//! The daily workbench (admin-web's `CatalogIntegrationImportToPromotionWorkspace` in its
//! `CatalogWorkbenchShell`): the shell, the governance and health banners, the flow's steps and
//! blockers, then its three stages, the open one expanded. The stages are `<details>` sharing a
//! name, so opening one closes the others and find-in-page opens the one that holds a match, with
//! no script. Every command is a form that posts to the pilot and lands back on the working set;
//! the rows' boxes sit inside their form, so a defer, a reject or a sync sends the checked ones
//! without JavaScript. Each table stacks on a phone, a row a block of labelled lines.
use corten::{Href, Local, prelude::*};
use platform::ui::{
    accordion::Accordion,
    alert::{Alert, AlertEmphasis, AlertVariant, FormAlert},
    button::{Button, ButtonSize, ButtonVariant},
    checkbox::Checkbox,
    input::Input,
    pagination::Pagination,
    steps::{Step, StepState, Steps, StepsLayout},
    table::{CellLabel, Table, TableLayout},
};

use super::integrations_page::{
    Banner, Blockers, Cell, Counts, Empty, Evidence, Module, Pairs, Pill, Shell, maybe_when, state_label, when,
};
use crate::{
    catalog::{
        daily::{
            self, CANDIDATE_COMMANDS, Candidate, CandidateInput, Daily, DailyScreen, Governance, Health, ImportJob, JobInput,
            Ran, ReviewInput, ReviewRow, Said, Stage, StageState, SyncInput, SyncRun, UnitState, at, with_query,
        },
        integrations,
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
    let open = daily::open_stage(model);
    let flow = daily::flow(model, open);
    let blockers = daily::blockers(model);
    let blocker_names: Vec<String> = blockers.iter().map(|b| (*b).to_owned()).collect();
    let settings = on(req, &integrations::url::Settings.href(), context);
    let health = on(req, &integrations::url::Health.href(), context);
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
                                    <JobsModule t={t} req={req} model={model} context={context} manage={screen.manage} />
                                }
                                Stage::Review => {
                                    <CandidatesModule t={t} p={p} model={model} context={context} manage={screen.manage} />
                                    <ReviewModule t={t} p={p} req={req} model={model} context={context} manage={screen.manage} />
                                }
                                Stage::Create => {
                                    <CreateModule t={t} p={p} model={model} context={context} />
                                }
                            }
                        </div>
                    </details>
                }
            </div>
        </Shell>
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
            <form method="post" action={&action} class={Stack} data-patch data-catalog-primary-workbench-command="scope.sync">
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
                            <caption class={Hidden}>{t.wb_sync_title()}</caption>
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
                    <caption class={Hidden}>{p.integrations_sync_run_caption()}</caption>
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
                    <caption class={Hidden}>{t.wb_sync_state_title()}</caption>
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

/// The import jobs (`CatalogIntegrationImportJobsModule`): each with its progress, failure groups
/// and usage, and the retry, resume and cancel the API offers it.
#[component(css = DailyPage)]
fn JobsModule<'a>(t: Cat, req: &'a Req, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let jobs = &model.import_jobs;
    let status = t.wb_import_operations_status(jobs.active_job_count).to_string();
    let none = t.wb_none();
    html! {
        <Module
            id="wb-jobs"
            title={t.wb_import_operations_title()}
            description={t.wb_import_operations_description()}
            status={status}
            tone={if jobs.active_job_count > 0 { "warning" } else { "success" }}
        >
            if jobs.jobs.is_empty() {
                <Empty title={t.wb_jobs_empty_title()} description={t.wb_jobs_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Hidden}>{t.wb_stage_supporting_jobs()}</caption>
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

fn candidate_tone(status: &str) -> &'static str {
    match status {
        "ready" | "promoted" => "success",
        "has-conflicts" | "rejected" => "danger",
        _ => "warning",
    }
}

/// Merged candidate review (`CatalogIntegrationMergeCandidateReviewModule`): each candidate's
/// identity, sources, status and readiness, and the ignore and defer the API offers it; its
/// evidence, edit, split and promotion open on admin-web.
#[component(css = DailyPage)]
fn CandidatesModule<'a>(t: Cat, p: Pilot, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let merge = &model.merge_candidate_review;
    let ready = t.wb_merge_ready_count(merge.counts.ready).to_string();
    let elsewhere = admin_web(&at("/catalog/integrations", context)).map(|u| u.to_string());
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
                        <caption class={Hidden}>{t.wb_merge_title()}</caption>
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
                                <CandidateRow t={t} row={row} context={context} manage={manage} />
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if let Some(href) = &elsewhere {
                <p class={Muted}>
                    {p.integrations_candidates_elsewhere()}
                    " "
                    <a href={href}>{p.integrations_candidates_open()}</a>
                </p>
            }
        </Module>
    }
}

