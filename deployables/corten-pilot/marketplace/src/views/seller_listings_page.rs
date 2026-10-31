//! The seller's list of listings (marketplace's `MarketplaceListingListPage` and
//! `TimeAwayCapacityCard`): the header with Create Listing and Advanced import, what a write was
//! refused for, the time away and order capacity card, the listings' counts, the seller's
//! reliability, the filters as a GET form with the applied ones as chips, a bulk write's outcomes,
//! the listings (each with a box for Pause selected and Withdraw selected), a page at a time as
//! links, and the fee lock report in a disclosure.
//!
//! Every action is a form and works without JavaScript; a picked day is read on the server where
//! the seller is (`seller_listings::seller_zone`). The page's script counts the checked listings. One
//! column on a phone; a listing's facts beside it from 64rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::listing_page::options;
use crate::{
    api::{FeeLockRow, ListingPage, ListingRow, SellerMetrics, StatusCounts},
    app::url,
    seller_listings::{Filters, ListingsForm, ListingsScreen, Outcome, Place, REASONS, STATUSES},
    text::{Pilot, SellerListingsMsg},
};

corten::script::script!(pub mod handlers = "seller_listings_page.js");

/// Turn listings off (or update the away settings).
#[derive(Id, Clone, Copy)]
pub struct DisableFormId;
/// Schedule an away window.
#[derive(Id, Clone, Copy)]
pub struct AwayFormId;
/// The order capacity.
#[derive(Id, Clone, Copy)]
pub struct CapacityFormId;
/// The bulk form around the listings.
#[derive(Id, Clone, Copy)]
pub struct BulkFormId;
/// The parts a change to the account's listings draws again.
#[derive(Id)]
pub struct ListingHealthId;
#[derive(Id)]
pub struct ListingRowsId;
#[derive(Id)]
pub struct FeeReportId;

/// An amount in its currency, or "Not set" (`formatMoney`).
fn money(t: SellerListingsMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    match (amount.and_then(platform::money::decimal), currency.and_then(|c| Currency::parse(c.trim()))) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => t.list_not_set().to_owned(),
    }
}

/// A time the API sent, in UTC as marketplace's `formatDateTime` writes it, or "Not set".
fn when(t: SellerListingsMsg, at: Option<&str>) -> String {
    match at {
        Some(at) => parse_timestamp(at)
            .map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string()),
        None => t.list_not_set().to_owned(),
    }
}

/// The fee, net and credit in one line (`renderFeeSummary`).
fn fee_summary(t: SellerListingsMsg, row: &ListingRow) -> String {
    if row.marketplace_sales_fee_unit_amount.is_none() && row.seller_net_unit_amount.is_none() {
        return t.list_fee_quote_unavailable().to_owned();
    }
    let currency = row.price_currency_code.as_deref();
    let bps = row.shipping_allowance_percentage_bps.unwrap_or_default();
    [
        t.list_marketplace_fee_summary(&money(t, row.marketplace_sales_fee_unit_amount.as_deref(), currency)).to_string(),
        t.list_net_summary(&money(t, row.seller_net_unit_amount.as_deref(), currency)).to_string(),
        t.list_buyer_shipping_credit_summary(&t.percent(Decimal::new(i128::from(bps), 4), 2).to_string()).to_string(),
    ]
    .join(". ")
}

/// Which terms priced the listing (`termsSource`).
fn terms_source(t: SellerListingsMsg, p: Pilot, row: &FeeLockRow) -> String {
    match (&row.terms_agreement_id, &row.terms_schedule_id) {
        (Some(_), _) => p.seller_listing_terms_seller().to_owned(),
        (None, Some(_)) => p.seller_listing_terms_standard().to_owned(),
        (None, None) => t.list_source_unavailable().to_owned(),
    }
}

fn status(p: Pilot, status: &str) -> &str {
    match status {
        "draft" => p.seller_listing_status_draft(),
        "active" => p.seller_listing_status_active(),
        "paused" => p.seller_listing_status_paused(),
        "withdrawn" => p.seller_listing_status_withdrawn(),
        other => other,
    }
}

