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
//! | `POST /catalog/integrations/review?<context>` | defers or rejects the checked Source Observations |
//! | `POST /catalog/integrations/candidates/{id}?<context>` | ignores or defers a merge candidate |
//! | `POST /catalog/integrations/aliases?<context>` | accepts, rejects, revokes or defers alias candidates |
//!
//! The context is the address's query as admin-web names it (`providerKey`, `unitKey`,
//! `importScope`, `filter.status`, `reviewOffset` and the rest); the pilot passes it to the API
//! as the surface's location without reading it, and every command's form carries it so its
//! redirect lands on the same working set. A command's body is the API's own
//! (`POST /source-observations/catalog-sync-scope/runs`, `.../integration-jobs/{id}/{command}`,
//! `.../bulk-defer/jobs`, `.../bulk-reject/jobs`, `.../admin/merge-candidates/{id}/{ignore,defer}`); the API
//! decides what each allows.
//!
//! Preview and promote stay on admin-web: the API does not yet refuse a stale preview itself
//! (chase-sets/chase-sets#11045), so the pilot does not send a promotion. Merge candidate edits and
//! splits open on admin-web until the API applies them to the stored snapshot rather than storing the
//! page's (chase-sets/chase-sets#11078); the evidence sheets until the API serves their detail
//! (chase-sets/chase-sets#11079); and the import preview until the API builds its scope
//! (chase-sets/chase-sets#11082).
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
//! Workaround (chase-sets/chase-sets#11047): the read model does not carry the stages' states, the
//! open stage, the governance and health banners or the review queue's pager and filter links, so
//! `open_stage`, `flow`, `blockers`, `governance`, `health` and `with_query` copy admin-web's
//! rules for them. Remove them when the API returns those fields.
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

    /// Defers or rejects the checked Source Observations.
    #[route("/catalog/integrations/review", post = crate::catalog::daily::review)]
    pub struct Review;

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
/// opens, as admin-web's path; its `commandContext` is left unread, since the pilot does not send
/// its commands (chase-sets/chase-sets#11082).
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
    pub pagination: Pagination,
    pub rows: Vec<ReviewRow>,
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
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Readied {
    pub state: String,
    pub blockers: Vec<String>,
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
    pub preview_id: Option<String>,
    pub blockers: Vec<String>,
    pub destructive_count: u64,
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

/// The stage the read model opens on: the route's section, else the first stage with work.
/// Workaround (chase-sets/chase-sets#11047): admin-web's `routeTargetStage` and
/// `serverDerivedActiveStage`.
pub fn open_stage(model: &Daily) -> Stage {
    match model.route_context.section.as_str() {
        "import-jobs" | "provider-scope-selection" | "readiness" => return Stage::RunSync,
        "source-observation-review" | "conflict-resolution" => return Stage::Review,
        "promotion-preview" | "promotion-result" => return Stage::Create,
        _ => {}
    }
    let review = &model.source_observation_review;
    if model.promotion_result.is_some() || model.promotion_preview.preview_id.is_some() {
        Stage::Create
    } else if !review.rows.is_empty() || review.promotion_ready_count > 0 || review.counts.changed > 0 {
        Stage::Review
    } else {
        Stage::RunSync
    }
}

/// Each stage's state, with `open` current. Workaround (chase-sets/chase-sets#11047): admin-web's
/// `buildFlowStages`.
pub fn flow(model: &Daily, open: Stage) -> [(Stage, StageState); 3] {
    let review = &model.source_observation_review;
    let sync_done = !model.import_jobs.jobs.is_empty() || review.counts.changed > 0;
    let create_done = model.promotion_result.is_some();
    let blocked = |stage: Stage| match stage {
        Stage::RunSync => !model.readiness.blockers.is_empty(),
        Stage::Review => false,
        Stage::Create => !model.promotion_preview.blockers.is_empty(),
    };
    let done = |stage: Stage| match stage {
        Stage::RunSync => sync_done,
        Stage::Review => review.promotion_ready_count == 0 && (create_done || sync_done),
        Stage::Create => create_done,
    };
    let at = |stage: Stage| Stage::ALL.iter().position(|s| *s == stage).unwrap_or(0);
    Stage::ALL.map(|stage| {
        let state = if blocked(stage) {
            StageState::Blocked
        } else if stage == open {
            StageState::Current
        } else if at(stage) < at(open) || done(stage) {
            StageState::Complete
        } else {
            StageState::Upcoming
        };
        (stage, state)
    })
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

/// Whether a primary command is denied (access) or stopped (a rollout control), denial first.
/// Workaround (chase-sets/chase-sets#11047): admin-web's `catalogDailyGovernanceStatus`.
pub fn governance(model: &Daily) -> Option<Governance> {
    let all = blockers(model);
    let has = |names: &[&str]| names.iter().any(|n| all.contains(n));
    if !model.readiness.rbac_allowed
        || model.actions.iter().any(|a| a.state == "denied")
        || has(&["permission-denied", "authorization-denied", "rbac-missing"])
    {
        Some(Governance::Denied)
    } else if !model.readiness.rollout_enabled || has(&["rollout-disabled", "kill-switch-active"]) {
        Some(Governance::Stopped)
    } else {
        None
    }
}

/// Whether the working set's health is blocked or degraded. Workaround
/// (chase-sets/chase-sets#11047): admin-web's `catalogDailyHealthStatus`.
pub fn health(model: &Daily) -> Option<Health> {
    let transport = &model.readiness.provider_transport;
    if transport.iter().any(|t| matches!(t.as_str(), "timeout" | "pagination-failure" | "degraded-provider")) {
        Some(Health::Blocked)
    } else if !transport.is_empty() || model.readiness.freshness != "fresh" || model.import_jobs.failed_job_count > 0 {
        Some(Health::Degraded)
    } else {
        None
    }
}

/// The query `context` with each named key set to its value, or removed for `None`, keeping the
/// rest in order. Workaround (chase-sets/chase-sets#11047): admin-web builds the pager's and the
/// status filter's links from its route context; the read model carries none.
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

/// The daily surface's location for the working set: the daily route with its query, less the
/// pilot's `home`.
pub fn location(context: &str) -> String {
    at(url::Daily.href().as_str(), &with_query(context, &[(HOME, None)]))
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
    Some(DailyScreen { read, manage, run, units, options: None, aliases: None })
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
    let screen = DailyScreen { read, manage: manages(viewer), run, units, options, aliases };
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
    render(&req, &staff.viewer, &config, &headers, &context_of(&uri), receipt, said, false).await
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
    // Without the runtime, a refusal from a scope's page is the daily workbench of the same working
    // set with the API's message (admin-web draws the scope's page again); with it, the message
    // is patched in place on either page.
    let daily = with_query(context, &[(HOME, None)]);
    let form = super::views::DailyRefusal { errors: &errors };
    req.invalid(&errors, form, || render(req, &staff.viewer, config, headers, &daily, None, Some(Said::Refused(&errors)), true))
        .await
}

/// The sync form: the scope as the read model has it, every unit the preview lists, and the
/// checked ones.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
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
#[derive(Clone, Debug, Default, Deserialize, Fields)]
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

/// The review form: `defer` or `reject`, the checked observations, and the reason a reject needs.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ReviewInput {
    pub action: String,
    pub observation: Vec<String>,
    pub reason: String,
}

impl ReviewInput {
    /// The API's path and body: a defer with admin-web's reason, or a reject with the one typed.
    /// `None` for an action the form does not offer. The API refuses a reject without a reason
    /// and either without an observation.
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
    let sent = match input.command(t) {
        Some((rest, body)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            command(&caller, Method::POST, Kind::SourceObservations, rest, Some(&body)).await
        }
        None => Sent::Refused(super::not_offered(req.t())),
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// A merge candidate's command: `ignore` or `defer`.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct CandidateInput {
    pub command: String,
}

/// The merge candidate commands the pilot sends; promote, edit and split stay on admin-web.
pub const CANDIDATE_COMMANDS: [(&str, &str); 2] = [("candidate.ignore", "ignore"), ("candidate.defer", "defer")];

impl CandidateInput {
    /// The command's path segment and the API's body: the reason admin-web sends for it
    /// (`candidateActionReason`). `None` for a command the form does not offer.
    pub fn command(&self, t: Cat) -> Option<(&'static str, Value)> {
        let (word, label) = match self.command.as_str() {
            "ignore" => ("ignore", t.wb_merge_action_ignore()),
            "defer" => ("defer", t.wb_merge_action_defer()),
            _ => return None,
        };
        Some((word, json!({ "reason": t.wb_merge_action_reason(label).to_string() })))
    }
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
            command(&caller, Method::POST, Kind::SourceObservations, &rest, Some(&body)).await
        }
        None => Sent::Refused(super::not_offered(req.t())),
    };
    answer(&req, &staff, &config, &headers, &context, sent, Ran::Queued).await
}

