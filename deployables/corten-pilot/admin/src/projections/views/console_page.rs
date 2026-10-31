//! admin-web's `ProjectionOperationsPage`: the header and its actions, the console's health (its status,
//! the API's attention items and eight counts), the filters, the repair queue and the recent
//! operations, and the selected record's sheet. The health, the queue and the operations are each
//! their own element, so the live stream draws them again without touching the filters someone is
//! typing in. On a phone the counts are two by two and each table row is a card, each cell under
//! its heading (admin-web's `DataTable` does the same).
use corten::{
    i18n::{DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{detail_sheet, ids};
use crate::{
    auth::Viewer,
    projections::{
        OPERATE, Screen,
        api::{AttentionItem, Count, Operation, RepairItem, Snapshot, Tone},
        url,
    },
    text::Ops,
    views::{LiveStatus, LiveWords, PageHeader, admin_web},
};

/// The states the State filter offers, in admin-web's order.
const STATES: [&str; 11] = [
    "failed",
    "error",
    "degraded",
    "cancel_requested",
    "blocked",
    "poison",
    "behind",
    "queued",
    "running",
    "caught-up",
    "succeeded",
];

/// A pill's color: the API's tone, or a state's (admin-web's `stateTone`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hue {
    Danger,
    Warning,
    Accent,
    Success,
    Neutral,
}

impl From<Tone> for Hue {
    fn from(tone: Tone) -> Self {
        match tone {
            Tone::Danger => Hue::Danger,
            Tone::Warning => Hue::Warning,
            Tone::Accent => Hue::Accent,
        }
    }
}

/// A state's color, as admin-web's `stateTone` gives it.
pub fn state_hue(state: &str) -> Hue {
    match state {
        "failed" | "error" | "poison" => Hue::Danger,
        "degraded" | "blocked" | "cancel_requested" | "stale" | "expired" | "behind" => Hue::Warning,
        "running" | "retrying" | "queued" => Hue::Accent,
        "caught-up" | "succeeded" | "active" | "ok" => Hue::Success,
        _ => Hue::Neutral,
    }
}

/// A state's order, most urgent first (admin-web's `stateSeverity`).
pub(crate) fn severity(state: &str) -> u8 {
    match state {
        "failed" | "error" => 0,
        "degraded" | "blocked" | "cancel_requested" => 1,
        "behind" | "stale" | "expired" | "queued" => 2,
        "running" => 3,
        "caught-up" | "succeeded" | "active" | "ok" => 4,
        _ => 5,
    }
}

/// A count as the page writes it (admin-web's `formatDecimalCount`: grouped), or the text itself.
pub fn count(t: Ops, value: &Count) -> String {
    match Decimal::parse(value.0.trim()) {
        Some(n) => t.number(n).to_string(),
        None => value.0.clone(),
    }
}

/// A time the API sent, as admin-web's `formatDateTime` writes it, or Not recorded for none.
pub fn when(t: Ops, at: Option<&str>) -> String {
    match at.filter(|at| !at.is_empty()) {
        Some(at) => match parse_timestamp(at) {
            Some(time) => t.date_time(time, DateStyle::Medium, TimeStyle::Short).to_string(),
            None => at.to_owned(),
        },
        None => t.projections_not_recorded().to_owned(),
    }
}

/// The stream's status words (admin-web's `ConnectionStatusIndicator` labels).
fn live_words(t: Ops) -> LiveWords {
    LiveWords {
        live: t.projections_connection_live(),
        connecting: t.projections_connection_connecting(),
        stale_since: t.js().projections_connection_stale_since(),
        stale: t.projections_connection_stale_since("").to_string(),
        stale_description: t.projections_connection_stale_description(),
        reload: None,
        date: t.js().date_time(DateStyle::Medium, TimeStyle::Short),
    }
}

#[component(css)]
pub fn ConsolePage<'a>(t: Ops, screen: &'a Screen, filters: &'a url::Filters, viewer: &'a Viewer) -> impl Render {
    let console = &screen.console;
    let page = url::Projections { filters: filters.clone() }.href();
    let live = url::ProjectionsLive { filters: filters.clone() }.href();
    let refresh = url::Refresh { filters: filters.clone() }.href();
    let reference = url::Reference::default().href();
    let catalog = viewer.can(crate::catalog::VIEW).then(|| crate::catalog::url::Dimensions::default().href());
    let identity = viewer.can("accounts.view").then(|| admin_web("/access/accounts").map(|u| u.to_string())).flatten();
    let followed = console.operations.iter().any(Operation::live);
    let words = live_words(t);
    html! {
        <PageHeader eyebrow={t.projections_eyebrow()} title={t.projections_title()} description={t.projections_description()} />
        <div class={Actions}>
            if viewer.can(OPERATE) {
                <form method="post" action={&refresh}>
                    <button type="submit" class={Button}>{t.projections_refresh()}</button>
                </form>
            }
            <a class={(Button, Secondary)} href={&reference}>{t.projections_reference()}</a>
            if let Some(href) = &catalog {
                <a class={(Button, Secondary)} href={href}>{t.projections_catalog()}</a>
            }
            if let Some(href) = &identity {
                <a class={(Button, Secondary)} href={href}>{t.projections_identity()}</a>
            }
        </div>
        if followed {
            <LiveStatus words={&words} id={ids::LIVE} src={&live} reload={&page} kept={&[]}>{""}</LiveStatus>
        }
        {health(t, screen)}
        <FiltersForm t={t} console={console} filters={filters} via={url::Via::Console} />
        {repair_queue(t, console, filters)}
        {operations(t, console, filters)}
        {detail_sheet(t, console, filters, viewer, url::Via::Console)}
    }
}

