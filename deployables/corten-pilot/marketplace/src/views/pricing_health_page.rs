//! Pricing health's page (marketplace's `PricingHealthPage`): the header with Back to the
//! repricing desk, what failed or what Apply goal changed, the policy picker (with more than one
//! policy), the verdict with Compute verdict, the goals the Adoption Gate cleared, their candidates
//! compared with Compare goals and Apply goal (asked first in a `<dialog>`), and the platform's
//! forecast grades. Every action is a form and works without a script. One column on a phone,
//! where the comparison is a card per goal; a table from 64rem, which scrolls inside its own
//! region when it is wider than the page.
use std::collections::BTreeMap;

use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::account_home_page::humanized;
use crate::{
    api::{
        HealthAdvice, HealthCandidate, HealthCount, HealthCurrency, HealthGoal, HealthGrade, HealthRun, HealthSummary,
        PricingHealth,
    },
    app::url,
    pricing_health::{HealthForm, HealthScreen, Place},
    text::RepricingMsg,
};

/// A candidate's Apply goal confirmation, by its dry run.
#[derive(Id)]
pub struct ApplyGoalDialogId<'a>(pub &'a str);

/// A number written to at most `digits` fraction digits, without trailing zeros.
fn decimal(value: f64, digits: usize) -> Option<Decimal> {
    if !value.is_finite() {
        return None;
    }
    let fixed = format!("{value:.digits$}");
    let text = if fixed.contains('.') { fixed.trim_end_matches('0').trim_end_matches('.') } else { &fixed };
    Decimal::parse(text)
}

/// `healthNumber`: at most four fraction digits, or Unavailable.
fn number(t: RepricingMsg, value: Option<f64>) -> String {
    value.and_then(|v| decimal(v, 4)).map_or_else(|| t.health_unavailable().to_owned(), |d| t.number(d).to_string())
}

fn count(t: RepricingMsg, n: u64) -> String {
    t.number(n).to_string()
}

/// `healthPercent`: a ratio as a percentage to at most two fraction digits, or Unavailable.
fn percent(t: RepricingMsg, value: Option<f64>) -> String {
    value.and_then(|v| decimal(v, 6)).map_or_else(|| t.health_unavailable().to_owned(), |d| t.percent(d, 2).to_string())
}

/// An amount in `currency` (`formatMoney`), or the amount as it came.
fn money(t: RepricingMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), Currency::parse(currency.trim())) {
        (Some(value), Some(currency)) => t.money(value, currency).to_string(),
        _ => amount.to_owned(),
    }
}

