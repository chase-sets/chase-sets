//! Pricing health (marketplace's `account-desk-pricing-health`, `/account/desk/pricing-health`): a
//! stored verdict for one active policy (its nine signals per currency), the pricing goals the
//! Adoption Gate cleared, their candidate runs compared, Apply goal behind a confirmation, and the
//! platform's forecast grades.
//!
//! The read is Pricing's, for the policy the address names (`?policyId=`) or its choice of one.
//! Compute verdict and Compare goals post to the page and go back to it for that policy; Apply
//! goal answers with the page and what it changed, as marketplace's action does. While a verdict
//! is computing the page reads itself again every 2 s (`ReadAgain`, which marketplace's
//! `useRevalidator` does with a script). A read that fails on Pricing's side is the page with
//! the error and Retry (502), as marketplace's `loadFailed` is; a policy Pricing does not know is a
//! 404. The writes are for a seller with `pricing.manage` (`PricingManager` refuses a post
//! otherwise); a reader sees the page without them.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Deserialize;

use crate::{
    api::{ApiError, AppliedGoal, ApplyGoal, PricingHealth, PricingHealthCalls as _},
    app::{Shared, read_failed, sign_in, url},
    auth::{PricingManager, Viewer},
    text::RepricingMsg,
    views::{self, Layout},
};

/// The page's address: the policy it shows.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct Place {
    #[serde(rename = "policyId")]
    pub policy_id: Option<String>,
}

impl Place {
    fn policy(&self) -> Option<&str> {
        self.policy_id.as_deref().map(str::trim).filter(|id| !id.is_empty())
    }

    pub fn of(policy: &str) -> Place {
        Place { policy_id: Some(policy.to_owned()) }
    }
}

/// A write: Compute verdict, Compare goals, or Apply goal with the candidate the page showed
/// (marketplace's hidden fields).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct HealthForm {
    pub intent: String,
    #[serde(rename = "policyId")]
    pub policy_id: String,
    #[serde(rename = "dryRunId")]
    pub dry_run_id: String,
    #[serde(rename = "targetRevision")]
    pub target_revision: String,
    #[serde(rename = "targetBodyHash")]
    pub target_body_hash: String,
    #[serde(rename = "candidateBodyHash")]
    pub candidate_body_hash: String,
    #[serde(rename = "goalId")]
    pub goal_id: String,
    #[serde(rename = "goalVersion")]
    pub goal_version: String,
    /// The goal's parameters as JSON, as the page wrote them.
    pub parameters: String,
}

impl HealthForm {
    /// Apply goal's request, or `None` when a field is missing or not what the page wrote
    /// (Pricing's `validApplyGoalRequest`).
    fn apply(&self) -> Option<ApplyGoal> {
        let revision: u64 = self.target_revision.trim().parse().ok().filter(|n| *n > 0)?;
        let version: u64 = self.goal_version.trim().parse().ok().filter(|n| *n > 0)?;
        let parameters: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&self.parameters).ok()?;
        if !parameters.values().all(|v| v.as_f64().is_some_and(f64::is_finite)) {
            return None;
        }
        let text = |s: &str| Some(s.trim().to_owned()).filter(|s| !s.is_empty());
        Some(ApplyGoal {
            dry_run_id: text(&self.dry_run_id)?,
            target_revision: revision,
            target_body_hash: text(&self.target_body_hash)?,
            candidate_body_hash: text(&self.candidate_body_hash)?,
            goal_id: text(&self.goal_id)?,
            goal_version: version,
            parameters,
        })
    }
}

/// What the page shows.
pub struct HealthScreen {
    /// Pricing's read; `None` when it failed on Pricing's side.
    pub data: Option<PricingHealth>,
    /// What failed: the read, or a write.
    pub error: Option<String>,
    /// What Apply goal changed.
    pub applied: Option<AppliedGoal>,
    /// The page's address, for Retry.
    pub here: String,
}

#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    error: Option<String>,
    applied: Option<AppliedGoal>,
    status: StatusCode,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let (data, error, status) = match caller.pricing_health(place.policy()).await {
        Ok(data) => (Some(data), error, status),
        Err(read) => match read.status() {
            Some(StatusCode::NOT_FOUND) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
            Some(s) if s.is_client_error() => return read_failed(req, Some(viewer), read, None),
            _ => {
                tracing::warn!("pricing health's read failed: {read}");
                (None, Some(error.unwrap_or_else(|| t.health_error_description().to_owned())), StatusCode::BAD_GATEWAY)
            }
        },
    };
    let computing = data.as_ref().is_some_and(|d| d.computing);
    let screen = HealthScreen { data, error, applied, here: url::PricingHealth { place: place.clone() }.href() };
    let head = html! {
        <meta name="robots" content="noindex">
        if computing {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.pricing_health()} head={head}>
            <views::PricingHealthPage t={t} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, for the policy its address names.
pub(crate) async fn page(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::PricingHealth>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.place, None, None, StatusCode::OK).await
}

/// Compute verdict, Compare goals and Apply goal. A refusal is the page with marketplace's words
/// (`goals.applyError` for a refused goal, `computeError` for the rest).
pub(crate) async fn write(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<HealthForm>,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let policy = form.policy_id.trim().to_owned();
    let place = if policy.is_empty() { Place::default() } else { Place::of(&policy) };
    let refused = |words: &str, status| (Some(words.to_owned()), status);
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome: Result<Option<AppliedGoal>, ApiError> = match (form.intent.as_str(), policy.is_empty()) {
        (command @ ("compute" | "compare"), false) => caller.pricing_health_command(&policy, command).await.map(|()| None),
        ("apply", false) => match form.apply() {
            Some(goal) => caller.apply_pricing_goal(&policy, &goal).await.map(Some),
            None => {
                let (error, status) = refused(t.health_compute_error(), StatusCode::UNPROCESSABLE_ENTITY);
                return render(&req, &viewer, &config, &headers, &place, error, None, status).await;
            }
        },
        _ => {
            let (error, status) = refused(t.health_compute_error(), StatusCode::UNPROCESSABLE_ENTITY);
            return render(&req, &viewer, &config, &headers, &place, error, None, status).await;
        }
    };
    match outcome {
        Ok(None) => req.redirect(&url::PricingHealth { place }),
        Ok(Some(applied)) => render(&req, &viewer, &config, &headers, &place, None, Some(applied), StatusCode::OK).await,
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(status @ (StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) => Err(corten::Error::new(error).with_status(status)),
            status => {
                tracing::warn!("a pricing health write was refused: {error}");
                let words = if error.code() == Some("goal_apply_refused") {
                    t.health_goals_apply_error()
                } else {
                    t.health_compute_error()
                };
                let status = if status.is_some_and(|s| s.is_client_error()) {
                    StatusCode::UNPROCESSABLE_ENTITY
                } else {
                    StatusCode::BAD_GATEWAY
                };
                render(&req, &viewer, &config, &headers, &place, Some(words.to_owned()), None, status).await
            }
        },
    }
}
