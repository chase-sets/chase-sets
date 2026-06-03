# Admin Profile Validation UX Plan

## Goal

Ship issue #633 by giving Catalog admins an integration-profile review surface that can inspect profile versions, see validation diagnostics, dry-run provider fixture payloads, and activate or deprecate profile versions through validated API paths.

## Current Shape

- The Catalog admin integrations page already lists Source Observation integration scopes and import/reapply actions.
- Provider profile versions are persisted through `catalog_provider_integration_profile_versions`.
- Executable profile contracts already validate fixture coverage and unsafe evidence use.
- The mapping interpreter can evaluate selectors and returns diagnostics with redaction categories.

## Implementation

1. Add a Catalog provider profile review API module that:
   - lists profile versions with lifecycle, source contract, fixture contract, capabilities, supported scopes, connector kind, and validation diagnostics;
   - dry-runs an executable profile version against an operator-supplied fixture payload;
   - returns normalized Source Observation fields, source hash, hash material evidence, external references, selected option references, merge evidence, duplicate-prevention rules, and evaluated promotion command-plan inputs;
   - redacts sensitive payload/evidence values before returning dry-run output.
2. Extend provider profile version storage with a deprecate operation and expose activate/deprecate endpoints that validate through the existing profile version rules.
3. Add API client and UI contracts/hooks for profile review, dry-run, activate, and deprecate.
4. Extend the existing Catalog integrations admin page with a profile review section:
   - profile/version table;
   - diagnostics status;
   - source/fixture/capability metadata;
   - dry-run dialog with JSON fixture input and structured output;
   - activation/deprecation actions.
5. Add focused runtime, route/client, and UI tests that cover diagnostics, redaction, dry-run output, and validation-blocked activation.

## Verification

- Focused Catalog source-observation API tests.
- Focused Catalog source-observation UI tests.
- Catalog unit tests.
- Typecheck, localization check, Prettier, and `git diff --check`.

## Non-Goals

- No visual diff editor for profile JSON.
- No persistence of ad hoc dry-run payloads.
- No live provider calls from the profile review surface.
- No automatic promotion from dry-run output.
