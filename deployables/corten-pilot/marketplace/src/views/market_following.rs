//! Market following (marketplace's `MarketFollowingOfferControls`), on the submitted offers list and
//! on an offer's page: the opened policy's status, what was refused, the policies that name the
//! page's offers (each a link that opens it), and for a reader with `offers.manage` the steps.
//!
//! Every step is its own form and works without JavaScript. "Follow the market for selected
//! Offers" is a `<details>` around the preview form, open once a policy is opened or a preview was
//! refused: each eligible offer's checkbox with its cap, the adjustment in its own `<details>`,
//! and Preview. The review lists each offer's proposed amount (or why it is held) with the Market
//! Price it read, and Authorize asks for consent in a required checkbox; Stop asks for its own.
//! While a result could not be confirmed every step is off until the page is opened again. One
//! column; every control is at least `--control-height` tall, a kit checkbox's row too (its label
//! is 20 px, filed as a Corten gap in the README's open workarounds).
use std::collections::BTreeMap;

use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use platform::ui::{checkbox::Checkbox, input::Input};

use crate::{
    api::{OfferPolicy, PolicyOutcome, PolicyTerms, SubmittedOffer},
    market_following::{self as mf, Following, Problem},
    text::{SubmittedOffersMsg, submitted_offers_msg as msg},
};

/// An offer's cap input and the adjustment input, for their labels.
#[derive(Id, Clone, Copy)]
pub struct CapId<'a>(pub &'a str);
#[derive(Id, Clone, Copy)]
pub struct AdjustmentId;
#[derive(Id, Clone, Copy)]
pub struct AdjustmentHintId;

/// An amount in its currency (`formatMoney`), or as the API sent it.
fn money(t: SubmittedOffersMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(value), Some(currency)) => t.money(value, currency).to_string(),
        _ => amount.to_owned(),
    }
}

fn status_label(t: SubmittedOffersMsg, status: &str) -> String {
    match status {
        "active" => t.following_status_active().to_owned(),
        "paused" => t.following_status_paused().to_owned(),
        "stopped" => t.following_status_stopped().to_owned(),
        "draft" => t.following_status_draft().to_owned(),
        other => other.to_owned(),
    }
}

/// Why a preview holds an offer (`marketplace.marketFollowing.held.*`), or the reason as sent.
fn held(t: SubmittedOffersMsg, reason: &str) -> String {
    match reason {
        "market-price-unavailable" => t.following_held_market_price_unavailable().to_owned(),
        "market-price-invalid" => t.following_held_market_price_invalid().to_owned(),
        "market-price-product-mismatch" => t.following_held_market_price_product_mismatch().to_owned(),
        "market-price-currency-mismatch" => t.following_held_market_price_currency_mismatch().to_owned(),
        "market-price-stale" => t.following_held_market_price_stale().to_owned(),
        "evaluation-time-invalid" => t.following_held_evaluation_time_invalid().to_owned(),
        "target-below-minimum" => t.following_held_target_below_minimum().to_owned(),
        other => other.to_owned(),
    }
}

fn problem_copy(t: SubmittedOffersMsg, problem: Problem) -> &'static str {
    match problem {
        Problem::Ambiguous => t.command_ambiguous(),
        Problem::Stale => t.following_stale(),
        Problem::Invalid => t.following_error(),
    }
}

/// One offer of some terms: its id, product, quantity and cap.
fn selection(t: SubmittedOffersMsg, terms: &PolicyTerms, offer: &crate::api::PolicySelection) -> String {
    let amount = money(t, &offer.maximum_unit_item_amount, &terms.currency);
    t.following_selection(msg::FollowingSelection {
        offer: &offer.offer_id,
        product: &offer.product_id,
        quantity: offer.quantity,
        amount: &amount,
    })
    .to_string()
}

