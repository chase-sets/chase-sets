# Issue #635: Config-driven integration contract test harness

## Context
- Provider profiles already expose executable mapping contracts, required fixture flows, redaction ownership, dry-run review output, mapping fingerprints, and promotion plan fingerprints.
- Validation currently proves contract shape and declared fixture flow coverage, but it does not execute every active/test profile against golden payload fixtures or assert expected normalized observations, references, selected options, merge evidence, and promotion command inputs.
- The fixture tree currently only has a single Scrydex/Scryfall payload; TCGdex and TCGplayer fixtures need local, sanitized golden payloads so CI can validate without live calls.

## Approach
1. Add a fixture-backed profile contract harness in the Source Observations API slice.
   - Define fixture case metadata for provider key, profile version, flow, payload file, expected status, expected diagnostics, expected normalized shape, evidence assertions, selected options, external references, and promotion command inputs.
   - Load payloads from each profile version's configured `fixtures.fixtureRoot`.
   - Run the same schema validation and dry-run/normalizer paths used by the admin review surface.
   - Report failures with provider/profile/flow plus profile rule path or provider payload path.
2. Add sanitized golden fixtures for TCGdex, TCGplayer automation, and Scrydex/Scryfall-style payloads.
   - Cover normal, partial, stale, changed, ambiguous, replay, sealed-product, and unknown-option flows for every executable profile version.
   - Keep price, inventory, seller, auth, and secrets out of catalog truth assertions.
3. Add CI/static verification coverage.
   - Unit test all built-in profile versions through the harness.
   - Add a repository script that runs the harness test directly so CI/local workflows have a named command.
4. Keep scope inside the catalog bounded context.
   - No live provider calls, no connector transport changes, and no broad import runtime refactor.

## Verification
- Targeted Source Observations API tests.
- Catalog unit tests.
- Typecheck.
- Localization check if UI/contracts are touched.
- Sandbox doctor.
