# Bounded Context Module Contract

`@chase-sets/bounded-context-module` defines the normalized manifest and runtime module surfaces shared by bounded contexts and platform hosts.

## Event Declarations

`defineBoundedContextModule` forwards normalized `eventSubscriptions` and `eventReactions` from `context.json` onto `BcApiModule`. The fields remain optional: when a manifest omits a declaration array, the module omits that property rather than publishing an empty replacement.

For every active mounted context, the shared bounded-context runtime reconciles those declarations with the subscriptions returned by `buildSubscriptions`:

- an event subscription is resolved by a built projection handler with the same source context and projection name;
- a self-sourced event subscription may instead be resolved by a local `ProjectionHandlerSet` with the same projection name;
- a cross-context declaration cannot use a same-named local projector;
- an event reaction is resolved only by a built reaction handler with the same source context and reaction name.

Missing declarations and missing handlers are named mount failures. Source-only mounts remain excluded because hosts do not construct target-side handlers for them.

The local-projector compatibility path keeps its existing runtime metadata: it derives `order` from the handler-set position and uses subscription version `1`. It does not adopt the declaration's order, version, or event-type fields.
