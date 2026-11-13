//! The daily workbench's import context (admin-web's `CatalogImportContextBar`): the provider,
//! the unit, the source scope and the profile version the workbench works in, and the provider's
//! synced source options with their reload and refresh. The surface read carries the providers
//! and units (`providerScope`) and the source options' skeleton (`sourceOptions`); the page reads
//! the populated options (`GET .../workbench-surfaces/daily/source-options?location=`) beside the
//! surface, and draws the skeleton when that read fails, as admin-web's panel does.
//!
//! Both reads carry the scope controls the Catalog API works out from the location: a select for
//! each option kind a route field takes, its options narrowed to the chosen parent, what is chosen
//! (`guidedFields`), whether the free-text import scope applies instead (`freeTextApplicable`),
//! and the collapsed bar's one line (`contextSummary`). The pilot draws them as they come.
use corten::prelude::*;
use serde::{Deserialize, Serialize};

/// `CatalogPrimaryWorkbenchScopeContext`: the structured scope the API parsed from the location.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeContext {
    pub product_id: Option<String>,
    pub language_code: Option<String>,
    pub product_line_id: Option<String>,
    pub product_line_name: Option<String>,
    pub series_id: Option<String>,
    pub series_name: Option<String>,
    pub expansion_id: Option<String>,
    pub expansion_name: Option<String>,
}

/// `CatalogPrimaryWorkbenchProviderScopeReadModel`: the providers and their units.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct ProviderScope {
    pub providers: Vec<ScopeProvider>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeProvider {
    pub provider_key: String,
    pub display_name: String,
    pub units: Vec<ScopeUnit>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeUnit {
    pub unit_key: String,
    pub product_domain: String,
    pub product_form: String,
    pub active_profile: Option<ProfilePointer>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfilePointer {
    pub profile_version: String,
}

/// `CatalogPrimaryWorkbenchSourceOptionsReadModel`, the parts the bar draws.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceOptions {
    pub status: String,
    /// A select for each option kind a route field takes, as the Catalog API works it out.
    pub guided_fields: Vec<GuidedField>,
    /// Whether the provider declares no option kind, so the scope is the free-text import scope.
    pub free_text_applicable: bool,
    /// The collapsed bar's one line, provider · unit · scope · profile, or none until a scope is chosen.
    pub context_summary: Option<String>,
    pub summary: OptionsSummary,
    pub option_kinds: Vec<OptionKind>,
    pub pages: Vec<OptionPage>,
    pub refresh: OptionsRefresh,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionsSummary {
    pub declared_kinds: u64,
    pub loaded_pages: u64,
    pub available_options: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionsRefresh {
    pub state: String,
    pub refresh_all_href: Option<String>,
}

impl OptionsRefresh {
    /// Whether Refresh all is offered (admin-web's `canRefreshAll`).
    pub fn all(&self) -> bool {
        self.refresh_all_href.is_some() && matches!(self.state.as_str(), "available" | "degraded")
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionKind {
    pub query_kind: String,
    pub scope: String,
    pub parent_scope: Option<String>,
    pub parent: OptionParent,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionParent {
    pub scope: Option<String>,
    pub diagnostic_text: Option<String>,
    pub selected_value: Option<String>,
    pub missing: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionPage {
    pub query_kind: String,
    pub display_name: String,
    pub scope: String,
    pub state: String,
    pub action_state: String,
    pub degraded: bool,
    pub request: OptionRequest,
    pub page: OptionCount,
    pub cache: OptionCache,
    pub items: Vec<OptionItem>,
    pub refresh_href: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionRequest {
    pub provider_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct OptionCount {
    pub count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct OptionCache {
    pub diagnostics: Vec<OptionDiagnostic>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct OptionDiagnostic {
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub parent_value: Option<String>,
}

/// Every route field the scope controls write, cleared when the provider or the unit changes.
pub const SCOPE_FIELDS: [&str; 8] =
    ["productId", "languageCode", "productLineId", "productLineName", "seriesId", "seriesName", "expansionId", "expansionName"];

/// `CatalogPrimaryWorkbenchGuidedScopeField`: one guided scope select, the route field it sets and
/// the one its name goes in, its options and what is chosen.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct GuidedField {
    pub query_kind: String,
    pub label: String,
    pub field_name: String,
    pub label_field_name: Option<String>,
    pub options: Vec<ScopeOption>,
    pub selected_value: String,
    pub selected_label: String,
    pub parent_missing: bool,
    pub parent_diagnostic: Option<String>,
}

/// One option of a guided scope select, with the parent value it sits under.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub parent_value: Option<String>,
}
