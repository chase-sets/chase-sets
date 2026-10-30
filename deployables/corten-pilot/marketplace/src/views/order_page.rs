//! The account's orders, after Ordering's `order-list-page.tsx`, `order-detail-page.tsx`,
//! `order-money-timeline.tsx` and `order-review-opportunity-callout.tsx`.
//!
//! The list: the heading, the counts (orders, items, pending), each order as a card (its items, kind,
//! date and reference, status, quantity, total and, on a sale, the seller's payout) with Open order,
//! and the pages as links. One column, two from 80rem.
//!
//! An order: the heading and Back, the order's facts and what can be done (Pay now, support, View
//! fulfillment, Cancel), where it ships, its outcome (status, issue and review), its money
//! timeline, its lines and, on a sale, the stock held for it; beside it on a wide screen and after
//! it on a narrow one, the side's money and the protection it has. Every action is a link or a
//! form; a sale's Cancel asks first in a dialog the button opens (`command`), without a script.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{account_page::page_range, listing_page::options, marketplace};
use crate::{
    api::{MoneyTimeline, OrderCard, OrderDetail, OrderLine, ReviewOpportunity, ReviewOutcome, Side},
    orders::{ListScreen, OrderScreen, cancel_href, list_href},
    text::{OrdersMsg, Pilot},
};

