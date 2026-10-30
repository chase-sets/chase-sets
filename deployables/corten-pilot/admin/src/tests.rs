//! Router tests against a stand-in platform API: who may see the screen, what the pilot forwards
//! to the API, and how each answer of the API becomes a page, a patch or a redirect.
use std::sync::{Arc, Mutex};

use corten::axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{
    api::Platform,
    app::{Config, app},
    form::default_payload,
};

const POLICIES: &str = "/api/marketplace/admin/postage-policies";
const RECEIPT: &str = r#"[{"sourceContextName":"ordering","maxGlobalPosition":"42","eventIds":["e1"]}]"#;

/// A call the stand-in received.
#[derive(Clone, Debug)]
struct Call {
    method: Method,
    path: String,
    headers: HeaderMap,
    body: String,
}

type Calls = Arc<Mutex<Vec<Call>>>;

fn policy(id: &str, label: &str, status: &str) -> Value {
    json!({
        "policy_id": id,
        "label": label,
        "status": status,
        "policy_version": "default-postage-policy-v2",
        "payload": default_payload(),
        "effective_from": "2026-01-01T00:00:00.000Z",
        "effective_until": null,
        "activation_reason": null,
        "updated_at": "2026-01-01T00:00:00.000Z",
        "activated_at": null,
        "history": [],
        "activeComparison": [],
    })
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

fn written(status: StatusCode, id: &str) -> Response {
    let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
    (status, headers, Json(json!({ "id": id, "version": 2 }))).into_response()
}

/// The platform API, as far as the screen uses it. The session cookie's value says who is
/// asking: `staff` may see the screen, `reader` may not, `down` makes the lookup fail.
async fn platform(State(calls): State<Calls>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    calls.lock().unwrap().push(Call {
        method: method.clone(),
        path: uri.to_string(),
        headers: headers.clone(),
        body: body.clone(),
    });
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if uri.path() == "/api/auth/session" {
        let actor = |permissions: &[&str]| {
            Json(json!({ "actor": { "userId": "usr_1", "accountId": "acc_platform", "roleKey": "platform_admin", "permissions": permissions } }))
                .into_response()
        };
        return if cookie.contains("chase_sets_session=staff") {
            actor(&["postage-policies.view", "catalog.view", "catalog.manage"])
        } else if cookie.contains("chase_sets_session=catalog-reader")
            || cookie.contains("chase_sets_session=catalog-viewer")
            || cookie.contains("chase_sets_session=queue-down")
        {
            actor(&["catalog.view"])
        } else if cookie.contains("chase_sets_session=projections-operator") {
            actor(&[
                "projection-operations.view",
                "projection-operations.operate",
                "projection-operations.rebuild",
                "catalog.view",
                "accounts.view",
            ])
        } else if cookie.contains("chase_sets_session=ops") || cookie.contains("chase_sets_session=projections-") {
            actor(&["projection-operations.view"])
        } else if cookie.contains("chase_sets_session=reader") {
            actor(&[])
        } else if cookie.contains("chase_sets_session=down") {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        } else {
            refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in.")
        };
    }
    if uri.path() == "/api/realtime/public/events" {
        return realtime(cookie);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/platform/projections") {
        return projections_api(&method, rest, cookie, &body);
    }
    if uri.path() == "/api/platform/operations-attention" {
        return operations_attention(cookie);
    }
    if uri.path() == "/api/catalog/scope-records" {
        return scope_records(uri.query().unwrap_or_default());
    }
    if let Some(answer) = scope_api(&method, uri.path(), uri.query().unwrap_or_default(), &body) {
        return answer;
    }
    if let Some(rest) = uri.path().strip_prefix("/api/catalog/attention-queue") {
        return attention_queue(method, rest, cookie, &headers, &body);
    }
    if uri.path() == "/api/catalog/alias-review/commands" {
        return written(StatusCode::OK, "alias");
    }
    if let Some(rest) = uri.path().strip_prefix(CATALOG) {
        return catalog_api(method, rest, &headers, &body);
    }
    let Some(rest) = uri.path().strip_prefix(POLICIES) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match (method, rest) {
        (Method::GET, "") => {
            Json(json!({ "items": [policy("opp_seed", "Default postage policy", "active")], "total": 1 })).into_response()
        }
        (Method::GET, "/opp_pending") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, id) => Json(policy(&id[1..], "Smoke draft", "draft")).into_response(),
        (Method::POST, "") if body.contains(r#""label":"Refused""#) => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "Effective until must be after effective from.")
        }
        (Method::POST, "") => written(StatusCode::CREATED, "opp_new"),
        (Method::POST, "/opp_seed/activate") => written(StatusCode::OK, "opp_seed"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The pilot, in front of a stand-in API on a loopback port.
struct Pilot {
    router: Router,
    calls: Calls,
}

impl Pilot {
    async fn new() -> Self {
        let calls = Calls::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stand_in = Router::new().fallback(platform).with_state(calls.clone());
        tokio::spawn(async move { corten::axum::serve(listener, stand_in).await.unwrap() });
        let router = app(Config { platform: Platform::new(&origin), proto: "http" }).router();
        Pilot { router, calls }
    }

    async fn send(&self, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
    }

    /// The calls to the policies API (the session lookups left out).
    fn policy_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(POLICIES)).cloned().collect()
    }
}

fn get(uri: &str, session: Option<&str>) -> Request<Body> {
    let mut req = Request::get(uri).header(header::HOST, "localhost:7790");
    if let Some(session) = session {
        req = req.header(header::COOKIE, format!("chase_sets_session={session}"));
    }
    req.body(Body::empty()).unwrap()
}

/// A form post as the runtime sends it (`corten: action`), or as a browser without JavaScript.
fn post(uri: &str, body: &str, script: bool) -> Request<Body> {
    post_as("staff", uri, body, script)
}

fn post_as(session: &str, uri: &str, body: &str, script: bool) -> Request<Body> {
    let mut req = Request::post(uri)
        .header(header::HOST, "localhost:7790")
        .header(header::COOKIE, format!("chase_sets_session={session}"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if script {
        req = req.header("corten", "action");
    }
    req.body(Body::from(body.to_owned())).unwrap()
}

/// A create form's body with `label` and every rule filled in.
fn create_body(label: &str, max_letter_units: &str) -> String {
    format!(
        "label={label}&effective_from=2026-01-01T00%3A00%3A00.000Z&effective_until=&policy_version=default-postage-policy-v2\
         &max_letter_units={max_letter_units}&max_letter_weight_ounces=3.5&max_letter_thickness_inches=0.25\
         &max_letter_declared_value_amount=50&letter_envelope_weight_ounces=0.4&parcel_packaging_weight_ounces=2\
         &parcel_required_shipping_options=priority"
    )
}

fn fresh_receipt() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let receipt = format!(r#"{{"observedAtMs":{now},"commitPosition":"42","sources":{RECEIPT}}}"#);
    percent_encoding::utf8_percent_encode(&receipt, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[tokio::test]
async fn a_signed_out_visitor_signs_in_through_admin_web() {
    let pilot = Pilot::new().await;
    for session in [None, Some("expired")] {
        let (status, headers, _) = pilot.send(get("/commerce/postage-policies", session)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{session:?}");
        assert_eq!(
            headers[header::LOCATION],
            "http://localhost:7752/access/sign-in?returnTo=%2Fcommerce%2Fpostage-policies",
            "{session:?}"
        );
    }
    assert!(pilot.policy_calls().is_empty(), "nothing is read for a visitor who is not signed in");
}

#[tokio::test]
async fn staff_without_the_permission_are_refused_and_an_unreachable_session_is_not_signed_out() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(html.contains("Your role cannot open this page.") && html.contains("<header"), "drawn with the reader's nav: {html}");
    // Corten's `Refused::unavailable`: a 503, not a sign-in, in its own words (not a screen's
    // "preparing your change") and with no nav, since no one could be read.
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("down"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a failed lookup must not send the user to sign in again");
    assert!(html.contains("We could not check who you are.") && !html.contains("<header"), "{html}");
    assert!(pilot.policy_calls().is_empty());
}

#[tokio::test]
async fn an_unknown_address_is_drawn_for_who_is_asking() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/nowhere", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("There is nothing at this address.") && html.contains("<header"), "with the staff nav: {html}");
    let (status, _, html) = pilot.send(get("/commerce/nowhere", None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an unknown address is not a sign-in");
    assert!(!html.contains("<header"), "no one, no nav: {html}");
}

#[tokio::test]
async fn the_list_renders_for_staff_and_data_clients_get_the_screen() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("<h1>Postage Policies</h1>"), "{html}");
    assert!(html.contains("Default postage policy"), "{html}");
    assert!(html.contains(r#"href="/commerce/postage-policies" aria-current="page""#), "{html}");

    let mut req = get("/commerce/postage-policies?policy=opp_seed", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["policies"]["items"][0]["policy_id"], "opp_seed", "{body}");
    assert_eq!(screen["data"]["selected"]["policy_id"], "opp_seed", "{body}");

    let calls = pilot.policy_calls();
    assert!(calls.iter().all(|c| c.headers["chase-sets-read-target-context"] == "ordering"), "{calls:?}");
    assert!(calls.iter().all(|c| c.headers["x-forwarded-host"] == "localhost:7790"), "{calls:?}");
    assert!(calls.iter().all(|c| c.headers[header::COOKIE] == "chase_sets_session=staff"), "{calls:?}");
    assert!(calls.iter().all(|c| !c.headers.contains_key("chase-sets-read-after-write")), "no write, no receipt: {calls:?}");
}

#[tokio::test]
async fn the_apis_refusal_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post("/commerce/postage-policies", &create_body("Refused", "8"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"), "a patch of the form: {headers:?}");
    assert!(html.starts_with(r#"<form class="policy-fields__form" id="create-form""#), "{html}");
    assert!(html.contains(r#"<p class="form-error" role="alert">Effective until must be after effective from.</p>"#), "{html}");
    assert!(html.contains(r#"value="Refused""#), "what was typed stays: {html}");

    // Without JavaScript the same refusal is the whole page, with the form in it.
    let (status, _, html) = pilot.send(post("/commerce/postage-policies", &create_body("Refused", "8"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("Effective until must be after effective from."), "{html}");
}

#[tokio::test]
async fn the_pilots_own_check_names_the_field_and_calls_nothing() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", ""), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="create-form-max_letter_units-error""#) && html.contains(r#"aria-invalid="true""#), "{html}");
    assert!(
        html.contains(r#"</label><p class="field-error" id="create-form-max_letter_units-error">"#),
        "the error is not in the label: {html}"
    );
    assert!(!pilot.policy_calls().iter().any(|c| c.method == Method::POST), "nothing is sent to the API");
}

#[tokio::test]
async fn an_accepted_write_redirects_to_the_policy_with_its_receipt() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", "8"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/commerce/postage-policies?policy=opp_new&after_write="), "{to}");
    let sent = pilot.policy_calls().into_iter().find(|c| c.method == Method::POST).unwrap();
    let body: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!((body["label"].as_str(), body["maxLetterUnits"].as_f64()), (Some("Draft"), Some(8.0)), "{body}");

    let (status, headers, _) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", "8"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION].to_str().unwrap().split("&after_write=").next(), to.split("&after_write=").next());
}

#[tokio::test]
async fn the_read_after_a_write_sends_the_receipt_and_waits_for_it() {
    let pilot = Pilot::new().await;
    let receipt = fresh_receipt();
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_new&after_write={receipt}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    let reads = pilot.policy_calls();
    assert_eq!(reads.len(), 2, "the list and the sheet: {reads:?}");
    for read in &reads {
        let sent = read.headers["chase-sets-read-after-write"].to_str().unwrap();
        let sent: Value = serde_json::from_str(&percent_encoding::percent_decode_str(sent).decode_utf8().unwrap()).unwrap();
        assert_eq!(sent["commitPosition"], "42", "{sent}");
        assert_eq!(sent["sources"], serde_json::from_str::<Value>(RECEIPT).unwrap(), "{sent}");
    }

    // The write's projection is not readable yet: "preparing", as admin-web answers.
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_pending&after_write={receipt}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    // Without a write before it, the same answer is the API failing.
    let (status, _, _) = pilot.send(get("/commerce/postage-policies?policy=opp_pending", Some("staff"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_stale_receipt_is_not_sent() {
    let pilot = Pilot::new().await;
    let old = format!(r#"{{"observedAtMs":1000,"commitPosition":"42","sources":{RECEIPT}}}"#);
    let old = percent_encoding::utf8_percent_encode(&old, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_new&after_write={old}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(pilot.policy_calls().iter().all(|c| !c.headers.contains_key("chase-sets-read-after-write")));
}

#[tokio::test]
async fn activation_sends_the_reason_or_asks_for_one() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/commerce/postage-policies/opp_seed/activate", "label=Default&activation_reason=Reviewed", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().starts_with("/commerce/postage-policies?policy=opp_seed&after_write="));
    let sent = pilot.policy_calls().into_iter().find(|c| c.method == Method::POST).unwrap();
    assert_eq!(sent.path, format!("{POLICIES}/opp_seed/activate"));
    assert_eq!(serde_json::from_str::<Value>(&sent.body).unwrap(), json!({ "activationReason": "Reviewed" }));

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/commerce/postage-policies/opp_seed/activate", "label=Default&activation_reason=+", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="lifecycle__card" id="activate-form""#), "{html}");
    assert!(html.contains(r#"id="activate-form-activation_reason-error""#), "{html}");
    assert!(!pilot.policy_calls().iter().any(|c| c.method == Method::POST));
}

// The catalog area.

const CATALOG: &str = "/api/catalog";

fn dimension(id: &str, status: &str) -> Value {
    json!({
        "dimension_id": id, "key": "condition", "name": "Condition", "description": null,
        "value_kind": "ordered", "status": status, "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

fn option(id: &str, code: &str, status: &str, order: i64) -> Value {
    json!({
        "option_id": id, "code": code, "label": code.to_uppercase(),
        "label_i18n": { "defaultLocale": "en", "values": { "en": code.to_uppercase(), "fr": "fr" } },
        "display_order": order, "numeric_value": if order == 1 { json!(2.5) } else { Value::Null }, "status": status,
    })
}

fn catalog_field(id: &str) -> Value {
    json!({
        "field_id": id, "key": "language", "name": "Language", "description": "Printed language", "status": "draft",
        "value_type": "string", "filterable": true, "searchable": false, "sortable": true,
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft child category under `ctg_root` (the API's `CategoryListItem`: snake_case, its parent
/// a camelCase `CategoryRef`).
fn catalog_category(id: &str) -> Value {
    json!({
        "category_id": id, "key": "fire", "name": "Fire", "description": "", "status": "draft",
        "parent_category": { "categoryId": "ctg_root", "name": "Energy types" }, "display_order": 3,
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft component with a required field rule and a dimension rule that allows one option and
/// applies when another dimension is `holo` (the API's `ComponentDetail`).
fn catalog_component(id: &str) -> Value {
    json!({
        "component_id": id, "key": "card-face", "name": "Card face", "description": "", "status": "draft",
        "field_rules": [{ "fieldId": "fld_seed", "fieldName": "Language", "required": true }],
        "dimension_rules": [{
            "dimensionId": "dim_seed", "dimensionName": "Condition", "required": false,
            "allowedOptions": [{ "optionId": "chc_a", "code": "nm" }],
            "appliesWhen": [{ "dimensionId": "dim_b", "dimensionName": "Finish", "optionIds": ["chc_x"], "options": [{ "optionId": "chc_x", "code": "holo" }] }],
        }],
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft blueprint as its page reads it (`BlueprintDetail`): one component, a required field
/// rule, a dimension rule, and a canonical order. The admin page's read misses the field rule
/// the list has (`fld_more`), as chase-sets/chase-sets#10823 can.
fn catalog_blueprint(id: &str) -> Value {
    json!({
        "blueprint_id": id, "key": "single", "name": "Card single", "description": "", "status": "draft",
        "components": [{ "componentId": "cmp_seed", "name": "Card face" }],
        "field_rules": [{ "fieldId": "fld_seed", "fieldName": "Language", "required": true }],
        "dimension_rules": [{
            "dimensionId": "dim_seed", "dimensionName": "Condition", "required": true,
            "allowedOptions": [{ "optionId": "chc_a", "code": "nm" }],
            "appliesWhen": [{ "dimensionId": "dim_b", "dimensionName": "Finish", "optionIds": ["chc_x"], "options": [{ "optionId": "chc_x", "code": "holo" }] }],
        }],
        "canonical_dimension_order": [{ "dimensionId": "dim_seed", "dimensionName": "Condition" }],
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// The blueprints list (`Blueprint`): the blueprint's own table, with every rule.
fn catalog_blueprints() -> Value {
    json!({
        "items": [{
            "blueprint_id": "bpr_seed", "key": "single", "name": "Card single", "status": "draft",
            "component_ids": ["cmp_seed"],
            "field_rules": [{ "fieldId": "fld_seed", "required": true }, { "fieldId": "fld_more", "required": false }],
            "dimension_rules": [{ "dimensionId": "dim_seed", "required": true, "allowedOptionIds": ["chc_a"],
                                  "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] }],
            "canonical_dimension_order": ["dim_seed", "dim_b"],
        }],
        "total": 1,
    })
}

/// A draft display template for a blueprint (`DisplayTemplate`).
fn display_template(id: &str) -> Value {
    json!({
        "display_template_id": id, "key": "card-title", "name": "Card title", "description": "",
        "target_kind": "blueprint", "target_id": "bpr_seed", "priority": 10,
        "title_template": "{field.card-name}", "subtitle_template": null,
        "required_field_keys": ["card-name"], "status": "draft", "updated_at": "2026-01-01T00:00:00.000Z",
    })
}
/// A draft reference type with two attribute keys (`ReferenceType`).
fn reference_type(id: &str) -> Value {
    json!({
        "reference_type_id": id, "key": "set", "name": "Set", "description": null,
        "attribute_keys": ["release-date", "series"], "status": "draft", "updated_at": "2026-01-01T00:00:00.000Z",
    })
}
fn candidate(id: &str, status: &str, outcome: &str, reason: Option<&str>) -> Value {
    json!({ "id": id, "label": format!("Label {id}"), "status": status, "outcome": outcome, "reason": reason })
}

/// A bulk job (`CatalogAuthoringBulkJob`): running (1 of 2), or completed with its outcome.
fn job(id: &str, done: bool) -> Value {
    let (status, completed, result) = if done {
        let candidates = [
            candidate("dim_seed", "deprecated", "succeeded", None),
            candidate("dim_b", "draft", "skipped", Some("Only an active dimension can be deprecated.")),
        ];
        let result = json!({ "action": "deprecate", "ids": ["dim_seed", "dim_b"], "total": 2, "succeeded_count": 1,
                             "skipped_count": 1, "failed_count": 0, "candidates": candidates });
        ("completed", 2, result)
    } else {
        ("running", 1, Value::Null)
    };
    json!({
        "jobId": id, "kind": "catalog.authoring.dimensions.lifecycle", "action": "deprecate", "status": status,
        "progress": { "phase": status, "completed": completed, "total": 2, "currentName": "Label dim_seed", "status": "succeeded" },
        "result": result, "errorMessage": null, "createdAt": "2026-01-01T00:00:00.000Z", "startedAt": null,
        "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

/// The job's status stream: the running record, then the stream ends (the pilot connects again
/// from the last id), then the completed one.
fn job_events(headers: &HeaderMap) -> Response {
    let body = if headers.get("last-event-id").is_some_and(|id| id == "1") {
        format!("id: 2\nevent: job.completed\ndata: {}\n\n", job("job_1", true))
    } else {
        format!(": keepalive\n\nid: 1\nevent: job.progress\ndata: {}\n\n", job("job_1", false))
    };
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

fn item(id: &str, status: &str) -> Value {
    json!({
        "catalog_item_id": id, "language_code": "ja", "title_i18n": {}, "title": format!("Title {id}"), "subtitle_i18n": null,
        "subtitle": null, "display_template_key": null, "display_identity_hash": null, "display_identity_resolved_at": null,
        "blueprint": { "blueprintId": "bpr_card", "name": "Card" }, "status": status, "source_providers": ["tcgplayer", "pokemon"],
        "tags": ["foil"], "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

fn publish_candidate(id: &str, outcome: &str, retryable: bool) -> Value {
    json!({
        "catalog_item_id": id, "title": format!("Title {id}"), "subtitle": null, "status": "draft", "blueprint_id": "bpr_card",
        "blueprint_name": "Card", "source_providers": [], "outcome": outcome,
        "reason": if outcome == "published" { Value::Null } else { json!("Display identity is not resolved yet.") },
        "reason_code": null, "retryable": retryable, "display_identity_readiness": "degraded", "missing_tokens": [],
        "required_field_ids": [],
    })
}

/// A catalog item bulk job, done: a publish (one published, one to retry) or an edit.
fn item_job(id: &str, kind: &str, action: &str) -> Value {
    let result = if kind.ends_with(".publish") {
        json!({ "item_ids": ["cat_a", "cat_b"], "total": 2, "published_count": 1, "failed_count": 1, "skipped_count": 0,
                "candidates": [publish_candidate("cat_a", "published", false), publish_candidate("cat_b", "failed", true)] })
    } else {
        json!({ "action": action, "item_ids": ["cat_a"], "total": 1, "succeeded_count": 1, "skipped_count": 0, "failed_count": 0,
                "candidates": [{ "catalog_item_id": "cat_a", "title": "Title cat_a", "status": "draft", "blueprint_id": null,
                                 "category_ids": [], "tags": ["featured", "foil"], "outcome": "succeeded", "reason": null }] })
    };
    json!({
        "jobId": id, "kind": kind, "action": action, "status": "completed",
        "progress": { "phase": "completed", "completed": 2, "total": 2, "currentName": null, "status": null },
        "result": result, "errorMessage": null, "createdAt": "2026-01-01T00:00:00.000Z", "startedAt": null,
        "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

/// The Catalog API's items routes: a page of a draft and an active item (75 in all); `cat_used`
/// cannot be removed.
fn items_api(method: Method, rest: &str, body: &str) -> Response {
    match (method, rest) {
        (Method::GET, "") => {
            Json(json!({ "items": [item("cat_a", "draft"), item("cat_b", "active")], "total": 75, "count": 2 })).into_response()
        }
        (Method::POST, "/bulk-publish/preview") => {
            let candidates = [publish_candidate("cat_a", "ready", false), publish_candidate("cat_b", "blocked", true)];
            Json(json!({ "mode": "ids", "item_ids": ["cat_a", "cat_b"], "total": 2, "ready_count": 1, "blocked_count": 1, "candidates": candidates }))
                .into_response()
        }
        (Method::POST, "/bulk-edit/preview") => {
            let sent: Value = serde_json::from_str(body).unwrap();
            let candidates =
                [json!({ "catalog_item_id": "cat_a", "title": "Title cat_a", "status": "draft", "blueprint_id": null,
                                      "category_ids": ["ctg_1"], "tags": ["foil"], "outcome": "ready", "reason": null })];
            Json(
                json!({ "mode": "ids", "action": sent["operation"]["action"], "item_ids": ["cat_a"], "total": 1, "ready_count": 1,
                         "blocked_count": 0, "candidates": candidates }),
            )
            .into_response()
        }
        (Method::POST, "/bulk-publish/confirm") => {
            (StatusCode::ACCEPTED, Json(item_job("job_publish", "catalog.authoring.items.publish", "publish"))).into_response()
        }
        (Method::POST, "/bulk-edit/confirm") => {
            (StatusCode::ACCEPTED, Json(item_job("job_edit", "catalog.authoring.items.edit", "mergeTags"))).into_response()
        }
        (Method::DELETE, "/cat_used") => refusal(StatusCode::CONFLICT, "invalid_transition", "Only draft items can be removed."),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The Catalog's Scope Records: two on the page of 51, one live and changed lately (a time to
/// come, so it stays fresh), one a draft untouched since 2020. A search for `broken` fails.
fn scope_records(query: &str) -> Response {
    if query.contains("search=broken") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "The scope list is unavailable.");
    }
    let scope = |id: &str, name: &str, code: Option<&str>, editions: &[&str], status: &str, updated: &str| {
        json!({ "scopeRecordId": id, "productDomain": "pokemon", "scopeKind": "expansion", "referenceTypeKey": "expansion",
                "referenceRecordId": format!("ref_{id}"), "referenceRecordKey": id, "name": name, "parentScopeRecordId": null,
                "productLineScopeRecordId": null, "seriesScopeRecordId": null, "releaseDate": null, "officialSetCode": code,
                "languageEditions": editions, "lifecycleStatus": status, "updatedAt": updated })
    };
    let items = [
        scope("scp_paf", "Paldean Fates", Some("PAF"), &["en", "ja"], "active", "2999-01-01T00:00:00.000Z"),
        scope("scp_base", "Base Set", None, &[], "draft", "2020-01-01T00:00:00.000Z"),
    ];
    Json(json!({ "items": items, "total": 51, "count": 2 })).into_response()
}

/// A scope's page's reads and writes. `scp_paf` has two editions (its Japanese alias pending), a
/// draft coverage with a provider available and one mapped, and a job of each kind; `scp_one` has
/// one edition and nothing to review; `scp_down`'s coverage and jobs cannot be read; `scp_gone`
/// is not there. A write whose reason (or provider) is `refuse` is refused.
fn scope_api(method: &Method, path: &str, query: &str, body: &str) -> Option<Response> {
    let scope = |id: &str, editions: &[&str], status: &str| {
        json!({ "scopeRecordId": id, "productDomain": "pokemon", "scopeKind": "expansion", "referenceTypeKey": "expansion",
                "referenceRecordId": format!("ref_{id}"), "referenceRecordKey": id, "name": "Paldean Fates",
                "officialSetCode": "PAF", "languageEditions": editions, "lifecycleStatus": status,
                "updatedAt": "2999-01-01T00:00:00.000Z" })
    };
    let job = |id: &str, kind: &str, status: &str, result: Value, error: Value| {
        json!({ "jobId": id, "kind": kind, "status": status, "progress": { "completed": 1, "total": 2 },
                "result": result, "errorMessage": error })
    };
    let rest = path.strip_prefix(CATALOG)?;
    let answer = match (method.clone(), rest) {
        (Method::GET, "/scope-records/scp_paf") => Json(scope("scp_paf", &["en", "ja"], "draft")).into_response(),
        (Method::GET, "/scope-records/scp_one") => Json(scope("scp_one", &["en"], "active")).into_response(),
        (Method::GET, "/scope-records/scp_down") => Json(scope("scp_down", &["en"], "active")).into_response(),
        (Method::GET, "/scope-records/scp_gone") => refusal(StatusCode::NOT_FOUND, "not_found", "Scope record not found."),
        (Method::GET, "/provider-scope-mappings/coverage/scp_down") | (Method::GET, "/source-observations/bulk-jobs/active")
            if query.contains("scp_down") || rest.ends_with("scp_down") =>
        {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "Unavailable.")
        }
        (Method::GET, "/provider-scope-mappings/coverage/scp_paf") => Json(json!({
            "lifecycleStatus": "draft",
            "providers": [
                { "providerKey": "tcgplayer", "state": "available", "mapping": { "mappingId": "map_1", "confidence": "high" } },
                { "providerKey": "pokemontcgio", "state": "mapped", "mapping": { "mappingId": "map_2", "confidence": "exact" },
                  "syncedObservations": 12, "promotedObservations": 3 },
                { "providerKey": "cardmarket", "state": "not-offered" },
            ],
        }))
        .into_response(),
        (Method::GET, path) if path.starts_with("/provider-scope-mappings/coverage/") => {
            Json(json!({ "lifecycleStatus": "active", "providers": [] })).into_response()
        }
        (Method::GET, "/source-observations/bulk-jobs/active")
            if query.contains("scp_paf") && query.contains("status=completed") =>
        {
            let done = json!({ "promoted": 2, "deferred": 0, "skippedNotEligible": 1, "failed": 0,
                               "outcomes": [{ "status": "promoted", "catalogItemId": "itm_1" }, { "status": "promoted", "catalogItemId": "itm_1" }] });
            let cursor = if query.contains("cursor=c2") { Value::Null } else { json!("c2") };
            Json(json!({ "items": [job("job_done", "merge-candidate-promote", "completed", done, Value::Null)], "cursor": cursor }))
                .into_response()
        }
        (Method::GET, "/source-observations/bulk-jobs/active") if query.contains("scp_paf") => Json(json!({
            "items": [job("job_run", "merge-candidate-defer", "running", Value::Null, Value::Null)]
        }))
        .into_response(),
        (Method::GET, "/source-observations/merge-candidate-bulk-jobs/failed") if query.contains("scp_paf") => Json(json!({
            "items": [job("job_fail", "merge-candidate-promote", "failed", Value::Null, json!("The candidate moved."))]
        }))
        .into_response(),
        (Method::GET, "/source-observations/bulk-jobs/active" | "/source-observations/merge-candidate-bulk-jobs/failed") => {
            Json(json!({ "items": [] })).into_response()
        }
        (Method::GET, "/alias-review") => Json(json!({ "candidates": [{
            "aliasHash": "ah_ja", "targetKind": "reference-record", "targetId": "ref_scp_paf",
            "nativePrintedName": "Shiny Treasure ex", "proposedAlias": "Paldean Fates", "aliasLanguageCode": "ja",
            "confidence": "medium", "reviewStatus": "pending", "autoAccept": { "reasons": ["Confidence is below high."] },
            "availableActions": ["alias.accept", "alias.reject", "alias.defer"],
        }] }))
        .into_response(),
        (Method::POST, "/provider-scope-mappings/commands" | "/provider-scope-mappings/propose") if body.contains("refuse") => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "The mapping moved meanwhile.")
        }
        (Method::POST, "/provider-scope-mappings/commands" | "/provider-scope-mappings/propose") => {
            written(StatusCode::OK, "map_1")
        }
        (Method::POST, "/reference-records/scp_paf/publish") => written(StatusCode::OK, "scp_paf"),
        _ => return None,
    };
    Some(answer)
}

const HEALTH: &str = "provider-health:tcgplayer:tcgplayer:mtg:single-card:source-observation-import";

/// The Catalog attention queue: a provider unit's health (critical, its sheet links to the
/// provider's page) and an alias candidate (accept and reject in one click). It cannot be read
/// for `queue-down`; a park whose reason is `refuse` is refused.
fn attention_queue(method: Method, rest: &str, cookie: &str, headers: &HeaderMap, body: &str) -> Response {
    match (method, rest) {
        (Method::GET, _) if cookie.contains("queue-down") && headers.contains_key("chase-sets-read-after-write") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, _) if cookie.contains("queue-down") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "The queue is unavailable.")
        }
        (Method::GET, "") => {
            let q = "catalog.features.attentionQueue";
            let health = json!({
                "itemKey": HEALTH, "kind": "provider-health", "severity": "critical",
                "titleKey": format!("{q}.item.providerHealth.title"),
                "titleParams": { "unit": "TCGplayer Magic Single Cards", "provider": "tcgplayer" },
                "detailKey": format!("{q}.item.providerHealth.detail"),
                "detailParams": { "blocker": "credential", "code": "provider-retired" },
                "providerKey": "tcgplayer", "unitKey": "tcgplayer:mtg:single-card:source-observation-import",
                "observedAt": "2026-10-25T09:20:07.661Z",
                "resolution": { "intent": "review-provider-health", "mode": "drawer", "labelKey": format!("{q}.action.reviewHealth"),
                    "fields": { "providerKey": "tcgplayer", "unitKey": "tcgplayer:mtg:single-card:source-observation-import" },
                    "href": "/catalog/providers/tcgplayer?unitKey=tcgplayer%3Amtg%3Asingle-card%3Asource-observation-import" },
                "secondaryResolutions": [],
            });
            let alias = json!({
                "itemKey": "alias-candidate:h1", "kind": "alias-candidate", "severity": "info",
                "titleKey": format!("{q}.item.aliasCandidate.title"), "titleParams": { "alias": "Charizard ex", "type": "name" },
                "detailKey": format!("{q}.item.aliasCandidate.detail"),
                "detailParams": { "provider": "tcgdex", "type": "name", "confidence": 0.92 },
                "providerKey": "tcgdex", "unitKey": null, "observedAt": "2026-10-24T04:09:09.701000Z",
                "resolution": { "intent": "alias.accept", "mode": "command", "labelKey": format!("{q}.action.acceptAlias"),
                    "fields": { "aliasHashes": "h1" }, "requiresReason": false },
                "secondaryResolutions": [{ "intent": "alias.reject", "mode": "command", "labelKey": format!("{q}.action.rejectAlias"),
                    "fields": { "aliasHashes": "h1" }, "requiresReason": true }],
            });
            Json(json!({
                "generatedAt": "2026-10-25T09:20:07.661Z", "empty": false, "items": [health, alias],
                "counts": { "total": 2, "bySeverity": { "critical": 1, "warning": 0, "info": 1 },
                    "byKind": { "unmapped-scope": 0, "merge-conflict": 0, "provider-health": 1, "import-job": 0,
                        "alias-candidate": 1, "stale-scope-sync": 0 } },
                "freshness": { "generatedAt": "2026-10-25T09:20:07.661Z", "oldestObservedAt": null, "newestObservedAt": null },
            }))
            .into_response()
        }
        (Method::POST, "/commands") if body.contains(r#""reason":"refuse""#) => {
            refusal(StatusCode::BAD_REQUEST, "attention_queue_invalid_kind", "Parking an attention item requires its kind.")
        }
        (Method::POST, "/commands") => written(StatusCode::OK, "attention"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The Catalog API, as far as the area uses it. A dimension list has 120 rows (three pages). A
/// bulk archive cannot start (another change is running).
fn catalog_api(method: Method, rest: &str, headers: &HeaderMap, body: &str) -> Response {
    if let Some(rest) = rest.strip_prefix("/items")
        && !rest.starts_with("/bulk-lifecycle")
    {
        let answer = items_api(method.clone(), rest, body);
        if answer.status() != StatusCode::NOT_FOUND {
            return answer;
        }
    }
    match (method, rest) {
        (Method::GET, "/bulk-authoring-jobs/job_publish") => {
            Json(item_job("job_publish", "catalog.authoring.items.publish", "publish")).into_response()
        }
        (Method::GET, "/bulk-authoring-jobs/job_edit") => {
            Json(item_job("job_edit", "catalog.authoring.items.edit", "mergeTags")).into_response()
        }
        (
            Method::POST,
            "/dimensions/bulk-lifecycle/preview"
            | "/fields/bulk-lifecycle/preview"
            | "/categories/bulk-lifecycle/preview"
            | "/components/bulk-lifecycle/preview"
            | "/blueprints/bulk-lifecycle/preview"
            | "/reference-types/bulk-lifecycle/preview"
            | "/items/bulk-lifecycle/preview",
        ) => {
            let sent: Value = serde_json::from_str(body).unwrap();
            let candidates = [
                candidate("dim_seed", "active", "ready", None),
                candidate("dim_b", "draft", "blocked", Some("Only an active dimension can be deprecated.")),
            ];
            Json(json!({ "mode": sent["selection"]["mode"], "action": sent["action"], "ids": ["dim_seed", "dim_b"], "total": 2,
                         "ready_count": 1, "blocked_count": 1, "candidates": candidates }))
            .into_response()
        }
        (Method::POST, "/dimensions/bulk-lifecycle/confirm") if body.contains(r#""action":"archive""#) => {
            refusal(StatusCode::CONFLICT, "conflict", "Another bulk change is running.")
        }
        (
            Method::POST,
            "/dimensions/bulk-lifecycle/confirm"
            | "/fields/bulk-lifecycle/confirm"
            | "/categories/bulk-lifecycle/confirm"
            | "/components/bulk-lifecycle/confirm"
            | "/blueprints/bulk-lifecycle/confirm"
            | "/reference-types/bulk-lifecycle/confirm"
            | "/items/bulk-lifecycle/confirm",
        ) => (StatusCode::ACCEPTED, Json(job("job_1", false))).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_1") => Json(job("job_1", false)).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_done") => Json(job("job_done", true)).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_1/events") => job_events(headers),
        (Method::GET, "/bulk-authoring-jobs/job_missing" | "/bulk-authoring-jobs/job_missing/events") => {
            refusal(StatusCode::NOT_FOUND, "not_found", "Bulk authoring job not found.")
        }
        (Method::GET, "/dimensions") => Json(json!({ "items": [dimension("dim_seed", "active")], "total": 120 })).into_response(),
        (Method::GET, "/dimensions/dim_pending") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, "/dimensions/dim_seed") => {
            let mut detail = dimension("dim_seed", "active");
            detail["options"] = json!([option("chc_a", "nm", "active", 1), option("chc_b", "lp", "deprecated", 2)]);
            Json(detail).into_response()
        }
        (Method::GET, "/dimensions/dim_missing") => refusal(StatusCode::NOT_FOUND, "not_found", "Dimension not found."),
        (Method::POST, "/dimensions") if body.contains(r#""key":"taken""#) => {
            refusal(StatusCode::CONFLICT, "conflict", "A dimension with this key already exists.")
        }
        (Method::POST, "/dimensions/dim_seed/archive") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "Only a deprecated dimension can be archived.")
        }
        (Method::GET, "/fields") => Json(json!({ "items": [catalog_field("fld_seed")], "total": 1 })).into_response(),
        (Method::GET, "/fields/fld_seed") => Json(catalog_field("fld_seed")).into_response(),
        (Method::GET, "/categories") => Json(json!({ "items": [catalog_category("ctg_seed")], "total": 1 })).into_response(),
        (Method::GET, "/categories/ctg_seed") => Json(catalog_category("ctg_seed")).into_response(),
        (Method::GET, "/components") => Json(json!({
            "items": [{
                "component_id": "cmp_seed", "key": "card-face", "name": "Card face", "status": "draft",
                "field_rules": [{ "fieldId": "fld_seed", "required": true }],
                "dimension_rules": [{ "dimensionId": "dim_seed", "required": false, "allowedOptionIds": ["chc_a"],
                                      "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x"] }] }],
            }],
            "total": 1,
        }))
        .into_response(),
        (Method::GET, "/components/cmp_seed") => Json(catalog_component("cmp_seed")).into_response(),
        (Method::DELETE, "/components/cmp_seed/field-rules/fld_gone") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "The component has no rule for this field.")
        }
        (Method::GET, "/display-templates") => {
            Json(json!({ "items": [display_template("dtp_seed")], "total": 1 })).into_response()
        }
        (Method::GET, "/display-templates/dtp_seed") => Json(display_template("dtp_seed")).into_response(),
        (Method::POST, "/display-templates/dtp_seed/publish") => refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "Display Template token {field.card-name} references an unknown or inactive field.",
        ),
        (Method::GET, "/reference-types") => Json(json!({ "items": [reference_type("rft_seed")], "total": 1 })).into_response(),
        (Method::GET, "/reference-types/rft_seed") => Json(reference_type("rft_seed")).into_response(),
        (Method::POST, "/reference-types/rft_seed/archive") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "Only a deprecated reference type can be archived.")
        }
        (Method::GET, "/blueprints") => Json(catalog_blueprints()).into_response(),
        (Method::GET, "/blueprints/bpr_seed" | "/blueprints/bpr_other") => {
            Json(catalog_blueprint(rest.trim_start_matches("/blueprints/"))).into_response()
        }
        (Method::DELETE, "/blueprints/bpr_seed/components/cmp_gone") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "The component is not attached to this blueprint.")
        }
        (Method::POST | Method::PUT | Method::DELETE, _) => written(StatusCode::OK, "cmd"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The platform's realtime stream: a heartbeat and one change, then the stream ends (the client
/// connects again). It refuses `catalog-reader`, standing in for a session the API will not stream
/// (`catalog-viewer` has the same permissions and is streamed).
fn realtime(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=catalog-reader") || cookie.contains("chase_sets_session=ops-refused") {
        return refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "Forbidden.");
    }
    let patch = r#"{"kind":"projection.patch","context":"catalog","projection":"catalog-dimensions","topics":["catalog:admin:dimensions"],"changes":[{"op":"summary","entity":"catalog.adminProjection","id":"dimensions:x","value":{}},{"op":"summary","entity":"catalog.adminProjection","id":"dimensions:y","value":{}}]}"#;
    let body = format!("id: c1\nevent: heartbeat\ndata: {{}}\nretry: 1000\n\nid: c2\nevent: projection.patch\ndata: {patch}\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

impl Pilot {
    /// The first `count` server-sent events of a stream at `uri` (their `event:` and `data:`), or
    /// what came before it ended.
    async fn events(&self, uri: &str, session: &str, count: usize) -> Vec<(String, String)> {
        let events = self.events_with_ids(get(uri, Some(session)), count).await;
        events.into_iter().map(|(event, _, data)| (event, data)).collect()
    }

    /// The same for `req` (a reconnect sends `Last-Event-ID`), with each event's `id:`.
    async fn events_with_ids(&self, req: Request<Body>, count: usize) -> Vec<(String, String, String)> {
        let uri = req.uri().to_string();
        let res = self.router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
        assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/event-stream"));
        let mut body = res.into_body();
        let (mut text, mut events) = (String::new(), Vec::new());
        while events.len() < count {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame()).await.expect("an event in time");
            let Some(frame) = frame else { break };
            let Ok(data) = frame.unwrap().into_data() else { continue };
            text.push_str(std::str::from_utf8(&data).unwrap());
            while let Some(end) = text.find("\n\n") {
                let block: String = text.drain(..end + 2).collect();
                let field = |name: &str| {
                    block.lines().filter_map(|l| l.strip_prefix(name)).map(str::to_owned).collect::<Vec<_>>().join("\n")
                };
                let event = field("event: ");
                if !event.is_empty() {
                    events.push((event, field("id: "), field("data: ")));
                }
            }
        }
        events
    }

    fn calls_to(&self, prefix: &str) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(prefix)).cloned().collect()
    }

    /// The calls to the Catalog API.
    fn catalog_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(CATALOG)).cloned().collect()
    }

    fn catalog_writes(&self) -> Vec<Call> {
        self.catalog_calls().into_iter().filter(|c| c.method != Method::GET).collect()
    }

    /// The stylesheet a page links whose URL contains `part`, and its text.
    async fn stylesheet(&self, html: &str, part: &str) -> Option<String> {
        let start = html.find(part)?;
        let href_start = html[..start].rfind("href=\"")? + 6;
        let href_end = href_start + html[href_start..].find('"')?;
        let (status, _, css) = self.send(get(&html[href_start..href_end], None)).await;
        assert_eq!(status, StatusCode::OK, "{}", &html[href_start..href_end]);
        Some(css)
    }
}

#[tokio::test]
async fn the_catalog_is_an_area_with_its_own_guard_and_stylesheet() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/catalog/dimensions/dim_seed", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "http://localhost:7752/access/sign-in?returnTo=%2Fcatalog%2Fdimensions");
    let (status, _, _) = pilot.send(get("/catalog/dimensions", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed to read");
    let (status, _, _) = pilot.send(get("/catalog/dimensions", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = pilot.send(post_as("catalog-reader", "/catalog/dimensions", "key=size", true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.manage is needed to write");
    let (status, _, _) = pilot.send(get("/commerce/postage-policies", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the postage area keeps its own permission");
    assert!(pilot.catalog_writes().is_empty(), "a refused write reaches no handler");
    let (status, headers, _) = pilot.send(get("/catalog", Some("staff"))).await;
    assert_eq!(
        (status, &headers[header::LOCATION]),
        (StatusCode::SEE_OTHER, &"/catalog/dimensions".parse::<header::HeaderValue>().unwrap())
    );

    // Each area's pages link its stylesheet, and only theirs; the shared one has neither's rules.
    let (_, _, catalog) = pilot.send(get("/catalog/dimensions", Some("staff"))).await;
    let (_, _, postage) = pilot.send(get("/commerce/postage-policies", Some("staff"))).await;
    assert!(catalog.contains("sections/catalog") && !catalog.contains("sections/commerce"), "{catalog}");
    assert!(postage.contains("sections/commerce/postage-policies") && !postage.contains("sections/catalog"), "{postage}");
    let section = pilot.stylesheet(&catalog, "sections/catalog").await.unwrap();
    let shared = pilot.stylesheet(&catalog, "components").await.unwrap();
    assert!(section.contains(".list-page__table") && section.contains(".dialog__form"), "{section}");
    assert!(!section.contains(".policy-table__"), "{section}");
    assert!(!shared.contains(".list-page__") && !shared.contains(".policy-table__"), "{shared}");
    assert!(shared.contains(".admin-nav__bar"), "{shared}");
}

#[tokio::test]
async fn the_list_asks_the_api_as_admin_web_does_and_pages() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/dimensions?search=cond&status=active&value_kind=&page=2", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    let calls = pilot.catalog_calls();
    assert_eq!(calls[0].path, "/api/catalog/dimensions?search=cond&status=active&limit=50&offset=50", "{calls:?}");
    assert_eq!(calls[0].headers["chase-sets-read-target-context"], "catalog");
    assert!(html.contains(r#"<a class="list-page__view" href="/catalog/dimensions/dim_seed">View</a>"#), "{html}");
    assert!(html.contains(r#"href="/catalog/dimensions?search=cond&amp;status=active" rel="prev""#), "{html}");
    assert!(html.contains(r#"href="/catalog/dimensions?search=cond&amp;status=active&amp;page=3" rel="next""#), "{html}");
    assert!(html.contains("Page 2 of 3"), "{html}");
    assert!(html.contains(r#"<option value="active" selected>Active</option>"#), "the filter shows its value: {html}");
    assert!(html.contains(r#"href="/catalog/dimensions" aria-current="page""#), "the catalog's own nav: {html}");
    assert!(html.contains(r#"href="/catalog/fields""#), "{html}");
}

#[tokio::test]
async fn a_create_sends_its_drawn_id_and_comes_back_with_the_receipt_and_the_toast() {
    let pilot = Pilot::new().await;
    let body = "dimension_id=dim_01JZ&key=size&name=+Size+&description=&value_kind=ordered";
    let (status, headers, _) = pilot.send(post("/catalog/dimensions?status=active", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/dimensions?status=active&after_write=") && to.ends_with("&done=created"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!((sent.method, sent.path.as_str()), (Method::POST, "/api/catalog/dimensions"));
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "dimensionId": "dim_01JZ", "key": "size", "valueKind": "ordered",
                "name": { "defaultLocale": "en", "values": { "en": "Size" } },
                "description": { "defaultLocale": "en", "values": {} } })
    );
    let (status, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<div id="ui-toast">Dimension created</div>"#), "{html}");
    assert!(pilot.catalog_calls().last().unwrap().headers.contains_key("chase-sets-read-after-write"));
}

#[tokio::test]
async fn a_refused_create_comes_back_in_its_dialog() {
    let pilot = Pilot::new().await;
    let body = "dimension_id=dim_01JZ&key=taken&name=Size&description=&value_kind=ordered";
    let (status, headers, html) = pilot.send(post("/catalog/dimensions", body, true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"));
    assert!(html.starts_with(r#"<form class="dialog__form" id="catalog-create""#), "{html}");
    assert!(html.contains("A dimension with this key already exists.") && html.contains(r#"value="dim_01JZ""#), "{html}");
    // Without JavaScript: the page, with the dialog open on the same form.
    let (status, _, html) = pilot.send(post("/catalog/dimensions", body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="catalog-create-dialog" aria-labelledby="catalog-create-dialog-title" open"#), "{html}");
    assert!(html.contains("A dimension with this key already exists."), "{html}");
}

#[tokio::test]
async fn a_dimension_shows_its_options_and_the_changes_its_status_allows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/dimensions/dim_seed", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<h1 class="detail-page__title">Condition</h1>"#), "{html}");
    assert!(html.contains(r#"command="show-modal" commandfor="catalog-lifecycle-deprecate">Deprecate</button>"#), "{html}");
    assert!(!html.contains(r#"value="activate""#), "an active dimension is not activated: {html}");
    assert!(html.contains("2 option(s)") && html.contains(">NM<") && html.contains(">2.5<"), "{html}");
    assert!(html.contains(r#"name="action" value="deprecate">Deprecate</button>"#), "the active option: {html}");
    assert!(html.contains(r#"name="action" value="reactivate">Reactivate</button>"#), "the deprecated one: {html}");
    assert!(html.contains(r#"value="chc_a, chc_b""#), "the reorder form starts from the order: {html}");
    assert!(html.contains(r#"name="label_locale" value="fr""#), "an option's edit form has its labels: {html}");

    let (status, _, _) = pilot.send(get("/catalog/dimensions/dim_missing", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) =
        pilot.send(get(&format!("/catalog/dimensions/dim_pending?after_write={}", fresh_receipt()), Some("staff"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "the write is not readable yet");
}

#[tokio::test]
async fn lifecycle_changes_go_to_their_api_routes_and_a_refusal_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=deprecate&status=active", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with("/catalog/dimensions/dim_seed?after_write=") && to.ends_with("&done=deprecated"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!((sent.path.as_str(), sent.body.as_str()), ("/api/catalog/dimensions/dim_seed/deprecate", ""));
    let (_, _, html) = pilot.send(get(to, Some("staff"))).await;
    assert!(html.contains(r#"<div id="ui-toast">Dimension deprecated.</div>"#), "{html}");

    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=archive&status=deprecated", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="detail-page__lifecycle" id="catalog-lifecycle""#), "{html}");
    assert!(html.contains("Only a deprecated dimension can be archived."), "{html}");

    let writes = pilot.catalog_writes().len();
    let (status, _, html) = pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=delete&status=active", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), writes, "an action the form does not offer is not sent");
}

#[tokio::test]
async fn options_are_added_revised_retired_and_reordered() {
    let pilot = Pilot::new().await;
    // Add Label draws the form again with a row more, and writes nothing.
    let rows = "code=nm&numeric_value=&label_locale=en&label_value=Near+mint";
    let (status, headers, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", &format!("option_id=chc_x&{rows}&relabel=add"), true)).await;
    assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true));
    assert_eq!(html.matches(r#"name="label_locale""#).count(), 2, "{html}");
    assert!(html.contains(r#"value="Near mint""#), "{html}");
    assert!(pilot.catalog_writes().is_empty());
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", &format!("option_id=chc_x&{rows}&relabel=add"), false)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"id="catalog-add-option-dialog" aria-labelledby="catalog-add-option-dialog-title" open"#), "{html}");

    // A number that does not parse is the pilot's own check.
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", "option_id=chc_x&code=nm&numeric_value=two", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="catalog-add-option-numeric_value-error""#), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let posts = [
        (
            "/catalog/dimensions/dim_seed/options",
            format!("option_id=chc_x&{}", rows.replace("numeric_value=", "numeric_value=3")),
            "option_added",
        ),
        ("/catalog/dimensions/dim_seed/options/chc_a", rows.to_owned(), "option_revised"),
        ("/catalog/dimensions/dim_seed/options/chc_a/lifecycle", "action=deprecate&status=active".into(), "option_deprecated"),
        (
            "/catalog/dimensions/dim_seed/options/chc_b/lifecycle",
            "action=reactivate&status=deprecated".into(),
            "option_reactivated",
        ),
        ("/catalog/dimensions/dim_seed/options/order", "option_ids=chc_b%2C+chc_a%2C".into(), "reordered"),
    ];
    for (uri, body, done) in &posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().ends_with(&format!("&done={done}")), "{uri}: {headers:?}");
    }
    let sent: Vec<(Method, String, String)> = pilot.catalog_writes().into_iter().map(|c| (c.method, c.path, c.body)).collect();
    let label = json!({ "defaultLocale": "en", "values": { "en": "Near mint" } });
    assert_eq!((&sent[0].0, sent[0].1.as_str()), (&Method::POST, "/api/catalog/dimensions/dim_seed/options"));
    assert_eq!(
        serde_json::from_str::<Value>(&sent[0].2).unwrap(),
        json!({ "optionId": "chc_x", "code": "nm", "label": label, "numericValue": 3.0 })
    );
    assert_eq!((&sent[1].0, sent[1].1.as_str()), (&Method::PUT, "/api/catalog/dimensions/dim_seed/options/chc_a"));
    assert_eq!(serde_json::from_str::<Value>(&sent[1].2).unwrap(), json!({ "code": "nm", "label": label }));
    assert_eq!(sent[2].1, "/api/catalog/dimensions/dim_seed/options/chc_a/deprecate");
    assert_eq!(sent[3].1, "/api/catalog/dimensions/dim_seed/options/chc_b/reactivate");
    assert_eq!((&sent[4].0, sent[4].1.as_str()), (&Method::PUT, "/api/catalog/dimensions/dim_seed/options/order"));
    assert_eq!(serde_json::from_str::<Value>(&sent[4].2).unwrap(), json!({ "optionIds": ["chc_b", "chc_a"] }));
}

#[tokio::test]
async fn fields_are_created_configured_and_activated() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/fields?filterable=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/fields?filterable=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/fields/fld_seed">View</a>"#), "{html}");

    let body = "field_id=fld_01JZ&key=language&name=Language&description=&value_type=string&filterable=on&sortable=on";
    let (status, headers, _) = pilot.send(post("/catalog/fields", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));
    let (status, _, _) =
        pilot.send(post("/catalog/fields/fld_seed/edit", "key=language&name=Language&value_type=number", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "without JavaScript a write is a redirect");
    let (status, _, _) = pilot.send(post("/catalog/fields/fld_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let sent = pilot.catalog_writes();
    let behavior = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap()["behavior"].clone();
    assert_eq!(behavior(0), json!({ "filterable": true, "searchable": false, "sortable": true }));
    assert_eq!(serde_json::from_str::<Value>(&sent[0].body).unwrap()["fieldId"], "fld_01JZ");
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/fields/fld_seed"));
    assert_eq!(behavior(1), json!({ "filterable": false, "searchable": false, "sortable": false }));
    assert_eq!(sent[2].path, "/api/catalog/fields/fld_seed/activate");

    let (_, _, html) = pilot.send(get("/catalog/fields/fld_seed", Some("staff"))).await;
    assert!(html.contains("<dt>Filterable</dt>") && html.contains("<dd>Yes</dd>") && html.contains("<dd>No</dd>"), "{html}");
    assert!(html.contains(r#"name="action" value="activate">Activate</button>"#), "a draft is activated: {html}");
    assert!(html.contains(r#"name="filterable" checked"#), "the configure form starts from the field: {html}");
}

#[tokio::test]
async fn categories_are_created_revised_and_published_not_activated() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/categories?hierarchy=child&parent_category_id=ctg_root", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        pilot.catalog_calls()[0].path,
        "/api/catalog/categories?parentCategoryId=ctg_root&hierarchy=child&limit=50&offset=0"
    );
    assert!(html.contains(r#"href="/catalog/categories/ctg_seed">View</a>"#), "{html}");
    assert!(html.contains("<td>Energy types</td>"), "a child shows its parent's name: {html}");
    assert!(html.contains(r#"<option value="child" selected>Child Categories</option>"#), "{html}");

    // A create leaves an empty parent out; an edit sends it as null (a root category).
    let body = "category_id=ctg_01JZ&key=fire&name=Fire&description=&parent_category_id=&display_order=2";
    let (status, headers, _) = pilot.send(post("/catalog/categories", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));
    let body = "key=fire&name=Fire&description=&parent_category_id=&display_order=next";
    let (status, _, _) = pilot.send(post("/catalog/categories/ctg_seed/edit", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "without JavaScript a write is a redirect");
    let (status, _, _) = pilot.send(post("/catalog/categories/ctg_seed/lifecycle", "action=publish&status=draft", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/categories"));
    assert_eq!((body(0)["categoryId"].clone(), body(0)["displayOrder"].clone()), (json!("ctg_01JZ"), json!(2)));
    assert!(body(0).get("parentCategoryId").is_none(), "{:?}", body(0));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/categories/ctg_seed"));
    assert_eq!((body(1)["parentCategoryId"].clone(), body(1)["displayOrder"].clone()), (Value::Null, json!(0)));
    assert!(body(1).get("categoryId").is_none(), "{:?}", body(1));
    assert_eq!(sent[2].path, "/api/catalog/categories/ctg_seed/publish");
    assert_eq!(sent.len(), 3);

    // A category is published, never activated: the page offers Publish, and Activate is refused.
    let (_, _, html) = pilot.send(get("/catalog/categories/ctg_seed", Some("staff"))).await;
    assert!(html.contains("<dt>Parent Category</dt>") && html.contains("<dd>Energy types</dd>"), "{html}");
    assert!(html.contains(r#"name="action" value="publish">Publish</button>"#), "a draft is published: {html}");
    assert!(html.contains(r#"value="ctg_root""#), "the edit form starts from the category: {html}");
    let (status, _, html) =
        pilot.send(post("/catalog/categories/ctg_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 3, "nothing more sent");
}

#[tokio::test]
async fn components_are_created_and_their_rules_added_and_removed() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/components?has_field_rules=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/components?hasFieldRules=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/components/cmp_seed">View</a>"#), "{html}");

    let (status, headers, _) =
        pilot.send(post("/catalog/components", "component_id=cmp_01JZ&key=back&name=Back&description=", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));

    // The page: each rule, with what it names, its options and when it applies.
    let (_, _, html) = pilot.send(get("/catalog/components/cmp_seed", Some("staff"))).await;
    assert!(html.contains("<td>Language</td>") && html.contains("<td>Condition</td>"), "{html}");
    assert!(html.contains("<td>nm</td>") && html.contains("<td>Finish = holo</td>"), "{html}");
    assert!(html.contains(r#"action="/catalog/components/cmp_seed/field-rules/fld_seed/remove""#), "{html}");
    assert!(html.contains(r#"name="action" value="activate">Activate</button>"#), "{html}");

    let posts = [
        ("/catalog/components/cmp_seed/edit", "key=card-face&name=Card+front&description="),
        ("/catalog/components/cmp_seed/field-rules", "field_id=+fld_x+&required=on"),
        (
            "/catalog/components/cmp_seed/dimension-rules",
            "dimension_id=dim_x&allowed_option_ids=chc_1%2C+chc_2&applies_when=dim_b%3Dchc_x%7Cchc_y%2C+bad%2C+dim_c%3D",
        ),
        ("/catalog/components/cmp_seed/field-rules/fld_seed/remove", ""),
        ("/catalog/components/cmp_seed/dimension-rules/dim_seed/remove", ""),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().starts_with("/catalog/components/cmp_seed?"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/components"));
    assert_eq!(body(0)["componentId"], "cmp_01JZ");
    // The edit restates the rules the API has, read from the list (the component's own table)
    // just before the write, not from the page's read.
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/components/cmp_seed"));
    assert_eq!(body(1)["fieldRules"], json!([{ "fieldId": "fld_seed", "required": true }]));
    assert_eq!(
        body(1)["dimensionRules"],
        json!([{ "dimensionId": "dim_seed", "required": false, "allowedOptionIds": ["chc_a"],
                 "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x"] }] }])
    );
    assert_eq!(sent[2].path, "/api/catalog/components/cmp_seed/field-rules");
    assert_eq!(body(2), json!({ "fieldId": "fld_x", "required": true }));
    assert_eq!(sent[3].path, "/api/catalog/components/cmp_seed/dimension-rules");
    assert_eq!(
        body(3),
        json!({ "dimensionId": "dim_x", "required": false, "allowedOptionIds": ["chc_1", "chc_2"],
                "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] })
    );
    assert_eq!(
        (&sent[4].method, sent[4].path.as_str()),
        (&Method::DELETE, "/api/catalog/components/cmp_seed/field-rules/fld_seed")
    );
    assert_eq!(sent[5].path, "/api/catalog/components/cmp_seed/dimension-rules/dim_seed");
    assert_eq!(sent.len(), 6);
    let reads: Vec<String> = pilot
        .catalog_calls()
        .into_iter()
        .filter(|c| c.method == Method::GET && c.path.starts_with("/api/catalog/components"))
        .map(|c| c.path)
        .collect();
    assert_eq!(
        reads,
        [
            "/api/catalog/components?hasFieldRules=true&limit=50&offset=0",
            "/api/catalog/components/cmp_seed",
            "/api/catalog/components?limit=50&offset=0",
        ],
        "the list, the page, and the edit's read of the rules"
    );
}

#[tokio::test]
async fn a_refused_rule_removal_is_its_rows_message_and_a_component_bulk_change_previews() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post("/catalog/components/cmp_seed/field-rules/fld_gone/remove", "", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.contains("The component has no rule for this field."), "{html}");
    let (status, _, html) = pilot.send(post("/catalog/components/cmp_seed/field-rules/fld_gone/remove", "", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("The component has no rule for this field."), "{html}");

    // An edit of a component the list does not have writes nothing: its rules would be lost.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/components/cmp_other/edit", "key=x&name=X&description=", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("rules could not be read, so it was not saved"), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/components/bulk?has_dimension_rules=false", "action=activate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Activate Preview"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/components/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "activate", "selection": { "mode": "filter", "query": { "hasDimensionRules": "false" } } })
    );
}

/// A `GET` as the runtime sends it from a `data-patch` form (`corten: action`): a dialog opened.
fn opened(uri: &str) -> Request<Body> {
    let mut req = get(uri, Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    req
}

#[tokio::test]
async fn blueprints_are_created_and_their_components_attached_and_rules_set() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/blueprints?has_components=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/blueprints?hasComponents=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/blueprints/bpr_seed">View</a>"#), "{html}");

    let (status, headers, _) =
        pilot.send(post("/catalog/blueprints", "blueprint_id=bpr_01JZ&key=lot&name=Lot&description=", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));

    // The page: its components, its rules folded with what they name, and a draft's openers,
    // which carry the page's receipt.
    let receipt = fresh_receipt();
    let (_, _, html) = pilot.send(get(&format!("/catalog/blueprints/bpr_seed?after_write={receipt}"), Some("staff"))).await;
    assert!(html.contains("<td>Card face</td>") && html.contains("<td>Language</td>"), "{html}");
    assert!(html.contains("<td>nm</td>") && html.contains("<td>Finish = holo</td>"), "{html}");
    assert!(html.contains("1 field rules") && html.contains("<dd>Condition</dd>"), "{html}");
    assert!(html.contains(r#"action="/catalog/blueprints/bpr_seed/components/cmp_seed/detach""#), "{html}");
    assert!(html.contains(r#"action="/catalog/blueprints/bpr_seed/field-rules" data-patch"#), "{html}");
    assert!(html.contains(r#"name="after_write" value=""#), "{html}");
    assert!(html.contains(r#"name="action" value="publish">Publish</button>"#), "{html}");

    // A Set dialog starts from the list's rules (two field rules), not the page's (one).
    let (status, headers, html) =
        pilot.send(opened(&format!("/catalog/blueprints/bpr_seed/field-rules?after_write={receipt}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.contains(r#"value="fld_seed""#) && html.contains(r#"value="fld_more""#), "{html}");
    assert!(html.contains(r#"name="required" value="0" checked"#) && !html.contains(r#"value="1" checked"#), "{html}");
    let list_read = pilot.catalog_calls().into_iter().last().unwrap();
    assert_eq!(list_read.path, "/api/catalog/blueprints?limit=50&offset=0");
    assert!(list_read.headers.contains_key("chase-sets-read-after-write"), "the list read waits for the page's write");
    let (_, _, html) = pilot.send(opened("/catalog/blueprints/bpr_seed/dimension-rules")).await;
    assert!(html.contains(r#"value="dim_seed""#) && html.contains(r#"value="chc_a""#), "{html}");
    assert!(html.contains(r#"value="dim_b=chc_x|chc_y""#), "{html}");
    let (_, _, html) = pilot.send(opened("/catalog/blueprints/bpr_seed/product-resolution-rules")).await;
    assert!(html.contains(r#"value="dim_seed, dim_b""#), "{html}");

    // Add Rule draws the form again with a row more, and writes nothing.
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bpr_seed/field-rules", "field_id=fld_seed&required=0&rerow=add", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(html.matches(r#"name="field_id""#).count(), 2, "{html}");
    assert!(pilot.catalog_writes().iter().all(|w| !w.path.ends_with("/fields")));

    let posts = [
        ("/catalog/blueprints/bpr_seed/edit", "key=single&name=Card+single+v2&description="),
        ("/catalog/blueprints/bpr_seed/field-rules", "field_id=fld_seed&required=0&field_id=+fld_x+&field_id="),
        (
            "/catalog/blueprints/bpr_seed/dimension-rules",
            "dimension_id=dim_x&required=0&allowed_option_ids=chc_1%2C+chc_2&applies_when=dim_b%3Dchc_x%7Cchc_y%2C+bad",
        ),
        ("/catalog/blueprints/bpr_seed/product-resolution-rules", "canonical_dimension_order=dim_b%2C+dim_seed%2C"),
        ("/catalog/blueprints/bpr_seed/components", "component_id=+cmp_x+"),
        ("/catalog/blueprints/bpr_seed/components/cmp_seed/detach", ""),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().starts_with("/catalog/blueprints/bpr_seed?"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/blueprints"));
    assert_eq!(body(0)["blueprintId"], "bpr_01JZ");
    // The revise sends the key, name and description only.
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/blueprints/bpr_seed"));
    assert_eq!(body(1)["key"], "single");
    assert!(body(1).get("fieldRules").is_none(), "{}", body(1));
    assert_eq!((&sent[2].method, sent[2].path.as_str()), (&Method::PUT, "/api/catalog/blueprints/bpr_seed/fields"));
    assert_eq!(
        body(2),
        json!({ "fieldRules": [{ "fieldId": "fld_seed", "required": true }, { "fieldId": "fld_x", "required": false }] })
    );
    assert_eq!(sent[3].path, "/api/catalog/blueprints/bpr_seed/dimensions");
    assert_eq!(
        body(3),
        json!({ "dimensionRules": [{ "dimensionId": "dim_x", "required": true, "allowedOptionIds": ["chc_1", "chc_2"],
                                     "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] }] })
    );
    assert_eq!(sent[4].path, "/api/catalog/blueprints/bpr_seed/product-resolution-rules");
    assert_eq!(body(4), json!({ "canonicalDimensionOrder": ["dim_b", "dim_seed"] }));
    assert_eq!((&sent[5].method, sent[5].path.as_str()), (&Method::POST, "/api/catalog/blueprints/bpr_seed/components/cmp_x"));
    assert_eq!(
        (&sent[6].method, sent[6].path.as_str()),
        (&Method::DELETE, "/api/catalog/blueprints/bpr_seed/components/cmp_seed")
    );
    assert_eq!(sent.len(), 7);
}

#[tokio::test]
async fn a_set_dialog_the_list_cannot_fill_has_no_form_and_blueprint_refusals_stay_on_the_page() {
    let pilot = Pilot::new().await;
    // The list does not have bpr_other: its rules are not known, so there is nothing to save.
    let (status, _, html) = pilot.send(opened("/catalog/blueprints/bpr_other/field-rules")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("rules could not be read") && !html.contains(r#"name="field_id""#), "{html}");
    let (status, _, html) = pilot.send(get("/catalog/blueprints/bpr_other/dimension-rules", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("rules could not be read"), "{html}");

    // Without a component id there is no command to send.
    let (status, _, html) = pilot.send(post("/catalog/blueprints/bpr_seed/components", "component_id=+", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a value."), "{html}");
    // A refused Detach is its row's message; activate is not a blueprint's.
    let (status, _, html) = pilot.send(post("/catalog/blueprints/bpr_seed/components/cmp_gone/detach", "", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The component is not attached to this blueprint."), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bpr_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 1, "only the Detach was sent");

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bulk?has_components=false", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Publish Preview"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/blueprints/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "hasComponents": "false" } } })
    );
}
#[tokio::test]
async fn display_templates_are_listed_created_and_revised_and_a_refused_publish_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/display-templates?target_kind=blueprint", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/display-templates?targetKind=blueprint&limit=50&offset=0");
    assert!(html.contains("<td>Blueprint: bpr_seed</td>") && html.contains("<td>{field.card-name}</td>"), "{html}");
    assert!(html.contains(r#"href="/catalog/display-templates/dtp_seed">View</a>"#), "{html}");
    // The create dialog opens on a blueprint target at priority 10, as admin-web's does.
    assert!(html.contains(r#"<option value="blueprint" selected>Blueprint</option>"#), "{html}");
    assert!(html.contains(r#"name="priority" value="10""#), "{html}");

    // A priority that is not a whole number is the pilot's own check: nothing is sent.
    let (status, _, html) = pilot
        .send(post(
            "/catalog/display-templates",
            "display_template_id=dtp_01JZ&key=k&name=N&target_kind=global&priority=ten",
            true,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a number."), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let posts = [
        (
            "/catalog/display-templates",
            "display_template_id=dtp_01JZ&key=k&name=N&description=&target_kind=global&target_id=ignored&priority=5&title_template=%7Bitem.title%7D&subtitle_template=+",
        ),
        (
            "/catalog/display-templates/dtp_seed/edit",
            "key=card-title&name=Card+title&description=&target_kind=category&target_id=+ctg_seed+&priority=&title_template=%7Bfield.card-name%7D&subtitle_template=%7Bfield.card-number%7D",
        ),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers.contains_key("corten-location"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/display-templates"));
    assert_eq!(body(0)["displayTemplateId"], "dtp_01JZ");
    assert_eq!(body(0)["target"], json!({ "kind": "global" }), "a global target sends no id");
    assert_eq!((body(0)["priority"].clone(), body(0)["subtitleTemplate"].clone()), (json!(5), Value::Null));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/display-templates/dtp_seed"));
    assert_eq!(body(1)["target"], json!({ "kind": "category", "id": "ctg_seed" }));
    assert_eq!((body(1)["priority"].clone(), body(1)["subtitleTemplate"].clone()), (json!(0), json!("{field.card-number}")));
    assert!(body(1).get("displayTemplateId").is_none());

    let (_, _, html) = pilot.send(get("/catalog/display-templates/dtp_seed", Some("staff"))).await;
    assert!(html.contains("<dd>card-name</dd>") && html.contains("<dd>Blueprint: bpr_seed</dd>"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/display-templates/dtp_seed/lifecycle", "action=publish&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("references an unknown or inactive field"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/display-templates/dtp_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 3, "the create, the edit and the refused publish");
}
#[tokio::test]
async fn reference_types_are_listed_created_revised_and_bulk_published_and_a_refused_archive_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/reference-types?attribute_key=series", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/reference-types?attributeKey=series&limit=50&offset=0");
    assert!(html.contains("<td>set</td>") && html.contains("<td>2</td>"), "{html}");
    assert!(html.contains(r#"href="/catalog/reference-types/rft_seed">View</a>"#), "{html}");

    let posts = [
        (
            "/catalog/reference-types",
            "reference_type_id=rft_01JZ&key=set&name=Set&description=&attribute_keys=release-date%2C+series%0D%0A%0D%0Aprinted",
        ),
        ("/catalog/reference-types/rft_seed/edit", "key=set&name=Card+set&description=Printed+sets&attribute_keys="),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers.contains_key("corten-location"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/reference-types"));
    assert_eq!(body(0)["referenceTypeId"], "rft_01JZ");
    assert_eq!(body(0)["attributeKeys"], json!(["release-date", "series", "printed"]), "split on commas and lines");
    assert_eq!(body(0)["name"], json!({ "defaultLocale": "en", "values": { "en": "Set" } }));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/reference-types/rft_seed"));
    assert_eq!(body(1)["attributeKeys"], json!([]));
    assert!(body(1).get("referenceTypeId").is_none());

    let (_, _, html) = pilot.send(get("/catalog/reference-types/rft_seed", Some("staff"))).await;
    assert!(html.contains("<dd>release-date, series</dd>"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/reference-types/rft_seed/lifecycle", "action=archive&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Only a deprecated reference type can be archived."), "{html}");

    let (status, _, _) = pilot.send(post("/catalog/reference-types/bulk?status=draft", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    let sent = pilot.catalog_writes().remove(3);
    assert_eq!(sent.path, "/api/catalog/reference-types/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "status": "draft" } } })
    );
}
#[tokio::test]
async fn a_category_bulk_change_publishes_by_the_lists_filters_and_refuses_activate() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/categories/bulk?hierarchy=root&search=gen", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Publish Preview"), "{html}");
    assert!(html.contains(r#"action="/catalog/categories/bulk/confirm?search=gen&amp;hierarchy=root""#), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/categories/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "search": "gen", "hierarchy": "root" } } })
    );

    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/categories/bulk", "action=activate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let (status, headers, _) =
        pilot.send(post("/catalog/categories/bulk/confirm?hierarchy=root", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().contains("job=job_1"), "{headers:?}");
}

#[tokio::test]
async fn a_list_draws_its_rows_on_open_and_again_on_each_change_resuming_after_a_drop() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/dimensions?status=active&page=2", Some("staff"))).await;
    assert!(
        html.contains(r#"<corten-live src="/catalog/dimensions/live?status=active&amp;page=2"><div data-scope="bulk-rows" id="catalog-rows""#),
        "the rows are live, with the list's filters and page: {html}"
    );
    let before = pilot.catalog_calls().len();

    // On open, on the change, and on the change the stream sends again after it reconnects.
    let events = pilot.events("/catalog/dimensions/live?status=active&page=2", "staff", 3).await;
    assert_eq!(events.len(), 3, "{events:?}");
    for (event, data) in &events {
        assert_eq!(event, "patch");
        assert!(
            data.starts_with(r#"<div data-scope="bulk-rows" id="catalog-rows""#) && data.contains("/catalog/dimensions/dim_seed"),
            "{data}"
        );
        assert!(
            data.contains("Page 2 of 3") && !data.contains(r#"role="search""#),
            "the rows, pager and bulk bar, not the filters: {data}"
        );
        assert!(data.contains("120 matching Dimensions"), "the bar's count is drawn with the rows: {data}");
    }
    let reads: Vec<_> = pilot.catalog_calls()[before..].iter().map(|c| c.path.clone()).collect();
    assert_eq!(reads, vec!["/api/catalog/dimensions?status=active&limit=50&offset=50"; 3], "the same list each time");

    let streams = pilot.calls_to("/api/realtime/");
    assert_eq!(streams[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions");
    assert_eq!(streams[0].headers[header::COOKIE], "chase_sets_session=staff", "as the signed-in user");
    assert_eq!(streams[1].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions&cursor=c2", "it resumes");
}

#[tokio::test]
async fn each_drawing_of_a_live_list_carries_the_streams_cursor_and_a_reconnect_resumes_from_it() {
    let pilot = Pilot::new().await;
    // A first connection: drawn once the stream is open (at its heartbeat, c1), then on the change.
    let first = pilot.events_with_ids(get("/catalog/dimensions/live", Some("staff")), 2).await;
    let ids: Vec<_> = first.iter().map(|(_, id, _)| id.as_str()).collect();
    assert_eq!(ids, ["c1", "c2"], "{first:?}");

    // The browser reconnects with the last cursor it got: nothing is drawn until a change.
    let before = (pilot.catalog_calls().len(), pilot.calls_to("/api/realtime/").len());
    let mut req = get("/catalog/dimensions/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "c2".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 1).await;
    assert_eq!(resumed.len(), 1);
    assert_eq!((resumed[0].0.as_str(), resumed[0].1.as_str()), ("patch", "c2"), "the change, not the open: {resumed:?}");
    assert_eq!(pilot.catalog_calls().len() - before.0, 1, "one read, for the change");
    let streams = &pilot.calls_to("/api/realtime/")[before.1..];
    assert_eq!(
        streams[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions&cursor=c2",
        "from the browser's cursor"
    );
}

#[tokio::test]
async fn a_live_list_ends_when_the_api_refuses_its_stream() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/catalog/fields/live", "catalog-reader", 3).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["end"], "the page's rows stay, and the element stops: {events:?}");
}

// Bulk changes.

#[tokio::test]
async fn staff_who_may_change_the_records_get_the_bulk_bar_and_a_box_on_each_row() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/dimensions?status=active", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<form data-ref="form" id="catalog-bulk" class="bulk-rows__bar" method="post" action="/catalog/dimensions/bulk?status=active" data-patch"#), "{html}");
    assert!(html.contains(r#"name="ids" value="dim_seed" form="catalog-bulk" aria-label="Select row dim_seed""#), "{html}");
    assert!(
        html.contains(r#"name="all" form="catalog-bulk" aria-label="Select all rows" hidden"#),
        "select-all needs the script: {html}"
    );
    assert!(
        html.contains(
            r#"connect:bulk_rows.drawn({form:@form,count:@count,preview:@preview,clear:@clear},{matching:&quot;120 matching Dimensions&quot;,entity:&quot;Dimensions&quot;,selected:%[&quot;&quot;,&quot;count&quot;,&quot; &quot;,&quot;entityName&quot;,&quot; selected&quot;]})"#
        ),
        "the count's text is the catalog's message, sent unfilled: {html}"
    );
    assert!(html.contains(r#"name="mode" value="ids">Preview</button>"#) && html.contains(r#"type="reset""#), "{html}");
    assert!(html.contains(r#"<dialog id="catalog-bulk-preview"></dialog>"#), "the preview's place: {html}");

    // catalog.view only: the rows, without the bar or the boxes (its posts need catalog.manage).
    let (status, _, html) = pilot.send(get("/catalog/dimensions", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<div id="catalog-rows">"#) && !html.contains("catalog-bulk\""), "{html}");
    assert!(!html.contains(r#"name="ids""#), "{html}");
    let (status, _, _) =
        pilot.send(post_as("catalog-reader", "/catalog/dimensions/bulk", "action=deprecate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, rows) = pilot.events("/catalog/fields/live", "catalog-viewer", 1).await.remove(0);
    assert!(rows.starts_with(r#"<div id="catalog-rows">"#) && !rows.contains("catalog-bulk"), "{rows}");
}

#[tokio::test]
async fn a_preview_asks_the_api_for_the_checked_rows_or_the_filter_and_answers_with_its_dialog() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot
        .send(post("/catalog/dimensions/bulk?status=active", "action=deprecate&mode=ids&ids=dim_seed&ids=dim_b", true))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.starts_with(r#"<dialog class="dialog__dialog" id="catalog-bulk-preview""#) && html.contains(" open "), "{html}");
    assert!(html.contains("Bulk Deprecate Preview") && html.contains("1 ready, 1 blocked."), "{html}");
    assert!(html.contains("Label dim_b") && html.contains("Only an active dimension can be deprecated."), "{html}");
    assert!(html.contains(r#"action="/catalog/dimensions/bulk/confirm?status=active""#), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="ids" value="dim_b">"#), "the confirm takes the preview's ids: {html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/dimensions/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "deprecate", "selection": { "mode": "ids", "ids": ["dim_seed", "dim_b"] } })
    );

    // Every field the filters match: the list's filters are the selection's query.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(post("/catalog/fields/bulk?search=lang&value_type=string&sortable=true", "action=archive&mode=filter", true))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains(r#"name="ids""#), "a filter is confirmed as a filter: {html}");
    assert!(html.contains(r#"<input type="hidden" name="mode" value="filter">"#), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/fields/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "archive", "selection": { "mode": "filter", "query": { "search": "lang", "valueType": "string", "sortable": "true" } } })
    );

    // Without JavaScript: the list, with the preview open.
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=deprecate&mode=ids&ids=dim_seed", false)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.starts_with("<!DOCTYPE html>")
            && html.contains(r#"id="catalog-bulk-preview" aria-labelledby="catalog-bulk-preview-title" open"#),
        "{html}"
    );
    assert!(html.contains("/catalog/dimensions/dim_seed"), "the list behind it: {html}");
}

#[tokio::test]
async fn a_preview_of_nothing_or_of_an_action_not_offered_is_refused_without_asking_the_api() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=deprecate&mode=ids", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"<p class="form-error" role="alert">Select at least one row to preview.</p>"#), "{html}");
    assert!(html.contains("disabled") && !html.contains("ready,"), "nothing to confirm: {html}");
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=delete&mode=filter", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert!(pilot.catalog_writes().is_empty());
}

#[tokio::test]
async fn a_confirm_starts_the_job_and_the_list_follows_it() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post("/catalog/dimensions/bulk/confirm?status=active", "action=deprecate&mode=ids&ids=dim_seed&ids=dim_b", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["corten-location"], "/catalog/dimensions?status=active&job=job_1");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/dimensions/bulk-lifecycle/confirm");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "deprecate", "selection": { "mode": "ids", "ids": ["dim_seed", "dim_b"] } })
    );

    let (status, _, html) = pilot.send(get("/catalog/dimensions?status=active&job=job_1", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"id="catalog-bulk-job" aria-labelledby="catalog-bulk-job-title" open"#), "{html}");
    assert!(html.contains("Bulk Deprecate Result"), "{html}");
    assert!(html.contains(r#"<corten-live src="/catalog/jobs/job_1/live"><div id="catalog-bulk-status">"#), "{html}");
    assert!(html.contains("1 of 2 processed.") && html.contains("Current: Label dim_seed"), "{html}");
    assert!(
        html.contains(r#"href="/catalog/dimensions?status=active&amp;page=2" rel="next""#),
        "the pages leave the job: {html}"
    );

    let mut req = get("/catalog/dimensions?job=job_1", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["job"]["jobId"], "job_1", "data clients get the job: {body}");

    // Without JavaScript the same confirm is a redirect.
    let (status, headers, _) = pilot.send(post("/catalog/dimensions/bulk/confirm", "action=deprecate&mode=filter", false)).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, "/catalog/dimensions?job=job_1"));
}

#[tokio::test]
async fn a_refused_confirm_is_the_preview_again_with_the_apis_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/bulk/confirm", "action=archive&mode=ids&ids=dim_seed", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<dialog class="dialog__dialog" id="catalog-bulk-preview""#), "{html}");
    assert!(html.contains(r#"<p class="form-error" role="alert">Another bulk change is running.</p>"#), "{html}");
    assert!(html.contains("1 ready, 1 blocked."), "the preview is drawn again: {html}");
    let paths: Vec<_> = pilot.catalog_writes().iter().map(|c| c.path.clone()).collect();
    assert_eq!(paths, ["/api/catalog/dimensions/bulk-lifecycle/confirm", "/api/catalog/dimensions/bulk-lifecycle/preview"]);
}

#[tokio::test]
async fn a_jobs_status_is_streamed_until_it_is_done_resuming_after_a_drop() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/catalog/jobs/job_1/live", "staff", 3).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["patch", "patch", "end"], "{events:?}");
    assert!(
        events[0].1.starts_with(r#"<div id="catalog-bulk-status">"#) && events[0].1.contains("1 of 2 processed."),
        "{events:?}"
    );
    assert!(events[1].1.contains("1 succeeded, 1 skipped, 0 failed.") && events[1].1.contains("Label dim_b"), "{events:?}");
    let streams = pilot.calls_to("/api/catalog/bulk-authoring-jobs/job_1/events");
    assert_eq!(streams.len(), 2, "{streams:?}");
    assert!(!streams[0].headers.contains_key("last-event-id"));
    assert_eq!(streams[1].headers["last-event-id"], "1", "it resumes from the last event");
    assert_eq!(streams[1].headers[header::COOKIE], "chase_sets_session=staff", "as the signed-in user");
}

#[tokio::test]
async fn a_job_dialog_that_reconnects_gets_only_the_changes_after_the_status_it_shows() {
    let pilot = Pilot::new().await;
    let first = pilot.events_with_ids(get("/catalog/jobs/job_1/live", Some("staff")), 1).await;
    assert_eq!(first[0].1, "1", "each status carries its event's id: {first:?}");

    let mut req = get("/catalog/jobs/job_1/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "1".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 2).await;
    let kinds: Vec<_> = resumed.iter().map(|(event, id, _)| (event.as_str(), id.as_str())).collect();
    assert_eq!(kinds, [("patch", "2"), ("end", "")], "{resumed:?}");
    assert!(resumed[0].2.contains("1 succeeded, 1 skipped, 0 failed."), "{resumed:?}");
    let streams = pilot.calls_to("/api/catalog/bulk-authoring-jobs/job_1/events");
    assert_eq!(streams.last().unwrap().headers["last-event-id"], "1", "the job's stream, from there");
}

#[tokio::test]
async fn a_done_job_shows_what_it_did_and_an_unknown_one_says_so() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/dimensions?job=job_done", Some("staff"))).await;
    assert!(
        html.contains("1 succeeded, 1 skipped, 0 failed.") && !html.contains("/catalog/jobs/"),
        "no stream once done: {html}"
    );
    let (_, _, html) = pilot.send(get("/catalog/dimensions?job=job_missing", Some("staff"))).await;
    assert!(html.contains("This bulk change is not known."), "{html}");
    let events = pilot.events("/catalog/jobs/job_missing/live", "staff", 2).await;
    assert!(events[0].1.contains("This bulk change is not known.") && events[1].0 == "end", "{events:?}");
}

// The catalog items list.

fn sent_json(call: &Call) -> Value {
    serde_json::from_str(&call.body).unwrap()
}

#[tokio::test]
async fn the_items_list_asks_the_api_with_admin_webs_filters_and_draws_its_columns() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(get(
            "/catalog/catalog-items?status=draft&language=ja&blueprint_state=missing&has_images=false&page=2",
            Some("staff"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let read = pilot.catalog_calls().remove(0);
    assert_eq!(
        read.path, "/api/catalog/items?status=draft&language=ja&blueprintState=missing&hasImages=false&limit=50&offset=50",
        "the API's query names"
    );
    assert!(html.contains("<title>Catalog Items | Catalog Admin</title>"), "{html}");
    assert!(html.contains("75 matching Catalog Items") && html.contains("Page 2 of 2"), "{html}");
    assert!(
        html.contains("<td>Title cat_a</td>") && html.contains("<td>Japanese</td>") && html.contains("<td>Card</td>"),
        "{html}"
    );
    assert!(html.contains("<td>tcgplayer, pokemon</td>"), "the sources: {html}");
    assert!(html.contains(r#"href="/catalog/catalog-items/cat_a""#), "the item's page is the pilot's: {html}");
    assert!(html.contains(r#"<details class="list-page__more" open>"#), "a folded filter that is set opens them: {html}");
    assert!(html.contains(r#"value="missing" selected"#), "{html}");
    assert!(html.contains(r#"data-status="draft""#), "a draft's box says so: {html}");
    assert!(html.contains(r#"formaction="/catalog/catalog-items/drafts?status=draft&amp;language=ja&amp;blueprint_state=missing&amp;has_images=false&amp;page=2" data-requires="draft""#), "{html}");
    assert!(html.contains(r#"<option value="mergeTags">Merge Tags</option>"#) && html.contains(r#"name="tags""#), "{html}");
    assert!(
        html.contains(r#"<corten-live data-scope="live-status" id="catalog-live" src="/catalog/catalog-items/live?status=draft&amp;language=ja&amp;blueprint_state=missing&amp;has_images=false&amp;page=2" data-on="#),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/catalog-items""#), "the nav serves the list: {html}");

    let (status, _, html) = pilot.send(get("/catalog/catalog-items", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("catalog-bulk\"") && !html.contains("New Catalog Item"), "no writes for catalog.view: {html}");
    assert!(!html.contains("<details class=\"list-page__more\" open>"), "{html}");
}

#[tokio::test]
async fn an_item_is_created_with_its_drawn_id_as_its_english_title() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/catalog-items", Some("staff"))).await;
    assert!(html.contains(r#"name="item_id" value="cat_"#) && html.contains(r#"name="language_code" value="en""#), "{html}");
    let (status, headers, _) = pilot
        .send(post("/catalog/catalog-items?status=draft", "item_id=cat_new&language_code=ja&description=Booster%20box", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with("/catalog/catalog-items?status=draft&after_write=") && to.ends_with("&done=created"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items");
    assert_eq!(
        sent_json(&sent),
        json!({ "itemId": "cat_new", "languageCode": "ja", "title": { "defaultLocale": "en", "values": { "en": "cat_new" } },
                "subtitle": null, "description": { "defaultLocale": "en", "values": { "en": "Booster box" } } })
    );
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?done=created", Some("staff"))).await;
    assert!(html.contains("Catalog item created"), "{html}");
}

#[tokio::test]
async fn each_bulk_operation_previews_through_its_own_api_route() {
    let pilot = Pilot::new().await;
    // A publish of the matching items: the filters are the selection.
    let (status, _, html) =
        pilot.send(post("/catalog/catalog-items/bulk?status=draft&tag=foil", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Bulk Publish Preview") && html.contains("Matching drafts: 1 ready, 1 need attention."), "{html}");
    assert!(html.contains("Display identity is not resolved yet."), "{html}");
    assert!(html.contains(r#"action="/catalog/catalog-items/bulk/confirm?status=draft&amp;tag=foil""#), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="mode" value="ids"><input type="hidden" name="ids" value="cat_a"><input type="hidden" name="ids" value="cat_b">"#),
        "the confirm takes the preview's items: {html}"
    );
    assert!(html.contains(">Publish or recheck items</button>") && !html.contains("disabled"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-publish/preview");
    assert_eq!(
        sent_json(&sent),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "status": "draft", "tag": "foil" } } })
    );

    // An edit of the checked rows, its tags as admin-web reads them.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(post("/catalog/catalog-items/bulk", "action=mergeTags&mode=ids&ids=cat_a&tags=foil%2C%20featured%2C%20foil", true))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Bulk Merge Tags Preview") && html.contains("1 ready, 0 need attention."), "{html}");
    assert!(html.contains("<td>ctg_1</td>") && html.contains(">Apply Edit</button>"), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="tags" value="foil, featured, foil">"#),
        "the confirm carries the operation: {html}"
    );
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-edit/preview");
    assert_eq!(
        sent_json(&sent),
        json!({ "operation": { "action": "mergeTags", "tags": ["featured", "foil"] }, "selection": { "mode": "ids", "ids": ["cat_a"] } })
    );

    // An archive: the lifecycle change, labelled as the item page labels it.
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(post("/catalog/catalog-items/bulk", "action=archive&mode=ids&ids=cat_a", true)).await;
    assert!(html.contains("Bulk Archive Preview") && html.contains("1 ready, 1 blocked."), "{html}");
    assert_eq!(pilot.catalog_writes().remove(0).path, "/api/catalog/items/bulk-lifecycle/preview");

    // An edit without the value it takes is the field's message, and the API is not asked.
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/catalog-items/bulk", "action=assignBlueprint&mode=filter&blueprint_id=%20", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a value.") && html.contains("disabled"), "{html}");
    assert!(pilot.catalog_writes().is_empty());
}

#[tokio::test]
async fn a_confirm_starts_the_operations_job_and_the_dialog_shows_its_outcome() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post("/catalog/catalog-items/bulk/confirm?status=draft", "action=publish&mode=ids&ids=cat_a&ids=cat_b", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?status=draft&job=job_publish");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(
        (sent.path.as_str(), sent_json(&sent)),
        ("/api/catalog/items/bulk-publish/confirm", json!({ "itemIds": ["cat_a", "cat_b"] }))
    );

    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_publish", Some("staff"))).await;
    assert!(html.contains("Bulk Publish Result") && html.contains("1 published, 1 failed, 0 skipped."), "{html}");
    assert!(!html.contains("/catalog/jobs/job_publish/live"), "done: no stream: {html}");
    assert!(
        html.contains(r#"<input type="hidden" name="action" value="publish"><input type="hidden" name="mode" value="ids"><input type="hidden" name="ids" value="cat_b">"#)
            && html.contains("Retry items needing attention"),
        "the items to retry are previewed again: {html}"
    );

    let pilot = Pilot::new().await;
    let (_, headers, _) =
        pilot.send(post("/catalog/catalog-items/bulk/confirm", "action=mergeTags&mode=filter&tags=foil", true)).await;
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?job=job_edit");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-edit/confirm");
    assert_eq!(
        sent_json(&sent),
        json!({ "operation": { "action": "mergeTags", "tags": ["foil"] }, "selection": { "mode": "filter", "query": {} } })
    );
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_edit", Some("staff"))).await;
    assert!(
        html.contains("Bulk Merge Tags Result")
            && html.contains("1 updated, 0 skipped, 0 failed.")
            && html.contains("<td>featured, foil</td>"),
        "{html}"
    );

    let pilot = Pilot::new().await;
    let (_, headers, _) =
        pilot.send(post("/catalog/catalog-items/bulk/confirm", "action=archive&mode=ids&ids=cat_b", true)).await;
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?job=job_1");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent_json(&sent), json!({ "action": "archive", "selection": { "mode": "ids", "ids": ["cat_b"] } }));
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_1", Some("staff"))).await;
    // The stand-in's running job is a dimensions' deprecate: labelled by its own kind.
    assert!(html.contains("Bulk Deprecate Result") && html.contains(r#"<corten-live src="/catalog/jobs/job_1/live">"#), "{html}");
}

#[tokio::test]
async fn checked_drafts_are_removed_one_by_one_and_only_drafts() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/catalog-items/drafts?status=draft", "mode=ids&ids=cat_a", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("Remove Draft Catalog Items") && html.contains("Remove 1 draft Catalog Items from the grid."),
        "{html}"
    );
    assert!(html.contains(r#"action="/catalog/catalog-items/drafts/confirm?status=draft""#), "{html}");

    let (status, _, html) = pilot.send(post("/catalog/catalog-items/drafts", "mode=ids&ids=cat_a&ids=cat_b", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Check only draft Catalog Items to remove them.") && html.contains("disabled"), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let (status, headers, _) = pilot.send(post("/catalog/catalog-items/drafts/confirm?status=draft", "ids=cat_a", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(
        to.starts_with("/catalog/catalog-items?status=draft&after_write=") && to.ends_with("&done=drafts_removed&removed=1"),
        "{to}"
    );
    let removed: Vec<_> = pilot.catalog_writes().iter().map(|c| (c.method.clone(), c.path.clone())).collect();
    assert_eq!(removed, [(Method::DELETE, "/api/catalog/items/cat_a".to_owned())]);
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?done=drafts_removed&removed=1", Some("staff"))).await;
    assert!(html.contains("1 draft Catalog Items removed"), "{html}");
}

#[tokio::test]
async fn the_items_page_counts_changes_and_a_reload_draws_the_rows_and_a_new_stream() {
    let pilot = Pilot::new().await;
    let events = pilot.events_with_ids(get("/catalog/catalog-items/live?status=draft", Some("staff")), 2).await;
    assert_eq!(events.len(), 2, "{events:?}");
    let (event, id, data) = &events[0];
    assert_eq!((event.as_str(), id.as_str()), ("patch", "2.0.c2"), "the count rides on the cursor: {events:?}");
    assert!(data.starts_with(r#"<div id="catalog-changes""#) && data.contains("2 Catalog Items changed"), "{data}");
    assert!(data.contains(r#"<input type="hidden" name="status" value="draft">"#) && data.contains(">Reload</button>"), "{data}");
    assert_eq!(events[1].1, "2.0.c2", "the same records again after a reconnect: still two");
    assert_eq!(pilot.calls_to("/api/realtime/")[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Acatalog-items");
    assert!(pilot.catalog_calls().is_empty(), "a change is counted, not read");

    // The browser reconnects with the count it shows: it goes on from there.
    let mut req = get("/catalog/catalog-items/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "5.0.c2".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 1).await;
    assert!(resumed[0].2.contains("7 Catalog Items changed") && resumed[0].1 == "7.0.c2", "{resumed:?}");
    assert!(pilot.calls_to("/api/realtime/").iter().any(|c| c.path.ends_with("&cursor=c2")), "from its cursor");

    // Reload, with the script: the rows, and a new element to stream from, counting from none.
    let mut req = get("/catalog/catalog-items?status=draft", Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    let (status, headers, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.starts_with(r#"<div data-scope="bulk-rows" id="catalog-rows""#), "{html}");
    assert!(
        html.contains(
            r#"<corten-live data-scope="live-status" id="catalog-live" src="/catalog/catalog-items/live?status=draft" data-on="connect:live_status.stale($c,@since,%[&quot;Stale since &quot;,&quot;value&quot;,&quot;&quot;],%{"#
        ),
        "the stream's connection status, in the element that streams: {html}"
    );
    // The stale time is written by the server's date format (`t.js().date_time`), in UTC.
    let live = &html[html.find("<corten-live").unwrap()..];
    let live = &live[..live.find('>').unwrap()];
    assert_eq!(live.matches(r#"&quot;u&quot;:&quot;UTC&quot;"#).count(), 2, "on connect and on each status: {live}");
    assert!(
        html.contains(r#"<input type="hidden" name="status" value="draft"><button type="submit" class="live-status__reload">Reload</button>"#),
        "a stale stream's Reload keeps the filters: {html}"
    );
    assert!(
        html.contains(r#"<div id="catalog-changes" class="item-form__changes" role="status"></div></corten-live>"#),
        "{html}"
    );
    assert!(!html.contains(r#"role="search""#), "not the filters: {html}");
}

#[tokio::test]
async fn the_scopes_list_asks_the_api_and_shows_each_scopes_promotion_and_sync() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/scopes?search=pal&status=active&product_domain=pokemon&page=2", Some("catalog-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "catalog.view is enough: {html}");
    let calls = pilot.catalog_calls();
    assert!(
        calls
            .iter()
            .any(|c| c.path == "/api/catalog/scope-records?search=pal&status=active&productDomain=pokemon&limit=50&offset=50"),
        "{calls:?}"
    );
    assert!(html.contains("<strong>Paldean Fates</strong>") && html.contains(">PAF</span>"), "{html}");
    assert!(html.contains("<td>pokemon · expansion</td>") && html.contains("2 edition(s): en, ja"), "{html}");
    assert!(html.contains(">Live</span>") && html.contains(">Fresh</span>"), "an active scope, changed lately: {html}");
    assert!(
        html.contains("No editions yet") && html.contains(">Unpublished</span>") && html.contains(">Stale sync</span>"),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/scopes/scp_paf">View</a>"#), "the scope's page is the pilot's: {html}");
    assert!(
        html.contains(r#"href="/catalog/scopes?search=pal&amp;status=active&amp;product_domain=pokemon" rel="prev""#),
        "the pager keeps the filters: {html}"
    );
    assert!(
        html.contains(r#"<option value="pokemon" selected>pokemon</option>"#) && html.contains(r#"<option value="lorcana">"#),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/scopes" aria-current="page""#), "the nav's Scopes is the pilot's: {html}");
}

#[tokio::test]
async fn the_scopes_language_filters_the_page_the_api_returned() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/scopes?language=ja", Some("staff"))).await;
    assert!(
        pilot.catalog_calls().iter().any(|c| c.path == "/api/catalog/scope-records?limit=50&offset=0"),
        "not sent to the API"
    );
    assert!(html.contains("Paldean Fates") && !html.contains("Base Set"), "{html}");
    assert!(
        html.contains(r#"<option value="ja" selected>ja</option>"#) && html.contains(r#"<option value="en">en</option>"#),
        "{html}"
    );
}

#[tokio::test]
async fn a_scopes_list_the_api_cannot_read_is_its_banner_over_no_rows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes?search=broken", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "as admin-web's loader: {html}");
    assert!(html.contains(r#"role="alert""#) && html.contains("The scope list is unavailable."), "{html}");
    assert!(html.contains("No scopes found"), "{html}");
    let mut req = get("/catalog/scopes?search=broken", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["error"], "The scope list is unavailable.", "{body}");
    assert_eq!(body["data"]["items"], json!([]), "{body}");

    let (status, _, _) = pilot.send(get("/catalog/scopes", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed");
}

fn action_get(uri: &str) -> Request<Body> {
    let mut req = get(uri, Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    req
}

#[tokio::test]
async fn the_attention_queue_sits_above_the_scopes_with_its_counts_and_items() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes?status=active", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (queue, list) = (html.find("data-attention-queue").unwrap(), html.find("Paldean Fates").unwrap());
    assert!(queue < list, "the queue is above the list");
    assert!(html.contains(">2 need you</span>") && html.contains("As of 2026-10-25T09:20:07.661Z"), "{html}");
    assert!(
        html.contains("Unblock TCGplayer Magic Single Cards on tcgplayer")
            && html.contains("Blocked by credential · provider-retired"),
        "{html}"
    );
    assert!(html.contains("tcgdex · name · confidence 0.92"), "a keyword argument and a number: {html}");
    assert!(
        html.contains(r#"<form id="attention-open" method="get" action="/catalog/scopes/attention/review" data-patch><input type="hidden" name="status" value="active"></form>"#),
        "one Review form, keeping the filters: {html}"
    );
    assert!(html.contains(&format!(r#"form="attention-open" name="item" value="{HEALTH}">Review health</button>"#)), "{html}");
    assert!(
        html.contains(r#"action="/catalog/scopes/attention/alias/reject?status=active" data-patch><input type="hidden" name="alias_hashes" value="h1"><input type="hidden" name="reason" value="Reject">"#),
        "a reject sends its label as the reason: {html}"
    );
    assert!(html.contains(r#"<dialog id="attention-sheet"></dialog>"#), "the sheet is drawn when opened: {html}");

    let mut req = get("/catalog/scopes", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["attention"]["items"][0]["kind"], "provider-health", "{body}");
    assert_eq!(body["data"]["attention"]["items"][1]["resolution"]["mode"], "command", "{body}");

    let (_, _, html) = pilot.send(get("/catalog/scopes", Some("catalog-viewer"))).await;
    assert!(
        html.contains(r#"<button type="submit" class="attention-panel__small" disabled>Accept</button>"#),
        "a viewer may not act: {html}"
    );
}

#[tokio::test]
async fn an_items_review_draws_its_sheet_with_its_evidence_and_park_forms() {
    let pilot = Pilot::new().await;
    let key = percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, html) = pilot.send(action_get(&format!("/catalog/scopes/attention/review?status=active&item={key}"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.starts_with(r#"<dialog class="dialog__dialog" id="attention-sheet" aria-labelledby="attention-sheet-title" open"#),
        "{html}"
    );
    assert!(html.contains("<dt>Unit</dt><dd>tcgplayer:mtg:single-card:source-observation-import</dd>"), "{html}");
    assert!(
        html.contains(r#"href="http://localhost:7752/catalog/providers/tcgplayer?unitKey=tcgplayer%3Amtg%3Asingle-card%3Asource-observation-import""#),
        "the destination is admin-web's: {html}"
    );
    assert!(
        html.contains(r#"id="attention-dismiss" method="post" action="/catalog/scopes/attention/dismiss?status=active""#),
        "{html}"
    );
    assert!(html.contains(r#"<input type="hidden" name="kind" value="provider-health">"#), "{html}");
    assert!(!html.contains("Paldean Fates"), "only the sheet: {html}");

    let (_, _, html) = pilot.send(action_get("/catalog/scopes/attention/review?item=gone")).await;
    assert_eq!(html, r#"<dialog id="attention-sheet"></dialog>"#, "an item no longer in the queue");

    let (status, _, html) = pilot.send(get(&format!("/catalog/scopes/attention/review?item={key}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.contains("Paldean Fates") && html.contains(r#"id="attention-sheet" aria-labelledby="attention-sheet-title" open"#),
        "{html}"
    );
}

#[tokio::test]
async fn parking_an_item_sends_its_reason_and_the_list_offers_restore() {
    let pilot = Pilot::new().await;
    let form = format!(
        "item_key={}&kind=provider-health&reason=Retired+provider",
        percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)
    );
    let (status, headers, _) = pilot.send(post("/catalog/scopes/attention/dismiss?status=active", &form, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/scopes?status=active&after_write="), "{to}");
    assert!(
        to.ends_with(&format!(
            "&done=queued&parked={}",
            percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)
        )) || to.contains("&done=queued&parked=provider-health"),
        "{to}"
    );
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[0].body).unwrap();
    assert_eq!(sent, json!({ "intent": "dismiss", "itemKey": HEALTH, "kind": "provider-health", "reason": "Retired provider" }));

    pilot.send(post("/catalog/scopes/attention/defer", &form, true)).await;
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[1].body).unwrap();
    assert_eq!((sent["intent"].as_str(), sent["deferHours"].as_u64()), (Some("defer"), Some(24)), "{sent}");

    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("Command queued"), "{html}");
    assert!(
        html.contains(&format!(r#"action="/catalog/scopes/attention/restore?status=active" data-patch><input type="hidden" name="item_key" value="{HEALTH}">"#)),
        "{html}"
    );
    pilot
        .send(post(
            "/catalog/scopes/attention/restore",
            &format!("item_key={}", percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)),
            true,
        ))
        .await;
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[2].body).unwrap();
    assert_eq!(sent, json!({ "intent": "restore", "itemKey": HEALTH }));
}

#[tokio::test]
async fn a_park_without_a_reason_or_refused_comes_back_in_its_sheet() {
    let pilot = Pilot::new().await;
    let key = percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, html) = pilot
        .send(post("/catalog/scopes/attention/dismiss", &format!("item_key={key}&kind=provider-health&reason=+"), true))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="attention-panel__park" id="attention-dismiss""#), "the form alone: {html}");
    assert!(html.contains(r#"id="attention-dismiss-reason-error""#) && html.contains("requires an operator reason"), "{html}");
    assert!(pilot.catalog_writes().is_empty(), "nothing sent");

    let (status, _, html) = pilot
        .send(post("/catalog/scopes/attention/defer", &format!("item_key={key}&kind=provider-health&reason=refuse"), false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        html.contains("Parking an attention item requires its kind.") && html.contains("Paldean Fates"),
        "the page, the sheet open: {html}"
    );
    assert!(html.contains(r#"id="attention-sheet" aria-labelledby="attention-sheet-title" open"#), "{html}");

    let (_, _, html) = pilot.send(post("/catalog/scopes/attention/dismiss", "item_key=x&kind=elsewhere&reason=r", true)).await;
    assert!(html.contains("role=\"alert\""), "a kind the queue does not have: {html}");
}

#[tokio::test]
async fn an_alias_candidates_accept_and_reject_post_the_alias_review() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post("/catalog/scopes/attention/alias/accept", "alias_hashes=h1", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().contains("done=queued"));
    pilot.send(post("/catalog/scopes/attention/alias/reject", "alias_hashes=h1&reason=Reject", true)).await;
    let writes = pilot.catalog_writes();
    assert_eq!(writes[0].path, "/api/catalog/alias-review/commands");
    let bodies: Vec<Value> = writes.iter().map(|w| serde_json::from_str(&w.body).unwrap()).collect();
    assert_eq!(
        bodies,
        [
            json!({ "intent": "accept", "aliasHashes": "h1" }),
            json!({ "intent": "reject", "aliasHashes": "h1", "reason": "Reject" })
        ]
    );

    let (_, headers, _) = pilot.send(post("/catalog/scopes/attention/alias/reject", "alias_hashes=h1", true)).await;
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.ends_with("done=failed"), "a reject needs its reason: {to}");
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("Command needs attention"), "{html}");
}

#[tokio::test]
async fn a_queue_the_api_cannot_read_is_its_banner_and_the_list_still_shows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes", Some("queue-down"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Attention queue unavailable") && html.contains("Paldean Fates"), "{html}");
    assert!(!html.contains("data-attention-queue"), "{html}");

    let (status, _, _) =
        pilot.send(get(&format!("/catalog/scopes?after_write={}&done=queued", fresh_receipt()), Some("queue-down"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "after a park, a queue still catching up is the page's preparing answer");
}

// The Operations Attention queue.

/// The queue as the API answers it: `ops-empty` has nothing, `ops-down` fails, any other a
/// critical, a warning and an info item, with one source unavailable.
fn operations_attention(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=ops-down") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.");
    }
    let sources = |wake: Value| {
        json!([
            { "id": "projection-poison-event", "status": "available", "itemCount": 1, "total": "unknown" },
            wake,
            { "id": "support-request-deadline", "status": "available", "itemCount": 1, "total": 1 },
            { "id": "platform-feedback-unreviewed", "status": "available", "itemCount": 1, "total": 1 },
        ])
    };
    if cookie.contains("chase_sets_session=ops-empty") {
        return Json(json!({
            "items": [],
            "rollup": { "total": 0, "bySeverity": { "critical": 0, "warning": 0, "info": 0 }, "bySource": {} },
            "sources": sources(json!({ "id": "wake-stalled-job", "status": "available", "itemCount": 0, "total": "unknown" })),
            "degraded": false,
        }))
        .into_response();
    }
    Json(json!({
        "items": [
            {
                "id": "projection-poison-event:ordering-orders:evt_1",
                "source": "projection-poison-event",
                "entity": "poison-event",
                "severity": "critical",
                "summary": { "code": "poisonEvent", "params": { "eventType": "OrderPlaced", "projectionKey": "ordering-orders", "retryCount": 3 } },
                "deepLink": { "surface": "projection-operations", "href": "/projections?tab=blocked" },
                "dueAt": null,
                "observedAt": "2026-10-25T09:20:00.000Z",
            },
            {
                "id": "support-request-deadline:req_1",
                "source": "support-request-deadline",
                "entity": "support-request",
                "severity": "warning",
                "summary": { "code": "supportRequest", "params": { "reference": "SR-1042" } },
                "deepLink": { "surface": "support-operations", "href": "/requests?requestId=req_1" },
                "dueAt": "2026-10-26T12:00:00.000Z",
                "observedAt": "2026-10-24 08:00:00+00",
            },
            {
                "id": "platform-feedback-unreviewed:pfb_1",
                "source": "platform-feedback-unreviewed",
                "entity": "platform-feedback",
                "severity": "info",
                "summary": { "code": "somethingNew", "params": {} },
                "deepLink": { "surface": "platform-feedback", "href": "/platform-feedback/pfb_1" },
                "observedAt": "2026-10-23T10:00:00.000Z",
            },
        ],
        "rollup": {
            "total": 3,
            "bySeverity": { "critical": 1, "warning": 1, "info": 1 },
            "bySource": { "projection-poison-event": 1, "support-request-deadline": 1, "platform-feedback-unreviewed": 1 },
        },
        "sources": sources(json!({ "id": "wake-stalled-job", "status": "unavailable", "itemCount": 0, "total": "unknown", "reason": "wake status unavailable" })),
        "degraded": true,
    }))
    .into_response()
}

#[tokio::test]
async fn the_attention_queue_draws_its_counts_its_missing_sources_and_its_items_in_the_apis_order() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/operations-attention", Some("ops"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<title>Attention Queue | Chase Sets Admin</title>") && html.contains("<h1>What needs you</h1>"),
        "{html}"
    );
    for (label, count) in [("Total", 3), ("Critical", 1), ("Warning", 1), ("Info", 1)] {
        assert!(html.contains(&format!("<dt>{label}</dt><dd>{count}</dd>")), "{label}: {html}");
    }
    assert!(
        html.contains("Some sources are unavailable") && html.contains("Wake work unavailable: wake status unavailable"),
        "{html}"
    );
    let rows = [
        "Poison event OrderPlaced on ordering-orders (retried 3)",
        "Support case SR-1042 needs review",
        "platformOperations.operationsAttention.summary.somethingNew",
    ];
    let at: Vec<usize> = rows.iter().map(|row| html.find(row).unwrap_or_else(|| panic!("{row}: {html}"))).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "in the API's order: {at:?}");
    assert!(
        html.contains("Oct 25, 2026, 9:20 AM UTC") && html.contains("Oct 24, 2026, 8:00 AM UTC"),
        "an ISO and a Postgres time: {html}"
    );
    assert!(html.contains("Oct 26, 2026, 12:00 PM UTC") && html.contains("No deadline"), "{html}");
    let origin = crate::app::admin_web_origin();
    for path in ["/platform/projections?tab=blocked", "/support/requests?requestId=req_1", "/support/platform-feedback/pfb_1"] {
        assert!(html.contains(&format!(r#"href="{origin}{path}">Open</a>"#)), "{path}: {html}");
    }
    assert!(html.contains(r#"id="attention-live" src="/platform/operations-attention/live""#), "{html}");
    assert!(html.contains(r#"<div id="attention-queue">"#), "{html}");
    assert!(
        html.contains(r#"href="/assets/"#) && html.contains("/sections/platform/operations-attention.css"),
        "the area's own stylesheet: {html}"
    );
    assert!(pilot.calls.lock().unwrap().iter().any(|c| c.path == "/api/platform/operations-attention"
        && c.headers.get(header::COOKIE).is_some_and(|v| v.to_str().unwrap().contains("chase_sets_session=ops"))));

    let mut req = get("/platform/operations-attention", Some("ops"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["queue"]["items"][0]["severity"], "critical", "{body}");
    assert_eq!(body["data"]["queue"]["sources"][1]["reason"], "wake status unavailable", "{body}");
}

#[tokio::test]
async fn the_attention_queue_is_for_staff_who_may_see_projection_operations() {
    let pilot = Pilot::new().await;
    for session in ["catalog-reader", "reader"] {
        let (status, _, _) = pilot.send(get("/platform/operations-attention", Some(session))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{session}");
    }
    let (status, headers, _) = pilot.send(get("/platform/operations-attention", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("/access/sign-in?returnTo=%2Fplatform%2Foperations-attention"));
    assert!(
        !pilot.calls.lock().unwrap().iter().any(|c| c.path == "/api/platform/operations-attention"),
        "refused before the read"
    );
}

#[tokio::test]
async fn an_empty_queue_says_so_and_a_queue_the_api_cannot_read_is_an_error() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/operations-attention", Some("ops-empty"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Nothing needs you") && html.contains("<dt>Total</dt><dd>0</dd>"), "{html}");
    assert!(!html.contains("Some sources are unavailable") && !html.contains("<table"), "{html}");
    let (status, _, _) = pilot.send(get("/platform/operations-attention", Some("ops-down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn the_queue_is_drawn_again_on_a_change_and_stays_when_the_api_refuses_the_topic() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/platform/operations-attention/live", "ops", 2).await;
    assert_eq!(events.len(), 2, "on the stream's opening and its change: {events:?}");
    for (event, data) in &events {
        assert_eq!(event, "patch");
        assert!(
            data.starts_with(r#"<div id="attention-queue">"#) && data.contains("Support case SR-1042 needs review"),
            "{data}"
        );
    }
    let topics: Vec<String> =
        pilot.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/realtime")).map(|c| c.path.clone()).collect();
    assert!(topics.iter().all(|p| p.contains("topic=platform-operations%3Aadmin%3Aoperations-attention")), "{topics:?}");

    let events = pilot.events("/platform/operations-attention/live", "ops-refused", 2).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["end"], "the page's queue stays, and the element stops: {events:?}");
}

#[tokio::test]
async fn a_scopes_page_draws_its_journey_coverage_jobs_and_editions_from_the_catalog_api() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_paf", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let calls: Vec<String> = pilot.catalog_calls().into_iter().map(|c| c.path).collect();
    for path in [
        "/api/catalog/scope-records/scp_paf",
        "/api/catalog/provider-scope-mappings/coverage/scp_paf",
        "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scp_paf",
        "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scp_paf&status=completed",
        "/api/catalog/source-observations/merge-candidate-bulk-jobs/failed?scopeRecordId=scp_paf",
        "/api/catalog/alias-review?targetKind=reference-record&targetId=ref_scp_paf",
    ] {
        assert!(calls.iter().any(|c| c == path), "{path} in {calls:?}");
    }
    assert!(html.contains("Paldean Fates") && html.contains(r#"href="/catalog/scopes""#), "{html}");
    // The journey: a pending Japanese alias is a conflict.
    assert!(html.contains(r#"data-status="current""#), "{html}");
    // The coverage: Confirm canonical record (a draft), Accept all available (map_1 only), each row.
    assert!(html.contains(r#"action="/catalog/scopes/scp_paf/publish""#), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="mapping_ids" value="map_1"><input type="hidden" name="all" value="1">"#),
        "{html}"
    );
    assert!(html.contains("tcgplayer") && html.contains("pokemontcgio") && html.contains("cardmarket"), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="intent" value="revoke">"#), "the mapped row can be revoked: {html}");
    // The jobs: running, failed with its reason, completed with its Catalog Item once, and the next page.
    assert!(html.contains(r#"data-candidate-review-job-id="job_run""#) && html.contains("The candidate moved."), "{html}");
    assert_eq!(html.matches(r#"data-promoted-catalog-item-id="itm_1""#).count(), 1, "{html}");
    assert!(html.contains(r#"href="/catalog/scopes/scp_paf?jobs=c2" rel="next""#), "{html}");
    // The editions: English canonical, Japanese open with its candidate and its commands.
    assert!(html.contains(r#"data-link="pending-review""#) && html.contains("Confidence is below high."), "{html}");
    assert!(html.contains(r#"data-language-edition-command="alias.defer""#), "{html}");
    assert!(html.contains(r#"href="http://localhost:7752/catalog/scopes/scp_paf""#), "the workspace is admin-web's: {html}");
    assert!(
        pilot.stylesheet(&html, "sections/catalog").await.is_some_and(|css| css.contains(".scope-page__stages")),
        "the page's stylesheet is the area's"
    );

    let (_, _, html) = pilot.send(get("/catalog/scopes/scp_paf?jobs=c2", Some("staff"))).await;
    assert!(pilot.catalog_calls().iter().any(|c| c.path.ends_with("&status=completed&cursor=c2")));
    assert!(
        html.contains(r#"href="/catalog/scopes/scp_paf">"#) && !html.contains(r#"rel="next""#),
        "first page, no next: {html}"
    );
}

#[tokio::test]
async fn a_scope_with_one_edition_reads_no_alias_review_and_a_failed_read_is_its_sections_banner() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_one", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!pilot.catalog_calls().iter().any(|c| c.path.contains("alias-review")), "one edition has nothing to review");
    assert!(!html.contains("scope-editions"), "{html}");

    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_down", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "as admin-web's loader degrades them: {html}");
    assert!(html.matches(r#"role="status""#).count() >= 3, "the journey's and both banners: {html}");
    assert!(!html.contains("Accept all"), "no commands over a coverage that could not be read: {html}");

    let (status, _, _) = pilot.send(get("/catalog/scopes/scp_gone", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = pilot.send(get("/catalog/scopes/scp_paf", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed");
}

#[tokio::test]
async fn a_scopes_coverage_writes_send_the_commands_and_redirect_with_the_toast() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=accept&mapping_ids=map_1&all=1", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/scopes/scp_paf?after_write=") && to.ends_with("&done=available_accepted&count=1"), "{to}");
    pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=revoke&mapping_ids=map_2&reason=Wrong+set", true)).await;
    pilot
        .send(post(
            "/catalog/scopes/scp_paf/coverage/propose",
            "provider_key=tcgplayer&unit_key=sv&set_id=sv4pt5&set_name=&confidence=high&accept=1",
            true,
        ))
        .await;
    pilot.send(post("/catalog/scopes/scp_paf/publish", "", true)).await;
    let writes = pilot.catalog_writes();
    let sent: Vec<(String, Value)> =
        writes.iter().map(|w| (w.path.clone(), serde_json::from_str(&w.body).unwrap_or(Value::Null))).collect();
    assert_eq!(
        sent,
        [
            ("/api/catalog/provider-scope-mappings/commands".to_owned(), json!({ "intent": "accept", "mappingIds": ["map_1"] })),
            (
                "/api/catalog/provider-scope-mappings/commands".to_owned(),
                json!({ "intent": "revoke", "mappingIds": ["map_2"], "reason": "Wrong set" })
            ),
            (
                "/api/catalog/provider-scope-mappings/propose".to_owned(),
                json!({ "scopeRecordId": "scp_paf", "providerKey": "tcgplayer", "unitKey": "sv",
                        "coordinates": { "setId": "sv4pt5", "setName": null }, "confidence": "high", "autoAccept": true })
            ),
            ("/api/catalog/reference-records/scp_paf/publish".to_owned(), Value::Null),
        ]
    );
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("1 mappings accepted."), "the toast says how many: {html}");
}

#[tokio::test]
async fn a_scope_write_without_its_reason_or_refused_is_the_page_again_with_the_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=reject&mapping_ids=map_1&reason=+", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"role="alert""#) && html.contains("Paldean Fates"), "{html}");
    assert!(pilot.catalog_writes().is_empty(), "nothing sent");

    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=reject&mapping_ids=map_1&reason=refuse", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The mapping moved meanwhile."), "the API's refusal: {html}");

    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage/propose", "provider_key=tcgplayer&unit_key=", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"value="tcgplayer""#) && html.contains("Enter the provider, the unit"), "the dialog, open: {html}");
    let (status, _, html) = pilot
        .send(post("/catalog/scopes/scp_paf/coverage/propose", "provider_key=refuse&unit_key=u&set_name=Paldean", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The mapping moved meanwhile.") && html.contains(r#"value="refuse""#), "{html}");

    let (status, _, _) = pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=forget&mapping_ids=map_1", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "an intent the form does not offer");
}

#[tokio::test]
async fn an_editions_alias_commands_post_the_alias_review_and_defer_writes_nothing() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.defer&alias_hashes=ah_ja", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert_eq!(to, "/catalog/scopes/scp_paf?done=alias_deferred");
    assert!(pilot.catalog_writes().is_empty(), "chase-sets/chase-sets#10702: defer has no command");
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("stays pending"), "{html}");

    pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.accept&alias_hashes=ah_ja", true)).await;
    pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.reject&alias_hashes=ah_ja&reason=Not+this+set", true)).await;
    let (status, _, _) =
        pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.revoke&alias_hashes=ah_ja", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "a revoke needs its reason");
    let bodies: Vec<Value> = pilot.catalog_writes().iter().map(|w| serde_json::from_str(&w.body).unwrap()).collect();
    assert_eq!(
        bodies,
        [
            json!({ "intent": "accept", "aliasHashes": "ah_ja" }),
            json!({ "intent": "reject", "aliasHashes": "ah_ja", "reason": "Not this set" }),
        ]
    );
}

#[tokio::test]
async fn a_catalog_viewer_sees_a_scope_without_its_commands_and_cannot_write() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_paf", Some("catalog-viewer"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("/catalog/scopes/scp_paf/coverage") && !html.contains("/publish"), "{html}");
    assert!(html.contains(r#"data-language-edition-command="alias.accept""#), "{html}");
    assert!(html.contains(r#"<button type="submit" class="#) && html.contains(" disabled>"), "off, as admin-web's: {html}");
    let (status, _, _) = pilot.send(post_as("catalog-viewer", "/catalog/scopes/scp_paf/publish", "", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.manage is needed");
    assert!(pilot.catalog_writes().is_empty());
}

// Projection Operations (/platform/projections).

const GROUP_KEY: &str = "settlement-fulfillment-source-projection:fulfillment:v2";

fn projection_operation(id: &str, kind: &str, state: &str, updated_at: &str) -> Value {
    json!({
        "operationId": id,
        "operationKind": kind,
        "state": state,
        "contextName": "settlement",
        "projectionName": "settlement-fulfillment-source-projection",
        "projectionKey": null,
        "streamId": null,
        "requestedByUserId": "usr_1",
        "claimOwnerId": null,
        "requestedAt": "2026-10-28T10:00:00.000Z",
        "startedAt": null,
        "updatedAt": updated_at,
        "completedAt": null,
        "error": if state == "failed" { json!({ "message": "Rebuild failed." }) } else { Value::Null },
    })
}

/// The console as the API answers it: a degraded group with blocked streams and poison events
/// (sent as counts only, as the API does: chase-sets/chase-sets#10710), a running operation and a
/// failed one, and the API's triage of them.
fn projections_console() -> Value {
    json!({
        "summary": { "status": "degraded", "totalGroups": 2, "runningGroups": 0, "outstandingEventCount": "12345" },
        "projectionGroups": [
            {
                "projectionName": "settlement-fulfillment-source-projection",
                "projectionRevision": 2,
                "storedProjectionRevision": 1,
                "revisionStale": false,
                "targetContextName": "settlement",
                "sourceContextNames": ["fulfillment"],
                "ownedTables": ["settlement_order_fulfillment_sources"],
                "requiredDuringBootstrap": false,
                "initialized": true,
                "caughtUp": false,
                "state": "degraded",
                "lastError": null,
                "outstandingEventCount": "0",
                "sourceLagEventCount": "0",
                "applicableLagEstimate": "0",
                "blockedStreamCount": 1,
                "poisonEventCount": 1,
                "updatedAt": "2026-10-28T10:00:00.000Z",
                "subscriptions": [{
                    "checkpointKey": GROUP_KEY,
                    "sourceContextName": "fulfillment",
                    "targetContextName": "settlement",
                    "subscriptionVersion": 2,
                    "lastGlobalPosition": "47",
                    "sourceHeadGlobalPosition": "47",
                    "outstandingEventCount": "0",
                    "state": "degraded",
                    "lastError": null,
                    "blockedStreamCount": 1,
                    "poisonEventCount": 1
                }]
            },
            {
                "projectionName": "auth-session-projection",
                "projectionRevision": 1,
                "storedProjectionRevision": 1,
                "targetContextName": "auth",
                "state": "caught-up",
                "caughtUp": true,
                "initialized": true,
                "outstandingEventCount": "0",
                "blockedStreamCount": 0,
                "poisonEventCount": 0,
                "updatedAt": "2026-10-28T10:00:00.000Z",
                "subscriptions": []
            }
        ],
        "blockedProjections": [{ "projectionKey": GROUP_KEY, "blockedStreamCount": 1, "poisonEventCount": 1 }],
        "projectionStatusSource": "worker-snapshot",
        "workers": [{ "worker_id": "platform-worker-1", "worker_kind": "platform-worker", "worker_state": "active" }],
        "workerHeartbeatHistory": { "expiredWithinDiagnosticWindowCount": 16 },
        "runners": [],
        "operations": [
            projection_operation("op_run", "rebuild-projection-group", "running", "2026-10-28T10:01:00.000Z"),
            projection_operation("op_fail", "rebuild-context", "failed", "2026-10-28T09:00:00.000Z"),
        ],
        "operationSummary": { "queuedCount": "0", "runningCount": "1", "failedCount": "1", "cancelRequestedCount": "0" },
        "attentionItems": [
            { "id": "degraded-groups", "label": "Degraded projection groups", "detail": "One or more projection groups report degraded or error state.", "tone": "danger", "count": 1, "targetTab": "groups" },
            { "id": "failed-operations", "label": "Failed operations", "detail": "Projection work reached a terminal failure.", "tone": "danger", "count": 1, "targetTab": "operations" }
        ],
        "repairQueue": [
            { "kind": "operation", "targetId": "op_fail", "label": "rebuild-context", "detail": "settlement", "state": "failed", "tone": "danger", "contextName": "settlement" },
            { "kind": "projection-group", "targetId": "settlement:settlement-fulfillment-source-projection", "label": "settlement-fulfillment-source-projection", "detail": "settlement projection group; poison events: 1; blocked streams: 1", "state": "degraded", "tone": "warning", "contextName": "settlement", "projectionName": "settlement-fulfillment-source-projection" }
        ],
        "activeWorkerCount": 1,
        "staleWorkerCount": 0
    })
}

/// The projections API. `projections-down` fails the console's read, `projections-nowake` the wake
/// read; staff who may only look are refused every write, as the API refuses them. A rebuild
/// without its confirm word is refused, as the API refuses it.
fn projections_api(method: &Method, rest: &str, cookie: &str, body: &str) -> Response {
    let view_only = !cookie.contains("chase_sets_session=projections-operator");
    let queued = |id: &str, kind: &str| {
        let operation = projection_operation(id, kind, "queued", "2026-10-28T10:10:00.000Z");
        (StatusCode::ACCEPTED, Json(json!({ "operation": operation }))).into_response()
    };
    match (method.clone(), rest) {
        (Method::GET, "") if cookie.contains("chase_sets_session=projections-down") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.")
        }
        (Method::GET, "") => Json(projections_console()).into_response(),
        (Method::GET, "/wake-status") if cookie.contains("chase_sets_session=projections-nowake") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.")
        }
        (Method::GET, "/wake-status") => Json(json!({
            "generatedAt": "2026-10-28T10:00:00.000Z",
            "attentionItems": [{ "id": "wake-failed", "label": "Failed wake intents", "detail": "Wake intents failed.", "tone": "warning", "targetTab": "wake" }]
        }))
        .into_response(),
        (Method::GET, "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams") => Json(json!({
            "projectionKey": GROUP_KEY,
            "blockedStreams": [{
                "projectionKey": GROUP_KEY,
                "streamId": "fulfillment.shipment-shp_1",
                "firstBlockedGlobalPosition": "11",
                "firstBlockedStreamVersion": 5,
                "lastSeenGlobalPosition": "12",
                "deferredEventCount": 1,
                "state": "blocked"
            }],
            "poisonEvents": [{
                "projectionKey": GROUP_KEY,
                "eventId": "evt_1",
                "eventType": "fulfillment.shipment.label-attached",
                "streamId": "fulfillment.shipment-shp_1",
                "streamVersion": 5,
                "globalPosition": "11",
                "errorMessage": "Label postage activation was not read.",
                "retryCount": 0,
                "firstSeenAt": "2026-10-24T03:56:21.724Z",
                "lastSeenAt": "2026-10-24T03:56:21.724Z",
                "state": "blocked"
            }]
        }))
        .into_response(),
        (Method::GET, "/operations/op_run/events") => {
            let event = |id: u32, operation: Value| format!("id: {id}\nevent: job.progress\ndata: {operation}\n\n");
            let body = [
                event(1, projection_operation("op_run", "rebuild-projection-group", "running", "2026-10-28T10:01:00.000Z")),
                event(2, projection_operation("op_run", "rebuild-projection-group", "succeeded", "2026-10-28T10:05:00.000Z")),
            ]
            .concat();
            ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
        }
        (Method::POST, _) if view_only => refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "Forbidden."),
        (Method::POST, "/refresh") => Json(json!({ "summary": {}, "projectionGroups": [] })).into_response(),
        (Method::POST, "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams/fulfillment.shipment-shp_1/retry") => {
            queued("op_retry", "retry-blocked-stream")
        }
        (Method::POST, "/groups/settlement/settlement-fulfillment-source-projection/rebuild") if body.contains(r#""confirm":"rebuild""#) => {
            queued("op_rebuild", "rebuild-projection-group")
        }
        (Method::POST, "/groups/settlement/rebuild") if body.contains(r#""confirm":"rebuild-all""#) => queued("op_context", "rebuild-context"),
        (Method::POST, "/operations/op_run/cancel") => Json(json!({ "result": { "cancelled": true } })).into_response(),
        (Method::POST, _) => refusal(StatusCode::BAD_REQUEST, "confirmation_required", "Confirm."),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

impl Pilot {
    fn projection_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/platform/projections")).cloned().collect()
    }
}

#[tokio::test]
async fn projection_operations_draws_the_apis_console_and_triage() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/projections", Some("projections-operator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<h1>Projection Operations</h1>")
            && html.contains("<title>Projection Operations | Chase Sets Admin</title>"),
        "{html}"
    );
    assert!(html.contains(r#"href="/platform/projections" aria-current="page""#), "the nav entry is the pilot's: {html}");
    assert!(html.contains("/sections/platform/projections.css"), "the area's own stylesheet: {html}");
    // The API's and the wake read's attention: a danger item makes the console Needs attention.
    for text in
        ["Needs attention", "Source: worker-snapshot", "Degraded projection groups", "Failed operations", "Failed wake intents"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    // The counts: three attention items, the source lag grouped, the API's worker counts.
    assert!(html.contains("<dt>Attention</dt><dd>3</dd>"), "{html}");
    assert!(html.contains("12,345"), "grouped as admin-web's formatDecimalCount: {html}");
    assert!(html.contains("1 active · 0 stale"), "{html}");
    assert!(html.contains("16 expired heartbeats in the last 7 days"), "{html}");
    // The API's repair queue in its order, and the operations most urgent first.
    let failed = html.find("rebuild-context").unwrap();
    let group = html.find("settlement projection group; poison events: 1; blocked streams: 1").unwrap();
    assert!(failed < group, "the API's order");
    assert!(html.contains(r#"href="/platform/projections?selected=op_fail""#), "{html}");
    assert!(
        html.contains("contextName=settlement&amp;projectionName=settlement-fulfillment-source-projection"),
        "the group's reference on admin-web: {html}"
    );
    let ops = &html[html.find("projections-operations-title").unwrap()..];
    assert!(ops.find("op_fail").unwrap() < ops.find("op_run").unwrap(), "failed before running");
    // Staff who may operate get Refresh status, and the console follows the running operation.
    assert!(html.contains(r#"action="/platform/projections/refresh""#) && html.contains("Refresh status"), "{html}");
    assert!(html.contains(r#"src="/platform/projections/live""#), "{html}");
    assert!(
        html.contains(r#"href="/catalog/dimensions""#) && html.contains("/access/accounts"),
        "Catalog and Identity for who may see them"
    );
    assert!(!html.contains("<dialog"), "nothing selected, no sheet");
    assert!(!pilot.projection_calls().iter().any(|c| c.path.contains("/blocked-streams")), "no detail read without a selection");

    // Staff who may only look: no Refresh, no Catalog.
    let (status, _, html) = pilot.send(get("/platform/projections", Some("ops"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("/platform/projections/refresh") && !html.contains(r#"href="/catalog/dimensions""#), "{html}");
}

#[tokio::test]
async fn projection_operations_is_for_staff_who_may_see_it_and_survives_a_failed_wake_read() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/projections", Some("staff"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "postage and catalog staff do not see projections");
    let (status, headers, _) = pilot.send(get("/platform/projections", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("/access/sign-in?returnTo=%2Fplatform%2Fprojections"));
    let (status, _, html) = pilot.send(get("/platform/projections", Some("projections-nowake"))).await;
    assert_eq!(status, StatusCode::OK, "the console without the wake read's items, as admin-web: {html}");
    assert!(!html.contains("Failed wake intents") && html.contains("Degraded projection groups"), "{html}");
    let (status, _, _) = pilot.send(get("/platform/projections", Some("projections-down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn projection_operations_filters_the_queue_and_the_operations() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/platform/projections?state=failed", Some("ops"))).await;
    assert!(html.contains("State: failed"), "the applied filter as a chip: {html}");
    assert!(html.contains(r#"<option value="failed" selected>failed</option>"#), "{html}");
    assert!(!html.contains("settlement projection group;"), "the degraded group is filtered out: {html}");
    let ops = &html[html.find("projections-operations-title").unwrap()..];
    assert!(ops.contains("op_fail") && !ops.contains("op_run"), "{ops}");
    // The details link keeps the filters.
    assert!(html.contains(r#"href="/platform/projections?state=failed&amp;selected=op_fail""#), "{html}");
    let (_, _, html) = pilot.send(get("/platform/projections?search=AUTH&context_name=auth", Some("ops"))).await;
    assert!(html.contains("No attention signals") && html.contains("Search: AUTH") && html.contains("Context: auth"), "{html}");
    assert!(html.contains(r#"<option value="auth" selected>auth</option>"#), "the contexts are the groups': {html}");
}

#[tokio::test]
async fn a_selected_record_opens_its_sheet_with_the_repairs_the_viewer_may_make() {
    let pilot = Pilot::new().await;
    // A running operation: Cancel for staff who may operate.
    let (_, _, html) = pilot.send(get("/platform/projections?selected=op_run", Some("projections-operator"))).await;
    assert!(html.contains("<dialog") && html.contains("rebuild-projection-group / running"), "{html}");
    assert!(html.contains("connect:ui.dialog.modalClosedBy($t,@back,$s)"), "Escape goes to the close link's address: {html}");
    assert!(
        html.contains(r#"action="/platform/projections/cancel?selected=op_run""#)
            && html.contains(r#"name="operation_id" value="op_run""#),
        "{html}"
    );
    assert!(html.contains(r#"href="/platform/projections" aria-label="Close projection detail""#), "closed by a link: {html}");
    let (_, _, html) = pilot.send(get("/platform/projections?selected=op_run", Some("ops"))).await;
    assert!(
        html.contains("<dialog") && !html.contains("/platform/projections/cancel"),
        "no Cancel for who may only look: {html}"
    );
    assert!(!pilot.projection_calls().iter().any(|c| c.path.contains("/blocked-streams")), "an operation needs no detail read");

    // A group: Rebuild and Rebuild context, each confirmed in its dialog, and its blocked streams
    // and poison events, read from the projection's own read (chase-sets/chase-sets#10710).
    let group = "/platform/projections?selected=settlement%3Asettlement-fulfillment-source-projection";
    let (_, _, html) = pilot.send(get(group, Some("projections-operator"))).await;
    assert!(html.contains("settlement.settlement-fulfillment-source-projection"), "{html}");
    assert!(
        html.contains(r#"command="show-modal""#)
            && html.contains("Queue rebuild")
            && html.contains(r#"action="/platform/projections/rebuild-context"#),
        "{html}"
    );
    assert!(html.contains("1 -&gt; 2") || html.contains("1 -> 2"), "the revision range: {html}");
    assert!(html.contains("selected=poison-event%3Aevt_1") && html.contains("fulfillment.shipment-shp_1"), "{html}");
    assert!(pilot.projection_calls().iter().any(|c| c.path.ends_with("%3Afulfillment%3Av2/blocked-streams")));

    // A poison event: Retry its stream.
    let (_, _, html) = pilot.send(get("/platform/projections?selected=poison-event%3Aevt_1", Some("projections-operator"))).await;
    assert!(
        html.contains("Label postage activation was not read.") && html.contains(r#"action="/platform/projections/retry"#),
        "{html}"
    );
    assert!(html.contains(r#"name="stream_id" value="fulfillment.shipment-shp_1""#), "{html}");
    // A blocked stream, and a record that is gone.
    let blocked =
        "/platform/projections?selected=settlement-fulfillment-source-projection%3Afulfillment%3Av2%3Afulfillment.shipment-shp_1";
    let (_, _, html) = pilot.send(get(blocked, Some("projections-operator"))).await;
    assert!(
        html.contains("<dialog")
            && html.contains(r#"name="projection_key" value="settlement-fulfillment-source-projection:fulfillment:v2""#),
        "{html}"
    );
    let (status, _, html) = pilot.send(get("/platform/projections?selected=gone", Some("projections-operator"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("<dialog"), "{html}");
}

#[tokio::test]
async fn each_projection_repair_goes_to_the_api_and_back_to_the_console_as_it_was() {
    let pilot = Pilot::new().await;
    let cases = [
        ("/platform/projections/refresh?state=failed", "", "/refresh", "{}"),
        (
            "/platform/projections/retry?selected=poison-event%3Aevt_1",
            "projection_key=settlement-fulfillment-source-projection%3Afulfillment%3Av2&stream_id=fulfillment.shipment-shp_1",
            "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams/fulfillment.shipment-shp_1/retry",
            "{}",
        ),
        (
            "/platform/projections/rebuild?selected=settlement%3Asettlement-fulfillment-source-projection",
            "context_name=settlement&projection_name=settlement-fulfillment-source-projection",
            "/groups/settlement/settlement-fulfillment-source-projection/rebuild",
            r#"{"confirm":"rebuild"}"#,
        ),
        (
            "/platform/projections/rebuild-context",
            "context_name=settlement",
            "/groups/settlement/rebuild",
            r#"{"confirm":"rebuild-all"}"#,
        ),
        ("/platform/projections/cancel?selected=op_run", "operation_id=op_run", "/operations/op_run/cancel", "{}"),
    ];
    for (uri, body, api, sent) in cases {
        let (status, headers, html) = pilot.send(post_as("projections-operator", uri, body, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{uri}: {html}");
        let back = uri.replacen(uri.split('?').next().unwrap(), "/platform/projections", 1);
        assert_eq!(headers[header::LOCATION], back.as_str(), "{uri}: back to the console as it was");
        let call = pilot.projection_calls().into_iter().rev().find(|c| c.method == Method::POST).unwrap();
        assert_eq!(call.path, format!("/api/platform/projections{api}"), "{uri}");
        assert_eq!(call.body, sent, "{uri}");
    }
    // The API refuses who may only look: the page says so.
    let (status, _, html) =
        pilot.send(post_as("ops", "/platform/projections/rebuild-context", "context_name=settlement", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{html}");
}

#[tokio::test]
async fn the_console_is_drawn_again_when_a_running_operation_changes_state() {
    let pilot = Pilot::new().await;
    // The stream's first record is the state the page has (running): nothing. The second
    // (succeeded) draws the health, the repair queue and the operations again from a new read.
    let events = pilot.events("/platform/projections/live", "projections-operator", 3).await;
    let patches: Vec<&(String, String)> = events.iter().filter(|(event, _)| event == "patch").collect();
    assert_eq!(patches.len(), 1, "{events:?}");
    let html = &patches[0].1;
    for id in [r#"id="projections-health""#, r#"id="projections-repair""#, r#"id="projections-operations""#] {
        assert!(html.contains(id), "{id}: {html}");
    }
    assert!(!html.contains(r#"method="get""#), "the filters are not drawn again: {html}");
    assert_eq!(events.last().unwrap().0, "end", "the stream ends once the operation is done: {events:?}");
}
