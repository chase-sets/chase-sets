//! The account's support page (Platform Operations' `SupportRequestListPage`): the header, what the
//! last post said, Report a problem (the intake's three steps for an order, or where to start
//! one), the buyer's and the seller's cases with their resolution's progress, and the flows.
//!
//! The intake's first two steps are GET forms to the page (a step and its choices are the
//! address); the last posts the address with the photos. The affected items are corten-ui's
//! `CheckboxGroup`, so with its script the browser stops Continue with no item at the group
//! (todd-skelton/corten#272); without it, Continue with no item draws the items step again and
//! says so, as the server always checks. A table is a list of cards on a phone, each cell with its
//! column's name, and a table from 48rem.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use corten_ui::CheckboxGroup;

use super::{on_marketplace, order_page::display_reference};
use crate::{
    api::{CustomerRemedyStatus, RemedyState, ReturnShipping, SupportCaseRow, SupportFlowSummary},
    app::url,
    support::Role,
    support_list::{Intake, OpenInput, PICTURES, Step, SupportListScreen, checklist},
    text::SupportMsg,
};

/// The case already open for the order, where View existing case goes.
#[derive(Id)]
pub struct ExistingCaseId;

/// An amount the API sent in `currency` (`formatMoney`), or as it came.
fn money(t: SupportMsg, amount: &str, currency: &str) -> String {
    let currency = if currency.trim().is_empty() { "USD" } else { currency.trim() };
    match (platform::money::decimal(amount), Currency::parse(currency)) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => amount.to_owned(),
    }
}

/// A moment, short (`formatDateTime(.., { preset: "short" })`), or N/A.
fn when(t: SupportMsg, at: Option<&str>) -> String {
    match at.and_then(|at| parse_timestamp(at).map(|m| (at, m))) {
        Some((_, moment)) => t.date_time(moment, DateStyle::Short, TimeStyle::Short).to_string(),
        None => at.map_or_else(|| t.list_not_applicable().to_owned(), str::to_owned),
    }
}

/// A case's status badge tone (`statusTone`).
fn status_tone(status: &str) -> &'static str {
    match status {
        "resolved" | "closed" => "success",
        "ready-for-support" => "warning",
        _ => "neutral",
    }
}

