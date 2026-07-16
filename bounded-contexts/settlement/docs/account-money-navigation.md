# Account Money Navigation

Settlement owns the Seller Desk Money dashboard at `/account/desk/money` as the single account-money destination in the marketplace app. Money combines available and pending Wallet balance, the next Payout, payout attention, payout requests, payout history, and Wallet activity without exposing provider or reconciliation internals.

Payout Setup remains a distinct Settlement-owned flow at `/account/desk/settings`, entered from Money when setup is incomplete or the payout account needs management. A Payout remains a forward entity surface at `/account/desk/payouts/:payoutId`; Wallet Adjustment details open as a drawer over Money.

The former `/account/settlement`, `/account/payouts`, `/account/payouts/:payoutId`, `/account/payouts/setup`, and `/account/wallet/adjustments/:reference` routes are compatibility redirects. Marketplace navigation contributes one Money entry and must not move Wallet or Payout behavior, read models, route loaders, or permissions out of Settlement.
