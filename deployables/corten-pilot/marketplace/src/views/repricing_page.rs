//! The Seller Desk's repricing page (marketplace's `PricingRepricingPolicyListPage` and
//! `PolicyEditorDrawer`'s preset tier): the header with Pricing Health, Recommendations and Create
//! repricing policy, what a write was refused for, the halt with its confirmation, the editor when
//! the address opens it, the policies with Pause and Resume, and the recent dry runs.
//!
//! Every action is a form and works without JavaScript; the editor's controls are a GET form, so
//! its address holds the policy (`repricing`). The page's script applies a choice as it changes.
//! A dry run that has not finished is relayed live (`<corten-live>`), and its part says the preview
//! is running with a link to read the page again for a reader without a script. One column on a
//! phone, where the tables are a card per row; the editor's controls beside its preview from
//! 64rem.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::{
        RepricingActivityRow, RepricingAnchor, RepricingCeiling, RepricingCondition, RepricingDryRun, RepricingFloor,
        RepricingHalt, RepricingOffset, RepricingPolicyRow, RepricingRounding, RepricingRule, RepricingScope, RepricingTerminal,
        RepricingTolerance, RepricingTrace, segment,
    },
    app::url,
    repricing::{DryRunView, EditorPart, EditorScreen, Floor, Place, Policies, Preset, RepricingScreen, Traces, WriteForm},
    repricing_policy::{ALWAYS_COUNTED, FILTERS, Place as PolicyPlace, PolicyForm, PolicyScreen},
    text::{Pilot, RepricingMsg},
};

corten::script::script!(pub mod handlers = "repricing_page.js");

/// The editor's form, which Activate in the dry run's part also posts.
#[derive(Id, Clone, Copy)]
pub struct EditorFormId;
/// The dry run's part, which its live relay draws again.
#[derive(Id)]
pub struct DryRunPartId;
/// The halt's confirmation.
#[derive(Id, Clone, Copy)]
pub struct HaltDialogId;
/// A policy's Delete confirmation.
#[derive(Id, Clone, Copy)]
pub struct DeleteDialogId;

/// No arguments, for a message found by its key that takes none.
const NONE: [(&str, &str); 0] = [];

/// A message found by its key, or the key's last part when the catalog has none.
fn keyed(t: RepricingMsg, key: &str) -> String {
    t.by_key(key, &NONE).map_or_else(|| key.rsplit('.').next().unwrap_or(key).to_owned(), |m| m.to_string())
}

/// A time the API sent (ISO 8601 or Postgres's text), written as marketplace's `formatDateTime` does.
fn when(t: RepricingMsg, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

fn count(t: RepricingMsg, n: u64) -> String {
    t.number(n).to_string()
}

/// An amount in the rule's currency, or the bare amount without one (`formatRepricingMoney`).
fn money(t: RepricingMsg, amount: &str, currency: Option<&str>) -> String {
    match (platform::money::decimal(amount), currency.and_then(|c| Currency::parse(c.trim()))) {
        (Some(value), Some(currency)) => t.money(value, currency).to_string(),
        _ => amount.to_owned(),
    }
}

/// A policy's status badge: an active policy reads Paused by halt while the halt is engaged
/// (`repricingStatusBadge`).
fn status(t: RepricingMsg, status: &str, halted: bool) -> (&'static str, &'static str) {
    match status {
        "active" if halted => (t.shared_status_halt_paused(), "warning"),
        "active" => (t.shared_status_active(), "success"),
        "paused" => (t.shared_status_paused(), "neutral"),
        _ => (t.shared_status_deleted(), "neutral"),
    }
}

/// The scope's words (`repricingScopeLabel`).
fn scope(t: RepricingMsg, scope: Option<&RepricingScope>) -> String {
    match scope {
        Some(RepricingScope::CatalogFilter { category_ids }) => {
            t.shared_scope_catalog_filter(&count(t, category_ids.len() as u64)).to_string()
        }
        Some(RepricingScope::ListingSet { listing_ids }) => {
            t.shared_scope_listing_set(&count(t, listing_ids.len() as u64)).to_string()
        }
        Some(RepricingScope::AllListings) | None => t.shared_scope_all_listings().to_owned(),
    }
}

/// The day's changes against the cap (`repricingBudgetLabel`).
fn budget(t: RepricingMsg, used: u64, cap: Option<u64>) -> String {
    let used = count(t, used);
    match cap {
        Some(cap) => t.shared_budget_capped(&used, &count(t, cap)).to_string(),
        None => t.shared_budget_uncapped(&used).to_string(),
    }
}

fn dry_run_status(t: RepricingMsg, status: &str) -> (&'static str, &'static str) {
    match status {
        "queued" => (t.list_dry_runs_status_queued(), "info"),
        "running" => (t.list_dry_runs_status_running(), "info"),
        "completed" => (t.list_dry_runs_status_completed(), "success"),
        _ => (t.list_dry_runs_status_failed(), "danger"),
    }
}

/// A policy's own page.
fn policy_href(id: &str) -> String {
    url::RepricingPolicy { id, place: PolicyPlace::default() }.href()
}

/// A sample's result: its skip reason when it skipped, else its outcome (`repricingResultCopyKey`).
fn result(t: RepricingMsg, trace: &RepricingTrace) -> String {
    match (trace.outcome.as_str(), trace.skip_reason.as_deref()) {
        ("skipped", Some(reason)) => keyed(t, &format!("activity.skip.{}", reason.replace('-', "_"))),
        (outcome, _) => keyed(t, &format!("activity.outcome.{}", outcome.replace('-', "_"))),
    }
}

/// The stratum a sample anchored to, in words that never name a competitor
/// (`resolveRepricingAnchorWording`).
fn anchor(t: RepricingMsg, trace: &RepricingTrace) -> String {
    let Some(anchor) = &trace.anchor else {
        return t.editor_mode_none().to_owned();
    };
    let key = match anchor.stratum.as_str() {
        "hard-ask" if anchor.source == "comp-percentile" => "activity.stratum.manual_listing_percentile",
        "hard-ask" => "activity.stratum.lowest_manual_listing",
        "any-ask" if trace.flags.iter().any(|f| f == "band-binding") => "activity.stratum.lowest_any_listing_band_floor",
        "any-ask" => "activity.stratum.lowest_any_listing",
        "market-estimate"
            if trace
                .exhausted_anchors
                .iter()
                .any(|a| matches!(a.source.as_str(), "lowest-competing-ask" | "comp-percentile")) =>
        {
            "activity.stratum.market_estimate_no_manual_listings"
        }
        "market-estimate" => "activity.stratum.market_estimate",
        "last-sold" => "activity.stratum.last_sold",
        "curve-objective" => "activity.anchor.goal_solved",
        _ => return t.editor_mode_none().to_owned(),
    };
    keyed(t, key)
}

/// The price limits a sample met, in words, joined.
fn clamps(t: RepricingMsg, trace: &RepricingTrace) -> String {
    let c = &trace.clamps;
    [
        (c.floor, t.activity_clamp_floor()),
        (c.ceiling, t.activity_clamp_ceiling()),
        (c.max_move, t.activity_clamp_max_move()),
        (c.evidence_floor, t.activity_clamp_evidence_floor()),
    ]
    .into_iter()
    .filter_map(|(met, label)| met.then_some(label))
    .collect::<Vec<_>>()
    .join(", ")
}

/// The currency a sample's rule prices in, from the run's body.
fn rule_currency(run: &RepricingDryRun, rule: usize) -> Option<&str> {
    run.body["rules"].get(rule).and_then(|r| r["directive"]["currencyCode"].as_str())
}

/// The page.
#[component(css)]
pub fn RepricingPage<'a>(t: RepricingMsg, p: Pilot, screen: &'a RepricingScreen) -> impl Render {
    let editing = screen.editor.is_some();
    let create = url::Repricing { place: Place::create() };
    let health = url::PricingHealth::default();
    let recommendations = url::Recommendations::default().href();
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.list_eyebrow()}</p>
            <h1 class={Title}>{t.list_caption()}</h1>
            <p class={Muted}>{t.list_description()}</p>
            <nav class={Row} aria-label={p.repricing_pages()}>
                <a class={(Button, Secondary)} href={url::Desk}>{p.repricing_desk()}</a>
                <a class={(Button, Secondary)} href={&health}>{t.pricing_health()}</a>
                <a class={(Button, Secondary)} href={&recommendations}>{t.recs_recommendations()}</a>
                if screen.manage && !editing {
                    <a class={Button} href={&create}>{t.editor_create()}</a>
                }
            </nav>
        </header>
        if let Some((message, details)) = &screen.refusal {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{message}</p>
                if !details.is_empty() {
                    <ul class={Plain}>
                        for detail in details {
                            <li>{detail}</li>
                        }
                    </ul>
                }
            </div>
        }
        <HaltPart
            t={t}
            halt={&screen.halt}
            failed={screen.halt_failed}
            manage={screen.manage}
            action={url::Repricing::default().href()}
            intent={WriteForm::FIELDS.intent}
        />
        if let Some(editor) = &screen.editor {
            <EditorSection t={t} p={p} part={editor} />
        }
        <PoliciesPart t={t} screen={screen} />
        <DryRunsPart t={t} runs={&screen.dry_runs} />
    }
}

