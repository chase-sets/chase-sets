//! A scope's page (admin-web's `CatalogScopeDetailPage`): the header, the journey, the coverage
//! matrix, the import-to-promotion section (on admin-web), the candidate review jobs and the
//! language editions. Every write is a plain form; a reject or revoke's reason is folded under its
//! button (`<details>`), and Propose mapping is a dialog, so the page works without JavaScript.
use corten::prelude::*;

use super::{CatalogDialog, DetailPage, Empty, Toasts, Tone, TonePill, Trigger};
use crate::{
    api::segment,
    catalog::{
        api::{AliasCandidate, Coverage, CoverageRow, ReviewJob},
        scope::{
            CONFIDENCES, Condition, Edition, Jobs, Journey, Link, ScopeBack, ScopeScreen, Stage, StageKey, StageStatus,
            url::{self, AliasCommand, MappingInput, ProposeInput, ScopeAt, Via},
        },
        scopes::{Promotion, Sync},
    },
    text::{Cat, Pilot},
    views::admin_web,
};

/// Propose mapping's dialog.
#[derive(Id, Clone, Copy)]
pub struct ScopeProposeDialogId;

/// The page: `cursor` is the completed jobs' page shown, `notice` the toast of the write before,
/// `back` a refused write's message or Propose mapping's form, and `manage` whether the viewer
/// may write (`catalog.manage`).
pub fn scope_page<'a>(
    t: Cat,
    p: Pilot,
    screen: &'a ScopeScreen,
    cursor: Option<&'a str>,
    notice: Option<String>,
    back: ScopeBack,
    manage: bool,
) -> impl Render + 'a {
    let (refused, propose) = match back {
        ScopeBack::Nothing => (None, None),
        ScopeBack::Refused(message) => (Some(message), None),
        ScopeBack::Propose(input, message) => (None, Some((input, message))),
    };
    let s = &screen.scope;
    let id = s.scope_record_id.as_str();
    let scopes = crate::catalog::url::Scopes::default().href();
    let aliases = url::ScopeAliases { id }.href();
    let workspace = workspace(id);
    html! {
        <DetailPage p={p} list={&scopes} list_label={t.scopes_title()} name={&s.name}>
            <ScopePage>
                <ScopeHeader t={t} p={p} screen={screen} refused={refused.as_deref()} />
                <JourneyPart t={t} p={p} journey={&screen.journey} />
                <CoveragePart
                    t={t}
                    p={p}
                    id={id}
                    coverage={screen.coverage.as_ref()}
                    propose={propose.as_ref()}
                    manage={manage}
                    via={Via::Scope}
                />
                <WorkspacePart p={p} href={&workspace} />
                <JobsPart t={t} p={p} id={id} jobs={screen.jobs.as_ref()} cursor={cursor} />
                if let Some(editions) = &screen.editions {
                    <EditionsPart t={t} action={&aliases} editions={editions} manage={manage} />
                }
            </ScopePage>
        </DetailPage>
        <Toasts p={p} notice={notice.as_ref()} />
    }
}

fn lifecycle_tone(status: &str) -> Tone {
    match status {
        "active" => Tone::Success,
        "draft" => Tone::Warning,
        _ => Tone::Neutral,
    }
}

/// The page's parts, with the screen's stylesheet.
#[component(css)]
pub fn ScopePage<C: Render>(children: C) -> impl Render {
    html! { <div class={Page}>{children}</div> }
}

/// The scope's domain and kind, its status, what the page is for, and a refused write's message.
#[component(css = ScopePage)]
fn ScopeHeader<'a>(t: Cat, p: Pilot, screen: &'a ScopeScreen, refused: Option<&'a str>) -> impl Render {
    let s = &screen.scope;
    let eyebrow = t.scope_detail_eyebrow(&s.product_domain, &s.scope_kind).to_string();
    html! {
        <div class={Header}>
            <p class={Eyebrow}>{&eyebrow}</p>
            <TonePill text={&s.lifecycle_status} tone={lifecycle_tone(&s.lifecycle_status)} />
        </div>
        <p class={Lead}>{t.scope_detail_description()}</p>
        if let Some(message) = refused {
            <div class={(Banner, Danger)} role="alert">
                <p class={BannerTitle}>{p.scope_refused()}</p>
                <p>{message}</p>
            </div>
        }
    }
}

