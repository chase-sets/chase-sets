//! marketplace-web's shell (`DiscoveryShellLayout` around the design system's `MarketplaceShell`):
//! the top bar, the account menu and, on a phone, the bottom bar, for a member, a guest checkout or
//! a visitor, from the exported top-nav, bottom-nav and account-menu contributions.
//!
//! The cart's count is the app's layout read (`crate::chrome::CartCount`), which Corten reads beside
//! the page for a full load and draws where the shell puts it, with or without JavaScript; a
//! visitor's cart entry is hidden by the stylesheet while its badge is hidden or missing, as
//! marketplace hides it at 0. A write's redirect draws the header again, and so does the cart page
//! reading itself again while its write lands, once the cart is found.
use std::collections::HashMap;

use corten::{Local, NavLink, NavLinks, NavTo, prelude::*};
use platform::{
    brand_mark::BrandMark,
    glyphs,
    ui::{icon::Icon as KitIcon, input::Input},
};

use super::{MainContentId, marketplace};
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    chrome::CartCount,
    text::{Pilot, SearchMsg},
};

corten::script::script!(pub mod header = "header_search.js");

/// The badge value the cart's entry reads.
const CART_COUNT: &str = "checkout.cart-count";

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

/// The skip link and the top bar of marketplace-web's shell (`MarketplaceShell` around `TopNav`):
/// its sections and, from 48rem, its utility entries (sign in, the cart), the header search, and the
/// account menu or Exit guest checkout. Below 48rem the bar is fixed to the top of the screen and
/// keeps 7.75rem of the page, the search on its own row, which folds away as the reader scrolls down
/// (`header_search.js`'s `shell`) while the bar keeps its room, so the page never moves under it.
/// An entry the pilot serves links to the pilot, marked current by Corten's nav rule; every other one
/// to marketplace, never current. The phone's bottom bar is `MarketPhoneNav`, after `<main>`.
#[component(css)]
pub fn MarketNav<'a>(p: Pilot, req: &'a Req, viewer: Option<&'a Viewer>) -> impl Render {
    let items = auth::top_nav(viewer);
    let (mut ends, primary): (Vec<_>, Vec<_>) =
        items.into_iter().partition(|(item, _)| item.placement.as_deref() == Some("utility"));
    // The cart last, as `TopNav` orders its utility entries.
    ends.sort_by_key(|(item, _)| item.key == "cart");
    let menu = auth::account_menu(viewer);
    let t: SearchMsg = req.t();
    html! {
        // The top bar's sections and its utility entries are one nav, as marketplace marks them.
        let top_marks = marks(req, primary.iter().chain(&ends));
        let top: HashMap<&str, NavLink<'_>> = top_marks.links().map(|(link, key)| (*key, link)).collect();
        <a class={Skip} href={MainContentId.fragment()}>{p.shell_skip()}</a>
        <nav
            class={Bar}
            aria-label={p.shell_primary_navigation()}
            data-shell-header-box="reserved"
            on:connect={header::shell(target, signal)}
        >
            <div class={Painted} data-shell-header-box="painted">
                <a class={Brand} href={url::Home::default().href()} aria-label={p.shell_brand()}>
                    <BrandMark gradient_id="chase-logo-market-nav" />
                    <span>{p.shell_brand()}</span>
                </a>
                <ul class={(Items, Wide)}>
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
                <HeaderSearch t={t} />
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
                                <li data-hide-empty={hides(viewer, item)}>
                                    <Entry class={Item} link={top.get(item.key.as_str())} item={item}>
                                        {&item.label}
                                        <Count item={item} />
                                    </Entry>
                                </li>
                            }
                        </ul>
                    }
                </div>
            </div>
        </nav>
    }
}

