//! Bulk reprice (marketplace's `account-bulk-reprice` route, `/account/bulk-reprice`): upload a CSV
//! of seller SKUs or listing IDs with new prices, follow the job Pricing runs for it, cancel it, and
//! download the template and a finished job's results.
//!
//! The address names the job it follows (`?jobId=`, marketplace's). Upload posts the form
//! (multipart, the file's text, as marketplace's action reads it) and goes to the page with the new
//! job; Cancel posts to the job and goes back to it. While the job runs, its part (the upload form,
//! which is off while a job runs, and the job's progress) is relayed live: the pilot reads Pricing's
//! job stream (marketplace's `subscribeDurableJobStatus` on `/jobs/{id}/events`) and draws the part
//! again on each event until the job finishes. Without a script the page reads itself again every 2
//! s while the job runs, by a `<noscript>` refresh the pilot writes, since Corten's `ReadAgain`
//! would have a page with a script read itself whole as well (todd-skelton/corten#319). The CSVs
//! are Pricing's, passed on with their type and file name.
//!
//! While Pricing has bulk reprice switched off, every one of its routes answers 404 and marketplace
//! still draws the page (chase-sets/chase-sets#10772). The pilot draws it too, and says bulk reprice
//! is not available when an upload is refused for that, rather than "API error 404".
use std::time::Duration;

use corten::{
    LiveResponse, Relay,
    axum::{
        body::Body,
        http::{HeaderMap, StatusCode, header},
    },
    prelude::*,
};
use futures_util::StreamExt;
use serde::Deserialize;

use crate::{
    api::{ApiError, BulkRepriceCalls as _, BulkRepriceJob, PRICING_CONTEXT, bulk_reprice_job_events},
    app::{Shared, read_failed, sign_in, url},
    auth::{BulkRepricer, Viewer},
    items::Raw,
    listing_new::first,
    text::{Pilot, RepricingMsg},
    uploads::{self, Limits, Over},
    views::{self, Layout},
};

/// A CSV up to 16 MiB (Pricing takes up to 250,000 rows); the form with it up to 17 MiB.
pub const LIMITS: Limits = Limits { file: 16 * 1024 * 1024, files: 1, whole: 17 * 1024 * 1024 };
/// Time for a large CSV on a slow connection, as a listing's photos have.
pub const DEADLINE: Duration = crate::listing_new::DEADLINE;

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

/// The upload form's fields, in marketplace's names.
#[derive(Deserialize, Fields)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct UploadForm {
    pub file: String,
    pub csv_text: String,
}

/// What the page shows.
pub struct BulkScreen {
    /// The job the address follows, if Pricing has it for this account.
    pub job: Option<BulkRepriceJob>,
    /// What an upload or Cancel was refused for.
    pub error: Option<String>,
}

impl BulkScreen {
    /// A job is queued or running: the upload form is off and the job is relayed live.
    pub fn active(&self) -> bool {
        self.job.as_ref().is_some_and(|job| !job.finished())
    }
}

/// The job the address follows; one Pricing does not have (or has switched off) is none, as
/// marketplace's loader reads a 404.
async fn read_job(config: &Shared, headers: &HeaderMap, place: &Place) -> Result<Option<BulkRepriceJob>, ApiError> {
    let Some(id) = place.job() else { return Ok(None) };
    match config.platform.caller(headers, config.proto, None).bulk_reprice_job(id).await {
        Ok(job) => Ok(Some(job)),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
        Err(error) => Err(error),
    }
}

#[allow(clippy::too_many_arguments)]
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
    let job = match read_job(config, headers, place).await {
        Ok(job) => job,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let screen = BulkScreen { job, error };
    let active = screen.active();
    let head = html! {
        <meta name="description" content={t.bulk_route_upload_a_csv_to_reprice()}>
        <meta name="robots" content="noindex">
        // Without a script, read again while the job runs; with one, the job's part is live.
        if active {
            <noscript><meta http-equiv="refresh" content="2"></noscript>
        }
    };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.bulk_route_bulk_reprice_marketplace()} head={head}>
            <views::BulkRepricePage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The page, following the job its address names.
pub(crate) async fn page(
    req: Req,
    Caller(BulkRepricer(viewer)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::bulk_reprice::BulkReprice>,
) -> HtmlResult {
    render(&req, &viewer, &config, &headers, &route.place, None, StatusCode::OK).await
}

/// What a refused upload or Cancel says: signed out goes to sign in, Pricing failing is a 502, and
/// a refusal is Pricing's words (a 404 is that bulk reprice is not available).
fn refused(req: &Req, error: ApiError) -> Result<String, Box<HtmlResult>> {
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => Err(Box::new(sign_in(req))),
        Some(StatusCode::NOT_FOUND) => Ok(p.bulk_reprice_unavailable().to_owned()),
        Some(status) if status.is_client_error() => {
            Ok(error.refusal().map_or_else(|| t.bulk_route_action_failed().to_owned(), str::to_owned))
        }
        _ => Err(Box::new(Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)))),
    }
}

