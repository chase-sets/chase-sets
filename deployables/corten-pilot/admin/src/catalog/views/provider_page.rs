//! Provider detail (admin-web's `CatalogProviderDetailPage`): the provider's header with its
//! transport readiness, the refresh schedule, the selected profile's evidence and its draft, the
//! version history with its lifecycle actions, the units it takes part in and its recent jobs, in
//! admin-web's order. Every command is a form that posts to the pilot and lands back on the page;
//! a lifecycle action needs its box checked, and a refusal is drawn at the top, patched in place
//! with JavaScript. A job's details are a disclosure, so they open without a script. Each table
//! stacks on a phone, a row a block of labelled lines.
use corten::prelude::*;
use platform::ui::{
    accordion::Accordion,
    alert::{Alert, AlertEmphasis, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    card::{Card, CardContent},
    checkbox::Checkbox,
    input::Input,
    table::{CellLabel, Table, TableLayout},
};

use super::integrations_page::{Banner, Blockers, Cell, Empty, Metric, Module, Pairs, Pill, maybe_when, state_label, when};
use crate::{
    catalog::{
        daily::{ImportJob, JobInput, at},
        provider::{
            self, Done, DraftInput, LifecycleInput, Model, Operation, Profile, ProviderScreen, RefreshInput, Said, Schedule,
        },
    },
    text::{Cat, Pilot},
    views::{admin_web, link_to},
};

/// The form whose refusal the page draws (a refused command's message at the top of the page).
#[derive(Id, Clone, Copy)]
pub struct ProviderRefusalId;

/// A refused command's message, where the page's notice goes, in the kit's destructive alert.
/// Workaround (todd-skelton/corten#861): `form_message()` is its own `role="alert"`, so inside
/// the kit's `Alert` it is two nested alerts; the alert takes the message's text.
#[component(css = ProviderPage)]
pub fn ProviderRefusal<'a>(errors: &'a Errors) -> impl Patch {
    html! {
        <div class={Notice} id={ProviderRefusalId}>
            if let Some(message) = errors.form() {
                <Alert variant={AlertVariant::Destructive} emphasis={AlertEmphasis::Outline}><p>{message}</p></Alert>
            }
        </div>
    }
}

fn outcome(t: Cat, p: Pilot, done: Done) -> (&'static str, &'static str) {
    match done {
        Done::Paused => (p.provider_paused_title(), p.provider_paused_description()),
        Done::Resumed => (p.provider_resumed_title(), p.provider_resumed_description()),
        Done::Ran => (p.provider_ran_title(), p.provider_ran_description()),
        Done::Drafted => (t.feedback_draft_title(), t.feedback_draft_description()),
        Done::RolledBack => (t.feedback_rollback_title(), t.feedback_rollback_description()),
        Done::Deprecated => (t.feedback_deprecated_title(), t.feedback_deprecated_description()),
        Done::Retired => (t.feedback_retired_title(), t.feedback_retired_description()),
        Done::Queued => (t.feedback_queued_title(), t.feedback_queued_description()),
        Done::Cancelled => (t.feedback_cancelled_title(), t.feedback_cancelled_description()),
    }
}

fn status_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "blocked" | "unavailable" => "danger",
        _ => "warning",
    }
}

fn credential_tone(status: &str) -> &'static str {
    match status {
        "ready" | "configured" => "success",
        "blocked" | "missing" | "invalid" | "expired" => "danger",
        "degraded" | "unknown" => "warning",
        _ => "neutral",
    }
}

fn lifecycle_tone(lifecycle: &str) -> &'static str {
    match lifecycle {
        "active" => "success",
        "retired" => "danger",
        "deprecated" => "warning",
        _ => "neutral",
    }
}

fn action_tone(state: &str) -> &'static str {
    match state {
        "available" => "success",
        "denied" | "unsafe" | "blocked" => "danger",
        "degraded" => "warning",
        _ => "neutral",
    }
}

fn job_tone(state: &str) -> &'static str {
    match state {
        "completed" => "success",
        "failed" | "cancelled" => "danger",
        "queued" | "running" => "warning",
        _ => "neutral",
    }
}

/// A failure group's words, by its key (admin-web's `failureGroupLabel`; the read model's label is
/// the machine key).
fn failure_label(t: Cat, key: &str, label: &str) -> String {
    match key {
        "durable-job-cancelled" => return t.wb_jobs_failure_cancelled().to_owned(),
        "durable-job-failed" => return t.wb_jobs_failure_durable().to_owned(),
        "partial-provider-data" => return t.wb_jobs_failure_partial().to_owned(),
        "stale-replay" => return t.wb_jobs_failure_stale_replay().to_owned(),
        _ => {}
    }
    let Some(category) = key.strip_prefix("provider-transport-") else {
        return label.to_owned();
    };
    let words = match category {
        "rate-limit" => t.wb_copy_rate_limit_cooldown(),
        "throttle" => t.wb_copy_provider_throttle(),
        "quota" => t.wb_copy_provider_quota_exhausted(),
        "timeout" => t.wb_copy_provider_timeout(),
        "pagination-failure" => t.wb_copy_provider_pagination_failed(),
        "partial-data" => t.wb_copy_partial_provider_data(),
        "stale-cache" => t.wb_copy_stale_provider_cache(),
        "degraded-provider" => t.wb_copy_provider_degraded(),
        other => return t.wb_jobs_failure_transport(other).to_string(),
    };
    t.wb_jobs_failure_transport(words).to_string()
}

