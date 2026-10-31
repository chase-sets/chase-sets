use corten::prelude::*;

use super::admin_web;
use crate::{
    access,
    app::url,
    auth::{self, NavItem, Viewer},
    catalog, commerce, operations, projections, reported, support,
    text::Pilot,
};

/// The pages the pilot serves, by their admin-web path; every other entry links to admin-web.
fn served(path: &str) -> Option<String> {
    let pages = [
        (<url::Policies as Route>::PATH, url::Policies::default().href()),
        (<catalog::url::Dimensions as Route>::PATH, catalog::url::Dimensions::default().href()),
        (<catalog::url::Fields as Route>::PATH, catalog::url::Fields::default().href()),
        (<catalog::components::url::Components as Route>::PATH, catalog::components::url::Components::default().href()),
        (<catalog::blueprints::url::Blueprints as Route>::PATH, catalog::blueprints::url::Blueprints::default().href()),
        (
            <catalog::display_templates::url::Templates as Route>::PATH,
            catalog::display_templates::url::Templates::default().href(),
        ),
        (
            <catalog::reference_records::url::RefRecords as Route>::PATH,
            catalog::reference_records::url::RefRecords::default().href(),
        ),
        (<catalog::categories::url::Categories as Route>::PATH, catalog::categories::url::Categories::default().href()),
        (<catalog::url::Items as Route>::PATH, catalog::url::Items::default().href()),
        (<catalog::url::Scopes as Route>::PATH, catalog::url::Scopes::default().href()),
        (<access::url::Access as Route>::PATH, access::url::Access::default().href()),
        (<access::url::Accounts as Route>::PATH, access::url::Accounts::default().href()),
        (<access::people::Users as Route>::PATH, access::people::Users::default().href()),
        (<access::teams::Memberships as Route>::PATH, access::teams::Memberships::default().href()),
        (<access::teams::Invitations as Route>::PATH, access::teams::Invitations::default().href()),
        (<access::people::ApiKeys as Route>::PATH, access::people::ApiKeys::default().href()),
        (<access::people::Sessions as Route>::PATH, access::people::Sessions::default().href()),
        (<operations::url::Attention as Route>::PATH, operations::url::Attention.href()),
        (<projections::url::Projections as Route>::PATH, projections::url::Projections::default().href()),
        (<reported::url::Reported as Route>::PATH, reported::url::Reported::default().href()),
        (<reported::risk::url::Risks as Route>::PATH, reported::risk::url::Risks::default().href()),
        (<support::url::Lookup as Route>::PATH, support::url::Lookup::default().href()),
        (<support::csat::url::Csat as Route>::PATH, support::csat::url::Csat::default().href()),
        (<support::feedback::url::Feedback as Route>::PATH, support::feedback::url::Feedback::default().href()),
        (<support::requests::url::Requests as Route>::PATH, support::requests::url::Requests::default().href()),
        (<support::ebay::url::Lookup as Route>::PATH, support::ebay::url::Lookup.href()),
        (<support::attention::url::Attention as Route>::PATH, support::attention::url::Attention.href()),
        (<commerce::intake::url::Intake as Route>::PATH, commerce::intake::url::Intake::default().href()),
        (<commerce::recovered::url::Recovered as Route>::PATH, commerce::recovered::url::Recovered::default().href()),
    ];
    pages.into_iter().find(|(at, _)| *at == path).map(|(_, href)| href)
}

/// Where a nav entry goes: the pilot's own page, or admin-web's.
fn link(section: &str, item: &NavItem) -> Option<String> {
    let path = format!("/{section}{}", item.href.as_deref()?);
    served(&path).or_else(|| admin_web(&path).map(|uri| uri.to_string()))
}

/// The section a path is in (its first segment), commerce for any other.
fn section_of(path: &str) -> &'static str {
    let first = path.trim_start_matches('/').split('/').next().unwrap_or("");
    auth::SECTIONS.into_iter().find(|s| *s == first).unwrap_or("commerce")
}

/// Where a section goes: the pilot's own home for it, or admin-web's.
fn section_link(section: &str) -> String {
    let path = format!("/{section}");
    served(&path).or_else(|| admin_web(&path).map(|uri| uri.to_string())).unwrap_or_default()
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
/// (catalog or commerce). The pilot serves postage policies, the catalog's dimensions, fields,
/// items list and scopes list, Access's home, lists and sessions, the platform's Operations Attention queue and Projection
/// Operations, and Support's Reported Content, Risk Alerts, Reference Lookup and CSAT dashboard; every other entry links to admin-web.
#[component(css)]
pub fn AdminNav<'a>(p: Pilot, viewer: &'a Viewer, path: &'a str) -> impl Render {
    let sections = auth::sections(viewer);
    let here = section_of(path);
    let items = auth::section_items(viewer, here);
    html! {
        <header class={Bar}>
            <a class={Brand} href={admin_web("/").map(|u| u.to_string()).unwrap_or_default()}>{p.shell_admin()}</a>
            <span class={Tag}>{p.shell_pilot()}</span>
            <nav aria-label={p.shell_navigation()}>
                <ul class={Sections}>
                    for section in &sections {
                        <li>
                            <a
                                class={Section}
                                href={section_link(section)}
                                aria-current={(*section == here).then_some("true")}
                            >
                                {section_label(p, section)}
                            </a>
                        </li>
                    }
                </ul>
            </nav>
        </header>
        <nav class={Side} aria-label={p.shell_section_navigation(section_label(p, here))}>
            <ul>
                for (item, children) in &items {
                    let href = link(here, item);
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
                                    if let Some(href) = link(here, child) {
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
