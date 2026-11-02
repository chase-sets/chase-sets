use corten::prelude::*;
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

/// The section a path is in (its first segment), commerce for any other.
fn section_of(path: &str) -> &'static str {
    let first = path.trim_start_matches('/').split('/').next().unwrap_or("");
    auth::SECTIONS.into_iter().find(|s| *s == first).unwrap_or("commerce")
}

/// Where a section goes: the pilot's own home for it, or admin-web's.
fn section_link(req: &Req, section: &str) -> String {
    link_to(req, &format!("/{section}")).unwrap_or_default()
}

/// Whether the page at `path` is the entry's or under it.
fn current(href: &str, path: &str) -> bool {
    path == href || path.strip_prefix(href).is_some_and(|rest| rest.starts_with('/'))
}

fn section_label(p: Pilot, section: &str) -> &'static str {
    match section {
        "access" => p.section_access(),
        "catalog" => p.section_catalog(),
        "commerce" => p.section_commerce(),
        "growth" => p.section_growth(),
        "support" => p.section_support(),
        _ => p.section_platform(),
    }
}

/// admin-web's frame: the sections the viewer can open, and the pages of the one the page is in
/// (catalog or commerce). An entry links to the pilot's page when the pilot serves its path, and to
/// admin-web's otherwise.
///
/// The top bar is the kit's `NavBar`, which draws the current section from `aria-current="page"`.
/// Most section homes are admin-web's, which `req.nav_of` cannot mark, so the section links are
/// marked here and, after a client navigation, by `markNav` (`data-nav-path`; the README's
/// todd-skelton/corten 341 row).
#[component(css)]
pub fn AdminNav<'a>(p: Pilot, req: &'a Req, viewer: &'a Viewer) -> impl Render {
    let path = req.path();
    let sections = auth::sections(viewer);
    let here = section_of(path);
    let items = auth::section_items(viewer, here);
    let m: SignInMsg = req.t();
    html! {
        // `Phone`: the section links take their own row on a phone (todd-skelton/corten 673).
        <header class={(NavBar {}, Phone)}>
            <a class={NavBrand {}} href={admin_web("/").map(|u| u.to_string()).unwrap_or_default()}>
                {p.shell_admin()}
                <span class={Tag}>{p.shell_pilot()}</span>
            </a>
            <nav class={NavSections {}} aria-label={p.shell_navigation()}>
                for section in &sections {
                    let href = section_link(req, section);
                    <a href={&href} aria-current={(*section == here).then_some("page")} data-nav-path={format!("/{section}")}>
                        {section_label(p, section)}
                    </a>
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
        <nav class={Side} aria-label={p.shell_section_navigation(section_label(p, here))}>
            <ul>
                for (item, children) in &items {
                    let href = link(req, here, item);
                    <li>
                        if let Some(href) = &href {
                            <a class={Item} href={href} aria-current={current(href, path).then_some("page")} data-nav-path={href}>
                                {&item.label}
                            </a>
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
