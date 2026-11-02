//! The account's team (Identity's marketplace `account-team` route): invite someone by email with
//! a role, and each member (Change Role, then Revoke behind a dialog or Reinstate) and invitation
//! (Cancel behind a dialog while it is pending). Every rule is the API's: who may be invited, which
//! roles may be granted, that the last owner keeps the account.
//!
//! Each write is an Identity account-management attempt, as the shipping addresses' are: the
//! form's `SubmitKey` is the `Idempotency-Key`, an answer the pilot did not get is asked about at
//! once, and one the lookup cannot settle sends the page to ask again (`?check=`) with that form
//! off (see `addresses`). Every write posts to the page's own path, as marketplace's form action
//! does, and a committed one redirects to the page read after it.
//!
//! An invitation the API newly records is then emailed: the pilot asks Auth to send its acceptance
//! link after the invitation's receipt, from the browser's address, as marketplace's action does. A
//! link that cannot be asked for leaves the invitation saved and its delivery unknown, as
//! marketplace's does; an invitation the API had already recorded is never emailed again. Asked for at
//! once, the link is often refused (404) before Auth has the invitation (chase-sets/chase-sets#10795).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/team?<place>` | the page, read after the write whose receipt it carries |
//! | `POST /account/team` | invite, cancel an invitation, change a role, revoke or reinstate a member (`intent`) |
use crate::recovery::attempt_text;
use corten::{
    ClientIp,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use crate::chrome::Chrome;
use crate::{
    addresses::Said,
    api::{AccountAction, AccountAnswer, Addresses as _, ApiError, Invitation, Membership, TeamCalls as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{TeamOwner, Viewer},
    recovery::valid_attempt,
    text::{Pilot, TeamMsg},
    views::{self, Layout},
};

/// The roles an invitation or a member may be given, in Identity's order (`GRANTABLE_ROLE_KEYS`).
pub const ROLES: [&str; 4] = ["owner", "manager", "fulfillment", "viewer"];

/// How long an invitation stays open: marketplace's action sends seven days from now.
const INVITATION_DAYS: i64 = 7;

/// An instant as Identity's `isInstant` takes it: RFC 3339 to the millisecond. A finer one is
/// refused as an indeterminate attempt (503 `INDETERMINATE`), so no invitation is created: a request
/// refused while it is validated should be a 4xx refusal (chase-sets/chase-sets#10793).
fn instant(at: OffsetDateTime) -> String {
    let at = at.replace_nanosecond(u32::from(at.millisecond()) * 1_000_000).unwrap_or(at);
    at.format(&Rfc3339).unwrap_or_default()
}

/// What the page's address carries: the last write's receipt (`after_write`), the attempt that
/// answer settles (`saved`), and an attempt to ask the API about (`check`, its `action` and
/// `target`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub saved: Option<String>,
    pub check: Option<String>,
    pub action: Option<AccountAction>,
    pub target: Option<String>,
}

/// Every form's fields: which write (`intent`, marketplace's), the attempt it was drawn with, an
/// invitation's email, the role, and the member or invitation a write is for.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct TeamInput {
    pub intent: String,
    pub attempt: Option<SubmitKey>,
    pub email: String,
    pub role_key: String,
    pub membership_id: String,
    pub invitation_id: String,
}

impl TeamInput {
    /// The write `intent` names: one of the page's five.
    pub fn action(&self) -> Option<AccountAction> {
        Some(match self.intent.as_str() {
            "create-invitation" => AccountAction::CreateInvitation,
            "cancel-invitation" => AccountAction::CancelInvitation,
            "change-role" => AccountAction::ChangeRole,
            "revoke" => AccountAction::Revoke,
            "reinstate" => AccountAction::Reinstate,
            _ => return None,
        })
    }

    /// The role a form chose: marketplace sends `viewer` when none was.
    fn role(&self) -> &str {
        match self.role_key.trim() {
            "" => "viewer",
            role => role,
        }
    }
}

/// The invite form drawn again after a refusal: what was sent and what is wrong with it.
#[derive(Clone, Debug)]
pub struct Draft {
    pub input: TeamInput,
    pub errors: Errors,
}

/// The page: the account's members and invitations (as they were while the lists catch up with a
/// write), what the last write did, and a refused invite.
#[derive(Serialize, ToJson)]
pub struct TeamScreen {
    pub memberships: Vec<Membership>,
    pub invitations: Vec<Invitation>,
    pub pending: bool,
    pub said: Said,
    #[serde(skip)]
    pub posted: Option<Draft>,
}

