//! Commerce > Money Health and Payout Operations (admin-web's `/commerce/money-health` and
//! `/commerce/payout-operations`, Settlement's `SettlementMoneyHealthPage` and
//! `SettlementPayoutOperationsPage`): the platform balance forecast, the provider's diagnostics,
//! negative balances, the payouts that need attention and recent reconciliation; and the payouts
//! needing reconciliation by filter, what needs attention, the payout setup's readiness, recent
//! provider attempts and a reconciliation run. Read from Settlement's `/api/settlement` as the
//! signed-in staff member: either page needs `payouts.reconcile` or `payouts.platform.view`, as its
//! nav entry does; the readiness, the attempts and a run need `payouts.reconcile`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/money-health` | Money Health |
//! | `GET /commerce/payout-operations?filter&job` | Payout Operations, with the run `job` started |
//! | `POST /commerce/payout-operations?filter` | a run (`intent=run-reconciliation`), then the page with it |
//! | `GET /commerce/payout-operations/live?filter&job` | the run again each time it moves, until it is done (`<corten-live>`) |
//!
//! admin-web shows a run as the API first answered it (queued) and forgets it on the next load. The
//! pilot sends the run's ID back in the address and reads the run there, so a reload shows where it
//! is, and with JavaScript it follows the run's status stream until it is done.
use corten::{
    Fragment, LiveResponse,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::{StreamExt, stream};
use jiff::Timestamp;
use platform::jobs::Update;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::views;
use crate::{
    api::{Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{PayoutAccess, Staff, Viewer},
    text::{Com, Pilot},
};

const CONTEXT: &str = "settlement";
const BASE: &str = "/api/settlement";
/// What a run asks for (admin-web's `runPayoutReconciliation({ limit: 100 })`).
const RUN_LIMIT: u32 = 100;
/// The filters, in admin-web's order; `all` asks the API for no filter.
pub const FILTERS: [&str; 5] = ["all", "missing-provider-reference", "in-transit", "failed", "stale-requested"];

/// Money Health's route: an area of its own, as an area's routes are under its prefix.
#[corten::routes(state = crate::app::Shared, area = crate::commerce::payouts::health_url::MoneyHealth, caller = crate::auth::Staff<crate::auth::PayoutAccess>)]
pub mod health_url {
    #[route("/commerce/money-health", get = health)]
    pub struct MoneyHealth;
}

#[corten::routes(state = crate::app::Shared, area = crate::commerce::payouts::url::Operations, caller = crate::auth::Staff<crate::auth::PayoutAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    pub use super::health_url::MoneyHealth;

    /// The filter and the run the page shows.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct View {
        pub filter: Option<String>,
        pub job: Option<String>,
    }

    /// Payout Operations; a `POST` starts a run.
    #[derive(Clone, Debug, Default)]
    #[route("/commerce/payout-operations", get = operations, post = run)]
    pub struct Operations {
        #[route(query)]
        pub view: View,
    }

    /// The run again each time it moves.
    #[derive(Clone, Debug, Default)]
    #[route("/commerce/payout-operations/live", get = live)]
    pub struct OperationsLive {
        #[route(query)]
        pub view: View,
    }
}

/// Money Health's area: its route and the pages' stylesheet.
pub fn health_area(area: Area<health_url::MoneyHealth>, shared: Shared) -> Area<health_url::MoneyHealth> {
    health_url::area(area, shared).components(views::PAYOUTS)
}

/// Payout Operations' area: its routes, the pages' stylesheet and the live status it shares with
/// the other areas.
pub fn area(area: Area<url::Operations>, shared: Shared) -> Area<url::Operations> {
    url::area(area, shared).components(views::PAYOUTS).components(crate::views::LIVE)
}

