//! The account's own page (Identity's marketplace `account` route): the profile, who is signed
//! in, the readiness signals and trust details, and Update Profile. Every rule is the API's.
//!
//! The profile write is an Identity account-management attempt (`update-profile`, its target
//! the account), as the shipping addresses' are: the form's `SubmitKey` is the `Idempotency-Key`,
//! an answer the pilot did not get is asked about at once, and one the lookup cannot settle sends
//! the page to ask again (`?check=`) with the form off (see `addresses`).
//!
//! After a write the page reads the account with the write's receipt. A read still catching up
//! is read again without it, or, failing that, drawn from who is signed in (marketplace's
//! `getAccountOrActorFallback`); unlike marketplace the page then says so and reads itself
//! again.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account?<place>` | the page, read after the write whose receipt it carries |
//! | `POST /account` | update the profile |
use crate::recovery::attempt_text;
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    addresses::Said,
    api::{AccountAction, AccountAnswer, AccountCalls, AccountProfile, ActorDisplay, Addresses as _, ApiError, ProfileCommand},
    app::{Shared, read_failed, sign_in, url},
    auth::{AccountOwner, Viewer},
    recovery::valid_attempt,
    text::{AccountHomeMsg, Pilot},
    views::{self, Layout},
};

/// What the page's address carries: the last write's receipt (`after_write`), the attempt that
/// answer settles (`saved`), and an attempt to ask the API about (`check`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub saved: Option<String>,
    pub check: Option<String>,
}

/// The form's fields (marketplace's `name` and `displayName`) and the attempt it was drawn with.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ProfileInput {
    pub attempt: Option<SubmitKey>,
    pub name: String,
    pub display_name: String,
}

impl ProfileInput {
    pub fn of(account: &AccountProfile) -> Self {
        ProfileInput { attempt: None, name: account.name.clone(), display_name: account.display_name.clone() }
    }

    /// The body marketplace sends: the text as it was typed.
    pub fn command(&self) -> ProfileCommand {
        ProfileCommand { name: self.name.clone(), display_name: self.display_name.clone() }
    }
}

/// A refused update's form, drawn again: what was sent and what is wrong with it.
#[derive(Clone, Debug)]
pub struct Draft {
    pub input: ProfileInput,
    pub errors: Errors,
}

/// The page: the account (the actor's fallback while it catches up with a write), who is signed
/// in (none when that read fails, as marketplace), what the last write did, and a refused form.
#[derive(Serialize, ToJson)]
pub struct AccountScreen {
    pub account: AccountProfile,
    pub actor: Option<ActorDisplay>,
    pub pending: bool,
    pub said: Said,
    #[serde(skip)]
    pub posted: Option<Draft>,
}

impl AccountScreen {
    /// Whether Update Profile is off: the write it would repeat is unconfirmed.
    pub fn held(&self) -> bool {
        self.said.holds(AccountAction::UpdateProfile, Some(&self.account.account_id))
    }

    /// The form: a refused one as it was sent, else the account's profile.
    pub fn draft(&self) -> Draft {
        self.posted.clone().unwrap_or_else(|| Draft { input: ProfileInput::of(&self.account), errors: Errors::new() })
    }
}

/// The account marketplace draws from who is signed in when the account cannot be read yet
/// (`buildActorAccountFallback`).
fn fallback(viewer: &Viewer, actor: Option<&ActorDisplay>) -> AccountProfile {
    let account = actor.map(|a| &a.account);
    let display_name = account
        .and_then(|a| a.display_name.clone().or_else(|| a.name.clone()))
        .unwrap_or_else(|| viewer.actor.account_id.clone());
    AccountProfile {
        account_id: viewer.actor.account_id.clone(),
        name: account.and_then(|a| a.name.clone()).unwrap_or_else(|| display_name.clone()),
        display_name,
        account_type: "personal".into(),
        status: "active".into(),
        badges: account.map(|a| a.badges.clone()).unwrap_or_default(),
        founder_number: None,
        updated_at: String::new(),
    }
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(AccountOwner(viewer)): Caller<AccountOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::account_home::AccountHome>,
) -> HtmlResult {
    let place = route.place;
    let said = match &place.check {
        Some(attempt) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            check(&caller, &viewer.actor.account_id, attempt).await
        }
        None if place.saved.is_some() => Said::Saved,
        None => Said::Editing,
    };
    render(&req, &viewer, &config, &headers, place.after_write.as_deref(), said, None, StatusCode::OK, &chrome).await
}