/// A list, or the words for none (`joinOrFallback`).
fn joined(t: Cat, values: &[String]) -> String {
    if values.is_empty() { t.wb_profile_not_reported().to_owned() } else { values.join(", ") }
}

/// An optional value, or "not reported".
fn reported(t: Cat, value: Option<&str>) -> String {
    value.filter(|v| !v.is_empty()).map_or_else(|| t.wb_profile_not_reported().to_owned(), str::to_owned)
}

/// The page: the header, the notice, then admin-web's sections in its order.
#[component(css)]
pub fn ProviderPage<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    screen: &'a ProviderScreen,
    context: &'a str,
    said: Option<&'a Said<'a>>,
) -> impl Render {
    let model = &screen.read.read_model;
    let key = screen.key.as_str();
    let admin = admin_web(&at(&provider::url::Provider { key }.href().to_string(), context)).map(|uri| uri.to_string());
    let sections = model.profile_authoring.section_workspaces.len();
    html! {
        <div class={Page} data-catalog-provider-detail="true">
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.pd_eyebrow()}</p>
                    <h1 class={Words}>{key}</h1>
                    <p class={Muted}>{t.pd_description()}</p>
                </div>
                if let Some(admin) = &admin {
                    <div class={Actions}>
                        <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={admin}>
                            {p.provider_elsewhere_open()}
                        </a>
                    </div>
                }
            </header>
            match said {
                Some(Said::Done(done)) => {
                    let (title, description) = outcome(t, p, *done);
                    <div class={Notice} id={ProviderRefusalId} role="status">
                        <Banner tone="success" title={title} description={description} />
                    </div>
                }
                Some(Said::Refused(errors)) => { <ProviderRefusal errors={errors} /> }
                None => { <div class={Notice} id={ProviderRefusalId}></div> }
            }
            <Head t={t} p={p} model={model} key={key} />
            if screen.operator_session {
                <p class={Note}>
                    {p.provider_operator_session()}
                    " "
                    if let Some(admin) = &admin {
                        <a href={admin}>{p.provider_operator_session_open()}</a>
                    }
                </p>
            }
            if let Some(schedules) = &screen.schedule {
                <SchedulePanel t={t} req={req} key={key} context={context} schedules={schedules} manage={screen.manage} />
            }
            match &model.profile_authoring.selected_profile {
                Some(profile) => { <Overview t={t} profile={profile} /> }
                None => { <Empty title={t.wb_profile_empty_title()} description={t.wb_profile_empty_description()} /> }
            }
            <DraftModule t={t} model={model} key={key} context={context} manage={screen.manage} />
            if sections > 0 {
                <Module
                    id="pd-sections"
                    title={t.wb_profile_sections_title()}
                    description={t.wb_profile_sections_description()}
                    status={t.wb_profile_sections_count(sections).to_string()}
                    tone="neutral"
                >
                    <p class={Muted}>
                        {p.provider_elsewhere()}
                        " "
                        if let Some(admin) = &admin {
                            <a href={admin}>{p.provider_elsewhere_open()}</a>
                        }
                    </p>
                </Module>
            }
            <History t={t} p={p} req={req} model={model} key={key} context={context} manage={screen.manage} />
            <Units t={t} model={model} key={key} />
            <Jobs t={t} p={p} req={req} model={model} key={key} context={context} manage={screen.manage} />
        </div>
    }
}

