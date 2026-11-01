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
| `admin/` | Catalog > Scope Coverage (the Unmapped Scope Inbox), `/catalog/scope-coverage` (`?product_domain=`), and a scope's coverage, `/catalog/scope-coverage/{id}` (the scope page's coverage matrix, whose writes come back here) |
| `admin/` | Catalog > a Source Observation, `/catalog/source-observations/{id}`: its image and values as admin-web lists them (a Pokemon card's and a provider product's own), and Promote (observed or changed) and Reject with its reason (observed), for `catalog.manage`; a refusal is the form's message |
| `admin/` | Catalog > Scope Sync Batches, `/catalog/scopes/sync-batches` (`?batch_id=`, `?quote_id=`): resolve a TCGplayer held-set export, preview a batch and confirm it, quote and acquire capped counts, and a batch's progress (read again every 2 seconds while it is queued or running) with Cancel, Resume and Retry unit. admin-web's staging count-capture steps (`countCapture`) are not served |
| `admin/` | Platform > Attention Queue, `/platform/operations-attention` |
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}`, with its Publish, Set Field Value and Add content line dialogs |
| `admin/` | Catalog's home, `/catalog`, a dimension's and a field's page, `/catalog/dimensions/{id}`, `/catalog/fields/{id}`, and the scope attention review, `/catalog/scopes/attention/review` |
| `admin/` | Catalog > Categories, `/catalog/categories` (search, status, hierarchy and parent filters, bulk publish, deprecate and archive), and a category's page, `/catalog/categories/{id}` |
| `admin/` | Catalog > Components, `/catalog/components` (search, status and has-rules filters, bulk changes), and a component's page, `/catalog/components/{id}`, with its field and dimension rules (add, remove) |
| `admin/` | Catalog > Blueprints, `/catalog/blueprints` (search, status, has-components and has-rules filters, bulk changes), and a blueprint's page, `/catalog/blueprints/{id}`, with its components (attach, detach) and its field, dimension and product resolution rules (set, from dialogs the server draws when opened) |
| `admin/` | Catalog > Display Templates, `/catalog/display-templates` (search, status and target kind filters, create), and a display template's page, `/catalog/display-templates/{id}` (edit, publish, deprecate, archive) |
| `admin/` | Catalog > Reference Types, `/catalog/reference-types` (search, status and attribute key filters, bulk publish, deprecate and archive, create), and a reference type's page, `/catalog/reference-types/{id}` (edit, publish, deprecate, archive) |
| `admin/` | Catalog > Reference Data, `/catalog/reference-records` (search, status, type, relationship and attribute filters, bulk publish, deprecate and archive, create), and a reference record's page, `/catalog/reference-records/{id}` (its relationships; edit, publish, deprecate, archive). The create and edit dialogs are drawn by the server when opened, with corten-ui's combobox for each relationship's record |
| `admin/` | Access's home, `/access` (the attention queue and the account search), and Access > Accounts, Users, Memberships, Invitations and API Keys, `/access/accounts`, `/access/users`, `/access/memberships`, `/access/invitations`, `/access/api-keys` (search and status filters, pages), an account's workspace, `/access/accounts/{id}` (Overview, Team, API Access and Audit tabs and their 23 forms; a user's, a key's, a membership's or an invitation's page opens it on its tab), Access > Sessions, `/access/sessions` and a session's page (switch account, revoke), and Support > Reported Content, `/support/reported-content` (the counts, status and target filters) and a reported target's page (its reports and its target type's moderation actions), and Support > Risk Alerts, `/support/risk-alerts` (the counts, status and kind filters) and an alert's page (its evidence, threshold and responses), Support > Reference Lookup, `/support/reference-lookup`, Support > CSAT dashboard, `/support/csat` (rates, volume, filters, trend, distribution and the invitation queue's pages), and Support > Platform Feedback, `/support/platform-feedback` (the counts, status, topic and workflow filters, Mark selected reviewed and Archive selected, Export CSV) and a feedback's page (Mark reviewed, Archive, operator notes, related marketplace records), and Support > Support requests, `/support/requests` (status tabs, filters and their chips, Escalate overdue, pages) and a request's sheet (adjudication, the recommended action, checklist, notes, audit trail with its photos, full case context, and Respond, Escalate, Resolve, Note, Close and Cancel; a remedy opens on admin-web), and Support > eBay Deletion Lookup, `/support/ebay-account-deletion` (Production's subject data counts and a posted user ID's unexpired receipts; the sandbox has no Channels credential keyring, so its lookup always answers the banner), and Support > Customer Feedback, `/support/customer-feedback/attention` (the attention figures and the queue with each case's SLA), and Commerce > Return Intake, `/commerce/return-intake` (a facility's station: the scan, its figures, Complete facility intake with photos, Record unidentified package, Reconcile and Record correction), and Commerce > Recovered Returns, `/commerce/recovered-items` (the recovery figures and value, the custody and disposition queue, and the action form's nine actions), and Commerce > Commercial Terms, `/commerce/terms` (the published seller fee schedule, the active and scheduled terms, a schedule's and an override's sheet with Compare, Revision history and revise, Create schedule and Create account override), with admin-web's older addresses under `/commerce/terms/`, and Commerce > Money Health, `/commerce/money-health` (the balance forecast, provider diagnostics, negative balances, payouts needing attention and recent reconciliation), and Commerce > Payout Operations, `/commerce/payout-operations` (what needs attention, the payout setup's readiness, the filters and payouts, recent provider attempts, and a reconciliation run followed live until it is done), and Growth > Waitlist, `/growth/waitlist` (the signups by role, the invite waves' fill, the filters and the signups, with Export CSV relayed from the API) |
| `admin/` | Commerce > a postage policy, `/commerce/postage-policies/{id}` |
| `admin/` | Commerce > Wallet Workbench, `/commerce/wallet-workbench/{id}` (`?accountName=&status=&adjustmentsOffset=&ledgerOffset=`): the balance and payout standing, the guided credit or debit (preview, then Confirm & submit with the preview's balance revision), the adjustment history with Approve (with an elevated approver when needed), Reject and Reverse, each asking first in a dialog that opens without JavaScript, and the ledger. Each command answers with the page and its own snapshot of the adjustment; an account's workspace links here |
| `admin/` | Platform > Projections, `/platform/projections` and its settings and reference, `/platform/projections/reference` |
| `admin/` | Platform > Provider Connections, `/platform/provider-connections` (a `platform-admin` only, as admin-web), Platform > Insights > Offer Economics, `/platform/insights/offer-economics` (`?from=&to=`), Platform > Insights > Ops Dashboard, `/platform/insights/ops-dashboard` (`?rangeDays=&granularity=`; the figures, GMV over time as a line drawn on the server, liquidity, the top items and the reconciliation runs), and Platform > Policy Console, `/platform/policy-console` (the policies by context, Commercial Terms dates and public article reviews with Confirm current) a policy's page, `/platform/policy-console/{key}` (in effect, scheduled, history, and a revision in the operator's zone), and Platform > Listing Evidence Policy, `/platform/listing-evidence-policy` (the policy in effect, its versions with Validate, Reject and Create rollback draft, a validation's diff and Policy Impact Preview with Activate in the operator's zone, and the guided draft form drawn by the server) |
| `admin/` | Support's reference lookup, `/support/reference-lookup`, and Support > Reported Content, `/support/reported-content` and a target's page, `/support/reported-content/{type}/{id}` |
| `admin/` | Support > Risk Alerts, `/support/risk-alerts` and an alert's page, `/support/risk-alerts/{id}` |
| `admin/` | Support > Support Requests, `/support/requests`, a request's page, `/support/requests/{id}`, and its attachments |
| `admin/` | Support > CSAT, `/support/csat`; Platform Feedback, `/support/platform-feedback` and an entry's page, with its export; the customer feedback attention queue, `/support/customer-feedback/attention`; eBay account deletion, `/support/ebay-account-deletion` |
| `admin/` | Commerce > Return Intake, `/commerce/return-intake`, and Recovered Returns, `/commerce/recovered-items` |
| `admin/` | Commerce > Commercial Terms, `/commerce/terms`, with a schedule's and an override's sheet and both create sheets, and admin-web's older addresses under `/commerce/terms/` |
| `admin/` | Commerce > Money Health, `/commerce/money-health`, and Payout Operations, `/commerce/payout-operations` (`?job=`, followed live) |
| `admin/` | Growth > Google Shopping, `/growth/google-shopping` (filters, a row's detail, the three dry runs, a dry run followed live; live runs stay gated) |
| `admin/` | Growth > Waitlist, `/growth/waitlist`, with its CSV export, `/growth/waitlist/export`. Growth's pages call the same Public Presence routes as admin-web and inherit their access; see the private advisory GHSA-2v8j-2hqx-92fq before giving anyone the pilot's admin |
| `admin/` | Growth > Campaign Analytics, `/growth/campaign-analytics` |
| `admin/` | Sign in, `/access/sign-in` (and `/catalog/sign-in`, the same page), `/access/sign-in/magic`, `/access/account-select` and `/access/sign-out`, with Google Workspace and a passkey on admin-web; a signed-out page now signs in here. The frame's account menu has Switch account, Sessions and Sign out. Both apps sign in through `platform::auth` |
| `admin/` | The site's own files: `/favicon.svg`, `/favicon.ico`, the web app manifest and service worker (Corten's PWA, leaving admin-web's sign-in, the API and the health checks to the network) and `/offline` |
| `admin/` | Growth > Promo Bar, `/growth/promo-bar` (`?edit=`, `?delete=`), with Create, Edit, Activate, Deactivate and Delete |
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
| `marketplace/` | Buy > Cart, `/account/cart`, for an account or the guest cart a visitor or guest checkout carries |
| `marketplace/` | Buy > Checkout, `/checkout/buy/session/{id}`, and its confirmation, `/checkout/buy/session/{id}/confirmation`, for an account or a guest checkout, and an offer's checkout (Submit offer). Pay now is sent once: after an answer that may be lost, the session is read once, and Pay now stays off until a refresh if the read cannot tell |
| `marketplace/` | Checkout start, `/checkout/buy/readiness`, for a listing, an offer or the cart, and a guest's or visitor's Buy. Each entry is sent once with its key (a key that is not one sends nothing); after an answer that may be lost, its attempt is looked up once, and Continue stays off if the lookup cannot tell |
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
| `marketplace/` | An item's page, `/items/{slug}`. marketplace-web's JSON route `/items/{id}/market-history` is not served: its panel fetches it after load and on a range change, while the pilot keeps the range in the address (`range=`), reads the Sales tab's history with the page, and redraws it on each `item:{id}` change through the page's live parts, so nothing calls it |
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
| `marketplace/` | The site's own files: `/robots.txt`, the sitemap index `/sitemap.xml` and its pages `/sitemap/{kind}/{page}.xml` (the home page and search, then Discovery's public items, categories, sellers, listings and sets), `/favicon.svg`, `/favicon.ico`, `/.well-known/appspecific/com.chrome.devtools.json`, the web app manifest and service worker (Corten's PWA, leaving marketplace-web's private paths to the network) and `/offline` |
| `marketplace/` | The item page's and search's analytics, `POST /analytics/item-detail-rail`: it refuses what marketplace-web's refuses and logs the rest with its fields (the pilot has no metrics yet, so there is no `chase_sets_marketplace_item_detail_rail_events_total`). The pages send a search result opened (`search_result_selected`, with its position and the search's keys), a similar item opened, Buy, Sell or Watch chosen in the rail or the mobile dock (`rail_intent_selected`), and the rail's own: a section opened (`workflow_selected`), a form sent with the button that sent it (`intent_submit_started`), a refused form's message (`validation_failed`), the offer's payout preview or its absence, and the create-listing registration gate shown and followed. Not sent, as the pilot has nothing they count: `reference_info_opened` (the pilot writes the reference text in the rail, with no popup) and the buyer and accept-offer registration gates (a guest makes an offer or adds it to a Sell List instead) |
| `marketplace/` | The shell on every page but `/offline`: the top bar, the account menu with Sign Out (a member), Exit guest checkout (a guest checkout), Sign In and Register (a visitor), and below 48rem the bottom bar of five with its groups, from marketplace's top-nav, bottom-nav and account-menu contributions. The server draws the cart's count with each full load, with or without JavaScript (`marketplace/src/chrome.rs`, read beside the page's own reads; a client navigation keeps the layout and reads nothing), and a visitor's cart entry is hidden while it holds 0, as marketplace hides it. An item page's add is a full-load form post, so it redraws the count; the cart page's writes keep the header, so the cart page sets the count its own read found (`badge::known`). Pages with their own bottom bar (checkout, the item dock, offer matches, packing) sit above it |
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
node --import tsx deployables/corten-pilot/scripts/export.mjs   # first: writes platform/tokens.json and the favicons, which are not committed
node deployables/corten-pilot/scripts/sign-in.mjs http://localhost:7753 artifacts/corten-pilot/marketplace-state.json marketplace
cd deployables/corten-pilot/marketplace; corten dev --port 7792    # or admin/, public/
cd ..
corten check                                    # cargo fmt, corten fmt, clippy -D warnings, the scripts' types, cargo test
node --import tsx scripts/export.mjs --check    # the exported text, nav, tokens and defaults match the React sources
node scripts/smoke-<screen>.mjs                 # a screen in a browser, with and without JavaScript (each script's header says its arguments)
node scripts/sweep.mjs <app> <pilot-url> [state] # every page at 390 px without JavaScript and 1280 px with it: overflow, failures and console errors
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
| `CHASE_SETS_MARKETPLACE_INDEXING` | on | marketplace: `0`, `false`, `no` or `off` closes `robots.txt` and empties the sitemaps |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:7754` | public: public-web's pages it does not serve (the developer pages, `llms.txt`) and its analytics endpoint |
| `PROXIES` | none | every app (read by Corten): the proxies in front, comma separated addresses or networks (`10.0.0.0/8`), whose `X-Forwarded-For` `ClientIp` follows back to the visitor; without it the visitor is the connection's peer. Set it where a deploy would have set `CHASE_SETS_TRUST_FORWARDED_HEADERS` for the Node apps. public's Join sends the address to the API |
| `CHASE_SETS_DISCORD_INVITE_URL` | none | public: the Discord invite the home page links, when set |

