//! Catalog > Providers, provider detail (admin-web's `/catalog/providers/{providerKey}`,
//! `CatalogProviderDetailPage`): one provider's identity and transport readiness, its source-option
//! refresh schedule, the selected profile's evidence and its draft, the version history with
//! rollback, deprecate and retire, the units it takes part in and its recent jobs. It reads the
//! Catalog API's composed health surface
//! (`GET /api/catalog/source-observations/workbench-surfaces/health?location=`,
//! chase-sets/chase-sets#10507), which computes every slice the page draws, as the signed-in staff
//! member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/providers/{key}?<context>&after_write&done` | the page for the context, after the command the address names |
//! | `POST /catalog/providers/{key}/refresh?<context>` | pauses, resumes or runs the provider's source-option refresh |
//! | `POST /catalog/providers/{key}/draft?<context>` | creates a draft from the selected profile version |
//! | `POST /catalog/providers/{key}/lifecycle?<context>` | rolls back, deprecates or retires a profile version |
//! | `POST /catalog/providers/{key}/jobs/{id}?<context>` | retries, resumes or cancels an import job |
//! | `POST /catalog/providers/{key}/evidence?<context>` | records migration evidence ([`super::validation`]) |
//! | `POST /catalog/providers/{key}/activate?<context>` | activates a profile version ([`super::validation`]) |
//!
//! The context is the address's query as admin-web names it (`profileVersion`, `unitKey`,
//! `jobId`); the pilot passes it to the API without reading it. A command's body is the API's own
//! (`.../refresh-schedule/{key}/{command}`, `.../provider-profiles/{key}/{version}/clone`,
//! `.../{rollback|deprecate|retire}`, `.../integration-jobs/{id}/{command}`); the API decides what
//! each allows. A refusal is drawn on the page, and so is a refresh run that failed
//! (chase-sets/chase-sets#11051: admin-web drops both).
//!
//! Validation readiness (provider readiness, fixtures, dry runs, semantic compare, activation
//! readiness and the activation decision) is drawn from the same read ([`super::validation`]).
//! Profile section editing and the Operator session section open on admin-web.
//!
//! Workarounds, each to remove when its issue lands:
//! 1. chase-sets/chase-sets#11050: the surface read takes the provider only from the location's
//!    query, so `location` adds `providerKey`; the read carries no refresh schedule, so `schedule`
//!    lists every provider's and keeps this one; and who is offered the Operator session section
//!    (`operator_session`) is copied from admin-web's loader.
//! 2. chase-sets/chase-sets#11049: the API's lifecycle commands take no confirmation, so
//!    `LifecycleInput::confirmed` checks the one the form carries before the pilot sends one.
use corten::{
    Local,
    http::{HeaderMap, StatusCode, Uri},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Sent,
    api::{Catalog as _, Kind, List, Written, under},
    command,
    daily::{self, ImportJobs, Readiness, at, with_query},
    integrations::{HealthProvider, HealthUnit},
    manages, receipt,
};
use crate::{
    api::{Method, segment},
    app::{Shared, read_failed, refused},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    /// A provider's page.
    #[route("/catalog/providers/{key}", get = crate::catalog::provider::page)]
    pub struct Provider<'a> {
        pub key: &'a str,
    }

    /// Pauses, resumes or runs the provider's source-option refresh.
    #[route("/catalog/providers/{key}/refresh", post = crate::catalog::provider::refresh)]
    pub struct Refresh<'a> {
        pub key: &'a str,
    }

    /// Creates a draft from the selected profile version.
    #[route("/catalog/providers/{key}/draft", post = crate::catalog::provider::draft)]
    pub struct Draft<'a> {
        pub key: &'a str,
    }

    /// Rolls back, deprecates or retires a profile version.
    #[route("/catalog/providers/{key}/lifecycle", post = crate::catalog::provider::lifecycle)]
    pub struct Lifecycle<'a> {
        pub key: &'a str,
    }

    /// Records migration evidence on the activation decision's profile version.
    #[route("/catalog/providers/{key}/evidence", post = crate::catalog::validation::evidence)]
    pub struct Evidence<'a> {
        pub key: &'a str,
    }

    /// Activates the activation decision's profile version.
    #[route("/catalog/providers/{key}/activate", post = crate::catalog::validation::activate)]
    pub struct Activate<'a> {
        pub key: &'a str,
    }

    /// Retries, resumes or cancels one of the provider's import jobs.
    #[route("/catalog/providers/{key}/jobs/{id}", post = crate::catalog::provider::job)]
    pub struct Job<'a> {
        pub key: &'a str,
        pub id: &'a str,
    }
}

