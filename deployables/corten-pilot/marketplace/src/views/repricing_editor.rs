//! The policy page's editor (marketplace's `PolicyEditorDrawer` with a policy's body): the preset's,
//! the Pricing Goal's, the structured or the advanced controls (`repricing_body::Tier`), what the
//! scope matches and the dry run that previews it.
//!
//! The editor is one `data-patch` form posted to the policy's page, with the body it drew in a
//! hidden field: Apply, each button that adds, removes or moves a rule, condition or anchor, a
//! tier's button, and Preview answer with the editor drawn again (a patch, or the page without a
//! script), and Save policy goes to the policy's page after its revise. The page's script applies
//! a choice as it changes. A rule's conditions and anchors are rows keyed by the rule and their
//! place (`repricing_body::slot`). One column on a phone; the controls beside the preview from
//! 64rem, as the create editor's.
use corten::prelude::*;
use serde_json::Value;

use super::repricing_page::{DryRunSlot, PresetFields, PresetNames, ReviseFormId, ScopePreview, goal, handlers, keyed, num};
use crate::{
    api::RepricingCategory,
    app::url,
    repricing_body::{self, ANCHORS, CONDITIONS, Op, Tier, condition_number, slot},
    repricing_policy::{Place as PolicyPlace, PolicyForm, ReviseEditor, ReviseScreen},
    text::{Pilot, RepricingMsg},
};

/// The editor's part, which its form's answers draw again.
#[derive(Id)]
pub struct ReviseEditorId;

/// A number or text of the body as a control shows it; nothing for null.
fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => n.as_f64().map(num).unwrap_or_default(),
        _ => String::new(),
    }
}

/// A part's mode (`mode`, or a terminal's `kind`).
fn mode<'v>(part: &'v Value, tag: &str) -> &'v str {
    part.get(tag).and_then(Value::as_str).unwrap_or_default()
}

/// An anchor a seller may choose, in words.
fn anchor_name(t: RepricingMsg, source: &str) -> &'static str {
    match source {
        "lowest-competing-ask" => t.editor_anchor_lowest(),
        "comp-percentile" => t.editor_anchor_percentile(),
        "last-sold" => t.editor_anchor_last_sold(),
        _ => t.editor_anchor_market(),
    }
}

/// A condition type in words.
fn condition_name(t: RepricingMsg, kind: &str) -> &'static str {
    match kind {
        "item-grading" => t.editor_condition_grading(),
        "quantity-at-least" => t.editor_condition_quantity(),
        "listing-age-at-least" => t.editor_condition_age(),
        "cost-basis-present" => t.editor_condition_cost_present(),
        "cost-basis-absent" => t.editor_condition_cost_absent(),
        "competing-listing-count-at-least" => t.editor_condition_count(),
        "schedule-window" => t.editor_condition_schedule(),
        _ => t.editor_condition_category(),
    }
}

/// A Pricing Goal anchor in words (`repricingGoalLabel`).
fn goal_name(t: RepricingMsg, anchor: &Value) -> String {
    let parameters = anchor["parameters"]
        .as_object()
        .map(|parameters| parameters.iter().filter_map(|(key, value)| Some((key.clone(), value.as_f64()?))).collect())
        .unwrap_or_default();
    goal(t, anchor["goalId"].as_str().unwrap_or_default(), &parameters)
}

/// The editor, or that it could not read what it starts from.
#[component(css = super::repricing_page::RepricingPage)]
pub fn ReviseSection<'a>(t: RepricingMsg, p: Pilot, id: &'a str, editor: &'a ReviseEditor) -> impl Patch {
    let close = url::RepricingPolicy { id, place: PolicyPlace::default() };
    let retry = url::RepricingPolicy { id, place: PolicyPlace::edit() };
    html! {
        <section
            id={ReviseEditorId}
            class={(Section, Editor)}
            aria-labelledby="repricing-editor-title"
            data-repricing-editor="revise"
        >
            <div class={EditorHead}>
                <h2 id="repricing-editor-title" class={PartTitle}>{t.editor_revise()}</h2>
                <a class={(Button, Secondary)} href={&close}>{p.repricing_close()}</a>
            </div>
            if let ReviseEditor::Ready(screen) = editor {
                <ReviseBody t={t} p={p} id={id} screen={screen} />
            } else {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.editor_prerequisites_error()}</p>
                    <p><a href={&retry}>{t.editor_retry()}</a></p>
                </div>
            }
        </section>
    }
}

