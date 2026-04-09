import { describe, expect, it } from 'vitest';
import { parseAnnotationText } from '../src/services/parserService';
import { calculateRiskSummary, determineAnnotationStatus, validateStrategy } from '../src/utils/strategy';
import { buildSeedStrategy, defaultUserSettings } from '../src/data/mockMarket';

describe('strategy helpers', () => {
  it('parses annotation text into a bullish strategy', () => {
    const result = parseAnnotationText('82000 지지 재테스트 시 롱, 81500 이탈 시 손절, 83200 목표', {
      currentPrice: 82120,
      visibleLevels: [82000, 81500, 83200],
      annotationId: 'ann_test'
    });

    expect(result.strategy.bias).toBe('bullish');
    expect(result.strategy.entryPrice).toBe(82000);
    expect(result.strategy.stopLossPrice).toBe(81500);
    expect(result.strategy.takeProfitPrices[0]).toBe(83200);
  });

  it('validates a seed strategy without violations', () => {
    const strategy = buildSeedStrategy('ann_seed', 82000);
    const validation = validateStrategy(strategy, 82100, defaultUserSettings);

    expect(validation.isValid).toBe(true);
    expect(validation.violations).toHaveLength(0);
    expect(validation.riskSummary.riskRewardRatio).toBeGreaterThan(1);
  });

  it('marks annotation as triggered when entry is reached', () => {
    const strategy = buildSeedStrategy('ann_seed', 82000);
    const status = determineAnnotationStatus(
      {
        annotationId: 'ann_seed',
        authorType: 'ai',
        authorId: 'system',
        marketSymbol: 'BTCUSDT',
        timeframe: '1h',
        text: '',
        chartAnchor: { time: new Date().toISOString(), price: 82000, index: 0 },
        drawingObjects: [],
        strategy,
        status: 'Active',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      82100
    );

    expect(status).toBe('Triggered');
  });

  it('calculates bounded risk summary', () => {
    const strategy = buildSeedStrategy('ann_seed', 82000);
    const risk = calculateRiskSummary(strategy, 82000, defaultUserSettings);

    expect(risk.maxLossAmount).toBeGreaterThan(0);
    expect(risk.maxLossRatio).toBeLessThan(0.05);
  });
});
