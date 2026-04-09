import { BrowserProvider } from 'ethers';
import type { WalletSession } from '../types/domain';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

async function buildSession(): Promise<WalletSession | null> {
  if (!window.ethereum) {
    return null;
  }

  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return {
    address: await signer.getAddress(),
    chainId: Number(network.chainId)
  };
}

export async function connectInjectedWallet() {
  if (!window.ethereum) {
    throw new Error('브라우저 지갑이 감지되지 않았습니다. MetaMask를 설치하거나 활성화해 주세요.');
  }

  await window.ethereum.request({ method: 'eth_requestAccounts' });
  return buildSession();
}

export async function getInjectedWalletSession() {
  if (!window.ethereum) {
    return null;
  }

  const accounts = (await window.ethereum.request({ method: 'eth_accounts' })) as string[];
  if (!accounts.length) {
    return null;
  }

  return buildSession();
}