/// An amount the API sent, in the request's locale (`formatMoney`), or as sent when it is not money.
fn money(t: OrdersMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

fn usd(t: OrdersMsg, amount: &str) -> String {
    money(t, amount, "USD")
}

/// A time the API sent (ISO 8601, or Postgres's `2026-03-22 12:00:00+00`, which
/// `delivery_summary` sends, chase-sets/chase-sets#10634), as `formatDateTime` writes it; as sent
/// when it is neither.
fn date_time(t: OrdersMsg, at: &str) -> String {
    timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

fn date(t: OrdersMsg, at: &str) -> String {
    timestamp(at).map_or_else(|| at.to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
}

fn timestamp(at: &str) -> Option<std::time::SystemTime> {
    parse_timestamp(at).or_else(|| {
        let (day, time) = at.trim().split_once(' ')?;
        let time = match time.rsplit_once(['+', '-']) {
            Some((clock, zone)) if zone.len() == 2 => format!("{clock}{}{zone}:00", &time[clock.len()..=clock.len()]),
            _ => time.to_owned(),
        };
        parse_timestamp(&format!("{day}T{time}"))
    })
}

/// A status's badge tone (`statusTone`). The badge shows the status's code, as marketplace's does
/// (chase-sets/chase-sets#10633).
fn tone(status: &str) -> &'static str {
    match status {
        "cancelled" => "danger",
        "ready-for-fulfillment" => "success",
        _ => "accent",
    }
}

/// How the order was made (`formatSourceType`): marketplace's words for the three it knows,
/// else the code's words capitalized.
fn source(p: Pilot, source: &str) -> String {
    match source {
        "buy-now" => p.orders_source_buy_now().to_owned(),
        "cart" => p.orders_source_cart().to_owned(),
        "offer-acceptance" => p.orders_source_offer_acceptance().to_owned(),
        _ => capitalized(source.split('-')),
    }
}

fn capitalized<'a>(words: impl Iterator<Item = &'a str>) -> String {
    words
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The outcome panel's status (`orderStatusLabel`): "ready-for-fulfillment" is "Ready for fulfillment".
fn status_label(status: &str) -> String {
    let words = status.split('-').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let mut chars = words.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A support request's reference (`deriveDisplayReferenceOrRaw`): `sup_<ULID>` is `SUP-` and the
/// ULID's last 8, anything else as it is.
pub fn display_reference(id: &str) -> String {
    const PREFIXES: [(&str, &str); 5] = [("ord", "ORD"), ("shp", "SHP"), ("pyo", "PYO"), ("sup", "SUP"), ("wad", "WAD")];
    let mut parts = id.split('_');
    let (Some(prefix), Some(ulid), None) = (parts.next(), parts.next(), parts.next()) else { return id.to_owned() };
    let crockford =
        |c: char| c.is_ascii_digit() || (c.is_ascii_alphabetic() && !matches!(c.to_ascii_uppercase(), 'I' | 'L' | 'O' | 'U'));
    match PREFIXES.iter().find(|(p, _)| *p == prefix) {
        Some((_, shown)) if ulid.len() == 26 && ulid.chars().all(crockford) => {
            format!("{shown}-{}", ulid[ulid.len() - 8..].to_ascii_uppercase())
        }
        _ => id.to_owned(),
    }
}

/// The card's headline (`orderCardHeadline`): the first item, and how many more.
fn headline(t: OrdersMsg, titles: &[String]) -> String {
    match titles {
        [] => t.list_untitled_order().to_owned(),
        [only] => only.clone(),
        [first, rest @ ..] => format!("{first} {}", t.list_more_items(rest.len())),
    }
}

/// The list (`OrderingOrderListPage`).
#[component(css = OrderPage)]
pub fn OrderList<'a>(t: OrdersMsg, p: Pilot, screen: &'a ListScreen) -> impl Render {
    let side = screen.side;
    let (title, eyebrow, empty_title, empty_description) = match side {
        Side::Buyer => (
            t.purchases_purchases(),
            t.purchases_buyer(),
            t.purchases_no_purchases_yet(),
            t.purchases_your_checkout_activity_and_accepted_offers(),
        ),
        Side::Seller => {
            (t.sales_sales(), t.sales_seller(), t.sales_no_sales_yet(), t.sales_accepted_offers_and_checkout_activity_create())
        }
    };
    let description = t.list_review_pending_commercial_commitments_created_by();
    let orders = &screen.orders;
    let metrics = [
        (orders.total, title),
        (orders.summary.total_quantity, t.list_items()),
        (orders.summary.pending_count, t.list_pending()),
    ];
    let home = crate::app::url::Home::default().href();
    html! {
        <div class={Page}>
            <platform::section::PageHeader eyebrow={eyebrow} title={title} description={description} />
            <section class={(Card, Tinted)} aria-labelledby="order-counts">
                <h2 id="order-counts" class={CardTitle}>{title}</h2>
                <p class={Muted}>{description}</p>
                <dl class={Metrics}>
                    for (value, label) in &metrics {
                        <div class={Metric}>
                            <dt class={MetricLabel}>{*label}</dt>
                            <dd class={MetricValue}>{*value}</dd>
                        </div>
                    }
                </dl>
            </section>
            <section class={Part} aria-labelledby="order-list">
                <h2 id="order-list" class={SectionTitle}>{title}</h2>
                if orders.items.is_empty() {
                    <div class={Empty}>
                        <h3 class={EmptyTitle}>{empty_title}</h3>
                        <p class={Muted}>{empty_description}</p>
                        <div class={Cue}>
                            <p class={Strong}>{t.list_empty_orders_protection_title()}</p>
                            <p class={Muted}>{t.list_empty_orders_protection_description()}</p>
                        </div>
                        <p><a class={Secondary} href={&home}>{t.list_browse_marketplace()}</a></p>
                    </div>
                } else {
                    <ul class={Cards}>
                        for order in &orders.items {
                            <li><OrderCardView t={t} side={side} order={order} /></li>
                        }
                    </ul>
                }
                if screen.paged() {
                    <Pager p={p} screen={screen} />
                }
            </section>
        </div>
    }
}

/// An order in the list: its items, kind, date and reference, status, numbers and Open order.
#[component(css = OrderPage)]
fn OrderCardView<'a>(t: OrdersMsg, side: Side, order: &'a OrderCard) -> impl Render {
    let kind = match side {
        Side::Buyer => t.list_kind_purchase(),
        Side::Seller => t.list_kind_sale(),
    };
    let caption = [kind.to_owned(), date(t, &order.created_at), order.display_reference.clone()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" \u{b7} ");
    let href = crate::orders::order_href(side, &order.order_id, None);
    html! {
        <article class={Card}>
            <div class={CardHead}>
                <span class={Tile} aria-hidden="true">"\u{1f0cf}"</span>
                <div class={Stack}>
                    <h3 class={Strong}>{&headline(t, &order.item_titles)}</h3>
                    <p class={Muted}>{&caption}</p>
                    <span class={Badge} data-tone={tone(&order.status)}>{&order.status}</span>
                </div>
            </div>
            <dl class={if side == Side::Seller { (Facts, Three) } else { (Facts, Two) }}>
                <div>
                    <dt class={Muted}>{t.list_quantity()}</dt>
                    <dd class={Strong}>{order.total_quantity}</dd>
                </div>
                <div>
                    <dt class={Muted}>{t.list_total()}</dt>
                    <dd class={Strong}>{&usd(t, &order.total_amount)}</dd>
                </div>
                if side == Side::Seller {
                    <div>
                        <dt class={Muted}>{t.list_seller_payout()}</dt>
                        <dd>{&usd(t, &order.seller_payout_amount)}</dd>
                    </div>
                }
            </dl>
            <a class={(Secondary, Wide)} href={&href}>{t.list_open_order()}</a>
        </article>
    }
}

/// The list's pages (`Pagination`), as links: Previous, the numbers, Next.
#[component(css = OrderPage)]
fn Pager<'a>(p: Pilot, screen: &'a ListScreen) -> impl Render {
    let (page, pages) = screen.page();
    html! {
        <nav class={Pages} aria-label={p.account_pagination()}>
            if page > 1 {
                <a class={Secondary} href={&screen.page_href(page - 1)}>{p.account_previous_page()}</a>
            }
            <ul class={Inline}>
                for number in &page_range(page, pages) {
                    <li>
                        match number {
                            Some(n) => {
                                <a
                                    class={if *n == page { Primary } else { Secondary }}
                                    href={&screen.page_href(*n)}
                                    aria-current={(*n == page).then_some("page")}
                                    aria-label={&p.account_page_number(*n).to_string()}
                                >
                                    {*n}
                                </a>
                            }
                            None => { <span class={Muted} aria-hidden="true">"\u{2026}"</span> }
                        }
                    </li>
                }
            </ul>
            if page < pages {
                <a class={Secondary} href={&screen.page_href(page + 1)}>{p.account_next_page()}</a>
            }
        </nav>
    }
}