#[component(css = super::repricing_page::RepricingPage)]
fn ReviseBody<'a>(t: RepricingMsg, p: Pilot, id: &'a str, screen: &'a ReviseScreen) -> impl Render {
    let f = PolicyForm::FIELDS;
    let here = url::RepricingPolicy { id, place: PolicyPlace::edit() };
    let tier = screen.tier;
    let legend = match tier {
        Tier::Preset => t.editor_presets(),
        Tier::Goal => t.editor_goal(),
        Tier::Structured => t.editor_structured(),
        Tier::Advanced => t.editor_advanced(),
    };
    let body = &screen.body;
    html! {
        if !screen.errors.is_empty() {
            <div class={Banner} data-tone="danger" role="alert" data-repricing-errors="true">
                <p class={Strong}>{t.editor_validation_title()}</p>
                <ul class={Plain}>
                    for error in &screen.errors {
                        <li>{error}</li>
                    }
                </ul>
            </div>
        }
        if screen.unsupported_goal {
            <div class={Banner} data-tone="warning" role="status" data-repricing-unsupported-goal="true">
                <p>{t.editor_intent_unsupported_goal()}</p>
            </div>
        }
        <div class={EditorGrid}>
            <form
                id={ReviseFormId}
                class={EditorForm}
                method="post"
                action={&here}
                data-patch
                data-repricing-tier={tier.key()}
                on:change={handlers::apply(event)}
            >
                // Enter in a text field applies it, as the first submit button of the form.
                <button
                    class={Unseen}
                    type="submit"
                    name={f.intent}
                    value="apply"
                    tabindex="-1"
                    aria-hidden="true"
                    data-repricing-apply="true"
                >
                    {p.repricing_apply()}
                </button>
                <input type="hidden" name={f.tier} value={tier.key()}>
                <input type="hidden" name={f.body} value={body.to_string()}>
                if let Some(run) = &screen.run {
                    <input type="hidden" name={f.dry_run} value={&run.run.dry_run_id}>
                }
                if let Some(preset) = &screen.preset {
                    <PresetFields
                        t={t}
                        editor={preset}
                        facts={&screen.facts}
                        categories={&screen.categories}
                        names={PresetNames::revise()}
                    />
                    <p class={Muted}>{t.editor_cap()} ": " {shown(&body["maxChangesPerDay"])}</p>
                    <p class={Row}>
                        <button type="submit" class={(Button, Secondary)} name={f.intent} value="open-up">
                            {t.editor_open_up()}
                        </button>
                    </p>
                } else {
                    <fieldset class={Fieldset}>
                        <legend class={PartTitle}>{legend}</legend>
                        <label class={Field}>
                            <span class={Label}>{t.editor_name()}</span>
                            <input
                                class={Input}
                                type="text"
                                name={f.name}
                                value={shown(&body["name"])}
                                autocomplete="off"
                                data-repricing-name="true"
                            >
                        </label>
                        <ScopeFields t={t} scope={&body["scope"]} categories={&screen.categories} />
                        if tier == Tier::Goal {
                            <GoalFields t={t} body={body} />
                        } else {
                            <BodyFields t={t} screen={screen} />
                        }
                    </fieldset>
                }
                <div class={Actions}>
                    <button type="submit" class={(Button, Secondary)} name={f.intent} value="apply">
                        {p.repricing_apply()}
                    </button>
                    <button
                        type="submit"
                        class={(Button, Secondary)}
                        name={f.intent}
                        value="preview"
                        data-repricing-preview="true"
                    >
                        {t.editor_preview_start()}
                    </button>
                    <button type="submit" class={Button} name={f.intent} value="revise-policy" data-repricing-save="true">
                        {t.editor_save()}
                    </button>
                </div>
            </form>
            <div class={Tight}>
                <ScopePreview t={t} preview={screen.preview.as_ref()} />
                if let Some(run) = &screen.run {
                    <DryRunSlot t={t} p={p} run={run} />
                }
            </div>
        </div>
    }
}

