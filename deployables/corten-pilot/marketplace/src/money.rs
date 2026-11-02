//! The Seller Desk's money page (Settlement's marketplace `account-desk-money` route, its
//! `money-dashboard-page.tsx` and `payout-request-panel.tsx`): the wallet's balances, the next
//! payout and the blocked ones at a glance, payout setup while it is unfinished, Request a payout
//! (a preview with its fees, then Confirm or Edit), the payouts that need a next step (Retry or
//! Check status), every payout with its breakdown, and the wallet's activity, with a wallet
//! adjustment's breakdown when the address names one (`?drawer=wallet-adjustment&entity=`).
//! A payout's own page (Settlement's `account-desk-payout`): its status, amounts and moments and
//! its timeline, read after the request whose receipt the address carries. Settlement's old
//! addresses move for good to these.
//!
//! When the next payout arrives, which payouts are blocked and whether a payout can be requested
//! are Settlement's answers, read with the payouts. When Settlement's summary did not see every
//! payout it leaves the first two out, and the page says the summary is incomplete.
//!
//! Every write posts to the page, as marketplace's form action does. Preview, Edit, Retry and
//! Check status draw the page with what they did, as marketplace's action data does. Confirm
//! requests the payout with the form's `SubmitKey` as its `Idempotency-Key` (marketplace sends none),
//! so a request sent again after a lost answer is the same payout, and goes to the payout's page,
//! read after it. Unlike marketplace's route, the page sends no Stripe Connect CSP:
//! nothing on it embeds Stripe (payout setup is its own page, `payout_setup`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/desk/money?<place>` | the page, with a wallet adjustment's breakdown open |
//! | `POST /account/desk/money` | `preview-payout`, `edit-payout`, `confirm-payout`, `retry`, `run-reconciliation` |
//! | `GET /account/desk/payouts/{id}?requested=1&afterWrite=` | the payout (`202` while Settlement catches up with the request) |
//! | `GET /account/payouts`, `/account/settlement` | `301` to the money page, with the query |
//! | `GET /account/payouts/{id}` | `301` to the payout's page, with the query |
//! | `GET /account/wallet/adjustments/{reference}` | `301` to the money page with the adjustment open |
//! | `GET /account/payouts/setup` | `301` to payout setup (`payout_setup`), with the query |
use crate::recovery::attempt_text;
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    i18n::Currency,
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, MoneyCalls as _, Payout, PayoutAmount, PayoutPreview, PayoutSummary, QuickAmounts, Wallet, WalletAdjustment,
        WalletEntry,
    },
    app::{PAYOUTS_RECONCILE, PAYOUTS_REQUEST, PAYOUTS_SETUP, Shared, read_failed, sign_in, url},
    auth::{PayoutViewer, Viewer},
    recovery::valid_attempt,
    text::{MoneyMsg, Pilot},
    views::{self, Layout},
};

/// What the page's address carries: the wallet adjustment whose breakdown is open
/// (marketplace's `drawer=wallet-adjustment&entity=<reference>`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub drawer: Option<String>,
    pub entity: Option<String>,
}

impl Place {
    /// The page with the adjustment `reference`'s breakdown open.
    pub fn adjustment(reference: &str) -> Place {
        Place { drawer: Some(ADJUSTMENT_DRAWER.into()), entity: Some(reference.into()) }
    }

    /// The adjustment the address opens, if it names one.
    fn opened(&self) -> Option<&str> {
        match self.drawer.as_deref() {
            Some(ADJUSTMENT_DRAWER) => self.entity.as_deref().map(str::trim).filter(|e| !e.is_empty()),
            _ => None,
        }
    }
}

const ADJUSTMENT_DRAWER: &str = "wallet-adjustment";

/// The page's forms, in marketplace's names: the write (`intent`), a quick amount or a typed one,
/// the note, and Confirm's attempt.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct MoneyInput {
    pub intent: String,
    pub quick_amount: String,
    pub amount: String,
    pub note: String,
    pub attempt: Option<SubmitKey>,
}

