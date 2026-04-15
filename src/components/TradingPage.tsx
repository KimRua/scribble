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
  setClientWalletAddress,
  subscribeMarketStream,
  updateAnnotation
} from '../services/apiClient';
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

const WALLET_LOGIN_STORAGE_KEY = 'scribble.walletLoginEnabled';

function readWalletLoginEnabled() {
  if (typeof window === 'undefined') {
    return true;
  }

  return window.localStorage.getItem(WALLET_LOGIN_STORAGE_KEY) !== 'false';
}

function writeWalletLoginEnabled(enabled: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(WALLET_LOGIN_STORAGE_KEY, enabled ? 'true' : 'false');
}

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

export function TradingPage() {
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
  const [delegationConfig, setDelegationConfig] = useState<DelegatedAutomationConfig>({
    ready: false,
    executorAddress: null,
    vaultAddress: null,
    missing: []
  });
  const [walletLoginEnabled, setWalletLoginEnabled] = useState(readWalletLoginEnabled);
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [nativeUsdtPrice, setNativeUsdtPrice] = useState<number | null>(null);
  const [aiRequestPending, setAiRequestPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const [pendingSyncAnnotationId, setPendingSyncAnnotationId] = useState<string | null>(null);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.annotationId === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId]
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

  const validation: StrategyValidation | null = useMemo(() => {
    return selectedAnnotation ? validateStrategy(selectedAnnotation.strategy, currentPrice, defaultUserSettings) : null;
  }, [selectedAnnotation, currentPrice]);

  const parsingNotes = selectedAnnotation ? parsingNotesByAnnotationId[selectedAnnotation.annotationId] ?? [] : [];
  const annotationCreationLocked = !walletSession?.address;

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
      if (!walletLoginEnabled) {
        const [health, nextMarkets, nextCandles] = await Promise.all([
          getHealth(),
          getMarkets(),
          getCandles(symbol, nextTimeframe)
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
        setAnnotations([]);
        setSelectedAnnotationId(null);
        setParsingNotesByAnnotationId({});
        setAuditEvents([]);
        setNotifications([]);
        setExecutions([]);
        setLastExecution(null);
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
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load workspace data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setClientWalletAddress(walletSession?.address ?? null);
    void loadWorkspace();
  }, [selectedSymbol, timeframe, walletLoginEnabled, walletSession?.address]);

  useEffect(() => {
    if (!walletLoginEnabled) {
      setWalletSession(null);
      setClientWalletAddress(null);
      return () => undefined;
    }

    void getInjectedWalletSession().then(setWalletSession).catch(() => undefined);
    void getDelegationConfig().then(setDelegationConfig).catch(() => undefined);

    return subscribeInjectedWalletSession((session) => {
      setWalletSession(session);
    });
  }, [walletLoginEnabled]);

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
    try {
      const preview = await previewExecution(selectedAnnotation.strategy.strategyId);
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to register the alert.');
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
      setErrorMessage(error instanceof Error ? error.message : 'Unable to cancel the order.');
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
      writeWalletLoginEnabled(true);
      setWalletLoginEnabled(true);
      setWalletSession(session);
    } catch (error) {
      writeWalletLoginEnabled(false);
      setWalletLoginEnabled(false);
      setWalletSession(null);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to connect the wallet.');
    }
  };

  const handleSwitchWallet = async () => {
    try {
      setErrorMessage(null);
      const session = await switchInjectedWallet();
      writeWalletLoginEnabled(true);
      setWalletLoginEnabled(true);
      setWalletSession(session);
    } catch (error) {
      if (!walletSession?.address) {
        writeWalletLoginEnabled(false);
        setWalletLoginEnabled(false);
        setWalletSession(null);
      }
      setErrorMessage(error instanceof Error ? error.message : 'Unable to switch wallets.');
    }
  };

  const handleDisconnectWallet = () => {
    writeWalletLoginEnabled(false);
    setWalletLoginEnabled(false);
    setClientWalletAddress(null);
    setWalletSession(null);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setAuditEvents([]);
    setDelegatedPolicyByStrategyId({});
    setDrawingMode('none');
  };

  return (
    <div className="app-shell">
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

      <section className="asset-allocation panel">
        <div className="asset-allocation-main">
          <div className="asset-allocation-copy">
            <p className="eyebrow">Portfolio</p>
            <h3>Strategy Portfolio</h3>
            <p className="muted">
              {portfolioSummary.liveStrategies} live strategies · {portfolioSummary.openPositions} open positions · {portfolioSummary.pendingOrders} pending orders
            </p>
          </div>
          <div className="allocation-donut-wrap" aria-hidden>
            <svg viewBox="0 0 120 120" className="allocation-donut">
              <circle className="allocation-donut-track" cx="60" cy="60" r="44" />
              <circle
                className="allocation-donut-segment"
                cx="60"
                cy="60"
                r="44"
                stroke="#0ecb81"
                strokeDasharray={`${2 * Math.PI * 44 * portfolioSummary.biasRatios.bullish} ${2 * Math.PI * 44}`}
                strokeDashoffset="0"
              />
              <circle
                className="allocation-donut-segment"
                cx="60"
                cy="60"
                r="44"
                stroke="#f6465d"
                strokeDasharray={`${2 * Math.PI * 44 * portfolioSummary.biasRatios.bearish} ${2 * Math.PI * 44}`}
                strokeDashoffset={`${-2 * Math.PI * 44 * portfolioSummary.biasRatios.bullish}`}
              />
              <circle
                className="allocation-donut-segment"
                cx="60"
                cy="60"
                r="44"
                stroke="#fcd535"
                strokeDasharray={`${2 * Math.PI * 44 * portfolioSummary.biasRatios.neutral} ${2 * Math.PI * 44}`}
                strokeDashoffset={`${-2 * Math.PI * 44 * (portfolioSummary.biasRatios.bullish + portfolioSummary.biasRatios.bearish)}`}
              />
            </svg>
            <div className="allocation-donut-center">
              <strong>{portfolioSummary.totalStrategies}</strong>
              <span>strategies</span>
            </div>
          </div>
        </div>

        <div className="allocation-breakdown allocation-breakdown-compact">
          <div className="allocation-item">
            <div>
              <span>Total assets</span>
              <strong>{formattedTotalAssetsUsd}</strong>
            </div>
          </div>
          <div className="allocation-item">
            <div>
              <span>Wallet</span>
              <strong>{formattedWalletBalance}</strong>
              {formattedWalletUsd ? <span>{formattedWalletUsd}</span> : null}
            </div>
          </div>
          <div className="allocation-item">
            <div>
              <span>Open exposure</span>
              <strong>{formattedExposureUsd}</strong>
              <span>{portfolioSummary.openPositions} open positions</span>
            </div>
          </div>
          <div className="allocation-item allocation-item-pending">
            <div>
              <span>Pending</span>
              <strong>{portfolioSummary.pendingOrders} orders</strong>
              <span>Ready for trigger</span>
            </div>
          </div>
        </div>

        <div className="allocation-legend allocation-legend-inline">
          <div className="allocation-legend-row">
            <div className="allocation-legend-copy">
              <span className="allocation-legend-dot" style={{ background: '#0ecb81' }} />
              <span>Bullish</span>
            </div>
            <strong>{portfolioSummary.biasCounts.bullish}</strong>
          </div>
          <div className="allocation-legend-row">
            <div className="allocation-legend-copy">
              <span className="allocation-legend-dot" style={{ background: '#f6465d' }} />
              <span>Bearish</span>
            </div>
            <strong>{portfolioSummary.biasCounts.bearish}</strong>
          </div>
          <div className="allocation-legend-row">
            <div className="allocation-legend-copy">
              <span className="allocation-legend-dot" style={{ background: '#fcd535' }} />
              <span>Neutral</span>
            </div>
            <strong>{portfolioSummary.biasCounts.neutral}</strong>
          </div>
          <div className="allocation-legend-row">
            <div className="allocation-legend-copy">
              <span className="allocation-legend-dot" style={{ background: '#7c8797' }} />
              <span>Auto</span>
            </div>
            <strong>{portfolioSummary.autoEnabled}</strong>
          </div>
        </div>
      </section>

      <main className="workspace-grid">
        <ChartCanvas
          marketData={candles}
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          timeframe={timeframe}
          drawingMode={drawingMode}
          currentPrice={currentPrice}
          annotationCreationLocked={annotationCreationLocked}
          onChangeMode={setDrawingMode}
          onSelectAnnotation={setSelectedAnnotationId}
          onCreateAnnotation={handleCreateAnnotation}
          onAddLineToSelected={handleAddLineToSelected}
          onAddBoxToSelected={handleAddBoxToSelected}
          onAddSegmentToSelected={handleAddSegmentToSelected}
          aiRequestPending={aiRequestPending}
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
            llmConfigured ? 'LLM connection ready' : 'No LLM key found: using fallback analysis',
            onchainConfigured ? 'opBNB proof recording ready' : 'opBNB proof not configured: recording local audit logs only',
            saving ? 'Saving changes' : 'Auto-save enabled'
          ]}
          auditEvents={auditEvents}
          onChangeText={handleTextChange}
          onChangeStrategy={handleStrategyChange}
          onActivate={activateSelectedAnnotation}
          onRemoveDrawingObject={handleRemoveDrawingObject}
          onCancelOrder={() => void handleCancelOrder()}
          onClosePosition={(input) => void handleClosePosition(input)}
        />
      </main>

      <section className="status-strip">
        <div className="status-card">
          <p className="eyebrow">Lifecycle</p>
          <strong>
            {selectedAnnotation ? `${selectedAnnotation.status} → ${determineAnnotationStatus(selectedAnnotation, currentPrice)}` : 'No strategy'}
          </strong>
        </div>
        <div className="status-card">
          <p className="eyebrow">Execution</p>
          <strong>
            {lastExecution
              ? `${lastExecution.actionType === 'close' ? 'Close' : 'Open'} · ${lastExecution.status} · ${lastExecution.executionChain}`
              : 'No executions yet'}
          </strong>
          {lastExecution ? (
            <div className="status-meta">
              <span className={`pill ${lastExecution.proofRecorded ? 'executed' : 'triggered'}`}>
                {lastExecution.proofRecorded ? 'Proof recorded' : 'Proof pending'}
              </span>
              <div className="status-links">
                <a href={getOpbnbTxUrl(lastExecution.executionChainTxHash)} target="_blank" rel="noreferrer">
                  Execution tx
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
