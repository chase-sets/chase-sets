//! Platform > Listing Evidence Policy (`ListingEvidencePolicyPage`). Top to bottom: the header,
//! a refusal, the policy in effect and its versions (side by side from 48rem), a validation's
//! diff, impact and Activate form, and the guided draft form, a fieldset per rule.
//!
//! Every rule sends every rule field, hidden where its selector does not use it, so the parallel
//! lists the form posts stay in step. A selector's values are drawn for the kind the form was
//! drawn with: after choosing another kind, Show values draws the form again with its values.
use corten::prelude::*;

use super::{NONE, ids, kind, lifecycle, view_set, when};
use crate::{
    evidence::{Choice, EvidenceScreen, KINDS, Posted, Row, Selectors, VIEW_SETS, url},
    text::{Ops, Pilot},
    views::Here,
};

/// The selector kinds whose values the API lists; a kind with no values listed is typed.
const LISTED: [&str; 6] = ["catalog-item", "product", "blueprint", "category", "option", "seller-risk"];

#[component(css = ListingEvidencePage)]
fn Pair<'a>(term: &'a str, value: String) -> impl Render {
    html! {
        <div class={Row}>
            <dt>{term}</dt>
            <dd>{value}</dd>
        </div>
    }
}

/// A version's write: Validate, Reject or Create rollback draft.
#[component(css = ListingEvidencePage)]
fn VersionWrite<'a>(intent: &'a str, policy_id: &'a str, words: &'a str) -> impl Render {
    let f = Posted::FIELDS;
    html! {
        <form method="post" action={url::Evidence::default()}>
            <input type="hidden" name={f.intent} value={intent}>
            <input type="hidden" name={f.policy_id} value={policy_id}>
            <button class={(Button, Small, Secondary)} type="submit">{words}</button>
        </form>
    }
}