/// What a command did, for the page it redirects to (admin-web's command feedback).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    Paused,
    Resumed,
    Ran,
    Drafted,
    RolledBack,
    Deprecated,
    Retired,
    Queued,
    Cancelled,
    EvidenceSaved,
    Activated,
}

impl Done {
    pub const ALL: [(Done, &'static str); 11] = [
        (Done::Paused, "paused"),
        (Done::Resumed, "resumed"),
        (Done::Ran, "ran"),
        (Done::Drafted, "drafted"),
        (Done::RolledBack, "rolled-back"),
        (Done::Deprecated, "deprecated"),
        (Done::Retired, "retired"),
        (Done::Queued, "queued"),
        (Done::Cancelled, "cancelled"),
        (Done::EvidenceSaved, "evidence-saved"),
        (Done::Activated, "activated"),
    ];

    pub fn word(self) -> &'static str {
        Done::ALL.iter().find(|(done, _)| *done == self).map_or("", |(_, word)| word)
    }

    pub fn of(word: &str) -> Option<Done> {
        Done::ALL.iter().find(|(_, w)| *w == word).map(|(done, _)| *done)
    }
}

/// The surface the API composed for the provider's location.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderRead {
    pub read_model: Model,
    pub read_model_failures: Vec<String>,
}

/// `CatalogPrimaryWorkbenchReadModel`, the slices provider detail draws.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Model {
    pub generated_at: Option<String>,
    pub route_context: RouteContext,
    pub readiness: Readiness,
    pub health_triage: Triage,
    pub provider_scope: ProviderScope,
    pub profile_authoring: Authoring,
    pub lifecycle_recovery: Recovery,
    pub import_jobs: ImportJobs,
    pub validation_readiness: super::validation::Validation,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RouteContext {
    pub provider_key: Option<String>,
    pub unit_key: Option<String>,
    pub job_id: Option<String>,
    pub profile_version: Option<String>,
}

/// The health triage's providers and units, for the header and the units.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Triage {
    pub freshness: String,
    pub generated_at: Option<String>,
    pub providers: Vec<HealthProvider>,
    pub units: Vec<HealthUnit>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct ProviderScope {
    pub providers: Vec<ScopeProvider>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeProvider {
    pub provider_key: String,
    pub units: Vec<ScopeUnit>,
}

/// A unit the provider takes part in, with its scopes and active profile.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeUnit {
    pub unit_key: String,
    pub product_domain: String,
    pub product_form: String,
    pub import_scopes: Vec<String>,
    pub active_profile: Option<ActiveProfile>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ActiveProfile {
    pub profile_version: String,
}

/// `profileAuthoring`: the selected profile, its draft, and its section workspaces (counted here;
/// they are edited on admin-web).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Authoring {
    pub selected_profile: Option<Profile>,
    pub clone_draft: CloneDraft,
    pub section_workspaces: Vec<Value>,
}

