//! A scope's page (admin-web's Scope Detail, `/catalog/scopes/{id}`): its journey, its provider
//! coverage, its candidate review jobs and, when it has more than one language edition, each
//! edition's link state and alias candidates, through the Catalog API as the signed-in staff
//! member.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes/{id}?jobs&after_write&done&count` | the page (`jobs`: the completed jobs' page cursor) |
//! | `POST /catalog/scopes/{id}/coverage` | a mapping's accept, reject or revoke, or Accept all available |
//! | `POST /catalog/scopes/{id}/coverage/propose` | Propose mapping (and accept it) |
//! | `POST /catalog/scopes/{id}/publish` | Confirm canonical record |
//! | `POST /catalog/scopes/{id}/aliases` | an edition's alias candidate: accept, reject, revoke or defer |
//!
//! The scope is the page's one required read; the coverage, the jobs and the alias review are
//! read with it, and each failed one is a banner in its own section, as admin-web's loader degrades
//! them. Every write is a form that works without JavaScript and answers with the page after it
//! (its receipt and the toast), or the page again with the API's refusal (422).
//!
//! Not ported: the import-to-promotion workspace, which admin-web composes in its web server
//! (chase-sets/chase-sets#10507); the section links to admin-web's page for it.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::future::join3;
use platform::receipt::Receipt;
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;

use super::{
    Sent,
    api::{AliasCandidate, AliasReview, Catalog as _, Coverage, Kind, ReviewJob, ReviewJobs, ScopeRecord, Written, under},
    command, manages, receipt,
    scopes::{self, Promotion, Sync},
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
    #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, corten::UrlValue)]
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
    }

    /// The page's query: the completed jobs' page, and what the write before left (its receipt,
    /// its toast and, for Accept all available, how many).
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ScopeAt {
        pub jobs: Option<String>,
        pub after_write: Option<String>,
        pub done: Option<ScopeDone>,
        pub count: Option<u32>,
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
    #[derive(Clone, Debug, Default, Deserialize, Fields)]
    #[serde(default)]
    pub struct MappingInput {
        pub intent: String,
        pub mapping_ids: String,
        pub all: String,
        pub reason: String,
    }

    /// Which page a coverage write answers with: the scope's page, or (`coverage`) the scope's
    /// coverage page, `/catalog/scope-coverage/{id}`, which posts to the same routes.
    #[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, corten::UrlValue)]
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
    #[derive(Clone, Debug, Default, Deserialize, Fields)]
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
    /// `alias.defer`), its hash, and the reason a reject or revoke needs.
    #[derive(Clone, Debug, Default, Deserialize, Fields)]
    #[serde(default)]
    pub struct AliasCommand {
        pub intent: String,
        pub alias_hashes: String,
        pub reason: String,
    }

    #[route("/catalog/scopes/{id}/aliases", post = crate::catalog::scope::aliases)]
    pub struct ScopeAliases<'a> {
        pub id: &'a str,
    }
}

use url::{AliasCommand, MappingInput, ProposeInput, ScopeAt, ScopeDone, Via};

impl ScopeDone {
    /// The toast: admin-web's words for the coverage, the pilot's for an alias (admin-web says
    /// "Command queued" for each, chase-sets/chase-sets#10702).
    pub fn notice(self, t: Cat, p: Pilot, count: u32) -> String {
        match self {
            ScopeDone::MappingAccepted => t.coverage_mapping_accepted().into(),
            ScopeDone::AvailableAccepted => t.coverage_all_available_accepted(count).to_string(),
            ScopeDone::MappingRejected => t.coverage_mapping_rejected().into(),
            ScopeDone::MappingRevoked => t.coverage_mapping_revoked().into(),
            ScopeDone::MappingProposed => t.coverage_mapping_proposed().into(),
            ScopeDone::MappingProposedAccepted => t.coverage_mapping_proposed_and_accepted().into(),
            ScopeDone::CanonicalConfirmed => t.coverage_canonical_record_confirmed().into(),
            ScopeDone::AliasAccepted => p.scope_alias_accepted().into(),
            ScopeDone::AliasRejected => p.scope_alias_rejected().into(),
            ScopeDone::AliasRevoked => p.scope_alias_revoked().into(),
            ScopeDone::AliasDeferred => p.scope_alias_deferred().into(),
        }
    }
}