fn tone(status: &str) -> &'static str {
    match status {
        "active" => "accent",
        "paused" => "warning",
        "withdrawn" => "danger",
        _ => "neutral",
    }
}

/// A status filter's words (`statusFilterLabel`).
fn filter_label(t: SellerListingsMsg, status: Option<&str>) -> &str {
    match status {
        Some("draft") => t.list_status_filter_draft(),
        Some("active") => t.list_status_filter_active(),
        Some("paused") => t.list_status_filter_paused(),
        Some("withdrawn") => t.list_status_filter_withdrawn(),
        _ => t.list_status_filter_all(),
    }
}

/// An away reason's words (`availabilityReasonLabel`).
fn reason_label(t: SellerListingsMsg, reason: Option<&str>) -> &str {
    match reason {
        Some("travel") => t.list_reason_travel(),
        Some("audit") => t.list_reason_audit(),
        Some("operations") => t.list_reason_operations(),
        Some("other") => t.list_reason_other(),
        _ => t.list_reason_not_set(),
    }
}

fn language(t: SellerListingsMsg, code: &str) -> &str {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en(),
        "ja" => t.language_ja(),
        _ => code.trim(),
    }
}

/// A rate from 0 to 1 as a percentage with at most one decimal (`formatBehavioralMetricRate`), or
/// "Not enough orders yet" while there is nothing to divide by.
fn rate(t: SellerListingsMsg, rate: Option<&str>) -> String {
    match rate.and_then(Decimal::parse) {
        Some(rate) => t.percent(rate, 1).to_string(),
        None => t.list_not_enough_orders_yet().to_owned(),
    }
}

/// The value a refused form was sent with, else the page's.
fn sent(screen: &ListingsScreen, intent: &str, field: impl Fn(&ListingsForm) -> &str, otherwise: &str) -> String {
    if screen.sent.intent == intent { field(&screen.sent).to_owned() } else { otherwise.to_owned() }
}

/// The page.
#[component(css)]
pub fn SellerListingsPage<'a>(t: SellerListingsMsg, p: Pilot, screen: &'a ListingsScreen) -> impl Render {
    let filters = &screen.filters;
    let live = url::SellerListingsLive { place: filters.here().place };
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.list_seller()}</p>
                <h1 class={Title}>{t.list_listings()}</h1>
                <p class={Muted}>{t.list_create_publish_and_manage_seller_listings()}</p>
            </div>
            <p class={Actions}>
                <a class={Button} href={url::NewListing}>{t.list_create_listing()}</a>
                <a class={(Button, Secondary)} href={url::Imports::default()}>{t.list_advanced_import()}</a>
            </p>
        </header>
        <div class={Notes} role="status" aria-live="polite">
            if let Some(message) = screen.errors.form() {
                <div class={Banner} data-tone="danger" tabindex="-1">
                    <p class={Strong}>{t.list_listings()}</p>
                    <p>{message}</p>
                </div>
            }
        </div>
        <section class={Section} aria-labelledby="time-away-title">
            <h2 id="time-away-title" class={PartTitle}>{t.list_time_away_and_order_capacity()}</h2>
            <div class={(Card, Tinted)}>
                <AvailabilityPart t={t} screen={screen} />
                <AwayWindowPart t={t} screen={screen} />
                <CapacityPart t={t} screen={screen} />
            </div>
        </section>
        <Health t={t} counts={&screen.page.status_counts} />
        if let Some(metrics) = &screen.metrics {
            <Reliability t={t} metrics={metrics} />
        } else {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.list_seller_reliability()}</p>
                <p>{t.degraded()}</p>
            </div>
        }
        <section class={Section} aria-labelledby="current-title">
            <h2 id="current-title" class={PartTitle}>{t.list_current_listings()}</h2>
            <FilterForm t={t} filters={filters} />
            if let Some(outcomes) = &screen.outcomes {
                <BulkResults t={t} outcomes={outcomes} />
            }
            <BulkForm t={t} p={p} screen={screen} />
        </section>
        <section class={Section} aria-labelledby="fee-report-title">
            <h2 id="fee-report-title" class={PartTitle}>{t.list_fee_lock_report()}</h2>
            <FeeReport t={t} p={p} fees={&screen.fees} />
        </section>
        // The counts, the rows and the report again on each change to the account's listings
        // (`seller_listings::live`).
        <corten-live src={&live.href()}></corten-live>
    }
}

