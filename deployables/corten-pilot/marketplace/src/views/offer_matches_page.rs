//! The seller's offer matches (marketplace's `MarketplaceOfferMatchListPage` and
//! `MarketplaceOfferMatchDetailPage`): the list with its best-match snapshot, the Sell List card
//! and each match's item, listing, best offer, offer vs ask, quantities, status and actions; and an
//! offer match's page with its overview, the fee terms accepting it would be priced with, the
//! shipping allowance and the steps.
//!
//! Every action is a form and works without JavaScript; the list is drawn again live. One column
//! on a phone, where a match's actions sit at the bottom of the screen on its page; a match's
//! facts sit beside it from 64rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::listing_page::options;
use crate::{
    api::{AcceptanceTerms, OfferMatch, OfferMatches},
    app::url,
    offer_matches::{OfferForm, OfferScreen},
    text::{OfferMatchesMsg, Pilot},
};

/// The parts a change to the account's offers draws again.
#[derive(Id)]
pub struct OfferSnapshotId;
#[derive(Id)]
pub struct OfferRowsId;

fn money(amount: &str, currency: Option<&str>, t: OfferMatchesMsg) -> String {
    match (platform::money::decimal(amount), currency.and_then(|c| Currency::parse(c.trim()))) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => amount.to_owned(),
    }
}

/// Basis points as a percentage with at most two decimals (`formatBpsPercent`).
fn bps(t: OfferMatchesMsg, bps: u32) -> String {
    t.percent(Decimal::new(i128::from(bps), 4), 2).to_string()
}

/// The offer's price against the listing's (`formatPriceGap`): below, over or meeting the ask.
/// The API sends the gap with two decimals, as marketplace shows it.
fn gap(t: OfferMatchesMsg, amount: &str) -> String {
    let amount = amount.trim();
    let (over, size) = match amount.strip_prefix('-') {
        Some(size) => (true, size),
        None => (false, amount.strip_prefix('+').unwrap_or(amount)),
    };
    if Decimal::parse(size).is_none() {
        return t.gap_unknown().to_owned();
    }
    if size.chars().all(|c| c == '0' || c == '.') {
        return t.gap_meets_ask().to_owned();
    }
    let usd = money(size, Some("USD"), t);
    if over { t.gap_over_ask(&usd).to_string() } else { t.gap_below_ask(&usd).to_string() }
}

/// Whether the seller can take it, in marketplace's order: listings off, a managed state, else
/// whether there is supply.
fn readiness(t: OfferMatchesMsg, offer: &OfferMatch) -> (String, &'static str) {
    if offer.seller_listing_availability_status == "unavailable" {
        (t.list_listings_unavailable().to_owned(), "warning")
    } else if let Some(state) = offer.managed_status.as_deref() {
        (managed(t, state).to_owned(), "warning")
    } else if offer.can_fulfill {
        (t.list_can_fulfill().to_owned(), "success")
    } else {
        (t.list_needs_supply().to_owned(), "warning")
    }
}

fn managed(t: OfferMatchesMsg, state: &str) -> &str {
    match state {
        "unavailable" => t.managed_unavailable(),
        "held" => t.managed_held(),
        "refresh_required" => t.managed_refresh_required(),
        other => other,
    }
}

fn buyer(offer: &OfferMatch) -> &str {
    offer.buyer_display_name.as_deref().unwrap_or(&offer.buyer_account_id)
}

/// The list.
#[component(css)]
pub fn OfferMatchesPage<'a>(t: OfferMatchesMsg, p: Pilot, matches: &'a OfferMatches) -> impl Render {
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.list_seller()}</p>
                <h1 class={Title}>{t.list_offer_matches()}</h1>
                <p class={Muted}>{t.list_compare_best_offers_to_your_listing()}</p>
            </div>
            <p class={Actions}>
                <a class={(Button, Secondary)} href={url::SellerListings::default()}>{t.list_view_listings()}</a>
            </p>
        </header>
        <Snapshot t={t} matches={matches} />
        <section class={Section} aria-labelledby="sell-list-title">
            <h2 id="sell-list-title" class={PartTitle}>{t.list_sell_list()}</h2>
            <div class={(Card, Tinted)}>
                <div class={Banner}>
                    <p class={Strong}>{t.list_checkout_sell_list()}</p>
                    <p>{t.list_offer_matches_source_checkout_sell_list()}</p>
                </div>
                <p class={Hint}>{t.list_add_selected_offers_then_review()}</p>
                <p class={Actions}>
                    <a class={Button} href={&crate::selling::sell_list_href("")}>{t.list_review_checkout_sell_list()}</a>
                    <a class={(Button, Secondary)} href={url::SellerListings::default()}>{t.list_view_listings()}</a>
                </p>
            </div>
        </section>
        <section class={Section} aria-labelledby="matches-title">
            <h2 id="matches-title" class={PartTitle}>{t.list_best_offer_matches()}</h2>
            <Rows t={t} p={p} matches={matches} />
        </section>
        // The snapshot and the rows again on each change to the account's offers
        // (`offer_matches::live`).
        <corten-live src={url::OfferMatchesLive}></corten-live>
    }
}

