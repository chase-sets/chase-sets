//! A set's page, after discovery's `routes/set.tsx`: the game, the set's name and what is known
//! of it (its card count, cataloged items, code and release date), and its cataloged items as
//! cards, with a link to all of them in search when the API sent only the first; or, with none
//! yet, an empty state that offers the marketplace.
use corten::prelude::*;

use super::search_page::ItemCards;
use crate::{
    api::SetPage as Set,
    app::url,
    search::{Filter, Kind, Terms},
    text::SearchMsg,
};

/// The page.
#[component(css)]
pub fn SetPage<'a>(t: SearchMsg, set: &'a Set) -> impl Render {
    let facts = facts(t, set);
    let more = set.item_count > set.items.len() as u64;
    let browse = url::Search { terms: Terms::default() }.href();
    html! {
        <div class={Page}>
            <header class={Head}>
                if let Some(game) = set.game.as_deref().filter(|g| !g.trim().is_empty()) {
                    <span class={Badge}>{game}</span>
                }
                <h1 class={Title}>{&set.name}</h1>
                <p class={Facts}>{&facts}</p>
            </header>
            if set.items.is_empty() {
                <div class={Empty}>
                    <h2 class={EmptyTitle}>{t.set_no_cards_yet()}</h2>
                    <p class={Muted}>{t.set_this_set_does_not_have_any_cataloged_cards_yet()}</p>
                    <a class={Primary} href={&browse}>{t.set_browse_marketplace()}</a>
                </div>
            } else {
                <ItemCards t={t} items={&set.items} action={t.set_view_card()} from={None} />
                if more {
                    <p class={More}>
                        <a class={Secondary} href={&browse_all(set)}>{t.set_browse_all_cards_in_this_set(set.item_count)}</a>
                    </p>
                }
            }
        </div>
    }
}

/// What is known of the set, joined by " · ".
fn facts(t: SearchMsg, set: &Set) -> String {
    let mut facts = Vec::new();
    if let Some(count) = set.reference_card_count {
        facts.push(t.set_reference_cards_count(count).to_string());
    }
    facts.push(t.set_cataloged_items_count(set.item_count).to_string());
    if let Some(code) = set.code.as_deref().filter(|c| !c.is_empty()) {
        facts.push(t.set_set_code(code).to_string());
    }
    if let Some(date) = set.release_date.as_deref().and_then(long_date) {
        facts.push(t.set_released_on(&date).to_string());
    }
    facts.join(" \u{b7} ")
}

/// Search for every item in the set (`browseAllHref`): `/search?reference.<type>=<set>`.
fn browse_all(set: &Set) -> String {
    let filter = Filter { kind: Kind::Reference, id: set.type_key.clone(), value: set.reference_record_id.clone() };
    url::Search { terms: Terms { filters: vec![filter], ..Terms::default() } }.href()
}

/// A date as Chase Sets writes it in English for public pages (`formatDate`'s `long` preset, in
/// UTC): `January 9, 1999`. The API sends a day (`1999-01-09`) or a timestamp that starts with one.
pub fn long_date(value: &str) -> Option<String> {
    let (year, name, date) = date_parts(value)?;
    (1..=31).contains(&date).then(|| format!("{name} {date}, {year}"))
}

/// A date's year, month name and day, from the first ten characters (`2026-10-24`).
fn date_parts(value: &str) -> Option<(u32, &'static str, u32)> {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let day = value.get(..10)?;
    let mut parts = day.split('-');
    let (year, month, date) = (parts.next()?, parts.next()?, parts.next()?);
    let year: u32 = year.parse().ok()?;
    let month: usize = month.parse().ok()?;
    let date: u32 = date.parse().ok()?;
    let name = MONTHS.get(month.checked_sub(1)?)?;
    Some((year, name, date))
}

#[cfg(test)]
mod tests {
    use super::long_date;

    #[test]
    fn a_release_date_is_written_long() {
        assert_eq!(long_date("1999-01-09").as_deref(), Some("January 9, 1999"));
        assert_eq!(long_date("2024-11-08T00:00:00.000Z").as_deref(), Some("November 8, 2024"));
        assert_eq!(long_date("1999-13-01"), None);
        assert_eq!(long_date("soon"), None);
    }
}