/// The parts the live stream draws again: the health, the repair queue and the operations.
pub fn live_parts<'a>(t: Ops, screen: &'a Screen, filters: &'a url::Filters) -> impl Render + 'a {
    html! {
        {health(t, screen)}
        {repair_queue(t, &screen.console, filters)}
        {operations(t, &screen.console, filters)}
    }
}

/// The console's status: admin-web's `resolveConsoleStatus`, from the API's and the wake read's
/// attention items, the stale workers and what is running.
fn status(t: Ops, console: &Snapshot, attention: &[&AttentionItem]) -> (&'static str, &'static str, Hue) {
    let running =
        console.summary.running_groups > 0 || console.operation_summary.as_ref().is_some_and(|s| s.running_count.is_positive());
    if attention.iter().any(|item| item.tone == Tone::Danger) {
        (t.projections_needs_attention(), t.projections_needs_attention_description(), Hue::Danger)
    } else if console.stale_worker_count > 0 {
        (t.projections_stale(), t.projections_stale_description(), Hue::Warning)
    } else if running {
        (t.projections_running(), t.projections_running_description(), Hue::Accent)
    } else if !attention.is_empty() {
        (t.projections_review(), t.projections_review_description(), Hue::Warning)
    } else {
        (t.projections_healthy(), t.projections_healthy_description(), Hue::Success)
    }
}

fn health<'a>(t: Ops, screen: &'a Screen) -> impl Render + 'a {
    html! { <Health t={t} screen={screen} /> }
}

