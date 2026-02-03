export type MarketPlatform = 'augur';

export interface Market {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  prices: Record<string, number>;
  volume?: number;
  liquidity?: number;
  endDate?: Date;
  category?: string;
  resolved?: boolean;
  resolution?: string;
  createdAt?: Date;
  platform: MarketPlatform;
  augur?: {
    marketFactory: string;
    marketIndex: number;
    type: 'crypto' | 'sports' | 'mma';
    shareTokens: string[];
    coinIndex?: number;
    creationPrice?: number;
    marketType?: string;
  };
}
