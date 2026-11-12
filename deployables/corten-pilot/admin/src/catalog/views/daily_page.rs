//! The daily workbench (admin-web's `CatalogIntegrationImportToPromotionWorkspace` in its
//! `CatalogWorkbenchShell`): the shell, the governance and health banners, the flow's steps and
//! blockers, then its three stages, the open one expanded. The stages are `<details>` sharing a
//! name, so opening one closes the others and find-in-page opens the one that holds a match, with
//! no script. Every command is a form that posts to the pilot and lands back on the working set;
//! the rows' boxes sit inside their form, so a defer, a reject or a sync sends the checked ones
//! without JavaScript. Each table stacks on a phone, a row a block of labelled lines.
use corten::prelude::*;
use corten::{Href, Local};
use platform::{
    theme::gap_4,
    ui::{
        accordion::Accordion,
        alert::{AlertEmphasis, FormAlert},
        button::{Button, ButtonSize, ButtonVariant},
        checkbox::Checkbox,
        dialog::{Dialog, DialogFooter, DialogHeader, DialogSize},
        input::Input,
        pagination::PreviousNext,
        radio_group::{Radio, RadioGroup},
        sheet::{Sheet, SheetHeader, SheetWidth, Side},
        stack::{Gap, Stack as KitStack},
        steps::{Step, StepState, Steps, StepsLayout},
        table::{CellLabel, Table, TableLayout},
        textarea::Textarea,
        visually_hidden::VisuallyHidden,
    },
};

use super::integrations_page::{
    Banner, Blockers, Cell, Counts, Empty, Evidence, Module, Pairs, Pill, Shell, maybe_when, state_label, when,
};
use crate::{
    catalog::{
        api::AliasReview,
        daily::{
            self, CANDIDATE_COMMANDS, Candidate, CandidateInput, ContentsLine, Daily, DailyScreen, EditForm, EvidenceDetail,
            Governance, Health, ImportJob, ImportPreview, JobInput, ObservationEvidence, PROMOTION_INTENTS, PreflightPart,
            PromotionInput, PromotionPreview, Ran, ReviewInput, ReviewRow, Said, Stage, StageState, SyncInput, SyncRun,
            UnitInput, UnitState, WorksetUnit, at, with_query,
        },
        integrations,
        views::AliasReviewPart,
    },
    text::{Cat, Pilot},
    views::{admin_web, link_to},
};

/// The form whose refusal the page draws (a refused command's message at the top of the page).
#[derive(Id, Clone, Copy)]
pub struct DailyRefusalId;

/// A refused command's message, where the page's notice goes, in the kit's destructive alert.
#[component(css = DailyPage)]
pub fn DailyRefusal<'a>(errors: &'a Errors) -> impl Patch {
    html! {
        <div class={Notice} id={DailyRefusalId}>
            <FormAlert errors={errors} emphasis={AlertEmphasis::Outline} />
        </div>
    }
}

fn stage_label(t: Cat, stage: Stage) -> &'static str {
    match stage {
        Stage::RunSync => t.wb_stage_run_sync_label(),
        Stage::Review => t.wb_stage_review_label(),
        Stage::Create => t.wb_stage_create_label(),
    }
}

fn stage_description(t: Cat, stage: Stage) -> &'static str {
    match stage {
        Stage::RunSync => t.wb_stage_run_sync_description(),
        Stage::Review => t.wb_stage_review_description(),
        Stage::Create => t.wb_stage_create_description(),
    }
}

/// A stage's summary line (`buildFlowStages`' `summary`).
fn stage_summary(t: Cat, model: &Daily, stage: Stage) -> String {
    let review = &model.source_observation_review;
    match stage {
        Stage::RunSync => t
            .wb_stage_run_sync_summary(crate::text::cat::WbStageRunSyncSummary {
                active: model.import_jobs.active_job_count,
                observed: review.counts.observed,
                changed: review.counts.changed,
            })
            .to_string(),
        Stage::Review => t
            .wb_stage_review_summary(crate::text::cat::WbStageReviewSummary {
                changed: review.counts.changed,
                ready: review.promotion_ready_count,
            })
            .to_string(),
        Stage::Create => match &model.promotion_result {
            Some(result) => t.wb_stage_create_summary(result.promoted_catalog_item_ids.len()).to_string(),
            None => t.wb_stage_create_summary_pending().to_owned(),
        },
    }
}

fn step_state(p: Pilot, state: StageState) -> StepState<'static> {
    match state {
        StageState::Complete => StepState::Done(p.steps_done()),
        StageState::Current => StepState::Current,
        StageState::Blocked => StepState::Blocked(p.steps_blocked()),
        StageState::Upcoming => StepState::Todo(p.steps_not_started()),
    }
}

/// An address on the pilot (or admin-web) for the working set `context` on `path`.
fn on(req: &Req, path: &str, context: &str) -> Option<String> {
    link_to(req, &at(path, context))
}

/// The page: the shell around the banners, the steps, the blockers and the stages.
#[component(css)]
pub fn DailyPage<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    screen: &'a DailyScreen,
    context: &'a str,
    said: Option<&'a Said<'a>>,
) -> impl Render {
    let model = &screen.read.read_model;
    let review = &model.source_observation_review;
    let counts = Counts {
        observed: review.counts.observed,
        changed: review.counts.changed,
        ready: review.promotion_ready_count,
        active_jobs: model.import_jobs.active_job_count,
        freshness: &model.import_jobs.freshness,
        destructive: model.promotion_preview.destructive_count,
    };
    html! {
        <Shell t={t} back={None} counts={counts}>
            match said {
                Some(Said::Ran(ran)) => {
                    let (title, description) = match ran {
                        Ran::Queued => (t.feedback_queued_title(), t.feedback_queued_description()),
                        Ran::Cancelled => (t.feedback_cancelled_title(), t.feedback_cancelled_description()),
                    };
                    <div class={Notice} id={DailyRefusalId} role="status">
                        <Banner tone="success" title={title} description={description} />
                    </div>
                }
                Some(Said::Refused(errors)) => { <DailyRefusal errors={errors} /> }
                None => { <div class={Notice} id={DailyRefusalId}></div> }
            }
            <Signals t={t} req={req} model={model} context={context} />
            <super::ImportContext
                t={t}
                route={&model.route_context}
                providers={&model.provider_scope}
                skeleton={&model.source_options}
                options={screen.source_options()}
                context={context}
            />
            <WorksetModule t={t} p={p} req={req} model={model} context={context} manage={screen.manage} />
            <Stages t={t} p={p} req={req} screen={screen} context={context} />
        </Shell>
    }
}

/// The governance and health banners, each drawn only on its own signal, with the page that
/// settles it.
#[component(css = DailyPage)]
pub fn Signals<'a>(t: Cat, req: &'a Req, model: &'a Daily, context: &'a str) -> impl Render {
    let context = with_query(context, &[(daily::HOME, None)]);
    let settings = on(req, &integrations::url::Settings.href(), &context);
    let health = on(req, &integrations::url::Health.href(), &context);
    html! {
        match daily::governance(model) {
            Some(status) => {
                let (title, description) = match status {
                    Governance::Denied => (t.wb_gov_status_denied_title(), t.wb_gov_status_denied_description()),
                    Governance::Stopped => (t.wb_gov_status_stopped_title(), t.wb_gov_status_stopped_description()),
                };
                <div
                    class={Signal}
                    data-catalog-daily-governance-status={if status == Governance::Denied { "denied" } else { "stopped" }}
                >
                    <Banner tone="danger" title={title} description={description} />
                    if let Some(href) = &settings {
                        <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={href}>
                            {t.wb_gov_status_open()}
                        </a>
                    }
                </div>
            }
            None => {}
        }
        match daily::health(model) {
            Some(status) => {
                let (tone, title, description) = match status {
                    Health::Blocked => ("danger", t.wb_health_status_blocked_title(), t.wb_health_status_blocked_description()),
                    Health::Degraded => ("warning", t.wb_health_status_degraded_title(), t.wb_health_status_degraded_description()),
                };
                <div
                    class={Signal}
                    data-catalog-daily-health-status={if status == Health::Blocked { "blocked" } else { "degraded" }}
                >
                    <Banner tone={tone} title={title} description={description} />
                    if let Some(href) = &health {
                        <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={href}>
                            {t.wb_health_status_open()}
                        </a>
                    }
                </div>
            }
            None => {}
        }
    }
}

/// The flow's steps and blockers, then its three stages, the open one expanded, for the working set
/// `context` (drawn on the daily workbench, and on a scope's page).
#[component(css = DailyPage)]
pub fn Stages<'a>(t: Cat, p: Pilot, req: &'a Req, screen: &'a DailyScreen, context: &'a str) -> impl Render {
    let model = &screen.read.read_model;
    let open = daily::open_stage(model);
    let flow = daily::flow(model);
    let blockers = daily::blockers(model);
    let blocker_names: Vec<String> = blockers.iter().map(|b| (*b).to_owned()).collect();
    html! {
        let steps: Vec<Step> = flow
            .iter()
            .map(|(stage, state)| Step {
                label: stage_label(t, *stage),
                description: Some(stage_description(t, *stage)),
                link: None,
                state: step_state(p, *state),
            })
            .collect();
        <Steps label={t.wb_stage_flow_title()} layout={StepsLayout::Row} steps={&steps} />
        if !blocker_names.is_empty() {
            <section class={Blocked} aria-labelledby="wb-blockers">
                <h2 id="wb-blockers">{t.wb_stage_blockers_title()}</h2>
                <p>{t.wb_stage_blockers_summary(blocker_names.len()).to_string()}</p>
                <Blockers t={t} blockers={&blocker_names} />
            </section>
        }
        <div class={Stages}>
            for (stage, _) in &flow {
                let stage = *stage;
                let summary = stage_summary(t, model, stage);
                <details
                    class={(Accordion {}, StageBox)}
                    name="wb-stage"
                    open={stage == open}
                    data-catalog-import-workflow-stage={stage.key()}
                >
                    <summary>
                        <span class={StageHead}>
                            <span class={StageName}>{stage_label(t, stage)}</span>
                            <span class={StageSummary}>{summary}</span>
                        </span>
                    </summary>
                    <div class={StageBody}>
                        match stage {
                            Stage::RunSync => {
                                <p class={Lead}>{t.wb_stage_run_sync_description()}</p>
                                <SyncModule
                                    t={t}
                                    p={p}
                                    model={model}
                                    run={screen.run.as_ref()}
                                    units={&screen.units}
                                    context={context}
                                    manage={screen.manage}
                                />
                                <JobsModule
                                    t={t}
                                    p={p}
                                    req={req}
                                    model={model}
                                    preflight={&screen.preflight}
                                    context={context}
                                    manage={screen.manage}
                                />
                            }
                            Stage::Review => {
                                <CandidatesModule t={t} p={p} model={model} context={context} manage={screen.manage} />
                                <ReviewModule
                                    t={t}
                                    p={p}
                                    req={req}
                                    model={model}
                                    context={context}
                                    manage={screen.manage}
                                    aliases={screen.aliases.as_ref()}
                                />
                            }
                            Stage::Create => {
                                <CreateModule t={t} p={p} req={req} model={model} context={context} manage={screen.manage} />
                            }
                        }
                    </div>
                </details>
            }
        </div>
        <EvidenceSheet t={t} p={p} evidence={screen.evidence.as_ref()} context={context} />
    }
}

fn workset_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "degraded" | "scope-required" => "warning",
        "blocked" => "danger",
        _ => "neutral",
    }
}

fn workset_unit_tone(state: &str) -> &'static str {
    match state {
        "promoted" => "success",
        "changed" => "warning",
        "blocked" => "danger",
        "imported" => "info",
        _ => "neutral",
    }
}