/// The parts of the page `<corten-live>` draws again on a change to the account's listings.
pub fn seller_listings_live_parts<'a>(
    t: SellerListingsMsg,
    p: Pilot,
    page: &'a ListingPage,
    fees: &'a [FeeLockRow],
    filters: &'a Filters,
) -> impl Render + 'a {
    html! {
        <Health t={t} counts={&page.status_counts} />
        <Rows t={t} p={p} page={page} filters={filters} />
        <FeeReport t={t} p={p} fees={fees} />
    }
}

/// Whether listings are on, and the form that turns them off (or updates the away settings) or
/// on (`AvailabilitySection`).
#[component(css = SellerListingsPage)]
fn AvailabilityPart<'a>(t: SellerListingsMsg, screen: &'a ListingsScreen) -> impl Render {
    let a = &screen.availability;
    let available = a.available();
    let f = ListingsForm::FIELDS;
    let e = screen.errors.within(DisableFormId);
    let intent = "disable-listing-availability";
    let reason = sent(screen, intent, |s| &s.reason_category, a.disabled_reason_category.as_deref().unwrap_or_default());
    let on = sent(screen, intent, |s| &s.available_again_on, a.available_again_on.as_deref().unwrap_or_default());
    html! {
        <div class={Stack}>
            <p class={Badges}>
                <span class={Badge} data-tone={if available { "success" } else { "warning" }}>
                    if available {
                        {t.list_listings_available()}
                    } else {
                        {t.list_listings_unavailable()}
                    }
                </span>
                <span class={Strong}>{t.list_account_wide_listing_control()}</span>
            </p>
            <p class={Muted}>
                if available {
                    {t.list_availability_available_description()}
                } else {
                    {t.list_availability_unavailable_description(
                        reason_label(t, a.disabled_reason_category.as_deref()),
                        a.available_again_on.as_deref().unwrap_or(t.list_no_return_date()),
                    )}
                }
            </p>
            if !available && a.available_again_at.is_some() {
                <div class={Banner}>
                    <p class={Strong}>{t.list_scheduled_restore_title()}</p>
                    <p>{t.list_scheduled_restore_notice(&when(t, a.available_again_at.as_deref()))}</p>
                </div>
            }
            <div class={Grid}>
                if available {
                    <div class={Banner}>
                        <p class={Strong}>{t.list_impact_preview_title()}</p>
                        <p>{t.list_impact_preview_description(screen.page.status_counts.active)}</p>
                    </div>
                } else {
                    <form method="post" action={screen.filters.here()}>
                        <button class={Button} type="submit" name={f.intent} value="enable-listing-availability">
                            {t.list_turn_on_listings()}
                        </button>
                    </form>
                }
                <form
                    id={DisableFormId}
                    class={Form}
                    method="post"
                    action={screen.filters.here()}
                >
                    <div class={Grid}>
                        <label class={Field}>
                            <span class={Label}>{t.list_reason()}</span>
                            <ReasonSelect t={t} name={f.reason_category} chosen={&reason} />
                        </label>
                        <div class={Field}>
                            <label class={Label} for="available-again-on">{t.list_available_again_on()}</label>
                            <input
                                id="available-again-on"
                                type="date"
                                name={f.available_again_on}
                                value={&on}
                                {..e.aria(f.available_again_on)}
                            >
                            {e.message(f.available_again_on)}
                        </div>
                    </div>
                    {e.message(f.reason_category)}
                    <p class={Row}>
                        <button class={(Button, Secondary)} type="submit" name={f.intent} value={intent}>
                            if available {
                                {t.list_turn_off_listings()}
                            } else {
                                {t.list_update_away_settings()}
                            }
                        </button>
                    </p>
                </form>
            </div>
        </div>
    }
}

/// A reason select (`reasonItems`).
#[component(css = SellerListingsPage)]
fn ReasonSelect<'a>(t: SellerListingsMsg, name: FieldName, chosen: &'a str) -> impl Render {
    html! {
        <select name={name}>
            <option value="" selected={chosen.is_empty()}>{t.list_reason_not_set()}</option>
            for reason in REASONS {
                <option value={reason} selected={chosen == reason}>{reason_label(t, Some(reason))}</option>
            }
        </select>
    }
}

