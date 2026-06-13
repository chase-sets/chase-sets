# Bounded Context Structure

This document owns the repository structure rules for implemented bounded contexts. The strategic context map lives in [bounded-contexts/README.md](../../bounded-contexts/README.md).

## Data Ownership And Structure

Each implemented bounded context is the canonical home for its own:

- data model
- schema composition
- projections and read models
- persistence orchestration
- seeds and test support

Shared top-level `infrastructure/` is reserved for reusable technical adapters only.

Examples of shared infrastructure:

- a Postgres pool factory
- a generic event-store adapter
- a projection checkpoint adapter
- a shared queue or search client

Examples of bounded-context-owned data plumbing:

- context schema assembly
- projector fanout
- read-model queries
- projection table naming
- seed orchestration

Inside a bounded context, avoid generic feature folders such as `infrastructure`, `shared`, and ad hoc root-level helper directories.

Prefer:

- slice-local files when behavior belongs to one slice
- purpose-specific names such as `route-support`, `request-support`, `projection-support`, `shell-support`, `seed-support`, `read-models`, `projections`, or `persistence` when context-local code is reused across slices

## Feature-Default Directory Plan

Bounded contexts should read as feature-first by default.

Top-level directory intent:

- Implemented contexts use explicit root buckets: `features/`, `support/`, `routes/`, optional `tests/`, and optional `docs/`.
- Implemented context roots keep only canonical entrypoints and docs: `context.json`, `package.json`, `index.ts`, `api.ts`, `client.ts`, `server.ts`, `web.ts`, `README.md`, `GLOSSARY.md`, and `ids.ts` when the context owns typed IDs.
- `docs/` is allowed only for context-owned decision records, policy notes, or modeling deep dives that are too specific for the context README. It must not contain runtime code.
- `slices` entries in `context.json` are logical feature slices and must resolve to `features/<slice>/`.
- `allowedSupportDirectories` entries in `context.json` are logical support modules and must resolve to `support/<name>/`.
- Feature roots are directory-only seams. Keep slice code under `api/`, `domain/`, `read-model/`, `ui/`, `integrations/`, and slice-local `tests/` when needed.
- Every implemented context must define `directoryIntent` in `context.json` for each logical slice or support directory.
- `directoryIntent` is the manifest-first contract that classifies each logical directory as exactly one of `slice`, `support`, or `routes`.
- `directoryIntent` entries use the slim load-bearing schema: `classification`, `purpose`, `expectedConsumers`, and optional `crossCuttingRuntimeComposition`.
- `purpose` is a short context-specific statement of the directory's responsibility; durable rationale belongs in the context README or architecture docs instead of manifest prose.
- `expectedConsumers` must describe the slices or composition seams that really consume the directory; support-directory consumers are checked against actual imports.
- `crossCuttingRuntimeComposition` defaults to `false` when absent and may be set to `true` only for approved runtime composition support directories.
- Structure checks compare declared support-directory `expectedConsumers` with actual support file consumers and fail when they drift.
- Structure checks fail when a declared slice is missing from `features/` or a declared support directory is missing from `support/`.

Naming standard for support directories:

- Keep reusable technical helpers in `*-support` folders, for example `request-support`, `route-support`, `shell-support`, `seed-support`, or `projection-support`.
- Route-owned loader, action, form, route type, and route helper modules belong under `support/route-support/<route-name>/`; keep `routes/` modules as thin adapters and keep `request-support` for request parsing or API-client concerns that are not route-specific.
- `tests/` is the non-`*-support` root bucket exception for acceptance or structure tests that span multiple slices.
- `docs/` is the non-runtime documentation bucket for context-owned supporting notes.
- Do not place ambiguous folders like `shell`, `helpers`, or `utils` directly at the bounded-context root; keep them under `features/` or `support/`.

When structure shifts away from slice locality, such as shared route wiring or shell composition, encode the shift by creating or extending a purpose-specific `*-support` directory and declaring it in `allowedSupportDirectories`.

## Public Surface Rules

Only a bounded context root `index.ts` may export `contextManifest`.

Secondary public surfaces must be real, stable contracts. A surface should either have meaningful public value or not exist.

Allowed public surfaces:

- `.`
- `./context`
- `./client`
- `./server`
- `./web`
- `./routes/*`
- `./seed-support/*`
- `./host-config`

Surface meanings:

- `.` is the deployable plug-in contract only
- `./context` is the context manifest contract used by structure checks and composition tooling
- `./client` is browser-safe transport clients, DTOs, and API errors
- `./server` is the provider-owned request and SSR surface for same-context use and approved cross-context request composition
- `./web` is deployable-facing shell, layout, provider, and browser-entry code only
- `./routes/*` is the feature-route surface consumed by manifest-driven deployable composition
- `./seed-support/*` is seed, bootstrap, and test-only support
- `./host-config` is an Auth-specific host integration surface for authentication entry points

Private route and request helpers must stay inside the owning bounded context under explicit support folders, not as ad hoc top-level files.

## Deployable Composition

The platform host resolves route and shell composition directly from bounded-context manifests.

- Bounded contexts own the real route modules and shell contributions.
- Deployables own only host routes, layout, auth wiring, and runtime bootstrap.
- `infrastructure/platform-runtime` is the canonical projection of manifest-driven route and shell composition.

Admin web route and shell contributions must declare explicit section placement with the manifest `section` field on every admin-web route module and shell contribution.

- Use `access` for accounts, users, memberships, invitations, API keys, sessions, and concrete admin auth journeys.
- Use `catalog` for Catalog-owned admin authoring surfaces.
- Use `commerce` for Commercial Terms fee schedules, commercial agreements, deterministic commercial terms resolution surfaces, and postage policies.
- Use `growth` for public-market activation surfaces such as Google Shopping, Waitlist, and Promo Bar.
- Use `support` for support requests and platform feedback review.
- Use `platform` for cross-context platform operations such as projections, release dashboard, and release controls.

The platform runtime rejects missing or unknown admin-web section metadata. Do not rely on context-name or file-name fallback heuristics for route placement.

## Shared Typed IDs

Cross-context references should use the canonical IDs defined in shared contracts or the owning bounded context.

Shared IDs in [contracts/primitives/typed-ids.ts](../../contracts/primitives/typed-ids.ts):

- `AccountId`
- `UserId`
- `MembershipId`
- `RoleId`
- `InvitationId`
- `ConsentId`
- `ContactMethodId`
- `VerificationId`
- `CredentialId`
- `AuthenticationMethodId`
- `SessionId`
- `CheckoutSessionId`
- `ShippingAddressId`
- `ApiKeyId`
- `InventoryItemId`
- `ListingId`
- `OfferId`
- `OrderId`
- `ShipmentId`
- `ReviewId`
- `PaymentId`
- `LedgerEntryId`
- `PayoutId`

Catalog-owned IDs in [bounded-contexts/catalog/ids.ts](../../bounded-contexts/catalog/ids.ts):

- `CatalogItemId`
- `DimensionId`
- `OptionId`
- `FieldId`
- `ComponentId`
- `BlueprintId`
- `CategoryId`

Catalog also owns the `SelectedOptionEntry` shape used to describe resolved product selections. `product_id` is derived from catalog truth and used at API boundaries, but it is not currently exported as a shared typed ID.
