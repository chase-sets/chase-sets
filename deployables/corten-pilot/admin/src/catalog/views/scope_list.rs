//! The scopes list (admin-web's `CatalogScopeLandingPage`): its filters, the rows, and the pager.
use corten::prelude::*;

use super::{
    AttentionBanner, AttentionPanel, AttentionSheet, Empty, Filters, ListPage, ListScreen, Pager, Pick, Search, Table, Tone,
    TonePill, pages_around, value,
};
use crate::{
    catalog::{
        scopes::{self, Promotion, ScopeBack, ScopeRow, ScopeScreen, Sync},
        url,
    },
    text::{Cat, Pilot},
};

/// The lifecycle statuses the list filters by, shown as their values (as admin-web's are).
const STATUSES: [(&str, &str); 4] =
    [("draft", "draft"), ("active", "active"), ("deprecated", "deprecated"), ("archived", "archived")];

/// The list, with the attention queue above it (after the banner of the queue command before, if
/// any) and an item's sheet (`back`), open.
pub fn scope_list<'a>(
    t: Cat,
    p: Pilot,
    query: &'a url::ScopeQuery,
    screen: &'a ScopeScreen,
    notice: &'a scopes::url::ScopeNotice,
    back: ScopeBack,
    manage: bool,
) -> impl Render + 'a {
    let (review, parked) = match back {
        ScopeBack::Review(key, parked) => (Some(key), parked),
        ScopeBack::None => (None, None),
    };
    let item = review.as_deref().and_then(|key| screen.attention.as_ref()?.items.iter().find(|i| i.item_key == key));
    let title = t.scopes_title();
    let filters = url::Scopes::default().href();
    let f = url::ScopeQuery::FIELDS;
    let domains: Vec<(&str, &str)> = scopes::product_domains().iter().map(|d| (d.as_str(), d.as_str())).collect();
    let languages: Vec<(&str, &str)> = screen.languages.iter().map(|l| (l.as_str(), l.as_str())).collect();
    html! {
        <ListPage title={title}>{()}</ListPage>
        if let Some(done) = notice.done {
            <AttentionBanner t={t} query={query} done={done} parked={notice.parked.as_deref()} manage={manage} />
        }
        <AttentionPanel t={t} query={query} queue={screen.attention.as_ref()} manage={manage} />
        <Filters t={t} action={&filters}>
            <Search t={t} name={f.search} title={title} value={value(&query.search)} />
            <Pick
                label={t.list_status()}
                name={f.status}
                all={t.list_all_statuses()}
                options={&STATUSES}
                value={value(&query.status)}
            />
            <Pick
                label={t.scopes_filter_product_domain()}
                name={f.product_domain}
                all={t.scopes_filter_all_domains()}
                options={&domains}
                value={value(&query.product_domain)}
            />
            <Pick
                label={t.scopes_filter_language()}
                name={f.language}
                all={t.scopes_filter_all_languages()}
                options={&languages}
                value={value(&query.language)}
            />
        </Filters>
        if let Some(error) = &screen.error {
            <ListError t={t} message={error.as_str()} />
        }
        {scope_rows(t, p, query, &screen.list)}
        <AttentionSheet t={t} query={query} item={item} parked={parked.as_ref()} manage={manage} />
    }
}

fn scope_rows<'a>(t: Cat, p: Pilot, query: &'a url::ScopeQuery, screen: &'a ListScreen<ScopeRow>) -> impl Render + 'a {
    let title = t.scopes_title();
    let filtered = query.search.is_some() || query.status.is_some();
    let empty_title = t.list_none_found(title.to_lowercase()).to_string();
    let empty_description = if filtered {
        t.list_try_adjusting_your_filters().to_owned()
    } else {
        t.list_create_first(t.scopes_entity_name().to_lowercase()).to_string()
    };
    let head = [
        t.scopes_column_scope(),
        t.scopes_column_domain(),
        t.scopes_column_coverage(),
        t.scopes_column_promotion(),
        t.scopes_column_sync(),
        "",
    ];
    let (previous, next) = pages_around(screen, |page| {
        url::Scopes { query: url::ScopeQuery { page: (page > 1).then_some(page), ..query.clone() }, notice: Default::default() }
            .href()
    });
    html! {
        if screen.items.is_empty() {
            <Empty title={&empty_title} description={&empty_description} />
        } else {
            <Table label={title} head={&head} all={None}>
                for row in &screen.items {
                    <ScopeRowView t={t} row={row} />
                }
            </Table>
            <Pager t={t} p={p} page={screen.page} pages={screen.pages} previous={previous.as_deref()} next={next.as_deref()} />
        }
    }
}

/// admin-web's danger banner: the list could not be read, and the API's message.
#[component(css = ScopeRowView)]
fn ListError<'a>(t: Cat, message: &'a str) -> impl Render {
    html! {
        <div class={Error} role="alert">
            <p class={ErrorTitle}>{t.list_error()}</p>
            <p>{message}</p>
        </div>
    }
}

/// A scope's row; its View opens the scope's page.
#[component(css)]
pub fn ScopeRowView<'a>(t: Cat, row: &'a ScopeRow) -> impl Render {
    let s = &row.scope;
    let domain = format!("{} · {}", s.product_domain, s.scope_kind);
    let coverage = (!s.language_editions.is_empty())
        .then(|| t.scopes_coverage_editions(s.language_editions.len(), s.language_editions.join(", ")).to_string());
    let (promotion, promotion_tone) = match row.promotion {
        Promotion::Unpublished => (t.scopes_promotion_unpublished(), Tone::Warning),
        Promotion::Live => (t.scopes_promotion_live(), Tone::Success),
        Promotion::Deprecated => (t.scopes_promotion_deprecated(), Tone::Neutral),
        Promotion::Archived => (t.scopes_promotion_archived(), Tone::Neutral),
    };
    let (sync, sync_tone) = match row.sync {
        Sync::Fresh => (t.scopes_sync_fresh(), Tone::Success),
        Sync::Stale => (t.scopes_sync_stale(), Tone::Warning),
    };
    let view = crate::catalog::scope::url::ScopePage::of(&s.scope_record_id).href();
    html! {
        <tr>
            <td>
                <span class={Scope}>
                    <strong>{&s.name}</strong>
                    if let Some(code) = &s.official_set_code {
                        <TonePill text={code.as_str()} tone={Tone::Neutral} />
                    }
                </span>
            </td>
            <td>{&domain}</td>
            <td>
                match &coverage {
                    Some(text) => { {text} }
                    None => <span class={Muted}>{t.scopes_coverage_none()}</span>,
                }
            </td>
            <td><TonePill text={promotion} tone={promotion_tone} /></td>
            <td><TonePill text={sync} tone={sync_tone} /></td>
            <td><a class={View} href={&view}>{t.list_view()}</a></td>
        </tr>
    }
}
