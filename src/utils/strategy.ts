import type {
  Annotation,
  AnnotationStatus,
  RiskSummary,
  Strategy,
  StrategyValidation,
  UserSettings
} from '../types/domain';

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function calculateRiskSummary(strategy: Strategy, currentPrice: number, settings: UserSettings): RiskSummary {
  const positionValue = settings.accountBalance * strategy.positionSizeRatio * strategy.leverage;
  const stopDistance = Math.abs(strategy.entryPrice - strategy.stopLossPrice);
  const takeProfit = strategy.takeProfitPrices[0] ?? strategy.entryPrice;
  const rewardDistance = Math.abs(takeProfit - strategy.entryPrice);
  const maxLossAmount = stopDistance === 0 ? 0 : (positionValue * stopDistance) / strategy.entryPrice;
  const maxLossRatio = settings.accountBalance === 0 ? 0 : maxLossAmount / settings.accountBalance;
  const riskRewardRatio = stopDistance === 0 ? 0 : rewardDistance / stopDistance;
  const liquidationBuffer = Math.abs(currentPrice - strategy.stopLossPrice) / currentPrice;
  const liquidationRisk = liquidationBuffer > 0.03 ? 'low' : liquidationBuffer > 0.015 ? 'medium' : 'high';

  return {
    maxLossRatio: round(maxLossRatio),
    maxLossAmount: round(maxLossAmount, 2),
    riskRewardRatio: round(riskRewardRatio, 2),
    liquidationRisk
  };
}

export function validateStrategy(strategy: Strategy, currentPrice: number, settings: UserSettings): StrategyValidation {
  const violations: string[] = [];
  const isBullish = strategy.bias === 'bullish';
  const isBearish = strategy.bias === 'bearish';

  if (strategy.positionSizeRatio <= 0 || strategy.positionSizeRatio > 1) {
    violations.push('Position size ratio must be greater than 0 and less than or equal to 1.');
  }

  if (strategy.leverage > settings.maxLeverage) {
    violations.push(`Leverage cannot exceed ${settings.maxLeverage}x.`);
  }

  if (strategy.takeProfitPrices.length === 0) {
    violations.push('At least one take-profit target is required.');
  }

  if (!strategy.invalidationCondition.trim()) {
    violations.push('An invalidation condition is required.');
  }

  if (isBullish && strategy.stopLossPrice >= strategy.entryPrice) {
    violations.push('For bullish setups, the stop loss must be below the entry price.');
  }

  if (isBearish && strategy.stopLossPrice <= strategy.entryPrice) {
    violations.push('For bearish setups, the stop loss must be above the entry price.');
  }

  if (isBullish && strategy.takeProfitPrices.some((price) => price <= strategy.entryPrice)) {
    violations.push('For bullish setups, take-profit targets must be above the entry price.');
  }

  if (isBearish && strategy.takeProfitPrices.some((price) => price >= strategy.entryPrice)) {
    violations.push('For bearish setups, take-profit targets must be below the entry price.');
  }

  const riskSummary = calculateRiskSummary(strategy, currentPrice, settings);
  if (riskSummary.maxLossRatio > 0.05) {
    violations.push('Estimated max loss exceeds 5% of the account balance.');
  }

  return {
    isValid: violations.length === 0,
    violations,
    riskSummary
  };
}

export function determineAnnotationStatus(annotation: Annotation, currentPrice: number): AnnotationStatus {
  const { strategy, status } = annotation;
  if (status === 'Executed' || status === 'Closed' || status === 'Archived') {
    return status;
  }

  const bullishTriggered = strategy.bias === 'bullish' && currentPrice >= strategy.entryPrice;
  const bearishTriggered = strategy.bias === 'bearish' && currentPrice <= strategy.entryPrice;
  const invalidatedBullish = strategy.bias === 'bullish' && currentPrice <= strategy.stopLossPrice;
  const invalidatedBearish = strategy.bias === 'bearish' && currentPrice >= strategy.stopLossPrice;

  if (invalidatedBullish || invalidatedBearish) {
    return 'Invalidated';
  }

  if (bullishTriggered || bearishTriggered) {
    return 'Triggered';
  }

  return status === 'Draft' ? 'Draft' : 'Active';
}

export function formatPrice(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
}

export function formatPercent(value: number) {
  return `${round(value * 100, 2)}%`;
}

export function annotationBadgeTone(status: AnnotationStatus) {
  switch (status) {
    case 'Active':
      return 'active';
    case 'Triggered':
      return 'triggered';
    case 'Executed':
      return 'executed';
    case 'Invalidated':
      return 'invalidated';
    default:
      return 'draft';
  }
}