/// A table whose rows are cards on a phone, each cell under its heading (`data-label`), so a row's
/// commands are never scrolled out of sight.
#[component(css = ScopePage)]
pub fn Rows<'a, C: Render>(label: &'a str, head: &'a [&'a str], children: C) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table} aria-label={label}>
                <thead>
                    <tr>
                        for heading in head {
                            <th scope="col">{*heading}</th>
                        }
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    }
}

/// Workaround for chase-sets/chase-sets#10507: the import-to-promotion workspace is composed in
/// admin-web's server, so the section links there.
#[component(css = ScopePage)]
fn WorkspacePart<'a>(p: Pilot, href: &'a str) -> impl Render {
    html! {
        <section class={Part} aria-labelledby="scope-workspace">
            <h2 class={PartTitle} id="scope-workspace">{p.scope_workspace_title()}</h2>
            <p class={Muted}>{p.scope_workspace_elsewhere()}</p>
            <a class={Link} href={href}>{p.scope_workspace_open()}</a>
        </section>
    }
}

/// admin-web's own scope page, where the import-to-promotion workspace is.
fn workspace(id: &str) -> String {
    admin_web(&format!("/catalog/scopes/{}", segment(id))).map(|u| u.to_string()).unwrap_or_default()
}

/// The journey (`CatalogScopeJourneyOverviewPanel`): where it is, the counts, and each stage.
#[component(css = ScopePage)]
fn JourneyPart<'a>(t: Cat, p: Pilot, journey: &'a Journey) -> impl Render {
    let (status, tone, banner, title, description) = match journey.condition {
        Condition::Empty => (
            t.scope_detail_journey_status_empty(),
            Tone::Neutral,
            Info,
            t.scope_detail_journey_banner_empty_title(),
            t.scope_detail_journey_banner_empty_description(),
        ),
        Condition::PartialFailure => (
            t.scope_detail_journey_status_partial_failure(),
            Tone::Warning,
            Warning,
            t.scope_detail_journey_banner_partial_failure_title(),
            t.scope_detail_journey_banner_partial_failure_description(),
        ),
        Condition::Blocked => (
            t.scope_detail_journey_status_blocked(),
            Tone::Danger,
            Danger,
            t.scope_detail_journey_banner_blocked_title(),
            t.scope_detail_journey_banner_blocked_description(),
        ),
        Condition::Conflict => (
            t.scope_detail_journey_status_conflict(),
            Tone::Warning,
            Warning,
            t.scope_detail_journey_banner_conflict_title(),
            t.scope_detail_journey_banner_conflict_description(),
        ),
        Condition::ProjectionLag => (
            t.scope_detail_journey_status_projection_lag(),
            Tone::Warning,
            Warning,
            t.scope_detail_journey_banner_projection_lag_title(),
            t.scope_detail_journey_banner_projection_lag_description(),
        ),
        Condition::Ready => (
            t.scope_detail_journey_status_ready(),
            Tone::Success,
            Success,
            t.scope_detail_journey_banner_ready_title(),
            t.scope_detail_journey_banner_ready_description(),
        ),
    };
    let stats = [
        (t.scope_detail_journey_stat_editions(), journey.editions),
        (t.scope_detail_journey_stat_linked(), journey.linked),
        (t.scope_detail_journey_stat_pending(), journey.pending),
    ];
    html! {
        <section class={Part} aria-labelledby="scope-journey">
            <div class={Head}>
                <h2 class={PartTitle} id="scope-journey">{t.scope_detail_journey_title()}</h2>
                <TonePill text={status} tone={tone} />
            </div>
            <p class={Muted}>{t.scope_detail_journey_description()}</p>
            <div class={(Banner, banner)} role="status">
                <p class={BannerTitle}>{title}</p>
                <p>{description}</p>
            </div>
            <Stats items={&stats} />
            <ol class={Stages} aria-label={p.scope_stages()}>
                for stage in &journey.stages {
                    <StageItem t={t} p={p} stage={stage} journey={journey} />
                }
            </ol>
        </section>
    }
}