impl TeamScreen {
    /// The invite form: a refused invite as it was sent, else empty with the role `viewer`.
    pub fn invite(&self) -> Draft {
        self.posted.clone().filter(|draft| draft.input.action() == Some(AccountAction::CreateInvitation)).unwrap_or_else(|| {
            Draft { input: TeamInput { role_key: "viewer".into(), ..TeamInput::default() }, errors: Errors::new() }
        })
    }
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(TeamOwner(viewer)): Caller<TeamOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::team::Team>,
) -> HtmlResult {
    let place = route.place;
    let said = match (&place.check, place.action) {
        (Some(attempt), Some(action)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            check(&caller, action, place.target.as_deref(), attempt).await
        }
        (Some(_), None) => Said::NotSaved,
        (None, _) if place.saved.is_some() => Said::Saved,
        (None, _) => Said::Editing,
    };
    render(&req, &viewer, &config, &headers, place.after_write.as_deref(), said, None, StatusCode::OK, &chrome).await
}

/// What the API says came of `attempt`, for the page.
async fn check(caller: &crate::api::Caller<'_>, action: AccountAction, target: Option<&str>, attempt: &str) -> Said {
    let unconfirmed = || Said::Unconfirmed { attempt: attempt.to_owned(), action, target: target.map(str::to_owned) };
    if !valid_attempt(attempt) {
        return Said::NotSaved;
    }
    match caller.account_attempt(action, target, attempt).await {
        Ok(AccountAnswer::Committed(_)) => Said::Saved,
        Ok(AccountAnswer::NotRecorded { .. }) => Said::NotSaved,
        Ok(AccountAnswer::Conflict) => Said::Conflict,
        Ok(AccountAnswer::Indeterminate) => unconfirmed(),
        Err(error) => {
            tracing::warn!("the team attempt check failed: {error}");
            unconfirmed()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    after_write: Option<&str>,
    said: Said,
    posted: Option<Draft>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write);
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let account = viewer.actor.account_id.as_str();
    let ((memberships, invitations), pending) = match caller.team(account).await {
        Ok(team) => (team, false),
        // The write's projection is not readable yet: the team as it was, marked as updating.
        Err(error) if receipt.is_some() && error.catching_up() => {
            let plain = config.platform.caller(headers, config.proto, None);
            match plain.team(account).await {
                Ok(team) => (team, true),
                Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
            }
        }
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let screen = TeamScreen { memberships, invitations, pending, said, posted };
    let t: TeamMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::TeamPage t={t} p={req.t()} screen={&screen} /> };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_title()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// A write.
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    Caller(TeamOwner(viewer)): Caller<TeamOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Form(input): Form<TeamInput>,
) -> HtmlResult {
    let (t, p): (TeamMsg, Pilot) = (req.t(), req.t());
    let (req, viewer, config, headers) = (&req, &viewer, &config, &headers);
    let action = input.action();
    let attempt = attempt_text(&input.attempt).to_owned();
    let refuse = |message: &'static str| {
        let mut errors = Errors::new();
        errors.add_form(message);
        // Only the invite form is drawn again; any other refusal is the page's banner, with its words.
        let said = if action == Some(AccountAction::CreateInvitation) { Said::Editing } else { Said::NotSaved };
        let posted = Some(Draft { input: input.clone(), errors });
        render(req, viewer, config, headers, None, said, posted, StatusCode::UNPROCESSABLE_ENTITY, &chrome)
    };
    let Some(action) = action else { return refuse(t.manage_state_failed_safe()).await };
    if !valid_attempt(&attempt) {
        return refuse(p.check_attempt()).await;
    }
    let account = viewer.actor.account_id.as_str();
    let (target, body) = match action {
        AccountAction::CreateInvitation => {
            let expires = instant(OffsetDateTime::now_utc() + Duration::days(INVITATION_DAYS));
            // A new invitation id for each send: the API keeps the attempt's first one.
            let invitation = format!("ivt_{}", uuid::Uuid::new_v4().simple());
            let body = json!({
                "invitationId": invitation,
                "accountId": account,
                "email": input.email,
                "roleKey": input.role(),
                "expiresAt": expires,
            });
            (None, body)
        }
        AccountAction::CancelInvitation => match input.invitation_id.trim() {
            "" => return refuse(t.manage_state_failed_safe()).await,
            id => (Some(id.to_owned()), json!({})),
        },
        _ => match input.membership_id.trim() {
            "" => return refuse(t.manage_state_failed_safe()).await,
            id if action == AccountAction::ChangeRole => (Some(id.to_owned()), json!({ "roleKey": input.role() })),
            id => (Some(id.to_owned()), json!({})),
        },
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let (answer, invited) = match caller.write_team(action, target.as_deref(), &attempt, &body).await {
        Ok(sent) => sent,
        Err(ApiError::Transport(error)) => {
            tracing::warn!("a team write had no answer: {error}");
            (AccountAnswer::Indeterminate, None)
        }
        Err(error) => return failed(req, viewer, config, headers, error, &chrome).await,
    };
    // No answer that says what happened: ask what came of the attempt, as marketplace does. A
    // create found this way is not emailed: the lookup cannot say whether this call recorded it.
    let answer = match answer {
        AccountAnswer::Indeterminate => match caller.account_attempt(action, target.as_deref(), &attempt).await {
            Ok(AccountAnswer::Indeterminate) | Err(_) => {
                let place = Place { check: Some(attempt), action: Some(action), target, ..Place::default() };
                return req.redirect(&url::Team { place });
            }
            Ok(asked) => asked,
        },
        answer => answer,
    };
    match answer {
        AccountAnswer::Committed(after_write) => {
            if let Some(invited) = invited.filter(|i| i.newly) {
                let receipt = Receipt::from_param(after_write.as_deref());
                let after = config.platform.caller(headers, config.proto, receipt.as_ref());
                if let Err(error) = after.invitation_link(&invited.invitation_id, client).await {
                    tracing::warn!("an invitation's acceptance link could not be asked for: {error}");
                }
            }
            let place = Place { after_write, saved: Some(attempt), ..Place::default() };
            req.redirect(&url::Team { place })
        }
        AccountAnswer::NotRecorded { code, .. } if code == "validation-failed" => refuse(t.action_validation()).await,
        AccountAnswer::NotRecorded { .. } => refuse(t.manage_state_failed_safe()).await,
        AccountAnswer::Conflict => {
            render(req, viewer, config, headers, None, Said::Conflict, None, StatusCode::CONFLICT, &chrome).await
        }
        AccountAnswer::Indeterminate => unreachable!("asked about above"),
    }
}

/// A write the API refused for who is asking: sign in again, or the page saying they may not. Any
/// other refusal (the last owner, a role that may not be granted) is a rule the API keeps, and the
/// page says nothing was recorded.
async fn failed(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    error: ApiError,
    chrome: &Chrome,
) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => {
            render(req, viewer, config, headers, None, Said::Denied, None, StatusCode::FORBIDDEN, chrome).await
        }
        Some(status) if status.is_client_error() => {
            render(req, viewer, config, headers, None, Said::NotSaved, None, StatusCode::UNPROCESSABLE_ENTITY, chrome).await
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invitations_expiry_is_to_the_millisecond_as_identity_takes_it() {
        let at = OffsetDateTime::from_unix_timestamp_nanos(1_793_305_000_123_456_789).unwrap();
        assert_eq!(instant(at), "2026-10-29T20:16:40.123Z");
        let whole = OffsetDateTime::from_unix_timestamp(1_793_305_000).unwrap();
        assert_eq!(instant(whole), "2026-10-29T20:16:40Z");
    }

    #[test]
    fn the_intent_names_one_of_the_pages_writes_and_the_role_is_viewer_unless_chosen() {
        let with = |intent: &str| TeamInput { intent: intent.into(), ..TeamInput::default() };
        assert_eq!(with("create-invitation").action(), Some(AccountAction::CreateInvitation));
        assert_eq!(with("cancel-invitation").action(), Some(AccountAction::CancelInvitation));
        assert_eq!(with("change-role").action(), Some(AccountAction::ChangeRole));
        assert_eq!(with("revoke").action(), Some(AccountAction::Revoke));
        assert_eq!(with("reinstate").action(), Some(AccountAction::Reinstate));
        assert_eq!(with("revoke-api-key").action(), None, "a security write is not this page's");
        assert_eq!(with("").role(), "viewer");
        assert_eq!(TeamInput { role_key: " manager ".into(), ..TeamInput::default() }.role(), "manager");
    }
}
