# ADR 0030: Web SSR And Local-Asset Mobile Clients

## Status

Accepted for the Mobile 1 foundation in [epic #5238](https://github.com/chase-sets/chase-sets/issues/5238). This record fixes the architecture for #5246 through #5249; it does not create a mobile deployable, generate native projects, add Capacitor dependencies, or select capability plugins.

## Context

Chase Sets needs iOS and Android clients without replacing the public, indexable marketplace or creating a second UI and route model. The adoption anchor is main commit `4648a8d1b78324e2ab308f274d6eca3b85153ee5` (2026-08-22).

Current-main facts make a remote wrapper easy but a trustworthy local-assets build non-trivial:

- `deployables/marketplace/react-router.config.ts` enables React Router SSR. Its build starts `build/server/index.js`; the current build is not a static mobile artifact.
- `deployables/marketplace/app/routes.ts` projects route records from bounded-context manifests through `infrastructure/platform-runtime/web-route-config.ts`. Bounded contexts already own the contributed route IDs, paths, modules, UI, loaders, actions, clients, and tests.
- The public Discovery `search` contribution maps `/search` to `bounded-contexts/discovery/routes/search.tsx`. Its server `loader` calls `createDiscoveryRequestApiClient`; its `clientLoader` serves a session cache hit but delegates a miss to `serverLoader`. It therefore preserves fast browser restoration but is not an independent local-assets data path.
- The authenticated Identity `account` contribution maps `/account` to `bounded-contexts/identity/routes/marketplace/account.tsx`. Its `loader` calls `requireActorFromIdentityApi`, forwards the incoming web session through `createIdentityRequestApiClient`, and renders `AccountProfilePage`. Its `action` updates the account and redirects with the existing post-write receipt semantics. It has no client-only load or mutation path.
- `infrastructure/platform-runtime/http.ts` currently derives API origins and forwards web cookies, authorization, and post-write headers from an incoming `Request`. That is the correct web SSR seam, not a native session store.
- The marketplace root registers the production PWA worker. The worker caches public static assets and an offline page, skips credentialed requests, and excludes auth, account, checkout, payment, order, and API paths. Authenticated web routes are intentionally not an offline application shell.
- Repository manifests and the lockfile contain no Capacitor, Cordova, TWA, iOS, or Android application dependency. There is no Capacitor config, mobile deployable, or generated native project at the adoption anchor.

Capacitor's current configuration defines `webDir` as the compiled asset directory containing the final `index.html`, while `server.url` is documented for live reload and not production. A Trusted Web Activity renders site content from the browser and is Android-only. Apple App Review Guideline 4.2 requires an experience beyond a repackaged website. Those constraints favor a signed local-assets client with real platform integrations, not a production remote wrapper.

## Decision

### Delivery topology

Use two boot paths that project one bounded-context-owned route source:

| Concern | Web boot | Native boot |
| --- | --- | --- |
| Composition root | Existing marketplace web deployable | Future marketplace-mobile deployable |
| App code | React Router server build plus browser assets | A separate client-only build copied into Capacitor `webDir` |
| First render | Server loaders render HTML; browser hydrates that data | Local `index.html` starts immediately; client loaders call the API |
| Route authority | Bounded-context manifest contribution and route module | The same context route ID, UI, portable load/mutation operations, and tests |
| API access | Existing request-derived server clients and same-origin browser calls | A native API transport with release identity and native session credentials |
| Native capabilities | Browser adapters | Native adapters behind provider-neutral capability ports |
| PWA | Manifest and service worker remain enabled under the current web policy | No manifest route, service-worker route, registration, or CacheStorage app shell |
| Release | Web deploy and cache policy | Signed store binary pins local core assets and client contract identity |

The web deployable remains `ssr: true`. The native build is not a static export of server-rendered HTML and does not emulate an application server inside the device. It is a distinct React Router client boot whose route data arrives through APIs.

Production Capacitor configuration must point `webDir` at the locally generated native client assets and must omit `server.url`. A development-only live-reload URL may exist only in an unmistakably non-production configuration that cannot enter a signed release. Core HTML, JavaScript, CSS, route definitions, and business behavior are reviewed and signed into the store binary. Remote APIs, user data, catalog/media content, and narrowly scoped provider flows may remain remote; remote HTML or script must never replace or extend core application logic after review.

### One route source, two execution adapters

#5246 must implement the following named seams. The names describe required responsibilities; they do not authorize a new business framework or shared domain model.

- **PortableRouteDefinition** is the context-owned route record: stable route ID and path, UI component, portable load/mutation operations, delivery classification, and test fixtures. The existing `deployableContributions` route record remains the current source from which this richer contract evolves.
- **RouteLoadOperation** is slice-local, browser-safe orchestration that accepts serializable route input and context API clients/ports and returns the route's typed data. It cannot read Node state, environment secrets, or an incoming server cookie directly.
- **RouteMutationOperation** is slice-local, browser-safe orchestration that validates an intent, calls the owning API, and returns a typed outcome. Domain validation remains in the owning API/domain; route validation and presentation-ready field errors remain in the owning context.
- **RouteOutcome** is the portable discriminated result: `data`, `validation-error`, `navigate`, `unauthorized`, `forbidden`, or `resource`. Context-specific payload types stay beside the slice. It preserves post-write receipts and semantic handoffs as data for the adapter rather than assuming an HTTP redirect.
- **WebRouteAdapter** maps a portable definition to React Router server `loader`/`action`, HTTP `Response`/redirect behavior, request-cookie forwarding, SSR metadata, and hydration. Existing request clients such as `createDiscoveryRequestApiClient`, `createIdentityRequestApiClient`, `resolveRequestApiBaseUrl`, and `createForwardedAuthFetch` remain web/server adapter seams.
- **NativeRouteAdapter** maps the same definition to independent `clientLoader`/`clientAction` behavior, client navigation, a design-system loading/error fallback, native auth recovery, and the native API transport. It never calls `serverLoader`.
- **NativeRouteRegistry** projects only native-eligible PortableRouteDefinitions from the same context registry used by the web host. The mobile deployable supplies selection and adapters; it does not copy route declarations or UI.
- **ClientApiTransport** is infrastructure-owned fetch composition for absolute API origins, JSON/error handling, credentials, post-write headers, release identity, network state, and upgrade-required responses. Context-owned generated/manual API clients consume it without knowing Capacitor.
- **AuthSessionPort** is the infrastructure-level session facade used by ClientApiTransport and route authorization. Its web adapter uses the current browser/session behavior. Its native adapter coordinates SystemBrowserAuthPort and SecureSessionStoragePort; bounded contexts never read native storage.
- **ClientReleaseIdentity** is compiled into a native build and includes platform, display version, monotonically increasing store build number, immutable asset revision, and client-contract version. ClientApiTransport attaches it to every native API request through the compatibility contract owned by #5249.

Do not centralize route business behavior inside these generic types. Each bounded context owns its concrete operations, data types, validation, API clients, UI, post-write behavior, and route tests. Infrastructure owns only runtime-neutral contracts and technical adapters.

### Route-class contract

Every route record must receive one mechanically exhaustive delivery classification before it can enter NativeRouteRegistry:

| Route class | Web behavior | Native behavior |
| --- | --- | --- |
| Public document | Server loader renders indexable HTML and hydrates it. | RouteLoadOperation calls the public API through ClientApiTransport; the same UI renders the same data type. SEO metadata remains web-only. |
| Authenticated document | WebRouteAdapter resolves the actor from the request session, enforces permission, and runs context operations. | AuthSessionPort supplies the native session; unauthorized returns an auth navigation outcome, forbidden stays an explicit error, and the context operation calls the same owned API. |
| Mutation with validation errors | WebRouteAdapter maps validation-error to action data and HTTP status as appropriate. | NativeRouteAdapter maps the same typed field/form errors to client action data. No HTML parsing or exception-message inference is allowed. |
| Internal redirect | WebRouteAdapter emits an HTTP redirect. | NativeRouteAdapter consumes a typed `navigate` outcome and routes only to a declared internal route. Post-write receipts survive both mappings. |
| External redirect or callback | The web adapter may emit an allowlisted document redirect or own a server callback route. | Native code uses SystemBrowserAuthPort, DeepLinkPort, ExternalNavigationPort, or PaymentPresentationPort; arbitrary URLs never load in the app WebView. |
| Resource-only route | Manifest, service worker, robots, sitemap, health, analytics ingestion, download, and other non-UI responses remain HTTP resources. | Excluded from NativeRouteRegistry. A portable screen calls a stable API or capability port when it needs the resource's behavior. |
| Server-only document | A route requiring Node-only modules, secrets, internal network access, server streaming, or server-owned policy stays on web. | Excluded until its owner provides an explicit portable operation and public API. It is never bundled with a stubbed secret or implicit fallback. |

`clientLoader` is not sufficient evidence of portability when it delegates to `serverLoader`; the current Search route demonstrates this distinction. A native-eligible route must complete cold load and mutation with the server loader unavailable.

### Current route traces through both compositions

#### Public `/search`

Current web path:

1. `deployables/marketplace/app/routes.ts` asks `resolveMarketplaceRouteConfigRecords` for `marketplace-web` contributions.
2. Discovery's manifest contributes route ID `search`, path `search`, and `./routes/search`; Platform Runtime converts it to the context route file.
3. `bounded-contexts/discovery/routes/search.tsx` parses the URL in `loader`, calls `createDiscoveryRequestApiClient`, and loads categories/search results from Discovery-owned APIs.
4. React Router SSR renders the context-owned `SearchPage`; the browser hydrates the loader result. Its current `clientLoader` may restore a session cache hit, otherwise it calls `serverLoader`.

Future native path:

1. NativeRouteRegistry projects the same Discovery `search` PortableRouteDefinition; the mobile composition root does not redeclare `/search`.
2. NativeRouteAdapter invokes Discovery's `RouteLoadOperation(search)` on cold boot. It calls the existing context-owned Discovery client through ClientApiTransport, never through the web `loader` or `serverLoader`.
3. The result uses the same Discovery route-data type and renders the same `SearchPage`. Web-only canonical/Open Graph metadata is not synthesized in the native client.
4. Search mutations invoke Discovery's `RouteMutationOperation(search)` and preserve its typed validation, anonymous/authenticated Checkout calls, and post-write outcomes through injected clients. A native anonymous-session implementation, if needed, is an AuthSessionPort concern rather than deployable business logic.

#### Authenticated `/account`

Current web path:

1. Identity's manifest contributes route ID `account`, path `account`, and `./routes/marketplace/account` to the same marketplace registry.
2. `bounded-contexts/identity/routes/marketplace/account.tsx` calls `requireActorFromIdentityApi` with `accounts.view`. Platform Runtime resolves `/api/auth/session` using the incoming request and redirects a signed-out request to `/sign-in`.
3. The Identity request client forwards web auth and post-write headers to `/api/identity`, loads current-actor display and Account data, and renders the context-owned `AccountProfilePage`.
4. The `update-profile` action enforces `accounts.manage`, calls the Identity client, and maps the command receipt to the `/account` redirect.

Future native path:

1. NativeRouteRegistry projects the same Identity `account` definition and `AccountProfilePage`.
2. NativeRouteAdapter asks AuthSessionPort for the actor/session. Signed-out returns `unauthorized`, which starts SystemBrowserAuthPort and resumes only after a validated DeepLinkPort callback; it does not navigate the app WebView to the sign-in site.
3. Identity's `RouteLoadOperation(account)` uses its existing context client through ClientApiTransport to resolve actor display and Account data. The native credential and ClientReleaseIdentity are attached by infrastructure, and `accounts.view` remains enforced by the API.
4. Identity's `RouteMutationOperation(account)` preserves `accounts.manage`, typed validation errors, post-write receipt, recovery classification, and final internal navigation. The same AccountProfilePage receives the same typed data/action states.

These two traces define the minimum omission-revealing proof for #5246: remove the server runtime, cold-start each route through NativeRouteRegistry, and observe no undefined data, auth, validation, redirect, or post-write seam.

### Ownership and dependency direction

| Owner | Owns | Must not own |
| --- | --- | --- |
| Bounded context | Route definition/ID, portable load and mutation operations, UI, route/API validation, API client, authorization intent, post-write semantics, domain behavior, and tests | Capacitor/native SDK imports, plugin selection, secure-store implementation, platform project files, or deployable imports |
| Infrastructure / Platform Runtime | Generic route adapters, ClientApiTransport, RuntimeKind, AuthSessionPort, capability-port contracts, browser/native adapters, release identity transport, and technical policy enforcement | Marketplace/Checkout/Identity decisions, route copy, form rules, domain state, or context-owned read models |
| Web deployable | SSR boot, web root/layout composition, web-only resource routes, host configuration, and adapter binding | Context business behavior or duplicate context routes/UI |
| Mobile deployable | Client boot, local asset selection, NativeRouteRegistry composition, native adapter binding, platform configuration, icons/splash/entitlements, and release metadata | Business/domain logic, context API orchestration, validation rules, duplicate route modules/UI, or direct read-model access |
| Platform API | Context API composition, authentication enforcement, client-compatibility ingress, and provider callback mounting | Mobile-specific business behavior or UI decisions |

Capacitor/native imports are forbidden anywhere under `bounded-contexts/`, `contracts/`, `packages/`, and context business/domain modules. Direct plugin imports are allowed only in infrastructure native adapters and the future mobile composition root when required solely to bind or configure an adapter. Business or domain logic in deployables/marketplace-mobile is forbidden even when it appears convenient for one platform.

### Capability ports and security posture

#5248 must begin with provider-neutral port contracts, then choose the smallest maintained adapters after platform spikes. No plugin is selected by this ADR.

| Required port | Contract boundary |
| --- | --- |
| SecureSessionStoragePort | Stores only opaque session/refresh material and key metadata in OS-protected storage; access tokens prefer memory; sign-out/revocation clears native state. WebView localStorage, IndexedDB, CacheStorage, and plain preferences are not session stores. |
| SystemBrowserAuthPort | Starts OAuth/auth in ASWebAuthenticationSession or a Custom Tabs-equivalent system surface with Authorization Code + PKCE, state, and nonce. Embedded WebView auth is prohibited. |
| PasskeyPort | Performs platform passkey create/get with the server-owned RP ID and challenge contract. Associated-domain/app-link configuration and origin binding are release gates; a WebView WebAuthn assumption is not the fallback. |
| PushRegistrationPort | Acquires/rotates/revokes a platform token. Notifications owns registration behavior and user preferences; the adapter owns only device interaction. Tapping a notification enters through DeepLinkPort. |
| DeepLinkPort | Receives universal links, app links, and narrowly registered callback schemes as untrusted input; normalizes them to a declared route intent; rejects unknown hosts, callbacks, duplicate consumption, and open redirects. |
| FileAcquisitionPort | Returns bounded bytes/handles plus MIME type, size, and provenance for camera/photo-library/document acquisition. Contexts own content rules; domain state never stores a device filesystem path. |
| SharePort | Presents the OS share surface for a context-owned title/text/URL/file payload and returns only a bounded completion/cancellation result. |
| LifecyclePort | Reports foreground/background/resume transitions so route/runtime code can revalidate or suspend work. Lifecycle is a hint, not business truth or authorization. |
| NetworkStatusPort | Reports connectivity changes for UX and retry scheduling. `online` never proves API reachability and `offline` never authorizes stale writes. |
| ExternalNavigationPort | Opens allowlisted HTTPS and system schemes outside the app WebView. App-owned internal routes stay in NativeRouteRegistry; unknown, cleartext, script, file, and intent URLs fail closed. |
| PaymentPresentationPort | Coordinates provider-approved external authentication or a future reviewed native SDK surface. Checkout and Payments retain all payment decisions. Arbitrary checkout/provider pages and card-entry challenges must not run in the embedded app WebView without provider and store-policy proof. |
| PlatformMetadataPort | Exposes the minimum typed platform, display version, build number, asset revision, locale, and supported-capability facts. It does not expose advertising IDs, raw device fingerprints, or mutable business flags. |

OAuth callbacks must bind state, PKCE verifier, initiating install/session, expected host/scheme, and one-time consumption before a credential is stored. System-browser cookies and WebView cookies are separate and must never be assumed to synchronize. Deep links and push payloads may select a route only after parsing and authorization; they cannot contain executable route code.

Passkeys must preserve RP ID/domain association on both platforms. Photo/file acquisition must survive permission denial and process/lifecycle interruption. Sharing must not disclose private URLs or tokens. External links default to the system browser. Payment flows must be reviewed against current provider guidance and Apple/Google rules before implementation; the fact that Chase Sets sells physical collectibles does not make arbitrary embedded payment content safe.

### Service worker, assets, and releases

The current service worker remains a web-only progressive enhancement. Native local assets already provide the application shell, so a second service-worker cache creates a stale-asset authority with no benefit. Native boot must neither register a service worker nor include the manifest, service-worker, offline-document, robots, sitemap, or health resource routes. Network loss renders a local, design-system error/retry state; authenticated data is not served from the PWA cache.

Each signed native release binds:

- an immutable asset revision for local HTML/JavaScript/CSS;
- a display version and monotonic iOS/Android build number;
- one client-contract version used by the API compatibility gate; and
- the exact native adapter/plugin dependency set and platform permission metadata.

ClientApiTransport sends ClientReleaseIdentity with every native API request. The platform API supports at least the currently distributed native release and its immediately preceding generally available release. Within that window, request changes are additive or version-negotiated, response readers tolerate additive fields, and semantics do not change under an existing contract version.

An incompatible change uses expand-ship-contract order: deploy backward-compatible API support, ship and observe the successor on both stores, then raise the minimum client-contract version in a separate server release after the previous supported release is no longer required. A rejected client receives a stable `client_upgrade_required` problem response with minimum contract, platform store destination, and no partial mutation. A critical security revocation may shorten the window, but it requires an explicit operator decision and upgrade-only UX.

There is no remote-code update channel for core app logic. Adding a hot-update dependency, setting production `server.url`, downloading executable bundles, evaluating remote code, or using a provider SDK as a general code loader violates this decision. Normal remote API data, media, public policy copy, and provider-controlled payment/auth pages remain data or bounded external flows, not a replacement application.

Native rollback is slower than web rollback. Stop a store rollout, restore a compatible backend, disable a failing capability at the server boundary when safe, and submit a corrected signed build. Never "roll back" by pointing installed clients at remote application code. Server compatibility and the previous-release window are the immediate containment mechanism.

### Store-readiness floor

A store submission must demonstrate more than an icon and remote marketplace page. The review build must cold-boot from local assets, support system-browser authentication and account deletion/sign-out paths, complete one representative authenticated buy-or-sell workflow, handle offline/API-incompatible states honestly, and integrate at least one workflow-relevant native capability such as photo acquisition, push-to-deep-link, or sharing. Review credentials or a fully featured approved demo path, live review backend services, privacy/permission metadata, and non-obvious flow notes are release artifacts.

This floor mitigates but cannot eliminate App Review minimum-functionality judgment. Store rejection remains a launch risk and must not trigger a production remote-wrapper shortcut.

## Alternatives Considered

| Alternative | Decision | Principal trade-off and reversal cost |
| --- | --- | --- |
| Remote WebView pointed at the marketplace | Rejected | Lowest initial effort and retains server loaders, but network availability controls boot, system-browser/WebView session behavior diverges, remote core code bypasses signed releases, payment/navigation risk increases, and App Review can classify it as a repackaged website. Moving later to local assets still requires every portable seam in this ADR, so the shortcut is throwaway architecture. |
| Full Swift/Kotlin native clients | Rejected | Maximum native control and conventional platform UX, but duplicates route UI, validation, client orchestration, and tests; creates two delivery cadences; and makes context behavior drift likely. Reversal to shared UI is the highest-cost option because two production clients and teams must converge. |
| Trusted Web Activity | Rejected | Reuses the PWA and browser cookies on Android with small host code, but serves browser-rendered remote content, gives the host limited web-state access, requires site/app association, has no iOS counterpart, and does not provide the selected local-assets release boundary. Reversal requires building the iOS architecture plus replacing Android navigation/session behavior. |
| Capacitor with locally bundled assets | Selected | Preserves React/design-system investment and one context-owned route source across iOS and Android while enabling bounded native adapters. The cost is a second client boot path, installed-client API compatibility, WebView testing, platform projects, plugin maintenance, and store release latency. Reversal to web-only removes the shell; reversal to full native can reuse APIs, capability contracts, and compatibility controls but replaces UI progressively. |

## Failure Modes And Containment

| Failure | Containment/proof |
| --- | --- |
| Native bundle includes a server-only import or calls `serverLoader` | Portable-route dependency scan plus cold route tests with the server runtime unavailable. |
| Deep link or nested refresh opens a blank screen | Local-asset build probe exercises every native route path and Android/iOS callback form against the SPA fallback. |
| API origin, CORS, TLS, or credential mode is wrong | ClientApiTransport contract tests and device smoke tests against staging; no per-context transport workaround. |
| Web session assumptions leak into native auth | `/account` trace must start signed out, complete system-browser auth, resume once, load data, mutate, sign out, and relaunch with expected secure-session state. |
| Old client and new API disagree | Current/previous contract matrix runs on every API change; unknown/retired clients fail before mutation with `client_upgrade_required`. |
| Service worker or hot-update code creates a second asset authority | Built-artifact and dependency/config scan rejects worker registration, remote `server.url`, executable download/eval, and hot-update packages. |
| Plugin update breaks one platform | Each adapter pins a dependency, declares supported OS versions/permissions, has browser/native contract tests, and has an owner and upgrade/rollback note. Unavailable capabilities fail closed or degrade through the port contract. |
| Arbitrary external/payment content stays inside the WebView | Navigation policy tests classify internal, system-browser, auth callback, payment, and rejected URL cases; payment smoke follows current provider/store rules. |
| Connectivity or lifecycle event duplicates a write | Context idempotency remains authoritative; ports provide hints only; route mutation tests cover resume/retry. |
| Store review rejects a thin wrapper | Store-readiness floor, review walkthrough, capability evidence, and honest metadata are required before submission; web remains available while a corrected binary is reviewed. |

## Architecture Fitness Rules

The follow-up work must make these rules executable, not leave them as review conventions:

1. **MOB-01 native-import-boundary:** fail when a bounded context, contract, shared package, or domain/business module imports Capacitor, a native SDK, generated iOS/Android code, or a plugin package.
2. **MOB-02 thin-mobile-root:** fail when marketplace-mobile contains route UI, API orchestration, validation, domain nouns/handlers, read-model access, or imports a context private path. Only approved public context surfaces and infrastructure adapters may be composed.
3. **MOB-03 one-route-authority:** derive web and native registries from context manifests and fail duplicate route IDs/paths or a mobile-only copy of context UI.
4. **MOB-04 exhaustive-route-delivery:** every marketplace route is classified portable, web-resource-only, or server-only. Every portable route supplies its required load/mutation outcome adapters; excluded routes cannot appear in the native bundle.
5. **MOB-05 client-only-route-proof:** run public `/search` and authenticated `/account` cold-load/mutation traces with `serverLoader`, Node built-ins, incoming web cookies, and internal server origin unavailable.
6. **MOB-06 local-asset-release:** parse production Capacitor config and built artifacts; require local `webDir` with `index.html`; reject production `server.url`, remote core script/module sources, executable bundle download/eval, and hot-update dependencies.
7. **MOB-07 no-native-service-worker:** inspect the native registry and built client for service-worker registration and web-only PWA resource routes; both must be absent.
8. **MOB-08 capability-adapter-boundary:** every native plugin import maps to exactly one declared capability port and approved infrastructure adapter; contexts import only port contracts. Browser and unavailable adapters must satisfy the same contract tests.
9. **MOB-09 release-compatibility:** exercise current and immediately previous ClientReleaseIdentity contracts against changed API routes, prove upgrade rejection happens before mutation, and reject an unversioned incompatible schema/semantic change.
10. **MOB-10 auth-navigation-security:** enumerate OAuth callback, passkey origin, deep-link, push-link, internal URL, external URL, and payment navigation cases; unknown/mismatched/replayed inputs fail closed.
11. **MOB-11 plugin-maintenance-inventory:** require every native dependency to be pinned and recorded with port, owner, supported OS matrix, permissions/privacy metadata, contract tests, and upgrade/rollback posture. No dependency is grandfathered by transitive installation.
12. **MOB-12 store-functionality-smoke:** on both platforms, prove local cold boot, system-browser auth, representative authenticated workflow, offline/upgrade UX, and at least one workflow-relevant native capability before store submission.

#5246 owns MOB-03 through MOB-05 and the route seam. #5247 owns the thin root, local asset build, generated native projects, and MOB-02/MOB-06/MOB-07. #5248 owns capability contracts/adapters and MOB-01/MOB-08/MOB-10/MOB-11. #5249 owns ClientReleaseIdentity, the compatibility ingress/window, and MOB-09. Store delivery owns MOB-12. No follow-up may weaken a rule implicitly; a different architecture requires a superseding ADR.

## Consequences

- Public web discovery retains SSR, SEO metadata, hydration, and the existing PWA policy.
- Mobile gains a signed, locally bootable application without forking context UI or domain behavior.
- Current route modules are not declared portable merely because they render in a browser. Search and Account need explicit client operations and adapters before the mobile shell.
- The platform must operate compatible APIs for slowly updating installed clients and cannot rely on synchronized web/app deployment.
- Native capability and plugin maintenance becomes explicit infrastructure work with platform-specific test and release evidence.
- Core application changes require a store release. Remote data and bounded external flows remain available without becoming a code-update channel.
- App Review, WebView/provider behavior, native dependency upgrades, and store rollback latency remain material risks.
- The repository change for this ADR has no runtime, schema, dependency, asset, or deployment effect. Reverting it before implementation removes only this record and its docs-map link. After follow-ups ship, reversal requires a superseding ADR plus a staged client/API migration; installed binaries cannot be recalled by a documentation revert.

## References

- [Capacitor configuration: `webDir` and development-only `server.url`](https://capacitorjs.com/docs/config)
- [Android Trusted Web Activity overview](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities)
- [Apple App Review Guidelines, including 4.2 Minimum Functionality](https://developer.apple.com/app-store/review/guidelines/)
- [ADR 0015: Deployables As Runtime Composition Roots](./0015-deployables-as-runtime-composition-roots.md)
- [Bounded Context Structure](../architecture/bounded-context-structure.md)
