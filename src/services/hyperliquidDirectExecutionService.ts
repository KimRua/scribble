import { encode } from '@msgpack/msgpack';
import { Signature, getBytes, keccak256 } from 'ethers';
import type { Execution, ExecutionPlan, Strategy, UserSettings } from '../types/domain';
import { validateStrategy } from '../utils/strategy';
import { getInjectedSigner } from './walletService';

const TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
const DEFAULT_FEE_RATE = 0.00045;
const DEFAULT_SLIPPAGE_ESTIMATE = 0.05;
const DEFAULT_TRANSFER_BUFFER_USDC = 0.5;
const SUPPORTED_QUOTES = ['USDT', 'USDC', 'USD'] as const;
const PHANTOM_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000'
} as const;
const TESTNET_CHAIN_DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 421614,
  verifyingContract: '0x0000000000000000000000000000000000000000'
} as const;

type TypedDataSigner = {
  getAddress(): Promise<string>;
  signTypedData(domain: Record<string, unknown>, types: Record<string, Array<{ name: string; type: string }>>, value: Record<string, unknown>): Promise<string>;
};

type MetaUniverseEntry = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
};

type SpotBalance = {
  coin: string;
  total: string;
  hold: string;
};

type SpotState = {
  balances: SpotBalance[];
};

type PerpPosition = {
  position: {
    coin: string;
    szi: string;
    leverage: {
      value: number;
    };
  };
};

type PerpState = {
  assetPositions: PerpPosition[];
  crossMarginSummary?: {
    accountValue: string;
  };
  marginSummary?: {
    accountValue: string;
  };
  withdrawable?: string;
};

type OrderStatusResponse = {
  status: string;
  response?: {
    data?: {
      statuses?: Array<{
        resting?: { oid: number };
        filled?: { oid: number; totalSz: string; avgPx: string };
      }>;
    };
  };
};

export type DirectOrderPlacementMode = 'market' | 'limit' | 'conditional';

export interface DirectHyperliquidReceipt {
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

function roundToCents(value: number) {
  return Number(value.toFixed(2));
}

function trimNumericString(value: number, decimals: number) {
  return value
    .toFixed(decimals)
    .replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, '')
    .replace(/\.$/, '');
}

function removeTrailingZeros(value: string) {
  if (!value.includes('.')) {
    return value;
  }

  const normalized = value.replace(/\.?0+$/, '');
  return normalized === '-0' ? '0' : normalized;
}

function floorToDecimals(value: number, decimals: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function toPerpSymbol(marketSymbol: string) {
  const normalized = marketSymbol.trim().toUpperCase();
  if (normalized.endsWith('-PERP')) {
    return normalized;
  }

  const quote = SUPPORTED_QUOTES.find((item) => normalized.endsWith(item));
  const base = quote ? normalized.slice(0, -quote.length) : normalized;
  return `${base}-PERP`;
}

function orderTypeToWire(orderType: {
  limit?: { tif: 'Alo' | 'Ioc' | 'Gtc' };
  trigger?: { triggerPx: string; isMarket: boolean; tpsl: 'tp' | 'sl' };
}) {
  if (orderType.limit) {
    return { limit: orderType.limit };
  }

  if (orderType.trigger) {
    return { trigger: orderType.trigger };
  }

  throw new Error('Unsupported Hyperliquid order type.');
}

function addressToBytes(address: string) {
  return getBytes(address);
}

function normalizeTrailingZeros(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTrailingZeros(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeTrailingZeros(entry)])
    );
  }

  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    return removeTrailingZeros(value);
  }

  return value;
}

function actionHash(action: unknown, vaultAddress: string | null, nonce: number) {
  const normalizedAction = normalizeTrailingZeros(action);
  const msgPackBytes = encode(normalizedAction);
  const additionalBytesLength = vaultAddress === null ? 9 : 29;
  const data = new Uint8Array(msgPackBytes.length + additionalBytesLength);
  data.set(msgPackBytes);
  const view = new DataView(data.buffer);
  view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  if (vaultAddress === null) {
    view.setUint8(msgPackBytes.length + 8, 0);
  } else {
    view.setUint8(msgPackBytes.length + 8, 1);
    data.set(addressToBytes(vaultAddress), msgPackBytes.length + 9);
  }
  return keccak256(data);
}

