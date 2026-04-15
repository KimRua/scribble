const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function isValidTxHash(value: unknown): value is string {
  return typeof value === 'string' && TX_HASH_REGEX.test(value.trim());
}

export function normalizeTxHash(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return isValidTxHash(trimmed) ? trimmed : null;
}
