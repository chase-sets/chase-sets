//! The buyer's submitted offers (marketplace's `account-offers-submitted` route,
//! `/account/offers/submitted`): the account's offers in a status, with every status's count,
//! and Pause, Resume and Withdraw, one offer or the checked ones.
//!
//! Reads: the first 100 offers in the address's status (`?status=submitted|paused|withdrawn|accepted`,
//! else all), after the write whose receipt a change left (a read still catching up is read again
//! without it).
//!
//! Writes post to the list: a row's button sends `row` as `{action}:{offer id}`, and Pause
//! selected, Resume selected and Withdraw selected send `lifecycleAction` with the checked
//! `offerIds`. One offer is its own command, several the bulk command, as marketplace's action
//! does; the answer is each offer's outcome, drawn above the list, and an outcome newer than the
//! read is the offer's status until the read catches up (`latestSubmittedOfferStatus`). An offer
//! the API cannot find or that changed under the request is that offer's refusal, and so is every
//! offer when the lifecycle is closed (503 `offer_lifecycle_closed`). Withdraw asks first, in a
//! dialog its button opens with no script.
//!
//! The counts and the rows are drawn again on each change to the account's offers
//! (`<corten-live>` on `account:{id}:offers`).
//!
//! An offer's own page (`account-offer-submitted`, `/account/offers/submitted/{id}`): its overview
//! (price and status, options, quantity, the accepting seller's reputation, the price lines and
//! where it is), and Pause, Resume and Withdraw for it, which post to the page and answer it with
//! the outcome, read after the write. An offer that is not the account's is a 404; one whose read
//! has not caught up with the write the address follows is marketplace's "Preparing submitted
//! offer" with Refresh, read again in 2 s.
//!
//! Not ported yet: market following (`MarketFollowingOfferControls`, an offer's buyer policy:
//! preview, authorize, pause and stop), on the list and on an offer's page.
use corten::{
    LiveResponse,
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
    },
    prelude::*,
};
use futures_util::StreamExt;
use platform::{realtime::Tick, receipt::Receipt};
use serde::Deserialize;

use crate::chrome::Chrome;
use crate::{
    api::{ApiError, LifecycleOutcome, SubmittedOffer, SubmittedOfferCalls as _, SubmittedOffers},
    app::{OFFERS_MANAGE, Shared, read_failed, sign_in},
    auth::{OfferBuyer, Viewer},
    text::{Pilot, SubmittedOffersMsg},
    views::{self, Layout},
};

/// The statuses the list can show, in marketplace's order (`submittedOfferStatusFilters` after `all`).
pub const STATUSES: [&str; 4] = ["submitted", "paused", "withdrawn", "accepted"];
/// The changes a buyer can make (`submittedOfferLifecycleActionValues`).
pub const ACTIONS: [&str; 3] = ["pause", "resume", "withdraw"];

/// The list's address: the status it shows.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub status: Option<String>,
}

impl Place {
    /// The status the list shows, or none for all (`parseSubmittedOfferStatusFilter`).
    pub fn status(&self) -> Option<&'static str> {
        self.status.as_deref().and_then(|s| STATUSES.into_iter().find(|known| *known == s))
    }

    pub fn of(status: Option<&str>) -> Place {
        Place { status: status.map(str::to_owned) }
    }
}

/// An offer page's address: the receipt of the write it follows.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct OfferPlace {
    pub after_write: Option<String>,
}

/// What an offer's page shows.
pub struct OfferScreen {
    pub offer: SubmittedOffer,
    pub manage: bool,
    pub outcomes: Option<Vec<LifecycleOutcome>>,
    pub refusal: Option<String>,
}

/// A lifecycle change: one row's (`row`), or the checked offers' (`lifecycleAction`, `offerIds`).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct LifecycleForm {
    pub lifecycle_action: String,
    pub offer_ids: Vec<String>,
    /// `{action}:{offer id}`.
    pub row: String,
}

