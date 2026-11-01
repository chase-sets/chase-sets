//! Money Health (`SettlementMoneyHealthPage`) and Payout Operations
//! (`SettlementPayoutOperationsPage`). Every table scrolls on its own on a phone; the header's
//! actions and the filters wrap. Payout Operations' run is its own part (`RunPart`), which the run's
//! live stream draws again while it moves.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    commerce::{
        money,
        payouts::{FILTERS, MoneyHealth, OperationsAttention, OperationsScreen, Payout, Run, payout_href, url},
    },
    text::{Com, Ops, Pilot},
    views::{LiveStatus, LiveWords},
};

pub mod ids {
    use corten::prelude::*;

    /// The element that follows a run's status stream.
    #[derive(Id, Clone, Copy)]
    pub struct PayoutRunLiveId;
    pub const RUN_LIVE: PayoutRunLiveId = PayoutRunLiveId;

    /// The run: what it has done so far.
    #[derive(Id, Clone, Copy)]
    pub struct PayoutRunId;
    pub const RUN: PayoutRunId = PayoutRunId;
}

fn when(t: Com, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A pill in one of the design system's tones.
#[component(css = MoneyHealthPage)]
fn Tone<'a>(words: &'a str, tone: &'static str) -> impl Render {
    let tone = match tone {
        "success" => Good,
        "warning" => Warning,
        "danger" => Danger,
        "accent" => Accent,
        _ => Neutral,
    };
    html! { <span class={(Pill, tone)}>{words}</span> }
}

/// An empty table's words (`DataTable`'s empty state).
#[component(css = MoneyHealthPage)]
fn Empty<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Nothing}>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// A link to the payout on Marketplace, in a new tab (admin-web's Open).
#[component(css = MoneyHealthPage)]
fn OpenPayout<'a>(label: &'a str, href: Option<String>) -> impl Render {
    html! {
        if let Some(href) = &href {
            <a class={(Button, Secondary, Small)} href={href} target="_blank" rel="noreferrer">{label}" \u{2197}"</a>
        }
    }
}

