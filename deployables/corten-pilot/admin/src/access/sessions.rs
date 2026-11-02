//! Access > Sessions (admin-web's `/access/sessions`, Auth's `SessionListPage` and
//! `SessionDetailPage`): the sessions, with their search and status filters, and a session's page,
//! where an active one switches its account or is revoked. Read from and written to the Auth API
//! (`/api/auth/sessions`) as the signed-in staff member; the nav entry needs `security.manage`,
//! and the API decides who may change a session (`canManageSession`).
//!
//! A form posts an `intent` to the page, as admin-web's do; an intent the page does not have goes
//! back to the page (admin-web's `onUnknownIntent`). A write goes back to the page read after its
//! receipt, and a refusal (4xx) is the page with the API's words.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Read, api::List, people, views};
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{SecurityManage, Staff, Viewer},
    text::Acc,
};

pub const CONTEXT: &str = "auth";

/// The statuses the list filters by (`AUTH_SESSION_STATUSES`).
pub const SESSION_STATUSES: &[&str] = &["active", "revoked", "expired"];

/// A session (Auth's `Session`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Session {
    pub session_id: String,
    pub user_id: String,
    #[serde(default)]
    pub user_display_name: Option<String>,
    #[serde(default)]
    pub user_primary_email: Option<String>,
    pub account_id: String,
    #[serde(default)]
    pub account_display_name: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub available_account_ids: Vec<String>,
    pub authentication_method: String,
    pub status: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

impl Session {
    /// The user's display name, else their email, else their id (`??`: an empty name is kept).
    pub fn user_label(&self) -> &str {
        self.user_display_name.as_deref().or(self.user_primary_email.as_deref()).unwrap_or(&self.user_id)
    }

    /// The account's display name, else its name, else its id.
    pub fn account_label(&self) -> &str {
        self.account_display_name.as_deref().or(self.account_name.as_deref()).unwrap_or(&self.account_id)
    }
}

/// `sessionStatusLabel`: a known status's words, else Auth's unrecognized ones.
pub fn status(t: Acc, value: &str) -> String {
    let known = match value {
        "active" => Some(t.sessions_status_filter_active()),
        "revoked" => Some(t.sessions_status_filter_revoked()),
        "expired" => Some(t.sessions_status_filter_expired()),
        _ => None,
    };
    let family = t.auth_value_family_session_status();
    match (known, super::humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.auth_value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.auth_value_unrecognized(family).to_string(),
    }
}

/// A moment as `formatDateTime` writes it, else Auth's unavailable words.
pub fn when(t: Acc, at: Option<&str>) -> String {
    at.and_then(parse_timestamp).map_or_else(
        || t.auth_value_date_unavailable().to_owned(),
        |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
    )
}

async fn read(caller: &ApiCaller<'_>, id: &str) -> Result<Session, ApiError> {
    caller.read(&format!("/api/auth/sessions/{}", segment(id)), CONTEXT).await
}

/// The list's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct SessionsScreen {
    pub list: List<Session>,
}

pub(crate) async fn list(
    req: Req,
    Caller(staff): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<people::Sessions>,
) -> HtmlResult {
    let read = Read::of(&route.query, SESSION_STATUSES);
    let caller = config.platform.caller(&headers, config.proto, None);
    let screen = match caller.read(&format!("/api/auth/sessions?{}", read.api_query()), CONTEXT).await {
        Ok(list) => SessionsScreen { list },
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Acc = req.t();
    let view = views::sessions(t, req.t(), &read, &screen.list);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.route_sessions()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// A session's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct SessionScreen {
    pub session: Session,
    /// Why the last form was refused.
    pub refusal: Option<String>,
    /// Whether the page was read without the write it follows, which is not readable yet.
    pub catching_up: bool,
}

/// The page's forms: their intent and the account a switch picks.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionForm {
    pub intent: String,
    pub account_id: String,
}

pub(crate) async fn page(
    req: Req,
    Caller(staff): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<people::SessionPage<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    draw(&req, &staff.viewer, &config, &headers, &route.id, receipt, None, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<Receipt>,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let mut catching_up = false;
    let session = match read(&caller, id).await {
        Ok(session) => session,
        // The write is not readable yet: the page is read without it and says so, as an account's
        // workspace does (chase-sets/chase-sets#10828: Auth's session projection applies a write
        // 4 to 6 s after it, past the receipt wait; drop the note when it is fixed).
        Err(error) if receipt.is_some() && error.catching_up() => {
            catching_up = true;
            match read(&config.platform.caller(headers, config.proto, None), id).await {
                Ok(session) => session,
                Err(error) => return read_failed(req, error, false),
            }
        }
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = SessionScreen { session, refusal, catching_up };
    let t: Acc = req.t();
    let view = html! { <views::SessionPage t={t} p={req.t()} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_session()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

pub(crate) async fn write(
    req: Req,
    Caller(staff): Caller<Staff<SecurityManage>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<people::SessionPage<'_>>,
    Form(form): Form<SessionForm>,
) -> HtmlResult {
    let id = route.id.as_str();
    let page = |after_write: Option<String>| people::SessionPage { id, after_write };
    let (rest, body) = match form.intent.as_str() {
        "switch-account" if !form.account_id.trim().is_empty() => {
            ("switch-account", json!({ "accountId": form.account_id.trim() }))
        }
        "revoke" => ("revoke", json!({})),
        _ => return req.redirect(&page(None)),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let path = format!("/api/auth/sessions/{}/{rest}", segment(id));
    match caller.write::<serde_json::Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((_, receipt)) => req.redirect(&page(receipt.as_ref().map(Receipt::param))),
        Err(error) => {
            let status = match error.status() {
                Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
                Some(status) if status.is_client_error() => status,
                _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            };
            let p: crate::text::Pilot = req.t();
            let refusal = Some(error.refusal().unwrap_or(p.access_refused()).to_owned());
            let status = match status {
                StatusCode::CONFLICT | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => status,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            draw(&req, &staff.viewer, &config, &headers, id, None, refusal, status).await
        }
    }
}
