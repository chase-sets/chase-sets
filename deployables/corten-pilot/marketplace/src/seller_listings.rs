//! The seller's list of listings (marketplace's `account-listings` route, `/account/listings`):
//! the account-wide time away and order capacity, the listings' counts and the seller's
//! reliability, the listings a page at a time with the status and title filters, bulk Pause and
//! Withdraw, and the fee lock report.
//!
//! Reads: the page of listings, the fee lock report, the availability and the order capacity,
//! after the write whose receipt the address carries; the seller's metrics and Ordering's count of
//! open orders without it, best-effort (a failure shows them unavailable, never the page's error).
//! While a write's projection is not readable yet, the page reads without the receipt and shows
//! the setting the address says was written (marketplace's `availabilityAction` and
//! `settingsAction` recovery).
//!
//! Writes, each its own form posting an `intent` to the page: turn listings off or on, schedule or
//! cancel an away window, set or remove the order capacity (each redirects to the page with its
//! receipt), and Pause or Withdraw the checked listings (the page again, each listing's outcome
//! shown, read after the latest write). A date a seller picks means the start of that day where
//! they are (marketplace's `localDateInputToInstant`): the browser's time zone (`ClientZone`), or
//! before the runtime has run (a first page, no JavaScript) the zone the account chose in
//! Identity's preferences, or UTC.
use corten::{
    ClientZone, LiveResponse,
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
    },
    form::Errors,
    prelude::*,
};
use futures_util::{StreamExt, future::join_all};
use platform::{realtime::Tick, receipt::Receipt};
use serde::Deserialize;

use crate::{
    api::{
        ApiError, Availability, Caller as Api, CommandError, FeeLockRow, ListingCommand, ListingPage, OrderCapacity,
        PreferenceCalls as _, SellerListingList as _, SellerListings as _, SellerMetrics, SellerSetting, segment,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{ListingManager, Viewer},
    text::{Pilot, SellerListingsMsg},
    views::{self, Layout},
};

/// The statuses the list filters by (`SELLER_LISTING_STATUSES`).
pub const STATUSES: [&str; 4] = ["draft", "active", "paused", "withdrawn"];
/// The away reasons (`parseSellerListingAvailabilityReason`).
pub const REASONS: [&str; 4] = ["travel", "audit", "operations", "other"];
const DEFAULT_LIMIT: u64 = 100;
const MAX_LIMIT: u64 = 250;

/// What the page's address carries, in marketplace's names: the filters and the page, the last
/// write's receipt, and what that write set, for while it is not readable yet.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub status: Option<String>,
    pub search: Option<String>,
    pub limit: Option<String>,
    pub offset: Option<String>,
    pub after_write: Option<String>,
    /// `disabled` or `enabled`: listings were turned off or on.
    pub availability_action: Option<String>,
    /// The other settings' intent, with what it set below.
    pub settings_action: Option<String>,
    pub away_window_reason_category: Option<String>,
    pub away_window_starts_at: Option<String>,
    pub away_window_ends_at: Option<String>,
    pub max_open_orders: Option<String>,
}

/// The list's filters and page (`sellerListingFilters`, `sellerListingPageQuery`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filters {
    /// One of `STATUSES`, or none for all.
    pub status: Option<&'static str>,
    pub search: String,
    pub limit: u64,
    pub offset: u64,
}

