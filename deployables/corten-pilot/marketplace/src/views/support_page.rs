//! A Support Request's participant page (Platform Operations' `SupportRequestDetailPage` and
//! `ParticipantRoute`): the header with Back to support, what the last write did, Check status while
//! an attempt's outcome is not known, who acts next with the deadline's countdown, the overview,
//! the evidence prompts, the offer, the seller's response and Request support review, Cancel case,
//! the resolution, and the timeline.
//!
//! Every form posts to the page with the form's `SubmitKey` as its attempt; while an attempt's
//! outcome is not known the forms' fieldsets are off. A partial refund's amount shows when the
//! response's select picks it (`:has`; without `:has` it always shows) and is corten-ui's
//! `RequiredWhen`, so with its script the browser requires it for a partial refund and leaves it
//! out otherwise (todd-skelton/corten#269); the handler still checks it is there. One column on a phone; a key and its value side by side from 40rem.
use corten::{
    i18n::{Currency, DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use corten_ui::RequiredWhen;

use crate::{
    api::{SupportChecklistItem, SupportOffer, SupportRequest},
    app::url,
    support::{Draft, Moment, Role, SupportInput, SupportScreen, prompt_types, terminal},
    text::{Pilot, SupportMsg},
};

const NONE: [(&str, &str); 0] = [];

/// An amount the API sent, in USD as marketplace shows it (`formatMoney(amount, "USD")`).
fn usd(t: SupportMsg, amount: &str) -> String {
    match platform::money::decimal(amount) {
        Some(amount) => t.money(amount, Currency::new("USD")).to_string(),
        None => amount.to_owned(),
    }
}

/// A moment (`formatSupportDateTime`), or N/A.
fn when(t: SupportMsg, at: Option<&str>) -> String {
    match at {
        Some(at) => {
            parse_timestamp(at).map_or_else(|| at.to_owned(), |m| t.date_time(m, DateStyle::Medium, TimeStyle::Short).to_string())
        }
        None => t.not_applicable().to_owned(),
    }
}

/// A catalog entry by a code with dashes (`evidence_type.photo`), or the code itself.
fn coded(t: SupportMsg, group: &str, code: &str) -> String {
    t.by_key(&format!("page.{group}.{}", code.replace('-', "_")), &NONE).map_or_else(|| code.to_owned(), |m| m.to_string())
}

/// The case's status (`statusLabel`): anything unknown is Open.
fn status(t: SupportMsg, status: &str) -> &'static str {
    match status {
        "waiting-on-buyer" => t.page_status_waiting_on_buyer(),
        "waiting-on-seller" => t.page_status_waiting_on_seller(),
        "ready-for-support" => t.page_status_ready_for_support(),
        "resolved" => t.page_status_resolved(),
        "closed" => t.page_status_closed(),
        "cancelled" => t.page_status_cancelled(),
        _ => t.page_status_open(),
    }
}

/// Who acts next, in words (`actionTitle`).
fn next_title(t: SupportMsg, screen: &SupportScreen) -> String {
    let request = &screen.request;
    if terminal(&request.status) {
        return status(t, &request.status).to_owned();
    }
    match screen.next_actor {
        Some(next) if next == screen.viewer_role => t.page_next_you().to_owned(),
        Some(Role::Support) => t.page_next_support().to_owned(),
        Some(Role::Buyer) => t.page_next_waiting(t.page_party_buyer()).to_string(),
        _ => t.page_next_waiting(t.page_party_seller()).to_string(),
    }
}

/// What the last write did (`actionResultMessage`).
fn result(t: SupportMsg, action: Option<&str>) -> Option<&'static str> {
    Some(match action? {
        "evidence" => t.page_action_result_evidence(),
        "response" => t.page_action_result_response(),
        "offerAccepted" => t.page_action_result_offer_accepted(),
        "offerDeclined" => t.page_action_result_offer_declined(),
        "escalated" => t.page_action_result_escalated(),
        "cancelled" => t.page_action_result_cancelled(),
        _ => return None,
    })
}

