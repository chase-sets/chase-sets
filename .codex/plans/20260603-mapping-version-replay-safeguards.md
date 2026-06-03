# Mapping Version Replay Safeguards Plan

## Goal

Ship issue #634 by making Source Observation replay and Catalog Item promotion explicitly tied to provider profile versions and mapping fingerprints.

## Current Shape

- Source Observations persist provider key, external key, source hash, normalized payload, source payload, review status, and promoted Catalog Item link.
- The executable mapping contract already carries provider key, profile key, profile version, lifecycle, replay policy, hash material, duplicate-prevention rules, and promotion command-plan intent.
- Reapply currently refreshes promoted Catalog Items from the stored normalized observation row. That is deterministic, but operators cannot see which profile version produced the row or whether a newer active profile changes identity/hash/reference evidence.
- Promotion planning is profile-aware in memory, but no promotion plan version or fingerprint is recorded back onto the Source Observation.

## Implementation

1. Extend the Source Observation aggregate command/event/state with:
   - source profile key/version;
   - source mapping fingerprint;
   - promotion profile key/version;
   - promotion plan fingerprint.
2. Add read-model columns with backward-compatible defaults for existing rows and project the new version fields.
3. Stamp executable normalizer output from the mapping contract identity and a deterministic mapping fingerprint.
4. Stamp TCGdex and TCGplayer observation imports with source profile evidence through the shared normalizer output.
5. Stamp successful promotion and reapply flows with the profile version and promotion-plan fingerprint used to execute Catalog Item commands.
6. Add mapping migration guard helpers that compare old/new profile-version evidence for:
   - external key changes;
   - source hash changes;
   - selected-option changes;
   - external reference target-level changes;
   - promotion plan fingerprint changes.
7. Surface version/fingerprint evidence in Source Observation UI contracts and detail rows.
8. Add focused domain, projection/query, normalizer, migration-guard, runtime, and UI tests.

## Verification

- Focused Source Observation domain/read-model/runtime tests.
- Focused provider normalizer and migration guard tests.
- Focused Source Observation detail UI tests.
- Catalog source-observation API/UI suites.
- Catalog unit tests.
- Typecheck, localization check, Prettier, and `git diff --check`.

## Non-Goals

- No automatic bulk migration to a newer profile version in this issue.
- No new visual diff editor for profile JSON.
- No live provider API calls in migration comparison; comparisons use supplied fixture/payload evidence.
- No inventory or pricing schema changes unless the new guard detects a breaking change before activation/reapply.