/// The selected source scope (`CatalogSourceScopeWorksetModule`): the scope and its counts, then each
/// provider unit with its state, the way to open its scope, and its Sync, Preview and Reapply. Sync
/// and Reapply post the scopes the API built for the unit, and Preview the unit's promotion the read
/// built. Nothing draws without a unit, as there.
#[component(css = DailyPage)]
fn WorksetModule<'a>(t: Cat, p: Pilot, req: &'a Req, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let workset = &model.source_scope_workset;
    let summary = &workset.summary;
    let items = [
        (t.wb_workset_selected_scope(), workset.selected_scope.label.clone()),
        (t.wb_workset_changed(), summary.changed_observation_count.to_string()),
        (t.wb_workset_promoted(), summary.promoted_observation_count.to_string()),
        (t.wb_workset_active_imports(), summary.active_import_count.to_string()),
    ];
    html! {
        if !workset.units.is_empty() {
            <div class={Workset} data-catalog-source-scope-workset={&workset.status}>
                <Module
                    id="wb-workset"
                    title={t.wb_workset_title()}
                    description={t.wb_workset_description()}
                    status={state_label(&workset.status)}
                    tone={workset_tone(&workset.status)}
                >
                    <Pairs items={&items} />
                    <Table layout={TableLayout::Stack}>
                        <table>
                            <caption class={VisuallyHidden {}}>{p.integrations_workset_caption()}</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{t.wb_workset_unit()}</th>
                                    <th scope="col">{t.wb_workset_state()}</th>
                                    <th scope="col">{t.wb_workset_actions()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for unit in &workset.units {
                                    <WorksetRow t={t} p={p} req={req} unit={unit} context={context} manage={manage} />
                                }
                            </tbody>
                        </table>
                    </Table>
                </Module>
            </div>
        }
    }
}

/// A unit's row: who it is, its state and counts, and its scope's working set, with its commands.
/// For a viewer who manages the catalog, Sync and Reapply are buttons, off unless the API offers
/// them (as admin-web's are), and so is Preview once the read built the unit's promotion; for anyone
/// else each is its state.
#[component(css = DailyPage)]
fn WorksetRow<'a>(t: Cat, p: Pilot, req: &'a Req, unit: &'a WorksetUnit, context: &'a str, manage: bool) -> impl Render {
    let key = unit.key();
    let detail = match &unit.profile_version {
        Some(version) => t.wb_workset_profile_version(version).to_string(),
        None => t.wb_workset_no_active_profile().to_owned(),
    };
    let counts = t
        .wb_workset_counts(crate::text::cat::WbWorksetCounts {
            observed: unit.counts.observed,
            changed: unit.counts.changed,
            promoted: unit.counts.promoted,
        })
        .to_string();
    let state = state_label(&unit.state);
    let scope = (!unit.current_workbench_href.is_empty()).then(|| link_to(req, &unit.current_workbench_href)).flatten();
    let commands = [
        ("import", t.wb_workset_sync_unit(&unit.display_name).to_string(), &unit.actions.import),
        ("preview", t.wb_workset_preview_unit(&unit.display_name).to_string(), &unit.actions.preview_promotion),
        ("reapply", t.wb_workset_reapply_unit(&unit.display_name).to_string(), &unit.actions.reapply),
    ];
    let action = at(&daily::url::Unit.href(), context);
    let sendable = manage && unit.command_scopes.is_some();
    let mut blocked: Vec<String> = Vec::new();
    for action in unit.actions.all() {
        for blocker in &action.blockers {
            if !blocked.contains(blocker) {
                blocked.push(blocker.clone());
            }
        }
    }
    let previewable = manage && unit.previewable();
    let promotion = at(&daily::url::Promotion.href(), context);
    html! {
        <tr data-catalog-source-scope-unit={key}>
            <td>
                <CellLabel>{t.wb_workset_unit()}</CellLabel>
                <Cell
                    title={&unit.display_name}
                    description={Some(unit.unit_key.as_deref().unwrap_or(t.wb_workset_no_active_unit()))}
                    detail={Some(detail.as_str())}
                />
            </td>
            <td>
                <CellLabel>{t.wb_workset_state()}</CellLabel>
                <span class={CellBlock}>
                    <Pill text={&state} tone={workset_unit_tone(&unit.state)} />
                    <small class={Muted}>{counts}</small>
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_workset_actions()}</CellLabel>
                <span class={CellBlock}>
                    if let Some(href) = &scope {
                        <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={href}>
                            {t.wb_workset_open_unit_scope()}
                        </a>
                    }
                    <span class={Badges}>
                        for (command, label, state) in &commands {
                            if previewable && *command == "preview" {
                                <form
                                    method="post"
                                    action={&promotion}
                                    data-patch
                                    data-catalog-primary-workbench-command={&state.key}
                                    data-state={&state.state}
                                >
                                    <input type="hidden" name={PromotionInput::FIELDS.unit} value={key}>
                                    <button
                                        type="submit"
                                        class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                                        name={PromotionInput::FIELDS.phase}
                                        value="preview-unit"
                                        disabled={!state.open()}
                                    >
                                        {label}
                                    </button>
                                </form>
                            } else if sendable && *command != "preview" {
                                <form
                                    method="post"
                                    action={&action}
                                    data-patch
                                    data-catalog-primary-workbench-command={&state.key}
                                    data-state={&state.state}
                                >
                                    <input type="hidden" name={UnitInput::FIELDS.unit} value={key}>
                                    <button
                                        type="submit"
                                        class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                                        name={UnitInput::FIELDS.command}
                                        value={*command}
                                        disabled={!state.open()}
                                    >
                                        {label}
                                    </button>
                                </form>
                            } else {
                                <span data-catalog-primary-workbench-command={&state.key} data-state={&state.state}>
                                    <Pill text={label} tone={if state.open() { "success" } else { "neutral" }} />
                                </span>
                            }
                        }
                    </span>
                    if !blocked.is_empty() {
                        <Blockers t={t} blockers={&blocked} />
                    }
                </span>
            </td>
        </tr>
    }
}

fn sync_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "blocked" => "danger",
        _ => "warning",
    }
}

/// Whether the sync's Start runs: the command is open, or blocked only until units are chosen
/// (the form's boxes choose them; the API decides).
fn sync_startable(model: &Daily) -> bool {
    let action = &model.catalog_sync.action;
    action.open() || (action.state == "blocked" && action.blockers.iter().all(|b| b == "unit-selection-required"))
}