/// Identity and transport readiness (`ProviderDetailHeader`), from the health triage's rows.
#[component(css = ProviderPage)]
fn Head<'a>(t: Cat, p: Pilot, model: &'a Model, key: &'a str) -> impl Render {
    let triage = &model.health_triage;
    let row = triage.providers.iter().find(|r| r.provider_key == key);
    let units: Vec<_> = triage.units.iter().filter(|u| u.provider_key == key).collect();
    let blocked = units.iter().filter(|u| u.status == "blocked").count();
    let status = row.map_or("unavailable", |r| r.status.as_str());
    let credential = row.map_or_else(|| t.wb_not_selected().to_owned(), |r| r.credential_readiness_state.clone());
    let credential_tone = credential_tone(row.map_or("unknown", |r| r.credential_readiness.as_str()));
    let title = match status {
        "ready" => t.pd_header_ready_title(),
        "blocked" | "unavailable" => t.pd_header_blocked_title(),
        _ => t.pd_header_degraded_title(),
    };
    let summary = t.pd_header_units(crate::text::cat::PdHeaderUnits { count: units.len(), blocked }).to_string();
    let or_none = |v: Option<&String>| v.cloned().unwrap_or_else(|| t.wb_not_selected().to_owned());
    let items = [
        (t.wb_health_capability_api(), or_none(row.map(|r| &r.api_reachability))),
        (t.wb_health_capability_options(), or_none(row.map(|r| &r.option_query_health))),
        (t.wb_health_capability_rate_limit(), or_none(row.map(|r| &r.rate_limit_status))),
        (t.wb_health_capability_payload(), or_none(row.map(|r| &r.payload_acquisition))),
        (t.wb_health_table_freshness(), state_label(&triage.freshness)),
        (t.wb_health_table_generated(), maybe_when(t, triage.generated_at.as_deref())),
        (
            t.wb_health_table_diagnostics(),
            row.and_then(|r| r.latest_diagnostic_text.clone()).unwrap_or_else(|| t.wb_none().to_owned()),
        ),
    ];
    let label = state_label(status);
    let _ = p;
    html! {
        <section class={Card {}} aria-labelledby="pd-head">
            <div class={(CardContent {}, Stack)}>
                <div class={CardHead}>
                    <h2 id="pd-head" class={Words}>{row.map_or(key, |r| r.provider_key.as_str())}</h2>
                    <span class={Badges}>
                        <Pill text={&label} tone={status_tone(status)} />
                        <Pill text={&credential} tone={credential_tone} />
                    </span>
                </div>
                <p class={Muted}>{t.pd_header_description()}</p>
                <Banner tone={status_tone(status)} title={title} description={&summary} />
                <Pairs items={&items} />
            </div>
        </section>
    }
}

/// The source-option refresh schedule (`ProviderRefreshSchedulePanel`): its cadence, its last and
/// next run, and Pause or Resume and Run now for a manager.
#[component(css = ProviderPage)]
fn SchedulePanel<'a>(
    t: Cat,
    req: &'a Req,
    key: &'a str,
    context: &'a str,
    schedules: &'a [Schedule],
    manage: bool,
) -> impl Render {
    let action = at(&provider::url::Refresh { key }.href().to_string(), context);
    let _ = req;
    html! {
        <section class={Panel} aria-labelledby="pd-schedule" data-catalog-provider-refresh-schedule="panel">
            <h2 id="pd-schedule" class={PanelTitle}>{t.schedule_title()}</h2>
            <p class={Muted}>{t.schedule_description()}</p>
            if schedules.is_empty() {
                <Empty title={t.schedule_empty()} description="" />
            }
            for s in schedules {
                let (badge, tone) = if s.paused {
                    (t.schedule_schedule_paused(), "warning")
                } else if s.manual_only {
                    (t.schedule_schedule_manual_only(), "neutral")
                } else if !s.schedule_enabled {
                    (t.schedule_schedule_disabled(), "neutral")
                } else {
                    (t.schedule_schedule_scheduled(), "success")
                };
                let hours = (s.interval_ms as f64 / 3_600_000.0).round().to_string();
                let cadence = t.schedule_cadence_hours(&hours).to_string();
                let last = match (s.last_run_status.as_deref(), s.last_run_completed_at.as_deref()) {
                    (Some(status), Some(at)) => {
                        let word = match status {
                            "succeeded" => t.schedule_last_run_succeeded(),
                            "failed" => t.schedule_last_run_failed(),
                            _ => t.schedule_last_run_skipped_no_targets(),
                        };
                        format!("{word} ({})", when(t, at))
                    }
                    _ => t.schedule_last_run_never().to_owned(),
                };
                let last = t.schedule_last_run_summary(&last).to_string();
                let next = s.next_run_at.as_deref().filter(|_| s.scheduled()).map(|at| t.schedule_next_run_summary(&when(t, at)).to_string());
                <div class={ScheduleRow} data-catalog-provider-refresh-schedule-row={&s.provider_key}>
                    <div class={Row}>
                        <span class={Strong}>{&s.provider_key}</span>
                        <Pill text={badge} tone={tone} />
                        <small class={Muted}>{cadence}</small>
                    </div>
                    <div class={Row}>
                        <small class={Muted}>{last}</small>
                        if s.last_run_status.as_deref() == Some("failed") {
                            <Pill text={t.schedule_last_run_failed()} tone="danger" />
                        }
                    </div>
                    if let Some(error) = s.last_run_error.as_deref().filter(|_| s.last_run_status.as_deref() == Some("failed")) {
                        <small class={(Muted, Words)}>{error}</small>
                    }
                    if let Some(next) = &next {
                        <small class={Muted}>{next}</small>
                    }
                    if manage {
                        <form method="post" action={&action} class={Row} data-patch>
                            if s.pausable() {
                                <button
                                    type="submit"
                                    class={Button {
                                        variant: if s.paused { ButtonVariant::Primary } else { ButtonVariant::Secondary },
                                        size: ButtonSize::Sm,
                                    }}
                                    name={RefreshInput::FIELDS.command}
                                    value={if s.paused { "resume" } else { "pause" }}
                                >
                                    {if s.paused { t.schedule_resume() } else { t.schedule_pause() }}
                                </button>
                            }
                            <button
                                type="submit"
                                class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                                name={RefreshInput::FIELDS.command}
                                value="run"
                            >
                                {t.schedule_run_now()}
                            </button>
                        </form>
                    }
                </div>
            }
        </section>
    }
}