/// The selected profile version (`ProfileOverview`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub provider_key: String,
    pub profile_key: String,
    pub profile_version: String,
    pub display_name: String,
    pub lifecycle: String,
    pub active: bool,
    pub connector_kind: String,
    pub capabilities: Vec<String>,
    pub supported_scopes: Vec<String>,
    pub language_options: Vec<String>,
    pub mapping_output_kind: String,
    pub has_executable_mapping_contract: bool,
    pub mapping_fingerprint: Option<String>,
    pub source_contract: SourceContract,
    pub fixtures: Fixtures,
    pub validation: ProfileValidation,
    pub migration_evidence: MigrationEvidence,
    pub authoring_audit: AuthoringAudit,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceContract {
    pub owner: String,
    pub repository: Option<String>,
    pub fixture_set_version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Fixtures {
    pub fixture_root: String,
    pub covered_flows: Vec<String>,
    pub live_provider_calls_allowed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileValidation {
    pub status: String,
    pub latest_diagnostic_text: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct MigrationEvidence {
    pub state: String,
    pub recorded_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuthoringAudit {
    pub created_at: Option<String>,
    pub created_by_user_id: Option<String>,
    pub updated_at: Option<String>,
    pub updated_by_user_id: Option<String>,
}

/// The draft the selected version can become (`cloneDraft`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct CloneDraft {
    pub source_provider_key: Option<String>,
    pub source_profile_version: Option<String>,
    pub target_profile_version: Option<String>,
    pub state: String,
    pub blockers: Vec<String>,
}

impl CloneDraft {
    /// admin-web's `cloneDisabled`, negated: a draft can be made when the API says it is available
    /// or degraded.
    pub fn open(&self) -> bool {
        self.state == "available" || self.state == "degraded"
    }
}

/// `lifecycleRecovery`: the version history and its rollback, deprecate and retire.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Recovery {
    pub freshness: String,
    pub summary: RecoverySummary,
    pub profiles: Vec<Version>,
    pub operations: Vec<Operation>,
    pub recent_audit_events: Vec<AuditEvent>,
    pub strict_retirement: StrictRetirement,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RecoverySummary {
    pub active_jobs: u64,
    pub affected_references: u64,
    pub downstream_profile_references: u64,
    pub impacted_catalog_items: u64,
    pub blockers: u64,
}

/// A row of the version history.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Version {
    pub provider_key: String,
    pub profile_key: String,
    pub profile_version: String,
    pub display_name: String,
    pub lifecycle: String,
    pub active: bool,
    pub reference_count: u64,
    pub href: String,
}

/// A lifecycle operation on the selected version, with its state and impact.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Operation {
    pub operation: String,
    pub label: String,
    pub description: String,
    pub command_key: String,
    pub provider_key: Option<String>,
    pub profile_version: Option<String>,
    pub lifecycle: Option<String>,
    pub active: bool,
    pub state: String,
    pub blockers: Vec<String>,
    pub impact: Impact,
}

impl Operation {
    /// admin-web's `isActionAvailable`.
    pub fn open(&self) -> bool {
        self.state == "available" || self.state == "degraded"
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Impact {
    pub referenced_observation_count: u64,
    pub impacted_catalog_item_count: u64,
    pub external_reference_count: u64,
    pub sample_observation_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditEvent {
    pub event_name: String,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct StrictRetirement {
    pub required_disposition: String,
    pub forbidden_support_paths: Vec<String>,
}

/// A provider's source-option refresh schedule (`ProviderRefreshScheduleRecord`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Schedule {
    pub provider_key: String,
    pub schedule_enabled: bool,
    pub manual_only: bool,
    pub interval_ms: u64,
    pub paused: bool,
    pub next_run_at: Option<String>,
    pub last_run_completed_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_error: Option<String>,
}

impl Schedule {
    /// Whether the schedule runs on its own (admin-web's `scheduledActive`).
    pub fn scheduled(&self) -> bool {
        self.schedule_enabled && !self.manual_only && !self.paused
    }

    /// Whether Pause or Resume is offered: a manual-only or disabled schedule has neither.
    pub fn pausable(&self) -> bool {
        self.schedule_enabled && !self.manual_only
    }
}

/// What the page draws: the provider, the read model, its refresh schedule (none when it could not
/// be read), whether the viewer may run the commands, and whether the Operator session section
/// is offered.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct ProviderScreen {
    pub key: String,
    pub read: ProviderRead,
    pub schedule: Option<Vec<Schedule>>,
    pub manage: bool,
    pub operator_session: bool,
}

/// What the page says at its top: a command's outcome, or its refusal.
pub enum Said<'a> {
    Done(Done),
    Refused(&'a Errors),
}

/// The API's location for the provider's page: the path and the context, with the provider in
/// the query unless the context names one (workaround, chase-sets/chase-sets#11050).
pub fn location(key: &str, context: &str) -> String {
    let path = url::Provider { key }.href().to_string();
    let named = context.split('&').any(|pair| pair.split('=').next() == Some("providerKey"));
    if named { at(&path, context) } else { at(&path, &with_query(context, &[("providerKey", Some(key))])) }
}

/// Who is offered the Operator session section: a platform admin on TCGplayer (admin-web's
/// `loadOperatorSessionActorKey`; workaround, chase-sets/chase-sets#11050).
pub fn operator_session(role_key: &str, key: &str) -> bool {
    key == "tcgplayer" && role_key == "platform-admin"
}

async fn read(
    config: &Shared,
    headers: &HeaderMap,
    location: &str,
    receipt: Option<&Receipt>,
) -> Result<ProviderRead, crate::api::ApiError> {
    let rest = format!("/workbench-surfaces/health?location={}", segment(location));
    config.platform.caller(headers, config.proto, receipt).read_at::<ProviderRead>(Kind::SourceObservations, &rest).await
}

/// The provider's refresh schedule: every provider's, this one kept (workaround,
/// chase-sets/chase-sets#11050). None when the API could not answer, so the panel is not drawn,
/// as on admin-web.
async fn schedule(config: &Shared, headers: &HeaderMap, key: &str) -> Option<Vec<Schedule>> {
    let caller = config.platform.caller(headers, config.proto, None);
    let all = caller.read_at::<List<Schedule>>(Kind::ProviderScopeDiscovery, "/refresh-schedule").await.ok()?;
    Some(all.items.into_iter().filter(|s| s.provider_key == key).collect())
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
    key: &str,
    context: &str,
    receipt: Option<Receipt>,
    said: Option<Said<'_>>,
    refused: bool,
) -> HtmlResult {
    let location = location(key, context);
    let (read, schedule) = tokio::join!(read(config, headers, &location, receipt.as_ref()), schedule(config, headers, key));
    let read = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = ProviderScreen {
        key: key.to_owned(),
        read,
        schedule,
        manage: manages(viewer),
        operator_session: operator_session(&viewer.role_key, key),
    };
    let t: Cat = req.t();
    let p: Pilot = req.t();
    let view = html! {
        <super::views::ProviderPage t={t} p={p} req={req} screen={&screen} context={context} said={said.as_ref()} />
    };
    let page = html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_provider()} head="">{view}</crate::views::Layout>
    };
    if refused { req.page(page) } else { req.screen(&screen, page) }
}

/// A query value the address carries (the last command's receipt and outcome), decoded.
fn param(uri: &Uri, key: &str) -> Option<String> {
    let raw = uri.query()?.split('&').find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))?;
    Some(percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Provider<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(param(&uri, "after_write").as_deref());
    let said = param(&uri, "done").as_deref().and_then(Done::of).map(Said::Done);
    let context = daily::context_of(&uri);
    render(&req, &staff.viewer, &config, &headers, &route.key, &context, receipt, said, false).await
}