/// The scheduled away window and Cancel, or the form that schedules one (`AwayWindowSection`).
#[component(css = SellerListingsPage)]
fn AwayWindowPart<'a>(t: SellerListingsMsg, screen: &'a ListingsScreen) -> impl Render {
    let a = &screen.availability;
    let f = ListingsForm::FIELDS;
    let e = screen.errors.within(AwayFormId);
    let intent = "schedule-away-window";
    let reason = sent(screen, intent, |s| &s.away_window_reason_category, "");
    let starts = sent(screen, intent, |s| &s.away_window_starts_on, "");
    let ends = sent(screen, intent, |s| &s.away_window_ends_on, "");
    html! {
        <div class={Stack}>
            <h3 class={Strong}>{t.list_away_window()}</h3>
            if let Some(starts_at) = &a.away_window_starts_at {
                <p class={Muted}>
                    {t.list_away_window_scheduled_description(
                        reason_label(t, a.away_window_reason_category.as_deref()),
                        &when(t, Some(starts_at)),
                        &a.away_window_ends_at.as_deref().map_or_else(|| t.list_no_return_date().to_owned(), |at| when(t, Some(at))),
                    )}
                </p>
                <div class={Banner}>
                    <p class={Strong}>{t.list_scheduled_restore_title()}</p>
                    <p>
                        if let Some(ends_at) = &a.away_window_ends_at {
                            {t.list_scheduled_restore_notice_window(&when(t, Some(starts_at)), &when(t, Some(ends_at)))}
                        } else {
                            {t.list_scheduled_restore_notice_window_indefinite(&when(t, Some(starts_at)))}
                        }
                    </p>
                </div>
                <form method="post" action={screen.filters.here()}>
                    <button class={(Button, Secondary)} type="submit" name={f.intent} value="cancel-away-window">
                        {t.list_cancel_away_window()}
                    </button>
                </form>
            } else if a.available() {
                <form
                    id={AwayFormId}
                    class={Form}
                    method="post"
                    action={screen.filters.here()}
                >
                    <p class={Muted}>{t.list_away_window_description()}</p>
                    <div class={Grid3}>
                        <div class={Field}>
                            <label class={Label} for="away-reason">{t.list_reason()}</label>
                            <select
                                id="away-reason"
                                name={f.away_window_reason_category}
                                required
                                {..e.aria(f.away_window_reason_category)}
                            >
                                <option value="" selected={reason.is_empty()}>{t.list_reason_not_set()}</option>
                                for value in REASONS {
                                    <option value={value} selected={reason == *value}>{reason_label(t, Some(value))}</option>
                                }
                            </select>
                            {e.message(f.away_window_reason_category)}
                        </div>
                        <div class={Field}>
                            <label class={Label} for="away-starts">{t.list_away_window_starts_on()}</label>
                            <input
                                id="away-starts"
                                type="date"
                                name={f.away_window_starts_on}
                                value={&starts}
                                required
                                {..e.aria(f.away_window_starts_on)}
                            >
                            {e.message(f.away_window_starts_on)}
                        </div>
                        <div class={Field}>
                            <label class={Label} for="away-ends">{t.list_away_window_ends_on()}</label>
                            <input
                                id="away-ends"
                                type="date"
                                name={f.away_window_ends_on}
                                value={&ends}
                                {..e.aria(f.away_window_ends_on)}
                            >
                            {e.message(f.away_window_ends_on)}
                        </div>
                    </div>
                    <p class={Row}>
                        <button class={(Button, Secondary)} type="submit" name={f.intent} value={intent}>
                            {t.list_schedule_away_window()}
                        </button>
                    </p>
                </form>
            } else {
                <p class={Muted}>{t.list_away_window_unavailable_while_away()}</p>
            }
        </div>
    }
}