/// Catalog scope sync (`CatalogSyncScopeModule`): the scope, the plan, its estimate for the units
/// the preview selected, and the units, each with its box, inside the form that starts the sync;
/// then the run the address names and the scope's durable sync state.
#[component(css = DailyPage)]
fn SyncModule<'a>(
    t: Cat,
    p: Pilot,
    model: &'a Daily,
    run: Option<&'a SyncRun>,
    units: &'a [UnitState],
    context: &'a str,
    manage: bool,
) -> impl Render {
    let sync = &model.catalog_sync;
    let scope = &sync.scope;
    let none = || p.integrations_sync_not_selected().to_owned();
    let start = manage && sync_startable(model);
    let selected = sync.preview.units.iter().filter(|u| u.selected && u.eligibility == "eligible").count();
    let left = [
        (p.integrations_sync_scope(), scope.label.clone()),
        (p.integrations_sync_domain(), scope.product_domain.clone().unwrap_or_else(none)),
        (p.integrations_sync_form(), scope.product_form.clone().unwrap_or_else(none)),
        (p.integrations_sync_language(), scope.language_code.clone().unwrap_or_else(none)),
    ];
    let right = [
        (p.integrations_sync_reference(), scope.reference.scope_record_id.clone().unwrap_or_else(none)),
        (p.integrations_sync_reference_kind(), scope.reference.kind.clone().unwrap_or_else(none)),
        (p.integrations_sync_plan(), sync.preview.explanation.clone()),
        (
            p.integrations_sync_start(),
            if start { p.integrations_sync_allowed() } else { p.integrations_sync_blocked() }.to_owned(),
        ),
    ];
    let estimate = &sync.preview.estimate;
    let requests =
        estimate.total_estimated_request_count.map_or_else(|| t.wb_sync_cost_preview_unavailable().to_owned(), |n| n.to_string());
    let cost = [(t.wb_sync_cost_preview_requests(), requests)];
    let selected_text = t.wb_sync_selected(selected).to_string();
    let action = at(&daily::url::Sync.href(), context);
    let f = SyncInput::FIELDS;
    let status = state_label(&sync.status);
    html! {
        <Module
            id="wb-sync"
            title={t.wb_sync_title()}
            description={t.wb_sync_description()}
            status={status.to_string()}
            tone={sync_tone(&sync.status)}
        >
            <p class={Count}><Pill text={&selected_text} tone={if selected > 0 { "info" } else { "warning" }} /></p>
            <div class={Columns}>
                <Pairs items={&left} />
                <Pairs items={&right} />
            </div>
            if !sync.action.blockers.is_empty() {
                <Blockers t={t} blockers={&sync.action.blockers} />
            }
            <div class={Panel} data-catalog-sync-cost-preview="true">
                <p class={Strong}>{t.wb_sync_cost_preview_title()}</p>
                <Pairs items={&cost} />
                if !estimate.credit_consuming_providers.is_empty() {
                    <p class={Muted}>{t.wb_sync_cost_preview_credit_providers()}</p>
                    <span class={Badges}>
                        for provider in &estimate.credit_consuming_providers {
                            <Pill text={&provider.display_name} tone="warning" />
                        }
                    </span>
                }
                if let Some(reason) = &estimate.estimate_reason {
                    <p class={Muted}>{reason}</p>
                }
                <p class={Muted}>{p.integrations_sync_estimate_note()}</p>
            </div>
            <form
                method="post"
                action={&action}
                class={(KitStack { gap: Gap::App }, gap_4(), Stack)}
                data-patch
                data-catalog-primary-workbench-command="scope.sync"
            >
                <input type="hidden" name={f.product_domain} value={scope.product_domain.as_deref().unwrap_or_default()}>
                <input type="hidden" name={f.product_form} value={scope.product_form.as_deref().unwrap_or_default()}>
                <input type="hidden" name={f.language_code} value={scope.language_code.as_deref().unwrap_or_default()}>
                <input type="hidden" name={f.reference_kind} value={scope.reference.kind.as_deref().unwrap_or_default()}>
                <input
                    type="hidden"
                    name={f.scope_record_id}
                    value={scope.reference.scope_record_id.as_deref().unwrap_or_default()}
                >
                if sync.preview.units.is_empty() {
                    <Empty title={t.wb_sync_empty_title()} description={t.wb_sync_empty_description()} />
                } else {
                    <Table layout={TableLayout::Stack}>
                        <table>
                            <caption class={VisuallyHidden {}}>{t.wb_sync_title()}</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{t.wb_sync_table_sync()}</th>
                                    <th scope="col">{t.wb_sync_table_provider_unit()}</th>
                                    <th scope="col">{t.wb_sync_table_readiness()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for unit in &sync.preview.units {
                                    let detail = match (unit.blockers.first(), &unit.profile_version) {
                                        (Some(b), _) => b.message.clone(),
                                        (None, Some(v)) => p.integrations_sync_profile(v).to_string(),
                                        (None, None) => p.integrations_sync_no_profile().to_owned(),
                                    };
                                    let key = unit.unit_key.as_deref().unwrap_or_default();
                                    let eligible = unit.eligibility == "eligible" && !key.is_empty();
                                    let include = p.integrations_sync_include(&unit.display_name).to_string();
                                    let eligibility = state_label(&unit.eligibility);
                                    let role = state_label(&unit.role);
                                    let requirement = state_label(&unit.requirement);
                                    <tr data-catalog-sync-participation-row="true" data-catalog-sync-participation-unit={key}>
                                        <td>
                                            <CellLabel>{t.wb_sync_table_sync()}</CellLabel>
                                            if !key.is_empty() {
                                                <input type="hidden" name={f.units} value={key}>
                                            }
                                            <Checkbox label={&include}>
                                                <input
                                                    type="checkbox"
                                                    name={f.selected}
                                                    value={key}
                                                    checked={unit.selected && eligible}
                                                    disabled={!eligible || !start}
                                                >
                                            </Checkbox>
                                        </td>
                                        <td>
                                            <CellLabel>{t.wb_sync_table_provider_unit()}</CellLabel>
                                            <Cell
                                                title={&unit.display_name}
                                                description={Some(unit.unit_key.as_deref().unwrap_or(p.integrations_sync_no_unit()))}
                                                detail={Some(detail.as_str())}
                                            />
                                        </td>
                                        <td>
                                            <CellLabel>{t.wb_sync_table_readiness()}</CellLabel>
                                            <span class={Badges}>
                                                <Pill
                                                    text={&eligibility}
                                                    tone={if unit.eligibility == "eligible" { "success" } else { "danger" }}
                                                />
                                                <Pill text={&role} tone="neutral" />
                                                <Pill text={&requirement} tone="neutral" />
                                            </span>
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </Table>
                }
                <div class={Row}>
                    <button
                        type="submit"
                        class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                        disabled={!start}
                    >
                        {t.wb_sync_start()}
                    </button>
                </div>
            </form>
            if let Some(run) = run {
                <RunProgress t={t} p={p} run={run} />
            }
            if !units.is_empty() {
                <UnitStates t={t} units={units} context={context} manage={manage} />
            }
        </Module>
    }
}

/// A Catalog sync run's progress (`CatalogSyncRunProgress`): the parent run, its counts, and a
/// child job per provider unit, whose retry, resume and cancel stay with the import jobs.
#[component(css = DailyPage)]
fn RunProgress<'a>(t: Cat, p: Pilot, run: &'a SyncRun) -> impl Render {
    let counts = &run.progress.child_jobs;
    let targets = &run.progress.provider_targets;
    let pairs = [
        (p.integrations_sync_run_children(), format!("{}/{}", counts.completed, counts.total)),
        (p.integrations_sync_run_running(), counts.running.to_string()),
        (p.integrations_sync_run_queued(), counts.queued.to_string()),
        (p.integrations_sync_run_partial(), counts.partial.to_string()),
        (p.integrations_sync_run_failed(), counts.failed.to_string()),
        (p.integrations_sync_run_targets(), format!("{}/{}", targets.completed, targets.total)),
    ];
    let title = t.wb_sync_progress_parent_run(&run.sync_run_id).to_string();
    let status = state_label(&run.status);
    html! {
        <div class={Panel} data-catalog-sync-run={&run.status} data-catalog-sync-run-id={&run.sync_run_id}>
            <div class={Row}>
                <span>
                    <p class={Strong}>{title}</p>
                    <p class={Muted}>{t.wb_sync_progress_delegated_children()}</p>
                </span>
                <Pill text={&status} tone={run_tone(&run.status)} />
            </div>
            <Pairs items={&pairs} />
            <Table layout={TableLayout::Stack}>
                <table>
                    <caption class={VisuallyHidden {}}>{p.integrations_sync_run_caption()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.wb_sync_progress_provider_child()}</th>
                            <th scope="col">{t.wb_sync_progress_status()}</th>
                            <th scope="col">{t.wb_sync_progress_link()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for child in &run.child_jobs {
                            let state = state_label(&child.status);
                            let link = state_label(&child.sync_run_link_state);
                            let job = child.child_job_id.as_deref().unwrap_or(p.integrations_sync_run_no_child());
                            <tr data-catalog-sync-run-child={&child.unit_key}>
                                <td>
                                    <CellLabel>{t.wb_sync_progress_provider_child()}</CellLabel>
                                    <Cell title={&child.display_name} description={Some(job)} detail={None} />
                                </td>
                                <td>
                                    <CellLabel>{t.wb_sync_progress_status()}</CellLabel>
                                    <Pill text={&state} tone={run_tone(&child.status)} />
                                </td>
                                <td>
                                    <CellLabel>{t.wb_sync_progress_link()}</CellLabel>
                                    <small>{link}</small>
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            </Table>
        </div>
    }
}

fn run_tone(status: &str) -> &'static str {
    match status {
        "completed" => "success",
        "failed" | "cancelled" => "danger",
        "partial" => "warning",
        _ => "info",
    }
}

fn unit_tone(state: &str) -> &'static str {
    match state {
        "settled" => "success",
        "failed" | "stale" => "danger",
        "running" | "pending" => "info",
        _ => "neutral",
    }
}

/// The scope's durable sync state (`ScopeSyncStateTable`): each provider unit's state kept across
/// runs, its counts and last run, and Retry provider for a failed or stale one, which retries that
/// unit's last import job and leaves the others as they are.
#[component(css = DailyPage)]
fn UnitStates<'a>(t: Cat, units: &'a [UnitState], context: &'a str, manage: bool) -> impl Render {
    html! {
        <div class={Panel} data-catalog-scope-sync-state="ready">
            <p class={Strong}>{t.wb_sync_state_title()}</p>
            <p class={Muted}>{t.wb_sync_state_description()}</p>
            <Table layout={TableLayout::Stack}>
                <table>
                    <caption class={VisuallyHidden {}}>{t.wb_sync_state_title()}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{t.wb_sync_table_provider_unit()}</th>
                            <th scope="col">{t.wb_sync_state_column_state()}</th>
                            <th scope="col">{t.wb_sync_state_column_counts()}</th>
                            <th scope="col">{t.wb_sync_state_column_last_run()}</th>
                            <th scope="col">{t.wb_table_action()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for unit in units {
                            let state = state_label(&unit.state);
                            let count = |n: Option<u64>| n.map_or_else(|| t.wb_not_selected().to_owned(), |n| n.to_string());
                            let observed = format!("{}: {}", t.wb_import_operations_observed(), count(unit.observed_count));
                            let changed = format!("{}: {}", t.wb_import_operations_changed(), count(unit.changed_count));
                            let run = t.wb_sync_progress_parent_run(unit.last_sync_run_id.as_deref().unwrap_or(t.wb_none())).to_string();
                            let completed = unit
                                .last_completed_at
                                .as_deref()
                                .map_or_else(|| t.wb_sync_state_never_completed().to_owned(), |at| when(t, at));
                            <tr
                                data-catalog-scope-sync-state-row="true"
                                data-catalog-scope-sync-state-unit={&unit.unit_key}
                                data-catalog-scope-sync-state-value={&unit.state}
                            >
                                <td>
                                    <CellLabel>{t.wb_sync_table_provider_unit()}</CellLabel>
                                    <Cell title={&unit.display_name} description={Some(unit.unit_key.as_str())} detail={None} />
                                </td>
                                <td>
                                    <CellLabel>{t.wb_sync_state_column_state()}</CellLabel>
                                    <Pill text={&state} tone={unit_tone(&unit.state)} />
                                </td>
                                <td>
                                    <CellLabel>{t.wb_sync_state_column_counts()}</CellLabel>
                                    <span class={CellBlock}>
                                        <small>{observed}</small>
                                        <small>{changed}</small>
                                    </span>
                                </td>
                                <td>
                                    <CellLabel>{t.wb_sync_state_column_last_run()}</CellLabel>
                                    <span class={CellBlock}>
                                        <small>{run}</small>
                                        <small>{completed}</small>
                                    </span>
                                </td>
                                <td>
                                    <CellLabel>{t.wb_table_action()}</CellLabel>
                                    if let Some(job) = unit.retry().filter(|_| manage) {
                                        let action = at(&daily::url::Job { id: job }.href(), context);
                                        <form
                                            method="post"
                                            action={&action}
                                            data-patch
                                            data-catalog-scope-sync-state-retry-unit={&unit.unit_key}
                                        >
                                            <button
                                                type="submit"
                                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                                name={JobInput::FIELDS.command}
                                                value="retry"
                                            >
                                                {t.wb_sync_state_retry()}
                                            </button>
                                        </form>
                                    }
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            </Table>
        </div>
    }
}
fn job_tone(state: &str) -> &'static str {
    match state {
        "completed" => "success",
        "failed" | "cancelled" => "danger",
        "running" => "info",
        _ => "warning",
    }
}

fn profile_label(t: Cat, job: &ImportJob) -> String {
    match (&job.profile_snapshot, &job.profile_version) {
        (Some(s), _) => format!("{}@{}", s.profile_key, s.profile_version),
        (None, Some(v)) => v.clone(),
        (None, None) => t.wb_not_selected().to_owned(),
    }
}

/// A job's usage (`ImportJobUsage`).
fn usage(t: Cat, job: &ImportJob) -> Vec<String> {
    let Some(usage) = job.result.as_ref().and_then(|r| r.usage.as_ref()) else {
        return Vec::new();
    };
    let unavailable = t.wb_jobs_usage_unavailable();
    let n = |v: Option<u64>| v.map_or_else(|| unavailable.to_owned(), |v| v.to_string());
    let mut lines = vec![
        t.wb_jobs_usage_requests(&n(usage.actual_request_count)).to_string(),
        t.wb_jobs_usage_pages(&n(usage.page_count)).to_string(),
    ];
    if let (Some(hits), Some(misses)) = (usage.cache_hit_count, usage.cache_miss_count) {
        lines.push(t.wb_jobs_usage_cache(crate::text::cat::WbJobsUsageCache { hits, misses }).to_string());
    }
    lines
}

/// The import jobs (`CatalogIntegrationImportJobsModule`): the selected scope's import preflight, then
/// each job with its progress, failure groups and usage, and the retry, resume and cancel the API
/// offers it. The preflight is sent by its `<corten-live>` part once it is read; where no stream will
/// bring it (without JavaScript, or once the stream gave up) the loading line's link to the page with it
/// read in shows in its place (`daily_page.css`, Corten's slow-part pattern).
#[component(css = DailyPage)]
fn JobsModule<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    model: &'a Daily,
    preflight: &'a PreflightPart,
    context: &'a str,
    manage: bool,
) -> impl Render {
    let jobs = &model.import_jobs;
    let status = t.wb_import_operations_status(jobs.active_job_count).to_string();
    let none = t.wb_none();
    // The preflight the API plans for a provider, unit and import scope (it answers none without them).
    let route = &model.route_context;
    let named = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    let planned =
        jobs.selected_scope.is_some() && named(&route.provider_key) && named(&route.unit_key) && named(&route.import_scope);
    html! {
        <Module
            id="wb-jobs"
            title={t.wb_import_operations_title()}
            description={t.wb_import_operations_description()}
            status={status}
            tone={if jobs.active_job_count > 0 { "warning" } else { "success" }}
        >
            if planned {
                match preflight {
                    PreflightPart::Read(answer) => {
                        <ImportPreflight t={t} answer={answer.as_ref()} />
                    }
                    PreflightPart::Live => {
                        <corten-live src={at(&daily::url::ImportPreview.href(), context)}>
                            <div id={ImportPreflightId}>
                                <p class={Muted}>
                                    <span class={Loading}>{t.wb_import_preview_loading()}</span>
                                    <a class={ReadIn} href={daily::read_in(context)} rel="nofollow">
                                        {p.integrations_preflight_read()}
                                    </a>
                                </p>
                            </div>
                        </corten-live>
                    }
                }
            }
            if jobs.jobs.is_empty() {
                <Empty title={t.wb_jobs_empty_title()} description={t.wb_jobs_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={VisuallyHidden {}}>{t.wb_stage_supporting_jobs()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_jobs_table_job()}</th>
                                <th scope="col">{t.wb_jobs_table_progress()}</th>
                                <th scope="col">{t.wb_jobs_table_failures()}</th>
                                <th scope="col">{t.wb_jobs_table_usage()}</th>
                                <th scope="col">{t.wb_table_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for job in &jobs.jobs {
                                let profile = t.wb_jobs_table_profile(&profile_label(t, job)).to_string();
                                let unit = t.wb_jobs_context_unit(job.unit_key.as_deref().unwrap_or(t.wb_not_selected())).to_string();
                                let scope = t.wb_jobs_context_scope(job.import_scope.as_deref().unwrap_or(t.wb_not_selected())).to_string();
                                let (route, route_tone) = if job.scope_matches_route {
                                    (t.wb_jobs_context_current_scope(), "success")
                                } else {
                                    (t.wb_jobs_context_overlapping_scope(), "warning")
                                };
                                let state = state_label(&job.state);
                                let operator = t.wb_jobs_operator_status(&state_label(&job.operator_status)).to_string();
                                let progress = t.wb_jobs_progress_value(crate::text::cat::WbJobsProgressValue { completed: job.completed, total: job.total, percent: job.progress_percent }).to_string();
                                let created = t.wb_jobs_created(&when(t, &job.created_at)).to_string();
                                let started = t.wb_jobs_started(&job.started_at.as_deref().map_or_else(|| t.wb_jobs_not_started().to_owned(), |at| when(t, at))).to_string();
                                let lines = usage(t, job);
                                let action = at(&daily::url::Job { id: &job.job_id }.href(), context);
                                let review = link_to(req, &job.source_observation_review_href);
                                <tr data-catalog-import-job-row="true" data-catalog-import-job-id={&job.job_id}>
                                    <td>
                                        <CellLabel>{t.wb_jobs_table_job()}</CellLabel>
                                        <span class={CellBlock}>
                                            <Cell
                                                title={&job.summary}
                                                description={Some(profile.as_str())}
                                                detail={Some(unit.as_str())}
                                            />
                                            <span class={Badges}>
                                                <Pill text={route} tone={route_tone} />
                                                <Pill text={&scope} tone="neutral" />
                                            </span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_jobs_table_progress()}</CellLabel>
                                        <span class={CellBlock}>
                                            <Pill text={&state} tone={job_tone(&job.state)} />
                                            <small>{operator}</small>
                                            <small>{progress}</small>
                                            <small>{created}</small>
                                            <small>{started}</small>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_jobs_table_failures()}</CellLabel>
                                        if job.failure_groups.is_empty() {
                                            <Pill text={none} tone="success" />
                                        } else {
                                            <span class={Badges}>
                                                for group in &job.failure_groups {
                                                    let label = t.wb_jobs_failure_group(crate::text::cat::WbJobsFailureGroup { label: &group.label, count: group.count }).to_string();
                                                    <Pill
                                                        text={&label}
                                                        tone={if group.severity == "error" { "danger" } else { "warning" }}
                                                    />
                                                }
                                            </span>
                                        }
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_jobs_table_usage()}</CellLabel>
                                        if lines.is_empty() {
                                            <Pill text={none} tone="neutral" />
                                        } else {
                                            <span class={CellBlock}>
                                                for line in &lines {
                                                    <small>{line}</small>
                                                }
                                            </span>
                                        }
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_table_action()}</CellLabel>
                                        <span class={CellBlock}>
                                            if manage && (job.retry_available || job.resume_available || job.cancel_available) {
                                                <form
                                                    method="post"
                                                    action={&action}
                                                    class={Row}
                                                    data-patch
                                                    data-catalog-primary-workbench-command="job"
                                                >
                                                    if job.retry_available {
                                                        <button
                                                            type="submit"
                                                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                                            name={JobInput::FIELDS.command}
                                                            value="retry"
                                                        >
                                                            {t.wb_jobs_retry()}
                                                        </button>
                                                    }
                                                    if job.resume_available {
                                                        <button
                                                            type="submit"
                                                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                                            name={JobInput::FIELDS.command}
                                                            value="resume"
                                                        >
                                                            {t.wb_jobs_resume()}
                                                        </button>
                                                    }
                                                    if job.cancel_available {
                                                        <button
                                                            type="submit"
                                                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                                            name={JobInput::FIELDS.command}
                                                            value="cancel"
                                                        >
                                                            {t.wb_jobs_cancel()}
                                                        </button>
                                                    }
                                                </form>
                                            }
                                            if let Some(review) = &review {
                                                <a class={Words} href={review}>{t.wb_jobs_review_link()}</a>
                                            }
                                            <Evidence
                                                req={req}
                                                href={&job.audit_evidence_url}
                                                label={t.wb_jobs_evidence_link()}
                                            />
                                        </span>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
    }
}