/// Upload: the file's text (or pasted rows) as a new job, then the page following it. A file that
/// is not UTF-8 text or over the limit is refused here, not sent.
pub(crate) async fn upload(
    req: Req,
    Caller(BulkRepricer(viewer)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    upload: corten::Upload<Raw>,
) -> HtmlResult {
    let p: Pilot = req.t();
    let f = UploadForm::FIELDS;
    let place = Place::default();
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(corten::UploadError::TooLarge { .. }) => {
            let error = Some(p.bulk_reprice_too_large().to_owned());
            return render(&req, &viewer, &config, &headers, &place, error, StatusCode::PAYLOAD_TOO_LARGE).await;
        }
        Err(other) => return Err(other.into()),
    };
    let file = posted.files.into_iter().find(|file| file.field == f.file.as_str() && !file.bytes.is_empty());
    let (text, filename) = match (file, posted.over) {
        (_, Some(Over::FileTooLarge | Over::TooManyFiles)) => {
            let error = Some(p.bulk_reprice_too_large().to_owned());
            return render(&req, &viewer, &config, &headers, &place, error, StatusCode::PAYLOAD_TOO_LARGE).await;
        }
        (Some(file), None) => (String::from_utf8(file.bytes.to_vec()).ok(), Some(file.filename)),
        (None, None) => (Some(first(&posted.fields, f.csv_text.as_str())), None),
    };
    let Some(text) = text.filter(|text| !text.trim().is_empty()) else {
        let error = Some(p.bulk_reprice_not_text().to_owned());
        return render(&req, &viewer, &config, &headers, &place, error, StatusCode::UNPROCESSABLE_ENTITY).await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.start_bulk_reprice(&text, filename.as_deref()).await {
        Ok(job) => req.redirect(&url::BulkReprice { place: Place::following(&job.job_id) }),
        Err(error) => match refused(&req, error) {
            Ok(message) => {
                render(&req, &viewer, &config, &headers, &place, Some(message), StatusCode::UNPROCESSABLE_ENTITY).await
            }
            Err(answer) => *answer,
        },
    }
}

/// Cancel a running job, then the page following it.
pub(crate) async fn cancel(
    req: Req,
    Caller(BulkRepricer(viewer)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::bulk_reprice::BulkRepriceCancel<'_>>,
) -> HtmlResult {
    let id = route.id.to_string();
    let place = Place::following(&id);
    match config.platform.caller(&headers, config.proto, None).cancel_bulk_reprice(&id).await {
        Ok(_) => req.redirect(&url::BulkReprice { place }),
        Err(error) => match refused(&req, error) {
            Ok(message) => {
                render(&req, &viewer, &config, &headers, &place, Some(message), StatusCode::UNPROCESSABLE_ENTITY).await
            }
            Err(answer) => *answer,
        },
    }
}

/// The CSV template, as Pricing sends it.
pub(crate) async fn template(
    Caller(BulkRepricer(_)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> corten::Result<Relay> {
    csv(&config, &headers, "template.csv").await
}

/// A job's results, as Pricing sends them.
pub(crate) async fn results(
    Caller(BulkRepricer(_)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::bulk_reprice::BulkRepriceResults<'_>>,
) -> corten::Result<Relay> {
    csv(&config, &headers, &format!("jobs/{}/results.csv", crate::api::segment(&route.id))).await
}

/// Pricing's CSV passed on with its type and file name, nothing else of its headers. One Pricing
/// does not have (or has switched off) is a 404.
async fn csv(config: &Shared, headers: &HeaderMap, path: &str) -> corten::Result<Relay> {
    let caller = config.platform.caller(headers, config.proto, None);
    let res = caller.bulk_reprice_csv(path).await.map_err(|error| {
        let status = match error.status() {
            Some(StatusCode::NOT_FOUND) => StatusCode::NOT_FOUND,
            Some(StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED) => StatusCode::FORBIDDEN,
            _ => StatusCode::BAD_GATEWAY,
        };
        corten::Error::new(error).with_status(status)
    })?;
    let mut kept = HeaderMap::new();
    for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION] {
        if let Some(value) =
            res.headers().get(name.as_str()).and_then(|v| corten::axum::http::HeaderValue::from_bytes(v.as_bytes()).ok())
        {
            kept.insert(name, value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

/// The job's part, drawn again on each event Pricing's job stream sends (each is the job, read
/// again here so the part is what Pricing has now), ending with the job.
pub(crate) async fn live(
    req: Req,
    Caller(BulkRepricer(_)): Caller<BulkRepricer>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::bulk_reprice::BulkRepriceLive<'_>>,
) -> LiveResponse {
    let id = route.id.to_string();
    let (t, p): (RepricingMsg, Pilot) = (req.t(), req.t());
    let open = config
        .platform
        .caller(&headers, config.proto, None)
        .request(reqwest::Method::GET, &bulk_reprice_job_events(&id), PRICING_CONTEXT)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    let events = futures_util::stream::once(async move { open.send().await })
        .filter_map(|res| {
            std::future::ready(match res {
                Ok(res) if res.status().is_success() => Some(res),
                Ok(res) => {
                    tracing::warn!("a bulk reprice job's stream answered {}", res.status());
                    None
                }
                Err(error) => {
                    tracing::warn!("a bulk reprice job's stream is unreachable: {error}");
                    None
                }
            })
        })
        .flat_map(|res| platform::realtime::events(res.bytes_stream().map(|chunk| chunk.map_err(|_| ()))))
        .filter_map(|event| std::future::ready(event.ok()));
    let fragments = events
        .then(move |_| {
            let (config, headers, id) = (config.clone(), headers.clone(), id.clone());
            async move {
                let job = match config.platform.caller(&headers, config.proto, None).bulk_reprice_job(&id).await {
                    Ok(job) => job,
                    Err(error) => {
                        tracing::warn!("a bulk reprice job's read for its event failed: {error}");
                        return None;
                    }
                };
                let finished = job.finished();
                let screen = BulkScreen { job: Some(job), error: None };
                let html = views::bulk_reprice_part(t, p, &screen).to_html();
                Some((corten::Fragment::new(html), finished))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_job_id_follows_no_job() {
        assert_eq!(Place { job_id: Some("  ".into()) }.job(), None);
        assert_eq!(Place::following("job_1").job(), Some("job_1"));
    }
}
