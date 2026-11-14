//! Support requests' page (`SupportOperationsPage`): the status tabs (links), the filters with their
//! applied chips, the count with Escalate overdue, the queue as a table that stacks on a phone
//! (a row a block of labelled lines), its pages, and the selected request's sheet (`EntityDetailDrawer`). Without
//! JavaScript the sheet is an open, non-modal `<dialog>` closed by a link back to the queue; corten-ui's
//! `dialog::modalClosedBy` makes it modal and sends Escape to that link. Each case and remedy action
//! is its own form, so none needs a script; the remedy lifecycle, Other actions and the full case
//! context are `<details>`.
use platform::{
    theme::gap_1,
    ui::{
        stack::{Gap, StackStart},
        table::{CellLabel, Table as KitTable, TableLayout},
    },
};
use std::time::SystemTime;

use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    support::requests::{
        ActionForm, Activity, ActivityKind, CORRECTION_REASONS, CaseAction, Detail, FUNDING_KINDS, Offer, PRIORITIES,
        QueueScreen, REFUND_TRIGGERS, REMEDY_KINDS, REMEDY_REASONS, RESPONSE_TYPES, RETURN_DIRECTIVES, RETURN_EXCEPTION_REASONS,
        Remedy, RemedyDraft, RemedyEffect, RemedyPreview, RemedyRights, RemedyWorkflow, Row, STATUSES, attachment_id, countdown,
        url,
    },
    text::{Pilot, Sup},
};

/// The sheet's title, which names it.
#[derive(Id)]
pub struct RequestSheetTitleId;

/// A status's words (the queue's tab labels), else the status as it is.
pub fn status(t: Sup, value: &str) -> String {
    match value {
        "all" => t.ops_status_filter_all(),
        "unresolved" => t.ops_status_filter_unresolved(),
        "open" => t.ops_status_filter_open(),
        "waiting-on-buyer" => t.ops_status_filter_waiting_on_buyer(),
        "waiting-on-seller" => t.ops_status_filter_waiting_on_seller(),
        "ready-for-support" => t.ops_status_filter_ready_for_support(),
        "resolved" => t.ops_status_filter_resolved(),
        "closed" => t.ops_status_filter_closed(),
        "cancelled" => t.ops_status_filter_cancelled(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn priority(t: Sup, value: &str) -> String {
    match value {
        "normal" => t.ops_priority_filter_normal(),
        "urgent" => t.ops_priority_filter_urgent(),
        "all" => t.ops_priority_filter_all(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn response_type(t: Sup, value: &str) -> &'static str {
    match value {
        "provide-tracking" => t.ops_response_provide_tracking(),
        "accept-return" => t.ops_response_accept_return(),
        "offer-partial-refund" => t.ops_response_offer_partial_refund(),
        "offer-replacement" => t.ops_response_offer_replacement(),
        "issue-refund" => t.ops_response_issue_refund(),
        "challenge-with-evidence" => t.ops_response_challenge_with_evidence(),
        "confirm-cancellation" => t.ops_response_confirm_cancellation(),
        "confirm-cannot-fulfill" => t.ops_response_confirm_cannot_fulfill(),
        _ => t.ops_response_request_support_review(),
    }
}

fn resolution(t: Sup, value: &str) -> &'static str {
    match value {
        "full-refund" => t.ops_resolution_full_refund(),
        "partial-refund" => t.ops_resolution_partial_refund(),
        "return-for-refund" => t.ops_resolution_return_for_refund(),
        "replacement" => t.ops_resolution_replacement(),
        "cancel-order" => t.ops_resolution_cancel_order(),
        "no-action" => t.ops_resolution_no_action(),
        _ => t.ops_resolution_support_reviewed(),
    }
}

/// What was just done, as the sheet says it.
fn done(t: Sup, action: &str) -> Option<&'static str> {
    Some(match action {
        "note" => t.ops_action_result_note(),
        "response" => t.ops_action_result_response(),
        "escalate" => t.ops_action_result_escalate(),
        "resolve" => t.ops_action_result_resolve(),
        "close" => t.ops_action_result_close(),
        "cancel" => t.ops_action_result_cancel(),
        "remedy-proposed" => t.ops_remedy_action_proposed(),
        "remedy-approved" => t.ops_remedy_action_approved(),
        "remedy-retry-requested" => t.ops_remedy_action_retry_requested(),
        "remedy-effect-waived" => t.ops_remedy_action_waived(),
        "remedy-refund-released" => t.ops_remedy_action_refund_released(),
        "remedy-correction-requested" => t.ops_remedy_action_correction_requested(),
        _ => return None,
    })
}

/// A time as admin-web's short `formatDateTime`, else "N/A".
fn when(t: Sup, at: Option<&str>) -> String {
    at.and_then(parse_timestamp)
        .map_or_else(|| t.ops_not_applicable().to_owned(), |at| t.date_time(at, DateStyle::Short, TimeStyle::Short).to_string())
}

/// A pill (`Badge`): its words and its tone.
#[component(css = RequestsPage)]
fn Tag<'a>(words: &'a str, tone: &'a str) -> impl Render {
    html! {
        match tone {
            "danger" => <span class={(Pill, Danger)}>{words}</span>,
            "warning" => <span class={(Pill, Warning)}>{words}</span>,
            "success" => <span class={(Pill, Success)}>{words}</span>,
            _ => <span class={(Pill, Neutral)}>{words}</span>,
        }
    }
}

/// A deadline's countdown and its time (`SupportDeadlineCountdown`).
#[component(css = RequestsPage)]
fn Deadline<'a>(t: Sup, due: Option<&'a str>, now: SystemTime) -> impl Render {
    let at = due.and_then(|d| parse_timestamp(d).map(|when| (when, d)));
    html! {
        if let Some((when_due, text)) = at {
            let (overdue, value, unit) = countdown(when_due, now);
            <span class={(StackStart { gap: Gap::App }, gap_1())}>
                if overdue {
                    <Tag
                        words={&t.ops_deadline_overdue(crate::text::sup::OpsDeadlineOverdue { value, unit }).to_string()}
                        tone="danger"
                    />
                } else {
                    <Tag
                        words={&t.ops_deadline_due(crate::text::sup::OpsDeadlineDue { value, unit }).to_string()}
                        tone="warning"
                    />
                }
                <span class={Small}>{when(t, Some(text))}</span>
            </span>
        } else {
            <span class={Muted}>{t.ops_deadline_none()}</span>
        }
    }
}

/// An order and its marketplace pages (`SupportOrderMarketplaceLinks`).
#[component(css = RequestsPage)]
fn Order<'a>(t: Sup, order_id: &'a str, marketplace: Option<&'a str>) -> impl Render {
    html! {
        <span class={(StackStart { gap: Gap::App }, gap_1())}>
            <span class={Words}>{order_id}</span>
            if let Some(origin) = marketplace {
                <span class={Links}>
                    <a class={Open} href={&format!("{origin}/account/purchases/{order_id}")} target="_blank" rel="noreferrer">
                        {t.ops_order_view_purchase()}
                    </a>
                    <a class={Open} href={&format!("{origin}/account/sales/{order_id}")} target="_blank" rel="noreferrer">
                        {t.ops_order_view_sale()}
                    </a>
                </span>
            } else {
                <Tag words={t.ops_order_marketplace_link_unavailable()} tone="warning" />
            }
        </span>
    }
}

