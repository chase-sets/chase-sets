//! admin-web's `ProjectionDetailDrawer`: the selected record (`selected` in the address) in a sheet beside
//! the console, with its repairs: an operation (Cancel), a projection group (Rebuild, Rebuild
//! context, each confirmed in a dialog), a subscription, a poison event or a blocked stream (Retry),
//! or a worker. An address whose record is gone draws no sheet, as admin-web's.
//!
//! Without JavaScript the sheet is an open, non-modal `<dialog>`, closed by a link back to the console;
//! the confirm dialogs open with `command="show-modal"` (no script). corten-ui's
//! `dialog::modalClosedBy` makes the sheet modal and sends Escape to the close link's address, so
//! the address says what is open.
use corten::prelude::*;
use serde_json::Value;

use super::{
    Pill,
    console_page::{count, state_hue, when},
};
use crate::{
    auth::Viewer,
    projections::{
        OPERATE, REBUILD,
        api::{BlockedStream, Count, Group, Operation, PoisonEvent, Snapshot, Subscription},
        url,
    },
    text::Ops,
};

/// The sheet's title, which names it.
#[derive(Id)]
pub struct ProjectionSheetTitleId;

/// The rebuild dialogs.
#[derive(Id, Clone, Copy)]
pub struct RebuildGroupId;
#[derive(Id, Clone, Copy)]
pub struct RebuildContextId;

