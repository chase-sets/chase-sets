//! The scopes list (admin-web's scope-first Catalog landing, `CatalogScopeLandingPage`): every
//! canonical Scope Record, filtered by product domain, lifecycle status and text in the API and
//! by language edition over the page it returned, as admin-web's loader does.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes?search&status&product_domain&language&page` | the list, with the attention queue above it ([`attention`](super::attention)) |
//!
//! Each row's View opens the scope's page ([`scope`](super::scope)). Not ported yet: the
//! all-scopes alias review that admin-web shows above the list.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use futures_util::future::join;
use platform::receipt::Receipt;

use super::{
    api::{AttentionQueue, Catalog as _, Kind, List, ScopeRecord},
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

    /// The list's filters (the filter form's fields) and page (from 1).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct ScopeQuery {
        pub search: Option<String>,
        pub status: Option<String>,
        pub product_domain: Option<String>,
        /// A language edition: filters the page the API returned, not the API's query.
        pub language: Option<String>,
        pub page: Option<u32>,
    }

    /// What an attention queue command did: admin-web's banner (queued, or the command failed).
    #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, corten::UrlValue)]
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
        /// The filters and page that are set, by their query names: what the queue's forms keep.
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
            kept
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

/// Whether a scope's canonical record can promote Catalog Items yet (`CatalogScopePromotionReadiness`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "lowercase")]
pub enum Promotion {
    Unpublished,
    Live,
    Deprecated,
    Archived,
}

/// Whether a scope's record changed in the last two weeks (`CatalogScopeSyncFreshness`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "lowercase")]
pub enum Sync {
    Fresh,
    Stale,
}

/// A row: the record, and what admin-web derives from it.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct ScopeRow {
    #[serde(flatten)]
    pub scope: ScopeRecord,
    pub promotion: Promotion,
    pub sync: Sync,
}

/// The list page's view model: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ScopeScreen {
    #[serde(flatten)]
    pub list: ListScreen<ScopeRow>,
    /// The language editions on the page the API returned, and the one filtered by.
    pub languages: Vec<String>,
    /// The API's message when the list could not be read (the page shows it, with no rows).
    pub error: Option<String>,
    /// The attention queue, or none when it could not be read (the page says it is unavailable).
    pub attention: Option<AttentionQueue>,
}

/// What the page draws besides the list: an item's sheet, open, with a park form that came back.
#[derive(Default)]
pub enum ScopeBack {
    #[default]
    None,
    Review(String, Option<Parked>),
}

/// `SCOPE_LANDING_STALE_SYNC_MS`: a record that has not changed in two weeks reads as a stale sync.
const STALE_SYNC: Duration = Duration::days(14);

/// Workaround for chase-sets/chase-sets#10507: admin-web derives a scope's promotion readiness and
/// sync freshness in its web layer (`scope-landing-read-model.ts`), so the pilot repeats the rule.
/// Remove it once the Catalog API returns them.
pub(crate) fn row(scope: ScopeRecord, now: OffsetDateTime) -> ScopeRow {
    let promotion = match scope.lifecycle_status.as_str() {
        "active" => Promotion::Live,
        "deprecated" => Promotion::Deprecated,
        "archived" => Promotion::Archived,
        _ => Promotion::Unpublished,
    };
    // An unreadable time is stale, so it is reviewed rather than read as fresh.
    let sync = match OffsetDateTime::parse(&scope.updated_at, &Rfc3339) {
        Ok(at) if now - at <= STALE_SYNC => Sync::Fresh,
        _ => Sync::Stale,
    };
    ScopeRow { scope, promotion, sync }
}

/// The rows, the page and the language facet, from the API's page (`buildCatalogScopeLandingReadModel`).
/// Workaround for chase-sets/chase-sets#10565: the API has no language filter, so the facet filters
/// only the page shown, as admin-web's does. Forward it to the API once it takes one.
fn scope_screen(list: List<ScopeRecord>, page: u32, language: Option<&str>, now: OffsetDateTime) -> ScopeScreen {
    let language = language.map(str::trim).filter(|l| !l.is_empty());
    let mut languages: Vec<String> = list.items.iter().flat_map(|s| s.language_editions.iter().cloned()).collect();
    languages.extend(language.map(str::to_owned));
    languages.sort();
    languages.dedup();
    let rows = List {
        items: list
            .items
            .into_iter()
            .filter(|s| language.is_none_or(|l| s.language_editions.iter().any(|e| e == l)))
            .map(|s| row(s, now))
            .collect(),
        total: list.total,
    };
    ScopeScreen { list: screen(rows, page), languages, error: None, attention: None }
}

