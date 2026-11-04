//! Packing a shipment (Fulfillment's `account-sale-shipment-packing`): the seller starts packing,
//! confirms each line (all of it, or one at a time, or by scanning a reference or a title), and
//! records the package as packed. Every rule is the API's: when packing may start, how many of a
//! line may be packed, and that every line is confirmed before the package is.
//!
//! Each write carries its attempt (the form's `SubmitKey`), sent as the `Idempotency-Key` the
//! Fulfillment API applies once and answers again with its first result. A refusal asks the API
//! what came of the attempt (`mutation-recovery`): one it applied before is applied. The page's
//! script remembers an attempt before it is sent, as marketplace's `ShipmentMutationBoundary` does,
//! and a page that finds one it does not settle asks the API about it (`check`); while the API
//! cannot say, the page's writes are off.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/sales/shipments/{id}/packing` | the packing page, read after the write whose receipt it carries |
//! | `POST ../packing/start` | start packing, then the page |
//! | `POST ../packing/lines/{line}` | how many of the line are packed: the line, the progress and Finish in place, or the page |
//! | `POST ../packing/scan` | one more of the line a scan names, or what the scan matched |
//! | `POST ../pack` | the package packed, then the shipment's page |
use crate::recovery::attempt_text;
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{ApiError, Caller as Api, Packing as _, PackingAttempt, ShipmentDetail, ShipmentLine, Shipments as _, Side},
    app::{Shared, read_failed, sign_in, url},
    auth::{Shipper, Viewer},
    text::{Pilot, ShipmentsMsg},
    views::{self, Layout},
};

/// What the packing page's address carries: the last write's receipt (`after_write`), the attempt
/// that answer settles (`done`), an attempt to ask the API about (`check`), and what the last scan
/// matched (`scan`, `line`).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
    pub done: Option<String>,
    pub check: Option<String>,
    pub scan: Option<Scanned>,
    pub line: Option<String>,
}

/// What a scan found (`handleScanSubmit`), written in the address as the word serde reads
/// (`UrlValue`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Scanned {
    /// One more of the line is packed.
    Matched,
    /// The line it names is packed already.
    Complete,
    /// More than one line matched.
    Ambiguous,
    /// No line matched.
    None,
}

/// A write's form: its attempt.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct AttemptInput {
    pub attempt: Option<SubmitKey>,
}

/// A line's form: its attempt and how many are packed after it (the button pressed).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct LineInput {
    pub attempt: Option<SubmitKey>,
    pub quantity: String,
}

/// The scan's form: its attempt, what was scanned or typed, and the receipt of the page's last
/// write, so the line's count is read after it.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ScanInput {
    pub attempt: Option<SubmitKey>,
    pub code: String,
    pub after_write: String,
}

/// Finish's form: its attempt and the package count.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct PackInput {
    pub attempt: Option<SubmitKey>,
    pub package_count: String,
}

/// What the page says about the last write.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "attempt", rename_all = "kebab-case")]
pub enum Outcome {
    /// Nothing to say.
    #[default]
    Ready,
    /// The answer settles the attempt: applied.
    Applied(String),
    /// The answer settles the attempt: nothing was applied, for `message`.
    Refused { attempt: String, message: String },
    /// The API cannot say yet what came of the attempt: writes are off until it can.
    Uncertain(String),
}

impl Outcome {
    /// The attempt this answer settles: the browser forgets it.
    pub fn settles(&self) -> &str {
        match self {
            Outcome::Applied(attempt) | Outcome::Refused { attempt, .. } => attempt,
            _ => "",
        }
    }

    /// The attempt this page could not confirm: the browser keeps it and does not ask again.
    pub fn unsettled(&self) -> &str {
        match self {
            Outcome::Uncertain(attempt) => attempt,
            _ => "",
        }
    }

    pub fn writes(&self) -> bool {
        !matches!(self, Outcome::Uncertain(_))
    }
}

/// A line's own word after a write (`PackingLine`'s status).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineState {
    Saved,
    Matched,
    Failed(String),
}

