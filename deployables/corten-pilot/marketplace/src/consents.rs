//! The user's consent history (Identity's marketplace `account-consents` route): each agreement
//! the user or its account gave, newest first, with when it was recorded and withdrawn, and
//! Withdraw (behind a dialog that asks first) on a current, recorded one. Every rule is the API's:
//! which consents the user sees, who may withdraw one, that only the current one may be withdrawn.
//!
//! Withdraw is an Identity account-management attempt, as the shipping addresses' writes are: the
//! form's `SubmitKey` is the `Idempotency-Key`, an answer the pilot did not get is asked about at
//! once, and one the lookup cannot settle sends the page to ask again (`?check=`) with that
//! consent's Withdraw off (see `addresses`). It posts to the page's own path, as marketplace's form
//! action does, and a committed one redirects to the page read after it.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/consents?<place>` | the page, read after the withdrawal whose receipt it carries |
//! | `POST /account/consents` | withdraw a consent (`intent=withdraw`) |
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    addresses::Said,
    api::{AccountAction, AccountAnswer, Addresses as _, ApiError, Consent, ConsentCalls as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{ConsentHolder, Viewer},
    recovery::valid_attempt,
    text::{ConsentsMsg, Pilot},
    views::{self, Layout},
};

/// What the page's address carries: the last withdrawal's receipt (`after_write`), the attempt
/// that answer settles (`saved`), and an attempt to ask the API about (`check`, the consent it
/// was for in `target`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub saved: Option<String>,
    pub check: Option<String>,
    pub target: Option<String>,
}

/// Withdraw's fields: the write (`intent`, marketplace's), the attempt it was drawn with, and the
/// consent.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ConsentInput {
    pub intent: String,
    pub attempt: String,
    pub consent_id: String,
}

/// The page: the user's consents (as they were while the history catches up with a withdrawal),
/// what the last one did, and a refusal's own words.
#[derive(Serialize, ToJson)]
pub struct ConsentsScreen {
    pub consents: Vec<Consent>,
    pub pending: bool,
    pub said: Said,
    #[serde(skip)]
    pub refused: Option<&'static str>,
}

pub(crate) async fn page(
    req: Req,
    Caller(ConsentHolder(viewer)): Caller<ConsentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::consents::Consents>,
) -> HtmlResult {
    let place = route.place;
    let said = match &place.check {
        Some(attempt) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            check(&caller, place.target.as_deref(), attempt).await
        }
        None if place.saved.is_some() => Said::Saved,
        None => Said::Editing,
    };
    render(&req, &viewer, &config, &headers, place.after_write.as_deref(), said, None, StatusCode::OK).await
}