/// A candidate's row. Its ignore and defer are one form's buttons, each disabled unless the API
/// offers it (admin-web's `MergeCandidateActionButton`), with the blockers of those it does not.
#[component(css = DailyPage)]
fn CandidateRow<'a>(t: Cat, row: &'a Candidate, context: &'a str, manage: bool) -> impl Render {
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
                    if manage && !commands.is_empty() {
                        <form
                            method="post"
                            action={&action}
                            class={Row}
                            data-patch
                            data-catalog-primary-workbench-command="candidate"
                        >
                            for (entry, word) in &commands {
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
                    if !blocked.is_empty() {
                        <Blockers t={t} blockers={&blocked} />
                    }
                </span>
            </td>
        </tr>
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
/// status choice as links, the page of rows with a box for each reviewable one, the pager, and
/// Defer and Reject for the checked ones. Preview promotion opens on admin-web
/// (chase-sets/chase-sets#11045).
#[component(css = DailyPage)]
fn ReviewModule<'a>(t: Cat, p: Pilot, req: &'a Req, model: &'a Daily, context: &'a str, manage: bool) -> impl Render {
    let review = &model.source_observation_review;
    let c = &review.counts;
    let total = c.observed + c.changed + c.promoted + c.rejected;
    let status = review.filters.iter().find(|f| f.key == "status").and_then(|f| f.value.clone()).unwrap_or_else(|| "all".into());
    let options = [
        ("all", t.wb_review_status_all(), total),
        ("observed", t.wb_review_status_observed(), c.observed),
        ("eligible", t.wb_review_status_eligible(), c.eligible),
        ("promoted", t.wb_review_status_promoted(), c.promoted),
        ("rejected", t.wb_review_status_rejected(), c.rejected),
    ];
    let daily_path = daily::url::Daily.href();
    // Workaround (chase-sets/chase-sets#11047): the status links, as admin-web's `selectStatus`
    // builds them.
    let choices: Vec<(String, String, bool)> = options
        .iter()
        .map(|(value, label, count)| {
            let chosen = (*value != "all").then_some(*value);
            let href =
                at(&daily_path, &with_query(context, &[("status", None), ("reviewOffset", None), ("filter.status", chosen)]));
            (href, format!("{label}{}", t.wb_review_saved_count(&count.to_string())), *value == status)
        })
        .collect();
    let narrowed = status != "all" && total > 0 && review.freshness != "unavailable";
    let pagination = &review.pagination;
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
    let elsewhere = admin_web(&at("/catalog/integrations", context)).map(|u| u.to_string());
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
            <form
                method="post"
                action={&action}
                class={Stack}
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
                            <caption class={Hidden}>{t.wb_review_title()}</caption>
                            <thead>
                                <tr>
                                    <th scope="col"><span class={Hidden}>{p.integrations_review_select()}</span></th>
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
                        <Pagination
                            label={t.wb_review_pager_label()}
                            previous_label={t.wb_review_pager_previous()}
                            next_label={t.wb_review_pager_next()}
                            pages={pages}
                            current={current}
                            link={&|n| review_page(context, limit, n)}
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
            if let Some(href) = &elsewhere {
                <p class={Muted}>
                    {p.integrations_preview_elsewhere()}
                    " "
                    <a href={href}>{p.integrations_preview_open()}</a>
                </p>
            }
        </Module>
    }
}

/// The review's page `n` (from 1) of the working set `context`, owned: the kit's `Pagination` ties
/// a named closure's borrow to its links' lifetime (todd-skelton/corten#862), so an inline closure
/// calls this.
// Workaround (chase-sets/chase-sets#11047): a page's link, as admin-web's pager builds it.
fn review_page(context: &str, limit: u64, n: usize) -> Box<dyn Href> {
    let offset = ((n as u64).saturating_sub(1) * limit).to_string();
    let offset = (n > 1).then_some(offset.as_str());
    let to = at(&daily::url::Daily.href(), &with_query(context, &[("reviewOffset", offset)]));
    match Local::parse(&to) {
        Some(local) => Box::new(local),
        None => Box::new(daily::url::Daily),
    }
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

/// Create / update items (`CatalogIntegrationCreateItemsStage`): the latest promotion outcome, and
/// the way to preview and promote, which opens on admin-web (chase-sets/chase-sets#11045).
#[component(css = DailyPage)]
fn CreateModule<'a>(t: Cat, p: Pilot, model: &'a Daily, context: &'a str) -> impl Render {
    let elsewhere = admin_web(&at("/catalog/integrations", &with_query(context, &[("section", Some("promotion-preview"))])))
        .map(|u| u.to_string());
    html! {
        <section class={Stack} aria-labelledby="wb-create">
            <h2 id="wb-create" class={Hidden}>{t.wb_stage_create_label()}</h2>
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
            if let Some(href) = &elsewhere {
                <Alert variant={AlertVariant::Info} emphasis={AlertEmphasis::Outline}>
                    <p>{p.integrations_create_elsewhere()}</p>
                    <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={href}>
                        {p.integrations_create_open()}
                    </a>
                </Alert>
            }
        </section>
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