/// The packing page: the shipment (none while it is catching up with a write), the receipt of the
/// last write, and what the page says.
#[derive(Serialize, ToJson)]
pub struct PackingScreen {
    pub shipment: Option<ShipmentDetail>,
    pub after_write: Option<String>,
    pub outcome: Outcome,
    pub scan: Option<(Scanned, String)>,
    /// The line the last write or scan was about, and what it says.
    pub line: Option<(String, LineState)>,
}

/// The page, read after `after_write`; a shipment not read yet after a write is the pending page,
/// which reads itself again.
pub(crate) async fn page(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::Packing<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome = match (&place.check, &place.done) {
        (Some(attempt), _) => check(&caller, &id, attempt).await,
        (None, Some(done)) => Outcome::Applied(done.clone()),
        (None, None) => Outcome::Ready,
    };
    let scan = place.scan.zip(place.line.clone());
    let line = match &scan {
        Some((Scanned::Matched, line)) => Some((line.clone(), LineState::Matched)),
        _ => None,
    };
    let line = line.or_else(|| place.done.as_ref().zip(place.line.clone()).map(|(_, line)| (line, LineState::Saved)));
    render(&req, &viewer, &config, &headers, &id, place.after_write.clone(), outcome, scan, line, StatusCode::OK, &chrome).await
}