/// The order capacity, Ordering's count against it, and its form (`OrderCapacitySection`).
#[component(css = SellerListingsPage)]
fn CapacityPart<'a>(t: SellerListingsMsg, screen: &'a ListingsScreen) -> impl Render {
    let cap = screen.capacity.max_open_orders;
    let f = ListingsForm::FIELDS;
    let e = screen.errors.within(CapacityFormId);
    let current = cap.map(|c| c.to_string()).unwrap_or_default();
    let value = sent(screen, "set-order-capacity", |s| &s.max_open_orders, &current);
    let open = match (screen.open_orders, cap) {
        (None, _) => t.list_order_capacity_open_orders_unavailable().to_owned(),
        (Some(count), Some(cap)) => t.list_order_capacity_open_orders_now(count, cap).to_string(),
        (Some(count), None) => t.list_order_capacity_open_orders_now_unlimited(count).to_string(),
    };
    html! {
        <div class={Stack}>
            <h3 class={Strong}>{t.list_order_capacity()}</h3>
            <p class={Muted}>{t.list_order_capacity_description()}</p>
            <div class={Tight}>
                <p>
                    if let Some(cap) = cap {
                        {t.list_order_capacity_current(cap)}
                    } else {
                        {t.list_order_capacity_unlimited()}
                    }
                </p>
                <p class={Hint}>{&open}</p>
                <p class={Hint}>{t.list_order_capacity_sourced_from_ordering()}</p>
            </div>
            <form id={CapacityFormId} class={Form} method="post" action={screen.filters.here()}>
                <div class={Grid}>
                    <div class={Field}>
                        <label class={Label} for="max-open-orders">{t.list_order_capacity_max_open_orders()}</label>
                        <input
                            id="max-open-orders"
                            type="number"
                            inputmode="numeric"
                            min="1"
                            step="1"
                            name={f.max_open_orders}
                            value={&value}
                            {..e.aria(f.max_open_orders)}
                        >
                        {e.message(f.max_open_orders)}
                    </div>
                </div>
                <p class={Row}>
                    <button class={(Button, Secondary)} type="submit" name={f.intent} value="set-order-capacity">
                        {t.list_order_capacity_set()}
                    </button>
                    if cap.is_some() {
                        <button
                            class={(Button, Secondary)}
                            type="submit"
                            name={f.intent}
                            value="clear-order-capacity"
                            formnovalidate
                        >
                            {t.list_order_capacity_clear()}
                        </button>
                    }
                </p>
            </form>
        </div>
    }
}

/// The listings' counts by status (`Listing health`).
#[component(css = SellerListingsPage)]
fn Health<'a>(t: SellerListingsMsg, counts: &'a StatusCounts) -> impl Patch {
    html! {
        <section id={ListingHealthId} class={Panel} aria-labelledby="health-title">
            <div class={Tight}>
                <h2 id="health-title" class={PartTitle}>{t.list_listing_health()}</h2>
                <p class={Muted}>{t.list_track_active_supply_drafts_and_sellable()}</p>
            </div>
            <dl class={Metrics}>
                <div>
                    <dt>{t.list_active_listings()}</dt>
                    <dd class={Big}>{counts.active}</dd>
                    <dd class={Hint}>{t.list_visible_to_buyers()}</dd>
                </div>
                <div>
                    <dt>{t.list_draft_listings()}</dt>
                    <dd class={Big}>{counts.draft}</dd>
                    <dd class={Hint}>{t.list_not_visible_yet()}</dd>
                </div>
                <div>
                    <dt>{t.list_paused_listings()}</dt>
                    <dd class={Big}>{counts.paused}</dd>
                    // Marketplace shows its message unfilled here (chase-sets/chase-sets#10653).
                </div>
                <div>
                    <dt>{t.list_withdrawn_listings()}</dt>
                    <dd class={Big}>{counts.withdrawn}</dd>
                    <dd class={Hint}>{t.list_withdrawn_listings_detail()}</dd>
                </div>
            </dl>
        </section>
    }
}

