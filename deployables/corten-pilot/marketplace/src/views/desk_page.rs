//! The Seller Desk home (marketplace's `SellerDeskHomePage`): the KPI band, the attention queue
//! ("Needs you") with its count, the sources the API could not read, each item's summary and the
//! link that fixes it, or the calm empty state; then the seller's surfaces.
//!
//! The queue's items carry a semantic code and its parameters; the page puts them in the Seller
//! Desk's own words (`resolveAttentionSummary`), looked up by key with the API's parameters.
//! No script: every row is a link. One column on a phone; the KPIs two across from 30rem and four
//! from 64rem, and a row's link beside its summary from 48rem.
use corten::prelude::*;
use serde_json::{Map, Value};

use crate::{
    api::{AttentionItem, AttentionQueue},
    app::url,
    desk::DeskScreen,
    text::DeskMsg,
};

type Params = Map<String, Value>;

/// No arguments, for a message that takes none, found by its key.
const NONE: [(&str, &str); 0] = [];

/// A badge's tone for a severity (`severityTone`).
fn tone(severity: &str) -> &'static str {
    match severity {
        "critical" => "danger",
        "warning" => "warning",
        _ => "info",
    }
}

fn severity(t: DeskMsg, severity: &str) -> &'static str {
    match severity {
        "critical" => t.severity_critical(),
        "warning" => t.severity_warning(),
        _ => t.severity_info(),
    }
}

/// The highest severity in the queue, which tones its count.
fn highest(queue: &AttentionQueue) -> &'static str {
    let by = queue.rollup.by_severity;
    if by.critical > 0 {
        "critical"
    } else if by.warning > 0 {
        "warning"
    } else {
        "info"
    }
}

/// A message the catalog has under `key`, with `args`; none when it has no such key or an
/// argument is missing.
fn found(t: DeskMsg, key: &str, args: &Params) -> Option<String> {
    t.by_key(key, args).map(|message| message.to_string())
}

/// A health reason's label (`channelHealthReasonLabel`).
fn channel_reason(t: DeskMsg, reason: Option<&Value>) -> String {
    match reason.and_then(Value::as_str) {
        Some("connector-liveness") => t.reason_connector_liveness().to_owned(),
        Some(
            reason @ ("credential"
            | "seller-setup"
            | "subscription"
            | "polling"
            | "drift"
            | "provider-rate"
            | "provider-availability"
            | "sale-follow-up"),
        ) => t.by_key(&format!("channel_reason.{reason}"), &NONE).map_or_else(String::new, |m| m.to_string()),
        _ => t.source_channel_action().to_owned(),
    }
}

/// A channel connection's open attention: its health, the listings that differ, a manual sync's
/// state and its orders, each when the item says (`channel-action-open`).
fn channel_open(t: DeskMsg, params: &Params) -> String {
    let number = |key: &str| params.get(key).is_some_and(Value::is_number);
    let one = |key: &str| params.get(key).and_then(Value::as_i64) == Some(1);
    let health = params.get("topReason").and_then(|reason| {
        let mut args = params.clone();
        args.insert("topReason".into(), Value::String(channel_reason(t, Some(reason))));
        found(t, "summary.channel_action_open", &args)
    });
    let drift = number("affectedListingCount")
        .then(|| {
            let key = if one("hasMore") { "summary.channel_drift_overflow" } else { "summary.channel_drift_count" };
            found(t, key, params)
        })
        .flatten();
    let manual = match params.get("manualReason").and_then(Value::as_str) {
        Some(reason @ ("ready" | "unknown" | "recovery")) => {
            found(t, &format!("manual.{reason}"), params).map(|m| format!("{m}."))
        }
        _ => None,
    };
    let orders = number("orderCount")
        .then(|| found(t, if one("orderOverflow") { "orders_overflow" } else { "orders_count" }, params))
        .flatten();
    [health, drift, manual, orders].into_iter().flatten().collect::<Vec<_>>().join(" ")
}

