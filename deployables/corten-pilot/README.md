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
| `admin/` | Catalog > a Catalog Item's page, `/catalog/catalog-items/{id}` | admin-web | the item, its origin and readiness, publish (with Recheck) and archive, and every dialog: blueprint, description, field values (a reference field takes a record), categories, product contents, tags, image URLs, the image fallback, and both kinds of external reference |
| `marketplace/` | Inventory > Storage locations, `/account/inventory/locations` | marketplace | the list (archived too), create, save and archive, and confirming a write whose answer was lost |
| `marketplace/` | Inventory > Restock decisions, `/account/inventory/restock-decisions` | marketplace | the pending decisions, Restock and Write off (with a damage note), a refusal drawn again at the current version, and confirming a write whose answer was lost |
| `marketplace/` | Buy > Cart, `/account/cart` | marketplace | the account's cart as the Checkout API reads it: each line (merged by product and fulfillment) with its badge, options, lock or preference, seller and price, the one notice (what needs attention, or the lower price), the totals and the checkout bar and Check out and Use lower price, which start the checkout session and send the buyer to marketplace's checkout; each line's quantity step, Remove and Lock this listing, as the Checkout API's command attempts (not ported yet: the guest cart, and the checkout pages after it) |
| `marketplace/` | An item's page, `/items/{slug}` | marketplace | anyone (a session only marks the viewer's own offers): the item, its picture, Buy and Sell, the product options as links (a GET form for a long list), the market summary, the rail with the listing or offer chosen, and the market book's Listings, Offers and Details, each choice in the address; an id or an old slug moves to the slug (301), an unknown item is a 404. Buying from the rail: Add listing to Buy Cart, Add product to Buy Cart and Buy best match (cart command attempts, to the account's cart or a guest's), and Buy this listing (a checkout session, then marketplace's checkout); Make an offer (the price, currency and quantity checked, then marketplace's offer checkout). Selling from the rail: the selected offer's payout for a guest (the API's standard terms), Accept offer (Sell now for a seller, else Add offer to Sell List) and Add product to Sell List, to the account's sell list or a guest's, then marketplace's sell list. Watching from the rail: Watch listings and Watch offers (an alert with an optional price), saved to the account, or for a guest as an intent claimed after marketplace's registration (not ported yet: listing at a price, which the rail sends to marketplace's page; the Sales tab; the gallery past the first picture; similar items; the reference dialog; the mobile action bar) |

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
node scripts/smoke-market-item.mjs    # an item's page beside the API and marketplace's: a guest without JavaScript, the collector with it, options, a long-list form, Select, sell, 301, 404, 390 px (only reads)
node scripts/smoke-market-item-buy.mjs http://localhost:7793  # the rail's buy forms: listing, product, Buy best match (a refusal too), Buy this listing, Make an offer (a price past the field's step, then marketplace's offer checkout), a guest's cart and checkout, 390 px with every fold open (writes cart lines and removes them; starts checkout sessions)
node scripts/smoke-market-item-sell.mjs http://localhost:7793  # the rail's sell forms: a guest's payout and adds, a seller's Sell now, a collector refused, 390 px (writes sell-list lines and removes them)
node scripts/smoke-market-item-watch.mjs http://localhost:7793  # the Watch tab: a guest's intent and marketplace's registration, the collector's alert with the catalog's words and the saved notice, a threshold past the field's step, 390 px (writes an alert and deletes it; a guest intent expires on its own)
node scripts/smoke-restock.mjs         # restock decisions: the API's list, a stale version refused, an uncertain write, no JavaScript, 390 px (records no decision)
node scripts/smoke-catalog.mjs         # the catalog area: a dimension's and a field's whole life, with and without JavaScript
node scripts/smoke-live.mjs            # the catalog lists stay current while another tab writes ([..] [state] http://localhost:7752 watches admin-web's)
node scripts/smoke-bulk.mjs            # bulk lifecycle changes on the dimensions list, with and without JavaScript
node scripts/smoke-items.mjs           # the catalog items list: create, the changes count, a bulk edit, removing drafts, 390 px
node scripts/smoke-item.mjs            # a catalog item's page: a draft through every dialog, with and without JavaScript, 390 px
node scripts/smoke-attention.mjs       # the attention queue beside admin-web's: same items, a sheet, dismiss, defer and restore, no JavaScript, 390 px (parks one item and restores it)
node scripts/smoke-scopes.mjs          # the scopes list beside admin-web's ([..] [admin-web]): same rows, the filters, View, no JavaScript, 390 px (only reads)
node scripts/measure-live.mjs pilot=http://localhost:7790 admin-web=http://localhost:7752   # what one change costs the watching tab
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/measure.mjs screen=marketplace marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=cart marketplace=http://localhost:7753 pilot=http://localhost:7793
node scripts/measure.mjs screen=item marketplace=http://localhost:7753 pilot=http://localhost:7793
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
| `91af573` | Corten `main` with [todd-skelton/corten#76 A page cannot write JSON-LD in its head since Meta was removed (an expression in <script> is escaped as HTML)](https://github.com/todd-skelton/corten/issues/76), [todd-skelton/corten#77 A view that is one component cannot pass a reference to its own locals (E0515 since the document change)](https://github.com/todd-skelton/corten/issues/77) and [todd-skelton/corten#78 An area's routes cannot name their handlers (#[corten::routes] covers only App::new)](https://github.com/todd-skelton/corten/issues/78) closed ([todd-skelton/corten#80 JsonLd, views that own their lets, and routes modules for areas](https://github.com/todd-skelton/corten/pull/80)), each adopted (see Corten gaps). No breaking change for the pilot: `<script>` and `<style>` now refuse an expression at compile time, and the pilot wrote none after its `JsonLd` was removed. Only the item area moved to an area routes module; the cart, inventory, postage and catalog areas keep `.route::<R>()` calls, which Corten still accepts; moving them is mechanical and checks nothing new |

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
| `marketplace/src/watching.rs` | the item page's Watch writes: an account's alert or a guest's intent for the product the page showed, the threshold's checks, and what the page says after each |
| `marketplace/src/selling.rs` | the item page's sell writes: the sell-list line built from the item read again (an offer or a product), the guest sell list, the payout terms, and what the page says after each |
| `marketplace/src/buying.rs` | the item page's buy writes: the cart line built from the item read again, the guest cart, Buy best match, Buy this listing, and what the page says after each |
| `platform/src/money.rs` | what an amount the APIs send is (decimal text, at most two fraction digits, read as cents); Corten writes it (`t.money`) |
| `*/src/views/` | the components, each with its stylesheet, and their scripts |
| `admin/src/catalog/` | the catalog area: its routes and handlers (`mod.rs`), the Catalog API calls (`api.rs`), the forms and the bodies admin-web sends (`form.rs`), and its views, whose stylesheets are `sections/catalog.css` |
| `admin/src/catalog/views/bulk_rows.*`, `bulk_dialogs.rs` | bulk changes: the bar and the rows' boxes (the selection's script), and the preview and job dialogs |
| `admin/src/catalog/items.rs`, `views/item_list.rs`, `views/item_form.css` | the catalog items list: its routes, the changes count, the three bulk changes and removing drafts |
| `admin/src/catalog/item.rs`, `views/item_page.rs`, `views/item_page.css` | a catalog item's page: its reads, one route per write, and its sections and dialogs |
| `admin/src/catalog/scopes.rs`, `views/scope_list.rs`, `views/scope_row_view.css` | the scopes list: its route and query, the promotion and sync of each row, and its table |
| `admin/src/catalog/attention.rs`, `views/attention_panel.*` | the Catalog attention queue on the scopes list: an item's sheet, the park and restore routes, the alias commands, and the queue's messages by key |
| `admin/src/catalog/views/live_status.*` | the items list's stream: Live, Connecting… or stale with Reload (CSS on `<corten-live>`'s `status`) |
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
3. **Guards.** marketplace has one guard (`App::guard`): sellers with `inventory.view` read and
   those with `inventory.manage` write (`req.writes()`). admin's app guard lets any signed-in staff
   member in, and each area asks for its own permission (`Area::guard`): postage
   `postage-policies.view`, the catalog `catalog.view` to read and `catalog.manage` to write, as
   the platform API asks for them. Anyone else with a session gets a 403, a session the API could
   not look up gets a 502 (signing in again would loop while it is down), and no session signs in
   at the React app. A write whose API call says the session ended meanwhile still signs in from
   the handler.
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
    Enter from removing the first row.
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

## Corten gaps

Open, filed in Corten (one gap each): none at the `91af573` pin.

Found in Chase Sets, not Corten: the Catalog API refuses every reorder of a dimension's options.
`PUT /:id/options/:optionId` is registered before `PUT /:id/options/order`
(`bounded-contexts/catalog/features/dimensions/api/route.ts`), so `order` is read as an option id:
400 "optionId must start with chc_.". admin-web's own Reorder gets the same 400 (checked in a
browser against the dev sandbox). The pilot shows the refusal in the dialog;
`scripts/smoke-catalog.mjs` reports the step as blocked by the API, not as passed.
Filed as [#10520 Let the Catalog API reorder a dimension's options instead of refusing every reorder](https://github.com/chase-sets/chase-sets/issues/10520);
once it lands, the smoke test's reorder step should pass instead of being reported blocked.

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
