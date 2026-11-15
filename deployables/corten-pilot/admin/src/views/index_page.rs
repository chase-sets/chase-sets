//! admin-web's home (`routes/index.tsx`): the sections the staff member may open, each a card with
//! Open, or that they may open none. `crate::sections::index` sends someone with one section
//! straight to it, as admin-web's loader does, so this page lists two or more, or none.
//!
//! The home is at `/`, which no area can be (an area's prefix starts every path under it), so its
//! stylesheet is the app's, on every page, as Corten's styles guide says of a home page. It is its
//! own few rules rather than the kit's Card and Button, which would add about 1.8 KB brotli to
//! every page (measured, brotli 11) for the areas that already link them.
use corten::prelude::*;
use platform::section::PageHeader;

use crate::text::SiteMsg;

/// A section on the home page: its name, where Open goes, and its heading's id.
pub struct HomeSection {
    pub label: &'static str,
    pub href: String,
    pub id: String,
}

/// The sections, one column on a phone, two from 48rem and three from 80rem (admin-web's
/// `Grid columns={{ base: 1, md: 2, xl: 3 }}`). Each Open names its section to a screen reader
/// (`aria-describedby` its heading), since every one says Open.
#[component(css)]
pub fn IndexPage<'a>(t: SiteMsg, sections: &'a [HomeSection]) -> impl Render {
    html! {
        if sections.is_empty() {
            <div class={Empty}>
                <h1 class={Title}>{t.index_no_admin_sections_available()}</h1>
                <p class={Muted}>
                    {t.index_your_account_is_signed_in_but_it_does_not_have_permission_to_view_any_admin_sections()}
                </p>
            </div>
        } else {
            <PageHeader
                eyebrow={t.index_admin()}
                title={t.index_admin_sections()}
                description={t.index_choose_a_section_to_continue_with_the_tools_available_to_your_account()}
            />
            <ul class={Sections}>
                for section in sections {
                    <li class={Card}>
                        <h2 id={&section.id} class={Name}>{section.label}</h2>
                        <a class={Open} href={&section.href} aria-describedby={&section.id}>{t.index_open()}</a>
                    </li>
                }
            </ul>
        }
    }
}
