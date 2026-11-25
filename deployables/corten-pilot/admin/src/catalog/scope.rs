//! A scope's page (admin-web's Scope Detail, `/catalog/scopes/{id}`): its journey, its provider
//! coverage, its candidate review jobs and, when it has more than one language edition, each
//! edition's link state and alias candidates, through the Catalog API as the signed-in staff
//! member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes/{id}?jobs&afterWrite&done&count&<working set>` | the page (`jobs`: the completed jobs' page cursor; the rest the import-to-promotion section's working set) |
//! | `POST /catalog/scopes/{id}/coverage` | a mapping's accept, reject or revoke, or Accept all available |
//! | `POST /catalog/scopes/{id}/coverage/propose` | Propose mapping (and accept it) |
//! | `POST /catalog/scopes/{id}/publish` | Confirm canonical record |
//! | `POST /catalog/scopes/{id}/aliases` | an edition's alias candidate: accept, reject, revoke or defer |
//!
//! The scope, with its language editions and journey as the Catalog API composes them, is the
//! page's one required read; the coverage and the jobs are read with it, and each failed one is a
//! banner in its own section, as admin-web's loader degrades them. An alias review the API could not
//! read is the journey's partial failure. Every write is a form that works without JavaScript and answers with the page after it
//! (its receipt and the toast), or the page again with the API's refusal (422).
//!
//! The import-to-promotion section is the daily workbench's surface for the scope
//! (`GET .../workbench-surfaces/daily?location=`), read with the others and drawn with the daily
//! page's banners and stages. It is read for this page's own address ([`journey_context`]), whose
//! journey the Catalog API composes from the Scope Record: its hierarchy, its id and its first
//! language edition are the API's to set, not the page's. Its commands are the daily routes', which
//! land back here (the working set's `home`). A surface that does not read is the section's banner,
//! with admin-web's page linked.
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::future::join3;
use platform::receipt::Receipt;
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Sent,
    api::{
        AliasCandidate, Catalog as _, Coverage, EditionLinkState, EditionSummary, JourneyCondition, JourneyOverview,
        JourneyStage, JourneyStageKey, JourneyStageStatus, Kind, ReviewJob, ReviewJobs, ScopeJourney, ScopeRecord, Written,
        under,
    },
    attention::AliasDone,
    command,
    daily::Opened,
    manages, receipt,
    scopes::{Promotion, Sync},
    views,
};
use crate::{
    api::{ApiError, Caller, Method, segment},
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`,
/// so every write needs `catalog.manage`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// What a write did: the page's toast.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, corten::UrlValue)]
    #[serde(rename_all = "snake_case")]
    pub enum ScopeDone {
        MappingAccepted,
        AvailableAccepted,
        MappingRejected,
        MappingRevoked,
        MappingProposed,
        MappingProposedAccepted,
        CanonicalConfirmed,
        AliasAccepted,
        AliasRejected,
        AliasRevoked,
        AliasDeferred,
        /// A command from the import-to-promotion section the API accepted, or the job it
        /// cancelled (the daily workbench's words, `daily::Ran`).
        Queued,
        Cancelled,
    }

    /// The page's query: the completed jobs' page, what the write before left (its receipt, its
    /// toast and, for Accept all available, how many), and whether its import-to-promotion section
    /// reads its import preflight in (`crate::catalog::daily::PREFLIGHT`, the loading line's link).
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ScopeAt {
        pub jobs: Option<String>,
        #[serde(rename = "afterWrite")]
        pub after_write: Option<String>,
        pub done: Option<ScopeDone>,
        pub count: Option<u32>,
        pub preflight: Option<bool>,
    }

    #[route("/catalog/scopes/{id}", get = crate::catalog::scope::page)]
    pub struct ScopePage<'a> {
        pub id: &'a str,
        #[route(query)]
        pub at: ScopeAt,
    }

    impl<'a> ScopePage<'a> {
        pub fn of(id: &'a str) -> Self {
            ScopePage { id, at: ScopeAt::default() }
        }
    }

    /// A coverage row's mapping: accept, reject or revoke (`intent`), one mapping or every
    /// available one (`all`); a reject or revoke needs its reason.
    #[derive(Clone, Debug, Default, Fields)]
    #[serde(default)]
    pub struct MappingInput {
        pub intent: String,
        pub mapping_ids: String,
        pub all: String,
        pub reason: String,
    }

    /// Which page a coverage write answers with: the scope's page, or (`coverage`) the scope's
    /// coverage page, `/catalog/scope-coverage/{id}`, which posts to the same routes.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, corten::UrlValue)]
    #[serde(rename_all = "snake_case")]
    pub enum Via {
        #[default]
        Scope,
        Coverage,
    }

    /// A coverage write's query: the page it answers with.
    #[derive(Clone, Copy, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ViaQuery {
        pub via: Option<Via>,
    }

    #[route("/catalog/scopes/{id}/coverage", post = crate::catalog::scope::coverage)]
    pub struct ScopeCoverage<'a> {
        pub id: &'a str,
        #[route(query)]
        pub via: ViaQuery,
    }

    /// Propose mapping's fields; `accept` is set by Propose & accept.
    #[derive(Clone, Debug, Default, Fields)]
    #[serde(default)]
    pub struct ProposeInput {
        pub provider_key: String,
        pub unit_key: String,
        pub set_id: String,
        pub set_name: String,
        pub confidence: String,
        pub accept: String,
    }

    #[route("/catalog/scopes/{id}/coverage/propose", post = crate::catalog::scope::propose)]
    pub struct ScopePropose<'a> {
        pub id: &'a str,
        #[route(query)]
        pub via: ViaQuery,
    }

    #[route("/catalog/scopes/{id}/publish", post = crate::catalog::scope::publish)]
    pub struct ScopePublish<'a> {
        pub id: &'a str,
        #[route(query)]
        pub via: ViaQuery,
    }

    /// An alias candidate's command (`alias.accept`, `alias.reject`, `alias.revoke`,
    /// `alias.defer`), its hash, and the reason a reject or revoke needs. `picked` are the boxes
    /// checked in the all-scopes review's bulk bar, one hash each, read with `alias_hashes`.
    #[derive(Clone, Debug, Default, Fields)]
    #[serde(default)]
    pub struct AliasCommand {
        pub intent: String,
        pub alias_hashes: String,
        pub reason: String,
        pub picked: Vec<String>,
    }

    #[route("/catalog/scopes/{id}/aliases", post = crate::catalog::scope::aliases)]
    pub struct ScopeAliases<'a> {
        pub id: &'a str,
    }
}

use url::{AliasCommand, MappingInput, ProposeInput, ScopeAt, ScopeDone, Via};

impl ScopeDone {
    /// The toast: admin-web's words for what the command did.
    pub fn notice(self, t: Cat, count: u32) -> String {
        match self {
            ScopeDone::MappingAccepted => t.coverage_mapping_accepted().into(),
            ScopeDone::AvailableAccepted => t.coverage_all_available_accepted(count).to_string(),
            ScopeDone::MappingRejected => t.coverage_mapping_rejected().into(),
            ScopeDone::MappingRevoked => t.coverage_mapping_revoked().into(),
            ScopeDone::MappingProposed => t.coverage_mapping_proposed().into(),
            ScopeDone::MappingProposedAccepted => t.coverage_mapping_proposed_and_accepted().into(),
            ScopeDone::CanonicalConfirmed => t.coverage_canonical_record_confirmed().into(),
            ScopeDone::AliasAccepted => AliasDone::Accepted.title(t).into(),
            ScopeDone::AliasRejected => AliasDone::Rejected.title(t).into(),
            ScopeDone::AliasRevoked => AliasDone::Revoked.title(t).into(),
            ScopeDone::AliasDeferred => AliasDone::Deferred.title(t).into(),
            ScopeDone::Queued => t.feedback_queued_title().into(),
            ScopeDone::Cancelled => t.feedback_cancelled_title().into(),
        }
    }
}

/// Where the whole journey is (`CatalogScopeJourneyCondition`), most pressing first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    Empty,
    PartialFailure,
    Blocked,
    Conflict,
    ProjectionLag,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "snake_case")]
pub enum StageKey {
    Coverage,
    Sync,
    Jobs,
    Candidates,
    Promotion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    Complete,
    Current,
    Upcoming,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
pub struct Stage {
    pub key: StageKey,
    pub status: StageStatus,
}

/// The scope's journey (`CatalogScopeJourneyOverviewReadModel`).
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Journey {
    pub condition: Condition,
    pub stages: Vec<Stage>,
    pub editions: usize,
    pub linked: usize,
    pub pending: usize,
    pub promotion: Promotion,
    pub sync: Sync,
}

/// An edition's link (`CatalogScopeLanguageEditionLinkState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToJson)]
#[serde(rename_all = "snake_case")]
pub enum Link {
    Linked,
    PendingReview,
    NotYetObserved,
}

