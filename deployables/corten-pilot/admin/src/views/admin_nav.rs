use std::collections::HashMap;

use corten::{Local, NavLink, NavTo, prelude::*};
use corten_ui::MenuButton;
use platform::ui::{
    nav_bar::{NavActions, NavBar, NavBrand, NavSections},
    sheet::{Sheet, SheetHeader, SheetWidth, Side as SheetSide},
    visually_hidden::VisuallyHidden,
};

use super::{admin_web, link_to};
use crate::{
    auth::{self, NavItem, Viewer},
    catalog::integrations::url::{Governance, Settings},
    sign_in,
    text::{Pilot, SignInMsg},
};

/// Where a nav entry goes.
fn link(req: &Req, section: &str, item: &NavItem) -> Option<String> {
    link_to(req, &format!("/{section}{}", item.href.as_deref()?))
}

/// The pilot's page at `path`, when the pilot serves it.
fn own(req: &Req, path: &str) -> Option<Local> {
    Local::parse(path).filter(|to| req.serves(to))
}

/// The section a path is in (its first segment), commerce for any other.
fn section_of(path: &str) -> &'static str {
    let first = path.trim_start_matches('/').split('/').next().unwrap_or("");
    auth::SECTIONS.into_iter().find(|s| *s == first).unwrap_or("commerce")
}

/// A section's name, in the bar and on the home's cards.
pub fn section_label(p: Pilot, section: &str) -> &'static str {
    match section {
        "access" => p.section_access(),
        "catalog" => p.section_catalog(),
        "commerce" => p.section_commerce(),
        "growth" => p.section_growth(),
        "support" => p.section_support(),
        _ => p.section_platform(),
    }
}

/// The account menu's id (`account-menu-button` is its trigger's).
#[derive(Id)]
struct AccountMenuId;

/// admin-web's top bar: the sections the viewer can open, and the account menu (`SectionNav` is the
/// pages of the section the page is in). An entry links to the pilot's page when the pilot serves
/// its path, and to admin-web's otherwise; the brand is the pilot's home.
///
/// The top bar is the kit's `NavBar`, which draws the current section from `aria-current="page"`.
/// Every section home is the pilot's (`crate::sections`), so Corten marks both bars
/// (`req.nav_of`, each entry current on the pages under it); the top bar is outside `<main>`, so
/// the runtime moves its mark after a client navigation. A page the pilot does not serve is a plain link to admin-web, never current.
///
/// The account menu is corten-ui's `MenuButton` (admin-web's `AdminAccountMenu`: a button named
/// "Account menu" and a menu of its items). On a tablet the bar is held at the top, 4rem tall
/// (admin-web's `h-16`), with the section bar (`SectionNav`) held under it.
#[component(css)]
pub fn AdminNav<'a>(p: Pilot, req: &'a Req, viewer: &'a Viewer) -> impl Render {
    let sections = auth::sections(viewer);
    let m: SignInMsg = req.t();
    // Each bar is one group: its entries the pilot serves, each current on the pages under it.
    let top_entries: Vec<(Local, &str)> =
        sections.iter().filter_map(|section| Some((own(req, &format!("/{section}"))?, *section))).collect();
    html! {
        let top_marks = req.nav_of(top_entries.iter().map(|(to, key)| (NavTo::section(to), *key)));
        let top: HashMap<&str, NavLink<'_>> = top_marks.links().map(|(link, key)| (*key, link)).collect();
        <header class={(NavBar {}, Top)}>
            <a class={NavBrand {}} href={link_to(req, "/").unwrap_or_default()}>
                {p.shell_admin()}
            </a>
            <nav class={NavSections {}} aria-label={p.shell_navigation()}>
                for section in &sections {
                    if let Some(marked) = top.get(section) {
                        <a {..marked}>{section_label(p, section)}</a>
                    } else if let Some(href) = admin_web(&format!("/{section}")) {
                        <a href={href.to_string()}>{section_label(p, section)}</a>
                    }
                }
            </nav>
            // admin-web's account menu (`AdminAccountMenu`): switch account, sessions and sign out.
            <div class={NavActions {}}>
                <div class={Account}>
                    <MenuButton
                        id={AccountMenuId}
                        label={html! {
                            <span aria-hidden="true">{m.menu_account()}</span>
                            <span class={VisuallyHidden {}}>{m.menu_account_menu()}</span>
                        }}
                    >
                        <a role="menuitem" class={Item} href={link_to(req, "/access/account-select").unwrap_or_default()}>
                            {m.menu_switch_account()}
                        </a>
                        <a role="menuitem" class={Item} href={link_to(req, "/access/sessions").unwrap_or_default()}>
                            {m.menu_sessions()}
                        </a>
                        <form method="post" action={sign_in::sign_out::SignOut}>
                            <button type="submit" role="menuitem" class={(Item, Plain)}>{m.menu_sign_out()}</button>
                        </form>
                    </MenuButton>
                </div>
            </div>
        </header>
    }
}