/// The halt: a warning while engaged, and its switch, which asks first (`RepricingHaltControl`).
/// Its confirmation posts `intent` to `action`. A halt that could not be read has its switch off.
#[component(css = RepricingPage)]
fn HaltPart<'a>(
    t: RepricingMsg,
    halt: &'a RepricingHalt,
    failed: bool,
    manage: bool,
    action: String,
    intent: FieldName,
) -> impl Render {
    let engaged = halt.engaged;
    let since = halt.engaged_at.as_deref().map(|at| when(t, at)).unwrap_or_default();
    let (title, description) = if engaged {
        (t.shared_halt_engaged_title().to_owned(), t.shared_halt_engaged_description(&since).to_string())
    } else {
        (t.shared_halt_released_title().to_owned(), t.shared_halt_released_description().to_owned())
    };
    let (ask, asked, confirm, value) = if engaged {
        (t.shared_halt_release_title(), t.shared_halt_release_description(), t.shared_halt_release_confirm(), "release-halt")
    } else {
        (t.shared_halt_engage_title(), t.shared_halt_engage_description(), t.shared_halt_engage_confirm(), "engage-halt")
    };
    html! {
        <section
            class={(Banner, Halt)}
            data-tone={if engaged { "warning" } else { "info" }}
            aria-labelledby="repricing-halt-title"
            data-repricing-halt={if engaged { "engaged" } else { "released" }}
        >
            <div class={Tight}>
                <h2 id="repricing-halt-title" class={PartTitle}>{&title}</h2>
                <p>{&description}</p>
            </div>
            if manage {
                <button
                    type="button"
                    class={(Button, Secondary)}
                    role="switch"
                    aria-checked={if engaged { "true" } else { "false" }}
                    disabled={failed}
                    command="show-modal"
                    commandfor={HaltDialogId}
                >
                    {t.shared_halt_switch()}
                </button>
                <dialog
                    id={HaltDialogId}
                    class={Dialog}
                    aria-labelledby="repricing-halt-ask"
                    aria-describedby="repricing-halt-asked"
                >
                    <h2 id="repricing-halt-ask" class={PartTitle}>{ask}</h2>
                    <p id="repricing-halt-asked" class={Muted}>{asked}</p>
                    <form class={Actions} method="post" action={&action}>
                        <button type="button" class={(Button, Secondary)} command="close" commandfor={HaltDialogId}>
                            {t.shared_cancel()}
                        </button>
                        <button type="submit" class={(Button, Caution)} name={intent} value={value}>{confirm}</button>
                    </form>
                </dialog>
            }
        </section>
    }
}

/// The policies (`DataTable` of name, status, scope, daily changes and Pause or Resume).
#[component(css = RepricingPage)]
fn PoliciesPart<'a>(t: RepricingMsg, screen: &'a RepricingScreen) -> impl Render {
    let f = WriteForm::FIELDS;
    let halted = screen.halt.engaged;
    let (rows, failed, catching_up): (&[RepricingPolicyRow], bool, bool) = match &screen.policies {
        Policies::Read(rows) if !screen.halt_failed => (rows, false, false),
        Policies::CatchingUp => (&[], false, true),
        Policies::Read(_) | Policies::Failed => (&[], true, false),
    };
    html! {
        <section class={Section} aria-labelledby="repricing-policies-title">
            <h2 id="repricing-policies-title" class={PartTitle}>{t.list_caption()}</h2>
            if failed {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.list_error_title()}</p>
                    <p>{t.list_error_description()}</p>
                </div>
            } else if catching_up {
                <div class={Banner} data-tone="info" role="status" data-repricing-catching-up="true">
                    <p class={Strong}>{t.shared_catching_up_title()}</p>
                    <p>{t.shared_catching_up_description()}</p>
                </div>
            } else if rows.is_empty() {
                <div class={(Card, Empty)} data-repricing-policies-empty="true">
                    <p class={Strong}>{t.list_empty_title()}</p>
                    <p class={Muted}>{t.list_empty_description()}</p>
                </div>
            } else {
                <table class={Table} data-repricing-policies="true">
                    <caption class={Hidden}>{t.list_caption()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.list_column_name()}</th>
                            <th scope="col">{t.list_column_status()}</th>
                            <th scope="col">{t.list_column_scope()}</th>
                            <th scope="col">{t.list_column_budget()}</th>
                            if screen.manage {
                                <th scope="col"><span class={Hidden}>{t.list_column_actions()}</span></th>
                            }
                        </tr>
                    </thead>
                    <tbody>
                        for policy in rows {
                            <PolicyRow
                                t={t}
                                policy={policy}
                                halted={halted}
                                manage={screen.manage}
                                intent={f.intent}
                                id_field={f.policy_id}
                            />
                        }
                    </tbody>
                </table>
            }
        </section>
    }
}

