//! The Sell List (Checkout's `CheckoutSellListPage`): the account gate for a guest, what registration
//! did with the guest's list, the latest seller confirmation, the page still catching up with a
//! write, the readiness notices, each line as a card, the bulk bar and Continue to seller checkout,
//! and the sale checkout summary.
//!
//! Continue posts one form (`SellListFormId`); each line's fields belong to it by their `form`
//! attribute, since each card also has its own forms (Remove, the evidence's). A line's offers and
//! terms fold under its card (`<details>`, where marketplace opens a side sheet), so its offer boxes and
//! its listing fields are in the page, and sent, whether the seller opened it or not. No script:
//! the bulk bar shows once an offer is checked (`:has()`; without it, always), Decline selected asks
//! first in a `<dialog>` its button opens (`command="show-modal"`), and Clear selection resets the form.
//! One column on a phone with the expected payout and Continue in a bar at the bottom; the cards
//! two across from 40rem, the summary beside them from 64rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::{ListingEvidence, OfferReview, SellListConfirmation, SellTerms},
    app::url,
    sell_list::{
        Line, LineReadiness, Merged, Pick, ReadinessDetail, ReadinessLabel, Recovery, RecoveryLabel, SellListScreen, Surface,
        support_reference,
    },
    text::{Pilot, SellListMsg},
};

/// Continue to seller checkout's form, which every line's fields belong to.
#[derive(Id, Clone, Copy)]
pub struct SellListFormId;
/// Decline selected's dialog.
#[derive(Id, Clone, Copy)]
pub struct DeclineDialogId;

fn usd() -> Currency {
    Currency::parse("USD").expect("USD")
}

/// Cents in the request's locale, in US dollars (marketplace's sell list writes every amount so).
fn dollars(t: SellListMsg, cents: i64) -> String {
    t.money(Decimal::new(i128::from(cents), 2), usd()).to_string()
}

/// An amount the API sent (`formatMoney`): none is "-", one that is not money as it was sent.
fn amount(t: SellListMsg, amount: Option<&str>) -> String {
    match amount {
        None => "-".to_owned(),
        Some(text) => platform::money::cents(text).map_or_else(|| text.to_owned(), |c| dollars(t, c)),
    }
}

fn cents(amount: Option<&str>) -> i64 {
    amount.and_then(platform::money::cents).unwrap_or(0)
}

fn times(amount: Option<&str>, quantity: u64) -> i64 {
    cents(amount).saturating_mul(i64::try_from(quantity).unwrap_or(i64::MAX))
}

fn percent(t: SellListMsg, bps: i64) -> String {
    t.percent(Decimal::new(i128::from(bps), 4), 2).to_string()
}

/// A shipping allowance: its amount on `basis` cents and its share.
fn allowance(t: SellListMsg, basis: i64, bps: Option<i64>) -> String {
    match bps {
        None => "-".to_owned(),
        Some(bps) => format!("{} ({})", dollars(t, (basis.saturating_mul(bps) + 5_000).div_euclid(10_000)), percent(t, bps)),
    }
}

/// A change in cents (`formatMoneyDelta`).
fn delta(t: SellListMsg, cents: i64) -> String {
    match cents.signum() {
        0 => t.page_no_change().to_owned(),
        1 => format!("+{}", dollars(t, cents)),
        _ => format!("-{}", dollars(t, -cents)),
    }
}

fn buyer(t: SellListMsg, name: Option<&str>) -> String {
    name.map(str::trim).filter(|n| !n.is_empty()).map_or_else(|| t.page_buyer().to_owned(), str::to_owned)
}

fn coverage(t: SellListMsg, code: &str) -> &'static str {
    match code {
        "min-photo-count-unmet" => t.coverage_min_photo_count_unmet(),
        "slot-view-mismatch" => t.coverage_slot_view_mismatch(),
        "slot-dimensions-too-small" => t.coverage_slot_dimensions_too_small(),
        "slot-expired" => t.coverage_slot_expired(),
        "duplicate-source" => t.coverage_duplicate_source(),
        _ => t.coverage_slot_missing(),
    }
}

fn view_label(t: SellListMsg, view: Option<&str>) -> &'static str {
    match view {
        Some("front") => t.page_evidence_view_front(),
        Some("back") => t.page_evidence_view_back(),
        Some("slab") => t.page_evidence_view_slab(),
        Some("condition") => t.page_evidence_view_condition(),
        _ => t.page_evidence_photo(),
    }
}

fn label(t: SellListMsg, label: ReadinessLabel) -> &'static str {
    match label {
        ReadinessLabel::Ready => t.page_ready(),
        ReadinessLabel::EvidenceNeedsAction => t.page_evidence_needs_action(),
        ReadinessLabel::NeedsRefresh => t.page_needs_refresh(),
        ReadinessLabel::NeedsAction => t.page_needs_action(),
    }
}

fn detail(t: SellListMsg, readiness: &LineReadiness) -> String {
    match &readiness.detail {
        ReadinessDetail::EvidenceUnavailable => t.page_evidence_unavailable().to_owned(),
        ReadinessDetail::Unmet(codes) => codes.iter().map(|c| coverage(t, c)).collect::<Vec<_>>().join(" "),
        ReadinessDetail::StandardPreview => t.page_public_standard_offer_preview_ready_detail().to_owned(),
        ReadinessDetail::SelectedOffer => t.page_selected_offer_ready_detail().to_owned(),
        ReadinessDetail::SmartMatch(n) => t.page_smart_match_ready_detail(*n as u64).to_string(),
        ReadinessDetail::Fallback => t.page_fallback_listing_ready_detail().to_owned(),
        ReadinessDetail::FallbackForm => t.page_fallback_listing_form_ready_detail().to_owned(),
        ReadinessDetail::OfferTermsNeedRefresh => t.page_offer_terms_need_refresh().to_owned(),
        ReadinessDetail::ChooseSaleAction => t.page_choose_sale_action_before_checkout().to_owned(),
        ReadinessDetail::Message(message) => message.clone(),
    }
}

