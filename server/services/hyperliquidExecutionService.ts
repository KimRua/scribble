import { Wallet } from 'ethers';
import { BASE_URLS, Hyperliquid, type ClearinghouseState, type Meta, type OrderResponse, type SpotClearinghouseState } from 'hyperliquid';
import type { Execution, ExecutionPlan, Strategy, UserSettings } from '../../src/types/domain';
import { validateStrategy } from '../../src/utils/strategy';

const DEFAULT_FEE_RATE = 0.00045;
const DEFAULT_SLIPPAGE_ESTIMATE = 0.05;
const DEFAULT_TRANSFER_BUFFER_USDC = 0.5;
const SUPPORTED_QUOTES = ['USDT', 'USDC', 'USD'] as const;

export interface HyperliquidConfigStatus {
  enabled: boolean;
  ready: boolean;
  missing: string[];
  baseUrl: string;
  walletAddress: string | null;
}

export interface HyperliquidExecutionReceipt {
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

interface HyperliquidUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}

interface AccountSnapshot {
  perpState: ClearinghouseState;
  spotState: SpotClearinghouseState;
}

interface OrderSizingResult {
  marketSymbol: string;
  perpSymbol: string;
  quantity: string;
  quantityNumber: number;
  leverage: number;
  leverageMode: 'cross' | 'isolated';
  notionalUsd: number;
  marginAllocated: number;
  availableCapitalUsd: number;
  snapshot: AccountSnapshot;
}

let sdkCache: Hyperliquid | null = null;
let sdkCacheKey: string | null = null;
let metaCache: Meta | null = null;

function getPrivateKey() {
  return process.env.HYPERLIQUID_TESTNET_PRIVATE_KEY?.trim() || '';
}

function getConfiguredWalletAddress() {
  return process.env.HYPERLIQUID_TESTNET_WALLET_ADDRESS?.trim().toLowerCase() || '';
}

function isExecutionEnabled() {
  return (process.env.ENABLE_HYPERLIQUID_TESTNET_EXECUTION ?? 'false').toLowerCase() === 'true';
}

function isAutoTransferEnabled() {
  return (process.env.HYPERLIQUID_TESTNET_AUTO_TRANSFER ?? 'true').toLowerCase() !== 'false';
}

function getWalletAddress() {
  const configured = getConfiguredWalletAddress();
  if (configured) {
    return configured;
  }

  const privateKey = getPrivateKey();
  if (!privateKey) {
    return null;
  }

  try {
    return new Wallet(privateKey).address.toLowerCase();
  } catch {
    return null;
  }
}

function getSdk() {
  const privateKey = getPrivateKey();
  const walletAddress = getConfiguredWalletAddress() || undefined;
  const cacheKey = `${privateKey}:${walletAddress ?? ''}`;

  if (!sdkCache || sdkCacheKey !== cacheKey) {
    sdkCache = new Hyperliquid({
      privateKey,
      walletAddress,
      testnet: true,
      enableWs: false,
      disableAssetMapRefresh: true
    });
    sdkCacheKey = cacheKey;
    metaCache = null;
  }

  return sdkCache;
}

function trimNumericString(value: number, decimals: number) {
  return value
    .toFixed(decimals)
    .replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, '')
    .replace(/\.$/, '');
}