/// A language edition (`CatalogScopeLanguageEditionSummary`): its pending candidates and its
/// accepted ones (a linked edition can still be revoked).
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Edition {
    pub language_code: String,
    pub canonical: bool,
    pub link: Link,
    pub pending: Vec<AliasCandidate>,
    pub accepted: Vec<AliasCandidate>,
}

/// The candidate review jobs: active, the latest failed, and a page of completed ones.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Jobs {
    pub active: Vec<ReviewJob>,
    pub failed: Vec<ReviewJob>,
    pub completed: Vec<ReviewJob>,
    /// The next (older) completed page's cursor.
    pub next: Option<String>,
}

/// The page's view model: what it shows and what a data client gets. A supplementary read that
/// failed is `None` (its section says so).
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct ScopeScreen {
    pub scope: ScopeRecord,
    pub journey: Journey,
    pub coverage: Option<Coverage>,
    pub jobs: Option<Jobs>,
    /// The editions, when the scope has more than one; none when it has one or none.
    pub editions: Option<Vec<Edition>>,
    /// Whether the alias review could not be read (the editions are then drawn from none).
    pub alias_review_failed: bool,
    /// The import-to-promotion section's working set (its `home` this scope), as its forms carry
    /// it, and the daily surface read for it; none when that does not read.
    pub context: String,
    pub workspace: Option<crate::catalog::daily::DailyScreen>,
}