#[component(css = RepricingPage)]
fn PolicyRow<'a>(
    t: RepricingMsg,
    policy: &'a RepricingPolicyRow,
    halted: bool,
    manage: bool,
    intent: FieldName,
    id_field: FieldName,
) -> impl Render {
    let id = policy.policy_id.as_deref().unwrap_or_default();
    let (label, tone) = status(t, &policy.status, halted);
    let name = policy.name.as_deref().unwrap_or(t.list_unnamed());
    let change = match policy.status.as_str() {
        "active" => Some(("pause-policy", t.shared_pause())),
        "paused" => Some(("resume-policy", t.shared_resume())),
        _ => None,
    };
    html! {
        <tr data-repricing-policy={id}>
            <th scope="row" data-label={t.list_column_name()}><a href={&policy_href(id)}>{name}</a></th>
            <td data-label={t.list_column_status()}><span class={Badge} data-tone={tone}>{label}</span></td>
            <td data-label={t.list_column_scope()}>{scope(t, policy.scope.as_ref())}</td>
            <td data-label={t.list_column_budget()}>{budget(t, policy.changes_used_today, policy.max_changes_per_day)}</td>
            if manage {
                <td class={Act}>
                    if let Some((value, words)) = change {
                        <form method="post" action={url::Repricing::default()}>
                            <input type="hidden" name={id_field} value={id}>
                            <button
                                type="submit"
                                class={(Button, Secondary)}
                                name={intent}
                                value={value}
                                aria-label={format!("{words} {name}")}
                            >
                                {words}
                            </button>
                        </form>
                    }
                </td>
            }
        </tr>
    }
}

/// The recent dry runs (requested, status, listings evaluated).
#[component(css = RepricingPage)]
fn DryRunsPart<'a>(t: RepricingMsg, runs: &'a [RepricingDryRun]) -> impl Render {
    html! {
        <section class={Section} aria-labelledby="repricing-runs-title">
            <h2 id="repricing-runs-title" class={PartTitle}>{t.list_dry_runs_title()}</h2>
            if runs.is_empty() {
                <div class={(Card, Empty)}>
                    <p class={Strong}>{t.list_dry_runs_empty_title()}</p>
                    <p class={Muted}>{t.list_dry_runs_empty_description()}</p>
                </div>
            } else {
                <table class={Table} data-repricing-dry-runs="true">
                    <caption class={Hidden}>{t.list_dry_runs_caption()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.list_dry_runs_column_requested()}</th>
                            <th scope="col">{t.list_dry_runs_column_status()}</th>
                            <th scope="col" class={Number}>{t.list_dry_runs_column_evaluated()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for run in runs {
                            <tr>
                                <th scope="row" data-label={t.list_dry_runs_column_requested()}>{when(t, &run.requested_at)}</th>
                                <td data-label={t.list_dry_runs_column_status()}>
                                    <span class={Badge} data-tone={dry_run_status(t, &run.status).1}>
                                        {dry_run_status(t, &run.status).0}
                                    </span>
                                </td>
                                <td class={Number} data-label={t.list_dry_runs_column_evaluated()}>
                                    {run.summary.as_ref().map_or_else(|| t.list_dry_runs_not_finished().to_owned(), |s| count(t, s.listings_evaluated))}
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            }
        </section>
    }
}

/// The editor (`PolicyEditorDrawer`'s preset tier), or that it could not read what it starts from.
#[component(css = RepricingPage)]
fn EditorSection<'a>(t: RepricingMsg, p: Pilot, part: &'a EditorPart) -> impl Render {
    html! {
        <section class={(Section, Editor)} aria-labelledby="repricing-editor-title" data-repricing-editor="true">
            <div class={EditorHead}>
                <h2 id="repricing-editor-title" class={PartTitle}>{t.editor_create()}</h2>
                <a class={(Button, Secondary)} href={url::Repricing::default()}>{p.repricing_close()}</a>
            </div>
            if let EditorPart::Ready(screen) = part {
                <EditorBody t={t} p={p} screen={screen} />
            } else {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.editor_prerequisites_error()}</p>
                    <p><a href={url::Repricing { place: Place::create() }}>{t.editor_retry()}</a></p>
                </div>
            }
        </section>
    }
}

