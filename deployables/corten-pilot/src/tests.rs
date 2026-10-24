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
            Json(json!({ "actor": { "userId": "usr_1", "roleKey": "platform_admin", "permissions": permissions } }))
                .into_response()
        };
        return if cookie.contains("chase_sets_session=staff") {
            actor(&["postage-policies.view"])
        } else if cookie.contains("chase_sets_session=reader") {
            actor(&[])
        } else if cookie.contains("chase_sets_session=down") {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        } else {
            refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in.")
        };
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
    let mut req = Request::post(uri)
        .header(header::HOST, "localhost:7790")
        .header(header::COOKIE, "chase_sets_session=staff")
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

/// Access is checked in each handler (Corten has no guard for a set of routes), so every route
/// is tried: none reads or writes for a visitor who is not signed in or may not see the screen.
#[tokio::test]
async fn every_route_checks_access_before_it_calls_the_api() {
    let pilot = Pilot::new().await;
    let policy = create_body("Draft", "8");
    let writes = [
        ("", policy.as_str()),
        ("/opp_seed/revise", policy.as_str()),
        ("/opp_seed/preview", policy.as_str()),
        ("/opp_seed/activate", "label=Default&activation_reason=Reviewed"),
        ("/opp_seed/retire", "label=Default&retirement_reason=Done"),
        ("/opp_seed/clone", "clone_label=Rollback&clone_effective_from=2026-01-01"),
    ];
    for session in [None, Some("reader")] {
        let (status, _, _) = pilot.send(get("/commerce/postage-policies/opp_seed", session)).await;
        assert_eq!(status, if session.is_none() { StatusCode::SEE_OTHER } else { StatusCode::FORBIDDEN }, "open {session:?}");
        for (path, body) in writes {
            let mut req = post(&format!("/commerce/postage-policies{path}"), body, false);
            req.headers_mut().remove(header::COOKIE);
            if let Some(session) = session {
                req.headers_mut().insert(header::COOKIE, format!("chase_sets_session={session}").parse().unwrap());
            }
            let (status, headers, _) = pilot.send(req).await;
            match session {
                None => {
                    assert_eq!(status, StatusCode::SEE_OTHER, "{path}");
                    assert!(headers[header::LOCATION].to_str().unwrap().contains("/access/sign-in"), "{path}");
                }
                Some(_) => assert_eq!(status, StatusCode::FORBIDDEN, "{path}"),
            }
        }
    }
    assert!(pilot.policy_calls().is_empty(), "{:?}", pilot.policy_calls());
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
    assert!(html.contains(r#"id="max_letter_units-error""#) && html.contains(r#"aria-invalid="true""#), "{html}");
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
    assert!(html.contains(r#"id="activation_reason-error""#), "{html}");
    assert!(!pilot.policy_calls().iter().any(|c| c.method == Method::POST));
}
