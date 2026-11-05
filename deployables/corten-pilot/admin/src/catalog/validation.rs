//! Provider detail's validation readiness (admin-web's provider-readiness, fixture, dry-run,
//! semantic compare, activation readiness and activation decision sections): the slices of the
//! Catalog API's composed health surface the provider page already reads
//! (`readModel.validationReadiness`, with the selected scope's readiness), and the activation
//! decision's two commands.
//!
//! | Route | Answers |
//! |---|---|
//! | `POST /catalog/providers/{key}/evidence?<context>` | records migration evidence on the decision's profile version |
//! | `POST /catalog/providers/{key}/activate?<context>` | activates the decision's profile version |
//!
//! Each command is the API's own (`.../provider-profiles/{key}/{version}/sections/migration-evidence`,
//! `.../provider-profiles/{key}/{version}/activate`); the API decides whether it is allowed and refuses
//! what it will not take, and the page draws the refusal. admin-web posts both to its route action
//! with an `_intent`; the pilot gives each its own route.
//!
//! Workaround, to remove when its issue lands: chase-sets/chase-sets#11068. The section command takes
//! the whole evidence object, and its time comes from the client, so the evidence form carries the
//! decision's fingerprints and the read's `generatedAt` (or the evidence's `recordedAt`) as admin-web's
//! does. The text is sent as typed: a blank one is refused by the API's own check, where admin-web
//! would send a fixed sentence in its place.
use corten::{
    http::{HeaderMap, Uri},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    api::{Kind, under},
    command, daily,
    provider::{self, Done, again, answer},
};
use crate::{
    api::Method,
    app::Shared,
    auth::{CatalogAccess, Staff},
};

/// `CatalogPrimaryWorkbenchValidationReadinessReadModel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Validation {
    pub status: String,
    pub summary: Summary,
    pub fixture_flows: Vec<FixtureFlow>,
    pub dry_run_evidence: Vec<DryRun>,
    pub semantic_compare: Compare,
    pub activation_readiness: ActivationReadiness,
    pub activation_decision: Decision,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Summary {
    pub ready_fixture_flows: u64,
    pub total_fixture_flows: u64,
    pub blocked_fixture_flows: u64,
    pub dry_run_evidence_count: u64,
    pub semantic_change_count: u64,
    pub unchanged_section_count: u64,
    pub blocking_readiness_checks: u64,
    pub audit_evidence_count: u64,
}

/// A fixture flow and what its fixture is expected to prove.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct FixtureFlow {
    pub flow: String,
    pub label: String,
    pub status: String,
    pub payload_file: Option<String>,
    pub payload_path: Option<String>,
    pub expected_status: Option<String>,
    pub expected_diagnostic_paths: Vec<String>,
    pub expected_hash_evidence_paths: Vec<String>,
    pub expected_merge_evidence_paths: Vec<String>,
    pub expected_promotion_commands: Vec<String>,
    pub sample_payload_available: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub path: String,
    pub domain_concept: String,
    pub diagnostic_text: String,
    pub severity: String,
    pub fixture_flow: Option<String>,
}

