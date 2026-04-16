import { BrowserProvider, formatEther } from 'ethers';
import type { WalletSession } from '../types/domain';

function resolveNativeSymbol(chainId: number) {
  if (chainId === 97 || chainId === 5611) {
    return 'tBNB';
  }

  if (chainId === 56 || chainId === 204) {
    return 'BNB';
  }

  return 'Native';
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

interface ProviderRequestError {
  code?: number;
  message?: string;
}

function isUserRejectedRequest(error: unknown) {
  return typeof error === 'object' && error !== null && (error as ProviderRequestError).code === 4001;
}

async function requestAccountSelection() {
  if (!window.ethereum) {
    throw new Error('No browser wallet detected. Please install or enable MetaMask.');
  }

  try {
    await window.ethereum.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }]
    });
    return;
  } catch (error) {
    if (isUserRejectedRequest(error)) {
      throw new Error('Wallet connection was cancelled.');
    }
  }

  try {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
  } catch (error) {
    if (isUserRejectedRequest(error)) {
      throw new Error('Wallet connection was cancelled.');
    }

    throw error;
  }
}

async function buildSession(): Promise<WalletSession | null> {
  if (!window.ethereum) {
    return null;
  }

  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  const address = await signer.getAddress();
  const nativeBalance = await provider.getBalance(address);
  return {
    address,
    chainId: Number(network.chainId),
    nativeBalance: Number(formatEther(nativeBalance)),
    nativeSymbol: resolveNativeSymbol(Number(network.chainId))
  };
}

export async function getInjectedProvider() {
  if (!window.ethereum) {
    throw new Error('No browser wallet detected. Please install or enable MetaMask.');
  }

  return new BrowserProvider(window.ethereum);
}

export async function getInjectedSigner() {
  const provider = await getInjectedProvider();
  return provider.getSigner();
}

export async function connectInjectedWallet() {
  await requestAccountSelection();
  return buildSession();
}

export async function switchInjectedWallet() {
  await requestAccountSelection();
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

export function subscribeInjectedWalletSession(onChange: (session: WalletSession | null) => void) {
  if (!window.ethereum?.on) {
    return () => undefined;
  }

  const handleChange = () => {
    void getInjectedWalletSession()
      .then(onChange)
      .catch(() => onChange(null));
  };

  window.ethereum.on('accountsChanged', handleChange);
  window.ethereum.on('chainChanged', handleChange);

  return () => {
    window.ethereum?.removeListener?.('accountsChanged', handleChange);
    window.ethereum?.removeListener?.('chainChanged', handleChange);
  };
}
