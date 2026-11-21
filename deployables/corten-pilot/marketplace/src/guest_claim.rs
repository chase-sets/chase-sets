//! Save this order (Auth's `guest-payment-claim`, marketplace's
//! `auth/routes/marketplace/guest-payment-claim.tsx`): `/checkout/claim/{id}`, where a paid guest
//! checkout's payment page sends the guest (Save this order) and a claim link lands.
//!
//! The page reads the payment after the write whose receipt it carries (Payments'
//! `readGuestPaymentClaimability`). A paid one (`captured`) offers to save the order to an account:
//! with a passkey for the guest's contact email (the shared passkey step, as registration creates
//! one), or with a claim link Auth emails there. One not paid yet says it can be saved after payment,
//! with a link back to its payment. Its forms post to the page, and each reads the payment again
//! first:
//!
//! | intent | Auth's call | then |
//! | --- | --- | --- |
//! | `claim-passkey` | `POST /api/auth/guest-checkout/claim-with-passkey` | signed in, at the account's payment |
//! | `claim-link-request` | `POST /api/auth/guest-checkout/claim-link/request` | the page, saying the link was sent |
//! | `claim-link-consume` | `POST /api/auth/guest-checkout/claim-with-magic-link` | signed in, at the account's payment |
//!
//! The last is the token typed by hand, offered only where `Config::claim_token_entry` shows it
//! (locally, without email). A claim link's landing (`?claimContinuation=`) claims with it
//! (`claim-with-continuation`) and signs in the same way, in any browser; the emailed link opens the
//! payment's address, which sends it here. Each claim ends the guest checkout, so its cookie is
//! cleared, and lands on the account's payment read after the claim. Auth's claim calls need the
//! platform's internal capability, which the server reads from `PLATFORM_INTERNAL_AUTH_SECRET`
//! (`platform::api::InternalAuth`) and sends on these calls only.
//!
//! An account here is sent to its own payment page, and a request with no guest checkout, or one
//! Payments refuses, is told the link is no longer good, as on the payment page.
//!
//! The prompt is drawn only for a contact Auth reports bound. An unbound one, or a read Auth refuses
//! (it allows five an hour for each guest), says the order cannot be saved now instead of failing
//! the page or drawing a prompt with no email, and a sent link says so, as marketplace's page does.
//! Until a checkout binds a guest's contact
//! (chase-sets/chase-sets#5736), no guest is offered it.
use corten::{
    ClientIp,
    http::{HeaderMap, StatusCode, header},
    prelude::*,
};
use platform::{
    auth::{Authenticated, Credential, PASSKEY_LABEL, call_internal},
    receipt::Receipt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    api::PaymentCalls as _,
    app::{Shared, read_failed, url},
    auth::{Session, Viewer},
    payment::{self, Payer, Place},
    text::{PaymentMsg, Pilot},
    views::{self, Layout},
};

/// Save this order's address: the receipt of the write it reads after (the payment page's), and a
/// claim link's continuation, which the page claims the order with.
#[derive(Clone, Debug, Default, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPlace {
    pub after_write: Option<String>,
    pub claim_continuation: Option<String>,
}

/// The page's forms, named as marketplace's name them; a passkey's credential is the passkey
/// step's.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimForm {
    pub intent: String,
    pub display_name: String,
    /// The contact's email, which the passkey step creates the passkey for.
    pub email: String,
    /// A claim link's token, typed by hand.
    pub token: String,
    pub challenge_id: String,
    pub challenge: String,
    pub external_credential_id: String,
    pub webauthn_response: String,
}

impl ClaimForm {
    /// The passkey's credential, as the passkey step filled it in.
    fn credential(&self) -> Credential<'_> {
        Credential {
            challenge_id: &self.challenge_id,
            challenge: &self.challenge,
            external_credential_id: &self.external_credential_id,
            webauthn_response: &self.webauthn_response,
        }
    }
}