/// A rule's fields. `index` is its place in the form, which Remove and its box send.
#[component(css = ListingEvidencePage)]
fn RuleFields<'a>(o: Ops, p: Pilot, index: usize, row: &'a Row, selectors: &'a Selectors, removable: bool) -> impl Render {
    let f = Posted::FIELDS;
    let chosen = row.selector_kind.as_str();
    let listed = selectors.of(chosen);
    let typed = listed.is_empty() && (LISTED.contains(&chosen) || matches!(chosen, "seller-reviews" | "seller-badge"));
    let price = chosen == "price";
    let words = move |c: &Choice| {
        if chosen == "option" { o.lep_selector_option_label(&c.label, &c.id).to_string() } else { c.label.clone() }
    };
    let legend = o.lep_rule_title(index + 1).to_string();
    html! {
        <fieldset class={Rule}>
            <legend class={Legend}>{legend}</legend>
            <div class={Fields}>
                <label class={Field}>
                    <span>{o.lep_rule_id()}</span>
                    <input name={f.rule_id} value={&row.rule_id} required>
                </label>
                <label class={Field}>
                    <span>{o.lep_explanation_code()}</span>
                    <input name={f.explanation_code} value={&row.explanation_code} required>
                </label>
                <label class={Field}>
                    <span>{o.lep_priority()}</span>
                    <input type="number" step="1" name={f.priority} value={&row.priority} required>
                </label>
            </div>
            <fieldset class={Group}>
                <legend class={Legend}>{o.lep_selector_title()}</legend>
                <p class={Muted}>{o.lep_selector_description()}</p>
                <div class={Fields}>
                    <label class={Field}>
                        <span>{o.lep_selector_kind()}</span>
                        <select name={f.selector_kind}>
                            for each in KINDS {
                                <option value={each} selected={each == chosen}>{kind(o, each)}</option>
                            }
                        </select>
                    </label>
                    if !listed.is_empty() {
                        <label class={Field}>
                            <span>{o.lep_selector_value()}</span>
                            <select name={f.selector_value}>
                                <option value="" selected={!listed.iter().any(|c| c.id == row.selector_value)}>
                                    {o.lep_selector_choose()}
                                </option>
                                for choice in listed {
                                    <option value={&choice.id} selected={choice.id == row.selector_value}>{words(choice)}</option>
                                }
                            </select>
                        </label>
                    } else if typed {
                        <label class={Field}>
                            <span>{o.lep_selector_value()}</span>
                            <input name={f.selector_value} value={&row.selector_value}>
                        </label>
                    } else {
                        <input type="hidden" name={f.selector_value} value={&row.selector_value}>
                    }
                    if price {
                        <label class={Field}>
                            <span>{o.lep_minimum_price()}</span>
                            <input inputmode="decimal" name={f.minimum_price} value={&row.minimum_price}>
                        </label>
                        <label class={Field}>
                            <span>{o.lep_maximum_price()}</span>
                            <input inputmode="decimal" name={f.maximum_price} value={&row.maximum_price}>
                        </label>
                    } else {
                        <input type="hidden" name={f.minimum_price} value={&row.minimum_price}>
                        <input type="hidden" name={f.maximum_price} value={&row.maximum_price}>
                    }
                </div>
                <button
                    class={(Button, Small, Secondary)}
                    type="submit"
                    name={f.rerow}
                    value="refresh"
                    title={p.evidence_show_values_hint()}
                    formnovalidate
                >
                    {p.evidence_show_values()}
                </button>
            </fieldset>
            <fieldset class={Group}>
                <legend class={Legend}>{o.lep_requirements_title()}</legend>
                <div class={Fields}>
                    <label class={Field}>
                        <span>{o.lep_minimum_photos()}</span>
                        <input type="number" min="0" step="1" name={f.minimum_photo_count} value={&row.minimum_photo_count}>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_view_set()}</span>
                        <select name={f.view_set}>
                            for set in VIEW_SETS {
                                <option value={set} selected={set == row.view_set}>{view_set(o, set)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_minimum_width()}</span>
                        <input type="number" min="0" step="1" name={f.minimum_width_pixels} value={&row.minimum_width_pixels}>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_minimum_height()}</span>
                        <input type="number" min="0" step="1" name={f.minimum_height_pixels} value={&row.minimum_height_pixels}>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_maximum_age()}</span>
                        <input type="number" min="0" step="1" name={f.maximum_age_hours} value={&row.maximum_age_hours}>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_minimum_trust_reviews()}</span>
                        <input type="number" min="0" step="1" name={f.minimum_trust_reviews} value={&row.minimum_trust_reviews}>
                    </label>
                    <label class={Field}>
                        <span>{o.lep_accepted_badge()}</span>
                        <input name={f.accepted_badge_key} value={&row.accepted_badge_key}>
                    </label>
                </div>
                <label class={Check}>
                    <input type="checkbox" name={f.buyer_acknowledgment} value={index} checked={row.buyer_acknowledgment}>
                    {o.lep_buyer_acknowledgment()}
                </label>
            </fieldset>
            if removable {
                <button class={(Button, Small, Danger)} type="submit" name={f.rerow} value={index} formnovalidate>
                    {o.lep_remove_rule()}
                </button>
            }
        </fieldset>
    }
}

