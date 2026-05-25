import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { defaultUserSettings } from '../../src/data/mockMarket';
import { validateStrategy } from '../../src/utils/strategy';
import type {
  AdminCodeItem,
  AdminMarketInsight,
  AdminMetric,
  AdminOverview,
  AdminRecentAuditEvent,
  AdminRecentExecution,
  AdminRecentNotification,
  AdminRecentStrategy,
  AdminServiceStatus,
  Annotation,
  Execution
} from '../../src/types/domain';
import {
  authenticateAdmin,
  changeAdminPassword,
  getAdminSession,
  getEditableAdminSettings,
  updateEditableAdminSettings
} from '../services/adminConsoleService';
import type { AuditRepository } from '../services/auditRepository';
import type { AutomationRepository } from '../services/automationRepository';
import type { DelegatedPolicyRepository } from '../services/delegatedPolicyRepository';
import type { ExecutionRepository } from '../services/executionRepository';
import type { NotificationRepository } from '../services/notificationRepository';
import type { getState } from '../services/stateStore';
import { getDelegatedAutomationConfigStatus } from '../services/delegatedAutomationService';
import { getDexExecutionConfigStatus } from '../services/dexExecutionService';
import { getHyperliquidConfigStatus } from '../services/hyperliquidExecutionService';
import { isRealMarketDataEnabled } from '../services/marketDataService';
import { getOnchainConfigStatus } from '../services/onchainExecutionService';
import { sendError, sendSuccess } from '../utils/response';

type State = ReturnType<typeof getState>;

interface RegisterAdminRoutesDependencies {
  app: Express;
  auditRepository: AuditRepository;
  automationRepository: AutomationRepository;
  delegatedPolicyRepository: DelegatedPolicyRepository;
  executionRepository: ExecutionRepository;
  notificationRepository: NotificationRepository;
  getState: () => State;
}

const periodOptions = [
  { key: 'today', label: '오늘' },
  { key: '7d', label: '최근 7일' },
  { key: '30d', label: '최근 30일' },
  { key: 'custom', label: '직접 선택' }
] as const;

function buildServices(): AdminServiceStatus[] {
  const llmReady = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  const marketDataEnabled = isRealMarketDataEnabled();
  const dexConfig = getDexExecutionConfigStatus();
  const onchainConfig = getOnchainConfigStatus();
  const hyperliquidConfig = getHyperliquidConfigStatus();
  const delegatedConfig = getDelegatedAutomationConfigStatus();

  return [
    {
      key: 'llm',
      label: 'LLM 분석',
      ready: llmReady,
      detail: llmReady ? `사용 모델 ${process.env.OPENAI_MODEL}` : 'Fallback 파서로 동작 중'
    },
    {
      key: 'market-data',
      label: '시세 데이터',
      ready: marketDataEnabled,
      detail: marketDataEnabled ? '실시간 시세 공급자 사용 중' : '모의 시세 데이터 사용 중'
    },
    {
      key: 'dex',
      label: 'DEX 실행',
      ready: dexConfig.ready,
      detail: dexConfig.ready ? '서버 스왑 경로 설정 완료' : dexConfig.missing.join(', ') || '설정 누락'
    },
    {
      key: 'hyperliquid',
      label: 'Hyperliquid 실행',
      ready: hyperliquidConfig.ready,
      detail: hyperliquidConfig.ready ? '직접 주문 경로 사용 가능' : hyperliquidConfig.missing.join(', ') || '설정 누락'
    },
    {
      key: 'onchain-proof',
      label: '온체인 증빙',
      ready: onchainConfig.ready,
      detail: onchainConfig.ready ? '실행 증빙 기록 가능' : onchainConfig.missing.join(', ') || '설정 누락'
    },
    {
      key: 'delegation',
      label: '위임 자동화',
      ready: delegatedConfig.ready,
      detail: delegatedConfig.ready ? 'executor/vault 연결 완료' : delegatedConfig.missing.join(', ') || '설정 누락'
    }
  ];
}

function ownerKeyToWalletAddress(ownerKey?: string | null) {
  if (!ownerKey?.startsWith('wallet:')) {
    return null;
  }

  return ownerKey.slice('wallet:'.length);
}

function deriveGrossExposureUsd(annotations: Annotation[]) {
  return annotations
    .filter((annotation) => annotation.status === 'Executed')
    .reduce((sum, annotation) => {
      return sum + annotation.strategy.entryPrice * annotation.strategy.positionSizeRatio * annotation.strategy.leverage;
    }, 0);
}

