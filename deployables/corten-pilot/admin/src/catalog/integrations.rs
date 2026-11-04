//! Catalog > Integrations: admin-web's integrations workbench surfaces (`/catalog/integrations`),
//! composed by the Catalog API (`GET /api/catalog/source-observations/workbench-surfaces/{surface}`,
//! chase-sets/chase-sets#10507) and drawn here as the signed-in staff member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/integrations/health?<context>` | Integration health: the audit timeline and health triage |
//! | `GET /catalog/integrations/settings?<context>` | Settings: the governance controls, with the audit evidence to open |
//! | `GET /catalog/integrations/governance?<context>` | the same surface at its older address, which evidence links still use |
//!
//! The address's query is the workbench's route context (`providerKey`, `unitKey`, `jobId`,
//! `section` and the rest, as admin-web names them). The pilot passes it to the API as the
//! surface's `location` without reading it, so the API is the one that parses it, and every link
//! the read model carries (back to the workbench, evidence) keeps working here. A link to a page
//! the pilot does not serve yet goes to admin-web (`link_to`).
//!
//! A projection the API could not read is named in `readModelFailures` and already folded into
//! its panel's status (`unavailable`), so each panel says so on its own and the rest stay usable.
use corten::{
    axum::http::{HeaderMap, Uri},
    prelude::*,
};
use serde::{Deserialize, Serialize};

use super::api::{Catalog as _, Kind};
use crate::{
    api::segment,
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff},
    text::Cat,
};

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    /// Integration health.
    #[route("/catalog/integrations/health", get = crate::catalog::integrations::health)]
    pub struct Health;

    /// Settings: the governance surface.
    #[route("/catalog/integrations/settings", get = crate::catalog::integrations::settings)]
    pub struct Settings;

    /// The governance surface at the address admin-web keeps for evidence links and bookmarks.
    #[route("/catalog/integrations/governance", get = crate::catalog::integrations::governance)]
    pub struct Governance;
}

/// An audience surface the API composes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Governance,
    Health,
}

impl Surface {
    fn key(self) -> &'static str {
        match self {
            Surface::Governance => "governance",
            Surface::Health => "health",
        }
    }
}

/// A link the read model carries.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Link {
    pub label: String,
    pub href: String,
}

/// The surface the API composed (`CatalogPrimaryWorkbenchSurfaceRead`): the parts of its read model
/// these pages draw, and the projections it was built without.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRead {
    pub read_model: ReadModel,
    #[serde(default)]
    pub read_model_failures: Vec<String>,
}

/// `CatalogPrimaryWorkbenchReadModel`, the slices the shell and these surfaces draw.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct ReadModel {
    pub source_observation_review: ReviewSummary,
    pub import_jobs: ImportJobs,
    pub promotion_preview: PromotionPreview,
    pub health_triage: HealthTriage,
    pub governance_controls: Governance,
    pub audit_evidence: AuditEvidence,
}

