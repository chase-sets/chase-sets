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
//! `settingsAction` recovery). When the address names a change (`listingRecovery`), the page reads
//! back what came of it and says so above the rest (`listing_recovery`); if the rest cannot be
//! read, it says only that (marketplace's `recoveryOnly`).
//!
//! Writes, each its own form posting an `intent` to the page with its `SubmitKey`: turn listings
//! off or on, schedule or cancel an away window, set or remove the order capacity, and Pause or
//! Withdraw the checked listings as one change. Each is prepared first and sent under the attempt
//! Marketplace prepared it as, so a form sent again applies once; then the page follows with the
//! write's receipt and the change on its address, saying what came of it (each listing of a bulk
//! change, with Retry for those still unknown). A change whose answer was lost is the page naming
//! it, read back; one refused is the page again with the API's words. A date a seller picks means
//! the start of that day where
//! they are (marketplace's `localDateInputToInstant`). The page draws the day forms in the
//! browser's time zone (`req.zone()`), or before the runtime has run (a first page, no JavaScript)
//! the zone the account chose in Identity's preferences, or UTC; each form sends that zone back
//! (`FormZone`) and its post reads the day's start in it (`Day::start`). A day sent without the
//! form's zone (not from this page) is refused.
use corten::{
    LiveResponse, SubmitKey,
    extract::State,
    form::{DrawZone, Errors, FormZone},
    http::{HeaderMap, StatusCode},
    i18n::{Day, Visitor},
    prelude::*,
};
use futures_util::StreamExt;
use platform::{realtime::Tick, receipt::Receipt};