#[component(css)]
pub fn RequestsPage<'a>(t: Sup, p: Pilot, screen: &'a QueueScreen, now: SystemTime) -> impl Render {
    let f = &screen.filters;
    let q = crate::support::requests::url::Queue::FIELDS;
    let here = url::Requests { queue: f.at(None, None), notice: url::Notice::default() };
    let pages = (screen.queue.total.div_ceil(u64::from(f.limit))).max(1);
    let page = u64::from(f.offset / f.limit) + 1;
    let previous = (f.offset > 0)
        .then(|| url::Requests { queue: f.at(None, Some(f.offset.saturating_sub(f.limit))), notice: url::Notice::default() });
    let next = (u64::from(f.offset) + u64::from(f.limit) < screen.queue.total)
        .then(|| url::Requests { queue: f.at(None, Some(f.offset + f.limit)), notice: url::Notice::default() });
    let flow_title = |flow: &str| screen.flows.iter().find(|x| x.flow_type == flow).map_or(flow.to_owned(), |x| x.title.clone());
    let mut chips: Vec<String> = Vec::new();
    if !f.search.is_empty() {
        chips.push(t.ops_search_filter_chip(&f.search).to_string());
    }
    if f.status != "all" {
        chips.push(t.ops_status_filter_chip(&status(t, &f.status)).to_string());
    }
    if f.priority != "all" {
        chips.push(t.ops_priority_filter_chip(&priority(t, &f.priority)).to_string());
    }
    if f.flow_type != "all" {
        chips.push(t.ops_flow_type_filter_chip(&flow_title(&f.flow_type)).to_string());
    }
    if f.contested {
        chips.push(t.ops_contested_filter_chip().to_owned());
    }
    if f.overdue {
        chips.push(t.ops_overdue_filter_chip().to_owned());
    }
    html! {
        <header class={Header}>
            <h1>{t.ops_title()}</h1>
            <p class={Muted}>{t.ops_description()}</p>
        </header>
        if screen.unavailable {
            <div class={Note} role="alert">
                <Tag words={t.ops_unavailable()} tone="warning" />
                <p class={Muted}>{t.ops_route_request_failed()}</p>
            </div>
        }
        if screen.selected_failed {
            <p class={Alert} role="alert">{t.ops_error()}": "{t.ops_route_request_failed()}</p>
        }
        if screen.selected.is_none() {
            if let Some(refusal) = &screen.refusal {
                <p class={Alert} role="alert">{refusal}</p>
            }
        }
        if let Some(e) = &screen.escalation {
            <div class={Note} role="status">
                if e.capped {
                    <Tag words={t.ops_partial()} tone="warning" />
                } else {
                    <Tag words={t.ops_success()} tone="success" />
                }
                <p class={Strong}>
                    {t.ops_escalation_result(crate::text::sup::OpsEscalationResult { escalated: e.escalated, skipped: e.skipped })}
                </p>
                if e.capped {
                    <p class={Muted}>{t.ops_escalation_capped(e.total)}</p>
                }
            </div>
        }
        if screen.catching_up && screen.selected.is_none() {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        <section class={Part}>
            <h2 class={Heading}>{t.ops_queue_title()}</h2>
            <p class={Muted}>{t.ops_queue_description()}</p>
            <nav class={Tabs} aria-label={t.ops_status()}>
                for value in STATUSES {
                    let href = url::Requests { queue: f.at(Some(value), Some(0)), notice: url::Notice::default() };
                    if value == f.status {
                        <a class={(Tab, Current)} href={&href} aria-current="page">{status(t, value)}</a>
                    } else {
                        <a class={Tab} href={&href}>{status(t, value)}</a>
                    }
                }
            </nav>
            <form class={Filters} method="get" action={url::Requests::default()}>
                if f.status != "all" {
                    <input type="hidden" name={q.status} value={&f.status}>
                }
                <label class={Field}>
                    <span>{t.ops_search()}</span>
                    <input type="search" name={q.search} value={&f.search} placeholder={t.ops_search_placeholder()}>
                </label>
                <label class={Field}>
                    <span>{t.ops_priority()}</span>
                    <select name={q.priority}>
                        for value in PRIORITIES {
                            <option value={value} selected={value == f.priority}>{priority(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_flow_type()}</span>
                    <select name={q.flow_type}>
                        <option value="all" selected={f.flow_type == "all"}>{t.ops_flow_type_filter_all()}</option>
                        for flow in &screen.flows {
                            <option value={&flow.flow_type} selected={flow.flow_type == f.flow_type}>{&flow.title}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_contested()}</span>
                    <select name={q.contested}>
                        <option value="" selected={!f.contested}>{t.ops_contested_filter_all()}</option>
                        <option value="true" selected={f.contested}>{t.ops_contested_filter_contested_only()}</option>
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_next_deadline()}</span>
                    <select name={q.overdue}>
                        <option value="" selected={!f.overdue}>{t.ops_contested_filter_all()}</option>
                        <option value="true" selected={f.overdue}>{t.ops_overdue_filter_overdue_only()}</option>
                    </select>
                </label>
                <div class={Actions}>
                    <button type="submit" class={Button}>{t.ops_apply_filters()}</button>
                    <a class={(Button, Secondary)} href={url::Requests::default()}>{t.ops_clear_filters()}</a>
                </div>
            </form>
            if !chips.is_empty() {
                <ul class={Chips} aria-label={t.ops_filters()}>
                    for chip in &chips {
                        <li>{chip}</li>
                    }
                </ul>
            }
            <div class={Count}>
                <p class={Strong}>
                    {t.ops_queue_count(crate::text::sup::OpsQueueCount { count: screen.queue.count, total: screen.queue.total })}
                </p>
                <form method="post" action={&here}>
                    <button type="submit" class={Button} disabled={screen.unavailable}>{t.ops_escalate_overdue()}</button>
                </form>
            </div>
            if screen.queue.items.is_empty() {
                <div class={Empty}>
                    if f.status == "unresolved" {
                        <p class={EmptyTitle}>{t.ops_no_unresolved_requests()}</p>
                    } else {
                        <p class={EmptyTitle}>{t.ops_no_requests()}</p>
                        <p class={Muted}>{t.ops_no_requests_description()}</p>
                    }
                </div>
            } else {
                <div class={Scroll}>
                    <KitTable layout={TableLayout::Stack}>
                        <table class={Table} aria-label={t.ops_queue_title()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.ops_reference()}</th>
                                    <th scope="col">{t.ops_order()}</th>
                                    <th scope="col">{t.ops_status()}</th>
                                    <th scope="col">{t.ops_next_deadline()}</th>
                                    <th scope="col">{t.ops_checklist()}</th>
                                    <th scope="col">{t.ops_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &screen.queue.items {
                                    <QueueRow t={t} row={row} screen={screen} now={now} title={&flow_title(&row.flow_type)} />
                                }
                            </tbody>
                        </table>
                    </KitTable>
                </div>
            }
            if previous.is_some() || next.is_some() {
                <nav class={Pages} aria-label={p.pages_label()}>
                    if let Some(href) = &previous { <a class={Open} href={href} rel="prev">{p.pages_previous()}</a> }
                    <span>{p.pages_current(crate::text::pilot::PagesCurrent { page, pages })}</span>
                    if let Some(href) = &next { <a class={Open} href={href} rel="next">{p.pages_next()}</a> }
                </nav>
            }
        </section>
        if let Some(detail) = &screen.selected {
            <RequestSheet t={t} p={p} screen={screen} detail={detail} now={now} title={&flow_title(&detail.row.flow_type)} />
        }
    }
}

#[component(css = RequestsPage)]
fn QueueRow<'a>(t: Sup, row: &'a Row, screen: &'a QueueScreen, now: SystemTime, title: &'a str) -> impl Render {
    let (satisfied, required) = row.checklist_counts();
    let open = url::Requests {
        queue: screen.filters.at(None, None),
        notice: url::Notice { request_id: Some(row.support_request_id.clone()), ..url::Notice::default() },
    };
    html! {
        <tr>
            <td>
                <CellLabel>{t.ops_reference()}</CellLabel>
                <span class={(StackStart { gap: Gap::App }, gap_1())}>
                    <span class={(Strong, Words)}>{row.reference()}</span>
                    <span class={Small}>{title}</span>
                </span>
            </td>
            <td>
                <CellLabel>{t.ops_order()}</CellLabel>
                <Order t={t} order_id={&row.order_id} marketplace={screen.marketplace.as_deref()} />
            </td>
            <td>
                <CellLabel>{t.ops_status()}</CellLabel>
                <span class={(StackStart { gap: Gap::App }, gap_1())}>
                    <Tag
                        words={&status(t, &row.status)}
                        tone={if row.status == "ready-for-support" { "warning" } else { "neutral" }}
                    />
                    if row.priority == "urgent" {
                        <Tag words={&priority(t, &row.priority)} tone="danger" />
                    }
                    if row.contested == Some(true) {
                        <Tag words={t.ops_contested_badge()} tone="warning" />
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.ops_next_deadline()}</CellLabel>
                <Deadline t={t} due={row.next_deadline()} now={now} />
            </td>
            <td>
                <CellLabel>{t.ops_checklist()}</CellLabel>
                {t.ops_checklist_summary(crate::text::sup::OpsChecklistSummary { satisfied, required })}
            </td>
            <td>
                <CellLabel>{t.ops_action()}</CellLabel>
                <a class={Open} href={&open}>{t.ops_open()}</a>
            </td>
        </tr>
    }
}

/// The selected request's sheet (`EntityDetailDrawer`).
#[component(css = RequestsPage)]
fn RequestSheet<'a>(
    t: Sup,
    p: Pilot,
    screen: &'a QueueScreen,
    detail: &'a Detail,
    now: SystemTime,
    title: &'a str,
) -> impl Render {
    let row = &detail.row;
    let close = url::Requests { queue: screen.filters.at(None, None), notice: url::Notice::default() }.href();
    let action = url::Request { id: &row.support_request_id, queue: screen.filters.at(None, None) }.href();
    let back = refs();
    let recommended = detail.recommended();
    let notes: Vec<_> = detail.evidence.iter().filter(|e| e.evidence_type == "support-note").collect();
    let remedy_open = screen.remedy_preview.is_some()
        || screen.remedy_draft.is_some()
        || detail.remedy_approval.is_some()
        || detail.remedy.is_some();
    html! {
        <dialog
            class={Sheet}
            open
            aria-labelledby={RequestSheetTitleId}
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <header class={Head}>
                <div>
                    <h2 id={RequestSheetTitleId} class={Words}>{row.reference()}</h2>
                    <p>{t.ops_drawer_description()}</p>
                </div>
                <a ref={back} class={Close} href={&close} aria-label={t.ops_drawer_close()}>"×"</a>
            </header>
            if let Some(words) = screen.action.as_deref().and_then(|a| done(t, a)) {
                <p class={Note} role="status">{words}</p>
            }
            if screen.catching_up {
                <p class={Note} role="status">{p.error_pending()}</p>
            }
            if let Some(refusal) = &screen.refusal {
                <p class={Alert} role="alert">{refusal}</p>
            }
            <dl class={Facts}>
                <div>
                    <dt>{t.ops_order()}</dt>
                    <dd><Order t={t} order_id={&row.order_id} marketplace={screen.marketplace.as_deref()} /></dd>
                </div>
                <div>
                    <dt>{t.ops_issue()}</dt>
                    <dd>{title}</dd>
                </div>
                <div>
                    <dt>{t.ops_status()}</dt>
                    <dd><Tag words={&status(t, &row.status)} tone="neutral" /></dd>
                </div>
                <div>
                    <dt>{t.ops_priority()}</dt>
                    <dd>
                        <Tag
                            words={&priority(t, &row.priority)}
                            tone={if row.priority == "urgent" { "danger" } else { "neutral" }}
                        />
                    </dd>
                </div>
                <div>
                    <dt>{t.ops_next_deadline()}</dt>
                    <dd><Deadline t={t} due={row.next_deadline()} now={now} /></dd>
                </div>
                <div>
                    <dt>{t.ops_accounts()}</dt>
                    <dd class={Words}>{format!("{} / {}", detail.buyer_account_id, detail.seller_account_id)}</dd>
                </div>
            </dl>
            if detail.adjudicating() {
                <Adjudication t={t} detail={detail} />
            }
            if !detail.terminal() {
                <section class={Part}>
                    <h3 class={Subheading}>{t.ops_recommended_action()}</h3>
                    <div class={Card}>
                        <CaseForm t={t} action={recommended} detail={detail} href={&action} />
                    </div>
                </section>
            }
            <section class={Part}>
                <h3 class={Subheading}>{t.ops_checklist()}</h3>
                <ul class={List}>
                    for item in &row.checklist {
                        <li class={Line}>
                            <span class={Words}>{&item.label}</span>
                            if item.satisfied_at.is_some() {
                                <Tag words={t.ops_checklist_complete()} tone="success" />
                            } else {
                                <Tag
                                    words={t.ops_checklist_incomplete()}
                                    tone={if item.required { "warning" } else { "neutral" }}
                                />
                            }
                        </li>
                    }
                </ul>
            </section>
            <section class={Part}>
                <h3 class={Subheading}>{t.ops_notes()}</h3>
                if notes.is_empty() {
                    <div class={Empty}>
                        <p class={EmptyTitle}>{t.ops_notes_empty()}</p>
                        <p class={Muted}>{t.ops_notes_empty_description()}</p>
                    </div>
                } else {
                    <ul class={List}>
                        for note in &notes {
                            <li class={Entry}>
                                <p class={Words}>{&note.summary}</p>
                                <p class={Small}>{when(t, Some(&note.submitted_at))}</p>
                            </li>
                        }
                    </ul>
                }
            </section>
            if !detail.offers.is_empty() {
                <section class={Part}>
                    <h3 class={Subheading}>{t.ops_offers()}</h3>
                    <ul class={List}>
                        for offer in &detail.offers {
                            <OfferEntry t={t} offer={offer} />
                        }
                    </ul>
                </section>
            }
            <section class={Part}>
                <h3 class={Subheading}>{t.ops_audit_trail()}</h3>
                <AuditTrail t={t} detail={detail} />
            </section>
            if detail.has_remedy() {
                <details class={More} open={remedy_open}>
                    <summary>{t.ops_remedy_workflow_title()}</summary>
                    <RemedyPanel t={t} screen={screen} detail={detail} href={&action} />
                </details>
            }
            <details class={More}>
                <summary>{t.ops_full_case()}</summary>
                <p class={Muted}>{t.ops_full_case_description()}</p>
                <CaseContext t={t} detail={detail} />
            </details>
            <details class={More} open={screen.refusal.is_some()}>
                <summary>{t.ops_other_actions()}</summary>
                <p class={Muted}>{t.ops_other_actions_description()}</p>
                <OtherActions t={t} detail={detail} recommended={recommended} href={&action} />
            </details>
        </dialog>
    }
}

fn remedy_kind(t: Sup, value: &str) -> &'static str {
    match value {
        "partial-refund" => t.ops_resolution_partial_refund(),
        _ => t.ops_resolution_full_refund(),
    }
}

