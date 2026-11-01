//! The buy checkout page (marketplace's `checkout/buy/session/:sessionId`: `checkout-session.tsx`'s
//! loader and action, and `features/sessions/ui/*`'s model and sections) for a signed-in buyer or
//! a guest checkout: the session the Checkout API keeps, the buyer's saved addresses and payment
//! methods, the wallet, and Payments' quote for the payable total; Update totals (the review
//! writes) and Pay now. A guest has no saved address, payment method or wallet, so every step is a
//! form and Pay now refuses a saved method (`GUEST_SAVED_PAYMENT_UNAVAILABLE`); its payment page is
//! `/checkout/payments/{id}`.
//!
//! A purchase intent (an offer's checkout, `source_type` `offer-intent`, marketplace's
//! `isOfferIntent`) makes no order and takes no payment: every step but payment is a form (it is
//! neither a signed-in buy checkout nor a guest's, so nothing collapses into a row), the email is
//! optional, the summary prices each line at its offer and says No payment today, and Submit offer
//! confirms it. The Checkout API submits the offer; the page then shows it, read after the write.
//! The wallet, saved addresses, saved methods and Payments' quote are not read for it, as
//! marketplace's page shows none of them.
//!
//! A guest's contact is not read: marketplace's loader asks Auth for it without the internal
//! capability the call needs, so it is always empty there too, and no host binds one yet
//! (chase-sets/chase-sets#5736).
//!
//! Every step is a form field of one POST form, so the page works without a script; a step that
//! is ready shows as a row whose Edit is a link (`?edit=delivery`, marketplace's `edit`). The
//! payment starts when the buyer presses Pay now, never as the page loads (marketplace's page
//! submits Pay now itself, chase-sets/chase-sets#10581). Payments quotes the fee
//! (`/account/checkout/preview-status`), where marketplace's loader quotes the compiled default
//! policy (chase-sets/chase-sets#10683).
//!
//! Checkout received (`/checkout/buy/session/{id}/confirmation`, marketplace's
//! `buy-checkout-confirmation.tsx`) is where Pay now with a saved card that needs no secure step
//! lands, as marketplace's action sends it there (`acceleratedSavedPayment`); any other Pay now
//! comes back to the checkout page. It shows the started payment's references, total and status,
//! and Continue to payment, the pilot's payment page (`payment`).
use std::time::SystemTime;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    i18n::parse_timestamp,
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, CheckoutSession, CheckoutSessions as _, ConfirmBody, FulfillmentPreview, PaymentPreview, PaymentSummary,
        SavedAddress, SavedInstrument, SellerGroup, SessionAddress, Wallet,
    },
    app::{ACCOUNTS_VIEW, ORDERS_MANAGE, PAYOUTS_VIEW, Shared, sign_in, url},
    auth::{CheckoutBuyer, Viewer},
    text::{CheckoutMsg, Pilot},
    views::{self, Layout},
};

/// A saved address picked, or `__manual` for the one typed into the form.
pub const MANUAL: &str = "__manual";
/// The payment methods Payments quotes, in its order.
pub const METHODS: [&str; 3] = ["card", "bank-account", "platform-credit"];
/// The shipping options, in the form's order.
pub const SHIPPING: [&str; 3] = ["standard", "expedited", "priority"];

/// The page's address: the write it reads after, the payment method on screen, what the last
/// write did (`review=updated`, `quote=required`) and the step opened for editing.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub after_write: Option<String>,
    pub payment_method_category: Option<String>,
    pub review: Option<String>,
    pub quote: Option<String>,
    pub edit: Option<String>,
}

impl Place {
    /// The page after a write: read after `receipt`, with the payment method the form showed.
    fn after(receipt: Option<&Receipt>, method: &str) -> Place {
        Place {
            after_write: receipt.map(Receipt::param),
            payment_method_category: Some(method.to_owned()).filter(|m| !m.is_empty()),
            ..Place::default()
        }
    }

    /// The page for a session just started, read after its start's receipt.
    pub fn started(receipt: Option<&Receipt>) -> Place {
        Place { after_write: receipt.map(Receipt::param), ..Place::default() }
    }

    /// The page after the review was written again: it says so, and that the total changed
    /// when Payments asked for a new quote.
    fn reviewed(receipt: Option<&Receipt>, method: &str, quote: bool) -> Place {
        Place { review: Some("updated".into()), quote: quote.then(|| "required".into()), ..Place::after(receipt, method) }
    }

    pub fn edit(&self) -> Option<Edit> {
        match self.edit.as_deref() {
            Some("contact") => Some(Edit::Contact),
            Some("delivery") => Some(Edit::Delivery),
            Some("shipping") => Some(Edit::Shipping),
            Some("payment") => Some(Edit::Payment),
            _ => None,
        }
    }

    /// The same page with `step` open for editing.
    pub fn editing(&self, step: Edit) -> Place {
        Place { edit: Some(step.key().into()), after_write: None, review: None, quote: None, ..self.clone() }
    }
}

/// A step that is ready, opened again (`CheckoutEditSection`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edit {
    Contact,
    Delivery,
    Shipping,
    Payment,
}

impl Edit {
    pub fn key(self) -> &'static str {
        match self {
            Edit::Contact => "contact",
            Edit::Delivery => "delivery",
            Edit::Shipping => "shipping",
            Edit::Payment => "payment",
        }
    }
}

/// The form's fields, named as marketplace's form names them.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckoutForm {
    pub intent: String,
    pub shipping_address_id: String,
    pub shipping_name: String,
    pub shipping_company: String,
    pub shipping_line1: String,
    pub shipping_line2: String,
    pub shipping_city: String,
    pub shipping_state: String,
    pub shipping_postal_code: String,
    pub shipping_country: String,
    pub shipping_phone: String,
    pub shipping_email: String,
    pub shipping_option: String,
    pub authenticity_check_opt_in: String,
    pub authenticity_check_opt_in_quote_fingerprint: String,
    /// The method the form shows.
    pub preview_payment_method_category: String,
    /// The method the shown quote is for.
    pub payment_method_category: String,
    pub saved_checkout_instrument_id: String,
    pub save_payment_method_for_future: String,
    pub requested_balance_credit_amount: String,
    pub marketplace_checkout_fee_quote_fingerprint: String,
    pub fulfillment_preview_revision: String,
    pub acknowledged_material_changes: String,
    pub reviewed_shipping_option: String,
    pub reviewed_shipping_address_signature: String,
    /// `true` when Pay now uses a saved card that needs no secure step: it lands on Checkout
    /// received.
    pub accelerated_saved_payment: String,
}