function roundToCents(value: number) {
  return Number(value.toFixed(2));
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

function parseSpotUsdcAvailable(spotState: SpotClearinghouseState) {
  const usdc = spotState.balances.find((balance) => balance.coin.toUpperCase() === 'USDC');
  if (!usdc) {
    return 0;
  }

  const total = Number(usdc.total);
  const hold = Number(usdc.hold);
  return Math.max(0, total - hold);
}

function parsePerpWithdrawable(perpState: ClearinghouseState) {
  return Math.max(0, Number(perpState.withdrawable || 0));
}

function parsePerpAccountValue(perpState: ClearinghouseState) {
  return Math.max(
    0,
    Number(perpState.crossMarginSummary?.accountValue ?? 0),
    Number(perpState.marginSummary?.accountValue ?? 0),
    Number(perpState.withdrawable ?? 0)
  );
}

async function getMeta() {
  if (!metaCache) {
    const sdk = getSdk();
    await sdk.ensureInitialized();
    metaCache = await sdk.info.perpetuals.getMeta();
  }

  return metaCache;
}

async function getUniverseEntry(perpSymbol: string): Promise<HyperliquidUniverseEntry> {
  const meta = await getMeta();
  const entry = meta.universe.find((item) => item.name.toUpperCase() === perpSymbol.toUpperCase());
  if (!entry) {
    throw new Error(`${perpSymbol} market is not available on Hyperliquid testnet.`);
  }

  return entry;
}

async function getAccountSnapshot() {
  const walletAddress = getWalletAddress();
  if (!walletAddress) {
    throw new Error('Unable to resolve the Hyperliquid wallet address from the configured private key.');
  }

  const sdk = getSdk();
  await sdk.ensureInitialized();

  const [perpState, spotState] = await Promise.all([
    sdk.info.perpetuals.getClearinghouseState(walletAddress),
    sdk.info.spot.getSpotClearinghouseState(walletAddress)
  ]);

  return {
    perpState,
    spotState
  } satisfies AccountSnapshot;
}

async function ensurePerpMargin(requiredMarginUsd: number, snapshot: AccountSnapshot) {
  const currentWithdrawable = parsePerpWithdrawable(snapshot.perpState);
  if (currentWithdrawable >= requiredMarginUsd || !isAutoTransferEnabled()) {
    return snapshot;
  }

  const spotUsdcAvailable = parseSpotUsdcAvailable(snapshot.spotState);
  const deficit = roundToCents(requiredMarginUsd - currentWithdrawable + DEFAULT_TRANSFER_BUFFER_USDC);
  if (spotUsdcAvailable < deficit) {
    throw new Error(`Not enough transferable USDC to fund the Hyperliquid perp account. Need ${deficit.toFixed(2)} USDC, found ${spotUsdcAvailable.toFixed(2)} USDC in spot.`);
  }

  const sdk = getSdk();
  await sdk.exchange.transferBetweenSpotAndPerp(deficit, true);
  return getAccountSnapshot();
}

async function resolveOrderSizing(strategy: Strategy, marketSymbol: string, referencePrice: number): Promise<OrderSizingResult> {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error('A valid market price is required to size the Hyperliquid order.');
  }

  const perpSymbol = toPerpSymbol(marketSymbol);
  const universe = await getUniverseEntry(perpSymbol);

  if (strategy.leverage > universe.maxLeverage) {
    throw new Error(`${perpSymbol} supports up to ${universe.maxLeverage}x leverage on Hyperliquid testnet.`);
  }

  const snapshot = await getAccountSnapshot();
  const perpWithdrawable = parsePerpWithdrawable(snapshot.perpState);
  const perpAccountValue = parsePerpAccountValue(snapshot.perpState);
  const spotUsdcAvailable = parseSpotUsdcAvailable(snapshot.spotState);
  const availableCapitalUsd = Math.max(perpWithdrawable + spotUsdcAvailable, perpAccountValue + spotUsdcAvailable);
  const marginAllocated = availableCapitalUsd * strategy.positionSizeRatio;

  if (!Number.isFinite(marginAllocated) || marginAllocated <= 0) {
    throw new Error('No usable USDC balance was found for Hyperliquid testnet trading.');
  }

  const targetNotional = marginAllocated * strategy.leverage;
  const quantityNumber = floorToDecimals(targetNotional / referencePrice, universe.szDecimals);
  if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) {
    throw new Error(`Calculated ${perpSymbol} order size is too small for Hyperliquid testnet.`);
  }

  const notionalUsd = quantityNumber * referencePrice;

  return {
    marketSymbol,
    perpSymbol,
    quantity: trimNumericString(quantityNumber, universe.szDecimals),
    quantityNumber,
    leverage: strategy.leverage,
    leverageMode: universe.onlyIsolated ? 'isolated' : 'cross',
    notionalUsd: roundToCents(notionalUsd),
    marginAllocated: roundToCents(notionalUsd / strategy.leverage),
    availableCapitalUsd: roundToCents(availableCapitalUsd),
    snapshot
  };
}