/// The page: the payment, whether it is paid, the prompt for a bound contact, and what the last
/// form left.
#[derive(Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ClaimScreen {
    pub payment_id: String,
    /// Paid (`isClaimablePayment`): the order can be saved.
    pub paid: bool,
    /// The prompt, for a paid order whose contact Auth reports bound.
    pub claim: Option<Claim>,
    /// Why the last claim did not save the order.
    pub error: Option<String>,
    /// That a claim link was sent, when the contact could not be read again to say where.
    pub sent: Option<String>,
}

/// The prompt (`GuestClaimPrompt`): the guest's bound contact, and what the last claim form left.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub contact_email: String,
    pub contact_name: String,
    /// The name the passkey is created for: the contact's, or the one typed.
    pub display_name: String,
    /// That a claim link was sent, in the page's words.
    pub link_sent: Option<String>,
    /// The link's token, to type by hand where `Config::claim_token_entry` shows it.
    pub token: Option<String>,
}

/// Auth's claim context (`POST /api/auth/guest-checkout/claim-context`): the guest's contact, both
/// parts null until a checkout binds it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimContext {
    contact_email: Option<String>,
    contact_name: Option<String>,
}

/// A claim link Auth sent (`claim-link/request`): its token, which the page shows only where it is
/// typed by hand.
#[derive(Deserialize)]
struct LinkSent {
    token: String,
}

/// The prompt for a paid order: Auth's bound contact (`getGuestCheckoutClaimContext`, with the
/// internal capability). An unbound contact, or a read Auth refuses or never answers, leaves the
/// prompt off rather than failing the page (chase-sets/chase-sets#11253).
async fn claim_context(config: &Shared, headers: &HeaderMap, client: Option<ClientIp>, id: &str) -> Option<Claim> {
    let caller = config.platform.caller(headers, config.proto, None);
    let body = json!({ "paymentId": id });
    let context = match call_internal::<ClaimContext>(&caller, client, "/api/auth/guest-checkout/claim-context", body).await {
        Ok((context, _)) => context,
        Err(error) => {
            tracing::warn!("a guest's claim context could not be read: {error}");
            return None;
        }
    };
    let bound = |part: Option<String>| part.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
    let (contact_email, contact_name) = (bound(context.contact_email)?, bound(context.contact_name)?);
    Some(Claim { display_name: contact_name.clone(), contact_email, contact_name, ..Claim::default() })
}

/// Why a claim (`intent`) was refused, in the page's words. Auth answers a passkey whose challenge
/// it cannot verify, and a spent or unknown link, with a 401 whose body is no error envelope; any
/// other refusal says its envelope's message, and the rest that the order could not be saved.
fn claim_refusal(req: &Req, intent: &str, error: &crate::api::ApiError) -> String {
    let (t, p): (PaymentMsg, Pilot) = (req.t(), req.t());
    match (error.status(), error.refusal()) {
        (Some(StatusCode::UNAUTHORIZED), _) if intent == "claim-passkey" => t.passkey_registration_failed().to_owned(),
        (Some(StatusCode::UNAUTHORIZED), _) if intent == "claim-link-consume" => p.guest_claim_link_expired().to_owned(),
        (_, Some(message)) => message.to_owned(),
        _ => {
            tracing::warn!("a guest claim failed: {error}");
            t.could_not_save_this_order().to_owned()
        }
    }
}

/// A claim that signed the guest in (`completeBrowserAuthentication` to `/account/payments/{id}`):
/// the account's payment, read after the claim, with the guest checkout's cookie cleared.
fn claimed(req: &Req, config: &Shared, id: &str, result: Authenticated, receipt: Option<&Receipt>) -> HtmlResult {
    let to = url::BuyerPayment { id, place: Place { after_write: receipt.map(Receipt::param) } }.href();
    crate::sign_in::complete_claim(req, config, &to, result)
}