fn funding(t: Sup, value: &str) -> &'static str {
    match value {
        "split" => t.ops_remedy_funding_split(),
        "seller-funded" => t.ops_remedy_funding_seller(),
        _ => t.ops_remedy_funding_platform(),
    }
}

fn return_directive(t: Sup, value: &str) -> &'static str {
    match value {
        "return-to-seller" => t.ops_remedy_return_seller(),
        "return-to-platform" => t.ops_remedy_return_platform(),
        _ => t.ops_remedy_return_none(),
    }
}

/// A remedy workflow's status tone, as admin-web gives it.
fn workflow_tone(status: &str) -> &'static str {
    match status {
        "reservation-rejected" | "correction-requested" => "danger",
        "authorized" => "success",
        _ => "warning",
    }
}

/// An effect's status tone, as admin-web gives it.
fn effect_tone(status: &str) -> &'static str {
    match status {
        "satisfied" | "waived" => "success",
        failed if failed.starts_with("failed") => "danger",
        _ => "warning",
    }
}

/// The remedy lifecycle (`PlatformRemedyWorkflowPanel`): before a workflow, the proposal and its
/// preview once the support decision has a refund; then the workflow, its approval, its effects and
/// their recovery, a correction and its audit trail.
#[component(css = RequestsPage)]
fn RemedyPanel<'a>(t: Sup, screen: &'a QueueScreen, detail: &'a Detail, href: &'a str) -> impl Render {
    let can = screen.remedy_rights;
    html! {
        match (&detail.remedy_approval, detail.decided_refund()) {
            (Some(workflow), _) => {
                <Workflow t={t} can={can} workflow={workflow} remedy={detail.remedy.as_ref()} href={href} />
            }
            (None, None) => {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.ops_remedy_unavailable_title()}</p>
                    <p class={Muted}>{t.ops_remedy_unavailable_description()}</p>
                </div>
            }
            (None, Some(_)) => {
                <Proposal t={t} can={can} screen={screen} detail={detail} href={href} />
            }
        }
    }
}

