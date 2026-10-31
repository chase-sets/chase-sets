//! admin-web's `ProjectionOperationsReferencePage` (Projection settings and reference): the
//! projection groups, the subscription matrix, the workers, the wake pipeline's signals and the
//! console read's diagnostics, each filtered as the console is, and the selected record's sheet.
//! Read-only but for the sheet's repairs, which come back here. On a phone each table row is a card.
use corten::prelude::*;
use serde_json::{Map, Value};

use super::{
    Pill,
    console_page::{FiltersForm, Hue, LinkButton, Named, Nothing, Part, Rows, count, severity, state_hue, when},
    detail_sheet::{detail_sheet, operator_state, worker_id},
};
use crate::{
    auth::Viewer,
    projections::{
        Screen,
        api::{AttentionItem, Count, Group, Snapshot, Subscription},
        url,
    },
    text::Ops,
    views::PageHeader,
};

/// The wake pipeline's dashboard and runbook, as admin-web links them.
const GRAFANA: &str = "https://grafana.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline";
const RUNBOOK: &str = "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/push-wake-operations.md";

const VIA: url::Via = url::Via::Reference;

#[component(css)]
pub fn ReferencePage<'a>(t: Ops, screen: &'a Screen, filters: &'a url::Filters, viewer: &'a Viewer) -> impl Render {
    let console = &screen.console;
    let back = filters.select(None).on(url::Via::Console);
    html! {
        <PageHeader
            eyebrow={t.projections_eyebrow()}
            title={t.projections_reference_title()}
            description={t.projections_reference_description()}
        />
        <div class={Actions}>
            <LinkButton href={&back} label={t.projections_back_to_operations()} compact={false} />
            <LinkButton href={GRAFANA} label={t.projections_wake_open_grafana()} compact={false} />
            <LinkButton href={RUNBOOK} label={t.projections_wake_open_runbook()} compact={false} />
        </div>
        <FiltersForm t={t} console={console} filters={filters} via={VIA} />
        <Part id="projections-groups-title" title={t.projections_projection_groups()} description={None}>
            {groups(t, console, filters)}
        </Part>
        <Part
            id="projections-subscriptions-title"
            title={t.projections_subscription_matrix()}
            description={Some(t.projections_subscription_matrix_description())}
        >
            {subscriptions(t, console, filters)}
        </Part>
        <Part id="projections-workers-title" title={t.projections_workers()} description={None}>
            {workers(t, console, filters)}
        </Part>
        <Part id="projections-wake-title" title={t.projections_wake_reference()} description={None}>
            <WakeReference t={t} wake={screen.wake.as_deref()} />
        </Part>
        <Part id="projections-diagnostics-title" title={t.projections_diagnostics()} description={None}>
            <Diagnostics t={t} console={console} />
        </Part>
        {detail_sheet(t, console, filters, viewer, VIA)}
    }
}

/// A count's lag: the source's lag, or what is outstanding when the API sent none.
fn lag<'a>(source: Option<&'a Count>, outstanding: &'a Count) -> &'a Count {
    source.unwrap_or(outstanding)
}

/// The groups the filters keep, most urgent first.
fn groups<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters) -> impl Render + 'a {
    let mut rows: Vec<&Group> = console
        .projection_groups
        .iter()
        .filter(|g| {
            let text = [&g.target_context_name, &g.projection_name]
                .into_iter()
                .chain(&g.source_context_names)
                .chain(&g.owned_tables)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            filters.matches(&text, &g.state, Some(&g.target_context_name), Some(&g.projection_name))
        })
        .collect();
    rows.sort_by_key(|g| severity(&g.state));
    let head = [
        t.projections_projection(),
        t.projections_state(),
        t.projections_source_lag(),
        t.projections_issues(),
        t.projections_actions(),
    ];
    html! {
        if rows.is_empty() {
            <Nothing
                title={t.projections_no_projection_groups()}
                description={t.projections_no_projection_groups_description()}
            />
        } else {
            <Rows label={t.projections_projection_groups()} head={&head}>
                for group in &rows {
                    let details = filters.select(Some(&group.id())).on(VIA);
                    let issues = t.projections_issue_summary(group.blocked_stream_count, group.poison_event_count).to_string();
                    <tr>
                        <td data-label={head[0]}><Named name={&group.projection_name} detail={&group.target_context_name} /></td>
                        <td data-label={head[1]}><Pill hue={state_hue(&group.state)} label={&group.state} /></td>
                        <td data-label={head[2]}>
                            {count(t, lag(group.source_lag_event_count.as_ref(), &group.outstanding_event_count))}
                        </td>
                        <td data-label={head[3]}>{&issues}</td>
                        <td data-label={head[4]}>
                            <LinkButton href={&details} label={t.projections_details()} compact={true} />
                        </td>
                    </tr>
                }
            </Rows>
        }
    }
}