/// A timeline entry's title (`timelineItems`).
fn moment_title(t: SupportMsg, kind: &str) -> &'static str {
    match kind {
        "opened" => t.page_timeline_opened(),
        "evidence" => t.page_timeline_evidence(),
        "response" => t.page_timeline_response(),
        "offer" => t.page_timeline_offer(),
        "offer-accepted" => t.page_timeline_offer_accepted(),
        "offer-declined" => t.page_timeline_offer_declined(),
        "escalated" => t.page_timeline_escalated(),
        "resolved" => t.page_timeline_resolved(),
        _ => t.page_timeline_closed(),
    }
}

/// The page.
#[component(css)]
pub fn SupportPage<'a>(t: SupportMsg, p: Pilot, screen: &'a SupportScreen) -> impl Render {
    let request = &screen.request;
    let over = terminal(&request.status);
    let acts = screen.next_actor == Some(screen.viewer_role);
    let tone = if over {
        "success"
    } else if acts {
        "warning"
    } else {
        "info"
    };
    let reference = if request.display_reference.is_empty() { &request.support_request_id } else { &request.display_reference };
    let said = &screen.said;
    let done = result(t, screen.action.as_deref());
    let actions = screen.offer_decision || !screen.responses.is_empty() || screen.review;
    html! {
        <header class={Header}>
            <div class={Tight}>
                <p class={Eyebrow}>{t.page_eyebrow()}</p>
                <h1 class={Title}>{reference}</h1>
                <p class={Muted}>{&request.flow.title}</p>
            </div>
            <a class={(Button, Secondary)} href={url::SupportList::default()}>{t.page_back()}</a>
        </header>
        <div class={Notices} role="status" aria-live="polite">
            if let Some(error) = &said.error {
                <div class={Banner} data-tone="danger" tabindex="-1" autofocus>
                    <p class={Strong}>{error}</p>
                </div>
            }
            if let Some(done) = done {
                <div class={Banner} data-tone="success">
                    <p class={Strong}>{done}</p>
                </div>
            }
            if let Some(recovery) = &said.recovery {
                <div class={Banner} data-tone="warning" data-support-recovery>
                    <h2 class={PartTitle} tabindex="-1" autofocus={said.error.is_none()}>{t.attempt_check_before_retry()}</h2>
                    <p>{t.attempt_ambiguous()}</p>
                    <form method="post" action={url::SupportCase { id: &request.support_request_id, place: Default::default() }}>
                        <input type="hidden" name={SupportInput::FIELDS.intent} value="check-status">
                        <input type="hidden" name={SupportInput::FIELDS.account} value={&screen.account}>
                        <input type="hidden" name={SupportInput::FIELDS.check_kind} value={&recovery.action_kind}>
                        <input type="hidden" name={SupportInput::FIELDS.check_attempt} value={&recovery.attempt}>
                        <input type="hidden" name={SupportInput::FIELDS.check_hash} value={&recovery.hash}>
                        <button type="submit" class={Button}>{t.attempt_check_status()}</button>
                    </form>
                </div>
            }
        </div>
        <section class={(Banner, Next)} data-tone={tone} aria-labelledby="support-next-title">
            <h2 id="support-next-title" class={PartTitle}>{next_title(t, screen)}</h2>
            <p>{t.page_current_status(status(t, &request.status))}</p>
            if !over {
                match &screen.countdown {
                    Some(c) => {
                        <p>
                            <span class={Badge} data-tone={if c.overdue { "danger" } else { "warning" }}>
                                if c.overdue {
                                    {t.deadline_overdue(c.value, c.unit)}
                                } else {
                                    {t.deadline_due(c.value, c.unit)}
                                }
                            </span>
                            " "
                            <span class={Muted}>{when(t, screen.deadline.as_deref())}</span>
                        </p>
                    }
                    None => { <p class={Muted}>{t.deadline_none()}</p> }
                }
            }
            <p>{&request.flow.automation_summary}</p>
        </section>
        <section class={Section} aria-labelledby="support-overview-title">
            <h2 id="support-overview-title" class={PartTitle}>{t.page_overview_title()}</h2>
            <dl class={Facts}>
                <div>
                    <dt>{t.page_overview_order()}</dt>
                    <dd>{&request.order_id}</dd>
                </div>
                <div>
                    <dt>{t.page_overview_status()}</dt>
                    <dd>
                        <span class={Badge} data-tone={if over { "success" } else { "warning" }}>
                            {status(t, &request.status)}
                        </span>
                    </dd>
                </div>
                <div>
                    <dt>{t.page_overview_opened()}</dt>
                    <dd>{when(t, Some(&request.opened_at))}</dd>
                </div>
            </dl>
        </section>
        if !screen.prompts.is_empty() {
            <section class={Section} aria-labelledby="support-prompts-title">
                <h2 id="support-prompts-title" class={PartTitle}>{t.page_prompts_title()}</h2>
                <p class={Muted}>{t.page_prompts_description()}</p>
                for item in &screen.prompts {
                    <EvidencePrompt t={t} screen={screen} item={item} />
                }
            </section>
        }
        if actions {
            <section class={Section} aria-labelledby="support-actions-title">
                <h2 id="support-actions-title" class={PartTitle}>{t.page_actions_title()}</h2>
                if let Some(offer) = request.pending_offer.as_ref().filter(|_| screen.offer_decision) {
                    <OfferDecision t={t} screen={screen} offer={offer} />
                }
                if !screen.responses.is_empty() {
                    <ResponseForm t={t} screen={screen} />
                }
                if screen.review {
                    <form method="post" action={url::SupportCase { id: &request.support_request_id, place: Default::default() }}>
                        <fieldset class={Plain} disabled={!screen.writes()}>
                            <input type="hidden" name={SupportInput::FIELDS.intent} value="escalate">
                            <input type="hidden" name={SupportInput::FIELDS.account} value={&screen.account}>
                            {SubmitKey::field(SupportInput::FIELDS.attempt)}
                            <button type="submit" class={(Button, Secondary)}>{t.page_review_submit()}</button>
                        </fieldset>
                    </form>
                }
            </section>
        }
        if screen.cancel {
            <section class={Section} aria-labelledby="support-cancel-title">
                <h2 id="support-cancel-title" class={PartTitle}>{t.page_cancel_section_title()}</h2>
                <CancelForm t={t} screen={screen} />
            </section>
        }
        if let Some(resolution) = &request.resolution {
            <section class={Section} aria-labelledby="support-resolution-title">
                <h2 id="support-resolution-title" class={PartTitle}>{t.page_resolution_title()}</h2>
                <dl class={(Facts, Card)}>
                    <div>
                        <dt>{t.page_resolution_outcome()}</dt>
                        <dd>{&resolution.resolution_type}</dd>
                    </div>
                    <div>
                        <dt>{t.page_resolution_summary()}</dt>
                        <dd>{&resolution.summary}</dd>
                    </div>
                    if let Some(refund) = &resolution.refund_amount {
                        <div>
                            <dt>{t.page_resolution_refund_amount()}</dt>
                            <dd>{usd(t, refund)}</dd>
                        </div>
                        <div>
                            <dt>{t.page_resolution_refund_progress()}</dt>
                            <dd>{refund_progress(t, request)}</dd>
                        </div>
                    }
                </dl>
            </section>
        }
        <section class={Section} aria-labelledby="support-timeline-title">
            <h2 id="support-timeline-title" class={PartTitle}>{t.page_timeline_title()}</h2>
            <p class={Muted}>{t.page_timeline_description()}</p>
            <ol class={Timeline} aria-label={t.page_timeline_aria_label()}>
                for moment in &screen.timeline {
                    <TimelineEntry t={t} request={request} moment={moment} />
                }
            </ol>
        </section>
    }
}