/// A remedy proposal: Preview consequences first, then Request reservation.
#[component(css = RequestsPage)]
fn Proposal<'a>(t: Sup, can: RemedyRights, screen: &'a QueueScreen, detail: &'a Detail, href: &'a str) -> impl Render {
    let f = ActionForm::FIELDS;
    let draft = screen.remedy_draft.clone().unwrap_or_else(|| RemedyDraft::start(detail));
    let key = format!("{}:platform-remedy-proposal", detail.row.support_request_id);
    html! {
        <form class={Form} method="post" action={href}>
            <div class={Grid}>
                <label class={Field}>
                    <span>{t.ops_remedy_kind()}</span>
                    <select name={f.remedy_kind} required>
                        for value in REMEDY_KINDS {
                            <option value={value} selected={value == draft.kind}>{remedy_kind(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_amount()}</span>
                    <input type="text" name={f.remedy_amount} inputmode="decimal" value={&draft.amount} required>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_currency()}</span>
                    <input type="text" name={f.currency_code} value={&draft.currency_code} required>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_funding_kind()}</span>
                    <select name={f.funding_kind} required>
                        for value in FUNDING_KINDS {
                            <option value={value} selected={value == draft.funding_kind}>{funding(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_seller_amount()}</span>
                    <input
                        type="text"
                        name={f.seller_funded_amount}
                        inputmode="decimal"
                        value={&draft.seller_funded_amount}
                        required
                    >
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_platform_amount()}</span>
                    <input
                        type="text"
                        name={f.platform_funded_amount}
                        inputmode="decimal"
                        value={&draft.platform_funded_amount}
                        required
                    >
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_return_directive()}</span>
                    <select name={f.return_directive} required>
                        for value in RETURN_DIRECTIVES {
                            <option value={value} selected={value == draft.return_directive}>{return_directive(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_refund_trigger()}</span>
                    <select name={f.refund_trigger} required>
                        for value in REFUND_TRIGGERS {
                            <option value={value} selected={value == draft.refund_trigger}>{value}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_reason()}</span>
                    <select name={f.reason_code} required>
                        for value in REMEDY_REASONS {
                            <option value={value} selected={value == draft.reason_code}>{value}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_return_exception()}</span>
                    <select name={f.return_exception_reason_code}>
                        for value in RETURN_EXCEPTION_REASONS {
                            <option value={value} selected={value == draft.return_exception_reason_code}>{value}</option>
                        }
                    </select>
                </label>
            </div>
            <label class={Field}>
                <span>{t.ops_remedy_rationale()}</span>
                <textarea name={f.rationale} rows="3" required>{&draft.rationale}</textarea>
            </label>
            <label class={Field}>
                <span>{t.ops_remedy_evidence_references()}</span>
                <textarea name={f.evidence_references} rows="3" required>{&draft.evidence_references}</textarea>
            </label>
            <input type="hidden" name={f.idempotency_key} value={&key}>
            <div class={Actions}>
                <button type="submit" class={(Button, Secondary)} name={f.intent} value="preview-remedy" disabled={!can.propose}>
                    {t.ops_remedy_preview_submit()}
                </button>
                <button
                    type="submit"
                    class={Button}
                    name={f.intent}
                    value="propose-remedy"
                    disabled={!can.propose || screen.remedy_preview.is_none()}
                >
                    {t.ops_remedy_propose_submit()}
                </button>
            </div>
        </form>
        if let Some(preview) = &screen.remedy_preview {
            <Preview t={t} preview={preview} />
        }
    }
}

/// What a proposal would do (`PlatformRemedyPreview`).
#[component(css = RequestsPage)]
fn Preview<'a>(t: Sup, preview: &'a RemedyPreview) -> impl Render {
    let rows = [
        (t.ops_remedy_preview_customer(), preview.customer_outcome.clone()),
        (t.ops_remedy_preview_seller(), preview.seller_impact.clone()),
        (t.ops_remedy_preview_reserve(), preview.protection_reserve_impact.clone()),
        (t.ops_remedy_preview_label_payer(), preview.return_label_cost_payer.clone()),
        (t.ops_remedy_refund_trigger(), preview.refund_trigger.clone()),
        (t.ops_remedy_preview_expiry(), when(t, preview.reservation_expires_at.as_deref())),
        (t.ops_remedy_preview_approvals(), preview.required_approval_count.to_string()),
        (t.ops_remedy_policy_version(), preview.policy_version.clone()),
    ];
    html! {
        <section class={Card} role="status">
            <h4 class={Strong}>{t.ops_remedy_preview_title()}</h4>
            <dl class={Facts}>
                for (label, value) in &rows {
                    <div>
                        <dt>{*label}</dt>
                        <dd>{value}</dd>
                    </div>
                }
            </dl>
            if preview.requires_elevated_approval {
                <Tag words={t.ops_remedy_preview_elevated()} tone="warning" />
            }
            if preview.return_override_required {
                <Tag words={t.ops_remedy_preview_return_override()} tone="warning" />
            }
        </section>
    }
}

/// A remedy's workflow: its terms and status, its approval while one is pending, its effects, a
/// correction and its audit trail.
#[component(css = RequestsPage)]
fn Workflow<'a>(
    t: Sup,
    can: RemedyRights,
    workflow: &'a RemedyWorkflow,
    remedy: Option<&'a Remedy>,
    href: &'a str,
) -> impl Render {
    let f = ActionForm::FIELDS;
    let terms = &workflow.terms;
    let id = &terms.remedy_id;
    let amount = format!("{} {} · {}", terms.remedy.amount, terms.remedy.currency_code, terms.allocation.funding_kind);
    let directive = format!("{} · {}", terms.return_directive, terms.refund_trigger);
    let approvals = format!("{}/{}", workflow.approvals.len(), workflow.required_approval_count);
    html! {
        <section class={Card}>
            <p class={Line}>
                <span class={Strong}>{t.ops_remedy_workflow_title()}</span>
                <Tag words={&workflow.status} tone={workflow_tone(&workflow.status)} />
            </p>
            <p class={(Small, Words)}>{id}</p>
            <p>{&amount}</p>
            <p>{&directive}</p>
            <p>{t.ops_remedy_reservation_status()}": "{&workflow.reservation_status}</p>
            <p>{t.ops_remedy_preview_approvals()}": "{&approvals}</p>
            <p class={Words}>{t.ops_remedy_policy_version()}": "{&terms.policy_version}</p>
            if let Some(code) = &workflow.reservation_reason_code {
                <Tag words={code} tone="danger" />
            }
        </section>
        if workflow.status == "approval-pending" {
            <section class={Card}>
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.idempotency_key} value={&format!("{id}:approval")}>
                    <label class={Field}>
                        <span>{t.ops_remedy_approval_reason()}</span>
                        <select name={f.reason_code} required>
                            <option value="policy-approved">{t.ops_remedy_approval_policy_approved()}</option>
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_remedy_rationale()}</span>
                        <textarea name={f.rationale} rows="3" required></textarea>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_remedy_evidence_references()}</span>
                        <textarea name={f.evidence_references} rows="2" required></textarea>
                    </label>
                    <button type="submit" class={Button} name={f.intent} value="approve-remedy" disabled={!can.approve}>
                        {t.ops_remedy_approve_submit()}
                    </button>
                </form>
            </section>
        }
        if let Some(remedy) = remedy {
            <h4 class={Minor}>{t.ops_remedy_effects_title()}</h4>
            <ul class={List}>
                for effect in &remedy.effects {
                    <EffectEntry t={t} can={can} remedy_id={&remedy.remedy_id} effect={effect} href={href} />
                }
            </ul>
        }
        <section class={Card}>
            <form class={Form} method="post" action={href}>
                <input type="hidden" name={f.idempotency_key} value={&format!("{id}:correction")}>
                <label class={Field}>
                    <span>{t.ops_remedy_correction_reason()}</span>
                    <select name={f.reason_code} required>
                        for value in CORRECTION_REASONS {
                            <option value={value}>{value}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_rationale()}</span>
                    <textarea name={f.rationale} rows="2" required></textarea>
                </label>
                <label class={Field}>
                    <span>{t.ops_remedy_evidence_references()}</span>
                    <textarea name={f.evidence_references} rows="2" required></textarea>
                </label>
                <button
                    type="submit"
                    class={(Button, Secondary)}
                    name={f.intent}
                    value="request-remedy-correction"
                    disabled={!can.correct}
                >
                    {t.ops_remedy_correction_submit()}
                </button>
            </form>
        </section>
        if !workflow.audit_trail.is_empty() {
            <div class={Scroll}>
                <KitTable layout={TableLayout::Stack}>
                    <table class={Table} aria-label={t.ops_audit_trail()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.ops_action()}</th>
                                <th scope="col">{t.ops_remedy_audit_actor()}</th>
                                <th scope="col">{t.ops_remedy_reason()}</th>
                                <th scope="col">{t.ops_submitted()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for entry in &workflow.audit_trail {
                                let actor = if entry.actor_type == "system" {
                                    t.ops_remedy_audit_system()
                                } else {
                                    entry.actor_account_id.as_deref().unwrap_or_default()
                                };
                                <tr>
                                    <td>
                                        <CellLabel>{t.ops_action()}</CellLabel>
                                        {&entry.action}
                                    </td>
                                    <td>
                                        <CellLabel>{t.ops_remedy_audit_actor()}</CellLabel>
                                        <span class={Words}>{actor}</span>
                                    </td>
                                    <td>
                                        <CellLabel>{t.ops_remedy_reason()}</CellLabel>
                                        {&entry.reason_code}
                                    </td>
                                    <td>
                                        <CellLabel>{t.ops_submitted()}</CellLabel>
                                        {when(t, Some(&entry.occurred_at))}
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </KitTable>
            </div>
        }
    }
}