#[component(css = RepricingPage)]
fn EditorBody<'a>(t: RepricingMsg, p: Pilot, screen: &'a EditorScreen) -> impl Render {
    let e = &screen.editor;
    let f = Place::FIELDS;
    let w = WriteForm::FIELDS;
    let (min, max, _) = e.preset.knob();
    let knob_label = match e.preset {
        Preset::Track => t.editor_adjust(),
        Preset::Beat => t.editor_undercut(),
        Preset::Premium => t.editor_premium(),
        Preset::Slow => t.editor_markdown(),
    };
    let promise = match e.preset {
        Preset::Track => t.editor_promise_track(),
        Preset::Beat => t.editor_promise_beat(),
        Preset::Premium => t.editor_promise_premium(),
        Preset::Slow => t.editor_promise_slow(),
    };
    let scope_kind = match &e.scope {
        RepricingScope::AllListings => "all-listings",
        RepricingScope::CatalogFilter { .. } => "catalog-filter",
        RepricingScope::ListingSet { .. } => "listing-set",
    };
    let chosen =
        |id: &str| matches!(&e.scope, RepricingScope::CatalogFilter { category_ids } if category_ids.iter().any(|c| c == id));
    let listings = match &e.scope {
        RepricingScope::ListingSet { listing_ids } => listing_ids.join(","),
        _ => String::new(),
    };
    let (cost, amount, margin, fallback) = match &e.floor {
        Floor::Absolute { amount } => (false, amount.clone(), "10".to_owned(), String::new()),
        Floor::CostPlus { margin, fallback } => (true, String::new(), margin.to_string(), fallback.clone()),
    };
    let codes = &screen.facts.listing_currency_codes;
    let run_id = screen.run.as_ref().map(|run| run.run.dry_run_id.as_str());
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
        <div class={EditorGrid}>
            // A GET form: Apply reads the page for its choices; Preview and Activate post.
            <form
                id={EditorFormId}
                class={EditorForm}
                method="get"
                action={url::Repricing::default()}
                data-keep-place
                on:change={handlers::apply(event)}
            >
                <input type="hidden" name={f.create} value="1">
                <input type="hidden" name={f.from} value={e.preset.key()}>
                if let Some(id) = run_id {
                    <input type="hidden" name={f.dry_run} value={id}>
                }
                <fieldset class={Fieldset}>
                    <legend class={PartTitle}>{t.editor_presets()}</legend>
                    <label class={Field}>
                        <span class={Label}>{t.editor_name()}</span>
                        <input
                            class={Input}
                            type="text"
                            name={f.name}
                            value={&e.name}
                            autocomplete="off"
                            data-repricing-name="true"
                        >
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.editor_strategy()}</span>
                        <select class={Input} name={f.preset}>
                            for preset in Preset::ALL {
                                <option value={preset.key()} selected={preset == e.preset}>{preset.title(t)}</option>
                            }
                        </select>
                        <span class={Hint}>{promise}</span>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{knob_label}</span>
                        <input
                            class={Input}
                            type="number"
                            inputmode="numeric"
                            name={f.knob}
                            value={e.knob.to_string()}
                            min={min.to_string()}
                            max={max.to_string()}
                            step="1"
                        >
                    </label>
                    if e.preset == Preset::Slow {
                        <label class={Field}>
                            <span class={Label}>{t.editor_age()}</span>
                            <input
                                class={Input}
                                type="number"
                                inputmode="numeric"
                                name={f.age}
                                value={e.age.to_string()}
                                min="14"
                                max="180"
                                step="1"
                            >
                        </label>
                    }
                    if codes.is_empty() {
                        <label class={Field}>
                            <span class={Label}>{t.editor_currency()}</span>
                            <input
                                class={Input}
                                type="text"
                                name={f.currency}
                                value={&e.currency}
                                maxlength="3"
                                autocapitalize="characters"
                                autocomplete="off"
                            >
                            <span class={Hint}>{t.editor_currency_empty()}</span>
                        </label>
                    } else {
                        <label class={Field}>
                            <span class={Label}>{t.editor_currency()}</span>
                            <select class={Input} name={f.currency}>
                                <option value="" selected={e.currency.is_empty()}>{t.editor_choose()}</option>
                                for code in codes {
                                    <option value={code} selected={*code == e.currency}>{code}</option>
                                }
                            </select>
                        </label>
                    }
                    <label class={Field}>
                        <span class={Label}>{t.editor_floor()}</span>
                        <select class={Input} name={f.floor}>
                            <option value="absolute" selected={!cost}>{t.editor_floor_absolute()}</option>
                            <option value="cost-basis-plus-margin" selected={cost}>{t.editor_floor_cost()}</option>
                        </select>
                    </label>
                    if cost {
                        <label class={Field}>
                            <span class={Label}>{t.editor_floor_margin()}</span>
                            <input class={Input} type="number" inputmode="decimal" name={f.margin} value={&margin} step="any">
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.editor_floor_fallback()}</span>
                            <input
                                class={Input}
                                type="text"
                                inputmode="decimal"
                                name={f.fallback}
                                value={&fallback}
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
                                name={f.amount}
                                value={&amount}
                                autocomplete="off"
                            >
                        </label>
                    }
                    <label class={Field}>
                        <span class={Label}>{t.editor_scope()}</span>
                        <select class={Input} name={f.scope}>
                            <option value="all-listings" selected={scope_kind == "all-listings"}>{t.editor_scope_all()}</option>
                            <option value="catalog-filter" selected={scope_kind == "catalog-filter"}>
                                {t.editor_scope_categories()}
                            </option>
                            <option value="listing-set" selected={scope_kind == "listing-set"}>
                                {t.editor_scope_listings()}
                            </option>
                        </select>
                    </label>
                    if scope_kind == "catalog-filter" {
                        <fieldset class={Checks}>
                            <legend class={Label}>{t.editor_scope_categories()}</legend>
                            for category in &screen.categories {
                                <label class={Check}>
                                    <input
                                        type="checkbox"
                                        name={f.categories}
                                        value={&category.id}
                                        checked={chosen(&category.id)}
                                    >
                                    <span>{&category.name}</span>
                                </label>
                            }
                        </fieldset>
                    }
                    if scope_kind == "listing-set" {
                        <label class={Field}>
                            <span class={Label}>{t.editor_scope_listing_ids()}</span>
                            <input class={Input} type="text" name={f.listings} value={&listings} autocomplete="off">
                        </label>
                    }
                </fieldset>
                <div class={Actions}>
                    <button type="submit" class={(Button, Secondary)} data-repricing-apply="true">
                        {p.repricing_apply()}
                    </button>
                    <button
                        type="submit"
                        class={Button}
                        formmethod="post"
                        name={w.intent}
                        value="preview"
                        data-repricing-preview="true"
                    >
                        {t.editor_preview_start()}
                    </button>
                </div>
            </form>
            <div class={Tight}>
                <ScopePreview t={t} screen={screen} />
                if let Some(run) = &screen.run {
                    if run.run.finished() {
                        {repricing_dry_run_part(t, p, run)}
                    } else {
                        // Drawn again on each status the run's stream sends (`repricing::live`).
                        <corten-live
                            class={Live}
                            src={&url::RepricingDryRunLive { id: &run.run.dry_run_id, place: run.place.clone() }.href()}
                        >
                            {repricing_dry_run_part(t, p, run)}
                        </corten-live>
                    }
                }
            </div>
        </div>
    }
}

/// What the scope matches and whose listings those are now (`ScopePreviewPanel`).
#[component(css = RepricingPage)]
fn ScopePreview<'a>(t: RepricingMsg, screen: &'a EditorScreen) -> impl Render {
    html! {
        if let Some(preview) = &screen.preview {
            <section class={Card} aria-labelledby="repricing-scope-title" data-repricing-scope="true">
                <h3 id="repricing-scope-title" class={Hidden}>{t.editor_scope()}</h3>
                <dl class={Stats}>
                    <div class={Stat}>
                        <dt>{t.editor_scope_matching()}</dt>
                        <dd>{count(t, preview.matching)}</dd>
                    </div>
                    <div class={Stat}>
                        <dt>{t.editor_scope_governed()}</dt>
                        <dd>{count(t, preview.governed)}</dd>
                    </div>
                </dl>
                if !preview.shadowed_by.is_empty() {
                    <p class={Strong}>{t.editor_scope_shadowed()}</p>
                    <ul class={Plain}>
                        for policy in &preview.shadowed_by {
                            <li>{&policy.name}{": "}{count(t, policy.count)}</li>
                        }
                    </ul>
                }
                if !preview.taken_from.is_empty() {
                    <p class={Strong}>{t.editor_scope_taken()}</p>
                    <ul class={Plain}>
                        for policy in &preview.taken_from {
                            <li>{&policy.name}{": "}{count(t, policy.count)}</li>
                        }
                    </ul>
                }
            </section>
        } else {
            <div class={Banner} data-tone="danger" role="status">
                <p>{t.editor_scope_error()}</p>
            </div>
        }
    }
}