The [export](scripts/export.mjs) writes what the apps read from Chase Sets' sources: each screen's English
text (`*/locales/*.en.json`), each app's navigation, admin's defaults, the design system's tokens
and fonts, and public's policy and developer documents. Run it after `main` changes them; the CI
job runs it with `--check`. `*/locales/pilot.en.json` is the pilot's own text. The two outputs that
carry the brand foil's colors, `platform/tokens.json` and the three apps' `favicon.svg`, are written on every
run and not committed: the structure gate allows those values only in the design system's own
registered files.

## Corten pin

`Cargo.toml` pins Corten to `0552f17d` (Corten `main` on 2026-11-01, after the first kit-gaps merge). No release is tagged. The
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
| [todd-skelton/corten#341 A nav built from data, or whose current entry is the deepest that holds the page, keeps the first page's aria-current after a client navigation](https://github.com/todd-skelton/corten/issues/341) | `markNav` in `marketplace/static/app.js` and `admin/static/app.js`, with `data-nav-path` on the nav links | Corten's fix ([todd-skelton/corten#342 req.nav_of: a whole nav, with only the deepest entry that holds the page current](https://github.com/todd-skelton/corten/pull/342)) takes only links on the app's own origin, and both navs still link to marketplace-web or admin-web for the pages the pilot does not serve: use `req.nav_of` once a nav's entries are all the pilot's |
| [todd-skelton/corten#580 A layout value read the guide's way is passed through every handler and helper that can draw the layout, so one cart count touched 172 handlers in a real app](https://github.com/todd-skelton/corten/issues/580) | `chrome::Chrome` is an extractor on every handler that can draw the layout (writes included), lent to the helpers that draw it, with a `OnceCell` so each branch awaits one read; synchronous closures take the awaited count; the cart page takes no `Chrome` and draws its own count (`cart::render`) | Corten starts a layout read once for the app, or an `Ahead` can be awaited from several places: drop `Chrome` from the handlers or its cell |
| [todd-skelton/corten#581 Caller is looked up once per type, so a caller type that is a rule over another asks the session store again in the same request](https://github.com/todd-skelton/corten/issues/581) | `auth::OneLookup` middleware puts an `auth::Lookup` (a `OnceCell`) on each request, and every caller type and the cart count find the session through it | a caller type can be derived from another's lookup: drop `OneLookup` and `Lookup` |
| [todd-skelton/corten#582 The error page's extractors get none of the failed request's extensions, so a caller the handler found is looked up again and middleware state is gone](https://github.com/todd-skelton/corten/issues/582) | `chrome::Chrome`, the error page's first extractor, puts a fresh `auth::Lookup` on the error page's request (`Lookup::kept`), so its caller and its cart count share one lookup; the handler's own is still not reused (a refused page asks twice) | the error page sees the failed request's extensions: drop `Lookup::kept` and assert one lookup per request in `a_page_and_its_layout_ask_who_is_asking_once` |
| [todd-skelton/corten#538 A data-patch write that redirects leaves the layout as the full load drew it, so a layout value the write changed stays stale with JavaScript and is right without it](https://github.com/todd-skelton/corten/issues/538) | the cart page's quantity and remove forms are `data-patch`, so it sets the nav's count with `badge::known` (`marketplace/src/views/nav_badge.js`) from its own read | Corten redraws or patches the layout after such a write: drop `nav_badge.js` and the cart page's `known` call |
| [todd-skelton/corten#577 A FromQuery Read cannot take an older parameter name its Link never writes, so a renamed parameter is declared on the link set](https://github.com/todd-skelton/corten/issues/577) | marketplace's `search::TermsQuery` has a `search` field its `link` always leaves `None`, so `TermsRead` can read the words' older name | Corten lets a `Read` field be read only: drop the field from `TermsQuery` |
| [todd-skelton/corten#310 A #[route(prefix)] field inside a #[route(query)] set is written into links but Params reads it back empty](https://github.com/todd-skelton/corten/issues/310) | `items::Address` and `search::Terms` keep a hand-written `Deserialize` over the raw query | [todd-skelton/corten#312 A query set is read the way a route reads its own, so its prefix fields round-trip](https://github.com/todd-skelton/corten/pull/312) merges |
| [todd-skelton/corten#415 A handler that answers a file cannot answer a page or a redirect when the file is refused](https://github.com/todd-skelton/corten/issues/415) | `channels::manual_sync_download` relays a 303 to the connection with `?manual=failed`, and the page shows the failure | Corten has an answer that is a file or a page: draw the connection with why |
| [todd-skelton/corten#515 pwa::Manifest cannot set the manifest's other members (orientation, categories, id, screenshots, shortcuts)](https://github.com/todd-skelton/corten/issues/515) | marketplace's and admin's manifests (`app::pwa`, `site::pwa`) leave out `orientation` and `categories` | Corten's manifest takes them: set them as marketplace-web does |
| [todd-skelton/corten#570 The two_components_style guard passes on Windows for a library and an app component with one name, and fails only at Linux link](https://github.com/todd-skelton/corten/issues/570) | admin's policy status component is `StatusBadge` (`admin/src/views/status_badge.rs`) and the catalog area's form dialog is `CatalogDialog` (`admin/src/catalog/views/dialog.rs`), since the kit's `Badge` and `Dialog` in `platform` share their style symbols; the Windows linker took the duplicate and only Linux CI failed. `corten ui add` now refuses such a clash in one crate ([todd-skelton/corten#550 A kit component and an app component with the same name fail at link time, and corten ui add does not warn](https://github.com/todd-skelton/corten/issues/550)), but not across crates | Corten keys a component's style by its path, or reports the clash across crates: name them `Badge` and `Dialog` again if that reads better |
| [todd-skelton/corten#569 Kit Badge has one look per tone, so an app cannot tell a filled status from an outlined one as MUI Chip does](https://github.com/todd-skelton/corten/issues/569) | the kit's Badge has filled `Info`, `Success`, `Warning` and `Destructive` since [todd-skelton/corten#552 Kit Badge and Alert have no success, warning or info tone, and every Alert is announced as role=alert](https://github.com/todd-skelton/corten/issues/552) (the pilot took its Alert as it is); `platform/src/ui/badge.rs` and `badge.css` keep the design system's soft `Success`, `Warning`, `Danger` and `Info`, with the kit theme's `-soft` colors (`kitTheme` in the [export](scripts/export.mjs)) | the kit's Badge has a soft look: take it (`corten ui diff`) and map `Danger` onto `Destructive` |
| [todd-skelton/corten#561 Kit control heights, spacing and type are literals, so a theme cannot give every control a 44 px touch target without editing each copied file](https://github.com/todd-skelton/corten/issues/561) | `platform/src/ui/button.css` reads the design system's `--control-height` and `--control-px` (44 px buttons at every size) | the kit reads size tokens: set them in the theme and take the kit's `button.css` again |
| [todd-skelton/corten#562 Kit Table keeps every cell on one line, and an app class cannot let a column wrap without matching the kit's specificity](https://github.com/todd-skelton/corten/issues/562) | `.prose:is(td, th)` and `.words:is(td, th)` in `admin/src/commerce/views/money_health_page.css` | cells can wrap with one class: drop the `:is(td, th)` |
| [todd-skelton/corten#563 Kit Card and Alert render their own div, so a card cannot be the page's section, article or list item](https://github.com/todd-skelton/corten/issues/563) | each card in `admin/src/commerce/views/payouts_page.rs` is wrapped in its own `<section aria-labelledby>` | a card styles the element the app writes: make the section the card |
| [todd-skelton/corten#564 corten ui add does not handle corten from the workspace, so a kit shared by several apps is set up by hand](https://github.com/todd-skelton/corten/issues/564) | `corten-ui.workspace = true` added to `platform/Cargo.toml` by hand; admin lists the five kit components it renders (`admin/src/commerce/views.rs`, `PAYOUTS`) | `corten ui add` handles workspace dependencies: nothing to remove, but check the next `ui add` writes the same |
| [todd-skelton/corten#568 corten ui diff reports a kit copy as edited after corten fmt lays it out with the app's rustfmt.toml](https://github.com/todd-skelton/corten/issues/568) | none: `corten ui diff` reports `platform/src/ui/field.rs` as edited, but the change is layout only (`corten fmt`) | `ui diff` ignores layout: check it reports `field.rs` as the kit's |

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
| [chase-sets/chase-sets#3494 [deployables] P2: Web route behavior leaks — analytics endpoint to discovery, cart/theme policy to contexts, catalog permission middleware to catalog](https://github.com/chase-sets/chase-sets/issues/3494) | [marketplace/src/site.rs](marketplace/src/site.rs) |
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
| [chase-sets/chase-sets#10749 [checkout] Return each Sell List line's readiness and the list's payout totals from the Sell List read](https://github.com/chase-sets/chase-sets/issues/10749) | [marketplace/src/sell_list.rs](marketplace/src/sell_list.rs) |
| [chase-sets/chase-sets#10753 [checkout] Work out seller checkout's seller readiness in the Checkout API instead of trusting the evidence the page posts](https://github.com/chase-sets/chase-sets/issues/10753) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/sell_checkout.rs](marketplace/src/sell_checkout.rs) |
| [chase-sets/chase-sets#10754 [checkout] Run seller checkout's Marketplace handoff in the Checkout API and record the summary it observed](https://github.com/chase-sets/chase-sets/issues/10754) | [marketplace/src/sell_checkout.rs](marketplace/src/sell_checkout.rs) |
| [chase-sets/chase-sets#10772 [pricing] Bulk reprice is offered and its page drawn while Pricing has it switched off](https://github.com/chase-sets/chase-sets/issues/10772) | [marketplace/src/api.rs](marketplace/src/api.rs), [marketplace/src/bulk_reprice.rs](marketplace/src/bulk_reprice.rs) |
| [chase-sets/chase-sets#10778 [channels] Return the connectable providers and each connection's allowed actions from the Channels API](https://github.com/chase-sets/chase-sets/issues/10778) | [marketplace/src/channels.rs](marketplace/src/channels.rs) |
| [chase-sets/chase-sets#10779 [channels] Disconnect answers no commit receipt, so the read after it still shows the connection before the disconnect](https://github.com/chase-sets/chase-sets/issues/10779) | [marketplace/src/channels.rs](marketplace/src/channels.rs) |
| [chase-sets/chase-sets#10809 [channels] A stale publication write shows 'Channels API error 409' instead of 'Settings changed'](https://github.com/chase-sets/chase-sets/issues/10809) | none: the pilot answers the 409 with the conflict notice ([marketplace/src/channels.rs](marketplace/src/channels.rs)) |
| [chase-sets/chase-sets#10812 [channels] A refused manual sync download shows Channels' JSON error instead of the connection](https://github.com/chase-sets/chase-sets/issues/10812) | none: the pilot goes back to the connection and says the download failed ([marketplace/src/channels.rs](marketplace/src/channels.rs)) |
| [chase-sets/chase-sets#10828 [identity] An account's access workspace read after a write times out while Identity projections the write did not touch sit one position behind](https://github.com/chase-sets/chase-sets/issues/10828) | [admin/src/access/account.rs](admin/src/access/account.rs), [admin/src/access/sessions.rs](admin/src/access/sessions.rs) |
| [chase-sets/chase-sets#10832 [platform-operations] A reported-content moderation action redirects to an unprefixed path admin-web does not serve](https://github.com/chase-sets/chase-sets/issues/10832) | none: the pilot redirects to the target's page under `/support` ([admin/src/reported/mod.rs](admin/src/reported/mod.rs)) |
| [chase-sets/chase-sets#10833 [platform-operations] A reported-content moderation action answers no commit receipt, so the target read after it shows the status before the action](https://github.com/chase-sets/chase-sets/issues/10833) | [admin/src/reported/mod.rs](admin/src/reported/mod.rs) |
| [chase-sets/chase-sets#10835 [platform-operations] A risk alert action answers no commit receipt, so the alert read after it shows the status before the action](https://github.com/chase-sets/chase-sets/issues/10835) | [admin/src/reported/risk.rs](admin/src/reported/risk.rs) |
| [chase-sets/chase-sets#10843 [customer-feedback] The CSAT dashboard's survey version filter sends v1, which the API answers with 500](https://github.com/chase-sets/chase-sets/issues/10843) | [admin/src/support/csat.rs](admin/src/support/csat.rs) |
| [chase-sets/chase-sets#10844 [customer-feedback] The CSAT dashboard read answers 500 for out-of-range or malformed filters instead of 400](https://github.com/chase-sets/chase-sets/issues/10844) | [admin/src/support/csat.rs](admin/src/support/csat.rs) |
| [chase-sets/chase-sets#10845 [customer-feedback] The CSAT dashboard's Export always fails: the API wants a grant no role has and a reason the link does not send](https://github.com/chase-sets/chase-sets/issues/10845) | [admin/src/support/csat.rs](admin/src/support/csat.rs) |
| [chase-sets/chase-sets#10854 [customer-feedback] The attention queue's case link reloads the queue: nothing reads its caseId](https://github.com/chase-sets/chase-sets/issues/10854) (the pilot shows the case ID without the link) | [admin/src/support/attention.rs](admin/src/support/attention.rs) |
| [chase-sets/chase-sets#10848 [design-system] A read-only Rating never tells a screen reader its value](https://github.com/chase-sets/chase-sets/issues/10848) (the pilot shows the value as text; nothing to remove) | [admin/src/support/views/feedback_page.rs](admin/src/support/views/feedback_page.rs) |
| [chase-sets/chase-sets#10856 [fulfillment] Return Intake's scan and every write go to /return-intake, which admin-web does not serve](https://github.com/chase-sets/chase-sets/issues/10856) (the pilot's scan and redirects stay under `/commerce`; nothing to remove) | [admin/src/commerce/intake.rs](admin/src/commerce/intake.rs) |
| [chase-sets/chase-sets#10857 [fulfillment] Return Intake records the receipt time in the server's time zone, not the operator's](https://github.com/chase-sets/chase-sets/issues/10857) (the pilot reads it in the browser's zone and refuses a time it cannot read; nothing to remove) | [admin/src/commerce/intake.rs](admin/src/commerce/intake.rs) |
| [chase-sets/chase-sets#10860 [fulfillment] Return Intake evidence uploads always answer 503: context.json does not declare the evidence storage port](https://github.com/chase-sets/chase-sets/issues/10860) (no intake or unidentified package can be recorded against a real API; the pilot's tests use a stand-in; nothing to remove) | [admin/src/commerce/intake.rs](admin/src/commerce/intake.rs) |
| [chase-sets/chase-sets#10861 [inventory] A recovered item action with an unknown intent answers 500 instead of 400](https://github.com/chase-sets/chase-sets/issues/10861) (the pilot refuses an unknown action before calling the API; nothing to remove) | [admin/src/commerce/recovered.rs](admin/src/commerce/recovered.rs) |
| [chase-sets/chase-sets#10871 [public-presence] Promo Bar's start and end times are read in the API server's time zone and shown in UTC, not the operator's](https://github.com/chase-sets/chase-sets/issues/10871) (the pilot reads and fills them in the operator's zone and sends the instant) | [admin/src/growth/promo.rs](admin/src/growth/promo.rs) |
| [chase-sets/chase-sets#10872 [discovery] Google Shopping's Inspect drops the filters and Close reopens the first blocked row instead of closing the detail](https://github.com/chase-sets/chase-sets/issues/10872) (the pilot keeps the filters and closes with `selected=none`; nothing to remove) | [admin/src/growth/google_shopping.rs](admin/src/growth/google_shopping.rs) |
| [chase-sets/chase-sets#10874 [platform-operations] Ops Dashboard's date range and granularity cannot be applied: the form has no submit control](https://github.com/chase-sets/chase-sets/issues/10874) (the pilot's range form has an Apply button; nothing to remove) | [admin/src/insights/ops.rs](admin/src/insights/ops.rs) |
| [chase-sets/chase-sets#10875 [platform-operations] Policy Console revisions take their effective times in the admin-web server's time zone, not the operator's](https://github.com/chase-sets/chase-sets/issues/10875) (the pilot reads them in the operator's zone and sends the instant; nothing to remove) | [admin/src/policy_console/mod.rs](admin/src/policy_console/mod.rs) |
| [chase-sets/chase-sets#10876 [platform-operations] A refused future-dated policy revision still ends the current policy's window](https://github.com/chase-sets/chase-sets/issues/10876) (none: the pilot sends what admin-web sends) | [admin/src/policy_console/mod.rs](admin/src/policy_console/mod.rs) |
| [chase-sets/chase-sets#10877 [marketplace] A Listing Evidence Policy write redirects to an unprefixed path admin-web does not serve](https://github.com/chase-sets/chase-sets/issues/10877) (the pilot's writes come back under `/platform`; nothing to remove) | [admin/src/evidence/mod.rs](admin/src/evidence/mod.rs) |
| [chase-sets/chase-sets#10878 [marketplace] Validating an invalid Listing Evidence Policy draft shows 'request failed (422)' instead of its diagnostics](https://github.com/chase-sets/chase-sets/issues/10878) (the pilot reads a 422's body as the validation and shows its diagnostics) | [admin/src/evidence/mod.rs](admin/src/evidence/mod.rs) |
| [chase-sets/chase-sets#10879 [marketplace] A validated Listing Evidence Policy draft cannot be activated after the page is reloaded](https://github.com/chase-sets/chase-sets/issues/10879) (the pilot offers Validate for a validated version as well as a draft) | [admin/src/evidence/views/listing_evidence_page.rs](admin/src/evidence/views/listing_evidence_page.rs) |
| [chase-sets/chase-sets#10880 [marketplace] Listing Evidence Policy activation takes its effective times in the admin-web server's time zone, not the operator's](https://github.com/chase-sets/chase-sets/issues/10880) (the pilot reads them in the operator's zone and sends the instant; nothing to remove) | [admin/src/evidence/mod.rs](admin/src/evidence/mod.rs) |
| [chase-sets/chase-sets#10881 [marketplace] The Listing Evidence Policy overview read after a write does not show the write: the policy document projection is not waited on](https://github.com/chase-sets/chase-sets/issues/10881) (none: the pilot sends the write's receipt, as admin-web does, and shows what the API answers) | [admin/src/evidence/mod.rs](admin/src/evidence/mod.rs) |
| [chase-sets/chase-sets#10892 [settlement] Give the Wallet Adjustment 'needs an elevated approver' and 'self-benefiting' refusals their own codes so pages stop matching message text](https://github.com/chase-sets/chase-sets/issues/10892) (the pilot matches the message's words, as admin-web does) | [admin/src/commerce/wallet.rs](admin/src/commerce/wallet.rs) |
| [chase-sets/chase-sets#10896 [catalog] A refused Promote or Reject on a Source Observation's page shows nothing](https://github.com/chase-sets/chase-sets/issues/10896) (none: the pilot's review is a form, and a refusal is its message) | [admin/src/catalog/observation.rs](admin/src/catalog/observation.rs) |
| [chase-sets/chase-sets#10882 [marketplace] Validating any Listing Evidence Policy draft fails: the impact preview reads listing.catalog_item_id, which marketplace_listing_pages does not have](https://github.com/chase-sets/chase-sets/issues/10882) (none: the pilot shows the API's message; Validate and Activate are checked against a stand-in only) | [admin/src/evidence/mod.rs](admin/src/evidence/mod.rs) |

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
