//! marketplace-web's shell (`DiscoveryShellLayout` around the design system's `MarketplaceShell`):
//! the top bar, the account menu and, on a phone, the bottom bar, for a member, a guest checkout or
//! a visitor, from the exported top-nav, bottom-nav and account-menu contributions.
//!
//! The cart's count is the page's `Chrome` (`crate::chrome`), read beside the page for a full load
//! and drawn here, with or without JavaScript; a visitor's cart entry is hidden while it is 0, as
//! marketplace hides it. A client navigation keeps the header, so the cart page tells the badge
//! the count its own read found (`badge::known`): its writes are `data-patch` forms whose redirect
//! keeps the header as the full load drew it (todd-skelton/corten#538).
use std::{collections::HashMap, sync::LazyLock};

use corten::prelude::*;

use super::marketplace;
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    text::Pilot,
};

corten::script::script!(pub mod badge = "nav_badge.js");

/// The badge value the cart's entry reads.
const CART_COUNT: &str = "checkout.cart-count";

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
    <url::AccountHome as Route>::PATH,
    <url::Security as Route>::PATH,
    <url::Consents as Route>::PATH,
    <url::Reviews as Route>::PATH,
    <url::SubmittedOffers as Route>::PATH,
    <url::PaymentMethods as Route>::PATH,
    <url::SignIn as Route>::PATH,
    <url::Register as Route>::PATH,
];

/// The design system's glyphs the nav draws (`Icon`'s lucide markup, from scripts/export.mjs).
static ICONS: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../nav-icons.json")).expect("nav-icons.json is the export's output"));

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

/// marketplace-web's shell: the top bar (its sections and, from 48rem, its utility entries: sign
/// in, the cart), the account menu or Exit guest checkout, and below 48rem the bottom bar of five
/// (`BottomNav`), its groups opening upward. An entry the pilot serves (`OWN`) links to the pilot;
/// every other one to marketplace.
#[component(css)]
pub fn MarketNav<'a>(p: Pilot, viewer: Option<&'a Viewer>, cart: Option<u64>, path: &'a str) -> impl Render {
    let items = auth::top_nav(viewer);
    let current = active(&items, path);
    let is = move |item: &NavItem| (current == Some(item.key.as_str())).then_some("page");
    let (mut ends, primary): (Vec<_>, Vec<_>) =
        items.into_iter().partition(|(item, _)| item.placement.as_deref() == Some("utility"));
    // The cart last, as `TopNav` orders its utility entries.
    ends.sort_by_key(|(item, _)| item.key == "cart");
    let menu = auth::account_menu(viewer);
    let bottom = auth::bottom_nav(viewer);
    let here = active(&bottom, path);
    // A visitor's cart entry is drawn hidden while the cart is empty, so the cart page can show it.
    let hidden = |item: &NavItem| viewer.is_none() && item.hides_when_empty() && cart.unwrap_or(0) == 0;
    let empty = |item: &NavItem| viewer.is_none() && item.hides_when_empty();
    html! {
        <header class={Bar}>
            <a class={Brand} href={marketplace("/").map(|u| u.to_string()).unwrap_or_default()}>{p.shell_marketplace()}</a>
            <span class={Tag}>{p.shell_pilot()}</span>
            <nav class={Wide} aria-label={p.shell_navigation()} data-nav-rule="deepest">
                <ul class={Items}>
                    for (item, children) in &primary {
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
            <div class={Ends}>
                if viewer.is_some_and(Viewer::guest) {
                    <form class={Exit} method="post" action={url::home::GuestCheckoutExit}>
                        <button type="submit" class={Item}>{p.shell_exit_guest_checkout()}</button>
                    </form>
                }
                if !menu.is_empty() {
                    <details class={Account}>
                        <summary class={Item} aria-label={p.shell_account_menu()}>
                            <Glyph name={Some("user")} />
                            <span>{p.shell_account()}</span>
                        </summary>
                        <ul class={(Menu, End)}>
                            for item in &menu {
                                if let Some(href) = link(item) {
                                    <li>
                                        <a class={Item} href={&href}>
                                            <Glyph name={item.icon.as_deref()} />
                                            {&item.label}
                                        </a>
                                    </li>
                                }
                            }
                            <li>
                                <form method="post" action={url::sign_out::SignOut}>
                                    <button type="submit" class={(Item, Plain)}>{p.shell_sign_out()}</button>
                                </form>
                            </li>
                        </ul>
                    </details>
                }
                if !ends.is_empty() {
                    <ul class={(Items, Wide)}>
                        for (item, _) in &ends {
                            if let Some(href) = link(item) {
                                <li hidden={hidden(item)} data-hide-empty={empty(item)}>
                                    <a class={Item} href={&href} aria-current={is(item)} data-nav-path={item.href.as_deref()}>
                                        {&item.label}
                                        <Count item={item} cart={cart} />
                                    </a>
                                </li>
                            }
                        }
                    </ul>
                }
            </div>
        </header>
        <nav class={Phone} aria-label={p.shell_navigation()} data-nav-rule="deepest">
            <ul class={Slots}>
                for (item, children) in &bottom {
                    <li class={Slot} hidden={hidden(item)} data-hide-empty={empty(item)}>
                        if children.is_empty() {
                            if let Some(href) = link(item) {
                                <a
                                    class={Tab}
                                    href={&href}
                                    aria-current={(here == Some(item.key.as_str())).then_some("page")}
                                    data-nav-path={item.href.as_deref()}
                                >
                                    <span class={Mark}>
                                        <Glyph name={item.icon.as_deref()} />
                                        <Count item={item} cart={cart} />
                                    </span>
                                    <span class={Label}>{&item.label}</span>
                                </a>
                            }
                        } else {
                            <details class={Group}>
                                <summary class={Tab}>
                                    <span class={Mark}><Glyph name={item.icon.as_deref()} /></span>
                                    <span class={Label}>{&item.label}</span>
                                </summary>
                                <ul class={(Menu, Up)}>
                                    for child in children {
                                        if let Some(href) = link(child) {
                                            <li>
                                                <a
                                                    class={Item}
                                                    href={&href}
                                                    aria-current={(here == Some(child.key.as_str())).then_some("page")}
                                                    data-nav-path={child.href.as_deref()}
                                                >
                                                    <Glyph name={child.icon.as_deref()} />
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
    }
}

/// A design-system icon (`Icon` at its small size): the lucide glyph the export took, or nothing
/// for an entry without one.
#[component(css = MarketNav)]
fn Glyph<'a>(name: Option<&'a str>) -> impl Render {
    let inner = name.and_then(|name| ICONS.get(name));
    html! {
        if let Some(inner) = inner {
            <svg
                class={Icon}
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                focusable="false"
            >
                {raw(inner)}
            </svg>
        }
    }
}

/// The cart's count on its entry, "max+" past its most and hidden at 0 (`toNavigationItem`);
/// nothing for an entry without a badge.
#[component(css = MarketNav)]
fn Count<'a>(item: &'a NavItem, cart: Option<u64>) -> impl Render {
    let key = item.badge_key();
    let count = cart.filter(|_| key == Some(CART_COUNT));
    let text = key.zip(count).and_then(|(key, count)| item.badge(&[(key, count)]));
    html! {
        if let Some(key) = key {
            <span class={Badge} data-badge={key} data-max={item.badge_max()} hidden={text.is_none()}>{text}</span>
        }
    }
}
