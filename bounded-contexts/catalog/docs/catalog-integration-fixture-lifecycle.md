# Catalog Integration Fixture Lifecycle

Catalog integration fixtures are Catalog-owned evidence used to prove a provider profile version can turn provider-controlled payloads into deterministic Source Observation facts without calling the live provider.

The authoritative TypeScript model lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-fixture-lifecycle.ts
```

## Ownership

- Catalog Source Observations owns fixture repository records, coverage sufficiency, profile-version compatibility, validation input selection, redaction state, dry-run history links, and activation-readiness diagnostics.
- Provider adapters own live transport, provider endpoints, credentials, pagination, throttling, retries, and raw payload acquisition. Adapters may supply sampled payload metadata, but they do not decide Catalog fixture coverage sufficiency.
- Ops, Security, and Legal own provider-data signoff. Catalog enforces the governed data-class and retained-data exception gates before retained sampled or fixture bodies can be used as release evidence.

## Repository Records

Each fixture repository record uses `schemaVersion: catalog-fixture-repository-record-v1` and includes:

- fixture id
- provider key
- ingestion `unitKey`
- fixture flow
- deterministic payload reference
- payload data class and redaction state
- provenance
- profile compatibility metadata
- validation status

The existing profile fixture contract remains compatible:

```text
fixtureRoot
coveredFlows
liveProviderCallsAllowed
```

The richer repository record sits beside that compact profile contract. Profile rows can still store the compact fixture metadata while validation, Admin read models, and future UI workflows consume the richer lifecycle model.

## Fixture Flows

The default activation coverage baseline is the executable mapping contract flow inventory:

- `normal`
- `partial`
- `stale`
- `changed`
- `ambiguous`
- `replay`
- `sealed-product`
- `unknown-option`

Every executable profile version must cover each required flow unless a later profile-specific coverage requirement explicitly changes the baseline. Missing flows are activation-blocking diagnostics.

## Versioning And Compatibility

Fixtures are compatible with a specific provider profile version and fixture-set version. Repository records capture:

- provider key
- profile key
- profile version
- fixture-set version
- source mapping fingerprint when available

Dry runs, activation readiness, replay planning, and migration evidence should use fixtures compatible with the profile version being evaluated. A fixture captured for one profile version must not silently validate another profile version.

## Provenance

Fixture provenance is one of:

- `generated`: authored or synthesized by Catalog for deterministic coverage.
- `manual`: manually attached by an operator as controlled fixture evidence.
- `sampled-provider`: derived from a real provider response.

Provenance may include sampled time, actor kind, source URL, source hash, job id, operator user id, account id, policy/legal signoff state, and retained-data exception issue.

Generated and manual fixtures are preferred for normal activation validation. Sampled-provider fixtures are allowed only when provider-data governance allows their retention and redacted use.

## Sampling Policy

Sampling is a provider-adapter transport activity, but Catalog owns the fixture record that describes how a sample is used for validation. Sampling must produce deterministic validation input references before activation readiness can consume it.

Live provider calls are forbidden in fixture validation and activation readiness. A provider adapter may support sampling in an operator workflow, but the sampled payload must be stored or referenced under the governed data policy before it becomes a fixture validation input.

## Redaction And Retention

Fixture payloads are governed as `fixture-payload` unless their provenance is `sampled-provider`, in which case they are governed as `sampled-provider-payload`.

Fixture previews must redact provider secrets, seller/account facts, prices, inventory, quantities, listings, and other provider-controlled commerce fields that Catalog does not own. Raw provider payload bodies remain excluded from normal Catalog evidence.

Retained sampled payload bodies, fixture bodies, provider imagery in fixture evidence, and exported provider content require policy/legal signoff plus a retained-data exception issue when the governance policy requires one.

## Coverage Sufficiency

Coverage is sufficient only when:

1. Live provider calls are not required.
2. Every required flow has coverage.
3. Fixture records match provider key, profile key, profile version, and unit key.
4. Each validation input has a deterministic payload reference.
5. Payload retention and preview behavior pass provider-data governance.

Coverage diagnostics are activation-blocking by default because activating a profile without deterministic fixture proof would make imports depend on unverified provider behavior.

## Validation Inputs

Validation input construction selects compatible fixture records and returns them in required flow order. The input shape carries:

- fixture id
- provider key
- unit key
- profile version
- flow
- payload reference

Dry-run and fixture validation workflows should read payloads from these references. They should not infer fixture paths from provider names inside UI modules or provider adapter code.

## Activation Readiness

Provider profile activation validation consumes the fixture lifecycle coverage check. It still emits the compatibility diagnostic code `missing-profile-fixture-flow` for existing callers, while richer lifecycle diagnostics identify forbidden live calls, profile mismatch, missing payload references, and governance blockers.

Admin activation readiness should present fixture blockers as Catalog semantic readiness issues, separate from provider transport or credential readiness.

## Dry-Run And History

Fixture-backed dry runs should append or project evidence using the canonical audit/evidence model:

- event name: `fixture-validation-run` for fixture harness runs
- event name: `dry-run-executed` for dry-run evidence
- data classes: `fixture-payload`, `dry-run-input-payload`, `dry-run-output-evidence`, and `engine-diagnostic`

History should retain summaries, hashes, diagnostic codes, fixture ids, and redacted previews. It should not retain raw provider bodies unless the governance gate and retained-data exception explicitly allow it.

## Migration And Backfill

Current executable profiles already declare compact fixture contracts and hard-coded fixture cases. The lifecycle helper can derive repository records from those fixtures without moving payload files. A later persistence migration can backfill repository rows from:

1. profile version rows,
2. executable mapping contract fixture metadata,
3. existing fixture case inventory,
4. audit/evidence history when available.

Backfill should preserve profile-version compatibility and should not mark sampled-provider fixture bodies retained without signoff and retained-data exception evidence.

## Related Issues

- #778 owns fixture validation, dry-run, compare, and activation UI workflows.
- #783 owns canonical audit/evidence records.
- #794 and #803 own provider-data governance and signoff.
- #806 owns final no-core-change external provider validation.
