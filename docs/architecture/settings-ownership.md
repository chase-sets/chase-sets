# Settings Ownership

Settings live with the bounded context that owns the behavior they change. A setting is not a shared platform concern just because more than one deployable can display it.

## Decision Rule

1. Behavior-coupled settings stay with the owning context. Notification delivery channels, notification categories, and suppression policy stay in Notifications because Notifications owns delivery behavior.
2. Viewer presentation preferences live on the User in Identity. Color mode, density, reduced motion, locale, and time zone describe how a signed-in User wants Chase Sets presented across accounts and devices.
3. Device ephemera stay client-local. Anonymous visitor theme fallback, viewport-only state, and one-device UI affordances are not durable Identity facts.
4. Deployables compose settings into shells but do not own setting behavior, persistence, read models, or domain vocabulary.
5. The design system owns reusable controls and presentation primitives. It emits intent through callbacks; it does not become the persistence owner.

## Applying The Rule

When adding a setting, first name the behavior it changes:

- If the setting changes when or how a domain action happens, put it in the bounded context that owns that action.
- If the setting changes only how the signed-in viewer experiences the product across devices, put it in Identity as User Preferences.
- If the setting is only a local convenience for one browser or anonymous visitor, keep it client-local and avoid server persistence.

The milestone #55 user preferences vertical applies this rule to theme persistence: Identity owns durable User Preferences, the shell viewer exposes the resolved value, deployables pass it through, and the design system supplies the AccountMenu control.

## Proof Expectations

Ownership is proven by code shape and tests:

- context-owned command/query/projection tests cover durable state and authorization;
- shell viewer tests prove deployables consume a resolved read model rather than importing context internals;
- design-system tests prove controls are reusable and persistence-free;
- end-to-end tests prove cross-device convergence for signed-in users;
- SSR or pre-hydration tests prove first-paint behavior when a persisted presentation preference affects the initial shell.

The completed user-preferences proof record is retained in [issue #2704](https://github.com/chase-sets/chase-sets/issues/2704); ongoing behavior is guarded by the context, shell, design-system, and end-to-end tests described above.
