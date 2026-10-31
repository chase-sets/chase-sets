//! The user's security page (Identity's marketplace `account-security` route): the user's names
//! with Update Profile, Create API Key, the account protection metrics, the security signals and
//! each key with Rotate and Revoke. Every rule is the API's.
//!
//! Each write is an Identity account-management attempt, as the shipping addresses' are: the
//! form's `SubmitKey` is the `Idempotency-Key`, an answer the pilot did not get is asked about at
//! once, and one the lookup cannot settle sends the page to ask again (`?check=`) with that form
//! off (see `addresses`).
//!
//! A create or rotate answers with the key's secret, once: the API keeps only its hash and its
//! attempt lookup never returns it. So the page answers that POST itself, with the secret and
//! `Cache-Control: no-store`, instead of redirecting to an address that would carry it. Every
//! write posts to the page's own path, as marketplace's form action does, so a reload sends the
//! same attempt again, which the API answers as already recorded, and the page says the secret
//! cannot be shown again (`committed-secret-unrecoverable`). A profile update or a revoke
//! redirects to the page read after the write, as marketplace's `navigateAfterWrite`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/security?<place>` | the page, read after the write whose receipt it carries |
//! | `POST /account/security` | update the user's names, or create, rotate or revoke a key (`intent`) |
use corten::{
    NoStore,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    addresses::Said,
    api::{AccountAction, AccountAnswer, ApiError, ApiKey, KeySecret, SecurityCalls as _, SecurityUser, UserCommand},
    app::{Shared, read_failed, sign_in, url},
    auth::{SecurityOwner, Viewer},
    recovery::valid_attempt,
    text::{Pilot, SecurityMsg},
    views::{self, Layout},
};

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

/// Every form's fields: which write (`intent`, marketplace's), the attempt it was drawn with, the
/// user's names, a new key's name and purpose, and the key a rotate or revoke is for.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct SecurityInput {
    pub intent: String,
    pub attempt: String,
    pub display_name: String,
    pub given_name: String,
    pub family_name: String,
    pub name: String,
    pub purpose: String,
    pub api_key_id: String,
}

impl SecurityInput {
    pub fn of(user: &SecurityUser) -> Self {
        SecurityInput {
            display_name: user.display_name.clone(),
            given_name: user.given_name.clone(),
            family_name: user.family_name.clone(),
            ..SecurityInput::default()
        }
    }

    /// The write `intent` names: one of the page's four.
    pub fn action(&self) -> Option<AccountAction> {
        Some(match self.intent.as_str() {
            "update-user" => AccountAction::UpdateUser,
            "create-api-key" => AccountAction::CreateApiKey,
            "rotate-api-key" => AccountAction::RotateApiKey,
            "revoke-api-key" => AccountAction::RevokeApiKey,
            _ => return None,
        })
    }

    /// The body marketplace sends for the names: the text as it was typed.
    pub fn user_command(&self) -> UserCommand {
        UserCommand {
            display_name: self.display_name.clone(),
            given_name: self.given_name.clone(),
            family_name: self.family_name.clone(),
        }
    }
}

/// The form a refused write draws again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Profile,
    Key,
}

/// A refused form, drawn again: what was sent and what is wrong with it.
#[derive(Clone, Debug)]
pub struct Draft {
    pub which: Which,
    pub input: SecurityInput,
    pub errors: Errors,
}

/// The page: the user and its keys (as they were while the list catches up with a write), what
/// the last write did, a secret it issued (once), and a refused form.
#[derive(Serialize, ToJson)]
pub struct SecurityScreen {
    pub user: SecurityUser,
    pub keys: Vec<ApiKey>,
    pub pending: bool,
    pub said: Said,
    /// The write the secret is from: a create or a rotate.
    pub issued_by: Option<AccountAction>,
    pub secret: KeySecret,
    #[serde(skip)]
    pub posted: Option<Draft>,
}

impl SecurityScreen {
    /// The form `which` draws: a refused one as it was sent, else the user's names (or nothing).
    pub fn draft(&self, which: Which) -> Draft {
        match &self.posted {
            Some(draft) if draft.which == which => draft.clone(),
            _ => {
                let input = if which == Which::Profile { SecurityInput::of(&self.user) } else { SecurityInput::default() };
                Draft { which, input, errors: Errors::new() }
            }
        }
    }
}

