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
    /// The design system's icon name (`IconName`).
    #[serde(default)]
    pub icon: Option<String>,
    /// `utility`: an entry at the bar's end (sign-in, the cart), not a section of the site.
    #[serde(default)]
    pub placement: Option<String>,
    /// Which entries a bar with room for few keeps: the highest first.
    #[serde(default)]
    packing_priority: i32,
    #[serde(default)]
    badge: Option<Badge>,
    #[serde(default)]
    pub children: Vec<NavItem>,
}

/// A count drawn on an entry (`BcShellContributionBadge`): the value it reads, the most it writes
/// before "max+", and whether a visitor sees the entry while the count is 0.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Badge {
    value_key: String,
    max: u64,
    hide_when_empty_for_signed_out: bool,
}

/// Whom the nav is for.
pub trait Reader {
    fn can(&self, permission: &str) -> bool;
    fn role_key(&self) -> &str;
}

/// The counts the entries' badges read, by value key (`dynamicValues`): `("checkout.cart-count", 2)`.
pub type Values<'a> = &'a [(&'a str, u64)];

impl NavItem {
    /// `isVisibleForActor` and the role exclusions, for a signed-in reader; a group shows when a
    /// child does.
    pub fn visible(&self, reader: &impl Reader) -> bool {
        self.shown(Some(reader), &[])
    }

    /// `filterShellContributionTree`: for `reader`, or a visitor (`None`), with the badges' counts.
    /// A visitor does not see an entry whose badge is empty when it says so (the cart with nothing
    /// in it).
    pub fn shown<R: Reader>(&self, reader: Option<&R>, values: Values) -> bool {
        let audience = match self.visibility.as_str() {
            "signed-in" => reader.is_some(),
            "signed-out" => reader.is_none(),
            _ => true,
        };
        let can = |p: &String| reader.is_some_and(|r| r.can(p));
        let permitted = self.required_permissions.is_empty()
            || match self.required_permissions_match.as_str() {
                "any" => self.required_permissions.iter().any(can),
                _ => self.required_permissions.iter().all(can),
            };
        let excluded = reader.is_some_and(|r| self.excluded_role_keys.iter().any(|k| k == r.role_key()));
        let hidden_empty =
            reader.is_none() && self.badge.as_ref().is_some_and(|b| b.hide_when_empty_for_signed_out) && self.count(values) == 0;
        audience
            && permitted
            && !excluded
            && !hidden_empty
            && (self.children.is_empty() || self.children.iter().any(|c| c.shown(reader, values)))
    }

    fn count(&self, values: Values) -> u64 {
        let Some(badge) = &self.badge else { return 0 };
        values.iter().find(|(key, _)| *key == badge.value_key).map_or(0, |(_, count)| *count)
    }

    /// The badge's text (`toNavigationItem`): the count, "max+" over its most, none for 0.
    pub fn badge(&self, values: Values) -> Option<String> {
        let max = self.badge.as_ref()?.max;
        match self.count(values) {
            0 => None,
            count if count > max => Some(format!("{max}+")),
            count => Some(count.to_string()),
        }
    }

    /// The badge's value key, for a page that fills the count in later.
    pub fn badge_key(&self) -> Option<&str> {
        self.badge.as_ref().map(|b| b.value_key.as_str())
    }

    /// The most the badge writes before "max+".
    pub fn badge_max(&self) -> Option<u64> {
        self.badge.as_ref().map(|b| b.max)
    }

    /// A visitor does not see the entry while its badge is 0.
    pub fn hides_when_empty(&self) -> bool {
        self.badge.as_ref().is_some_and(|b| b.hide_when_empty_for_signed_out)
    }
}

/// An entry and its visible children.
pub type Shown<'a> = (&'a NavItem, Vec<&'a NavItem>);

/// The entries the reader may see, by order then label, each with its visible children.
pub fn visible<'a>(items: impl IntoIterator<Item = &'a NavItem>, reader: &impl Reader) -> Vec<Shown<'a>> {
    shown(items, Some(reader), &[])
}

/// The same for a reader or a visitor, with the badges' counts.
pub fn shown<'a, R: Reader>(items: impl IntoIterator<Item = &'a NavItem>, reader: Option<&R>, values: Values) -> Vec<Shown<'a>> {
    let by_order = |a: &&NavItem, b: &&NavItem| a.order.cmp(&b.order).then_with(|| a.label.cmp(&b.label));
    let mut shown: Vec<&NavItem> = items.into_iter().filter(|i| i.shown(reader, values)).collect();
    shown.sort_by(by_order);
    shown
        .into_iter()
        .map(|item| {
            let mut children: Vec<&NavItem> = item.children.iter().filter(|c| c.shown(reader, values)).collect();
            children.sort_by(by_order);
            (item, children)
        })
        .collect()
}