async function signL1Action(
  signer: TypedDataSigner,
  action: unknown,
  nonce: number,
  vaultAddress: string | null = null
) {
  const signature = await signer.signTypedData(
    PHANTOM_DOMAIN,
    {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    },
    {
      source: 'b',
      connectionId: actionHash(action, vaultAddress, nonce)
    }
  );

  const parsed = Signature.from(signature);
  return {
    r: parsed.r,
    s: parsed.s,
    v: parsed.v
  };
}

async function signUserAction(
  signer: TypedDataSigner,
  action: Record<string, unknown>,
  types: Array<{ name: string; type: string }>,
  primaryType: string
) {
  const signature = await signer.signTypedData(
    TESTNET_CHAIN_DOMAIN,
    { [primaryType]: types },
    action
  );
  const parsed = Signature.from(signature);
  return {
    r: parsed.r,
    s: parsed.s,
    v: parsed.v
  };
}

async function postExchange<T = OrderStatusResponse>(payload: Record<string, unknown>) {
  const response = await fetch(`${TESTNET_API_URL}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = (await response.json()) as { status?: string; response?: unknown };
  if (!response.ok || data.status !== 'ok') {
    throw new Error((data as { response?: string }).response || 'Hyperliquid exchange request failed.');
  }
  return data as T;
}

async function postInfo<T>(payload: Record<string, unknown>) {
  const response = await fetch(`${TESTNET_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Hyperliquid info request failed.');
  }

  return (await response.json()) as T;
}

async function getMeta() {
  return postInfo<{ universe: MetaUniverseEntry[] }>({ type: 'meta' });
}

async function getPerpState(walletAddress: string) {
  return postInfo<PerpState>({ type: 'clearinghouseState', user: walletAddress });
}

async function getSpotState(walletAddress: string) {
  return postInfo<SpotState>({ type: 'spotClearinghouseState', user: walletAddress });
}

async function getUserFillsByTime(walletAddress: string, startTime: number, endTime: number) {
  return postInfo<Array<{ oid: number; coin: string; px: string; sz: string }>>({
    type: 'userFillsByTime',
    user: walletAddress,
    startTime: Math.round(startTime),
    endTime: Math.round(endTime)
  });
}

function parseSpotUsdcAvailable(spotState: SpotState) {
  const usdc = spotState.balances.find((balance) => balance.coin.toUpperCase() === 'USDC');
  if (!usdc) {
    return 0;
  }

  return Math.max(0, Number(usdc.total) - Number(usdc.hold));
}

function parsePerpWithdrawable(perpState: PerpState) {
  return Math.max(0, Number(perpState.withdrawable || 0));
}

function parsePerpAccountValue(perpState: PerpState) {
  return Math.max(
    0,
    Number(perpState.crossMarginSummary?.accountValue ?? 0),
    Number(perpState.marginSummary?.accountValue ?? 0),
    Number(perpState.withdrawable ?? 0)
  );
}

function getAggressiveLimitPrice(referencePrice: number, isBuy: boolean) {
  const raw = referencePrice * (isBuy ? 1 + DEFAULT_SLIPPAGE_ESTIMATE : 1 - DEFAULT_SLIPPAGE_ESTIMATE);
  const decimals = Math.max(2, (referencePrice.toString().split('.')[1]?.length ?? 0) - 1);
  return trimNumericString(raw, decimals);
}

function getConfiguredLimitPrice(targetPrice: number, referencePrice: number) {
  const decimals = Math.max(
    2,
    (targetPrice.toString().split('.')[1]?.length ?? 0),
    (referencePrice.toString().split('.')[1]?.length ?? 0)
  );
  return trimNumericString(targetPrice, decimals);
}

function resolveTriggerType(isBuy: boolean, triggerPrice: number, referencePrice: number): 'tp' | 'sl' {
  if (isBuy) {
    return triggerPrice >= referencePrice ? 'sl' : 'tp';
  }

  return triggerPrice <= referencePrice ? 'sl' : 'tp';
}

function mapOrderStatus(status: string): Execution['status'] {
  const normalized = status.toUpperCase();
  if (normalized.includes('FILLED')) {
    return 'Filled';
  }
  if (normalized.includes('OPEN') || normalized.includes('RESTING')) {
    return 'Pending';
  }
  if (normalized.includes('PARTIAL')) {
    return 'PartiallyFilled';
  }
  if (normalized.includes('CANCEL')) {
    return 'Cancelled';
  }
  return 'Executing';
}

async function resolveUniverseEntry(perpSymbol: string) {
  const meta = await getMeta();
  const universe = meta.universe as MetaUniverseEntry[];
  const assetIndex = universe.findIndex((item) => item.name.toUpperCase() === perpSymbol.toUpperCase());
  if (assetIndex < 0) {
    throw new Error(`${perpSymbol} market is not available on Hyperliquid testnet.`);
  }

  return {
    entry: universe[assetIndex],
    assetIndex
  };
}

async function buildSizing(strategy: Strategy, marketSymbol: string, referencePrice: number, walletAddress: string) {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error('유효한 시장가가 필요합니다.');
  }

  const perpSymbol = toPerpSymbol(marketSymbol);
  const [{ entry, assetIndex }, perpState, spotState] = await Promise.all([
    resolveUniverseEntry(perpSymbol),
    getPerpState(walletAddress),
    getSpotState(walletAddress)
  ]);

  if (strategy.leverage > entry.maxLeverage) {
    throw new Error(`${perpSymbol} supports up to ${entry.maxLeverage}x leverage on Hyperliquid testnet.`);
  }

  const perpWithdrawable = parsePerpWithdrawable(perpState);
  const perpAccountValue = parsePerpAccountValue(perpState);
  const spotUsdcAvailable = parseSpotUsdcAvailable(spotState);
  const availableCapitalUsd = Math.max(perpWithdrawable + spotUsdcAvailable, perpAccountValue + spotUsdcAvailable);
  const marginAllocated = availableCapitalUsd * strategy.positionSizeRatio;

  if (!Number.isFinite(marginAllocated) || marginAllocated <= 0) {
    throw new Error('Hyperliquid testnet에서 사용 가능한 USDC 잔고가 없습니다.');
  }

  const targetNotional = marginAllocated * strategy.leverage;
  const quantityNumber = floorToDecimals(targetNotional / referencePrice, entry.szDecimals);
  if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) {
    throw new Error(`Calculated ${perpSymbol} order size is too small for Hyperliquid testnet.`);
  }

  const notionalUsd = quantityNumber * referencePrice;

  return {
    perpSymbol,
    assetIndex,
    leverageMode: entry.onlyIsolated ? 'isolated' as const : 'cross' as const,
    leverage: strategy.leverage,
    quantity: trimNumericString(quantityNumber, entry.szDecimals),
    quantityNumber,
    notionalUsd: roundToCents(notionalUsd),
    marginAllocated: roundToCents(notionalUsd / strategy.leverage),
    perpWithdrawable,
    spotUsdcAvailable,
    walletAddress,
    perpState
  };
}