/// The edition every scope's Reference Record is named in: it needs no alias to be linked
/// (`CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE`).
const CANONICAL: &str = "en";

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
}

/// Workaround for chase-sets/chase-sets#10703: admin-web derives each edition's link state from
/// the alias review in its web layer (`language-edition-review.ts`), so the pilot repeats it.
/// The canonical edition first, then the rest in order.
fn editions(scope: &ScopeRecord, review: &AliasReview) -> Vec<Edition> {
    let mut codes: Vec<&str> = scope.language_editions.iter().map(String::as_str).collect();
    codes.sort_by(|a, b| (*a != CANONICAL).cmp(&(*b != CANONICAL)).then(a.cmp(b)));
    codes.dedup();
    codes
        .into_iter()
        .map(|code| {
            let canonical = code == CANONICAL;
            let mine = review.candidates.iter().filter(|c| {
                c.target_kind == "reference-record"
                    && c.target_id.as_deref() == Some(scope.reference_record_id.as_str())
                    && c.alias_language_code == code
            });
            let pending: Vec<AliasCandidate> = mine.clone().filter(|c| c.review_status == "pending").cloned().collect();
            let accepted: Vec<AliasCandidate> =
                mine.filter(|c| matches!(c.review_status.as_str(), "accepted" | "auto-accepted")).cloned().collect();
            let link = if canonical || !accepted.is_empty() {
                Link::Linked
            } else if !pending.is_empty() {
                Link::PendingReview
            } else {
                Link::NotYetObserved
            };
            Edition { language_code: code.to_owned(), canonical, link, pending, accepted }
        })
        .collect()
}

