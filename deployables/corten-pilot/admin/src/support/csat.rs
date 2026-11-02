//! Support > CSAT dashboard (admin-web's `/support/csat`, Platform Operations' `CsatAdminPage`):
//! the trailing 7- and 30-day CSAT and response rates, the 30-day volume, the dashboard's
//! filters, the CSAT trend, the 30-day rating distribution, the invitation queue with its pages,
//! and the projection's freshness. Read from Customer Feedback's `/api/customer-feedback` as the
//! signed-in staff member; it needs `platform-feedback.view`, as the API and admin-web's nav entry
//! do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /support/csat?from&to&surveyVersion&outcomeCodes&customerRoles&states&ratings&followUpConsent&cursor&direction` | the dashboard |
//!
//! Departures from admin-web, each until its issue closes:
//! - The survey filter sends the registered version (`csat.v1`); admin-web's `v1` is answered
//!   500 (chase-sets/chase-sets#10843), and an address with `v1` is read as `csat.v1`.
//! - A read that fails keeps the filters on the page with a banner (502), since the API answers
//!   a filter it refuses with 500 (chase-sets/chase-sets#10844).
//! - There is no Export: it fails for everyone who is shown it (chase-sets/chase-sets#10845).
//! - The filter form does not carry the read's `asOf` back, so a later `To` is not refused for
//!   being after a stale `asOf`.
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::views;
use crate::{
    api::segment,
    app::{Shared, sign_in},
    auth::{PlatformFeedbackView, Staff},
    text::Sup,
};

const CONTEXT: &str = "customer-feedback";
const BASE: &str = "/api/customer-feedback";

#[corten::routes(state = crate::app::Shared, area = crate::support::csat::url::Csat, caller = crate::auth::Staff<crate::auth::PlatformFeedbackView>)]
pub mod url {
    use corten::{Fields, Route};
    use serde::Deserialize;

    /// The dashboard, filtered, on a page of its queue.
    #[derive(Clone, Debug, Default)]
    #[route("/support/csat", get = dashboard)]
    pub struct Csat {
        #[route(query)]
        pub filters: Filters,
    }

    /// The dashboard's filters (one value each, as admin-web's selects send) and the queue's page.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Filters {
        pub from: Option<String>,
        pub to: Option<String>,
        pub survey_version: Option<String>,
        pub outcome_codes: Option<String>,
        pub customer_roles: Option<String>,
        pub states: Option<String>,
        pub ratings: Option<String>,
        pub follow_up_consent: Option<String>,
        pub cursor: Option<String>,
        pub direction: Option<String>,
    }
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Csat>, shared: Shared) -> Area<url::Csat> {
    url::area(area, shared).components(views::CSAT)
}

/// The registered transactional CSAT survey version (`transactionalCsatV1`).
pub const SURVEY: &str = "csat.v1";
/// The workflow outcomes, in admin-web's order.
pub const OUTCOMES: [&str; 14] = [
    "checkout.completed",
    "checkout.recovered",
    "order.delivered",
    "return.resolved",
    "support.request-resolved",
    "reputation.review-received",
    "listing.published",
    "offer.accepted",
    "inventory.item-adjusted",
    "payout.completed",
    "discovery.search-completed",
    "registration.completed",
    "authentication.completed",
    "onboarding.completed",
];
pub const ROLES: [&str; 4] = ["buyer", "seller", "account", "visitor"];
pub const STATES: [&str; 6] = ["eligible", "issued", "presented", "submitted", "dismissed", "expired"];
pub const RATINGS: [&str; 5] = ["1", "2", "3", "4", "5"];
pub const CONSENTS: [&str; 2] = ["granted", "not-granted"];