/// An execution effect, its latest fact, and the recovery admin-web offers: retry a retryable
/// failure, waive a terminal one it lets an operator waive, release a pending operator release.
#[component(css = RequestsPage)]
fn EffectEntry<'a>(t: Sup, can: RemedyRights, remedy_id: &'a str, effect: &'a RemedyEffect, href: &'a str) -> impl Render {
    let f = ActionForm::FIELDS;
    let retryable = effect.status == "failed-retryable";
    let release = effect.effect == "operator-release" && effect.status == "pending";
    html! {
        <li class={Entry}>
            <p class={Line}>
                <span class={(Strong, Words)}>{&effect.effect}</span>
                <Tag words={&effect.status} tone={effect_tone(&effect.status)} />
            </p>
            if let Some(latest) = effect.latest() {
                <p class={Small}>{&latest.reason_code}" · "{when(t, Some(&latest.occurred_at))}</p>
            }
            if retryable {
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.remedy_id} value={remedy_id}>
                    <input type="hidden" name={f.effect} value={&effect.effect}>
                    <input type="hidden" name={f.idempotency_key} value={&effect.key(remedy_id, "retry")}>
                    <label class={Field}>
                        <span>{t.ops_remedy_recovery_reason()}</span>
                        <input type="text" name={f.reason_code} required>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_remedy_rationale()}</span>
                        <textarea name={f.rationale} rows="2" required></textarea>
                    </label>
                    <button type="submit" class={Button} name={f.intent} value="retry-remedy-effect" disabled={!can.retry}>
                        {t.ops_remedy_retry_submit()}
                    </button>
                </form>
            }
            if effect.waivable() {
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.remedy_id} value={remedy_id}>
                    <input type="hidden" name={f.effect} value={&effect.effect}>
                    <input type="hidden" name={f.idempotency_key} value={&effect.key(remedy_id, "waive")}>
                    <label class={Field}>
                        <span>{t.ops_remedy_recovery_reason()}</span>
                        <input type="text" name={f.reason_code} required>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_remedy_rationale()}</span>
                        <textarea name={f.rationale} rows="2" required></textarea>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_remedy_evidence_references()}</span>
                        <textarea name={f.evidence_references} rows="2" required></textarea>
                    </label>
                    <button
                        type="submit"
                        class={(Button, Secondary)}
                        name={f.intent}
                        value="waive-remedy-effect"
                        disabled={!can.waive}
                    >
                        {t.ops_remedy_waive_submit()}
                    </button>
                </form>
            }
            if release {
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.remedy_id} value={remedy_id}>
                    <input type="hidden" name={f.idempotency_key} value={&format!("{remedy_id}:operator-release")}>
                    <label class={Field}>
                        <span>{t.ops_remedy_recovery_reason()}</span>
                        <input type="text" name={f.reason_code} required>
                    </label>
                    <button type="submit" class={Button} name={f.intent} value="release-remedy-refund" disabled={!can.release}>
                        {t.ops_remedy_release_submit()}
                    </button>
                </form>
            }
        </li>
    }
}
#[component(css = RequestsPage)]
fn OfferEntry<'a>(t: Sup, offer: &'a Offer) -> impl Render {
    let tone = if offer.status == "pending" { "warning" } else { "neutral" };
    html! {
        <li class={Entry}>
            <p class={Strong}>{resolution(t, &offer.resolution_type)}</p>
            <p class={(Small, Words)}>{&offer.summary}</p>
            <p class={Line}>
                <Tag words={&offer.status} tone={tone} />
                <span>{t.ops_resolve_refund_amount()}": "{offer.refund_amount.as_deref().unwrap_or(t.ops_not_applicable())}</span>
            </p>
        </li>
    }
}

