//! The scopes list (admin-web's scope-first Catalog landing, `CatalogScopeLandingPage`): every
//! canonical Scope Record, filtered by product domain, lifecycle status, language edition and text
//! in the API, with each row's promotion readiness and sync freshness as the API derives them and
//! the language choices from its facets.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes?search&status&product_domain&language&page` | the list, with the attention queue above it ([`attention`](super::attention)) |
//!
//! Each row's View opens the scope's page ([`scope`](super::scope)). Above the list, after the
//! queue, is the all-scopes alias review (`alias-review?limit=200`, folded as admin-web's is), whose
//! commands post to the attention routes ([`attention`](super::attention)). Not ported: its bulk
//! selection, which admin-web keeps in the browser; each candidate has its own commands.
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;

use futures_util::future::join3;
use platform::receipt::Receipt;

pub use super::api::{Promotion, Sync};
use super::{
    api::{AliasReview, AttentionQueue, Catalog as _, Kind, List, ScopeFacets, ScopePage, ScopeRecord},
    attention::Parked,
    list_query, screen,
    views::{self, ListScreen},
};
use crate::{
    api::{ApiError, Caller},
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The list's filters (the filter form's fields) and page (from 1), and the attention queue's
    /// window apart from them (admin-web's `attentionKind` and `attentionOffset`), so paging one
    /// never moves the other. The window is read as admin-web reads it: an unknown kind is the
    /// summary and an offset that is not a number is 0, rather than a refused page.
    #[derive(Clone, Debug, Default, Fields, Route)]
    #[route(query)]
    pub struct ScopeQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub product_domain: Option<String>,
        /// A language edition (the API's `languageEdition`).
        pub language: Option<String>,
        pub page: Option<u32>,
        pub attention_kind: Option<String>,
        pub attention_offset: Option<String>,
    }

    /// What an attention queue command did: admin-web's banner (queued, or the command failed).
    #[derive(Clone, Copy, Debug, PartialEq, Eq, corten::UrlValue)]
    #[serde(rename_all = "snake_case")]
    pub enum AttentionDone {
        Queued,
        Failed,
    }

    /// What the write before left on the list: its receipt, its banner, and the item a park took
    /// out of the queue (Restore brings it back).
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ScopeNotice {
        pub after_write: Option<String>,
        pub done: Option<AttentionDone>,
        pub parked: Option<String>,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/catalog/scopes", get = scopes)]
    pub struct Scopes {
        #[route(query)]
        pub query: ScopeQuery,
        #[route(query)]
        pub notice: ScopeNotice,
    }

    impl ScopeQuery {
        /// The filters, page and queue window that are set, by their query names: what the queue's
        /// forms keep.
        pub fn kept(&self) -> Vec<(corten::FieldName, String)> {
            let f = ScopeQuery::FIELDS;
            let names = [
                (f.search, &self.search),
                (f.status, &self.status),
                (f.product_domain, &self.product_domain),
                (f.language, &self.language),
            ];
            let mut kept: Vec<_> = names.into_iter().filter_map(|(name, value)| Some((name.untyped(), value.clone()?))).collect();
            if let Some(page) = self.page.filter(|page| *page > 1) {
                kept.push((f.page.untyped(), page.to_string()));
            }
            let (kind, offset) = self.attention_window();
            if let Some(kind) = kind {
                kept.push((f.attention_kind.untyped(), kind.as_str().to_owned()));
            }
            if offset > 0 {
                kept.push((f.attention_offset.untyped(), offset.to_string()));
            }
            kept
        }

        /// The queue window asked for (`readCatalogAttentionQueuePageWindow`): a kind, or none for
        /// the summary, and the offset into it.
        pub fn attention_window(&self) -> (Option<crate::catalog::api::AttentionKind>, u64) {
            let kind = self.attention_kind.as_deref().map(str::trim).and_then(crate::catalog::api::AttentionKind::parse);
            let offset = self.attention_offset.as_deref().and_then(|o| o.trim().parse::<f64>().ok()).filter(|o| o.is_finite());
            match kind {
                // An unknown kind is the summary, at its start.
                None if self.attention_kind.as_deref().is_some_and(|k| !k.trim().is_empty()) => (None, 0),
                kind => (kind, offset.map_or(0, |o| o.trunc().max(0.0) as u64)),
            }
        }

        /// The same list showing the queue's window `kind` at `offset` (`catalogAttentionQueuePageHref`).
        pub fn with_attention(&self, kind: Option<crate::catalog::api::AttentionKind>, offset: u64) -> ScopeQuery {
            ScopeQuery {
                attention_kind: kind.map(|k| k.as_str().to_owned()),
                attention_offset: (offset > 0).then(|| offset.to_string()),
                ..self.clone()
            }
        }
    }
}

/// The Catalog's scope product domains (`catalogScopeProductDomains`, from scripts/export.mjs).
pub fn product_domains() -> &'static [String] {
    static DOMAINS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../scope-domains.json")).expect("scope-domains.json is the export's output")
    });
    &DOMAINS
}

/// The list page's view model: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ScopeScreen {
    #[serde(flatten)]
    pub list: ListScreen<ScopeRecord>,
    /// The language editions across every page of the filter (the API's facets), and the one
    /// filtered by.
    pub languages: Vec<String>,
    /// The API's message when the list could not be read (the page shows it, with no rows).
    pub error: Option<String>,
    /// The attention queue, or none when it could not be read (the page says it is unavailable).
    pub attention: Option<AttentionQueue>,
    /// The all-scopes alias review, or none when it could not be read (`alias_review_failed`).
    pub alias_review: Option<AliasReview>,
    pub alias_review_failed: bool,
}