/// The scope's controls over the body's scope (`PolicyScopeFields`).
#[component(css = super::repricing_page::RepricingPage)]
fn ScopeFields<'a>(t: RepricingMsg, scope: &'a Value, categories: &'a [RepricingCategory]) -> impl Render {
    let f = PolicyForm::FIELDS;
    let kind = mode(scope, "kind");
    let ids = |key: &str| -> Vec<String> {
        scope[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    };
    let chosen = ids("categoryIds");
    let listings = ids("listingIds").join(",");
    html! {
        <label class={Field}>
            <span class={Label}>{t.editor_scope()}</span>
            <select class={Input} name={f.scope}>
                <option value="all-listings" selected={kind != "catalog-filter" && kind != "listing-set"}>
                    {t.editor_scope_all()}
                </option>
                <option value="catalog-filter" selected={kind == "catalog-filter"}>{t.editor_scope_categories()}</option>
                <option value="listing-set" selected={kind == "listing-set"}>{t.editor_scope_listings()}</option>
            </select>
        </label>
        if kind == "catalog-filter" {
            <fieldset class={Checks}>
                <legend class={Label}>{t.editor_scope_categories()}</legend>
                for category in categories {
                    <label class={Check}>
                        <input
                            type="checkbox"
                            name={f.categories}
                            value={&category.id}
                            checked={chosen.contains(&category.id)}
                        >
                        <span>{&category.name}</span>
                    </label>
                }
                // A chosen category the list does not offer stays checked, so the next post keeps it.
                for id in chosen.iter().filter(|id| !categories.iter().any(|category| &category.id == *id)) {
                    <label class={Check}>
                        <input type="checkbox" name={f.categories} value={id} checked>
                        <span>{id}</span>
                    </label>
                }
            </fieldset>
        }
        if kind == "listing-set" {
            <label class={Field}>
                <span class={Label}>{t.editor_scope_listing_ids()}</span>
                <input class={Input} type="text" name={f.listings} value={&listings} autocomplete="off">
            </label>
        }
    }
}

/// A Pricing Goal's controls: the goal and currency it prices in, one floor for every rule, and
/// the daily cap.
#[component(css = super::repricing_page::RepricingPage)]
fn GoalFields<'a>(t: RepricingMsg, body: &'a Value) -> impl Render {
    let f = PolicyForm::FIELDS;
    let goal = repricing_body::goal_anchor(body).map(|anchor| goal_name(t, anchor)).unwrap_or_default();
    let directive = &body["rules"][0]["directive"];
    html! {
        <p class={Strong} data-repricing-goal="true">{goal}</p>
        <p class={Muted}>{shown(&directive["currencyCode"])}</p>
        <FloorFields t={t} rule={0} floor={&directive["floor"]} />
        <NumberField label={t.editor_cap()} name={f.cap} value={&body["maxChangesPerDay"]} />
        <p class={Row}>
            <button type="submit" class={(Button, Secondary)} name={f.intent} value="open-advanced">
                {t.editor_open_advanced()}
            </button>
        </p>
    }
}

/// A number control of the body: blank for null (marketplace's `PolicyNumber`).
#[component(css = super::repricing_page::RepricingPage)]
fn NumberField<'a>(label: &'a str, name: FieldName<String>, value: &'a Value) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <input class={Input} type="number" inputmode="decimal" step="any" name={name} value={shown(value)}>
        </label>
    }
}

