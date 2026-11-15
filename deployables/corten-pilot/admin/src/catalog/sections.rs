//! Provider detail's profile section editing (admin-web's `ProfileSectionWorkspaces` and its
//! `provider-profile.edit-section` command): each of the selected version's registered sections, as
//! the Catalog API's composed surface describes it (`readModel.profileAuthoring.sectionWorkspaces`,
//! read with the provider's page), and its form, saved through the API's typed section command.
//!
//! | Route | Answers |
//! |---|---|
//! | `POST /catalog/providers/{key}/sections/{section}?<context>` | saves one section of a profile version |
//!
//! The API decides whether a section may change and refuses what it will not take; the page draws the
//! refusal. Which fields a section has, their values, options and whether each may be edited come
//! from the read model, so the form is drawn from it rather than written here.
//!
//! Workaround, to remove when its issue lands: chase-sets/chase-sets#11074. The section command takes
//! the whole section, so the save reads the version's authoring model
//! (`GET .../provider-profiles/{key}/{version}/authoring`) and merges the posted fields over the
//! stored ones as admin-web's `profileSectionCommandFromFormData` does, with its defaults and fixed
//! values (fixtures never call the provider live, promotion is always reviewed, a retired profile is
//! removed once its executable mapping contract is active, and the rest named in that issue). There
//! is no revision check, as there. One difference, as the validation readiness' evidence form has
//! (chase-sets/chase-sets#11068): migration evidence's text is never filled with admin-web's fixed
//! sentence, which would satisfy activation; a blank one is sent blank, for the API to refuse.
use std::collections::BTreeMap;

use corten::{
    http::{HeaderMap, Uri},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{
    api::{Catalog as _, Kind, under},
    command, daily,
    provider::{self, Done, again, answer},
};
use crate::{
    api::Method,
    app::{Shared, refused},
    auth::{CatalogAccess, Staff},
};

/// `sectionGroups`: the groups the sections are listed in, in order.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Group {
    pub key: String,
    pub label: String,
    pub sections: Vec<String>,
}

/// One section's workspace (`CatalogPrimaryWorkbenchProfileSectionWorkspace`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Workspace {
    pub section_key: String,
    pub display_name: String,
    pub group_label: String,
    pub description: String,
    pub domain_concept: String,
    pub status: String,
    pub editable: bool,
    pub action_state: String,
    pub blockers: Vec<String>,
    pub dirty_state: String,
    pub stale_state: String,
    pub save_outcome: String,
    pub fields: Vec<Field>,
    pub diagnostics: Vec<Diagnostic>,
    pub semantic_change_count: u64,
    pub readiness_check_count: u64,
    pub anchor_id: String,
}

/// A section's field: its control, value and whether it may be changed.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    pub value: String,
    /// `text`, `textarea`, `select`, `checkbox` or `tags` (a comma-separated list, typed as text).
    pub control: String,
    pub required: bool,
    pub disabled: bool,
    pub help_text: Option<String>,
    pub options: Vec<Choice>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Diagnostic {
    pub path: String,
    pub diagnostic_text: String,
    pub severity: String,
}

/// The sections the API's section command takes (`CatalogProviderProfileEditableSectionKey`).
pub const EDITABLE: [&str; 15] = [
    "basics",
    "provider-options",
    "connector",
    "catalog-field-mapping",
    "source-contract",
    "fixtures",
    "source-observation",
    "normalized-observation",
    "external-references",
    "selected-options",
    "reference-hierarchy",
    "duplicate-prevention",
    "promotion-plan",
    "retirement-plan",
    "migration-evidence",
];

/// The version the form is for; the hidden field every section form carries.
pub const PROFILE_VERSION: &str = "profileVersion";

/// What a section form posted: each field it sent, by name. A field the form left out (disabled, or
/// a checkbox not checked) is missing, which keeps the stored value; one sent blank is blank.
pub type Posted = BTreeMap<String, String>;

/// `stringValue`: the text trimmed, or none when it is blank or not text.
fn text(value: Option<&Value>) -> Option<Value> {
    value.and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(|v| Value::String(v.to_owned()))
}

