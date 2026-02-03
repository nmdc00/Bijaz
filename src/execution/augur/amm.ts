import { ethers } from 'ethers';
import { AUGUR_TURBO_ADDRESSES } from './constants.js';

const AMM_FACTORY_ABI = [
  'function buy(address marketFactory, uint256 marketId, uint256 outcome, uint256 collateralIn, uint256 minShares) external returns (uint256)',
  'function sell(address marketFactory, uint256 marketId, uint256 outcome, uint256 sharesToSell, uint256 minCollateral) external returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

export class AugurAMMTrader {
  private wallet: ethers.Wallet;
  private ammFactory: ethers.Contract;
  private usdc: ethers.Contract;

  constructor(wallet: ethers.Wallet) {
    this.wallet = wallet;
    this.ammFactory = new ethers.Contract(
      AUGUR_TURBO_ADDRESSES.ammFactory,
      AMM_FACTORY_ABI,
      wallet
    );
    this.usdc = new ethers.Contract(AUGUR_TURBO_ADDRESSES.USDC, ERC20_ABI, wallet);
  }

  async approveUsdc(amount: ethers.BigNumber): Promise<ethers.ContractTransaction> {
    return this.usdc.approve(AUGUR_TURBO_ADDRESSES.ammFactory, amount);
  }

  async allowance(): Promise<ethers.BigNumber> {
    return this.usdc.allowance(this.wallet.address, AUGUR_TURBO_ADDRESSES.ammFactory);
  }

  async balance(): Promise<ethers.BigNumber> {
    return this.usdc.balanceOf(this.wallet.address);
  }

  async buy(params: {
    marketFactory: string;
    marketId: number;
    outcome: number;
    collateralIn: string;
    minShares: string;
  }): Promise<ethers.ContractTransaction> {
    return this.ammFactory.buy(
      params.marketFactory,
      params.marketId,
      params.outcome,
      params.collateralIn,
      params.minShares
    );
  }

  async sell(params: {
    marketFactory: string;
    marketId: number;
    outcome: number;
    sharesToSell: string;
    minCollateral: string;
  }): Promise<ethers.ContractTransaction> {
    return this.ammFactory.sell(
      params.marketFactory,
      params.marketId,
      params.outcome,
      params.sharesToSell,
      params.minCollateral
    );
  }
}