/// What the page needs, read after `receipt`: the screen, or the page to answer instead (the
/// payment page's answers).
#[allow(clippy::too_many_arguments)]
async fn read(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    receipt: Option<&Receipt>,
) -> Result<ClaimScreen, Box<HtmlResult>> {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let payment = match caller.account_payment(id).await {
        Ok(Some(payment)) => payment,
        Ok(None) if receipt.is_some() => return Err(Box::new(payment::preparing(req, viewer, Payer::Guest))),
        Ok(None) => return Err(Box::new(payment::not_found(req, viewer, Payer::Guest))),
        Err(error) if receipt.is_some() && error.catching_up() => {
            return Err(Box::new(payment::preparing(req, viewer, Payer::Guest)));
        }
        Err(error) if payment::refused_access(&error) => return Err(Box::new(payment::expired(req, Some(viewer)))),
        Err(error) => return Err(Box::new(read_failed(req, Some(viewer), error, None))),
    };
    let paid = payment.status == "captured";
    let claim = if paid { claim_context(config, headers, client, id).await } else { None };
    Ok(ClaimScreen { payment_id: id.to_owned(), paid, claim, error: None, sent: None })
}

/// The page, drawn from the screen, with `status`.
fn draw(req: &Req, viewer: &Viewer, screen: &ClaimScreen, status: StatusCode) -> HtmlResult {
    let (t, p): (PaymentMsg, Pilot) = (req.t(), req.t());
    let view = html! { <views::GuestClaimPage t={t} p={p} screen={screen} /> };
    let head = html! { <meta name="robots" content="noindex"> };
    let page =
        html! { <Layout req={req} viewer={Some(viewer)} title={views::guest_claim_title(t, screen)} head={head}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(screen, page) } else { req.page_with_status(status, page) }
}

/// Save this order's page, read after the write whose receipt it carries, or a claim link's
/// landing, which claims the order with it (see the module).
pub(crate) async fn page(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::guest_claims::GuestClaim<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    if let Some(continuation) = place.claim_continuation.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        return claim_with_link(&req, session, &config, &headers, client, &id, continuation).await;
    }
    let viewer = match payment::guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    let receipt = Receipt::from_param(place.after_write.as_deref());
    match read(&req, &viewer, &config, &headers, client, &id, receipt.as_ref()).await {
        Ok(screen) => draw(&req, &viewer, &screen, StatusCode::OK),
        Err(page) => *page,
    }
}

/// A claim link's landing (`claimGuestCheckoutWithClaimContinuation`): signed in at the account's
/// payment, told the link is no longer good, or, when Auth limits the link's tries (429), told to
/// wait. The link may be opened in any browser, so no guest checkout is needed.
async fn claim_with_link(
    req: &Req,
    session: Option<Caller<Session>>,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    continuation: &str,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let body = json!({ "continuation": continuation, "paymentId": id });
    let path = "/api/auth/guest-checkout/claim-with-continuation";
    let error = match call_internal::<Authenticated>(&caller, client, path, body).await {
        Ok((result, receipt)) => return claimed(req, config, id, result, receipt.as_ref()),
        Err(error) => error,
    };
    let viewer = match session {
        Some(Caller(Session::Account(viewer))) => Some(viewer),
        _ => None,
    };
    let (t, p): (PaymentMsg, Pilot) = (req.t(), req.t());
    let (status, title, says) = match error.status() {
        Some(StatusCode::UNAUTHORIZED | StatusCode::BAD_REQUEST) => {
            (StatusCode::UNAUTHORIZED, p.guest_claim_link_expired_title(), p.guest_claim_link_expired())
        }
        Some(StatusCode::TOO_MANY_REQUESTS) => {
            (StatusCode::TOO_MANY_REQUESTS, p.guest_claim_link_rate_limited_title(), p.guest_claim_link_rate_limited())
        }
        _ => return read_failed(req, viewer.as_ref(), error, None),
    };
    let head = html! { <meta name="robots" content="noindex"> };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={viewer.as_ref()} title={title} head={head}>
                <views::PaymentNotice t={t} title={title} says={says} guest={true} />
            </Layout>
        },
    )
}

/// The page drawn again after one of its forms, `change`d (why it did not go through, or the
/// prompt's state), with `status`.
#[allow(clippy::too_many_arguments)]
async fn redraw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    client: Option<ClientIp>,
    id: &str,
    status: StatusCode,
    change: impl FnOnce(&mut ClaimScreen),
) -> HtmlResult {
    match read(req, viewer, config, headers, client, id, None).await {
        Ok(mut screen) => {
            change(&mut screen);
            draw(req, viewer, &screen, status)
        }
        Err(page) => *page,
    }
}