/// The selected profile's evidence (`ProfileOverviewEvidence`): four panels.
#[component(css = ProviderPage)]
fn Overview<'a>(t: Cat, profile: &'a Profile) -> impl Render {
    let yes_no = |on: bool| if on { t.wb_profile_yes() } else { t.wb_profile_no() }.to_owned();
    let identity = [
        (t.wb_key_provider(), profile.provider_key.clone()),
        (t.wb_key_profile(), profile.profile_key.clone()),
        (t.wb_profile_key_version(), profile.profile_version.clone()),
        (t.wb_profile_key_connector(), profile.connector_kind.clone()),
        (t.wb_profile_key_mapping_kind(), profile.mapping_output_kind.clone()),
        (t.wb_profile_key_mapping_fingerprint(), reported(t, profile.mapping_fingerprint.as_deref())),
    ];
    let validation = [
        (t.wb_profile_key_capabilities(), joined(t, &profile.capabilities)),
        (t.wb_profile_key_scopes(), joined(t, &profile.supported_scopes)),
        (t.wb_profile_key_languages(), joined(t, &profile.language_options)),
        (t.wb_profile_key_executable(), yes_no(profile.has_executable_mapping_contract)),
        (t.wb_profile_key_latest_diagnostic(), reported(t, profile.validation.latest_diagnostic_text.as_deref())),
    ];
    let fixtures = [
        (t.wb_profile_key_fixture_root(), profile.fixtures.fixture_root.clone()),
        (t.wb_profile_key_covered_flows(), joined(t, &profile.fixtures.covered_flows)),
        (t.wb_profile_key_source_owner(), profile.source_contract.owner.clone()),
        (t.wb_profile_key_source_repository(), reported(t, profile.source_contract.repository.as_deref())),
        (t.wb_profile_key_fixture_version(), profile.source_contract.fixture_set_version.clone()),
    ];
    let audit = [
        (t.wb_profile_key_created(), reported(t, profile.authoring_audit.created_at.as_deref())),
        (t.wb_profile_key_created_by(), reported(t, profile.authoring_audit.created_by_user_id.as_deref())),
        (t.wb_profile_key_updated(), reported(t, profile.authoring_audit.updated_at.as_deref())),
        (t.wb_profile_key_updated_by(), reported(t, profile.authoring_audit.updated_by_user_id.as_deref())),
        (t.wb_profile_key_migration_recorded(), reported(t, profile.migration_evidence.recorded_at.as_deref())),
    ];
    let lifecycle = state_label(&profile.lifecycle);
    let valid = state_label(&profile.validation.status);
    let migration = state_label(&profile.migration_evidence.state);
    let (fixture_word, fixture_tone) = if profile.fixtures.live_provider_calls_allowed {
        (t.wb_profile_fixtures_live(), "warning")
    } else {
        (t.wb_profile_fixtures_offline(), "success")
    };
    html! {
        <div class={Columns}>
            <Evidence
                id="pd-overview"
                title={t.wb_profile_overview_title()}
                description={t.wb_profile_overview_description()}
                status={&lifecycle}
                tone={if profile.active { "success" } else { lifecycle_tone(&profile.lifecycle) }}
                items={&identity}
            />
            <Evidence
                id="pd-validation"
                title={t.wb_profile_validation_title()}
                description={t.wb_profile_validation_description()}
                status={&valid}
                tone={if profile.validation.status == "valid" { "success" } else { "danger" }}
                items={&validation}
            />
            <Evidence
                id="pd-fixtures"
                title={t.wb_profile_fixtures_title()}
                description={t.wb_profile_fixtures_description()}
                status={fixture_word}
                tone={fixture_tone}
                items={&fixtures}
            />
            <Evidence
                id="pd-audit"
                title={t.wb_profile_audit_title()}
                description={t.wb_profile_audit_description()}
                status={&migration}
                tone={if profile.migration_evidence.state == "recorded" { "success" } else { "neutral" }}
                items={&audit}
            />
        </div>
    }
}

/// An evidence panel (`EvidencePanel`): its heading and status, then its values.
#[component(css = ProviderPage)]
fn Evidence<'a>(
    id: &'a str,
    title: &'a str,
    description: &'a str,
    status: &'a str,
    tone: &'static str,
    items: &'a [(&'a str, String)],
) -> impl Render {
    html! {
        <section class={Panel} aria-labelledby={id}>
            <div class={Row}>
                <h2 id={id} class={PanelTitle}>{title}</h2>
                <Pill text={status} tone={tone} />
            </div>
            <p class={Muted}>{description}</p>
            <Pairs items={items} />
        </section>
    }
}

