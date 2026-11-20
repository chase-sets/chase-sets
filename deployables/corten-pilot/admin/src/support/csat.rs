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
//! | `POST /support/csat/export?<the filters>` | the filtered queue as the API's CSV (`reason`) |
//!
//! A filter the API refuses (400 `validation_failed`) keeps the filters on the page with the API's
//! reason (400), as admin-web does; any other failed read keeps them with a banner (502).
//!
//! Export is offered, as admin-web offers it, to staff who hold the export grant: a reason (Case
//! review or Quality review) and the dashboard's filters. admin-web's script asks the API to create
//! the export, then downloads it; here the form posts to the pilot, which does both and relays the
//! file, so it works without a script.
//!
//! Departures from admin-web:
//! - The filter form does not carry the read's `asOf` back, so a later `To` is not refused for
//!   being after a stale `asOf`.
//! - Export answers the file itself rather than a status line beside the button.
use corten::{
    Relay,
    http::{Body, HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::views;
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, sign_in, sign_in_at},
    auth::{CsatAccess, Staff},
    text::Sup,
};

const CONTEXT: &str = "customer-feedback";
const BASE: &str = "/api/customer-feedback";

#[corten::routes(state = crate::app::Shared, area = crate::support::csat::url::Csat, caller = crate::auth::Staff<crate::auth::CsatAccess>)]
pub mod url {
    use corten::{Fields, Route};

    /// The dashboard, filtered, on a page of its queue.
    #[derive(Clone, Debug, Default)]
    #[route("/support/csat", get = dashboard)]
    pub struct Csat {
        #[route(query)]
        pub filters: Filters,
    }

    /// The dashboard's filtered queue as CSV: a `POST`, since the API audits each export.
    #[derive(Clone, Debug, Default)]
    #[route("/support/csat/export", post = export)]
    pub struct Export {
        #[route(query)]
        pub filters: Filters,
    }

    /// The dashboard's filters (one value each, as admin-web's selects send) and the queue's page.
    #[derive(Clone, Debug, Default, Fields, Route)]
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

/// The grant the export needs (`privacyPermission("export-sensitive-feedback")`).
pub const EXPORT: &str = "customer-feedback.privacy.export-sensitive-feedback";
/// The export reasons admin-web offers, in its order.
pub const EXPORT_REASONS: [&str; 2] = ["case-review", "quality-review"];

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
/// Why Customer Feedback refuses a dashboard query (`csatQueryRefusalReasons`).
pub const REFUSALS: [&str; 11] = [
    "timestamp-invalid",
    "range-order",
    "range-after-as-of",
    "range-too-long",
    "history-too-long",
    "survey-version-unregistered",
    "granularity-unsupported",
    "page-size-invalid",
    "minimum-sample-size-invalid",
    "cursor-invalid",
    "filter-empty",
];

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
    /// Why the API refused the filters (one of [`REFUSALS`]), when it did.
    pub refused: Option<String>,
    /// Whether the viewer may export (holds [`EXPORT`]).
    pub can_export: bool,
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
            survey_version: one(&filters.survey_version, &[SURVEY]),
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

/// The export's form: why the export is made (one of [`EXPORT_REASONS`]).
#[derive(Clone, Debug, Default, Fields)]
#[serde(default)]
pub struct ExportForm {
    pub reason: String,
}

/// The export's answer when it cannot be the file: sign in again, back to the dashboard.
fn sign_in_again(path: &str) -> corten::Result<Relay> {
    let to = sign_in_at(path).ok_or_else(|| corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR))?;
    let mut kept = HeaderMap::new();
    kept.insert(header::LOCATION, HeaderValue::from_str(&to.to_string()).map_err(corten::Error::new)?);
    Ok(Relay::new(StatusCode::SEE_OTHER, kept, Body::empty()))
}

