# Account User Identity Visibility

## Intent

Make the signed-in marketplace actor obvious without requiring a user to open Account and infer identity from the account profile page. The immediate risk is a shared store computer where one staff user may accidentally continue acting as another user or account.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-account-user-identity`
- Branch: `codex/account-user-identity-visibility`
- Base: current source repo `HEAD` (`4f492f63`)
- Sandbox id: `b4e79d07`
- Sandbox ports: marketplace `http://localhost:10953`, admin web `http://localhost:10952`, platform API `http://localhost:10962`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- Sandbox doctor: `pnpm run sandbox:doctor` completed.
- Setup caveat: repo wants Node `24.x`; local runtime is Node `v26.1.0` with pnpm `11.0.9`.
- Source worktree note: original repo had unrelated modified fulfillment packing-slip files; they were not touched.

## Owning Contexts

- Identity owns the User, Account, Membership, Profile, and marketplace account management surfaces.
- Auth owns session lifecycle, account selection, sign-in/sign-out, and actor resolution.
- Discovery currently owns the marketplace shell layout wrapper through `DiscoveryShellLayout`, but deployables should remain thin composition roots.
- The feature should keep identity read behavior in Identity and authentication/session behavior in Auth. The marketplace deployable may compose the data into the shell but should not become the owner of identity facts.

## Resolved Decisions

- Use the terms `User`, `Account`, and `Membership` exactly as defined by Identity. Do not introduce `operator`, `staff identity`, `logged-in account`, or a buyer/seller capability label.
- Treat `User` as the person signed in and `Account` as the commercial identity the user is acting for.
- The marketplace must provide persistent shell visibility for the signed-in identity. Desktop should show the selected Account plus User near the top-bar identity/sign-out area. Mobile should keep bottom navigation compact while still giving a quick identity cue in the Account experience.
- Do not add new domain events for this feature unless implementation discovers missing Identity facts. Existing User, Account, and Membership read models already contain the names and email needed for display.
- Do not put account/user display state into the session aggregate as new durable session truth. Auth's `ResolvedActor` currently carries stable ids and permissions; display names remain Identity profile/read-model data.
- The likely implementation should be a query/composition enhancement, not a new aggregate behavior.

## Repo Evidence

- `bounded-contexts/README.md` says Auth owns sign-in/session journeys and Identity owns users, accounts, memberships, and identity-management surfaces.
- `bounded-contexts/identity/GLOSSARY.md` states accounts do not sign in; users sign in, and all commerce activity is attributed to an account.
- `contracts/auth-context/index.ts` defines `ResolvedActor` with `sessionId`, `userId`, `accountId`, `membershipId`, `roleKey`, and permissions, but no display labels.
- `deployables/marketplace/app/root.tsx` resolves the marketplace actor and cart count only.
- `deployables/marketplace/app/routes/layout.tsx` passes only actor permissions into navigation, then renders a generic `Account` navigation item and a `Sign Out` button.
- `deployables/marketplace/app/host.ts` groups the signed-in account navigation under generic `Account`.
- `bounded-contexts/identity/routes/marketplace/account.tsx` loads only the active account by `actor.accountId`.
- `bounded-contexts/identity/features/accounts/ui/account-profile-page.tsx` shows account profile/readiness details, but not the signed-in user.
- `bounded-contexts/identity/features/users/read-model/queries.ts` already supports `getUser`.
- `bounded-contexts/identity/features/users/ui/contracts.ts` exposes `display_name` and `primary_email`.
- `bounded-contexts/identity/features/accounts/ui/contracts.ts` exposes account `display_name`, `name`, type, status, and timestamp.

## Stress Tests

- Normal flow: one user with one account should see the account name and the user name/email without navigation friction.
- Multi-account flow: after Auth account selection, the shell must show the selected account, not just the user.
- Shared computer flow: the visible indicator must be present before a user starts listing, packing, buying, or changing payout/security settings.
- Stale data/replay: if account or user profile projections lag, the feature should degrade to ids or omit optional display details rather than blocking all marketplace browsing.
- Cross-context handoff: Auth resolves actor ids; Identity supplies display facts. No context should consume another context's internal aggregate state.
- Failure/cancellation: if Identity profile fetch fails in the marketplace root, sign-out should remain available and the app should not trap the user in a broken shell.
- Mobile: bottom navigation has limited space, so mobile needs a compact but still quick identity check, likely in the Account destination or a compact account control rather than crowding all bottom-nav labels.