/// The audit trail (`AuditTrail`): each entry's kind, summary, time and photos.
#[component(css = RequestsPage)]
fn AuditTrail<'a>(t: Sup, detail: &'a Detail) -> impl Render {
    let items: Vec<Activity<'_>> = detail.activity();
    html! {
        if items.is_empty() {
            <div class={Empty}>
                <p class={EmptyTitle}>{t.ops_audit_empty()}</p>
                <p class={Muted}>{t.ops_audit_empty_description()}</p>
            </div>
        } else {
            <ul class={List}>
                for item in &items {
                    let kind = match item.kind {
                        ActivityKind::Note => t.ops_audit_note(),
                        ActivityKind::Evidence => t.ops_audit_evidence(),
                        ActivityKind::Response => t.ops_audit_response(),
                        ActivityKind::Offer => t.ops_audit_offer(),
                        ActivityKind::Escalation => t.ops_audit_escalation(),
                        ActivityKind::Resolution => t.ops_audit_resolution(),
                    };
                    <li class={Entry}>
                        <p class={Line}>
                            <Tag words={kind} tone="neutral" />
                            <span class={Small}>{when(t, Some(item.at))}</span>
                        </p>
                        <p class={Words}>{item.summary}</p>
                        <Photos t={t} id={&detail.row.support_request_id} attachments={item.attachments} />
                    </li>
                }
            </ul>
        }
    }
}