/// Money Health. Top to bottom: the header, the platform balance forecast, the provider's
/// diagnostics, negative balances, the payouts needing attention and recent reconciliation.
#[component(css)]
pub fn MoneyHealthPage<'a>(t: Com, screen: &'a MoneyHealth, marketplace: Option<&'a str>) -> impl Render {
    let forecast = &screen.platform_balance_forecast;
    let health = &screen.provider_health;
    let diagnostics = [
        (
            t.mh_adapter(),
            if health.adapter_mode == "fake" { t.mh_local_test_adapter().to_owned() } else { health.provider_name.clone() },
        ),
        (
            t.mh_webhook_signatures(),
            if health.webhook_signature_required { t.mh_required() } else { t.mh_local_only() }.to_owned(),
        ),
        (t.mh_webhook_failure_classes(), health.webhook_failure_classes.join(", ")),
        (
            t.mh_platform_balance(),
            if health.platform_balance_supported { t.mh_checked_before_payout() } else { t.mh_unavailable() }.to_owned(),
        ),
        (
            t.mh_connected_payouts(),
            if health.connected_account_payouts_supported { t.mh_enabled_through_adapter() } else { t.mh_unavailable_2() }
                .to_owned(),
        ),
    ];
    html! {
        <div class={Page}>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.mh_operations()}</p>
                    <h1>{t.mh_money_health()}</h1>
                    <p class={Muted}>{t.mh_review_payout_demand_reconciliation_history_and()}</p>
                </div>
                <div class={Actions}>
                    <a class={(Button, Secondary)} href={url::Operations::default()}>{t.mh_payout_operations()}</a>
                </div>
            </header>
            <section class={Card} aria-labelledby="mh-forecast">
                <h2 class={Heading} id="mh-forecast">{t.mh_platform_balance_forecast()}</h2>
                <div class={Facts}>
                    <Tone words={t.mh_provider_balance()} tone="accent" />
                    <p class={Strong}>{t.mh_amount_available(&money(t, &forecast.available_amount, &forecast.currency_code))}</p>
                    <p class={Muted}>
                        {t.mh_pending_payout_demand()}
                        <span class={Number}>{money(t, &forecast.pending_payout_demand_amount, &forecast.currency_code)}</span>
                    </p>
                    <p class={Muted}>
                        {t.mh_forecast_after_pending_demand()}
                        <span class={Number}>
                            {money(t, &forecast.forecast_after_pending_demand_amount, &forecast.currency_code)}
                        </span>
                    </p>
                </div>
            </section>
            <section class={Card} aria-labelledby="mh-provider">
                <h2 class={Heading} id="mh-provider">{t.mh_provider_diagnostics()}</h2>
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{t.mh_signal()}</th>
                                <th scope="col">{t.mh_status()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (label, value) in diagnostics {
                                <tr>
                                    <th scope="row">{label}</th>
                                    <td class={Words}>{value}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
            <section class={Card} aria-labelledby="mh-negative">
                <h2 class={Heading} id="mh-negative">{t.mh_negative_balance_accounts()}</h2>
                if screen.negative_balance_accounts.is_empty() {
                    <Empty
                        title={t.mh_no_negative_balances()}
                        description={t.mh_accounts_with_negative_wallet_balances_appear()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.mh_account()}</th>
                                    <th scope="col">{t.mh_negative_amount()}</th>
                                    <th scope="col">{t.mh_negative_since()}</th>
                                    <th scope="col">{t.mh_collections()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.negative_balance_accounts {
                                    <tr>
                                        <td>
                                            <p class={(Strong, Words)}>{&row.account_id}</p>
                                            <Tone
                                                words={&row.negative_balance_status}
                                                tone={if row.negative_balance_status == "collections" { "warning" } else { "neutral" }}
                                            />
                                        </td>
                                        <td class={Number}>{money(t, &row.available_balance_amount, &row.currency_code)}</td>
                                        <td>
                                            {row.negative_balance_started_at.as_deref().map_or_else(|| "-".to_owned(), |at| when(t, at))}
                                        </td>
                                        <td>
                                            {row.collections_escalated_at.as_deref().map_or_else(|| "-".to_owned(), |at| when(t, at))}
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="mh-payouts">
                <h2 class={Heading} id="mh-payouts">{t.mh_payouts_needing_attention()}</h2>
                if screen.payouts_needing_attention.is_empty() {
                    <Empty title={t.mh_no_payout_issues()} description={t.mh_payouts_that_need_reconciliation_or_review()} />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.mh_payout()}</th>
                                    <th scope="col">{t.payout_requested_amount()}</th>
                                    <th scope="col">{t.payout_fee()}</th>
                                    <th scope="col">{t.payout_net()}</th>
                                    <th scope="col">{t.mh_updated()}</th>
                                    <th scope="col">{t.mh_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.payouts_needing_attention {
                                    <tr>
                                        <td>
                                            <p class={(Strong, Words)}>{&row.payout_id}</p>
                                            <p class={Muted}>{&row.status}</p>
                                        </td>
                                        <td class={Number}>{money(t, &row.requested_amount, &row.currency_code)}</td>
                                        <td class={Number}>{money(t, &row.fee_amount, &row.currency_code)}</td>
                                        <td class={Number}>{money(t, &row.net_amount, &row.currency_code)}</td>
                                        <td>{when(t, &row.updated_at)}</td>
                                        <td>
                                            <OpenPayout label={t.mh_open()} href={payout_href(marketplace, &row.payout_id)} />
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="mh-runs">
                <h2 class={Heading} id="mh-runs">{t.mh_recent_reconciliation()}</h2>
                if screen.reconciliation_runs.is_empty() {
                    <Empty
                        title={t.mh_no_reconciliation_runs()}
                        description={t.mh_scheduled_and_manual_reconciliation_outcomes_appear()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.mh_status_2()}</th>
                                    <th scope="col">{t.mh_counts()}</th>
                                    <th scope="col">{t.mh_completed()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.reconciliation_runs {
                                    <tr>
                                        <td>
                                            <Tone
                                                words={&row.status}
                                                tone={if row.error_count > 0 { "warning" } else { "success" }}
                                            />
                                        </td>
                                        <td>
                                            {t.mh_reconciliation_counts(row.checked_count, row.reconciled_count, row.error_count)}
                                        </td>
                                        <td>{row.completed_at.as_deref().map_or_else(String::new, |at| when(t, at))}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
        </div>
    }
}

/// A payout's status pill: Settlement's operations state and severity (admin-web's
/// `operationsLabel` and `operationsTone`).
fn operations_status(t: Com, row: &Payout) -> (&'static str, &'static str) {
    let tone = match row.operations_severity.as_deref() {
        Some("critical") => "danger",
        Some("warning") => "warning",
        _ => "accent",
    };
    let label = match row.operations_state.as_deref() {
        Some("retry-queued") => t.po_retry_queued(),
        Some("needs-provider-reference") => t.po_needs_provider_reference(),
        Some("ready-to-reconcile") => t.po_ready_to_reconcile(),
        _ => t.po_review(),
    };
    (label, tone)
}

/// A payout's status pill.
#[component(css = MoneyHealthPage)]
fn PayoutStatus<'a>(t: Com, row: &'a Payout) -> impl Render {
    let (label, tone) = operations_status(t, row);
    html! { <Tone words={label} tone={tone} /> }
}

/// A payout's retries (admin-web's: the form for one attempt when the count is 1).
fn retries(t: Com, row: &Payout) -> String {
    let n = row.retry_count;
    match &row.next_retry_at {
        Some(at) if n == 1 => t.po_retry_attempt_next_singular(n, &when(t, at)).to_string(),
        Some(at) => t.po_retry_attempt_next_plural(n, &when(t, at)).to_string(),
        None if n == 1 => t.po_retry_attempt_singular(n).to_string(),
        None if n > 0 => t.po_retry_attempt_plural(n).to_string(),
        None => t.po_none().to_owned(),
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

/// The run, as `run_part` draws it.
pub fn run_part<'a>(t: Com, p: Pilot, run: Option<&'a Run>, view: &'a url::View) -> impl Render + 'a {
    html! { <RunPart t={t} p={p} run={run} view={view} /> }
}

/// When the run asked for started and what it has done (admin-web's run result). One still
/// running says so, with a link that reads it again (with JavaScript the page follows it).
#[component(css = MoneyHealthPage)]
fn RunPart<'a>(t: Com, p: Pilot, run: Option<&'a Run>, view: &'a url::View) -> impl Render {
    let again = url::Operations { view: view.clone() };
    html! {
        <div id={ids::RUN} class={Facts}>
            <p class={Muted}>
                {t.po_last_checked()}
                {run.map_or_else(|| t.po_not_checked_in_this_session().to_owned(), |run| when(t, &run.created_at))}
            </p>
            if let Some(run) = run {
                <Tone
                    words={&run.status}
                    tone={match run.status.as_str() { "failed" => "danger", "completed" => "success", _ => "accent" }}
                />
                if let Some(message) = &run.progress.message {
                    <p class={Muted}>{message}</p>
                }
                <p class={Muted}>
                    {t.po_reconciliation_summary(
                        run.result.as_ref().map_or(run.progress.completed, |r| r.checked),
                        run.result.as_ref().map_or(0, |r| r.reconciled),
                        run.result.as_ref().map_or(0, |r| r.ignored),
                        run.result.as_ref().map_or(0, |r| r.skipped),
                    )}
                </p>
                if let Some(result) = run.result.as_ref().filter(|r| !r.errors.is_empty()) {
                    <p class={(Muted, Words)}>
                        {t.po_reconciliation_errors(
                            &result.errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>().join("; "),
                        )}
                    </p>
                }
                if let Some(message) = &run.error_message {
                    <p class={(Muted, Words)}>{t.po_reconciliation_errors(message)}</p>
                }
                if !run.done() {
                    <a class={(Button, Secondary, Small)} href={again}>{p.payout_check_again()}</a>
                }
            }
        </div>
    }
}

/// Payout Operations. Top to bottom: the header; with `payouts.reconcile`, the run; what needs
/// attention (and the payout setup's readiness); the filters and the payouts; and with
/// `payouts.reconcile`, recent provider attempts.
#[component(css = MoneyHealthPage)]
pub fn PayoutOperationsPage<'a>(
    t: Com,
    p: Pilot,
    o: Ops,
    screen: &'a OperationsScreen,
    marketplace: Option<&'a str>,
) -> impl Render {
    // Settlement's counts and setup state; zeros when the read did not return them, as admin-web.
    let attention = screen.attention.as_ref();
    let of = |f: fn(&OperationsAttention) -> usize| attention.map_or(0, f);
    let readiness = screen.readiness.as_ref();
    let (setup_blocked, setup_stale) = readiness.map_or((false, false), |r| (r.setup_blocked, r.setup_stale));
    let count = |n: usize| n.to_string();
    let mut needs = vec![
        (t.po_failed_payouts(), of(|a| a.failed), t.po_provider_reported_failure_or_internal_submission()),
        (t.po_missing_provider_references(), of(|a| a.missing_provider_reference), t.po_transfer_or_payout_reference_has_not()),
        (t.po_retry_queued_2(), of(|a| a.retry_queued), t.po_retry_policy_has_a_next_provider()),
        (t.po_stale_reconciliation(), of(|a| a.stale_reconciliation), t.po_provider_status_has_not_been_checked()),
    ];
    if screen.can_reconcile {
        needs.extend([
            (t.po_payout_setup_blocked(), usize::from(setup_blocked), t.po_account_cannot_request_payouts_until()),
            (
                t.po_open_setup_requirements(),
                readiness.map_or(0, |r| r.missing_requirements.len()),
                t.po_provider_requirement_groups_remain_open(),
            ),
            (t.po_stale_payout_setup_status(), usize::from(setup_stale), t.po_payout_setup_status_needs_refresh()),
        ]);
    }
    let older = t.po_older_than_minutes(attention.map_or(15, |a| a.stale_requested_after_minutes)).to_string();
    let filters = [t.po_all(), t.po_missing_reference(), t.po_in_transit(), t.po_failed()].map(str::to_owned);
    let filters = filters.into_iter().chain([older]);
    let live = url::OperationsLive { view: screen.view.clone() }.href();
    let page = url::Operations { view: screen.view.clone() }.href();
    let following = screen.run.as_ref().is_some_and(|r| !r.done());
    let words = live_words(o);
    html! {
        <div class={Page}>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.po_settlement()}</p>
                    <h1>{t.po_payout_operations()}</h1>
                    <p class={Muted}>{t.po_monitor_payouts_that_may_need_provider()}</p>
                </div>
                <div class={Actions}>
                    <a class={(Button, Secondary)} href={url::MoneyHealth}>{t.po_money_health()}</a>
                </div>
            </header>
            if screen.can_reconcile {
                <section class={Card} aria-labelledby="po-run">
                    <h2 class={Heading} id="po-run">{t.po_reconciliation()}</h2>
                    if let Some(error) = &screen.error {
                        <p class={Alert} role="alert">{error}</p>
                    }
                    <form method="post" action={url::Operations { view: url::View { job: None, ..screen.view.clone() } }}>
                        <input type="hidden" name="intent" value="run-reconciliation">
                        <button type="submit" class={Button}>{t.po_run_reconciliation()}</button>
                    </form>
                    if following {
                        <LiveStatus words={&words} id={ids::RUN_LIVE} src={&live} reload={&page} kept={&[]}>{""}</LiveStatus>
                    }
                    {run_part(t, p, screen.run.as_ref(), &screen.view)}
                </section>
            }
            <section class={Card} aria-labelledby="po-attention">
                <h2 class={Heading} id="po-attention">{t.po_needs_attention()}</h2>
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{t.po_signal()}</th>
                                <th scope="col">{t.po_count()}</th>
                                <th scope="col">{t.po_meaning()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (label, value, meaning) in needs {
                                <tr>
                                    <th scope="row">{label}</th>
                                    <td><Tone words={&count(value)} tone={if value > 0 { "warning" } else { "success" }} /></td>
                                    <td class={Prose}>{meaning}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
                if let Some(readiness) = screen.readiness.as_ref().filter(|_| screen.can_reconcile) {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.po_signal()}</th>
                                    <th scope="col">{t.po_status()}</th>
                                    <th scope="col">{t.po_meaning()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for (label, value, meaning) in [
                                    (t.po_setup_status(), readiness.status.clone(), t.po_current_payout_setup_status()),
                                    (t.po_payout_destination(), readiness.payout_destination_status.clone(), t.po_destination_status_from_provider()),
                                    (
                                        t.po_setup_last_updated(),
                                        readiness.updated_at.as_deref().map_or_else(|| t.po_not_checked().to_owned(), |at| when(t, at)),
                                        t.po_provider_readiness_snapshot(),
                                    ),
                                ] {
                                    <tr>
                                        <th scope="row">{label}</th>
                                        <td>
                                            <Tone
                                                words={&value}
                                                tone={if setup_blocked || setup_stale { "warning" } else { "success" }}
                                            />
                                        </td>
                                        <td class={Prose}>{meaning}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
                <nav class={Filters} aria-label={t.po_needs_attention()}>
                    for (value, label) in FILTERS.into_iter().zip(filters) {
                        <a
                            class={(Button, Small, if screen.filter == value { Current } else { Secondary })}
                            href={url::Operations { view: url::View { filter: (value != "all").then(|| value.to_owned()), job: None } }}
                            aria-current={(screen.filter == value).then_some("page")}
                        >
                            {label}
                        </a>
                    }
                </nav>
                if screen.payouts.is_empty() {
                    <Empty
                        title={t.po_no_payouts_need_attention()}
                        description={t.po_provider_payout_reconciliation_is_clear()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.po_status()}</th>
                                    <th scope="col">{t.payout_requested_amount()}</th>
                                    <th scope="col">{t.payout_fee()}</th>
                                    <th scope="col">{t.payout_net()}</th>
                                    <th scope="col">{t.po_payout_confirmation()}</th>
                                    <th scope="col">{t.po_external_status()}</th>
                                    <th scope="col">{t.po_last_checked_2()}</th>
                                    <th scope="col">{t.po_retry_policy()}</th>
                                    <th scope="col">{t.po_updated()}</th>
                                    <th scope="col">{t.po_actions()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.payouts {
                                    <tr>
                                        <td><PayoutStatus t={t} row={row} /></td>
                                        <td class={Number}>{money(t, &row.requested_amount, &row.currency_code)}</td>
                                        <td class={Number}>{money(t, &row.fee_amount, &row.currency_code)}</td>
                                        <td class={Number}>{money(t, &row.net_amount, &row.currency_code)}</td>
                                        <td>
                                            {if row.provider_payout_reference.is_some() { t.po_confirmed() } else { t.po_pending_confirmation() }}
                                        </td>
                                        <td>{row.provider_status.as_deref().unwrap_or(t.po_unknown())}</td>
                                        <td>
                                            {row.last_reconciled_at.as_deref().map_or_else(|| t.po_not_checked().to_owned(), |at| when(t, at))}
                                        </td>
                                        <td>{retries(t, row)}</td>
                                        <td>{when(t, &row.updated_at)}</td>
                                        <td>
                                            <OpenPayout label={t.po_open()} href={payout_href(marketplace, &row.payout_id)} />
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            if screen.can_reconcile {
                <section class={Card} aria-labelledby="po-attempts">
                    <h2 class={Heading} id="po-attempts">{t.po_recent_provider_attempts()}</h2>
                    if screen.attempts.is_empty() {
                        <Empty
                            title={t.po_no_provider_attempts()}
                            description={t.po_provider_transfer_and_payout_submissions_appear()}
                        />
                    } else {
                        <div class={Scroll}>
                            <table class={Table}>
                                <thead>
                                    <tr>
                                        <th scope="col">{t.po_operation()}</th>
                                        <th scope="col">{t.po_payout()}</th>
                                        <th scope="col">{t.po_provider_reference()}</th>
                                        <th scope="col">{t.po_idempotency_key()}</th>
                                        <th scope="col">{t.po_created()}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    for row in &screen.attempts {
                                        <tr>
                                            <td>{&row.operation_kind}</td>
                                            <td class={Words}>{row.payout_id.as_deref().unwrap_or(t.po_none())}</td>
                                            <td class={Words}>
                                                {row.provider_object_reference.as_deref().unwrap_or(t.po_pending())}
                                            </td>
                                            <td>{t.po_protected_retry_key()}</td>
                                            <td>{when(t, &row.created_at)}</td>
                                        </tr>
                                    }
                                </tbody>
                            </table>
                        </div>
                    }
                </section>
            }
        </div>
    }
}
