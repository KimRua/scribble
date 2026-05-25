import { useEffect, useMemo, useState } from 'react';
import { defaultUserSettings, marketOptions as fallbackMarkets } from '../data/mockMarket';
import {
  analyzeChart,
  cancelOrder,
  createExecution,
  createAlert,
  createAnnotation,
  createAutomation,
  createDelegationPolicy,
  fetchNewsInsights,
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
  recordDirectClosePosition,
  recordDirectExecution,
  setClientWalletAddress,
  subscribeMarketStream,
  updateAnnotation
} from '../services/apiClient';
import {
  cancelDirectHyperliquidOrder,
  closeDirectHyperliquidPosition,
  createDirectHyperliquidExecutionPreview,
  executeDirectHyperliquidOrder
} from '../services/hyperliquidDirectExecutionService';
import { connectInjectedWallet, getInjectedWalletSession, subscribeInjectedWalletSession, switchInjectedWallet } from '../services/walletService';
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
  NewsInsight,
  NotificationItem,
  Strategy,
  StrategyValidation,
  WalletSession
} from '../types/domain';
import { syncAnnotationWithStrategy } from '../utils/annotation';
import { formatPrice, validateStrategy } from '../utils/strategy';
import { AutomationModal } from './AutomationModal';
import { BottomActionBar } from './BottomActionBar';
import { ChartCanvas } from './ChartCanvas';
import { ExecutionHistoryPanel } from './ExecutionHistoryPanel';
import { ExecutionModal } from './ExecutionModal';
import { HeaderBar } from './HeaderBar';
import { MyStrategiesPanel } from './MyStrategiesPanel';
import { NotificationDrawer } from './NotificationDrawer';
import { RightPanel } from './RightPanel';
import { useToast } from './ToastProvider';

function normalizeNativeAssetSymbol(symbol?: string | null) {
  if (!symbol) {
    return null;
  }

  const upper = symbol.toUpperCase();
  if (upper === 'TBNB' || upper === 'WBNB') {
    return 'BNB';
  }

  return upper;
}

