//! Router tests against a stand-in platform API: who may read and write, what the pilot sends,
//! and how a write that may or may not have been applied is confirmed.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

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
    recovery::new_attempt,
};

const LOCATIONS: &str = "/api/inventory/storage-locations";
const ATTEMPTS: &str = "/api/inventory/mutation-attempts/";
const SCREEN: &str = "/account/inventory/locations";
const RECEIPT: &str = r#"[{"sourceContextName":"inventory","maxGlobalPosition":"42","eventIds":["e1"]}]"#;

/// A call the stand-in received.
#[derive(Clone, Debug)]
struct Call {
    method: Method,
    path: String,
    headers: HeaderMap,
    body: String,
}

/// What the stand-in received, and the attempts it applied (id to family and target).
#[derive(Clone, Default)]
struct Stand {
    calls: Arc<Mutex<Vec<Call>>>,
    applied: Arc<Mutex<HashMap<String, (String, String)>>>,
}

fn location(id: &str, name: &str, archived: bool) -> Value {
    json!({
        "storage_location_id": id,
        "name": name,
        "description": null,
        "ship_from_code": "MAIN",
        "ship_from_address": {
            "name": "Synthetic Seller", "company": null, "line1": "1 Test Way", "line2": null, "city": "Austin",
            "state": "TX", "postalCode": "78701", "country": "US", "phone": null, "email": null,
        },
        "is_archived": archived,
    })
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

fn written(status: StatusCode, id: &str) -> Response {
    let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
    (status, headers, Json(json!({ "storage_location_id": id }))).into_response()
}

/// The commit position a read waits for, if it sends a receipt.
fn waits_for(headers: &HeaderMap) -> Option<String> {
    let sent = headers.get("chase-sets-read-after-write")?.to_str().ok()?;
    let sent: Value = serde_json::from_str(&percent_encoding::percent_decode_str(sent).decode_utf8().ok()?).ok()?;
    sent["commitPosition"].as_str().map(str::to_owned)
}

/// The platform API, as far as the screen uses it. The session cookie's value says who is
/// asking: `seller` may read and write, `reader` may only read, `other` reads nothing, `down`
/// makes the lookup fail. A write named `Refused` is refused, `Broken` fails, and a write that
/// repeats an applied attempt with other fields is refused as the API refuses it. A read that
/// waits for position 43 is still catching up; one that waits for 44 fails.
async fn platform(State(stand): State<Stand>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    stand.calls.lock().unwrap().push(Call {
        method: method.clone(),
        path: uri.to_string(),
        headers: headers.clone(),
        body: body.clone(),
    });
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let session = cookie.strip_prefix("chase_sets_session=").unwrap_or_default();
    if uri.path() == "/api/auth/session" {
        let actor = |permissions: &[&str]| {
            Json(json!({ "actor": { "userId": "usr_seller", "accountId": "acc_seller", "roleKey": "seller", "permissions": permissions } }))
                .into_response()
        };
        return match session {
            "seller" => actor(&["inventory.view", "inventory.manage"]),
            "reader" => actor(&["inventory.view"]),
            "other" => actor(&[]),
            "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in."),
        };
    }
    if let Some(id) = uri.path().strip_prefix(ATTEMPTS) {
        return match stand.applied.lock().unwrap().get(id) {
            Some((family, target)) => Json(json!({
                "version": 1, "family": family, "targetId": target, "result": {}, "completedAt": "2026-10-24T00:00:00.000Z",
            }))
            .into_response(),
            None => refusal(StatusCode::NOT_FOUND, "inventory_attempt_unavailable", "Inventory result is unavailable."),
        };
    }
    let Some(rest) = uri.path().strip_prefix(LOCATIONS) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if method == Method::GET {
        return match waits_for(&headers).as_deref() {
            Some("43") => refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            ),
            Some("44") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => Json(json!({ "items": [location("loc_main", "Main shelf", false), location("loc_old", "Old bin", true)] }))
                .into_response(),
        };
    }
    let attempt = headers.get("inventory-mutation-attempt").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let command: Value = serde_json::from_str(&body).unwrap_or_default();
    let (family, target) = match (&method, rest) {
        (&Method::POST, "") => ("location-create", "draft".to_owned()),
        (&Method::PATCH, id) if command["isArchived"] == true => ("location-archive", id[1..].to_owned()),
        (&Method::PATCH, id) => ("location-update", id[1..].to_owned()),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    if stand.applied.lock().unwrap().contains_key(&attempt) {
        return refusal(
            StatusCode::CONFLICT,
            "inventory_attempt_conflict",
            "This change was already submitted with other values.",
        );
    }
    match command["name"].as_str() {
        Some("Refused") => {
            return refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "Ship-from code is already in use.");
        }
        Some("Broken") => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => {}
    }
    stand.applied.lock().unwrap().insert(attempt, (family.into(), target.clone()));
    if family == "location-create" { written(StatusCode::CREATED, "loc_new") } else { written(StatusCode::OK, &target) }
}

