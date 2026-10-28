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
//! Three of the page's rules are Settlement's but live in marketplace's web layer: when the next
//! payout arrives, which payouts are blocked, and whether a payout can be requested
//! (chase-sets/chase-sets#10712). The pilot copies them here as written; remove them once the API
//! answers.
//!
//! Every write posts to the page, as marketplace's form action does. Preview, Edit, Retry and
//! Check status draw the page with what they did, as marketplace's action data does. Confirm
//! requests the payout with the form's `SubmitKey` as its `Idempotency-Key` (marketplace sends none),
//! so a request sent again after a lost answer is the same payout, and goes to the payout's page,
//! read after it. Unlike marketplace's route, the page sends no Stripe Connect CSP:
//! nothing on it embeds Stripe (payout setup is on marketplace's settings page).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/desk/money?<place>` | the page, with a wallet adjustment's breakdown open |
//! | `POST /account/desk/money` | `preview-payout`, `edit-payout`, `confirm-payout`, `retry`, `run-reconciliation` |
//! | `GET /account/desk/payouts/{id}?requested=1&afterWrite=` | the payout (`202` while Settlement catches up with the request) |
//! | `GET /account/payouts`, `/account/settlement` | `301` to the money page, with the query |
//! | `GET /account/payouts/{id}` | `301` to the payout's page, with the query |
//! | `GET /account/wallet/adjustments/{reference}` | `301` to the money page with the adjustment open |
//! | `GET /account/payouts/setup` | `301` to marketplace's payout settings (not ported), with the query |
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    i18n::{Currency, parse_timestamp},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::{
    api::{
        ApiError, MoneyCalls as _, Payout, PayoutAmount, PayoutPreview, PayoutReadiness, QuickAmounts, Wallet, WalletAdjustment,
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
    pub attempt: String,
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

/// The payout that arrives first, and when (marketplace's `NextPayout`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NextPayout {
    pub payout_id: String,
    pub amount: String,
    pub currency_code: String,
    /// ISO 8601, UTC.
    pub estimated_arrival_at: String,
    #[serde(skip)]
    pub arrival: SystemTime,
}

/// A payout held from settling (marketplace's `BlockedPayoutAttentionRow`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Blocked {
    pub payout_id: String,
    pub reference: String,
    /// A money status code, or the provider's words for a failure.
    pub block_reason: String,
    /// `failed`, `missing-provider-reference` or `stale-requested`.
    pub kind: &'static str,
    /// The write that is its next step: `retry` or `run-reconciliation`.
    pub next_action: &'static str,
}

/// The page: what the API read, what the page works out from it, and what the last write did.
#[derive(Serialize, ToJson)]
pub struct MoneyScreen {
    pub wallet: Wallet,
    pub entries: Vec<WalletEntry>,
    pub payouts: Vec<Payout>,
    pub readiness: PayoutReadiness,
    pub quick_amounts: QuickAmounts,
    pub adjustment: Option<WalletAdjustment>,
    pub next_payout: Option<NextPayout>,
    pub blocked: Vec<Blocked>,
    /// Whether Request a payout's form is on, and if not, the money status codes that say why.
    pub can_request: bool,
    pub unavailable: Vec<&'static str>,
    pub setup_incomplete: bool,
    pub may: May,
    pub said: Said,
}

/// The days a payout takes, after it is sent or requested (`ESTIMATED_PAYOUT_BUSINESS_DAYS`,
/// chase-sets/chase-sets#10712).
const ESTIMATED_PAYOUT_BUSINESS_DAYS: u32 = 3;
/// How long a requested payout may go without an update before it needs a status check
/// (`STALE_REQUESTED_AFTER_MS`, chase-sets/chase-sets#10712).
const STALE_REQUESTED_AFTER: Duration = Duration::from_secs(15 * 60);
const DAY: Duration = Duration::from_secs(86_400);

/// `at` plus `days` weekdays, by the UTC calendar (`addBusinessDays`).
fn add_business_days(at: SystemTime, days: u32) -> SystemTime {
    let mut at = at;
    let mut left = days;
    while left > 0 {
        at += DAY;
        let since = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / DAY.as_secs();
        // 1970-01-01 was a Thursday: 0 is Sunday, 6 Saturday.
        if !matches!((since + 4) % 7, 0 | 6) {
            left -= 1;
        }
    }
    at
}