/// The parts of the list `<corten-live>` draws again.
pub fn offer_matches_live_parts<'a>(t: OfferMatchesMsg, p: Pilot, matches: &'a OfferMatches) -> impl Render + 'a {
    html! {
        <Snapshot t={t} matches={matches} />
        <Rows t={t} p={p} matches={matches} />
    }
}

/// The best-match snapshot (`MarketplaceDashboardPanel`), and that listings are off.
#[component(css = OfferMatchesPage)]
fn Snapshot<'a>(t: OfferMatchesMsg, matches: &'a OfferMatches) -> impl Patch {
    let items = &matches.items;
    let ready = items.iter().filter(|o| o.can_fulfill).count();
    let at_ask = items.iter().filter(|o| o.offer_to_listing_price_bps >= 10_000).count();
    let best = bps(t, items.iter().map(|o| o.offer_to_listing_price_bps).max().unwrap_or(0));
    let off = items.iter().any(|o| o.seller_listing_availability_status == "unavailable");
    html! {
        <div id={OfferSnapshotId} class={Stack}>
            <section class={Panel} aria-labelledby="snapshot-title">
                <div class={Tight}>
                    <h2 id="snapshot-title" class={PartTitle}>{t.list_best_match_snapshot()}</h2>
                    <p class={Muted}>{t.list_best_match_snapshot_description()}</p>
                </div>
                <dl class={Metrics}>
                    <div>
                        <dt>{t.list_active_matches()}</dt>
                        <dd class={Big}>{items.len()}</dd>
                    </div>
                    <div>
                        <dt>{t.list_ready_to_accept()}</dt>
                        <dd class={Big}>{ready}</dd>
                    </div>
                    <div>
                        <dt>{t.list_at_or_above_ask()}</dt>
                        <dd class={Big}>{at_ask}</dd>
                    </div>
                    <div>
                        <dt>{t.list_best_match()}</dt>
                        <dd class={Big}>{best}</dd>
                    </div>
                    <div>
                        <dt>{t.list_source_list()}</dt>
                        <dd class={Strong}>{t.list_checkout_sell_list()}</dd>
                    </div>
                </dl>
            </section>
            if off {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.list_listings_unavailable()}</p>
                    <p>{t.list_turn_listings_on_before_accepting()}</p>
                </div>
            }
        </div>
    }
}

/// The matches, or that there are none.
#[component(css = OfferMatchesPage)]
fn Rows<'a>(t: OfferMatchesMsg, p: Pilot, matches: &'a OfferMatches) -> impl Patch {
    html! {
        <div id={OfferRowsId} class={Stack}>
            if matches.items.is_empty() {
                <div class={Card}>
                    <p class={Strong}>{t.list_no_offer_matches()}</p>
                    <p class={Muted}>{t.list_offer_matches_appear_here_when_submitted()}</p>
                </div>
            } else {
                <ul class={Matches}>
                    for offer in &matches.items {
                        <li class={Match}><MatchRow t={t} p={p} offer={offer} /></li>
                    }
                </ul>
            }
        </div>
    }
}