/// The structured and advanced controls: Return to simple controls, the exclusions and cap, and
/// each rule (`PolicyDirectiveFields`, and in the advanced editor its conditions and moves).
#[component(css = super::repricing_page::RepricingPage)]
fn BodyFields<'a>(t: RepricingMsg, screen: &'a ReviseScreen) -> impl Render {
    let f = PolicyForm::FIELDS;
    let body = &screen.body;
    let advanced = screen.tier == Tier::Advanced;
    let excluded =
        body["excludedListingIds"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(",");
    let rules = repricing_body::rules_of(body);
    let last = rules.len().saturating_sub(1);
    html! {
        if screen.intent.is_some() {
            <p class={Row}>
                <button type="submit" class={(Button, Secondary)} name={f.intent} value="simple" data-repricing-simple="true">
                    {t.editor_intent_simple()}
                </button>
            </p>
        } else {
            <p class={Muted} data-repricing-custom="true">{t.editor_intent_custom()}</p>
        }
        <label class={Field}>
            <span class={Label}>{t.editor_excluded()}</span>
            <input class={Input} type="text" name={f.excluded} value={&excluded} autocomplete="off">
        </label>
        <NumberField label={t.editor_cap()} name={f.cap} value={&body["maxChangesPerDay"]} />
        if advanced {
            <p class={Muted}>{t.editor_first_match()}</p>
        } else {
            <p class={Row}>
                <button type="submit" class={(Button, Secondary)} name={f.intent} value="open-advanced">
                    {t.editor_open_advanced()}
                </button>
            </p>
        }
        for (index, rule) in rules.iter().enumerate() {
            <RuleFields
                t={t}
                categories={&screen.categories}
                index={index}
                rule={rule}
                last={index == last}
                advanced={advanced}
            />
        }
        if advanced {
            <p class={Row}>
                <button type="submit" class={(Button, Secondary)} name={f.op} value={Op::AddRule.value()}>
                    {t.editor_add_rule()}
                </button>
            </p>
        }
    }
}

/// One rule: in the advanced editor, its conditions and moves (but the default rule's), then its
/// directive.
#[component(css = super::repricing_page::RepricingPage)]
fn RuleFields<'a>(
    t: RepricingMsg,
    categories: &'a [RepricingCategory],
    index: usize,
    rule: &'a Value,
    last: bool,
    advanced: bool,
) -> impl Render {
    let f = PolicyForm::FIELDS;
    let legend =
        if last { t.editor_default_rule().to_owned() } else { t.editor_rule_number(&(index + 1).to_string()).to_string() };
    let conditions: Vec<(String, &Value)> = rule["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(j, condition)| (slot(index, j), condition))
        .collect();
    let rule_key = u32::try_from(index).unwrap_or(u32::MAX);
    html! {
        <fieldset class={(Card, Fieldset)} data-repricing-rule={index.to_string()}>
            <legend class={PartTitle}>{&legend}</legend>
            if advanced && !last {
                for (j, (key, condition)) in conditions.iter().enumerate() {
                    <ConditionFields t={t} categories={categories} at={key} condition={condition} rule={index} index={j} />
                }
                <div class={Actions}>
                    <button type="submit" class={(Button, Secondary)} name={f.op} value={Op::AddCondition(index).value()}>
                        {t.editor_add_condition()}
                    </button>
                    <button
                        type="submit"
                        class={(Button, Secondary)}
                        name={f.op}
                        value={Op::MoveRuleUp(index).value()}
                        disabled={index == 0}
                    >
                        {t.editor_move_up()}
                    </button>
                    <button type="submit" class={(Button, Caution)} name={f.op} value={Op::RemoveRule(index).value()}>
                        {t.editor_remove_rule()}
                    </button>
                </div>
            }
            <DirectiveFields t={t} rule={rule_key} index={index} directive={&rule["directive"]} advanced={advanced} />
        </fieldset>
    }
}

/// A rule's condition (`PolicyConditionFields`): its type, the controls the type has, and Remove.
#[component(css = super::repricing_page::RepricingPage)]
fn ConditionFields<'a>(
    t: RepricingMsg,
    categories: &'a [RepricingCategory],
    at: &'a String,
    condition: &'a Value,
    rule: usize,
    index: usize,
) -> impl Render {
    let row = PolicyForm::FIELDS.conditions.at(at);
    let kind = mode(condition, "type");
    let number = condition_number(kind).map(|field| shown(&condition[field]));
    let cost = kind.starts_with("cost-basis-");
    let days: Vec<u64> = condition["daysOfWeek"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
    let category = mode(condition, "categoryId");
    let graded = mode(condition, "grading") == "graded";
    html! {
        <fieldset class={(Group, Fieldset)} aria-label={t.editor_condition()} data-repricing-condition={at.as_str()}>
            <label class={Field}>
                <span class={Label}>{t.editor_condition()}</span>
                <select class={Input} name={row.kind}>
                    for option in CONDITIONS {
                        <option value={option} selected={option == kind}>{condition_name(t, option)}</option>
                    }
                </select>
            </label>
            if kind == "category" {
                <label class={Field}>
                    <span class={Label}>{t.editor_condition_category()}</span>
                    <select class={Input} name={row.category}>
                        <option value="" selected={category.is_empty()}>{t.editor_choose()}</option>
                        // A category the list does not offer stays chosen, so the next post keeps it.
                        if !category.is_empty() && !categories.iter().any(|option| option.id == category) {
                            <option value={category} selected>{category}</option>
                        }
                        for option in categories {
                            <option value={&option.id} selected={option.id == category}>{&option.name}</option>
                        }
                    </select>
                </label>
            }
            if kind == "item-grading" {
                <fieldset class={Checks}>
                    <legend class={Label}>{t.editor_condition_grading()}</legend>
                    <label class={Check}>
                        <input type="radio" name={row.grading} value="raw" checked={!graded}>
                        <span>{t.editor_grading_raw()}</span>
                    </label>
                    <label class={Check}>
                        <input type="radio" name={row.grading} value="graded" checked={graded}>
                        <span>{t.editor_grading_graded()}</span>
                    </label>
                </fieldset>
            }
            if let Some(number) = &number {
                <label class={Field}>
                    <span class={Label}>{condition_name(t, kind)}</span>
                    <input class={Input} type="number" inputmode="decimal" step="any" name={row.value} value={number}>
                </label>
            }
            if cost {
                <fieldset class={Checks}>
                    <legend class={Label}>{t.editor_cost_basis()}</legend>
                    for option in ["cost-basis-present", "cost-basis-absent"] {
                        <label class={Check}>
                            <input type="radio" name={row.cost} value={option} checked={option == kind}>
                            <span>{condition_name(t, option)}</span>
                        </label>
                    }
                </fieldset>
            }
            if kind == "schedule-window" {
                <fieldset class={Checks}>
                    <legend class={Label}>{t.editor_condition_schedule()}</legend>
                    for day in 0..7u64 {
                        <label class={Check}>
                            <input type="checkbox" name={row.days} value={day.to_string()} checked={days.contains(&day)}>
                            <span>{keyed(t, &format!("editor.weekday.{day}"))}</span>
                        </label>
                    }
                </fieldset>
                <label class={Field}>
                    <span class={Label}>{t.editor_schedule_start()}</span>
                    <input class={Input} type="time" name={row.start} value={shown(&condition["startTime"])}>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.editor_schedule_end()}</span>
                    <input class={Input} type="time" name={row.end} value={shown(&condition["endTime"])}>
                </label>
            }
            <p class={Row}>
                <button
                    type="submit"
                    class={(Button, Secondary)}
                    name={PolicyForm::FIELDS.op}
                    value={Op::RemoveCondition(rule, index).value()}
                >
                    {t.editor_remove_condition()}
                </button>
            </p>
        </fieldset>
    }
}

