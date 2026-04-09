import { useEffect, useMemo, useState } from 'react';
import { buildSeedAnnotations, defaultUserSettings, generateCandles, marketOptions } from '../data/mockMarket';
import { createAuditEvent } from '../services/auditLogService';
import { generateAiAnnotation } from '../services/aiService';
import { armAutomation, createExecutionPreview, executeStrategy, simulatePriceTick } from '../services/executionService';
import { parseAnnotationText } from '../services/parserService';
import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  DrawingObject,
  DrawingMode,
  Execution,
  NotificationItem,
  Strategy,
  StrategyValidation
} from '../types/domain';
import { createAnnotationFromText, syncAnnotationWithStrategy } from '../utils/annotation';
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
  const [candles, setCandles] = useState(() => generateCandles('BTCUSDT', '1h'));
  const [annotations, setAnnotations] = useState<Annotation[]>(() => buildSeedAnnotations('BTCUSDT', '1h', generateCandles('BTCUSDT', '1h')));
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>('ann_seed_ai');
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('none');
  const [currentPrice, setCurrentPrice] = useState(() => generateCandles('BTCUSDT', '1h').slice(-1)[0].close);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [automationByStrategyId, setAutomationByStrategyId] = useState<Record<string, AutomationRule>>({});
  const [executionPreview, setExecutionPreview] = useState<ReturnType<typeof createExecutionPreview> | null>(null);
  const [executionMode, setExecutionMode] = useState<'execute' | 'conditional'>('execute');
  const [executionModalOpen, setExecutionModalOpen] = useState(false);
  const [automationModalOpen, setAutomationModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [parsingNotesByAnnotationId, setParsingNotesByAnnotationId] = useState<Record<string, string[]>>({});
  const [lastExecution, setLastExecution] = useState<Execution | null>(null);

  useEffect(() => {
    const nextCandles = generateCandles(selectedSymbol, timeframe);
    const nextAnnotations = buildSeedAnnotations(selectedSymbol, timeframe, nextCandles);
    setCandles(nextCandles);
    setAnnotations(nextAnnotations);
    setSelectedAnnotationId(nextAnnotations[0]?.annotationId ?? null);
    setCurrentPrice(nextCandles[nextCandles.length - 1]?.close ?? 0);
    setAutomationByStrategyId({});
    setLastExecution(null);
  }, [selectedSymbol, timeframe]);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.annotationId === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId]
  );

  const visibleLevels = useMemo(() => candles.slice(-10).flatMap((candle) => [candle.high, candle.low, candle.close]), [candles]);

  const validation: StrategyValidation | null = useMemo(() => {
    return selectedAnnotation ? validateStrategy(selectedAnnotation.strategy, currentPrice, defaultUserSettings) : null;
  }, [selectedAnnotation, currentPrice]);

  const selectedAuditEvents = useMemo(() => {
    if (!selectedAnnotation) {
      return [];
    }
    return auditEvents.filter((event) => event.entityId === selectedAnnotation.annotationId || event.entityId === selectedAnnotation.strategy.strategyId).slice(0, 8);
  }, [auditEvents, selectedAnnotation]);

  const parsingNotes = selectedAnnotation ? parsingNotesByAnnotationId[selectedAnnotation.annotationId] ?? [] : [];

  useEffect(() => {
    if (!selectedAnnotation) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const parsed = parseAnnotationText(selectedAnnotation.text, {
        currentPrice,
        visibleLevels,
        annotationId: selectedAnnotation.annotationId
      });
      setParsingNotesByAnnotationId((prev) => ({ ...prev, [selectedAnnotation.annotationId]: parsed.parsingNotes }));
      setAnnotations((prev) =>
        prev.map((annotation) => {
          if (annotation.annotationId !== selectedAnnotation.annotationId || annotation.authorType === 'ai') {
            return annotation;
          }
          return syncAnnotationWithStrategy(annotation, {
            ...annotation.strategy,
            ...parsed.strategy,
            positionSizeRatio: annotation.strategy.positionSizeRatio,
            leverage: annotation.strategy.leverage,
            autoExecuteEnabled: annotation.strategy.autoExecuteEnabled
          });
        })
      );
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [currentPrice, selectedAnnotation?.annotationId, selectedAnnotation?.text, visibleLevels]);

  const recordAudit = (event: AuditEvent) => {
    setAuditEvents((prev) => [event, ...prev]);
  };

  const pushNotifications = (items: NotificationItem[]) => {
    if (items.length === 0) {
      return;
    }
    setNotifications((prev) => [...items, ...prev].slice(0, 20));
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
  };

  const handleRequestAi = () => {
    const annotation = generateAiAnnotation({
      symbol: selectedSymbol,
      timeframe,
      candles,
      settings: defaultUserSettings
    });
    setAnnotations((prev) => [annotation, ...prev]);
    setSelectedAnnotationId(annotation.annotationId);
    recordAudit(createAuditEvent('ai_analysis_requested', 'annotation', annotation.annotationId, { symbol: selectedSymbol, timeframe }));
  };

  const handleCreateAnnotation = (text: string, anchor: Annotation['chartAnchor']) => {
    const annotationId = `ann_user_${Date.now()}`;
    const parsed = parseAnnotationText(text, {
      currentPrice,
      visibleLevels,
      annotationId
    });
    const annotation = createAnnotationFromText({
      annotationId,
      symbol: selectedSymbol,
      timeframe,
      text,
      authorType: 'user',
      authorId: 'me',
      anchor,
      strategy: parsed.strategy
    });
    setAnnotations((prev) => [annotation, ...prev]);
    setSelectedAnnotationId(annotationId);
    setDrawingMode('none');
    setParsingNotesByAnnotationId((prev) => ({ ...prev, [annotationId]: parsed.parsingNotes }));
    recordAudit(createAuditEvent('annotation_created', 'annotation', annotationId, { symbol: selectedSymbol, timeframe }));
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
    recordAudit(createAuditEvent('annotation_edited', 'annotation', selectedAnnotation.annotationId, { textLength: text.length }));
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

  const openExecutionFlow = (mode: 'execute' | 'conditional') => {
    if (!selectedAnnotation) {
      return;
    }
    const preview = createExecutionPreview(selectedAnnotation.strategy, currentPrice, defaultUserSettings);
    setExecutionPreview(preview);
    setExecutionMode(mode);
    setExecutionModalOpen(true);
    recordAudit(createAuditEvent('execute_clicked', 'strategy', selectedAnnotation.strategy.strategyId, { mode }));
  };

  const confirmExecution = () => {
    if (!selectedAnnotation) {
      return;
    }

    if (executionMode === 'conditional') {
      activateSelectedAnnotation();
      const notification: NotificationItem = {
        notificationId: `noti_${Date.now()}_conditional`,
        type: 'alert_fired',
        title: '조건 주문 생성 완료',
        body: `${selectedAnnotation.marketSymbol} 조건 주문이 등록되었습니다.`,
        annotationId: selectedAnnotation.annotationId,
        createdAt: new Date().toISOString(),
        read: false
      };
      pushNotifications([notification]);
    } else {
      const execution = executeStrategy(selectedAnnotation.strategy);
      setLastExecution(execution);
      upsertAnnotation(selectedAnnotation.annotationId, (annotation) => ({
        ...annotation,
        status: 'Executed',
        updatedAt: new Date().toISOString()
      }));
      pushNotifications([
        {
          notificationId: `noti_${Date.now()}_filled`,
          type: 'execution_filled',
          title: '주문 실행 완료',
          body: `${selectedAnnotation.marketSymbol} 전략이 실행되었습니다.`,
          annotationId: selectedAnnotation.annotationId,
          createdAt: new Date().toISOString(),
          read: false
        }
      ]);
      recordAudit(createAuditEvent('execute_confirmed', 'execution', execution.executionId, { executionChain: 'opbnb', liquidityChain: 'bsc' }));
    }

    setExecutionModalOpen(false);
  };

  const handleSetAlert = () => {
    if (!selectedAnnotation) {
      return;
    }
    activateSelectedAnnotation();
    const item: NotificationItem = {
      notificationId: `noti_${Date.now()}_alert`,
      type: 'alert_fired',
      title: '알림 등록 완료',
      body: `${selectedAnnotation.marketSymbol} ${selectedAnnotation.strategy.entryPrice} 조건 알림을 등록했습니다.`,
      annotationId: selectedAnnotation.annotationId,
      createdAt: new Date().toISOString(),
      read: false
    };
    pushNotifications([item]);
  };

  const handleSaveAutomation = (config: {
    maxPositionSizeRatio: number;
    maxLeverage: number;
    maxLossRatio: number;
    maxDailyExecutions: number;
  }) => {
    if (!selectedAnnotation) {
      return;
    }

    const automation = {
      ...armAutomation(selectedAnnotation.strategy, defaultUserSettings),
      ...config,
      status: 'Armed' as const
    };
    setAutomationByStrategyId((prev) => ({ ...prev, [selectedAnnotation.strategy.strategyId]: automation }));
    upsertAnnotation(selectedAnnotation.annotationId, (annotation) =>
      syncAnnotationWithStrategy(annotation, {
        ...annotation.strategy,
        autoExecuteEnabled: true
      })
    );
    activateSelectedAnnotation();
    pushNotifications([
      {
        notificationId: `noti_${Date.now()}_automation`,
        type: 'alert_fired',
        title: '자동 실행 Armed',
        body: `${selectedAnnotation.marketSymbol} 전략 자동 실행이 활성화되었습니다.`,
        annotationId: selectedAnnotation.annotationId,
        createdAt: new Date().toISOString(),
        read: false
      }
    ]);
    recordAudit(createAuditEvent('automation_enabled', 'automation', automation.automationId, { maxLeverage: config.maxLeverage }));
    setAutomationModalOpen(false);
  };

  const advancePrice = (nextPrice: number) => {
    setCurrentPrice(nextPrice);
    const notificationsBuffer: NotificationItem[] = [];
    let latestExecution: Execution | null = null;
    const nextAutomationState: Record<string, AutomationRule> = { ...automationByStrategyId };

    setAnnotations((prev) =>
      prev.map((annotation) => {
        const automation = automationByStrategyId[annotation.strategy.strategyId];
        const simulation = simulatePriceTick(annotation, nextPrice, automation);
        notificationsBuffer.push(...simulation.notifications);
        if (simulation.execution) {
          latestExecution = simulation.execution;
        }
        if (simulation.nextAutomation) {
          nextAutomationState[annotation.strategy.strategyId] = simulation.nextAutomation;
        }
        const autoStatus = simulation.execution ? 'Executed' : simulation.nextStatus;
        return {
          ...annotation,
          status: autoStatus,
          updatedAt: new Date().toISOString()
        };
      })
    );

    setAutomationByStrategyId(nextAutomationState);
    pushNotifications(notificationsBuffer);
    if (latestExecution) {
      setLastExecution(latestExecution);
    }
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
        connectionStatus="connected"
        markets={marketOptions}
        onChangeSymbol={setSelectedSymbol}
        onChangeTimeframe={setTimeframe}
        onToggleNotifications={() => setNotificationsOpen((prev) => !prev)}
        onToggleStrategies={() => setStrategiesOpen((prev) => !prev)}
      />

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
          parsingNotes={parsingNotes}
          auditEvents={selectedAuditEvents}
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
        onExecute={() => openExecutionFlow('execute')}
        onConditionalOrder={() => openExecutionFlow('conditional')}
        onSetAlert={handleSetAlert}
        onAutoExecute={() => setAutomationModalOpen(true)}
      />

      <ExecutionModal
        open={executionModalOpen}
        selectedAnnotation={selectedAnnotation}
        preview={executionPreview}
        validation={validation}
        mode={executionMode}
        onClose={() => setExecutionModalOpen(false)}
        onConfirm={confirmExecution}
      />

      <AutomationModal
        open={automationModalOpen}
        selectedAnnotation={selectedAnnotation}
        automation={selectedAnnotation ? automationByStrategyId[selectedAnnotation.strategy.strategyId] ?? null : null}
        onClose={() => setAutomationModalOpen(false)}
        onSave={handleSaveAutomation}
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