/// The query keys the scope's page owns: the completed jobs' page, what the write before left, and
/// the import preflight read in.
const PAGE_KEYS: [&str; 5] = ["jobs", "afterWrite", "done", "count", crate::catalog::daily::PREFLIGHT];

/// The keys the scope sets itself (admin-web's `SCOPE_QUERY_KEYS`, then `scopeRecordId`): a
/// provider, unit, import scope or profile version in the address is dropped, as there.
const SCOPE_KEYS: [&str; 11] = [
    "providerKey",
    "unitKey",
    "importScope",
    "profileVersion",
    "productLineId",
    "productLineName",
    "seriesId",
    "seriesName",
    "expansionId",
    "expansionName",
    "scopeRecordId",
];

/// The import-to-promotion section's working set as the page sends it: the address's keys less
/// the page's own and the ones the scope decides, then `home`, so the daily surface is read for the
/// scope's own page (whose journey the Catalog API composes from the Scope Record) and a command
/// lands back here.
pub fn journey_context(query: &str, id: &str) -> String {
    use crate::catalog::daily::{HOME, with_query};
    let mut drop: Vec<(&str, Option<&str>)> = PAGE_KEYS.iter().chain(&SCOPE_KEYS).map(|k| (*k, None)).collect();
    drop.push((HOME, None));
    with_query(&with_query(query, &drop), &[(HOME, Some(id))])
}

impl From<EditionSummary> for Edition {
    fn from(edition: EditionSummary) -> Self {
        Edition {
            language_code: edition.language_code,
            canonical: edition.is_canonical,
            link: match edition.link_state {
                EditionLinkState::Linked => Link::Linked,
                EditionLinkState::PendingReview => Link::PendingReview,
                EditionLinkState::NotYetObserved => Link::NotYetObserved,
            },
            pending: edition.pending_candidates,
            accepted: edition.accepted_candidates,
        }
    }
}

impl From<JourneyStage> for Stage {
    fn from(stage: JourneyStage) -> Self {
        Stage {
            key: match stage.key {
                JourneyStageKey::Coverage => StageKey::Coverage,
                JourneyStageKey::Sync => StageKey::Sync,
                JourneyStageKey::Jobs => StageKey::Jobs,
                JourneyStageKey::Candidates => StageKey::Candidates,
                JourneyStageKey::Promotion => StageKey::Promotion,
            },
            status: match stage.status {
                JourneyStageStatus::Complete => StageStatus::Complete,
                JourneyStageStatus::Current => StageStatus::Current,
                JourneyStageStatus::Upcoming => StageStatus::Upcoming,
                JourneyStageStatus::Blocked => StageStatus::Blocked,
            },
        }
    }
}