/// An entry's private photos, each a thumbnail and a link to its full size
/// (`SupportEvidenceAttachmentGallery`), relayed by the pilot.
#[component(css = RequestsPage)]
fn Photos<'a>(t: Sup, id: &'a str, attachments: &'a [String]) -> impl Render {
    let photos: Vec<String> = attachments
        .iter()
        .filter_map(|reference| attachment_id(reference))
        .map(|attachment| url::Attachment { id, attachment }.href())
        .collect();
    html! {
        if !photos.is_empty() {
            <ul class={Gallery}>
                for (index, href) in photos.iter().enumerate() {
                    let number = index + 1;
                    <li>
                        <img src={href} alt={&t.att_photo_alt(number).to_string()} loading="lazy">
                        <a class={Open} href={href} target="_blank" rel="noreferrer">{t.att_full_size(number)}</a>
                    </li>
                }
            </ul>
        }
    }
}

/// The adjudication comparison (`CaseAdjudicationPanel`): both parties' positions, the escalation and
/// the offer history.
#[component(css = RequestsPage)]
fn Adjudication<'a>(t: Sup, detail: &'a Detail) -> impl Render {
    let any =
        !detail.responses.is_empty() || !detail.evidence.is_empty() || !detail.offers.is_empty() || detail.escalated_at.is_some();
    html! {
        <section class={(Part, Card)}>
            <h3 class={Subheading}>{t.ops_adjudication_title()}</h3>
            <p class={Muted}>{t.ops_adjudication_description()}</p>
            if any {
                <div class={Positions}>
                    <Position
                        t={t}
                        detail={detail}
                        role="buyer"
                        heading={t.ops_adjudication_buyer_position()}
                        empty={t.ops_adjudication_no_buyer_position()}
                    />
                    <Position
                        t={t}
                        detail={detail}
                        role="seller"
                        heading={t.ops_adjudication_seller_position()}
                        empty={t.ops_adjudication_no_seller_position()}
                    />
                </div>
                <h4 class={Minor}>{t.ops_adjudication_escalation_title()}</h4>
                if let Some(at) = &detail.escalated_at {
                    <div class={Entry}>
                        <p class={Line}>
                            <Tag
                                words={&t.ops_adjudication_escalation_origin(detail.escalated_by_role.as_deref().unwrap_or("support")).to_string()}
                                tone="warning"
                            />
                            <span class={Small}>{when(t, Some(at))}</span>
                        </p>
                        if let Some(reason) = &detail.escalation_reason {
                            <p class={Words}>{reason}</p>
                        }
                    </div>
                } else {
                    <p class={Muted}>{t.ops_adjudication_escalation_none()}</p>
                }
                <h4 class={Minor}>{t.ops_adjudication_offers_title()}</h4>
                if detail.offers.is_empty() {
                    <p class={Muted}>{t.ops_adjudication_offers_none()}</p>
                } else {
                    <ul class={List}>
                        for offer in &detail.offers {
                            let tone = match offer.status.as_str() { "declined" => "danger", "pending" => "warning", _ => "success" };
                            <li class={Entry}>
                                <p class={Strong}>{resolution(t, &offer.resolution_type)}</p>
                                <p class={Small}>{t.ops_adjudication_offers_offered_by(&offer.offered_by_role)}</p>
                                <p class={(Small, Words)}>{&offer.summary}</p>
                                <p class={Line}>
                                    <Tag words={&offer.status} tone={tone} />
                                    <span>{offer.refund_amount.as_deref().unwrap_or(t.ops_not_applicable())}</span>
                                </p>
                                if offer.status == "declined" {
                                    <p class={Small}>
                                        {t.ops_adjudication_offers_declined_by(offer.decided_by_role.as_deref().unwrap_or("support"))}
                                    </p>
                                }
                            </li>
                        }
                    </ul>
                }
            } else {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.ops_adjudication_no_buyer_position()}</p>
                </div>
            }
        </section>
    }
}

/// One party's responses and evidence (`PartyPosition`).
#[component(css = RequestsPage)]
fn Position<'a>(t: Sup, detail: &'a Detail, role: &'a str, heading: &'a str, empty: &'a str) -> impl Render {
    let responses: Vec<_> = detail.responses.iter().filter(|r| r.submitted_by_role == role).collect();
    let evidence: Vec<_> =
        detail.evidence.iter().filter(|e| e.submitted_by_role == role && e.evidence_type != "support-note").collect();
    html! {
        <div class={Entry}>
            <p class={Strong}>{heading}</p>
            if responses.is_empty() && evidence.is_empty() {
                <p class={Muted}>{empty}</p>
            }
            for response in &responses {
                <p class={Line}>
                    <Tag
                        words={response_type(t, &response.response_type)}
                        tone={if response.response_type == "challenge-with-evidence" { "warning" } else { "neutral" }}
                    />
                    <span class={Small}>{when(t, Some(&response.submitted_at))}</span>
                </p>
                <p class={Words}>{&response.summary}</p>
            }
            for item in &evidence {
                <p class={Line}>
                    <Tag words={&item.evidence_type} tone="neutral" />
                    <span class={Small}>{when(t, Some(&item.submitted_at))}</span>
                </p>
                <p class={Words}>{&item.summary}</p>
                if item.attachments.is_empty() {
                    <p class={Small}>{t.ops_adjudication_evidence_no_attachments()}</p>
                } else {
                    <Photos t={t} id={&detail.row.support_request_id} attachments={&item.attachments} />
                }
            }
        </div>
    }
}

