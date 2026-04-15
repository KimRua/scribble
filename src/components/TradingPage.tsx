import { useEffect, useMemo, useState } from 'react';
import { defaultUserSettings, marketOptions as fallbackMarkets } from '../data/mockMarket';
import {
  analyzeChart,
  cancelOrder,
  closePosition,
  createAlert,
  createAnnotation,
  createAutomation,
  createDelegationPolicy,
  createExecution,
  getDelegationConfig,
  getDelegationPolicies,
  getExecutions,
  getAnnotations,
  getAuditLogs,
  getCandles,
  getHealth,
  getOpbnbAddressUrl,
  getOpbnbTxUrl,
  getMarkets,
  getNotifications,
  previewExecution,
  subscribeMarketStream,
  updateAnnotation
} from '../services/apiClient';
import { connectInjectedWallet, getInjectedWalletSession, subscribeInjectedWalletSession } from '../services/walletService';
import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  DelegatedAutomationConfig,
  DelegatedAutomationPolicy,
  DrawingObject,
  DrawingMode,
  Execution,
  ExecutionPlan,
  MarketOption,
  NotificationItem,
  Strategy,
  StrategyValidation,
  WalletSession
} from '../types/domain';
import { syncAnnotationWithStrategy } from '../utils/annotation';
import { determineAnnotationStatus, validateStrategy } from '../utils/strategy';
import { AutomationModal } from './AutomationModal';
import { BottomActionBar } from './BottomActionBar';
import { ChartCanvas } from './ChartCanvas';
import { ExecutionHistoryPanel } from './ExecutionHistoryPanel';
import { ExecutionModal } from './ExecutionModal';
import { HeaderBar } from './HeaderBar';
import { MyStrategiesPanel } from './MyStrategiesPanel';
import { NotificationDrawer } from './NotificationDrawer';
import { RightPanel } from './RightPanel';

function formatUsd(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: 0
  }).format(value);
}

