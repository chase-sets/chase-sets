//! Google Shopping (`GoogleShoppingOperationsPage`). Top to bottom: the header and its actions (the
//! three dry runs, the gated live runs, Projections and the runbook), which wrap; what the last dry
//! run said and the run itself, which the run's live stream draws again while it moves; the live
//! gate; the feed's readiness; the filters (one column on a phone, two from 40rem, a row from
//! 64rem); the open row's detail; and the feed rows, which scroll on their own on a phone.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    growth::google_shopping::{FILTERS, Job, LIMITS, REFRESH_DAYS, Row, ShoppingScreen, url},
    text::{Gro, Ops},
    views::{LiveStatus, LiveWords},
};

/// admin-web's launch gate for live Merchant writes.
const LIVE_GATE: &str = "https://github.com/chase-sets/chase-sets/issues/3032";
const RUNBOOK: &str = "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/google-shopping-operations.md";

pub mod ids {
    use corten::prelude::*;

    /// The element that follows a dry run's status stream.
    #[derive(Id, Clone, Copy)]
    pub struct ShoppingJobLiveId;
    pub const JOB_LIVE: ShoppingJobLiveId = ShoppingJobLiveId;

    /// The dry run: what it has done so far.
    #[derive(Id, Clone, Copy)]
    pub struct ShoppingJobId;
    pub const JOB: ShoppingJobId = ShoppingJobId;
}

fn when(t: Gro, at: Option<&str>) -> String {
    match at {
        None => t.gs_none().to_owned(),
        Some(at) => {
            parse_timestamp(at).map_or_else(|| at.to_owned(), |w| t.date_time(w, DateStyle::Medium, TimeStyle::Short).to_string())
        }
    }
}

fn or_none(t: Gro, value: Option<&str>) -> String {
    value.map_or_else(|| t.gs_none().to_owned(), str::to_owned)
}

/// An exclusion reason's words (`exclusionReasonLabel`), or the catalog's unrecognized words.
pub fn reason(t: Gro, value: &str) -> String {
    let known = match value {
        "listing-not-active" => t.gs_exclusion_reason_listing_not_active(),
        "seller-unavailable" => t.gs_exclusion_reason_seller_unavailable(),
        "seller-not-active" => t.gs_exclusion_reason_seller_not_active(),
        "sold-out" => t.gs_exclusion_reason_sold_out(),
        "missing-link" => t.gs_exclusion_reason_missing_link(),
        "missing-title" => t.gs_exclusion_reason_missing_title(),
        "missing-description" => t.gs_exclusion_reason_missing_description(),
        "missing-image" => t.gs_exclusion_reason_missing_image(),
        "invalid-image-url" => t.gs_exclusion_reason_invalid_image_url(),
        "image-not-public" => t.gs_exclusion_reason_image_not_public(),
        "image-too-small" => t.gs_exclusion_reason_image_too_small(),
        "fallback-image-not-approved" => t.gs_exclusion_reason_fallback_image_not_approved(),
        "missing-price" => t.gs_exclusion_reason_missing_price(),
        "missing-condition" => t.gs_exclusion_reason_missing_condition(),
        "ambiguous-condition" => t.gs_exclusion_reason_ambiguous_condition(),
        "missing-shipping-policy" => t.gs_exclusion_reason_missing_shipping_policy(),
        "missing-returns-policy" => t.gs_exclusion_reason_missing_returns_policy(),
        "missing-product-measure" => t.gs_exclusion_reason_missing_product_measure(),
        "not-crawlable" => t.gs_exclusion_reason_not_crawlable(),
        other => return t.gs_unrecognized_reason_with_value(t.gs_exclusion_reason_family(), other).to_string(),
    };
    known.to_owned()
}

fn reasons(t: Gro, list: &[String]) -> String {
    if list.is_empty() { t.gs_none().to_owned() } else { list.iter().map(|r| reason(t, r)).collect::<Vec<_>>().join(", ") }
}