/// Where the import preflight goes in the jobs stage, replaced by the fragment that answers it.
#[derive(Id, Clone, Copy)]
pub struct ImportPreflightId;

fn strategy_tone(strategy: Option<&str>) -> &'static str {
    match strategy {
        Some("bulk-first") => "success",
        Some("single-record") => "warning",
        _ => "neutral",
    }
}

fn usage_check_tone(state: Option<&str>) -> &'static str {
    match state {
        Some("checked") => "success",
        Some("unavailable") => "danger",
        Some("not-configured" | "unknown") => "warning",
        _ => "neutral",
    }
}

/// The import preflight (admin-web's `ImportPreviewEvidence`): the targets the provider's plan
/// would fetch, its request strategy and usage check, and the estimate, fields, fallback, transport
/// steps, diagnostics and plan keys; that the provider did not answer in time; or nothing.
#[component(css = DailyPage)]
pub fn ImportPreflight<'a>(t: Cat, answer: Option<&'a ImportPreview>) -> impl Render {
    html! {
        <div id={ImportPreflightId}>
            match answer {
                Some(ImportPreview::Ready(ready)) => {
                    <PreflightPanel t={t} preview={&ready.preview} usage={&ready.usage_summary} />
                }
                Some(ImportPreview::Unavailable) => {
                    <div data-catalog-deferred-panel="unavailable" role="status">
                        <Banner tone="warning" title={t.wb_import_preview_title()} description={t.alias_review_unavailable()} />
                    </div>
                }
                None => {}
            }
        </div>
    }
}

#[component(css = DailyPage)]
fn PreflightPanel<'a>(t: Cat, preview: &'a daily::Preflight, usage: &'a daily::PreflightUsage) -> impl Render {
    let not_selected = || t.wb_not_selected().to_owned();
    let unknown = state_label("unknown");
    let strategy = usage.request_strategy.as_deref();
    let check = usage.usage_check_state.as_deref();
    let requests = match (usage.estimated_request_count, usage.estimate_state.as_deref()) {
        (Some(count), _) => count.to_string(),
        (None, Some("estimate-unavailable")) => t.wb_import_preview_estimate_unavailable().to_owned(),
        (None, _) => not_selected(),
    };
    let payloads = if preview.targets.is_empty() || preview.targets.iter().any(|target| target.estimated_payloads.is_none()) {
        not_selected()
    } else {
        preview.targets.iter().filter_map(|target| target.estimated_payloads).sum::<u64>().to_string()
    };
    let mut steps: Vec<&str> = Vec::new();
    for step in preview.targets.iter().flat_map(|target| &target.transport_steps) {
        if !step.is_empty() && !steps.contains(&step.as_str()) {
            steps.push(step);
        }
    }
    let or = |value: &Option<String>, otherwise: &str| value.clone().unwrap_or_else(|| otherwise.to_owned());
    let estimate = [
        (t.wb_import_preview_estimated_requests(), requests),
        (t.wb_import_preview_estimate_reason(), or(&usage.estimate_reason, t.wb_import_preview_no_estimate_reason())),
        (t.wb_import_preview_estimated_payloads(), payloads),
        (t.wb_import_preview_page_size(), usage.page_size.map_or_else(not_selected, |size| size.to_string())),
    ];
    let plan = [
        (
            t.wb_import_preview_selected_fields(),
            if usage.selected_fields.is_empty() { t.wb_none().to_owned() } else { usage.selected_fields.join(", ") },
        ),
        (t.wb_import_preview_fallback(), or(&usage.per_record_fallback_reason, t.wb_import_preview_bulk_first())),
        (t.wb_import_preview_transport_steps(), if steps.is_empty() { t.wb_none().to_owned() } else { steps.join(" / ") }),
    ];
    let diagnostics = [
        (t.wb_import_preview_credit_diagnostic(), or(&usage.credit_diagnostic, t.wb_import_preview_no_credit_diagnostic())),
        (t.wb_import_preview_degraded_diagnostic(), or(&usage.degraded_diagnostic, t.wb_import_preview_no_degraded_diagnostic())),
        (
            t.wb_import_preview_plan_keys(),
            preview.targets.iter().map(|target| target.plan_key.as_str()).collect::<Vec<_>>().join(", "),
        ),
    ];
    let targets = t.wb_import_preview_targets(preview.target_count).to_string();
    let strategy_text = t.wb_import_preview_strategy(&strategy.map_or_else(|| unknown.clone(), state_label)).to_string();
    let check_text = t.wb_import_preview_usage_check(&check.map_or_else(|| unknown.clone(), state_label)).to_string();
    html! {
        <div
            class={Panel}
            data-catalog-import-preview="ready"
            data-catalog-import-preview-provider={&preview.provider_key}
            data-catalog-import-preview-unit={preview.scope.ingestion_unit_key.as_deref().unwrap_or("")}
            data-catalog-import-preview-scope={&preview.scope.key()}
            data-catalog-import-preview-strategy={strategy.unwrap_or("none")}
            data-catalog-import-preview-usage-state={check.unwrap_or("none")}
        >
            <div class={Row}>
                <div>
                    <p class={Strong}>{t.wb_import_preview_title()}</p>
                    <p class={Muted}>{t.wb_import_preview_description()}</p>
                </div>
                <span class={Badges}>
                    <Pill text={&targets} tone="info" />
                    <Pill text={&strategy_text} tone={strategy_tone(strategy)} />
                    <Pill text={&check_text} tone={usage_check_tone(check)} />
                </span>
            </div>
            <div class={Columns}>
                <Pairs items={&estimate} />
                <Pairs items={&plan} />
                <Pairs items={&diagnostics} />
            </div>
        </div>
    }
}

fn candidate_tone(status: &str) -> &'static str {
    match status {
        "ready" | "promoted" => "success",
        "has-conflicts" | "rejected" => "danger",
        _ => "warning",
    }
}

