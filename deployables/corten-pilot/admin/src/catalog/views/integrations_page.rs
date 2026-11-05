//! The integrations workbench's surfaces (admin-web's `CatalogWorkbenchShell` around a surface's
//! workspaces): the header with the way back to the import workbench, the shell's four metrics, then
//! Integration health's audit timeline and health triage, or Settings' governance controls with the
//! audit evidence to open beside them (admin-web's drawer, a disclosure here, so it opens without a
//! script). Each table stacks on a phone, a row a block of labelled lines.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use platform::ui::{
    accordion::Accordion,
    alert::{Alert, AlertEmphasis, AlertVariant},
    badge::{Badge, BadgeEmphasis, BadgeTone},
    button::{Button, ButtonSize, ButtonVariant},
    card::{Card, CardContent, CardHeader},
    table::{CellLabel, Table, TableLayout},
};

use crate::{
    catalog::integrations::{
        AuditEvidence, EvidenceLink, Governance, HealthProvider, HealthTriage, ReadModel, Surface, UsageBudget,
    },
    text::{Cat, Pilot},
    views::link_to,
};

pub(super) fn when(t: Cat, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |w| t.date_time(w, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A time, or "not selected" without one (`formatWorkspaceDateTime`).
pub(super) fn maybe_when(t: Cat, at: Option<&str>) -> String {
    match at.filter(|at| !at.is_empty()) {
        Some(at) => when(t, at),
        None => t.wb_not_selected().to_owned(),
    }
}

/// admin-web's `stateLabel` on the governance page: words, the first capitalized.
pub(super) fn state_label(value: &str) -> String {
    let words = value.split('-').collect::<Vec<_>>().join(" ");
    let mut chars = words.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// The audit pages' `stateLabel`: words, as they are.
fn words(value: &str) -> String {
    value.replace('-', " ")
}

/// A badge in one of the design system's tones: the kit's soft badge (admin-web's accent is the
/// info tone), or an outlined one for neutral.
#[component]
pub(super) fn Pill<'a>(text: &'a str, tone: &'static str) -> impl Render {
    let (tone, emphasis) = match tone {
        "success" => (BadgeTone::Success, BadgeEmphasis::Soft),
        "warning" => (BadgeTone::Warning, BadgeEmphasis::Soft),
        "danger" => (BadgeTone::Destructive, BadgeEmphasis::Soft),
        "info" | "accent" => (BadgeTone::Info, BadgeEmphasis::Soft),
        _ => (BadgeTone::Neutral, BadgeEmphasis::Outline),
    };
    html! { <span class={Badge { tone, emphasis }}>{text}</span> }
}

/// A banner in a tone (`OperationalStatusBanner`).
#[component(css = IntegrationsPage)]
pub(super) fn Banner<'a>(tone: &'static str, title: &'a str, description: &'a str) -> impl Render {
    let variant = match tone {
        "success" => AlertVariant::Success,
        "danger" => AlertVariant::Destructive,
        "warning" => AlertVariant::Warning,
        _ => AlertVariant::Info,
    };
    html! {
        <Alert variant={variant} emphasis={AlertEmphasis::Outline}>
            <strong>{title}</strong>
            if !description.is_empty() {
                <p>{description}</p>
            }
        </Alert>
    }
}

/// A metric (`MetricStrip`'s item).
#[component(css = IntegrationsPage)]
pub(super) fn Metric<'a>(label: &'a str, value: String, trend: String) -> impl Render {
    html! {
        <div class={Metric}>
            <dt>{label}</dt>
            <dd class={Value}>{value}</dd>
            <dd class={Trend}>{trend}</dd>
        </div>
    }
}

/// Labelled values (`KeyValueList`).
#[component(css = IntegrationsPage)]
pub(super) fn Pairs<'a>(items: &'a [(&'a str, String)]) -> impl Render {
    html! {
        <dl class={Pairs}>
            for (key, value) in items {
                <div class={Pair}>
                    <dt>{*key}</dt>
                    <dd>{value}</dd>
                </div>
            }
        </dl>
    }
}

/// An empty table's words (`DataTable`'s empty state).
#[component(css = IntegrationsPage)]
pub(super) fn Empty<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Nothing}>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// A part of a workspace (`WorkflowModule`): its heading, description and status, then its content.
#[component(css = IntegrationsPage)]
pub(super) fn Module<'a, C: Render>(
    id: &'a str,
    title: &'a str,
    description: &'a str,
    status: String,
    tone: &'static str,
    children: C,
) -> impl Render {
    html! {
        <section class={Card {}} aria-labelledby={id}>
            <header class={(CardHeader {}, ModuleHead)}>
                <div>
                    <h2 id={id}>{title}</h2>
                    <p>{description}</p>
                </div>
                <div class={Status}><Pill text={status} tone={tone} /></div>
            </header>
            <div class={(CardContent {}, Stack)}>{children}</div>
        </section>
    }
}

/// A cell's title, description and detail (`WorkbenchDataCell`).
#[component(css = IntegrationsPage)]
pub(super) fn Cell<'a>(title: &'a str, description: Option<&'a str>, detail: Option<&'a str>) -> impl Render {
    html! {
        <span class={CellText}>
            <span class={(Strong, Words)}>{title}</span>
            if let Some(text) = description.filter(|d| !d.is_empty()) {
                <span class={(Muted, Words)}>{text}</span>
            }
            if let Some(text) = detail.filter(|d| !d.is_empty()) {
                <span class={(Muted, Words)}>{text}</span>
            }
        </span>
    }
}

/// A link the read model carries: the pilot's page for one it serves, else admin-web's. An absolute
/// one is an alert or runbook the API already held to its approved observability hosts, so it goes
/// out as the API wrote it.
#[component(css = IntegrationsPage)]
pub(super) fn Evidence<'a>(req: &'a Req, href: &'a str, label: &'a str) -> impl Render {
    let to = if href.starts_with("https://") { Some(href.to_owned()) } else { link_to(req, href) };
    html! {
        match to {
            Some(to) => { <a class={Words} href={to}>{label}</a> }
            None => { <span class={Words}>{label}</span> }
        }
    }
}

fn health_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "blocked" | "unavailable" => "danger",
        _ => "warning",
    }
}