impl MoneyInput {
    fn note(&self) -> Option<String> {
        Some(self.note.trim().to_owned()).filter(|n| !n.is_empty())
    }
}

/// What the account may do on the page beyond reading it.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct May {
    pub request: bool,
    pub setup: bool,
    pub reconcile: bool,
}

/// An amount and a note Request a payout's form shows again (marketplace's `draft`).
#[derive(Clone, Debug, Default, Serialize)]
pub struct Draft {
    pub amount: String,
    pub note: Option<String>,
}

/// A previewed payout waiting for Confirm (marketplace's `confirmation`).
#[derive(Clone, Debug, Serialize)]
pub struct Confirmation {
    pub amount: String,
    pub note: Option<String>,
    pub preview: PayoutPreview,
}

/// What the last write did (marketplace's `MoneyDashboardActionState`).
#[derive(Clone, Debug, Default, Serialize)]
pub struct Said {
    pub error: Option<String>,
    pub draft: Option<Draft>,
    pub confirmation: Option<Confirmation>,
    /// Settlement's word on a status check it queued.
    pub checked: Option<String>,
}

/// The page: what the API read and what the last write did. The next payout, the blocked ones and
/// whether a payout can be requested are Settlement's answers, in `summary`.
#[derive(Serialize, ToJson)]
pub struct MoneyScreen {
    pub wallet: Wallet,
    pub entries: Vec<WalletEntry>,
    pub summary: PayoutSummary,
    pub quick_amounts: QuickAmounts,
    pub adjustment: Option<WalletAdjustment>,
    pub may: May,
    pub said: Said,
}

impl MoneyScreen {
    /// Whether payout setup is unfinished, by Settlement's reasons a payout is unavailable.
    pub fn setup_incomplete(&self) -> bool {
        self.summary.availability.unavailable_reasons.iter().any(|code| code == "payout-setup-incomplete")
    }
}

/// Marketplace's one currency, in which a typed amount is read.
const USD: Currency = Currency::new("USD");

/// The amount a preview is for: a quick amount Settlement resolves, or the typed one read as money
/// in the page's locale (`$1,299.50` in en) and written as the API takes it; text that is not
/// money is sent as typed, for Settlement to refuse in its words.
fn payout_amount(t: MoneyMsg, input: &MoneyInput) -> PayoutAmount {
    match input.quick_amount.as_str() {
        "minimum" => PayoutAmount::Selection("minimum"),
        "available" => PayoutAmount::Selection("available"),
        _ => PayoutAmount::Typed(match t.parse_money(input.amount.trim(), USD) {
            Some(cents) => format!("{}.{:02}", cents.0 / 100, cents.0 % 100),
            None => input.amount.trim().to_owned(),
        }),
    }
}

pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::money::Money>,
) -> HtmlResult {
    let place = route.place;
    render(&req, &viewer, &config, &headers, &place, Said::default(), StatusCode::OK, &chrome).await
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    said: Said,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let adjustment = async {
        match place.opened() {
            Some(reference) => caller.wallet_adjustment(reference).await,
            None => Ok(None),
        }
    };
    let (wallet, entries, summary, quick_amounts, adjustment) =
        tokio::join!(caller.balances(), caller.wallet_entries(), caller.payouts(), caller.payout_quick_amounts(), adjustment,);
    let read = (|| Ok::<_, ApiError>((wallet?, entries?, summary?, quick_amounts?, adjustment?)))();
    let (wallet, entries, summary, quick_amounts, adjustment) = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let actor = &viewer.actor;
    let may =
        May { request: actor.can(PAYOUTS_REQUEST), setup: actor.can(PAYOUTS_SETUP), reconcile: actor.can(PAYOUTS_RECONCILE) };
    let screen = MoneyScreen { wallet, entries, summary, quick_amounts, adjustment, may, said };
    let t: MoneyMsg = req.t();
    let view = html! { <views::MoneyPage t={t} p={req.t()} screen={&screen} /> };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.page_marketplace_title()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// Preview, Edit, Confirm, Retry and Check status (marketplace's action intents).
pub(crate) async fn write(
    req: Req,
    chrome: Chrome,
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<MoneyInput>,
) -> HtmlResult {
    let (t, p): (MoneyMsg, Pilot) = (req.t(), req.t());
    let (req, viewer, config, headers) = (&req, &viewer, &config, &headers);
    let here = Place::default();
    let draw = |said: Said, status: StatusCode| render(req, viewer, config, headers, &here, said, status, &chrome);
    let draft = || Draft { amount: input.amount.trim().to_owned(), note: input.note() };
    let refused = |message: String, draft: Option<Draft>| Said { error: Some(message), draft, ..Said::default() };
    let caller = config.platform.caller(headers, config.proto, None);
    match input.intent.as_str() {
        "preview-payout" | "edit-payout" | "confirm-payout" if !viewer.actor.can(PAYOUTS_REQUEST) => {
            draw(refused(t.page_request_permission_required().to_owned(), None), StatusCode::FORBIDDEN).await
        }
        "retry" | "run-reconciliation" if !viewer.actor.can(PAYOUTS_RECONCILE) => {
            draw(refused(t.page_reconcile_permission_required().to_owned(), None), StatusCode::FORBIDDEN).await
        }
        "preview-payout" => match caller.preview_payout(&payout_amount(t, &input)).await {
            Ok(preview) => {
                let confirmation = Confirmation { amount: preview.requested_amount.clone(), note: input.note(), preview };
                draw(Said { confirmation: Some(confirmation), ..Said::default() }, StatusCode::OK).await
            }
            Err(error) => match failed(req, &error) {
                Some(answer) => answer,
                None => draw(refused(message(t, &error), Some(draft())), StatusCode::UNPROCESSABLE_ENTITY).await,
            },
        },
        "edit-payout" => draw(Said { draft: Some(draft()), ..Said::default() }, StatusCode::OK).await,
        "confirm-payout" => {
            if !valid_attempt(attempt_text(&input.attempt)) {
                return draw(refused(p.check_attempt().to_owned(), Some(draft())), StatusCode::UNPROCESSABLE_ENTITY).await;
            }
            let amount = input.amount.trim();
            match caller.request_payout(attempt_text(&input.attempt), amount, input.note().as_deref()).await {
                Ok((id, receipt)) => {
                    let place = PayoutPlace { requested: Some("1".into()), after_write: receipt.map(|r| r.param()) };
                    req.redirect(&url::DeskPayout { id: &id, place })
                }
                // No answer: the same attempt sent again is the same payout, so say so with a 5xx,
                // which keeps the form's key for the resend.
                Err(ApiError::Transport(error)) => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
                Err(error) => match failed(req, &error) {
                    Some(answer) => answer,
                    None => draw(refused(message(t, &error), Some(draft())), StatusCode::UNPROCESSABLE_ENTITY).await,
                },
            }
        }
        "retry" | "run-reconciliation" => match caller.run_payout_reconciliation().await {
            Ok(said) => {
                let checked = said.unwrap_or_else(|| t.page_status_check_queued().to_owned());
                draw(Said { checked: Some(checked), ..Said::default() }, StatusCode::OK).await
            }
            Err(error) => match failed(req, &error) {
                Some(answer) => answer,
                None => draw(refused(message(t, &error), None), StatusCode::UNPROCESSABLE_ENTITY).await,
            },
        },
        // Marketplace's `onUnknownIntent`: the page again.
        _ => req.redirect(&url::Money { place: here.clone() }),
    }
}

/// A payout page's address: `requested=1` after Request a payout, and the receipt of the request
/// the read waits for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct PayoutPlace {
    pub requested: Option<String>,
    pub after_write: Option<String>,
}

