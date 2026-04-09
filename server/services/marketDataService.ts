import { generateCandles, marketOptions as fallbackMarketOptions } from '../../src/data/mockMarket';
import type { Candle, MarketOption } from '../../src/types/domain';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_BINANCE_BASE_URL = 'https://api.binance.com';
const DEFAULT_BINANCE_WS_BASE_URL = 'wss://stream.binance.com:9443/ws';
const DEFAULT_CANDLE_LIMIT = 120;
const CANDLE_CACHE_TTL_MS = 15_000;
const MARKET_CACHE_TTL_MS = 5 * 60_000;
const WS_STALE_MS = 45_000;
const WS_RECONNECT_DELAY_MS = 3_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type CandleCacheEntry = CacheEntry<Candle[]> & {
  source: MarketDataSource;
  updatedAt: number;
};

type FetchLike = typeof fetch;

type FeedConnection = {
  socket: WebSocket;
  reconnectTimer: NodeJS.Timeout | null;
  lastMessageAt: number;
  source: MarketDataSource;
};

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

type BinanceStreamPayload = {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean;
  };
};

export type MarketDataSource = 'binance' | 'mock';

const candleCache = new Map<string, CandleCacheEntry>();
const feedConnections = new Map<string, FeedConnection>();
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

function getCacheKey(symbol: string, timeframe: string) {
  return `${symbol}:${timeframe}`;
}

function getBinanceBaseUrl() {
  return process.env.MARKET_DATA_BASE_URL ?? DEFAULT_BINANCE_BASE_URL;
}

function getBinanceWsBaseUrl() {
  return process.env.MARKET_DATA_WS_BASE_URL ?? DEFAULT_BINANCE_WS_BASE_URL;
}

function getBinanceStreamName(symbol: string, timeframe: string) {
  return `${symbol.toLowerCase()}@kline_${timeframe}`;
}

function setCandleCache(cacheKey: string, candles: Candle[], source: MarketDataSource, ttlMs = CANDLE_CACHE_TTL_MS) {
  const now = Date.now();
  candleCache.set(cacheKey, {
    value: candles,
    source,
    updatedAt: now,
    expiresAt: now + ttlMs
  });
}

function getCachedCandles(cacheKey: string, allowStale = false) {
  const cached = candleCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (!allowStale && cached.expiresAt <= Date.now()) {
    return null;
  }

  return cached;
}