/// The id of the layout's element that holds the section's pages, beside `<main>` (`Frame`). It is
/// marked `page`, so a client navigation sends it with `<main>`'s children and the runtime puts
/// it in place of the one on screen: a link from one section to another shows the new section's
/// pages.
#[derive(Id)]
pub struct SectionNavId;

/// The Sections sheet, its heading, and the phone bar's More list.
#[derive(Id)]
struct AdminSectionsId;
#[derive(Id)]
struct AdminSectionsTitleId;
#[derive(Id)]
struct AdminMoreId;

/// admin-web's phone bar (`compactAdminMobileNavItems`): four entries or fewer as they are, else
/// the first three (or the first two and the current one) with the rest under More.
fn phone_bar<'a>(entries: &[&'a NavItem], current: Option<&str>) -> (Vec<&'a NavItem>, Vec<&'a NavItem>) {
    if entries.len() <= 4 {
        return (entries.to_vec(), Vec::new());
    }
    let active = entries.iter().copied().find(|e| Some(e.key.as_str()) == current);
    let shown = match active {
        Some(active) if !entries[..3].iter().any(|e| e.key == active.key) => vec![entries[0], entries[1], active],
        _ => entries[..3].to_vec(),
    };
    let more = entries.iter().copied().filter(|e| !shown.iter().any(|s| s.key == e.key)).collect();
    (shown, more)
}

