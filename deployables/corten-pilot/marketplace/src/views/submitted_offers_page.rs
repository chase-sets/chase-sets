//! The buyer's submitted offers (marketplace's `MarketplaceSubmittedOfferListPage`): the status
//! filter with each status's count, what the change before did to each offer, and each offer's
//! item, price, status, options, quantity, the accepting seller's reputation and when it changed,
//! with Open and, for a reader with `offers.manage`, its Pause, Resume and Withdraw and a box to
//! check it for the bulk bar.
//!
//! Every action is a form and works without JavaScript: Withdraw (one or the checked offers) asks
//! first in a `<dialog>` its button opens (`command="show-modal"`). The page's script only counts
//! the checked offers in the bar, which it shows once one is checked. One column on a phone, two
//! from 80rem.
use corten::{
    i18n::{Currency, DateStyle, parse_timestamp},
    prelude::*,
};

use super::listing_page::options;
use crate::{
    api::{LifecycleOutcome, OfferStatusCounts, SubmittedOffer},
    app::url,
    submitted_offers::{LifecycleForm, OfferPlace, OfferScreen, OffersScreen, Place, STATUSES, actions},
    text::{Pilot, SubmittedOffersMsg},
};

corten::script::script!(pub mod handlers = "submitted_offers_page.js");

/// The form around the offers, for the bulk bar and every row's change.
#[derive(Id, Clone, Copy)]
pub struct OffersFormId;
/// Withdraw selected's dialog.
#[derive(Id, Clone, Copy)]
pub struct BulkWithdrawId;
/// An offer's Withdraw dialog and its title.
#[derive(Id, Clone, Copy)]
pub struct WithdrawId<'a>(pub &'a str);
#[derive(Id, Clone, Copy)]
pub struct WithdrawTitleId<'a>(pub &'a str);
/// The parts a change to the account's offers draws again.
#[derive(Id)]
pub struct OfferFiltersId;
#[derive(Id)]
pub struct SubmittedRowsId;

/// An offer's price in its currency (`formatMoney`), or that it is incomplete.
fn money(t: SubmittedOffersMsg, offer: &SubmittedOffer) -> String {
    let currency = offer.price_currency_code.as_deref().and_then(|c| Currency::parse(c.trim()));
    match (platform::money::decimal(&offer.price_amount), currency) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        (None, Some(_)) => offer.price_amount.clone(),
        _ => t.price_incomplete().to_owned(),
    }
}

fn date(t: SubmittedOffersMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
}

/// A status's word (`submittedOfferStatusLabel`); an unknown one as the API sent it.
pub fn status_label(t: SubmittedOffersMsg, status: &str) -> String {
    match status {
        "submitted" => t.lifecycle_status_submitted().to_owned(),
        "paused" => t.lifecycle_status_paused().to_owned(),
        "withdrawn" => t.lifecycle_status_withdrawn().to_owned(),
        "accepted" => t.lifecycle_status_accepted().to_owned(),
        other => other.to_owned(),
    }
}

/// `submittedOfferStatusTone`.
fn tone(status: &str) -> &'static str {
    match status {
        "submitted" => "accent",
        "paused" => "warning",
        _ => "neutral",
    }
}

/// A filter's label with its count (`statusFilterLabel`).
fn filter_label(t: SubmittedOffersMsg, status: Option<&str>, counts: &OfferStatusCounts) -> String {
    match status {
        None => t.lifecycle_filter_all(counts.submitted + counts.paused + counts.withdrawn + counts.accepted).to_string(),
        Some("submitted") => t.lifecycle_filter_submitted(counts.submitted).to_string(),
        Some("paused") => t.lifecycle_filter_paused(counts.paused).to_string(),
        Some("withdrawn") => t.lifecycle_filter_withdrawn(counts.withdrawn).to_string(),
        Some(_) => t.lifecycle_filter_accepted(counts.accepted).to_string(),
    }
}

fn empty_title(t: SubmittedOffersMsg, status: &str) -> &str {
    match status {
        "submitted" => t.lifecycle_empty_submitted(),
        "paused" => t.lifecycle_empty_paused(),
        "withdrawn" => t.lifecycle_empty_withdrawn(),
        _ => t.lifecycle_empty_accepted(),
    }
}

