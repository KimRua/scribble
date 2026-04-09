import { Contract, JsonRpcProvider, MaxUint256, Wallet, getAddress, parseUnits } from 'ethers';
import type { Strategy } from '../../src/types/domain';

const uniswapV2RouterAbi = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) returns (uint256[] memory amounts)'
];

const erc20Abi = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
];

export interface DexExecutionConfigStatus {
  enabled: boolean;
  ready: boolean;
  missing: string[];
}

export interface DexMarketConfig {
  baseTokenAddress: string;
  quoteTokenAddress: string;
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
  buyAmount: string;
  sellAmount?: string;
  buyPath?: string[];
  sellPath?: string[];
}

export type DexMarketMap = Record<string, DexMarketConfig>;

export interface DexSwapPlan {
  marketSymbol: string;
  side: 'buy' | 'sell';
  inputTokenAddress: string;
  outputTokenAddress: string;
  inputDecimals: number;
  outputDecimals: number;
  amountIn: bigint;
  amountInDisplay: string;
  path: string[];
}

export interface DexExecutionReceipt {
  enabled: boolean;
  ready: boolean;
  executed: boolean;
  routerAddress?: string;
  txHash?: string | null;
  inputTokenAddress?: string | null;
  outputTokenAddress?: string | null;
  amountIn?: string | null;
  expectedAmountOut?: string | null;
  minimumAmountOut?: string | null;
}

export function parseDexMarketMap(raw = process.env.DEX_MARKET_MAP_JSON): DexMarketMap {
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as DexMarketMap;
  return Object.fromEntries(
    Object.entries(parsed).map(([symbol, config]) => [
      symbol,
      {
        ...config,
        baseTokenAddress: getAddress(config.baseTokenAddress),
        quoteTokenAddress: getAddress(config.quoteTokenAddress),
        buyPath: config.buyPath?.map((value) => getAddress(value)),
        sellPath: config.sellPath?.map((value) => getAddress(value))
      }
    ])
  );
}

export function getDexExecutionConfigStatus(): DexExecutionConfigStatus {
  const enabled = (process.env.ENABLE_DEX_EXECUTION ?? 'false').toLowerCase() === 'true';
  const required = {
    BSC_RPC_URL: process.env.BSC_RPC_URL,
    EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
    DEX_ROUTER_ADDRESS: process.env.DEX_ROUTER_ADDRESS,
    DEX_MARKET_MAP_JSON: process.env.DEX_MARKET_MAP_JSON
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    enabled,
    ready: enabled && missing.length === 0,
    missing
  };
}

export function resolveDexSwapPlan(strategy: Strategy, marketSymbol: string, marketMap: DexMarketMap = parseDexMarketMap()): DexSwapPlan {
  const marketConfig = marketMap[marketSymbol];
  if (!marketConfig) {
    throw new Error(`dex market config not found for ${marketSymbol}`);
  }

  if (strategy.bias === 'neutral') {
    throw new Error('neutral strategy cannot be executed as a spot dex swap');
  }

  if (strategy.bias === 'bullish') {
    return {
      marketSymbol,
      side: 'buy',
      inputTokenAddress: marketConfig.quoteTokenAddress,
      outputTokenAddress: marketConfig.baseTokenAddress,
      inputDecimals: marketConfig.quoteTokenDecimals,
      outputDecimals: marketConfig.baseTokenDecimals,
      amountIn: parseUnits(marketConfig.buyAmount, marketConfig.quoteTokenDecimals),
      amountInDisplay: marketConfig.buyAmount,
      path: marketConfig.buyPath ?? [marketConfig.quoteTokenAddress, marketConfig.baseTokenAddress]
    };
  }

  const sellAmount = marketConfig.sellAmount ?? marketConfig.buyAmount;
  return {
    marketSymbol,
    side: 'sell',
    inputTokenAddress: marketConfig.baseTokenAddress,
    outputTokenAddress: marketConfig.quoteTokenAddress,
    inputDecimals: marketConfig.baseTokenDecimals,
    outputDecimals: marketConfig.quoteTokenDecimals,
    amountIn: parseUnits(sellAmount, marketConfig.baseTokenDecimals),
    amountInDisplay: sellAmount,
    path: marketConfig.sellPath ?? [marketConfig.baseTokenAddress, marketConfig.quoteTokenAddress]
  };
}

function getDexExecutionContext() {
  const provider = new JsonRpcProvider(process.env.BSC_RPC_URL);
  const wallet = new Wallet(process.env.EXECUTOR_PRIVATE_KEY!, provider);
  const routerAddress = getAddress(process.env.DEX_ROUTER_ADDRESS!);
  const router = new Contract(routerAddress, uniswapV2RouterAbi, wallet);
  return { provider, wallet, routerAddress, router };
}

export async function executeDexSwap(strategy: Strategy, marketSymbol: string): Promise<DexExecutionReceipt> {
  const status = getDexExecutionConfigStatus();
  if (!status.enabled || !status.ready) {
    return {
      enabled: status.enabled,
      ready: status.ready,
      executed: false
    };
  }

  const plan = resolveDexSwapPlan(strategy, marketSymbol);
  const { wallet, router, routerAddress } = getDexExecutionContext();
  const walletAddress = await wallet.getAddress();
  const inputToken = new Contract(plan.inputTokenAddress, erc20Abi, wallet);

  const balance = (await inputToken.balanceOf(walletAddress)) as bigint;
  if (balance < plan.amountIn) {
    throw new Error(`insufficient token balance for dex swap: need ${plan.amountInDisplay} of ${plan.inputTokenAddress}`);
  }

  const allowance = (await inputToken.allowance(walletAddress, routerAddress)) as bigint;
  if (allowance < plan.amountIn) {
    const approveTx = await inputToken.approve(routerAddress, MaxUint256);
    await approveTx.wait();
  }

  const amountsOut = (await router.getAmountsOut(plan.amountIn, plan.path)) as bigint[];
  const expectedAmountOut = amountsOut.at(-1);
  if (!expectedAmountOut) {
    throw new Error('dex router did not return an output amount');
  }

  const slippageBps = Number(process.env.DEX_SLIPPAGE_BPS ?? 100);
  const deadlineSeconds = Number(process.env.DEX_DEADLINE_SECONDS ?? 300);
  const minimumAmountOut = (expectedAmountOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const swapTx = await router.swapExactTokensForTokens(
    plan.amountIn,
    minimumAmountOut,
    plan.path,
    walletAddress,
    Math.floor(Date.now() / 1000) + deadlineSeconds
  );
  await swapTx.wait();

  return {
    enabled: true,
    ready: true,
    executed: true,
    routerAddress,
    txHash: swapTx.hash as string,
    inputTokenAddress: plan.inputTokenAddress,
    outputTokenAddress: plan.outputTokenAddress,
    amountIn: plan.amountInDisplay,
    expectedAmountOut: expectedAmountOut.toString(),
    minimumAmountOut: minimumAmountOut.toString()
  };
}