function getAggressiveLimitPrice(referencePrice: number, isBuy: boolean) {
  const raw = referencePrice * (isBuy ? 1 + DEFAULT_SLIPPAGE_ESTIMATE : 1 - DEFAULT_SLIPPAGE_ESTIMATE);
  const decimals = Math.max(0, (referencePrice.toString().split('.')[1]?.length ?? 0) - 1);
  return trimNumericString(raw, Math.max(2, decimals));
}

async function lookupFilledOrderDetails(orderResponse: OrderResponse, perpSymbol: string) {
  const order = orderResponse.response?.data?.statuses?.[0];
  const filled = order?.filled;
  const resting = order?.resting;

  if (filled) {
    return {
      orderId: String(filled.oid),
      filledPrice: Number(filled.avgPx),
      executedQuantity: filled.totalSz,
      status: Number(filled.totalSz) > 0 ? 'Filled' : 'Pending'
    } as const;
  }

  if (resting) {
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      return {
        orderId: String(resting.oid),
        filledPrice: null,
        executedQuantity: '0',
        status: 'Pending' as const
      };
    }

    const sdk = getSdk();
    const fills = await sdk.info.getUserFillsByTime(walletAddress, Date.now() - 60_000, Date.now() + 5_000);
    const matchedFill = [...fills]
      .reverse()
      .find((fill) => fill.oid === resting.oid && fill.coin.toUpperCase() === perpSymbol.toUpperCase());

    return {
      orderId: String(resting.oid),
      filledPrice: matchedFill ? Number(matchedFill.px) : null,
      executedQuantity: matchedFill?.sz ?? '0',
      status: matchedFill ? 'Filled' as const : 'Pending' as const
    };
  }

  throw new Error('Hyperliquid returned an empty order response.');
}

function buildFailedReceipt(strategy: Strategy): HyperliquidExecutionReceipt {
  const now = new Date().toISOString();
  return {
    enabled: isExecutionEnabled(),
    ready: false,
    executed: false,
    executionChain: 'hyperliquid-testnet',
    liquidityChain: 'hyperliquid-testnet',
    settlementMode: 'perp_dex',
    externalVenue: 'hyperliquid_testnet',
    externalOrderId: null,
    externalClientOrderId: null,
    leverageUsed: strategy.leverage,
    executedQuantity: '0',
    side: strategy.bias === 'bearish' ? 'SELL' : 'BUY',
    reduceOnly: false,
    status: 'Failed',
    filledPrice: null,
    filledAt: now
  };
}

export function getHyperliquidConfigStatus(): HyperliquidConfigStatus {
  const enabled = isExecutionEnabled();
  const privateKey = getPrivateKey();
  const missing = privateKey ? [] : ['HYPERLIQUID_TESTNET_PRIVATE_KEY'];

  return {
    enabled,
    ready: enabled && missing.length === 0,
    missing,
    baseUrl: BASE_URLS.TESTNET,
    walletAddress: getWalletAddress()
  };
}