/// A rule's directive (`PolicyDirectiveFields`): its currency, its anchors with their moves, then the
/// offset, floor, ceiling, tolerance, rounding, largest move and what happens when no anchor is
/// usable.
#[component(css = super::repricing_page::RepricingPage)]
fn DirectiveFields<'a>(t: RepricingMsg, rule: u32, index: usize, directive: &'a Value, advanced: bool) -> impl Render {
    let row = PolicyForm::FIELDS.rules.at(&rule);
    let anchors: Vec<(String, &Value)> = directive["anchorChain"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(j, anchor)| (slot(index, j), anchor))
        .collect();
    let offset = mode(&directive["offset"], "mode");
    let ceiling = if directive["ceiling"].is_null() { "none" } else { mode(&directive["ceiling"], "mode") };
    let tolerance = mode(&directive["tolerance"], "mode");
    let rounding = mode(&directive["rounding"], "mode");
    let terminal = mode(&directive["terminal"], "kind");
    let value_of = |part: &Value| if mode(part, "mode") == "percent" { shown(&part["percent"]) } else { shown(&part["amount"]) };
    let terminal_value = match terminal {
        "pause" => Some((t.editor_terminal_reason(), shown(&directive["terminal"]["reason"]))),
        "fallback-price" => Some((t.editor_terminal_amount(), shown(&directive["terminal"]["amount"]))),
        _ => None,
    };
    let percent_or_amount = [("percent", t.editor_mode_percent()), ("absolute", t.editor_mode_absolute())];
    html! {
        <label class={Field}>
            <span class={Label}>{t.editor_currency()}</span>
            <input
                class={Input}
                type="text"
                name={row.currency}
                value={shown(&directive["currencyCode"])}
                maxlength="3"
                autocapitalize="characters"
                autocomplete="off"
            >
        </label>
        for (j, (key, anchor)) in anchors.iter().enumerate() {
            <AnchorFields t={t} at={key} anchor={anchor} rule={index} index={j} advanced={advanced} />
        }
        <p class={Row}>
            <button
                type="submit"
                class={(Button, Secondary)}
                name={PolicyForm::FIELDS.op}
                value={Op::AddAnchor(index).value()}
            >
                {t.editor_add_anchor()}
            </button>
        </p>
        <label class={Field}>
            <span class={Label}>{t.editor_offset()}</span>
            <select class={Input} name={row.offset}>
                for (value, words) in percent_or_amount {
                    <option value={value} selected={value == offset}>{words}</option>
                }
            </select>
        </label>
        <label class={Field}>
            if offset == "percent" {
                <span class={Label}>{t.editor_offset_percent()}</span>
                <input
                    class={Input}
                    type="number"
                    inputmode="decimal"
                    step="any"
                    name={row.offset_value}
                    value={value_of(&directive["offset"])}
                >
            } else {
                <span class={Label}>{t.editor_offset_amount()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.offset_value}
                    value={value_of(&directive["offset"])}
                    autocomplete="off"
                >
            }
        </label>
        <FloorFields t={t} rule={rule} floor={&directive["floor"]} />
        <label class={Field}>
            <span class={Label}>{t.editor_ceiling()}</span>
            <select class={Input} name={row.ceiling}>
                <option value="none" selected={ceiling == "none"}>{t.editor_mode_none()}</option>
                for (value, words) in percent_or_amount {
                    <option value={value} selected={value == ceiling}>{words}</option>
                }
            </select>
        </label>
        if ceiling == "percent" {
            <label class={Field}>
                <span class={Label}>{t.editor_ceiling_percent()}</span>
                <input
                    class={Input}
                    type="number"
                    inputmode="decimal"
                    step="any"
                    name={row.ceiling_value}
                    value={value_of(&directive["ceiling"])}
                >
            </label>
        }
        if ceiling == "absolute" {
            <label class={Field}>
                <span class={Label}>{t.editor_ceiling_amount()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.ceiling_value}
                    value={value_of(&directive["ceiling"])}
                    autocomplete="off"
                >
            </label>
        }
        <label class={Field}>
            <span class={Label}>{t.editor_tolerance()}</span>
            <select class={Input} name={row.tolerance}>
                for (value, words) in percent_or_amount {
                    <option value={value} selected={value == tolerance}>{words}</option>
                }
            </select>
        </label>
        <label class={Field}>
            if tolerance == "percent" {
                <span class={Label}>{t.editor_tolerance_percent()}</span>
                <input
                    class={Input}
                    type="number"
                    inputmode="decimal"
                    step="any"
                    name={row.tolerance_value}
                    value={value_of(&directive["tolerance"])}
                >
            } else {
                <span class={Label}>{t.editor_tolerance_amount()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.tolerance_value}
                    value={value_of(&directive["tolerance"])}
                    autocomplete="off"
                >
            }
        </label>
        <label class={Field}>
            <span class={Label}>{t.editor_rounding()}</span>
            <select class={Input} name={row.rounding}>
                <option value="none" selected={rounding == "none"}>{t.editor_rounding_none()}</option>
                <option value="charm" selected={rounding == "charm"}>{t.editor_rounding_charm()}</option>
                <option value="increment" selected={rounding == "increment"}>{t.editor_rounding_increment()}</option>
            </select>
        </label>
        if rounding == "increment" {
            <label class={Field}>
                <span class={Label}>{t.editor_rounding_amount()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.increment}
                    value={shown(&directive["rounding"]["incrementAmount"])}
                    autocomplete="off"
                >
            </label>
        }
        <label class={Field}>
            <span class={Label}>{t.editor_max_move()}</span>
            <input
                class={Input}
                type="number"
                inputmode="decimal"
                step="any"
                name={row.max_move}
                value={shown(&directive["maxMovePercent"])}
            >
        </label>
        <label class={Field}>
            <span class={Label}>{t.editor_terminal()}</span>
            <select class={Input} name={row.terminal}>
                <option value="hold" selected={terminal == "hold"}>{t.editor_terminal_hold()}</option>
                <option value="pause" selected={terminal == "pause"}>{t.editor_terminal_pause()}</option>
                <option value="fallback-price" selected={terminal == "fallback-price"}>{t.editor_terminal_fallback()}</option>
                <option value="price-at-floor" selected={terminal == "price-at-floor"}>{t.editor_terminal_floor()}</option>
                <option value="notify-only" selected={terminal == "notify-only"}>{t.editor_terminal_notify()}</option>
            </select>
        </label>
        if let Some((label, value)) = &terminal_value {
            <label class={Field}>
                <span class={Label}>{*label}</span>
                <input class={Input} type="text" name={row.terminal_value} value={value} autocomplete="off">
            </label>
        }
    }
}