/// Merged candidate review (`CatalogIntegrationMergeCandidateReviewModule`): each candidate's
/// identity, sources, status and readiness, and the ignore, defer, split and edit the API offers
/// it, its promote once the API checks it against the version read, and its detail sheet; a
/// blocking conflict's resolution opens on admin-web (chase-sets/chase-sets#11235).
#[component(css = DailyPage)]
fn CandidatesModule<'a>(t: Cat, p: Pilot, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let merge = &model.merge_candidate_review;
    let ready = t.wb_merge_ready_count(merge.counts.ready).to_string();
    let elsewhere = admin_web(&daily::location(context)).map(|u| u.to_string());
    let conflicts = t.wb_merge_conflict_count(merge.counts.conflict).to_string();
    html! {
        <Module
            id="wb-candidates"
            title={t.wb_merge_title()}
            description={t.wb_merge_description()}
            status={ready}
            tone={if merge.counts.ready > 0 { "success" } else { "neutral" }}
        >
            <p class={Count}>
                <Pill text={&conflicts} tone={if merge.counts.conflict > 0 { "warning" } else { "neutral" }} />
            </p>
            if merge.rows.is_empty() {
                <Empty title={t.wb_merge_empty_title()} description={t.wb_merge_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={VisuallyHidden {}}>{t.wb_merge_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_merge_table_identity()}</th>
                                <th scope="col">{t.wb_merge_table_sources()}</th>
                                <th scope="col">{t.wb_merge_table_status()}</th>
                                <th scope="col">{t.wb_merge_table_readiness()}</th>
                                <th scope="col">{t.wb_table_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &merge.rows {
                                <CandidateRow
                                    t={t}
                                    p={p}
                                    row={row}
                                    context={context}
                                    manage={manage}
                                    elsewhere={elsewhere.as_deref()}
                                />
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if let (true, Some(href)) = (merge.rows.iter().any(|row| row.conflicts.blocking > 0), &elsewhere) {
                <p class={Muted}>
                    {p.integrations_conflicts_elsewhere()}
                    " "
                    <a href={href}>{p.integrations_candidates_open()}</a>
                </p>
            }
        </Module>
    }
}

/// A candidate's row. Its ignore and defer are one form's buttons, each disabled unless the API
/// offers it (admin-web's `MergeCandidateActionButton`), with the blockers of those it does not.
/// Split is its own form, carrying the version and the observations the API's split names; Edit
/// opens a dialog with the typed edit (admin-web's `CatalogMergeCandidateEditForm`), and Evidence the
/// candidate's detail sheet.
#[component(css = DailyPage)]
fn CandidateRow<'a>(
    t: Cat,
    p: Pilot,
    row: &'a Candidate,
    context: &'a str,
    manage: bool,
    elsewhere: Option<&'a str>,
) -> impl Render {
    let intent = state_label(&row.proposed_mapping.promotion_intent);
    let sources = t.wb_merge_sources_count(row.source_count).to_string();
    let status = state_label(&row.status);
    let blocking = t.wb_merge_conflicts_blocking(row.conflicts.blocking).to_string();
    let warnings = t.wb_merge_conflicts_warning(row.conflicts.warnings).to_string();
    let readiness = state_label(&row.promote_readiness.state);
    let commands: Vec<_> = CANDIDATE_COMMANDS
        .iter()
        .filter_map(|(key, word)| row.actions.iter().find(|a| a.key == *key).map(|a| (a, *word)))
        .collect();
    let mut blocked: Vec<String> = Vec::new();
    for (action, _) in &commands {
        for blocker in &action.blockers {
            if blocker != "unsupported-command" && !blocked.contains(blocker) {
                blocked.push(blocker.clone());
            }
        }
    }
    let action = at(&daily::url::MergeCandidate { id: &row.candidate_id }.href(), context);
    let split = row.split();
    let edit = row.edit_form.version();
    let dialog = CandidateEditId(&row.candidate_id);
    let detail = CandidateDetailId(&row.candidate_id);
    let evidence = t
        .wb_merge_action_aria(crate::text::cat::WbMergeActionAria { action: t.wb_evidence(), candidate: &row.identity_label })
        .to_string();
    html! {
        <tr data-catalog-merge-candidate={&row.candidate_id}>
            <td>
                <CellLabel>{t.wb_merge_table_identity()}</CellLabel>
                <span class={CellBlock}>
                    <Cell title={&row.identity_label} description={Some(row.identity_fingerprint.as_str())} detail={None} />
                    <span class={Badges}>
                        <Pill text={&intent} tone="neutral" />
                        <Pill text={&sources} tone="info" />
                    </span>
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_merge_table_sources()}</CellLabel>
                <span class={CellBlock}>
                    for source in row.sources.iter().take(3) {
                        let id = source.observation_id.as_deref().or(source.external_key.as_deref()).unwrap_or_default();
                        <small class={Words}>{format!("{}: {id}", source.provider_key)}</small>
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_merge_table_status()}</CellLabel>
                <span class={CellBlock}>
                    <Pill text={&status} tone={candidate_tone(&row.status)} />
                    <span class={Badges}>
                        <Pill text={&blocking} tone={if row.conflicts.blocking > 0 { "danger" } else { "neutral" }} />
                        <Pill text={&warnings} tone={if row.conflicts.warnings > 0 { "warning" } else { "neutral" }} />
                    </span>
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_merge_table_readiness()}</CellLabel>
                <span class={CellBlock}>
                    <Pill text={&readiness} tone={if row.promote_readiness.state == "ready" { "success" } else { "warning" }} />
                    if !row.promote_readiness.blockers.is_empty() {
                        <Blockers t={t} blockers={&row.promote_readiness.blockers} />
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_table_action()}</CellLabel>
                <span class={CellBlock}>
                    <button
                        type="button"
                        class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                        command="show-modal"
                        commandfor={detail}
                        aria-haspopup="dialog"
                        aria-label={&evidence}
                    >
                        {t.wb_evidence()}
                    </button>
                    <CandidateDetail t={t} p={p} dialog={detail} row={row} elsewhere={elsewhere} />
                    if manage && !commands.is_empty() {
                        <form
                            method="post"
                            action={&action}
                            class={Row}
                            data-patch
                            data-catalog-primary-workbench-command="candidate"
                        >
                            for (entry, word) in commands.iter().filter(|(_, word)| *word != "split") {
                                let label = if *word == "ignore" { t.wb_merge_action_ignore() } else { t.wb_merge_action_defer() };
                                let aria = t.wb_merge_action_aria(crate::text::cat::WbMergeActionAria { action: label, candidate: &row.identity_label }).to_string();
                                <button
                                    type="submit"
                                    class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                    name={CandidateInput::FIELDS.command}
                                    value={*word}
                                    aria-label={&aria}
                                    disabled={!entry.open()}
                                >
                                    {label}
                                </button>
                            }
                        </form>
                    }
                    if let (true, Some((action_entry, version, ids))) = (manage, split) {
                        <form
                            method="post"
                            action={&action}
                            class={Row}
                            data-patch
                            data-catalog-primary-workbench-command="candidate-split"
                        >
                            <input type="hidden" name={CandidateInput::FIELDS.version} value={version}>
                            for id in ids {
                                <input type="hidden" name={CandidateInput::FIELDS.split} value={id}>
                            }
                            if let Some(preview) = &action_entry.command_preview {
                                if !preview.body.reason.is_empty() {
                                    <input type="hidden" name={CandidateInput::FIELDS.reason} value={&preview.body.reason}>
                                }
                            }
                            let aria = t.wb_merge_action_aria(crate::text::cat::WbMergeActionAria { action: t.wb_merge_action_split(), candidate: &row.identity_label }).to_string();
                            <button
                                type="submit"
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                name={CandidateInput::FIELDS.command}
                                value="split"
                                aria-label={&aria}
                            >
                                {t.wb_merge_action_split()}
                            </button>
                        </form>
                    }
                    if let (true, Some((promote, version))) = (manage, row.promote()) {
                        <form
                            method="post"
                            action={&action}
                            class={Row}
                            data-patch
                            data-catalog-primary-workbench-command="candidate-promote"
                        >
                            <input type="hidden" name={CandidateInput::FIELDS.version} value={version}>
                            if let Some(preview) = &promote.command_preview {
                                if !preview.body.reason.is_empty() {
                                    <input type="hidden" name={CandidateInput::FIELDS.reason} value={&preview.body.reason}>
                                }
                            }
                            let aria = t.wb_merge_action_aria(crate::text::cat::WbMergeActionAria { action: t.wb_merge_action_promote(), candidate: &row.identity_label }).to_string();
                            <button
                                type="submit"
                                class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                                name={CandidateInput::FIELDS.command}
                                value="promote"
                                aria-label={&aria}
                            >
                                {t.wb_merge_action_promote()}
                            </button>
                        </form>
                    }
                    if let (true, Some(version)) = (manage, edit) {
                        <button
                            type="button"
                            class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                            command="show-modal"
                            commandfor={dialog}
                            aria-haspopup="dialog"
                        >
                            {t.wb_merge_edit_trigger()}
                        </button>
                        <CandidateEdit t={t} p={p} dialog={dialog} form={&row.edit_form} version={version} action={&action} />
                    }
                    if !blocked.is_empty() {
                        <Blockers t={t} blockers={&blocked} />
                    }
                </span>
            </td>
        </tr>
    }
}

/// A candidate's detail sheet, by the candidate's id.
#[derive(Id, Clone, Copy)]
struct CandidateDetailId<'a>(&'a str);

/// A candidate's detail (admin-web's `MergeCandidateDetailSheet`) in the kit's sheet from the right:
/// its mapping, each source's values, the field provenance, the proposed references and facts, its
/// conflicts and the commands the API built for it, all from the row the read gave. A candidate
/// with blocking conflicts says their resolution runs on admin-web (chase-sets/chase-sets#11235:
/// the API does not apply the value a resolution chooses, so the pilot does not offer the choice).
/// Without JavaScript the dialog opens by its trigger's command, as the candidate edit does.
#[component(css = DailyPage)]
fn CandidateDetail<'a>(
    t: Cat,
    p: Pilot,
    dialog: CandidateDetailId<'a>,
    row: &'a Candidate,
    elsewhere: Option<&'a str>,
) -> impl Render {
    let heading = super::id_with(&dialog, "-title");
    let title = t.wb_merge_detail_title(&row.identity_label).to_string();
    let mapping = &row.proposed_mapping;
    let products = if mapping.product_ids.is_empty() { t.wb_none().to_owned() } else { mapping.product_ids.join(", ") };
    let items = [
        (t.wb_merge_key_candidate(), row.candidate_id.clone()),
        (t.wb_merge_key_intent(), state_label(&mapping.promotion_intent)),
        (t.wb_merge_key_catalog_item(), mapping.catalog_item_id.clone().unwrap_or_else(|| t.wb_not_selected().to_owned())),
        (t.wb_merge_key_products(), products),
    ];
    let compared: Vec<String> = row
        .source_comparison
        .iter()
        .map(|v| format!("{} {} {}: {}", v.provider_key, v.observation_id, v.field_path, v.value))
        .collect();
    let provenance: Vec<String> = row
        .field_provenance
        .iter()
        .map(|f| format!("{}: {} {} {}", f.field_path, f.provider_key, f.source_profile_version, state_label(&f.confidence)))
        .collect();
    let references: Vec<String> =
        mapping.external_catalog_item_references.iter().chain(&mapping.external_product_references).cloned().collect();
    let facts: Vec<String> = row.proposed_facts.iter().map(|f| format!("{}: {}", f.key, f.value)).collect();
    let payloads: Vec<String> = row
        .actions
        .iter()
        .filter_map(|action| {
            let preview = action.command_preview.as_ref()?;
            let provenance = preview.provenance.as_ref()?;
            Some(
                t.wb_merge_detail_command_payload(crate::text::cat::WbMergeDetailCommandPayload {
                    action: candidate_action_label(t, &action.key),
                    kind: &preview.command_kind,
                    source_count: provenance.membership.len(),
                    product_reference_count: provenance.external_product_references.len(),
                })
                .to_string(),
            )
        })
        .collect();
    html! {
        <dialog
            class={Sheet { side: Side::Right(SheetWidth::Lg) }}
            id={dialog}
            closedby="any"
            aria-labelledby={&heading}
            data-catalog-merge-candidate-detail={&row.candidate_id}
        >
            <div class={SheetHeader {}}>
                <h2 id={&heading} class={Words}>{title}</h2>
                <button
                    type="button"
                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    command="close"
                    commandfor={dialog}
                >
                    {t.wb_evidence_close()}
                </button>
            </div>
            <p>{t.wb_merge_detail_description()}</p>
            <div class={(KitStack { gap: Gap::App }, gap_4(), Stack)}>
                if row.conflicts.blocking > 0 {
                    <p class={Muted}>
                        {p.integrations_conflicts_elsewhere()}
                        if let Some(href) = elsewhere {
                            " "
                            <a href={href}>{p.integrations_candidates_open()}</a>
                        }
                    </p>
                }
                <Pairs items={&items} />
                <EvidenceList title={t.wb_merge_detail_source_comparison()} items={&compared} empty={t.wb_none()} />
                <EvidenceList title={t.wb_merge_detail_field_provenance()} items={&provenance} empty={t.wb_none()} />
                <EvidenceList title={t.wb_merge_detail_references()} items={&references} empty={t.wb_none()} />
                <EvidenceList title={t.wb_merge_detail_proposed_facts()} items={&facts} empty={t.wb_none()} />
                <EvidenceList
                    title={t.wb_merge_detail_conflicts()}
                    items={&row.conflicts.messages}
                    empty={t.wb_review_evidence_no_conflicts()}
                />
                <EvidenceList
                    title={t.wb_merge_detail_command_payloads()}
                    items={&payloads}
                    empty={t.wb_merge_detail_command_payloads_empty()}
                />
            </div>
        </dialog>
    }
}