/// What the API says came of `attempt`, for the page.
async fn check(caller: &Api<'_>, id: &str, attempt: &str) -> Outcome {
    if !crate::recovery::valid_attempt(attempt) {
        return Outcome::Uncertain(attempt.to_owned());
    }
    match caller.packing_attempt(id, attempt).await {
        Ok(found) if found.applied() => Outcome::Applied(attempt.to_owned()),
        Ok(found) if found.refused() => Outcome::Refused { attempt: attempt.to_owned(), message: String::new() },
        Ok(_) => Outcome::Uncertain(attempt.to_owned()),
        Err(error) => {
            tracing::warn!("the packing attempt check failed: {error}");
            Outcome::Uncertain(attempt.to_owned())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    after_write: Option<String>,
    outcome: Outcome,
    scan: Option<(Scanned, String)>,
    line: Option<(String, LineState)>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let receipt = Receipt::from_param(after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let shipment = match caller.shipment(Side::Seller, id).await {
        Ok(shipment) => Some(shipment),
        // The write's projection is not readable yet (marketplace's `recoverTransient`).
        Err(error) if receipt.is_some() && error.catching_up() => None,
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let pending = shipment.is_none();
    let screen = PackingScreen { shipment, after_write, outcome, scan, line };
    let t: ShipmentsMsg = req.t();
    let head = html! {
        if pending {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let view = html! { <views::PackingPage t={t} p={req.t()} viewer={viewer} id={id} screen={&screen} /> };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.pack_route_pack_shipment_marketplace()} head={head}>
            {view}
        </Layout>
    };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// What a write's failed call means.
enum Failed {
    /// The API applied this attempt before (the same form, sent again).
    AppliedBefore,
    /// Refused, with the API's words: nothing was applied.
    Refused(String),
    SignIn,
    /// Refused, but the API cannot say whether this attempt was applied before (mutation-recovery
    /// failed): the page that asks about it, which says it could not confirm the write, with every
    /// write off.
    Uncertain,
    /// No answer that says what happened: the error page; the browser keeps its record.
    Unknown(corten::Error),
}

async fn failed(caller: &Api<'_>, id: &str, attempt: &str, error: ApiError) -> Failed {
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        return Failed::SignIn;
    }
    let Some(message) = error.refusal().map(str::to_owned) else {
        return Failed::Unknown(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY));
    };
    match caller.packing_attempt(id, attempt).await {
        Ok(found) if found.applied() => Failed::AppliedBefore,
        Ok(PackingAttempt { .. }) => Failed::Refused(message),
        Err(lookup) => {
            tracing::warn!("the packing attempt check after a refusal ({message}) failed: {lookup}");
            Failed::Uncertain
        }
    }
}

/// The packing page asking the API about `attempt` (`check`), after a write it cannot confirm.
fn uncertain(req: &Req, id: &str, attempt: &str) -> HtmlResult {
    req.redirect(&url::Packing { id, place: Place { check: Some(attempt.to_owned()), ..Place::default() } })
}

/// The packing page after an applied write: read after its receipt, saying it settles `attempt`.
fn applied(
    req: &Req,
    id: &str,
    attempt: &str,
    receipt: Option<Receipt>,
    line: Option<&str>,
    scan: Option<Scanned>,
) -> HtmlResult {
    let place = Place {
        after_write: receipt.map(|r| r.param()),
        done: Some(attempt.to_owned()),
        check: None,
        scan,
        line: line.map(str::to_owned),
    };
    let to = url::Packing { id, place };
    match line {
        Some(line) => req.redirect(&to.at(views::PackingLineId(line))),
        None => req.redirect(&to),
    }
}

pub(crate) async fn start(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::PackingStart<'_>>,
    Form(input): Form<AttemptInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let attempt = attempt_text(&input.attempt);
    match caller.start_packing(&id, attempt).await {
        Ok(receipt) => applied(&req, &id, attempt, receipt, None, None),
        Err(error) => match failed(&caller, &id, attempt, error).await {
            Failed::AppliedBefore => applied(&req, &id, attempt, None, None, None),
            Failed::Refused(message) => {
                let outcome = Outcome::Refused { attempt: attempt.to_owned(), message };
                render(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    &id,
                    None,
                    outcome,
                    None,
                    None,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &chrome,
                )
                .await
            }
            Failed::Uncertain => uncertain(&req, &id, attempt),
            Failed::SignIn => sign_in(&req),
            Failed::Unknown(error) => Err(error),
        },
    }
}

/// How many of a line are packed: a whole number (`Number(..)`); the API checks the rest.
fn quantity(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

pub(crate) async fn line(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::PackingLine<'_>>,
    Form(input): Form<LineInput>,
) -> HtmlResult {
    let (id, line) = (route.id, route.line);
    let p: Pilot = req.t();
    let Some(count) = quantity(&input.quantity) else {
        let outcome = Outcome::Refused {
            attempt: attempt_text(&input.attempt).to_owned(),
            message: p.packing_quantity_invalid().to_owned(),
        };
        return refused(&req, &viewer, &config, &headers, &id, &line, outcome, None, &chrome).await;
    };
    set(&req, &viewer, &config, &headers, &id, &line, count, attempt_text(&input.attempt), None, &chrome).await
}

/// Set how many of `line` are packed, then the line, the progress and Finish in place (with the
/// script) or the page.
#[allow(clippy::too_many_arguments)]
async fn set(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    line: &str,
    count: u64,
    attempt: &str,
    scan: Option<Scanned>,
    chrome: &Chrome,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let receipt = match caller.set_packed(id, line, count, attempt).await {
        Ok(receipt) => receipt,
        Err(error) => match failed(&caller, id, attempt, error).await {
            Failed::AppliedBefore => None,
            Failed::Refused(message) => {
                let outcome = Outcome::Refused { attempt: attempt.to_owned(), message };
                return refused(req, viewer, config, headers, id, line, outcome, scan, chrome).await;
            }
            Failed::Uncertain => return uncertain(req, id, attempt),
            Failed::SignIn => return sign_in(req),
            Failed::Unknown(error) => return Err(error),
        },
    };
    if req.mode == corten::Mode::Action {
        let waiting = config.platform.caller(headers, config.proto, receipt.as_ref());
        // Read after the write; a read that is behind falls back to the page, which waits.
        if let Ok(shipment) = waiting.shipment(Side::Seller, id).await {
            let state = if scan.is_some() { LineState::Matched } else { LineState::Saved };
            let screen = PackingScreen {
                shipment: Some(shipment),
                after_write: receipt.map(|r| r.param()),
                outcome: Outcome::Applied(attempt.to_owned()),
                scan: scan.map(|s| (s, line.to_owned())),
                line: Some((line.to_owned(), state)),
            };
            return patch(req, viewer, id, &screen, StatusCode::OK);
        }
    }
    applied(req, id, attempt, receipt, Some(line), scan)
}

/// The parts a line write changes, as a patch: the status, the scan, the line, the progress and
/// Finish.
fn patch(req: &Req, viewer: &Viewer, id: &str, screen: &PackingScreen, status: StatusCode) -> HtmlResult {
    let t: ShipmentsMsg = req.t();
    req.patch_with_status(status, html! { <views::PackingParts t={t} p={req.t()} viewer={viewer} id={id} screen={screen} /> })
}

/// A line write the API refused: the line says why, in place or on the page (422).
#[allow(clippy::too_many_arguments)]
async fn refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    line: &str,
    outcome: Outcome,
    scan: Option<Scanned>,
    chrome: &Chrome,
) -> HtmlResult {
    let message = match &outcome {
        Outcome::Refused { message, .. } => message.clone(),
        _ => String::new(),
    };
    let status = StatusCode::UNPROCESSABLE_ENTITY;
    let state = Some((line.to_owned(), LineState::Failed(message)));
    let scan = scan.map(|s| (s, line.to_owned()));
    if req.mode == corten::Mode::Action {
        let caller = config.platform.caller(headers, config.proto, None);
        match caller.shipment(Side::Seller, id).await {
            Ok(shipment) => {
                let screen = PackingScreen { shipment: Some(shipment), after_write: None, outcome, scan, line: state };
                return patch(req, viewer, id, &screen, status);
            }
            Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
        }
    }
    render(req, viewer, config, headers, id, None, outcome, scan, state, status, chrome).await
}

/// The line a scan names (`findScannedLine`): a reference exactly (the line's, its order line's,
/// its catalog item's or product's, or the short form of one), else a title containing it.
pub fn find<'a>(lines: &'a [ShipmentLine], code: &str) -> Result<Option<&'a ShipmentLine>, ()> {
    let code = code.trim().to_lowercase();
    if code.is_empty() {
        return Ok(None);
    }
    let one = |found: Vec<&'a ShipmentLine>| match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0])),
        _ => Err(()),
    };
    let keys = |line: &ShipmentLine| {
        [
            line.line_id.clone(),
            line.order_line_id.clone(),
            line.catalog_catalog_item_id.clone(),
            line.product_id.clone(),
            short_reference(&line.line_id),
            short_reference(&line.order_line_id),
            short_reference(&line.product_id),
        ]
        .map(|key| key.trim().to_lowercase())
    };
    match one(lines.iter().filter(|line| keys(line).contains(&code)).collect())? {
        Some(line) => Ok(Some(line)),
        None => one(lines.iter().filter(|line| line.item_title.trim().to_lowercase().contains(&code)).collect()),
    }
}