/// A seller confirmation's status (`formatStatus`); an unknown one with its words capitalized.
pub(crate) fn status(t: SellListMsg, status: &str) -> String {
    let status = if status.trim().is_empty() { "not-attempted" } else { status.trim() };
    let known = match status {
        "accepted-offer" => t.page_latest_confirmation_status_accepted_offer(),
        "accepted-smart-match" => t.page_latest_confirmation_status_accepted_smart_match(),
        "completed" => t.page_latest_confirmation_status_completed(),
        "failed" => t.page_latest_confirmation_status_failed(),
        "handoff-recorded" => t.page_latest_confirmation_status_handoff_recorded(),
        "kept-in-sell-list" => t.page_latest_confirmation_status_kept_in_sell_list(),
        "mixed" => t.page_latest_confirmation_status_mixed(),
        "not-attempted" => t.page_latest_confirmation_status_not_attempted(),
        "partial" => t.page_latest_confirmation_status_partial(),
        "pending-downstream" => t.page_latest_confirmation_status_pending_downstream(),
        "published-listing" => t.page_latest_confirmation_status_published_listing(),
        "skipped" => t.page_latest_confirmation_status_skipped(),
        _ => "",
    };
    if !known.is_empty() {
        return known.to_owned();
    }
    status
        .split('-')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `sideEffectTone`.
fn tone(status: &str) -> &'static str {
    match status {
        "handoff-recorded" => "success",
        "pending-downstream" => "warning",
        "failed" => "danger",
        _ => "accent",
    }
}

fn date_time(t: SellListMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// The page.
#[component(css)]
pub fn SellListPage<'a>(t: SellListMsg, p: Pilot, screen: &'a SellListScreen) -> impl Render {
    let desk = screen.surface == Surface::DeskOffers;
    let back = format!("{}?registrationReturn=seller-checkout", url::SellList::PATH);
    let register = crate::register::href(&back);
    let sign_in = crate::app::sign_in_back_to(&back).map(|u| u.to_string()).unwrap_or_default();
    let continue_label = if screen.account { t.page_continue_to_seller_checkout() } else { t.page_create_account_to_continue() };
    let _ = p;
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{if desk { t.page_seller_desk() } else { t.page_checkout() }}</p>
                <h1 class={Title}>{if desk { t.page_offers_and_sell_list() } else { t.page_sell_list() }}</h1>
                <p class={Muted}>{t.page_simple_review_description()}</p>
            </div>
        </header>
        <div class={Notices}>
            if !screen.account {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.page_account_gate_title()}</p>
                    <p>{t.page_account_gate_description()}</p>
                    <p class={Row}>
                        <a class={Button} href={&register}>{t.page_create_account()}</a>
                        <a class={(Button, Secondary)} href={&sign_in}>{t.page_sign_in()}</a>
                    </p>
                </div>
            }
            if screen.registration {
                if screen.merged == Some(Merged::Failed) {
                    <div class={Banner} data-tone="warning">
                        <p class={Strong}>{t.page_registration_return_merge_issue_title()}</p>
                        <p>{t.route_sell_list_request_failed()}</p>
                    </div>
                } else if let Some(Merged::Lines(count)) = screen.merged.filter(|m| matches!(m, Merged::Lines(n) if *n > 0)) {
                    <div class={Banner} data-tone="success">
                        <p class={Strong}>{t.page_registration_return_merged_title()}</p>
                        <p>{t.page_registration_return_merged_description(count)}</p>
                    </div>
                } else {
                    <div class={Banner} data-tone="info">
                        <p class={Strong}>{t.page_registration_return_review_title()}</p>
                        <p>{t.page_registration_return_review_description()}</p>
                    </div>
                }
            }
            if let Some(message) = &screen.notice {
                <div class={Banner} data-tone="warning" role="alert" tabindex="-1" autofocus>
                    <p class={Strong}>{t.page_checkout_issue()}</p>
                    <p>{message}</p>
                </div>
            }
        </div>
        if let Some(confirmation) = &screen.confirmation {
            <ConfirmationPanel t={t} confirmation={confirmation} />
        }
        if matches!(screen.recovery, Some(Recovery::Pending | Recovery::ConfirmationPending)) {
            <div class={(Card, Tinted)} role="status">
                <p class={Badges}><span class={Badge}>{t.page_sell_list_update_pending()}</span></p>
                <p class={Strong}>{t.page_sell_list_update_pending_title()}</p>
                <p class={Muted}>
                    {if screen.recovery == Some(Recovery::ConfirmationPending) {
                        t.route_seller_confirmation_pending_fresh_write()
                    } else {
                        t.route_sell_list_pending_fresh_write()
                    }}
                </p>
                <p class={Row}>
                    <a class={(Button, Secondary)} href={screen.surface.path()}>{t.page_refresh_sell_list()}</a>
                    if !screen.lines.is_empty() {
                        <button class={Button} type="button" disabled>{continue_label}</button>
                    }
                </p>
            </div>
        } else if screen.lines.is_empty() && screen.recovery == Some(Recovery::Missing) {
            <div class={(Card, Empty)}>
                <p class={Strong}>{t.page_sell_list_update_missing_title()}</p>
                <p class={Muted}>{t.route_sell_list_missing_after_fresh_write()}</p>
                <p class={Row}>
                    <a class={(Button, Secondary)} href={screen.surface.path()}>{t.page_refresh_sell_list()}</a>
                    <a class={Button} href={url::Search::PATH}>{t.page_browse_products()}</a>
                </p>
            </div>
        } else if screen.lines.is_empty() {
            <div class={(Card, Empty)}>
                <p class={Strong}>{t.page_your_sell_list_is_empty()}</p>
                <p class={Muted}>{t.page_add_selected_offers_or_products()}</p>
                <p class={Row}><a class={Button} href={url::Search::PATH}>{t.page_browse_products()}</a></p>
            </div>
        } else {
            <Review t={t} screen={screen} continue_label={continue_label} />
        }
    }
}

