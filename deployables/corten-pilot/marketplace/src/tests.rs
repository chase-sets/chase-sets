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
const RESTOCK: &str = "/api/inventory/restock-decisions";
const RESTOCK_SCREEN: &str = "/account/inventory/restock-decisions";
const CART: &str = "/api/marketplace/account/cart";
const CART_SCREEN: &str = "/account/cart";
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

/// The one pending decision: a returned shipment, at version 2.
fn decision() -> Value {
    json!({
        "decision_id": "rstk_1", "version": 2, "account_id": "acc_seller", "order_id": "ord_1", "item_id": "inv_1",
        "item_title": "Twilight Masquerade Elite Trainer Box", "item_subtitle": null, "product_summary": null,
        "quantity": 1, "source": "shipment-returned", "source_ref": null, "shipment_id": "shp_1",
        "return_reason": "Carrier return to sender", "status": "pending", "outcome": null, "damage_note": null,
        "pending_at": "2026-03-22T12:00:00.000Z", "decided_at": null, "updated_at": "2026-10-24T03:56:21.245Z",
    })
}

/// A cart line for `item`, locked to `locked` or Smart Match, with listings `(id, seller, price)`.
fn cart_line(id: &str, item: &str, quantity: u32, locked: Option<&str>, listings: &[(&str, &str, &str)], updated: &str) -> Value {
    let options: Vec<Value> = listings
        .iter()
        .map(|(listing, seller, price)| {
            json!({
                "listing_id": listing, "seller_account_id": "acc_x", "seller_slug": "x", "seller_display_name": seller,
                "seller_average_rating": if *seller == "Chase Sets" { json!("5.00") } else { Value::Null },
                "seller_review_count": if *seller == "Chase Sets" { 1 } else { 0 },
                "price_amount": price, "price_currency_code": "USD", "listing_stream_version": 1, "available_quantity": 4,
                "product_summary": "Form: raw | Condition: excellent", "product_measure_snapshot": { "source": "profile" },
            })
        })
        .collect();
    json!({
        "line_id": id, "catalog_catalog_item_id": format!("cat_{item}"), "product_id": format!("cat_{item}::raw"),
        "item_language_code": null, "item_title": item, "item_subtitle": "Base Set", "item_image_url": null,
        "item_image_srcset": null, "item_image_loading_url": null, "item_image_loading_alt": null,
        "item_image_loading_srcset": null, "selected_options": [], "product_summary": "Form: Raw | Condition: Near Mint",
        "quantity": quantity, "fulfillment_mode": if locked.is_some() { "locked-listing" } else { "optimize" },
        "locked_listing_id": locked, "selected_listing_id": null, "selected_listing_seller_account_id": null,
        "selected_listing_seller_display_name": null, "selected_listing_seller_slug": null,
        "selected_listing_price_amount": null, "selected_listing_price_currency_code": null,
        "selected_listing_stream_version": null, "selected_listing_snapshot_source": null,
        "selected_listing_snapshot_captured_at": null, "seller_preference_id": null, "availability_state": "available",
        "seller_options": options, "created_at": updated, "updated_at": updated,
    })
}

/// A readiness snapshot of `status` with each line's reason and the optimization's `decision`.
fn snapshot(id: &str, status: &str, reasons: &[(&str, &str)], decision: &str, offer: bool) -> Value {
    let outcomes: Vec<Value> =
        reasons.iter().map(|(line, reason)| json!({ "lineId": line, "outcome": "checkout", "reason": reason })).collect();
    json!({
        "schemaVersion": "checkout.cart-readiness.v1", "source": "cart", "sourceRevision": "cr_rev", "snapshotId": id,
        "status": status, "lineCount": reasons.len(), "includedLineIds": [], "unresolvedLineIds": [],
        "lineOutcomes": outcomes,
        "optimization": {
            "available": offer, "decision": decision,
            "proposedLineId": if offer { json!("cli_charizard") } else { Value::Null },
            "proposedListingId": if offer { json!("lst_vault_charizard") } else { Value::Null },
            "currentListingId": null, "savingsAmount": if offer { json!("10.99") } else { Value::Null }, "currency": "USD",
        },
        "fulfillmentGroups": [], "customerSafeFacts": [],
    })
}