/// The redirect after a command the API accepted: the page again with the write's receipt and
/// what it did, the context changed as `changes` says (the version a draft or a lifecycle command
/// selects, the job a job command ran).
fn landed(
    req: &Req,
    key: &str,
    context: &str,
    changes: &[(&str, Option<&str>)],
    written: Option<&Written>,
    done: Done,
) -> HtmlResult {
    let mut all: Vec<(&str, Option<&str>)> = changes.to_vec();
    all.push(("done", Some(done.word())));
    let receipt = written.and_then(receipt);
    if let Some(receipt) = receipt.as_deref() {
        all.push(("after_write", Some(receipt)));
    }
    let to = at(&url::Provider { key }.href().to_string(), &with_query(context, &all));
    match Local::parse(&to) {
        Some(local) => req.redirect(&local),
        None => req.redirect(&url::Provider { key }),
    }
}

/// A refused command: the page with the API's words (or the pilot's), patched in place with
/// JavaScript.
pub(super) async fn again(
    req: &Req,
    staff: &Staff<CatalogAccess>,
    config: &Shared,
    headers: &HeaderMap,
    key: &str,
    context: &str,
    errors: Errors,
) -> HtmlResult {
    let form = super::views::ProviderRefusal { errors: &errors };
    req.invalid(&errors, form, || {
        render(req, &staff.viewer, config, headers, key, context, None, Some(Said::Refused(&errors)), true)
    })
    .await
}

