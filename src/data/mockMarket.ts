import type { Annotation, Candle, MarketOption, Strategy, UserSettings } from '../types/domain';

const now = Date.now();

export const marketOptions: MarketOption[] = [
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT', status: 'active' },
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'active' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'active' }
];

export const defaultUserSettings: UserSettings = {
  riskLevel: 'balanced',
  defaultPositionSize: 0.1,
  leverage: 2,
  maxLeverage: 5,
  accountBalance: 10000
};

export function generateCandles(symbol: string, timeframe: string, length = 40): Candle[] {
  const seed = symbol === 'ETHUSDT' ? 3100 : symbol === 'BNBUSDT' ? 580 : 82000;
  const step = timeframe === '4h' ? 4 : timeframe === '15m' ? 0.5 : 1;

  return Array.from({ length }, (_, index) => {
    const drift = Math.sin(index / 5) * seed * 0.004;
    const trend = index * seed * 0.0008 * step;
    const close = seed + drift + trend;
    const open = close - Math.cos(index / 3) * seed * 0.0018;
    const high = Math.max(open, close) + seed * 0.002;
    const low = Math.min(open, close) - seed * 0.002;

    return {
      openTime: new Date(now - (length - index) * 60 * 60 * 1000).toISOString(),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Number((10 + Math.random() * 20).toFixed(2))
    };
  });
}

export function buildSeedStrategy(annotationId: string, entryPrice: number): Strategy {
  return {
    strategyId: `str_${annotationId}`,
    annotationId,
    bias: 'bullish',
    entryType: 'conditional',
    entryPrice,
    stopLossPrice: Number((entryPrice * 0.994).toFixed(2)),
    takeProfitPrices: [Number((entryPrice * 1.008).toFixed(2)), Number((entryPrice * 1.015).toFixed(2))],
    invalidationCondition: `price closes below ${Number((entryPrice * 0.994).toFixed(2))}`,
    confidence: 0.72,
    riskLevel: 'balanced',
    positionSizeRatio: 0.1,
    leverage: 2,
    autoExecuteEnabled: false
  };
}

export function buildSeedAnnotations(symbol: string, timeframe: string, candles: Candle[], ownerKey?: string | null): Annotation[] {
  const anchorIndex = candles.length - 8;
  const anchorCandle = candles[anchorIndex];
  const scopeSuffix = (ownerKey ?? 'guest').replace(/[^a-zA-Z0-9]+/g, '_').slice(-24);
  const annotationId = `ann_seed_ai_${symbol}_${timeframe.replace(/[^a-zA-Z0-9]+/g, '_')}_${scopeSuffix}`;
  const strategy = buildSeedStrategy(annotationId, Number(anchorCandle.close.toFixed(2)));

  return [
    {
      annotationId,
      authorType: 'ai',
      authorId: 'system',
      ownerKey: ownerKey ?? null,
      marketSymbol: symbol,
      timeframe,
      text: `A short-term long setup looks valid on a support retest near ${strategy.entryPrice}. The idea is invalidated below ${strategy.stopLossPrice}.`,
      chartAnchor: {
        time: anchorCandle.openTime,
        price: strategy.entryPrice,
        index: anchorIndex
      },
      drawingObjects: [
        { id: `${annotationId}_entry`, type: 'line', role: 'entry', price: strategy.entryPrice },
        { id: `${annotationId}_sl`, type: 'line', role: 'stop_loss', price: strategy.stopLossPrice },
        { id: `${annotationId}_tp_1`, type: 'line', role: 'take_profit', price: strategy.takeProfitPrices[0] },
        { id: `${annotationId}_zone`, type: 'box', role: 'zone', priceFrom: strategy.stopLossPrice, priceTo: strategy.entryPrice }
      ],
      strategy,
      status: 'Active',
      visibility: 'private',
      createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 10 * 60 * 1000).toISOString()
    }
  ];
}
