//! Support > Customer Feedback (admin-web's `/support/customer-feedback/attention`, Customer
//! Feedback's `FeedbackAttentionSurface`): the attention metrics and the queue of low-score
//! and reopened cases with their priority, rating, SLA, delivery outcomes and owner. Read from
//! `/api/customer-feedback/attention` as the signed-in staff member; the page needs
//! `support.view`, its nav entry's permission, as admin-web's route does.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/customer-feedback/attention` | the metrics and the queue |
//! | `GET /support/customer-feedback/attention?caseId=...` | one case's attention |
//!
//! Each item's SLA is the read's (`sla`, worked out by the API at one instant), as admin-web
//! shows it. Each case links to the queue for that case alone; the API refuses a malformed case ID
//! with a 400, which the page answers as admin-web does.
use corten::{
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::{Deserialize, Serialize};

use super::views;
use crate::{
    api::segment,
    app::{Shared, read_failed},
    auth::{Staff, SupportView},
    text::Sup,
};

const CONTEXT: &str = "customer-feedback";
const PATH: &str = "/api/customer-feedback/attention";

#[corten::routes(state = crate::app::Shared, area = crate::support::attention::url::Attention, caller = crate::auth::Staff<crate::auth::SupportView>)]
pub mod url {
    use corten::{Fields, Route};

    /// The attention queue, or one case's.
    #[derive(Clone, Debug, Default)]
    #[route("/support/customer-feedback/attention", get = attention)]
    pub struct Attention {
        #[route(query)]
        pub focus: Focus,
    }

    /// The case a link selects, as admin-web names it.
    #[derive(Clone, Debug, Default, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Focus {
        pub case_id: Option<String>,
    }

    impl Attention {
        /// The queue for one case.
        pub fn case(case_id: &str) -> Self {
            Self { focus: Focus { case_id: Some(case_id.to_owned()) } }
        }
    }
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
    pub sla: Sla,
    pub delivery_status: String,
    pub follow_up_delivery_status: String,
}

/// An item's SLA as the API works it out (`FeedbackSlaState`), as far as the queue shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Sla {
    /// Past its triage deadline untriaged, or past its due date, while open.
    pub overdue: bool,
    /// The due date, or the triage deadline while untriaged; none once triaged without one.
    #[serde(default)]
    pub effective_due_at: Option<String>,
    pub triage_due_at: String,
}

impl Sla {
    /// The deadline the queue shows (admin-web's `sla.effectiveDueAt ?? sla.triageDueAt`).
    pub fn due(&self) -> &str {
        self.effective_due_at.as_deref().unwrap_or(&self.triage_due_at)
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
    /// The case the address selects; the items are then that case's alone.
    #[serde(default)]
    pub case_id: Option<String>,
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
    Params(route): Params<url::Attention>,
) -> HtmlResult {
    let case_id = route.focus.case_id.filter(|id| !id.is_empty());
    let path = match &case_id {
        Some(id) => format!("{PATH}?caseId={}", segment(id)),
        None => PATH.to_owned(),
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let mut screen = match caller.read::<AttentionScreen>(&path, CONTEXT).await {
        Ok(screen) => screen,
        // A malformed case ID: admin-web answers the API's status.
        Err(error) if error.status() == Some(StatusCode::BAD_REQUEST) => {
            return Err(corten::Error::new(error).with_status(StatusCode::BAD_REQUEST));
        }
        Err(error) => return read_failed(&req, error, false),
    };
    screen.case_id = case_id;
    let t: Sup = req.t();
    let view = html! { <views::FeedbackAttentionPage t={t} screen={&screen} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.cfa_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}