/// The seller's own reliability (`SellerReliabilityPanel`).
#[component(css = SellerListingsPage)]
fn Reliability<'a>(t: SellerListingsMsg, metrics: &'a SellerMetrics) -> impl Render {
    html! {
        <section class={Panel} aria-labelledby="reliability-title">
            <div class={Tight}>
                <h2 id="reliability-title" class={PartTitle}>{t.list_seller_reliability()}</h2>
                <p class={Muted}>{t.list_seller_reliability_description(metrics.window_days)}</p>
            </div>
            <dl class={Metrics}>
                <div>
                    <dt>{t.list_on_time_shipment_rate()}</dt>
                    <dd class={Big}>{rate(t, metrics.on_time_shipment_rate.as_deref())}</dd>
                    <dd class={Hint}>{t.list_on_time_shipment_rate_detail(metrics.shipments_dispatched_count)}</dd>
                </div>
                <div>
                    <dt>{t.list_cancellation_rate()}</dt>
                    <dd class={Big}>{rate(t, metrics.cancellation_rate.as_deref())}</dd>
                    <dd class={Hint}>{t.list_cancellation_rate_detail(metrics.orders_created_count)}</dd>
                </div>
                <div>
                    <dt>{t.list_dispute_rate()}</dt>
                    <dd class={Big}>{rate(t, metrics.dispute_rate.as_deref())}</dd>
                    <dd class={Hint}>{t.list_dispute_rate_detail(metrics.orders_created_count)}</dd>
                </div>
            </dl>
        </section>
    }
}

/// The filters (a GET form) and the applied ones as chips, each a link without it.
#[component(css = SellerListingsPage)]
fn FilterForm<'a>(t: SellerListingsMsg, filters: &'a Filters) -> impl Render {
    let f = Place::FIELDS;
    let all = url::SellerListings { place: Place::default() };
    let applied = filters.status.is_some() || !filters.search.is_empty();
    html! {
        <form class={(Form, SearchForm)} method="get" action={all.clone()} role="search" aria-label={t.list_filters()}>
            <div class={Grid}>
                <label class={Field}>
                    <span class={Label}>{t.list_search_by_title()}</span>
                    <input
                        type="search"
                        name={f.search}
                        value={&filters.search}
                        placeholder={t.list_search_by_title_placeholder()}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.list_status()}</span>
                    <select name={f.status}>
                        <option value="all" selected={filters.status.is_none()}>{t.list_status_filter_all()}</option>
                        for status in STATUSES {
                            <option value={status} selected={filters.status == Some(status)}>
                                {filter_label(t, Some(status))}
                            </option>
                        }
                    </select>
                </label>
            </div>
            <p class={Row}>
                <button class={Button} type="submit">{t.list_apply_filters()}</button>
                <a class={(Button, Secondary)} href={all}>{t.list_clear_filters()}</a>
            </p>
        </form>
        if applied {
            <p class={Chips}>
                if !filters.search.is_empty() {
                    <a class={Chip} href={filters.without_search()}>{t.list_search_filter_chip(&filters.search)}</a>
                }
                if filters.status.is_some() {
                    <a class={Chip} href={filters.without_status()}>
                        {t.list_status_filter_chip(filter_label(t, filters.status))}
                    </a>
                }
            </p>
        }
    }
}

/// What a bulk Pause or Withdraw did to each listing.
#[component(css = SellerListingsPage)]
fn BulkResults<'a>(t: SellerListingsMsg, outcomes: &'a [Outcome]) -> impl Render {
    let succeeded = outcomes.iter().filter(|o| o.ok).count();
    let failed = outcomes.len() - succeeded;
    html! {
        <div class={(Card, Tinted)} role="status" tabindex="-1">
            <p class={Strong}>{t.list_bulk_action_results(succeeded, failed)}</p>
            <ul class={Outcomes}>
                for outcome in outcomes {
                    <li>
                        <span class={Badge} data-tone={if outcome.ok { "success" } else { "danger" }}>
                            if outcome.ok {
                                {t.list_bulk_action_succeeded()}
                            } else {
                                {t.list_bulk_action_failed()}
                            }
                        </span>
                        <span>{t.route_bulk_action_listing_label(&outcome.listing_id)}</span>
                        if let Some(message) = &outcome.message {
                            <span class={Hint}>{message}</span>
                        }
                    </li>
                }
            </ul>
        </div>
    }
}

