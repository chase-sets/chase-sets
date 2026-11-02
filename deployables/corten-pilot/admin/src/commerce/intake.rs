//! Commerce > Return Intake (admin-web's `/commerce/return-intake`, Fulfillment's `FacilityIntakePage`):
//! a facility station. The operator opens their facility, scans a package, and either completes
//! its intake (custody, condition, photos, discrepancy, disposition) or, when the scan resolves
//! nothing, records it as unidentified; a package already received takes a correction. Below,
//! the station's figures, its queue and its unidentified packages, each with Reconcile. Read from
//! and written to Fulfillment's `/api/marketplace/operations/return-intake` as the signed-in staff
//! member: reading needs `return-intake.view`, writing `return-intake.manage`.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /commerce/return-intake?facilityId&identifier&result&after_write` | the station, with the scanned package |
//! | `POST /commerce/return-intake?facilityId&identifier` | an intake action (`intent`: complete, unidentified, reconcile, correct), then the station |
//!
//! Every form posts `multipart/form-data` (two carry photos), read with Corten's `Upload`; each
//! photo goes to the evidence endpoint before the intake that cites it, as admin-web sends them.
//!
//! Departures from admin-web:
//! - The scan and every write's redirect stay under `/commerce`; admin-web's leave it off and land on
//!   its not-found page (chase-sets/chase-sets#10856).
//! - The receipt time is read in the operator's time zone (`ClientZone`, UTC when unknown) and a time
//!   that cannot be read is refused; admin-web reads it in its server's zone and turns an unreadable
//!   one into now (chase-sets/chase-sets#10857).
//! - The unidentified-package form shows once a facility is open: without one the API refuses it.
use bytes::Bytes;
use corten::{
    ClientZone, Upload, UploadError,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Caller as ApiCaller, Method, segment},
    app::{Shared, sign_in},
    auth::{IntakeAccess, Staff, Viewer},
    catalog::form::new_id,
    text::{Com, Pilot},
};

const CONTEXT: &str = "fulfillment";
const BASE: &str = "/api/marketplace/operations/return-intake";
/// One photo's size, as the API takes it (`RETURN_INTAKE_EVIDENCE_MAX_BYTES`).
pub const PHOTO_BYTES: usize = 10 << 20;
/// How many photos one form may send.
pub const PHOTOS: usize = 10;

#[corten::routes(state = crate::app::Shared, area = crate::commerce::intake::url::Intake, caller = crate::auth::Staff<crate::auth::IntakeAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// The station's facility, the scanned package, what was just done, and the write's receipt.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[serde(rename_all = "camelCase")]
    #[route(query)]
    pub struct Station {
        pub facility_id: Option<String>,
        pub identifier: Option<String>,
        pub result: Option<String>,
        #[serde(rename = "after_write")]
        pub after_write: Option<String>,
    }

    /// The station; a `POST` is an intake action.
    #[derive(Clone, Debug, Default)]
    #[route("/commerce/return-intake", get = station, post = act)]
    pub struct Intake {
        #[route(query)]
        pub station: Station,
    }
}

/// The area: its route, its stylesheet and its script.
pub fn area(area: Area<url::Intake>, shared: Shared) -> Area<url::Intake> {
    url::area(area, shared).components(views::INTAKE)
}

/// What a scan found (`OperatorReturnShipmentView`), as far as the station shows it.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Shipment {
    pub return_shipment_id: String,
    pub order_id: String,
    pub status: String,
    #[serde(default)]
    pub tracking_identifier: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<String>,
    #[serde(default)]
    pub received_at: Option<String>,
    #[serde(default)]
    pub expected_items: Vec<ExpectedItem>,
    #[serde(default)]
    pub package_requirements: Option<Value>,
    #[serde(default)]
    pub destination_snapshot: Option<Value>,
    #[serde(default)]
    pub facility_intake: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct ExpectedItem {
    pub item_title: String,
    pub quantity: u64,
}

/// A completed intake's result (admin-web's `facilityIntakeSummary`).
pub struct IntakeSummary {
    pub custody_identifier: Option<String>,
    pub disposition: String,
}

