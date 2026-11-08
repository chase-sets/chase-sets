//! Catalog > Integrations, the daily workbench (admin-web's `/catalog/integrations`,
//! `CatalogIntegrationImportToPromotionWorkspace`): Run sync, Review changes, then Create / update
//! items, from the Catalog API's composed read of the daily surface
//! (`GET /api/catalog/source-observations/workbench-surfaces/daily?location=`,
//! chase-sets/chase-sets#10507), as the signed-in staff member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/integrations?<context>&after_write&done` | the workbench for the context, after the command the address names |
//! | `POST /catalog/integrations/catalog-sync?<context>` | starts a Catalog sync of the scope with the checked provider units, and lands on its run |
//! | `POST /catalog/integrations/jobs/{id}?<context>` | retries, resumes or cancels an import job |
//! | `POST /catalog/integrations/units?<context>` | imports or reapplies a workset unit's scope |
//! | `POST /catalog/integrations/review?<context>` | defers or rejects the checked Source Observations |
//! | `POST /catalog/integrations/promotion?<context>` | previews the promotion of the checked Source Observations, or commits the preview the address holds |
//! | `GET /catalog/integrations/evidence/{id}?<context>` | a Source Observation's evidence sheet, or without the script the page with it open |
//! | `POST /catalog/integrations/candidates/{id}?<context>` | ignores or defers a merge candidate |
//! | `POST /catalog/integrations/aliases?<context>` | accepts, rejects, revokes or defers alias candidates |
//!
//! The context is the address's query as admin-web names it (`providerKey`, `unitKey`,
//! `importScope`, `filter.status`, `reviewOffset` and the rest); the pilot passes it to the API
//! as the surface's location without reading it, and every command's form carries it so its
//! redirect lands on the same working set. A command's body is the API's own
//! (`POST /source-observations/catalog-sync-scope/runs`, `.../integration-jobs/{id}/{command}`,
//! `.../bulk-defer/jobs`, `.../bulk-reject/jobs`, `.../admin/merge-candidates/{id}/{ignore,defer,split,update}`);
//! the API decides what each allows. A merge candidate's split and edit name the candidate version
//! the page read, and the API applies them to the snapshot it holds.
//!
//! A workset unit's Sync and Reapply post the bodies the read model built for the unit
//! (`commandScopes`, chase-sets/chase-sets#11082), to `POST .../integration-jobs` and
//! `POST .../reapply`; the API refuses a scope it cannot import or reapply.
//!
//! Preview promotion and Create or update Catalog Items send the selection and confirmation the read
//! model built for `observation.promote` (its `commandPreview`, chase-sets/chase-sets#11142), read
//! again for the working set when the form posts: the preview (`POST .../bulk-promote/preview`)
//! answers a token, which the redirect puts on the address as `promotionPreviewId` with the
//! selection and the draft choice, so the read previews the selection again for the create stage;
//! the commit (`POST .../bulk-promote/jobs`) presents the token and lands on the job it queued.
//! The jobs stage's import preview opens on admin-web until the API composes it for the working set
//! (chase-sets/chase-sets#11130).
//!
//! A review row's Evidence opens the observation's evidence sheet from the API's detail
//! (`GET /api/catalog/source-observations/{id}/evidence`, admin-web's lazy `SourceObservationEvidenceSheet`
//! fetch): a GET form on the page carries the working set, so with the script the answer is the sheet
//! alone, and without it the page the stages are drawn on, with the sheet open.
//!
//! A scope's page draws the same stages for its scope (`crate::catalog::scope`), its forms carrying
//! the working set's `home` (the pilot's own key, never sent to the API), so the redirect after a
//! command lands back on that page.
//!
//! The review stage folds the alias review of the provider and profile version the surface names
//! (`GET /api/catalog/alias-review?providerKey=&sourceProfileVersion=`, admin-web's deferred
//! `selectedScopeAliasReview`), left out when it does not read, and posts its commands to the alias
//! review's own (`POST .../alias-review/commands`).
//!
//! Above the steps the import context bar ([`super::views::ImportContext`]) chooses the provider,
//! the unit, the scope and the profile version from the surface's provider scope and its deferred
//! source options read (`GET .../workbench-surfaces/daily/source-options?location=`), and posts the
//! options' Reload and Force refresh to `POST /catalog/integrations/source-options?<context>`. Which
//! field each option kind drives and which options a level offers are copied from admin-web until the
//! API returns them (chase-sets/chase-sets#11080).
//!
//! Beside the surface the page reads the Catalog sync run the address's `jobId` names
//! (`GET .../catalog-sync-scope/runs/{id}`), where a sync lands, and then the durable sync state of the
//! scope the surface names (`POST .../catalog-sync-scope/state`, a read); each is left out when it
//! does not read, as admin-web's panels are. A failed or stale unit's Retry provider is the job route's
//! retry of its last job.
//!
//! The read model carries the open stage and each stage's state (`flow`), the governance and
//! health banners (`dailyStatus`), and the review queue's status filter and pager links; a scope's
//! page draws those links on itself ([`rebase`]).
use corten::{
    Local,
    http::{HeaderMap, Uri},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Sent,
    api::{Catalog as _, Kind, under},
    command,
    import_context::{ProviderScope, ScopeContext, SourceOptions},
    manages, receipt,
};
use crate::{
    api::{Caller, Method, segment},
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    /// The daily workbench.
    #[route("/catalog/integrations", get = crate::catalog::daily::page)]
    pub struct Daily;

    /// Starts a Catalog sync of the scope.
    #[route("/catalog/integrations/catalog-sync", post = crate::catalog::daily::sync)]
    pub struct Sync;

    /// Retries, resumes or cancels an import job.
    #[route("/catalog/integrations/jobs/{id}", post = crate::catalog::daily::job)]
    pub struct Job<'a> {
        pub id: &'a str,
    }

    /// Imports or reapplies a workset unit's scope.
    #[route("/catalog/integrations/units", post = crate::catalog::daily::unit)]
    pub struct Unit;

    /// Defers or rejects the checked Source Observations.
    #[route("/catalog/integrations/review", post = crate::catalog::daily::review)]
    pub struct Review;

    /// Previews the promotion of the checked Source Observations (or the scope), or commits the
    /// preview the address holds.
    #[route("/catalog/integrations/promotion", post = crate::catalog::daily::promotion)]
    pub struct Promotion;

    /// A Source Observation's evidence sheet, for the working set the address carries.
    #[route("/catalog/integrations/evidence/{id}", get = crate::catalog::daily::evidence)]
    pub struct Evidence<'a> {
        pub id: &'a str,
    }

    /// Ignores or defers a merge candidate.
    #[route("/catalog/integrations/candidates/{id}", post = crate::catalog::daily::candidate)]
    pub struct MergeCandidate<'a> {
        pub id: &'a str,
    }

    /// Reloads or refreshes the provider's source options, then lands on the working set.
    #[route("/catalog/integrations/source-options", post = crate::catalog::daily::source_options_refresh)]
    pub struct SourceOptions;

    /// An alias candidate's command in the review stage's alias review.
    #[route("/catalog/integrations/aliases", post = crate::catalog::daily::aliases)]
    pub struct Aliases;
}

/// What a command did, for the page it redirects to (admin-web's `CatalogCommandFeedbackBanner`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ran {
    /// A command the API accepted: a sync, a retry, a resume, a defer, a reject, or a merge
    /// candidate's ignore or defer (admin-web says `job-queued` for each).
    Queued,
    Cancelled,
}

impl Ran {
    pub(crate) fn word(self) -> &'static str {
        match self {
            Ran::Queued => "queued",
            Ran::Cancelled => "cancelled",
        }
    }

    fn of(word: &str) -> Option<Ran> {
        match word {
            "queued" => Some(Ran::Queued),
            "cancelled" => Some(Ran::Cancelled),
            _ => None,
        }
    }
}

/// The surface the API composed for the daily route: its read model and the projections it was
/// built without.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct DailyRead {
    pub read_model: Daily,
    #[serde(default)]
    pub read_model_failures: Vec<String>,
    /// The Catalog sync scope the read names (catalogSyncScope): the scope Sync scope starts, and
    /// the one whose durable sync state the page reads. Passed back to the API as it is.
    #[serde(default)]
    pub catalog_sync_scope: Option<Value>,
}

/// `CatalogPrimaryWorkbenchReadModel`, the slices the daily workbench draws.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Daily {
    pub route_context: RouteContext,
    pub readiness: Readiness,
    pub catalog_sync: CatalogSync,
    pub import_jobs: ImportJobs,
    pub source_observation_review: Review,
    pub merge_candidate_review: MergeReview,
    pub promotion_preview: PromotionPreview,
    pub promotion_result: Option<PromotionResult>,
    pub actions: Vec<Action>,
    pub provider_scope: ProviderScope,
    pub source_scope_workset: Workset,
    /// The source options' skeleton: their kinds, without the pages the page reads beside it.
    pub source_options: SourceOptions,
    /// The stage the page opens on and each stage's state.
    pub flow: Flow,
    /// The governance and health banners the daily route shows.
    pub daily_status: DailyStatus,
}

