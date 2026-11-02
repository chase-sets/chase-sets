//! Signing in to admin: admin-web's `/access/sign-in` (and `/catalog/sign-in`, the same page),
//! `/access/sign-in/magic`, `/access/account-select` and `/access/sign-out`, through Auth's API as
//! its auth host does (`adminAuthHostConfig`, through `platform::auth`).
//!
//! The page asks for an email or phone first, as admin-web's does; that step is a GET to the same
//! page (`signInIdentifier`, `signInMethod=password`), so the page needs no script. An email
//! offers a passkey, a magic link and a password; a phone a code. Each method is a link to the same
//! address with its `signInMethod`, where admin-web's segmented control changes state.
//!
//! | Form (`intent`) | API | Then |
//! |---|---|---|
//! | `password` | `POST /api/auth/password-sign-in` | the session, or account selection |
//! | `magic-link-request` | `POST /api/auth/magic-link/request` | the page, saying the link is sent |
//! | `phone-code-request` | `POST /api/auth/phone-code/request` | the page, with the code's form |
//! | `phone-code-consume` | `POST /api/auth/phone-code/consume` | the session, or account selection |
//!
//! A passkey needs the browser's WebAuthn, and Google Workspace the provider's round trip through
//! the API, which comes back to admin-web's sign-in: both are links to admin-web. A session started
//! here is the platform's cookie (`chase_sets_session`, HttpOnly, SameSite=Lax, Secure on https);
//! the browser then goes back to `returnTo`, on the pilot when it serves the path and on
//! admin-web otherwise.
use corten::{
    ClientIp, Local,
    axum::http::{HeaderMap, StatusCode, Uri},
    prelude::*,
    security::cookie::SetCookie,
};
use platform::auth::{Authenticated, Kind, Membership, Method, PhoneCodeSent, Refusal, call, safe_return_to, selection_token};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller, segment},
    app::{Config, Shared},
    text::SignInMsg,
    views::{self, Layout},
};

/// Where a sign-in goes without a `returnTo` (`adminAuthHostConfig.defaultSuccessPath`).
pub const DEFAULT_SUCCESS: &str = "/";

/// The sign-in page and a magic link's landing. Public: no handler reads who is asking.
#[corten::routes(state = crate::app::Shared, area = SignIn)]
pub mod url {
    /// The page, at the step its address is on; every sign-in form posts to it.
    #[derive(Clone, Debug, Default)]
    #[route("/access/sign-in", get = crate::sign_in::page, post = crate::sign_in::write)]
    pub struct SignIn {
        #[route(query)]
        pub ask: crate::sign_in::Ask,
    }

    /// Where a magic link's email points: its token signs the browser in.
    #[derive(Clone, Debug, Default)]
    #[route("/access/sign-in/magic", get = crate::sign_in::magic)]
    pub struct MagicLink {
        #[route(query)]
        pub link: crate::sign_in::Link,
    }
}

/// The catalog's sign-in, which admin-web serves as the same page: here, the access sign-in with
/// the same address. Public.
#[corten::routes(state = crate::app::Shared, area = CatalogSignIn)]
pub mod catalog {
    #[derive(Clone, Debug, Default)]
    #[route("/catalog/sign-in", get = crate::sign_in::catalog_page)]
    pub struct CatalogSignIn {
        #[route(query)]
        pub ask: crate::sign_in::Ask,
    }
}

/// The account a sign-in acts for, when the user may act for more than one. Public: the
/// selection's cookie says whose it is.
#[corten::routes(state = crate::app::Shared, area = AccountSelect)]
pub mod account_select {
    #[derive(Clone, Debug, Default)]
    #[route("/access/account-select", get = crate::sign_in::select_page, post = crate::sign_in::select)]
    pub struct AccountSelect {
        #[route(query)]
        pub back: crate::sign_in::Back,
    }
}

