# Magic-Strings Audit

An audit of every place a human must type or paste an exact string to get correct behavior — end-user and admin web UIs, operator tooling, CI workflows, environment configuration, and documentation. Each finding names the exact string, how a mismatch is handled today, and the recommended fix.

The core UX problem is not that exact strings exist — IDs, confirm phrases, and enum values are unavoidable — it is **what happens on a near-miss**. The audit sorts findings by failure mode:

1. **Silent wrong behavior** (worst): a typo produces a valid-looking but incorrect outcome with no error.
2. **Silent no-op**: nothing happens and nothing says why.
3. **Loud but unhelpful**: an error fires but does not name the allowed values.
4. **Loud and self-documenting** (target): the error states the expected string(s).

## Severity 1 — typos produce silent wrong behavior

### 1.1 `DEPLOYMENT_ENVIRONMENT` accepts any string; production guards silently skip

`deployables/platform-api/src/config.ts:374-388` and `deployables/admin-support-api/src/config.ts` (same helper). `getDeploymentEnvironment()` returns whatever string is set. `DEPLOYMENT_ENVIRONMENT=prod` or `Production` is not equal to `"production"`, so `isProductionDeployment()` is false and every production-only guard (required Stripe/EasyPost/SES credentials, S3-only photo storage, data-profile safety checks) silently does not apply.

**Fix:** validate against an allow-list (`production`, `staging`, `preview`, `test`, `dev`) and throw naming the allowed values, mirroring the existing `MARKETPLACE_LISTING_PHOTO_STORAGE_KIND must be filesystem or s3` pattern (`platform-api/src/config.ts:479`).

### 1.2 Provider selectors silently fall back to `noop`

- `infrastructure/platform-runtime/config-schema.ts:530-531` — `resolveMobileMessagingProvider` is `value === "twilio" ? "twilio" : "noop"`. `MOBILE_MESSAGING_PROVIDER=twillio` (or `Twilio`) silently disables SMS.
- `deployables/platform-worker/src/config.ts:525-531` — `resolveNotificationEmailProvider` accepts only `amazon-ses` | `local-capture`, else `noop`. `NOTIFICATION_EMAIL_PROVIDER=ses` / `amazon_ses` silently drops all email.

Because the credential checks fire only when the provider string matches exactly, a mistyped provider also skips the "missing credentials" errors — a deploy goes green while sending nothing.

**Fix:** unknown non-empty value → throw listing allowed values. Keep `noop` as the explicit spelled-out choice and the unset default, never the typo fallback.

### 1.3 Catalog integration kill-switches fail open on typo

`bounded-contexts/catalog/features/source-observations/api/catalog-integration-rollout-controls.ts:623-690`.

- `parseControlPlaneMode` / `parseOptionQueryMode` / `parseActivationMode` / `parseWorkerMode` return `undefined` for unrecognized values, which resolves to the default `open`. `CATALOG_INTEGRATION_WORKER_MODE=disabld` keeps the worker running; `...ACTIVATION_MODE=disable` (missing `d`) leaves activation open.
- `parseProviderScope` treats anything that is not a sentinel (`false|open|none` / `true|all|*`) as a comma-list of provider keys, so `alll` becomes an allow-list matching no provider — an emergency stop that stops nothing.

These are operational safety controls; failing open on a typo inverts their purpose.

**Fix:** unrecognized mode value → throw (fail closed). For provider scopes, validate each key against the known provider registry and reject unknown keys.

### 1.4 `EASYPOST_MODE` falls back to `test` silently

`infrastructure/platform-runtime/config-schema.ts:419` — `=== "production" ? "production" : "test"`. `EASYPOST_MODE=prod` silently buys nothing (test labels). Same fix as 1.2.

### 1.5 Boolean env flags: any unrecognized value is silently `false`

`infrastructure/platform-runtime/config-schema.ts:136-143` — `getBooleanEnv` returns `true` only for `1|true|yes|on` (case-insensitive); anything else is `false` with no warning. That is fine for cosmetic flags but drives security-relevant ones like `TWILIO_WEBHOOK_SIGNATURE_REQUIRED`: `=required` or `=enabled` silently disables signature enforcement.

**Fix:** in `getBooleanEnv`, treat a non-empty value outside `{1,true,yes,on,0,false,no,off}` as an error rather than `false`.

### 1.6 `roleKey` accepted over HTTP with no runtime validation

