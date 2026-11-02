//! Growth > Google Shopping (admin-web's `/growth/google-shopping`, Discovery's
//! `GoogleShoppingOperationsPage`): the feed's readiness, the filters, a row's detail and the feed
//! rows, and the three dry runs (full sync, maintenance, diagnostics). Read from and written to
//! Discovery's `/api/marketplace/google-shopping`, which asks for `google-shopping.manage`; the page
//! takes `google-shopping.view`, as its nav entry does. Live writes stay gated, as in admin-web.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /growth/google-shopping?search&filter&limit&refresh_window_days&selected&job&queued&total` | the page, with the dry run `job` that was queued |
//! | `POST /growth/google-shopping?..` | a dry run (`intent`), then the page with it |
//! | `GET /growth/google-shopping/live?job` | the dry run again each time it moves, until it is done (`<corten-live>`) |
//!
//! Inspect keeps the filters, and Close closes the detail (`selected=none`): admin-web's Inspect
//! drops the filters and its Close opens the first blocked row again (chase-sets/chase-sets#10872).
use corten::{
    Fragment, LiveResponse,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::{StreamExt, stream};
use platform::jobs::Update;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{GoogleShoppingView, Staff, Viewer},
    text::{Gro, Ops},
};

const CONTEXT: &str = "discovery";
const BASE: &str = "/api/marketplace/google-shopping";
/// The row filters, in admin-web's order; anything else is `all`.
pub const FILTERS: [&str; 9] =
    ["all", "eligible", "excluded", "failed", "disapproved", "pending-delete", "stale", "nearing-refresh", "pending-diagnostics"];
/// The limits and refresh windows admin-web offers, and its defaults.
pub const LIMITS: [u32; 4] = [25, 50, 100, 200];
pub const REFRESH_DAYS: [u32; 4] = [14, 25, 30, 45];
pub const DEFAULT_LIMIT: u32 = 100;
pub const DEFAULT_REFRESH_DAYS: u32 = 25;
/// `selected` when the detail was closed; a row's ID always starts `google-shopping:`.
pub const CLOSED: &str = "none";
/// What a dry run queued, as the address says.
pub const QUEUED: [&str; 3] = ["full-sync", "maintenance", "diagnostics"];

#[corten::routes(state = crate::app::Shared, area = crate::growth::google_shopping::url::Shopping, caller = crate::auth::Staff<crate::auth::GoogleShoppingView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The filters and the row whose detail is open ([`super::CLOSED`]: none).
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct View {
        pub search: Option<String>,
        pub filter: Option<String>,
        pub limit: Option<String>,
        pub refresh_window_days: Option<String>,
        pub selected: Option<String>,
    }

    /// The dry run that was queued: its job, what it was, and a maintenance run's candidates.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct Queued {
        pub job: Option<String>,
        pub queued: Option<String>,
        pub total: Option<String>,
    }

    /// The page; a `POST` is a dry run.
    #[derive(Clone, Debug, Default)]
    #[route("/growth/google-shopping", get = page, post = act)]
    pub struct Shopping {
        #[route(query)]
        pub view: View,
        #[route(query)]
        pub queued: Queued,
    }

    /// The dry run again each time it moves.
    #[derive(Clone, Debug, Default)]
    #[route("/growth/google-shopping/live", get = live)]
    pub struct ShoppingLive {
        #[route(query)]
        pub queued: Queued,
    }
}

/// The area: its routes, the page's stylesheet and the live status.
pub fn area(area: Area<url::Shopping>, shared: Shared) -> Area<url::Shopping> {
    url::area(area, shared).components(views::GOOGLE_SHOPPING).components(crate::views::LIVE)
}

fn positive(text: Option<&str>, fallback: u32) -> u32 {
    text.and_then(|t| t.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n >= 1.0).map_or(fallback, |n| n as u32)
}