/// `stringValue` of a posted field.
fn sent(form: &Posted, key: &str) -> Option<Value> {
    form.get(key).map(|v| v.trim()).filter(|v| !v.is_empty()).map(|v| Value::String(v.to_owned()))
}

/// `listValue`: a posted comma-separated list, or `fallback` when it has no entries.
fn list(form: &Posted, key: &str, fallback: Option<&Value>) -> Option<Value> {
    let parsed: Vec<Value> = form
        .get(key)
        .map(|v| v.split(',').map(str::trim).filter(|e| !e.is_empty()).map(|e| Value::String(e.to_owned())).collect())
        .unwrap_or_default();
    if parsed.is_empty() { fallback.cloned() } else { Some(Value::Array(parsed)) }
}

/// `nullableStringValue`: a posted field trimmed (blank is null), or `fallback` when it was not sent.
fn nullable(form: &Posted, key: &str, fallback: Option<&Value>) -> Value {
    match form.get(key) {
        Some(v) if v.trim().is_empty() => Value::Null,
        Some(v) => Value::String(v.trim().to_owned()),
        None => fallback.cloned().unwrap_or(Value::Null),
    }
}

/// `numberValue`: a finite number, or text that reads as one.
fn number(value: Option<&Value>) -> Option<Value> {
    let read = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !read.is_finite() {
        return None;
    }
    // A whole number goes as an integer, as JSON.stringify writes one.
    #[expect(clippy::cast_possible_truncation, reason = "only a whole number within i64's range is cast")]
    let whole = (read.fract() == 0.0 && read.abs() < 9.0e15).then_some(read as i64);
    Some(whole.map_or_else(|| json!(read), |n| json!(n)))
}

/// `recordValue`: an object's fields, or none.
fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `recordValue(..) ?? {}`, owned.
fn object(value: Option<&Value>) -> Map<String, Value> {
    record(value).cloned().unwrap_or_default()
}

/// `arrayValue(..).map(jsonRecord)` before an edit: the entries, each an object.
fn records(value: Option<&Value>) -> Vec<Map<String, Value>> {
    value.and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().map(|e| object(Some(e))).collect())
}

/// Sets `key` when there is a value; JSON.stringify leaves an undefined one out.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

/// `a ?? b ?? fallback` over text.
fn first_text(values: [Option<Value>; 2], fallback: &str) -> Value {
    values.into_iter().flatten().next().unwrap_or_else(|| Value::String(fallback.to_owned()))
}

/// `expressionWithPath`: the stored expression (or admin-web's default one) with the posted path.
fn with_path(value: Option<&Value>, form: &Posted, key: &str) -> Value {
    let mut expression = record(value).cloned().unwrap_or_else(|| {
        let default = json!({ "owner": "catalog-truth", "uses": ["source-payload"], "redaction": "none" });
        default.as_object().cloned().unwrap_or_default()
    });
    let mut selector = record(expression.get("selector")).cloned().unwrap_or_else(|| {
        let default = json!({ "kind": "path", "required": true, "nullPolicy": "diagnostic" });
        default.as_object().cloned().unwrap_or_default()
    });
    let path = first_text([sent(form, key), text(selector.get("path"))], "");
    selector.insert("kind".into(), "path".into());
    selector.insert("path".into(), path);
    expression.insert("selector".into(), Value::Object(selector));
    Value::Object(expression)
}