/// The Market Price a preview read for an offer, when it has an amount, a currency and a time.
fn evidence(t: SubmittedOffersMsg, outcome: &PolicyOutcome) -> Option<String> {
    let market = outcome.result.evidence.get("marketPrice")?.as_object()?;
    let text = |key: &str| market.get(key).and_then(serde_json::Value::as_str);
    let (amount, currency, until) = (text("amount")?, text("currencyCode")?, text("freshUntil")?);
    let until = parse_timestamp(until)
        .map_or_else(|| until.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
    let amount = money(t, amount, currency);
    Some(
        t.following_evidence(msg::FollowingEvidence {
            amount: &amount,
            version: text("estimateVersion").unwrap_or(""),
            until: &until,
        })
        .to_string(),
    )
}

/// What the preview form starts from: what a refused step sent, else the opened policy's terms,
/// else the page's one submitted offer.
struct Draft {
    chosen: Vec<String>,
    caps: BTreeMap<String, String>,
    adjustment: String,
}

fn draft(following: &Following, offers: &[SubmittedOffer]) -> Draft {
    if let Some(posted) = &following.posted {
        return Draft { chosen: posted.offers.clone(), caps: posted.caps.clone(), adjustment: posted.adjustment.clone() };
    }
    if let Some(terms) = following.terms() {
        return Draft {
            chosen: terms.offers.iter().map(|o| o.offer_id.clone()).collect(),
            caps: terms.offers.iter().map(|o| (o.offer_id.clone(), o.maximum_unit_item_amount.clone())).collect(),
            adjustment: mf::percent(terms.adjustment_bps),
        };
    }
    let chosen = match offers {
        [one] if one.status == "submitted" => vec![one.offer_id.clone()],
        _ => Vec::new(),
    };
    Draft { chosen, caps: BTreeMap::new(), adjustment: "0".to_owned() }
}

/// The section. `action` is where the steps post; `opens` is each policy's address, in
/// `following.policies`' order (none for a policy without an id).
#[component(css)]
pub fn MarketFollowing<'a>(
    t: SubmittedOffersMsg,
    following: &'a Following,
    offers: &'a [SubmittedOffer],
    manage: bool,
    action: String,
    opens: Vec<Option<String>>,
) -> impl Render {
    let policy: Option<&OfferPolicy> = following.policy.as_ref();
    let status = policy.map_or("draft", OfferPolicy::status);
    let stopped = status == "stopped";
    let blocked = following.blocked();
    let bound = following.bound();
    let authority: Vec<&str> = policy
        .and_then(|p| p.authority.as_ref())
        .map(|a| a.offers.iter().map(|o| o.offer_id.as_str()).collect())
        .unwrap_or_default();
    let choosable: Vec<&SubmittedOffer> = offers
        .iter()
        .filter(|o| {
            o.status == "submitted" && (!bound.contains(&o.offer_id.as_str()) || authority.contains(&o.offer_id.as_str()))
        })
        .collect();
    let start = draft(following, offers);
    let policy_id = policy.and_then(|p| p.policy_id.clone()).unwrap_or_else(|| following.draft_id.clone());
    let version = policy.map_or(0, |p| p.version).to_string();
    let review = policy.and_then(|p| p.preview.as_ref()).filter(|p| p.outcomes.is_some() && following.problem.is_none());
    let open = policy.is_some() || following.posted.is_some();
    let links: Vec<(String, String)> = following
        .policies
        .iter()
        .zip(opens)
        .filter_map(|(p, href)| {
            let terms = p.authority.as_ref().or(p.preview.as_ref().map(|v| &v.terms));
            let ids: Vec<&str> = terms.map(|t| t.offers.iter().map(|o| o.offer_id.as_str()).collect()).unwrap_or_default();
            let status = status_label(t, p.status());
            Some((
                href.clone()?,
                t.following_manage(msg::FollowingManage { status: &status, offers: &ids.join(", ") }).to_string(),
            ))
        })
        .collect();
    html! {
        <section class={Following} aria-labelledby="market-following-title">
            <h2 id="market-following-title" class={Title}>{t.following_title()}</h2>
            <div class={Feedback} role="status" tabindex="-1">
                if let Some(problem) = following.problem {
                    <div class={Notice} data-tone="danger">
                        <p class={Strong}>{t.following_error_title()}</p>
                        <p>{problem_copy(t, problem)}</p>
                    </div>
                }
                <p><span class={Badge} data-status={status}>{status_label(t, status)}</span></p>
            </div>
            <div class={Notice}>
                <p class={Strong}>{t.following_item_only()}</p>
                <p>{t.following_effects()}</p>
            </div>
            if !links.is_empty() {
                <ul class={Links}>
                    for (href, label) in &links {
                        <li><a class={(Button, Secondary)} href={href}>{label}</a></li>
                    }
                </ul>
            }
            if let Some(terms) = policy.and_then(|p| p.authority.as_ref()) {
                <ul class={Lines}>
                    for offer in &terms.offers {
                        <li>{selection(t, terms, offer)}</li>
                    }
                </ul>
            }
            if stopped {
                <div class={Notice}>
                    <p class={Strong}>{t.following_status_stopped()}</p>
                    <p>{t.following_stop_effects()}</p>
                </div>
            } else if manage {
                if !choosable.is_empty() {
                    <details class={Follow} open={open}>
                        <summary class={(Button, Secondary)}>{t.following_toggle()}</summary>
                        <form class={Form} method="post" action={&action}>
                            <Operation step="preview" policy={&policy_id} version={&version} following={following} />
                            for offer in &choosable {
                                <div class={Offer}>
                                    <div class={Choice}>
                                        <Checkbox
                                            label={&t.following_select(msg::FollowingSelect { title: &offer.item_title, offer: &offer.offer_id }).to_string()}
                                        >
                                            <input
                                                type="checkbox"
                                                name={mf::OFFER}
                                                value={&offer.offer_id}
                                                checked={start.chosen.contains(&offer.offer_id)}
                                            >
                                        </Checkbox>
                                    </div>
                                    <p class={Hint}>
                                        {t.following_current(msg::FollowingCurrent {
                                            amount: &offer.price_currency_code.as_deref().map(|c| money(t, &offer.price_amount, c)).unwrap_or_default(),
                                            quantity: offer.quantity_requested,
                                            currency: offer.price_currency_code.as_deref().unwrap_or(""),
                                        })}
                                    </p>
                                    <label class={Label} for={CapId(&offer.offer_id)}>
                                        {t.following_maximum(&offer.item_title)}
                                    </label>
                                    <input
                                        id={CapId(&offer.offer_id)}
                                        class={Input {}}
                                        name={mf::cap_field(&offer.offer_id)}
                                        inputmode="decimal"
                                        required
                                        value={start.caps.get(&offer.offer_id).unwrap_or(&offer.price_amount)}
                                    >
                                </div>
                            }
                            <details class={Advanced} open={start.adjustment != "0"}>
                                <summary>{t.following_advanced()}</summary>
                                <label class={Label} for={AdjustmentId}>{t.following_adjustment()}</label>
                                <input
                                    id={AdjustmentId}
                                    class={Input {}}
                                    name={mf::ADJUSTMENT}
                                    inputmode="decimal"
                                    value={&start.adjustment}
                                    aria-describedby={AdjustmentHintId}
                                >
                                <p id={AdjustmentHintId} class={Hint}>{t.following_adjustment_help()}</p>
                            </details>
                            <p class={Row}>
                                <button class={Button} type="submit" disabled={blocked}>
                                    {if status == "paused" { t.following_resume_preview() } else { t.following_preview() }}
                                </button>
                            </p>
                        </form>
                    </details>
                } else {
                    <p class={Hint}>{t.following_empty()}</p>
                }
                if let Some(preview) = review {
                    <form class={(Form, Review)} method="post" action={&action}>
                        <Operation step="authorize" policy={&policy_id} version={&version} following={following} />
                        <input type="hidden" name={mf::PREVIEW} value={&preview.preview_id}>
                        <p class={Strong}>{t.following_review()}</p>
                        <p>
                            {t.following_review_terms(msg::FollowingReviewTerms {
                                currency: &preview.terms.currency,
                                adjustment: &mf::percent(preview.terms.adjustment_bps),
                            })}
                        </p>
                        <ul class={Lines}>
                            for outcome in preview.outcomes.iter().flatten() {
                                <li>
                                    if let Some(offer) = preview.terms.offers.iter().find(|o| o.offer_id == outcome.offer_id) {
                                        <p>{selection(t, &preview.terms, offer)}</p>
                                    }
                                    if let Some(evidence) = evidence(t, outcome) {
                                        <p class={Hint}>{evidence}</p>
                                    }
                                    <p class={Strong}>
                                        match outcome.result.status.as_str() {
                                            "target" => {
                                                {t.following_target(&money(t, outcome.result.unit_item_amount.as_deref().unwrap_or(""), &preview.terms.currency))}
                                            }
                                            _ => { {held(t, outcome.result.reason.as_deref().unwrap_or(""))} }
                                        }
                                    </p>
                                </li>
                            }
                        </ul>
                        <div class={Choice}>
                            <Checkbox label={t.following_consent()}>
                                <input type="checkbox" name={mf::CONSENT} value="true" required>
                            </Checkbox>
                        </div>
                        <p class={Row}>
                            <button class={Button} type="submit" disabled={blocked}>{t.following_authorize()}</button>
                        </p>
                    </form>
                }
                if status == "active" {
                    <form class={Row} method="post" action={&action}>
                        <Operation step="pause" policy={&policy_id} version={&version} following={following} />
                        <button class={(Button, Secondary)} type="submit" disabled={blocked}>{t.following_pause()}</button>
                    </form>
                }
                if policy.is_some_and(|p| p.policy_id.is_some()) {
                    <form class={Form} method="post" action={&action}>
                        <Operation step="stop" policy={&policy_id} version={&version} following={following} />
                        <div class={Choice}>
                            <Checkbox label={t.following_stop_effects()}>
                                <input type="checkbox" name={mf::CONFIRM_STOP} value="true" required>
                            </Checkbox>
                        </div>
                        <p class={Row}>
                            <button class={(Button, Secondary)} type="submit" disabled={blocked}>{t.following_stop()}</button>
                        </p>
                    </form>
                }
            }
        </section>
    }
}

/// A step's hidden fields: the step, the policy and its version, and the attempt and operation
/// it sends.
#[component]
fn Operation<'a>(step: &'static str, policy: &'a str, version: &'a str, following: &'a Following) -> impl Render {
    html! {
        <input type="hidden" name={mf::STEP} value={step}>
        <input type="hidden" name={mf::POLICY} value={policy}>
        <input type="hidden" name={mf::VERSION} value={version}>
        <input type="hidden" name={mf::ATTEMPT} value={&following.attempt}>
        <input type="hidden" name={mf::OPERATION} value={&following.operation}>
    }
}
