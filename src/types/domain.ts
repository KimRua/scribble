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
export type DelegationStatus = 'pending_approval' | 'active' | 'paused' | 'revoked' | 'expired';
export type EntryType = 'market' | 'limit' | 'conditional';
export type Bias = 'bullish' | 'bearish' | 'neutral';
export type RiskLevel = 'conservative' | 'balanced' | 'aggressive';
export type Visibility = 'private' | 'public' | 'unlisted';
export type DrawingMode = 'none' | 'text' | 'line' | 'box' | 'segment';

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

export interface SegmentDrawingObject extends DrawingObjectBase {
  type: 'segment';
  startAnchor: ChartAnchor;
  endAnchor: ChartAnchor;
}

export interface TextDrawingObject extends DrawingObjectBase {
  type: 'text';
  text: string;
}

export type DrawingObject = LineDrawingObject | BoxDrawingObject | SegmentDrawingObject | TextDrawingObject;

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
  ownerKey?: string | null;
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
  sessionId?: string | null;
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
  sessionId?: string | null;
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
  sessionId?: string | null;
  actionType?: 'open' | 'close';
  closeMode?: 'market' | 'price' | null;
  status: OrderStatus;
  executionChain: 'opbnb';
  liquidityChain: 'bsc';
  executionChainTxHash: string | null;
  liquidityChainTxHash: string | null;
  executionChainTxStatus?: 'pending' | 'success' | 'reverted' | 'unavailable';
  liquidityChainTxStatus?: 'pending' | 'success' | 'reverted' | 'unavailable';
  executionChainBlockNumber?: number | null;
  liquidityChainBlockNumber?: number | null;
  executionChainLogCount?: number | null;
  liquidityChainLogCount?: number | null;
  liquidityTransferCount?: number | null;
  liquiditySwapEventCount?: number | null;
  liquidityTouchedContractCount?: number | null;
  liquiditySettlementState?:
    | 'mock_fallback'
    | 'pending_receipt'
    | 'settled_with_swap_event'
    | 'settled_with_transfer_events'
    | 'settled_without_decoded_events'
    | 'reverted'
    | 'receipt_unavailable';
  executionChainCheckedAt?: string | null;
  liquidityChainCheckedAt?: string | null;
  executionChainTxHashValid?: boolean;
  liquidityChainTxHashValid?: boolean;
  txHashWarning?: string | null;
  settlementMode?: 'mock' | 'dex';
  dexExecuted?: boolean;
  executionTxState?: 'not_submitted' | 'receipt_observed' | 'submitted_receipt_unavailable';
  liquidityReceiptEvidence?: 'mock_fallback' | 'receipt_observed' | 'receipt_observed_hash_hidden' | 'receipt_not_observed';
  dexRouterAddress?: string | null;
  dexInputTokenAddress?: string | null;
  dexOutputTokenAddress?: string | null;
  dexAmountIn?: string | null;
  dexExpectedAmountOut?: string | null;
  dexMinimumAmountOut?: string | null;
  proofAttempted?: boolean;
  proofRetryCount?: number;
  proofErrorMessage?: string | null;
  proofRecorded?: boolean;
  proofState?: 'recorded' | 'attempted_not_recorded' | 'not_attempted';
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

export interface DelegatedAutomationPolicy {
  policyId: string;
  strategyId: string;
  ownerAddress: string;
  delegateAddress: string;
  marketSymbol: string;
  status: DelegationStatus;
  maxOrderSizeUsd: number;
  maxSlippageBps: number;
  dailyLossLimitUsd: number;
  validUntil: string;
  approvalTxHash?: string | null;
  vaultAddress?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedAutomationConfig {
  ready: boolean;
  executorAddress: string | null;
  vaultAddress: string | null;
  missing: string[];
}

export interface WalletSession {
  address: string;
  chainId: number;
  nativeBalance?: number;
  nativeSymbol?: string;
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