/// What the page shows.
pub struct OffersScreen {
    pub offers: SubmittedOffers,
    pub place: Place,
    /// The reader may Pause, Resume and Withdraw (`offers.manage`).
    pub manage: bool,
    /// What the change before did to each offer.
    pub outcomes: Option<Vec<LifecycleOutcome>>,
    /// Why a change was refused as a whole.
    pub refusal: Option<String>,
}

/// The buyer actions a status admits (`submittedOfferLifecycleActions`): withdrawn and accepted
/// offers are final.
pub fn actions(status: &str) -> &'static [&'static str] {
    match status {
        "submitted" => &["pause", "withdraw"],
        "paused" => &["resume", "withdraw"],
        _ => &[],
    }
}

/// The offers in `status`, read after `receipt`'s write.
async fn read(
    config: &Shared,
    headers: &HeaderMap,
    status: Option<&str>,
    receipt: Option<&Receipt>,
) -> Result<SubmittedOffers, ApiError> {
    match config.platform.caller(headers, config.proto, receipt).submitted_offers(status).await {
        Err(error) if receipt.is_some() && error.catching_up() => {
            config.platform.caller(headers, config.proto, None).submitted_offers(status).await
        }
        other => other,
    }
}

/// Each outcome newer than the read is its offer's status until the read catches up.
fn overlay(offers: &mut SubmittedOffers, outcomes: &[LifecycleOutcome]) {
    for offer in &mut offers.items {
        let newer = outcomes.iter().find(|o| {
            o.offer_id == offer.offer_id && o.outcome != "rejected" && o.version.is_some_and(|v| v > offer.last_stream_version)
        });
        if let Some(status) = newer.and_then(|o| o.status.clone()) {
            offer.status = status;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: Place,
    receipt: Option<Receipt>,
    outcomes: Option<Vec<LifecycleOutcome>>,
    refusal: Option<String>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let mut offers = match read(config, headers, place.status(), receipt.as_ref()).await {
        Ok(offers) => offers,
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    if let Some(outcomes) = &outcomes {
        overlay(&mut offers, outcomes);
    }
    let manage = viewer.actor.can(OFFERS_MANAGE);
    let screen = OffersScreen { offers, place, manage, outcomes, refusal };
    let t: SubmittedOffersMsg = req.t();
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.route_submitted_offers_marketplace()} head={()}>
            <views::SubmittedOffersPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn list(
    req: Req,
    chrome: Chrome,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffers>,
) -> HtmlResult {
    let place = route.place;
    render(&req, &viewer, &config, &headers, place, None, None, None, StatusCode::OK, &chrome).await
}

/// Each offer once, in the order checked.
fn distinct(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids.into_iter().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()) {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Every offer refused with `code`.
fn rejected(ids: &[String], code: &str) -> Vec<LifecycleOutcome> {
    ids.iter()
        .map(|id| LifecycleOutcome {
            offer_id: id.clone(),
            outcome: "rejected".into(),
            status: None,
            version: None,
            code: Some(code.to_owned()),
        })
        .collect()
}

/// Pause, Resume or Withdraw, for one row or the checked offers; the list again with each
/// offer's outcome.
pub(crate) async fn change(
    req: Req,
    chrome: Chrome,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffers>,
    Form(form): Form<LifecycleForm>,
) -> HtmlResult {
    let place = route.place;
    let p: Pilot = req.t();
    let (action, ids) = match form.row.split_once(':') {
        Some((action, id)) => (action.to_owned(), distinct(vec![id.to_owned()])),
        None => (form.lifecycle_action, distinct(form.offer_ids)),
    };
    let refuse = |message: String| {
        render(
            &req,
            &viewer,
            &config,
            &headers,
            place.clone(),
            None,
            None,
            Some(message),
            StatusCode::UNPROCESSABLE_ENTITY,
            &chrome,
        )
    };
    if !ACTIONS.contains(&action.as_str()) {
        return refuse(p.submitted_offers_unknown_action().to_owned()).await;
    }
    if ids.is_empty() {
        return refuse(p.submitted_offers_choose().to_owned()).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let answer = match ids.as_slice() {
        [id] => caller.change_offer(id, &action).await.map(|(outcome, receipt)| (vec![outcome], receipt)),
        _ => caller.change_offers(&ids, &action).await,
    };
    let (outcomes, receipt) = match answer {
        Ok(answer) => answer,
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            // Closed admission refuses the whole request before any write, so every offer says so.
            Some(StatusCode::SERVICE_UNAVAILABLE) if error.code() == Some("offer_lifecycle_closed") => {
                (rejected(&ids, "offer_lifecycle_closed"), None)
            }
            Some(StatusCode::NOT_FOUND | StatusCode::CONFLICT) if ids.len() == 1 => {
                (rejected(&ids, error.code().unwrap_or("request_failed")), None)
            }
            Some(status) if status.is_client_error() => {
                let t: SubmittedOffersMsg = req.t();
                let message = error.refusal().map(str::to_owned);
                return refuse(message.unwrap_or_else(|| t.lifecycle_outcome_request_failed(&ids.join(", ")).to_string())).await;
            }
            _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    render(&req, &viewer, &config, &headers, place, receipt, Some(outcomes), None, StatusCode::OK, &chrome).await
}

/// The counts and the rows again on each change to the account's offers (marketplace's
/// `useRealtimePatchedSnapshot` on `account:{id}:offers`, which patches the rows and reloads
/// for the counts; the pilot reads the list again, so each redraw is complete).
pub(crate) async fn live(
    req: Req,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: corten::LiveSince,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffersLive>,
) -> LiveResponse {
    let place = route.place;
    let (t, p): (SubmittedOffersMsg, Pilot) = (req.t(), req.t());
    let manage = viewer.actor.can(OFFERS_MANAGE);
    let topic = format!("account:{}:offers", viewer.actor.account_id);
    let changes = config.platform.caller(&headers, config.proto, None).changes(&[&topic], since.0);
    let fragments = changes
        .take_while(|tick| std::future::ready(!matches!(tick, Tick::Refused(_))))
        .filter_map(|tick| {
            std::future::ready(match tick {
                Tick::Changed(cursor, _) => Some(cursor),
                Tick::Opened(_) | Tick::Refused(_) => None,
            })
        })
        .then(move |cursor| {
            let (config, headers, place) = (config.clone(), headers.clone(), place.clone());
            async move {
                let offers = match read(&config, &headers, place.status(), None).await {
                    Ok(offers) => offers,
                    Err(error) => {
                        tracing::warn!("the submitted offers' read for a change failed: {error}");
                        return None;
                    }
                };
                let screen = OffersScreen { offers, place, manage, outcomes: None, refusal: None };
                let html = views::submitted_offers_live_parts(t, p, &screen).to_html();
                Some(match cursor {
                    Some(cursor) => corten::Fragment::new(html).cursor(cursor),
                    None => corten::Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

/// What an offer's read came to: the offer, not the account's, or still catching up with the
/// write the address follows (`classifyPostWriteDestinationResult`'s `recover`).
enum OfferRead {
    Found(Box<SubmittedOffer>),
    NotFound,
    Preparing,
}

async fn read_offer(config: &Shared, headers: &HeaderMap, id: &str, receipt: Option<&Receipt>) -> Result<OfferRead, ApiError> {
    match config.platform.caller(headers, config.proto, receipt).submitted_offer(id).await {
        Ok(Some(offer)) => Ok(OfferRead::Found(Box::new(offer))),
        // Not found after a write: the read has not caught up with it yet (`loadAfterWrite`'s isNotFound).
        Ok(None) if receipt.is_some() => Ok(OfferRead::Preparing),
        Ok(None) => Ok(OfferRead::NotFound),
        Err(error) if receipt.is_some() && error.catching_up() => Ok(OfferRead::Preparing),
        Err(error) => Err(error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn render_offer(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<Receipt>,
    outcomes: Option<Vec<LifecycleOutcome>>,
    refusal: Option<String>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let t: SubmittedOffersMsg = req.t();
    let mut offer = match read_offer(config, headers, id, receipt.as_ref()).await {
        Ok(OfferRead::Found(offer)) => *offer,
        Ok(OfferRead::NotFound) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Ok(OfferRead::Preparing) => {
            let here = crate::app::url::SubmittedOffer { id, place: OfferPlace { after_write: receipt.map(|r| r.param()) } };
            // After a change, go to the address that carries the receipt, so reading again (and
            // Refresh) waits for the write rather than reading the post's address.
            if outcomes.is_some() {
                return req.redirect(&here);
            }
            let head = html! { <ReadAgain after={std::time::Duration::from_secs(2)} /> };
            let cart = chrome.cart().await;
            let page = html! {
                <Layout
                    req={req}
                    viewer={Some(viewer)}
                    cart={cart}
                    title={t.detail_route_submitted_offer_marketplace()}
                    head={head}
                >
                    <views::SubmittedOfferPreparing t={t} refresh={here.href()} />
                </Layout>
            };
            return req.page(page);
        }
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    if let Some(outcomes) = &outcomes {
        let mut list = SubmittedOffers { items: vec![offer], ..SubmittedOffers::default() };
        overlay(&mut list, outcomes);
        offer = list.items.remove(0);
    }
    let manage = viewer.actor.can(OFFERS_MANAGE);
    let screen = OfferScreen { offer, manage, outcomes, refusal };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.detail_route_submitted_offer_marketplace()} head={()}>
            <views::SubmittedOfferPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// An offer's page, read after the write its address names.
pub(crate) async fn detail(
    req: Req,
    chrome: Chrome,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffer<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.place.after_write.as_deref());
    render_offer(&req, &viewer, &config, &headers, &route.id, receipt, None, None, StatusCode::OK, &chrome).await
}

/// Pause, Resume or Withdraw this offer (`row` is `{action}:{offer id}`, as the list's): the page
/// again with the outcome, read after the write.
pub(crate) async fn change_one(
    req: Req,
    chrome: Chrome,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffer<'_>>,
    Form(form): Form<LifecycleForm>,
) -> HtmlResult {
    let id = route.id.to_string();
    let p: Pilot = req.t();
    let action = match form.row.split_once(':') {
        Some((action, offer)) if offer == id && ACTIONS.contains(&action) => action.to_owned(),
        _ => {
            let message = p.submitted_offers_unknown_action().to_owned();
            return render_offer(
                &req,
                &viewer,
                &config,
                &headers,
                &id,
                None,
                None,
                Some(message),
                StatusCode::UNPROCESSABLE_ENTITY,
                &chrome,
            )
            .await;
        }
    };
    let ids = [id.clone()];
    let caller = config.platform.caller(&headers, config.proto, None);
    let (outcomes, receipt) = match caller.change_offer(&id, &action).await {
        Ok((outcome, receipt)) => (vec![outcome], receipt),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            Some(StatusCode::SERVICE_UNAVAILABLE) if error.code() == Some("offer_lifecycle_closed") => {
                (rejected(&ids, "offer_lifecycle_closed"), None)
            }
            Some(StatusCode::NOT_FOUND | StatusCode::CONFLICT) => {
                (rejected(&ids, error.code().unwrap_or("request_failed")), None)
            }
            Some(status) if status.is_client_error() => {
                let t: SubmittedOffersMsg = req.t();
                let message =
                    error.refusal().map(str::to_owned).unwrap_or_else(|| t.lifecycle_outcome_request_failed(&id).to_string());
                return render_offer(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    &id,
                    None,
                    None,
                    Some(message),
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &chrome,
                )
                .await;
            }
            _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    render_offer(&req, &viewer, &config, &headers, &id, receipt, Some(outcomes), None, StatusCode::OK, &chrome).await
}