impl From<JourneyOverview> for Journey {
    fn from(overview: JourneyOverview) -> Self {
        Journey {
            condition: match overview.condition {
                JourneyCondition::Empty => Condition::Empty,
                JourneyCondition::PartialFailure => Condition::PartialFailure,
                JourneyCondition::Blocked => Condition::Blocked,
                JourneyCondition::Conflict => Condition::Conflict,
                JourneyCondition::ProjectionLag => Condition::ProjectionLag,
                JourneyCondition::Ready => Condition::Ready,
            },
            stages: overview.stages.into_iter().map(Stage::from).collect(),
            editions: overview.edition_count,
            linked: overview.linked_edition_count,
            pending: overview.pending_candidate_count,
            promotion: overview.promotion_readiness,
            sync: overview.sync_freshness,
        }
    }
}

/// The candidate review jobs (`loadCandidateReviewJobs`): none when any of the three reads failed.
async fn jobs(caller: &Caller<'_>, id: &str, cursor: Option<&str>) -> Option<Jobs> {
    let scope = format!("?scopeRecordId={}", segment(id));
    let page = cursor.map(|c| format!("&cursor={}", segment(c))).unwrap_or_default();
    let (active, completed, failed) = join3(
        caller.read_at::<ReviewJobs>(Kind::SourceObservations, &format!("/bulk-jobs/active{scope}")),
        caller.read_at::<ReviewJobs>(Kind::SourceObservations, &format!("/bulk-jobs/active{scope}&status=completed{page}")),
        caller.read_at::<ReviewJobs>(Kind::SourceObservations, &format!("/merge-candidate-bulk-jobs/failed{scope}")),
    )
    .await;
    match (active, completed, failed) {
        (Ok(active), Ok(completed), Ok(failed)) => {
            Some(Jobs { active: active.items, failed: failed.items, completed: completed.items, next: completed.cursor })
        }
        (active, completed, failed) => {
            for error in [active.err(), completed.err(), failed.err()].into_iter().flatten() {
                tracing::warn!("a scope's candidate review jobs could not be read: {error}");
            }
            None
        }
    }
}

/// The page's reads, together: the scope with its editions and journey, its coverage, its jobs and
/// its import-to-promotion section.
async fn screen(caller: &Caller<'_>, id: &str, cursor: Option<&str>, query: &str, manage: bool) -> Result<ScopeScreen, ApiError> {
    use crate::catalog::daily::workspace as daily;
    let context = journey_context(query, id);
    let (journey_at, coverage_at) = (under(id, &["journey"]), format!("/coverage{}", under(id, &[])));
    let (journey, coverage, jobs, workspace) = tokio::join!(
        caller.read_at::<ScopeJourney>(Kind::ScopeRecords, &journey_at),
        caller.read_at::<Coverage>(Kind::ProviderScopeMappings, &coverage_at),
        jobs(caller, id, cursor),
        daily(caller, &context, manage),
    );
    let ScopeJourney { scope, language_editions, language_edition_review_failed, overview } = journey?;
    if language_edition_review_failed {
        tracing::warn!("the Catalog API could not read a scope's alias review");
    }
    let coverage = coverage.inspect_err(|error| tracing::warn!("a scope's coverage could not be read: {error}")).ok();
    let editions = language_editions.map(|review| review.editions.into_iter().map(Edition::from).collect());
    Ok(ScopeScreen {
        scope,
        journey: Journey::from(overview),
        coverage,
        jobs,
        editions,
        alias_review_failed: language_edition_review_failed,
        context,
        workspace,
    })
}

fn caller<'a>(config: &'a Shared, headers: &'a HeaderMap, receipt: Option<&'a Receipt>) -> Caller<'a> {
    config.platform.caller(headers, config.proto, receipt)
}

/// What the page draws besides the reads: a refused write's message, and Propose mapping's form
/// when it came back.
#[derive(Default)]
pub enum ScopeBack {
    #[default]
    Nothing,
    Refused(String),
    Propose(ProposeInput, String),
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: corten::http::Uri,
    Params(route): Params<crate::catalog::scope::url::ScopePage<'_>>,
) -> HtmlResult {
    let (id, at) = (route.id, route.at);
    let query = uri.query().unwrap_or_default();
    let receipt = Receipt::from_param(at.after_write.as_deref());
    let asked = at.preflight == Some(true);
    let opened = crate::catalog::daily::read_in_preflight(
        &caller(&config, &headers, receipt.as_ref()),
        asked,
        &journey_context(query, &id),
    )
    .await;
    render(&req, &staff.viewer, &config, &headers, &id, &at, query, ScopeBack::Nothing, opened).await
}