fn health_label(t: Cat, status: &str) -> String {
    match status {
        "ready" => t.wb_health_status_ready(),
        "degraded" => t.wb_health_status_degraded(),
        "blocked" => t.wb_health_status_blocked(),
        "unavailable" => t.wb_health_status_unavailable(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn readiness_tone(status: &str) -> &'static str {
    match status {
        "ready" | "completed" | "not-required" | "configured" => "success",
        "blocked" | "missing" | "invalid" | "expired" => "danger",
        "degraded" | "unknown" => "warning",
        _ => "neutral",
    }
}

pub(super) fn freshness_tone(status: &str) -> &'static str {
    match status {
        "fresh" => "success",
        "unavailable" => "danger",
        "partial" | "stale" | "lagging" => "warning",
        _ => "neutral",
    }
}

fn primary_action(t: Cat, action: &str) -> String {
    match action {
        "pull-provider-data" => t.wb_health_primary_action_pull_provider_data(),
        "review-source-observations" => t.wb_health_primary_action_review_source_observations(),
        "observation.promote" => t.wb_health_primary_action_preview_promotion(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A count, as `String(n)` writes it.
fn number(value: f64) -> String {
    value.to_string()
}

fn credits(t: Cat, budget: &UsageBudget) -> String {
    let unit = budget.credit_unit.as_deref().unwrap_or("");
    match (budget.credit_balance, budget.credit_allowance) {
        (None, _) => t.wb_health_usage_not_reported().to_owned(),
        (Some(balance), None) => t.wb_health_usage_credits_balance(number(balance), unit).to_string(),
        (Some(balance), Some(allowance)) => {
            t.wb_health_usage_credits_allowance(number(balance), number(allowance), unit).to_string()
        }
    }
}

fn usage_freshness(t: Cat, budget: &UsageBudget) -> String {
    let observed = budget.observed_at.as_deref().map(|at| when(t, at));
    let at = observed.clone().unwrap_or_default();
    match budget.freshness.as_str() {
        "fresh" => t.wb_health_usage_freshness_fresh(&at).to_string(),
        "stale" => t.wb_health_usage_freshness_stale(&at).to_string(),
        "unavailable" => match observed {
            Some(at) => t.wb_health_usage_freshness_unavailable_observed(&at).to_string(),
            None => t.wb_health_usage_freshness_unavailable().to_owned(),
        },
        "never-observed" => t.wb_health_usage_freshness_never_observed().to_owned(),
        other => other.to_owned(),
    }
}

fn usage_lag(t: Cat, lag: &str) -> String {
    match lag {
        "within-provider-window" => t.wb_health_usage_lag_within(),
        "beyond-provider-window" => t.wb_health_usage_lag_beyond(),
        "documented-window" => t.wb_health_usage_lag_documented(),
        "unobserved" => t.wb_health_usage_lag_unobserved(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A provider's capabilities (`usageBudgetItems` and the rest of admin-web's list).
fn capabilities(t: Cat, row: &HealthProvider) -> Vec<(&'static str, String)> {
    let mut items = vec![
        (t.wb_health_capability_api(), row.api_reachability.clone()),
        (t.wb_health_capability_options(), row.option_query_health.clone()),
        (t.wb_health_capability_rate_limit(), row.rate_limit_status.clone()),
        (t.wb_health_capability_payload(), row.payload_acquisition.clone()),
    ];
    match &row.usage_budget {
        None => items.push((t.wb_health_capability_credits(), t.wb_health_usage_unsupported().to_owned())),
        Some(budget) => {
            items.push((t.wb_health_capability_credits(), credits(t, budget)));
            items.push((t.wb_health_capability_budget_readiness(), budget.readiness.clone()));
            items.push((t.wb_health_capability_usage_freshness(), usage_freshness(t, budget)));
            items.push((t.wb_health_capability_usage_lag(), usage_lag(t, &budget.lag_category)));
            // A complete, fresh, ready budget stays quiet; any other budget shows its reason.
            if (budget.freshness != "fresh" || budget.readiness != "ready")
                && let Some(diagnostic) = &budget.diagnostic
            {
                items.push((t.wb_health_capability_usage_diagnostic(), diagnostic.clone()));
            }
            let calls = match budget.estimated_calls {
                None => t.wb_not_selected().to_owned(),
                Some(calls) => std::iter::once(number(calls))
                    .chain(budget.estimated_scope.clone().filter(|s| !s.is_empty()))
                    .collect::<Vec<_>>()
                    .join(" / "),
            };
            items.push((t.wb_health_capability_estimated_calls(), calls));
        }
    }
    let unobserved = t.ssb_count_unobserved();
    let spend = match row.count_spend.as_deref() {
        Some(spends) if !spends.is_empty() => spends
            .iter()
            .map(|s| {
                let observed = s.observed_at.as_deref().unwrap_or(unobserved);
                let expires = s.expires_at.as_deref().unwrap_or("-");
                format!("{}: {} / {} / {observed} / {expires}", s.kind, s.credits, s.outcome)
            })
            .collect::<Vec<_>>()
            .join("; "),
        _ => unobserved.to_owned(),
    };
    items.push((t.ssb_count_spend(), spend));
    items
}

/// Integration health triage (`CatalogIntegrationHealthTriageWorkspace`).
#[component(css = IntegrationsPage)]
fn HealthWorkspace<'a>(t: Cat, health: &'a HealthTriage) -> impl Render {
    let s = &health.summary;
    let none = t.wb_health_diagnostics_none();
    let active: Vec<_> = health.rollout_controls.iter().filter(|c| c.status != "open").collect();
    let audit_tone = if health.audit_preview.projection_status == "partial" { "warning" } else { "danger" };
    let audit_status = t.wb_health_audit_status(&health.audit_preview.projection_status).to_string();
    let status = health_label(t, &health.status);
    html! {
        <Module
            id="wb-health"
            title={t.wb_health_title()}
            description={t.wb_health_description()}
            status={status.to_string()}
            tone={health_tone(&health.status)}
        >
            <dl class={Metrics}>
                <Metric
                    label={t.wb_health_metric_ready_units()}
                    value={format!("{}/{}", s.ready_units, s.total_units)}
                    trend={t.wb_health_metric_ready_units_trend().to_owned()}
                />
                <Metric
                    label={t.wb_health_metric_blocked_units()}
                    value={s.blocked_units.to_string()}
                    trend={t.wb_health_metric_blocked_units_trend().to_owned()}
                />
                <Metric
                    label={t.wb_health_metric_degraded_providers()}
                    value={s.degraded_providers.to_string()}
                    trend={t.wb_health_metric_degraded_providers_trend().to_owned()}
                />
                <Metric
                    label={t.wb_health_metric_active_jobs()}
                    value={s.active_jobs.to_string()}
                    trend={t.wb_health_metric_active_jobs_trend().to_owned()}
                />
                <Metric
                    label={t.wb_health_metric_rollout_stops()}
                    value={s.rollout_stops.to_string()}
                    trend={t.wb_health_metric_rollout_stops_trend().to_owned()}
                />
                <Metric
                    label={t.wb_health_metric_audit_entries()}
                    value={s.audit_entries.to_string()}
                    trend={t.wb_health_metric_audit_entries_trend().to_owned()}
                />
            </dl>
            if health.status == "unavailable" {
                <Banner
                    tone="danger"
                    title={t.wb_health_unavailable_title()}
                    description={t.wb_health_unavailable_description()}
                />
            }
            if health.read_models.is_empty() {
                <Empty title={t.wb_health_read_models_empty()} description={t.wb_health_read_models_empty_detail()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_health_table_query()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_query()}</th>
                                <th scope="col">{t.wb_health_table_freshness()}</th>
                                <th scope="col">{t.wb_health_table_owner_metric()}</th>
                                <th scope="col">{t.wb_health_table_generated()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &health.read_models {
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_health_table_query()}</CellLabel>
                                        <Cell
                                            title={&row.query_key}
                                            description={Some(row.status_message.as_str())}
                                            detail={None}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_freshness()}</CellLabel>
                                        <Pill text={&row.freshness} tone={freshness_tone(&row.freshness)} />
                                    </td>
                                    <td class={Words}>
                                        <CellLabel>{t.wb_health_table_owner_metric()}</CellLabel>
                                        {&row.owner_metric_key}
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_generated()}</CellLabel>
                                        {maybe_when(t, row.generated_at.as_deref())}
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if health.units.is_empty() {
                <Empty title={t.wb_health_units_empty()} description={t.wb_health_units_empty_detail()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_health_table_unit()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_unit()}</th>
                                <th scope="col">{t.wb_health_table_catalog_semantic()}</th>
                                <th scope="col">{t.wb_health_table_provider_transport()}</th>
                                <th scope="col">{t.wb_health_table_next_action()}</th>
                                <th scope="col">{t.wb_health_table_diagnostics()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &health.units {
                                let scope = format!("{} / {}/{}", row.provider_key, row.product_domain, row.product_form);
                                let counts = t.wb_health_diagnostic_counts(row.diagnostic_counts.error, row.diagnostic_counts.warning, row.diagnostic_counts.info).to_string();
                                let facts = t.wb_health_observation_facts(row.observation_facts).to_string();
                                let dry_tone = if row.dry_run_status == "completed" { "success" } else { "danger" };
                                let unit_status = health_label(t, &row.status);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_health_table_unit()}</CellLabel>
                                        <Cell
                                            title={&row.display_name}
                                            description={Some(row.unit_key.as_str())}
                                            detail={Some(scope.as_str())}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_catalog_semantic()}</CellLabel>
                                        <span class={Badges}>
                                            <Pill text={&row.semantic_readiness} tone={readiness_tone(&row.semantic_readiness)} />
                                            <Pill
                                                text={&row.fixture_validation_status}
                                                tone={readiness_tone(&row.fixture_validation_status)}
                                            />
                                            <Pill text={&row.dry_run_status} tone={dry_tone} />
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_provider_transport()}</CellLabel>
                                        <span class={CellText}>
                                            <span class={Badges}>
                                                <Pill
                                                    text={&row.transport_readiness}
                                                    tone={readiness_tone(&row.transport_readiness)}
                                                />
                                                <Pill
                                                    text={&row.credential_readiness_state}
                                                    tone={readiness_tone(&row.credential_readiness)}
                                                />
                                            </span>
                                            <span class={Muted}>{facts}</span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_next_action()}</CellLabel>
                                        <span class={CellText}>
                                            <Pill text={&unit_status} tone={health_tone(&row.status)} />
                                            <span class={Words}>{primary_action(t, &row.affected_primary_action)}</span>
                                            <span class={(Muted, Words)}>{&row.owner_metric_key}</span>
                                            <span class={(Muted, Words)}>{&row.next_action}</span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_diagnostics()}</CellLabel>
                                        <Cell
                                            title={&counts}
                                            description={None}
                                            detail={Some(row.latest_diagnostic_text.as_deref().unwrap_or(none))}
                                        />
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if health.providers.is_empty() {
                <Empty title={t.wb_health_providers_empty()} description={t.wb_health_providers_empty_detail()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_health_table_provider()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_provider()}</th>
                                <th scope="col">{t.wb_health_table_status()}</th>
                                <th scope="col">{t.wb_health_table_capabilities()}</th>
                                <th scope="col">{t.wb_health_table_next_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &health.providers {
                                let affected = t.wb_health_affected_units(row.unit_keys.len()).to_string();
                                let provider_status = health_label(t, &row.status);
                                let items = capabilities(t, row);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_health_table_provider()}</CellLabel>
                                        <Cell
                                            title={&row.provider_key}
                                            description={Some(row.adapter_key.as_str())}
                                            detail={Some(affected.as_str())}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_status()}</CellLabel>
                                        <span class={Badges}>
                                            <Pill text={&provider_status} tone={health_tone(&row.status)} />
                                            <Pill
                                                text={&row.credential_readiness_state}
                                                tone={readiness_tone(&row.credential_readiness)}
                                            />
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_capabilities()}</CellLabel>
                                        <Pairs items={&items} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_next_action()}</CellLabel>
                                        <Cell
                                            title={&row.next_action}
                                            description={Some(row.owner_metric_key.as_str())}
                                            detail={Some(row.latest_diagnostic_text.as_deref().unwrap_or(none))}
                                        />
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if active.is_empty() {
                <Banner
                    tone="success"
                    title={t.wb_health_rollout_clear_title()}
                    description={t.wb_health_rollout_clear_description()}
                />
            } else {
                for control in &active {
                    let owner = t.wb_health_rollout_owner_metric(&control.metric_key).to_string();
                    let description = t.wb_health_rollout_description(&control.message, &owner, &control.next_action).to_string();
                    <Banner
                        tone={if control.status == "blocked" { "danger" } else { "warning" }}
                        title={&control.control_id}
                        description={&description}
                    />
                }
            }
            if health.recent_jobs.is_empty() {
                <Empty title={t.wb_health_jobs_empty()} description={t.wb_health_jobs_empty_detail()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_health_table_job()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_job()}</th>
                                <th scope="col">{t.wb_health_table_progress()}</th>
                                <th scope="col">{t.wb_health_table_next_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &health.recent_jobs {
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_health_table_job()}</CellLabel>
                                        <Cell title={&row.job_id} description={Some(row.summary.as_str())} detail={None} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_progress()}</CellLabel>
                                        <span class={CellText}>
                                            <Pill
                                                text={&row.operator_status}
                                                tone={if row.phase == "failed" { "danger" } else { "warning" }}
                                            />
                                            <span class={Muted}>{&row.progress_label}</span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_next_action()}</CellLabel>
                                        <Cell
                                            title={&row.next_action}
                                            description={Some(row.owner_metric_key.as_str())}
                                            detail={None}
                                        />
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
            <Banner tone={audit_tone} title={&audit_status} description={&health.audit_preview.status_message} />
            if health.audit_preview.entries.is_empty() {
                <Empty title={t.wb_health_audit_empty()} description={t.wb_health_audit_empty_detail()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_health_table_audit_event()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_health_table_audit_event()}</th>
                                <th scope="col">{t.wb_health_table_audit_category()}</th>
                                <th scope="col">{t.wb_health_table_scope()}</th>
                                <th scope="col">{t.wb_health_table_occurred()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &health.audit_preview.entries {
                                let scope = format!("{} / {}", row.provider_key, row.unit_key.as_deref().unwrap_or(t.wb_not_selected()));
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_health_table_audit_event()}</CellLabel>
                                        <Cell title={&row.event_name} description={Some(row.summary.as_str())} detail={None} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_audit_category()}</CellLabel>
                                        <Pill text={&row.category} tone="neutral" />
                                    </td>
                                    <td class={Words}>
                                        <CellLabel>{t.wb_health_table_scope()}</CellLabel>
                                        {scope}
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_health_table_occurred()}</CellLabel>
                                        {maybe_when(t, Some(row.occurred_at.as_str()))}
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

fn audit_tone(status: &str) -> &'static str {
    match status {
        "ready" | "not-needed" => "success",
        "partial" | "degraded" | "missing" | "redacted" => "warning",
        "blocked" | "unavailable" | "excluded" => "danger",
        _ => "neutral",
    }
}

fn category_tone(category: &str) -> &'static str {
    match category {
        "promotion" | "source-observation" | "import-job" => "accent",
        "diagnostic" => "warning",
        _ => "neutral",
    }
}

fn link_tone(kind: &str) -> &'static str {
    match kind {
        "proof" | "test" => "accent",
        "diagnostic" => "warning",
        _ => "neutral",
    }
}

fn redaction_tone(state: &str) -> &'static str {
    match state {
        "not-needed" => "success",
        "excluded" => "danger",
        _ => "warning",
    }
}