/// The pages of the section the page is in, drawn in the layout's `SectionNavId` element beside
/// `<main>` (`Frame`), as admin-web's `AdminShell` draws them at each width:
///
/// - from `lg` up, a 16rem rail beside `<main>` (its `SideNav`);
/// - below it, a bar held under the top bar with the "Current section" trail (`Breadcrumbs`) and,
///   from `wide` up, a Sections button that opens every page in a sheet (`NavigationDrawer`);
/// - on a phone, a bar fixed at the bottom with the first pages and More (`BottomNav`).
///
/// Each is drawn from one `req.nav_of`, so every copy of a link is marked alike. A client
/// navigation patches the element in place, so an open sheet or More list would stay in the top
/// layer: the script closes each when one of its links is followed, as admin-web's drawer does,
/// and Corten's link handling then navigates. Without it a link is a full load, which draws both
/// closed. The home (`/`) is admin-web's root shell, with no section pages.
#[component(css = AdminNav, js)]
pub fn SectionNav<'a>(p: Pilot, req: &'a Req, viewer: &'a Viewer) -> impl Render {
    let here = section_of(req.path());
    let home = req.path() == "/";
    let items = if home { Vec::new() } else { auth::section_items(viewer, here) };
    // A child joins its parent's group, so the deepest entry holding the page is the current one.
    let side_entries: Vec<(Local, &str)> = items
        .iter()
        .flat_map(|(item, children)| std::iter::once(*item).chain(children.iter().copied()))
        .filter_map(|item| Some((own(req, &format!("/{here}{}", item.href.as_deref()?))?, item.key.as_str())))
        .collect();
    let side_marks = req.nav_of(side_entries.iter().map(|(to, key)| {
        let target = if to.path() == Settings::PATH { NavTo::section(&Settings).also(&Governance) } else { NavTo::section(to) };
        (target, *key)
    }));
    let now = side_marks.links().find_map(|(link, key)| link.is_current().then_some(*key));
    // The trail: the current page, after the entry that holds it when it is a child.
    let trail: Vec<(&NavItem, bool)> = items
        .iter()
        .find_map(|(item, children)| {
            if Some(item.key.as_str()) == now {
                Some(vec![(*item, true)])
            } else {
                children.iter().find(|c| Some(c.key.as_str()) == now).map(|child| vec![(*item, false), (*child, true)])
            }
        })
        .unwrap_or_default();
    // The phone bar's entries: each page with an address, a group's pages in its place.
    let served = |item: &NavItem| side_entries.iter().any(|(_, key)| *key == item.key);
    let pages: Vec<&NavItem> = items
        .iter()
        .flat_map(|(item, children)| if children.is_empty() { vec![*item] } else { children.clone() })
        .filter(|item| served(item) || link(req, here, item).is_some())
        .collect();
    let (shown, more) = phone_bar(&pages, now);
    let label = p.shell_section_navigation(section_label(p, here)).to_string();
    html! {
        let side: HashMap<&str, NavLink<'_>> = side_marks.links().map(|(link, key)| (*key, link)).collect();
        if !home {
            <nav class={Side} aria-label={&label}>
                <PageList req={req} here={here} items={&items} side={&side} />
            </nav>
            <div class={Bar} data-admin-section-bar="true">
                <button type="button" class={(Control, Open)} command="show-modal" commandfor={AdminSectionsId}>
                    {p.shell_sections()}
                </button>
                if !trail.is_empty() {
                    <nav class={Trail} aria-label={p.shell_current_section()}>
                        <ol>
                            for (item, at) in &trail {
                                <li>
                                    if *at {
                                        <span aria-current="page">{&item.label}</span>
                                    } else if let Some(href) = link(req, here, item) {
                                        <a href={&href}>{&item.label}</a>
                                    } else {
                                        <span>{&item.label}</span>
                                    }
                                </li>
                            }
                        </ol>
                    </nav>
                }
            </div>
            <dialog
                class={(Sheet { side: SheetSide::Left(SheetWidth::Sm) }, Drawer)}
                id={AdminSectionsId}
                aria-labelledby={AdminSectionsTitleId}
                closedby="any"
                on:click={js::followed(event, target)}
            >
                <div class={SheetHeader {}}>
                    <h2 id={AdminSectionsTitleId}>{p.shell_sections()}</h2>
                    <button type="button" class={Control} command="close" commandfor={AdminSectionsId}>
                        {p.shell_close()}
                    </button>
                </div>
                <nav aria-label={&label}>
                    <PageList req={req} here={here} items={&items} side={&side} />
                </nav>
            </dialog>
            if !shown.is_empty() {
                <nav class={Bottom} aria-label={&label} data-admin-bottom-nav="true">
                    <ul>
                        for item in &shown {
                            <li><PageLink req={req} here={here} item={item} side={&side} /></li>
                        }
                        if !more.is_empty() {
                            <li>
                                <button type="button" class={Item} popovertarget={AdminMoreId}>{p.shell_more()}</button>
                                <ul class={More} id={AdminMoreId} popover on:click={js::picked(event, target)}>
                                    for item in &more {
                                        <li><PageLink req={req} here={here} item={item} side={&side} /></li>
                                    }
                                </ul>
                            </li>
                        }
                    </ul>
                </nav>
            }
        }
    }
}

/// The section's pages as admin-web's `SideNav` lists them: each entry, its children under it, and
/// a group with no page of its own as its name.
#[component(css = AdminNav)]
fn PageList<'a>(
    req: &'a Req,
    here: &'a str,
    items: &'a [(&'static NavItem, Vec<&'static NavItem>)],
    side: &'a HashMap<&'a str, NavLink<'a>>,
) -> impl Render {
    html! {
        <ul>
            for (item, children) in items {
                <li>
                    if side.contains_key(item.key.as_str()) || link(req, here, item).is_some() {
                        <PageLink req={req} here={here} item={item} side={side} />
                    } else {
                        <span class={Group}>{&item.label}</span>
                    }
                    if !children.is_empty() {
                        <ul>
                            for child in children {
                                if side.contains_key(child.key.as_str()) || link(req, here, child).is_some() {
                                    <li><PageLink req={req} here={here} item={child} side={side} /></li>
                                }
                            }
                        </ul>
                    }
                </li>
            }
        </ul>
    }
}

/// One page's link: Corten's marked one when the pilot serves it, admin-web's otherwise.
#[component(css = AdminNav)]
fn PageLink<'a>(req: &'a Req, here: &'a str, item: &'a NavItem, side: &'a HashMap<&'a str, NavLink<'a>>) -> impl Render {
    html! {
        if let Some(marked) = side.get(item.key.as_str()) {
            <a class={Item} {..marked}>{&item.label}</a>
        } else if let Some(href) = link(req, here, item) {
            <a class={Item} href={&href}>{&item.label}</a>
        }
    }
}