/// A subscription as the matrix lists it: its group, and its state as the operator sees it.
struct Wiring<'a> {
    group: &'a Group,
    subscription: &'a Subscription,
    state: &'a str,
}

/// A lag as a number to order by; text that is not one orders as none.
fn backlog(wiring: &Wiring<'_>) -> i128 {
    let s = wiring.subscription;
    lag(s.source_lag_event_count.as_ref(), &s.outstanding_event_count).0.trim().parse().unwrap_or(0)
}

/// The subscriptions the filters keep, the largest backlog first, then by group and source
/// (admin-web's `compareSubscriptionRows`).
fn subscriptions<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters) -> impl Render + 'a {
    let mut rows: Vec<Wiring> = console
        .projection_groups
        .iter()
        .flat_map(|group| {
            group.subscriptions.iter().map(move |subscription| Wiring {
                group,
                subscription,
                state: operator_state(console, group, subscription),
            })
        })
        .filter(|w| {
            let s = w.subscription;
            let text = [&s.checkpoint_key, &w.group.projection_name, &s.source_context_name, &s.target_context_name]
                .map(String::as_str)
                .join(" ");
            filters.matches(&text, w.state, Some(&s.target_context_name), Some(&w.group.projection_name))
        })
        .collect();
    rows.sort_by(|a, b| {
        backlog(b)
            .cmp(&backlog(a))
            .then_with(|| a.group.projection_name.cmp(&b.group.projection_name))
            .then_with(|| a.subscription.source_context_name.cmp(&b.subscription.source_context_name))
    });
    let head = [
        t.projections_projection(),
        t.projections_source_context(),
        t.projections_state(),
        t.projections_source_lag(),
        t.projections_positions(),
        t.projections_actions(),
    ];
    html! {
        if rows.is_empty() {
            <Nothing title={t.projections_no_subscriptions()} description={t.projections_no_subscriptions_description()} />
        } else {
            <Rows label={t.projections_subscription_matrix()} head={&head}>
                for w in &rows {
                    let s = w.subscription;
                    let details = filters.select(Some(&s.checkpoint_key)).on(VIA);
                    let positions = t
                        .projections_position_range(count(t, &s.last_global_position), count(t, &s.source_head_global_position))
                        .to_string();
                    <tr>
                        <td data-label={head[0]}><Named name={&w.group.projection_name} detail={&s.checkpoint_key} /></td>
                        <td data-label={head[1]}>{&s.source_context_name}</td>
                        <td data-label={head[2]}><Pill hue={state_hue(w.state)} label={w.state} /></td>
                        <td data-label={head[3]}>
                            {count(t, lag(s.source_lag_event_count.as_ref(), &s.outstanding_event_count))}
                        </td>
                        <td data-label={head[4]}>{&positions}</td>
                        <td data-label={head[5]}>
                            <LinkButton href={&details} label={t.projections_details()} compact={true} />
                        </td>
                    </tr>
                }
            </Rows>
        }
    }
}

/// A runner's or worker's value as admin-web writes it: the first of `keys` it has.
fn field(entry: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match entry.get(*key) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
    })
}