/// The review wave's counts, for the shell's metrics.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewSummary {
    pub counts: ReviewCounts,
    pub promotion_ready_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct ReviewCounts {
    pub observed: u64,
    pub changed: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportJobs {
    pub freshness: String,
    pub active_job_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PromotionPreview {
    pub destructive_count: u64,
}

/// `CatalogPrimaryWorkbenchHealthTriageReadModel`.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct HealthTriage {
    pub status: String,
    pub return_to_primary_href: String,
    pub summary: HealthSummary,
    #[serde(default)]
    pub read_models: Vec<ReadModelState>,
    #[serde(default)]
    pub units: Vec<HealthUnit>,
    #[serde(default)]
    pub providers: Vec<HealthProvider>,
    #[serde(default)]
    pub rollout_controls: Vec<RolloutControl>,
    #[serde(default)]
    pub recent_jobs: Vec<HealthJob>,
    pub audit_preview: AuditPreview,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct HealthSummary {
    pub ready_units: u64,
    pub total_units: u64,
    pub blocked_units: u64,
    pub degraded_providers: u64,
    pub active_jobs: u64,
    pub rollout_stops: u64,
    pub audit_entries: u64,
}

/// A read model's freshness, for the triage's first table.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ReadModelState {
    pub query_key: String,
    pub freshness: String,
    pub generated_at: Option<String>,
    pub status_message: String,
    pub owner_metric_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct DiagnosticCounts {
    pub error: u64,
    pub warning: u64,
    pub info: u64,
}

/// An ingestion unit's readiness.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct HealthUnit {
    pub unit_key: String,
    pub provider_key: String,
    pub display_name: String,
    pub product_domain: String,
    pub product_form: String,
    pub status: String,
    pub semantic_readiness: String,
    pub credential_readiness: String,
    pub credential_readiness_state: String,
    pub transport_readiness: String,
    pub fixture_validation_status: String,
    pub dry_run_status: String,
    pub observation_facts: u64,
    pub diagnostic_counts: DiagnosticCounts,
    pub latest_diagnostic_text: Option<String>,
    pub affected_primary_action: String,
    pub owner_metric_key: String,
    pub next_action: String,
}

/// A provider's usage budget (`CatalogIntegrationProviderUsageBudget`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct UsageBudget {
    pub credit_balance: Option<f64>,
    pub credit_allowance: Option<f64>,
    pub credit_unit: Option<String>,
    pub readiness: String,
    pub freshness: String,
    pub observed_at: Option<String>,
    pub lag_category: String,
    pub diagnostic: Option<String>,
    pub estimated_calls: Option<f64>,
    pub estimated_scope: Option<String>,
}

/// A count acquisition's spend (`CountSpend`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CountSpend {
    pub kind: String,
    pub credits: u64,
    pub outcome: String,
    pub observed_at: Option<String>,
    pub expires_at: Option<String>,
}