/// Workaround for chase-sets/chase-sets#10703: the journey (`scope-journey-overview.ts`), from the
/// scope, its editions and whether their review could be read. Promotion and sync are the scopes
/// list's (chase-sets/chase-sets#10507).
fn journey(scope: &ScopeRecord, editions: Option<&[Edition]>, review_failed: bool, now: OffsetDateTime) -> Journey {
    let count = scope.language_editions.len();
    // A scope with one edition is its own canonical identity: linked, nothing to review.
    let (linked, pending) = match editions {
        Some(editions) => {
            (editions.iter().filter(|e| e.link == Link::Linked).count(), editions.iter().map(|e| e.pending.len()).sum())
        }
        None => (count, 0),
    };
    let row = scopes::row(scope.clone(), now);
    let (promotion, sync) = (row.promotion, row.sync);
    let condition = if count == 0 {
        Condition::Empty
    } else if review_failed {
        Condition::PartialFailure
    } else if matches!(promotion, Promotion::Deprecated | Promotion::Archived) {
        Condition::Blocked
    } else if pending > 0 {
        Condition::Conflict
    } else if sync == Sync::Stale {
        Condition::ProjectionLag
    } else {
        Condition::Ready
    };
    let fresh = sync == Sync::Fresh;
    let done = |yes: bool, otherwise: StageStatus| if yes { StageStatus::Complete } else { otherwise };
    let stages = vec![
        Stage { key: StageKey::Coverage, status: done(count > 0, StageStatus::Current) },
        Stage { key: StageKey::Sync, status: done(fresh, StageStatus::Current) },
        // A sync runs the live jobs: a fresh scope ran them lately, a stale one waits for the next.
        Stage { key: StageKey::Jobs, status: done(fresh, StageStatus::Upcoming) },
        Stage { key: StageKey::Candidates, status: done(pending == 0, StageStatus::Current) },
        Stage {
            key: StageKey::Promotion,
            status: match promotion {
                Promotion::Live => StageStatus::Complete,
                Promotion::Deprecated | Promotion::Archived => StageStatus::Blocked,
                Promotion::Unpublished => StageStatus::Upcoming,
            },
        },
    ];
    Journey { condition, stages, editions: count, linked, pending, promotion, sync }
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

/// The page's reads: the scope, then its coverage, jobs and (with more than one edition) the
/// alias review of its Reference Record, together.
async fn screen(caller: &Caller<'_>, id: &str, cursor: Option<&str>, now: OffsetDateTime) -> Result<ScopeScreen, ApiError> {
    let scope: ScopeRecord = caller.get(Kind::ScopeRecords, id).await?;
    let review = async {
        if scope.language_editions.len() <= 1 {
            return None;
        }
        let query = format!("?targetKind=reference-record&targetId={}", segment(&scope.reference_record_id));
        Some(caller.read_at::<AliasReview>(Kind::AliasReview, &query).await)
    };
    let coverage_at = format!("/coverage{}", under(id, &[]));
    let coverage = caller.read_at::<Coverage>(Kind::ProviderScopeMappings, &coverage_at);
    let (review, coverage, jobs) = join3(review, coverage, jobs(caller, id, cursor)).await;
    let coverage = coverage.inspect_err(|error| tracing::warn!("a scope's coverage could not be read: {error}")).ok();
    let (editions, alias_review_failed) = match review {
        None => (None, false),
        Some(Ok(review)) => (Some(editions(&scope, &review)), false),
        Some(Err(error)) => {
            tracing::warn!("a scope's alias review could not be read: {error}");
            (Some(editions(&scope, &AliasReview { candidates: Vec::new() })), true)
        }
    };
    let journey = journey(&scope, editions.as_deref(), alias_review_failed, now);
    Ok(ScopeScreen { scope, journey, coverage, jobs, editions, alias_review_failed })
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
    Params(route): Params<crate::catalog::scope::url::ScopePage<'_>>,
) -> HtmlResult {
    let (id, at) = (route.id, route.at);
    render(&req, &staff.viewer, &config, &headers, &id, &at, ScopeBack::Nothing).await
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
        Via::Scope => render(req, viewer, config, headers, id, at, back).await,
        Via::Coverage => crate::catalog::coverage::render(req, viewer, config, headers, id, at, back).await,
    }
}

/// The page; with a `back` other than nothing, a refused write's answer (422).
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    at: &ScopeAt,
    back: ScopeBack,
) -> HtmlResult {
    let receipt = Receipt::from_param(at.after_write.as_deref());
    let caller = caller(config, headers, receipt.as_ref());
    let view = match screen(&caller, id, at.jobs.as_deref(), OffsetDateTime::now_utc()).await {
        Ok(view) => view,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let notice = at.done.map(|done| done.notice(t, p, at.count.unwrap_or(0)));
    let status = if matches!(back, ScopeBack::Nothing) { StatusCode::OK } else { StatusCode::UNPROCESSABLE_ENTITY };
    let page = views::scope_page(t, p, &view, at.jobs.as_deref(), notice, back, manages(viewer));
    let html = html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_scope()} head="">{page}</crate::views::Layout>
    };
    if status == StatusCode::OK { req.screen(&view, html) } else { req.page_with_status(status, html) }
}

