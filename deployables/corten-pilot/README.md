# Corten pilot

Pilot ports of Chase Sets screens to [Corten](https://github.com/todd-skelton/corten), the Rust
full-stack framework, to find what Corten lacks for real screens with real data and auth. It is
not deployed, is not part of the platform gates or the delivery loop, and has its own CI job
([corten-pilot.yml](../../.github/workflows/corten-pilot.yml)).

Each app is a standalone server in front of the existing platform API. Every call forwards the
signed-in user's cookies, as the React app does (`public/`'s pages are the same for everyone and
call it with none); sign-in, the other pages and all business rules stay where they are. The
pilot owns only the screens:

| App | Screen | Ported from | What it covers |
|---|---|---|---|
| `admin/` | Commerce > Postage policies, `/commerce/postage-policies` | admin-web | the list, the policy sheet, create, revise, preview, activate, retire and clone |
| `admin/` | Catalog > Dimensions and Fields, `/catalog/dimensions`, `/catalog/fields` | admin-web | the lists (live, with bulk lifecycle changes), each record's page, and every write on it |
| `admin/` | Catalog > Catalog Items (the list), `/catalog/catalog-items` | admin-web | the list and its ten filters, create, the changes count and Reload, bulk publish, archive and edits as jobs, and removing drafts |
| `admin/` | Catalog > Scopes (the list), `/catalog/scopes` | admin-web | the attention queue above the list (its counts, every item, an item's sheet, dismiss, defer and restore, and an alias candidate's accept and reject), the list, its search, status, product domain and language filters, promotion and sync, and the pager; View opens the scope's page (not ported: the all-scopes alias review) |
| `admin/` | Catalog > a scope's page, `/catalog/scopes/{id}` | admin-web | the journey and its five stages, the coverage matrix (accept, reject and revoke a mapping, Accept all available, Propose mapping, Confirm canonical record), the candidate review jobs (active, failed, and completed by page), and each language edition's link state with its alias candidates' commands; each supplementary read that fails is its section's banner (not ported: the import-to-promotion workspace, which the section links to on admin-web) |
| `admin/` | Platform > Attention Queue, `/platform/operations-attention` | admin-web | the queue as the Platform Operations API composes it: the four counts, the sources it could not read, each item's severity, words, source, wait and deadline, and Open to the admin-web page that resolves it; the queue drawn again on each change to its realtime topic (`<corten-live>`), which the API refuses for now |
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}` | admin-web | the item, its origin and readiness, publish (with Recheck) and archive, and every dialog: blueprint, description, field values (a reference field takes a record), categories, product contents, tags, image URLs, the image fallback, and both kinds of external reference |
| `marketplace/` | Inventory > Storage locations, `/account/inventory/locations` | marketplace | the list (archived too), create, save and archive, and confirming a write whose answer was lost |
| `marketplace/` | Inventory > Restock decisions, `/account/inventory/restock-decisions` | marketplace | the pending decisions, Restock and Write off (with a damage note), a refusal drawn again at the current version, and confirming a write whose answer was lost |
| `marketplace/` | Inventory > Inventory, `/account/inventory` | marketplace | a seller with `inventory.view` to see it and `inventory.manage` to write (signed out goes to sign-in and back): the items a page at a time (100, Previous and Next) with each one's options, location, counts and cost, Open (the pilot's item page), Create listing and Record sale; Create Inventory Item with Create listing's catalog picker (find as you type, a pasted id, Choose, the product options, each a GET of the page without a script), a storage location (archived ones left out), the quantity and cost, sent once with its attempt and confirmed if the answer was lost, then the pilot's item page, which confirms the attempt and reads after the write's receipt; Record sale as a dialog at its own address (`?sale={id}`): quantity, price, channel, note, and for an owner or manager honoring the sale over its orders with a confirmation, then the list with what the sale did, read again after its receipt. A slow read is a notice with what the page has. A card per item on a phone, a table from 48rem (not ported: imports) |
| `marketplace/` | Inventory > an item, `/account/inventory/items/{id}` | marketplace | a seller with `inventory.view` to see it and `inventory.manage` to write (signed out goes to sign-in and back to the item, its query kept): the item (catalog item, product options, location and its ship-from code, total, held and available), Create listing while stock is available, Back to inventory; the hold history (reason and quantity, purpose, time left on an active hold, its order, notes, created) with Release hold on an active manual hold; the stock ledger with All movements and a filter per kind it has (`?ledgerKind=`, a link each), each movement's facts and its order; Record sale (the list's form, the outcome on the page), Adjust Quantity (a signed whole number, one of the four reasons a seller may give, the reason and a note) and Create Hold (quantity, reason, notes), each sent once with its attempt and confirmed on the page after, read after its receipt; an adjustment the API records as a collision with orders' holds says the API's words. One column on a phone, the writes beside the item from 64rem |
| `marketplace/` | Seller Desk, `/account/desk` | marketplace | anyone signed in (signed out goes to sign-in and back): the account's attention queue as the API orders it, each row its severity, what it is about in the API's words (the summary's key and parameters, from marketplace's own messages), when it was raised and one link to act on it; the count to handle; a banner naming each source the API could not read (by name only); the active listings (the account's own status count) and open orders to ship as tiles, payouts and the wallet Unavailable as on marketplace; an empty queue says so; Jump to the seller's other pages. A queue the API cannot read is an error that says so, never an empty desk. A listing's, shipment's or sale's row links to the pilot's own page, where marketplace's goes to a Seller Desk address that does not exist ([chase-sets/chase-sets#10676 [marketplace] Seller Desk queue rows for listings, shipments and sales link to /account/desk/... routes that do not exist](https://github.com/chase-sets/chase-sets/issues/10676)). Counts two across from 30rem and four from 64rem, a row's link beside its summary from 48rem |
| `marketplace/` | Seller Desk > Repricing, `/account/desk/repricing` | marketplace | a seller with `pricing.view` to see it and `pricing.manage` to write (signed out goes to sign-in and back): the repricing halt as a switch that asks first in a `<dialog>` (`command="show-modal"`, no script), Pause and Resume per policy, the account's policies (status, strategy, scope and the last run) and recent dry runs; the policy editor at its own address (`?create=1&preset=..&knob=..`): the four presets with their knobs, the floor, the fallback and the scope (all listings, categories or picked listings) with the scope's count, compiled on the server to the body Pricing runs (`Editor::compile`, the workaround for #10682), Preview starts a dry run and draws it live as Pricing reports it (or reloaded without a script), and Activate is offered only for a completed preview of exactly the settings on screen; a changed setting says so and turns Activate off. A list Pricing has not caught up to says so and reads again. Tables are a card per row below 48rem, the editor two columns from 64rem (not ported: the structured and advanced rule editors, a policy's own page and activity, revising a policy; a policy's name opens marketplace's page) |
| `marketplace/` | Buy > Cart, `/account/cart` | marketplace | the account's cart as the Checkout API reads it: each line (merged by product and fulfillment) with its badge, options, lock or preference, seller and price, the one notice (what needs attention, or the lower price), the totals and the checkout bar and Check out and Use lower price, which start the checkout session and send the buyer to the pilot's checkout; each line's quantity step, Remove and Lock this listing, as the Checkout API's command attempts (not ported yet: the guest cart and the guest checkout) |
| `marketplace/` | Buy > Checkout, `/checkout/buy/session/{id}` | marketplace | an account's buy checkout (signed out goes to sign-in and back; a guest's goes to marketplace's at the same address): the steps (contact, delivery, shipping, payment, review), each ready step folded with Edit (`?edit=`), the saved addresses and payment methods to pick (or an address typed), the shipping option and the authenticity check, the payment method; the order summary with Payments' quote for the method on screen (the checkout fee and payable total, the wallet's balance applied for a buyer with `payouts.view`); the page's one notice by marketplace's priority; Update totals (the shipping option, the address, the opt-in and the reviewed preview, read after the last receipt) and Pay now (the review written again first when it changed or Payments has no quote, a stale quote or a pending payment back to the page saying so, else Checkout's confirm), with a script a changed choice says the totals need a refresh and keeps Pay now off until they are; a refused address or option opens its step again with the API's words. A session not found, someone else's, failing, or not yet caught up with a write is its own page (404, 403, 502, 202 read again). One column on a phone with the summary folded above the form and Pay now in a bar at the bottom, the summary beside the form from 64rem. Buy this listing, the item page's buy and the cart's Check out land here (not ported: the secure payment step after Pay now, which a started payment links to on marketplace; a purchase intent's checkout, which goes to marketplace's) |
| `marketplace/` | Sign in, `/sign-in`, `/sign-in/magic`, `/account/select`, `/sign-out` | marketplace | anyone: the email or phone first (a GET to the page), the methods it offers as links (an email's passkey, magic link and password; a phone's code), password, magic link and phone code on the pilot and passkey and social sign-in on marketplace; the session's cookie, then back to `returnTo` (the pilot's page when it serves the path, marketplace's otherwise); choosing an account; signing out. Every pilot page that needs a session signs in here. |
| `marketplace/` | The account's own page, `/account` | marketplace | an account with `accounts.view` to see it and `accounts.manage` to update it (signed out goes to sign-in and back; it is where a sign-in with no return address lands): the account's marketplace name with its badges (a founding account's with its number), Update Profile (the legal and marketplace names, an Identity attempt as the shipping addresses' are, read after the write; a write with no answer asked about, one that cannot be confirmed holds the form with Check again), the links to the shipping addresses, ship-from locations and listings (all the pilot's), who is signed in (the account, the user, the membership's role), Marketplace Readiness (the account type, status and when it changed, in Identity's words for a value it does not know) and Trust Details. A page still catching up with a write shows the account as it was (or as the session has it) and reads itself again. One column on a phone, every control the full width; the fields beside Update Profile and the signals three across from 48rem |
| `marketplace/` | The user's security page, `/account/security` | marketplace | a user with `security.manage` (signed out goes to sign-in and back): the user's names with Update Profile, Create API Key, the account protection metrics (sign-in methods, active keys, last update), the security signals with marketplace's Manage sessions, and each of the user's own keys with Rotate and Revoke (a dialog that asks first). A create or rotate answers with the key's secret once, `no-store`, at the page's own address, with Copy when the script runs; a reload says the secret cannot be shown again. Every write is an Identity account-management attempt |
| `marketplace/` | The user's sessions, `/account/sessions` and `/account/sessions/{id}` | marketplace | a user with `security.manage`, which Auth requires for every session call (signed out goes to sign-in and back): the user's own sessions by status (Active, Revoked, Expired) and page, each a card with its user, account, method and status; a session's page with its details, Switch Account (only to another of its accounts) and Revoke (a dialog that asks first). After a write Auth did not confirm, the page reads the session again and says what it is now |
| `marketplace/` | The account's team, `/account/team` | marketplace | a member with `memberships.view` reads it, and writes need `memberships.manage` (signed out goes to sign-in and back): the account's own members (name, role and status) and invitations (email, role and status), one card each on a phone; Invite (an email and a role), Change Role, Revoke (a dialog that asks first) and Reinstate for a member, Cancel (a dialog) for a pending invitation. Each write is an attempt with its `Idempotency-Key`; a lost answer is asked about, and the write it would repeat stays off until it is known. A new invitation, once committed, asks Auth for its acceptance link. A refused invite is drawn again with what was typed; any other refusal is the page's banner with the API's words |
| `marketplace/` | The user's consent history, `/account/consents` | marketplace | anyone signed in (signed out goes to sign-in and back): the consents Identity lists for the user on the account, newest first, only the user's own, each a card with its policy and version, when it was recorded (and withdrawn) and its status, and Withdraw (a dialog that asks first) on a recorded, current one, as an attempt with its `Idempotency-Key` (a lost answer is asked about, and that consent's Withdraw stays off until it is known). A refusal is the page's banner with its own words; no consents says so |
| `marketplace/` | The account's reviews, `/account/reviews`, `/account/reviews/received`, `/account/reviews/written`, `/account/reviews/{id}` | marketplace | a member with `reputation.view` reads them, and Report review needs `reputation.manage` (signed out goes to sign-in and back): the summary's account name, its ratings as a seller and as a buyer (average, how many, and the share of each star rating) and its ten newest revealed reviews; the lists' role filter (All, As seller, As buyer, kept in the address) and each review Reputation lists, a card (author, rating, reviewed account, status, scoring context, the account's reply) or the words for a withdrawn (and operator-withdrawn), paused or pending one, with Open review to its own page. A review's page: the review or its stand-in words with its author's role and the redacted badge, View order outcome (the purchase or the sale) and Back to the list it is on, and Respond to this review for the account reviewed, once, on an active, revealed review that is not held, read after its receipt (Reputation still catching up is the page's preparing words, read again in two seconds); a refused reply keeps its words, and a closed authoring code says how to fix it with a link to the field. Report review on an active, revealed review that is not held (on its page, not redacted either): a dialog with the reason and an explanation, posted to the page it is on; a sent report comes back to the review saying it was received, a repeat says it was sent before, a refused one reopens its dialog with what was sent and why |
| `marketplace/` | An item's page, `/items/{slug}` | marketplace | anyone (a session only marks the viewer's own offers): the item, its picture, Buy and Sell, the product options as links (a GET form for a long list), the market summary, the rail with the listing or offer chosen, and the market book's Listings, Offers and Details, each choice in the address; an id or an old slug moves to the slug (301), an unknown item is a 404. Buying from the rail: Add listing to Buy Cart, Add product to Buy Cart and Buy best match (cart command attempts, to the account's cart or a guest's), and Buy this listing (a checkout session, then marketplace's checkout); Make an offer (the price, currency and quantity checked, then marketplace's offer checkout). Selling from the rail: the selected offer's payout for a guest (the API's standard terms), Accept offer (Sell now for a seller, else Add offer to Sell List) and Add product to Sell List, to the account's sell list or a guest's, then marketplace's sell list. Watching from the rail: Watch listings and Watch offers (an alert with an optional price), saved to the account, or for a guest as an intent claimed after marketplace's registration. Listing at a price from the Sell rail: the ship-from setup when the seller has none, then Create listing (the stock, the listing and its publication), the seller's own listing with Manage listing after it, a guest's draft claimed after marketplace's registration The mobile action dock below 80rem: the price, then Buy, Sell and Watch as links to the rail on that side, or Select options. The gallery: more than one picture shows one at a time, picked by its thumbnail. More like this: the similar items' cards under the market book, each to its page here. The market book's Sales tab: the chosen product's spread, last sale and medians, and its sale prices over a range as a chart drawn on the server, the range links. Live: on each change to the item, the market summary, the market book (with the Sales tab's history) and the dock are drawn again (`<corten-live>`) Details' references: each record's dialog, opened by its value with no script. Add to List: an account's recent Saved Lists or a new one in a dialog the page draws, with the tracked quantity, or for a guest an intent claimed after marketplace's registration (not ported yet: a graded product's listing; the rail and the options redrawn live) |
| `marketplace/` | A listing's page, `/listings/{slug}` | marketplace | anyone: the status, the item, the product's options and price; the purchase panel with the seller's rating, availability, fulfillment, returns and protection, Buy this listing (an account's checkout session, a guest's marketplace guest checkout) and Compare market (the pilot's item page); the seller with their account link, tiles, shipping credit and product; a seller away or at capacity as a warning with no Buy; and Report Listing, which says the report was received, or was sent already, or to wait, where marketplace says nothing ([chase-sets/chase-sets#10614 [discovery] Tell a visitor their listing report was received (the page ignores ?reported=1)](https://github.com/chase-sets/chase-sets/issues/10614)) or shows its 500 page ([chase-sets/chase-sets#10615 [discovery] A repeat listing report shows a 500 page instead of saying it was already reported](https://github.com/chase-sets/chase-sets/issues/10615)). An old slug moves for good; an unknown listing is a 404, a failed read a 502 (not ported: the realtime patches, and the Product JSON-LD marketplace writes only in production) |
| `marketplace/` | An account's page, `/accounts/{slug}` | marketplace | anyone: the account's standing (its name as the page's one `h1`, Verified account, Trusted seller and Founder badges, Contact and Report account to marketplace, active listings, review history, member since and response time, and the two policies), the seller's chips when the API vouches for them (best-effort: a failed read shows none), its feedback as a seller and as a buyer with each rating's share, the reviews by role (All roles, As seller, As buyer) and by page (links to the feedback, ten a page), each review's byline, role, rating, how it counts toward the rating, words and the account's reply, the order confidence promises, and its active listings as cards (options, availability and limit, price, seller, fulfillment, View listing and Compare). Report review, for an account: a dialog its button opens (modal once the page's script joins), sent once (`303` back to the review, `#review-{id}`, saying it was received), a repeat said as sent already (`409`), a refusal or a missing reason drawn again in the open dialog (`422`), too many reports (`429`), a visitor sent to sign in. The account's id or an old slug moves for good with the query; an unknown account is a 404 and a failed read a 502 (marketplace answers 200 for both: [chase-sets/chase-sets#10619 [discovery] An unknown account page answers 200, and a failed account read reads as not found](https://github.com/chase-sets/chase-sets/issues/10619)); a closed or suspended account says only that it is unavailable, `noindex`. The item and listing pages' seller links now open it here (not ported: the realtime patches to the listings and counts) |
| `marketplace/` | The notification center, `/account/notifications` | marketplace | a member (signed out goes to sign-in and back): Feed and Settings as links (`?view=settings`, `&section=product-alerts`). The feed: the unread count, each notification's title, words, New or Read, source and time, Open (here for a ported page, marketplace for another, no link off-site) and Mark read; Mark all read, off when none is unread. Each write draws the feed again in place with a script and redirects without one. The settings: a switch per channel the page has words for (web, email, product alerts; marketplace also shows bare `sms` and `rcs`, [chase-sets/chase-sets#10625 [notifications] Delivery settings show unlabeled 'sms' and 'rcs' switches for channels the platform does not deliver](https://github.com/chase-sets/chase-sets/issues/10625)), each a form button with `role="switch"` drawn again in place; then the account's Product alerts with Pause or Resume, Delete and View product, read after each write with its receipt. A refusal is a `422` with the API's words, a failed read or write a `502`. The item page's Manage alerts now opens it here at `#product-alerts` (not ported: the feed's live updates) |
| `marketplace/` | The account's orders, `/account/purchases`, `/account/sales` and each order's page | marketplace | a member (signed out goes to sign-in and back): Purchases and Sales, each its counts (orders, items, pending) and the orders as cards (the first line's title and how many more, the side, when, the reference and status, the quantity, the total and, for a sale, the seller's payout, Open order), a page at a time as links (`limit`, `offset`); an order's page: its facts (source, support reference, counterparty, when its terms were set), each line with its picture, the delivery summary, the money (subtotal, shipping, tax, total, and for a sale the fee and payout, holds and the money's timeline), refunds, the support case, the review outcome and the review it opens, and Cancel: a purchase posts a form, a sale opens a `<dialog>` with its button (`command="show-modal"`, no script). A cancellation sends the buyer or seller back to the order with the write's receipt; a refusal is the order again with the API's words. An unknown order is a 404, a failed read a 502. A reader without `orders.manage` sees no Cancel ([chase-sets/chase-sets#10635 [ordering] A purchase page offers Cancel to a member without orders.manage (an unverified email), and the action then answers Forbidden](https://github.com/chase-sets/chase-sets/issues/10635)) (a purchase's View fulfillment opens the pilot's shipments; a sale's opens marketplace's command center) |
| `marketplace/` | The account's shipments, `/account/shipments`, `/account/shipments/{id}` and `/account/sales/shipments/{id}` | marketplace | a member (signed out goes to sign-in and back) with `fulfillment.view`: the buyer's shipments as cards (status, carrier and tracking, lines, when, Open shipment), two to a row from 80rem; a shipment's page for its buyer or seller: the steps, its facts, the lines, the package plan, and for the seller the postage policy, the postage operations and provider events, exceptions and label errors. For the seller, Start packing (a form) or Resume packing opens the pilot's packing page; the other actions (labels, dispatch, delivery, returns, exceptions), its Back and Print packing slip open marketplace's page; `/account/sales/shipments` (the command center) answers 303 to marketplace's, since marketplace builds it in its own loader ([chase-sets/chase-sets#10638 [fulfillment] Serve the seller's shipment command center (buckets, order and each next action) from the Fulfillment API instead of building it in the web host](https://github.com/chase-sets/chase-sets/issues/10638)). An unknown shipment is a 404, a failed read a 502 |
| `marketplace/` | Shipping addresses, `/account/shipping-addresses` | marketplace | a member with `accounts.view` to see and `accounts.manage` to change: the header with Back to account, the add form (label, recipient, company, country, both lines, city, state, postal code, phone, email, and Keep or Make default), and the saved addresses as cards (the label, Default, the lines) with Update address (its form in a dialog), Set default and Archive (a dialog that asks first). Each write is an Identity attempt; a required field the API names is the form again with its words by the field, an undeliverable address says so, a suggested address is a choice between the two, a changed address book says so (409), and a write whose answer was lost is asked about, or the page asks again with that form off. Read after each write; while the list catches up it says so and reads itself again. Works without a script (marketplace's action needs one) |
| `marketplace/` | Packing a shipment, `/account/sales/shipments/{id}/packing` | marketplace | a seller with `fulfillment.view` to see it and `fulfillment.manage` to pack: the heading, the three steps, the stage's banner (Ready to start with Start packing, the packing lock with when it started, Package recorded), the item checklist (the progress as a `<progress>` bar, Scan or search, each line with its options, count and references with Copy, a box that packs all of it or none and a step down and up for more than one) beside the shipment's details (the summary, where it goes with Copy address, the packing slip), and while packing the footer with the package count and Finish packing, off until every line is packed and on screen at the bottom of a phone. Each write carries its attempt as the `Idempotency-Key`; with a script a line's or a scan's answer replaces the line, the progress, the scan and the footer in place, without one it is a page at the line; start reads the packing page and Finish the shipment's page after the write. A refusal is a `422` with the API's words; an attempt the API applied before reads as applied; one it refuses and cannot say anything about sends the page to ask (`?check=`), which says it could not confirm the write with every write off until the API can say or the seller discards the browser's record. While the page has not caught up with a write it says so and reads itself again. The seller's Back opens marketplace's command center |
| `marketplace/` | Create listing, `/account/listings/new` | marketplace | a seller with `listings.view` to see it and `listings.manage` to write (signed out goes to sign-in and back, an account without it reads Account access required): the catalog search (found as the seller types, from two letters or a pasted id), the chosen item and each product option that applies (a raw card's condition, a graded card's grade), price, currency and quantity, the seller's inventory (the first 100, and the one an address names) with Use this inventory, the purchase limits, a ship-from address for an account without its Listing stock, the photos (JPEG, PNG or WebP, 10 MB each, 24, 60 MB in all, checked by their first bytes), the evidence readiness of the chosen inventory, Preview fees, Save as draft and Create and publish, a guest's draft claimed after registering, and a create that goes to the pilot's listing page with what came of its evidence |
| `marketplace/` | A seller's listing, `/account/listings/{id}` | marketplace | a seller with `listings.view` to see it and `listings.manage` to change it (signed out goes to sign-in and back): the listing's overview (status, language and shipping-measure badges, the item and its options, price, fee summary, inventory, quantity cap, credit rate, the price breakdown, the terms and the status timeline), its evidence readiness and the photos buyers see, its fee lock history, and every write marketplace's page takes: Preview fees, Save price (a stale quote shows the current one), the quantity cap, the purchase limits, Publish (refused for its evidence with the readiness now), Pause and Withdraw (asked first in a dialog); on a draft, Upload evidence, each photo's view and description (a refused description shows its recovery at the field), Replace, Move earlier, Move later and Remove; a page whose read has not caught up says it is preparing and reads again |
| `marketplace/` | A set's page, `/sets/{slug}` | marketplace | anyone: the game, the set's name and what is known of it (its card count, cataloged items, code and long release date), its cataloged items as search's cards (the lowest price and View card; one column, two from lg, three from 2xl), Browse all in search (`reference.<type>=<set>`) when the API sent only some, an empty state with none, and the breadcrumb's JSON-LD. An old slug moves for good with its query; an unknown set is a 404 and a failed read a 502 (marketplace answers 200 for both: [chase-sets/chase-sets#10612 [discovery] Answer an unknown set page with 404, and a failed set read with 5xx, not 200](https://github.com/chase-sets/chase-sets/issues/10612)) |
| `marketplace/` | Search and the home page, `/search`, `/categories/{slug}` and `/` | marketplace | anyone: the words, the category (its own path), price and stock, language, market activity, the results' own facets (fields, references and product dimensions) and the sort, all in one GET form, applied as a choice changes with a script and by Show results without one; the applied filters as chips, each a link without its filter; the results as cards with the lowest price and Buy, Sell and Watch, each to the item page with the dimension filters; Load more (a GET form: with a script, the next page added after the rows shown; without one, the same results with a page more); close spellings and closest matches; with nothing asked, the landing's headline and featured categories, and on `/` the home page's shelf in place of the results: the four featured categories (their description, count and a link to each) and the three newest items (the lowest price and View item), one column on a phone; words or a filter asked on `/` show the results there. `page` and `category=..` (or a category's id, key, name or old slug) move for good, and words the API reads filters from redirect to the address with them applied, marked `interpreted`. Below 64rem the filters are a dialog the Filters button opens. A failed read is an error banner with the filters and a 502 (not ported yet: Add to List and the bulk add to the buy cart from a result, the realtime market patches, the facet option search and the automatic load on scroll) |
| `public/` | An item's market page, `/market/{slug}`, with `robots.txt` and `sitemap.xml` | public-web | anyone, the same page for everyone (`Public`: a browser keeps it a minute, a shared cache for the `s-maxage` Pricing's answer carries, a day by default, and either serves it stale for an hour): the breadcrumb, the item's title and subtitle, then for each currency it traded in its price history (each day's median or last price, the day's low to high as a band, drawn on the server; an empty or one-day chart says so) and its market stats as a list (last sold and when, the 30- and 90-day medians and their trades, active listings and the lowest asks, the 30-day sell-through), and View active listings, Create a price alert and Sell yours on marketplace. The title, description, social tags, canonical, `noindex` when the site is not indexed, and the Product's lowest ask as JSON-LD on the production site. An unknown item is a 404 with public-web's words, a failed read a 502 no cache keeps. `robots.txt` and the sitemap of the market pages Pricing says are worth indexing follow `CHASE_SETS_PUBLIC_INDEXING` (not ported: public-web's other pages, its favicons and manifest, and its waitlist analytics bridge) |
| `public/` | The home page, `/` (chasesets.com's waitlist landing) | public-web | anyone, the same page for everyone (`Public`: a browser keeps it a minute, a shared cache four minutes while the fee terms were read live, either a minute stale): the promo bar (one message at a time, turning with a script), the nav, the hero (the seller's or the buyer's copy, by `?intent` or a buyer's `utm` words, swapped by the hero's role with a script) with the early-access form, the five games, open offers, the fee comparison from Commerce's live terms (the compiled terms when the read fails), the founders offer, the full form with the waitlist counter, the FAQ, the footer, the sticky calls to action, and the page's JSON-LD. Join without a script: a signup goes to public-web's `/welcome` with its receipt, role, variant and games (303); a refusal is the page again with the API's words in the form it came from (422, 429 too many, 502). A legacy fee-calculator share link moves for good to public-web's `/compare/tcgplayer` at `#fee-calculator`. The waitlist analytics bridge posts the form's events as public-web's does (to `/api`, which the pilot does not serve) (not ported: `/welcome`, `/compare`, `/founders`, `/faq` and the policies, linked on public-web) |
| `marketplace/` | The seller's listings, `/account/listings` | marketplace | a seller with `listings.view` to see it and `listings.manage` to change it (signed out goes to sign-in and back, an account without it reads Account access required): the heading with Create listing, the seller's availability (Turn off listings with an optional automatic return, Turn on, and an away window scheduled from a reason and dates and cancelled), the order capacity (Set capacity, Remove cap) with the open orders, the listings health (each status's count, a filter link each) and the seller's reliability (best-effort: a failed read shows none), the filters (status and words) as a GET form with chips, the listings a page at a time (100, up to 250) as rows with a box to pick each (a 44 px target), the item, status, price, quantity cap, fee summary, inventory and Open to the pilot's listing page, the bulk bar once a listing is picked (Publish, Pause and Withdraw selected, each listing's outcome after), and the fee lock report in a `<details>`. The rows, the health and the fee report are drawn again on each change to the account's listings (`<corten-live>` on `account:{id}:listings`). Each write reads after its receipt. Every form posts without a script; a picked day is its start where the seller is: the browser's time zone, or without a script the zone the account chose in Identity's preferences. Marketplace's Paused listings card shows its raw template ([chase-sets/chase-sets#10653 [marketplace] The listings page's Paused listings card shows the raw template '{count} paused {label}'](https://github.com/chase-sets/chase-sets/issues/10653)); the pilot draws the count with no detail line |
| `marketplace/` | The seller's offer matches, `/account/offers/matches` and `/account/offers/matches/{id}` | marketplace | a seller with `offers.view` and `listings.view` to see them and `offers.manage` to act (signed out goes to sign-in and back): the best-match snapshot (active matches, ready to accept, at or above ask, the best match as a share of the ask), that listings are off, the Sell List card, and each match (the item and its options, the status and whether the seller can fulfill it or why not, the listing's price and quantities, the best offer with the buyer's rating, offer vs ask with the gap, the quantities requested and available, when it changed) with Add selected offer to Sell List, Open and Decline. The snapshot and the matches are drawn again on each change to the account's offers (`<corten-live>` on `account:{id}:offers`). A match's page: the overview, a managed offer's state, the fee terms accepting it would be priced with (best-effort), the shipping allowance and the steps, with Accept offer match, Add selected offer to Sell List and Decline, at the bottom of the screen on a phone. Adding reads the offer as Checkout's sell list does and goes to marketplace's sell list with the write's receipt; Decline goes back to the list with its receipt; a refusal is the match's page with the API's words |
| `marketplace/` | The buyer's submitted offers, `/account/offers/submitted` | marketplace | a member with `offers.view` to see them and `offers.manage` to change them (signed out goes to sign-in and back): the status filter as links with each status's count (All, Open, Paused, Withdrawn, Accepted, `?status=`), each offer (the item and its options, the price or Price incomplete, the status, the quantity requested, the accepting seller's reputation for an accepted offer, when it changed) with Open (marketplace's offer page), and for `offers.manage` Pause or Resume and Withdraw (asked first in a `<dialog>` its button opens, no script), a box to check it and the bulk bar (Pause selected, Resume selected, Withdraw selected, asked first, and Clear selection) once one is checked. One offer is its own command and several the bulk command; each offer's outcome is drawn above the list, and a newer outcome is the row's status until the read catches up. A closed lifecycle (`503 offer_lifecycle_closed`, as the dev sandbox answers) says so for every offer. The counts and the rows are drawn again on each change to the account's offers (`<corten-live>` on `account:{id}:offers`). A reader without `offers.manage` sees no boxes or buttons ([chase-sets/chase-sets#10660 [marketplace] An unverified account can submit an offer but cannot withdraw it (submit needs no offers.manage; pause, resume and withdraw do)](https://github.com/chase-sets/chase-sets/issues/10660)). Not ported yet: market following (an offer's buyer policy: preview, authorize, pause and stop) and an offer's own page |

Both work with and without JavaScript. `platform/` is what both share: the platform API as the
signed-in user, the session and color mode, read after write, nav rules, the theme and the page
sections.

## Measured

Median of 7 cold-cache loads, signed in as the same user, production builds of both (the React
apps from the same commit, the pilot `--release`), against the dev sandbox on one machine. The
mobile profile is 4x CPU, 150 ms RTT and 1.6 Mbps down. Interactive is when the page's scripts
ran. Raw results are in `artifacts/corten-pilot/` (not committed).

| Storage locations (list) | marketplace desktop | pilot desktop | marketplace mobile | pilot mobile |
|---|---|---|---|---|
| Interactive | 929 ms | 386 ms | 7,011 ms | 902 ms |
| Largest contentful paint | 648 ms | 372 ms | 2,300 ms | 1,360 ms |
| Server time (document) | 197 ms | 72 ms | 197 ms | 118 ms |
| JavaScript transferred | 667,789 B | 8,049 B | 667,789 B | 8,049 B |
| HTML / CSS transferred | 16,275 / 19,970 B | 4,163 / 3,164 B | 16,275 / 19,970 B | 4,165 / 3,164 B |
| Requests | 93 | 9 | 92 | 9 |

The cart (`/account/cart`, as the auth seed's collector, two lines) at the `c590b8a` pin: the pilot is
a release build. marketplace is its dev server (`react-router dev`), desktop only. A production build
of marketplace-web is refused outside the heavy-slot governor (`heavy-admission`), so there is no
production React baseline for this screen yet. The dev numbers overstate React's bytes and time by
an unknown amount and are not a comparison. Measured once, 7 loads each.

| Cart | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 6,674 ms | 736 ms | 595 ms |
| Largest contentful paint | 3,088 ms | 728 ms | 1,216 ms |
| Server time (document) | 2,834 ms | 64 ms | 73 ms |
| JavaScript transferred | 3,624,607 B | 7,590 B | 7,590 B |
| HTML / CSS transferred | 437,787 / 186,198 B | 2,730 / 4,325 B | 2,730 / 4,325 B |
| Requests | 251 | 10 | 9 |

A scope's page (`/catalog/scopes/ref_seed_set_lorcana_d23_collection`, two mapped providers, no jobs)
at the `dfaaa90` pin, as the sandbox's platform admin: the pilot is a release build, admin-web its
dev server (`react-router dev`), desktop only, since its mobile load did not finish within 120 s.
As with the cart, the dev numbers overstate React's bytes and time by an unknown amount and are not
a comparison. Measured once, 7 loads each.

| Scope page | admin-web (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,227 ms | 195 ms | 1,665 ms |
| Largest contentful paint | 3,344 ms | 288 ms | 1,364 ms |
| Server time (document) | 3,096 ms | 97 ms | 106 ms |
| JavaScript transferred | 7,718,168 B | 10,627 B | 10,627 B |
| HTML / CSS transferred | 847,248 / 186,139 B | 3,278 / 7,070 B | 3,278 / 7,070 B |
| Requests | 251 | 12 | 12 |

The pilot measured interactive sooner on mobile than on desktop. That was not profiled, and one
run of 7 loads does not show whether it repeats.

Search (`/search?q=charizard`, two results, and `/search`, the landing with 14), on the local
`feat/route-handlers` port: the pilot is a release build, marketplace its dev server, so as with the
cart the React numbers are not a comparison. marketplace's mobile load did not finish within the
script's 120 s timeout (7.7 MB of JavaScript at 1.6 Mbps), so it has no mobile number. Measured once,
7 loads each, as the collector.

| Search | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive, results | 5,562 ms | 499 ms | 1,282 ms |
| Largest contentful paint, results | 3,700 ms | 604 ms | 15,072 ms |
| Server time (document), results | 3,283 ms | 111 ms | 140 ms |
| JavaScript transferred | 7,692,764 B | 9,638 B | 9,638 B |
| HTML / CSS transferred, results | 527,534 / 186,198 B | 4,729 / 4,153 B | 4,729 / 4,153 B |
| Interactive, landing | not measured | 678 ms | 957 ms |
| Largest contentful paint, landing | not measured | 648 ms | 1,536 ms |

The results page's mobile LCP is the cards' picture: both results use the sandbox's card-back
fallback, `/fake-cdn/assets/pokemon_tcg_back.png`, a 1,451,020 B PNG for every variant, which
marketplace's cards load too. The landing's LCP is its headline. When this was measured, the pilot's
`components.css` carried search's stylesheet on every page
([todd-skelton/corten#93 An area has one prefix, so a screen at two addresses (/search, /categories/{slug}) puts its stylesheet on every page](https://github.com/todd-skelton/corten/issues/93)).
From the `319d3b7` pin to the `0f3f03f` pin it was in `sections/search+categories+sets.css`,
linked only from those areas and, by a workaround, the home page. Since the `8cb28fb` pin it is in
`components.css` again: the home page is search too, and Corten measured that a stylesheet for `/`
alone costs the most visited page a blocking request to save about 2.2 KB brotli
([todd-skelton/corten#95 A page outside every area (the app's /) cannot link an area's stylesheet, so a screen that is also the home page ships its CSS on every page](https://github.com/todd-skelton/corten/issues/95), closed as not planned).

Search again at the `319d3b7` pin (Load more appends, `data-keep-place`, the shared stylesheet),
the pilot only, 7 loads each:

| Search, `319d3b7` | pilot desktop | pilot mobile (two runs) |
|---|---|---|
| Interactive, results | 339 ms | 1,686 / 1,553 ms |
| Largest contentful paint, results | 328 ms | 14,740 / 14,748 ms |
| Server time (document), results | 106 ms | 126 / 144 ms |
| JavaScript transferred | 9,808 B | 9,808 B |
| HTML / CSS transferred, results | 4,843 / 4,814 B | 4,843 / 4,814 B |
| Interactive, landing | 378 ms | 1,822 / 1,727 ms |

The JavaScript is 170 B larger: Corten's runtime grew 287 B gzipped for keep-place and `Append`
(its measurement), and `search.js` shrank. The CSS is 661 B larger in all, but it is now three
files: `style.css` (1,091 B, as before), `components.css` (1,683 B, every page) and the shared
section (2,040 B, these areas only).
Every other page's `components.css` is 1,379 B smaller than at `c7fc490` (3,062 B). Desktop
interactive went from 499 to 339 ms. Mobile interactive went from 1,282 to 1,553-1,686 ms, and
its blocking time from 725 to 815 ms. That was not profiled. The two mobile runs differ by
133 ms, and other processes on the machine were busy, so one run each does not show whether the
regression is real.

The home page (`/`: the landing, four featured categories and three new arrivals), the same way:
the pilot's release build and marketplace's dev server, so the React numbers are not a comparison,
and marketplace has no mobile number. Measured once, 7 loads each, as the collector.

| Home page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,219 ms | 526 ms | 747 ms |
| Largest contentful paint | 2,928 ms | 656 ms | 1,472 ms |
| Server time (document) | 2,665 ms | 108 ms | 144 ms |
| JavaScript transferred | 7,692,764 B | 9,638 B | 9,638 B |
| HTML / CSS transferred | 574,851 / 186,198 B | 5,416 / 4,277 B | 5,416 / 4,277 B |
| Requests | 251 | 10 | 10 |

The pilot reads the results and the new arrivals in parallel, so the shelf adds one read but not
its wait.

A set's page (`/sets/base-set`: three cards, one listed), the same way. Measured once, 7 loads
each, as the collector.

| Set page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 2,803 ms | 272 ms | 600 ms |
| Largest contentful paint | 1,304 ms | 304 ms | 14,684 ms |
| Server time (document) | 1,035 ms | 57 ms | 74 ms |
| JavaScript transferred | 7,692,764 B | 8,085 B | 8,085 B |
| HTML / CSS transferred | 425,244 / 186,198 B | 2,073 / 4,962 B | 2,073 / 4,962 B |
| Requests | 251 | 11 | 11 |

The mobile LCP is the cards' picture again: the sandbox's 1,451,020 B card back, three of them.
The page's CSS is search's (its cards) and its own.

The 14.7 s is that picture's bytes, not the page. Traced at the `b35c934` pin (one 390 px phone
load each, the mobile profile): the largest paint on the set page is the card back at 14,832 ms,
and on search's results at 15,288 ms. The same loads with the card backs answered by a 27,540 B
picture (the sandbox's Lorcana card back) paint at 1,084 ms and 1,316 ms. Marketplace's pages load
the same files, so its mobile LCP waits for them too
([chase-sets/chase-sets#10586 [discovery] Shrink the Pokemon card-back fallback pictures (1.45 MB and 2.95 MB PNGs)](https://github.com/chase-sets/chase-sets/issues/10586)).

The carried-over mobile `Layout` cost (the account page, below) is the web fonts. Under 4x CPU on
the listing page, the first layouts take about 550 to 850 ms with every stylesheet, about 265 ms
without `components.css`, and the same with `components.css` but `--font-body` and
`--font-display` set to `sans-serif` (about 350 ms) or Arial (about 400 ms). The `:root` tokens
alone bring back the cost; no other block does. Dropping `ui-sans-serif` or `system-ui` from the
stacks changes nothing. Preloading the two other faces, or `font-display: optional`, moved
single pages either way in 7 loads (the account page painted later with `optional`), so the fonts
stay as public-web and marketplace load them.

A listing's page (the seeded Lugia, BGS 9.5), the same way. Measured once, 7 loads each, as the
collector. One of marketplace's loads navigated while measured and was taken again.

| Listing page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 3,138 ms | 376 ms | 560 ms |
| Largest contentful paint | 1,588 ms | 364 ms | 1,472 ms |
| Server time (document) | 1,382 ms | 57 ms | 56 ms |
| JavaScript transferred | 7,589,979 B | 8,085 B | 8,085 B |
| HTML / CSS transferred | 428,884 / 186,198 B | 2,486 / 5,510 B | 2,487 / 5,510 B |
| Requests | 251 | 9 | 9 |

An account's page (the seeded demo account: nine listings, one review), the pilot's release build
at the `319d3b7` pin against marketplace's dev server, desktop only for marketplace (its dev server
timed out under the mobile profile). As for the cart, the dev numbers are not a comparison.
Measured once, 7 loads each, as the collector.

| Account page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 3,961 ms | 404 ms | 1,806 ms |
| Largest contentful paint | 2,092 ms | 384 ms | 1,476 ms |
| Server time (document) | 1,808 ms | 100 ms | 93 ms |
| JavaScript transferred | 7,692,764 B | 9,190 B | 9,190 B |
| HTML / CSS transferred | 511,369 / 186,198 B | 4,279 / 4,409 B | 4,279 / 4,409 B |
| Requests | 251 | 11 | 11 |

The JavaScript is the listing page's plus `corten_ui`'s dialog script (`scripts/ui.dialog.js`), for
Report review's modal: 849 B more transferred than the listing page at this pin (9,190 against
8,341 B, the listing page measured the same day; the table above is from an earlier pin).

The mobile interactive time is not the page's script. Traced under the same profile, every pilot
page starts with one long layout: about 450 to 600 ms of `Layout` on the account page (374
elements) and on the listing page (113 elements), and about 240 ms on a set's page (58
elements). The listing page still reads as interactive at about 530 to 660 ms and the account
page at 1.5 to 2.8 s, so where that layout falls against the module scripts seems to decide the
number; the order was not traced. Blocking the
card pictures changed nothing. Removing `overflow-wrap: anywhere`, the page's grids, the
pictures' `aspect-ratio` or the rating bars changed little. Setting every font to `system-ui`
brought it to about 450 to 540 ms. So the cost is shared by the pilot's pages (the web fonts and
the site's base styles), not this page's. A later trace (the set page, above) puts it on the web
fonts the `:root` tokens name. It is likely the same effect as search's slower mobile interactive
at this pin (above).

The notification center (the collector's feed, 25 notifications, and its settings), the pilot's
release build at the `43079a1` commit (`d824f40` pin) against marketplace's dev server, desktop
only for marketplace (its dev server timed out under the mobile profile). As for the cart, the dev
numbers are not a comparison. Measured once, 7 loads each, as the collector.

| Notification center | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive, feed / settings | 3,881 / 3,096 ms | 312 / 244 ms | 537 / 520 ms |
| Largest contentful paint, feed / settings | 2,128 / 1,464 ms | 304 / 264 ms | 1,220 / 976 ms |
| Server time (document), feed / settings | 1,904 / 1,272 ms | 49 / 55 ms | 50 / 46 ms |
| JavaScript transferred | 7,718,152 / 7,749,592 B | 8,504 B | 8,504 B |
| HTML transferred, feed / settings | 485,997 / 417,989 B | 3,294 / 1,954 B | 3,294 / 1,954 B |
| CSS transferred | 186,198 B | 3,983 B | 3,983 B |
| Requests | 251 | 9 | 9 |

The page has no script of its own: the JavaScript is Corten's runtime and `static/app.js`. The
switches, Mark read and the alerts' buttons are
`data-patch` forms.

public-web's market page (the seeded Twilight Masquerade Elite Trainer Box: a last sale, three
listings, no series), signed out, the pilot's `public/` release build against public-web's dev
server, desktop only for public-web. As for the cart, the dev numbers are not a comparison: the
dev server sends its modules one by one, unminified. Measured once, 11 loads each on desktop and 7
on mobile. Two earlier desktop runs of the pilot, minutes before, gave medians of 1,117 and 749 ms
interactive while the machine was busy; a trace of single loads then showed 290 to 390 ms to the
first paint, so the 11-load run is the one recorded.

| Market page | public-web (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 2,535 ms | 301 ms | 871 ms |
| Largest contentful paint | 708 ms | 348 ms | 992 ms |
| Server time (document) | 537 ms | 18 ms | 16 ms |
| JavaScript transferred | 9,855,670 B | 8,504 B | 8,504 B |
| HTML / CSS transferred | 383,153 / 186,139 B | 1,681 / 3,526 B | 1,681 / 3,526 B |
| Requests | 251 | 9 | 9 |

The page has no script of its own. Its server time is one Pricing read with no session; in front
of a CDN most loads would not reach it at all.

public-web's home page (`/`, signed out, with the sandbox's live fee terms, promo bar and
counter), the pilot's `public/` release build against public-web's dev server, desktop only for
public-web, so again not a comparison. Measured once, 11 loads on desktop and 7 on mobile.

| Home page | public-web (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 1,890 ms | 217 ms | 640 ms |
| Largest contentful paint | 772 ms | 248 ms | 1,928 ms |
| Server time (document) | 560 ms | 1 ms | 1 ms |
| JavaScript transferred | 9,874,441 B | 12,956 B | 12,956 B |
| HTML / CSS transferred | 424,544 / 186,139 B | 7,849 / 4,647 B | 7,849 / 4,647 B |
| Requests | 251 | 13 | 13 |

The server time is the kept reads (decision 49): the three reads happen at most once a minute,
not per visitor. The JavaScript is the runtime (8,249 B), the page's script (4,189 B) and
`app.js`. The mobile LCP is the hero picture (the measure's mobile profile keeps a 1,280 px
viewport, so it takes the full 133,796 B size), painted after the first layout: a trace of one
throttled load shows two layouts of 497 and 315 ms at 4x CPU before the first paint at about
1.9 s. That is the carried-over mobile Layout cost, not this page's script: the page with no
stylesheet still lays out in about 390 ms, no block of `components.css` accounts for most of the
rest when removed, and public-web's own page spends 729 ms in layout and 380 ms in style on the
same profile.

The account's orders (the collector's Purchases, 205 orders, and its purchase
`ord_01M5P0SQE5TQGRJCTMD116ACF7`; the seller's Sales and the same order as a sale), the pilot's
release build at the `770b7eb` pin against marketplace's dev server, desktop only for marketplace
(its dev server timed out under the mobile profile). As for the cart, the dev numbers are not a
comparison. Marketplace measured 5 loads each, the pilot 11. The machine was busy: the
notification center measured again just before gave 796 / 473 ms interactive where it measured
312 / 244 ms above, and one purchase-page run's median server time was 954 ms where every other
run of the same page was about 70 ms. Read the pilot's times as an upper bound until measured on a
quiet machine; the bytes and requests are exact.

| Orders | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive, Purchases / a purchase | 3,581 / 3,544 ms | 556 / 1,627 ms | 1,109 / 1,477 ms |
| Interactive, Sales / a sale | 4,563 / 3,055 ms | 1,141 / 601 ms | 1,104 / 1,325 ms |
| Largest contentful paint, Purchases / a purchase | 1,812 / 1,680 ms | 576 / 1,612 ms | 1,680 / 2,352 ms |
| Largest contentful paint, Sales / a sale | 2,608 / 1,516 ms | 1,348 / 620 ms | 1,700 / 1,976 ms |
| Server time (document), Purchases / a purchase | 1,388 / 1,462 ms | 69 / 954 ms | 64 / 72 ms |
| Server time (document), Sales / a sale | 2,108 / 1,309 ms | 73 / 96 ms | 65 / 82 ms |
| JavaScript transferred | 7,718,152 to 7,813,780 B | 8,626 B | 8,626 B |
| HTML transferred | 427,033 to 433,740 B | 1,988 to 2,776 B | 1,988 to 2,776 B |
| CSS transferred | 186,198 B | 4,472 B | 4,472 B |
| Requests | 251 | 9 | 9 |

The pages have no script of their own; Cancel and the sale's dialog need none. The JavaScript is
122 B more than the notification center's at the `d824f40` pin: Corten's runtime
(`dist/corten.js`) is 502 B larger at `770b7eb` before compression, and no page here adds a script.

The account's shipments (the collector's Shipments, nine seeded, and `shp_seed_demo_charizard`, delivered; the
seller's `shp_seed_exception`, with its postage policy, operations, events and an exception), the
pilot's release build at the `0f3f03f` pin against marketplace's dev server, desktop only for
marketplace. As for the cart, the dev numbers are not a comparison. Marketplace measured 5 loads
each, the pilot 11. The machine was busy again: the buyer's page measured 286 ms and 257 ms
interactive on desktop in two shorter runs before the 619 ms below, and the seller's page 812 ms
and 746 ms before the 271 ms below. Read the pilot's times as an upper bound; the bytes and
requests are exact.

| Shipments | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive, Shipments / a shipment / a sale's shipment | 3,116 / 3,049 / 3,123 ms | 244 / 619 / 271 ms | 750 / 643 / 1,615 ms |
| Largest contentful paint | 1,540 / 1,480 / 1,568 ms | 272 / 640 / 300 ms | 1,208 / 1,136 / 1,404 ms |
| Server time (document) | 1,362 / 1,264 / 1,353 ms | 51 / 57 / 63 ms | 69 / 48 / 53 ms |
| JavaScript transferred | 7,692,764 / 7,767,634 / 7,739,127 B | 8,637 B | 8,637 B |
| HTML transferred | 431,721 / 425,661 / 439,349 B | 1,836 / 2,000 / 2,407 B | 1,836 / 2,000 / 2,407 B |
| CSS transferred | 186,198 B | 4,081 / 4,081 / 5,779 B | 4,081 / 4,081 / 5,779 B |
| Requests | 251 | 9 / 9 / 10 | 9 / 9 / 10 |

The pages have no script of their own. A sale's shipment links two section stylesheets, the orders'
(`sections/account/purchases+account/sales.css`, 1,698 B) and the shipments', because
`/account/sales/shipments` is under the `/account/sales` area and Corten links each area a page
is under, outermost first (its styles guide). The orders' rules do not apply there; the cost is one
request a seller makes once, since the file is cached after Sales.

A shipment's packing page (`/account/sales/shipments/{id}/packing`, a seeded shipment awaiting its
package, read only), the pilot's release build at the `cf48958` pin against marketplace's dev
server, desktop only for marketplace (its mobile load timed out at 120 s). As for the cart, the dev
numbers are not a comparison. Measured once, marketplace 5 loads, the pilot 9.

| Packing | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 4,694 ms | 260 ms | 1,382 ms |
| Largest contentful paint | 2,628 ms | 260 ms | 1,168 ms |
| Server time (document) | 2,379 ms | 62 ms | 93 ms |
| JavaScript transferred | 7,692,764 B | 10,522 B | 10,522 B |
| HTML / CSS transferred | 438,330 / 186,198 B | 3,103 / 9,301 B | 3,104 / 9,301 B |
| Requests | 251 | 12 | 12 |

The page's own script (`packing.js`: the attempt's record, Discard, Copy and the slip's words)
is 1,455 B of the JavaScript transferred (4,722 B decoded); the rest is Corten's runtime. The
packing page's rules are the seller's shipment area's own stylesheet
(`sections/account/sales/shipments.css`, 1,660 B transferred), so a seller's shipment page links
it too, one request more, once; the buyer's area does not (`views::SALE_SHIPMENTS`).

The collector's shipping addresses (`/account/shipping-addresses`, the seeded Home address), the
pilot's release build at the `b35c934` pin against marketplace's dev server, which timed out on
the mobile profile. Measured once, 7 loads each.

| Shipping addresses | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 2,702 ms | 328 ms | 1,290 ms |
| Largest contentful paint | 1,224 ms | 360 ms | 1,064 ms |
| Server time (document) | 1,024 ms | 95 ms | 147 ms |
| JavaScript transferred | 7,718,152 B | 9,616 B | 9,616 B |
| HTML / CSS transferred | 423,106 / 186,198 B | 2,648 / 5,530 B | 2,648 / 5,530 B |
| Requests | 251 | 10 | 10 |

The page has no script of its own. The JavaScript is Corten's runtime and corten-ui's dialog
handler, which makes a refused update's dialog modal again; Update address and Archive open their
dialogs with the buttons' `command`, without it.

Create listing (`/account/listings/new`, as the auth seed's demo seller, blank and from the
seeded Twilight Masquerade Elite Trainer Box's inventory), the pilot's release build at the
`2338bcb` pin. Marketplace's page could not be measured the same way: it never hydrates
([chase-sets/chase-sets#10651 [marketplace] Create listing never hydrates: its client graph imports event-core's AsyncLocalStorage](https://github.com/chase-sets/chase-sets/issues/10651)),
so it has no time to interactive. Its column below is three loads of its dev server waiting for the network to be idle,
as transferred (a dev server's bytes, not a production build's). The pilot's is the median of 7.

| Create listing | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | never (#10651) | 144 ms (from inventory 131 ms) | 962 ms (1,013 ms) |
| Largest contentful paint | 2,644 ms (1,500 ms) | 160 ms (208 ms) | 868 ms (888 ms) |
| Time to first byte | 2,442 ms (1,314 ms) | 53 ms server (92 ms) | 50 ms server (76 ms) |
| JavaScript transferred | 23,965,429 B | 9,830 B | 9,830 B |
| HTML transferred | 454,697 B | 3,435 B (3,595 B) | 3,435 B |
| Requests | 466 | 10 | 10 |

The page's own script (`listing_new.js`: draw again when an option or the inventory changes,
and find as the seller types) is a small part of the JavaScript. The rest is Corten's runtime. The
fee preview, the catalog search, a chosen item's options and a refused create are all answers of
the same form, patched in place with JavaScript and full pages without it.

A seller's listing (`/account/listings/{id}`, the seeded Lugia draft), the pilot's release build at
the `a12c78b` pin, 7 cold loads each (`measure.mjs screen=seller-listing`, in
`artifacts/corten-pilot/measure-seller-listing-pilot.json`); marketplace's dev server never
hydrates this page either ([chase-sets/chase-sets#10651 [marketplace] Create listing never hydrates: its client graph imports event-core's AsyncLocalStorage](https://github.com/chase-sets/chase-sets/issues/10651), commented with this page), so its column is three cold loads read
directly: no interactive time, and the dev numbers are not a comparison.

| Seller's listing | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | never (chase-sets/chase-sets#10651) | 343 ms | 536 ms |
| Largest contentful paint | 1,192-1,528 ms | 344 ms | 980 ms |
| Server time (document) | 1,026-1,383 ms | 146 ms | 86 ms |
| JavaScript transferred | about 17.9 MB | 8,863 B | 8,863 B |
| HTML / CSS transferred | | 3,713 / 5,984 B | 3,713 / 5,984 B |
| Requests | 251 | 9 | 9 |

The page has no script of its own: every write is a form, and Withdraw's dialog opens with
`command="show-modal"`. The pilot's desktop server time moved between runs (87, 216 and
146 ms medians in three runs of 7; the listing and its fee history are read together since the
first); the API's reads are most of it.

The seller's listings (`/account/listings`, the demo seller's 45 listings, all on one page), the
pilot's release build at the `76eda4f` pin, 7 cold loads each (`measure.mjs
screen=seller-listings`, in `artifacts/corten-pilot/measure-seller-listings-pilot.json`). Marketplace's
dev server's desktop column is from the first run's 7 loads (its mobile loads then passed the 120 s
timeout and ended the run), so the dev numbers are not a comparison.

| Seller's listings | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 9,009 ms | 287 ms | 1,597 ms |
| Largest contentful paint | 7,216 ms | 312 ms | 1,308 ms |
| Server time (document) | 6,937 ms | 143 ms | 100 ms |
| JavaScript transferred | 7,692,764 B | 10,074 B | 10,074 B |
| HTML / CSS transferred | 1,161,165 / 186,198 B | 7,418 / 6,649 B | 7,418 / 6,649 B |
| Requests | 251 | 10 | 10 |

Before the rows were `content-visibility: auto`, the pilot's mobile interactive time was 2,469 ms
and its LCP 1,820 ms (one run of 7): 48 rows (about 2,600 elements, 101 KB of HTML) laid out at
4x CPU took over a second in one task, and the page's script waited behind it. With the rows off
screen laid out as they are scrolled near, a probe of six loads each went from a median of
3,174 ms to 991 ms. The rest is the throttled network and the fonts. The page's own script is
1,163 B: the picked count and the away window's instants.

The seller's offer matches (`/account/offers/matches`, the demo seller's 9 matches, and the seeded
Pikachu quick-sale match's page), the pilot's release build at the `12e0695` pin, 7 cold loads each
(`measure.mjs screen=offer-matches`, desktop and mobile run separately, in
`artifacts/corten-pilot/measure-offer-matches-*.json`); marketplace's dev server, desktop only. As
before, the dev numbers are not a comparison.

| Offer matches, list / a match | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,578 / 4,574 ms | 440 / 420 ms | 583 / 540 ms |
| Largest contentful paint | 3,360 / 2,396 ms | 480 / 520 ms | 1,552 / 1,092 ms |
| Server time (document) | 3,115 / 2,146 ms | 160 / 303 ms | 78 / 108 ms |
| JavaScript transferred | 7,692,764 B | 8,911 B | 8,911 B |
| HTML / CSS transferred | 559,940 / 186,198 B; 435,510 / 186,198 B | 3,169 / 5,837 B; 2,267 / 5,837 B | the same |
| Requests | 251 | 9 | 9 |

The pages have no script of their own; the JavaScript is Corten's runtime and the live list's
element. A match's server time is two reads in a row (the match, then its terms at its listing).

The buyer's submitted offers (`/account/offers/submitted`, the collector's 14 offers, and
`?status=submitted`, its 12 open ones), the pilot's release build at the `132c136` pin, 7 cold loads
each (`measure.mjs screen=submitted-offers`, in `artifacts/corten-pilot/measure-submitted-offers-*.json`);
marketplace's dev server, desktop only, 5 loads. As before, the dev numbers are not a comparison.

| Submitted offers, all / open | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,078 / 5,478 ms | 474 / 280 ms | 749 / 638 ms |
| Largest contentful paint | 3,012 / 3,208 ms | 472 / 372 ms | 1,472 / 1,324 ms |
| Server time (document) | 2,760 / 2,936 ms | 63 / 62 ms | 59 / 64 ms |
| JavaScript transferred | 7,692,764 / 3,517,194 B | 8,954 B | 8,954 B |
| HTML / CSS transferred | 482,257 / 186,198 B; 473,941 / 186,198 B | 2,490 / 5,779 B; 2,272 / 5,779 B | the same |
| Requests | 251 | 9 | 9 |

The pilot's desktop times are not steady on this machine: the first run measured the whole list
at 1,202 ms interactive (LCP 1,344 ms) and the open ones at 280 ms; a second desktop run measured
474 ms and 837 ms. The table has the whole list's second run and the open ones' first; the bytes
and requests are exact. The page's own script is the bulk bar's count.

The seller's inventory list (`/account/inventory`, the demo seller's 21 items, nine of them the
smoke's sold-out synthetic ones), the pilot's release build at the `af7d7cb` pin, 7 cold loads each
(`measure.mjs screen=inventory`, in `artifacts/corten-pilot/measure-inventory-*.json`); marketplace's
dev server, desktop only (its mobile load timed out at 120 s). As before, the dev numbers are not a
comparison. Measured once on a busy machine.

| Inventory list | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,017 ms | 291 ms | 1,905 ms |
| Largest contentful paint | 3,060 ms | 284 ms | 1,560 ms |
| Server time (document) | 2,834 ms | 83 ms | 78 ms |
| JavaScript transferred | 7,734,889 B | 11,909 B | 11,909 B |
| HTML / CSS transferred | 622,689 / 186,198 B | 4,286 / 6,465 B | 4,287 / 6,465 B |
| Requests | 251 | 11 | 11 |

The JavaScript is the runtime, the recovery script, Create listing's picker script (find as you
type and the options' redraw) and Corten's dialog. The mobile interactive time was not profiled.

An inventory item's page (`/account/inventory/items/inv_seed_twilight_masquerade_elite_trainer_box`,
two order holds and three movements), the pilot's release build at the `af0019f` pin, 7 cold loads
each (`measure.mjs screen=inventory-item`, in `artifacts/corten-pilot/measure-inventory-item-*.json`);
marketplace's dev server, desktop only. Measured on a busy machine: the pilot's desktop numbers moved
between 416 ms and 1,030 ms interactive across two sessions, and the list's between 291 ms and
1,029 ms, with the server time under 210 ms each time. The table shows the second session's desktop
and the first's mobile.

| Inventory item page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 4,677 ms | 416 ms | 1,996 ms |
| Largest contentful paint | 2,524 ms | 408 ms | 1,996 ms |
| Server time (document) | 2,272 ms | 131 ms | 163 ms |
| JavaScript transferred | 7,734,889 B | 10,887 B | 10,887 B |
| HTML / CSS transferred | 447,500 / 186,198 B | 3,667 / 6,865 B | 3,666 / 6,865 B |
| Requests | 251 | 10 | 10 |

The JavaScript is Corten's runtime, the recovery script and the pilot's `app.js`; the page has no
script of its own. Its stylesheet is the inventory section's, shared with the list.

The Seller Desk (`/account/desk`, the seed seller's queue: one channel item, four sources the API
could not read), the pilot's release build at the `af0019f` pin, 7 cold loads each
(`measure.mjs screen=desk`, in `artifacts/corten-pilot/measure-desk-pilot.json`). Marketplace's Desk
has no number: it never hydrates on its dev server, by the same import chain as Create listing
([chase-sets/chase-sets#10651 [marketplace] Create listing never hydrates: its client graph imports event-core's AsyncLocalStorage](https://github.com/chase-sets/chase-sets/issues/10651), commented with the Desk's path), so `measure.mjs` times out waiting for it.

| Seller Desk | marketplace (dev) | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | never (it does not hydrate) | 229 ms | 541 ms |
| Largest contentful paint | not measured | 308 ms | 1,012 ms |
| Server time (document) | not measured | 124 ms | 124 ms |
| JavaScript transferred | not measured | 8,959 B | 8,959 B |
| HTML / CSS transferred | not measured | 2,096 / 5,356 B | 2,096 / 5,356 B |
| Requests | not measured | 9 | 9 |

The three reads run together, so the server time is about the slowest of them. The JavaScript is
Corten's runtime and the pilot's `app.js`; the page has no script of its own.

The repricing desk (`/account/desk/repricing`, the seed seller: no policies, the halt released),
the pilot's release build at the `1b00742` pin, 7 cold loads each (`measure.mjs screen=repricing`,
in `artifacts/corten-pilot/measure-repricing-pilot.json`). Marketplace's page on its dev server
measured on desktop only (`measure-repricing-pilot-2.json`); its mobile loads timed out at 120 s on the
dev server, so there is no mobile number. Dev numbers are not a comparison, as for the cart. One
session each, on a busy machine.

| Repricing desk | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 5,890 ms | 350 ms | 1,492 ms |
| Largest contentful paint | 2,976 ms | 372 ms | 1,620 ms |
| Server time (document) | 2,778 ms | 197 ms | 117 ms |
| JavaScript transferred | 7,734,889 B (dev) | 9,038 B | 9,038 B |
| HTML / CSS transferred | 434,215 / 186,198 B | 2,235 / 6,968 B | 2,235 / 6,968 B |
| Requests | 251 | 10 | 10 |

The JavaScript is Corten's runtime, the pilot's `app.js` and the page's `repricing_page.js`
(one listener: a changed choice submits the editor's Apply). The server time is the policies, the
halt, the dry runs and the editor's prerequisites read together.

The buy checkout (`/checkout/buy/session/{id}`, the collector's buy-now session for the Lugia at
$620.00, its saved address and expedited shipping), the pilot's release build at the `1b00742` pin,
7 cold loads each (`measure.mjs screen=checkout`, in `artifacts/corten-pilot/measure-checkout-pilot.json`).
Marketplace's page on its dev server, desktop only (`measure-checkout-marketplace.json`); dev
numbers are not a comparison, as for the cart. One session each, on a busy machine. Loading
marketplace's page confirmed the session: it submits Pay now itself once it hydrates
([chase-sets/chase-sets#10685 [checkout] Opening a ready checkout page confirms it: the page submits Pay now by itself on load](https://github.com/chase-sets/chase-sets/issues/10685)),
so its later loads were of a session with an order, and the measurement left a pending purchase
that paused the seed Lugia listing.

| Buy checkout | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 3,671 ms | 350 ms | 1,736 ms |
| Largest contentful paint | 1,744 ms | 480 ms | 1,584 ms |
| Server time (document) | 1,570 ms | 109 ms | 108 ms |
| JavaScript transferred | 7,692,764 B (dev) | 9,856 B | 9,856 B |
| HTML / CSS transferred | 449,982 / 186,198 B | 4,108 / 6,269 B | 4,108 / 6,269 B |
| Requests | 251 | 10 | 10 |

The JavaScript is Corten's runtime, the pilot's `app.js` and the page's `checkout_page.js` (one
listener: a changed field marks the totals stale). The server time is the session, then the wallet,
the saved addresses and the saved methods together, then Payments' quote.

Sign-in (`/sign-in?returnTo=%2Faccount`, the first step, and the collector's password step), signed
out, the pilot's release build at the `aaef56f` pin, 7 cold loads each (`measure.mjs screen=sign-in`,
in `artifacts/corten-pilot/measure-sign-in-pilot.json`). Marketplace's first step on its dev server,
desktop, 5 loads; its mobile profile did not finish a load in two minutes, and dev numbers are not a
comparison. One session each, on a busy machine.

| Sign-in | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive, first step / password step | 4,203 ms / not measured | 223 / 515 ms | 691 / 1,171 ms |
| Largest contentful paint | 1,648 ms / not measured | 232 / 496 ms | 876 / 1,404 ms |
| Server time (document) | 1,475 ms | 1 ms | 1 ms |
| JavaScript transferred | 7,692,764 B (dev) | 8,417 B | 8,417 B |
| HTML / CSS transferred | 389,802 / 186,198 B | 1,253 / 5,334 B | 1,253 / 5,334 B |
| Requests | 251 | 9 | 9 |

The page reads nothing, so the server's time is drawing it. The JavaScript is Corten's runtime and
the pilot's `app.js`; the page has no script of its own.

The account's own page (`/account`, the collector), the pilot's release build at the `aaef56f` pin,
7 cold loads each (`measure.mjs screen=account-home`). Marketplace's on its dev server, desktop, 5
loads; its mobile profile again did not finish a load in two minutes, and dev numbers are not a
comparison. One session each, on a busy machine.

| Account page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 3,012 ms | 282 ms | 689 ms |
| Largest contentful paint | 1,368 ms | 276 ms | 1,096 ms |
| Server time (document) | 1,046 ms | 67 ms | 65 ms |
| JavaScript transferred | 7,692,764 B (dev) | 8,417 B | 8,417 B |
| HTML / CSS transferred | 418,899 / 186,198 B | 2,328 / 4,718 B | 2,328 / 4,718 B |
| Requests | 251 | 8 | 8 |

The server's time is the session lookup and Identity's two reads, made together. The page's rules
are in `components.css` (decision 63), which grew from 2,939 to 3,312 B brotli for every page, once.

The user's security page (`/account/security`, the collector: one sign-in method, three revoked
keys left by the smoke), the pilot's release build at the `aaef56f` pin, 7 cold loads each
(`measure.mjs screen=security`). Not measured on marketplace: its dev server's numbers are not a
comparison (see the account page above). One session, on a busy machine.

| Security page | pilot desktop | pilot mobile |
|---|---|---|
| Interactive | 263 ms | 687 ms |
| Largest contentful paint | 272 ms | 1,124 ms |
| Server time (document) | 72 ms | 65 ms |
| JavaScript transferred | 8,417 B | 8,417 B |
| HTML / CSS transferred | 2,423 / 5,970 B | 2,423 / 5,970 B |
| Requests | 9 | 9 |

The server's time is the session lookup and Identity's two reads (the user, the keys), made
together (an earlier run on a busier machine measured 304 ms on mobile). The JavaScript is the account
page's 8,417 B: the Copy script is fetched only when a secret's Copy connects, and Revoke's dialog
needs none (`command="show-modal"`), so this load fetches neither. The one request more than the
account page is the area's own stylesheet.

The user's sessions (`/account/sessions`, the collector: 11 to 13 sessions as the smoke added them, two active), the
pilot's release build at the `aaef56f` pin, 7 cold loads each (`measure.mjs screen=sessions`).
Marketplace's dev server's numbers are not a comparison; marketplace's page draws the same first 50
whatever its filter ([chase-sets/chase-sets#10699 [auth] Marketplace's sessions page ignores its status filter, search and pages, always showing the first 50](https://github.com/chase-sets/chase-sets/issues/10699)). One session, on a busy machine.

| Sessions | pilot desktop | pilot mobile |
|---|---|---|
| Interactive | 238 ms | 745 ms |
| Largest contentful paint | 260 ms | 1,144 ms |
| Server time (document) | 51 ms | 54 ms |
| JavaScript transferred | 8,417 B | 8,417 B |
| HTML / CSS transferred | 1,840 / 5,986 B | 1,840 / 5,986 B |
| Requests | 9 | 9 |

The server's time is the session lookup and Auth's one list read. The page has no script of its
own; Revoke's dialog is the browser's `command="show-modal"`.

The account's team (`/account/team`, the demo account's owner: two members, four invitations), the
pilot's release build at the `dfaaa90` pin, 7 cold loads each (`measure.mjs screen=team`). Not
measured on marketplace. One session, on a busy machine; a first run beside a screenshot job read
815 ms interactive on desktop, so this is the second.

| Team | pilot desktop | pilot mobile |
|---|---|---|
| Interactive | 218 ms | 687 ms |
| Largest contentful paint | 260 ms | 976 ms |
| Server time (document) | 68 ms | 63 ms |
| JavaScript transferred | 8,481 B | 8,481 B |
| HTML / CSS transferred | 2,361 / 5,685 B | 2,362 / 5,685 B |
| Requests | 9 | 9 |

The server's time is the session lookup and Identity's two list reads, side by side. The page has
no script of its own: Revoke and Cancel are the browser's `command="show-modal"`.

The user's consent history (`/account/consents`, the collector: the sandbox records no consents,
so the page is its title and the words for none), the pilot's release build at the `9bdbb5a` pin,
7 cold loads each (`measure.mjs screen=consents`). Not measured on marketplace. One session, on a
busy machine.

| Consents | pilot desktop | pilot mobile |
|---|---|---|
| Interactive | 183 ms | 732 ms |
| Largest contentful paint | 200 ms | 996 ms |
| Server time (document) | 53 ms | 152 ms |
| JavaScript transferred | 8,481 B | 8,481 B |
| HTML / CSS transferred | 1,336 / 5,636 B | 1,336 / 5,636 B |
| Requests | 9 | 9 |

An empty history is the lightest this page gets; each consent adds a card and, while it can be
withdrawn, its dialog, and still no script.

The account's reviews (`/account/reviews`, the collector's summary: no revealed reviews yet, so
the two ratings and the words for none; and `/account/reviews/received`, one review its author
withdrew), the pilot's release build at the `9f854ec` pin, 7 cold loads each (`measure.mjs
screen=reviews`). Not measured on marketplace. One session, on a busy machine.

| Reviews | summary desktop | summary mobile | received desktop | received mobile |
|---|---|---|---|---|
| Interactive | 251 ms | 735 ms | 223 ms | 709 ms |
| Largest contentful paint | 276 ms | 1,224 ms | 248 ms | 1,012 ms |
| Server time (document) | 60 ms | 57 ms | 56 ms | 52 ms |
| JavaScript transferred | 8,481 B | 8,481 B | 8,481 B | 8,481 B |
| HTML / CSS transferred | 1,695 / 6,073 B | 1,695 / 6,073 B | 1,617 / 6,073 B | 1,617 / 6,073 B |
| Requests | 9 | 9 | 9 | 9 |

The server's time on the summary is the session lookup and Reputation's two reads, side by side.
The pages have no script of their own: Report review is the browser's `command="show-modal"`, and
a refused report's dialog, drawn open, is made modal by `corten_ui::dialog::modal` as on the
account page.

A review's own page (`/account/reviews/{id}`, the collector's seeded written review: active,
revealed, with Report review and no reply form), the same build, 7 cold loads each (`measure.mjs
screen=review`). Not measured on marketplace.

| Review page | pilot desktop | pilot mobile |
|---|---|---|
| Interactive | 225 ms | 1,314 ms (1,311 ms on a second run) |
| Largest contentful paint | 244 ms | 1,200 ms |
| Server time (document) | 50 ms | 57 ms |
| JavaScript transferred | 9,330 B | 9,330 B |
| HTML / CSS transferred | 2,399 / 6,103 B | 2,399 / 6,103 B |
| Requests | 10 | 10 |

The tenth request and the 849 B more JavaScript are `corten_ui`'s dialog script, which loads with
Report review's dialog as on the account page. The mobile time is the long first layout the account
page's section describes, not the page's script.

An item's page (`/items/{slug}`, the seeded Charizard: four listings, four offers, the
fallback card back), the pilot's release build against marketplace's dev server, desktop only for
marketplace, at the `c590b8a` pin. As for the cart, the dev numbers are not a comparison. Measured
once, 7 loads each.

| Item page | marketplace (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 4,740 ms | 435 ms | 806 ms |
| Largest contentful paint | 2,632 ms | 464 ms | 8,016 ms |
| Server time (document) | 2,302 ms | 85 ms | 87 ms |
| JavaScript transferred | 7,692,764 B | 7,590 B | 7,590 B |
| HTML / CSS transferred | 510,161 / 186,198 B | 2,641 / 4,454 B | 2,641 / 4,454 B |
| Requests | 251 | 10 | 10 |

The pilot's mobile LCP is the item's picture: the fallback card back is a 1,451,020 B PNG, which
takes most of 8 s at 1.6 Mbps. Marketplace's page shows the same file
([chase-sets/chase-sets#10586 [discovery] Shrink the Pokemon card-back fallback pictures (1.45 MB and 2.95 MB PNGs)](https://github.com/chase-sets/chase-sets/issues/10586)).
The measurement does not count image bytes. The picture now has `fetchpriority="high"`, added
after this measurement.

With the rail's buy forms (measured once, 7 loads, pilot release only): the same
7,590 B of JavaScript, since the forms need none; HTML 3,164 B and CSS 4,814 B transferred;
interactive 435 ms desktop and 879 ms mobile; server time 111 ms and 250 ms (one run on a
shared machine, so the server times are noise until measured again).

At the `993eeac` pin, with Make an offer (measured once, 7 loads, pilot release only): JavaScript
7,847 B on the item page and the cart (+257 B, Corten's runtime reading a page again); item page
HTML 3,430 B and CSS 4,837 B; cart HTML 2,733 B and CSS 4,325 B. The times on that run were spread
widely on a busy machine (item page interactive 983 ms desktop and 607 ms mobile, cart 377 ms and
1,265 ms), so they are not compared with the runs above.

At the `9326a3f` pin, after the move to layouts (measured once, 7 loads, pilot release only): the
same bytes as at `993eeac`. JavaScript is 7,847 B on both pages; the item page is HTML 3,430 B and
CSS 4,837 B, and the cart is HTML 2,733 B and CSS 4,325 B. Item page: interactive 341 ms on desktop
and 660 ms on mobile, server 80 ms and 183 ms. Cart: interactive 523 ms and 780 ms, server 253 ms
and 246 ms. This was one run on a busy machine, so the times are noise. The item page's mobile
LCP of 7,956 ms was an outlier and was not re-run.

Catalog area (`/catalog`), the pilot only: this worktree has no admin-web production build, so
there is no React baseline for these pages yet (measured the same way, release build).

| Catalog dimensions | list desktop | list mobile | a dimension desktop | a dimension mobile |
|---|---|---|---|---|
| Interactive | 213 ms | 1,211 ms | 213 ms | 1,203 ms |
| Largest contentful paint | 244 ms | 1,012 ms | 256 ms | 1,000 ms |
| Server time (document) | 41 ms | 43 ms | 43 ms | 42 ms |
| JavaScript transferred | 7,702 B | 7,702 B | 7,702 B | 7,702 B |
| HTML / CSS transferred | 2,399 / 4,305 B | 2,399 / 4,305 B | 3,629 / 4,305 B | 3,629 / 4,305 B |
| Requests | 10 | 10 | 10 | 10 |

The area stylesheets, measured on the same loads (transferred brotli / decoded): every admin page
gets `style.css` (1,079 / 2,693 B) and `components.css`, the frame (1,687 / 7,224 B); catalog
pages add `sections/catalog.css` (1,539 / 7,426 B) and postage pages
`sections/commerce/postage-policies.css` (1,405 / 6,331 B). Neither area downloads the other's
1.4 to 1.5 kB. On mobile the catalog pages are interactive later than the postage list (1,211 against
507 ms; first paint is the same, about 1,000 ms). Interactive waits for every component script the
page uses, and the catalog pages use one, corten-ui's toaster, which the postage list does not;
postage's sheet, which runs its own script, is later still (1,556 ms). Not profiled further: the
blocking time is only counted up to interactive, so it grows with it and does not say which task
is slow.

Operations Attention queue (`/platform/operations-attention`, the sandbox's four unreviewed
feedback items), at the `c919779` pin, the pilot's release build against admin-web's dev server
(`react-router dev`), so admin-web's bytes and times are high by an unknown amount and are not a
comparison. admin-web desktop only: its mobile run did not finish one load in 120 s. Measured once,
7 loads each, on a busy machine.

| Attention queue | admin-web (dev) desktop | pilot desktop | pilot mobile |
|---|---|---|---|
| Interactive | 3,552 ms | 725 ms | 1,401 ms |
| Largest contentful paint | 1,900 ms | 752 ms | 1,212 ms |
| Server time (document) | 1,693 ms | 59 ms | 65 ms |
| JavaScript transferred | 7,911,621 B | 8,918 B | 8,918 B |
| HTML / CSS transferred | 429,249 / 186,139 B | 2,224 / 4,146 B | 2,224 / 4,146 B |
| Requests | 251 | 11 | 11 |

The pilot's CSS is `style.css` (1,083 B), `components.css` (2,008 B, now with the live status,
which two areas render) and `sections/platform/operations-attention.css` (1,055 B). Its
JavaScript includes the live status's script. Interactive waits for it, and the page's stream
opens and ends at once while the API refuses its topic.

Projection Operations (`/platform/projections`, the sandbox's 208 groups with one degraded, and
that group's sheet), at the `9f854ec` pin, the pilot's release build against admin-web's dev server
(`react-router dev`), so admin-web's numbers are high by an unknown amount and are not a comparison.
admin-web desktop only: its mobile run did not finish one load in 120 s. Measured once, 7 loads
each, on a busy machine. The pilot's server time is the projections read and the wake read
together (the API's projections read is most of it).

| Projection Operations | admin-web (dev) desktop | pilot desktop | pilot mobile | pilot desktop, a group's sheet | pilot mobile, a group's sheet |
|---|---|---|---|---|---|
| Interactive | 3,556 ms | 242 ms | 1,262 ms | 266 ms | 1,526 ms |
| Largest contentful paint | 1,792 ms | 340 ms | 1,012 ms | 284 ms | 1,552 ms |
| Server time (document) | 1,586 ms | 182 ms | 137 ms | 138 ms | 138 ms |
| JavaScript transferred | 5,164,092 B | 8,481 B | 8,481 B | 9,341 B | 9,341 B |
| HTML / CSS transferred | 878,138 / 186,139 B | 5,371 / 5,366 B | 5,371 / 5,366 B | 6,550 / 5,366 B | 6,550 / 5,366 B |
| Requests | 251 | 10 | 10 | 11 | 11 |

**A change to a catalog list**, measured with one tab watching the dimensions list and another
creating a dimension through the pilot, 5 changes each (median; `scripts/measure-live.mjs`). Both
follow the same realtime topic. admin-web here is its dev server (`react-router dev`), not a
production build, so its script time is high by an unknown amount; the bytes are not affected.

| One change, in the watching tab | admin-web (dev) | pilot (`corten dev`) |
|---|---|---|
| Fetches it makes | 2 | 0 |
| Bytes received for the change | 416 B event + 5,861 B fetched | 1,074 B (the rows, as HTML) |
| Script time / task time | 373 / 504 ms | 0 / 63 ms (under 1 ms of script) |
| New row on screen, after the create was sent | 9.1 s | 8.6 s |

The time to the screen is the platform's: the Catalog projection and the realtime outbox, the
same for both (2 to 15 s per sample). The pilot reads the list again on the server and sends the
rows it draws, so the tab receives the rows and nothing else. The pilot's event grows by about 250 B per
dimension the filter matches, because it sends every row on the page, not the changed one.
The 1,074 B was measured before the bulk bar; the bar is now drawn with the rows, so the same
event for a staff member who may change the records is larger. Measured after: 2,180 B raw for
`search=condition`, and 16,979 B raw for the full list (33 rows), of which 2,074 B is the bar's
form and 1,220 B its count template. The stream is not compressed
([todd-skelton/corten#24 corten::live responses are never compressed](https://github.com/todd-skelton/corten/issues/24)).

## Running it

From the worktree root, with the dev system running (`node scripts/dev-system.mjs dev admin-web`
for admin, `marketplace-full` for marketplace):

```powershell
node deployables/corten-pilot/scripts/sign-in.mjs http://localhost:7752 artifacts/corten-pilot/admin-state.json admin
node deployables/corten-pilot/scripts/sign-in.mjs http://localhost:7753 artifacts/corten-pilot/marketplace-state.json marketplace
cd deployables/corten-pilot/admin; corten dev --port 7790          # or marketplace/, --port 7792
cd ..
node scripts/smoke-admin.mjs           # every action in a browser, with and without JavaScript (writes sandbox data)
node scripts/smoke-marketplace.mjs     # the same for storage locations, with a lost answer and an uncertain write
node scripts/sign-in.mjs http://localhost:7792 ../../artifacts/corten-pilot/collector-state.json collector --api http://localhost:7762
node scripts/smoke-cart.mjs            # the cart beside the API's read and marketplace's page: lines, badges, prices, total, the offer, the checkout forms, no JavaScript, 390 px (only reads)
node scripts/smoke-cart.mjs http://localhost:7792 ../../artifacts/corten-pilot/collector-state.json http://localhost:7753 http://localhost:7762 --checkout
node scripts/smoke-cart.mjs --write     # also steps a one-line card's quantity up and back, with and without JavaScript (writes, left as found)
                                        # also sends Check out: a checkout session is started in the sandbox (a write); stops at the redirect to marketplace
node scripts/smoke-market-item.mjs    # an item's page beside the API and marketplace's: a guest without JavaScript, the collector with it, options, a long-list form, Select, sell, 301, 404, 390 px, the mobile dock (only reads)
node scripts/smoke-market-item-buy.mjs http://localhost:7793  # the rail's buy forms: listing, product, Buy best match (a refusal too), Buy this listing, Make an offer (a price past the field's step, then marketplace's offer checkout), a guest's cart and checkout, 390 px with every fold open (writes cart lines and removes them; starts checkout sessions)
node scripts/smoke-market-item-sell.mjs http://localhost:7793  # the rail's sell forms: a guest's payout and adds, a seller's Sell now, a collector refused, 390 px (writes sell-list lines and removes them; marketplace's own Sell List, where a guest's add lands, sometimes answers 500 while a checkout projection is behind: [chase-sets/chase-sets#10600 [checkout] Sell List page answers 500 after a guest add when the offer-reviews read is behind](https://github.com/chase-sets/chase-sets/issues/10600))
node scripts/smoke-market-item-watch.mjs http://localhost:7793  # the Watch tab: a guest's intent and marketplace's registration, the collector's alert with the catalog's words and the saved notice, a threshold past the field's step, 390 px (writes an alert and deletes it; a guest intent expires on its own)
node scripts/smoke-market-item-save.mjs http://localhost:7793  # Add to List: a guest's intent and marketplace's registration, the collector's dialog with no script and Add Product to a recent or new list with the page saying where it went, a refusal reopened as a modal, the sheet at 390 px (adds to the collector's list "Corten pilot smoke"; a guest intent expires on its own)
node scripts/smoke-market-item-list.mjs http://localhost:7793  # List this product as the seed seller: the post, the page while Discovery catches up and after, the same form again, the API's waits with the receipt, 390 px (lists below 250.00 and withdraws each listing)
node scripts/smoke-market-listing.mjs http://localhost:7793 # a listing's page beside marketplace's: its title, price, seller and facts, an unknown listing's 404, a visitor's Buy to guest checkout, a repeat report told so (no new report), the collector's Buy to a checkout session, two columns at 1280 px and one at 390 px (writes a checkout session)
node scripts/smoke-market-set.mjs http://localhost:7793     # a set's page beside marketplace's: its name, facts and cards in marketplace's order, an unknown set's 404, two columns at 1280 px and one at 390 px (reads only)
node scripts/smoke-market-search.mjs http://localhost:7793  # search as a visitor: the words' filters applied, Show results and a chip without a script, a filter applied on change with focus and scroll kept, the sort, a category's path, the filters dialog at 390 px, the home page's shelf and its columns at 1280 and 390 px (reads only)
node scripts/smoke-market-orders.mjs http://localhost:7794  # the account's orders beside marketplace's: Purchases, two purchases, Sales and a sale word for word, Open order, two to a page, a cancel the collector may not send (403) and one the API refuses, 1280 and 390 px (writes nothing the API applies)
node scripts/smoke-market-shipments.mjs http://localhost:7794  # the account's shipments beside marketplace's: Shipments and Open shipment, a buyer's and a seller's shipment in five statuses word for word (not the seller's Actions), the seller's list sent to marketplace, 1280 and 390 px (writes nothing)
node scripts/smoke-market-packing.mjs http://localhost:7794   # packing as the seed seller: Start or Resume packing as marketplace offers it, Ready to start, 390 px; Start packing with a script, which the sandbox's API refuses and cannot account for (#10645), so the page asks, says it could not confirm the write with every write off, Check again and Discard; once #10645 is fixed, it packs the sandbox's shipments awaiting their package, which cannot be undone
node scripts/smoke-market-addresses.mjs http://localhost:7794 [collector-state]  # the collector's shipping addresses: the API's list, 390 px; with a script, Save address (read after the write), a city sent empty (the API's words by the field), Update address in its modal dialog, Set default and Archive; without one, Save address and Archive. WRITES two synthetic addresses, archives them and makes the collector's default the default again
node scripts/smoke-market-sessions.mjs http://localhost:7794 [collector-state] [api-url]  # the collector's sessions: one card per session, 390 px with 44 px controls; the status filter reaches Auth (Active lists only active sessions, Clear lists them all); a session's page with its details, no Switch Account for a one-account session, the top bar's Sessions current and the pilot's, the breadcrumb back; with a script, Revoke asks first and signs a synthetic session out (Auth then refuses its token), and a revoke sent again (Auth's 500) says it is no longer active; without one, Revoke still opens its dialog and signs a second session out; a visitor signs in on the pilot. WRITES two synthetic sessions through Auth's password sign-in (tokens never printed), both revoked; the browser's own session is checked still signed in
node scripts/smoke-team.mjs http://localhost:7794 [demo-state] [api-url]  # the demo account's team as its owner: only the account's members and invitations (decision 67), each with its role and status, 390 px with 44 px controls and no sideways scroll, Revoke's dialog opened and closed with nothing sent; with a script, Change Role makes the manager a Viewer; without one, back to Manager; a visitor signs in on the pilot. WRITES the manager's role and restores it (through the API too, if a check failed); sends no invitation
node scripts/smoke-consents.mjs http://localhost:7794 [collector-state] [api-url]  # the collector's consent history: only the user's own consents (decision 68), or the words for none, Withdraw only on a recorded, current one, at 1280 and 390 px (no sideways scroll, 44 px buttons) and without a script; a visitor signs in on the pilot (only reads: the sandbox records no consents)
node scripts/smoke-reviews.mjs http://localhost:7794 [collector-state] [api-url]  # the collector's reviews: the summary's name, ratings and newest revealed reviews, each review Reputation lists received, written and as a seller (a card or its stand-in words), each one's own page (its order and back links, Report review and Respond only where marketplace offers them; another account's review is not found), Report review only on an active, revealed review not held, its dialog opened and closed with nothing sent, the current role marked, at 1280 and 390 px (no sideways scroll, 44 px controls) and without a script; a visitor signs in on the pilot (only reads: a report is tested against the stand-in API)
node scripts/smoke-market-security.mjs http://localhost:7794 [collector-state] [api-url]  # the collector's security page: Identity's names and sign-in methods, 390 px with 44 px controls; with a script, a key name of spaces is not sent, Create API Key answers 200 no-store at the page's own address with the secret, Copy copies it, a reload says it cannot be shown again, Rotate shows a new one, Revoke asks first, Update Profile saves a synthetic given name and puts it back; without one, Create shows the secret with no Copy and Revoke still opens its dialog; a visitor signs in on the pilot. WRITES two synthetic keys (revoked by the run; any left active is revoked through the API) and the given name (restored). Never prints a secret
node scripts/smoke-market-account-home.mjs http://localhost:7794 [collector-state]  # the collector's account page: what Identity has and who is signed in, the pilot's links, 390 px with 44 px controls; with a script, a legal name of spaces is not sent and Update Profile saves a synthetic marketplace name (read after the write); without one, Update Profile puts it back; a visitor signs in on the pilot. WRITES the marketplace name and restores it (through the API too, if a check failed)
node scripts/smoke-market-listing-new.mjs http://localhost:7794 [seller-state]  # Create listing as the demo seller: 390 px; with a script, find as you type, Choose, Preview fees in place, a non-picture refused, Save as draft with a PNG (the API has the draft and its photo); without one, Save as draft. WRITES drafts at 970-979 USD and withdraws them
node scripts/smoke-market-seller-listing.mjs http://localhost:7794 [seller-state]  # a seller's listing as the demo seller: a draft made through Create listing lands on it; 390 px; Preview fees, Save price, the quantity cap and the limits, two photos uploaded, described, reordered, one replaced and one removed, Withdraw's dialog (modal) and Cancel; without a script, the quantity cap; then Withdraw. WRITES one draft at 980-989 USD and withdraws it
node scripts/smoke-market-seller-listings.mjs http://localhost:7794 [seller-state] [api-url]  # the seller's listings as the demo seller: 390 px; the bulk bar; Set capacity and Remove cap; an away window scheduled (its instant the start of the day where the browser is, read on the server) and cancelled; Turn off listings and on; Pause selected on withdrawn listings (each refused); a draft's cap changed through the API redraws its row live; without a script, the filters and an away window scheduled from the start of its day in the account's zone (Identity's preferences), then cancelled. WRITES each setting and puts it back
node scripts/smoke-market-offer-matches.mjs http://localhost:7794 [seller-state] [collector-state] [api-url] [decline]  # the seller's offer matches as the demo seller: 390 px; the snapshot, the Sell List card and the matches; a synthetic offer from the collector (reused, chase-sets/chase-sets#10660) redrawn live when its price moves; a match's page with its terms and its actions at the bottom of a phone; Add selected offer to Sell List with and without a script. WRITES the offer's price and a sell list line it removes; with decline, a second offer it declines for good
node scripts/smoke-market-submitted-offers.mjs http://localhost:7794 [seller-state] [collector-state] [api-url]  # the buyer's submitted offers as the demo seller (WRITES one synthetic offer): 390 px; the filter's counts; the bulk bar once an offer is checked; the row drawn again live; Pause, Resume, Pause selected and Withdraw from its dialog without a script, or the closed lifecycle's answer; the collector sees no boxes or buttons
node scripts/smoke-market-inventory.mjs http://localhost:7794 [seller-state] [api-url]  # the inventory list and an item's page as the demo seller: the API's items, find as you type and a pasted id, Choose and the options (a raw card, chase-sets/chase-sets#10671), Create inventory item (to the pilot's item page, which confirms it); on that page Adjust Quantity +1, Create Hold and Release it (each confirmed, and the API has it), the ledger filtered to adjustments, Record sale of one unit; then Record sale of the last unit from the list's dialog. A page that says it could not verify a write is accepted only after the API timed out its receipt (chase-sets/chase-sets#10672). Without a script, Find, the dialog drawn open, a refused sale and a refused adjustment (422, nothing sent); both pages at 390 px. WRITES one synthetic raw Charizard at the first open location, adjusts, holds, releases and sells it out, leaving it with nothing available
node scripts/smoke-market-desk.mjs http://localhost:7794 [seller-state] [api-url]  # the Seller Desk as the demo seller, with and without a script: the API's count and one row per item in its order, each row's link (the pilot's own page for a listing, shipment or sale, chase-sets/chase-sets#10676), every summary filled in, the degraded banner naming the sources the API could not read without their reason, the active listings and open orders tiles; at 390 px nothing scrolls sideways, the tiles stack, every link is 44 px tall and a button-like link's text is at least 4.5:1 on its background (reads only)
node scripts/smoke-market-support.mjs http://localhost:7794 [seller-state] [marketplace-url] [api-url]  # the seed's Support Requests as the demo seller, with and without a script: titled by reference, who acts next by marketplace's rule, a timeline entry per moment the API holds and no forms when it is not the viewer's turn, beside marketplace's page; a case that does not exist is Not found; at 390 px nothing scrolls sideways and every control is 40 px tall. It never submits a form
node scripts/smoke-market-money.mjs http://localhost:7794 [seller-state] [marketplace-url] [api-url]  # the money page as the demo seller, with and without a script: the balance, the blocked payouts by marketplace's rule and a row per payout and movement against Settlement, beside marketplace's page; Request a payout off while setup is unfinished; a typed $5.00 previewed (a preview writes nothing) with Settlement's reasons and Confirm off; a payout's breakdown opened and closed with Escape; an adjustment the account has not; at 390 px nothing scrolls sideways, the figures stack and every control is 40 px tall. It never confirms a payout or runs a status check
node scripts/smoke-market-repricing.mjs http://localhost:7794 [seller-state] [api-url]  # the repricing desk as the demo seller, with and without a script: the policies and the halt against the API, the halt engaged through its dialog and released (WRITES the halt, released again), the editor's currency, floor and scope count against the API, a new strategy's name and undercut, Preview (a synthetic dry run, drawn live or reloaded) whose body is the compiled preset and whose changed count is the API's, Activate on, then a changed knob saying so with Activate off; at 390 px nothing scrolls sideways, the editor is one column, each table a card per row, every control 44 px tall and every button 4.5:1. It never activates a policy
node scripts/smoke-market-checkout.mjs http://localhost:7794 [session] [collector-state] [api-url]  # the buy checkout as the collector on a buy-now session it started, with and without a script: the session's lines, the checkout fee and payable total against Payments' quote for what the form sends, Update totals (offered with a script once a choice changes, which says the totals need a refresh) writing the address and shipping option to the session (WRITES the session's review; the shipping option alternates run to run), read after its receipt; at 390 px one column, nothing scrolls sideways, every control 44 px tall and Pay now in the bottom bar; at 1280 px the summary beside the form. It never presses Pay now
node scripts/smoke-sign-in.mjs http://localhost:7794  # the pilot's sign-in as the collector (the right password only: chase-sets/chase-sets#10686), with and without a script at 390 and 1280 px: signed-out purchases go to the pilot's sign-in, the email's methods, the session cookie (HttpOnly, Lax), back on the pilot's purchases, then signing out
node scripts/smoke-restock.mjs         # restock decisions: the API's list, a stale version refused, an uncertain write, no JavaScript, 390 px (records no decision)
node scripts/smoke-catalog.mjs         # the catalog area: a dimension's and a field's whole life, with and without JavaScript
node scripts/smoke-live.mjs            # the catalog lists stay current while another tab writes ([..] [state] http://localhost:7752 watches admin-web's)
node scripts/smoke-bulk.mjs            # bulk lifecycle changes on the dimensions list, with and without JavaScript
node scripts/smoke-items.mjs           # the catalog items list: create, the changes count, a bulk edit, removing drafts, 390 px
node scripts/smoke-item.mjs            # a catalog item's page: a draft through every dialog, with and without JavaScript, 390 px
node scripts/smoke-attention.mjs       # the attention queue beside admin-web's: same items, a sheet, dismiss, defer and restore, no JavaScript, 390 px (parks one item and restores it)
node scripts/smoke-operations-attention.mjs  # the Operations Attention queue beside admin-web's: the counts, the same rows in order, each Open answering on admin-web, the stream, no JavaScript, 390 px (only reads)
node scripts/smoke-projections.mjs           # Projection Operations beside admin-web's: the repair queue in order, eight counts, a filter, a group's sheet (Rebuild's confirm opened and cancelled), its blocked streams and poison events, a poison event's Retry (not pressed), Escape or the close link, Refresh status, no JavaScript, 390 px (refreshes the groups' status; repairs nothing)
node scripts/smoke-scopes.mjs          # the scopes list beside admin-web's ([..] [admin-web]): same rows, the filters, View, no JavaScript, 390 px (only reads)
node scripts/smoke-scope.mjs           # a scope's page ([..] [admin-web] [state] [scope]): its sections, the coverage beside admin-web's, a revoke's fold, Propose mapping and its refusal, no JavaScript, 390 px (writes nothing)
node scripts/measure-live.mjs pilot=http://localhost:7790 admin-web=http://localhost:7752   # what one change costs the watching tab
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/measure.mjs screen=marketplace marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=cart marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=item marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=search marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=home marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=set marketplace=http://localhost:7753 pilot=http://localhost:7793 set=base-set
node scripts/measure.mjs screen=listing marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=purchases marketplace=http://localhost:7753 pilot=http://localhost:7794   # screen=sales for the seller; order= for another order
node scripts/measure.mjs screen=shipments marketplace=http://localhost:7753 pilot=http://localhost:7794   # screen=sale-shipment for the seller's page; shipment= for another shipment
node scripts/measure.mjs screen=catalog dimension=dim_seed_condition admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/smoke-public-market.mjs http://localhost:7797 http://localhost:7754  # public-web's market page beside its own: the head's tags, the h1 and sections, every stat, the links, what caches keep (with and without a cookie), no JavaScript, a 404, robots and the sitemap, 1280 and 390 px (only reads)
node scripts/measure.mjs screen=market public-web=http://localhost:7754 pilot=http://localhost:7797   # signed out
node scripts/smoke-public-home.mjs http://localhost:7797 http://localhost:7754  # public-web's home page beside its own: the head's tags, the h1 shown, the sections in order, every word and fee figure, the promo bar's message, what caches keep, Join without a script (a signup to /welcome, a refusal drawn again), the legacy share link's move, no JavaScript, Buy's swap, 1280 and 390 px (writes one waitlist signup with a synthetic email)
node scripts/measure.mjs screen=landing public-web=http://localhost:7754 pilot=http://localhost:7797 profiles=desktop runs=11   # signed out
corten check                           # at the workspace root: cargo fmt, corten fmt, clippy -D warnings, cargo test
```

Run `corten dev` inside the app's directory; it also rebuilds on an edit in `platform/`.

| Variable | Default | |
|---|---|---|
| `PLATFORM_API_ORIGIN` | `http://localhost:7762` | the platform API the apps call |
| `ADMIN_WEB_ORIGIN` | `http://localhost:7752` | admin: sign-in and the admin pages the nav links to |
| `MARKETPLACE_WEB_ORIGIN` | `http://localhost:7753` | marketplace: sign-in and the pages the nav links to |
| `PUBLIC_PROTO` | `http` | the scheme forwarded to the API as `x-forwarded-proto` |
| `CHASE_SETS_PUBLIC_ORIGIN` | `https://chasesets.com` | public: the canonical origin (canonical links, the sitemap, the host the API is told) |
| `CHASE_SETS_MARKETPLACE_ORIGIN` | `https://marketplace.chasesets.com` | public: where Buy or sell links go |
| `CHASE_SETS_PUBLIC_INDEXING` | on | public: `0`, `false`, `no` or `off` adds `noindex`, closes `robots.txt` and empties the sitemap |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:7754` | public: public-web's pages it does not serve (`/welcome`, the compare pages, the founders' terms, the FAQ, the policies) |
| `PROXIES` | none | every app (read by Corten): the proxies in front, comma separated addresses or networks (`10.0.0.0/8`), whose `X-Forwarded-For` `ClientIp` follows back to the visitor; without it the visitor is the connection's peer. Set it where a deploy would have set `CHASE_SETS_TRUST_FORWARDED_HEADERS` for the Node apps. public's Join sends the address to the API |
| `CHASE_SETS_DISCORD_INVITE_URL` | none | public: the Discord invite the home page links, when set |

`scripts/export.mjs` writes what the apps read from Chase Sets' sources: each screen's English
text (`*/locales/en.json`), each app's navigation (`*/nav.json`), admin's default policy
(`admin/defaults.json`), the scope product domains (`admin/scope-domains.json`), the design system's tokens (`platform/tokens.json`, with the brand's foil colors), three fonts, and the home page's words (`public/locales/home.en.json`) and pictures (`public/static/home/`). CI
runs it with `--check`, so a change to the React apps' text, nav or tokens shows up here.
`*/locales/pilot.en.json` is the pilot's own text. One image per app:
`docker build --build-arg APP=marketplace .` (or `admin`, `public`).

The market page's reference is public-web's dev server, which the dev system does not start
with `marketplace-full`. From the worktree root, on 7754 against the sandbox's API:
`PORT=7754 CHASE_SETS_INTERNAL_API_ORIGIN=http://localhost:7762 CHASE_SETS_PUBLIC_ORIGIN=http://localhost:7754 CHASE_SETS_MARKETPLACE_ORIGIN=http://localhost:7753 node node_modules/@react-router/dev/bin.js dev`
in `deployables/public-web`. The pilot's app runs with `CHASE_SETS_PUBLIC_ORIGIN=http://localhost:7797`
and `CHASE_SETS_MARKETPLACE_ORIGIN=http://localhost:7753` so the two pages name the same places.

## Corten pin

`Cargo.toml` (the workspace) pins Corten to a revision. No release is tagged, and the pin moves
forward only on purpose, when a fix the pilot needs lands.

| Revision | Why it moved |
|---|---|
| `ffa13a8` | the start |
| `01586b4` | `tokens!` themes under a media condition; `Errors::add_form` |
| `122fd5d` | `App::serve` listens on both loopback addresses |
| `028655d` | a stylesheet class may be named like its component (the pilot's renames are undone) |
| `ad8d3af` | the four commits above rebased onto Corten `main` at `340c133`, which closed the pilot's gaps: `App::guard`, `FieldName` in the prelude, `Result<T, E>` (see Corten gaps) |
| `04989b5` | Corten `main` with the pilot's commits merged ([todd-skelton/corten#7 Pilot fixes, and areas and APIs checked at compile time](https://github.com/todd-skelton/corten/pull/7)), and its breaking changes: `App<C>` (`.context` before `.shell` and `.guard`), `App::guard` without a prefix for the whole app, `corten::serve(app)` |
| `860d985` | [todd-skelton/corten#12 corten dev watches local packages; a navigation before load is a full load](https://github.com/todd-skelton/corten/pull/12) closed two of the pilot's gaps (the workaround in `recovery.js` is gone), and [todd-skelton/corten#8 Less work per page: escape, route parameters and module tags](https://github.com/todd-skelton/corten/pull/8); no breaking change for the pilot |
| `733fdd4` | [todd-skelton/corten#14 A data-patch form posts to its own action whatever its controls are named](https://github.com/todd-skelton/corten/pull/14) closed [todd-skelton/corten#13 A control named action or method breaks a data-patch form](https://github.com/todd-skelton/corten/issues/13): the lifecycle button is `action` again and its router test is gone; no breaking change for the pilot |
| `6f2ba32` | [todd-skelton/corten#21 A <corten-live> stream resumes from the app's cursor](https://github.com/todd-skelton/corten/pull/21) closed [todd-skelton/corten#15 A <corten-live> stream cannot resume after a reconnect](https://github.com/todd-skelton/corten/issues/15). Breaking for the pilot only in a test: a live route the API refuses now draws nothing (a stand-in session the stream accepts, `catalog-viewer`, checks a viewer's rows). Also brings [todd-skelton/corten#16 Write JSON with a derive whose layout is fixed at compile time](https://github.com/todd-skelton/corten/pull/16) (`Json` and `ToJson` move to the end of the prelude; nothing in the pilot changed) and [todd-skelton/corten#19 Copy a route parameter at once when nothing in it needs encoding](https://github.com/todd-skelton/corten/pull/19) |
| `f80d4a1` | Corten `main` with the pilot's earlier gaps closed: [todd-skelton/corten#9 Forms have no per-submission idempotency key](https://github.com/todd-skelton/corten/issues/9) (`SubmitKey`), [todd-skelton/corten#20 corten check does not type-check an app's scripts](https://github.com/todd-skelton/corten/issues/20), [todd-skelton/corten#24 corten::live responses are never compressed](https://github.com/todd-skelton/corten/issues/24) and [todd-skelton/corten#26 A component that names a variable scope is treated as scoped](https://github.com/todd-skelton/corten/issues/26). Breaking: `Json`, `req.screen` and `json_ld` take `ToJson`, so the screens and the catalog's read types derive it. `DimensionDetail` flattens a struct, which the derive refuses ([todd-skelton/corten#34 #[derive(ToJson)] refuses #[serde(flatten)] of a struct that is itself ToJson](https://github.com/todd-skelton/corten/issues/34)), so it writes itself through serde. `SubmitKey` is not used yet: it was 32 hex digits and the Inventory API takes a UUID ([todd-skelton/corten#35 A SubmitKey can only be 32 hex digits, so an API that takes a UUID cannot use it](https://github.com/todd-skelton/corten/issues/35)) |
| `014a2fd` | Corten `main` with [todd-skelton/corten#32 A route cannot share a set of query parameters with another route](https://github.com/todd-skelton/corten/issues/32), [todd-skelton/corten#33 A page cannot tell whether a <corten-live> element is connected](https://github.com/todd-skelton/corten/issues/33), [todd-skelton/corten#34 #[derive(ToJson)] refuses #[serde(flatten)] of a struct that is itself ToJson](https://github.com/todd-skelton/corten/issues/34), [todd-skelton/corten#35 A SubmitKey can only be 32 hex digits, so an API that takes a UUID cannot use it](https://github.com/todd-skelton/corten/issues/35), [todd-skelton/corten#39 corten check at a workspace root type-checks none of the members' scripts](https://github.com/todd-skelton/corten/issues/39), [todd-skelton/corten#44 A form with a control named id cannot be patched](https://github.com/todd-skelton/corten/issues/44), [todd-skelton/corten#45 Field error ids are only the field's name, so two forms on a page share them](https://github.com/todd-skelton/corten/issues/45) and [todd-skelton/corten#17 Scripts have no typed way to show user-facing text they compute](https://github.com/todd-skelton/corten/issues/17) closed, each adopted (see Corten gaps). Breaking: `Errors::aria` and `Errors::message` are gone; a form's field errors are `errors.within(FormId)`, with typed form ids, and their ids are `{form id}-{field}-error` |
| `c35a10a` | Corten `main` with [todd-skelton/corten#49 A script cannot hear a <corten-live> element's status change](https://github.com/todd-skelton/corten/issues/49) and [todd-skelton/corten#50 A @typedef of plain values and a Message is not a group, and the error does not say why](https://github.com/todd-skelton/corten/issues/50) closed, both adopted. No breaking change for the pilot; its tests changed only where a page's markup did (`LiveStatus` now draws the `<corten-live>`, and `drawn` takes one group) |
| `e220c14` | Corten `main` with [todd-skelton/corten#54 A page cannot show a catalog message chosen at run time by its key](https://github.com/todd-skelton/corten/issues/54) and [todd-skelton/corten#56 A catalog message cannot take an argument named like a Rust keyword ({type})](https://github.com/todd-skelton/corten/issues/56) closed, both adopted (`t.by_key`; `{type}` as it is). No breaking change for the pilot. Also brings a feed's snapshot kept between writes (CHANGELOG, Changed 38) |
| `26c55a8` | Corten `main` with [todd-skelton/corten#58 A catalog message cannot take a camelCase argument ({updatedAt})](https://github.com/todd-skelton/corten/issues/58) closed and adopted: the exported catalogs keep their camelCase arguments. Breaking for the pilot only in a script: a `Message<"...">` JSDoc and its call take the catalog's names (`bulk_rows.js` says `entityName`) |
| `c268ecc` | Corten `main` with [todd-skelton/corten#61 A patch element without an id is dropped in the browser, and nothing says so before](https://github.com/todd-skelton/corten/issues/61) and [todd-skelton/corten#64 A page cannot send a form to another origin, and a post cannot redirect to one (form-action is always 'self')](https://github.com/todd-skelton/corten/issues/64) closed, both adopted: the router tests' `patch_ids` is gone, and the cart's Check out is a form whose redirect goes to marketplace (`Policy::form_action`). No breaking change for the pilot |
| `c590b8a` | Corten `main` with [todd-skelton/corten#60 A page cannot write a date and time in the request's locale](https://github.com/todd-skelton/corten/issues/60) and [todd-skelton/corten#63 A page cannot write an amount of money in the request's locale](https://github.com/todd-skelton/corten/issues/63) closed, both adopted (`t.money`, `t.date_time`, `t.js().date_time`). No breaking change for the pilot. Its tests changed only where its own output did: a line's price in the screen JSON is now the amount and currency, and the live status's markup carries the date format |
| `993eeac` | Corten `main` with [todd-skelton/corten#69 A page cannot ask to be read again shortly, and the Refresh header only works on a full load](https://github.com/todd-skelton/corten/issues/69) closed and adopted (`Meta::read_again`; the cart's line writes are `data-patch`). No breaking change for the pilot. The runtime grows 282 B gzipped (Corten's measurement) |
| `9326a3f` | Corten `main` with [todd-skelton/corten#71 A typed route cannot carry query parameters whose names are data (dimension.<id>=<option>)](https://github.com/todd-skelton/corten/issues/71) and [todd-skelton/corten#72 A page that moved cannot redirect permanently (Req::redirect is always 303)](https://github.com/todd-skelton/corten/issues/72) closed ([todd-skelton/corten#73 Routes: query parameters named by data, and a permanent redirect](https://github.com/todd-skelton/corten/pull/73)) and adopted, plus the breaking change to pages ([todd-skelton/corten#75 Pages are documents built from components, and routes name their handlers](https://github.com/todd-skelton/corten/pull/75)): `Meta` and `App::shell` are gone, so each app's shell became its `Layout` component (in `views.rs`; it reads the session with `req.context::<Session>()`), every page is `req.page`/`req.screen` of a `Layout` with its title and head tags as `html!` (the cart's pending read is `<ReadAgain>` there), and `error_page` takes `&Req` and `Failure` (Corten sends it with `X-Robots-Tag: noindex`). Three gaps found and filed ([#76](https://github.com/todd-skelton/corten/issues/76), [#77](https://github.com/todd-skelton/corten/issues/77), [#78](https://github.com/todd-skelton/corten/issues/78); see [Corten gaps](#corten-gaps)). The same bytes on the item page and the cart |
| `052b327` | Corten `main` with [todd-skelton/corten#79 A patch is checked when it compiles, and a component parameter can be impl Render](https://github.com/todd-skelton/corten/pull/79). Breaking: `req.patch`, `req.patch_with_status` and `req.invalid` take an `impl Patch`, which the compiler checks. About 35 components a patch sends now say `-> impl Patch`: every write form, dialog and refusal, marketplace's `Recovery` and `WriteForm`, and admin's `Dialog`, `LiveStatus` and the list rows. An id at a patch's top level must be a `#[derive(Id)]` type, so admin's dialog, lifecycle, rows, live and changes ids became types named to render the same strings (`CatalogCreateDialogId` is `catalog-create-dialog`), and `Dialog`, `Trigger`, `LiveStatus`, `LifecycleForm`, `OptionLifecycleForm` and `WriteForm` take a typed id. Three kinds of id changed form. An item page row's form and a reference's dialog are `ItemId(key)`, which renders `item-{key}` as before. An option's edit dialog and lifecycle form are now `option-dialog-{id}` and `option-lifecycle-{id}` (they were `option-{id}-dialog` and `option-{id}-lifecycle`; nothing else names them). The two reference dialogs share one type, `ItemId("product-ref-dialog")`, since the page picks either. One gap found and filed ([todd-skelton/corten#82 A view that is lets then one patch component is not a patch (One<F> never implements Patch)](https://github.com/todd-skelton/corten/issues/82); see [Corten gaps](#corten-gaps)). The debug-only patch scan is gone, so the router tests now rely on the compiler |
| `91af573` | Corten `main` with [todd-skelton/corten#76 A page cannot write JSON-LD in its head since Meta was removed (an expression in <script> is escaped as HTML)](https://github.com/todd-skelton/corten/issues/76), [todd-skelton/corten#77 A view that is one component cannot pass a reference to its own locals (E0515 since the document change)](https://github.com/todd-skelton/corten/issues/77) and [todd-skelton/corten#78 An area's routes cannot name their handlers (#[corten::routes] covers only App::new)](https://github.com/todd-skelton/corten/issues/78) closed ([todd-skelton/corten#80 JsonLd, views that own their lets, and routes modules for areas](https://github.com/todd-skelton/corten/pull/80)), each adopted (see Corten gaps). No breaking change for the pilot: `<script>` and `<style>` now refuse an expression at compile time, and the pilot wrote none after its `JsonLd` was removed. Only the item area moved to an area routes module; the cart, inventory, postage and catalog areas keep `.route::<R>()` calls, which Corten still accepts; moving them is mechanical and checks nothing new |
| `c919779` | Corten `main` with [todd-skelton/corten#84 A patch or live fragment closes a <dialog> the user opened and folds a <details> they unfolded](https://github.com/todd-skelton/corten/issues/84) closed ([todd-skelton/corten#85 A patch keeps what the user opened: dialogs, details and popovers](https://github.com/todd-skelton/corten/pull/85)) and adopted: the item page's reference dialogs are back in the Details tab, beside their triggers, inside the market book a change to the item redraws. No breaking change for the pilot (Corten's runtime grows 268 B gzipped, its measurement) |
| `c7fc490` | Corten `main` with [todd-skelton/corten#86 A dialog the server draws open (a refused form without JavaScript) is not modal, and every app writes the handler that fixes it](https://github.com/todd-skelton/corten/issues/86) closed ([todd-skelton/corten#87 A dialog the server draws open is modal: corten_ui::dialog::modal](https://github.com/todd-skelton/corten/pull/87)) and adopted: both apps' `modal` handlers are gone. No breaking change for the pilot |
| `de6f039` | Corten `main` with [todd-skelton/corten#82 A view that is lets then one patch component is not a patch (One<F> never implements Patch)](https://github.com/todd-skelton/corten/issues/82) closed ([todd-skelton/corten#83 A view that is lets then one patch component is a patch](https://github.com/todd-skelton/corten/pull/83)) and adopted: the four `match () { () => { .. } }` blocks are gone. No breaking change for the pilot |
| `319d3b7` | Corten `main` with [todd-skelton/corten#81 A route's handler says what it answers, who may call it and how it caches, checked for every route](https://github.com/todd-skelton/corten/pull/81) merged, the breaking change the pilot had been ported to ahead of time on `pilot/corten-route-handlers` (below), and [todd-skelton/corten#94 Filters keep the user's place, lists grow by appending, query names follow serde, areas share stylesheets](https://github.com/todd-skelton/corten/pull/94). Breaking beyond the earlier port: `App::new` takes `Routes` (`Routes::new()` in admin, where every route is in an area), so the local `[patch]` is gone and the four search gaps' workarounds could be removed (see [Corten gaps](#corten-gaps)) |
| `d824f40` | Corten `main` with [todd-skelton/corten#102 Keeping a place keeps the rail's scroll and the open groups; Fields takes generics; Route declares serde](https://github.com/todd-skelton/corten/pull/102) merged, closing [#96](https://github.com/todd-skelton/corten/issues/96), [#97](https://github.com/todd-skelton/corten/issues/97), [#98](https://github.com/todd-skelton/corten/issues/98) and [#99](https://github.com/todd-skelton/corten/issues/99), each adopted (see [Corten gaps](#corten-gaps)). No breaking change for the pilot |
| `770b7eb` | Corten `main` with [todd-skelton/corten#105 A typed route carries a place on its page (Route::at); t.date writes the month and year (MonthStyle)](https://github.com/todd-skelton/corten/pull/105) merged, closing [#100](https://github.com/todd-skelton/corten/issues/100) and [#101](https://github.com/todd-skelton/corten/issues/101), each adopted (see [Corten gaps](#corten-gaps)). No breaking change for the pilot |
| `0f3f03f` | Corten `main` with [todd-skelton/corten#108 The error page takes extractors (the caller), Failure::Unidentified, ReadAgain at a #place](https://github.com/todd-skelton/corten/pull/108) merged, closing [#88](https://github.com/todd-skelton/corten/issues/88), [#89](https://github.com/todd-skelton/corten/issues/89) and [#107](https://github.com/todd-skelton/corten/issues/107), each adopted (see [Corten gaps](#corten-gaps)), and [todd-skelton/corten#109 Brand pack, README lockup, and favicons for the examples and corten new](https://github.com/todd-skelton/corten/pull/109), which changes nothing the pilot uses. Breaking: `App::error_page(page, state)` takes an async function of the `Failure` and extractors, and `Failure` has a new case, `Unidentified`, which each app's error page now names |
| `8cb28fb` | Corten `main` with [todd-skelton/corten#110 Public::shared (s-maxage); a patch can ask to be read again (ReadAgain::from)](https://github.com/todd-skelton/corten/pull/110) merged, closing [#104](https://github.com/todd-skelton/corten/issues/104) and [#106](https://github.com/todd-skelton/corten/issues/106), each adopted, and [#95](https://github.com/todd-skelton/corten/issues/95) closed as not planned, its workaround removed (see [Corten gaps](#corten-gaps)). No breaking change for the pilot: `Public::shared` and `ReadAgain::from` are new |
| `cf48958` | Corten `main` with [todd-skelton/corten#118 A patch's read again stops quietly when the server fails it](https://github.com/todd-skelton/corten/pull/118): a read again's answer that is a patch is applied whatever its status, so an alert's read that fails after its write now says so in place (502) where it navigated. No breaking change for the pilot |
| `b35c934` | Corten `main` with [todd-skelton/corten#124 Answer only localhost, IP addresses and listed host names (421 otherwise)](https://github.com/todd-skelton/corten/pull/124) (breaking: an app answers only `localhost`, IP literals and the names in `HOSTS`; the pilot runs on `localhost`, and a deployment under a domain would set `HOSTS`), [todd-skelton/corten#127 App::task: work that lives as long as the app, stopped and waited for on shutdown](https://github.com/todd-skelton/corten/pull/127) (breaking: `corten::serve` takes an `App`, which the pilot's three `main.rs` already pass; `Abort::Shutdown`, which it matches nowhere) and [todd-skelton/corten#128 The error page keeps the headers of the failure it replaces](https://github.com/todd-skelton/corten/pull/128). No change to the pilot's code: `corten check` passed at admin 62, marketplace 158, platform 9, public 19, and the packing, shipments, notifications, public home and public market smokes passed on its release build |
| `4bd06d3` | Corten `main` with [todd-skelton/corten#132 #[derive(UrlValue)]: an enum in an address spells its words once](https://github.com/todd-skelton/corten/pull/132) (`811b274`, closing [todd-skelton/corten#129 A query value must be Display while it is read with serde, so an enum in an address spells its words twice](https://github.com/todd-skelton/corten/issues/129)) and [todd-skelton/corten#134 A page in another layout has another shell key](https://github.com/todd-skelton/corten/pull/134) (`4bd06d3`, closing [todd-skelton/corten#122 Client navigation between pages with different layouts keeps the first layout, because the shell key does not include the layout](https://github.com/todd-skelton/corten/issues/122)). Neither is breaking. The seven hand-written `Display` impls for the enums in addresses became `#[derive(UrlValue)]`, and the `data-reload` links between the two public layouts are gone. `corten check` passed at admin 62, marketplace 169, platform 9, public 19, and the public home, public market, shipments, packing, notifications and shipping addresses smokes passed on its release build |
| `15dc546` | Corten `main` with [todd-skelton/corten#136 A client navigation is told about a redirect to another site](https://github.com/todd-skelton/corten/pull/136) (closing [todd-skelton/corten#131 A client navigation to a route that redirects to another origin is blocked by connect-src, then reloads](https://github.com/todd-skelton/corten/issues/131)), [todd-skelton/corten#135 An area or an API sets its own deadline](https://github.com/todd-skelton/corten/pull/135) (closing [todd-skelton/corten#114 App::deadline is one value for the whole app, so one slow route (an upstream call, an upload) lifts it for every page](https://github.com/todd-skelton/corten/issues/114)) and [todd-skelton/corten#137 corten::serve_on serves an app on listeners of its own](https://github.com/todd-skelton/corten/pull/137) (closing [todd-skelton/corten#115 corten::serve takes no listener, so an app that needs TLS or its own socket loses the loopback pair, the stream drain and graceful shutdown](https://github.com/todd-skelton/corten/issues/115)). None is breaking. The packing page's Back links the pilot's `/account/sales/shipments` again; a click there was checked to reach marketplace's command center in one navigation with no console error. `corten check` passed at admin 62, marketplace 169, platform 9, public 19 |
| `2338bcb` | Corten `main` with [todd-skelton/corten#141 t.percent and t.js().percent: a ratio as the locale writes a percentage](https://github.com/todd-skelton/corten/pull/141) (closing [todd-skelton/corten#119 i18n writes no percentage, so a rate like 2.9% cannot be localized](https://github.com/todd-skelton/corten/issues/119)) and [todd-skelton/corten#138 Elsewhere::at: a place on a page outside the app keeps its fragment](https://github.com/todd-skelton/corten/pull/138) (closing [todd-skelton/corten#123 An address outside the app cannot carry a #fragment, so req.moved and req.redirect drop the anchor of an external URL](https://github.com/todd-skelton/corten/issues/123)). Not breaking. Both workarounds removed: the home page's rates are `t.percent` (`home::rate`), and the fee calculator's share link moves with `corten::Elsewhere::at(&to, "fee-calculator")`. Create listing was ported at this pin. |
| `a12c78b` | Corten `main` with [todd-skelton/corten#144 html! and corten fmt read a pattern with braces as Rust does](https://github.com/todd-skelton/corten/pull/144), closing [todd-skelton/corten#142 html! if let cannot take a struct pattern: the pattern's braces are read as the body](https://github.com/todd-skelton/corten/issues/142). Not breaking. The workaround is removed: Create listing's view matches `if let Catalog::Chosen { item, picks, reset } = &screen.catalog`, and `Catalog::chosen()` is gone. |
| `07d7f65` | Corten `main` with [todd-skelton/corten#145 ClientIp: the visitor's address, from the peer or a trusted proxy's X-Forwarded-For](https://github.com/todd-skelton/corten/pull/145), closing [todd-skelton/corten#120 A handler cannot read the client's address, so an app that calls an API for a visitor cannot pass it on for rate limiting](https://github.com/todd-skelton/corten/issues/120). Not breaking. public's Join takes `Option<corten::ClientIp>`; `platform::client` (the `CHASE_SETS_TRUST_FORWARDED_HEADERS` reader) is gone, and a deploy lists its proxies in `PROXIES`. The router tests give the request a connection address (`ConnectInfo`) and check that, with no proxy listed, the browser's `X-Forwarded-For` is not read. |
| `76eda4f` | Corten `main` with [todd-skelton/corten#146 A patch keeps the files chosen in a file input it replaces](https://github.com/todd-skelton/corten/pull/146), closing [todd-skelton/corten#143 A patch drops the files chosen in a file input it replaces, so a refused upload cannot mark its input invalid](https://github.com/todd-skelton/corten/issues/143). Not breaking. The workaround is removed: Create listing's photo fieldset is a patched part (`PhotosPart`), its input marked `aria-invalid` and described by its message after a refusal, and `PhotoErrorPart` is gone. Its smoke now checks that the refused input keeps its file, is invalid and names the message. That check found [todd-skelton/corten#147 A field with its own hint cannot also point at its error: Within::aria writes a second aria-describedby, which the browser drops](https://github.com/todd-skelton/corten/issues/147): the input writes its own `aria-describedby` until it is fixed. `corten check` passed at admin 62, marketplace 195, platform 8, public 19 |
| `12e0695` | Corten `main` with [todd-skelton/corten#148 Upload<T>: a multipart form's files as they arrive, then its fields by Form's rules](https://github.com/todd-skelton/corten/pull/148), closing [todd-skelton/corten#140 A form cannot post a file: Form reads only URL-encoded bodies, so a multipart form is a 415 and nothing reads its files](https://github.com/todd-skelton/corten/issues/140). Not breaking. The multer workaround is removed: `uploads::read` takes an `Upload<Raw>` (the form's fields read as the address is), limits the body with `upload.limit`, reads each photo up to its limit with `bytes_up_to` and reads past the rest, and Create listing's and a seller's listing's photo handlers take it in place of the raw body. Moving it found [todd-skelton/corten#150 A handler cannot read an Error's status, so an upload over Upload::limit (413) cannot draw the form again with a message](https://github.com/todd-skelton/corten/issues/150): a body over the limit is refused by its `Content-Length` first. `corten check` passed at admin 62, marketplace 205, platform 10, public 19 |
| `132c136` | Corten `main` with [todd-skelton/corten#125 An API's routes go in a routes module of their own, Result leaves the prelude, Caller derefs, and the examples use every pattern](https://github.com/todd-skelton/corten/pull/125) and [todd-skelton/corten#151 A data-keep-place swap keeps a rail's scroll made in the same frame](https://github.com/todd-skelton/corten/pull/151), closing [todd-skelton/corten#130 Firefox sometimes loses the filter rail's own scroll after a data-keep-place swap (smoke: 76 -> 0)](https://github.com/todd-skelton/corten/issues/130). Breaking: `#[route(.., link)]` is gone, so every route in a routes module names its handler, and an area's prefix route can no longer be one with no page. The item page's four link-only routes (`ItemWritten`, `ItemWatched`, `ItemSaved`, `ItemAdded`) are now one `#[route(query)]` field of `url::Item`, `items::After`. The seven areas with no page at their prefix (`/categories`, `/accounts`, `/listings`, `/sets`, `/items`, `/account/inventory` and public's `/market`) name a `#[derive(Route)]` prefix struct declared outside their module, which found [todd-skelton/corten#152 An area with no page at its prefix (/items, /sets) must declare the prefix as a link-only route outside its routes module](https://github.com/todd-skelton/corten/issues/152). Adopted: `Caller` dereferences (`session.as_deref()`), and `.area(mod::area)` infers the prefix. `corten::Result` and the prelude's `Result` were not used. `corten check` passed at admin 62, marketplace 211, platform 10, public 19 |
| `9627ee2` | Corten `main` with [todd-skelton/corten#156 UploadError: a body over Upload::limit can be answered in the form](https://github.com/todd-skelton/corten/pull/156), closing [todd-skelton/corten#150 A handler cannot read an Error's status, so an upload over Upload::limit (413) cannot draw the form again with a message](https://github.com/todd-skelton/corten/issues/150). Not breaking. The `Content-Length` precheck is removed: `uploads::read` returns `UploadError`, and Create listing's and a seller's listing's photo handlers match `UploadError::TooLarge` once to draw the form again with a 413, with a length or without (a chunked 72 MB body now gets the form, not the error page); `?` turns the other errors into 400 and 422. `corten check` passed at admin 62, marketplace 218, platform 10, public 19 |
| `06821f8` | Corten `main` with [todd-skelton/corten#155 A field's hint and its error share one aria-describedby](https://github.com/todd-skelton/corten/pull/155), closing [todd-skelton/corten#147 A field with its own hint cannot also point at its error: Within::aria writes a second aria-describedby, which the browser drops](https://github.com/todd-skelton/corten/issues/147). Breaking only for a tag that writes `aria-describedby` or `aria-invalid` beside `e.aria(..)`, which the pilot did not. The workaround is removed: Create listing's photo input takes `{..e.aria(f.evidence).hint(&ListingPhotosHintId)}`, one `aria-describedby` naming its hint and then its error, in place of the ids built by hand; a router test checks the attribute. `corten check` passed at admin 62, marketplace 218, platform 10, public 19 |
| `af7d7cb` | Corten `main` with [todd-skelton/corten#168 A page whose handlers call an unserved script module fails in debug builds](https://github.com/todd-skelton/corten/pull/168), closing [todd-skelton/corten#157 A page that names a script! module the app does not serve renders fine; only the browser finds the 404, and its handlers silently do nothing](https://github.com/todd-skelton/corten/issues/157), and [todd-skelton/corten#165 An area with no page at its prefix: the prefix route names no handler and is not a link](https://github.com/todd-skelton/corten/pull/165), closing [todd-skelton/corten#152 An area with no page at its prefix (/items, /sets) must declare the prefix as a link-only route outside its routes module](https://github.com/todd-skelton/corten/issues/152), and [todd-skelton/corten#162 Upgrade and Relay: a WebSocket, a tunnel and an upstream's answer are checked routes](https://github.com/todd-skelton/corten/pull/162), closing [todd-skelton/corten#117 A route cannot be a WebSocket or pass an upstream response through, so such routes are added outside Corten's checks](https://github.com/todd-skelton/corten/issues/117). Breaking only for an area whose prefix has no page, which the pilot declared outside its module. The workaround is removed: the seven prefixes (`/categories`, `/accounts`, `/listings`, `/sets`, `/items`, `/account/inventory` and public's `/market`) are `#[route("/items")] pub struct ItemsArea;` inside their routes modules, naming no handler, so each is only a `corten::Prefix` and a link to it does not compile. The pilot had no workaround for #117 (its live parts are its own `corten-live` feeds, with no WebSocket or relayed route) or #157; with #168 a debug build answers 500 for a page whose handlers call an unlisted module, and every router test passes at this pin. `corten check` passed at admin 62, marketplace 218, platform 10, public 19 |
| `af0019f` | Corten `main` with [todd-skelton/corten#163 An API cannot shape the failures Corten answers itself (404, 405, cross-site 403, Caller 401), so a gateway that must answer in Anthropic's error shape checks keys outside Caller](https://github.com/todd-skelton/corten/issues/163) and [todd-skelton/corten#164 A Relay loses the upstream's Content-Security-Policy, so a relayed page's own scripts are blocked](https://github.com/todd-skelton/corten/issues/164) closed. Neither is the pilot's (it has no API of its own and no `Relay`), and neither breaks it: moved to stay current before the inventory item page. `corten check` passed at admin 62, marketplace 229, platform 10, public 19 |
| `3375815` | Corten `main` with [todd-skelton/corten#180 App::client_zone and Option<ClientZone>: a handler knows the visitor's time zone](https://github.com/todd-skelton/corten/pull/180) (closing [todd-skelton/corten#149 A handler cannot know the visitor's time zone, so a picked date needs a script to become an instant and every date is written in UTC](https://github.com/todd-skelton/corten/issues/149)), [todd-skelton/corten#178 corten::shutdown: the app begins the graceful shutdown a signal begins](https://github.com/todd-skelton/corten/pull/178) (closing [todd-skelton/corten#174 An app cannot begin its own graceful shutdown (a route, a task, a supervisor's request), and on Windows only Ctrl-C starts one](https://github.com/todd-skelton/corten/issues/174)) and the watchlist example. Not breaking for the pilot. Marketplace sets `.client_zone()`; the seller's listings read a picked day where the seller is on the server, and `seller_listings_page.js` only counts the checked listings now. `corten check` passed at admin 62, marketplace 244, platform 10, public 19 |
| `1b00742` | Corten `main` with [todd-skelton/corten#185 A var() no stylesheet on its pages declares fails at startup and names the file](https://github.com/todd-skelton/corten/pull/185) (closing [todd-skelton/corten#179 A stylesheet can use a token the theme does not define (var(--color-primary-contrast)), and nothing reports it until a browser draws the wrong color](https://github.com/todd-skelton/corten/issues/179)), [todd-skelton/corten#182 Refused::message and Refused::too_many](https://github.com/todd-skelton/corten/pull/182) and a smoke fix. Not breaking for the pilot. `scripts/check-tokens.mjs` and its CI step are removed: the app refuses to start on such a `var()`, and a planted `--color-primary-contrast` in `desk_page.css` failed the Desk's tests naming the file. `corten check` passed at admin 62, marketplace 244, platform 10, public 19 |
| `aaef56f` | [todd-skelton/corten#193 A submit button's formmethod decides how a navigating form goes, in Chromium too](https://github.com/todd-skelton/corten/pull/193) closed [todd-skelton/corten#190 In Chromium, a POST submit button in a GET form is sent as a GET with no fields: the runtime reads the method from NavigateEvent.formData](https://github.com/todd-skelton/corten/issues/190): the repricing editor is a GET form again, its Preview and Activate `formmethod="post"`, so Apply swaps in place in Chromium instead of loading the page. Also the JSON reader's faster skip of undeclared scalars, script formats as their own module, `Error::not_found` and the listings-feed example. Not breaking for the pilot |
| `dfaaa90` | Corten `main` with [todd-skelton/corten#203 An app cannot ask whether it routes a path, so a sign-in's return address is checked against a hand-kept list of prefixes](https://github.com/todd-skelton/corten/issues/203), [todd-skelton/corten#204 SetCookie::new panics on a value it cannot carry, so a token from another service can turn a sign-in into a 500](https://github.com/todd-skelton/corten/issues/204) and [todd-skelton/corten#239 A page whose path is the prefix of other areas (/account above /account/cart) cannot have a stylesheet only it links](https://github.com/todd-skelton/corten/issues/239) closed. `Local::parse` and `Req::serves` replace the pilot's `AREAS` and `app::serves`: a sign-in's return address is the pilot's page only where it routes one with a `GET`, so `/account/inventory/imports` (under the inventory area, not routed) now goes to marketplace instead of the pilot's not-found page. `SetCookie::try_new` replaces `cookie_value`, and `HtmlResponse::with_cookie` the sign-in's header appends. #239 was closed by the styles guide naming the pilot's own answer (`App::components`), so `views::ACCOUNT_HOME` stays there. Also brings `Req::patch_or`, `live_watch`, `tokens!` functions per value and `Id` props (not adopted yet). Not breaking for the pilot: it compiled unchanged |
| `9bdbb5a` | Corten `main` with [todd-skelton/corten#247 #[derive(FromRef)]: a handler takes one part of the app's state without a hand-written impl](https://github.com/todd-skelton/corten/pull/247) and [todd-skelton/corten#248 Nav links from one mention of the route: req.nav and req.nav_section](https://github.com/todd-skelton/corten/pull/248). Breaking only for code the pilot does not have: `Req::current` is removed for `req.nav`, and `data-nav` written by hand no longer compiles (the pilot uses neither, and has no hand-written `FromRef`). Neither adopted: the marketplace top bar's entries come from `nav.json` and link to marketplace as often as to the pilot, and the admin nav reads `req.is_current`. No change to the pilot's code: `corten check` passed at admin 72, marketplace 307, platform 10, public 19, and the team smoke passed on its release build |
| `9f854ec` | Corten `main` with [todd-skelton/corten#249 corten-ui text props take the text: label="Actions", Toast { message: Some(text) }](https://github.com/todd-skelton/corten/pull/249), [todd-skelton/corten#250 watchlist: a module a screen, with each screen's tests next to it](https://github.com/todd-skelton/corten/pull/250) and [todd-skelton/corten#251 Message arguments are corten::i18n::Arg: integers written from their digits, floats refused](https://github.com/todd-skelton/corten/pull/251). Breaking for the pilot in one place: the postage policies list passed a declared value (`f64`) to `list.signature_value_threshold` and `list.insurance_value_threshold`, which no longer compiles. It now passes the number's text (`value.to_string()`), which is what admin-web writes (JavaScript's `String(500)`, no grouping), rather than `t.number`, which would group it. The pilot passes no `&dyn Render` text props to corten-ui. `corten check` passed at admin 72, marketplace 311, platform 10, public 19 |
| `1f7d68b` | Corten `main` with [todd-skelton/corten#255 t.parse_money: money typed in the reader's locale, read back into minor units](https://github.com/todd-skelton/corten/pull/255), closing [todd-skelton/corten#208 Money typed into a form is parsed by each app, three different ways, and card-market reads it as f64](https://github.com/todd-skelton/corten/issues/208), and [todd-skelton/corten#256 A Public answer that sets a cookie does not compile: HtmlResponse<For>, with_cookie only for one visitor](https://github.com/todd-skelton/corten/pull/256), closing [todd-skelton/corten#235 A Public answer that sets a cookie compiles, and is only made private when it is sent](https://github.com/todd-skelton/corten/issues/235). Both adopted: an offer's and a listing's price, Record sale's price and Create listing's price are read with `t.parse_money` in USD, so `$1,299.50` is money in en where the pilot refused it (`buying::price`, `inventory_list`, `listing_new::typed_money`). Breaking: a helper that draws a `Public` page returns `corten::Result<HtmlResponse<For>>` (public-web's home `render`, generic since `join` answers the same page to one visitor) or `HtmlResponse<ForAll>` (the market page's `render`), so a public page that sets a cookie no longer compiles. Also brings smoke diagnostics ([todd-skelton/corten#253 Smoke: the two intermittent first-load checks say why when they fail](https://github.com/todd-skelton/corten/pull/253)), which the pilot does not use |

**Ported ahead of Corten: `feat/route-handlers`, pinned at `319d3b7`.** Corten's breaking change
([todd-skelton/corten#81 A route's handler says what it answers, who may call it and how it caches, checked for every route](https://github.com/todd-skelton/corten/pull/81), first as its local
commit `e07c1a3`) replaces `App::context`, `App::guard` and `Area::guard` with a handler's `Caller<T>`
and an area's `caller = T`. It also makes a handler's return type its route's answer (`HtmlResult`, `LiveResponse`),
has every route name its handler in `#[route(..)]`, and turns `Failure` into an enum. The pilot is ported
to it on the local branch `pilot/corten-route-handlers`, which built against `e07c1a3` merged
with `c7fc490` through a local `[patch]` until the change merged into Corten `main` as `319d3b7`;
the branch is now pinned there and merged into `pilot/corten`. At `e07c1a3` `corten check` passes (admin 61, marketplace 93, platform 6). Eight
smokes pass against its release builds on the sandbox: Operations Attention, scopes, bulk,
postage, storage locations, cart, item and Add to List. What changed:
1. Every area is a `#[corten::routes(state = Shared, area = .., caller = ..)]` module whose routes
   name their handlers. The catalog area is five such modules, one per screen. A prefix with no page
   is a `link` route (`/items`, `/account/inventory`). Where a page shared the prefix's path (postage, Operations
   Attention, the cart), that page is the area's route.
2. The callers are `Identify` impls (`auth.rs`), so a request reads the session once, only where a handler asks for it.
3. The layout takes `viewer` as a prop. 18 page helpers in admin and 30 in marketplace take the viewer, or
   the item page's `Option<&Session>`, from their handler. Ten of them now take eight arguments and
   say so to clippy (`#[expect(clippy::too_many_arguments)]`).
4. Both error pages name every `Failure` case. Two gaps were filed:
   [todd-skelton/corten#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88)
   and [todd-skelton/corten#89 Refused::unavailable reaches the error page as Failure::Failed (503), the same as a handler's own 503](https://github.com/todd-skelton/corten/issues/89).
5. Marketplace search, the home page, a set's page and a listing's page were ported on this
   branch after that, so they are not on `pilot/corten` yet. With them `corten check` passes
   (admin 61, marketplace 107, platform 6), and `smoke-market-search.mjs`, `smoke-market-set.mjs`
   and `smoke-market-listing.mjs` pass against its release build on the sandbox. The home page is
   a routes module with no area (`url::home`, the router `App::new` takes): an area's prefix
   starts each of its paths, and `/` starts every path. Search's four Corten gaps are under
   [Corten gaps](#corten-gaps).

## What lives where

| Path | What |
|---|---|
| `platform/src/api.rs` | the platform API as the signed-in user (`Caller`): reads, writes with their receipt, who is asking (`identify`) |
| `platform/src/receipt.rs` | read after write: the write's receipt rides the redirect and the next read waits for it |
| `platform/src/realtime.rs` | the platform's realtime stream as the signed-in user: a tick per change to a topic, resuming from the last cursor |
| `platform/src/jobs.rs` | a durable job's status stream as the signed-in user: the job's record after each change until it is done, resuming from the last event |
| `platform/src/session.rs`, `nav.rs` | the session cookie, the color mode, and the React apps' nav rules |
| `platform/src/theme.rs`, `section.rs` | the design system's tokens, and the page header, sections and banner both screens use |
| `platform/src/chart.rs` | a time series drawn on the server as SVG (`TimeSeriesChart`): the item page's Sales tab and the market page |
| `*/src/app.rs` | routes, access (sign-in at the React app, 403, 502), and the handlers |
| `*/src/api.rs` | the screen's calls; typed bodies with only the fields the screen reads |
| `*/src/form.rs` | what the forms post; the pilot checks only shape (text present, numbers parse), the API checks the rules |
| `public/src/market.rs`, `views/market_page.*` | public-web's market page, `robots.txt` and the sitemap, each `Public` |
| `public/src/home.rs`, `views/home_page.*`, `views/home.js`, `home_layout.css` | public-web's home page: the landing's address, the reads and their fallbacks, the fee preview, Join, and the page's parts, its layout and its script (the analytics bridge, the role's sync, the sticky bars, the promo bar) |
| `public/src/presence.rs`, `kept.rs` | Public Presence's API as the home page calls it (policy values, promos, the counter, Join), and a read kept for the next visitor |
| `platform/src/client.rs` | the visitor's address behind a trusted proxy |
| `marketplace/src/recovery.rs` | the write's attempt id, the address's `Check`, and confirming a write the browser did not hear back about |
| `marketplace/src/locations.rs`, `views/location_card.*` | the storage locations: the list and its three writes |
| `marketplace/src/restock.rs`, `views/decision_card.*` | the restock decisions: the list and its two writes |
| `marketplace/src/inventory_list.rs`, `views/inventory_page.*` | the inventory list: its address (`Place`), the reads, Create Inventory Item (`CreateItem`, the picker shared with Create listing) and Record sale (`SaleInput`, `SaleDraft`), and the page's parts |
| `marketplace/src/inventory_item.rs`, `views/inventory_item_page.*` | the inventory item page: its address (`ItemPlace`, the ledger filter and a sale's outcome), the read, Adjust Quantity (`AdjustInput`), Create Hold (`HoldInput`), Release hold and Record sale, the forms drawn again (`Drafts`), and the page's parts |
| `marketplace/src/desk.rs`, `views/desk_page.*` | the Seller Desk: the three reads in parallel (the queue, the listings' status counts at `limit=1`, open orders), what a failed read draws, the summary's words by key (`summary`), the row's link (`link`, the workaround for #10676) and the page's parts |
| `marketplace/src/support.rs`, `views/support_page.*` | a Support Request's participant page: its address (`Place`), the copied Platform Operations rules (`next_actor`, `deadline`, `offer_outcome`, the gates in `screen`, the workaround for #10715), the canonical request and its hash, the writes and Check status (`write`) and the page's parts |
| `marketplace/src/money.rs`, `views/money_page.*` | the Seller Desk's money page: its address (`Place`, an adjustment's breakdown), the six reads at once, the copied Settlement rules (`next_payout`, `blocked`, `can_request`, `unavailable`, the workaround for #10712), the five writes (`write`) and the page's parts |
| `marketplace/src/repricing.rs`, `views/repricing_page.*` | the repricing desk: the presets and their knobs (`Preset`), the editor's address (`Place`) and its compiled body (`Editor::compile`, the workaround for #10682), the reads, the six writes (`write`), the dry run's live relay (`live`) and the page's parts |
| `marketplace/src/cart.rs`, `views/cart_item.*` | the cart: its read, the lines merged and priced, its writes and checkout, and the page's parts, whose stylesheet is `sections/account/cart.css` |
| `marketplace/src/items.rs`, `views/item_detail.*` | an item's page: the read, the address (its choices, read and written), marketplace's selection rules, and the page's parts |
| `marketplace/src/cart_attempt.rs` | a cart write (`api::CartWrite`: the cart's commands or an item page's new line, for an account or a guest) as the Checkout API's command attempt: the attempt id, the request hash, one lookup for a lost answer, and what the attempt came to |
| `marketplace/src/saving.rs` | the item page's Add to List: the recent lists read with the page, the ids drawn with the form, an account's addition or a guest's intent, the quantity's and title's checks, and what the page says after each |
| `marketplace/src/watching.rs` | the item page's Watch writes: an account's alert or a guest's intent for the product the page showed, the threshold's checks, and what the page says after each |
| `marketplace/src/selling.rs` | the item page's sell writes: the sell-list line built from the item read again (an offer or a product), the guest sell list, the payout terms, and what the page says after each |
| `marketplace/src/listing.rs` | the item page's List this product writes: the ship-from setup, the stock, the listing and its publication as one attempt, a guest's draft, and what the page says after each |
| `marketplace/src/buying.rs` | the item page's buy writes: the cart line built from the item read again, the guest cart, Buy best match, Buy this listing, and what the page says after each |
| `marketplace/src/checkout.rs`, `views/checkout_page.*` | the buy checkout: its address (`Place`), the form as marketplace names it (`CheckoutForm`), the reads (the session, the wallet, the saved addresses and methods, Payments' quote), the page's model (`Screen`: the steps, the notice, what Pay now may do), Update totals and Pay now, the recovery pages, and the page's parts and script (the stale mark); Checkout's calls are `api::CheckoutSessions` |
| `marketplace/src/sign_in.rs`, `views/sign_in_page.*` | signing in: the address (`Ask`), the methods an email or phone offers (`Kind`, `Method`), the forms as marketplace names them, the Auth API's calls with the browser's address, refusals in marketplace's words, the session and selection cookies, the return address (`safe_return_to` through `corten::Local`, and `destination` through `Req::serves`), the magic link's landing, account selection and signing out |
| `marketplace/src/orders.rs`, `views/order_page.*` | the account's orders: Purchases and Sales a page at a time (`Paging`), an order's page, Cancel and what the page says after it, for a buyer or a seller (`Side`); the stylesheet is `sections/account/purchases+account/sales.css` |
| `marketplace/src/shipments.rs`, `views/shipment_page.*` | the account's shipments: the buyer's list, a shipment's page for its buyer or seller (`Side`, read after a write's receipt), and the 303 from the seller's list to marketplace's command center; the stylesheet is `sections/account/shipments+account/sales/shipments.css` |
| `marketplace/src/sessions.rs`, `views/sessions_page.*` | the user's sessions: the list's address (`Filters`, its status and page sent to Auth), a session's address (`Place`, the receipt and what came of the write), Revoke and Switch Account with the re-read after a write Auth did not confirm, and the pages' parts (the filter, the cards, the pages, the session's actions and details); Auth's calls are `api::SessionCalls` |
| `marketplace/src/team.rs`, `views/team_page.*` | the account's team: the page's address (`Place`: the receipt, what came of the write, the attempt to ask about), the form (`TeamInput`, its intent naming one of five writes), the reads with the catch-up after a write, the writes with the lost-answer lookup and the acceptance link after a new invitation, and the page's parts (Invite, a member's row and its Revoke dialog, an invitation's row and its Cancel dialog); Identity's and Auth's calls are `api::TeamCalls` |
| `marketplace/src/consents.rs`, `views/consents_page.*` | the user's consent history: the page's address (`Place`: the receipt, what came of the withdrawal, the attempt and consent to ask about), Withdraw's form (`ConsentInput`), the read with the catch-up after a withdrawal, Withdraw with the lost-answer lookup, and the page's parts (a consent's card and its Withdraw dialog); Identity's calls are `api::ConsentCalls` |
| `marketplace/src/reviews.rs`, `marketplace/src/review.rs`, `views/reviews_page.*` | the account's reviews: which page (`Which`), the address (`Place`: the lists' role and the review a report was received for), the forms' fields (`ReportInput`, with the review page's `intent` and reply), the reads (the summary's two side by side, a list by role), Report review with its checks and the API's refusals (`send_report`), and the page's parts (the ratings, the role filter, a review's card or its stand-in words, the scoring context, Report review's dialog); a review's own page (`review.rs`: its address `ReviewPlace` with the reply's receipt, the read and its preparing state, the two writes by intent, the reply's checks and the closed authoring codes) with its parts (the card, Respond to this review, the preparing words); Reputation's calls are `api::ReviewCalls` |
| `marketplace/src/security.rs`, `views/security_page.*`, `views/security.js` | the user's security page: its address (`Place`), the reads (the user, its own keys), the four writes as Identity attempts posted to the page itself, a create's or rotate's secret answered once with `NoStore`, and the page's parts (the forms, the secret with Copy, the metrics, the signals, each key with Rotate and Revoke); Identity's calls are `api::SecurityCalls`, a secret `api::KeySecret` |
| `marketplace/src/account_home.rs`, `views/account_home_page.*` | the account's own page: its address (`Place`), the reads (the account, who is signed in) and marketplace's fallback while the account catches up with a write, Update Profile as an Identity attempt, and the page's parts (the form, who is signed in, the readiness signals, the trust details); Identity's calls are `api::AccountCalls`, the attempt's answer `api::AccountAnswer` |
| `marketplace/src/addresses.rs`, `views/address_page.*` | the account's shipping addresses: the page and its address (`Place`), add, update, default and archive as Identity attempts, and what the page says of each (`Said`); Identity's calls are `api::Addresses` |
| `marketplace/src/packing.rs`, `views/packing_page.*`, `views/packing.js` | packing a shipment: the page and its address (`Place`), start, a line's count, a scan and Finish, each with its attempt as the `Idempotency-Key`, what the API says came of an attempt, and the page's parts and script; the stylesheet is `sections/account/sales/shipments.css` |
| `platform/src/money.rs` | what an amount the APIs send is (decimal text, at most two fraction digits, read as cents); Corten writes it (`t.money`) |
| `*/src/views/` | the components, each with its stylesheet, and their scripts |
| `admin/src/catalog/` | the catalog area: its routes and handlers (`mod.rs`), the Catalog API calls (`api.rs`), the forms and the bodies admin-web sends (`form.rs`), and its views, whose stylesheets are `sections/catalog.css` |
| `admin/src/catalog/views/bulk_rows.*`, `bulk_dialogs.rs` | bulk changes: the bar and the rows' boxes (the selection's script), and the preview and job dialogs |
| `admin/src/catalog/items.rs`, `views/item_list.rs`, `views/item_form.css` | the catalog items list: its routes, the changes count, the three bulk changes and removing drafts |
| `admin/src/catalog/item.rs`, `views/item_page.rs`, `views/item_page.css` | a catalog item's page: its reads, one route per write, and its sections and dialogs |
| `admin/src/catalog/scopes.rs`, `views/scope_list.rs`, `views/scope_row_view.css` | the scopes list: its route and query, the promotion and sync of each row, and its table |
| `admin/src/catalog/scope.rs`, `views/scope_page.*` | a scope's page: its reads, the journey and editions it derives (chase-sets/chase-sets#10703), its writes, and its sections |
| `admin/src/catalog/attention.rs`, `views/attention_panel.*` | the Catalog attention queue on the scopes list: an item's sheet, the park and restore routes, the alias commands, and the queue's messages by key |
| `admin/src/views/live_status.*` | a stream's status, for the catalog items list and the attention queue: Live, Connecting… or stale with Reload (CSS on `<corten-live>`'s `status`), each in its screen's words; in `components.css`, since two areas render it |
| `admin/src/operations/` | the Operations Attention area: its routes and the Open links (`mod.rs`), the queue's read (`api.rs`), and its page, whose stylesheet is `sections/platform/operations-attention.css` |
| `admin/src/projections/` | the Projection Operations area: its routes, filters, the live relay of running operations and the five repairs (`mod.rs`), the console's reads and writes (`api.rs`), and its views: the console (`console_page.*`) and the record's sheet with its confirm dialogs (`detail_sheet.*`), whose stylesheet is `sections/platform/projections.css` |
| `*/src/tests.rs` | router tests against a stand-in platform API |

## Workarounds and decisions in the pilot

1. **Read after write.** After a write, the pilot sends the write's receipt
   (`Chase-Sets-Read-After-Write`) and, while the API's projection catches up, answers as the
   React app does: admin 503 "preparing, refresh in a moment"
   ([`read_failed`](admin/src/app.rs)), marketplace the page with "still updating" and no list,
   or 409 "could not be verified" when the read fails for good
   ([`read_failed`](marketplace/src/app.rs)). This is Chase Sets' consistency protocol, not Corten's.
2. **Business rules stay in the API.** A refusal with a message becomes the form's message
   (`Errors::add_form`), so the pilot never restates a rule.
3. **Who may use each area is its caller type.** Each area's routes module says
   `caller = ..`, so every handler there takes that `Caller` (Corten's `feat/route-handlers`; before
   it, `App::guard` and `Area::guard`). admin's areas take `Staff<R>`, where the rule `R` names the
   permission for the request's method: postage `postage-policies.view`, Operations Attention
   `projection-operations.view`, and the catalog `catalog.view` to read and `catalog.manage` to
   write (`CatalogAccess`), as the platform API asks for them. marketplace's inventory takes a
   `Seller` (`inventory.view` to read, `inventory.manage` to write) and the cart a `Buyer` (an
   account that is not a guest checkout). The item page is public: its handlers take
   `Option<Caller<Session>>`. Anyone else with a session gets a 403. A session the API could not
   look up gets a 503 (`Refused::unavailable`; it was a 502 before the port), because signing in
   again would loop while the API is down. No session signs in at the React app. A write whose API
   call says the session ended meanwhile still signs in from the handler. The layout shows the
   viewer the handler passes it, and the error page the one it reads itself (from the `0f3f03f` pin;
   it had none before,
   [todd-skelton/corten#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88)).
4. **Every write is its own route** (`/revise`, `/archive`, ...) where the React apps post one
   form with an `intent`; admin's preview button posts the revise form to `/preview` with
   `formaction`.
5. **admin's sheet is a `<dialog open>`** that works without JavaScript; its script reopens it as
   a modal and lets Escape follow the close link. Confirmations use `command="show-modal"`.
6. **Sign-in returns to the React app's copy of the screen**: both only return to their own paths.
   admin returns to the page's section and screen (`/catalog/dimensions` for any page under it).
7. **A write's attempt id is the pilot's own** ([`recovery`](marketplace/src/recovery.rs)). The
   Inventory API applies an `Inventory-Mutation-Attempt` once and keeps its result. Each write
   form carries an attempt the pilot drew it with; its script remembers it in sessionStorage
   before the post, with marketplace's key and record, and the next page asks the API about any
   record it does not settle. While the answer is uncertain the page's writes are off until the
   seller checks again or discards the record. Without JavaScript the server still confirms the
   attempt after the redirect. The attempt is Corten's `SubmitKey` (`SubmitKey::field`): the
   runtime keeps it while a post has no answer and draws a new one after it.
8. **`target` cannot name a handler argument**: in a handler call it is the event's target, so
   `WriteForm` passes its record id as `record` ([`WriteForm`](marketplace/src/views/recovery.rs)).
   Corten documents this; not a gap.
9. **marketplace's top bar only**: the nav groups and the active entry are ported; the bottom bar,
   account menu and cart count are not. An entry the pilot serves links to the pilot (`OWN` in
   [`market_nav.rs`](marketplace/src/views/market_nav.rs), by the exact path marketplace's nav
   names); until the sessions port only the inventory entries and the Seller Desk did, so Search,
   Purchases, Sales, Notifications, Sessions, Listings, Offer matches and Cart left the pilot.
10. **admin's two screens are areas** (`App::area`), each with its own stylesheet and guard; the
    frame (`AdminNav`, the tokens, `Section`) stays in `components.css`. `AdminNav` shows the
    side nav of the section the page is in, and links the pages the pilot serves to itself.
11. **Catalog dialogs work without JavaScript.** Each is a `<dialog>` its button opens with
    `command="show-modal"`; a form that comes back (refused without JavaScript, or a label row
    added or removed) is drawn `open`. Add Label and Remove are submit buttons that post the form
    back to be drawn with a row more or less, and nothing is written
    ([`OptionInput::relabeled`](admin/src/catalog/form.rs)); a hidden first submit button keeps
    Enter from removing the first row. A dialog drawn `open` becomes modal when it joins the page
    (`corten_ui::dialog::modal`), with focus on the first field marked invalid.
12. **Success toasts are the redirect's `done`** (`?done=option_added`): the page the write sends
    the browser to puts admin-web's message in corten-ui's `Toaster`, with and without JavaScript.
13. **New records keep the id they were drawn with.** The create forms carry a `dim_`, `fld_` or
    `chc_` ULID made when the form is drawn (`createId`), so the same form posted twice names the
    same record and the Catalog API refuses the second.
14. **Bulk lifecycle changes** are admin-web's `BulkLifecycleActionBar` on both lists: check rows
    (or take every record the filters match), pick an action, preview it, confirm it, and follow
    the job. The rows' boxes belong to the bar's form (`form="catalog-bulk"`), so without
    JavaScript the form posts the checked ids, Clear Selection is the form's reset and the
    select-all box is hidden. With it, a 70-line script ([`bulk_rows.js`](admin/src/catalog/views/bulk_rows.js))
    keeps the count, the select-all box (mixed when some rows are checked) and the buttons in step,
    with no request; that is the work the browser does fastest. The bar is drawn with the rows,
    so a live change redraws its "matching" count, and a box the user checked keeps its mark
    through it (the runtime keeps edited fields). The API decides which records are ready: the
    preview is the API's `bulk-lifecycle/preview`, answered as a dialog (a patch, or the list with
    it open), and its confirm form carries the preview's ids (or the filter, which the API
    resolves again, as admin-web's does). The confirm starts the API's job and redirects to the
    list with `?job=`; the job's dialog follows the job's own status stream
    (`/api/catalog/bulk-authoring-jobs/{id}/events`, resumed from its last event id after a drop,
    [`jobs`](platform/src/jobs.rs)), drawn by the server on each change until it is done. The
    selection resets with the redirect, as admin-web clears it. Staff with `catalog.view` only
    get the rows without the bar or the boxes (the bar's posts need `catalog.manage`, as the
    API's do); admin-web shows them a bar whose preview the API refuses. Not ported: shift-click
    ranges (admin-web has none either). The job dialog's title is the result's ("Bulk Deprecate
    Result") from the start; admin-web shows the preview's title until the job is done.
15. **The lists are live**, as admin-web's are (`useCatalogRealtimeRevalidation` on the
    dimensions and fields lists; their detail pages are not live in admin-web either). The rows
    and pager are a `<corten-live>` whose route (`/catalog/dimensions/live`, with the list's
    filters and page) follows the Catalog topic `catalog:admin:dimensions` on the platform's
    realtime stream, as the signed-in user, and on each change reads the list again and sends the
    rows it draws ([`live_rows`](admin/src/catalog/mod.rs)). Changes within 150 ms are one read,
    as admin-web debounces. The browser runs no script of the pilot's for it; what was typed in the
    filters stays. The platform's stream protocol is Chase Sets', so its client is the pilot's
    ([`realtime`](platform/src/realtime.rs)). Each drawing carries that stream's cursor, so a
    reconnect resumes from it and draws only what changed meanwhile.
    `scripts/smoke-live.mjs` checks it in a browser.
16. **The catalog items list counts changes instead of drawing them**, as admin-web's does
    (`useCatalogRealtimeRevalidation` in manual mode: an import can change many items while a
    user is checking rows). Its `<corten-live>` (`/catalog/catalog-items/live`) draws
    admin-web's bar, "N Catalog Items changed" with Reload, counting the distinct record ids in
    the platform's patches (`Tick::Changed` carries them, [`realtime`](platform/src/realtime.rs)).
    Each count's event id is `{count}.{sync}.{cursor}`, so a reconnect goes on counting
    from the browser's `Last-Event-ID`. A record changed both before and after a reconnect counts
    twice, because the ids are not kept across connections. Reload is a `GET` form: with
    JavaScript it is a patch with the rows and a new `<corten-live>` (the count starts over, and
    checked boxes keep their marks); without it, the page. The connection indicator admin-web
    shows next to it is not ported (see Corten gaps).
17. **The items' bulk bar is one form for the API's three bulk changes.** Publish, archive and the
    six edits are one action select, as in admin-web. The preview posts to the operation's own
    API route (`bulk-publish`, `bulk-lifecycle`, `bulk-edit`) and answers with that route's
    dialog. A publish's confirm carries the preview's `item_ids`, which is what the API's confirm
    takes. The value an edit takes (a blueprint, a category, the tags) is an input shown only for
    the operations that take it, with CSS `:has` and no script; a browser without `:has` shows all
    three. A publish's result offers "Retry items needing attention", a form that previews the
    retryable items again. `BulkRows` gained two slots for this (`fields`, `more`), and its
    script disables a submit marked `data-requires="draft"` unless every checked box is a draft.
18. **Remove drafts restates a Catalog rule in the web layer**, as admin-web's page does. The API
    has no bulk route for it, so the pilot reads the page's rows, refuses a selection that is not
    all drafts, and sends one `DELETE` per item. The first refusal stops it, and the drafts
    before it stay removed. Filed as
    [chase-sets/chase-sets#10530 Give removing draft Catalog Items a bulk preview and job like the other item bulk actions](https://github.com/chase-sets/chase-sets/issues/10530);
    the workaround is `draft_refusal` in [`items`](admin/src/catalog/items.rs).
19. **Marketplace and admin pages stay responsive.** Every ported page is checked at a phone's
    width (390 px): the page must not scroll sideways (`scripts/smoke-items.mjs` and
    `smoke-item.mjs` check it); wide tables scroll inside their own box, and a title that is
    one long id (a new draft's) wraps.
20. **An item's page is one read and a route per write.** The page reads the item, the lines it
    contains and the products that contain it at once, and the names of content types, policies
    and items only when it has lines (admin-web reads the same lists). Each of admin-web's
    dialogs is a `<dialog>` with its own form and route; Set Field Value is drawn by the server
    when it opens (`GET /fields`, a patch with JavaScript, the page with it open without),
    because its choices need the blueprint's fields. A reference field's record select is shown
    only when a reference field is picked, with CSS `:has` and no script. Folds are
    `<details>`, and the one a write changed comes back open. Publish's Recheck is the same
    form sent with `formmethod="get"`: it reads the display identity's readiness again and
    writes nothing.
21. **Publish sends the preconditions the API asks for**, as admin-web does: the single-item
    publish takes `blueprintIsActive` and `requiredFieldIds` from the caller, where the bulk
    publish decides both itself. The pilot sends `blueprintIsActive: true` and no field ids,
    so the API's own checks decide. Filed as
    [chase-sets/chase-sets#10535 Decide a Catalog Item's publish preconditions in the API instead of taking them from the caller](https://github.com/chase-sets/chase-sets/issues/10535)
    (`PublishInput` in [`form`](admin/src/catalog/form.rs)).
22. **Image URLs are one per line.** admin-web's dialog has one line for all of them; the pilot's
    is a textarea. Filed as
    [chase-sets/chase-sets#10537 Let the Catalog Item Set Image URLs dialog take one URL per line](https://github.com/chase-sets/chase-sets/issues/10537).
23. **Product contents are read again when written.** The API replaces the whole list and takes
    no version, so two editors drop each other's lines. The pilot reads the list at write time,
    not from the page, which narrows the window but does not close it. Filed as
    [chase-sets/chase-sets#10538 Stop concurrent Product Contents edits from silently dropping each other's lines](https://github.com/chase-sets/chase-sets/issues/10538).
24. **A field's error is outside its label.** A label that wraps its control names it with all
    of its text, so an error inside it became part of the field's name ("Variants JSON Enter a
    JSON object…"). Every pilot field now puts the message after the label, where
    `aria-describedby` points to it, as Corten's examples do.
25. **A write's page can be drawn from the read before it.** The Catalog API declares no exact
    freshness routes, so a receipted item read waits on every catalog projection, and locally
    one unrelated projection can keep it 503 "preparing" for 30 s and more (after one image URLs
    write: the item's own data was current at 10 s and the receipted read at 27 s; measured
    once). Filed as
    [chase-sets/chase-sets#10549 Wait only on a Catalog Item's own projections when reading it after a write](https://github.com/chase-sets/chase-sets/issues/10549);
    the wait also never wakes a projection, because wake-before-wait is off by default
    ([chase-sets/chase-sets#2512 [Projection Performance] Roll out read-consistency wake-before-wait for critical routes](https://github.com/chase-sets/chase-sets/issues/2512)).
    After 30 s the receipt is dropped, as admin-web drops it, and the page can show the record
    from before the write with no notice. Separately, the admin item projection can rebuild an
    item's page from the row before an event and never apply it, so a saved change may not show
    at all:
    [chase-sets/chase-sets#10554 Keep the admin Catalog Item pages current when the item projection applies an event after them](https://github.com/chase-sets/chase-sets/issues/10554).
    `smoke-item.mjs` reloads for up to 90 s before it checks a write's result, and reports a step
    as blocked (not passed) when the API's own item lacks the change too.
26. **The scopes list repeats two web-layer rules of admin-web's**, so the two pages compare row for
    row (`scripts/smoke-scopes.mjs`). A row's promotion comes from its lifecycle status and its
    sync is stale 14 days after `updatedAt` (or when the time cannot be read), as
    `scope-landing-read-model.ts` derives them; noted on
    [chase-sets/chase-sets#10507 [catalog] Compose the Catalog integrations surfaces in the Catalog API](https://github.com/chase-sets/chase-sets/issues/10507).
    The language filter applies only to the page shown, because the API has no language filter:
    [chase-sets/chase-sets#10565 Filter Scope Records by language edition across every page, not only the page shown](https://github.com/chase-sets/chase-sets/issues/10565).
    Both are marked in `scopes.rs` for removal. An API error other than sign-in or permission is
    the list's banner over no rows, as admin-web's loader shows it.
27. **The attention queue's text is the API's message keys.** The queue sends each item's title,
    detail and action label as a catalog key and its arguments, which `attention::shown` draws
    with `t.by_key` (the API's key mapped to the pilot's `attention.*` key; a key the catalog
    lacks is shown as the key). Its arguments are the API's params, by the catalog's own
    camelCase names, through `attention::Params`, which fills an alias candidate's detail `{type}` from the title's params, where the API sends it
    ([chase-sets/chase-sets#10569 Show the alias type in a Catalog attention queue alias candidate's detail instead of {type}](https://github.com/chase-sets/chase-sets/issues/10569); admin-web shows the text `{type}`). The queue's 214 items in the
    sandbox are all drawn, as admin-web draws them (the API does not page them); a row's Review is
    a submit button of one shared form, so a row carries only its key, and the sheet is drawn by
    the server when opened. The pilot trusts the API's counts; admin-web recomputes them and drops
    a queue that disagrees, which
    [chase-sets/chase-sets#10507 [catalog] Compose the Catalog integrations surfaces in the Catalog API](https://github.com/chase-sets/chase-sets/issues/10507)
    removes. A park reads after its write, so the parked item is gone from the page the write
    sends the browser to (admin-web's page may still show it until the projection catches up).
    Locally the dismissal took about 13 s to project (measured once), so the page answers
    "preparing" until it does. Each source of the queue is capped at 200 rows and its counts are
    of the capped list (the sandbox has 5,027 proposed mappings; the panel shows 200), which
    [chase-sets/chase-sets#10568 Count every item in the Catalog attention queue, not only the first 200 per source](https://github.com/chase-sets/chase-sets/issues/10568)
    fixes; the pilot shows what the API sends.

28. **The restock decisions page is the storage locations' recovery, a second time.** Both
    marketplace screens share `recovery`: the address's `Check` (a `#[route(query)]` set both
    lists take), the status, `WriteForm` and `failed`, so a page confirms a record of any of the
    pilot's four families, as marketplace's `InventoryMutationProvider` does on every Inventory
    page. Restock and Write off are the `restock-record` family on the decision, sent with the
    version the page read; a refused one is drawn again at the decision's version as it is now
    (marketplace reads the list again after a refusal). A read after a write that fails for good is
    drawn by the screen in its own words (the storage locations' "Storage location update could
    not be verified", the resource route's "The update could not be verified"), since the error
    page knows only the status. Times are written in the request's locale and in UTC by Corten
    (`t.date_time(at, Medium, Short)`), which in `en` is Chase Sets' `formatDateTime` (its own
    test cases are the pilot's).
    The seeded decision cannot be recorded in the sandbox
    ([chase-sets/chase-sets#10572 Let the seed seller record the seeded restock decision instead of Restock decision not found](https://github.com/chase-sets/chase-sets/issues/10572)),
    so `scripts/smoke-restock.mjs` checks refusals and recovery only, and the router tests check
    an applied decision.

29. **The cart is the API's read, drawn.** marketplace's two areas are Corten areas, each with
    its guard and stylesheet: `/account/inventory` needs `inventory.view` (writes
    `inventory.manage`), and `/account/cart` any account but a guest checkout's. A visitor with
    no account cart is sent to marketplace's own `/account/cart`, which reads the guest cart; the
    pilot does not port it. The readiness, the estimated subtotal, the blocked count and the
    savings are the Checkout API's ([chase-sets/chase-sets#10504 [checkout] Return Cart readiness, subtotal and savings from the cart read](https://github.com/chase-sets/chase-sets/issues/10504)). Each line's badge is the API's line outcome rather
    than a copy of marketplace's rules. That differs from marketplace in one case: a line in
    another currency is "Needs review" here and "Ready" there
    ([chase-sets/chase-sets#10576 Draw each cart line's readiness from the cart read instead of recomputing it in the cart page](https://github.com/chase-sets/chase-sets/issues/10576)). The line's price is still worked out here as marketplace's page does (exact for a
    locked listing, "from" for Smart Match, "Priced at checkout" without a priced listing), and
    lines for one product and fulfillment are merged as `groupCartLines` merges them. Money is
    written by Corten in the request's locale (`t.money`), which in `en` is `formatMoney` (its
    own test cases are the pilot's). A data client gets each line's price as the API's decimal
    text and currency, not as text for one locale.

30. **Check out starts the session in the pilot.** marketplace's Check out and Use lower price
    post to its `/checkout/buy/readiness` action, which merges a guest cart, reads the readiness
    again with the offer's decision, starts a checkout session and redirects to it. The pilot's
    forms cannot post there: React Router refuses an action whose `Origin` is another origin
    (400, its CSRF check), unless marketplace lists the pilot in `allowedActionOrigins`. So the
    forms post to `POST /account/cart/checkout`, which makes the same three calls to the Checkout
    API (`cart::checkout`) and redirects to the session's checkout with its receipt as
    `afterWrite`, forgetting the guest cart cookie as marketplace does: marketplace's
    `/checkout/buy/session/{id}` until the pilot ported it, its own page at the same address since
    (decision 61). The form carries only
    the offer's decision (`offer`, `line`, `listing`), not the page's snapshot, since checkout
    reads the readiness again anyway. A session started again from the same readiness is the same
    session (the API keys it by the snapshot), so the form needs no attempt id; a refusal is the
    cart again, 422, with the API's reason as "Checkout issue". The smoke test stops at the
    redirect: loading marketplace's session page as a returning buyer starts the payment and
    holds the cart's listings for an hour
    ([chase-sets/chase-sets#10581 Start a cart's payment when the buyer presses Pay, not when the checkout page loads](https://github.com/chase-sets/chase-sets/issues/10581)).
    That page also fails to hydrate while checkout is being prepared
    ([chase-sets/chase-sets#10582 Hydrate the checkout recovery page without the div-inside-p error](https://github.com/chase-sets/chase-sets/issues/10582)).

    A line without an image shows marketplace's card back from
    marketplace's origin, a 2.9 MB PNG ([chase-sets/chase-sets#10577 Shrink the cart's 2.9 MB fallback card-back thumbnail](https://github.com/chase-sets/chase-sets/issues/10577)); the policy allows images from that origin,
    since it is plain http locally.

31. **Cart writes are command attempts, as marketplace sends them.** Each line has a quantity
    stepper (Decrease and Increase, the first off at 1), Remove, and Lock this listing for a line
    with a preferred listing it is not locked to. Each is a form that posts to its own route
    (`/account/cart/quantity`, `/remove`, `/lock`) with a `SubmitKey` as the attempt id and
    every line merged into the card. The pilot sends one `POST /cart/commands` attempt per post,
    with the commands marketplace's action builds: a quantity on the first line and a remove for
    each line merged into it, all or nothing; a remove or a lock for each line
    ([`cart_attempt`](marketplace/src/cart_attempt.rs)). An answer that may have been lost (none,
    408 or 5xx) is looked up once by the attempt id and the request's hash, which is the web
    hosts' `computeCheckoutCommandAttemptRequestHash`, checked against it. Nothing is resent on
    its own. A write that succeeded redirects to the cart with its receipt, and the read waits for
    it. One that applied nothing is the cart again, 422, with the API's reason. One that applied in
    part is 409, listing the lines not updated. One whose outcome is not known is 409: the cart's
    writes are paused, and the buyer can send the same change again (the same attempt, so it
    cannot apply twice) or refresh. A 401 sends the buyer to sign in, back to the cart.

    The checkout read model is often behind the write. In the dev sandbox every quantity write
    the smoke test sent was read before it caught up. That read is marketplace's
    `pending-fresh-write`: the page says the change is saved and reads itself again every 2 s
    until the receipt is 30 s old. The page asks for that with Corten's `<ReadAgain>` among its
    head tags (2 s), only while it is behind: the runtime reads the address again in place, or without
    JavaScript the browser reloads it. The line writes are `data-patch` forms, so a step and the
    reads after it swap the page in place rather than loading it; the smoke test checks both, with
    and without JavaScript. Check out stays a plain form, since it leaves for marketplace.
    A line keeps the picture its add sent, and a card back is site-relative to marketplace
    (`/fake-cdn/assets/pokemon_tcg_back.png`), so the cart puts it and its `srcset` on
    marketplace's origin, as the item page does its own pictures (`views::on_marketplace`).

32. **The item page's choices are in its address.** Marketplace reads `market`, `listing`, `offer`
    and `dimension.<id>` once and keeps later choices in React state. The pilot reads every
    choice from the address, so each option, tab and Select is a link (and a dimension with more
    than five options a GET form, which sends the other options along) and works without
    JavaScript. The rules that turn the address into a selection are marketplace's page model:
    the options normalized against the schema, the listings filtered by them, the best available
    listing the first the API ranks, the option summaries, the product id. The scope decision on
    [chase-sets/chase-sets#10558 [discovery] Return item-detail Listings and Offers in canonical order with each product's lowest Listing and best Offer](https://github.com/chase-sets/chase-sets/issues/10558)
    leaves them in the web layer as presentation, and [`items`](marketplace/src/items.rs) ports
    them as they are. Two additions: `book=` names the market book's tab (marketplace keeps
    it in state), and `dimension.<id>=any` clears the last option, where marketplace would
    otherwise choose the only listing's again. The keys are data, which a typed route cannot write
    ([todd-skelton/corten#71 A typed route cannot carry query parameters whose names are data (dimension.<id>=<option>)](https://github.com/todd-skelton/corten/issues/71), fixed at the `9326a3f` pin), so they are a `#[route(prefix = "dimension.")]`
    field of a derived query that `Params for Address` writes. An id or an old slug is a 301 to
    the slug with the same query (`req.moved`, [todd-skelton/corten#72 A page that moved cannot redirect permanently (Req::redirect is always 303)](https://github.com/todd-skelton/corten/issues/72)).
    An unknown item is a 404, where marketplace answers 200
    ([chase-sets/chase-sets#10585 [discovery] Answer an unknown item page with 404, not 200](https://github.com/chase-sets/chase-sets/issues/10585)).
    Listing at a price is the next part of the port; until then the rail's Continue
    on marketplace opens marketplace's page with the same choices.
33. **The item page's buy forms are plain forms, and the pilot builds the cart line.**
    Marketplace's buy card is three radio cards (the listing, the selected product, an offer),
    each showing its own form, which needs its script. The pilot shows the listing's form
    (Buy this listing, Add listing to Buy Cart) and, folded under it in a `<details>`, the
    product's (Add product to Buy Cart, Buy best match), so both work without JavaScript and the
    rail keeps one primary button; Continue on marketplace is a secondary button now. Each form
    posts the page's address, the product and listing it showed, the quantity and its
    `SubmitKey`. Marketplace's action takes the product's options and words from the form; the
    pilot reads the item again ([`buying`](marketplace/src/buying.rs)) and takes them from the
    address and the listing, as the page drew them, and refuses an add whose product the page no
    longer shows ("This item was not added to your Buy Cart. Nothing was changed."). The checks
    before a write are marketplace's (a whole quantity from 1; the listing active with stock;
    Buy best match only when the product's lowest listing has the quantity).
    An add is one `cart.add-line` command attempt through the same code as the cart's writes
    (`cart_attempt`, now taking an `api::CartWrite`), so a lost answer is looked up once by
    its hash and a write not known to have applied holds the adds (409) with Send the same add
    again, as marketplace does. Marketplace answers Add to cart in place (a fetcher and a banner);
    the pilot redirects to the item with `added=<receipt>`, whose View buy cart opens the cart
    after the write; Buy best match redirects to the cart.
    A guest's add goes to a guest cart, its id in marketplace's own cookie
    (`chase_sets_anonymous_cart`, 30 days, `anon_cmd_<uuid>` when new), and View buy cart is
    marketplace's cart, which reads guest carts (the pilot's cart is for accounts), with the
    `afterWrite` and `postWriteHandoff` marketplace sends. Buy this listing starts a checkout
    session with the form's `SubmitKey` as the entry key (marketplace mints one per input set in
    its server HTML; either way a resend is the same session and a reused key is "Your selection
    changed"). A guest's Buy this listing goes to marketplace's guest checkout with the query
    marketplace builds, as a 303 where marketplace uses 307: a 307 would post the pilot's form
    to marketplace's readiness action, whose fields differ, and its page reads the query
    (`sourceFromUrl`). The Checkout API keeps whatever words and picture a cart add sends,
    which is why the pilot does not take them from the form
    ([chase-sets/chase-sets#10587 [checkout] Take a cart line's title, picture and product summary from the catalog, not the request](https://github.com/chase-sets/chase-sets/issues/10587)).
    Make an offer is a third fold: the offer price (`step="0.01"`, from 0.01), its currency
    (the listings', else USD), the quantity, and the current lowest listing. Marketplace places
    an offer on its offer checkout, not from the item page, so the pilot's form writes nothing:
    it checks the price as marketplace's `normalizeMoneyAmount` does (two decimals, above zero),
    the quantity, and that the posted product is still the page's, then redirects (303) to
    marketplace's `/checkout/buy/readiness?source=offer-intent` with the query marketplace's
    action builds. A refusal is shown in its own fold (422), which stays open.
34. **The item page's sell forms are plain forms, and the pilot builds the sell-list line.**
    The Sell tab's rail shows the selected offer (its total) and, for a guest, the payout
    marketplace shows: the Marketplace API's standard terms for the offer's price (the fee, the
    net and the shipping allowance), read only on the Sell tab with an offer chosen. A seller sees
    "Fees and terms are calculated before acceptance.", as marketplace says for an account.
    Accept offer posts `sell-now` for a viewer with seller features and `add-to-sell-list`
    otherwise, as marketplace's action names them; Add offer to Sell List sits beside it, and Add
    product to Sell List, with its quantity, is folded under them in a `<details>`, so every form
    works without JavaScript. As with the buy forms ([decision 33](#workarounds-and-decisions-in-the-pilot)),
    each form posts the page's address and what it showed, and the pilot
    ([`selling`](marketplace/src/selling.rs)) reads the item again: an offer must be the item's
    own and `submitted`, a product must still be the page's, and the line's title, subtitle and
    summary come from the catalog read, not the form. An account without `offers.manage` taking an
    offer gets 403; a signed-out session that expired goes to sign-in. A guest's line goes to a
    guest sell list, its id in marketplace's own cookie (`chase_sets_anonymous_sell_list`, 30
    days) and sent as `x-checkout-anonymous-sell-list-id`. A write lands on marketplace's
    `/account/sell-list` with the `afterWrite` and `postWriteHandoff` marketplace sends (303);
    the pilot has no sell list of its own yet. A refusal (the API's 4xx message, else 502) is
    shown in the rail (422). The Checkout API keeps whatever words a sell-list add sends
    ([chase-sets/chase-sets#10592 [checkout] Take a sell-list line's title and product summary from the catalog, not the request](https://github.com/chase-sets/chase-sets/issues/10592)),
    and it refuses an offer line with no exact listing, so Add offer to Sell List and Sell now are
    refused today, in the pilot as in marketplace (whose guest add answers 500); see
    [chase-sets/chase-sets#8830 Complete Sell List Offer lines from inventory when the seller has no Listing](https://github.com/chase-sets/chase-sets/issues/8830).
    The pilot shows the API's message and changes nothing.
35. **The item page's Watch tab is the pilot's, with plain forms.** Marketplace's Watch card is
    two radio cards (Watch listings, Watch offers), each showing its form, which needs its
    script. The pilot folds each form in a `<details>` (listings open), so both work without
    JavaScript: the price (`step="0.01"`, from 0, optional) and its currency (the listings',
    else USD, where marketplace's field starts empty), then Set listing alert or Set offer
    alert. The rail on this tab is the Watch card, with no listing to buy. As with the buy and
    sell forms, each form posts the page's address and the product it showed, and
    [`watching`](marketplace/src/watching.rs) reads the item again. A product the page no longer
    shows is refused. The options and summary come from the page, not the form, since the API
    checks nothing against the catalog ([chase-sets/chase-sets#10595 [discovery] Check a Product Alert's item and product against the catalog, and take its summary from it](https://github.com/chase-sets/chase-sets/issues/10595)). The price is checked as marketplace's
    `normalizeMoneyAmount` checks it (two decimals, zero allowed). A price needs a three-letter
    currency, and with no price the alert has no threshold, whatever the currency says (the
    API refuses one without the other). An account without `accounts.view` (a guest checkout's
    session) is told "This account cannot create Product Alerts." (403), where marketplace's
    action throws. An account's alert redirects (303) back to the Watch tab with
    `watched=<receipt>`, and the page says the alert was saved, with Manage alerts linking to
    marketplace's alert settings after the write. Marketplace says nothing ([chase-sets/chase-sets#10597 [discovery] Say a Watch alert was saved after Set alert on the item page](https://github.com/chase-sets/chase-sets/issues/10597)); the words
    are the pilot's own (`item.watch_saved`). A guest's alert is an intent: its owner is kept in
    marketplace's own cookie (`chase_sets_anonymous_product_alerts`, 30 days), and the guest
    goes to marketplace's `/register` with the return address marketplace builds. Marketplace's
    item page claims the intent on the way back. A create takes no attempt id, so a form sent
    twice is two alerts ([chase-sets/chase-sets#10596 [discovery] Create an account Product Alert once when the same create is sent twice](https://github.com/chase-sets/chase-sets/issues/10596)).
36. **List this product is the pilot's, one plain form, written as one attempt.** Marketplace's
    action (`list-at-price`) makes three writes: it ensures the account's Listing stock holds the
    product, creates the listing from the stock's snapshot, then publishes it. The pilot
    ([`listing`](marketplace/src/listing.rs)) makes the same three, with one `SubmitKey` for all
    of them. The stock's ensure takes it as its attempt, and the listing's id is made from it
    (`listingIdOverride`, `lst_` and the UUID's digits). So a form sent again (its answer lost)
    is the same stock and the same listing. The create then answers the listing as it is now,
    and when it is already active the pilot does not publish it again, which the API would
    refuse. The fold shows one of four things. An account that may not list sees registration.
    A seller with their own listing of the product sees it and Manage listing. Without the
    ship-from setup, the button is disabled and the setup's form is shown (a Listing stock
    location, its own attempt). Otherwise the price (starting at the best listing's), currency
    and quantity are shown. A guest's listing is a draft intent, kept in marketplace's cookie
    (`chase_sets_anonymous_listing_drafts`) and claimed after `/register`, as marketplace does.
    A refusal shows in the form, and a publish refusal (a price that needs photo evidence) also
    links to the draft. After a listing, the post redirects (303) to the item with the listing
    chosen and the write's receipt. The page reads the item and the seller overlay at once, since
    each may wait 2.5 s on the API for the receipt, so the page waits once rather than twice
    (measured on the sandbox: 2.6 s with both behind, where the earlier page took 4.3 s). Until
    Discovery has caught up, the fold says the listing was published (the pilot's own words,
    `item.listing_published`), links to it, offers no second listing and reads again in 2 s.
    Marketplace's Create listing fails today for every product, because the create refuses two
    keys the stock's snapshot now has ([chase-sets/chase-sets#10599 [marketplace] Accept the Listing stock snapshot Inventory returns when creating a listing (two new keys are refused)](https://github.com/chase-sets/chase-sets/issues/10599)). The pilot leaves each out when it is null
    (`accepted_snapshot`). A graded product is not listed: the ensure needs graded details the
    form does not collect ([chase-sets/chase-sets#10598 [discovery] Let List for sale on the item page list a graded product (it never sends graded card details)](https://github.com/chase-sets/chase-sets/issues/10598)).
37. **The item page's mobile action dock links to the rail.** Marketplace holds a bar at the
    bottom of the screen below its `xl` width (80rem): the price (the chosen listing's, the best
    offer's on the Sell side, else the lowest listing's), then Buy, Sell and Watch, or a single
    Select options while the options name no product. Each of its buttons opens that side's rail
    card in a bottom sheet, which is a script and a second copy of each form. The pilot's dock is
    the same bar, `position: sticky` at the bottom with the safe-area inset, and its buttons
    are links to the page on that side at `#rail-title`. So it works without JavaScript, and the
    rail stays the one place each form is drawn. Corten's navigation keeps the fragment: the link
    lands with the rail's title at the top of the screen, with and without JavaScript (checked
    at 390 px; the dock is shown at 800 px and hidden at 1280 px). It adds no script.
38. **The item page's gallery needs no script.** Marketplace's `ImageGallery` keeps the shown
    picture in React state, and its thumbnails are buttons. The pilot draws each thumbnail as a
    radio button (outside any form, so it posts nothing) just before its picture, and the
    stylesheet shows the picture after the checked one (`:has(:checked) + .shot`). Clicks, and
    the arrow keys between thumbnails, change the picture with no JavaScript. The pictures are the
    same as marketplace's (`buildItemDetailImages`, then the card back when it stays). Only the
    first is fetched with the page: the others are `loading="lazy"` and `display: none`, so the
    browser fetches one when it is picked (checked at 390 and 1280 px against a stand-in page,
    since no sandbox item has two pictures). The thumbnails are a grid column, and the picture
    spans its rows with a last `1fr` row that takes its height, so the thumbnails stay at the
    top whichever picture is shown.
39. **The item page's similar items read with the item, without a write's receipt.** Marketplace's
    loader reads them after the item, by its id, and reads a failure as none. The pilot reads them
    by the address's slug or id at the same time as the item and the seller overlay, so they add
    no wait to the page (the sandbox answers in about 15 ms warm). They read without the receipt
    a listing's page carries, since no write of the page's changes them and they should not wait
    2.5 s for one. A refused form's page leaves them out, as it leaves out the Sell tab's reads:
    that page is about the form. Each card is the search result's `ListingCard` (the
    `search-card` rendition, else the first image, else the card back when it stays, at its card
    size; alt text the item's display identity) without two parts that do nothing here: its Save
    button, which has no action in marketplace, and the card back drawn behind a picture. View item
    goes to the item's page in the pilot and is described by its card's title, so eight of them
    are told apart. Checked at 390, 800 and 1280 px against the sandbox: the same eight items in
    the same order as marketplace's page, one column then two from 64rem, no sideways scroll, and
    every picture loaded once scrolled to (each is `loading="lazy"`).
40. **The Sales tab is read with the page and its chart is SVG drawn on the server.** Marketplace's
    `ItemDetailMarketPanel` fetches the market history from a resource route after the page
    hydrates, keeps the range in React state, and draws `TimeSeriesChart` (hand-rolled SVG, with
    a fade-in) in the browser. The pilot reads Pricing's stats, then each currency's series
    (`GET /api/marketplace/market-rollups/{item}/{product}/stats` and `.../series`, the windows
    and granularities of `resolveMarketHistoryRangeWindow`), only when the Sales tab is shown,
    and without a write's receipt. It draws the same geometry on the server: the line, the
    band, and a mark with a `<title>` for each verified sale, in a 640 by 220 box that scales
    with its width and scrolls in its box below 480 px, with the same screen-reader summary
    (`item.chart_summary` and `item.chart_marker`, since marketplace's are English in the design
    system). The range is a `range=30d|90d|1y|all` parameter (90 days when absent), and each
    range is a link, so the tab works without a script and can be shared. It adds no script. One
    deliberate difference: marketplace drops the range control when the range has fewer than
    two sale days, so older sales cannot be reached
    ([#10603 [design-system] Keep a chart's range control when the range has too few points to plot](https://github.com/chase-sets/chase-sets/issues/10603)).
    The pilot keeps it. A refused form's page does not read the history again; its Sales tab is
    a link to the page that does (`item.sales_again`). Not ported: marketplace refetches when a
    `pricing.productMarketStats` realtime patch lands for the product, so a sale moves the
    numbers without a reload. Measured once against the sandbox's release build: the Sales tab's
    page in 48 to 76 ms warm, the Listings tab's in 34 to 51 ms. The sandbox has no recorded
    sales, so the chart was checked with the router test's stand-in history in the real page's
    stylesheet at 390 and 1280 px.
41. **The item page's market parts are kept current by `<corten-live>`, not patched in the
    browser.** Marketplace subscribes to `public:market` and `item:{id}`, applies each listing,
    offer and market-summary patch to the item in React state, and refetches the Sales tab on a
    `pricing.productMarketStats` patch. The pilot's page has an empty
    `<corten-live src="/items/{id}/live?{address}">`. On each change to `item:{id}` (the topic
    every listing, offer and Pricing stats patch for the item names), the server reads the item
    again, and the Sales tab's history when it is shown. It then draws the market summary, the
    market book and the mobile dock again, each swapped in by its id, with the realtime cursor,
    so a reconnect resumes. It skips `public:market`, which ticks on every change anywhere in
    the marketplace. It draws nothing when the stream opens, since the page was drawn just then,
    as marketplace's subscription applies only later patches. The rail and the options are not
    redrawn: they hold forms. Corten's patch keeps a field the user edited, but a redraw of a
    form the buyer is using would still change what it posts under them. So a listing that goes
    away while chosen is refused when posted, as before. The cost is one item read per open
    page per change to the item, where marketplace applies the patch it was sent. That is fine
    at the pilot's scale; at marketplace's it wants one read per item shared by its viewers,
    which is the app's to do (one cache keyed by item), not Corten's. It adds no script of the
    pilot's own. Checked against the sandbox at 390 px, measured once: with the page open on the
    raw product, `scripts/smoke-market-item-list.mjs` published a listing, and the market book
    went from 2 rows to 3 and the summary from 1 seller to 2. After the withdraw it was back to
    2. The quantity typed into the rail stayed `2` through both redraws, with no console errors.
42. **A reference's dialog is a native `<dialog>` opened by an invoker command.** Marketplace
    keeps the chosen reference in React state and draws `ReferenceInfoDialog` for it. In the
    pilot, each value in the Details tab that names a record is a button with
    `command="show-modal" commandfor="reference-{id}"`, and the page draws one `<dialog>` for
    each record, with the same rows: type, status and key, the attributes in the API's order,
    and the relationships. The browser opens it, makes it modal, closes it on Escape or its
    close button, and returns focus to the value, all with no script (checked at 390 px with
    JavaScript off). The dialogs are in the Details tab beside their triggers, inside the market
    book a change to the item redraws. Until the `c919779` pin they were drawn outside it,
    because a redraw closed an open one
    ([todd-skelton/corten#84 A patch or live fragment closes a <dialog> the user opened and folds a <details> they unfolded](https://github.com/todd-skelton/corten/issues/84));
    Corten now keeps a dialog the user opened open, and modal. At that pin, with a reference's
    dialog open at 390 px, the list smoke published and withdrew a listing: two patches with
    the book reached the stream, and the dialog stayed open and modal with no page errors
    (checked once; the Details tab's markup did not change, so the runtime had nothing to
    replace there).
43. **Add to List is a dialog the page draws, with its lists and its ids.** Marketplace's
    button posts `prepare-saved-list`, which reads the account's recent Saved Lists and makes
    the ids the addition is written with, and then opens its sheet. The pilot reads the recent
    lists with the page, beside the item read, so the page waits no longer for them (Discovery's
    own picker projection; only for an account with `accounts.view`), and draws the four ids
    (`slc_`, `sll_`, `svl_`, `slc_` ULIDs, as `createSavedListAdditionTokens` makes them) as
    hidden fields. So Add to List opens with no request and no script
    (`command="show-modal"`), and the same form sent twice is one addition. The new list's
    title is shown only while a new list is chosen, by CSS (`:has(input[value="new"]:checked)`).
    Add Product checks the quantity (a whole number, 1 to 1,000,000) and the title (1 to 120
    UTF-16 units) as the API does, posts `AddProductToSavedListRequest` with the product's
    options from the page it was drawn as, and redirects (303) back with `saved=<receipt>`,
    `saved_list`, `saved_quantity` and `saved_line`. The page then says "Added to {list}"
    with "added" or "merged" copy and View in My Collection (marketplace's collection, after
    the write). It reads the recent lists without the receipt and again with it only when the
    list is not there yet (a list it just made). Measured in the sandbox against the release
    build: with the receipt on every read, the picker read after an addition to a list it
    already had took 1.5 s once and timed out at 2.6 s once, and the page after it 1.9 and
    2.4 s (two runs); with the second read only when needed, that page loaded in 246, 288 and
    314 ms (three runs), and the page after a new list in 1.8 s (one run).
    A refused form (the pilot's checks or the API's) comes back 422 with the dialog drawn
    `open`, what was chosen and typed, and the same ids, so trying again is the same addition;
    `corten_ui::dialog::modal` makes it modal when it joins the page.
    An account without `accounts.view` (a guest checkout's session) gets the dialog with
    "This account cannot manage Saved Lists." and no read. A guest's button posts the product:
    an anonymous intent (its owner in marketplace's `chase_sets_anonymous_saved_lists`
    cookie, 30 days), then marketplace's `/register`, back to the item with
    `claimSavedListIntent`, which marketplace's item page claims. On a phone the dialog is a
    sheet at the bottom of the screen, like marketplace's. A page that answers another rail
    form's refusal leaves Add to List out rather than add a read to each of them. The list
    summary says "1 lines", as marketplace's does
    ([chase-sets/chase-sets#10604 [collections] Say 1 line, not 1 lines, for a Saved List in Add to List](https://github.com/chase-sets/chase-sets/issues/10604)).

44. **The Operations Attention queue draws what the API composed.** admin-web's page renders the
    API's queue as it is, and so does the pilot. The API reads each source the caller may see,
    marks the ones it could not read with a reason, orders the items and counts them; the page
    checks none of it. An item's words are its `summary.code`'s message with the API's arguments
    (`t.by_key`), or admin-web's key when the catalog has no such message. Its times are
    `formatDateTime`'s (`parse_timestamp` reads the Postgres form the feedback source sends,
    `2026-05-04 15:00:00+00`). Open goes to admin-web, since no page it names is ported. The page
    is an area (`/platform/operations-attention`, guarded by `projection-operations.view`, the
    permission admin-web's nav entry and section loader ask for) with its own stylesheet. The
    live status moved out of the catalog and takes each screen's words. Both areas list it, so its
    stylesheet is one file they share (`sections/platform/operations-attention+catalog.css`). Until
    the `319d3b7` pin it was in `App::components`, because Corten refused a component listed in
    two areas. The page follows admin-web's realtime topic and draws
    the counts, the missing sources and the rows again on each change. The platform does not
    register that topic yet (chase-sets/chase-sets#10607), so the stream ends at once and the
    status shows nothing; admin-web's says Connecting. On a phone the counts are two by two and
    each row is a card with each cell beside its heading, CSS only, as admin-web's `DataTable`.
    The degraded line's two arguments are both text, and `t` takes a message's arguments in the
    order the message names them (`{source} unavailable: {reason}`): the router test caught them
    swapped. This port merged `origin/main` into the branch first, for the API's runtime reads
    ([#10557 [platform-operations] Wire projection and wake reads into the platform API and load the admin Operations Attention queue from it](https://github.com/chase-sets/chase-sets/issues/10557)).

45. **The notification center is plain forms, and an alert's write reads with its receipt.**
    Marketplace's page is a React island that posts to its own BFF and patches its state. The
    pilot's every action is a form: a channel's switch is the form's one button (`role="switch"`,
    `aria-checked`), so it toggles without a script, and with one it is a `data-patch` form whose
    answer is the switch the API returned, focus kept on it. Mark read and Mark all read answer the
    feed the API returns with the write (`{status, feed}`), so they need no second read. The
    Product alerts list is Discovery's projection, which measured 1.9 to 6.4 s behind a write,
    longer than the platform's freshness wait (about 2.5 s). So Pause, Resume and Delete send the
    write's receipt with the list's read, and the alerts are drawn again in place either way: caught
    up, the list; not yet, the section saying the change is saved, which asks to be read again after
    2 s from the settings' address with the receipt (`ReadAgain::from`, from the `8cb28fb` pin,
    [todd-skelton/corten#104 A data-patch answer cannot ask to be read again, so a write whose read is catching up has to navigate](https://github.com/todd-skelton/corten/issues/104)).
    That address answers the section alone to the runtime (`Mode::Action`), asking again while it
    is behind, and the page otherwise. A read that fails, after the write or read again, answers
    the section as a 502 patch saying the change was saved and a reload shows it, which the
    runtime applies whatever its status (from the `cf48958` pin,
    [todd-skelton/corten#118 A patch's read again stops quietly when the server fails it](https://github.com/todd-skelton/corten/pull/118));
    before it, such a read navigated. Without JavaScript the write redirects there (`afterWrite`, `section=product-alerts`, at `#product-alerts`,
    whose heading takes focus), and the page says the change is pending and reads itself again
    after 2 s (`ReadAgain`). Before the `0f3f03f` pin that redirect and the item page's Manage
    alerts link carried no fragment, since a page at one was never read again
    ([todd-skelton/corten#107 ReadAgain never reads a page whose address has a #fragment, so a write redirected to route.at(..) stays on its catching-up state](https://github.com/todd-skelton/corten/issues/107)).
    Marketplace's redirect carries no receipt at all
    ([chase-sets/chase-sets#10627 [discovery] Pausing, resuming or deleting a Product alert shows its old status: the redirect carries no write receipt](https://github.com/chase-sets/chase-sets/issues/10627)).
    The smoke checks that the three writes navigate nowhere and reports how often the section was
    read again (twice on the sandbox at the `8cb28fb` and `cf48958` pins).
    The page is one narrow column at every width, as marketplace's is, with 2.75rem controls
    ([`notifications.rs`](marketplace/src/notifications.rs),
    [`notification_page.rs`](marketplace/src/views/notification_page.rs)).

46. **public-web is its own app, and every answer is the same for everyone.** public-web is a
    third web host (chasesets.com), with no shell and no session, so its market page is a third
    app, `public/`, rather than a route in `marketplace/`. Each handler returns `Public`, whose
    inputs cannot tell who is asking: a `Caller`, a cookie or a header does not compile there.
    The page reads Pricing with `Platform::anonymous`, which sends no cookie and names the site's
    configured host instead of the request's. Corten sends the page `public, max-age=60,
    stale-while-revalidate=3600` and `Vary: cookie`, and `private, no-cache` to a request with
    a cookie, a client navigation, a 404 or a 502. A CDN keeps it for the `s-maxage` Pricing's own
    answer sets from its display policy (`Public::shared`, from the `8cb28fb` pin,
    [todd-skelton/corten#106 Public has no shared-cache lifetime (s-maxage) apart from the browser's, so a CDN cannot keep a page longer than a browser](https://github.com/todd-skelton/corten/issues/106)),
    a day by default; public-web writes that day as a literal, so a revised policy reaches its JSON
    API but not its page.
    The chart is the item page's Sales chart, moved to `platform::chart` so both apps draw the
    same geometry; the market page passes each day's median, or last, price and its low to high,
    with no marks. The stats are a `<dl>`: public-web's values are `h2`s
    ([chase-sets/chase-sets#10629 [pricing] The public market page's stat values are h2 headings, so a screen reader lists "$44.50" and "3" as sections](https://github.com/chase-sets/chase-sets/issues/10629)).
    "{count} trades" is the catalog's, "1 trades" too
    ([chase-sets/chase-sets#10630 [pricing] The public market page says '1 trades' for a window with one trade](https://github.com/chase-sets/chase-sets/issues/10630)).
    Three deliberate differences. The sitemap lists only the pages this app serves (public-web
    also lists its own), each with when it last traded (`lastmod`; public-web has the date and
    leaves it out), and a failed read answers 502 instead of a sitemap without the market pages,
    which a crawler would keep for an hour. One canonical origin (`CHASE_SETS_PUBLIC_ORIGIN`) for
    the page and the sitemap, where public-web's market route falls back to the request's origin
    and its layout to chasesets.com. Home is this app's `/` now (decision 49), in its own layout;
    a client navigation to it loads it in full, since the shell key names the layout (since the
    `4bd06d3` pin, [todd-skelton/corten#122 Client navigation between pages with different layouts keeps the first layout, because the shell key does not include the layout](https://github.com/todd-skelton/corten/issues/122)).
    Not ported: the waitlist analytics bridge public-web's layout inlines in every page (the
    market page sends no event; the home page's script carries its own), the favicons and the
    manifest
    ([`market.rs`](public/src/market.rs), [`market_page.rs`](public/src/views/market_page.rs),
    [`chart.rs`](platform/src/chart.rs)).

47. **The account's orders are plain links and forms, and Cancel shows only to who may cancel.**
    Ordering's four routes (`account-purchases`, `account-purchase`, `account-sales`,
    `account-sale`) are one module for both sides (`Side`): a buyer reads with `orders.view`, a
    seller with `orders.view` and `listings.view`, and both cancel with `orders.manage`, as
    Ordering's loaders and actions ask. The list's pages are links (`Paging`: `limit` 1 to 250,
    100 when missing, zero or not a number, as `orderListPageQuery` reads it). A purchase's Cancel
    is a form; a sale's asks first in a `<dialog>` its button opens with `command="show-modal"`,
    so it needs no script. A cancellation redirects to the order with the write's receipt; while the
    read has not caught up the page says the change is pending and reads again after 2 s
    (`ReadAgain`), and a read that fails after a write says the change could not be confirmed. A
    refusal is the order again with the API's status and words. Three differences. Cancel is drawn
    only for `orders.manage`: marketplace draws it for anyone who may read the order and its action
    answers Forbidden
    ([chase-sets/chase-sets#10635 [ordering] A purchase page offers Cancel to a member without orders.manage (an unverified email), and the action then answers Forbidden](https://github.com/chase-sets/chase-sets/issues/10635)).
    The delivery summary's time is read in Postgres's form as well as ISO 8601, since the API sends
    `2026-03-22 12:00:00+00`
    ([chase-sets/chase-sets#10634 [ordering] A purchase's delivery_summary.latest_delivered_at is Postgres text (2026-03-22 12:00:00+00), not ISO 8601](https://github.com/chase-sets/chase-sets/issues/10634)).
    The card and fact badges keep marketplace's status codes (`ready-for-fulfillment`,
    `standard`), where its outcome panel writes words; the pilot matches it until Ordering decides
    ([chase-sets/chase-sets#10633 [ordering] Order pages show status codes (ready-for-fulfillment, standard, active) where the same page elsewhere writes words](https://github.com/chase-sets/chase-sets/issues/10633)).
    One column on a phone; the money beside the order from 64rem; two cards to a row from 80rem;
    2.75rem controls
    ([`orders.rs`](marketplace/src/orders.rs), [`order_page.rs`](marketplace/src/views/order_page.rs)).

48. **The account's shipments are read only, and the seller's work stays on marketplace.**
    Fulfillment's three page routes (`account-shipments`, `account-shipment`,
    `account-sale-shipment`) are one module for both sides (`Side`). Both read with
    `fulfillment.view` (`Shipper`), as Fulfillment's loaders ask; the buyer's list reads the first
    100, as marketplace does. The seller's list is not ported: marketplace builds the command center
    (buckets, their order and each shipment's next action) from Fulfillment's rules in its own
    loader, and its actions check the posted state there too, so the pilot's
    `/account/sales/shipments` answers 303 to marketplace's until the API serves it
    ([chase-sets/chase-sets#10638 [fulfillment] Serve the seller's shipment command center (buckets, order and each next action) from the Fulfillment API instead of building it in the web host](https://github.com/chase-sets/chase-sets/issues/10638)).
    For the same reason a shipment's actions (packing, labels, void, dispatch, delivery, returns,
    exceptions, cancel), its Back and Print packing slip open marketplace's page. Each empty state is
    said once, where marketplace says it as the title and again as the description
    ([chase-sets/chase-sets#10641 [fulfillment] A shipment page says each empty state twice ("No shipment exceptions recorded." as the title and again as the description)](https://github.com/chase-sets/chase-sets/issues/10641)).
    A notification's Open, and a purchase's View fulfillment, now open the pilot's shipment pages;
    of the seller's only a shipment's own page does (`notifications::served_here`). Postage is
    cents through `Decimal` and the locale's money format. One column on a phone; the facts two to
    a row and the cover three from 48rem; two cards to a row from 80rem; 2.75rem controls
    ([`shipments.rs`](marketplace/src/shipments.rs), [`shipment_page.rs`](marketplace/src/views/shipment_page.rs)).

49. **The home page is the same for everyone, so what public-web reads per visitor comes another
    way.** public-web's `/` is a third public page in `public/`, in its own layout
    (`HomeLayout`: the skip link, promo bar, nav, `main` and footer), with its components in
    `App::components` since it is `/` (decision on
    [todd-skelton/corten#95 A page outside every area (the app's /) cannot link an area's stylesheet, so a screen that is also the home page ships its CSS on every page](https://github.com/todd-skelton/corten/issues/95)).
    It is `Public`: a browser keeps it a minute, either serves it a minute stale, and a shared
    cache keeps it four minutes only when Commerce's fee terms were read live, which stays inside
    the six minutes the /sales-fees article promises a fee change takes; a page drawn with the
    compiled terms (2.9% + $0.30 card, 0.5% bank) is not kept by a CDN. Three reads at once, each
    waited on for 2 s (public-web's `LANDING_FEE_READ_TIMEOUT_MS`): the policy values, the promo
    bar and the waitlist counter. Each good read is kept for the next visitor (`kept::Kept`, five
    minutes for the terms as public-web keeps them, a minute for the others) and a failed read
    falls back to the last good one, then to none
    ([todd-skelton/corten#121 There is no way to keep an upstream read for a while across requests, so a page that every visitor opens reads the same data each time](https://github.com/todd-skelton/corten/issues/121)).
    public-web's shell fetches the promo bar and counter from the browser after the page renders,
    so they move the page in; here they are drawn with it. The referrer public-web reads from the
    request is the browser's: the page's script writes `document.referrer` into the forms, so a
    visitor without one sends none. The variant (`?intent`, or buyer words in `utm_*`) picks
    which hero copy shows; both are in the page, the other `hidden`, so there are two `h1`s and
    one is shown, and the hero's role swaps them with a script. The forms' hidden source fields
    are named as the API names them (`page_path`, `utm_source`, ..). Percentages are written
    with `t.number` and a literal `%`
    ([todd-skelton/corten#119 i18n writes no percentage, so a rate like 2.9% cannot be localized](https://github.com/todd-skelton/corten/issues/119)).
    Join sends the visitor's address as `X-Forwarded-For`: Corten's `ClientIp`, the
    connection's peer or, behind the proxies the deploy lists in `PROXIES`, the nearest address
    they forwarded that is not one of them ([todd-skelton/corten#120 A handler cannot read the client's address, so an app that calls an API for a visitor cannot pass it on for rate limiting](https://github.com/todd-skelton/corten/issues/120), fixed at the `07d7f65` pin);
    public-web sends none
    ([chase-sets/chase-sets#10644 [public-presence] Waitlist signups through public-web share one rate-limit bucket because no client address reaches the API](https://github.com/chase-sets/chase-sets/issues/10644)).
    A signup answers 303 to public-web's `/welcome`, which reads the role, variant and games from
    the address. The legacy fee-calculator share link moves to public-web's compare page with its
    `Location` written by hand to add `#fee-calculator`
    ([todd-skelton/corten#123 An address outside the app cannot carry a #fragment, so req.moved and req.redirect drop the anchor of an external URL](https://github.com/todd-skelton/corten/issues/123)).
    A client navigation between `/` and the market page loads the other layout in full (#122
    above, fixed at the `4bd06d3` pin). The analytics bridge posts to
    `/api/public-presence/analytics/waitlist` on the page's own origin, as public-web's does; in
    production the ingress sends `/api` to the platform API, and locally it is a 404. The words
    are public-web's (`locales/home.en.json`, exported), the brand's foil colors are tokens, and
    the hero picture is three widths (800, 1,200 and full) in a `srcset`. One column on a phone
    with the sticky call to action at the bottom; the hero's form beside its copy from 64rem
    ([`home.rs`](public/src/home.rs), [`home_page.rs`](public/src/views/home_page.rs),
    [`presence.rs`](public/src/presence.rs), [`kept.rs`](public/src/kept.rs),
    [`client.rs`](platform/src/client.rs)).

50. **Packing is the API's rules and the page's attempts; the browser only remembers.** The
    seller's packing page (Fulfillment's `shipment-packing-page.tsx`) is in the seller's shipment
    area, its routes `Packing`, `PackingStart`, `PackingLine`, `PackingScan` and `Pack`. Every
    rule is the API's: when packing may start, how many of a line may be packed, that every line is
    packed before the package is; the pilot checks only that a count is a whole number (a package
    count at least 1), as marketplace's form does. Each write's form carries its attempt
    (`SubmitKey`), sent as the `Idempotency-Key` Fulfillment applies once. A refusal asks the API
    what came of the attempt (`mutation-recovery`): one it applied before reads as applied, one it
    refused shows the API's words (422), and one it cannot say anything about sends the page to
    ask (`?check=`). Before a write is sent the page's script remembers its attempt in
    `sessionStorage` (`shipment-mutation/v1:<account>:<shipment>`); the next page forgets an
    attempt its answer settles and asks about any other, and while the API cannot say, the page
    says it could not confirm the write with every write off (a disabled `fieldset`), offering
    Check again and Discard. Marketplace keeps that record encrypted in IndexedDB
    (`mutation-recovery.ts`); the pilot's holds only the attempt id, which is not a secret, so
    `sessionStorage` is enough. A line's box is a submit button with `role="checkbox"` whose
    value is the line's quantity or 0, and the step down and up are buttons with the count either
    side, so it all works without a script; with one, a line's or a scan's answer is a patch of the
    line, the progress, the scan and the footer (`PackingParts`), read after the write's receipt,
    and the page when that read is behind. A scan finds a line as marketplace's `findScannedLine`
    does (a reference exactly, its short form, then a title containing it) and sends one more
    packed. Start redirects to the packing page and Finish to the shipment's page, each read after
    the write; the shipment's page reads itself again while it has not caught up. The scan's
    result is in the address (`?scan=matched`), its words written by `#[derive(UrlValue)]` from
    serde's ([todd-skelton/corten#129 A query value must be Display while it is read with serde, so an enum in an address spells its words twice](https://github.com/todd-skelton/corten/issues/129), fixed at the `4bd06d3` pin). The seller's Back is the pilot's `/account/sales/shipments`, which redirects to marketplace's
    command center; a client navigation there leaves in one request since the `15dc546` pin
    ([todd-skelton/corten#131 A client navigation to a route that redirects to another origin is blocked by connect-src, then reloads](https://github.com/todd-skelton/corten/issues/131), where the link went straight to marketplace). The seeded shipments cannot be packed in the sandbox ([chase-sets/chase-sets#10645 Let the seed seller pack a seeded shipment instead of Shipment mutation authority is unavailable](https://github.com/chase-sets/chase-sets/issues/10645)), so the
    smoke stops at the page asking about the refused start; the writes are checked by the router
    tests against a stand-in. Two columns from 64rem with the details beside the checklist; on a
    phone one column with Finish sticky at the bottom (and the safe area), 2.75rem controls
    ([`packing.rs`](marketplace/src/packing.rs), [`packing_page.rs`](marketplace/src/views/packing_page.rs),
    [`packing.js`](marketplace/src/views/packing.js)).

51. **Shipping addresses are Identity's attempts, settled on the server.** The collector's
    shipping addresses (Identity's `account-shipping-addresses`) are an area of their own,
    `ShippingAddresses`, whose caller `AddressOwner` reads with `accounts.view` and writes with
    `accounts.manage`. Every rule is the API's: the required fields, whether an address is
    deliverable, and the address it suggests instead; the pilot checks only that the form carries
    its attempt. Each write is an account-management attempt: the form's `SubmitKey`, sent as the
    `Idempotency-Key`. Identity answers with an `outcome` (`committed`, `not-recorded`, `conflict`,
    `indeterminate`) rather than an `error`, so its calls read the answer themselves
    (`api::AccountAnswer`, named `AddressAnswer` until decision 63) instead of `Caller::write`. A write with no answer, or an
    `indeterminate` one, is asked about at once (the attempt lookup), as marketplace's
    `sendMutation` does; one the lookup cannot settle sends the page to ask again (`?check=`, with
    the action and target), which says it could not confirm the result with that write's form off,
    and Check again. Marketplace keeps that record in memory and loses it on a reload; the pilot keeps
    it in the address, and needs no script. A suggestion draws the form again (422) with the
    suggested address and what was entered, and two submit buttons that send it again, in the new
    attempt the form is drawn with, with the choice (`decision`). A committed write redirects with
    its receipt (from the headers, or the lookup's `destination`), and the list, which lags a write
    by about 4 s in the sandbox, says it is still updating and reads itself again. Marketplace's
    action refuses a post without its script (`requireInterruptionSafeClient`); the pilot's forms
    work without one. Update address's form is in a dialog its button opens (`command`), drawn
    open and made modal when its update is refused. One column on a phone, the fields two to a row
    from 48rem ([`addresses.rs`](marketplace/src/addresses.rs),
    [`address_page.rs`](marketplace/src/views/address_page.rs)).
52. **Create listing is one form; everything before the write is a GET of it.** Marketplace's
    page is a React form with a catalog combobox, a drop zone and client-side previews. The
    pilot's is one `multipart/form-data` form (`data-patch`). Find, Choose, Choose another
    item, an option or inventory change (`data-redraw`), Use this inventory and Preview fees are
    `formmethod="get"` buttons that send the form's fields to the page. Its handler draws the
    page as the address says. With JavaScript the answer is a patch of the form's parts (notice,
    product, photo message, readiness, actions, fees), so the photo input, outside them, keeps its
    files. Without JavaScript it is the whole page, and every step works. `listing_new.js` only
    asks for those GETs sooner: when a select changes, and 250 ms after typing settles in the
    search (from two letters, as marketplace's picker does). The writes follow marketplace's action.
    From inventory, the create takes `inventoryItemId`. For a catalog product, the Listing stock is
    ensured first, with the form's `SubmitKey` as its `inventory-mutation-attempt`, and the create
    takes its snapshot. The create's `listingIdOverride` comes from the same key, so the same form
    sent again is the same listing. An item that Marketplace's read has and Inventory's does not is
    created from Marketplace's snapshot (`createListingFromMarketplaceSupplySnapshot`). Create and
    publish publishes after the create; publication blocked by missing evidence goes to the listing
    with `evidenceEvent=publication_blocked`. Any other refusal keeps the draft and says so with a
    link to it. Photos are read with Corten's `Upload<Raw>` (since the `12e0695` pin; multer before
    it, until [todd-skelton/corten#140 A form cannot post a file: Form reads only URL-encoded bodies, so a multipart form is a 415 and nothing reads its files](https://github.com/todd-skelton/corten/issues/140) closed): the whole body is limited to 60 MB, each photo is read up to 10 MB
    (`bytes_up_to`) and kept only if it is from the photo input and within the count, and a file
    over its limit is read past, not kept. The photos kept are held in memory, since the API takes
    them in one request after their first bytes are checked. A body over 60 MB, with a
    `Content-Length` or without, is `UploadError::TooLarge` (since the `9627ee2` pin; a
    `Content-Length` precheck before it, until [todd-skelton/corten#150 A handler cannot read an Error's status, so an upload over Upload::limit (413) cannot draw the form again with a message](https://github.com/todd-skelton/corten/issues/150) closed), and the page draws the form again
    with a 413 and says so. Each file's first bytes must say JPEG, PNG or WebP,
    because the API answers 500 for anything it cannot decode
    ([chase-sets/chase-sets#10649 [marketplace] Refuse a listing photo the API cannot decode instead of answering 500](https://github.com/chase-sets/chase-sets/issues/10649)).
    A 5xx from a create with photos is drawn as "the photos could not be processed, nothing was
    created". The purchase limits are sent as their own fields, only those given, because the
    multipart create refuses marketplace's `purchaseLimits`
    ([chase-sets/chase-sets#10650 [marketplace] Create listing with photos is refused: the form sends purchaseLimits, which the multipart create does not take](https://github.com/chase-sets/chase-sets/issues/10650)).
    The area's deadline is 150 s (`Area::deadline`), because the API turns each photo into six
    sizes. The page differs from marketplace's in two ways. "Advanced inventory and limits" is
    open when an inventory item is chosen, so what was chosen is in view. A refused photo marks the input `aria-invalid` with its message, with or without
    JavaScript; the patch keeps the files chosen (since the `76eda4f` pin), and the input names
    its hint and then the message in one `aria-describedby`, written by
    `e.aria(f.evidence).hint(&ListingPhotosHintId)` (since the `06821f8` pin; by hand before it,
    until [todd-skelton/corten#147 A field with its own hint cannot also point at its error: Within::aria writes a second aria-describedby, which the browser drops](https://github.com/todd-skelton/corten/issues/147) closed).
    One column on a phone, two from 64rem ([`listing_new.rs`](marketplace/src/listing_new.rs),
    [`uploads.rs`](marketplace/src/uploads.rs),
    [`listing_new_page.rs`](marketplace/src/views/listing_new_page.rs)).
53. **A seller's listing is small forms that post to the page, and the page reads after the write.**
    Marketplace's page has one action with twelve intents. The pilot keeps them as forms of their
    own, each posting its `intent` to the page, so each works without JavaScript. Preview fees is
    a GET of the page (`?preview=1&priceAmount=..&priceCurrencyCode=..`), not a POST intent,
    since it writes nothing; the price form then carries the preview's quote. A write that
    applies goes back to the page with its receipt (`afterWrite`) and, as marketplace's does,
    `evidenceEvent` (`upload_completed` after a photo upload, `remediation_completed` after a
    view, a reorder or a removal, `publication_succeeded` after Publish). A write that changes
    nothing comes back from the API without a receipt and goes back to the page without one. A
    read that has not caught up draws "Preparing listing", which reads itself again
    (`ReadAgain`) and links to the same address. A 409 that carries the API's current fee quote
    shows it and puts it in the price form; one that carries the evidence readiness now draws the
    checklist from it. An image description refused with one of the five authoring codes draws
    marketplace's recovery at that photo's field (`aria-invalid`, except for a rate limit).
    Classify names the slot, and the pilot reads the slot's view from the listing's policy, as
    marketplace does. Reorder sends the new order as comma-separated ids from its hidden field
    (marketplace's is JSON); the API gets the same list. Add photos and Replace post
    `multipart/form-data` to `/account/listings/{id}/photos`, read with `Upload` like Create
    listing's, under the same limits and picture check; a 5xx from them
    reads as "the photos could not be processed" (chase-sets/chase-sets#10649). Withdraw asks
    first in a `<dialog>` its button opens with `command="show-modal"`, no script. The pilot
    sends no analytics: marketplace's `trackListingEvidenceEvent` pushes to `window.dataLayer`
    when a tag manager is on the page, and the pilot loads none; `evidenceEvent` is kept in the
    address so one could. The area is `/account/listings` (its own page since decision 54), with Create listing an area inside it, both with the 150 s deadline;
    Create listing's draft and the item page's Manage listing now go to the pilot's page. A
    listing's photos are on the API's origin, plain http locally, so the policy adds it to
    `img-src`. One column on a phone; the overview's cards, the photos and two of the price
    fields sit two abreast from 48rem, the three limits three abreast
    ([`seller_listing.rs`](marketplace/src/seller_listing.rs),
    [`seller_listing_page.rs`](marketplace/src/views/seller_listing_page.rs)).
54. **The seller's listings are a form per intent, and a picked day becomes an instant on the
    server.** Marketplace's page posts every setting and the bulk changes to one action. The
    pilot gives each its own form (availability, the away window, the capacity, and the bulk
    bar's `listingIds`), each posting its `intent` to the page (`write`) or to `bulk`, so each
    works without JavaScript. An away window and an automatic return are days in the seller's
    time zone, which the API takes as instants (marketplace's `localDateInputToInstant`, in the
    browser). Since the `3375815` pin the handler reads the browser's zone (`App::client_zone`,
    `Option<ClientZone>`, [todd-skelton/corten#180 App::client_zone and Option<ClientZone>: a handler knows the visitor's time zone](https://github.com/todd-skelton/corten/pull/180)) and writes the day's start there with `jiff`
    (`seller_listings::start_of_day`, as marketplace's `toISOString`). Before the runtime has run
    (a first page, no JavaScript) there is no zone, so the handler reads the one the account chose
    in Identity's preferences (`UTC` until chosen), and UTC if that read fails; only the two
    forms with a day read it. Before, the page's script filled the instants and a window was
    refused without it ([todd-skelton/corten#149 A handler cannot know the visitor's time zone, so a picked date needs a script to become an instant and every date is written in UTC](https://github.com/todd-skelton/corten/issues/149)). Times are still written in UTC, as marketplace's
    `formatDateTime` writes them. The
    seller's metrics and open orders are read best-effort, without the receipt: a failed read
    draws no reliability card, not a failed page. Bulk changes go one listing at a time
    (deduplicated): a 4xx is that listing's outcome, a 5xx a 502, and the list is read after the
    latest receipt of those that applied (`Receipt::later`). The live part subscribes to
    `account:{id}:listings`, which the platform serves on `/api/realtime/account/events` only
    (the public endpoint answers 403), so `platform::realtime::endpoint` picks the account
    endpoint when every topic is an account's, as marketplace's `resolveRealtimeEndpointPath`
    does. The rows are `content-visibility: auto` (see Measured). Back to listings on a listing's
    page and Create listing now opens it. One column on a phone; a row's facts sit beside it from
    64rem, and the bulk bar sticks to the bottom of the screen while a listing is picked
    ([`seller_listings.rs`](marketplace/src/seller_listings.rs),
    [`seller_listings_page.rs`](marketplace/src/views/seller_listings_page.rs)).
55. **Offer matches are forms on the match's page, and adding one reads it as Checkout does.**
    Marketplace's list posts Add selected offer to Sell List to its sell list with sixteen hidden
    fields copied from the row, and its sell list's action then reads the offer again
    (`getSellListOfferMatch`) and uses only the id. The pilot's forms post just the intent to the
    match's page, which reads the offer from Checkout's `/account/sell-list/offer-matches/{id}`
    and adds the line from that read (`SellListLine::offer_match`, with the listing, prices and
    both stream versions), then goes to marketplace's sell list with the receipt and its handoff,
    as the item page's sell writes do. An offer no longer submitted is refused (409) before
    anything is added. Accept offer match does what marketplace's does: it adds the offer to the
    Sell List, where the sale is reviewed. Decline posts `decline` and goes back to the list
    with its receipt; a read still catching up is read again without it. Marketplace disables a
    match page's Decline while the seller cannot fulfill the offer, which is when declining
    matters most, while its list allows it; the pilot follows the list. The acceptance terms are
    best-effort: marketplace's page fails when the preview does, and the pilot draws the match
    without them. The list is `<corten-live>` on `account:{id}:offers`, which the offers
    projection writes for every seller with an active listing of the offer's product; the
    account realtime endpoint serves it (decision 54). Marketplace's list redraws only the rows'
    data and reloads on a sync; the pilot redraws the snapshot and the rows. The item page's
    offer line is unchanged: the new fields are left out when empty. The smoke's synthetic offer
    is the collector's, which cannot withdraw it ([chase-sets/chase-sets#10660 [marketplace] An unverified account can submit an offer but cannot withdraw it (submit needs no offers.manage; pause, resume and withdraw do)](https://github.com/chase-sets/chase-sets/issues/10660)), so every run reuses it and moves its
    price between two values. One column on a phone, a match's facts beside it from 64rem and a
    match page's cards two abreast from 48rem
    ([`offer_matches.rs`](marketplace/src/offer_matches.rs),
    [`offer_matches_page.rs`](marketplace/src/views/offer_matches_page.rs)).
56. **A submitted offer's change is a submit button on one form, and its outcome is drawn, not
    redirected to.** Marketplace's list posts Pause, Resume and Withdraw with a fetcher and draws
    each offer's outcome from the answer. The pilot puts the offers in one form: a row's button
    sends `row` as `{action}:{offer id}`, the bulk bar's buttons send `lifecycleAction` with the
    checked `offerIds`, and the page answers with the list and each outcome (as the seller's
    listings' bulk writes do, decision 54), read after the write's receipt. One offer uses its own
    command and several the bulk command, as marketplace's action does, and the refusals are
    mapped the same way: a single offer's 404 or 409 and a closed lifecycle's 503 are that offer's
    outcome, any other 4xx the page's banner. Withdraw asks first in a `<dialog>` its button opens
    with `command="show-modal"`, one per offer, so it needs no script. Marketplace's filter is a
    segmented control that navigates; the pilot's is links. A reader without `offers.manage`
    sees no boxes or buttons, where marketplace shows them and the API then refuses
    ([chase-sets/chase-sets#10660 [marketplace] An unverified account can submit an offer but cannot withdraw it (submit needs no offers.manage; pause, resume and withdraw do)](https://github.com/chase-sets/chase-sets/issues/10660)). The dev sandbox's API has not opened the
    lifecycle (`offer_lifecycle_closed`; `createOfferLifecycleAdmission` opens it by
    configuration), so changed and unchanged outcomes are checked against the stand-in only, and
    the smoke checks the closed answer live. Its synthetic offer is the demo seller's (the
    collector cannot change offers), on a product it does not list, at 1.01 or 1.02 USD. It stays
    open while the lifecycle is closed, and the next run reuses it. Not ported: market following
    and an offer's page. One column on a phone, two from 80rem, the bulk bar at the bottom of the
    screen once an offer is checked
    ([`submitted_offers.rs`](marketplace/src/submitted_offers.rs),
    [`submitted_offers_page.rs`](marketplace/src/views/submitted_offers_page.rs)).

57. **The inventory list is the list's own forms; Record sale is a dialog at an address.**
    Marketplace's list keeps Create Inventory Item's picker and the Record sale dialog in React
    state. The pilot's picker is Create listing's (decision 52): `listing_new::catalog` reads the
    matches or the chosen item, and its `redraw` and `find` handlers draw them as GETs of the page,
    patched in place with a script. The create is a `WriteForm` of the recovery family
    `item-create` (marketplace's `inventory-mutation/v1` record), confirmed on the next page if
    its answer is lost, and goes on to the item page with the write's receipt (marketplace's at the time; the
    pilot's since decision 58). Record sale has an address, `?sale={item}`, drawn open as a modal dialog; Close
    is a link back to the list. Its form posts to `/account/inventory/items/{id}/offline-sales`; a
    refusal is the dialog again (422, a patch with a script), and a recorded sale goes back to the
    list with what it did in the address (`offlineSaleItemId`, `requested`, `applied`,
    `refused`, `orders`) and the receipt, which the list reads the item again after
    (`readFreshWriteToken`); a read that fails says the result could not be verified, as
    marketplace does. Honoring a sale over its orders is drawn only for an owner or manager
    (`canHonorOffline`); anyone else who sends it is refused in the form. As on marketplace, the
    dialog is for an item the list shows. Two fixes the smoke found: checking a remembered write
    (`recovery.js`) is a GET of the page and now carries the page's own address, which closed an
    open dialog before; and Create listing's find as you type (`listing_new.js`) drops its pending
    search on any submit, which drew the matches over a choice made within 250 ms. The global
    `input[type="search"]` style the pages had each drawn is now in `style.css`. The sandbox shows
    two Chase Sets bugs:
    [chase-sets/chase-sets#10671 [inventory] Create Inventory Item offers Graded but never sends graded card details, so the API refuses it](https://github.com/chase-sets/chase-sets/issues/10671)
    (both pages are refused, so the smoke creates a raw card), and
    [chase-sets/chase-sets#10672 [platform-runtime] Inventory reads with a write's receipt time out for ~30 s while unrelated Inventory projections sit two positions behind](https://github.com/chase-sets/chase-sets/issues/10672)
    (after a sale the list cannot verify it for longer than the receipt is kept). Not ported: the
    item's page and imports. A card per item below 48rem, a table from 48rem, Create's two columns
    from 64rem, and the honor confirmation shown with `:has`
    ([`inventory_list.rs`](marketplace/src/inventory_list.rs),
    [`inventory_page.rs`](marketplace/src/views/inventory_page.rs)).

58. **The inventory item page is the pilot's; Open and Create inventory item land on it.**
    Marketplace's item page (`account-inventory-item.tsx`, `InventoryItemDetailPage`) keeps its
    three writes' recovery in React. The pilot's are `WriteForm`s of the families `item-adjust`,
    `hold-create` (target: the item, as marketplace's form names it) and `hold-release` (target:
    the hold), confirmed on the page after an applied write and drawn again with what is wrong
    after a refused one (422, only that form as a patch with a script). Record sale is the list's
    form (`SaleForm`, which now takes `autofocus`: on in the dialog, off on the page) posting to the
    item's own `/sale`, and its outcome is drawn on the item page from the address, as on the list.
    An adjustment the API records as a collision with orders' holds (`hold-collision-recorded`)
    changes nothing on hand; the page says the API's words and confirms the attempt. The ledger
    filter is a link per kind the ledger has (`?ledgerKind=`), `aria-current` on the one shown.
    The list's Open and a create without `returnTo` now go to this page (a create with `returnTo`
    still goes back to marketplace's Create listing). Marketplace's ledger shows an offline sale's
    raw kind; the pilot says "Sold offline"
    ([chase-sets/chase-sets#10673 [inventory] The item page's Stock Ledger labels an offline sale with the raw code offline-sale](https://github.com/chase-sets/chase-sets/issues/10673)).
    The page draws the API's ledger as it is, so each offline sale shows twice
    ([chase-sets/chase-sets#10675 [inventory] Recording an offline sale writes two stock-ledger movements, so the ledger no longer sums to on hand](https://github.com/chase-sets/chase-sets/issues/10675));
    hiding one would put Inventory's rule in the web layer. A fix the tests found: a signed-out
    visitor sent to sign-in from a page now comes back to that page with its query
    (marketplace's `buildCurrentPath`); before, the path was cut to its first three segments, which
    lost an item's id. A write still comes back to its screen
    ([`auth.rs`](marketplace/src/auth.rs),
    [`inventory_item.rs`](marketplace/src/inventory_item.rs),
    [`inventory_item_page.rs`](marketplace/src/views/inventory_item_page.rs)).

59. **The Seller Desk draws the API's queue in its own words, and one link per row that works.**
    Marketplace's Desk (`seller-desk.tsx`) reads the queue, the listings and the order capacity and
    keeps the queue's summary a key with parameters (`marketplace.features.sellerDesk.*`,
    `channels.manualSync.attention.*` and `channels.attention.reason.*`), so the pilot exports those
    words (`locales/desk.en.json`) and draws each summary with `t.by_key`, a channel action's
    summary composed from its reason as marketplace does. The three reads run in parallel; the
    listings' tiles read `limit=1`, since only the account's `statusCounts` are drawn (the full
    page is about 380 KB), and marketplace's offers read is not made, since the Desk does not draw
    it. A queue the API cannot read is an error that says so (never an empty desk), a failed tile
    read is Unavailable, and a 401 from any read goes to sign-in. The degraded banner names the
    sources only; their reasons are the API's internal words
    ([chase-sets/chase-sets#8766 Show every seller attention source in the Desk Needs you queue](https://github.com/chase-sets/chase-sets/issues/8766), which is why
    the sandbox's queue shows only its channel source). A listing's, shipment's or sale's deep link
    is a Seller Desk address marketplace does not serve ([chase-sets/chase-sets#10676 [marketplace] Seller Desk queue rows for listings, shipments and sales link to /account/desk/... routes that do not exist](https://github.com/chase-sets/chase-sets/issues/10676)); the pilot's `link` sends each
    to the page that has it (`/account/listings/{id}`, `/account/sales/shipments/{id}`,
    `/account/sales/{id}`); remove it once the API's links land. The nav's Seller Desk now links the
    pilot's page. The pages' primary buttons had drawn dark text on indigo: eight stylesheets used
    `--color-primary-contrast`, which the design system's tokens do not define (they have
    `--color-primary-foreground`, and `--color-danger-contrast` for a danger button), and nothing
    said so ([todd-skelton/corten#179 A stylesheet can use a token the theme does not define (var(--color-primary-contrast)), and nothing reports it until a browser draws the wrong color](https://github.com/todd-skelton/corten/issues/179)). They use the defined tokens now. Since the `1b00742` pin Corten's `App::router` refuses to start
    on a `var()` without a fallback that no stylesheet on its pages declares, naming the file (the
    pilot's `scripts/check-tokens.mjs` did this in CI until then), and the Desk's smoke checks a
    button-like link's contrast
    ([`desk.rs`](marketplace/src/desk.rs),
    [`desk_page.rs`](marketplace/src/views/desk_page.rs)).

60. **The repricing editor lives at its own address, compiles on the server, and activates only
    what it previewed.** Marketplace's Repricing page keeps the editor in client state and compiles a
    preset to Pricing's rule body in the browser (`repricing-presets.ts`, by the catalog in
    [chase-sets/chase-sets#7905 Decision: the plain-language repricing preset catalog and the complete AST each preset compiles to](https://github.com/chase-sets/chase-sets/issues/7905)). The pilot keeps
    every choice in the query (`repricing::Place`), so a reload, a link or a browser without a
    script lands on the same editor, and compiles on the server (`Editor::compile`, unit-tested
    against the decision's compiled example). That copies Pricing's rule into a second client, so
    [chase-sets/chase-sets#10682 [pricing] Compile Repricing Presets in the Pricing API now that a second client authors policies from them](https://github.com/chase-sets/chase-sets/issues/10682) asks
    Pricing to own it; remove `Editor::compile` once it lands. Preview starts a dry run and the page
    follows it through Pricing's own events: `/account/desk/repricing/dry-runs/{id}/live` relays
    each `status` event as the run's part, read again, and ends after the finished one; without a
    script the page reloads. Activate is accepted only for a completed, unused dry run whose body is
    exactly the editor's compiled body (without the name), so what is turned on is what the seller
    saw; any change after the preview says the settings changed and turns Activate off. The halt is
    a switch whose dialog asks first, and the page reads with `pricing.view` and writes with
    `pricing.manage`. The editor is a GET form whose Apply the page's script presses on a changed
    choice, with Preview and Activate `formmethod="post"`. Until the `aaef56f` pin it was the other
    way round (a POST form with a GET Apply, a full load per choice in Chromium), since Corten's
    runtime sent a POST button in a GET form as a GET with no fields
    ([todd-skelton/corten#190 In Chromium, a POST submit button in a GET form is sent as a GET with no fields: the runtime reads the method from NavigateEvent.formData](https://github.com/todd-skelton/corten/issues/190))
    ([`repricing.rs`](marketplace/src/repricing.rs),
    [`repricing_page.rs`](marketplace/src/views/repricing_page.rs)).

61. **The buy checkout reads its quote from Payments, never submits itself, and leaves the
    payment step to marketplace.** Marketplace's loader quotes the checkout fee in the web host from
    the compiled default policy; the pilot asks Payments (`/account/checkout/preview-status`) for
    the session's total, the wallet's balance and the method on screen, the same answer Payments
    gives Pay now, so the page cannot show a fee Payments would refuse
    ([chase-sets/chase-sets#10683 [checkout] Read the checkout fee quote from Payments instead of quoting the compiled default policy in the web loader](https://github.com/chase-sets/chase-sets/issues/10683)
    asks marketplace to do the same). Pay now is a button the buyer presses, never the page: marketplace's submits it on load
    ([chase-sets/chase-sets#10685 [checkout] Opening a ready checkout page confirms it: the page submits Pay now by itself on load](https://github.com/chase-sets/chase-sets/issues/10685)). With a script a
    changed field marks the totals stale (`data-stale`), hides Pay now and offers Update totals;
    without one Update totals is always offered and Pay now writes the review again first when it
    changed (the reviewed option, the address's signature, the quoted method). The signature is the
    normalized fields as a JSON array, which an attribute can carry, where marketplace joins them
    with a control character. After Checkout's confirm starts a payment the page says so and links
    to marketplace's payment page: the secure step (Stripe's Payment Element, a third-party script
    and frame) is not ported, and the sandbox has no Stripe key to test it against. A purchase
    intent's checkout, a guest's and a submitted offer go to marketplace's pages
    ([`checkout.rs`](marketplace/src/checkout.rs),
    [`checkout_page.rs`](marketplace/src/views/checkout_page.rs)).

62. **The pilot signs in itself, and every pilot page that needs a session signs in here.** Marketplace's
    sign-in (`/sign-in`, its magic link's `/sign-in/magic`, `/account/select` and `/sign-out`) is
    an address-first page whose identifier step is client state; without a script it is a GET to the
    same page, and the pilot's is that GET for everyone: the email or phone is the address
    (`signInIdentifier`), each method a link (`signInMethod`), each action a form, and no script.
    Password, magic link and phone code sign in on the pilot (the code's form shows once a code is
    sent, where marketplace shows it before); a passkey needs WebAuthn in the browser and a social
    sign-in comes back to marketplace, so both link to marketplace's page with the same identifier.
    The session is marketplace's cookie (HttpOnly, SameSite=Lax, Secure on https, Max-Age to the
    session's expiry), and the browser goes back to `returnTo` on the pilot when it serves the path
    and on marketplace otherwise: `Req::serves` says whether the pilot routes the path with a `GET`
    (until the `dfaaa90` pin the pilot kept its areas' prefixes, [todd-skelton/corten#203 An app cannot ask whether it routes a path, so a sign-in's return address is checked against a hand-kept list of prefixes](https://github.com/todd-skelton/corten/issues/203)). A token a cookie
    cannot carry is a 502 through `SetCookie::try_new` (before, the pilot checked it itself,
    [todd-skelton/corten#204 SetCookie::new panics on a value it cannot carry, so a token from another service can turn a sign-in into a 500](https://github.com/todd-skelton/corten/issues/204)). The return address is a `corten::Local`, which refuses a backslash, which
    marketplace's check lets through to another site ([chase-sets/chase-sets#10687 [auth] A return address or magic-link path starting with /\ passes Auth's same-site check and leads to another site after sign-in](https://github.com/chase-sets/chase-sets/issues/10687)); every Auth call forwards the
    browser's address, which marketplace's does not ([chase-sets/chase-sets#10686 [auth] Password sign-in failures through the web hosts share one IP bucket: five wrong passwords lock everyone out for five minutes](https://github.com/chase-sets/chase-sets/issues/10686)); and a password sign-in is retried
    only when the API never received it (marketplace also retries after a reset or a timeout, which
    could count a wrong password twice). Every `sign_in_at` and `Refused::sign_in` in the pilot now
    points at the pilot's own sign-in
    ([`sign_in.rs`](marketplace/src/sign_in.rs),
    [`sign_in_page.rs`](marketplace/src/views/sign_in_page.rs)).
63. **The account's own page is the pilot's, and so is every sign-in with nowhere else to go.**
    Identity's marketplace `account` route is `/account`, the prefix of every other account screen.
    It is a routes module of its own with an `AccountOwner` caller (`accounts.view` to read,
    `accounts.manage` to write). (Until the `dfaaa90` pin, the pilot's own `serves` named its path
    rather than listing it in `AREAS`, which would have claimed every `/account/..` path
    marketplace still serves; `Req::serves` now asks the router.) Its components are in
    `App::components`: an `/account` area's stylesheet would be linked by every nested account area
    ([todd-skelton/corten#239 A page whose path is the prefix of other areas (/account above /account/cart) cannot have a stylesheet only it links](https://github.com/todd-skelton/corten/issues/239)).
    Update Profile is the same Identity account-management attempt as the shipping addresses'
    writes: `AddressAction` and `AddressAnswer` are now `AccountAction` (with `UpdateProfile`) and
    `AccountAnswer`, and the page reuses the addresses' `Said`. The body is the text as typed, as
    marketplace sends it; Identity trims it. Both names carry `pattern=".*\S.*"` because Identity
    takes a blank name
    ([chase-sets/chase-sets#10688 [identity] A profile update accepts a blank legal or marketplace name, so an account's name can be saved empty](https://github.com/chase-sets/chase-sets/issues/10688));
    the pattern goes once Identity refuses one. A read still catching up after a write is read again
    without the receipt and then drawn from who is signed in (marketplace's
    `buildActorAccountFallback`), as marketplace does, but the pilot says so and reads itself again
    where marketplace shows the older values as current. The shipping addresses' Back to account and
    Create listing's View account now open this page, and a sign-in with no return address (or an
    unsafe one) lands here rather than on marketplace
    ([`account_home.rs`](marketplace/src/account_home.rs),
    [`account_home_page.rs`](marketplace/src/views/account_home_page.rs)).
64. **The security page answers a new key's secret itself, once, and every write posts to the page.**
    Identity's marketplace `account-security` route is an area at `/account/security` with a
    `SecurityOwner` caller (`security.manage` for reading and every write, as Identity's loader and
    action). Its four writes are account-management attempts like the addresses' (`AccountAction`
    gains `UpdateUser`, `CreateApiKey`, `RotateApiKey` and `RevokeApiKey`), chosen by the form's
    `intent` as marketplace's action does. A create or rotate is answered with the key's secret,
    which the API keeps only as a hash and never returns from its attempt lookup, so the page draws
    that POST's answer itself, with `Cache-Control: no-store` (`NoStore`), instead of redirecting to
    an address that would have to carry the secret. Marketplace holds the secret in React state; the
    pilot holds it in nothing but that one response. Because every form posts to `/account/security`,
    a reload sends the same attempt again, the API answers it as recorded before, and the page says
    the secret cannot be shown again (Identity's `committed-secret-unrecoverable`); "I have stored this
    secret" is a link to the page. The secret is read only from a newly committed create or rotate,
    at most 200 characters, with the key's id, as marketplace's `clientResult` checks; a lookup that
    carries one is ambiguous. `KeySecret`'s `Debug` never prints it. A page showing a secret never
    reads itself again (`ReadAgain` would lose it); it says to reload once the secret is stored. A
    profile update or a revoke redirects to the page read after its write. Copy is the page's own
    script, as the packing page's
    ([todd-skelton/corten#244 corten-ui has no copy-to-clipboard control, so each app ships its own script for Copy](https://github.com/todd-skelton/corten/issues/244)),
    shown only when it runs. Revoke's dialog opens with `command="show-modal"`, without a script too.
    The key list is filtered to the user's own keys, since Identity's is not
    ([chase-sets/chase-sets#10695 [identity] A user's API key list shows other users' keys whose name or owner mentions the user's id, with the owner's email](https://github.com/chase-sets/chase-sets/issues/10695)),
    and the display name and a key's name carry `pattern=".*\S.*"` as the account page's names do
    ([`security.rs`](marketplace/src/security.rs),
    [`security_page.rs`](marketplace/src/views/security_page.rs)).
65. **The sessions are the pilot's, and say what Auth did when Auth will not.** Auth's marketplace
    `account-sessions` routes are an area at `/account/sessions` with a `SecurityOwner` caller:
    Auth guards every session call with `security.manage`, and marketplace's routes ask only for a
    signed-in user and let the API refuse. The list sends its status filter and page to Auth, which
    marketplace's loader does not
    ([chase-sets/chase-sets#10699 [auth] Marketplace's sessions page ignores its status filter, search and pages, always showing the first 50](https://github.com/chase-sets/chase-sets/issues/10699)),
    and has no Search, which Auth replaces with the user's id; it keeps only the user's own sessions
    ([chase-sets/chase-sets#10697 [auth] A user's session list shows other users' sessions whose name, email or account mentions the user's id](https://github.com/chase-sets/chase-sets/issues/10697)).
    Revoke and Switch Account are not attempts (Auth takes no `Idempotency-Key` for them), and Auth
    answers every refusal with a 500
    ([chase-sets/chase-sets#10698 [auth] Session switch-account and revoke answer 500 for every refusal, so marketplace's Switch Account always fails for a one-account user](https://github.com/chase-sets/chase-sets/issues/10698)),
    so after a write that did not succeed the page reads the session again and says what it finds
    (no longer active, already on that account, or unchanged) instead of an error page. That re-read
    has no receipt to wait for, so right after another write it can still show the session as it
    was (the smoke saw a revoke sent again within a second say it could not be confirmed); a success
    redirects to the session read after its receipt. Switch Account offers only the session's other
    accounts and is not drawn when there are none. The breadcrumb goes back to this list
    ([chase-sets/chase-sets#10700 [auth] Marketplace's session page links its Sessions breadcrumb to admin's /access/sessions, a page not found](https://github.com/chase-sets/chase-sets/issues/10700)).
    The port also made the top bar link every entry the pilot serves to the pilot (item 9 above)
    ([`sessions.rs`](marketplace/src/sessions.rs),
    [`sessions_page.rs`](marketplace/src/views/sessions_page.rs)).

66. **A scope's page is the pilot's, and derives what the Catalog API does not answer yet.** The
    scope is the page's one required read; its coverage, its candidate review jobs and (with more
    than one language edition) the alias review of its Reference Record are read beside it, and a
    failed one is a banner in its own section, as admin-web's loader degrades them. Each edition's
    link state and the journey's condition and stages are derived in admin-web's web layer, so the
    pilot repeats them in `scope.rs` until the Catalog API returns them
    ([chase-sets/chase-sets#10703 [catalog] Return a scope's language-edition link states and journey from the Catalog API instead of deriving them in admin-web](https://github.com/chase-sets/chase-sets/issues/10703));
    promotion and sync are the scopes list's. The import-to-promotion workspace is composed in
    admin-web's server
    ([chase-sets/chase-sets#10507 [catalog] Compose the Catalog integrations surfaces in the Catalog API](https://github.com/chase-sets/chase-sets/issues/10507)),
    so its section links to admin-web's page. Every write is a plain form: a reject or revoke's
    reason folds open under its button (`<details>`), Propose mapping is a dialog drawn open with
    what was typed when it comes back, and a refusal is the page again (422) with the API's message.
    An alias candidate's toast says what was done; admin-web says "Command queued" for every one,
    and its Defer writes nothing
    ([chase-sets/chase-sets#10702 [catalog] Scope Detail's alias Accept, Reject, Revoke and Defer each say "Command queued", and Defer writes nothing](https://github.com/chase-sets/chase-sets/issues/10702)),
    so the pilot's Defer sends nothing and says the candidate stays pending. Confirm canonical record
    publishes the Reference Record by the scope's id, as admin-web does; every sandbox scope's two ids
    are the same. The sandbox has no scope with more than one edition, so the editions section is
    tested only against the stand-in API, and no coverage write was made on the sandbox
    ([`scope.rs`](admin/src/catalog/scope.rs),
    [`scope_page.rs`](admin/src/catalog/views/scope_page.rs)).

67. **The team is the pilot's, and keeps only the account's own people.** Identity's marketplace
    `account-team` route is `/account/team` with a `TeamOwner` caller (`memberships.view`; a write
    also needs `memberships.manage`). The lists are Identity's memberships and invitations searched
    by the account's id, which also finds other accounts' rows whose names or emails mention it
    ([chase-sets/chase-sets#10704 [identity] An account's team lists other accounts' memberships and invitations whose names or emails mention the account's id](https://github.com/chase-sets/chase-sets/issues/10704)),
    so the pilot keeps only the rows whose account is this one. Every write is an account attempt
    as the shipping addresses' are (decision 63's pattern): the form's `SubmitKey` is the
    `Idempotency-Key`, a lost answer is looked up, and while it is unknown the page says so and the
    write it would repeat is off. Invite gives each send a new `ivt_` id (the API keeps the
    attempt's first) and a seven-day expiry, as marketplace's does; only a create the API says this
    call committed asks Auth for the acceptance link, after the invitation's receipt, with the
    browser's address as `X-Forwarded-For` for Auth's limit, so a replay or a create found by the
    lookup is not emailed twice. A refused invite is drawn again with what was typed; any other
    refusal (the last owner, an out-of-date form) is the banner with its own words. The nav names no
    team entry, so only the notifications' links were pointed here. The smoke sends no invitation:
    the sandbox's email path for it is untested
    ([`team.rs`](marketplace/src/team.rs),
    [`team_page.rs`](marketplace/src/views/team_page.rs)).

68. **The consent history is the pilot's, and keeps only the user's own consents.** Identity's
    marketplace `account-consents` route is `/account/consents` with a `ConsentHolder` caller:
    marketplace's loader and action ask only for a signed-in actor and leave the rest to the API.
    The list sends the user's and the account's ids, as marketplace's loader does, but Identity
    takes them from the query for an actor with `security.manage`, which every self-registered
    owner holds
    ([chase-sets/chase-sets#10707 [identity] A security.manage owner can list another user's or account's consents by naming its ids, or every consent by naming neither](https://github.com/chase-sets/chase-sets/issues/10707)),
    so the pilot keeps only consents withdraw's own rule (`subjectMatchesActor`) would let the
    user withdraw (`Consent::is_of`). Withdraw is an account attempt as the team's writes are
    (decision 67), behind a dialog, on a recorded and current consent only. A policy or status the
    page does not know is Identity's "Unrecognized" words, a version that is not a token is
    "Version unavailable", as `consentVersionLabel` writes them. Marketplace's page draws only its
    title when there are no consents; the pilot says so in its own words (`consents.none`). The
    sandbox records no consents, so the cards and Withdraw are tested only against the stand-in API,
    and the smoke checks the empty page
    ([`consents.rs`](marketplace/src/consents.rs),
    [`consents_page.rs`](marketplace/src/views/consents_page.rs)).

69. **The account's reviews are the pilot's.** Reputation's
    marketplace `account-review-summary`, `account-received-reviews` and `account-written-reviews`
    routes are three pages in one area with a `ReviewMember` caller (`reputation.view` to read,
    `reputation.manage` to report, as their loaders and action ask). Report review posts to the page
    it is on, as marketplace's form action does, and reuses the public account page's reasons,
    limit and notices (`accounts.rs`): a sent report redirects back to the review
    (`?reported={id}#review-anchor-{id}`) saying it was received, where marketplace redraws the
    page from its action; a refused one is the page again with that review's dialog open. A list
    keeps marketplace's stand-in words for a withdrawn, paused or pending review, and its role in
    the address. Open review goes to the review's own page (decision 70). The
    summary's reply shows when the reply is active, as marketplace's does; a list's only while the
    review may also be reported (`ReviewItem::reply`). The view copies the account page's rating,
    scoring and Report review parts rather than sharing them, because they read a different
    catalog and API type
    ([`reviews.rs`](marketplace/src/reviews.rs),
    [`reviews_page.rs`](marketplace/src/views/reviews_page.rs)).

70. **A review's own page is the pilot's, and a reply keeps its words until Reputation takes them.**
    Reputation's `account-review` route is `/account/reviews/{id}` in the reviews' area. Report review
    and Respond to this review post to the page by `intent`, as marketplace's action does, and Report
    review shares the lists' checks and refusals (`reviews::send_report`). The reply is offered as
    marketplace's `canComposeReply` allows (the account reviewed, once, an active, revealed review
    not held), sent as typed after two checks of its own (not blank, at most 1,000 characters), and
    read after its receipt; while Reputation has not caught up the page is
    `ReviewDetailRecoveryPage`'s words and reads itself again. A refused reply is the page again with
    its words: a closed authoring code (`authoredTextRecoveryCopy`) is the recovery summary with a
    link to the field (none for a rate limit), any other refusal the API's words, and a failed API
    "Response could not be posted." with a 502. The link to the field needs an in-page `#id`, which
    Corten cannot write from an `Id` yet
    ([todd-skelton/corten#254 A link to an element on the same page cannot take an Id, so each app writes its #fragment by hand](https://github.com/todd-skelton/corten/issues/254)):
    `views::fragment` does it for this page and the seller listing page
    ([`review.rs`](marketplace/src/review.rs),
    [`reviews_page.rs`](marketplace/src/views/reviews_page.rs)).

71. **Projection Operations is the pilot's, and a record's sheet is in the address.**
    admin-web's `projections` route is `/platform/projections` in the platform section, an area
    with its own stylesheet and admin-web's caller (`projection-operations.view`). The console draws
    what the API derived (`deriveProjectionTriage`): its attention items with the wake read's, the
    repair queue in its order, and the worker counts; the page computes only admin-web's console
    status, its eight counts and the filters (`matchesProjectionFilters`, on the server, a `GET`
    form). The wake read is optional, as admin-web's: a failed one leaves its items out. A record's
    details are `?selected=` (admin-web's `projectionSelectionHref`), drawn as an open `<dialog>`
    closed by a link, made modal by its script, with the repairs the viewer may make: Cancel and
    Retry for `.operate`, Rebuild and Rebuild context for `.rebuild`, each confirm a
    `command="show-modal"` dialog. Each repair is its own route that posts to the API and goes back
    to the console as it was (admin-web's `formActionRedirect` to the current path); a refusal is
    the error page with the API's status, as admin-web throws it. The live part follows each queued
    or running operation's status stream (`platform::jobs`, as the catalog's bulk jobs) and draws
    the health, the queue and the operations again from a fresh read when one changes state, as
    admin-web revalidates (`onOperationTerminal`); it ends when they are all done. Two gaps:
    the API sends blocked projections as counts only, so neither the repair queue nor Operations
    Attention lists a blocked stream or a poison event
    ([chase-sets/chase-sets#10710 [platform-operations] List each blocked projection's streams and poison events in the projections read (the repair queue and Operations Attention show none)](https://github.com/chase-sets/chase-sets/issues/10710)):
    a group's sheet reads its projections' details (`GET /{projectionKey}/blocked-streams`) and
    links each one, so Retry is reachable. And Escape on a sheet the address opened must follow its
    close link, which corten-ui's `dialog::modal` does not
    ([todd-skelton/corten#257 corten-ui's dialog::modal closes a dialog the address opened without following its close link, so Escape leaves ?selected= behind](https://github.com/todd-skelton/corten/issues/257)):
    the sheet's own script does, a second copy of the postage sheet's. Not ported: the
    reference page (`/platform/projections/reference`), which the console links to on admin-web
    ([`projections`](admin/src/projections/mod.rs),
    [`console_page.rs`](admin/src/projections/views/console_page.rs),
    [`detail_sheet.rs`](admin/src/projections/views/detail_sheet.rs)).

72. **The Seller Desk's money page is the pilot's, and it previews a payout before it asks
    for one.** Settlement's `account-desk-money` route is `/account/desk/money` in an area of its
    own, behind a `PayoutViewer` (`payouts.view`); each write also checks its own permission, as
    marketplace's action does (`payouts.request` for Preview, Edit and Confirm, `payouts.reconcile`
    for Retry and Check status). The page reads Settlement's six reads at once (the wallet, its
    movements, the payouts, payout readiness, the policy's quick amounts and an adjustment the
    address names), and any failure is the page's error, as marketplace's `Promise.all` is. Every
    write posts to the page by `intent`. Preview, Edit, Retry and Check status draw the page with
    what they did, as marketplace's action data does; a refused preview keeps the typed amount, which
    marketplace's drops. A typed amount is read with `t.parse_money` (`$1,299.50`), a quick amount is
    sent as Settlement's `amountSelection`, and Confirm sends the amount the preview returned. Confirm
    sends the form's `SubmitKey` as the `Idempotency-Key` (marketplace sends none), answers a lost
    answer with a 502 so the resend is the same payout, and goes to the payout's page on marketplace,
    read after it. Three rules are Settlement's but live in marketplace's web layer: when the next
    payout arrives (3 business days), which payouts are blocked (failed, 15 minutes without an
    update, in transit with no provider reference) and whether a payout can be requested
    ([chase-sets/chase-sets#10712 [settlement] Answer the money dashboard's next payout, blocked payouts and payout availability from the Settlement API](https://github.com/chase-sets/chase-sets/issues/10712)):
    the pilot copies them as written (`next_payout`, `blocked`, `can_request`, `unavailable`).
    A payout's breakdown is a `command="show-modal"` dialog; a wallet adjustment's is the address's
    (`?drawer=wallet-adjustment&entity=`), drawn open and closed by a link, so Escape leaves the
    address as it was
    ([todd-skelton/corten#257 corten-ui's dialog::modal closes a dialog the address opened without following its close link, so Escape leaves ?selected= behind](https://github.com/todd-skelton/corten/issues/257)),
    as the inventory list's Record sale does; no script is copied for it. The page sends no Stripe
    Connect CSP: nothing on it embeds Stripe. Not ported: the payout's page
    (`/account/desk/payouts/{id}`), payout setup (`/account/desk/settings`) and support, which stay
    marketplace's
    ([`money.rs`](marketplace/src/money.rs),
    [`money_page.rs`](marketplace/src/views/money_page.rs)).

73. **A Support Request's participant page is the pilot's, and every write on it is one attempt
    the API can be asked about.** Platform Operations' `account-support-detail` route is
    `/account/support/{id}` in an area of its own, behind a `SupportMember` (`support.view` to read,
    `support.manage` to write, as marketplace's loader and action require); anyone but the case's
    buyer or seller gets Not found. The page shows who acts next with the deadline's countdown, the
    overview, the evidence prompts, the offer, the seller's response and Request support review,
    Cancel case, the resolution and the timeline. Which party acts next, the deadline in effect and
    which forms the viewer gets are Platform Operations' rules in marketplace's web layer
    ([chase-sets/chase-sets#10715 [platform-operations] Return who acts next on a Support Request, the deadline in effect and the participant's actions from its detail read](https://github.com/chase-sets/chase-sets/issues/10715)):
    the pilot copies them as written (`next_actor`, `deadline`, `offer_outcome`, `screen`). Every
    write is a participant attempt: the form's `SubmitKey` is its `Idempotency-Key` (a post without
    one draws one), and the canonical request (`{version, actionKind, payload}`, keys in the web
    host's order) is hashed into `X-Support-Request-Hash`; unit tests pin the hash against the web
    host's function run with tsx. A 400 or 403 applied nothing, so the page says why (the API's words
    where it gives them; marketplace always says "not sent") and keeps what was typed. Any other
    failure is looked up once; committed goes on to the page with its receipt, anything else is
    ambiguous: Check status, with every form's fieldset off. Check status only looks up, and a lookup
    that finds nothing stays ambiguous, as marketplace's does. The role a write is submitted as is
    the viewer's, read before the write (marketplace's is a hidden field), a response's offer outcome
    is derived from its type, and Request support review's reason and a declined offer's summary are
    the catalog's words. A partial refund's amount is shown by CSS `:has` and checked by the handler,
    since `required` cannot follow another field without a script
    ([todd-skelton/corten#269 A field required only for one choice of another field needs a script, so the browser cannot check it before the form is sent](https://github.com/todd-skelton/corten/issues/269)).
    The timeline is sorted by the moment, not as text (marketplace's text sort puts the read model's
    `2026-10-28 13:05` before an event's `2026-10-28T09:00`). No script. Not ported: the list of
    cases with opening a case and its photo uploads (`/account/support`), which stays marketplace's
    ([`support.rs`](marketplace/src/support.rs),
    [`support_page.rs`](marketplace/src/views/support_page.rs)).

## Corten gaps

Closed at the `1f7d68b` pin and adopted: [todd-skelton/corten#208 Money typed into a form is parsed by each app, three different ways, and card-market reads it as f64](https://github.com/todd-skelton/corten/issues/208) (`t.parse_money`; the pilot's own reading of a typed price is gone) and [todd-skelton/corten#235 A Public answer that sets a cookie compiles, and is only made private when it is sent](https://github.com/todd-skelton/corten/issues/235) (public-web's pages are made for everyone, checked when they compile).

Open at the `1f7d68b` pin, found by the Support Request page's port (decision 73): [todd-skelton/corten#269 A field required only for one choice of another field needs a script, so the browser cannot check it before the form is sent](https://github.com/todd-skelton/corten/issues/269), worked around by `:has` for the partial refund's amount and a check in `support.rs`.

Open at the `1f7d68b` pin, found by Projection Operations' port (decision 71): [todd-skelton/corten#257 corten-ui's dialog::modal closes a dialog the address opened without following its close link, so Escape leaves ?selected= behind](https://github.com/todd-skelton/corten/issues/257), worked around by two copies of one script (`views/policy_sheet.js` and `projections/views/detail_sheet.js`).

Open at the `1f7d68b` pin, found by the review page's port (decision 70): [todd-skelton/corten#254 A link to an element on the same page cannot take an Id, so each app writes its #fragment by hand](https://github.com/todd-skelton/corten/issues/254), worked around by `views::fragment`.

Open at the `1f7d68b` pin (as at `dfaaa90`), found by the security page's port (decision 64): [todd-skelton/corten#244 corten-ui has no copy-to-clipboard control, so each app ships its own script for Copy](https://github.com/todd-skelton/corten/issues/244), worked around by two identical scripts (`views/packing.js` and `views/security.js`). Also learned, not filed: `#[derive(Id)]` names are unique across the app, so a second `ProfileFormId` on another page fails to link (`cargo check` passes; `corten check` catches it), and the page's stylesheet check refused an undeclared `--color-primary-contrast` before the page ever loaded.

Closed since the `aaef56f` pin, at `dfaaa90`: [todd-skelton/corten#203 An app cannot ask whether it routes a path, so a sign-in's return address is checked against a hand-kept list of prefixes](https://github.com/todd-skelton/corten/issues/203), its workaround (`AREAS` and `serves` in `app.rs`) removed for `Local::parse` and `Req::serves`; [todd-skelton/corten#204 SetCookie::new panics on a value it cannot carry, so a token from another service can turn a sign-in into a 500](https://github.com/todd-skelton/corten/issues/204), its workaround (`cookie_value` in `sign_in.rs`) removed for `SetCookie::try_new` (`a_token_a_cookie_cannot_carry_is_the_apis_mistake_not_a_panic` checks the 502); and [todd-skelton/corten#239 A page whose path is the prefix of other areas (/account above /account/cart) cannot have a stylesheet only it links](https://github.com/todd-skelton/corten/issues/239), closed by the styles guide naming the pilot's answer: `views::ACCOUNT_HOME` stays in `App::components` (373 B brotli more in `components.css`, measured).

Closed since the `1b00742` pin, at `aaef56f`: [todd-skelton/corten#190 In Chromium, a POST submit button in a GET form is sent as a GET with no fields: the runtime reads the method from NavigateEvent.formData](https://github.com/todd-skelton/corten/issues/190), found by the repricing desk's port, fixed by [todd-skelton/corten#193 A submit button's formmethod decides how a navigating form goes, in Chromium too](https://github.com/todd-skelton/corten/pull/193); its workaround (the editor a POST form with a `formmethod="get"` Apply) removed.

Closed since the `3375815` pin, at `1b00742`: [todd-skelton/corten#179 A stylesheet can use a token the theme does not define (var(--color-primary-contrast)), and nothing reports it until a browser draws the wrong color](https://github.com/todd-skelton/corten/issues/179), fixed by [todd-skelton/corten#185 A var() no stylesheet on its pages declares fails at startup and names the file](https://github.com/todd-skelton/corten/pull/185); its workaround (`scripts/check-tokens.mjs` and its CI step) removed, since `corten check` and every test that builds the router now fail on such a `var()`.

Closed since the `af0019f` pin, at `3375815`: [todd-skelton/corten#149 A handler cannot know the visitor's time zone, so a picked date needs a script to become an instant and every date is written in UTC](https://github.com/todd-skelton/corten/issues/149), its workaround (the page's script writing each picked day's instant, and an away window refused without it) removed for `Option<ClientZone>` in `seller_listings::write` (decision 54).

Closed since the `06821f8` pin, at `af7d7cb`: [todd-skelton/corten#152 An area with no page at its prefix (/items, /sets) must declare the prefix as a link-only route outside its routes module](https://github.com/todd-skelton/corten/issues/152), its workaround (the seven prefix structs declared outside their routes modules) removed for a prefix route with no handler inside each module; and [todd-skelton/corten#117 A route cannot be a WebSocket or pass an upstream response through, so such routes are added outside Corten's checks](https://github.com/todd-skelton/corten/issues/117), for which the pilot had no workaround; and [todd-skelton/corten#157 A page that names a script! module the app does not serve renders fine; only the browser finds the 404, and its handlers silently do nothing](https://github.com/todd-skelton/corten/issues/157), which had none to remove: a debug build now answers 500 for a page whose handlers call a module its area does not list, and the router tests pass at this pin (unlisting `submitted_offers_page::handlers` on purpose made its test fail with that 500).

Closed since the `9627ee2` pin, at `06821f8`: [todd-skelton/corten#147 A field with its own hint cannot also point at its error: Within::aria writes a second aria-describedby, which the browser drops](https://github.com/todd-skelton/corten/issues/147), its workaround (`PhotosPart`'s hand-built `aria-describedby`) removed for `e.aria(..).hint(..)`.

Closed since the `132c136` pin, at `9627ee2`: [todd-skelton/corten#150 A handler cannot read an Error's status, so an upload over Upload::limit (413) cannot draw the form again with a message](https://github.com/todd-skelton/corten/issues/150), its workaround (the `Content-Length` precheck in `uploads::read`) removed for `UploadError::TooLarge`.

Closed since the `12e0695` pin, at `132c136`: [todd-skelton/corten#130 Firefox sometimes loses the filter rail's own scroll after a data-keep-place swap (smoke: 76 -> 0)](https://github.com/todd-skelton/corten/issues/130). The pilot had no workaround for it.

Closed since the `76eda4f` pin, at `12e0695`: [todd-skelton/corten#140 A form cannot post a file: Form reads only URL-encoded bodies, so a multipart form is a 415 and nothing reads its files](https://github.com/todd-skelton/corten/issues/140), its workaround (multer) removed for `Upload<Raw>` in `uploads::read`.

Closed since the `07d7f65` pin, at `76eda4f`: [todd-skelton/corten#143 A patch drops the files chosen in a file input it replaces, so a refused upload cannot mark its input invalid](https://github.com/todd-skelton/corten/issues/143), its workaround (`PhotoErrorPart`) removed.

Closed since the `a12c78b` pin, at `07d7f65`: [todd-skelton/corten#120 A handler cannot read the client's address, so an app that calls an API for a visitor cannot pass it on for rate limiting](https://github.com/todd-skelton/corten/issues/120), its workaround (`platform::client`) removed for `ClientIp`.

Closed since the `2338bcb` pin, at `a12c78b`: [todd-skelton/corten#142 html! if let cannot take a struct pattern: the pattern's braces are read as the body](https://github.com/todd-skelton/corten/issues/142), its workaround (`Catalog::chosen()`) removed.

Closed since the `15dc546` pin, at `2338bcb`, and their workarounds removed:

1. [todd-skelton/corten#119 i18n writes no percentage, so a rate like 2.9% cannot be localized](https://github.com/todd-skelton/corten/issues/119): the home page writes `t.percent` (`home::rate`).
2. [todd-skelton/corten#123 An address outside the app cannot carry a #fragment, so req.moved and req.redirect drop the anchor of an external URL](https://github.com/todd-skelton/corten/issues/123): the share link moves with `corten::Elsewhere::at(&to, "fee-calculator")`; the hand-written `Location` is gone.

Closed since the `4bd06d3` pin: [todd-skelton/corten#131 A client navigation to a route that redirects to another origin is blocked by connect-src, then reloads](https://github.com/todd-skelton/corten/issues/131), fixed by Corten's `0e09fba` (a client navigation to a redirect elsewhere gets `corten-location` and the browser leaves in one request); the packing page's Back links the pilot's `/account/sales/shipments` again (decision 50). [todd-skelton/corten#114 App::deadline is one value for the whole app, so one slow route (an upstream call, an upload) lifts it for every page](https://github.com/todd-skelton/corten/issues/114) and [todd-skelton/corten#115 corten::serve takes no listener, so an app that needs TLS or its own socket loses the loopback pair, the stream drain and graceful shutdown](https://github.com/todd-skelton/corten/issues/115) closed too; the pilot had no workaround for either.

Closed since the `b35c934` pin, and their workarounds removed at `4bd06d3`:

1. [todd-skelton/corten#122 Client navigation between pages with different layouts keeps the first layout, because the shell key does not include the layout](https://github.com/todd-skelton/corten/issues/122), fixed by Corten's `4bd06d3` (a page in another layout has another shell key, so a client navigation to it loads it in full). The market page's breadcrumb Home and the error page's Go home no longer carry `data-reload`; a client navigation from a market page to `/` was checked to draw the home page's own layout (its promo bar, footer and headline).
2. [todd-skelton/corten#129 A query value must be Display while it is read with serde, so an enum in an address spells its words twice](https://github.com/todd-skelton/corten/issues/129), fixed by Corten's `811b274` (`#[derive(UrlValue)]` writes `Display` from the same `rename_all` and `rename` serde reads). The seven hand-written `Display` impls are gone: admin's `Done`, `ItemDone`, `AttentionDone` and `Change`, and marketplace's `recovery::Family`, `packing::Scanned` and `api::AddressAction` derive it.

Closed as not planned: [todd-skelton/corten#121 There is no way to keep an upstream read for a while across requests, so a page that every visitor opens reads the same data each time](https://github.com/todd-skelton/corten/issues/121). An in-process cache is the app's choice (its key, staleness and failures); Corten points to `moka::future::Cache` with `time_to_live` and `try_get_with`. The pilot keeps `public::kept::Kept` (a lock around the last good read and when it was read, in the app's state), which also serves the last good read when a new one fails, as the page needs (decision 49).

Since the `b35c934` pin, past `96ed39e` ([todd-skelton/corten#113 An app on loopback answers any Host, so a DNS-rebound page can read and write its routes](https://github.com/todd-skelton/corten/issues/113), breaking): an app answers only `localhost`, IP literals, no Host, and the names it lists, any other Host a 421 before routing. Local runs need nothing; any deployment under a domain must set `HOSTS` to the name its proxy sends. Also in it, `App::task` ([todd-skelton/corten#116 Work that lives as long as the app (a refresh loop, a supervised child) has no signal, so shutdown neither stops it nor waits for it](https://github.com/todd-skelton/corten/issues/116)) merged as `cf8ac0f`: `corten::serve` takes an `App` (an outer layer is `App::layer`) and `Abort` has a `Shutdown` variant. The pilot's three `main.rs` already call `corten::serve(app::app(..))` and match no `Abort`, so the pin needed only the hash.

Fixed at the `8cb28fb` pin ([todd-skelton/corten#110 Public::shared (s-maxage); a patch can ask to be read again (ReadAgain::from)](https://github.com/todd-skelton/corten/pull/110)), workarounds removed:

1. [todd-skelton/corten#104 A data-patch answer cannot ask to be read again, so a write whose read is catching up has to navigate](https://github.com/todd-skelton/corten/issues/104): an alert's write whose read has not caught up answers in place. The section says the change is saved and carries `ReadAgain { after: 2 s }.from(&to)`, `to` being the settings' address with the write's receipt; that address answers the section alone as a patch in `Mode::Action` (asking again while behind) and the page otherwise. The redirect is left for a browser without JavaScript. Since the `cf48958` pin a read that fails after the write, or while being read again, answers the section as a 502 patch saying the change was saved and a reload shows it (`notifications::unconfirmed`); signed out or forbidden still answers the page's, which stops the reads ([`notifications::change_alert`](marketplace/src/notifications.rs), decision 45). `smoke-market-notifications.mjs` now checks that the three alert writes navigate nowhere; on the sandbox the section was read again twice while the reads caught up.
2. [todd-skelton/corten#106 Public has no shared-cache lifetime (s-maxage) apart from the browser's, so a CDN cannot keep a page longer than a browser](https://github.com/todd-skelton/corten/issues/106): the market page is `Public::new(60 s).shared(ttl).stale_while_revalidate(3600 s)`, `ttl` being the `s-maxage` Pricing's own answer sets from the display policy's `publicPageCacheTtlSeconds` (a day by default, kept within the policy's minute to a week), so a revised policy reaches the page. public-web writes the default day as a literal. A not-found page or a failed read keeps the day ([`market.rs`](public/src/market.rs), decision 46).
3. [todd-skelton/corten#95 A page outside every area (the app's /) cannot link an area's stylesheet, so a screen that is also the home page ships its CSS on every page](https://github.com/todd-skelton/corten/issues/95), closed as not planned: Corten's measurement on the issue is that search's rules are about 2.2 KB brotli in the cached `components.css`, and a stylesheet for `/` alone would add a blocking request to the most visited page. Search's components are in `App::components` now (`views::SEARCH`), the home page's own `<link>` in its body is gone, and `corten dev` no longer reports the home page. Measured on the pilot's release build: a page outside search (the shipments list) now transfers 5,588 B of CSS where it transferred 4,081 B, once, since `components.css` is cached after the first page; the home page transfers 4,281 B of CSS in two stylesheets. The JavaScript is 8,767 B, 130 B more than at `0f3f03f`: the runtime reads a patch again.

Found in Chase Sets by the search port:

1. [chase-sets/chase-sets#10609 [discovery] Search answers 500 on the first request after a quiet minute](https://github.com/chase-sets/chase-sets/issues/10609). The pilot shows the error banner and answers 502; the smoke reads once before it starts.
2. [chase-sets/chase-sets#10610 [discovery] Search says No items found when the search read fails](https://github.com/chase-sets/chase-sets/issues/10610). Marketplace's behavior, not the pilot's: the pilot says the read failed.
3. [chase-sets/chase-sets#10612 [discovery] Answer an unknown set page with 404, and a failed set read with 5xx, not 200](https://github.com/chase-sets/chase-sets/issues/10612), found by the set page's port. The pilot answers 404 and 502; no workaround.
4. [chase-sets/chase-sets#10614 [discovery] Tell a visitor their listing report was received (the page ignores ?reported=1)](https://github.com/chase-sets/chase-sets/issues/10614), found by the listing page's port. The pilot says it was received; no workaround.
5. [chase-sets/chase-sets#10615 [discovery] A repeat listing report shows a 500 page instead of saying it was already reported](https://github.com/chase-sets/chase-sets/issues/10615), found the same way. The pilot answers 409 with the page saying so; no workaround.
6. [chase-sets/chase-sets#10619 [discovery] An unknown account page answers 200, and a failed account read reads as not found](https://github.com/chase-sets/chase-sets/issues/10619), found by the account page's port. The pilot answers 404 and 502; no workaround.
7. [chase-sets/chase-sets#10623 [discovery] The public account page has no h1: the account's name is an h2](https://github.com/chase-sets/chase-sets/issues/10623), found the same way. The pilot's name is the page's one `h1`; `smoke-market-account.mjs` checks it and prints marketplace's count.
8. [chase-sets/chase-sets#10624 [discovery] Product-alert links go through a retired notifications URL, so each visit takes two redirects](https://github.com/chase-sets/chase-sets/issues/10624), found by the notification center's port. The pilot's Manage alerts links straight to the settings at `#product-alerts`.
9. [chase-sets/chase-sets#10625 [notifications] Delivery settings show unlabeled 'sms' and 'rcs' switches for channels the platform does not deliver](https://github.com/chase-sets/chase-sets/issues/10625), found the same way. The pilot lists only the channels it has words for (`notifications::CHANNELS`); the smoke checks there are three.
10. [chase-sets/chase-sets#10627 [discovery] Pausing, resuming or deleting a Product alert shows its old status: the redirect carries no write receipt](https://github.com/chase-sets/chase-sets/issues/10627), found the same way. The pilot reads with the receipt (decision 45).
11. [chase-sets/chase-sets#10629 [pricing] The public market page's stat values are h2 headings, so a screen reader lists "$44.50" and "3" as sections](https://github.com/chase-sets/chase-sets/issues/10629), found by the market page's port. The pilot's stats are a `<dl>`; `smoke-public-market.mjs` prints public-web's headings beside the pilot's.
12. [chase-sets/chase-sets#10630 [pricing] The public market page says '1 trades' for a window with one trade](https://github.com/chase-sets/chase-sets/issues/10630), found the same way, from the catalog. The pilot keeps the catalog's message.
13. [chase-sets/chase-sets#10633 [ordering] Order pages show status codes (ready-for-fulfillment, standard, active) where the same page elsewhere writes words](https://github.com/chase-sets/chase-sets/issues/10633), found by the orders' port. The pilot shows the codes as marketplace does (decision 47).
14. [chase-sets/chase-sets#10634 [ordering] A purchase's delivery_summary.latest_delivered_at is Postgres text (2026-03-22 12:00:00+00), not ISO 8601](https://github.com/chase-sets/chase-sets/issues/10634), found the same way. The pilot reads both forms (`order_page::timestamp`).
15. [chase-sets/chase-sets#10635 [ordering] A purchase page offers Cancel to a member without orders.manage (an unverified email), and the action then answers Forbidden](https://github.com/chase-sets/chase-sets/issues/10635), found the same way. The pilot draws Cancel only for `orders.manage`; `smoke-market-orders.mjs` checks the collector's cancel answers 403.
16. [chase-sets/chase-sets#10638 [fulfillment] Serve the seller's shipment command center (buckets, order and each next action) from the Fulfillment API instead of building it in the web host](https://github.com/chase-sets/chase-sets/issues/10638), found by the shipments' port. The pilot sends the seller's list to marketplace's (decision 48).
17. [chase-sets/chase-sets#10641 [fulfillment] A shipment page says each empty state twice ("No shipment exceptions recorded." as the title and again as the description)](https://github.com/chase-sets/chase-sets/issues/10641), found the same way. The pilot says it once; `smoke-market-shipments.mjs` counts marketplace's once.
18. [chase-sets/chase-sets#10644 [public-presence] Waitlist signups through public-web share one rate-limit bucket because no client address reaches the API](https://github.com/chase-sets/chase-sets/issues/10644), found by the home page's port (read from the code, not seen in production). The pilot sends the visitor's address behind a trusted proxy (decision 49).
19. [chase-sets/chase-sets#10645 Let the seed seller pack a seeded shipment instead of Shipment mutation authority is unavailable](https://github.com/chase-sets/chase-sets/issues/10645), found by the packing page's port. Fulfillment refuses every packing write and mutation-recovery check on the sandbox's shipments, written under the seed's tenant (`tnt_seed_development`) where the seller's session writes as `tnt_identity`; the same split as #10572. The pilot says it could not confirm the write (decision 50); `smoke-market-packing.mjs` reports the writes as blocked.
20. [chase-sets/chase-sets#10649 [marketplace] Refuse a listing photo the API cannot decode instead of answering 500](https://github.com/chase-sets/chase-sets/issues/10649), found by Create listing's port. The pilot checks each photo's first bytes against its type, and draws a 5xx from a create with photos as the photos not processed.
21. [chase-sets/chase-sets#10650 [marketplace] Create listing with photos is refused: the form sends purchaseLimits, which the multipart create does not take](https://github.com/chase-sets/chase-sets/issues/10650), found the same way. The pilot sends each limit as its own field.
22. [chase-sets/chase-sets#10651 [marketplace] Create listing never hydrates: its client graph imports event-core's AsyncLocalStorage](https://github.com/chase-sets/chase-sets/issues/10651), found while measuring marketplace's page. The pilot's page is drawn on the server and is unaffected; marketplace's interactive time is not measured until it lands. The seller's listing page (`/account/listings/{id}`) has the same failure through `listing-evidence-readiness.tsx`, added to the issue as a comment.
23. [chase-sets/chase-sets#10671 [inventory] Create Inventory Item offers Graded but never sends graded card details, so the API refuses it](https://github.com/chase-sets/chase-sets/issues/10671), found by the inventory list's port. The pilot's form is refused the same way; the smoke creates a raw card (decision 57).
24. [chase-sets/chase-sets#10672 [platform-runtime] Inventory reads with a write's receipt time out for ~30 s while unrelated Inventory projections sit two positions behind](https://github.com/chase-sets/chase-sets/issues/10672), found the same way. The pilot says it could not verify the write; the inventory smoke accepts that only after the API timed out the receipt.
25. [chase-sets/chase-sets#10673 [inventory] The item page's Stock Ledger labels an offline sale with the raw code offline-sale](https://github.com/chase-sets/chase-sets/issues/10673), found by the item page's port. The pilot says "Sold offline" (decision 58).
26. [chase-sets/chase-sets#10675 [inventory] Recording an offline sale writes two stock-ledger movements, so the ledger no longer sums to on hand](https://github.com/chase-sets/chase-sets/issues/10675), found the same way. The pilot draws the ledger as the API answers it; no workaround (decision 58).
27. [chase-sets/chase-sets#10676 [marketplace] Seller Desk queue rows for listings, shipments and sales link to /account/desk/... routes that do not exist](https://github.com/chase-sets/chase-sets/issues/10676), found by the Seller Desk's port. The pilot's `desk_page::link` sends those rows to the pages that have them (decision 59).
28. [chase-sets/chase-sets#10680 [marketplace] The seller's listing availability read answers its instants as Postgres text (2026-12-10 06:00:00+00), not ISO 8601](https://github.com/chase-sets/chase-sets/issues/10680), found while moving the away window's day to the server. The pilot reads both forms; no workaround (decision 54).
29. [chase-sets/chase-sets#10682 [pricing] Compile Repricing Presets in the Pricing API now that a second client authors policies from them](https://github.com/chase-sets/chase-sets/issues/10682), found by the repricing desk's port. The pilot compiles a preset on the server (`Editor::compile`, decision 60) until Pricing does.
30. [chase-sets/chase-sets#10683 [checkout] Read the checkout fee quote from Payments instead of quoting the compiled default policy in the web loader](https://github.com/chase-sets/chase-sets/issues/10683), found by the buy checkout's port. The pilot reads Payments' quote (decision 61); no workaround to remove.
31. [chase-sets/chase-sets#10685 [checkout] Opening a ready checkout page confirms it: the page submits Pay now by itself on load](https://github.com/chase-sets/chase-sets/issues/10685), found while measuring marketplace's checkout beside the pilot's: a `page.goto` created a pending purchase and paused the listing. The pilot's Pay now is only ever the buyer's press (decision 61); no workaround to remove.
32. [chase-sets/chase-sets#10686 [auth] Password sign-in failures through the web hosts share one IP bucket: five wrong passwords lock everyone out for five minutes](https://github.com/chase-sets/chase-sets/issues/10686), found by reading marketplace's auth host for the sign-in's port (not reproduced, to keep the shared dev API's limit clear). The pilot forwards the browser's address as `X-Forwarded-For` on every Auth call (decision 62).
33. [chase-sets/chase-sets#10687 [auth] A return address or magic-link path starting with /\ passes Auth's same-site check and leads to another site after sign-in](https://github.com/chase-sets/chase-sets/issues/10687), found by the sign-in's port and reproduced on the dev marketplace: a correct sign-in at `returnTo=/\example.com/phish` answered `Location: /\example.com/phish`, which a browser reads as `http://example.com/phish`. The same check builds the magic link's emailed address (code reading). The pilot refuses a backslash (decision 62).
34. [chase-sets/chase-sets#10688 [identity] A profile update accepts a blank legal or marketplace name, so an account's name can be saved empty](https://github.com/chase-sets/chase-sets/issues/10688), found by the account page's port and reproduced on the sandbox: a legal name of three spaces committed and read back as `""` (the collector's name was written back at once). The pilot's inputs carry `pattern=".*\S.*"` until Identity refuses it (decision 63).
35. [chase-sets/chase-sets#10689 [identity] A profile update can take a marketplace name another account holds, bypassing registration's display-name reservation](https://github.com/chase-sets/chase-sets/issues/10689), found by reading Identity's update path for the account page's port (not reproduced, to keep the sandbox's accounts distinct). No workaround: the rule is Identity's.
36. [chase-sets/chase-sets#10690 [marketplace] An inventory hold pauses a listing as the seller's own pause, and nothing resumes it when the hold is released](https://github.com/chase-sets/chase-sets/issues/10690), found because `smoke-market-listing.mjs` has failed since the checkout tests: the seeded Lugia listing was paused 10 s after an order held its only item, the order was cancelled an hour later, and the listing is still paused with the item available. No workaround; the listing smoke fails until Marketplace resumes it.
37. [chase-sets/chase-sets#10695 [identity] A user's API key list shows other users' keys whose name or owner mentions the user's id, with the owner's email](https://github.com/chase-sets/chase-sets/issues/10695), found by reading Identity's list query for the security page's port and reproduced on the sandbox: a synthetic key the collector named after the demo user's id appeared in the demo user's list with the collector's email, while its detail read answered 403 (the key was revoked at once). The pilot keeps only the user's own keys (decision 64).
38. [chase-sets/chase-sets#10697 [auth] A user's session list shows other users' sessions whose name, email or account mentions the user's id](https://github.com/chase-sets/chase-sets/issues/10697), the same pattern in Auth, reproduced on the sandbox: with the demo user's display name set to include the collector's id, the collector's list held 4 of the demo user's sessions with its email, while their detail reads answered 403 (the name was put back at once). The pilot keeps only the user's own sessions (decision 65).
39. [chase-sets/chase-sets#10698 [auth] Session switch-account and revoke answer 500 for every refusal, so marketplace's Switch Account always fails for a one-account user](https://github.com/chase-sets/chase-sets/issues/10698), reproduced on the sandbox: a switch to the current account, to an unavailable one or with none, and a revoke of a revoked session each answered 500; marketplace's Switch Account POST answered 500. The pilot reads the session again after such a write and offers only other accounts (decision 65).
40. [chase-sets/chase-sets#10699 [auth] Marketplace's sessions page ignores its status filter, search and pages, always showing the first 50](https://github.com/chase-sets/chase-sets/issues/10699), reproduced on the local marketplace: three different filter addresses drew the same 14 links. The pilot's filter and pages reach Auth (decision 65).
41. [chase-sets/chase-sets#10700 [auth] Marketplace's session page links its Sessions breadcrumb to admin's /access/sessions, a page not found](https://github.com/chase-sets/chase-sets/issues/10700), reproduced on the local marketplace. The pilot links back to its own list.
42. [chase-sets/chase-sets#10702 [catalog] Scope Detail's alias Accept, Reject, Revoke and Defer each say "Command queued", and Defer writes nothing](https://github.com/chase-sets/chase-sets/issues/10702), found by reading admin-web's scope page for its port. The pilot's toasts say what each command did, and its Defer sends nothing (decision 66).
43. [chase-sets/chase-sets#10703 [catalog] Return a scope's language-edition link states and journey from the Catalog API instead of deriving them in admin-web](https://github.com/chase-sets/chase-sets/issues/10703), found the same way. The pilot derives them in `scope.rs` until the API returns them (decision 66).
44. [chase-sets/chase-sets#10704 [identity] An account's team lists other accounts' memberships and invitations whose names or emails mention the account's id](https://github.com/chase-sets/chase-sets/issues/10704), the same pattern in Identity's team lists, reproduced on the sandbox: with the demo user's display name set to include the collector's account id, the collector's membership list held the demo membership with its email, while its detail read answered 403 (the name was put back at once). The invitations list was not reproduced. The pilot keeps only the account's own rows (decision 67).
45. [chase-sets/chase-sets#10707 [identity] A security.manage owner can list another user's or account's consents by naming its ids, or every consent by naming neither](https://github.com/chase-sets/chase-sets/issues/10707), found by reading Identity's consents route for the consent history's port. Not reproduced: the sandbox records no consents (the list answered `total: 0` for the collector and the platform admin). The pilot keeps only the user's own consents (decision 68).

46. [chase-sets/chase-sets#10712 [settlement] Answer the money dashboard's next payout, blocked payouts and payout availability from the Settlement API](https://github.com/chase-sets/chase-sets/issues/10712), found by reading Settlement's money dashboard for its port: three Settlement rules in the web layer, and the blocked one disagrees with the Seller Desk's own source (failed payouts only). The pilot copies the three in `money.rs` until the API answers them (decision 72).

47. [chase-sets/chase-sets#10715 [platform-operations] Return who acts next on a Support Request, the deadline in effect and the participant's actions from its detail read](https://github.com/chase-sets/chase-sets/issues/10715), found by reading the Support Request detail page for its port: who acts next, the deadline and which actions a participant gets are worked out in the web layer. The pilot copies them in `support.rs` until the detail read answers them (decision 73).

Found in Chase Sets, not Corten: the Catalog API refuses every reorder of a dimension's options.
`PUT /:id/options/:optionId` is registered before `PUT /:id/options/order`
(`bounded-contexts/catalog/features/dimensions/api/route.ts`), so `order` is read as an option id:
400 "optionId must start with chc_.". admin-web's own Reorder gets the same 400 (checked in a
browser against the dev sandbox). The pilot shows the refusal in the dialog;
`scripts/smoke-catalog.mjs` reports the step as blocked by the API, not as passed.
Filed as [#10520 Let the Catalog API reorder a dimension's options instead of refusing every reorder](https://github.com/chase-sets/chase-sets/issues/10520);
once it lands, the smoke test's reorder step should pass instead of being reported blocked.

Also found in Chase Sets, by Projection Operations' port: [chase-sets/chase-sets#10710 [platform-operations] List each blocked projection's streams and poison events in the projections read (the repair queue and Operations Attention show none)](https://github.com/chase-sets/chase-sets/issues/10710). The projections read sends each blocked projection's counts only, so the API's repair queue and attention items, and Operations Attention's poison-event and blocked-stream sources, list none of them. Workaround: a group's sheet reads its projections' details and links each one (`blocked_details` and `group_problems` in [`projections`](admin/src/projections/)). Remove both once the issue lands.

Also found in Chase Sets, by the Operations Attention queue's port:

1. [chase-sets/chase-sets#10606 [platform-operations] Give the Operations Attention queue's Open links their admin section (every one is a 404)](https://github.com/chase-sets/chase-sets/issues/10606). The API's hrefs have no admin section, so admin-web's Open goes to a 404. Workaround: `open_href` in [`operations`](admin/src/operations/mod.rs) puts the surface's section in front of a path that has none. Remove it once the issue lands.
2. [chase-sets/chase-sets#10607 [platform-operations] Register and publish the Operations Attention realtime topic (the API refuses it, so the queue never goes live)](https://github.com/chase-sets/chase-sets/issues/10607). Nothing registers `platform-operations:admin:operations-attention`, so the realtime API answers 403. admin-web's page then says Connecting forever. The pilot's stream ends and the queue stays as drawn. No workaround: the page goes live once the topic is registered and published.

Also found in Chase Sets: a realtime stream the client drops before the response headers arrive
keeps its stream lease, and the platform API renews the lease for as long as its process runs.
After six such drops for one account (`maxActiveStreamsPerConnectionKey`), every realtime stream
for that account answers 429 `too_many_realtime_streams`. Its live lists then stop updating,
and nothing on the page shows it. The pilot drops its upstream request whenever a browser leaves
a live page, so smoke runs locked the admin account out. Filed as
[#10524 Release a realtime stream's lease when the client drops it before the headers](https://github.com/chase-sets/chase-sets/issues/10524).
Workaround: the pilot sends the upstream request from its own task, so it reaches the headers
even if the page goes away first (`connect` in [`realtime`](platform/src/realtime.rs)). Twelve
live connections dropped 1 to 50 ms after opening leaked one lease without the workaround and
none with it, counted in the dev sandbox's `platform_realtime_stream_leases` (measured once each; the leak is intermittent). Remove it once that issue lands.

Closed:

Fixed at the `0f3f03f` pin ([todd-skelton/corten#108 The error page takes extractors (the caller), Failure::Unidentified, ReadAgain at a #place](https://github.com/todd-skelton/corten/pull/108)), workarounds removed:

1. [todd-skelton/corten#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88): each app's error page is `async fn error_page(failure, req, ..)` and takes who is asking as a page does, marketplace's `Option<Caller<Session>>` and admin's `Option<Caller<Viewer>>` (any signed-in staff member, `auth::Viewer`'s `Identify`), so a 404 or a 403 is drawn with the user's nav and theme. public's takes none. Corten looks the caller up again for the error page (its measurement: an unknown URL's error page 20,650 to 26,122 instructions).
2. [todd-skelton/corten#89 Refused::unavailable reaches the error page as Failure::Failed (503), the same as a handler's own 503](https://github.com/todd-skelton/corten/issues/89): a session the platform API could not read is `Failure::Unidentified`, "We could not check who you are", with no nav. In admin it read as the screens' own 503 ("We are preparing your change") before.
3. [todd-skelton/corten#107 ReadAgain never reads a page whose address has a #fragment, so a write redirected to route.at(..) stays on its catching-up state](https://github.com/todd-skelton/corten/issues/107): the alert fallback redirect and the item page's Manage alerts link are `.at(ProductAlertsId)` again; the settings at `#product-alerts` read themselves again while the alerts catch up.

Fixed at the `770b7eb` pin ([todd-skelton/corten#105 A typed route carries a place on its page (Route::at); t.date writes the month and year (MonthStyle)](https://github.com/todd-skelton/corten/pull/105)), workarounds removed:

1. [todd-skelton/corten#100 A typed route cannot carry a #fragment, so a redirect after a write cannot bring the browser back to the element it acted on](https://github.com/todd-skelton/corten/issues/100): `app::At` and `account_page::review_anchor` are gone. Report review redirects to `to.at(ReviewId(&review))`, and the `#feedback` link is `.at(FeedbackId)`, so the markup's id and the URL's are the same type. The alert links were `.at(ProductAlertsId)` too until [todd-skelton/corten#107 ReadAgain never reads a page whose address has a #fragment, so a write redirected to route.at(..) stays on its catching-up state](https://github.com/todd-skelton/corten/issues/107) took the fragment back off them; they are again at the `0f3f03f` pin.
2. [todd-skelton/corten#101 t.date has no month-and-year style, so 'Member since March 2025' cannot be localized](https://github.com/todd-skelton/corten/issues/101): `set_page::month_year` is gone; "Member since" is `t.date(at, MonthStyle::Long)` of the account's `created_at` (Postgres' text, which `parse_timestamp` reads).

Fixed at the `d824f40` pin ([todd-skelton/corten#102 Keeping a place keeps the rail's scroll and the open groups; Fields takes generics; Route declares serde](https://github.com/todd-skelton/corten/pull/102)), workarounds removed:

1. [todd-skelton/corten#96 A data-keep-place navigation resets a scrolling container (a filter rail), so the control it focuses is out of view](https://github.com/todd-skelton/corten/issues/96) and [todd-skelton/corten#97 A data-keep-place navigation folds the <details> the user unfolded, so focus can fall to the body](https://github.com/todd-skelton/corten/issues/97): `search.js` no longer notes the rail's scroll and the open groups, and the page has no `connect` handler (`restore` is gone). `smoke-market-search.mjs` still checks that focus, the page's scroll and the rail's scroll stay where they were.
2. [todd-skelton/corten#98 #[derive(Fields)] refuses a struct with a lifetime, so a borrowed query struct cannot name its form's controls](https://github.com/todd-skelton/corten/issues/98) and [todd-skelton/corten#99 #[derive(Route)] reads #[serde(rename_all)] but does not declare it, so a link-only struct must derive a serde trait](https://github.com/todd-skelton/corten/issues/99): `TermsQuery` derives `Route` and `Fields` and nothing else, its `FIELDS` name the form's controls and `Terms::read`'s parameters, and the owned copy `TermsNames` is gone ([`search.rs`](marketplace/src/search.rs)).

Fixed at the `319d3b7` pin, workarounds removed:

1. [todd-skelton/corten#90 An answer cannot add rows to a list (Load more re-reads and re-renders every row shown)](https://github.com/todd-skelton/corten/issues/90): Load more is a GET `data-patch` form (`LoadMore`). With JavaScript the handler reads one page after the API's cursor and answers `view::Append(ResultsId, rows)` and the form again, so it goes past the 192 a whole page can show. A restarted cursor replaces the rows with the new first page, and a failed read says so and offers to try again. Without JavaScript the form is the address with a page more, as before. The router tests cover all four; the sandbox's seed has fewer than 24 results, so the smoke cannot.
2. [todd-skelton/corten#91 A query parameter cannot have a name other than its field's (#[route(query)] has no name =), so camelCase URLs need a hand-written Params](https://github.com/todd-skelton/corten/issues/91): `Terms` writes its links through `TermsQuery`, a `#[derive(Route)]` with `#[serde(rename_all = "camelCase")]` and the three filter families as `prefix` fields, instead of by hand. The form's controls and `Terms::read` take their names from it (through `TermsNames` until the `d824f40` pin). Two gaps found: #98 and #99, fixed at `d824f40` above.
3. [todd-skelton/corten#92 A GET form that applies a filter on change loses the user's place: its navigation scrolls to the top and moves focus to the body](https://github.com/todd-skelton/corten/issues/92): the filters form is `data-keep-place`. `search.js` no longer keeps the field or the page's scroll in `sessionStorage` or waits out the focus reset in a `setTimeout`. At this pin Corten kept neither the rail's scroll nor the open groups, so the workaround stayed for those two until #96 and #97 were fixed at `d824f40` (above). `smoke-market-search.mjs` checks that focus, the page and the rail stay where they were.
4. [todd-skelton/corten#93 An area has one prefix, so a screen at two addresses (/search, /categories/{slug}) puts its stylesheet on every page](https://github.com/todd-skelton/corten/issues/93): `views::SEARCH` is listed in the search, categories and sets areas, so its stylesheet is `sections/search+categories+sets.css`, linked from those pages only (and from the home page, #95 above). Admin's live status is listed in the catalog and Operations Attention areas instead of `App::components`.

Fixed at the `c7fc490` pin, workarounds removed:

1. [todd-skelton/corten#86 A dialog the server draws open (a refused form without JavaScript) is not modal, and every app writes the handler that fixes it](https://github.com/todd-skelton/corten/issues/86): the pilot's two `modal` handlers (`admin/src/catalog/views/dialog.js`, `marketplace/src/views/save_dialog.js`) are gone. The catalog's `Dialog` and Add to List's `SaveDialog` use `corten_ui::dialog::modal`, listed as `corten_ui::dialog::COMPONENT` in the catalog area and the item area (marketplace now depends on corten-ui for it alone). `smoke-bulk.mjs` (the preview drawn open, with and without JavaScript) and `smoke-market-item-save.mjs` (a refused new list comes back modal) pass against the release builds.

Fixed at the `c919779` pin, workarounds removed:

1. [todd-skelton/corten#84 A patch or live fragment closes a <dialog> the user opened and folds a <details> they unfolded](https://github.com/todd-skelton/corten/issues/84): `RefDialogs` is drawn in the Details tab again, inside the redrawn market book; the live fragment's test now expects the dialogs in it.

Fixed at the `de6f039` pin, workarounds removed:

1. [todd-skelton/corten#82 A view that is lets then one patch component is not a patch (One<F> never implements Patch)](https://github.com/todd-skelton/corten/issues/82): `PreviewDialog` in `bulk_dialogs.rs`, and `ItemPreviewDialog`, `DraftsDialog` and `item_live` in `item_list.rs`, are `let`s and then their patch component again, with no `match ()` block (`scripts/smoke-bulk.mjs` and `scripts/smoke-items.mjs` pass against the release build).

Fixed at the `91af573` pin, workarounds removed:

1. [todd-skelton/corten#76 A page cannot write JSON-LD in its head since Meta was removed (an expression in <script> is escaped as HTML)](https://github.com/todd-skelton/corten/issues/76): the pilot's `views::JsonLd` is gone; the item page's `Product` and `BreadcrumbList`
   are Corten's `<JsonLd value={..} />` among its head tags. A unit test renders the product with a
   description that says `</script>` and reads the JSON back
   ([`tests.rs`](marketplace/src/tests.rs), `the_production_item_writes_its_product_as_json_ld_that_no_description_can_end`).
2. [todd-skelton/corten#77 A view that is one component cannot pass a reference to its own locals (E0515 since the document change)](https://github.com/todd-skelton/corten/issues/77): the documented form is the workaround's form, so the four admin views now make their
   title, description or links inside the markup and their workaround notes are gone. The
   preview dialog still moves its title and description in, because a long `match` decides them.
3. [todd-skelton/corten#78 An area's routes cannot name their handlers (#[corten::routes] covers only App::new)](https://github.com/todd-skelton/corten/issues/78): the item pages' routes are `#[corten::routes(area = ItemsArea)] mod items` in
   [`app.rs`](marketplace/src/app.rs), served by one `items::Pages` that names every handler
   ([`items.rs`](marketplace/src/items.rs)); `ItemAdded` and `ItemWatched` are links to the item's
   route. The other areas still mount `#[derive(Route)]` structs (see the pin row).

Fixed at the `9326a3f` pin, workarounds removed:

1. [todd-skelton/corten#71 A typed route cannot carry query parameters whose names are data (dimension.<id>=<option>)](https://github.com/todd-skelton/corten/issues/71): the item page's address writes `dimension.<id>=<option>` through a
   `#[route(prefix = "dimension.")]` field of a derived `#[route(query)]` struct; the hand-written
   separators and encoding are gone.
2. [todd-skelton/corten#72 A page that moved cannot redirect permanently (Req::redirect is always 303)](https://github.com/todd-skelton/corten/issues/72): an id or an old slug answers `req.moved` (301, `private, max-age=86400`), checked by
   `smoke-market-item.mjs` and by hand.

Fixed at the `993eeac` pin, workaround removed:

1. [todd-skelton/corten#69 A page cannot ask to be read again shortly, and the Refresh header only works on a full load](https://github.com/todd-skelton/corten/issues/69)
   ([todd-skelton/corten#70 A page can ask to be read again, however it was reached](https://github.com/todd-skelton/corten/pull/70)): the cart's
   pending read is `Meta::read_again(2 s)` instead of the `Refresh` header, and its line
   writes and Send the same change again are `data-patch` forms. Its tests check the
   `<noscript>` tag and no `Refresh` header (a debug build now answers 500 to a page that sends one).

Fixed at the `c590b8a` pin, workarounds removed:

1. [todd-skelton/corten#63 A page cannot write an amount of money in the request's locale](https://github.com/todd-skelton/corten/issues/63)
   ([todd-skelton/corten#67 Numbers, money and dates in the request's locale](https://github.com/todd-skelton/corten/pull/67)): the cart's prices and totals are `t.money`.
   `platform::money` keeps only Chase Sets' rule for what an amount is (`cents`, `decimal`).
   `formatMoney`'s cases now check Corten's `en` output, and all of them pass.
2. [todd-skelton/corten#60 A page cannot write a date and time in the request's locale](https://github.com/todd-skelton/corten/issues/60)
   ([todd-skelton/corten#67 Numbers, money and dates in the request's locale](https://github.com/todd-skelton/corten/pull/67), [todd-skelton/corten#68 Numbers, money and dates a script writes, as the server does](https://github.com/todd-skelton/corten/pull/68)): `platform::when` is gone.
   The restock decision's time is `t.date_time`, and the cart orders its lines by
   `parse_timestamp`. The live lists' "Stale since" time, which their script wrote with the
   browser's `Intl`, now uses the server's format (`t.js().date_time`).
   `formatDateTime`'s cases check Corten's output.

Fixed at the `c268ecc` pin, workarounds removed:

1. [todd-skelton/corten#61 A patch element without an id is dropped in the browser, and nothing says so before](https://github.com/todd-skelton/corten/issues/61)
   ([todd-skelton/corten#62 A patch element the browser would drop is an error in debug builds](https://github.com/todd-skelton/corten/pull/62)): a patch element without an id is a 500 in
   debug builds, so the refused-write router tests catch it; their `patch_ids` check is gone.
2. [todd-skelton/corten#64 A page cannot send a form to another origin, and a post cannot redirect to one (form-action is always 'self')](https://github.com/todd-skelton/corten/issues/64)
   ([todd-skelton/corten#65 Policy::form_action: an origin a form may send the user to](https://github.com/todd-skelton/corten/pull/65)): Check out and Use lower price are forms again;
   their redirect to marketplace's checkout is allowed by `form_action`. The `CheckoutLink`
   links remain only for Keep shopping and Continue to checkout, which are links in marketplace
   too.

Fixed at the `26c55a8` pin, workaround removed:

1. [todd-skelton/corten#58 A catalog message cannot take a camelCase argument ({updatedAt})](https://github.com/todd-skelton/corten/issues/58)
   ([todd-skelton/corten#59 A catalog argument may be camelCase](https://github.com/todd-skelton/corten/pull/59)): `export.mjs` copies each argument as the
   catalog has it, and `attention::Params` looks the API's params up by that name; the
   snake-case rewrite and its `camel` lookup are gone.

Fixed at the `e220c14` pin, workarounds removed:

1. [todd-skelton/corten#54 A page cannot show a catalog message chosen at run time by its key](https://github.com/todd-skelton/corten/issues/54)
   ([todd-skelton/corten#55 t.by_key: a catalog message chosen at run time by its key](https://github.com/todd-skelton/corten/pull/55)): the attention queue's text is `t.by_key`; the 20-key `item_text` match is gone.
2. [todd-skelton/corten#56 A catalog message cannot take an argument named like a Rust keyword ({type})](https://github.com/todd-skelton/corten/issues/56)
   ([todd-skelton/corten#57 A catalog argument may be named like a Rust keyword](https://github.com/todd-skelton/corten/pull/57)): the catalog keeps `{type}`; `export.mjs` no longer renames it `{type_}`.

Fixed at the `c35a10a` pin, workarounds removed:

1. [todd-skelton/corten#49 A script cannot hear a <corten-live> element's status change](https://github.com/todd-skelton/corten/issues/49):
   `LiveStatus` draws the `<corten-live>` and takes its `corten-status` event (and `on:connect`
   for the state before the scripts loaded); the `MutationObserver` is gone.
2. [todd-skelton/corten#50 A @typedef of plain values and a Message is not a group, and the error does not say why](https://github.com/todd-skelton/corten/issues/50):
   `BulkRows`' `drawn` takes the count's texts as one `js::Count` group.

Fixed at the `014a2fd` pin, workarounds removed:

1. [todd-skelton/corten#32 A route cannot share a set of query parameters with another route](https://github.com/todd-skelton/corten/issues/32)
   (correctness): each list's filters are one `#[route(query)]` set (`ItemQuery`,
   `DimensionQuery`, `FieldQuery`) that its page, live, bulk and confirm routes carry, and
   what a write left on the list is another (`ItemNotice`, `ListNotice`). The `filtered!`
   macro and the repeated fields are gone.
2. [todd-skelton/corten#33 A page cannot tell whether a <corten-live> element is connected](https://github.com/todd-skelton/corten/issues/33)
   (correctness, as the user sees it): the items list shows admin-web's Live, Connecting… and
   "Stale since …" with Reload (`LiveStatus`). admin-web shows it on that list only, so the
   dimensions and fields lists do not.
3. [todd-skelton/corten#34 #[derive(ToJson)] refuses #[serde(flatten)] of a struct that is itself ToJson](https://github.com/todd-skelton/corten/issues/34)
   (developer time): `DimensionDetail` derives `ToJson`; a test checks it writes what serde does.
4. [todd-skelton/corten#35 A SubmitKey can only be 32 hex digits, so an API that takes a UUID cannot use it](https://github.com/todd-skelton/corten/issues/35)
   (correctness): marketplace's write forms draw their attempt with `SubmitKey::field` (item 7).
5. [todd-skelton/corten#39 corten check at a workspace root type-checks none of the members' scripts](https://github.com/todd-skelton/corten/issues/39)
   (correctness): CI puts the repo's `tsc` on `PATH` and fails if `corten check` says it
   type-checked nothing; the pilot's `jsconfig.json` and its CI step are gone.
6. [todd-skelton/corten#44 A form with a control named id cannot be patched](https://github.com/todd-skelton/corten/issues/44)
   (correctness): Assign Blueprint and Assign Category name their control `id` again.
7. [todd-skelton/corten#45 Field error ids are only the field's name, so two forms on a page share them](https://github.com/todd-skelton/corten/issues/45)
   (correctness, for a screen reader): every form's errors are `errors.within(FormId)`, so a
   message's id is `{form id}-{field}-error`. Breaking at this pin: `Errors::aria` and
   `Errors::message` are gone, so every form id is a typed `#[derive(Id)]` value.
8. [todd-skelton/corten#17 Scripts have no typed way to show user-facing text they compute](https://github.com/todd-skelton/corten/issues/17)
   (end-user performance): the bulk bar's "N Dimensions selected" is the catalog's message, sent
   once unfilled (`t.js().bulk_selected()`), instead of a `<template>` with the text for every
   count from 0 to the page's rows, which went out again in each live event.

Fixed at the `f80d4a1` pin:

1. [todd-skelton/corten#9 Forms have no per-submission idempotency key](https://github.com/todd-skelton/corten/issues/9)
   (correctness): Corten has `SubmitKey`, renewed after each answer. Adopted at `014a2fd`, once
   [todd-skelton/corten#35 A SubmitKey can only be 32 hex digits, so an API that takes a UUID cannot use it](https://github.com/todd-skelton/corten/issues/35)
   made it a UUID.
2. [todd-skelton/corten#20 corten check does not type-check an app's scripts](https://github.com/todd-skelton/corten/issues/20)
   (correctness): `corten check` in an app's directory runs `tsc` over its scripts when `tsc`
   is on `PATH`; at the workspace root too since `014a2fd`.
3. [todd-skelton/corten#24 corten::live responses are never compressed](https://github.com/todd-skelton/corten/issues/24)
   (end-user performance): live events are compressed.
4. [todd-skelton/corten#26 A component that names a variable scope is treated as scoped](https://github.com/todd-skelton/corten/issues/26)
   (developer loop). The `mode` and `taken` names stay; they match the API's words.

Fixed in [todd-skelton/corten#21 A <corten-live> stream resumes from the app's cursor](https://github.com/todd-skelton/corten/pull/21), at the pin, workaround removed:

1. [todd-skelton/corten#15 A <corten-live> stream cannot resume after a reconnect](https://github.com/todd-skelton/corten/issues/15)
   (correctness, then performance): the live lists drew their rows on every connection. Each
   fragment now carries the platform realtime stream's cursor (`Fragment::cursor`), and a
   reconnect resumes the upstream stream from the browser's `Last-Event-ID` (`LiveSince`): it
   draws only if something changed meanwhile. Measured against the dev system: the first
   connection to `/catalog/dimensions/live?search=condition` sent one 2,236 B fragment, and a
   reconnect with its id sent nothing in 6 s. A first connection still draws once, when the
   upstream stream opens, because the platform's list read gives no cursor for `since`. The job
   dialog's fragments carry the job event's id the same way.

Fixed in [todd-skelton/corten#14 A data-patch form posts to its own action whatever its controls are named](https://github.com/todd-skelton/corten/pull/14), at the pin, workaround removed:

1. [todd-skelton/corten#13 A control named action or method breaks a data-patch form](https://github.com/todd-skelton/corten/issues/13)
   (correctness): the lifecycle buttons were named `step`, with a router test that no catalog
   page had a control named `action`.

Fixed in [todd-skelton/corten#12 corten dev watches local packages; a navigation before load is a full load](https://github.com/todd-skelton/corten/pull/12), at the pin, workarounds removed:

1. [todd-skelton/corten#10 corten dev does not rebuild when a path dependency changes](https://github.com/todd-skelton/corten/issues/10)
   (developer loop): was a save in the app after an edit in `platform/`.
2. [todd-skelton/corten#11 A navigation taken over before the first page loads stops it loading](https://github.com/todd-skelton/corten/issues/11)
   (correctness): the recovery script waited for `load` before submitting its check form.

Filed in Corten, one gap each, all fixed in
[todd-skelton/corten#5 App::guard, a defaulted Result error type and FieldName in the prelude](https://github.com/todd-skelton/corten/pull/5);
the pin is past it and the workarounds are gone.

1. [todd-skelton/corten#2 A set of routes cannot require a context (sign-in, a permission)](https://github.com/todd-skelton/corten/issues/2)
   (correctness): was `staff()` at the top of every handler and a test that tried every route
   signed out; now the guard above.
2. [todd-skelton/corten#3 FieldName is not in the prelude](https://github.com/todd-skelton/corten/issues/3)
   (convenience): was `use corten::{FieldName, prelude::*}`.
3. [todd-skelton/corten#4 The prelude's Result hides std::result::Result](https://github.com/todd-skelton/corten/issues/4)
   (one way to do things): was `std::result::Result`; helpers now write `Result<T, Errors>`.
