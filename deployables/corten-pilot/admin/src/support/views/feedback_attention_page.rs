//! Customer Feedback's attention queue (`FeedbackAttentionSurface`): four figures (one column on a
//! phone, four from 48rem), then the queue as a table that scrolls on its own on a phone.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
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
            <td class={Words}>{&item.case_id}</td>
            <td><Priority value={&item.priority} /></td>
            <td>{format!("{}/5", item.rating)}</td>
            <td>
                if item.sla.overdue {
                    <span class={(Pill, Danger)}>{t.cfa_sla_breached()}</span>
                } else {
                    <span class={(Pill, Neutral)}>{&due}</span>
                }
            </td>
            <td>{format!("{} / {}", item.delivery_status, item.follow_up_delivery_status)}</td>
            <td class={Words}>{item.owner_id.as_deref().unwrap_or(t.cfa_unassigned())}</td>
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
        <dl class={Stats}>
            <div class={Stat}>
                <dt>{t.cfa_metrics_active()}</dt>
                <dd>{m.active_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.cfa_metrics_overdue()}</dt>
                <dd>{m.overdue_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.cfa_metrics_time_to_triage()}</dt>
                <dd>{duration(t, m.median_time_to_triage_ms)}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.cfa_metrics_delivery_failures()}</dt>
                <dd>{m.delivery_failures}</dd>
            </div>
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
                </div>
            }
        </section>
    }
}