/// The audit timeline (`CatalogIntegrationAuditEvidenceWorkspace`), on Integration health and in
/// Settings' evidence.
#[component(css = IntegrationsPage)]
fn AuditWorkspace<'a>(t: Cat, req: &'a Req, audit: &'a AuditEvidence, id: &'static str) -> impl Render {
    let (banner_tone, title, description) = match audit.status.as_str() {
        "blocked" => ("danger", t.wb_audit_banner_blocked_title().to_owned(), t.wb_audit_banner_blocked_description().to_owned()),
        "unavailable" => {
            ("warning", t.wb_audit_banner_unavailable_title().to_owned(), audit.projection_state.status_message.clone())
        }
        "partial" => (
            "warning",
            t.wb_audit_banner_partial_title().to_owned(),
            t.wb_audit_banner_partial_description(audit.summary.partial_projection_count).to_string(),
        ),
        _ => ("success", t.wb_audit_banner_ready_title().to_owned(), audit.redaction_policy.summary.clone()),
    };
    let none = t.wb_none();
    let policy = &audit.redaction_policy;
    let facts = [
        (t.wb_audit_key_projection(), audit.projection_state.status_message.clone()),
        (t.wb_audit_key_generated_at(), audit.projection_state.generated_at.clone().unwrap_or_else(|| none.to_owned())),
        (t.wb_audit_key_source_payload(), policy.source_payload_access.clone()),
        (t.wb_audit_key_profile_snapshot(), policy.profile_snapshot_access.clone()),
        (t.wb_audit_key_forbidden_requests(), policy.forbidden_evidence_requests.join(", ")),
    ];
    let active = audit.filters.iter().filter(|f| f.active).count().to_string();
    let status = words(&audit.status);
    let timeline_count = audit.timeline.len().to_string();
    let links_count = audit.evidence_links.len().to_string();
    let ids = [format!("{id}-audit"), format!("{id}-filters"), format!("{id}-timeline"), format!("{id}-links")];
    html! {
        <Module
            id={&ids[0]}
            title={t.wb_audit_title()}
            description={t.wb_audit_description()}
            status={status.to_string()}
            tone={audit_tone(&audit.status)}
        >
            <Banner tone={banner_tone} title={&title} description={&description} />
            <dl class={Metrics}>
                <Metric
                    label={t.wb_audit_metric_timeline()}
                    value={audit.summary.timeline_events.to_string()}
                    trend={audit.freshness.clone()}
                />
                <Metric
                    label={t.wb_audit_metric_links()}
                    value={audit.summary.redacted_evidence_links.to_string()}
                    trend={t.wb_audit_metric_links_trend().to_owned()}
                />
                <Metric
                    label={t.wb_audit_metric_projection()}
                    value={audit.summary.partial_projection_count.to_string()}
                    trend={audit.projection_state.query_key.clone()}
                />
            </dl>
            <Pairs items={&facts} />
        </Module>
        <Module
            id={&ids[1]}
            title={t.wb_audit_filters_title()}
            description={t.wb_audit_filters_description()}
            status={active.to_string()}
            tone="neutral"
        >
            if audit.filters.is_empty() {
                <Empty title={t.wb_audit_filters_empty_title()} description={t.wb_audit_filters_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_audit_filters_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_audit_table_filter()}</th>
                                <th scope="col">{t.wb_audit_table_value()}</th>
                                <th scope="col">{t.wb_audit_table_options()}</th>
                                <th scope="col">{t.wb_audit_table_state()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for filter in &audit.filters {
                                let options = if filter.options.is_empty() { none.to_owned() } else { filter.options.iter().take(4).cloned().collect::<Vec<_>>().join(", ") };
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_filter()}</CellLabel>
                                        <Cell title={&filter.label} description={Some(filter.key.as_str())} detail={None} />
                                    </td>
                                    <td class={Words}>
                                        <CellLabel>{t.wb_audit_table_value()}</CellLabel>
                                        {filter.value.as_deref().unwrap_or(t.wb_audit_filters_not_applied())}
                                    </td>
                                    <td class={Words}>
                                        <CellLabel>{t.wb_audit_table_options()}</CellLabel>
                                        {options}
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_state()}</CellLabel>
                                        if filter.active {
                                            <Pill text={t.wb_audit_filters_active()} tone="accent" />
                                        } else {
                                            <Pill text={t.wb_audit_filters_available()} tone="neutral" />
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
        <Module
            id={&ids[2]}
            title={t.wb_audit_timeline_title()}
            description={t.wb_audit_timeline_description()}
            status={timeline_count.to_string()}
            tone={audit_tone(&audit.status)}
        >
            if audit.timeline.is_empty() {
                <Empty title={t.wb_audit_timeline_empty_title()} description={t.wb_audit_timeline_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_audit_timeline_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_audit_table_event()}</th>
                                <th scope="col">{t.wb_audit_table_target()}</th>
                                <th scope="col">{t.wb_audit_table_category()}</th>
                                <th scope="col">{t.wb_audit_table_summary()}</th>
                                <th scope="col">{t.wb_audit_table_evidence()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &audit.timeline {
                                let target = words(&row.target_type);
                                let target = state_label(&target);
                                let codes = if row.diagnostic_codes.is_empty() { none.to_owned() } else { row.diagnostic_codes.iter().take(3).cloned().collect::<Vec<_>>().join(", ") };
                                let category = state_label(&row.category);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_event()}</CellLabel>
                                        <Cell
                                            title={&row.event_name}
                                            description={Some(row.event_id.as_str())}
                                            detail={Some(row.occurred_at.as_str())}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_target()}</CellLabel>
                                        <Cell
                                            title={&row.target_id}
                                            description={Some(target.as_str())}
                                            detail={Some(row.provider_key.as_deref().unwrap_or(none))}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_category()}</CellLabel>
                                        <span class={CellText}>
                                            <Pill text={&category} tone={category_tone(&row.category)} />
                                            <span class={Muted}>{&row.actor_label}</span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_summary()}</CellLabel>
                                        <Cell title={&row.summary} description={Some(codes.as_str())} detail={None} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_audit_table_evidence()}</CellLabel>
                                        <span class={CellText}>
                                            for link in row.evidence_links.iter().take(2) {
                                                <Evidence req={req} href={&link.href} label={&link.label} />
                                            }
                                        </span>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
        <Module
            id={&ids[3]}
            title={t.wb_audit_links_title()}
            description={t.wb_audit_links_description()}
            status={links_count.to_string()}
            tone="neutral"
        >
            if audit.evidence_links.is_empty() {
                <Empty title={t.wb_audit_links_empty_title()} description={t.wb_audit_links_empty_description()} />
            } else {
                <LinksTable t={t} req={req} links={&audit.evidence_links} />
            }
        </Module>
    }
}

