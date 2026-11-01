//! Signing in: marketplace's `sign-in`, `sign-in/magic`, `account/select` and `sign-out` routes, and
//! its auth host's actions (bounded-contexts/auth/support/route-support/auth-host.ts).
//!
//! The page asks for an email or phone first, as marketplace's does. Marketplace's identifier form
//! is a GET to the same page without JavaScript (`signInIdentifier`, and `signInMethod=password`);
//! the pilot's is that GET for everyone, so the step is the address and the page needs no script.
//! An email offers a passkey, a magic link and a password (the password first, as the GET asks); a
//! phone a code. Each method is a link to the same address with its `signInMethod`, where
//! marketplace's segmented control changes state.
//!
//! | Form (`intent`) | API | Then |
//! |---|---|---|
//! | `password` | `POST /api/auth/password-sign-in` | the session, or account selection |
//! | `magic-link-request` | `POST /api/auth/magic-link/request` | the page, saying the link is sent |
//! | `phone-code-request` | `POST /api/auth/phone-code/request` | the page, with the code's form |
//! | `phone-code-consume` | `POST /api/auth/phone-code/consume` | the session, or account selection |
//!
//! A passkey needs the browser's WebAuthn, and a social sign-in the provider's round trip through
//! the API, which comes back to marketplace's sign-in: both are links to marketplace. The magic
//! link's email points at `/sign-in/magic` on the host that asked for it, which the pilot serves.
//!
//! A session started here is marketplace's cookie (`chase_sets_session`, HttpOnly, SameSite=Lax,
//! Secure on https, Max-Age to the session's expiry); the browser then goes back to `returnTo`, on
//! the pilot when it serves the path and on marketplace otherwise.
//!
//! Every call forwards the browser's address (`X-Forwarded-For`), as marketplace's forwarded Auth
//! transport does: the API limits failed sign-ins by that address, and without it every browser
//! would share the web host's
//! ([chase-sets/chase-sets#10686](https://github.com/chase-sets/chase-sets/issues/10686)).
use corten::{
    ClientIp, Local,
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
    security::cookie::SetCookie,
};
pub(crate) use platform::auth::{Authenticated, call, call_written, safe_return_to};
pub use platform::auth::{GUEST_CHECKOUT_COOKIE, Kind, Membership, Method, SELECTION_COOKIE};
use platform::auth::{PhoneCodeSent, Refusal, selection_token};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller, segment},
    app::{Config, Shared, url},
    text::{Pilot, SignInMsg},
    views::{self, Layout},
};

/// Where a sign-in goes without a `returnTo` (the host's `defaultSuccessPath`).
pub const DEFAULT_SUCCESS: &str = "/account";

/// The page's address, named as marketplace's.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub return_to: Option<String>,
    pub sign_in_identifier: Option<String>,
    pub sign_in_method: Option<String>,
    pub social_login_error: Option<String>,
}

impl Ask {
    /// Signing in, back to `path`.
    pub fn back_to(path: &str) -> Self {
        Ask { return_to: Some(path.to_owned()), ..Ask::default() }
    }

    /// The identifier asked for, trimmed; none when empty.
    pub fn identifier(&self) -> Option<&str> {
        self.sign_in_identifier.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// The same address with `method` shown.
    pub fn with_method(&self, method: Method) -> Self {
        Ask { sign_in_method: Some(method.key().into()), social_login_error: None, ..self.clone() }
    }

    /// The first step again: another email or phone, back to the same place.
    pub fn change(&self) -> Self {
        Ask { return_to: self.return_to.clone(), ..Ask::default() }
    }
}

/// The account selection's address: where the sign-in goes once an account is chosen.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Back {
    pub return_to: Option<String>,
}

/// The magic link's address, as the API writes it.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub token: Option<String>,
    pub return_to: Option<String>,
}

/// A method's name on marketplace's page.
pub trait Label {
    fn label(self, t: SignInMsg) -> &'static str;
}

impl Label for Method {
    fn label(self, t: SignInMsg) -> &'static str {
        match self {
            Method::Password => t.page_password(),
            Method::PhoneCode => t.page_phone_code(),
            Method::MagicLink => t.page_magic_link(),
            Method::Passkey => t.page_passkey(),
        }
    }
}

/// Where a path on the site is: the pilot's page when it has one there (`Req::serves`),
/// marketplace's otherwise.
pub fn destination(req: &Req, path: &str) -> Option<Uri> {
    match Local::parse(path) {
        Some(local) if req.serves(&local) => local.to_string().parse().ok(),
        _ => views::marketplace(path),
    }
}