/// A provider adapter's readiness.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct HealthProvider {
    pub provider_key: String,
    pub adapter_key: String,
    pub status: String,
    pub credential_readiness: String,
    pub credential_readiness_state: String,
    pub unit_keys: Vec<String>,
    pub api_reachability: String,
    pub option_query_health: String,
    pub rate_limit_status: String,
    pub payload_acquisition: String,
    pub usage_budget: Option<UsageBudget>,
    pub count_spend: Option<Vec<CountSpend>>,
    pub latest_diagnostic_text: Option<String>,
    pub owner_metric_key: String,
    pub next_action: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RolloutControl {
    pub control_id: String,
    pub status: String,
    pub metric_key: String,
    pub message: String,
    pub next_action: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct HealthJob {
    pub job_id: String,
    pub operator_status: String,
    pub phase: String,
    pub progress_label: String,
    pub summary: String,
    pub owner_metric_key: String,
    pub next_action: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditPreview {
    pub projection_status: String,
    pub status_message: String,
    pub entries: Vec<AuditPreviewEntry>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditPreviewEntry {
    pub event_id: String,
    pub occurred_at: String,
    pub event_name: String,
    pub category: String,
    pub provider_key: String,
    pub unit_key: Option<String>,
    pub summary: String,
}

/// `CatalogPrimaryWorkbenchGovernanceControlsReadModel`.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Governance {
    pub status: String,
    pub return_to_primary_href: String,
    pub summary: GovernanceSummary,
    pub rollout_mode: RolloutMode,
    #[serde(default)]
    pub controls: Vec<Control>,
    #[serde(default)]
    pub rbac_matrix: Vec<RbacRow>,
    pub observability: Observability,
    pub legacy_removal_evidence: RemovalEvidence,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct GovernanceSummary {
    pub active_rollout_stops: u64,
    pub denied_commands: u64,
    pub blocked_commands: u64,
    pub degraded_signals: u64,
    pub alert_count: u64,
    pub deletion_evidence_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RolloutMode {
    pub label: String,
    pub state: String,
    pub worker_state: String,
    pub provider_emergency_stop_count: u64,
    pub import_kill_switch_active: bool,
    pub promotion_kill_switch_active: bool,
    pub reapply_kill_switch_active: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Control {
    pub control_id: String,
    pub label: String,
    pub status: String,
    pub metric_key: String,
    pub evidence_url: String,
    pub command_keys: Vec<String>,
    pub blockers: Vec<String>,
    pub provider_keys: Vec<String>,
    pub unit_keys: Vec<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RbacRow {
    pub action_key: String,
    pub required_permission: String,
    pub route_pattern: String,
    pub state: String,
    pub blockers: Vec<String>,
    pub confirmation_required: bool,
    pub denied_copy: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Observability {
    pub status: String,
    pub signals: Vec<Signal>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Signal {
    pub key: String,
    pub label: String,
    pub status: String,
    pub value: String,
    pub threshold: String,
    pub owner_metric_key: String,
    pub stale: bool,
    pub alert_links: Vec<Link>,
    pub runbook_links: Vec<Link>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RemovalEvidence {
    pub status: String,
    pub required_disposition: String,
    pub removed_surfaces: Vec<String>,
    pub launch_blocker_if_present: Vec<String>,
    pub evidence: Vec<RemovedSurface>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RemovedSurface {
    pub key: String,
    pub label: String,
    pub status: String,
    pub evidence_url: String,
    pub detail: String,
}

/// `CatalogPrimaryWorkbenchAuditEvidenceReadModel`.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvidence {
    pub status: String,
    pub freshness: String,
    pub summary: AuditSummary,
    #[serde(default)]
    pub filters: Vec<AuditFilter>,
    pub projection_state: ProjectionState,
    pub redaction_policy: RedactionPolicy,
    #[serde(default)]
    pub timeline: Vec<TimelineRow>,
    #[serde(default)]
    pub evidence_links: Vec<EvidenceLink>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditSummary {
    pub timeline_events: u64,
    pub redacted_evidence_links: u64,
    pub partial_projection_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct AuditFilter {
    pub key: String,
    pub label: String,
    pub value: Option<String>,
    pub options: Vec<String>,
    pub active: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectionState {
    pub query_key: String,
    pub generated_at: Option<String>,
    pub status_message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RedactionPolicy {
    pub source_payload_access: String,
    pub profile_snapshot_access: String,
    pub forbidden_evidence_requests: Vec<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct TimelineRow {
    pub event_id: String,
    pub occurred_at: String,
    pub event_name: String,
    pub category: String,
    pub actor_label: String,
    pub target_type: String,
    pub target_id: String,
    pub provider_key: Option<String>,
    pub summary: String,
    pub diagnostic_codes: Vec<String>,
    pub evidence_links: Vec<EvidenceLink>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceLink {
    pub key: String,
    pub label: String,
    pub href: String,
    pub kind: String,
    pub summary: String,
    pub redaction_state: String,
    pub source_payload_access: String,
    pub profile_snapshot_access: String,
}

/// The surface's read: the API's composition for this address.
async fn read(config: &Shared, headers: &HeaderMap, surface: Surface, uri: &Uri) -> Result<SurfaceRead, crate::api::ApiError> {
    let location = uri.path_and_query().map_or_else(|| uri.path().to_owned(), |p| p.as_str().to_owned());
    let rest = format!("/workbench-surfaces/{}?location={}", surface.key(), segment(&location));
    config.platform.caller(headers, config.proto, None).read_at::<SurfaceRead>(Kind::SourceObservations, &rest).await
}

async fn page(
    req: Req,
    staff: Staff<CatalogAccess>,
    config: Shared,
    headers: HeaderMap,
    uri: Uri,
    surface: Surface,
    title: &'static str,
) -> HtmlResult {
    let screen = match read(&config, &headers, surface, &uri).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Cat = req.t();
    let view = html! { <super::views::IntegrationsPage t={t} req={&req} surface={surface} model={&screen.read_model} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={title} head="">{view}</crate::views::Layout>
        },
    )
}

async fn health(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let title = req.t::<Cat>().route_integrations_health();
    page(req, staff, config, headers, uri, Surface::Health, title).await
}

async fn settings(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let title = req.t::<Cat>().route_integrations_settings();
    page(req, staff, config, headers, uri, Surface::Governance, title).await
}

async fn governance(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let title = req.t::<Cat>().route_integrations_governance();
    page(req, staff, config, headers, uri, Surface::Governance, title).await
}
