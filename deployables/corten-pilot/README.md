# Corten pilot

Pilot ports of Chase Sets screens to [Corten](https://github.com/todd-skelton/corten), the Rust
full-stack framework, to find what Corten lacks for real screens with real data and auth. It is
not deployed, is not part of the platform gates or the delivery loop, and has its own CI job
([corten-pilot.yml](../../.github/workflows/corten-pilot.yml)).

Each app is a standalone server in front of the existing platform API. Every call forwards the
signed-in user's cookies, as the React app does; sign-in, the other pages and all business rules
stay where they are. The pilot owns only the screens:

| App | Screen | Ported from | What it covers |
|---|---|---|---|
| `admin/` | Commerce > Postage policies, `/commerce/postage-policies` | admin-web | the list, the policy sheet, create, revise, preview, activate, retire and clone |
| `admin/` | Catalog > Dimensions and Fields, `/catalog/dimensions`, `/catalog/fields` | admin-web | the lists (live, with bulk lifecycle changes), each record's page, and every write on it |
| `admin/` | Catalog > Catalog Items (the list), `/catalog/catalog-items` | admin-web | the list and its ten filters, create, the changes count and Reload, bulk publish, archive and edits as jobs, and removing drafts |
| `admin/` | Catalog > Scopes (the list), `/catalog/scopes` | admin-web | the attention queue above the list (its counts, every item, an item's sheet, dismiss, defer and restore, and an alias candidate's accept and reject), the list, its search, status, product domain and language filters, promotion and sync, and the pager (not ported: the all-scopes alias review, and a scope's page, which View opens in admin-web) |
| `admin/` | Platform > Attention Queue, `/platform/operations-attention` | admin-web | the queue as the Platform Operations API composes it: the four counts, the sources it could not read, each item's severity, words, source, wait and deadline, and Open to the admin-web page that resolves it; the queue drawn again on each change to its realtime topic (`<corten-live>`), which the API refuses for now |
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}` | admin-web | the item, its origin and readiness, publish (with Recheck) and archive, and every dialog: blueprint, description, field values (a reference field takes a record), categories, product contents, tags, image URLs, the image fallback, and both kinds of external reference |
| `marketplace/` | Inventory > Storage locations, `/account/inventory/locations` | marketplace | the list (archived too), create, save and archive, and confirming a write whose answer was lost |
| `marketplace/` | Inventory > Restock decisions, `/account/inventory/restock-decisions` | marketplace | the pending decisions, Restock and Write off (with a damage note), a refusal drawn again at the current version, and confirming a write whose answer was lost |
| `marketplace/` | Buy > Cart, `/account/cart` | marketplace | the account's cart as the Checkout API reads it: each line (merged by product and fulfillment) with its badge, options, lock or preference, seller and price, the one notice (what needs attention, or the lower price), the totals and the checkout bar and Check out and Use lower price, which start the checkout session and send the buyer to marketplace's checkout; each line's quantity step, Remove and Lock this listing, as the Checkout API's command attempts (not ported yet: the guest cart, and the checkout pages after it) |
| `marketplace/` | An item's page, `/items/{slug}` | marketplace | anyone (a session only marks the viewer's own offers): the item, its picture, Buy and Sell, the product options as links (a GET form for a long list), the market summary, the rail with the listing or offer chosen, and the market book's Listings, Offers and Details, each choice in the address; an id or an old slug moves to the slug (301), an unknown item is a 404. Buying from the rail: Add listing to Buy Cart, Add product to Buy Cart and Buy best match (cart command attempts, to the account's cart or a guest's), and Buy this listing (a checkout session, then marketplace's checkout); Make an offer (the price, currency and quantity checked, then marketplace's offer checkout). Selling from the rail: the selected offer's payout for a guest (the API's standard terms), Accept offer (Sell now for a seller, else Add offer to Sell List) and Add product to Sell List, to the account's sell list or a guest's, then marketplace's sell list. Watching from the rail: Watch listings and Watch offers (an alert with an optional price), saved to the account, or for a guest as an intent claimed after marketplace's registration. Listing at a price from the Sell rail: the ship-from setup when the seller has none, then Create listing (the stock, the listing and its publication), the seller's own listing with Manage listing after it, a guest's draft claimed after marketplace's registration The mobile action dock below 80rem: the price, then Buy, Sell and Watch as links to the rail on that side, or Select options. The gallery: more than one picture shows one at a time, picked by its thumbnail. More like this: the similar items' cards under the market book, each to its page here. The market book's Sales tab: the chosen product's spread, last sale and medians, and its sale prices over a range as a chart drawn on the server, the range links. Live: on each change to the item, the market summary, the market book (with the Sales tab's history) and the dock are drawn again (`<corten-live>`) Details' references: each record's dialog, opened by its value with no script. Add to List: an account's recent Saved Lists or a new one in a dialog the page draws, with the tracked quantity, or for a guest an intent claimed after marketplace's registration (not ported yet: a graded product's listing; the rail and the options redrawn live) |
| `marketplace/` | A listing's page, `/listings/{slug}` | marketplace | anyone: the status, the item, the product's options and price; the purchase panel with the seller's rating, availability, fulfillment, returns and protection, Buy this listing (an account's checkout session, a guest's marketplace guest checkout) and Compare market (the pilot's item page); the seller with their account link, tiles, shipping credit and product; a seller away or at capacity as a warning with no Buy; and Report Listing, which says the report was received, or was sent already, or to wait, where marketplace says nothing ([chase-sets/chase-sets#10614 [discovery] Tell a visitor their listing report was received (the page ignores ?reported=1)](https://github.com/chase-sets/chase-sets/issues/10614)) or shows its 500 page ([chase-sets/chase-sets#10615 [discovery] A repeat listing report shows a 500 page instead of saying it was already reported](https://github.com/chase-sets/chase-sets/issues/10615)). An old slug moves for good; an unknown listing is a 404, a failed read a 502 (not ported: the realtime patches, and the Product JSON-LD marketplace writes only in production) |
| `marketplace/` | A set's page, `/sets/{slug}` | marketplace | anyone: the game, the set's name and what is known of it (its card count, cataloged items, code and long release date), its cataloged items as search's cards (the lowest price and View card; one column, two from lg, three from 2xl), Browse all in search (`reference.<type>=<set>`) when the API sent only some, an empty state with none, and the breadcrumb's JSON-LD. An old slug moves for good with its query; an unknown set is a 404 and a failed read a 502 (marketplace answers 200 for both: [chase-sets/chase-sets#10612 [discovery] Answer an unknown set page with 404, and a failed set read with 5xx, not 200](https://github.com/chase-sets/chase-sets/issues/10612)) |
| `marketplace/` | Search and the home page, `/search`, `/categories/{slug}` and `/` | marketplace | anyone: the words, the category (its own path), price and stock, language, market activity, the results' own facets (fields, references and product dimensions) and the sort, all in one GET form, applied as a choice changes with a script and by Show results without one; the applied filters as chips, each a link without its filter; the results as cards with the lowest price and Buy, Sell and Watch, each to the item page with the dimension filters; Load more (a link to the same results with a page more); close spellings and closest matches; with nothing asked, the landing's headline and featured categories, and on `/` the home page's shelf in place of the results: the four featured categories (their description, count and a link to each) and the three newest items (the lowest price and View item), one column on a phone; words or a filter asked on `/` show the results there. `page` and `category=..` (or a category's id, key, name or old slug) move for good, and words the API reads filters from redirect to the address with them applied, marked `interpreted`. Below 64rem the filters are a dialog the Filters button opens. A failed read is an error banner with the filters and a 502 (not ported yet: Add to List and the bulk add to the buy cart from a result, the realtime market patches, the facet option search and the automatic load on scroll) |

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
marketplace's cards load too. The landing's LCP is its headline. The pilot's `components.css`
carries search's stylesheet on every page
([todd-skelton/corten#93 An area has one prefix, so a screen at two addresses (/search, /categories/{slug}) puts its stylesheet on every page](https://github.com/todd-skelton/corten/issues/93)).

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
node scripts/smoke-restock.mjs         # restock decisions: the API's list, a stale version refused, an uncertain write, no JavaScript, 390 px (records no decision)
node scripts/smoke-catalog.mjs         # the catalog area: a dimension's and a field's whole life, with and without JavaScript
node scripts/smoke-live.mjs            # the catalog lists stay current while another tab writes ([..] [state] http://localhost:7752 watches admin-web's)
node scripts/smoke-bulk.mjs            # bulk lifecycle changes on the dimensions list, with and without JavaScript
node scripts/smoke-items.mjs           # the catalog items list: create, the changes count, a bulk edit, removing drafts, 390 px
node scripts/smoke-item.mjs            # a catalog item's page: a draft through every dialog, with and without JavaScript, 390 px
node scripts/smoke-attention.mjs       # the attention queue beside admin-web's: same items, a sheet, dismiss, defer and restore, no JavaScript, 390 px (parks one item and restores it)
node scripts/smoke-operations-attention.mjs  # the Operations Attention queue beside admin-web's: the counts, the same rows in order, each Open answering on admin-web, the stream, no JavaScript, 390 px (only reads)
node scripts/smoke-scopes.mjs          # the scopes list beside admin-web's ([..] [admin-web]): same rows, the filters, View, no JavaScript, 390 px (only reads)
node scripts/measure-live.mjs pilot=http://localhost:7790 admin-web=http://localhost:7752   # what one change costs the watching tab
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/measure.mjs screen=marketplace marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=cart marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=item marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=search marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=home marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=set marketplace=http://localhost:7753 pilot=http://localhost:7793 set=base-set
node scripts/measure.mjs screen=listing marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=catalog dimension=dim_seed_condition admin-web=http://localhost:7756 pilot=http://localhost:7791
corten check                           # at the workspace root: cargo fmt, corten fmt, clippy -D warnings, cargo test
```

Run `corten dev` inside the app's directory; it also rebuilds on an edit in `platform/`.

| Variable | Default | |
|---|---|---|
| `PLATFORM_API_ORIGIN` | `http://localhost:7762` | the platform API the apps call |
| `ADMIN_WEB_ORIGIN` | `http://localhost:7752` | admin: sign-in and the admin pages the nav links to |
| `MARKETPLACE_WEB_ORIGIN` | `http://localhost:7753` | marketplace: sign-in and the pages the nav links to |
| `PUBLIC_PROTO` | `http` | the scheme forwarded to the API as `x-forwarded-proto` |

`scripts/export.mjs` writes what the apps read from Chase Sets' sources: each screen's English
text (`*/locales/en.json`), each app's navigation (`*/nav.json`), admin's default policy
(`admin/defaults.json`), the scope product domains (`admin/scope-domains.json`), the design system's tokens (`platform/tokens.json`) and three fonts. CI
runs it with `--check`, so a change to the React apps' text, nav or tokens shows up here.
`*/locales/pilot.en.json` is the pilot's own text. One image per app:
`docker build --build-arg APP=marketplace .`.

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

**Ported ahead of Corten: `feat/route-handlers`.** Corten's next breaking change
([todd-skelton/corten#81 A route names its handlers in its attribute](https://github.com/todd-skelton/corten/pull/81), with its local
commit `e07c1a3`) replaces `App::context`, `App::guard` and `Area::guard` with a handler's `Caller<T>`
and an area's `caller = T`. It also makes a handler's return type its route's answer (`HtmlResult`, `LiveResponse`),
has every route name its handler in `#[route(..)]`, and turns `Failure` into an enum. The pilot is ported
to it on the local branch `pilot/corten-route-handlers`, which builds against `e07c1a3` merged
with `c7fc490` through a local `[patch]`. It is pushed and pinned once the change merges into
Corten `main`. At that commit `corten check` passes (admin 61, marketplace 93, platform 6). Eight
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
| `*/src/app.rs` | routes, access (sign-in at the React app, 403, 502), and the handlers |
| `*/src/api.rs` | the screen's calls; typed bodies with only the fields the screen reads |
| `*/src/form.rs` | what the forms post; the pilot checks only shape (text present, numbers parse), the API checks the rules |
| `marketplace/src/recovery.rs` | the write's attempt id, the address's `Check`, and confirming a write the browser did not hear back about |
| `marketplace/src/locations.rs`, `views/location_card.*` | the storage locations: the list and its three writes |
| `marketplace/src/restock.rs`, `views/decision_card.*` | the restock decisions: the list and its two writes |
| `marketplace/src/cart.rs`, `views/cart_item.*` | the cart: its read, the lines merged and priced, its writes and checkout, and the page's parts, whose stylesheet is `sections/account/cart.css` |
| `marketplace/src/items.rs`, `views/item_detail.*` | an item's page: the read, the address (its choices, read and written), marketplace's selection rules, and the page's parts |
| `marketplace/src/cart_attempt.rs` | a cart write (`api::CartWrite`: the cart's commands or an item page's new line, for an account or a guest) as the Checkout API's command attempt: the attempt id, the request hash, one lookup for a lost answer, and what the attempt came to |
| `marketplace/src/saving.rs` | the item page's Add to List: the recent lists read with the page, the ids drawn with the form, an account's addition or a guest's intent, the quantity's and title's checks, and what the page says after each |
| `marketplace/src/watching.rs` | the item page's Watch writes: an account's alert or a guest's intent for the product the page showed, the threshold's checks, and what the page says after each |
| `marketplace/src/selling.rs` | the item page's sell writes: the sell-list line built from the item read again (an offer or a product), the guest sell list, the payout terms, and what the page says after each |
| `marketplace/src/listing.rs` | the item page's List this product writes: the ship-from setup, the stock, the listing and its publication as one attempt, a guest's draft, and what the page says after each |
| `marketplace/src/buying.rs` | the item page's buy writes: the cart line built from the item read again, the guest cart, Buy best match, Buy this listing, and what the page says after each |
| `platform/src/money.rs` | what an amount the APIs send is (decimal text, at most two fraction digits, read as cents); Corten writes it (`t.money`) |
| `*/src/views/` | the components, each with its stylesheet, and their scripts |
| `admin/src/catalog/` | the catalog area: its routes and handlers (`mod.rs`), the Catalog API calls (`api.rs`), the forms and the bodies admin-web sends (`form.rs`), and its views, whose stylesheets are `sections/catalog.css` |
| `admin/src/catalog/views/bulk_rows.*`, `bulk_dialogs.rs` | bulk changes: the bar and the rows' boxes (the selection's script), and the preview and job dialogs |
| `admin/src/catalog/items.rs`, `views/item_list.rs`, `views/item_form.css` | the catalog items list: its routes, the changes count, the three bulk changes and removing drafts |
| `admin/src/catalog/item.rs`, `views/item_page.rs`, `views/item_page.css` | a catalog item's page: its reads, one route per write, and its sections and dialogs |
| `admin/src/catalog/scopes.rs`, `views/scope_list.rs`, `views/scope_row_view.css` | the scopes list: its route and query, the promotion and sync of each row, and its table |
| `admin/src/catalog/attention.rs`, `views/attention_panel.*` | the Catalog attention queue on the scopes list: an item's sheet, the park and restore routes, the alias commands, and the queue's messages by key |
| `admin/src/views/live_status.*` | a stream's status, for the catalog items list and the attention queue: Live, Connecting… or stale with Reload (CSS on `<corten-live>`'s `status`), each in its screen's words; in `components.css`, since two areas render it |
| `admin/src/operations/` | the Operations Attention area: its routes and the Open links (`mod.rs`), the queue's read (`api.rs`), and its page, whose stylesheet is `sections/platform/operations-attention.css` |
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
   viewer the handler passes it; the error page has none
   ([todd-skelton/corten#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88)).
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
   account menu and cart count are not.
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
    API (`cart::checkout`) and redirects to marketplace's `/checkout/buy/session/{id}` with the
    session's receipt as `afterWrite`, forgetting the guest cart cookie as marketplace does. The
    redirect leaves the pilot's origin, which `Policy::form_action` allows. The form carries only
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
    live status moved out of the catalog, takes each screen's words, and is listed in
    `App::components`: Corten refuses a component listed in two areas, since its stylesheet is
    one file (the startup error says so). The page follows admin-web's realtime topic and draws
    the counts, the missing sources and the rows again on each change. The platform does not
    register that topic yet (chase-sets/chase-sets#10607), so the stream ends at once and the
    status shows nothing; admin-web's says Connecting. On a phone the counts are two by two and
    each row is a card with each cell beside its heading, CSS only, as admin-web's `DataTable`.
    The degraded line's two arguments are both text, and `t` takes a message's arguments in the
    order the message names them (`{source} unavailable: {reason}`): the router test caught them
    swapped. This port merged `origin/main` into the branch first, for the API's runtime reads
    ([#10557 [platform-operations] Wire projection and wake reads into the platform API and load the admin Operations Attention queue from it](https://github.com/chase-sets/chase-sets/issues/10557)).

## Corten gaps

Open, filed in Corten: none at the `c7fc490` pin.

Open, filed against `feat/route-handlers` (the local port), each with its workaround:

1. [todd-skelton/corten#88 An error page cannot show who is asking (App::error_page has no Caller), so a signed-in user's 404 is drawn signed out](https://github.com/todd-skelton/corten/issues/88): both error pages pass `viewer={None}`.
2. [todd-skelton/corten#89 Refused::unavailable reaches the error page as Failure::Failed (503), the same as a handler's own 503](https://github.com/todd-skelton/corten/issues/89): none; a session lookup outage shows the failed page's words.
3. [todd-skelton/corten#90 An answer cannot add rows to a list (Load more re-reads and re-renders every row shown)](https://github.com/todd-skelton/corten/issues/90): Load more is a link to the same results with a page more (`more=24#result-25`), up to 192, the most the API reads at once ([`Found`](marketplace/src/views/search_page.rs)).
4. [todd-skelton/corten#91 A query parameter cannot have a name other than its field's (#[route(query)] has no name =), so camelCase URLs need a hand-written Params](https://github.com/todd-skelton/corten/issues/91): `search::Terms` writes its parameters by hand ([`search.rs`](marketplace/src/search.rs)).
5. [todd-skelton/corten#92 A GET form that applies a filter on change loses the user's place: its navigation scrolls to the top and moves focus to the body](https://github.com/todd-skelton/corten/issues/92): `search.js` keeps the changed field, the page's scroll and the rail's in `sessionStorage` and puts them back after the swap, in a `setTimeout` after the runtime's focus reset ([`search.js`](marketplace/src/views/search.js)).
6. [todd-skelton/corten#93 An area has one prefix, so a screen at two addresses (/search, /categories/{slug}) puts its stylesheet on every page](https://github.com/todd-skelton/corten/issues/93): search's components are in `App::components` ([`app()`](marketplace/src/app.rs)).

Found in Chase Sets by the search port:

1. [chase-sets/chase-sets#10609 [discovery] Search answers 500 on the first request after a quiet minute](https://github.com/chase-sets/chase-sets/issues/10609). The pilot shows the error banner and answers 502; the smoke reads once before it starts.
2. [chase-sets/chase-sets#10610 [discovery] Search says No items found when the search read fails](https://github.com/chase-sets/chase-sets/issues/10610). Marketplace's behavior, not the pilot's: the pilot says the read failed.
3. [chase-sets/chase-sets#10612 [discovery] Answer an unknown set page with 404, and a failed set read with 5xx, not 200](https://github.com/chase-sets/chase-sets/issues/10612), found by the set page's port. The pilot answers 404 and 502; no workaround.
4. [chase-sets/chase-sets#10614 [discovery] Tell a visitor their listing report was received (the page ignores ?reported=1)](https://github.com/chase-sets/chase-sets/issues/10614), found by the listing page's port. The pilot says it was received; no workaround.
5. [chase-sets/chase-sets#10615 [discovery] A repeat listing report shows a 500 page instead of saying it was already reported](https://github.com/chase-sets/chase-sets/issues/10615), found the same way. The pilot answers 409 with the page saying so; no workaround.

Found in Chase Sets, not Corten: the Catalog API refuses every reorder of a dimension's options.
`PUT /:id/options/:optionId` is registered before `PUT /:id/options/order`
(`bounded-contexts/catalog/features/dimensions/api/route.ts`), so `order` is read as an option id:
400 "optionId must start with chc_.". admin-web's own Reorder gets the same 400 (checked in a
browser against the dev sandbox). The pilot shows the refusal in the dialog;
`scripts/smoke-catalog.mjs` reports the step as blocked by the API, not as passed.
Filed as [#10520 Let the Catalog API reorder a dimension's options instead of refusing every reorder](https://github.com/chase-sets/chase-sets/issues/10520);
once it lands, the smoke test's reorder step should pass instead of being reported blocked.

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
