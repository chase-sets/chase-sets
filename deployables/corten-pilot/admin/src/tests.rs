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
    if uri.path() == "/api/catalog/scope-records" {
        return scope_records(uri.query().unwrap_or_default());
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
    let (status, _, _) = pilot.send(get("/commerce/postage-policies", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/commerce/postage-policies", Some("down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "a failed lookup must not send the user to sign in again");
    assert!(pilot.policy_calls().is_empty());
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
            "/dimensions/bulk-lifecycle/preview" | "/fields/bulk-lifecycle/preview" | "/items/bulk-lifecycle/preview",
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
            "/dimensions/bulk-lifecycle/confirm" | "/fields/bulk-lifecycle/confirm" | "/items/bulk-lifecycle/confirm",
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
        (Method::POST | Method::PUT | Method::DELETE, _) => written(StatusCode::OK, "cmd"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The platform's realtime stream: a heartbeat and one change, then the stream ends (the client
/// connects again). It refuses `catalog-reader`, standing in for a session the API will not stream
/// (`catalog-viewer` has the same permissions and is streamed).
fn realtime(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=catalog-reader") {
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
            r#"connect:bulk_rows.drawn({form:@form,count:@count,preview:@preview,clear:@clear},{matching:&quot;120 matching Dimensions&quot;,entity:&quot;Dimensions&quot;,selected:%[&quot;&quot;,&quot;count&quot;,&quot; &quot;,&quot;entity_name&quot;,&quot; selected&quot;]})"#
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
            r#"<corten-live data-scope="live-status" id="catalog-live" src="/catalog/catalog-items/live?status=draft" data-on="connect:live_status.stale($c,@since,%[&quot;Stale since &quot;,&quot;value&quot;,&quot;&quot;]) corten-status:live_status.stale($t,@since,%[&quot;Stale since &quot;,&quot;value&quot;,&quot;&quot;])"><div class="live-status__status""#
        ),
        "the stream's connection status, in the element that streams: {html}"
    );
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
    assert!(
        html.contains(r#"href="http://localhost:7752/catalog/scopes/scp_paf">View</a>"#),
        "the scope's page is admin-web's: {html}"
    );
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