/// Marketplace's sign-in, for what the pilot does not do (a passkey): back to the same place with
/// the same identifier and method.
pub fn on_marketplace(ask: &Ask) -> String {
    let mut path = format!("/sign-in?returnTo={}", segment(&safe_return_to(ask.return_to.as_deref(), DEFAULT_SUCCESS)));
    if let Some(identifier) = ask.identifier() {
        path.push_str(&format!("&signInIdentifier={}&signInMethod=passkey", segment(identifier)));
    }
    views::on_marketplace(&path)
}

/// The account gate's message for where the sign-in returns to (`marketplaceAccountGateContextMessage`).
pub fn context(t: SignInMsg, return_to: &str) -> Option<(&'static str, &'static str)> {
    let (path, query) = return_to.split_once('?').unwrap_or((return_to, ""));
    let query: Vec<(&str, &str)> = query.split('&').filter_map(|pair| pair.split_once('=').or(Some((pair, "")))).collect();
    let has = |name: &str| query.iter().any(|(k, _)| *k == name);
    let is = |name: &str, value: &str| query.iter().any(|(k, v)| *k == name && *v == value);
    if path == "/account/sell-list" && is("registrationReturn", "seller-checkout") {
        return Some((t.context_seller_checkout_title(), t.context_seller_checkout_description()));
    }
    if path == "/account/listings/new" && has("claimListingIntent") {
        return Some((t.context_listing_draft_title(), t.context_listing_draft_description()));
    }
    None
}

/// A social sign-in's refusal, as the API names it in `socialLoginError` (`socialLoginErrorMessage`).
pub fn social_error(t: SignInMsg, code: &str) -> &'static str {
    match code {
        "unsupported_provider" => t.social_unsupported_provider(),
        "provider_not_configured" => t.social_provider_not_configured(),
        "authentication_required" => t.social_authentication_required(),
        "provider_failed" => t.social_provider_failed(),
        "workspace_domain_required" => t.social_admin_workspace_domain_required(),
        "provider_already_linked" => t.social_provider_already_linked(),
        "verified_email_required" => t.social_verified_email_required(),
        "admin_user_required" => t.social_admin_user_required(),
        "registration_admission_required" => t.gate_registration_requires_an_invitation(),
        "disposable_email_domain" => t.gate_disposable_email_domains_are_not_allowed(),
        "registration_consent_unavailable" => t.social_registration_consent_unavailable(),
        "identity_conflict" => t.social_identity_conflict(),
        "user_unavailable" => t.social_user_unavailable(),
        "admin_permission_required" => t.social_admin_permission_required(),
        _ => t.social_state_invalid(),
    }
}

/// The form's fields, named as marketplace's forms name them.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct SignInForm {
    pub intent: String,
    pub email: String,
    pub password: String,
    pub phone: String,
    pub code: String,
    pub token_id: String,
}

/// Account selection's form.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct SelectForm {
    pub account_id: String,
}

/// What a request sent, which the page says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    MagicLinkSent,
    /// The code's form sends the request's id back with the code.
    PhoneCodeSent {
        token_id: String,
    },
}

/// The sign-in page's view model.
pub struct SignInScreen {
    pub ask: Ask,
    pub identifier: Option<(String, Kind)>,
    pub method: Option<Method>,
    pub context: Option<(&'static str, &'static str)>,
    pub error: Option<String>,
    pub social_error: Option<&'static str>,
    pub notice: Option<Notice>,
}

impl SignInScreen {
    fn new(t: SignInMsg, ask: Ask) -> Self {
        let identifier = ask.identifier().map(|id| (id.to_owned(), Kind::of(id)));
        let method = identifier.as_ref().map(|(_, kind)| kind.shown(ask.sign_in_method.as_deref()));
        let return_to = safe_return_to(ask.return_to.as_deref(), DEFAULT_SUCCESS);
        SignInScreen {
            context: context(t, &return_to),
            social_error: ask.social_login_error.as_deref().map(|code| social_error(t, code)),
            identifier,
            method,
            error: None,
            notice: None,
            ask,
        }
    }
}

/// A sign-in's refusal in the page's words (`authApiActionError`), and the status the page has.
pub(crate) fn refusal(t: SignInMsg, intent: &str, error: &ApiError) -> (StatusCode, String) {
    let refused = Refusal::of(intent, error);
    let message = match refused {
        Refusal::Unavailable => t.host_sign_in_temporarily_unavailable(),
        Refusal::InvalidEmailOrPassword => t.password_invalid_email_or_password(),
        Refusal::InvalidPhoneCode => t.phone_phone_code_is_invalid_or_has(),
        Refusal::InvalidSelection => t.selection_api_account_selection_is_invalid_or_has(),
        Refusal::InvitationRequired => t.gate_registration_requires_an_invitation(),
        Refusal::DisposableEmail => t.gate_disposable_email_domains_are_not_allowed(),
        Refusal::ConsentUnavailable => t.social_registration_consent_unavailable(),
        Refusal::RateLimited => t.host_rate_limited(),
        Refusal::Failed => t.host_request_failed(),
    };
    (refused.status(), message.to_owned())
}

