use corten::prelude::*;

use super::marketplace;
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    text::Pilot,
};

/// Where a nav entry goes: the pilot's own page, or marketplace's.
fn link(item: &NavItem) -> Option<String> {
    let href = item.href.as_deref()?;
    if href == <url::Locations as Route>::PATH {
        return Some(url::Locations::default().href());
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

/// marketplace's top bar: the entries the seller can open, groups as menus. The pilot serves only
/// storage locations; every other entry links to marketplace. (Not ported: the bottom bar, the
/// account menu and the cart count.)
#[component(css)]
pub fn MarketNav<'a>(p: Pilot, viewer: &'a Viewer, path: &'a str) -> impl Render {
    let items = auth::top_nav(viewer);
    let current = active(&items, path);
    let is = move |item: &NavItem| (current == Some(item.key.as_str())).then_some("page");
    html! {
        <header class={Bar}>
            <a class={Brand} href={marketplace("/").map(|u| u.to_string()).unwrap_or_default()}>{p.shell_marketplace()}</a>
            <span class={Tag}>{p.shell_pilot()}</span>
            <nav aria-label={p.shell_navigation()}>
                <ul class={Items}>
                    for (item, children) in &items {
                        <li>
                            if children.is_empty() {
                                if let Some(href) = link(item) {
                                    <a class={Item} href={&href} aria-current={is(item)}>{&item.label}</a>
                                }
                            } else {
                                <details class={Group}>
                                    <summary class={Item}>{&item.label}</summary>
                                    <ul class={Menu}>
                                        for child in children {
                                            if let Some(href) = link(child) {
                                                <li><a class={Item} href={&href} aria-current={is(child)}>{&child.label}</a></li>
                                            }
                                        }
                                    </ul>
                                </details>
                            }
                        </li>
                    }
                </ul>
            </nav>
        </header>
    }
}