export function TradingPage() {
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [markets, setMarkets] = useState<MarketOption[]>(fallbackMarkets);
  const [candles, setCandles] = useState([] as Awaited<ReturnType<typeof getCandles>>);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('none');
  const [currentPrice, setCurrentPrice] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [automationByStrategyId, setAutomationByStrategyId] = useState<Record<string, AutomationRule>>({});
  const [delegatedPolicyByStrategyId, setDelegatedPolicyByStrategyId] = useState<Record<string, DelegatedAutomationPolicy>>({});
  const [executionPreview, setExecutionPreview] = useState<ExecutionPlan | null>(null);
  const [executionMode, setExecutionMode] = useState<'execute' | 'conditional'>('execute');
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [automationModalOpen, setAutomationModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [parsingNotesByAnnotationId, setParsingNotesByAnnotationId] = useState<Record<string, string[]>>({});
  const [lastExecution, setLastExecution] = useState<Execution | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [onchainConfigured, setOnchainConfigured] = useState(false);
  const [delegationConfig, setDelegationConfig] = useState<DelegatedAutomationConfig>({
    ready: false,
    executorAddress: null,
    vaultAddress: null,
    missing: []
  });
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [nativeAssetPrice, setNativeAssetPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const [pendingSyncAnnotationId, setPendingSyncAnnotationId] = useState<string | null>(null);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.annotationId === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId]
  );

  const validation: StrategyValidation | null = useMemo(() => {
    return selectedAnnotation ? validateStrategy(selectedAnnotation.strategy, currentPrice, defaultUserSettings) : null;
  }, [selectedAnnotation, currentPrice]);

  const parsingNotes = selectedAnnotation ? parsingNotesByAnnotationId[selectedAnnotation.annotationId] ?? [] : [];

  useEffect(() => {
    let cancelled = false;

    if (walletSession?.nativeBalance == null || !walletSession.nativeSymbol) {
      setNativeAssetPrice(null);
      return () => {
        cancelled = true;
      };
    }

    const isBnbFamily = walletSession.nativeSymbol === 'tBNB' || walletSession.nativeSymbol === 'BNB';
    if (!isBnbFamily) {
      setNativeAssetPrice(null);
      return () => {
        cancelled = true;
      };
    }

    if (selectedSymbol === 'BNBUSDT' && currentPrice > 0) {
      setNativeAssetPrice(currentPrice);
      return () => {
        cancelled = true;
      };
    }

    void getCandles('BNBUSDT', '1h')
      .then((nextCandles) => {
        if (cancelled) {
          return;
        }
        setNativeAssetPrice(nextCandles.at(-1)?.close ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setNativeAssetPrice(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [walletSession?.nativeBalance, walletSession?.nativeSymbol, selectedSymbol, currentPrice]);

  const portfolioSnapshot = useMemo(() => {
    const walletUsesBnbPricing =
      walletSession?.nativeBalance != null &&
      (walletSession.nativeSymbol === 'tBNB' || walletSession.nativeSymbol === 'BNB');
    const actualWalletBalance =
      walletUsesBnbPricing && nativeAssetPrice
        ? Number((((walletSession?.nativeBalance ?? 0) * nativeAssetPrice)).toFixed(2))
        : null;
    const portfolioBaseUsd = walletUsesBnbPricing ? actualWalletBalance ?? 0 : defaultUserSettings.accountBalance;
    const latestExecutionByStrategyId = new Map<string, Execution>();
    executions.forEach((execution) => {
      const current = latestExecutionByStrategyId.get(execution.strategyId);
      const currentTime = current?.filledAt ? Date.parse(current.filledAt) : 0;
      const nextTime = execution.filledAt ? Date.parse(execution.filledAt) : 0;
      if (!current || nextTime >= currentTime) {
        latestExecutionByStrategyId.set(execution.strategyId, execution);
      }
    });

    const positionAnnotations = annotations.filter((annotation) => {
      const latestExecution = latestExecutionByStrategyId.get(annotation.strategy.strategyId);
      return (
        annotation.status === 'Executed' &&
        (latestExecution?.status === 'Filled' || latestExecution?.status === 'PartiallyFilled')
      );
    });
    const pendingOrderAnnotations = annotations.filter(
      (annotation) =>
        annotation.status !== 'Executed' &&
        annotation.status !== 'Closed' &&
        annotation.status !== 'Invalidated' &&
        (annotation.strategy.entryType === 'limit' || annotation.strategy.entryType === 'conditional')
    );

    const requestedAllocationFor = (annotation: Annotation) =>
      Number((portfolioBaseUsd * annotation.strategy.positionSizeRatio).toFixed(2));

    const positionsWithAllocation = positionAnnotations.map((annotation) => ({
      annotation,
      latestExecution: latestExecutionByStrategyId.get(annotation.strategy.strategyId) ?? null,
      allocatedValue: requestedAllocationFor(annotation)
    }));

    const positionsValue = positionsWithAllocation.reduce((total, item) => total + item.allocatedValue, 0);

    let remainingCashForOrders = Math.max(portfolioBaseUsd - positionsValue, 0);
    const pendingOrdersWithAllocation = [...pendingOrderAnnotations]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map((annotation) => {
        const requestedValue = requestedAllocationFor(annotation);
        const allocatedValue = Math.min(requestedValue, remainingCashForOrders);
        remainingCashForOrders = Math.max(remainingCashForOrders - allocatedValue, 0);

        return {
          annotation,
          latestExecution: latestExecutionByStrategyId.get(annotation.strategy.strategyId) ?? null,
          allocatedValue
        };
      })
      .filter((item) => item.allocatedValue > 0);

    const pendingOrdersValue = pendingOrdersWithAllocation.reduce((total, item) => total + item.allocatedValue, 0);
    const cashValue = Math.max(portfolioBaseUsd - positionsValue - pendingOrdersValue, 0);
    const totalTrackedValue = positionsValue + pendingOrdersValue + cashValue;
    const donutTotal = totalTrackedValue > 0 ? totalTrackedValue : 1;

    return {
      totalBalance: portfolioBaseUsd,
      nativeBalance: walletSession?.nativeBalance ?? null,
      nativeSymbol: walletSession?.nativeSymbol ?? null,
      nativeAssetPrice,
      usingWalletBalance: walletUsesBnbPricing,
      walletValueResolved: actualWalletBalance != null,
      positionsValue,
      pendingOrdersValue,
      cashValue,
      donutTotal,
      positionCount: positionsWithAllocation.length,
      pendingOrderCount: pendingOrdersWithAllocation.length,
      positions: positionsWithAllocation
        .map((item) => ({
          latestExecution: item.latestExecution,
          annotationId: item.annotation.annotationId,
          label: item.annotation.marketSymbol,
          detail: item.annotation.strategy.bias.toUpperCase(),
          value: item.allocatedValue
        }))
        .sort((left, right) => right.value - left.value)
        .slice(0, 4),
      pendingOrders: pendingOrdersWithAllocation
        .map((item) => ({
          latestExecution: item.latestExecution,
          annotationId: item.annotation.annotationId,
          label: item.annotation.marketSymbol,
          detail: `${item.annotation.strategy.entryType.toUpperCase()} · ${item.annotation.status}`,
          value: item.allocatedValue
        }))
        .sort((left, right) => right.value - left.value)
        .slice(0, 4)
    };
  }, [annotations, executions, nativeAssetPrice, walletSession?.nativeBalance, walletSession?.nativeSymbol]);

  const allocationSegments = useMemo(() => {
    const circumference = 2 * Math.PI * 54;
    const segments = [
      {
        key: 'cash',
        label: '현금 대기',
        value: portfolioSnapshot.cashValue,
        color: '#d0d9e7'
      },
      {
        key: 'pending',
        label: '미체결 주문',
        value: portfolioSnapshot.pendingOrdersValue,
        color: '#ffb020'
      },
      {
        key: 'positions',
        label: '보유 포지션',
        value: portfolioSnapshot.positionsValue,
        color: '#3182f6'
      }
    ];

    let offset = 0;
    return segments.map((segment) => {
      const length = (segment.value / portfolioSnapshot.donutTotal) * circumference;
      const next = {
        ...segment,
        dashArray: `${length} ${circumference - length}`,
        dashOffset: -offset
      };
      offset += length;
      return next;
    });
  }, [portfolioSnapshot]);

  const loadWorkspace = async (symbol = selectedSymbol, nextTimeframe = timeframe) => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const [health, nextMarkets, nextCandles, nextAnnotations, nextNotifications, nextExecutions] = await Promise.all([
        getHealth(),
        getMarkets(),
        getCandles(symbol, nextTimeframe),
        getAnnotations(symbol, nextTimeframe),
        getNotifications(),
        getExecutions(symbol, nextTimeframe)
      ]);

      setConnectionStatus(health.ok ? 'connected' : 'disconnected');
      setLlmConfigured(health.llmConfigured);
      setOnchainConfigured(health.onchainConfigured ?? false);
      setDelegationConfig({
        ready: health.delegatedAutomationConfigured ?? false,
        executorAddress: health.delegatedExecutorAddress ?? null,
        vaultAddress: health.delegationVaultAddress ?? null,
        missing: []
      });
      setMarkets(nextMarkets);
      setCandles(nextCandles);
      setCurrentPrice(nextCandles.at(-1)?.close ?? 0);
      setAnnotations(nextAnnotations);
      setSelectedAnnotationId((current) =>
        current && nextAnnotations.some((annotation) => annotation.annotationId === current)
          ? current
          : null
      );
      setNotifications(nextNotifications);
      setExecutions(nextExecutions);
      setLastExecution(nextExecutions[0] ?? null);
    } catch (error) {
      setConnectionStatus('disconnected');
      setErrorMessage(error instanceof Error ? error.message : '데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [selectedSymbol, timeframe]);

  useEffect(() => {
    void getInjectedWalletSession().then(setWalletSession).catch(() => undefined);
    void getDelegationConfig().then(setDelegationConfig).catch(() => undefined);

    return subscribeInjectedWalletSession((session) => {
      setWalletSession(session);
    });
  }, []);

  useEffect(() => {
    if (!walletSession?.address) {
      setDelegatedPolicyByStrategyId({});
      return;
    }

    void getDelegationPolicies({ ownerAddress: walletSession.address })
      .then((result) => {
        setDelegationConfig(result.config);
        setDelegatedPolicyByStrategyId(
          Object.fromEntries(result.policies.map((policy) => [policy.strategyId, policy]))
        );
      })
      .catch(() => undefined);
  }, [walletSession?.address]);

  useEffect(() => {
    const unsubscribe = subscribeMarketStream(selectedSymbol, timeframe, {
      onMessage: (payload) => {
        setCandles(
          payload.candles.map((candle) => ({
            openTime: candle.open_time,
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume)
          }))
        );
        setCurrentPrice(payload.current_price);
        setConnectionStatus('connected');
      },
      onError: () => {
        setConnectionStatus('disconnected');
      }
    });

    return () => unsubscribe();
  }, [selectedSymbol, timeframe]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void getNotifications().then(setNotifications).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedAnnotation) {
      setAuditEvents([]);
      return;
    }
    void getAuditLogs({ annotationId: selectedAnnotation.annotationId })
      .then(setAuditEvents)
      .catch(() => undefined);
  }, [selectedAnnotation?.annotationId]);

  useEffect(() => {
    if (!selectedAnnotation || pendingSyncAnnotationId !== selectedAnnotation.annotationId || syncRevision === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSaving(true);
      void updateAnnotation(selectedAnnotation.annotationId, {
        text: selectedAnnotation.text,
        bias: selectedAnnotation.strategy.bias,
        entryType: selectedAnnotation.strategy.entryType,
        entryPrice: selectedAnnotation.strategy.entryPrice,
        stopLossPrice: selectedAnnotation.strategy.stopLossPrice,
        takeProfitPrices: selectedAnnotation.strategy.takeProfitPrices,
        invalidationCondition: selectedAnnotation.strategy.invalidationCondition,
        confidence: selectedAnnotation.strategy.confidence,
        riskLevel: selectedAnnotation.strategy.riskLevel,
        positionSizeRatio: selectedAnnotation.strategy.positionSizeRatio,
        leverage: selectedAnnotation.strategy.leverage,
        autoExecuteEnabled: selectedAnnotation.strategy.autoExecuteEnabled
      })
        .then((result) => {
          setAnnotations((prev) =>
            prev.map((annotation) => (annotation.annotationId === result.annotation.annotationId ? result.annotation : annotation))
          );
          setParsingNotesByAnnotationId((prev) => ({ ...prev, [selectedAnnotation.annotationId]: result.parsing_notes }));
          setPendingSyncAnnotationId(null);
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : '편집 저장에 실패했습니다.');
        })
        .finally(() => {
          setSaving(false);
        });
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [pendingSyncAnnotationId, selectedAnnotation, syncRevision]);

  const markDirty = (annotationId: string) => {
    setPendingSyncAnnotationId(annotationId);
    setSyncRevision((value) => value + 1);
  };

  const upsertAnnotation = (annotationId: string, updater: (annotation: Annotation) => Annotation) => {
    setAnnotations((prev) => prev.map((annotation) => (annotation.annotationId === annotationId ? updater(annotation) : annotation)));
  };

  const activateSelectedAnnotation = () => {
    if (!selectedAnnotation) {
      return;
    }
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      status: annotation.status === 'Draft' ? 'Active' : annotation.status,
      updatedAt: new Date().toISOString()
    }));
    markDirty(selectedAnnotation.annotationId);
  };

  const handleRequestAi = async () => {
    try {
      const result = await analyzeChart({
        marketSymbol: selectedSymbol,
        timeframe,
        riskLevel: defaultUserSettings.riskLevel,
        defaultPositionSizeRatio: defaultUserSettings.defaultPositionSize,
        leverage: defaultUserSettings.leverage
      });
      setAnnotations((prev) => [result.annotation, ...prev]);
      setSelectedAnnotationId(result.annotation.annotationId);
      setParsingNotesByAnnotationId((prev) => ({
        ...prev,
        [result.annotation.annotationId]: [result.provider === 'openai' ? 'LLM 분석으로 생성됨' : 'fallback 분석으로 생성됨']
      }));
      setAuditEvents(await getAuditLogs({ annotationId: result.annotation.annotationId }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'AI 분석 생성에 실패했습니다.');
    }
  };

  const handleCreateAnnotation = async (text: string, anchor: Annotation['chartAnchor']) => {
    try {
      const result = await createAnnotation({
        marketSymbol: selectedSymbol,
        timeframe,
        text,
        chartAnchor: anchor
      });
      setAnnotations((prev) => [result.annotation, ...prev]);
      setSelectedAnnotationId(result.annotation.annotationId);
      setDrawingMode('none');
      setParsingNotesByAnnotationId((prev) => ({ ...prev, [result.annotation.annotationId]: result.parsing_notes }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '주석 생성에 실패했습니다.');
    }
  };

  const handleTextChange = (text: string) => {
    if (!selectedAnnotation) {
      return;
    }
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      text,
      updatedAt: new Date().toISOString()
    }));
    markDirty(selectedAnnotation.annotationId);
  };

  const handleStrategyChange = <K extends keyof Strategy>(key: K, value: Strategy[K]) => {
    if (!selectedAnnotation) {
      return;
    }
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => {
      const nextStrategy = {
        ...annotation.strategy,
        [key]: value
      };
      return syncAnnotationWithStrategy(annotation, nextStrategy);
    });
    markDirty(selectedAnnotation.annotationId);
  };

  const handleAddLineToSelected = (price: number) => {
    if (!selectedAnnotation) {
      return;
    }
    const object: DrawingObject = {
      id: `${selectedAnnotation.annotationId}_line_${Date.now()}`,
      type: 'line',
      role: 'trendline',
      price
    };
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      drawingObjects: [...annotation.drawingObjects, object],
      updatedAt: new Date().toISOString()
    }));
  };

  const handleAddBoxToSelected = (priceFrom: number, priceTo: number) => {
    if (!selectedAnnotation) {
      return;
    }
    const object: DrawingObject = {
      id: `${selectedAnnotation.annotationId}_box_${Date.now()}`,
      type: 'box',
      role: 'zone',
      priceFrom,
      priceTo
    };
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      drawingObjects: [...annotation.drawingObjects, object],
      updatedAt: new Date().toISOString()
    }));
  };

  const openExecutionFlow = async (mode: 'execute' | 'conditional') => {
    if (!selectedAnnotation) {
      return;
    }
    try {
      const preview = await previewExecution(selectedAnnotation.strategy.strategyId);
      setExecutionPreview(preview);
      setExecutionMode(mode);
      setExecutionModalOpen(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '실행 프리뷰 생성에 실패했습니다.');
    }
  };

  const confirmExecution = async () => {
    if (!selectedAnnotation) {
      return;
    }
    try {
      if (executionMode === 'conditional') {
        await createAlert(selectedAnnotation.annotationId, selectedAnnotation.strategy.entryPrice);
        activateSelectedAnnotation();
      } else {
        const result = await createExecution(selectedAnnotation.strategy.strategyId);
        const nextExecution = {
          ...result,
          filledPrice: result.filledPrice ?? selectedAnnotation.strategy.entryPrice,
          filledAt: result.filledAt ?? new Date().toISOString()
        };
        setLastExecution(nextExecution);
        setExecutions((prev) => [nextExecution, ...prev.filter((execution) => execution.executionId !== nextExecution.executionId)].slice(0, 8));
        upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
          ...annotation,
          status: 'Executed',
          updatedAt: new Date().toISOString()
        }));
      }

      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: selectedAnnotation.annotationId }));
      setExecutionModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '실행 처리에 실패했습니다.');
    }
  };

  const handleSetAlert = async () => {
    if (!selectedAnnotation) {
      return;
    }
    try {
      await createAlert(selectedAnnotation.annotationId, selectedAnnotation.strategy.entryPrice);
      setNotifications(await getNotifications());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '알림 등록에 실패했습니다.');
    }
  };

  const handleCancelOrder = async (annotationId?: string) => {
    const targetAnnotationId = annotationId ?? selectedAnnotation?.annotationId;
    if (!targetAnnotationId) {
      return;
    }

    const previousAnnotations = annotations;
    const wasSelected = selectedAnnotation?.annotationId === targetAnnotationId;

    try {
      setAnnotations((prev) =>
        prev.map((annotation) =>
          annotation.annotationId === targetAnnotationId
            ? {
                ...annotation,
                status: 'Invalidated',
                updatedAt: new Date().toISOString()
              }
            : annotation
        )
      );
      if (wasSelected) {
        setSelectedAnnotationId(null);
      }

      const nextAnnotation = await cancelOrder(targetAnnotationId);
      setAnnotations((prev) =>
        prev.map((annotation) => (annotation.annotationId === targetAnnotationId ? nextAnnotation : annotation))
      );
      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: targetAnnotationId }));
    } catch (error) {
      setAnnotations(previousAnnotations);
      if (wasSelected) {
        setSelectedAnnotationId(targetAnnotationId);
      }
      setErrorMessage(error instanceof Error ? error.message : '주문 취소에 실패했습니다.');
    }
  };

  const handleClosePosition = async (input: { mode: 'market' | 'price'; closePrice?: number }) => {
    if (!selectedAnnotation) {
      return;
    }

    try {
      const result = await closePosition(selectedAnnotation.annotationId, input);
      upsertAnnotation(selectedAnnotation.annotationId, () => result.annotation);
      setExecutions((prev) =>
        [result.execution, ...prev.filter((execution) => execution.executionId !== result.execution.executionId)].slice(0, 12)
      );
      setLastExecution(result.execution);
      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: selectedAnnotation.annotationId }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '포지션 정리에 실패했습니다.');
    }
  };

  const handleSaveAutomation = async (config: {
    maxPositionSizeRatio: number;
    maxLeverage: number;
    maxLossRatio: number;
    maxDailyExecutions: number;
    maxOrderSizeUsd: number;
    maxSlippageBps: number;
    dailyLossLimitUsd: number;
    validUntil: string;
    approvalTxHash?: string | null;
  }) => {
    if (!selectedAnnotation) {
      return;
    }

    if (!walletSession?.address) {
      setErrorMessage('자동거래 권한 위임을 위해 먼저 지갑을 연결해 주세요.');
      return;
    }

    try {
      const delegation = await createDelegationPolicy({
        strategyId: selectedAnnotation.strategy.strategyId,
        ownerAddress: walletSession.address,
        marketSymbol: selectedAnnotation.marketSymbol,
        maxOrderSizeUsd: config.maxOrderSizeUsd,
        maxSlippageBps: config.maxSlippageBps,
        dailyLossLimitUsd: config.dailyLossLimitUsd,
        validUntil: new Date(config.validUntil).toISOString(),
        approvalTxHash: config.approvalTxHash ?? null
      });
      const result = await createAutomation(selectedAnnotation.strategy.strategyId, config);
      setDelegationConfig(delegation.config);
      setDelegatedPolicyByStrategyId((prev) => ({
        ...prev,
        [selectedAnnotation.strategy.strategyId]: delegation.policy
      }));
      setAutomationByStrategyId((prev) => ({
        ...prev,
        [selectedAnnotation.strategy.strategyId]: {
          automationId: result.automation_id,
          strategyId: selectedAnnotation.strategy.strategyId,
          status: result.status,
          triggerPrice: selectedAnnotation.strategy.entryPrice,
          maxPositionSizeRatio: config.maxPositionSizeRatio,
          maxLeverage: config.maxLeverage,
          maxLossRatio: config.maxLossRatio,
          maxDailyExecutions: config.maxDailyExecutions,
          stopConditions: ['max daily executions reached', 'guardrail violation', 'manual halt']
        }
      }));
      upsertAnnotation(selectedAnnotation.annotationId, (annotation) =>
        syncAnnotationWithStrategy(annotation, {
          ...annotation.strategy,
          autoExecuteEnabled: true
        })
      );
      markDirty(selectedAnnotation.annotationId);
      setNotifications(await getNotifications());
      setAutomationModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '자동 실행 설정에 실패했습니다.');
    }
  };

  const advancePrice = (nextPrice: number) => {
    setCurrentPrice(nextPrice);
  };

  const handleTriggerSelected = () => {
    if (!selectedAnnotation) {
      return;
    }
    advancePrice(selectedAnnotation.strategy.entryPrice);
  };

  const handleConnectWallet = async () => {
    try {
      const session = await connectInjectedWallet();
      setWalletSession(session);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '지갑 연결에 실패했습니다.');
    }
  };

  const handleDisconnectWallet = () => {
    setWalletSession(null);
  };

  return (
    <div className="app-shell">
      <HeaderBar
        selectedSymbol={selectedSymbol}
        timeframe={timeframe}
        connectionStatus={connectionStatus}
        markets={markets}
        walletAddress={walletSession?.address ?? null}
        onChangeSymbol={setSelectedSymbol}
        onChangeTimeframe={setTimeframe}
        onToggleNotifications={() => setNotificationsOpen((prev) => !prev)}
        onToggleStrategies={() => setStrategiesOpen((prev) => !prev)}
        onConnectWallet={() => void handleConnectWallet()}
        onDisconnectWallet={handleDisconnectWallet}
      />

      {errorMessage ? <div className="error-banner panel">{errorMessage}</div> : null}
      {loading ? <div className="loading-banner panel">데이터를 불러오는 중입니다...</div> : null}

      <section className="dashboard-hero">
        <div className="overview-grid">
          <article className="overview-card panel">
            <p className="eyebrow">Market</p>
            <strong>{selectedSymbol}</strong>
            <span>{currentPrice ? `${currentPrice.toLocaleString('ko-KR')} USDT` : '시세 로딩 중'}</span>
          </article>
          <article className="overview-card panel">
            <p className="eyebrow">AI Engine</p>
            <strong>{llmConfigured ? 'LLM Ready' : 'Fallback Active'}</strong>
            <span>{llmConfigured ? '실시간 분석 가능' : '규칙 기반 분석 사용 중'}</span>
          </article>
          <article className="overview-card panel">
            <p className="eyebrow">Onchain</p>
            <strong>{onchainConfigured ? 'Proof Ready' : 'Local Only'}</strong>
            <span>{onchainConfigured ? 'opBNB proof 기록 사용' : '감사 로그만 기록'}</span>
          </article>
          <article className="overview-card panel">
            <p className="eyebrow">Selection</p>
            <strong>{selectedAnnotation ? selectedAnnotation.strategy.bias.toUpperCase() : 'No Strategy'}</strong>
            <span>{selectedAnnotation ? `${selectedAnnotation.strategy.entryType} · ${selectedAnnotation.status}` : '전략을 선택하세요'}</span>
          </article>
        </div>

        <article className="asset-allocation panel">
          <div className="asset-allocation-summary">
            <div>
              <p className="eyebrow">Asset Allocation</p>
              <h3>{formatUsd(portfolioSnapshot.totalBalance)} USDT</h3>
              <p className="muted">
                {portfolioSnapshot.usingWalletBalance && portfolioSnapshot.nativeBalance != null && portfolioSnapshot.nativeSymbol
                  ? portfolioSnapshot.walletValueResolved
                    ? `${portfolioSnapshot.nativeBalance.toFixed(4)} ${portfolioSnapshot.nativeSymbol} 반영`
                    : `${portfolioSnapshot.nativeBalance.toFixed(4)} ${portfolioSnapshot.nativeSymbol} 감지 · USDT 환산 대기 중`
                  : '지갑 미연결 시 기본 자산값 사용'}
              </p>
              <p className="muted">
                보유 포지션 {portfolioSnapshot.positionCount}건 · 미체결 주문 {portfolioSnapshot.pendingOrderCount}건
              </p>
            </div>

            <div className="allocation-donut-wrap">
              <svg viewBox="0 0 140 140" className="allocation-donut" aria-label="현재 자산 비중">
                <circle cx="70" cy="70" r="54" className="allocation-donut-track" />
                {allocationSegments.map((segment) => (
                  <circle
                    key={segment.key}
                    cx="70"
                    cy="70"
                    r="54"
                    className="allocation-donut-segment"
                    style={{
                      stroke: segment.color,
                      strokeDasharray: segment.dashArray,
                      strokeDashoffset: segment.dashOffset
                    }}
                  />
                ))}
              </svg>
              <div className="allocation-donut-center">
                <strong>{formatUsd(portfolioSnapshot.positionsValue + portfolioSnapshot.pendingOrdersValue)} USDT</strong>
                <span>배분 중</span>
              </div>
            </div>
          </div>

          <div className="allocation-legend">
            {allocationSegments.map((segment) => (
              <div key={segment.key} className="allocation-legend-row">
                <div className="allocation-legend-copy">
                  <span className="allocation-legend-dot" style={{ backgroundColor: segment.color }} />
                  <strong>{segment.label}</strong>
                </div>
                <span>{formatUsd(segment.value)} USDT</span>
              </div>
            ))}
          </div>

        </article>

        <article className="selection-hero panel">
          <div className="selection-hero-copy">
            <p className="eyebrow">Selected Strategy</p>
            <h2>
              {selectedAnnotation
                ? `${selectedAnnotation.marketSymbol} ${timeframe} · ${selectedAnnotation.strategy.bias.toUpperCase()}`
                : '선택된 전략이 없습니다'}
            </h2>
            <p className="selection-hero-note">
              {selectedAnnotation
                ? selectedAnnotation.text
                : '차트에서 주석을 선택하면 엔트리, 리스크, 액션이 이 영역에 요약됩니다.'}
            </p>
          </div>
          <div className="selection-hero-metrics">
            <div>
              <span>Entry</span>
              <strong>
                {selectedAnnotation ? selectedAnnotation.strategy.entryPrice.toLocaleString('ko-KR') : '-'}
              </strong>
            </div>
            <div>
              <span>SL</span>
              <strong>
                {selectedAnnotation ? selectedAnnotation.strategy.stopLossPrice.toLocaleString('ko-KR') : '-'}
              </strong>
            </div>
            <div>
              <span>TP1</span>
              <strong>
                {selectedAnnotation
                  ? (selectedAnnotation.strategy.takeProfitPrices[0] ?? 0).toLocaleString('ko-KR')
                  : '-'}
              </strong>
            </div>
            <div>
              <span>Status</span>
              <strong>
                {selectedAnnotation ? determineAnnotationStatus(selectedAnnotation, currentPrice) : '-'}
              </strong>
            </div>
          </div>
        </article>
      </section>

      <main className="workspace-grid">
        <ChartCanvas
          marketData={candles}
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          drawingMode={drawingMode}
          currentPrice={currentPrice}
          onChangeMode={setDrawingMode}
          onSelectAnnotation={setSelectedAnnotationId}
          onCreateAnnotation={handleCreateAnnotation}
          onAddLineToSelected={handleAddLineToSelected}
          onAddBoxToSelected={handleAddBoxToSelected}
          onRequestAi={handleRequestAi}
          onNudgePrice={(deltaRatio) => advancePrice(Number((currentPrice * (1 + deltaRatio)).toFixed(2)))}
          onTriggerSelected={handleTriggerSelected}
        />

        <RightPanel
          selectedAnnotation={selectedAnnotation}
          validation={validation}
          currentPrice={currentPrice}
          parsingNotes={[
            ...parsingNotes,
            llmConfigured ? 'LLM 연동 준비됨' : 'LLM 키 미설정: fallback 분석 사용 중',
            onchainConfigured ? 'opBNB proof 기록 준비됨' : 'opBNB proof 미설정: 로컬 실행 로그만 기록',
            saving ? '변경사항 저장 중' : '변경사항 자동 저장'
          ]}
          auditEvents={auditEvents}
          onChangeText={handleTextChange}
          onChangeStrategy={handleStrategyChange}
          onActivate={activateSelectedAnnotation}
          onCancelOrder={() => void handleCancelOrder()}
          onClosePosition={(input) => void handleClosePosition(input)}
        />
      </main>

      <section className="status-strip">
        <div className="status-card">
          <p className="eyebrow">Lifecycle</p>
          <strong>
            {selectedAnnotation ? `${selectedAnnotation.status} → ${determineAnnotationStatus(selectedAnnotation, currentPrice)}` : '전략 없음'}
          </strong>
        </div>
        <div className="status-card">
          <p className="eyebrow">Execution</p>
          <strong>
            {lastExecution
              ? `${lastExecution.actionType === 'close' ? 'Close' : 'Open'} · ${lastExecution.status} · ${lastExecution.executionChain}`
              : '아직 실행 없음'}
          </strong>
          {lastExecution ? (
            <div className="status-meta">
              <span className={`pill ${lastExecution.proofRecorded ? 'executed' : 'triggered'}`}>
                {lastExecution.proofRecorded ? 'Proof recorded' : 'Proof pending'}
              </span>
              <div className="status-links">
                <a href={getOpbnbTxUrl(lastExecution.executionChainTxHash)} target="_blank" rel="noreferrer">
                  실행 Tx
                </a>
                {lastExecution.proofContractAddress ? (
                  <a href={getOpbnbAddressUrl(lastExecution.proofContractAddress)} target="_blank" rel="noreferrer">
                    Registry
                  </a>
                ) : null}
              </div>
              {lastExecution.proofRegistryId ? <small className="muted">{lastExecution.proofRegistryId.slice(0, 12)}…</small> : null}
            </div>
          ) : null}
        </div>
        <div className="status-card">
          <p className="eyebrow">Automation</p>
          <strong>
            {selectedAnnotation ? automationByStrategyId[selectedAnnotation.strategy.strategyId]?.status ?? 'Disabled' : 'Disabled'}
          </strong>
        </div>
      </section>

      <ExecutionHistoryPanel
        annotations={annotations}
        executions={executions}
        onCancelOrder={(annotationId) => void handleCancelOrder(annotationId)}
        onSelectAnnotation={setSelectedAnnotationId}
      />

      <BottomActionBar
        selectedAnnotation={selectedAnnotation}
        validation={validation}
        onExecute={() => void openExecutionFlow('execute')}
        onConditionalOrder={() => void openExecutionFlow('conditional')}
        onSetAlert={() => void handleSetAlert()}
        onAutoExecute={() => setAutomationModalOpen(true)}
      />

      <ExecutionModal
        open={executionModalOpen}
        selectedAnnotation={selectedAnnotation}
        preview={executionPreview}
        validation={validation}
        mode={executionMode}
        onchainConfigured={onchainConfigured}
        onClose={() => setExecutionModalOpen(false)}
        onConfirm={() => void confirmExecution()}
      />

      <AutomationModal
        open={automationModalOpen}
        selectedAnnotation={selectedAnnotation}
        automation={selectedAnnotation ? automationByStrategyId[selectedAnnotation.strategy.strategyId] ?? null : null}
        connectedWalletAddress={walletSession?.address ?? null}
        delegatedPolicy={selectedAnnotation ? delegatedPolicyByStrategyId[selectedAnnotation.strategy.strategyId] ?? null : null}
        executorAddress={delegationConfig.executorAddress}
        vaultAddress={delegationConfig.vaultAddress}
        onClose={() => setAutomationModalOpen(false)}
        onConnectWallet={() => void handleConnectWallet()}
        onSave={(config) => void handleSaveAutomation(config)}
      />

      <NotificationDrawer
        open={notificationsOpen}
        notifications={notifications}
        onClose={() => setNotificationsOpen(false)}
        onSelectAnnotation={(annotationId) => {
          setSelectedAnnotationId(annotationId);
          setNotificationsOpen(false);
        }}
      />

      <MyStrategiesPanel
        open={strategiesOpen}
        annotations={annotations}
        onClose={() => setStrategiesOpen(false)}
        onSelect={(annotationId) => {
          setSelectedAnnotationId(annotationId);
          setStrategiesOpen(false);
        }}
      />
    </div>
  );
}