/// A fixture-backed dry run's proof.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct DryRun {
    pub external_key: String,
    pub source_url: Option<String>,
    pub source_hash: Option<String>,
    pub status: String,
    pub normalized_facts: Vec<Fact>,
    pub redaction_summary: Vec<Labelled>,
    pub duplicate_candidates: Vec<EvidenceRow>,
    pub selected_options: Vec<EvidenceRow>,
    pub promotion_command_preview: Vec<CommandPreview>,
    pub diagnostics: Vec<Diagnostic>,
    pub audit_evidence: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Fact {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Labelled {
    pub label: String,
    pub value: String,
}

/// `CatalogPrimaryWorkbenchValidationEvidenceRow`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct EvidenceRow {
    pub key: String,
    pub label: String,
    pub path: String,
    pub summary: String,
    pub owner: Option<String>,
    pub uses: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CommandPreview {
    pub command_name: String,
    pub inputs: Vec<EvidenceRow>,
}

/// The selected version beside the active one.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Compare {
    pub mapping_fingerprint: Fingerprint,
    pub activation_impact: Vec<String>,
    pub fixture_coverage: Vec<Coverage>,
    pub sections: Vec<Section>,
    pub unchanged_sections: Vec<Unchanged>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Fingerprint {
    pub candidate: Option<String>,
    pub active: Option<String>,
    pub changed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Coverage {
    pub flow: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Section {
    pub section_key: String,
    pub domain_concept: String,
    pub status: String,
    pub change_count: u64,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub label: String,
    pub candidate_summary: String,
    pub active_summary: String,
    pub activation_impact: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Unchanged {
    pub section_key: String,
    pub domain_concept: String,
}

/// The activation checks, by domain concept.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivationReadiness {
    pub status: String,
    pub requires_migration_evidence: bool,
    pub reference_count: u64,
    pub groups: Vec<Group>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Group {
    pub domain_concept: String,
    pub status: String,
    pub checks: Vec<Check>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Check {
    pub check_key: String,
    pub code: String,
    pub status: String,
    pub path: String,
    pub diagnostic_text: String,
    pub severity: String,
    pub remediation: String,
}

impl Check {
    /// admin-web's checklist state: blocked, a warning, or passed.
    pub fn state(&self) -> &'static str {
        if self.status == "blocked" {
            "blocked"
        } else if self.severity == "warning" {
            "warning"
        } else {
            "passed"
        }
    }
}

/// Whether the selected version can be activated, and what saving its evidence and activating it
/// would do.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Decision {
    pub status: String,
    pub action_state: String,
    pub blockers: Vec<String>,
    pub save_evidence_state: String,
    pub save_evidence_blockers: Vec<String>,
    pub provider_key: Option<String>,
    pub profile_version: Option<String>,
    pub lifecycle: Option<String>,
    pub import_eligibility: String,
    pub affected_references: AffectedReferences,
    pub migration_evidence: Evidence,
    pub audit_consequences: AuditConsequences,
}

/// Whether an action the read model offers can run (admin-web's `isDecisionActionAvailable`).
pub fn open(state: &str) -> bool {
    state == "available" || state == "degraded"
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AffectedReferences {
    pub reference_count: u64,
    pub requires_migration_evidence: bool,
    pub replay_implications: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Evidence {
    pub state: String,
    pub evidence_text: String,
    pub fixture_run_id: Option<String>,
    pub mapping_fingerprint_before: Option<String>,
    pub mapping_fingerprint_after: Option<String>,
    pub recorded_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditConsequences {
    pub audit_evidence_url: String,
    pub event_names: Vec<String>,
    pub summary: String,
}

/// The import scope's readiness (`importJobs.selectedScope.readiness`), for provider readiness.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeReadiness {
    pub adapter_readiness: String,
    pub credential_readiness: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct SelectedScope {
    pub readiness: ScopeReadiness,
}

/// The evidence form: the version it is for, the text and fixture run typed, and (workaround,
/// chase-sets/chase-sets#11068) the fingerprints and time admin-web's form carries.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceInput {
    pub profile_version: String,
    pub migration_evidence_text: String,
    pub migration_fixture_run_id: String,
    pub migration_fingerprint_before: String,
    pub migration_fingerprint_after: String,
    pub migration_recorded_at: String,
}

impl EvidenceInput {
    /// The API's section command. The text goes as typed (trimmed), so a blank one is the API's to
    /// refuse; an empty fixture run or fingerprint is none.
    pub fn command(&self) -> Value {
        let some = |value: &str| {
            let value = value.trim();
            if value.is_empty() { Value::Null } else { Value::String(value.to_owned()) }
        };
        json!({
            "command": {
                "section": "migration-evidence",
                "migrationEvidence": {
                    "evidenceText": self.migration_evidence_text.trim(),
                    "fixtureRunId": some(&self.migration_fixture_run_id),
                    "mappingFingerprintBefore": some(&self.migration_fingerprint_before),
                    "mappingFingerprintAfter": some(&self.migration_fingerprint_after),
                    "recordedAt": self.migration_recorded_at.trim(),
                }
            }
        })
    }
}

/// The activate form: the version it activates.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivateInput {
    pub profile_version: String,
}

pub(crate) async fn evidence(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<provider::url::Evidence<'_>>,
    Form(input): Form<EvidenceInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let version = input.profile_version.trim();
    if version.is_empty() {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/provider-profiles{}", under(&route.key, &[version, "sections", "migration-evidence"]));
    let sent = command(&caller, Method::PATCH, Kind::SourceObservations, &rest, Some(&input.command())).await;
    let changes = [("profileVersion", Some(version))];
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &changes, Done::EvidenceSaved).await
}

pub(crate) async fn activate(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<provider::url::Activate<'_>>,
    Form(input): Form<ActivateInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let version = input.profile_version.trim();
    if version.is_empty() {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/provider-profiles{}", under(&route.key, &[version, "activate"]));
    let sent = command(&caller, Method::POST, Kind::SourceObservations, &rest, None).await;
    let changes = [("profileVersion", Some(version))];
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &changes, Done::Activated).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_evidence_command_sends_the_text_as_typed_and_empty_values_as_none() {
        let input = EvidenceInput {
            profile_version: "2026.07.13".into(),
            migration_evidence_text: "  Replayed the changed fixtures.  ".into(),
            migration_fixture_run_id: " ".into(),
            migration_fingerprint_before: "fp_a".into(),
            migration_fingerprint_after: String::new(),
            migration_recorded_at: "2026-11-05T12:00:00.000Z".into(),
        };
        assert_eq!(
            input.command(),
            json!({ "command": { "section": "migration-evidence", "migrationEvidence": {
                "evidenceText": "Replayed the changed fixtures.", "fixtureRunId": null,
                "mappingFingerprintBefore": "fp_a", "mappingFingerprintAfter": null,
                "recordedAt": "2026-11-05T12:00:00.000Z" } } })
        );
        let blank = EvidenceInput { migration_evidence_text: "   ".into(), ..input };
        assert_eq!(blank.command()["command"]["migrationEvidence"]["evidenceText"], "", "the API's to refuse, not replaced");
    }

    #[test]
    fn a_check_is_blocked_a_warning_or_passed() {
        let check = |status: &str, severity: &str| Check { status: status.into(), severity: severity.into(), ..Check::default() };
        assert_eq!(check("blocked", "warning").state(), "blocked");
        assert_eq!(check("passed", "warning").state(), "warning");
        assert_eq!(check("passed", "error").state(), "passed");
        assert!(open("available") && open("degraded") && !open("blocked") && !open("denied"));
    }
}
