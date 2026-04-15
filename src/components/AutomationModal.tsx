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
        ? 'Only a 64-byte hex tx hash starting with 0x can be saved.'
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
      normalizeTxHash(value) ? null : 'Only a 64-byte hex tx hash starting with 0x can be saved.'
    );
  };

  const handleSave = () => {
    const normalizedApprovalTxHash = form.approvalTxHash.trim();

    if (normalizedApprovalTxHash && !normalizeTxHash(normalizedApprovalTxHash)) {
      setApprovalTxHashError('Only a 64-byte hex tx hash starting with 0x can be saved.');
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
            <h3>Auto-execution rules</h3>
          </div>
          <button className="ghost-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>Max position ratio</span>
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
            <span>Max leverage</span>
            <input
              type="number"
              min="1"
              max="10"
              value={form.maxLeverage}
              onChange={(event) => setForm((prev) => ({ ...prev, maxLeverage: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>Max loss ratio</span>
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
            <span>Daily execution cap</span>
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
          <strong>Wallet delegation status</strong>
          <p>
            {connectedWalletAddress
              ? `Automation permissions will be granted for wallet ${connectedWalletAddress.slice(0, 6)}...${connectedWalletAddress.slice(-4)}.`
              : 'Connect a wallet first to enable automation.'}
          </p>
          <div className="delegation-meta">
            <span>Executor {executorAddress ? `${executorAddress.slice(0, 6)}...${executorAddress.slice(-4)}` : 'Not set'}</span>
            <span>Vault {vaultAddress ? `${vaultAddress.slice(0, 6)}...${vaultAddress.slice(-4)}` : 'Not initialized'}</span>
            <span>Status {delegatedPolicy?.status ?? 'not_configured'}</span>
          </div>
          {!connectedWalletAddress ? (
            <button className="secondary" onClick={onConnectWallet}>
              Connect wallet
            </button>
          ) : null}
        </div>
        <div className="form-grid">
          <label>
            <span>Max order size (USD)</span>
            <input
              type="number"
              min="10"
              step="10"
              value={form.maxOrderSizeUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, maxOrderSizeUsd: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>Max slippage (bps)</span>
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
            <span>Daily loss cap (USD)</span>
            <input
              type="number"
              min="10"
              step="10"
              value={form.dailyLossLimitUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, dailyLossLimitUsd: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>Permission expiry</span>
            <input
              type="datetime-local"
              value={form.validUntil}
              onChange={(event) => setForm((prev) => ({ ...prev, validUntil: event.target.value }))}
            />
          </label>
          <label className="form-span-2">
            <span>Approval transaction hash (optional)</span>
            <input
              type="text"
              placeholder="Save the tx hash after onchain approval completes"
              value={form.approvalTxHash}
              onChange={(event) => handleApprovalTxHashChange(event.target.value)}
            />
            {approvalTxHashError ? <small className="muted">{approvalTxHashError}</small> : null}
          </label>
        </div>
        <div className="warning-box">
          <strong>Trigger condition</strong>
          <p>Execution only proceeds when price reaches {selectedAnnotation.strategy.entryPrice} and all guardrails plus delegation limits pass.</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={!connectedWalletAddress || Boolean(approvalTxHashError)} onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