/// The leading integer `parseInt` reads, or 0 (`Math.max(0, parseInt(..) || 0)`).
fn index(form: &Posted, key: &str) -> usize {
    let raw = form.get(key).map_or("0", |v| v.trim());
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

/// admin-web's `profileSectionCommand`: the section command for `section` of `profile` (the
/// authoring model's `review`), the posted fields over the stored ones. None for a section the
/// command does not take.
pub fn section_command(profile: &Value, section: &str, form: &Posted) -> Option<Value> {
    let get = |key: &str| profile.get(key);
    let body = record(get("profile"));
    let contract = record(get("executableMappingContract"));
    let of = |map: Option<&Map<String, Value>>, key: &str| map.and_then(|m| m.get(key)).cloned();
    let mut command = Map::new();
    command.insert("section".into(), section.into());
    match section {
        "basics" => {
            put(&mut command, "displayName", sent(form, "displayName").or_else(|| get("displayName").cloned()));
            let lifecycle = form.get("lifecycle").filter(|v| *v == "draft" || *v == "test");
            put(&mut command, "lifecycle", lifecycle.map(|v| Value::String(v.clone())));
            let status = form.get("status").filter(|v| *v == "active" || *v == "planned").cloned().unwrap_or_else(|| {
                if get("status").and_then(Value::as_str) == Some("active") { "active".into() } else { "planned".into() }
            });
            command.insert("status".into(), status.into());
            for key in ["capabilities", "supportedScopes", "languageOptions"] {
                put(&mut command, key, list(form, key, get(key)));
            }
        }
        "provider-options" => {
            let mut queries = body.and_then(|b| b.get("optionQueries")).and_then(Value::as_array).cloned().unwrap_or_default();
            let at = index(form, "optionQueryIndex");
            if let Some(entry) = queries.get_mut(at) {
                let mut query = object(Some(entry));
                for (field, name) in [
                    ("displayName", "optionQueryDisplayName"),
                    ("scope", "optionQueryScope"),
                    ("operation", "optionQueryOperation"),
                ] {
                    let value = first_text([sent(form, name), text(query.get(field))], "");
                    query.insert(field.into(), value);
                }
                *entry = Value::Object(query);
            }
            let queries: Vec<Value> = queries.iter().map(|q| Value::Object(object(Some(q)))).collect();
            command.insert("optionQueries".into(), queries.into());
        }
        "connector" => {
            let mut connector = object(body.and_then(|b| b.get("connector")));
            put(&mut connector, "kind", sent(form, "connectorKind").or_else(|| get("connectorKind").cloned()));
            put(&mut connector, "baseUrl", sent(form, "connectorBaseUrl"));
            let stored = record(contract.and_then(|c| c.get("connector")));
            let mut mapping = stored.cloned().unwrap_or_default();
            let kind = sent(form, "connectorKind")
                .or_else(|| text(stored.and_then(|s| s.get("kind"))))
                .or_else(|| get("connectorKind").cloned());
            put(&mut mapping, "kind", kind);
            for (field, name) in [("transportOwns", "connectorTransportOwns"), ("mappingOwns", "connectorMappingOwns")] {
                let strings: Vec<Value> = stored
                    .and_then(|s| s.get(field))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter(|e| e.is_string()).cloned().collect())
                    .unwrap_or_default();
                put(&mut mapping, field, list(form, name, Some(&Value::Array(strings))));
            }
            command.insert("connector".into(), Value::Object(connector));
            command.insert("mappingConnector".into(), Value::Object(mapping));
        }
        "catalog-field-mapping" => {
            let mut mapping = object(body.and_then(|b| b.get("catalogFieldMapping")));
            for key in ["blueprintKey", "categoryKey"] {
                let value = first_text([sent(form, key), text(mapping.get(key))], "");
                mapping.insert(key.into(), value);
            }
            command.insert("catalogFieldMapping".into(), Value::Object(mapping));
        }
        "source-contract" => {
            let stored = record(get("sourceContract"));
            let mut contract = Map::new();
            put(&mut contract, "owner", sent(form, "sourceOwner").or_else(|| of(stored, "owner")));
            contract.insert("repository".into(), nullable(form, "sourceRepository", stored.and_then(|s| s.get("repository"))));
            contract.insert("commit".into(), nullable(form, "sourceCommit", stored.and_then(|s| s.get("commit"))));
            put(&mut contract, "documentPath", sent(form, "sourceDocumentPath").or_else(|| of(stored, "documentPath")));
            put(&mut contract, "fixtureSetVersion", sent(form, "fixtureSetVersion").or_else(|| of(stored, "fixtureSetVersion")));
            command.insert("sourceContract".into(), Value::Object(contract));
        }
        "fixtures" => {
            let stored = record(get("fixtures"));
            let mut fixtures = Map::new();
            put(&mut fixtures, "fixtureRoot", sent(form, "fixtureRoot").or_else(|| of(stored, "fixtureRoot")));
            put(&mut fixtures, "coveredFlows", list(form, "coveredFlows", stored.and_then(|s| s.get("coveredFlows"))));
            fixtures.insert("liveProviderCallsAllowed".into(), false.into());
            command.insert("fixtures".into(), Value::Object(fixtures));
        }
        "source-observation" => {
            let observation = match record(contract.and_then(|c| c.get("sourceObservation"))) {
                Some(stored) => {
                    let mut observation = stored.clone();
                    for (field, name) in [
                        ("observationId", "observationIdPath"),
                        ("externalKey", "externalKeyPath"),
                        ("sourceUrl", "sourceUrlPath"),
                        ("sourceUpdatedAt", "sourceUpdatedAtPath"),
                    ] {
                        let value = with_path(stored.get(field), form, name);
                        observation.insert(field.into(), value);
                    }
                    Value::Object(observation)
                }
                None => Value::Null,
            };
            command.insert("sourceObservation".into(), observation);
        }
        "normalized-observation" => {
            let mut normalized = object(contract.and_then(|c| c.get("normalizedObservation")));
            let kind = sent(form, "normalizedOutputKind")
                .or_else(|| text(normalized.get("outputKind")))
                .or_else(|| get("mappingOutputKind").cloned());
            put(&mut normalized, "outputKind", kind);
            let language = with_path(normalized.get("languageCode"), form, "normalizedLanguagePath");
            normalized.insert("languageCode".into(), language);
            command.insert("normalizedObservationContract".into(), Value::Object(normalized));
        }
        "external-references" => {
            let mut contracts = records(contract.and_then(|c| c.get("externalReferences")));
            let mut first = contracts.first().cloned().unwrap_or_default();
            let provider = sent(form, "externalReferenceProviderKey")
                .or_else(|| text(first.get("providerKey")))
                .or_else(|| get("providerKey").cloned());
            put(&mut first, "providerKey", provider);
            let target = first_text([sent(form, "externalReferenceTarget"), text(first.get("target"))], "catalog-item-reference");
            first.insert("target".into(), target);
            let prefix = first_text([sent(form, "externalKeyPrefix"), text(first.get("externalKeyPrefix"))], "");
            first.insert("externalKeyPrefix".into(), prefix);
            if contracts.is_empty() {
                contracts.push(first)
            } else {
                contracts[0] = first
            }
            let rules = object(body.and_then(|b| b.get("externalReferenceExtractionRules")));
            command.insert("externalReferenceExtractionRules".into(), Value::Object(rules));
            command.insert("externalReferenceContracts".into(), contracts.into_iter().map(Value::Object).collect());
        }
        "selected-options" => {
            let mapping = match record(body.and_then(|b| b.get("selectedOptionMapping"))) {
                Some(stored) => {
                    let mut mapping = stored.clone();
                    let mut dimensions = records(stored.get("dimensions"));
                    if let Some(first) = dimensions.first_mut() {
                        let key = first_text([sent(form, "selectedOptionDimensionKey"), text(first.get("dimensionKey"))], "");
                        first.insert("dimensionKey".into(), key);
                    }
                    mapping.insert("dimensions".into(), dimensions.into_iter().map(Value::Object).collect());
                    Value::Object(mapping)
                }
                None => Value::Null,
            };
            command.insert("selectedOptionMapping".into(), mapping);
        }
        "reference-hierarchy" => {
            let mut contracts = records(contract.and_then(|c| c.get("referenceHierarchy")));
            if let Some(first) = contracts.first_mut() {
                let target = first_text([sent(form, "referenceHierarchyType"), text(first.get("targetTypeKey"))], "");
                first.insert("targetTypeKey".into(), target);
                let attribute =
                    first_text([sent(form, "referenceHierarchyProviderAttribute"), text(first.get("providerAttributeKey"))], "");
                first.insert("providerAttributeKey".into(), attribute);
            }
            let mapping = object(body.and_then(|b| b.get("referenceHierarchyMapping")));
            command.insert("referenceHierarchyMapping".into(), Value::Object(mapping));
            command.insert("referenceHierarchyContracts".into(), contracts.into_iter().map(Value::Object).collect());
        }
        "duplicate-prevention" => {
            let mut prevention = object(contract.and_then(|c| c.get("duplicatePrevention")));
            let exact = form.get("exactExternalCatalogItemReferencesFirst").is_some_and(|v| v == "on" || v == "true");
            prevention.insert("exactExternalCatalogItemReferencesFirst".into(), exact.into());
            let ambiguous = first_text(
                [sent(form, "ambiguousCandidatePolicy"), text(prevention.get("ambiguousCandidatePolicy"))],
                "review-only",
            );
            prevention.insert("ambiguousCandidatePolicy".into(), ambiguous);
            let replay = first_text([sent(form, "replayPolicy"), text(prevention.get("replayPolicy"))], "same-profile-version");
            prevention.insert("replayPolicy".into(), replay);
            command.insert(
                "duplicatePreventionMapping".into(),
                Value::Object(object(body.and_then(|b| b.get("duplicatePreventionMapping")))),
            );
            command.insert("ambiguityRules".into(), Value::Object(object(body.and_then(|b| b.get("ambiguityRules")))));
            command.insert("duplicatePreventionContract".into(), Value::Object(prevention));
        }
        "promotion-plan" => {
            let mut plan = object(contract.and_then(|c| c.get("promotionCommandPlan")));
            plan.insert("planKind".into(), first_text([sent(form, "promotionPlanKind"), None], "catalog-item-promotion"));
            plan.insert("requiresReview".into(), true.into());
            command.insert("promotionCommandPlan".into(), Value::Object(plan));
        }
        "retirement-plan" => {
            let tracking = number(form.get("retirementTrackingIssue").map(|v| Value::String(v.clone())).as_ref());
            let reason = sent(form, "retirementReason");
            let plan = if tracking.is_none() && reason.is_none() {
                Value::Null
            } else {
                let stored = record(get("retirementPlan"));
                let mut plan = stored.cloned().unwrap_or_default();
                let tracking =
                    tracking.or_else(|| number(stored.and_then(|s| s.get("trackingIssue")))).unwrap_or_else(|| json!(0));
                plan.insert("trackingIssue".into(), tracking);
                plan.insert("removeAfter".into(), "executable-mapping-contract-activated".into());
                let reason = first_text(
                    [reason, text(stored.and_then(|s| s.get("diagnosticText")))],
                    "Remove retired profile completely before launch.",
                );
                plan.insert("diagnosticText".into(), reason);
                Value::Object(plan)
            };
            command.insert("retirementPlan".into(), plan);
        }
        "migration-evidence" => {
            let stored = record(get("migrationEvidence"));
            let mut evidence = stored.cloned().unwrap_or_default();
            let kept = |key: &str| stored.and_then(|s| s.get(key)).filter(|v| !v.is_null());
            // Sent as typed, never admin-web's fixed sentence (chase-sets/chase-sets#11068).
            let typed = form.get("migrationEvidenceText").map(|v| Value::String(v.trim().to_owned()));
            evidence.insert("evidenceText".into(), typed.or_else(|| kept("evidenceText").cloned()).unwrap_or_else(|| "".into()));
            for (field, name) in [
                ("fixtureRunId", "migrationFixtureRunId"),
                ("mappingFingerprintBefore", "migrationFingerprintBefore"),
                ("mappingFingerprintAfter", "migrationFingerprintAfter"),
            ] {
                evidence.insert(field.into(), nullable(form, name, kept(field)));
            }
            let recorded = sent(form, "migrationRecordedAt").or_else(|| kept("recordedAt").cloned());
            evidence.insert("recordedAt".into(), recorded.unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into()));
            command.insert("migrationEvidence".into(), Value::Object(evidence));
        }
        _ => return None,
    }
    Some(Value::Object(command))
}