/// The lines, the readiness and the summary.
#[component(css = SellListPage)]
fn Review<'a>(t: SellListMsg, screen: &'a SellListScreen, continue_label: &'a str) -> impl Render {
    let totals = screen.totals();
    let blocked = screen.blocked();
    let (recovery_href, recovery) = screen.recovery();
    let recovery_label = match recovery {
        RecoveryLabel::SetUpPayouts => t.page_set_up_payouts(),
        RecoveryLabel::Resolve => t.page_resolve_items(),
        RecoveryLabel::KeepSelling => t.page_keep_selling(),
    };
    let can = screen.can_continue();
    let here = screen.surface.path();
    let any_offer = screen.lines.iter().any(|l| !l.picks.is_empty());
    let payout_value = if !screen.account {
        t.page_sign_in_required()
    } else if screen.payout_ready() {
        t.page_ready()
    } else {
        t.page_setup_required()
    };
    let readiness_summary = if blocked > 0 {
        t.page_readiness_needs_action(blocked as u64).to_string()
    } else {
        t.page_readiness_ready((screen.lines.len() - blocked) as u64).to_string()
    };
    html! {
        <form id={SellListFormId} class={Hidden} method="post" action={here}></form>
        <div class={Layout}>
            <div class={Main}>
                <details class={(Card, Folded)}>
                    <summary class={Strong}>
                        {t.page_sale_checkout_summary()} " · " {dollars(t, totals.payout)}
                    </summary>
                    <Summary
                        t={t}
                        totals={&totals}
                        lines={screen.lines.len()}
                        payout={payout_value}
                        readiness={&readiness_summary}
                    />
                </details>
                <div class={Banner} data-tone={if blocked > 0 { "warning" } else { "success" }}>
                    if blocked > 0 {
                        <p class={Strong}>{t.page_some_items_need_action()}</p>
                        <p>{t.page_resolve_before_seller_checkout(blocked as u64)}</p>
                    } else {
                        <p class={Strong}>{t.page_ready_for_seller_checkout()}</p>
                        <p>{t.page_ready_for_seller_checkout_description()}</p>
                    }
                </div>
                if screen.account && !screen.payout_ready() {
                    <div class={(Banner, Spread)} data-tone="warning">
                        <div class={Tight}>
                            <p class={Strong}>{t.page_payout_setup_required()}</p>
                            if let Some(payout) = &screen.payout {
                                <p>
                                    {t.page_payout_setup_required_description(
                                        &if payout.missing_requirements.is_empty() {
                                            payout.status.clone()
                                        } else {
                                            payout.missing_requirements.join(", ")
                                        },
                                    )}
                                </p>
                            } else {
                                <p>{t.page_payout_readiness_unavailable_description()}</p>
                            }
                        </div>
                        <a class={(Button, Secondary)} href={screen.payout_setup_href()}>{t.page_set_up_payouts()}</a>
                    </div>
                }
                <section class={Section} aria-labelledby="sell-list-items-title">
                    <h2 id="sell-list-items-title" class={PartTitle}>{t.page_review_items()}</h2>
                    <ul class={Cards}>
                        for line in &screen.lines {
                            <LineCard t={t} line={line} surface={screen.surface} selectable={screen.account} />
                        }
                    </ul>
                </section>
                <div class={(Card, Tinted)}>
                    <p class={Strong}>{t.page_seller_checkout_readiness()}</p>
                    <p class={Hint}>{t.page_seller_checkout_readiness_description()}</p>
                    <p class={Row}>
                        <button
                            class={Button}
                            type="submit"
                            form={SellListFormId}
                            name="intent"
                            value="review-sell-list-checkout"
                            disabled={!can}
                        >
                            {continue_label}
                        </button>
                        <a class={(Button, Secondary)} href={&recovery_href}>{recovery_label}</a>
                    </p>
                </div>
                <div class={Dock}>
                    if any_offer && screen.account {
                        <div class={Bulk}>
                            <p class={Row}>
                                <button
                                    class={Button}
                                    type="submit"
                                    form={SellListFormId}
                                    name="intent"
                                    value="review-sell-list-checkout"
                                    formnovalidate
                                    disabled={!can}
                                >
                                    {t.page_accept_selected()}
                                </button>
                                <button
                                    class={(Button, Secondary)}
                                    type="button"
                                    command="show-modal"
                                    commandfor={DeclineDialogId}
                                >
                                    {t.page_decline_selected()}
                                </button>
                                <button class={(Button, Secondary)} type="reset" form={SellListFormId}>
                                    {t.page_clear_selection()}
                                </button>
                            </p>
                            <dialog id={DeclineDialogId} class={Dialog} aria-labelledby="decline-title">
                                <h2 id="decline-title" class={PartTitle}>{t.page_decline_selected()}</h2>
                                <p class={Row}>
                                    <button
                                        class={(Button, Secondary)}
                                        type="button"
                                        command="close"
                                        commandfor={DeclineDialogId}
                                    >
                                        {t.page_clear_selection()}
                                    </button>
                                    <button
                                        class={Button}
                                        type="submit"
                                        form={SellListFormId}
                                        name="intent"
                                        value="decline-sell-list-offers"
                                        formnovalidate
                                    >
                                        {t.page_decline_selected()}
                                    </button>
                                </p>
                            </dialog>
                        </div>
                    }
                    <div class={Cta}>
                        <p class={Total}>
                            <span class={Big}>{dollars(t, totals.payout)}</span>
                            <span class={Hint}>{t.page_expected_payout_before_checkout()}</span>
                        </p>
                        <p class={Row}>
                            <button
                                class={Button}
                                type="submit"
                                form={SellListFormId}
                                name="intent"
                                value="review-sell-list-checkout"
                                disabled={!can}
                            >
                                {continue_label}
                            </button>
                            <a class={(Button, Secondary)} href={&recovery_href}>{recovery_label}</a>
                        </p>
                    </div>
                </div>
            </div>
            <aside class={Aside} aria-label={t.page_sale_checkout_summary()}>
                <div class={Card}>
                    <h2 class={PartTitle}>{t.page_sale_checkout_summary()}</h2>
                    <Summary
                        t={t}
                        totals={&totals}
                        lines={screen.lines.len()}
                        payout={payout_value}
                        readiness={&readiness_summary}
                    />
                </div>
            </aside>
        </div>
    }
}

