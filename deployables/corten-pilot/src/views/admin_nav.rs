use corten::prelude::*;

use super::admin_web;
use crate::{
    app::url,
    auth::{self, NavItem, Viewer},
    text::Pilot,
};

/// Where a nav entry goes: the pilot's own page, or admin-web's.
fn link(section: &str, item: &NavItem) -> Option<String> {
    let path = format!("/{section}{}", item.href.as_deref()?);
    if path == <url::Policies as Route>::PATH {
        return Some(url::Policies::default().href());
    }
    admin_web(&path).map(|uri| uri.to_string())
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

/// admin-web's frame: the sections the viewer can open, and the commerce section's pages. The
/// pilot only serves postage policies; every other entry links to admin-web.
#[component(css)]
pub fn AdminNav<'a>(p: Pilot, viewer: &'a Viewer, path: &'a str) -> impl Render {
    let sections = auth::sections(viewer);
    let commerce = auth::section_items(viewer, "commerce");
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
                                href={admin_web(&format!("/{section}")).map(|u| u.to_string()).unwrap_or_default()}
                                aria-current={(*section == "commerce").then_some("true")}
                            >
                                {section_label(p, section)}
                            </a>
                        </li>
                    }
                </ul>
            </nav>
        </header>
        <nav class={Side} aria-label={p.shell_section_navigation(section_label(p, "commerce"))}>
            <ul>
                for (item, children) in &commerce {
                    let href = link("commerce", item);
                    <li>
                        if let Some(href) = &href {
                            <a class={Item} href={href} aria-current={(href == path).then_some("page")}>{&item.label}</a>
                        } else {
                            <span class={Group}>{&item.label}</span>
                        }
                        if !children.is_empty() {
                            <ul>
                                for child in children {
                                    if let Some(href) = link("commerce", child) {
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