#[component(css = IntegrationsPage)]
fn LinksTable<'a>(t: Cat, req: &'a Req, links: &'a [EvidenceLink]) -> impl Render {
    html! {
        <Table layout={TableLayout::Stack}>
            <table>
                <caption class={Caption}>{t.wb_audit_links_title()}</caption>
                <thead>
                    <tr>
                        <th scope="col">{t.wb_audit_table_evidence()}</th>
                        <th scope="col">{t.wb_audit_table_kind()}</th>
                        <th scope="col">{t.wb_audit_table_redaction()}</th>
                        <th scope="col">{t.wb_audit_table_summary()}</th>
                    </tr>
                </thead>
                <tbody>
                    for link in links {
                        let kind = words(&link.kind);
                        let redaction = words(&link.redaction_state);
                        <tr>
                            <td>
                                <CellLabel>{t.wb_audit_table_evidence()}</CellLabel>
                                <span class={CellText}>
                                    <Evidence req={req} href={&link.href} label={&link.label} />
                                    <span class={(Muted, Words)}>{&link.key}</span>
                                </span>
                            </td>
                            <td>
                                <CellLabel>{t.wb_audit_table_kind()}</CellLabel>
                                <Pill text={&kind} tone={link_tone(&link.kind)} />
                            </td>
                            <td>
                                <CellLabel>{t.wb_audit_table_redaction()}</CellLabel>
                                <span class={CellText}>
                                    <Pill text={&redaction} tone={redaction_tone(&link.redaction_state)} />
                                    <span class={Muted}>{&link.source_payload_access}</span>
                                    <span class={Muted}>{&link.profile_snapshot_access}</span>
                                </span>
                            </td>
                            <td class={Words}>
                                <CellLabel>{t.wb_audit_table_summary()}</CellLabel>
                                {&link.summary}
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
        </Table>
    }
}

