# Issue #636: Retire provider-specific mapping code after config-driven migration

## Context
- TCGdex, TCGplayer, and Scrydex/Scryfall-style profiles now run through executable mapping contracts and fixture-backed profile contract tests.
- The remaining risky runtime coupling is not raw transport parsing; it is promotion and duplicate-prevention code still reaching for `tcgdexPokemonTcgProviderProfile` when promoting any Pokemon-card Source Observation.
- Provider transport clients still belong in the Source Observations API slice, but they should fetch/parse only. Catalog mapping semantics must come from provider profiles/contracts and shared interpreters.

## Approach
1. Remove hardcoded provider profile usage from promotion/runtime paths.
   - Resolve the promotion profile from the observation provider key.
   - Use the active profile version for promotion evidence/fingerprints.
   - Pass the resolved profile into duplicate-prevention, reference hierarchy provisioning, field/category lookup, and promotion planning.
2. Keep transport-specific clients but prevent them from becoming mapping owners.
   - Add static coverage that scans runtime and transport client modules for forbidden provider-profile imports and `to*SourceObservation` style mapping exports.
   - Keep existing TCGplayer response-contract tests because they validate client DTO/fixture boundaries, not Catalog aggregate mapping.
3. Update docs to mark executable profile contracts and the fixture harness as the canonical integration path.
   - Provider adapters fetch/parse; profile interpreters normalize, hash, reference, duplicate, and promotion evidence.

## Verification
- Source Observations API tests.
- Catalog unit tests.
- Repository typecheck.
- Localization check if docs/contracts change scan requires it.
- Sandbox doctor.