/// A time the API sent, as `formatDateTime` writes it.
fn when(t: RepricingMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// An evidence reason (`healthReasonLabel`): the value in words, or Unrecognized.
fn reason(t: RepricingMsg, value: &str) -> String {
    humanized(value).unwrap_or_else(|| t.health_reason_unknown().to_owned())
}

/// A goal's name (`goalLabel`), with its parameters; a goal the catalog has no words for is generic.
fn goal_label(t: RepricingMsg, goal: &HealthGoal) -> String {
    t.by_key(&format!("health.goals.label.{}", goal.goal_id), &goal.parameters)
        .map_or_else(|| t.health_goals_label_generic().to_owned(), |m| m.to_string())
}

/// The goal a candidate or recommendation names, in words.
fn goal_named(t: RepricingMsg, goals: &[HealthGoal], id: Option<&str>, version: Option<u64>) -> String {
    goals
        .iter()
        .find(|g| Some(g.goal_id.as_str()) == id && Some(g.goal_version) == version)
        .map_or_else(|| t.health_goals_label_generic().to_owned(), |g| goal_label(t, g))
}

/// What a goal does (`goalExplanation`).
fn goal_explanation(t: RepricingMsg, goal: &HealthGoal) -> String {
    if let Some(m) = t.by_key(&format!("health.goals.explanation.{}", goal.goal_id), &goal.parameters) {
        return m.to_string();
    }
    let none: [(&str, &str); 0] = [];
    let features: Vec<String> = goal
        .required_curve_features
        .iter()
        .map(|f| t.by_key(&format!("health.goals.feature.{}", snake(f)), &none).map_or_else(|| f.clone(), |m| m.to_string()))
        .collect();
    let parameters: Vec<String> = goal.parameters.iter().map(|(k, v)| format!("{k}: {v}")).collect();
    t.health_goals_explanation_generic(&features.join(", "), &parameters.join(", ")).to_string()
}

/// A catalog key's part as `scripts/export.mjs` writes it: `storeWinShare` is `store_win_share`.
fn snake(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    let mut previous = None::<char>;
    for c in text.chars() {
        if c.is_ascii_uppercase() && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
        previous = Some(c);
    }
    out
}

/// The recommendation's words (`recommendationCopy`).
fn advice(t: RepricingMsg, advice: &HealthAdvice, goals: &[HealthGoal]) -> String {
    let key = if advice.kind == "attention" { advice.reason.clone().unwrap_or_default() } else { advice.kind.clone() };
    let goal = goal_named(t, goals, advice.goal_id.as_deref(), advice.goal_version);
    let args = [
        ("goal", goal),
        ("currency", advice.currency.clone().unwrap_or_default()),
        ("delta", number(t, advice.delta)),
        ("waitDelta", number(t, advice.wait_delta)),
        ("raised", advice.raised.unwrap_or(0).to_string()),
        ("lowered", advice.lowered.unwrap_or(0).to_string()),
        ("held", advice.held.unwrap_or(0).to_string()),
        ("count", advice.count.unwrap_or(0).to_string()),
    ];
    t.by_key(&format!("health.goals.recommendation.{key}"), &args).map_or(key, |m| m.to_string())
}

/// A candidate's status (`localizedGoalStatus`).
fn goal_status(t: RepricingMsg, status: &str) -> &'static str {
    match status {
        "queued" => t.health_goals_status_value_queued(),
        "running" => t.health_goals_status_value_running(),
        "completed" => t.health_goals_status_value_completed(),
        "failed" => t.health_goals_status_value_failed(),
        _ => t.health_goals_status_value_unknown(),
    }
}

/// Per-currency values as marketplace's cells write them: `USD 3.5, EUR 2`, or Unavailable.
fn per_currency<V>(t: RepricingMsg, values: Option<&BTreeMap<String, V>>, show: impl Fn(&str, &V) -> String) -> String {
    let shown: Vec<String> = values.into_iter().flatten().map(|(currency, v)| show(currency, v)).collect();
    if shown.is_empty() { t.health_unavailable().to_owned() } else { shown.join(", ") }
}

/// A JSON value as `JSON.stringify` writes it.
fn json(value: Option<&serde_json::Value>) -> String {
    value.map_or_else(|| "null".to_owned(), |v| v.to_string())
}

#[component(css)]
pub fn PricingHealthPage<'a>(t: RepricingMsg, screen: &'a HealthScreen) -> impl Render {
    let data = screen.data.as_ref();
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1 class={Title}>{t.pricing_health()}</h1>
                <p class={Muted}>{t.health_description()}</p>
                <p class={Row}><a class={(Button, Secondary)} href={url::Repricing::default()}>{t.health_back()}</a></p>
            </header>
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.health_error()}</p>
                    <p>{error}</p>
                    <p class={Row}><a class={(Button, Secondary)} href={&screen.here}>{t.health_retry()}</a></p>
                </div>
            }
            if let Some(applied) = &screen.applied {
                <div class={Banner} data-tone="success" role="status" data-pricing-health-applied>
                    <p class={Strong}>{t.health_goals_applied()}</p>
                    <p>
                        {t.health_goals_applied_description(
                            &count(t, applied.revision),
                            &count(t, applied.movement.raised),
                            &count(t, applied.movement.lowered),
                            &count(t, applied.movement.held),
                            &count(t, applied.alerts.floor_binding),
                        )}
                    </p>
                </div>
            }
            if let Some(data) = data {
                <Body t={t} data={data} />
            }
        </div>
    }
}