/// A flow's default outcome (`resolutionLabel`).
fn resolution(t: SupportMsg, resolution: &str) -> String {
    match resolution {
        "full-refund" => t.resolution_full_refund(),
        "partial-refund" => t.resolution_partial_refund(),
        "return-for-refund" => t.resolution_return_for_refund(),
        "replacement" => t.resolution_replacement(),
        "cancel-order" => t.resolution_cancel_order(),
        "no-action" => t.resolution_no_action(),
        "support-reviewed" => t.resolution_support_reviewed(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A flow's seller response window, or support's.
fn window(t: SupportMsg, flow: &SupportFlowSummary) -> String {
    match flow.seller_response_hours {
        Some(hours) => t.list_hours(hours).to_string(),
        None => t.list_support_owned().to_owned(),
    }
}

/// The page.
#[component(css)]
pub fn SupportListPage<'a>(t: SupportMsg, screen: &'a SupportListScreen) -> impl Render {
    let said = &screen.said;
    let opened = screen.ask.opened.as_deref().filter(|o| !o.is_empty());
    html! {
        <header class={Header}>
            <h1 class={Title}>{t.list_title()}</h1>
            <p class={Muted}>{t.list_description()}</p>
        </header>
        <div class={Notices} role="status" aria-live="polite">
            if let Some(opened) = opened {
                <div class={Banner} data-tone="success">
                    <p class={Strong}>{t.list_open_success(&display_reference(opened))}</p>
                </div>
            }
            if let Some(error) = &said.error {
                <div class={Banner} data-tone="danger" tabindex="-1" autofocus>
                    <p class={Strong}>{error}</p>
                    <p>{t.list_photos_retry()}</p>
                </div>
            }
            if let Some(error) = &screen.lookup_error {
                <div class={Banner} data-tone="danger">
                    <p class={Strong}>{error}</p>
                </div>
            }
            if let Some(recovery) = &said.open {
                <div class={Banner} data-tone="warning">
                    <h2 class={PartTitle} tabindex="-1" autofocus={said.error.is_none()}>{t.attempt_check_before_retry()}</h2>
                    <p>{t.attempt_ambiguous()}</p>
                    <form
                        method="post"
                        action={url::SupportList { ask: screen.ask.at(Step::Review) }}
                        enctype="multipart/form-data"
                    >
                        <input type="hidden" name={OpenInput::FIELDS.intent} value="check-status">
                        <input type="hidden" name={OpenInput::FIELDS.account} value={&screen.account}>
                        <input type="hidden" name={OpenInput::FIELDS.check_attempt} value={&recovery.attempt}>
                        <input type="hidden" name={OpenInput::FIELDS.check_hash} value={&recovery.hash}>
                        <button type="submit" class={Button}>{t.attempt_check_status()}</button>
                    </form>
                </div>
            }
        </div>
        <section class={Section} aria-labelledby="support-open-title">
            <div class={Tight}>
                <h2 id="support-open-title" class={PartTitle}>{t.list_open_title()}</h2>
                <p class={Muted}>{t.list_open_description()}</p>
            </div>
            match &screen.intake {
                Some(intake) => { <IntakePanel t={t} screen={screen} intake={intake} /> }
                None => {
                    <div class={Card}>
                        <p>{t.list_intake_from_order()}</p>
                        <p class={Row}>
                            <a class={Button} href={url::Purchases::default()}>{t.list_intake_purchases()}</a>
                            <a class={(Button, Secondary)} href={url::Sales::default()}>{t.list_intake_sales()}</a>
                        </p>
                    </div>
                }
            }
        </section>
        <section class={Section} aria-labelledby="support-buyer-title">
            <h2 id="support-buyer-title" class={PartTitle}>{t.list_buyer_requests()}</h2>
            <CaseTable t={t} rows={&screen.buyer} role={Role::Buyer} />
        </section>
        <section class={Section} aria-labelledby="support-seller-title">
            <h2 id="support-seller-title" class={PartTitle}>{t.list_seller_requests()}</h2>
            <CaseTable t={t} rows={&screen.seller} role={Role::Seller} />
        </section>
        <section class={Section} aria-labelledby="support-flows-title">
            <div class={Tight}>
                <h2 id="support-flows-title" class={PartTitle}>{t.list_available_flows()}</h2>
                <p class={Muted}>{t.list_available_flows_description()}</p>
            </div>
            <table class={Table}>
                <thead>
                    <tr>
                        <th scope="col">{t.list_flow()}</th>
                        <th scope="col">{t.list_default_outcome()}</th>
                        <th scope="col">{t.list_response_window()}</th>
                    </tr>
                </thead>
                <tbody>
                    for flow in &screen.flows {
                        <tr>
                            <td data-label={t.list_flow()}>{&flow.title}</td>
                            <td data-label={t.list_default_outcome()}>{resolution(t, &flow.default_resolution)}</td>
                            <td data-label={t.list_response_window()}>{window(t, flow)}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </section>
    }
}

/// The buyer's or the seller's cases (`SupportRequestTable`).
#[component(css = SupportListPage)]
fn CaseTable<'a>(t: SupportMsg, rows: &'a [SupportCaseRow], role: Role) -> impl Render {
    html! {
        if rows.is_empty() {
            <div class={Card}>
                <p class={Strong}>{t.list_no_requests()}</p>
                <p class={Muted}>{t.list_no_requests_description()}</p>
            </div>
        } else {
            <table class={Table}>
                <thead>
                    <tr>
                        <th scope="col">{t.list_reference()}</th>
                        <th scope="col">{t.list_issue()}</th>
                        <th scope="col">{t.list_order()}</th>
                        <th scope="col">{t.list_status()}</th>
                        <th scope="col">{t.list_priority()}</th>
                        <th scope="col">{t.list_next_deadline()}</th>
                        <th scope="col">{t.list_checklist()}</th>
                        <th scope="col">{t.list_resolution()}</th>
                    </tr>
                </thead>
                <tbody>
                    for row in rows {
                        <CaseRow t={t} row={row} role={role} />
                    }
                </tbody>
            </table>
        }
    }
}

#[component(css = SupportListPage)]
fn CaseRow<'a>(t: SupportMsg, row: &'a SupportCaseRow, role: Role) -> impl Render {
    let reference = if row.display_reference.is_empty() { &row.support_request_id } else { &row.display_reference };
    let (done, required) = checklist(row);
    html! {
        <tr>
            <td data-label={t.list_reference()}>
                <a class={(Link, Strong)} href={url::SupportCase { id: &row.support_request_id, place: Default::default() }}>
                    {reference}
                </a>
            </td>
            <td data-label={t.list_issue()}>{&row.flow_type}</td>
            <td data-label={t.list_order()}>{&row.order_id}</td>
            <td data-label={t.list_status()}><span class={Badge} data-tone={status_tone(&row.status)}>{&row.status}</span></td>
            <td data-label={t.list_priority()}>
                <span class={Badge} data-tone={if row.priority == "urgent" { "danger" } else { "neutral" }}>{&row.priority}</span>
            </td>
            <td data-label={t.list_next_deadline()}>{when(t, row.next_deadline.as_deref())}</td>
            <td data-label={t.list_checklist()}>{t.list_checklist_summary(done, required)}</td>
            <td data-label={t.list_resolution()}>
                <div class={Stack}>
                    if let Some(status) = &row.customer_remedy_status {
                        <RemedyStatus t={t} status={status} role={role} />
                    }
                    if let Some(shipping) = &row.return_shipping {
                        <ReturnShippingStatus t={t} shipping={shipping} role={role} />
                    }
                </div>
            </td>
        </tr>
    }
}

/// The state's title and tone, and whether it is the end.
fn remedy_title(t: SupportMsg, state: RemedyState) -> (&'static str, &'static str) {
    match state {
        RemedyState::Proposed => (t.remedy_state_proposed(), "neutral"),
        RemedyState::AwaitingCoverage => (t.remedy_state_awaiting_coverage(), "warning"),
        RemedyState::LabelReady => (t.remedy_state_label_ready(), "warning"),
        RemedyState::InTransit => (t.remedy_state_in_transit(), "neutral"),
        RemedyState::AwaitingIntake => (t.remedy_state_awaiting_intake(), "neutral"),
        RemedyState::RefundSubmitted => (t.remedy_state_refund_submitted(), "neutral"),
        RemedyState::RefundConfirmed => (t.remedy_state_refund_confirmed(), "success"),
        RemedyState::ReconciliationPending => (t.remedy_state_reconciliation_pending(), "neutral"),
        RemedyState::Completed => (t.remedy_state_completed(), "success"),
        RemedyState::Expired => (t.remedy_state_expired(), "danger"),
        RemedyState::CarrierException => (t.remedy_state_carrier_exception(), "danger"),
        RemedyState::RefundFailure => (t.remedy_state_refund_failure(), "danger"),
        RemedyState::ManualReview => (t.remedy_state_manual_review(), "warning"),
        RemedyState::InProgress => (t.remedy_state_in_progress(), "neutral"),
    }
}

/// What the remedy gives, in the role's words (`outcomeCopy`).
fn outcome(t: SupportMsg, status: &CustomerRemedyStatus) -> String {
    let amount = money(t, &status.amount, &status.currency_code);
    let seller = money(t, &status.seller_amount, &status.allocation_currency_code);
    let platform = money(t, &status.platform_amount, &status.allocation_currency_code);
    match status.outcome.as_str() {
        "underReview" => t.remedy_outcome_under_review(&amount).to_string(),
        "fullRefund" => t.remedy_outcome_full_refund(&amount).to_string(),
        "partialRefund" => t.remedy_outcome_partial_refund(&amount).to_string(),
        "sellerFunded" => t.remedy_seller_allocation_seller_funded(&seller).to_string(),
        "completedCovered" => t.remedy_seller_allocation_completed_covered(&seller, &platform).to_string(),
        _ => t.remedy_seller_allocation_covered(&seller, &platform).to_string(),
    }
}

/// What the buyer is told about coverage (`coverageCopy`).
fn coverage(t: SupportMsg, status: &CustomerRemedyStatus) -> Option<String> {
    match status.coverage.as_deref() {
        Some("full") => Some(t.remedy_coverage_full().to_owned()),
        Some("partial") => {
            Some(t.remedy_coverage_partial(&money(t, &status.platform_amount, &status.allocation_currency_code)).to_string())
        }
        _ => None,
    }
}

/// Where the item goes back to (`returnCopy`).
fn return_copy(t: SupportMsg, status: &CustomerRemedyStatus, role: Role) -> &'static str {
    match (status.return_directive.as_deref(), role) {
        (Some("return-to-platform"), Role::Buyer) => t.remedy_return_buyer_platform(),
        (Some("return-to-platform"), _) => t.remedy_return_seller_platform(),
        (Some("return-to-seller"), Role::Buyer) => t.remedy_return_buyer_seller(),
        (Some("return-to-seller"), _) => t.remedy_return_seller_seller(),
        _ => t.remedy_return_none(),
    }
}