/// Counts, as `StatGrid` shows them.
#[component(css = ScopePage)]
fn Stats<'a>(items: &'a [(&'a str, usize)]) -> impl Render {
    html! {
        <dl class={Stats}>
            for (label, value) in items {
                <div class={Stat}>
                    <dt>{*label}</dt>
                    <dd>{value.to_string()}</dd>
                </div>
            }
        </dl>
    }
}

/// A stage of the journey (`PageStepper`'s item): its label, what it says, and its status.
#[component(css = ScopePage)]
fn StageItem<'a>(t: Cat, p: Pilot, stage: &'a Stage, journey: &'a Journey) -> impl Render {
    let (label, description) = match stage.key {
        StageKey::Coverage => (
            t.scope_detail_journey_stage_coverage_label(),
            t.scope_detail_journey_stage_coverage_description(journey.editions).to_string(),
        ),
        StageKey::Sync => (
            t.scope_detail_journey_stage_sync_label(),
            match journey.sync {
                Sync::Fresh => t.scope_detail_journey_stage_sync_description_fresh(),
                Sync::Stale => t.scope_detail_journey_stage_sync_description_stale(),
            }
            .to_owned(),
        ),
        StageKey::Jobs => (t.scope_detail_journey_stage_jobs_label(), t.scope_detail_journey_stage_jobs_description().to_owned()),
        StageKey::Candidates => (
            t.scope_detail_journey_stage_candidates_label(),
            if journey.pending > 0 {
                t.scope_detail_journey_stage_candidates_description_pending(journey.pending).to_string()
            } else {
                t.scope_detail_journey_stage_candidates_description_clear().to_owned()
            },
        ),
        StageKey::Promotion => (
            t.scope_detail_journey_stage_promotion_label(),
            match journey.promotion {
                Promotion::Live => t.scope_detail_journey_stage_promotion_description_live(),
                Promotion::Unpublished => t.scope_detail_journey_stage_promotion_description_unpublished(),
                Promotion::Deprecated => t.scope_detail_journey_stage_promotion_description_deprecated(),
                Promotion::Archived => t.scope_detail_journey_stage_promotion_description_archived(),
            }
            .to_owned(),
        ),
    };
    let (status, mark) = match stage.status {
        StageStatus::Complete => (p.scope_stage_complete(), "complete"),
        StageStatus::Current => (p.scope_stage_current(), "current"),
        StageStatus::Upcoming => (p.scope_stage_upcoming(), "upcoming"),
        StageStatus::Blocked => (p.scope_stage_blocked(), "blocked"),
    };
    html! {
        <li class={Stage} data-status={mark} aria-current={(stage.status == StageStatus::Current).then_some("step")}>
            <span class={Mark} aria-hidden="true"></span>
            <span class={StageText}>
                <strong>{label}</strong>
                <span class={Muted}>{&description}</span>
                <span class={StageStatusText}>{status}</span>
            </span>
        </li>
    }
}

fn coverage_tone(state: &str) -> Tone {
    match state {
        "available" => Tone::Warning,
        "mapped" | "synced" => Tone::Info,
        "settled" => Tone::Success,
        _ => Tone::Neutral,
    }
}