#[component(css = PricingHealthPage)]
fn Body<'a>(t: RepricingMsg, data: &'a PricingHealth) -> impl Render {
    let f = HealthForm::FIELDS;
    html! {
        if data.policies.is_empty() {
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.health_no_policy()}</p>
                <p class={Row}>
                    <a class={Button} href={url::Repricing { place: crate::repricing::Place::create() }}>{t.health_create()}</a>
                </p>
            </div>
        } else {
            if data.policies.len() > 1 {
                <form class={(Card, Picker)} method="get" action={url::PricingHealth::default()}>
                    <label class={Field}>
                        <span class={Label}>{t.health_policy()}</span>
                        <select class={Select} name="policyId" required>
                            <option value="" selected={data.target.is_none()}>{t.health_choose()}</option>
                            for policy in &data.policies {
                                <option
                                    value={&policy.policy_id}
                                    selected={data.target.as_ref().is_some_and(|t| t.policy_id == policy.policy_id)}
                                >
                                    {&policy.name}
                                </option>
                            }
                        </select>
                    </label>
                    <button type="submit" class={(Button, Secondary)}>{t.health_show()}</button>
                </form>
            }
            match &data.target {
                None => <div class={Banner} data-tone="info"><p class={Strong}>{t.health_select_policy()}</p></div>,
                Some(target) => {
                    <section class={Section} aria-labelledby="pricing-health-verdict">
                        <div class={SectionHead}>
                            <h2 id="pricing-health-verdict" class={PartTitle}>{&target.name}</h2>
                            if data.can_compute {
                                <form method="post" action={url::PricingHealth { place: Place::of(&target.policy_id) }}>
                                    <input type="hidden" name={f.policy_id} value={&target.policy_id}>
                                    <button
                                        type="submit"
                                        class={Button}
                                        name={f.intent}
                                        value="compute"
                                        disabled={data.computing}
                                    >
                                        {t.health_compute()}
                                    </button>
                                </form>
                            }
                        </div>
                        if data.computing {
                            <div class={Banner} data-tone="info" role="status" data-pricing-health-computing>
                                <p class={Strong}>{t.health_computing()}</p>
                            </div>
                        }
                        match &data.health {
                            Some(health) => <Summary t={t} health={health} run={data.run.as_ref()} />,
                            None => {
                                <div class={Banner} data-tone="info">
                                    <p class={Strong}>{t.health_no_verdict()}</p>
                                    <p>{t.health_no_verdict_description()}</p>
                                </div>
                            }
                        }
                    </section>
                    <Goals t={t} goals={&data.goals} />
                    <section class={Section} aria-labelledby="pricing-health-compare">
                        <div class={SectionHead}>
                            <h2 id="pricing-health-compare" class={PartTitle}>{t.health_goals_comparison()}</h2>
                            if data.can_compute && data.branch.as_deref().unwrap_or("comparison") == "comparison" {
                                <form method="post" action={url::PricingHealth { place: Place::of(&target.policy_id) }}>
                                    <input type="hidden" name={f.policy_id} value={&target.policy_id}>
                                    <button type="submit" class={Button} name={f.intent} value="compare">
                                        {t.health_goals_compare()}
                                    </button>
                                </form>
                            }
                        </div>
                        <Comparison
                            t={t}
                            data={data}
                            policy={&target.policy_id}
                            revision={target.version}
                            hash={target.body_hash.as_deref()}
                        />
                    </section>
                    <section class={Section} aria-labelledby="pricing-health-grades">
                        <h2 id="pricing-health-grades" class={PartTitle}>{t.health_grades_title()}</h2>
                        <p class={Muted}>{t.health_grades_platform()}</p>
                        <Grades t={t} grades={&data.grades} />
                    </section>
                }
            }
        }
    }
}

/// Reasons and their counts, or None.
#[component(css = PricingHealthPage)]
fn Reasons<'a>(t: RepricingMsg, values: &'a BTreeMap<String, u64>) -> impl Render {
    html! {
        if values.is_empty() {
            {t.health_none()}
        } else {
            <dl class={Counts}>
                for (key, n) in values {
                    <div>
                        <dt>{reason(t, key)}</dt>
                        <dd>{count(t, *n)}</dd>
                    </div>
                }
            </dl>
        }
    }
}

fn listings_units(t: RepricingMsg, c: &HealthCount) -> String {
    t.health_population_value(&count(t, c.listing_count), &count(t, c.unit_count)).to_string()
}

