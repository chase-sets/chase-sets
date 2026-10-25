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
        } else if cookie.contains("chase_sets_session=catalog-reader") {
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
    if let Some(rest) = uri.path().strip_prefix(CATALOG) {
        return catalog_api(method, rest, &body);
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

/// The Catalog API, as far as the area uses it. A dimension list has 120 rows (three pages).
fn catalog_api(method: Method, rest: &str, body: &str) -> Response {
    match (method, rest) {
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
        (Method::POST | Method::PUT, _) => written(StatusCode::OK, "cmd"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The platform's realtime stream: a heartbeat and one change, then the stream ends (the client
/// connects again). It refuses `catalog-reader`, standing in for a session the API will not stream.
fn realtime(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=catalog-reader") {
        return refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "Forbidden.");
    }
    let patch = r#"{"kind":"projection.patch","context":"catalog","projection":"catalog-dimensions","topics":["catalog:admin:dimensions"],"changes":[{"op":"summary","entity":"catalog.adminProjection","id":"dimensions:x","value":{}}]}"#;
    let body = format!("id: c1\nevent: heartbeat\ndata: {{}}\nretry: 1000\n\nid: c2\nevent: projection.patch\ndata: {patch}\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

impl Pilot {
    /// The first `count` server-sent events of a stream at `uri` (their `event:` and `data:`), or
    /// what came before it ended.
    async fn events(&self, uri: &str, session: &str, count: usize) -> Vec<(String, String)> {
        let res = self.router.clone().oneshot(get(uri, Some(session))).await.unwrap();
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
                    events.push((event, field("data: ")));
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
    assert!(html.contains(r#"id="numeric_value-error""#), "{html}");
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
        html.contains(r#"<corten-live src="/catalog/dimensions/live?status=active&amp;page=2"><div id="catalog-rows">"#),
        "the rows are live, with the list's filters and page: {html}"
    );
    let before = pilot.catalog_calls().len();

    // On open, on the change, and on the change the stream sends again after it reconnects.
    let events = pilot.events("/catalog/dimensions/live?status=active&page=2", "staff", 3).await;
    assert_eq!(events.len(), 3, "{events:?}");
    for (event, data) in &events {
        assert_eq!(event, "patch");
        assert!(data.starts_with(r#"<div id="catalog-rows">"#) && data.contains("/catalog/dimensions/dim_seed"), "{data}");
        assert!(data.contains("Page 2 of 3") && !data.contains("<form"), "only the rows and pager, not the filters: {data}");
    }
    let reads: Vec<_> = pilot.catalog_calls()[before..].iter().map(|c| c.path.clone()).collect();
    assert_eq!(reads, vec!["/api/catalog/dimensions?status=active&limit=50&offset=50"; 3], "the same list each time");

    let streams = pilot.calls_to("/api/realtime/");
    assert_eq!(streams[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions");
    assert_eq!(streams[0].headers[header::COOKIE], "chase_sets_session=staff", "as the signed-in user");
    assert_eq!(streams[1].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions&cursor=c2", "it resumes");
}

#[tokio::test]
async fn a_live_list_ends_when_the_api_refuses_its_stream() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/catalog/fields/live", "catalog-reader", 3).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["patch", "end"], "the rows once, then the element stops: {events:?}");
    assert!(events[0].1.contains("/catalog/fields/fld_seed"), "{events:?}");
}