/// The header search's box (`HeaderSearch`): a GET form to /search with the words as `q`, which
/// `header_search.js` makes a combobox of, listing suggestions and recent searches. Its row is the
/// part of the bar that folds away on a phone (`data-search-row-slot`); the list sits outside the
/// part that folds, so an open list is never cut off. The search button is for a pointer: a
/// keyboard sends the words with Enter.
#[component(css = MarketNav)]
fn HeaderSearch(t: SearchMsg) -> impl Render {
    let search_for = t.header_search_query("{query}").to_string();
    html! {
        <div class={SearchSlot} data-search-row-slot>
            <div class={Fold}>
                <form
                    class={Search}
                    role="search"
                    method="get"
                    action={url::Search::default().href()}
                    on:connect={header::combobox(
                        target,
                        signal,
                        url::SearchSuggest::default().href(),
                        search_for.clone(),
                        t.header_recent_search().to_string(),
                        t.header_clear_recent_searches().to_string(),
                        t.header_no_matches().to_string(),
                        t.header_no_recent_searches().to_string()
                    )}
                >
                    <input
                        class={(Input {}, Words)}
                        type="text"
                        name="q"
                        role="combobox"
                        aria-label={t.header_label()}
                        aria-autocomplete="list"
                        aria-expanded="false"
                        aria-controls={HeaderSearchListId}
                        autocomplete="off"
                        enterkeyhint="search"
                        placeholder={t.header_placeholder()}
                    >
                    <button type="submit" class={Go} tabindex="-1" aria-label={t.header_label()}>
                        <KitIcon glyph={glyphs::SEARCH} />
                    </button>
                </form>
            </div>
            <ul class={Choices} id={HeaderSearchListId} role="listbox" aria-label={t.header_label()} hidden></ul>
        </div>
    }
}

/// The header search's list of choices.
#[derive(Id)]
pub struct HeaderSearchListId;

/// The phone's bottom bar of marketplace-web's shell (`BottomNav`), after `<main>`: below 48rem,
/// up to five entries, its groups opening upward. From 48rem the top bar has every entry.
#[component(css = MarketNav)]
pub fn MarketPhoneNav<'a>(p: Pilot, req: &'a Req, viewer: Option<&'a Viewer>) -> impl Render {
    let bottom = auth::bottom_nav(viewer);
    html! {
        let bottom_marks = marks(req, &bottom);
        let phone: HashMap<&str, NavLink<'_>> = bottom_marks.links().map(|(link, key)| (*key, link)).collect();
        <nav class={Phone} aria-label={p.shell_navigation()}>
            <ul class={Slots}>
                for (item, children) in &bottom {
                    <li class={Slot} data-hide-empty={hides(viewer, item)}>
                        if children.is_empty() {
                            <Entry class={Tab} link={phone.get(item.key.as_str())} item={item}>
                                <span class={Mark}>
                                    <Glyph name={item.icon.as_deref()} />
                                    <Count item={item} />
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

/// Whether an entry is drawn hidden until its badge has a count: a visitor's cart entry is always
/// drawn, and the stylesheet hides it while its badge is hidden or missing (`data-hide-empty`), so
/// the count the layout read draws decides it, without a script.
fn hides(viewer: Option<&Viewer>, item: &NavItem) -> bool {
    viewer.is_none() && item.hides_when_empty()
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

/// A design-system icon (`Icon` at its small size, in its `<span>`): the kit's `Icon` with the
/// glyph the export took (filled where the design system fills it, a rating's star), or nothing for
/// an entry without one.
#[component(css = MarketNav)]
fn Glyph<'a>(name: Option<&'a str>) -> impl Render {
    let glyph = name.and_then(glyphs::named);
    html! {
        if let Some(glyph) = glyph {
            <span class={Icon}><KitIcon glyph={glyph} /></span>
        }
    }
}

/// Where the cart's count goes on its entry: the layout read's place (`CartCount`); nothing for
/// an entry without the cart's badge.
#[component(css = MarketNav)]
fn Count<'a>(item: &'a NavItem) -> impl Render {
    let cart = item.badge_key() == Some(CART_COUNT);
    html! {
        if cart {
            {later::<CartCount>()}
        }
    }
}

/// The cart's badge (`toNavigationItem`): the count, "max+" past its most, and hidden at 0 or
/// while the cart page's read catches up (`None`). `CartCount`'s view: it has only the count, so
/// the most is the top bar's cart entry's, which the bottom bar's matches (nav.json).
#[component(css = MarketNav)]
pub fn CartBadge(count: Option<u64>) -> impl Render {
    let item = auth::NAV.iter().find(|item| item.badge_key() == Some(CART_COUNT));
    let text = item.zip(count).and_then(|(item, count)| item.badge(&[(CART_COUNT, count)]));
    html! {
        <span class={Badge} data-badge={CART_COUNT} data-max={item.and_then(NavItem::badge_max)} hidden={text.is_none()}>
            {text}
        </span>
    }
}