/// The list.
#[component(css)]
pub fn SubmittedOffersPage<'a>(t: SubmittedOffersMsg, p: Pilot, screen: &'a OffersScreen) -> impl Render {
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.list_offers()}</p>
                <h1 class={Title}>{t.list_submitted_offers()}</h1>
                <p class={Muted}>{t.list_review_the_offers_your_account_has()}</p>
            </div>
        </header>
        if let Some(message) = &screen.refusal {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{t.list_offer_status_issue()}</p>
                <p>{message}</p>
            </div>
        }
        if let Some(outcomes) = &screen.outcomes {
            <Outcomes t={t} outcomes={outcomes} offers={&screen.offers.items} />
        }
        <section class={Section} aria-labelledby="submitted-offers-title">
            <h2 id="submitted-offers-title" class={PartTitle}>{t.list_submitted_offers_2()}</h2>
            <Filters t={t} screen={screen} />
            if screen.manage {
                <OffersForm t={t} p={p} screen={screen} />
            } else {
                <Rows t={t} p={p} screen={screen} />
            }
        </section>
        // The counts and the rows again on each change to the account's offers
        // (`submitted_offers::live`).
        <corten-live src={url::SubmittedOffersLive { place: screen.place.clone() }}></corten-live>
    }
}

/// The offers in the form the bulk bar and every row's change post, and the bar: how many are
/// checked (with the script), Pause selected, Resume selected, Withdraw selected (asked first) and
/// Clear selection (the form's reset).
#[component(css = SubmittedOffersPage)]
fn OffersForm<'a>(t: SubmittedOffersMsg, p: Pilot, screen: &'a OffersScreen) -> impl Render {
    let f = LifecycleForm::FIELDS;
    let here = url::SubmittedOffers { place: screen.place.clone() };
    let (form, count) = refs();
    html! {
        <form
            ref={form}
            id={OffersFormId}
            class={Bulk}
            method="post"
            action={&here}
            on:change={handlers::picked(form, count, t.js().lifecycle_bulk_selected())}
            on:reset={handlers::cleared(form, count, t.js().lifecycle_bulk_selected())}
            on:connect={handlers::picked(form, count, t.js().lifecycle_bulk_selected())}
        >
            <Rows t={t} p={p} screen={screen} />
            <div class={Bar}>
                <output ref={count} class={Strong}></output>
                <p class={Row}>
                    <button class={Button} type="submit" name={f.lifecycle_action} value="pause">
                        {t.lifecycle_bulk_pause()}
                    </button>
                    <button class={Button} type="submit" name={f.lifecycle_action} value="resume">
                        {t.lifecycle_bulk_resume()}
                    </button>
                    <button class={(Button, Secondary)} type="button" command="show-modal" commandfor={BulkWithdrawId}>
                        {t.lifecycle_bulk_withdraw()}
                    </button>
                    <button class={(Button, Secondary)} type="reset">{t.lifecycle_bulk_clear()}</button>
                </p>
                <dialog
                    id={BulkWithdrawId}
                    class={Dialog}
                    aria-labelledby="bulk-withdraw-title"
                    aria-describedby="bulk-withdraw-description"
                >
                    <h2 id="bulk-withdraw-title" class={PartTitle}>{t.lifecycle_bulk_withdraw()}</h2>
                    <p id="bulk-withdraw-description" class={Muted}>{t.lifecycle_withdraw_confirm_description()}</p>
                    <p class={Row}>
                        <button class={(Button, Secondary)} type="button" command="close" commandfor={BulkWithdrawId}>
                            {t.lifecycle_withdraw_confirm_cancel()}
                        </button>
                        <button class={Button} type="submit" name={f.lifecycle_action} value="withdraw">
                            {t.lifecycle_withdraw()}
                        </button>
                    </p>
                </dialog>
            </div>
        </form>
    }
}

/// The parts of the list `<corten-live>` draws again.
pub fn submitted_offers_live_parts<'a>(t: SubmittedOffersMsg, p: Pilot, screen: &'a OffersScreen) -> impl Render + 'a {
    html! {
        <Filters t={t} screen={screen} />
        <Rows t={t} p={p} screen={screen} />
    }
}

