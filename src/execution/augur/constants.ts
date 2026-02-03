export const AUGUR_TURBO_ADDRESSES = {
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  ammFactory: '0x79C3CF0553B6852890E8BA58878a5bCa8b06d90C',
  marketFactories: {
    MLB: '0x03810440953e2BCd2F17a63706a4C8325e0aBf94',
    NBA: '0xe696B8fa35e487c3A02c2444777c7a2EF6cd0297',
    NFL: '0x1f3eF7cA2b2ca07a397e7BC1bEb8c3cffc57E95a',
    MMA: '0x6D2e53d53aEc521dec3d53C533E6c6E60444c655',
    Crypto: '0x48725baC1C27C2DaF5eD7Df22D6A9d781053Fec1',
  },
  fetchers: {
    sports: '0xcfcF4EF9A35460345D6efC7D01993644Dbcd4273',
    crypto: '0x0C68954eCB79C80868cd34aE12e0C2cC8E1Cc430',
  },
  masterChef: '0x1486AE5344C0239d5Ec6198047a33454c25E1ffD',
  reputationToken: '0x435C88888388D73BD97dab3B3EE1773B084E0cdd',
} as const;

export const AUGUR_SUBGRAPH_DEFAULT =
  'https://api.thegraph.com/subgraphs/name/augurproject/augur-turbo-matic';
