//! The account's saved payment methods (Payments' marketplace `account-payment-methods` route):
//! each one with its readiness and whether it is the default, Set default and Remove, Refresh (ask
//! the provider again about every one), and Add, which starts a Stripe setup and draws its secure
//! step on the page. Every rule is Payments': which methods the account has, whether one may be
//! the default or removed, what a setup saved.
//!
//! Each write is a Saved Checkout Instrument Attempt: the form carries the account the page was
//! drawn for and its attempt (Corten's `SubmitKey`), and Payments applies an attempt once. A
//! failure is classified as marketplace's `classifySavedPaymentMethodAttemptFailure` does, by its
//! code, then its status, and no answer at all is unconfirmed, never refused. An unconfirmed write
//! is drawn again with its form holding the same attempt and saying Check again, which sends it
//! once more; a conflict or an account that changed offers only Reload, which draws new attempts; a
//! session that ended signs in and comes back. Set default and Remove redirect to the page read
//! after their receipt.
//!
//! Add answers its POST with the page itself and `Cache-Control: no-store`, as the security page
//! answers a new key: the setup's client secret is never in an address. The secure step's script
//! (`payment_setup.js`) mounts Stripe's Payment Element with it and Save payment method confirms
//! the SetupIntent; once Stripe accepts it the browser goes to the page with the setup's reference
//! (`?setupReferenceId=`, where Payments' return address also comes back to) and when to stop
//! (`until`). That page asks Payments what the setup saved and, while nothing yet, reads itself
//! again every two seconds until `until`, five minutes, as marketplace's setup card polls.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/payment-methods?<place>` | the page, read after a change's receipt or a setup's outcome |
//! | `POST /account/payment-methods` | Add, Set default, Remove or Refresh (`intent`) |
use crate::recovery::attempt_text;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    NoStore,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{ApiError, MethodChange, PaymentMethod, PaymentMethodCalls as _, SetupSession},
    app::{ORDERS_MANAGE, Shared, read_failed, sign_in, url},
    auth::{PaymentBuyer, Viewer},
    recovery::valid_attempt,
    text::PaymentMethodsMsg,
    views::{self, Layout},
};

/// How long the page reads a setup's outcome again after Stripe accepted it, as marketplace's
/// `POLL_MAX_DURATION_MS`.
pub const SETUP_WATCH: Duration = Duration::from_secs(5 * 60);
/// How often, as marketplace's `POLL_INTERVAL_MS`.
pub const SETUP_EVERY: Duration = Duration::from_secs(2);
/// Where Payments sends the browser back after a setup that leaves the page.
pub const RETURN_PATH: &str = "/account/payment-methods";

/// What the page's address carries: the setup it comes back from (`setupReferenceId`, Payments'
/// name) and until when (Unix seconds) to read it again, or the last change's receipt and the
/// form it was (`default:{id}`, `remove:{id}`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub setup_reference_id: Option<String>,
    pub until: Option<u64>,
    pub after_write: Option<String>,
    pub done: Option<String>,
}

/// A form's fields: the write (`intent`, marketplace's), the account the page was drawn for,
/// the attempt and the payment method.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct MethodInput {
    pub intent: String,
    pub account_id: String,
    pub attempt: Option<SubmitKey>,
    pub instrument_id: String,
}

/// Which of the page's forms an attempt is (marketplace's `attemptFormKey`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormKey {
    Add,
    Default(String),
    Remove(String),
}

impl FormKey {
    /// `add`, `default:{id}` or `remove:{id}`.
    pub fn key(&self) -> String {
        match self {
            FormKey::Add => "add".to_owned(),
            FormKey::Default(id) => format!("default:{id}"),
            FormKey::Remove(id) => format!("remove:{id}"),
        }
    }

    /// The form a posted `intent` and payment method are, `None` for an intent the page does not have.
    pub fn of(intent: &str, instrument: &str) -> Option<Self> {
        let id = instrument.trim().to_owned();
        match intent {
            "add" => Some(FormKey::Add),
            "default" => Some(FormKey::Default(id)),
            "remove" => Some(FormKey::Remove(id)),
            _ => None,
        }
    }

