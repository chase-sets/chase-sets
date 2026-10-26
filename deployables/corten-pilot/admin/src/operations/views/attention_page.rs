//! admin-web's `OperationsAttentionQueuePage`: the header, the stream's status, the four counts,
//! the sources the API could not read, and a row per item with its severity, its words, its
//! source, how long it has waited, its deadline and Open, which goes to the admin-web page that
//! resolves it. On a phone the counts are two by two and each row is a card, each cell under its
//! heading (admin-web's `DataTable` does the same).
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::ids;
use crate::{
    operations::{
        api::{Item, Queue, Severity, SourceHealth},
        open_href, url,
    },
    text::{Ops, snake_case},
    views::{LiveStatus, LiveWords, PageHeader},
};

/// The queue's words for its stream's status (admin-web's `ConnectionStatusIndicator` labels).
fn live_words(t: Ops) -> LiveWords {
    LiveWords {
        live: t.attention_connection_live(),
        connecting: t.attention_connection_connecting(),
        stale_since: t.js().attention_connection_stale_since(),
        stale: t.attention_connection_stale_since("").to_string(),
        stale_description: t.attention_connection_stale_description(),
        // admin-web's indicator has no button: its words say to reload.
        reload: None,
        date: t.js().date_time(DateStyle::Medium, TimeStyle::Short),
    }
}

#[component(css)]
pub fn AttentionPage<'a>(t: Ops, queue: &'a Queue) -> impl Render {
    let words = live_words(t);
    let live = url::AttentionLive.href();
    let page = url::Attention.href();
    html! {
        <PageHeader eyebrow={t.attention_eyebrow()} title={t.attention_title()} description={t.attention_description()} />
        <LiveStatus words={&words} id={ids::LIVE} src={&live} reload={&page} kept={&[]}>
            {queue_body(t, queue)}
        </LiveStatus>
    }
}

/// The counts, the sources the API could not read, and the items: the part each change draws again.
pub fn queue_body<'a>(t: Ops, queue: &'a Queue) -> impl Render + 'a {
    html! {
        <div id={ids::QUEUE}>
            <QueueParts t={t} queue={queue} />
        </div>
    }
}

/// A source's name, or its id for a source the page does not know.
fn source(t: Ops, id: &str) -> &str {
    match id {
        "projection-poison-event" => t.attention_source_projection_poison_event(),
        "projection-blocked-stream" => t.attention_source_projection_blocked_stream(),
        "wake-stalled-job" => t.attention_source_wake_stalled_job(),
        "support-request-deadline" => t.attention_source_support_request_deadline(),
        "platform-feedback-unreviewed" => t.attention_source_platform_feedback_unreviewed(),
        other => other,
    }
}

/// A time the API sent, as admin-web's `formatDateTime` writes it (`May 4, 2026, 3:00 PM UTC`), or
/// the text itself when it is not a time.
fn when(t: Ops, at: &str) -> String {
    match parse_timestamp(at) {
        Some(at) => t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
        None => at.to_owned(),
    }
}

/// An item's words: its code's message with the API's arguments (`t(\`${routeKey}.summary.${code}\`, params)`),
/// or admin-web's key when the catalog has no such message or an argument is missing.
fn summary(t: Ops, item: &Item) -> String {
    let key = format!("attention.summary.{}", snake_case(&item.summary.code));
    match t.by_key(&key, &item.summary.params) {
        Some(message) => message.to_string(),
        None => format!("platformOperations.operationsAttention.summary.{}", item.summary.code),
    }
}

#[component(css = AttentionPage)]
fn QueueParts<'a>(t: Ops, queue: &'a Queue) -> impl Render {
    let counts = &queue.rollup;
    let stats = [
        (t.attention_stat_total(), counts.total),
        (t.attention_stat_critical(), counts.by_severity.critical),
        (t.attention_stat_warning(), counts.by_severity.warning),
        (t.attention_stat_info(), counts.by_severity.info),
    ];
    let unavailable: Vec<&SourceHealth> = queue.sources.iter().filter(|s| s.unavailable()).collect();
    let head = [
        t.attention_column_severity(),
        t.attention_column_item(),
        t.attention_column_source(),
        t.attention_column_waited(),
        t.attention_column_due(),
        t.attention_column_action(),
    ];
    html! {
        <dl class={Stats}>
            for (label, value) in &stats {
                <div class={Stat}>
                    <dt>{*label}</dt>
                    <dd>{*value}</dd>
                </div>
            }
        </dl>
        if !unavailable.is_empty() {
            <section class={Part} aria-labelledby="attention-degraded-title">
                <h2 class={Heading} id="attention-degraded-title">{t.attention_degraded_title()}</h2>
                <div class={Degraded} role="status">
                    <p class={Muted}>{t.attention_degraded_description()}</p>
                    for health in &unavailable {
                        <p class={Unavailable}>
                            {t.attention_source_unavailable(source(t, &health.id), health.reason.as_deref().unwrap_or(""))}
                        </p>
                    }
                </div>
            </section>
        }
        <section class={Part} aria-labelledby="attention-queue-title">
            <h2 class={Heading} id="attention-queue-title">{t.attention_queue_title()}</h2>
            if queue.items.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.attention_empty_title()}</p>
                    <p class={Muted}>{t.attention_empty_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                for heading in &head {
                                    <th scope="col">{*heading}</th>
                                }
                            </tr>
                        </thead>
                        <tbody>
                            for item in &queue.items {
                                <Row t={t} item={item} head={&head} />
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
    }
}

#[component(css = AttentionPage)]
fn Row<'a>(t: Ops, item: &'a Item, head: &'a [&'static str; 6]) -> impl Render {
    // admin-web's `severityTone`: critical is danger, warning a warning, info neutral.
    let (label, tone) = match item.severity {
        Severity::Critical => (t.attention_severity_critical(), Danger),
        Severity::Warning => (t.attention_severity_warning(), Warning),
        Severity::Info => (t.attention_severity_info(), Neutral),
    };
    let due = item.due_at.as_deref().map_or_else(|| t.attention_not_set().to_owned(), |at| when(t, at));
    let open = open_href(&item.deep_link);
    html! {
        <tr>
            <td data-label={head[0]}><span class={(Pill, tone)}>{label}</span></td>
            <td data-label={head[1]} class={Words}>{summary(t, item)}</td>
            <td data-label={head[2]}>{source(t, &item.source)}</td>
            <td data-label={head[3]}>{when(t, &item.observed_at)}</td>
            <td data-label={head[4]}>{due}</td>
            <td data-label={head[5]}>
                if let Some(href) = &open {
                    <a class={Open} href={href}>{t.attention_open()}</a>
                }
            </td>
        </tr>
    }
}