#[component(css = ConsolePage)]
fn Health<'a>(t: Ops, screen: &'a Screen) -> impl Render {
    let console = &screen.console;
    let attention: Vec<&AttentionItem> = console.attention_items.iter().chain(screen.wake.iter().flatten()).collect();
    let (label, detail, hue) = status(t, console, &attention);
    let zero = Count("0".into());
    let ops = console.operation_summary.as_ref();
    let stats = [
        (t.projections_attention(), t.number(attention.len() as u64).to_string()),
        (t.projections_source_lag(), count(t, &console.summary.outstanding_event_count)),
        (
            t.projections_blocked_streams(),
            t.number(console.projection_groups.iter().map(|g| u64::from(g.blocked_stream_count)).sum::<u64>()).to_string(),
        ),
        (
            t.projections_poison_events(),
            t.number(console.projection_groups.iter().map(|g| u64::from(g.poison_event_count)).sum::<u64>()).to_string(),
        ),
        (t.projections_failed_operations(), count(t, ops.map_or(&zero, |s| &s.failed_count))),
        (t.projections_queued_operations(), count(t, ops.map_or(&zero, |s| &s.queued_count))),
        (t.projections_running_operations(), count(t, ops.map_or(&zero, |s| &s.running_count))),
        (
            t.projections_active_workers(),
            t.projections_active_worker_summary(console.active_worker_count, console.stale_worker_count).to_string(),
        ),
    ];
    html! {
        <section id={ids::HEALTH} class={Health} aria-label={t.projections_overview()}>
            <div class={Badges}>
                <Pill hue={hue} label={label} />
                <Pill hue={Hue::Neutral} label={&t.projections_source(&console.projection_status_source).to_string()} />
            </div>
            <p class={Muted}>{detail}</p>
            if !attention.is_empty() {
                <ul class={Signals}>
                    for item in &attention {
                        <li title={&item.detail}><Pill hue={Hue::from(item.tone)} label={&item.label} /></li>
                    }
                </ul>
            }
            <dl class={Stats}>
                for (name, value) in &stats {
                    <div class={Stat}>
                        <dt>{*name}</dt>
                        <dd>{value}</dd>
                    </div>
                }
            </dl>
            <p class={Muted}>
                {t.projections_expired_heartbeat_history(console.worker_heartbeat_history.expired_within_diagnostic_window_count)}
            </p>
        </section>
    }
}

/// A part of a page: its heading (`id` names it), what it holds, and its content.
#[component(css = ConsolePage)]
pub(crate) fn Part<'a, C: Render>(id: &'a str, title: &'a str, description: Option<&'a str>, children: C) -> impl Render {
    html! {
        <section class={Part} aria-labelledby={id}>
            <h2 class={Heading} id={id}>{title}</h2>
            if let Some(description) = description {
                <p class={Muted}>{description}</p>
            }
            {children}
        </section>
    }
}

/// A table whose rows are cards on a phone, each cell beside its heading (`data-label`).
#[component(css = ConsolePage)]
pub(crate) fn Rows<'a, C: Render>(label: &'a str, head: &'a [&'a str], children: C) -> impl Render {
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

/// A record's name and, under it, what tells it apart.
#[component(css = ConsolePage)]
pub(crate) fn Named<'a>(name: &'a str, detail: &'a str) -> impl Render {
    html! {
        <span class={Strong}>{name}</span>
        <span class={Small}>{detail}</span>
    }
}

/// Nothing to list: what is missing and why.
#[component(css = ConsolePage)]
pub(crate) fn Nothing<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Empty}>
            <p class={EmptyTitle}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// A link drawn as a button: `compact` in a table row.
#[component(css = ConsolePage)]
pub(crate) fn LinkButton<'a>(href: &'a str, label: &'a str, compact: bool) -> impl Render {
    html! {
        if compact {
            <a class={(Button, Secondary, Compact)} href={href}>{label}</a>
        } else {
            <a class={(Button, Secondary)} href={href}>{label}</a>
        }
    }
}

/// A state or a tone, as a pill.
#[component(css = ConsolePage)]
pub fn Pill<'a>(hue: Hue, label: &'a str) -> impl Render {
    let tone = match hue {
        Hue::Danger => Danger,
        Hue::Warning => Warning,
        Hue::Accent => Accent,
        Hue::Success => Success,
        Hue::Neutral => Neutral,
    };
    html! { <span class={(Pill, tone)}>{label}</span> }
}