/// The status filter (`SegmentedControl`), as links, each with its count.
#[component(css = SubmittedOffersPage)]
fn Filters<'a>(t: SubmittedOffersMsg, screen: &'a OffersScreen) -> impl Patch {
    let current = screen.place.status();
    let statuses = std::iter::once(None).chain(STATUSES.into_iter().map(Some));
    html! {
        <div id={OfferFiltersId}>
            if let Some(counts) = &screen.offers.status_counts {
                <nav class={Filter} aria-label={t.lifecycle_status_filter()}>
                    for status in statuses {
                        <a
                            class={Choice}
                            href={url::SubmittedOffers { place: Place::of(status) }}
                            aria-current={if status == current { Some("page") } else { None }}
                        >
                            {filter_label(t, status, counts)}
                        </a>
                    }
                </nav>
            }
        </div>
    }
}

/// The offers, or that there are none.
#[component(css = SubmittedOffersPage)]
fn Rows<'a>(t: SubmittedOffersMsg, p: Pilot, screen: &'a OffersScreen) -> impl Patch {
    let items = &screen.offers.items;
    html! {
        <div id={SubmittedRowsId} class={Stack}>
            if items.is_empty() {
                <div class={Card}>
                    match screen.place.status() {
                        None => {
                            <p class={Strong}>{t.list_no_submitted_offers_yet()}</p>
                            <p class={Muted}>{t.list_submit_an_offer_from_any_item()}</p>
                            <p class={Row}>
                                <a class={(Button, Secondary)} href="/">{t.list_browse_marketplace()}</a>
                            </p>
                        }
                        Some(status) => {
                            <p class={Strong}>{empty_title(t, status)}</p>
                            <p class={Muted}>{t.lifecycle_empty_description()}</p>
                        }
                    }
                </div>
            } else {
                <ul class={Offers}>
                    for offer in items {
                        <li class={Offer}><OfferRow t={t} p={p} offer={offer} manage={screen.manage} /></li>
                    }
                </ul>
            }
        </div>
    }
}

/// An offer (`OfferCard`): its item, status, options and facts, each labelled, and its actions.
#[component(css = SubmittedOffersPage)]
fn OfferRow<'a>(t: SubmittedOffersMsg, p: Pilot, offer: &'a SubmittedOffer, manage: bool) -> impl Render {
    let f = LifecycleForm::FIELDS;
    let title = offer.item_title.as_str();
    let id = offer.offer_id.as_str();
    let open = url::SubmittedOffer { id, place: OfferPlace::default() };
    let seller = offer.accepted_seller_account_id.as_deref().filter(|_| offer.status == "accepted");
    html! {
        if manage {
            <label class={Pick}>
                <input type="checkbox" name={f.offer_ids} value={id} aria-label={t.lifecycle_select_row(title).to_string()}>
            </label>
        }
        <div class={Main}>
            <p class={Strong}>{title}</p>
            <p class={Badges}>
                <span class={Badge} data-tone={tone(&offer.status)}>{status_label(t, &offer.status)}</span>
            </p>
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
        </div>
        <dl class={Lines}>
            <div>
                <dt>{t.list_offer_price()}</dt>
                <dd class={Strong}>{money(t, offer)}</dd>
            </div>
            <div>
                <dt>{t.list_quantity()}</dt>
                <dd>{t.list_quantity_requested(offer.quantity_requested)}</dd>
            </div>
            if let Some(seller) = seller {
                <div>
                    <dt>{t.list_seller_reputation()}</dt>
                    <dd><Seller t={t} p={p} offer={offer} seller={seller} /></dd>
                </div>
            }
            <div>
                <dt>{t.list_updated()}</dt>
                <dd>{date(t, &offer.updated_at)}</dd>
            </div>
        </dl>
        <p class={Row}>
            <a class={(Button, Secondary)} href={&open} aria-label={p.submitted_offers_open_for(title).to_string()}>
                {t.list_open()}
            </a>
            if manage {
                for action in actions(&offer.status) {
                    match *action {
                        "withdraw" => {
                            <button
                                class={(Button, Secondary)}
                                type="button"
                                command="show-modal"
                                commandfor={WithdrawId(id)}
                                aria-label={t.lifecycle_withdraw_row(title).to_string()}
                            >
                                {t.lifecycle_withdraw()}
                            </button>
                            <dialog id={WithdrawId(id)} class={Dialog} aria-labelledby={WithdrawTitleId(id)}>
                                <h2 id={WithdrawTitleId(id)} class={PartTitle}>{t.lifecycle_withdraw_confirm_title_one()}</h2>
                                <p class={Muted}>{title}</p>
                                <p class={Muted}>{t.lifecycle_withdraw_confirm_description()}</p>
                                <p class={Row}>
                                    <button class={(Button, Secondary)} type="button" command="close" commandfor={WithdrawId(id)}>
                                        {t.lifecycle_withdraw_confirm_cancel()}
                                    </button>
                                    <button class={Button} type="submit" name={f.row} value={format!("withdraw:{id}")}>
                                        {t.lifecycle_withdraw()}
                                    </button>
                                </p>
                            </dialog>
                        }
                        "pause" => {
                            <button
                                class={(Button, Secondary)}
                                type="submit"
                                name={f.row}
                                value={format!("pause:{id}")}
                                aria-label={t.lifecycle_pause_row(title).to_string()}
                            >
                                {t.lifecycle_pause()}
                            </button>
                        }
                        _ => {
                            <button
                                class={(Button, Secondary)}
                                type="submit"
                                name={f.row}
                                value={format!("resume:{id}")}
                                aria-label={t.lifecycle_resume_row(title).to_string()}
                            >
                                {t.lifecycle_resume()}
                            </button>
                        }
                    }
                }
            }
        </p>
    }
}

