//! Creating an account: marketplace's `register` route and its auth host's register action
//! (`createRegisterAction`, bounded-contexts/auth/support/route-support/auth-host.ts).
//!
//! The page offers marketplace's four ways, in its order: a passkey (recommended), a phone code, a
//! magic link and a password. Marketplace switches between them with a segmented control; here
//! each is a link to the same page with its `registrationMethod`, so the page needs no script. A
//! passkey needs the browser's WebAuthn, so it is a link to marketplace's page, as on sign-in.
//!
//! | Form (`intent`) | API | Then |
//! |---|---|---|
//! | `password` | `GET /api/auth/registration-consent`, then `POST /api/auth/register` | the session |
//! | `phone-code-request` | `POST /api/auth/phone-code/request` | the page, with the code's form |
//! | `phone-code-consume` | `POST /api/auth/phone-code/consume` | the session |
//! | `magic-link-register` | `POST /api/auth/magic-link/request` | the page, saying the link is sent |
//!
//! Unlike marketplace, "Email me a magic link" sends one: marketplace's action reads the intent
//! as a password and creates the account at once, with no password and no email sent
//! ([chase-sets/chase-sets#10245](https://github.com/chase-sets/chase-sets/issues/10245)). The
//! link creates the account when it is used, under a name the API makes from the email; the name
//! typed here is not sent.
//!
//! A new account lands on `returnTo`, or the account's page read after the identity's write
//! (`after_write`, marketplace's scoped continuation). Marketplace adds `authPrompt=add-passkey`
//! there, a prompt its layout draws; the pilot's layout has none.
//!
//! Not ported: the registration analytics events (`registration_method` on `dataLayer`), which
//! are the page's script.
use corten::{
    ClientIp, Local,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::chrome::Chrome;
use crate::{
    account_home::Place,
    app::{Shared, url},
    sign_in::{Authenticated, DEFAULT_SUCCESS, call, call_written, complete, context, refusal, safe_return_to, social_error},
    text::{Pilot, SignInMsg},
    views::{self, Layout},
};

const AUTH: &str = "auth";

/// The page's address, named as marketplace's (`returnTo`, `socialLoginError`), and the method
/// shown, the pilot's own.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    pub return_to: Option<String>,
    pub registration_method: Option<String>,
    pub social_login_error: Option<String>,
}

impl Join {
    /// Creating an account, back to `path`.
    pub fn back_to(path: &str) -> Self {
        Join { return_to: Some(path.to_owned()), ..Join::default() }
    }

    /// The same address with `method` shown.
    pub fn with_method(&self, method: Method) -> Self {
        Join { registration_method: Some(method.key().into()), social_login_error: None, ..self.clone() }
    }
}

/// A way to create an account, in marketplace's order (`REGISTRATION_METHOD_OPTIONS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Passkey,
    PhoneCode,
    MagicLink,
    Password,
}

impl Method {
    pub const ALL: [Method; 4] = [Method::Passkey, Method::PhoneCode, Method::MagicLink, Method::Password];

    pub fn key(self) -> &'static str {
        match self {
            Method::Passkey => "passkey",
            Method::PhoneCode => "phone-code",
            Method::MagicLink => "magic-link",
            Method::Password => "password",
        }
    }

    pub fn label(self, t: SignInMsg) -> &'static str {
        match self {
            Method::Passkey => t.register_passkey(),
            Method::PhoneCode => t.register_phone_code(),
            Method::MagicLink => t.register_magic_link(),
            Method::Password => t.register_password(),
        }
    }

    /// The method asked for, else marketplace's first (`DEFAULT_REGISTRATION_METHOD`).
    pub fn shown(asked: Option<&str>) -> Method {
        asked.and_then(|key| Method::ALL.into_iter().find(|m| m.key() == key)).unwrap_or(Method::Passkey)
    }

    /// The method a form was for.
    fn of_intent(intent: &str) -> Method {
        match intent {
            "phone-code-request" | "phone-code-consume" => Method::PhoneCode,
            "magic-link-register" => Method::MagicLink,
            _ => Method::Password,
        }
    }
}

/// The page's forms (marketplace's register action's fields).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct RegisterForm {
    pub intent: String,
    pub display_name: String,
    pub email: String,
    pub password: String,
    pub phone: String,
    pub code: String,
    pub token_id: String,
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

/// The page's view model. `typed` is what the last form sent, drawn again (never its password or
/// code).
pub struct RegisterScreen {
    pub join: Join,
    pub method: Method,
    pub return_to: String,
    pub context: Option<(&'static str, &'static str)>,
    pub error: Option<String>,
    pub social_error: Option<&'static str>,
    pub notice: Option<Notice>,
    pub typed: RegisterForm,
}