/// What the API says came of the withdrawal `attempt` of `target`, for the page.
async fn check(caller: &crate::api::Caller<'_>, target: Option<&str>, attempt: &str) -> Said {
    let action = AccountAction::Withdraw;
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
            tracing::warn!("the consent attempt check failed: {error}");
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
    refused: Option<&'static str>,
    status: StatusCode,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write);
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let (user, account) = (viewer.actor.user_id.as_str(), viewer.actor.account_id.as_str());
    let (consents, pending) = match caller.consents(user, account).await {
        Ok(consents) => (consents, false),
        // The withdrawal's projection is not readable yet: the history as it was, marked as updating.
        Err(error) if receipt.is_some() && error.catching_up() => {
            let plain = config.platform.caller(headers, config.proto, None);
            match plain.consents(user, account).await {
                Ok(consents) => (consents, true),
                Err(error) => return read_failed(req, Some(viewer), error, None),
            }
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let screen = ConsentsScreen { consents, pending, said, refused };
    let t: ConsentsMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::ConsentsPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_consents_marketplace()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// Withdraw.
pub(crate) async fn write(
    req: Req,
    Caller(ConsentHolder(viewer)): Caller<ConsentHolder>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<ConsentInput>,
) -> HtmlResult {
    let (t, p): (ConsentsMsg, Pilot) = (req.t(), req.t());
    let (req, viewer, config, headers) = (&req, &viewer, &config, &headers);
    let refuse = |message: &'static str| {
        render(req, viewer, config, headers, None, Said::NotSaved, Some(message), StatusCode::UNPROCESSABLE_ENTITY)
    };
    if input.intent != "withdraw" {
        return refuse(t.route_unknown_action()).await;
    }
    let attempt = input.attempt;
    if !valid_attempt(&attempt) {
        return refuse(p.check_attempt()).await;
    }
    let consent = match input.consent_id.trim() {
        "" => return refuse(t.route_consent_required()).await,
        id => id.to_owned(),
    };
    let caller = config.platform.caller(headers, config.proto, None);
    let answer = match caller.withdraw_consent(&consent, &attempt).await {
        Ok(answer) => answer,
        Err(ApiError::Transport(error)) => {
            tracing::warn!("a consent withdrawal had no answer: {error}");
            AccountAnswer::Indeterminate
        }
        Err(error) => return failed(req, viewer, config, headers, error).await,
    };
    // No answer that says what happened: ask what came of the attempt, as marketplace does.
    let action = AccountAction::Withdraw;
    let answer = match answer {
        AccountAnswer::Indeterminate => match caller.account_attempt(action, Some(&consent), &attempt).await {
            Ok(AccountAnswer::Indeterminate) | Err(_) => {
                let place = Place { check: Some(attempt), target: Some(consent), ..Place::default() };
                return req.redirect(&url::Consents { place });
            }
            Ok(asked) => asked,
        },
        answer => answer,
    };
    match answer {
        AccountAnswer::Committed(after_write) => {
            let place = Place { after_write, saved: Some(attempt), ..Place::default() };
            req.redirect(&url::Consents { place })
        }
        AccountAnswer::NotRecorded { code, .. } if code == "validation-failed" => refuse(t.action_validation()).await,
        AccountAnswer::NotRecorded { .. } => refuse(t.manage_state_failed_safe()).await,
        AccountAnswer::Conflict => render(req, viewer, config, headers, None, Said::Conflict, None, StatusCode::CONFLICT).await,
        AccountAnswer::Indeterminate => unreachable!("asked about above"),
    }
}

/// A withdrawal the API refused for who is asking: sign in again, or the page saying they may not.
/// Any other refusal (a consent another one replaced, one that is not there) is a rule the API
/// keeps, and the page says nothing was recorded.
async fn failed(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => {
            render(req, viewer, config, headers, None, Said::Denied, None, StatusCode::FORBIDDEN).await
        }
        Some(status) if status.is_client_error() => {
            render(req, viewer, config, headers, None, Said::NotSaved, None, StatusCode::UNPROCESSABLE_ENTITY).await
        }
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consent(subject: &str, user: Option<&str>, account: Option<&str>) -> Consent {
        Consent {
            subject_type: subject.into(),
            user_id: user.map(str::to_owned),
            account_id: account.map(str::to_owned),
            ..Consent::default()
        }
    }

    #[test]
    fn a_consent_is_the_users_when_withdraw_would_let_it_be() {
        assert!(consent("user", Some("usr_a"), None).is_of("usr_a", "acc_a"));
        assert!(consent("user", Some("usr_a"), Some("acc_b")).is_of("usr_a", "acc_a"), "a user consent is the user's anywhere");
        assert!(consent("account", Some("usr_a"), Some("acc_a")).is_of("usr_a", "acc_a"));
        assert!(!consent("account", Some("usr_a"), Some("acc_b")).is_of("usr_a", "acc_a"), "another account's");
        assert!(!consent("user", Some("usr_b"), Some("acc_a")).is_of("usr_a", "acc_a"), "another user's (#10707)");
        assert!(!consent("account", Some("usr_b"), Some("acc_a")).is_of("usr_a", "acc_a"), "another user's for the account");
        assert!(!consent("device", Some("usr_a"), Some("acc_a")).is_of("usr_a", "acc_a"));
    }
}