/// What the order's page knows of it, as `OrderingOrderDetailPage` works it out.
struct Known<'a> {
    side: Side,
    order: &'a OrderDetail,
    /// "Purchase" or "Sale".
    label: &'a str,
    fully_delivered: bool,
    can_cancel: bool,
}

impl<'a> Known<'a> {
    fn of(t: OrdersMsg, side: Side, order: &'a OrderDetail) -> Self {
        let delivery = order.delivery_summary.as_ref().filter(|_| side == Side::Buyer);
        let fully_delivered = delivery.is_some_and(|d| d.shipment_count > 0 && d.delivered_count == d.shipment_count);
        let pending = matches!(order.status.as_str(), "pending-payment" | "pending-reservation");
        let label = match side {
            Side::Buyer => t.detail_purchase(),
            Side::Seller => t.detail_sale(),
        };
        Known {
            side,
            order,
            label,
            fully_delivered,
            can_cancel: !fully_delivered && (order.self_service_cancellation_available || pending),
        }
    }

    fn lower(&self) -> String {
        self.label.to_lowercase()
    }

    fn counterparty(&self) -> &'a str {
        let o = self.order;
        match self.side {
            Side::Buyer => o.seller_display_name.as_deref().unwrap_or(&o.seller_account_id),
            Side::Seller => o.buyer_display_name.as_deref().unwrap_or(&o.buyer_account_id),
        }
    }

    fn fulfillment_started(&self) -> bool {
        self.order.cancellation_unavailable_reason.as_deref() == Some("fulfillment-started")
    }

    /// The pilot's support page for the order (Report a problem), with the flow the page offers.
    fn support_href(&self) -> String {
        let flow = match self.side {
            Side::Buyer if self.fulfillment_started() => Some("buyer-cancel-request"),
            Side::Buyer => None,
            Side::Seller => Some("seller-cannot-fulfill"),
        };
        support_for(&self.order.order_id, flow)
    }

    fn payment_deadline(&self) -> Option<&'a str> {
        (self.order.status == "pending-payment").then_some(self.order.payment_deadline_at.as_deref()).flatten()
    }

    fn money(&self) -> MoneyTimeline {
        self.order.money_timeline.clone().unwrap_or_else(|| MoneyTimeline {
            refunded_amount: "0.00".into(),
            currency_code: "USD".into(),
            ..MoneyTimeline::default()
        })
    }
}

/// The pilot's support page with Report a problem for `order`.
fn support_for(order: &str, flow: Option<&str>) -> String {
    let ask = crate::support_list::Ask { order_id: Some(order.to_owned()), flow: flow.map(str::to_owned), ..Default::default() };
    crate::app::url::SupportList { ask }.href()
}

fn market_href(path: &str) -> String {
    marketplace(path).map(|u| u.to_string()).unwrap_or_default()
}

fn cents(amount: &str) -> i64 {
    platform::money::cents(amount).unwrap_or(0)
}

/// Whether the money timeline has anything to say (`hasMoneyTimeline`).
fn has_timeline(money: &MoneyTimeline) -> bool {
    !money.refunds.is_empty() || money.support_cases.iter().any(|c| c.active_hold) || cents(&money.refunded_amount) > 0
}

/// A sale's Cancel dialog, which its button opens.
#[derive(Id)]
pub struct CancelDialogId;

/// An order's page (`OrderingOrderDetailPage`), or, while a read after a write has not caught
/// up, what marketplace's pending page says.
#[component(css)]
pub fn OrderPage<'a>(t: OrdersMsg, p: Pilot, screen: &'a OrderScreen) -> impl Render {
    let back = list_href(screen.side, crate::orders::Paging::default());
    let pending = match screen.side {
        Side::Buyer => p.orders_purchase_pending(),
        Side::Seller => p.orders_sale_pending(),
    };
    html! {
        if let Some(order) = &screen.order {
            <OrderView
                t={t}
                p={p}
                side={screen.side}
                order={order}
                notice={screen.notice.as_deref()}
                back={&back}
                may_cancel={screen.may_cancel}
            />
        } else {
            <div class={Page}>
                <p class={(Banner, Info)} role="status">{pending}</p>
                <p><a class={Secondary} href={&back}>{t.detail_back()}</a></p>
            </div>
        }
    }
}