/// The accepting seller and their rating (`AccountReputationSummary`).
#[component(css = SubmittedOffersPage)]
fn Seller<'a>(t: SubmittedOffersMsg, p: Pilot, offer: &'a SubmittedOffer, seller: &'a str) -> impl Render {
    let reviews = offer.accepted_seller_review_count.unwrap_or(0);
    let rating = offer.accepted_seller_average_rating.as_deref().and_then(|r| r.parse::<f64>().ok()).filter(|r| r.is_finite());
    html! {
        <span class={Who}>
            <span class={Strong}>{seller}</span>
            match rating.filter(|_| reviews > 0) {
                Some(r) => {
                    <span class={Hint} aria-label={p.submitted_offers_rating(&format!("{r:.1}"), reviews).to_string()}>
                        <span aria-hidden="true">"\u{2605} " {format!("{r:.1}")} " (" {reviews} ")"</span>
                    </span>
                }
                None => { <span class={Hint}>{t.list_no_seller_feedback_yet()}</span> }
            }
        </span>
    }
}

/// What the change did to each offer (`SubmittedOfferLifecycleOutcomes`), by the offer's title.
#[component(css = SubmittedOffersPage)]
fn Outcomes<'a>(t: SubmittedOffersMsg, outcomes: &'a [LifecycleOutcome], offers: &'a [SubmittedOffer]) -> impl Render {
    let count = |kind: &str| outcomes.iter().filter(|o| o.outcome == kind).count();
    let rejected = count("rejected");
    let title = |id: &'a str| offers.iter().find(|o| o.offer_id == id).map_or(id, |o| o.item_title.as_str());
    html! {
        <div class={Banner} data-tone={if rejected > 0 { "warning" } else { "success" }} role="status" tabindex="-1">
            <p class={Strong}>{t.lifecycle_outcomes_title()}</p>
            <p>{t.lifecycle_outcomes_summary(count("changed"), count("unchanged"), rejected)}</p>
            <ul class={Outcome}>
                for outcome in outcomes {
                    <li>{outcome_line(t, outcome, title(&outcome.offer_id))}</li>
                }
            </ul>
        </div>
    }
}

