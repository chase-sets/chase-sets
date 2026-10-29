//! The signed-in user's sessions (Auth's marketplace `account-sessions` and
//! `account-sessions-detail` routes): the list, a session's page, and its two writes, Switch
//! Account and Revoke. Every rule is the API's.
//!
//! Auth requires `security.manage` for every session call, so every handler takes a
//! `SecurityOwner`; marketplace's routes ask only for a signed-in user and let the API refuse.
//! The list sends its status filter and page to the API, which marketplace's loader does not
//! (chase-sets/chase-sets#10699), and has no Search: for a user, Auth replaces it with the user's id.
//!
//! Neither write is an attempt (Auth takes no `Idempotency-Key` for them) and Auth answers every
//! refusal with a 500 (chase-sets/chase-sets#10698). So after a write that did not succeed the page
//! reads the session again and says what it finds: no longer active, already on that account, or
//! unchanged. Switch Account offers only the session's other accounts, and is not drawn when there
//! are none (marketplace's always offers the current one, which Auth refuses).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/sessions?<filters>` | a page of the user's sessions |
//! | `GET /account/sessions/{id}?<place>` | a session, read after the write whose receipt it carries |
//! | `POST /account/sessions/{id}/revoke` | sign the session out |
//! | `POST /account/sessions/{id}/switch` | make it act for another of its accounts |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{ApiError, SessionCalls as _, SessionRecord, SessionWrite},
    app::{Shared, read_failed, sign_in, url},
    auth::{SecurityOwner, Viewer},
    text::SessionsMsg,
    views::{self, Layout},
};

/// A page's length when the address names none (marketplace's loader asks for 50), and the most.
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 250;

/// The statuses the filter offers (`AUTH_SESSION_STATUSES`).
pub const STATUSES: [&str; 3] = ["active", "revoked", "expired"];

/// What the list's address asks for: a status (`all` or none for every one), and the page.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Filters {
    pub status: Option<String>,
    pub limit: Option<String>,
    pub offset: Option<String>,
}

impl Filters {
    /// The status to list, when it is one Auth knows (`readSessionListFilters`).
    pub fn status(&self) -> Option<&str> {
        self.status.as_deref().map(str::trim).filter(|s| STATUSES.contains(s))
    }

    pub fn limit(&self) -> u32 {
        match self.limit.as_deref().and_then(|l| l.trim().parse::<f64>().ok()) {
            Some(l) if l.is_finite() && l != 0.0 => l.clamp(1.0, MAX_LIMIT as f64) as u32,
            _ => DEFAULT_LIMIT,
        }
    }

    pub fn offset(&self) -> u32 {
        match self.offset.as_deref().and_then(|o| o.trim().parse::<f64>().ok()) {
            Some(o) if o.is_finite() => o.clamp(0.0, u32::MAX as f64) as u32,
            _ => 0,
        }
    }
}

/// The list: a page of the user's sessions.
#[derive(Serialize, ToJson)]
pub struct ListScreen {
    pub sessions: Vec<SessionRecord>,
    pub status: Option<String>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

impl ListScreen {
    /// The page shown (from 1) and how many there are (at least 1).
    pub fn page(&self) -> (u64, u64) {
        let size = self.limit.max(1);
        (self.offset / size + 1, self.total.div_ceil(size).max(1))
    }

    pub fn paged(&self) -> bool {
        self.total > self.limit || self.offset > 0
    }

    /// The list's page `page` (from 1), with the same status.
    pub fn page_href(&self, page: u64) -> String {
        let size = self.limit.max(1);
        let filters = Filters {
            status: self.status.clone(),
            limit: Some(size.to_string()),
            offset: Some((page.saturating_sub(1) * size).to_string()),
        };
        url::Sessions { filters }.href()
    }
}

/// What came of the last write, in the session page's address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Said {
    /// Auth signed it out.
    Revoked,
    /// It now acts for the account chosen.
    Switched,
    /// A write found it no longer active.
    NotActive,
    /// A switch Auth did not make: it acts for the account it did.
    SwitchRefused,
    /// A write whose result is not known; the session as it is now.
    Failed,
}

/// What a session's address carries: the last write's receipt, and what came of it.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub said: Option<Said>,
}

/// A session's page: the session (as it was while it catches up with a write) and what the last
/// write did.
#[derive(Serialize, ToJson)]
pub struct SessionScreen {
    pub session: SessionRecord,
    pub said: Option<Said>,
    pub pending: bool,
}

/// Switch Account's field.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct SwitchInput {
    pub account_id: String,
}