/// A match: the item, the listing, the best offer, offer vs ask, the quantities, the status and
/// the actions, each labelled, since a phone shows them one under another.
#[component(css = OfferMatchesPage)]
fn MatchRow<'a>(t: OfferMatchesMsg, p: Pilot, offer: &'a OfferMatch) -> impl Render {
    let open = url::OfferMatch { id: &offer.offer_id };
    let submitted = offer.status == "submitted";
    let (ready, tone) = readiness(t, offer);
    let f = OfferForm::FIELDS;
    let (who, title) = (buyer(offer), offer.item_title.as_str());
    html! {
        <div class={Main}>
            <p class={Strong}><a href={&open}>{title}</a></p>
            if let Some(subtitle) = &offer.item_subtitle {
                <p class={Hint}>{subtitle}</p>
            }
            if offer.product_summary.is_some() {
                <p class={Tags}>
                    for option in options(offer.product_summary.as_deref()) {
                        <span class={Tag}>{option}</span>
                    }
                </p>
            }
            <p class={Badges}>
                <span class={Badge} data-tone={if submitted { "accent" } else { "neutral" }}>{&offer.status}</span>
                <span class={Badge} data-tone={tone}>{ready}</span>
            </p>
        </div>
        <dl class={Lines}>
            <div>
                <dt>{t.list_your_listing()}</dt>
                <dd>
                    <span class={Strong}>{money(&offer.listing_price_amount, Some(&offer.listing_price_currency_code), t)}</span>
                    <span class={Hint}>
                        {t.list_listing_quantity(offer.listing_visible_quantity, offer.listing_quantity_cap)}
                    </span>
                </dd>
            </div>
            <div>
                <dt>{t.list_best_offer()}</dt>
                <dd>
                    <span class={Strong}>{money(&offer.price_amount, offer.price_currency_code.as_deref(), t)}</span>
                    <Buyer t={t} p={p} offer={offer} />
                </dd>
            </div>
            <div>
                <dt>{t.list_offer_vs_ask()}</dt>
                <dd>
                    <span class={Badge} data-tone={if offer.offer_to_listing_price_bps >= 10_000 { "success" } else { "accent" }}>
                        {bps(t, offer.offer_to_listing_price_bps)}
                    </span>
                    <span class={Hint}>{gap(t, &offer.offer_price_gap_amount)}</span>
                </dd>
            </div>
            <div>
                <dt>{t.list_quantity()}</dt>
                <dd>
                    <span>{t.list_requested_quantity(offer.quantity_requested)}</span>
                    <span class={Hint}>{t.list_available_quantity(offer.seller_available_quantity)}</span>
                </dd>
            </div>
            <div>
                <dt>{t.list_updated()}</dt>
                <dd>{date(t, &offer.updated_at)}</dd>
            </div>
        </dl>
        <div class={Row}>
            <form method="post" action={&open}>
                <input type="hidden" name={f.intent} value="add-selected-offer">
                <button
                    class={(Button, Secondary)}
                    type="submit"
                    disabled={!offer.can_fulfill || !submitted}
                    aria-label={p.offer_matches_add_for(who, title).to_string()}
                >
                    {t.list_add_to_sell_list()}
                </button>
            </form>
            <a class={(Button, Secondary)} href={&open} aria-label={p.offer_matches_open_for(who, title).to_string()}>
                {t.list_open()}
            </a>
            <form method="post" action={&open}>
                <input type="hidden" name={f.intent} value="decline-offer">
                {SubmitKey::field(f.attempt_id)}
                <button
                    class={(Button, Secondary)}
                    type="submit"
                    disabled={!submitted}
                    aria-label={p.offer_matches_decline_for(who, title).to_string()}
                >
                    {t.list_decline()}
                </button>
            </form>
        </div>
    }
}

fn date(t: OfferMatchesMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
}

/// The buyer's name and rating (`AccountReputationSummary`): "New" with no reviews.
#[component(css = OfferMatchesPage)]
fn Buyer<'a>(t: OfferMatchesMsg, p: Pilot, offer: &'a OfferMatch) -> impl Render {
    let rating = offer.buyer_average_rating.as_deref().and_then(|r| r.parse::<f64>().ok()).filter(|r| r.is_finite());
    html! {
        <span class={Who}>
            <span class={Strong}>{buyer(offer)}</span>
            match rating.filter(|_| offer.buyer_review_count > 0) {
                Some(r) => {
                    <span
                        class={Hint}
                        aria-label={p.offer_matches_rating(&format!("{r:.1}"), offer.buyer_review_count).to_string()}
                    >
                        <span aria-hidden="true">"\u{2605} " {format!("{r:.1}")} " (" {offer.buyer_review_count} ")"</span>
                    </span>
                }
                None => { <span class={Hint} title={t.list_no_buyer_feedback_yet()}>{p.offer_matches_new_buyer()}</span> }
            }
        </span>
    }
}