/// `CatalogPrimaryWorkbenchFlowReadModel`: the stage the route opens on (its section's, else the
/// first with work) and the three stages' states with it open.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Flow {
    pub open_stage: String,
    pub stages: Vec<FlowStage>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct FlowStage {
    pub key: String,
    pub state: String,
}

/// `CatalogPrimaryWorkbenchDailyStatusReadModel`: `denied` or `stopped`, and `blocked` or
/// `degraded`; none for a banner the route does not show.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct DailyStatus {
    pub governance: Option<String>,
    pub health: Option<String>,
}

/// The route context the API parsed from the location: the section, for the open stage, and the
/// import context the bar draws.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RouteContext {
    pub section: String,
    pub provider_key: Option<String>,
    pub unit_key: Option<String>,
    pub scope: Option<ScopeContext>,
    pub import_scope: Option<String>,
    pub profile_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Readiness {
    pub freshness: String,
    pub blockers: Vec<String>,
    pub provider_transport: Vec<String>,
    pub rollout_enabled: bool,
    pub rbac_allowed: bool,
}

impl Default for Readiness {
    fn default() -> Self {
        Readiness {
            freshness: "fresh".into(),
            blockers: Vec::new(),
            provider_transport: Vec::new(),
            rollout_enabled: true,
            rbac_allowed: true,
        }
    }
}

/// A command's state (`CatalogPrimaryWorkbenchActionReadModel`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Action {
    pub key: String,
    pub state: String,
    pub blockers: Vec<String>,
    /// The body the API built for the command, where it builds one (a merge candidate's split
    /// names the version it read and the observations it splits off).
    pub command_preview: Option<CommandPreview>,
}

/// A command's body as the API built it: a merge candidate's (`CatalogMergeCandidateReviewCommandPreview`),
/// or a promotion's selection and confirmation (`CatalogPrimaryWorkbenchPromotionCommandPreview`,
/// chase-sets/chase-sets#11142), passed back to the API as they are.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CommandPreview {
    pub body: PreviewBody,
    pub scope: Option<Value>,
    pub confirmation: Option<Value>,
    /// Whether the promotion may run on the scope with no observation checked.
    pub allow_scope_selection: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PreviewBody {
    pub reason: String,
    pub expected_version: Option<u64>,
    pub split_observation_ids: Vec<String>,
}

impl Action {
    /// Whether the command may run (`available` or `degraded`, as admin-web's buttons allow).
    pub fn open(&self) -> bool {
        matches!(self.state.as_str(), "available" | "degraded")
    }
}

/// The selected source scope's provider units (`CatalogPrimaryWorkbenchSourceScopeWorksetReadModel`):
/// the scope, its counts, and each unit's state, counts, address and commands.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Workset {
    pub status: String,
    pub selected_scope: WorksetScope,
    pub summary: WorksetSummary,
    pub units: Vec<WorksetUnit>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct WorksetScope {
    pub label: String,
    pub import_scope: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct WorksetSummary {
    pub changed_observation_count: u64,
    pub promoted_observation_count: u64,
    pub active_import_count: u64,
}

/// A provider unit of the workset. Its `currentWorkbenchHref` is the working set the unit's scope
/// opens, as admin-web's path, and its `commandScopes` the bodies its import and reapply post.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct WorksetUnit {
    pub provider_key: String,
    pub display_name: String,
    pub unit_key: Option<String>,
    pub profile_version: Option<String>,
    pub state: String,
    pub counts: WorksetCounts,
    pub current_workbench_href: String,
    pub actions: WorksetActions,
    pub command_scopes: Option<CommandScopes>,
}

impl WorksetUnit {
    /// The key the row and its forms name the unit by: its unit, or its provider without one
    /// (admin-web's `data-catalog-source-scope-unit`).
    pub fn key(&self) -> &str {
        self.unit_key.as_deref().unwrap_or(&self.provider_key)
    }

    /// Whether the read built the unit's own promotion preview (its `actions.previewPromotion`
    /// `commandPreview`, chase-sets/chase-sets#11142), so its Preview posts to the pilot.
    pub fn previewable(&self) -> bool {
        self.actions.preview_promotion.command_preview.as_ref().is_some_and(|c| c.confirmation.is_some())
    }
}

/// The scopes a unit's commands post (`commandScopes`), as the API built them; passed back as they
/// are. Null while the unit has no scope.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct CommandScopes {
    pub import: Value,
    pub reapply: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct WorksetCounts {
    pub observed: u64,
    pub changed: u64,
    pub promoted: u64,
}

/// A unit's three commands: its import (`scope.import`), its promotion preview
/// (`observation.promote`) and its reapply (`observation.reapply`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct WorksetActions {
    pub import: Action,
    pub preview_promotion: Action,
    pub reapply: Action,
}

impl WorksetActions {
    /// The commands, in admin-web's order.
    pub fn all(&self) -> [&Action; 3] {
        [&self.import, &self.preview_promotion, &self.reapply]
    }
}