/// The pilot, in front of a stand-in API on a loopback port.
struct Pilot {
    router: Router,
    stand: Stand,
}

impl Pilot {
    async fn new() -> Self {
        let stand = Stand::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stand_in = Router::new().fallback(platform).with_state(stand.clone());
        tokio::spawn(async move { corten::axum::serve(listener, stand_in).await.unwrap() });
        let router = app(Config { platform: Platform::new(&origin), proto: "http" }).router();
        Pilot { router, stand }
    }

    async fn send(&self, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
    }

    /// The calls to the Inventory API (the session lookups left out).
    fn inventory_calls(&self) -> Vec<Call> {
        self.stand.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/inventory/")).cloned().collect()
    }

    fn writes(&self) -> Vec<Call> {
        self.inventory_calls().into_iter().filter(|c| c.method != Method::GET).collect()
    }
}

fn get(uri: &str, session: Option<&str>) -> Request<Body> {
    let mut req = Request::get(uri).header(header::HOST, "localhost:7791");
    if let Some(session) = session {
        req = req.header(header::COOKIE, format!("chase_sets_session={session}"));
    }
    req.body(Body::empty()).unwrap()
}

/// The screen as a data client reads it.
fn get_json(uri: &str) -> Request<Body> {
    let mut req = get(uri, Some("seller"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    req
}

/// A form post as the runtime sends it (`corten: action`), or as a browser without JavaScript.
fn post(uri: &str, session: &str, body: &str, script: bool) -> Request<Body> {
    let mut req = Request::post(uri)
        .header(header::HOST, "localhost:7791")
        .header(header::COOKIE, format!("chase_sets_session={session}"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if script {
        req = req.header("corten", "action");
    }
    req.body(Body::from(body.to_owned())).unwrap()
}

/// A location form's body with every required field, named `name`.
fn location_body(attempt: &str, name: &str) -> String {
    format!(
        "attempt={attempt}&name={name}&description=&ship_from_code=MAIN&ship_from_name=Synthetic+Seller&ship_from_company=\
         &ship_from_line1=1+Test+Way&ship_from_line2=&ship_from_city=Austin&ship_from_state=TX&ship_from_postal_code=78701\
         &ship_from_country=&ship_from_phone=&ship_from_email=+"
    )
}

fn receipt_at(position: &str) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let receipt = format!(r#"{{"observedAtMs":{now},"commitPosition":"{position}","sources":{RECEIPT}}}"#);
    percent_encoding::utf8_percent_encode(&receipt, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// The query parameters of a URL the pilot sent the browser to.
fn query(to: &str) -> HashMap<String, String> {
    let (_, query) = to.split_once('?').unwrap_or_default();
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_owned(), percent_encoding::percent_decode_str(v).decode_utf8().unwrap().into_owned()))
        .collect()
}

/// A write form's attempt input (the check form's has a ref first).
const ATTEMPT_INPUT: &str = r#"<input type="hidden" name="attempt" value=""#;

/// The attempt a write form in `html` was drawn with (the first one).
fn drawn_attempt(html: &str) -> String {
    let at = html.find(ATTEMPT_INPUT).expect("a write form") + ATTEMPT_INPUT.len();
    html[at..].split('"').next().unwrap().to_owned()
}

#[tokio::test]
async fn a_signed_out_visitor_signs_in_through_marketplace() {
    let pilot = Pilot::new().await;
    for session in [None, Some("expired")] {
        let (status, headers, _) = pilot.send(get(SCREEN, session)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{session:?}");
        assert_eq!(
            headers[header::LOCATION],
            "http://localhost:7753/sign-in?returnTo=%2Faccount%2Finventory%2Flocations",
            "{session:?}"
        );
    }
    assert!(pilot.inventory_calls().is_empty(), "nothing is read for a visitor who is not signed in");
}

#[tokio::test]
async fn reading_needs_inventory_view_writing_needs_inventory_manage() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get(SCREEN, Some("other"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) = pilot.send(get(SCREEN, Some("reader"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (status, _, _) = pilot.send(post(SCREEN, "reader", &location_body(&new_attempt(), "Shelf"), true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get(SCREEN, Some("down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "a failed lookup must not send the user to sign in again");
    assert!(pilot.writes().is_empty(), "the refused write reached nothing");
}

#[tokio::test]
async fn the_list_shows_archived_locations_and_data_clients_get_the_screen() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(SCREEN, Some("seller"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Main shelf") && html.contains("Old bin"), "{html}");
    // The create form, both save forms and the active location's archive form, each its own attempt.
    let mut attempts: Vec<_> = html.split(ATTEMPT_INPUT).skip(1).map(|rest| rest.split('"').next().unwrap()).collect();
    assert_eq!(attempts.len(), 4, "{html}");
    assert!(attempts.iter().all(|a| crate::recovery::valid_attempt(a)), "{attempts:?}");
    attempts.dedup();
    assert_eq!(attempts.len(), 4, "{attempts:?}");

    let (status, _, body) = pilot.send(get_json(SCREEN)).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["locations"][1]["is_archived"], true, "{body}");
    assert_eq!(screen["data"]["status"], json!({ "state": "ready" }), "{body}");

    let reads = pilot.inventory_calls();
    assert!(reads.iter().all(|c| c.path == format!("{LOCATIONS}?includeArchived=true")), "{reads:?}");
    assert!(reads.iter().all(|c| c.headers[header::COOKIE] == "chase_sets_session=seller"), "{reads:?}");
    assert!(reads.iter().all(|c| c.headers["x-forwarded-host"] == "localhost:7791"), "{reads:?}");
}

#[tokio::test]
async fn an_applied_create_sends_its_attempt_and_redirects_to_confirm_it() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let (status, headers, _) = pilot.send(post(SCREEN, "seller", &location_body(&attempt, "Shelf"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with(&format!("{SCREEN}?")), "{to}");
    let q = query(to);
    assert_eq!(
        (q["attempt"].as_str(), q["family"].as_str(), q["target"].as_str()),
        (attempt.as_str(), "location-create", "draft")
    );
    assert!(q["after_write"].contains(r#""commitPosition":"42""#), "{q:?}");

    let sent = pilot.writes();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, LOCATIONS));
    assert_eq!(sent[0].headers["inventory-mutation-attempt"], attempt.as_str());
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        body,
        json!({
            "name": "Shelf", "description": null, "shipFromCode": "MAIN",
            "shipFromAddress": {
                "name": "Synthetic Seller", "company": null, "line1": "1 Test Way", "line2": null, "city": "Austin",
                "state": "TX", "postalCode": "78701", "country": "US", "phone": null, "email": null,
            },
        }),
        "built as marketplace's action builds it"
    );

    // Without JavaScript the same write is a 303 to the same place.
    let (status, headers, _) = pilot.send(post(SCREEN, "seller", &location_body(&new_attempt(), "Bin"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(query(headers[header::LOCATION].to_str().unwrap())["family"], "location-create");
}

#[tokio::test]
async fn saving_and_archiving_patch_the_location() {
    let pilot = Pilot::new().await;
    let (save, archive) = (new_attempt(), new_attempt());
    let (status, headers, _) =
        pilot.send(post(&format!("{SCREEN}/loc_main"), "seller", &location_body(&save, "Main shelf"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let q = query(headers["corten-location"].to_str().unwrap());
    assert_eq!((q["family"].as_str(), q["target"].as_str()), ("location-update", "loc_main"));
    let (status, headers, _) =
        pilot.send(post(&format!("{SCREEN}/loc_main/archive"), "seller", &location_body(&archive, "Main shelf"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(query(headers["corten-location"].to_str().unwrap())["family"], "location-archive");

    let sent = pilot.writes();
    assert_eq!(sent.len(), 2, "{sent:?}");
    for (call, archived) in sent.iter().zip([false, true]) {
        assert_eq!((&call.method, call.path.as_str()), (&Method::PATCH, &*format!("{LOCATIONS}/loc_main")));
        assert_eq!(serde_json::from_str::<Value>(&call.body).unwrap()["isArchived"], archived);
    }
}

#[tokio::test]
async fn a_refused_write_is_the_form_again_with_a_new_attempt() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let (status, headers, html) = pilot.send(post(SCREEN, "seller", &location_body(&attempt, "Refused"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(headers.contains_key("corten-patch"), "a patch: {headers:?}");
    assert!(html.contains(r#"role="alert">Ship-from code is already in use.</p>"#), "{html}");
    assert!(html.contains(r#"value="Refused""#), "what was typed stays: {html}");
    let again = drawn_attempt(&html);
    assert!(again != attempt && crate::recovery::valid_attempt(&again), "a new attempt: {again}");
    assert!(
        pilot.inventory_calls().iter().any(|c| c.path == format!("{ATTEMPTS}{attempt}")),
        "the refusal is checked against the attempt before the form is drawn again"
    );

    // Without JavaScript the same refusal is the whole page, with the form in it.
    let (status, _, html) = pilot.send(post(SCREEN, "seller", &location_body(&new_attempt(), "Refused"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("Ship-from code is already in use."), "{html}");
}

#[tokio::test]
async fn a_form_posted_again_after_its_write_applied_is_not_refused() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let (status, _, _) = pilot.send(post(SCREEN, "seller", &location_body(&attempt, "Shelf"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // The answer was lost; the seller changed a field and posted the same form again.
    let (status, headers, html) = pilot.send(post(SCREEN, "seller", &location_body(&attempt, "Shelf 2"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{html}");
    let q = query(headers["corten-location"].to_str().unwrap());
    assert_eq!(q["attempt"], attempt);
    assert!(!q.contains_key("after_write"), "the first write's receipt is not known: {q:?}");
    assert_eq!(pilot.stand.applied.lock().unwrap().len(), 1, "applied once");
}

#[tokio::test]
async fn the_pilots_own_checks_call_nothing() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post(SCREEN, "seller", &location_body("not-an-attempt", "Shelf"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This form is out of date."), "{html}");
    let body = location_body(&new_attempt(), "Shelf").replace("ship_from_city=Austin", "ship_from_city=+");
    let (status, _, html) = pilot.send(post(SCREEN, "seller", &body, true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="ship_from_city-error""#) && html.contains(r#"aria-invalid="true""#), "{html}");
    assert!(pilot.inventory_calls().is_empty(), "nothing is sent to the API");
}

#[tokio::test]
async fn a_write_with_no_answer_is_the_error_page_and_applies_nothing() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post(SCREEN, "seller", &location_body(&new_attempt(), "Broken"), true)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(!headers.contains_key("corten-location"));
    assert!(pilot.stand.applied.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_list_confirms_an_applied_attempt_and_doubts_an_unknown_one() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    pilot.send(post(SCREEN, "seller", &location_body(&attempt, "Shelf"), true)).await;
    let status_of = |body: &str| serde_json::from_str::<Value>(body).unwrap()["data"]["status"].clone();

    let (status, _, body) =
        pilot.send(get_json(&format!("{SCREEN}?attempt={attempt}&family=location-create&target=draft"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_of(&body), json!({ "state": "confirmed", "attempt": attempt }));

    // Another target than the attempt was applied to: not this write.
    let (_, _, body) = pilot.send(get_json(&format!("{SCREEN}?attempt={attempt}&family=location-update&target=loc_main"))).await;
    assert_eq!(status_of(&body)["state"], "uncertain");

    let unknown = new_attempt();
    let (_, _, html) =
        pilot.send(get(&format!("{SCREEN}?attempt={unknown}&family=location-create&target=draft"), Some("seller"))).await;
    assert!(html.contains("<fieldset") && html.contains("disabled"), "writes are off while a write is uncertain: {html}");

    // A record another user left in this browser: they sign in to confirm it.
    let (_, _, body) =
        pilot.send(get_json(&format!("{SCREEN}?attempt={unknown}&family=location-create&target=draft&user=usr_other"))).await;
    assert_eq!(status_of(&body)["state"], "reauth");
}

#[tokio::test]
async fn the_read_after_a_write_waits_for_its_receipt() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get(&format!("{SCREEN}?after_write={}", receipt_at("42")), Some("seller"))).await;
    assert_eq!(status, StatusCode::OK);
    let read = pilot.inventory_calls().pop().unwrap();
    assert_eq!(waits_for(&read.headers).as_deref(), Some("42"));

    // Not readable yet: the page says so, with no list.
    let (status, _, body) = pilot.send(get_json(&format!("{SCREEN}?after_write={}", receipt_at("43")))).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (screen["data"]["pending"].as_bool(), screen["data"]["locations"].as_array().map(Vec::len)),
        (Some(true), Some(0))
    );
    // A read after a write that fails for good: the write could not be verified.
    let (status, _, _) = pilot.send(get(&format!("{SCREEN}?after_write={}", receipt_at("44")), Some("seller"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
}