pub(crate) async fn page(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::security::Security>,
) -> HtmlResult {
    let place = route.place;
    let (said, secret) = match (&place.check, place.action) {
        (Some(attempt), Some(action)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            check(&caller, action, place.target.as_deref(), attempt).await
        }
        (Some(_), None) => (Said::NotSaved, KeySecret::None),
        (None, _) if place.saved.is_some() => (Said::Saved, KeySecret::None),
        (None, _) => (Said::Editing, KeySecret::None),
    };
    let shown = Shown { said, secret, issued_by: place.action };
    render(&req, &viewer, &config, &headers, place.after_write.as_deref(), shown, None, StatusCode::OK).await
}

/// What the API says came of `attempt`, for the page: a create or rotate it recorded says its
/// secret cannot be shown.
async fn check(caller: &crate::api::Caller<'_>, action: AccountAction, target: Option<&str>, attempt: &str) -> (Said, KeySecret) {
    let unconfirmed = || Said::Unconfirmed { attempt: attempt.to_owned(), action, target: target.map(str::to_owned) };
    if !valid_attempt(attempt) {
        return (Said::NotSaved, KeySecret::None);
    }
    match caller.security_attempt(action, target, attempt).await {
        Ok((AccountAnswer::Committed(_), secret)) => (Said::Saved, secret),
        Ok((AccountAnswer::NotRecorded { .. }, _)) => (Said::NotSaved, KeySecret::None),
        Ok((AccountAnswer::Conflict, _)) => (Said::Conflict, KeySecret::None),
        Ok((AccountAnswer::Indeterminate, _)) => (unconfirmed(), KeySecret::None),
        Err(error) => {
            tracing::warn!("the security attempt check failed: {error}");
            (unconfirmed(), KeySecret::None)
        }
    }
}

/// What the page says about the last write: the state, and a secret it issued or lost.
struct Shown {
    said: Said,
    secret: KeySecret,
    issued_by: Option<AccountAction>,
}

impl Shown {
    fn said(said: Said) -> Self {
        Shown { said, secret: KeySecret::None, issued_by: None }
    }
}

