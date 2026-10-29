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
//! Not ported yet: market following (`MarketFollowingOfferControls`, an offer's buyer policy:
//! preview, authorize, pause and stop) and an offer's own page, which Open leaves for on
//! marketplace.
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

use crate::{
    api::{ApiError, LifecycleOutcome, SubmittedOfferCalls as _, SubmittedOffers},
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
) -> HtmlResult {
    let mut offers = match read(config, headers, place.status(), receipt.as_ref()).await {
        Ok(offers) => offers,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    if let Some(outcomes) = &outcomes {
        overlay(&mut offers, outcomes);
    }
    let manage = viewer.actor.can(OFFERS_MANAGE);
    let screen = OffersScreen { offers, place, manage, outcomes, refusal };
    let t: SubmittedOffersMsg = req.t();
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_submitted_offers_marketplace()} head={()}>
            <views::SubmittedOffersPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn list(
    req: Req,
    Caller(OfferBuyer(viewer)): Caller<OfferBuyer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::submitted_offers::SubmittedOffers>,
) -> HtmlResult {
    let place = route.place;
    render(&req, &viewer, &config, &headers, place, None, None, None, StatusCode::OK).await
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
        render(&req, &viewer, &config, &headers, place.clone(), None, None, Some(message), StatusCode::UNPROCESSABLE_ENTITY)
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
    render(&req, &viewer, &config, &headers, place, receipt, Some(outcomes), None, StatusCode::OK).await
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