/// A blocker's label and group (`getCatalogPrimaryWorkbenchBlockerCopy`).
pub(super) fn blocker(t: Cat, category: &str) -> Option<(&'static str, &'static str)> {
    Some(match category {
        "permission-denied" => (t.wb_copy_permission_denied(), "permission"),
        "authorization-denied" => (t.wb_copy_authorization_denied(), "permission"),
        "rollout-disabled" => (t.wb_copy_rollout_stopped(), "rollout"),
        "kill-switch-active" => (t.wb_copy_kill_switch_active(), "rollout"),
        "rbac-missing" => (t.wb_copy_rbac_grant_missing(), "permission"),
        "provider-selection-required" => (t.wb_copy_provider_selection_required(), "readiness"),
        "unit-selection-required" => (t.wb_copy_unit_selection_required(), "readiness"),
        "import-scope-required" => (t.wb_copy_import_scope_required(), "readiness"),
        "active-job-conflict" => (t.wb_copy_import_already_running(), "job"),
        "concurrent-job" => (t.wb_copy_concurrent_jobs_detected(), "job"),
        "missing-active-profile" => (t.wb_copy_active_profile_missing(), "profile"),
        "profile-version-missing" => (t.wb_copy_profile_version_missing(), "profile"),
        "profile-section-read-only" => (t.wb_copy_profile_section_read_only(), "profile"),
        "profile-section-stale" => (t.wb_copy_profile_section_stale(), "profile"),
        "profile-section-invalid" => (t.wb_copy_profile_section_invalid(), "profile"),
        "profile-lifecycle-conflict" => (t.wb_copy_profile_lifecycle_conflict(), "profile"),
        "profile-retirement-references" => (t.wb_copy_profile_retirement_references(), "retirement"),
        "activation-readiness-blocked" => (t.wb_copy_activation_readiness_blocked(), "readiness"),
        "migration-evidence-missing" => (t.wb_copy_migration_evidence_missing(), "profile"),
        "reference-impact-review-required" => (t.wb_copy_reference_impact_review_required(), "promotion"),
        "missing-fixture-coverage" => (t.wb_copy_fixture_coverage_missing(), "fixture"),
        "fixture-validation-blocked" => (t.wb_copy_fixture_validation_blocked(), "fixture"),
        "provider-credential-missing" => (t.wb_copy_provider_credential_missing(), "credential"),
        "provider-credential-invalid" => (t.wb_copy_provider_credential_invalid(), "credential"),
        "provider-credential-expired" => (t.wb_copy_provider_credential_expired(), "credential"),
        "source-projection-stale" => (t.wb_copy_source_observation_projection_stale(), "resilience"),
        "read-model-degraded" => (t.wb_copy_read_model_degraded(), "resilience"),
        "read-model-partial" => (t.wb_copy_read_model_partial(), "resilience"),
        "read-model-unavailable" => (t.wb_copy_read_model_unavailable(), "resilience"),
        "job-not-found" => (t.wb_copy_job_not_found(), "job"),
        "observation-not-found" => (t.wb_copy_source_observation_not_found(), "source-observation"),
        "selection-empty" => (t.wb_copy_no_observations_selected(), "source-observation"),
        "no-promotion-eligible-observations" => (t.wb_copy_no_promotable_observations(), "source-observation"),
        "duplicate-conflict" => (t.wb_copy_duplicate_evidence_conflict(), "promotion"),
        "promotion-conflict" => (t.wb_copy_promotion_conflict(), "promotion"),
        "destructive-confirmation-required" => (t.wb_copy_confirmation_required(), "promotion"),
        "stale-promotion-preview" => (t.wb_copy_stale_promotion_preview(), "promotion"),
        "display-identity-unresolvable" => (t.wb_copy_display_identity_unresolvable(), "promotion"),
        "stale-replay" => (t.wb_copy_stale_replay_checkpoint(), "job"),
        "idempotency-replay" => (t.wb_copy_idempotency_replay_in_progress(), "job"),
        "security-privacy-blocked" => (t.wb_copy_security_or_privacy_blocker(), "security-privacy"),
        "unsupported-command" => (t.wb_copy_command_unavailable(), "resilience"),
        "deploy-skew-unsupported-version" => (t.wb_copy_unsupported_deployed_version(), "resilience"),
        "raw-json-retired" => (t.wb_copy_payload_escape_hatch_removed(), "retirement"),
        "legacy-selector-retired" => (t.wb_copy_old_selector_removed(), "retirement"),
        "provider-scopes" => (t.wb_copy_no_provider_scopes_are_ready_for_import(), "profile"),
        "import-context" => (t.wb_copy_import_context_is_incomplete(), "readiness"),
        "import-jobs" => (t.wb_copy_no_durable_import_jobs_for_this_context(), "job"),
        "source-observations" => (t.wb_copy_no_source_observations_in_this_context(), "source-observation"),
        "promotion-eligible" => (t.wb_copy_no_promotable_observations(), "promotion"),
        "audit-evidence" => (t.wb_copy_no_audit_evidence_for_this_context(), "readiness"),
        "route-load-failure" => (t.wb_copy_route_could_not_load(), "resilience"),
        "api-failure" => (t.wb_copy_catalog_api_unavailable(), "resilience"),
        "detail-panel-failure" => (t.wb_copy_evidence_panel_failed(), "resilience"),
        "telemetry-unavailable" => (t.wb_copy_telemetry_unavailable(), "resilience"),
        "provider-import-complete" => (t.wb_copy_provider_data_pulled(), "job"),
        "promotion-complete" => (t.wb_copy_catalog_promotion_complete(), "promotion"),
        "reject-complete" => (t.wb_copy_observations_rejected(), "source-observation"),
        "defer-complete" => (t.wb_copy_observations_deferred(), "source-observation"),
        "reapply-complete" => (t.wb_copy_reapply_complete(), "profile"),
        "replay-complete" => (t.wb_copy_replay_complete(), "profile"),
        _ => return None,
    })
}