/// The attention queue. The page shows it as unavailable when it cannot be read: a missing route,
/// a failure, or an answer that is not the queue's shape (`resolveCatalogAttentionQueueResult`),
/// so an unreadable queue never reads as an empty one.
pub async fn read_queue(caller: &Caller<'_>) -> Result<AttentionQueue, ApiError> {
    let read = caller.read_at::<AttentionQueue>(Kind::AttentionQueue, "").await;
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
    let filters = [("search", &query.search), ("status", &query.status), ("productDomain", &query.product_domain)];
    let now = OffsetDateTime::now_utc();
    let (list, queue) =
        join(caller.list::<ScopeRecord>(Kind::ScopeRecords, &list_query(&filters, page)), read_queue(&caller)).await;
    let mut view = match list {
        Ok(list) => scope_screen(list, page, query.language.as_deref(), now),
        // As admin-web's loader: an API error is the list's banner, over no rows; sign-in and no
        // answer at all are the error pages.
        Err(error) if error.status().is_some_and(|s| s != StatusCode::UNAUTHORIZED) => {
            let mut empty = scope_screen(List { items: Vec::new(), total: 0 }, page, query.language.as_deref(), now);
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
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let manage = super::manages(viewer);
    let page_view = views::scope_list(t, p, query, &view, notice, back, manage);
    req.screen(
        &view,
        html! {
            <crate::views::Layout req={&req} viewer={Some(viewer)} title={t.route_scopes()} head="">
                {page_view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str, status: &str, updated_at: &str, editions: &[&str]) -> ScopeRecord {
        ScopeRecord {
            scope_record_id: id.into(),
            reference_record_id: id.into(),
            product_domain: "pokemon".into(),
            scope_kind: "expansion".into(),
            name: id.into(),
            official_set_code: None,
            language_editions: editions.iter().map(|e| (*e).into()).collect(),
            lifecycle_status: status.into(),
            updated_at: updated_at.into(),
        }
    }

    #[test]
    fn promotion_follows_the_lifecycle_and_sync_the_last_two_weeks() {
        let now = OffsetDateTime::parse("2026-10-25T00:00:00Z", &Rfc3339).unwrap();
        let read = |status, at| {
            let r = row(scope("s", status, at, &[]), now);
            (r.promotion, r.sync)
        };
        assert_eq!(read("active", "2026-10-11T00:00:00.000Z"), (Promotion::Live, Sync::Fresh), "exactly 14 days");
        assert_eq!(read("draft", "2026-10-10T23:59:59Z"), (Promotion::Unpublished, Sync::Stale));
        assert_eq!(read("deprecated", "2026-10-24T19:00:00-05:00"), (Promotion::Deprecated, Sync::Fresh), "an offset");
        assert_eq!(read("archived", "yesterday"), (Promotion::Archived, Sync::Stale), "unreadable is stale");
    }

    #[test]
    fn the_language_facet_filters_the_page_and_lists_its_editions() {
        let now = OffsetDateTime::now_utc();
        let list = List { items: vec![scope("a", "active", "", &["ja", "en"]), scope("b", "active", "", &["en"])], total: 7 };
        let all = scope_screen(list.clone(), 1, None, now);
        assert_eq!(
            (all.list.items.len(), all.list.total, all.languages.as_slice()),
            (2, 7, &["en".to_owned(), "ja".to_owned()][..])
        );
        let ja = scope_screen(list.clone(), 1, Some("ja"), now);
        assert_eq!(ja.list.items.iter().map(|r| r.scope.scope_record_id.as_str()).collect::<Vec<_>>(), ["a"]);
        let fr = scope_screen(list, 1, Some("fr"), now);
        assert!(fr.list.items.is_empty() && fr.languages.contains(&"fr".to_owned()), "the active edition stays a choice");
    }
}