/// What is selected, found in the console's read.
pub(crate) enum Record<'a> {
    Operation(&'a Operation),
    Group(&'a Group),
    Subscription(&'a Group, &'a Subscription),
    Poison { projection_key: &'a str, event: &'a PoisonEvent, stream: Option<&'a BlockedStream> },
    Blocked { projection_key: &'a str, stream: &'a BlockedStream, events: Vec<&'a PoisonEvent> },
    Worker(&'a serde_json::Map<String, Value>),
}

/// The record `selected` names, in admin-web's order: an operation, a group, a subscription, a
/// poison event (`poison-event:{id}`), a blocked stream (`{projectionKey}:{streamId}`), a worker.
fn find<'a>(console: &'a Snapshot, selected: &str) -> Option<Record<'a>> {
    if selected.is_empty() {
        return None;
    }
    if let Some(operation) = console.operations.iter().find(|o| o.operation_id == selected) {
        return Some(Record::Operation(operation));
    }
    if let Some(group) = console.projection_groups.iter().find(|g| g.id() == selected) {
        return Some(Record::Group(group));
    }
    for group in &console.projection_groups {
        if let Some(subscription) = group.subscriptions.iter().find(|s| s.checkpoint_key == selected) {
            return Some(Record::Subscription(group, subscription));
        }
    }
    if let Some(event_id) = selected.strip_prefix("poison-event:") {
        for projection in &console.blocked_projections {
            if let Some(event) = projection.poison_events.iter().find(|e| e.event_id == event_id) {
                let stream = projection.blocked_streams.iter().find(|s| s.stream_id == event.stream_id);
                return Some(Record::Poison { projection_key: &projection.projection_key, event, stream });
            }
        }
    }
    for projection in &console.blocked_projections {
        if let Some(stream) =
            projection.blocked_streams.iter().find(|s| format!("{}:{}", projection.projection_key, s.stream_id) == selected)
        {
            let events = projection.poison_events.iter().filter(|e| e.stream_id == stream.stream_id).collect();
            return Some(Record::Blocked { projection_key: &projection.projection_key, stream, events });
        }
    }
    console.runners.iter().chain(&console.workers).find(|w| worker_id(w) == selected).map(Record::Worker)
}

/// A runner's or a worker's id (admin-web's `workerId`).
pub(crate) fn worker_id(entry: &serde_json::Map<String, Value>) -> String {
    match entry.get("runner_name").filter(|v| !v.is_null()).or_else(|| entry.get("worker_id")) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// A subscription's state as the operator sees it: behind while its runner runs is running
/// (admin-web's `resolveProjectionOperatorState`).
pub(crate) fn operator_state<'a>(console: &'a Snapshot, group: &Group, subscription: &'a Subscription) -> &'a str {
    let runner = format!("{}.{}", group.target_context_name, group.projection_name);
    let running = console.runners.iter().any(|r| {
        r.get("runner_name").and_then(Value::as_str) == Some(runner.as_str())
            && r.get("state").and_then(Value::as_str) == Some("running")
    });
    if subscription.state == "behind" && running { "running" } else { &subscription.state }
}

fn yes_no(t: Ops, value: bool) -> &'static str {
    if value { t.projections_yes() } else { t.projections_no() }
}

fn lag(t: Ops, value: Option<&Count>) -> String {
    match value.filter(|c| !c.0.is_empty()) {
        Some(value) => count(t, value),
        None => t.projections_not_recorded().to_owned(),
    }
}

/// What a sheet draws: its title, its rows, its error, and the poison events it lists.
struct Detail<'a> {
    title: String,
    rows: Vec<(&'static str, String)>,
    error: Option<String>,
    poison: Vec<&'a PoisonEvent>,
}

fn detail<'a>(t: Ops, console: &'a Snapshot, record: &Record<'a>) -> Detail<'a> {
    let none = || t.projections_not_recorded().to_owned();
    match record {
        Record::Operation(o) => Detail {
            title: t.projections_operation_detail_title(&o.operation_kind, &o.state).to_string(),
            rows: vec![
                (t.projections_operation_id(), o.operation_id.clone()),
                (t.projections_context(), o.context_name.clone()),
                (t.projections_target(), o.target().unwrap_or(t.projections_all()).to_owned()),
                (t.projections_requested_by(), o.requested_by_user_id.clone().unwrap_or_else(none)),
                (t.projections_claim_owner(), o.claim_owner_id.clone().unwrap_or_else(none)),
                (t.projections_requested_at(), when(t, Some(&o.requested_at))),
                (t.projections_started_at(), when(t, o.started_at.as_deref())),
                (t.projections_completed_at(), when(t, o.completed_at.as_deref())),
            ],
            error: o.error.as_ref().map(|e| Value::Object(e.clone()).to_string()),
            poison: Vec::new(),
        },
        Record::Group(g) => Detail {
            title: t.projections_projection_group_detail_title(&g.target_context_name, &g.projection_name).to_string(),
            rows: vec![
                (t.projections_state(), g.state.clone()),
                (t.projections_required_during_bootstrap(), yes_no(t, g.required_during_bootstrap).to_owned()),
                (t.projections_initialized(), yes_no(t, g.initialized).to_owned()),
                (t.projections_caught_up(), yes_no(t, g.caught_up).to_owned()),
                (
                    t.projections_source_contexts(),
                    if g.source_context_names.is_empty() { none() } else { g.source_context_names.join(", ") },
                ),
                (
                    t.projections_revision(),
                    t.projections_revision_range(
                        g.stored_projection_revision.map_or_else(|| t.projections_none().to_owned(), |r| r.to_string()),
                        g.projection_revision,
                    )
                    .to_string(),
                ),
                (t.projections_source_lag(), count(t, g.source_lag_event_count.as_ref().unwrap_or(&g.outstanding_event_count))),
                (t.projections_applicable_lag(), lag(t, g.applicable_lag_estimate.as_ref())),
                (t.projections_owned_tables(), if g.owned_tables.is_empty() { none() } else { g.owned_tables.join(", ") }),
                (t.projections_updated(), when(t, Some(&g.updated_at))),
            ],
            error: g.last_error.clone(),
            poison: Vec::new(),
        },
        Record::Subscription(g, s) => Detail {
            title: s.checkpoint_key.clone(),
            rows: vec![
                (t.projections_state(), operator_state(console, g, s).to_owned()),
                (t.projections_source_context(), s.source_context_name.clone()),
                (t.projections_target_context(), s.target_context_name.clone()),
                (t.projections_version(), s.subscription_version.to_string()),
                (t.projections_blocked_streams(), s.blocked_stream_count.to_string()),
                (t.projections_poison_events(), s.poison_event_count.to_string()),
                (
                    t.projections_positions(),
                    t.projections_position_range(&s.last_global_position.0, &s.source_head_global_position.0).to_string(),
                ),
                (t.projections_source_lag(), count(t, s.source_lag_event_count.as_ref().unwrap_or(&s.outstanding_event_count))),
                (t.projections_applicable_lag(), lag(t, s.applicable_lag_estimate.as_ref())),
            ],
            error: s.last_error.clone(),
            poison: Vec::new(),
        },
        Record::Poison { projection_key, event, .. } => Detail {
            title: event.event_type.clone(),
            rows: vec![
                (t.projections_projection_key(), (*projection_key).to_owned()),
                (t.projections_stream(), event.stream_id.clone()),
                (t.projections_version(), event.stream_version.to_string()),
                (t.projections_position(), event.global_position.0.clone()),
                (t.projections_retry_count(), event.retry_count.to_string()),
                (t.projections_first_seen_at(), when(t, Some(&event.first_seen_at))),
                (t.projections_last_seen_at(), when(t, Some(&event.last_seen_at))),
            ],
            error: Some(event.error_message.clone()).filter(|e| !e.is_empty()),
            poison: vec![*event],
        },
        Record::Blocked { projection_key, stream, events } => Detail {
            title: t.projections_blocked_stream_detail_title(*projection_key, &stream.stream_id).to_string(),
            rows: vec![
                (t.projections_state(), stream.state.clone()),
                (t.projections_stream(), stream.stream_id.clone()),
                (t.projections_first_version(), stream.first_blocked_stream_version.to_string()),
                (
                    t.projections_positions(),
                    t.projections_position_range(&stream.first_blocked_global_position.0, &stream.last_seen_global_position.0)
                        .to_string(),
                ),
                (t.projections_deferred(), stream.deferred_event_count.to_string()),
            ],
            error: None,
            poison: events.clone(),
        },
        Record::Worker(entry) => Detail { title: worker_id(entry), rows: Vec::new(), error: None, poison: Vec::new() },
    }
}

/// A worker's first twelve recorded values, as admin-web lists them (its keys are the API's).
fn worker_rows(entry: &serde_json::Map<String, Value>) -> Vec<(String, String)> {
    entry
        .iter()
        .filter(|(_, v)| !v.is_null())
        .take(12)
        .map(|(k, v)| {
            (
                k.clone(),
                match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                },
            )
        })
        .collect()
}

/// A group's blocked streams and poison events, each a link to its own sheet. The console's read
/// does not list them anywhere else (chase-sets/chase-sets#10710), so this is how an operator
/// reaches Retry; remove it once the repair queue lists them.
fn group_problems<'a>(console: &'a Snapshot, group: &Group) -> Vec<(String, String, &'a str)> {
    let keys: Vec<&str> = group.subscriptions.iter().map(|s| s.checkpoint_key.as_str()).collect();
    let mut out = Vec::new();
    for projection in console.blocked_projections.iter().filter(|b| keys.contains(&b.projection_key.as_str())) {
        for stream in &projection.blocked_streams {
            out.push((
                format!("{}:{}", projection.projection_key, stream.stream_id),
                stream.stream_id.clone(),
                stream.state.as_str(),
            ));
        }
        for event in &projection.poison_events {
            out.push((format!("poison-event:{}", event.event_id), event.event_type.clone(), event.state.as_str()));
        }
    }
    out
}

