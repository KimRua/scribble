import crypto from 'node:crypto';
import type { Execution, ExecutionPlan, Strategy, UserSettings } from '../../src/types/domain';
import { validateStrategy } from '../../src/utils/strategy';

const DEFAULT_BASE_URL = 'https://testnet.binancefuture.com';
const DEFAULT_FEE_RATE = 0.0004;
const DEFAULT_SLIPPAGE_ESTIMATE = 0.001;

type ExchangeInfoResponse = {
  symbols: Array<{
    symbol: string;
    filters: Array<
      | { filterType: 'PRICE_FILTER'; minPrice: string; maxPrice: string; tickSize: string }
      | { filterType: 'LOT_SIZE'; minQty: string; maxQty: string; stepSize: string }
      | { filterType: 'MARKET_LOT_SIZE'; minQty: string; maxQty: string; stepSize: string }
      | { filterType: 'MIN_NOTIONAL'; notional: string }
      | { filterType: string; [key: string]: unknown }
    >;
  }>;
};

type FuturesBalanceRow = {
  asset: string;
  availableBalance: string;
  balance: string;
};

type FuturesLeverageResponse = {
  leverage: number;
  symbol: string;
  maxNotionalValue: string;
};

type FuturesOrderResponse = {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: string;
  avgPrice?: string;
  executedQty?: string;
  origQty?: string;
  side: 'BUY' | 'SELL';
  reduceOnly?: boolean;
  updateTime?: number;
};

type FuturesPositionRow = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  leverage: string;
  markPrice: string;
};

interface SymbolFilters {
  tickSize: string;
  stepSize: string;
  minQty: number;
  minNotional: number;
}

export interface FuturesTestnetConfigStatus {
  enabled: boolean;
  ready: boolean;
  missing: string[];
  baseUrl: string;
}

export interface FuturesExecutionReceipt {
  enabled: boolean;
  ready: boolean;
  executed: boolean;
  executionChain: string;
  liquidityChain: string;
  settlementMode: NonNullable<Execution['settlementMode']>;
  externalVenue: NonNullable<Execution['externalVenue']>;
  externalOrderId: string | null;
  externalClientOrderId: string | null;
  leverageUsed: number;
  executedQuantity: string;
  side: 'BUY' | 'SELL';
  reduceOnly: boolean;
  status: Execution['status'];
  filledPrice: number | null;
  filledAt: string;
}

let exchangeInfoCache: ExchangeInfoResponse | null = null;

