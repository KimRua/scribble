import { describe, expect, it } from 'vitest';
import { normalizeLlmStrategyShape } from '../server/services/llmService';

describe('llm strategy normalization', () => {
  it('normalizes long/short aliases into canonical enums', () => {
    const strategy = normalizeLlmStrategyShape({
      bias: 'long',
      entry_type: 'buy_limit',
      entry_price: 100,
      stop_loss_price: 95,
      take_profit_prices: [110, 115],
      invalidation_condition: 'close below 95',
      confidence: 0.8,
      risk_level: 'medium',
      position_size_ratio: 0.2,
      leverage: 3,
      auto_execute_enabled: false
    });

    expect(strategy.bias).toBe('bullish');
    expect(strategy.entryType).toBe('limit');
    expect(strategy.riskLevel).toBe('balanced');
  });

  it('falls back safely on unknown values', () => {
    const strategy = normalizeLlmStrategyShape({
      bias: 'sideways',
      entry_type: 'weird',
      entry_price: 100,
      stop_loss_price: 99,
      take_profit_prices: [],
      invalidation_condition: '',
      confidence: 2,
      risk_level: 'extreme',
      position_size_ratio: 2,
      leverage: 0,
      auto_execute_enabled: false
    });

    expect(strategy.bias).toBe('neutral');
    expect(strategy.entryType).toBe('conditional');
    expect(strategy.riskLevel).toBe('balanced');
    expect(strategy.confidence).toBeLessThanOrEqual(1);
    expect(strategy.positionSizeRatio).toBe(1);
    expect(strategy.leverage).toBe(1);
  });
});