/// The selected record's sheet, or nothing when nothing (or a record that is gone) is selected.
/// `via` is the page it is drawn on, which its links and writes come back to.
pub fn detail_sheet<'a>(
    t: Ops,
    console: &'a Snapshot,
    filters: &'a url::Filters,
    viewer: &'a Viewer,
    via: url::Via,
) -> impl Render + 'a {
    let record = find(console, filters.selected());
    html! {
        if let Some(record) = &record {
            <DetailSheet t={t} console={console} record={record} filters={filters} viewer={viewer} via={via} />
        }
    }
}

#[component(css)]
pub(crate) fn DetailSheet<'a>(
    t: Ops,
    console: &'a Snapshot,
    record: &'a Record<'a>,
    filters: &'a url::Filters,
    viewer: &'a Viewer,
    via: url::Via,
) -> impl Render {
    let close = filters.select(None).on(via);
    let back = refs();
    let operate = viewer.can(OPERATE);
    let rebuild = viewer.can(REBUILD);
    let shown = detail(t, console, record);
    html! {
        <dialog
            class={Sheet}
            open
            aria-labelledby={ProjectionSheetTitleId}
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <header class={Head}>
                <div>
                    <h2 id={ProjectionSheetTitleId}>{&shown.title}</h2>
                    <p>{t.projections_drawer_description()}</p>
                </div>
                <a ref={back} class={Close} href={&close} aria-label={t.projections_close_detail()}>"×"</a>
            </header>
            <Repairs t={t} record={record} filters={filters} operate={operate} rebuild={rebuild} via={via} />
            if let Record::Worker(entry) = record {
                <dl class={Rows}>
                    for (key, value) in &worker_rows(entry) {
                        <div>
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                        </div>
                    }
                </dl>
            } else {
                <dl class={Rows}>
                    for (key, value) in &shown.rows {
                        <div>
                            <dt>{*key}</dt>
                            <dd>{value}</dd>
                        </div>
                    }
                </dl>
            }
            if let Some(error) = &shown.error {
                <p class={Error}>{error}</p>
            }
            if !shown.poison.is_empty() {
                <PoisonTable t={t} events={&shown.poison} />
            }
            if let Record::Group(group) = record {
                let problems = group_problems(console, group);
                if !problems.is_empty() {
                    <section class={Problems} aria-labelledby="projections-group-problems">
                        <h3 id="projections-group-problems">
                            {t.projections_blocked_streams()}" / "{t.projections_poison_events()}
                        </h3>
                        <ul>
                            for (id, label, state) in &problems {
                                let href = filters.select(Some(id)).on(via);
                                <li>
                                    <Pill hue={state_hue(state)} label={state} />
                                    <a href={&href}>{label}</a>
                                </li>
                            }
                        </ul>
                    </section>
                }
            }
        </dialog>
    }
}