/// The page's forms (the action's intents, see the module). A refusal is the page with why; an
/// intent the page does not draw goes back to the page.
pub(crate) async fn write(
    req: Req,
    session: Option<Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<ClientIp>,
    Params(route): Params<url::guest_claims::GuestClaim<'_>>,
    Form(form): Form<ClaimForm>,
) -> HtmlResult {
    // Lent to each answer that draws the page, the refusals' closures among them.
    let id = route.id;
    let viewer = match payment::guest_payer(&req, session, &id) {
        Ok(viewer) => viewer,
        Err(answer) => return *answer,
    };
    if !matches!(form.intent.as_str(), "claim-link-request" | "claim-link-consume" | "claim-passkey") {
        return req.redirect(&url::GuestClaim { id: &id, place: ClaimPlace::default() });
    }
    let t: PaymentMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let failed = |message: String| {
        let (req, viewer, config, headers, id) = (&req, &viewer, &config, &headers, &id);
        redraw(req, viewer, config, headers, client, id, StatusCode::UNPROCESSABLE_ENTITY, move |screen| {
            screen.error = Some(message)
        })
    };
    let payment = match caller.account_payment(&id).await {
        Ok(Some(payment)) => payment,
        Ok(None) => return payment::not_found(&req, &viewer, Payer::Guest),
        Err(error) if payment::refused_access(&error) => return payment::expired(&req, Some(&viewer)),
        Err(error) => return failed(error.refusal().unwrap_or(t.could_not_save_this_order()).to_owned()).await,
    };
    if payment.status != "captured" {
        return failed(t.you_can_save_this_order_after_payment().to_owned()).await;
    }
    let display_name = form.display_name.trim().to_owned();
    let claim = match form.intent.as_str() {
        "claim-link-request" => {
            // The page's origin, which the emailed link opens (Auth falls back to the site's).
            let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
            let origin = host.map(|host| format!("{}://{host}", config.proto));
            let body = json!({ "paymentId": id, "origin": origin });
            let path = "/api/auth/guest-checkout/claim-link/request";
            return match call_internal::<LinkSent>(&caller, client, path, body).await {
                Ok((sent, _)) => {
                    let p: Pilot = req.t();
                    let token = config.claim_token_entry.then_some(sent.token);
                    redraw(&req, &viewer, &config, &headers, client, &id, StatusCode::OK, move |screen| {
                        match &mut screen.claim {
                            Some(claim) => {
                                claim.link_sent = Some(p.guest_claim_link_sent(&claim.contact_email).to_string());
                                claim.token = token;
                                if !display_name.is_empty() {
                                    claim.display_name = display_name;
                                }
                            }
                            // Auth sent the link but the contact's read after it failed.
                            None => screen.sent = Some(p.guest_claim_link_sent_unread().to_owned()),
                        }
                    })
                    .await
                }
                Err(error) => failed(claim_refusal(&req, "claim-link-request", &error)).await,
            };
        }
        "claim-link-consume" if !config.claim_token_entry => {
            return failed(t.claim_token_entry_is_not_available().to_owned()).await;
        }
        "claim-link-consume" => {
            let body = json!({ "token": form.token.trim(), "paymentId": id, "displayName": display_name });
            call_internal::<Authenticated>(&caller, client, "/api/auth/guest-checkout/claim-with-magic-link", body).await
        }
        // No credential: the step's script did not run, or the browser has no passkeys.
        _ if form.credential().is_missing() => return failed(t.passkey_registration_failed().to_owned()).await,
        _ => {
            let mut body = form.credential().json();
            body.insert("displayName".into(), display_name.into());
            body.insert("email".into(), form.email.trim().into());
            body.insert("paymentId".into(), json!(id));
            body.insert("label".into(), PASSKEY_LABEL.into());
            let path = "/api/auth/guest-checkout/claim-with-passkey";
            call_internal::<Authenticated>(&caller, client, path, Value::Object(body)).await
        }
    };
    match claim {
        Ok((result, receipt)) => claimed(&req, &config, &id, result, receipt.as_ref()),
        Err(error) => failed(claim_refusal(&req, &form.intent, &error)).await,
    }
}
