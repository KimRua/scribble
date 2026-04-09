import { generateCandles, marketOptions as fallbackMarketOptions } from '../../src/data/mockMarket';
import type { Candle, MarketOption } from '../../src/types/domain';

const DEFAULT_BINANCE_BASE_URL = 'https://api.binance.com';
const DEFAULT_CANDLE_LIMIT = 120;
const CANDLE_CACHE_TTL_MS = 15_000;
const MARKET_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type FetchLike = typeof fetch;

type BinanceExchangeInfo = {
  symbols?: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    isSpotTradingAllowed?: boolean;
  }>;
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

export type MarketDataSource = 'binance' | 'mock';

const candleCache = new Map<string, CacheEntry<Candle[]>>();
let marketCache: CacheEntry<MarketOption[]> | null = null;

export function isRealMarketDataEnabled() {
  const enabledFlag = (process.env.ENABLE_REAL_MARKET_DATA ?? 'true').toLowerCase();
  const provider = (process.env.MARKET_DATA_PROVIDER ?? 'binance').toLowerCase();
  return enabledFlag !== 'false' && provider === 'binance';
}

export function normalizeMarketDataTimeframe(timeframe: string) {
  const supported = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
  return supported.has(timeframe) ? timeframe : null;
}

function getBinanceBaseUrl() {
  return process.env.MARKET_DATA_BASE_URL ?? DEFAULT_BINANCE_BASE_URL;
}

async function fetchJson<T>(url: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`market data request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchBinanceMarkets(fetchImpl: FetchLike = fetch) {
  const exchangeInfo = await fetchJson<BinanceExchangeInfo>(`${getBinanceBaseUrl()}/api/v3/exchangeInfo`, fetchImpl);
  const preferredSymbols = new Set(fallbackMarketOptions.map((market) => market.symbol));

  const markets = (exchangeInfo.symbols ?? [])
    .filter((symbol) => preferredSymbols.has(symbol.symbol))
    .filter((symbol) => symbol.quoteAsset === 'USDT' && symbol.isSpotTradingAllowed !== false)
    .map<MarketOption>((symbol) => ({
      symbol: symbol.symbol,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
      status: symbol.status === 'TRADING' ? 'active' : 'halted'
    }));

  if (markets.length === 0) {
    throw new Error('no supported markets returned from provider');
  }

  return markets;
}

export async function fetchBinanceCandles(
  symbol: string,
  timeframe: string,
  limit = DEFAULT_CANDLE_LIMIT,
  fetchImpl: FetchLike = fetch
) {
  const interval = normalizeMarketDataTimeframe(timeframe);
  if (!interval) {
    throw new Error(`unsupported timeframe: ${timeframe}`);
  }

  const payload = await fetchJson<BinanceKline[]>(
    `${getBinanceBaseUrl()}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
    fetchImpl
  );

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('empty candle response');
  }

  return payload.map<Candle>((entry) => ({
    openTime: new Date(entry[0]).toISOString(),
    open: Number(entry[1]),
    high: Number(entry[2]),
    low: Number(entry[3]),
    close: Number(entry[4]),
    volume: Number(entry[5])
  }));
}

export async function getAvailableMarkets(): Promise<{ markets: MarketOption[]; source: MarketDataSource }> {
  const now = Date.now();
  if (marketCache && marketCache.expiresAt > now) {
    return { markets: marketCache.value, source: isRealMarketDataEnabled() ? 'binance' : 'mock' };
  }

  if (!isRealMarketDataEnabled()) {
    return { markets: fallbackMarketOptions, source: 'mock' };
  }

  try {
    const markets = await fetchBinanceMarkets();
    marketCache = {
      value: markets,
      expiresAt: now + MARKET_CACHE_TTL_MS
    };
    return { markets, source: 'binance' };
  } catch {
    return { markets: fallbackMarketOptions, source: 'mock' };
  }
}

export async function getMarketCandles(symbol: string, timeframe: string): Promise<{ candles: Candle[]; source: MarketDataSource }> {
  const cacheKey = `${symbol}:${timeframe}`;
  const now = Date.now();
  const cached = candleCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return { candles: cached.value, source: isRealMarketDataEnabled() ? 'binance' : 'mock' };
  }

  if (!isRealMarketDataEnabled()) {
    return { candles: generateCandles(symbol, timeframe), source: 'mock' };
  }

  try {
    const candles = await fetchBinanceCandles(symbol, timeframe);
    candleCache.set(cacheKey, {
      value: candles,
      expiresAt: now + CANDLE_CACHE_TTL_MS
    });
    return { candles, source: 'binance' };
  } catch {
    const candles = generateCandles(symbol, timeframe);
    candleCache.set(cacheKey, {
      value: candles,
      expiresAt: now + CANDLE_CACHE_TTL_MS
    });
    return { candles, source: 'mock' };
  }
}