/// A refund's progress (`ResolutionSummary`): the remedy's case presentation while one runs.
fn refund_progress(t: SupportMsg, request: &SupportRequest) -> String {
    if request.remedy.as_ref().is_some_and(|r| !r.is_null()) {
        coded(t, "resolution.progress", &request.case_presentation)
    } else {
        t.page_resolution_refund_pending().to_owned()
    }
}

/// The draft a refusal left for `form`, if it is this one.
fn draft<'a>(screen: &'a SupportScreen, form: &str) -> Option<&'a Draft> {
    screen.said.draft.as_ref().filter(|d| d.form == form)
}

/// An evidence prompt (`EvidencePrompt`): the item, its evidence types and a summary. None when
/// support's note is all it takes.
#[component(css = SupportPage)]
fn EvidencePrompt<'a>(t: SupportMsg, screen: &'a SupportScreen, item: &'a SupportChecklistItem) -> impl Render {
    let f = SupportInput::FIELDS;
    let types: Vec<&str> = prompt_types(item).collect();
    let typed = draft(screen, &format!("evidence:{}", item.key));
    let picked = typed.map_or(types.first().copied().unwrap_or_default(), |d| d.evidence_type.as_str());
    let summary = typed.map_or("", |d| d.summary.as_str());
    html! {
        if !types.is_empty() {
            <form
                class={(Card, Form)}
                method="post"
                action={url::SupportCase { id: &screen.request.support_request_id, place: Default::default() }}
            >
                <fieldset class={Plain} disabled={!screen.writes()}>
                    <legend class={Strong}>{&item.label}</legend>
                    <p class={Muted}>{t.page_prompt_description()}</p>
                    <input type="hidden" name={f.intent} value="evidence">
                    <input type="hidden" name={f.account} value={&screen.account}>
                    <input type="hidden" name={f.item} value={&item.key}>
                    {SubmitKey::field(f.attempt)}
                    <label class={Field}>
                        <span class={Label}>{t.page_evidence_type()}</span>
                        <select name={f.evidence_type} required>
                            for kind in types.iter() {
                                <option value={*kind} selected={picked == *kind}>{coded(t, "evidence_type", kind)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.page_evidence_summary()}</span>
                        <textarea name={f.summary} rows="3" required maxlength="4000">{summary}</textarea>
                    </label>
                    <div class={End}>
                        <button type="submit" class={Button}>{t.page_evidence_submit()}</button>
                    </div>
                </fieldset>
            </form>
        }
    }
}

