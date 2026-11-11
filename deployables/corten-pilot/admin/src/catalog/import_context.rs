//! The daily workbench's import context (admin-web's \`CatalogImportContextBar\`): the provider,
//! the unit, the source scope and the profile version the workbench works in, and the provider's
//! synced source options with their reload and refresh. The surface read carries the providers
//! and units (\`providerScope\`) and the source options' skeleton (\`sourceOptions\`); the page reads
//! the populated options (\`GET .../workbench-surfaces/daily/source-options?location=\`) beside the
//! surface, and draws the skeleton when that read fails, as admin-web's panel does.
//!
//! Workaround (chase-sets/chase-sets#11080): the reads return the option pages, not the scope
//! controls, so \`guided_fields\` and \`summary\` copy admin-web's rules for them
//! (\`guidedSourceScopeFields\`, \`importContextSummary\`): which route field each option scope
//! drives, a child's options narrowed to the selected parent, and what is selected. The selection
//! is the API's \`routeContext.scope\` and its options' \`parent.selectedValue\`; the pilot does not
//! parse \`importScope\` as admin-web does, so a location named only by \`importScope\` leaves its
//! leaf unchosen, with the import scope in the summary. Remove them when the reads return the fields.
use corten::prelude::*;
use serde::{Deserialize, Serialize};

/// \`CatalogPrimaryWorkbenchScopeContext\`: the structured scope the API parsed from the location.
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

impl ScopeContext {
    /// The value of the route field \`name\` (\`languageCode\`, \`seriesName\` and the rest).
    pub fn field(&self, name: &str) -> Option<&str> {
        let value = match name {
            "productId" => &self.product_id,
            "languageCode" => &self.language_code,
            "productLineId" => &self.product_line_id,
            "productLineName" => &self.product_line_name,
            "seriesId" => &self.series_id,
            "seriesName" => &self.series_name,
            "expansionId" => &self.expansion_id,
            "expansionName" => &self.expansion_name,
            _ => &None,
        };
        value.as_deref().map(str::trim).filter(|v| !v.is_empty())
    }
}

/// \`CatalogPrimaryWorkbenchProviderScopeReadModel\`: the providers and their units.
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

/// \`CatalogPrimaryWorkbenchSourceOptionsReadModel\`, the parts the bar draws.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceOptions {
    pub status: String,
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
    /// Whether Refresh all is offered (admin-web's \`canRefreshAll\`).
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

/// The route fields a provider option scope drives, and the field its label goes in
/// (admin-web's \`scopeQueryFieldsByProviderScope\`).
pub fn scope_field(scope: &str) -> Option<(&'static str, Option<&'static str>)> {
    match scope {
        "product" => Some(("productId", None)),
        "language" => Some(("languageCode", None)),
        "product-line/category" => Some(("productLineId", Some("productLineName"))),
        "series" => Some(("seriesId", Some("seriesName"))),
        "expansion" | "set-name" => Some(("expansionId", Some("expansionName"))),
        _ => None,
    }
}

/// Every route field the scope controls write, cleared when the provider or the unit changes.
pub const SCOPE_FIELDS: [&str; 8] =
    ["productId", "languageCode", "productLineId", "productLineName", "seriesId", "seriesName", "expansionId", "expansionName"];

/// One option of a scope select.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub parent: Option<String>,
}

/// One guided scope select (\`CatalogPrimaryWorkbenchGuidedScopeField\`).
#[derive(Clone, Debug)]
pub struct GuidedField<'a> {
    pub query_kind: &'a str,
    pub label: &'a str,
    pub field: &'static str,
    pub label_field: Option<&'static str>,
    pub options: Vec<ScopeOption>,
    pub selected: String,
    pub selected_label: String,
    pub parent_missing: bool,
    pub parent_diagnostic: Option<String>,
}

/// Two option values compared as admin-web compares them: TCGdex's case-insensitively.
fn same_value(a: &str, b: &str, provider: &str) -> bool {
    if provider == "tcgdex" { a.trim().eq_ignore_ascii_case(b.trim()) } else { a.trim() == b.trim() }
}

