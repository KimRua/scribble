import type { MarketOption } from '../types/domain';

interface HeaderBarProps {
  selectedSymbol: string;
  timeframe: string;
  connectionStatus: 'connected' | 'disconnected';
  markets: MarketOption[];
  onChangeSymbol: (symbol: string) => void;
  onChangeTimeframe: (timeframe: string) => void;
  onToggleNotifications: () => void;
  onToggleStrategies: () => void;
}

const timeframes = ['15m', '1h', '4h'];

export function HeaderBar(props: HeaderBarProps) {
  const {
    selectedSymbol,
    timeframe,
    connectionStatus,
    markets,
    onChangeSymbol,
    onChangeTimeframe,
    onToggleNotifications,
    onToggleStrategies
  } = props;

  return (
    <header className="header-bar panel">
      <div className="header-brand">
        <div className="header-brand-mark">S</div>
        <div className="header-copy">
          <div className="header-copy-top">
            <p className="eyebrow">Scribble</p>
            <span className="header-divider">·</span>
            <span className="header-mode">Trading Workspace</span>
          </div>
          <h1>차트 주석 기반 트레이딩 코파일럿</h1>
          <p className="header-subtitle">주석 작성부터 전략 검증, 실행까지 한 흐름으로 관리합니다.</p>
        </div>
      </div>
      <div className="header-controls">
        <div className="header-fields">
          <label className="header-field">
            <span>마켓</span>
            <select value={selectedSymbol} onChange={(event) => onChangeSymbol(event.target.value)}>
              {markets.map((market) => (
                <option key={market.symbol} value={market.symbol}>
                  {market.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="header-field">
            <span>타임프레임</span>
            <select value={timeframe} onChange={(event) => onChangeTimeframe(event.target.value)}>
              {timeframes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="header-meta">
          <div className={`status-badge ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '연결됨' : '연결 끊김'}
          </div>
          <div className="header-shortcuts">
            <button className="ghost-button" onClick={onToggleNotifications}>
              알림
            </button>
            <button className="ghost-button" onClick={onToggleStrategies}>
              내 전략
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