/// A rule's floor (`PolicyFloorFields`), named as the rule's.
#[component(css = super::repricing_page::RepricingPage)]
fn FloorFields<'a>(t: RepricingMsg, rule: u32, floor: &'a Value) -> impl Render {
    let row = PolicyForm::FIELDS.rules.at(&rule);
    let cost = mode(floor, "mode") == "cost-basis-plus-margin";
    html! {
        <label class={Field}>
            <span class={Label}>{t.editor_floor()}</span>
            <select class={Input} name={row.floor}>
                <option value="absolute" selected={!cost}>{t.editor_floor_absolute()}</option>
                <option value="cost-basis-plus-margin" selected={cost}>{t.editor_floor_cost()}</option>
            </select>
        </label>
        if cost {
            <label class={Field}>
                <span class={Label}>{t.editor_floor_margin()}</span>
                <input
                    class={Input}
                    type="number"
                    inputmode="decimal"
                    step="any"
                    name={row.margin}
                    value={shown(&floor["marginPercent"])}
                >
            </label>
            <label class={Field}>
                <span class={Label}>{t.editor_floor_fallback()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.fallback}
                    value={shown(&floor["absoluteFallbackAmount"])}
                    autocomplete="off"
                >
                <span class={Hint}>{t.editor_floor_cost_help()}</span>
            </label>
        } else {
            <label class={Field}>
                <span class={Label}>{t.editor_floor_amount()}</span>
                <input
                    class={Input}
                    type="text"
                    inputmode="decimal"
                    name={row.amount}
                    value={shown(&floor["amount"])}
                    autocomplete="off"
                >
            </label>
        }
    }
}