impl url::View {
    /// The row filter asked for, if it is one of admin-web's.
    pub fn filter(&self) -> &'static str {
        let asked = self.filter.as_deref().unwrap_or("all");
        FILTERS.into_iter().find(|f| *f == asked).unwrap_or("all")
    }

    pub fn search(&self) -> &str {
        self.search.as_deref().map_or("", str::trim)
    }

    /// admin-web's `readPositiveInteger`: a positive number, floored, or the default.
    pub fn limit(&self) -> u32 {
        positive(self.limit.as_deref(), DEFAULT_LIMIT)
    }

    pub fn refresh_window_days(&self) -> u32 {
        positive(self.refresh_window_days.as_deref(), DEFAULT_REFRESH_DAYS)
    }

    /// The filters as the API's query (`googleShoppingOperationsListQuery`).
    pub fn query(&self) -> String {
        let mut query =
            format!("filter={}&limit={}&refreshWindowDays={}", self.filter(), self.limit(), self.refresh_window_days());
        if !self.search().is_empty() {
            query.push_str(&format!("&search={}", segment(self.search())));
        }
        query
    }

    /// The same filters with `selected` set (Inspect), or closed ([`CLOSED`]).
    pub fn with_selected(&self, row: &str) -> url::Shopping {
        url::Shopping { view: url::View { selected: Some(row.to_owned()), ..self.clone() }, queued: url::Queued::default() }
    }

    /// The filters that differ from admin-web's defaults (its applied filter chips).
    pub fn applied(&self) -> bool {
        !self.search().is_empty()
            || self.filter() != "all"
            || self.limit() != DEFAULT_LIMIT
            || self.refresh_window_days() != DEFAULT_REFRESH_DAYS
    }
}

impl url::Queued {
    pub fn job(&self) -> Option<&str> {
        self.job.as_deref().map(str::trim).filter(|j| !j.is_empty())
    }

    pub fn kind(&self) -> Option<&'static str> {
        let asked = self.queued.as_deref()?;
        QUEUED.into_iter().find(|q| *q == asked)
    }
}

/// The feed's figures (`GoogleShoppingFeedRowList.summary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Summary {
    pub total_rows: u64,
    pub attention_rows: u64,
    pub eligible_rows: u64,
    pub excluded_rows: u64,
    pub failed_rows: u64,
    pub disapproved_rows: u64,
    pub pending_delete_rows: u64,
    pub stale_rows: u64,
    pub nearing_refresh_rows: u64,
    pub pending_diagnostics_rows: u64,
}

/// A feed row (`GoogleShoppingFeedRowListItem`), as far as the page shows it.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Row {
    pub row_id: String,
    pub listing_id: String,
    pub title: Option<String>,
    pub account_id: String,
    pub catalog_item_id: String,
    pub product_id: String,
    pub merchant_offer_id: String,
    pub external_seller_id: String,
    pub canonical_url: String,
    pub eligibility_status: String,
    pub exclusion_reasons: Vec<String>,
    pub image_eligibility_status: String,
    pub image_exclusion_reasons: Vec<String>,
    pub sync_status: String,
    pub diagnostic_status: Option<String>,
    pub active_issue_count: u64,
    pub unknown_issue_code_count: u64,
    pub blocking_issue_count: u64,
    pub remediation_owners: Vec<String>,
    pub pending_delete: bool,
    pub stale: bool,
    pub payload_hash: Option<String>,
    pub last_submitted_payload_hash: Option<String>,
    pub last_submitted_at: Option<String>,
    pub last_accepted_at: Option<String>,
    pub last_sync_error_code: Option<String>,
    pub last_sync_error_message: Option<String>,
    pub last_provider_operation: Option<String>,
    pub last_diagnostic_at: Option<String>,
    pub shipping_policy_url: Option<String>,
    pub return_policy_url: Option<String>,
    pub return_policy_label: Option<String>,
    pub updated_at: String,
}

impl Row {
    /// The row's exclusion reasons and its image's, once each (`EligibilityCell`).
    pub fn reasons(&self) -> Vec<&str> {
        let mut seen: Vec<&str> = Vec::new();
        for reason in self.exclusion_reasons.iter().chain(&self.image_exclusion_reasons) {
            if !seen.contains(&reason.as_str()) {
                seen.push(reason);
            }
        }
        seen
    }
}

/// The feed (`GoogleShoppingFeedRowList`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Feed {
    pub generated_at: String,
    pub refresh_cutoff: String,
    pub summary: Summary,
    pub rows: Vec<Row>,
}

/// A dry run's progress (`GoogleShoppingFullSyncJobProgress`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Progress {
    pub completed: u64,
    pub total: u64,
    pub current_row_id: Option<String>,
    pub submitted: u64,
    pub skipped: u64,
    pub deleted: u64,
    pub failed: u64,
    pub excluded: u64,
    pub message: Option<String>,
}