/// The sale checkout summary (marketplace's `PriceBreakdown`).
#[component(css = SellListPage)]
fn Summary<'a>(
    t: SellListMsg,
    totals: &'a crate::sell_list::Totals,
    lines: usize,
    payout: &'a str,
    readiness: &'a str,
) -> impl Render {
    html! {
        <dl class={Facts}>
            <div>
                <dt>{t.page_items()}</dt>
                <dd>{totals.quantity}</dd>
            </div>
            <div>
                <dt>{t.page_sell_list_lines()}</dt>
                <dd>{lines}</dd>
            </div>
            <div>
                <dt>{t.page_selected_offer_gross()}</dt>
                <dd>{dollars(t, totals.offer_gross)}</dd>
            </div>
            <div>
                <dt>{t.page_expected_seller_payout()}</dt>
                <dd>{dollars(t, totals.payout)}</dd>
            </div>
            <div>
                <dt>{t.page_future_listing_gross()}</dt>
                <dd>{dollars(t, totals.future_listing_gross)}</dd>
            </div>
            <div>
                <dt>{t.page_estimated_sales_fees()}</dt>
                <dd>{dollars(t, totals.fees)}</dd>
            </div>
            <div>
                <dt>{t.page_payout_readiness()}</dt>
                <dd>{payout}</dd>
            </div>
            <div>
                <dt>{t.page_line_readiness()}</dt>
                <dd>{readiness}</dd>
            </div>
            <div class={Sum}>
                <dt>{t.page_expected_seller_payout()}</dt>
                <dd>{dollars(t, totals.payout)}</dd>
            </div>
        </dl>
        <p class={Hint}>{t.page_no_commitment_until_review()}</p>
    }
}

/// A line's card: what it is, what it needs, Remove, and its offers and terms folded.
#[component(css = SellListPage)]
fn LineCard<'a>(t: SellListMsg, line: &'a Line, surface: Surface, selectable: bool) -> impl Render {
    let row = &line.row;
    let ready = &line.readiness;
    let best = line.best();
    let offers = line.picks.len();
    let offer_count = match offers {
        0 => t.page_no_ready_matching_offers().to_owned(),
        1 => t.page_offer_count_one(1u64).to_string(),
        n => t.page_offer_count_many(n as u64).to_string(),
    };
    let subtitle = row.item_subtitle.clone().or_else(|| row.product_summary.clone());
    let net = best.map_or(0, |(_, net)| net);
    let best_offer = best.map_or_else(|| "-".to_owned(), |(pick, _)| amount(t, pick.price.as_deref()));
    let terms = line.offer_review.as_ref().and_then(|r| r.terms.as_ref());
    let comparison = line.offer_review.as_ref().and_then(|r| r.comparison.as_ref()).and_then(|c| match c.status.as_str() {
        "changed" => Some(t.page_terms_comparison_changed_inline()),
        "final-unavailable" => Some(t.page_terms_comparison_final_unavailable_inline()),
        _ => None,
    });
    let review_label = t.page_review_item_offers_and_terms(&row.item_title).to_string();
    html! {
        <li class={Entry} data-ready={if ready.ready { "true" } else { "false" }}>
            <div class={Top}>
                if let Some(src) = line.thumbnail() {
                    <img class={Thumb} src={src} alt={&row.item_title} width="96" height="96" loading="lazy" decoding="async">
                }
                <div class={Tight}>
                    <p class={Badges}>
                        <span class={Badge} data-tone={if row.is_offer() { "success" } else { "info" }}>
                            {if row.is_offer() { t.page_selected_offer() } else { t.page_product_line() }}
                        </span>
                        <span class={Badge} data-tone={if ready.ready { "success" } else { "warning" }}>
                            {label(t, ready.label)}
                        </span>
                        <span class={Badge} data-tone={if offers > 0 { "success" } else { "warning" }}>{offer_count}</span>
                    </p>
                    <h3 class={Strong}>{&row.item_title}</h3>
                    if let Some(subtitle) = &subtitle {
                        <p class={Hint}>{subtitle}</p>
                    }
                </div>
            </div>
            <p class={Big}>{t.page_estimated_net(&dollars(t, net))}</p>
            <p class={Hint}>{t.page_card_summary(row.quantity, &best_offer)}</p>
            <p class={Muted}>{detail(t, ready)}</p>
            if let Some(comparison) = comparison {
                <p class={Muted}>{comparison}</p>
            }
            if row.is_offer() {
                <dl class={Facts}>
                    <div>
                        <dt>{t.page_buyer()}</dt>
                        <dd>{buyer(t, row.buyer_display_name.as_deref())}</dd>
                    </div>
                    <div>
                        <dt>{t.page_quantity()}</dt>
                        <dd>{row.quantity}</dd>
                    </div>
                    <div>
                        <dt>{t.page_offer()}</dt>
                        <dd>{amount(t, row.offer_price_amount.as_deref())}</dd>
                    </div>
                    <div>
                        <dt>{t.page_seller_net()}</dt>
                        <dd>{amount(t, terms.map(|t| t.seller_net_unit_amount.as_str()))}</dd>
                    </div>
                </dl>
            } else {
                <dl class={Facts}>
                    <div>
                        <dt>{t.page_quantity()}</dt>
                        <dd>{row.quantity}</dd>
                    </div>
                    <div>
                        <dt>{t.page_matching_offers()}</dt>
                        <dd>
                            {if line.matched() > 0 {
                                t.page_matching_offer_quantity(line.matched()).to_string()
                            } else {
                                t.page_no_ready_matching_offers().to_owned()
                            }}
                        </dd>
                    </div>
                    <div>
                        <dt>{t.page_minimum_listing_price()}</dt>
                        <dd>{amount(t, row.minimum_listing_price_amount.as_deref())}</dd>
                    </div>
                    <div>
                        <dt>{t.page_inventory()}</dt>
                        <dd>
                            {match line.default_inventory() {
                                Some(i) => t.page_inventory_option_label(&i.storage_location_name, &i.ship_from_code, i.available_quantity).to_string(),
                                None => t.page_inventory_required().to_owned(),
                            }}
                        </dd>
                    </div>
                </dl>
            }
            <div class={Row}>
                <form method="post" action={surface.path()}>
                    <input type="hidden" name="intent" value="remove-sell-list-line">
                    <input type="hidden" name="lineId" value={&row.line_id}>
                    <button class={(Button, Secondary)} type="submit">{t.page_remove()}</button>
                </form>
                if !ready.ready && row.is_offer() {
                    <a class={(Button, Secondary)} href={line.setup_href()}>{t.page_create_matching_listing()}</a>
                }
                if !ready.ready && !row.is_offer() && offers == 0 {
                    <a class={(Button, Secondary)} href={line.setup_href()}>{t.page_create_listing()}</a>
                    <a class={(Button, Ghost)} href={line.inventory_href()}>{t.page_add_inventory()}</a>
                }
            </div>
            if let Some(fingerprint) = terms.and_then(|t| t.fee_quote_fingerprint.as_deref()) {
                <input
                    type="hidden"
                    form={SellListFormId}
                    name={format!("offerFeeQuoteFingerprint:{}", row.line_id)}
                    value={fingerprint}
                >
            }
            for o in line.product_review.iter().flat_map(|r| &r.offers) {
                <input
                    type="hidden"
                    form={SellListFormId}
                    name={format!("productOfferId:{}", row.line_id)}
                    value={&o.offer.offer_id}
                >
                <input
                    type="hidden"
                    form={SellListFormId}
                    name={format!("productOfferFeeQuoteFingerprint:{}:{}", row.line_id, o.offer.offer_id)}
                    value={o.terms.fee_quote_fingerprint.as_deref().unwrap_or_default()}
                >
            }
            <details class={More}>
                <summary class={(Button, Secondary)} aria-label={&review_label}>{t.page_review_offers_and_terms()}</summary>
                <div class={Stack}>
                    <p class={Hint}>{t.page_drawer_description()}</p>
                    if !line.picks.is_empty() {
                        <ul class={Picks}>
                            for pick in &line.picks {
                                <PickOption t={t} pick={pick} selectable={selectable} />
                            }
                        </ul>
                    }
                    if let Some(review) = &line.offer_review {
                        <OfferTerms t={t} review={review} quantity={row.quantity} />
                        if let Some(evidence) = &review.evidence {
                            <Evidence t={t} evidence={evidence.as_ref()} surface={surface} />
                        }
                    }
                    if !row.is_offer() {
                        <ProductAction t={t} line={line} surface={surface} />
                    }
                </div>
            </details>
        </li>
    }
}