impl Filters {
    pub fn read(place: &Place) -> Self {
        let status = place.status.as_deref().map(str::trim).and_then(|s| STATUSES.into_iter().find(|known| *known == s));
        let number = |text: &Option<String>| text.as_deref().and_then(|t| t.trim().parse::<u64>().ok());
        Filters {
            status,
            search: place.search.as_deref().unwrap_or_default().trim().to_owned(),
            limit: number(&place.limit).filter(|n| *n >= 1).unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT),
            offset: number(&place.offset).unwrap_or(0),
        }
    }

    /// The API's query: `limit`, `offset`, and the filters set.
    pub fn query(&self) -> String {
        let mut query = format!("limit={}&offset={}", self.limit, self.offset);
        if let Some(status) = self.status {
            query.push_str(&format!("&status={status}"));
        }
        if !self.search.is_empty() {
            query.push_str(&format!("&search={}", segment(&self.search)));
        }
        query
    }

    /// The list with these filters, at `offset` (the page size only when it is not the default).
    pub fn at(&self, offset: u64) -> url::SellerListings {
        let place = Place {
            status: self.status.map(str::to_owned),
            search: Some(self.search.clone()).filter(|s| !s.is_empty()),
            limit: (self.limit != DEFAULT_LIMIT).then(|| self.limit.to_string()),
            offset: (offset != 0).then(|| offset.to_string()),
            ..Place::default()
        };
        url::SellerListings { place }
    }

    /// The list as it is now: where its forms post.
    pub fn here(&self) -> url::SellerListings {
        self.at(self.offset)
    }

    /// The list without the status filter, or without the title filter (an applied filter's chip).
    pub fn without_status(&self) -> url::SellerListings {
        Filters { status: None, offset: 0, ..self.clone() }.here()
    }

    pub fn without_search(&self) -> url::SellerListings {
        Filters { search: String::new(), offset: 0, ..self.clone() }.here()
    }
}

/// The forms' fields, for their names: marketplace's.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ListingsForm {
    pub intent: String,
    pub reason_category: String,
    /// The date listings come back: a day where the seller is.
    pub available_again_on: String,
    pub away_window_reason_category: String,
    pub away_window_starts_on: String,
    pub away_window_ends_on: String,
    pub max_open_orders: String,
    /// The checked listings, for Pause selected and Withdraw selected.
    pub listing_ids: Vec<String>,
}

/// One listing's outcome of a bulk Pause or Withdraw (`MarketplaceListingBulkActionOutcome`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub listing_id: String,
    pub ok: bool,
    pub message: Option<String>,
}

/// The page.
pub struct ListingsScreen {
    pub page: ListingPage,
    pub fees: Vec<FeeLockRow>,
    pub availability: Availability,
    pub capacity: OrderCapacity,
    /// Ordering's count of open orders; none when it could not be read.
    pub open_orders: Option<u64>,
    /// None when the metrics could not be read, or were not all valid.
    pub metrics: Option<SellerMetrics>,
    pub filters: Filters,
    pub outcomes: Option<Vec<Outcome>>,
    /// What a refused write was refused for: the page's banner and the fields'.
    pub errors: Errors,
    /// The refused form as it was sent.
    pub sent: ListingsForm,
}

/// What a write adds to the page drawn after it.
#[derive(Default)]
struct After {
    outcomes: Option<Vec<Outcome>>,
    errors: Errors,
    sent: ListingsForm,
}

struct Reads {
    page: ListingPage,
    fees: Vec<FeeLockRow>,
    availability: Availability,
    capacity: OrderCapacity,
}

async fn reads(caller: &Api<'_>, query: &str) -> Result<Reads, ApiError> {
    let (page, fees, availability, capacity) = tokio::join!(
        caller.seller_listing_page(query),
        caller.fee_lock_report(),
        caller.listing_availability(),
        caller.order_capacity(),
    );
    Ok(Reads { page: page?, fees: fees?, availability: availability?, capacity: capacity? })
}

/// The setting the address says was just written, over a read that does not have it yet
/// (`applySettingsRecovery`, and `availabilityAction`'s status).
fn overlay(place: &Place, reads: &mut Reads) {
    match place.availability_action.as_deref() {
        Some("disabled") => reads.availability.status = "unavailable".into(),
        Some("enabled") => reads.availability.status = "available".into(),
        _ => {}
    }
    let some = |value: &Option<String>| value.clone().filter(|v| !v.trim().is_empty());
    let a = &mut reads.availability;
    match place.settings_action.as_deref() {
        Some("schedule-away-window") if some(&place.away_window_starts_at).is_some() => {
            a.away_window_starts_at = some(&place.away_window_starts_at);
            a.away_window_ends_at = some(&place.away_window_ends_at);
            a.away_window_reason_category = some(&place.away_window_reason_category);
        }
        Some("cancel-away-window") => {
            a.away_window_starts_at = None;
            a.away_window_ends_at = None;
            a.away_window_reason_category = None;
        }
        Some("set-order-capacity") => {
            if let Some(max) = place.max_open_orders.as_deref().and_then(|m| m.parse::<u64>().ok()).filter(|m| *m >= 1) {
                reads.capacity.max_open_orders = Some(max);
            }
        }
        Some("clear-order-capacity") => reads.capacity.max_open_orders = None,
        _ => {}
    }
}

