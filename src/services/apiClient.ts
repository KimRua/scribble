import type {
  Annotation,
  AuditEvent,
  AutomationRule,
  Candle,
  DelegatedAutomationConfig,
  DelegatedAutomationPolicy,
  Execution,
  ExecutionPlan,
  MarketOption,
  NotificationItem,
  StrategyValidation
} from '../types/domain';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';
const OPBNB_EXPLORER_BASE_URL = import.meta.env.VITE_OPBNB_EXPLORER_BASE_URL ?? 'https://opbnb-testnet.bscscan.com';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.error?.message ?? 'API request failed');
  }
  return payload.data;
}

function normalizeAnnotation(annotation: Annotation) {
  return annotation;
}

export async function getHealth() {
  return request<{
    ok: boolean;
    llmConfigured: boolean;
    marketDataEnabled?: boolean;
    marketDataProvider?: 'binance' | 'mock';
    onchainConfigured?: boolean;
    dexConfigured?: boolean;
    delegatedAutomationConfigured?: boolean;
    delegatedExecutorAddress?: string | null;
    delegationVaultAddress?: string | null;
  }>('/api/v1/health');
}

function normalizeDelegatedPolicy(policy: DelegatedAutomationPolicy) {
  return policy;
}

export async function getDelegationConfig() {
  return request<DelegatedAutomationConfig>('/api/v1/delegations/config');
}

export async function getDelegationPolicies(filters?: { ownerAddress?: string; strategyId?: string }) {
  const query = new URLSearchParams();
  if (filters?.ownerAddress) query.set('owner_address', filters.ownerAddress);
  if (filters?.strategyId) query.set('strategy_id', filters.strategyId);
  const data = await request<{
    policies: DelegatedAutomationPolicy[];
    ready: boolean;
    executorAddress: string | null;
    vaultAddress: string | null;
    missing: string[];
  }>(`/api/v1/delegations${query.toString() ? `?${query.toString()}` : ''}`);

  return {
    policies: data.policies.map(normalizeDelegatedPolicy),
    config: {
      ready: data.ready,
      executorAddress: data.executorAddress,
      vaultAddress: data.vaultAddress,
      missing: data.missing
    } satisfies DelegatedAutomationConfig
  };
}

export async function createDelegationPolicy(input: {
  strategyId: string;
  ownerAddress: string;
  marketSymbol: string;
  maxOrderSizeUsd: number;
  maxSlippageBps: number;
  dailyLossLimitUsd: number;
  validUntil: string;
  approvalTxHash?: string | null;
}) {
  const data = await request<{
    policy: DelegatedAutomationPolicy;
    executor_address: string | null;
    vault_address: string | null;
    ready: boolean;
  }>('/api/v1/delegations', {
    method: 'POST',
    body: JSON.stringify({
      strategy_id: input.strategyId,
      owner_address: input.ownerAddress,
      market_symbol: input.marketSymbol,
      max_order_size_usd: input.maxOrderSizeUsd,
      max_slippage_bps: input.maxSlippageBps,
      daily_loss_limit_usd: input.dailyLossLimitUsd,
      valid_until: input.validUntil,
      approval_tx_hash: input.approvalTxHash ?? null
    })
  });

  return {
    policy: normalizeDelegatedPolicy(data.policy),
    config: {
      ready: data.ready,
      executorAddress: data.executor_address,
      vaultAddress: data.vault_address,
      missing: []
    } satisfies DelegatedAutomationConfig
  };
}

export async function getMarkets() {
  const data = await request<{ markets: MarketOption[] }>('/api/v1/markets');
  return data.markets;
}

