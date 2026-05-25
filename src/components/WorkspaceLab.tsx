import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { defaultUserSettings, marketOptions as fallbackMarketOptions } from '../data/mockMarket';
import { analyzeChart, fetchNewsInsights, getCandles, getMarkets, setClientWalletAddress } from '../services/apiClient';
import {
  connectInjectedWallet,
  getInjectedWalletSession,
  subscribeInjectedWalletSession,
  switchInjectedWallet
} from '../services/walletService';
import type { Annotation, Candle, DrawingMode, DrawingObject, EntryType, NewsInsight, WalletSession } from '../types/domain';
import { useToast } from './ToastProvider';
import { ChartCanvas } from './ChartCanvas';
import StarBorder from './StarBorder';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'scribble.lab.sidebarCollapsed';
const MOBILE_MEDIA_QUERY = '(max-width: 920px)';
const MARKET_ICON_URL_BY_ASSET: Record<string, string> = {
  BTC: 'https://assets-cdn.trustwallet.com/blockchains/bitcoin/info/logo.png',
  BNB: 'https://assets-cdn.trustwallet.com/blockchains/smartchain/info/logo.png',
  ETH: 'https://assets-cdn.trustwallet.com/blockchains/ethereum/info/logo.png'
};

function readIsMobileViewport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function formatWalletChip(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function MarketIcon({ asset }: { asset: string }) {
  const normalizedAsset = asset.toUpperCase();
  const iconUrl = MARKET_ICON_URL_BY_ASSET[normalizedAsset];
  const [imageFailed, setImageFailed] = useState(false);

  if (!iconUrl || imageFailed) {
    return <span className="workspace-lab-market-icon-fallback" aria-hidden>{normalizedAsset.slice(0, 1)}</span>;
  }

  return (
    <img
      className="workspace-lab-market-icon-image"
      src={iconUrl}
      alt=""
      aria-hidden
      loading="eager"
      decoding="async"
      onError={() => setImageFailed(true)}
    />
  );
}

function formatStrategyPrice(value: number) {
  if (!Number.isFinite(value)) {
    return '-';
  }

  return value >= 100 ? value.toFixed(2) : value.toFixed(4);
}

function formatBias(value: Annotation['strategy']['bias']) {
  if (value === 'bullish') return '롱 / bullish';
  if (value === 'bearish') return '숏 / bearish';
  return '중립 / neutral';
}

function formatEntryType(value: EntryType) {
  if (value === 'market') return '시장가';
  if (value === 'limit') return '지정가';
  return '조건부';
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatRelativeAge(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return '생성 시각 알 수 없음';
  }

  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return '방금 생성됨';
  if (minutes < 60) return `${minutes}분 전 분석`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전 분석`;
  return `${Math.round(hours / 24)}일 전 분석`;
}

function getSnapshotFreshness(annotation: Annotation, latestAnnotationId: string | null) {
  if (annotation.annotationId !== latestAnnotationId) {
    return '이전 분석 스냅샷';
  }

  const createdAt = new Date(annotation.createdAt).getTime();
  const ageMinutes = Number.isFinite(createdAt) ? (Date.now() - createdAt) / 60_000 : Number.POSITIVE_INFINITY;
  if (ageMinutes <= 15) {
    return '최신 분석 스냅샷';
  }
  return '재분석 권장';
}

function formatNewsTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return value;
  }

  return time.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function anchorAnalysisAtCurrentCandle(annotation: Annotation, candles: Candle[]): Annotation {
  const anchorCandle = candles.at(-1);
  if (!anchorCandle) {
    return annotation;
  }

  const anchoredAnnotation = {
    ...annotation,
    chartAnchor: {
      time: anchorCandle.openTime,
      price: anchorCandle.close,
      index: Math.max(candles.length - 1, 0)
    }
  };

  return {
    ...anchoredAnnotation,
    drawingObjects: buildTraderSetupDrawingObjects(anchoredAnnotation, candles)
  };
}

function createSetupAnchor(candles: Candle[], index: number, price: number) {
  const safeIndex = Math.min(Math.max(index, 0), Math.max(candles.length - 1, 0));
  return {
    index: safeIndex,
    time: candles[safeIndex]?.openTime ?? new Date().toISOString(),
    price
  };
}

function buildTraderSetupDrawingObjects(annotation: Annotation, candles: Candle[]): DrawingObject[] {
  const strategy = annotation.strategy;
  const anchorIndex = annotation.chartAnchor.index;
  const isShort = strategy.bias === 'bearish';
  const entry = strategy.entryPrice;
  const stop = strategy.stopLossPrice;
  const takeProfits = strategy.takeProfitPrices.slice(0, 3);
  const firstTarget = takeProfits[0] ?? (isShort ? entry - Math.abs(entry - stop) * 2 : entry + Math.abs(entry - stop) * 2);
  const contextStartIndex = Math.max(anchorIndex - 18, 0);
  const setupIndex = Math.max(anchorIndex - 8, 0);
  const triggerIndex = Math.max(anchorIndex - 4, 0);
  const contextCandles = candles.slice(contextStartIndex, Math.max(anchorIndex + 1, contextStartIndex + 1));
  const swingOffset = contextCandles.reduce((bestIndex, candle, index) => {
    const best = contextCandles[bestIndex];
    if (!best) return index;
    return isShort ? (candle.high > best.high ? index : bestIndex) : (candle.low < best.low ? index : bestIndex);
  }, 0);
  const swingIndex = contextStartIndex + swingOffset;
  const swingPrice = isShort ? candles[swingIndex]?.high ?? annotation.chartAnchor.price : candles[swingIndex]?.low ?? annotation.chartAnchor.price;

  return [
    { id: 'setup_entry_line', type: 'line', role: 'entry', price: entry },
    { id: 'setup_stop_line', type: 'line', role: 'stop_loss', price: stop },
    ...takeProfits.map((price, index) => ({ id: `setup_tp_${index + 1}`, type: 'line' as const, role: 'take_profit' as const, price })),
    { id: 'setup_risk_zone', type: 'box', role: 'zone', priceFrom: entry, priceTo: stop },
    { id: 'setup_reward_zone', type: 'box', role: 'zone', priceFrom: entry, priceTo: firstTarget },
    {
      id: 'setup_context_trendline',
      type: 'segment',
      role: 'trendline',
      startAnchor: createSetupAnchor(candles, swingIndex, swingPrice),
      endAnchor: createSetupAnchor(candles, anchorIndex, annotation.chartAnchor.price)
    },
    {
      id: 'setup_entry_path',
      type: 'segment',
      role: 'entry',
      startAnchor: createSetupAnchor(candles, setupIndex, annotation.chartAnchor.price),
      endAnchor: createSetupAnchor(candles, triggerIndex, entry)
    },
    {
      id: 'setup_target_path',
      type: 'segment',
      role: 'take_profit',
      startAnchor: createSetupAnchor(candles, triggerIndex, entry),
      endAnchor: createSetupAnchor(candles, anchorIndex, firstTarget)
    },
    {
      id: 'setup_failure_path',
      type: 'segment',
      role: 'stop_loss',
      startAnchor: createSetupAnchor(candles, triggerIndex, entry),
      endAnchor: createSetupAnchor(candles, anchorIndex, stop)
    }
  ];
}

export function WorkspaceLab() {
  const sidebarId = useId();
  const { showToast } = useToast();
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const walletMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const walletMenuRef = useRef<HTMLDivElement | null>(null);
  const [symbolMenuOpen, setSymbolMenuOpen] = useState(false);
  const symbolMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const symbolMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  });

  const [activeMain, setActiveMain] = useState<'dex' | null>('dex');
  const [availableMarkets, setAvailableMarkets] = useState(fallbackMarketOptions);
  const [selectedSymbol, setSelectedSymbol] = useState('BNBUSDT');
  const [timeframe, setTimeframe] = useState<'15m' | '1h' | '4h'>('1h');
  const [orderbookOpen, setOrderbookOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [aiRequestPending, setAiRequestPending] = useState(false);
  const [parsingNotesByAnnotationId, setParsingNotesByAnnotationId] = useState<Record<string, string[]>>({});
  const [newsInsights, setNewsInsights] = useState<NewsInsight[]>([]);
  const [selectedNewsInsightId, setSelectedNewsInsightId] = useState<string | null>(null);
  const [newsProvider, setNewsProvider] = useState<'openai' | 'fallback' | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [marketData, setMarketData] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const symbol = selectedSymbol;

  const currentPrice = marketData.at(-1)?.close ?? 0;
  const drawingMode: DrawingMode = 'none';
  const selectedMarket = useMemo(
    () => availableMarkets.find((market) => market.symbol === selectedSymbol) ?? null,
    [availableMarkets, selectedSymbol]
  );
  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.annotationId === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId]
  );
  const latestAnnotationId = annotations[0]?.annotationId ?? null;
  const selectedNewsInsight = useMemo(
    () => newsInsights.find((insight) => insight.insightId === selectedNewsInsightId) ?? null,
    [newsInsights, selectedNewsInsightId]
  );
  const selectedStrategy = selectedAnnotation?.strategy ?? null;
  const selectedParsingNotes = selectedAnnotation ? parsingNotesByAnnotationId[selectedAnnotation.annotationId] ?? [] : [];
  const selectableMarkets = useMemo(
    () => availableMarkets.filter((market) => market.symbol !== selectedSymbol),
    [availableMarkets, selectedSymbol]
  );

  const handleContentAreaClick = () => {
    if (isMobileViewport && !sidebarCollapsed) {
      setSidebarCollapsed(true);
      return;
    }

    if (!isMobileViewport && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  };

  const handleActivateDex = () => {
    setActiveMain('dex');
    setSidebarCollapsed(isMobileViewport);
  };

  useEffect(() => {
    let cancelled = false;

    void getMarkets()
      .then((markets) => {
        if (cancelled || markets.length === 0) return;

        const activeMarkets = markets.filter((market) => market.status === 'active');
        const nextMarkets = activeMarkets.length > 0 ? activeMarkets : markets;
        setAvailableMarkets(nextMarkets);

        setSelectedSymbol((current) => {
          if (nextMarkets.some((market) => market.symbol === current)) {
            return current;
          }
          return nextMarkets[0]?.symbol ?? current;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableMarkets(fallbackMarketOptions);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (activeMain !== 'dex') {
      return;
    }

    let cancelled = false;
    let refreshTimer: number | null = null;

    const loadCandles = async (showLoading: boolean) => {
      if (showLoading) {
        setChartLoading(true);
      }
      setChartError(null);

      try {
        const candles = await getCandles(symbol, timeframe);
        if (cancelled) return;
        setMarketData(candles);
      } catch (error) {
        if (cancelled) return;
        setChartError(error instanceof Error ? error.message : '차트 데이터를 불러오지 못했습니다.');
        if (showLoading) {
          setMarketData([]);
        }
      } finally {
        if (!cancelled && showLoading) {
          setChartLoading(false);
        }
      }
    };

    void loadCandles(true);
    refreshTimer = window.setInterval(() => {
      void loadCandles(false);
    }, 15_000);

    return () => {
      cancelled = true;
      if (refreshTimer !== null) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [activeMain, symbol, timeframe]);

  useEffect(() => {
    if (activeMain !== 'dex') {
      return;
    }

    let cancelled = false;
    setNewsLoading(true);
    setSelectedNewsInsightId(null);

    void fetchNewsInsights({ marketSymbol: symbol, timeframe, threshold: 0.5 })
      .then((result) => {
        if (cancelled) return;
        setNewsInsights(result.insights);
        setNewsProvider(result.provider);
      })
      .catch(() => {
        if (cancelled) return;
        setNewsInsights([]);
        setNewsProvider(null);
      })
      .finally(() => {
        if (!cancelled) {
          setNewsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeMain, symbol, timeframe, walletSession?.address]);

  useEffect(() => {
    const unsubscribe = subscribeInjectedWalletSession((session) => {
      setWalletSession(session);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getInjectedWalletSession()
      .then((session) => {
        if (!cancelled) setWalletSession(session);
      })
      .catch(() => {
        if (!cancelled) setWalletSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isMobileViewport) {
      return;
    }

    setSidebarCollapsed(true);
    setWalletMenuOpen(false);
    setSymbolMenuOpen(false);
  }, [isMobileViewport]);

  const handleConnectWallet = async () => {
    const session = await connectInjectedWallet();
    if (!session?.address) {
      setClientWalletAddress(null);
      setWalletSession(null);
      return;
    }
    setClientWalletAddress(session.address);
    setWalletSession(session);
    showToast('지갑이 연결되었습니다.', { tone: 'success', durationMs: 1000 });
  };

  const handleDisconnectWallet = () => {
    setClientWalletAddress(null);
    setWalletSession(null);
    setWalletMenuOpen(false);
  };

  const handleSwitchWallet = async () => {
    const session = await switchInjectedWallet();
    if (!session?.address) {
      setClientWalletAddress(null);
      setWalletSession(null);
      setWalletMenuOpen(false);
      return;
    }
    setClientWalletAddress(session.address);
    setWalletSession(session);
    setWalletMenuOpen(false);
  };

  const handleRequestAi = async () => {
    if (!walletSession?.address) {
      showToast('AI 분석을 생성하려면 지갑을 먼저 연결하세요.', { durationMs: 1600 });
      return;
    }

    try {
      setAiRequestPending(true);
      const result = await analyzeChart({
        marketSymbol: selectedSymbol,
        timeframe,
        riskLevel: defaultUserSettings.riskLevel,
        defaultPositionSizeRatio: defaultUserSettings.defaultPositionSize,
        leverage: defaultUserSettings.leverage
      });
      const analysisSnapshot = anchorAnalysisAtCurrentCandle(result.annotation, marketData);
      setAnnotations((prev) => [analysisSnapshot, ...prev]);
      setSelectedAnnotationId(analysisSnapshot.annotationId);
      setSelectedNewsInsightId(null);
      setParsingNotesByAnnotationId((prev) => ({
        ...prev,
        [analysisSnapshot.annotationId]: [
          result.provider === 'openai' ? 'provider: openai' : 'provider: fallback',
          `snapshot price: ${formatStrategyPrice(analysisSnapshot.chartAnchor.price)}`,
          result.provider === 'openai' ? 'Generated by LLM analysis' : 'Generated by fallback analysis'
        ]
      }));
      setOrderbookOpen(true);
      showToast('AI 분석 결과를 생성했습니다.', { tone: 'success', durationMs: 1200 });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'AI 분석을 생성하지 못했습니다.', { durationMs: 2200 });
    } finally {
      setAiRequestPending(false);
    }
  };

  const handleSelectAnnotation = (annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
    if (annotationId) {
      setSelectedNewsInsightId(null);
    }
    if (annotationId) {
      setOrderbookOpen(true);
    }
  };

  const handleSelectNewsInsight = (insightId: string | null) => {
    setSelectedNewsInsightId(insightId);
    if (insightId) {
      setSelectedAnnotationId(null);
      setOrderbookOpen(true);
    }
  };

  const handleCopyAddress = async () => {
    if (!walletSession?.address) return;
    try {
      await navigator.clipboard.writeText(walletSession.address);
      showToast('주소를 복사했습니다.', { tone: 'success', durationMs: 900 });
    } catch {
      // ignore
    } finally {
      setWalletMenuOpen(false);
    }
  };

  useEffect(() => {
    if (!walletMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (walletMenuRef.current?.contains(target)) return;
      if (walletMenuButtonRef.current?.contains(target)) return;
      setWalletMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWalletMenuOpen(false);
      }
    };

    // Use boolean capture to ensure removeEventListener matches in all browsers.
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [walletMenuOpen]);

  useEffect(() => {
    if (!symbolMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (symbolMenuRef.current?.contains(target)) return;
      if (symbolMenuButtonRef.current?.contains(target)) return;
      setSymbolMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSymbolMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [symbolMenuOpen]);

  return (
    <div className={sidebarCollapsed ? 'workspace-lab-frame is-collapsed' : 'workspace-lab-frame'}>
      <aside id={sidebarId} className="workspace-lab-sidebar panel" aria-label="사이드바">
        <div className="workspace-lab-sidebar-head">
          <button
            type="button"
            className="workspace-lab-sidebar-toggle ghost-button"
            aria-controls={sidebarId}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? '사이드바 열기' : '사이드바 닫기'}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <span className="workspace-lab-brand-icon" aria-hidden>
              S
            </span>
            <span className="workspace-lab-open-icon" aria-hidden />
          </button>

          {!sidebarCollapsed ? (
            <button
              type="button"
              className="workspace-lab-sidebar-close ghost-button"
              aria-controls={sidebarId}
              aria-expanded={!sidebarCollapsed}
              aria-label="사이드바 닫기"
              onClick={() => setSidebarCollapsed(true)}
            >
              <span className="workspace-lab-arrow-icon is-left" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="workspace-lab-sidebar-body" aria-label="메뉴">
          <button
            type="button"
            className="workspace-lab-nav-item"
            aria-current={activeMain === 'dex' ? 'page' : undefined}
            onClick={handleActivateDex}
          >
            <span className="workspace-lab-nav-icon" aria-hidden />
            <span className="workspace-lab-nav-label">DEX 매매하기</span>
          </button>
        </div>
        <div className="workspace-lab-sidebar-footer" aria-label="지갑">
          {walletSession?.address ? (
            <div className="workspace-lab-wallet-shell">
              <button
                ref={walletMenuButtonRef}
                type="button"
                className="workspace-lab-wallet-chip ghost-button"
                aria-haspopup="menu"
                aria-expanded={walletMenuOpen}
                onClick={() => {
                  // When collapsed, keep interactions simple: expand sidebar first.
                  if (sidebarCollapsed) {
                    setSidebarCollapsed(false);
                    return;
                  }
                  setWalletMenuOpen((v) => !v);
                }}
              >
                <span className="workspace-lab-wallet-icon" aria-hidden />
                <strong className="workspace-lab-wallet-value">{formatWalletChip(walletSession.address)}</strong>
                <span className="workspace-lab-wallet-caret" aria-hidden />
              </button>

              {walletMenuOpen ? (
                <div ref={walletMenuRef} className="workspace-lab-wallet-menu panel" role="menu" aria-label="지갑 메뉴">
                  <button
                    type="button"
                    className="workspace-lab-wallet-menu-item"
                    role="menuitem"
                    onClick={() => void handleCopyAddress()}
                  >
                    주소 복사
                  </button>
                  <button
                    type="button"
                    className="workspace-lab-wallet-menu-item"
                    role="menuitem"
                    onClick={() => void handleSwitchWallet()}
                  >
                    지갑 전환
                  </button>
                  <div className="workspace-lab-wallet-menu-divider" role="separator" />
                  <button type="button" className="workspace-lab-wallet-menu-item is-danger" role="menuitem" onClick={handleDisconnectWallet}>
                    연결 해제
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button type="button" className="workspace-lab-wallet-connect" onClick={() => void handleConnectWallet()}>
              <span className="workspace-lab-wallet-connect-icon" aria-hidden />
              <span className="workspace-lab-wallet-label">지갑 연결</span>
            </button>
          )}
        </div>
      </aside>

      {isMobileViewport && !sidebarCollapsed ? (
        <button
          type="button"
          className="workspace-lab-mobile-scrim"
          aria-label="사이드바 닫기"
          onClick={() => setSidebarCollapsed(true)}
        />
      ) : null}

      <header className="workspace-lab-header panel" aria-label="헤더" onClick={handleContentAreaClick}>
        {isMobileViewport ? (
          <button
            type="button"
            className="workspace-lab-mobile-menu ghost-button"
            aria-controls={sidebarId}
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? '사이드바 열기' : '사이드바 닫기'}
            onClick={(event) => {
              event.stopPropagation();
              setSidebarCollapsed((value) => !value);
            }}
          >
            {sidebarCollapsed ? <span className="workspace-lab-open-icon is-visible" aria-hidden /> : <span className="workspace-lab-arrow-icon is-left" aria-hidden />}
          </button>
        ) : null}
        <div className="workspace-lab-header-fill">
          {isMobileViewport ? <strong className="workspace-lab-header-title">{activeMain === 'dex' ? 'DEX 매매하기' : 'Scribble Lab'}</strong> : null}
        </div>
      </header>

      <main className="workspace-lab-main" aria-label="메인 영역" onClick={handleContentAreaClick}>
        {activeMain === 'dex' ? (
          <div className={orderbookOpen ? 'workspace-lab-dex-layout is-orderbook-open' : 'workspace-lab-dex-layout'} aria-label="DEX 매매">
            <section className="workspace-lab-surface workspace-lab-chart" aria-label="차트">
              <div className="workspace-lab-chart-toolbar">
                <div className="workspace-lab-chart-toolbar-group">
                  <div className="workspace-lab-symbol-picker">
                    <button
                      ref={symbolMenuButtonRef}
                      type="button"
                      className="workspace-lab-symbol-trigger"
                      aria-haspopup="menu"
                      aria-expanded={symbolMenuOpen}
                      aria-label="거래 심볼 선택"
                      onClick={() => setSymbolMenuOpen((value) => !value)}
                    >
                      <span className="workspace-lab-symbol-trigger-main">
                        <span className="workspace-lab-market-icon" aria-hidden>
                          <MarketIcon asset={selectedMarket?.baseAsset ?? selectedSymbol.replace(/USDT$/i, '')} />
                        </span>
                        <span>{selectedSymbol}</span>
                      </span>
                      <span className={symbolMenuOpen ? 'workspace-lab-symbol-caret is-open' : 'workspace-lab-symbol-caret'} aria-hidden />
                    </button>

                    {symbolMenuOpen ? (
                      <div ref={symbolMenuRef} className="workspace-lab-wallet-menu panel workspace-lab-symbol-menu" role="menu" aria-label="심볼 목록">
                        {selectableMarkets.map((market) => (
                          <button
                            key={market.symbol}
                            type="button"
                            role="menuitemradio"
                            aria-checked={false}
                            className="workspace-lab-wallet-menu-item workspace-lab-symbol-option"
                            onClick={() => {
                              setSelectedSymbol(market.symbol);
                              setSymbolMenuOpen(false);
                            }}
                          >
                            <span className="workspace-lab-symbol-option-main">
                              <span className="workspace-lab-market-icon" aria-hidden>
                                <MarketIcon asset={market.baseAsset} />
                              </span>
                              <span>{market.symbol}</span>
                            </span>
                            <span>{market.baseAsset}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="workspace-lab-timeframe-group" role="tablist" aria-label="시간 프레임">
                    {(['15m', '1h', '4h'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={timeframe === value}
                        className={timeframe === value ? 'workspace-lab-timeframe-button is-active' : 'workspace-lab-timeframe-button'}
                        onClick={() => setTimeframe(value)}
                      >
                        {value === '15m' ? '15분' : value === '1h' ? '1시간' : '4시간'}
                      </button>
                    ))}
                  </div>
                </div>
                <StarBorder
                  as="button"
                  type="button"
                  className="workspace-lab-chart-ai-button"
                  color="rgba(244, 114, 182, 0.95)"
                  speed="7s"
                  thickness={1}
                  disabled={aiRequestPending}
                  onClick={() => void handleRequestAi()}
                >
                  {aiRequestPending ? '분석 중' : 'Scribble AI'}
                </StarBorder>
              </div>
              {chartLoading ? (
                <div className="workspace-lab-chart-state">실시간 차트를 불러오는 중입니다.</div>
              ) : chartError ? (
                <div className="workspace-lab-chart-state is-error">{chartError}</div>
              ) : marketData.length === 0 ? (
                <div className="workspace-lab-chart-state">표시할 차트 데이터가 없습니다.</div>
              ) : (
                <ChartCanvas
                  minimal
                  marketData={marketData}
                  annotations={annotations}
                  selectedAnnotationId={selectedAnnotationId}
                  selectedNewsInsightId={selectedNewsInsightId}
                  timeframe={timeframe}
                  drawingMode={drawingMode}
                  currentPrice={currentPrice}
                  annotationCreationLocked={!walletSession?.address}
                  aiRequestPending={aiRequestPending}
                  newsInsights={newsInsights}
                  onChangeMode={() => undefined}
                  onSelectAnnotation={handleSelectAnnotation}
                  onSelectNewsInsight={handleSelectNewsInsight}
                  onCreateAnnotation={() => undefined}
                  onAddLineToSelected={() => undefined}
                  onAddBoxToSelected={() => undefined}
                  onAddSegmentToSelected={() => undefined}
                  onRequestAi={handleRequestAi}
                  onNudgePrice={() => undefined}
                  onTriggerSelected={() => undefined}
                />
              )}
            </section>

            <aside className="workspace-lab-position-stack" aria-label="포지션 설정">
              <div className={orderbookOpen ? 'workspace-lab-orderbook-drawer is-open' : 'workspace-lab-orderbook-drawer'}>
                <button
                  type="button"
                  className={orderbookOpen ? 'workspace-lab-orderbook-tab is-open' : 'workspace-lab-orderbook-tab'}
                  aria-expanded={orderbookOpen}
                  aria-controls="workspace-lab-orderbook-card"
                  aria-label={orderbookOpen ? 'AI 결과 닫기' : 'AI 결과 열기'}
                  onClick={() => setOrderbookOpen((value) => !value)}
                >
                  <span className="workspace-lab-orderbook-tab-arrow" aria-hidden />
                </button>

                <div id="workspace-lab-orderbook-card" className="workspace-lab-surface workspace-lab-orderbook-card" aria-hidden={!orderbookOpen}>
                  {selectedNewsInsight ? (
                    <div className="workspace-lab-ai-result">
                      <div className="workspace-lab-panel-head">
                        <span>{selectedNewsInsight.category === 'global' ? '국제 뉴스' : '뉴스 인사이트'}</span>
                        <strong>
                          {selectedNewsInsight.category === 'global'
                            ? 'Global'
                            : selectedNewsInsight.direction === 'spike'
                              ? 'Spike'
                              : 'Crash'}
                        </strong>
                      </div>
                      <div className="workspace-lab-news-card">
                        <div className="workspace-lab-news-topline">
                          <span className={selectedNewsInsight.direction === 'spike' ? 'tone-up' : 'tone-down'}>
                            {selectedNewsInsight.category === 'global'
                              ? 'GLOBAL'
                              : `${selectedNewsInsight.direction === 'spike' ? '▲' : '▼'} ${Math.abs(selectedNewsInsight.priceChangePercent).toFixed(1)}%`}
                          </span>
                          <span>{formatNewsTime(selectedNewsInsight.time)}</span>
                        </div>
                        <strong>{selectedNewsInsight.headline}</strong>
                        <p>{selectedNewsInsight.summary}</p>
                        {selectedNewsInsight.sourceName || selectedNewsInsight.url ? (
                          <a href={selectedNewsInsight.url ?? undefined} target="_blank" rel="noreferrer">
                            {selectedNewsInsight.sourceName ?? '원문 보기'}
                          </a>
                        ) : null}
                      </div>
                      <div className="workspace-lab-ai-copy">
                        <span>AI comment</span>
                        <p>{selectedNewsInsight.aiComment}</p>
                      </div>
                      <div className="workspace-lab-ai-copy">
                        <span>Provider</span>
                        <p>{newsProvider ? `provider: ${newsProvider}` : newsLoading ? '뉴스 인사이트를 불러오는 중입니다.' : 'provider 정보가 없습니다.'}</p>
                      </div>
                    </div>
                  ) : selectedAnnotation && selectedStrategy ? (
                    <div className="workspace-lab-ai-result">
                      <div className="workspace-lab-panel-head">
                        <span>AI 분석 결과</span>
                        <strong>{selectedAnnotation.marketSymbol}</strong>
                      </div>
                      <div className="workspace-lab-snapshot-status">
                        <strong>{getSnapshotFreshness(selectedAnnotation, latestAnnotationId)}</strong>
                        <span>{formatRelativeAge(selectedAnnotation.createdAt)}</span>
                      </div>
                      <div className="workspace-lab-ai-result-grid">
                        <div>
                          <span>전략 방향</span>
                          <strong>{formatBias(selectedStrategy.bias)}</strong>
                        </div>
                        <div>
                          <span>진입 방식</span>
                          <strong>{formatEntryType(selectedStrategy.entryType)}</strong>
                        </div>
                        <div>
                          <span>진입가</span>
                          <strong>{formatStrategyPrice(selectedStrategy.entryPrice)}</strong>
                        </div>
                        <div>
                          <span>손절가</span>
                          <strong>{formatStrategyPrice(selectedStrategy.stopLossPrice)}</strong>
                        </div>
                        <div>
                          <span>익절가</span>
                          <strong>{selectedStrategy.takeProfitPrices.map(formatStrategyPrice).join(' / ') || '-'}</strong>
                        </div>
                        <div>
                          <span>신뢰도</span>
                          <strong>{formatConfidence(selectedStrategy.confidence)}</strong>
                        </div>
                      </div>
                      <div className="workspace-lab-ai-copy">
                        <span>Annotation</span>
                        <p>{selectedAnnotation.text}</p>
                      </div>
                      <div className="workspace-lab-ai-copy">
                        <span>Parsing notes</span>
                        <p>{selectedParsingNotes.length > 0 ? selectedParsingNotes.join(' · ') : 'provider 정보가 없습니다.'}</p>
                      </div>
                      {annotations.length > 1 ? (
                        <div className="workspace-lab-snapshot-list">
                          <span>Analysis history</span>
                          {annotations.slice(0, 4).map((annotation) => (
                            <button
                              key={annotation.annotationId}
                              type="button"
                              className={annotation.annotationId === selectedAnnotation.annotationId ? 'is-active' : ''}
                              onClick={() => handleSelectAnnotation(annotation.annotationId)}
                            >
                              <strong>{formatRelativeAge(annotation.createdAt)}</strong>
                              <em>{annotation.strategy.bias} · {formatStrategyPrice(annotation.strategy.entryPrice)}</em>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="workspace-lab-ai-empty">
                      <strong>선택된 스냅샷이 없습니다.</strong>
                      <p>Scribble AI 분석을 생성하거나 차트 위 AI/뉴스 marker를 선택하면 이 패널에 시점 고정 결과가 표시됩니다.</p>
                      <div className="workspace-lab-news-strip">
                        <span>{newsLoading ? '뉴스 로딩 중' : `${newsInsights.length} news signals`}</span>
                        {newsInsights.slice(0, 3).map((insight) => (
                          <button key={insight.insightId} type="button" onClick={() => handleSelectNewsInsight(insight.insightId)}>
                            {insight.category === 'global' ? 'GLOBAL' : insight.direction === 'spike' ? '▲' : '▼'} {insight.headline}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="workspace-lab-surface workspace-lab-position" key={selectedAnnotationId ?? 'empty-position'}>
                <div className="workspace-lab-panel-head">
                  <span>포지션</span>
                  {selectedAnnotation ? <strong>{selectedAnnotation.status}</strong> : null}
                </div>
                <div className="workspace-lab-form">
                  <label className="workspace-lab-field">
                    <span>방향</span>
                    <select defaultValue={selectedStrategy?.bias === 'bearish' ? 'short' : selectedStrategy?.bias === 'neutral' ? 'neutral' : 'long'}>
                      <option value="long">롱</option>
                      <option value="short">숏</option>
                      <option value="neutral">중립</option>
                    </select>
                  </label>
                  <label className="workspace-lab-field">
                    <span>레버리지</span>
                    <input type="number" min={1} max={50} defaultValue={selectedStrategy?.leverage ?? defaultUserSettings.leverage} />
                  </label>
                  <label className="workspace-lab-field">
                    <span>포지션 비율</span>
                    <input type="number" min={0} step="0.01" defaultValue={selectedStrategy?.positionSizeRatio ?? defaultUserSettings.defaultPositionSize} />
                  </label>
                  <label className="workspace-lab-field">
                    <span>주문</span>
                    <select defaultValue={selectedStrategy?.entryType ?? 'market'}>
                      <option value="market">시장가</option>
                      <option value="limit">지정가</option>
                      <option value="conditional">조건부</option>
                    </select>
                  </label>
                  <label className="workspace-lab-field">
                    <span>진입가</span>
                    <input type="number" min={0} step="0.01" defaultValue={selectedStrategy?.entryPrice ?? currentPrice} />
                  </label>
                  <label className="workspace-lab-field">
                    <span>손절가</span>
                    <input type="number" min={0} step="0.01" defaultValue={selectedStrategy?.stopLossPrice ?? currentPrice * 0.98} />
                  </label>
                  <label className="workspace-lab-field workspace-lab-field-wide">
                    <span>익절가</span>
                    <input type="text" defaultValue={selectedStrategy?.takeProfitPrices.map(formatStrategyPrice).join(', ') ?? ''} />
                  </label>
                  <button type="button" className="workspace-lab-primary" disabled={!walletSession?.address}>
                    {walletSession?.address ? '주문 준비' : '지갑 연결 필요'}
                  </button>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="workspace-lab-main-empty" aria-hidden />
        )}
      </main>
    </div>
  );
}