/// The dry run's part, drawn on the page and again by its live relay (`DryRunResult`): the run's
/// state, then, once it completed, its counts, the price change distribution, the samples (100 at
/// a time) and Activate.
pub fn repricing_dry_run_part<'a>(t: RepricingMsg, p: Pilot, view: &'a DryRunView) -> impl Render + 'a {
    html! { <DryRunPart t={t} p={p} view={view} /> }
}

#[component(css = RepricingPage)]
fn DryRunPart<'a>(t: RepricingMsg, p: Pilot, view: &'a DryRunView) -> impl Render {
    let run = &view.run;
    let summary = run.summary.as_ref().filter(|_| run.status == "completed");
    let w = WriteForm::FIELDS;
    let flag = move |key: &str| summary.and_then(|s| s.flags.get(key)).copied().unwrap_or_default();
    let outcome = move |key: &str| summary.and_then(|s| s.outcomes.get(key)).copied().unwrap_or_default();
    let skipped = move |key: &str| summary.and_then(|s| s.skip_reasons.get(key)).copied().unwrap_or_default();
    let bucket = move |i: usize| summary.and_then(|s| s.delta_buckets.get(&i.to_string())).copied().unwrap_or_default();
    let next = match &view.traces {
        Traces::Read(traces) if traces.len() == 100 => traces.last().map(|last| {
            let mut place = view.place.clone();
            place.after = Some(last.listing_id.clone());
            url::Repricing { place }
        }),
        _ => None,
    };
    let again = url::Repricing { place: view.place.clone() };
    html! {
        <section id={DryRunPartId} class={(Card, Run)} aria-labelledby="repricing-run-title" data-repricing-run={&run.status}>
            <h3 id="repricing-run-title" class={PartTitle}>{t.editor_preview_samples()}</h3>
            if run.status == "failed" {
                <div class={Banner} data-tone="danger" role="alert">
                    <p>{t.editor_preview_failed()}</p>
                </div>
            } else if let Some(summary) = summary {
                <p class={Muted}>
                    {t.editor_preview_completed(&when(t, run.completed_at.as_deref().unwrap_or(&run.updated_at)), &count(t, summary.listings_evaluated))}
                </p>
                if summary.listings_evaluated == 0 {
                    <div class={Banner} data-tone="info"><p>{t.editor_preview_empty()}</p></div>
                }
                if !view.current {
                    <div class={Banner} data-tone="warning" role="status" data-repricing-stale="true">
                        <p>{p.repricing_changed()}</p>
                    </div>
                }
                <dl class={Stats}>
                    <div class={Stat}>
                        <dt>{t.editor_preview_evaluated()}</dt>
                        <dd>{count(t, summary.listings_evaluated)}</dd>
                    </div>
                    <div class={Stat}>
                        <dt>{t.editor_preview_changed()}</dt>
                        <dd data-repricing-changed="true">{count(t, outcome("changed"))}</dd>
                    </div>
                    <div class={Stat}>
                        <dt>{t.editor_preview_tolerance()}</dt>
                        <dd>{count(t, summary.within_tolerance)}</dd>
                    </div>
                </dl>
                <dl class={Facts}>
                    <div>
                        <dt>{t.activity_clamp_floor()}</dt>
                        <dd>{count(t, flag("floor-binding"))}</dd>
                    </div>
                    <div>
                        <dt>{t.activity_clamp_ceiling()}</dt>
                        <dd>{count(t, flag("ceiling-binding"))}</dd>
                    </div>
                    <div>
                        <dt>{t.activity_clamp_max_move()}</dt>
                        <dd>{count(t, flag("max-move-binding"))}</dd>
                    </div>
                    <div>
                        <dt>{t.editor_preview_paused()}</dt>
                        <dd>{count(t, outcome("pause-requested"))}</dd>
                    </div>
                    <div>
                        <dt>{t.editor_preview_notified()}</dt>
                        <dd>{count(t, outcome("notify-only"))}</dd>
                    </div>
                    <div>
                        <dt>{t.editor_preview_held()}</dt>
                        <dd>{count(t, skipped("terminal-hold"))}</dd>
                    </div>
                </dl>
                <table class={Table}>
                    <caption class={Strong}>{t.editor_preview_buckets()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.editor_preview_delta()}</th>
                            <th scope="col" class={Number}>{t.editor_preview_count()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for i in 0..9usize {
                            <tr>
                                <th scope="row" data-label={t.editor_preview_delta()}>
                                    {keyed(t, &format!("editor.bucket.{i}"))}
                                </th>
                                <td class={Number} data-label={t.editor_preview_count()}>{count(t, bucket(i))}</td>
                            </tr>
                        }
                    </tbody>
                </table>
                if let Traces::Failed = &view.traces {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p>{t.editor_preview_samples_failed()}</p>
                        <p><a href={&again}>{t.editor_retry()}</a></p>
                    </div>
                }
                if let Traces::Read(traces) = &view.traces {
                    <table class={Table} data-repricing-samples="true">
                        <caption class={Strong}>{t.editor_preview_samples()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.editor_preview_listing()}</th>
                                <th scope="col">{t.editor_preview_result()}</th>
                                <th scope="col">{t.editor_anchor()}</th>
                                <th scope="col" class={Number}>{t.editor_preview_price()}</th>
                                <th scope="col">{t.editor_preview_clamps()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for trace in traces {
                                <tr>
                                    <th scope="row" class={Code} data-label={t.editor_preview_listing()}>{&trace.listing_id}</th>
                                    <td data-label={t.editor_preview_result()}>{result(t, trace)}</td>
                                    <td data-label={t.editor_anchor()}>{anchor(t, trace)}</td>
                                    <td class={Number} data-label={t.editor_preview_price()}>
                                        {money(t, trace.target_price_amount.as_deref().unwrap_or(&trace.current_price_amount), rule_currency(run, trace.rule_index))}
                                    </td>
                                    <td data-label={t.editor_preview_clamps()}>{clamps(t, trace)}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                    if let Some(next) = &next {
                        <p><a class={(Button, Secondary)} href={next}>{t.editor_preview_more()}</a></p>
                    }
                }
                <div class={Actions}>
                    <button
                        type="submit"
                        class={Button}
                        form={EditorFormId}
                        formmethod="post"
                        name={w.intent}
                        value="create-policy"
                        disabled={!view.activates()}
                        data-repricing-activate="true"
                    >
                        {t.editor_activate()}
                    </button>
                </div>
            } else {
                <div class={Banner} data-tone="info" role="status">
                    <p class={Strong}>{t.editor_preview_running()}</p>
                    <p class={Reconnecting}>{t.editor_preview_reconnecting()}</p>
                    <noscript><p><a href={&again}>{p.repricing_refresh()}</a></p></noscript>
                </div>
            }
        </section>
    }
}

/// A number as marketplace writes it into a message: a whole number without a fraction.
fn num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { n.to_string() }
}

/// A rule's condition in words (`conditionLabel`).
fn condition(t: RepricingMsg, p: Pilot, condition: &RepricingCondition) -> String {
    match condition {
        RepricingCondition::Category { category_id } => t.body_condition_category(category_id).to_string(),
        RepricingCondition::ItemGrading { grading } if grading == "graded" => t.body_condition_graded().to_owned(),
        RepricingCondition::ItemGrading { .. } => t.body_condition_raw().to_owned(),
        RepricingCondition::QuantityAtLeast { quantity } => t.body_condition_quantity_at_least(&num(*quantity)).to_string(),
        RepricingCondition::ListingAgeAtLeast { days } => t.body_condition_listing_age_at_least(&num(*days)).to_string(),
        RepricingCondition::CostBasisPresent => t.body_condition_cost_basis_present().to_owned(),
        RepricingCondition::CostBasisAbsent => t.body_condition_cost_basis_absent().to_owned(),
        RepricingCondition::CompetingListingCountAtLeast { count } => {
            t.body_condition_competing_listing_count_at_least(&num(*count)).to_string()
        }
        RepricingCondition::ScheduleWindow { days_of_week, start_time, end_time } => {
            t.body_condition_schedule_window(start_time, end_time, &days_of_week.len().to_string()).to_string()
        }
        RepricingCondition::Other => p.repricing_unknown_setting().to_owned(),
    }
}

/// A pricing goal in words (`repricingGoalLabel`); one the pilot does not know is its id.
fn goal(t: RepricingMsg, id: &str, parameters: &std::collections::BTreeMap<String, f64>) -> String {
    let at = |key: &str| parameters.get(key).map(|n| num(*n)).unwrap_or_default();
    match id {
        "fixed-percentile" => t.goal_fixed_percentile(&at("percentile")).to_string(),
        "target-horizon" => t.goal_target_horizon(&at("horizonDays")).to_string(),
        "profit-per-day" => t.goal_profit_per_day().to_owned(),
        "hold-value" => t.goal_hold_value().to_owned(),
        "cash-target" => t.goal_cash_target(&at("amount"), &at("days")).to_string(),
        other => other.to_owned(),
    }
}

/// An anchor in words (`anchorLabel`).
fn anchor_words(t: RepricingMsg, p: Pilot, anchor: &RepricingAnchor) -> String {
    match anchor {
        RepricingAnchor::MarketEstimate => t.body_anchor_market_estimate().to_owned(),
        RepricingAnchor::LowestCompetingAsk { strata: Some(strata), band } if strata == "any" => {
            let percent = band.as_ref().map(|band| num(band.min_percent_of_ground)).unwrap_or_default();
            t.body_anchor_lowest_any_listing(&percent).to_string()
        }
        RepricingAnchor::LowestCompetingAsk { .. } => t.body_anchor_lowest_manual_listing().to_owned(),
        RepricingAnchor::CompPercentile { percentile } => t.body_anchor_comp_percentile(&num(*percentile)).to_string(),
        RepricingAnchor::LastSold => t.body_anchor_last_sold().to_owned(),
        RepricingAnchor::CurveObjective { goal_id, parameters } => {
            t.body_anchor_curve_objective(&goal(t, goal_id, parameters)).to_string()
        }
        RepricingAnchor::Other => p.repricing_unknown_setting().to_owned(),
    }
}

/// The anchor chain: each anchor, then the next (`anchorChainLabel`).
fn anchor_chain(t: RepricingMsg, p: Pilot, chain: &[RepricingAnchor]) -> String {
    let mut words = chain.iter().rev().map(|anchor| anchor_words(t, p, anchor));
    let Some(last) = words.next() else {
        return t.activity_anchor_none().to_owned();
    };
    words.fold(last, |rest, first| t.body_anchor_then(&first, &rest).to_string())
}

/// A rule's summary (`summarizeRepricingRule`): each setting's name and words.
fn rule_summary(t: RepricingMsg, p: Pilot, rule: &RepricingRule) -> Vec<(&'static str, String)> {
    let d = &rule.directive;
    let cur = d.currency_code.as_deref();
    let unknown = || p.repricing_unknown_setting().to_owned();
    let when = if rule.conditions.is_empty() {
        t.body_condition_none().to_owned()
    } else {
        rule.conditions.iter().map(|c| condition(t, p, c)).collect::<Vec<_>>().join(" \u{b7} ")
    };
    let offset = match &d.offset {
        RepricingOffset::Percent { percent } => {
            let signed = if *percent > 0.0 { format!("+{}", num(*percent)) } else { num(*percent) };
            t.body_offset_percent(&signed).to_string()
        }
        RepricingOffset::Absolute { amount } => t.body_offset_absolute(&money(t, amount, cur)).to_string(),
        RepricingOffset::Other => unknown(),
    };
    let floor = match &d.floor {
        RepricingFloor::Absolute { amount } => money(t, amount, cur),
        RepricingFloor::CostBasisPlusMargin { margin_percent, absolute_fallback_amount } => {
            t.body_floor_cost_basis_plus_margin(&num(*margin_percent), &money(t, absolute_fallback_amount, cur)).to_string()
        }
        RepricingFloor::Other => unknown(),
    };
    let ceiling = match &d.ceiling {
        None => t.body_ceiling_none().to_owned(),
        Some(RepricingCeiling::Absolute { amount }) => money(t, amount, cur),
        Some(RepricingCeiling::Percent { percent }) => t.body_ceiling_percent(&num(*percent)).to_string(),
        Some(RepricingCeiling::Other) => unknown(),
    };
    let tolerance = match &d.tolerance {
        RepricingTolerance::Percent { percent } => t.body_tolerance_percent(&num(*percent)).to_string(),
        RepricingTolerance::Absolute { amount } => t.body_tolerance_absolute(&money(t, amount, cur)).to_string(),
        RepricingTolerance::Other => unknown(),
    };
    let rounding = match &d.rounding {
        RepricingRounding::None => t.body_rounding_none().to_owned(),
        RepricingRounding::Charm => t.body_rounding_charm().to_owned(),
        RepricingRounding::Increment { increment_amount } => {
            t.body_rounding_increment(&money(t, increment_amount, cur)).to_string()
        }
        RepricingRounding::Other => unknown(),
    };
    let max_move = match d.max_move_percent {
        None => t.body_max_move_none().to_owned(),
        Some(percent) => t.body_max_move_percent(&num(percent)).to_string(),
    };
    let terminal = match &d.terminal {
        RepricingTerminal::Hold => t.body_terminal_hold().to_owned(),
        RepricingTerminal::Pause => t.body_terminal_pause().to_owned(),
        RepricingTerminal::FallbackPrice { amount } => t.body_terminal_fallback_price(&money(t, amount, cur)).to_string(),
        RepricingTerminal::PriceAtFloor => t.body_terminal_price_at_floor().to_owned(),
        RepricingTerminal::NotifyOnly => t.body_terminal_notify_only().to_owned(),
        RepricingTerminal::Other => unknown(),
    };
    vec![
        (t.body_rule_when(), when),
        (t.body_rule_anchor(), anchor_chain(t, p, &d.anchor_chain)),
        (t.body_rule_offset(), offset),
        (t.body_rule_floor(), floor),
        (t.body_rule_ceiling(), ceiling),
        (t.body_rule_tolerance(), tolerance),
        (t.body_rule_rounding(), rounding),
        (t.body_rule_max_move(), max_move),
        (t.body_rule_terminal(), terminal),
    ]
}

/// A filter's name: a skip reason's words, or the filter's own (`repricingActivityFilterCopyKeys`).
fn filter_name(t: RepricingMsg, filter: &str) -> String {
    let own = matches!(filter, "changed" | "paused-for-missing-input" | "floor-binding" | "spiral-breaker");
    let group = if own { "activity.filter_name" } else { "activity.skip" };
    keyed(t, &format!("{group}.{}", filter.replace('-', "_")))
}

/// A sample's outcome tone (`outcomeTone`).
fn outcome_tone(outcome: &str) -> &'static str {
    match outcome {
        "changed" => "success",
        "pause-requested" => "warning",
        "notify-only" => "info",
        _ => "neutral",
    }
}

/// The current price, and the target when it moves (`priceLabel`).
fn price(t: RepricingMsg, trace: &RepricingTrace, currency: Option<&str>) -> String {
    let current = money(t, &trace.current_price_amount, currency);
    match trace.target_price_amount.as_deref() {
        Some(target) if target != trace.current_price_amount => {
            t.activity_price_change(&current, &money(t, target, currency)).to_string()
        }
        _ => current,
    }
}

/// Shown instead of a policy while a change just saved is still reaching it
/// (`PricingRepricingPolicyCatchingUpPage`); the page reads itself again in 2 s.
#[component(css = RepricingPage)]
pub fn RepricingPolicyCatchingUp(t: RepricingMsg, refresh: String) -> impl Render {
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.detail_eyebrow()}</p>
            <h1 class={Title}>{t.shared_catching_up_title()}</h1>
            <nav class={Row}>
                <a class={(Button, Secondary)} href={url::Repricing::default()}>{t.detail_back()}</a>
            </nav>
        </header>
        <div class={Banner} data-tone="info" role="status" data-repricing-catching-up="true">
            <p class={Strong}>{t.shared_catching_up_title()}</p>
            <p>{t.detail_catching_up_description()}</p>
            <p><a href={&refresh}>{t.shared_catching_up_refresh()}</a></p>
        </div>
    }
}