/// The order's page.
#[component(css = OrderPage)]
fn OrderView<'a>(
    t: OrdersMsg,
    p: Pilot,
    side: Side,
    order: &'a OrderDetail,
    notice: Option<&'a str>,
    back: &'a str,
    may_cancel: bool,
) -> impl Render {
    let mut facts = Known::of(t, side, order);
    facts.can_cancel &= may_cancel;
    let eyebrow = match side {
        Side::Buyer => t.detail_buyer(),
        Side::Seller => t.detail_seller(),
    };
    let title = t.detail_order_title(facts.label, &order.display_reference).to_string();
    let counterparty = t.detail_counterparty_description(facts.counterparty()).to_string();
    let money = facts.money();
    let outcome_title = match side {
        Side::Buyer => t.purchase_order_outcome(),
        Side::Seller => t.sale_order_outcome(),
    };
    html! {
        <div class={Page}>
            <header class={Heading}>
                <div class={Stack}>
                    <p class={Eyebrow}>{eyebrow}</p>
                    <h1 class={Title}>{&title}</h1>
                    <p class={Muted}>{&counterparty}</p>
                </div>
                <a class={Secondary} href={back}>{t.detail_back()}</a>
            </header>
            if let Some(message) = notice {
                <div class={(Banner, Danger)} role="alert">
                    <p class={Strong}>{&t.detail_projection_issue(facts.label).to_string()}</p>
                    <p>{message}</p>
                </div>
            }
            <div class={Layout}>
                <div class={Main}>
                    <OrderFacts t={t} p={p} facts={&facts} />
                    <address class={Address} aria-label={t.detail_shipping_destination()}>
                        <span class={Strong}>{t.detail_shipping_destination()}</span>
                        for line in &destination(order) {
                            <span>{line}</span>
                        }
                    </address>
                    <section class={Part} aria-labelledby="order-outcome">
                        <h2 id="order-outcome" class={SectionTitle}>{outcome_title}</h2>
                        <Outcome t={t} facts={&facts} />
                    </section>
                    if has_timeline(&money) {
                        <section class={Part} aria-labelledby="money-timeline">
                            <h2 id="money-timeline" class={SectionTitle}>{t.money_title()}</h2>
                            <Timeline t={t} facts={&facts} timeline={&money} />
                        </section>
                    }
                    <section class={Part} aria-labelledby="order-lines">
                        <h2 id="order-lines" class={SectionTitle}>{t.detail_lines()}</h2>
                        <ul class={List}>
                            for line in &order.lines {
                                <li><Line t={t} p={p} side={side} line={line} /></li>
                            }
                        </ul>
                    </section>
                    if side == Side::Seller {
                        <section class={Part} aria-labelledby="order-holds">
                            <h2 id="order-holds" class={SectionTitle}>{t.detail_inventory_holds()}</h2>
                            <ul class={List}>
                                for hold in &order.inventory_holds {
                                    <li class={(Card, Tinted)}>
                                        <dl class={(Facts, Three)}>
                                            <div>
                                                <dt class={Strong}>{t.detail_reserved_item()}</dt>
                                                <dd class={Muted}>{t.detail_inventory_is_reserved()}</dd>
                                            </div>
                                            <div>
                                                <dt class={Muted}>{t.detail_quantity_2()}</dt>
                                                <dd>{hold.quantity}</dd>
                                            </div>
                                            <div>
                                                <dt class={Muted}>{t.detail_status_2()}</dt>
                                                <dd><span class={Badge} data-tone="accent">{&hold.status}</span></dd>
                                            </div>
                                        </dl>
                                    </li>
                                }
                            </ul>
                        </section>
                    }
                </div>
                <aside class={Aside} aria-label={p.orders_summary()}>
                    <Summary t={t} facts={&facts} />
                    <Protection t={t} p={p} facts={&facts} />
                </aside>
            </div>
        </div>
    }
}

/// The shipping address's lines (`destinationLines`).
fn destination(order: &OrderDetail) -> Vec<String> {
    let a = &order.shipping_destination_snapshot;
    let city = format!(
        "{}, {} {}",
        a.city.as_deref().unwrap_or(""),
        a.state.as_deref().unwrap_or(""),
        a.postal_code.as_deref().unwrap_or("")
    );
    [a.name.clone(), a.company.clone(), a.line1.clone(), a.line2.clone(), Some(city), a.country.clone()]
        .into_iter()
        .flatten()
        .filter(|l| !l.is_empty())
        .collect()
}

