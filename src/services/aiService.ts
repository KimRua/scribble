import type { Annotation, Candle, Strategy, UserSettings } from '../types/domain';

export function generateAiAnnotation(params: {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  settings: UserSettings;
}): Annotation {
  const { symbol, timeframe, candles, settings } = params;
  const pivotIndex = candles.length - 6;
  const pivot = candles[pivotIndex];
  const entryPrice = Number(pivot.close.toFixed(2));
  const stopLossPrice = Number((entryPrice * 0.9935).toFixed(2));
  const takeProfitOne = Number((entryPrice * 1.008).toFixed(2));
  const takeProfitTwo = Number((entryPrice * 1.013).toFixed(2));
  const annotationId = `ann_ai_${Date.now()}`;

  const strategy: Strategy = {
    strategyId: `str_${annotationId}`,
    annotationId,
    bias: 'bullish',
    entryType: 'conditional',
    entryPrice,
    stopLossPrice,
    takeProfitPrices: [takeProfitOne, takeProfitTwo],
    invalidationCondition: `price closes below ${stopLossPrice}`,
    confidence: 0.74,
    riskLevel: settings.riskLevel,
    positionSizeRatio: settings.defaultPositionSize,
    leverage: settings.leverage,
    autoExecuteEnabled: false
  };

  return {
    annotationId,
    authorType: 'ai',
    authorId: 'system',
    marketSymbol: symbol,
    timeframe,
    text: `Maintain a bullish bias on a retest near ${entryPrice}. Invalidate the setup on a close below ${stopLossPrice}, then scale out around ${takeProfitOne} and ${takeProfitTwo}.`,
    chartAnchor: {
      time: pivot.openTime,
      price: entryPrice,
      index: pivotIndex
    },
    drawingObjects: [
      { id: `${annotationId}_entry`, type: 'line', role: 'entry', price: entryPrice },
      { id: `${annotationId}_sl`, type: 'line', role: 'stop_loss', price: stopLossPrice },
      { id: `${annotationId}_tp1`, type: 'line', role: 'take_profit', price: takeProfitOne },
      { id: `${annotationId}_tp2`, type: 'line', role: 'take_profit', price: takeProfitTwo },
      { id: `${annotationId}_zone`, type: 'box', role: 'zone', priceFrom: stopLossPrice, priceTo: entryPrice }
    ],
    strategy,
    status: 'Draft',
    visibility: 'private',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
