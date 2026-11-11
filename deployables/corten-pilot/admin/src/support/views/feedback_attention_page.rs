//! Customer Feedback's attention queue (`FeedbackAttentionSurface`): four figures (one column on a
//! phone, four from 48rem), then the queue as a table that stacks on a phone, a row a block of labelled lines.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};
use platform::ui::{
    stats::{Stat, StatTone, Stats as KitStats, StatsSurface},
    table::{CellLabel, Table as KitTable, TableLayout},
};

use crate::{
    support::attention::{AttentionScreen, Item, duration},
    text::Sup,
};

#[component(css = FeedbackAttentionPage)]
fn Priority<'a>(value: &'a str) -> impl Render {
    html! {
        match value {
            "urgent" => <span class={(Pill, Danger)}>{value}</span>,
            "high" => <span class={(Pill, Warning)}>{value}</span>,
            _ => <span class={(Pill, Neutral)}>{value}</span>,
        }
    }
}

#[component(css = FeedbackAttentionPage)]
fn Row<'a>(t: Sup, item: &'a Item) -> impl Render {
    let at = item.sla.due();
    let due =
        parse_timestamp(at).map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
    html! {
        <tr>
            <td class={Words}>
                <CellLabel>{t.cfa_case()}</CellLabel>
                {&item.case_id}
            </td>
            <td>
                <CellLabel>{t.cfa_priority()}</CellLabel>
                <Priority value={&item.priority} />
            </td>
            <td>
                <CellLabel>{t.cfa_rating()}</CellLabel>
                {format!("{}/5", item.rating)}
            </td>
            <td>
                <CellLabel>{t.cfa_sla()}</CellLabel>
                if item.sla.overdue {
                    <span class={(Pill, Danger)}>{t.cfa_sla_breached()}</span>
                } else {
                    <span class={(Pill, Neutral)}>{&due}</span>
                }
            </td>
            <td>
                <CellLabel>{t.cfa_delivery()}</CellLabel>
                {format!("{} / {}", item.delivery_status, item.follow_up_delivery_status)}
            </td>
            <td class={Words}>
                <CellLabel>{t.cfa_owner()}</CellLabel>
                {item.owner_id.as_deref().unwrap_or(t.cfa_unassigned())}
            </td>
        </tr>
    }
}

#[component(css)]
pub fn FeedbackAttentionPage<'a>(t: Sup, screen: &'a AttentionScreen) -> impl Render {
    let m = &screen.metrics;
    html! {
        <header class={Header}>
            <p class={Eyebrow}>{t.cfa_title()}</p>
            <h1>{t.cfa_title()}</h1>
            <p class={Muted}>{t.cfa_description()}</p>
        </header>
        <dl class={(KitStats { surface: StatsSurface::Cards }, Counts)}>
            <Stat label={t.cfa_metrics_active()} value={m.active_count} note="" tone={StatTone::Neutral} />
            <Stat label={t.cfa_metrics_overdue()} value={m.overdue_count} note="" tone={StatTone::Neutral} />
            <Stat
                label={t.cfa_metrics_time_to_triage()}
                value={duration(t, m.median_time_to_triage_ms)}
                note=""
                tone={StatTone::Neutral}
            />
            <Stat label={t.cfa_metrics_delivery_failures()} value={m.delivery_failures} note="" tone={StatTone::Neutral} />
        </dl>
        <section class={Part}>
            <h2 class={Heading}>{t.cfa_queue()}</h2>
            if screen.items.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.cfa_empty()}</p>
                    <p class={Muted}>{t.cfa_description()}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <KitTable layout={TableLayout::Stack}>
                        <table class={Table} aria-label={t.cfa_queue()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.cfa_case()}</th>
                                    <th scope="col">{t.cfa_priority()}</th>
                                    <th scope="col">{t.cfa_rating()}</th>
                                    <th scope="col">{t.cfa_sla()}</th>
                                    <th scope="col">{t.cfa_delivery()}</th>
                                    <th scope="col">{t.cfa_owner()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &screen.items {
                                    <Row t={t} item={item} />
                                }
                            </tbody>
                        </table>
                    </KitTable>
                </div>
            }
        </section>
    }
}