/// The order's facts (source, support reference, counterparty, when its terms resolved), the
/// payment deadline and cancellation window, and what can be done.
#[component(css = OrderPage)]
fn OrderFacts<'a>(t: OrdersMsg, p: Pilot, facts: &'a Known<'a>) -> impl Render {
    let order = facts.order;
    let reference = order.source_reference_id.as_deref().map(str::trim).filter(|r| !r.is_empty()).unwrap_or(&order.order_id);
    let lower = facts.lower();
    let window = match (facts.fully_delivered, order.status.as_str()) {
        (false, "ready-for-fulfillment") if order.self_service_cancellation_available => {
            Some(t.detail_cancellation_window_open(&lower).to_string())
        }
        (false, "ready-for-fulfillment") if facts.fulfillment_started() => {
            Some(t.detail_cancellation_window_fulfillment_started(&lower).to_string())
        }
        _ => None,
    };
    let deadline = facts.payment_deadline().map(|at| t.detail_payment_deadline_description(&date_time(t, at)).to_string());
    let pay = (facts.side == Side::Buyer && order.status == "pending-payment").then(|| {
        let place = crate::payment_start::StartPlace::of(std::slice::from_ref(&order.order_id));
        crate::app::url::BuyerPaymentNew { place }.href()
    });
    let support = !(facts.fully_delivered && facts.fulfillment_started());
    let support_label = if facts.fulfillment_started() { t.detail_ask_to_cancel() } else { t.detail_open_support() };
    let fulfillment = (!matches!(order.status.as_str(), "pending-payment" | "pending-reservation")).then(|| match facts.side {
        Side::Buyer => crate::app::url::Shipments.href(),
        // The seller's command center is marketplace's (chase-sets/chase-sets#10638).
        Side::Seller => market_href("/account/sales/shipments"),
    });
    let cancel = t.detail_cancel_projection(&lower).to_string();
    html! {
        <div class={(Card, Raised)}>
            <dl class={(Facts, Four)}>
                <div>
                    <dt class={Muted}>{t.detail_source()}</dt>
                    <dd class={Strong}>{&source(p, &order.source_type)}</dd>
                </div>
                <div>
                    <dt class={Muted}>{t.detail_support_reference()}</dt>
                    <dd class={(Strong, Anywhere)}>{reference}</dd>
                </div>
                <div>
                    <dt class={Muted}>{t.detail_counterparty()}</dt>
                    <dd class={Strong}>{facts.counterparty()}</dd>
                </div>
                <div>
                    <dt class={Muted}>{t.detail_terms_resolved()}</dt>
                    <dd>{&date_time(t, &order.terms_resolved_at)}</dd>
                </div>
            </dl>
            <hr class={Rule}>
            if let Some(deadline) = &deadline {
                <div class={(Banner, Info)} role="note">
                    <p class={Strong}>{t.detail_payment_deadline_title()}</p>
                    <p>{deadline}</p>
                </div>
            }
            if let Some(window) = &window {
                <p class={(Banner, Info)} role="note">{window}</p>
            }
            <div class={Actions}>
                if let Some(pay) = &pay {
                    <a class={Primary} href={pay}>{t.detail_pay_now()}</a>
                }
                if support {
                    <a class={Secondary} href={&facts.support_href()}>{support_label}</a>
                }
                if let Some(fulfillment) = &fulfillment {
                    <a class={Secondary} href={fulfillment}>{t.detail_view_fulfillment()}</a>
                }
                if facts.can_cancel {
                    <CancelForm t={t} facts={facts} label={&cancel} />
                }
            </div>
        </div>
    }
}

/// Cancel: a purchase's is its form's button; a sale's opens a dialog that asks first.
#[component(css = OrderPage)]
fn CancelForm<'a>(t: OrdersMsg, facts: &'a Known<'a>, label: &'a str) -> impl Render {
    let action = cancel_href(facts.side, &facts.order.order_id);
    html! {
        if facts.side == Side::Buyer {
            <form method="post" action={&action}>
                <button type="submit" class={DangerButton}>{label}</button>
            </form>
        } else {
            <button type="button" class={DangerButton} command="show-modal" commandfor={CancelDialogId}>{label}</button>
            <dialog
                id={CancelDialogId}
                class={Dialog}
                aria-labelledby="cancel-sale-title"
                aria-describedby="cancel-sale-description"
            >
                <h2 id="cancel-sale-title" class={CardTitle}>{t.detail_cancel_sale_confirm_title()}</h2>
                <p id="cancel-sale-description" class={Muted}>{t.detail_cancel_sale_confirm_description()}</p>
                <form class={Actions} method="post" action={&action}>
                    <button type="button" class={Secondary} command="close" commandfor={CancelDialogId}>
                        {t.detail_cancel_sale_confirm_cancel()}
                    </button>
                    <button type="submit" class={DangerButton}>{t.detail_cancel_sale_confirm_confirm()}</button>
                </form>
            </dialog>
        }
    }
}

/// The order's outcome (`OrderOutcomePanel`): its status, Track issue, and where its review is.
#[component(css = OrderPage)]
fn Outcome<'a>(t: OrdersMsg, facts: &'a Known<'a>) -> impl Render {
    let order = facts.order;
    // marketplace's link adds `role`, which its support page does not read.
    let track = support_for(&order.order_id, None);
    let review_href = match facts.side {
        Side::Buyer => crate::app::url::PurchaseReview { id: &order.order_id, ask: Default::default() }.href(),
        Side::Seller => crate::app::url::SaleReview { id: &order.order_id, ask: Default::default() }.href(),
    };
    html! {
        <div class={(Card, Tinted)}>
            <p class={Strong}>{t.outcome_title()}</p>
            <div class={Stack}>
                <p class={Muted}>{t.outcome_order_status()}</p>
                <span class={Badge} data-tone={if order.status == "cancelled" { "neutral" } else { "success" }}>
                    {&status_label(&order.status)}
                </span>
            </div>
            <div class={Stack}>
                <p class={Muted}>{t.outcome_issue_status()}</p>
                <a class={(Secondary, Wide)} href={&track}>{t.outcome_track_issue()}</a>
            </div>
            <div class={Stack}>
                <p class={Muted}>{t.outcome_review_status()}</p>
                <Review t={t} facts={facts} review={order.review_outcome.as_ref()} href={&review_href} />
            </div>
        </div>
    }
}