/// The page, read after `receipt`'s write.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    receipt: Option<Receipt>,
    after: After,
    status: StatusCode,
) -> HtmlResult {
    let filters = Filters::read(place);
    let query = filters.query();
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    // Neither has a write on this page to wait for, and neither may fail the page.
    let plain = config.platform.caller(headers, config.proto, None);
    let (fresh, metrics, open_orders) = tokio::join!(reads(&caller, &query), plain.seller_metrics(), plain.open_order_count());
    let reads = match fresh {
        Ok(reads) => reads,
        Err(error) if receipt.is_some() && error.catching_up() => match self::reads(&plain, &query).await {
            Ok(mut reads) => {
                overlay(place, &mut reads);
                reads
            }
            Err(error) => return read_failed(req, Some(viewer), error, None),
        },
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let metrics = match metrics {
        Ok(metrics) if metrics.valid() => Some(metrics),
        Ok(_) => {
            tracing::warn!("the seller metrics have a rate that is not a fraction from 0 to 1");
            None
        }
        Err(error) => {
            tracing::warn!("the seller metrics read failed: {error}");
            None
        }
    };
    let open_orders = open_orders.inspect_err(|error| tracing::warn!("the open order count read failed: {error}")).ok();
    let screen = ListingsScreen {
        page: reads.page,
        fees: reads.fees,
        availability: reads.availability,
        capacity: reads.capacity,
        open_orders,
        metrics,
        filters,
        outcomes: after.outcomes,
        errors: after.errors,
        sent: after.sent,
    };
    let t: SellerListingsMsg = req.t();
    let view = html! { <views::SellerListingsPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_listings_marketplace()} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

pub(crate) async fn page(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListings>,
) -> HtmlResult {
    let place = route.place;
    let receipt = Receipt::from_param(place.after_write.as_deref());
    render(&req, &viewer, &config, &headers, &place, receipt, After::default(), StatusCode::OK).await
}

/// A date a form sent, as the API takes it: `YYYY-MM-DD`.
fn date(text: &str) -> Option<&str> {
    let text = text.trim();
    let b = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    (b.len() == 10 && b[4] == b'-' && b[7] == b'-' && digits(0..4) && digits(5..7) && digits(8..10)).then_some(text)
}

/// Where the seller is: the browser's zone, or before the runtime has run on a page (a first page,
/// no JavaScript) the zone the account chose in Identity's preferences, or UTC when neither is
/// known or names a zone.
async fn seller_zone(zone: Option<ClientZone>, caller: &Api<'_>) -> jiff::tz::TimeZone {
    if let Some(here) = zone.and_then(|ClientZone(name)| jiff::tz::TimeZone::get(&name).ok()) {
        return here;
    }
    match caller.user_preferences().await {
        Ok(preferences) => preferences.time_zone.and_then(|name| jiff::tz::TimeZone::get(&name).ok()),
        Err(error) => {
            tracing::warn!("the account's time zone could not be read, so a picked day is read in UTC: {error:?}");
            None
        }
    }
    .unwrap_or(jiff::tz::TimeZone::UTC)
}

/// The start of a picked day (`YYYY-MM-DD`) in `zone`, as marketplace's script writes it
/// (`toISOString`: `2026-11-02T06:00:00.000Z`). A midnight the zone skips is the first moment after.
fn start_of_day(day: &str, zone: &jiff::tz::TimeZone) -> Option<String> {
    let date: jiff::civil::Date = day.parse().ok()?;
    let at = date.to_zoned(zone.clone()).ok()?.timestamp();
    Some(format!("{}.{:03}Z", at.strftime("%Y-%m-%dT%H:%M:%S"), at.subsec_millisecond()))
}

/// The setting a form changes, or what it got wrong. A picked day is read in `zone`.
fn setting(form: &ListingsForm, zone: &jiff::tz::TimeZone, t: SellerListingsMsg, p: Pilot) -> Result<SellerSetting, Errors> {
    let f = ListingsForm::FIELDS;
    let mut errors = Errors::new();
    let reason = |text: &str, name, errors: &mut Errors| {
        let text = text.trim();
        if !text.is_empty() && !REASONS.contains(&text) {
            errors.add(name, t.error_availability_reason_invalid());
        }
        text.to_owned()
    };
    let setting = match form.intent.as_str() {
        "disable-listing-availability" => {
            let reason = reason(&form.reason_category, f.reason_category, &mut errors);
            let on = form.available_again_on.trim();
            let at = match on {
                "" => String::new(),
                on => date(on).and_then(|on| start_of_day(on, zone)).unwrap_or_else(|| {
                    errors.add(f.available_again_on, p.seller_listings_date());
                    String::new()
                }),
            };
            SellerSetting::Disable { reason, on: on.to_owned(), at }
        }
        "enable-listing-availability" => SellerSetting::Enable,
        "schedule-away-window" => {
            let reason = reason(&form.away_window_reason_category, f.away_window_reason_category, &mut errors);
            if reason.is_empty() {
                errors.add(f.away_window_reason_category, t.error_away_window_reason_required());
            }
            let (starts_on, ends_on) = (form.away_window_starts_on.trim(), form.away_window_ends_on.trim());
            let starts_at = date(starts_on).and_then(|on| start_of_day(on, zone));
            let ends_at = date(ends_on).and_then(|on| start_of_day(on, zone));
            if starts_on.is_empty() {
                errors.add(f.away_window_starts_on, t.error_away_window_instant_required());
            } else if starts_at.is_none() {
                errors.add(f.away_window_starts_on, p.seller_listings_date());
            }
            if !ends_on.is_empty() && ends_at.is_none() {
                errors.add(f.away_window_ends_on, p.seller_listings_date());
            }
            SellerSetting::Schedule { reason, starts_at: starts_at.unwrap_or_default(), ends_at: ends_at.unwrap_or_default() }
        }
        "cancel-away-window" => SellerSetting::CancelWindow,
        "set-order-capacity" => match form.max_open_orders.trim().parse::<u64>() {
            Ok(max) if max >= 1 => SellerSetting::Capacity(max),
            _ => {
                errors.add(f.max_open_orders, t.error_order_capacity_invalid());
                return Err(errors);
            }
        },
        "clear-order-capacity" => SellerSetting::ClearCapacity,
        _ => {
            errors.add_form(p.check_attempt());
            return Err(errors);
        }
    };
    errors.into_result(setting)
}

/// Where a setting that applied goes: the list as it was, after the write, saying what it set
/// (`navigateAfterWrite` to `settingsDestination`).
fn applied(place: &Place, receipt: Option<&Receipt>, setting: &SellerSetting) -> url::SellerListings {
    let mut to = Filters::read(place).here();
    let p = &mut to.place;
    p.after_write = receipt.map(Receipt::param);
    let action = |name: &str| Some(name.to_owned());
    match setting {
        SellerSetting::Disable { .. } => p.availability_action = action("disabled"),
        SellerSetting::Enable => p.availability_action = action("enabled"),
        SellerSetting::Schedule { reason, starts_at, ends_at } => {
            p.settings_action = action("schedule-away-window");
            p.away_window_reason_category = Some(reason.clone());
            p.away_window_starts_at = Some(starts_at.clone());
            p.away_window_ends_at = Some(ends_at.clone()).filter(|e| !e.is_empty());
        }
        SellerSetting::CancelWindow => p.settings_action = action("cancel-away-window"),
        SellerSetting::Capacity(max) => {
            p.settings_action = action("set-order-capacity");
            p.max_open_orders = Some(max.to_string());
        }
        SellerSetting::ClearCapacity => p.settings_action = action("clear-order-capacity"),
    }
    to
}

/// The listing API's refusal codes and marketplace's words for them (`listingErrorContract`).
fn refusal(t: SellerListingsMsg, code: &str) -> Option<&str> {
    Some(match code {
        "listing_request_unknown_field" => t.error_unknown_field(),
        "listing_availability_reason_invalid" => t.error_availability_reason_invalid(),
        "away_window_reason_required" => t.error_away_window_reason_required(),
        "away_window_instant_required" => t.error_away_window_instant_required(),
        "order_capacity_invalid" => t.error_order_capacity_invalid(),
        "listing_request_id_invalid" => t.error_id_invalid(),
        "listing_not_found" => t.error_listing_not_found(),
        "listing_command_rejected" => t.error_command_rejected(),
        "listing_evidence_incomplete" => t.error_evidence_incomplete(),
        "fee_quote_stale" => t.error_fee_quote_stale(),
        _ => return None,
    })
}

/// The field a refusal is about, on the form `intent` sent.
fn refused_field(intent: &str, code: &str) -> Option<FieldName> {
    let f = ListingsForm::FIELDS;
    match code {
        "listing_availability_reason_invalid" if intent == "disable-listing-availability" => Some(f.reason_category),
        "listing_availability_reason_invalid" | "away_window_reason_required" => Some(f.away_window_reason_category),
        "away_window_instant_required" => Some(f.away_window_starts_on),
        "order_capacity_invalid" => Some(f.max_open_orders),
        _ => None,
    }
}

pub(crate) async fn write(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    zone: Option<ClientZone>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListings>,
    Form(form): Form<ListingsForm>,
) -> HtmlResult {
    let place = route.place;
    let (t, p): (SellerListingsMsg, Pilot) = (req.t(), req.t());
    if let Some(command) = match form.intent.as_str() {
        "bulk-pause-listings" => Some(ListingCommand::Pause),
        "bulk-withdraw-listings" => Some(ListingCommand::Withdraw),
        _ => None,
    } {
        return bulk(&req, &viewer, &config, &headers, &place, form, command).await;
    }
    let refused_page = |errors: Errors, form: ListingsForm, status| {
        let after = After { errors, sent: form, ..After::default() };
        render(&req, &viewer, &config, &headers, &place, None, after, status)
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    // Only a form with a day reads where the seller is, so the others never read Identity.
    let zone = match form.intent.as_str() {
        "disable-listing-availability" | "schedule-away-window" => seller_zone(zone, &caller).await,
        _ => jiff::tz::TimeZone::UTC,
    };
    let setting = match setting(&form, &zone, t, p) {
        Ok(setting) => setting,
        Err(errors) => return refused_page(errors, form, StatusCode::UNPROCESSABLE_ENTITY).await,
    };
    let error = match caller.seller_setting(&setting).await {
        Ok(receipt) => return req.redirect(&applied(&place, receipt.as_ref(), &setting)),
        Err(CommandError::Api(error)) => error,
        Err(other) => {
            tracing::warn!("a listing setting was refused with a listing's conflict: {other:?}");
            let mut errors = Errors::new();
            errors.add_form(t.route_bulk_action_request_failed());
            return refused_page(errors, form, StatusCode::CONFLICT).await;
        }
    };
    let status = match error.status() {
        Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
        Some(status) if status.is_client_error() => status,
        _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    let message =
        error.code().and_then(|code| refusal(t, code)).or(error.refusal()).unwrap_or(t.route_bulk_action_request_failed());
    let mut errors = Errors::new();
    match error.code().and_then(|code| refused_field(&form.intent, code)) {
        Some(field) => errors.add(field, message),
        None => errors.add_form(message),
    }
    let status = if status == StatusCode::CONFLICT { status } else { StatusCode::UNPROCESSABLE_ENTITY };
    refused_page(errors, form, status).await
}

/// Pause selected or Withdraw selected: each checked listing's write, side by side, then the page
/// with each one's outcome, read after the latest write. A refusal (4xx) is that listing's
/// outcome; a failure (5xx, no answer) is the error page, as marketplace's action throws.
async fn bulk(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    form: ListingsForm,
    command: ListingCommand,
) -> HtmlResult {
    let (t, p): (SellerListingsMsg, Pilot) = (req.t(), req.t());
    let mut ids: Vec<String> = Vec::new();
    for id in form.listing_ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        let mut errors = Errors::new();
        errors.add_form(p.seller_listings_choose_listings());
        let after = After { errors, sent: form, ..After::default() };
        return render(req, viewer, config, headers, place, None, after, StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let caller = config.platform.caller(headers, config.proto, None);
    let answers = join_all(ids.iter().map(|id| caller.listing_command(id, &command))).await;
    let mut latest: Option<Receipt> = None;
    let mut outcomes = Vec::with_capacity(ids.len());
    for (listing_id, answer) in ids.into_iter().zip(answers) {
        let message = match answer {
            Ok(receipt) => {
                latest = match (latest, receipt) {
                    (Some(a), Some(b)) => Some(a.later(b)),
                    (a, b) => a.or(b),
                };
                outcomes.push(Outcome { listing_id, ok: true, message: None });
                continue;
            }
            Err(CommandError::Api(error)) => match error.status() {
                Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
                Some(status) if status.is_client_error() => {
                    error.code().and_then(|code| refusal(t, code)).or(error.refusal()).map(str::to_owned)
                }
                _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            },
            // A 409 that carries a fee quote or evidence: still that listing's refusal.
            Err(CommandError::StaleQuote(_)) => Some(t.error_fee_quote_stale().to_owned()),
            Err(CommandError::EvidenceIncomplete { message, .. }) => Some(message),
        };
        let message = message.unwrap_or_else(|| t.route_bulk_action_request_failed().to_owned());
        outcomes.push(Outcome { listing_id, ok: false, message: Some(message) });
    }
    let after = After { outcomes: Some(outcomes), ..After::default() };
    render(req, viewer, config, headers, place, latest, after, StatusCode::OK).await
}

/// The list's parts for `<corten-live>` (marketplace's `useRealtimePatchedSnapshot` on
/// `account:{id}:listings`): on each change to the account's listings, the page of listings and
/// the fee lock report are read again and drawn again: the counts, the rows (a box the seller
/// checked keeps its mark) and the report. Marketplace patches the rows it is sent, and reloads
/// the page when the stream asks it to sync; the pilot reads again, so each redraw is complete.
pub(crate) async fn live(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: corten::LiveSince,
    Params(route): Params<crate::app::url::seller_listings::SellerListingsLive>,
) -> LiveResponse {
    let place = route.place;
    let (t, p): (SellerListingsMsg, Pilot) = (req.t(), req.t());
    let filters = Filters::read(&place);
    let topic = format!("account:{}:listings", viewer.actor.account_id);
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
            let (config, headers, filters) = (config.clone(), headers.clone(), filters.clone());
            async move {
                let caller = config.platform.caller(&headers, config.proto, None);
                let query = filters.query();
                let (page, fees) = tokio::join!(caller.seller_listing_page(&query), caller.fee_lock_report());
                let (page, fees) = match (page, fees) {
                    (Ok(page), Ok(fees)) => (page, fees),
                    (Err(error), _) | (_, Err(error)) => {
                        tracing::warn!("the listings' read for a change failed: {error}");
                        return None;
                    }
                };
                let html = views::seller_listings_live_parts(t, p, &page, &fees, &filters).to_html();
                Some(match cursor {
                    Some(cursor) => corten::Fragment::new(html).cursor(cursor),
                    None => corten::Fragment::new(html),
                })
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(pairs: &[(&str, &str)]) -> Place {
        let mut place = Place::default();
        for (name, value) in pairs {
            let value = Some((*value).to_owned());
            match *name {
                "status" => place.status = value,
                "search" => place.search = value,
                "limit" => place.limit = value,
                "offset" => place.offset = value,
                _ => unreachable!(),
            }
        }
        place
    }

    #[test]
    fn the_filters_are_marketplaces_with_a_bounded_page() {
        let f = Filters::read(&place(&[]));
        assert_eq!(f.query(), "limit=100&offset=0");
        let f = Filters::read(&place(&[("status", " paused "), ("search", " Base Set "), ("limit", "500"), ("offset", "20")]));
        assert_eq!(f.query(), "limit=250&offset=20&status=paused&search=Base%20Set");
        let f = Filters::read(&place(&[("status", "sold"), ("limit", "0"), ("offset", "-1")]));
        assert_eq!((f.status, f.limit, f.offset), (None, 100, 0), "an unknown status is all, a bad page the first");
    }

    #[test]
    fn a_date_is_four_two_and_two_digits() {
        assert_eq!(date(" 2026-11-02 "), Some("2026-11-02"));
        for bad in ["2026-1-02", "11/02/2026", "2026-11-0x", ""] {
            assert_eq!(date(bad), None, "{bad}");
        }
    }
}