/// Signing out. Public: it ends whatever session the cookie names.
#[corten::routes(state = crate::app::Shared, area = SignOut)]
pub mod sign_out {
    #[route("/access/sign-out", post = crate::sign_in::sign_out)]
    pub struct SignOut;
}

/// The page's address, named as admin-web's.
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

    /// Where the sign-in goes (`getSafeAdminReturnTo`).
    pub fn return_to(&self) -> String {
        safe_return_to(self.return_to.as_deref(), DEFAULT_SUCCESS)
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

/// The form's fields, named as admin-web's forms name them.
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
    pub error: Option<&'static str>,
    pub social_error: Option<&'static str>,
    pub notice: Option<Notice>,
}

impl SignInScreen {
    fn new(t: SignInMsg, ask: Ask) -> Self {
        let identifier = ask.identifier().map(|id| (id.to_owned(), Kind::of(id)));
        let method = identifier.as_ref().map(|(_, kind)| kind.shown(ask.sign_in_method.as_deref()));
        SignInScreen {
            social_error: ask.social_login_error.as_deref().map(|code| social_error(t, code)),
            identifier,
            method,
            error: None,
            notice: None,
            ask,
        }
    }
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

/// A method's name on the page.
pub fn label(t: SignInMsg, method: Method) -> &'static str {
    match method {
        Method::Password => t.page_password(),
        Method::PhoneCode => t.page_phone_code(),
        Method::MagicLink => t.page_magic_link(),
        Method::Passkey => t.page_passkey(),
    }
}

/// A sign-in's refusal in the page's words (`authApiActionError`), and the status the page has.
fn refusal(t: SignInMsg, intent: &str, error: &ApiError) -> (StatusCode, &'static str) {
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
    (refused.status(), message)
}

/// Google Workspace's sign-in (`createAdminGoogleWorkspaceSocialLoginHref`), on admin-web's
/// origin, where the provider comes back to.
pub fn workspace(return_to: &str) -> String {
    views::admin_web(&format!("/api/auth/social/google/start?journey=admin&returnTo={}", segment(return_to)))
        .map(|uri| uri.to_string())
        .unwrap_or_default()
}

/// admin-web's sign-in, for a passkey (WebAuthn is its page's script): back to the same place with
/// the same identifier.
pub fn on_admin_web(ask: &Ask) -> String {
    let mut path = format!("/access/sign-in?returnTo={}", segment(&ask.return_to()));
    if let Some(identifier) = ask.identifier() {
        path.push_str(&format!("&signInIdentifier={}&signInMethod=passkey", segment(identifier)));
    }
    views::admin_web(&path).map(|uri| uri.to_string()).unwrap_or_default()
}

/// Where a path on the site is: the pilot's page when it serves it, admin-web's otherwise.
fn destination(req: &Req, path: &str) -> Option<Uri> {
    match Local::parse(path) {
        Some(local) if req.serves(&local) => local.to_string().parse().ok(),
        _ => views::admin_web(path),
    }
}

/// A cookie, Secure only when browsers reach the pilot over https.
fn secure(config: &Config, cookie: SetCookie) -> SetCookie {
    if config.proto == "https" { cookie } else { cookie.insecure() }
}

/// The browser signed in (`completeBrowserAuthentication`): the session's cookie and back to
/// `return_to`, or the selection's cookie and the choice of account, which then goes there.
fn complete(req: &Req, config: &Config, return_to: &str, result: Authenticated) -> HtmlResult {
    // A token the API wrote that a cookie cannot carry is the API's mistake: 502, not a panic.
    let keep = result.cookie().ok_or_else(|| corten::Error::status(StatusCode::BAD_GATEWAY))?;
    let res = match &result {
        Authenticated::SessionStarted { .. } => {
            let to = destination(req, return_to).or_else(|| views::admin_web(DEFAULT_SUCCESS));
            let to = to.ok_or_else(|| corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR))?;
            req.redirect(&to)?
        }
        Authenticated::AccountSelectionRequired { .. } => {
            req.redirect(&account_select::AccountSelect { back: Back { return_to: Some(return_to.to_owned()) } })?
        }
    };
    let cleared = secure(config, SetCookie::remove(platform::auth::SELECTION_COOKIE));
    Ok(res.with_cookie(cleared).with_cookie(secure(config, keep)))
}