/// Create draft profile: its blockers and the form, for a manager when the API offers it.
#[component(css = ProviderPage)]
fn DraftModule<'a>(t: Cat, model: &'a Model, key: &'a str, context: &'a str, manage: bool) -> impl Render {
    let draft = &model.profile_authoring.clone_draft;
    let open = draft.open() && manage;
    let action = at(&provider::url::Draft { key }.href().to_string(), context);
    let f = DraftInput::FIELDS;
    let source = draft.source_profile_version.clone().unwrap_or_default();
    let target = draft.target_profile_version.clone().unwrap_or_default();
    let help = if draft.state == "denied" { t.wb_profile_draft_denied() } else { t.wb_profile_draft_help() };
    let status = state_label(&draft.state);
    html! {
        <Module
            id="pd-draft"
            title={t.wb_profile_draft_title()}
            description={t.wb_profile_draft_description()}
            status={status}
            tone={action_tone(&draft.state)}
        >
            <div class={Columns}>
                <div class={Stack}>
                    <Blockers t={t} blockers={&draft.blockers} />
                </div>
                <form
                    method="post"
                    action={&action}
                    class={Form}
                    data-patch
                    data-catalog-primary-workbench-command="provider-profile.clone"
                >
                    <input type="hidden" name={f.source_profile_version} value={&source}>
                    <label class={Field}>
                        <span>{t.wb_profile_draft_target_label()}</span>
                        <input
                            type="text"
                            class={Input {}}
                            name={f.target_profile_version}
                            value={&target}
                            required
                            disabled={!open}
                            aria-describedby="pd-draft-help"
                        >
                    </label>
                    <small id="pd-draft-help" class={Muted}>{help}</small>
                    <div>
                        <button
                            type="submit"
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            disabled={!open}
                        >
                            {t.wb_profile_draft_submit()}
                        </button>
                    </div>
                </form>
            </div>
        </Module>
    }
}

/// The version history (`ProviderVersionHistory`): its metrics and table, a panel per lifecycle
/// operation with its confirmation, the strict retirement rule and the lifecycle audit.
#[component(css = ProviderPage)]
fn History<'a>(t: Cat, p: Pilot, req: &'a Req, model: &'a Model, key: &'a str, context: &'a str, manage: bool) -> impl Render {
    let r = &model.lifecycle_recovery;
    let s = &r.summary;
    let count = p.provider_versions(r.profiles.len()).to_string();
    let operations: Vec<&Operation> = r.operations.iter().filter(|o| o.operation != "activation").collect();
    let action = at(&provider::url::Lifecycle { key }.href().to_string(), context);
    let rule = [
        (p.provider_required_disposition(), r.strict_retirement.required_disposition.clone()),
        (p.provider_forbidden_paths(), r.strict_retirement.forbidden_support_paths.join(", ")),
    ];
    html! {
        <Module
            id="pd-versions"
            title={t.recovery_profile_candidates_title()}
            description={t.recovery_profile_candidates_description()}
            status={count}
            tone="neutral"
        >
            <dl class={Metrics}>
                <Metric
                    label={t.recovery_metric_affected_references()}
                    value={s.affected_references.to_string()}
                    trend={p.provider_downstream(s.downstream_profile_references).to_string()}
                />
                <Metric label={t.recovery_metric_active_jobs()} value={s.active_jobs.to_string()} trend={r.freshness.clone()} />
                <Metric
                    label={t.recovery_metric_impacted_catalog_items()}
                    value={s.impacted_catalog_items.to_string()}
                    trend={p.provider_blocker_count(s.blockers).to_string()}
                />
            </dl>
            if r.profiles.is_empty() {
                <Empty
                    title={t.recovery_profile_candidates_empty_title()}
                    description={t.recovery_profile_candidates_empty_description()}
                />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Hidden}>{t.recovery_profile_candidates_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.recovery_table_profile()}</th>
                                <th scope="col">{t.recovery_table_lifecycle()}</th>
                                <th scope="col">{t.recovery_table_references()}</th>
                                <th scope="col">{t.recovery_table_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for v in &r.profiles {
                                let lifecycle = state_label(&v.lifecycle);
                                let detail = format!("{}@{}", v.profile_key, v.profile_version);
                                let inspect = link_to(req, &v.href);
                                <tr>
                                    <td>
                                        <CellLabel>{t.recovery_table_profile()}</CellLabel>
                                        <Cell title={&v.display_name} description={Some(detail.as_str())} detail={None} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.recovery_table_lifecycle()}</CellLabel>
                                        <span class={Badges}>
                                            <Pill
                                                text={&lifecycle}
                                                tone={if v.active { "success" } else { lifecycle_tone(&v.lifecycle) }}
                                            />
                                            if v.active {
                                                <Pill text={t.recovery_badge_active()} tone="accent" />
                                            }
                                            if v.provider_key == key {
                                                <Pill text={t.recovery_badge_selected_provider()} tone="neutral" />
                                            }
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.recovery_table_references()}</CellLabel>
                                        {v.reference_count.to_string()}
                                    </td>
                                    <td>
                                        <CellLabel>{t.recovery_table_action()}</CellLabel>
                                        if let Some(inspect) = &inspect {
                                            <a
                                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                                href={inspect}
                                            >
                                                {t.recovery_table_inspect()}
                                            </a>
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            <div class={Columns}>
                for op in &operations {
                    <OperationPanel t={t} p={p} op={op} key={key} action={&action} manage={manage} />
                }
            </div>
            <section class={Panel} aria-labelledby="pd-retirement">
                <div class={Row}>
                    <h3 id="pd-retirement" class={PanelTitle}>{t.recovery_strict_retirement_title()}</h3>
                    <Pill text={t.recovery_strict_retirement_badge()} tone="danger" />
                </div>
                <p class={Muted}>{t.recovery_strict_retirement_description()}</p>
                <Pairs items={&rule} />
            </section>
            if r.recent_audit_events.is_empty() {
                <Empty title={t.recovery_audit_empty_title()} description={t.recovery_audit_empty_description()} />
            } else {
                <section class={Panel} aria-labelledby="pd-audit-events">
                    <h3 id="pd-audit-events" class={PanelTitle}>{t.recovery_audit_title()}</h3>
                    <ul class={List}>
                        for event in &r.recent_audit_events {
                            <li class={Words}>{format!("{}: {}", event.event_name, event.summary)}</li>
                        }
                    </ul>
                </section>
            }
        </Module>
    }
}