function deriveExecutionCreatedAt(execution: Execution) {
  return execution.filledAt ?? execution.liquidityChainCheckedAt ?? execution.executionChainCheckedAt ?? new Date(0).toISOString();
}

function parseDateInput(input: string | undefined, endOfDay = false) {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  return endOfDay ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
}

function resolvePeriod(startDateInput?: string, endDateInput?: string) {
  const now = new Date();
  const defaultEnd = now.toISOString();
  const defaultStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = parseDateInput(startDateInput) ?? defaultStart;
  const endedAt = parseDateInput(endDateInput, true) ?? defaultEnd;
  const key = startDateInput || endDateInput ? 'custom' : '7d';
  const label = periodOptions.find((option) => option.key === key)?.label ?? '최근 7일';

  return {
    key,
    label,
    startedAt,
    endedAt
  };
}

function isWithinRange(value: string | null | undefined, startedAt: string | null, endedAt: string | null) {
  if (!value) {
    return false;
  }

  if (startedAt && value < startedAt) {
    return false;
  }

  if (endedAt && value > endedAt) {
    return false;
  }

  return true;
}

function buildCodeItems(adminPath: string): AdminCodeItem[] {
  const llmReady = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  const settingMap = new Map(getEditableAdminSettings().map((item) => [item.key, item]));

  return [
    {
      key: 'ADMIN_PATH',
      category: 'runtime',
      label: '관리자 경로',
      value: settingMap.get('ADMIN_PATH')?.value || adminPath,
      status: 'healthy',
      description: '현재 관리자 API 접근 경로',
      editable: true,
      requiresRestart: true,
      inputType: 'text'
    },
    {
      key: 'VITE_ADMIN_PATH',
      category: 'runtime',
      label: '프론트 관리자 경로',
      value: settingMap.get('VITE_ADMIN_PATH')?.value || adminPath,
      status: 'healthy',
      description: '브라우저에서 접근하는 관리자 URL',
      editable: true,
      requiresRestart: true,
      inputType: 'text'
    },
    {
      key: 'OPENAI_MODEL',
      category: 'integration',
      label: 'AI 모델',
      value: settingMap.get('OPENAI_MODEL')?.value || process.env.OPENAI_MODEL || '미설정',
      status: llmReady ? 'healthy' : 'warning',
      description: '전략 분석에 사용하는 OpenAI 모델',
      editable: true,
      requiresRestart: true,
      inputType: 'text'
    },
    ...getEditableAdminSettings()
      .filter((item) => !['ADMIN_PATH', 'VITE_ADMIN_PATH', 'OPENAI_MODEL'].includes(item.key))
      .map<AdminCodeItem>((item) => ({
        key: item.key,
        category: item.category,
        label: item.label,
        value: item.value || '미설정',
        status:
          item.inputType === 'boolean'
            ? item.value === 'true'
              ? 'healthy'
              : 'inactive'
            : item.value
              ? 'healthy'
              : 'warning',
        description: item.description,
        editable: true,
        requiresRestart: item.requiresRestart,
        inputType: item.inputType,
        ...(item.options ? { options: item.options } : {})
      }))
  ];
}