/// The coverage matrix (`CatalogScopeCoverageMatrixPanel`): its counts, its commands, and each
/// provider's row. A coverage that could not be read is its banner, never an empty table. `via`
/// is the page it is on, which its writes answer with.
#[component(css = ScopePage)]
pub fn CoveragePart<'a>(
    t: Cat,
    p: Pilot,
    id: &'a str,
    coverage: Option<&'a Coverage>,
    propose: Option<&'a (ProposeInput, String)>,
    manage: bool,
    via: Via,
) -> impl Render {
    let via = url::ViaQuery { via: (via == Via::Coverage).then_some(via) };
    let rows: &[CoverageRow] = coverage.map_or(&[], |c| c.providers.as_slice());
    let count = |state: &str| rows.iter().filter(|r| r.state == state).count();
    let (mapped, synced, settled) = (count("mapped"), count("synced"), count("settled"));
    let available: Vec<&str> =
        rows.iter().filter(|r| r.state == "available").filter_map(|r| Some(r.mapping.as_ref()?.mapping_id.as_str())).collect();
    let draft = coverage.is_some_and(|c| c.lifecycle_status == "draft");
    let action = url::ScopeCoverage { id, via }.href();
    let f = MappingInput::FIELDS;
    let mapped_text = t.scope_detail_coverage_summary_mapped(mapped).to_string();
    let synced_text = t.scope_detail_coverage_summary_synced(synced).to_string();
    let settled_text = t.scope_detail_coverage_summary_settled(settled).to_string();
    let accept_all = t.coverage_accept_all_available(available.len()).to_string();
    let head = [
        t.coverage_provider(),
        t.coverage_coverage(),
        t.coverage_confidence(),
        t.coverage_synced_observations(),
        t.coverage_settled_observations(),
        "",
    ];
    html! {
        <section class={Part} aria-labelledby="scope-coverage">
            <div class={Head}>
                <h2 class={PartTitle} id="scope-coverage">{t.coverage_coverage_matrix()}</h2>
                <span class={Pills}>
                    <TonePill text={&mapped_text} tone={if mapped > 0 { Tone::Info } else { Tone::Neutral }} />
                    <TonePill text={&synced_text} tone={if synced > 0 { Tone::Info } else { Tone::Neutral }} />
                    <TonePill text={&settled_text} tone={if settled > 0 { Tone::Success } else { Tone::Neutral }} />
                </span>
            </div>
            if manage && coverage.is_some() {
                <div class={Actions}>
                    if draft {
                        <form method="post" action={&url::ScopePublish { id, via }.href()}>
                            <button type="submit" class={Small}>{t.coverage_confirm_canonical_record()}</button>
                        </form>
                    }
                    if !available.is_empty() {
                        <form method="post" action={&action}>
                            <input type="hidden" name={f.intent} value="accept">
                            <input type="hidden" name={f.mapping_ids} value={&available.join(",")}>
                            <input type="hidden" name={f.all} value="1">
                            <button type="submit" class={Small}>{&accept_all}</button>
                        </form>
                    }
                    <Trigger dialog={ScopeProposeDialogId} label={t.coverage_propose_mapping()} secondary={true} />
                </div>
            }
            match coverage {
                None => {
                    <div class={(Banner, Warning)} role="status">
                        <p class={BannerTitle}>{t.scope_detail_coverage_partial_title()}</p>
                        <p>{t.scope_detail_coverage_partial_description()}</p>
                    </div>
                }
                Some(_) => {
                    if draft {
                        <div class={(Banner, Warning)} role="status">
                            <p class={BannerTitle}>{t.coverage_draft_banner_title()}</p>
                            <p>{t.coverage_draft_banner_description()}</p>
                        </div>
                    }
                    if rows.is_empty() {
                        <Empty title={t.coverage_no_coverage_yet()} description="" />
                    } else {
                        <Rows label={t.coverage_coverage_matrix()} head={&head}>
                            for row in rows {
                                <CoverageRowView t={t} row={row} action={&action} manage={manage} />
                            }
                        </Rows>
                    }
                }
            }
            if manage {
                <ProposeDialog t={t} p={p} action={&url::ScopePropose { id, via }.href()} back={propose} />
            }
        </section>
    }
}

/// A provider's row: its state, confidence and counts, and what can be done with its mapping.
#[component(css = ScopePage)]
fn CoverageRowView<'a>(t: Cat, row: &'a CoverageRow, action: &'a str, manage: bool) -> impl Render {
    let f = MappingInput::FIELDS;
    let mapping = row.mapping.as_ref();
    let reviewable = matches!(row.state.as_str(), "mapped" | "synced" | "settled");
    let commands = mapping.filter(|_| manage).is_some() && (row.state == "available" || reviewable);
    html! {
        <tr>
            <td data-label={t.coverage_provider()}>{&row.provider_key}</td>
            <td data-label={t.coverage_coverage()}><TonePill text={&row.state} tone={coverage_tone(&row.state)} /></td>
            <td data-label={t.coverage_confidence()}>{mapping.map_or("\u{2014}", |m| m.confidence.as_str())}</td>
            <td data-label={t.coverage_synced_observations()}>{row.synced_observations.to_string()}</td>
            <td data-label={t.coverage_settled_observations()}>{row.promoted_observations.to_string()}</td>
            <td class={(!commands).then_some(Blank)}>
                if let Some(m) = mapping.filter(|_| manage) {
                    <div class={RowActions}>
                        if row.state == "available" {
                            <form method="post" action={action}>
                                <input type="hidden" name={f.intent} value="accept">
                                <input type="hidden" name={f.mapping_ids} value={&m.mapping_id}>
                                <button type="submit" class={Small}>{t.coverage_accept()}</button>
                            </form>
                            <ReasonForm
                                t={t}
                                action={action}
                                intent="reject"
                                mapping={&m.mapping_id}
                                label={t.coverage_reject()}
                                title={t.coverage_reject_mapping()}
                            />
                        } else if reviewable {
                            <ReasonForm
                                t={t}
                                action={action}
                                intent="revoke"
                                mapping={&m.mapping_id}
                                label={t.coverage_revoke()}
                                title={t.coverage_revoke_mapping()}
                            />
                        }
                    </div>
                }
            </td>
        </tr>
    }
}

