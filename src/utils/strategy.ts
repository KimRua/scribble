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
    violations.push('포지션 비중은 0보다 크고 1 이하여야 합니다.');
  }

  if (strategy.leverage > settings.maxLeverage) {
    violations.push(`레버리지는 최대 ${settings.maxLeverage}배까지만 허용됩니다.`);
  }

  if (strategy.takeProfitPrices.length === 0) {
    violations.push('최소 1개의 TP가 필요합니다.');
  }

  if (!strategy.invalidationCondition.trim()) {
    violations.push('무효화 조건은 필수입니다.');
  }

  if (isBullish && strategy.stopLossPrice >= strategy.entryPrice) {
    violations.push('롱 전략의 손절가는 진입가보다 낮아야 합니다.');
  }

  if (isBearish && strategy.stopLossPrice <= strategy.entryPrice) {
    violations.push('숏 전략의 손절가는 진입가보다 높아야 합니다.');
  }

  if (isBullish && strategy.takeProfitPrices.some((price) => price <= strategy.entryPrice)) {
    violations.push('롱 전략의 TP는 진입가보다 높아야 합니다.');
  }

  if (isBearish && strategy.takeProfitPrices.some((price) => price >= strategy.entryPrice)) {
    violations.push('숏 전략의 TP는 진입가보다 낮아야 합니다.');
  }

  const riskSummary = calculateRiskSummary(strategy, currentPrice, settings);
  if (riskSummary.maxLossRatio > 0.05) {
    violations.push('예상 최대 손실이 계좌 대비 5%를 초과합니다.');
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
  return new Intl.NumberFormat('ko-KR', {
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