/// The seller's response (`ResponseForm`): its type, a partial refund's amount and a summary.
#[component(css = SupportPage)]
fn ResponseForm<'a>(t: SupportMsg, screen: &'a SupportScreen) -> impl Render {
    let f = SupportInput::FIELDS;
    let typed = draft(screen, "response");
    let picked = typed.map_or(screen.responses.first().map(String::as_str).unwrap_or_default(), |d| d.response_type.as_str());
    let (refund, summary) = typed.map_or(("", ""), |d| (d.refund_amount.as_str(), d.summary.as_str()));
    html! {
        <form
            class={(Card, Form)}
            method="post"
            action={url::SupportCase { id: &screen.request.support_request_id, place: Default::default() }}
        >
            <fieldset class={Plain} disabled={!screen.writes()}>
                <legend class={Strong}>{t.page_response_title()}</legend>
                <p class={Muted}>{t.page_response_description()}</p>
                <input type="hidden" name={f.intent} value="response">
                <input type="hidden" name={f.account} value={&screen.account}>
                {SubmitKey::field(f.attempt)}
                <label class={Field}>
                    <span class={Label}>{t.page_response_type()}</span>
                    <select name={f.response_type} required>
                        for kind in &screen.responses {
                            <option value={kind} selected={picked == kind}>{coded(t, "response_type", kind)}</option>
                        }
                    </select>
                </label>
                if screen.responses.iter().any(|r| r == "offer-partial-refund") {
                    <div class={Refund}>
                        <RequiredWhen control={f.response_type} values={&["offer-partial-refund"]}>
                            <label class={Field}>
                                <span class={Label}>{t.page_response_refund_amount()}</span>
                                <input
                                    type="text"
                                    name={f.refund_amount}
                                    value={refund}
                                    inputmode="decimal"
                                    placeholder="0.00"
                                    autocomplete="off"
                                >
                            </label>
                        </RequiredWhen>
                    </div>
                }
                <label class={Field}>
                    <span class={Label}>{t.page_response_summary()}</span>
                    <textarea name={f.summary} rows="3" required maxlength="4000">{summary}</textarea>
                </label>
                <div class={End}>
                    <button type="submit" class={Button}>{t.page_response_submit()}</button>
                </div>
            </fieldset>
        </form>
    }
}

