# Bounded Context Module Contract

`@chase-sets/bounded-context-module` defines the normalized manifest and runtime module surfaces shared by bounded contexts and platform hosts.

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
