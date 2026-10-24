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
| `marketplace/` | Inventory > Storage locations, `/account/inventory/locations` | marketplace | the list (archived too), create, save and archive, and confirming a write whose answer was lost |

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
node scripts/smoke-catalog.mjs         # the catalog area: a dimension's and a field's whole life, with and without JavaScript
node scripts/smoke-live.mjs            # the catalog lists stay current while another tab writes ([..] [state] http://localhost:7752 watches admin-web's)
node scripts/measure-live.mjs pilot=http://localhost:7790 admin-web=http://localhost:7752   # what one change costs the watching tab
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/measure.mjs screen=marketplace marketplace=http://localhost:7753 pilot=http://localhost:7793
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
(`admin/defaults.json`), the design system's tokens (`platform/tokens.json`) and three fonts. CI
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

## What lives where

| Path | What |
|---|---|
| `platform/src/api.rs` | the platform API as the signed-in user (`Caller`): reads, writes with their receipt, who is asking (`identify`) |
| `platform/src/receipt.rs` | read after write: the write's receipt rides the redirect and the next read waits for it |
| `platform/src/realtime.rs` | the platform's realtime stream as the signed-in user: a tick per change to a topic, resuming from the last cursor |
| `platform/src/session.rs`, `nav.rs` | the session cookie, the color mode, and the React apps' nav rules |
| `platform/src/theme.rs`, `section.rs` | the design system's tokens, and the page header, sections and banner both screens use |
| `*/src/app.rs` | routes, access (sign-in at the React app, 403, 502), and the handlers |
| `*/src/api.rs` | the screen's calls; typed bodies with only the fields the screen reads |
| `*/src/form.rs` | what the forms post; the pilot checks only shape (text present, numbers parse), the API checks the rules |
| `marketplace/src/recovery.rs` | the write's attempt id, and confirming a write the browser did not hear back about |
| `*/src/views/` | the components, each with its stylesheet, and their scripts |
| `admin/src/catalog/` | the catalog area: its routes and handlers (`mod.rs`), the Catalog API calls (`api.rs`), the forms and the bodies admin-web sends (`form.rs`), and its views, whose stylesheets are `sections/catalog.css` |
| `*/src/tests.rs` | router tests against a stand-in platform API |

## Workarounds and decisions in the pilot

1. **Read after write.** After a write, the pilot sends the write's receipt
   (`Chase-Sets-Read-After-Write`) and, while the API's projection catches up, answers as the
   React app does: admin 503 "preparing, refresh in a moment"
   ([`read_failed`](admin/src/app.rs)), marketplace the page with "still updating" and no list,
   or 409 "could not be verified" when the read fails for good
   ([`render`](marketplace/src/app.rs)). This is Chase Sets' consistency protocol, not Corten's.
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
   attempt after the redirect. Corten has no per-submission idempotency key for forms; see Corten
   gaps.
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
14. **Not ported**: bulk lifecycle changes (the selection, preview, confirm and job progress), a
    larger slice of its own.
15. **The lifecycle forms' button is named `step`, not `action`**: see Corten gaps.
16. **The lists are live**, as admin-web's are (`useCatalogRealtimeRevalidation` on the
    dimensions and fields lists; their detail pages are not live in admin-web either). The rows
    and pager are a `<corten-live>` whose route (`/catalog/dimensions/live`, with the list's
    filters and page) follows the Catalog topic `catalog:admin:dimensions` on the platform's
    realtime stream, as the signed-in user, and on each change reads the list again and sends the
    rows it draws ([`live_rows`](admin/src/catalog/mod.rs)). Changes within 150 ms are one read,
    as admin-web debounces. The browser runs no script of the pilot's for it; what was typed in the
    filters stays. The platform's stream protocol is Chase Sets', so its client is the pilot's
    ([`realtime`](platform/src/realtime.rs)). `scripts/smoke-live.mjs` checks it in a browser.

## Corten gaps

Open, filed in Corten (one gap each):

1. [todd-skelton/corten#9 Forms have no per-submission idempotency key](https://github.com/todd-skelton/corten/issues/9)
   (correctness). Corten's rule 3 asks actions to
   carry one, but a `data-patch` form cannot get one from Corten, and the runtime aborts a pending
   submit when a newer one differs, which does not stop the first write on the server. The
   pilot's workaround is item 7 above.
2. [todd-skelton/corten#13 A control named action or method breaks a data-patch form](https://github.com/todd-skelton/corten/issues/13)
   (correctness). The catalog's
   lifecycle buttons were `<button name="action" value="activate">`, as admin-web's handler
   names its argument. In a form, `form.action` is then the named control (a DOM rule from
   before HTML5), so the runtime's `new URL(submitter?.getAttribute("formaction") || form.action)`
   posts to `/catalog/dimensions/[object HTMLButtonElement]`: a 405, the error page, and no
   write. Without JavaScript the browser posts to the right URL, so only the JavaScript path
   breaks. Checked in Chromium: `form.action` is the button and `form.method` the input when
   controls carry those names. Expected: the runtime resolves the form's own action and method
   (from the attribute, against the page's URL), or `corten dev` flags the name. Workaround: the
   field is `step` ([`ActionInput`](admin/src/catalog/form.rs)), and a router test asserts no
   catalog page has a control named `action`.
3. [todd-skelton/corten#15 A <corten-live> stream cannot resume after a reconnect](https://github.com/todd-skelton/corten/issues/15)
   (correctness, then performance). `corten::live` events carry no `id`, so a reconnect sends no
   `Last-Event-ID` and the route cannot tell it from a first connection. Workaround: the live
   lists draw their rows on every connection, so each page view and reconnect costs one more
   Catalog list read and render (`live_rows`); a dropped connection is then never left showing
   rows that changed meanwhile.

Found in Chase Sets, not Corten: the Catalog API refuses every reorder of a dimension's options.
`PUT /:id/options/:optionId` is registered before `PUT /:id/options/order`
(`bounded-contexts/catalog/features/dimensions/api/route.ts`), so `order` is read as an option id:
400 "optionId must start with chc_.". admin-web's own Reorder gets the same 400 (checked in a
browser against the dev sandbox). The pilot shows the refusal in the dialog;
`scripts/smoke-catalog.mjs` reports the step as blocked by the API, not as passed.
Filed as [#10520 Let the Catalog API reorder a dimension's options instead of refusing every reorder](https://github.com/chase-sets/chase-sets/issues/10520);
once it lands, the smoke test's reorder step should pass instead of being reported blocked.

Closed:

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