/// The listings in the bulk form, and its bar: how many are checked (with the script), Pause
/// selected, Withdraw selected and Clear selection (the form's reset).
#[component(css = SellerListingsPage)]
fn BulkForm<'a>(t: SellerListingsMsg, p: Pilot, screen: &'a ListingsScreen) -> impl Render {
    let f = ListingsForm::FIELDS;
    let (form, count) = refs();
    html! {
        <form
            ref={form}
            id={BulkFormId}
            class={Bulk}
            method="post"
            action={screen.filters.here()}
            on:change={handlers::picked(form, count, t.js().list_bulk_selected())}
            on:reset={handlers::cleared(form, count, t.js().list_bulk_selected())}
            on:connect={handlers::picked(form, count, t.js().list_bulk_selected())}
        >
            <Rows t={t} p={p} page={&screen.page} filters={&screen.filters} />
            <div class={Bar}>
                <output ref={count} class={Strong}></output>
                <p class={Row}>
                    <button class={Button} type="submit" name={f.intent} value="bulk-pause-listings">
                        {t.list_pause_selected()}
                    </button>
                    <button class={(Button, Secondary)} type="submit" name={f.intent} value="bulk-withdraw-listings">
                        {t.list_withdraw_selected()}
                    </button>
                    <button class={(Button, Secondary)} type="reset">{t.list_clear_selection()}</button>
                </p>
            </div>
        </form>
    }
}

/// The page of listings, or that there are none, and the links to the others.
#[component(css = SellerListingsPage)]
fn Rows<'a>(t: SellerListingsMsg, p: Pilot, page: &'a ListingPage, filters: &'a Filters) -> impl Patch {
    let f = ListingsForm::FIELDS;
    let limit = filters.limit.max(1);
    let pages = page.total.div_ceil(limit).max(1);
    let current = filters.offset / limit + 1;
    let paged = page.total > limit || filters.offset > 0;
    let next = filters.offset + limit;
    html! {
        <div id={ListingRowsId} class={Stack}>
            if page.items.is_empty() {
                <div class={Card}>
                    <p class={Strong}>{t.list_no_listings_yet()}</p>
                    <p class={Muted}>{t.list_create_a_listing_from_available_inventory()}</p>
                </div>
            } else {
                <ul class={Listings}>
                    for row in &page.items {
                        <li class={Listing}>
                            <label class={Pick}>
                                <input
                                    type="checkbox"
                                    name={f.listing_ids}
                                    value={&row.listing_id}
                                    aria-label={p.seller_listings_select(row.item_title.as_deref().unwrap_or(&row.catalog_catalog_item_id)).to_string()}
                                >
                            </label>
                            <ListingFacts t={t} p={p} row={row} />
                        </li>
                    }
                </ul>
            }
            if paged {
                <nav class={Pages} aria-label={p.seller_listings_pages()}>
                    if filters.offset > 0 {
                        <a class={(Button, Secondary)} href={filters.at(filters.offset.saturating_sub(limit))} rel="prev">
                            {p.seller_listings_previous()}
                        </a>
                    }
                    <span>{p.seller_listings_page_of(current, pages)}</span>
                    if next < page.total {
                        <a class={(Button, Secondary)} href={filters.at(next)} rel="next">{p.seller_listings_next()}</a>
                    }
                </nav>
            }
        </div>
    }
}

