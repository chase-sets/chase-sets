# Account Shipping Addresses

## Intent

Accounts need a saved shipping address capability so checkout can reuse known destinations, let an account choose or create a default destination, and manage shipping addresses without leaving checkout.

The feature should keep account-owned address book behavior separate from checkout-owned session snapshots and fulfillment-owned shipment execution.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-account-shipping-addresses`
- Branch: `codex/account-shipping-addresses`
- Base: current source repo `HEAD` at worktree creation, `8cc4f1e6 Add notifications database to staging platform (#72)`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox id: `12252d7f`
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- Sandbox ports: marketplace `http://localhost:9553`, platform API `http://localhost:9562`, dev portal `http://localhost:9550`
- Setup caveats: dependency install reported existing cyclic workspace dependency warnings among checkout, ordering, marketplace seed testing, and discovery; install and sandbox doctor still succeeded.

## Owning Contexts

- Primary owner: Identity, because the context map makes Account the root identity for marketplace participation, Identity owns Account, and the Identity glossary now defines recipient Shipping Address as account-owned reusable state.
- Checkout collaborator: Checkout should display, select, create, and snapshot an account shipping address during the active checkout session, but the saved address book must not live in Checkout.
- Ordering collaborator: Ordering should continue to consume an immutable shipping destination snapshot when order commitments are created.
- Fulfillment collaborator: Fulfillment should continue to consume immutable shipping destination snapshots for shipment execution and labels.

## Resolved Decisions

- Create planning in an isolated feature worktree before product-code changes.
- Product-code changes are now underway in this implementation worktree.
- Treat saved shipping addresses as account state, not checkout session state, unless a later decision explicitly changes ownership.
- Preserve immutable snapshots across Checkout -> Ordering -> Fulfillment so historical orders and shipments are not affected by later address book edits.
- Model only account-owned recipient `Shipping Address` entries in Identity for this feature, not a broad typed account address/location book.
- Keep Inventory `Storage Location`, Fulfillment `Ship-from Location`, and Identity `Shipping Address` as distinct terms.
- Enforce exactly one active default shipping address per account whenever the account has any active shipping addresses.
- Make the first active shipping address default automatically; setting a new default clears the previous default.
- When the default shipping address is archived or removed, promote the most recently updated active shipping address, or leave no default only when no active addresses remain.
- Checkout stores optional saved shipping address provenance (`shippingAddressId`) plus the immutable shipping address snapshot used for order and fulfillment handoff.
- Ordering and Fulfillment continue to depend on snapshots, not live Identity address records.
- Checkout may create or update saved shipping addresses only through an explicit visible user choice; checkout confirmation must not silently mutate Identity address book state.
- For signed-in accounts, a new checkout address can default to "Save to account" while still allowing one-off use. Guest checkout keeps snapshot-only behavior.
- Editing an existing saved address during checkout should offer explicit choices such as update saved address, save as new address, or use for this checkout only.

## Repo Evidence

- `bounded-contexts/README.md` says Identity is upstream for user and account references and Checkout owns cart intent and active checkout sessions.
- `bounded-contexts/identity/GLOSSARY.md` defines Account as the commercial root and now says accounts own recipient shipping addresses used for checkout reuse.
- `bounded-contexts/checkout/README.md` says Checkout owns selected shipping option and checkout review state before order/payment.
- `bounded-contexts/checkout/features/sessions/domain/domain.ts` already has `CheckoutShippingAddress`, `SetShippingAddress`, and `checkout.session.shipping-address-set`; checkout requires a shipping address before orders or purchase intent submission.
- `bounded-contexts/checkout/routes/checkout-session.tsx` currently renders raw shipping address fields and posts an inline address on confirmation.
- `bounded-contexts/ordering/features/orders/domain/domain.ts` stores `shippingDestinationSnapshot` on order creation.
- `bounded-contexts/fulfillment/features/shipments/read-model/schema.ts` stores `shipping_destination_snapshot` for shipment pages.
- `contracts/primitives/address-snapshot.ts` already provides a reusable immutable `AddressSnapshot` shape and normalization helper.

## Contradictions Found

- Identity glossary says accounts own locations (addresses) and fulfillment settings.
- Fulfillment README says Fulfillment owns Ship-from Locations.
- Inventory already owns storage locations and ship-from codes for account-held stock.
- Proposed resolution: use `Shipping Address` for account-owned recipient destinations in Identity; keep Inventory `Storage Location` and Fulfillment `Ship-from Location` separate. If seller ship-from address management is part of this feature, that would require a second ownership decision instead of folding it into buyer checkout address reuse.

## Implementation Shape

- Add a new Identity slice `shipping-addresses` under `bounded-contexts/identity/features/shipping-addresses/` and declare it in `bounded-contexts/identity/context.json`.
- Use a new `ShippingAddressId` typed id in shared primitives only if Checkout stores provenance across the Identity/Checkout boundary; otherwise keep the type context-local and expose it through Identity client contracts. Current decision favors cross-context provenance, so a shared typed id is expected.
- Identity domain commands/events:
  - `AddShippingAddress` -> `identity.shipping-address.added`
  - `UpdateShippingAddress` -> `identity.shipping-address.updated`
  - `SetDefaultShippingAddress` -> `identity.shipping-address.default-set`
  - `ArchiveShippingAddress` -> `identity.shipping-address.archived`
- Identity read model:
  - `identity_shipping_addresses`
  - keyed by `shipping_address_id`
  - indexed by `(account_id, is_archived, is_default, updated_at DESC)`
  - stores normalized recipient fields plus `label`, `is_default`, `is_archived`, `created_at`, `updated_at`
- Identity API surface:
  - `GET /api/identity/accounts/:id/shipping-addresses`
  - `POST /api/identity/accounts/:id/shipping-addresses`
  - `PUT /api/identity/accounts/:id/shipping-addresses/:shippingAddressId`
  - `POST /api/identity/accounts/:id/shipping-addresses/:shippingAddressId/default`
  - `POST /api/identity/accounts/:id/shipping-addresses/:shippingAddressId/archive`
- Marketplace account route:
  - add `/account/shipping-addresses` as an Identity-owned marketplace route for full address management.
  - add account page affordance/link to shipping addresses.
- Checkout route:
  - load saved shipping addresses for signed-in non-guest accounts through the Identity request API.
  - preselect the active default when no checkout session shipping address has been set.
  - allow selecting saved address, adding a new address, updating an existing saved address, saving as new, or using an entered address for this checkout only.
  - on selection/confirmation, call Checkout to record `shippingAddressId` plus normalized snapshot; any Identity mutation must happen through explicit Identity API calls before Checkout confirmation.
- Checkout session changes:
  - add optional `shippingAddressId`/`shipping_address_id` provenance to `CheckoutShippingAddress` state/event/read model/API contract.
  - keep `shippingAddress` snapshot required before orders or offer intent submission.
  - do not project or subscribe to Identity address events in Checkout unless implementation finds stale-selection warnings require asynchronous facts; synchronous Identity reads at route time should be enough for the first version.
- Ordering/Fulfillment:
  - preserve existing snapshot handoff.
  - no live dependency on Identity shipping address records.
  - only adjust contracts if Checkout currently strips provenance before order creation and tests need to assert snapshot stability.

## Open Questions

None currently blocking.

## Recommended Answer

No remaining blocking product/domain question at this checkpoint.

The implementation goal can proceed with the resolved decisions unless new contradictions appear during implementation.

## Implementation Checklist

- [x] Add a new Identity-owned shipping address slice under `bounded-contexts/identity/features/shipping-addresses/`.
- [x] Add account shipping address domain commands/events for add, update, archive, and set default.
- [x] Add read models and API routes for listing and managing account shipping addresses under `/api/identity`.
- [x] Add marketplace account UI for managing shipping addresses from account settings.
- [x] Add Checkout read/selection UI that fetches Identity-owned saved addresses, preselects the default address, supports entering a new address during checkout, and snapshots the selected address into the checkout session.
- [x] Keep Checkout confirmation explicit about whether it updates a saved address, saves a new address, or uses a checkout-only snapshot.
- [x] Add localization keys through contracts localization.
- [x] Add focused Identity and Checkout domain/API/UI/route tests for default rules, provenance, account management UI, and checkout saved-address flows.
- [x] Complete browser visual checks for account shipping-address management and checkout saved-address management on desktop and mobile.
- [ ] Submit PR, wait for CI, merge, and verify staging workflows.

## Verification Log

- `pnpm --filter @chase-sets/identity run test` passed.
- `pnpm --filter @chase-sets/checkout run test` passed.
- `pnpm run check:structure` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:no-any` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed.
- `pnpm run verify:db` passed.
- `pnpm run dev:bootstrap` passed for sandbox `12252d7f`.
- `pnpm run dev:marketplace-full` started marketplace `http://localhost:9553` and platform API `http://localhost:9562`.
- Browser visual verification covered `/account/shipping-addresses` and `/checkout/chk_seed_started_cart` at desktop and narrow mobile-ish widths with manual seeded sign-in because the in-app browser control layer could not type into `type=email` fields and Browser policy blocked script/file helper navigation.
- Visual verification found and fixed a shared `PriceBreakdown` total-row wrapping issue that made long checkout statuses overlap in narrow sidebars.
- After the shared design-system fix, `pnpm --filter @chase-sets/design-system run test`, `pnpm --filter @chase-sets/design-system run typecheck`, `pnpm run verify:typecheck`, `pnpm run verify:test`, and `pnpm run verify:build` passed again.

## Documentation To Promote

- Updated `bounded-contexts/identity/GLOSSARY.md` with `Shipping Address`.
- Updated `bounded-contexts/identity/README.md` to list `Shipping Address` as Identity-owned and exclude Inventory storage locations/Fulfillment ship-from locations.
- Updated `docs/GLOSSARY.md` with the cross-context `Shipping Address` term.
- Update or add an Identity context doc during implementation if address book rules become more detailed than the glossary can carry.
- Re-check Identity/Fulfillment/Inventory address-location language during implementation if seller ship-from management enters scope.

## Goal Completion Criteria

- Implementation happens in this worktree and branch.
- Durable docs are promoted alongside code and the retained plan stays committed.
- Automated checks include relevant unit, API, UI, structure, typecheck, and build coverage.
- Marketplace checkout and account address management are visually verified on desktop and mobile.
- Checkout reuse, default selection, adding during checkout, editing/archiving stale addresses, order snapshot creation, and fulfillment snapshot display are verified.
- A PR is submitted, CI passes, the PR is merged, and staging deploy verification confirms account and checkout address workflows.
