# Augur Turbo Implementation Guide

> Implementation guide for replacing Augur Turbo with Augur Turbo in Thufir.

## Overview

Augur Turbo is an AMM-based prediction market on Polygon using Chainlink oracles. Unlike Augur Turbo's order book (CLOB), Augur uses automated market makers for trading.

**Key Differences from Augur Turbo:**
| Aspect | Augur Turbo | Augur Turbo |
|--------|------------|-------------|
| Trading Model | Order Book (CLOB) | AMM (Balancer pools) |
| Authentication | L1 (EIP-712) + L2 (HMAC API keys) | None - just wallet signatures |
| Chain | Polygon | Polygon |
| Collateral | USDC | USDC |
| Market Types | General (politics, crypto, events) | Sports, Crypto, MMA |
| Data Access | REST API | GraphQL Subgraph + Direct contract calls |

## Architecture

### Contract Addresses (Polygon Mainnet - 137)

```typescript
const AUGUR_TURBO_ADDRESSES = {
  // Collateral
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',

  // AMM Factory
  ammFactory: '0x79C3CF0553B6852890E8BA58878a5bCa8b06d90C',

  // Market Factories by Type
  marketFactories: {
    MLB: '0x03810440953e2BCd2F17a63706a4C8325e0aBf94',
    NBA: '0xe696B8fa35e487c3A02c2444777c7a2EF6cd0297',
    NFL: '0x1f3eF7cA2b2ca07a397e7BC1bEb8c3cffc57E95a',
    MMA: '0x6D2e53d53aEc521dec3d53C533E6c6E60444c655',
    Crypto: '0x48725baC1C27C2DaF5eD7Df22D6A9d781053Fec1',
  },

  // Fetchers (read market data)
  fetchers: {
    sports: '0xcfcF4EF9A35460345D6efC7D01993644Dbcd4273',
    crypto: '0x0C68954eCB79C80868cd34aE12e0C2cC8E1Cc430',
  },

  // Rewards
  masterChef: '0x1486AE5344C0239d5Ec6198047a33454c25E1ffD',

  // REP Token
  reputationToken: '0x435C88888388D73BD97dab3B3EE1773B084E0cdd',
};
```

### GraphQL Subgraph

Endpoint: `https://api.thegraph.com/subgraphs/name/augurproject/augur-turbo-matic`

```graphql
# Query active markets
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
    trades(first: 10, orderBy: timestamp, orderDirection: desc) {
      outcome
      collateral
      shares
      price
      timestamp
    }
  }
}

# Query user positions
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
    trade {
      marketId { id }
      outcome
      collateral
      shares
      price
      timestamp
    }
  }
}

# Query specific market
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
    liquidity {
      collateralBigDecimal
      lpTokens
    }
    trades(first: 100, orderBy: timestamp, orderDirection: desc) {
      outcome
      collateral
      shares
      price
      timestamp
      user
    }
  }
}
```

## Implementation Steps

### Step 1: Create Augur Client (`src/execution/augur/client.ts`)

```typescript
import { ethers } from 'ethers';
import { GraphQLClient, gql } from 'graphql-request';

const SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/augurproject/augur-turbo-matic';

export interface AugurMarket {
  id: string;
  marketFactory: string;
  marketIndex: string;
  type: 'crypto' | 'sports' | 'mma';
  endTime: number;
  outcomes: string[];
  shareTokens: string[];
  prices: number[];  // Current prices from AMM
  winner?: string;
}

export interface AugurPosition {
  marketId: string;
  outcome: string;
  shares: string;
  avgPrice: number;
  costBasis: number;
  open: boolean;
}

export class AugurTurboClient {
  private graphql: GraphQLClient;
  private provider: ethers.providers.Provider;
  private wallet?: ethers.Wallet;

  constructor(provider: ethers.providers.Provider) {
    this.graphql = new GraphQLClient(SUBGRAPH_URL);
    this.provider = provider;
  }

  setWallet(wallet: ethers.Wallet): void {
    this.wallet = wallet;
  }

  // Query markets from subgraph
  async getMarkets(options?: { type?: string; limit?: number }): Promise<AugurMarket[]> {
    // Implementation: Query subgraph and normalize
  }

  // Get market by ID
  async getMarket(id: string): Promise<AugurMarket | null> {
    // Implementation: Query specific market
  }

  // Get user positions
  async getPositions(address: string): Promise<AugurPosition[]> {
    // Implementation: Query user positions
  }

  // Get current AMM prices for a market
  async getPrices(marketFactory: string, marketIndex: number): Promise<number[]> {
    // Implementation: Call Fetcher contract
  }
}
```

