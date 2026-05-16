# Magic Link Local Recovery Admin Security

## Intent

Review and address the security issue where a user can request a magic link on an admin sign-in surface, press the local recovery `Continue` action, and complete sign-in as a platform admin without leaving the browser session.

The implementation should make the magic-link credential path production-safe by default: raw magic-link secrets must not be returned to browser clients, and admin sign-in surfaces must not expose local token recovery controls.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-magic-link-recovery-admin`
- Branch: `codex/magic-link-recovery-admin`
- Base: current source repo `HEAD` at `8cc4f1e6 Add notifications database to staging platform (#72)`
- Sandbox id: `5fe1ff36`
- Sandbox doctor: passed
- Dependency setup: `pnpm run deps:install` passed
- Local URLs: admin web `http://localhost:8902`, platform API `http://localhost:8912`

## Owning Contexts

- Auth owns the fix for the interactive sign-in journey, `/api/auth/magic-link/request`, `/api/auth/magic-link/consume`, session creation, account selection, browser cookies, and the shared sign-in UI.
- Identity owns the upstream user, membership, role, and permission facts that allow the resolved actor to be a `platform-admin`; Identity should not own the magic-link recovery behavior.
- Deployables should remain thin composition roots. Admin-specific behavior should be configured through Auth host configuration or Auth-owned route modules, not hard-coded in `deployables/admin-web`.

## Resolved Decisions

- Decision: treat local magic-link recovery as a development/test convenience only, not as a browser credential path.
  - Why: the current API returns the raw magic-link token in the HTTP response and the shared UI immediately posts it back. This bypasses the intended email possession check.
  - Repo evidence: `bounded-contexts/auth/support/api-support/magic-link-routes.ts` returns `{ tokenId, token, expiresAt }`; `bounded-contexts/auth/support/route-support/auth-host.ts` stores that token in `AuthActionNotice`; `bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx` renders a hidden-token `Continue` form; localization explicitly calls this "local recovery mode".
  - Consequence of choosing differently: keeping browser-visible local recovery on admin surfaces lets any user who can request a magic link for a privileged email complete sign-in from the same browser response.

- Decision: Auth should return only non-secret request metadata to browser clients after requesting a magic link.
  - Recommended response shape: `{ tokenId, expiresAt }` or an equivalent `deliveryQueued` acknowledgement.
  - Why: existing email-delivery docs already say magic-link secrets are stored in mutable auth token storage, read by the transactional email projector, and cleared after the outbox entry is created.
  - Repo evidence: `docs/architecture/email-delivery-task-list.md` documents the mutable-token handoff; `bounded-contexts/auth/features/sessions/integrations/transactional-email/transactional-email-projector.ts` reads the delivery token by `tokenId` and clears it.
  - Consequence of choosing differently: Auth would continue to leak a bearer credential to any caller of the unauthenticated request endpoint.

- Decision: admin sign-in pages should not expose magic-link token entry or local recovery controls.
  - Why: admin surfaces protect platform operations, and the admin host configs already define stronger permission gates after authentication (`catalog.view` and `security.manage`), but those gates only run after the session exists.
  - Repo evidence: `bounded-contexts/auth/support/route-support/host-config.ts` defines admin host configs and required permissions; `SignInPage` is shared and currently has no host capability policy for magic-link local recovery.
  - Consequence of choosing differently: admin auth keeps a privileged same-browser credential completion path even if the API response stops returning the token, because future dev helpers could reintroduce browser token consumption.

- Decision: preserve `/api/auth/magic-link/consume` as the email-link completion endpoint, with one-time token consumption, expiry, and membership/account-selection checks.
  - Why: consuming the token is the correct completion behavior once the user proves possession of the email-delivered link.
  - Repo evidence: `consumeMagicLinkToken` marks tokens consumed only when hash matches, token is unconsumed, and `expires_at > now()`.
  - Consequence of choosing differently: removing consumption would break legitimate magic-link sign-in.

## Security Findings

- Critical: the magic-link request endpoint leaks the bearer token to the requester. `bounded-contexts/auth/support/api-support/magic-link-routes.ts` inserts the token hash and mutable delivery token, appends `auth.magic-link.requested`, then returns the raw token in the JSON response.
- Critical: the shared sign-in action and UI convert that leaked token into a same-browser sign-in. `auth-host.ts` puts the token into action data, and `sign-in-page.tsx` renders a hidden `magic-link-consume` form labelled `Continue`.
- High: admin sign-in routes reuse the same magic-link local recovery UI as marketplace sign-in. There is no host-level capability policy preventing admin local recovery.
- Medium: the existing Auth test suite has no test covering "magic-link request response must not include a token" or "admin sign-in must not render local recovery controls".

## Implementation Checklist

- Add an Auth-owned magic-link request result type that excludes raw secret tokens from browser responses.
- Update `/api/auth/magic-link/request` to return only non-secret metadata while still storing the short-lived delivery token for the transactional email projector.
- Update `AuthActionNotice` and `createSignInAction` so magic-link request notices do not carry a token.
- Add an Auth host sign-in capability policy, likely on `AuthHostConfig`, to let marketplace and admin hosts explicitly choose supported sign-in methods and whether manual token entry is allowed.
- Configure `catalogAdminAuthHostConfig` and `identityAdminAuthHostConfig` to disable browser local recovery/manual token entry.
- Update `SignInPage` to render only the host-allowed methods and to show a non-action success notice after magic-link request.
- Keep `/magic-link/consume` available for email links and direct token completion in tests/server flows, but do not expose token entry on admin browser pages.
- Add focused Auth tests:
  - magic-link request response does not include `token`;
  - magic-link requested transport event does not include a secret;
  - admin sign-in page does not render `Continue`, `Continue With Token`, or hidden `magic-link-consume` after a request notice;
  - marketplace behavior uses email-only success messaging unless a deliberately named local/test-only capability remains;
  - magic-link consume still starts a session for a valid email-delivered token and rejects invalid/expired/reused tokens.
- Update localization copy to remove "continue here in local recovery mode" from browser-visible production copy.
- Add or update an Auth context doc if local/test-only recovery remains, naming who may use it and how it is kept out of browser admin surfaces.

## Documentation To Promote

- Prefer an Auth context doc under `bounded-contexts/auth/docs/` if local/test-only token recovery remains.
- No ADR is currently needed unless implementation introduces a hard-to-reverse deployment-wide policy for development credential recovery.
- If the public API response shape changes, update `docs/api/` only if `/api/auth` is documented there during implementation.

## Verification Notes

- Baseline command passed: `pnpm --filter @chase-sets/auth run test` with 10 files and 22 tests passing.
- Implementation command passed before rebase: `pnpm --filter @chase-sets/auth run test` with 12 files and 28 tests passing.
- Implementation command passed after rebasing onto `origin/main`: `pnpm --filter @chase-sets/auth run test` with 15 files and 41 tests passing.
- Implementation command passed: `pnpm run check:localization`.
- Implementation command passed: `pnpm run typecheck`.
- Implementation command passed: `pnpm run check:structure`.
- Browser visual verification passed on the running sandbox:
  - identity admin desktop at `http://localhost:8902/identity/sign-in`;
  - catalog admin mobile at `http://localhost:8902/catalog/sign-in`;
  - marketplace desktop at `http://localhost:8903/sign-in`;
  - marketplace mobile at `http://localhost:8903/sign-in`.
- Browser verification confirmed zero visible `Continue`, `Continue With Token`, `Magic Link Token`, local recovery copy, or `magic-link-consume` controls in the loaded sign-in surfaces. The in-app browser did not hydrate segmented-control clicks in this session, so the magic-link tab and post-request notice states are verified by focused component tests.
- Live sandbox API smoke passed after refreshing this worktree's sandbox database for the rebased schema: `POST http://localhost:8912/api/auth/magic-link/request` returned only `tokenId` and `expiresAt`.

## Goal Completion Criteria

The implementation goal must:

- work only in `D:\Users\ToddS\Source\Repos\chase-sets-20260515-magic-link-recovery-admin` on `codex/magic-link-recovery-admin`;
- implement the Auth-owned fixes above without moving behavior into deployables;
- promote any durable Auth-local documentation needed to explain local/test-only recovery;
- keep `.codex/plans/20260515-magic-link-recovery-admin.md` retained and committed with the implementation;
- run the targeted Auth tests and broader relevant checks;
- visually verify admin and marketplace sign-in surfaces on desktop and mobile;
- submit a PR;
- get CI passing;
- merge the PR;
- verify the staging deploy cannot sign in as a platform admin via same-browser local recovery.