fn text(value: &str) -> Option<String> {
    Some(value.trim().to_owned()).filter(|v| !v.is_empty())
}

impl CheckoutForm {
    /// The address as typed (`shippingAddressFromForm`).
    fn typed(&self) -> SessionAddress {
        SessionAddress {
            shipping_address_id: None,
            name: self.shipping_name.trim().to_owned(),
            company: text(&self.shipping_company),
            line1: self.shipping_line1.trim().to_owned(),
            line2: text(&self.shipping_line2),
            city: self.shipping_city.trim().to_owned(),
            state: self.shipping_state.trim().to_uppercase(),
            postal_code: self.shipping_postal_code.trim().to_owned(),
            country: text(&self.shipping_country).map_or_else(|| "US".to_owned(), |c| c.to_uppercase()),
            phone: text(&self.shipping_phone),
            email: text(&self.shipping_email),
        }
    }

    /// The address the session is given (`resolveCheckoutShippingAddress` for "use for this
    /// checkout"): a saved address picked is used as saved; otherwise the typed one, which keeps
    /// the saved address's id it was edited from.
    fn address(&self, saved: &[SavedAddress]) -> SessionAddress {
        let picked = text(&self.shipping_address_id).filter(|id| id != MANUAL);
        match picked.as_deref().and_then(|id| saved.iter().find(|a| a.shipping_address_id == id)) {
            Some(address) => from_saved(address),
            None => SessionAddress { shipping_address_id: None, ..self.typed() },
        }
    }

    fn shipping_option(&self) -> &str {
        let option = self.shipping_option.trim();
        if SHIPPING.contains(&option) { option } else { "standard" }
    }

    fn opted_in(&self) -> bool {
        self.authenticity_check_opt_in == "true"
    }

    fn quote(&self) -> Option<&str> {
        Some(self.authenticity_check_opt_in_quote_fingerprint.trim()).filter(|q| !q.is_empty())
    }

    /// The method on screen, and the one its quote is for.
    fn methods(&self) -> (&str, &str) {
        let quoted = Some(self.payment_method_category.trim()).filter(|m| !m.is_empty()).unwrap_or("card");
        let visible = Some(self.preview_payment_method_category.trim()).filter(|m| !m.is_empty()).unwrap_or(quoted);
        (visible, quoted)
    }
}

/// A saved address as the session takes it (`shippingAddressFromSavedAddress`).
pub fn from_saved(address: &SavedAddress) -> SessionAddress {
    SessionAddress {
        shipping_address_id: Some(address.shipping_address_id.clone()),
        name: address.recipient_name.clone(),
        company: address.company.clone(),
        line1: address.line1.clone(),
        line2: address.line2.clone(),
        city: address.city.clone(),
        state: address.state.clone(),
        postal_code: address.postal_code.clone(),
        country: address.country.clone(),
        phone: address.phone.clone(),
        email: address.email.clone(),
    }
}

/// What the review was drawn for, to tell whether the address changed since
/// (`normalizedAddressSignature`): the normalized fields as a JSON array, printable in an
/// attribute and unambiguous.
pub fn signature(address: &SessionAddress) -> String {
    let field = |value: Option<&String>| value.map_or("", |v| v.trim()).to_owned();
    let fields = [
        address.name.trim().to_owned(),
        field(address.company.as_ref()),
        address.line1.trim().to_owned(),
        field(address.line2.as_ref()),
        address.city.trim().to_owned(),
        address.state.trim().to_uppercase(),
        address.postal_code.trim().to_owned(),
        address.country.trim().to_uppercase(),
        field(address.phone.as_ref()),
        field(address.email.as_ref()).to_lowercase(),
    ];
    serde_json::to_string(&fields).unwrap_or_default()
}

/// Everything a delivery needs (`addressIsComplete`).
pub fn complete(address: &SessionAddress) -> bool {
    [&address.name, &address.line1, &address.city, &address.state, &address.postal_code, &address.country]
        .iter()
        .all(|v| !v.trim().is_empty())
}

/// The wallet, when the buyer may see payouts.
pub enum WalletRead {
    NotAsked,
    Read(Wallet),
    Unavailable,
}

/// The page's one notice, by marketplace's priority (`buildCheckoutNoticeCandidates`).
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    /// Lines the preview cannot fulfill: review the buy cart.
    CartReview(usize),
    /// What changed since the last preview, in the API's words.
    FulfillmentChanged(Option<String>),
    QuoteRequired,
    ReviewUpdated,
    /// A saved address and a saved method that pays in one step.
    FastCheckout {
        address: String,
        method: String,
    },
    /// A saved address and a saved method that needs its secure step.
    SavedPayment {
        address: String,
        method: String,
    },
    SavedAddress(String),
}

/// The steps: which are ready, and which show their form.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Steps {
    pub contact: bool,
    pub delivery: bool,
    pub shipping: bool,
    pub payment: bool,
    pub show_contact: bool,
    pub show_delivery: bool,
    pub show_shipping: bool,
    pub show_payment: bool,
}

impl Steps {
    pub fn rows(&self) -> bool {
        self.contact || self.delivery || self.shipping || self.payment
    }
}

/// The page, worked out from the reads (`useCheckoutSessionModel` for a signed-in buyer).
pub struct Screen {
    pub session: CheckoutSession,
    /// A purchase intent: an offer for sellers to accept, not orders and a payment.
    pub offer: bool,
    pub preview: Option<FulfillmentPreview>,
    /// A session that creates orders but recorded no preview yet.
    pub preview_missing: bool,
    pub payment: Option<PaymentPreview>,
    pub wallet: Option<Wallet>,
    pub wallet_unavailable: bool,
    pub addresses: Vec<SavedAddress>,
    pub address: SessionAddress,
    pub methods: Vec<String>,
    pub method: String,
    pub instrument: Option<SavedInstrument>,
    pub instruments: Vec<SavedInstrument>,
    pub can_save_payment: bool,
    /// A guest checkout, not an account.
    pub guest: bool,
    pub accelerated: bool,
    pub steps: Steps,
    pub can_confirm: bool,
    pub needs_quote: bool,
    pub acknowledged: bool,
    pub notice: Option<Notice>,
    pub expired: bool,
    pub error: Option<String>,
    /// Pay now may have reached Checkout, but one read of the session showed neither a payment
    /// nor an offer: Pay now is off until the buyer refreshes (`confirmationAmbiguous`).
    pub ambiguous: bool,
    pub place: Place,
}