/// A payout's page: the payout, and whether it was just requested (marketplace's `requestSuccess`).
#[derive(Serialize, ToJson)]
pub struct PayoutScreen {
    pub payout: Payout,
    pub requested: bool,
}

/// A payout's page (marketplace's `account-desk-payout` loader). One the account has not is a 404;
/// one a request's receipt names that Settlement has not caught up to says it is being prepared
/// (`202`) and reads again.
pub(crate) async fn payout(
    req: Req,
    chrome: Chrome,
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::payout::DeskPayout<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let payout = match caller.payout(&id).await {
        Ok(Some(payout)) => payout,
        Ok(None) if receipt.is_some() => return preparing(&req, &viewer, chrome.cart().await),
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) if receipt.is_some() && error.catching_up() => return preparing(&req, &viewer, chrome.cart().await),
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let screen = PayoutScreen { payout, requested: place.requested.as_deref() == Some("1") };
    let t: MoneyMsg = req.t();
    let view = html! { <views::PayoutPage t={t} screen={&screen} /> };
    let cart = chrome.cart().await;
    req.screen(
        &screen,
        html! {
            <Layout req={&req} viewer={Some(&viewer)} cart={cart} title={t.route_payout_marketplace()} head={()}>{view}</Layout>
        },
    )
}

/// A requested payout Settlement has not caught up to (marketplace's `SettlementPayoutDetailRecoveryPage`).
fn preparing(req: &Req, viewer: &Viewer, cart: Option<u64>) -> HtmlResult {
    let t: MoneyMsg = req.t();
    let head = html! {
        <meta name="robots" content="noindex">
        {ReadAgain { after: Duration::from_secs(2) }}
    };
    req.page_with_status(
        StatusCode::ACCEPTED,
        html! {
            <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_payout_preparing()} head={head}>
                <views::PayoutPreparing t={t} />
            </Layout>
        },
    )
}

/// `to` with the query the old address had.
fn moved_with(req: &Req, to: String, uri: &Uri) -> HtmlResult {
    let to = match uri.query() {
        Some(query) if !query.is_empty() => format!("{to}?{query}"),
        _ => to,
    };
    let to: Uri = to.parse().map_err(corten::Error::new)?;
    req.moved(&to)
}

/// `/account/payouts` and `/account/settlement`: the money page.
pub(crate) async fn legacy_payouts(req: Req, uri: Uri) -> HtmlResult {
    moved_with(&req, url::Money::default().href(), &uri)
}

/// `/account/payouts/{id}`: the payout's page.
pub(crate) async fn legacy_payout(
    req: Req,
    uri: Uri,
    Params(route): Params<crate::app::url::home::LegacyPayout<'_>>,
) -> HtmlResult {
    let id = route.id;
    moved_with(&req, url::DeskPayout { id: &id, place: PayoutPlace::default() }.href(), &uri)
}

/// `/account/payouts/setup`: payout setup.
pub(crate) async fn legacy_payout_setup(req: Req, uri: Uri) -> HtmlResult {
    moved_with(&req, crate::payout_setup::PATH.to_owned(), &uri)
}

/// `/account/wallet/adjustments/{reference}`: the money page with the adjustment's breakdown open.
pub(crate) async fn legacy_adjustment(
    req: Req,
    Params(route): Params<crate::app::url::home::LegacyAdjustment<'_>>,
) -> HtmlResult {
    let reference = route.reference;
    req.moved(&url::Money { place: Place::adjustment(&reference) })
}

/// A refusal that is not the page's to draw: a session that ended, or an API that did not answer.
fn failed(req: &Req, error: &ApiError) -> Option<HtmlResult> {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => Some(sign_in(req)),
        Some(status) if status.is_client_error() => None,
        _ => Some(Err(corten::Error::new(error.to_string()).with_status(StatusCode::BAD_GATEWAY))),
    }
}

/// Settlement's words for a refusal, or the page's own.
fn message(t: MoneyMsg, error: &ApiError) -> String {
    error.refusal().unwrap_or(t.page_action_failed()).to_owned()
}