/// A reject or revoke: its button opens the reason it needs and the confirm.
#[component(css = ScopePage)]
fn ReasonForm<'a>(t: Cat, action: &'a str, intent: &'a str, mapping: &'a str, label: &'a str, title: &'a str) -> impl Render {
    let f = MappingInput::FIELDS;
    html! {
        <details class={Fold}>
            <summary class={(Small, DangerButton)}>{label}</summary>
            <form method="post" action={action} class={ReasonForm} aria-label={title}>
                <input type="hidden" name={f.intent} value={intent}>
                <input type="hidden" name={f.mapping_ids} value={mapping}>
                <label class={Field}>
                    <span class={Label}>{t.coverage_reason()}</span>
                    <input type="text" name={f.reason} required>
                </label>
                <p class={Hint}>{t.coverage_reason_required()}</p>
                <button type="submit" class={(Small, DangerButton)}>{t.coverage_confirm()}</button>
            </form>
        </details>
    }
}

/// Propose mapping's form before anything is typed.
static BLANK: ProposeInput = ProposeInput {
    provider_key: String::new(),
    unit_key: String::new(),
    set_id: String::new(),
    set_name: String::new(),
    confidence: String::new(),
    accept: String::new(),
};

/// Propose mapping: a provider's unit for this scope, by its set id or name, at a confidence;
/// Propose & accept accepts it too. Drawn open with its message when it came back.
#[component(css = ScopePage)]
fn ProposeDialog<'a>(t: Cat, p: Pilot, action: &'a str, back: Option<&'a (ProposeInput, String)>) -> impl Render {
    let f = ProposeInput::FIELDS;
    let (input, message) = back.map_or((&BLANK, None), |(input, message)| (input, Some(message.as_str())));
    let confidences = [
        (CONFIDENCES[0], t.coverage_confidence_exact()),
        (CONFIDENCES[1], t.coverage_confidence_high()),
        (CONFIDENCES[2], t.coverage_confidence_manual()),
    ];
    let chosen = if input.confidence.is_empty() { "manual" } else { input.confidence.as_str() };
    html! {
        <CatalogDialog
            id={ScopeProposeDialogId}
            title={t.coverage_propose_mapping()}
            description={None}
            open={back.is_some()}
            close={p.catalog_close()}
        >
            <form method="post" action={action} class={Propose}>
                if let Some(message) = message.filter(|m| !m.is_empty()) {
                    <p class={FormError} role="alert">{message}</p>
                }
                <label class={Field}>
                    <span class={Label}>{t.coverage_provider_key()}</span>
                    <input type="text" name={f.provider_key} value={&input.provider_key} required>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.coverage_unit_key()}</span>
                    <input type="text" name={f.unit_key} value={&input.unit_key} required>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.coverage_provider_set_id()}</span>
                    <input type="text" name={f.set_id} value={&input.set_id}>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.coverage_provider_set_name()}</span>
                    <input type="text" name={f.set_name} value={&input.set_name}>
                </label>
                <label class={Field}>
                    <span class={Label}>{t.coverage_confidence()}</span>
                    <select name={f.confidence}>
                        for (value, text) in &confidences {
                            <option value={*value} selected={*value == chosen}>{*text}</option>
                        }
                    </select>
                </label>
                <div class={Buttons}>
                    <button type="submit" class={(Small, Secondary)}>{t.coverage_propose()}</button>
                    <button type="submit" class={Small} name={f.accept} value="1">{t.coverage_propose_and_accept()}</button>
                </div>
            </form>
        </CatalogDialog>
    }
}

fn job_tone(status: &str) -> Tone {
    match status {
        "running" => Tone::Info,
        "completed" => Tone::Success,
        "failed" => Tone::Danger,
        _ => Tone::Neutral,
    }
}