#[component(css)]
pub fn ListingEvidencePage<'a>(o: Ops, p: Pilot, here: &'a Here, screen: &'a EvidenceScreen) -> impl Render {
    let f = Posted::FIELDS;
    let current = &screen.overview.current;
    let at = |value: Option<&str>, otherwise: &str| value.map_or_else(|| otherwise.to_owned(), |v| when(o, here, v));
    let removable = screen.draft.rows.len() > 1;
    let rewritable = |lifecycle: &str| matches!(lifecycle, "draft" | "validated");
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{o.lep_eyebrow()}</p>
                <h1>{o.lep_title()}</h1>
                <p class={Muted}>{o.lep_description()}</p>
            </header>
            if let Some(refusal) = &screen.refusal {
                <p class={Alert} role="alert">{refusal}</p>
            }
            <div class={Panels}>
                <section class={Card} aria-labelledby="lep-current">
                    <h2 class={Heading} id="lep-current">{o.lep_current_title()}</h2>
                    <dl class={Pairs}>
                        <Pair
                            term={o.lep_policy_id()}
                            value={current.policy_id.clone().unwrap_or_else(|| o.lep_compiled_fallback().to_owned())}
                        />
                        <Pair term={o.lep_version()} value={current.version.map_or_else(|| NONE.to_owned(), |v| v.to_string())} />
                        <Pair term={o.lep_hash()} value={current.hash.clone()} />
                        <Pair term={o.lep_effective_from()} value={at(current.effective_from.as_deref(), NONE)} />
                        <Pair term={o.lep_effective_until()} value={at(current.effective_until.as_deref(), o.lep_open_ended())} />
                    </dl>
                    <p class={Muted}>{o.lep_rule_count(current.value.rules.len()).to_string()}</p>
                </section>
                <section class={Card} aria-labelledby="lep-versions">
                    <h2 class={Heading} id="lep-versions">{o.lep_lifecycle_title()}</h2>
                    <ul class={Versions}>
                        for document in &screen.overview.documents {
                            let (words, tone) = lifecycle(o, &document.lifecycle);
                            <li class={Version}>
                                <div class={Line}>
                                    <span class={Tag} data-tone={tone}>{words}</span>
                                    <span class={Words}>{format!("{} v{}", document.policy_id, document.version)}</span>
                                </div>
                                <p class={(Muted, Words)}>{&document.hash}</p>
                                <div class={Line}>
                                    if screen.can_validate && rewritable(&document.lifecycle) {
                                        <VersionWrite
                                            intent="validate"
                                            policy_id={&document.policy_id}
                                            words={o.lep_validate()}
                                        />
                                    }
                                    if screen.can_draft && rewritable(&document.lifecycle) {
                                        <VersionWrite intent="reject" policy_id={&document.policy_id} words={o.lep_reject()} />
                                    }
                                    if screen.can_draft && document.lifecycle == "active" {
                                        <VersionWrite
                                            intent="rollback"
                                            policy_id={&document.policy_id}
                                            words={o.lep_rollback()}
                                        />
                                    }
                                </div>
                            </li>
                        }
                    </ul>
                </section>
            </div>
            if let Some(validation) = &screen.validation {
                <section class={Card} aria-labelledby="lep-impact">
                    <h2 class={Heading} id="lep-impact">{o.lep_impact_title()}</h2>
                    <p>{o.lep_impact_count(validation.impact_preview.impacted_listing_count).to_string()}</p>
                    <p class={Words}>
                        {o.lep_diff(
                            &ids(&validation.semantic_diff.added_rule_ids),
                            &ids(&validation.semantic_diff.changed_rule_ids),
                            &ids(&validation.semantic_diff.removed_rule_ids),
                        ).to_string()}
                    </p>
                    if !validation.diagnostics.is_empty() {
                        <ul class={(Alert, Diagnostics)} role="alert">
                            for diagnostic in &validation.diagnostics {
                                <li class={Words}>{format!("{}: {}", diagnostic.path, diagnostic.message)}</li>
                            }
                        </ul>
                    }
                    if validation.valid && screen.can_activate {
                        <form class={Form} method="post" action={url::Evidence::default()}>
                            <input type="hidden" name={f.intent} value="activate">
                            <input type="hidden" name={f.policy_id} value={&validation.document_id}>
                            <input
                                type="hidden"
                                name={f.impact_acknowledgment_hash}
                                value={&validation.impact_preview.preview_hash}
                            >
                            <div class={(Fields, Two)}>
                                <label class={Field}>
                                    <span>{o.lep_effective_from()}</span>
                                    <input type="datetime-local" name={f.effective_from} required>
                                </label>
                                <label class={Field}>
                                    <span>{o.lep_effective_until()}</span>
                                    <input type="datetime-local" name={f.effective_until}>
                                </label>
                            </div>
                            <label class={Check}>
                                <input type="checkbox" name={f.impact_acknowledged} value="yes" required>
                                {o.lep_impact_acknowledge()}
                            </label>
                            <button class={Button} type="submit">{o.lep_activate()}</button>
                        </form>
                    }
                </section>
            }
            if screen.can_draft {
                <section class={Card} aria-labelledby="lep-draft">
                    <h2 class={Heading} id="lep-draft">{o.lep_draft_title()}</h2>
                    <form class={Form} method="post" action={url::Evidence::default()}>
                        <button class={Default} type="submit" tabindex="-1" aria-hidden="true">{o.lep_create_draft()}</button>
                        <input type="hidden" name={f.intent} value="create-draft">
                        <label class={Field}>
                            <span>{o.lep_policy_name()}</span>
                            <input name={f.policy_name} value={&screen.draft.policy_name} required>
                        </label>
                        for (index, row) in screen.draft.rows.iter().enumerate() {
                            <RuleFields o={o} p={p} index={index} row={row} selectors={&screen.selectors} removable={removable} />
                        }
                        <div class={Line}>
                            <button class={(Button, Secondary)} type="submit" name={f.rerow} value="add" formnovalidate>
                                {o.lep_add_rule()}
                            </button>
                            <button class={Button} type="submit">{o.lep_create_draft()}</button>
                        </div>
                    </form>
                </section>
            }
        </div>
    }
}