/// The cart the session's account has: `buyer`'s is the seed's (two locked lines, ready, a
/// lower price offered); `blocked`'s has two Smart Match lines for one product, which the page
/// merges, and a line in another currency, so nothing can check out; `empty`'s has no line.
fn cart(session: &str) -> Value {
    let charizard = [("lst_chase_charizard", "Chase Sets", "399.99"), ("lst_vault_charizard", "Card Vault", "389.00")];
    match session {
        "blocked" => {
            let pikachu = [("lst_pikachu", "Card Vault", "17.95")];
            let reasons = [
                ("cli_pikachu_a", "unassigned-fulfillment"),
                ("cli_pikachu_b", "unassigned-fulfillment"),
                ("cli_eur", "currency-mismatch"),
            ];
            json!({
                "items": [
                    cart_line("cli_pikachu_a", "Pikachu", 1, None, &pikachu, "2026-10-24T03:00:00.000Z"),
                    cart_line("cli_eur", "Mew", 1, Some("lst_mew"), &[], "2026-10-24T02:00:00.000Z"),
                    cart_line("cli_pikachu_b", "Pikachu", 2, None, &pikachu, "2026-10-24T04:00:00.000Z"),
                ],
                "count": 3,
                "readiness": {
                    "loaded": snapshot("cr_loaded", "blocked", &reasons, "none", false),
                    "declined": snapshot("cr_declined", "blocked", &reasons, "declined", false),
                    "accepted": null,
                    "lineListingIds": { "cli_pikachu_a": "lst_pikachu", "cli_pikachu_b": "lst_pikachu", "cli_eur": null },
                    "estimatedSubtotal": null, "blockedLineCount": 2, "savings": null,
                },
            })
        }
        "empty" => json!({
            "items": [], "count": 0,
            "readiness": {
                "loaded": snapshot("cr_loaded", "blocked", &[], "none", false),
                "declined": snapshot("cr_declined", "blocked", &[], "none", false),
                "accepted": null, "lineListingIds": {}, "estimatedSubtotal": null, "blockedLineCount": 0, "savings": null,
            },
        }),
        _ => {
            let reasons = [("cli_charizard", "ready"), ("cli_pikachu", "ready")];
            json!({
                "items": [
                    cart_line("cli_pikachu", "Pikachu", 1, Some("lst_chase_pikachu"), &[("lst_chase_pikachu", "Chase Sets", "21.50")], "2026-10-24T03:55:54.259Z"),
                    cart_line("cli_charizard", "Charizard", 1, Some("lst_chase_charizard"), &charizard, "2026-10-24T03:55:54.247Z"),
                ],
                "count": 2,
                "readiness": {
                    "loaded": snapshot("cr_loaded", "ready", &reasons, "none", true),
                    "declined": snapshot("cr_declined", "ready", &reasons, "declined", true),
                    "accepted": snapshot("cr_accepted", "ready", &reasons, "accepted", true),
                    "lineListingIds": { "cli_pikachu": "lst_chase_pikachu", "cli_charizard": "lst_chase_charizard" },
                    "estimatedSubtotal": { "amount": "421.49", "currency": "USD" },
                    "blockedLineCount": 0,
                    "savings": { "amount": "10.99", "currency": "USD" },
                },
            })
        }
    }
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
            // A buyer: any account has a cart, and none of these may see inventory.
            "other" | "buyer" | "blocked" | "empty" => actor(&[]),
            "guest" => actor(&["guest-checkout.manage"]),
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
    if uri.path() == CART {
        return Json(cart(session)).into_response();
    }
    if let Some(rest) = uri.path().strip_prefix(RESTOCK) {
        return restock(&stand, &method, rest, &headers, &body);
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

/// The restock decisions, as the stand-in answers them: a read waits as the locations' does; a
/// decision sent for another version than 2 is refused, as the API refuses a stale one.
fn restock(stand: &Stand, method: &Method, rest: &str, headers: &HeaderMap, body: &str) -> Response {
    if *method == Method::GET {
        return match waits_for(headers).as_deref() {
            Some("43") => refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            ),
            Some("44") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => Json(json!({ "items": [decision()], "total": 1, "count": 1 })).into_response(),
        };
    }
    let Some(id) = rest.strip_prefix('/').and_then(|r| r.strip_suffix("/decision")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let attempt = headers.get("inventory-mutation-attempt").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let command: Value = serde_json::from_str(body).unwrap_or_default();
    if command["expectedVersion"] != 2 {
        return refusal(StatusCode::CONFLICT, "conflict", "Restock decision version conflicts with the current decision.");
    }
    stand.applied.lock().unwrap().insert(attempt, ("restock-record".into(), id.to_owned()));
    let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
    (StatusCode::OK, headers, Json(json!({ "id": id, "version": 3, "status": "recorded" }))).into_response()
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
const ATTEMPT_INPUT: &str = r#"<input type="hidden" name="attempt" data-submit value=""#;

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
    assert_eq!(patch_ids(&html), ["recovery", "create-form"], "each element the patch replaces has its id: {html}");
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
    assert!(html.contains(r#"id="create-form-ship_from_city-error""#) && html.contains(r#"aria-invalid="true""#), "{html}");
    assert!(
        html.contains(r#"</label><p class="field-error" id="create-form-ship_from_city-error">"#),
        "the error is not in the label: {html}"
    );
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

/// The ids of a patch's top-level elements, in order (`""` for one without): the runtime replaces
/// each by its id and drops one that has none.
fn patch_ids(html: &str) -> Vec<String> {
    let (mut ids, mut depth, mut rest) = (Vec::new(), 0usize, html);
    while let Some(at) = rest.find('<') {
        rest = &rest[at..];
        let end = rest.find('>').expect("a tag ends");
        let tag = &rest[..=end];
        let void = ["<input", "<br", "<img", "<meta", "<link", "<hr"].iter().any(|v| tag.starts_with(v));
        if tag.starts_with("</") {
            depth -= 1;
        } else {
            if depth == 0 {
                let id = tag.split(" id=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or_default();
                ids.push(id.to_owned());
            }
            if !void && !tag.ends_with("/>") {
                depth += 1;
            }
        }
        rest = &rest[end + 1..];
    }
    ids
}

/// A restock decision form's body.
fn decision_body(attempt: &str, version: &str, note: Option<&str>) -> String {
    let note = note.map(|n| format!("&damage_note={}", n.replace(' ', "+"))).unwrap_or_default();
    format!("attempt={attempt}&expected_version={version}{note}")
}

#[tokio::test]
async fn the_restock_list_shows_each_decision_and_data_clients_get_the_screen() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(RESTOCK_SCREEN, Some("seller"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "<title>Restock Decisions | Marketplace</title>",
        "Shipment returned",
        "1 returned",
        "Twilight Masquerade Elite Trainer Box",
        "Mar 22, 2026, 12:00 PM UTC",
        "Carrier return to sender",
        r#"href="http://localhost:7753/account/sales/ord_1">View order ord_1</a>"#,
        r#"href="http://localhost:7753/account/inventory/items/inv_1">View ledger</a>"#,
        r#"name="expected_version" value="2""#,
        "Damage note",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    // Restock and Write off, each its own attempt.
    let mut attempts: Vec<_> = html.split(ATTEMPT_INPUT).skip(1).map(|rest| rest.split('"').next().unwrap()).collect();
    attempts.dedup();
    assert_eq!(attempts.len(), 2, "{attempts:?}");

    let (status, _, body) = pilot.send(get_json(RESTOCK_SCREEN)).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["decisions"][0]["decision_id"], "rstk_1", "{body}");
    assert_eq!(screen["data"]["status"], json!({ "state": "ready" }), "{body}");
    let reads = pilot.inventory_calls();
    assert!(reads.iter().all(|c| c.path == format!("{RESTOCK}?limit=100&offset=0")), "marketplace's query: {reads:?}");
}

#[tokio::test]
async fn restock_and_write_off_record_the_decision_and_redirect_to_confirm_it() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let restock = format!("{RESTOCK_SCREEN}/rstk_1/restock");
    let (status, headers, html) = pilot.send(post(&restock, "seller", &decision_body(&attempt, "2", None), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{html}");
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with(&format!("{RESTOCK_SCREEN}?")), "{to}");
    let q = query(to);
    assert_eq!(
        (q["attempt"].as_str(), q["family"].as_str(), q["target"].as_str()),
        (attempt.as_str(), "restock-record", "rstk_1")
    );
    assert!(q["after_write"].contains(r#""commitPosition":"42""#), "{q:?}");
    let sent = pilot.writes();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/inventory/restock-decisions/rstk_1/decision"));
    assert_eq!(sent[0].headers["inventory-mutation-attempt"], attempt.as_str());
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body, json!({ "expectedVersion": 2, "outcome": "restocked" }), "a restock has no damage note");

    // The list it redirects to confirms the attempt.
    let (_, _, body) =
        pilot.send(get_json(&format!("{RESTOCK_SCREEN}?attempt={attempt}&family=restock-record&target=rstk_1"))).await;
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["status"], json!({ "state": "confirmed", "attempt": attempt }), "{body}");

    // A write-off, without JavaScript: its note trimmed, or null.
    let write_off = format!("{RESTOCK_SCREEN}/rstk_1/write-off");
    let (status, headers, _) =
        pilot.send(post(&write_off, "seller", &decision_body(&new_attempt(), "2", Some("  Crushed corner  ")), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(query(headers[header::LOCATION].to_str().unwrap())["family"], "restock-record");
    pilot.send(post(&write_off, "seller", &decision_body(&new_attempt(), "2", Some(" ")), true)).await;
    let bodies: Vec<Value> = pilot.writes().iter().skip(1).map(|c| serde_json::from_str(&c.body).unwrap()).collect();
    assert_eq!(
        bodies,
        [
            json!({ "expectedVersion": 2, "outcome": "written-off", "damageNote": "Crushed corner" }),
            json!({ "expectedVersion": 2, "outcome": "written-off", "damageNote": null }),
        ]
    );
}

#[tokio::test]
async fn a_refused_decision_is_its_form_again_at_the_current_version() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let write_off = format!("{RESTOCK_SCREEN}/rstk_1/write-off");
    let (status, headers, html) = pilot.send(post(&write_off, "seller", &decision_body(&attempt, "1", Some("Torn")), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(headers.contains_key("corten-patch"), "a patch: {headers:?}");
    assert_eq!(patch_ids(&html), ["recovery", "write-off-form-rstk_1"], "each element the patch replaces has its id: {html}");
    assert!(html.contains("Restock decision version conflicts with the current decision."), "{html}");
    assert!(html.contains(r#"value="2""#) && !html.contains(r#"value="1""#), "the version as it is now: {html}");
    assert!(html.contains(">Torn</textarea>"), "the note stays: {html}");
    let again = drawn_attempt(&html);
    assert!(again != attempt && crate::recovery::valid_attempt(&again), "a new attempt: {again}");
    assert!(pilot.stand.applied.lock().unwrap().is_empty());

    // Without JavaScript: the whole page, with the form in it.
    let (status, _, html) = pilot.send(post(&write_off, "seller", &decision_body(&new_attempt(), "1", None), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("conflicts with the current decision"), "{html}");

    // A version that is not a number is an out-of-date form: nothing is sent.
    let before = pilot.writes().len();
    let restock = format!("{RESTOCK_SCREEN}/rstk_1/restock");
    let (status, _, html) = pilot.send(post(&restock, "seller", &decision_body(&new_attempt(), "x", None), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This form is out of date."), "{html}");
    assert_eq!(pilot.writes().len(), before);
}

#[tokio::test]
async fn the_restock_page_signs_in_reads_with_view_and_writes_with_manage() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get(RESTOCK_SCREEN, None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "http://localhost:7753/sign-in?returnTo=%2Faccount%2Finventory%2Frestock-decisions");
    let (status, _, html) = pilot.send(get(RESTOCK_SCREEN, Some("reader"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let restock = format!("{RESTOCK_SCREEN}/rstk_1/restock");
    let (status, _, _) = pilot.send(post(&restock, "reader", &decision_body(&new_attempt(), "2", None), true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(pilot.writes().is_empty());
}

#[tokio::test]
async fn the_restock_read_after_a_write_waits_and_says_when_it_cannot_be_verified() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(&format!("{RESTOCK_SCREEN}?after_write={}", receipt_at("43")), Some("seller"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Restock decisions are still updating."), "{html}");
    assert!(!html.contains("No returned stock needs a decision."), "not empty while it updates: {html}");
    let (status, _, html) = pilot.send(get(&format!("{RESTOCK_SCREEN}?after_write={}", receipt_at("44")), Some("seller"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(html.contains("The update could not be verified."), "the screen's words: {html}");
    let (_, _, html) = pilot.send(get(&format!("{SCREEN}?after_write={}", receipt_at("44")), Some("seller"))).await;
    assert!(html.contains("Storage location update could not be verified."), "{html}");
}

/// The calls to the cart read.
fn cart_calls(pilot: &Pilot) -> Vec<Call> {
    pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path == CART).cloned().collect()
}

/// The text of `html` with its tags taken out, its runs of space made one.
fn text(html: &str) -> String {
    let mut out = String::new();
    let mut tag = false;
    for c in html.chars() {
        match c {
            '<' => tag = true,
            '>' => {
                tag = false;
                out.push(' ');
            }
            c if !tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[tokio::test]
async fn the_cart_shows_each_line_the_total_and_the_lower_price_the_api_offers() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(CART_SCREEN, Some("buyer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Save $10.99 by switching to Card Vault"), "the API's savings and the proposed seller: {page}");
    // Newest first, each with its badge, options, lock, seller and price.
    let (pikachu, charizard) = (page.find("Pikachu").unwrap(), page.find("Charizard").unwrap());
    assert!(pikachu < charizard, "{page}");
    assert_eq!(html.matches("data-reason>Ready<").count(), 2, "{html}");
    assert!(page.contains("Raw Near Mint"), "{page}");
    assert!(page.contains("Chase Sets is locked for checkout unless availability changes."), "{page}");
    assert!(page.contains("Chase Sets \u{2605} 5.0 (1)"), "{page}");
    assert!(page.contains("$21.50") && page.contains("$399.99"), "{page}");
    assert!(page.contains("Estimated total $421.49 Final total confirmed at checkout"), "the API's subtotal: {page}");
    assert!(!page.contains("Find alternatives"), "every line can be fulfilled: {page}");
    // Checkout is marketplace's (todd-skelton/corten#64: links, not forms).
    assert!(html.contains(r#"href="http://localhost:7753/checkout/buy/readiness">Check out<"#), "{html}");
    assert!(html.contains(r#"href="http://localhost:7753/account/cart">Use lower price<"#), "{html}");
    assert!(html.contains(r#"src="http://localhost:7753/fake-cdn/assets/pokemon-card-back.png""#), "{html}");
    assert!(!html.contains("<script>"), "the page needs no inline script");

    let reads = cart_calls(&pilot);
    assert_eq!(reads.len(), 1, "{reads:?}");
    assert_eq!(reads[0].headers["chase-sets-read-target-context"], "checkout");
    assert_eq!(reads[0].headers[header::COOKIE], "chase_sets_session=buyer");
}

#[tokio::test]
async fn a_cart_that_cannot_check_out_says_which_lines_need_attention() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(CART_SCREEN, Some("blocked"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Some items need attention"), "{page}");
    assert!(page.contains("2 items need fulfillment, shipping measure, or availability resolved before checkout."), "{page}");
    assert!(!page.contains("Save "), "a cart that needs attention offers no lower price: {page}");
    // The two Pikachu lines are one, quantity 3, before the older Mew; Smart Match prices it "from".
    assert_eq!(html.matches("data-cart-line=").count(), 2, "{html}");
    assert!(html.contains(r#"data-cart-line="cli_pikachu_a""#), "the merged line keeps the first one's id: {html}");
    assert!(html.contains("data-quantity>3<"), "{html}");
    assert!(page.contains("from $53.85"), "{page}");
    assert!(html.contains("data-reason>Needs fulfillment<"), "{html}");
    // The API says the other currency's line needs review (marketplace draws it Ready).
    assert!(html.contains("data-reason>Needs review<"), "{html}");
    assert!(page.contains("Priced at checkout"), "a line without a priced listing, and the total: {page}");
    assert_eq!(page.matches("Find alternatives").count(), 1, "only the line with no fulfillment: {page}");
    assert!(html.contains(r#"href="http://localhost:7753/search?q=Pikachu""#), "{html}");
    assert!(html.contains(">Continue to checkout<") && !html.contains(">Check out<"), "{html}");
    assert!(page.contains("Resolve item availability before payment starts."), "{page}");
    assert!(!page.contains("Use lower price"), "{page}");
}

#[tokio::test]
async fn an_empty_cart_offers_to_keep_shopping() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(CART_SCREEN, Some("empty"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Your buy cart is empty"), "{page}");
    assert!(page.contains("Checkout protection stays visible"), "{page}");
    assert!(html.contains(r#"href="http://localhost:7753/search">Keep shopping<"#), "{html}");
    assert!(!page.contains("Estimated total"), "no totals or checkout bar: {page}");
}

#[tokio::test]
async fn any_account_has_a_cart_and_a_guest_goes_to_marketplaces() {
    let pilot = Pilot::new().await;
    for session in [None, Some("expired"), Some("guest")] {
        let (status, headers, _) = pilot.send(get(CART_SCREEN, session)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{session:?}");
        assert_eq!(headers[header::LOCATION], "http://localhost:7753/account/cart", "{session:?}");
    }
    assert!(cart_calls(&pilot).is_empty(), "nothing is read for a visitor without an account cart");
    let (status, _, _) = pilot.send(get(CART_SCREEN, Some("down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "a failed lookup must not send the user away");
    // A seller's inventory permission is not needed for the cart, and a buyer's is not enough for inventory.
    let (status, _, _) = pilot.send(get(CART_SCREEN, Some("seller"))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = pilot.send(get(SCREEN, Some("buyer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_data_client_gets_the_cart_screen() {
    let pilot = Pilot::new().await;
    let mut req = get(CART_SCREEN, Some("blocked"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let screen: Value = serde_json::from_str(&body).unwrap();
    let lines = &screen["data"]["lines"];
    assert_eq!(lines[0]["line_ids"], json!(["cli_pikachu_a", "cli_pikachu_b"]), "{body}");
    assert_eq!(lines[0]["reason"], "unassigned-fulfillment", "{body}");
    assert_eq!(lines[0]["price"], json!({ "state": "from", "text": "$53.85" }), "{body}");
    assert_eq!(lines[1]["reason"], "currency-mismatch", "{body}");
    assert_eq!(lines[1]["price"], json!({ "state": "deferred" }), "{body}");
    assert_eq!(screen["data"]["readiness"]["blockedLineCount"], 2, "{body}");
}
