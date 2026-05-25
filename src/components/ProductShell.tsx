import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  changeAdminPassword,
  getAdminOverview,
  getAdminPath,
  getAdminSession,
  isAdminLocation,
  loginAdmin,
  setAdminToken,
  updateAdminSettings
} from '../services/apiClient';
import type {
  AdminCodeItem,
  AdminOverview,
  AdminServiceStatus
} from '../types/domain';

type MainView = 'home' | 'workspace';
type AdminSection = 'stats' | 'history' | 'code';
type HistoryTab = 'strategies' | 'executions' | 'notifications' | 'audits';

const MAIN_VIEW_STORAGE_KEY = 'scribble.mainView';
	const HISTORY_PAGE_SIZE = 20;
	const ASCIIText = lazy(() => import('./ASCIIText'));
	const AnimatedContent = lazy(() => import('./AnimatedContent'));
	const Magnet = lazy(() => import('./Magnet'));
	const DecryptedText = lazy(() => import('./DecryptedText'));
	const TradingPage = lazy(() => import('./TradingPage').then((module) => ({ default: module.TradingPage })));
  const WorkspaceLab = lazy(() => import('./WorkspaceLab').then((module) => ({ default: module.WorkspaceLab })));

type MainViewWithLab = MainView | 'lab';

function readMainViewOverrideFromUrl(): MainViewWithLab | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const view = (params.get('view') || '').toLowerCase();
    const lab = (params.get('lab') || '').toLowerCase();

    if (view === 'lab' || lab === '1' || lab === 'true') {
      return 'lab';
    }
  } catch {
    // ignore
  }

  return null;
}

function readMainView(): MainView {
  if (typeof window === 'undefined') {
    return 'home';
  }

  return window.localStorage.getItem(MAIN_VIEW_STORAGE_KEY) === 'workspace' ? 'workspace' : 'home';
}

function formatCompactNumber(value: number, fractionDigits = 0) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: fractionDigits
  }).format(value);
}