/// What the reads found, before the page is worked out.
pub struct Reads {
    pub session: CheckoutSession,
    pub wallet: WalletRead,
    pub addresses: Vec<SavedAddress>,
    pub instruments: Vec<SavedInstrument>,
    pub payment: Option<PaymentPreview>,
    pub can_save_payment: bool,
    pub guest: bool,
    pub expired: bool,
}

/// Whether the session's handoff expired before it made orders (`isExpiredCheckoutHandoff`).
pub fn expired(session: &CheckoutSession, now: SystemTime) -> bool {
    session.order_ids.is_empty() && session.handoff_expires_at.as_deref().and_then(parse_timestamp).is_some_and(|at| at <= now)
}

/// Whether the session made anything a review must not change (`hasCommittedCheckoutSideEffects`).
fn committed(session: &CheckoutSession) -> bool {
    session.payment_id.is_some() || session.submitted_offer_id.is_some() || !session.order_ids.is_empty()
}

/// The method the address asks for, or the default saved method's, or a card.
fn asked_method(place: &Place, instruments: &[SavedInstrument]) -> String {
    let ready = |i: &&SavedInstrument| i.readiness == "ready";
    place
        .payment_method_category
        .clone()
        .or_else(|| instruments.iter().filter(ready).find(|i| i.is_default).map(|i| i.payment_method_category.clone()))
        .or_else(|| instruments.iter().find(ready).map(|i| i.payment_method_category.clone()))
        .unwrap_or_else(|| "card".into())
}

impl Screen {
    pub fn new(reads: Reads, place: Place, error: Option<String>) -> Screen {
        let Reads { session, wallet, addresses, instruments, payment, can_save_payment, guest, expired } = reads;
        let offer = session.source_type == "offer-intent";
        let creates_orders = !offer;
        let preview = if expired || !creates_orders { None } else { session.fulfillment_preview_snapshot.clone() };
        let preview_missing = !expired && creates_orders && preview.is_none();
        let (addresses, instruments) = if offer { (Vec::new(), Vec::new()) } else { (addresses, instruments) };
        let wallet_unavailable = matches!(wallet, WalletRead::Unavailable);
        let wallet = match wallet {
            WalletRead::Read(wallet) => Some(wallet),
            _ => None,
        };
        let has_payment = session.payment_id.is_some();
        let payment = if wallet_unavailable && !has_payment { None } else { payment };

        // The methods Payments quoted, else card and bank account; the one asked for when quoted.
        let mut methods: Vec<String> = Vec::new();
        for quote in payment.iter().flat_map(|p| &p.payment_method_quotes) {
            if !methods.contains(&quote.payment_method_category) {
                methods.push(quote.payment_method_category.clone());
            }
        }
        if methods.is_empty() {
            methods = vec!["card".into(), "bank-account".into()];
        }
        let asked = asked_method(&place, &instruments);
        let asked = if METHODS.contains(&asked.as_str()) { asked } else { "card".into() };
        let selected = if methods.contains(&asked) { asked } else { methods[0].clone() };
        let ready: Vec<SavedInstrument> =
            instruments.into_iter().filter(|i| i.readiness == "ready" && methods.contains(&i.payment_method_category)).collect();
        let for_selected = || ready.iter().filter(|i| i.payment_method_category == selected);
        let instrument = for_selected()
            .find(|i| i.is_default)
            .or_else(|| for_selected().next())
            .or_else(|| ready.iter().find(|i| i.is_default))
            .or_else(|| ready.first())
            .cloned();
        let method = instrument.as_ref().map_or(selected.clone(), |i| i.payment_method_category.clone());
        let instruments: Vec<SavedInstrument> = ready.into_iter().filter(|i| i.payment_method_category == method).collect();

        // The form starts from the session's address, else the default saved one.
        let saved = addresses
            .iter()
            .find(|a| Some(&a.shipping_address_id) == session.shipping_address_id.as_ref())
            .or_else(|| addresses.iter().find(|a| a.is_default))
            .or_else(|| addresses.first());
        let address = match (&session.shipping_address, saved) {
            (Some(address), _) => address.clone(),
            (None, Some(saved)) => from_saved(saved),
            (None, None) => SessionAddress { country: "US".into(), ..SessionAddress::default() },
        };

        let edit = place.edit();
        let first_group = preview.as_ref().and_then(|p| p.seller_groups.first()).is_some();
        // A guest's steps other than its contact are never rows (`signedInBuyCheckout`), and its
        // contact cannot be opened again (`canEditCollapsedContact`). A purchase intent's steps are
        // all forms, and it has no payment step.
        let rows = !guest && !offer;
        let contact = !offer && address.email.as_deref().is_some_and(|e| !e.trim().is_empty());
        let delivery = rows && complete(&address);
        let first_group = rows && first_group;
        let payment_ready = rows && instrument.is_some();
        let steps = Steps {
            contact,
            delivery,
            shipping: first_group,
            payment: payment_ready,
            show_contact: !contact || (!guest && edit == Some(Edit::Contact)),
            show_delivery: !delivery || edit == Some(Edit::Delivery),
            show_shipping: !first_group || edit == Some(Edit::Shipping),
            show_payment: !offer && (!payment_ready || edit == Some(Edit::Payment)),
        };

        let lines = session.lines.len();
        let ready_count = preview.as_ref().map_or(lines, |p| p.ready_line_keys.len());
        let unavailable = preview.as_ref().map_or(0, |p| p.unavailable_lines.len().max(p.unavailable_line_keys.len()));
        let can_confirm = if offer { lines > 0 } else { ready_count > 0 && unavailable == 0 };
        let needs_quote = !offer && !has_payment && payment.is_none();
        let changed = match (&preview, &session.fulfillment_preview_revision) {
            (Some(p), Some(recorded)) => p.revision.as_ref().is_some_and(|r| r != recorded),
            _ => false,
        };
        let reasons = preview.as_ref().map(|p| p.material_change_reasons.join(" ")).filter(|r| !r.is_empty());
        let acknowledged = reasons.is_some() || changed;
        let fast = !offer && saved.is_some() && instrument.is_some() && !has_payment;
        let accelerated = fast
            && !wallet_unavailable
            && payment.is_some()
            && instrument.as_ref().is_some_and(|i| i.confirmation_experience == "off-session-token");
        let label = saved.map(|a| a.label.clone()).unwrap_or_default();
        let method_label = instrument.as_ref().map_or_else(|| method.replace('-', " "), |i| i.display_label.clone());
        let notice = if offer {
            None
        } else if unavailable > 0 {
            Some(Notice::CartReview(unavailable))
        } else if acknowledged {
            Some(Notice::FulfillmentChanged(reasons))
        } else if place.quote.as_deref() == Some("required") {
            Some(Notice::QuoteRequired)
        } else if place.review.as_deref() == Some("updated") {
            Some(Notice::ReviewUpdated)
        } else if steps.rows() {
            None
        } else if accelerated {
            Some(Notice::FastCheckout { address: label, method: method_label })
        } else if fast {
            Some(Notice::SavedPayment { address: label, method: method_label })
        } else if saved.is_some() && instrument.is_none() && !has_payment {
            Some(Notice::SavedAddress(label))
        } else {
            None
        };

        Screen {
            session,
            offer,
            preview,
            preview_missing,
            payment,
            wallet,
            wallet_unavailable,
            addresses,
            address,
            methods,
            method,
            instrument,
            instruments,
            can_save_payment,
            guest,
            accelerated,
            steps,
            can_confirm,
            needs_quote,
            acknowledged,
            notice,
            expired,
            error,
            ambiguous: false,
            place,
        }
    }

