//! Provider detail's profile section editing (admin-web's `ProfileSectionWorkspaces` and its
//! `provider-profile.edit-section` command): each of the selected version's registered sections, as
//! the Catalog API's composed surface describes it (`readModel.profileAuthoring.sectionWorkspaces`,
//! read with the provider's page), and its form, saved through the API's section edit.
//!
//! | Route | Answers |
//! |---|---|
//! | `POST /catalog/providers/{key}/sections/{section}?<context>` | saves one section of a profile version |
//!
//! The API decides whether a section may change and refuses what it will not take; the page draws the
//! refusal. Which fields a section has, their values, options and whether each may be edited come
//! from the read model, so the form is drawn from it rather than written here.
//!
//! Each form carries its section's revision as the page read it (`sectionFingerprint`), and the save
//! sends it as `If-Match`: the API refuses a save drawn from a revision another save has replaced,
//! and takes one after a change to another section.
//!
//! A save sends the fields the form posted, as typed (`{ "fields": { .. } }`). Catalog composes the
//! section over the stored version and applies its own defaults and fixed values, so the pilot keeps
//! no copy of them (chase-sets/chase-sets#11074).
use std::collections::BTreeMap;

use corten::{
    http::{HeaderMap, Uri},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{
    api::{Kind, under},
    command_at, daily,
    provider::{self, Done, again, answer},
};
use crate::{
    api::Method,
    app::Shared,
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
    /// The section's revision as the page read it, which its save is checked against.
    pub section_fingerprint: String,
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

/// The section's revision as the page read it; the other hidden field every section form carries.
pub const SECTION_FINGERPRINT: &str = "sectionFingerprint";

/// What a section form posted: each field it sent, by name. A field the form left out (disabled, or
/// a checkbox not checked) is missing, which keeps the stored value; one sent blank is blank.
pub type Posted = BTreeMap<String, String>;

/// The section edit a form makes: every field it posted but the two the pilot reads itself, the
/// version and the revision. Catalog composes the section over the stored version and applies its
/// own defaults and fixed values.
pub fn section_edit(form: &Posted) -> Value {
    let fields: Map<String, Value> = form
        .iter()
        .filter(|(key, _)| *key != PROFILE_VERSION && *key != SECTION_FINGERPRINT)
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    json!({ "fields": fields })
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
    let rest = format!("/provider-profiles{}", under(&route.key, &[&version, "sections", section]));
    let revision = form.get(SECTION_FINGERPRINT).map_or("", |v| v.trim());
    let sent = command_at(&caller, Method::PATCH, Kind::SourceObservations, &rest, &section_edit(&form), revision).await;
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
    fn the_edit_is_the_posted_fields_as_typed_without_the_version_and_revision() {
        let form = posted(&[
            ("profileVersion", "2026.07.13"),
            ("sectionFingerprint", "sha256:basics-read"),
            ("displayName", " New "),
            ("sourceCommit", ""),
        ]);
        assert_eq!(section_edit(&form), json!({ "fields": { "displayName": " New ", "sourceCommit": "" } }));
        assert_eq!(section_edit(&posted(&[("profileVersion", "2026.07.13")])), json!({ "fields": {} }));
    }
}
