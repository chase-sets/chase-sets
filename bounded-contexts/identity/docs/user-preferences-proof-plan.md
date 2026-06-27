# User Preferences Proof Plan

This note is the milestone #55 handoff for issue #2704. It defines the ownership rule and the automated proof that must exist before the user preferences milestone is closed.

## Ownership Rule

The durable settings ownership rule is defined in [Settings Ownership](../../../docs/architecture/settings-ownership.md). In short, settings live with the bounded context that owns the behavior they change.

- Behavior-coupled settings stay with their owning context. Notification delivery, category, and channel preferences stay in Notifications because Notifications owns delivery policy and notification settings.
- Viewer presentation preferences live on the User in Identity. Theme, density, reduced-motion, locale, and time zone describe how the signed-in user wants Chase Sets presented across accounts and devices.
- Device ephemera stay client-local. Anonymous visitor theme fallback, transient viewport state, and one-device UI affordances do not become Identity facts.

Identity owns the durable User Preferences value object and its user-scoped command/query authorization. Deployables consume the resolved shell viewer model and stay thin composition roots. The design system owns reusable controls and presentation primitives, but not persistence.

## Final Automated Proof

Issue #2704 is not complete until automated tests demonstrate the end-to-end behavior below. Manual screenshots can support the record, but they must not replace executable proof.

| Proof area | Required evidence | Downstream owner |
| --- | --- | --- |
| Cross-device theme persistence | A signed-in user sets `dark`, reloads, and a second browser context/session/device converges to `dark` from the Identity-backed resolved preference. | #2698, #2699, #2700, #2703 |
| First paint/no FOUC | Server-rendered output for a signed-in user with stored `dark` applies the dark color mode before hydration; the test must fail on a light-to-dark flash. | #2701, #2703 |
| Settings ownership | Tests or docs gates prove viewer presentation preferences are Identity-owned, notification settings remain Notifications-owned, and deployables do not grow domain/read-model behavior. | #2698-#2703 |
| Reduced motion | Identity persists the reduced-motion preference, the shell viewer exposes it, and deployable roots pass it to the design-system `ChaseRoot` so motion policy is honored before route content renders. | #2702, #2703, #2704 |

## Suggested Test Shape

Keep proof at the lowest level that can catch the regression:

1. Identity unit/integration tests cover the preferences value object, decider/evolver, projection replay, defaults, partial updates, validation, and current-user-only command authorization.
2. Shell viewer tests cover signed-in resolved preferences and signed-out absence/fallback behavior without importing Identity internals into deployables.
3. Design-system tests cover AccountMenu preferences control keyboard/focus behavior and reduced-motion-sensitive motion behavior.
4. Browser e2e covers the complete user path: sign in, set dark, reload, open a second context, and observe convergence without custom deployable overrides.
5. SSR/no-FOUC proof inspects the first rendered document or pre-hydration DOM/class/data attribute before client scripts can correct the theme.

## Reduced-Motion Decision

Color mode is the first AccountMenu control exposed by this milestone. Reduced motion is still a durable User Preference in Identity and is honored by shell roots through the design-system `ChaseRoot` contract. The browser e2e proof may set it through the Identity API until a dedicated user-facing reduced-motion control is added.

## Closure Gate

Do not close #2704 from a docs-only PR. Close it only after the downstream implementation PRs provide the automated proof for cross-device persistence, first paint/no FOUC, settings ownership, reduced-motion behavior, docs index coverage, and the scoped non-DB/e2e verification called out in the issue.
