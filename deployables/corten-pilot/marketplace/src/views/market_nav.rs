//! marketplace-web's shell (`DiscoveryShellLayout` around the design system's `MarketplaceShell`):
//! the top bar, the account menu and, on a phone, the bottom bar, for a member, a guest checkout or
//! a visitor, from the exported top-nav, bottom-nav and account-menu contributions.
//!
//! The cart's count is the page's `Chrome` (`crate::chrome`), read beside the page for a full load
//! and drawn here, with or without JavaScript; a visitor's cart entry is hidden while it is 0, as
//! marketplace hides it. A write's redirect draws the header again, and so does the cart page
//! reading itself again while its write lands, once the cart is found.
use std::{collections::HashMap, sync::LazyLock};

use corten::{Local, NavLink, NavLinks, NavTo, prelude::*};

use super::marketplace;
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    text::Pilot,
};

/// The badge value the cart's entry reads.
const CART_COUNT: &str = "checkout.cart-count";

/// The design system's glyphs the nav draws (`Icon`'s lucide markup, from scripts/export.mjs).
static ICONS: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../nav-icons.json")).expect("nav-icons.json is the export's output"));

/// An entry's page on the pilot, when the pilot serves it.
fn own(req: &Req, item: &NavItem) -> Option<Local> {
    item.href.as_deref().and_then(Local::parse).filter(|to| req.serves(to))
}

/// One bar's entries the pilot serves, by key, marked as `resolveMarketplaceActiveKey` marks them:
/// each entry holds the pages under it, and of those that hold this page only the deepest is
/// current. Corten keeps the mark right after a client navigation (`req.nav_of`).
fn marks<'a, 'b>(req: &Req, items: impl IntoIterator<Item = &'b (&'a NavItem, Vec<&'a NavItem>)>) -> NavLinks<&'a str>
where
    'a: 'b,
{
    let entries: Vec<(Local, &str)> = items
        .into_iter()
        .flat_map(|(item, children)| std::iter::once(*item).chain(children.iter().copied()))
        .filter(|item| item.children.is_empty())
        .filter_map(|item| Some((own(req, item)?, item.key.as_str())))
        .collect();
    req.nav_of(entries.iter().map(|(to, key)| (NavTo::section(to), *key)))
}

/// Where an entry the pilot does not serve goes: marketplace's page.
fn elsewhere(item: &NavItem) -> Option<String> {
    marketplace(item.href.as_deref()?).map(|uri| uri.to_string())
}

/// marketplace-web's shell: the top bar (its sections and, from 48rem, its utility entries: sign
/// in, the cart), the account menu or Exit guest checkout, and below 48rem the bottom bar of five
/// (`BottomNav`), its groups opening upward. An entry the pilot serves links to the pilot, marked
/// current by Corten's nav rule; every other one to marketplace, never current.
#[component(css)]
pub fn MarketNav<'a>(p: Pilot, req: &'a Req, viewer: Option<&'a Viewer>, cart: Option<u64>) -> impl Render {
    let items = auth::top_nav(viewer);
    let (mut ends, primary): (Vec<_>, Vec<_>) =
        items.into_iter().partition(|(item, _)| item.placement.as_deref() == Some("utility"));
    // The cart last, as `TopNav` orders its utility entries.
    ends.sort_by_key(|(item, _)| item.key == "cart");
    let menu = auth::account_menu(viewer);
    let bottom = auth::bottom_nav(viewer);
    // A visitor's cart entry is drawn hidden while the cart is empty, so the cart page can show it.
    let hidden = |item: &NavItem| viewer.is_none() && item.hides_when_empty() && cart.unwrap_or(0) == 0;
    let empty = |item: &NavItem| viewer.is_none() && item.hides_when_empty();
    html! {
        // The top bar's sections and its utility entries are one nav, as marketplace marks them;
        // the phone's bar is another.
        let top_marks = marks(req, primary.iter().chain(&ends));
        let top: HashMap<&str, NavLink<'_>> = top_marks.links().map(|(link, key)| (*key, link)).collect();
        let bottom_marks = marks(req, &bottom);
        let phone: HashMap<&str, NavLink<'_>> = bottom_marks.links().map(|(link, key)| (*key, link)).collect();
        <header class={Bar}>
            <a class={Brand} href={marketplace("/").map(|u| u.to_string()).unwrap_or_default()}>{p.shell_marketplace()}</a>
            <span class={Tag}>{p.shell_pilot()}</span>
            <nav class={Wide} aria-label={p.shell_navigation()}>
                <ul class={Items}>
                    for (item, children) in &primary {
                        <li>
                            if children.is_empty() {
                                <Entry class={Item} link={top.get(item.key.as_str())} item={item}>{&item.label}</Entry>
                            } else {
                                <details>
                                    <summary class={Item}>{&item.label}</summary>
                                    <ul class={Menu}>
                                        for child in children {
                                            <li>
                                                <Entry class={Item} link={top.get(child.key.as_str())} item={child}>
                                                    {&child.label}
                                                </Entry>
                                            </li>
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
                                if let Some(href) = own(req, item).map(|to| to.to_string()).or_else(|| elsewhere(item)) {
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
                            <li hidden={hidden(item)} data-hide-empty={empty(item)}>
                                <Entry class={Item} link={top.get(item.key.as_str())} item={item}>
                                    {&item.label}
                                    <Count item={item} cart={cart} />
                                </Entry>
                            </li>
                        }
                    </ul>
                }
            </div>
        </header>
        <nav class={Phone} aria-label={p.shell_navigation()}>
            <ul class={Slots}>
                for (item, children) in &bottom {
                    <li class={Slot} hidden={hidden(item)} data-hide-empty={empty(item)}>
                        if children.is_empty() {
                            <Entry class={Tab} link={phone.get(item.key.as_str())} item={item}>
                                <span class={Mark}>
                                    <Glyph name={item.icon.as_deref()} />
                                    <Count item={item} cart={cart} />
                                </span>
                                <span class={Label}>{&item.label}</span>
                            </Entry>
                        } else {
                            <details class={Group}>
                                <summary class={Tab}>
                                    <span class={Mark}><Glyph name={item.icon.as_deref()} /></span>
                                    <span class={Label}>{&item.label}</span>
                                </summary>
                                <ul class={(Menu, Up)}>
                                    for child in children {
                                        <li>
                                            <Entry class={Item} link={phone.get(child.key.as_str())} item={child}>
                                                <Glyph name={child.icon.as_deref()} />
                                                {&child.label}
                                            </Entry>
                                        </li>
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

/// A nav entry's link: the pilot's page with Corten's marks (`link`), or else marketplace's.
#[component(css = MarketNav)]
fn Entry<'a, K: ClassList, C: Render>(class: K, link: Option<&'a NavLink<'a>>, item: &'a NavItem, children: C) -> impl Render {
    let away = link.is_none().then(|| elsewhere(item)).flatten();
    html! {
        if let Some(link) = link {
            <a class={class} {..link}>{children}</a>
        } else if let Some(href) = &away {
            <a class={class} href={href}>{children}</a>
        }
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