/// A policy's page (`PricingRepricingPolicyDetailPage`): the header with its actions, what a write
/// was refused for, the halt, the settings, the rules and the activity. Every action is a form;
/// Delete and the halt ask first in a dialog. Edit opens marketplace's editor (not ported).
#[component(css = RepricingPage)]
pub fn RepricingPolicyPage<'a>(t: RepricingMsg, p: Pilot, screen: &'a PolicyScreen) -> impl Render {
    let policy = &screen.policy;
    let (label, tone) = status(t, &policy.status, screen.halt.engaged);
    let name = policy.name.as_deref().unwrap_or(t.list_unnamed());
    let here = policy_href(&screen.id);
    let edit = super::on_marketplace(&format!("/account/desk/repricing/{}?edit=1", segment(&screen.id)));
    let deletable = policy.status != "deleted";
    let change = match policy.status.as_str() {
        "active" => Some(("pause-policy", t.shared_pause())),
        "paused" => Some(("resume-policy", t.shared_resume())),
        _ => None,
    };
    let f = PolicyForm::FIELDS;
    let cap = policy.max_changes_per_day.map_or_else(|| t.detail_field_cap_none().to_owned(), |cap| count(t, cap));
    let updated = policy.updated_at.as_deref().map(|at| when(t, at)).unwrap_or_default();
    let settings = [
        (t.detail_field_status(), label.to_owned()),
        (t.detail_field_scope(), scope(t, policy.scope.as_ref())),
        (t.detail_field_exclusions(), count(t, policy.excluded_listing_ids.len() as u64)),
        (t.detail_field_cap(), cap),
        (t.detail_field_budget(), budget(t, screen.changes_used_today, policy.max_changes_per_day)),
        (t.detail_field_updated(), updated),
    ];
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.detail_eyebrow()}</p>
            <h1 class={Title}>{name}</h1>
            <p><span class={Badge} data-tone={tone} data-repricing-policy-status={&policy.status}>{label}</span></p>
            <nav class={Row} aria-label={p.repricing_policy_actions()}>
                <a class={(Button, Secondary)} href={url::Repricing::default()}>{t.detail_back()}</a>
                if screen.manage && deletable {
                    <a class={(Button, Secondary)} href={&edit}>{t.editor_revise()}</a>
                    if let Some((value, words)) = change {
                        <form class={Inline} method="post" action={&here}>
                            <button type="submit" class={(Button, Secondary)} name={f.intent} value={value}>{words}</button>
                        </form>
                    }
                    <button type="button" class={(Button, Caution)} command="show-modal" commandfor={DeleteDialogId}>
                        {t.detail_delete()}
                    </button>
                }
            </nav>
            if screen.manage && deletable {
                <dialog
                    id={DeleteDialogId}
                    class={Dialog}
                    aria-labelledby="repricing-delete-ask"
                    aria-describedby="repricing-delete-asked"
                >
                    <h2 id="repricing-delete-ask" class={PartTitle}>{t.detail_delete_title()}</h2>
                    <p id="repricing-delete-asked" class={Muted}>{t.detail_delete_description()}</p>
                    <form class={Actions} method="post" action={&here}>
                        <button type="button" class={(Button, Secondary)} command="close" commandfor={DeleteDialogId}>
                            {t.shared_cancel()}
                        </button>
                        <button type="submit" class={(Button, Caution)} name={f.intent} value="delete-policy">
                            {t.detail_delete_confirm()}
                        </button>
                    </form>
                </dialog>
            }
        </header>
        if let Some(details) = &screen.refusal {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{t.shared_action_error_title()}</p>
                <ul class={Plain}>
                    for detail in details {
                        <li>{detail}</li>
                    }
                </ul>
            </div>
        }
        <HaltPart
            t={t}
            halt={&screen.halt}
            failed={screen.halt_failed}
            manage={screen.manage}
            action={here.clone()}
            intent={f.intent}
        />
        <section class={Section} aria-labelledby="repricing-settings-title">
            <div class={Tight}>
                <h2 id="repricing-settings-title" class={PartTitle}>{t.detail_settings_title()}</h2>
                <p class={Muted}>{t.detail_settings_description()}</p>
            </div>
            <dl class={Pairs} data-repricing-policy-settings="true">
                for (key, value) in &settings {
                    <div>
                        <dt>{*key}</dt>
                        <dd>{value}</dd>
                    </div>
                }
            </dl>
        </section>
        <section class={Section} aria-labelledby="repricing-rules-title">
            <div class={Tight}>
                <h2 id="repricing-rules-title" class={PartTitle}>{t.detail_rules_title()}</h2>
                <p class={Muted}>{t.detail_rules_description()}</p>
            </div>
            <ol class={Rules} data-repricing-policy-rules="true">
                for (index, rule) in policy.rules.iter().enumerate() {
                    <li class={Card}>
                        <h3 class={Strong}>{t.body_rule(&(index + 1).to_string())}</h3>
                        <dl class={Pairs}>
                            for (key, value) in rule_summary(t, p, rule) {
                                <div>
                                    <dt>{key}</dt>
                                    <dd>{&value}</dd>
                                </div>
                            }
                        </dl>
                    </li>
                }
            </ol>
        </section>
        <ActivityPart t={t} screen={screen} />
    }
}