    fn instrument(&self) -> Option<&str> {
        match self {
            FormKey::Add => None,
            FormKey::Default(id) | FormKey::Remove(id) => Some(id),
        }
    }
}

/// What came of an attempt (`AttemptState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttemptState {
    Succeeded,
    Refused,
    Unconfirmed,
    Conflict,
    AccountChanged,
    ReauthRequired,
}

impl AttemptState {
    /// `classifySavedPaymentMethodAttemptFailure`: the code when it is one Payments names, else the
    /// status; no answer, or one that is not an error Payments wrote, is unconfirmed.
    pub fn of(error: &ApiError) -> Self {
        let Some(status) = error.status() else { return AttemptState::Unconfirmed };
        match error.code() {
            Some("attempt_conflict") => AttemptState::Conflict,
            Some("attempt_unconfirmed") => AttemptState::Unconfirmed,
            Some("account_changed") => AttemptState::AccountChanged,
            Some("authentication_required") => AttemptState::ReauthRequired,
            Some("authorization_forbidden" | "not_found" | "validation_failed") => AttemptState::Refused,
            _ if status == StatusCode::UNAUTHORIZED => AttemptState::ReauthRequired,
            _ if status == StatusCode::CONFLICT => AttemptState::Conflict,
            _ if status.is_client_error() => AttemptState::Refused,
            _ => AttemptState::Unconfirmed,
        }
    }

    /// The page's status for an answer in this state.
    fn status(self) -> StatusCode {
        match self {
            AttemptState::Succeeded => StatusCode::OK,
            AttemptState::Refused => StatusCode::UNPROCESSABLE_ENTITY,
            AttemptState::Conflict | AttemptState::AccountChanged => StatusCode::CONFLICT,
            AttemptState::Unconfirmed => StatusCode::ACCEPTED,
            AttemptState::ReauthRequired => StatusCode::UNAUTHORIZED,
        }
    }
}

/// The last attempt the page answers: its form, its id and what came of it.
#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub form: String,
    pub attempt: String,
    pub state: AttemptState,
}

/// What a setup the page comes back from saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupResult {
    Saved,
    Pending,
}

/// The page: the account's payment methods, whether the viewer may change them, what a setup
/// saved, the last attempt's outcome, and Add's secure step.
#[derive(Serialize, ToJson)]
pub struct MethodsScreen {
    pub account_id: String,
    pub methods: Vec<PaymentMethod>,
    pub may_manage: bool,
    pub setup_result: Option<SetupResult>,
    pub outcome: Option<Outcome>,
    /// The setup Add started: its secret is for this answer only.
    #[serde(skip)]
    pub setup: Option<SetupSession>,
    /// A write the page could not make sense of (an unknown intent, Refresh failing), in its words.
    #[serde(skip)]
    pub failed: Option<&'static str>,
}

impl MethodsScreen {
    /// The methods not removed: none is marketplace's empty state.
    pub fn active(&self) -> impl Iterator<Item = &PaymentMethod> {
        self.methods.iter().filter(|m| m.readiness != "removed")
    }

