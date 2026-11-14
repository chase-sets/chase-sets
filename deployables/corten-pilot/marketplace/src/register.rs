//! Creating an account: marketplace's `register` route and its auth host's register action
//! (`createRegisterAction`, bounded-contexts/auth/support/route-support/auth-host.ts).
//!
//! The page offers marketplace's four ways, in its order: a passkey (recommended), a phone code, a
//! magic link and a password. Marketplace switches between them with a segmented control; here
//! each is a link to the same page with its `registrationMethod`. A passkey is the browser's
//! WebAuthn, through the shared passkey step (`platform::auth`'s `passkey.js`), which asks the
//! sign-in's challenge route as on sign-in and creates a passkey for the email and name typed.
//!
//! | Form (`intent`) | API | Then |
//! |---|---|---|
//! | `passkey-register` | `POST /api/auth/passkeys/register` | the session, or the page saying the passkey was added (no session started) |
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
//! The page's analytics are marketplace's `registration_method` events (`trackRegistrationAnalytics`),
//! sent by its script (`views/register_analytics.js`) to window listeners and `dataLayer`: every
//! method shown when the page opens, one chosen, a form sent, one refused (with marketplace's
//! classification of the refusal, [`classification`]) and the page left unsent. A method is a link
//! here, so choosing one draws the page again; that page counts the choice, not every method shown
//! again. Without the script nothing is counted, and the page works the same.
use corten::{
    ClientIp, Local,
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{
    auth::{Credential, PASSKEY_LABEL},
    receipt::Receipt,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    account_home::Place,
    api::ApiError,
    app::{Shared, url},
    sign_in::{Authenticated, DEFAULT_SUCCESS, call, call_written, complete, context, refusal, safe_return_to, social_error},
    text::{Pilot, SignInMsg},
    views::{self, Layout},
};

const AUTH: &str = "auth";

/// The page's address, named as marketplace's (`returnTo`, `socialLoginError`), and the method
/// shown, the pilot's own.
#[derive(Clone, Debug, Default, Fields, Route)]
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
            "passkey-register" => Method::Passkey,
            _ => Method::Password,
        }
    }
}

/// The page's forms (marketplace's register action's fields); a passkey's credential is the
/// passkey step's.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct RegisterForm {
    pub intent: String,
    pub display_name: String,
    pub email: String,
    pub password: String,
    pub phone: String,
    pub code: String,
    pub token_id: String,
    pub challenge_id: String,
    pub challenge: String,
    pub external_credential_id: String,
    pub webauthn_response: String,
}

impl RegisterForm {
    /// The passkey's credential, as the passkey step filled it in.
    pub fn credential(&self) -> Credential<'_> {
        Credential {
            challenge_id: &self.challenge_id,
            challenge: &self.challenge,
            external_credential_id: &self.external_credential_id,
            webauthn_response: &self.webauthn_response,
        }
    }

    /// What the page draws again: never a password, a code or a credential.
    fn typed(&self) -> Self {
        RegisterForm {
            display_name: self.display_name.clone(),
            email: self.email.clone(),
            phone: self.phone.clone(),
            ..Self::default()
        }
    }
}

/// What a request sent, which the page says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    MagicLinkSent,
    /// The code's form sends the request's id back with the code.
    PhoneCodeSent {
        token_id: String,
    },
    /// The passkey was added to a user who already had one, so no session started
    /// (`passkey-recovery`): sign in with it.
    PasskeyAdded {
        message: &'static str,
    },
}

/// The page's view model. `typed` is what the last form sent, drawn again (never its password or
/// code). `opened` is the page as an address opens it, not a form's answer, and `failed` the
/// refused form's analytics reason.
pub struct RegisterScreen {
    pub opened: bool,
    pub failed: Option<&'static str>,
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
            opened: false,
            failed: None,
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

/// A passkey registration's answer: the session it started, if any.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyRegistered {
    auth_result: Option<Authenticated>,
}