fn outcome_line(t: SubmittedOffersMsg, outcome: &LifecycleOutcome, offer: &str) -> String {
    let status = status_label(t, outcome.status.as_deref().unwrap_or_default());
    match (outcome.outcome.as_str(), outcome.code.as_deref()) {
        ("changed", _) => t.lifecycle_outcome_changed(offer, &status).to_string(),
        ("unchanged", _) => t.lifecycle_outcome_unchanged(offer, &status).to_string(),
        (_, Some("not_found")) => t.lifecycle_outcome_not_found(offer).to_string(),
        (_, Some("offer_transition_rejected")) => t.lifecycle_outcome_offer_transition_rejected(offer).to_string(),
        (_, Some("offer_conflict")) => t.lifecycle_outcome_offer_conflict(offer).to_string(),
        (_, Some("offer_lifecycle_closed")) => t.lifecycle_outcome_offer_lifecycle_closed(offer).to_string(),
        _ => t.lifecycle_outcome_request_failed(offer).to_string(),
    }
}

/// A label written as a prefix (`Offer price: `) used as a term.
fn term(label: &str) -> &str {
    label.trim_end_matches([':', ' '])
}

/// One offer's page (marketplace's `MarketplaceSubmittedOfferDetailPage`): the header with Back to
/// submitted offers; Manage this Offer (the paused notice, what the change did, and Pause, Resume
/// or Withdraw, Withdraw asking first) for a reader with `offers.manage`; and the overview: the
/// offer's card (price and status, options, quantity, that it is marketplace-wide, the accepting
/// seller), the price lines, and where it is. Marketplace's protection module repeats the
/// overview's own sentences and is left out. One column; the card and the price lines side by side
/// from 64rem.
#[component(css = SubmittedOffersPage)]
pub fn SubmittedOfferPage<'a>(t: SubmittedOffersMsg, p: Pilot, screen: &'a OfferScreen) -> impl Render {
    let f = LifecycleForm::FIELDS;
    let offer = &screen.offer;
    let id = offer.offer_id.as_str();
    let title = offer.item_title.as_str();
    let status = offer.status.as_str();
    let available: &[&str] = if screen.manage { actions(status) } else { &[] };
    let seller = offer.accepted_seller_account_id.as_deref().filter(|_| status == "accepted");
    let price = money(t, offer);
    let open = matches!(status, "submitted" | "paused");
    let here = url::SubmittedOffer { id, place: OfferPlace::default() };
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.detail_offers()}</p>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{t.detail_review_the_details_of_your_submitted()}</p>
            </div>
            <a class={(Button, Secondary)} href={url::SubmittedOffers::default()}>{t.detail_back_to_submitted_offers()}</a>
        </header>
        if let Some(message) = &screen.refusal {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{t.list_offer_status_issue()}</p>
                <p>{message}</p>
            </div>
        }
        if !available.is_empty() || screen.outcomes.is_some() {
            <section class={Section} aria-labelledby="offer-manage-title">
                <h2 id="offer-manage-title" class={PartTitle}>{t.lifecycle_manage_title()}</h2>
                if status == "paused" {
                    <div class={Banner} data-tone="warning">
                        <p class={Strong}>{status_label(t, status)}</p>
                        <p>{t.lifecycle_paused_notice()}</p>
                    </div>
                }
                if let Some(outcomes) = &screen.outcomes {
                    <Outcomes t={t} outcomes={outcomes} offers={std::slice::from_ref(offer)} />
                }
                if !available.is_empty() {
                    <form class={Row} method="post" action={&here}>
                        for action in available {
                            match *action {
                                "withdraw" => {
                                    <button
                                        class={(Button, Secondary)}
                                        type="button"
                                        command="show-modal"
                                        commandfor={WithdrawId(id)}
                                    >
                                        {t.lifecycle_withdraw_offer()}
                                    </button>
                                    <dialog id={WithdrawId(id)} class={Dialog} aria-labelledby={WithdrawTitleId(id)}>
                                        <h2 id={WithdrawTitleId(id)} class={PartTitle}>
                                            {t.lifecycle_withdraw_confirm_title_one()}
                                        </h2>
                                        <p class={Muted}>{title}</p>
                                        <p class={Muted}>{t.lifecycle_withdraw_confirm_description()}</p>
                                        <p class={Row}>
                                            <button
                                                class={(Button, Secondary)}
                                                type="button"
                                                command="close"
                                                commandfor={WithdrawId(id)}
                                            >
                                                {t.lifecycle_withdraw_confirm_cancel()}
                                            </button>
                                            <button class={Button} type="submit" name={f.row} value={format!("withdraw:{id}")}>
                                                {t.lifecycle_withdraw()}
                                            </button>
                                        </p>
                                    </dialog>
                                }
                                "pause" => {
                                    <button class={Button} type="submit" name={f.row} value={format!("pause:{id}")}>
                                        {t.lifecycle_pause_offer()}
                                    </button>
                                }
                                _ => {
                                    <button class={Button} type="submit" name={f.row} value={format!("resume:{id}")}>
                                        {t.lifecycle_resume_offer()}
                                    </button>
                                }
                            }
                        }
                    </form>
                }
            </section>
        }
        <section class={Section} aria-labelledby="offer-overview-title">
            <h2 id="offer-overview-title" class={PartTitle}>{t.detail_submitted_offer_overview()}</h2>
            <div class={Overview}>
                <article class={Card}>
                    <div class={Main}>
                        <p class={Strong}>{title}</p>
                        <p class={Badges}>
                            <span class={Strong}>{&price}</span>
                            <span class={Badge} data-tone={tone(status)}>{status_label(t, status)}</span>
                        </p>
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
                    </div>
                    <dl class={Lines}>
                        <div>
                            <dt>{term(t.detail_quantity_requested())}</dt>
                            <dd>{offer.quantity_requested}</dd>
                        </div>
                        if let Some(seller) = seller {
                            <div>
                                <dt>{t.detail_seller_reputation()}</dt>
                                <dd><Seller t={t} p={p} offer={offer} seller={seller} /></dd>
                            </div>
                        }
                    </dl>
                    <p class={Hint}>{t.detail_this_submitted_offer_is_marketplace_wide()}</p>
                </article>
                <div class={Card}>
                    <dl class={Lines}>
                        <div>
                            <dt>{term(t.detail_offer_price())}</dt>
                            <dd>{&price}</dd>
                        </div>
                        <div>
                            <dt>{term(t.detail_quantity_requested())}</dt>
                            <dd>{offer.quantity_requested}</dd>
                        </div>
                        <div class={Total}>
                            <dt>{term(t.detail_offer_price())}</dt>
                            <dd class={Strong}>{&price}</dd>
                        </div>
                    </dl>
                </div>
            </div>
            <ol class={Steps}>
                <li class={Step} data-state={if open { "current" } else { "complete" }} aria-current={open.then_some("step")}>
                    <p class={Strong}>{status_label(t, status)}</p>
                    <p class={Hint}>{t.detail_this_submitted_offer_is_marketplace_wide()}</p>
                </li>
                <li class={Step} data-state="upcoming">
                    <p class={Strong}>{t.detail_submitted_offer_overview()}</p>
                    <p class={Hint}>{t.detail_review_the_details_of_your_submitted()}</p>
                </li>
            </ol>
        </section>
    }
}