/// A lifecycle operation on the selected version (`LifecycleOperationRowAction`): what it acts on,
/// its impact and blockers, and its form, whose box confirms it.
#[component(css = ProviderPage)]
fn OperationPanel<'a>(t: Cat, p: Pilot, op: &'a Operation, key: &'a str, action: &'a str, manage: bool) -> impl Render {
    let open = op.open() && manage;
    let version = op.profile_version.clone().unwrap_or_default();
    let not_selected = || p.provider_not_selected().to_owned();
    let items = [
        (p.provider_op_provider(), op.provider_key.clone().unwrap_or_else(not_selected)),
        (p.provider_op_version(), op.profile_version.clone().unwrap_or_else(not_selected)),
        (p.provider_op_lifecycle(), op.lifecycle.clone().unwrap_or_else(not_selected)),
        (p.provider_op_active(), if op.active { p.provider_yes() } else { p.provider_no() }.to_owned()),
    ];
    let confirm = if op.operation == "retire" {
        t.recovery_confirmation_retire().to_owned()
    } else {
        t.recovery_confirmation_default(&op.label.to_lowercase()).to_string()
    };
    let value = LifecycleInput::confirmation_for(&op.command_key, key, &version);
    let f = LifecycleInput::FIELDS;
    let status = state_label(&op.state);
    let id = format!("pd-op-{}", op.operation);
    let impact = &op.impact;
    html! {
        <section class={Panel} aria-labelledby={&id} data-catalog-lifecycle-command={&op.operation}>
            <div class={Row}>
                <h3 id={&id} class={PanelTitle}>{&op.label}</h3>
                <Pill text={&status} tone={action_tone(&op.state)} />
            </div>
            <p class={Muted}>{&op.description}</p>
            <Pairs items={&items} />
            <dl class={Metrics}>
                <Metric
                    label={t.recovery_operation_metric_referenced_observations()}
                    value={impact.referenced_observation_count.to_string()}
                    trend={p.provider_samples(impact.sample_observation_ids.len()).to_string()}
                />
                <Metric
                    label={t.recovery_operation_metric_catalog_items()}
                    value={impact.impacted_catalog_item_count.to_string()}
                    trend={p.provider_external_refs(impact.external_reference_count).to_string()}
                />
            </dl>
            if op.blockers.is_empty() {
                <span><Pill text={t.recovery_blockers_none()} tone="success" /></span>
            } else {
                <Blockers t={t} blockers={&op.blockers} />
            }
            <form method="post" action={action} class={Form} data-patch data-catalog-primary-workbench-command={&op.command_key}>
                <input type="hidden" name={f.operation} value={&op.operation}>
                <input type="hidden" name={f.profile_version} value={&version}>
                <Checkbox label={&confirm}>
                    <input type="checkbox" name={f.confirmation} value={&value} required={open} disabled={!open}>
                </Checkbox>
                <div>
                    <button
                        type="submit"
                        class={Button {
                            variant: if op.operation == "retire" { ButtonVariant::Destructive } else { ButtonVariant::Primary },
                            size: ButtonSize::Md,
                        }}
                        disabled={!open}
                    >
                        {&op.label}
                    </button>
                </div>
            </form>
        </section>
    }
}