### Step 2: Create AMM Trader (`src/execution/augur/amm.ts`)

```typescript
import { ethers } from 'ethers';

// ABI fragments for AMM trading
const AMM_FACTORY_ABI = [
  'function buy(address marketFactory, uint256 marketId, uint256 outcome, uint256 collateralIn, uint256 minShares) external returns (uint256)',
  'function sell(address marketFactory, uint256 marketId, uint256 outcome, uint256 sharesToSell, uint256 minCollateral) external returns (uint256)',
  'function getPool(address marketFactory, uint256 marketId) external view returns (address)',
];

const FETCHER_ABI = [
  'function getMarket(uint256 marketId) external view returns (tuple(...))',
  'function getMarketPrices(uint256 marketId) external view returns (uint256[] memory)',
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
    this.usdc = new ethers.Contract(
      AUGUR_TURBO_ADDRESSES.USDC,
      ERC20_ABI,
      wallet
    );
  }

  // Approve USDC spending (one-time per factory)
  async approveUsdc(amount: ethers.BigNumber): Promise<ethers.ContractTransaction> {
    return this.usdc.approve(AUGUR_TURBO_ADDRESSES.ammFactory, amount);
  }

  // Buy outcome shares
  async buy(params: {
    marketFactory: string;
    marketId: number;
    outcome: number;      // 0 = first outcome, 1 = second, etc.
    collateralIn: string; // USDC amount (6 decimals)
    minShares: string;    // Minimum shares to receive (slippage protection)
  }): Promise<ethers.ContractTransaction> {
    return this.ammFactory.buy(
      params.marketFactory,
      params.marketId,
      params.outcome,
      params.collateralIn,
      params.minShares
    );
  }

  // Sell outcome shares
  async sell(params: {
    marketFactory: string;
    marketId: number;
    outcome: number;
    sharesToSell: string;
    minCollateral: string; // Minimum USDC to receive
  }): Promise<ethers.ContractTransaction> {
    return this.ammFactory.sell(
      params.marketFactory,
      params.marketId,
      params.outcome,
      params.sharesToSell,
      params.minCollateral
    );
  }

  // Calculate expected output (for slippage estimation)
  async estimateBuy(params: {
    marketFactory: string;
    marketId: number;
    outcome: number;
    collateralIn: string;
  }): Promise<{ shares: string; pricePerShare: number }> {
    // Implementation: Use staticCall or view function
  }
}
```

### Step 3: Create Execution Adapter (`src/execution/modes/augur-live.ts`)

```typescript
import { ExecutionAdapter, TradeDecision, TradeResult } from '../executor.js';
import { AugurTurboClient, AugurMarket } from '../augur/client.js';
import { AugurAMMTrader } from '../augur/amm.js';

export class AugurLiveExecutor implements ExecutionAdapter {
  private client: AugurTurboClient;
  private trader: AugurAMMTrader;
  private limits: SpendingLimitEnforcer;

  async execute(market: AugurMarket, decision: TradeDecision): Promise<TradeResult> {
    // 1. Check spending limits
    // 2. Get current prices from AMM
    // 3. Calculate slippage tolerance
    // 4. Execute buy/sell via AMM
    // 5. Record trade in ledger
    // 6. Return result
  }

  async getOpenOrders(): Promise<Order[]> {
    // Augur AMM trades execute immediately; no open orders.
    return [];
  }

  async cancelOrder(id: string): Promise<void> {
    throw new Error('Augur AMM trades execute immediately; no open orders to cancel.');
  }
}
```

### Step 4: Update Market Interface

Extend the existing `Market` interface to support Augur:

```typescript
// src/execution/markets.ts
export interface Market {
  // Common fields
  id: string;
  question: string;
  description?: string;
  endDate?: Date;
  resolved: boolean;

  // Prices (0-1 range)
  prices: Record<string, number>;  // { 'YES': 0.65, 'NO': 0.35 } or { 'Over': 0.5, 'Under': 0.5 }

  // Platform-specific
  platform: 'augur' | 'manifold';

  // Augur-specific
  augur?: {
    marketFactory: string;
    marketIndex: number;
    type: 'crypto' | 'sports' | 'mma';
    shareTokens: string[];
  };

}
```

### Step 5: Update Config Schema