fn filter_words(t: Gro, filter: &str) -> &'static str {
    match filter {
        "eligible" => t.gs_filter_eligible(),
        "excluded" => t.gs_filter_excluded(),
        "failed" => t.gs_filter_failed(),
        "disapproved" => t.gs_filter_disapproved(),
        "pending-delete" => t.gs_filter_pending_delete(),
        "stale" => t.gs_filter_stale(),
        "nearing-refresh" => t.gs_filter_nearing_refresh(),
        "pending-diagnostics" => t.gs_filter_pending_diagnostics(),
        _ => t.gs_filter_all(),
    }
}

fn job_tone(status: Option<&str>) -> &'static str {
    match status {
        Some("completed") => "success",
        Some("failed") => "danger",
        Some("running") => "info",
        _ => "warning",
    }
}

fn sync_tone(status: &str) -> &'static str {
    match status {
        "failed" => "danger",
        "submitted" => "success",
        _ => "neutral",
    }
}

fn diagnostic_tone(status: Option<&str>) -> &'static str {
    match status {
        Some("disapproved") => "danger",
        Some("approved") => "success",
        Some("pending") => "info",
        _ => "warning",
    }
}

fn live_words(o: Ops) -> LiveWords {
    LiveWords {
        live: o.projections_connection_live(),
        connecting: o.projections_connection_connecting(),
        stale_since: o.js().projections_connection_stale_since(),
        stale: o.projections_connection_stale_since("").to_string(),
        stale_description: o.projections_connection_stale_description(),
        reload: None,
        date: o.js().date_time(DateStyle::Medium, TimeStyle::Short),
    }
}

/// A status as a badge: the API's words, in a tone.
#[component(css = GoogleShoppingPage)]
fn Badge<'a>(words: &'a str, tone: &'static str) -> impl Render {
    html! { <span class={Badge} data-tone={tone}>{words}</span> }
}

#[component(css = GoogleShoppingPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Stat}>
            <p class={Muted}>{label}</p>
            <p class={Value}>{value}</p>
        </div>
    }
}

/// The dry run, as `job_part` draws it.
pub fn job_part<'a>(t: Gro, id: &'a str, job: Option<&'a Job>) -> impl Render + 'a {
    html! { <JobPart t={t} id={id} job={job} /> }
}

/// The latest dry run (`GoogleShoppingJobSummary`).
#[component(css = GoogleShoppingPage)]
fn JobPart<'a>(t: Gro, id: &'a str, job: Option<&'a Job>) -> impl Render {
    let progress = job.map(|j| j.progress.clone()).unwrap_or_default();
    let n = |v: u64| t.number(v).to_string();
    html! {
        <section id={ids::JOB} class={Card} aria-labelledby="gs-job">
            <div class={Line}>
                <div>
                    <h2 class={Heading} id="gs-job">{t.gs_latest_job()}</h2>
                    <p class={Muted}>{progress.message.clone().unwrap_or_else(|| t.gs_latest_job_waiting().to_owned())}</p>
                </div>
                <Badge
                    words={job.map_or(t.gs_job_status_pending(), |j| j.status.as_str())}
                    tone={job_tone(job.map(|j| j.status.as_str()))}
                />
            </div>
            <dl class={Facts}>
                <div>
                    <dt>{t.gs_job_id()}</dt>
                    <dd class={Words}>{id}</dd>
                </div>
                <div>
                    <dt>{t.gs_job_kind()}</dt>
                    <dd class={Words}>{or_none(t, job.map(|j| j.job_kind.as_str()))}</dd>
                </div>
                <div>
                    <dt>{t.gs_current_row()}</dt>
                    <dd class={Words}>{or_none(t, progress.current_row_id.as_deref())}</dd>
                </div>
                <div>
                    <dt>{t.gs_updated()}</dt>
                    <dd>{when(t, job.and_then(|j| j.updated_at.as_deref()))}</dd>
                </div>
            </dl>
            <div class={(Stats, Six)}>
                <Figure
                    label={t.gs_job_processed()}
                    value={t.gs_job_processed_value(progress.completed, progress.total).to_string()}
                />
                <Figure label={t.gs_job_submitted()} value={n(progress.submitted)} />
                <Figure label={t.gs_job_skipped()} value={n(progress.skipped)} />
                <Figure label={t.gs_job_deleted()} value={n(progress.deleted)} />
                <Figure label={t.gs_job_failed()} value={n(progress.failed)} />
                <Figure label={t.gs_job_excluded()} value={n(progress.excluded)} />
            </div>
            if let Some(message) = job.and_then(|j| j.error_message.as_deref()) {
                <p class={(Alert, Words)} role="alert">{message}</p>
            }
        </section>
    }
}

