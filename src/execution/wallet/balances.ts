import { ethers } from 'ethers';

import type { Balance } from '../../types/index.js';

const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export async function getWalletBalances(wallet: ethers.Wallet): Promise<Balance | null> {
  if (!wallet.provider) {
    return null;
  }

  const [matic, usdc] = await Promise.all([
    wallet.provider.getBalance(wallet.address),
    getTokenBalance(wallet, USDC_ADDRESS),
  ]);

  return {
    matic: Number(ethers.utils.formatEther(matic)),
    usdc: usdc ?? 0,
    usdcAddress: USDC_ADDRESS,
  };
}

async function getTokenBalance(wallet: ethers.Wallet, token: string): Promise<number | null> {
  if (!wallet.provider) return null;

  const contract = new ethers.Contract(token, ERC20_ABI, wallet.provider);
  const [raw, decimals] = await Promise.all([contract.balanceOf(wallet.address), contract.decimals()]);
  return Number(ethers.utils.formatUnits(raw, decimals));
}