/// An offer whose read has not caught up with the write the address follows
/// (`MarketplaceOfferDetailRecoveryPage`): Refresh offer and Back to submitted offers; the page reads
/// itself again in 2 s.
#[component(css = SubmittedOffersPage)]
pub fn SubmittedOfferPreparing(t: SubmittedOffersMsg, refresh: String) -> impl Render {
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.detail_submitted_offer_overview()}</p>
                <h1 class={Title}>{t.detail_route_submitted_offer_preparing()}</h1>
                <p class={Muted}>{t.detail_route_submitted_offer_preparing_description()}</p>
            </div>
        </header>
        <section class={Section} aria-labelledby="offer-recover-title">
            <h2 id="offer-recover-title" class={PartTitle}>{t.recovery_recover_offer()}</h2>
            <div class={Card} role="status">
                <p class={Strong}>{t.detail_route_submitted_offer_preparing()}</p>
                <p class={Muted}>{t.recovery_no_payment_or_sale_changed()}</p>
                <p class={Row}>
                    <a class={Button} href={&refresh}>{t.recovery_refresh_offer()}</a>
                    <a class={(Button, Secondary)} href={url::SubmittedOffers::default()}>
                        {t.detail_back_to_submitted_offers()}
                    </a>
                </p>
            </div>
        </section>
    }
}
