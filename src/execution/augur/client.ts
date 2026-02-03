import fetch from 'node-fetch';
import { ethers } from 'ethers';

import type { ThufirConfig } from '../../core/config.js';
import { AUGUR_SUBGRAPH_DEFAULT, AUGUR_TURBO_ADDRESSES } from './constants.js';

export interface AugurMarket {
  id: string;
  marketFactory: string;
  marketIndex: number;
  type: 'crypto' | 'sports' | 'mma';
  endTime: number;
  outcomes: string[];
  shareTokens: string[];
  prices: number[];
  winner?: string;
  coinIndex?: number;
  creationPrice?: number;
  marketType?: string;
}

export interface AugurPosition {
  marketId: string;
  outcome: string;
  shares: string;
  avgPrice: number;
  costBasis: number;
  open: boolean;
}

type SubgraphMarket = {
  id: string;
  marketFactory: string;
  marketIndex: string;
  cryptoMarket?: {
    coinIndex: string;
    creationPrice: string;
    endTime: string;
    marketType: string;
    shareTokens: string[];
    winner?: string | null;
    initialOdds?: string[] | null;
  } | null;
  teamSportsMarket?: {
    endTime: string;
    shareTokens: string[];
    winner?: string | null;
  } | null;
  mmaMarket?: {
    endTime: string;
    shareTokens: string[];
    winner?: string | null;
  } | null;
};

const FETCHER_ABI = [
  'function getMarketPrices(uint256 marketId) external view returns (uint256[] memory)',
];

export class AugurTurboClient {
  private subgraphUrl: string;
  private provider: ethers.providers.Provider;
  private fetcherContracts: Record<string, ethers.Contract> = {};

  constructor(config: ThufirConfig, provider: ethers.providers.Provider) {
    this.subgraphUrl = config.augur?.subgraph ?? AUGUR_SUBGRAPH_DEFAULT;
    this.provider = provider;
  }

  async getMarkets(options?: { type?: string; limit?: number; skip?: number }): Promise<AugurMarket[]> {
    const limit = options?.limit ?? 20;
    const skip = options?.skip ?? 0;
    const query = `
      query GetMarkets($first: Int!, $skip: Int!) {
        markets(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
          id
          marketFactory
          marketIndex
          cryptoMarket {
            coinIndex
            creationPrice
            endTime
            marketType
            shareTokens
            winner
            initialOdds
          }
          teamSportsMarket {
            endTime
            shareTokens
            winner
          }
          mmaMarket {
            endTime
            shareTokens
            winner
          }
        }
      }
    `;
    const data = await this.querySubgraph<{ markets: SubgraphMarket[] }>(query, {
      first: limit,
      skip,
    });

    const normalized = data.markets.map((raw) => this.normalizeMarket(raw));
    if (options?.type) {
      return normalized.filter((m) => m.type === options.type);
    }
    return normalized;
  }

  async getMarket(id: string): Promise<AugurMarket | null> {
    const query = `
      query GetMarket($id: ID!) {
        market(id: $id) {
          id
          marketFactory
          marketIndex
          cryptoMarket {
            coinIndex
            creationPrice
            endTime
            marketType
            shareTokens
            winner
            initialOdds
          }
          teamSportsMarket {
            endTime
            shareTokens
            winner
          }
          mmaMarket {
            endTime
            shareTokens
            winner
          }
        }
      }
    `;
    const data = await this.querySubgraph<{ market: SubgraphMarket | null }>(query, { id });
    if (!data.market) return null;
    return this.normalizeMarket(data.market);
  }

  async getPositions(address: string): Promise<AugurPosition[]> {
    const query = `
      query GetUserPositions($user: String!) {
        sender(id: $user) {
          positionBalance {
            marketId
            outcomeId
            shares
            avgPrice
            initCostUsd
            open
          }
        }
      }
    `;
    const data = await this.querySubgraph<{
      sender: {
        positionBalance: Array<{
          marketId: string;
          outcomeId: string;
          shares: string;
          avgPrice: string;
          initCostUsd: string;
          open: boolean;
        }>;
      } | null;
    }>(query, { user: address.toLowerCase() });

    if (!data.sender?.positionBalance) return [];
    return data.sender.positionBalance.map((pos) => ({
      marketId: pos.marketId,
      outcome: pos.outcomeId,
      shares: pos.shares,
      avgPrice: Number(pos.avgPrice),
      costBasis: Number(pos.initCostUsd),
      open: pos.open,
    }));
  }

  async getPrices(marketType: 'crypto' | 'sports' | 'mma', marketId: number): Promise<number[]> {
    const fetcher = this.getFetcher(marketType);
    const raw = (await fetcher.getMarketPrices(marketId)) as ethers.BigNumber[];
    if (!Array.isArray(raw) || raw.length === 0) {
      return [];
    }
    return raw.map((value) => Number(ethers.utils.formatUnits(value, 18)));
  }

  private getFetcher(marketType: 'crypto' | 'sports' | 'mma'): ethers.Contract {
    const key = marketType;
    if (this.fetcherContracts[key]) {
      return this.fetcherContracts[key];
    }
    const address =
      marketType === 'crypto'
        ? AUGUR_TURBO_ADDRESSES.fetchers.crypto
        : AUGUR_TURBO_ADDRESSES.fetchers.sports;
    const contract = new ethers.Contract(address, FETCHER_ABI, this.provider);
    this.fetcherContracts[key] = contract;
    return contract;
  }

  private normalizeMarket(raw: SubgraphMarket): AugurMarket {
    const isCrypto = raw.cryptoMarket != null;
    const isSports = raw.teamSportsMarket != null;
    const type: 'crypto' | 'sports' | 'mma' = isCrypto
      ? 'crypto'
      : isSports
        ? 'sports'
        : 'mma';
    const endTime = Number(
      raw.cryptoMarket?.endTime ?? raw.teamSportsMarket?.endTime ?? raw.mmaMarket?.endTime ?? 0
    );
    const shareTokens =
      raw.cryptoMarket?.shareTokens ??
      raw.teamSportsMarket?.shareTokens ??
      raw.mmaMarket?.shareTokens ??
      [];

    const initialOdds = raw.cryptoMarket?.initialOdds ?? null;
    const prices =
      Array.isArray(initialOdds) && initialOdds.length > 0
        ? initialOdds.map((v) => Number(v))
        : [0.5, 0.5];

    return {
      id: raw.id,
      marketFactory: raw.marketFactory,
      marketIndex: Number(raw.marketIndex),
      type,
      endTime,
      outcomes: ['YES', 'NO'],
      shareTokens,
      prices,
      winner: raw.cryptoMarket?.winner ?? raw.teamSportsMarket?.winner ?? raw.mmaMarket?.winner ?? undefined,
      coinIndex: raw.cryptoMarket ? Number(raw.cryptoMarket.coinIndex) : undefined,
      creationPrice: raw.cryptoMarket ? Number(raw.cryptoMarket.creationPrice) : undefined,
      marketType: raw.cryptoMarket?.marketType ?? undefined,
    };
  }

  private async querySubgraph<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.subgraphUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`Augur subgraph query failed: ${response.status}`);
    }
    const data = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (data.errors?.length) {
      throw new Error(`Augur subgraph error: ${data.errors[0]?.message ?? 'unknown'}`);
    }
    if (!data.data) {
      throw new Error('Augur subgraph returned no data');
    }
    return data.data;
  }
}