/// When the refund can be submitted (`refundTimingCopy`).
fn refund_timing(t: SupportMsg, status: &CustomerRemedyStatus) -> &'static str {
    match status.refund_trigger.as_deref() {
        Some("carrier-accepted") => t.remedy_refund_timing_carrier_accepted(),
        Some("delivered") => t.remedy_refund_timing_delivered(),
        Some("facility-intake") => t.remedy_refund_timing_intake(),
        Some("operator-release") => t.remedy_refund_timing_review(),
        _ => t.remedy_refund_timing_immediate(),
    }
}

/// What the role does next (`nextActionCopy`).
fn next_action(t: SupportMsg, status: &CustomerRemedyStatus) -> Option<&'static str> {
    Some(match status.next_action.as_deref()? {
        "ship" => t.remedy_next_action_ship(),
        "waitForLabel" => t.remedy_next_action_wait_for_label(),
        "followSupport" => t.remedy_next_action_follow_support(),
        "refundFailure" => t.remedy_next_action_refund_failure(),
        _ => t.remedy_next_action_none(),
    })
}

/// A case's remedy as its buyer or seller sees it (`CustomerRemedyStatus`), from the list read's
/// projection.
#[component(css = SupportListPage)]
fn RemedyStatus<'a>(t: SupportMsg, status: &'a CustomerRemedyStatus, role: Role) -> impl Render {
    let (title, tone) = remedy_title(t, status.state);
    html! {
        <div class={Stack}>
            <span class={Badge} data-tone={tone}>{title}</span>
            <p class={(Small, Strong)}>{outcome(t, status)}</p>
            if let Some(coverage) = coverage(t, status) {
                <p class={Small}>{coverage}</p>
            }
            if status.no_fault_finding {
                <p class={(Small, Muted)}>{t.remedy_coverage_no_fault_finding()}</p>
            }
            <p class={(Small, Muted)}>{return_copy(t, status, role)}</p>
            <p class={(Small, Muted)}>{refund_timing(t, status)}</p>
            if let Some(next) = next_action(t, status).filter(|_| !status.terminal) {
                <div class={Next}>
                    <p class={(Small, Muted)}>{t.remedy_next_action_label()}</p>
                    <p class={(Small, Strong)}>{next}</p>
                </div>
            }
            <a class={(Link, Small)} href={&on_marketplace("/help/buying/order-protection#platform-covered-resolutions")}>
                {t.remedy_policy_link()}
            </a>
        </div>
    }
}