    pub fn first_group(&self) -> Option<&SellerGroup> {
        self.preview.as_ref().and_then(|p| p.seller_groups.first())
    }

    /// The payable total: Payments' quote, else the preview's.
    pub fn total(&self) -> Option<&str> {
        self.payment
            .as_ref()
            .map(|p| p.marketplace_checkout_fee.total_amount.as_str())
            .or_else(|| self.preview.as_ref().and_then(|p| p.totals.total_amount.as_deref()))
    }

    /// The authenticity check is offered, and chosen.
    pub fn authenticity(&self) -> (bool, bool) {
        let eligible = self.preview.as_ref().and_then(|p| p.authenticity_check_offer.as_ref()).is_some_and(|o| o.eligible);
        let selected = self.session.authenticity_check_opt_in.as_ref().is_some_and(|o| o.selected);
        (eligible, eligible && selected)
    }
}

/// The session's reference for support (`buyCheckoutSupportReference`): the split group's, or a
/// fulfillment group's from the cart's readiness.
pub fn support_reference(session: &CheckoutSession) -> Option<String> {
    let trimmed = |v: &serde_json::Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    session.split_group_handoff.as_ref().and_then(|h| h.get("supportReference")).and_then(trimmed).or_else(|| {
        session
            .cart_readiness_snapshot
            .as_ref()
            .and_then(|s| s.get("fulfillmentGroups"))
            .and_then(|g| g.as_array())
            .and_then(|groups| groups.iter().filter_map(|g| g.get("supportReference")).find_map(trimmed))
    })
}

fn ended(error: &ApiError) -> bool {
    error.status() == Some(StatusCode::UNAUTHORIZED)
}

/// A page that is not the checkout: a session that is not there, someone else's, or one whose
/// write the API has not caught up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    NotFound,
    WrongAccount,
    Preparing,
    Unavailable,
}

async fn recovery(req: &Req, viewer: &Viewer, kind: Recovery, chrome: &Chrome) -> HtmlResult {
    let t: CheckoutMsg = req.t();
    let status = match kind {
        Recovery::NotFound => StatusCode::NOT_FOUND,
        Recovery::WrongAccount => StatusCode::FORBIDDEN,
        Recovery::Preparing => StatusCode::ACCEPTED,
        Recovery::Unavailable => StatusCode::BAD_GATEWAY,
    };
    let head = html! {
        <meta name="robots" content="noindex">
        {(kind == Recovery::Preparing).then_some(ReadAgain { after: std::time::Duration::from_secs(2) })}
    };
    let cart = chrome.cart().await;
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_checkout_marketplace()} head={head}>
                <views::CheckoutRecovery t={t} kind={kind} />
            </Layout>
        },
    )
}

/// What a write left for the page to say at its top.
enum Answer {
    Nothing,
    /// The page's status and what the write was refused for.
    Refused(StatusCode, String),
    /// Pay now may have reached Checkout and one read could not tell.
    Ambiguous,
}

