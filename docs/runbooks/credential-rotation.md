# Credential Rotation

Platform credentials live as GitHub Actions secrets in the repository and its environments. This runbook defines the credential inventory, the agent tier it records, the daily credential health check that reads it, the command that rotates an `assisted` credential, and the GitHub App that rotation tooling uses. Automatic rotation arrives with #9915 and #9916.

## Definitions

- **Credential inventory**: `.github/credential-inventory.json`, one entry per secret name set in the repository or any environment, plus each name workflows reference but deliberately leave unset. It records metadata only (names, scopes, rotation rules), never a value. Always say "credential inventory"; it is unrelated to the Inventory bounded context.
- **Credential liveness**: whether a provider still accepts a credential, measured by one read-only request (see [Liveness checks](#liveness-checks)). A verdict is `live`, `dead`, `unknown` or `absent`.
- **Rotation kinds**:
  - `automatic`: tooling replaces the value on a schedule without a person.
  - `assisted`: a person starts the rotation and tooling validates and distributes the new value.
  - `external-owner`: another workstream owns the value's lifecycle; the entry names its `owner` issue (the TCGplayer cookie belongs to #8447).
- **Value group**: the environments that share one value. By default each environment is its own group. A group ages from its oldest member's GitHub `updated_at`, so a stale copy is never hidden by a fresh one.
- **Provider expiry**: `updated_at` plus `providerExpiryDays` (90 for the three DigitalOcean API tokens). A `github-token` check's measured expiry replaces it.
- **Agent tier**: the credential inventory names whose test values a lane may receive through `scripts/agent-secrets/with-secrets.ps1` from Bitwarden Secrets Manager project `chase-sets-agent-dev`, listed in the inventory's `agentTier` (see [Agent tier](#agent-tier)). The agent value of a name is always a separately created test credential; its GitHub copies are never read.
- **CI/deploy-only**: every credential inventory entry the agent tier does not list. Its values reach only CI and deploy workflows, never a lane.
- **Agent token renewal**: replacing the Bitwarden machine-account token that `with-secrets.ps1` reads before its recorded `tokenExpiresOn` (see [Agent token renewal](#agent-token-renewal)). It is a recurring Todd step; `credential:rotate` does not apply.

## Credential Inventory Entries

Each entry has `name`, `scope` (`"repository"` or a list of inventoried environments, which may include `"repository"` when a name is set at both levels), optional `valueGroups`, `kind` (`credential` or `identifier`), `rotation`, `owner` (only for `external-owner`), `providerExpiryDays`, `maxAgeDays`, `liveness` (`{ "kind", "bucket"? }` or `null`), `pairedWith`, `proofWorkflows`, and `optional: true` for names referenced but deliberately unset.

Rules enforced by `scripts/credential-inventory.test.mjs` in `test:scripts`:

- Every `secrets.NAME` in `.github/workflows/**` and `.github/actions/**` (except `GITHUB_TOKEN`) has an entry, and `secrets[...]` index syntax is rejected because it hides the name from every static check.
- `valueGroups` partition `scope` with no overlap.
- Assisted credentials use `maxAgeDays` 365. Identifiers carry no age limit, provider expiry or liveness.
- `pairedWith` is reciprocal. A Spaces liveness entry pairs with exactly one secret key of the same scope.
- Each `proofWorkflows` file references the secret, and each `optional` name is referenced somewhere.

Add, rename or remove the entry in the same pull request that adds, renames or removes a secret reference. When a secret is set or deleted outside a pull request, the next daily run warns until the credential inventory matches.

## Agent Tier

### Connector staging persona verifier

`CONNECTOR_STAGING_PERSONA_MAGIC_LINK_SECRET` is a Todd-only Bitwarden value used once by the staging connector drill. It is never a GitHub secret, workflow input, command argument, log value, receipt field or persisted application value. The operator derives its lowercase SHA-256 digest locally and stores only `CONNECTOR_STAGING_PERSONA_MAGIC_LINK_VERIFIER_SHA256` in the staging runtime secret set. The verifier is dedicated to the Auth staging persona route and must not be placed in `CHANNELS_CREDENTIAL_KEYRING_JSON`, production, preview or any other environment. Rotate both values together; absence or malformed verifier fails closed and does not mount the route.

The top-level `agentTier` holds `project`, the Bitwarden project name, and `keys`, sorted by name. Each key has `name`, an existing inventory entry, and `testPrefixes`, the prefixes its agent value must start with; the list is empty when the provider has no test-key shape. `node ./scripts/credential-inventory.mjs tiers` prints the names in each tier, never a value.

Membership rules, enforced by `scripts/credential-inventory.test.mjs` in `test:scripts` and settled by the [#10031 decision](https://github.com/chase-sets/chase-sets/issues/10031):

- A key must name an inventory entry.
- `DIGITALOCEAN_`, `SES_` and `TCGPLAYER_` names, names containing `ADMIN_PASSWORD`, `external-owner` entries, and entries whose liveness is `digitalocean-account` or `spaces-list-buckets` are CI/deploy-only.
- Every `pairedWith` partner of a key is in the agent tier too, so a pair never joins by halves.
- A Spaces pair joins only when its liveness is `spaces-bucket`, neither member's scope includes `production` or `repository` (production jobs can read repository secrets), and no other entry with such a scope uses its bucket.
- `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` list exactly the test-mode prefixes that `STRIPE_KEY_CASES` in `scripts/stripe-key-mode.mjs` gives their role.

`agentTier.accounts` is optional and lists the Bitwarden machine accounts whose tokens lanes hold. Each account has exactly `name` (the `with-secrets.ps1 -Account` name, matching `^[a-z0-9][a-z0-9-]{0,62}$`, unique), `machineAccount` (the Bitwarden machine account), `access` (`read`) and `tokenExpiresOn`, the expiry date recorded when its token was minted, as a calendar `YYYY-MM-DD` or `null` before a token is issued. The repository's `lanes` account is `chase-sets-lanes`. The committed date is the only record of the expiry: Bitwarden tokens carry no readable expiry and GitHub cannot reach the token.

Voyage and Scrydex keys stay CI/deploy-only: they bill real usage, so lanes that need them dispatch the CI workflows that hold them. Admitting a name is a pull request that adds it to `agentTier` and passes these rules; the value then goes into the Bitwarden project.

`scripts/agent-secrets/with-secrets.ps1` enforces the tier at run time. For `-Command` and `-Check` it first reads `agentTier` from `.github/credential-inventory.json` in the checkout it sits in, before it reads the token. If that file is missing, unparseable or has no valid `agentTier`, it refuses with `inventory-unavailable`. It then lists the project, keeping values in memory, and refuses with `tier-violation` while the project holds a key that `agentTier.keys` does not list, or a value that starts with none of its key's `testPrefixes`. The refusal names each offending key and never prints its value, and `-Command` never reaches `bws run`, with or without `-NoInheritEnv`. `-ListKeys` skips the guard, so the names stay inspectable. To clear a violation, delete the key from the project or replace its value with a test credential. A value added between the list and the run is not checked. After a passing check, `-Check` prints `token expires <date> (<n> days)` from the account's `tokenExpiresOn`, or `token expiry not recorded for account '<name>'`, and warns on stderr within 21 days of the date or past it. It never refuses on the date alone, because the date can be stale; a dead token surfaces as `bws-failed` on first use.

## Daily Credential Health Check

`.github/workflows/platform-credential-health.yml` runs daily at 07:23 UTC and on `workflow_dispatch` from `main`:

1. `metadata` runs in environment `secret-rotation`, mints a read-only rotation App token, and lists every environment and the secret names and update dates of the repository and every environment, paginated and reconciled against each `total_count`.
2. `liveness` is a matrix over the repository and every inventoried environment. Each row binds to its own environment, and each secret reaches only the rows its inventory scope names. The checks run in process with `node`.
3. `report` classifies the result, writes the run summary table, and opens, updates or closes one `[ops-alert] Platform Credential Health failing` issue through the scheduled workflow alert action. A failure level also fails the run.

Locally, `pnpm run ops credential:health report --metadata <file> --liveness-dir <dir> --out <file>` reclassifies downloaded run artifacts. Outputs, the summary, the alert and artifacts carry only names, scopes, ages, expiry dates and verdicts.

## Levels

Levels apply per credential and value group:

| Level   | `assisted` and `external-owner`                                         | `automatic`                                                    | Any credential                                                                                                                       |
| ------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| failure | within 7 days of provider expiry, or older than `maxAgeDays`            | older than `maxAgeDays` + 14, or within 7 days of provider expiry | liveness dead                                                                                                                      |
| warning | within 21 days of provider expiry, or within 30 days of `maxAgeDays`    | older than `maxAgeDays` + 7                                    | liveness unknown; a live name not in the credential inventory; a non-`optional` name missing from its scope; metadata not collected |
| success | otherwise                                                               | otherwise                                                      |                                                                                                                                      |

A collection failure never reports success: a failed or skipped `metadata` or `liveness` job, a missing liveness row, an undiscovered environment list or a scope whose listing does not reconcile is at least a warning. The absence of an `optional` name never warns.

Each `agentTier.accounts` row is classified from its `tokenExpiresOn` alone with the `assisted` provider-expiry levels, counting whole UTC calendar days: failure on or past the date or within 7 days of it, warning within 21 days, success otherwise. A `null` date shows as `not issued` at success. The row carries only the account name, date, days remaining and level; nothing is collected for it, and value-group counts exclude it. The run summary lists the rows under "Agent token accounts", and the alert lists every row after the collection findings.

## Liveness Checks

| Kind                   | Request                                                                     | Live       | Dead                 | Unknown                                                          |
| ---------------------- | --------------------------------------------------------------------------- | ---------- | -------------------- | ---------------------------------------------------------------- |
| `digitalocean-account` | `GET https://api.digitalocean.com/v2/account`                               | 200        | 401                  | 403 and anything else                                            |
| `spaces-list-buckets`  | SigV4 `GET /` on `https://nyc3.digitaloceanspaces.com` (root pair)           | 2xx        | `InvalidAccessKeyId` | `SignatureDoesNotMatch`, `AccessDenied`, other 4xx               |
| `spaces-bucket`        | SigV4 `GET /<bucket>?list-type=2&max-keys=0`, path-style (scoped pairs)      | 2xx        | `InvalidAccessKeyId` | `SignatureDoesNotMatch`, `AccessDenied`, other 4xx               |
| `github-token`         | `GET https://api.github.com/user`                                           | 200        | 401                  | anything else; a malformed expiry header; expiry within an hour of `Date` |

Network errors and 5xx are unknown for every kind. A secret absent from an environment is "absent", never dead. Spaces requests sign region `nyc3`, service `s3`, with `x-amz-content-sha256` set to the SHA-256 of the empty body. The `github-token` check reads `GitHub-Authentication-Token-Expiration` (`YYYY-MM-DD HH:MM:SS (UTC|±HHMM)`); an absent header means the token does not expire.

## Responding To The Alert

- **liveness-dead** or **provider-expiry-within-7-days**: rotate now. Create the replacement with the provider and rotate an `assisted` entry with [`credential:rotate`](#rotating-an-assisted-credential), which stores it only in the GitHub secrets the entry's value group names and dispatches each workflow in `proofWorkflows`; then revoke the old value. Never paste a value into an issue, PR, log or screenshot.
- **provider-expiry-within-21-days** or **max-age-within-30-days**: schedule the rotation before the failure threshold.
- **liveness-unknown** on a DigitalOcean token: a 403 usually means the token lacks the `account:read` scope; add it at the next rotation. On Spaces, `SignatureDoesNotMatch` or `AccessDenied` means the pair or bucket grant does not match the credential inventory.
- **not-inventoried** or **missing-from-scope**: update the credential inventory, or set or delete the secret so the two agree.
- **metadata-not-collected**, **liveness-not-collected** or a `*-job-*` finding: open the run and fix the collection; the run is not evidence of health until it completes.
- **agent token** row at warning or failure: follow [Agent token renewal](#agent-token-renewal).

The run summary table lists every live name per scope with its update date, age, provider expiry, liveness verdict and level.

## Rotating An Assisted Credential

`pnpm run ops -- credential:rotate --secret <NAME> [--env <name>[,<name>...]] [--dry-run]` (`scripts/credential-rotate.mjs`) rotates one `assisted` entry together with its `pairedWith` partners. It runs on the operator's machine under the operator's own `gh` login, which is production credential custody: never in CI and never as the rotation App. It refuses `automatic` and `external-owner` entries, and any pair that includes one, naming the owner.

1. Create the replacement with the provider. Keep the old value until the last step.
2. Preview with `--dry-run`. It prints the values in prompt order with each one's validation, every `gh secret set` target in write order, and the proof workflows. It prompts, reads, validates, writes and dispatches nothing. The dry run is the per-credential reference; this runbook does not copy the credential inventory.
3. Choose the value group. `--env` must equal exactly one of the entry's value groups, in any order. It is required when the entry has more than one group, so a test-mode Stripe key takes `--env staging` and the live key `--env production`. A repository-scoped entry takes no `--env`; for a name set at both levels, `--env repository` selects the repository group.
4. Enter each value at the hidden prompt: the named secret first, then each partner in `pairedWith` order. Alternatively pipe them on stdin, one value per line, in the same order. Every value is a single line, so compact JSON before pasting it. The prompt hides input only where Node sees a terminal (Windows Terminal, PowerShell, macOS and Linux terminals); Git Bash's mintty is not one, so the command prints `stdin is not a terminal` instead of a prompt; stop there and rerun under `winpty` or another terminal rather than typing a value that echoes.
5. Validation finishes for the whole pair before the first write. A member with a `liveness` kind must check `live` against its provider (see [Liveness checks](#liveness-checks)); `dead`, `unknown` and `absent` are refused, so replace the value rather than retry. Every other member must be non-empty with no whitespace or line breaks; a value that needs whitespace cannot use this command.
6. Writes go to each target in the group's inventory order, every member of the pair per target, and stop at the first failure. The command then names the targets that already hold the new values, and any target holding only part of the pair; rerun with the same values to complete the set.
7. After every write succeeds, each `proofWorkflows` entry is dispatched with `gh workflow run <file> --ref main` and its run URL printed. A dispatch that fails or returns no run URL is reported as failed and the command exits non-zero; dispatch that workflow from the Actions tab.
8. Once every proof run passes, delete the old credential with the provider. When the entry lists no proof workflow, confirm its consumers first.

Examples:

- `pnpm run ops -- credential:rotate --secret DIGITALOCEAN_READONLY_TOKEN`: checks `/v2/account`, writes `production`, dispatches `platform-credential-health.yml` and `platform-digitalocean-drift-digest.yml`.
- `pnpm run ops -- credential:rotate --secret SPACES_ACCESS_ID`: prompts for the access key, then `SPACES_SECRET_KEY`, checks the pair together, and writes both to `merge-gate`, `preview`, `production` and `staging` in turn.
- `pnpm run ops -- credential:rotate --secret STRIPE_SECRET_KEY --env staging`: prompts for the secret key, then `STRIPE_PUBLISHABLE_KEY`, and writes only `staging`.
- `pnpm run ops -- credential:rotate --secret PROJECTS_TOKEN`: checks the token against GitHub `/user` and writes the repository secret.

Values never enter argv, a child process environment, stdout, stderr or a file; they reach only `gh secret set` on stdin and the in-process liveness check.

## Agent Token Renewal

The token for each `agentTier.accounts` account is minted in Bitwarden with a 90-day expiry and stored only in Windows Credential Manager on the lane host. `credential:rotate` does not apply: it writes GitHub secrets through `gh`, and this token is neither. Bitwarden offers agents no token-minting API for machine accounts, so renewal stays a recurring Todd step. Start it when the daily report or `-Check` warns, within 21 days of `tokenExpiresOn`:

1. Todd mints a new 90-day access token for machine account `chase-sets-lanes` in Bitwarden Secrets Manager.
2. Todd runs `pwsh -NoProfile -File scripts/agent-secrets/set-bitwarden-agent-token.ps1 -ProjectId <project-guid>` in an interactive terminal on the lane host and pastes the token at its masked prompt.
3. An agent PR sets the account's `tokenExpiresOn` in `.github/credential-inventory.json` to the new expiry date; Todd gives the agent the date only, never the token.
4. Todd revokes the old token in Bitwarden.

A stale date fails safe: the report alerts on the old date until step 3 lands. Never paste a token into an issue, PR, log or screenshot.

## Rotation App

Rotation tooling authenticates as the GitHub App `chase-sets-credential-rotation`, installed only on `chase-sets/chase-sets`, with repository permissions Environments read and write, Secrets read and write, Actions read and write, and Metadata read. A personal access token was rejected: it is long-lived, tied to one person and itself expires.

- The App ID is the variable `CREDENTIAL_ROTATION_APP_ID` and the private key is the secret `CREDENTIAL_ROTATION_APP_PRIVATE_KEY`, both only in environment `secret-rotation`, whose deployment branch policy allows only `main`.
- The daily check mints its token with a full-SHA `actions/create-github-app-token` and only `permission-environments: read` and `permission-secrets: read`, so it can list names and dates but cannot write.
- Creating the App and storing its private key is production credential custody and stays with the operator. Agents create `secret-rotation` with its `main`-only policy and set the ID variable.