/// A case's return shipment (`ReturnShippingStatus`).
#[component(css = SupportListPage)]
fn ReturnShippingStatus<'a>(t: SupportMsg, shipping: &'a ReturnShipping, role: Role) -> impl Render {
    let (tone, label) = match shipping.label_status.as_str() {
        "failed" => ("danger", t.shipping_failed()),
        "voided" => ("neutral", t.shipping_voided()),
        "ready" if shipping.status == "delivered" => ("success", t.shipping_delivered()),
        "ready" => ("info", t.shipping_ready()),
        _ => ("neutral", t.shipping_pending()),
    };
    let amount = shipping
        .postage_amount_cents
        .map(|cents| {
            money(
                t,
                &format!("{}.{:02}", cents / 100, (cents % 100).abs()),
                shipping.postage_currency.as_deref().unwrap_or("USD"),
            )
        })
        .unwrap_or_default();
    let label_url = shipping.label_document_url.as_deref().filter(|_| role == Role::Buyer && shipping.label_status == "ready");
    html! {
        <div class={Stack}>
            <p class={(Small, Strong)}>{t.shipping_title()}</p>
            <span class={Badge} data-tone={tone}>{label}</span>
            if shipping.label_status == "failed" {
                <p class={(Small, Danger)}>{t.shipping_fallback()}</p>
            }
            if let Some(href) = label_url {
                <a class={(Link, Small)} href={&on_marketplace(href)}>{t.shipping_open_label()}</a>
            }
            if let Some(tracking) = &shipping.tracking_identifier {
                <p class={Small}>{t.shipping_tracking(tracking)}</p>
            }
            <p class={(Small, Muted)}>
                if shipping.cost_payer == "buyer" {
                    {t.shipping_buyer_pays(&amount)}
                } else {
                    {t.shipping_seller_pays()}
                }
            </p>
        </div>
    }
}