async function transferBetweenSpotAndPerpIfNeeded(requiredMarginUsd: number, signer: TypedDataSigner, walletAddress: string) {
  const [perpState, spotState] = await Promise.all([getPerpState(walletAddress), getSpotState(walletAddress)]);
  const currentWithdrawable = parsePerpWithdrawable(perpState);
  if (currentWithdrawable >= requiredMarginUsd) {
    return;
  }

  const spotUsdcAvailable = parseSpotUsdcAvailable(spotState);
  const deficit = roundToCents(requiredMarginUsd - currentWithdrawable + DEFAULT_TRANSFER_BUFFER_USDC);
  if (spotUsdcAvailable < deficit) {
    throw new Error(`Not enough transferable USDC. Need ${deficit.toFixed(2)} USDC, found ${spotUsdcAvailable.toFixed(2)} USDC.`);
  }

  const nonce = Date.now();
  const action = {
    type: 'usdClassTransfer',
    hyperliquidChain: 'Testnet',
    signatureChainId: '0x66eee',
    amount: deficit.toString(),
    toPerp: true,
    nonce
  };
  const signature = await signUserAction(
    signer,
    action,
    [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' }
    ],
    'HyperliquidTransaction:UsdClassTransfer'
  );

  await postExchange({ action, nonce, signature });
}