/// An anchor of a rule's chain: a Pricing Goal's summary, or its source and what that source takes,
/// with Move up and Remove anchor.
#[component(css = super::repricing_page::RepricingPage)]
fn AnchorFields<'a>(
    t: RepricingMsg,
    at: &'a String,
    anchor: &'a Value,
    rule: usize,
    index: usize,
    advanced: bool,
) -> impl Render {
    let row = PolicyForm::FIELDS.anchors.at(at);
    let op = PolicyForm::FIELDS.op;
    let source = mode(anchor, "source");
    let any = source == "lowest-competing-ask" && mode(anchor, "strata") == "any";
    let parameters: Vec<(String, String)> =
        anchor["parameters"].as_object().into_iter().flatten().map(|(name, value)| (name.clone(), shown(value))).collect();
    let version = format!("{} v{}", shown(&anchor["goalId"]), shown(&anchor["goalVersion"]));
    html! {
        <fieldset class={(Group, Fieldset)} data-repricing-anchor={at.as_str()}>
            <legend class={Label}>{t.editor_anchor_number(&(index + 1).to_string())}</legend>
            if source == "curve-objective" {
                <p class={Strong}>{t.editor_anchor_curve_objective()}</p>
                <ul class={Plain}>
                    <li>{goal_name(t, anchor)}</li>
                    <li class={Code}>{&version}</li>
                    for (name, value) in &parameters {
                        <li>{name} ": " {value}</li>
                    }
                </ul>
            } else {
                <label class={Field}>
                    <span class={Label}>{t.editor_anchor()}</span>
                    <select class={Input} name={row.source}>
                        for option in ANCHORS {
                            <option value={option} selected={option == source}>{anchor_name(t, option)}</option>
                        }
                    </select>
                </label>
            }
            if source == "comp-percentile" {
                <label class={Field}>
                    <span class={Label}>{t.editor_percentile()}</span>
                    <input
                        class={Input}
                        type="number"
                        inputmode="decimal"
                        step="any"
                        min="1"
                        max="99"
                        name={row.percentile}
                        value={shown(&anchor["percentile"])}
                    >
                </label>
            }
            if advanced && source == "lowest-competing-ask" {
                <label class={Field}>
                    <span class={Label}>{t.editor_stratum()}</span>
                    <select class={Input} name={row.strata}>
                        <option value="hard" selected={!any}>{t.editor_stratum_hard()}</option>
                        <option value="any" selected={any}>{t.editor_stratum_any()}</option>
                    </select>
                </label>
            }
            if any {
                <div class={Banner} data-tone="info">
                    <p class={Strong}>{t.editor_band_title()}</p>
                    <p>{t.editor_band_description()}</p>
                </div>
                <label class={Field}>
                    <span class={Label}>{t.editor_band_minimum()}</span>
                    <input
                        class={Input}
                        type="number"
                        inputmode="decimal"
                        step="any"
                        min="50"
                        max="100"
                        name={row.band}
                        value={shown(&anchor["band"]["minPercentOfGround"])}
                    >
                </label>
            }
            <div class={Actions}>
                <button
                    type="submit"
                    class={(Button, Secondary)}
                    name={op}
                    value={Op::MoveAnchorUp(rule, index).value()}
                    disabled={index == 0}
                >
                    {t.editor_move_up()}
                </button>
                <button type="submit" class={(Button, Secondary)} name={op} value={Op::RemoveAnchor(rule, index).value()}>
                    {t.editor_remove_anchor()}
                </button>
            </div>
        </fieldset>
    }
}