/// Report a problem for an order (`SupportRequestOpenPanel`): the case already open for it, or the
/// order and its three steps.
#[component(css = SupportListPage)]
fn IntakePanel<'a>(t: SupportMsg, screen: &'a SupportListScreen, intake: &'a Intake) -> impl Render {
    let order = &intake.order;
    let currency = order.lines.first().map_or("USD", |l| l.currency_code.as_str());
    let current = Step::ALL.iter().position(|s| *s == intake.step).unwrap_or(0);
    html! {
        if let Some(existing) = order.existing_open_request.as_ref().filter(|_| intake.duplicate) {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.list_duplicate_title()}</p>
                <p>{t.list_duplicate_description()}</p>
                <p><a class={(Button, Secondary)} href={ExistingCaseId.fragment()}>{t.list_duplicate_view()}</a></p>
            </div>
            <div class={Card} id={ExistingCaseId}>
                <p class={Row}>
                    <a
                        class={(Link, Strong)}
                        href={url::SupportCase { id: &existing.support_request_id, place: Default::default() }}
                    >
                        if existing.display_reference.is_empty() {
                            {&existing.support_request_id}
                        } else {
                            {&existing.display_reference}
                        }
                    </a>
                    <span class={Badge} data-tone={status_tone(&existing.status)}>{&existing.status}</span>
                </p>
                <p class={Muted}>
                    {screen.flows.iter().find(|f| f.flow_type == existing.flow_type).map_or(existing.flow_type.as_str(), |f| f.title.as_str())}
                </p>
            </div>
        } else {
            <div class={Card}>
                <p class={Row}>
                    <span class={Strong}>{&order.order_id}</span>
                    <span class={Badge} data-tone="neutral">{&order.status}</span>
                    <span class={Muted}>{money(t, &order.total_amount, currency)}</span>
                </p>
                <ol class={Steps}>
                    for (i, step) in Step::ALL.iter().enumerate() {
                        if i == current {
                            <li data-state="current" aria-current="step">{step_title(t, *step)}</li>
                        } else {
                            <li data-state={if i < current { "complete" } else { "upcoming" }}>{step_title(t, *step)}</li>
                        }
                    }
                </ol>
                match intake.step {
                    Step::Items => { <ItemsStep t={t} intake={intake} /> }
                    Step::Issue => { <IssueStep t={t} intake={intake} /> }
                    Step::Review => { <ReviewStep t={t} screen={screen} intake={intake} /> }
                }
            </div>
        }
    }
}