/// The open row's detail (`SelectedRowDetail`).
#[component(css = GoogleShoppingPage)]
fn Detail<'a>(t: Gro, row: &'a Row, view: &'a url::View) -> impl Render {
    let close = view.with_selected(crate::growth::google_shopping::CLOSED);
    let facts = [
        (t.gs_row_id(), Some(row.row_id.as_str())),
        (t.gs_listing(), Some(row.listing_id.as_str())),
        (t.gs_account(), Some(row.account_id.as_str())),
        (t.gs_product(), Some(row.product_id.as_str())),
        (t.gs_catalog_item(), Some(row.catalog_item_id.as_str())),
        (t.gs_merchant_offer_id(), Some(row.merchant_offer_id.as_str())),
        (t.gs_external_seller_id(), Some(row.external_seller_id.as_str())),
        (t.gs_payload_hash(), row.payload_hash.as_deref()),
        (t.gs_last_submitted_payload_hash(), row.last_submitted_payload_hash.as_deref()),
        (t.gs_provider_operation(), row.last_provider_operation.as_deref()),
        (t.gs_sync_error_code(), row.last_sync_error_code.as_deref()),
        (t.gs_sync_error_message(), row.last_sync_error_message.as_deref()),
        (t.gs_shipping_policy_url(), row.shipping_policy_url.as_deref()),
        (t.gs_return_policy_url(), row.return_policy_url.as_deref()),
        (t.gs_return_policy_label(), row.return_policy_label.as_deref()),
    ];
    let times = [
        (t.gs_last_submitted_at(), row.last_submitted_at.as_deref()),
        (t.gs_last_accepted_at(), row.last_accepted_at.as_deref()),
        (t.gs_last_diagnostic_at(), row.last_diagnostic_at.as_deref()),
    ];
    let title = match row.title.as_deref().filter(|t| !t.is_empty()) {
        Some(title) => title.to_owned(),
        None => t.gs_untitled_listing(&row.listing_id).to_string(),
    };
    let issues = t.gs_issue_summary(row.active_issue_count, row.unknown_issue_code_count).to_string();
    html! {
        <section class={Card} aria-labelledby="gs-detail">
            <div class={Line}>
                <h2 class={(Heading, Words)} id="gs-detail">{title}</h2>
                <div class={Actions}>
                    <button type="button" class={(Button, Secondary, Small)} disabled>{t.gs_targeted_retry_gated()}</button>
                    <a class={(Button, Secondary, Small)} href={LIVE_GATE} target="_blank" rel="noreferrer">
                        {t.gs_live_gate_action()}
                    </a>
                    <a class={(Button, Secondary, Small)} href={close}>{t.gs_close_detail()}</a>
                </div>
            </div>
            <a class={Words} href={&row.canonical_url} target="_blank" rel="noreferrer">{t.gs_public_listing()}</a>
            <dl class={Facts}>
                for (key, value) in facts {
                    <div>
                        <dt>{key}</dt>
                        <dd class={Words}>{or_none(t, value)}</dd>
                    </div>
                }
                for (key, value) in times {
                    <div>
                        <dt>{key}</dt>
                        <dd>{when(t, value)}</dd>
                    </div>
                }
                <div>
                    <dt>{t.gs_owners()}</dt>
                    <dd>{row.remediation_owners.join(", ")}</dd>
                </div>
            </dl>
            <div class={Scroll}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th scope="col">{t.gs_signal()}</th>
                            <th scope="col">{t.gs_status()}</th>
                            <th scope="col">{t.gs_reasons()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>{t.gs_eligibility()}</td>
                            <td>{&row.eligibility_status}</td>
                            <td>{reasons(t, &row.exclusion_reasons)}</td>
                        </tr>
                        <tr>
                            <td>{t.gs_image_eligibility()}</td>
                            <td>{&row.image_eligibility_status}</td>
                            <td>{reasons(t, &row.image_exclusion_reasons)}</td>
                        </tr>
                        <tr>
                            <td>{t.gs_diagnostics()}</td>
                            <td>{row.diagnostic_status.as_deref().unwrap_or(t.gs_unknown())}</td>
                            <td>{issues}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    }
}