/// Reads the session and what the page shows with it, then draws it with `answer`.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: Place,
    answer: Answer,
    chrome: &Chrome,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let waiting = config.platform.caller(headers, config.proto, receipt.as_ref());
    let caller = config.platform.caller(headers, config.proto, None);
    let session = match waiting.checkout_session(id).await {
        Ok(session) => session,
        Err(error) if ended(&error) => return sign_in(req),
        Err(error) if receipt.is_some() && error.catching_up() => {
            return recovery(req, viewer, Recovery::Preparing, chrome).await;
        }
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return recovery(req, viewer, Recovery::NotFound, chrome).await;
        }
        // A guest whose checkout is no longer its own starts again (the loader's 403 for a guest).
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) && viewer.guest() => {
            return req.redirect(&url::CheckoutStart);
        }
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return recovery(req, viewer, Recovery::WrongAccount, chrome).await;
        }
        Err(error) => {
            tracing::warn!("the checkout session could not be read: {error}");
            return recovery(req, viewer, Recovery::Unavailable, chrome).await;
        }
    };
    if let Some(offer) = &session.submitted_offer_id {
        return req.redirect(&submitted_offer(offer, receipt.as_ref()));
    }
    let offer = session.source_type == "offer-intent";
    let expired = expired(&session, SystemTime::now());
    let actor = &viewer.actor;
    let guest = viewer.guest();
    let wallet = async {
        if offer || guest || !actor.can(PAYOUTS_VIEW) {
            return WalletRead::NotAsked;
        }
        match caller.wallet().await {
            Ok(w) if platform::money::decimal(&w.available_balance_amount).is_some() && w.currency_code.trim().len() == 3 => {
                WalletRead::Read(Wallet { currency_code: w.currency_code.trim().to_lowercase(), ..w })
            }
            Ok(_) => WalletRead::Unavailable,
            Err(error) => {
                tracing::warn!("the wallet could not be read: {error}");
                WalletRead::Unavailable
            }
        }
    };
    let addresses = async {
        if offer || guest || !actor.can(ACCOUNTS_VIEW) {
            return Vec::new();
        }
        caller.checkout_addresses().await.unwrap_or_else(|error| {
            tracing::warn!("the saved addresses could not be read: {error}");
            Vec::new()
        })
    };
    let instruments = async {
        if offer || guest {
            return Vec::new();
        }
        caller.checkout_instruments().await.unwrap_or_else(|error| {
            tracing::warn!("the saved payment methods could not be read: {error}");
            Vec::new()
        })
    };
    let (wallet, addresses, instruments) = tokio::join!(wallet, addresses, instruments);
    // Payments' quote for the preview's total, the wallet's balance applied (`loadPaymentPreview`).
    let total = session.fulfillment_preview_snapshot.as_ref().and_then(|p| p.totals.total_amount.clone());
    let payment = match (&total, &wallet, expired) {
        (Some(_), WalletRead::Unavailable, _) | (None, _, _) | (_, _, true) => None,
        (Some(total), wallet, false) => {
            let (currency, credit) = match wallet {
                WalletRead::Read(w) => (w.currency_code.as_str(), w.available_balance_amount.as_str()),
                _ => ("usd", "0.00"),
            };
            let method = asked_method(&place, &instruments);
            caller
                .payment_preview(total, currency, credit, &method)
                .await
                .map_err(|error| tracing::warn!("the payment quote could not be read: {error}"))
                .ok()
        }
    };
    let can_save_payment = !offer && !guest && actor.can(ORDERS_MANAGE);
    let reads = Reads { session, wallet, addresses, instruments, payment, can_save_payment, guest, expired };
    let (status, error) = match &answer {
        Answer::Refused(status, error) => (*status, Some(error.clone())),
        Answer::Nothing | Answer::Ambiguous => (StatusCode::OK, None),
    };
    let mut screen = Screen::new(reads, place, error);
    screen.ambiguous = matches!(answer, Answer::Ambiguous);
    let t: CheckoutMsg = req.t();
    let description = if screen.offer {
        t.page_confirm_shipping_place_purchase_intent()
    } else {
        t.route_enter_contact_delivery_shipping_payment()
    };
    let head = html! {
        <meta name="description" content={description}>
        <meta name="robots" content="noindex">
    };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_checkout_marketplace()} head={head}>
            <views::CheckoutPage t={t} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// Checkout received's address: the receipt of the Pay now it reads after.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationPlace {
    pub after_write: Option<String>,
}

/// Checkout received: the session's orders and support reference, the started payment, its
/// summary when Payments has one, and marketplace's payment page for it.
#[derive(Serialize, ToJson)]
pub struct ConfirmationScreen {
    pub session_id: String,
    pub order_ids: Vec<String>,
    pub payment_id: String,
    pub support_reference: Option<String>,
    pub payment: Option<PaymentSummary>,
    #[serde(skip)]
    pub payment_href: String,
}

/// Checkout received (marketplace's confirmation loader): the session read after Pay now's
/// receipt, a submitted offer's page for an offer's checkout, the checkout page while no payment
/// has started, else the payment's references and Continue to payment.
pub(crate) async fn confirmation(
    req: Req,
    chrome: Chrome,
    Caller(CheckoutBuyer(viewer)): Caller<CheckoutBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::checkout::BuyConfirmation<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let waiting = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let session = match waiting.checkout_session(&id).await {
        Ok(session) => session,
        Err(error) if ended(&error) => return sign_in(&req),
        Err(error) if receipt.is_some() && error.catching_up() => {
            return recovery(&req, &viewer, Recovery::Preparing, &chrome).await;
        }
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return recovery(&req, &viewer, Recovery::NotFound, &chrome).await;
        }
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return recovery(&req, &viewer, Recovery::WrongAccount, &chrome).await;
        }
        Err(error) => {
            tracing::warn!("the checkout session could not be read: {error}");
            return recovery(&req, &viewer, Recovery::Unavailable, &chrome).await;
        }
    };
    if let Some(offer) = &session.submitted_offer_id {
        return req.redirect(&submitted_offer(offer, receipt.as_ref()));
    }
    let Some(payment_id) = session.payment_id.clone() else {
        return req.redirect(&url::BuyCheckout { id: &id, place: Place::default() });
    };
    // Best effort, as marketplace's: a failed summary is Pending and Preparing payment.
    let caller = config.platform.caller(&headers, config.proto, None);
    let payment = caller.checkout_payment_summary(&payment_id).await.ok();
    let after_write = place.after_write.clone().filter(|a| !a.is_empty());
    let payment_href = payment_href(viewer.guest(), &payment_id, after_write);
    let screen = ConfirmationScreen {
        support_reference: support_reference(&session),
        session_id: session.session_id,
        order_ids: session.order_ids,
        payment_id,
        payment,
        payment_href,
    };
    let t: CheckoutMsg = req.t();
    let view = html! { <views::BuyConfirmationPage t={t} screen={&screen} /> };
    let head = html! { <meta name="description" content={t.confirmation_route_description()}> };
    let cart = chrome.cart().await;
    req.screen(
        &screen,
        html! {
            <Layout req={&req} viewer={Some(&viewer)} cart={cart} title={t.confirmation_route_title()} head={head}>{view}</Layout>
        },
    )
}

/// The payment's page, read after `after_write`: an account's, or a guest checkout's
/// (`paymentPathForActor`).
pub fn payment_href(guest: bool, id: &str, after_write: Option<String>) -> String {
    if guest {
        url::GuestPayment { id, place: crate::payment::GuestPlace { after_write, ..Default::default() } }.href()
    } else {
        url::BuyerPayment { id, place: crate::payment::Place { after_write } }.href()
    }
}