/// A dry run (`GoogleShoppingFullSyncJobStatus`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub job_kind: String,
    pub status: String,
    pub progress: Progress,
    pub error_message: Option<String>,
    pub updated_at: Option<String>,
}

impl Job {
    /// Done: the job store's last two states.
    pub fn done(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

/// A maintenance dry run's answer: what it found, and the job when it found any.
#[derive(Deserialize)]
struct Maintenance {
    summary: MaintenanceSummary,
    job: Option<Job>,
}

#[derive(Deserialize)]
struct MaintenanceSummary {
    total: u64,
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct ShoppingScreen {
    pub feed: Feed,
    #[serde(skip)]
    pub view: url::View,
    #[serde(skip)]
    pub queued: url::Queued,
    /// The dry run that was queued, as the API last read it.
    pub job: Option<Job>,
    /// Why the last dry run was refused.
    pub error: Option<String>,
    #[serde(skip)]
    pub links: Links,
}

/// The links the viewer may follow (admin-web's permission checks).
#[derive(Clone, Copy, Debug, Default)]
pub struct Links {
    pub accounts: bool,
    pub catalog: bool,
    pub projections: bool,
}

impl ShoppingScreen {
    /// The row whose detail is open: the one selected, else the first with blocking issues
    /// (`resolveSelectedRow`); none once closed.
    pub fn selected(&self) -> Option<&Row> {
        match self.view.selected.as_deref() {
            Some(CLOSED) => None,
            Some(id) => self.feed.rows.iter().find(|r| r.row_id == id).or_else(|| self.first_blocked()),
            None => self.first_blocked(),
        }
    }

    fn first_blocked(&self) -> Option<&Row> {
        self.feed.rows.iter().find(|r| r.blocking_issue_count > 0)
    }
}

async fn read(
    config: &Shared,
    headers: &HeaderMap,
    viewer: &Viewer,
    view: &url::View,
    queued: &url::Queued,
) -> Result<ShoppingScreen, crate::api::ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let list = format!("{BASE}/feed-rows?{}", view.query());
    let job_path = queued.job().map(|j| format!("{BASE}/sync-jobs/{}", segment(j)));
    let (feed, job) = tokio::try_join!(caller.read::<Feed>(&list, CONTEXT), async {
        match &job_path {
            // A job that is not known: an old address; show it waiting, as admin-web does.
            Some(path) => match caller.read::<Job>(path, CONTEXT).await {
                Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
                found => found.map(Some),
            },
            None => Ok(None),
        }
    })?;
    Ok(ShoppingScreen {
        feed,
        view: view.clone(),
        queued: queued.clone(),
        job,
        error: None,
        links: Links {
            accounts: viewer.can("accounts.view"),
            catalog: viewer.can("catalog.view"),
            projections: viewer.can("security.manage"),
        },
    })
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<GoogleShoppingView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Shopping>,
) -> HtmlResult {
    match read(&config, &headers, &staff.viewer, &route.view, &route.queued).await {
        Ok(screen) => draw(&req, &staff.viewer, &screen, StatusCode::OK),
        Err(error) => read_failed(&req, error, false),
    }
}

fn draw(req: &Req, viewer: &Viewer, screen: &ShoppingScreen, status: StatusCode) -> HtmlResult {
    let (t, o): (Gro, Ops) = (req.t(), req.t());
    let view = html! { <views::GoogleShoppingPage t={t} o={o} screen={screen} /> };
    req.screen_with_status(
        status,
        screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.gs_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct DryRun {
    intent: String,
}

/// Queues a dry run with the page's limit and refresh window (admin-web's hidden fields) and shows
/// it, keeping the filters. A live intent or an unknown one queues nothing: the page offers neither.
async fn act(
    req: Req,
    Caller(staff): Caller<Staff<GoogleShoppingView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Shopping>,
    Form(form): Form<DryRun>,
) -> HtmlResult {
    let view = route.view;
    let caller = config.platform.caller(&headers, config.proto, None);
    let post = |path: &str, body: Value| caller.request(Method::POST, &format!("{BASE}{path}"), CONTEXT).json(&body);
    let shown = |job: Option<String>, kind: &str, total: Option<u64>| {
        req.redirect(&url::Shopping {
            view: view.clone(),
            queued: url::Queued { job, queued: Some(kind.to_owned()), total: total.map(|t| t.to_string()) },
        })
    };
    let answer = match form.intent.as_str() {
        "dry-run-full-sync" => caller
            .write::<Job>(post("/sync-jobs", json!({ "mode": "dry-run", "batchSize": view.limit() })))
            .await
            .map(|(job, _)| shown(Some(job.job_id), "full-sync", None)),
        "dry-run-maintenance-sync" => caller
            .write::<Maintenance>(post(
                "/maintenance/sync-jobs",
                json!({ "mode": "dry-run", "limit": view.limit(), "refreshWindowDays": view.refresh_window_days() }),
            ))
            .await
            .map(|(found, _)| shown(found.job.map(|j| j.job_id), "maintenance", Some(found.summary.total))),
        "dry-run-diagnostics-refresh" => caller
            .write::<Job>(post("/diagnostics/refresh-jobs", json!({ "mode": "dry-run", "batchSize": view.limit() })))
            .await
            .map(|(job, _)| shown(Some(job.job_id), "diagnostics", None)),
        _ => return req.redirect(&url::Shopping { view, queued: url::Queued::default() }),
    };
    match answer {
        Ok(answer) => answer,
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Err(error) => {
            let t: Gro = req.t();
            let (message, status) = match error.status() {
                Some(status) if status.is_client_error() => {
                    let status = if status == StatusCode::FORBIDDEN { status } else { StatusCode::UNPROCESSABLE_ENTITY };
                    (error.refusal().unwrap_or(t.gs_request_failed()).to_owned(), status)
                }
                _ => {
                    tracing::warn!("a Google Shopping dry run failed to start: {error}");
                    (t.gs_request_failed().to_owned(), StatusCode::BAD_GATEWAY)
                }
            };
            match read(&config, &headers, &staff.viewer, &view, &url::Queued::default()).await {
                Ok(screen) => draw(&req, &staff.viewer, &ShoppingScreen { error: Some(message), ..screen }, status),
                Err(error) => read_failed(&req, error, false),
            }
        }
    }
}

/// The dry run, drawn again each time its status stream says it moved, until it is done
/// (`/sync-jobs/{id}/events`). None, or one done, streams nothing.
async fn live(
    req: Req,
    Caller(_): Caller<Staff<GoogleShoppingView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::ShoppingLive>,
) -> LiveResponse {
    let t: Gro = req.t();
    let Some(id) = route.queued.job().map(str::to_owned) else { return corten::live(stream::empty::<String>()) };
    let caller = config.platform.caller(&headers, config.proto, None);
    let path = format!("{BASE}/sync-jobs/{}/events", segment(&id));
    let updates = caller.watch_job::<Job>(&path, CONTEXT, None, Job::done);
    drop(caller);
    let mut last: Option<(String, u64)> = None;
    let fragments = updates.filter_map(move |update| {
        std::future::ready(match update {
            Update::Job(job, _) => {
                let seen = Some((job.status.clone(), job.progress.completed));
                (seen != last).then(|| {
                    last = seen;
                    Fragment::new(views::job_part(t, &id, Some(&job)).to_html())
                })
            }
            Update::Refused(_) => None,
        })
    });
    corten::live(fragments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filters_read_as_admin_webs() {
        let view = url::View {
            search: Some("  box ".into()),
            filter: Some("nonsense".into()),
            limit: Some("12.9".into()),
            refresh_window_days: Some("-3".into()),
            selected: None,
        };
        assert_eq!((view.filter(), view.limit(), view.refresh_window_days()), ("all", 12, DEFAULT_REFRESH_DAYS));
        assert_eq!(view.query(), "filter=all&limit=12&refreshWindowDays=25&search=box");
        assert!(view.applied());
        assert!(!url::View::default().applied());
    }

    #[test]
    fn a_rows_reasons_are_its_own_and_its_images_once() {
        let row = Row {
            exclusion_reasons: vec!["invalid-image-url".into(), "missing-condition".into()],
            image_exclusion_reasons: vec!["invalid-image-url".into()],
            ..Row::default()
        };
        assert_eq!(row.reasons(), ["invalid-image-url", "missing-condition"]);
    }
}