/// The full case context (`FullCaseContext`): the return lines and the evidence that is not a note.
#[component(css = RequestsPage)]
fn CaseContext<'a>(t: Sup, detail: &'a Detail) -> impl Render {
    let evidence: Vec<_> = detail.evidence.iter().filter(|e| e.evidence_type != "support-note").collect();
    html! {
        if detail.order_return_context.is_empty() {
            <div class={Empty}>
                <p class={EmptyTitle}>{t.ops_no_return_context()}</p>
                <p class={Muted}>{t.ops_no_return_context_description()}</p>
            </div>
        } else {
            <ul class={List}>
                for line in &detail.order_return_context {
                    let card = &line["gradedCard"];
                    let graded = if card.is_object() {
                        let cert = card["certificationNumber"].as_str().map(|c| t.ops_certification_number(c).to_string());
                        [card["gradingCompany"].as_str().map(str::to_owned), card["grade"].as_str().map(str::to_owned), cert]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" ")
                    } else {
                        t.ops_not_applicable().to_owned()
                    };
                    <li class={Entry}>
                        <p class={(Strong, Words)}>{line["itemTitle"].as_str().unwrap_or_default()}</p>
                        <p class={(Small, Words)}>{t.ops_listing()}": "{line["listingId"].as_str().unwrap_or_default()}</p>
                        <p class={Small}>{t.ops_graded_card()}": "{&graded}</p>
                    </li>
                }
            </ul>
        }
        if evidence.is_empty() {
            <div class={Empty}>
                <p class={EmptyTitle}>{t.ops_no_evidence()}</p>
                <p class={Muted}>{t.ops_no_evidence_description()}</p>
            </div>
        } else {
            <ul class={List}>
                for item in &evidence {
                    <li class={Entry}>
                        <p class={Line}>
                            <Tag words={&item.evidence_type} tone="neutral" />
                            <span class={Small}>{when(t, Some(&item.submitted_at))}</span>
                        </p>
                        <p class={Words}>{&item.summary}</p>
                    </li>
                }
            </ul>
        }
    }
}

/// A case action's form: Respond, Escalate or Resolve.
#[component(css = RequestsPage)]
fn CaseForm<'a>(t: Sup, action: CaseAction, detail: &'a Detail, href: &'a str) -> impl Render {
    let f = ActionForm::FIELDS;
    let reasons = detail.reasons();
    let cap = detail.refund_cap();
    let prefill = detail.refund_prefill().unwrap_or_default();
    html! {
        <form class={Form} method="post" action={href}>
            match action {
                CaseAction::Response => {
                    <input type="hidden" name={f.intent} value="response">
                    <label class={Field}>
                        <span>{t.ops_response_type()}</span>
                        <select name={f.response_type} required>
                            for value in RESPONSE_TYPES {
                                <option value={value}>{response_type(t, value)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_response_summary()}</span>
                        <textarea name={f.summary} rows="3" required></textarea>
                    </label>
                    <button type="submit" class={Button}>{t.ops_response_submit()}</button>
                }
                CaseAction::Escalate => {
                    <input type="hidden" name={f.intent} value="escalate">
                    <label class={Field}>
                        <span>{t.ops_escalate_reason()}</span>
                        <textarea name={f.reason} rows="3" required></textarea>
                    </label>
                    <button type="submit" class={(Button, Secondary)}>{t.ops_escalate_submit()}</button>
                }
                CaseAction::Resolve => {
                    <input type="hidden" name={f.intent} value="resolve">
                    <label class={Field}>
                        <span>{t.ops_resolve_type()}</span>
                        <select name={f.resolution_type} required>
                            for value in detail.resolutions() {
                                <option value={value}>{resolution(t, value)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_resolve_summary()}</span>
                        <textarea name={f.summary} rows="3" required></textarea>
                    </label>
                    <p class={Small}>{t.ops_adjudication_decision_summary_verbatim()}</p>
                    <label class={Field}>
                        <span>{t.ops_resolve_refund_amount()}</span>
                        <input type="text" name={f.refund_amount} inputmode="decimal" value={prefill}>
                    </label>
                    if let Some(cap) = cap {
                        <p class={Small}>{t.ops_adjudication_decision_refund_cap(cap)}</p>
                    }
                    <label class={Field}>
                        <span>{t.ops_resolve_responsibility_reason()}</span>
                        <select name={f.responsibility_finding} required>
                            for reason in reasons {
                                <option value={&format!("{}|{}", reason.responsibility, reason.code)}>
                                    {t.ops_resolve_responsibility_reason_option(crate::text::sup::OpsResolveResponsibilityReasonOption { reason: &reason.operator_label, responsibility: &reason.responsibility })}
                                </option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.ops_resolve_evidence_basis()}</span>
                        <select name={f.evidence_basis_type} required>
                            <option value="operator-finding" selected>{t.ops_resolve_evidence_basis_operator_finding()}</option>
                            <option value="insufficient-evidence">{t.ops_resolve_evidence_basis_insufficient_evidence()}</option>
                        </select>
                    </label>
                    <button type="submit" class={Button}>{t.ops_resolve_submit()}</button>
                }
            }
        </form>
    }
}

/// Other actions (`OtherActions`): the two case actions not recommended, a note, Close once resolved,
/// and Cancel, while the request is open.
#[component(css = RequestsPage)]
fn OtherActions<'a>(t: Sup, detail: &'a Detail, recommended: CaseAction, href: &'a str) -> impl Render {
    let f = ActionForm::FIELDS;
    let open = !detail.terminal();
    html! {
        if open {
            for action in [CaseAction::Response, CaseAction::Escalate, CaseAction::Resolve] {
                if action != recommended {
                    <div class={Card}>
                        <CaseForm t={t} action={action} detail={detail} href={href} />
                    </div>
                }
            }
            <div class={Card}>
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.intent} value="note">
                    <label class={Field}>
                        <span>{t.ops_note_summary()}</span>
                        <textarea name={f.summary} rows="3" required></textarea>
                    </label>
                    <button type="submit" class={(Button, Secondary)}>{t.ops_note_submit()}</button>
                </form>
            </div>
        }
        if detail.row.status == "resolved" {
            <div class={Card}>
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.intent} value="close">
                    <p class={Muted}>{t.ops_close_description()}</p>
                    for reason in &detail.closure_blocking_reasons {
                        <Tag words={reason} tone="danger" />
                    }
                    <button type="submit" class={(Button, Secondary)} disabled={!detail.closure_eligible}>
                        {t.ops_close_submit()}
                    </button>
                </form>
            </div>
        }
        if open {
            <div class={Card}>
                <form class={Form} method="post" action={href}>
                    <input type="hidden" name={f.intent} value="cancel">
                    <label class={Field}>
                        <span>{t.ops_cancel_reason()}</span>
                        <textarea name={f.reason} rows="3" required></textarea>
                    </label>
                    <button type="submit" class={(Button, DangerButton)}>{t.ops_cancel_submit()}</button>
                </form>
            </div>
        }
    }
}