/// A candidate command's name (admin-web's `candidateActionLabel`).
fn candidate_action_label(t: Cat, key: &str) -> &'static str {
    match key {
        "candidate.promote" => t.wb_merge_action_promote(),
        "candidate.split" => t.wb_merge_action_split(),
        "candidate.edit" => t.wb_merge_action_update(),
        "candidate.ignore" => t.wb_merge_action_ignore(),
        _ => t.wb_merge_action_defer(),
    }
}

/// A candidate's edit dialog, by the candidate's id.#[derive(Id, Clone, Copy)]
struct CandidateEditId<'a>(&'a str);

/// The typed candidate edit (admin-web's `CatalogMergeCandidateEditForm`): the promotion intent,
/// the matched Catalog Item and Products, each editable fact, the external references to drop and
/// the reason. It posts without `data-patch`, so a refusal is the page again with its message at
/// the top, not behind the dialog.
#[component(css = DailyPage)]
fn CandidateEdit<'a>(
    t: Cat,
    p: Pilot,
    dialog: CandidateEditId<'a>,
    form: &'a EditForm,
    version: u64,
    action: &'a str,
) -> impl Render {
    let f = CandidateInput::FIELDS;
    let heading = super::id_with(&dialog, "-title");
    let intents = [t.wb_merge_edit_intent_create(), t.wb_merge_edit_intent_update(), t.wb_merge_edit_intent_link()];
    let products = form.product_ids.join(", ");
    html! {
        <dialog class={Dialog { size: DialogSize::Md }} id={dialog} closedby="any" aria-labelledby={&heading}>
            <div class={DialogHeader {}}>
                <h2 id={&heading}>{t.wb_merge_edit_title()}</h2>
                <button
                    type="button"
                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    command="close"
                    commandfor={dialog}
                >
                    {p.catalog_close()}
                </button>
            </div>
            <p class={Muted}>{t.wb_merge_edit_description()}</p>
            <form method="post" action={action} class={Edit} data-catalog-merge-candidate-edit-form="true">
                <input type="hidden" name={f.command} value="update">
                <input type="hidden" name={f.version} value={version}>
                <RadioGroup legend={t.wb_merge_edit_promotion_intent()}>
                    for (value, label) in PROMOTION_INTENTS.iter().zip(intents) {
                        <Radio label={label}>
                            <input type="radio" name={f.intent} value={*value} checked={*value == form.promotion_intent}>
                        </Radio>
                    }
                </RadioGroup>
                <label class={Field}>
                    <span>{t.wb_merge_edit_catalog_item_id()}</span>
                    <input
                        type="text"
                        name={f.catalog_item_id}
                        value={form.catalog_item_id.as_deref().unwrap_or_default()}
                        class={Input {}}
                    >
                </label>
                <label class={Field}>
                    <span>{t.wb_merge_edit_product_ids()}</span>
                    <input type="text" name={f.product_ids} value={&products} class={Input {}}>
                    <small class={Muted}>{t.wb_merge_edit_product_ids_help()}</small>
                </label>
                <fieldset class={Edit}>
                    <legend>{t.wb_merge_edit_facts_title()}</legend>
                    if form.editable_facts.is_empty() {
                        <p class={Muted}>{t.wb_merge_edit_facts_empty()}</p>
                    }
                    for fact in &form.editable_facts {
                        <input type="hidden" name={f.fact_key} value={&fact.key}>
                        <label class={Field}>
                            <span>{&fact.label}</span>
                            <input type="text" name={f.fact_value} value={&fact.value} class={Input {}}>
                        </label>
                        <input type="hidden" name={f.fact_shown} value={&fact.value}>
                    }
                </fieldset>
                <fieldset class={Edit}>
                    <legend>{t.wb_merge_edit_references_catalog_item()}</legend>
                    if form.external_catalog_item_references.is_empty() {
                        <p class={Muted}>{t.wb_merge_edit_references_empty()}</p>
                    }
                    for reference in &form.external_catalog_item_references {
                        let label = t.wb_merge_edit_references_drop(&reference.label).to_string();
                        <Checkbox label={&label}>
                            <input type="checkbox" name={f.drop_catalog_ref} value={reference.index}>
                        </Checkbox>
                    }
                </fieldset>
                <fieldset class={Edit}>
                    <legend>{t.wb_merge_edit_references_product()}</legend>
                    if form.external_product_references.is_empty() {
                        <p class={Muted}>{t.wb_merge_edit_references_empty()}</p>
                    }
                    for reference in &form.external_product_references {
                        let label = t.wb_merge_edit_references_drop(&reference.label).to_string();
                        <Checkbox label={&label}>
                            <input type="checkbox" name={f.drop_product_ref} value={reference.index}>
                        </Checkbox>
                    }
                </fieldset>
                <label class={Field}>
                    <span>{t.wb_merge_edit_reason()}</span>
                    <textarea name={f.reason} rows="2" required class={Textarea {}}></textarea>
                </label>
                <div class={DialogFooter {}}>
                    <button type="submit" class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}>
                        {t.wb_merge_edit_submit()}
                    </button>
                </div>
            </form>
        </dialog>
    }
}

fn observation_tone(status: &str) -> &'static str {
    match status {
        "promoted" => "success",
        "rejected" => "danger",
        "changed" => "warning",
        _ => "info",
    }
}

/// Source Observation review (`CatalogIntegrationSourceObservationReviewModule`): the filters, the
/// status choice as links, the page of rows with a box for each reviewable one and its Evidence
/// sheet, the pager, and Preview promotion, Defer and Reject for the checked ones. Preview promotion
/// sends the selection and confirmation the read built.
#[component(css = DailyPage)]
fn ReviewModule<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    model: &'a Daily,
    context: &'a str,
    manage: bool,
    aliases: Option<&'a AliasReview>,
) -> impl Render {
    let alias_action = at(&daily::url::Aliases.href(), context);
    let review = &model.source_observation_review;
    let total = review.status_filters.iter().find(|o| o.value == "all").map_or(0, |o| o.count);
    let status = review.filters.iter().find(|f| f.key == "status").and_then(|f| f.value.clone()).unwrap_or_else(|| "all".into());
    let daily_path = daily::home(context);
    let kept = daily::context_fields(context);
    // The read model's status filter, each option's link on this page; one it names that the page
    // has no words for, or whose link is not the daily route's, is not drawn.
    let choices: Vec<(String, String, bool)> = review
        .status_filters
        .iter()
        .filter_map(|option| {
            let label = match option.value.as_str() {
                "all" => t.wb_review_status_all(),
                "observed" => t.wb_review_status_observed(),
                "eligible" => t.wb_review_status_eligible(),
                "promoted" => t.wb_review_status_promoted(),
                "rejected" => t.wb_review_status_rejected(),
                _ => return None,
            };
            let href = daily::rebase(context, &option.href)?;
            Some((href, format!("{label}{}", t.wb_review_saved_count(&option.count.to_string())), option.value == status))
        })
        .collect();

    let narrowed = status != "all" && total > 0 && review.freshness != "unavailable";
    let pagination = &review.pagination;
    // The read model's links to the neighbouring pages, on this page.
    let page_link =
        |href: &Option<String>| href.as_deref().and_then(|href| daily::rebase(context, href)).and_then(|to| Local::parse(&to));
    let (previous, next) = (page_link(&pagination.previous_href), page_link(&pagination.next_href));
    let limit = pagination.limit.max(1);
    let pages = pagination.total.div_ceil(limit).max(1) as usize;
    let current = (pagination.offset / limit + 1) as usize;
    let range_start = if pagination.total == 0 { 0 } else { pagination.offset + 1 };
    let range_end = (pagination.offset + limit).min(pagination.total);
    let pager_summary = t
        .wb_review_pager_summary(crate::text::cat::WbReviewPagerSummary {
            range_start,
            range_end,
            total: pagination.total,
            current_page: current,
            page_count: pages,
        })
        .to_string();
    let action = at(&daily::url::Review.href(), context);
    let f = ReviewInput::FIELDS;
    let reviewable = review.rows.iter().any(ReviewRow::reviewable);
    let action_open = |key: &str| model.actions.iter().find(|a| a.key == key).is_none_or(|a| a.open());
    let defer = manage && reviewable && action_open("observation.defer");
    let reject = manage && reviewable && action_open("observation.reject");
    let scope = review.filters.iter().find(|f| f.key == "setId").and_then(|f| f.value.clone()).unwrap_or_default();
    let offered = manage && daily::promotion_command(model).is_some();
    let promotion = at(&daily::url::Promotion.href(), context);
    let previewable = offered && action_open("observation.promote") && review.rows.iter().any(ReviewRow::eligible);
    let in_scope = t.wb_review_status(pagination.total).to_string();
    let filtered =
        t.wb_review_empty_filtered(crate::text::cat::WbReviewEmptyFiltered { status: &status, scope: &scope, total }).to_string();
    html! {
        <Module
            id="wb-review"
            title={t.wb_review_title()}
            description={t.wb_review_description()}
            status={in_scope}
            tone={if review.rows.is_empty() { "warning" } else { "success" }}
        >
            if !review.filters.is_empty() {
                <div class={Badges} aria-label={t.wb_review_filters_title()} role="group">
                    for filter in &review.filters {
                        let value = filter.value.as_deref().unwrap_or(t.wb_not_selected());
                        let text = format!("{}: {value}", filter.label);
                        <Pill text={&text} tone={if filter.server_applied { "info" } else { "warning" }} />
                    }
                </div>
            }
            <nav class={Choices} aria-label={t.wb_review_filter_status()}>
                for (href, text, chosen) in &choices {
                    if *chosen {
                        <a class={Chosen} href={href} aria-current="true">{text}</a>
                    } else {
                        <a href={href}>{text}</a>
                    }
                }
            </nav>
            <AliasReviewPart t={t} p={p} action={&alias_action} review={aliases} failed={false} manage={manage} />
            <form id={EVIDENCE_OPEN} method="get" action={&daily_path} data-patch>
                for (name, value) in &kept {
                    <input type="hidden" name={name.as_str()} value={value.as_str()}>
                }
            </form>
            <form
                method="post"
                action={&action}
                class={(KitStack { gap: Gap::App }, gap_4(), Stack)}
                data-patch
                data-catalog-primary-workbench-command="observation.review"
            >
                if review.rows.is_empty() {
                    if narrowed {
                        <Empty
                            title={&filtered}
                            description={t.wb_review_empty_filtered_description()}
                        />
                    } else {
                        <Empty title={t.wb_review_empty_title()} description={t.wb_review_empty_description()} />
                    }
                } else {
                    <Table layout={TableLayout::Stack}>
                        <table>
                            <caption class={VisuallyHidden {}}>{t.wb_review_title()}</caption>
                            <thead>
                                <tr>
                                    <th scope="col"><span class={VisuallyHidden {}}>{p.integrations_review_select()}</span></th>
                                    <th scope="col">{t.wb_review_table_observation()}</th>
                                    <th scope="col">{t.wb_review_table_status()}</th>
                                    <th scope="col">{t.wb_review_table_evidence()}</th>
                                    <th scope="col">{t.wb_review_table_readiness()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &review.rows {
                                    <ReviewRowView t={t} p={p} req={req} row={row} manage={manage} />
                                }
                            </tbody>
                        </table>
                    </Table>
                }
                if pagination.total > limit {
                    <div class={Pager}>
                        <small>{pager_summary}</small>
                        // The read model gives only the neighbouring pages' links.
                        <PreviousNext
                            label={t.wb_review_pager_label()}
                            previous_label={t.wb_review_pager_previous()}
                            next_label={t.wb_review_pager_next()}
                            previous={previous.as_ref().map(|l| l as &dyn Href)}
                            next={next.as_ref().map(|l| l as &dyn Href)}
                            on:link={None::<Handler>}
                        />
                    </div>
                }
                if manage && reviewable {
                    <div class={Bulk}>
                        <label class={Field}>
                            <span>{t.wb_review_reject_reason()}</span>
                            <input type="text" name={f.reason} class={Input {}}>
                        </label>
                        <div class={Row}>
                            if offered {
                                <button
                                    type="submit"
                                    class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                                    formaction={&promotion}
                                    name={PromotionInput::FIELDS.phase}
                                    value="preview-checked"
                                    disabled={!previewable}
                                    aria-label={(!previewable).then(|| t.wb_review_bulk_preview_denied())}
                                >
                                    {t.wb_preview_promotion()}
                                </button>
                            }
                            <button
                                type="submit"
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                name={f.action}
                                value="defer"
                                disabled={!defer}
                            >
                                {t.wb_review_defer()}
                            </button>
                            <button
                                type="submit"
                                class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Sm }}
                                name={f.action}
                                value="reject"
                                disabled={!reject}
                            >
                                {t.wb_review_reject()}
                            </button>
                        </div>
                        <small class={Muted}>{p.integrations_review_note()}</small>
                    </div>
                }
            </form>
        </Module>
    }
}