/// The user and its keys, read after `receipt`; `None` when either has not caught up with it.
async fn read(caller: &crate::api::Caller<'_>, user: &str) -> Result<(SecurityUser, Vec<ApiKey>), ApiError> {
    let (found, keys) = tokio::join!(caller.user(user), caller.api_keys(user));
    Ok((found?, keys?))
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    after_write: Option<&str>,
    shown: Shown,
    posted: Option<Draft>,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write);
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let id = viewer.actor.user_id.as_str();
    let ((user, keys), pending) = match read(&caller, id).await {
        Ok(read) => (read, false),
        // The write's projection is not readable yet: the page as it was, marked as updating.
        Err(error) if receipt.is_some() && error.catching_up() => {
            let plain = config.platform.caller(headers, config.proto, None);
            match read(&plain, id).await {
                Ok(read) => (read, true),
                Err(error) => return read_failed(req, Some(viewer), error, None),
            }
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let Shown { said, secret, issued_by } = shown;
    let issued_by = issued_by.filter(|_| matches!(secret, KeySecret::Issued { .. }));
    let screen = SecurityScreen { user, keys, pending, said, issued_by, secret, posted };
    let t: SecurityMsg = req.t();
    // Reading the page again would lose a secret it shows: then the page says to reload instead.
    let again = pending && !matches!(screen.secret, KeySecret::Issued { .. });
    let head = html! {
        if again {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::SecurityPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_title()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// A write. Nothing may keep its answer: a create's or rotate's carries the key's secret.
pub(crate) async fn write(
    req: Req,
    Caller(SecurityOwner(viewer)): Caller<SecurityOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<SecurityInput>,
) -> NoStore<HtmlResult> {
    NoStore(send(&req, &viewer, &config, &headers, input).await)
}

async fn send(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, input: SecurityInput) -> HtmlResult {
    let (t, p): (SecurityMsg, Pilot) = (req.t(), req.t());
    let action = input.action();
    let which = match action {
        Some(AccountAction::UpdateUser) => Some(Which::Profile),
        Some(AccountAction::CreateApiKey) => Some(Which::Key),
        _ => None,
    };
    let attempt = input.attempt.clone();
    let refuse = |message: &'static str| {
        let mut errors = Errors::new();
        errors.add_form(message);
        let posted = which.map(|which| Draft { which, input: input.clone(), errors });
        let said = if posted.is_some() { Said::Editing } else { Said::NotSaved };
        render(req, viewer, config, headers, None, Shown::said(said), posted, StatusCode::UNPROCESSABLE_ENTITY)
    };
    let Some(action) = action else { return refuse(t.manage_state_failed_safe()).await };
    if !valid_attempt(&attempt) {
        return refuse(p.check_attempt()).await;
    }
    let user = viewer.actor.user_id.as_str();
    let target = match action {
        AccountAction::UpdateUser => Some(user.to_owned()),
        AccountAction::CreateApiKey => None,
        _ => match input.api_key_id.trim() {
            "" => return refuse(t.manage_state_failed_safe()).await,
            key => Some(key.to_owned()),
        },
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let sent = match action {
        AccountAction::UpdateUser => {
            caller.update_user(user, &attempt, &input.user_command()).await.map(|answer| (answer, KeySecret::None))
        }
        _ => {
            let name = (action == AccountAction::CreateApiKey).then_some(input.name.as_str());
            caller.write_key(user, action, target.as_deref(), &attempt, name).await
        }
    };
    let (answer, secret) = match sent {
        Ok(sent) => sent,
        Err(ApiError::Transport(error)) => {
            tracing::warn!("a security write had no answer: {error}");
            (AccountAnswer::Indeterminate, KeySecret::None)
        }
        Err(error) => return failed(req, viewer, config, headers, error).await,
    };
    // No answer that says what happened: ask what came of the attempt, as marketplace does.
    let (answer, secret) = match answer {
        AccountAnswer::Indeterminate => match caller.security_attempt(action, target.as_deref(), &attempt).await {
            Ok((AccountAnswer::Indeterminate, _)) | Err(_) => {
                let place = Place { check: Some(attempt), action: Some(action), target, ..Place::default() };
                return req.redirect(&url::Security { place });
            }
            Ok(asked) => asked,
        },
        answer => (answer, secret),
    };
    match answer {
        AccountAnswer::Committed(after_write) => match secret {
            KeySecret::None => {
                let place = Place { after_write, saved: Some(attempt), ..Place::default() };
                req.redirect(&url::Security { place })
            }
            // The secret, or that it is lost: this answer is the only place either is said.
            secret => {
                let shown = Shown { said: Said::Saved, secret, issued_by: Some(action) };
                render(req, viewer, config, headers, after_write.as_deref(), shown, None, StatusCode::OK).await
            }
        },
        AccountAnswer::NotRecorded { code, .. } if code == "validation-failed" => refuse(t.action_validation()).await,
        AccountAnswer::NotRecorded { .. } => refuse(t.manage_state_failed_safe()).await,
        AccountAnswer::Conflict => {
            render(req, viewer, config, headers, None, Shown::said(Said::Conflict), None, StatusCode::CONFLICT).await
        }
        AccountAnswer::Indeterminate => unreachable!("asked about above"),
    }
}

/// A write the API refused for who is asking: sign in again, or the page saying they may not.
async fn failed(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => {
            render(req, viewer, config, headers, None, Shown::said(Said::Denied), None, StatusCode::FORBIDDEN).await
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intent_names_one_of_the_pages_writes() {
        let with = |intent: &str| SecurityInput { intent: intent.into(), ..SecurityInput::default() }.action();
        assert_eq!(with("update-user"), Some(AccountAction::UpdateUser));
        assert_eq!(with("create-api-key"), Some(AccountAction::CreateApiKey));
        assert_eq!(with("rotate-api-key"), Some(AccountAction::RotateApiKey));
        assert_eq!(with("revoke-api-key"), Some(AccountAction::RevokeApiKey));
        assert_eq!(with("archive"), None, "an address write is not this page's");
        assert_eq!(with(""), None);
    }
}