/// A cookie, Secure only when browsers reach the pilot over https.
fn secure(config: &Config, cookie: SetCookie) -> SetCookie {
    if config.proto == "https" { cookie } else { cookie.insecure() }
}

/// The browser signed in (`completeBrowserAuthentication`): the session's cookie and back to
/// `return_to`, or the selection's cookie and the choice of account, which then goes there.
pub(crate) fn complete(req: &Req, config: &Config, return_to: &str, result: Authenticated) -> HtmlResult {
    // A token the API wrote that a cookie cannot carry is the API's mistake: 502, not a panic.
    let keep = result.cookie().ok_or_else(|| corten::Error::status(StatusCode::BAD_GATEWAY))?;
    let res = match &result {
        Authenticated::SessionStarted { .. } => {
            let to = destination(req, return_to).or_else(|| views::marketplace(DEFAULT_SUCCESS));
            let to = to.ok_or_else(|| corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR))?;
            req.redirect(&to)?
        }
        Authenticated::AccountSelectionRequired { .. } => {
            req.redirect(&url::AccountSelect { back: Back { return_to: Some(return_to.to_owned()) } })?
        }
    };
    Ok(res.with_cookie(secure(config, SetCookie::remove(SELECTION_COOKIE))).with_cookie(secure(config, keep)))
}

