//! Support > Customer Feedback (admin-web's `/support/customer-feedback/attention`, Customer
//! Feedback's `FeedbackAttentionSurface`): the attention metrics and the queue of low-score
//! and reopened cases with their priority, rating, SLA, delivery outcomes and owner. Read from
//! `/api/customer-feedback/attention` as the signed-in staff member; the page needs
//! `support.view`, its nav entry's permission, as admin-web's route does.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/customer-feedback/attention` | the metrics and the queue |
//!
//! Departures from admin-web, each until its issue closes:
//! - The read does not say whether an item is past its SLA or which deadline is in effect
//!   (chase-sets/chase-sets#10855): the pilot works it out as admin-web does, from the item's
//!   `triageDueAt`, `dueAt`, `triagedAt` and `closedAt`.
//! - admin-web links each case to this queue again with a `caseId` it ignores
//!   (chase-sets/chase-sets#10854): the pilot shows the case ID without the link.
use std::time::SystemTime;

use corten::{axum::http::HeaderMap, i18n::parse_timestamp, prelude::*};
use serde::{Deserialize, Serialize};

use super::views;
use crate::{
    app::{Shared, read_failed},
    auth::{Staff, SupportView},
    text::Sup,
};

const CONTEXT: &str = "customer-feedback";
const PATH: &str = "/api/customer-feedback/attention";

#[corten::routes(state = crate::app::Shared, area = crate::support::attention::url::Attention, caller = crate::auth::Staff<crate::auth::SupportView>)]
pub mod url {
    /// The attention queue.
    #[derive(Clone, Debug, Default)]
    #[route("/support/customer-feedback/attention", get = attention)]
    pub struct Attention;
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Attention>, shared: Shared) -> Area<url::Attention> {
    url::area(area, shared).components(views::ATTENTION)
}

/// A case that needs attention (`FeedbackAttentionItem`), as far as the queue shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub attention_id: String,
    pub case_id: String,
    pub rating: u8,
    pub priority: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub triaged_at: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
    pub triage_due_at: String,
    #[serde(default)]
    pub closed_at: Option<String>,
    pub delivery_status: String,
    pub follow_up_delivery_status: String,
}

/// An item's SLA (admin-web's `feedbackCaseSlaState`; chase-sets/chase-sets#10855).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sla<'a> {
    /// Past its triage deadline untriaged, or past its due date, while open.
    Breached,
    /// The deadline in effect: the due date, else the triage deadline.
    Due(&'a str),
}

impl Item {
    pub fn sla(&self, now: SystemTime) -> Sla<'_> {
        let past = |at: &str| parse_timestamp(at).is_some_and(|at| now > at);
        let open = self.closed_at.is_none();
        let untriaged = self.triaged_at.is_none();
        if open && ((untriaged && past(&self.triage_due_at)) || self.due_at.as_deref().is_some_and(past)) {
            return Sla::Breached;
        }
        Sla::Due(self.due_at.as_deref().unwrap_or(&self.triage_due_at))
    }
}

/// The queue's figures (`FeedbackAttentionMetrics`), as far as the page shows them.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub active_count: u64,
    pub overdue_count: u64,
    #[serde(default)]
    pub median_time_to_triage_ms: Option<f64>,
    pub delivery_failures: u64,
}

/// The page: what it shows and what a data client gets.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct AttentionScreen {
    pub items: Vec<Item>,
    pub metrics: Metrics,
}

/// A duration as admin-web's `formatDuration` words it: whole minutes under an hour, else hours.
pub fn duration(t: Sup, ms: Option<f64>) -> String {
    let Some(ms) = ms.filter(|ms| ms.is_finite()) else { return t.cfa_not_available().to_owned() };
    let minutes = (ms / 60_000.0).round() as i64;
    if minutes < 60 {
        return t.cfa_duration_minutes(minutes).to_string();
    }
    t.cfa_duration_hours((minutes as f64 / 60.0).round() as i64).to_string()
}

async fn attention(
    req: Req,
    Caller(staff): Caller<Staff<SupportView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let screen = match caller.read::<AttentionScreen>(PATH, CONTEXT).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, error, false),
    };
    let t: Sup = req.t();
    let view = html! { <views::FeedbackAttentionPage t={t} screen={&screen} now={SystemTime::now()} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.cfa_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn item(triaged: Option<&str>, due: Option<&str>, closed: Option<&str>) -> Item {
        Item {
            attention_id: "a".into(),
            case_id: "c".into(),
            rating: 1,
            priority: "high".into(),
            owner_id: None,
            triaged_at: triaged.map(Into::into),
            due_at: due.map(Into::into),
            triage_due_at: "2026-05-07T12:00:00.000Z".into(),
            closed_at: closed.map(Into::into),
            delivery_status: "sent".into(),
            follow_up_delivery_status: "not-requested".into(),
        }
    }

    #[test]
    fn an_items_sla_is_breached_as_admin_web_works_it_out() {
        let at = |s: &str| parse_timestamp(s).unwrap();
        let before = at("2026-05-07T11:00:00.000Z");
        let after = at("2026-05-07T13:00:00.000Z");
        assert_eq!(item(None, None, None).sla(before), Sla::Due("2026-05-07T12:00:00.000Z"));
        assert_eq!(item(None, None, None).sla(after), Sla::Breached, "untriaged past the triage deadline");
        assert_eq!(item(Some("2026-05-07T11:30:00.000Z"), None, None).sla(after), Sla::Due("2026-05-07T12:00:00.000Z"));
        let due = Some("2026-05-07T12:30:00.000Z");
        assert_eq!(item(Some("2026-05-07T11:30:00.000Z"), due, None).sla(after), Sla::Breached, "past its due date");
        assert_eq!(item(Some("2026-05-07T11:30:00.000Z"), due, None).sla(before), Sla::Due("2026-05-07T12:30:00.000Z"));
        assert_eq!(
            item(None, None, Some("2026-05-07T12:10:00.000Z")).sla(after + Duration::from_secs(60)),
            Sla::Due("2026-05-07T12:00:00.000Z"),
            "closed"
        );
    }
}