/// An offer match's page.
#[component(css = OfferMatchesPage)]
pub fn OfferMatchPage<'a>(t: OfferMatchesMsg, p: Pilot, screen: &'a OfferScreen) -> impl Render {
    let offer = &screen.offer;
    let submitted = offer.status == "submitted";
    let (ready, tone) = readiness(t, offer);
    let offer_price = money(&offer.price_amount, offer.price_currency_code.as_deref(), t);
    let listing_price = money(&offer.listing_price_amount, Some(&offer.listing_price_currency_code), t);
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.detail_offer_match()}</p>
                <h1 class={Title}>{&offer.item_title}</h1>
                <p class={Muted}>{t.detail_review_an_offer_match_that_matches()}</p>
            </div>
            <p class={Actions}>
                <a class={(Button, Secondary)} href={url::OfferMatches::default()}>{t.detail_back_to_offer_matches()}</a>
            </p>
        </header>
        <div class={Notes} role="status" aria-live="polite">
            if let Some(refusal) = &screen.refusal {
                <div class={Banner} data-tone="danger" tabindex="-1">
                    <p class={Strong}>{t.detail_offer_match_overview()}</p>
                    <p>{refusal}</p>
                </div>
            }
        </div>
        if let Some(state) = offer.managed_status.as_deref() {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.detail_offer_match_overview()}</p>
                <p>{managed(t, state)}</p>
            </div>
        }
        if offer.seller_listing_availability_status == "unavailable" {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.detail_listings_unavailable()}</p>
                <p>{t.detail_turn_listings_on_before_accepting()}</p>
            </div>
        }
        <section class={Section} aria-labelledby="overview-title">
            <h2 id="overview-title" class={PartTitle}>{t.detail_offer_match_overview()}</h2>
            <div class={Overview}>
                <div class={Card}>
                    <p class={Badges}>
                        <span class={Badge} data-tone={if submitted { "accent" } else { "neutral" }}>{&offer.status}</span>
                        <span class={Badge} data-tone={tone}>{ready}</span>
                    </p>
                    <p class={Big}>{&offer_price}</p>
                    <p class={Muted}>
                        {t.detail_offer_is_percentage_of_ask(&bps(t, offer.offer_to_listing_price_bps), &gap(t, &offer.offer_price_gap_amount))}
                    </p>
                    <p class={Strong}>{&offer.item_title}</p>
                    if let Some(subtitle) = &offer.item_subtitle {
                        <p class={Muted}>{subtitle}</p>
                    }
                    if offer.product_summary.is_some() {
                        <p class={Tags}>
                            for option in options(offer.product_summary.as_deref()) {
                                <span class={Tag}>{option}</span>
                            }
                        </p>
                    }
                    <dl class={Facts}>
                        <div>
                            <dt>{t.detail_buyer().trim_end_matches([':', ' '])}</dt>
                            <dd><Buyer t={t} p={p} offer={offer} /></dd>
                        </div>
                        <div>
                            <dt>{t.detail_listing_price().trim_end_matches([':', ' '])}</dt>
                            <dd>{&listing_price}</dd>
                        </div>
                        <div>
                            <dt>{t.detail_offer_vs_ask().trim_end_matches([':', ' '])}</dt>
                            <dd>{bps(t, offer.offer_to_listing_price_bps)}</dd>
                        </div>
                        <div>
                            <dt>{t.detail_ask_gap().trim_end_matches([':', ' '])}</dt>
                            <dd>{gap(t, &offer.offer_price_gap_amount)}</dd>
                        </div>
                        <div>
                            <dt>{t.detail_quantity_requested().trim_end_matches([':', ' '])}</dt>
                            <dd>{offer.quantity_requested}</dd>
                        </div>
                        <div>
                            <dt>{t.detail_active_supply_available().trim_end_matches([':', ' '])}</dt>
                            <dd>{offer.seller_available_quantity}</dd>
                        </div>
                    </dl>
                </div>
                if let Some(terms) = &screen.terms {
                    <Terms t={t} p={p} terms={terms} offer_price={&offer_price} listing_price={&listing_price} />
                }
                <div class={Card}>
                    <p class={PartTitle}>{t.detail_seller_shipping_allowance()}</p>
                    <p class={Muted}>
                        match screen.terms.as_ref().and_then(|terms| terms.shipping_allowance_percentage_bps) {
                            Some(rate) => { {t.detail_accepting_this_offer_earns_percentage_toward_shipping(&bps(t, rate))} }
                            None => { {t.detail_standard_terms()} }
                        }
                    </p>
                    <dl class={Facts}>
                        <div>
                            <dt>{t.detail_can_fulfill()}</dt>
                            <dd>if offer.can_fulfill { {t.detail_can_fulfill()} } else { {t.detail_needs_supply()} }</dd>
                        </div>
                        <div>
                            <dt>{t.detail_quote_time().trim_end_matches([':', ' '])}</dt>
                            <dd>
                                {screen.terms.as_ref().and_then(|terms| terms.resolved_at.as_deref()).and_then(parse_timestamp)
                                    .map_or_else(|| t.detail_standard_terms().to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())}
                            </dd>
                        </div>
                    </dl>
                </div>
                <Timeline t={t} offer={offer} />
            </div>
            if submitted {
                <OfferActions t={t} offer={offer} price={&offer_price} ready={&ready} />
            }
        </section>
    }
}