async function updateLeverage(assetIndex: number, leverageMode: 'cross' | 'isolated', leverage: number, signer: TypedDataSigner) {
  const nonce = Date.now();
  const action = {
    type: 'updateLeverage',
    asset: assetIndex,
    isCross: leverageMode === 'cross',
    leverage
  };
  const signature = await signL1Action(signer, action, nonce);
  await postExchange({ action, nonce, signature });
}

async function lookupFilledOrder(orderResponse: OrderStatusResponse, perpSymbol: string, walletAddress: string) {
  const status = orderResponse.response?.data?.statuses?.[0];
  if (status?.filled) {
    return {
      orderId: String(status.filled.oid),
      filledPrice: Number(status.filled.avgPx),
      executedQuantity: status.filled.totalSz,
      status: Number(status.filled.totalSz) > 0 ? 'Filled' as const : 'Pending' as const
    };
  }

  if (status?.resting) {
    const fills = await getUserFillsByTime(walletAddress, Date.now() - 60_000, Date.now() + 5_000);
    const matched = [...fills].reverse().find((fill) => fill.oid === status.resting?.oid && fill.coin.toUpperCase() === perpSymbol.toUpperCase());
    return {
      orderId: String(status.resting.oid),
      filledPrice: matched ? Number(matched.px) : null,
      executedQuantity: matched?.sz ?? '0',
      status: matched ? 'Filled' as const : 'Pending' as const
    };
  }

  return {
    orderId: null,
    filledPrice: null,
    executedQuantity: '0',
    status: mapOrderStatus(orderResponse.status)
  };
}

export async function createDirectHyperliquidExecutionPreview(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number,
  settings: UserSettings,
  walletAddress: string
): Promise<ExecutionPlan> {
  const validation = validateStrategy(strategy, currentPrice, settings);
  const sizing = await buildSizing(strategy, marketSymbol, currentPrice, walletAddress);

  return {
    executionChain: 'hyperliquid-testnet',
    liquidityChain: 'hyperliquid-testnet',
    entryPrice: currentPrice,
    positionSize: sizing.notionalUsd,
    estimatedSlippage: DEFAULT_SLIPPAGE_ESTIMATE,
    estimatedFee: roundToCents(sizing.notionalUsd * DEFAULT_FEE_RATE),
    guardrailCheck: {
      passed: validation.isValid,
      violations: validation.violations
    }
  };
}

export async function executeDirectHyperliquidOrder(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number,
  input?: { entryType?: DirectOrderPlacementMode }
): Promise<DirectHyperliquidReceipt> {
  const signer = await getInjectedSigner();
  const walletAddress = (await signer.getAddress()).toLowerCase();
  const sizing = await buildSizing(strategy, marketSymbol, currentPrice, walletAddress);
  const entryType = input?.entryType ?? strategy.entryType;
  const isBuy = strategy.bias !== 'bearish';
  const entryPrice = removeTrailingZeros(getConfiguredLimitPrice(strategy.entryPrice, currentPrice));
  await transferBetweenSpotAndPerpIfNeeded(sizing.marginAllocated, signer, walletAddress);
  await updateLeverage(sizing.assetIndex, sizing.leverageMode, sizing.leverage, signer);

  const action = {
    type: 'order',
    orders: [
      {
        a: sizing.assetIndex,
        b: isBuy,
        p: entryType === 'market' ? removeTrailingZeros(getAggressiveLimitPrice(currentPrice, isBuy)) : entryPrice,
        s: removeTrailingZeros(sizing.quantity),
        r: false,
        t:
          entryType === 'conditional'
            ? orderTypeToWire({
                trigger: {
                  triggerPx: entryPrice,
                  isMarket: false,
                  tpsl: resolveTriggerType(isBuy, strategy.entryPrice, currentPrice)
                }
              })
            : orderTypeToWire({ limit: { tif: entryType === 'limit' ? 'Gtc' : 'Ioc' } })
      }
    ],
    grouping: 'na'
  };
  const nonce = Date.now();
  const signature = await signL1Action(signer, action, nonce);
  const orderResponse = await postExchange({ action, nonce, signature });
  const details = await lookupFilledOrder(orderResponse, sizing.perpSymbol, walletAddress);

  return {
    executionChain: 'hyperliquid-testnet',
    liquidityChain: 'hyperliquid-testnet',
    settlementMode: 'perp_dex',
    externalVenue: 'hyperliquid_testnet',
    externalOrderId: details.orderId,
    externalClientOrderId: null,
    leverageUsed: sizing.leverage,
    executedQuantity: details.executedQuantity,
    side: strategy.bias === 'bearish' ? 'SELL' : 'BUY',
    reduceOnly: false,
    status: details.status,
    filledPrice: details.filledPrice,
    filledAt: new Date().toISOString()
  };
}