impl url::View {
    /// The filter asked for, if it is one of admin-web's; anything else is All, as its buttons only
    /// ever send these.
    pub fn filter(&self) -> &'static str {
        let asked = self.filter.as_deref().unwrap_or("all");
        FILTERS.into_iter().find(|f| *f == asked).unwrap_or("all")
    }

    fn job(&self) -> Option<&str> {
        self.job.as_deref().map(str::trim).filter(|j| !j.is_empty())
    }
}

/// A payout (`SettlementPayoutRow`), as far as the pages show it; amounts are decimal text.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Payout {
    pub payout_id: String,
    pub status: String,
    pub requested_amount: String,
    pub fee_amount: String,
    pub net_amount: String,
    pub currency_code: String,
    #[serde(default)]
    pub provider_payout_reference: Option<String>,
    #[serde(default)]
    pub provider_status: Option<String>,
    #[serde(default)]
    pub last_reconciled_at: Option<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub next_retry_at: Option<String>,
    pub updated_at: String,
}

/// An account whose wallet is below zero (`SettlementWalletRow`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Negative {
    pub account_id: String,
    pub negative_balance_status: String,
    pub available_balance_amount: String,
    pub currency_code: String,
    #[serde(default)]
    pub negative_balance_started_at: Option<String>,
    #[serde(default)]
    pub collections_escalated_at: Option<String>,
}

/// A reconciliation run (`SettlementReconciliationRunRow`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Reconciliation {
    pub reconciliation_run_id: String,
    pub status: String,
    pub checked_count: u64,
    pub reconciled_count: u64,
    pub error_count: u64,
    #[serde(default)]
    pub completed_at: Option<String>,
}

/// The platform balance after the payouts asked for.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Forecast {
    pub currency_code: String,
    pub available_amount: String,
    pub pending_payout_demand_amount: String,
    pub forecast_after_pending_demand_amount: String,
}

/// What the payment provider's adapter can do.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ProviderHealth {
    pub provider_name: String,
    pub adapter_mode: String,
    pub webhook_signature_required: bool,
    #[serde(default)]
    pub webhook_failure_classes: Vec<String>,
    pub platform_balance_supported: bool,
    pub connected_account_payouts_supported: bool,
}

/// Money Health's one read (`GET /money-health`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct MoneyHealth {
    pub payouts_needing_attention: Vec<Payout>,
    pub negative_balance_accounts: Vec<Negative>,
    pub reconciliation_runs: Vec<Reconciliation>,
    pub platform_balance_forecast: Forecast,
    pub provider_health: ProviderHealth,
}

/// The payout setup's readiness (`SettlementPayoutReadinessRow`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Readiness {
    pub status: String,
    #[serde(default)]
    pub provider_reference: Option<String>,
    #[serde(default)]
    pub missing_requirements: Vec<String>,
    pub payout_destination_status: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// A provider call the payouts made (`SettlementProviderIdempotencyKeyRow`); the key itself is not
/// shown.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Attempt {
    pub operation_key: String,
    pub operation_kind: String,
    #[serde(default)]
    pub payout_id: Option<String>,
    #[serde(default)]
    pub provider_object_reference: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
struct List<T> {
    items: Vec<T>,
}

/// A run's progress (`DurableJobPublicSnapshot`'s).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Progress {
    #[serde(default)]
    pub completed: u64,
    #[serde(default)]
    pub message: Option<String>,
}

/// A payout a run could not reconcile.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct RunError {
    pub message: String,
}

/// What a finished run did.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Outcome {
    pub checked: u64,
    pub reconciled: u64,
    pub ignored: u64,
    pub skipped: u64,
    #[serde(default)]
    pub errors: Vec<RunError>,
}

