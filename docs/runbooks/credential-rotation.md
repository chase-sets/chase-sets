# Credential Rotation

Platform credentials live as GitHub Actions secrets in the repository and its environments. This runbook defines the credential inventory, the daily credential health check that reads it, and the GitHub App that rotation tooling uses. It does not rotate anything; rotation commands arrive with #9914, #9915 and #9916.

## Definitions

- **Credential inventory**: `.github/credential-inventory.json`, one entry per secret name set in the repository or any environment, plus each name workflows reference but deliberately leave unset. It records metadata only (names, scopes, rotation rules), never a value. Always say "credential inventory"; it is unrelated to the Inventory bounded context.
- **Credential liveness**: whether a provider still accepts a credential, measured by one read-only request (see [Liveness checks](#liveness-checks)). A verdict is `live`, `dead`, `unknown` or `absent`.
- **Rotation kinds**:
  - `automatic`: tooling replaces the value on a schedule without a person.
  - `assisted`: a person starts the rotation and tooling validates and distributes the new value.
  - `external-owner`: another workstream owns the value's lifecycle; the entry names its `owner` issue (the TCGplayer cookie belongs to #8447).
- **Value group**: the environments that share one value. By default each environment is its own group. A group ages from its oldest member's GitHub `updated_at`, so a stale copy is never hidden by a fresh one.
- **Provider expiry**: `updated_at` plus `providerExpiryDays` (90 for the three DigitalOcean API tokens). A `github-token` check's measured expiry replaces it.

## Credential Inventory Entries

Each entry has `name`, `scope` (`"repository"` or a list of inventoried environments, which may include `"repository"` when a name is set at both levels), optional `valueGroups`, `kind` (`credential` or `identifier`), `rotation`, `owner` (only for `external-owner`), `providerExpiryDays`, `maxAgeDays`, `liveness` (`{ "kind", "bucket"? }` or `null`), `pairedWith`, `proofWorkflows`, and `optional: true` for names referenced but deliberately unset.

Rules enforced by `scripts/credential-inventory.test.mjs` in `test:scripts`:

- Every `secrets.NAME` in `.github/workflows/**` and `.github/actions/**` (except `GITHUB_TOKEN`) has an entry, and `secrets[...]` index syntax is rejected because it hides the name from every static check.
- `valueGroups` partition `scope` with no overlap.
- Assisted credentials use `maxAgeDays` 365. Identifiers carry no age limit, provider expiry or liveness.
- `pairedWith` is reciprocal. A Spaces liveness entry pairs with exactly one secret key of the same scope.
- Each `proofWorkflows` file references the secret, and each `optional` name is referenced somewhere.

Add, rename or remove the entry in the same pull request that adds, renames or removes a secret reference. When a secret is set or deleted outside a pull request, the next daily run warns until the credential inventory matches.

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

## Liveness Checks

| Kind                   | Request                                                                     | Live       | Dead                 | Unknown                                                          |
| ---------------------- | --------------------------------------------------------------------------- | ---------- | -------------------- | ---------------------------------------------------------------- |
| `digitalocean-account` | `GET https://api.digitalocean.com/v2/account`                               | 200        | 401                  | 403 and anything else                                            |
| `spaces-list-buckets`  | SigV4 `GET /` on `https://nyc3.digitaloceanspaces.com` (root pair)           | 2xx        | `InvalidAccessKeyId` | `SignatureDoesNotMatch`, `AccessDenied`, other 4xx               |
| `spaces-bucket`        | SigV4 `GET /<bucket>?list-type=2&max-keys=0`, path-style (scoped pairs)      | 2xx        | `InvalidAccessKeyId` | `SignatureDoesNotMatch`, `AccessDenied`, other 4xx               |
| `github-token`         | `GET https://api.github.com/user`                                           | 200        | 401                  | anything else; a malformed expiry header; expiry within an hour of `Date` |

Network errors and 5xx are unknown for every kind. A secret absent from an environment is "absent", never dead. Spaces requests sign region `nyc3`, service `s3`, with `x-amz-content-sha256` set to the SHA-256 of the empty body. The `github-token` check reads `GitHub-Authentication-Token-Expiration` (`YYYY-MM-DD HH:MM:SS (UTC|±HHMM)`); an absent header means the token does not expire.

## Responding To The Alert

- **liveness-dead** or **provider-expiry-within-7-days**: rotate now. Create the replacement with the provider, store it only in the GitHub secrets the entry's scope names, dispatch each workflow in `proofWorkflows`, then revoke the old value. Never paste a value into an issue, PR, log or screenshot.
- **provider-expiry-within-21-days** or **max-age-within-30-days**: schedule the rotation before the failure threshold.
- **liveness-unknown** on a DigitalOcean token: a 403 usually means the token lacks the `account:read` scope; add it at the next rotation. On Spaces, `SignatureDoesNotMatch` or `AccessDenied` means the pair or bucket grant does not match the credential inventory.
- **not-inventoried** or **missing-from-scope**: update the credential inventory, or set or delete the secret so the two agree.
- **metadata-not-collected**, **liveness-not-collected** or a `*-job-*` finding: open the run and fix the collection; the run is not evidence of health until it completes.

The run summary table lists every live name per scope with its update date, age, provider expiry, liveness verdict and level.

## Rotation App

Rotation tooling authenticates as the GitHub App `chase-sets-credential-rotation`, installed only on `chase-sets/chase-sets`, with repository permissions Environments read and write, Secrets read and write, Actions read and write, and Metadata read. A personal access token was rejected: it is long-lived, tied to one person and itself expires.

- The App ID is the variable `CREDENTIAL_ROTATION_APP_ID` and the private key is the secret `CREDENTIAL_ROTATION_APP_PRIVATE_KEY`, both only in environment `secret-rotation`, whose deployment branch policy allows only `main`.
- The daily check mints its token with a full-SHA `actions/create-github-app-token` and only `permission-environments: read` and `permission-secrets: read`, so it can list names and dates but cannot write.
- Creating the App and storing its private key is production credential custody and stays with the operator. Agents create `secret-rotation` with its `main`-only policy and set the ID variable.
