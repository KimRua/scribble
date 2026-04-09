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
      <div>
        <p className="eyebrow">Scribble</p>
        <h1>차트 주석 기반 트레이딩 코파일럿</h1>
      </div>
      <div className="header-controls">
        <label>
          <span>마켓</span>
          <select value={selectedSymbol} onChange={(event) => onChangeSymbol(event.target.value)}>
            {markets.map((market) => (
              <option key={market.symbol} value={market.symbol}>
                {market.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>타임프레임</span>
          <select value={timeframe} onChange={(event) => onChangeTimeframe(event.target.value)}>
            {timeframes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className={`status-badge ${connectionStatus}`}>
          {connectionStatus === 'connected' ? '연결됨' : '연결 끊김'}
        </div>
        <button className="ghost-button" onClick={onToggleNotifications}>
          알림
        </button>
        <button className="ghost-button" onClick={onToggleStrategies}>
          내 전략
        </button>
      </div>
    </header>
  );
}
