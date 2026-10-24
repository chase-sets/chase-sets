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
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
node scripts/measure.mjs screen=marketplace marketplace=http://localhost:7753 pilot=http://localhost:7793
corten check                           # at the workspace root: cargo fmt, corten fmt, clippy -D warnings, cargo test
```

Run `corten dev` inside the app's directory. It watches only that directory, so an edit in
`platform/` needs a save in the app (or a restart) to rebuild; see Corten gaps.

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

## What lives where

| Path | What |
|---|---|
| `platform/src/api.rs` | the platform API as the signed-in user (`Caller`): reads, writes with their receipt, who is asking (`identify`) |
| `platform/src/receipt.rs` | read after write: the write's receipt rides the redirect and the next read waits for it |
| `platform/src/session.rs`, `nav.rs` | the session cookie, the color mode, and the React apps' nav rules |
| `platform/src/theme.rs`, `section.rs` | the design system's tokens, and the page header, sections and banner both screens use |
| `*/src/app.rs` | routes, access (sign-in at the React app, 403, 502), and the handlers |
| `*/src/api.rs` | the screen's calls; typed bodies with only the fields the screen reads |
| `*/src/form.rs` | what the forms post; the pilot checks only shape (text present, numbers parse), the API checks the rules |
| `marketplace/src/recovery.rs` | the write's attempt id, and confirming a write the browser did not hear back about |
| `*/src/views/` | the components, each with its stylesheet, and their scripts |
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
3. **One guard covers each app** (`App::guard` in each `app.rs`): admin lets staff with
   `postage-policies.view` in; marketplace lets sellers with `inventory.view` read and those with
   `inventory.manage` write (`req.writes()`). Anyone else with a session gets a 403, a session the
   API could not look up gets a 502 (signing in again would loop while it is down), and no session
   signs in at the React app. A write whose API call says the session ended meanwhile still signs
   in from the handler.
4. **Every write is its own route** (`/revise`, `/archive`, ...) where the React apps post one
   form with an `intent`; admin's preview button posts the revise form to `/preview` with
   `formaction`.
5. **admin's sheet is a `<dialog open>`** that works without JavaScript; its script reopens it as
   a modal and lets Escape follow the close link. Confirmations use `command="show-modal"`.
6. **Sign-in returns to the React app's copy of the screen**: both only return to their own paths.
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

## Corten gaps

Open, sent to the Corten thread to fix in the framework (one gap each):

1. **Forms have no per-submission idempotency key** (correctness). Corten's rule 3 asks actions to
   carry one, but a `data-patch` form cannot get one from Corten, and the runtime aborts a pending
   submit when a newer one differs, which does not stop the first write on the server. The
   pilot's workaround is item 7 above.
2. **`corten dev` does not rebuild for a path dependency** (developer loop). It watches the
   current directory only, so in a workspace an edit in `platform/` does not rebuild the app.
   Workaround: save a file in the app, or restart `corten dev`.
3. **A navigation the runtime takes over before the page has loaded stops the page loading**
   (correctness). The recovery script submits the hidden check form (a GET form) from
   `on:connect`, which runs before `load`; the runtime intercepts that navigation, and in
   Chromium the first document's `load` never fires (`loadEventEnd` 0). Workaround: the script
   waits for `load` before it submits ([`restore`](marketplace/src/views/recovery.js)).

Closed:

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
