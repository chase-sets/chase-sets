//! The moderation queue (`ReportedContentAdminListPage`): its three counts, the status and target
//! filters, and the queue as a table that scrolls on its own on a phone; and a target's page
//! (`ReportedContentAdminDetailPage`): its queue facts and moderation form beside its report
//! history from 64rem, stacked below that. The form's buttons each send their action, as
//! admin-web's do, so it works without a script.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    reported::{ActionForm, ItemScreen, QueueItem, QueueScreen, STATUSES, TARGET_TYPES, actions, url},
    text::{Ops, Pilot},
};

/// A status's words, else the status as it is (admin-web's `statusLabel`).
pub fn status(t: Ops, value: &str) -> String {
    match value {
        "needs-review" => t.reported_status_needs_review(),
        "auto-unlisted" => t.reported_status_auto_unlisted(),
        "dismissed" => t.reported_status_dismissed(),
        "seller-contact-requested" => t.reported_status_seller_contact_requested(),
        "manually-unlisted" => t.reported_status_manually_unlisted(),
        "suspension-escalated" => t.reported_status_suspension_escalated(),
        "review-withdrawn" => t.reported_status_review_withdrawn(),
        "review-feedback-redacted" => t.reported_status_review_feedback_redacted(),
        "review-reply-withdrawn" => t.reported_status_review_reply_withdrawn(),
        "account-contact-requested" => t.reported_status_account_contact_requested(),
        "profile-display-name-redacted" => t.reported_status_profile_display_name_redacted(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A target type's words, else the type as it is.
pub fn target_type(t: Ops, value: &str) -> String {
    match value {
        "listing" => t.reported_target_listing(),
        "review" => t.reported_target_review(),
        "account-profile" => t.reported_target_account_profile(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// An action's button and the words the last action is told with (`actionPresentation`), and
/// whether it is a danger.
fn action(t: Ops, value: &str) -> (&'static str, &'static str, bool) {
    match value {
        "dismiss" => (t.reported_action_dismiss(), t.reported_action_label_dismiss(), false),
        "contact-seller" => (t.reported_action_contact_seller(), t.reported_action_label_contact_seller(), false),
        "contact-account" => (t.reported_action_contact_account(), t.reported_action_label_contact_account(), false),
        "unlist" => (t.reported_action_unlist(), t.reported_action_label_unlist(), true),
        "withdraw-review" => (t.reported_action_withdraw_review(), t.reported_action_label_withdraw_review(), true),
        "redact-review-feedback" => {
            (t.reported_action_redact_review_feedback(), t.reported_action_label_redact_review_feedback(), true)
        }
        "withdraw-review-reply" => {
            (t.reported_action_withdraw_review_reply(), t.reported_action_label_withdraw_review_reply(), true)
        }
        "redact-profile-display-name" => {
            (t.reported_action_redact_profile_display_name(), t.reported_action_label_redact_profile_display_name(), true)
        }
        _ => (t.reported_action_escalate(), t.reported_action_label_escalate(), true),
    }
}

fn when(t: Ops, at: Option<&str>) -> String {
    at.and_then(parse_timestamp)
        .map_or_else(|| t.reported_not_set().to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

fn reasons(item: &QueueItem) -> String {
    item.reasons.iter().map(|r| format!("{} ({})", r.reason, r.count)).collect::<Vec<_>>().join(", ")
}

/// A status's pill (`statusTone`).
#[component(css = ReportedPage)]
fn StatusPill<'a>(t: Ops, value: &'a str) -> impl Render {
    let words = status(t, value);
    html! {
        match value {
            "dismissed" => <span class={(Pill, Neutral)}>{&words}</span>,
            "auto-unlisted" => <span class={(Pill, Warning)}>{&words}</span>,
            "manually-unlisted" | "suspension-escalated" | "review-withdrawn" | "review-feedback-redacted"
            | "review-reply-withdrawn" | "profile-display-name-redacted" => <span class={(Pill, Danger)}>{&words}</span>,
            _ => <span class={(Pill, Accent)}>{&words}</span>,
        }
    }
}

#[component(css)]
pub fn ReportedPage<'a>(t: Ops, screen: &'a QueueScreen) -> impl Render {
    let f = url::Filters::FIELDS;
    let status_now = screen.status.as_deref().unwrap_or("all");
    let target_now = screen.target_type.as_deref().unwrap_or("all");
    let m = &screen.metrics;
    html! {
        <crate::views::PageHeader
            eyebrow={t.reported_eyebrow()}
            title={t.reported_title()}
            description={t.reported_description()}
        />
        <dl class={Stats}>
            <div class={Stat}>
                <dt>{t.reported_total()}</dt>
                <dd>{m.total_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.reported_needs_review()}</dt>
                <dd>{m.needs_review_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.reported_auto_unlisted()}</dt>
                <dd>{m.auto_unlisted_count}</dd>
            </div>
        </dl>
        <section class={Part}>
            <h2 class={Heading}>{t.reported_filters()}</h2>
            <form class={Filters} method="get" action={url::Reported::default()}>
                <label class={Field}>
                    <span>{t.reported_status()}</span>
                    <select name={f.status}>
                        <option value="all" selected={status_now == "all"}>{t.reported_all_statuses()}</option>
                        for value in STATUSES {
                            <option value={value} selected={value == status_now}>{status(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.reported_target_type()}</span>
                    <select name={f.target_type}>
                        <option value="all" selected={target_now == "all"}>{t.reported_all_targets()}</option>
                        for value in TARGET_TYPES {
                            <option value={value} selected={value == target_now}>{target_type(t, value)}</option>
                        }
                    </select>
                </label>
                <button type="submit" class={Button}>{t.reported_apply_filters()}</button>
            </form>
        </section>
        <section class={Part}>
            <h2 class={Heading}>{t.reported_queue()}</h2>
            if screen.queue.items.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.reported_empty_title()}</p>
                    <p class={Muted}>{t.reported_empty_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table} aria-label={t.reported_queue()}>
                        <thead>
                            <tr>
                                <th scope="col">{t.reported_status()}</th>
                                <th scope="col">{t.reported_target()}</th>
                                <th scope="col">{t.reported_reports()}</th>
                                <th scope="col">{t.reported_reasons()}</th>
                                <th scope="col">{t.reported_last_reported()}</th>
                                <th scope="col">{t.reported_action()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for item in &screen.queue.items {
                                <tr>
                                    <td><StatusPill t={t} value={&item.status} /></td>
                                    <td class={Words}>{format!("{} {}", target_type(t, &item.target_type), item.target_id)}</td>
                                    <td>{item.report_count}</td>
                                    <td class={Words}>{reasons(item)}</td>
                                    <td>{when(t, item.last_reported_at.as_deref())}</td>
                                    <td>
                                        <a
                                            class={Open}
                                            href={url::Item { target_type: &item.target_type, target_id: &item.target_id, after_write: None, recorded: None }}
                                        >
                                            {t.reported_open()}
                                        </a>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
            <p class={Muted}>{t.reported_count_summary(screen.queue.count, screen.queue.total)}</p>
        </section>
    }
}

/// A fact of the target.
#[component(css = ReportedPage)]
fn Fact<'a>(label: &'a str, value: &'a str) -> impl Render {
    html! {
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    }
}

#[component(css = ReportedPage)]
pub fn ItemPage<'a>(t: Ops, p: Pilot, screen: &'a ItemScreen) -> impl Render {
    let item = &screen.item;
    let kind = target_type(t, &item.target_type);
    let f = ActionForm::FIELDS;
    let here = url::Item { target_type: &item.target_type, target_id: &item.target_id, after_write: None, recorded: None };
    html! {
        let title = t.reported_detail_title(&kind, &item.target_id).to_string();
        let owner = item.target_owner_account_id.clone().unwrap_or_else(|| t.reported_not_set().to_owned());
        let last = item.last_action.as_deref().map(|a| t.reported_last_action(action(t, a).1, &when(t, item.last_action_at.as_deref())).to_string());
        <crate::views::PageHeader eyebrow={t.reported_eyebrow()} title={&title} description={t.reported_detail_description()} />
        <div class={Links}>
            <a class={(Button, Secondary)} href={url::Reported::default()}>{t.reported_back()}</a>
            if let Some(href) = &screen.marketplace_href {
                <a class={Button} href={href} target="_blank" rel="noreferrer">{t.reported_open_marketplace_target()}</a>
            }
        </div>
        if let Some(refusal) = &screen.refusal {
            <p class={Alert} role="alert">{refusal}</p>
        }
        if screen.catching_up {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        <div class={Panels}>
            <section class={Panel}>
                <h2 class={Heading}>{t.reported_queue_item()}</h2>
                <dl class={Facts}>
                    <Fact label={t.reported_status()} value={&status(t, &item.status)} />
                    <Fact label={t.reported_target_type()} value={&kind} />
                    <Fact label={t.reported_target_id()} value={&item.target_id} />
                    <Fact label={t.reported_owner_account()} value={&owner} />
                    <Fact label={t.reported_reports()} value={&item.report_count.to_string()} />
                    <Fact label={t.reported_distinct_reporters()} value={&item.distinct_reporter_count.to_string()} />
                    <Fact label={t.reported_first_reported()} value={&when(t, item.first_reported_at.as_deref())} />
                    <Fact label={t.reported_last_reported()} value={&when(t, item.last_reported_at.as_deref())} />
                    <Fact label={t.reported_auto_unlisted_at()} value={&when(t, item.auto_unlisted_at.as_deref())} />
                </dl>
                <form class={Moderate} method="post" action={&here}>
                    <label class={Field}>
                        <span>{t.reported_action_note()}</span>
                        <textarea name={f.note} rows="3" maxlength="1000"></textarea>
                    </label>
                    <div class={Actions}>
                        for value in actions(&item.target_type) {
                            let (button, _, danger) = action(t, value);
                            if danger {
                                <button type="submit" class={(Button, DangerButton)} name={f.action} value={value.as_str()}>
                                    {button}
                                </button>
                            } else {
                                <button type="submit" class={(Button, Secondary)} name={f.action} value={value.as_str()}>
                                    {button}
                                </button>
                            }
                        }
                    </div>
                    <p class={Muted}>{t.reported_review_actions_require_note()}</p>
                </form>
                if let Some(last) = &last {
                    <p class={Muted}>{last}</p>
                }
            </section>
            <section class={Panel}>
                <h2 class={Heading}>{t.reported_report_history()}</h2>
                <ul class={Reports}>
                    for report in &item.reports {
                        let who = if report.reporter_kind == "account" {
                            t.reported_reporter_kind_account()
                        } else {
                            t.reported_reporter_kind_visitor()
                        };
                        <li class={ReportCard}>
                            <p class={Strong}>{&report.reason}</p>
                            <p class={Words}>{report.details.as_deref().unwrap_or(t.reported_no_details())}</p>
                            <p class={Muted}>{t.reported_report_attribution(who, &when(t, Some(&report.submitted_at)))}</p>
                        </li>
                    }
                </ul>
            </section>
        </div>
    }
}