impl Shipment {
    pub fn intake(&self) -> Option<IntakeSummary> {
        let intake = self.facility_intake.as_ref()?.as_object()?;
        let text = |key: &str| match &intake.get(key) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Null) | None => None,
            Some(other) => Some(other.to_string()),
        };
        Some(IntakeSummary {
            custody_identifier: text("custodyIdentifier"),
            disposition: text("disposition").unwrap_or_else(|| "completed".to_owned()),
        })
    }

    /// The expected items, "title × quantity; ..." (admin-web's `expectedItemSummary`).
    pub fn items(&self) -> Option<String> {
        (!self.expected_items.is_empty()).then(|| {
            self.expected_items.iter().map(|i| format!("{} \u{d7} {}", i.item_title, i.quantity)).collect::<Vec<_>>().join("; ")
        })
    }

    /// The package's weight and size (admin-web's `packageSummary`).
    pub fn package(&self) -> Option<String> {
        let p = self.package_requirements.as_ref().filter(|p| p.is_object())?;
        let v = |key: &str| match &p[key] {
            Value::Null => "\u{2014}".to_owned(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        Some(format!(
            "{} oz \u{b7} {} \u{d7} {} \u{d7} {} in",
            v("weightOunces"),
            v("lengthInches"),
            v("widthInches"),
            v("heightInches")
        ))
    }

    /// The destination's handling instructions (admin-web's `destinationInstructions`).
    pub fn handling(&self) -> Option<&str> {
        self.destination_snapshot.as_ref()?.get("displayInstructions")?.as_str()
    }
}

/// An unidentified package (`UnidentifiedReturnPackageView`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Unidentified {
    pub unidentified_package_id: String,
    pub custody_identifier: String,
    pub received_at: String,
    pub package_condition: String,
    #[serde(default)]
    pub return_shipment_id: Option<String>,
}

/// The station's figures (`ReturnIntakeMetrics`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Metrics {
    pub delivered_not_intaken_count: u64,
    pub oldest_delivered_not_intaken_age_seconds: f64,
    pub discrepancy_rate: f64,
    pub unidentified_package_count: u64,
    pub duplicate_scan_count: u64,
    pub average_intake_latency_seconds: f64,
}

#[derive(Deserialize)]
struct Queue {
    items: Vec<Shipment>,
    unidentified: Vec<Unidentified>,
    metrics: Metrics,
}

#[derive(Deserialize)]
struct Resolution {
    shipment: Shipment,
    version: Option<u64>,
}

/// A duration as admin-web's `formatDuration` writes it: seconds, minutes or hours.
pub fn duration(seconds: f64) -> String {
    if seconds < 60.0 {
        format!("{}s", seconds.round())
    } else if seconds < 3600.0 {
        format!("{}m", (seconds / 60.0).round())
    } else {
        format!("{}h", (seconds / 3600.0).round())
    }
}

/// The station as drawn: its facility, figures, queues, the scanned package, and what the last
/// action did.
#[derive(Serialize, ToJson)]
pub struct StationScreen {
    pub facility_id: String,
    pub identifier: String,
    pub queue: Vec<Shipment>,
    pub unidentified: Vec<Unidentified>,
    pub metrics: Metrics,
    pub resolved: Option<Shipment>,
    pub expected_version: Option<u64>,
    /// This form's idempotency key (admin-web's `formToken`).
    pub form_token: String,
    /// Why the last action was not saved.
    pub error: Option<String>,
    /// What the last action did (completed, duplicate, unidentified, reconciled, corrected).
    pub result: Option<String>,
    /// That the queue was read without the write's receipt, which it had not caught up to.
    pub catching_up: bool,
}

const RESULTS: [&str; 5] = ["completed", "duplicate", "unidentified", "reconciled", "corrected"];

