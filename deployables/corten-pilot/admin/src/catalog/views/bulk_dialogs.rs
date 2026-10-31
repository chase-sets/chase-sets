use corten::prelude::*;

use serde_json::Value;

use super::{Dialog, ItemJobOutcome, StatusPill, Table, ids};
use crate::{
    catalog::{
        api::{Candidate, ITEMS_EDIT, ITEMS_PUBLISH, Job, Outcome, Preview},
        form::BulkInput,
    },
    text::{Cat, Pilot},
};

/// How many records a preview or a result lists (admin-web's dialog shows the first 20).
const SHOWN: usize = 20;

/// A preview the API answered, or the refusal in its place.
#[derive(Clone, Copy)]
pub struct Previewed<'a> {
    pub input: &'a BulkInput,
    pub preview: Option<&'a Preview>,
    pub errors: &'a Errors,
    /// The confirm form's URL, with the list's filters.
    pub confirm: &'a str,
    /// The action's label (`Deprecate`).
    pub label: &'a str,
}

/// The preview dialog (`ids::PREVIEW_DIALOG`): what the change would do to each record, and the
/// form that starts it. The page has an empty `<dialog>` with its id; a preview's answer is this
/// dialog, open (a patch with JavaScript, the page without).
#[component(css)]
pub fn PreviewDialog<'a>(t: Cat, p: Pilot, shown: Previewed<'a>) -> impl Patch {
    let f = BulkInput::FIELDS;
    html! {
        let title = t.bulk_preview_title(shown.label).to_string();
        let description = shown.preview.map(|v| t.bulk_preview_description(v.ready_count, v.blocked_count).to_string());
        let ready = shown.preview.is_some_and(|v| v.ready_count > 0);
        let ids: &[String] = match shown.preview {
            Some(preview) if shown.input.mode != "filter" => &preview.ids,
            _ => &[],
        };
        <Dialog
            id={ids::PREVIEW_DIALOG}
            title={&title}
            description={description.as_deref()}
            open
            close={p.catalog_close()}
        >
            if let Some(preview) = shown.preview {
                <Candidates t={t} candidates={&preview.candidates} />
            }
            <form class={Confirm} id={ids::CONFIRM} method="post" action={shown.confirm} data-patch>
                {shown.errors.form_message()}
                <input type="hidden" name={f.action} value={&shown.input.action}>
                <input type="hidden" name={f.mode} value={&shown.input.mode}>
                for id in ids {
                    <input type="hidden" name={f.ids} value={id}>
                }
                <div class={Footer}>
                    <button type="submit" class={Small} disabled={!ready}>{t.bulk_confirm()}</button>
                    <button type="button" class={(Small, Secondary)} command="close" commandfor={ids::PREVIEW_DIALOG}>
                        {t.bulk_cancel()}
                    </button>
                </div>
            </form>
        </Dialog>
    }
}

/// A bulk change's job, after the confirm: its progress, kept current until it is done, then
/// what it did. `live` is its stream (none once it is done, or when the job is not known).
#[component(css = PreviewDialog)]
pub fn JobDialog<'a>(t: Cat, p: Pilot, job: Option<&'a Job<Value>>, label: &'a str, live: Option<&'a str>) -> impl Render {
    html! {
        let title = t.bulk_result_title(label).to_string();
        <Dialog id={ids::JOB_DIALOG} title={&title} description={None} open close={p.catalog_close()}>
            if let Some(src) = live {
                <corten-live src={src}>{job_status(t, p, job)}</corten-live>
            } else {
                {job_status(t, p, job)}
            }
        </Dialog>
    }
}

/// A job's status (`ids::JOB_STATUS`): drawn in its dialog, and again on each change. A
/// catalog item publish or edit that completed shows its own outcome; every other job's outcome
/// is a lifecycle change's.
pub fn job_status<'a>(t: Cat, p: Pilot, job: Option<&'a Job<Value>>) -> impl Render + 'a {
    let items = job.filter(|job| job.status == "completed" && matches!(job.kind.as_str(), ITEMS_PUBLISH | ITEMS_EDIT));
    let lifecycle = job.map(Job::read::<Outcome>);
    html! {
        <div id={ids::JOB_STATUS}>
            if let Some(job) = items {
                <ItemJobOutcome t={t} job={job} />
            } else {
                <JobStatus t={t} p={p} job={lifecycle.as_ref()} />
            }
        </div>
    }
}

#[component(css = PreviewDialog)]
fn JobStatus<'a>(t: Cat, p: Pilot, job: Option<&'a Job>) -> impl Render {
    html! {
        match job {
            None => <p class="form-error" role="alert">{p.bulk_unknown_job()}</p>,
            Some(job) if job.status == "failed" => {
                <p class="form-error" role="alert">{job.error_message.as_deref().unwrap_or(p.bulk_failed())}</p>
            }
            Some(Job { result: Some(outcome), status, .. }) if status == "completed" => {
                <p class={Summary}>
                    {t.bulk_result_description(outcome.succeeded_count, outcome.skipped_count, outcome.failed_count)}
                </p>
                <Candidates t={t} candidates={&outcome.candidates} />
            }
            Some(job) => {
                let progress = &job.progress;
                <div class={Progress} role="status">
                    <StatusPill status={progress.status.as_deref().unwrap_or(&job.status)} toned={false} />
                    <span>{t.bulk_progress(progress.completed, progress.total)}</span>
                    if let Some(name) = &progress.current_name {
                        <span>{t.bulk_progress_current(name)}</span>
                    }
                </div>
            }
        }
    }
}

/// The records of a preview or a result: the first 20, and how many there are when there are more.
#[component(css = PreviewDialog)]
pub fn Candidates<'a>(t: Cat, candidates: &'a [Candidate]) -> impl Render {
    let head = [t.bulk_record(), t.bulk_status(), t.bulk_outcome(), t.bulk_reason()];
    let shown = &candidates[..candidates.len().min(SHOWN)];
    html! {
        if candidates.is_empty() {
            <p class={Summary}>{t.bulk_no_records()}</p>
        } else {
            <Table label={t.bulk_record()} head={&head} all={None}>
                for c in shown {
                    <tr>
                        <td>{&c.label}</td>
                        <td>{&c.status}</td>
                        <td><StatusPill status={&c.outcome} toned={false} /></td>
                        <td>{c.reason.as_deref().unwrap_or("\u{2014}")}</td>
                    </tr>
                }
            </Table>
            if candidates.len() > shown.len() {
                <p class={Summary}>{t.bulk_truncated(shown.len(), candidates.len())}</p>
            }
        }
    }
}
