import type { Annotation, Candle, MarketOption, Strategy, UserSettings } from '../types/domain';

const now = Date.now();

export const marketOptions: MarketOption[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'active' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'active' },
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT', status: 'active' }
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

export function buildSeedAnnotations(symbol: string, timeframe: string, candles: Candle[]): Annotation[] {
  const anchorIndex = candles.length - 8;
  const anchorCandle = candles[anchorIndex];
  const annotationId = 'ann_seed_ai';
  const strategy = buildSeedStrategy(annotationId, Number(anchorCandle.close.toFixed(2)));

  return [
    {
      annotationId,
      authorType: 'ai',
      authorId: 'system',
      marketSymbol: symbol,
      timeframe,
      text: `${strategy.entryPrice} 지지 재테스트 시 단기 롱 진입 가능. ${strategy.stopLossPrice} 이탈 시 시나리오 무효.`,
      chartAnchor: {
        time: anchorCandle.openTime,
        price: strategy.entryPrice,
        index: anchorIndex
      },
      drawingObjects: [
        { id: 'draw_entry_seed', type: 'line', role: 'entry', price: strategy.entryPrice },
        { id: 'draw_sl_seed', type: 'line', role: 'stop_loss', price: strategy.stopLossPrice },
        { id: 'draw_tp_seed_1', type: 'line', role: 'take_profit', price: strategy.takeProfitPrices[0] },
        { id: 'draw_zone_seed', type: 'box', role: 'zone', priceFrom: strategy.stopLossPrice, priceTo: strategy.entryPrice }
      ],
      strategy,
      status: 'Active',
      visibility: 'private',
      createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 10 * 60 * 1000).toISOString()
    }
  ];
}