/// An item's summary in the Desk's words (`resolveAttentionSummary`): the message its code
/// names, with its parameters; the neutral fallback for a code the page does not know.
pub fn summary(t: DeskMsg, item: &AttentionItem) -> String {
    let (code, params) = (item.summary.code.as_str(), &item.summary.params);
    let key = match code {
        "channel-action-open" => return channel_open(t, params),
        "channel-ready" | "channel-unknown" | "channel-recovery" => format!("manual.{}", &code["channel-".len()..]),
        _ => format!("summary.{}", code.replace('-', "_")),
    };
    // Repricing counts can run into the thousands: grouped ("2,341"), as marketplace writes them.
    let grouped = matches!(
        code,
        "repricing-floor-binding" | "repricing-paused-for-missing-input" | "repricing-budget-exhausted" | "repricing-frozen"
    );
    let args = match params.get("count").and_then(Value::as_u64) {
        Some(count) if grouped => {
            let mut args = params.clone();
            args.insert("count".into(), Value::String(t.number(count).to_string()));
            std::borrow::Cow::Owned(args)
        }
        _ => std::borrow::Cow::Borrowed(params),
    };
    found(t, &key, &args).unwrap_or_else(|| t.summary_fallback().to_owned())
}

/// The link's words, a verb for the fix it leads to (`attentionActionLabel`).
pub fn action(t: DeskMsg, item: &AttentionItem) -> &'static str {
    match item.source.as_str() {
        "fulfillment-ship-by" => t.action_ship_by_link(),
        "settlement-blocked-payout" => t.action_payout_link(),
        "inventory-resolution" => t.action_resolution_link(),
        "channel-action" if item.summary.code != "channel-action-open" || item.summary.params.contains_key("manualReason") => {
            t.manual_action()
        }
        "channel-action" => t.action_channel_attention(),
        "offer-response" => t.action_offer_link(),
        "pricing-repricing" => t.action_repricing_link(),
        "dispute-response" => t.action_dispute_link(),
        _ => t.action_listing_link(),
    }
}

/// A source's name for the seller (`attentionSourceLabel`).
pub fn source(t: DeskMsg, id: &str) -> &str {
    match id {
        "fulfillment-ship-by" => t.source_fulfillment_ship_by(),
        "settlement-blocked-payout" => t.source_settlement_blocked_payout(),
        "inventory-resolution" => t.source_inventory_resolution(),
        "channel-action" => t.source_channel_action(),
        "offer-response" => t.source_offer_response(),
        "listing-action" => t.source_listing_action(),
        "pricing-repricing" => t.source_pricing_repricing(),
        "dispute-response" => t.source_dispute_response(),
        other => other,
    }
}

/// Where an item's link goes. The queue links a listing, a shipment and a sale to their own pages
/// (chase-sets/chase-sets#10676), which the pilot serves, as it serves the Desk; anything else is
/// marketplace's.
pub fn link(href: &str) -> String {
    let id = |prefix: &str| href.strip_prefix(prefix).filter(|id| !id.is_empty() && !id.contains(['/', '?', '#']));
    let ours = ["/account/listings/", "/account/sales/shipments/", "/account/sales/"].into_iter().any(|p| id(p).is_some());
    if ours || href == "/account/desk" || href.starts_with("/account/desk?") {
        return href.to_owned();
    }
    super::on_marketplace(href)
}

