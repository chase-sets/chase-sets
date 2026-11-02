//! Support's operator pages. Support > CSAT dashboard is [`csat`] and Support > Platform Feedback
//! [`feedback`], each its own area; this module is the ones that
//! need `support.manage`, as admin-web's nav entries do. So far Support > Reference Lookup (admin-web's `/support/reference-lookup`, Platform Operations'
//! `SupportReferenceLookupPage`): an operator pastes a support reference (`ORD-`, `SHP-`, `PYO-`,
//! `SUP-`, `CSG-`, `CS-SL-`, or a raw typed id) and gets the owning record's summary and a link to
//! its admin page. Read from `/api/platform/support-reference-lookup/{reference}` as the
//! signed-in staff member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/reference-lookup?reference` | the search, and the record a reference names |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::{Deserialize, Serialize};

pub mod attention;
pub mod csat;
pub mod ebay;
pub mod feedback;
pub mod requests;
pub mod views;

use crate::{
    api::segment,
    app::{Shared, sign_in},
    auth::{Staff, SupportManage},
    text::Sup,
};

const CONTEXT: &str = "platform-operations";

#[corten::routes(state = crate::app::Shared, area = crate::support::url::Lookup, caller = crate::auth::Staff<crate::auth::SupportManage>)]
pub mod url {
    /// The lookup, with the reference searched for, if any.
    #[derive(Clone, Debug, Default)]
    #[route("/support/reference-lookup", get = lookup)]
    pub struct Lookup {
        pub reference: Option<String>,
    }
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Lookup>, shared: Shared) -> Area<url::Lookup> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// The record a reference names (`SupportReferenceLookupResult`), redacted by the API to what an
/// operator may see.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub context_name: String,
    pub entity_type: String,
    #[serde(default)]
    pub display_reference: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub admin_href: Option<String>,
}

#[derive(Deserialize)]
struct Answer {
    result: Found,
}

/// The page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct LookupScreen {
    /// The reference searched for, trimmed; empty before the first search.
    pub query: String,
    /// Whether a search was made, so no record reads as "not found" rather than no section.
    pub searched: bool,
    pub found: Option<Found>,
    /// The record's admin page: the API's admin-web path, on admin-web.
    pub href: Option<String>,
    /// That the lookup failed (admin-web's banner).
    pub failed: bool,
}

/// An admin-web path the API gave, on admin-web; anything that is not a path on this site is
/// not linked.
fn record_href(path: &str) -> Option<String> {
    (path.starts_with('/') && !path.starts_with("//") && !path.starts_with("/\\")).then(|| crate::access::admin_web(path))
}

async fn lookup(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Lookup>,
) -> HtmlResult {
    let query = route.reference.as_deref().unwrap_or_default().trim().to_owned();
    let mut screen = LookupScreen { searched: !query.is_empty(), query, found: None, href: None, failed: false };
    let mut status = StatusCode::OK;
    if screen.searched {
        let caller = config.platform.caller(&headers, config.proto, None);
        let path = format!("/api/platform/support-reference-lookup/{}", segment(&screen.query));
        match caller.read::<Answer>(&path, CONTEXT).await {
            Ok(answer) => {
                screen.href = answer.result.admin_href.as_deref().and_then(record_href);
                screen.found = Some(answer.result);
            }
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {}
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            Err(error) => {
                // admin-web's banner; the cause goes to the log.
                tracing::warn!("a support reference lookup failed: {error}");
                screen.failed = true;
                status = StatusCode::BAD_GATEWAY;
            }
        }
    }
    let t: Sup = req.t();
    let view = html! { <views::LookupPage t={t} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.lookup_route_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}