/// Accept offer match (adds it to the Sell List, as marketplace's does), Add selected offer to
/// Sell List and Decline: after the overview from 48rem, at the bottom of the screen on a phone
/// for the whole page.
#[component(css = OfferMatchesPage)]
fn OfferActions<'a>(t: OfferMatchesMsg, offer: &'a OfferMatch, price: &'a str, ready: &'a str) -> impl Render {
    let f = OfferForm::FIELDS;
    html! {
        <div class={Bar}>
            <p class={Total}><span class={Strong}>{price}</span> <span class={Hint}>{ready}</span></p>
            <div class={Actions}>
                <form method="post">
                    <input type="hidden" name={f.intent} value="add-selected-offer">
                    <button class={Button} type="submit" disabled={!offer.can_fulfill}>{t.detail_accept_offer_match()}</button>
                </form>
                <form method="post">
                    <input type="hidden" name={f.intent} value="add-selected-offer">
                    <button class={(Button, Secondary)} type="submit">{t.detail_add_to_sell_list()}</button>
                </form>
                // Marketplace's Decline here is off while the seller cannot fulfill the offer, which is
                // when declining it matters most; the list's is not, and the pilot follows the list.
                <form method="post">
                    <input type="hidden" name={f.intent} value="decline-offer">
                    {SubmitKey::field(f.attempt_id)}
                    <button class={(Button, Secondary)} type="submit">{t.detail_decline()}</button>
                </form>
            </div>
        </div>
    }
}

/// What accepting it would be priced with (`PriceBreakdown`).
#[component(css = OfferMatchesPage)]
fn Terms<'a>(
    t: OfferMatchesMsg,
    p: Pilot,
    terms: &'a AcceptanceTerms,
    offer_price: &'a str,
    listing_price: &'a str,
) -> impl Render {
    let usd = |amount: Option<&str>| amount.map(|a| money(a, Some("USD"), t)).unwrap_or_default();
    let label = |text: &'a str| text.trim_end_matches([':', ' ']);
    html! {
        <div class={Card}>
            <dl class={Facts}>
                <div>
                    <dt>{label(t.detail_offer_price())}</dt>
                    <dd>{offer_price}</dd>
                </div>
                <div>
                    <dt>{label(t.detail_listing_price())}</dt>
                    <dd>{listing_price}</dd>
                </div>
                <div>
                    <dt>{label(t.detail_marketplace_fee())}</dt>
                    <dd>{usd(terms.marketplace_sales_fee_unit_amount.as_deref())}</dd>
                </div>
                <div>
                    <dt>{label(t.detail_shipping_allowance_rate())}</dt>
                    <dd>{bps(t, terms.shipping_allowance_percentage_bps.unwrap_or_default())}</dd>
                </div>
                <div>
                    <dt>{label(t.detail_terms_source())}</dt>
                    <dd>
                        if terms.agreement_id.is_some() { {p.offer_matches_seller_terms()} } else { {t.detail_standard_terms()} }
                    </dd>
                </div>
                <div class={Sum}>
                    <dt>{label(t.detail_seller_net())}</dt>
                    <dd>{usd(terms.seller_net_unit_amount.as_deref())}</dd>
                </div>
            </dl>
        </div>
    }
}

/// The three steps (`MarketplaceStatusTimeline`).
#[component(css = OfferMatchesPage)]
fn Timeline<'a>(t: OfferMatchesMsg, offer: &'a OfferMatch) -> impl Render {
    let accepted = offer.status == "accepted";
    let supply = format!("{}{}", t.detail_active_supply_available(), offer.seller_available_quantity);
    let last = if accepted {
        t.detail_this_offer_match_has_already_been()
    } else if offer.can_fulfill {
        t.detail_accept_this_match_to_create_the_sale()
    } else {
        t.detail_add_enough_available_supply_before_accepting()
    };
    html! {
        <ol class={Steps}>
            <li data-state={if accepted { "complete" } else { "current" }}>
                <p class={Strong}>{&offer.status}</p>
                <p class={Hint}>{t.detail_review_an_offer_match_that_matches()}</p>
            </li>
            <li data-state={if offer.can_fulfill { "complete" } else { "issue" }}>
                <p class={Strong}>if offer.can_fulfill { {t.detail_can_fulfill()} } else { {t.detail_needs_supply()} }</p>
                <p class={Hint}>{supply}</p>
            </li>
            <li data-state={if accepted { "complete" } else { "upcoming" }}>
                <p class={Strong}>{t.detail_accept_offer_match()}</p>
                <p class={Hint}>{last}</p>
            </li>
        </ol>
    }
}
