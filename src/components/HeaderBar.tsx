import type { MarketOption } from '../types/domain';

interface HeaderBarProps {
  selectedSymbol: string;
  timeframe: string;
  markets: MarketOption[];
  walletAddress: string | null;
  onChangeSymbol: (symbol: string) => void;
  onChangeTimeframe: (timeframe: string) => void;
  onToggleNotifications: () => void;
  onToggleStrategies: () => void;
  onConnectWallet: () => void;
  onSwitchWallet: () => void;
  onDisconnectWallet: () => void;
}

const timeframes = ['15m', '1h', '4h'];

export function HeaderBar(props: HeaderBarProps) {
  const {
    selectedSymbol,
    timeframe,
    markets,
    walletAddress,
    onChangeSymbol,
    onChangeTimeframe,
    onToggleNotifications,
    onToggleStrategies,
    onConnectWallet,
    onSwitchWallet,
    onDisconnectWallet
  } = props;

  return (
    <header className="header-bar panel">
      <div className="header-brand">
        <div className="header-brand-mark">S</div>
        <div className="header-copy">
          <div className="header-copy-top">
            <p className="eyebrow">Scribble Workspace</p>
            <span className="header-divider">·</span>
            <span className="header-mode">지갑 기반 트레이딩</span>
          </div>
          <strong className="header-title">{selectedSymbol}</strong>
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
          {walletAddress ? (
            <div className="header-wallet-chip">
              <span>연결 지갑</span>
              <strong>{walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</strong>
            </div>
          ) : (
            <div className="header-wallet-chip header-wallet-chip-muted">
              <span>지갑 상태</span>
              <strong>미연결</strong>
            </div>
          )}
        </div>

        <div className="header-wallet-actions">
          {walletAddress ? (
            <>
              <button className="secondary header-wallet-button" onClick={onSwitchWallet}>
                지갑 전환
              </button>
              <button className="ghost-button header-wallet-button" onClick={onDisconnectWallet}>
                연결 해제
              </button>
            </>
          ) : (
            <button className="secondary header-wallet-button" onClick={onConnectWallet}>
              지갑 연결
            </button>
          )}
        </div>

        <div className="header-shortcuts">
          <button className="ghost-button" onClick={onToggleNotifications}>
            알림
          </button>
          <button className="ghost-button" onClick={onToggleStrategies}>
            전략
          </button>
        </div>
      </div>
    </header>
  );
}
