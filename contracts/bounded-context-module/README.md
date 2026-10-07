# Bounded Context Module Contract

`@chase-sets/bounded-context-module` defines the normalized manifest and runtime module surfaces shared by bounded contexts and platform hosts.

## Shell Contributions

Contexts own shell declarations; infrastructure composes them within a host and expanded slot. `placements` expands one declaration into several slots, replacing `slot` when supplied. Marketplace supports `top-nav`, `bottom-nav`, and `account-menu`; Admin supports `primary-nav` with an explicit section. Admin hrefs and active aliases receive that section prefix before composition. `placement` is different: it passes `"primary"` or `"utility"` through to the design system's `NavigationItem.placement`, not a route module's root/layout placement.

Absent `activation` preserves legacy href leaves, groups, href groups, and inline children. Explicit `activation: "route"` requires an href leaf; `activation: "action"` has no href, children (even an empty array), or active paths. An action emits its `key` for host selection handling; this contract does not implement the action. An empty `children: []` without an href declares an attachable group, removed if it stays empty. Legacy href leaves with empty children remain leaves.

`parentKey` attaches a top-level declaration to a href-less group in the same host and expanded slot, including groups owned by another context. Inline children cannot also declare `parentKey`. Missing, self, cyclic, non-group and cross-section Admin parents are invalid. Attached children must not widen parent visibility, permission requirements (`all` by default or `any`), or `excludedRoleKeys`; permission checks still compose with the parent rather than replacing it. Legacy inline children inherit their parents' restrictions. Exclusions read the optional actor `roleKey`; a missing/null role matches no exclusion. Visibility and permissions continue to apply independently. Empty or fully hidden groups are removed.

`packingPriority` is a finite number. `resolveWebHostNavItems` accepts optional `limit` and `dynamicValues` alongside the existing `section`. There is no default limit and no host-specific item count here. A limit is a nonnegative integer, and requires finite priority on every expanded record and child before actor or section filtering. Packing selects top-level candidates by descending priority, then ascending order/key; it never packs children independently. Limited output, including children, renders by order/key, independent of translated labels. Unlimited calls preserve legacy order/label sorting. The resolver does not mutate declarations or dynamic values.

`badge` declares `{ valueKey, max, hideWhenEmptyForSignedOut }`, with a nonempty value key, positive finite max and boolean hiding flag. `dynamicValues[valueKey]` supplies a count; missing, non-finite or negative counts become zero. Zero emits no badge. Positive counts retain their numeric text (including fractions), capped as `<max>+`. Signed-out entries disappear at zero only when the declaration requests it; signed-in entries remain. A value key has one badge owner per host/expanded slot. This navigation counter is unrelated to Identity's Account Badge.

`activePathPatterns` are literal absolute path aliases on href leaves, not regexes, templates or globs. Hrefs and aliases match themselves and descendants on segment boundaries. Declaration paths must not contain query/hash or pattern syntax. `resolveWebHostActiveKey(registry, hostName, slot, pathname, actor?, options?)` accepts the same options plus `defaultKey`. It normalizes leading/trailing slashes and ignores the input pathname's query/hash. It matches unfiltered expanded route leaves first, choosing most path segments then exact over descendant, and only then checks the rendered tree. Hidden or packed-out matches select nothing; actions and href groups never match. Only a true miss can use the supplied default, and only if rendered. Same-key aliases are allowed. Different-key ties return `undefined` (fail closed, not an exception); the structural guard's `SHELL_ACTIVE_PATH_AMBIGUOUS` diagnostic identifies the declaration defect.

The shell guard discovers tracked JSON/JSONC by the `shellContributions` field, not context or path vocabulary. It classifies malformed arrays and every node before either entry validation or expanded ownership validation, with stable `SHELL_*` code/path diagnostics and scanned/candidate totals. Route ownership uses the union of every route block for the same manifest and deployable; another context or host never supplies ownership. Expanded duplicate keys/hrefs, badge owners, invalid parent graphs, malformed activation/active paths, and non-finite order/priority/max are rejected. Runtime limited calls additionally reject missing priorities with `SHELL_PRIORITY_INVALID`.

## Account Capability Declarations

Contexts may publish Account Capability Declarations through the optional `accountCapabilities` manifest field. Manifest input is untrusted JSON: normalization accepts only the closed `boolean`, `limit`, and `tier` declaration variants, validates the key and kind-specific default, and rejects extra fields. Tier `allowedValues` remain distinct from the declared `defaultValue`.

The normalized manifest and `BcApiModule` expose only `BcAccountCapabilityDeclaration`. Omitting `accountCapabilities` preserves absence on both surfaces; an empty authored array remains an explicit empty array. Declarations are catalog metadata only. This contract does not grant, resolve, enforce, price, or present an Account Capability.

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