/// A command's answer: the redirect to the page, or the page with the API's refusal.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
pub(super) async fn answer(
    req: &Req,
    staff: &Staff<CatalogAccess>,
    config: &Shared,
    headers: &HeaderMap,
    key: &str,
    context: &str,
    sent: Sent,
    changes: &[(&str, Option<&str>)],
    done: Done,
) -> HtmlResult {
    match sent {
        Sent::Written(written) => landed(req, key, context, changes, Some(&written), done),
        Sent::Refused(errors) => again(req, staff, config, headers, key, context, errors).await,
        Sent::Denied(denied) => denied.answer(req),
    }
}

/// What a failed call to the API came to.
fn sent_of(error: crate::api::ApiError) -> Sent {
    match refused(error) {
        Ok(errors) => Sent::Refused(errors),
        Err(denied) => Sent::Denied(denied),
    }
}

/// The refresh form: `pause`, `resume` or `run`.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct RefreshInput {
    pub command: String,
}

pub(crate) async fn refresh(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Refresh<'_>>,
    Form(input): Form<RefreshInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let p: Pilot = req.t();
    let done = match input.command.as_str() {
        "pause" => Done::Paused,
        "resume" => Done::Resumed,
        "run" => Done::Ran,
        _ => return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(p)).await,
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/refresh-schedule{}", under(&route.key, &[input.command.as_str()]));
    let sent = match caller.command(Method::POST, Kind::ProviderScopeDiscovery, &rest, None).await {
        Ok(written) => Sent::Written(written),
        // A run that reached the provider and failed: the API's 502 with the run's result, whose
        // error the schedule's last run now shows.
        Err(error) if done == Done::Ran && error.status() == Some(StatusCode::BAD_GATEWAY) => {
            let mut errors = Errors::new();
            errors.add_form(p.provider_run_failed());
            Sent::Refused(errors)
        }
        Err(error) => sent_of(error),
    };
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &[], done).await
}

/// The draft form: the version it is made from and the one it is called.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct DraftInput {
    pub source_profile_version: String,
    pub target_profile_version: String,
}

pub(crate) async fn draft(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Draft<'_>>,
    Form(input): Form<DraftInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let (source, target) = (input.source_profile_version.trim(), input.target_profile_version.trim());
    if source.is_empty() {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/provider-profiles{}", under(&route.key, &[source, "clone"]));
    let body = json!({ "targetProfileVersion": target, "lifecycle": "draft" });
    // The API answers the draft it made; its version is the one the page selects next, read after
    // the write.
    match caller.post_written::<Value>(Kind::SourceObservations, &rest, &body).await {
        Ok((profile, written)) => {
            let version = profile.get("profileVersion").and_then(Value::as_str).unwrap_or(target).to_owned();
            landed(&req, &route.key, &context, &[("profileVersion", Some(&version))], Some(&written), Done::Drafted)
        }
        Err(error) => answer(&req, &staff, &config, &headers, &route.key, &context, sent_of(error), &[], Done::Drafted).await,
    }
}

/// A lifecycle form: the operation, the version it acts on, and the box that confirms it.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct LifecycleInput {
    pub operation: String,
    pub profile_version: String,
    pub confirmation: String,
}

impl LifecycleInput {
    /// The value the confirmation box carries for a command on a version (admin-web's
    /// `lifecycleConfirmationValue`).
    pub fn confirmation_for(command_key: &str, key: &str, version: &str) -> String {
        format!("confirm:{command_key}:{key}:{version}")
    }

    /// The API's path segment and the outcome for an operation the form offers.
    pub fn operation(&self) -> Option<(&'static str, Done)> {
        match self.operation.as_str() {
            "rollback" => Some(("rollback", Done::RolledBack)),
            "deprecate" => Some(("deprecate", Done::Deprecated)),
            "retire" => Some(("retire", Done::Retired)),
            _ => None,
        }
    }

