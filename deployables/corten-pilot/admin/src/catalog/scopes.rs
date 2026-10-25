//! The scopes list (admin-web's scope-first Catalog landing, `CatalogScopeLandingPage`): every
//! canonical Scope Record, filtered by product domain, lifecycle status and text in the API and
//! by language edition over the page it returned, as admin-web's loader does.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes?search&status&product_domain&language&page` | the list |
//!
//! Not ported yet: the attention queue and the all-scopes alias review that admin-web shows above
//! the list, and the scope's own page (each row's View opens admin-web's).
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Serialize;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    api::{Catalog as _, Kind, List, ScopeRecord},
    list_query, screen,
    views::{self, ListScreen},
};
use crate::{
    api::ApiError,
    app::{Shared, read_failed},
    text::{Cat, Pilot},
};

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

    #[derive(Clone, Debug, Default, Route)]
    #[route("/catalog/scopes")]
    pub struct Scopes {
        #[route(query)]
        pub query: ScopeQuery,
    }
}

/// The Catalog's scope product domains (`catalogScopeProductDomains`, from scripts/export.mjs).
pub fn product_domains() -> &'static [String] {
    static DOMAINS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../scope-domains.json")).expect("scope-domains.json is the export's output")
    });
    &DOMAINS
}

pub fn routes(
    area: Area<crate::auth::Session, super::url::Catalog>,
    shared: Shared,
) -> Area<crate::auth::Session, super::url::Catalog> {
    area.route::<url::Scopes>(get(scopes).with_state(shared))
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
}

/// `SCOPE_LANDING_STALE_SYNC_MS`: a record that has not changed in two weeks reads as a stale sync.
const STALE_SYNC: Duration = Duration::days(14);

/// Workaround for chase-sets/chase-sets#10507: admin-web derives a scope's promotion readiness and
/// sync freshness in its web layer (`scope-landing-read-model.ts`), so the pilot repeats the rule.
/// Remove it once the Catalog API returns them.
fn row(scope: ScopeRecord, now: OffsetDateTime) -> ScopeRow {
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
    ScopeScreen { list: screen(rows, page), languages, error: None }
}

async fn scopes(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<url::ScopeQuery>,
) -> corten::Result {
    let caller = config.platform.caller(&headers, config.proto, None);
    let page = query.page.unwrap_or(1).max(1);
    let filters = [("search", &query.search), ("status", &query.status), ("productDomain", &query.product_domain)];
    let now = OffsetDateTime::now_utc();
    let view = match caller.list::<ScopeRecord>(Kind::ScopeRecords, &list_query(&filters, page)).await {
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
        Err(error) => return read_failed(&req, error, false),
    };
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let page_view = views::scope_list(t, p, &query, &view);
    req.screen(Meta::new(t.route_scopes()), &view, page_view)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str, status: &str, updated_at: &str, editions: &[&str]) -> ScopeRecord {
        ScopeRecord {
            scope_record_id: id.into(),
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