#[component(css = PricingHealthPage)]
fn Summary<'a>(t: RepricingMsg, health: &'a HealthSummary, run: Option<&'a HealthRun>) -> impl Render {
    let unavailable = t.health_unavailable();
    html! {
        <div class={Tight} data-pricing-health-summary>
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.health_snapshot_title()}</p>
                <p>{t.health_snapshot_description()}</p>
            </div>
            <dl class={Pairs}>
                <div>
                    <dt>{t.health_captured_at()}</dt>
                    <dd>{when(t, &health.captured_at)}</dd>
                </div>
                <div>
                    <dt>{t.health_population()}</dt>
                    <dd>{listings_units(t, &health.population)}</dd>
                </div>
                <div>
                    <dt>{t.health_run()}</dt>
                    <dd class={Code}>{run.map_or(unavailable, |r| r.dry_run_id.as_str())}</dd>
                </div>
                <div>
                    <dt>{t.health_revision()}</dt>
                    <dd class={Code}>{run.map_or(unavailable, |r| r.body_hash.as_str())}</dd>
                </div>
                <div>
                    <dt>{t.health_completed_at()}</dt>
                    <dd>{run.map_or_else(|| unavailable.to_owned(), |r| when(t, &r.completed_at))}</dd>
                </div>
                <div>
                    <dt>{t.health_uncategorized()}</dt>
                    <dd>{listings_units(t, &health.uncategorized)}</dd>
                </div>
                <div>
                    <dt>{t.health_reasons()}</dt>
                    <dd><Reasons t={t} values={&health.uncategorized.reasons} /></dd>
                </div>
            </dl>
            if health.population.listing_count == 0 {
                <div class={Banner} data-tone="info"><p class={Strong}>{t.health_empty_population()}</p></div>
            }
            for (currency, summary) in &health.currencies {
                <CurrencyCard t={t} currency={currency} summary={summary} />
            }
        </div>
    }
}

