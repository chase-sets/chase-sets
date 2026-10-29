//! Pricing recommendations (marketplace's `account-repricing` route, `/account/repricing`): the
//! market signals across the first 100 recommendations, and the recommendations with Refresh,
//! Apply selected and Dismiss selected, each a job Pricing runs.
//!
//! Reads, as marketplace's loader makes them: the recommendations, and the job the address names
//! (`?jobId=`; one Pricing does not have is none). Every write posts to the page and goes to it
//! with the job. While the job runs its notice is relayed live from Pricing's job stream
//! (marketplace's `subscribeDurableJobStatus` on `/recommendation-jobs/{id}/events`); once it
//! finished the pilot reads the recommendations again and draws the page's part again, where
//! marketplace's page reloads itself. The page's actions are off while a job runs. Without a
//! script the page reads itself again every 2 s while the job runs, by the `<noscript>` refresh
//! bulk reprice writes (todd-skelton/corten#319).
//!
//! Refresh, Apply and Dismiss are for a seller with `pricing.manage`; a reader sees the page
//! without them, as the pilot's repricing desk does (marketplace shows them and its action refuses).
use corten::{
    LiveResponse,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use futures_util::StreamExt;
use serde::Deserialize;

use crate::{
    api::{ApiError, PRICING_CONTEXT, Recommendation, RecommendationCalls as _, RecommendationJob, recommendation_job_events},
    app::{PRICING_MANAGE, Shared, read_failed, sign_in, url},
    auth::{PricingManager, Viewer},
    text::{Pilot, RepricingMsg},
    views::{self, Layout},
};

/// The page's address: the job it follows.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct Place {
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
}

impl Place {
    fn job(&self) -> Option<&str> {
        self.job_id.as_deref().map(str::trim).filter(|id| !id.is_empty())
    }

    pub fn following(id: &str) -> Place {
        Place { job_id: Some(id.to_owned()) }
    }
}

/// A write: Refresh, Apply selected or Dismiss selected, and the recommendations picked.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct RecommendationsForm {
    pub intent: String,
    #[serde(rename = "recommendationId")]
    pub recommendation_id: Vec<String>,
}

/// What the page shows.
pub struct RecommendationsScreen {
    pub items: Vec<Recommendation>,
    /// The job the address follows.
    pub job: Option<RecommendationJob>,
    /// What a write was refused for.
    pub error: Option<String>,
    /// The reader may Refresh, Apply and Dismiss (`pricing.manage`).
    pub manage: bool,
}

impl RecommendationsScreen {
    /// A job is queued or running: the actions are off and its notice is live.
    pub fn active(&self) -> bool {
        self.job.as_ref().is_some_and(|job| !job.finished())
    }
}

async fn read_job(config: &Shared, headers: &HeaderMap, id: Option<&str>) -> Result<Option<RecommendationJob>, ApiError> {
    let Some(id) = id else { return Ok(None) };
    match config.platform.caller(headers, config.proto, None).recommendation_job(id).await {
        Ok(job) => Ok(Some(job)),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The screen: the recommendations and the job `id` names.
async fn screen(
    config: &Shared,
    headers: &HeaderMap,
    viewer: &Viewer,
    id: Option<&str>,
    error: Option<String>,
) -> Result<RecommendationsScreen, ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let (items, job) = tokio::join!(caller.recommendations(), read_job(config, headers, id));
    Ok(RecommendationsScreen { items: items?.items, job: job?, error, manage: viewer.actor.can(PRICING_MANAGE) })
}

async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: &Place,
    error: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let screen = match screen(config, headers, viewer, place.job(), error).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let active = screen.active();
    let head = html! {
        <meta name="description" content={t.recs_route_review_seller_pricing_recommendations()}>
        <meta name="robots" content="noindex">
        // Without a script, read again while the job runs; with one, its notice is live
        // (todd-skelton/corten#319).
        if active {
            <noscript><meta http-equiv="refresh" content="2"></noscript>
        }
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.recs_route_repricing_marketplace()} head={head}>
            <views::RecommendationsPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, following the job its address names.
pub(crate) async fn page(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::recommendations::Recommendations>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.place, None, StatusCode::OK).await
}

/// Refresh, Apply selected and Dismiss selected: the page following the job, or the page with what
/// Pricing refused (its words), as marketplace's action answers.
pub(crate) async fn write(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<RecommendationsForm>,
) -> HtmlResult {
    let t: RepricingMsg = req.t();
    let command = match form.intent.as_str() {
        "refresh-recommendations" => "refresh",
        "apply-recommendations" => "apply",
        "dismiss-recommendations" => "dismiss",
        _ => {
            let error = Some(t.recs_route_unknown_action().to_owned());
            return render(&req, &viewer, &config, &headers, &Place::default(), error, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    let ids: Vec<String> = form.recommendation_id.iter().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).collect();
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.recommendation_command(command, &ids).await {
        Ok(job) => req.redirect(&url::Recommendations { place: Place::following(&job.job_id) }),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(status) if status.is_client_error() => {
                let message = error.refusal().map_or_else(|| t.recs_route_action_failed().to_owned(), str::to_owned);
                let place = Place::default();
                render(&req, &viewer, &config, &headers, &place, Some(message), StatusCode::UNPROCESSABLE_ENTITY).await
            }
            _ => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    }
}

/// The job's notice, drawn again on each event Pricing's job stream sends; once the job finished,
/// the page's part with the recommendations read again, and the end.
pub(crate) async fn live(
    req: Req,
    Caller(PricingManager(viewer)): Caller<PricingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::recommendations::RecommendationsLive<'_>>,
) -> LiveResponse {
    let id = route.id.to_string();
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    let open = config
        .platform
        .caller(&headers, config.proto, None)
        .request(reqwest::Method::GET, &recommendation_job_events(&id), PRICING_CONTEXT)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    let events = futures_util::stream::once(async move { open.send().await })
        .filter_map(|res| {
            std::future::ready(match res {
                Ok(res) if res.status().is_success() => Some(res),
                Ok(res) => {
                    tracing::warn!("a recommendation job's stream answered {}", res.status());
                    None
                }
                Err(error) => {
                    tracing::warn!("a recommendation job's stream is unreachable: {error}");
                    None
                }
            })
        })
        .flat_map(|res| platform::realtime::events(res.bytes_stream().map(|chunk| chunk.map_err(|_| ()))))
        .filter_map(|event| std::future::ready(event.ok()));
    let fragments = events
        .then(move |_| {
            let (config, headers, id, viewer) = (config.clone(), headers.clone(), id.clone(), viewer.clone());
            async move {
                let job = match read_job(&config, &headers, Some(&id)).await {
                    Ok(Some(job)) => job,
                    Ok(None) => return None,
                    Err(error) => {
                        tracing::warn!("a recommendation job's read for its event failed: {error}");
                        return None;
                    }
                };
                if !job.finished() {
                    let html = views::recommendations_notice(t, &job).to_html();
                    return Some((corten::Fragment::new(html), false));
                }
                // Finished: the recommendations as they are now, and the actions on again.
                let screen = match screen(&config, &headers, &viewer, Some(&id), None).await {
                    Ok(screen) => screen,
                    Err(error) => {
                        tracing::warn!("the recommendations' read after a job failed: {error}");
                        return None;
                    }
                };
                Some((corten::Fragment::new(views::recommendations_part(t, p, &screen).to_html()), true))
            }
        })
        .filter_map(std::future::ready)
        .scan(false, |done, (fragment, finished)| {
            let next = (!*done).then_some(fragment);
            *done = *done || finished;
            std::future::ready(next)
        });
    corten::live(fragments)
}