/// The filters: a search and three choices, sent as the page's address (a `GET` form, so it
/// works without JavaScript), and the filters applied, each a chip, with Clear filters.
#[component(css = ConsolePage)]
pub(crate) fn FiltersForm<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters, via: url::Via) -> impl Render {
    let mut contexts: Vec<&str> = console.projection_groups.iter().map(|g| g.target_context_name.as_str()).collect();
    contexts.sort_unstable();
    contexts.dedup();
    let mut projections: Vec<&str> = console.projection_groups.iter().map(|g| g.projection_name.as_str()).collect();
    projections.sort_unstable();
    projections.dedup();
    let f = url::Filters::FIELDS;
    let clear = url::Filters::default().on(via);
    let applied: Vec<String> = [
        (!filters.search().is_empty()).then(|| t.projections_filter_search(filters.search()).to_string()),
        (!filters.state().is_empty()).then(|| t.projections_filter_state(filters.state()).to_string()),
        (!filters.context().is_empty()).then(|| t.projections_filter_context(filters.context()).to_string()),
        (!filters.projection().is_empty()).then(|| t.projections_filter_projection(filters.projection()).to_string()),
    ]
    .into_iter()
    .flatten()
    .collect();
    html! {
        <form class={Filters} method="get" action={&clear} aria-label={t.projections_filters()}>
            <label class={Field}>
                <span class={Label}>{t.projections_search()}</span>
                <input type="search" name={f.search} value={filters.search()} placeholder={t.projections_search_placeholder()}>
            </label>
            <label class={Field}>
                <span class={Label}>{t.projections_state()}</span>
                <select name={f.state}>
                    <option value="" selected={filters.state().is_empty()}>{t.projections_all_states()}</option>
                    for state in STATES {
                        <option value={state} selected={filters.state() == state}>{state}</option>
                    }
                </select>
            </label>
            <label class={Field}>
                <span class={Label}>{t.projections_context()}</span>
                <select name={f.context_name}>
                    <option value="" selected={filters.context().is_empty()}>{t.projections_all_contexts()}</option>
                    for context in &contexts {
                        <option value={*context} selected={filters.context() == *context}>{*context}</option>
                    }
                </select>
            </label>
            <label class={Field}>
                <span class={Label}>{t.projections_projection()}</span>
                <select name={f.projection_name}>
                    <option value="" selected={filters.projection().is_empty()}>{t.projections_all_projections()}</option>
                    for projection in &projections {
                        <option value={*projection} selected={filters.projection() == *projection}>{*projection}</option>
                    }
                </select>
            </label>
            <div class={FilterActions}>
                <button type="submit" class={Button}>{t.projections_apply_filters()}</button>
                <a class={(Button, Secondary)} href={&clear}>{t.projections_clear_filters()}</a>
            </div>
        </form>
        if !applied.is_empty() {
            <ul class={Chips} aria-label={t.projections_filters()}>
                for chip in &applied {
                    <li class={Chip}>{chip}</li>
                }
            </ul>
        }
    }
}

fn repair_queue<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters) -> impl Render + 'a {
    let rows: Vec<&RepairItem> = console
        .repair_queue
        .iter()
        .filter(|item| {
            let text = [
                Some(item.label.as_str()),
                Some(item.detail.as_str()),
                item.projection_key.as_deref(),
                item.stream_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            filters.matches(&text, &item.state, item.context_name.as_deref(), item.projection_name.as_deref())
        })
        .collect();
    html! { <RepairQueue t={t} rows={rows} filters={filters} /> }
}