/// The evidence sheet, and the GET form a review row's Evidence submits (its action the row's sheet,
/// its fields the working set).
#[derive(Id, Clone, Copy)]
pub struct EvidenceSheetId;
const EVIDENCE_OPEN: &str = "wb-evidence-open";

/// A Source Observation's evidence (admin-web's `SourceObservationEvidenceSheet`) in the kit's sheet
/// from the right, a record's width beside its list and never more than most of a phone's: drawn
/// open by the server and made modal when it joins the page, or the empty dialog a row's Evidence
/// answer replaces. A detail the API does not have is the sheet's error, as there. Its footer's
/// Preview promotion previews this observation's promotion (admin-web's button does nothing); the
/// sheet has no read model of its own, so a preview the working set's read does not offer is
/// refused as not offered.
#[component(css = DailyPage)]
pub fn EvidenceSheet<'a>(t: Cat, p: Pilot, evidence: Option<&'a ObservationEvidence>, context: &'a str) -> impl Patch {
    let heading = super::id_with(&EvidenceSheetId, "-title");
    let _ = p;
    html! {
        match evidence {
            None => <dialog id={EvidenceSheetId}></dialog>,
            Some(evidence) => {
                let detail = evidence.detail.as_ref();
                let name = detail.map_or(evidence.observation_id.as_str(), |d| d.display_name.as_str());
                let title = t.wb_review_evidence_title(name).to_string();
                let eligible = detail.is_some_and(|d| d.promotion_readiness.state == "eligible");
                let promotion = at(&daily::url::Promotion.href(), context);
                <dialog
                    class={Sheet { side: Side::Right(SheetWidth::Lg) }}
                    id={EvidenceSheetId}
                    aria-labelledby={&heading}
                    closedby="any"
                    open
                    on:connect={corten_ui::dialog::modal(target)}
                >
                    <div class={SheetHeader {}}>
                        <h2 id={&heading} class={Words}>{title}</h2>
                        <button
                            type="button"
                            class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                            command="close"
                            commandfor={EvidenceSheetId}
                        >
                            {t.wb_evidence_close()}
                        </button>
                    </div>
                    <p>{t.wb_review_evidence_description()}</p>
                    match detail {
                        None => {
                            <div data-catalog-observation-evidence="error">
                                <Banner
                                    tone="danger"
                                    title={t.wb_review_evidence_error_title()}
                                    description={t.wb_review_evidence_error_description()}
                                />
                            </div>
                        }
                        Some(detail) => { <EvidenceBody t={t} detail={detail} /> }
                    }
                    <div class={EvidenceFooter}>
                        if eligible {
                            <form
                                method="post"
                                action={&promotion}
                                data-patch
                                data-catalog-primary-workbench-command="observation.promote"
                            >
                                <input type="hidden" name={PromotionInput::FIELDS.observation} value={&evidence.observation_id}>
                                <button
                                    type="submit"
                                    class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                                    name={PromotionInput::FIELDS.phase}
                                    value="preview-checked"
                                >
                                    {t.wb_preview_promotion()}
                                </button>
                            </form>
                        } else {
                            <button
                                type="button"
                                class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                                disabled
                            >
                                {t.wb_blocked()}
                            </button>
                        }
                    </div>
                </dialog>
            }
        }
    }
}

/// The evidence's facts (admin-web's `KeyValueList`, in its order), then its lists and the blockers.
#[component(css = DailyPage)]
fn EvidenceBody<'a>(t: Cat, detail: &'a EvidenceDetail) -> impl Render {
    let contents = &detail.product_contents_evidence;
    let items = [
        (t.wb_key_provider(), detail.provider_key.clone()),
        (t.wb_review_key_external(), detail.external_key.clone()),
        (t.wb_review_key_source_url(), detail.source_url.clone()),
        (t.wb_review_key_hash(), detail.source_record_hash.clone()),
        (t.wb_review_key_observed(), detail.observed_at.clone()),
        (t.wb_review_key_changed(), detail.source_updated_at.clone().unwrap_or_else(|| detail.changed_at.clone())),
        (t.wb_key_profile(), detail.source_profile_version.clone()),
        (
            t.wb_review_key_promotion_profile(),
            detail.promotion_profile_version.clone().unwrap_or_else(|| t.wb_not_selected().to_owned()),
        ),
        (t.wb_review_key_payload(), detail.payload_summary.clone()),
        (t.wb_review_key_redaction(), detail.redaction_summary.clone()),
        (
            t.wb_review_key_command_preview(),
            detail.command_preview.promotion_plan_hash.clone().unwrap_or_else(|| t.wb_review_preview_required().to_owned()),
        ),
        (t.wb_review_evidence_product_contents(), contents.summary.clone()),
    ];
    let lines: Vec<String> = contents.rows.iter().map(|row| contents_line(t, row)).collect();
    html! {
        <div class={(KitStack { gap: Gap::App }, gap_4(), Stack)} data-catalog-observation-evidence="loaded">
            <Pairs items={&items} />
            <EvidenceList
                title={t.wb_review_evidence_normalized()}
                items={&detail.normalized_fact_summaries}
                empty={t.wb_none()}
            />
            <EvidenceList title={t.wb_review_evidence_product_contents()} items={&lines} empty={&contents.summary} />
            <EvidenceList
                title={t.wb_review_evidence_duplicates()}
                items={&detail.duplicate_evidence}
                empty={t.wb_review_evidence_no_duplicates()}
            />
            <EvidenceList
                title={t.wb_review_evidence_conflicts()}
                items={&detail.conflict_evidence}
                empty={t.wb_review_evidence_no_conflicts()}
            />
            <EvidenceList title={t.wb_review_evidence_audit()} items={&detail.audit_trail} empty={t.wb_none()} />
            <Blockers t={t} blockers={&detail.promotion_readiness.blockers} />
        </div>
    }
}

/// A titled list of the evidence's lines (admin-web's `EvidenceStringList`), or what it says for none.
#[component(css = DailyPage)]
fn EvidenceList<'a>(title: &'a str, items: &'a [String], empty: &'a str) -> impl Render {
    html! {
        <section class={EvidenceList}>
            <h3>{title}</h3>
            if items.is_empty() {
                <p class={Muted}>{empty}</p>
            } else {
                <ul>
                    for item in items {
                        <li class={Words}>{item}</li>
                    }
                </ul>
            }
        </section>
    }
}

/// A Product Contents line as the sheet says it (`productContentsEvidenceItems`).
fn contents_line(t: Cat, row: &ContentsLine) -> String {
    let join = |labels: &[String], none: &str| if labels.is_empty() { none.to_owned() } else { labels.join(", ") };
    let quantity = row.quantity.map_or_else(|| t.wb_review_product_contents_quantity_variable().to_owned(), |q| q.to_string());
    let options = join(&row.contained_selected_option_labels, t.wb_review_product_contents_selected_options_none());
    let provenance = join(&row.provenance_summary, t.wb_review_product_contents_provenance_none());
    let state = state_label(&row.state);
    t.wb_review_product_contents_line(crate::text::cat::WbReviewProductContentsLine {
        line_number: row.line_number,
        state: &state,
        content_type: &row.content_type_label,
        policy: row.inclusion_policy_label.as_deref().unwrap_or(t.wb_review_product_contents_policy_none()),
        quantity: &quantity,
        target: &row.target_summary,
        options: &options,
        provenance: &provenance,
    })
    .to_string()
}

#[component(css = DailyPage)]
fn ReviewRowView<'a>(t: Cat, p: Pilot, req: &'a Req, row: &'a ReviewRow, manage: bool) -> impl Render {
    let external = t
        .wb_review_table_external(crate::text::cat::WbReviewTableExternal {
            provider: &row.provider_key,
            external: &row.external_key,
        })
        .to_string();
    let status = state_label(&row.status);
    let changed = t.wb_review_table_changed(&when(t, row.source_updated_at.as_deref().unwrap_or(&row.changed_at))).to_string();
    let duplicates = t.wb_review_duplicate_count(row.duplicate_count).to_string();
    let readiness = state_label(&row.promotion_readiness.state);
    let detail = link_to(
        req,
        &crate::catalog::observation::url::Observation { id: &row.observation_id, after_write: None, done: None }.href(),
    );
    let choose = p.integrations_review_choose(&row.display_name).to_string();
    let evidence = daily::url::Evidence { id: &row.observation_id }.href().to_string();
    html! {
        <tr data-catalog-observation-row={&row.observation_id}>
            <td>
                if manage && row.reviewable() {
                    <Checkbox label={&choose}>
                        <input type="checkbox" name={ReviewInput::FIELDS.observation} value={&row.observation_id}>
                    </Checkbox>
                }
            </td>
            <td>
                <CellLabel>{t.wb_review_table_observation()}</CellLabel>
                <span class={CellBlock}>
                    match &detail {
                        Some(href) => { <a class={(Strong, Words)} href={href}>{&row.display_name}</a> }
                        None => { <span class={(Strong, Words)}>{&row.display_name}</span> }
                    }
                    <small class={(Muted, Words)}>{external}</small>
                    if !row.fact_summary_preview.is_empty() {
                        <span class={Badges}>
                            for fact in &row.fact_summary_preview {
                                <Pill text={fact} tone="neutral" />
                            }
                        </span>
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_review_table_status()}</CellLabel>
                <span class={CellBlock}>
                    <Pill text={&status} tone={observation_tone(&row.status)} />
                    <small>{changed}</small>
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_review_table_evidence()}</CellLabel>
                <span class={CellBlock}>
                    <Cell title={&row.payload_summary} description={None} detail={Some(row.redaction_summary.as_str())} />
                    if row.duplicate_count > 0 {
                        <Pill text={&duplicates} tone="warning" />
                    }
                    <button
                        type="submit"
                        class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Sm }}
                        form={EVIDENCE_OPEN}
                        formaction={&evidence}
                        data-catalog-observation-evidence-open={&row.observation_id}
                    >
                        {t.wb_evidence()}
                    </button>
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_review_table_readiness()}</CellLabel>
                <span class={CellBlock}>
                    <Pill
                        text={&readiness}
                        tone={if row.promotion_readiness.state == "eligible" { "success" } else { "warning" }}
                    />
                    if !row.promotion_readiness.blockers.is_empty() {
                        <Blockers t={t} blockers={&row.promotion_readiness.blockers} />
                    }
                </span>
            </td>
        </tr>
    }
}