/// The filtered queue as the API's CSV: the API creates the export (and its audit) for the reason,
/// then the file is downloaded and relayed with its type and name, never cached.
async fn export(
    Caller(staff): Caller<Staff<CsatAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Export>,
    Form(form): Form<ExportForm>,
) -> corten::Result<Relay> {
    let back = Chosen::read(&route.filters);
    let reason = form.reason.trim();
    // admin-web's button cannot be pressed without a reason.
    if !EXPORT_REASONS.contains(&reason) {
        let mut kept = HeaderMap::new();
        kept.insert(header::LOCATION, HeaderValue::from_str(&back.at(None).href()).map_err(corten::Error::new)?);
        return Ok(Relay::new(StatusCode::SEE_OTHER, kept, Body::empty()));
    }
    debug_assert!(staff.viewer.can(EXPORT), "the area's rule asks for the export grant on a POST");
    let query = back.query(None);
    let path = if query.is_empty() {
        format!("{BASE}/export?reason={reason}")
    } else {
        format!("{BASE}/export?{query}&reason={reason}")
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let gateway = |error: reqwest::Error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY);
    let created = caller.request(Method::GET, &path, CONTEXT).send().await.map_err(gateway)?;
    match created.status().as_u16() {
        201 => {}
        401 => return sign_in_again(&back.at(None).href()),
        403 => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        status => {
            tracing::warn!("the CSAT export answered {status}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Created {
        export_id: String,
    }
    let Created { export_id } = created.json().await.map_err(gateway)?;
    let file =
        caller.request(Method::GET, &format!("{BASE}/export/{}", segment(&export_id)), CONTEXT).send().await.map_err(gateway)?;
    match file.status().as_u16() {
        200 => {}
        401 => return sign_in_again(&back.at(None).href()),
        403 => return Err(corten::Error::status(StatusCode::FORBIDDEN)),
        status => {
            tracing::warn!("the CSAT export's download answered {status}");
            return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
        }
    }
    let mut kept = HeaderMap::new();
    for name in ["content-type", "content-disposition"] {
        if let Some(value) = file.headers().get(name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
            kept.insert(HeaderName::from_static(name), value);
        }
    }
    kept.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let bytes = file.bytes().await.map_err(gateway)?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

/// The dashboard, or the reason Customer Feedback refused its filters (a 400 `validation_failed`
/// with a reason in [`REFUSALS`]); any other failure is an error.
async fn read(caller: &ApiCaller<'_>, path: &str) -> Result<Result<Dashboard, String>, ApiError> {
    let res = caller.request(Method::GET, path, CONTEXT).send().await?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_success() {
        return Ok(Ok(res.json().await?));
    }
    #[derive(Deserialize, Default)]
    struct Refused {
        #[serde(default)]
        error: Reason,
    }
    #[derive(Deserialize, Default)]
    struct Reason {
        code: Option<String>,
        reason: Option<String>,
        #[serde(default)]
        message: String,
    }
    let body: Refused = res.json().await.unwrap_or_default();
    match body.error {
        Reason { code: Some(code), reason: Some(reason), .. }
            if status == StatusCode::BAD_REQUEST && code == "validation_failed" && REFUSALS.contains(&reason.as_str()) =>
        {
            Ok(Err(reason))
        }
        Reason { code, message, .. } => Err(ApiError::Status { status, code, message }),
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
    Caller(staff): Caller<Staff<CsatAccess>>,
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
    let (dashboard, refused, status) = match read(&caller, &path).await {
        Ok(Ok(dashboard)) => (Some(dashboard), None, StatusCode::OK),
        Ok(Err(reason)) => (None, Some(reason), StatusCode::BAD_REQUEST),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN));
        }
        // The filters stay on the page so they can be changed.
        Err(error) => {
            tracing::warn!("the CSAT dashboard's read failed: {error}");
            (None, None, StatusCode::BAD_GATEWAY)
        }
    };
    let screen = CsatScreen { filters, dashboard, refused, can_export: staff.viewer.can(EXPORT) };
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