function getBaseUrl() {
  return process.env.BINANCE_FUTURES_TESTNET_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function getApiKey() {
  return process.env.BINANCE_FUTURES_TESTNET_API_KEY?.trim() || '';
}

function getApiSecret() {
  return process.env.BINANCE_FUTURES_TESTNET_API_SECRET?.trim() || '';
}

function getRecvWindow() {
  return Number(process.env.BINANCE_FUTURES_TESTNET_RECV_WINDOW ?? 5000);
}

function getTradingAsset() {
  return (process.env.BINANCE_FUTURES_TESTNET_MARGIN_ASSET ?? 'USDT').trim().toUpperCase();
}

function getNormalizedSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

async function parseJsonResponse<T>(response: Response) {
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as T | { msg?: string }) : ({} as T | { msg?: string });

  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'msg' in payload && payload.msg
      ? payload.msg
      : `binance futures testnet request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function requestPublic<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }

  const url = `${getBaseUrl()}${path}${params.size ? `?${params.toString()}` : ''}`;
  const response = await fetch(url, { method: 'GET' });
  return parseJsonResponse<T>(response);
}

async function requestSigned<T>(
  path: string,
  method: 'GET' | 'POST',
  query?: Record<string, string | number | boolean | undefined>
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  params.set('recvWindow', String(getRecvWindow()));
  params.set('timestamp', String(Date.now()));

  const signature = crypto.createHmac('sha256', getApiSecret()).update(params.toString()).digest('hex');
  params.set('signature', signature);

  const response = await fetch(`${getBaseUrl()}${path}?${params.toString()}`, {
    method,
    headers: {
      'X-MBX-APIKEY': getApiKey()
    }
  });

  return parseJsonResponse<T>(response);
}

function getDecimalPlaces(value: string) {
  if (!value.includes('.')) {
    return 0;
  }

  return value.replace(/0+$/, '').split('.')[1]?.length ?? 0;
}

function floorToStep(value: number, step: number) {
  if (!Number.isFinite(value) || step <= 0) {
    return 0;
  }

  return Math.floor(value / step) * step;
}

function formatStepValue(value: number, stepSize: string) {
  const decimals = getDecimalPlaces(stepSize);
  return value.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, '').replace(/\.$/, '');
}

async function getExchangeInfo() {
  if (!exchangeInfoCache) {
    exchangeInfoCache = await requestPublic<ExchangeInfoResponse>('/fapi/v1/exchangeInfo');
  }

  return exchangeInfoCache;
}

async function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const exchangeInfo = await getExchangeInfo();
  const normalizedSymbol = getNormalizedSymbol(symbol);
  const symbolInfo = exchangeInfo.symbols.find((item) => item.symbol === normalizedSymbol);
  if (!symbolInfo) {
    throw new Error(`${normalizedSymbol} is not available on Binance Futures testnet.`);
  }

  const priceFilter = symbolInfo.filters.find((filter) => filter.filterType === 'PRICE_FILTER') as Extract<ExchangeInfoResponse['symbols'][number]['filters'][number], { filterType: 'PRICE_FILTER' }> | undefined;
  const marketLotFilter = symbolInfo.filters.find((filter) => filter.filterType === 'MARKET_LOT_SIZE') as Extract<ExchangeInfoResponse['symbols'][number]['filters'][number], { filterType: 'MARKET_LOT_SIZE' }> | undefined;
  const lotFilter = symbolInfo.filters.find((filter) => filter.filterType === 'LOT_SIZE') as Extract<ExchangeInfoResponse['symbols'][number]['filters'][number], { filterType: 'LOT_SIZE' }> | undefined;
  const minNotionalFilter = symbolInfo.filters.find((filter) => filter.filterType === 'MIN_NOTIONAL') as Extract<ExchangeInfoResponse['symbols'][number]['filters'][number], { filterType: 'MIN_NOTIONAL' }> | undefined;

  const activeLotFilter = marketLotFilter ?? lotFilter;
  if (!priceFilter || !activeLotFilter) {
    throw new Error(`Unable to resolve trading filters for ${normalizedSymbol}.`);
  }

  return {
    tickSize: priceFilter.tickSize,
    stepSize: activeLotFilter.stepSize,
    minQty: Number(activeLotFilter.minQty),
    minNotional: Number(minNotionalFilter?.notional ?? 5)
  };
}

async function getAvailableMarginBalance() {
  const balanceRows = await requestSigned<FuturesBalanceRow[]>('/fapi/v3/balance', 'GET');
  const marginAsset = getTradingAsset();
  const row = balanceRows.find((item) => item.asset.toUpperCase() === marginAsset);
  if (!row) {
    throw new Error(`${marginAsset} balance was not found on Binance Futures testnet.`);
  }

  const availableBalance = Number(row.availableBalance);
  if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
    throw new Error(`No available ${marginAsset} balance found on Binance Futures testnet.`);
  }

  return availableBalance;
}

function mapOrderStatus(status: string): Execution['status'] {
  switch (status.toUpperCase()) {
    case 'FILLED':
      return 'Filled';
    case 'PARTIALLY_FILLED':
      return 'PartiallyFilled';
    case 'CANCELED':
      return 'Cancelled';
    case 'REJECTED':
    case 'EXPIRED':
      return 'Failed';
    case 'NEW':
      return 'Pending';
    default:
      return 'Executing';
  }
}

async function setInitialLeverage(symbol: string, leverage: number) {
  return requestSigned<FuturesLeverageResponse>('/fapi/v1/leverage', 'POST', {
    symbol: getNormalizedSymbol(symbol),
    leverage: Math.max(1, Math.trunc(leverage))
  });
}

async function resolveOrderSizing(strategy: Strategy, marketSymbol: string, referencePrice: number) {
  const availableBalance = await getAvailableMarginBalance();
  const filters = await getSymbolFilters(marketSymbol);
  const step = Number(filters.stepSize);
  const targetMargin = availableBalance * strategy.positionSizeRatio;
  const targetNotional = targetMargin * strategy.leverage;
  const rawQuantity = targetNotional / referencePrice;
  const roundedQuantity = floorToStep(rawQuantity, step);
  const effectiveQuantity = roundedQuantity >= filters.minQty ? roundedQuantity : 0;

  if (!Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0) {
    throw new Error(`Calculated quantity for ${marketSymbol} is below the exchange minimum size.`);
  }

  const actualNotional = effectiveQuantity * referencePrice;
  if (actualNotional < filters.minNotional) {
    throw new Error(`Calculated order notional ${actualNotional.toFixed(2)} is below the exchange minimum of ${filters.minNotional}.`);
  }

  return {
    availableBalance,
    marginAllocated: Number(targetMargin.toFixed(2)),
    notionalUsd: Number(actualNotional.toFixed(2)),
    quantity: formatStepValue(effectiveQuantity, filters.stepSize),
    leverage: strategy.leverage,
    filters
  };
}

export function getFuturesTestnetConfigStatus(): FuturesTestnetConfigStatus {
  const enabled = (process.env.ENABLE_FUTURES_TESTNET_EXECUTION ?? 'false').toLowerCase() === 'true';
  const required = {
    BINANCE_FUTURES_TESTNET_API_KEY: getApiKey(),
    BINANCE_FUTURES_TESTNET_API_SECRET: getApiSecret()
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    enabled,
    ready: enabled && missing.length === 0,
    missing,
    baseUrl: getBaseUrl()
  };
}

export async function createFuturesExecutionPreview(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number,
  settings: UserSettings
): Promise<ExecutionPlan> {
  const validation = validateStrategy(strategy, currentPrice, settings);
  const sizing = await resolveOrderSizing(strategy, marketSymbol, currentPrice);
  const estimatedFee = Number((sizing.notionalUsd * DEFAULT_FEE_RATE).toFixed(2));

  return {
    executionChain: 'binance-testnet',
    liquidityChain: 'binance-futures-testnet',
    entryPrice: currentPrice,
    positionSize: sizing.notionalUsd,
    estimatedSlippage: DEFAULT_SLIPPAGE_ESTIMATE,
    estimatedFee,
    guardrailCheck: {
      passed: validation.isValid,
      violations: validation.violations
    }
  };
}

export async function executeFuturesTestnetOrder(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number
): Promise<FuturesExecutionReceipt> {
  const status = getFuturesTestnetConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready,
      executed: false,
      executionChain: 'binance-testnet',
      liquidityChain: 'binance-futures-testnet',
      settlementMode: 'futures_testnet',
      externalVenue: 'binance_futures_testnet',
      externalOrderId: null,
      externalClientOrderId: null,
      leverageUsed: strategy.leverage,
      executedQuantity: '0',
      side: strategy.bias === 'bearish' ? 'SELL' : 'BUY',
      reduceOnly: false,
      status: 'Failed',
      filledPrice: null,
      filledAt: new Date().toISOString()
    };
  }

  if (strategy.bias === 'neutral') {
    throw new Error('Neutral strategies cannot be executed on futures testnet.');
  }

  const normalizedSymbol = getNormalizedSymbol(marketSymbol);
  const sizing = await resolveOrderSizing(strategy, normalizedSymbol, currentPrice);
  await setInitialLeverage(normalizedSymbol, strategy.leverage);

  const order = await requestSigned<FuturesOrderResponse>('/fapi/v1/order', 'POST', {
    symbol: normalizedSymbol,
    side: strategy.bias === 'bearish' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: sizing.quantity,
    newOrderRespType: 'RESULT'
  });

  return {
    enabled: true,
    ready: true,
    executed: true,
    executionChain: 'binance-testnet',
    liquidityChain: 'binance-futures-testnet',
    settlementMode: 'futures_testnet',
    externalVenue: 'binance_futures_testnet',
    externalOrderId: String(order.orderId),
    externalClientOrderId: order.clientOrderId,
    leverageUsed: strategy.leverage,
    executedQuantity: order.executedQty ?? sizing.quantity,
    side: order.side,
    reduceOnly: false,
    status: mapOrderStatus(order.status),
    filledPrice: order.avgPrice ? Number(order.avgPrice) : currentPrice,
    filledAt: new Date(order.updateTime ?? Date.now()).toISOString()
  };
}

async function getOpenPosition(symbol: string) {
  const normalizedSymbol = getNormalizedSymbol(symbol);
  const rows = await requestSigned<FuturesPositionRow[]>('/fapi/v2/positionRisk', 'GET', {
    symbol: normalizedSymbol
  });
  return rows.find((row) => row.symbol === normalizedSymbol) ?? null;
}

export async function closeFuturesTestnetPosition(
  marketSymbol: string,
  input: { mode: 'market' | 'price'; closePrice?: number }
): Promise<FuturesExecutionReceipt> {
  const status = getFuturesTestnetConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready,
      executed: false,
      executionChain: 'binance-testnet',
      liquidityChain: 'binance-futures-testnet',
      settlementMode: 'futures_testnet',
      externalVenue: 'binance_futures_testnet',
      externalOrderId: null,
      externalClientOrderId: null,
      leverageUsed: 1,
      executedQuantity: '0',
      side: 'SELL',
      reduceOnly: true,
      status: 'Failed',
      filledPrice: null,
      filledAt: new Date().toISOString()
    };
  }

  if (input.mode !== 'market') {
    throw new Error('Binance Futures testnet close currently supports market close only.');
  }

  const position = await getOpenPosition(marketSymbol);
  const positionAmount = Number(position?.positionAmt ?? 0);
  if (!position || !Number.isFinite(positionAmount) || positionAmount === 0) {
    throw new Error(`No open ${getNormalizedSymbol(marketSymbol)} futures position was found to close.`);
  }

  const filters = await getSymbolFilters(marketSymbol);
  const quantity = formatStepValue(Math.abs(positionAmount), filters.stepSize);
  const side: 'BUY' | 'SELL' = positionAmount > 0 ? 'SELL' : 'BUY';
  const order = await requestSigned<FuturesOrderResponse>('/fapi/v1/order', 'POST', {
    symbol: getNormalizedSymbol(marketSymbol),
    side,
    type: 'MARKET',
    quantity,
    reduceOnly: 'true',
    newOrderRespType: 'RESULT'
  });

  return {
    enabled: true,
    ready: true,
    executed: true,
    executionChain: 'binance-testnet',
    liquidityChain: 'binance-futures-testnet',
    settlementMode: 'futures_testnet',
    externalVenue: 'binance_futures_testnet',
    externalOrderId: String(order.orderId),
    externalClientOrderId: order.clientOrderId,
    leverageUsed: Number(position.leverage),
    executedQuantity: order.executedQty ?? quantity,
    side,
    reduceOnly: true,
    status: mapOrderStatus(order.status),
    filledPrice: order.avgPrice ? Number(order.avgPrice) : Number(position.markPrice),
    filledAt: new Date(order.updateTime ?? Date.now()).toISOString()
  };
}