/// Where the order's review is (`ReviewOutcome` and `OrderReviewOpportunityCallout`).
#[component(css = OrderPage)]
fn Review<'a>(t: OrdersMsg, facts: &'a Known<'a>, review: Option<&'a ReviewOutcome>, href: &'a str) -> impl Render {
    // No outcome is marketplace's `{ status: "unavailable" }`.
    let unavailable = review.is_none_or(|r| r.status == "unavailable");
    let opportunity = review.and_then(|r| r.opportunity.as_ref());
    // A review the page only describes: its badge, words and badge tone.
    let plain: Option<(&str, &str, &str)> = match (unavailable, opportunity) {
        (true, _) => None,
        (_, None) if facts.order.status != "cancelled" => {
            Some((t.outcome_review_awaiting(), t.outcome_review_awaiting_description(), "neutral"))
        }
        (_, None) => Some((t.outcome_review_ineligible(), t.outcome_review_ineligible_description(), "neutral")),
        (_, Some(o)) if o.submission_state == "held" => {
            Some((t.outcome_review_held(), t.outcome_review_held_description(), "warning"))
        }
        (_, Some(o)) if o.active_review_id.is_none() && (o.submission_state == "expired" || o.window_expired) => {
            Some((t.outcome_review_expired(), t.outcome_review_expired_description(), "neutral"))
        }
        _ => None,
    };
    html! {
        if unavailable {
            <div class={(Banner, Warning)} role="note">
                <p class={Strong}>{t.outcome_review_unavailable()}</p>
                <p>{t.outcome_review_unavailable_description()}</p>
            </div>
        } else if let Some((badge, text, tone)) = plain {
            <div class={Stack}>
                <span class={Badge} data-tone={tone}>{badge}</span>
                <p class={Muted}>{text}</p>
            </div>
        } else if let Some(opportunity) = opportunity {
            <Callout t={t} facts={facts} opportunity={opportunity} href={href} />
        }
    }
}

/// A review the account may write, or has written (`OrderReviewOpportunityCallout`).
#[component(css = OrderPage)]
fn Callout<'a>(t: OrdersMsg, facts: &'a Known<'a>, opportunity: &'a ReviewOpportunity, href: &'a str) -> impl Render {
    let counterparty = if opportunity.author_role == "buyer" { "seller" } else { "buyer" };
    let transaction = match facts.side {
        Side::Buyer => "purchase",
        Side::Seller => "sale",
    };
    let active = opportunity.active_review_id.as_deref();
    let href = match active {
        Some(id) => crate::app::url::Review { id, place: Default::default() }.href(),
        None => href.to_owned(),
    };
    let published = opportunity.revealed && opportunity.active_review_revealed_at.is_some();
    let heading = match active {
        Some(_) => t.callout_your_account_review_is_already_active().to_owned(),
        None => t.callout_ready_for_counterparty_review(transaction, counterparty).to_string(),
    };
    html! {
        <div class={(Card, Tinted)}>
            <p class={Strong}>{&heading}</p>
            if active.is_some() {
                <span class={Badge} data-tone={if published { "success" } else { "neutral" }}>
                    {if published { t.callout_revealed() } else { t.callout_awaiting_reveal() }}
                </span>
            }
            if active.is_some() || opportunity.submission_state == "allowed" {
                <a class={(Primary, Wide)} href={&href}>
                    {if active.is_some() { t.callout_open_your_review() } else { t.callout_leave_account_review() }}
                </a>
            }
        </div>
    }
}