/// The offer a purchase intent became, read after `receipt`.
fn submitted_offer<'a>(id: &'a str, receipt: Option<&Receipt>) -> url::SubmittedOffer<'a> {
    url::SubmittedOffer { id, place: crate::submitted_offers::OfferPlace { after_write: receipt.map(Receipt::param) } }
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(CheckoutBuyer(viewer)): Caller<CheckoutBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::checkout::BuyCheckout<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    render(&req, &viewer, &config, &headers, &id, place, Answer::Nothing, &chrome).await
}

/// What a review write was refused for, in the page's words: an address or shipping option the
/// API cannot deliver to opens its step again (`deliveryCorrectionActionData`).
fn correction(t: CheckoutMsg, error: &ApiError) -> Option<(String, Edit)> {
    let (message, step) = match error.code()? {
        "shipping_address_required" => (t.route_delivery_address_required(), Edit::Delivery),
        "shipping_address_unsupported" => (t.route_delivery_address_unsupported(), Edit::Delivery),
        "shipping_address_restricted" => (t.route_delivery_address_restricted(), Edit::Delivery),
        "shipping_option_unavailable" => (t.route_shipping_option_unavailable(), Edit::Shipping),
        _ => return None,
    };
    Some((message.to_owned(), step))
}

/// A field the form sent, unless it is empty.
fn reviewed(value: &str) -> Option<&str> {
    Some(value.trim()).filter(|v| !v.is_empty())
}

/// The receipt the next read waits for, of every write that sent one.
fn latest(receipts: impl IntoIterator<Item = Option<Receipt>>) -> Option<Receipt> {
    receipts.into_iter().flatten().reduce(Receipt::later)
}