export async function getCandles(symbol: string, timeframe: string) {
  const data = await request<{ symbol: string; timeframe: string; source?: 'binance' | 'mock'; candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>; }>(`/api/v1/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
  return data.candles.map<Candle>((candle) => ({
    openTime: candle.open_time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume)
  }));
}

export async function getAnnotations(symbol: string, timeframe: string) {
  const data = await request<{ annotations: Annotation[] }>(`/api/v1/annotations?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
  return data.annotations.map(normalizeAnnotation);
}

function normalizeExecution(execution: {
  execution_id: string;
  strategy_id: string;
  status: Execution['status'];
  execution_chain: Execution['executionChain'];
  liquidity_chain: Execution['liquidityChain'];
  execution_chain_tx_hash: string;
  liquidity_chain_tx_hash: string;
  settlement_mode?: 'mock' | 'dex';
  dex_executed?: boolean;
  dex_router_address?: string | null;
  proof_recorded?: boolean;
  proof_registry_id?: string | null;
  proof_contract_address?: string | null;
  filled_price?: number | null;
  filled_at?: string | null;
}): Execution {
  return {
    executionId: execution.execution_id,
    strategyId: execution.strategy_id,
    status: execution.status,
    executionChain: execution.execution_chain,
    liquidityChain: execution.liquidity_chain,
    executionChainTxHash: execution.execution_chain_tx_hash,
    liquidityChainTxHash: execution.liquidity_chain_tx_hash,
    settlementMode: execution.settlement_mode,
    dexExecuted: execution.dex_executed,
    dexRouterAddress: execution.dex_router_address ?? null,
    proofRecorded: execution.proof_recorded,
    proofRegistryId: execution.proof_registry_id ?? null,
    proofContractAddress: execution.proof_contract_address ?? null,
    filledPrice: execution.filled_price ?? undefined,
    filledAt: execution.filled_at ?? undefined
  };
}

export async function getExecutions(symbol?: string, timeframe?: string) {
  const query = new URLSearchParams();
  if (symbol) query.set('symbol', symbol);
  if (timeframe) query.set('timeframe', timeframe);
  const data = await request<{
    executions: Array<{
      execution_id: string;
      strategy_id: string;
      status: Execution['status'];
      execution_chain: Execution['executionChain'];
      liquidity_chain: Execution['liquidityChain'];
      execution_chain_tx_hash: string;
      liquidity_chain_tx_hash: string;
      settlement_mode?: 'mock' | 'dex';
      dex_executed?: boolean;
      dex_router_address?: string | null;
      proof_recorded?: boolean;
      proof_registry_id?: string | null;
      proof_contract_address?: string | null;
      filled_price?: number | null;
      filled_at?: string | null;
    }>;
  }>(`/api/v1/executions${query.toString() ? `?${query.toString()}` : ''}`);
  return data.executions.map(normalizeExecution);
}

export async function createAnnotation(input: { marketSymbol: string; timeframe: string; text: string; chartAnchor: { time: string; price: number; index: number; }; visibility?: 'private' | 'public' | 'unlisted'; }) {
  const data = await request<{ annotation: Annotation; parsing_notes: string[] }>(`/api/v1/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      market_symbol: input.marketSymbol,
      timeframe: input.timeframe,
      text: input.text,
      chart_anchor: input.chartAnchor,
      visibility: input.visibility ?? 'private'
    })
  });
  return data;
}

export async function updateAnnotation(annotationId: string, input: {
  text?: string;
  bias?: Annotation['strategy']['bias'];
  entryType?: Annotation['strategy']['entryType'];
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrices?: number[];
  invalidationCondition?: string;
  confidence?: number;
  riskLevel?: Annotation['strategy']['riskLevel'];
  positionSizeRatio?: number;
  leverage?: number;
  autoExecuteEnabled?: boolean;
}) {
  const data = await request<{ annotation: Annotation; parsing_notes: string[] }>(`/api/v1/annotations/${annotationId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      text: input.text,
      bias: input.bias,
      entry_type: input.entryType,
      entry_price: input.entryPrice,
      stop_loss_price: input.stopLossPrice,
      take_profit_prices: input.takeProfitPrices,
      invalidation_condition: input.invalidationCondition,
      confidence: input.confidence,
      risk_level: input.riskLevel,
      position_size_ratio: input.positionSizeRatio,
      leverage: input.leverage,
      auto_execute_enabled: input.autoExecuteEnabled
    })
  });
  return data;
}

export async function analyzeChart(input: { marketSymbol: string; timeframe: string; riskLevel: 'conservative' | 'balanced' | 'aggressive'; defaultPositionSizeRatio: number; leverage: number; }) {
  const data = await request<{ annotation: Annotation; strategy: Annotation['strategy']; provider: 'openai' | 'fallback' }>(`/api/v1/ai/analyze`, {
    method: 'POST',
    body: JSON.stringify({
      market_symbol: input.marketSymbol,
      timeframe: input.timeframe,
      user_preferences: {
        risk_level: input.riskLevel,
        default_position_size_ratio: input.defaultPositionSizeRatio,
        leverage: input.leverage
      }
    })
  });
  return data;
}

export async function validateStrategyApi(strategyId: string) {
  const data = await request<{ is_valid: boolean; violations: string[]; risk_summary: { max_loss_ratio: number; max_loss_amount: number; risk_reward_ratio: number; estimated_liquidation_risk: 'low' | 'medium' | 'high'; }; }>(`/api/v1/strategies/${strategyId}/validate`, { method: 'POST' });
  const validation: StrategyValidation = {
    isValid: data.is_valid,
    violations: data.violations,
    riskSummary: {
      maxLossRatio: data.risk_summary.max_loss_ratio,
      maxLossAmount: data.risk_summary.max_loss_amount,
      riskRewardRatio: data.risk_summary.risk_reward_ratio,
      liquidationRisk: data.risk_summary.estimated_liquidation_risk
    }
  };
  return validation;
}

