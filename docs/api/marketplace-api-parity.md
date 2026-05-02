# Marketplace API Parity Matrix

This inventory covers `marketplace-web` buyer and seller actions. Deployables remain thin composition roots; each API action lives under the bounded context that owns the behavior.

| Marketplace-web action | API action | Owner | Permission |
| --- | --- | --- | --- |
| Search marketplace | `GET /api/marketplace/items` | Discovery | anonymous |
| View item detail | `GET /api/marketplace/items/{id}` | Discovery | anonymous |
| Browse categories | `GET /api/marketplace/categories` | Discovery | anonymous |
| View product market summary | `GET /api/marketplace/products/{productId}/market-summary` | Marketplace | anonymous |
| View product listings | `GET /api/marketplace/products/{productId}/listings` | Marketplace | anonymous |
| View cart | `GET /api/marketplace/account/cart` | Checkout | `orders.view` |
| Add cart line | `POST /api/marketplace/account/cart` | Checkout | `orders.manage` |
| Change cart quantity | `POST /api/marketplace/account/cart/{lineId}/quantity` | Checkout | `orders.manage` |
| Remove cart line | `POST /api/marketplace/account/cart/{lineId}/remove` | Checkout | `orders.manage` |
| Start checkout | `POST /api/marketplace/account/checkout-sessions` | Checkout | `orders.manage` |
| View checkout session | `GET /api/marketplace/account/checkout-sessions/{sessionId}` | Checkout | `orders.view` |
| Select shipping option | `POST /api/marketplace/account/checkout-sessions/{sessionId}/shipping-option` | Checkout | `orders.manage` |
| Confirm checkout | `POST /api/marketplace/account/checkout-sessions/{sessionId}/confirm` | Checkout | `orders.manage` |
| Create orders from checkout | `POST /api/marketplace/account/purchases/checkout` | Ordering | `orders.manage` |
| View purchases | `GET /api/marketplace/account/purchases` | Ordering | `orders.view` |
| View purchase detail | `GET /api/marketplace/account/purchases/{id}` | Ordering | `orders.view` |
| Cancel purchase | `POST /api/marketplace/account/purchases/{id}/cancel` | Ordering | `orders.manage` |
| Create payment | `POST /api/marketplace/account/payments` | Payments | `orders.manage` |
| View checkout payment status | `GET /api/marketplace/account/checkout/status` | Payments | `orders.view` |
| Recover checkout payment | `POST /api/marketplace/account/checkout/recover` | Payments | `orders.manage` |
| View checkout recovery options | `GET /api/marketplace/account/checkout/recovery` | Payments | `orders.view` |
| View payment detail | `GET /api/marketplace/account/payments/{id}` | Payments | `orders.view` |
| View payment timeline | `GET /api/marketplace/account/payments/{id}/timeline` | Payments | `orders.view` |
| Issue refund | `POST /api/marketplace/account/payments/{paymentId}/refunds` | Payments | `orders.manage` |
| View buyer shipments | `GET /api/marketplace/account/shipments` | Fulfillment | `orders.view` |
| View buyer shipment detail | `GET /api/marketplace/account/shipments/{id}` | Fulfillment | `orders.view` |
| View review opportunity | `GET /api/marketplace/reviews/opportunities/orders/{orderId}` | Reputation | `orders.view` |
| Submit review | `POST /api/marketplace/reviews` | Reputation | `orders.manage` |
| Update review | `POST /api/marketplace/reviews/{id}/update` | Reputation | `orders.manage` |
| Withdraw review | `POST /api/marketplace/reviews/{id}/withdraw` | Reputation | `orders.manage` |
| View written reviews | `GET /api/marketplace/reviews/written` | Reputation | `orders.view` |
| View received reviews | `GET /api/marketplace/reviews/received` | Reputation | `orders.view` |
| View review detail | `GET /api/marketplace/reviews/{id}` | Reputation | `orders.view` |
| View account review summary | `GET /api/marketplace/accounts/{accountId}/review-summary` | Reputation | anonymous |
| View public account reviews | `GET /api/marketplace/accounts/{accountId}/reviews` | Reputation | anonymous |
| View inventory catalog snapshot | `GET /api/inventory/catalog-items/{id}` | Inventory | `inventory.view` |
| View storage locations | `GET /api/inventory/storage-locations` | Inventory | `inventory.view` |
| Create storage location | `POST /api/inventory/storage-locations` | Inventory | `inventory.manage` |
| Update storage location | `PATCH /api/inventory/storage-locations/{id}` | Inventory | `inventory.manage` |
| View inventory items | `GET /api/inventory/items` | Inventory | `inventory.view` |
| View inventory item detail | `GET /api/inventory/items/{id}` | Inventory | `inventory.view` |
| Create inventory item | `POST /api/inventory/items` | Inventory | `inventory.manage` |
| Adjust inventory item | `POST /api/inventory/items/{id}/adjustments` | Inventory | `inventory.manage` |
| Place inventory hold | `POST /api/inventory/items/{id}/holds` | Inventory | `inventory.manage` |
| Release inventory hold | `POST /api/inventory/holds/{id}/release` | Inventory | `inventory.manage` |
| View listing-ready inventory | `GET /api/marketplace/account/listing-inventory` | Marketplace | `listings.view` |
| View seller listings | `GET /api/marketplace/account/listings` | Marketplace | `listings.view` |
| Preview listing terms | `POST /api/marketplace/account/listings/preview` | Marketplace | `listings.manage` |
| Create listing | `POST /api/marketplace/account/listings` | Marketplace | `listings.manage` |
| View seller listing | `GET /api/marketplace/account/listings/{id}` | Marketplace | `listings.view` |
| Update listing price | `POST /api/marketplace/account/listings/{id}/price` | Marketplace | `listings.manage` |
| Update listing quantity cap | `POST /api/marketplace/account/listings/{id}/quantity-cap` | Marketplace | `listings.manage` |
| Publish listing | `POST /api/marketplace/account/listings/{id}/publish` | Marketplace | `listings.manage` |
| Pause listing | `POST /api/marketplace/account/listings/{id}/pause` | Marketplace | `listings.manage` |
| Withdraw listing | `POST /api/marketplace/account/listings/{id}/withdraw` | Marketplace | `listings.manage` |
| View submitted offers | `GET /api/marketplace/account/offers/submitted` | Marketplace | `offers.view` |
| Submit offer | `POST /api/marketplace/account/offers/submitted` | Marketplace | `offers.manage` |
| View submitted offer detail | `GET /api/marketplace/account/offers/submitted/{id}` | Marketplace | `offers.view` |
| View offer matches | `GET /api/marketplace/account/offers/matches` | Marketplace | `offers.view` |
| View offer match detail | `GET /api/marketplace/account/offers/matches/{id}` | Marketplace | `offers.view` |
| Accept offer match | `POST /api/marketplace/account/offers/matches/{id}/accept` | Marketplace | `offers.manage`, `listings.view` |
| View offer match sell list | `GET /api/marketplace/account/offers/match-sell-list` | Marketplace | `offers.view`, `listings.view` |
| Add offer match to sell list | `POST /api/marketplace/account/offers/match-sell-list` | Marketplace | `offers.manage`, `listings.view` |
| Accept offer match sell list | `POST /api/marketplace/account/offers/match-sell-list/accept` | Marketplace | `offers.manage`, `listings.view` |
| View sales | `GET /api/marketplace/account/sales` | Ordering | `orders.view`, `listings.view` |
| View sale detail | `GET /api/marketplace/account/sales/{id}` | Ordering | `orders.view`, `listings.view` |
| Cancel sale | `POST /api/marketplace/account/sales/{id}/cancel` | Ordering | `orders.manage`, `listings.view` |
| View seller shipments | `GET /api/marketplace/account/sales/shipments` | Fulfillment | `orders.view`, `listings.view` |
| View seller shipment detail | `GET /api/marketplace/account/sales/shipments/{id}` | Fulfillment | `orders.view`, `listings.view` |
| Pack shipment | `POST /api/marketplace/account/sales/shipments/{id}/pack` | Fulfillment | seller shipment access |
| Attach shipment label | `POST /api/marketplace/account/sales/shipments/{id}/label` | Fulfillment | seller shipment access |
| Dispatch shipment | `POST /api/marketplace/account/sales/shipments/{id}/dispatch` | Fulfillment | seller shipment access |
| Mark shipment delivered | `POST /api/marketplace/account/sales/shipments/{id}/deliver` | Fulfillment | seller shipment access |
| Record shipment return | `POST /api/marketplace/account/sales/shipments/{id}/return` | Fulfillment | seller shipment access |
| Raise shipment exception | `POST /api/marketplace/account/sales/shipments/{id}/exception` | Fulfillment | seller shipment access |
| View seller money status | `GET /api/settlement/account-status` | Settlement | `payouts.view` |
| View wallet | `GET /api/settlement/wallet` | Settlement | `payouts.view` |
| View wallet entries | `GET /api/settlement/wallet/entries` | Settlement | `payouts.view` |
| View payout readiness | `GET /api/settlement/payout-readiness` | Settlement | `payouts.view` |
| View payout setup progress | `GET /api/settlement/payout-setup/progress` | Settlement | `payouts.view` |
| Start payout onboarding | `POST /api/settlement/payout-setup/onboarding-session` | Settlement | `payouts.setup` |
| Start payout account management | `POST /api/settlement/payout-setup/account-management-session` | Settlement | `payouts.setup` |
| Refresh payout setup | `POST /api/settlement/payout-setup/refresh` | Settlement | `payouts.setup` |
| View payouts | `GET /api/settlement/payouts` | Settlement | `payouts.view` |
| Preview payout | `POST /api/settlement/payouts/preview` | Settlement | `payouts.request` |
| Request payout | `POST /api/settlement/payouts` | Settlement | `payouts.request` |
| View payout detail | `GET /api/settlement/payouts/{id}` | Settlement | `payouts.view` |
| View payout timeline | `GET /api/settlement/payouts/{id}/timeline` | Settlement | `payouts.view` |
| View money operations health | `GET /api/settlement/money-health` | Settlement | `payouts.reconcile` |
| View payout provider health | `GET /api/settlement/provider-health` | Settlement | `payouts.reconcile` |
| View account profile | `GET /api/identity/accounts/{id}` | Identity | `accounts.view` |
| Update account profile | `PUT /api/identity/accounts/{id}` | Identity | `accounts.manage` |
| View team memberships | `GET /api/identity/memberships` | Identity | `memberships.view` |
| View membership detail | `GET /api/identity/memberships/{id}` | Identity | `memberships.view` |
| Grant membership | `POST /api/identity/memberships` | Identity | `memberships.manage` |
| Change membership role | `PUT /api/identity/memberships/{id}/role` | Identity | `memberships.manage` |
| Revoke membership | `POST /api/identity/memberships/{id}/revoke` | Identity | `memberships.manage` |
| Reinstate membership | `POST /api/identity/memberships/{id}/reinstate` | Identity | `memberships.manage` |
| View invitations | `GET /api/identity/invitations` | Identity | `memberships.manage` |
| Create invitation | `POST /api/identity/invitations` | Identity | `memberships.manage` |
| View invitation detail | `GET /api/identity/invitations/{id}` | Identity | `memberships.manage` |
| Resend invitation | `POST /api/identity/invitations/{id}/resend` | Identity | `memberships.manage` |
| Cancel invitation | `POST /api/identity/invitations/{id}/cancel` | Identity | `memberships.manage` |
| View API keys | `GET /api/identity/api-keys` | Identity | `security.manage` |
| Create API key | `POST /api/identity/api-keys` | Identity | `security.manage` |
| View API key detail | `GET /api/identity/api-keys/{id}` | Identity | `security.manage` |
| Revoke API key | `POST /api/identity/api-keys/{id}/revoke` | Identity | `security.manage` |
| Rotate API key | `POST /api/identity/api-keys/{id}/rotate` | Identity | `security.manage` |
| View consent history | `GET /api/identity/consents` | Identity | authenticated account |

## Notes

- Identity, inventory, and settlement are intentionally documented alongside `/api/marketplace` because they power marketplace-web account workflows while retaining their canonical bounded-context base paths.
- Provider webhook endpoints are excluded because they are provider-facing ingress, not user-facing marketplace actions.
- Internal auth bootstrap endpoints are excluded; marketplace registration and sign-in continue to use Auth-owned `/api/auth` journeys.