/// A blocker's tone by its group (`blockerTone`).
pub(super) fn blocker_tone(group: &str) -> &'static str {
    match group {
        "permission" | "rollout" | "security-privacy" | "retirement" => "danger",
        _ => "warning",
    }
}

/// A row's blockers (`BlockerBadges`): each once, by its label, or none.
#[component(css = IntegrationsPage)]
pub(super) fn Blockers<'a>(t: Cat, blockers: &'a [String]) -> impl Render {
    let mut seen: Vec<&str> = Vec::new();
    for b in blockers {
        if !seen.contains(&b.as_str()) {
            seen.push(b);
        }
    }
    html! {
        if seen.is_empty() {
            <Pill text={t.wb_gov_blockers_none()} tone="success" />
        } else {
            <span class={Badges}>
                for b in &seen {
                    match blocker(t, b) {
                        Some((label, group)) => { <Pill text={label} tone={blocker_tone(group)} /> }
                        None => { <Pill text={b} tone="warning" /> }
                    }
                }
            </span>
        }
    }
}

fn gov_tone(status: &str) -> &'static str {
    match status {
        "ready" | "open" => "success",
        "blocked" | "unavailable" | "removed" => "danger",
        "degraded" | "stopped" | "staged" => "warning",
        _ => "neutral",
    }
}

fn control_tone(status: &str) -> &'static str {
    match status {
        "open" => "success",
        "blocked" | "removed" => "danger",
        _ => "warning",
    }
}

fn action_tone(state: &str) -> &'static str {
    match state {
        "available" => "success",
        "denied" | "blocked" | "unsafe" | "unavailable" => "danger",
        "degraded" => "warning",
        _ => "neutral",
    }
}