`bounded-contexts/identity/features/memberships/api/route.ts:44` (GrantMembership) and `:66` (ChangeMembershipRole) pass `body.roleKey` from raw JSON straight into the command. `RoleKey` is a TypeScript-only union (`identity/support/runtime-support/common.ts:20`), erased at runtime. The projection then does `ROLE_PERMISSIONS[roleKey]`, so a typo (`onwer`) creates a membership with **no permissions, silently** — the API returns 201/200.

**Fix:** add a runtime `ROLE_KEYS` array next to `ROLE_PERMISSIONS` (single source of truth), derive the type from it (`typeof ROLE_KEYS[number]`), and reject unknown keys at the route with a 400 naming valid roles. Reuse the same array to render the role `<select>` options in the UI so the picker and the validator cannot drift.

## Severity 2 — exact-ID free-text entry in admin UIs

Four admin forms require typing/pasting an exact opaque ID into a plain `TextInput` with no lookup, format hint, or client-side validation. Typos 404 at best and mis-target a resource at worst:

| Form | Field | Location |
|---|---|---|
| Create API key | `userId` | `identity/features/api-keys/ui/api-key-list-page.tsx:30` |
| Create invitation | `accountId` | `identity/features/invitations/ui/invitation-list-page.tsx:38` |
| Create commercial agreement | `accountId` | `commercial-terms/features/agreements/ui/agreement-list-page.tsx:73` |
| Open support request | `orderId` | `platform-operations/features/support-requests/ui/support-request-list-page.tsx:173` |

Note the inconsistency inside the same forms: `roleKey` and flow-type are proper `Select`s while the adjacent ID is free text.

**Fixes, in order of preference:**
1. **Entity pickers** — a search-as-you-type combobox backed by the existing list read models (users, accounts, orders). The read models and list endpoints already exist for the adjacent list pages.
2. Where a picker is not yet warranted, **validate the typed-ID prefix on blur/submit** using `parseTypedId` from `contracts/primitives/typed-ids.ts` (`usr_`, `acc_`, `ord_`), echo back the resolved entity's display name for confirmation before submit, and hard-fail unknown IDs with a clear message.
3. Everywhere an ID is displayed (detail pages, list rows), render it with a copy button so the paste source is reliable — a copy-then-paste flow at least eliminates transcription typos.

Related: the guest-order claim flow (`payments/routes/marketplace/account-payment.tsx:429`) asks users to paste a claim token from email. Prefer a link that carries the token in the URL, with the paste field as fallback only.

### Transitional raw scope field

`catalog/features/source-observations/ui/admin-control-plane/import-to-promotion/import-context-bar.tsx:217,233` — `importScope` and `profileVersion` are free-text fields (the code comments already flag them as transitional). A mistyped scope token silently narrows or empties the import set. Prioritize replacing with guided option queries per provider, as the surrounding code intends.

## Severity 3 — operator tooling and CI

### 3.1 `replay:projection` takes unvalidated context/projection names

`scripts/replay-projection.ts:105-116` — `deployableName` is validated with usage output (good), but `contextName` and `projectionName` are passed straight into the rebuild. A typo surfaces as a deep runtime error, and the CLI never shows valid names even though `status` mode can enumerate them.

**Fix:** on unknown context/projection, print the valid names (the data already exists in `status`) and exit non-zero before touching anything. This is a destructive rebuild driven by an unguessable exact string — it deserves the best error in the repo.

### 3.2 EasyPost replay workflow green-skips on a mistyped confirm phrase

`.github/workflows/marketplace-easypost-refund-event-replay.yml:70` — `if: inputs.mode != 'replay' || inputs.confirm == 'replay easypost refund event'` gates the whole job. With `mode=replay` and a wrong/blank confirm phrase, the job **skips** — no failure, no explanation — and the operator can believe the replay ran. The underlying script would hard-error helpfully (`scripts/easypost-refund-event-replay.mjs:53-63`), but the workflow never reaches it.

**Fix:** drop the job-level `if:` and let the script's own validation fail the run loudly, or add an explicit first step that fails with "confirm must be exactly …" when the phrase mismatches.

### 3.3 Confirm phrases duplicated between code and prompts

The exact phrases (`replay easypost refund event`, `reset staging`, `collect redacted staging order-readiness trace`) live in script constants, workflow input descriptions, and runbooks independently. They currently match; nothing keeps them matching.

**Fix:** make the workflow input description reference the script as the source of truth (or generate it), and have runbooks quote the phrase from one place. Low effort: a test that greps the workflow description against the script constant.

### 3.4 pnpm script namespace requires exact recall

`package.json` carries ~55 `test:<exact-name>` entries plus near-aliases (`test` / `test:fast` / `verify:test`; `test:db` / `verify:test-db` / `verify:db`). Discoverability is "open package.json"; a typo yields pnpm's generic "command not found."

