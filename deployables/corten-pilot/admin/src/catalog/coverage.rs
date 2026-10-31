//! Catalog > Scope Coverage (admin-web's Unmapped Scope Inbox, `/catalog/scope-coverage`) and a
//! scope's coverage page (`/catalog/scope-coverage/{id}`), through the Catalog API as the signed-in
//! staff member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scope-coverage?product_domain` | the scopes with provider mappings waiting for review |
//! | `GET /catalog/scope-coverage/{id}?after_write&done&count` | the scope's coverage matrix |
//!
//! The coverage page is the scope page's coverage matrix on its own. Its forms post to the scope
//! page's coverage routes (`/catalog/scopes/{id}/coverage`, `../propose`, `../publish`) with
//! `?via=coverage`, so a write and a refusal come back here; the writes are the scope page's.
//! A coverage that cannot be read is a banner on the page, as admin-web's loader degrades it.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use super::{
    api::{Catalog as _, Coverage, Kind, under},
    manages,
    scope::{ScopeBack, url::ScopeAt},
    views,
};
use crate::{
    api::segment,
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use serde::Deserialize;

    use crate::catalog::scope::url::ScopeAt;

    /// The inbox's filter (its form's field).
    #[derive(Clone, Debug, Default, Deserialize, corten::Fields, corten::Route)]
    #[route(query)]
    pub struct InboxQuery {
        pub product_domain: Option<String>,
    }

    #[route("/catalog/scope-coverage", get = crate::catalog::coverage::inbox)]
    pub struct Inbox {
        #[route(query)]
        pub query: InboxQuery,
    }

    #[route("/catalog/scope-coverage/{id}", get = crate::catalog::coverage::page)]
    pub struct CoveragePage<'a> {
        pub id: &'a str,
        #[route(query)]
        pub at: ScopeAt,
    }
}

/// A proposal's counts (`UnmappedScopeInboxGroup.counts`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupCounts {
    pub total: u64,
    pub high_confidence: u64,
}

/// A scope with proposals waiting (`UnmappedScopeInboxGroup`), without its candidates, which the
/// inbox does not show.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub scope_record_id: String,
    pub scope_name: String,
    pub product_domain: String,
    pub scope_kind: String,
    #[serde(default)]
    pub official_set_code: Option<String>,
    #[serde(default)]
    pub is_draft_canonical_record: bool,
    #[serde(default)]
    pub counts: GroupCounts,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct InboxCounts {
    pub total_groups: u64,
    pub total_candidates: u64,
    pub high_confidence_candidates: u64,
}

/// The inbox (`UnmappedScopeInboxReadModel`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Inbox {
    pub groups: Vec<Group>,
    pub counts: InboxCounts,
}

/// The inbox page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct InboxScreen {
    pub inbox: Inbox,
    pub product_domain: Option<String>,
}

/// A scope's coverage page: the matrix and the scope it is for, or none when it could not be read.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub scope_record_id: String,
    pub scope_name: String,
    #[serde(flatten)]
    pub coverage: Coverage,
}

#[derive(Serialize, ToJson)]
pub struct CoverageScreen {
    pub scope_record_id: String,
    pub matrix: Option<Matrix>,
}

pub(crate) async fn inbox(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Inbox>,
) -> HtmlResult {
    let product_domain = route.query.product_domain.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    let query = product_domain.as_deref().map(|d| format!("?productDomain={}", segment(d))).unwrap_or_default();
    let caller = config.platform.caller(&headers, config.proto, None);
    let inbox = match caller.read_at::<Inbox>(Kind::ProviderScopeMappings, &format!("/inbox{query}")).await {
        Ok(inbox) => inbox,
        Err(error) => return read_failed(&req, error, false),
    };
    let screen = InboxScreen { inbox, product_domain };
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let page = views::coverage_inbox(t, p, &screen);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.route_scope_inbox()} head="">
                {page}
            </crate::views::Layout>
        },
    )
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::CoveragePage<'_>>,
) -> HtmlResult {
    render(&req, &staff.viewer, &config, &headers, &route.id, &route.at, ScopeBack::Nothing).await
}

/// The coverage page; with a `back` other than nothing, a refused write's answer (422). A read
/// after a write that is not caught up yet is the "pending" answer, an unknown scope is 404, and any
/// other failed read is the page's banner.
pub(crate) async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    at: &ScopeAt,
    back: ScopeBack,
) -> HtmlResult {
    let receipt = Receipt::from_param(at.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let matrix = match caller.read_at::<Matrix>(Kind::ProviderScopeMappings, &format!("/coverage{}", under(id, &[]))).await {
        Ok(matrix) => Some(matrix),
        Err(error) if receipt.is_some() && error.catching_up() => return read_failed(req, error, true),
        Err(error)
            if matches!(error.status(), Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) =>
        {
            return read_failed(req, error, false);
        }
        Err(error) => {
            tracing::warn!("a scope's coverage could not be read: {error}");
            None
        }
    };
    let screen = CoverageScreen { scope_record_id: id.to_owned(), matrix };
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let notice = at.done.map(|done| done.notice(t, p, at.count.unwrap_or(0)));
    let refused = matches!(back, ScopeBack::Refused(_) | ScopeBack::Propose(..));
    let page = views::coverage_page(t, p, &screen, notice, back, manages(viewer));
    let html = html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_scope_coverage()} head="">
            {page}
        </crate::views::Layout>
    };
    if refused { req.page_with_status(StatusCode::UNPROCESSABLE_ENTITY, html) } else { req.screen(&screen, html) }
}