/// Update totals and Pay now (marketplace's action's `refresh-checkout-preview` and
/// `confirm-checkout`), and Retry wallet balance, which reads the page again.
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    Caller(CheckoutBuyer(viewer)): Caller<CheckoutBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::checkout::BuyCheckout<'_>>,
    Form(form): Form<CheckoutForm>,
) -> HtmlResult {
    // Lent to each answer that draws the page, the refusals' closures among them.
    let chrome = &chrome;
    let id = route.id;
    let t: CheckoutMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let (visible, quoted) = form.methods();
    let (visible, quoted) = (visible.to_owned(), quoted.to_owned());
    let back = |place: Place| req.redirect(&url::BuyCheckout { id: &id, place });
    if form.intent == "retry-wallet-balance" {
        return back(Place::after(None, &visible));
    }
    let saved = if viewer.actor.can(ACCOUNTS_VIEW) && text(&form.shipping_address_id).is_some_and(|id| id != MANUAL) {
        caller.checkout_addresses().await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let address = form.address(&saved);
    let option = form.shipping_option().to_owned();
    let refused = |error: ApiError, place: Place| {
        let config = config.clone();
        let (req, viewer, headers, id) = (&req, &viewer, &headers, &id);
        async move {
            if ended(&error) {
                return sign_in(req);
            }
            let (message, place) = match correction(t, &error) {
                Some((message, step)) => (message, Place { edit: Some(step.key().into()), ..place }),
                None => (error.refusal().unwrap_or(t.route_request_failed()).to_owned(), place),
            };
            tracing::warn!("a checkout write was refused: {error}");
            render(req, viewer, &config, headers, id, place, Answer::Refused(StatusCode::UNPROCESSABLE_ENTITY, message), chrome)
                .await
        }
    };
    let here = Place { payment_method_category: Some(visible.clone()), ..Place::default() };
    match form.intent.as_str() {
        "refresh-checkout-preview" => {
            let session = match caller.checkout_session(&id).await {
                Ok(session) => session,
                Err(error) => return refused(error, here).await,
            };
            let writes = async {
                let a = caller.select_shipping_option(&id, &option).await?;
                let b = caller.select_shipping_address(&id, &address).await?;
                let c = select_authenticity_check(&caller, &session, &form).await?;
                Ok::<_, ApiError>([a, b, c])
            };
            match writes.await {
                Ok(receipts) => {
                    let preview = record_preview(&caller, &session, &option, &address).await;
                    back(Place::after(latest(receipts.into_iter().chain([preview])).as_ref(), &visible))
                }
                Err(error) => refused(error, here).await,
            }
        }
        // A guest has no saved payment method and cannot save one (`GUEST_SAVED_PAYMENT_UNAVAILABLE`).
        "confirm-checkout"
            if viewer.guest()
                && (reviewed(&form.saved_checkout_instrument_id).is_some() || form.save_payment_method_for_future == "true") =>
        {
            let p: Pilot = req.t();
            let refused = Answer::Refused(StatusCode::UNPROCESSABLE_ENTITY, p.guest_saved_payment_unavailable().to_owned());
            render(&req, &viewer, &config, &headers, &id, here, refused, chrome).await
        }
        "confirm-checkout" => {
            let session = match caller.checkout_session(&id).await {
                Ok(session) => session,
                Err(error) => return refused(error, here).await,
            };
            if expired(&session, SystemTime::now()) {
                let message = t.recovery_checkout_handoff_expired_description().to_owned();
                return render(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    &id,
                    here,
                    Answer::Refused(StatusCode::CONFLICT, message),
                    chrome,
                )
                .await;
            }
            // A cancelled session is final: a confirm sent again sends nothing and shows it as it is.
            if session.cancelled_at.is_some() {
                return back(here);
            }
            let committed = committed(&session);
            let mut receipts = Vec::new();
            if !committed {
                let writes = async {
                    let a = caller.select_shipping_option(&id, &option).await?;
                    let b = select_authenticity_check(&caller, &session, &form).await?;
                    Ok::<_, ApiError>([a, b])
                };
                match writes.await {
                    Ok(written) => receipts.extend(written),
                    Err(error) => return refused(error, here).await,
                }
            }
            // A purchase intent has no totals to refresh first (`shouldRefreshReviewBeforeConfirm`).
            let offer = session.source_type == "offer-intent";
            let review_changed = !offer
                && (visible != quoted
                    || reviewed(&form.reviewed_shipping_option).is_some_and(|o| o != option)
                    || reviewed(&form.reviewed_shipping_address_signature).is_some_and(|s| s != signature(&address)));
            let fingerprint = reviewed(&form.marketplace_checkout_fee_quote_fingerprint).map(str::to_owned);
            let needs_quote =
                !session.source_type.is_empty() && !offer && fingerprint.is_none() && session.payment_id.is_none() && !committed;
            if (review_changed && !committed) || needs_quote {
                match caller.select_shipping_address(&id, &address).await {
                    Ok(receipt) => receipts.push(receipt),
                    Err(error) => return refused(error, here).await,
                }
                receipts.push(record_preview(&caller, &session, &option, &address).await);
                return back(Place::reviewed(latest(receipts).as_ref(), &visible, needs_quote));
            }
            let instrument = reviewed(&form.saved_checkout_instrument_id).map(str::to_owned);
            let body = ConfirmBody {
                requested_balance_credit_amount: reviewed(&form.requested_balance_credit_amount).map(str::to_owned),
                payment_method_category: quoted.clone(),
                marketplace_checkout_fee_quote_fingerprint: fingerprint,
                save_payment_method_for_future: form.save_payment_method_for_future == "true" && instrument.is_none(),
                saved_checkout_instrument_id: instrument,
                fulfillment_preview_revision: reviewed(&form.fulfillment_preview_revision).map(str::to_owned),
                acknowledged_material_changes: form.acknowledged_material_changes == "true",
                shipping_address: address,
            };
            match caller.confirm_checkout(&id, &body).await {
                Ok((confirmed, receipt)) => {
                    receipts.push(receipt);
                    match (confirmed.offer_id, confirmed.payment_id) {
                        (Some(offer), _) => req.redirect(&submitted_offer(&offer, latest(receipts).as_ref())),
                        (None, Some(_)) if form.accelerated_saved_payment == "true" => {
                            let place = ConfirmationPlace { after_write: latest(receipts).as_ref().map(Receipt::param) };
                            req.redirect(&url::BuyConfirmation { id: &id, place })
                        }
                        (None, Some(_)) => back(Place::after(latest(receipts).as_ref(), &visible)),
                        (None, None) => {
                            tracing::warn!("Pay now answered without a payment or an offer");
                            render(
                                &req,
                                &viewer,
                                &config,
                                &headers,
                                &id,
                                here,
                                Answer::Refused(StatusCode::BAD_GATEWAY, t.route_request_failed().to_owned()),
                                chrome,
                            )
                            .await
                        }
                    }
                }
                // Payments asked for a new quote, or the payment is still starting: the page again,
                // read after what was written (marketplace's refresh paths).
                Err(error)
                    if error.status() == Some(StatusCode::CONFLICT)
                        && matches!(error.code(), Some("payment_quote_required" | "fee_quote_stale")) =>
                {
                    back(Place::reviewed(latest(receipts).as_ref(), &visible, true))
                }
                Err(error)
                    if error.status() == Some(StatusCode::CONFLICT)
                        && matches!(error.code(), Some("payment_start_pending" | "checkout_reservation_unavailable")) =>
                {
                    back(Place::reviewed(latest(receipts).as_ref(), &visible, false))
                }
                // The session already started with other order or payment details: nothing new was
                // sent, and the page shows it as it is now.
                Err(error)
                    if error.status() == Some(StatusCode::CONFLICT) && error.code() == Some("checkout_confirmation_changed") =>
                {
                    let changed = Answer::Refused(StatusCode::CONFLICT, t.route_confirmation_changed().to_owned());
                    render(&req, &viewer, &config, &headers, &id, here, changed, chrome).await
                }
                // Pay now may have reached Checkout: it is never sent again. One read decides; a
                // started payment or a submitted offer is its first result, anything else stays
                // ambiguous (`settleConfirmAfterPossibleSendLoss`).
                Err(error) if crate::checkout_entry::possible_send_loss(&error) => {
                    tracing::warn!("Pay now may not have arrived, so the session is read once: {error}");
                    match caller.checkout_session(&id).await {
                        Ok(read) if read.submitted_offer_id.is_some() => {
                            let offer = read.submitted_offer_id.unwrap_or_default();
                            req.redirect(&submitted_offer(&offer, latest(receipts).as_ref()))
                        }
                        Ok(read) if read.payment_id.is_some() => back(Place::after(latest(receipts).as_ref(), &visible)),
                        _ => render(&req, &viewer, &config, &headers, &id, here, Answer::Ambiguous, chrome).await,
                    }
                }
                Err(error) => refused(error, here).await,
            }
        }
        _ => back(here),
    }
}

/// Writes the authenticity check choice, except for a purchase intent, which Checkout refuses it
/// for. Marketplace's action writes it for one too, so its Submit offer always fails
/// (chase-sets/chase-sets#10821); the pilot skips it until the action stops sending it.
async fn select_authenticity_check(
    caller: &crate::api::Caller<'_>,
    session: &CheckoutSession,
    form: &CheckoutForm,
) -> Result<Option<Receipt>, ApiError> {
    if session.source_type == "offer-intent" {
        return Ok(None);
    }
    caller.select_authenticity_check(&session.session_id, form.opted_in(), form.quote()).await
}

/// Records the preview the buyer reviewed (`recordReviewedFulfillmentPreview`), for a session
/// that makes orders; a failure only means no receipt.
async fn record_preview(
    caller: &crate::api::Caller<'_>,
    session: &CheckoutSession,
    option: &str,
    address: &SessionAddress,
) -> Option<Receipt> {
    if session.source_type == "offer-intent" {
        return None;
    }
    caller.record_fulfillment_preview(&session.session_id, option, address).await.unwrap_or_else(|error| {
        tracing::warn!("the reviewed fulfillment preview was not recorded: {error}");
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{AuthenticityOffer, FeeQuote, PreviewLine, PreviewTotals};

    fn session() -> CheckoutSession {
        CheckoutSession {
            session_id: "chk_1".into(),
            source_type: "buy-now".into(),
            shipping_option: Some("standard".into()),
            lines: vec![crate::api::SessionLine { quantity: 1, item_title: "Lugia".into(), ..Default::default() }],
            fulfillment_preview_snapshot: Some(FulfillmentPreview {
                revision: Some("r1".into()),
                totals: PreviewTotals { total_amount: Some("620.00".into()), ..Default::default() },
                seller_groups: vec![SellerGroup {
                    lines: vec![PreviewLine { line_key: "l1".into(), ..Default::default() }],
                    ..Default::default()
                }],
                ready_line_keys: vec!["l1".into()],
                authenticity_check_offer: Some(AuthenticityOffer {
                    eligible: true,
                    fee_amount: "20.40".into(),
                    quote_fingerprint: "q".into(),
                }),
                ..Default::default()
            }),
            fulfillment_preview_revision: Some("r1".into()),
            ..Default::default()
        }
    }

    fn home() -> SavedAddress {
        SavedAddress {
            shipping_address_id: "adr_home".into(),
            label: "Home".into(),
            recipient_name: "Demo Collector".into(),
            line1: "42 Binder Lane".into(),
            city: "Evanston".into(),
            state: "IL".into(),
            postal_code: "60201".into(),
            country: "US".into(),
            email: Some("collector@chasesets.test".into()),
            is_default: true,
            ..Default::default()
        }
    }

    fn quote(method: &str, total: &str) -> FeeQuote {
        FeeQuote {
            payment_method_category: method.into(),
            total_amount: total.into(),
            quote_fingerprint: format!("fp-{method}"),
            ..Default::default()
        }
    }

    fn reads(addresses: Vec<SavedAddress>, payment: bool) -> Reads {
        Reads {
            session: session(),
            wallet: WalletRead::NotAsked,
            addresses,
            instruments: Vec::new(),
            payment: payment.then(|| PaymentPreview {
                marketplace_checkout_fee: quote("card", "638.83"),
                payment_method_quotes: vec![quote("card", "638.83"), quote("bank-account", "623.12")],
                ..Default::default()
            }),
            can_save_payment: true,
            guest: false,
            expired: false,
        }
    }

    #[test]
    fn a_saved_address_fills_the_steps_and_the_quote_sets_the_total_and_methods() {
        let screen = Screen::new(reads(vec![home()], true), Place::default(), None);
        assert!(screen.steps.contact && screen.steps.delivery && screen.steps.shipping);
        assert!(!screen.steps.show_contact && !screen.steps.show_delivery && !screen.steps.show_shipping);
        assert!(screen.steps.show_payment, "no saved method: the payment step shows");
        assert_eq!(screen.address.shipping_address_id.as_deref(), Some("adr_home"));
        assert_eq!(screen.total(), Some("638.83"));
        assert_eq!(screen.methods, ["card", "bank-account"]);
        assert!(screen.can_confirm && !screen.needs_quote);
        assert_eq!(screen.authenticity(), (true, false));
        assert_eq!(screen.notice, None, "the saved rows say it, so no notice");
    }

    #[test]
    fn without_a_quote_the_page_asks_to_update_totals_and_a_new_buyer_sees_every_form() {
        let screen = Screen::new(reads(Vec::new(), false), Place::default(), None);
        assert!(screen.needs_quote);
        assert_eq!(screen.total(), Some("620.00"));
        assert!(screen.steps.show_contact && screen.steps.show_delivery && !screen.steps.show_shipping);
        assert_eq!(screen.address.country, "US");
    }

    #[test]
    fn the_address_asks_for_a_step_and_a_method_and_says_what_the_last_write_did() {
        let place = Place {
            edit: Some("delivery".into()),
            payment_method_category: Some("bank-account".into()),
            review: Some("updated".into()),
            ..Place::default()
        };
        let screen = Screen::new(reads(vec![home()], true), place, None);
        assert!(screen.steps.show_delivery);
        assert_eq!(screen.method, "bank-account");
        assert_eq!(screen.notice, Some(Notice::ReviewUpdated));
        let place = Place { payment_method_category: Some("cash".into()), ..Place::default() };
        assert_eq!(Screen::new(reads(vec![home()], true), place, None).method, "card");
    }

    #[test]
    fn unavailable_lines_block_pay_now_and_a_changed_preview_says_so() {
        let mut r = reads(vec![home()], true);
        if let Some(p) = r.session.fulfillment_preview_snapshot.as_mut() {
            p.unavailable_line_keys = vec!["l2".into()];
        }
        let screen = Screen::new(r, Place::default(), None);
        assert!(!screen.can_confirm);
        assert_eq!(screen.notice, Some(Notice::CartReview(1)));
        let mut r = reads(vec![home()], true);
        if let Some(p) = r.session.fulfillment_preview_snapshot.as_mut() {
            p.revision = Some("r2".into());
        }
        let screen = Screen::new(r, Place::default(), None);
        assert!(screen.acknowledged);
        assert_eq!(screen.notice, Some(Notice::FulfillmentChanged(None)));
    }

    #[test]
    fn a_picked_saved_address_is_sent_as_saved_and_a_typed_one_as_typed() {
        let form =
            CheckoutForm { shipping_address_id: "adr_home".into(), shipping_name: "Someone Else".into(), ..Default::default() };
        let sent = form.address(&[home()]);
        assert_eq!(sent.name, "Demo Collector");
        assert_eq!(sent.shipping_address_id.as_deref(), Some("adr_home"));
        let form = CheckoutForm {
            shipping_address_id: MANUAL.into(),
            shipping_name: " Ada ".into(),
            shipping_line1: "1 Main".into(),
            shipping_city: "Chicago".into(),
            shipping_state: "il".into(),
            shipping_postal_code: "60601".into(),
            ..Default::default()
        };
        let sent = form.address(&[home()]);
        assert_eq!((sent.name.as_str(), sent.state.as_str(), sent.country.as_str()), ("Ada", "IL", "US"));
        assert!(complete(&sent) && sent.shipping_address_id.is_none());
        assert_eq!(signature(&sent), signature(&SessionAddress { state: "il".into(), ..sent.clone() }));
    }

    #[test]
    fn a_handoff_past_its_time_without_orders_is_expired() {
        let mut s = session();
        s.handoff_expires_at = Some("2026-01-01T00:00:00Z".into());
        assert!(expired(&s, SystemTime::now()));
        s.order_ids = vec!["ord_1".into()];
        assert!(!expired(&s, SystemTime::now()));
    }
}