/// The units the provider takes part in (`ProviderParticipatingUnits`), the selected one first.
#[component(css = ProviderPage)]
fn Units<'a>(t: Cat, model: &'a Model, key: &'a str) -> impl Render {
    let units =
        model.provider_scope.providers.iter().find(|p| p.provider_key == key).map(|p| p.units.as_slice()).unwrap_or_default();
    let selected = model.route_context.unit_key.as_deref();
    let mut ordered: Vec<_> = units.iter().collect();
    ordered.sort_by_key(|u| Some(u.unit_key.as_str()) != selected);
    let missing = selected.is_some_and(|s| !units.iter().any(|u| u.unit_key == s));
    let none = t.wb_none();
    let triage = &model.health_triage;
    let freshness = format!("{} \u{b7} {}", state_label(&triage.freshness), maybe_when(t, triage.generated_at.as_deref()));
    html! {
        <Module
            id="pd-units"
            title={t.pd_units_title()}
            description={t.pd_units_description()}
            status={units.len().to_string()}
            tone="neutral"
        >
            if units.is_empty() {
                <Empty title={t.pd_units_empty_title()} description={t.pd_units_empty_description()} />
            } else {
                <div class={Stack}>
                    for unit in &ordered {
                        let health = triage.units.iter().find(|h| h.unit_key == unit.unit_key);
                        let items = [
                            (unit.unit_key.as_str(), format!("{}/{}", unit.product_domain, unit.product_form)),
                            (
                                t.pd_units_scopes(),
                                if unit.import_scopes.is_empty() { none.to_owned() } else { unit.import_scopes.join(", ") },
                            ),
                            (
                                t.pd_units_active_profile(),
                                unit.active_profile.as_ref().map_or_else(|| t.wb_not_selected().to_owned(), |a| a.profile_version.clone()),
                            ),
                            (
                                t.wb_health_table_catalog_semantic(),
                                health.map_or_else(|| none.to_owned(), |h| state_label(&h.semantic_readiness)),
                            ),
                            (
                                t.wb_health_table_provider_transport(),
                                health.map_or_else(|| none.to_owned(), |h| state_label(&h.transport_readiness)),
                            ),
                            (t.wb_health_table_freshness(), freshness.clone()),
                            (
                                t.wb_health_table_diagnostics(),
                                health.and_then(|h| h.latest_diagnostic_text.clone()).unwrap_or_else(|| none.to_owned()),
                            ),
                        ];
                        <div
                            class={(Panel, if Some(unit.unit_key.as_str()) == selected { Some(Chosen) } else { None })}
                            data-provider-unit-selected={(Some(unit.unit_key.as_str()) == selected).then_some("true")}
                        >
                            <Pairs items={&items} />
                        </div>
                    }
                </div>
            }
            if missing {
                <p class={Muted}>{t.attention_resolution_unavailable()}</p>
            }
        </Module>
    }
}

/// The provider's recent jobs (`ProviderRecentJobs`): on TCGplayer, or with a job asked for, each
/// row opens on its outcome and the retry, resume and cancel the API offers; elsewhere a row is its
/// summary.
#[component(css = ProviderPage)]
fn Jobs<'a>(t: Cat, p: Pilot, req: &'a Req, model: &'a Model, key: &'a str, context: &'a str, manage: bool) -> impl Render {
    let jobs: Vec<&ImportJob> = model.import_jobs.jobs.iter().filter(|j| j.provider_key == key).collect();
    let selected = model.route_context.job_id.as_deref();
    let inspectable = key == "tcgplayer" || selected.is_some_and(|s| jobs.iter().any(|j| j.job_id == s));
    let last = jobs.first().map_or_else(|| t.wb_not_selected().to_owned(), |j| when(t, &j.created_at));
    let missing = selected.is_some_and(|s| !jobs.iter().any(|j| j.job_id == s));
    let _ = req;
    html! {
        <Module id="pd-jobs" title={t.pd_jobs_title()} description={t.pd_jobs_description()} status={last} tone="neutral">
            if jobs.is_empty() {
                <Empty title={t.pd_jobs_empty_title()} description={t.pd_jobs_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table data-catalog-provider-recent-jobs="true">
                        <caption class={Hidden}>{t.pd_jobs_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_job()}</th>
                                <th scope="col">{t.wb_health_table_status()}</th>
                                <th scope="col">{t.pd_jobs_scope()}</th>
                                <th scope="col">{t.wb_health_table_generated()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for job in &jobs {
                                let status = state_label(&job.operator_status);
                                let scope = job.import_scope.clone().unwrap_or_else(|| t.wb_not_selected().to_owned());
                                let created = when(t, &job.created_at);
                                let chosen = Some(job.job_id.as_str()) == selected;
                                <tr data-provider-job-selected={chosen.then_some("true")}>
                                    <td>
                                        <CellLabel>{t.wb_health_table_job()}</CellLabel>
                                        if inspectable {
                                            <details
                                                class={(Accordion {}, JobBox)}
                                                open={chosen}
                                                data-catalog-provider-job-disclosure={&job.job_id}
                                            >
                                                <summary>
                                                    <Cell
                                                        title={&job.job_id}
                                                        description={Some(job.summary.as_str())}
                                                        detail={None}
                                                    />
                                                </summary>
                                                <div class={Stack}>
                                                    <Outcome t={t} job={job} />
                                                    if manage && (job.retry_available || job.resume_available || job.cancel_available) {
                                                        <JobActions t={t} p={p} job={job} key={key} context={context} />
                                                    }
                                                </div>
                                            </details>
                                        } else {
                                            <Cell title={&job.job_id} description={Some(job.summary.as_str())} detail={None} />
                                        }
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_status()}</CellLabel>
                                        <Pill text={&status} tone={job_tone(&job.state)} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.pd_jobs_scope()}</CellLabel>
                                        <span class={Words}>{scope}</span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_generated()}</CellLabel>
                                        {created}
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if missing {
                <p class={Muted}>{t.attention_resolution_unavailable()}</p>
            }
        </Module>
    }
}