/// A trailing window's or a trend bucket's figures (`CsatMetricSlice`), as far as the page shows them.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    #[serde(default)]
    pub csat: Option<f64>,
    pub csat_availability: String,
    #[serde(default)]
    pub response_rate: Option<f64>,
    pub response_rate_availability: String,
    #[serde(default)]
    pub rating_distribution: Map<String, Value>,
    pub volume: Volume,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Volume {
    pub submitted: u64,
    pub presented: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Windows {
    #[serde(rename = "trailing-7d")]
    pub seven: Slice,
    #[serde(rename = "trailing-30d")]
    pub thirty: Slice,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub bucket_start: String,
    #[serde(flatten)]
    pub slice: Slice,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Trend {
    pub items: Vec<Bucket>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    #[serde(default)]
    pub last_projected_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub as_of: String,
    pub windows: Windows,
    pub trend: Trend,
    pub health: Health,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct SurveyId {
    pub survey_version: String,
}

/// An invitation (`CsatAdminQueueItem`), as far as the page shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub invitation_id: String,
    pub state: String,
    pub survey_version: SurveyId,
    pub outcome_code: String,
    #[serde(default)]
    pub rating: Option<u8>,
    #[serde(default)]
    pub submitted_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub items: Vec<Invitation>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub previous_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Dashboard {
    pub analytics: Analytics,
    pub queue: Queue,
}

/// The page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct CsatScreen {
    /// The filters as read, each one admin-web offers (else none), without the page.
    pub filters: Chosen,
    /// The dashboard, or none when its read failed.
    pub dashboard: Option<Dashboard>,
}

/// The filters the page read with.
#[derive(Clone, Debug, Default, Serialize, ToJson)]
pub struct Chosen {
    pub from: Option<String>,
    pub to: Option<String>,
    pub survey_version: Option<String>,
    pub outcome: Option<String>,
    pub role: Option<String>,
    pub state: Option<String>,
    pub rating: Option<String>,
    pub consent: Option<String>,
}

impl Chosen {
    fn read(filters: &url::Filters) -> Self {
        let one = |value: &Option<String>, known: &[&str]| {
            value.as_deref().map(str::trim).filter(|v| known.contains(v)).map(str::to_owned)
        };
        Chosen {
            from: filters.from.as_deref().and_then(date),
            to: filters.to.as_deref().and_then(date),
            // admin-web's address says v1 for the registered version (chase-sets/chase-sets#10843).
            survey_version: one(
                &filters.survey_version.as_deref().map(|v| if v == "v1" { SURVEY.to_owned() } else { v.to_owned() }),
                &[SURVEY],
            ),
            outcome: one(&filters.outcome_codes, &OUTCOMES),
            role: one(&filters.customer_roles, &ROLES),
            state: one(&filters.states, &STATES),
            rating: one(&filters.ratings, &RATINGS),
            consent: one(&filters.follow_up_consent, &CONSENTS),
        }
    }

    /// The address of this filtering on another page of the queue, or on its first.
    pub fn at(&self, page: Option<(&str, &str)>) -> url::Csat {
        url::Csat {
            filters: url::Filters {
                from: self.from.clone(),
                to: self.to.clone(),
                survey_version: self.survey_version.clone(),
                outcome_codes: self.outcome.clone(),
                customer_roles: self.role.clone(),
                states: self.state.clone(),
                ratings: self.rating.clone(),
                follow_up_consent: self.consent.clone(),
                cursor: page.map(|(cursor, _)| cursor.to_owned()),
                direction: page.map(|(_, direction)| direction.to_owned()),
            },
        }
    }

    /// The API's query: each filter set, as admin-web sends it.
    fn query(&self, page: Option<(&str, &str)>) -> String {
        let pairs = [
            ("from", &self.from),
            ("to", &self.to),
            ("surveyVersion", &self.survey_version),
            ("outcomeCodes", &self.outcome),
            ("customerRoles", &self.role),
            ("states", &self.state),
            ("ratings", &self.rating),
            ("followUpConsent", &self.consent),
        ];
        let mut parts: Vec<String> =
            pairs.iter().filter_map(|(key, value)| value.as_ref().map(|v| format!("{key}={}", segment(v)))).collect();
        if let Some((cursor, direction)) = page {
            parts.push(format!("cursor={}", segment(cursor)));
            parts.push(format!("direction={direction}"));
        }
        parts.join("&")
    }
}

/// A date field's value (`YYYY-MM-DD`), else none.
fn date(value: &str) -> Option<String> {
    let value = value.trim();
    let b = value.as_bytes();
    (b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()))
        .then(|| value.to_owned())
}

async fn dashboard(
    req: Req,
    Caller(staff): Caller<Staff<PlatformFeedbackView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Csat>,
) -> HtmlResult {
    let filters = Chosen::read(&route.filters);
    let direction = if route.filters.direction.as_deref() == Some("previous") { "previous" } else { "next" };
    let page = route.filters.cursor.as_deref().filter(|c| !c.is_empty()).map(|cursor| (cursor, direction));
    let query = filters.query(page);
    let path = if query.is_empty() { BASE.to_owned() } else { format!("{BASE}?{query}") };
    let caller = config.platform.caller(&headers, config.proto, None);
    let (dashboard, status) = match caller.read::<Dashboard>(&path, CONTEXT).await {
        Ok(dashboard) => (Some(dashboard), StatusCode::OK),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN));
        }
        // The API answers a filter it refuses with 500 (chase-sets/chase-sets#10844): the filters
        // stay on the page so they can be changed.
        Err(error) => {
            tracing::warn!("the CSAT dashboard's read failed: {error}");
            (None, StatusCode::BAD_GATEWAY)
        }
    };
    let screen = CsatScreen { filters, dashboard };
    let t: Sup = req.t();
    let view = html! { <views::CsatPage t={t} p={req.t()} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.csat_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}