fn render(req: &Req, status: StatusCode, screen: &RegisterScreen) -> HtmlResult {
    let (t, p): (SignInMsg, Pilot) = (req.t(), req.t());
    let page = html! {
        <Layout
            req={req}
            viewer={None}
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
pub(crate) async fn page(req: Req, Params(route): Params<url::Register>) -> HtmlResult {
    let screen = RegisterScreen { opened: true, ..RegisterScreen::new(req.t(), route.join) };
    render(&req, StatusCode::OK, &screen)
}

/// Marketplace's classification of a refused form (`authApiActionError`), the reason its
/// analytics give: `FIELD` for a phone the API refused, `FORM` for a refusal the page names, and
/// `INDETERMINATE` for anything else. The pilot's client keeps no rejection details, so every
/// `validation_failed` of a phone code's form counts as the missing phone marketplace checks for.
fn classification(intent: &str, error: &ApiError) -> &'static str {
    // No answer: marketplace says sign-in is unavailable, a form failure.
    let Some(status) = error.status() else { return "FORM" };
    let code = error.code();
    let consent = matches!(
        code,
        Some(
            "registration_consent_not_server_minted"
                | "registration_consent_expired"
                | "registration_consent_affirmation_required"
        )
    );
    match status.as_u16() {
        400 if code == Some("validation_failed") && intent.starts_with("phone-code-") => "FIELD",
        400 if consent && matches!(intent, "password" | "phone-code-consume" | "passkey-register") => "FORM",
        401 if code.is_none_or(|c| c == "authentication_required") => "FORM",
        403 if matches!(code, Some("registration_admission_required" | "disposable_email_domain")) => "FORM",
        409 if code.is_none_or(|c| c == "conflict") => "FORM",
        429 if code.is_none_or(|c| c == "rate_limited") => "FORM",
        _ => "INDETERMINATE",
    }
}

/// The page's forms (marketplace's register action).
pub(crate) async fn write(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::Register>,
    Form(form): Form<RegisterForm>,
) -> HtmlResult {
    let (t, p): (SignInMsg, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut screen = RegisterScreen::new(t, route.join);
    let intent = form.intent.clone();
    screen.method = Method::of_intent(&intent);
    screen.typed = form.typed();
    let failed = |mut screen: RegisterScreen, error| {
        // A magic link's refusals are the sign-in's request's.
        let asked = if intent == "magic-link-register" { "magic-link-request" } else { intent.as_str() };
        let (status, message) = refusal(t, asked, &error);
        screen.error = Some(message);
        screen.failed = Some(classification(asked, &error));
        render(&req, status, &screen)
    };
    let started: Result<(Authenticated, Option<Receipt>), _> = match intent.as_str() {
        "magic-link-register" => {
            let body = json!({ "email": form.email, "landingPath": url::MagicLink::PATH, "returnTo": screen.return_to });
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
        // No credential: the step's script did not run, or the browser has no passkeys.
        "passkey-register" if form.credential().is_missing() => {
            screen.error = Some(t.register_passkey_registration_failed().to_owned());
            screen.failed = Some("browser-passkey-failed");
            return render(&req, StatusCode::UNPROCESSABLE_ENTITY, &screen);
        }
        "passkey-register" => {
            let mut body = form.credential().json();
            body.insert("displayName".into(), form.display_name.clone().into());
            body.insert("email".into(), form.email.clone().into());
            body.insert("label".into(), PASSKEY_LABEL.into());
            match call_written::<PasskeyRegistered>(&caller, client, "/api/auth/passkeys/register", Value::Object(body)).await {
                Ok((PasskeyRegistered { auth_result: Some(result) }, receipt)) => Ok((result, receipt)),
                Ok((PasskeyRegistered { auth_result: None }, _)) => {
                    screen.notice = Some(Notice::PasskeyAdded { message: p.auth_passkey_added_sign_in() });
                    return render(&req, StatusCode::OK, &screen);
                }
                Err(error) => Err(error),
            }
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
        Err(error) => failed(screen, error),
    }
}

/// The pilot's page, back to `back`: for a return the pilot's page acts on (a draft listing's or
/// the Sell List's claim, an item's page). A return only marketplace's page acts on (a product
/// alert's or a saved list's claim) keeps marketplace's registration.
pub fn href(back: &str) -> String {
    url::Register { join: Join::back_to(back) }.href()
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
        assert_eq!(Method::of_intent("passkey-register"), Method::Passkey);
        assert_eq!(Method::of_intent(""), Method::Password);
    }

    #[test]
    fn a_refusal_is_classified_as_marketplace_classifies_it() {
        let refused = |status: u16, code: Option<&str>| ApiError::Status {
            status: StatusCode::from_u16(status).unwrap(),
            code: code.map(str::to_owned),
            message: String::new(),
        };
        assert_eq!(classification("phone-code-request", &refused(400, Some("validation_failed"))), "FIELD");
        assert_eq!(classification("password", &refused(400, Some("validation_failed"))), "INDETERMINATE");
        assert_eq!(classification("password", &refused(400, Some("registration_consent_expired"))), "FORM");
        assert_eq!(classification("magic-link-request", &refused(400, Some("registration_consent_expired"))), "INDETERMINATE");
        assert_eq!(classification("password", &refused(401, None)), "FORM");
        assert_eq!(classification("password", &refused(401, Some("forbidden"))), "INDETERMINATE");
        assert_eq!(classification("magic-link-request", &refused(403, Some("disposable_email_domain"))), "FORM");
        assert_eq!(classification("password", &refused(403, None)), "INDETERMINATE");
        assert_eq!(classification("password", &refused(409, None)), "FORM");
        assert_eq!(classification("password", &refused(429, Some("rate_limited"))), "FORM");
        assert_eq!(classification("password", &refused(500, None)), "INDETERMINATE");
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