/// A feed row (the table's row): the listing and its links, eligibility, sync, diagnostics, owners,
/// when it changed and Inspect.
#[component(css = GoogleShoppingPage)]
fn FeedRow<'a>(t: Gro, row: &'a Row, screen: &'a ShoppingScreen) -> impl Render {
    let inspect = screen.view.with_selected(&row.row_id);
    let reasons = row.reasons();
    let account = format!("/access/accounts/{}", crate::api::segment(&row.account_id));
    let item = crate::catalog::item::url::Item::of(&row.catalog_item_id);
    html! {
        <tr>
            <td class={Words}>
                <a href={&inspect}>{&row.listing_id}</a>
                <p class={Small}>{&row.merchant_offer_id}</p>
                <span class={Links}>
                    <a href={&row.canonical_url} target="_blank" rel="noreferrer">{t.gs_public_listing()}</a>
                    if screen.links.accounts {
                        <a href={account}>{t.gs_account()}</a>
                    }
                    if screen.links.catalog {
                        <a href={item}>{t.gs_catalog_item()}</a>
                    }
                </span>
            </td>
            <td>
                <span class={Pills}>
                    <Badge
                        words={&row.eligibility_status}
                        tone={if row.eligibility_status == "eligible" { "success" } else { "warning" }}
                    />
                    if row.pending_delete {
                        <Badge words={t.gs_pending_delete()} tone="warning" />
                    }
                    if row.stale {
                        <Badge words={t.gs_stale()} tone="info" />
                    }
                </span>
                <p class={Small}>
                    {if reasons.is_empty() { t.gs_no_exclusions().to_owned() } else { reasons.iter().map(|r| reason(t, r)).collect::<Vec<_>>().join(", ") }}
                </p>
            </td>
            <td>
                <Badge words={&row.sync_status} tone={sync_tone(&row.sync_status)} />
                <p class={Small}>
                    {row.last_sync_error_code.as_deref().or(row.last_provider_operation.as_deref()).unwrap_or(t.gs_no_provider_operation())}
                </p>
            </td>
            <td>
                <Badge
                    words={row.diagnostic_status.as_deref().unwrap_or(t.gs_unknown())}
                    tone={diagnostic_tone(row.diagnostic_status.as_deref())}
                />
                <p class={Small}>{t.gs_issue_summary(row.active_issue_count, row.unknown_issue_code_count).to_string()}</p>
            </td>
            <td>{row.remediation_owners.join(", ")}</td>
            <td>{when(t, Some(&row.updated_at))}</td>
            <td><a class={(Button, Secondary, Small)} href={&inspect}>{t.gs_inspect()}</a></td>
        </tr>
    }
}

/// What the last dry run said (the route's `noticeFromSearchParams`).
fn notice(t: Gro, queued: &url::Queued) -> Option<String> {
    let job = queued.job();
    match (queued.kind()?, job) {
        ("full-sync", Some(job)) => Some(t.gs_full_sync_queued(job).to_string()),
        ("diagnostics", Some(job)) => Some(t.gs_diagnostics_queued(job).to_string()),
        ("maintenance", job) => {
            let total = queued.total.as_deref().unwrap_or("0");
            Some(match job {
                Some(job) => t.gs_maintenance_queued(job, total).to_string(),
                None => t.gs_maintenance_previewed(total).to_string(),
            })
        }
        _ => None,
    }
}