function authorizeAdmin(request: Request, response: Response, adminPath: string) {
  const requestedAdminPath = request.header('X-Admin-Path')?.trim();
  if (requestedAdminPath !== adminPath) {
    response.status(404).end();
    return null;
  }

  const authorization = request.header('Authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
  const session = getAdminSession(token);
  if (!session) {
    sendError(response, 'AUTH_REQUIRED', '관리자 로그인이 필요합니다.');
    return null;
  }

  return session;
}

export function registerAdminRoutes({
  app,
  auditRepository,
  automationRepository,
  delegatedPolicyRepository,
  executionRepository,
  notificationRepository,
  getState
}: RegisterAdminRoutesDependencies) {
  const adminPath = process.env.ADMIN_PATH?.trim() || '/ops/scribble-admin-7f3a9x';

  app.post('/api/v1/admin/login', (request, response) => {
    const requestedAdminPath = request.header('X-Admin-Path')?.trim();
    if (requestedAdminPath !== adminPath) {
      return response.status(404).end();
    }

    const bodySchema = z.object({
      username: z.string().min(1),
      password: z.string().min(1)
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid admin login payload', parsedBody.error.flatten());
    }

    const session = authenticateAdmin(parsedBody.data.username, parsedBody.data.password);
    if (!session) {
      return sendError(response, 'AUTH_REQUIRED', '아이디 또는 비밀번호가 올바르지 않습니다.');
    }

    return sendSuccess(response, {
      token: session.token,
      session: {
        username: session.username
      }
    });
  });

  app.get('/api/v1/admin/session', (request, response) => {
    const session = authorizeAdmin(request, response, adminPath);
    if (!session) {
      return;
    }

    return sendSuccess(response, {
      username: session.username
    });
  });

  app.post('/api/v1/admin/change-password', (request, response) => {
    const session = authorizeAdmin(request, response, adminPath);
    if (!session) {
      return;
    }

    const bodySchema = z.object({
      current_password: z.string().min(1),
      next_password: z.string().min(4)
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid password change payload', parsedBody.error.flatten());
    }

    const changed = changeAdminPassword(session.username, parsedBody.data.current_password, parsedBody.data.next_password);
    if (!changed) {
      return sendError(response, 'AUTH_REQUIRED', '현재 비밀번호가 올바르지 않습니다.');
    }

    return sendSuccess(response, {
      ok: true
    });
  });

  app.patch('/api/v1/admin/settings', (request, response) => {
    const session = authorizeAdmin(request, response, adminPath);
    if (!session) {
      return;
    }

    const bodySchema = z.object({
      updates: z.record(z.string(), z.string())
    });
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 'VALIDATION_ERROR', 'invalid settings payload', parsedBody.error.flatten());
    }

    const settings = updateEditableAdminSettings(parsedBody.data.updates);
    return sendSuccess(response, {
      updatedBy: session.username,
      settings
    });
  });

  app.get('/api/v1/admin/overview', (request, response) => {
    const session = authorizeAdmin(request, response, adminPath);
    if (!session) {
      return;
    }

    const period = resolvePeriod(
      request.query.start_date ? String(request.query.start_date) : undefined,
      request.query.end_date ? String(request.query.end_date) : undefined
    );
    const generatedAt = new Date().toISOString();
    const state = getState();
    const annotations = [...state.annotations]
      .filter((annotation) => isWithinRange(annotation.updatedAt, period.startedAt, period.endedAt))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const executions = [...executionRepository.list()]
      .filter((execution) => isWithinRange(deriveExecutionCreatedAt(execution), period.startedAt, period.endedAt))
      .sort((left, right) => deriveExecutionCreatedAt(right).localeCompare(deriveExecutionCreatedAt(left)));
    const notifications = [...notificationRepository.list()]
      .filter((notification) => isWithinRange(notification.createdAt, period.startedAt, period.endedAt))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const auditEvents = [...auditRepository.list()]
      .filter((event) => isWithinRange(event.timestamp, period.startedAt, period.endedAt))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const automations = automationRepository.list();
    const delegatedPolicies = delegatedPolicyRepository
      .list()
      .filter((policy) => isWithinRange(policy.updatedAt, period.startedAt, period.endedAt));

    const annotationByStrategyId = new Map(annotations.map((annotation) => [annotation.strategy.strategyId, annotation]));
    const notificationWalletByAnnotationId = new Map(annotations.map((annotation) => [annotation.annotationId, ownerKeyToWalletAddress(annotation.ownerKey)]));

    const liveStrategies = annotations.filter((annotation) =>
      ['Draft', 'Active', 'Triggered', 'Executed'].includes(annotation.status)
    );
    const executedStrategies = annotations.filter((annotation) => annotation.status === 'Executed');
    const openExecutions = executions.filter((execution) =>
      ['Pending', 'ReadyToExecute', 'Executing', 'PartiallyFilled'].includes(execution.status)
    );
    const invalidStrategies = annotations.filter(
      (annotation) => !validateStrategy(annotation.strategy, annotation.strategy.entryPrice, defaultUserSettings).isValid
    );
    const avgConfidence =
      annotations.reduce((sum, annotation) => sum + annotation.strategy.confidence, 0) / Math.max(1, annotations.length);
    const grossExposureUsd = deriveGrossExposureUsd(annotations);
    const automationCoverageRatio = automations.length / Math.max(1, annotations.length);
    const delegatedPoliciesActive = delegatedPolicies.filter((policy) => policy.status === 'active').length;

    const metrics: AdminMetric[] = [
      {
        label: '자동화 커버리지',
        value: Math.round(automationCoverageRatio * 100),
        tone: automationCoverageRatio >= 0.5 ? 'good' : 'warn',
        detail: `${automations.length}개 전략에 자동화 규칙이 연결되어 있습니다.`
      },
      {
        label: '위임 자동화 준비도',
        value: delegatedPoliciesActive,
        tone: delegatedPoliciesActive > 0 ? 'good' : 'neutral',
        detail: `${delegatedPolicies.length}개의 위임 정책을 추적하고 있습니다.`
      },
      {
        label: '검토 필요 전략',
        value: invalidStrategies.length,
        tone: invalidStrategies.length === 0 ? 'good' : 'warn',
        detail: '현재 검증 규칙을 통과하지 못한 전략 수'
      },
      {
        label: '미확인 알림',
        value: notifications.filter((item) => !item.read).length,
        tone: notifications.some((item) => !item.read) ? 'warn' : 'neutral',
        detail: `${notifications.length}개의 알림 이력을 보관 중입니다.`
      }
    ];

    const marketInsights: AdminMarketInsight[] = [...new Map(annotations.map((annotation) => [annotation.marketSymbol, true])).keys()]
      .map((symbol) => {
        const items = annotations.filter((annotation) => annotation.marketSymbol === symbol);
        return {
          symbol,
          strategies: items.length,
          executed: items.filter((item) => item.status === 'Executed').length,
          pending: items.filter((item) => item.status === 'Active' || item.status === 'Triggered').length,
          avgConfidence: items.reduce((sum, item) => sum + item.strategy.confidence, 0) / Math.max(1, items.length)
        };
      })
      .sort((left, right) => right.strategies - left.strategies);

    const recentStrategies: AdminRecentStrategy[] = annotations.map((annotation) => ({
      annotationId: annotation.annotationId,
      strategyId: annotation.strategy.strategyId,
      walletAddress: ownerKeyToWalletAddress(annotation.ownerKey),
      marketSymbol: annotation.marketSymbol,
      timeframe: annotation.timeframe,
      status: annotation.status,
      bias: annotation.strategy.bias,
      entryType: annotation.strategy.entryType,
      confidence: annotation.strategy.confidence,
      updatedAt: annotation.updatedAt,
      text: annotation.text
    }));

    const recentExecutions: AdminRecentExecution[] = executions.map((execution) => {
      const annotation = annotationByStrategyId.get(execution.strategyId);
      return {
        executionId: execution.executionId,
        strategyId: execution.strategyId,
        walletAddress: annotation ? ownerKeyToWalletAddress(annotation.ownerKey) : execution.sessionId ?? null,
        marketSymbol: annotation?.marketSymbol ?? '미확인',
        status: execution.status,
        actionType: execution.actionType ?? 'open',
        settlementMode: execution.settlementMode ?? 'mock',
        externalVenue: execution.externalVenue ?? null,
        filledAt: execution.filledAt,
        createdAt: deriveExecutionCreatedAt(execution)
      };
    });

    const recentNotifications: AdminRecentNotification[] = notifications.map((notification) => ({
      notificationId: notification.notificationId,
      walletAddress: notificationWalletByAnnotationId.get(notification.annotationId) ?? notification.sessionId ?? null,
      type: notification.type,
      title: notification.title,
      createdAt: notification.createdAt,
      read: notification.read
    }));

    const recentAuditEvents: AdminRecentAuditEvent[] = auditEvents.map((event) => ({
      eventId: event.eventId,
      walletAddress: event.sessionId ?? null,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      timestamp: event.timestamp
    }));

    const payload: AdminOverview = {
      generatedAt,
      period: {
        key: period.key,
        label: period.label,
        startedAt: period.startedAt,
        endedAt: period.endedAt
      },
      availablePeriods: periodOptions.map((option) => ({ key: option.key, label: option.label })),
      headline: {
        totalStrategies: annotations.length,
        liveStrategies: liveStrategies.length,
        executedStrategies: executedStrategies.length,
        openExecutions: openExecutions.length,
        unreadNotifications: notifications.filter((item) => !item.read).length,
        automationCoverageRatio,
        delegatedPoliciesActive,
        invalidStrategies: invalidStrategies.length,
        grossExposureUsd,
        avgConfidence
      },
      services: buildServices(),
      metrics,
      marketInsights,
      recentStrategies,
      recentExecutions,
      recentNotifications,
      recentAuditEvents,
      codeItems: buildCodeItems(adminPath)
    };

    return sendSuccess(response, {
      ...payload,
      adminSession: {
        username: session.username
      }
    });
  });
}