/// Settings (`CatalogControlPlaneSettingsPage`): governance controls, rollout and worker controls,
/// RBAC, observability and removal evidence, with the audit evidence to open beside them.
#[component(css = IntegrationsPage)]
fn GovernanceWorkspace<'a>(t: Cat, p: Pilot, req: &'a Req, governance: &'a Governance, audit: &'a AuditEvidence) -> impl Render {
    let g = governance;
    let (banner_tone, title, description) = match g.status.as_str() {
        "blocked" => ("danger", t.wb_gov_banner_blocked_title(), t.wb_gov_banner_blocked_description()),
        "ready" => ("success", t.wb_gov_banner_ready_title(), t.wb_gov_banner_ready_description()),
        _ => ("warning", t.wb_gov_banner_degraded_title(), t.wb_gov_banner_degraded_description()),
    };
    let on_off = |on: bool| if on { p.integrations_switch_on() } else { p.integrations_switch_off() }.to_owned();
    let rollout = [
        (p.integrations_rollout_mode(), g.rollout_mode.state.clone()),
        (p.integrations_worker_state(), g.rollout_mode.worker_state.clone()),
        (p.integrations_emergency_stops(), g.rollout_mode.provider_emergency_stop_count.to_string()),
        (p.integrations_import_kill_switch(), on_off(g.rollout_mode.import_kill_switch_active)),
        (p.integrations_promotion_kill_switch(), on_off(g.rollout_mode.promotion_kill_switch_active)),
        (p.integrations_reapply_kill_switch(), on_off(g.rollout_mode.reapply_kill_switch_active)),
    ];
    let removal = [
        (p.integrations_status(), g.legacy_removal_evidence.status.clone()),
        (p.integrations_removed_surfaces(), g.legacy_removal_evidence.removed_surfaces.join(", ")),
        (p.integrations_launch_blocker(), g.legacy_removal_evidence.launch_blocker_if_present.join(", ")),
    ];
    let status = state_label(&g.status);
    let stops_tone = if g.summary.active_rollout_stops > 0 { "danger" } else { "success" };
    let rbac_count = t.wb_gov_rbac_action_count(g.rbac_matrix.len()).to_string();
    let rbac_tone = if g.summary.denied_commands > 0 { "danger" } else { "success" };
    let observability = state_label(&g.observability.status);
    html! {
        <Module
            id="wb-governance"
            title={t.wb_gov_title()}
            description={t.wb_gov_description()}
            status={status.to_string()}
            tone={gov_tone(&g.status)}
        >
            <Banner tone={banner_tone} title={title} description={description} />
            <details class={(Accordion {}, Drawer)}>
                <summary>{t.wb_audit_title()}</summary>
                <p class={Muted}>{t.wb_audit_description()}</p>
                <div class={Stack}>
                    <AuditWorkspace t={t} req={req} audit={audit} id="wb-drawer" />
                </div>
            </details>
            <dl class={Metrics}>
                <Metric
                    label={t.wb_gov_metric_rollout_stops()}
                    value={g.summary.active_rollout_stops.to_string()}
                    trend={g.rollout_mode.label.clone()}
                />
                <Metric
                    label={t.wb_gov_metric_denied_commands()}
                    value={g.summary.denied_commands.to_string()}
                    trend={"catalog.manage".to_owned()}
                />
                <Metric
                    label={t.wb_gov_metric_blocked_commands()}
                    value={g.summary.blocked_commands.to_string()}
                    trend={g.rollout_mode.worker_state.clone()}
                />
                <Metric
                    label={t.wb_gov_metric_observability()}
                    value={g.summary.degraded_signals.to_string()}
                    trend={p.integrations_alert_links(g.summary.alert_count).to_string()}
                />
                <Metric
                    label={t.wb_gov_metric_deletion_evidence()}
                    value={g.summary.deletion_evidence_count.to_string()}
                    trend={g.legacy_removal_evidence.required_disposition.clone()}
                />
            </dl>
            <Pairs items={&rollout} />
        </Module>
        <Module
            id="wb-controls"
            title={t.wb_gov_controls_title()}
            description={t.wb_gov_controls_description()}
            status={g.rollout_mode.state.clone()}
            tone={stops_tone}
        >
            if g.controls.is_empty() {
                <Empty title={t.wb_gov_controls_empty_title()} description={t.wb_gov_controls_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_gov_controls_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_gov_table_control()}</th>
                                <th scope="col">{t.wb_gov_table_status()}</th>
                                <th scope="col">{t.wb_gov_table_metric()}</th>
                                <th scope="col">{t.wb_gov_table_scope()}</th>
                                <th scope="col">{t.wb_gov_table_evidence()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &g.controls {
                                let control_status = state_label(&row.status);
                                let commands = if row.command_keys.is_empty() { p.integrations_deletion_evidence().to_owned() } else { row.command_keys.join(", ") };
                                let providers = if row.provider_keys.is_empty() { p.integrations_all_providers().to_owned() } else { row.provider_keys.join(", ") };
                                let units = if row.unit_keys.is_empty() { p.integrations_all_units().to_owned() } else { row.unit_keys.join(", ") };
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_control()}</CellLabel>
                                        <Cell
                                            title={&row.label}
                                            description={Some(row.control_id.as_str())}
                                            detail={Some(row.message.as_str())}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_status()}</CellLabel>
                                        <span class={CellText}>
                                            <Pill text={&control_status} tone={control_tone(&row.status)} />
                                            <Blockers t={t} blockers={&row.blockers} />
                                        </span>
                                    </td>
                                    <td class={Words}>
                                        <CellLabel>{t.wb_gov_table_metric()}</CellLabel>
                                        {&row.metric_key}
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_scope()}</CellLabel>
                                        <span class={CellText}>
                                            <span class={(Muted, Words)}>{commands}</span>
                                            <span class={(Muted, Words)}>{providers}</span>
                                            <span class={(Muted, Words)}>{units}</span>
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_evidence()}</CellLabel>
                                        <Evidence req={req} href={&row.evidence_url} label={t.wb_gov_open_evidence()} />
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
        <Module
            id="wb-rbac"
            title={t.wb_gov_rbac_title()}
            description={t.wb_gov_rbac_description()}
            status={rbac_count.clone()}
            tone={rbac_tone}
        >
            if g.rbac_matrix.is_empty() {
                <Empty title={t.wb_gov_rbac_empty_title()} description={t.wb_gov_rbac_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_gov_rbac_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_gov_table_action()}</th>
                                <th scope="col">{t.wb_gov_table_permission()}</th>
                                <th scope="col">{t.wb_gov_table_state()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &g.rbac_matrix {
                                let state = state_label(&row.state);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_action()}</CellLabel>
                                        <Cell
                                            title={&row.action_key}
                                            description={Some(row.route_pattern.as_str())}
                                            detail={None}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_permission()}</CellLabel>
                                        <span class={Badges}>
                                            <Pill text={&row.required_permission} tone="info" />
                                            if row.confirmation_required {
                                                <Pill text={t.wb_gov_confirmation_required()} tone="warning" />
                                            } else {
                                                <Pill text={t.wb_gov_no_confirmation()} tone="neutral" />
                                            }
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_state()}</CellLabel>
                                        <span class={CellText}>
                                            <Pill text={&state} tone={action_tone(&row.state)} />
                                            <span class={(Muted, Words)}>{&row.denied_copy}</span>
                                            <Blockers t={t} blockers={&row.blockers} />
                                        </span>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
        <Module
            id="wb-observability"
            title={t.wb_gov_observability_title()}
            description={t.wb_gov_observability_description()}
            status={observability.to_string()}
            tone={gov_tone(&g.observability.status)}
        >
            if g.observability.signals.is_empty() {
                <Empty title={t.wb_gov_observability_empty_title()} description={t.wb_gov_observability_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_gov_observability_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_gov_table_signal()}</th>
                                <th scope="col">{t.wb_gov_table_status()}</th>
                                <th scope="col">{t.wb_gov_table_value()}</th>
                                <th scope="col">{t.wb_gov_table_alert_runbook()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &g.observability.signals {
                                let signal_status = state_label(&row.status);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_signal()}</CellLabel>
                                        <Cell
                                            title={&row.label}
                                            description={Some(row.owner_metric_key.as_str())}
                                            detail={None}
                                        />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_status()}</CellLabel>
                                        <span class={Badges}>
                                            <Pill text={&signal_status} tone={gov_tone(&row.status)} />
                                            if row.stale {
                                                <Pill text={t.wb_gov_stale_evidence()} tone="warning" />
                                            }
                                        </span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_value()}</CellLabel>
                                        <Cell title={&row.value} description={None} detail={Some(row.threshold.as_str())} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_alert_runbook()}</CellLabel>
                                        <span class={CellText}>
                                            for link in row.alert_links.iter().chain(&row.runbook_links) {
                                                <Evidence req={req} href={&link.href} label={&link.label} />
                                            }
                                        </span>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
        <Module
            id="wb-removal"
            title={t.wb_gov_removal_title()}
            description={t.wb_gov_removal_description()}
            status={g.legacy_removal_evidence.required_disposition.to_string()}
            tone="danger"
        >
            <Banner tone="danger" title={t.wb_gov_removal_banner_title()} description={t.wb_gov_removal_banner_description()} />
            <Pairs items={&removal} />
            if !g.legacy_removal_evidence.evidence.is_empty() {
                <Table layout={TableLayout::Stack}>
                    <table>
                        <caption class={Caption}>{t.wb_gov_removal_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_gov_table_surface()}</th>
                                <th scope="col">{t.wb_gov_table_status()}</th>
                                <th scope="col">{t.wb_gov_table_evidence()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &g.legacy_removal_evidence.evidence {
                                let removed = state_label(&row.status);
                                <tr>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_surface()}</CellLabel>
                                        <Cell title={&row.label} description={None} detail={Some(row.detail.as_str())} />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_status()}</CellLabel>
                                        <Pill text={&removed} tone="danger" />
                                    </td>
                                    <td>
                                        <CellLabel>{t.wb_gov_table_evidence()}</CellLabel>
                                        <Evidence req={req} href={&row.evidence_url} label={t.wb_gov_open_evidence()} />
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

/// The shell's numbers (`CatalogWorkbenchShell`'s metric strip): the review wave's counts, the
/// import jobs and the promotion's draft item updates.
pub(super) struct Counts<'a> {
    pub observed: u64,
    pub changed: u64,
    pub ready: u64,
    pub active_jobs: u64,
    pub freshness: &'a str,
    pub destructive: u64,
}