/// The candidate review jobs (`CatalogScopeCandidateReviewJobsPanel`): active, failed and a page
/// of completed jobs, with the pages around it. Jobs that could not be read are the banner alone.
#[component(css = ScopePage)]
fn JobsPart<'a>(t: Cat, p: Pilot, id: &'a str, jobs: Option<&'a Jobs>, cursor: Option<&'a str>) -> impl Render {
    let head = [
        t.scope_detail_candidate_review_jobs_column_job(),
        t.scope_detail_candidate_review_jobs_column_status(),
        t.scope_detail_candidate_review_jobs_column_counts(),
        t.scope_detail_candidate_review_jobs_column_catalog_items(),
    ];
    let first = cursor.map(|_| url::ScopePage::of(id).href());
    let next = jobs
        .and_then(|j| j.next.as_deref())
        .map(|c| url::ScopePage { id, at: ScopeAt { jobs: Some(c.to_owned()), ..ScopeAt::default() } }.href());
    html! {
        <section class={Part} aria-labelledby="scope-jobs" data-catalog-candidate-review-jobs>
            <h2 class={PartTitle} id="scope-jobs">{t.scope_detail_candidate_review_jobs_title()}</h2>
            <p class={Muted}>{t.scope_detail_candidate_review_jobs_description()}</p>
            match jobs {
                None => {
                    <div class={(Banner, Warning)} role="status">
                        <p class={BannerTitle}>{t.scope_detail_candidate_review_jobs_unavailable_title()}</p>
                        <p>{t.scope_detail_candidate_review_jobs_unavailable_description()}</p>
                    </div>
                }
                Some(jobs) => {
                    if jobs.active.is_empty() && jobs.failed.is_empty() && jobs.completed.is_empty() {
                        <Empty
                            title={t.scope_detail_candidate_review_jobs_empty_title()}
                            description={t.scope_detail_candidate_review_jobs_empty_description()}
                        />
                    } else {
                        <Rows label={t.scope_detail_candidate_review_jobs_title()} head={&head}>
                            for job in jobs.active.iter().chain(&jobs.failed).chain(&jobs.completed) {
                                <JobRow t={t} job={job} />
                            }
                        </Rows>
                    }
                }
            }
            if first.is_some() || next.is_some() {
                <nav class={Actions} aria-label={p.pages_label()}>
                    if let Some(href) = &first {
                        <a class={Link} href={href}>{t.scope_detail_candidate_review_jobs_first_page()}</a>
                    }
                    if let Some(href) = &next {
                        <a class={Link} href={href} rel="next">{t.scope_detail_candidate_review_jobs_next_page()}</a>
                    }
                </nav>
            }
        </section>
    }
}

/// A job's row: its kind and id (and why it failed), its status and progress, its counts, and the
/// Catalog Items its promoted candidates target.
#[component(css = ScopePage)]
fn JobRow<'a>(t: Cat, job: &'a ReviewJob) -> impl Render {
    let kind = if job.kind == "merge-candidate-promote" {
        t.scope_detail_candidate_review_jobs_kind_promote()
    } else {
        t.scope_detail_candidate_review_jobs_kind_defer()
    };
    let progress = t.scope_detail_candidate_review_jobs_progress(job.progress.completed, job.progress.total).to_string();
    let counts = job.result.as_ref().map(|r| {
        t.scope_detail_candidate_review_jobs_counts(r.promoted, r.deferred, r.skipped_not_eligible, r.failed).to_string()
    });
    let mut items: Vec<&str> = Vec::new();
    for outcome in job.result.iter().flat_map(|r| &r.outcomes) {
        if let Some(item) = outcome.catalog_item_id.as_deref().filter(|_| outcome.status == "promoted")
            && !items.contains(&item)
        {
            items.push(item);
        }
    }
    let failed = job.status == "failed";
    html! {
        <tr data-candidate-review-job-id={&job.job_id}>
            <td data-label={t.scope_detail_candidate_review_jobs_column_job()}>
                <span class={Stack}>
                    <span>{kind}</span>
                    <span class={Muted}>{&job.job_id}</span>
                    if failed {
                        <span class={(Banner, Danger)} role="note">
                            <span class={BannerTitle}>{t.scope_detail_candidate_review_jobs_failure_title()}</span>
                            <span>
                                {job.error_message.as_deref().unwrap_or(t.scope_detail_candidate_review_jobs_failure_unknown())}
                            </span>
                        </span>
                    }
                </span>
            </td>
            <td data-label={t.scope_detail_candidate_review_jobs_column_status()}>
                <span class={Stack}>
                    <TonePill text={&job.status} tone={job_tone(&job.status)} />
                    <span class={Muted}>{&progress}</span>
                </span>
            </td>
            <td data-label={t.scope_detail_candidate_review_jobs_column_counts()}>
                match &counts {
                    Some(text) => { {text} }
                    None if failed => <span class={Muted}>{t.scope_detail_candidate_review_jobs_counts_unavailable()}</span>,
                    None => <span class={Muted}>{t.scope_detail_candidate_review_jobs_counts_pending()}</span>,
                }
            </td>
            <td data-label={t.scope_detail_candidate_review_jobs_column_catalog_items()}>
                if items.is_empty() {
                    <span class={Muted}>{t.scope_detail_candidate_review_jobs_catalog_items_none()}</span>
                } else {
                    <span class={Stack}>
                        for item in &items {
                            <span data-promoted-catalog-item-id={*item}>{*item}</span>
                        }
                    </span>
                }
            </td>
        </tr>
    }
}