pub(crate) async fn list(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sessions::Sessions>,
) -> HtmlResult {
    let filters = route.filters;
    let caller = config.platform.caller(&headers, config.proto, None);
    let (limit, offset, status) = (filters.limit(), filters.offset(), filters.status());
    let (sessions, total) = match caller.sessions(&viewer.actor.user_id, status, limit, offset).await {
        Ok(found) => found,
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let screen = ListScreen { sessions, status: status.map(str::to_owned), total, limit: limit.into(), offset: offset.into() };
    let t: SessionsMsg = req.t();
    let view = html! { <views::SessionsPage t={t} p={req.t()} screen={&screen} /> };
    req.screen(&screen, html! { <Layout req={&req} viewer={Some(&viewer)} title={t.list_sessions()} head={()}>{view}</Layout> })
}

pub(crate) async fn page(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sessions::SessionPage<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let (session, pending) = match caller.session(&id).await {
        Ok(session) => (session, false),
        // The write's projection is not readable yet: the session as it was, marked as updating.
        Err(error) if receipt.is_some() && error.catching_up() => {
            let plain = config.platform.caller(&headers, config.proto, None);
            match plain.session(&id).await {
                Ok(session) => (session, true),
                Err(error) => return failed_read(&req, &viewer, error),
            }
        }
        Err(error) => return failed_read(&req, &viewer, error),
    };
    let screen = SessionScreen { session, said: place.said, pending };
    let t: SessionsMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::SessionPage t={t} p={req.t()} screen={&screen} /> };
    req.screen(&screen, html! { <Layout req={&req} viewer={Some(&viewer)} title={t.list_session()} head={head}>{view}</Layout> })
}

/// A session Auth does not have is not found; one that is not the user's, forbidden.
fn failed_read(req: &Req, viewer: &Viewer, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::NOT_FOUND) => Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
        _ => read_failed(req, Some(viewer), error, None),
    }
}

pub(crate) async fn revoke(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sessions::SessionRevoke<'_>>,
) -> HtmlResult {
    let id = route.id;
    write(&req, &viewer, &config, &headers, &id, SessionWrite::Revoke).await
}

pub(crate) async fn switch(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sessions::SessionSwitch<'_>>,
    Form(input): Form<SwitchInput>,
) -> HtmlResult {
    let id = route.id;
    let account = input.account_id.trim();
    write(&req, &viewer, &config, &headers, &id, SessionWrite::Switch(account)).await
}

async fn write(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    write: SessionWrite<'_>,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let to = |after_write: Option<String>, said: Said| {
        req.redirect(&url::SessionPage { id, place: Place { after_write, said: Some(said) } })
    };
    let done = match write {
        SessionWrite::Revoke => Said::Revoked,
        SessionWrite::Switch(_) => Said::Switched,
    };
    match caller.session_write(id, write).await {
        Ok(after_write) => return to(after_write, done),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
            Some(StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) => return failed_read(req, viewer, error),
            // A refusal, a failure, or no answer: Auth answers them alike.
            _ => tracing::warn!("a session write did not succeed: {error}"),
        },
    }
    let said = match (caller.session(id).await, write) {
        (Ok(now), SessionWrite::Revoke) if now.status != "active" => Said::NotActive,
        (Ok(now), SessionWrite::Switch(account)) if now.account_id == account && now.status == "active" => Said::Switched,
        (Ok(now), SessionWrite::Switch(_)) if now.status != "active" => Said::NotActive,
        (Ok(_), SessionWrite::Switch(_)) => Said::SwitchRefused,
        (Ok(_), SessionWrite::Revoke) => Said::Failed,
        (Err(error), _) => return failed_read(req, viewer, error),
    };
    to(None, said)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filters_are_auths() {
        let with = |status: &str, limit: &str, offset: &str| Filters {
            status: Some(status.into()),
            limit: Some(limit.into()),
            offset: Some(offset.into()),
        };
        let f = with(" active ", "10", "20");
        assert_eq!((f.status(), f.limit(), f.offset()), (Some("active"), 10, 20));
        let f = with("all", "0", "-5");
        assert_eq!((f.status(), f.limit(), f.offset()), (None, DEFAULT_LIMIT, 0), "all, and a zero or negative page");
        assert_eq!(with("pending", "900", "x").status(), None, "a status Auth does not know is every status");
        assert_eq!(with("pending", "900", "x").limit(), MAX_LIMIT);
        assert_eq!(Filters::default().limit(), 50);
    }

    #[test]
    fn a_session_is_named_as_marketplace_names_it_and_offers_only_its_other_accounts() {
        let mut s = SessionRecord {
            user_id: "usr_1".into(),
            account_id: "acc_1".into(),
            available_account_ids: vec!["acc_1".into(), "acc_2".into()],
            ..SessionRecord::default()
        };
        assert_eq!((s.user(), s.account()), ("usr_1", "acc_1"));
        s.user_primary_email = Some("a@chasesets.test".into());
        s.account_name = Some("Legal".into());
        assert_eq!((s.user(), s.account()), ("a@chasesets.test", "Legal"));
        s.user_display_name = Some("Ada".into());
        s.account_display_name = Some("Shop".into());
        assert_eq!((s.user(), s.account()), ("Ada", "Shop"));
        assert_eq!(s.others().collect::<Vec<_>>(), ["acc_2"]);
    }
}