```yaml
# config.yaml
augur:
  enabled: true
  subgraph: 'https://api.thegraph.com/subgraphs/name/augurproject/augur-turbo-matic'
  slippageTolerance: 0.02  # 2% max slippage
  marketTypes:
    - crypto   # Enable crypto price markets
    # - sports # Optionally enable sports
    # - mma    # Optionally enable MMA
```

### Step 6: Market Normalization

Create a normalizer to convert Augur markets to the common Market interface:

```typescript
// src/execution/augur/normalize.ts
export function normalizeAugurMarket(raw: SubgraphMarket): Market {
  const isCrypto = raw.cryptoMarket !== null;
  const isSports = raw.teamSportsMarket !== null;
  const isMma = raw.mmaMarket !== null;

  let question: string;
  let outcomes: string[];
  let prices: Record<string, number>;

  if (isCrypto) {
    const crypto = raw.cryptoMarket;
    question = `Will ${COIN_NAMES[crypto.coinIndex]} be above ${crypto.creationPrice} at ${formatDate(crypto.endTime)}?`;
    outcomes = ['YES', 'NO'];
    prices = calculatePricesFromOdds(crypto.initialOdds);
  } else if (isSports) {
    // Handle sports markets
  }

  return {
    id: raw.id,
    question,
    platform: 'augur',
    prices,
    augur: {
      marketFactory: raw.marketFactory,
      marketIndex: parseInt(raw.marketIndex),
      type: isCrypto ? 'crypto' : isSports ? 'sports' : 'mma',
      shareTokens: raw.cryptoMarket?.shareTokens ?? [],
    },
  };
}
```

## Testing

### Mumbai Testnet (80001)

Use Mumbai testnet for development:

```typescript
const MUMBAI_ADDRESSES = {
  USDC: '0x5799bFe361BEea69f808328FF4884DF92f1f66f0', // Test USDC
  ammFactory: '0xDcf4173FC3947bC2CbAB929559b7f38Cb25Bef34',
  cryptoMarketFactory: '0x6B12716B875320Dd7c6fC1161639f93a088091B7',
};
```

### Test Script

```typescript
// scripts/test-augur.ts
async function testAugur() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const client = new AugurTurboClient(provider);
  client.setWallet(wallet);

  // List crypto markets
  const markets = await client.getMarkets({ type: 'crypto', limit: 10 });
  console.log('Crypto markets:', markets);

  // Get prices
  for (const market of markets) {
    const prices = await client.getPrices(market.marketFactory, market.marketIndex);
    console.log(`${market.question}: ${prices}`);
  }
}
```

## Migration Checklist

- [x] Create `src/execution/augur/` directory
- [x] Implement `AugurTurboClient` with GraphQL queries
- [x] Implement `AugurAMMTrader` with contract interactions
- [x] Create `AugurLiveExecutor` implementing `ExecutionAdapter`
- [x] Add Augur config schema to `config.ts`
- [x] Update `Market` interface for multi-platform support
- [x] Create market normalization for Augur
- [x] Update CLI commands to support Augur markets
- [x] Add Augur to opportunity scanner
- [ ] Test on Mumbai testnet
- [ ] Deploy to Polygon mainnet

## Implementation Status Notes

- Portfolio/positions now include Augur subgraph positions (queried by wallet address).
- ExecutionAdapter includes `getOpenOrders`/`cancelOrder` (no-ops for AMM).

## Key Considerations

### AMM vs Order Book

- **No limit orders**: AMM executes immediately at market price
- **Slippage**: Large orders move price; use slippage tolerance
- **Liquidity**: Check pool liquidity before trading
- **Price impact**: Estimate before executing

### Market Types

Augur Turbo focuses on:
1. **Crypto price markets** - Bitcoin/ETH above/below price at time X
2. **Sports** - NBA, NFL, MLB, MMA outcomes
3. **Grouped markets** - Custom market types

For Thufir's "prediction market trading on current events", crypto markets are the best fit. Sports markets are viable but require sports-specific intelligence.

### Gas Optimization

- Approve USDC once with max amount
- Batch position queries via multicall
- Cache subgraph results (markets don't change frequently)

## References

- [Augur Turbo GitHub](https://github.com/AugurProject/turbo)
- [Subgraph Schema](https://github.com/AugurProject/turbo/tree/master/packages/subgraph)
- [Contract ABIs](https://github.com/AugurProject/turbo/tree/master/packages/smart/contracts)