/// What each option scope has selected: the route's scope, then a parent the API reports as
/// selected when a descendant is chosen or the location names its scope only by \`importScope\`.
fn selections(scope: &ScopeContext, options: &SourceOptions, import_scope: bool) -> Vec<(String, String, String)> {
    let mut chosen: Vec<(String, String, String)> = Vec::new();
    for name in ["product", "language", "product-line/category", "series", "expansion", "set-name"] {
        let Some((field, label_field)) = scope_field(name) else { continue };
        let label = label_field.and_then(|f| scope.field(f)).unwrap_or("");
        if let Some(value) = scope.field(field).or((!label.is_empty()).then_some(label)) {
            chosen.push((name.to_owned(), value.to_owned(), label.to_owned()));
        }
    }
    let explicit: Vec<String> = chosen.iter().map(|(s, ..)| s.clone()).collect();
    let parent_of = |scope: &str| options.option_kinds.iter().find(|k| k.scope == scope).and_then(|k| k.parent_scope.clone());
    let below = |ancestor: &str| {
        explicit.iter().any(|scope| {
            let mut current = parent_of(scope);
            while let Some(parent) = current {
                if parent == ancestor {
                    return true;
                }
                current = parent_of(&parent);
            }
            false
        })
    };
    for kind in &options.option_kinds {
        let (Some(parent), Some(value)) = (&kind.parent.scope, &kind.parent.selected_value) else { continue };
        if chosen.iter().any(|(s, ..)| s == parent) || value.is_empty() {
            continue;
        }
        if below(parent) || (explicit.is_empty() && import_scope) {
            chosen.push((parent.clone(), value.clone(), String::new()));
        }
    }
    chosen
}

/// The guided scope selects for the provider's option pages (admin-web's \`guidedSourceScopeFields\`).
pub fn guided_fields<'a>(scope: &ScopeContext, import_scope: bool, options: &'a SourceOptions) -> Vec<GuidedField<'a>> {
    let chosen = selections(scope, options, import_scope);
    let selected = |scope: &str| chosen.iter().find(|(s, ..)| s == scope).map(|(_, v, l)| (v.as_str(), l.as_str()));
    options
        .pages
        .iter()
        .filter_map(|page| {
            let (field, label_field) = scope_field(&page.scope)?;
            let kind = options.option_kinds.iter().find(|k| k.query_kind == page.query_kind);
            let parent = kind.map(|k| &k.parent);
            let parent_missing = parent.map_or(page.state == "not-requested", |p| p.missing);
            let (value, label) = selected(&page.scope).unwrap_or(("", ""));
            let parent_value = parent.and_then(|p| p.scope.as_deref()).and_then(selected).map(|(v, _)| v);
            let provider = page.request.provider_key.as_str();
            let mut list: Vec<ScopeOption> = page
                .items
                .iter()
                .filter(|item| match (item.parent_value.as_deref(), parent_value) {
                    (Some(item_parent), Some(chosen)) => same_value(item_parent, chosen, provider),
                    _ => true,
                })
                .map(|item| ScopeOption {
                    value: item.value.clone(),
                    label: item.label.clone(),
                    description: item.description.clone(),
                    parent: item.parent_value.clone(),
                })
                .collect();
            let selected_label = if field == "expansionId" && value != label {
                page.items.iter().find(|i| i.value == value).map(|i| i.label.clone())
            } else {
                None
            }
            .filter(|l| !l.is_empty())
            .or_else(|| (!label.is_empty()).then(|| label.to_owned()))
            .or_else(|| list.iter().find(|o| o.value == value).map(|o| o.label.to_owned()))
            .unwrap_or_else(|| value.to_owned());
            let selected_value = value.to_owned();
            if !value.is_empty() && !list.iter().any(|o| o.value == value) {
                // A selected value the page does not list stays chosen, labelled by its value.
                let shown = ScopeOption { value: value.to_owned(), label: value.to_owned(), description: None, parent: None };
                list.insert(0, shown);
            }
            let diagnostic = parent_missing
                .then(|| {
                    parent
                        .and_then(|p| p.diagnostic_text.clone())
                        .or_else(|| page.cache.diagnostics.first().map(|d| d.message.clone()))
                })
                .flatten();
            Some(GuidedField {
                query_kind: &page.query_kind,
                label: &page.display_name,
                field,
                label_field,
                options: list,
                selected: selected_value,
                selected_label,
                parent_missing,
                parent_diagnostic: diagnostic,
            })
        })
        .collect()
}

