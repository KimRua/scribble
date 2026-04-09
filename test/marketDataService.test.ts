import { describe, expect, it } from 'vitest';
import {
  fetchBinanceCandles,
  fetchBinanceMarkets,
  mapBinanceStreamPayloadToCandle,
  normalizeMarketDataTimeframe,
  upsertRealtimeCandle
} from '../server/services/marketDataService';

describe('market data service', () => {
  it('normalizes supported timeframes', () => {
    expect(normalizeMarketDataTimeframe('15m')).toBe('15m');
    expect(normalizeMarketDataTimeframe('4h')).toBe('4h');
    expect(normalizeMarketDataTimeframe('13m')).toBeNull();
  });

  it('maps binance klines into candle objects', async () => {
    const candles = await fetchBinanceCandles(
      'BTCUSDT',
      '1h',
      2,
      async () =>
        new Response(
          JSON.stringify([
            [1700000000000, '100', '110', '95', '105', '123.4', 1700003599999, '0', 1, '0', '0', '0'],
            [1700003600000, '105', '112', '101', '108', '156.7', 1700007199999, '0', 1, '0', '0', '0']
          ]),
          { status: 200 }
        )
    );

    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 123.4
    });
  });

  it('maps exchange info into supported market options', async () => {
    const markets = await fetchBinanceMarkets(async () =>
      new Response(
        JSON.stringify({
          symbols: [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'BREAK', isSpotTradingAllowed: true },
            { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true }
          ]
        }),
        { status: 200 }
      )
    );

    expect(markets).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'active' },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'halted' }
    ]);
  });

  it('maps websocket kline payload into a candle', () => {
    const candle = mapBinanceStreamPayloadToCandle({
      e: 'kline',
      E: 1700003600000,
      s: 'BTCUSDT',
      k: {
        t: 1700000000000,
        T: 1700003599999,
        s: 'BTCUSDT',
        i: '1h',
        o: '100',
        c: '107',
        h: '110',
        l: '95',
        v: '123.4',
        x: false
      }
    });

    expect(candle).toMatchObject({
      open: 100,
      high: 110,
      low: 95,
      close: 107,
      volume: 123.4
    });
  });

  it('upserts a realtime candle into the latest slot', () => {
    const candles = [
      { openTime: '2023-11-14T22:13:20.000Z', open: 100, high: 105, low: 99, close: 103, volume: 10 },
      { openTime: '2023-11-14T23:13:20.000Z', open: 103, high: 108, low: 101, close: 104, volume: 11 }
    ];

    const updated = upsertRealtimeCandle(candles, {
      openTime: '2023-11-14T23:13:20.000Z',
      open: 103,
      high: 109,
      low: 101,
      close: 107,
      volume: 15
    });

    expect(updated).toHaveLength(2);
    expect(updated[1]).toMatchObject({ high: 109, close: 107, volume: 15 });
  });
});