use crate::{
    api::{
        ApiError, Availability, Caller as Api, CommandError, FeeLockRow, ListingPage, ListingRecovery, ListingReference,
        OrderCapacity, PreferenceCalls as _, SellerListingList as _, SellerListings as _, SellerMetrics, SellerSetting, segment,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{ListingManager, Viewer},
    listing_recovery::{self, Change, Next},
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
#[derive(Clone, Debug, Default, Fields, Route)]
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
    /// A prepared change whose outcome the page says (`ListingReference`'s JSON).
    pub listing_recovery: Option<String>,
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
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ListingsForm {
    pub intent: String,
    pub reason_category: String,
    /// The date listings come back: a day where the seller is.
    pub available_again_on: Entry<Day>,
    pub away_window_reason_category: String,
    pub away_window_starts_on: Entry<Day>,
    pub away_window_ends_on: Entry<Day>,
    /// The zone a day form was drawn in, which its days begin in.
    pub zone: Option<FormZone>,
    pub max_open_orders: String,
    /// The checked listings, for Pause selected and Withdraw selected.
    pub listing_ids: Vec<String>,
    /// The form's attempt, drawn with it (marketplace's `ListingCommandForm`): Marketplace prepares
    /// the change as this attempt, so the same form sent again is the same change.
    pub attempt: Option<SubmitKey>,
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
    /// What came of the change the address names, or of one the page did not send.
    pub recovery: Option<ListingRecovery>,
    /// The page as it is, naming the change: where its forms post.
    pub action: url::SellerListings,
    /// What a refused write was refused for: the page's banner and the fields'.
    pub errors: Errors,
    /// The refused form as it was sent.
    pub sent: ListingsForm,
    /// Where the seller is: the zone the day forms are drawn in.
    pub zone: DrawZone,
}

impl ListingsScreen {
    /// Whether the page's changes are off: what it says came of a change is recorded, or nothing
    /// is confirmed (`ListingRecovery::blocks`).
    pub fn blocked(&self) -> bool {
        self.recovery.as_ref().is_some_and(ListingRecovery::blocks)
    }
}

/// What a write adds to the page drawn after it.
#[derive(Default)]
struct After {
    /// What came of a change the page did not send.
    recovery: Option<ListingRecovery>,
    errors: Errors,
    sent: ListingsForm,
    /// The zone a refused day form was drawn in, to draw it again in.
    zone: Option<DrawZone>,
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
    let After { recovery, errors, sent, zone: drawn } = after;
    let zone = async {
        match drawn {
            Some(zone) => zone,
            None => seller_zone(req, &plain).await,
        }
    };
    // What came of the change the address names, read without the receipt (`nonFreshApi`).
    let recovery = async {
        match recovery {
            Some(recovery) => Some(recovery),
            None => listing_recovery::read(&plain, place.listing_recovery.as_deref()).await,
        }
    };
    let (fresh, metrics, open_orders, zone, recovery) =
        tokio::join!(reads(&caller, &query), plain.seller_metrics(), plain.open_order_count(), zone, recovery);
    let action = naming(&filters, place.listing_recovery.clone());
    let reads = match (fresh, &recovery) {
        (Ok(reads), _) => reads,
        // A change's outcome is still said when the page cannot be read (`recoveryOnly`).
        (Err(error), Some(recovery)) => {
            tracing::warn!("the listings could not be read after a change: {error}");
            let (here, clear) = (action.href(), filters.here().href());
            let t: SellerListingsMsg = req.t();
            let view = html! { <views::ListingRecoveryNotice t={req.t()} recovery={recovery} here={&here} clear={&clear} /> };
            return req.page(html! {
                <Layout req={req} viewer={Some(viewer)} title={t.route_listings_marketplace()} head={()}>{view}</Layout>
            });
        }
        (Err(error), None) if receipt.is_some() && error.catching_up() => match self::reads(&plain, &query).await {
            Ok(mut reads) => {
                overlay(place, &mut reads);
                reads
            }
            Err(error) => return read_failed(req, Some(viewer), error, None),
        },
        (Err(error), None) => return read_failed(req, Some(viewer), error, None),
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
        recovery,
        action,
        errors,
        sent,
        zone,
    };
    let t: SellerListingsMsg = req.t();
    let view = html! { <views::SellerListingsPage t={t} p={req.t()} r={req.t()} screen={&screen} /> };
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

/// Where the seller is, to draw the day forms in: the browser's zone, or before the runtime has run
/// on a page (a first page, no JavaScript) the zone the account chose in Identity's preferences, or
/// UTC when neither is known or names a zone.
async fn seller_zone(req: &Req, caller: &Api<'_>) -> DrawZone {
    let here = req.zone();
    if here.is_known() {
        return DrawZone::from(here);
    }
    match caller.user_preferences().await {
        Ok(preferences) => DrawZone::from(preferences.time_zone.map_or_else(Visitor::default, |name| Visitor::named(&name))),
        Err(error) => {
            tracing::warn!("the account's time zone could not be read, so a picked day is read in UTC: {error:?}");
            DrawZone::from(Visitor::default())
        }
    }
}

/// The start of a picked day in the zone its form was drawn in, as marketplace's script writes it
/// (`toISOString`: `2026-11-02T06:00:00.000Z`). A midnight the zone skips is the change.
fn start_of_day(day: Day, zone: &FormZone) -> Option<String> {
    let at = jiff::Timestamp::try_from(day.start(zone)?).ok()?;
    Some(format!("{}.{:03}Z", at.strftime("%Y-%m-%dT%H:%M:%S"), at.subsec_millisecond()))
}

/// The setting a form changes, or what it got wrong. A picked day begins where the form's zone says.
fn setting(form: &ListingsForm, t: SellerListingsMsg, p: Pilot) -> Result<SellerSetting, Errors> {
    let f = ListingsForm::FIELDS;
    let mut errors = Errors::new();
    let days = [&form.available_again_on, &form.away_window_starts_on, &form.away_window_ends_on];
    if form.zone.is_none() && days.iter().any(|day| !day.is_blank()) {
        errors.add_form(p.check_zone());
        return Err(errors);
    }
    let start = |day: &Entry<Day>| form.zone.as_ref().and_then(|zone| start_of_day(day.value()?, zone));
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
            let on = &form.available_again_on;
            let at = match on.is_blank() {
                true => String::new(),
                false => start(on).unwrap_or_else(|| {
                    errors.add(f.available_again_on, p.seller_listings_date());
                    String::new()
                }),
            };
            SellerSetting::Disable { reason, on: on.value().map(|day| day.to_string()).unwrap_or_default(), at }
        }
        "enable-listing-availability" => SellerSetting::Enable,
        "schedule-away-window" => {
            let reason = reason(&form.away_window_reason_category, f.away_window_reason_category, &mut errors);
            if reason.is_empty() {
                errors.add(f.away_window_reason_category, t.error_away_window_reason_required());
            }
            let (starts_on, ends_on) = (&form.away_window_starts_on, &form.away_window_ends_on);
            let (starts_at, ends_at) = (start(starts_on), start(ends_on));
            if starts_on.is_blank() {
                errors.add(f.away_window_starts_on, t.error_away_window_instant_required());
            } else if starts_at.is_none() {
                errors.add(f.away_window_starts_on, p.seller_listings_date());
            }
            if !ends_on.is_blank() && ends_at.is_none() {
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
    // Each setting is a Listing attempt, and a form drawn by the page has one.
    if form.attempt.is_none() {
        errors.add_form(p.check_attempt());
        return Err(errors);
    }
    errors.into_result(setting)
}

/// The list as `filters` have it, naming the change `reference` (a reference's JSON).
fn naming(filters: &Filters, reference: Option<String>) -> url::SellerListings {
    let mut to = filters.here();
    to.place.listing_recovery = reference;
    to
}

/// The list as it was, naming the change `reference`, after the write `receipt` follows: where a
/// change goes, and one whose answer was lost (`listingRecoveryUrl`).
fn changed(place: &Place, reference: &ListingReference, receipt: Option<&Receipt>) -> url::SellerListings {
    let mut to = naming(&Filters::read(place), Some(listing_recovery::param(reference)));
    to.place.after_write = receipt.map(Receipt::param);
    to
}

/// Where a setting that applied goes: the list as it was, naming the change, after the write,
/// saying what it set (`navigateAfterWrite` to `settingsDestination`).
fn applied(
    place: &Place,
    reference: &ListingReference,
    receipt: Option<&Receipt>,
    setting: &SellerSetting,
) -> url::SellerListings {
    let mut to = changed(place, reference, receipt);
    let p = &mut to.place;
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
        "invalid_attempt" => t.error_attempt_invalid(),
        "attempt_conflict" => t.error_attempt_conflict(),
        "history_incomplete" => t.error_history_incomplete(),
        _ => return None,
    })
}

/// The field a refusal is about, on the form `intent` sent.
fn refused_field(intent: &str, code: &str) -> Option<FieldName> {
    let f = ListingsForm::FIELDS;
    match code {
        "listing_availability_reason_invalid" if intent == "disable-listing-availability" => Some(f.reason_category.untyped()),
        "listing_availability_reason_invalid" | "away_window_reason_required" => Some(f.away_window_reason_category.untyped()),
        "away_window_instant_required" => Some(f.away_window_starts_on.untyped()),
        "order_capacity_invalid" => Some(f.max_open_orders.untyped()),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn write(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListings>,
    Form(form): Form<ListingsForm>,
) -> HtmlResult {
    let place = route.place;
    let (t, p): (SellerListingsMsg, Pilot) = (req.t(), req.t());
    match form.intent.as_str() {
        "bulk-pause-listings" | "bulk-withdraw-listings" => return bulk(&req, &viewer, &config, &headers, &place, form).await,
        "retry-listing-batch" => return retry(&req, &viewer, &config, &headers, &place).await,
        _ => {}
    }
    let refused_page = |errors: Errors, form: ListingsForm, status| {
        // A refused day form is drawn again in the zone it was drawn in.
        let zone = form.zone.as_ref().map(DrawZone::from);
        let after = After { errors, sent: form, zone, ..After::default() };
        render(&req, &viewer, &config, &headers, &place, None, after, status)
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let setting = match setting(&form, t, p) {
        Ok(setting) => setting,
        Err(errors) => return refused_page(errors, form, StatusCode::UNPROCESSABLE_ENTITY).await,
    };
    let change = Change {
        intent: &form.intent,
        attempt: form.attempt.as_ref().map(SubmitKey::as_str),
        listing_id: None,
        listing_ids: &[],
        fields: listing_recovery::setting_fields(&setting),
    };
    let reference = match listing_recovery::prepare(&caller, place.listing_recovery.as_deref(), change).await {
        Ok(Next::Send(reference)) => reference,
        Ok(Next::Show(recovery)) => return shown(&req, &viewer, &config, &headers, &place, form, recovery).await,
        Err(_) => return sign_in(&req),
    };
    let error = match caller.seller_setting(&setting, &reference.batch_id).await {
        Ok(receipt) => return req.redirect(&applied(&place, &reference, receipt.as_ref(), &setting)),
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
        _ if listing_recovery::interrupted(&error) => {
            tracing::warn!("a listing setting's answer was lost: {error}");
            return req.redirect(&changed(&place, &reference, None));
        }
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

/// The page again, not having sent `form`'s change, saying `recovery`.
async fn shown(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    form: ListingsForm,
    recovery: ListingRecovery,
) -> HtmlResult {
    // A day form is drawn again in the zone it was drawn in.
    let zone = form.zone.as_ref().map(DrawZone::from);
    let after = After { recovery: Some(recovery), sent: form, zone, ..After::default() };
    render(req, viewer, config, headers, place, None, after, StatusCode::CONFLICT).await
}

/// Pause selected or Withdraw selected: the checked listings as one change (marketplace's
/// `bulk-pause-listings` and `bulk-withdraw-listings`), prepared as the form's attempt and sent
/// (`send_batch`). The same form sent again (a double click, a resend after a lost answer) is the
/// same change: Marketplace sends again only a listing whose outcome is unknown.
async fn bulk(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, place: &Place, form: ListingsForm) -> HtmlResult {
    let p: Pilot = req.t();
    let mut ids: Vec<String> = Vec::new();
    for id in form.listing_ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_owned());
        }
    }
    // Nothing checked on a page that names no change: nothing to send.
    if ids.is_empty() && place.listing_recovery.is_none() {
        let mut errors = Errors::new();
        errors.add_form(p.seller_listings_choose_listings());
        let after = After { errors, sent: form, ..After::default() };
        return render(req, viewer, config, headers, place, None, after, StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let caller = config.platform.caller(headers, config.proto, None);
    let change = Change {
        intent: &form.intent,
        attempt: form.attempt.as_ref().map(SubmitKey::as_str),
        listing_id: None,
        listing_ids: &ids,
        fields: Default::default(),
    };
    match listing_recovery::prepare(&caller, place.listing_recovery.as_deref(), change).await {
        Ok(Next::Send(reference)) => send_batch(req, viewer, config, headers, place, &reference).await,
        Ok(Next::Show(recovery)) => shown(req, viewer, config, headers, place, form, recovery).await,
        Err(_) => sign_in(req),
    }
}

/// Retry unknown Listings (marketplace's `retry-listing-batch`): the bulk change the address names,
/// sent again. A page naming no bulk change sends nothing.
async fn retry(req: &Req, viewer: &Viewer, config: &Shared, headers: &HeaderMap, place: &Place) -> HtmlResult {
    match listing_recovery::reference(place.listing_recovery.as_deref()) {
        Ok(Some(reference)) if reference.bulk => send_batch(req, viewer, config, headers, place, &reference).await,
        _ => shown(req, viewer, config, headers, place, ListingsForm::default(), ListingRecovery::ambiguous()).await,
    }
}

/// Sends a prepared bulk change (`retryListingBatch`): Marketplace checks each listing's history
/// and sends those whose outcome is unknown, then the list follows naming the change, which says
/// what came of each. One whose answer was lost is the same. A refused one (4xx) is the list naming
/// it, with the API's words.
async fn send_batch(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    reference: &ListingReference,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let error = match caller.retry_listing_batch(reference).await {
        Ok(receipt) => return req.redirect(&changed(place, reference, receipt.as_ref())),
        Err(error) => error,
    };
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        return sign_in(req);
    }
    if listing_recovery::interrupted(&error) {
        tracing::warn!("a bulk listing change's answer was lost: {error}");
        return req.redirect(&changed(place, reference, None));
    }
    let t: SellerListingsMsg = req.t();
    let message =
        error.code().and_then(|code| refusal(t, code)).or(error.refusal()).unwrap_or(t.route_bulk_action_request_failed());
    let mut errors = Errors::new();
    errors.add_form(message);
    let naming = Place { listing_recovery: Some(listing_recovery::param(reference)), ..place.clone() };
    let after = After { errors, ..After::default() };
    render(req, viewer, config, headers, &naming, None, after, StatusCode::UNPROCESSABLE_ENTITY).await
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
    fn a_picked_day_begins_where_its_form_was_drawn() {
        let form = |body: &[u8]| corten::form::from_bytes::<ListingsForm>(body).unwrap();
        let chicago = form(b"availableAgainOn=2026-11-02&zone=America%2FChicago");
        let day = chicago.available_again_on.value().unwrap();
        assert_eq!(start_of_day(day, chicago.zone.as_ref().unwrap()).as_deref(), Some("2026-11-02T06:00:00.000Z"));
        let utc = form(b"zone=UTC").zone.unwrap();
        assert_eq!(start_of_day(day, &utc).as_deref(), Some("2026-11-02T00:00:00.000Z"));
        for bad in ["2026-1-02", "11%2F02%2F2026", "2026-11-0x"] {
            let sent = form(format!("availableAgainOn={bad}&zone=UTC").as_bytes());
            assert!(sent.available_again_on.value().is_none() && !sent.available_again_on.is_blank(), "{bad}");
        }
    }
}