/// Create / update items (`CatalogIntegrationCreateItemsStage`): the latest promotion outcome, then
/// the previewed impact of the working set's selection (or its scope), its pre-write validation,
/// and one form that previews again or, with the box confirmed, commits the preview the address
/// holds. The draft choice sits in that form, so a commit with a choice the preview did not bind is
/// refused and asks for a preview again, as admin-web's stage holds it back.
#[component(css = DailyPage)]
fn CreateModule<'a>(t: Cat, p: Pilot, req: &'a Req, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let preview = &model.promotion_preview;
    let offered = manage && daily::promotion_command(model).is_some();
    let open = model.actions.iter().find(|a| a.key == "observation.promote").is_some_and(|a| a.open());
    let fresh = preview.committable();
    let blocked = preview.identity_blocked();
    let draft = preview.validation.promote_as_draft;
    let scoped = t
        .wb_stage_create_promote_scope_scoped(crate::text::cat::WbStageCreatePromoteScopeScoped {
            count: preview.scope.eligible_count,
            scope: &preview.scope.label,
        })
        .to_string();
    let explicit = t
        .wb_stage_create_promote_scope_explicit(crate::text::cat::WbStageCreatePromoteScopeExplicit {
            count: preview.scope.requested_count,
            scope: &preview.scope.filter_summary.join(", "),
        })
        .to_string();
    let confirm = t
        .wb_stage_create_confirm(crate::text::cat::WbStageCreateConfirm {
            count: preview.scope.eligible_count,
            scope: &preview.scope.label,
        })
        .to_string();
    let freshness = state_label(&preview.freshness);
    let plan = preview.command_plan_hash.clone().unwrap_or_else(|| t.wb_review_preview_required().to_owned());
    let facts = [
        (t.wb_command_scope(), preview.scope.label.clone()),
        (t.wb_eligible_observations(), preview.scope.eligible_count.to_string()),
        (t.wb_command_plan(), plan),
    ];
    let counts = [
        (t.wb_count_matched(), preview.scope.requested_count.to_string()),
        (t.wb_count_eligible(), preview.outcome_counts.eligible.to_string()),
        (t.wb_count_blocked(), preview.outcome_counts.blocked.to_string()),
        (t.wb_count_skipped(), preview.outcome_counts.skipped.to_string()),
        (t.wb_count_conflicting(), preview.outcome_counts.conflicting.to_string()),
        (t.wb_item_updates(), preview.destructive_count.to_string()),
    ];
    let state = if fresh { t.wb_stage_create_preview_fresh() } else { t.wb_stage_create_preview_refresh() };
    let action = at(&daily::url::Promotion.href(), context);
    let f = PromotionInput::FIELDS;
    let provider = model.route_context.provider_key.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let items = crate::catalog::items::url::ItemQuery { source: provider.map(str::to_owned), ..Default::default() };
    let handoff = link_to(req, &crate::catalog::items::url::Items::of(&items).href().to_string());
    let handoff_label = match provider {
        Some(provider) => t.wb_stage_create_handoff_cta(provider).to_string(),
        None => t.wb_stage_create_handoff_cta_unscoped().to_owned(),
    };
    html! {
        <section class={(KitStack { gap: Gap::App }, gap_4(), Stack)} aria-labelledby="wb-create">
            <h2 id="wb-create" class={VisuallyHidden {}}>{t.wb_stage_create_label()}</h2>
            <p class={Lead}>{t.wb_stage_create_description()}</p>
            if let Some(result) = &model.promotion_result {
                let items = [
                    (t.wb_stage_create_outcome_job(), result.job_id.clone()),
                    (t.wb_stage_create_outcome_promoted(), result.promoted_count.to_string()),
                    (t.wb_stage_create_outcome_recorded_at(), maybe_when(t, Some(result.completed_at.as_str()))),
                ];
                <div class={Panel} data-catalog-promotion-outcome={&result.status}>
                    <p class={Strong}>{t.wb_stage_create_outcome_title()}</p>
                    <p class={Muted}>{t.wb_stage_create_outcome_description(&result.result_id).to_string()}</p>
                    <Pairs items={&items} />
                </div>
            }
            if offered {
                <form
                    method="post"
                    action={&action}
                    class={(Panel, KitStack { gap: Gap::App }, gap_4(), Stack)}
                    data-patch
                    data-catalog-primary-workbench-command="observation.promote"
                    data-catalog-promotion-preview={if fresh { "fresh" } else { "stale" }}
                >
                    <div class={Row}>
                        <span class={CellBlock}>
                            <span class={Strong}>{t.wb_stage_create_promote_scope_title()}</span>
                            <small class={Muted}>{scoped}</small>
                        </span>
                        <span class={Badges}>
                            <Pill text={t.wb_stage_create_scoped_badge()} tone="info" />
                            <Pill text={&freshness} tone={if fresh { "success" } else { "warning" }} />
                        </span>
                    </div>
                    <div class={Columns}>
                        <Pairs items={&facts} />
                        <Pairs items={&counts} />
                    </div>
                    <small class={Muted}>{explicit}</small>
                    <Checkbox label={t.wb_stage_create_promote_as_draft_label()}>
                        <input type="checkbox" name={f.draft} value="true" checked={draft}>
                    </Checkbox>
                    <small class={Muted}>{t.wb_stage_create_promote_as_draft_description()}</small>
                    <div class={Row}>
                        <span class={Strong}>{state}</span>
                        <button
                            type="submit"
                            class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Sm }}
                            name={f.phase}
                            value="preview"
                            disabled={!open}
                        >
                            {t.wb_preview_promotion()}
                        </button>
                    </div>
                    <PromotionValidation t={t} preview={preview} />
                    <Checkbox label={&confirm}>
                        <input type="checkbox" name={f.confirm} value="true" disabled={!open || !fresh || blocked}>
                    </Checkbox>
                    <div class={Row}>
                        <button
                            type="submit"
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Sm }}
                            name={f.phase}
                            value="execute"
                            disabled={!open || !fresh || blocked}
                        >
                            {t.wb_stage_create_commit()}
                        </button>
                    </div>
                    if !preview.blockers.is_empty() {
                        <Blockers t={t} blockers={&preview.blockers} />
                    }
                </form>
            }
            if let Some(href) = &handoff {
                <div class={(Panel, Row)}>
                    <span class={CellBlock}>
                        <span class={Strong}>{t.wb_stage_create_handoff_title()}</span>
                        <small class={Muted}>{t.wb_stage_create_handoff_description()}</small>
                    </span>
                    <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={href}>
                        {handoff_label}
                    </a>
                </div>
            }
        </section>
    }
}

/// The preview's pre-write validation (`CatalogIntegrationPromotionValidation`): how much it
/// validated, how many observations are blocked or carried as drafts, and each identity verdict.
/// Nothing before a preview.
#[component(css = DailyPage)]
fn PromotionValidation<'a>(t: Cat, preview: &'a PromotionPreview) -> impl Render {
    let validation = &preview.validation;
    let shown = validation.coverage != "not-previewed";
    let blocked = validation.identity_diagnostics.iter().filter(|d| d.blocking).count();
    let draft_only = validation.identity_diagnostics.len() - blocked;
    let coverage = if validation.coverage == "complete" {
        t.wb_stage_create_validation_coverage_complete(validation.covered_count).to_string()
    } else {
        t.wb_stage_create_validation_coverage_partial(validation.covered_count).to_string()
    };
    let verdicts: Vec<(&str, String, bool)> = validation
        .identity_diagnostics
        .iter()
        .map(|d| {
            let reason = match d.template_reason.as_str() {
                "unresolved-title-tokens" => t.wb_stage_create_validation_identity_reason_unresolved_title_tokens(),
                "no-targeted-template" => t.wb_stage_create_validation_identity_reason_no_targeted_template(),
                "missing-required-fields" => t.wb_stage_create_validation_identity_reason_missing_required_fields(),
                _ => "",
            };
            let text = if d.missing_tokens.is_empty() {
                t.wb_stage_create_validation_identity_observation_no_tokens(
                    crate::text::cat::WbStageCreateValidationIdentityObservationNoTokens {
                        observation_id: &d.observation_id,
                        reason: &d.diagnostic_text,
                    },
                )
                .to_string()
            } else {
                t.wb_stage_create_validation_identity_observation(crate::text::cat::WbStageCreateValidationIdentityObservation {
                    observation_id: &d.observation_id,
                    reason: &d.diagnostic_text,
                    tokens: &d.missing_tokens.join(", "),
                })
                .to_string()
            };
            (reason, text, d.blocking)
        })
        .collect();
    html! {
        if shown {
            <div class={(KitStack { gap: Gap::App }, Stack)} data-catalog-promotion-validation={&validation.coverage}>
                <p class={Strong}>{t.wb_stage_create_validation_title()}</p>
                <small class={Muted}>{coverage}</small>
                if blocked > 0 {
                    <small class={Strong}>{t.wb_stage_create_validation_identity_blocked(blocked).to_string()}</small>
                }
                if draft_only > 0 {
                    <small class={Muted}>{t.wb_stage_create_validation_identity_draft_only(draft_only).to_string()}</small>
                }
                if !validation.other_blocked_observation_ids.is_empty() {
                    <small class={Muted}>
                        {t.wb_stage_create_validation_other_blocked(validation.other_blocked_observation_ids.len()).to_string()}
                    </small>
                }
                if !verdicts.is_empty() {
                    <ul class={Verdicts}>
                        for (reason, text, blocking) in &verdicts {
                            <li class={Row}>
                                if !reason.is_empty() {
                                    <Pill text={reason} tone={if *blocking { "danger" } else { "warning" }} />
                                }
                                <span class={(Muted, Words)}>{text}</span>
                            </li>
                        }
                    </ul>
                }
            </div>
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sync_starts_when_open_or_blocked_only_on_the_units_to_choose() {
        let with = |state: &str, blockers: &[&str]| {
            let mut model = Daily::default();
            model.catalog_sync.action.state = state.into();
            model.catalog_sync.action.blockers = blockers.iter().map(|b| (*b).to_owned()).collect();
            sync_startable(&model)
        };
        assert!(with("available", &[]));
        assert!(with("degraded", &["provider-throttle"]));
        assert!(with("blocked", &["unit-selection-required"]));
        assert!(!with("blocked", &["unit-selection-required", "kill-switch-active"]));
        assert!(!with("denied", &[]));
    }
}