async fn station(
    req: Req,
    Caller(staff): Caller<Staff<IntakeAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Intake>,
) -> HtmlResult {
    let route = route.station;
    let result = route.result.as_deref().filter(|r| RESULTS.contains(r)).map(str::to_owned);
    let receipt = Receipt::from_param(route.after_write.as_deref());
    draw(&req, &staff.viewer, &config, &headers, &route, receipt, None, result, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    route: &url::Station,
    receipt: Option<Receipt>,
    error: Option<String>,
    result: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let facility_id = route.facility_id.as_deref().unwrap_or_default().trim().to_owned();
    let identifier = route.identifier.as_deref().unwrap_or_default().trim().to_owned();
    let mut screen = StationScreen {
        facility_id,
        identifier,
        queue: Vec::new(),
        unidentified: Vec::new(),
        metrics: Metrics::default(),
        resolved: None,
        expected_version: None,
        form_token: new_id("rii"),
        error,
        result,
        catching_up: false,
    };
    if !screen.facility_id.is_empty() {
        let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
        let facility = segment(&screen.facility_id);
        let queue_path = format!("{BASE}?facilityId={facility}");
        let resolve_path = format!("{BASE}/resolve?identifier={}&facilityId={facility}", segment(&screen.identifier));
        let resolve = async {
            if screen.identifier.is_empty() { None } else { Some(caller.read::<Resolution>(&resolve_path, CONTEXT).await) }
        };
        let (queue, resolution) = tokio::join!(caller.read::<Queue>(&queue_path, CONTEXT), resolve);
        let queue = match queue {
            Ok(queue) => queue,
            Err(error) if receipt.is_some() && error.catching_up() => {
                screen.catching_up = true;
                let plain = config.platform.caller(headers, config.proto, None);
                match plain.read::<Queue>(&queue_path, CONTEXT).await {
                    Ok(queue) => queue,
                    Err(error) => return crate::app::read_failed(req, error, false),
                }
            }
            Err(error) => return crate::app::read_failed(req, error, false),
        };
        screen.queue = queue.items;
        screen.unidentified = queue.unidentified;
        screen.metrics = queue.metrics;
        match resolution {
            None => {}
            Some(Ok(found)) => {
                screen.resolved = Some(found.shipment);
                screen.expected_version = found.version;
            }
            // Not found, or more than one: admin-web offers the unidentified form.
            Some(Err(error)) if matches!(error.status(), Some(StatusCode::NOT_FOUND | StatusCode::CONFLICT)) => {}
            Some(Err(error)) => return crate::app::read_failed(req, error, false),
        }
    }
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let view = html! { <views::IntakePage t={t} p={p} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.ri_route_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// An intake action's fields (admin-web's form names); `evidence` is the photo input.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct IntakeForm {
    pub intent: String,
    pub facility_id: String,
    pub return_shipment_id: String,
    pub expected_version: String,
    pub idempotency_key: String,
    pub station_id: String,
    pub received_at: String,
    pub package_condition: String,
    pub seal_condition: String,
    pub measured_weight_ounces: String,
    pub custody_identifier: String,
    pub discrepancy_type: String,
    pub disposition: String,
    pub expected_item_reference: String,
    pub observed_item_reference: String,
    pub quantity: String,
    pub owner: String,
    pub next_action: String,
    pub notes: String,
    pub unidentified_package_id: String,
    pub reason: String,
    pub evidence: Files,
}

/// A photo the form sent.
pub struct Photo {
    pub filename: String,
    pub content_type: String,
    pub bytes: Bytes,
}

/// The posted form and its photos; `None` photos when one was over its size or past the count.
async fn read(mut upload: Upload<IntakeForm>) -> Result<(IntakeForm, Option<Vec<Photo>>), UploadError> {
    upload.limit(PHOTOS * PHOTO_BYTES + (1 << 20));
    let field = IntakeForm::FIELDS.evidence;
    let (mut photos, mut over) = (Vec::new(), false);
    while let Some(mut file) = upload.next_file().await? {
        if !file.is(field) {
            continue;
        }
        if photos.len() == PHOTOS {
            over = true;
            continue;
        }
        let filename = file.filename().to_owned();
        let content_type = file.content_type().split(';').next().unwrap_or_default().trim().to_owned();
        match file.bytes_up_to(PHOTO_BYTES).await? {
            Some(bytes) => photos.push(Photo { filename, content_type, bytes }),
            None => over = true,
        }
    }
    let form = upload.fields().await?;
    Ok((form, (!over).then_some(photos)))
}

/// A receipt time (`datetime-local`: a wall-clock time without a zone) as the instant it is in
/// `zone` (chase-sets/chase-sets#10857); `None` when it cannot be read.
pub fn instant(local: &str, zone: &jiff::tz::TimeZone) -> Option<String> {
    let civil: jiff::civil::DateTime = local.trim().parse().ok()?;
    Some(civil.to_zoned(zone.clone()).ok()?.timestamp().to_string())
}

/// What the station says when an action is refused, and its status.
fn refusal(t: Com, error: &ApiError) -> (String, StatusCode) {
    match error.status() {
        Some(StatusCode::CONFLICT) => (t.ri_route_stale().to_owned(), StatusCode::CONFLICT),
        Some(status) if status.is_client_error() => {
            (error.refusal().unwrap_or(t.ri_route_failed()).to_owned(), StatusCode::UNPROCESSABLE_ENTITY)
        }
        _ => (t.ri_route_failed().to_owned(), StatusCode::BAD_GATEWAY),
    }
}

/// Why an action stopped before it was saved.
enum Stop {
    /// Draw the station again with this banner and status.
    Refused(String, StatusCode),
    /// The session ended: sign in.
    SignIn,
}

impl Stop {
    fn api(t: Com, error: ApiError) -> Stop {
        if error.status() == Some(StatusCode::UNAUTHORIZED) {
            return Stop::SignIn;
        }
        let (message, status) = refusal(t, &error);
        if status == StatusCode::BAD_GATEWAY {
            tracing::warn!("a return intake action failed: {error}");
        }
        Stop::Refused(message, status)
    }
}

/// Each photo sent to the evidence endpoint, in order: the attachments the intake cites. Until
/// chase-sets/chase-sets#10860 the API answers every upload 503, which the station shows as a failure.
async fn upload_photos(caller: &ApiCaller<'_>, t: Com, facility_id: &str, photos: Vec<Photo>) -> Result<Vec<Value>, Stop> {
    let mut attachments = Vec::with_capacity(photos.len());
    for photo in photos {
        let part = reqwest::multipart::Part::stream(photo.bytes)
            .file_name(photo.filename)
            .mime_str(&photo.content_type)
            .map_err(|_| Stop::Refused(t.ri_route_failed().to_owned(), StatusCode::UNPROCESSABLE_ENTITY))?;
        let form = reqwest::multipart::Form::new().text("facilityId", facility_id.to_owned()).part("evidence", part);
        let request = caller.request(Method::POST, &format!("{BASE}/evidence"), CONTEXT).multipart(form);
        let (answer, _) = caller.write::<Value>(request).await.map_err(|error| Stop::api(t, error))?;
        attachments.push(answer["attachment"].clone());
    }
    Ok(attachments)
}

fn text_or_null(value: &str) -> Value {
    let value = value.trim();
    if value.is_empty() { Value::Null } else { Value::String(value.to_owned()) }
}

fn number_or_null(value: &str) -> Value {
    value.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
}

/// Runs an intent: its API calls and the result the station then reports.
async fn run(
    caller: &ApiCaller<'_>,
    t: Com,
    p: Pilot,
    zone: &jiff::tz::TimeZone,
    form: &IntakeForm,
    photos: Vec<Photo>,
) -> Result<(&'static str, Option<Receipt>), Stop> {
    let facility_id = form.facility_id.trim();
    let received_at = || {
        instant(&form.received_at, zone)
            .ok_or_else(|| Stop::Refused(p.check_received_at().to_owned(), StatusCode::UNPROCESSABLE_ENTITY))
    };
    let expected_version = form.expected_version.trim().parse::<u64>().ok();
    let post = |path: String, body: Value| caller.request(Method::POST, &path, CONTEXT).json(&body);
    match form.intent.as_str() {
        "complete" => {
            let received_at = received_at()?;
            let evidence = upload_photos(caller, t, facility_id, photos).await?;
            let ids: Vec<Value> = evidence.iter().map(|a| a["attachmentId"].clone()).collect();
            let quantity = form.quantity.trim().parse::<u64>().unwrap_or(1);
            let body = json!({
                "facilityId": facility_id,
                "stationId": form.station_id.trim(),
                "receivedAt": received_at,
                "packageCondition": form.package_condition.trim(),
                "sealCondition": form.seal_condition.trim(),
                "measuredWeightOunces": number_or_null(&form.measured_weight_ounces),
                "evidence": evidence,
                "discrepancies": [{
                    "type": form.discrepancy_type.trim(),
                    "expectedItemReference": text_or_null(&form.expected_item_reference),
                    "observedItemReference": text_or_null(&form.observed_item_reference),
                    "quantity": quantity,
                    "notes": text_or_null(&form.notes),
                    "evidenceAttachmentIds": ids,
                    "owner": form.owner.trim(),
                    "nextAction": form.next_action.trim(),
                }],
                "disposition": form.disposition.trim(),
                "custodyIdentifier": form.custody_identifier.trim(),
                "idempotencyKey": form.idempotency_key.trim(),
                "expectedVersion": expected_version,
            });
            let path = format!("{BASE}/{}/complete", segment(form.return_shipment_id.trim()));
            let (answer, receipt) = caller.write::<Value>(post(path, body)).await.map_err(|error| Stop::api(t, error))?;
            Ok((if answer["duplicate"] == Value::Bool(true) { "duplicate" } else { "completed" }, receipt))
        }
        "unidentified" => {
            let received_at = received_at()?;
            let evidence = upload_photos(caller, t, facility_id, photos).await?;
            let body = json!({
                "facilityId": facility_id,
                "stationId": form.station_id.trim(),
                "receivedAt": received_at,
                "packageCondition": form.package_condition.trim(),
                "sealCondition": form.seal_condition.trim(),
                "measuredWeightOunces": number_or_null(&form.measured_weight_ounces),
                "evidence": evidence,
                "custodyIdentifier": form.custody_identifier.trim(),
                "notes": text_or_null(&form.notes),
                "owner": form.owner.trim(),
                "nextAction": form.next_action.trim(),
            });
            let (_, receipt) =
                caller.write::<Value>(post(format!("{BASE}/unidentified"), body)).await.map_err(|error| Stop::api(t, error))?;
            Ok(("unidentified", receipt))
        }
        "reconcile" => {
            let path = format!("{BASE}/unidentified/{}/reconcile", segment(form.unidentified_package_id.trim()));
            let body = json!({ "returnShipmentId": form.return_shipment_id.trim(), "reason": form.reason.trim() });
            let (_, receipt) = caller.write::<Value>(post(path, body)).await.map_err(|error| Stop::api(t, error))?;
            Ok(("reconciled", receipt))
        }
        "correct" => {
            let path = format!("{BASE}/{}/corrections", segment(form.return_shipment_id.trim()));
            let body = json!({
                "facilityId": facility_id,
                "expectedVersion": expected_version,
                "correctionId": new_id("ric"),
                "reason": form.reason.trim(),
                "owner": text_or_null(&form.owner),
                "nextAction": text_or_null(&form.next_action),
                "custodyIdentifier": text_or_null(&form.custody_identifier),
            });
            let (_, receipt) = caller.write::<Value>(post(path, body)).await.map_err(|error| Stop::api(t, error))?;
            Ok(("corrected", receipt))
        }
        _ => Err(Stop::Refused(t.ri_route_choose_action().to_owned(), StatusCode::UNPROCESSABLE_ENTITY)),
    }
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<IntakeAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Intake>,
    upload: Upload<IntakeForm>,
) -> HtmlResult {
    let (t, p): (Com, Pilot) = (req.t(), req.t());
    let route = route.station;
    let refused = |message: String, status: StatusCode| {
        draw(&req, &staff.viewer, &config, &headers, &route, None, Some(message), None, status)
    };
    let (form, photos) = match read(upload).await {
        Ok((form, Some(photos))) => (form, photos),
        Ok((_, None)) | Err(UploadError::TooLarge { .. }) => {
            return refused(p.check_evidence_too_large().to_owned(), StatusCode::PAYLOAD_TOO_LARGE).await;
        }
        Err(other) => return Err(other.into()),
    };
    let zone = zone.and_then(|ClientZone(name)| jiff::tz::TimeZone::get(&name).ok()).unwrap_or(jiff::tz::TimeZone::UTC);
    let caller = config.platform.caller(&headers, config.proto, None);
    match run(&caller, t, p, &zone, &form, photos).await {
        Ok((result, receipt)) => {
            // The station again, as admin-web redirects: the facility, without the scan.
            let facility_id = Some(form.facility_id.trim().to_owned()).filter(|f| !f.is_empty());
            let station = url::Station {
                facility_id,
                identifier: None,
                result: Some(result.to_owned()),
                after_write: receipt.map(|r| r.param()),
            };
            let to = url::Intake { station };
            req.redirect(&to)
        }
        Err(Stop::SignIn) => sign_in(&req),
        Err(Stop::Refused(message, status)) => refused(message, status).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_time_is_read_in_the_operators_zone() {
        let chicago = jiff::tz::TimeZone::get("America/Chicago").unwrap();
        assert_eq!(instant("2026-10-30T14:05", &chicago).as_deref(), Some("2026-10-30T19:05:00Z"));
        assert_eq!(instant("2026-10-30T14:05", &jiff::tz::TimeZone::UTC).as_deref(), Some("2026-10-30T14:05:00Z"));
        assert_eq!(instant("not a time", &chicago), None);
        assert_eq!(instant("", &chicago), None);
    }

    #[test]
    fn durations_read_as_admin_webs() {
        assert_eq!(duration(42.4), "42s");
        assert_eq!(duration(150.0), "3m");
        assert_eq!(duration(7200.0), "2h");
    }
}