/// The page a write came from, again: with a `back` other than nothing, a refused write's answer
/// (422).
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn again(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    at: &ScopeAt,
    back: ScopeBack,
    from: Via,
) -> HtmlResult {
    match from {
        Via::Scope => render(req, viewer, config, headers, id, at, "", back, Opened::Nothing).await,
        Via::Coverage => crate::catalog::coverage::render(req, viewer, config, headers, id, at, back).await,
    }
}

/// The page, `query` its address's query (the import-to-promotion section's working set); with a
/// `back` other than nothing, a refused write's answer (422).
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    at: &ScopeAt,
    query: &str,
    back: ScopeBack,
    opened: Opened,
) -> HtmlResult {
    let receipt = Receipt::from_param(at.after_write.as_deref());
    let caller = caller(config, headers, receipt.as_ref());
    let mut view = match screen(&caller, id, at.jobs.as_deref(), query, manages(viewer)).await {
        Ok(view) => view,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    if let Some(workspace) = view.workspace.as_mut() {
        workspace.open(opened);
    }
    let t: Cat = req.t();
    let notice = at.done.map(|done| done.notice(t, at.count.unwrap_or(0)));
    let status = if matches!(back, ScopeBack::Nothing) { StatusCode::OK } else { StatusCode::UNPROCESSABLE_ENTITY };
    let page = views::scope_page(req, &view, at.jobs.as_deref(), notice, back, manages(viewer));
    let html = html! {
        <crate::views::OwnToastLayout req={req} viewer={Some(viewer)} title={t.route_scope()} head="">
            {page}
        </crate::views::OwnToastLayout>
    };
    if status == StatusCode::OK { req.screen(&view, html) } else { req.page_with_status(status, html) }
}

/// A command its import-to-promotion section posted to the daily workbench's routes, refused, without
/// the runtime: the page again for the same working set (`context`, whose `home` is `id`), with
/// the API's message (422).
pub(crate) async fn refused_in_workspace(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    context: &str,
    errors: &corten::Errors,
) -> HtmlResult {
    let message = errors.form().map(str::to_owned).unwrap_or_default();
    render(req, viewer, config, headers, id, &ScopeAt::default(), context, ScopeBack::Refused(message), Opened::Nothing).await
}

/// The scope's page without the runtime with what its import-to-promotion section has open (a review
/// row's evidence sheet): the page for the same working set (`context`, whose
/// `home` is `id`).
pub(crate) async fn opened(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    context: &str,
    opened: Opened,
) -> HtmlResult {
    render(req, viewer, config, headers, id, &ScopeAt::default(), context, ScopeBack::Nothing, opened).await
}

/// After a write: the page it came from, waiting for it, with its toast.
fn to_scope(req: &Req, id: &str, written: Option<&Written>, done: ScopeDone, count: Option<u32>, from: Via) -> HtmlResult {
    let at = ScopeAt { after_write: written.and_then(receipt), done: Some(done), count, jobs: None, preflight: None };
    match from {
        Via::Scope => req.redirect(&url::ScopePage { id, at }),
        Via::Coverage => req.redirect(&crate::catalog::coverage::url::CoveragePage { id, at }),
    }
}

/// A write's answer: the page after it, or the page again with the API's refusal.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn answer(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    sent: Sent,
    done: ScopeDone,
    count: Option<u32>,
    from: Via,
) -> HtmlResult {
    match sent {
        Sent::Written(written) => to_scope(req, id, Some(&written), done, count, from),
        Sent::Refused(errors) => {
            let message = errors.form().map(str::to_owned).unwrap_or_default();
            again(req, viewer, config, headers, id, &ScopeAt::default(), ScopeBack::Refused(message), from).await
        }
        Sent::Denied(denied) => denied.answer(req),
    }
}

/// The comma-separated ids a form sends, each once.
fn ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in text.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// A refused form, before anything is sent: the page with `message` (422).
async fn invalid(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    message: String,
    from: Via,
) -> HtmlResult {
    again(req, viewer, config, headers, id, &ScopeAt::default(), ScopeBack::Refused(message), from).await
}