#[component(css)]
pub fn GoogleShoppingPage<'a>(t: Gro, o: Ops, screen: &'a ShoppingScreen) -> impl Render {
    let view = &screen.view;
    let s = &screen.feed.summary;
    let n = |v: u64| t.number(v).to_string();
    let f = url::View::FIELDS;
    let action = url::Shopping { view: url::View { selected: None, ..view.clone() }, queued: url::Queued::default() };
    let words = live_words(o);
    let job = screen.queued.job();
    let following = job.is_some() && !screen.job.as_ref().is_some_and(Job::done);
    let live = url::ShoppingLive { queued: screen.queued.clone() }.href();
    let page = url::Shopping { view: view.clone(), queued: screen.queued.clone() }.href();
    let projections = crate::projections::url::Projections {
        filters: crate::projections::url::Filters { context_name: Some("discovery".into()), ..Default::default() },
    };
    let headline = t.gs_eligibility_headline(s.eligible_rows, s.total_rows, s.excluded_rows).to_string();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.gs_eyebrow()}</p>
                <h1>{t.gs_title()}</h1>
                <p class={Muted}>{t.gs_description()}</p>
            </header>
            <div class={Actions}>
                <form method="post" action={&action}>
                    <button type="submit" class={Button} name="intent" value="dry-run-full-sync">
                        {t.gs_dry_run_full_sync()}
                    </button>
                </form>
                <form method="post" action={&action}>
                    <button type="submit" class={(Button, Secondary)} name="intent" value="dry-run-maintenance-sync">
                        {t.gs_dry_run_maintenance()}
                    </button>
                </form>
                <form method="post" action={&action}>
                    <button type="submit" class={(Button, Secondary)} name="intent" value="dry-run-diagnostics-refresh">
                        {t.gs_dry_run_diagnostics()}
                    </button>
                </form>
                <button type="button" class={(Button, Secondary)} disabled>{t.gs_live_full_sync_gated()}</button>
                <button type="button" class={(Button, Secondary)} disabled>{t.gs_live_maintenance_gated()}</button>
                if screen.links.projections {
                    <a class={(Button, Secondary)} href={projections}>{t.gs_projections()}</a>
                }
                <a class={(Button, Secondary)} href={RUNBOOK} target="_blank" rel="noreferrer">{t.gs_runbook()}</a>
            </div>
            if let Some(error) = &screen.error {
                <p class={(Alert, Words)} role="alert">{error}</p>
            } else if let Some(said) = notice(t, &screen.queued) {
                <p class={(Done, Words)} role="status">{said}</p>
            }
            if let Some(id) = job {
                if following {
                    <LiveStatus words={&words} id={ids::JOB_LIVE} src={&live} reload={&page} kept={&[]}>{""}</LiveStatus>
                }
                {job_part(t, id, screen.job.as_ref())}
            }
            <div class={(Card, Gate)}>
                <p>
                    <Badge words={t.gs_live_gate_badge()} tone="warning" />
                    <span class={Strong}>{t.gs_live_gate_message()}</span>
                </p>
                <a class={(Button, Secondary, Small)} href={LIVE_GATE} target="_blank" rel="noreferrer">
                    {t.gs_live_gate_action()}
                </a>
            </div>
            <section class={Card} aria-labelledby="gs-readiness">
                <h2 class={Heading} id="gs-readiness">{t.gs_title()}</h2>
                <span class={Pills}>
                    <Badge
                        words={&headline}
                        tone={if s.total_rows > 0 && s.eligible_rows == 0 { "warning" } else { "neutral" }}
                    />
                    <Badge
                        words={&t.gs_readiness(s.attention_rows).to_string()}
                        tone={if s.attention_rows > 0 { "warning" } else { "success" }}
                    />
                    <Badge words={&t.gs_generated_at(&when(t, Some(&screen.feed.generated_at))).to_string()} tone="info" />
                </span>
                <p class={Muted}>{t.gs_refresh_cutoff(&when(t, Some(&screen.feed.refresh_cutoff))).to_string()}</p>
                <div class={(Stats, Four)}>
                    <Figure label={t.gs_total_rows()} value={n(s.total_rows)} />
                    <Figure label={t.gs_eligible_rows()} value={n(s.eligible_rows)} />
                    <Figure label={t.gs_failed_rows()} value={n(s.failed_rows)} />
                    <Figure label={t.gs_disapproved_rows()} value={n(s.disapproved_rows)} />
                    <Figure label={t.gs_excluded_rows()} value={n(s.excluded_rows)} />
                    <Figure label={t.gs_pending_delete_rows()} value={n(s.pending_delete_rows)} />
                    <Figure label={t.gs_stale_rows()} value={n(s.stale_rows)} />
                    <Figure label={t.gs_pending_diagnostics_rows()} value={n(s.pending_diagnostics_rows)} />
                </div>
            </section>
            <section class={Card} aria-labelledby="gs-filters">
                <h2 class={Heading} id="gs-filters">{t.gs_filters()}</h2>
                <form class={Filters} method="get" action={url::Shopping::default()}>
                    <label class={Field}>
                        <span>{t.gs_search()}</span>
                        <input type="search" name={f.search} value={view.search()} placeholder={t.gs_search_placeholder()}>
                    </label>
                    <label class={Field}>
                        <span>{t.gs_filter()}</span>
                        <select name={f.filter}>
                            for value in FILTERS {
                                <option value={value} selected={view.filter() == value}>{filter_words(t, value)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.gs_limit()}</span>
                        <select name={f.limit}>
                            for value in LIMITS {
                                <option value={value.to_string()} selected={view.limit() == value}>{value.to_string()}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.gs_refresh_window_days()}</span>
                        <select name={f.refresh_window_days}>
                            for value in REFRESH_DAYS {
                                <option value={value.to_string()} selected={view.refresh_window_days() == value}>
                                    {value.to_string()}
                                </option>
                            }
                        </select>
                    </label>
                    <div class={Actions}>
                        <button type="submit" class={Button}>{t.gs_apply_filters()}</button>
                        if view.applied() {
                            <a class={(Button, Secondary)} href={url::Shopping::default()}>{t.gs_clear_filters()}</a>
                        }
                    </div>
                </form>
                if view.applied() {
                    <span class={Pills}>
                        if !view.search().is_empty() {
                            <Badge words={&t.gs_search_filter(view.search()).to_string()} tone="neutral" />
                        }
                        if view.filter() != "all" {
                            <Badge words={&t.gs_row_filter(filter_words(t, view.filter())).to_string()} tone="neutral" />
                        }
                        if view.limit() != crate::growth::google_shopping::DEFAULT_LIMIT {
                            <Badge words={&t.gs_limit_filter(view.limit()).to_string()} tone="neutral" />
                        }
                        if view.refresh_window_days() != crate::growth::google_shopping::DEFAULT_REFRESH_DAYS {
                            <Badge
                                words={&t.gs_refresh_window_days_filter(view.refresh_window_days()).to_string()}
                                tone="neutral"
                            />
                        }
                    </span>
                }
            </section>
            if let Some(row) = screen.selected() {
                <Detail t={t} row={row} view={view} />
            }
            <section class={Card} aria-labelledby="gs-rows">
                <div>
                    <h2 class={Heading} id="gs-rows">{t.gs_feed_rows()}</h2>
                    <p class={Muted}>{t.gs_feed_rows_description()}</p>
                </div>
                if screen.feed.rows.is_empty() {
                    <div class={Nothing}>
                        <p class={Strong}>{t.gs_no_rows()}</p>
                        <p class={Muted}>{t.gs_no_rows_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.gs_listing()}</th>
                                    <th scope="col">{t.gs_eligibility()}</th>
                                    <th scope="col">{t.gs_sync()}</th>
                                    <th scope="col">{t.gs_diagnostics()}</th>
                                    <th scope="col">{t.gs_owners()}</th>
                                    <th scope="col">{t.gs_updated()}</th>
                                    <th scope="col">{t.gs_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.feed.rows {
                                    <FeedRow t={t} row={row} screen={screen} />
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
        </div>
    }
}
