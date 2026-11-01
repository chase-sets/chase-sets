//! The seller's offer matches (marketplace's `account-offer-matches` and `account-offer-match`
//! routes, `/account/offers/matches` and `/account/offers/matches/{id}`): the submitted offers
//! that match a listing of the seller's, with how each compares to the listing's price, and an
//! offer match's page with the fee terms accepting it would be priced with.
//!
//! Reads: the first 100 offer matches, after the write whose receipt the address carries (a read
//! still catching up is read again without it); an offer match and, while it is submitted, its
//! acceptance terms (best-effort: a failed preview shows the page without them).
//!
//! Writes, each a form posting an `intent` to the offer match's page, as marketplace's do:
//! `add-selected-offer` (Accept offer match and Add selected offer to Sell List) reads the offer
//! as Checkout's sell list does and adds its line, then goes to marketplace's sell list, which
//! reads the write; `decline-offer` declines it as the form's attempt (`attemptId`, a `SubmitKey`;
//! a post without one is still one attempt) and goes back to the list with its receipt. A
//! refusal draws the offer match's page with the API's words.
//!
//! The list is drawn again on each change to the account's offers (`<corten-live>` on
//! `account:{id}:offers`), which the offers projection writes to every seller with an active
//! listing of the offer's product.
use crate::recovery::attempt_text;
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
    api::{AcceptanceTerms, ApiError, CommandError, OfferMatch, OfferMatchCalls as _, SellList as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{OfferReviewer, Viewer},
    selling::{SellListLine, sell_list_href},
    text::{OfferMatchesMsg, Pilot},
    views::{self, Layout},
};

/// The list's address: the write it is read after.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub after_write: Option<String>,
}

/// An offer match's forms: the intent and, for a decline, its attempt (a `SubmitKey`).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct OfferForm {
    pub intent: String,
    pub attempt_id: Option<SubmitKey>,
}

/// What an offer match's page shows.
pub struct OfferScreen {
    pub offer: OfferMatch,
    pub terms: Option<AcceptanceTerms>,
    /// Why a write was refused.
    pub refusal: Option<String>,
}

pub(crate) async fn list(
    req: Req,
    Caller(OfferReviewer(viewer)): Caller<OfferReviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::offer_matches::OfferMatches>,
) -> HtmlResult {
    let place = route.place;
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let matches = match caller.offer_matches().await {
        Ok(matches) => matches,
        Err(error) if receipt.is_some() && error.catching_up() => {
            match config.platform.caller(&headers, config.proto, None).offer_matches().await {
                Ok(matches) => matches,
                Err(error) => return read_failed(&req, Some(&viewer), error, None),
            }
        }
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let req = &req;
    let t: OfferMatchesMsg = req.t();
    req.page(html! {
        <Layout req={req} viewer={Some(&viewer)} title={t.routes_offer_matches_marketplace()} head={()}>
            <views::OfferMatchesPage t={t} p={req.t()} matches={&matches} />
        </Layout>
    })
}

/// The list's parts again on each change to the account's offers.
pub(crate) async fn live(
    req: Req,
    Caller(OfferReviewer(viewer)): Caller<OfferReviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: corten::LiveSince,
) -> LiveResponse {
    let (t, p): (OfferMatchesMsg, Pilot) = (req.t(), req.t());
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
            let (config, headers) = (config.clone(), headers.clone());
            async move {
                let matches = match config.platform.caller(&headers, config.proto, None).offer_matches().await {
                    Ok(matches) => matches,
                    Err(error) => {
                        tracing::warn!("the offer matches' read for a change failed: {error}");
                        return None;
                    }
                };
                let html = views::offer_matches_live_parts(t, p, &matches).to_html();
                Some(match cursor {
                    Some(cursor) => corten::Fragment::new(html).cursor(cursor),
                    None => corten::Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

/// An offer match's page, with `refusal` when a write was refused.
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let offer = match caller.offer_match(id).await {
        Ok(Some(offer)) => offer,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    // Marketplace's page fails when the preview does; the offer is still worth showing.
    let terms = match offer.status.as_str() {
        "submitted" => caller
            .acceptance_terms(id, &offer.listing_id)
            .await
            .inspect_err(|error| tracing::warn!("the acceptance terms' read failed: {error}"))
            .ok(),
        _ => None,
    };
    let t: OfferMatchesMsg = req.t();
    let screen = OfferScreen { offer, terms, refusal };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_offer_match_marketplace()} head={()}>
            <views::OfferMatchPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn page(
    req: Req,
    Caller(OfferReviewer(viewer)): Caller<OfferReviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::offer_matches::OfferMatch<'_>>,
) -> HtmlResult {
    let id = route.id;
    render(&req, &viewer, &config, &headers, &id, None, StatusCode::OK).await
}

/// Add selected offer to Sell List (and Accept offer match, which adds it too) and Decline.
pub(crate) async fn write(
    req: Req,
    Caller(OfferReviewer(viewer)): Caller<OfferReviewer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::offer_matches::OfferMatch<'_>>,
    Form(form): Form<OfferForm>,
) -> HtmlResult {
    let id = route.id;
    let t: OfferMatchesMsg = req.t();
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let error = match form.intent.as_str() {
        "add-selected-offer" => {
            let offer = match caller.sell_list_offer(&id).await {
                Ok(Some(offer)) if offer.status == "submitted" => offer,
                Ok(_) => {
                    let refusal = Some(p.offer_matches_unavailable().to_owned());
                    return render(&req, &viewer, &config, &headers, &id, refusal, StatusCode::CONFLICT).await;
                }
                Err(error) => return read_failed(&req, Some(&viewer), error, None),
            };
            match caller.add_sell_list_line(&SellListLine::offer_match(&offer), None).await {
                Ok(receipt) => {
                    let receipt = receipt.as_ref().map(Receipt::param).unwrap_or_default();
                    let to = sell_list_href(&receipt).parse::<corten::axum::http::Uri>().map_err(corten::Error::new)?;
                    return req.redirect(&to);
                }
                Err(error) => error,
            }
        }
        "decline-offer" => {
            match caller.decline_offer_match(&id, &crate::cart_attempt::attempt_id(attempt_text(&form.attempt_id))).await {
                Ok(receipt) => {
                    return req
                        .redirect(&url::OfferMatches { place: Place { after_write: receipt.as_ref().map(Receipt::param) } });
                }
                Err(CommandError::Api(error)) => error,
                Err(other) => {
                    tracing::warn!("a decline was refused with a listing's conflict: {other:?}");
                    let refusal = Some(t.route_request_failed().to_owned());
                    return render(&req, &viewer, &config, &headers, &id, refusal, StatusCode::CONFLICT).await;
                }
            }
        }
        _ => return Err(corten::Error::status(StatusCode::BAD_REQUEST)),
    };
    refused(&req, &viewer, &config, &headers, &id, error, t).await
}

/// A write the API refused (4xx), as the offer match's page with its words; anything else is a 502.
async fn refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    error: ApiError,
    t: OfferMatchesMsg,
) -> HtmlResult {
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Some(StatusCode::NOT_FOUND) => return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
        Some(status) if status.is_client_error() => status,
        _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let message = error.refusal().unwrap_or(t.route_request_failed()).to_owned();
    let status = if status == StatusCode::CONFLICT { status } else { StatusCode::UNPROCESSABLE_ENTITY };
    render(req, viewer, config, headers, id, Some(message), status).await
}