/// A source options control: `reload` (from the cache), `force-refresh` (one kind, live) or
/// `force-refresh-all`.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
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
    fn the_open_stage_follows_the_section_then_the_work_as_admin_web_picks_it() {
        assert_eq!(open_stage(&Daily::default()), Stage::RunSync);
        let changed = model(json!({ "sourceObservationReview": { "counts": { "changed": 2 } } }));
        assert_eq!(open_stage(&changed), Stage::Review);
        let previewed = model(json!({ "promotionPreview": { "previewId": "p1" } }));
        assert_eq!(open_stage(&previewed), Stage::Create);
        let jobs = model(json!({ "routeContext": { "section": "import-jobs" }, "promotionPreview": { "previewId": "p1" } }));
        assert_eq!(open_stage(&jobs), Stage::RunSync, "the route's section first");
    }

    #[test]
    fn a_stage_is_blocked_by_its_blockers_and_done_behind_the_open_one() {
        let m = model(json!({ "readiness": { "blockers": ["provider-selection-required"] },
            "sourceObservationReview": { "counts": { "changed": 1 }, "promotionReadyCount": 3 } }));
        let states: Vec<_> = flow(&m, open_stage(&m)).into_iter().map(|(_, s)| s).collect();
        assert_eq!(states, [StageState::Blocked, StageState::Current, StageState::Upcoming]);
        let done = model(json!({ "importJobs": { "jobs": [{ "jobId": "j" }] }, "promotionResult": { "resultId": "r" } }));
        let states: Vec<_> = flow(&done, Stage::Create).into_iter().map(|(_, s)| s).collect();
        assert_eq!(states, [StageState::Complete, StageState::Complete, StageState::Current]);
    }

    #[test]
    fn denial_comes_before_a_stop_and_a_blocking_transport_before_degradation() {
        assert_eq!(governance(&Daily::default()), None);
        let stopped = model(json!({ "readiness": { "blockers": ["kill-switch-active"] } }));
        assert_eq!(governance(&stopped), Some(Governance::Stopped));
        let both = model(json!({ "readiness": { "rolloutEnabled": false, "rbacAllowed": false } }));
        assert_eq!(governance(&both), Some(Governance::Denied));
        let denied = model(json!({ "actions": [{ "key": "scope.sync", "state": "denied" }] }));
        assert_eq!(governance(&denied), Some(Governance::Denied));
        assert_eq!(health(&Daily::default()), None);
        let stale = model(json!({ "readiness": { "freshness": "stale" } }));
        assert_eq!(health(&stale), Some(Health::Degraded));
        let failed = model(json!({ "importJobs": { "failedJobCount": 1 } }));
        assert_eq!(health(&failed), Some(Health::Degraded));
        let timeout = model(json!({ "readiness": { "providerTransport": ["throttle", "timeout"] } }));
        assert_eq!(health(&timeout), Some(Health::Blocked));
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