/// The policy's activity (`PricingRepricingActivityPanel`): the three counts always shown, a link
/// per filter with its count, the rows, and Show more activity. Each is an address, so it works
/// without a script.
#[component(css = RepricingPage)]
fn ActivityPart<'a>(t: RepricingMsg, screen: &'a PolicyScreen) -> impl Render {
    let at = |filter: Option<&str>, after: Option<&str>| {
        url::RepricingPolicy {
            id: &screen.id,
            place: PolicyPlace { filter: filter.map(str::to_owned), after: after.map(str::to_owned), ..PolicyPlace::default() },
        }
        .href()
    };
    let counts = screen.activity.as_ref().map(|page| &page.filter_counts);
    let rows: &[RepricingActivityRow] = screen.activity.as_ref().map_or(&[], |page| &page.rows);
    let next = screen.activity.as_ref().and_then(|page| page.next.as_deref());
    let currency = |rule: usize| screen.policy.rules.get(rule).and_then(|r| r.directive.currency_code.as_deref());
    let counted = |filter: &str| count(t, counts.and_then(|counts| counts.get(filter)).copied().unwrap_or_default());
    let stats: Vec<(String, String)> = ALWAYS_COUNTED.iter().map(|f| (filter_name(t, f), counted(f))).collect();
    let chips: Vec<(String, String, bool)> = FILTERS
        .iter()
        .map(|f| {
            (at(Some(f), None), t.activity_filter_label(&filter_name(t, f), &counted(f)).to_string(), screen.filter == Some(*f))
        })
        .collect();
    let shown = counts.is_some();
    html! {
        <section
            class={Section}
            aria-labelledby="repricing-activity-title"
            data-repricing-activity-filter={screen.filter.unwrap_or("all")}
        >
            <div class={Tight}>
                <h2 id="repricing-activity-title" class={PartTitle}>{t.activity_title()}</h2>
                <p class={Muted}>{t.activity_description()}</p>
            </div>
            if shown {
                <dl class={Stats} data-repricing-activity-counts="true">
                    for (name, value) in &stats {
                        <div class={Stat}>
                            <dt>{name}</dt>
                            <dd>{value}</dd>
                        </div>
                    }
                </dl>
                <nav class={Chips} aria-label={t.activity_filters_label()}>
                    <a
                        class={(Button, Secondary, Chip)}
                        href={&at(None, None)}
                        aria-current={screen.filter.is_none().then_some("true")}
                    >
                        {t.activity_filter_all()}
                    </a>
                    for (href, label, current) in &chips {
                        <a class={(Button, Secondary, Chip)} href={href} aria-current={current.then_some("true")}>
                            {label}
                        </a>
                    }
                </nav>
            }
            if screen.activity.is_none() {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.activity_error_title()}</p>
                    <p>{t.activity_error_description()}</p>
                </div>
            } else if rows.is_empty() {
                <div class={(Card, Empty)} data-repricing-activity-empty="true">
                    <p class={Strong}>{t.activity_empty_title()}</p>
                    <p class={Muted}>{t.activity_empty_description()}</p>
                </div>
            } else {
                <table class={Table} data-repricing-activity="true">
                    <caption class={Hidden}>{t.activity_caption()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.activity_column_listing()}</th>
                            <th scope="col">{t.activity_column_result()}</th>
                            <th scope="col">{t.activity_column_anchor()}</th>
                            <th scope="col" class={Number}>{t.activity_column_price()}</th>
                            <th scope="col">{t.activity_column_clamps()}</th>
                            <th scope="col">{t.activity_column_evaluated()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for row in rows {
                            <tr data-repricing-activity-row={&row.listing_id}>
                                <th scope="row" class={Code} data-label={t.activity_column_listing()}>{&row.listing_id}</th>
                                <td data-label={t.activity_column_result()}>
                                    <span class={Badge} data-tone={outcome_tone(&row.trace.outcome)}>
                                        {result(t, &row.trace)}
                                    </span>
                                    if row.affected_listing_count > 0 {
                                        " "
                                        <span class={Badge} data-tone="warning">
                                            {t.activity_frozen(&count(t, row.affected_listing_count))}
                                        </span>
                                        if let Some(until) = &row.frozen_until {
                                            <span class={Hint}>{t.activity_frozen_until(&when(t, until))}</span>
                                        }
                                    }
                                </td>
                                <td data-label={t.activity_column_anchor()}>{anchor(t, &row.trace)}</td>
                                <td class={Number} data-label={t.activity_column_price()}>
                                    {price(t, &row.trace, currency(row.trace.rule_index))}
                                </td>
                                <td data-label={t.activity_column_clamps()}>{clamps(t, &row.trace)}</td>
                                <td data-label={t.activity_column_evaluated()}>{when(t, &row.evaluated_at)}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            }
            if let Some(next) = next.filter(|_| screen.activity.is_some()) {
                <p class={Row}>
                    <a class={(Button, Secondary)} href={&at(screen.filter, Some(next))}>{t.activity_more()}</a>
                </p>
            }
        </section>
    }
}