export async function cancelDirectHyperliquidOrder(marketSymbol: string, externalOrderId: string | number) {
  const signer = await getInjectedSigner();
  const perpSymbol = toPerpSymbol(marketSymbol);
  const { assetIndex } = await resolveUniverseEntry(perpSymbol);
  const nonce = Date.now();
  const action = {
    type: 'cancel',
    cancels: [
      {
        a: assetIndex,
        o: typeof externalOrderId === 'number' ? externalOrderId : externalOrderId.trim()
      }
    ]
  };
  const signature = await signL1Action(signer, action, nonce);
  const response = await postExchange<{ response?: { data?: { statuses?: string[] } } }>({ action, nonce, signature });
  const status = response.response?.data?.statuses?.[0];
  if (typeof status === 'string' && status.toLowerCase() !== 'success') {
    throw new Error(`Hyperliquid cancel request returned ${status}.`);
  }
}

export async function closeDirectHyperliquidPosition(
  marketSymbol: string,
  currentPrice: number,
  input: { mode: 'market' | 'price'; closePrice?: number }
): Promise<DirectHyperliquidReceipt> {
  if (input.mode === 'price' && (!Number.isFinite(input.closePrice) || (input.closePrice ?? 0) <= 0)) {
    throw new Error('지정가 청산에는 유효한 가격이 필요합니다.');
  }

  const signer = await getInjectedSigner();
  const walletAddress = (await signer.getAddress()).toLowerCase();
  const perpSymbol = toPerpSymbol(marketSymbol);
  const [{ entry, assetIndex }, perpState] = await Promise.all([
    resolveUniverseEntry(perpSymbol),
    getPerpState(walletAddress)
  ]);
  const position = perpState.assetPositions.find((item) => item.position.coin.toUpperCase() === perpSymbol.toUpperCase());
  const size = Math.abs(Number(position?.position.szi ?? 0));

  if (!position || !size) {
    throw new Error(`No open ${perpSymbol} position was found on Hyperliquid testnet.`);
  }

  const isBuy = Number(position.position.szi) < 0;
  const quantity = trimNumericString(floorToDecimals(size, entry.szDecimals), entry.szDecimals);
  const limitPrice =
    input.mode === 'price'
      ? removeTrailingZeros(trimNumericString(input.closePrice ?? currentPrice, Math.max(2, entry.szDecimals + 2)))
      : removeTrailingZeros(getAggressiveLimitPrice(currentPrice, isBuy));
  const action = {
    type: 'order',
    orders: [
      {
        a: assetIndex,
        b: isBuy,
        p: limitPrice,
        s: removeTrailingZeros(quantity),
        r: true,
        t: orderTypeToWire({ limit: { tif: input.mode === 'price' ? 'Gtc' : 'Ioc' } })
      }
    ],
    grouping: 'na'
  };
  const nonce = Date.now();
  const signature = await signL1Action(signer, action, nonce);
  const orderResponse = await postExchange({ action, nonce, signature });
  const details = await lookupFilledOrder(orderResponse, perpSymbol, walletAddress);

  return {
    executionChain: 'hyperliquid-testnet',
    liquidityChain: 'hyperliquid-testnet',
    settlementMode: 'perp_dex',
    externalVenue: 'hyperliquid_testnet',
    externalOrderId: details.orderId,
    externalClientOrderId: null,
    leverageUsed: position.position.leverage.value,
    executedQuantity: details.executedQuantity || quantity,
    side: isBuy ? 'BUY' : 'SELL',
    reduceOnly: true,
    status: details.status,
    filledPrice: details.filledPrice,
    filledAt: new Date().toISOString()
  };
}