export async function previewExecution(strategyId: string) {
  const data = await request<{ execution_plan: { execution_chain: 'opbnb'; liquidity_chain: 'bsc'; entry_price: string; position_size: string; estimated_slippage: string; estimated_fee: string; guardrail_check: { passed: boolean; violations: string[]; }; }; }>(`/api/v1/executions/preview`, {
    method: 'POST',
    body: JSON.stringify({ strategy_id: strategyId })
  });
  const plan: ExecutionPlan = {
    executionChain: data.execution_plan.execution_chain,
    liquidityChain: data.execution_plan.liquidity_chain,
    entryPrice: Number(data.execution_plan.entry_price),
    positionSize: Number(data.execution_plan.position_size),
    estimatedSlippage: Number(data.execution_plan.estimated_slippage),
    estimatedFee: Number(data.execution_plan.estimated_fee),
    guardrailCheck: data.execution_plan.guardrail_check
  };
  return plan;
}

export async function createExecution(strategyId: string) {
  const data = await request<{
    execution_id: string;
    status: Execution['status'];
    execution_chain_tx_hash: string;
    liquidity_chain_tx_hash: string;
    settlement_mode?: 'mock' | 'dex';
    dex_executed?: boolean;
    dex_router_address: string | null;
    proof_recorded: boolean;
    proof_registry_id: string | null;
    proof_contract_address: string | null;
  }>(`/api/v1/executions`, {
    method: 'POST',
    body: JSON.stringify({ strategy_id: strategyId, mode: 'manual_confirmed' })
  });
  return normalizeExecution({
    ...data,
    strategy_id: strategyId,
    execution_chain: 'opbnb',
    liquidity_chain: 'bsc',
    filled_price: null,
    filled_at: null
  });
}

export function getOpbnbTxUrl(txHash: string) {
  return `${OPBNB_EXPLORER_BASE_URL}/tx/${txHash}`;
}

export function getOpbnbAddressUrl(address: string) {
  return `${OPBNB_EXPLORER_BASE_URL}/address/${address}`;
}

export async function createAutomation(strategyId: string, config: { maxPositionSizeRatio: number; maxLeverage: number; maxLossRatio: number; maxDailyExecutions: number; }) {
  const data = await request<{ automation_id: string; status: AutomationRule['status'] }>(`/api/v1/automations`, {
    method: 'POST',
    body: JSON.stringify({
      strategy_id: strategyId,
      enabled: true,
      guardrails: {
        max_position_size_ratio: config.maxPositionSizeRatio,
        max_leverage: config.maxLeverage,
        max_loss_ratio: config.maxLossRatio,
        max_daily_executions: config.maxDailyExecutions
      }
    })
  });
  return data;
}

export async function createAlert(annotationId: string, value: number) {
  return request<{ notification: NotificationItem }>(`/api/v1/alerts`, {
    method: 'POST',
    body: JSON.stringify({
      annotation_id: annotationId,
      type: 'price_touch',
      value: String(value),
      channels: ['in_app']
    })
  });
}

export async function getNotifications() {
  const data = await request<{ notifications: NotificationItem[] }>(`/api/v1/notifications`);
  return data.notifications;
}

export async function getAuditLogs(filters?: { annotationId?: string; strategyId?: string; executionId?: string }) {
  const query = new URLSearchParams();
  if (filters?.annotationId) query.set('annotation_id', filters.annotationId);
  if (filters?.strategyId) query.set('strategy_id', filters.strategyId);
  if (filters?.executionId) query.set('execution_id', filters.executionId);
  const data = await request<{ events: AuditEvent[] }>(`/api/v1/audit-logs${query.toString() ? `?${query.toString()}` : ''}`);
  return data.events;
}

export function subscribeMarketStream(
  symbol: string,
  timeframe: string,
  handlers: {
    onMessage: (payload: {
      symbol: string;
      timeframe: string;
      source: 'binance' | 'mock';
      current_price: number;
      candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>;
    }) => void;
    onError?: () => void;
  }
) {
  const streamUrl = new URL(`/api/v1/market-data/stream?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`, API_BASE_URL).toString();
  const eventSource = new EventSource(streamUrl);

  eventSource.onmessage = (event) => {
    handlers.onMessage(JSON.parse(event.data) as {
      symbol: string;
      timeframe: string;
      source: 'binance' | 'mock';
      current_price: number;
      candles: Array<{ open_time: string; open: string; high: string; low: string; close: string; volume: string; }>;
    });
  };

  eventSource.onerror = () => {
    handlers.onError?.();
  };

  return () => {
    eventSource.close();
  };
}