/// The API's repair queue, in its order, as far as the filters keep it.
#[component(css = ConsolePage)]
fn RepairQueue<'a>(t: Ops, rows: Vec<&'a RepairItem>, filters: &'a url::Filters) -> impl Render {
    let head = [t.projections_state(), t.projections_signal(), t.projections_target(), t.projections_actions()];
    html! {
        <section id={ids::REPAIR} class={Part} aria-labelledby="projections-repair-title">
            <h2 class={Heading} id="projections-repair-title">{t.projections_repair_queue()}</h2>
            <p class={Muted}>{t.projections_repair_queue_description()}</p>
            if rows.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.projections_no_attention()}</p>
                    <p class={Muted}>{t.projections_no_attention_description()}</p>
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
                            for item in rows.iter() {
                                let details = url::Projections { filters: filters.select(Some(&item.target_id)) }.href();
                                let reference = (item.kind == "projection-group")
                                    .then(|| group_reference(item.context_name.as_deref(), item.projection_name.as_deref()));
                                <tr>
                                    <td data-label={head[0]}><Pill hue={Hue::from(item.tone)} label={&item.state} /></td>
                                    <td data-label={head[1]}>
                                        <span class={Strong}>{&item.label}</span>
                                        <span class={Small}>{&item.kind}</span>
                                    </td>
                                    <td data-label={head[2]} class={Words}>{&item.detail}</td>
                                    <td data-label={head[3]}>
                                        <span class={RowActions}>
                                            <a class={(Button, Secondary, Compact)} href={&details}>{t.projections_details()}</a>
                                            if let Some(href) = &reference {
                                                <a class={(Button, Secondary, Compact)} href={href}>
                                                    {t.projections_group_reference()}
                                                </a>
                                            }
                                        </span>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
    }
}

/// A group's place on the reference page, its context and projection chosen, as admin-web links it.
fn group_reference(context: Option<&str>, projection: Option<&str>) -> String {
    let some = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    let filters = url::Filters { context_name: some(context), projection_name: some(projection), ..Default::default() };
    url::Reference { filters }.href()
}

fn operations<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters) -> impl Render + 'a {
    let mut rows: Vec<&Operation> = console
        .operations
        .iter()
        .filter(|o| {
            let text = [
                Some(o.operation_id.as_str()),
                Some(o.operation_kind.as_str()),
                Some(o.state.as_str()),
                Some(o.context_name.as_str()),
                o.projection_name.as_deref(),
                o.projection_key.as_deref(),
                o.stream_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            filters.matches(&text, &o.state, Some(&o.context_name), o.projection_name.as_deref())
        })
        .collect();
    rows.sort_by_key(|o| severity(&o.state));
    html! { <Operations t={t} rows={rows} filters={filters} /> }
}

/// The recent operations, most urgent first.
#[component(css = ConsolePage)]
fn Operations<'a>(t: Ops, rows: Vec<&'a Operation>, filters: &'a url::Filters) -> impl Render {
    let head = [
        t.projections_operation(),
        t.projections_state(),
        t.projections_target(),
        t.projections_updated(),
        t.projections_actions(),
    ];
    html! {
        <section id={ids::OPERATIONS} class={Part} aria-labelledby="projections-operations-title">
            <h2 class={Heading} id="projections-operations-title">{t.projections_recent_operations()}</h2>
            <p class={Muted}>{t.projections_recent_operations_description()}</p>
            if rows.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.projections_no_projection_operations()}</p>
                    <p class={Muted}>{t.projections_no_projection_operations_description()}</p>
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
                            for operation in rows.iter() {
                                let details = url::Projections { filters: filters.select(Some(&operation.operation_id)) }.href();
                                let target = t
                                    .projections_operation_target(&operation.context_name, operation.target().unwrap_or(t.projections_all()))
                                    .to_string();
                                <tr>
                                    <td data-label={head[0]}>
                                        <span class={Strong}>{&operation.operation_kind}</span>
                                        <span class={Small}>{&operation.operation_id}</span>
                                    </td>
                                    <td data-label={head[1]}>
                                        <Pill hue={state_hue(&operation.state)} label={&operation.state} />
                                    </td>
                                    <td data-label={head[2]} class={Words}>{&target}</td>
                                    <td data-label={head[3]}>{when(t, Some(&operation.updated_at))}</td>
                                    <td data-label={head[4]}>
                                        <a class={(Button, Secondary, Compact)} href={&details}>{t.projections_details()}</a>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
    }
}