/// A listing's title, badges and facts, and Open.
#[component(css = SellerListingsPage)]
fn ListingFacts<'a>(t: SellerListingsMsg, p: Pilot, row: &'a ListingRow) -> impl Render {
    let title = row.item_title.as_deref().unwrap_or(&row.catalog_catalog_item_id);
    let open = url::SellerListing { id: &row.listing_id, place: crate::seller_listing::Place::default() };
    let photos = row.evidence.iter().filter(|p| p.status == "active").count();
    html! {
        <div class={Main}>
            <p class={Strong}>{title}</p>
            <p class={Badges}>
                <span class={Badge} data-tone={tone(&row.status)}>{status(p, &row.status)}</span>
                if let Some(code) = &row.item_language_code {
                    <span class={Badge}>{language(t, code)}</span>
                }
                if row.product_measure_snapshot.is_none() {
                    <span class={Badge} data-tone="warning">{t.list_shipping_measure_missing()}</span>
                }
            </p>
            if let Some(subtitle) = &row.item_subtitle {
                <p class={Hint}>{subtitle}</p>
            }
            if row.product_summary.is_some() {
                <p class={Tags}>
                    for option in options(row.product_summary.as_deref()) {
                        <span class={Tag}>{option}</span>
                    }
                </p>
            }
            if photos > 0 {
                <p class={Hint}>{t.list_photo_count(photos)}</p>
            }
        </div>
        <dl class={Lines}>
            <div>
                <dt>{t.list_price_2()}</dt>
                <dd>
                    <span class={Strong}>
                        if row.price_currency_code.is_some() {
                            {money(t, Some(&row.price_amount), row.price_currency_code.as_deref())}
                        } else {
                            {t.list_price_incomplete()}
                        }
                    </span>
                    <span class={Hint}>{fee_summary(t, row)}</span>
                </dd>
            </div>
            <div>
                <dt>{t.list_cap()}</dt>
                <dd>{row.quantity_cap}</dd>
            </div>
            <div>
                <dt>{t.list_inventory()}</dt>
                <dd>
                    <span>{row.storage_location_name.as_deref().unwrap_or(t.list_location_unavailable())}</span>
                    if row.terms_resolved_at.is_some() {
                        <span class={Hint}>{t.list_terms_resolved()} {when(t, row.terms_resolved_at.as_deref())}</span>
                    }
                </dd>
            </div>
        </dl>
        <a class={(Button, Secondary, Open)} href={open}>{t.list_open()}</a>
    }
}

/// The fee lock report, folded (`ProgressiveDisclosure`).
#[component(css = SellerListingsPage)]
fn FeeReport<'a>(t: SellerListingsMsg, p: Pilot, fees: &'a [FeeLockRow]) -> impl Patch {
    html! {
        <details id={FeeReportId} class={Disclosure} data-tone={if fees.is_empty() { "neutral" } else { "info" }}>
            <summary>
                <span class={Strong}>{t.list_fee_lock_report()}</span>
                <span class={Hint}>{t.list_fee_lock_records_summary(fees.len())}</span>
            </summary>
            if fees.is_empty() {
                <p class={Strong}>{t.list_no_fee_locks()}</p>
                <p class={Muted}>{t.list_fee_lock_report_empty()}</p>
            } else {
                <ul class={Listings}>
                    for row in fees {
                        <li class={Card}>
                            <p class={Strong}>{row.item_title.as_deref().unwrap_or(&row.inventory_item_id)}</p>
                            if row.product_summary.is_some() {
                                <p class={Tags}>
                                    for option in options(row.product_summary.as_deref()) {
                                        <span class={Tag}>{option}</span>
                                    }
                                </p>
                            }
                            <dl class={Lines}>
                                <div>
                                    <dt>{t.list_locked_fee()}</dt>
                                    <dd>
                                        <span>
                                            {money(t, row.marketplace_sales_fee_unit_amount.as_deref(), row.price_currency_code.as_deref())}
                                        </span>
                                        <span class={Hint}>
                                            {t.list_seller_net_report(&money(t, row.seller_net_unit_amount.as_deref(), row.price_currency_code.as_deref()))}
                                        </span>
                                    </dd>
                                </div>
                                <div>
                                    <dt>{t.list_terms_source()}</dt>
                                    <dd>
                                        <span>{terms_source(t, p, row)}</span>
                                        <span class={Hint}>{when(t, row.terms_resolved_at.as_deref())}</span>
                                    </dd>
                                </div>
                                <div>
                                    <dt>{t.list_status()}</dt>
                                    <dd><span class={Badge} data-tone={tone(&row.status)}>{status(p, &row.status)}</span></dd>
                                </div>
                                <div>
                                    <dt>{t.list_cap()}</dt>
                                    <dd>{row.quantity_cap}</dd>
                                </div>
                                <div>
                                    <dt>{t.list_updated()}</dt>
                                    <dd>{when(t, row.updated_at.as_deref())}</dd>
                                </div>
                            </dl>
                        </li>
                    }
                </ul>
            }
        </details>
    }
}
