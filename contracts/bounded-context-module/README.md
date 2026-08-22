# Bounded Context Module Contract

`@chase-sets/bounded-context-module` defines the normalized manifest and runtime module surfaces shared by bounded contexts and platform hosts.

## Shell Contributions

Shell contributions are additive presentation records owned by bounded contexts. Hosts may resolve `primary-nav`, `top-nav`, `bottom-nav`, and `account-menu` slots without requiring an existing manifest to adopt newer fields.

The additive item fields are `parentKey?: string`, `placement?: "primary" | "utility"`, `packingPriority?: number`, `excludedRoleKeys?: readonly string[]`, `activePathPatterns?: readonly string[]`, `activation?: "route" | "action"`, and `badge?: { valueKey: string; max: number; hideWhenEmptyForSignedOut: boolean }`.

An item with no `activation` keeps the legacy interpretation: an href leaf is a route and an item with children (or an empty item that receives `parentKey` children) is a group. `activation: "route"` explicitly declares an href leaf. `activation: "action"` declares an action leaf; it has no href, children, or `activePathPatterns`, and its emitted key is the host selection-event key. Route leaves may add literal absolute `activePathPatterns`; hrefs and patterns match themselves and descendants only at path-segment boundaries.

`parentKey` attaches a contribution beneath a group with the same deployable and expanded slot. `placements` expands before attachment and actor filtering. Parent and child visibility, required permissions, and `excludedRoleKeys` compose without widening. `placement` carries the design-system `primary` or `utility` hint through unchanged.

Hosts supply dynamic badge values by `badge.valueKey`. Missing, non-finite, and negative values normalize to zero. Zero omits the badge; positive values render from `1` through `badge.max`, then `<max>+`. `hideWhenEmptyForSignedOut` hides an empty item only for a signed-out actor.

`packingPriority` is dormant unless a host supplies a numeric limit. A limited resolution requires a finite priority on every item expanded into the host and slot, including attached and inline children. Visible top-level candidates are selected by descending priority, ascending display `order`, then key. Selected siblings render by ascending `order`, then key. There is no shared default limit.

## API Mount Binding

Each `buildApis` result is the closed tuple `{ mountPath, contextMountOrdinal, router }`. `mountPath` must equal the declaration at the same position in `apiMounts`, and `contextMountOrdinal` is that declaration's one-based position. The runtime verifies both redundant values without sorting, deduplicating, or matching by path, so contexts may intentionally declare several routers at the same mount path while retaining their declared order. The resolved mount retains the inner `router` object unchanged.

A context may return any internally composed Hono application for a declared mount. Register-style builders such as Auth and inline-only builders such as Notifications are supported escape hatches from feature-level `.route()` composition, but not from the binding checks or the readable-route-table requirement. There is no collision-census exemption.

## API Route Collision Invariant

After all context routers are mounted, the bounded-context runtime reads every router's public route table and rejects any two records with the same method and structural collision shape, including `ALL`. The complete mount path and raw route path are merged by the runtime's target Hono `mergePath`; Hono's optional-parameter expansion is then applied before brace-aware route splitting and pattern extraction. Parameter names are erased by position while exact custom-pattern bytes, literals, wildcards, accepted optional projections, and trailing-slash behavior are preserved. An unreadable table, invalid or empty target expansion, or incomplete scan is an error rather than a skipped row.

Because Hono's public route table cannot distinguish registration intent, duplicate records are categorically unsupported:

- Register one handler per verb. Put per-route middleware in a preceding `.use(path, middleware)` record.
- Compose multiple middleware for the same path into one `.use()` handler, or attach them to structurally distinct paths such as `/x` and `/x/*`.
- Do not combine `.all()` with another `ALL`-producing registration at the same collision shape. `.all()` and a specific verb remain distinct methods.

## Event Declarations

`defineBoundedContextModule` forwards normalized `eventSubscriptions` and `eventReactions` from `context.json` onto `BcApiModule`. The fields remain optional: when a manifest omits a declaration array, the module omits that property rather than publishing an empty replacement.

Each declaration may set `subscriptionName` and `filterToEventTypes`. A missing `subscriptionName` keeps the existing context-and-handler-name derivation, including established double prefixes. A missing `filterToEventTypes` keeps the complete registered handler map; setting it to `true` restricts that map to the declaration's `eventTypes`. Handler registrations supply only the declaration-to-handler-map function, so the manifest is the single owner of both options.

For every active mounted context, the shared bounded-context runtime reconciles those declarations with the subscriptions returned by `buildSubscriptions`:

- an event subscription is resolved by a built projection handler with the same source context and projection name;
- a local `ProjectionHandlerSet` with no matching declaration creates its own self-sourced subscription;
- a declaration that is satisfied only by a same-named local `ProjectionHandlerSet` is rejected because its version, order, and event types would have two conflicting owners;
- a cross-context declaration cannot use a same-named local projector;
- an event reaction is resolved only by a built reaction handler with the same source context and reaction name.

Missing declarations and missing handlers are named mount failures. Source-only mounts remain excluded because hosts do not construct target-side handlers for them.

The local-projector path keeps its runtime metadata: it derives `order` from the handler-set position, uses subscription version `1`, and derives event types from the handler set. Authors must either register a handler for a manifest declaration or remove the declaration and let the local projector own the runner.