export async function createHyperliquidExecutionPreview(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number,
  settings: UserSettings
): Promise<ExecutionPlan> {
  const validation = validateStrategy(strategy, currentPrice, settings);
  const sizing = await resolveOrderSizing(strategy, marketSymbol, currentPrice);

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

export async function executeHyperliquidOrder(
  strategy: Strategy,
  marketSymbol: string,
  currentPrice: number
): Promise<HyperliquidExecutionReceipt> {
  const status = getHyperliquidConfigStatus();
  if (!status.enabled || !status.ready) {
    return buildFailedReceipt(strategy);
  }

  const sizing = await resolveOrderSizing(strategy, marketSymbol, currentPrice);
  await ensurePerpMargin(sizing.marginAllocated, sizing.snapshot);

  const sdk = getSdk();
  const isBuy = strategy.bias !== 'bearish';
  await sdk.exchange.updateLeverage(sizing.perpSymbol, sizing.leverageMode, sizing.leverage);
  const orderResponse = (await sdk.exchange.placeOrder({
    coin: sizing.perpSymbol,
    is_buy: isBuy,
    sz: sizing.quantity,
    limit_px: getAggressiveLimitPrice(currentPrice, isBuy),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false
  })) as OrderResponse;

  const details = await lookupFilledOrderDetails(orderResponse, sizing.perpSymbol);
  const now = new Date().toISOString();

  return {
    enabled: true,
    ready: true,
    executed: details.status === 'Filled',
    executionChain: 'hyperliquid-testnet',
    liquidityChain: 'hyperliquid-testnet',
    settlementMode: 'perp_dex',
    externalVenue: 'hyperliquid_testnet',
    externalOrderId: details.orderId,
    externalClientOrderId: null,
    leverageUsed: sizing.leverage,
    executedQuantity: details.executedQuantity,
    side: isBuy ? 'BUY' : 'SELL',
    reduceOnly: false,
    status: details.status,
    filledPrice: details.filledPrice,
    filledAt: now
  };
}

export async function closeHyperliquidPosition(
  marketSymbol: string,
  currentPrice: number,
  input: { mode: 'market' | 'price'; close_price?: number }
): Promise<HyperliquidExecutionReceipt> {
  const status = getHyperliquidConfigStatus();
  if (!status.enabled || !status.ready) {
    return buildFailedReceipt({
      strategyId: '',
      annotationId: '',
      bias: 'neutral',
      entryType: 'market',
      entryPrice: currentPrice,
      stopLossPrice: currentPrice,
      takeProfitPrices: [currentPrice],
      invalidationCondition: '',
      confidence: 0,
      riskLevel: 'balanced',
      positionSizeRatio: 0,
      leverage: 1,
      autoExecuteEnabled: false
    });
  }

  if (input.mode !== 'market') {
    throw new Error('Hyperliquid close currently supports market close only.');
  }

  const walletAddress = getWalletAddress();
  if (!walletAddress) {
    throw new Error('Unable to resolve the Hyperliquid wallet address from the configured private key.');
  }

  const sdk = getSdk();
  const perpSymbol = toPerpSymbol(marketSymbol);
  const positions = await sdk.info.perpetuals.getClearinghouseState(walletAddress);
  const position = positions.assetPositions.find((item) => item.position.coin.toUpperCase() === perpSymbol.toUpperCase());

  if (!position || Math.abs(Number(position.position.szi)) === 0) {
    throw new Error(`No open ${perpSymbol} position was found on Hyperliquid testnet.`);
  }

  const size = Math.abs(Number(position.position.szi));
  const isBuy = Number(position.position.szi) < 0;
  const universe = await getUniverseEntry(perpSymbol);
  const quantity = trimNumericString(floorToDecimals(size, universe.szDecimals), universe.szDecimals);
  const orderResponse = (await sdk.exchange.placeOrder({
    coin: perpSymbol,
    is_buy: isBuy,
    sz: quantity,
    limit_px: getAggressiveLimitPrice(currentPrice, isBuy),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: true
  })) as OrderResponse;
  const details = await lookupFilledOrderDetails(orderResponse, perpSymbol);
  const now = new Date().toISOString();

  return {
    enabled: true,
    ready: true,
    executed: details.status === 'Filled',
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
    filledAt: now
  };
}