/// After a write: the page it came from, waiting for it, with its toast.
fn to_scope(req: &Req, id: &str, written: Option<&Written>, done: ScopeDone, count: Option<u32>, from: Via) -> HtmlResult {
    let at = ScopeAt { after_write: written.and_then(receipt), done: Some(done), count, jobs: None };
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
    use time::format_description::well_known::Rfc3339;

    fn scope(editions: &[&str], status: &str, updated_at: &str) -> ScopeRecord {
        ScopeRecord {
            scope_record_id: "scp_1".into(),
            reference_record_id: "ref_1".into(),
            product_domain: "pokemon".into(),
            scope_kind: "set".into(),
            name: "Base Set".into(),
            official_set_code: None,
            language_editions: editions.iter().map(|e| (*e).into()).collect(),
            lifecycle_status: status.into(),
            updated_at: updated_at.into(),
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
        }
    }

    const NOW: &str = "2026-10-25T00:00:00Z";

    #[test]
    fn editions_put_the_canonical_first_and_link_by_an_accepted_alias_of_this_scope_only() {
        let review = AliasReview {
            candidates: vec![
                candidate("a", "ja", "pending", "ref_1"),
                candidate("b", "de", "auto-accepted", "ref_1"),
                candidate("c", "fr", "pending", "ref_other"),
                candidate("d", "ja", "rejected", "ref_1"),
            ],
        };
        let editions = editions(&scope(&["ja", "fr", "en", "de", "ja"], "active", NOW), &review);
        let shown: Vec<(&str, Link, usize, usize)> =
            editions.iter().map(|e| (e.language_code.as_str(), e.link, e.pending.len(), e.accepted.len())).collect();
        assert_eq!(
            shown,
            [
                ("en", Link::Linked, 0, 0),
                ("de", Link::Linked, 0, 1),
                ("fr", Link::NotYetObserved, 0, 0),
                ("ja", Link::PendingReview, 1, 0),
            ]
        );
    }

    #[test]
    fn the_journey_condition_follows_admin_webs_order() {
        let now = OffsetDateTime::parse(NOW, &Rfc3339).unwrap();
        let fresh = "2026-10-20T00:00:00Z";
        let stale = "2026-09-01T00:00:00Z";
        let pending = [Edition {
            language_code: "ja".into(),
            canonical: false,
            link: Link::PendingReview,
            pending: vec![candidate("a", "ja", "pending", "ref_1")],
            accepted: Vec::new(),
        }];
        let of = |s: &ScopeRecord, editions: Option<&[Edition]>, failed| journey(s, editions, failed, now);
        assert_eq!(of(&scope(&[], "active", fresh), None, false).condition, Condition::Empty);
        assert_eq!(of(&scope(&["en", "ja"], "active", fresh), Some(&pending), true).condition, Condition::PartialFailure);
        assert_eq!(of(&scope(&["en", "ja"], "archived", fresh), Some(&pending), false).condition, Condition::Blocked);
        assert_eq!(of(&scope(&["en", "ja"], "active", stale), Some(&pending), false).condition, Condition::Conflict);
        let lag = of(&scope(&["en"], "draft", stale), None, false);
        assert_eq!((lag.condition, lag.linked, lag.pending), (Condition::ProjectionLag, 1, 0), "one edition is linked");
        let ready = of(&scope(&["en"], "active", fresh), None, false);
        assert_eq!(ready.condition, Condition::Ready);
        assert!(ready.stages.iter().all(|s| s.status == StageStatus::Complete), "{:?}", ready.stages);
        let stages: Vec<StageStatus> = lag.stages.iter().map(|s| s.status).collect();
        assert_eq!(
            stages,
            [StageStatus::Complete, StageStatus::Current, StageStatus::Upcoming, StageStatus::Complete, StageStatus::Upcoming]
        );
    }

    #[test]
    fn the_screen_is_written_as_serde_writes_it() {
        let now = OffsetDateTime::parse(NOW, &Rfc3339).unwrap();
        let s = scope(&["en", "ja"], "active", NOW);
        let review = AliasReview { candidates: vec![candidate("a", "ja", "pending", "ref_1")] };
        let editions = editions(&s, &review);
        let journey = journey(&s, Some(&editions), false, now);
        let screen = ScopeScreen {
            scope: s,
            journey,
            coverage: None,
            jobs: Some(Jobs { active: Vec::new(), failed: Vec::new(), completed: Vec::new(), next: Some("c1".into()) }),
            editions: Some(editions),
            alias_review_failed: false,
        };
        let derived: serde_json::Value = serde_json::from_str(&screen.to_json()).unwrap();
        assert_eq!(derived, serde_json::to_value(&screen).unwrap());
    }

    #[test]
    fn a_forms_ids_are_each_kept_once() {
        assert_eq!(ids(" a, b,,a ,c"), ["a", "b", "c"]);
        assert!(ids(" , ").is_empty());
    }
}