/// What the API says came of `attempt`, for the page.
async fn check(caller: &crate::api::Caller<'_>, account: &str, attempt: &str) -> Said {
    let unconfirmed = || Said::Unconfirmed {
        attempt: attempt.to_owned(),
        action: AccountAction::UpdateProfile,
        target: Some(account.to_owned()),
    };
    if !valid_attempt(attempt) {
        return Said::NotSaved;
    }
    match caller.account_attempt(AccountAction::UpdateProfile, Some(account), attempt).await {
        Ok(AccountAnswer::Committed(_)) => Said::Saved,
        Ok(AccountAnswer::NotRecorded { .. }) => Said::NotSaved,
        Ok(AccountAnswer::Conflict) => Said::Conflict,
        Ok(AccountAnswer::Indeterminate) => unconfirmed(),
        Err(error) => {
            tracing::warn!("the profile attempt check failed: {error}");
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
    let id = viewer.actor.account_id.as_str();
    let (actor, account) = tokio::join!(caller.actor_display(), caller.account(id));
    let actor = actor.inspect_err(|error| tracing::warn!("the signed-in identity could not be read: {error}")).ok();
    let (account, pending) = match account {
        Ok(account) => (account, false),
        // The write's projection is not readable yet: the account as it was, or as the actor has it.
        Err(error) if receipt.is_some() && error.catching_up() => {
            let plain = config.platform.caller(headers, config.proto, None);
            (plain.account(id).await.unwrap_or_else(|_| fallback(viewer, actor.as_ref())), true)
        }
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let screen = AccountScreen { account, actor, pending, said, posted };
    let t: AccountHomeMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={std::time::Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::AccountHomePage t={t} p={req.t()} screen={&screen} /> };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_title()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn update(
    req: Req,
    chrome: Chrome,
    Caller(AccountOwner(viewer)): Caller<AccountOwner>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<ProfileInput>,
) -> HtmlResult {
    let (t, p): (AccountHomeMsg, Pilot) = (req.t(), req.t());
    let attempt = attempt_text(&input.attempt).to_owned();
    let refuse = |message: &'static str| {
        let mut errors = Errors::new();
        errors.add_form(message);
        let draft = Draft { input: input.clone(), errors };
        render(&req, &viewer, &config, &headers, None, Said::Editing, Some(draft), StatusCode::UNPROCESSABLE_ENTITY, &chrome)
    };
    if !valid_attempt(&attempt) {
        return refuse(p.check_attempt()).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let account = viewer.actor.account_id.as_str();
    let answer = match caller.update_profile(account, &attempt, &input.command()).await {
        Ok(answer) => answer,
        Err(ApiError::Transport(error)) => {
            tracing::warn!("a profile update had no answer: {error}");
            AccountAnswer::Indeterminate
        }
        Err(error) => return failed(&req, &viewer, &config, &headers, error, &chrome).await,
    };
    // No answer that says what happened: ask what came of the attempt, as marketplace does.
    let answer = match answer {
        AccountAnswer::Indeterminate => {
            match caller.account_attempt(AccountAction::UpdateProfile, Some(account), &attempt).await {
                Ok(AccountAnswer::Indeterminate) | Err(_) => {
                    return req.redirect(&url::AccountHome { place: Place { check: Some(attempt), ..Place::default() } });
                }
                Ok(answer) => answer,
            }
        }
        answer => answer,
    };
    match answer {
        AccountAnswer::Committed(after_write) => {
            req.redirect(&url::AccountHome { place: Place { after_write, saved: Some(attempt), ..Place::default() } })
        }
        AccountAnswer::NotRecorded { code, .. } if code == "validation-failed" => refuse(t.action_validation()).await,
        AccountAnswer::NotRecorded { .. } => refuse(t.manage_state_failed_safe()).await,
        AccountAnswer::Conflict => {
            render(&req, &viewer, &config, &headers, None, Said::Conflict, None, StatusCode::CONFLICT, &chrome).await
        }
        AccountAnswer::Indeterminate => unreachable!("asked about above"),
    }
}

/// A write the API refused for who is asking: sign in again, or the page saying they may not.
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
        _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use platform::api::Actor;

    fn viewer() -> Viewer {
        let actor = Actor { user_id: "usr_1".into(), account_id: "acc_1".into(), role_key: "owner".into(), permissions: vec![] };
        Viewer { actor, color_mode: Default::default() }
    }

    #[test]
    fn the_fallback_is_marketplaces() {
        let bare = fallback(&viewer(), None);
        assert_eq!((bare.display_name.as_str(), bare.name.as_str()), ("acc_1", "acc_1"), "the account's id, with nothing else");
        assert_eq!((bare.account_type.as_str(), bare.status.as_str(), bare.updated_at.as_str()), ("personal", "active", ""));
        let mut actor = ActorDisplay::default();
        actor.account.name = Some("Legal Co".into());
        actor.account.badges = vec!["trusted-seller".into()];
        let named = fallback(&viewer(), Some(&actor));
        assert_eq!((named.display_name.as_str(), named.name.as_str()), ("Legal Co", "Legal Co"), "no display name: the name");
        actor.account.display_name = Some("Shop".into());
        let shown = fallback(&viewer(), Some(&actor));
        assert_eq!((shown.display_name.as_str(), shown.name.as_str()), ("Shop", "Legal Co"));
        assert_eq!(shown.badges, ["trusted-seller"]);
    }

    #[test]
    fn the_body_is_the_text_as_typed() {
        let input = ProfileInput { attempt: None, name: " Legal ".into(), display_name: "Shop".into() };
        assert_eq!(input.command(), ProfileCommand { name: " Legal ".into(), display_name: "Shop".into() });
        assert_eq!(
            serde_json::to_value(input.command()).unwrap(),
            serde_json::json!({ "name": " Legal ", "displayName": "Shop" })
        );
    }
}
