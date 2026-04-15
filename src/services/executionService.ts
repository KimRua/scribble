import type { Annotation, AutomationRule, Execution, ExecutionPlan, NotificationItem, Strategy, UserSettings } from '../types/domain';
import { validateStrategy } from '../utils/strategy';

export function createExecutionPreview(strategy: Strategy, currentPrice: number, settings: UserSettings): ExecutionPlan {
  const validation = validateStrategy(strategy, currentPrice, settings);
  return {
    executionChain: 'opbnb',
    liquidityChain: 'bsc',
    entryPrice: strategy.entryPrice,
    positionSize: Number((settings.accountBalance * strategy.positionSizeRatio).toFixed(2)),
    estimatedSlippage: 0.003,
    estimatedFee: 0.12,
    guardrailCheck: {
      passed: validation.isValid,
      violations: validation.violations
    }
  };
}

export function executeStrategy(strategy: Strategy): Execution {
  return {
    executionId: `exe_${strategy.strategyId}_${Date.now()}`,
    strategyId: strategy.strategyId,
    status: 'Filled',
    executionChain: 'opbnb',
    liquidityChain: 'bsc',
    executionChainTxHash: null,
    liquidityChainTxHash: null,
    executionChainTxHashValid: true,
    liquidityChainTxHashValid: true,
    filledPrice: strategy.entryPrice,
    filledAt: new Date().toISOString()
  };
}

export function armAutomation(strategy: Strategy, settings: UserSettings): AutomationRule {
  return {
    automationId: `auto_${strategy.strategyId}`,
    strategyId: strategy.strategyId,
    status: 'Armed',
    triggerPrice: strategy.entryPrice,
    maxPositionSizeRatio: strategy.positionSizeRatio,
    maxLeverage: Math.min(settings.maxLeverage, strategy.leverage),
    maxLossRatio: 0.05,
    maxDailyExecutions: 3,
    stopConditions: ['max daily executions reached', 'guardrail violation', 'manual halt']
  };
}

export function simulatePriceTick(annotation: Annotation, nextPrice: number, automation?: AutomationRule) {
  const notifications: NotificationItem[] = [];
  let nextStatus = annotation.status;
  let execution: Execution | null = null;
  let nextAutomation = automation;

  if (annotation.strategy.bias === 'bullish') {
    if (nextPrice <= annotation.strategy.stopLossPrice) {
      nextStatus = 'Invalidated';
      if (automation) {
        nextAutomation = { ...automation, status: 'Halted' };
      }
      notifications.push({
        notificationId: `noti_${Date.now()}_invalidated`,
        type: 'strategy_invalidated',
        title: '전략 무효화',
        body: `${annotation.marketSymbol} 전략이 손절 기준 이탈로 무효화되었습니다.`,
        annotationId: annotation.annotationId,
        createdAt: new Date().toISOString(),
        read: false
      });
    } else if (nextPrice >= annotation.strategy.entryPrice) {
      nextStatus = annotation.strategy.autoExecuteEnabled ? 'Executed' : 'Triggered';
      notifications.push({
        notificationId: `noti_${Date.now()}_triggered`,
        type: annotation.strategy.autoExecuteEnabled ? 'execution_filled' : 'strategy_triggered',
        title: annotation.strategy.autoExecuteEnabled ? '자동 실행 완료' : '전략 트리거 발생',
        body: `${annotation.marketSymbol} ${annotation.strategy.entryPrice} 진입 조건이 충족되었습니다.`,
        annotationId: annotation.annotationId,
        createdAt: new Date().toISOString(),
        read: false
      });
      if (annotation.strategy.autoExecuteEnabled) {
        execution = executeStrategy(annotation.strategy);
        if (automation) {
          nextAutomation = { ...automation, status: 'Completed' };
        }
      }
    }
  }

  return { nextStatus, execution, notifications, nextAutomation };
}
