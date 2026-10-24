# Corten pilot: Commerce > Postage policies

A pilot port of one admin-web screen, `/commerce/postage-policies`, to
[Corten](https://github.com/todd-skelton/corten), the Rust full-stack framework, to find what
Corten lacks for a real screen with real data and auth. It is not deployed, is not part of the
platform gates or the delivery loop, and has its own CI job
([corten-pilot.yml](../../.github/workflows/corten-pilot.yml)).

It is a standalone server in front of the existing platform API. Every call forwards the
signed-in staff member's cookies, as admin-web does; sign-in, the other admin pages and all
business rules stay where they are. The pilot owns only the screen: the list, the policy sheet,
create, revise, preview, activate, retire and clone, with and without JavaScript.

## Running it

From the worktree root, with the dev system running (`node scripts/dev-system.mjs dev admin-web`):

```powershell
node deployables/corten-pilot/scripts/sign-in.mjs http://localhost:7752 artifacts/corten-pilot/admin-state.json
cd deployables/corten-pilot
corten dev --port 7790                # or: cargo run, with PORT=7790
node scripts/smoke.mjs                # every action in a browser, with and without JavaScript (writes sandbox data)
node scripts/measure.mjs admin-web=http://localhost:7756 pilot=http://localhost:7791
corten check                          # cargo fmt, corten fmt, clippy -D warnings, cargo test
```

| Variable | Default | |
|---|---|---|
| `PLATFORM_API_ORIGIN` | `http://localhost:7762` | the platform API the pilot calls |
| `ADMIN_WEB_ORIGIN` | `http://localhost:7752` | sign-in and the admin pages the nav links to |
| `PUBLIC_PROTO` | `http` | the scheme forwarded to the API as `x-forwarded-proto` |

`scripts/export.mjs` writes what the pilot reads from Chase Sets' sources: the screen's English
text (`locales/en.json`), admin-web's navigation (`nav.json`), the design system's tokens
(`tokens.json`), the default policy (`defaults.json`) and three fonts. CI runs it with `--check`,
so a change to admin-web's text, nav or tokens shows up here. `locales/pilot.en.json` is the
pilot's own text.

## Corten pin

`Cargo.toml` pins Corten to a revision. No release is tagged, and the pin moves forward only on
purpose, when a fix the pilot needs lands. While the pinned commits are not on GitHub, build with
git's `url.<local checkout>.insteadOf=https://github.com/todd-skelton/corten` and
`CARGO_NET_GIT_FETCH_WITH_CLI=true`; CI and the Dockerfile need the revision pushed.

| Revision | Why it moved |
|---|---|
| `ffa13a8` | the start |
| `01586b4` | `tokens!` themes under a media condition; `Errors::add_form` |
| `122fd5d` | `App::serve` listens on both loopback addresses |
| `028655d` | a stylesheet class may be named like its component (the pilot's renames are undone) |

## What lives where

| Path | What |
|---|---|
| `src/app.rs` | routes, access (sign-in at admin-web, 403, 502), and the handlers |
| `src/api.rs` | the platform API as the signed-in staff member; typed bodies with only the fields the screen reads |
| `src/receipt.rs` | read-after-write: the write's receipt rides the redirect and the next read waits for it |
| `src/auth.rs` | the session, the color mode, and admin-web's nav rules |
| `src/form.rs` | what the forms post; the pilot checks only shape (text present, numbers parse), the API checks the rules |
| `src/views/` | the components, each with its stylesheet, and the sheet's script |
| `src/tests.rs` | router tests against a stand-in platform API |

## Workarounds and decisions in the pilot

1. **Read after write.** After a write, the pilot sends the write's receipt
   (`Chase-Sets-Read-After-Write`) and answers 503 "preparing, refresh in a moment" while the
   API's projection catches up, as admin-web does ([`read_failed`](src/app.rs)). This is
   Chase Sets' consistency protocol, not Corten's.
2. **Business rules stay in the API.** A refusal with a message becomes the form's message
   (`Errors::add_form`), so the pilot never restates a rule ([`refused`](src/app.rs)).
3. **Access is checked in every handler** ([`staff`](src/app.rs)). Corten has no way to say a
   set of routes needs a context; see the gaps below.
4. **Every write is its own route** (`/revise`, `/activate`, ...) where admin-web posts one form
   with an `intent`; the preview button posts the revise form to `/preview` with `formaction`.
5. **The sheet is a `<dialog open>`** that works without JavaScript; its script reopens it as a
   modal and lets Escape follow the close link. Confirmations use `command="show-modal"`.
6. **Sign-in returns to admin-web's copy of the screen**: admin-web only returns to its own paths.

## Corten gaps

Filed in Corten, one gap each. Remove the workaround when the fix lands and the pin moves past it.

1. [todd-skelton/corten#2 A set of routes cannot require a context (sign-in, a permission)](https://github.com/todd-skelton/corten/issues/2)
   (correctness): `staff()` at the top of every handler in [`app.rs`](src/app.rs), and the
   test `every_route_checks_access_before_it_calls_the_api` in [`tests.rs`](src/tests.rs).
2. [todd-skelton/corten#3 FieldName is not in the prelude](https://github.com/todd-skelton/corten/issues/3)
   (convenience): `use corten::{FieldName, prelude::*}` in [`form.rs`](src/form.rs) and
   [`policy_fields.rs`](src/views/policy_fields.rs).
3. [todd-skelton/corten#4 The prelude's Result hides std::result::Result](https://github.com/todd-skelton/corten/issues/4)
   (one way to do things): `std::result::Result` in [`app.rs`](src/app.rs) and
   [`form.rs`](src/form.rs).