function hasFreshRealtimeFeed(cacheKey: string) {
  const feed = feedConnections.get(cacheKey);
  return Boolean(feed && Date.now() - feed.lastMessageAt < WS_STALE_MS);
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

function mapBinanceKlinesToCandles(entries: BinanceKline[]) {
  return entries.map<Candle>((entry) => ({
    openTime: new Date(entry[0]).toISOString(),
    open: Number(entry[1]),
    high: Number(entry[2]),
    low: Number(entry[3]),
    close: Number(entry[4]),
    volume: Number(entry[5])
  }));
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

  return mapBinanceKlinesToCandles(payload);
}

export function mapBinanceStreamPayloadToCandle(payload: BinanceStreamPayload): Candle {
  return {
    openTime: new Date(payload.k.t).toISOString(),
    open: Number(payload.k.o),
    high: Number(payload.k.h),
    low: Number(payload.k.l),
    close: Number(payload.k.c),
    volume: Number(payload.k.v)
  };
}

export function upsertRealtimeCandle(candles: Candle[], nextCandle: Candle, maxLength = DEFAULT_CANDLE_LIMIT) {
  const next = [...candles];
  const last = next.at(-1);

  if (last?.openTime === nextCandle.openTime) {
    next[next.length - 1] = nextCandle;
    return next;
  }

  if (last && last.openTime > nextCandle.openTime) {
    return next;
  }

  next.push(nextCandle);
  return next.slice(-maxLength);
}

function scheduleReconnect(symbol: string, timeframe: string) {
  const cacheKey = getCacheKey(symbol, timeframe);
  const current = feedConnections.get(cacheKey);
  if (!current || current.reconnectTimer) {
    return;
  }

  current.reconnectTimer = setTimeout(() => {
    const latest = feedConnections.get(cacheKey);
    if (latest) {
      latest.reconnectTimer = null;
    }
    ensureRealtimeMarketFeed(symbol, timeframe);
  }, WS_RECONNECT_DELAY_MS);
}

function handleStreamPayload(symbol: string, timeframe: string, payload: BinanceStreamPayload) {
  const cacheKey = getCacheKey(symbol, timeframe);
  const currentCandles = getCachedCandles(cacheKey, true)?.value ?? [];
  const nextCandle = mapBinanceStreamPayloadToCandle(payload);
  const nextCandles = upsertRealtimeCandle(currentCandles, nextCandle);
  setCandleCache(cacheKey, nextCandles, 'binance', WS_STALE_MS);

  const feed = feedConnections.get(cacheKey);
  if (feed) {
    feed.lastMessageAt = Date.now();
    feed.source = 'binance';
  }
}

export function ensureRealtimeMarketFeed(symbol: string, timeframe: string) {
  if (!isRealMarketDataEnabled()) {
    return;
  }

  const interval = normalizeMarketDataTimeframe(timeframe);
  if (!interval) {
    return;
  }

  const cacheKey = getCacheKey(symbol, timeframe);
  const existing = feedConnections.get(cacheKey);
  if (existing && (existing.socket.readyState === WebSocket.OPEN || existing.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const socket = new WebSocket(`${getBinanceWsBaseUrl()}/${getBinanceStreamName(symbol, interval)}`);
  const connection: FeedConnection = {
    socket,
    reconnectTimer: null,
    lastMessageAt: 0,
    source: 'mock'
  };

  feedConnections.set(cacheKey, connection);

  socket.on('message', (raw: RawData) => {
    try {
      const payload = JSON.parse(raw.toString()) as BinanceStreamPayload;
      if (payload.e === 'kline') {
        handleStreamPayload(symbol, timeframe, payload);
      }
    } catch {
      return;
    }
  });

  socket.on('error', () => {
    try {
      socket.close();
    } catch {
      return;
    }
  });

  socket.on('close', () => {
    const current = feedConnections.get(cacheKey);
    if (!current || current.socket !== socket) {
      return;
    }
    scheduleReconnect(symbol, timeframe);
  });
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
  const cacheKey = getCacheKey(symbol, timeframe);
  const now = Date.now();
  const cached = getCachedCandles(cacheKey);

  if (!isRealMarketDataEnabled()) {
    const candles = generateCandles(symbol, timeframe);
    setCandleCache(cacheKey, candles, 'mock');
    return { candles, source: 'mock' };
  }

  ensureRealtimeMarketFeed(symbol, timeframe);

  if (cached && (cached.expiresAt > now || hasFreshRealtimeFeed(cacheKey))) {
    return { candles: cached.value, source: cached.source };
  }

  try {
    const candles = await fetchBinanceCandles(symbol, timeframe);
    setCandleCache(cacheKey, candles, 'binance');
    return { candles, source: 'binance' };
  } catch {
    const candles = generateCandles(symbol, timeframe);
    setCandleCache(cacheKey, candles, 'mock');
    return { candles, source: 'mock' };
  }
}

export async function getMarketSnapshot(symbol: string, timeframe: string): Promise<{ candles: Candle[]; source: MarketDataSource }> {
  const cacheKey = getCacheKey(symbol, timeframe);
  if (isRealMarketDataEnabled()) {
    ensureRealtimeMarketFeed(symbol, timeframe);
    const cached = getCachedCandles(cacheKey, true);
    if (cached && (hasFreshRealtimeFeed(cacheKey) || Date.now() - cached.updatedAt < WS_STALE_MS)) {
      return { candles: cached.value, source: cached.source };
    }
  }

  return getMarketCandles(symbol, timeframe);
}
