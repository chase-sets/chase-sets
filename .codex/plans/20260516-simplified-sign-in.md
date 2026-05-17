# Simplified Sign-In

## Intent

Replace the current sign-in page's all-at-once method picker with a simpler two-step journey across every deployable that uses Auth-owned sign-in routes:

1. Let a signed-out user continue with Social Login or enter one Sign-In Identifier.
2. After the identifier is entered, present the strongest appropriate sign-in method first and expose the other enabled methods as secondary options.

The experience should reduce initial choice load, preserve Social Login as a fast first-step option, and follow simple authentication security practices.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-simplified-sign-in`
- Branch: `codex/simplified-sign-in`
- Base commit: `612d59b64c919443d54fcf719357cdff46884d15`
- Sandbox id: `5fa1cd1c`
- Dependency setup: `pnpm run deps:install` passed on 2026-05-16.
- Sandbox doctor: `pnpm run sandbox:doctor` passed on 2026-05-16.
- Local URLs:
  - Dev portal: `http://localhost:7400`
  - Admin web: `http://localhost:7402`
  - Marketplace: `http://localhost:7403`
  - Public web: `http://localhost:7404`
  - Platform API: `http://localhost:7412`
  - Platform worker: `http://localhost:7413`
- Setup caveats:
  - `pnpm run deps:install` reported existing cyclic workspace dependency warnings involving checkout, ordering, marketplace seed testing, and discovery.
  - Sandboxed file reads hit a Windows runner `CreateProcessAsUserW failed: 1312` error; escalated read/search commands were used for planning.

## Owning Contexts

- Auth owns the sign-in journey, session lifecycle, Sign-In Identifier normalization and challenge consumption, Social Login redirect/callback handling, and deployable route modules.
- Identity owns durable User, Contact Method, Social Login Link, Credential, and Authentication Method facts. Auth consumes Identity facts through Auth-owned projections and narrow server calls.
- Deployables remain thin composition roots. The sign-in experience should be implemented in `bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx` and shared Auth support, then consumed by existing Auth route contributions for marketplace and admin deployables.
- Design system remains the canonical UI source. The Auth page must use `@chase-sets/design-system` components only.

## Resolved Decisions

- Auth is the behavior owner for this change.
- The affected deployable sign-in routes are:
  - `bounded-contexts/auth/routes/marketplace/sign-in.tsx`
  - `bounded-contexts/auth/routes/catalog-admin/sign-in.tsx`
  - `bounded-contexts/auth/routes/identity-admin/sign-in.tsx`
- Existing host configs enable the same sign-in methods for marketplace, catalog admin, and identity admin: password, phone code, magic link, and passkey.
- Social Login is already Auth-owned and implemented as first-step provider links for Google and Facebook.
- Existing manual magic-link token entry is disabled by host config and should remain hidden/rejected.
- Best-practice planning inputs:
  - NIST SP 800-63B-4 treats phishing-resistant authenticators as strongest and keeps PSTN/SMS out-of-band authentication restricted.
  - OWASP authentication guidance favors strong, MFA-capable/passwordless methods and safe error behavior that does not create account enumeration.
  - OWASP MFA guidance recognizes passkeys/FIDO2 as strong MFA and treats SMS as weaker because of SIM-swap and phishing exposure.
- Proposed method strength ladder for this repo:
  - Email identifier: passkey, magic link, password.
  - Phone identifier: phone code.
  - Secondary options expose other host-enabled methods without making the first screen noisy.
- Step two will use a non-enumerating fixed method ladder rather than account-specific method discovery before authentication.

## Open Questions

- None.

## Implementation Checklist

- [x] Resolve whether step two uses non-enumerating fixed priority or account-specific method discovery.
- [x] Update the Auth sign-in UI into a two-step state machine:
  - [x] Step 1: Social Login links plus one Sign-In Identifier field accepting email or phone.
  - [x] Step 2: Strongest recommended method first, with secondary options for other enabled methods.
  - [x] Preserve hidden return/account fields, action target, notices, and manual magic-link restrictions.
  - [x] Preserve passkey browser flow using email identifiers only.
  - [x] Preserve phone-code request/consume and magic-link request flows.
  - [x] Preserve password fallback for email identifiers.
- [x] Update sign-in UI tests to cover:
  - [x] Social Login plus identifier-only first step.
  - [x] Email identifier defaults to passkey when passkey is enabled.
  - [x] Phone identifier defaults to phone code.
  - [x] Secondary options are available only after identifier entry.
  - [x] Magic-link manual token entry remains hidden and crafted consumes remain rejected.
- [x] Run Auth tests.
- [x] Run static structure/type checks required by the repo.
- [x] Run marketplace/admin visual checks for desktop and mobile sign-in routes.
- [x] Confirm generated deployable adapters do not require changes because Auth owns the route modules.

## Verification

- `pnpm --filter @chase-sets/auth test` passed on 2026-05-16 with 16 files and 49 tests.
- `pnpm run verify:typecheck` passed on 2026-05-16 after the final route changes.
- `pnpm run verify:static` passed on 2026-05-16 after the final route changes.
- CDP visual verification through local Edge passed on 2026-05-16 for:
  - Marketplace `/sign-in` desktop and mobile.
  - Catalog Admin `/catalog/sign-in` desktop and mobile.
  - Identity Admin `/identity/sign-in` desktop and mobile.
  - Step 1 Social Login plus Sign-In Identifier.
  - Email step 2 with Passkey first and Magic Link/Password secondary.
  - Phone step 2 with Phone Code.
- The visual pass caught and fixed admin mobile route padding by wrapping admin sign-in routes in the design-system `Container`.

## Documentation To Promote

- Update `bounded-contexts/auth/docs/flexible-sign-in.md` with the two-step Sign-In Identifier journey and method priority.
- Update Auth glossary only if new terminology is introduced. Current terms appear sufficient: Sign-In Identifier, Social Login, Phone Code, Authentication.
- Update design-system docs only if a reusable authentication pattern is added there. Initial plan is Auth-owned UI composition using existing components, so no design-system doc promotion is expected.

## Goal Completion Criteria

The implementation goal must own:

- Feature implementation in this worktree and branch.
- Durable documentation promotion for the Auth two-step sign-in flow.
- Automated verification for Auth UI tests and repo static checks.
- Desktop and mobile visual verification of marketplace, catalog admin, and identity admin sign-in routes.
- PR submission for `codex/simplified-sign-in`.
- Passing CI.
- PR merge.
- Preview deploy verification and cleanup.
- Staging deploy verification.
- Production deploy verification when the merge reaches `main`.
- Retention of this plan file in the committed change.
