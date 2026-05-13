# Account Money Navigation

Settlement owns the Wallet as the primary account-money destination in the marketplace app. Wallet is the account-facing place to inspect pending balance, available balance, payout readiness, and ledger activity.

Payouts remains the Settlement-owned workflow for payout setup, payout requests, and payout history. It should be reachable from Wallet and from account-money navigation where grouped child navigation is available, but it should not be the only visible entry point for account money.

Marketplace deployables may group Wallet and Payouts under Account navigation, but they should not move Wallet behavior, read models, route loaders, or permissions out of Settlement.
