# Corten pilot

Chase Sets screens ported to [Corten](https://github.com/todd-skelton/corten), the Rust and plain
JavaScript framework, to find what Corten lacks for real screens with real data and auth. Each app
is a standalone server in front of the existing platform API: every call forwards the signed-in
user's cookies, as the React apps do, and business rules stay in the API. The pilot owns only the
screens.

It is not deployed. It is not part of the platform gates or the delivery loop. Its own CI job,
[corten-pilot.yml](../../.github/workflows/corten-pilot.yml), is advisory.

## Owner

Todd Skelton owns the pilot. Its work runs in a dedicated Codex task (the "Corten pilot" thread)
alongside the Corten framework's own task, not through the delivery loop. Lanes do not pick up
pilot work, and a delivery change that makes the advisory pilot check fail is not blocked by it:
note it on the PR and the pilot task fixes the pilot. Where a problem goes:

1. Corten lacks something another app would also hit: an issue in
   [todd-skelton/corten](https://github.com/todd-skelton/corten/issues), one gap per issue, with the
   pilot's workaround linked.
2. A Chase Sets bug, or a business rule that lives in a web loader instead of its API: an issue in
   this repo, with the pilot's workaround linked (below).

## What is ported

| App | Screen and addresses |
|---|---|
| `admin/` | Commerce > Postage policies, `/commerce/postage-policies` |
| `admin/` | Catalog > Dimensions and Fields, `/catalog/dimensions`, `/catalog/fields` |
| `admin/` | Catalog > Catalog Items (the list), `/catalog/catalog-items` |
| `admin/` | Catalog > Scopes (the list), `/catalog/scopes` |
| `admin/` | Catalog > a scope's page, `/catalog/scopes/{id}` |
| `admin/` | Platform > Attention Queue, `/platform/operations-attention` |
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}`, with its Publish, Set Field Value and Add content line dialogs |
| `admin/` | Catalog's home, `/catalog`, a dimension's and a field's page, `/catalog/dimensions/{id}`, `/catalog/fields/{id}`, and the scope attention review, `/catalog/scopes/attention/review` |
| `admin/` | Catalog > Categories, `/catalog/categories` (search, status, hierarchy and parent filters, bulk publish, deprecate and archive), and a category's page, `/catalog/categories/{id}` |
| `admin/` | Catalog > Components, `/catalog/components` (search, status and has-rules filters, bulk changes), and a component's page, `/catalog/components/{id}`, with its field and dimension rules (add, remove) |
| `admin/` | Catalog > Blueprints, `/catalog/blueprints` (search, status, has-components and has-rules filters, bulk changes), and a blueprint's page, `/catalog/blueprints/{id}`, with its components (attach, detach) and its field, dimension and product resolution rules (set, from dialogs the server draws when opened) |
| `admin/` | Commerce > a postage policy, `/commerce/postage-policies/{id}` |
| `admin/` | Platform > Projections, `/platform/projections` |
| `marketplace/` | Inventory > Storage locations, `/account/inventory/locations` |
| `marketplace/` | Inventory > Restock decisions, `/account/inventory/restock-decisions` |
| `marketplace/` | Inventory > Inventory, `/account/inventory` |
| `marketplace/` | Inventory > an item, `/account/inventory/items/{id}` |
| `marketplace/` | Seller Desk, `/account/desk` |
| `marketplace/` | Seller Desk > Repricing, `/account/desk/repricing` |
| `marketplace/` | Seller Desk > a repricing policy, `/account/desk/repricing/{id}` |
| `marketplace/` | Bulk reprice, `/account/bulk-reprice` (`?jobId=`) |
| `marketplace/` | Pricing > Recommendations, `/account/repricing` (`?jobId=`) |
| `marketplace/` | Seller Desk > Pricing Health, `/account/desk/pricing-health` (`?policyId=`) |
| `marketplace/` | Channels > Connections, `/account/channels` (`?status=`, `?cursor=`), a connection, `/account/channels/{id}`, with its manual TCGplayer sync (`POST ../{id}/manual-sync`, `../ingest`, `../download`), Publication, `/account/channels/publication`, and a connection's publication, `/account/channels/publication/{id}` |
| `marketplace/` | Seller Desk > Money and a payout's page, `/account/desk/money`, `/account/desk/payouts/{id}` |
| `marketplace/` | Seller Desk > payout setup, `/account/desk/settings` (`?mode=manage`) |
| `marketplace/` | Buy > Cart, `/account/cart` |
| `marketplace/` | Buy > Checkout, `/checkout/buy/session/{id}`, and its confirmation, `/checkout/buy/session/{id}/confirmation`, for an account or a guest checkout, and an offer's checkout (Submit offer) |
| `marketplace/` | Checkout start, `/checkout/buy/readiness`, for a listing, an offer or the cart, and a guest's or visitor's Buy |
| `marketplace/` | Buy > a payment, `/account/payments/{id}`, and a guest checkout's, `/checkout/payments/{id}`, with Retry payment; saving a paid guest order to an account stays on marketplace |
| `marketplace/` | Buy > start a payment for a purchase, `/account/payments/new`, where Pay now and Retry payment go |
| `marketplace/` | Sign in, `/sign-in`, `/sign-in/magic`, `/account/select`, `/sign-out` |
| `marketplace/` | Create an account, `/register` (`?registrationMethod=`); a passkey stays on marketplace |
| `marketplace/` | Accept a team invitation, `/invite/{id}` (`?token=`, `?credentialMethod=`); a passkey stays on marketplace |
| `marketplace/` | The account's own page, `/account` |
| `marketplace/` | The user's security page, `/account/security` |
| `marketplace/` | The user's sessions, `/account/sessions` and `/account/sessions/{id}` |
| `marketplace/` | The account's team, `/account/team` |
| `marketplace/` | The user's consent history, `/account/consents` |
| `marketplace/` | The account's reviews, `/account/reviews`, `/account/reviews/received`, `/account/reviews/written`, `/account/reviews/{id}` |
| `marketplace/` | An item's page, `/items/{slug}` |
| `marketplace/` | A listing's page, `/listings/{slug}` |
| `marketplace/` | An account's page, `/accounts/{slug}` |
| `marketplace/` | The notification center, `/account/notifications` |
| `marketplace/` | The account's orders, `/account/purchases`, `/account/sales` and each order's page |
| `marketplace/` | An order's review, `/account/purchases/{id}/review` and `/account/sales/{id}/review` |
| `marketplace/` | The account's shipments, `/account/shipments`, `/account/shipments/{id}` and `/account/sales/shipments/{id}` |
| `marketplace/` | Shipping addresses, `/account/shipping-addresses` |
| `marketplace/` | Packing a shipment, `/account/sales/shipments/{id}/packing` |
| `marketplace/` | Create listing, `/account/listings/new` |
| `marketplace/` | A seller's listing, `/account/listings/{id}` |
| `marketplace/` | A set's page, `/sets/{slug}` |
| `marketplace/` | Search and the home page, `/search`, `/categories/{slug}` and `/` |
| `public/` | An item's market page, `/market/{slug}`, with `robots.txt` and `sitemap.xml` |
| `public/` | The home page, `/` (chasesets.com's waitlist landing) |
| `public/` | The policy documents, `/terms`, `/privacy`, `/founders`, `/seller-agreement`, `/payments-terms`, `/agent-terms` and `/authenticity-terms` |
| `public/` | The welcome page, `/welcome` |
| `public/` | The help center, `/help`, `/help/{category}` and `/help/{category}/{slug}`, and two of its articles at their own addresses, `/sales-fees` and `/press` |
| `public/` | The compare pages, `/compare/tcgplayer` and `/compare/ebay`, with the fee calculator, and Contact, `/contact` |
| `public/` | The developer portal, `/developers`, a guide at `/developers/{slug}`, `/developers/manifest.json` and `/llms.txt` |
| `public/` | The site's own files: `/manifest.webmanifest`, `/favicon.svg`, `/favicon.ico` and `/.well-known/appspecific/com.chrome.devtools.json` |
| `marketplace/` | The seller's listings, `/account/listings` |
| `marketplace/` | The seller's offer matches, `/account/offers/matches` and `/account/offers/matches/{id}` |
| `marketplace/` | The Sell List, `/account/sell-list`, and the Seller Desk's Offers & sell list, `/account/desk/offers` |
| `marketplace/` | Seller checkout, `/checkout/sell/session/{id}`, and its confirmation, `/checkout/sell/session/{id}/confirmation` |
| `marketplace/` | Buy > Saved payment methods, `/account/payment-methods` |
| `marketplace/` | Packing slips, `/account/sales/shipments/packing-slips?shipmentIds=..&format=..` |
| `marketplace/` | Inventory import, `/account/inventory/imports`, `/account/inventory/imports/{batch}` |
| `marketplace/` | The buyer's submitted offers, `/account/offers/submitted` |
| `marketplace/` | A submitted offer's page, `/account/offers/submitted/{id}` |
| `marketplace/` | Support, `/account/support` and a case's page, `/account/support/{id}` |
| `marketplace/` | Product alerts, `/account/product-alerts` |
| `marketplace/` | marketplace's older money addresses, which move to the Seller Desk: `/account/payouts`, `/account/settlement`, `/account/payouts/{id}`, `/account/payouts/setup` and `/account/wallet/adjustments/{reference}` |

What each screen covers and leaves out, screen by screen, is in the
[README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("What it covers"), with decisions 1 to 96 behind them.

## Measured

Median of 7 cold-cache loads, signed in as the same user, production builds of both (the React
app and the pilot `--release`) from the same commit, against the dev sandbox on one machine. The
mobile profile is 4x CPU, 150 ms RTT and 1.6 Mbps down. Interactive is when the page's scripts ran.

| Storage locations (list) | marketplace desktop | pilot desktop | marketplace mobile | pilot mobile |
|---|---|---|---|---|
| Interactive | 929 ms | 386 ms | 7,011 ms | 902 ms |
| Largest contentful paint | 648 ms | 372 ms | 2,300 ms | 1,360 ms |
| Server time (document) | 197 ms | 72 ms | 197 ms | 118 ms |
| JavaScript transferred | 667,789 B | 8,049 B | 667,789 B | 8,049 B |
| HTML / CSS transferred | 16,275 / 19,970 B | 4,163 / 3,164 B | 16,275 / 19,970 B | 4,165 / 3,164 B |
| Requests | 93 | 9 | 92 | 9 |


This is the one screen with a production React baseline: a production build of marketplace-web is
refused outside the heavy-slot governor, so every later screen was measured against the React dev
servers, which overstate React's bytes and time by an unknown amount. Those per-screen numbers are
in the [README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("Measured"). Every number is a single run on one machine.

## Running it

From the worktree root, with the dev system running (`node scripts/dev-system.mjs dev marketplace-full`,
or `admin-web` for admin):

```powershell
node --import tsx deployables/corten-pilot/scripts/export.mjs   # first: writes platform/tokens.json and public/favicon.svg, which are not committed
node deployables/corten-pilot/scripts/sign-in.mjs http://localhost:7753 artifacts/corten-pilot/marketplace-state.json marketplace
cd deployables/corten-pilot/marketplace; corten dev --port 7792    # or admin/, public/
cd ..
corten check                                    # cargo fmt, corten fmt, clippy -D warnings, the scripts' types, cargo test
node --import tsx scripts/export.mjs --check    # the exported text, nav, tokens and defaults match the React sources
node scripts/smoke-<screen>.mjs                 # a screen in a browser, with and without JavaScript (each script's header says its arguments)
node scripts/measure.mjs screen=<screen> marketplace=http://localhost:7753 pilot=http://localhost:7792
```

`corten check` needs TypeScript on the `PATH` to type-check the apps' scripts (CI puts the repo's
`node_modules/.bin` there). The pilot has no image and nothing deploys it: the root `.dockerignore`
keeps it out of the platform image, and a `deployables/*/Dockerfile` would make every pilot PR build
and preview the platform.

| Variable | Default | |
|---|---|---|
| `PLATFORM_API_ORIGIN` | `http://localhost:7762` | the platform API the apps call |
| `ADMIN_WEB_ORIGIN` | `http://localhost:7752` | admin: sign-in and the admin pages the nav links to |
| `MARKETPLACE_WEB_ORIGIN` | `http://localhost:7753` | marketplace: sign-in and the pages the nav links to |
| `PUBLIC_PROTO` | `http` | the scheme forwarded to the API as `x-forwarded-proto` |
| `CHASE_SETS_PUBLIC_ORIGIN` | `https://chasesets.com` | public: the canonical origin (canonical links, the sitemap, the host the API is told) |
| `CHASE_SETS_MARKETPLACE_ORIGIN` | `https://marketplace.chasesets.com` | public: where Buy or sell links go |
| `CHASE_SETS_PUBLIC_INDEXING` | on | public: `0`, `false`, `no` or `off` adds `noindex`, closes `robots.txt` and empties the sitemap |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:7754` | public: public-web's pages it does not serve (the developer pages, `llms.txt`) and its analytics endpoint |
| `PROXIES` | none | every app (read by Corten): the proxies in front, comma separated addresses or networks (`10.0.0.0/8`), whose `X-Forwarded-For` `ClientIp` follows back to the visitor; without it the visitor is the connection's peer. Set it where a deploy would have set `CHASE_SETS_TRUST_FORWARDED_HEADERS` for the Node apps. public's Join sends the address to the API |
| `CHASE_SETS_DISCORD_INVITE_URL` | none | public: the Discord invite the home page links, when set |

The [export](scripts/export.mjs) writes what the apps read from Chase Sets' sources: each screen's English
text (`*/locales/*.en.json`), each app's navigation, admin's defaults, the design system's tokens
and fonts, and public's policy and developer documents. Run it after `main` changes them; the CI
job runs it with `--check`. `*/locales/pilot.en.json` is the pilot's own text. The two outputs that
carry the brand foil's colors, `platform/tokens.json` and `public/favicon.svg`, are written on every
run and not committed: the structure gate allows those values only in the design system's own
registered files.

## Corten pin

`Cargo.toml` pins Corten to `723c5e2` (Corten `main` on 2026-10-29). No release is tagged. The
pin moves forward only on purpose, when a fix the pilot needs lands, and each move is its own
commit that says what changed. The history of every move is in the
[README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("Corten pin") and in `git log -- deployables/corten-pilot/Cargo.toml`.

## Layout

1. `platform/` is the library the apps share: the API caller and its errors (`api.rs`), write
   receipts (`receipt.rs`), the realtime relay, jobs, the session, nav, theme, charts and money.
2. `admin/`, `marketplace/` and `public/` are the apps. In each, `src/app.rs` declares every
   route by area (each area is a screen with its own stylesheet and the caller, the permission, its
   handlers take), `src/api.rs` the API calls and types, one module per screen with its view in
   `src/views/<screen>_page.{rs,css,js}`, and `src/tests.rs` drives every route against an
   in-process stand-in of the API.
3. `scripts/` holds the export, the sign-in helper, the browser smokes and the measurements.

## How the pilot works

1. A write is its own typed route. One the API applies redirects (303) with the write's receipt
   (`?after_write=`), and the read after it waits for that receipt; a read still catching up is a
   short page that reads itself again. A refusal draws the form again with the API's words (422),
   an API failure is a 502, an unknown thing a 404, a missing permission a 403, and someone signed
   out goes to sign-in and back.
2. Every page works without JavaScript: links are links and forms post. Scripts add live updates,
   in-place patches and third-party widgets (Stripe) to server-rendered HTML.
3. Every screen is responsive: one column on a phone, tables as a card per row below 48rem, wider
   layouts from 48rem or 64rem, and no sideways scroll at 390 px. Each port is checked in a browser
   at 390 and 1280 px and without JavaScript against the dev sandbox.
4. User-facing words come from the React apps' catalogs through the export, so the two say the
   same thing; a page never shows an API's raw code where marketplace shows words.
5. A rule the pilot needs but marketplace computes in its web layer is copied into the pilot with
   a comment linking the Chase Sets issue that asks the API to own it.

## Open workarounds

### Corten

| Gap | Workaround | Remove when |
|---|---|---|
| [todd-skelton/corten#319 A page relayed by <corten-live> cannot ask a browser without JavaScript to read it again](https://github.com/todd-skelton/corten/issues/319) | `bulk_reprice::render` and `recommendations::render` write `<noscript><meta http-equiv="refresh" content="2"></noscript>` while a job runs | [todd-skelton/corten#340 ReadAgain::without_javascript: a page a <corten-live> keeps fresh asks only a browser without JavaScript to reload](https://github.com/todd-skelton/corten/pull/340), merged on Corten `main` as `70d2fa1f`: move the pin and use `ReadAgain::without_javascript` |
| [todd-skelton/corten#341 A nav built from data, or whose current entry is the deepest that holds the page, keeps the first page's aria-current after a client navigation](https://github.com/todd-skelton/corten/issues/341) | `markNav` in `marketplace/static/app.js` and `admin/static/app.js`, with `data-nav-path` on the nav links | fixed on Corten `main` after `723c5e2` by [todd-skelton/corten#342 req.nav_of: a whole nav, with only the deepest entry that holds the page current](https://github.com/todd-skelton/corten/pull/342), and after a patch by [todd-skelton/corten#348 The runtime marks nav links after a patch that puts one on the page](https://github.com/todd-skelton/corten/pull/348) (`9c589685`): move the pin, use `req.nav_of` and drop `markNav` |
| [todd-skelton/corten#310 A #[route(prefix)] field inside a #[route(query)] set is written into links but Params reads it back empty](https://github.com/todd-skelton/corten/issues/310) | `items::Address` and `search::Terms` keep a hand-written `Deserialize` over the raw query | [todd-skelton/corten#312 A query set is read the way a route reads its own, so its prefix fields round-trip](https://github.com/todd-skelton/corten/pull/312) merges |
| [todd-skelton/corten#307 A script's relative import of another script module is not preloaded, so the page waits a round trip for it, and the guide does not describe it](https://github.com/todd-skelton/corten/issues/307) | none: `stripe.js` loads one round trip after the step's script | [todd-skelton/corten#308 A script's relative imports of other script modules are preloaded with it](https://github.com/todd-skelton/corten/pull/308), merged on Corten `main` as `e4512627`: move the pin; a relative import must then name a listed script |
| [todd-skelton/corten#415 A handler that answers a file cannot answer a page or a redirect when the file is refused](https://github.com/todd-skelton/corten/issues/415) | `channels::manual_sync_download` relays a 303 to the connection with `?manual=failed`, and the page shows the failure | Corten has an answer that is a file or a page: draw the connection with why |

Every Corten gap the pilot found and how it closed is in the [README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("Corten gaps").

### Chase Sets

Each issue below is open and cited in the pilot's code, where the comment says what the pilot does
instead. Remove the workaround when the issue closes.

| Issue | Cited in |
|---|---|
| [chase-sets/chase-sets#9995 [checkout] Apply Sell List commands exactly once and converge the Offer handoff](https://github.com/chase-sets/chase-sets/issues/9995) | [marketplace/src/selling.rs](marketplace/src/selling.rs), [marketplace/src/api.rs](marketplace/src/api.rs) |
| [chase-sets/chase-sets#8766 Show every seller attention source in the Desk Needs you queue](https://github.com/chase-sets/chase-sets/issues/8766) | [scripts/smoke-market-desk.mjs](scripts/smoke-market-desk.mjs), [marketplace/src/views/desk_page.rs](marketplace/src/views/desk_page.rs) |
| [chase-sets/chase-sets#8830 Complete Sell List Offer lines from inventory when the seller has no Listing](https://github.com/chase-sets/chase-sets/issues/8830) | [scripts/smoke-market-item-sell.mjs](scripts/smoke-market-item-sell.mjs), [marketplace/src/selling.rs](marketplace/src/selling.rs) |
| [chase-sets/chase-sets#10505 [checkout] Build and keep the Sell List review plan in the Checkout API](https://github.com/chase-sets/chase-sets/issues/10505) | [marketplace/src/sell_list.rs](marketplace/src/sell_list.rs), [marketplace/src/sell_checkout.rs](marketplace/src/sell_checkout.rs) |
| [chase-sets/chase-sets#10507 [catalog] Compose the Catalog integrations surfaces in the Catalog API](https://github.com/chase-sets/chase-sets/issues/10507) | [admin/src/catalog/attention.rs](admin/src/catalog/attention.rs), [admin/src/catalog/scope.rs](admin/src/catalog/scope.rs), [admin/src/catalog/scopes.rs](admin/src/catalog/scopes.rs), [admin/src/catalog/views/scope_page.rs](admin/src/catalog/views/scope_page.rs) |
| [chase-sets/chase-sets#10524 Release a realtime stream's lease when the client drops it before the headers](https://github.com/chase-sets/chase-sets/issues/10524) | [platform/src/realtime.rs](platform/src/realtime.rs) |
| [chase-sets/chase-sets#10530 Give removing draft Catalog Items a bulk preview and job like the other item bulk actions](https://github.com/chase-sets/chase-sets/issues/10530) | [admin/src/catalog/items.rs](admin/src/catalog/items.rs) |
| [chase-sets/chase-sets#10537 Let the Catalog Item Set Image URLs dialog take one URL per line](https://github.com/chase-sets/chase-sets/issues/10537) | [scripts/smoke-item.mjs](scripts/smoke-item.mjs) |
| [chase-sets/chase-sets#10538 Stop concurrent Product Contents edits from silently dropping each other's lines](https://github.com/chase-sets/chase-sets/issues/10538) | [admin/src/catalog/item.rs](admin/src/catalog/item.rs) |
| [chase-sets/chase-sets#10549 Wait only on a Catalog Item's own projections when reading it after a write](https://github.com/chase-sets/chase-sets/issues/10549) | [scripts/smoke-item.mjs](scripts/smoke-item.mjs) |
| [chase-sets/chase-sets#10565 Filter Scope Records by language edition across every page, not only the page shown](https://github.com/chase-sets/chase-sets/issues/10565) | [admin/src/catalog/scopes.rs](admin/src/catalog/scopes.rs) |
| [chase-sets/chase-sets#10569 Show the alias type in a Catalog attention queue alias candidate's detail instead of {type}](https://github.com/chase-sets/chase-sets/issues/10569) | [admin/src/catalog/attention.rs](admin/src/catalog/attention.rs) |
| [chase-sets/chase-sets#10572 Let the seed seller record the seeded restock decision instead of Restock decision not found](https://github.com/chase-sets/chase-sets/issues/10572) | [scripts/smoke-restock.mjs](scripts/smoke-restock.mjs) |
| [chase-sets/chase-sets#10576 Draw each cart line's readiness from the cart read instead of recomputing it in the cart page](https://github.com/chase-sets/chase-sets/issues/10576) | [marketplace/src/cart.rs](marketplace/src/cart.rs) |
| [chase-sets/chase-sets#10581 Start a cart's payment when the buyer presses Pay, not when the checkout page loads](https://github.com/chase-sets/chase-sets/issues/10581) | [marketplace/src/checkout.rs](marketplace/src/checkout.rs) |
| [chase-sets/chase-sets#10592 [checkout] Take a sell-list line's title and product summary from the catalog, not the request](https://github.com/chase-sets/chase-sets/issues/10592) | [marketplace/src/selling.rs](marketplace/src/selling.rs) |
| [chase-sets/chase-sets#10595 [discovery] Check a Product Alert's item and product against the catalog, and take its summary from it](https://github.com/chase-sets/chase-sets/issues/10595) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/watching.rs](marketplace/src/watching.rs) |
| [chase-sets/chase-sets#10596 [discovery] Create an account Product Alert once when the same create is sent twice](https://github.com/chase-sets/chase-sets/issues/10596) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/watching.rs](marketplace/src/watching.rs) |
| [chase-sets/chase-sets#10597 [discovery] Say a Watch alert was saved after Set alert on the item page](https://github.com/chase-sets/chase-sets/issues/10597) | [marketplace/src/watching.rs](marketplace/src/watching.rs) |
| [chase-sets/chase-sets#10598 [discovery] Let List for sale on the item page list a graded product (it never sends graded card details)](https://github.com/chase-sets/chase-sets/issues/10598) | [marketplace/src/listing.rs](marketplace/src/listing.rs) |
| [chase-sets/chase-sets#10606 [platform-operations] Give the Operations Attention queue's Open links their admin section (every one is a 404)](https://github.com/chase-sets/chase-sets/issues/10606) | [admin/src/operations/mod.rs](admin/src/operations/mod.rs), [scripts/smoke-operations-attention.mjs](scripts/smoke-operations-attention.mjs) |
| [chase-sets/chase-sets#10607 [platform-operations] Register and publish the Operations Attention realtime topic (the API refuses it, so the queue never goes live)](https://github.com/chase-sets/chase-sets/issues/10607) | [admin/src/operations/mod.rs](admin/src/operations/mod.rs), [scripts/smoke-operations-attention.mjs](scripts/smoke-operations-attention.mjs) |
| [chase-sets/chase-sets#10609 [discovery] Search answers 500 on the first request after a quiet minute](https://github.com/chase-sets/chase-sets/issues/10609) | [scripts/smoke-market-search.mjs](scripts/smoke-market-search.mjs) |
| [chase-sets/chase-sets#10612 [discovery] Answer an unknown set page with 404, and a failed set read with 5xx, not 200](https://github.com/chase-sets/chase-sets/issues/10612) | [scripts/smoke-market-set.mjs](scripts/smoke-market-set.mjs), [marketplace/src/sets.rs](marketplace/src/sets.rs) |
| [chase-sets/chase-sets#10614 [discovery] Tell a visitor their listing report was received (the page ignores ?reported=1)](https://github.com/chase-sets/chase-sets/issues/10614) | [marketplace/src/public_listing.rs](marketplace/src/public_listing.rs) |
| [chase-sets/chase-sets#10615 [discovery] A repeat listing report shows a 500 page instead of saying it was already reported](https://github.com/chase-sets/chase-sets/issues/10615) | [marketplace/src/public_listing.rs](marketplace/src/public_listing.rs) |
| [chase-sets/chase-sets#10619 [discovery] An unknown account page answers 200, and a failed account read reads as not found](https://github.com/chase-sets/chase-sets/issues/10619) | [marketplace/src/accounts.rs](marketplace/src/accounts.rs), [scripts/smoke-market-account.mjs](scripts/smoke-market-account.mjs) |
| [chase-sets/chase-sets#10625 [notifications] Delivery settings show unlabeled 'sms' and 'rcs' switches for channels the platform does not deliver](https://github.com/chase-sets/chase-sets/issues/10625) | [marketplace/src/notifications.rs](marketplace/src/notifications.rs), [scripts/smoke-market-notifications.mjs](scripts/smoke-market-notifications.mjs) |
| [chase-sets/chase-sets#10627 [discovery] Pausing, resuming or deleting a Product alert shows its old status: the redirect carries no write receipt](https://github.com/chase-sets/chase-sets/issues/10627) | [marketplace/src/notifications.rs](marketplace/src/notifications.rs) |
| [chase-sets/chase-sets#10629 [pricing] The public market page's stat values are h2 headings, so a screen reader lists "$44.50" and "3" as sections](https://github.com/chase-sets/chase-sets/issues/10629) | [scripts/smoke-public-market.mjs](scripts/smoke-public-market.mjs) |
| [chase-sets/chase-sets#10633 [ordering] Order pages show status codes (ready-for-fulfillment, standard, active) where the same page elsewhere writes words](https://github.com/chase-sets/chase-sets/issues/10633) | [marketplace/src/views/order_page.rs](marketplace/src/views/order_page.rs) |
| [chase-sets/chase-sets#10634 [ordering] A purchase's delivery_summary.latest_delivered_at is Postgres text (2026-03-22 12:00:00+00), not ISO 8601](https://github.com/chase-sets/chase-sets/issues/10634) | [marketplace/src/views/order_page.rs](marketplace/src/views/order_page.rs) |
| [chase-sets/chase-sets#10635 [ordering] A purchase page offers Cancel to a member without orders.manage (an unverified email), and the action then answers Forbidden](https://github.com/chase-sets/chase-sets/issues/10635) | [marketplace/src/orders.rs](marketplace/src/orders.rs) |
| [chase-sets/chase-sets#10638 [fulfillment] Serve the seller's shipment command center (buckets, order and each next action) from the Fulfillment API instead of building it in the web host](https://github.com/chase-sets/chase-sets/issues/10638) | [marketplace/src/app.rs](marketplace/src/app.rs), [scripts/smoke-market-shipments.mjs](scripts/smoke-market-shipments.mjs), [marketplace/src/shipments.rs](marketplace/src/shipments.rs), [marketplace/src/views/market_nav.rs](marketplace/src/views/market_nav.rs), [marketplace/src/views/order_page.rs](marketplace/src/views/order_page.rs) |
| [chase-sets/chase-sets#10641 [fulfillment] A shipment page says each empty state twice ("No shipment exceptions recorded." as the title and again as the description)](https://github.com/chase-sets/chase-sets/issues/10641) | [scripts/smoke-market-shipments.mjs](scripts/smoke-market-shipments.mjs) |
| [chase-sets/chase-sets#10644 [public-presence] Waitlist signups through public-web share one rate-limit bucket because no client address reaches the API](https://github.com/chase-sets/chase-sets/issues/10644) | [scripts/smoke-public-home.mjs](scripts/smoke-public-home.mjs) |
| [chase-sets/chase-sets#10645 Let the seed seller pack a seeded shipment instead of Shipment mutation authority is unavailable](https://github.com/chase-sets/chase-sets/issues/10645) | [scripts/smoke-market-packing.mjs](scripts/smoke-market-packing.mjs) |
| [chase-sets/chase-sets#10649 [marketplace] Refuse a listing photo the API cannot decode instead of answering 500](https://github.com/chase-sets/chase-sets/issues/10649) | [marketplace/src/listing_new.rs](marketplace/src/listing_new.rs), [marketplace/src/seller_listing.rs](marketplace/src/seller_listing.rs), [marketplace/src/uploads.rs](marketplace/src/uploads.rs) |
| [chase-sets/chase-sets#10653 [marketplace] The listings page's Paused listings card shows the raw template '{count} paused {label}'](https://github.com/chase-sets/chase-sets/issues/10653) | [marketplace/src/views/seller_listings_page.rs](marketplace/src/views/seller_listings_page.rs) |
| [chase-sets/chase-sets#10660 [marketplace] An unverified account can submit an offer but cannot withdraw it (submit needs no offers.manage; pause, resume and withdraw do)](https://github.com/chase-sets/chase-sets/issues/10660) | [marketplace/src/auth.rs](marketplace/src/auth.rs), [scripts/smoke-market-offer-matches.mjs](scripts/smoke-market-offer-matches.mjs), [scripts/smoke-market-submitted-offers.mjs](scripts/smoke-market-submitted-offers.mjs) |
| [chase-sets/chase-sets#10672 [platform-runtime] Inventory reads with a write's receipt time out for ~30 s while unrelated Inventory projections sit two positions behind](https://github.com/chase-sets/chase-sets/issues/10672) | [scripts/smoke-market-inventory.mjs](scripts/smoke-market-inventory.mjs) |
| [chase-sets/chase-sets#10673 [inventory] The item page's Stock Ledger labels an offline sale with the raw code offline-sale](https://github.com/chase-sets/chase-sets/issues/10673) | [marketplace/src/views/inventory_item_page.rs](marketplace/src/views/inventory_item_page.rs) |
| [chase-sets/chase-sets#10682 [pricing] Compile Repricing Presets in the Pricing API now that a second client authors policies from them](https://github.com/chase-sets/chase-sets/issues/10682) | [marketplace/src/repricing.rs](marketplace/src/repricing.rs) |
| [chase-sets/chase-sets#10683 [checkout] Read the checkout fee quote from Payments instead of quoting the compiled default policy in the web loader](https://github.com/chase-sets/chase-sets/issues/10683) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/checkout.rs](marketplace/src/checkout.rs) |
| [chase-sets/chase-sets#10688 [identity] A profile update accepts a blank legal or marketplace name, so an account's name can be saved empty](https://github.com/chase-sets/chase-sets/issues/10688) | [marketplace/src/views/account_home_page.rs](marketplace/src/views/account_home_page.rs), [marketplace/src/views/security_page.rs](marketplace/src/views/security_page.rs) |
| [chase-sets/chase-sets#10695 [identity] A user's API key list shows other users' keys whose name or owner mentions the user's id, with the owner's email](https://github.com/chase-sets/chase-sets/issues/10695) | [marketplace/src/api.rs](marketplace/src/api.rs) |
| [chase-sets/chase-sets#10697 [auth] A user's session list shows other users' sessions whose name, email or account mentions the user's id](https://github.com/chase-sets/chase-sets/issues/10697) | [marketplace/src/api.rs](marketplace/src/api.rs) |
| [chase-sets/chase-sets#10698 [auth] Session switch-account and revoke answer 500 for every refusal, so marketplace's Switch Account always fails for a one-account user](https://github.com/chase-sets/chase-sets/issues/10698) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/sessions.rs](marketplace/src/sessions.rs) |
| [chase-sets/chase-sets#10699 [auth] Marketplace's sessions page ignores its status filter, search and pages, always showing the first 50](https://github.com/chase-sets/chase-sets/issues/10699) | [marketplace/src/sessions.rs](marketplace/src/sessions.rs) |
| [chase-sets/chase-sets#10702 [catalog] Scope Detail's alias Accept, Reject, Revoke and Defer each say "Command queued", and Defer writes nothing](https://github.com/chase-sets/chase-sets/issues/10702) | [admin/src/catalog/scope.rs](admin/src/catalog/scope.rs) |
| [chase-sets/chase-sets#10703 [catalog] Return a scope's language-edition link states and journey from the Catalog API instead of deriving them in admin-web](https://github.com/chase-sets/chase-sets/issues/10703) | [admin/src/catalog/scope.rs](admin/src/catalog/scope.rs) |
| [chase-sets/chase-sets#10704 [identity] An account's team lists other accounts' memberships and invitations whose names or emails mention the account's id](https://github.com/chase-sets/chase-sets/issues/10704) | [marketplace/src/api.rs](marketplace/src/api.rs) |
| [chase-sets/chase-sets#10707 [identity] A security.manage owner can list another user's or account's consents by naming its ids, or every consent by naming neither](https://github.com/chase-sets/chase-sets/issues/10707) | [marketplace/src/api.rs](marketplace/src/api.rs) |
| [chase-sets/chase-sets#10710 [platform-operations] List each blocked projection's streams and poison events in the projections read (the repair queue and Operations Attention show none)](https://github.com/chase-sets/chase-sets/issues/10710) | [admin/src/projections/api.rs](admin/src/projections/api.rs), [admin/src/projections/mod.rs](admin/src/projections/mod.rs), [admin/src/projections/views/detail_sheet.rs](admin/src/projections/views/detail_sheet.rs), [scripts/smoke-projections.mjs](scripts/smoke-projections.mjs) |
| [chase-sets/chase-sets#10245 [auth] Make registration non-committal: create accounts on a verified email link](https://github.com/chase-sets/chase-sets/issues/10245) | [marketplace/src/register.rs](marketplace/src/register.rs) |
| [chase-sets/chase-sets#10793 [identity] Account-management writes answer a request they refuse during validation as 503 INDETERMINATE instead of a 4xx refusal](https://github.com/chase-sets/chase-sets/issues/10793) | [marketplace/src/team.rs](marketplace/src/team.rs) |
| [chase-sets/chase-sets#10795 [auth] A team invitation is saved but not emailed: the acceptance-link request answers 404 before Auth's invitation projection catches up](https://github.com/chase-sets/chase-sets/issues/10795) | [marketplace/src/team.rs](marketplace/src/team.rs) |
| [chase-sets/chase-sets#10789 [inventory] Derive a graded inventory item's grading company and grade from its selected options instead of requiring the form to send them](https://github.com/chase-sets/chase-sets/issues/10789) | [marketplace/src/inventory_list.rs](marketplace/src/inventory_list.rs) |
| [chase-sets/chase-sets#10724 [platform-operations] Return each Support Request's customer remedy status and next deadline from the list reads, and enforce intake photos in the API](https://github.com/chase-sets/chase-sets/issues/10724) | [marketplace/src/support_list.rs](marketplace/src/support_list.rs) |
| [chase-sets/chase-sets#10749 [checkout] Return each Sell List line's readiness and the list's payout totals from the Sell List read](https://github.com/chase-sets/chase-sets/issues/10749) | [marketplace/src/sell_list.rs](marketplace/src/sell_list.rs) |
| [chase-sets/chase-sets#10753 [checkout] Work out seller checkout's seller readiness in the Checkout API instead of trusting the evidence the page posts](https://github.com/chase-sets/chase-sets/issues/10753) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/sell_checkout.rs](marketplace/src/sell_checkout.rs) |
| [chase-sets/chase-sets#10754 [checkout] Run seller checkout's Marketplace handoff in the Checkout API and record the summary it observed](https://github.com/chase-sets/chase-sets/issues/10754) | [marketplace/src/sell_checkout.rs](marketplace/src/sell_checkout.rs) |
| [chase-sets/chase-sets#10772 [pricing] Bulk reprice is offered and its page drawn while Pricing has it switched off](https://github.com/chase-sets/chase-sets/issues/10772) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/bulk_reprice.rs](marketplace/src/bulk_reprice.rs) |
| [chase-sets/chase-sets#10778 [channels] Return the connectable providers and each connection's allowed actions from the Channels API](https://github.com/chase-sets/chase-sets/issues/10778) | [marketplace/src/channels.rs](marketplace/src/channels.rs) |
| [chase-sets/chase-sets#10779 [channels] Disconnect answers no commit receipt, so the read after it still shows the connection before the disconnect](https://github.com/chase-sets/chase-sets/issues/10779) | [marketplace/src/channels.rs](marketplace/src/channels.rs) |
| [chase-sets/chase-sets#10804 [platform-runtime] The platform worker exits silently when a startup database step fails once](https://github.com/chase-sets/chase-sets/issues/10804) | none in code: the local sandbox reruns the worker by touching `deployables/platform-worker/src/main.ts` |
| [chase-sets/chase-sets#10809 [channels] A stale publication write shows 'Channels API error 409' instead of 'Settings changed'](https://github.com/chase-sets/chase-sets/issues/10809) | none: the pilot answers the 409 with the conflict notice ([marketplace/src/channels.rs](marketplace/src/channels.rs)) |
| [chase-sets/chase-sets#10812 [channels] A refused manual sync download shows Channels' JSON error instead of the connection](https://github.com/chase-sets/chase-sets/issues/10812) | none: the pilot goes back to the connection and says the download failed ([marketplace/src/channels.rs](marketplace/src/channels.rs)) |

These are closed and still cited in the pilot's code as the decision or fix the code relies on.
None of them leaves a workaround behind:

| Issue | Cited in |
|---|---|
| [chase-sets/chase-sets#7905 Decision: the plain-language repricing preset catalog and the complete AST each preset compiles to](https://github.com/chase-sets/chase-sets/issues/7905) | [marketplace/src/repricing.rs](marketplace/src/repricing.rs) |
| [chase-sets/chase-sets#10504 [checkout] Return Cart readiness, subtotal and savings from the cart read](https://github.com/chase-sets/chase-sets/issues/10504) | [marketplace/src/cart.rs](marketplace/src/cart.rs) |
| [chase-sets/chase-sets#10520 Let the Catalog API reorder a dimension's options instead of refusing every reorder](https://github.com/chase-sets/chase-sets/issues/10520) | [scripts/smoke-catalog.mjs](scripts/smoke-catalog.mjs) |
| [chase-sets/chase-sets#10558 [discovery] Return item-detail Listings and Offers in canonical order with each product's lowest Listing and best Offer](https://github.com/chase-sets/chase-sets/issues/10558) | [marketplace/src/items.rs](marketplace/src/items.rs) |
| [chase-sets/chase-sets#10610 [discovery] Search says No items found when the search read fails](https://github.com/chase-sets/chase-sets/issues/10610) | [marketplace/src/views/search_page.rs](marketplace/src/views/search_page.rs) |
| [chase-sets/chase-sets#10686 [auth] Password sign-in failures through the web hosts share one IP bucket: five wrong passwords lock everyone out for five minutes](https://github.com/chase-sets/chase-sets/issues/10686) | [marketplace/src/sign_in.rs](marketplace/src/sign_in.rs), [scripts/smoke-sign-in.mjs](scripts/smoke-sign-in.mjs) |
| [chase-sets/chase-sets#10687 [auth] A return address or magic-link path starting with /\ passes Auth's same-site check and leads to another site after sign-in](https://github.com/chase-sets/chase-sets/issues/10687) | [marketplace/src/sign_in.rs](marketplace/src/sign_in.rs) |