/// A moment as `toISOString` writes it: `2026-10-28T13:05:00.000Z`.
fn iso(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs(), since.subsec_millis());
    // Days to a civil date (Howard Hinnant's `civil_from_days`).
    let z = i64::try_from(secs / 86_400).unwrap_or_default() + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let clock = secs % 86_400;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", clock / 3600, clock % 3600 / 60, clock % 60)
}

/// The requested or in-transit payout that arrives first, by its estimate (`selectNextPayout`):
/// three business days after it was sent, or requested when it has not been.
pub fn next_payout(payouts: &[Payout]) -> Option<NextPayout> {
    payouts
        .iter()
        .filter(|p| matches!(p.status.as_str(), "requested" | "in-transit"))
        .filter_map(|p| {
            let from = parse_timestamp(p.sent_at.as_deref().unwrap_or(&p.requested_at))?;
            Some((add_business_days(from, ESTIMATED_PAYOUT_BUSINESS_DAYS), p))
        })
        .min_by(|(a, left), (b, right)| a.cmp(b).then_with(|| left.payout_id.cmp(&right.payout_id)))
        .map(|(arrival, p)| NextPayout {
            payout_id: p.payout_id.clone(),
            amount: p.net_amount.clone(),
            currency_code: p.currency_code.clone(),
            estimated_arrival_at: iso(arrival),
            arrival,
        })
}

/// The payouts held from settling, in the API's order (`selectBlockedPayoutAttentionRows`): a
/// failed one, to retry; a requested one with no update for 15 minutes, and one in transit with no
/// provider payout reference, to check with the provider.
pub fn blocked(payouts: &[Payout], now: SystemTime) -> Vec<Blocked> {
    let stale = |p: &Payout| {
        p.status == "requested"
            && parse_timestamp(&p.updated_at).is_some_and(|at| now.duration_since(at).is_ok_and(|d| d >= STALE_REQUESTED_AFTER))
    };
    payouts
        .iter()
        .filter_map(|p| {
            let row = |block_reason: String, kind, next_action| Blocked {
                payout_id: p.payout_id.clone(),
                reference: p.display_reference.clone(),
                block_reason,
                kind,
                next_action,
            };
            if p.status == "failed" {
                let reason = p.failure_reason.clone().or_else(|| p.provider_failure_code.clone());
                return Some(row(reason.unwrap_or_else(|| "recent-payout-failure".into()), "failed", "retry"));
            }
            if stale(p) {
                return Some(row("payout-reconciliation-required".into(), "stale-requested", "run-reconciliation"));
            }
            if p.status == "in-transit" && p.provider_payout_reference.as_deref().is_none_or(str::is_empty) {
                return Some(row("payout-reconciliation-required".into(), "missing-provider-reference", "run-reconciliation"));
            }
            None
        })
        .collect()
}

fn positive(amount: &str) -> bool {
    platform::money::cents(amount).is_some_and(|c| c > 0)
}

fn refreshed(readiness: &PayoutReadiness) -> bool {
    readiness.updated_at.as_deref().is_some_and(|at| !at.is_empty())
}

/// Whether Request a payout's form is on (the panel's `canRequest`): the account may request,
/// payout setup is ready and refreshed, and the wallet has a balance.
pub fn can_request(may: bool, wallet: &Wallet, readiness: &PayoutReadiness) -> bool {
    may && readiness.status == "ready" && refreshed(readiness) && positive(&wallet.available_balance_amount)
}

/// Why a payout cannot be requested, as money status codes (the panel's `unavailableReasons`).
pub fn unavailable(wallet: &Wallet, readiness: &PayoutReadiness) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if readiness.status != "ready" {
        reasons.push("payout-setup-incomplete");
    }
    if readiness.status == "ready" && !refreshed(readiness) {
        reasons.push("payout-setup-refresh-required");
    }
    if !readiness.missing_requirements.is_empty() {
        reasons.push("provider-requirements-open");
    }
    if !positive(&wallet.available_balance_amount) {
        reasons.push("no-available-wallet-balance");
    }
    reasons
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
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(place): Query<Place>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &place, Said::default(), StatusCode::OK).await
}