function formatRelativeTimestamp(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return value;
  }

  const deltaMinutes = Math.round((Date.now() - time) / 1000 / 60);
  if (deltaMinutes <= 1) {
    return '방금 전';
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}분 전`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}시간 전`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}일 전`;
}

function formatPercentValue(value: number) {
  return `${Math.round(value * 100)}%`;
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getServiceTone(service: AdminServiceStatus) {
  return service.ready ? 'good' : 'warn';
}

function buildPagination(currentPage: number, totalPages: number) {
  const safeTotal = Math.max(1, totalPages);
  const pages = new Set<number>([1, safeTotal, currentPage - 1, currentPage, currentPage + 1]);
  return [...pages].filter((page) => page >= 1 && page <= safeTotal).sort((left, right) => left - right);
}

function paginateRows<T>(rows: T[], currentPage: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = (safePage - 1) * HISTORY_PAGE_SIZE;
  return {
    rows: rows.slice(start, start + HISTORY_PAGE_SIZE),
    currentPage: safePage,
    totalPages,
    totalItems: rows.length
  };
}

function MainHome({ onEnterWorkspace }: { onEnterWorkspace: () => void }) {
  const [ctaVisible, setCtaVisible] = useState(false);
  const [touchStartY, setTouchStartY] = useState<number | null>(null);

  const revealCta = () => {
    setCtaVisible(true);
  };

  return (
    <section
      className="ascii-landing"
      aria-label="Scribble ASCII background"
      onWheel={(event) => {
        if (event.deltaY > 8) {
          revealCta();
          event.preventDefault();
        }
      }}
      onTouchStart={(event) => {
        setTouchStartY(event.touches[0]?.clientY ?? null);
      }}
      onTouchMove={(event) => {
        const currentY = event.touches[0]?.clientY;
        if (touchStartY !== null && typeof currentY === 'number' && touchStartY - currentY > 18) {
          revealCta();
        }
      }}
    >
      <div className="ascii-landing-stage">
        <div className="ascii-landing-copy" aria-label="서비스 소개">
          <p className="ascii-landing-tagline">
            <Suspense fallback={null}>
              <DecryptedText
                text="믿을 수 있는 탈중앙 거래소를 AI와 함께 누비세요."
                animateOn="view"
                sequential
                revealDirection="start"
                speed={22}
                useOriginalCharsOnly={false}
                encryptedClassName="decrypt-encrypted"
              />
            </Suspense>
          </p>
          <p className="ascii-landing-subtitle">
            <Suspense fallback={null}>
              <DecryptedText
                text="Scribble은 뉴스와 포지션을 제공하겠습니다."
                animateOn="view"
                sequential
                revealDirection="start"
                speed={18}
                useOriginalCharsOnly={false}
                encryptedClassName="decrypt-encrypted"
              />
            </Suspense>
          </p>
        </div>

        <Suspense fallback={<div className="ascii-landing-fallback" aria-hidden="true" />}>
          <ASCIIText
            text="Scribble"
            enableWaves={true}
            asciiFontSize={8}
            textFontSize={200}
            planeBaseHeight={8}
            textColor="#fdf9f3"
          />
        </Suspense>

        <div className="ascii-landing-cta-zone">
          <div className="ascii-landing-cta-stack">
            <div
              className={`ascii-landing-scroll-hint${ctaVisible ? ' is-hidden' : ''}`}
              aria-hidden={ctaVisible}
            >
              <span className="ascii-landing-scroll-hint-label">Scribble AI 시작하기</span>
              <span className="ascii-landing-scroll-hint-arrow" aria-hidden="true" />
            </div>

            {ctaVisible ? (
              <Suspense fallback={null}>
                <AnimatedContent
                  manualTrigger
                  distance={140}
                  direction="vertical"
                  reverse={false}
                  duration={1}
                  ease="power3.out"
                  initialOpacity={0}
                  animateOpacity
                  scale={0.94}
                  delay={0}
                  className="ascii-landing-cta-shell"
                >
                  <Suspense fallback={null}>
                    <Magnet
                      padding={180}
                      disabled={false}
                      magnetStrength={8}
                      activeTransition="transform 0.12s ease-out"
                      inactiveTransition="transform 0.22s ease-in-out"
                    >
                      <button type="button" className="ascii-landing-cta-button" onClick={onEnterWorkspace}>
                        지갑 연결
                      </button>
                    </Magnet>
                  </Suspense>
                </AnimatedContent>
              </Suspense>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function AdminLogin({
  username,
  password,
  loading,
  errorMessage,
  onChangeUsername,
  onChangePassword,
  onSubmit
}: {
  username: string;
  password: string;
  loading: boolean;
  errorMessage: string | null;
  onChangeUsername: (value: string) => void;
  onChangePassword: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="product-shell admin-surface">
      <div className="admin-login-shell">
        <section className="panel product-card admin-login-card">
          <p className="eyebrow">스크리블 관리자</p>
          <h1>관리자 로그인</h1>
          <p className="hero-description">초기 계정은 `admin / admin` 입니다. 로그인 후 비밀번호를 변경할 수 있습니다.</p>
          <div className="stack-list">
            <label>
              <span>아이디</span>
              <input value={username} onChange={(event) => onChangeUsername(event.target.value)} />
            </label>
            <label>
              <span>비밀번호</span>
              <input type="password" value={password} onChange={(event) => onChangePassword(event.target.value)} />
            </label>
          </div>
          {errorMessage ? <div className="warning-box compact">{errorMessage}</div> : null}
          <div className="hero-actions">
            <button onClick={onSubmit} disabled={loading}>
              {loading ? '로그인 중…' : '로그인'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function HistoryPagination({
  currentPage,
  totalPages,
  onChangePage
}: {
  currentPage: number;
  totalPages: number;
  onChangePage: (page: number) => void;
}) {
  const pages = buildPagination(currentPage, totalPages);
  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="admin-pagination">
      <button className="ghost-button" onClick={() => onChangePage(currentPage - 1)} disabled={currentPage <= 1}>
        이전
      </button>
      {pages.map((page, index) => {
        const previous = pages[index - 1];
        const needsEllipsis = previous && page - previous > 1;
        return (
          <div key={page} className="admin-pagination-group">
            {needsEllipsis ? <span className="muted">…</span> : null}
            <button className={page === currentPage ? 'secondary' : 'ghost-button'} onClick={() => onChangePage(page)}>
              {page}
            </button>
          </div>
        );
      })}
      <button className="ghost-button" onClick={() => onChangePage(currentPage + 1)} disabled={currentPage >= totalPages}>
        다음
      </button>
    </div>
  );
}

function AdminConsole() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin');
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [activeSection, setActiveSection] = useState<AdminSection>('stats');
  const [activeHistoryTab, setActiveHistoryTab] = useState<HistoryTab>('executions');
  const [historyPageByTab, setHistoryPageByTab] = useState<Record<HistoryTab, number>>({
    strategies: 1,
    executions: 1,
    notifications: 1,
    audits: 1
  });
  const [startDate, setStartDate] = useState(() => toDateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [endDate, setEndDate] = useState(() => toDateInputValue(new Date()));
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAdminLocation()) {
      return;
    }

    void getAdminSession()
      .then(() => {
        setAdminLoggedIn(true);
      })
      .catch(() => {
        setAdminToken(null);
        setAdminLoggedIn(false);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!adminLoggedIn) {
      return;
    }

    let active = true;

    async function load(mode: 'initial' | 'refresh') {
      try {
        if (mode === 'initial') {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        const nextOverview = await getAdminOverview({
          startDate,
          endDate
        });
        if (!active) {
          return;
        }

        setOverview(nextOverview);
        setEditingValues(
          Object.fromEntries(nextOverview.codeItems.filter((item) => item.editable).map((item) => [item.key, item.value]))
        );
        setErrorMessage(null);
      } catch (error) {
        if (!active) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : '관리자 데이터를 불러오지 못했습니다.');
      } finally {
        if (!active) {
          return;
        }

        setLoading(false);
        setRefreshing(false);
      }
    }

    void load('initial');
    const interval = window.setInterval(() => {
      void load('refresh');
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [adminLoggedIn, startDate, endDate]);

  const paginatedStrategies = useMemo(
    () => paginateRows(overview?.recentStrategies ?? [], historyPageByTab.strategies),
    [historyPageByTab.strategies, overview?.recentStrategies]
  );
  const paginatedExecutions = useMemo(
    () => paginateRows(overview?.recentExecutions ?? [], historyPageByTab.executions),
    [historyPageByTab.executions, overview?.recentExecutions]
  );
  const paginatedNotifications = useMemo(
    () => paginateRows(overview?.recentNotifications ?? [], historyPageByTab.notifications),
    [historyPageByTab.notifications, overview?.recentNotifications]
  );
  const paginatedAudits = useMemo(
    () => paginateRows(overview?.recentAuditEvents ?? [], historyPageByTab.audits),
    [historyPageByTab.audits, overview?.recentAuditEvents]
  );

  const paginatedHistory =
    activeHistoryTab === 'strategies'
      ? paginatedStrategies
      : activeHistoryTab === 'notifications'
        ? paginatedNotifications
        : activeHistoryTab === 'audits'
          ? paginatedAudits
          : paginatedExecutions;

  const handleAdminLogin = async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      const result = await loginAdmin(loginUsername, loginPassword);
      setAdminToken(result.token);
      setAdminLoggedIn(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '로그인에 실패했습니다.');
      setLoading(false);
    }
  };

  const handlePasswordChange = async () => {
    try {
      setPasswordMessage(null);
      await changeAdminPassword(currentPassword, nextPassword);
      setCurrentPassword('');
      setNextPassword('');
      setPasswordMessage('비밀번호를 변경했습니다.');
    } catch (error) {
      setPasswordMessage(error instanceof Error ? error.message : '비밀번호 변경에 실패했습니다.');
    }
  };

  const handleSaveCodeSetting = async (item: AdminCodeItem) => {
    try {
      const value = editingValues[item.key] ?? item.value;
      await updateAdminSettings({ [item.key]: value });
      const nextOverview = await getAdminOverview({ startDate, endDate });
      setOverview(nextOverview);
      setEditingValues((current) => ({ ...current, [item.key]: value }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '설정 저장에 실패했습니다.');
    }
  };

  if (loading && !adminLoggedIn) {
    return <AdminLogin username={loginUsername} password={loginPassword} loading={loading} errorMessage={errorMessage} onChangeUsername={setLoginUsername} onChangePassword={setLoginPassword} onSubmit={handleAdminLogin} />;
  }

  if (!adminLoggedIn) {
    return <AdminLogin username={loginUsername} password={loginPassword} loading={loading} errorMessage={errorMessage} onChangeUsername={setLoginUsername} onChangePassword={setLoginPassword} onSubmit={handleAdminLogin} />;
  }

  return (
    <div className="product-shell admin-surface">
      <header className="product-topbar">
        <div className="product-brand">
          <div className="product-brand-mark">S</div>
          <div>
            <p className="eyebrow">비공개 관리자 URL</p>
            <h1>스크리블 관리자 콘솔</h1>
          </div>
        </div>
        <div className="admin-header-actions">
          <label className="admin-period-field">
            <span>시작 날짜</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="admin-period-field">
            <span>종료 날짜</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <button className="ghost-button" onClick={() => window.location.assign('/')} disabled={refreshing}>
            메인 앱
          </button>
        </div>
      </header>

      <nav className="admin-nav panel">
        <button className={activeSection === 'stats' ? 'secondary' : 'ghost-button'} onClick={() => setActiveSection('stats')}>
          통계
        </button>
        <button className={activeSection === 'history' ? 'secondary' : 'ghost-button'} onClick={() => setActiveSection('history')}>
          이력
        </button>
        <button className={activeSection === 'code' ? 'secondary' : 'ghost-button'} onClick={() => setActiveSection('code')}>
          코드관리
        </button>
      </nav>

      {errorMessage ? <div className="panel error-banner product-banner">{errorMessage}</div> : null}
      {loading && !overview ? <div className="panel loading-banner product-banner">관리자 데이터를 불러오는 중입니다…</div> : null}

      {overview ? (
        <div className="admin-grid">
          <section className="panel product-card admin-span-2">
            <div className="section-heading">
              <div>
                <p className="eyebrow">관리자 헤더</p>
                <h2>운영 현황 요약</h2>
              </div>
              <div className="hero-footnote">
                <span>{overview.period.startedAt?.slice(0, 10)} ~ {overview.period.endedAt?.slice(0, 10)}</span>
                <span>업데이트 {formatRelativeTimestamp(overview.generatedAt)}</span>
              </div>
            </div>
            <div className="admin-kpi-grid">
              <article className="ops-metric-card tone-neutral">
                <span>전체 전략 수</span>
                <strong>{overview.headline.totalStrategies}</strong>
                <p>{overview.headline.liveStrategies}개 전략이 현재 운영 중입니다.</p>
              </article>
              <article className="ops-metric-card tone-good">
                <span>총 익스포저</span>
                <strong>${formatCompactNumber(overview.headline.grossExposureUsd)}</strong>
                <p>{overview.headline.executedStrategies}개 전략이 체결 상태입니다.</p>
              </article>
              <article className="ops-metric-card tone-warn">
                <span>미확인 알림</span>
                <strong>{overview.headline.unreadNotifications}</strong>
                <p>{overview.headline.invalidStrategies}개 전략이 검토가 필요합니다.</p>
              </article>
              <article className="ops-metric-card tone-good">
                <span>자동화 커버리지</span>
                <strong>{formatPercentValue(overview.headline.automationCoverageRatio)}</strong>
                <p>{overview.headline.delegatedPoliciesActive}개 위임 정책이 활성화되어 있습니다.</p>
              </article>
            </div>
          </section>

          {activeSection === 'stats' ? (
            <>
              <section className="panel product-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">서비스 상태</p>
                    <h2>실행 스택 준비 상태</h2>
                  </div>
                </div>
                <div className="service-list">
                  {overview.services.map((service) => (
                    <article key={service.key} className={`service-card tone-${getServiceTone(service)}`}>
                      <div className="service-card-top">
                        <strong>{service.label}</strong>
                        <span className={`pill ${service.ready ? 'executed' : 'triggered'}`}>{service.ready ? '정상' : '설정 필요'}</span>
                      </div>
                      <p>{service.detail}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="panel product-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">운영 지표</p>
                    <h2>핵심 관리 포인트</h2>
                  </div>
                </div>
                <div className="ops-metric-grid">
                  {overview.metrics.map((metric) => (
                    <article key={metric.label} className={`ops-metric-card tone-${metric.tone}`}>
                      <span>{metric.label}</span>
                      <strong>{metric.label.includes('커버리지') ? `${metric.value}%` : metric.value}</strong>
                      <p>{metric.detail}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="panel product-card admin-span-2">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">시장 분포</p>
                    <h2>마켓별 전략 집중도</h2>
                  </div>
                </div>
                <div className="admin-table">
                  <div className="admin-table-head admin-table-market">
                    <span>마켓</span>
                    <span>전략 수</span>
                    <span>체결</span>
                    <span>대기</span>
                    <span>신뢰도</span>
                  </div>
                  <div className="admin-table-body">
                    {overview.marketInsights.map((market) => (
                      <article key={market.symbol} className="admin-table-row admin-table-market">
                        <strong>{market.symbol}</strong>
                        <span>{market.strategies}</span>
                        <span>{market.executed}</span>
                        <span>{market.pending}</span>
                        <span>{Math.round(market.avgConfidence)}</span>
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {activeSection === 'history' ? (
            <>
              <section className="panel product-card admin-span-2">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">이력 탭</p>
                    <h2>조회할 이력 종류를 선택하세요</h2>
                  </div>
                </div>
                <div className="product-nav">
                  <button className={activeHistoryTab === 'executions' ? 'secondary' : 'ghost-button'} onClick={() => setActiveHistoryTab('executions')}>
                    실행 이력
                  </button>
                  <button className={activeHistoryTab === 'strategies' ? 'secondary' : 'ghost-button'} onClick={() => setActiveHistoryTab('strategies')}>
                    전략 이력
                  </button>
                  <button className={activeHistoryTab === 'notifications' ? 'secondary' : 'ghost-button'} onClick={() => setActiveHistoryTab('notifications')}>
                    알림 이력
                  </button>
                  <button className={activeHistoryTab === 'audits' ? 'secondary' : 'ghost-button'} onClick={() => setActiveHistoryTab('audits')}>
                    감사 로그
                  </button>
                </div>
              </section>

              <section className="panel product-card admin-span-2">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">상세 이력</p>
                    <h2>{activeHistoryTab === 'executions' ? '실행 이력' : activeHistoryTab === 'strategies' ? '전략 이력' : activeHistoryTab === 'notifications' ? '알림 이력' : '감사 로그'}</h2>
                  </div>
                  <span className="muted">총 {paginatedHistory.totalItems}건</span>
                </div>

                {activeHistoryTab === 'executions' ? (
                  <div className="admin-table">
                    <div className="admin-table-head admin-table-executions-wallet">
                      <span>지갑</span>
                      <span>마켓</span>
                      <span>상태</span>
                      <span>동작</span>
                      <span>정산 방식</span>
                      <span>실행 경로</span>
                      <span>업데이트</span>
                    </div>
                    <div className="admin-table-body">
                      {paginatedExecutions.rows.map((execution) => (
                        <article key={execution.executionId} className="admin-table-row admin-table-executions-wallet">
                          <span className="admin-table-target">{execution.walletAddress ?? '미확인'}</span>
                          <strong>{execution.marketSymbol}</strong>
                          <span className={`pill ${execution.status.toLowerCase()}`}>{execution.status}</span>
                          <span>{execution.actionType ?? 'open'}</span>
                          <span>{execution.settlementMode ?? 'mock'}</span>
                          <span>{execution.externalVenue ?? 'internal'}</span>
                          <span>{formatRelativeTimestamp(execution.createdAt)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeHistoryTab === 'strategies' ? (
                  <div className="admin-table">
                    <div className="admin-table-head admin-table-strategies-wallet">
                      <span>지갑</span>
                      <span>마켓</span>
                      <span>상태</span>
                      <span>방향</span>
                      <span>진입 방식</span>
                      <span>신뢰도</span>
                      <span>업데이트</span>
                    </div>
                    <div className="admin-table-body">
                      {paginatedStrategies.rows.map((strategy) => (
                        <article key={strategy.annotationId} className="admin-table-row admin-table-strategies-wallet">
                          <span className="admin-table-target">{strategy.walletAddress ?? '미확인'}</span>
                          <strong>{strategy.marketSymbol} · {strategy.timeframe}</strong>
                          <span className={`pill ${strategy.status.toLowerCase()}`}>{strategy.status}</span>
                          <span>{strategy.bias}</span>
                          <span>{strategy.entryType}</span>
                          <span>{Math.round(strategy.confidence)}</span>
                          <span>{formatRelativeTimestamp(strategy.updatedAt)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeHistoryTab === 'notifications' ? (
                  <div className="admin-table">
                    <div className="admin-table-head admin-table-notifications-wallet">
                      <span>지갑</span>
                      <span>제목</span>
                      <span>종류</span>
                      <span>상태</span>
                      <span>업데이트</span>
                    </div>
                    <div className="admin-table-body">
                      {paginatedNotifications.rows.map((notification) => (
                        <article key={notification.notificationId} className="admin-table-row admin-table-notifications-wallet">
                          <span className="admin-table-target">{notification.walletAddress ?? '미확인'}</span>
                          <strong>{notification.title}</strong>
                          <span>{notification.type}</span>
                          <span className={`pill ${notification.read ? 'draft' : 'triggered'}`}>{notification.read ? '읽음' : '미확인'}</span>
                          <span>{formatRelativeTimestamp(notification.createdAt)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeHistoryTab === 'audits' ? (
                  <div className="admin-table">
                    <div className="admin-table-head admin-table-audit-wallet">
                      <span>지갑</span>
                      <span>이벤트</span>
                      <span>대상 종류</span>
                      <span>대상 ID</span>
                      <span>업데이트</span>
                    </div>
                    <div className="admin-table-body">
                      {paginatedAudits.rows.map((event) => (
                        <article key={event.eventId} className="admin-table-row admin-table-audit-wallet">
                          <span className="admin-table-target">{event.walletAddress ?? '미확인'}</span>
                          <strong>{event.eventType}</strong>
                          <span>{event.entityType}</span>
                          <span className="admin-table-target">{event.entityId}</span>
                          <span>{formatRelativeTimestamp(event.timestamp)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                <HistoryPagination
                  currentPage={paginatedHistory.currentPage}
                  totalPages={paginatedHistory.totalPages}
                  onChangePage={(page) =>
                    setHistoryPageByTab((current) => ({
                      ...current,
                      [activeHistoryTab]: page
                    }))
                  }
                />
              </section>
            </>
          ) : null}

          {activeSection === 'code' ? (
            <>
              <section className="panel product-card admin-span-2">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">코드관리</p>
                    <h2>환경값 및 운영 설정 수정</h2>
                  </div>
                </div>
                <div className="admin-table">
                  <div className="admin-table-head admin-table-code-edit">
                    <span>분류</span>
                    <span>항목</span>
                    <span>값</span>
                    <span>상태</span>
                    <span>설명</span>
                    <span>저장</span>
                  </div>
                  <div className="admin-table-body">
                    {overview.codeItems.map((item) => (
                      <article key={item.key} className="admin-table-row admin-table-code-edit">
                        <span>{item.category}</span>
                        <strong>{item.label}</strong>
                        <div>
                          {item.inputType === 'boolean' ? (
                            <select
                              value={editingValues[item.key] ?? item.value}
                              onChange={(event) =>
                                setEditingValues((current) => ({ ...current, [item.key]: event.target.value }))
                              }
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : item.inputType === 'select' && item.options ? (
                            <select
                              value={editingValues[item.key] ?? item.value}
                              onChange={(event) =>
                                setEditingValues((current) => ({ ...current, [item.key]: event.target.value }))
                              }
                            >
                              {item.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              value={editingValues[item.key] ?? item.value}
                              onChange={(event) =>
                                setEditingValues((current) => ({ ...current, [item.key]: event.target.value }))
                              }
                            />
                          )}
                        </div>
                        <span className={`pill ${item.status === 'healthy' ? 'executed' : item.status === 'warning' ? 'triggered' : 'draft'}`}>
                          {item.status === 'healthy' ? '정상' : item.status === 'warning' ? '주의' : '비활성'}
                        </span>
                        <span className="admin-table-target">
                          {item.description}
                          {item.requiresRestart ? ' 재시작 후 적용됩니다.' : ''}
                        </span>
                        <button className="ghost-button" onClick={() => void handleSaveCodeSetting(item)} disabled={!item.editable}>
                          저장
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
              </section>

              <section className="panel product-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">비밀번호 재설정</p>
                    <h2>로그인 상태에서만 변경 가능</h2>
                  </div>
                </div>
                <div className="stack-list">
                  <label>
                    <span>현재 비밀번호</span>
                    <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                  </label>
                  <label>
                    <span>새 비밀번호</span>
                    <input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
                  </label>
                  {passwordMessage ? <div className="info-banner">{passwordMessage}</div> : null}
                  <button onClick={() => void handlePasswordChange()}>비밀번호 변경</button>
                </div>
              </section>

              <section className="panel product-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">관리 정보</p>
                    <h2>현재 관리자 상태</h2>
                  </div>
                </div>
                <div className="stack-list">
                  <article className="timeline-card">
                    <strong>관리자 URL</strong>
                    <p className="admin-table-target">{getAdminPath()}</p>
                  </article>
                  <article className="timeline-card">
                    <strong>조회 기간</strong>
                    <p>{startDate} ~ {endDate}</p>
                  </article>
                </div>
              </section>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProductShell() {
  const [mainView, setMainView] = useState<MainViewWithLab>(() => readMainViewOverrideFromUrl() ?? readMainView());

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // URL override (lab) should not persist as user's main default view.
      if (mainView !== 'lab') {
        window.localStorage.setItem(MAIN_VIEW_STORAGE_KEY, mainView);
      }
    }
  }, [mainView]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const locked = mainView === 'home' && !isAdminLocation();
    document.documentElement.classList.toggle('landing-locked', locked);
    document.body.classList.toggle('landing-locked', locked);

    return () => {
      document.documentElement.classList.remove('landing-locked');
      document.body.classList.remove('landing-locked');
    };
  }, [mainView]);

  if (isAdminLocation()) {
    return <AdminConsole />;
  }

  return (
    <div
      className={
        mainView === 'home'
          ? 'product-shell product-shell-immersive'
          : 'product-shell product-shell-workspace workspace-theme'
      }
    >
      {mainView === 'home' ? <MainHome onEnterWorkspace={() => setMainView('workspace')} /> : null}

      {mainView === 'lab' ? (
        <Suspense fallback={null}>
          <WorkspaceLab />
        </Suspense>
      ) : null}

      {mainView === 'workspace' ? (
        <Suspense fallback={<div className="workspace-loading-shell">워크스페이스를 불러오는 중입니다…</div>}>
          <TradingPage />
        </Suspense>
      ) : null}
    </div>
  );
}