fn step_title(t: SupportMsg, step: Step) -> &'static str {
    match step {
        Step::Items => t.list_intake_items(),
        Step::Issue => t.list_intake_issue(),
        Step::Review => t.list_intake_review(),
    }
}

/// The address's order and flow, which a step's GET form sends again.
#[component(css = SupportListPage)]
fn Kept<'a>(intake: &'a Intake, flow: bool, lines: bool) -> impl Render {
    html! {
        <input type="hidden" name="orderId" value={&intake.order.order_id}>
        if flow {
            if let Some(flow) = &intake.flow {
                <input type="hidden" name="flow" value={&flow.flow_type}>
            }
        }
        if lines {
            for line in &intake.lines {
                <input type="hidden" name="line" value={line}>
            }
        }
    }
}

/// The affected items (a GET form).
#[component(css = SupportListPage)]
fn ItemsStep<'a>(t: SupportMsg, intake: &'a Intake) -> impl Render {
    let lines = &intake.order.lines;
    html! {
        <form class={Form} method="get" action={url::SupportList::default()}>
            <Kept intake={intake} flow={true} lines={false} />
            <h3 class={PartTitle}>{t.list_intake_items()}</h3>
            if lines.is_empty() {
                <div class={Banner} data-tone="info"><p>{t.list_intake_whole_order()}</p></div>
            } else {
                <div class={Group}>
                    <CheckboxGroup legend={t.list_intake_items_label()} missing={t.list_intake_items_description()}>
                        if intake.choose_items {
                            <p id="support-items-hint" class={(Small, Danger)} role="alert">
                                {t.list_intake_items_description()}
                            </p>
                        } else {
                            <p id="support-items-hint" class={(Small, Muted)}>{t.list_intake_items_description()}</p>
                        }
                        for line in lines {
                            <label class={Choice}>
                                <input
                                    type="checkbox"
                                    name="line"
                                    value={&line.line_id}
                                    checked={intake.lines.contains(&line.line_id)}
                                >
                                <span class={Tight}>
                                    <span>
                                        {t.list_intake_item_label(&line.item_title, line.quantity, &money(t, &line.amount, &line.currency_code))}
                                    </span>
                                    if let Some(summary) = &line.product_summary {
                                        <span class={(Small, Muted)}>{summary}</span>
                                    }
                                </span>
                            </label>
                        }
                    </CheckboxGroup>
                </div>
            }
            <div class={End}>
                <button type="submit" class={Button} name="step" value="issue">{t.list_intake_continue()}</button>
            </div>
        </form>
    }
}

/// The issue (a GET form): the flows the order's party may open.
#[component(css = SupportListPage)]
fn IssueStep<'a>(t: SupportMsg, intake: &'a Intake) -> impl Render {
    let chosen = intake.flow.as_ref().map(|f| f.flow_type.as_str());
    html! {
        <form class={Form} method="get" action={url::SupportList::default()}>
            <Kept intake={intake} flow={false} lines={true} />
            <h3 class={PartTitle}>{t.list_intake_issue()}</h3>
            <fieldset class={Plain}>
                <legend class={Strong}>{t.list_intake_issue_label()}</legend>
                for flow in &intake.flows {
                    <label class={Choice}>
                        <input
                            type="radio"
                            name="flow"
                            value={&flow.flow_type}
                            checked={chosen == Some(flow.flow_type.as_str())}
                            required
                        >
                        <span class={Tight}>
                            <span>{&flow.title}</span>
                            <span class={(Small, Muted)}>{&flow.automation_summary}</span>
                        </span>
                    </label>
                }
            </fieldset>
            <div class={End}>
                <button type="submit" class={(Button, Secondary)} name="step" value="items" formnovalidate>
                    {t.list_intake_back()}
                </button>
                <button type="submit" class={Button} name="step" value="review">{t.list_intake_continue()}</button>
            </div>
        </form>
    }
}