function formatSignedPercent(value: number, maximumFractionDigits = 2) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(maximumFractionDigits)}%`;
}

function getExecutionDisabledReason(
  annotation: Annotation | null,
  validation: StrategyValidation | null,
  mode: 'execute' | 'conditional',
  manualExecutionReady: boolean,
  dexExecutionReady: boolean
) {
  if (!annotation) {
    return '주문을 실행할 전략을 먼저 선택하세요.';
  }

  if (!validation?.isValid) {
    return validation?.violations[0] ?? '전략 검증을 먼저 통과해야 합니다.';
  }

  if (manualExecutionReady) {
    return null;
  }

  if (mode === 'conditional') {
    return '조건부 주문은 현재 연결 지갑을 통한 Hyperliquid 경로에서만 지원됩니다.';
  }

  if (!dexExecutionReady) {
    return '지갑을 연결하거나 서버 DEX 실행 설정을 활성화해야 주문을 실행할 수 있습니다.';
  }

  return null;
}

export function TradingPage() {
  const { showToast } = useToast();
  const [selectedSymbol, setSelectedSymbol] = useState('BNBUSDT');
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
  const [, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [onchainConfigured, setOnchainConfigured] = useState(false);
  const [dexConfigured, setDexConfigured] = useState(false);
  const [delegationConfig, setDelegationConfig] = useState<DelegatedAutomationConfig>({
    ready: false,
    executorAddress: null,
    vaultAddress: null,
    missing: []
  });
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [nativeUsdtPrice, setNativeUsdtPrice] = useState<number | null>(null);
  const [aiRequestPending, setAiRequestPending] = useState(false);
  const [newsInsights, setNewsInsights] = useState<NewsInsight[]>([]);
  const [selectedNewsInsightId, setSelectedNewsInsightId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const [pendingSyncAnnotationId, setPendingSyncAnnotationId] = useState<string | null>(null);

  const pushSuccessToast = (message: string) => {
    showToast(message, { tone: 'success', durationMs: 1100 });
  };

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.annotationId === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId]
  );

  const selectedNewsInsight = useMemo(
    () => newsInsights.find((insight) => insight.insightId === selectedNewsInsightId) ?? null,
    [newsInsights, selectedNewsInsightId]
  );

  const portfolioSummary = useMemo(() => {
    const liveStatuses: Annotation['status'][] = ['Draft', 'Active', 'Triggered', 'Executed'];
    const liveStrategies = annotations.filter((annotation) => liveStatuses.includes(annotation.status));
    const openPositions = annotations.filter((annotation) => annotation.status === 'Executed');
    const pendingOrders = annotations.filter(
      (annotation) =>
        annotation.status !== 'Executed' &&
        annotation.status !== 'Closed' &&
        annotation.status !== 'Invalidated' &&
        annotation.status !== 'Archived' &&
        (annotation.strategy.entryType === 'limit' || annotation.strategy.entryType === 'conditional')
    );
    const autoEnabled = annotations.filter((annotation) => annotation.strategy.autoExecuteEnabled);

    const exposureUsd = openPositions.reduce((sum, annotation) => {
      return sum + annotation.strategy.entryPrice * annotation.strategy.positionSizeRatio * annotation.strategy.leverage;
    }, 0);

    const biasCounts = liveStrategies.reduce(
      (acc, annotation) => {
        acc[annotation.strategy.bias] += 1;
        return acc;
      },
      {
        bullish: 0,
        bearish: 0,
        neutral: 0
      } as Record<'bullish' | 'bearish' | 'neutral', number>
    );

    const totalBias = Math.max(1, biasCounts.bullish + biasCounts.bearish + biasCounts.neutral);
    const bullishRatio = biasCounts.bullish / totalBias;
    const bearishRatio = biasCounts.bearish / totalBias;
    const neutralRatio = biasCounts.neutral / totalBias;

    return {
      totalStrategies: annotations.length,
      liveStrategies: liveStrategies.length,
      openPositions: openPositions.length,
      pendingOrders: pendingOrders.length,
      autoEnabled: autoEnabled.length,
      exposureUsd,
      biasCounts,
      biasRatios: {
        bullish: bullishRatio,
        bearish: bearishRatio,
        neutral: neutralRatio
      }
    };
  }, [annotations]);

  const formattedExposureUsd = useMemo(() => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(portfolioSummary.exposureUsd);
  }, [portfolioSummary.exposureUsd]);

  const formattedWalletBalance = useMemo(() => {
    if (typeof walletSession?.nativeBalance !== 'number') {
      return '—';
    }

    const symbol = walletSession.nativeSymbol ?? 'NATIVE';
    return `${walletSession.nativeBalance.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4
    })} ${symbol}`;
  }, [walletSession?.nativeBalance, walletSession?.nativeSymbol]);

  const formattedTotalAssetsUsd = useMemo(() => {
    if (typeof walletSession?.nativeBalance === 'number' && typeof nativeUsdtPrice === 'number') {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
      }).format(walletSession.nativeBalance * nativeUsdtPrice);
    }

    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(defaultUserSettings.accountBalance);
  }, [walletSession?.nativeBalance, nativeUsdtPrice]);

  const formattedWalletUsd = useMemo(() => {
    if (typeof walletSession?.nativeBalance !== 'number') {
      return null;
    }

    if (typeof nativeUsdtPrice !== 'number') {
      return null;
    }

    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(walletSession.nativeBalance * nativeUsdtPrice);
  }, [walletSession?.nativeBalance, nativeUsdtPrice]);

  const currentPriceLabel = useMemo(() => formatPrice(currentPrice), [currentPrice]);

  const marketStrip = useMemo(() => {
    const first = candles[0]?.open;
    const last = candles[candles.length - 1]?.close;
    const changePct = typeof first === 'number' && typeof last === 'number' && first !== 0 ? ((last - first) / first) * 100 : 0;
    return {
      changePct
    };
  }, [candles]);

  const validation: StrategyValidation | null = useMemo(() => {
    return selectedAnnotation ? validateStrategy(selectedAnnotation.strategy, currentPrice, defaultUserSettings) : null;
  }, [selectedAnnotation, currentPrice]);

  const latestExecutionByStrategyId = useMemo(() => {
    const latest = new Map<string, Execution>();
    executions.forEach((execution) => {
      const current = latest.get(execution.strategyId);
      const currentTime = current?.filledAt ? Date.parse(current.filledAt) : 0;
      const nextTime = execution.filledAt ? Date.parse(execution.filledAt) : 0;
      if (!current || nextTime >= currentTime) {
        latest.set(execution.strategyId, execution);
      }
    });
    return latest;
  }, [executions]);

  const selectedLatestExecution = useMemo(() => {
    if (!selectedAnnotation) {
      return null;
    }

    return latestExecutionByStrategyId.get(selectedAnnotation.strategy.strategyId) ?? null;
  }, [latestExecutionByStrategyId, selectedAnnotation]);

  const parsingNotes = selectedAnnotation ? parsingNotesByAnnotationId[selectedAnnotation.annotationId] ?? [] : [];
  const annotationCreationLocked = !walletSession?.address;
  const manualExecutionReady = Boolean(walletSession?.address);
  const dexExecutionReady = dexConfigured;
  const executionReady = manualExecutionReady || dexExecutionReady;
  const executionVenueLabel = manualExecutionReady ? 'Hyperliquid testnet direct' : 'BSC testnet DEX spot';
  const executeDisabledReason = getExecutionDisabledReason(
    selectedAnnotation,
    validation,
    'execute',
    manualExecutionReady,
    dexExecutionReady
  );
  const conditionalDisabledReason = getExecutionDisabledReason(
    selectedAnnotation,
    validation,
    'conditional',
    manualExecutionReady,
    dexExecutionReady
  );
  const autoExecuteDisabledReason = !selectedAnnotation
    ? '자동화를 설정할 전략을 먼저 선택하세요.'
    : !validation?.isValid
      ? validation?.violations[0] ?? '전략 검증을 먼저 통과해야 합니다.'
      : !manualExecutionReady
        ? '자동화는 연결된 지갑 기반 실행에서만 지원됩니다.'
        : null;

  const isPendingExecutionStatus = (status?: Execution['status'] | null) => {
    return status === 'Pending' || status === 'ReadyToExecute' || status === 'Executing' || status === 'PartiallyFilled';
  };

  const findLatestCancellableExecution = (annotation: Annotation) => {
    return executions
      .filter(
        (execution) =>
          execution.strategyId === annotation.strategy.strategyId &&
          execution.settlementMode === 'perp_dex' &&
          Boolean(execution.externalOrderId) &&
          isPendingExecutionStatus(execution.status)
      )
      .sort((left, right) => new Date(right.filledAt ?? 0).getTime() - new Date(left.filledAt ?? 0).getTime())[0] ?? null;
  };

  const deriveAnnotationStatusFromExecution = (
    entryType: Annotation['strategy']['entryType'],
    status: Execution['status']
  ): Annotation['status'] => {
    if (status === 'Filled' || status === 'PartiallyFilled') {
      return 'Executed';
    }

    return entryType === 'conditional' ? 'Triggered' : 'Active';
  };

  const ensureWalletForAnnotations = () => {
    if (walletSession?.address) {
      return true;
    }

    setDrawingMode('none');
    setErrorMessage('Connect a wallet to create annotations.');
    return false;
  };

  const loadWorkspace = async (symbol = selectedSymbol, nextTimeframe = timeframe) => {
    setLoading(true);
    setErrorMessage(null);

    try {
      if (!walletSession?.address) {
        const [health, nextMarkets, nextCandles] = await Promise.all([
          getHealth(),
          getMarkets(),
          getCandles(symbol, nextTimeframe)
        ]);

        setConnectionStatus(health.ok ? 'connected' : 'disconnected');
        setLlmConfigured(health.llmConfigured);
        setOnchainConfigured(health.onchainConfigured ?? false);
        setDexConfigured(health.dexConfigured ?? false);
        setDelegationConfig({
          ready: health.delegatedAutomationConfigured ?? false,
          executorAddress: health.delegatedExecutorAddress ?? null,
          vaultAddress: health.delegationVaultAddress ?? null,
          missing: []
        });
        setMarkets(nextMarkets);
        setCandles(nextCandles);
        setCurrentPrice(nextCandles.at(-1)?.close ?? 0);
        setAnnotations([]);
        setSelectedAnnotationId(null);
        setParsingNotesByAnnotationId({});
        setAuditEvents([]);
        setNotifications([]);
        setExecutions([]);
        setLastExecution(null);

        setNewsInsights([]);
        return;
      }

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
      setDexConfigured(health.dexConfigured ?? false);
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

      fetchNewsInsights({ marketSymbol: symbol, timeframe: nextTimeframe, threshold: 0.5 })
        .then((r) => setNewsInsights(r.insights))
        .catch(() => setNewsInsights([]));
    } catch (error) {
      setConnectionStatus('disconnected');
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load workspace data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setClientWalletAddress(walletSession?.address ?? null);
    void loadWorkspace();
  }, [selectedSymbol, timeframe, walletSession?.address]);

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
    const nativeAsset = normalizeNativeAssetSymbol(walletSession?.nativeSymbol);
    if (!nativeAsset) {
      setNativeUsdtPrice(null);
      return;
    }

    const pair = `${nativeAsset}USDT`;
    if (selectedSymbol === pair && currentPrice > 0) {
      setNativeUsdtPrice(currentPrice);
      return;
    }

    let mounted = true;
    void getCandles(pair, timeframe)
      .then((nextCandles) => {
        if (!mounted) {
          return;
        }
        const close = nextCandles.at(-1)?.close;
        setNativeUsdtPrice(typeof close === 'number' && Number.isFinite(close) ? close : null);
      })
      .catch(() => {
        if (mounted) {
          setNativeUsdtPrice(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, [walletSession?.nativeSymbol, selectedSymbol, currentPrice, timeframe]);

  useEffect(() => {
    if (!walletSession?.address) {
      return () => undefined;
    }
    const interval = window.setInterval(() => {
      void getNotifications().then(setNotifications).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(interval);
  }, [walletSession?.address]);

  useEffect(() => {
    if (!selectedAnnotation || !walletSession?.address) {
      setAuditEvents([]);
      return;
    }
    void getAuditLogs({ annotationId: selectedAnnotation.annotationId })
      .then(setAuditEvents)
      .catch(() => undefined);
  }, [selectedAnnotation?.annotationId, walletSession?.address]);

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
        autoExecuteEnabled: selectedAnnotation.strategy.autoExecuteEnabled,
        drawingObjects: selectedAnnotation.drawingObjects
      })
        .then((result) => {
          setAnnotations((prev) =>
            prev.map((annotation) => (annotation.annotationId === result.annotation.annotationId ? result.annotation : annotation))
          );
          setParsingNotesByAnnotationId((prev) => ({ ...prev, [selectedAnnotation.annotationId]: result.parsing_notes }));
          setPendingSyncAnnotationId(null);
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to save your edits.');
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
    if (!ensureWalletForAnnotations()) {
      return;
    }

    try {
      setAiRequestPending(true);
      const result = await analyzeChart({
        marketSymbol: selectedSymbol,
        timeframe,
        riskLevel: defaultUserSettings.riskLevel,
        defaultPositionSizeRatio: defaultUserSettings.defaultPositionSize,
        leverage: defaultUserSettings.leverage
      });
      setAnnotations((prev) => [result.annotation, ...prev]);
      setSelectedAnnotationId(result.annotation.annotationId);
      setSelectedNewsInsightId(null);
      setParsingNotesByAnnotationId((prev) => ({
        ...prev,
        [result.annotation.annotationId]: [result.provider === 'openai' ? 'Generated by LLM analysis' : 'Generated by fallback analysis']
      }));
      setAuditEvents(await getAuditLogs({ annotationId: result.annotation.annotationId }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to generate AI analysis.');
    } finally {
      setAiRequestPending(false);
    }
  };

  const handleCreateAnnotation = async (text: string, anchor: Annotation['chartAnchor']) => {
    if (!ensureWalletForAnnotations()) {
      return;
    }

    try {
      const result = await createAnnotation({
        marketSymbol: selectedSymbol,
        timeframe,
        text,
        chartAnchor: anchor
      });
      setAnnotations((prev) => [result.annotation, ...prev]);
      setSelectedAnnotationId(result.annotation.annotationId);
      setSelectedNewsInsightId(null);
      setDrawingMode('none');
      setParsingNotesByAnnotationId((prev) => ({ ...prev, [result.annotation.annotationId]: result.parsing_notes }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the annotation.');
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

  const handleSelectAnnotation = (annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
    setSelectedNewsInsightId(null);
  };

  const handleSelectNewsInsight = (insightId: string | null) => {
    setSelectedNewsInsightId(insightId);
    setSelectedAnnotationId(null);
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
    if (!selectedAnnotation || !ensureWalletForAnnotations()) {
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
    markDirty(selectedAnnotation.annotationId);
  };

  const handleAddSegmentToSelected = (startAnchor: Annotation['chartAnchor'], endAnchor: Annotation['chartAnchor']) => {
    if (!selectedAnnotation || !ensureWalletForAnnotations()) {
      return;
    }
    const object: DrawingObject = {
      id: `${selectedAnnotation.annotationId}_segment_${Date.now()}`,
      type: 'segment',
      role: 'trendline',
      startAnchor,
      endAnchor
    };
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      drawingObjects: [...annotation.drawingObjects, object],
      updatedAt: new Date().toISOString()
    }));
    markDirty(selectedAnnotation.annotationId);
  };

  const handleAddBoxToSelected = (priceFrom: number, priceTo: number) => {
    if (!selectedAnnotation || !ensureWalletForAnnotations()) {
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
    markDirty(selectedAnnotation.annotationId);
  };

  const handleRemoveDrawingObject = (drawingObjectId: string) => {
    if (!selectedAnnotation) {
      return;
    }
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
      ...annotation,
      drawingObjects: annotation.drawingObjects.filter((object) => object.id !== drawingObjectId),
      updatedAt: new Date().toISOString()
    }));
    markDirty(selectedAnnotation.annotationId);
  };

  const openExecutionFlow = async (mode: 'execute' | 'conditional') => {
    if (!selectedAnnotation) {
      return;
    }

    const latestCancellableExecution = findLatestCancellableExecution(selectedAnnotation);
    if (latestCancellableExecution?.actionType !== 'close') {
      setErrorMessage('이미 Hyperliquid testnet에 대기 중인 주문이 있습니다. 먼저 취소한 뒤 다시 시도하세요.');
      return;
    }

    const disabledReason = getExecutionDisabledReason(selectedAnnotation, validation, mode, manualExecutionReady, dexExecutionReady);
    if (disabledReason) {
      setErrorMessage(disabledReason);
      return;
    }

    try {
      const preview = manualExecutionReady
        ? await createDirectHyperliquidExecutionPreview(
            selectedAnnotation.strategy,
            selectedAnnotation.marketSymbol,
            currentPrice,
            defaultUserSettings,
            walletSession?.address ?? ''
          )
        : await previewExecution(selectedAnnotation.strategy.strategyId);
      setExecutionPreview(preview);
      setExecutionMode(mode);
      setExecutionModalOpen(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the execution preview.');
    }
  };

  const confirmExecution = async () => {
    if (!selectedAnnotation) {
      return;
    }

    const disabledReason = getExecutionDisabledReason(
      selectedAnnotation,
      validation,
      executionMode,
      manualExecutionReady,
      dexExecutionReady
    );
    if (disabledReason) {
      setErrorMessage(disabledReason);
      setExecutionModalOpen(false);
      return;
    }

    try {
      if (!manualExecutionReady) {
        const result = await createExecution(selectedAnnotation.strategy.strategyId);
        const nextExecution = {
          ...result,
          filledPrice: result.filledPrice ?? selectedAnnotation.strategy.entryPrice,
          filledAt: result.filledAt ?? new Date().toISOString()
        };
        setLastExecution(nextExecution);
        setExecutions((prev) => [nextExecution, ...prev.filter((execution) => execution.executionId !== nextExecution.executionId)].slice(0, 12));
        upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
          ...annotation,
          status: 'Executed',
          updatedAt: nextExecution.filledAt ?? new Date().toISOString()
        }));
        pushSuccessToast(nextExecution.settlementMode === 'dex' ? 'DEX 현물 주문이 실행되었습니다.' : '주문이 기록되었습니다.');
        setNotifications(await getNotifications());
        setAuditEvents(await getAuditLogs({ annotationId: selectedAnnotation.annotationId }));
        setExecutionModalOpen(false);
        return;
      }

      const entryType = executionMode === 'conditional' ? 'conditional' : selectedAnnotation.strategy.entryType;
      const receipt = await executeDirectHyperliquidOrder(
        selectedAnnotation.strategy,
        selectedAnnotation.marketSymbol,
        currentPrice,
        { entryType }
      );
      const result = await recordDirectExecution(selectedAnnotation.strategy.strategyId, {
        walletAddress: walletSession?.address ?? '',
        entryType,
        receipt
      });
      const nextExecution = {
        ...result.execution,
        filledPrice: result.execution.filledPrice ?? selectedAnnotation.strategy.entryPrice,
        filledAt: result.execution.filledAt ?? new Date().toISOString()
      };
      setLastExecution(nextExecution);
      setExecutions((prev) => [nextExecution, ...prev.filter((execution) => execution.executionId !== nextExecution.executionId)].slice(0, 12));
      upsertAnnotation(selectedAnnotation.annotationId, () => result.annotation);
      pushSuccessToast(
        deriveAnnotationStatusFromExecution(entryType, nextExecution.status) === 'Executed'
          ? '주문이 실행되었습니다.'
          : '대기 주문이 등록되었습니다.'
      );

      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: selectedAnnotation.annotationId }));
      setExecutionModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to complete the execution.');
    }
  };

  const handleSetAlert = async () => {
    if (!selectedAnnotation) {
      return;
    }
    try {
      await createAlert(selectedAnnotation.annotationId, selectedAnnotation.strategy.entryPrice);
      setNotifications(await getNotifications());
      pushSuccessToast('알림이 설정되었습니다.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to register the alert.');
    }
  };

  const handleCancelOrder = async (annotationId?: string) => {
    const targetAnnotationId = annotationId ?? selectedAnnotation?.annotationId;
    if (!targetAnnotationId) {
      return;
    }

    const targetAnnotation = annotations.find((annotation) => annotation.annotationId === targetAnnotationId);
    if (!targetAnnotation) {
      return;
    }

    const cancellableExecution = findLatestCancellableExecution(targetAnnotation);

    try {
      if (cancellableExecution?.externalOrderId) {
        await cancelDirectHyperliquidOrder(targetAnnotation.marketSymbol, cancellableExecution.externalOrderId);
      }

      const nextAnnotation = await cancelOrder(targetAnnotationId);
      setAnnotations((prev) =>
        prev.map((annotation) => (annotation.annotationId === targetAnnotationId ? nextAnnotation : annotation))
      );
      if (cancellableExecution) {
        setExecutions((prev) =>
          prev.map((execution) =>
            execution.executionId === cancellableExecution.executionId
              ? {
                  ...execution,
                  status: 'Cancelled'
                }
              : execution
          )
        );
      }
      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: targetAnnotationId }));
      pushSuccessToast(cancellableExecution?.actionType === 'close' ? '청산 주문을 취소했습니다.' : '대기 주문을 취소했습니다.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to cancel the order.');
    }
  };

  const handleClosePosition = async (input: { mode: 'market' | 'price'; closePrice?: number }) => {
    if (!selectedAnnotation) {
      return;
    }

    try {
      if (!walletSession?.address) {
        throw new Error('지갑을 연결해야 포지션을 직접 정리할 수 있습니다.');
      }

      if (selectedLatestExecution?.actionType === 'close' && isPendingExecutionStatus(selectedLatestExecution.status)) {
        throw new Error('이미 대기 중인 청산 주문이 있습니다. 먼저 취소한 뒤 다시 시도하세요.');
      }

      const receipt = await closeDirectHyperliquidPosition(selectedAnnotation.marketSymbol, currentPrice, input);
      const result = await recordDirectClosePosition(selectedAnnotation.annotationId, {
        mode: input.mode,
        walletAddress: walletSession.address,
        receipt
      });
      upsertAnnotation(selectedAnnotation.annotationId, () => result.annotation);
      setExecutions((prev) =>
        [result.execution, ...prev.filter((execution) => execution.executionId !== result.execution.executionId)].slice(0, 12)
      );
      setLastExecution(result.execution);
      pushSuccessToast(result.annotation.status === 'Closed' ? '포지션을 정리했습니다.' : '청산 주문을 등록했습니다.');
      setNotifications(await getNotifications());
      setAuditEvents(await getAuditLogs({ annotationId: selectedAnnotation.annotationId }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to close the position.');
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
      setErrorMessage('Connect your wallet first to delegate automation permissions.');
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
      setErrorMessage(error instanceof Error ? error.message : 'Unable to save the automation settings.');
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
      setErrorMessage(null);
      const session = await connectInjectedWallet();
      setWalletSession(session);
      if (session?.address) {
        showToast('지갑이 연결되었습니다.', { tone: 'success', durationMs: 1000 });
      }
    } catch (error) {
      setWalletSession(null);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to connect the wallet.');
    }
  };

  const handleSwitchWallet = async () => {
    try {
      setErrorMessage(null);
      const session = await switchInjectedWallet();
      setWalletSession(session);
    } catch (error) {
      if (!walletSession?.address) {
        setWalletSession(null);
      }
      setErrorMessage(error instanceof Error ? error.message : 'Unable to switch wallets.');
    }
  };

  const handleDisconnectWallet = () => {
    setClientWalletAddress(null);
    setWalletSession(null);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setAuditEvents([]);
    setDelegatedPolicyByStrategyId({});
    setDrawingMode('none');
  };

  return (
    <div className="app-shell workspace-hl">
      <HeaderBar
        selectedSymbol={selectedSymbol}
        timeframe={timeframe}
        markets={markets}
        walletAddress={walletSession?.address ?? null}
        onChangeSymbol={setSelectedSymbol}
        onChangeTimeframe={setTimeframe}
        onToggleNotifications={() => setNotificationsOpen((prev) => !prev)}
        onToggleStrategies={() => setStrategiesOpen((prev) => !prev)}
        onConnectWallet={() => void handleConnectWallet()}
        onSwitchWallet={() => void handleSwitchWallet()}
        onDisconnectWallet={handleDisconnectWallet}
      />

	      {errorMessage ? <div className="error-banner panel">{errorMessage}</div> : null}
	      {loading ? <div className="loading-banner panel">Loading workspace data...</div> : null}
	      {annotationCreationLocked ? (
	        <div className="info-banner annotation-auth-banner panel">
          <div>
            <strong>Wallet required for annotation tools</strong>
            <p>Annotations, AI drafts, and chart objects are stored against the connected wallet.</p>
          </div>
          <button className="secondary" onClick={() => void handleConnectWallet()}>
            Connect wallet
          </button>
	        </div>
	      ) : null}

      <section className="workspace-hl-strip panel" aria-label="마켓 요약">
        <div className="workspace-hl-strip-grid">
          <div className="workspace-hl-strip-item">
            <span>마크 가격</span>
            <strong>{currentPriceLabel}</strong>
            <em className={marketStrip.changePct >= 0 ? 'tone-up' : 'tone-down'}>
              {selectedSymbol} · {formatSignedPercent(marketStrip.changePct, 2)}
            </em>
          </div>
          <div className="workspace-hl-strip-item">
            <span>AI 주석</span>
            <strong>{portfolioSummary.liveStrategies}</strong>
            <em>live / {portfolioSummary.totalStrategies} total</em>
          </div>
          <div className="workspace-hl-strip-item">
            <span>자동 실행</span>
            <strong>{portfolioSummary.autoEnabled}</strong>
            <em>armed</em>
          </div>
          <div className="workspace-hl-strip-item">
            <span>포지션</span>
            <strong>{portfolioSummary.openPositions}</strong>
            <em>open</em>
          </div>
          <div className="workspace-hl-strip-item">
            <span>익스포저</span>
            <strong>{formattedExposureUsd}</strong>
            <em>open</em>
          </div>
        </div>
      </section>

      <main className="workspace-hl-layout" aria-label="워크스페이스">
        <section className="workspace-hl-chart" aria-label="차트 영역">
          <div className="workspace-hl-market-grid">
            <div className="workspace-hl-chart-main">
              <ChartCanvas
                marketData={candles}
                annotations={annotations}
                selectedAnnotationId={selectedAnnotationId}
                selectedNewsInsightId={selectedNewsInsightId}
                timeframe={timeframe}
                drawingMode={drawingMode}
                currentPrice={currentPrice}
                annotationCreationLocked={annotationCreationLocked}
                onChangeMode={setDrawingMode}
                onSelectAnnotation={(annotationId) => {
                  handleSelectAnnotation(annotationId);
                }}
                onSelectNewsInsight={(insightId) => {
                  handleSelectNewsInsight(insightId);
                }}
                onCreateAnnotation={handleCreateAnnotation}
                onAddLineToSelected={handleAddLineToSelected}
                onAddBoxToSelected={handleAddBoxToSelected}
                onAddSegmentToSelected={handleAddSegmentToSelected}
                aiRequestPending={aiRequestPending}
                newsInsights={newsInsights}
                onRequestAi={handleRequestAi}
                onNudgePrice={(deltaRatio) => advancePrice(Number((currentPrice * (1 + deltaRatio)).toFixed(2)))}
                onTriggerSelected={handleTriggerSelected}
              />
            </div>

            <div className="workspace-ai-rail" aria-label="AI 주석 레일">
              <section className="workspace-ai-actions panel" aria-label="AI 주석">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">AI Layer</p>
                    <h3>뉴스 + 주석</h3>
                  </div>
                  <span className="section-count">{newsInsights.length} signals</span>
                </div>

                <div className="workspace-ai-actions-row">
                  <button
                    className={aiRequestPending ? 'ai-cta-button is-loading' : 'ai-cta-button'}
                    disabled={annotationCreationLocked || aiRequestPending}
                    onClick={() => void handleRequestAi()}
                  >
                    <span className="ai-cta-icon" aria-hidden>
                      {aiRequestPending ? '◌' : '✦'}
                    </span>
                    <span className="ai-cta-label">{aiRequestPending ? '분석 중…' : 'AI 주석 생성'}</span>
                    <span className="ai-cta-badge" aria-hidden>
                      AI
                    </span>
                  </button>
                  <button className="ghost-button" onClick={() => handleSelectNewsInsight(null)}>
                    뉴스 닫기
                  </button>
                </div>

                <div className="workspace-ai-feed" role="list">
                  {newsInsights.length === 0 ? <p className="muted">아직 감지된 뉴스 이벤트가 없습니다.</p> : null}
                  {newsInsights.slice(0, 8).map((insight) => (
                    <button
                      key={insight.insightId}
                      type="button"
                      className={selectedNewsInsightId === insight.insightId ? 'workspace-ai-feed-item is-active' : 'workspace-ai-feed-item'}
                      onClick={() => handleSelectNewsInsight(insight.insightId)}
                    >
                      <span className={insight.direction === 'spike' ? 'workspace-ai-feed-pill tone-up' : 'workspace-ai-feed-pill tone-down'}>
                        {insight.direction === 'spike' ? '▲' : '▼'} {Math.abs(insight.priceChangePercent).toFixed(1)}%
                      </span>
                      <div className="workspace-ai-feed-copy">
                        <strong>{insight.headline}</strong>
                        <span>{new Date(insight.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <RightPanel
                selectedAnnotation={selectedAnnotation}
                selectedNewsInsight={selectedNewsInsight}
                validation={validation}
                latestExecution={selectedLatestExecution}
                manualExecutionReady={manualExecutionReady}
                currentPrice={currentPrice}
                parsingNotes={[
                  ...parsingNotes,
                  llmConfigured ? 'AI 분석 준비 완료' : 'LLM 키가 없어 대체 분석을 사용 중입니다.',
                  manualExecutionReady
                    ? '연결된 지갑으로 Hyperliquid testnet 직접 주문이 가능합니다.'
                    : dexExecutionReady
                      ? '서버 DEX 실행 경로가 준비되어 있습니다.'
                      : '지갑 연결 또는 서버 DEX 설정이 필요합니다.',
                  onchainConfigured ? 'opBNB 증빙 기록이 활성화되어 있습니다.' : '온체인 기록이 없어 로컬 감사 로그만 저장합니다.',
                  saving ? '변경사항을 저장하고 있습니다.' : '자동 저장이 켜져 있습니다.'
                ]}
                auditEvents={auditEvents}
                onChangeText={handleTextChange}
                onChangeStrategy={handleStrategyChange}
                onActivate={activateSelectedAnnotation}
                onRemoveDrawingObject={handleRemoveDrawingObject}
                onCancelOrder={() => void handleCancelOrder()}
                onClosePosition={(input) => void handleClosePosition(input)}
              />
            </div>
          </div>
        </section>

        <aside className="workspace-hl-right" aria-label="주문 패널">
          <div className="workspace-hl-summary panel">
            <div className="workspace-hl-summary-row">
              <div>
                <span>현재가</span>
                <strong>{currentPriceLabel}</strong>
              </div>
              <div>
                <span>총 자산</span>
                <strong>{formattedTotalAssetsUsd}</strong>
              </div>
              <div>
                <span>익스포저</span>
                <strong>{formattedExposureUsd}</strong>
              </div>
            </div>
            <p className="workspace-hl-summary-note">
              {formattedWalletBalance}
              {formattedWalletUsd ? ` · ${formattedWalletUsd}` : ''} · 포지션 {portfolioSummary.openPositions} · 대기 {portfolioSummary.pendingOrders}
            </p>
          </div>

          <section className="workspace-hl-exec panel" aria-label="자동 거래 실행">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Auto Trade</p>
                <h3>AI 추천 → 자동 실행</h3>
              </div>
              <span className="section-count">{executionVenueLabel}</span>
            </div>

            {!selectedAnnotation ? (
              <div className="workspace-hl-exec-empty">
                <strong>먼저 AI 주석을 생성하세요</strong>
                <p className="muted">차트 위에 뉴스와 주석이 생성되고, 그 내용을 기반으로 추천 포지션이 만들어집니다.</p>
              </div>
            ) : (
              <div className="workspace-hl-exec-grid" aria-label="추천 포지션">
                <div>
                  <span>방향</span>
                  <strong>
                    {selectedAnnotation.strategy.bias === 'bullish'
                      ? '상승'
                      : selectedAnnotation.strategy.bias === 'bearish'
                        ? '하락'
                        : '중립'}
                  </strong>
                </div>
                <div>
                  <span>진입</span>
                  <strong>
                    {selectedAnnotation.strategy.entryType === 'market'
                      ? '시장가'
                      : selectedAnnotation.strategy.entryType === 'limit'
                        ? '지정가'
                        : '조건부'}
                  </strong>
                </div>
                <div>
                  <span>진입가</span>
                  <strong>{formatPrice(selectedAnnotation.strategy.entryPrice)}</strong>
                </div>
                <div>
                  <span>손절</span>
                  <strong>{formatPrice(selectedAnnotation.strategy.stopLossPrice)}</strong>
                </div>
                <div>
                  <span>익절</span>
                  <strong>
                    {selectedAnnotation.strategy.takeProfitPrices.length > 0
                      ? selectedAnnotation.strategy.takeProfitPrices.map((p) => formatPrice(p)).join(' · ')
                      : '—'}
                  </strong>
                </div>
                <div>
                  <span>레버리지/비중</span>
                  <strong>
                    {selectedAnnotation.strategy.leverage}x · {Math.round(selectedAnnotation.strategy.positionSizeRatio * 100)}%
                  </strong>
                </div>
              </div>
            )}

            {annotationCreationLocked ? (
              <div className="workspace-hl-exec-gate">
                <p className="muted">자동 실행은 연결 지갑 기준으로 동작합니다. 지갑을 연결하면 주석/실행이 활성화됩니다.</p>
                <button className="secondary" onClick={() => void handleConnectWallet()}>
                  지갑 연결
                </button>
              </div>
            ) : null}

            <BottomActionBar
              selectedAnnotation={selectedAnnotation}
              executeDisabledReason={executeDisabledReason}
              conditionalDisabledReason={conditionalDisabledReason}
              autoExecuteDisabledReason={autoExecuteDisabledReason}
              executionVenueLabel={executionVenueLabel}
              onExecute={() => void openExecutionFlow('execute')}
              onConditionalOrder={() => void openExecutionFlow('conditional')}
              onSetAlert={() => void handleSetAlert()}
              onAutoExecute={() => setAutomationModalOpen(true)}
            />
          </section>

          <section className="workspace-hl-system panel" aria-label="실행 컨텍스트">
            <div className="section-heading">
              <div>
                <p className="eyebrow">System</p>
                <h3>실행 컨텍스트</h3>
              </div>
              <span className="section-count">{portfolioSummary.liveStrategies} active</span>
            </div>
            <div className="workspace-hl-system-grid">
              <div>
                <span>AI 분석</span>
                <strong>{llmConfigured ? '준비됨' : '대체 분석 사용 중'}</strong>
              </div>
              <div>
                <span>주문 실행</span>
                <strong>
                  {manualExecutionReady
                    ? '연결 지갑으로 직접 실행'
                    : dexExecutionReady
                      ? '서버 DEX 실행 준비됨'
                      : '실행 준비 필요'}
                </strong>
              </div>
              <div>
                <span>온체인 기록</span>
                <strong>{onchainConfigured ? 'opBNB 기록 활성' : '로컬 감사 로그만 사용'}</strong>
              </div>
              <div>
                <span>자동 저장</span>
                <strong>{saving ? '저장 중' : '활성화됨'}</strong>
              </div>
              <div className="workspace-hl-system-span2">
                <span>최근 실행</span>
                <strong>
                  {lastExecution ? `${lastExecution.actionType === 'close' ? '청산' : '진입'} · ${lastExecution.status}` : '실행 이력 없음'}
                </strong>
                {lastExecution?.executionChainTxHash ? (
                  <a href={getOpbnbTxUrl(lastExecution.executionChainTxHash)} target="_blank" rel="noreferrer">
                    실행 트랜잭션
                  </a>
                ) : lastExecution?.proofContractAddress ? (
                  <a href={getOpbnbAddressUrl(lastExecution.proofContractAddress)} target="_blank" rel="noreferrer">
                    레지스트리
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        </aside>
      </main>

      <section className="workspace-hl-bottom panel" aria-label="포지션 및 이력">
        <ExecutionHistoryPanel
          annotations={annotations}
          executions={executions}
          onCancelOrder={(annotationId) => void handleCancelOrder(annotationId)}
          onSelectAnnotation={(annotationId) => {
            handleSelectAnnotation(annotationId);
          }}
        />
      </section>

      <ExecutionModal
        open={executionModalOpen}
        selectedAnnotation={selectedAnnotation}
        preview={executionPreview}
        validation={validation}
        mode={executionMode}
        executionConfigured={executionReady}
        executionVenueLabel={executionVenueLabel}
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
          handleSelectAnnotation(annotationId);
          setNotificationsOpen(false);
        }}
      />

      <MyStrategiesPanel
        open={strategiesOpen}
        annotations={annotations}
        onClose={() => setStrategiesOpen(false)}
        onSelect={(annotationId) => {
          handleSelectAnnotation(annotationId);
          setStrategiesOpen(false);
        }}
      />
    </div>
  );
}