fn render(req: &Req, status: StatusCode, screen: &SignInScreen) -> HtmlResult {
    let t: SignInMsg = req.t();
    let page = html! {
        <Layout req={req} viewer={None} title={t.route_sign_in()} head={html! { <meta name="robots" content="noindex"> }}>
            <views::SignInPage t={t} screen={screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, at the step its address is on.
pub(crate) async fn page(req: Req, Params(route): Params<url::SignIn>) -> HtmlResult {
    let screen = SignInScreen::new(req.t(), route.ask);
    render(&req, StatusCode::OK, &screen)
}

/// The catalog's sign-in: the same page, at the access sign-in's address.
pub(crate) async fn catalog_page(req: Req, Params(route): Params<catalog::CatalogSignIn>) -> HtmlResult {
    req.redirect(&url::SignIn { ask: route.ask })
}

/// The page's forms (admin-web's sign-in action).
pub(crate) async fn write(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::SignIn>,
    Form(form): Form<SignInForm>,
) -> HtmlResult {
    let t: SignInMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let return_to = route.ask.return_to();
    let mut screen = SignInScreen::new(t, route.ask);
    let intent = form.intent.as_str();
    // The page shows the method the form was for (`withSignInAttempt`), on the identifier it sent.
    let method = Method::of_intent(intent);
    let identifier = if method == Method::PhoneCode { form.phone.trim() } else { form.email.trim() };
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
        // admin-web's default intent is a password.
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
    Params(route): Params<url::MagicLink>,
) -> HtmlResult {
    let link = route.link;
    let t: SignInMsg = req.t();
    let return_to = safe_return_to(link.return_to.as_deref(), DEFAULT_SUCCESS);
    let failed = |status: StatusCode, title: &str, description: &str| {
        let again = url::SignIn { ask: Ask::back_to(&return_to) };
        req.page_with_status(
            status,
            html! {
                <Layout
                    req={&req}
                    viewer={None}
                    title={t.route_sign_in()}
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
    req.redirect(&url::SignIn { ask: Ask::back_to(&safe_return_to(back.return_to.as_deref(), DEFAULT_SUCCESS)) })
}

async fn select_render(
    req: &Req,
    caller: &Caller<'_>,
    client: Option<ClientIp>,
    token: &str,
    back: &Back,
    error: Option<(StatusCode, &'static str)>,
) -> HtmlResult {
    let memberships: Vec<Membership> = match platform::auth::memberships(caller, client, token).await {
        Ok(found) => found,
        // The choice ended: sign in again, back to the same place.
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in_again(req, back),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let t: SignInMsg = req.t();
    let (status, message) = error.map_or((StatusCode::OK, None), |(status, message)| (status, Some(message)));
    let page = html! {
        <Layout
            req={req}
            viewer={None}
            title={t.route_account_selection()}
            head={html! { <meta name="robots" content="noindex"> }}
        >
            <views::AccountSelectPage t={t} memberships={&memberships} error={message} back={back} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The accounts the user may act for, each a form (admin-web's account selection loader).
pub(crate) async fn select_page(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<account_select::AccountSelect>,
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
    Params(route): Params<account_select::AccountSelect>,
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

/// Signing out (`signOutActorViaAuthApi`): the session ended and the browser's cookies cleared
/// even when the API could not be reached; then the sign-in (`signedOutReturnTo`).
pub(crate) async fn sign_out(req: Req, State(config): State<Shared>, headers: HeaderMap, client: Option<ClientIp>) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let cleared = platform::auth::sign_out(&caller, client, &headers).await;
    let mut res = req.redirect(&url::SignIn::default())?;
    for name in cleared {
        res = res.with_cookie(secure(&config, SetCookie::remove(name)));
    }
    Ok(res)
}
