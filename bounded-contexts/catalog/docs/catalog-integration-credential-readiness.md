# Catalog Integration Credential Readiness

Catalog Provider Integration Profiles describe Catalog semantics. They must not store provider usernames, passwords, bearer tokens, cookies, session IDs, marketplace account identifiers, or any other provider credential material. Provider adapters own credential configuration, validation, rotation, revocation, and readiness reporting for their transport boundary.

## Ownership

- Catalog owns profile semantic readiness, dry-run evidence, Admin read-model contracts, diagnostic taxonomy, and redacted audit/evidence summaries.
- Provider adapters own live provider credentials, credential/session validation, provider account scoping, transport retry/throttle behavior, and the secret store integration used by each deployable.
- Operators configure credentials through deployable/runtime configuration or managed secret references, never through Catalog-facing profile section forms or raw profile JSON edits.

## Storage And Scope

Credential material belongs in an encrypted runtime secret store appropriate to the environment. Catalog may reference only secret-free metadata:

- `providerKey`
- `unitKey`
- credential requirement
- credential readiness state
- credential source kind
- environment key
- account or tenant label when the provider requires one
- redacted secret reference label
- validation timestamps and rotation/revocation timestamps

Adapters may scope credentials by provider, environment, tenant/account, or ingestion unit when a provider needs that split. The scope labels must remain operator-safe labels; they must not include seller account facts, provider account secrets, cookies, or raw provider payload values.

## Readiness States

Adapters report credential readiness separately from provider transport diagnostics:

| State | Import behavior | Operator meaning |
| --- | --- | --- |
| `not-required` | Allowed | Provider transport is public or fixture-backed. |
| `configured` | Allowed | Required credential material is present and the adapter can use it. |
| `missing` | Blocked | Required credential material is absent. |
| `invalid` | Blocked | Provider rejected or adapter validation failed for the credential. |
| `expired` | Blocked | Credential or session lifetime elapsed. |
| `revoked` | Blocked | Credential was intentionally revoked or disabled. |
| `unknown` | Blocked | Adapter cannot determine readiness safely. |

Missing, invalid, expired, revoked, or unknown credentials block live imports and option queries. They do not mutate profile data and do not make Catalog profile semantics invalid. Admin readiness must show credential readiness as its own axis beside semantic readiness, transport readiness, fixture validation, and dry-run status.

## Diagnostics And Redaction

Credential readiness uses the Catalog Integration Diagnostic Taxonomy with `credential-readiness` as the source and `credential-redacted` evidence policy. Current blocking codes are:

- `credential-missing`
- `credential-invalid`
- `credential-expired`
- `credential-revoked`
- `adapter-authentication-failed` for unknown authentication failures that cannot be classified more precisely

Credential readiness evidence may include state, requirement, source kind, redacted secret reference labels, provider key, unit key, environment label, and validation timestamps. It must not include tokens, cookies, passwords, bearer values, authorization headers, provider account secrets, seller/account facts, or raw provider payload bodies.

## Rotation And Revocation

Rotation replaces the secret value in the adapter-owned secret store, then reruns adapter validation. Revocation removes or disables the old credential, marks readiness as `revoked` until replacement validation succeeds, and blocks imports during the gap. Audit evidence records the readiness transition and redacted scope metadata only.

## Local And Test Credentials

Local/dev/test flows may use explicit `local-fake` credential source metadata for deterministic tests and fixtures. Fake credentials never count as production approval and must not be copied into production/staging secret stores. Fixture-backed providers and public transports should report `not-required` instead of pretending a fake credential exists.

## Current Provider Policy

| Provider | Credential policy |
| --- | --- |
| Reference Cards | Fixture-backed proof adapter; credentials are `not-required`. |
| TCGdex | Public JSON transport; credentials are `not-required`. |
| TCGplayer | Required automation client/session owned by the TCGplayer adapter and runtime secret configuration; missing session readiness blocks live transport without changing profile semantics. |

## Related Docs

- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md)
- [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Provider Integration Profiles](./provider-integration-profiles.md)
- [TCGplayer Automation Operations](../../../docs/runbooks/tcgplayer-automation-operations.md)