/// A reconciliation run (the API's job snapshot).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub progress: Progress,
    #[serde(default)]
    pub result: Option<Outcome>,
    #[serde(default)]
    pub error_message: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl Run {
    /// Done: the job store's last two states.
    pub fn done(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

/// Payout Operations as drawn.
#[derive(Serialize, ToJson)]
pub struct OperationsScreen {
    pub payouts: Vec<Payout>,
    /// Whether the staff member may reconcile: the readiness, the attempts and a run.
    pub can_reconcile: bool,
    pub readiness: Option<Readiness>,
    pub attempts: Vec<Attempt>,
    pub filter: &'static str,
    /// The run the address names, if the API knows it.
    pub run: Option<Run>,
    /// Why the run asked for did not start.
    pub error: Option<String>,
    #[serde(skip)]
    pub view: url::View,
    #[serde(skip)]
    pub now: Timestamp,
}

/// What needs attention: admin-web's counts, worked out by the page (chase-sets/chase-sets#10867).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Attention {
    pub failed: usize,
    pub missing_reference: usize,
    pub retry_queued: usize,
    pub stale_checks: usize,
    pub setup_blocked: bool,
    pub setup_stale: bool,
    pub setup_requirements: usize,
}

/// Milliseconds since `at`, or none when it does not parse.
fn age(now: Timestamp, at: &str) -> Option<i64> {
    at.parse::<Timestamp>().ok().map(|at| now.as_millisecond() - at.as_millisecond())
}

impl OperationsScreen {
    /// admin-web's counts: a payout not reconciled for 30 minutes (or never, unless only
    /// requested) is a stale check; the setup is blocked unless ready with a provider reference,
    /// and stale once 30 days old.
    pub fn attention(&self) -> Attention {
        let payouts = &self.payouts;
        let stale = |p: &&Payout| match &p.last_reconciled_at {
            None => p.status != "requested",
            Some(at) => age(self.now, at).is_some_and(|ms| ms > 30 * 60 * 1000),
        };
        let readiness = self.readiness.as_ref();
        Attention {
            failed: payouts.iter().filter(|p| p.status == "failed").count(),
            missing_reference: payouts.iter().filter(|p| p.provider_payout_reference.is_none()).count(),
            retry_queued: payouts.iter().filter(|p| p.next_retry_at.is_some()).count(),
            stale_checks: payouts.iter().filter(stale).count(),
            setup_blocked: readiness.is_some_and(|r| r.status != "ready" || r.provider_reference.is_none()),
            setup_stale: readiness
                .and_then(|r| r.updated_at.as_deref())
                .and_then(|at| age(self.now, at))
                .is_some_and(|ms| ms > 30 * 24 * 60 * 60 * 1000),
            setup_requirements: readiness.map_or(0, |r| r.missing_requirements.len()),
        }
    }
}

/// A payout's page on Marketplace (admin-web's `payoutDetailHref`), or none without its origin.
pub fn payout_href(origin: Option<&str>, payout_id: &str) -> Option<String> {
    let origin = origin?.trim_end_matches('/');
    Some(format!("{origin}/account/desk/payouts/{}", segment(payout_id)))
}

async fn health(
    req: Req,
    Caller(staff): Caller<Staff<PayoutAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let screen = match caller.read::<MoneyHealth>(&format!("{BASE}/money-health"), CONTEXT).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Com = req.t();
    let view = html! { <views::MoneyHealthPage t={t} screen={&screen} marketplace={crate::app::marketplace_origin()} /> };
    req.screen(&screen, layout(&req, &staff.viewer, t.mh_route_title(), view))
}

fn layout<'a, V: Render + 'a>(req: &'a Req, viewer: &'a Viewer, title: &'a str, view: V) -> impl Document + 'a {
    html! {
        <crate::views::Layout req={req} viewer={Some(viewer)} title={title} head="">
            {view}
        </crate::views::Layout>
    }
}

/// Payout Operations' reads: the payouts by filter, and with `payouts.reconcile` the setup's
/// readiness and the last 10 provider attempts (admin-web's loader); and the run asked for.
async fn read(
    config: &Shared,
    headers: &HeaderMap,
    viewer: &Viewer,
    view: &url::View,
) -> Result<OperationsScreen, crate::api::ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let can_reconcile = viewer.can(crate::auth::RECONCILE);
    let filter = view.filter();
    let list = match filter {
        "all" => format!("{BASE}/payouts/reconciliation"),
        f => format!("{BASE}/payouts/reconciliation?filter={}", segment(f)),
    };
    let readiness_path = format!("{BASE}/payout-readiness");
    let attempts_path = format!("{BASE}/payouts/provider-idempotency?limit=10");
    let job_path = view.job().map(|j| format!("{BASE}/payouts/reconciliation/jobs/{}", segment(j)));
    let (payouts, readiness, attempts, run) = tokio::try_join!(
        caller.read::<List<Payout>>(&list, CONTEXT),
        async { if can_reconcile { caller.read::<Readiness>(&readiness_path, CONTEXT).await.map(Some) } else { Ok(None) } },
        async {
            if can_reconcile {
                caller.read::<List<Attempt>>(&attempts_path, CONTEXT).await.map(|l| l.items)
            } else {
                Ok(Vec::new())
            }
        },
        async {
            match &job_path {
                // A run that is not known (or not this account's): an old address; show none.
                Some(path) => match caller.read::<Run>(path, CONTEXT).await {
                    Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
                    found => found.map(Some),
                },
                None => Ok(None),
            }
        },
    )?;
    Ok(OperationsScreen {
        payouts: payouts.items,
        can_reconcile,
        readiness,
        attempts,
        filter,
        run,
        error: None,
        view: view.clone(),
        now: Timestamp::now(),
    })
}

async fn operations(
    req: Req,
    Caller(staff): Caller<Staff<PayoutAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Operations>,
) -> HtmlResult {
    match read(&config, &headers, &staff.viewer, &route.view).await {
        Ok(screen) => draw(&req, &staff.viewer, &screen, StatusCode::OK),
        Err(error) => read_failed(&req, error, false),
    }
}

fn draw(req: &Req, viewer: &Viewer, screen: &OperationsScreen, status: StatusCode) -> HtmlResult {
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let o: crate::text::Ops = req.t();
    let view = html! {
        <views::PayoutOperationsPage t={t} p={p} o={o} screen={screen} marketplace={crate::app::marketplace_origin()} />
    };
    req.screen_with_status(status, screen, layout(req, viewer, t.po_route_title(), view))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RunForm {
    intent: String,
}

/// Starts a run and shows it, keeping the filter. An unknown intent does nothing, as admin-web's
/// action answers none; a refused run draws the page with why.
async fn run(
    req: Req,
    Caller(staff): Caller<Staff<PayoutAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Operations>,
    Form(form): Form<RunForm>,
) -> HtmlResult {
    let view = url::View { filter: route.view.filter.clone(), job: None };
    if form.intent != "run-reconciliation" {
        return req.redirect(&url::Operations { view });
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let request =
        caller.request(Method::POST, &format!("{BASE}/payouts/reconciliation/run"), CONTEXT).json(&json!({ "limit": RUN_LIMIT }));
    match caller.write::<Run>(request).await {
        Ok((run, _)) => req.redirect(&url::Operations { view: url::View { job: Some(run.job_id), ..view } }),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Err(error) => {
            let p: Pilot = req.t();
            let (message, status) = match error.status() {
                Some(status) if status.is_client_error() => {
                    let status = if status == StatusCode::FORBIDDEN { status } else { StatusCode::UNPROCESSABLE_ENTITY };
                    (error.refusal().unwrap_or(p.error_failed()).to_owned(), status)
                }
                _ => {
                    tracing::warn!("a payout reconciliation run failed to start: {error}");
                    (p.error_failed().to_owned(), StatusCode::BAD_GATEWAY)
                }
            };
            match read(&config, &headers, &staff.viewer, &view).await {
                Ok(screen) => draw(&req, &staff.viewer, &OperationsScreen { error: Some(message), ..screen }, status),
                Err(error) => read_failed(&req, error, false),
            }
        }
    }
}

/// The run, drawn again each time its status stream says it moved, until it is done
/// (`/payouts/reconciliation/jobs/{id}/events`). A run that is done, or none, streams nothing.
async fn live(
    req: Req,
    Caller(_): Caller<Staff<PayoutAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::OperationsLive>,
) -> LiveResponse {
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let Some(job) = route.view.job().map(str::to_owned) else { return corten::live(stream::empty::<String>()) };
    let caller = config.platform.caller(&headers, config.proto, None);
    let path = format!("{BASE}/payouts/reconciliation/jobs/{}/events", segment(&job));
    let updates = caller.watch_job::<Run>(&path, CONTEXT, None, Run::done);
    drop(caller);
    let mut last: Option<(String, u64)> = None;
    let fragments = updates.filter_map(move |update| {
        std::future::ready(match update {
            Update::Job(run, _) => {
                let seen = Some((run.status.clone(), run.progress.completed));
                (seen != last).then(|| {
                    last = seen;
                    Fragment::new(
                        views::run_part(t, p, Some(&run), &url::View { job: Some(job.clone()), ..route.view.clone() }).to_html(),
                    )
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

    fn payout(status: &str, reference: Option<&str>, reconciled: Option<&str>, retry: Option<&str>) -> Payout {
        Payout {
            payout_id: "pyo_1".into(),
            status: status.into(),
            requested_amount: "20.00".into(),
            fee_amount: "0.00".into(),
            net_amount: "20.00".into(),
            currency_code: "usd".into(),
            provider_payout_reference: reference.map(Into::into),
            provider_status: None,
            last_reconciled_at: reconciled.map(Into::into),
            retry_count: 0,
            next_retry_at: retry.map(Into::into),
            updated_at: "2026-10-30T11:00:00.000Z".into(),
        }
    }

    #[test]
    fn attention_counts_as_admin_web_does() {
        let screen = OperationsScreen {
            payouts: vec![
                payout("failed", None, Some("2026-10-30T11:50:00.000Z"), Some("2026-10-30T12:15:00.000Z")),
                payout("in-transit", Some("po_1"), Some("2026-10-30T11:00:00.000Z"), None),
                payout("requested", None, None, None),
                payout("in-transit", Some("po_2"), None, None),
            ],
            can_reconcile: true,
            readiness: Some(Readiness {
                status: "ready".into(),
                provider_reference: Some("acct_1".into()),
                missing_requirements: vec!["external_account".into()],
                payout_destination_status: "ready".into(),
                updated_at: Some("2026-09-01T00:00:00.000Z".into()),
            }),
            attempts: Vec::new(),
            filter: "all",
            run: None,
            error: None,
            view: url::View::default(),
            now: "2026-10-30T12:00:00Z".parse().unwrap(),
        };
        let attention = screen.attention();
        assert_eq!(
            attention,
            Attention {
                failed: 1,
                missing_reference: 2,
                retry_queued: 1,
                // 30 minutes after 11:00, and never checked though sent; a requested one is not stale.
                stale_checks: 2,
                setup_blocked: false,
                setup_stale: true,
                setup_requirements: 1,
            }
        );
        let blocked = OperationsScreen {
            readiness: Some(Readiness { provider_reference: None, updated_at: None, ..screen.readiness.clone().unwrap() }),
            ..screen
        };
        assert!(blocked.attention().setup_blocked && !blocked.attention().setup_stale);
    }

    #[test]
    fn a_filter_is_one_of_admin_webs_and_a_payout_link_needs_marketplace() {
        let view = |f: &str| url::View { filter: Some(f.into()), job: None };
        assert_eq!(view("failed").filter(), "failed");
        assert_eq!(view("anything").filter(), "all");
        assert_eq!(url::View::default().filter(), "all");
        assert_eq!(payout_href(None, "pyo_1"), None);
        assert_eq!(
            payout_href(Some("https://market.example/"), "pyo 1").as_deref(),
            Some("https://market.example/account/desk/payouts/pyo%201")
        );
    }
}