## Recommendation

Accepted: provide a persistent signed-in identity control in the marketplace shell on desktop, showing the selected Account display name plus the User display name or primary email, with Sign Out adjacent or inside the same control. On mobile, keep the bottom nav compact but make the Account item/opened account surface immediately show "acting as Account" and "signed in as User" at the top.

Why: the risk is accidental action on a shared computer. A page-only fix still requires navigation and can be missed before high-impact actions. A persistent shell cue gives the user a quick identity check while preserving Identity ownership of names and Auth ownership of session/sign-out.

Consequence of choosing differently: limiting this to the Account page is less invasive but does not protect listing, buying, fulfillment, payout, or security workflows before the user notices the mismatch.

## Open Questions

No blocking product/domain questions remain for implementation. Copy and visual details should follow existing design-system shell patterns and the Identity glossary.

## Implementation Checklist

- [x] Add an Identity-owned current actor display read contract that composes the current `User`, selected `Account`, and `Membership` display facts from existing Identity read models.
- [x] Expose that contract through Identity server/request support or the Identity API without moving ownership into the marketplace deployable.
- [x] Extend marketplace root loader data with the current actor display, treating lookup failure as non-fatal.
- [x] Extend the design-system shell/navigation pattern only if existing components cannot show the identity cue without custom overrides.
- [x] Render a desktop shell identity cue showing account and user information near Sign Out.
- [x] Render a mobile-friendly identity cue that does not destabilize the bottom nav.
- [x] Update marketplace layout tests and Identity route/API tests around the new read contract.
- [x] Run focused unit tests for Identity, marketplace layout, and design system shell changes.
- [x] Run desktop and mobile visual verification in the marketplace sandbox.

## Implementation Evidence

- Added `CurrentActorDisplay` in Identity request support and exposed `GET /api/identity/current-actor-display`.
- Marketplace root resolves `actorDisplay` from Identity as non-fatal loader data.
- Design system owns the reusable `ActorIdentityCue`; Identity and marketplace compose it without deployable-owned identity display logic.
- Desktop marketplace shell shows Account, User, and Membership beside Sign Out.
- Mobile Account page shows the same facts in a compact panel above account readiness details.

## Verification Evidence

- `pnpm --filter @chase-sets/identity test`
- `pnpm --filter @chase-sets/app-marketplace-web test -- app/routes/layout.test.tsx app/root.test.tsx`
- `pnpm --filter @chase-sets/design-system test`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck`
- `pnpm run check:structure`
- `pnpm run check:localization`
- Live sandbox visual check at `http://localhost:10953/search`, desktop `1440x900`: shell shows `Acting as Chase Sets`, `Signed in as Demo Account`, and `Owner` without overlapping top navigation.
- Live sandbox visual check at `http://localhost:10953/account`, mobile `390x844`: Account page shows `Signed-In Identity`, `Chase Sets`, `Demo Account`, `demo@chasesets.test`, and `Owner` above the mobile bottom nav.

## Documentation To Promote

- Consider a short Identity context note if the implementation creates a reusable "current actor display" contract.
- Update `bounded-contexts/identity/GLOSSARY.md` only if new user-facing terminology is introduced; current recommendation uses existing glossary terms.
- No ADR expected unless the implementation changes the durable actor/session contract.

## Goal Completion Criteria

- Implementation remains in the feature worktree and branch listed above.
- Durable planning artifact remains committed with implementation.
- Identity remains the source of User, Account, and Membership display facts.
- Auth remains the source of session and actor id resolution.
- Marketplace shell exposes a quick visible check of selected account and signed-in user.
- Automated tests cover the read contract and shell rendering.
- Mobile and desktop visual checks confirm the cue is visible, readable, and not overlapping existing navigation.
- Documentation changes, if needed, are promoted to the owning context docs.
- A PR is submitted, CI passes, the PR is merged, and staging deploy verification confirms the identity cue works after sign-in and account switching.