/// An offer to pick for Accept selected or Decline selected; a guest's is only shown, since
/// accepting and declining are an account's.
#[component(css = SellListPage)]
fn PickOption<'a>(t: SellListMsg, pick: &'a Pick, selectable: bool) -> impl Render {
    let who = buyer(t, pick.buyer.as_deref());
    html! {
        <li class={OfferPick}>
            if selectable {
                <label class={Choose}>
                    <input type="checkbox" form={SellListFormId} name="bulkOfferId" value={&pick.offer_id}>
                    <span class={Tight}>
                        <span class={Strong}>{t.page_select_offer(&who)}</span>
                        <span class={Hint}>{t.page_offer_quantity(pick.quantity)}</span>
                    </span>
                </label>
            } else {
                <p class={Tight}>
                    <span class={Strong}>{&who}</span>
                    <span class={Hint}>{t.page_offer_quantity(pick.quantity)}</span>
                </p>
            }
            <dl class={Facts}>
                <div>
                    <dt>{t.page_offer()}</dt>
                    <dd>{amount(t, pick.price.as_deref())}</dd>
                </div>
                <div>
                    <dt>{t.page_marketplace_fee()}</dt>
                    <dd>{amount(t, pick.fee.as_deref())}</dd>
                </div>
                <div>
                    <dt>{t.page_seller_net()}</dt>
                    <dd>{amount(t, pick.net.as_deref())}</dd>
                </div>
                <div>
                    <dt>{t.page_shipping_allowance()}</dt>
                    <dd>{allowance(t, cents(pick.basis.as_deref()), pick.allowance_bps)}</dd>
                </div>
            </dl>
        </li>
    }
}

/// A selected offer's terms: the standard terms beside the seller's, and the estimated payout's
/// facts (marketplace's `TermsComparison` and `SellListTermsReferenceInfo`).
#[component(css = SellListPage)]
fn OfferTerms<'a>(t: SellListMsg, review: &'a OfferReview, quantity: u64) -> impl Render {
    let standard = review.comparison.as_ref().and_then(|c| c.standard_preview.as_ref());
    let shown = review.terms.as_ref().or(standard);
    html! {
        if let Some(terms) = shown {
            <div class={Pair}>
                <div class={(Card, Tinted)}>
                    <p class={Strong}>{t.page_standard_terms()}</p>
                    <TermsFacts t={t} terms={standard.unwrap_or(terms)} />
                </div>
                <div class={(Card, Tinted)}>
                    <p class={Strong}>{t.page_seller_terms()}</p>
                    if let Some(final_terms) = &review.terms {
                        <TermsFacts t={t} terms={final_terms} />
                    } else {
                        <p class={Hint}>{t.page_refresh_needed()}</p>
                    }
                </div>
            </div>
            <Payout t={t} review={review} terms={terms} quantity={quantity} />
        }
    }
}