#[component(css = PricingHealthPage)]
fn CurrencyCard<'a>(t: RepricingMsg, currency: &'a str, summary: &'a HealthCurrency) -> impl Render {
    let m = move |amount: &str| money(t, amount, currency);
    let risk = move |c: &HealthCount| {
        t.health_risk_value(&count(t, c.listing_count), &count(t, c.unit_count), &m(&c.value_amount)).to_string()
    };
    let c = &summary.coverage;
    let stale = summary.curve_age.stale_count > 0;
    let unavailable_reason = |r: &Option<String>| r.as_deref().map_or_else(|| t.health_none().to_owned(), |r| reason(t, r));
    html! {
        <article class={Card} data-pricing-health-currency={currency}>
            <header class={Tight}>
                <h3 class={PartTitle}>{currency}</h3>
                <p class={Muted}>{t.health_currency_description()}</p>
            </header>
            if c.listing_count == 0 {
                <div class={Banner} data-tone="info"><p class={Strong}>{t.health_no_modeled()}</p></div>
            }
            <p>
                <span class={Badge} data-tone={if stale { "warning" } else { "neutral" }}>
                    {if stale { t.health_stale() } else { t.health_fresh_at_capture() }}
                </span>
            </p>
            <dl class={Pairs}>
                <div>
                    <dt>{t.health_s1()}</dt>
                    <dd>{m(&summary.listed_value_amount)}</dd>
                </div>
                <div>
                    <dt>{t.health_s2()}</dt>
                    <dd data-health-s2>{m(&summary.modeled_value_amount)}</dd>
                </div>
                <div>
                    <dt>{t.health_delta()}</dt>
                    <dd>{m(&summary.modeled_value_delta_amount)}</dd>
                </div>
                <div>
                    <dt>{t.health_s3()}</dt>
                    <dd>
                        {t.health_coverage_value(
                            &count(t, c.listing_count),
                            &count(t, c.listing_total),
                            &percent(t, c.listing_ratio),
                            &count(t, c.unit_count),
                            &count(t, c.unit_total),
                            &percent(t, c.unit_ratio),
                        )}
                    </dd>
                </div>
                <div>
                    <dt>{t.health_reasons()}</dt>
                    <dd><Reasons t={t} values={&c.missing_reasons} /></dd>
                </div>
                <div>
                    <dt>{t.health_bounds()}</dt>
                    <dd>{count(t, c.bound_status_count)}</dd>
                </div>
                <div>
                    <dt>{t.health_s4()}</dt>
                    <dd>
                        {t.health_age_value(
                            &number(t, summary.curve_age.newest_age_days),
                            &number(t, summary.curve_age.oldest_age_days),
                            &count(t, summary.curve_age.stale_count),
                        )}
                    </dd>
                </div>
                <div>
                    <dt>{t.health_s5()}</dt>
                    <dd>
                        {t.health_wait_value(&number(t, summary.expected_wait.median_days), &number(t, summary.expected_wait.p90_days))}
                    </dd>
                </div>
                <div>
                    <dt>{t.health_s6()}</dt>
                    <dd data-health-s6>
                        {t.health_sales_value(&count(t, summary.expected_sales.listing_count), &m(&summary.expected_sales.value_amount))}
                    </dd>
                </div>
                <div>
                    <dt>{t.health_s7_hopeless()}</dt>
                    <dd>{risk(&summary.value_at_risk.hopeless)}</dd>
                </div>
                <div>
                    <dt>{t.health_s7_slow()}</dt>
                    <dd>{risk(&summary.value_at_risk.slow)}</dd>
                </div>
                <div>
                    <dt>{t.health_risk_unknown()}</dt>
                    <dd>{count(t, summary.value_at_risk.unknown_policy_listing_count)}</dd>
                </div>
                <div>
                    <dt>{t.health_s8()}</dt>
                    <dd>
                        {t.health_profit_value(
                            &number(t, summary.profit_per_day.value),
                            currency,
                            &number(t, summary.profit_per_day.cycle_days),
                        )}
                    </dd>
                </div>
                <div>
                    <dt>{t.health_economics_count()}</dt>
                    <dd>{count(t, summary.profit_per_day.economics_listing_count)}</dd>
                </div>
                <div>
                    <dt>{t.health_unavailable_reason()}</dt>
                    <dd>{unavailable_reason(&summary.profit_per_day.unavailable_reason)}</dd>
                </div>
                <div>
                    <dt>{t.health_economics_reasons()}</dt>
                    <dd><Reasons t={t} values={&summary.profit_per_day.economics_unavailable_reasons} /></dd>
                </div>
                <div>
                    <dt>{t.health_cost_sources()}</dt>
                    <dd><Reasons t={t} values={&summary.profit_per_day.cost_basis_source_kinds} /></dd>
                </div>
                <div>
                    <dt>{t.health_s9()}</dt>
                    <dd>{percent(t, summary.capital_turn.value)}</dd>
                </div>
                <div>
                    <dt>{t.health_capital_cycle()}</dt>
                    <dd>{number(t, summary.capital_turn.cycle_days)}</dd>
                </div>
                <div>
                    <dt>{t.health_hurdle()}</dt>
                    <dd>{percent(t, summary.capital_turn.daily_return_hurdle)}</dd>
                </div>
                <div>
                    <dt>{t.health_hurdle_sources()}</dt>
                    <dd><Reasons t={t} values={&summary.capital_turn.daily_return_hurdle_source_kinds} /></dd>
                </div>
                <div>
                    <dt>{t.health_unavailable_reason()}</dt>
                    <dd>{unavailable_reason(&summary.capital_turn.unavailable_reason)}</dd>
                </div>
            </dl>
        </article>
    }
}

/// The goals the Adoption Gate cleared (`GoalPicker`).
#[component(css = PricingHealthPage)]
fn Goals<'a>(t: RepricingMsg, goals: &'a [HealthGoal]) -> impl Render {
    html! {
        <section class={Card} aria-labelledby="pricing-health-goals" data-pricing-health-goals>
            <header class={Tight}>
                <h2 id="pricing-health-goals" class={PartTitle}>{t.health_goals_title()}</h2>
                <p class={Muted}>{t.health_goals_description()}</p>
            </header>
            if goals.is_empty() {
                <div class={Banner} data-tone="info"><p class={Strong}>{t.health_goals_empty()}</p></div>
            } else {
                <ul class={GoalList}>
                    for goal in goals {
                        <li>
                            <h3 class={GoalName}>{goal_label(t, goal)}</h3>
                            <p class={Muted}>{goal_explanation(t, goal)}</p>
                        </li>
                    }
                </ul>
            }
        </section>
    }
}