/// The pending offer (`OfferDecision`): its outcome and amount, Accept offer and Decline offer.
#[component(css = SupportPage)]
fn OfferDecision<'a>(t: SupportMsg, screen: &'a SupportScreen, offer: &'a SupportOffer) -> impl Render {
    let f = SupportInput::FIELDS;
    let here = || url::SupportCase { id: &screen.request.support_request_id, place: Default::default() };
    html! {
        <div class={Card} data-support-offer={&offer.offer_id}>
            <p class={Strong}>{t.page_offer_title()}</p>
            <p class={Muted}>{&offer.summary}</p>
            <dl class={Facts}>
                <div>
                    <dt>{t.page_offer_outcome()}</dt>
                    <dd>{&offer.resolution_type}</dd>
                </div>
                <div>
                    <dt>{t.page_offer_amount()}</dt>
                    <dd>
                        match &offer.refund_amount {
                            Some(amount) => { {usd(t, amount)} }
                            None => { {t.page_not_applicable()} }
                        }
                    </dd>
                </div>
            </dl>
            <div class={Row}>
                <form method="post" action={here()}>
                    <fieldset class={Plain} disabled={!screen.writes()}>
                        <input type="hidden" name={f.intent} value="accept-offer">
                        <input type="hidden" name={f.account} value={&screen.account}>
                        <input type="hidden" name={f.offer_id} value={&offer.offer_id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="submit" class={Button}>{t.page_offer_accept()}</button>
                    </fieldset>
                </form>
                <form method="post" action={here()}>
                    <fieldset class={Plain} disabled={!screen.writes()}>
                        <input type="hidden" name={f.intent} value="decline-offer">
                        <input type="hidden" name={f.account} value={&screen.account}>
                        <input type="hidden" name={f.offer_id} value={&offer.offer_id}>
                        {SubmitKey::field(f.attempt)}
                        <button type="submit" class={(Button, Secondary)}>{t.page_offer_decline()}</button>
                    </fieldset>
                </form>
            </div>
        </div>
    }
}

/// Cancel case (`CancelCaseForm`): the reason.
#[component(css = SupportPage)]
fn CancelForm<'a>(t: SupportMsg, screen: &'a SupportScreen) -> impl Render {
    let f = SupportInput::FIELDS;
    let reason = draft(screen, "cancel").map_or("", |d| d.reason.as_str());
    html! {
        <form
            class={(Card, Form)}
            method="post"
            action={url::SupportCase { id: &screen.request.support_request_id, place: Default::default() }}
        >
            <fieldset class={Plain} disabled={!screen.writes()}>
                <legend class={Strong}>{t.page_cancel_title()}</legend>
                <input type="hidden" name={f.intent} value="cancel">
                <input type="hidden" name={f.account} value={&screen.account}>
                {SubmitKey::field(f.attempt)}
                <label class={Field}>
                    <span class={Label}>{t.page_cancel_reason()}</span>
                    <textarea name={f.reason} rows="2" required maxlength="4000">{reason}</textarea>
                </label>
                <div class={End}>
                    <button type="submit" class={(Button, Danger)}>{t.page_cancel_submit()}</button>
                </div>
            </fieldset>
        </form>
    }
}

/// A timeline entry: what happened, when, and what was said.
#[component(css = SupportPage)]
fn TimelineEntry<'a>(t: SupportMsg, request: &'a SupportRequest, moment: &'a Moment) -> impl Render {
    let description = match moment.kind {
        "opened" => Some(t.page_timeline_opened_by(&request.opened_by_role).to_string()),
        _ => moment.description.clone(),
    };
    html! {
        <li class={Entry} data-support-moment={&moment.id}>
            <p class={Strong}>{moment_title(t, moment.kind)}</p>
            <p class={Muted}><time datetime={&moment.at}>{when(t, Some(&moment.at))}</time></p>
            if let Some(description) = &description {
                <p>{description}</p>
            }
        </li>
    }
}