/// The collapsed bar's one line, provider · unit · scope · profile (admin-web's
/// \`importContextSummary\`), or none until a scope is chosen.
pub fn summary(
    provider: Option<&str>,
    unit: Option<&str>,
    scope: &ScopeContext,
    import_scope: Option<&str>,
    profile: Option<String>,
) -> Option<String> {
    let levels: Vec<&str> = [
        scope.field("languageCode"),
        scope.field("productLineId"),
        scope.field("seriesId"),
        scope.field("expansionId").or(scope.field("expansionName")),
        scope.field("productId"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let scope_label =
        if levels.is_empty() { import_scope.map(str::trim).filter(|s| !s.is_empty())?.to_owned() } else { levels.join("/") };
    let parts: Vec<String> = [provider.map(str::to_owned), unit.map(str::to_owned), Some(scope_label), profile]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    Some(parts.join(" \u{b7} "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn options(value: serde_json::Value) -> SourceOptions {
        serde_json::from_value(value).unwrap()
    }

    fn tcgdex() -> SourceOptions {
        options(json!({
            "optionKinds": [
                { "queryKind": "languages", "scope": "language", "parentScope": null, "parent": { "scope": null } },
                { "queryKind": "series", "scope": "series", "parentScope": "language",
                  "parent": { "scope": "language", "selectedValue": "en" } },
                { "queryKind": "expansions", "scope": "expansion", "parentScope": "series",
                  "parent": { "scope": "series", "selectedValue": "base" } },
                { "queryKind": "rarities", "scope": "rarity", "parentScope": null, "parent": { "scope": null } }
            ],
            "pages": [
                { "queryKind": "languages", "displayName": "Language", "scope": "language", "request": { "providerKey": "tcgdex" },
                  "items": [{ "value": "en", "label": "English" }, { "value": "fr", "label": "French" }] },
                { "queryKind": "series", "displayName": "Series", "scope": "series", "request": { "providerKey": "tcgdex" },
                  "items": [{ "value": "base", "label": "Base", "parentValue": "EN" }, { "value": "neo", "label": "Neo", "parentValue": "fr" }] },
                { "queryKind": "expansions", "displayName": "Expansion", "scope": "expansion", "request": { "providerKey": "tcgdex" },
                  "items": [{ "value": "base1", "label": "Base Set", "parentValue": "base" }, { "value": "base2", "label": "Jungle", "parentValue": "base" },
                            { "value": "neo1", "label": "Neo Genesis", "parentValue": "neo" }] },
                { "queryKind": "rarities", "displayName": "Rarity", "scope": "rarity", "request": { "providerKey": "tcgdex" }, "items": [] }
            ]
        }))
    }

    #[test]
    fn each_mapped_scope_is_a_select_narrowed_to_its_parent_and_an_unmapped_one_is_left_out() {
        let options = tcgdex();
        let scope = ScopeContext { language_code: Some("en".into()), series_id: Some("base".into()), ..Default::default() };
        let fields = guided_fields(&scope, false, &options);
        let names: Vec<_> = fields.iter().map(|f| (f.field, f.label_field)).collect();
        assert_eq!(names, [("languageCode", None), ("seriesId", Some("seriesName")), ("expansionId", Some("expansionName"))]);
        // TCGdex compares a parent's value without case.
        assert_eq!(fields[1].options.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(), ["base"]);
        assert_eq!(fields[2].options.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(), ["base1", "base2"]);
        assert_eq!((fields[0].selected.as_str(), fields[1].selected.as_str(), fields[2].selected.as_str()), ("en", "base", ""));
        assert_eq!(fields[1].selected_label, "Base");
    }

    #[test]
    fn a_parent_the_api_reports_is_chosen_only_under_a_chosen_descendant_or_an_import_scope() {
        let options = tcgdex();
        let leaf = ScopeContext { expansion_id: Some("base2".into()), ..Default::default() };
        let fields = guided_fields(&leaf, false, &options);
        assert_eq!(fields[1].selected, "base", "the series above the chosen expansion");
        assert_eq!(fields[2].selected_label, "Jungle");
        let none = guided_fields(&ScopeContext::default(), false, &options);
        assert!(none.iter().all(|f| f.selected.is_empty()));
        let named = guided_fields(&ScopeContext::default(), true, &options);
        assert_eq!((named[0].selected.as_str(), named[1].selected.as_str()), ("en", "base"));
    }

    #[test]
    fn a_chosen_value_the_page_does_not_list_stays_chosen_and_a_missing_parent_says_why() {
        let mut options = tcgdex();
        options.option_kinds[2].parent.missing = true;
        options.option_kinds[2].parent.diagnostic_text = Some("Select a series first.".into());
        let scope = ScopeContext { series_id: Some("gone".into()), ..Default::default() };
        let fields = guided_fields(&scope, false, &options);
        assert_eq!(
            fields[1].options[0],
            ScopeOption { value: "gone".into(), label: "gone".into(), description: None, parent: None }
        );
        assert!(fields[2].parent_missing);
        assert_eq!(fields[2].parent_diagnostic.as_deref(), Some("Select a series first."));
    }

    #[test]
    fn the_summary_joins_the_levels_or_the_import_scope_and_is_none_without_a_scope() {
        let scope =
            ScopeContext { language_code: Some("en".into()), expansion_name: Some("Jungle".into()), ..Default::default() };
        assert_eq!(
            summary(Some("tcgdex"), Some("u"), &scope, None, Some("profile 1".into())).as_deref(),
            Some("tcgdex \u{b7} u \u{b7} en/Jungle \u{b7} profile 1")
        );
        assert_eq!(
            summary(Some("tcgdex"), None, &ScopeContext::default(), Some("en:base:base2"), None).as_deref(),
            Some("tcgdex \u{b7} en:base:base2")
        );
        assert_eq!(summary(Some("tcgdex"), Some("u"), &ScopeContext::default(), None, None), None);
    }
}
