//! The hosts' navigation: the shell contributions in every bounded context's `context.json`
//! (exported to each app's `nav.json` by scripts/export.mjs), filtered by the rules of
//! `resolveWebHostNavItems` (infrastructure/platform-runtime).
use serde::Deserialize;

/// One nav entry and the entries grouped under it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavItem {
    pub key: String,
    #[serde(default)]
    pub section: String,
    pub label: String,
    pub href: Option<String>,
    pub order: i32,
    visibility: String,
    required_permissions: Vec<String>,
    required_permissions_match: String,
    excluded_role_keys: Vec<String>,
    #[serde(default)]
    pub children: Vec<NavItem>,
}

/// Whom the nav is for.
pub trait Reader {
    fn can(&self, permission: &str) -> bool;
    fn role_key(&self) -> &str;
}

impl NavItem {
    /// `isVisibleForActor` and the role exclusions, for a signed-in reader; a group shows when a
    /// child does.
    pub fn visible(&self, reader: &impl Reader) -> bool {
        let signed_in = self.visibility != "signed-out";
        let permitted = match self.required_permissions_match.as_str() {
            "any" => self.required_permissions.is_empty() || self.required_permissions.iter().any(|p| reader.can(p)),
            _ => self.required_permissions.iter().all(|p| reader.can(p)),
        };
        let excluded = self.excluded_role_keys.iter().any(|r| r == reader.role_key());
        signed_in && permitted && !excluded && (self.children.is_empty() || self.children.iter().any(|c| c.visible(reader)))
    }
}

/// The entries the reader may see, by order then label, each with its visible children.
pub fn visible<'a>(items: impl IntoIterator<Item = &'a NavItem>, reader: &impl Reader) -> Vec<(&'a NavItem, Vec<&'a NavItem>)> {
    let by_order = |a: &&NavItem, b: &&NavItem| a.order.cmp(&b.order).then_with(|| a.label.cmp(&b.label));
    let mut shown: Vec<&NavItem> = items.into_iter().filter(|i| i.visible(reader)).collect();
    shown.sort_by(by_order);
    shown
        .into_iter()
        .map(|item| {
            let mut children: Vec<&NavItem> = item.children.iter().filter(|c| c.visible(reader)).collect();
            children.sort_by(by_order);
            (item, children)
        })
        .collect()
}