/// What a search finds a runner or worker by: each of its plain values.
fn worker_text(entry: &Map<String, Value>) -> String {
    entry
        .values()
        .filter_map(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The runners and workers the filters keep (by search and state: they have no context or
/// projection, so choosing one hides them, as admin-web's), most urgent first.
fn workers<'a>(t: Ops, console: &'a Snapshot, filters: &'a url::Filters) -> impl Render + 'a {
    let state = |entry: &Map<String, Value>| field(entry, &["state", "worker_state"]);
    let mut rows: Vec<&Map<String, Value>> = console
        .runners
        .iter()
        .chain(&console.workers)
        .filter(|entry| filters.matches(&worker_text(entry), &state(entry).unwrap_or_default(), None, None))
        .collect();
    rows.sort_by_key(|entry| severity(&state(entry).unwrap_or_default()));
    let head =
        [t.projections_runner(), t.projections_kind(), t.projections_state(), t.projections_updated(), t.projections_actions()];
    html! {
        if rows.is_empty() {
            <Nothing title={t.projections_no_workers()} description={t.projections_no_workers_description()} />
        } else {
            <Rows label={t.projections_workers()} head={&head}>
                for entry in &rows {
                    let id = worker_id(entry);
                    let details = filters.select(Some(&id)).on(VIA);
                    let kind = field(entry, &["runner_kind", "worker_kind"]).unwrap_or_default();
                    // admin-web colors a worker without a state as idle and names it active.
                    let hue = state(entry).map_or(Hue::Neutral, |s| state_hue(&s));
                    let label = state(entry).unwrap_or_else(|| "active".to_owned());
                    let updated = field(entry, &["updated_at", "heartbeat_at"]);
                    <tr>
                        <td data-label={head[0]}>{&id}</td>
                        <td data-label={head[1]}>{&kind}</td>
                        <td data-label={head[2]}><Pill hue={hue} label={&label} /></td>
                        <td data-label={head[3]}>{when(t, updated.as_deref())}</td>
                        <td data-label={head[4]}>
                            <LinkButton href={&details} label={t.projections_details()} compact={true} />
                        </td>
                    </tr>
                }
            </Rows>
        }
    }
}

/// Where the wake pipeline's telemetry is, and its signals: none when its read failed.
#[component(css = ReferencePage)]
fn WakeReference<'a>(t: Ops, wake: Option<&'a [AttentionItem]>) -> impl Render {
    let head = [t.projections_signal(), t.projections_meaning()];
    html! {
        <div class={Note}>
            <p class={Strong}>{t.projections_wake_observability_title()}</p>
            <p>{t.projections_wake_observability_description()}</p>
        </div>
        match wake {
            None => {
                <div class={Note}>
                    <p class={Strong}>{t.projections_wake_unavailable()}</p>
                    <p>{t.projections_wake_unavailable_description()}</p>
                </div>
            }
            Some([]) => {
                <p class={Quiet}>{t.projections_no_wake_attention()}</p>
            }
            Some(items) => {
                <Rows label={t.projections_wake_reference()} head={&head}>
                    for item in items {
                        <tr>
                            <td data-label={head[0]}><Pill hue={Hue::from(item.tone)} label={&item.label} /></td>
                            <td data-label={head[1]}>{&item.detail}</td>
                        </tr>
                    }
                </Rows>
            }
        }
    }
}

/// The read's own numbers: where its status came from, its groups, and its operations.
#[component(css = ReferencePage)]
fn Diagnostics<'a>(t: Ops, console: &'a Snapshot) -> impl Render {
    let summary = &console.summary;
    let zero = Count("0".into());
    let ops = console.operation_summary.as_ref();
    let snapshot = [
        (t.projections_status_source(), console.projection_status_source.clone()),
        (t.projections_groups(), t.number(summary.total_groups).to_string()),
        (t.projections_caught_up(), t.number(summary.caught_up_groups).to_string()),
        (t.projections_behind(), t.number(summary.behind_groups).to_string()),
        (t.projections_error_groups(), t.number(summary.error_groups).to_string()),
    ];
    let operations = [
        (t.projections_queued_operations(), count(t, ops.map_or(&zero, |s| &s.queued_count))),
        (t.projections_running_operations(), count(t, ops.map_or(&zero, |s| &s.running_count))),
        (t.projections_failed_operations(), count(t, ops.map_or(&zero, |s| &s.failed_count))),
        (t.projections_oldest_queued_at(), when(t, ops.and_then(|s| s.oldest_queued_at.as_deref()))),
        (t.projections_oldest_running_at(), when(t, ops.and_then(|s| s.oldest_running_at.as_deref()))),
    ];
    html! {
        <div class={Panels}>
            for (title, rows) in [(t.projections_snapshot_diagnostics(), &snapshot), (t.projections_operation_diagnostics(), &operations)] {
                <section class={Panel} aria-label={title}>
                    <h3>{title}</h3>
                    <dl>
                        for (key, value) in rows {
                            <div>
                                <dt>{*key}</dt>
                                <dd>{value}</dd>
                            </div>
                        }
                    </dl>
                </section>
            }
        </div>
    }
}