/// The goals' candidates compared (`GoalComparison`), or why there is no comparison.
#[component(css = PricingHealthPage)]
fn Comparison<'a>(
    t: RepricingMsg,
    data: &'a PricingHealth,
    policy: &'a str,
    revision: u64,
    hash: Option<&'a str>,
) -> impl Render {
    let branch = data.branch.as_deref().unwrap_or("comparison");
    let fallback = HealthAdvice { kind: "compare-goals".into(), ..HealthAdvice::default() };
    let recommendation = data.recommendation.clone().unwrap_or(fallback);
    let edit = super::on_marketplace(&format!("/account/desk/repricing/{}?edit=1", crate::api::segment(policy)));
    let manage = data.can_compute;
    html! {
        if branch == "advanced-editor" {
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.health_goals_advanced_editor()}</p>
                <p>{t.health_goals_no_comparison()}</p>
                <p class={Row}><a class={Button} href={&edit}>{t.health_goals_advanced_editor()}</a></p>
            </div>
        } else if branch == "create-editor" {
            <div class={Banner} data-tone="info">
                <p class={Strong}>{t.health_goals_create_editor()}</p>
                <p>{t.health_goals_no_comparison()}</p>
                <p class={Row}>
                    <a class={Button} href={url::Repricing { place: crate::repricing::Place::create() }}>{t.health_create()}</a>
                </p>
            </div>
        } else {
            <div
                class={Banner}
                data-tone={if recommendation.kind == "switch" { "success" } else { "info" }}
                data-pricing-health-advice={&recommendation.kind}
            >
                <p class={Strong}>{advice(t, &recommendation, &data.goals)}</p>
            </div>
            if data.comparison.is_empty() {
                <p class={Muted}>{t.health_goals_compare_empty()}</p>
            } else {
                <div class={Scroll} role="region" aria-labelledby="pricing-health-compare" tabindex="0">
                    <table class={Table}>
                        <caption class={Hidden}>{t.health_goals_comparison()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.health_goals_goal()}</th>
                                <th scope="col">{t.health_goals_scope()}</th>
                                <th scope="col">{t.health_goals_listings()}</th>
                                <th scope="col">{t.health_goals_target_revision()}</th>
                                <th scope="col">{t.health_goals_requested_at()}</th>
                                <th scope="col">{t.health_goals_body_hash()}</th>
                                <th scope="col">{t.health_goals_status()}</th>
                                <th scope="col">{t.health_goals_value()}</th>
                                <th scope="col">{t.health_goals_wait()}</th>
                                <th scope="col">{t.health_goals_coverage()}</th>
                                <th scope="col">{t.health_goals_p90()}</th>
                                <th scope="col">{t.health_goals_bounds()}</th>
                                <th scope="col">{t.health_goals_profit()}</th>
                                <th scope="col">{t.health_goals_movement()}</th>
                                <th scope="col">{t.health_goals_held_reasons()}</th>
                                if manage {
                                    <th scope="col">{t.health_goals_apply()}</th>
                                }
                            </tr>
                        </thead>
                        <tbody>
                            for c in &data.comparison {
                                <Candidate
                                    t={t}
                                    c={c}
                                    goals={&data.goals}
                                    policy={policy}
                                    revision={revision}
                                    hash={hash}
                                    manage={manage}
                                />
                            }
                        </tbody>
                    </table>
                </div>
            }
        }
    }
}