/// The money timeline (`OrderMoneyTimeline`): the buyer's payment and refunds and resolved cases;
/// the seller's held proceeds and refund outcome.
#[component(css = OrderPage)]
fn Timeline<'a>(t: OrdersMsg, facts: &'a Known<'a>, timeline: &'a MoneyTimeline) -> impl Render {
    let money_of = move |amount: &str, currency: &str| money(t, amount, currency);
    let order = facts.order;
    // Each case's link, by its reference: the case's own page (marketplace's goes to its support
    // page for the order with a `requestId` that page does not read).
    let link = |c: &crate::api::SupportCase| {
        let case = crate::app::url::SupportCase { id: &c.support_request_id, place: Default::default() };
        (case.href(), display_reference(&c.support_request_id))
    };
    let terminal: Vec<_> =
        timeline.support_cases.iter().filter(|c| matches!(c.status.as_str(), "resolved" | "closed")).map(link).collect();
    let active: Vec<_> = timeline.support_cases.iter().filter(|c| c.active_hold).map(link).collect();
    let mut events: Vec<(&str, Option<String>, String)> = Vec::new();
    if let Some(paid) = &order.ready_for_fulfillment_at {
        events.push((t.money_paid(), None, date_time(t, paid)));
    }
    for refund in &timeline.refunds {
        let amount = refund.amount.as_deref().map(|a| money_of(a, &refund.currency_code));
        events.push((t.money_refund_requested(), amount, date_time(t, &refund.requested_at)));
        match (refund.status.as_str(), &refund.issued_at, &refund.failed_at) {
            ("issued", Some(at), _) => {
                events.push((t.money_refund_issued(), Some(t.money_refund_issued_eta().to_owned()), date_time(t, at)))
            }
            ("failed", _, Some(at)) => {
                events.push((t.money_refund_failed(), Some(t.money_refund_failed_support().to_owned()), date_time(t, at)))
            }
            _ => {}
        }
    }
    let refunded = cents(&timeline.refunded_amount);
    let retained = format!("{:.2}", (cents(&order.total_amount) - refunded).max(0) as f64 / 100.0);
    html! {
        if facts.side == Side::Buyer {
            if !timeline.refunds.is_empty() || !terminal.is_empty() {
                <div class={Stack}>
                    <ol class={Events} aria-label={t.money_title()}>
                        for (title, description, at) in &events {
                            <li>
                                <p class={Strong}>{*title}</p>
                                if let Some(description) = description {
                                    <p class={Muted}>{description}</p>
                                }
                                <p class={Muted}>{at}</p>
                            </li>
                        }
                    </ol>
                    if !terminal.is_empty() {
                        <div class={Actions}>
                            <span class={Badge} data-tone="success">{t.money_case_resolved()}</span>
                            for (href, reference) in &terminal {
                                <a class={Secondary} href={href}>{reference}</a>
                            }
                        </div>
                    }
                </div>
            }
        } else if !active.is_empty() || refunded > 0 {
            <div class={Stack}>
                if !active.is_empty() {
                    <div class={(Banner, Warning)} role="note">
                        <p class={Strong}>{t.money_hold_title()}</p>
                        <p>
                            {&t.money_hold_description(&money_of(&order.seller_payout_amount, &timeline.currency_code)).to_string()}
                        </p>
                    </div>
                    <div class={Actions}>
                        <span class={Badge} data-tone="warning">{t.money_hold_active()}</span>
                        for (href, reference) in &active {
                            <a class={Secondary} href={href}>{reference}</a>
                        }
                    </div>
                }
                if refunded > 0 {
                    <div class={(Card, Tinted)}>
                        <p class={Strong}>{t.money_refund_outcome()}</p>
                        <dl class={Metrics}>
                            <div class={Metric}>
                                <dt class={MetricLabel}>{t.money_refunded()}</dt>
                                <dd class={MetricValue}>{&money_of(&timeline.refunded_amount, &timeline.currency_code)}</dd>
                            </div>
                            <div class={Metric}>
                                <dt class={MetricLabel}>{t.money_retained()}</dt>
                                <dd class={MetricValue}>{&money_of(&retained, &timeline.currency_code)}</dd>
                            </div>
                        </dl>
                    </div>
                }
            </div>
        }
    }
}

/// A line: on a purchase, the seller's evidence when the offer was accepted; the item, its
/// options, how many and its total.
#[component(css = OrderPage)]
fn Line<'a>(t: OrdersMsg, p: Pilot, side: Side, line: &'a OrderLine) -> impl Render {
    let images: Vec<(String, String)> = if side == Side::Buyer {
        line.listing_evidence_gallery
            .iter()
            .filter_map(|image| {
                let asset = ["catalog-detail", "search-card"]
                    .iter()
                    .find_map(|role| image.assets.iter().find(|a| a.role == *role))
                    .or(image.assets.first())?;
                let alt = image.alt_text.clone().unwrap_or_else(|| p.orders_evidence_alt(&line.item_title).to_string());
                Some((super::on_marketplace(&asset.public_url), alt))
            })
            .collect()
    } else {
        Vec::new()
    };
    let summary = line.product_summary.as_deref().unwrap_or(t.detail_standard());
    let total = format!("{} x {} = {}", line.quantity, usd(t, &line.unit_price_amount), usd(t, &line.line_total_amount));
    html! {
        <article class={Card}>
            if !images.is_empty() {
                <div class={Stack}>
                    <p class={Strong}>{t.detail_seller_evidence_at_acceptance()}</p>
                    <ul class={Evidence}>
                        for (src, alt) in &images {
                            <li><img class={EvidenceImage} src={src} alt={alt} loading="lazy"></li>
                        }
                    </ul>
                    <p class={Muted}>{t.detail_seller_evidence_at_acceptance_description()}</p>
                </div>
            }
            <dl class={(Facts, Three)}>
                <div>
                    <dt class={Strong}>{&line.item_title}</dt>
                    if let Some(subtitle) = &line.item_subtitle {
                        <dd class={Muted}>{subtitle}</dd>
                    }
                    <dd>
                        <ul class={Chips}>
                            for option in &options(Some(summary)) {
                                <li class={Chip}>{option}</li>
                            }
                        </ul>
                    </dd>
                </div>
                <div>
                    <dt class={Muted}>{t.detail_quantity()}</dt>
                    <dd class={Strong}>{line.quantity}</dd>
                </div>
                <div>
                    <dt class={Muted}>{t.detail_line_total()}</dt>
                    <dd class={Strong}>{&total}</dd>
                </div>
            </dl>
        </article>
    }
}