fn render(req: &Req, status: StatusCode, screen: &SignInScreen) -> HtmlResult {
    let (t, p): (SignInMsg, Pilot) = (req.t(), req.t());
    let page = html! {
        <Layout req={req} viewer={None} title={p.auth_sign_in_title()} head={html! { <meta name="robots" content="noindex"> }}>
            <views::SignInPage t={t} screen={screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, at the step its address is on.
pub(crate) async fn page(req: Req, Params(route): Params<crate::app::url::sign_in::SignIn>) -> HtmlResult {
    let ask = route.ask;
    let screen = SignInScreen::new(req.t(), ask);
    render(&req, StatusCode::OK, &screen)
}

/// The page's forms (marketplace's sign-in action).
pub(crate) async fn write(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::sign_in::SignIn>,
    Form(form): Form<SignInForm>,
) -> HtmlResult {
    let ask = route.ask;
    let t: SignInMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let return_to = safe_return_to(ask.return_to.as_deref(), DEFAULT_SUCCESS);
    let mut screen = SignInScreen::new(t, ask);
    let intent = form.intent.as_str();
    // The page shows the method the form was for (`withSignInAttempt`), on the identifier it sent.
    let (identifier, method) = match intent {
        "phone-code-request" | "phone-code-consume" => (form.phone.trim(), Method::PhoneCode),
        "magic-link-request" => (form.email.trim(), Method::MagicLink),
        _ => (form.email.trim(), Method::Password),
    };
    if !identifier.is_empty() {
        screen.identifier = Some((identifier.to_owned(), Kind::of(identifier)));
        screen.method = Some(method);
    }
    let failed = |mut screen: SignInScreen, error: ApiError| {
        let (status, message) = refusal(t, intent, &error);
        screen.error = Some(message);
        render(&req, status, &screen)
    };
    let started = match intent {
        "magic-link-request" => {
            let body = json!({ "email": form.email, "landingPath": url::MagicLink::PATH, "returnTo": return_to });
            return match call::<Value>(&caller, client, "/api/auth/magic-link/request", body).await {
                Ok(_) => {
                    screen.notice = Some(Notice::MagicLinkSent);
                    render(&req, StatusCode::OK, &screen)
                }
                Err(error) => failed(screen, error),
            };
        }
        "phone-code-request" => {
            return match call::<PhoneCodeSent>(&caller, client, "/api/auth/phone-code/request", json!({ "phone": form.phone }))
                .await
            {
                Ok(sent) => {
                    screen.notice = Some(Notice::PhoneCodeSent { token_id: sent.token_id });
                    render(&req, StatusCode::OK, &screen)
                }
                Err(error) => failed(screen, error),
            };
        }
        "phone-code-consume" => {
            let body = json!({ "tokenId": form.token_id, "phone": form.phone, "code": form.code });
            let started = call::<Authenticated>(&caller, client, "/api/auth/phone-code/consume", body).await;
            if started.is_err() {
                // The code's form stays, for another try at the same code request.
                screen.notice = Some(Notice::PhoneCodeSent { token_id: form.token_id.clone() });
            }
            started
        }
        // Marketplace's default intent is a password.
        _ => platform::auth::password(&caller, client, &form.email, &form.password).await,
    };
    match started {
        Ok(result) => complete(&req, &config, &return_to, result),
        Err(error) => failed(screen, error),
    }
}

/// The magic link's landing (`createMagicLinkLandingLoader`): the link's token signs the browser
/// in, or the page says why it could not.
pub(crate) async fn magic(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::sign_in::MagicLink>,
) -> HtmlResult {
    let link = route.link;
    let t: SignInMsg = req.t();
    let return_to = safe_return_to(link.return_to.as_deref(), DEFAULT_SUCCESS);
    let failed = |status: StatusCode, title: &str, description: &str| {
        let p: Pilot = req.t();
        let again = url::SignIn { ask: Ask::back_to(&return_to) };
        req.page_with_status(
            status,
            html! {
                <Layout
                    req={&req}
                    viewer={None}
                    title={p.auth_sign_in_title()}
                    head={html! { <meta name="robots" content="noindex"> }}
                >
                    <views::MagicLinkFailed t={t} title={title} description={description} again={&again} />
                </Layout>
            },
        )
    };
    let Some(token) = link.token.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return failed(StatusCode::BAD_REQUEST, t.magic_magic_link_could_not_be_completed(), t.magic_magic_link_is_missing());
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match call::<Authenticated>(&caller, client, "/api/auth/magic-link/consume", json!({ "token": token })).await {
        Ok(result) => complete(&req, &config, &return_to, result),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
            failed(StatusCode::UNAUTHORIZED, t.magic_magic_link_expired_or_used(), t.magic_request_a_new_sign_in_link())
        }
        Err(ApiError::Status { status, message, .. }) => {
            tracing::warn!("a magic link could not be used: {status} {message}");
            failed(StatusCode::BAD_GATEWAY, t.magic_sign_in_temporarily_unavailable(), &message)
        }
        Err(error) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

/// No choice to make, or one that ended: the sign-in again, back to the same place
/// (`requireAccountSelectionTokenOrRedirect`).
fn sign_in_again(req: &Req, back: &Back) -> HtmlResult {
    let return_to = safe_return_to(back.return_to.as_deref(), DEFAULT_SUCCESS);
    req.redirect(&url::SignIn { ask: Ask::back_to(&return_to) })
}

async fn select_render(
    req: &Req,
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    token: &str,
    back: &Back,
    error: Option<(StatusCode, String)>,
) -> HtmlResult {
    let memberships = match platform::auth::memberships(caller, client, token).await {
        Ok(found) => found,
        // The choice ended: sign in again, back to the same place.
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in_again(req, back),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let (t, p): (SignInMsg, Pilot) = (req.t(), req.t());
    let (status, message) = error.map_or((StatusCode::OK, None), |(status, message)| (status, Some(message)));
    let page = html! {
        <Layout
            req={req}
            viewer={None}
            title={p.auth_account_selection_title()}
            head={html! { <meta name="robots" content="noindex"> }}
        >
            <views::AccountSelectPage t={t} memberships={&memberships} error={message.as_deref()} back={back} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The accounts the user may act for, each a form (marketplace's account selection loader).
pub(crate) async fn select_page(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::account_select::AccountSelect>,
) -> HtmlResult {
    let back = route.back;
    let Some(token) = selection_token(&headers) else { return sign_in_again(&req, &back) };
    let caller = config.platform.caller(&headers, config.proto, None);
    select_render(&req, &caller, client, token, &back, None).await
}

/// The account chosen: the session, then where the sign-in was going.
pub(crate) async fn select(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<crate::app::url::account_select::AccountSelect>,
    Form(form): Form<SelectForm>,
) -> HtmlResult {
    let back = route.back;
    let Some(token) = selection_token(&headers) else { return sign_in_again(&req, &back) };
    let caller = config.platform.caller(&headers, config.proto, None);
    let body = json!({ "selectionToken": token, "accountId": form.account_id });
    match call::<Authenticated>(&caller, client, "/api/auth/account-selection/complete", body).await {
        Ok(result) => complete(&req, &config, &safe_return_to(back.return_to.as_deref(), DEFAULT_SUCCESS), result),
        Err(error) => {
            let refused = refusal(req.t(), "account-selection", &error);
            select_render(&req, &caller, client, token, &back, Some(refused)).await
        }
    }
}

/// Signing out (`signOutActorViaAuthApi`): the guest checkout ended when there is one, the session
/// ended, and the browser's cookies cleared even when the API could not be reached; then search
/// (the host's `signedOutReturnTo`).
pub(crate) async fn sign_out(req: Req, State(config): State<Shared>, headers: HeaderMap, client: Option<ClientIp>) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let cleared = platform::auth::sign_out(&caller, client, &headers).await;
    let mut res = req.redirect(&url::Search::default())?;
    for name in cleared {
        res = res.with_cookie(secure(&config, SetCookie::remove(name)));
    }
    Ok(res)
}