#[component(css = PricingHealthPage)]
fn Candidate<'a>(
    t: RepricingMsg,
    c: &'a HealthCandidate,
    goals: &'a [HealthGoal],
    policy: &'a str,
    revision: u64,
    hash: Option<&'a str>,
    manage: bool,
) -> impl Render {
    let unavailable = t.health_unavailable();
    let dash = |n: Option<u64>| n.map_or_else(|| "\u{2014}".to_owned(), |n| n.to_string());
    let movement = format!(
        "{}: {}; {}: {}; {}: {}",
        t.health_goals_raised(),
        dash(c.raised),
        t.health_goals_lowered(),
        dash(c.lowered),
        t.health_goals_held(),
        dash(c.held)
    );
    let held: Vec<String> = c.held_reasons.iter().map(|(r, n)| format!("{}: {n}", reason(t, r))).collect();
    let numbers =
        |values: Option<&BTreeMap<String, Option<f64>>>| per_currency(t, values, |cur, v| format!("{cur} {}", number(t, *v)));
    let goal = goal_named(t, goals, Some(&c.goal_id), Some(c.goal_version));
    html! {
        <tr data-pricing-health-candidate={&c.dry_run_id}>
            <th scope="row" data-label={t.health_goals_goal()}>{&goal}</th>
            <td data-label={t.health_goals_scope()}>{t.health_goals_entire_scope()}</td>
            <td data-label={t.health_goals_listings()}>
                {c.listing_count.map_or_else(|| unavailable.to_owned(), |n| n.to_string())}
            </td>
            <td data-label={t.health_goals_target_revision()} class={Code}>
                {t.health_goals_target_revision_value(&c.target_policy_id, &c.target_revision.to_string())}
            </td>
            <td data-label={t.health_goals_requested_at()}>{when(t, &c.requested_at)}</td>
            <td data-label={t.health_goals_body_hash()} class={Code}>{&c.body_hash}</td>
            <td data-label={t.health_goals_status()}>{goal_status(t, &c.status)}</td>
            <td data-label={t.health_goals_value()}>{per_currency(t, c.value.as_ref(), |cur, v| money(t, v, cur))}</td>
            <td data-label={t.health_goals_wait()}>{numbers(c.median_wait_days.as_ref())}</td>
            <td data-label={t.health_goals_coverage()}>
                {per_currency(t, c.coverage.as_ref(), |cur, v| format!("{cur} {}", percent(t, Some(*v))))}
            </td>
            <td data-label={t.health_goals_p90()}>{numbers(c.p90_wait_days.as_ref())}</td>
            <td data-label={t.health_goals_bounds()}>
                {per_currency(t, c.bound_status_count.as_ref(), |cur, v| format!("{cur} {}", number(t, Some(*v))))}
            </td>
            <td data-label={t.health_goals_profit()}>{numbers(c.profit_per_day.as_ref())}</td>
            <td data-label={t.health_goals_movement()}>{&movement}</td>
            <td data-label={t.health_goals_held_reasons()}>{held.join(", ")}</td>
            if manage {
                <td data-label={t.health_goals_apply()}>
                    if c.status == "completed" {
                        <ApplyGoal t={t} c={c} goal={&goal} policy={policy} revision={revision} hash={hash} />
                    }
                </td>
            }
        </tr>
    }
}