async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    said: Said,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let adjustment = async {
        match place.opened() {
            Some(reference) => caller.wallet_adjustment(reference).await,
            None => Ok(None),
        }
    };
    let (wallet, entries, payouts, readiness, quick_amounts, adjustment) = tokio::join!(
        caller.balances(),
        caller.wallet_entries(),
        caller.payouts(),
        caller.payout_readiness(),
        caller.payout_quick_amounts(),
        adjustment,
    );
    let read = (|| Ok::<_, ApiError>((wallet?, entries?, payouts?, readiness?, quick_amounts?, adjustment?)))();
    let (wallet, entries, payouts, readiness, quick_amounts, adjustment) = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let actor = &viewer.actor;
    let may =
        May { request: actor.can(PAYOUTS_REQUEST), setup: actor.can(PAYOUTS_SETUP), reconcile: actor.can(PAYOUTS_RECONCILE) };
    let can = can_request(may.request, &wallet, &readiness);
    let screen = MoneyScreen {
        next_payout: next_payout(&payouts),
        blocked: blocked(&payouts, SystemTime::now()),
        unavailable: if can { Vec::new() } else { unavailable(&wallet, &readiness) },
        can_request: can,
        setup_incomplete: readiness.status != "ready" || readiness.provider_reference.as_deref().is_none_or(str::is_empty),
        wallet,
        entries,
        payouts,
        readiness,
        quick_amounts,
        adjustment,
        may,
        said,
    };
    let t: MoneyMsg = req.t();
    let view = html! { <views::MoneyPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.page_marketplace_title()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// Preview, Edit, Confirm, Retry and Check status (marketplace's action intents).
pub(crate) async fn write(
    req: Req,
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<MoneyInput>,
) -> HtmlResult {
    let (t, p): (MoneyMsg, Pilot) = (req.t(), req.t());
    let (req, viewer, config, headers) = (&req, &viewer, &config, &headers);
    let here = Place::default();
    let draw = |said: Said, status: StatusCode| render(req, viewer, config, headers, &here, said, status);
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
            if !valid_attempt(&input.attempt) {
                return draw(refused(p.check_attempt().to_owned(), Some(draft())), StatusCode::UNPROCESSABLE_ENTITY).await;
            }
            let amount = input.amount.trim();
            match caller.request_payout(&input.attempt, amount, input.note().as_deref()).await {
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
    Caller(PayoutViewer(viewer)): Caller<PayoutViewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(place): Query<PayoutPlace>,
) -> HtmlResult {
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let payout = match caller.payout(&id).await {
        Ok(Some(payout)) => payout,
        Ok(None) if receipt.is_some() => return preparing(&req, &viewer),
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) if receipt.is_some() && error.catching_up() => return preparing(&req, &viewer),
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let screen = PayoutScreen { payout, requested: place.requested.as_deref() == Some("1") };
    let t: MoneyMsg = req.t();
    let view = html! { <views::PayoutPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! { <Layout req={&req} viewer={Some(&viewer)} title={t.route_payout_marketplace()} head={()}>{view}</Layout> },
    )
}

/// A requested payout Settlement has not caught up to (marketplace's `SettlementPayoutDetailRecoveryPage`).
fn preparing(req: &Req, viewer: &Viewer) -> HtmlResult {
    let t: MoneyMsg = req.t();
    let head = html! {
        <meta name="robots" content="noindex">
        {ReadAgain { after: Duration::from_secs(2) }}
    };
    req.page_with_status(
        StatusCode::ACCEPTED,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.route_payout_preparing()} head={head}>
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
pub(crate) async fn legacy_payout(req: Req, uri: Uri, Path(id): Path<String>) -> HtmlResult {
    moved_with(&req, url::DeskPayout { id: &id, place: PayoutPlace::default() }.href(), &uri)
}

/// `/account/payouts/setup`: marketplace's payout settings, which the pilot does not port.
pub(crate) async fn legacy_payout_setup(req: Req, uri: Uri) -> HtmlResult {
    moved_with(&req, views::on_marketplace("/account/desk/settings"), &uri)
}

/// `/account/wallet/adjustments/{reference}`: the money page with the adjustment's breakdown open.
pub(crate) async fn legacy_adjustment(req: Req, Path(reference): Path<String>) -> HtmlResult {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> SystemTime {
        parse_timestamp(text).unwrap()
    }

    fn payout(id: &str, status: &str) -> Payout {
        Payout {
            payout_id: id.into(),
            display_reference: format!("PYO-{id}"),
            status: status.into(),
            net_amount: "9.73".into(),
            currency_code: "usd".into(),
            requested_at: "2026-10-23T15:00:00.000Z".into(),
            updated_at: "2026-10-23T15:00:00.000Z".into(),
            ..Payout::default()
        }
    }

    #[test]
    fn a_payout_arrives_three_weekdays_after_it_is_sent_or_requested() {
        // Friday the 23rd: Monday, Tuesday, Wednesday.
        assert_eq!(iso(add_business_days(at("2026-10-23T15:00:00.000Z"), 3)), "2026-10-28T15:00:00.000Z");
        // Wednesday: Thursday, Friday, Monday.
        assert_eq!(iso(add_business_days(at("2026-10-28T09:30:05.250Z"), 3)), "2026-11-02T09:30:05.250Z");
        assert_eq!(iso(at("2024-02-29T00:00:00.000Z")), "2024-02-29T00:00:00.000Z", "a leap day");

        let sent = Payout { sent_at: Some("2026-10-26T12:00:00.000Z".into()), ..payout("pyo_sent", "in-transit") };
        let requested = Payout { requested_at: "2026-10-26T13:00:00.000Z".into(), ..payout("pyo_requested", "requested") };
        let paid = Payout { requested_at: "2026-10-01T00:00:00.000Z".into(), ..payout("pyo_paid", "completed") };
        let next = next_payout(&[requested.clone(), paid.clone(), sent.clone()]).unwrap();
        assert_eq!((next.payout_id.as_str(), next.estimated_arrival_at.as_str()), ("pyo_sent", "2026-10-29T12:00:00.000Z"));
        assert_eq!(next.amount, "9.73", "what reaches the seller");
        assert_eq!(next_payout(&[paid]), None, "only one still on its way");
        let twin = Payout { payout_id: "pyo_a".into(), ..requested.clone() };
        assert_eq!(next_payout(&[requested, twin]).unwrap().payout_id, "pyo_a", "the same moment: by id");
    }

    #[test]
    fn a_payout_is_blocked_when_it_failed_went_quiet_or_lost_its_provider_reference() {
        let now = at("2026-10-23T15:20:00.000Z");
        let failed =
            Payout { failure_reason: Some("Bank account temporarily unavailable".into()), ..payout("pyo_failed", "failed") };
        let coded = Payout { provider_failure_code: Some("account_closed".into()), ..payout("pyo_coded", "failed") };
        let bare = payout("pyo_bare", "failed");
        let quiet = payout("pyo_quiet", "requested");
        let fresh = Payout { updated_at: "2026-10-23T15:10:00.000Z".into(), ..payout("pyo_fresh", "requested") };
        let lost = payout("pyo_lost", "in-transit");
        let tracked = Payout { provider_payout_reference: Some("po_1".into()), ..payout("pyo_tracked", "in-transit") };
        let rows = blocked(&[failed, coded, bare, quiet, fresh, lost, tracked], now);
        let got: Vec<_> = rows.iter().map(|r| (r.payout_id.as_str(), r.kind, r.next_action, r.block_reason.as_str())).collect();
        assert_eq!(
            got,
            [
                ("pyo_failed", "failed", "retry", "Bank account temporarily unavailable"),
                ("pyo_coded", "failed", "retry", "account_closed"),
                ("pyo_bare", "failed", "retry", "recent-payout-failure"),
                ("pyo_quiet", "stale-requested", "run-reconciliation", "payout-reconciliation-required"),
                ("pyo_lost", "missing-provider-reference", "run-reconciliation", "payout-reconciliation-required"),
            ]
        );
        assert_eq!(rows[0].reference, "PYO-pyo_failed");
    }

    #[test]
    fn a_payout_can_be_requested_once_setup_is_ready_and_the_wallet_has_money() {
        let wallet = |amount: &str| Wallet { available_balance_amount: amount.into(), ..Wallet::default() };
        let ready = PayoutReadiness {
            status: "ready".into(),
            updated_at: Some("2026-10-01T00:00:00Z".into()),
            ..PayoutReadiness::default()
        };
        assert!(can_request(true, &wallet("26.83"), &ready));
        assert!(!can_request(false, &wallet("26.83"), &ready), "without payouts.request");
        assert!(!can_request(true, &wallet("0.00"), &ready));
        assert!(unavailable(&wallet("26.83"), &ready).is_empty());
        assert_eq!(unavailable(&wallet("0.00"), &ready), ["no-available-wallet-balance"]);
        let stale = PayoutReadiness { updated_at: None, ..ready.clone() };
        assert!(!can_request(true, &wallet("26.83"), &stale));
        assert_eq!(unavailable(&wallet("26.83"), &stale), ["payout-setup-refresh-required"]);
        let started = PayoutReadiness {
            status: "not-started".into(),
            missing_requirements: vec!["provider-onboarding".into()],
            ..PayoutReadiness::default()
        };
        assert_eq!(
            unavailable(&wallet("-1.00"), &started),
            ["payout-setup-incomplete", "provider-requirements-open", "no-available-wallet-balance"]
        );
    }
}