/// What the page draws besides the list: an item's sheet, open, with a park form that came back.
#[derive(Default)]
pub enum ScopeBack {
    #[default]
    None,
    Review(String, Option<Parked>),
}

/// The rows, the page and the language choices, from the API's page
/// (`buildCatalogScopeLandingReadModel`): the active edition stays a choice when no record has it.
fn scope_screen(list: ScopePage, page: u32, language: Option<&str>) -> ScopeScreen {
    let mut languages = list.facets.language_editions;
    languages.extend(language.map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned));
    languages.sort();
    languages.dedup();
    let rows = List { items: list.items, total: list.total };
    ScopeScreen {
        list: screen(rows, page),
        languages,
        error: None,
        attention: None,
        alias_review: None,
        alias_review_failed: false,
    }
}

/// The attention queue's window the list asks for. The page shows it as unavailable when it cannot
/// be read: a missing route, a failure, or an answer that is not the queue's shape
/// (`resolveCatalogAttentionQueueResult`), so an unreadable queue never reads as an empty one.
pub async fn read_queue(caller: &Caller<'_>, query: &url::ScopeQuery) -> Result<AttentionQueue, ApiError> {
    // `catalogAttentionQueueWindowSearch`: the summary is the bare path.
    let (kind, offset) = query.attention_window();
    let mut search = Vec::new();
    if let Some(kind) = kind {
        search.push(format!("kind={}", kind.as_str()));
    }
    if offset > 0 {
        search.push(format!("offset={offset}"));
    }
    let search = if search.is_empty() { String::new() } else { format!("?{}", search.join("&")) };
    let read = caller.read_at::<AttentionQueue>(Kind::AttentionQueue, &search).await;
    if let Err(error) = &read {
        tracing::warn!("attention queue read failed: {error}");
    }
    read
}

async fn scopes(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::scopes::url::Scopes>,
) -> HtmlResult {
    let (query, notice) = (route.query, route.notice);
    render(&req, &staff.viewer, &config, &headers, &query, &notice, ScopeBack::None).await
}

/// The scopes page: the list and the attention queue, read together (after the write before, when
/// there was one), and the sheet `back` opens.
pub async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    query: &url::ScopeQuery,
    notice: &url::ScopeNotice,
    back: ScopeBack,
) -> HtmlResult {
    let receipt = Receipt::from_param(notice.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let page = query.page.unwrap_or(1).max(1);
    let filters = [
        ("search", &query.search),
        ("status", &query.status),
        ("productDomain", &query.product_domain),
        ("languageEdition", &query.language),
    ];
    let (list, queue, review) = join3(
        caller.read_at::<ScopePage>(Kind::ScopeRecords, &format!("?{}", list_query(&filters, page))),
        read_queue(&caller, query),
        caller.read_at::<AliasReview>(Kind::AliasReview, "?limit=200"),
    )
    .await;
    let mut view = match list {
        Ok(list) => scope_screen(list, page, query.language.as_deref()),
        // As admin-web's loader: an API error is the list's banner, over no rows; sign-in and no
        // answer at all are the error pages.
        Err(error) if error.status().is_some_and(|s| s != StatusCode::UNAUTHORIZED) => {
            let empty_page = ScopePage { items: Vec::new(), total: 0, facets: ScopeFacets::default() };
            let mut empty = scope_screen(empty_page, page, query.language.as_deref());
            empty.error = Some(match error {
                ApiError::Status { message, .. } if !message.is_empty() => message,
                other => other.to_string(),
            });
            empty
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    view.attention = match queue {
        Ok(queue) => Some(queue),
        // After a park the queue waits for it, as the list does: not readable yet is the page's
        // "preparing" answer (refresh), not an unavailable queue.
        Err(error) if receipt.is_some() && error.catching_up() => return read_failed(req, error, true),
        Err(_) => None,
    };
    // As admin-web's loader: an unreadable review is its section's banner, never an empty review.
    match review {
        Ok(review) => view.alias_review = Some(review),
        Err(error) => {
            tracing::warn!("the all-scopes alias review could not be read: {error}");
            view.alias_review_failed = true;
        }
    }
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = super::manages(viewer);
    let page_view = views::scope_list(t, p, req, query, &view, notice, back, manage);
    req.screen(
        &view,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_scopes()} head="">
                {page_view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str, editions: &[&str]) -> ScopeRecord {
        ScopeRecord {
            product_line_scope_record_id: None,
            series_scope_record_id: None,
            scope_record_id: id.into(),
            reference_record_id: id.into(),
            product_domain: "pokemon".into(),
            scope_kind: "expansion".into(),
            name: id.into(),
            official_set_code: None,
            language_editions: editions.iter().map(|e| (*e).into()).collect(),
            lifecycle_status: "active".into(),
            updated_at: String::new(),
            promotion_readiness: Promotion::Live,
            sync_freshness: Sync::Fresh,
        }
    }

    #[test]
    fn the_language_choices_are_the_apis_facets_with_the_active_edition() {
        let facets = ScopeFacets { language_editions: vec!["ja".into(), "en".into()] };
        let list = ScopePage { items: vec![scope("a", &["en"])], total: 7, facets };
        let all = scope_screen(list.clone(), 1, None);
        assert_eq!(
            (all.list.items.len(), all.list.total, all.languages.as_slice()),
            (1, 7, &["en".to_owned(), "ja".to_owned()][..]),
            "the rows are the API's: it filtered them"
        );
        let fr = scope_screen(list, 1, Some(" fr "));
        assert_eq!(fr.languages, ["en", "fr", "ja"], "the active edition stays a choice");
    }
}