/// Apply goal, asked first (`GoalApplyConfirmation`): the exact values Pricing checks.
#[component(css = PricingHealthPage)]
fn ApplyGoal<'a>(
    t: RepricingMsg,
    c: &'a HealthCandidate,
    goal: &'a str,
    policy: &'a str,
    revision: u64,
    hash: Option<&'a str>,
) -> impl Render {
    let f = HealthForm::FIELDS;
    let ready = hash.is_some();
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let parameters = c.parameters.clone().map_or(empty, serde_json::Value::Object);
    let parameters = json(Some(&parameters));
    let ask = format!("pricing-health-apply-{}", c.dry_run_id);
    let currency = c.currency_code.as_deref().unwrap_or(t.health_unavailable());
    html! {
        <button
            type="button"
            class={Button}
            command="show-modal"
            commandfor={ApplyGoalDialogId(&c.dry_run_id)}
            disabled={!ready}
            aria-label={format!("{}: {goal}", t.health_goals_apply())}
        >
            {t.health_goals_apply()}
        </button>
        if let Some(hash) = hash {
            <dialog id={ApplyGoalDialogId(&c.dry_run_id)} class={Dialog} aria-labelledby={&ask}>
                <h2 id={&ask} class={PartTitle}>{t.health_goals_confirm_title()}</h2>
                <div class={Confirm}>
                    <p>{t.health_goals_confirm_policy(policy, &revision.to_string(), hash)}</p>
                    <p>{t.health_goals_confirm_goal(&c.goal_id, &c.goal_version.to_string())}</p>
                    <p>{t.health_goals_confirm_parameters(&parameters)}</p>
                    <p>{t.health_goals_confirm_body_hash(&c.body_hash)}</p>
                    <p>
                        {t.health_goals_confirm_movement(
                            &c.raised.unwrap_or(0).to_string(),
                            &c.lowered.unwrap_or(0).to_string(),
                            &c.held.unwrap_or(0).to_string(),
                        )}
                    </p>
                    <p>
                        {t.health_goals_confirm_guardrails(&json(Some(c.guardrails.as_ref().unwrap_or(&serde_json::Value::Array(Vec::new())))))}
                    </p>
                    <p>{t.health_goals_confirm_currency_floor(currency, &json(c.floor.as_ref()))}</p>
                </div>
                <form class={(Row, Actions)} method="post" action={url::PricingHealth { place: Place::of(policy) }}>
                    <input type="hidden" name={f.policy_id} value={policy}>
                    <input type="hidden" name={f.dry_run_id} value={&c.dry_run_id}>
                    <input type="hidden" name={f.target_revision} value={revision.to_string()}>
                    <input type="hidden" name={f.target_body_hash} value={hash}>
                    <input type="hidden" name={f.candidate_body_hash} value={&c.body_hash}>
                    <input type="hidden" name={f.goal_id} value={&c.goal_id}>
                    <input type="hidden" name={f.goal_version} value={c.goal_version.to_string()}>
                    <input type="hidden" name={f.parameters} value={&parameters}>
                    <button
                        type="button"
                        class={(Button, Secondary)}
                        command="close"
                        commandfor={ApplyGoalDialogId(&c.dry_run_id)}
                    >
                        {t.health_goals_confirm_cancel()}
                    </button>
                    <button type="submit" class={(Button, Caution)} name={f.intent} value="apply">
                        {t.health_goals_confirm_apply()}
                    </button>
                </form>
            </dialog>
        }
    }
}

/// The platform's forecast grades (`ForecastGradePanel`).
#[component(css = PricingHealthPage)]
fn Grades<'a>(t: RepricingMsg, grades: &'a [HealthGrade]) -> impl Render {
    html! {
        if grades.is_empty() {
            <p><span class={Badge}>{t.health_grades_empty()}</span></p>
        } else {
            <div class={Cards}>
                for g in grades {
                    <article class={Card}>
                        <h3 class={PartTitle}>
                            {t.health_grades_identity(&g.goal_id, &g.goal_version.to_string(), &g.forecast_kind, &number(t, Some(g.horizon_days)), &g.model)}
                        </h3>
                        <p class={Muted}>{t.health_grades_platform()}</p>
                        <p>
                            <span class={Badge} data-tone={if g.status == "disclosed" { "success" } else { "neutral" }}>
                                {if g.status == "disclosed" { t.health_grades_disclosed() } else { t.health_grades_empty() }}
                            </span>
                        </p>
                        <dl class={Pairs}>
                            <div>
                                <dt>{t.health_grades_closed_on()}</dt>
                                <dd>{&g.closed_on}</dd>
                            </div>
                            if let (true, Some(v)) = (g.status == "disclosed", &g.values) {
                                <div>
                                    <dt>{t.health_grades_sold_share()}</dt>
                                    <dd>{percent(t, v.sold_share)}</dd>
                                </div>
                                <div>
                                    <dt>{t.health_grades_expected_share()}</dt>
                                    <dd>{percent(t, v.expected_share)}</dd>
                                </div>
                                <div>
                                    <dt>{t.health_grades_brier()}</dt>
                                    <dd>{number(t, v.brier)}</dd>
                                </div>
                                <div>
                                    <dt>{t.health_grades_base_rate_brier()}</dt>
                                    <dd>{number(t, v.base_rate_brier)}</dd>
                                </div>
                            }
                        </dl>
                    </article>
                }
            </div>
        }
    }
}