    /// Whether the box was checked for this operation on this version. Workaround
    /// (chase-sets/chase-sets#11049): the API's commands take no confirmation, so the pilot checks
    /// it, as admin-web's action does.
    pub fn confirmed(&self, key: &str) -> bool {
        let command_key = format!("provider-profile.{}", self.operation);
        self.confirmation == LifecycleInput::confirmation_for(&command_key, key, self.profile_version.trim())
    }
}

pub(crate) async fn lifecycle(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Lifecycle<'_>>,
    Form(input): Form<LifecycleInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let t: Cat = req.t();
    let version = input.profile_version.trim();
    let Some((word, done)) = input.operation().filter(|_| !version.is_empty()) else {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    };
    if !input.confirmed(&route.key) {
        let mut errors = Errors::new();
        errors.add_form(t.feedback_confirmation_required());
        return again(&req, &staff, &config, &headers, &route.key, &context, errors).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/provider-profiles{}", under(&route.key, &[version, word]));
    let sent = command(&caller, Method::POST, Kind::SourceObservations, &rest, None).await;
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &[("profileVersion", Some(version))], done).await
}

pub(crate) async fn job(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Params(route): Params<url::Job<'_>>,
    Form(input): Form<daily::JobInput>,
) -> HtmlResult {
    let context = daily::context_of(&uri);
    let Some(word) = ["retry", "resume", "cancel"].into_iter().find(|c| *c == input.command) else {
        return again(&req, &staff, &config, &headers, &route.key, &context, super::not_offered(req.t())).await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let rest = format!("/integration-jobs{}", under(&route.id, &[word]));
    let sent = command(&caller, Method::POST, Kind::SourceObservations, &rest, None).await;
    let done = if word == "cancel" { Done::Cancelled } else { Done::Queued };
    answer(&req, &staff, &config, &headers, &route.key, &context, sent, &[("jobId", Some(&route.id))], done).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_location_names_the_provider_unless_the_context_already_does() {
        assert_eq!(location("tcgplayer", ""), "/catalog/providers/tcgplayer?providerKey=tcgplayer");
        assert_eq!(
            location("tcgplayer", "profileVersion=2026.07.13"),
            "/catalog/providers/tcgplayer?profileVersion=2026.07.13&providerKey=tcgplayer"
        );
        assert_eq!(location("tcgplayer", "providerKey=scryfall"), "/catalog/providers/tcgplayer?providerKey=scryfall");
    }

    #[test]
    fn a_lifecycle_command_runs_only_with_its_own_confirmation() {
        let mut input = LifecycleInput {
            operation: "retire".into(),
            profile_version: "2026.06.23".into(),
            confirmation: LifecycleInput::confirmation_for("provider-profile.retire", "tcgplayer", "2026.06.23"),
        };
        assert!(input.confirmed("tcgplayer"));
        assert!(!input.confirmed("scryfall"), "another provider's");
        input.profile_version = "2026.07.13".into();
        assert!(!input.confirmed("tcgplayer"), "another version's");
        input.profile_version = "2026.06.23".into();
        input.operation = "rollback".into();
        assert!(!input.confirmed("tcgplayer"), "another operation's");
        input.confirmation.clear();
        assert!(!input.confirmed("tcgplayer"), "an unchecked box");
        input.operation = "activate".into();
        assert_eq!(input.operation(), None, "the page offers no activation");
    }

    #[test]
    fn a_schedule_is_pausable_only_when_it_runs_on_its_own() {
        let mut s = Schedule { schedule_enabled: true, ..Schedule::default() };
        assert!(s.scheduled() && s.pausable());
        s.paused = true;
        assert!(!s.scheduled() && s.pausable());
        s.manual_only = true;
        assert!(!s.pausable());
    }

    #[test]
    fn each_outcome_reads_back_from_its_word() {
        for (done, word) in Done::ALL {
            assert_eq!(Done::of(word), Some(done));
            assert_eq!(done.word(), word);
        }
        assert_eq!(Done::of("promoted"), None);
    }

    #[test]
    fn an_operator_session_is_offered_to_a_platform_admin_on_tcgplayer() {
        assert!(operator_session("platform-admin", "tcgplayer"));
        assert!(!operator_session("catalog-manager", "tcgplayer"));
        assert!(!operator_session("platform-admin", "scryfall"));
    }
}
