use std::collections::HashMap;

use corten::{Local, NavLink, NavTo, prelude::*};
use platform::ui::nav_bar::{NavActions, NavBar, NavBrand, NavSections};

use super::{admin_web, link_to};
use crate::{
    auth::{self, NavItem, Viewer},
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

/// admin-web's frame: the sections the viewer can open, and the pages of the one the page is in.
/// The home (`/`) is admin-web's root shell, the bar only, so it has no section pages. An entry
/// links to the pilot's page when the pilot serves its path, and to admin-web's otherwise; the
/// brand is the pilot's home.
///
/// The top bar is the kit's `NavBar`, which draws the current section from `aria-current="page"`.
/// Every section home is the pilot's (`crate::sections`), so Corten marks both bars
/// (`req.nav_of`, each entry current on the pages under it) and moves the marks after a client
/// navigation. A page the pilot does not serve is a plain link to admin-web, never current.
#[component(css)]
pub fn AdminNav<'a>(p: Pilot, req: &'a Req, viewer: &'a Viewer) -> impl Render {
    let sections = auth::sections(viewer);
    let here = section_of(req.path());
    let home = req.path() == "/";
    let items = if home { Vec::new() } else { auth::section_items(viewer, here) };
    let m: SignInMsg = req.t();
    // Each bar is one group: its entries the pilot serves, each current on the pages under it.
    let top_entries: Vec<(Local, &str)> =
        sections.iter().filter_map(|section| Some((own(req, &format!("/{section}"))?, *section))).collect();
    let side_entries: Vec<(Local, &str)> = items
        .iter()
        .filter_map(|(item, _)| Some((own(req, &format!("/{here}{}", item.href.as_deref()?))?, item.key.as_str())))
        .collect();
    html! {
        let top_marks = req.nav_of(top_entries.iter().map(|(to, key)| (NavTo::section(to), *key)));
        let top: HashMap<&str, NavLink<'_>> = top_marks.links().map(|(link, key)| (*key, link)).collect();
        let side_marks = req.nav_of(side_entries.iter().map(|(to, key)| (NavTo::section(to), *key)));
        let side: HashMap<&str, NavLink<'_>> = side_marks.links().map(|(link, key)| (*key, link)).collect();
        <header class={NavBar {}}>
            <a class={NavBrand {}} href={link_to(req, "/").unwrap_or_default()}>
                {p.shell_admin()}
                <span class={Tag}>{p.shell_pilot()}</span>
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
                <details class={Account}>
                    <summary class={Trigger} aria-label={m.menu_account_menu()}>{m.menu_account()}</summary>
                    <ul class={Menu}>
                        <li>
                            <a class={Item} href={link_to(req, "/access/account-select").unwrap_or_default()}>
                                {m.menu_switch_account()}
                            </a>
                        </li>
                        <li>
                            <a class={Item} href={link_to(req, "/access/sessions").unwrap_or_default()}>{m.menu_sessions()}</a>
                        </li>
                        <li>
                            <form method="post" action={sign_in::sign_out::SignOut}>
                                <button type="submit" class={(Item, Plain)}>{m.menu_sign_out()}</button>
                            </form>
                        </li>
                    </ul>
                </details>
            </div>
        </header>
        if !home {
            <nav class={Side} aria-label={p.shell_section_navigation(section_label(p, here))}>
                <ul>
                    for (item, children) in &items {
                        let away = (!side.contains_key(item.key.as_str())).then(|| link(req, here, item)).flatten();
                        <li>
                            if let Some(marked) = side.get(item.key.as_str()) {
                                <a class={Item} {..marked}>{&item.label}</a>
                            } else if let Some(href) = &away {
                                <a class={Item} href={href}>{&item.label}</a>
                            } else {
                                <span class={Group}>{&item.label}</span>
                            }
                            if !children.is_empty() {
                                <ul>
                                    for child in children {
                                        if let Some(href) = link(req, here, child) {
                                            <li><a class={Item} href={&href}>{&child.label}</a></li>
                                        }
                                    }
                                </ul>
                            }
                        </li>
                    }
                </ul>
            </nav>
        }
    }
}
