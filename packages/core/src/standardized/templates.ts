export const META = `_meta { block { number timestamp } hasIndexingErrors }`;

export const YIELD_VAULTS_QUERY = `query($first: Int!) { ${META}
  vaults(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    pricePerShare outputTokenPriceUSD totalValueLockedUSD inputTokenBalance outputTokenSupply depositLimit
    hourlySnapshots: hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
    dailySnapshots: dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
  } }`;

export const LENDING_MARKETS_QUERY = `query($first: Int!) { ${META}
  markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    exchangeRate totalValueLockedUSD totalDepositBalanceUSD totalBorrowBalanceUSD inputTokenBalance
    hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD hourlyDepositUSD hourlyWithdrawUSD }
    dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD dailyDepositUSD dailyWithdrawUSD }
  } }`;