fn review_tone(status: &str) -> Tone {
    match status {
        "accepted" | "auto-accepted" => Tone::Success,
        "pending" => Tone::Warning,
        "rejected" => Tone::Danger,
        _ => Tone::Neutral,
    }
}

/// The language editions (`CatalogIntegrationLanguageEditionsPanel`): how many are linked, and
/// each edition folded, open while it has candidates to review.
#[component(css = ScopePage)]
fn EditionsPart<'a>(t: Cat, action: &'a str, editions: &'a [Edition], manage: bool) -> impl Render {
    let linked = editions.iter().filter(|e| e.link == Link::Linked).count();
    let pending: usize = editions.iter().map(|e| e.pending.len()).sum();
    let status = t.scope_detail_language_editions_status(linked, editions.len()).to_string();
    let stats = [
        (t.scope_detail_language_editions_stat_editions(), editions.len()),
        (t.scope_detail_language_editions_stat_linked(), linked),
        (t.scope_detail_language_editions_stat_pending(), pending),
    ];
    html! {
        <section class={Part} aria-labelledby="scope-editions">
            <div class={Head}>
                <h2 class={PartTitle} id="scope-editions">{t.scope_detail_language_editions_title()}</h2>
                <TonePill text={&status} tone={if pending > 0 { Tone::Warning } else { Tone::Success }} />
            </div>
            <p class={Muted}>{t.scope_detail_language_editions_description()}</p>
            <Stats items={&stats} />
            for edition in editions {
                <EditionView t={t} action={action} edition={edition} manage={manage} />
            }
        </section>
    }
}

#[component(css = ScopePage)]
fn EditionView<'a>(t: Cat, action: &'a str, edition: &'a Edition, manage: bool) -> impl Render {
    let title = t.scope_detail_language_editions_edition_title(edition.language_code.to_uppercase()).to_string();
    let summary = if edition.canonical {
        t.scope_detail_language_editions_edition_canonical().to_owned()
    } else {
        match edition.link {
            Link::Linked => t.scope_detail_language_editions_edition_linked().to_owned(),
            Link::PendingReview => t.scope_detail_language_editions_edition_pending_review(edition.pending.len()).to_string(),
            Link::NotYetObserved => t.scope_detail_language_editions_edition_not_yet_observed().to_owned(),
        }
    };
    let link = match edition.link {
        Link::Linked => "linked",
        Link::PendingReview => "pending-review",
        Link::NotYetObserved => "not-yet-observed",
    };
    html! {
        <details class={Edition} open={edition.link == Link::PendingReview} data-link={link}>
            <summary>
                <strong>{&title}</strong>
                <span class={Muted}>{&summary}</span>
            </summary>
            if edition.canonical {
                <p class={Muted}>{t.scope_detail_language_editions_canonical_description()}</p>
            } else if edition.pending.is_empty() && edition.accepted.is_empty() {
                <p class={Muted}>{t.scope_detail_language_editions_empty()}</p>
            } else {
                for candidate in edition.pending.iter().chain(&edition.accepted) {
                    <CandidateView t={t} action={action} candidate={candidate} manage={manage} />
                }
            }
        </details>
    }
}

