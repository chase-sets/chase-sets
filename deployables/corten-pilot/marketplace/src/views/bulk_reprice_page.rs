//! Bulk reprice's page (marketplace's `PricingBulkRepricePage`): the header with Download CSV
//! template and Recommendations, what an upload or Cancel was refused for, then the part a running
//! job relays live: the upload form (off while a job runs) and the job's progress with Cancel or
//! Download results. Every action is a form or a link and works without a script. One column on a
//! phone; the job's four counts two to a row, four from 48rem.
use corten::prelude::*;

use crate::{
    app::url,
    bulk_reprice::{BulkScreen, Place, UploadForm},
    text::{Pilot, RepricingMsg},
};

/// The part a running job relays live (`bulk_reprice::live`).
#[derive(Id)]
pub struct BulkPartId;

/// The page.
#[component(css)]
pub fn BulkRepricePage<'a>(t: RepricingMsg, p: Pilot, screen: &'a BulkScreen) -> impl Render {
    let live = screen.job.as_ref().filter(|_| screen.active()).map(|job| url::BulkRepriceLive { id: &job.job_id }.href());
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.bulk_seller()}</p>
            <h1 class={Title}>{t.bulk_bulk_reprice()}</h1>
            <p class={Muted}>{t.bulk_upload_a_csv()}</p>
            <nav class={Row} aria-label={p.bulk_reprice_pages()}>
                <a class={(Button, Secondary)} href={url::BulkRepriceTemplate} download>{t.bulk_download_template()}</a>
                <a class={(Button, Ghost)} href={url::Recommendations::default()}>{t.bulk_recommendations()}</a>
            </nav>
        </header>
        if let Some(error) = &screen.error {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{t.bulk_bulk_reprice()}</p>
                <p>{error}</p>
            </div>
        }
        if let Some(src) = live {
            <corten-live class={Live} src={&src}>
                <BulkPart t={t} p={p} screen={screen} />
            </corten-live>
        } else {
            <BulkPart t={t} p={p} screen={screen} />
        }
    }
}

/// The part drawn on the page and again by the job's live relay.
pub fn bulk_reprice_part<'a>(t: RepricingMsg, p: Pilot, screen: &'a BulkScreen) -> impl Render + 'a {
    html! { <BulkPart t={t} p={p} screen={screen} /> }
}

/// The upload form, then the job: its progress, its counts, and Cancel or Download results
/// (`MarketplaceDashboardPanel` and the job's card).
#[component(css = BulkRepricePage)]
fn BulkPart<'a>(t: RepricingMsg, p: Pilot, screen: &'a BulkScreen) -> impl Render {
    let active = screen.active();
    let f = UploadForm::FIELDS;
    html! {
        <div id={BulkPartId} class={Part} data-bulk-reprice-active={if active { "true" } else { "false" }}>
            <section class={Section} aria-labelledby="bulk-upload-title">
                <h2 id="bulk-upload-title" class={PartTitle}>{t.bulk_upload()}</h2>
                <form class={(Card, Form)} method="post" action={url::BulkReprice::default()} enctype="multipart/form-data">
                    <p class={Muted}>{t.bulk_upload_description()}</p>
                    <label class={Field}>
                        <span class={Label}>{t.bulk_csv_file()}</span>
                        <input class={Input} type="file" name={f.file} accept=".csv,text/csv" required disabled={active}>
                    </label>
                    <p class={Row}>
                        <button type="submit" class={Button} disabled={active}>{t.bulk_upload()}</button>
                    </p>
                </form>
            </section>
            if let Some(job) = &screen.job {
                <section class={Section} aria-labelledby="bulk-job-title" data-bulk-reprice-job={&job.status}>
                    <h2 id="bulk-job-title" class={PartTitle}>{t.bulk_job_status()}</h2>
                    <div class={Card}>
                        <div class={Tight}>
                            <h3 class={Strong}>{t.bulk_progress()}</h3>
                            <p class={Muted} role="status">{job.progress.message.as_deref().unwrap_or(&job.status)}</p>
                        </div>
                        <dl class={Stats}>
                            <div class={Stat}>
                                <dt>{t.bulk_completed()}</dt>
                                <dd>{t.number(job.progress.completed).to_string()}</dd>
                                <dd class={Hint}>
                                    {t.bulk_rows_of_total(&t.number(job.progress.total).to_string()).to_string()}
                                </dd>
                            </div>
                            <div class={Stat}>
                                <dt>{t.bulk_applied()}</dt>
                                <dd>{t.number(job.result.as_ref().map_or(0, |r| r.applied)).to_string()}</dd>
                            </div>
                            <div class={Stat}>
                                <dt>{t.bulk_unchanged()}</dt>
                                <dd>{t.number(job.result.as_ref().map_or(0, |r| r.unchanged)).to_string()}</dd>
                            </div>
                            <div class={Stat}>
                                <dt>{t.bulk_failed()}</dt>
                                <dd>{t.number(job.result.as_ref().map_or(0, |r| r.failed)).to_string()}</dd>
                            </div>
                        </dl>
                    </div>
                    <div class={(Card, JobRow)}>
                        <p class={Strong} data-tone={if job.status == "failed" { "danger" } else { "primary" }}>
                            {job.error_message.as_deref().or(job.progress.message.as_deref()).unwrap_or_default()}
                        </p>
                        <div class={Row}>
                            if active {
                                <form method="post" action={url::BulkRepriceCancel { id: &job.job_id }}>
                                    <button type="submit" class={(Button, Ghost)}>{t.bulk_cancel()}</button>
                                </form>
                                <noscript>
                                    <a href={url::BulkReprice { place: Place::following(&job.job_id) }}>
                                        {p.repricing_refresh()}
                                    </a>
                                </noscript>
                            }
                            if job.finished() {
                                <a class={(Button, Secondary)} href={url::BulkRepriceResults { id: &job.job_id }} download>
                                    {t.bulk_download_results()}
                                </a>
                            }
                        </div>
                    </div>
                </section>
            }
        </div>
    }
}
