# Corten pilot

Chase Sets screens ported to [Corten](https://github.com/todd-skelton/corten), the Rust and plain
JavaScript framework, to find what Corten lacks for real screens with real data and auth. Each app
is a standalone server in front of the existing platform API: every call forwards the signed-in
user's cookies, as the React apps do, and business rules stay in the API. The pilot owns only the
screens.

Only the admin app is deployed: to staging, at `admin-corten.staging.chasesets.com` next to admin-web, since [#11330 [infrastructure] Deploy Corten admin alongside staging admin-web](https://github.com/chase-sets/chase-sets/pull/11330). The marketplace and public apps are not deployed. The pilot is not part of the platform gates or the delivery loop. Its own CI job,
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
| `admin/` | Catalog > Scopes (the list) with the attention queue, which pages one kind at a time apart from the list (`?attention_kind=&attention_offset=`), and the all-scopes alias review, `/catalog/scopes`: each candidate's Accept, Reject, Revoke and Defer, and a bulk bar whose boxes join its form, so it posts the checked candidates without JavaScript (the bar is always drawn while one is pending, where admin-web shows it once one is checked, and has no selected count) |
| `admin/` | Catalog > a scope's page, `/catalog/scopes/{id}` |
| `admin/` | Catalog > Scope Coverage (the Unmapped Scope Inbox), `/catalog/scope-coverage` (`?product_domain=`), and a scope's coverage, `/catalog/scope-coverage/{id}` (the scope page's coverage matrix, whose writes come back here) |
| `admin/` | Catalog > a Source Observation, `/catalog/source-observations/{id}`: its image and values as admin-web lists them (a Pokemon card's and a provider product's own), and Promote (observed or changed) and Reject with its reason (observed), for `catalog.manage`; a refusal is the form's message |
| `admin/` | Catalog > Scope Sync Batches, `/catalog/scopes/sync-batches` (`?batch_id=`, `?quote_id=`): resolve a TCGplayer held-set export, preview a batch and confirm it, quote and acquire capped counts, and a batch's progress (read again every 2 seconds while it is queued or running) with Cancel, Resume and Retry unit. admin-web's staging count-capture steps (`countCapture`) are not served |
| `admin/` | Platform > Attention Queue, `/platform/operations-attention` |
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}`, with its Publish, Set Field Value and Add content line dialogs |
| `admin/` | Catalog's home, `/catalog`, a dimension's and a field's page, `/catalog/dimensions/{id}`, `/catalog/fields/{id}`, and the scope attention review, `/catalog/scopes/attention/review` |
| `admin/` | The admin home, `/`: a card for each section the viewer may open, straight to the section when there is one, or that there is none, as admin-web's is; the bar's brand goes there |
| `admin/` | The Commerce, Growth, Support and Platform homes, `/commerce`, `/growth`, `/support`, `/platform`: each opens the first page in its nav the viewer may see, as admin-web's does, or answers 403 when there is none. With every section home the pilot's, both of admin's bars are marked by `req.nav_of` |
| `admin/` | Catalog > Categories, `/catalog/categories` (search, status, hierarchy and parent filters, bulk publish, deprecate and archive), and a category's page, `/catalog/categories/{id}` |
| `admin/` | Catalog > Components, `/catalog/components` (search, status and has-rules filters, bulk changes), and a component's page, `/catalog/components/{id}`, with its field and dimension rules (add, remove) |
| `admin/` | Catalog > Blueprints, `/catalog/blueprints` (search, status, has-components and has-rules filters, bulk changes), and a blueprint's page, `/catalog/blueprints/{id}`, with its components (attach, detach) and its field, dimension and product resolution rules (set, from dialogs the server draws when opened) |
| `admin/` | Catalog > Display Templates, `/catalog/display-templates` (search, status and target kind filters, create), and a display template's page, `/catalog/display-templates/{id}` (edit, publish, deprecate, archive) |
| `admin/` | Catalog > Reference Types, `/catalog/reference-types` (search, status and attribute key filters, bulk publish, deprecate and archive, create), and a reference type's page, `/catalog/reference-types/{id}` (edit, publish, deprecate, archive) |
| `admin/` | Catalog > Reference Data, `/catalog/reference-records` (search, status, type, relationship and attribute filters, bulk publish, deprecate and archive, create), and a reference record's page, `/catalog/reference-records/{id}` (its relationships; edit, publish, deprecate, archive). The create and edit dialogs are drawn by the server when opened, with corten-ui's combobox for each relationship's record |
| `admin/` | Access's home, `/access` (the attention queue and the account search), and Access > Accounts, Users, Memberships, Invitations and API Keys, `/access/accounts`, `/access/users`, `/access/memberships`, `/access/invitations`, `/access/api-keys` (search and status filters, pages), an account's workspace, `/access/accounts/{id}` (Overview, Team, API Access and Audit tabs and their 23 forms; a user's, a key's, a membership's or an invitation's page opens it on its tab), Access > Sessions, `/access/sessions` and a session's page (switch account, revoke), and Support > Reported Content, `/support/reported-content` (the counts, status and target filters, each target's response severity, deadlines, accountable role and state) and a reported target's page (its response and its policy, Acknowledge, its reports and its target type's moderation actions), and Support > Risk Alerts, `/support/risk-alerts` (the counts, status and kind filters) and an alert's page (its evidence, threshold and responses), Support > Reference Lookup, `/support/reference-lookup`, Support > CSAT dashboard, `/support/csat` (rates, volume, filters, trend, distribution, the invitation queue's pages, and Export CSV for staff who hold the export grant), and Support > Platform Feedback, `/support/platform-feedback` (the counts, status, topic and workflow filters, Mark selected reviewed and Archive selected, Export CSV) and a feedback's page (Mark reviewed, Archive, operator notes, related marketplace records), and Support > Support requests, `/support/requests` (status tabs, filters and their chips, Escalate overdue, pages) and a request's sheet (adjudication, the recommended action, checklist, notes, audit trail with its photos, full case context, and Respond, Escalate, Resolve, Note, Close and Cancel, and the remedy lifecycle: a proposal previewed before its reservation is requested, its approval, its effects with Retry, Waive and Release, a correction and its audit trail), and Support > eBay Deletion Lookup, `/support/ebay-account-deletion` (Production's subject data counts and a posted user ID's unexpired receipts; the sandbox has no Channels credential keyring, so its lookup always answers the banner), and Support > Customer Feedback, `/support/customer-feedback/attention` (the attention figures and the queue with each case's SLA), and Commerce > Return Intake, `/commerce/return-intake` (a facility's station: the scan, its figures, Complete facility intake with photos, Record unidentified package, Reconcile and Record correction), and Commerce > Recovered Returns, `/commerce/recovered-items` (the recovery figures and value, the custody and disposition queue, and the action form's nine actions), and Commerce > Commercial Terms, `/commerce/terms` (the published seller fee schedule, the active and scheduled terms, a schedule's and an override's sheet with Compare, Revision history and revise, Create schedule and Create account override), with admin-web's older addresses under `/commerce/terms/`, and Commerce > Money Health, `/commerce/money-health` (the balance forecast, provider diagnostics, negative balances, payouts needing attention and recent reconciliation), and Commerce > Payout Operations, `/commerce/payout-operations` (what needs attention, the payout setup's readiness, the filters and payouts, recent provider attempts, and a reconciliation run followed live until it is done), and Growth > Waitlist, `/growth/waitlist` (the signups by role, the invite waves' fill, the filters and the signups, with Export CSV relayed from the API) |
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
| `admin/` | Sign in, `/access/sign-in` (and `/catalog/sign-in`, the same page), `/access/sign-in/magic`, `/access/account-select` and `/access/sign-out`, with a passkey through the shared passkey step (`platform::auth`'s `passkey.js`, its challenge at `/access/sign-in/passkey`) and Google Workspace through Auth (`platform::auth::social`, relayed at `/api/auth/social/google/start` and `../callback` where nothing else serves `/api`); a signed-out page now signs in here. The frame's account menu has Switch account, Sessions and Sign out. Both apps sign in through `platform::auth` |
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
| `marketplace/` | Channels > Connections, `/account/channels` (`?status=`, `?cursor=`), a connection, `/account/channels/{id}`, with its manual TCGplayer sync (`POST ../{id}/manual-sync`, `../ingest`, `../download`), Publication, `/account/channels/publication`, and a connection's publication, `/account/channels/publication/{id}`; Connect eBay Sandbox, `/account/channels/ebay` (consent, Authorize to eBay Sandbox's consent only, Disconnect, and seller setup: a pending or active connection's fulfillment, payment and return policies and its storage location pairs, saved to activate it, with Add location pair as a form), with eBay's return, `/channels/ebay/callback` and `/channels/ebay/declined` |
| `marketplace/` | Seller Desk > Money and a payout's page, `/account/desk/money`, `/account/desk/payouts/{id}` |
| `marketplace/` | Seller Desk > payout setup, `/account/desk/settings` (`?mode=manage`) |
| `marketplace/` | Buy > Cart, `/account/cart`, for an account or the guest cart a visitor or guest checkout carries |
| `marketplace/` | Buy > Checkout, `/checkout/buy/session/{id}`, and its confirmation, `/checkout/buy/session/{id}/confirmation`, for an account or a guest checkout, and an offer's checkout (Submit offer). Pay now is sent once: after an answer that may be lost, the session is read once, and Pay now stays off until a refresh if the read cannot tell |
| `marketplace/` | Checkout start, `/checkout/buy/readiness`, for a listing, an offer or the cart, and a guest's or visitor's Buy. Each entry is sent once with its key (a key that is not one sends nothing); after an answer that may be lost, its attempt is looked up once, and Continue stays off if the lookup cannot tell |
| `marketplace/` | Buy > a payment, `/account/payments/{id}`, and a guest checkout's, `/checkout/payments/{id}`, with Retry payment and a link to Save this order, `/checkout/claim/{id}` (a passkey, a claim link, and the link's landing) |
| `marketplace/` | Buy > start a payment for a purchase, `/account/payments/new`, where Pay now and Retry payment go |
| `marketplace/` | Sign in, `/sign-in`, `/sign-in/magic`, `/account/select`, `/sign-out`, a passkey included (its challenge at `/sign-in/passkey`), and Google and Facebook through Auth (`platform::auth::social`, relayed at `/api/auth/social/{provider}/start` and `../callback` where nothing else serves `/api`), for registration too |
| `marketplace/` | Create an account, `/register` (`?registrationMethod=`), a passkey included, through the shared passkey step (its challenge at `/sign-in/passkey`) |
| `marketplace/` | Accept a team invitation, `/invite/{id}` (`?token=`, `?credentialMethod=`), with a passkey or a password |
| `marketplace/` | The account's own page, `/account` |
| `marketplace/` | The user's security page, `/account/security` |
| `marketplace/` | The user's sessions, `/account/sessions` and `/account/sessions/{id}` |
| `marketplace/` | The account's team, `/account/team` |
| `marketplace/` | The user's consent history, `/account/consents` |
| `marketplace/` | The account's reviews, `/account/reviews`, `/account/reviews/received`, `/account/reviews/written`, `/account/reviews/{id}` |
| `marketplace/` | An item's page, `/items/{slug}`. marketplace-web's JSON route `/items/{id}/market-history` is not served: its panel fetches it after load and on a range change, while the pilot keeps the range in the address (`range=`), reads the Sales tab's history with the page, and redraws it on each `item:{id}` change through the page's live parts, so nothing calls it |
| `marketplace/` | A listing's page, `/listings/{slug}`, with its Product JSON-LD from its Google Shopping payload on the production marketplace |
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
| `marketplace/` | Search and the home page, `/search`, `/categories/{slug}` and `/`, with each result's Add to List: the dialog for the product the search's option filters name, patched into the page (or the item page with it open without a script, or the item page to choose its options), a guest's registration back to the search, and Add Product back to the search saying where the product went; and Add matching products to Buy Cart, `/search/cart`: the preview of every match in a sheet (patched in, or the search with it open without a script), then one cart attempt for the account's or a guest cart, back to the search after the write saying how many, or the sheet saying what was not added, nothing added, or that the add is not known with the same attempt to send again; and each result's price and market intents drawn again on a change to its market (`public:market`, `/search/live`); and each filter group's first six choices with Show more for the rest, and an option search for a facet of more than eight values once the script runs; and Load more sent as the reader nears it, once the script runs |
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
| `marketplace/` | The buyer's submitted offers, `/account/offers/submitted`, with market following: the policies naming the listed offers (`?policy={id}` opens one), and Preview, Authorize, Pause and Stop, each a form that works without JavaScript and posts to `/account/offers/submitted/following` |
| `marketplace/` | A submitted offer's page, `/account/offers/submitted/{id}`, with market following for that offer (posting to `/account/offers/submitted/{id}/following`) |
| `marketplace/` | Support, `/account/support` and a case's page, `/account/support/{id}` |
| `marketplace/` | Product alerts, `/account/product-alerts` |
| `marketplace/` | The site's own files: `/robots.txt`, the sitemap index `/sitemap.xml` and its pages `/sitemap/{kind}/{page}.xml` (the home page and search, then Discovery's public items, categories, sellers, listings and sets), `/favicon.svg`, `/favicon.ico`, `/.well-known/appspecific/com.chrome.devtools.json`, the web app manifest and service worker (Corten's PWA, leaving marketplace-web's private paths to the network) and `/offline` |
| `marketplace/` | The item page's and search's analytics, `POST /analytics/item-detail-rail`: it refuses what marketplace-web's refuses and logs the rest with its fields (the pilot has no metrics yet, so there is no `chase_sets_marketplace_item_detail_rail_events_total`). The pages send a search result opened (`search_result_selected`, with its position and the search's keys), a similar item opened, Buy, Sell or Watch chosen in the rail or the mobile dock (`rail_intent_selected`), and the rail's own: a section opened (`workflow_selected`), a form sent with the button that sent it (`intent_submit_started`), a refused form's message (`validation_failed`), the offer's payout preview or its absence, and the create-listing registration gate shown and followed. Not sent, as the pilot has nothing they count: `reference_info_opened` (the pilot writes the reference text in the rail, with no popup) and the buyer and accept-offer registration gates (a guest makes an offer or adds it to a Sell List instead) |
| `marketplace/` | The shell on every page but `/offline`: the top bar, the account menu with Sign Out (a member), Exit guest checkout (a guest checkout), Sign In and Register (a visitor), and below 48rem the bottom bar of five with its groups, from marketplace's top-nav, bottom-nav and account-menu contributions. The server draws the cart's count with each full load, with or without JavaScript (`marketplace/src/chrome.rs`, Corten's layout read, started beside the page's own reads and drawn where the shell places it; a client navigation keeps the layout and reads nothing; the cart page gives the count its own read found), and the stylesheet hides a visitor's cart entry while its badge is hidden at 0 or missing, as marketplace hides it. An item page's add is a full-load form post, and a cart page write's redirect and the cart page reading itself again while the write lands are fetched whole, so each redraws the count. Pages with their own bottom bar (checkout, the item dock, offer matches, packing) sit above it |
| `marketplace/` | marketplace's older money addresses, which move to the Seller Desk: `/account/payouts`, `/account/settlement`, `/account/payouts/{id}`, `/account/payouts/setup` and `/account/wallet/adjustments/{reference}` |

What each screen covers and leaves out, screen by screen, is in the
[README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("What it covers"), with decisions 1 to 96 behind them.

### Not ported

Every page route marketplace-web, admin-web and public-web declare is served here (compared with
each host's route records on 2026-11-01). admin-web's
`/catalog/integrations/observation-evidence/{id}` is a JSON resource for its evidence sheet; the
pilot draws that sheet on the server at `/catalog/integrations/evidence/{id}` from the Catalog API's
evidence read, a review row's Evidence opening it in place with JavaScript and as the page with the
sheet open without. The Catalog API composes the integrations surfaces
([chase-sets/chase-sets#11038 [catalog] Compose the Catalog integrations surfaces in the Catalog API](https://github.com/chase-sets/chase-sets/pull/11038)),
and the pilot draws Integration health, Settings and Settings' older `governance` address from it
([admin/src/catalog/integrations.rs](admin/src/catalog/integrations.rs)), and the daily
`/catalog/integrations` workbench ([admin/src/catalog/daily.rs](admin/src/catalog/daily.rs)); those
pages need that API to answer. The daily workbench starts a scope's Catalog sync, retries, resumes
and cancels import jobs, defers or rejects Source Observations, and ignores, defers, splits or edits a
merge candidate, each a form that works without JavaScript. It draws the sync run a sync lands on and the
scope's durable sync state, with Retry provider for a failed or stale unit. Preview promotion (for the
checked rows, an observation's evidence or a unit's scope) and Create or update Catalog Items send the
selection and confirmation the Catalog API builds for the read; a promotion the read does not offer is
not offered. The commit presents the token the preview answered, with the draft choice it bound, and is
offered while the read says the held preview may be committed (`previewCommittable`). A merge
candidate's Promote sends the version the read offered it with, and its Evidence opens the candidate's detail sheet from the row the read gave; the sheet resolves a candidate's blocking conflicts, the catalog's value or the source's for each with a reason, and promotes with those choices, which the API applies. Its import context
bar chooses the provider, unit, scope and profile version from synced source options and reloads or
force-refreshes them; the scope selects, their options and the bar's summary line are the Catalog
API's.
Below the bar the selected source scope's workset lists each provider unit with its state, counts and
scope link. A unit's Sync and Reapply post the scopes the API builds for it (`commandScopes`,
[chase-sets/chase-sets#11082 [catalog] Accept the daily workset unit's import and reapply in the Catalog API: admin-web builds their job and reapply scope from the unit's commandContext with its own rules](https://github.com/chase-sets/chase-sets/issues/11082)),
read again for the working set when the form posts, and land on the unit's working set with the job
they queued; its Preview previews the unit's scope with the unit's own promotion. The jobs stage's
import preflight is the Catalog API's for the working set, sent in one `<corten-live>` fragment when it
is read, so a slow provider does not hold the page; where no stream will bring it (without JavaScript, or once the stream gave up), the loading line's link opens the page's own address with `preflight=true`, which reads it in (Corten's slow-part pattern from [corten-run/corten#1280 Give a slow part a <corten-live> stream sends once a no-JavaScript answer](https://github.com/corten-run/corten/pull/1280)). The review stage folds the alias review of the provider and profile version the surface
names, with the same candidate commands and bulk bar as the scopes list's.
Provider detail,
`/catalog/providers/{providerKey}` ([admin/src/catalog/provider.rs](admin/src/catalog/provider.rs)),
draws the same composed read for the provider with its refresh schedule, and pauses, resumes and
runs the refresh, makes a draft profile, rolls back, deprecates and retires a version with its
confirmation, and retries, resumes and cancels a job. Its validation readiness
([admin/src/catalog/validation.rs](admin/src/catalog/validation.rs)) draws provider readiness, the
fixture flows, dry-run proofs, semantic compare and activation checks from the same read, each
row's sheet a disclosure, and saves migration evidence and activates a version from the activation
decision. Its profile section workspaces
([admin/src/catalog/sections.rs](admin/src/catalog/sections.rs)) draw each of the selected version's
fifteen sections, in its group, as a disclosure with its form, drawn from the fields the read model
describes, and save one through the API's section command. A platform admin on TCGplayer gets its
Operator session ([admin/src/catalog/operator_session.rs](admin/src/catalog/operator_session.rs)):
the extension grant's status, Pair extension, whose answer shows the grant once (`no-store`, handed
to the operator extension first with JavaScript), and Disconnect behind its box. Each write carries
the browser's `Origin`, which the API checks against the forwarded host, so it succeeds only where
the API trusts that host (`CHASE_SETS_TRUST_FORWARDED_HEADERS`, set by the platform's deploys;
locally, a proxy that sets `Host` from it).
marketplace-web's `/items/{id}/market-history` is a JSON resource for its client; the pilot draws
the Sales tab's history on the server.

## Measured

Median of 7 cold-cache loads, signed in as the same user, production builds of both (the React
app and the pilot `--release`) from the same commit, against the dev sandbox on one machine. The
mobile profile is 4x CPU, 150 ms RTT and 1.6 Mbps down. Interactive is when the page's scripts ran. The pilot
was built without thin LTO then; `Cargo.toml` sets it since, and nothing here was measured again.

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
`node_modules/.bin` there). The root `.dockerignore` keeps the pilot out of the platform image, and a `deployables/*/Dockerfile`
would make every pilot PR build and preview the platform. The admin app has its own image instead,
`Dockerfile.corten-admin` at the repository root with its own `Dockerfile.corten-admin.dockerignore`,
which staging runs as the Helm component `admin-corten`. That deploy plumbing belongs to the delivery
loop ([#11327 [infrastructure] Deploy the Corten admin app to staging next to admin-web](https://github.com/chase-sets/chase-sets/issues/11327)). Each app writes one line per request on standard output through Corten's access log (`App::access_log`): an `INFO` event with target `corten::access` and its method, path without the query, route, status, bytes and duration.

| Variable | Default | |
|---|---|---|
| `CHASE_SETS_INTERNAL_API_ORIGIN`, else `PLATFORM_API_ORIGIN` | `http://localhost:7762` | the platform API the apps call. The first is the name the React hosts and the deploy give it |
| `ADMIN_WEB_ORIGIN` | `http://localhost:7752` | admin: sign-in and the admin pages the nav links to |
| `MARKETPLACE_WEB_ORIGIN` | `http://localhost:7753` | marketplace: sign-in and the pages the nav links to |
| `PUBLIC_PROTO` | `http` | admin and marketplace: the scheme forwarded to the API as `x-forwarded-proto`; `https` also has Corten send `Strict-Transport-Security` and refuse a write from a plain-http page (`Policy::hsts`). public takes both from `CHASE_SETS_PUBLIC_ORIGIN`'s scheme |
| `CHASE_SETS_PUBLIC_ORIGIN` | `https://chasesets.com` | public: the canonical origin (canonical links, the sitemap, the host the API is told) |
| `CHASE_SETS_MARKETPLACE_ORIGIN` | `https://marketplace.chasesets.com` | public: where Buy or sell links go |
| `CHASE_SETS_PUBLIC_INDEXING` | on | public: `0`, `false`, `no` or `off` adds `noindex`, closes `robots.txt` and empties the sitemap |
| `CHASE_SETS_MARKETPLACE_INDEXING` | on | marketplace: `0`, `false`, `no` or `off` closes `robots.txt` and empties the sitemaps |
| `PLATFORM_INTERNAL_AUTH_SECRET` | none | marketplace: the platform's internal capability, sent only on Auth's guest claim calls. Without it Save this order says a paid guest order cannot be saved now. The pilot has no development default, unlike the React hosts; locally, set the value the platform API uses |
| `GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED` | off | marketplace: `1`, `true`, `yes` or `on` shows a claim link's token on Save this order to type by hand (no email locally); never where `NODE_ENV` or `DEPLOYMENT_ENVIRONMENT` is `production` |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:7754` | public: public-web's pages it does not serve (the developer pages, `llms.txt`) and its analytics endpoint |
| `PROXIES` | none | every app (read by Corten): the proxies in front, comma separated addresses or networks (`10.0.0.0/8`), whose `X-Forwarded-For` `ClientIp` follows back to the visitor; without it the visitor is the connection's peer. Set it where a deploy would have set `CHASE_SETS_TRUST_FORWARDED_HEADERS` for the Node apps. public's Join sends the address to the API |
| `CHASE_SETS_DISCORD_INVITE_URL` | none | public: the Discord invite the home page links, when set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | marketplace: the collector it sends traces, logs and metrics to over OTLP HTTP, as marketplace-web does ([telemetry.rs](platform/src/telemetry.rs)); without it nothing is exported. It reads marketplace-web's other variables too: `OBSERVABILITY_ENABLED` (`false` turns export off), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (else `marketplace-web`), `OTEL_SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` |

The [export](scripts/export.mjs) writes what the apps read from Chase Sets' sources: each screen's English
text (`*/locales/*.en.json`), each app's navigation, admin's defaults, the design system's tokens
and fonts, and public's policy and developer documents. Run it after `main` changes them; the CI
job runs it with `--check`. `*/locales/pilot.en.json` is the pilot's own text. The two outputs that
carry the brand foil's colors, `platform/tokens.json` and the three apps' `favicon.svg`, are written on every
run and not committed: the structure gate allows those values only in the design system's own
registered files.

## Corten pin

`Cargo.toml` pins Corten to `92bc3267` (Corten `main` on 2026-11-23), whose framework package is
`corten-run` (the library is still `corten`). Corten 0.2.0 is released (tag `v0.2.0`, `a833b4e3`), and the pin is a git revision past it. The
pin follows Corten's latest `main` (Todd, 2026-11-02), and each move is its own commit that says
what changed; the workarounds a move lets go follow it in commits of their own. The history of every move is in the
[README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("Corten pin") and in `git log -- deployables/corten-pilot/Cargo.toml`.

The kit's copies in `platform/src/ui/` move with the pin. On each move, from `platform/`, run
`corten ui diff` and take every kit change with `corten ui add --merge <name>`; a copy edited here
must link the Corten issue that asks the kit to make the edit unnecessary. Then run `corten ui list`
for components the kit added, and port the screens' local rules to them. Two are not taken because the
design system has nothing for them: `control_width` (its fields fill their row; it has no control width
scale) and `tip` (no screen draws a tooltip). The support intake's items take `checkboxes` for the group
but keep their own bordered choice rows, which are the design system's `Checkbox` look, not a gap in the kit.

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

Each workaround is one file in [workarounds/](workarounds/), named for its issue
(`chase-sets-<n>.md` or `corten-<n>.md`), so adding or retiring one never touches another's lines:

1. [workarounds/open/](workarounds/open/): an issue that is open and cited in the pilot's code,
   where the comment says what the pilot does instead. When the issue closes, remove the
   workaround and delete its file.
2. [workarounds/cited/](workarounds/cited/): an issue that is closed and still cited in the
   pilot's code as the change or decision the code relies on, with nothing left to remove.
   Delete its file when the code stops citing it.

A file's heading links the issue with its title; the rest says where the pilot cites it and what
it does. Its links are relative to the file, and the repository's docs path check fails on one
that does not resolve.

No Corten issue the pilot works around is open. Every Corten gap the pilot found and how it closed is in the [README before it was cut](https://github.com/chase-sets/chase-sets/blob/5a683c4eb5/deployables/corten-pilot/README.md) ("Corten gaps").