/// The record's repairs, for staff the API lets make them.
#[component(css = DetailSheet)]
fn Repairs<'a>(
    t: Ops,
    record: &'a Record<'a>,
    filters: &'a url::Filters,
    operate: bool,
    rebuild: bool,
    via: url::Via,
) -> impl Render {
    let cancel = url::Cancel { filters: filters.writing_from(via) }.href();
    let retry = url::Retry { filters: filters.writing_from(via) }.href();
    let rebuild_group = url::Rebuild { filters: filters.writing_from(via) }.href();
    let rebuild_context = url::RebuildContext { filters: filters.writing_from(via) }.href();
    let cancel_fields = crate::projections::CancelInput::FIELDS;
    let retry_fields = crate::projections::RetryInput::FIELDS;
    let group_fields = crate::projections::RebuildInput::FIELDS;
    let context_fields = crate::projections::ContextInput::FIELDS;
    html! {
        match record {
            Record::Operation(o) if operate && o.live() => {
                <div class={Repairs}>
                    <form method="post" action={&cancel}>
                        <input type="hidden" name={cancel_fields.operation_id} value={&o.operation_id}>
                        <button type="submit" class={Secondary}>{t.projections_cancel()}</button>
                    </form>
                </div>
            }
            Record::Group(g) if rebuild => {
                <div class={Repairs}>
                    <button type="button" class={Secondary} command="show-modal" commandfor={RebuildGroupId}>
                        {t.projections_rebuild()}
                    </button>
                    <button type="button" class={Secondary} command="show-modal" commandfor={RebuildContextId}>
                        {t.projections_rebuild_context()}
                    </button>
                </div>
                <dialog id={RebuildGroupId} class={Confirm} aria-labelledby="projections-rebuild-group-title">
                    <h3 id="projections-rebuild-group-title">{t.projections_confirm_rebuild_group_title()}</h3>
                    <p>{t.projections_confirm_rebuild_group_description(&g.target_context_name, &g.projection_name)}</p>
                    <p class={Muted}>{t.projections_confirm_rebuild_group_impact()}</p>
                    <form method="post" action={&rebuild_group}>
                        <input type="hidden" name={group_fields.context_name} value={&g.target_context_name}>
                        <input type="hidden" name={group_fields.projection_name} value={&g.projection_name}>
                        <div class={Footer}>
                            <button type="button" class={Secondary} command="close" commandfor={RebuildGroupId}>
                                {t.projections_cancel()}
                            </button>
                            <button type="submit" class={Danger}>{t.projections_confirm_rebuild()}</button>
                        </div>
                    </form>
                </dialog>
                <dialog id={RebuildContextId} class={Confirm} aria-labelledby="projections-rebuild-context-title">
                    <h3 id="projections-rebuild-context-title">{t.projections_confirm_rebuild_context_title()}</h3>
                    <p>{t.projections_confirm_rebuild_context_description(&g.target_context_name)}</p>
                    <p class={Muted}>{t.projections_confirm_rebuild_context_impact()}</p>
                    <form method="post" action={&rebuild_context}>
                        <input type="hidden" name={context_fields.context_name} value={&g.target_context_name}>
                        <div class={Footer}>
                            <button type="button" class={Secondary} command="close" commandfor={RebuildContextId}>
                                {t.projections_cancel()}
                            </button>
                            <button type="submit" class={Danger}>{t.projections_confirm_rebuild_context()}</button>
                        </div>
                    </form>
                </dialog>
            }
            Record::Poison { projection_key, stream: Some(stream), .. } if operate => {
                <div class={Repairs}>
                    <form method="post" action={&retry}>
                        <input type="hidden" name={retry_fields.projection_key} value={*projection_key}>
                        <input type="hidden" name={retry_fields.stream_id} value={&stream.stream_id}>
                        <button type="submit">{t.projections_retry()}</button>
                    </form>
                </div>
            }
            Record::Blocked { projection_key, stream, .. } if operate => {
                <div class={Repairs}>
                    <form method="post" action={&retry}>
                        <input type="hidden" name={retry_fields.projection_key} value={*projection_key}>
                        <input type="hidden" name={retry_fields.stream_id} value={&stream.stream_id}>
                        <button type="submit">{t.projections_retry()}</button>
                    </form>
                </div>
            }
            _ => {}
        }
    }
}

/// Poison events: their type, state, position and error.
#[component(css = DetailSheet)]
fn PoisonTable<'a>(t: Ops, events: &'a [&'a PoisonEvent]) -> impl Render {
    html! {
        <table class={Table}>
            <thead>
                <tr>
                    <th scope="col">{t.projections_event_type()}</th>
                    <th scope="col">{t.projections_state()}</th>
                    <th scope="col">{t.projections_position()}</th>
                    <th scope="col">{t.projections_error()}</th>
                </tr>
            </thead>
            <tbody>
                for event in events {
                    <tr>
                        <td>{&event.event_type}</td>
                        <td><Pill hue={state_hue(&event.state)} label={&event.state} /></td>
                        <td class={Number}>{&event.global_position.0}</td>
                        <td>{&event.error_message}</td>
                    </tr>
                }
            </tbody>
        </table>
    }
}
