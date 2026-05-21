# Identity Passkey Registration

## Intent

Fix passkey registration so a new personal identity, passkey credential, Auth passkey lookup, and first session are created as one successful Auth journey. While inside the Identity/Auth boundary, also enforce unique personal display names and stop treating display names as legal account names.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-identity-passkey-registration`
- Branch: `codex/identity-passkey-registration`
- Sandbox id: `111e0fd5`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none after fresh `origin/main` fetch and worktree creation

## Owning Contexts

- Auth owns interactive passkey registration, passkey sign-in, challenge consumption, Auth-owned passkey lookup storage, and session creation.
- Identity owns durable User, Account, Membership, Authentication Method, Contact Method, and account/user profile facts.

## Resolved Decisions

- The passkey registration failure belongs to the Auth journey plus Identity internal auth mutation boundary.
- The likely failure mode is partial completion: `createPersonalIdentityForAuth` succeeds using a bootstrap context, but `registerPasskeyCredentialForAuth` is reached through `/internal/auth/users/:id/passkey-credential` and requires a request context. When that context is missing, Identity throws after the user/account records exist and before Auth writes `identity_passkey_credentials`, producing the observed unknown passkey on later sign-in.
- Passkey registration also needs the just-created owner membership passed into session start, matching password registration, because Auth projections may not have caught up with Identity membership facts inside the same request.
- Personal registration must reserve display names case-insensitively before Identity events are committed so repeated attempts do not create duplicate active accounts with the same visible name.
- A personal account display name is public/representational. A legal account name should not be silently derived from it during Auth-owned self-registration; use an empty legal name until an explicit legal-name capture/verification workflow exists.

## Open Questions

- None currently blocking. Existing docs define Account `name` as an account profile field but do not define a separate legal-name workflow; for this bug fix, the conservative behavior is to stop copying display name into that field for personal registrations.

## Implementation Checklist

- [x] Add focused regression tests for partial passkey registration and Auth passkey lookup persistence.
- [x] Add Identity tests for duplicate display-name rejection in Auth-created personal identities.
- [x] Update Identity personal identity creation to validate display-name uniqueness and avoid using display name as the account legal name.
- [x] Update passkey credential registration to use a context consistently with other internal Auth mutations or otherwise guarantee the request context is present.
- [x] Improve API error mapping where needed so uniqueness failures return user-actionable conflict errors instead of internal server errors.
- [x] Run focused tests for Auth and Identity, then broader type/static verification as time allows.

## Documentation To Promote

- Consider a durable Identity glossary/doc note for Account display name versus legal name if this distinction grows beyond the immediate registration fix.
- No durable docs promoted in this change; the retained plan captures the temporary decision and evidence.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