/// The page.
#[component(css)]
pub fn DeskPage<'a>(t: DeskMsg, screen: &'a DeskScreen) -> impl Render {
    let queue = &screen.queue;
    let kpis = &screen.kpis;
    let unavailable: Vec<_> = queue.sources.iter().filter(|s| s.status == "unavailable").collect();
    let count = |value: Option<u64>| value.map_or_else(|| t.kpis_unavailable().to_owned(), |n| t.number(n).to_string());
    let amount = |value: &Option<String>| value.clone().unwrap_or_else(|| t.kpis_unavailable().to_owned());
    let payouts = super::on_marketplace("/account/payouts");
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.eyebrow()}</p>
            <h1 class={Title}>{t.title()}</h1>
            <p class={Muted}>{t.description()}</p>
        </header>
        <section class={Section} aria-labelledby="desk-kpis-title">
            <h2 id="desk-kpis-title" class={PartTitle}>{t.kpis_title()}</h2>
            <dl class={Kpis}>
                <div class={Kpi}>
                    <dt>{t.kpis_active_listings()}</dt>
                    <dd>{count(kpis.active_listings)}</dd>
                </div>
                <div class={Kpi}>
                    <dt>{t.kpis_open_orders_to_ship()}</dt>
                    <dd>{count(kpis.open_orders_to_ship)}</dd>
                </div>
                <div class={Kpi}>
                    <dt>{t.kpis_next_payout()}</dt>
                    <dd>{amount(&kpis.next_payout_amount)}</dd>
                </div>
                <div class={Kpi}>
                    <dt>{t.kpis_wallet_balance()}</dt>
                    <dd>{amount(&kpis.wallet_balance_amount)}</dd>
                </div>
            </dl>
        </section>
        <section class={Section} aria-labelledby="desk-queue-title">
            <div class={Tight}>
                <h2 id="desk-queue-title" class={PartTitle}>{t.queue_title()}</h2>
                <p class={Muted}>{t.queue_description()}</p>
            </div>
            <p class={Row}>
                <span class={Badge} data-tone={if queue.rollup.total > 0 { tone(highest(queue)) } else { "success" }}>
                    {t.queue_count(queue.rollup.total)}
                </span>
            </p>
            if !unavailable.is_empty() {
                // The source's name only: the API's reason is internal (chase-sets/chase-sets#8766).
                <div class={Banner} role="status" data-seller-desk-degraded="true">
                    <p class={Strong}>{t.degraded_title()}</p>
                    <p>{t.degraded_description()}</p>
                    <ul class={Plain}>
                        for health in &unavailable {
                            <li>{t.degraded_source(source(t, &health.id), t.degraded_reason_unknown())}</li>
                        }
                    </ul>
                </div>
            }
            if queue.items.is_empty() {
                <div class={(Card, Empty)}>
                    <p class={Strong}>{t.empty_title()}</p>
                    <p class={Muted}>{t.empty_description()}</p>
                    <p class={Row}>
                        <a class={Button} href={url::NewListing}>{t.empty_create_listing()}</a>
                        <a class={(Button, Secondary)} href={url::Inventory::default()}>{t.empty_view_inventory()}</a>
                    </p>
                </div>
            } else {
                <ol class={Queue} data-seller-desk-queue="true">
                    for item in &queue.items {
                        <li class={(Card, Item)} data-seller-desk-item={&item.id} data-seller-desk-severity={&item.severity}>
                            <div class={Tight}>
                                <p><span class={Badge} data-tone={tone(&item.severity)}>{severity(t, &item.severity)}</span></p>
                                <p class={Strong}>{summary(t, item)}</p>
                            </div>
                            <a class={Button} href={link(&item.deep_link.href)}>{action(t, item)}</a>
                        </li>
                    }
                </ol>
            }
        </section>
        <section class={Section} aria-labelledby="desk-surfaces-title">
            <h2 id="desk-surfaces-title" class={PartTitle}>{t.surfaces_title()}</h2>
            <nav class={Row} aria-labelledby="desk-surfaces-title">
                <a class={(Button, Secondary)} href={url::SellerListings::default()}>{t.surfaces_listings()}</a>
                <a class={(Button, Secondary)} href={url::OfferMatches::default()}>{t.surfaces_offers()}</a>
                <a class={(Button, Secondary)} href={url::Sales::default()}>{t.surfaces_sales()}</a>
                <a class={(Button, Secondary)} href={url::SaleShipments}>{t.surfaces_shipments()}</a>
                <a class={(Button, Secondary)} href={&payouts}>{t.surfaces_payouts()}</a>
                <a class={(Button, Secondary)} href={url::Inventory::default()}>{t.surfaces_inventory()}</a>
            </nav>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_queue_links_the_pilots_pages_here_and_the_rest_to_marketplace() {
        assert_eq!(link("/account/listings/lst_1"), "/account/listings/lst_1");
        assert_eq!(link("/account/sales/shipments/shp%201"), "/account/sales/shipments/shp%201");
        assert_eq!(link("/account/sales/ord_1"), "/account/sales/ord_1");
        assert_eq!(
            link("/account/desk?drawer=resolution-drawer&entity=imp_1"),
            "/account/desk?drawer=resolution-drawer&entity=imp_1"
        );
        assert!(link("/account/channels/conn_1").ends_with("/account/channels/conn_1"));
        assert!(link("/account/channels/conn_1").starts_with("http"), "marketplace's");
        assert!(link("/account/listings/").starts_with("http"), "no id: marketplace's");
    }
}