    /// The outcome for `form`, when the last attempt was that form's.
    pub fn outcome_of(&self, form: &FormKey) -> Option<&Outcome> {
        self.outcome.as_ref().filter(|o| o.form == form.key())
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether a pending setup is still read again: before `until`, and never further ahead than
/// [`SETUP_WATCH`] (an address written by hand cannot keep the page reading).
fn watching(until: Option<u64>) -> bool {
    let now = now();
    until.is_some_and(|until| now < until && until <= now + SETUP_WATCH.as_secs() + 60)
}

pub(crate) async fn page(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::payment_methods::PaymentMethods>,
) -> HtmlResult {
    let place = route.place;
    let caller = config.platform.caller(&headers, config.proto, None);
    let t: PaymentMethodsMsg = req.t();
    let mut failed = None;
    let mut watch = false;
    let setup = place.setup_reference_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let setup_result = match setup {
        None => None,
        Some(setup) => match caller.reconcile_setup(setup).await {
            Ok(Some(_)) => Some(SetupResult::Saved),
            Ok(None) => {
                watch = watching(place.until);
                Some(SetupResult::Pending)
            }
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            // A setup Payments does not know for the account: nothing to wait for.
            Err(error) if error.status().is_some_and(|s| s.is_client_error()) => {
                tracing::warn!("a setup's outcome was refused: {error}");
                failed = Some(t.payment_method_update_failed());
                None
            }
            // No answer: the setup may still save, so it is pending and read again, as the card's
            // poll keeps going after a failed check.
            Err(error) => {
                tracing::warn!("a setup's outcome could not be read: {error}");
                watch = watching(place.until);
                Some(SetupResult::Pending)
            }
        },
    };
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let outcome = place.done.map(|form| Outcome { form, attempt: String::new(), state: AttemptState::Succeeded });
    let screen = Drawn { setup_result, outcome, setup: None, failed, watch };
    render(&req, &viewer, &config, &headers, receipt.as_ref(), screen, StatusCode::OK).await
}

/// What a handler has for the page before the methods are read.
struct Drawn {
    setup_result: Option<SetupResult>,
    outcome: Option<Outcome>,
    setup: Option<SetupSession>,
    failed: Option<&'static str>,
    /// Read the page again while a setup is pending.
    watch: bool,
}

impl Drawn {
    fn answer(outcome: Option<Outcome>) -> Self {
        Drawn { setup_result: None, outcome, setup: None, failed: None, watch: false }
    }
}

async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    receipt: Option<&Receipt>,
    drawn: Drawn,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let methods = match caller.payment_methods().await {
        Ok(methods) => methods,
        // The change's projection is not readable yet: the methods as they were.
        Err(error) if receipt.is_some() && error.catching_up() => {
            match config.platform.caller(headers, config.proto, None).payment_methods().await {
                Ok(methods) => methods,
                Err(error) => return read_failed(req, Some(viewer), error, None),
            }
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let screen = MethodsScreen {
        account_id: viewer.actor.account_id.clone(),
        methods,
        may_manage: viewer.actor.can(ORDERS_MANAGE),
        setup_result: drawn.setup_result,
        outcome: drawn.outcome,
        setup: drawn.setup,
        failed: drawn.failed,
    };
    let t: PaymentMethodsMsg = req.t();
    let watch = drawn.watch;
    let head = html! {
        <meta name="robots" content="noindex">
        if watch {
            <ReadAgain after={SETUP_EVERY} />
        }
    };
    let view = html! { <views::PaymentMethodsPage t={t} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.saved_payment_methods()} head={head}>{view}</Layout>
    };
    if status == StatusCode::OK && screen.setup.is_none() {
        req.screen(&screen, page)
    } else {
        req.page_with_status(status, page)
    }
}

/// Add, Set default, Remove or Refresh. Add's answer carries the setup's secret, so no answer is
/// kept (`no-store`).
pub(crate) async fn write(
    req: Req,
    Caller(PaymentBuyer(viewer)): Caller<PaymentBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<MethodInput>,
) -> NoStore<HtmlResult> {
    NoStore(send(&req, &viewer, &config, &headers, input).await)
}

async fn send(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, input: MethodInput) -> HtmlResult {
    let t: PaymentMethodsMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    if input.intent == "reconcile" {
        return match caller.reconcile_payment_methods().await {
            Ok(()) => req.redirect(&url::PaymentMethods::default()),
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(req),
            Err(error) => {
                tracing::warn!("Refresh failed: {error}");
                let drawn = Drawn { failed: Some(t.payment_method_update_failed()), ..Drawn::answer(None) };
                render(req, viewer, config, headers, None, drawn, StatusCode::BAD_GATEWAY).await
            }
        };
    }
    let Some(form) = FormKey::of(&input.intent, &input.instrument_id) else {
        let drawn = Drawn { failed: Some(t.choose_payment_method_action()), ..Drawn::answer(None) };
        return render(req, viewer, config, headers, None, drawn, StatusCode::UNPROCESSABLE_ENTITY).await;
    };
    let attempt = attempt_text(&input.attempt).to_owned();
    let answer = |state: AttemptState| {
        let outcome = Outcome { form: form.key(), attempt: attempt.clone(), state };
        render(req, viewer, config, headers, None, Drawn::answer(Some(outcome)), state.status())
    };
    // Checked before any command, as marketplace's `submitAttempt`.
    if input.account_id != viewer.actor.account_id {
        return answer(AttemptState::AccountChanged).await;
    }
    if !valid_attempt(&attempt) || form.instrument().is_some_and(str::is_empty) || input.account_id.is_empty() {
        return answer(AttemptState::Refused).await;
    }
    let account = viewer.actor.account_id.as_str();
    let failed = |error: ApiError| async move {
        let state = AttemptState::of(&error);
        tracing::warn!("a payment method attempt was {state:?}: {error}");
        if state == AttemptState::ReauthRequired { sign_in(req) } else { answer(state).await }
    };
    match &form {
        FormKey::Add => match caller.start_setup(account, &attempt, RETURN_PATH).await {
            Ok(setup) => {
                let drawn = Drawn { setup: Some(setup), ..Drawn::answer(None) };
                render(req, viewer, config, headers, None, drawn, StatusCode::OK).await
            }
            Err(error) => failed(error).await,
        },
        FormKey::Default(id) | FormKey::Remove(id) => {
            let change = if matches!(form, FormKey::Default(_)) { MethodChange::Default } else { MethodChange::Remove };
            match caller.change_payment_method(change, id, account, &attempt).await {
                Ok(receipt) => {
                    let place = Place { after_write: receipt.map(|r| r.param()), done: Some(form.key()), ..Place::default() };
                    req.redirect(&url::PaymentMethods { place })
                }
                Err(error) => failed(error).await,
            }
        }
    }
}

/// The address Save payment method goes to once Stripe accepts the setup; its script adds `until`.
pub fn after_setup(setup: &SetupSession) -> String {
    url::PaymentMethods { place: Place { setup_reference_id: Some(setup.setup_reference_id.clone()), ..Place::default() } }.href()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(status: u16, code: Option<&str>) -> ApiError {
        ApiError::Status { status: StatusCode::from_u16(status).unwrap(), code: code.map(str::to_owned), message: String::new() }
    }

    #[test]
    fn a_failure_is_its_code_then_its_status_and_no_answer_is_unconfirmed() {
        use AttemptState::*;
        assert_eq!(AttemptState::of(&refused(409, Some("attempt_conflict"))), Conflict);
        assert_eq!(AttemptState::of(&refused(503, Some("attempt_unconfirmed"))), Unconfirmed);
        assert_eq!(AttemptState::of(&refused(409, Some("account_changed"))), AccountChanged);
        assert_eq!(AttemptState::of(&refused(403, Some("authentication_required"))), ReauthRequired);
        for code in ["authorization_forbidden", "not_found", "validation_failed"] {
            assert_eq!(AttemptState::of(&refused(500, Some(code))), Refused, "{code} is refused whatever its status");
        }
        assert_eq!(AttemptState::of(&refused(401, None)), ReauthRequired);
        assert_eq!(AttemptState::of(&refused(409, Some("something_else"))), Conflict);
        assert_eq!(AttemptState::of(&refused(404, None)), Refused);
        assert_eq!(AttemptState::of(&refused(500, None)), Unconfirmed);
        assert_eq!(AttemptState::of(&refused(502, Some("upstream"))), Unconfirmed);
    }

    #[test]
    fn a_setup_is_read_again_until_its_time_and_no_further_than_five_minutes_ahead() {
        let now = now();
        assert!(watching(Some(now + 30)));
        assert!(watching(Some(now + 300)));
        assert!(!watching(Some(now.saturating_sub(1))), "its time has passed");
        assert!(!watching(Some(now + 3_600)), "an hour ahead is not a watch Save started");
        assert!(!watching(None), "Payments' return address carries no watch");
    }

    #[test]
    fn a_form_is_its_intent_and_payment_method() {
        assert_eq!(FormKey::of("add", "spm_1").map(|f| f.key()).as_deref(), Some("add"));
        assert_eq!(FormKey::of("default", " spm_1 ").map(|f| f.key()).as_deref(), Some("default:spm_1"));
        assert_eq!(FormKey::of("remove", "spm_1").map(|f| f.key()).as_deref(), Some("remove:spm_1"));
        assert_eq!(FormKey::of("reconcile", ""), None);
        assert_eq!(FormKey::of("delete", "spm_1"), None);
    }
}
