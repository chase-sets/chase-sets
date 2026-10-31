//! Support > eBay Deletion Lookup (admin-web's `/support/ebay-account-deletion`, Channels'
//! `EbayAccountDeletionLookupPage`): an operator enters one exact eBay user ID and gets its
//! unexpired account-deletion receipts, under Production's eBay subject data counts. Read from
//! Channels' `/api/channels/staff/ebay-account-deletion` as the signed-in staff member; every
//! route needs `support.manage`, as the API's do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/ebay-account-deletion` | the lookup form and the counts |
//! | `POST /support/ebay-account-deletion` | the receipts an eBay user ID matches, with the counts |
//!
//! The user ID is posted, not put in the address, as admin-web does: it is an eBay member's
//! identifier, so it stays out of logs and history. Both answers are `no-store`, as the API's are.
use corten::{
    axum::http::{HeaderMap, HeaderValue, StatusCode, header},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::views;
use crate::{
    api::Method,
    app::{Shared, sign_in},
    auth::{Staff, SupportManage, Viewer},
    text::Sup,
};

const CONTEXT: &str = "channels";
const BASE: &str = "/api/channels/staff/ebay-account-deletion";
/// The longest user ID the API takes (admin-web's `maxLength`).
pub const MAX_USER_ID: usize = 1024;

#[corten::routes(state = crate::app::Shared, area = crate::support::ebay::url::Lookup, caller = crate::auth::Staff<crate::auth::SupportManage>)]
pub mod url {
    /// The lookup; a `POST` looks a user ID up.
    #[derive(Clone, Debug, Default)]
    #[route("/support/ebay-account-deletion", get = page, post = look_up)]
    pub struct Lookup;
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Lookup>, shared: Shared) -> Area<url::Lookup> {
    url::area(area, shared).components(views::EBAY)
}

/// Production's eBay subject data (`EbaySubjectDataCount`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Counts {
    pub connections: u64,
    pub credential_envelopes: u64,
}

/// An unexpired receipt (`EbayReceiptMatch`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub notification_id: String,
    pub event_date: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Matches {
    matches: Vec<Receipt>,
}

/// The lookup's field (admin-web's form name).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct LookupForm {
    pub user_id: String,
}

/// The page: what it shows and what a data client gets. The user ID looked up is not in it.
#[derive(Serialize, ToJson)]
pub struct EbayScreen {
    pub counts: Option<Counts>,
    /// The receipts found, once a lookup was made.
    pub matches: Option<Vec<Receipt>>,
    /// That the counts or the lookup failed (admin-web's one banner).
    pub failed: bool,
}

/// The counts, none when they could not be read; `Err` when the session has expired.
async fn counts(config: &Shared, headers: &HeaderMap) -> Result<Option<Counts>, ()> {
    let caller = config.platform.caller(headers, config.proto, None);
    match caller.read::<Counts>(&format!("{BASE}/subject-data-count"), CONTEXT).await {
        Ok(counts) => Ok(Some(counts)),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => Err(()),
        Err(error) => {
            tracing::warn!("the eBay subject data counts could not be read: {error}");
            Ok(None)
        }
    }
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let counts = match counts(&config, &headers).await {
        Ok(counts) => counts,
        Err(_) => return sign_in(&req),
    };
    let screen = EbayScreen { failed: counts.is_none(), counts, matches: None };
    draw(&req, &staff.viewer, &screen, StatusCode::OK)
}

async fn look_up(
    req: Req,
    Caller(staff): Caller<Staff<SupportManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<LookupForm>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let user_id: String = form.user_id.chars().take(MAX_USER_ID).collect();
    let request = caller.request(Method::POST, &format!("{BASE}/lookup"), CONTEXT).json(&json!({ "userId": user_id }));
    let (counts, found) = tokio::join!(counts(&config, &headers), caller.write::<Matches>(request));
    let counts = match counts {
        Ok(counts) => counts,
        Err(_) => return sign_in(&req),
    };
    let (matches, status) = match found {
        Ok((found, _)) => (Some(found.matches), StatusCode::OK),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
        Err(error) => {
            // admin-web's one banner for every failure; the cause goes to the log, not the ID.
            tracing::warn!("an eBay receipt lookup failed: {}", error.status().map_or("no answer".to_owned(), |s| s.to_string()));
            let status = match error.status() {
                Some(StatusCode::BAD_REQUEST) => StatusCode::UNPROCESSABLE_ENTITY,
                Some(StatusCode::FORBIDDEN) => StatusCode::FORBIDDEN,
                _ => StatusCode::BAD_GATEWAY,
            };
            (None, status)
        }
    };
    let screen = EbayScreen { failed: matches.is_none() || counts.is_none(), counts, matches };
    draw(&req, &staff.viewer, &screen, status)
}

fn draw(req: &Req, viewer: &Viewer, screen: &EbayScreen, status: StatusCode) -> HtmlResult {
    let t: Sup = req.t();
    let view = html! { <views::EbayPage t={t} screen={screen} /> };
    let mut answer = req.screen_with_status(
        status,
        screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ebay_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )?;
    answer.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(answer)
}