pub(crate) async fn coverage(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::scope::url::ScopeCoverage<'_>>,
    Form(input): Form<MappingInput>,
) -> HtmlResult {
    let (id, via) = (route.id, route.via.via.unwrap_or_default());
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let viewer = &staff.viewer;
    let mapping_ids = ids(&input.mapping_ids);
    let reason = input.reason.trim();
    let intent = input.intent.as_str();
    if mapping_ids.is_empty() || !matches!(intent, "accept" | "reject" | "revoke") {
        return invalid(&req, viewer, &config, &headers, &id, p.catalog_action().to_owned(), via).await;
    }
    if intent != "accept" && reason.is_empty() {
        return invalid(&req, viewer, &config, &headers, &id, t.coverage_reason_required().to_owned(), via).await;
    }
    let mut body = json!({ "intent": intent, "mappingIds": mapping_ids });
    if !reason.is_empty() {
        body["reason"] = json!(reason);
    }
    let (done, count) = match intent {
        "accept" if !input.all.is_empty() => (ScopeDone::AvailableAccepted, Some(mapping_ids.len() as u32)),
        "accept" => (ScopeDone::MappingAccepted, None),
        "reject" => (ScopeDone::MappingRejected, None),
        _ => (ScopeDone::MappingRevoked, None),
    };
    let sent =
        command(&caller(&config, &headers, None), Method::POST, Kind::ProviderScopeMappings, "/commands", Some(&body)).await;
    answer(&req, viewer, &config, &headers, &id, sent, done, count, via).await
}

/// The confidence tiers Propose mapping offers (`confidenceOptions`).
pub const CONFIDENCES: [&str; 3] = ["exact", "high", "manual"];

pub(crate) async fn propose(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::scope::url::ScopePropose<'_>>,
    Form(input): Form<ProposeInput>,
) -> HtmlResult {
    let (id, via) = (route.id, route.via.via.unwrap_or_default());
    let p: Pilot = req.t();
    let viewer = &staff.viewer;
    let (provider, unit, set_id, set_name) =
        (input.provider_key.trim(), input.unit_key.trim(), input.set_id.trim(), input.set_name.trim());
    // admin-web's dialog sends nothing until these are filled; the pilot says what is missing.
    if provider.is_empty() || unit.is_empty() || (set_id.is_empty() && set_name.is_empty()) {
        let back = ScopeBack::Propose(input.clone(), p.scope_propose_needs().to_owned());
        return again(&req, viewer, &config, &headers, &id, &ScopeAt::default(), back, via).await;
    }
    let confidence = if CONFIDENCES.contains(&input.confidence.as_str()) { input.confidence.as_str() } else { "manual" };
    let accept = !input.accept.is_empty();
    let body = json!({
        "scopeRecordId": id,
        "providerKey": provider,
        "unitKey": unit,
        "coordinates": {
            "setId": (!set_id.is_empty()).then_some(set_id),
            "setName": (!set_name.is_empty()).then_some(set_name),
        },
        "confidence": confidence,
        "autoAccept": accept,
    });
    let done = if accept { ScopeDone::MappingProposedAccepted } else { ScopeDone::MappingProposed };
    match command(&caller(&config, &headers, None), Method::POST, Kind::ProviderScopeMappings, "/propose", Some(&body)).await {
        Sent::Refused(errors) => {
            let back = ScopeBack::Propose(input.clone(), errors.form().map(str::to_owned).unwrap_or_default());
            again(&req, viewer, &config, &headers, &id, &ScopeAt::default(), back, via).await
        }
        sent => answer(&req, viewer, &config, &headers, &id, sent, done, None, via).await,
    }
}

/// Confirm canonical record: publishes the scope's Reference Record. A scope's id is its
/// Reference Record's (admin-web publishes the scope's id too).
pub(crate) async fn publish(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::scope::url::ScopePublish<'_>>,
) -> HtmlResult {
    let (id, via) = (route.id, route.via.via.unwrap_or_default());
    let rest = under(&id, &["publish"]);
    let sent = command(&caller(&config, &headers, None), Method::POST, Kind::ReferenceRecords, &rest, None).await;
    answer(&req, &staff.viewer, &config, &headers, &id, sent, ScopeDone::CanonicalConfirmed, None, via).await
}