/// The outcome and the photos (the post that opens the case).
#[component(css = SupportListPage)]
fn ReviewStep<'a>(t: SupportMsg, screen: &'a SupportListScreen, intake: &'a Intake) -> impl Render {
    let f = OpenInput::FIELDS;
    let batch = &intake.batch;
    let here = url::SupportList { ask: screen.ask.at(Step::Review) };
    let count = if intake.lines.is_empty() { intake.order.lines.len() } else { intake.lines.len() };
    html! {
        if let Some(flow) = &intake.flow {
            <h3 class={PartTitle}>{t.list_intake_review()}</h3>
            <dl class={(Facts, Inset)}>
                <div>
                    <dt>{t.list_issue()}</dt>
                    <dd class={Strong}>{&flow.title}</dd>
                </div>
                <div>
                    <dt>{t.list_default_outcome()}</dt>
                    <dd>{resolution(t, &flow.default_resolution)}</dd>
                </div>
                <div>
                    <dt>{t.list_intake_seller_window()}</dt>
                    <dd>{window(t, flow)}</dd>
                </div>
                <div>
                    <dt>{t.list_intake_automatic_outcome()}</dt>
                    <dd>{&flow.automation_summary}</dd>
                </div>
            </dl>
            <p class={Muted}>{t.list_intake_affected_count(count)}</p>
            if let Some(days) = flow.post_delivery_open_window_days {
                <p class={Muted}>{t.list_open_post_delivery_window(days)}</p>
            }
            <p>
                <a class={Link} href={&on_marketplace("/help/buying/order-protection")}>{t.list_order_protection_terms_link()}</a>
            </p>
            <form class={Form} method="post" action={here.clone()} enctype="multipart/form-data">
                <fieldset class={Plain} disabled={!screen.said.writes()}>
                    <input type="hidden" name={f.intent} value="open">
                    <input type="hidden" name={f.account} value={&screen.account}>
                    <input type="hidden" name={f.attempt} value={&batch.attempt}>
                    <input type="hidden" name={f.operation} value={&batch.operation}>
                    <input type="hidden" name={f.uncertain} value={if batch.uncertain { "true" } else { "false" }}>
                    for reference in &batch.refs {
                        <input type="hidden" name={f.refs} value={reference}>
                    }
                    if !batch.refs.is_empty() {
                        <p>{t.list_photos_recovered()}</p>
                    } else if intake.photos {
                        <label class={Field}>
                            <span class={Label}>{t.attachments_add()}</span>
                            <span class={(Small, Muted)}>{t.attachments_description()}</span>
                            <input
                                type="file"
                                name={f.attachments}
                                accept={PICTURES}
                                multiple
                                capture="environment"
                                required
                            >
                        </label>
                    }
                    <div class={End}>
                        <a class={(Button, Secondary)} href={url::SupportList { ask: screen.ask.at(Step::Issue) }}>
                            {t.list_intake_back()}
                        </a>
                        <button type="submit" class={Button}>{t.list_intake_submit()}</button>
                    </div>
                </fieldset>
            </form>
            if batch.recovered() || screen.said.error.is_some() {
                <form method="post" action={here} enctype="multipart/form-data">
                    <input type="hidden" name={f.intent} value="new-batch">
                    <input type="hidden" name={f.account} value={&screen.account}>
                    <button type="submit" class={(Button, Secondary)}>{t.list_photos_new_batch()}</button>
                </form>
            }
        }
    }
}