#[component(css = SellListPage)]
fn TermsFacts<'a>(t: SellListMsg, terms: &'a SellTerms) -> impl Render {
    html! {
        <dl class={Facts}>
            <div>
                <dt>{t.page_marketplace_fee()}</dt>
                <dd>{amount(t, Some(&terms.marketplace_sales_fee_unit_amount))}</dd>
            </div>
            <div>
                <dt>{t.page_seller_net()}</dt>
                <dd>{amount(t, Some(&terms.seller_net_unit_amount))}</dd>
            </div>
            <div>
                <dt>{t.page_shipping_allowance()}</dt>
                <dd>{allowance(t, cents(Some(&terms.basis_amount)), terms.shipping_allowance_percentage_bps)}</dd>
            </div>
        </dl>
    }
}

/// The estimated payout's facts for the line's quantity, and the comparison with the standard
/// estimate after registration.
#[component(css = SellListPage)]
fn Payout<'a>(t: SellListMsg, review: &'a OfferReview, terms: &'a SellTerms, quantity: u64) -> impl Render {
    let source = terms.source_label.clone().unwrap_or_else(|| {
        if terms.agreement_id.is_some() { t.page_seller_specific_terms() } else { t.page_standard_terms() }.to_owned()
    });
    let basis = times(Some(&terms.basis_amount), quantity);
    let quoted = terms.resolved_at.as_deref().map_or_else(|| t.page_just_now().to_owned(), |at| date_time(t, at));
    let comparison = review.comparison.as_ref();
    let standard = comparison.and_then(|c| c.standard_preview.as_ref());
    let final_terms = review.terms.as_ref();
    let net_delta = match (final_terms, standard) {
        (Some(f), Some(s)) => times(Some(&f.seller_net_unit_amount), quantity) - times(Some(&s.seller_net_unit_amount), quantity),
        _ => 0,
    };
    let line = comparison.map(|c| match c.status.as_str() {
        "same" => t.page_terms_comparison_same_line(),
        "standard-preview-unavailable" => t.page_terms_comparison_standard_unavailable_line(),
        "final-unavailable" => t.page_terms_comparison_final_unavailable_line(),
        _ if net_delta < 0 => t.page_terms_comparison_worse_line(),
        _ if net_delta > 0 => t.page_terms_comparison_better_line(),
        _ => t.page_terms_comparison_changed_line(),
    });
    html! {
        <section class={(Card, Tinted)} aria-label={t.page_estimated_payout_aria()}>
            <p class={Strong}>{t.page_estimated_payout()}</p>
            <p class={Hint}>{t.page_estimated_payout_summary(&source)}</p>
            <p class={Hint}>{t.page_estimated_payout_facts()}</p>
            <dl class={Facts}>
                <div>
                    <dt>{t.page_sales_fee()}</dt>
                    <dd>{dollars(t, times(Some(&terms.marketplace_sales_fee_unit_amount), quantity))}</dd>
                </div>
                if terms.shipping_allowance_percentage_bps.is_some() {
                    <div>
                        <dt>{t.page_shipping_allowance()}</dt>
                        <dd>{allowance(t, basis, terms.shipping_allowance_percentage_bps)}</dd>
                    </div>
                }
                <div>
                    <dt>{t.page_terms_source()}</dt>
                    <dd>{&source}</dd>
                </div>
                <div>
                    <dt>{t.page_quote_time()}</dt>
                    <dd>{quoted}</dd>
                </div>
            </dl>
            if comparison.is_some() {
                <p class={Hint}>{t.page_standard_estimate_comparison()}</p>
                <dl class={Facts}>
                    <div>
                        <dt>{t.page_standard_estimate()}</dt>
                        <dd>
                            {standard.map_or_else(
                                || t.page_unavailable().to_owned(),
                                |s| dollars(t, times(Some(&s.seller_net_unit_amount), quantity)),
                            )}
                        </dd>
                    </div>
                    <div>
                        <dt>{t.page_final_registered_payout()}</dt>
                        <dd>
                            {final_terms.map_or_else(
                                || t.page_refresh_needed().to_owned(),
                                |f| dollars(t, times(Some(&f.seller_net_unit_amount), quantity)),
                            )}
                        </dd>
                    </div>
                    if let (Some(f), Some(s)) = (final_terms, standard) {
                        <div>
                            <dt>{t.page_payout_change()}</dt>
                            <dd>{delta(t, net_delta)}</dd>
                        </div>
                        <div>
                            <dt>{t.page_sales_fee_change()}</dt>
                            <dd>
                                {delta(t, times(Some(&f.marketplace_sales_fee_unit_amount), quantity) - times(Some(&s.marketplace_sales_fee_unit_amount), quantity))}
                            </dd>
                        </div>
                        <div>
                            <dt>{t.page_shipping_allowance_change()}</dt>
                            <dd>
                                {match f.shipping_allowance_percentage_bps.unwrap_or(0) - s.shipping_allowance_percentage_bps.unwrap_or(0) {
                                    0 => t.page_no_change().to_owned(),
                                    d if d > 0 => format!("+{}", percent(t, d)),
                                    d => format!("-{}", percent(t, -d)),
                                }}
                            </dd>
                        </div>
                        if comparison.is_some_and(|c| c.changed_fields.iter().any(|f| f == "terms-source")) {
                            <div>
                                <dt>{t.page_final_terms_source()}</dt>
                                <dd>{&source}</dd>
                            </div>
                        }
                    }
                </dl>
            }
            if terms.standard() {
                <p class={Hint}>{t.page_public_standard_terms_line1()}</p>
                <p class={Hint}>{t.page_public_standard_terms_line2()}</p>
            } else {
                <p class={Hint}>{t.page_registered_terms_line1()}</p>
            }
            if let Some(line) = line {
                <p class={Hint}>{line}</p>
            }
        </section>
    }
}