/// An alias candidate's command (`handleAliasReviewCommand`). Defer writes nothing (the candidate
/// stays pending), so it only says so.
pub(crate) async fn aliases(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::catalog::scope::url::ScopeAliases<'_>>,
    Form(input): Form<AliasCommand>,
) -> HtmlResult {
    let id = route.id;
    let p: Pilot = req.t();
    let t: Cat = req.t();
    let viewer = &staff.viewer;
    let hashes = ids(&input.alias_hashes);
    let reason = input.reason.trim();
    let (intent, done) = match input.intent.as_str() {
        "alias.accept" => ("accept", ScopeDone::AliasAccepted),
        "alias.reject" => ("reject", ScopeDone::AliasRejected),
        "alias.revoke" => ("revoke", ScopeDone::AliasRevoked),
        "alias.defer" => ("defer", ScopeDone::AliasDeferred),
        _ => return invalid(&req, viewer, &config, &headers, &id, p.catalog_action().to_owned(), Via::Scope).await,
    };
    if hashes.is_empty() {
        return invalid(&req, viewer, &config, &headers, &id, p.catalog_action().to_owned(), Via::Scope).await;
    }
    if intent == "defer" {
        return to_scope(&req, &id, None, done, None, Via::Scope);
    }
    if intent != "accept" && reason.is_empty() {
        return invalid(&req, viewer, &config, &headers, &id, t.coverage_reason_required().to_owned(), Via::Scope).await;
    }
    let mut body: Value = json!({ "intent": intent, "aliasHashes": hashes.join(",") });
    if !reason.is_empty() {
        body["reason"] = json!(reason);
    }
    let sent = command(&caller(&config, &headers, None), Method::POST, Kind::AliasReview, "/commands", Some(&body)).await;
    answer(&req, viewer, &config, &headers, &id, sent, done, None, Via::Scope).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::api::AutoAccept;

    /// A scope as the API answers it: `status` is its lifecycle, `sync` the freshness the API
    /// measured.
    fn scope(editions: &[&str], status: &str, sync: Sync) -> ScopeRecord {
        let promotion = match status {
            "active" => Promotion::Live,
            "archived" => Promotion::Archived,
            "deprecated" => Promotion::Deprecated,
            _ => Promotion::Unpublished,
        };
        ScopeRecord {
            scope_record_id: "scp_1".into(),
            reference_record_id: "ref_1".into(),
            product_domain: "pokemon".into(),
            scope_kind: "set".into(),
            name: "Base Set".into(),
            product_line_scope_record_id: Some("scp_pokemon".into()),
            series_scope_record_id: Some("scp_series".into()),
            official_set_code: None,
            language_editions: editions.iter().map(|e| (*e).into()).collect(),
            lifecycle_status: status.into(),
            updated_at: "2026-10-25T00:00:00Z".into(),
            promotion_readiness: promotion,
            sync_freshness: sync,
        }
    }

    fn candidate(hash: &str, language: &str, status: &str, target: &str) -> AliasCandidate {
        AliasCandidate {
            alias_hash: hash.into(),
            target_kind: "reference-record".into(),
            target_id: Some(target.into()),
            native_printed_name: "拡張パック".into(),
            proposed_alias: "Base Set".into(),
            alias_language_code: language.into(),
            confidence: "high".into(),
            review_status: status.into(),
            auto_accept: AutoAccept::default(),
            available_actions: Vec::new(),
            ..Default::default()
        }
    }

    /// `GET /scope-records/{id}/journey` as the Catalog API answers it: a pending Japanese alias, so
    /// the journey is a conflict.
    fn api_journey() -> ScopeJourney {
        let mut scope = serde_json::to_value(scope(&["en", "ja"], "active", Sync::Fresh)).unwrap();
        scope["referenceRecordId"] = "ref_1".into();
        let candidate = serde_json::to_value(candidate("a", "ja", "pending", "ref_1")).unwrap();
        serde_json::from_value(serde_json::json!({
            "generatedAt": "2026-10-25T00:00:00.000Z",
            "scope": scope,
            "languageEditions": { "scopeRecordId": "scp_1", "referenceRecordId": "ref_1", "editions": [
                { "languageCode": "en", "isCanonical": true, "linkState": "linked", "acceptedAliasCount": 0,
                  "pendingCandidates": [], "acceptedCandidates": [] },
                { "languageCode": "ja", "isCanonical": false, "linkState": "pending-review", "acceptedAliasCount": 0,
                  "pendingCandidates": [candidate], "acceptedCandidates": [] },
            ] },
            "languageEditionReviewFailed": false,
            "overview": { "scopeRecordId": "scp_1", "condition": "conflict", "stages": [
                { "key": "coverage", "status": "complete" }, { "key": "sync", "status": "complete" },
                { "key": "jobs", "status": "complete" }, { "key": "candidates", "status": "current" },
                { "key": "promotion", "status": "complete" },
            ], "editionCount": 2, "linkedEditionCount": 1, "pendingCandidateCount": 1,
              "promotionReadiness": "live", "syncFreshness": "fresh" },
        }))
        .unwrap()
    }

    #[test]
    fn the_editions_and_journey_are_drawn_as_the_catalog_api_composes_them() {
        let ScopeJourney { scope, language_editions, language_edition_review_failed, overview } = api_journey();
        assert_eq!(scope.reference_record_id, "ref_1");
        assert!(!language_edition_review_failed);
        let editions: Vec<Edition> = language_editions.unwrap().editions.into_iter().map(Edition::from).collect();
        let shown: Vec<(&str, bool, Link, usize)> =
            editions.iter().map(|e| (e.language_code.as_str(), e.canonical, e.link, e.pending.len())).collect();
        assert_eq!(shown, [("en", true, Link::Linked, 0), ("ja", false, Link::PendingReview, 1)]);
        let journey = Journey::from(overview);
        assert_eq!((journey.condition, journey.editions, journey.linked, journey.pending), (Condition::Conflict, 2, 1, 1));
        assert_eq!((journey.promotion, journey.sync), (Promotion::Live, Sync::Fresh));
        let stages: Vec<(StageKey, StageStatus)> = journey.stages.iter().map(|s| (s.key, s.status)).collect();
        assert_eq!(stages[3], (StageKey::Candidates, StageStatus::Current));
        assert_eq!(stages.len(), 5);
    }

    #[test]
    fn every_api_condition_has_the_pages() {
        for (api, page) in [
            ("empty", Condition::Empty),
            ("partial-failure", Condition::PartialFailure),
            ("blocked", Condition::Blocked),
            ("conflict", Condition::Conflict),
            ("projection-lag", Condition::ProjectionLag),
            ("ready", Condition::Ready),
        ] {
            let condition: JourneyCondition = serde_json::from_value(serde_json::json!(api)).unwrap();
            let overview = JourneyOverview { condition, ..api_journey().overview };
            assert_eq!(Journey::from(overview).condition, page, "{api}");
        }
        let link: EditionLinkState = serde_json::from_value(serde_json::json!("not-yet-observed")).unwrap();
        assert_eq!(link, EditionLinkState::NotYetObserved);
    }

    #[test]
    fn the_screen_is_written_as_serde_writes_it() {
        let ScopeJourney { scope, language_editions, overview, .. } = api_journey();
        let screen = ScopeScreen {
            scope,
            journey: Journey::from(overview),
            coverage: None,
            jobs: Some(Jobs { active: Vec::new(), failed: Vec::new(), completed: Vec::new(), next: Some("c1".into()) }),
            editions: language_editions.map(|review| review.editions.into_iter().map(Edition::from).collect()),
            alias_review_failed: false,
            context: String::new(),
            workspace: None,
        };
        let derived: serde_json::Value = serde_json::from_str(&screen.to_json()).unwrap();
        assert_eq!(derived, serde_json::to_value(&screen).unwrap());
    }

    #[test]
    fn the_journey_is_read_for_the_pages_own_address_with_no_hierarchy_of_the_pilots() {
        // The address's working set passes through as sent, its edition included; the page's own
        // keys, the scope's keys and an old `home` are dropped, and `home` is this scope.
        assert_eq!(
            journey_context(
                "jobs=c2&filter.status=observed&providerKey=x&done=queued&languageCode=en&reviewOffset=25\
                 &productLineId=scp_other&expansionId=scp_other&scopeRecordId=other&home=elsewhere",
                "scp_1"
            ),
            "filter.status=observed&languageCode=en&reviewOffset=25&home=scp_1"
        );
        assert_eq!(journey_context("", "scp_1"), "home=scp_1", "nothing of the scope's is added");
    }

    #[test]
    fn a_forms_ids_are_each_kept_once() {
        assert_eq!(ids(" a, b,,a ,c"), ["a", "b", "c"]);
        assert!(ids(" , ").is_empty());
    }
}
