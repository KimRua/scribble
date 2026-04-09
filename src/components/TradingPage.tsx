import { useEffect, useMemo, useState } from 'react';
import { defaultUserSettings, marketOptions as fallbackMarkets } from '../data/mockMarket';
import {
  analyzeChart,
  createAlert,
  createAnnotation,
  createAutomation,
  createExecution,
  getAnnotations,
  getAuditLogs,
  getCandles,
  getHealth,
  getMarkets,
  getNotifications,
  previewExecution,
  subscribeMarketStream,
  updateAnnotation
} from '../services/apiClient';
import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  DrawingObject,
  DrawingMode,
  Execution,
  ExecutionPlan,
  MarketOption,
  NotificationItem,
  Strategy,
  StrategyValidation
} from '../types/domain';
import { syncAnnotationWithStrategy } from '../utils/annotation';
import { determineAnnotationStatus, validateStrategy } from '../utils/strategy';
import { AutomationModal } from './AutomationModal';
import { BottomActionBar } from './BottomActionBar';
import { ChartCanvas } from './ChartCanvas';
import { ExecutionModal } from './ExecutionModal';
import { HeaderBar } from './HeaderBar';
import { MyStrategiesPanel } from './MyStrategiesPanel';
import { NotificationDrawer } from './NotificationDrawer';
import { RightPanel } from './RightPanel';

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
  const [executionPreview, setExecutionPreview] = useState<ExecutionPlan | null>(null);
  const [executionMode, setExecutionMode] = useState<'execute' | 'conditional'>('execute');
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [automationModalOpen, setAutomationModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [parsingNotesByAnnotationId, setParsingNotesByAnnotationId] = useState<Record<string, string[]>>({});
  const [lastExecution, setLastExecution] = useState<Execution | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [llmConfigured, setLlmConfigured] = useState(false);
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

  const loadWorkspace = async (symbol = selectedSymbol, nextTimeframe = timeframe) => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const [health, nextMarkets, nextCandles, nextAnnotations, nextNotifications] = await Promise.all([
        getHealth(),
        getMarkets(),
        getCandles(symbol, nextTimeframe),
        getAnnotations(symbol, nextTimeframe),
        getNotifications()
      ]);

      setConnectionStatus(health.ok ? 'connected' : 'disconnected');
      setLlmConfigured(health.llmConfigured);
      setMarkets(nextMarkets);
      setCandles(nextCandles);
      setCurrentPrice(nextCandles.at(-1)?.close ?? 0);
      setAnnotations(nextAnnotations);
      setSelectedAnnotationId((current) =>
        current && nextAnnotations.some((annotation) => annotation.annotationId === current)
          ? current
          : nextAnnotations[0]?.annotationId ?? null
      );
      setNotifications(nextNotifications);
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
        setLastExecution({
          executionId: result.execution_id,
          strategyId: selectedAnnotation.strategy.strategyId,
          status: result.status,
          executionChain: 'opbnb',
          liquidityChain: 'bsc',
          executionChainTxHash: result.execution_chain_tx_hash,
          liquidityChainTxHash: result.liquidity_chain_tx_hash,
          filledPrice: selectedAnnotation.strategy.entryPrice,
          filledAt: new Date().toISOString()
        });
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

  const handleSaveAutomation = async (config: {
    maxPositionSizeRatio: number;
    maxLeverage: number;
    maxLossRatio: number;
    maxDailyExecutions: number;
  }) => {
    if (!selectedAnnotation) {
      return;
    }

    try {
      const result = await createAutomation(selectedAnnotation.strategy.strategyId, config);
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

  return (
    <div className="app-shell">
      <HeaderBar
        selectedSymbol={selectedSymbol}
        timeframe={timeframe}
        connectionStatus={connectionStatus}
        markets={markets}
        onChangeSymbol={setSelectedSymbol}
        onChangeTimeframe={setTimeframe}
        onToggleNotifications={() => setNotificationsOpen((prev) => !prev)}
        onToggleStrategies={() => setStrategiesOpen((prev) => !prev)}
      />

      {errorMessage ? <div className="error-banner panel">{errorMessage}</div> : null}
      {loading ? <div className="loading-banner panel">데이터를 불러오는 중입니다...</div> : null}

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
            saving ? '변경사항 저장 중' : '변경사항 자동 저장'
          ]}
          auditEvents={auditEvents}
          onChangeText={handleTextChange}
          onChangeStrategy={handleStrategyChange}
          onActivate={activateSelectedAnnotation}
        />
      </main>

      <section className="status-strip panel">
        <div>
          <p className="eyebrow">Lifecycle</p>
          <strong>
            {selectedAnnotation ? `${selectedAnnotation.status} → ${determineAnnotationStatus(selectedAnnotation, currentPrice)}` : '전략 없음'}
          </strong>
        </div>
        <div>
          <p className="eyebrow">Execution</p>
          <strong>{lastExecution ? `${lastExecution.status} · ${lastExecution.executionChain}` : '아직 실행 없음'}</strong>
        </div>
        <div>
          <p className="eyebrow">Automation</p>
          <strong>
            {selectedAnnotation ? automationByStrategyId[selectedAnnotation.strategy.strategyId]?.status ?? 'Disabled' : 'Disabled'}
          </strong>
        </div>
      </section>

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
        onClose={() => setExecutionModalOpen(false)}
        onConfirm={() => void confirmExecution()}
      />

      <AutomationModal
        open={automationModalOpen}
        selectedAnnotation={selectedAnnotation}
        automation={selectedAnnotation ? automationByStrategyId[selectedAnnotation.strategy.strategyId] ?? null : null}
        onClose={() => setAutomationModalOpen(false)}
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
