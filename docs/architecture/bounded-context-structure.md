# Bounded Context Structure

This document owns the repository structure rules for implemented bounded contexts. The strategic context map lives in [bounded-contexts/README.md](../../bounded-contexts/README.md).

## Rules the structure gate enforces

Use this section as the lookup table when `pnpm run check:structure` fails. Each rule names what is checked, why the gate cares, and the usual repair.

| Rule | What the gate checks | Why | Fix |
| --- | --- | --- | --- |
| R01 top-level roots | Repository root directories must be one of `artifacts`, `bounded-contexts`, `contracts`, `deployables`, `docs`, `infrastructure`, `node_modules`, `packages`, `scripts`, or `secure`. | Keeps ownership discoverable at the first directory level. | Move new code under the owning bounded context, contract, infrastructure adapter, deployable, package, or docs area. |
| R02 retired paths and workspace directories | Hard-coded retired artifacts, including old deployables, zombie workspace directories, old generated deployable scripts, `contracts/dev-seeds`, `contracts/sellable-units`, and the catalog authoring package, must not exist. Each child directory under a workspace glob (`bounded-contexts/*`, `contracts/*`, `infrastructure/*`, `packages/*`, `deployables/*`) must either declare `package.json`, be a bounded context package with `context.json`, or be an approved non-package infrastructure container. | Prevents deleted architecture from creeping back in under familiar names and stops ignored `node_modules` husks from masquerading as contexts/packages. | Delete the artifact, add the missing manifest/package, or move behavior to the current manifest-driven surface. |
| R03 tracked temp artifacts | Tracked source-like `.tmp` files and `*.ts.tmp`, `*.tsx.tmp`, or `*.json.tmp` files are forbidden. | Temporary files hide decisions and often bypass tests. | Delete the temp file or rename it into a real, owned source/test/doc file. |
| R04 workspace test script coverage | Any workspace containing runnable tests must expose a test script, and TypeScript tests must be covered by root `test:typecheck`/`verify:typecheck` or a workspace typecheck script. | Tests in a package must run in CI and typecheck with the package. | Add `test`, `test:unit`, or `test:db`; add typecheck coverage when the workspace owns TS tests. |
| R05 workspace tsconfig extends | Workspace `tsconfig.json` files must parse, extend root `tsconfig.base.json` or `tsconfig.vitest.json`, and get `vitest/globals` from `tsconfig.vitest.json`. | Keeps compiler settings centralized and prevents test globals from leaking into production configs. | Change the `extends` target to the root config and remove local one-off Vitest globals. |
| R06 design-system dead exports | Root `@chase-sets/design-system` value exports need production consumers unless they are allowlisted with a reason; stale allowlist entries fail too. | The design system is canonical, but unused public atoms still become API surface. | Delete unused exports, add a one-line allowlist reason, or remove stale allowlist entries. |
| R07 work-signal primitives | Direct `pg_notify`, `LISTEN`, and Postgres wake-signal primitive usage is limited to the approved platform-runtime/event-core files. | New wake paths must use the platform work-signal composite instead of ad hoc listeners. | Move the primitive use behind `infrastructure/platform-runtime/work-signal-composite.ts` or add an owned, documented exception in the guard test. |
| R08 context manifest exists | A directory under `bounded-contexts/` with `package.json` must also have `context.json`. | Implemented bounded contexts are manifest-owned. | Add `context.json` or remove the package if the context is not implemented. |
| R09 manifest required fields | `context.json` must declare `contextName`, `packageName`, `ownedNouns`, `streamPrefix`, `apiBasePath`, `slices`, `allowedSupportDirectories`, `publicExports`, `allowedContextDependencies`, `seedRequirements`, `hostPorts`, `apiDeployables`, `apiMounts`, `deployableContributions`, `shellContributions`, and `directoryIntent`. | Composition, import checks, and docs all read the same manifest contract. | Add the missing field using the slim current schema; do not restore retired ceremony fields from old issues. |
| R10 manifest scalar shapes | `contextName` must be non-empty, `ownedNouns`/`slices`/support/dependency/seed/deployable lists must be string arrays, `streamPrefix` must end in `.`, and `apiBasePath` must be absolute. | Invalid manifest primitives make ownership and route mounting ambiguous. | Correct the type/value in `context.json`; for example, use `"/api/marketplace"` for an API base path. |
| R11 package name agreement | `context.json.packageName` must match the bounded context `package.json` name. | Package imports are the enforced public boundary. | Rename one side so both use the same `@chase-sets/<context>` package name. |
| R12 umbrella slice names | Slice names `authoring`, `customer`, and `items` are forbidden. | Slices must be concrete capabilities or journeys, not vague role/object buckets. | Rename to the specific capability, such as `source-observations`, `sessions`, or `catalog-items`. |
| R13 support directory names | `allowedSupportDirectories` must be unique, must not overlap `slices`, and must use `*-support` except `tests`. | Shared helpers need explicit intent and a recognizable support shape. | Rename generic entries to names like `route-support`, `request-support`, `seed-support`, or `projection-support`. |
| R14 planned support directories | `plannedSupportDirectories`, when present, must be a string array and may reference only declared support directories. | Planned support is a temporary declaration for a real support seam, not a backlog bucket. | Either create `support/<name>/`, list the already-declared support directory as planned, or remove the declaration. |
| R15 retired manifest fields | `requiredPorts`, `integrationCapabilities`, and `apiRequirements` are rejected. | Those fields encoded old integration ceremony outside the current event/host/server model. | Replace them with `hostPorts`, `eventSubscriptions`, `projectionGroups`, and `./server` surfaces. |
| R16 directoryIntent schema | Each `directoryIntent` entry must be an object with only `classification`, `purpose`, `expectedConsumers`, and optional `crossCuttingRuntimeComposition`. | The manifest now carries only load-bearing structure metadata. | Remove old prose fields such as `allowedWhen`, `createdFor`, `justification`, or `sunsetWhen`. |
| R17 directoryIntent required values | `classification` must be `slice`, `support`, or `routes`; `purpose` must be non-empty; `expectedConsumers` must be a non-empty string array without duplicates. | Intent metadata must be specific enough for drift checks. | Fill the fields with actual consumers and a context-specific purpose. |
| R18 directoryIntent placeholder and specificity | `purpose` must not use placeholder tokens like `TBD`, `TODO`, `unknown`, or `misc`; weak purpose text warns if it names no context term, noun, or slice. | Placeholder manifest text becomes permanent architecture. | Use a short concrete purpose such as "Own checkout session route support for sessions and sell-list." |
| R19 directoryIntent declared directory mapping | Every slice, support directory, and `routes` must have matching `directoryIntent`, correct classification, and an existing bucketed directory except implicit `routes`. | The manifest must match the actual tree. | Add or fix the intent entry, create `features/<slice>/` or `support/<name>/`, or remove stale manifest metadata. |
| R20 routes are implicit support | `routes` must be represented as `directoryIntent.routes`, not as `allowedSupportDirectories`. | Route adapters are a top-level bucket, not support code. | Remove `routes` from `allowedSupportDirectories` and add `directoryIntent.routes` with `classification: "routes"`. |
| R21 support existence or plan | Declared support directories must exist under `support/` unless listed in `plannedSupportDirectories`. | Contributors should not have to guess whether a support seam is real. | Create `support/<name>/`, mark it planned temporarily, or remove it. |
| R22 cross-cutting runtime support | `crossCuttingRuntimeComposition: true` is allowed only for `auth-support`, `request-support`, and `seed-support`, and it is the only way support intent can omit expected consumers. | Only a small set of runtime composition seams are truly cross-cutting. | Add expected consumers or move the code to an approved runtime composition support directory. |
| R23 root bucket shape | Bounded context top-level directories must be `features`, `support`, `routes`, optional `tests`, optional `docs`, or the temporarily allowed nested `deployables` bucket. | Context roots should show behavior, support, route adapters, tests, and docs only. | Move code into `features/<slice>/...`, `support/<name>/...`, `routes/`, or top-level `deployables/`. |
| R24 canonical root files | Bounded context root files are limited to canonical entrypoints/docs such as `context.json`, `package.json`, `index.ts`, `api.ts`, `client.ts`, `server.ts`, `web.ts`, `README.md`, `GLOSSARY.md`, and `ids.ts`. | Loose helpers at the root hide ownership. | Move helper code into a slice or support directory. |
| R25 implemented context docs | Implemented bounded contexts must define `README.md` and `GLOSSARY.md`. | Each context owns its local behavior and ubiquitous language. | Add the two docs at the context root. |
| R26 generic context folders | Directory names `infrastructure` and `shared` are forbidden inside bounded contexts. | Generic buckets hide responsibility. | Rename to purpose-specific support such as `projection-support` or move code into the owning slice. |
| R27 retired context integration directories | Bounded context root `integration/` directories and `integration.ts` surfaces are retired. | Cross-context access now goes through provider `./server` surfaces or events. | Move request-time adapters to `server.ts`/support and downstream data sharing to projections. |
| R28 nested bounded-context deployables | `bounded-contexts/<context>/deployables` is retired for new structure. | Deployables must remain thin top-level composition roots. | Move deployable code under top-level `deployables/` and keep context behavior in the context. |
| R29 docs are documentation-only | Source files under `bounded-contexts/<context>/docs/` fail. | Context docs must not become hidden runtime modules. | Move runtime code into `features/`, `support/`, or `routes/`; keep docs as Markdown and assets. |
| R30 feature bucket mapping | Every `features/<slice>/` directory must map to a declared slice, and every declared slice must exist under `features/`. | Feature-first structure only works when manifest and tree agree. | Add/remove the slice declaration or create/move the directory. |
| R31 feature internals | Feature roots must contain only `api`, `domain`, `integrations`, `read-model`, `tests`, and `ui`, and no loose files. | Slice internals should be predictable and locally owned. | Move files under the right subfolder; do not create one-off subdirectories. |
| R32 support bucket mapping | Every `support/<name>/` directory must be declared in `allowedSupportDirectories`. | Support code is shared by declaration, not by accident. | Add the support directory to the manifest with intent, or move single-slice code back into its slice. |
| R33 support consumer metadata | Support imports from feature slices must have matching `directoryIntent.expectedConsumers`; missing support metadata or consumer drift fails. | Shared support needs explicit consumers so it can be retired when it stops being shared. | Update `expectedConsumers` to actual slice names or relocate the support file. |
| R34 single-slice support | Support files imported by only one slice warn by default, fail when `STRUCTURE_SINGLE_SLICE_SUPPORT_ENFORCEMENT=violation`, and the metrics warning tracks the count. | Single-consumer support is usually misplaced slice code. | Move it to `features/<slice>/...`; #1501 removed Identity `read-model-support` when its last shared use disappeared. |
| R35 single-slice allowlist hygiene | `singleSliceSupportFileAllowlist` entries must have `file`, `owner`, and ISO `removeBy`; expired entries fail, and CI requires an explicit env flag or PR label if the list is non-empty. | Temporary support debt must stay owned and time-boxed. | Fix the entry, remove expired debt, or use the temporary-debt label only while actively migrating. |
| R36 route support placement | Loader/action support modules must live under `support/route-support/<route-name>/`, except approved cross-cutting runtime support. | Route-owned behavior should not be buried in request or shell support. | Move route loader/action helpers to `route-support`; #1534 moved the catalog integrations route into a thin `routes/` adapter plus adjacent route modules. |
| R37 `routes/` adapter exports | Production files under context `routes/` must export route adapters: `loader`, `action`, `meta`, `headers`, or a default component. | `routes/` is for deployable route modules, not arbitrary helper code. | Move helpers to slice/support folders and leave a thin route adapter. |
| R38 route and shell composition imports | `routes/` and `shell-support` modules must stay composition-only: no domain/query/projection/read-model imports and no unapproved bounded-context package imports. | Route/shell code should wire slice adapters, not reach into internals. | Create a slice-local route adapter and import that; keep deployable-facing imports explicit. |
| R39 context public exports declaration | `package.json` exports must be declared in `context.json.publicExports`, and every declared public export must exist, be supported, and resolve to a source file. | Public package API is the context contract. | Add the export to both files or remove the unused/stale surface. |
| R40 supported public surfaces | Public surfaces are limited to `.`, `./context`, `./client`, `./server`, `./web`, `./routes/*`, `./seed-support/*`, and Auth `./host-config`; `./integration/*` is forbidden. | Keeps cross-context contracts small and named. | Use `./server` for request-time access, `./routes/*` for deployable routes, and events for downstream data. |
| R41 context root index | Context root `index.ts` may export only `contextManifest` and `module`, and must not re-export secondary public surfaces. | The root is the deployable plug-in contract, not an aggregate barrel. | Remove `client`, `server`, `web`, and `seed-support` re-exports from root index. |
| R42 non-root public surfaces | `client.ts`, `server.ts`, and `web.ts` must not export `contextManifest`, and declared surfaces cannot be placeholder-only. | Each public surface must carry its own stable purpose. | Put the manifest export only in `index.ts`; delete empty surfaces or add real contract exports. |
| R43 client surface safety | `client.ts` must remain browser-safe: no request-scoped API/integration client factories and no presentation-named `ui/contracts` exports. | Browser clients should not expose server/request helpers or UI folder names. | Export DTOs/errors/browser-safe clients from neutral names, and keep request clients on `./server`. |
| R44 web surface safety | `web.ts` may export only shell, provider, browser-entry, `shell-support`, or `ui-support` modules, and must not export API client factories/errors. | Web surfaces are deployable-facing UI composition, not transport API. | Move API clients/errors to `client.ts` or `server.ts`; keep web exports to shell/browser providers. |
| R45 client consumer proof | A context must not export `./client` without at least one external production consumer. | Avoids speculative public client APIs. | Remove `./client` from `publicExports` and `package.json`, or add the real external consumer. |
| R46 same-context public surface imports | Same-context code may not import its own `./client`, `./server`, or retired `./integration` public surface except `host-config.ts`. | Internal code should use local modules instead of round-tripping through public API. | Replace the package/self-surface import with a relative slice/support import. |
| R47 bounded context to deployable imports | Bounded contexts must not import deployables. | Deployables compose contexts; contexts cannot depend upward on hosts. | Move shared behavior into the context, contracts, or infrastructure and inject host details through declared ports. |
| R48 cross-context imports | Non-test, non-seed context code cannot import another bounded context unless it uses an allowed explicit surface and the manifest declares the dependency. | Cross-context coupling must be intentional and visible. | Add `allowedContextDependencies` only for approved `./server` use from API, request, route, or UCP support, approved route/web use, or subscribe to events and project local data. |
| R49 catalog runtime dependency | Non-Catalog bounded contexts must not depend on or import `@chase-sets/catalog` outside tests; catalog seed fixtures live in `@chase-sets/catalog-seed`. | Catalog is high-churn and should not expand runtime blast radius. | Use seed fixtures for tests or own the small local mapping/version-key logic. |
| R50 retired integration imports | API deployables and bounded-context code must not import retired bounded-context `./integration` surfaces; feature modules cannot directly import another context integration surface. | Integration barrels were the old cross-context escape hatch. | Use provider `./server` surfaces in route/request support or model downstream reads from published events. |
| R51 contracts purity | `contracts/` must not import bounded contexts, deployables, infrastructure, packages, React, React Router, Hono, or read `process.env`. | Contracts must stay runtime-neutral shared language. | Move runtime adapters out of contracts and pass environment/config through callers. |
| R52 infrastructure purity | Shared `infrastructure/` outside `platform-runtime` must not import bounded contexts, deployables, or packages. | Infrastructure owns technical adapters, not domain behavior. | Invert the dependency: expose generic adapters and let contexts compose them. |
| R53 packages domain agnosticism | `packages/` must not import bounded contexts, deployables, or infrastructure. | Shared packages should be reusable primitives, not hidden domain modules. | Move domain behavior into the owning context or publish a tiny contract. |
| R54 deployable import boundaries | Deployables must use package imports, not relative source paths into workspaces, and must consume only approved public context entrypoints. | Deployables are thin composition roots. | Replace `../../bounded-contexts/...` with `@chase-sets/<context>` public exports. |
| R55 deployable tests and clients | Deployable tests must not depend on bounded-context `./client` surfaces. | Host tests should verify composition, not couple to context browser clients. | Test through route composition or context-owned tests. |
| R56 runtime script imports | Runtime source cannot import `scripts/`; tests, seeds, configs, and scripts are exempt. | Script helpers are not production API. | Move reusable runtime code into a package, infrastructure, or context support module. |
| R57 deployable build configs | Deployable Vite/Vitest configs must use `createWorkspaceSourceAliases` and must not hard-code workspace source paths. | Alias behavior should stay centralized. | Replace local alias maps with the shared helper. |
| R58 web auth wrappers | `deployables/admin-web/app/auth.server.ts` and `deployables/marketplace/app/auth.server.ts` must use `defineAuthHost`. | Auth host behavior should be shared and consistent. | Compose auth through the shared factory. |
| R59 deployable composition files | API deployables must not keep `src/stack.ts`, `src/seed-stack.ts`, or local `api.server.ts` business helpers. | Stacks are manifest-generated/composed, not hand-maintained per host. | Move behavior into bounded contexts and compose from manifests. |
| R60 shell navigation modules | Hand-authored bounded-context `shell/nav.ts` modules are retired. | Shell navigation comes from manifest-driven platform runtime composition. | Model navigation through `shellContributions`. |
| R61 route contribution schema | `deployableContributions` must target known deployables, contain a routes array, and each route needs `routeId`, string `routePath`, `routeType` of `route`/`index`, optional `placement` of `root`/`layout`, and `fileExport` under `./routes/`. | The host router is manifest generated. | Fix the route metadata and point to a context-owned route adapter. |
| R62 route contribution targets | Route `fileExport` must omit file extensions and resolve to an existing route module. | Manifest route records should be stable package exports, not source filenames. | Use `"./routes/<name>"` and create the corresponding file. |
| R63 deployable route uniqueness | `routeId` and `routePath` must be unique per deployable after admin-web section identity is applied. | Duplicate route identities break generated host routing. | Rename the route id or path. |
| R64 shell contribution schema | `shellContributions` must target known web deployables/slots, use valid placements, and define key, label, icon, absolute href, numeric order, visibility, and string permissions. | Shell entries are generated and sorted from manifest data. | Correct the contribution object in `context.json`. |
| R65 shell route ownership | A shell contribution href must point at a same-context route contribution for that deployable. | Contexts should not add navigation to routes they do not own. | Add the route contribution in the same context or move the shell item to the owning context. |
| R66 shell contribution uniqueness | Shell contribution keys and hrefs must be unique per deployable slot. | Duplicate nav entries create ambiguous UI. | Rename the key or consolidate the duplicate href. |
| R67 API deployable names | `apiDeployables`, `runtimeDeployables`, and `sourceRuntimeDeployables` must use the known deployable names for their category. | Mount and runtime ownership must align with real hosts. | Use `platform-api` or `platform-worker`; use runtime profile fields for landing/proof/public selection. |
| R68 API mount shape | Contexts without API deployables must not declare mounts; API contexts need exactly one primary mount, absolute `mountPath`, valid `kind`, and boolean `requiresAuth`. | API hosts compose mounts directly from manifests. | Add or remove mounts to match the context API posture. |
| R69 event subscription schema | `eventSubscriptions` entries must be objects with source context, projection name, version, handler set names, optional event types/stream prefixes, and optional numeric order. | Projection subscriptions need stable replay metadata. | Correct the subscription shape. |
| R70 projection group schema | `projectionGroups` need unique non-empty names, source context names, owned tables, valid reset strategy, and optional boolean bootstrap flag. Side-effect-only subscription groups may set `sideEffectOnly: true`, declare `ownedTables: []`, and use `replay-only`. | Read-model ownership and rebuild behavior must be explicit; workflow/effect subscriptions that own no table must be marked so missing table ownership does not hide by accident. | Declare the projection group and table owners; for workflow/effect subscriptions that own no table, mark `sideEffectOnly: true` and keep `resetStrategy: "replay-only"`. |
| R71 subscription projection agreement | Subscriptions must reference declared projection groups, and each group's `sourceContextNames` must exactly match subscribed sources. | Source ownership drives replay and wake routing. | Add the missing group or align source lists. |
| R72 runtime co-mounting | Event subscription source contexts and seed requirements must reference known contexts mounted in the same runtime/API deployable. | A runtime cannot consume events or seed data from a context that is not present. | Add the provider context to the same deployable/runtime or remove the dependency. |
| R73 host ports | `hostPorts` entries must be objects with `portName`, `providedBy`, and `purpose`. | External runtime dependencies belong in explicit host ports. | Add a concise host-port record naming the provider and purpose. |
| R74 Auth/Identity ownership extraction | Identity must not declare `auth-support`, own `session`, or declare a `sessions` slice; Auth must own `authentication`, `session-journey`, and `account-selection`. | Auth owns authentication/session behavior after the extraction. | Move session/auth behavior to Auth and update both manifests. |
| R75 Payments ordering projection | Payments must declare an ordering-backed `payments-order-input-projection` subscription and projection group. | Payments reads Ordering facts through a local projection. | Add the Ordering event subscription and projection group metadata. |
| R76 read freshness route schema | `readFreshnessRoutes` must be arrays of objects with mount-relative absolute `routePath`, optional GET/HEAD methods, and non-empty dependency arrays. | Fresh read waits are declared at the API route. | Add the route declaration on the API mount. |
| R77 read freshness dependency schema | Each freshness dependency must be an object declaring exactly one of `projectionName` or `readModelTable`; optional `targetContextName` must be a string. | Exact freshness waits need an unambiguous projection or table. | Pick one dependency target and point cross-context waits at the owning context. |
| R78 freshness route existence | A freshness route path must match a discovered GET/HEAD API route. | Manifest freshness cannot refer to a route that the API does not expose. | Correct the path or add the GET/HEAD route handler. |
| R79 freshness dependency ownership | Freshness dependencies must point at declared projection groups or read-model tables owned by exactly one projection group. | The waiter needs one owner for each dependency. | Add the projection group/table owner or fix the dependency name. |
| R80 read-after-write inventory schema | `readAfterWriteRouteInventory` entries must be objects with unique `id`, `owner`, supported risk, source and destination objects, and valid section fields. | Post-write freshness needs an owned inventory. | Fill the entry with `critical`, `important`, `internal`, or `informational` risk and valid source/destination sections. |
| R81 inventory route references | Source/destination route IDs must reference deployable routes; non-exception source/destination sections need route IDs. | Freshness inventory ties browser routes to manifest route contributions. | Point to real route IDs or add the missing contribution. |
| R82 inventory helper usage | `helperUses` must be non-empty valid helper names when present, and claimed helpers must actually appear in the production route/file. | The inventory must match code that carries or consumes fresh-write tokens. | Use `appendFreshWriteToken`, `appendFreshWriteTokenFromSources`, or `loadFreshlyWrittenResource` only where the file really uses it. |
| R83 inventory exceptions | Exceptions need a supported status, reason, owner, and ISO `reviewBy` date. | Exceptions are temporary migration records, not silent bypasses. | Use `accepted`, `not-read-model-backed`, or `not-post-write-read` with owner/reason/review date. |
| R84 inventory destination freshness | Non-exception destinations need `transientRecovery`, `apiContextName`, `apiRoutePath`, and declared read-model/projection dependencies that match the API freshness route. | The destination route must own safe temporary recovery. | Add route-owned recovery text and align destination dependencies with `readFreshnessRoutes`. |
| R85 helper coverage inverse | Production use of fresh-write helpers must be mapped to a manifest route contribution or file-level inventory exception. | Token-carrying routes cannot be invisible to the freshness audit. | Add a `readAfterWriteRouteInventory` entry or exception for the route/file. |
| R86 freshness route inventory coverage | Every `readFreshnessRoutes` entry must be referenced by `readAfterWriteRouteInventory`. | API freshness waits need a browser/source-route story. | Add an inventory row for the source-to-destination path. |
| R87 account capability language | Guarded code/docs cannot use retired buyer/seller capability terms except durable transaction-party identifiers. | Accounts can both buy and sell; capability language must stay account-neutral. | Rename routes, modules, DTOs, docs, and UI primitives to account-neutral terms. |
| R88 cross-context SQL reads | Non-owning contexts cannot query guarded read-model tables owned by Identity, Inventory, Ordering, or Fulfillment. | Contexts read other contexts through events and local projections. | Subscribe to owner events and persist a local projection. |
| R89 retired freshness forwarding helper | Imports from `@chase-sets/bounded-context-runtime/http` or its old relative file are forbidden. | The old helper dropped freshness state. | Import the canonical helper from `@chase-sets/platform-runtime/http`. |
| R90 durable progress transport | Request-tied NDJSON progress streams are retired, and durable job SSE routes must pass notification-backed `waitForEvents` with polling fallback. | Long-running work needs resumable durable jobs and bounded listeners. | Use durable job status/SSE events instead of request-tied streams. |
| R91 durable job storage and payload guards | Source Observation jobs must use shared durable job tables; TCGdex imports must forward per-set progress; inventory import jobs need stable `batchId`; input cleanup must retain queued/running job inputs. | Durable work must be replay-safe and lease-safe. | Use the shared durable job store, include stable IDs, forward progress, and keep active inputs. |
| R92 replay-safe job side effects | Pricing draft-listing jobs need deterministic `listingIdOverride`; durable enqueue routes must return public status snapshots; catalog authoring jobs must receive cancellation/lease-loss context. | Durable retries must not duplicate private records or ignore cancellation. | Make side effects deterministic, return public snapshots, and pass worker context into job runners. |
| R93 projection operation and SSE limits | Projection operation jobs must renew claims and reserve event sequences through the control-plane row; durable job SSE streams must use the shared in-process limiter. | Platform operations need fenced progress and bounded stream counts. | Keep the control-plane claim/event-sequence SQL and `createInMemoryDurableJobStreamLimiter`. |
| R94 database test boundaries | Only approved platform host configs/tests may use `DATABASE_URL`; DB-backed tests using `TEST_DATABASE_URL` must use per-context test-support databases and must not compose multiple context schemas. | Tests should not accidentally share production host configuration or cross-context databases. | Use `@chase-sets/bounded-context-runtime/test-support` and per-context schemas. |
| R95 retired drawer aliases | Non-navigation `CommerceDrawer`, `FilterDrawer`, `MarketplaceFilterDrawer`, `MarketplaceMobileFilterDrawer`, and `NotificationCenterDrawer` aliases are forbidden. | The design system retired these component names. | Use `SideSheet`, `BottomSheet`, `CommerceSheet`, `ResponsiveEditSheet`, or `NotificationCenterSheet`. |
| R96 deployable and API helper retirements | Local deployable business API helpers, hand-written stacks, seed stacks, retired integration imports, and deployable tests coupled to client surfaces fail. | Deployables should compose context-owned behavior only. | Move behavior to bounded contexts, use manifest/platform composition, and test through host routes. |
| R97 mutation consistency inventory | Browser route actions, statically identifiable POST forms/fetchers, mutating API routes, and mutating API-client calls must be classified by `mutationConsistencyInventory` or staged in the #1809 baseline. Accepted fresh-write exceptions need a current remediation issue. | Product-wide writes need explicit post-write consistency strategy, and current audit debt must not disappear silently. | Add a strategy entry with proof fields, remove stale baseline rows when code is removed, or keep current migration debt linked to #1809 until bounded remediation issues replace it. |
| R98 glossary coverage | Every `context.json` owned noun and every declared event noun must resolve to a term heading in the owning context `GLOSSARY.md`; duplicate term headings across contexts require a `docs/GLOSSARY.md` `Cross-Context Disambiguation` entry; the master glossary must keep its Language Constitution, Adaptation Rules, Ratchet Rules, and Hold/Policy/Channel family rows; matched term headings need definition bodies; `[[term]]` references must resolve. The explicit alias map handles legitimate stream/manifest variants, and the allowlist ratchets existing gaps only. | Ubiquitous language should drift no more easily than structure, docs indexes, or localization keys. | Add the missing local glossary heading and definition, add/update the master disambiguation entry for cross-context collisions or required language-family rows, add a justified alias for a legitimate variant, or remove stale rows from `scripts/check-structure/glossary-coverage-baseline.json`. |
| R99 boot schema DDL discipline | Boot `*SchemaSql` templates must stay additive (no DROP, SET NOT NULL, or UPDATE). Changed `*SchemaMigrations` ledgers must use `CREATE INDEX CONCURRENTLY`; must guard DROP/validated-constraint/type-change/TRUNCATE/RENAME DDL with `lock_timeout`; must not add NOT NULL columns with volatile or non-constant defaults; and must not tighten existing columns with `ALTER COLUMN ... SET NOT NULL` unless the same migration validates a `CHECK (column IS NOT NULL) NOT VALID` constraint first and sets `lock_timeout`. `ADD COLUMN ... NOT NULL DEFAULT <constant or stable expression>` is allowed: on PostgreSQL 11+ it is a metadata-only fast default (no rewrite, no validation scan, only a brief ACCESS EXCLUSIVE). | `SET NOT NULL` on an existing column holds ACCESS EXCLUSIVE across a full-table validation scan; under rolling-deploy reads it repeatedly hits `lock_timeout` and the bootstrap retry loop livelocks silently until the deploy quiesce kills the job (#4638). Volatile defaults (`gen_random_uuid()`, `random()`, `clock_timestamp()`) still force a full table rewrite. | For new required columns use one `ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT <constant>` statement. For tightening existing columns: `ADD CONSTRAINT ... CHECK (column IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE only), then `SET NOT NULL` behind `lock_timeout` in the same migration so PostgreSQL 12+ proves it from the validated constraint without a scan. See `docs/architecture/postgres-schema-migrations.md`. |

Semantic post-write handoffs use the same structure rules as other fresh-write paths. `appendPostWriteHandoff`, `appendPostWriteHandoffFromSources`, `readPostWriteHandoff`, `readPostWriteHandoffState`, and `evaluatePostWriteHandoff` must be covered by `readAfterWriteRouteInventory` or a dated exception, and the owning mutation remains classified as `fresh-read` in `mutationConsistencyInventory`. The handoff does not add a new `readFreshnessRoutes` shape; it only lets the destination route treat a valid unmet expectation, such as a stale `200` empty collection after add-line, as temporary while the original `afterWrite` receipt is fresh.

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
- `./server` is the provider-owned request and SSR surface for same-context use and approved cross-context API, request, route, or UCP composition
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
- `CatalogItemId`
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
- `SupportRequestId`

## Shared Display References

Display references are support-safe, human-facing labels derived from typed ULIDs with [contracts/primitives/display-reference.ts](../../contracts/primitives/display-reference.ts). They are not canonical identity.

- `OrderId` uses `ORD-<SHORTCODE>`.
- `ShipmentId` uses `SHP-<SHORTCODE>`.
- `PayoutId` uses `PYO-<SHORTCODE>`.
- `SupportRequestId` uses `SUP-<SHORTCODE>`.
- Existing checkout group references (`CSG-`) and support slice references (`CS-SL-`) stay as-is.

`SHORTCODE` is the uppercase last 8 Crockford-base32 characters of the ULID by default. Projection consumers that persist display references must enforce a UNIQUE index and, on conflict, retry with 10 then 12 suffix characters. Do not use hashes or global sequences for display-reference collision fallback. Typed ULIDs remain canonical for URLs, events, foreign keys, and cross-context references.

Catalog re-exports the shared `CatalogItemId` contract and owns its other IDs in [bounded-contexts/catalog/ids.ts](../../bounded-contexts/catalog/ids.ts):

- `DimensionId`
- `OptionId`
- `FieldId`
- `ComponentId`
- `BlueprintId`
- `CategoryId`

Catalog also owns the `SelectedOptionEntry` shape used to describe resolved product selections. Product identity is `(catalogItemId, selectedOptions)`; the shared `ProductKey` in [contracts/primitives/catalog-identity.ts](../../contracts/primitives/catalog-identity.ts) types the derived `productId` wire field without treating it as a shared typed ID.