/// A job's retained outcome (`ProviderJobOutcome`): progress, failure groups, counts and usage.
/// Evidence the job did not keep reads Unavailable, never zero.
#[component(css = ProviderPage)]
fn Outcome<'a>(t: Cat, job: &'a ImportJob) -> impl Render {
    let unavailable = t.wb_jobs_usage_unavailable();
    let n = |v: Option<u64>| v.map_or_else(|| unavailable.to_owned(), |v| v.to_string());
    let result = job.result.as_ref();
    let usage = result.and_then(|r| r.usage.as_ref());
    let mut usage_lines = Vec::new();
    match usage {
        None => usage_lines.push(unavailable.to_owned()),
        Some(u) => {
            usage_lines.push(t.wb_jobs_usage_requests(&n(u.actual_request_count)).to_string());
            usage_lines.push(t.wb_jobs_usage_pages(&n(u.page_count)).to_string());
            if let (Some(hits), Some(misses)) = (u.cache_hit_count, u.cache_miss_count) {
                usage_lines.push(t.wb_jobs_usage_cache(crate::text::cat::WbJobsUsageCache { hits, misses }).to_string());
            }
        }
    }
    let progress = [
        t.wb_jobs_operator_status(&state_label(&job.operator_status)).to_string(),
        t.wb_jobs_progress_value(crate::text::cat::WbJobsProgressValue {
            completed: job.completed,
            total: job.total,
            percent: job.progress_percent,
        })
        .to_string(),
    ];
    let counts = [
        (t.wb_import_operations_observed(), result.map_or_else(|| unavailable.to_owned(), |r| n(r.observed_count))),
        (t.wb_count_skipped(), result.map_or_else(|| unavailable.to_owned(), |r| n(r.skipped_count))),
        (t.wb_count_failed(), result.map_or_else(|| unavailable.to_owned(), |r| n(r.failed_count))),
    ];
    html! {
        <dl class={JobPairs}>
            <div class={JobPair}>
                <dt>{t.wb_jobs_table_progress()}</dt>
                <dd class={CellBlock}>
                    for line in &progress {
                        <small>{line}</small>
                    }
                </dd>
            </div>
            <div class={JobPair}>
                <dt>{t.wb_jobs_table_failures()}</dt>
                <dd>
                    if job.failure_groups.is_empty() {
                        <Pill text={t.wb_none()} tone="neutral" />
                    } else {
                        <span class={Badges}>
                            for group in &job.failure_groups {
                                let label = t.wb_jobs_failure_group(crate::text::cat::WbJobsFailureGroup { label: &failure_label(t, &group.key, &group.label), count: group.count }).to_string();
                                <Pill text={&label} tone={if group.severity == "error" { "danger" } else { "warning" }} />
                            }
                        </span>
                    }
                </dd>
            </div>
            for (label, value) in &counts {
                <div class={JobPair}>
                    <dt>{*label}</dt>
                    <dd>{value}</dd>
                </div>
            }
            <div class={JobPair}>
                <dt>{t.wb_jobs_table_usage()}</dt>
                <dd class={CellBlock}>
                    for line in &usage_lines {
                        <small>{line}</small>
                    }
                </dd>
            </div>
        </dl>
    }
}

/// A job's retry, resume and cancel, as the API offers them.
#[component(css = ProviderPage)]
fn JobActions<'a>(t: Cat, p: Pilot, job: &'a ImportJob, key: &'a str, context: &'a str) -> impl Render {
    let action = at(&provider::url::Job { key, id: &job.job_id }.href().to_string(), context);
    let name = JobInput::FIELDS.command;
    let label = p.provider_job_details(&job.job_id).to_string();
    html! {
        <form
            method="post"
            action={&action}
            class={Row}
            data-patch
            data-catalog-primary-workbench-command="job"
            aria-label={&label}
        >
            if job.retry_available {
                <button
                    type="submit"
                    class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Sm }}
                    name={name}
                    value="retry"
                >
                    {t.wb_jobs_retry()}
                </button>
            }
            if job.resume_available {
                <button
                    type="submit"
                    class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Sm }}
                    name={name}
                    value="resume"
                >
                    {t.wb_jobs_resume()}
                </button>
            }
            if job.cancel_available {
                <button
                    type="submit"
                    class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Sm }}
                    name={name}
                    value="cancel"
                >
                    {t.wb_jobs_cancel()}
                </button>
            }
        </form>
    }
}
