import { useEffect, useState } from 'react';
import type { Annotation, AutomationRule, DelegatedAutomationPolicy } from '../types/domain';
import { normalizeTxHash } from '../utils/txHash';

interface AutomationModalProps {
  open: boolean;
  selectedAnnotation: Annotation | null;
  automation: AutomationRule | null;
  connectedWalletAddress: string | null;
  delegatedPolicy: DelegatedAutomationPolicy | null;
  executorAddress: string | null;
  vaultAddress: string | null;
  onClose: () => void;
  onConnectWallet: () => void;
  onSave: (config: {
    maxPositionSizeRatio: number;
    maxLeverage: number;
    maxLossRatio: number;
    maxDailyExecutions: number;
    maxOrderSizeUsd: number;
    maxSlippageBps: number;
    dailyLossLimitUsd: number;
    validUntil: string;
    approvalTxHash?: string | null;
  }) => void;
}

export function AutomationModal({
  open,
  selectedAnnotation,
  automation,
  connectedWalletAddress,
  delegatedPolicy,
  executorAddress,
  vaultAddress,
  onClose,
  onConnectWallet,
  onSave
}: AutomationModalProps) {
  const [approvalTxHashError, setApprovalTxHashError] = useState<string | null>(null);
  const [form, setForm] = useState({
    maxPositionSizeRatio: 0.1,
    maxLeverage: 2,
    maxLossRatio: 0.05,
    maxDailyExecutions: 3,
    maxOrderSizeUsd: 500,
    maxSlippageBps: 100,
    dailyLossLimitUsd: 150,
    validUntil: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 16),
    approvalTxHash: ''
  });

  useEffect(() => {
    const nextApprovalTxHash = delegatedPolicy?.approvalTxHash ?? '';

    if (automation || delegatedPolicy) {
      setForm({
        maxPositionSizeRatio: automation?.maxPositionSizeRatio ?? 0.1,
        maxLeverage: automation?.maxLeverage ?? 2,
        maxLossRatio: automation?.maxLossRatio ?? 0.05,
        maxDailyExecutions: automation?.maxDailyExecutions ?? 3,
        maxOrderSizeUsd: delegatedPolicy?.maxOrderSizeUsd ?? 500,
        maxSlippageBps: delegatedPolicy?.maxSlippageBps ?? 100,
        dailyLossLimitUsd: delegatedPolicy?.dailyLossLimitUsd ?? 150,
        validUntil:
          delegatedPolicy?.validUntil?.slice(0, 16) ??
          new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 16),
        approvalTxHash: nextApprovalTxHash
      });
    }

    setApprovalTxHashError(
      nextApprovalTxHash && !normalizeTxHash(nextApprovalTxHash)
        ? '0x로 시작하는 64자리 16진수 Tx hash만 저장할 수 있습니다.'
        : null
    );
  }, [automation, delegatedPolicy]);

  const handleApprovalTxHashChange = (value: string) => {
    setForm((prev) => ({ ...prev, approvalTxHash: value }));

    if (!value.trim()) {
      setApprovalTxHashError(null);
      return;
    }

    setApprovalTxHashError(
      normalizeTxHash(value) ? null : '0x로 시작하는 64자리 16진수 Tx hash만 저장할 수 있습니다.'
    );
  };

  const handleSave = () => {
    const normalizedApprovalTxHash = form.approvalTxHash.trim();

    if (normalizedApprovalTxHash && !normalizeTxHash(normalizedApprovalTxHash)) {
      setApprovalTxHashError('0x로 시작하는 64자리 16진수 Tx hash만 저장할 수 있습니다.');
      return;
    }

    onSave({
      ...form,
      approvalTxHash: normalizedApprovalTxHash || null
    });
  };

  if (!open || !selectedAnnotation) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal panel">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Automation</p>
            <h3>자동 실행 설정</h3>
          </div>
          <button className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>최대 포지션 비율</span>
            <input
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              value={form.maxPositionSizeRatio}
              onChange={(event) => setForm((prev) => ({ ...prev, maxPositionSizeRatio: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>최대 레버리지</span>
            <input
              type="number"
              min="1"
              max="10"
              value={form.maxLeverage}
              onChange={(event) => setForm((prev) => ({ ...prev, maxLeverage: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>최대 손실 비율</span>
            <input
              type="number"
              min="0.01"
              max="0.2"
              step="0.01"
              value={form.maxLossRatio}
              onChange={(event) => setForm((prev) => ({ ...prev, maxLossRatio: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>1일 최대 실행 횟수</span>
            <input
              type="number"
              min="1"
              max="10"
              value={form.maxDailyExecutions}
              onChange={(event) => setForm((prev) => ({ ...prev, maxDailyExecutions: Number(event.target.value) }))}
            />
          </label>
        </div>
        <div className="info-banner delegation-banner">
          <strong>지갑 위임 상태</strong>
          <p>
            {connectedWalletAddress
              ? `연결된 지갑 ${connectedWalletAddress.slice(0, 6)}...${connectedWalletAddress.slice(-4)} 에 자동거래 권한을 설정합니다.`
              : '자동거래를 사용하려면 먼저 지갑을 연결해야 합니다.'}
          </p>
          <div className="delegation-meta">
            <span>Executor {executorAddress ? `${executorAddress.slice(0, 6)}...${executorAddress.slice(-4)}` : '미설정'}</span>
            <span>Vault {vaultAddress ? `${vaultAddress.slice(0, 6)}...${vaultAddress.slice(-4)}` : '초기화 전'}</span>
            <span>상태 {delegatedPolicy?.status ?? 'not_configured'}</span>
          </div>
          {!connectedWalletAddress ? (
            <button className="secondary" onClick={onConnectWallet}>
              지갑 연결하기
            </button>
          ) : null}
        </div>
        <div className="form-grid">
          <label>
            <span>최대 주문 금액 (USD)</span>
            <input
              type="number"
              min="10"
              step="10"
              value={form.maxOrderSizeUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, maxOrderSizeUsd: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>최대 슬리피지 (bps)</span>
            <input
              type="number"
              min="10"
              max="1000"
              step="10"
              value={form.maxSlippageBps}
              onChange={(event) => setForm((prev) => ({ ...prev, maxSlippageBps: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>일일 손실 한도 (USD)</span>
            <input
              type="number"
              min="10"
              step="10"
              value={form.dailyLossLimitUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, dailyLossLimitUsd: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>권한 만료 시각</span>
            <input
              type="datetime-local"
              value={form.validUntil}
              onChange={(event) => setForm((prev) => ({ ...prev, validUntil: event.target.value }))}
            />
          </label>
          <label className="form-span-2">
            <span>승인 트랜잭션 해시 (선택)</span>
            <input
              type="text"
              placeholder="온체인 승인 완료 후 tx hash를 저장"
              value={form.approvalTxHash}
              onChange={(event) => handleApprovalTxHashChange(event.target.value)}
            />
            {approvalTxHashError ? <small className="muted">{approvalTxHashError}</small> : null}
          </label>
        </div>
        <div className="warning-box">
          <strong>생성 조건</strong>
          <p>{selectedAnnotation.strategy.entryPrice} 도달 시 가드레일과 위임 한도를 모두 통과해야 실행됩니다.</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            취소
          </button>
          <button disabled={!connectedWalletAddress || Boolean(approvalTxHashError)} onClick={handleSave}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
