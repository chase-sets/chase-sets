use corten::prelude::*;

use super::marketplace;
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    text::Pilot,
};

/// The nav entries the pilot serves, by the exact path marketplace's nav names. Not `Req::serves`:
/// the pilot routes `/account/sales/shipments` only to send it on to marketplace's command center
/// (chase-sets/chase-sets#10638), and a nav entry should not take that extra hop.
const OWN: &[&str] = &[
    <url::Locations as Route>::PATH,
    <url::Restock as Route>::PATH,
    <url::Inventory as Route>::PATH,
    <url::Imports as Route>::PATH,
    <url::Desk as Route>::PATH,
    <url::Money as Route>::PATH,
    <url::Search as Route>::PATH,
    <url::Purchases as Route>::PATH,
    <url::Sales as Route>::PATH,
    <url::Notifications as Route>::PATH,
    <url::Sessions as Route>::PATH,
    <url::SellerListings as Route>::PATH,
    <url::OfferMatches as Route>::PATH,
    <url::Cart as Route>::PATH,
    <url::SellList as Route>::PATH,
    <url::DeskOffers as Route>::PATH,
    <url::Recommendations as Route>::PATH,
];

/// Where a nav entry goes: the pilot's own page, or marketplace's.
fn link(item: &NavItem) -> Option<String> {
    let href = item.href.as_deref()?;
    if OWN.contains(&href) {
        return Some(href.to_owned());
    }
    marketplace(href).map(|uri| uri.to_string())
}

/// The entry `resolveMarketplaceActiveKey` marks: the deepest entry whose path holds this one.
fn active<'a>(items: &[(&'a NavItem, Vec<&'a NavItem>)], path: &str) -> Option<&'a str> {
    let holds = |href: &str| path == href || path.starts_with(&format!("{}/", href.trim_end_matches('/')));
    items
        .iter()
        .flat_map(|(item, children)| std::iter::once(*item).chain(children.iter().copied()))
        .filter(|item| item.children.is_empty())
        .filter_map(|item| Some((item, item.href.as_deref()?)))
        .filter(|(_, href)| holds(href))
        .max_by_key(|(_, href)| href.split('/').filter(|s| !s.is_empty()).count())
        .map(|(item, _)| item.key.as_str())
}

/// marketplace's top bar: the entries the seller can open, groups as menus. An entry the pilot
/// serves (`OWN`) links to the pilot; every other one to marketplace. A guest checkout's bar ends with Exit
/// guest checkout, as marketplace's does. (Not ported: the bottom bar, the account menu and the
/// cart count.)
#[component(css)]
pub fn MarketNav<'a>(p: Pilot, viewer: &'a Viewer, path: &'a str) -> impl Render {
    let items = auth::top_nav(viewer);
    let current = active(&items, path);
    let is = move |item: &NavItem| (current == Some(item.key.as_str())).then_some("page");
    html! {
        <header class={Bar}>
            <a class={Brand} href={marketplace("/").map(|u| u.to_string()).unwrap_or_default()}>{p.shell_marketplace()}</a>
            <span class={Tag}>{p.shell_pilot()}</span>
            <nav aria-label={p.shell_navigation()} data-nav-rule="deepest">
                <ul class={Items}>
                    for (item, children) in &items {
                        <li>
                            if children.is_empty() {
                                if let Some(href) = link(item) {
                                    <a class={Item} href={&href} aria-current={is(item)} data-nav-path={item.href.as_deref()}>
                                        {&item.label}
                                    </a>
                                }
                            } else {
                                <details>
                                    <summary class={Item}>{&item.label}</summary>
                                    <ul class={Menu}>
                                        for child in children {
                                            if let Some(href) = link(child) {
                                                <li>
                                                    <a
                                                        class={Item}
                                                        href={&href}
                                                        aria-current={is(child)}
                                                        data-nav-path={child.href.as_deref()}
                                                    >
                                                        {&child.label}
                                                    </a>
                                                </li>
                                            }
                                        }
                                    </ul>
                                </details>
                            }
                        </li>
                    }
                </ul>
            </nav>
            if viewer.guest() {
                <form class={Exit} method="post" action={url::home::GuestCheckoutExit}>
                    <button type="submit" class={Item}>{p.shell_exit_guest_checkout()}</button>
                </form>
            }
        </header>
    }
}