/// The version's authoring model (`CatalogProviderProfileAuthoringModel`): its `review` is the
/// profile the section command is merged over.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct AuthoringModel {
    review: Value,
}

pub(crate) async fn save(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<provider::url::Section<'_>>,
    Form(form): Form<Posted>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let version = form.get(PROFILE_VERSION).map_or("", |v| v.trim()).to_owned();
    let section = route.section.as_str();
    if version.is_empty() || !EDITABLE.contains(&section) {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let at = format!("/provider-profiles{}", under(&route.key, &[&version, "authoring"]));
    let model = match caller.read_at::<AuthoringModel>(Kind::SourceObservations, &at).await {
        Ok(model) => model,
        Err(error) => {
            return match refused(error) {
                Ok(errors) => again(&req, &staff, &config, &headers, &route.key, &context, errors).await,
                Err(denied) => denied.answer(&req),
            };
        }
    };
    let same = |key: &str, want: &str| model.review.get(key).and_then(Value::as_str) == Some(want);
    let built = (same("providerKey", &route.key) && same("profileVersion", &version))
        .then(|| section_command(&model.review, section, &form))
        .flatten();
    let Some(command_body) = built else {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    };
    let rest = format!("/provider-profiles{}", under(&route.key, &[&version, "sections", section]));
    let sent = command(&caller, Method::PATCH, Kind::SourceObservations, &rest, Some(&json!({ "command": command_body }))).await;
    let changes = [("profileVersion", Some(version.as_str()))];
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &changes, Done::SectionSaved).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn posted(pairs: &[(&str, &str)]) -> Posted {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn a_form_reads_as_its_posted_fields_by_name_with_a_blank_one_kept_blank() {
        let form: Posted = corten::form::from_bytes(b"profileVersion=2026.07.13&sourceCommit=&displayName=TCGdex").unwrap();
        assert_eq!(form, posted(&[("displayName", "TCGdex"), ("profileVersion", "2026.07.13"), ("sourceCommit", "")]));
    }

    #[test]
    fn basics_take_the_posted_fields_over_the_stored_ones_and_a_lifecycle_only_when_mutable() {
        let profile = json!({ "displayName": "Old", "status": "active", "capabilities": ["a"], "supportedScopes": ["s"], "languageOptions": ["en"] });
        let command = section_command(
            &profile,
            "basics",
            &posted(&[("displayName", " New "), ("lifecycle", "active"), ("capabilities", "x, y,")]),
        )
        .unwrap();
        assert_eq!(
            command,
            json!({ "section": "basics", "displayName": "New", "status": "active", "capabilities": ["x", "y"], "supportedScopes": ["s"], "languageOptions": ["en"] })
        );
        let command = section_command(&profile, "basics", &posted(&[("lifecycle", "draft"), ("status", "planned")])).unwrap();
        assert_eq!(command["lifecycle"], "draft");
        assert_eq!(command["status"], "planned");
        assert_eq!(command["displayName"], "Old");
    }

    #[test]
    fn source_contract_keeps_a_field_not_sent_and_clears_one_sent_blank() {
        let profile = json!({ "sourceContract": { "owner": "o", "repository": "r", "commit": "c", "documentPath": "d", "fixtureSetVersion": "v" } });
        let command = section_command(&profile, "source-contract", &posted(&[("sourceCommit", " ")])).unwrap();
        assert_eq!(
            command["sourceContract"],
            json!({ "owner": "o", "repository": "r", "commit": null, "documentPath": "d", "fixtureSetVersion": "v" })
        );
    }

    #[test]
    fn the_fixed_values_and_defaults_are_admin_webs() {
        let profile = json!({ "fixtures": { "fixtureRoot": "f", "coveredFlows": ["normal"], "liveProviderCallsAllowed": true } });
        let fixtures = section_command(&profile, "fixtures", &posted(&[])).unwrap();
        assert_eq!(
            fixtures["fixtures"],
            json!({ "fixtureRoot": "f", "coveredFlows": ["normal"], "liveProviderCallsAllowed": false })
        );
        let plan = section_command(&json!({}), "promotion-plan", &posted(&[])).unwrap();
        assert_eq!(plan["promotionCommandPlan"], json!({ "planKind": "catalog-item-promotion", "requiresReview": true }));
        let none =
            section_command(&json!({}), "retirement-plan", &posted(&[("retirementTrackingIssue", ""), ("retirementReason", "")]))
                .unwrap();
        assert_eq!(none["retirementPlan"], Value::Null);
        let retire = section_command(&json!({}), "retirement-plan", &posted(&[("retirementTrackingIssue", "42")])).unwrap();
        assert_eq!(
            retire["retirementPlan"],
            json!({ "trackingIssue": 42, "removeAfter": "executable-mapping-contract-activated", "diagnosticText": "Remove retired profile completely before launch." })
        );
        let prevention =
            section_command(&json!({}), "duplicate-prevention", &posted(&[("exactExternalCatalogItemReferencesFirst", "on")]))
                .unwrap();
        assert_eq!(
            prevention["duplicatePreventionContract"],
            json!({ "exactExternalCatalogItemReferencesFirst": true, "ambiguousCandidatePolicy": "review-only", "replayPolicy": "same-profile-version" })
        );
    }

    #[test]
    fn a_path_is_set_in_the_stored_expression_or_admin_webs_default_one() {
        let profile = json!({ "executableMappingContract": { "sourceObservation": {
            "observationId": { "owner": "x", "selector": { "kind": "path", "path": "old", "required": false } }
        } } });
        let command =
            section_command(&profile, "source-observation", &posted(&[("observationIdPath", "id"), ("externalKeyPath", "key")]))
                .unwrap();
        let observation = &command["sourceObservation"];
        assert_eq!(
            observation["observationId"],
            json!({ "owner": "x", "selector": { "kind": "path", "path": "id", "required": false } })
        );
        assert_eq!(
            observation["externalKey"],
            json!({ "owner": "catalog-truth", "uses": ["source-payload"], "redaction": "none",
                    "selector": { "kind": "path", "required": true, "nullPolicy": "diagnostic", "path": "key" } })
        );
        assert_eq!(section_command(&json!({}), "source-observation", &posted(&[])).unwrap()["sourceObservation"], Value::Null);
    }

    #[test]
    fn an_option_query_is_edited_at_its_index_and_the_rest_kept() {
        let profile = json!({ "profile": { "optionQueries": [{ "displayName": "A", "scope": "a" }, { "displayName": "B", "operation": "op" }] } });
        let command =
            section_command(&profile, "provider-options", &posted(&[("optionQueryIndex", "1"), ("optionQueryScope", "b")]))
                .unwrap();
        assert_eq!(
            command["optionQueries"],
            json!([{ "displayName": "A", "scope": "a" }, { "displayName": "B", "scope": "b", "operation": "op" }])
        );
    }

    #[test]
    fn migration_evidence_is_sent_as_typed_never_admin_webs_sentence() {
        let command = section_command(&json!({}), "migration-evidence", &posted(&[("migrationEvidenceText", "  ")])).unwrap();
        assert_eq!(command["migrationEvidence"]["evidenceText"], "");
        assert_eq!(command["migrationEvidence"]["fixtureRunId"], Value::Null);
        let stored = json!({ "migrationEvidence": { "evidenceText": "Replayed.", "recordedAt": "2026-11-01T00:00:00Z" } });
        let kept = section_command(&stored, "migration-evidence", &posted(&[])).unwrap();
        assert_eq!(kept["migrationEvidence"]["evidenceText"], "Replayed.");
        assert_eq!(kept["migrationEvidence"]["recordedAt"], "2026-11-01T00:00:00Z");
    }

    #[test]
    fn a_section_the_command_does_not_take_is_none() {
        assert_eq!(section_command(&json!({}), "operator-session", &posted(&[])), None);
        assert!(EDITABLE.iter().all(|s| section_command(&json!({}), s, &posted(&[])).is_some()));
    }
}