/// `CatalogPrimaryWorkbenchCatalogSyncReadModel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogSync {
    pub status: String,
    pub scope: SyncScope,
    pub preview: SyncPreview,
    pub action: Action,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncScope {
    pub product_domain: Option<String>,
    pub product_form: Option<String>,
    pub language_code: Option<String>,
    pub reference: SyncReference,
    pub label: String,
    pub has_concrete_scope: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncReference {
    pub kind: Option<String>,
    pub scope_record_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncPreview {
    pub status: String,
    pub start_allowed: bool,
    pub explanation: String,
    pub estimate: SyncEstimate,
    pub units: Vec<SyncUnit>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncEstimate {
    pub total_estimated_request_count: Option<u64>,
    pub estimate_reason: Option<String>,
    pub credit_consuming_providers: Vec<CreditProvider>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CreditProvider {
    pub provider_key: String,
    pub display_name: String,
}

/// A provider unit's part in the sync (`CatalogPrimaryWorkbenchCatalogSyncUnitReadModel`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncUnit {
    pub provider_key: String,
    pub unit_key: Option<String>,
    pub display_name: String,
    pub profile_version: Option<String>,
    pub role: String,
    pub requirement: String,
    pub selected: bool,
    pub eligibility: String,
    pub blockers: Vec<SyncBlocker>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct SyncBlocker {
    pub code: String,
    pub message: String,
}

/// A Catalog sync run (CatalogSyncRun, GET .../catalog-sync-scope/runs/{id}): the parent run
/// the address's jobId names after Sync scope, its counts and a child job per provider unit.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncRun {
    pub sync_run_id: String,
    pub status: String,
    pub progress: SyncRunProgress,
    pub child_jobs: Vec<SyncRunChild>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncRunProgress {
    pub child_jobs: SyncRunCounts,
    pub provider_targets: SyncRunTargets,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct SyncRunCounts {
    pub total: u64,
    pub queued: u64,
    pub running: u64,
    pub completed: u64,
    pub partial: u64,
    pub failed: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct SyncRunTargets {
    pub completed: u64,
    pub total: u64,
}

/// A provider unit's child job in a run (CatalogSyncRunChildJob).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncRunChild {
    pub unit_key: String,
    pub display_name: String,
    pub child_job_id: Option<String>,
    pub status: String,
    pub sync_run_link_state: String,
}

/// A provider unit's durable sync state in the scope, kept across runs
/// (CatalogScopeSyncUnitStateReadModel, POST .../catalog-sync-scope/state).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct UnitState {
    pub provider_key: String,
    pub unit_key: String,
    pub display_name: String,
    pub state: String,
    pub last_sync_run_id: Option<String>,
    pub last_job_id: Option<String>,
    pub observed_count: Option<u64>,
    pub changed_count: Option<u64>,
    pub last_completed_at: Option<String>,
}

impl UnitState {
    /// The job Retry provider retries: the unit's last one, offered only for a failed or stale
    /// unit (admin-web's scopeSyncUnitRetryAvailable); the API decides whether it runs.
    pub fn retry(&self) -> Option<&str> {
        matches!(self.state.as_str(), "failed" | "stale").then_some(self.last_job_id.as_deref()).flatten()
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct UnitStates {
    items: Vec<UnitState>,
}

/// `CatalogPrimaryWorkbenchImportJobsReadModel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportJobs {
    pub freshness: String,
    pub active_job_count: u64,
    pub failed_job_count: u64,
    pub jobs: Vec<ImportJob>,
    /// The import scope's readiness, which provider detail's validation readiness shows.
    pub selected_scope: Option<super::validation::SelectedScope>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportJob {
    pub job_id: String,
    pub state: String,
    pub operator_status: String,
    pub summary: String,
    pub completed: u64,
    pub total: u64,
    pub progress_percent: u64,
    pub unit_key: Option<String>,
    pub provider_key: String,
    pub import_scope: Option<String>,
    pub profile_version: Option<String>,
    pub profile_snapshot: Option<ProfileSnapshot>,
    pub scope_matches_route: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub failure_groups: Vec<FailureGroup>,
    pub retry_available: bool,
    pub resume_available: bool,
    pub cancel_available: bool,
    pub source_observation_review_href: String,
    pub audit_evidence_url: String,
    pub result: Option<JobResult>,
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub profile_key: String,
    pub profile_version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct FailureGroup {
    pub key: String,
    pub label: String,
    pub count: u64,
    pub severity: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct JobResult {
    pub usage: Option<JobUsage>,
    pub observed_count: Option<u64>,
    pub skipped_count: Option<u64>,
    pub failed_count: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct JobUsage {
    pub actual_request_count: Option<u64>,
    pub page_count: Option<u64>,
    pub cache_hit_count: Option<u64>,
    pub cache_miss_count: Option<u64>,
}

/// `CatalogPrimaryWorkbenchSourceObservationReviewReadModel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Review {
    pub freshness: String,
    pub counts: ReviewCounts,
    pub promotion_ready_count: u64,
    pub filters: Vec<ReviewFilter>,
    /// The status filter's options in order, each with its count and its daily link.
    pub status_filters: Vec<StatusFilter>,
    pub pagination: Pagination,
    pub rows: Vec<ReviewRow>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct StatusFilter {
    pub value: String,
    pub count: u64,
    pub href: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct ReviewCounts {
    pub observed: u64,
    pub changed: u64,
    pub promoted: u64,
    pub rejected: u64,
    pub blocked: u64,
    pub eligible: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewFilter {
    pub key: String,
    pub label: String,
    pub value: Option<String>,
    pub server_applied: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Pagination {
    pub limit: u64,
    pub offset: u64,
    pub total: u64,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
    /// The daily links to the neighbouring pages, none at either end.
    pub previous_href: Option<String>,
    pub next_href: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewRow {
    pub observation_id: String,
    pub provider_key: String,
    pub external_key: String,
    pub display_name: String,
    pub status: String,
    pub source_updated_at: Option<String>,
    pub changed_at: String,
    pub fact_summary_preview: Vec<String>,
    pub payload_summary: String,
    pub redaction_summary: String,
    pub duplicate_count: u64,
    pub promotion_readiness: Readied,
    pub actions: Vec<Action>,
}

impl ReviewRow {
    /// Whether the row can be checked for a defer or a reject (`isReviewableObservationRow`).
    pub fn reviewable(&self) -> bool {
        matches!(self.status.as_str(), "observed" | "changed")
    }

    /// Whether the row can be checked for Preview promotion: reviewable, and eligible for it (the
    /// rows admin-web's bar counts as `selectedEligibleObservationCount`).
    pub fn eligible(&self) -> bool {
        self.reviewable() && self.promotion_readiness.state == "eligible"
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Readied {
    pub state: String,
    pub blockers: Vec<String>,
}

/// A Source Observation's evidence (`CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData`):
/// none when the API has no detail for it, or the read failed, where the sheet says so.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ObservationEvidence {
    pub observation_id: String,
    pub detail: Option<EvidenceDetail>,
}

/// `CatalogPrimaryWorkbenchSourceObservationEvidenceDetail`: the fields the sheet shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceDetail {
    pub observation_id: String,
    pub provider_key: String,
    pub external_key: String,
    pub display_name: String,
    pub source_url: String,
    pub source_record_hash: String,
    pub source_updated_at: Option<String>,
    pub observed_at: String,
    pub changed_at: String,
    pub source_profile_version: String,
    pub promotion_profile_version: Option<String>,
    pub payload_summary: String,
    pub redaction_summary: String,
    pub normalized_fact_summaries: Vec<String>,
    pub product_contents_evidence: ContentsEvidence,
    pub duplicate_evidence: Vec<String>,
    pub conflict_evidence: Vec<String>,
    pub audit_trail: Vec<String>,
    pub promotion_readiness: Readied,
    pub command_preview: EvidencePreview,
}

/// `CatalogPrimaryWorkbenchProductContentsEvidenceReview`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ContentsEvidence {
    pub state: String,
    pub summary: String,
    pub rows: Vec<ContentsLine>,
}

/// `CatalogPrimaryWorkbenchProductContentsEvidenceLine`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ContentsLine {
    pub line_number: u64,
    pub state: String,
    pub content_type_label: String,
    pub inclusion_policy_label: Option<String>,
    pub quantity: Option<f64>,
    pub target_summary: String,
    pub contained_selected_option_labels: Vec<String>,
    pub provenance_summary: Vec<String>,
}

/// The evidence's command preview: the plan hash, once a preview made one.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidencePreview {
    pub promotion_plan_hash: Option<String>,
}

/// `CatalogPrimaryWorkbenchMergeCandidateReviewReadModel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct MergeReview {
    pub freshness: String,
    pub counts: MergeCounts,
    pub rows: Vec<Candidate>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct MergeCounts {
    pub total: u64,
    pub ready: u64,
    pub conflict: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Candidate {
    pub candidate_id: String,
    pub identity_fingerprint: String,
    pub identity_label: String,
    pub source_count: u64,
    pub sources: Vec<CandidateSource>,
    pub status: String,
    pub conflicts: Conflicts,
    pub promote_readiness: Readied,
    pub proposed_mapping: Mapping,
    pub actions: Vec<Action>,
    pub edit_form: EditForm,
}

impl Candidate {
    /// The split the API offers: the version it read and the observations it splits off, when
    /// the command may run.
    pub fn split(&self) -> Option<(&Action, u64, &[String])> {
        let action = self.actions.iter().find(|a| a.key == "candidate.split" && a.open())?;
        let body = &action.command_preview.as_ref()?.body;
        let ids = body.split_observation_ids.as_slice();
        Some((action, body.expected_version?, ids)).filter(|(_, _, ids)| !ids.is_empty())
    }

    /// The promote the API offers with the version it read (its `commandPreview`,
    /// chase-sets/chase-sets#11143), when the command may run and no blocking conflict needs a
    /// resolution first; a promote that resolves conflicts stays on admin-web's conflict form.
    pub fn promote(&self) -> Option<(&Action, u64)> {
        let action = self.actions.iter().find(|a| a.key == "candidate.promote" && a.open())?;
        let version = action.command_preview.as_ref()?.body.expected_version?;
        (self.conflicts.blocking == 0).then_some((action, version))
    }
}

/// A candidate's typed edit (`CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel`): what the
/// form shows and the version it names. The API applies the edit to the snapshot it holds.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct EditForm {
    pub state: String,
    pub blockers: Vec<String>,
    pub candidate_version: Option<u64>,
    pub promotion_intent: String,
    pub catalog_item_id: Option<String>,
    pub product_ids: Vec<String>,
    pub editable_facts: Vec<EditFact>,
    pub external_catalog_item_references: Vec<EditReference>,
    pub external_product_references: Vec<EditReference>,
}

impl EditForm {
    /// The version the form names, when the API offers the edit.
    pub fn version(&self) -> Option<u64> {
        if self.state == "available" { self.candidate_version } else { None }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct EditFact {
    pub key: String,
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct EditReference {
    pub index: u64,
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CandidateSource {
    pub provider_key: String,
    pub observation_id: Option<String>,
    pub external_key: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Conflicts {
    pub blocking: u64,
    pub warnings: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Mapping {
    pub promotion_intent: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PromotionPreview {
    /// The preview token the address carries (`promotionPreviewId`), with which the API previewed
    /// the selection again for this read.
    pub preview_id: Option<String>,
    pub blockers: Vec<String>,
    pub destructive_count: u64,
    pub freshness: String,
    pub scope: PromotionScope,
    pub outcome_counts: OutcomeCounts,
    pub command_plan_hash: Option<String>,
    pub validation: PromotionValidation,
    pub execution_safeguards: Safeguards,
}

impl PromotionPreview {
    /// Whether the preview may be committed: a token is held, the API found it fresh, and it
    /// validated every eligible observation in one page with no blocking identity. admin-web decides
    /// this from the receipt its action keeps (`promotionReceiptHasCompleteCoverage`), which a
    /// redirect does not carry, so this is that rule as the read can answer it until the read says it
    /// (chase-sets/chase-sets#11175); the API refuses a stale token whatever the page offers.
    pub fn fresh(&self) -> bool {
        self.preview_id.is_some()
            && self.execution_safeguards.preview_fresh
            && self.validation.coverage == "complete"
            && self.validation.continuation.is_none()
            && self.scope.eligible_count > 0
            && !self.validation.identity_diagnostics.iter().any(|d| d.blocking)
    }

    /// Whether an observation's display identity cannot be resolved, which no commit carries.
    pub fn identity_blocked(&self) -> bool {
        self.blockers.iter().any(|b| b == "display-identity-unresolvable")
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PromotionScope {
    pub label: String,
    pub requested_count: u64,
    pub eligible_count: u64,
    pub selected_observation_ids: Vec<String>,
    pub filter_summary: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct OutcomeCounts {
    pub eligible: u64,
    pub blocked: u64,
    pub skipped: u64,
    pub conflicting: u64,
}

/// The preview's read-only pre-write validation (`CatalogPrimaryWorkbenchPromotionValidationReadModel`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PromotionValidation {
    pub promote_as_draft: bool,
    /// `complete`, `partial` or `not-previewed`.
    pub coverage: String,
    pub covered_count: u64,
    pub identity_diagnostics: Vec<IdentityDiagnostic>,
    pub other_blocked_observation_ids: Vec<String>,
    /// The next page's cursor when the preview validated only its first page.
    pub continuation: Option<String>,
}

impl Default for PromotionValidation {
    fn default() -> Self {
        PromotionValidation {
            promote_as_draft: false,
            coverage: "not-previewed".into(),
            covered_count: 0,
            identity_diagnostics: Vec::new(),
            other_blocked_observation_ids: Vec::new(),
            continuation: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct IdentityDiagnostic {
    pub observation_id: String,
    pub blocking: bool,
    pub template_reason: String,
    pub diagnostic_text: String,
    pub missing_tokens: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Safeguards {
    pub preview_fresh: bool,
    pub stale_reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct PromotionResult {
    pub result_id: String,
    pub job_id: String,
    pub status: String,
    pub promoted_count: u64,
    pub promoted_catalog_item_ids: Vec<String>,
    pub completed_at: String,
}

/// A stage of the daily flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    RunSync,
    Review,
    Create,
}

impl Stage {
    pub const ALL: [Stage; 3] = [Stage::RunSync, Stage::Review, Stage::Create];

    /// The stage's key (`data-catalog-import-workflow-stage`).
    pub fn key(self) -> &'static str {
        match self {
            Stage::RunSync => "run-sync",
            Stage::Review => "review-changes",
            Stage::Create => "create-items",
        }
    }
}

/// Where a stage is (`PageStepperItem["status"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageState {
    Complete,
    Current,
    Upcoming,
    Blocked,
}

impl Stage {
    /// The stage a read model's key names.
    pub fn of(key: &str) -> Option<Stage> {
        Stage::ALL.into_iter().find(|stage| stage.key() == key)
    }
}

impl StageState {
    /// The state a read model's flow names (`CatalogPrimaryWorkbenchFlowStageState`).
    pub fn of(state: &str) -> Option<StageState> {
        match state {
            "complete" => Some(StageState::Complete),
            "current" => Some(StageState::Current),
            "upcoming" => Some(StageState::Upcoming),
            "blocked" => Some(StageState::Blocked),
            _ => None,
        }
    }
}

/// The stage the read model opens on (`flow.openStage`), Run sync for one it does not name.
pub fn open_stage(model: &Daily) -> Stage {
    Stage::of(&model.flow.open_stage).unwrap_or(Stage::RunSync)
}

/// Each stage's state as the read model's flow gives them, in order; a stage it leaves out or
/// names in a state the page does not know is not drawn.
pub fn flow(model: &Daily) -> Vec<(Stage, StageState)> {
    model.flow.stages.iter().filter_map(|s| Some((Stage::of(&s.key)?, StageState::of(&s.state)?))).collect()
}

/// The flow's blockers, each once: readiness's, then the promotion command's.
pub fn blockers(model: &Daily) -> Vec<&str> {
    let mut seen: Vec<&str> = Vec::new();
    for b in model.readiness.blockers.iter().chain(&model.promotion_preview.blockers) {
        if !seen.contains(&b.as_str()) {
            seen.push(b);
        }
    }
    seen
}

/// A governance signal the daily route shows instead of the governance panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Governance {
    Denied,
    Stopped,
}

/// A health signal the daily route shows instead of health triage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Blocked,
    Degraded,
}

/// The governance banner the read model asks for (`dailyStatus.governance`).
pub fn governance(model: &Daily) -> Option<Governance> {
    match model.daily_status.governance.as_deref()? {
        "denied" => Some(Governance::Denied),
        "stopped" => Some(Governance::Stopped),
        _ => None,
    }
}

/// The health banner the read model asks for (`dailyStatus.health`).
pub fn health(model: &Daily) -> Option<Health> {
    match model.daily_status.health.as_deref()? {
        "blocked" => Some(Health::Blocked),
        "degraded" => Some(Health::Degraded),
        _ => None,
    }
}

/// The query `context` with each named key set to its value, or removed for `None`, keeping the
/// rest in order.
pub fn with_query(context: &str, changes: &[(&str, Option<&str>)]) -> String {
    let named = |pair: &str| changes.iter().any(|(key, _)| pair.split('=').next() == Some(*key));
    let mut pairs: Vec<String> = context.split('&').filter(|p| !p.is_empty() && !named(p)).map(str::to_owned).collect();
    for (key, value) in changes {
        if let Some(value) = value {
            pairs.push(format!("{key}={}", segment(value)));
        }
    }
    pairs.join("&")
}

/// `path` with the query `context`, or the bare path for none.
pub fn at(path: &str, context: &str) -> String {
    if context.is_empty() { path.to_owned() } else { format!("{path}?{context}") }
}

/// The working set's pilot-only key that names the scope whose page draws the stages (admin-web's
/// Scope Detail, which posts the same commands to its own route): a command lands back there.
/// It is never sent to the API.
pub const HOME: &str = "home";

/// The page the working set `context` draws its stages on: the scope's page its `home` names, or
/// the daily workbench.
pub fn home(context: &str) -> String {
    match context_value(context, HOME).filter(|id| !id.is_empty()) {
        Some(id) => crate::catalog::scope::url::ScopePage::of(&id).href().to_string(),
        None => url::Daily.href().to_string(),
    }
}

/// A daily link the read model built (a review status filter's, its pager's) on the page the
/// working set `context` draws its stages on, as admin-web's embeds rebase it: the link's query with
/// the working set's `home`, at that page. `None` for a link that is not the daily route's.
pub fn rebase(context: &str, href: &str) -> Option<String> {
    let (path, query) = href.split_once('?').unwrap_or((href, ""));
    (path == url::Daily.href().as_str()).then(|| {
        let id = context_value(context, HOME).filter(|id| !id.is_empty());
        at(&home(context), &with_query(query, &[(HOME, id.as_deref())]))
    })
}

/// The daily surface's location for the working set, less the pilot's `home`: the scope's page its
/// `home` names, whose journey the Catalog API composes from the Scope Record
/// (chase-sets/chase-sets#11131), or the daily route.
pub fn location(context: &str) -> String {
    let rest = with_query(context, &[(HOME, None)]);
    match context_value(context, HOME).filter(|id| !id.is_empty()) {
        Some(id) => at(crate::catalog::scope::url::ScopePage::of(&id).href().as_str(), &rest),
        None => at(url::Daily.href().as_str(), &rest),
    }
}

/// The address's working set: its query without what the last command left on it.
pub fn context_of(uri: &Uri) -> String {
    with_query(uri.query().unwrap_or_default(), &[("after_write", None), ("done", None)])
}

/// A query value the address carries (the last command's receipt and outcome), decoded.
fn param(uri: &Uri, key: &str) -> Option<String> {
    context_value(uri.query()?, key)
}

/// A value of the query `context`, decoded.
pub fn context_value(context: &str, key: &str) -> Option<String> {
    let raw = context.split('&').find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))?;
    Some(percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

/// The working set's query as names and values, decoded as a form's are (`+` a space): the hidden
/// fields of a GET form that lands on the same working set, as its submit replaces its action's query.
pub fn context_fields(context: &str) -> Vec<(String, String)> {
    let decode = |text: &str| percent_encoding::percent_decode_str(&text.replace('+', " ")).decode_utf8_lossy().into_owned();
    context
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(name), decode(value))
        })
        .collect()
}

/// What the page draws: the read model, what the last command did or the refusal of the one just
/// sent, and whether the viewer may run the commands.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct DailyScreen {
    pub read: DailyRead,
    pub manage: bool,
    /// The sync run the address names (jobId), when it reads.
    pub run: Option<SyncRun>,
    /// The scope's durable sync state, per provider unit; empty when there is none or it fails.
    pub units: Vec<UnitState>,
    /// The provider's populated source options; none when that read fails, and the bar draws the
    /// surface's skeleton.
    pub options: Option<SourceOptions>,
    /// The alias review of the surface's provider and profile version; none when it does not read.
    pub aliases: Option<super::api::AliasReview>,
    /// The evidence sheet drawn open, without the script; none otherwise.
    pub evidence: Option<ObservationEvidence>,
}

impl DailyScreen {
    /// The source options the bar draws.
    pub fn source_options(&self) -> &SourceOptions {
        self.options.as_ref().unwrap_or(&self.read.read_model.source_options)
    }
}

/// What the page says at its top: a command's outcome, or its refusal.
pub enum Said<'a> {
    Ran(Ran),
    Refused(&'a Errors),
}

async fn read(
    config: &Shared,
    headers: &HeaderMap,
    location: &str,
    receipt: Option<&Receipt>,
) -> Result<DailyRead, crate::api::ApiError> {
    read_with(&config.platform.caller(headers, config.proto, receipt), location).await
}

async fn read_with(caller: &Caller<'_>, location: &str) -> Result<DailyRead, crate::api::ApiError> {
    let rest = format!("/workbench-surfaces/daily?location={}", segment(location));
    caller.read_at::<DailyRead>(Kind::SourceObservations, &rest).await
}

/// The daily surface for a scope's page, the working set `context` (its `home` the scope), with
/// the sync run it names and the scope's sync state, as admin-web's Scope Detail reads them; none
/// when the surface does not read, where the section says so. The scope's page has no import
/// context bar or alias review, so neither is read.
pub(crate) async fn workspace(caller: &Caller<'_>, context: &str, manage: bool) -> Option<DailyScreen> {
    let location = location(context);
    let (read, run) = tokio::join!(read_with(caller, &location), sync_run(caller, context));
    let read = read.inspect_err(|error| tracing::warn!("a scope's daily surface could not be read: {error}")).ok()?;
    let units = unit_states(caller, &read).await;
    Some(DailyScreen { read, manage, run, units, options: None, aliases: None, evidence: None })
}

/// The Catalog sync run the address's `jobId` names (admin-web's `selectedCatalogSyncRun`): none
/// without one, or when it does not read (an import job's id, a run that is gone), as there.
async fn sync_run(caller: &Caller<'_>, context: &str) -> Option<SyncRun> {
    let id = context_value(context, "jobId").filter(|id| !id.is_empty())?;
    let rest = format!("/catalog-sync-scope/runs/{}", segment(&id));
    caller.read_at::<SyncRun>(Kind::SourceObservations, &rest).await.ok()
}

/// The provider's populated source options for the location (admin-web's deferred
/// `settledSourceOptionsRead`): none when they do not read, where the bar draws the skeleton.
async fn source_options(config: &Shared, headers: &HeaderMap, location: &str) -> Option<SourceOptions> {
    let rest = format!("/workbench-surfaces/daily/source-options?location={}", segment(location));
    match config.platform.caller(headers, config.proto, None).read_at::<SourceOptions>(Kind::SourceObservations, &rest).await {
        Ok(options) => Some(options),
        Err(error) => {
            tracing::warn!("catalog source options read failed: {error}");
            None
        }
    }
}

/// The durable sync state of the scope the surface names (admin-web's
/// `selectedCatalogScopeSyncState`, a `POST` that reads): none without a scope, or when it does
/// not read, as there, where the run's own panels still draw.
async fn unit_states(caller: &Caller<'_>, read: &DailyRead) -> Vec<UnitState> {
    let Some(scope) = &read.catalog_sync_scope else { return Vec::new() };
    let body = json!({ "scope": scope });
    match caller.post::<UnitStates>(Kind::SourceObservations, "/catalog-sync-scope/state", &body).await {
        Ok(states) => states.items,
        Err(error) => {
            tracing::warn!("catalog scope sync state read failed: {error}");
            Vec::new()
        }
    }
}
/// The alias review's query for the provider and profile version the surface names (admin-web's
/// `selectedScopeAliasReview`), also what an Auto-accept eligible reads again.
fn alias_query(provider_key: Option<&str>, profile_version: Option<&str>) -> String {
    let mut pairs: Vec<String> = Vec::new();
    if let Some(key) = provider_key.filter(|k| !k.is_empty()) {
        pairs.push(format!("providerKey={}", segment(key)));
    }
    if let Some(version) = profile_version.filter(|v| !v.is_empty()) {
        pairs.push(format!("sourceProfileVersion={}", segment(version)));
    }
    if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) }
}

/// The alias review beside the surface: none when it does not read, as admin-web's slot draws
/// nothing then.
async fn alias_review(caller: &Caller<'_>, route: &RouteContext) -> Option<super::api::AliasReview> {
    let query = alias_query(route.provider_key.as_deref(), route.profile_version.as_deref());
    match caller.read_at::<super::api::AliasReview>(Kind::AliasReview, &query).await {
        Ok(review) => Some(review),
        Err(error) => {
            tracing::warn!("the daily alias review could not be read: {error}");
            None
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    context: &str,
    receipt: Option<Receipt>,
    said: Option<Said<'_>>,
    refused: bool,
    evidence: Option<ObservationEvidence>,
) -> HtmlResult {
    let location = location(context);
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    // The run the address names is read beside the surface; the scope's state needs the scope the
    // surface names, so it follows.
    let (read, run, options) = tokio::join!(
        read(config, headers, &location, receipt.as_ref()),
        sync_run(&caller, context),
        source_options(config, headers, &location),
    );
    let read = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let (units, aliases) = tokio::join!(unit_states(&caller, &read), alias_review(&caller, &read.read_model.route_context));
    let screen = DailyScreen { read, manage: manages(viewer), run, units, options, aliases, evidence };
    let t: Cat = req.t();
    let p: Pilot = req.t();
    let view = html! {
        <super::views::DailyPage t={t} p={p} req={req} screen={&screen} context={context} said={said.as_ref()} />
    };
    let page = html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_integrations()} head="">{view}</crate::views::Layout>
    };
    if refused { req.page(page) } else { req.screen(&screen, page) }
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> HtmlResult {
    let receipt = Receipt::from_param(param(&uri, "after_write").as_deref());
    let said = param(&uri, "done").as_deref().and_then(Ran::of).map(Said::Ran);
    render(&req, &staff.viewer, &config, &headers, &context_of(&uri), receipt, said, false, None).await
}

/// A Source Observation's evidence sheet (admin-web's `SourceObservationEvidenceSheet`, which reads
/// it when the sheet opens): with the script, the sheet alone; without, the page the working set's
/// stages are drawn on (the scope's page its `home` names, or the daily workbench) with it open.
pub(crate) async fn evidence(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Evidence<'_>>,
) -> HtmlResult {
    let context = context_of(&uri);
    let caller = config.platform.caller(&headers, config.proto, None);
    let shown = read_evidence(&caller, &route.id).await;
    if req.mode == Mode::Action {
        let (t, p): (Cat, Pilot) = (req.t(), req.t());
        return req.patch(super::views::EvidenceSheet { t, p, evidence: Some(&shown), context: &context });
    }
    match context_value(&context, HOME).filter(|id| !id.is_empty()) {
        Some(id) => super::scope::with_evidence(&req, &staff.viewer, &config, &headers, &id, &context, shown).await,
        None => render(&req, &staff.viewer, &config, &headers, &context, None, None, false, Some(shown)).await,
    }
}

/// The observation's evidence, or none when the API has none for it or does not answer (admin-web's
/// sheet draws its error then, as here).
async fn read_evidence(caller: &Caller<'_>, id: &str) -> ObservationEvidence {
    let rest = format!("/{}/evidence", segment(id));
    match caller.read_at::<ObservationEvidence>(Kind::SourceObservations, &rest).await {
        Ok(evidence) => evidence,
        Err(error) => {
            tracing::warn!("a Source Observation's evidence could not be read: {error}");
            ObservationEvidence { observation_id: id.to_owned(), detail: None }
        }
    }
}

/// The redirect after a command the API accepted: the working set again with `set` changed, the
/// write's receipt and what it did.
fn landed(req: &Req, context: &str, set: &[(&str, Option<&str>)], written: &super::api::Written, ran: Ran) -> HtmlResult {
    let mut changes = set.to_vec();
    changes.push(("done", Some(ran.word())));
    let receipt = receipt(written);
    if let Some(receipt) = receipt.as_deref() {
        changes.push(("after_write", Some(receipt)));
    }
    let to = at(&home(context), &with_query(context, &changes));
    match Local::parse(&to) {
        Some(local) => req.redirect(&local),
        None => req.redirect(&url::Daily),
    }
}

/// A command's answer: the redirect to the working set, or the page with the API's refusal.
async fn answer(
    req: &Req,
    staff: &Staff<CatalogAccess>,
    config: &Shared,
    headers: &HeaderMap,
    context: &str,
    sent: Sent,
    ran: Ran,
) -> HtmlResult {
    let errors = match sent {
        Sent::Written(written) => return landed(req, context, &[], &written, ran),
        Sent::Refused(errors) => errors,
        Sent::Denied(denied) => return denied.answer(req),
    };
    // Without the runtime, a refusal is the page the command came from again with the API's
    // message: the scope's page its `home` names (as admin-web draws Scope Detail again), or the
    // daily workbench; with it, the message is patched in place on either page.
    let scope = context_value(context, HOME).filter(|id| !id.is_empty());
    let form = super::views::DailyRefusal { errors: &errors };
    req.invalid(&errors, form, || async {
        match &scope {
            Some(id) => super::scope::refused_in_workspace(req, &staff.viewer, config, headers, id, context, &errors).await,
            None => {
                let daily = with_query(context, &[(HOME, None)]);
                render(req, &staff.viewer, config, headers, &daily, None, Some(Said::Refused(&errors)), true, None).await
            }
        }
    })
    .await
}

/// The sync form: the scope as the read model has it, every unit the preview lists, and the
/// checked ones.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncInput {
    pub product_domain: String,
    pub product_form: String,
    pub language_code: String,
    pub reference_kind: String,
    pub scope_record_id: String,
    pub units: Vec<String>,
    pub selected: Vec<String>,
}

impl SyncInput {
    /// The API's `catalog-sync-scope-v2` scope (`catalogSyncScopeFromContext`): the checked units
    /// selected, every other unit the preview lists excluded.
    pub fn body(&self) -> Value {
        let mut selected: Vec<&str> = Vec::new();
        for unit in &self.selected {
            if !selected.contains(&unit.as_str()) {
                selected.push(unit);
            }
        }
        let mut excluded: Vec<&str> = Vec::new();
        for unit in &self.units {
            if !selected.contains(&unit.as_str()) && !excluded.contains(&unit.as_str()) {
                excluded.push(unit);
            }
        }
        json!({ "scope": {
            "scopeVersion": "catalog-sync-scope-v2",
            "productDomain": self.product_domain,
            "productForm": self.product_form,
            "languageCode": self.language_code,
            "reference": { "kind": self.reference_kind, "scopeRecordId": self.scope_record_id },
            "providerParticipation": { "requiredUnitKeys": [], "selectedUnitKeys": selected, "excludedUnitKeys": excluded },
        } })
    }
}

pub(crate) async fn sync(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<SyncInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let caller = config.platform.caller(&headers, config.proto, None);
    // The API answers the run it queued (or the active one it reuses); the working set names it as
    // its `jobId`, as admin-web's does, so the page lands on the run's progress.
    let sent = match caller.post_written::<Value>(Kind::SourceObservations, "/catalog-sync-scope/runs", &input.body()).await {
        Ok((run, written)) => {
            let id = run.get("syncRunId").and_then(Value::as_str);
            return landed(&req, &context, &[("jobId", id)], &written, Ran::Queued);
        }
        Err(error) => match crate::app::refused(error) {
            Ok(errors) => Sent::Refused(errors),
            Err(denied) => Sent::Denied(denied),
        },
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// A job's command: `retry`, `resume` or `cancel`.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct JobInput {
    pub command: String,
}

pub(crate) async fn job(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Job<'_>>,
    Form(input): Form<JobInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let Some(command_word) = ["retry", "resume", "cancel"].into_iter().find(|c| *c == input.command) else {
        let errors = super::not_offered(req.t());
        return answer(&req, &staff, &config, &headers, &context, Sent::Refused(errors), Ran::Queued).await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/integration-jobs{}", under(&route.id, &[command_word]));
    let sent = command(&caller, Method::POST, Kind::SourceObservations, &rest, None).await;
    let ran = if command_word == "cancel" { Ran::Cancelled } else { Ran::Queued };
    answer(&req, &staff, &config, &headers, &context, sent, ran).await
}

/// A workset unit's command: `import` (its Sync) or `reapply`, and the unit it runs for.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct UnitInput {
    pub unit: String,
    pub command: String,
}

impl UnitInput {
    /// The API's path and body for the unit's command, from the scopes the read model gave it;
    /// `None` for a command the row does not offer or a unit without scopes.
    pub fn command(&self, scopes: Option<&CommandScopes>) -> Option<(&'static str, Value)> {
        let scopes = scopes?;
        match self.command.as_str() {
            "import" => Some(("/integration-jobs", json!({ "action": "import", "scope": scopes.import }))),
            "reapply" => Some(("/reapply", json!({ "scope": scopes.reapply }))),
            _ => None,
        }
    }
}

/// The working set a unit's command lands on: the unit's own (its `currentWorkbenchHref`'s query,
/// where admin-web's row posts), keeping the page's `home`.
fn unit_landing(context: &str, href: &str) -> String {
    let query = href.split_once('?').map_or("", |(_, query)| query);
    let home = context_value(context, HOME);
    with_query(query, &[(HOME, home.as_deref().filter(|id| !id.is_empty()))])
}

pub(crate) async fn unit(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<UnitInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let caller = config.platform.caller(&headers, config.proto, None);
    // The body is the one the API built for the unit on this working set, read again rather than
    // taken from the form, so the pilot posts nothing it composed itself.
    let read = match read_with(&caller, &location(&context)).await {
        Ok(read) => read,
        Err(error) => return read_failed(&req, error, false),
    };
    let unit = read.read_model.source_scope_workset.units.iter().find(|unit| unit.key() == input.unit);
    let Some((rest, body)) = unit.and_then(|unit| input.command(unit.command_scopes.as_ref())) else {
        let errors = super::not_offered(req.t());
        return answer(&req, &staff, &config, &headers, &context, Sent::Refused(errors), Ran::Queued).await;
    };
    let landing = unit.map(|unit| unit_landing(&context, &unit.current_workbench_href)).unwrap_or_default();
    // Each answers the job it queued; the working set names it as its `jobId`, as admin-web's does.
    let sent = match caller.post_written::<Value>(Kind::SourceObservations, rest, &body).await {
        Ok((job, written)) => {
            let id = job.get("jobId").and_then(Value::as_str);
            return landed(&req, &landing, &[("jobId", id)], &written, Ran::Queued);
        }
        Err(error) => match crate::app::refused(error) {
            Ok(errors) => Sent::Refused(errors),
            Err(denied) => Sent::Denied(denied),
        },
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// The review form: `defer` or `reject`, the checked observations, and the reason a reject needs.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct ReviewInput {
    pub action: String,
    pub observation: Vec<String>,
    pub reason: String,
}

impl ReviewInput {
    /// The API's path and body: a defer with admin-web's reason, or a reject with the one typed.
    /// `None` for an action the form does not offer. The API refuses a reject without a reason
    /// and a defer without an observation.
    pub fn command(&self, t: Cat) -> Option<(&'static str, Value)> {
        match self.action.as_str() {
            "defer" => {
                Some(("/bulk-defer/jobs", json!({ "observationIds": self.observation, "reason": t.wb_review_defer_reason() })))
            }
            "reject" => Some(("/bulk-reject/jobs", json!({ "observationIds": self.observation, "reason": self.reason.trim() }))),
            _ => None,
        }
    }
}

pub(crate) async fn review(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<ReviewInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let t: Cat = req.t();
    // Nothing checked is sent as it is: the API refuses a defer or reject with no observations and
    // no scope (`selection_required`), and its reason is the form's.
    let sent = match input.command(t) {
        Some((rest, body)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            command(&caller, Method::POST, Kind::SourceObservations, rest, Some(&body)).await
        }
        None => Sent::Refused(super::not_offered(req.t())),
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// Preview promotion and Create or update Catalog Items (admin-web's `observation.promote`).
///
/// `phase` is `preview` (the create stage's: the checked observations, else the working set's
/// `selectedObservationIds`, else the scope where the API allows it), `preview-checked` (the review
/// bar's and the evidence sheet's: only the checked observations), `preview-unit` (a workset unit's,
/// on that unit's own working set and descriptor) or `execute` (the create stage's commit, with the
/// draft choice and the confirmation box).
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct PromotionInput {
    pub phase: String,
    pub observation: Vec<String>,
    pub draft: String,
    pub confirm: String,
    pub unit: String,
}

/// The most checked observations the address carries, as admin-web's (`MAX_URL_SELECTED_OBSERVATION_IDS`).
pub const MOST_SELECTED: usize = 50;

/// The working set's selection (`selectedObservationIds`, comma separated).
pub fn selected(context: &str) -> Vec<String> {
    context_value(context, "selectedObservationIds")
        .map(|csv| ids(std::slice::from_ref(&csv)).into_iter().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The promotion's body: the descriptor's confirmation and the draft choice, with the selection, or
/// the descriptor's scope when nothing is selected (`previewBulkPromoteSourceObservations`).
pub fn promotion_body(descriptor: &CommandPreview, selection: &[String], draft: bool) -> Value {
    let mut body = json!({ "promoteAsDraft": draft, "confirmation": descriptor.confirmation });
    if selection.is_empty() {
        body["scope"] = descriptor.scope.clone().unwrap_or(Value::Null);
    } else {
        body["observationIds"] = json!(selection);
    }
    body
}

pub(crate) async fn promotion(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<PromotionInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    // Without the held token, so the read does not preview again, and without the last job.
    let bare = with_query(&context, &[("promotionPreviewId", None), ("jobId", None)]);
    let refuse = |message: &str| {
        let mut errors = Errors::new();
        errors.add_form(message);
        Sent::Refused(errors)
    };
    let phase = input.phase.as_str();
    if !matches!(phase, "preview" | "preview-checked" | "preview-unit" | "execute") {
        return answer(&req, &staff, &config, &headers, &bare, Sent::Refused(super::not_offered(p)), Ran::Queued).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let read = match read_with(&caller, &location(&bare)).await {
        Ok(read) => read,
        Err(error) => return read_failed(&req, error, false),
    };
    // A unit's Preview runs on the unit's own working set with the descriptor the read built for that
    // unit (its `actions.previewPromotion`), never the selected unit's.
    let (descriptor, working) = if phase == "preview-unit" {
        let unit = read.read_model.source_scope_workset.units.iter().find(|unit| unit.key() == input.unit);
        let unit = unit.filter(|unit| unit.previewable() && unit.actions.preview_promotion.open());
        let descriptor = unit.and_then(|unit| unit.actions.preview_promotion.command_preview.as_ref());
        let working = unit.map(|unit| unit_landing(&bare, &unit.current_workbench_href)).unwrap_or_default();
        (descriptor, working)
    } else {
        let open = read.read_model.actions.iter().find(|a| a.key == "observation.promote").is_some_and(Action::open);
        (promotion_command(&read.read_model).filter(|_| open), bare.clone())
    };
    let Some(descriptor) = descriptor else {
        return answer(&req, &staff, &config, &headers, &bare, Sent::Refused(super::not_offered(p)), Ran::Queued).await;
    };
    let checked: Vec<String> = ids(&input.observation).into_iter().map(str::to_owned).collect();
    let selection = match phase {
        "preview-unit" => Vec::new(),
        "preview-checked" => checked,
        _ if checked.is_empty() => selected(&context),
        _ => checked,
    };
    if phase == "preview-checked" && selection.is_empty() {
        return answer(&req, &staff, &config, &headers, &bare, refuse(t.wb_review_bulk_preview_denied()), Ran::Queued).await;
    }
    if selection.is_empty() && !descriptor.allow_scope_selection {
        let sent = refuse(p.integrations_promotion_select());
        return answer(&req, &staff, &config, &headers, &bare, sent, Ran::Queued).await;
    }
    if selection.len() > MOST_SELECTED {
        let sent = refuse(&p.integrations_promotion_over_limit(MOST_SELECTED).to_string());
        return answer(&req, &staff, &config, &headers, &bare, sent, Ran::Queued).await;
    }
    let csv = selection.join(",");
    let csv = Some(csv.as_str()).filter(|csv| !csv.is_empty());
    let draft = input.draft == "true";
    if phase != "execute" {
        let body = promotion_body(descriptor, &selection, draft);
        let sent = match caller.post::<Value>(Kind::SourceObservations, "/bulk-promote/preview", &body).await {
            Ok(preview) => match preview.get("previewToken").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                Some(token) => {
                    let set = [
                        ("section", Some("promotion-preview")),
                        ("selectedObservationIds", csv),
                        ("promotionPreviewId", Some(token)),
                        ("promoteAsDraft", draft.then_some("true")),
                        ("jobId", None),
                    ];
                    let to = at(&home(&working), &with_query(&working, &set));
                    return match Local::parse(&to) {
                        Some(local) => req.redirect(&local),
                        None => req.redirect(&url::Daily),
                    };
                }
                // A first page's preview always carries a token; without one nothing can commit.
                None => refuse(p.integrations_promotion_preview_again()),
            },
            Err(error) => match crate::app::refused(error) {
                Ok(errors) => Sent::Refused(errors),
                Err(denied) => Sent::Denied(denied),
            },
        };
        return answer(&req, &staff, &config, &headers, &bare, sent, Ran::Queued).await;
    }
    // The commit presents the token the preview answered, with the selection and the draft choice
    // the address kept from it; a refusal drops the token, so the page asks for a preview again.
    let Some(token) = context_value(&context, "promotionPreviewId").filter(|t| !t.is_empty()) else {
        return answer(&req, &staff, &config, &headers, &bare, refuse(p.integrations_promotion_preview_again()), Ran::Queued)
            .await;
    };
    // The draft box sits in the commit's form: a choice other than the previewed one needs a new
    // preview, as admin-web's stage holds the commit back until one binds it.
    let previewed = context_value(&context, "promoteAsDraft").as_deref() == Some("true");
    if draft != previewed {
        let sent = refuse(t.wb_stage_create_preview_choice_changed());
        return answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await;
    }
    if input.confirm != "true" {
        return answer(&req, &staff, &config, &headers, &context, refuse(p.integrations_promotion_confirm()), Ran::Queued).await;
    }
    let mut body = promotion_body(descriptor, &selection, draft);
    body["previewToken"] = json!(token);
    let sent = match caller.post_written::<Value>(Kind::SourceObservations, "/bulk-promote/jobs", &body).await {
        Ok((job, written)) => {
            let id = job.get("jobId").and_then(Value::as_str);
            let set = [
                ("jobId", id),
                ("section", Some("promotion-result")),
                ("promotionPreviewId", None),
                ("promoteAsDraft", None),
                ("selectedObservationIds", None),
            ];
            return landed(&req, &context, &set, &written, Ran::Queued);
        }
        Err(error) => match crate::app::refused(error) {
            Ok(errors) => Sent::Refused(errors),
            Err(denied) => Sent::Denied(denied),
        },
    };
    answer(&req, &staff, &config, &headers, &bare, sent, Ran::Queued).await
}

/// The selection and confirmation the read model built for promoting observations, when it built one.
pub fn promotion_command(model: &Daily) -> Option<&CommandPreview> {
    let action = model.actions.iter().find(|a| a.key == "observation.promote")?;
    action.command_preview.as_ref().filter(|c| c.confirmation.is_some())
}

/// A merge candidate's command: `ignore`, `defer`, `split` or `update` (its edit). A split
/// and an edit name the candidate version the page read; the API applies them to the snapshot it
/// holds and refuses a version it has moved on from.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct CandidateInput {
    pub command: String,
    pub version: String,
    /// The observations a split takes off, as the API's split names them.
    pub split: Vec<String>,
    pub reason: String,
    /// The edit's fields (admin-web's `CatalogMergeCandidateEditForm`).
    pub intent: String,
    pub catalog_item_id: String,
    pub product_ids: String,
    /// Each fact the form shows: its key, the value typed, and the value it showed, so only a
    /// fact the operator changed becomes an override.
    pub fact_key: Vec<String>,
    pub fact_value: Vec<String>,
    pub fact_shown: Vec<String>,
    /// The indexes of the external references to drop.
    pub drop_catalog_ref: Vec<String>,
    pub drop_product_ref: Vec<String>,
}

/// The merge candidate commands the row's buttons send. Split and promote are each their own form
/// with the version the page read (a promote only once the API checks it against that version,
/// chase-sets/chase-sets#11143), and the edit is its dialog's.
pub const CANDIDATE_COMMANDS: [(&str, &str); 3] =
    [("candidate.ignore", "ignore"), ("candidate.defer", "defer"), ("candidate.split", "split")];

/// The promotion intents an edit offers, in admin-web's order.
pub const PROMOTION_INTENTS: [&str; 3] = ["create-catalog-item", "update-catalog-item", "link-existing-catalog-item"];

impl CandidateInput {
    /// The command's path segment and the API's body. An ignore or defer sends the reason
    /// admin-web sends for it (`candidateActionReason`); a split the reason the API built, or that
    /// one. `None` for a command the form does not offer, or a split or edit without the version
    /// it read.
    pub fn command(&self, t: Cat) -> Option<(&'static str, Value)> {
        let reason = |label: &str| t.wb_merge_action_reason(label).to_string();
        match self.command.as_str() {
            "ignore" => Some(("ignore", json!({ "reason": reason(t.wb_merge_action_ignore()) }))),
            "defer" => Some(("defer", json!({ "reason": reason(t.wb_merge_action_defer()) }))),
            "split" => {
                let version = self.version()?;
                let ids = ids(&self.split);
                if ids.is_empty() {
                    return None;
                }
                let typed = self.reason.trim();
                let reason = if typed.is_empty() { reason(t.wb_merge_action_split()) } else { typed.to_owned() };
                Some(("split", json!({ "reason": reason, "expectedVersion": version, "splitObservationIds": ids })))
            }
            "promote" => {
                let version = self.version()?;
                let typed = self.reason.trim();
                let reason = if typed.is_empty() { reason(t.wb_merge_action_promote()) } else { typed.to_owned() };
                // No conflict to resolve: the row offers Promote only without blocking conflicts.
                Some(("promote", json!({ "reason": reason, "expectedVersion": version, "conflictResolutions": [] })))
            }
            "update" => {
                let version = self.version()?;
                Some(("update", json!({ "reason": self.reason.trim(), "expectedVersion": version, "edit": self.edit() })))
            }
            _ => None,
        }
    }

    fn version(&self) -> Option<u64> {
        self.version.trim().parse().ok()
    }

    /// The edit (`catalogMergeCandidateEditRequestFromFormData`): the intent when it is one the
    /// form offers, the Catalog Item (none when blank), the Product ids, the facts changed from
    /// what the form showed, and the references to drop.
    fn edit(&self) -> Value {
        let overrides: Vec<Value> = self
            .fact_key
            .iter()
            .zip(&self.fact_value)
            .zip(&self.fact_shown)
            .filter(|((key, value), shown)| !key.is_empty() && value != shown)
            .map(|((key, value), _)| json!({ "key": key, "value": value }))
            .collect();
        let indexes = |checked: &[String]| -> Vec<u64> {
            let mut out: Vec<u64> = checked.iter().filter_map(|i| i.trim().parse().ok()).collect();
            out.sort_unstable();
            out.dedup();
            out
        };
        let mut edit = json!({
            "catalogItemId": Some(self.catalog_item_id.trim()).filter(|id| !id.is_empty()),
            "productIds": ids(std::slice::from_ref(&self.product_ids)),
            "factOverrides": overrides,
            "droppedExternalCatalogItemReferenceIndexes": indexes(&self.drop_catalog_ref),
            "droppedExternalProductReferenceIndexes": indexes(&self.drop_product_ref),
        });
        if PROMOTION_INTENTS.contains(&self.intent.as_str()) {
            edit["promotionIntent"] = json!(self.intent);
        }
        edit
    }
}

/// The ids in the values, each split at commas and trimmed, blanks and repeats left out.
fn ids(values: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for id in values.iter().flat_map(|v| v.split(',')).map(str::trim) {
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

pub(crate) async fn candidate(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::MergeCandidate<'_>>,
    Form(input): Form<CandidateInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let t: Cat = req.t();
    let sent = match input.command(t) {
        Some((word, body)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            let rest = format!("/admin/merge-candidates{}", under(&route.id, &[word]));
            match caller.command(Method::POST, Kind::SourceObservations, &rest, Some(&body)).await {
                Ok(written) => Sent::Written(written),
                // The candidate moved after the page read it (admin-web's `candidate-stale`).
                Err(error) if error.code() == Some("stale_merge_candidate") => {
                    let mut errors = Errors::new();
                    errors.add_form(t.feedback_candidate_stale());
                    Sent::Refused(errors)
                }
                Err(error) => match crate::app::refused(error) {
                    Ok(errors) => Sent::Refused(errors),
                    Err(denied) => Sent::Denied(denied),
                },
            }
        }
        None => Sent::Refused(super::not_offered(req.t())),
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// A source options control: `reload` (from the cache), `force-refresh` (one kind, live) or
/// `force-refresh-all`.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct OptionsInput {
    pub action: String,
    pub query_kind: String,
}

impl OptionsInput {
    /// The location's changes that ask for it (admin-web's `catalogPrimaryWorkbenchSourceOptionHref`),
    /// or none for an action the bar does not offer.
    pub fn intent(&self) -> Option<[(&'static str, Option<&str>); 2]> {
        let action = ["reload", "force-refresh", "force-refresh-all"].into_iter().find(|a| *a == self.action)?;
        let kind = self.query_kind.trim();
        let kind = (action != "force-refresh-all" && !kind.is_empty()).then_some(kind);
        Some([("sourceOptionAction", Some(action)), ("sourceOptionQueryKind", kind)])
    }
}

/// Reads the source options with the control's intent, then lands on the working set without it, so
/// reloading the page never asks the provider again (admin-web strips a Cards refresh's intent once
/// its read settles). The read is the API's; what it fetched is what the page reads next.
pub(crate) async fn source_options_refresh(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<OptionsInput>,
) -> HtmlResult {
    let context = context_of(&uri);
    let Some(intent) = input.intent() else {
        let errors = super::not_offered(req.t());
        return answer(&req, &staff, &config, &headers, &context, Sent::Refused(errors), Ran::Queued).await;
    };
    let location = at(url::Daily.href().as_str(), &with_query(&context, &intent));
    let rest = format!("/workbench-surfaces/daily/source-options?location={}", segment(&location));
    let caller = config.platform.caller(&headers, config.proto, None);
    let sent = match caller.read_at::<Value>(Kind::SourceObservations, &rest).await {
        Ok(_) => {
            let to = at(url::Daily.href().as_str(), &context);
            return match Local::parse(&to) {
                Some(local) => req.redirect(&local),
                None => req.redirect(&url::Daily),
            };
        }
        Err(error) => match crate::app::refused(error) {
            Ok(errors) => Sent::Refused(errors),
            Err(denied) => Sent::Denied(denied),
        },
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// An alias candidate's command from the review stage (admin-web posts the alias review's forms to
/// the daily route's action): the alias review's command, or for a defer nothing written; then the
/// working set again. One it cannot send is the page with the form's message.
pub(crate) async fn aliases(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Form(input): Form<crate::catalog::scope::url::AliasCommand>,
) -> HtmlResult {
    let context = context_of(&uri);
    let caller = config.platform.caller(&headers, config.proto, None);
    let query =
        alias_query(context_value(&context, "providerKey").as_deref(), context_value(&context, "profileVersion").as_deref());
    let sent = match crate::catalog::attention::alias_command_body(&caller, &input, &query).await {
        Ok(Some(body)) => command(&caller, Method::POST, Kind::AliasReview, "/commands", Some(&body)).await,
        Ok(None) => {
            let to = at(&home(&context), &with_query(&context, &[("done", Some(Ran::Queued.word()))]));
            return match Local::parse(&to) {
                Some(local) => req.redirect(&local),
                None => req.redirect(&url::Daily),
            };
        }
        Err(()) => Sent::Refused(super::not_offered(req.t())),
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(value: Value) -> Daily {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_stages_and_banners_are_the_read_models() {
        assert_eq!(open_stage(&Daily::default()), Stage::RunSync, "a model without a flow opens on Run sync");
        assert!(flow(&Daily::default()).is_empty());
        let m = model(json!({ "flow": { "openStage": "review-changes", "stages": [
            { "key": "run-sync", "state": "blocked" }, { "key": "review-changes", "state": "current" },
            { "key": "create-items", "state": "upcoming" }, { "key": "later", "state": "upcoming" }] },
            "dailyStatus": { "governance": "stopped", "health": "degraded" } }));
        assert_eq!(open_stage(&m), Stage::Review);
        assert_eq!(
            flow(&m),
            [(Stage::RunSync, StageState::Blocked), (Stage::Review, StageState::Current), (Stage::Create, StageState::Upcoming)],
            "a stage the page does not know is left out"
        );
        assert_eq!((governance(&m), health(&m)), (Some(Governance::Stopped), Some(Health::Degraded)));
        assert_eq!((governance(&Daily::default()), health(&Daily::default())), (None, None));
    }

    #[test]
    fn a_daily_link_is_drawn_on_the_page_the_working_set_draws_its_stages_on() {
        let href = "/catalog/integrations?providerKey=tcgplayer&reviewOffset=25&section=source-observation-review";
        assert_eq!(rebase("providerKey=tcgplayer", href).as_deref(), Some(href));
        let scope = crate::catalog::scope::url::ScopePage::of("scp_paf").href().to_string();
        assert_eq!(
            rebase("providerKey=tcgplayer&home=scp_paf", href),
            Some(format!("{scope}?providerKey=tcgplayer&reviewOffset=25&section=source-observation-review&home=scp_paf"))
        );
        assert_eq!(rebase("", "https://example.test/catalog/integrations?x=1"), None, "only the daily route's");
    }

    #[test]
    fn a_query_keeps_its_other_pairs_in_order_and_drops_a_commands_outcome() {
        let context = "providerKey=tcgplayer&filter.status=observed&reviewOffset=25";
        assert_eq!(
            with_query(context, &[("reviewOffset", Some("50"))]),
            "providerKey=tcgplayer&filter.status=observed&reviewOffset=50"
        );
        assert_eq!(with_query(context, &[("filter.status", None), ("reviewOffset", None)]), "providerKey=tcgplayer");
        assert_eq!(with_query("", &[("filter.status", Some("a b"))]), "filter.status=a%20b");
        let uri: Uri = "/catalog/integrations?providerKey=x&after_write=r1&done=queued".parse().unwrap();
        assert_eq!(context_of(&uri), "providerKey=x");
        assert_eq!(param(&uri, "done").as_deref(), Some("queued"));
        let receipt: Uri = format!("/catalog/integrations?after_write={}", segment(r#"{"a": 1}"#)).parse().unwrap();
        assert_eq!(param(&receipt, "after_write").as_deref(), Some(r#"{"a": 1}"#), "the receipt as it was written");
        assert_eq!(at("/catalog/integrations", ""), "/catalog/integrations");
    }

    #[test]
    fn the_sync_selects_the_checked_units_and_excludes_the_rest() {
        let input = SyncInput {
            product_domain: "pokemon".into(),
            product_form: "card".into(),
            language_code: "en".into(),
            reference_kind: "expansion".into(),
            scope_record_id: "sr_1".into(),
            units: vec!["a".into(), "b".into(), "c".into()],
            selected: vec!["a".into(), "a".into()],
        };
        let body = input.body();
        assert_eq!(body["scope"]["providerParticipation"]["selectedUnitKeys"], json!(["a"]));
        assert_eq!(body["scope"]["providerParticipation"]["excludedUnitKeys"], json!(["b", "c"]));
        assert_eq!(body["scope"]["reference"], json!({ "kind": "expansion", "scopeRecordId": "sr_1" }));
    }

    #[test]
    fn a_defer_sends_admin_webs_reason_and_a_reject_the_one_typed() {
        let t = Cat::default();
        let input = |action: &str, reason: &str| ReviewInput {
            action: action.into(),
            observation: vec!["o1".into()],
            reason: reason.into(),
        };
        let (path, body) = input("defer", "").command(t).unwrap();
        assert_eq!(path, "/bulk-defer/jobs");
        assert_eq!(body["reason"], "Deferred from the primary workbench; observation remains in review.");
        let (path, body) = input("reject", " dupe ").command(t).unwrap();
        assert_eq!((path, body["reason"].as_str()), ("/bulk-reject/jobs", Some("dupe")));
        assert!(input("promote", "").command(t).is_none(), "promotion stays on admin-web");
    }
}