/// A candidate: the alias, its native name, its status and confidence, why a pending one did not
/// auto-accept, and its commands (off for a viewer who may not write, as admin-web's are).
#[component(css = ScopePage)]
fn CandidateView<'a>(t: Cat, action: &'a str, candidate: &'a AliasCandidate, manage: bool) -> impl Render {
    let native = t.scope_detail_language_editions_candidate_native(&candidate.native_printed_name).to_string();
    let f = AliasCommand::FIELDS;
    html! {
        <div class={Candidate} data-language-edition-candidate={&candidate.alias_hash}>
            <div class={Head}>
                <span class={Stack}>
                    <strong>{&candidate.proposed_alias}</strong>
                    <span class={Muted}>{&native}</span>
                </span>
                <span class={Pills}>
                    <TonePill text={&candidate.review_status} tone={review_tone(&candidate.review_status)} />
                    <TonePill text={&candidate.confidence} tone={Tone::Neutral} />
                </span>
            </div>
            if candidate.review_status == "pending" {
                <div class={Reasons}>
                    <p class={Label}>{t.scope_detail_language_editions_candidate_auto_accept()}</p>
                    if candidate.auto_accept.reasons.is_empty() {
                        <p class={Muted}>{t.scope_detail_language_editions_candidate_no_auto_accept_reasons()}</p>
                    } else {
                        <ul>
                            for reason in &candidate.auto_accept.reasons {
                                <li>{reason}</li>
                            }
                        </ul>
                    }
                </div>
            }
            <div class={Actions}>
                for intent in &candidate.available_actions {
                    match intent.as_str() {
                        "alias.reject" | "alias.revoke" => {
                            <form
                                method="post"
                                action={action}
                                class={ReasonForm}
                                data-language-edition-command={intent.as_str()}
                            >
                                <input type="hidden" name={f.intent} value={intent.as_str()}>
                                <input type="hidden" name={f.alias_hashes} value={&candidate.alias_hash}>
                                <label class={Field}>
                                    <span class={Label}>{t.scope_detail_language_editions_candidate_reason()}</span>
                                    <input type="text" name={f.reason} required disabled={!manage}>
                                </label>
                                <button type="submit" class={(Small, Secondary)} disabled={!manage}>
                                    {alias_label(t, intent)}
                                </button>
                            </form>
                        }
                        "alias.accept" | "alias.defer" => {
                            <form method="post" action={action} data-language-edition-command={intent.as_str()}>
                                <input type="hidden" name={f.intent} value={intent.as_str()}>
                                <input type="hidden" name={f.alias_hashes} value={&candidate.alias_hash}>
                                if intent == "alias.accept" {
                                    <button type="submit" class={Small} disabled={!manage}>{alias_label(t, intent)}</button>
                                } else {
                                    <button type="submit" class={(Small, Secondary)} disabled={!manage}>
                                        {alias_label(t, intent)}
                                    </button>
                                }
                            </form>
                        }
                        _ => {}
                    }
                }
            </div>
        </div>
    }
}

fn alias_label(t: Cat, intent: &str) -> &'static str {
    match intent {
        "alias.accept" => t.alias_action_accept(),
        "alias.reject" => t.alias_action_reject(),
        "alias.defer" => t.alias_action_defer(),
        _ => t.alias_action_revoke(),
    }
}

// Catalog > Scope Coverage's parts (views/coverage.rs), which share this stylesheet.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum InboxTone {
    Success,
    Warning,
}

/// The title, what the inbox is for, and how much waits.
#[component(css = ScopePage)]
pub fn InboxHeader<'a>(t: Cat, summary: &'a str, tone: InboxTone) -> impl Render {
    let tone = if tone == InboxTone::Warning { Warning } else { Success };
    html! {
        <h1 class={PageTitle}>{t.inbox_unmapped_scope_inbox()}</h1>
        <p class={Lead}>{t.inbox_description()}</p>
        <div class={(Banner, tone)} role="status">
            <p class={BannerTitle}>{t.inbox_summary_title()}</p>
            <p>{summary}</p>
        </div>
    }
}

/// A scope's row; Review opens its coverage page.
#[component(css = ScopePage)]
pub fn InboxRow<'a>(t: Cat, group: &'a crate::catalog::coverage::Group) -> impl Render {
    let review = crate::catalog::coverage::url::CoveragePage { id: &group.scope_record_id, at: Default::default() }.href();
    let pending = t.inbox_pending_count(group.counts.total, group.counts.high_confidence).to_string();
    let (status, tone) = if group.is_draft_canonical_record {
        (t.inbox_new_canonical_record(), Tone::Warning)
    } else {
        (t.inbox_existing_record(), Tone::Neutral)
    };
    html! {
        <tr>
            <td data-label={t.inbox_scope()}><strong>{&group.scope_name}</strong></td>
            <td data-label={t.inbox_product_domain()}>{&group.product_domain}</td>
            <td data-label={t.inbox_scope_kind()}>{&group.scope_kind}</td>
            <td data-label={t.inbox_official_code()}>{group.official_set_code.as_deref().unwrap_or("\u{2014}")}</td>
            <td data-label={t.inbox_status()}><TonePill text={status} tone={tone} /></td>
            <td data-label={t.inbox_pending_proposals()}>{&pending}</td>
            <td><a class={Link} href={&review}>{t.inbox_review()}</a></td>
        </tr>
    }
}

/// A refused write's message.
#[component(css = ScopePage)]
pub fn Refused<'a>(p: Pilot, message: &'a str) -> impl Render {
    html! {
        <div class={(Banner, Danger)} role="alert">
            <p class={BannerTitle}>{p.scope_refused()}</p>
            <p>{message}</p>
        </div>
    }
}