/// A reference's short form (`shortReference`): what follows its prefix, its last eight
/// characters, upper case.
pub fn short_reference(value: &str) -> String {
    let suffix = value.split('_').nth(1).unwrap_or(value);
    let count = suffix.chars().count();
    let tail: String = if count > 8 { suffix.chars().skip(count - 8).collect() } else { suffix.to_owned() };
    tail.to_uppercase()
}

pub(crate) async fn scan(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::PackingScan<'_>>,
    Form(input): Form<ScanInput>,
) -> HtmlResult {
    let id = route.id;
    let receipt = Receipt::from_param(Some(input.after_write.as_str()).filter(|r| !r.is_empty()));
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let shipment = match caller.shipment(Side::Seller, &id).await {
        Ok(shipment) => shipment,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let found = find(&shipment.lines, &input.code);
    let (scanned, line) = match found {
        Err(()) => (Scanned::Ambiguous, None),
        Ok(None) => (Scanned::None, None),
        Ok(Some(line)) if line.packed() >= line.quantity => (Scanned::Complete, Some(line)),
        Ok(Some(line)) => {
            let (line_id, count) = (line.line_id.clone(), line.packed() + 1);
            return set(
                &req,
                &viewer,
                &config,
                &headers,
                &id,
                &line_id,
                count,
                attempt_text(&input.attempt),
                Some(Scanned::Matched),
                &chrome,
            )
            .await;
        }
    };
    // Nothing to write: what the scan found, in place or on the page. The attempt was not sent.
    let line = line.map(|l| l.line_id.clone());
    let line_id = line.clone().unwrap_or_default();
    let screen = PackingScreen {
        shipment: Some(shipment),
        after_write: receipt.map(|r| r.param()),
        outcome: Outcome::Ready,
        scan: Some((scanned, line_id.clone())),
        line: line.map(|l| (l, LineState::Matched)),
    };
    if req.mode == corten::Mode::Action {
        return patch(&req, &viewer, &id, &screen, StatusCode::OK);
    }
    let place =
        Place { after_write: screen.after_write.clone(), done: None, check: None, scan: Some(scanned), line: Some(line_id) };
    req.redirect(&url::Packing { id: &id, place })
}

pub(crate) async fn pack(
    req: Req,
    chrome: Chrome,
    Caller(Shipper(viewer)): Caller<Shipper>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::sale_shipments::Pack<'_>>,
    Form(input): Form<PackInput>,
) -> HtmlResult {
    let id = route.id;
    let p: Pilot = req.t();
    let attempt = attempt_text(&input.attempt);
    let refuse = |message: String| Outcome::Refused { attempt: attempt.to_owned(), message };
    let Some(packages) = quantity(&input.package_count).filter(|n| *n >= 1) else {
        let outcome = refuse(p.packing_package_count_invalid().to_owned());
        return render(
            &req,
            &viewer,
            &config,
            &headers,
            &id,
            None,
            outcome,
            None,
            None,
            StatusCode::UNPROCESSABLE_ENTITY,
            &chrome,
        )
        .await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let receipt = match caller.pack(&id, packages, attempt).await {
        Ok(receipt) => receipt,
        Err(error) => match failed(&caller, &id, attempt, error).await {
            Failed::AppliedBefore => None,
            Failed::Refused(message) => {
                return render(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    &id,
                    None,
                    refuse(message),
                    None,
                    None,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &chrome,
                )
                .await;
            }
            Failed::Uncertain => return uncertain(&req, &id, attempt),
            Failed::SignIn => return sign_in(&req),
            Failed::Unknown(error) => return Err(error),
        },
    };
    // The shipment's page, read after the write, as marketplace's `navigateAfterWrite` does.
    let after = crate::cart::AfterWrite { after_write: receipt.map(|r| r.param()) };
    req.redirect(&url::SaleShipment { id: &id, after })
}

#[cfg(test)]
mod tests {
    use super::{find, short_reference};
    use crate::api::ShipmentLine;

    fn line(id: &str, title: &str) -> ShipmentLine {
        ShipmentLine {
            line_id: format!("shl_{id}0000000000"),
            order_line_id: format!("orl_{id}1111111111"),
            catalog_catalog_item_id: format!("cat_{id}"),
            product_id: format!("cat_{id}::nm"),
            item_title: title.into(),
            quantity: 2,
            ..ShipmentLine::default()
        }
    }

    #[test]
    fn a_reference_is_its_last_eight_characters_after_the_prefix() {
        assert_eq!(short_reference("shl_01ABCDEFGHJK"), "CDEFGHJK");
        assert_eq!(short_reference("shl_abc"), "ABC");
        assert_eq!(short_reference("plain"), "PLAIN");
    }

    #[test]
    fn a_scan_finds_a_reference_exactly_then_a_title() {
        let lines = [line("a", "Charizard ex"), line("b", "Charizard V")];
        assert_eq!(find(&lines, "  CAT_A ").unwrap().map(|l| l.item_title.as_str()), Some("Charizard ex"));
        assert_eq!(find(&lines, "00000000").map(|l| l.is_some()), Err(()), "two lines end so");
        assert_eq!(find(&lines, "orl_b1111111111").unwrap().map(|l| l.item_title.as_str()), Some("Charizard V"));
        assert_eq!(find(&lines, "ex").unwrap().map(|l| l.item_title.as_str()), Some("Charizard ex"));
        assert!(find(&lines, "charizard").is_err(), "two titles");
        assert!(find(&lines, "pikachu").unwrap().is_none());
        assert!(find(&lines, " ").unwrap().is_none());
    }
}