/// The side's money (`PriceBreakdown`): the buyer's what they paid, the seller's their fee, net
/// and payout; then the total.
#[component(css = OrderPage)]
fn Summary<'a>(t: OrdersMsg, facts: &'a Known<'a>) -> impl Render {
    let o = facts.order;
    let delivered_at = o
        .delivery_summary
        .as_ref()
        .filter(|_| facts.fully_delivered)
        .and_then(|d| d.latest_delivered_at.as_deref())
        .map(|at| date_time(t, at));
    let mut lines: Vec<(&str, String)> = vec![(t.detail_item_subtotal(), usd(t, &o.item_subtotal_amount))];
    match facts.side {
        Side::Buyer => {
            lines.push((t.detail_shipping(), usd(t, &o.shipping_charge_amount)));
            lines.push((t.detail_tax(), usd(t, &o.sales_tax_amount)));
        }
        Side::Seller => {
            lines.push((t.detail_shipping_allowance(), usd(t, &o.shipping_allowance_amount)));
            lines.push((t.detail_order_protection(), usd(t, o.protection_amount.as_deref().unwrap_or("0.00"))));
            lines.push((t.detail_marketplace_fee(), usd(t, &o.marketplace_sales_fee_amount)));
            lines.push((t.detail_seller_item_net(), usd(t, &o.seller_item_net_amount)));
            lines.push((t.detail_seller_payout(), usd(t, &o.seller_payout_amount)));
        }
    }
    let (badge, badge_tone) =
        if facts.fully_delivered { (t.detail_delivered(), "success") } else { (o.status.as_str(), tone(&o.status)) };
    html! {
        <div class={(Card, Tinted)}>
            <dl class={Breakdown}>
                <div class={Row}>
                    <dt>{t.detail_status()}</dt>
                    <dd><span class={Badge} data-tone={badge_tone}>{badge}</span></dd>
                </div>
                if let Some(at) = &delivered_at {
                    <div class={Row}>
                        <dt>{t.detail_delivered_at()}</dt>
                        <dd>{at}</dd>
                    </div>
                }
                for (label, value) in &lines {
                    <div class={Row}>
                        <dt>{*label}</dt>
                        <dd class={Strong}>{value}</dd>
                    </div>
                }
            </dl>
            <div class={(Row, Total)}>
                <p class={Strong}>{&t.detail_summary_title(facts.label).to_string()}</p>
                <p class={TotalValue}>{&usd(t, &o.total_amount)}</p>
            </div>
            <p class={Secure}><span aria-hidden="true">"\u{1f512}"</span>" "{t.detail_secure_payment()}</p>
        </div>
    }
}

/// The protection the order has (`OrderProtectionModule`): what is included, the terms, the
/// shipping preference and the payment state.
#[component(css = OrderPage)]
fn Protection<'a>(t: OrdersMsg, p: Pilot, facts: &'a Known<'a>) -> impl Render {
    let o = facts.order;
    let title = match facts.side {
        Side::Buyer => t.detail_buyer_protection(),
        Side::Seller => t.detail_seller_protection(),
    };
    let terms = if o.terms_schedule_id.is_some() { p.orders_terms_locked() } else { t.detail_no_schedule_snapshot() };
    let payment = match facts.payment_deadline() {
        Some(at) => t.detail_payment_deadline_description(&date_time(t, at)).to_string(),
        None => o.status.clone(),
    };
    let help = market_href("/help/buying/order-protection");
    html! {
        <section class={(Card, Tinted)} aria-labelledby="order-protection">
            <h3 id="order-protection" class={ProtectionTitle}>{title}</h3>
            <ul class={Protections}>
                <li>
                    <p class={Strong}>{t.detail_protection_included()}</p>
                    <p class={Muted}>
                        {t.detail_protection_included_description()}" "
                        <a href={&help}>{t.detail_protection_terms_link()}</a>
                    </p>
                </li>
                <li>
                    <p class={Strong}>{t.detail_resolved_terms()}</p>
                    <p class={Muted}>{terms}</p>
                </li>
                <li>
                    <p class={Strong}>{t.detail_shipping_preference()}</p>
                    <p class={Muted}>{&o.shipping_option}</p>
                </li>
                <li>
                    <p class={Strong}>{t.detail_payment_state()}</p>
                    <p class={Muted}>{&payment}</p>
                </li>
            </ul>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_support_request_is_shown_by_its_reference() {
        assert_eq!(display_reference("sup_01M5SPB8DCX26R20QVHASPF77D"), "SUP-HASPF77D");
        assert_eq!(display_reference("sup_seed_case"), "sup_seed_case");
        assert_eq!(display_reference("xyz_01M5SPB8DCX26R20QVHASPF77D"), "xyz_01M5SPB8DCX26R20QVHASPF77D");
        // I, L, O and U are not Crockford base 32.
        assert_eq!(display_reference("sup_01M5SPB8DCX26R20QVHASPF7IL"), "sup_01M5SPB8DCX26R20QVHASPF7IL");
    }

    #[test]
    fn statuses_and_sources_are_written_as_marketplace_writes_them() {
        assert_eq!(status_label("ready-for-fulfillment"), "Ready for fulfillment");
        assert_eq!(status_label("cancelled"), "Cancelled");
        assert_eq!(capitalized("cart-checkout".split('-')), "Cart Checkout");
    }

    #[test]
    fn a_postgres_time_is_read_as_an_instant() {
        let at = timestamp("2026-03-22 12:00:00+00").expect("a time");
        assert_eq!(Some(at), parse_timestamp("2026-03-22T12:00:00Z"));
        assert!(timestamp("2026-10-24T03:55:44.970Z").is_some());
        assert!(timestamp("soon").is_none());
    }
}