impl RegisterScreen {
    fn new(t: SignInMsg, join: Join) -> Self {
        let return_to = safe_return_to(join.return_to.as_deref(), DEFAULT_SUCCESS);
        RegisterScreen {
            method: Method::shown(join.registration_method.as_deref()),
            context: context(t, &return_to),
            social_error: join.social_login_error.as_deref().map(|code| social_error(t, code)),
            error: None,
            notice: None,
            typed: RegisterForm::default(),
            return_to,
            join,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneCodeSent {
    token_id: String,
}

fn render(req: &Req, status: StatusCode, screen: &RegisterScreen, cart: Option<u64>) -> HtmlResult {
    let (t, p): (SignInMsg, Pilot) = (req.t(), req.t());
    let page = html! {
        <Layout
            req={req}
            viewer={None}
            cart={cart}
            title={p.auth_register_title()}
            head={html! { <meta name="robots" content="noindex"> }}
        >
            <views::RegisterPage t={t} screen={screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// Where a new account goes (`completeBrowserAuthentication`): `returnTo`, and the account's
/// page read after the write when that is where it goes.
pub fn landing(return_to: &str, receipt: Option<&Receipt>) -> String {
    match (Local::parse(return_to), receipt) {
        (Some(local), Some(receipt)) if local.path() == DEFAULT_SUCCESS => {
            url::AccountHome { place: Place { after_write: Some(receipt.param()), ..Place::default() } }.href()
        }
        _ => return_to.to_owned(),
    }
}

/// The page, with the method its address asks for.
pub(crate) async fn page(req: Req, chrome: Chrome, Params(route): Params<url::Register>) -> HtmlResult {
    let screen = RegisterScreen::new(req.t(), route.join);
    render(&req, StatusCode::OK, &screen, chrome.cart().await)
}

/// The page's forms (marketplace's register action).
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::Register>,
    Form(form): Form<RegisterForm>,
) -> HtmlResult {
    let t: SignInMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut screen = RegisterScreen::new(t, route.join);
    let intent = form.intent.clone();
    screen.method = Method::of_intent(&intent);
    screen.typed = RegisterForm { password: String::new(), code: String::new(), ..form.clone() };
    let failed = |cart: Option<u64>, mut screen: RegisterScreen, error| {
        // A magic link's refusals are the sign-in's request's.
        let asked = if intent == "magic-link-register" { "magic-link-request" } else { intent.as_str() };
        let (status, message) = refusal(t, asked, &error);
        screen.error = Some(message);
        render(&req, status, &screen, cart)
    };
    let started: Result<(Authenticated, Option<Receipt>), _> = match intent.as_str() {
        "magic-link-register" => {
            let body = json!({ "email": form.email, "landingPath": url::MagicLink::PATH, "returnTo": screen.return_to });
            return match call::<Value>(&caller, client, "/api/auth/magic-link/request", body).await {
                Ok(_) => {
                    screen.notice = Some(Notice::MagicLinkSent);
                    render(&req, StatusCode::OK, &screen, chrome.cart().await)
                }
                Err(error) => failed(chrome.cart().await, screen, error),
            };
        }
        "phone-code-request" => {
            return match call::<PhoneCodeSent>(&caller, client, "/api/auth/phone-code/request", json!({ "phone": form.phone }))
                .await
            {
                Ok(sent) => {
                    screen.notice = Some(Notice::PhoneCodeSent { token_id: sent.token_id });
                    render(&req, StatusCode::OK, &screen, chrome.cart().await)
                }
                Err(error) => failed(chrome.cart().await, screen, error),
            };
        }
        "phone-code-consume" => {
            let body = json!({
                "tokenId": form.token_id, "displayName": form.display_name, "phone": form.phone, "code": form.code,
            });
            let started = call_written(&caller, client, "/api/auth/phone-code/consume", body).await;
            if started.is_err() {
                // The code's form stays, for another try at the same code request.
                screen.notice = Some(Notice::PhoneCodeSent { token_id: form.token_id.clone() });
            }
            started
        }
        // Marketplace's default intent is a password. The consent resolution is the API's, sent
        // back as it was handed over: the form draws no affirmation, as marketplace's does not.
        _ => match caller.read::<Value>("/api/auth/registration-consent", AUTH).await {
            Ok(resolution) => {
                let body = json!({
                    "displayName": form.display_name,
                    "email": form.email,
                    "password": form.password,
                    "registrationConsent": { "resolution": resolution, "affirmed": false },
                });
                call_written(&caller, client, "/api/auth/register", body).await
            }
            Err(error) => Err(error),
        },
    };
    match started {
        Ok((result, receipt)) => complete(&req, &config, &landing(&screen.return_to, receipt.as_ref()), result),
        Err(error) => failed(chrome.cart().await, screen, error),
    }
}

/// The pilot's page, back to `back`: for a return the pilot's page acts on (a draft listing's or
/// the Sell List's claim, an item's page). A return only marketplace's page acts on (a product
/// alert's or a saved list's claim) keeps marketplace's registration.
pub fn href(back: &str) -> String {
    url::Register { join: Join::back_to(back) }.href()
}

/// Marketplace's register page, for a passkey (WebAuthn is its page's script).
pub fn on_marketplace(join: &Join) -> String {
    views::on_marketplace(&format!(
        "/register?returnTo={}",
        crate::api::segment(&safe_return_to(join.return_to.as_deref(), DEFAULT_SUCCESS))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_method_is_the_one_asked_for_else_a_passkey() {
        assert_eq!(Method::shown(Some("password")), Method::Password);
        assert_eq!(Method::shown(Some("phone-code")), Method::PhoneCode);
        assert_eq!(Method::shown(Some("anything")), Method::Passkey);
        assert_eq!(Method::shown(None), Method::Passkey);
        assert_eq!(Method::of_intent("magic-link-register"), Method::MagicLink);
        assert_eq!(Method::of_intent("phone-code-consume"), Method::PhoneCode);
        assert_eq!(Method::of_intent(""), Method::Password);
    }

    #[test]
    fn a_new_account_reads_its_page_after_the_write_and_elsewhere_goes_where_it_was_going() {
        let receipt = Receipt::of_event("identity", "7", "evt_1").unwrap();
        let home = landing("/account", Some(&receipt));
        assert!(home.starts_with("/account?after_write="), "{home}");
        assert_eq!(landing("/account", None), "/account");
        assert_eq!(landing("/items/charizard?x=1", Some(&receipt)), "/items/charizard?x=1");
    }
}