**Fix:** an `ops`-style index (extend `scripts/ops.mjs help`, which already does this well) as the documented entry point, and prune true aliases.

## Severity 4 — duplication and drift hazards

- **`.env.example` files lag code by hand.** Four example files list ~60 vars each with no generator; newer vars (`REALTIME_*`, `MCP_*`, `PLATFORM_DATA_PROFILES`, …) are missing from some. `PLATFORM_INTERNAL_AUTH_SECRET` appears in `admin-support-api/.env.example:7` (with the literal dev secret, duplicating the default in `infrastructure/platform-runtime/http.ts:32`) but not in the platform-api/worker examples — yet the services must share the value, so setting it on one side silently 401s. **Fix:** generate `.env.example` from the config readers, or add a verify script asserting every `getOptionalEnv`/`getRequiredEnv` name appears in the examples.
- **Social provider literals defined four times** (`"google"`/`"facebook"`): `auth/features/sessions/domain/auth-flow.ts`, `identity/support/runtime-support/common.ts:11`, `auth/support/api-support/social-login-routes.ts:75-76`, plus env var names. **Fix:** one runtime const array in contracts; derive types and checks from it.
- **Data-profile allow-list duplicated** between `platform-api/src/config.ts:412-417` and `admin-support-api/src/config.ts:246-251`; same for the `READ_CONSISTENCY_ROUTE_TUNING_JSON` validator. **Fix:** hoist to `infrastructure/platform-runtime/config-schema.ts`.
- **Webhook mount paths** (`/api/fulfillment/provider/postage/webhooks`, `/api/payments/provider/webhooks`, `/api/settlement/provider/money-movement/webhooks`, `/api/notifications/provider/email/webhooks`) are hand-typed into provider dashboards and repeated across six runbooks and the EasyPost workflow. **Fix:** export the mount paths as constants where routes mount, and have runbooks/workflows reference a single generated table (the readiness scripts already print exact values — extend that pattern).
- **Production launch checklists ask humans to copy values "exactly as listed"** (`scripts/marketplace-production-launch-readiness.mjs:229`, SES/ARN/bucket tables in `docs/runbooks/digitalocean-platform-deployment.md:145-159`). Wherever a readiness script can verify the value (it already checks `GOOGLE_MERCHANT_*`), prefer verification over instruction.

## Patterns already working — adopt as house rules

The codebase already contains the right patterns; the fixes above mostly mean applying them consistently:

- **Fail loudly with the allowed values named:** `MARKETPLACE_LISTING_PHOTO_STORAGE_KIND must be filesystem or s3`; `STRIPE_CONNECT_ACCOUNTS_API` (`v1|v2`); `REALTIME_STREAM_LIMITER` (`local|redis|postgres`); `quantityMode must be add or replace` (inventory MCP).
- **Enumerate on unknown input:** `scripts/dev-system.mjs` — `Unknown dev target "X". Use one of: <list>`; `scripts/ops.mjs` help listing.
- **Normalize before matching:** the inventory import pipeline (`import-batches/api/runtime.ts:353-390`) matches dimensions/options by id, code, or label after trim/lowercase/strip-punctuation, and CSV headers via alias sets — users can type `Near Mint`, `near-mint`, or the option id and all resolve. This is the gold standard for user-supplied enum-ish values.
- **Typed ID prefixes** (`contracts/primitives/typed-ids.ts`): every ID is self-identifying (`acc_`, `usr_`, `ord_`), and `parseTypedId` throws on wrong prefix — currently underused at UI/API boundaries.
- **Choice inputs over free text:** CI workflows already use `type: choice` for mode/environment; most admin forms use `Select`/`NativeSelect`.
- **Checkbox instead of typed confirmation phrase** for the catalog create-items commit.

## Recommended order of work

1. **Config fail-closed sweep** (1.1–1.5): one shared `resolveEnum(name, value, allowed, default)` helper in `config-schema.ts`; convert the silent-fallback sites. Small diff, removes the worst failure class.
2. **`roleKey` runtime validation** (1.6): runtime const array + route validation + UI select from the same array.
3. **CI confirm-gate fix** (3.2): make mismatch fail loudly.
4. **Admin ID pickers or typed-ID validation** (Severity 2), starting with the invitation and agreement forms.
5. **`replay:projection` name validation** (3.1).
6. **Drift tooling** (Severity 4): `.env.example` generation/check, hoist duplicated allow-lists, webhook-path constants.
