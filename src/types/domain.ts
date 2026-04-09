export type AuthorType = 'ai' | 'user' | 'community';
export type AnnotationStatus =
  | 'Draft'
  | 'Active'
  | 'Triggered'
  | 'Executed'
  | 'Closed'
  | 'Invalidated'
  | 'Archived';
export type OrderStatus =
  | 'Pending'
  | 'ReadyToExecute'
  | 'Executing'
  | 'Filled'
  | 'PartiallyFilled'
  | 'Cancelled'
  | 'Failed';
export type AutomationStatus = 'Disabled' | 'Armed' | 'Monitoring' | 'Triggered' | 'Executing' | 'Completed' | 'Halted';
export type EntryType = 'market' | 'limit' | 'conditional';
export type Bias = 'bullish' | 'bearish' | 'neutral';
export type RiskLevel = 'conservative' | 'balanced' | 'aggressive';
export type Visibility = 'private' | 'public' | 'unlisted';
export type DrawingMode = 'none' | 'text' | 'line' | 'box';

export interface Candle {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartAnchor {
  time: string;
  price: number;
  index: number;
}

export interface DrawingObjectBase {
  id: string;
  role: 'entry' | 'stop_loss' | 'take_profit' | 'zone' | 'trendline' | 'note';
}

export interface LineDrawingObject extends DrawingObjectBase {
  type: 'line';
  price: number;
}

export interface BoxDrawingObject extends DrawingObjectBase {
  type: 'box';
  priceFrom: number;
  priceTo: number;
}

export interface TextDrawingObject extends DrawingObjectBase {
  type: 'text';
  text: string;
}

export type DrawingObject = LineDrawingObject | BoxDrawingObject | TextDrawingObject;

export interface Strategy {
  strategyId: string;
  annotationId: string;
  bias: Bias;
  entryType: EntryType;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrices: number[];
  invalidationCondition: string;
  confidence: number;
  riskLevel: RiskLevel;
  positionSizeRatio: number;
  leverage: number;
  autoExecuteEnabled: boolean;
}

export interface Annotation {
  annotationId: string;
  authorType: AuthorType;
  authorId: string;
  marketSymbol: string;
  timeframe: string;
  text: string;
  chartAnchor: ChartAnchor;
  drawingObjects: DrawingObject[];
  strategy: Strategy;
  status: AnnotationStatus;
  visibility: Visibility;
  sourceAnnotationId?: string;
  forkedFromAuthorId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RiskSummary {
  maxLossRatio: number;
  maxLossAmount: number;
  riskRewardRatio: number;
  liquidationRisk: 'low' | 'medium' | 'high';
}

export interface StrategyValidation {
  isValid: boolean;
  violations: string[];
  riskSummary: RiskSummary;
}

export interface NotificationItem {
  notificationId: string;
  type: 'strategy_triggered' | 'execution_filled' | 'strategy_invalidated' | 'alert_fired' | 'automation_halted';
  title: string;
  body: string;
  annotationId: string;
  createdAt: string;
  read: boolean;
}

export interface AuditEvent {
  eventId: string;
  eventType:
    | 'ai_analysis_requested'
    | 'annotation_created'
    | 'annotation_edited'
    | 'strategy_validated'
    | 'strategy_invalid'
    | 'execute_clicked'
    | 'execute_confirmed'
    | 'automation_enabled'
    | 'automation_triggered'
    | 'status_changed';
  entityType: 'annotation' | 'strategy' | 'execution' | 'automation';
  entityId: string;
  timestamp: string;
  metadata: Record<string, string | number | boolean>;
}

export interface ExecutionPlan {
  executionChain: 'opbnb';
  liquidityChain: 'bsc';
  entryPrice: number;
  positionSize: number;
  estimatedSlippage: number;
  estimatedFee: number;
  guardrailCheck: {
    passed: boolean;
    violations: string[];
  };
}

export interface Execution {
  executionId: string;
  strategyId: string;
  status: OrderStatus;
  executionChain: 'opbnb';
  liquidityChain: 'bsc';
  executionChainTxHash: string;
  liquidityChainTxHash: string;
  proofRecorded?: boolean;
  proofRegistryId?: string | null;
  proofContractAddress?: string | null;
  filledPrice?: number;
  filledAt?: string;
}

export interface AutomationRule {
  automationId: string;
  strategyId: string;
  status: AutomationStatus;
  triggerPrice: number;
  maxPositionSizeRatio: number;
  maxLeverage: number;
  maxLossRatio: number;
  maxDailyExecutions: number;
  stopConditions: string[];
}

export interface UserSettings {
  riskLevel: RiskLevel;
  defaultPositionSize: number;
  leverage: number;
  maxLeverage: number;
  accountBalance: number;
}

export interface MarketOption {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: 'active' | 'halted';
}

export interface ParserResult {
  strategy: Strategy;
  parsingNotes: string[];
  missingFields: string[];
}