/// A listing's required evidence: what it misses, its photos (each unmatched one with Classify),
/// and Add photo while it is not complete (`SellListOfferEvidenceReview`).
#[component(css = SellListPage)]
fn Evidence<'a>(t: SellListMsg, evidence: Option<&'a ListingEvidence>, surface: Surface) -> impl Render {
    html! {
        if let Some(e) = evidence {
            <EvidenceReview t={t} e={e} surface={surface} />
        } else {
            <p class={Hint}>{t.page_evidence_unavailable()}</p>
        }
    }
}

#[component(css = SellListPage)]
fn EvidenceReview<'a>(t: SellListMsg, e: &'a ListingEvidence, surface: Surface) -> impl Render {
    let matched: Vec<&str> = e.coverage.slots.iter().filter_map(|s| s.matched_photo_id.as_deref()).collect();
    let slots = &e.requirements.required_slots;
    html! {
        <section class={(Card, Tinted)} aria-label={t.page_evidence_required()}>
            <p class={Row}>
                <span class={Strong}>{t.page_evidence_required()}</span>
                <span class={Badge} data-tone={if e.coverage.complete { "success" } else { "warning" }}>
                    {if e.coverage.complete { t.page_evidence_complete() } else { t.page_evidence_needs_action() }}
                </span>
            </p>
            <p class={Hint}>{t.page_evidence_listing()} ": " {&e.listing_id}</p>
            for code in &e.coverage.unmet_codes {
                <p class={Hint}>{coverage(t, code)}</p>
            }
            <ul class={Photos}>
                for photo in e.evidence.iter().filter(|p| p.status == "active") {
                    <li class={Tight}>
                        if let Some(src) = photo.thumbnail() {
                            <img
                                class={Thumb}
                                src={src}
                                alt={photo.alt_text.as_deref().unwrap_or(view_label(t, photo.view_kind.as_deref()))}
                                width="96"
                                height="96"
                                loading="lazy"
                                decoding="async"
                            >
                        }
                        <span class={Hint}>{view_label(t, photo.view_kind.as_deref())}</span>
                        if !matched.contains(&photo.photo_id.as_str()) && !slots.is_empty() {
                            <form class={Tight} method="post" action={surface.path()}>
                                <input type="hidden" name="intent" value="classify-listing-evidence">
                                <input type="hidden" name="listingId" value={&e.listing_id}>
                                <input type="hidden" name="photoId" value={&photo.photo_id}>
                                <label class={Field}>
                                    <span class={Hint}>{t.page_evidence_classify()}</span>
                                    <select name="classification">
                                        for slot in slots {
                                            <option value={format!("{}::{}", slot.slot_id, slot.view_kind)}>
                                                {view_label(t, Some(&slot.view_kind))}
                                            </option>
                                        }
                                    </select>
                                </label>
                                <button class={(Button, Secondary)} type="submit">{t.page_evidence_classify_action()}</button>
                            </form>
                        }
                    </li>
                }
            </ul>
            if !e.coverage.complete {
                <form class={Tight} method="post" action={url::SellListEvidence} enctype="multipart/form-data">
                    <input type="hidden" name="surface" value={surface.key()}>
                    <input type="hidden" name="listingId" value={&e.listing_id}>
                    <label class={Field}>
                        <span class={Strong}>{t.page_evidence_add()}</span>
                        <span class={Hint}>{t.page_evidence_photo_description()}</span>
                        <input type="file" name="listingPhoto" accept="image/jpeg,image/png,image/webp" required>
                    </label>
                    <button class={(Button, Secondary)} type="submit">{t.page_evidence_add_action()}</button>
                </form>
            }
        </section>
    }
}