/// The shell (`CatalogWorkbenchShell`) around a surface's workspaces: the header, with the way back
/// to the import workbench on a supporting surface, and the four metrics.
#[component(css = IntegrationsPage)]
pub(super) fn Shell<'a, C: Render>(t: Cat, back: Option<String>, counts: Counts<'a>, children: C) -> impl Render {
    html! {
        <div class={Page} data-catalog-primary-workbench>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.wb_eyebrow()}</p>
                    <h1>{t.wb_title()}</h1>
                    <p class={Muted}>{t.wb_description()}</p>
                </div>
                if let Some(back) = &back {
                    <div class={Actions}>
                        <a class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }} href={back}>
                            {t.wb_return()}
                        </a>
                    </div>
                }
            </header>
            <dl class={Metrics}>
                <Metric
                    label={t.wb_metric_observed()}
                    value={counts.observed.to_string()}
                    trend={t.wb_metric_changed(counts.changed).to_string()}
                />
                <Metric
                    label={t.wb_metric_ready_for_preview()}
                    value={counts.ready.to_string()}
                    trend={t.wb_metric_promotion_candidates().to_owned()}
                />
                <Metric
                    label={t.wb_metric_active_jobs()}
                    value={counts.active_jobs.to_string()}
                    trend={t.wb_metric_job_view(counts.freshness).to_string()}
                />
                <Metric
                    label={t.wb_item_updates()}
                    value={counts.destructive.to_string()}
                    trend={t.wb_metric_fail_closed().to_owned()}
                />
            </dl>
            {children}
        </div>
    }
}

/// A surface's page: the shell (`CatalogWorkbenchShell`) around its workspaces, in admin-web's order.
#[component(css)]
pub fn IntegrationsPage<'a>(t: Cat, req: &'a Req, surface: Surface, model: &'a ReadModel) -> impl Render {
    let review = &model.source_observation_review;
    let counts = Counts {
        observed: review.counts.observed,
        changed: review.counts.changed,
        ready: review.promotion_ready_count,
        active_jobs: model.import_jobs.active_job_count,
        freshness: &model.import_jobs.freshness,
        destructive: model.promotion_preview.destructive_count,
    };
    let back = link_to(req, &model.health_triage.return_to_primary_href);
    html! {
        <Shell t={t} back={back} counts={counts}>
            match surface {
                Surface::Health => {
                    <AuditWorkspace t={t} req={req} audit={&model.audit_evidence} id="wb" />
                    <HealthWorkspace t={t} health={&model.health_triage} />
                }
                Surface::Governance => {
                    <GovernanceWorkspace
                        t={t}
                        p={req.t()}
                        req={req}
                        governance={&model.governance_controls}
                        audit={&model.audit_evidence}
                    />
                }
            }
        </Shell>
    }
}
