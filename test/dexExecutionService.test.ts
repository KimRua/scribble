import { describe, expect, it } from 'vitest';
import { getDexExecutionConfigStatus, parseDexMarketMap, resolveDexSwapPlan } from '../server/services/dexExecutionService';

describe('dex execution service', () => {
  it('reports missing env values when dex execution is enabled', () => {
    const previous = {
      ENABLE_DEX_EXECUTION: process.env.ENABLE_DEX_EXECUTION,
      BSC_RPC_URL: process.env.BSC_RPC_URL,
      EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
      DEX_ROUTER_ADDRESS: process.env.DEX_ROUTER_ADDRESS,
      DEX_MARKET_MAP_JSON: process.env.DEX_MARKET_MAP_JSON
    };

    process.env.ENABLE_DEX_EXECUTION = 'true';
    delete process.env.BSC_RPC_URL;
    delete process.env.EXECUTOR_PRIVATE_KEY;
    delete process.env.DEX_ROUTER_ADDRESS;
    delete process.env.DEX_MARKET_MAP_JSON;

    const status = getDexExecutionConfigStatus();

    expect(status.enabled).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(
      expect.arrayContaining(['BSC_RPC_URL', 'EXECUTOR_PRIVATE_KEY', 'DEX_ROUTER_ADDRESS', 'DEX_MARKET_MAP_JSON'])
    );

    process.env.ENABLE_DEX_EXECUTION = previous.ENABLE_DEX_EXECUTION;
    process.env.BSC_RPC_URL = previous.BSC_RPC_URL;
    process.env.EXECUTOR_PRIVATE_KEY = previous.EXECUTOR_PRIVATE_KEY;
    process.env.DEX_ROUTER_ADDRESS = previous.DEX_ROUTER_ADDRESS;
    process.env.DEX_MARKET_MAP_JSON = previous.DEX_MARKET_MAP_JSON;
  });

  it('parses market config and builds a bullish swap plan', () => {
    const marketMap = parseDexMarketMap(
      JSON.stringify({
        BTCUSDT: {
          baseTokenAddress: '0x00000000000000000000000000000000000000b1',
          quoteTokenAddress: '0x00000000000000000000000000000000000000c1',
          baseTokenDecimals: 18,
          quoteTokenDecimals: 18,
          buyAmount: '10',
          buyPath: [
            '0x00000000000000000000000000000000000000c1',
            '0x00000000000000000000000000000000000000d1',
            '0x00000000000000000000000000000000000000b1'
          ]
        }
      })
    );

    const plan = resolveDexSwapPlan(
      {
        strategyId: 'str_demo',
        annotationId: 'ann_demo',
        bias: 'bullish',
        entryType: 'limit',
        entryPrice: 100,
        stopLossPrice: 90,
        takeProfitPrices: [110],
        invalidationCondition: 'none',
        confidence: 0.8,
        riskLevel: 'balanced',
        positionSizeRatio: 0.1,
        leverage: 1,
        autoExecuteEnabled: false
      },
      'BTCUSDT',
      marketMap
    );

    expect(plan.side).toBe('buy');
    expect(plan.path).toHaveLength(3);
    expect(plan.amountInDisplay).toBe('10');
  });

  it('uses base token as input for bearish swaps', () => {
    const marketMap = parseDexMarketMap(
      JSON.stringify({
        BTCUSDT: {
          baseTokenAddress: '0x00000000000000000000000000000000000000b1',
          quoteTokenAddress: '0x00000000000000000000000000000000000000c1',
          baseTokenDecimals: 8,
          quoteTokenDecimals: 18,
          buyAmount: '10',
          sellAmount: '0.001'
        }
      })
    );

    const plan = resolveDexSwapPlan(
      {
        strategyId: 'str_demo',
        annotationId: 'ann_demo',
        bias: 'bearish',
        entryType: 'limit',
        entryPrice: 100,
        stopLossPrice: 90,
        takeProfitPrices: [110],
        invalidationCondition: 'none',
        confidence: 0.8,
        riskLevel: 'balanced',
        positionSizeRatio: 0.1,
        leverage: 1,
        autoExecuteEnabled: false
      },
      'BTCUSDT',
      marketMap
    );

    expect(plan.side).toBe('sell');
    expect(plan.inputTokenAddress).toBe('0x00000000000000000000000000000000000000B1');
    expect(plan.outputTokenAddress).toBe('0x00000000000000000000000000000000000000C1');
    expect(plan.amountInDisplay).toBe('0.001');
  });
});