/// A product line's pre-checkout action: its Smart Match offers, each one's evidence, and what the
/// rest of the quantity does, with a listing's inventory, price and currency. The listing's price
/// and currency are required while a listing is the default, as marketplace's page requires them
/// whenever there is inventory; Keep in Sell List then needs them too until a script or the
/// browser can make a field required for one choice (todd-skelton/corten#269).
#[component(css = SellListPage)]
fn ProductAction<'a>(t: SellListMsg, line: &'a Line, surface: Surface) -> impl Render {
    let row = &line.row;
    let inventory = line.default_inventory();
    let fallback = line.fallback_default();
    let required = fallback == "create-listing";
    let id = &row.line_id;
    html! {
        <section class={(Card, Tinted)} aria-label={t.page_pre_checkout_action()}>
            <p class={Strong}>{t.page_pre_checkout_action()}</p>
            for o in line.product_review.iter().flat_map(|r| &r.offers) {
                <div class={Tight}>
                    <p class={Row}>
                        <span class={Badge} data-tone="success">
                            {t.page_use_smart_match_offer(&buyer(t, o.offer.buyer_display_name.as_deref()))}
                        </span>
                        <span class={Hint}>
                            {t.page_use_smart_match_offer_description(o.offer.quantity_requested, &amount(t, Some(&o.terms.seller_net_unit_amount)))}
                        </span>
                    </p>
                    if let Some(evidence) = &o.evidence {
                        <Evidence t={t} evidence={evidence.as_ref()} surface={surface} />
                    }
                </div>
            }
            if line.picks.is_empty() {
                <p class={Hint}>{t.page_no_smart_match_offers_available()}</p>
            }
            <div class={Fields}>
                <label class={Field}>
                    <span class={Hint}>{t.page_remaining_quantity_action()}</span>
                    <select form={SellListFormId} name={format!("fallbackMode:{id}")}>
                        <option value="none" selected={fallback == "none"}>
                            {if line.matched() > 0 { t.page_keep_remaining_in_sell_list() } else { t.page_keep_in_sell_list() }}
                        </option>
                        <option value="create-listing" selected={fallback == "create-listing"} disabled={inventory.is_none()}>
                            {t.page_create_listing_for_remaining()}
                        </option>
                    </select>
                </label>
                <label class={Field}>
                    <span class={Hint}>{t.page_ship_from_inventory()}</span>
                    <select form={SellListFormId} name={format!("inventoryItemId:{id}")}>
                        if inventory.is_none() {
                            <option value="">{t.page_choose_inventory()}</option>
                        }
                        for item in &line.inventory {
                            <option value={&item.item_id} selected={inventory.is_some_and(|i| i.item_id == item.item_id)}>
                                {t.page_inventory_option_label(&item.storage_location_name, &item.ship_from_code, item.available_quantity)}
                            </option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span class={Hint}>{t.page_listing_price()}</span>
                    <input
                        form={SellListFormId}
                        name={format!("priceAmount:{id}")}
                        inputmode="decimal"
                        value={row.minimum_listing_price_amount.as_deref().unwrap_or_default()}
                        required={required}
                    >
                </label>
                <label class={Field}>
                    <span class={Hint}>{t.page_listing_price_currency_code()}</span>
                    <input
                        form={SellListFormId}
                        name={format!("priceCurrencyCode:{id}")}
                        placeholder={t.page_listing_price_currency_code_placeholder()}
                        minlength="3"
                        maxlength="3"
                        pattern="[A-Za-z]{3}"
                        autocapitalize="characters"
                        required={required}
                    >
                </label>
                <input
                    type="hidden"
                    form={SellListFormId}
                    name={format!("quantityCap:{id}")}
                    value={line.quantity_cap().to_string()}
                >
            </div>
        </section>
    }
}

/// The latest seller confirmation (`LatestSellListConfirmationPanel`).
#[component(css = SellListPage)]
fn ConfirmationPanel<'a>(t: SellListMsg, confirmation: &'a SellListConfirmation) -> impl Render {
    let summary = &confirmation.handoff_summary;
    let effects = [
        ("sale", t.page_latest_confirmation_side_effect_sale()),
        ("accountHistory", t.page_latest_confirmation_side_effect_account_history()),
        ("label", t.page_latest_confirmation_side_effect_label()),
        ("payout", t.page_latest_confirmation_side_effect_payout()),
        ("settlement", t.page_latest_confirmation_side_effect_settlement()),
        ("notification", t.page_latest_confirmation_side_effect_notification()),
    ];
    let pending = summary.side_effects.values().any(|s| s == "pending-downstream");
    html! {
        <section class={Section} aria-labelledby="sell-list-confirmation-title">
            <h2 id="sell-list-confirmation-title" class={PartTitle}>{t.page_latest_confirmation_title()}</h2>
            <div class={(Card, Tinted)}>
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.page_latest_confirmation_notice_title()}</p>
                    <p>{t.page_latest_confirmation_notice_description()}</p>
                </div>
                <dl class={Metrics}>
                    <div>
                        <dt>{t.page_latest_confirmation_reference()}</dt>
                        <dd class={Strong}>{support_reference(&confirmation.confirmation_id)}</dd>
                    </div>
                    <div>
                        <dt>{t.page_latest_confirmation_recorded()}</dt>
                        <dd>{date_time(t, &confirmation.confirmed_at)}</dd>
                    </div>
                    <div>
                        <dt>{t.page_latest_confirmation_accepted_offers()}</dt>
                        <dd class={Strong}>{summary.accepted_offer_count}</dd>
                    </div>
                    <div>
                        <dt>{t.page_latest_confirmation_listings_published()}</dt>
                        <dd class={Strong}>{summary.published_listing_count}</dd>
                    </div>
                </dl>
                <ul class={Effects}>
                    for (key, name) in effects {
                        <li class={Row}>
                            <span class={Strong}>{name}</span>
                            <span
                                class={Badge}
                                data-tone={tone(summary.side_effects.get(key).map_or("not-attempted", String::as_str))}
                            >
                                {status(t, summary.side_effects.get(key).map_or("not-attempted", String::as_str))}
                            </span>
                        </li>
                    }
                </ul>
                if !summary.line_outcomes.is_empty() {
                    <p class={Strong}>{t.page_latest_confirmation_line_outcomes()}</p>
                    <ul class={Cards}>
                        for outcome in &summary.line_outcomes {
                            <li class={Card}>
                                <p class={Row}>
                                    <span
                                        class={Badge}
                                        data-tone={tone(if outcome.status == "completed" && pending { "handoff-recorded" } else { &outcome.status })}
                                    >
                                        {status(t, if outcome.status == "completed" && pending { "handoff-recorded" } else { &outcome.status })}
                                    </span>
                                    <span class={Strong}>{&outcome.item_title}</span>
                                </p>
                                <p class={Hint}>{&outcome.detail}</p>
                                <dl class={Facts}>
                                    <div>
                                        <dt>{t.page_latest_confirmation_action()}</dt>
                                        <dd>{status(t, &outcome.action)}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.page_latest_confirmation_quantity()}</dt>
                                        <dd>{outcome.quantity}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.page_latest_confirmation_remaining()}</dt>
                                        <dd>{outcome.remaining_quantity}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.page_latest_confirmation_support_references()}</dt>
                                        <dd>
                                            {if outcome.references.is_some() {
                                                t.page_latest_confirmation_reference_downstream()
                                            } else {
                                                t.page_latest_confirmation_reference_pending()
                                            }}
                                        </dd>
                                    </div>
                                </dl>
                            </li>
                        }
                    </ul>
                }
                <p class={Row}>
                    <a class={Button} href={url::SellList::PATH}>{t.page_latest_confirmation_view_seller_activity()}</a>
                    <a class={(Button, Secondary)} href="/account/sales">{t.page_latest_confirmation_view_committed_sales()}</a>
                    <a class={(Button, Secondary)} href="/account/sales/shipments">
                        {t.page_latest_confirmation_view_sale_shipments()}
                    </a>
                    <a class={(Button, Secondary)} href="/account/support">{t.page_latest_confirmation_open_support()}</a>
                </p>
            </div>
        </section>
    }
}