/// A bar with room for `limit` entries (`renderShellTree` with a limit): the visible entries with
/// the highest packing priority, drawn by order then key, each group's children the same way.
pub fn packed<'a, R: Reader>(
    items: impl IntoIterator<Item = &'a NavItem>,
    reader: Option<&R>,
    values: Values,
    limit: usize,
) -> Vec<Shown<'a>> {
    let by_order = |a: &&NavItem, b: &&NavItem| a.order.cmp(&b.order).then_with(|| a.key.cmp(&b.key));
    let mut shown: Vec<&NavItem> = items.into_iter().filter(|i| i.shown(reader, values)).collect();
    shown.sort_by(|a, b| b.packing_priority.cmp(&a.packing_priority).then_with(|| by_order(a, b)));
    shown.truncate(limit);
    shown.sort_by(by_order);
    shown
        .into_iter()
        .map(|item| {
            let mut children: Vec<&NavItem> = item.children.iter().filter(|c| c.shown(reader, values)).collect();
            children.sort_by(by_order);
            (item, children)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Who(&'static [&'static str], &'static str);

    impl Reader for Who {
        fn can(&self, permission: &str) -> bool {
            self.0.contains(&permission)
        }
        fn role_key(&self) -> &str {
            self.1
        }
    }

    fn items(json: &str) -> Vec<NavItem> {
        serde_json::from_str(json).unwrap()
    }

    const BAR: &str = r#"[
        {"key":"search","label":"Browse","href":"/search","order":10,"visibility":"always","requiredPermissions":[],"requiredPermissionsMatch":"all","excludedRoleKeys":[],"packingPriority":700},
        {"key":"cart","label":"Buy Cart","href":"/account/cart","order":50,"visibility":"always","requiredPermissions":[],"requiredPermissionsMatch":"all","excludedRoleKeys":[],"packingPriority":650,
         "badge":{"valueKey":"checkout.cart-count","max":99,"hideWhenEmptyForSignedOut":true}},
        {"key":"sign-in","label":"Sign In","href":"/sign-in","order":20,"visibility":"signed-out","requiredPermissions":[],"requiredPermissionsMatch":"all","excludedRoleKeys":[],"packingPriority":350},
        {"key":"alerts","label":"Alerts","href":"/account/notifications","order":90,"visibility":"signed-in","requiredPermissions":["accounts.view"],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"],"packingPriority":600},
        {"key":"sell","label":"Sell","order":170,"visibility":"signed-in","requiredPermissions":[],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"],"packingPriority":550,"children":[
            {"key":"sales","label":"Sales","href":"/account/sales","order":190,"visibility":"signed-in","requiredPermissions":["orders.view","listings.view"],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"]}
        ]},
        {"key":"purchases","label":"Purchases","href":"/account/purchases","order":80,"visibility":"signed-in","requiredPermissions":["orders.view"],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"],"packingPriority":400},
        {"key":"account","label":"Account","order":200,"visibility":"signed-in","requiredPermissions":["accounts.view"],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"],"packingPriority":450,"children":[
            {"key":"me","label":"Account","href":"/account","order":200,"visibility":"signed-in","requiredPermissions":["accounts.view"],"requiredPermissionsMatch":"all","excludedRoleKeys":["guest-buyer"]}
        ]}
    ]"#;

    fn keys(shown: &[Shown]) -> Vec<String> {
        shown.iter().map(|(i, _)| i.key.clone()).collect()
    }

    #[test]
    fn a_visitor_sees_the_cart_only_with_something_in_it() {
        let bar = items(BAR);
        assert_eq!(keys(&packed(&bar, None::<&Who>, &[], 5)), ["search", "sign-in"]);
        let values = [("checkout.cart-count", 2)];
        assert_eq!(keys(&packed(&bar, None::<&Who>, &values, 5)), ["search", "sign-in", "cart"]);
    }

    #[test]
    fn a_full_bar_keeps_the_highest_priorities_drawn_in_order() {
        let bar = items(BAR);
        let seller = Who(&["accounts.view", "orders.view", "listings.view"], "seller");
        // Seven visible; purchases (400) is the one left out, the rest drawn by order.
        assert_eq!(keys(&packed(&bar, Some(&seller), &[], 5)), ["search", "cart", "alerts", "sell", "account"]);
        // A buyer cannot see Sales, so Sell has nothing in it and Purchases comes back.
        let buyer = Who(&["accounts.view", "orders.view"], "buyer");
        assert_eq!(keys(&packed(&bar, Some(&buyer), &[], 5)), ["search", "cart", "purchases", "alerts", "account"]);
        // A guest checkout sees the cart even when it is empty, and nothing kept for accounts.
        let guest = Who(&["orders.view", "accounts.view"], "guest-buyer");
        assert_eq!(keys(&packed(&bar, Some(&guest), &[], 5)), ["search", "cart"]);
    }

    #[test]
    fn a_badge_is_the_count_or_its_most_and_a_plus() {
        let bar = items(BAR);
        let cart = &bar[1];
        assert_eq!(cart.badge(&[]), None);
        assert_eq!(cart.badge(&[("checkout.cart-count", 7)]).as_deref(), Some("7"));
        assert_eq!(cart.badge(&[("checkout.cart-count", 100)]).as_deref(), Some("99+"));
        assert_eq!(cart.badge_key(), Some("checkout.cart-count"));
    }
}
