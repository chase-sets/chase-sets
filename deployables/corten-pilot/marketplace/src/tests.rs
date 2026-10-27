//! Router tests against a stand-in platform API: who may read and write, what the pilot sends,
//! and how a write that may or may not have been applied is confirmed.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use corten::axum::{
    Json, Router,
    body::{Body, Bytes},
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
const ITEMS: &str = "/api/marketplace/items/";
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
    /// The cart attempts the Checkout API kept, by id.
    kept: Arc<Mutex<HashMap<String, Value>>>,
    /// The listings created here, by id: what was sent, and `published` once it is.
    listings: Arc<Mutex<HashMap<String, Value>>>,
    /// The Listing stock ensures applied, by attempt.
    ensured: Arc<Mutex<HashMap<String, Value>>>,
}

const OVERLAY: &str = "/api/marketplace/items/charizard/seller-overlay";
const ENSURE: &str = "/api/inventory/items/listing-stock/ensure";
const CREATE_LISTING: &str = "/api/marketplace/account/listings";
const DRAFT_INTENTS: &str = "/api/marketplace/guest/listing-draft-intents";

/// A write's answer with a receipt at `position` in `context`.
fn committed(status: StatusCode, context: &str, position: &str, body: Value) -> Response {
    let receipt =
        format!(r#"[{{"sourceContextName":"{context}","maxGlobalPosition":"{position}","eventIds":["evt_{position}"]}}]"#);
    let receipt = percent_encoding::utf8_percent_encode(&receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", position.to_owned()), ("chase-sets-commit-receipt", receipt)];
    (status, headers, Json(body)).into_response()
}

/// A quick listing's calls, as the stand-in answers them. The seller overlay says `lister` has a
/// Listing stock location, and `starter` has one once a read waits for its setup's write
/// (position 42; 43 is still catching up). The stock's ensure is one attempt, refused for a
/// graded product and for `starter`; a create with `listingIdOverride` sent again is the same
/// listing, and one priced `1.00` is refused; a listing priced `2.00` is created but its
/// publication refused. A guest's draft needs its owner.
fn listings(stand: &Stand, session: &str, method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    if path == OVERLAY {
        let has = match (session, waits_for(headers).as_deref()) {
            (_, Some("43")) => {
                return Some(refusal(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "projection_freshness_timeout",
                    "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
                ));
            }
            ("lister", _) | ("starter", Some("42")) => true,
            _ => false,
        };
        let overlay = json!({
            "accountOfferMatches": [], "sellerInventoryItems": [], "hasListingStockLocation": has, "selectedSellerListing": null,
        });
        return Some(Json(overlay).into_response());
    }
    if *method != Method::POST {
        return None;
    }
    if path == ENSURE {
        let attempt = headers.get("inventory-mutation-attempt").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        if sent["selectedOptions"].to_string().contains("chc_graded") {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "validation_failed",
                "Graded listing stock requires graded card details.",
            ));
        }
        if session == "starter" {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "validation_failed",
                "Ship-from address is required before creating listing stock.",
            ));
        }
        let snapshot = json!({ "inventoryItemId": "inv_stock", "quantity": sent["quantity"], "attempt": attempt, "acquisitionCostCurrencyCode": null, "shipFromAddress": { "line1": "1 Test Way", "verification": null } });
        let mut ensured = stand.ensured.lock().unwrap();
        let first = ensured.entry(attempt).or_insert(snapshot).clone();
        return Some((StatusCode::CREATED, Json(json!({ "inventoryItemId": "inv_stock", "snapshot": first }))).into_response());
    }
    if path == CREATE_LISTING {
        // The create's closed snapshot refuses what the ensure now writes (chase-sets/chase-sets#10599).
        let snapshot = &sent["inventorySnapshot"];
        if snapshot.get("acquisitionCostCurrencyCode").is_some() || snapshot["shipFromAddress"].get("verification").is_some() {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "listing_request_unknown_field",
                "Remove unrecognized fields and try again.",
            ));
        }
        if sent["priceAmount"] == "1.00" {
            return Some(refusal(StatusCode::BAD_REQUEST, "command-rejected", "Listing price is below the marketplace minimum."));
        }
        let id = sent["listingIdOverride"].as_str().unwrap_or("lst_new").to_owned();
        let mut listings = stand.listings.lock().unwrap();
        let listing = listings.entry(id.clone()).or_insert(sent);
        // The same id again answers the listing as it now is: active once published.
        let status = if listing["published"] == true { "active" } else { "draft" };
        let created =
            json!({ "id": id, "version": 1, "status": "draft", "feeQuoteFingerprint": "fq_1", "state": { "status": status } });
        return Some(committed(StatusCode::CREATED, "marketplace", "30", created));
    }
    if let Some(id) = path.strip_prefix("/api/marketplace/account/listings/").and_then(|p| p.strip_suffix("/publish")) {
        let mut listings = stand.listings.lock().unwrap();
        let listing = listings.get_mut(id)?;
        if listing["published"] == true {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "listing_command_rejected",
                "This listing change is not available. Check the listing details and try again.",
            ));
        }
        if listing["priceAmount"] == "2.00" {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "command-rejected",
                "Listings require a resolved shipping measure before publication.",
            ));
        }
        if listing["inventoryItemId"] == "inv_bare" {
            return Some(refusal(
                StatusCode::BAD_REQUEST,
                "listing_evidence_incomplete",
                "Listing evidence is incomplete for the active policy.",
            ));
        }
        listing["published"] = json!(true);
        listing["publishedWith"] = sent["feeQuoteFingerprint"].clone();
        return Some(committed(StatusCode::OK, "marketplace", "31", json!({ "listingId": id, "version": 2 })));
    }
    if path == DRAFT_INTENTS {
        let owner = headers.get("x-marketplace-anonymous-listing-draft-id").and_then(|v| v.to_str().ok());
        if !owner.is_some_and(|o| o.starts_with("anon_")) {
            return Some(refusal(StatusCode::BAD_REQUEST, "validation_failed", "Anonymous listing draft owner is required."));
        }
        return Some((StatusCode::CREATED, Json(json!({ "intent_id": "ldi_1", "status": "active" }))).into_response());
    }
    None
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
            // The buyer prefers the Pikachu listing, so those lines can be locked to it.
            let preferred = |mut line: Value| {
                line["seller_preference_id"] = json!("lst_pikachu");
                line
            };
            // A picture as the card back leaves it: site-relative to marketplace.
            let mut mew = cart_line("cli_eur", "Mew", 1, Some("lst_mew"), &[], "2026-10-24T02:00:00.000Z");
            mew["item_image_url"] = json!("/fake-cdn/assets/pokemon_tcg_back.png");
            mew["item_image_srcset"] = json!("/fake-cdn/assets/mew-1x.png 1x, https://cdn.example/mew-2x.png 2x");
            let reasons = [
                ("cli_pikachu_a", "unassigned-fulfillment"),
                ("cli_pikachu_b", "unassigned-fulfillment"),
                ("cli_eur", "currency-mismatch"),
            ];
            json!({
                "items": [
                    preferred(cart_line("cli_pikachu_a", "Pikachu", 1, None, &pikachu, "2026-10-24T03:00:00.000Z")),
                    mew,
                    preferred(cart_line("cli_pikachu_b", "Pikachu", 2, None, &pikachu, "2026-10-24T04:00:00.000Z")),
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
async fn platform(State(stand): State<Stand>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    // A create's photos are bytes; the stand-in reads every body as text.
    let body = String::from_utf8_lossy(&body).into_owned();
    stand.calls.lock().unwrap().push(Call {
        method: method.clone(),
        path: uri.to_string(),
        headers: headers.clone(),
        body: body.clone(),
    });
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let session = cookie.split(';').find_map(|pair| pair.trim().strip_prefix("chase_sets_session=")).unwrap_or_default();
    if uri.path() == "/api/auth/session" {
        let actor = |permissions: &[&str]| {
            Json(json!({ "actor": { "userId": "usr_seller", "accountId": "acc_seller", "roleKey": "seller", "permissions": permissions } }))
                .into_response()
        };
        return match session {
            "seller" => actor(&["inventory.view", "inventory.manage"]),
            "reader" => actor(&["inventory.view"]),
            // A buyer: any account has a cart, and none of these may see inventory.
            // `stale`'s session ends before its cart write is sent.
            "other" | "buyer" | "blocked" | "empty" | "stale" => actor(&[]),
            "guest" => actor(&["guest-checkout.manage"]),
            // An account that sees items as a seller and may take offers.
            "trader" => actor(&["offers.view", "listings.view", "offers.manage"]),
            // An account that may save Watch alerts.
            "watcher" | "notices_down" => actor(&["accounts.view"]),
            // Sellers who may list at a price: `lister` has a Listing stock location, `starter` has
            // none until its ship-from setup is saved.
            "lister" | "starter" => actor(&["listings.view", "listings.manage", "offers.view"]),
            // A seller who may read its listings but not change them.
            "lookout" => actor(&["listings.view"]),
            // The account's orders: `shopper` buys and may cancel, `merchant` sells too, `looker`
            // may only read its purchases.
            "shopper" => actor(&["orders.view", "orders.manage"]),
            "merchant" => actor(&["orders.view", "orders.manage", "listings.view"]),
            "looker" => actor(&["orders.view"]),
            // The account's shipments, as a buyer and as the seller who sends them.
            "shipper" => actor(&["fulfillment.view", "fulfillment.manage"]),
            // A seller who may see the shipments but not pack them.
            "tracker" => actor(&["fulfillment.view"]),
            // An account that may change its shipping addresses (`watcher` may only read them).
            "addresser" => actor(&["accounts.view", "accounts.manage"]),
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
    if let Some(answer) = identity(&method, &uri, &headers, &body) {
        return answer;
    }
    // Before Ordering's and the listing page's, whose paths begin the same.
    if let Some(answer) = listing_list(session, &method, &uri, &headers, &body) {
        return answer;
    }
    if let Some(answer) = public_listings(&method, uri.path(), &headers) {
        return answer;
    }
    if let Some(answer) = public_accounts(&method, uri.path(), session) {
        return answer;
    }
    if let Some(answer) = notification_center(session, &method, uri.path(), &headers, &body) {
        return answer;
    }
    // Before Ordering's, whose sales path is a prefix of the seller's shipments.
    if let Some(answer) = packing(&method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(answer) = fulfillment(&method, &uri) {
        return answer;
    }
    if let Some(answer) = ordering(&method, &uri, &headers) {
        return answer;
    }
    if let Some(answer) = listing_create(&stand, session, &method, &uri, &headers, &body) {
        return answer;
    }
    if let Some(answer) = listings(&stand, session, &method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(answer) = seller_listings(&method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(rest) = uri.path().strip_prefix(ROLLUPS) {
        return rollups(rest);
    }
    if uri.path() == "/api/realtime/public/events" || uri.path() == "/api/realtime/account/events" {
        return realtime();
    }
    if let Some(answer) = search(&uri) {
        return answer;
    }
    if let Some(id) = uri.path().strip_prefix(ITEMS) {
        // Discovery has not caught up with a listing published at 44.
        if waits_for(&headers).as_deref() == Some("44") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return discovery_item(&stand, id);
    }
    if let Some(answer) = cart_add(&stand, &method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(answer) = sell_list(&method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(answer) = product_alerts(&method, uri.path(), &headers, &body) {
        return answer;
    }
    if let Some(answer) = saved_lists(&stand, session, &method, uri.path(), &headers, &body) {
        return answer;
    }
    if uri.path() == CART {
        return match waits_for(&headers).as_deref() {
            Some("43") => refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            ),
            Some("44") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => Json(cart(session)).into_response(),
        };
    }
    if let Some(answer) = cart_commands(&stand, session, &method, uri.path(), &body) {
        return answer;
    }
    if let Some(answer) = checkout(session, &method, uri.path(), &body) {
        return answer;
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

/// Starting checkout, as the stand-in answers it: the readiness is read again with the posted
/// decision (`cr_fresh`); `buyer`'s session starts as `chk_1` with a receipt, and `blocked`'s is
/// refused as the API refuses a cart that changed. A guest cart merges one line.
fn checkout(session: &str, method: &Method, path: &str, body: &str) -> Option<Response> {
    if *method != Method::POST {
        return None;
    }
    Some(match path {
        "/api/marketplace/guest/cart/merge-to-account" => Json(json!({ "mergedLineCount": 1 })).into_response(),
        "/api/marketplace/account/cart/readiness" => {
            let decisions: Value = serde_json::from_str(body).unwrap_or_default();
            let decision = decisions["optimization"]["decision"].as_str().unwrap_or("none");
            Json(json!({ "readiness": snapshot("cr_fresh", "ready", &[], decision, true) })).into_response()
        }
        "/api/marketplace/account/checkout-sessions" if body.contains(r#""entryAttemptKey":"conflict-"#) => refusal(
            StatusCode::CONFLICT,
            "checkout_attempt_conflict",
            "This checkout attempt was already used for a different request.",
        ),
        "/api/marketplace/account/checkout-sessions" if session == "blocked" => refusal(
            StatusCode::BAD_REQUEST,
            "readiness_snapshot_stale",
            "Cart readiness changed. Review your cart before checkout.",
        ),
        "/api/marketplace/account/checkout-sessions" => {
            let receipt = r#"[{"sourceContextName":"checkout","maxGlobalPosition":"9","eventIds":["evt_1"]}]"#;
            let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
            let headers = [("chase-sets-commit-position", "9".to_owned()), ("chase-sets-commit-receipt", receipt)];
            (StatusCode::CREATED, headers, Json(json!({ "session_id": "chk_1", "status": "started" }))).into_response()
        }
        _ => return None,
    })
}

const CART_COMMANDS: &str = "/api/marketplace/account/cart/commands";
const CART_ATTEMPTS: &str = "/api/marketplace/account/command-attempts/";

/// Cart writes, as the stand-in answers them. A command's line says what happens: `cli_gone` is
/// no longer in the cart (its command is a conflict, the others apply), `cli_refused` is refused
/// with nothing applied, `cli_lost` applies and its answer is lost, `cli_unknown`'s answer is lost
/// and nothing is kept. Any other applies, at position 11. `stale`'s session has ended. A lookup
/// answers what was kept.
fn cart_commands(stand: &Stand, session: &str, method: &Method, path: &str, body: &str) -> Option<Response> {
    if let Some(id) = path.strip_prefix(CART_ATTEMPTS) {
        return Some(match stand.kept.lock().unwrap().get(id) {
            Some(attempt) => Json(json!({ "attempt": attempt })).into_response(),
            None => refusal(StatusCode::NOT_FOUND, "command_attempt_not_found", "Command attempt not found."),
        });
    }
    if path != CART_COMMANDS || *method != Method::POST {
        return None;
    }
    if session == "stale" {
        return Some(refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in."));
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    let attempt = sent["attemptId"].as_str().unwrap_or_default().to_owned();
    let lines: Vec<String> =
        sent["commands"].as_array().into_iter().flatten().map(|c| c["lineId"].as_str().unwrap_or_default().to_owned()).collect();
    let has = |id: &str| lines.iter().any(|l| l == id);
    if has("cli_refused") {
        return Some(refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "Only 2 are available."));
    }
    if has("cli_unknown") {
        return Some(StatusCode::SERVICE_UNAVAILABLE.into_response());
    }
    let vector: Vec<Value> = lines
        .iter()
        .map(|line| match line.as_str() {
            "cli_gone" => json!({ "lineId": line, "outcome": "conflict", "message": "Cart line not found." }),
            _ => json!({ "lineId": line, "outcome": "succeeded", "message": null }),
        })
        .collect();
    let kept = json!({
        "ownerStatus": "committed", "vector": vector, "commitReceipt": { "eventId": "evt_cart", "globalPosition": "11" },
    });
    stand.kept.lock().unwrap().insert(attempt, kept.clone());
    if has("cli_lost") {
        return Some(StatusCode::BAD_GATEWAY.into_response());
    }
    let receipt = r#"[{"sourceContextName":"checkout","maxGlobalPosition":"11","eventIds":["evt_cart"]}]"#;
    let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "11".to_owned()), ("chase-sets-commit-receipt", receipt)];
    Some((StatusCode::OK, headers, Json(json!({ "attempt": kept }))).into_response())
}

const ACCOUNT_CART_ADD: &str = "/api/marketplace/account/cart";
const GUEST_CART_ADD: &str = "/api/marketplace/guest/cart";
const GUEST_ATTEMPTS: &str = "/api/marketplace/guest/command-attempts/";

/// An item page's cart add, as the stand-in answers it, to the account's cart or (with its id) a
/// guest's. The quantity says what happens: 7 is refused with nothing applied, 8 applies and its
/// answer is lost, 9's answer is lost and nothing is kept; any other applies, at position 12. A
/// guest's lookup answers what was kept.
fn cart_add(stand: &Stand, method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    let guest = headers.get("x-checkout-anonymous-cart-id").and_then(|v| v.to_str().ok()).filter(|id| id.starts_with("anon_"));
    if let Some(id) = path.strip_prefix(GUEST_ATTEMPTS) {
        return Some(match (guest, stand.kept.lock().unwrap().get(id)) {
            (None, _) => refusal(StatusCode::BAD_REQUEST, "anonymous_cart_required", "Sign in."),
            (Some(_), Some(attempt)) => Json(json!({ "attempt": attempt })).into_response(),
            (Some(_), None) => refusal(StatusCode::NOT_FOUND, "command_attempt_not_found", "Command attempt not found."),
        });
    }
    if *method != Method::POST || (path != ACCOUNT_CART_ADD && path != GUEST_CART_ADD) {
        return None;
    }
    if path == GUEST_CART_ADD && guest.is_none() {
        return Some(refusal(StatusCode::BAD_REQUEST, "anonymous_cart_required", "A guest cart is required."));
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    let attempt = sent["attemptId"].as_str().unwrap_or_default().to_owned();
    match sent["quantity"].as_u64() {
        Some(7) => return Some(refusal(StatusCode::BAD_REQUEST, "validation_failed", "Only 2 are available.")),
        Some(9) => return Some(StatusCode::SERVICE_UNAVAILABLE.into_response()),
        _ => {}
    }
    let kept = json!({
        "ownerStatus": "committed",
        "vector": [{ "lineId": "cli_new", "outcome": "succeeded", "message": null }],
        "commitReceipt": { "eventId": "evt_add", "globalPosition": "12" },
    });
    stand.kept.lock().unwrap().insert(attempt, kept.clone());
    if sent["quantity"].as_u64() == Some(8) {
        return Some(StatusCode::BAD_GATEWAY.into_response());
    }
    let receipt = r#"[{"sourceContextName":"checkout","maxGlobalPosition":"12","eventIds":["evt_add"]}]"#;
    let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "12".to_owned()), ("chase-sets-commit-receipt", receipt)];
    let answer = json!({ "id": "cli_new", "version": 1, "status": "added", "attempt": kept });
    Some((StatusCode::CREATED, headers, Json(answer)).into_response())
}

const ACCOUNT_SELL_LIST: &str = "/api/marketplace/account/sell-list";
const GUEST_SELL_LIST: &str = "/api/marketplace/guest/sell-list";
const STANDARD_TERMS: &str = "/api/marketplace/terms/public-standard/listing-preview";

/// A sell-list add and the public standard terms, as the stand-in answers them. An offer's line
/// is refused as the API refuses one without a listing (chase-sets/chase-sets#8830); a product's
/// is added at position 13. The terms are a 5% fee and a 5% shipping allowance.
fn sell_list(method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    if *method != Method::POST {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    if path == STANDARD_TERMS {
        let cents = crate::buying::price(sent["priceAmount"].as_str().unwrap_or_default())
            .and_then(|p| platform::money::cents(&p))
            .unwrap_or_default();
        let amount = |c: i64| format!("{}.{:02}", c / 100, c % 100);
        return Some(
            Json(json!({
                "marketplace_sales_fee_unit_amount": amount(cents / 20), "seller_net_unit_amount": amount(cents - cents / 20),
                "shipping_allowance_percentage_bps": 500, "source_label": "Standard seller terms",
                "resolved_at": "2026-10-25T19:25:20.646Z",
            }))
            .into_response(),
        );
    }
    if path != ACCOUNT_SELL_LIST && path != GUEST_SELL_LIST {
        return None;
    }
    let guest =
        headers.get("x-checkout-anonymous-sell-list-id").and_then(|v| v.to_str().ok()).filter(|id| id.starts_with("anon_"));
    if path == GUEST_SELL_LIST && guest.is_none() {
        return Some(refusal(StatusCode::BAD_REQUEST, "anonymous_sell_list_required", "Sign in."));
    }
    if sent["lineType"] == "selected-offer" {
        return Some(refusal(
            StatusCode::BAD_REQUEST,
            "validation_failed",
            "Selected offer sell-list lines must reference an Offer and exact Listing.",
        ));
    }
    let receipt = r#"[{"sourceContextName":"checkout","maxGlobalPosition":"13","eventIds":["evt_sell"]}]"#;
    let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "13".to_owned()), ("chase-sets-commit-receipt", receipt)];
    Some((StatusCode::CREATED, headers, Json(json!({ "id": "sll_new", "version": 1, "status": "added" }))).into_response())
}

const ACCOUNT_ALERTS: &str = "/api/marketplace/account/product-alerts";
const GUEST_ALERT_INTENTS: &str = "/api/marketplace/guest/product-alert-intents";

/// A Product Alert's create and a guest's intent, as the stand-in answers them: an alert whose
/// threshold is `999.99` is refused as the API refuses a bad one; the rest are created at position
/// 21, and a guest's intent (which needs its owner) is `pai_1`.
fn product_alerts(method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    if *method != Method::POST || (path != ACCOUNT_ALERTS && path != GUEST_ALERT_INTENTS) {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    if sent["thresholdAmount"] == "999.99" {
        return Some(refusal(StatusCode::BAD_REQUEST, "validation_failed", "Price threshold is too high for this stand-in."));
    }
    if path == GUEST_ALERT_INTENTS {
        let owner = headers.get("x-discovery-anonymous-product-alert-id").and_then(|v| v.to_str().ok());
        if !owner.is_some_and(|o| o.starts_with("anon_")) {
            return Some(refusal(StatusCode::BAD_REQUEST, "validation_failed", "Anonymous Product Alert owner is required."));
        }
        return Some(Json(json!({ "intent_id": "pai_1", "status": "active" })).into_response());
    }
    let receipt = r#"[{"sourceContextName":"discovery","maxGlobalPosition":"21","eventIds":["evt_alert"]}]"#;
    let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "21".to_owned()), ("chase-sets-commit-receipt", receipt)];
    Some((StatusCode::CREATED, headers, Json(json!({ "id": "pal_new", "version": 1, "status": "active" }))).into_response())
}

const RECENT_SAVED_LISTS: &str = "/api/marketplace/account/saved-lists/recent";
const LIST_ADDITIONS: &str = "/api/collections/account/list-additions";
const GUEST_SAVED_LIST_INTENTS: &str = "/api/collections/guest/saved-list-intents";

/// Add to List's calls, as the stand-in answers them. `watcher`'s recent lists are "Binder"
/// (`svl_binder`), and, for a read that waits for the addition at 31, the list it made. An
/// addition of 13 is refused as Collections refuses one it cannot apply; the rest apply at 31, to a
/// new list as `added` and to Binder as `merged`. A guest's intent (which needs its owner) is
/// `sli_1`.
fn saved_lists(stand: &Stand, session: &str, method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    if path == RECENT_SAVED_LISTS {
        if session != "watcher" {
            return Some(refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "This account cannot manage Saved Lists."));
        }
        let mut items = vec![json!({
            "listId": "svl_binder", "title": "Binder", "lineCount": 4, "trackedUnitCount": 9, "version": 3,
            "changedAt": "2026-10-24T00:00:00.000Z",
        })];
        if waits_for(headers).as_deref() == Some("31")
            && let Some(made) = stand.kept.lock().unwrap().get("saved_list")
        {
            items.insert(0, made.clone());
        }
        return Some(Json(json!({ "items": items, "total": items.len(), "count": items.len() })).into_response());
    }
    if *method != Method::POST || (path != LIST_ADDITIONS && path != GUEST_SAVED_LIST_INTENTS) {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    if path == GUEST_SAVED_LIST_INTENTS {
        let owner = headers.get("x-collections-anonymous-saved-list-id").and_then(|v| v.to_str().ok());
        if !owner.is_some_and(|o| o.starts_with("anon_")) {
            return Some(refusal(StatusCode::BAD_REQUEST, "anonymous_saved_list_required", "Save the Product again."));
        }
        return Some(
            (StatusCode::CREATED, Json(json!({ "intent": { "intentId": "sli_1", "status": "active" }, "analyticsLabel": "x" })))
                .into_response(),
        );
    }
    if sent["trackedQuantity"] == 13 {
        return Some(refusal(
            StatusCode::CONFLICT,
            "list-unavailable",
            "This Product could not be added to the Saved List. Review the List and try again.",
        ));
    }
    let destination = &sent["destination"];
    let (list, title, line) = if destination["kind"] == "new" {
        let list = destination["listId"].as_str().unwrap_or_default().to_owned();
        let title = destination["title"].as_str().unwrap_or_default().to_owned();
        let made = json!({ "listId": list, "title": title, "lineCount": 1, "trackedUnitCount": 1, "version": 1, "changedAt": "2026-10-25T00:00:00.000Z" });
        stand.kept.lock().unwrap().insert("saved_list".into(), made);
        (list, title, "added")
    } else {
        (destination["listId"].as_str().unwrap_or_default().to_owned(), "Binder".to_owned(), "merged")
    };
    let receipt = r#"[{"sourceContextName":"collections","maxGlobalPosition":"31","eventIds":["evt_saved"]}]"#;
    let receipt = percent_encoding::utf8_percent_encode(receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "31".to_owned()), ("chase-sets-commit-receipt", receipt)];
    let answer = json!({ "command": {}, "listId": list, "title": title, "lineStatus": line, "alreadyClaimed": false, "analyticsLabel": "x" });
    Some((headers, Json(answer)).into_response())
}

/// The search's category, as Discovery has it.
fn singles() -> Value {
    json!({
        "category_id": "ctg_singles", "key": "singles", "slug": "singles-x1", "name": "Singles", "display_order": 0,
        "description": "Raw and graded single cards.", "item_count": 12,
    })
}

/// Search's reads, as the stand-in answers them: one category, `singles-x1`; 30 results, the first
/// `limit` sent with a next page while there are more; `charizard psa 10` read as a grade (until
/// the address is marked `interpreted`); `broken` failing.
fn search(uri: &Uri) -> Option<Response> {
    let path = uri.path();
    if path == "/api/marketplace/categories" {
        return Some(Json(json!({ "items": [singles()], "total": 1, "count": 1 })).into_response());
    }
    if let Some(slug) = path.strip_prefix("/api/marketplace/categories/") {
        return Some(if slug == "singles-x1" {
            Json(singles()).into_response()
        } else {
            refusal(StatusCode::NOT_FOUND, "not_found", "Category not found.")
        });
    }
    if let Some(slug) = path.strip_prefix("/api/marketplace/sets/") {
        return Some(set(slug));
    }
    if path != "/api/marketplace/items" {
        return None;
    }
    let sent = query(&uri.to_string());
    let words = sent.get("search").map_or("", String::as_str);
    if words == "broken" {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let interpretation = (words == "charizard psa 10" && !sent.contains_key("interpreted")).then(|| {
        json!({ "remainingQuery": "charizard", "applied": [{ "param": "dimension.dim_grade", "optionId": "chc_10", "label": "Gem Mint 10" }] })
    });
    let limit: usize = sent.get("limit").and_then(|l| l.parse().ok()).unwrap_or(24);
    // Thirty results. A cursor is the next page: `c1` the rows after the first 24, `gone` one the
    // API no longer takes (a first page again, marked restarted), `broken` a failed read.
    let cursor = sent.get("cursor").map(String::as_str);
    if cursor == Some("broken") {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let from = if cursor == Some("c1") { 25 } else { 1 };
    let shown = limit.min(31 - from);
    let last = from + shown - 1;
    let items: Vec<Value> = (from..=last)
        .map(|n| {
            let listed = n % 2 == 1;
            json!({
                "catalog_item_id": format!("cat_{n}"), "slug": format!("card-{n}"), "title": format!("Card {n}"),
                "subtitle": "Base Set", "language_code": if n == 2 { "ja" } else { "en" }, "image_urls": [],
                "product_asset_sets": [], "image_fallback": null, "display_badges": [{ "kind": "rarity", "label": "Holo" }],
                "market_summary": listed.then(|| json!({
                    "lowest_price_amount": "389.00", "lowest_price_currency_code": "USD", "active_listing_count": 2,
                })),
            })
        })
        .collect();
    let facets = json!([{ "id": "dim_grade", "kind": "dimension", "label": "Grade", "values": [
        { "id": "chc_10", "label": "Gem Mint 10", "count": 9, "selected": sent.get("dimension.dim_grade").map(String::as_str) == Some("chc_10") },
        { "id": "chc_9", "label": "Mint 9", "count": 4, "selected": false },
    ] }]);
    let mut page = json!({
        "items": items, "facets": facets, "category_counts": [{ "slug": "singles-x1", "count": 7 }],
        "total": cursor.is_none().then_some(30),
        "count": shown, "nextCursor": (last < 30).then_some("c1"), "retrievalMode": "lexical",
        "interpretation": interpretation, "resultSetKey": "k",
    });
    if cursor == Some("gone") {
        page["cursorRestarted"] = json!(true);
    }
    Some(Json(page).into_response())
}

/// A set's read, as the stand-in answers it: `base-set` (old slug `base`) with two of its three
/// items, one listed; `empty-set` with none; `down` failing; any other unknown.
fn set(slug: &str) -> Response {
    let card = |n: u32, listed: bool| {
        json!({
            "catalog_item_id": format!("cat_set_{n}"), "slug": format!("set-card-{n}"), "title": format!("Set Card {n}"),
            "subtitle": format!("Base Set {n}/102"), "image_urls": [], "product_asset_sets": [], "image_fallback": null,
            "market_summary": listed.then(|| json!({ "lowest_price_amount": "12.50", "lowest_price_currency_code": "USD", "active_listing_count": 1 })),
        })
    };
    let set = |slug: &str, items: Vec<Value>, count: u64| {
        json!({
            "reference_record_id": "ref_base_set", "type_key": "expansion", "key": slug, "slug": slug, "name": "Base Set",
            "code": "BS", "game": "Pokemon Trading Card Game", "release_date": "1999-01-09", "reference_card_count": 102,
            "item_count": count, "items": items, "updated_at": "2026-10-24T03:54:25.877Z",
        })
    };
    match slug {
        "base-set" | "base" => Json(set("base-set", vec![card(1, true), card(2, false)], 3)).into_response(),
        "empty-set" => Json(set("empty-set", Vec::new(), 0)).into_response(),
        "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Set not found."),
    }
}

/// A listing's public page and its reports, as the stand-in answers them: `psa-8` (old slug
/// `old-psa-8`) is a PSA 8 Charizard from Chase Sets in Chicago; `away` is the same, its seller
/// away until a day; `down` fails; any other is unknown. A report is received, except from the
/// visitor `anon_repeat` (reported already) and `anon_busy` (too many).
fn public_listings(method: &Method, path: &str, headers: &HeaderMap) -> Option<Response> {
    const PUBLIC: &str = "/api/marketplace/listings/";
    let rest = path.strip_prefix(PUBLIC)?;
    if let Some(id) = rest.strip_suffix("/report") {
        if *method != Method::POST || id != "lst_psa_8" {
            return None;
        }
        let visitor = headers.get("x-marketplace-anonymous-report-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
        return Some(match visitor {
            "anon_repeat" => {
                refusal(StatusCode::CONFLICT, "report_already_submitted", "This reporter has already reported this content.")
            }
            "anon_busy" => refusal(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many requests."),
            _ => (StatusCode::CREATED, Json(json!({ "id": "rpt_1", "status": "submitted" }))).into_response(),
        });
    }
    if *method != Method::GET {
        return None;
    }
    let listing = |slug: &str, away: bool| {
        json!({
            "listing_id": "lst_psa_8", "listing_slug": slug, "account_id": "acc_chase", "catalog_catalog_item_id": "cat_charizard",
            "catalog_item_slug": "charizard", "product_id": "cat_charizard::psa8", "item_title": "Charizard",
            "item_subtitle": "Base Set 4/102 Holo Rare", "selected_options": [{ "dimensionId": "dim_grade", "optionId": "chc_8" }],
            "product_summary": "Form: graded | Grading Company: psa | Grade: nm-mt-8", "ship_from_code": "CHI-ANNEX-2",
            "price_amount": "749.00", "price_currency_code": "USD", "listing_stream_version": 1,
            "shipping_allowance_percentage_bps": 500, "quantity_cap": 1, "visible_quantity": 1, "status": "active",
            "seller_slug": "chase-sets", "seller_display_name": "Chase Sets", "seller_average_rating": "5.00", "seller_review_count": 1,
            "seller_listing_availability_status": if away { "unavailable" } else { "available" },
            "seller_available_again_at": if away { json!("2026-11-08T00:00:00.000Z") } else { Value::Null },
            "seller_at_capacity": false, "created_at": "2026-10-24T03:55:32.446Z", "updated_at": "2026-10-24T03:55:33.413Z",
        })
    };
    Some(match rest {
        "psa-8" | "old-psa-8" => Json(listing("psa-8", false)).into_response(),
        "away" => Json(listing("away", true)).into_response(),
        "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Listing not found."),
    })
}

/// An account's public page, its chips and its reviews' reports, as the stand-in answers them:
/// `chase-sets` (old slug `old-chase`, id `acc_chase`) is an active seller with 23 reviews and
/// two listings; `quiet` has nothing yet and its chips fail; `closed` is closed; `down` fails;
/// any other is unknown. A review's report needs an account (a visitor is a 401): `other` reported
/// it already, `stale` sent too many, and `rev_refused` cannot be reported.
fn public_accounts(method: &Method, path: &str, session: &str) -> Option<Response> {
    if let Some(review) = path.strip_prefix("/api/marketplace/reviews/").and_then(|r| r.strip_suffix("/report")) {
        if *method != Method::POST {
            return None;
        }
        return Some(match (session, review) {
            ("" | "nobody", _) => refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in."),
            ("other", _) => {
                refusal(StatusCode::CONFLICT, "report_already_submitted", "This reporter has already reported this content.")
            }
            ("stale", _) => refusal(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many requests."),
            (_, "rev_refused") => refusal(StatusCode::BAD_REQUEST, "validation_failed", "This review cannot be reported."),
            _ => (StatusCode::CREATED, Json(json!({ "id": "rpt_review", "status": "submitted" }))).into_response(),
        });
    }
    let rest = path.strip_prefix("/api/marketplace/accounts/")?;
    if *method != Method::GET {
        return None;
    }
    if let Some(id) = rest.strip_suffix("/behavioral-metrics-chips") {
        return Some(match id {
            "acc_chase" => {
                Json(json!({ "shipsOnTime": true, "lowCancellationRate": null, "lowDisputeRate": true })).into_response()
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        });
    }
    let review = |id: &str, role: &str, rating: u8, disposition: &str| {
        json!({
            "review_id": id, "author_display_name": "Collector Zero", "author_role": role, "rating": rating,
            "feedback": format!("Review {id}"), "scoring_disposition": disposition, "disposition_reason_code": "normal-completion",
            "resolution_context": null, "remedy_kind": null, "submitted_at": "2026-10-20T15:00:00.000Z",
            "updated_at": "2026-10-20T15:00:00.000Z", "reply_feedback": if id == "rev_1" { json!("Thanks!") } else { Value::Null },
            "reply_status": if id == "rev_1" { json!("active") } else { Value::Null },
        })
    };
    let listing = |id: &str, slug: &str, code: &str| {
        json!({
            "listing_id": id, "listing_slug": slug, "catalog_catalog_item_id": "cat_charizard", "catalog_item_slug": "charizard",
            "item_title": "Charizard", "product_summary": "Form: graded | Grading Company: psa | Grade: nm-mt-8",
            "ship_from_code": code, "price_amount": "749.00", "price_currency_code": "USD", "visible_quantity": 2,
            "max_units_per_order": 1, "max_units_per_day": null, "max_units_per_customer_account": null,
        })
    };
    let account = |slug: &str, id: &str, status: &str| {
        json!({
            "account_id": id, "account_slug": slug, "account_display_name": "Chase Sets", "status": status,
            "created_at": "2025-03-04T00:00:00.000Z", "active_listing_count": 0, "badges": [], "founder_number": null,
            "reviews": { "items": [], "total": 0 }, "listings": [],
        })
    };
    let slug = rest.split('?').next().unwrap_or_default();
    Some(match slug {
        "chase-sets" | "old-chase" | "acc_chase" => {
            let mut a = account("chase-sets", "acc_chase", "active");
            a["active_listing_count"] = json!(2);
            a["badges"] = json!(["trusted-seller", "founding-account"]);
            a["founder_number"] = json!(7);
            a["average_rating_as_seller"] = json!("4.50");
            a["review_count_as_seller"] = json!(20);
            a["rating_count_as_seller"] = json!(18);
            a["rating_5_count_as_seller"] = json!(12);
            a["rating_4_count_as_seller"] = json!(6);
            a["review_count_as_buyer"] = json!(3);
            a["rating_count_as_buyer"] = json!(3);
            a["average_rating_as_buyer"] = json!("5.00");
            a["rating_5_count_as_buyer"] = json!(3);
            a["reviews"] = json!({ "items": [review("rev_1", "buyer", 5, "included"), review("rev_refused", "seller", 3, "context-only")], "total": 23 });
            a["listings"] = json!([listing("lst_psa_8", "psa-8", "CHI-ANNEX-2"), listing("lst_stl", "stl-copy", "STL-1")]);
            Json(a).into_response()
        }
        "quiet" => Json(account("quiet", "acc_quiet", "active")).into_response(),
        "closed" => Json(account("closed", "acc_closed", "closed")).into_response(),
        "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Account not found."),
    })
}

/// The notification center's calls, as the stand-in answers them for `watcher` (`notices_down`'s
/// reads fail): two notifications, `dlv_1` unread (marking `dlv_broken` fails), five channels
/// (`sms` and `rcs` too, as the API lists them; `nope` is refused), and two Product alerts.
/// Pausing `pal_1` commits at 22, and a read after it has it paused; `pal_lag`'s write commits
/// at 43, which the read has not caught up with; `pal_down`'s at 44, which the read fails at;
/// `pal_gone` is refused.
fn notification_center(session: &str, method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    let item = |id: &str, title: &str, kind: &str, href: &str, read: bool| {
        json!({
            "deliveryId": id, "messageType": kind, "criticality": "commerce", "title": title, "body": format!("{title}, in words."),
            "actionHref": href, "readAt": if read { json!("2026-10-25T16:00:00.000Z") } else { Value::Null },
            "createdAt": "2026-10-25T15:10:26.601Z",
        })
    };
    let feed = |all_read: bool| {
        json!({
            "items": [
                item("dlv_1", "Order ORD-1 cancelled", "ordering.order.cancelled", "/account/purchases/ord_1", all_read),
                item("dlv_2", "A Charizard matched your alert", "discovery.product-alert.matched", "/items/charizard", true),
            ],
            "count": 2, "unread": if all_read { 0 } else { 1 },
        })
    };
    let down = session == "notices_down";
    match (method, path) {
        (&Method::GET, "/api/notifications/center") if down => Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        (&Method::GET, "/api/notifications/center") => Some(Json(feed(false)).into_response()),
        (&Method::POST, "/api/notifications/center/read-all") => {
            Some(Json(json!({ "status": "read", "feed": feed(true) })).into_response())
        }
        (&Method::POST, "/api/notifications/center/dlv_broken/read") => Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        (&Method::POST, p) if p.starts_with("/api/notifications/center/") && p.ends_with("/read") => {
            Some(Json(json!({ "status": "read", "feed": feed(true) })).into_response())
        }
        (&Method::GET, "/api/notifications/preferences") if down => Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        (&Method::GET, "/api/notifications/preferences") => Some(
            Json(json!({ "items": [
                { "key": "web", "enabled": true }, { "key": "email", "enabled": true }, { "key": "sms", "enabled": false },
                { "key": "rcs", "enabled": false }, { "key": "product-alerts", "enabled": true },
            ] }))
            .into_response(),
        ),
        (&Method::POST, p) if p.starts_with("/api/notifications/preferences/") => {
            let key = &p["/api/notifications/preferences/".len()..];
            if key == "nope" {
                return Some(refusal(StatusCode::BAD_REQUEST, "invalid_preference", "Choose a notification channel."));
            }
            let sent: Value = serde_json::from_str(body).unwrap_or_default();
            Some(Json(json!({ "item": { "key": key, "enabled": sent["enabled"] == true } })).into_response())
        }
        (&Method::GET, ACCOUNT_ALERTS) => {
            if waits_for(headers).as_deref() == Some("44") {
                return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
            if waits_for(headers).as_deref() == Some("43") {
                return Some(refusal(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "projection_freshness_timeout",
                    "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
                ));
            }
            let paused = waits_for(headers).as_deref() == Some("22");
            let alert = |id: &str, side: &str, threshold: Value, status: &str| {
                json!({
                    "alert_id": id, "catalog_catalog_item_id": "cat_charizard", "product_id": "cat_charizard::psa8",
                    "product_summary": "Charizard, PSA 8", "market_side": side, "threshold_amount": threshold, "status": status,
                })
            };
            Some(
                Json(json!({ "items": [
                    alert("pal_1", "listing", json!("25.00"), if paused { "paused" } else { "active" }),
                    alert("pal_2", "offer", Value::Null, "paused"),
                ], "total": 2, "count": 2 }))
                .into_response(),
            )
        }
        (&Method::POST, p) if p.starts_with("/api/marketplace/account/product-alerts/pal_") => {
            let (id, action) = p["/api/marketplace/account/product-alerts/".len()..].split_once('/')?;
            Some(match id {
                "pal_gone" => refusal(StatusCode::BAD_REQUEST, "validation_failed", "Product alert not found."),
                "pal_lag" => committed(StatusCode::OK, "discovery", "43", json!({ "id": id, "version": 2, "status": action })),
                "pal_down" => committed(StatusCode::OK, "discovery", "44", json!({ "id": id, "version": 2, "status": action })),
                _ => committed(StatusCode::OK, "discovery", "22", json!({ "id": id, "version": 2, "status": action })),
            })
        }
        _ => None,
    }
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

    /// The first `count` server-sent events of the stream `req` opens (their `event:`, `id:`
    /// and `data:`), or what came before it ended.
    async fn events(&self, req: Request<Body>, count: usize) -> Vec<(String, String, String)> {
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
    // Corten's `Refused::unavailable`: a 503, not a sign-in.
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a failed lookup must not send the user to sign in again");
    assert!(pilot.writes().is_empty(), "the refused write reached nothing");
}

#[tokio::test]
async fn an_error_page_is_drawn_for_who_is_asking() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/nowhere", Some("seller"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("There is nothing at this address.") && html.contains("<header"), "with the member's nav: {html}");
    let (status, _, html) = pilot.send(get("/account/nowhere", None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!html.contains("<header"), "a visitor has no nav: {html}");
    let (status, _, html) = pilot.send(get(SCREEN, Some("other"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(html.contains("Your role cannot open this page.") && html.contains("<header"), "{html}");
    // A session the API could not read is said so, not as a failed page.
    let (status, _, html) = pilot.send(get(SCREEN, Some("down"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(html.contains("We could not check who you are.") && !html.contains("<header"), "{html}");
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
    // A patch element without an id would be a 500 here (todd-skelton/corten#61).
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
    // A patch element without an id would be a 500 here (todd-skelton/corten#61).
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

/// Each form on the page that starts checkout, in order.
fn checkout_forms(html: &str) -> Vec<&str> {
    let mut forms = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<form ") {
        let end = start + rest[start..].find("</form>").expect("a closed form") + "</form>".len();
        if rest[start..end].contains(r#"action="/account/cart/checkout""#) {
            forms.push(&rest[start..end]);
        }
        rest = &rest[end..];
    }
    forms
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
    let (status, headers, html) = pilot.send(get(CART_SCREEN, Some("buyer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(csp.contains("form-action 'self' http://localhost:7753;"), "the checkout forms may go to marketplace: {csp}");
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
    // Use lower price (drawn first, beside it) posts the accepted decision, Check out the declined
    // one, each for the offer's line and listing.
    let forms = checkout_forms(&html);
    assert_eq!(forms.len(), 2, "{html}");
    for (form, (choice, label)) in forms.iter().zip([("accepted", "Use lower price"), ("declined", "Check out")]) {
        assert!(form.contains(r#"method="post" action="/account/cart/checkout""#), "{form}");
        assert!(form.contains(&format!(r#"name="offer" value="{choice}""#)), "{form}");
        assert!(form.contains(r#"name="line" value="cli_charizard""#), "{form}");
        assert!(form.contains(r#"name="listing" value="lst_vault_charizard""#), "{form}");
        assert!(form.contains(&format!(">{label}</button>")), "{form}");
    }
    assert!(forms.iter().all(|f| !f.contains("data-patch")), "the browser follows each form's redirect to marketplace: {html}");
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
    // Corten's `Refused::unavailable`: a 503, not a sign-in.
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a failed lookup must not send the user away");
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
    assert_eq!(lines[0]["price"], json!({ "state": "from", "amount": "53.85", "currency": "USD" }), "the API's amount: {body}");
    assert_eq!(lines[1]["reason"], "currency-mismatch", "{body}");
    assert_eq!(lines[1]["price"], json!({ "state": "deferred" }), "{body}");
    assert_eq!(screen["data"]["readiness"]["blockedLineCount"], 2, "{body}");
}

/// The calls to start checkout, in order (the session lookups and cart reads left out).
fn checkout_calls(pilot: &Pilot) -> Vec<Call> {
    pilot
        .stand
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.method == Method::POST && c.path.starts_with("/api/marketplace/"))
        .cloned()
        .collect()
}

const CHECK_OUT: &str = "/account/cart/checkout";
const DECLINED: &str = "offer=declined&line=cli_charizard&listing=lst_vault_charizard";

#[tokio::test]
async fn check_out_starts_a_session_and_sends_the_buyer_to_marketplace_with_its_receipt() {
    let pilot = Pilot::new().await;
    let (status, headers, body) = pilot.send(post(CHECK_OUT, "buyer", DECLINED, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/checkout/buy/session/chk_1?afterWrite="), "{to}");
    let receipt: Value = serde_json::from_str(&query(to)["afterWrite"]).unwrap();
    assert_eq!(receipt["commitPosition"], "9", "the session's receipt: {receipt}");
    assert_eq!(receipt["sources"][0]["sourceContextName"], "checkout", "{receipt}");
    assert!(!headers.contains_key(header::SET_COOKIE), "no guest cart to forget");

    // The readiness is read again with the posted decision, and the session started from it.
    let calls = checkout_calls(&pilot);
    let paths: Vec<_> = calls.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, ["/api/marketplace/account/cart/readiness", "/api/marketplace/account/checkout-sessions"]);
    let decisions: Value = serde_json::from_str(&calls[0].body).unwrap();
    assert_eq!(
        decisions,
        json!({ "optimization": { "decision": "declined", "lineId": "cli_charizard", "listingId": "lst_vault_charizard" } })
    );
    let started: Value = serde_json::from_str(&calls[1].body).unwrap();
    assert_eq!(
        started,
        json!({ "source": {
            "type": "cart", "readinessSnapshotId": "cr_fresh", "readinessSourceRevision": "cr_rev", "readinessDecisions": decisions,
        } })
    );
    assert_eq!(calls[1].headers[header::COOKIE], "chase_sets_session=buyer");

    // With the script: the runtime follows corten-location.
    let (status, headers, _) = pilot.send(post(CHECK_OUT, "buyer", DECLINED, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().starts_with("http://localhost:7753/checkout/buy/session/chk_1?"));
}

#[tokio::test]
async fn check_out_without_an_offer_sends_no_decision() {
    let pilot = Pilot::new().await;
    let (status, _, body) = pilot.send(post(CHECK_OUT, "buyer", "offer=&line=&listing=", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(checkout_calls(&pilot)[0].body, "{}", "no optimization");
}

#[tokio::test]
async fn check_out_brings_the_guest_cart_along_and_forgets_it() {
    let pilot = Pilot::new().await;
    let mut req = post(CHECK_OUT, "buyer", DECLINED, false);
    req.headers_mut().insert(header::COOKIE, "chase_sets_session=buyer; chase_sets_anonymous_cart=anon_1".parse().unwrap());
    let (status, headers, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let calls = checkout_calls(&pilot);
    let paths: Vec<_> = calls.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/api/marketplace/guest/cart/merge-to-account",
            "/api/marketplace/account/cart/readiness",
            "/api/marketplace/account/checkout-sessions"
        ]
    );
    assert!(calls.iter().all(|c| c.headers["x-checkout-anonymous-cart-id"] == "anon_1"), "{calls:?}");
    let forget = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(forget.starts_with("chase_sets_anonymous_cart=; Path=/;") && forget.contains("Max-Age=0"), "{forget}");
}

#[tokio::test]
async fn a_checkout_the_api_refuses_is_the_cart_with_its_reason() {
    let pilot = Pilot::new().await;
    for script in [false, true] {
        let (status, headers, html) = pilot.send(post(CHECK_OUT, "blocked", DECLINED, script)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
        assert!(!headers.contains_key(header::LOCATION) && !headers.contains_key("corten-location"));
        let page = text(&html);
        assert!(page.contains("Checkout issue Cart readiness changed. Review your cart before checkout."), "{page}");
        assert!(page.contains("Some items need attention"), "the cart as it is now: {page}");
    }
}

#[tokio::test]
async fn only_an_account_cart_checks_out_here() {
    let pilot = Pilot::new().await;
    for session in ["guest", "nobody"] {
        let (status, headers, _) = pilot.send(post(CHECK_OUT, session, DECLINED, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{session}");
        assert_eq!(headers[header::LOCATION], "http://localhost:7753/account/cart", "{session}: marketplace's own cart");
    }
    assert!(checkout_calls(&pilot).is_empty(), "nothing started");
}

/// The cart writes the stand-in received, each as the JSON it was sent.
fn cart_writes(pilot: &Pilot) -> Vec<Value> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path == CART_COMMANDS).map(|c| serde_json::from_str(&c.body).unwrap()).collect()
}

/// The cart attempt lookups the stand-in received.
fn cart_lookups(pilot: &Pilot) -> Vec<String> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with(CART_ATTEMPTS)).map(|c| c.path.clone()).collect()
}

/// Each form on the page that posts to `action`, in order.
fn forms_to<'a>(html: &'a str, action: &str) -> Vec<&'a str> {
    let mut forms = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<form ") {
        let end = start + rest[start..].find("</form>").expect("a closed form") + "</form>".len();
        if rest[start..end].contains(&format!(r#"action="{action}""#)) {
            forms.push(&rest[start..end]);
        }
        rest = &rest[end..];
    }
    forms
}

/// The opening tag of each fieldset in `html`.
fn fieldsets(html: &str) -> Vec<&str> {
    html.match_indices("<fieldset ").map(|(at, _)| &html[at..at + html[at..].find('>').unwrap()]).collect()
}

const QUANTITY: &str = "/account/cart/quantity";
const REMOVE: &str = "/account/cart/remove";
const LOCK: &str = "/account/cart/lock";

#[tokio::test]
async fn each_line_has_its_writes_as_plain_forms_for_every_line_merged_into_it() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(CART_SCREEN, Some("blocked"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let steppers = forms_to(&html, QUANTITY);
    assert_eq!(steppers.len(), 2, "{html}");
    let merged = steppers[0];
    assert!(merged.contains(ATTEMPT_INPUT), "a new attempt with each form: {merged}");
    assert!(
        merged.contains(r#"name="line_id" value="cli_pikachu_a""#) && merged.contains(r#"name="line_id" value="cli_pikachu_b""#),
        "{merged}"
    );
    assert!(merged.contains(r#"name="quantity" value="3""#), "{merged}");
    assert!(
        merged.contains(r#"name="delta" value="-1" aria-label="Decrease""#)
            && merged.contains(r#"value="1" aria-label="Increase""#),
        "{merged}"
    );
    // Mew's quantity is 1: it can only go up.
    let one = steppers[1];
    assert!(one.contains(r#"value="-1" aria-label="Decrease" disabled"#), "{one}");
    assert_eq!(forms_to(&html, REMOVE).len(), 2, "{html}");
    // Only the line with a preferred listing it is not locked to can be locked.
    let locks = forms_to(&html, LOCK);
    assert_eq!(locks.len(), 1, "{html}");
    assert!(
        locks[0].contains(r#"name="preference" value="lst_pikachu""#) && locks[0].contains(">Lock this listing<"),
        "{}",
        locks[0]
    );
    assert_eq!(html.matches("data-patch").count(), 5, "the line writes patch in place: {html}");
    assert!(
        html.contains(r#"src="http://localhost:7753/fake-cdn/assets/pokemon_tcg_back.png" srcset="http://localhost:7753/fake-cdn/assets/mew-1x.png 1x, https://cdn.example/mew-2x.png 2x""#),
        "a site-relative picture is marketplace's: {html}"
    );
    assert!(forms_to(&html, CHECK_OUT).iter().all(|f| !f.contains("data-patch")), "checkout leaves for marketplace: {html}");
    assert!(fieldsets(&html).iter().all(|f| !f.contains("disabled")), "none paused: {html}");
}

#[tokio::test]
async fn a_quantity_step_is_one_attempt_and_the_cart_is_read_after_it() {
    let pilot = Pilot::new().await;
    let attempt = new_attempt();
    let body = format!("attempt={attempt}&line_id=cli_pikachu_a&line_id=cli_pikachu_b&quantity=3&delta=1");
    let (status, headers, html) = pilot.send(post(QUANTITY, "blocked", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/account/cart?after_write="), "{to}");
    let receipt: Value = serde_json::from_str(&query(to)["after_write"]).unwrap();
    assert_eq!(receipt["commitPosition"], "11", "{receipt}");
    // The first line takes the quantity and the one merged into it is removed, all or nothing.
    assert_eq!(
        cart_writes(&pilot),
        [json!({ "attemptId": attempt, "commands": [
            { "type": "quantity", "lineId": "cli_pikachu_a", "quantity": 4 },
            { "type": "remove", "lineId": "cli_pikachu_b" },
        ] })]
    );
    // The cart it redirects to waits for the write.
    let (status, _, _) = pilot.send(get(to, Some("blocked"))).await;
    assert_eq!(status, StatusCode::OK);
    let reads = cart_calls(&pilot);
    assert_eq!(waits_for(&reads.last().unwrap().headers).as_deref(), Some("11"));

    // A step below 1 is 1, and a post without an attempt (no script) is still one attempt.
    let (status, _, _) = pilot.send(post(QUANTITY, "blocked", "line_id=cli_eur&quantity=1&delta=-1", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let sent = cart_writes(&pilot).pop().unwrap();
    assert_eq!(sent["commands"], json!([{ "type": "quantity", "lineId": "cli_eur", "quantity": 1 }]));
    assert_eq!(sent["attemptId"].as_str().unwrap().len(), 36, "{sent}");
}

#[tokio::test]
async fn remove_and_lock_send_a_command_for_each_merged_line() {
    let pilot = Pilot::new().await;
    let lines = "line_id=cli_pikachu_a&line_id=cli_pikachu_b";
    let (status, _, _) = pilot.send(post(REMOVE, "blocked", &format!("attempt={}&{lines}", new_attempt()), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let (status, _, _) =
        pilot.send(post(LOCK, "blocked", &format!("attempt={}&{lines}&preference=lst_pikachu", new_attempt()), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let sent = cart_writes(&pilot);
    assert_eq!(
        sent[0]["commands"],
        json!([{ "type": "remove", "lineId": "cli_pikachu_a" }, { "type": "remove", "lineId": "cli_pikachu_b" }])
    );
    let lock = json!({
        "type": "fulfillment", "fulfillmentMode": "locked-listing", "lockedListingId": "lst_pikachu",
        "sellerPreferenceId": "lst_pikachu", "availabilityState": "available",
    });
    let with = |line: &str| {
        let mut command = lock.clone();
        command["lineId"] = json!(line);
        command
    };
    assert_eq!(sent[1]["commands"], json!([with("cli_pikachu_a"), with("cli_pikachu_b")]));

    // A lock without a preferred listing is refused before it is sent.
    let (status, _, html) =
        pilot.send(post(LOCK, "blocked", &format!("attempt={}&{lines}&preference=", new_attempt()), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(
        page.contains("Your cart change was not applied Choose a preferred listing before locking this cart line."),
        "{page}"
    );
    assert_eq!(cart_writes(&pilot).len(), 2, "nothing sent");
}

#[tokio::test]
async fn a_write_refused_or_applied_in_part_is_the_cart_with_what_did_not_apply() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(post(QUANTITY, "blocked", &format!("attempt={}&line_id=cli_refused&quantity=5&delta=1", new_attempt()), false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(page.contains("Your cart change was not applied Only 2 are available."), "the API's reason: {page}");
    assert!(page.contains("Some items need attention"), "the cart as it is now: {page}");
    assert!(html.contains(r#"data-attempt="failed-safe""#), "{html}");
    assert!(fieldsets(&html).iter().all(|f| !f.contains("disabled")), "a refusal pauses nothing: {html}");

    let body = format!("attempt={}&line_id=cli_pikachu_a&line_id=cli_gone", new_attempt());
    let (status, _, html) = pilot.send(post(REMOVE, "blocked", &body, false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    let page = text(&html);
    assert!(page.contains("Some cart changes were not applied Some of your changes were saved. These lines were not updated: Cart line not found."), "{page}");
    // What applied is read back after the write.
    assert_eq!(waits_for(&cart_calls(&pilot).last().unwrap().headers).as_deref(), Some("11"));
    assert!(cart_lookups(&pilot).is_empty(), "every answer arrived");
}

#[tokio::test]
async fn a_lost_answer_is_looked_up_once_and_one_not_found_pauses_the_cart_until_it_is_sent_again() {
    let pilot = Pilot::new().await;
    // Applied, its answer lost: the lookup finds it, and its receipt is the lookup's.
    let attempt = new_attempt();
    let (status, headers, html) =
        pilot.send(post(REMOVE, "blocked", &format!("attempt={attempt}&line_id=cli_lost"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let receipt: Value = serde_json::from_str(&query(headers[header::LOCATION].to_str().unwrap())["after_write"]).unwrap();
    assert_eq!(
        receipt["sources"],
        json!([{ "sourceContextName": "checkout", "maxGlobalPosition": "11", "eventIds": ["evt_cart"] }])
    );
    let commands = [crate::api::CartCommand::Remove { line_id: "cli_lost".into() }];
    let hash = crate::cart_attempt::request_hash(&crate::api::CartWrite::commands(&commands).body);
    assert_eq!(cart_lookups(&pilot), [format!("{CART_ATTEMPTS}{attempt}?kind=cart.commands&target=cart&requestHash={hash}")]);

    // Not found: not known, so the cart's writes are paused and the same write can be sent again.
    let attempt = new_attempt();
    let body = format!("attempt={attempt}&line_id=cli_unknown&quantity=2&delta=-1");
    let (status, _, html) = pilot.send(post(QUANTITY, "blocked", &body, false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert_eq!(cart_writes(&pilot).len(), 2, "never resent on its own");
    assert_eq!(cart_lookups(&pilot).len(), 2, "looked up once");
    let page = text(&html);
    assert!(page.contains("We couldn&#39;t confirm your cart change"), "{page}");
    let resend = forms_to(&html, QUANTITY).into_iter().find(|f| f.contains("Send the same change again")).expect("a resend");
    assert!(
        resend.contains(&format!(r#"name="attempt" value="{attempt}""#)) && !resend.contains("data-submit"),
        "the same attempt: {resend}"
    );
    assert!(resend.contains(r#"name="quantity" value="2""#) && resend.contains(r#"name="delta" value="-1""#), "{resend}");
    assert!(html.contains(r#"href="/account/cart">Refresh cart<"#), "{html}");
    let fieldsets = fieldsets(&html);
    assert_eq!(fieldsets.len(), 5, "two steppers, two removes, one lock: {html}");
    assert!(fieldsets.iter().all(|f| f.contains("disabled")), "every line write is paused: {html}");
}

#[tokio::test]
async fn a_cart_write_after_the_session_ended_signs_in() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post(REMOVE, "stale", &format!("attempt={}&line_id=cli_pikachu", new_attempt()), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7753/sign-in?returnTo=%2Faccount%2Fcart",
        "back to the cart, not the write"
    );
    assert!(cart_lookups(&pilot).is_empty(), "a refusal is not a lost answer");
}

#[tokio::test]
async fn a_cart_not_readable_yet_after_a_write_says_so_and_reads_again() {
    let pilot = Pilot::new().await;
    let (status, headers, html) =
        pilot.send(get(&format!("{CART_SCREEN}?after_write={}", receipt_at("43")), Some("buyer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!headers.contains_key("refresh"), "a Refresh header outlives the runtime's navigations (todd-skelton/corten#69)");
    assert!(
        html.contains(
            r#"<noscript data-corten-read-again="2" data-corten-head><meta http-equiv="refresh" content="2"></noscript>"#
        ),
        "read again shortly: {html}"
    );
    let page = text(&html);
    assert!(page.contains("Refreshing cart We saved your cart change and are refreshing the cart view."), "{page}");
    assert!(html.contains(r#"href="/account/cart">Refresh cart<"#) && !html.contains("data-cart-line"), "{html}");
    // A read that failed for good is the page that says the change could not be verified.
    let (status, _, html) = pilot.send(get(&format!("{CART_SCREEN}?after_write={}", receipt_at("44")), Some("buyer"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(!html.contains("data-corten-read-again"), "{html}");
    let (_, _, html) = pilot.send(get(CART_SCREEN, Some("buyer"))).await;
    assert!(!html.contains("data-corten-read-again"), "a cart read as it is waits for nothing");
}

/// A Discovery item: a card that is raw (in one of three conditions) or graded (one of seven
/// grades), with three listings and two offers, in the order the API ranks them.
fn item() -> Value {
    let option = |id: &str, label: &str, order: i64, numeric: Option<f64>| json!({ "optionId": id, "code": id, "label": label, "displayOrder": order, "numericValue": numeric });
    let raw = json!({ "dimensionId": "dim_form", "optionId": "chc_raw" });
    let graded = json!({ "dimensionId": "dim_form", "optionId": "chc_graded" });
    let listing = |id: &str, account: &str, price: &str, options: Value, quantity: u64| {
        json!({
            "listing_id": id, "account_id": account, "catalog_catalog_item_id": "cat_charizard",
            "product_id": format!("cat_charizard::{id}"), "selected_options": options,
            "product_summary": "Form: raw", "price_amount": price, "price_currency_code": "USD",
            "quantity_cap": quantity, "visible_quantity": quantity, "max_units_per_order": null,
            "max_units_per_day": null, "max_units_per_customer_account": if id == "lst_vault" { json!(2) } else { json!(null) },
            "seller_slug": format!("{account}-slug"), "seller_display_name": if account == "acc_vault" { "Card Vault" } else { "Chase Sets" },
            "seller_average_rating": if account == "acc_vault" { json!(null) } else { json!("4.75") }, "seller_review_count": 4,
            "status": "active", "listing_stream_version": 3, "seller_at_capacity": id == "lst_chase",
        })
    };
    let nm = json!({ "dimensionId": "dim_condition", "optionId": "chc_nm" });
    let offer = |id: &str, buyer: &str, price: &str| {
        json!({
            "offer_id": id, "buyer_account_id": buyer, "catalog_catalog_item_id": "cat_charizard",
            "product_id": "cat_charizard::dim_form:chc_raw|dim_condition:chc_nm|dim_grade:-",
            "selected_options": [raw, nm], "product_summary": "Form: Raw | Condition: Near Mint",
            "price_amount": price, "price_currency_code": "USD", "quantity_requested": 2, "status": "submitted",
            "buyer_slug": null, "buyer_display_name": if buyer == "acc_seller" { "You" } else { "Top Loader" },
            "buyer_average_rating": null, "buyer_review_count": 0,
        })
    };
    let grades: Vec<Value> =
        (1..=7).map(|n| option(&format!("chc_grade_{n}"), &format!("Grade {n}"), 7 - n, Some(n as f64))).collect();
    json!({
        "catalog_item_id": "cat_charizard",
        "slug": "charizard",
        "language_code": "en",
        "title": "Charizard",
        "subtitle": "Base Set 4/102",
        "description": "The iconic Charizard.",
        "blueprint": { "name": "Pokemon Card Single" },
        "status": "active",
        "field_values": [
            { "fieldId": "fld_number", "fieldName": "Card Number", "value": "4", "reference": null },
            { "fieldId": "fld_set", "fieldName": "Expansion", "value": { "referenceId": "ref_base" }, "reference": {
                "referenceId": "ref_base", "name": "Base Set", "typeKey": "expansion", "key": "base-set", "status": "active",
                "attributes": { "card-count": 102, "abbreviation": "BS", "language-editions": ["en"] },
                "relationships": [{ "relationshipType": "part-of", "referenceId": "ref_series", "reference": { "referenceId": "ref_series", "name": "Base", "typeKey": "series", "relationships": [] } }],
            } },
        ],
        "categories": [{ "categoryId": "ctg_tcg", "slug": "pokemon-tcg", "name": "Pokemon TCG" }],
        "tags": ["base-set", "base-set"],
        "image_urls": [],
        "product_asset_sets": [],
        "image_fallback": { "url": "/fake-cdn/assets/back.png", "alt": "Card back", "usage": "permanent" },
        "product_schema": {
            "dimensions": [
                { "dimensionId": "dim_condition", "dimensionName": "Condition", "valueKind": "ordered", "required": true,
                  "appliesWhen": [{ "dimensionId": "dim_form", "optionIds": ["chc_raw"] }],
                  "allowedOptions": [option("chc_lp", "Lightly Played", 1, None), option("chc_nm", "Near Mint", 0, None)] },
                { "dimensionId": "dim_form", "dimensionName": "Form", "valueKind": "unordered", "required": true, "appliesWhen": [],
                  "allowedOptions": [option("chc_raw", "Raw", 0, None), option("chc_graded", "Graded", 1, None)] },
                { "dimensionId": "dim_grade", "dimensionName": "Grade", "valueKind": "numeric", "required": true,
                  "appliesWhen": [{ "dimensionId": "dim_form", "optionIds": ["chc_graded"] }], "allowedOptions": grades },
            ],
            "canonicalDimensionOrder": [{ "dimensionId": "dim_form" }, { "dimensionId": "dim_condition" }, { "dimensionId": "dim_grade" }],
        },
        "updated_at": "2026-10-24 03:54:25.777+00",
        "market_summary": { "lowest_price_amount": "389.00", "lowest_price_currency_code": "USD", "active_listing_count": 3, "total_visible_quantity": 4 },
        "market_listings": [
            listing("lst_vault", "acc_vault", "389.00", json!([raw, nm]), 2),
            listing("lst_gone", "acc_vault", "395.00", json!([raw, nm]), 0),
            listing("lst_chase", "acc_chase", "412.50", json!([raw, nm]), 1),
            listing("lst_psa", "acc_vault", "735.00", json!([graded, { "dimensionId": "dim_grade", "optionId": "chc_grade_7" }]), 1),
        ],
        "offer_demand_matches": [offer("off_high", "acc_buyer", "380.00"), offer("off_mine", "acc_seller", "350.00")],
        "market_products": [
            { "product_id": "cat_charizard::lst_vault", "lowest_listing_id": "lst_vault", "best_offer_id": null },
            { "product_id": "cat_charizard::lst_chase", "lowest_listing_id": "lst_chase", "best_offer_id": null },
        ],
        "market_product_listings": [],
    })
}

/// The Discovery API's item read: `charizard` (or its id), with the listings published here as
/// the seller's; `unlisted` is the same item with no listings or offers; `down` fails, anything
/// else is unknown. `charizard` has three similar items, one with its search card, one with only
/// its card back and one with no picture; `unlisted`'s similar items fail.
fn discovery_item(stand: &Stand, id: &str) -> Response {
    match id {
        "charizard/similar" => Json(json!({ "mode": "category", "count": 3, "items": [
            {
                "catalog_item_id": "cat_blastoise", "slug": "blastoise", "title": "Blastoise", "subtitle": "Base Set 2/102",
                "image_urls": ["/fake-cdn/blastoise.png"], "image_fallback": null,
                "product_asset_sets": [{ "variants": [
                    { "role": "search-card", "density": 2, "width": 328, "height": 458, "publicUrl": "/fake-cdn/blastoise-328.webp" },
                    { "role": "search-card", "density": 1, "width": 164, "height": 229, "publicUrl": "/fake-cdn/blastoise-164.webp" },
                    { "role": "thumbnail", "density": 1, "width": 64, "height": 89, "publicUrl": "/fake-cdn/blastoise-64.webp" },
                ] }],
            },
            {
                "catalog_item_id": "cat_bulbasaur", "slug": "bulbasaur", "title": "Bulbasaur", "subtitle": "Base Set 44/102",
                "image_urls": [], "product_asset_sets": [],
                "image_fallback": { "url": "/fake-cdn/assets/back.png", "alt": "Card back", "usage": "permanent",
                    "variants": { "card": { "oneX": "/fake-cdn/assets/back-card.png", "twoX": "/fake-cdn/assets/back-card@2x.png" } } },
            },
            { "catalog_item_id": "cat_mew", "slug": "", "title": "Mew", "subtitle": null, "image_urls": [], "product_asset_sets": [], "image_fallback": null },
        ] }))
        .into_response(),
        "unlisted/similar" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "pictured" => {
            let mut item = item();
            item["slug"] = json!("pictured");
            item["image_urls"] = json!(["/fake-cdn/front.png", "/fake-cdn/back.png"]);
            Json(item).into_response()
        }
        "unlisted" => {
            let mut item = item();
            item["slug"] = json!("unlisted");
            item["market_listings"] = json!([]);
            item["offer_demand_matches"] = json!([]);
            Json(item).into_response()
        }
        "charizard" | "cat_charizard" => {
            let mut item = item();
            let raw = json!([{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }]);
            for (id, listing) in stand.listings.lock().unwrap().iter().filter(|(_, l)| l["published"] == true) {
                item["market_listings"].as_array_mut().unwrap().push(json!({
                    "listing_id": id, "account_id": "acc_seller", "catalog_catalog_item_id": "cat_charizard",
                    "product_id": OFFERED, "selected_options": raw, "product_summary": "Form: raw",
                    "price_amount": listing["priceAmount"], "price_currency_code": listing["priceCurrencyCode"],
                    "quantity_cap": listing["quantityCap"], "visible_quantity": listing["quantityCap"],
                    "max_units_per_order": null, "max_units_per_day": null, "max_units_per_customer_account": null,
                    "seller_slug": "seller", "seller_display_name": "You", "seller_average_rating": null,
                    "seller_review_count": 0, "status": "active", "listing_stream_version": 2, "seller_at_capacity": false,
                }));
            }
            Json(item).into_response()
        }
        "down" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Item not found."),
    }
}

const ITEM_PAGE: &str = "/items/charizard";

const ROLLUPS: &str = "/api/marketplace/market-rollups/";

/// The platform's realtime stream: a heartbeat, then one change to Charizard (a listing's
/// patch), then the stream ends (the client connects again).
fn realtime() -> Response {
    let patch = r#"{"kind":"projection.patch","context":"discovery","projection":"discovery-market","topics":["item:cat_charizard"],"changes":[{"op":"upsert","entity":"discovery.marketListing","id":"lst_vault","value":{}}]}"#;
    let body = format!("id: c1\nevent: heartbeat\ndata: {{}}\nretry: 1000\n\nid: c2\nevent: projection.patch\ndata: {patch}\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

/// Pricing's market rollups: Charizard's `lst_vault` product (the raw one the page picks) has
/// sold in dollars (one sale in 30 days, four units in 90, three days of prices, one with a
/// verified sale); any other product's stats fail.
fn rollups(rest: &str) -> Response {
    let raw = rest.starts_with("cat_charizard/cat_charizard%3A%3Alst_vault/");
    if rest.ends_with("/stats") && raw {
        return Json(json!({
            "aggregates": [{
                "currencyCode": "USD", "lastSoldAt": "2026-10-20T15:00:00.000Z", "lastSoldPriceAmount": "395.00",
                "medianPrice30d": null, "volume30d": 1, "tradeCount30d": 1,
                "medianPrice90d": "392.50", "volume90d": 4, "tradeCount90d": 4,
            }],
            "marketState": { "day": "2026-10-25", "minAskAmount": "389.00", "maxBidAmount": "380.00", "spreadAmount": "9.00" },
            "statHygiene": { "minimumTradeSample": 3 },
            "displayPolicy": { "showVerifiedMarkers": true },
        }))
        .into_response();
    }
    if rest.ends_with("/series") && raw {
        let point = |day: &str, last: &str, min: &str, max: &str, verified: u64| {
            json!({ "currencyCode": "USD", "day": day, "firstPriceAmount": last, "lastPriceAmount": last, "minPriceAmount": min,
                "maxPriceAmount": max, "medianPriceAmount": last, "unitVolume": 1, "tradeCount": 1, "verifiedTradeCount": verified })
        };
        return Json(json!({ "items": [
            point("2026-08-01", "380.00", "375.00", "385.00", 0),
            point("2026-09-01", "390.00", "390.00", "390.00", 1),
            point("2026-10-20", "395.00", "390.00", "400.00", 0),
        ] }))
        .into_response();
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// The address of each link on the page with `text` in it.
fn hrefs<'a>(html: &'a str, text: &str) -> Vec<&'a str> {
    html.split("<a ")
        .skip(1)
        .filter(|a| a.split("</a>").next().is_some_and(|body| body.contains(text)))
        .filter_map(|a| a.split("href=\"").nth(1)?.split('"').next())
        .collect()
}

#[tokio::test]
async fn anyone_reads_an_item_with_its_best_listing_and_its_market() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(ITEM_PAGE, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let call = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.starts_with(ITEMS)).cloned().unwrap();
    assert_eq!(call.headers["chase-sets-read-target-context"], "discovery");
    let page = text(&html);
    assert!(page.contains("Pokemon Card Single Charizard Base Set 4/102"), "{page}");
    // Nothing chosen and three buyable listings: the first is the best available one.
    assert!(page.contains("Lowest ask $389.00 All active listings Available 4 Listings 3 listings Sellers 2 sellers"), "{page}");
    assert!(page.contains("Best available listing $389.00 Card Vault \u{b7} 2 available"), "{page}");
    // The book: the buyable listings in the API's order, the lowest marked, the limit shown.
    assert!(page.contains("3 active listings"), "{page}");
    let (vault, chase) = (page.find("$389.00 Lowest price").unwrap(), page.find("$412.50").unwrap());
    assert!(vault < chase && !page.contains("$395.00"), "a listing with nothing available is not in the book: {page}");
    assert!(page.contains("Limit 2 per customer"), "{page}");
    assert!(page.contains("Chase Sets \u{2605} 4.8 (4)"), "{page}");
    assert!(html.contains(r#"<link rel="canonical" href="http://localhost:7753/items/charizard""#), "{html}");
    assert!(!html.contains("application/ld+json"), "structured data is for the production marketplace only: {html}");
}

#[test]
fn the_production_item_writes_its_product_as_json_ld_that_no_description_can_end() {
    use corten::prelude::*;
    let mut value = item();
    value["description"] = json!("A </script><b> Charizard");
    let item: crate::api::Item = serde_json::from_value(value).unwrap();
    let product = crate::views::product_json_ld(&item, "https://marketplace.chasesets.com/items/charizard")
        .expect("an active item with a price");
    let html = html! { <JsonLd value={&product} /> }.to_html();
    let json =
        html.strip_prefix(r#"<script type="application/ld+json">"#).and_then(|s| s.strip_suffix("</script>")).expect(&html);
    assert!(!json.contains('<'), "{json}");
    assert_eq!(serde_json::from_str::<Value>(json).unwrap(), product);
    assert_eq!(product["description"], "A </script><b> Charizard");
}

#[tokio::test]
async fn an_id_or_an_old_slug_moves_to_the_slug_for_good_with_its_parameters() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/items/cat_charizard?market=sell&dimension.dim_form=chc_raw", None)).await;
    assert_eq!(status, StatusCode::MOVED_PERMANENTLY);
    assert_eq!(headers[header::LOCATION], "/items/charizard?market=sell&dimension.dim_form=chc_raw");
}

#[tokio::test]
async fn an_unknown_item_is_not_found_and_a_failed_read_a_bad_gateway() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(get("/items/nope", None)).await;
    // The error page is in the layout, and Corten keeps it out of search engines.
    assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::NOT_FOUND, &"noindex".parse().unwrap()));
    assert!(html.starts_with("<!DOCTYPE html><html lang=\"en\">") && html.contains("<main><h1>"), "{html}");
    assert_eq!(pilot.send(get("/items/down", None)).await.0, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn an_option_is_a_link_that_chooses_it_and_any_takes_it_away() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?dimension.dim_form=chc_raw", None)).await;
    let page = text(&html);
    // Raw is chosen, so its condition applies (ordered by its order) and the grade does not.
    assert!(
        page.contains(
            "Form Any Raw 2 from $389.00 Graded 1 from $735.00 Condition Any Near Mint 2 from $389.00 Lightly Played none"
        ),
        "{page}"
    );
    assert!(!page.contains("Grade 7"), "{page}");
    assert_eq!(hrefs(&html, "Graded"), ["/items/charizard?dimension.dim_form=chc_graded"]);
    assert_eq!(hrefs(&html, "Near Mint")[0], "/items/charizard?dimension.dim_form=chc_raw&amp;dimension.dim_condition=chc_nm");
    // Any takes Raw away; nothing left chosen, so the address says so and the page chooses nothing.
    let any = hrefs(&html, "Any")[0];
    assert_eq!(any, "/items/charizard?dimension.dim_form=any");
    let (_, _, html) = pilot.send(get(&any.replace("&amp;", "&"), None)).await;
    assert!(text(&html).contains("Chosen options All listings"), "{html}");
}

#[tokio::test]
async fn a_dimension_with_many_options_is_a_get_form_that_keeps_the_others() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?market=sell&dimension.dim_form=chc_graded", None)).await;
    let form = html.split(r#"<form class="#).nth(1).and_then(|f| f.split("</form>").next()).expect("the grade's form");
    assert!(form.contains(r#"method="get""#), "{form}");
    assert!(form.contains(r#"<input type="hidden" name="market" value="sell">"#), "{form}");
    assert!(form.contains(r#"<input type="hidden" name="dimension.dim_form" value="chc_graded">"#), "{form}");
    assert!(form.contains(r#"<select id="dim-dim_grade" name="dimension.dim_grade">"#), "{form}");
    // Highest grade first, as a numeric dimension orders them.
    let (seven, one) = (form.find("Grade 7").unwrap(), form.find("Grade 1").unwrap());
    assert!(seven < one, "{form}");
    assert!(form.contains(r#"<option value="any" selected>Any</option>"#), "{form}");
}

#[tokio::test]
async fn choosing_a_listing_chooses_its_product_and_one_gone_says_so() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(ITEM_PAGE, None)).await;
    assert!(hrefs(&html, "Select").contains(&"/items/charizard?listing=lst_chase"), "{html}");
    let (_, _, html) = pilot.send(get("/items/charizard?listing=lst_chase", None)).await;
    let page = text(&html);
    assert!(page.contains("Selected listing $412.50 Chase Sets"), "{page}");
    assert!(page.contains("Chosen options Form Raw Condition Near Mint"), "the listing's options are the selection: {page}");
    assert!(html.contains(r#"aria-current="true">Selected</a>"#), "{html}");
    let (_, _, html) = pilot.send(get("/items/charizard?listing=lst_gone", None)).await;
    let page = text(&html);
    assert!(page.contains("Listing unavailable"), "{page}");
    assert!(page.contains("Best available listing $389.00"), "{page}");
}

#[tokio::test]
async fn selling_shows_the_best_offer_first_and_the_viewers_own_as_theirs() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?market=sell", Some("buyer"))).await;
    let page = text(&html);
    assert!(page.contains("Best offer $380.00 All offers Requested 4 Offers 2 offers Accounts 2 accounts"), "{page}");
    assert!(page.contains("Best offer $380.00 Top Loader"), "the rail: {page}");
    assert!(page.contains("$350.00 Your offer You"), "{page}");
    assert!(page.contains("You cannot accept your own offer."), "{page}");
    // The tabs keep the side; Listings is the sell side's other tab.
    assert_eq!(hrefs(&html, "Listings")[0], "/items/charizard?market=sell&amp;book=listings");
}

#[tokio::test]
async fn the_details_tab_lists_the_fields_and_the_records_they_relate_to() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?book=details", None)).await;
    let page = text(&html);
    assert!(page.contains("Description The iconic Charizard."), "{page}");
    assert!(
        page.contains(
            "Card Number 4 Expansion Base Set Series Base Language English Categories Pokemon TCG Tags base-set Last updated"
        ),
        "{page}"
    );
}

#[tokio::test]
async fn a_reference_in_the_details_opens_its_records_dialog_with_no_script() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?book=details", None)).await;
    // Each referenced value is a button for its record's dialog: the field's and the one it relates to.
    assert!(
        html.contains(concat!(
            r#"<button type="button" class="item-detail__ref-trigger" command="show-modal" commandfor="reference-ref_base" "#,
            r#"aria-haspopup="dialog" aria-label="View Expansion reference details for Base Set">Base Set</button>"#,
        )),
        "{html}"
    );
    assert!(html.contains(r#"commandfor="reference-ref_series""#), "{html}");
    let at = html.find(r#"<dialog class="item-detail__ref-dialog" id="reference-ref_base""#).expect("the dialog");
    let dialog = text(&html[at..at + html[at..].find("</dialog>").unwrap()]);
    assert_eq!(
        dialog,
        concat!(
            "Base Set Expansion Close reference detail Reference type Expansion Status active Reference key base-set ",
            // The stand-in's JSON sorts its keys; `attributes_keep_the_apis_order` covers the order.
            r#"Attributes abbreviation BS card-count 102 language-editions [&quot;en&quot;] Relationships Part Of Base"#,
        ),
    );
    // A record with nothing: says so.
    let at = html.find(r#"id="reference-ref_series""#).expect("the related record's dialog");
    let dialog = text(&html[at..at + html[at..].find("</dialog>").unwrap()]);
    assert!(dialog.ends_with("Attributes No attributes Relationships No relationships"), "{dialog}");
    assert_eq!(html.matches("<dialog").count(), 2, "one dialog for each record");
    // A change to the item draws the book again with its triggers and its dialogs; the runtime
    // keeps one the buyer opened open (todd-skelton/corten#84).
    let events = pilot.events(get("/items/cat_charizard/live?book=details", None), 1).await;
    let data = &events[0].2;
    assert!(data.contains(r#"commandfor="reference-ref_base""#) && data.matches("<dialog").count() == 2, "{data}");
}

#[test]
fn attributes_keep_the_apis_order() {
    let reference: crate::api::Reference = serde_json::from_str(
        r#"{"referenceId":"r","name":"n","typeKey":"t","attributes":{"card-count":102,"abbreviation":"BS","release-date":"1999-01-09"}}"#,
    )
    .unwrap();
    let keys: Vec<&str> = reference.attributes.0.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["card-count", "abbreviation", "release-date"]);
    // Anything but an object is no attributes.
    let reference: crate::api::Reference =
        serde_json::from_str(r#"{"referenceId":"r","name":"n","typeKey":"t","attributes":null}"#).unwrap();
    assert!(reference.attributes.0.is_empty());
}

#[tokio::test]
async fn a_data_client_gets_the_item_screen() {
    let pilot = Pilot::new().await;
    let mut req = get("/items/charizard?dimension.dim_form=chc_graded&dimension.dim_grade=chc_grade_7", None);
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let screen: Value = serde_json::from_str(&body).unwrap();
    let data = &screen["data"];
    assert_eq!(data["product_id"], "cat_charizard::dim_form:chc_graded|dim_condition:-|dim_grade:chc_grade_7", "{body}");
    assert_eq!(data["complete"], true);
    assert_eq!(data["listing_id"], "lst_psa");
    assert_eq!(data["offers"], json!([]), "the offers are for the raw card: {body}");
}

#[test]
fn the_address_reads_as_marketplace_reads_it_and_writes_its_choices_back() {
    use corten::Route;

    use crate::items::{Address, Book, Market, Raw};
    let read = |query: &str| Address::read(&corten::form::from_bytes::<Raw>(query.as_bytes()).unwrap());
    let a = read("market=sell&listing=a&listing=a&offer=x&offer=y&dimension.d1=o1&dimension.d2=o2&dimension.d2=o3&dimension.d3=");
    assert_eq!(a.market, Market::Sell);
    assert_eq!(a.listing.as_deref(), Some("a"), "the same id twice is one");
    assert_eq!(a.offer, None, "two ids are none");
    assert_eq!(a.options, [("d1".to_owned(), "o1".to_owned())], "a dimension given two options is dropped");
    assert!(a.filtered);
    assert_eq!(a.book(), Book::Offers);
    assert_eq!(read("market=nope").market, Market::Buy);
    assert!(!read("dimension.d3=+").filtered, "a blank option is no filter");
    let link = crate::app::url::Item { slug: "a b", state: a.with_book(Book::Listings) }.href();
    assert_eq!(link, "/items/a%20b?market=sell&listing=a&book=listings&dimension.d1=o1");
    assert_eq!(
        crate::app::url::Item { slug: "x", state: a.with_book(Book::Offers) }.href(),
        "/items/x?market=sell&listing=a&dimension.d1=o1"
    );
}

const ITEM_CART: &str = "/items/charizard/cart";
const ITEM_BUY: &str = "/items/charizard/buy";
const KEY: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const VAULT: &str = "cat_charizard::lst_vault";

/// A buy form's body: its button, the attempt, the quantity, the product, the listing it showed,
/// and the page's address after them.
fn buy_body(intent: &str, quantity: &str, product: &str, lock: &str, address: &str) -> String {
    let mut body = format!("intent={intent}&attempt={KEY}&quantity={quantity}&product={}", crate::api::segment(product));
    if !lock.is_empty() {
        body.push_str(&format!("&lock={lock}"));
    }
    if !address.is_empty() {
        body.push('&');
        body.push_str(address);
    }
    body
}

/// The item page's cart adds the stand-in received, as JSON.
fn adds(pilot: &Pilot) -> Vec<(Call, Value)> {
    pilot
        .stand
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.method == Method::POST && (c.path == ACCOUNT_CART_ADD || c.path == GUEST_CART_ADD))
        .map(|c| (c.clone(), serde_json::from_str(&c.body).unwrap()))
        .collect()
}

#[tokio::test]
async fn the_rail_buys_the_listing_shown_or_the_product_chosen() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(ITEM_PAGE, Some("buyer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    // The listing form: posted to the cart, Buy now to its own path, with the listing it shows.
    assert!(html.contains(r#"action="/items/charizard/cart""#), "{html}");
    assert!(html.contains(r#"formaction="/items/charizard/buy""#), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="lock" value="lst_vault">"#), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="product" value="cat_charizard::lst_vault">"#), "{html}");
    assert!(html.contains(r#"name="quantity" min="1" step="1" inputmode="numeric" required value="1""#), "{html}");
    let page = text(&html);
    assert!(page.contains("Buy best available listing Add listing to Buy Cart"), "{page}");
    // The product form, folded under the listing.
    assert!(page.contains("Selected product Save the selected product for Buy Cart review."), "{page}");
    assert!(page.contains("3 listings match this selection."), "{page}");
    assert!(page.contains("Add product to Buy Cart Buy best match"), "{page}");
    assert_eq!(drawn_attempt(&html).len(), 36, "each form draws an attempt");

    // A listing chosen in the book: Buy this listing; one whose seller is at capacity cannot be bought.
    let (_, _, html) = pilot.send(get(&format!("{ITEM_PAGE}?listing=lst_chase"), Some("buyer"))).await;
    let page = text(&html);
    assert!(page.contains("Temporarily at capacity This seller is temporarily at capacity. Check back soon."), "{page}");
    assert!(html.contains(r#"<input type="hidden" name="listing" value="lst_chase">"#), "the address is posted: {html}");
    let (_, _, html) = pilot.send(get(&format!("{ITEM_PAGE}?listing=lst_vault"), Some("buyer"))).await;
    assert!(text(&html).contains("Buy this listing Add listing to Buy Cart"), "{html}");

    // Nothing chosen to buy: the guidance, no forms. Selling: no buy forms.
    // (A dimension given two options is a filter with no option: marketplace chooses no product.)
    let (_, _, html) =
        pilot.send(get(&format!("{ITEM_PAGE}?dimension.dim_form=chc_raw&dimension.dim_form=chc_graded"), Some("buyer"))).await;
    assert!(text(&html).contains("Choose every required product option before buying"), "{html}");
    assert!(!html.contains("/items/charizard/cart"), "{html}");
    let (_, _, html) = pilot.send(get(&format!("{ITEM_PAGE}?market=sell"), Some("buyer"))).await;
    assert!(!html.contains("/items/charizard/cart"), "{html}");
}

#[tokio::test]
async fn a_buyer_adds_the_listing_shown_and_the_page_says_so() {
    let pilot = Pilot::new().await;
    let (status, headers, body) =
        pilot.send(post(ITEM_CART, "buyer", &buy_body("add-listing", "2", VAULT, "lst_vault", ""), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/items/charizard?added="), "{to}");
    assert!(!headers.contains_key(header::SET_COOKIE), "an account's cart has no guest cookie");
    let [(call, line)] = adds(&pilot).try_into().unwrap();
    assert_eq!(call.path, ACCOUNT_CART_ADD);
    assert_eq!(call.headers["chase-sets-read-target-context"], "checkout");
    assert_eq!(
        line,
        json!({
            "attemptId": KEY, "catalogItemId": "cat_charizard", "productId": VAULT, "itemTitle": "Charizard",
            "itemSubtitle": "Base Set 4/102", "itemImageUrl": "/fake-cdn/assets/back.png", "itemImageSrcSet": null,
            "itemImageLoadingUrl": "/fake-cdn/assets/back.png", "itemImageLoadingAlt": "Card back", "itemImageLoadingSrcSet": null,
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            "productSummary": "Form: raw", "quantity": 2, "fulfillmentMode": "locked-listing",
            "lockedListingId": "lst_vault", "sellerPreferenceId": "lst_vault",
            "selectedListingSnapshot": {
                "listingId": "lst_vault", "sellerAccountId": "acc_vault", "sellerDisplayName": "Card Vault",
                "sellerSlug": "acc_vault-slug", "priceAmount": "389.00", "priceCurrencyCode": "USD",
                "listingStreamVersion": 3, "source": "discovery.item-detail.add-to-cart",
            },
        })
    );
    // The page after: added, and View buy cart waits for the write.
    let (status, _, html) = pilot.send(get(&to, Some("buyer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Added to buy cart Charizard is in your Buy Cart."), "{html}");
    let [view] = hrefs(&html, "View buy cart").try_into().unwrap();
    let receipt: Value = serde_json::from_str(&query(&view.replace("&amp;", "&"))["after_write"]).unwrap();
    assert!(view.starts_with("/account/cart?after_write="), "{view}");
    assert_eq!(receipt["sources"][0]["maxGlobalPosition"], "12", "{receipt}");

    // With the script, the runtime follows corten-location to the same page.
    let (status, headers, _) =
        pilot.send(post(ITEM_CART, "buyer", &buy_body("add-listing", "1", VAULT, "lst_vault", ""), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().starts_with("/items/charizard?added="));
}

#[tokio::test]
async fn the_product_goes_to_smart_match_and_buy_best_match_opens_the_cart() {
    let pilot = Pilot::new().await;
    let (status, _, body) = pilot.send(post(ITEM_CART, "buyer", &buy_body("add-product", "3", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let (status, headers, body) =
        pilot.send(post(ITEM_CART, "buyer", &buy_body("buy-best-match", "1", VAULT, "lst_vault", ""), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/account/cart?after_write="), "{to}");
    let lines: Vec<Value> = adds(&pilot).into_iter().map(|(_, line)| line).collect();
    for line in &lines {
        assert_eq!(line["fulfillmentMode"], "optimize", "{line}");
        assert_eq!(line["lockedListingId"], Value::Null, "Buy best match is not locked, whatever the form says: {line}");
        assert_eq!(line["selectedListingSnapshot"], Value::Null);
    }
    assert_eq!((lines[0]["quantity"].clone(), lines[1]["quantity"].clone()), (json!(3), json!(1)));

    // Buy best match needs the lowest listing to have the quantity; nothing is sent.
    let (status, _, html) = pilot.send(post(ITEM_CART, "buyer", &buy_body("buy-best-match", "3", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Only 2 available from this listing."), "{html}");
    assert!(html.contains(r#"<details class="#) && html.contains(" open>"), "the product form shows the error, open: {html}");
    assert!(html.contains(
        r#"id="buy-product-quantity" type="number" name="quantity" min="1" step="1" inputmode="numeric" required value="3""#
    ));
    assert_eq!(adds(&pilot).len(), 2);
}

#[tokio::test]
async fn an_add_is_refused_before_it_is_sent_when_the_form_no_longer_holds() {
    let pilot = Pilot::new().await;
    let cases = [
        (buy_body("add-listing", "0", VAULT, "lst_vault", ""), "Enter a quantity of 1 or more."),
        (buy_body("add-listing", "1.5", VAULT, "lst_vault", ""), "Enter a quantity of 1 or more."),
        (buy_body("add-listing", "3", VAULT, "lst_vault", ""), "Only 2 available from this listing."),
        (buy_body("add-listing", "1", VAULT, "lst_gone", ""), "This listing is no longer available."),
        // The page now shows another product than the form did.
        (buy_body("add-product", "1", "cat_charizard::lst_psa", "", ""), "This item was not added to your Buy Cart."),
    ];
    for (body, message) in cases {
        let (status, _, html) = pilot.send(post(ITEM_CART, "buyer", &body, false)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(text(&html).contains(message), "{body}: {html}");
    }
    assert!(adds(&pilot).is_empty());
    // The API's refusal is the page again, with its reason.
    let (status, _, html) = pilot.send(post(ITEM_CART, "buyer", &buy_body("add-listing", "7", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("This listing is no longer available."), "no lock: {html}");
    let (status, _, html) = pilot.send(post(ITEM_CART, "buyer", &buy_body("add-product", "7", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Only 2 are available."), "{html}");
    // An unknown item is not found.
    let (status, _, _) =
        pilot.send(post("/items/nothing/cart", "buyer", &buy_body("add-product", "1", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_add_whose_answer_was_lost_is_looked_up_and_one_not_known_is_held() {
    let pilot = Pilot::new().await;
    // Applied, the answer lost: the lookup finds it.
    let (status, headers, body) = pilot.send(post(ITEM_CART, "buyer", &buy_body("add-product", "8", VAULT, "", ""), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/items/charizard?added="));
    let [(_, line)] = adds(&pilot).try_into().unwrap();
    let mut sent = line.clone();
    sent.as_object_mut().unwrap().remove("attemptId");
    let hash = crate::cart_attempt::request_hash(&sent);
    let lookups: Vec<String> =
        pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(CART_ATTEMPTS)).map(|c| c.path.clone()).collect();
    assert_eq!(lookups, [format!("{CART_ATTEMPTS}{KEY}?kind=cart.add-line&target=cart&requestHash={hash}")]);

    // Not known: the page holds the adds and offers the same add again.
    let pilot = Pilot::new().await;
    let address = "dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm";
    let raw_nm = "cat_charizard::dim_form:chc_raw|dim_condition:chc_nm|dim_grade:-";
    let (status, _, html) = pilot.send(post(ITEM_CART, "buyer", &buy_body("add-product", "9", raw_nm, "", address), false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    let page = text(&html);
    assert!(page.contains("confirm this add It may or may not be in your Buy Cart."), "{page}");
    assert!(page.contains("Send the same add again View buy cart"), "{page}");
    for (name, value) in [("attempt", KEY), ("intent", "add-product"), ("quantity", "9"), ("dimension.dim_form", "chc_raw")] {
        assert!(html.contains(&format!(r#"<input type="hidden" name="{name}" value="{value}">"#)), "{name}: {html}");
    }
    assert!(html.contains(" disabled>"), "the adds are held: {html}");
}

#[tokio::test]
async fn a_guest_adds_to_the_guest_cart_marketplace_reads() {
    let pilot = Pilot::new().await;
    let req = || {
        Request::post(ITEM_CART)
            .header(header::HOST, "localhost:7791")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
    };
    let body = buy_body("buy-best-match", "1", VAULT, "", "");
    let (status, headers, html) = pilot.send(req().body(Body::from(body.clone())).unwrap()).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/account/cart?afterWrite="), "{to}");
    assert_eq!(
        query(to)["postWriteHandoff"],
        r#"{"kind":"checkout.cart.add-line","expectation":"collection-non-empty","surface":"account-cart"}"#
    );
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.starts_with("chase_sets_anonymous_cart=anon_cmd_") && cookie.contains("Max-Age=2592000"), "{cookie}");
    let id = cookie.split(';').next().unwrap().split_once('=').unwrap().1.to_owned();
    let [(call, _)] = adds(&pilot).try_into().unwrap();
    assert_eq!(
        (call.path.as_str(), call.headers["x-checkout-anonymous-cart-id"].to_str().unwrap()),
        (GUEST_CART_ADD, id.as_str())
    );

    // The cart the browser keeps is the one written next; a guest's View buy cart is marketplace's.
    let req = req().header(header::COOKIE, format!("chase_sets_anonymous_cart={id}"));
    let (status, headers, _) = pilot.send(req.body(Body::from(buy_body("add-product", "1", VAULT, "", ""))).unwrap()).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(adds(&pilot)[1].0.headers["x-checkout-anonymous-cart-id"].to_str().unwrap(), id);
    let (_, _, html) = pilot.send(get(headers[header::LOCATION].to_str().unwrap(), None)).await;
    let [view] = hrefs(&html, "View buy cart").try_into().unwrap();
    assert!(view.starts_with("http://localhost:7753/account/cart?afterWrite="), "{view}");
}

#[tokio::test]
async fn buy_this_listing_starts_a_checkout_session_once_per_form() {
    let pilot = Pilot::new().await;
    let (status, headers, body) = pilot.send(post(ITEM_BUY, "buyer", &buy_body("", "2", VAULT, "lst_vault", ""), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/checkout/buy/session/chk_1?afterWrite="), "{to}");
    let call = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.ends_with("/checkout-sessions")).cloned().unwrap();
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(sent["entryAttemptKey"], KEY, "the form's attempt is the entry key");
    assert_eq!(
        sent["source"],
        json!({
            "type": "buy-now", "listingId": "lst_vault", "catalogItemId": "cat_charizard", "productId": VAULT,
            "itemTitle": "Charizard", "itemSubtitle": "Base Set 4/102",
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            "productSummary": "Form: raw", "quantity": 2, "fulfillmentMode": "locked-listing", "lockedListingId": "lst_vault",
        })
    );
    // An entry key used for another listing: the selection changed.
    let body = buy_body("", "1", VAULT, "lst_vault", "").replace(KEY, "conflict-0000000000000000000000");
    let (status, _, html) = pilot.send(post(ITEM_BUY, "buyer", &body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Your selection changed after you chose Buy now."), "{html}");
    // A guest goes to marketplace's guest checkout with the listing.
    let req = Request::post(ITEM_BUY)
        .header(header::HOST, "localhost:7791")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(buy_body("", "1", VAULT, "lst_vault", "")))
        .unwrap();
    let (status, headers, _) = pilot.send(req).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/checkout/buy/readiness?source=buy-now&listingId=lst_vault&"), "{to}");
    let q = query(to);
    assert_eq!(
        (q["quantity"].as_str(), q["sellerName"].as_str(), q["availability"].as_str()),
        ("1", "Card Vault", "Form: raw - 2 available")
    );
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.ends_with("/checkout-sessions")).count(), 2);
}

#[tokio::test]
async fn make_offer_is_checked_then_marketplaces_offer_checkout() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(ITEM_PAGE, Some("buyer"))).await;
    assert!(html.contains(r#"action="/items/charizard/offer""#), "{html}");
    assert!(text(&html).contains("Make an offer Offer your price and quantity for the selected product."), "{html}");
    assert!(text(&html).contains("Current lowest listing is $389.00."), "{html}");
    assert!(html.contains(r#"name="currency" minlength="3" maxlength="3" autocapitalize="characters" placeholder="ISO 4217" required value="USD""#), "{html}");

    let body = format!("product={}&price=24.5&currency=usd&quantity=2", crate::api::segment(VAULT));
    let (status, headers, html) = pilot.send(post("/items/charizard/offer", "buyer", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/checkout/buy/readiness?source=offer-intent&"), "{to}");
    let q = query(to);
    assert_eq!(
        (q["productId"].as_str(), q["offerPriceAmount"].as_str(), q["offerPriceCurrencyCode"].as_str(), q["quantity"].as_str()),
        (VAULT, "24.50", "USD", "2")
    );
    assert_eq!(
        q["selectedOptions"],
        r#"[{"dimensionId":"dim_form","optionId":"chc_raw"},{"dimensionId":"dim_condition","optionId":"chc_nm"}]"#
    );
    assert_eq!((q["itemTitle"].as_str(), q["productSummary"].as_str()), ("Charizard", "Form: raw"));

    // A price marketplace would not take: the page again, the offer form open with what was typed.
    for (price, message) in
        [("0", "Enter a price greater than $0.00"), ("1.234", "Enter a price greater than $0.00"), ("", "Enter a price")]
    {
        let body = format!("product={}&price={price}&currency=USD&quantity=3", crate::api::segment(VAULT));
        let (status, _, html) = pilot.send(post("/items/charizard/offer", "buyer", &body, false)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{price}");
        assert!(text(&html).contains(message), "{price}: {html}");
        assert!(
            html.contains(
                r#"id="offer-quantity" type="number" name="quantity" min="1" step="1" inputmode="numeric" required value="3""#
            ),
            "{html}"
        );
    }
    let calls = pilot.stand.calls.lock().unwrap().iter().filter(|c| c.method == Method::POST).count();
    assert_eq!(calls, 0, "an offer writes nothing here");
}

#[test]
fn a_price_is_marketplaces_money_amount() {
    use crate::buying::price;
    assert_eq!(price("24.5").as_deref(), Some("24.50"));
    assert_eq!(price(" 7 ").as_deref(), Some("7.00"));
    assert_eq!(price("007.10").as_deref(), Some("7.10"));
    assert_eq!(price("0.01").as_deref(), Some("0.01"));
    for bad in ["", "0", "0.00", "1.", ".5", "1.234", "-1", "1e3", "1,5"] {
        assert_eq!(price(bad), None, "{bad:?}");
    }
}

const SELL_PAGE: &str = "/items/charizard?market=sell";
const OPEN_PRODUCT_FOLD: &str = r#"<details class="item-detail__product-buy" open>"#;
const SELL_LIST: &str = "/items/charizard/sell-list";
/// The product the best offer is for (`off_high`'s).
const OFFERED: &str = "cat_charizard::dim_form:chc_raw|dim_condition:chc_nm|dim_grade:-";

/// The calls to the sell list and the terms, in order.
fn sell_calls(pilot: &Pilot) -> Vec<Call> {
    let paths = [ACCOUNT_SELL_LIST, GUEST_SELL_LIST, STANDARD_TERMS];
    pilot.stand.calls.lock().unwrap().iter().filter(|c| paths.contains(&c.path.as_str())).cloned().collect()
}

/// A form post from a browser with no session.
fn post_signed_out(uri: &str, body: &str) -> Request<Body> {
    Request::post(uri)
        .header(header::HOST, "localhost:7791")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(body.to_owned()))
        .unwrap()
}

#[tokio::test]
async fn a_guest_sees_what_an_offer_pays_and_saves_it_or_its_product_to_a_sell_list() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(SELL_PAGE, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    // 380.00 x 2: a 5% fee, the rest paid out, and 5% of the offer's value for shipping.
    assert!(page.contains("$760.00 offer"), "{page}");
    assert!(page.contains("Requested 2 requested"), "{page}");
    assert!(page.contains("Seller payout $722.00 after $38.00 fee"), "{page}");
    assert!(page.contains("Shipping allowance $38.00 (5%)"), "{page}");
    let calls = sell_calls(&pilot);
    assert_eq!(calls.len(), 1, "the terms for the offer shown, once");
    assert_eq!(serde_json::from_str::<Value>(&calls[0].body).unwrap(), json!({ "priceAmount": "380.00" }));
    let forms = forms_to(&html, SELL_LIST);
    assert_eq!(forms.len(), 2, "the offer's and the product's: {html}");
    assert!(
        forms[0].contains(r#"name="offer" value="off_high""#) && forms[0].contains(r#"name="market" value="sell""#),
        "{}",
        forms[0]
    );
    assert!(
        forms[0].contains(r#"name="intent" value="add-to-sell-list">Accept offer<"#),
        "a guest's Accept offer saves it: {}",
        forms[0]
    );
    assert!(forms[1].contains(&format!(r#"name="product" value="{OFFERED}""#)), "{}", forms[1]);
    assert!(!html.contains("data-patch"), "plain forms: {html}");

    // The offer: the API's refusal on the rail, nothing else written.
    let body = "market=sell&intent=add-to-sell-list&offer=off_high";
    let (status, _, html) = pilot.send(post_signed_out(SELL_LIST, body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(
        html.contains(r#"role="alert">Selected offer sell-list lines must reference an Offer and exact Listing.<"#),
        "{html}"
    );
    assert!(text(&html).contains("$722.00 after $38.00 fee"), "the refusal keeps the payout: {html}");
    let sent = sell_calls(&pilot).into_iter().find(|c| c.path == GUEST_SELL_LIST).expect("the guest's sell list");
    assert!(sent.headers["x-checkout-anonymous-sell-list-id"].to_str().unwrap().starts_with("anon_cmd_"));
    let line: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!(
        (&line["lineType"], &line["offerId"], &line["offerPriceAmount"], &line["buyerDisplayName"], &line["quantity"]),
        (&json!("selected-offer"), &json!("off_high"), &json!("380.00"), &json!("Top Loader"), &json!(2))
    );
    assert_eq!((&line["itemTitle"], &line["catalogItemId"]), (&json!("Charizard"), &json!("cat_charizard")));

    // The product: added, then marketplace's sell list, which waits for the write.
    let body = format!(
        "market=sell&intent=add-product-to-sell-list&product={}&quantity=3&itemTitle=Spoofed",
        crate::api::segment(OFFERED)
    );
    let (status, headers, html) = pilot.send(post_signed_out(SELL_LIST, &body)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/account/sell-list?afterWrite="), "{to}");
    let q = query(to);
    assert!(q["afterWrite"].contains(r#""commitPosition":"13""#), "{to}");
    assert_eq!(
        q["postWriteHandoff"],
        r#"{"kind":"checkout.sell-list.add-line","expectation":"collection-non-empty","surface":"account-sell-list"}"#
    );
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.starts_with("chase_sets_anonymous_sell_list=anon_cmd_") && cookie.contains("Max-Age=2592000"), "{cookie}");
    let sent = sell_calls(&pilot).into_iter().rfind(|c| c.path == GUEST_SELL_LIST).unwrap();
    let line: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!((&line["lineType"], &line["productId"], &line["quantity"]), (&json!("product"), &json!(OFFERED), &json!(3)));
    assert_eq!(&line["itemTitle"], &json!("Charizard"), "the catalog's words, not the form's");
    assert_eq!(
        &line["selectedOptions"],
        &json!([{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }])
    );

    // Refused before anything is sent: a quantity that is not one, a product the page does not show.
    let before = sell_calls(&pilot).len();
    for (product, quantity, message) in
        [(OFFERED, "0", "Enter a quantity of 1 or more."), ("cat_charizard::other", "1", "Choose options to sell this item")]
    {
        let body =
            format!("market=sell&intent=add-product-to-sell-list&product={}&quantity={quantity}", crate::api::segment(product));
        let (status, _, html) = pilot.send(post_signed_out(SELL_LIST, &body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
        assert!(text(&html).contains(message), "{message}: {html}");
        assert!(html.contains(&format!(r#"id="sell-product-quantity" type="number" name="quantity" min="1" step="1" inputmode="numeric" required value="{quantity}""#)), "{html}");
        assert!(html.contains(OPEN_PRODUCT_FOLD), "the product's fold stays open: {html}");
    }
    assert_eq!(sell_calls(&pilot).len() - before, 2, "only the terms again, for each page");
}

#[tokio::test]
async fn an_account_takes_an_offer_as_a_seller_and_needs_to_manage_offers() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(SELL_PAGE, Some("trader"))).await;
    assert!(text(&html).contains("Fees and terms are calculated before acceptance."), "{html}");
    assert!(sell_calls(&pilot).is_empty(), "an account's terms are not the public ones");
    let forms = forms_to(&html, SELL_LIST);
    assert!(forms[0].contains(r#"name="intent" value="sell-now">Accept offer<"#), "{}", forms[0]);

    // An offer the item no longer has for sellers is refused here.
    let (status, _, html) = pilot.send(post(SELL_LIST, "trader", "market=sell&intent=sell-now&offer=off_gone", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("This offer is no longer available. Choose another offer."), "{html}");
    assert!(sell_calls(&pilot).is_empty());

    // An account that may not manage offers cannot take one.
    let (status, _, _) = pilot.send(post(SELL_LIST, "buyer", "market=sell&intent=add-to-sell-list&offer=off_high", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(sell_calls(&pilot).is_empty());

    // The account's sell list, without a guest's id or cookie.
    let body = format!("market=sell&intent=add-product-to-sell-list&product={}&quantity=1", crate::api::segment(OFFERED));
    let (status, headers, _) = pilot.send(post(SELL_LIST, "buyer", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(!headers.contains_key(header::SET_COOKIE));
    let sent = sell_calls(&pilot);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].path, ACCOUNT_SELL_LIST);
    assert!(!sent[0].headers.contains_key("x-checkout-anonymous-sell-list-id"));
}

const WATCH_PAGE: &str = "/items/charizard?market=watch&dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm";
const WATCH: &str = "/items/charizard/watch";

/// A Watch form's body: the page's address, the product it showed, the side and the threshold.
fn watch_body(side: &str, threshold: &str, currency: &str) -> String {
    format!(
        "market=watch&dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm&product={}&side={side}&threshold={threshold}&currency={currency}",
        crate::api::segment(OFFERED)
    )
}

/// The calls to the alert API, in order.
fn alert_calls(pilot: &Pilot) -> Vec<Call> {
    let paths = [ACCOUNT_ALERTS, GUEST_ALERT_INTENTS];
    pilot.stand.calls.lock().unwrap().iter().filter(|c| paths.contains(&c.path.as_str())).cloned().collect()
}

#[tokio::test]
async fn the_watch_tab_is_the_pilots_with_a_form_for_listings_and_one_for_offers() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(WATCH_PAGE, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    // Watch is a tab of this page now, current on it.
    assert!(html.contains(r#"href="/items/charizard?market=watch&amp;dimension.dim_condition=chc_nm&amp;dimension.dim_form=chc_raw" aria-current="true">Watch</a>"#), "{html}");
    let page = text(&html);
    assert!(page.contains("Watch listings Listings at or below your target."), "{page}");
    assert!(page.contains("Watch offers Offers at or above your target."), "{page}");
    assert!(page.contains("Alerts are created after account registration"), "a guest is told: {page}");
    assert_eq!(html.matches(r#"action="/items/charizard/watch""#).count(), 2, "{html}");
    assert!(html.contains(r#"name="side" value="listing""#) && html.contains(r#"name="side" value="offer""#), "{html}");
    assert!(
        html.contains(r#"<label class="item-detail__label" for="watch-listing-price">Maximum listing price</label>"#),
        "{html}"
    );
    assert!(html.contains(r#"<label class="item-detail__label" for="watch-offer-price">Minimum offer price</label>"#), "{html}");
    assert!(html.contains(r#"id="watch-listing-price" type="number" name="threshold" min="0" step="0.01""#), "{html}");
    // Listings are open, offers folded; the currency starts as the listings'.
    assert!(html.contains(&format!("{OPEN_PRODUCT_FOLD}<summary><span class=\"item-detail__strong\">Watch listings")), "{html}");
    assert!(
        html.contains(
            r#"name="currency" minlength="3" maxlength="3" autocapitalize="characters" placeholder="ISO 4217" value="USD""#
        ),
        "{html}"
    );
    // The rail is the Watch card, not a listing to buy: no price, no buy forms.
    assert!(html.contains(r#"id="rail-title">Watch</h2>"#), "{html}");
    assert!(!html.contains(r#"action="/items/charizard/cart""#) && !text(&html).contains("Best available listing"), "{html}");
}

#[tokio::test]
async fn an_account_saves_a_watch_alert_from_the_catalogs_words_and_the_page_says_so() {
    let pilot = Pilot::new().await;
    let body = format!("{}&productSummary=SPOOFED", watch_body("offer", "15", "usd"));
    let (status, headers, html) = pilot.send(post(WATCH, "watcher", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(
        to.starts_with("/items/charizard?market=watch&dimension.dim_condition=chc_nm&dimension.dim_form=chc_raw&watched=%7B"),
        "back on the Watch tab with the receipt: {to}"
    );
    let calls = alert_calls(&pilot);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].path, ACCOUNT_ALERTS);
    let sent: Value = serde_json::from_str(&calls[0].body).unwrap();
    assert_eq!(
        sent,
        json!({
            "marketSide": "offer", "catalogItemId": "cat_charizard", "productId": OFFERED,
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            "productSummary": "Raw / Near Mint", "thresholdAmount": "15.00", "thresholdCurrencyCode": "USD",
        })
    );
    // The page after it says the alert was saved, with the alerts' settings after the write.
    let (_, _, html) = pilot.send(get(to, Some("watcher"))).await;
    assert!(
        text(&html).contains("Watch alert saved We will notify you when this product matches your alert. Manage alerts"),
        "{html}"
    );
    assert!(
        html.contains(r#"href="/account/notifications?view=settings&amp;section=product-alerts&amp;afterWrite=%7B"#),
        "{html}"
    );
    assert!(html.contains(r#"%7D#product-alerts""#), "the link is at the alerts: {html}");
    assert!(!text(&html).contains("Alerts are created after account registration"), "an account is not told to register: {html}");

    // No threshold is an alert without one, whatever the currency says.
    let (status, _, _) = pilot.send(post(WATCH, "watcher", &watch_body("listing", "", "USD"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let sent: Value = serde_json::from_str(&alert_calls(&pilot)[1].body).unwrap();
    assert_eq!(
        (&sent["marketSide"], &sent["thresholdAmount"], &sent["thresholdCurrencyCode"]),
        (&json!("listing"), &Value::Null, &Value::Null)
    );
}

#[tokio::test]
async fn a_watch_alert_marketplace_would_not_take_is_refused_in_its_own_form() {
    let pilot = Pilot::new().await;
    for (threshold, currency) in [("1.234", "USD"), ("-1", "USD"), ("5", "US"), ("5", "")] {
        let (status, _, html) = pilot.send(post(WATCH, "watcher", &watch_body("offer", threshold, currency), false)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{threshold} {currency}");
        assert!(text(&html).contains("Enter a target price of $0.00 or more using dollars and cents."), "{html}");
        // The offers' form is open with what was typed, on the Watch tab.
        assert!(
            html.contains(&format!("{OPEN_PRODUCT_FOLD}<summary><span class=\"item-detail__strong\">Watch offers")),
            "{html}"
        );
        assert!(html.contains(&format!(r#"id="watch-offer-price" type="number" name="threshold" min="0" step="0.01" inputmode="decimal" placeholder="15.00" value="{threshold}""#)), "{html}");
    }
    // The API's own refusal is shown the same way.
    let (status, _, html) = pilot.send(post(WATCH, "watcher", &watch_body("listing", "999.99", "USD"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Price threshold is too high for this stand-in."), "{html}");
    // A product the page no longer shows saves nothing.
    let body = watch_body("listing", "5", "USD").replace(&crate::api::segment(OFFERED), "cat_charizard%3A%3Aother");
    let (status, _, html) = pilot.send(post(WATCH, "watcher", &body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Choose every required product option"), "{html}");
    // An account that may not have alerts (a buyer without accounts.view) is told so.
    let (status, _, html) = pilot.send(post(WATCH, "buyer", &watch_body("listing", "5", "USD"), false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text(&html).contains("This account cannot create Product Alerts."), "{html}");
    assert_eq!(alert_calls(&pilot).len(), 1, "only the stand-in's refusal reached the API");
}

#[tokio::test]
async fn a_guest_saves_a_watch_alert_as_an_intent_and_registers_to_claim_it() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post_signed_out(WATCH, &watch_body("listing", "300", "USD"))).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7753/register?returnTo=%2Fitems%2Fcharizard%3Fmarket%3Dwatch%26claimProductAlertIntent%3Dpai_1"
    );
    let set = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.starts_with("chase_sets_anonymous_product_alerts=anon_cmd_") && set.contains("Max-Age=2592000"), "{set}");
    let owner = set.split(';').next().unwrap().split_once('=').unwrap().1.to_owned();
    let calls = alert_calls(&pilot);
    assert_eq!(calls[0].path, GUEST_ALERT_INTENTS);
    assert_eq!(calls[0].headers["x-discovery-anonymous-product-alert-id"], owner.as_str());
    let sent: Value = serde_json::from_str(&calls[0].body).unwrap();
    assert_eq!((&sent["sourcePath"], &sent["thresholdAmount"]), (&json!("/items/charizard?market=watch"), &json!("300.00")));
    // The same browser keeps its owner.
    let mut again = post_signed_out(WATCH, &watch_body("offer", "", "USD"));
    again.headers_mut().insert(header::COOKIE, format!("chase_sets_anonymous_product_alerts={owner}").parse().unwrap());
    let (status, headers, _) = pilot.send(again).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::SET_COOKIE].to_str().unwrap().starts_with(&format!("chase_sets_anonymous_product_alerts={owner};")));
    assert_eq!(alert_calls(&pilot)[1].headers["x-discovery-anonymous-product-alert-id"], owner.as_str());
}

const SAVE_PAGE: &str = "/items/charizard?dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm";
const SAVE: &str = "/items/charizard/save";

/// The value of the hidden input `name` in the first form that has one.
fn hidden(html: &str, name: &str) -> String {
    let marker = format!(r#"name="{name}" value=""#);
    let at = html.find(&marker).unwrap_or_else(|| panic!("no {name} in {html}")) + marker.len();
    html[at..].split('"').next().unwrap().to_owned()
}

/// Add to List's form's body as the page drew it for `session`: its address, the product, its ids,
/// and the list, title and quantity chosen.
async fn save_body(pilot: &Pilot, session: &str, list: &str, title: &str, quantity: &str) -> String {
    let (_, _, html) = pilot.send(get(SAVE_PAGE, Some(session))).await;
    let ids: Vec<String> = ["add_command", "line", "new_list", "new_list_command"]
        .iter()
        .map(|name| format!("{name}={}", hidden(&html, name)))
        .collect();
    format!(
        "dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm&product={}&{}&list={list}&title={title}&quantity={quantity}",
        crate::api::segment(OFFERED),
        ids.join("&")
    )
}

/// The calls to the Saved List APIs, in order.
fn saved_list_calls(pilot: &Pilot) -> Vec<Call> {
    let paths = [RECENT_SAVED_LISTS, LIST_ADDITIONS, GUEST_SAVED_LIST_INTENTS];
    pilot.stand.calls.lock().unwrap().iter().filter(|c| paths.contains(&c.path.as_str())).cloned().collect()
}

#[tokio::test]
async fn add_to_list_opens_a_dialog_the_page_drew_with_the_accounts_recent_lists() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(SAVE_PAGE, Some("watcher"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    // The button opens the dialog with no script; the dialog is drawn closed.
    assert!(
        html.contains(r#"<button type="button" class="item-detail__button" command="show-modal" commandfor="save-to-list" aria-label="Add Charizard · Raw / Near Mint to a Saved List">Add to List</button>"#),
        "{html}"
    );
    let dialog = html.split(r#"id="save-to-list""#).nth(1).expect("the dialog").split("</dialog>").next().unwrap();
    assert!(!html.contains(r#"id="save-to-list" aria-labelledby="save-to-list-title" open"#), "drawn closed: {html}");
    assert!(dialog.contains(r#"action="/items/charizard/save""#), "{dialog}");
    // The most recent list is chosen, then a new list; the title field is there for a new one.
    assert!(dialog.contains(r#"name="list" value="svl_binder" checked>"#), "{dialog}");
    assert!(dialog.contains(r#"name="list" value="new">"#), "{dialog}");
    assert!(text(dialog).contains("Binder 4 lines · 9 tracked"), "{dialog}");
    assert!(dialog.contains(r#"name="title" maxlength="120""#), "{dialog}");
    assert!(dialog.contains(r#"name="quantity" min="1" max="1000000" step="1""#), "{dialog}");
    // The ids the addition is made with, drawn with the form, each new.
    let ids: Vec<String> = ["add_command", "line", "new_list", "new_list_command"].iter().map(|n| hidden(dialog, n)).collect();
    assert!(
        ids[0].starts_with("slc_") && ids[1].starts_with("sll_") && ids[2].starts_with("svl_") && ids[3].starts_with("slc_"),
        "{ids:?}"
    );
    assert_ne!(ids[0], ids[3]);
    let calls = saved_list_calls(&pilot);
    assert_eq!(calls.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), [RECENT_SAVED_LISTS], "{calls:?}");
    assert!(!calls[0].headers.contains_key("chase-sets-read-after-write"), "no write to wait for");

    // A guest's button posts the product; nothing is read for them.
    let (_, _, html) = pilot.send(get(SAVE_PAGE, None)).await;
    assert!(!html.contains(r#"id="save-to-list""#), "{html}");
    let form = html
        .split(r#"<form class="item-detail__save" method="post" action="/items/charizard/save">"#)
        .nth(1)
        .expect("the guest's form");
    assert!(form.split("</form>").next().unwrap().contains(r#"<button type="submit" class="item-detail__button""#), "{form}");
    // An account that cannot manage Saved Lists is told so in the dialog, without a read.
    let (_, _, html) = pilot.send(get(SAVE_PAGE, Some("buyer"))).await;
    assert!(text(&html).contains("This account cannot manage Saved Lists."), "{html}");
    assert_eq!(saved_list_calls(&pilot).len(), 1, "only watcher's page read the lists");
}

#[tokio::test]
async fn add_product_adds_to_a_new_or_a_recent_list_and_the_page_says_where_it_went() {
    let pilot = Pilot::new().await;
    let body = save_body(&pilot, "watcher", "new", "Chase+cards", "2").await;
    let (status, headers, html) = pilot.send(post(SAVE, "watcher", &format!("{body}&productSummary=SPOOFED"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    let q = query(to);
    assert!(to.starts_with("/items/charizard?dimension.dim_condition=chc_nm&dimension.dim_form=chc_raw&saved=%7B"), "{to}");
    assert!(q["saved_list"].starts_with("svl_") && q["saved_quantity"] == "2" && q["saved_line"] == "added", "{q:?}");
    let sent = saved_list_calls(&pilot).into_iter().filter(|c| c.path == LIST_ADDITIONS).collect::<Vec<_>>();
    assert_eq!(sent.len(), 1, "{sent:?}");
    let posted = |name: &str| query(&format!("?{body}"))[name].clone();
    let sent: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        sent,
        json!({
            "destination": { "kind": "new", "listId": posted("new_list"), "createCommandId": posted("new_list_command"), "title": "Chase cards" },
            "addCommandId": posted("add_command"), "lineId": posted("line"),
            "product": {
                "catalogItemId": "cat_charizard", "productId": OFFERED,
                "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            },
            "trackedQuantity": 2, "sourceSurface": "item-detail",
        })
    );
    assert_eq!(q["saved_list"], posted("new_list"));
    // The page after it reads the lists with the write's receipt, so the new list is there.
    let (_, _, html) = pilot.send(get(to, Some("watcher"))).await;
    assert!(
        text(&html)
            .contains("Added to Chase cards The exact Product was added with a Tracked Quantity of 2. View in My Collection"),
        "{html}"
    );
    assert!(
        html.contains(&format!(
            r#"href="http://localhost:7753/account/collection?section=lists&amp;list={}&amp;afterWrite=%7B"#,
            posted("new_list")
        )),
        "{html}"
    );
    let reads: Vec<Call> = saved_list_calls(&pilot).into_iter().filter(|c| c.path == RECENT_SAVED_LISTS).collect();
    let last = &reads[reads.len() - 2..];
    assert_eq!(waits_for(&last[0].headers), None, "first without the receipt: {reads:?}");
    assert_eq!(waits_for(&last[1].headers).as_deref(), Some("31"), "then, the new list not there, with it: {reads:?}");

    // A recent list: the product was on it, so its quantity grew.
    let body = save_body(&pilot, "watcher", "svl_binder", "", "3").await;
    let (status, headers, _) = pilot.send(post(SAVE, "watcher", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let (_, _, html) = pilot.send(get(headers[header::LOCATION].to_str().unwrap(), Some("watcher"))).await;
    assert!(
        text(&html).contains("Added to Binder This Product was already on the List, so its Tracked Quantity increased by 3."),
        "{html}"
    );
    // Binder is there without the receipt, so nothing waits for it.
    let reads: Vec<Call> = saved_list_calls(&pilot).into_iter().filter(|c| c.path == RECENT_SAVED_LISTS).collect();
    assert_eq!(waits_for(&reads.last().unwrap().headers), None, "{reads:?}");
    let additions: Vec<Call> = saved_list_calls(&pilot).into_iter().filter(|c| c.path == LIST_ADDITIONS).collect();
    let sent: Value = serde_json::from_str(&additions[1].body).unwrap();
    assert_eq!(sent["destination"], json!({ "kind": "existing", "listId": "svl_binder" }));
}

#[tokio::test]
async fn a_refused_add_product_draws_the_dialog_open_with_what_was_chosen_and_the_same_ids() {
    let pilot = Pilot::new().await;
    let cases = [
        ("new", "", "1", "Enter a title of 1 to 120 characters for the new Saved List."),
        ("svl_binder", "", "0", "Enter a Tracked Quantity: a whole number from 1 to 1,000,000."),
        ("svl_binder", "", "1.5", "Enter a Tracked Quantity: a whole number from 1 to 1,000,000."),
        ("", "", "1", "Choose a Saved List, or create a new one."),
        ("svl_binder", "", "13", "This Product could not be added to the Saved List. Review the List and try again."),
    ];
    for (list, title, quantity, message) in cases {
        let body = save_body(&pilot, "watcher", list, title, quantity).await;
        let (status, _, html) = pilot.send(post(SAVE, "watcher", &body, false)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{list} {quantity}");
        assert!(text(&html).contains(&format!("Could not add this Product {message}")), "{message}: {html}");
        // Open, so it is in front of the buyer without a script; its script makes it modal.
        assert!(html.contains(r#"id="save-to-list" aria-labelledby="save-to-list-title" open"#), "{html}");
        assert!(html.contains(&format!(r#"value="{quantity}""#)), "{html}");
        // The same ids, so trying again is the same addition.
        let posted = query(&format!("?{body}"));
        assert_eq!(hidden(&html, "add_command"), posted["add_command"]);
        assert_eq!(hidden(&html, "new_list"), posted["new_list"]);
    }
    // A form without its ids, or for a product the page no longer shows, sends nothing.
    let no_ids = format!(
        "dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm&product={}&list=svl_binder&quantity=1",
        crate::api::segment(OFFERED)
    );
    let (status, _, html) = pilot.send(post(SAVE, "watcher", &no_ids, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("This form is out of date. Reload the page and try again."), "{html}");
    let body = save_body(&pilot, "watcher", "svl_binder", "", "1")
        .await
        .replace(&crate::api::segment(OFFERED), "cat_charizard%3A%3Aother");
    let (status, _, html) = pilot.send(post(SAVE, "watcher", &body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Choose an exact Product and Options before adding it to a Saved List."), "{html}");
    // An account that cannot manage Saved Lists is told so.
    let body = save_body(&pilot, "watcher", "svl_binder", "", "1").await;
    let (status, _, html) = pilot.send(post(SAVE, "buyer", &body, false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text(&html).contains("This account cannot manage Saved Lists."), "{html}");
    let additions = saved_list_calls(&pilot).into_iter().filter(|c| c.path == LIST_ADDITIONS).count();
    assert_eq!(additions, 1, "only the stand-in's refusal reached the API");
}

#[tokio::test]
async fn a_guests_add_to_list_is_an_intent_they_register_to_claim() {
    let pilot = Pilot::new().await;
    let body = format!("dimension.dim_form=chc_raw&dimension.dim_condition=chc_nm&product={}", crate::api::segment(OFFERED));
    let (status, headers, html) = pilot.send(post_signed_out(SAVE, &body)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7753/register?returnTo=%2Fitems%2Fcharizard%3Fdimension.dim_condition%3Dchc_nm%26dimension.dim_form%3Dchc_raw%26claimSavedListIntent%3Dsli_1"
    );
    let set = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.starts_with("chase_sets_anonymous_saved_lists=anon_cmd_") && set.contains("Max-Age=2592000"), "{set}");
    let owner = set.split(';').next().unwrap().split_once('=').unwrap().1.to_owned();
    let calls = saved_list_calls(&pilot);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].headers["x-collections-anonymous-saved-list-id"], owner.as_str());
    let sent: Value = serde_json::from_str(&calls[0].body).unwrap();
    assert_eq!(
        sent,
        json!({
            "sourcePath": "/items/charizard?dimension.dim_condition=chc_nm&dimension.dim_form=chc_raw", "sourceSurface": "item-detail",
            "product": {
                "catalogItemId": "cat_charizard", "productId": OFFERED,
                "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            },
            "productSummary": "Charizard · Raw / Near Mint",
        })
    );
}

const LIST: &str = "/items/charizard/list";
const SHIP_FROM: &str = "/items/charizard/ship-from";
const ATTEMPT: &str = "0b6f3c1e-4d2a-4b8e-9f00-1234567890ab";
const LISTED: &str = "lst_0b6f3c1e4d2a4b8e9f001234567890ab";

/// A List this product form's body: the Sell tab's address, the product it showed, the attempt,
/// the price, currency and quantity.
fn list_body(attempt: &str, price: &str, currency: &str, quantity: &str) -> String {
    format!(
        "market=sell&product={}&attempt={attempt}&price={price}&currency={currency}&quantity={quantity}",
        crate::api::segment(OFFERED)
    )
}

/// The calls to a quick listing's APIs, in order, as (path, body).
fn listing_calls(pilot: &Pilot) -> Vec<(String, Value)> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls
        .iter()
        .filter(|c| c.method == Method::POST)
        .filter(|c| c.path == ENSURE || c.path.starts_with(CREATE_LISTING) || c.path == DRAFT_INTENTS || c.path == LOCATIONS)
        .map(|c| (c.path.clone(), serde_json::from_str(&c.body).unwrap_or_default()))
        .collect()
}

#[tokio::test]
async fn a_seller_without_a_ship_from_sees_its_setup_before_they_can_list() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(SELL_PAGE, Some("starter"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let overlay = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path == OVERLAY).cloned().expect("the overlay is read");
    assert_eq!(overlay.headers["chase-sets-read-target-context"], "discovery");
    let page = text(&html);
    assert!(page.contains("List this product Set price and quantity to create a listing."), "{page}");
    assert!(page.contains("Current best listing is $389.00."), "the price starts as the best listing's: {page}");
    assert!(html.contains(r#"action="/items/charizard/list""#), "{html}");
    assert!(
        html.contains(r#"name="price" min="0" step="0.01" inputmode="decimal" placeholder="24.99" required value="389.00""#),
        "{html}"
    );
    assert!(page.contains("Ship-from setup is required before quick listing."), "{page}");
    assert!(
        html.contains(
            r#"<button type="submit" class="item-detail__button item-detail__primary" disabled>Create listing</button>"#
        ),
        "{html}"
    );
    // The setup's own form, after it.
    assert!(html.contains(r#"action="/items/charizard/ship-from""#), "{html}");
    assert!(page.contains("Ship-from setup Create the Listing stock origin used by quick listings."), "{page}");
    assert!(
        html.contains(r#"id="ship-from-country" type="text" name="country" autocomplete="country" required value="US""#),
        "{html}"
    );
    // Nothing typed is refused here; the rest is the API's to check.
    let (status, _, html) =
        pilot.send(post(SHIP_FROM, "starter", "market=sell&name=&line1=&city=&state=&postal_code=&country=US", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(
        html.contains(r#"<p class="item-detail__error" role="alert">Ship-from setup is required before quick listing.</p>"#),
        "{html}"
    );
    assert!(listing_calls(&pilot).is_empty(), "nothing is written");
}

#[tokio::test]
async fn the_ship_from_setup_is_the_listing_stock_location_and_the_page_waits_for_it() {
    let pilot = Pilot::new().await;
    let body = format!(
        "market=sell&attempt={ATTEMPT}&name=Synthetic+Seller&line1=1+Test+Way&city=Austin&state=TX&postal_code=78701&country=US"
    );
    let (status, headers, html) = pilot.send(post(SHIP_FROM, "starter", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let write = pilot.writes().into_iter().find(|c| c.path == LOCATIONS).expect("the location is created");
    assert_eq!(write.headers["inventory-mutation-attempt"], ATTEMPT);
    let sent: Value = serde_json::from_str(&write.body).unwrap();
    assert_eq!(sent["name"], "Listing stock");
    assert_eq!(sent["shipFromCode"], "LISTING-STOCK");
    assert_eq!(sent["description"], "Auto-managed stock backing standard marketplace listings.");
    assert_eq!(sent["shipFromAddress"]["postalCode"], "78701");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/items/charizard?market=sell&after_write=%7B"), "{to}");
    // The page after it reads the overlay with the write's receipt: the form can list now.
    let (_, _, html) = pilot.send(get(to, Some("starter"))).await;
    let overlay = pilot.stand.calls.lock().unwrap().iter().rev().find(|c| c.path == OVERLAY).cloned().unwrap();
    assert_eq!(waits_for(&overlay.headers).as_deref(), Some("42"));
    assert!(
        html.contains(r#"<button type="submit" class="item-detail__button item-detail__primary">Create listing</button>"#),
        "{html}"
    );
    assert!(!html.contains(r#"action="/items/charizard/ship-from""#) && !html.contains("data-corten-read-again"), "{html}");
}

#[tokio::test]
async fn a_setup_whose_read_has_not_caught_up_says_so_and_reads_again() {
    let pilot = Pilot::new().await;
    let receipt = r#"{"observedAtMs":OBSERVED,"commitPosition":"43","sources":[]}"#.replace(
        "OBSERVED",
        &std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string(),
    );
    let to = format!("{SELL_PAGE}&after_write={}", crate::api::segment(&receipt));
    let (status, _, html) = pilot.send(get(&to, Some("starter"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Ship-from setup is still updating."), "{html}");
    assert!(!html.contains(r#"action="/items/charizard/ship-from""#), "no second setup while the first is catching up: {html}");
    assert!(html.contains(r#"<noscript data-corten-read-again="2" data-corten-head>"#), "the page reads again: {html}");
}

#[tokio::test]
async fn a_seller_lists_the_product_once_however_often_the_form_is_sent() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post(LIST, "lister", &list_body(ATTEMPT, "400", "usd", "2"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let calls = listing_calls(&pilot);
    let paths: Vec<&str> = calls.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, [ENSURE, CREATE_LISTING, &format!("{CREATE_LISTING}/{LISTED}/publish") as &str], "{calls:?}");
    let ensure = pilot.inventory_calls().into_iter().find(|c| c.path == ENSURE).unwrap();
    assert_eq!(ensure.headers["inventory-mutation-attempt"], ATTEMPT, "the stock is the form's attempt");
    assert_eq!(
        calls[0].1,
        json!({
            "catalogItemId": "cat_charizard",
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            "quantity": 2,
        })
    );
    assert_eq!(
        calls[1].1,
        json!({
            "inventoryItemId": "", "priceAmount": "400.00", "priceCurrencyCode": "USD", "quantityCap": 2,
            "inventorySnapshot": { "inventoryItemId": "inv_stock", "quantity": 2, "attempt": ATTEMPT, "shipFromAddress": { "line1": "1 Test Way" } },
            "listingIdOverride": LISTED,
        })
    );
    assert_eq!(calls[2].1, json!({ "feeQuoteFingerprint": "fq_1" }));
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with(&format!("/items/charizard?market=sell&listing={LISTED}&after_write=%7B")), "{to}");
    // The page after it has the listing as the seller's own: its price and Manage listing, open.
    let (_, _, html) = pilot.send(get(to, Some("lister"))).await;
    let item_read = pilot
        .stand
        .calls
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|c| c.path.starts_with("/api/marketplace/items/charizard") && c.path != OVERLAY && !c.path.ends_with("/similar"))
        .cloned()
        .unwrap();
    assert_eq!(waits_for(&item_read.headers).as_deref(), Some("31"), "the item waits for the publication");
    assert!(text(&html).contains("Your active listing is $400.00. Manage listing"), "{html}");
    assert_eq!(hrefs(&html, "Manage listing"), [format!("/account/listings/{LISTED}")]);
    assert!(
        html.contains(&format!("{OPEN_PRODUCT_FOLD}<summary><span class=\"item-detail__strong\">List this product")),
        "{html}"
    );
    // The same form sent again (its answer lost) is the same stock and the same listing, already
    // published, so it is not published again (which the API refuses).
    let (status, headers, html) = pilot.send(post(LIST, "lister", &list_body(ATTEMPT, "400", "usd", "2"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let again = headers[header::LOCATION].to_str().unwrap();
    assert!(again.starts_with(&format!("/items/charizard?market=sell&listing={LISTED}&after_write=%7B")), "{again}");
    let publishes = listing_calls(&pilot).iter().filter(|(p, _)| p.ends_with("/publish")).count();
    assert_eq!(publishes, 1, "{:?}", listing_calls(&pilot));
    assert_eq!(pilot.stand.listings.lock().unwrap().len(), 1);
    assert_eq!(pilot.stand.ensured.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_item_with_more_than_one_picture_shows_one_at_a_time_picked_by_its_thumbnail() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/items/pictured", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let at = html.find(r#"<div class="item-detail__gallery">"#).expect("the gallery");
    let gallery = &html[at..at + html[at..].find("</div>").unwrap()];
    // The two pictures, then the card back that stays, each after its thumbnail; the first checked.
    assert_eq!(gallery.matches(r#"type="radio" name="item-gallery""#).count(), 3, "{gallery}");
    assert_eq!(gallery.matches(" checked").count(), 1, "{gallery}");
    let shots: Vec<&str> =
        gallery.split(r#"class="item-detail__shot" src=""#).skip(1).map(|s| s.split('"').next().unwrap()).collect();
    assert_eq!(
        shots,
        [
            "http://localhost:7753/fake-cdn/front.png",
            "http://localhost:7753/fake-cdn/back.png",
            "http://localhost:7753/fake-cdn/assets/back.png"
        ]
    );
    assert!(gallery.contains(r#"loading="eager" fetchpriority="high" alt="Charizard image 1""#), "{gallery}");
    assert_eq!(gallery.matches(r#"loading="lazy" alt="Charizard image"#).count(), 1, "only the second picture waits: {gallery}");
    assert!(gallery.contains(r#"aria-label="Card back""#), "{gallery}");
    // One picture: just the picture.
    let (_, _, html) = pilot.send(get("/items/charizard", None)).await;
    assert!(!html.contains("item-detail__gallery") && html.contains(r#"fetchpriority="high""#), "{html}");
}

#[tokio::test]
async fn similar_items_are_cards_under_the_market_book_and_a_failed_read_leaves_them_out() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(ITEM_PAGE, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let at = html.find(r#"aria-labelledby="similar-items""#).expect("the similar items");
    assert!(html.find(r#"id="market-book""#).unwrap() < at, "under the market book: {html}");
    let section = &html[at..at + html[at..].find("</section>").unwrap()];
    assert!(section.contains(r#"id="similar-items">More like this</h2>"#), "{section}");
    assert_eq!(section.matches("<li").count(), 3, "{section}");
    // Each card's View item is the item's page here, by its slug or else its id, and names its card.
    assert_eq!(hrefs(section, "View item"), ["/items/blastoise", "/items/bulbasaur", "/items/cat_mew"]);
    assert!(section.contains(r#"aria-describedby="similar-cat_blastoise""#) && section.contains(r#"id="similar-cat_blastoise""#));
    // The search card's rendition with its widths; else the card back at its card size; else none.
    assert!(
        section.contains(concat!(
            r#"src="http://localhost:7753/fake-cdn/blastoise-164.webp" "#,
            r#"srcset="http://localhost:7753/fake-cdn/blastoise-164.webp 164w, http://localhost:7753/fake-cdn/blastoise-328.webp 328w" "#,
            r#"sizes="(min-width: 768px) 164px, 124px" width="164" height="229" loading="lazy""#,
        )),
        "{section}"
    );
    assert!(section.contains(r#"alt="Blastoise — Base Set 2/102""#), "{section}");
    assert!(
        section.contains(concat!(
            r#"src="http://localhost:7753/fake-cdn/assets/back.png" "#,
            r#"srcset="http://localhost:7753/fake-cdn/assets/back-card.png 1x, http://localhost:7753/fake-cdn/assets/back-card@2x.png 2x" loading="lazy""#,
        )),
        "{section}"
    );
    assert!(section.contains(r#"role="img" aria-label="Mew""#), "{section}");
    // A failed read: the page without them.
    let (status, _, html) = pilot.send(get("/items/unlisted", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains("similar-items"), "{html}");
}

#[tokio::test]
async fn the_sales_tab_reads_the_products_market_history_with_the_page_and_draws_its_chart() {
    let pilot = Pilot::new().await;
    let page = "/items/charizard?book=sales&range=1y&dimension.dim_form=chc_raw";
    let (status, _, html) = pilot.send(get(page, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let at = html.find(r#"id="market-book""#).expect("the market book");
    let book = &html[at..at + html[at..].find("</section>").unwrap()];
    assert_eq!(
        hrefs(book, "Sales"),
        ["/items/charizard?book=sales&amp;range=1y&amp;dimension.dim_form=chc_raw"],
        "the tab keeps the range: {book}"
    );
    let shown = text(book);
    // The spread between the ask and the bid, then the dollars' last sale and medians.
    assert!(shown.contains("Spread $9.00 $389.00 ask / $380.00 bid"), "{shown}");
    assert!(shown.contains("Last sold $395.00 Sold Oct 20, 2026, 3:00 PM UTC"), "{shown}");
    assert!(shown.contains("30-day median Unavailable 1 sale in 30 days — median shown at 3+ sales"), "{shown}");
    assert!(shown.contains("90-day median $392.50 4 units sold"), "{shown}");
    // The series is read for a year, a point a week, to today.
    let calls = pilot.stand.calls.lock().unwrap().clone();
    let series = calls.iter().find(|c| c.path.contains("/series?")).expect("the series is read");
    let today = time::OffsetDateTime::now_utc().date();
    assert!(
        series
            .path
            .contains(&format!("from={}&to={today}&currencyCode=USD&granularity=weekly", today - time::Duration::days(365)))
    );
    assert!(series.headers.get("chase-sets-read-after-write").is_none());
    // The range is links, the year chosen; the chart is a line, a band and one verified sale.
    assert!(book.contains(r#"aria-current="true">1 year</a>"#), "{book}");
    assert_eq!(hrefs(book, "90 days"), ["/items/charizard?book=sales&amp;dimension.dim_form=chc_raw"]);
    assert!(book.contains(r#"<svg viewBox="0 0 640 220" role="img" aria-label="Trade price history for Charizard""#), "{book}");
    assert!(book.contains(r#"class="time-series__chart-line" d="M12.00,"#), "{book}");
    assert_eq!(book.matches("time-series__chart-band").count(), 1, "{book}");
    assert_eq!(book.matches("<circle").count(), 1, "{book}");
    assert!(book.contains("<title>Verified sale, $390.00, 2026-09-01</title>"), "{book}");
    assert!(
        shown.contains("Sale price: 3 points, from $380.00 to $395.00. Sale price marker: Verified sale, $390.00, 2026-09-01."),
        "{shown}"
    );
    // Another tab reads none of it.
    let before = pilot.stand.calls.lock().unwrap().len();
    pilot.send(get("/items/charizard?dimension.dim_form=chc_raw", None)).await;
    assert!(!pilot.stand.calls.lock().unwrap()[before..].iter().any(|c| c.path.starts_with(ROLLUPS)));
}

#[tokio::test]
async fn the_sales_tab_asks_for_a_product_and_says_when_its_history_cannot_be_read() {
    let pilot = Pilot::new().await;
    // No product named: choose one.
    let (status, _, html) = pilot.send(get("/items/unlisted?book=sales", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Select a condition Choose a product option above to see its sales history."), "{html}");
    // Pricing fails for another product: the tab says so, the page is still the page.
    let (status, _, html) = pilot.send(get("/items/charizard?book=sales&listing=lst_chase", None)).await;
    assert!(
        pilot.stand.calls.lock().unwrap().iter().any(|c| c.path.ends_with("dim_grade%3A-/stats")),
        "the listing's product's stats"
    );
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Sales history unavailable We could not load sales history right now."), "{html}");
}

#[tokio::test]
async fn a_change_to_the_item_draws_its_market_parts_again_and_a_reconnect_resumes() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/items/charizard?market=sell&book=sales", None)).await;
    assert!(html.contains(r#"<corten-live src="/items/cat_charizard/live?market=sell&amp;book=sales"></corten-live>"#), "{html}");
    let events = pilot.events(get("/items/cat_charizard/live?market=sell&book=sales", None), 1).await;
    assert_eq!(events.len(), 1, "one change, one redraw: {events:?}");
    let (event, cursor, data) = &events[0];
    assert_eq!((event.as_str(), cursor.as_str()), ("patch", "c2"));
    // The summary, the book (on the Sales tab, its history read again) and the dock, by their ids;
    // not the rail or the options.
    for id in [r#"id="market-summary""#, r#"id="market-book-section""#, r#"id="item-dock""#] {
        assert!(data.contains(id), "{id}: {data}");
    }
    assert!(!data.contains(r#"id="rail-title""#) && !data.contains(r#"id="select-options""#), "{data}");
    assert!(data.contains("Best offer") && data.contains(r#"aria-current="page">Sales</a>"#), "{data}");
    let calls = pilot.stand.calls.lock().unwrap().clone();
    assert_eq!(calls.iter().filter(|c| c.path.starts_with("/api/realtime/")).count(), 1);
    assert!(calls.iter().any(|c| c.path == "/api/realtime/public/events?topic=item%3Acat_charizard"), "the item's topic only");
    assert!(calls.iter().any(|c| c.path == "/api/marketplace/items/cat_charizard"), "the item is read again");
    // A reconnect goes on from the last cursor.
    let mut again = get("/items/cat_charizard/live?market=sell&book=sales", None);
    again.headers_mut().insert("last-event-id", "c2".parse().unwrap());
    pilot.events(again, 1).await;
    let streams: Vec<_> = pilot
        .stand
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.path.starts_with("/api/realtime/"))
        .map(|c| c.path.clone())
        .collect();
    assert_eq!(streams[1], "/api/realtime/public/events?topic=item%3Acat_charizard&cursor=c2");
}

#[tokio::test]
async fn the_mobile_dock_links_to_the_rail_on_each_side_or_to_the_options() {
    let pilot = Pilot::new().await;
    let dock = |html: &str| {
        let at = html.find(r#"<div class="item-detail__dock" id="item-dock">"#).expect("the dock");
        html[at..].split("</nav>").next().unwrap().to_owned()
    };
    // A product the page names: its price and the rail on each side, the options kept.
    let (_, _, html) = pilot.send(get("/items/charizard?dimension.dim_form=chc_raw", None)).await;
    let bar = dock(&html);
    assert!(text(&bar).contains("$389.00 Buy Sell Watch"), "{bar}");
    assert_eq!(
        hrefs(&bar, ""),
        [
            "/items/charizard?dimension.dim_form=chc_raw#rail-title",
            "/items/charizard?market=sell&amp;dimension.dim_form=chc_raw#rail-title",
            "/items/charizard?market=watch&amp;dimension.dim_form=chc_raw#rail-title",
        ]
    );
    assert!(html.contains(r#"id="rail-title""#), "the links' target: {html}");
    // On the Sell side the price is the best offer's.
    let (_, _, html) = pilot.send(get("/items/charizard?market=sell", None)).await;
    assert!(text(&dock(&html)).starts_with("$380.00"), "{html}");
    // Nothing named: one Select options, to the options.
    let (status, _, html) = pilot.send(get("/items/unlisted", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let bar = dock(&html);
    assert_eq!(hrefs(&bar, "Select options"), ["#select-options"], "{bar}");
    assert!(!bar.contains("#rail-title"), "{bar}");
}

#[tokio::test]
async fn a_listing_whose_read_has_not_caught_up_says_it_was_published_and_reads_again() {
    let pilot = Pilot::new().await;
    let receipt = r#"{"observedAtMs":OBSERVED,"commitPosition":"44","sources":[]}"#.replace(
        "OBSERVED",
        &std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string(),
    );
    let to = format!("{SELL_PAGE}&listing={LISTED}&after_write={}", crate::api::segment(&receipt));
    let (status, _, html) = pilot.send(get(&to, Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Listing published It shows here in a moment"), "{html}");
    assert_eq!(hrefs(&html, "Manage listing"), [format!("/account/listings/{LISTED}")]);
    assert!(html.contains(&format!("{OPEN_PRODUCT_FOLD}<summary>")), "the fold is open on it: {html}");
    assert!(!page.contains("Listing unavailable"), "a listing on its way is not unavailable: {html}");
    assert!(!html.contains(r#"action="/items/charizard/list""#), "no second listing while the first catches up: {html}");
    assert!(html.contains(r#"<noscript data-corten-read-again="2" data-corten-head>"#), "the page reads again: {html}");
    let calls = pilot.stand.calls.lock().unwrap().clone();
    let reads: Vec<_> =
        calls.iter().filter(|c| c.path == "/api/marketplace/items/charizard").map(|c| waits_for(&c.headers)).collect();
    assert_eq!(reads, [Some("44".to_owned()), None], "the item with the receipt, then as it is now");
}

#[tokio::test]
async fn a_listing_the_input_or_the_api_refuses_says_why_in_its_form() {
    let pilot = Pilot::new().await;
    // A price past the field's step, or none: nothing is written.
    for price in ["1.234", "", "0"] {
        let (status, _, html) = pilot.send(post(LIST, "lister", &list_body(ATTEMPT, price, "USD", "1"), false)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{price}: {html}");
        assert!(text(&html).contains("Enter a price greater than $0.00 using dollars and cents."), "{price}: {html}");
    }
    let (status, _, html) = pilot.send(post(LIST, "lister", &list_body(ATTEMPT, "10", "USD", "0"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Enter a quantity of 1 or more."), "{html}");
    assert!(listing_calls(&pilot).is_empty());
    // The API refuses the listing: the form says so, with what was typed.
    let (status, _, html) = pilot.send(post(LIST, "lister", &list_body(ATTEMPT, "1", "USD", "3"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(
        html.contains(r#"<p class="item-detail__error" role="alert">Listing price is below the marketplace minimum.</p>"#),
        "{html}"
    );
    assert!(
        html.contains(r#"value="1""#)
            && html.contains(
                r#"id="list-quantity" type="number" name="quantity" min="1" step="1" inputmode="numeric" required value="3""#
            ),
        "{html}"
    );
    // A publication refused leaves the draft, which the form links to.
    let attempt = "1b6f3c1e-4d2a-4b8e-9f00-1234567890ab";
    let (status, _, html) = pilot.send(post(LIST, "lister", &list_body(attempt, "2", "USD", "1"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("Listings require a resolved shipping measure before publication. Manage listing"), "{html}");
    assert_eq!(hrefs(&html, "Manage listing"), ["/account/listings/lst_1b6f3c1e4d2a4b8e9f001234567890ab"]);
    // A graded product's stock is refused, as on marketplace (chase-sets/chase-sets#10598).
    let address = "market=sell&dimension.dim_form=chc_graded&dimension.dim_grade=chc_grade_7";
    let (_, _, html) = pilot.send(get(&format!("/items/charizard?{address}"), Some("lister"))).await;
    let form = html.split(r#"action="/items/charizard/list""#).nth(1).expect("the listing form");
    let product = form.split(r#"name="product" value=""#).nth(1).and_then(|s| s.split('"').next()).unwrap().replace("&amp;", "&");
    assert!(product.contains("chc_graded"), "{product}");
    let graded =
        format!("{address}&product={}&attempt={ATTEMPT}&price=700&currency=USD&quantity=1", crate::api::segment(&product));
    let (status, _, html) = pilot.send(post(LIST, "lister", &graded, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("Graded listing stock requires graded card details."), "{html}");
}

#[tokio::test]
async fn a_guest_drafts_a_listing_and_registers_to_claim_it() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(SELL_PAGE, None)).await;
    let page = text(&html);
    assert!(page.contains("Guests can draft the price and quantity before registration."), "{page}");
    assert!(!page.contains("Ship-from setup"), "a guest needs no ship-from: {page}");
    assert!(!pilot.stand.calls.lock().unwrap().iter().any(|c| c.path == OVERLAY), "a guest's page reads no overlay");
    let req = post(LIST, "nobody", &list_body(ATTEMPT, "25.5", "usd", "1"), false);
    let (status, headers, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(
        headers[header::LOCATION],
        "http://localhost:7753/register?returnTo=%2Faccount%2Flistings%2Fnew%3FclaimListingIntent%3Dldi_1"
    );
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        cookie.starts_with("chase_sets_anonymous_listing_drafts=anon_cmd_") && cookie.contains("Max-Age=2592000"),
        "{cookie}"
    );
    let calls = listing_calls(&pilot);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(
        calls[0].1,
        json!({
            "sourcePath": "/items/charizard?market=sell", "catalogItemId": "cat_charizard", "productId": OFFERED,
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_nm" }],
            // No options chosen: the product and its words are the offer's, as the page showed them.
            "productSummary": "Form: Raw | Condition: Near Mint", "priceAmount": "25.50", "priceCurrencyCode": "USD", "quantityCap": 1,
        })
    );
}

#[tokio::test]
async fn an_account_that_may_not_list_is_sent_to_registration_and_cannot_post() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(SELL_PAGE, Some("watcher"))).await;
    let page = text(&html);
    assert!(page.contains("Asking price Set before publishing Inventory Confirm before publishing"), "{page}");
    assert_eq!(
        hrefs(&html, "Continue to create listing"),
        ["http://localhost:7753/register?returnTo=%2Fitems%2Fcharizard%3Fmarket%3Dsell"]
    );
    assert!(!html.contains(r#"action="/items/charizard/list""#), "{html}");
    let (status, _, _) = pilot.send(post(LIST, "watcher", &list_body(ATTEMPT, "10", "USD", "1"), false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(listing_calls(&pilot).is_empty());
}

/// The search reads the pilot sent, as their parameters.
fn search_reads(pilot: &Pilot) -> Vec<HashMap<String, String>> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with("/api/marketplace/items?")).map(|c| query(&c.path)).collect()
}

#[tokio::test]
async fn search_moves_old_addresses_for_good_and_applies_the_filters_its_words_name() {
    let pilot = Pilot::new().await;
    for (from, to) in [
        // `page` is gone, the rest as sent.
        ("/search?page=2&q=x", "/search?q=x"),
        // A category asked for as a parameter, or by its id or key, is at its slug's path.
        ("/search?category=singles&sort=newest", "/categories/singles-x1?sort=newest"),
        ("/categories/ctg_singles?inStock=true", "/categories/singles-x1?inStock=true"),
    ] {
        let (status, headers, _) = pilot.send(get(from, None)).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{from}");
        assert_eq!(headers[header::LOCATION], to, "{from}");
    }
    // The words the API reads a filter from: the address with it applied and the words left,
    // marked so they are not read again.
    let (status, headers, _) = pilot.send(get("/search?q=charizard%20psa%2010", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert_eq!(to, "/search?q=charizard&dimension.dim_grade=chc_10&interpreted=dimension.dim_grade");
    let (status, _, html) = pilot.send(get(&to, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Filters applied from your search: Grade: Gem Mint 10"), "{html}");
    let read = search_reads(&pilot).pop().unwrap();
    assert_eq!(read.get("interpreted").map(String::as_str), Some("dimension.dim_grade"));
    // Removing the applied filter keeps the mark (the words are still not read again); another
    // change drops it.
    assert!(html.contains(r#"href="/search?q=charizard&amp;interpreted=dimension.dim_grade""#), "{html}");
    assert!(html.contains(r#"href="/search?dimension.dim_grade=chc_10""#), "the words' chip: {html}");
}

#[tokio::test]
async fn search_sends_its_terms_and_draws_results_filters_and_load_more() {
    let pilot = Pilot::new().await;
    let address =
        "/search?q=pika&priceMin=12.5&priceMax=01&inStock=true&marketActivity=offers&dimension.dim_grade=chc_10&sort=newest";
    let (status, _, html) = pilot.send(get(address, None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let read = search_reads(&pilot).pop().unwrap();
    for (key, value) in [
        ("search", "pika"),
        ("priceMin", "12.5"),
        ("inStock", "true"),
        ("marketActivity", "offers"),
        ("sort", "newest"),
        ("limit", "24"),
        ("includeTotal", "true"),
        ("dimension.dim_grade", "chc_10"),
    ] {
        assert_eq!(read.get(key).map(String::as_str), Some(value), "{key}: {read:?}");
    }
    assert!(!read.contains_key("priceMax"), "a price with a leading zero is no price: {read:?}");
    assert_eq!(html.matches(r#"<li id="result-"#).count(), 24);
    assert!(html.contains("Showing 24 of 30 results in All Categories"), "{html}");
    // A result links to its item with the dimension filter, Buy first when it has listings.
    assert!(html.contains(r#"href="/items/card-1?dimension.dim_grade=chc_10""#), "{html}");
    // A result without listings offers Sell first.
    let sell =
        html.find(r#"href="/items/card-2?market=sell&amp;dimension.dim_grade=chc_10" aria-label="Add product to Sell List""#);
    let buy = html.find(r#"href="/items/card-2?dimension.dim_grade=chc_10" aria-label="Add product to Buy Cart""#);
    assert!(sell.is_some() && buy.is_some() && sell < buy, "{html}");
    assert!(html.contains("From"), "{html}");
    assert!(html.contains(">Japanese<"), "a result's language: {html}");
    // The filters are one GET form; the words box and the sort are in it by its id.
    assert!(html.contains(r#"<form id="search-form""#), "{html}");
    assert!(html.contains(r#"<input type="search" name="q" form="search-form" value="pika""#), "{html}");
    assert!(html.contains(r#"<select name="sort" form="search-form">"#), "{html}");
    assert!(html.contains(r#"<input type="checkbox" name="dimension.dim_grade" value="chc_10" checked>"#), "{html}");
    // Each chip is the address without its filter.
    assert!(html.contains("Minimum price: $12.50"), "{html}");
    assert!(
        html.contains(
            r#"href="/search?q=pika&amp;marketActivity=offers&amp;priceMin=12.5&amp;sort=newest&amp;dimension.dim_grade=chc_10""#
        ),
        "the in-stock chip: {html}"
    );
    // Load more: a GET form with every choice, a page more and the API's cursor. Without
    // JavaScript it is the address with a page more, at the first result it adds.
    let form = r#"<form id="load-more" class="#;
    assert!(html.contains(form) && html.contains(r#"action="/search#result-25" data-patch>"#), "{html}");
    for field in [
        r#"<input type="hidden" name="q" value="pika">"#,
        r#"<input type="hidden" name="marketActivity" value="offers">"#,
        r#"<input type="hidden" name="dimension.dim_grade" value="chc_10">"#,
        r#"<input type="hidden" name="more" value="24">"#,
        r#"<input type="hidden" name="cursor" value="c1">"#,
    ] {
        assert!(html.contains(field), "{field}: {html}");
    }
    let more = "/search?q=pika&marketActivity=offers&priceMin=12.5&inStock=true&sort=newest&dimension.dim_grade=chc_10&more=24&cursor=c1";
    let (status, _, html) = pilot.send(get(more, None)).await;
    assert_eq!(status, StatusCode::OK);
    let read = search_reads(&pilot).pop().unwrap();
    assert_eq!(read.get("limit").map(String::as_str), Some("48"), "{read:?}");
    assert!(!read.contains_key("cursor"), "a whole page reads from the first result: {read:?}");
    assert_eq!(html.matches(r#"<li id="result-"#).count(), 30);
    assert!(
        html.contains(r#"<form id="load-more" class="#) && html.contains(r#"data-patch hidden>"#),
        "every result is shown: {html}"
    );
    // The canonical address leaves Load more out.
    assert!(
        html.contains(r#"<link rel="canonical" href="http://localhost:7753/search?q=pika&amp;marketActivity=offers"#),
        "{html}"
    );
    assert!(!html.contains(r#"more=24" data-corten-head"#), "{html}");
}

/// A GET as the runtime sends a `data-patch` form's (`corten: action`).
fn get_patch(uri: &str) -> Request<Body> {
    let mut req = get(uri, None);
    req.headers_mut().insert("corten", "action".parse().unwrap());
    req
}

#[tokio::test]
async fn load_more_with_javascript_adds_only_the_next_page_and_says_when_it_failed() {
    let pilot = Pilot::new().await;
    let more = "/categories/singles-x1?q=pika&dimension.dim_grade=chc_10&more=24&cursor=c1";
    let (status, headers, html) = pilot.send(get_patch(more)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(headers.contains_key("corten-patch"), "a patch: {headers:?}");
    // One page read after the cursor, in the category, without the total.
    let read = search_reads(&pilot).pop().unwrap();
    for (key, value) in [("cursor", "c1"), ("limit", "24"), ("category", "singles-x1"), ("dimension.dim_grade", "chc_10")] {
        assert_eq!(read.get(key).map(String::as_str), Some(value), "{key}: {read:?}");
    }
    assert!(!read.contains_key("includeTotal"), "{read:?}");
    // Its six rows, numbered after the 24 the page has, added at the end of the list.
    assert!(html.starts_with(r#"<template id="results" data-append>"#), "{html}");
    assert_eq!(html.matches(r#"<li id="result-"#).count(), 6, "{html}");
    assert!(html.contains(r#"<li id="result-25""#) && html.contains(r#"<li id="result-30""#), "{html}");
    assert!(html.contains(r#"href="/items/card-25?dimension.dim_grade=chc_10""#), "{html}");
    // Load more again, hidden: there is no page after it.
    assert!(
        html.contains(r#"<form id="load-more" class="#)
            && html.contains(r#"action="/categories/singles-x1#result-31" data-patch hidden>"#),
        "{html}"
    );

    // A cursor the API no longer takes: its first page replaces the rows.
    let (status, _, html) = pilot.send(get_patch("/search?q=pika&more=24&cursor=gone")).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains("data-append"), "{html}");
    assert!(html.contains(r#"<ol id="results" class="#), "{html}");
    assert!(html.contains(r#"<li id="result-1""#) && html.contains(r#"<li id="result-24""#), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="more" value="24">"#), "{html}");

    // A failed read leaves the rows and offers Load more again, saying so.
    let (status, _, html) = pilot.send(get_patch("/search?q=pika&more=24&cursor=broken")).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains(r#"<li id="result-"#), "{html}");
    assert!(html.contains("Could not load more results") && html.contains(">Retry loading results</button>"), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="cursor" value="broken">"#), "{html}");

    // Without JavaScript the same form is the page with a page more.
    let (status, headers, html) = pilot.send(get(more, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!headers.contains_key("corten-patch"), "{headers:?}");
    assert_eq!(html.matches(r#"<li id="result-"#).count(), 30);
}

#[test]
fn the_search_forms_names_are_the_ones_its_links_write() {
    use crate::search::{Filter, Kind, Terms, TermsQuery};
    let terms = Terms {
        q: "q".into(),
        category: "c".into(),
        tag: "t".into(),
        language: "ja".into(),
        activity: crate::search::Activity::Offers,
        price_min: "1".into(),
        price_max: "2".into(),
        in_stock: true,
        sort: "newest".into(),
        filters: vec![Filter { kind: Kind::Field, id: "f".into(), value: "v".into() }],
        interpreted: Some("field.f".into()),
        more: 24,
    };
    let written: Vec<String> = terms.pairs().into_iter().map(|(key, _)| key).collect();
    let f = TermsQuery::FIELDS;
    let names = [
        f.q,
        f.category,
        f.tag,
        f.language,
        f.market_activity,
        f.price_min,
        f.price_max,
        f.in_stock,
        f.sort,
        f.interpreted,
        f.more,
    ];
    for name in names {
        assert!(written.iter().any(|w| w == name.as_str()), "{name:?} is not written: {written:?}");
    }
    assert_eq!(written.len(), names.len() + 1, "and the field filter: {written:?}");
}

#[tokio::test]
async fn a_category_page_searches_in_it_and_the_landing_offers_categories() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/categories/singles-x1", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(search_reads(&pilot).pop().unwrap().get("category").map(String::as_str), Some("singles-x1"));
    assert!(html.contains("Search results in Singles"), "{html}");
    assert!(html.contains(r#"<form id="search-form" class="#) && html.contains(r#"action="/categories/singles-x1""#), "{html}");
    assert!(html.contains(r#"aria-current="page">Singles (7)"#), "{html}");
    // `/search` with nothing asked is the landing: the headline, and the categories as chips.
    let (status, _, html) = pilot.send(get("/search", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Find trading cards worth "), "{html}");
    assert!(html.contains(r#"href="/categories/singles-x1">Singles</a>"#), "{html}");
}

#[tokio::test]
async fn the_home_page_shows_the_featured_categories_and_the_newest_items_until_something_is_asked() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    // The results' read and the new arrivals' (the three newest, in no category).
    let reads = search_reads(&pilot);
    assert_eq!(reads.len(), 2, "{reads:?}");
    let arrivals = reads.iter().find(|r| r.get("limit").map(String::as_str) == Some("3")).expect("the new arrivals' read");
    assert_eq!(arrivals.get("sort").map(String::as_str), Some("newest"), "{arrivals:?}");
    assert!(!arrivals.contains_key("category"), "{arrivals:?}");
    assert!(html.contains("Find trading cards worth "), "the landing's headline: {html}");
    assert!(html.contains(">Featured categories</h2>"), "{html}");
    assert!(html.contains(">Raw and graded single cards.</p>") && html.contains(">12 items</p>"), "{html}");
    assert!(html.contains(r#"href="/categories/singles-x1">Browse Singles</a>"#), "{html}");
    assert!(html.contains(">New arrivals</h2>"), "{html}");
    assert!(html.contains(r#"href="/search?sort=newest">Browse all new arrivals</a>"#), "{html}");
    assert_eq!(html.matches(">View item</a>").count(), 3, "{html}");
    assert!(html.contains(r#"href="/items/card-1">View item</a>"#), "{html}");
    // The shelf is in place of the results, and the address it stands for is the search's.
    assert!(!html.contains(r#"<li id="result-"#), "{html}");
    assert!(html.contains(r#"<link rel="canonical" href="http://localhost:7753/search" "#), "{html}");
    assert!(html.contains(r#"action="/""#), "the filters stay at the home page: {html}");

    // Asked something, it is the search: the results, and no arrivals' read.
    let (status, _, html) = pilot.send(get("/?q=pika", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(search_reads(&pilot).len(), 3);
    assert!(!html.contains("Featured categories"), "{html}");
    assert_eq!(html.matches(r#"<li id="result-"#).count(), 24);
    assert!(html.contains(r#"action="/#result-25" data-patch>"#), "Load more stays at the home page: {html}");
    // Search's rules are in components.css, which every page links once, the home page too
    // (todd-skelton/corten#95): no section stylesheet of its own, none in the page's body.
    for uri in ["/?q=pika", "/search?q=pika", "/items/charizard"] {
        let (_, _, html) = pilot.send(get(uri, None)).await;
        assert_eq!(html.matches("/components.css\"").count(), 1, "{uri}: {html}");
        assert!(!html.contains("search+categories"), "{uri}: {html}");
    }
}

#[tokio::test]
async fn a_set_page_shows_the_set_and_its_cards_and_links_to_all_of_them() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/sets/base-set", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Base Set card list | Marketplace</title>"), "{html}");
    assert!(html.contains(">Pokemon Trading Card Game</span>") && html.contains(">Base Set</h1>"), "{html}");
    assert!(
        html.contains(">Cards in set: 102 \u{b7} Cataloged items: 3 \u{b7} set code BS \u{b7} released January 9, 1999</p>"),
        "{html}"
    );
    assert_eq!(html.matches(">View card</a>").count(), 2, "{html}");
    assert!(html.contains(r#"href="/items/set-card-1">View card</a>"#), "{html}");
    // A card shows its lowest price without "From", as marketplace's set cards do.
    assert!(html.contains(r#"<span class="search-page__strong">$12.50</span>"#) && !html.contains(">From "), "{html}");
    // The API sent two of three, so the page links to all of them in search.
    assert!(html.contains(r#"href="/search?reference.expansion=ref_base_set">Browse all 3 cards in this set</a>"#), "{html}");
    assert!(html.contains(r#"<link rel="canonical" href="http://localhost:7753/sets/base-set" "#), "{html}");
    assert!(html.contains(r#""@type":"BreadcrumbList""#) && html.contains(r#""item":"http://localhost:7753/search""#), "{html}");
    assert!(search_reads(&pilot).is_empty(), "the set's read has its items");

    let (_, _, html) = pilot.send(get("/sets/empty-set", None)).await;
    assert!(html.contains(">No cards yet</h2>") && html.contains(r#"href="/search">Browse marketplace</a>"#), "{html}");
}

#[tokio::test]
async fn an_old_set_slug_moves_with_its_query_an_unknown_set_is_not_found_and_a_failed_read_a_bad_gateway() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/sets/base?ref=nav", None)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, "/sets/base-set?ref=nav"));
    let (status, headers, html) = pilot.send(get("/sets/no-such-set", None)).await;
    assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::NOT_FOUND, &"noindex".parse().unwrap()), "{html}");
    assert_eq!(pilot.send(get("/sets/down", None)).await.0, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_listing_page_shows_the_listing_its_purchase_panel_and_its_seller() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/listings/psa-8", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Charizard | Marketplace</title>"), "{html}");
    assert!(html.contains(r#"<meta name="description" content="$749.00 from Chase Sets." "#), "{html}");
    assert!(html.contains(r#"<link rel="canonical" href="http://localhost:7753/listings/psa-8" "#), "{html}");
    assert!(html.contains(">Charizard</h1>") && html.contains(">Base Set 4/102 Holo Rare</p>"), "{html}");
    for chip in ["graded", "psa", "nm-mt-8"] {
        assert!(html.contains(&format!(">{chip}</span>")), "{chip}: {html}");
    }
    let page = text(&html);
    for words in
        ["$749.00 from Chase Sets", "Ready to buy this listing", "1 available", "Ships from Chicago, IL", "Order protected", "5%"]
    {
        assert!(page.contains(words), "{words}: {page}");
    }
    assert!(html.contains(r#"<form method="post" action="/listings/psa-8/buy">"#), "{html}");
    assert!(html.contains(r#"href="/items/charizard">Compare market</a>"#), "{html}");
    assert!(html.contains(r#"href="/accounts/chase-sets#feedback">View account</a>"#), "{html}");
    assert!(html.contains(r#"<select name="reason" required>"#) && html.contains(r#"maxlength="1000""#), "{html}");
    assert!(!html.contains(r#"role="status""#), "{html}");
}

#[tokio::test]
async fn an_old_listing_slug_moves_with_its_query_an_unknown_one_is_not_found_and_a_failed_read_a_bad_gateway() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/listings/old-psa-8?ref=x", None)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, "/listings/psa-8?ref=x"));
    let (status, headers, _) = pilot.send(get("/listings/nope", None)).await;
    assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::NOT_FOUND, &"noindex".parse().unwrap()));
    assert_eq!(pilot.send(get("/listings/down", None)).await.0, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn an_away_sellers_listing_shows_why_and_offers_no_buy() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/listings/away", None)).await;
    assert!(
        html.contains(">Seller is away</p>") && html.contains("This seller is away. Listings return November 8, 2026."),
        "{html}"
    );
    assert!(!html.contains("/listings/away/buy"), "{html}");
    assert!(html.contains(">Unavailable</span>"), "{html}");
    let (status, _, html) = pilot.send(post("/listings/away/buy", "buyer", &format!("attempt={KEY}"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains(r#"role="alert"><p>This seller is away. Listings return November 8, 2026.</p>"#), "{html}");
}

#[tokio::test]
async fn buy_this_listing_starts_a_checkout_for_an_account_and_sends_a_guest_to_guest_checkout() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post("/listings/psa-8/buy", "buyer", &format!("attempt={KEY}"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(
        headers["location"].to_str().unwrap().starts_with("http://localhost:7753/checkout/buy/session/chk_1?afterWrite="),
        "{headers:?}"
    );
    let call = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.ends_with("/checkout-sessions")).cloned().unwrap();
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(sent["entryAttemptKey"], KEY);
    assert_eq!(
        (&sent["source"]["type"], &sent["source"]["lockedListingId"], &sent["source"]["quantity"]),
        (&json!("buy-now"), &json!("lst_psa_8"), &json!(1))
    );
    // A guest: marketplace's guest checkout with the listing.
    let (status, headers, _) = pilot.send(post("/listings/psa-8/buy", "guest", &format!("attempt={KEY}"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/checkout/buy/readiness?source=buy-now&listingId=lst_psa_8"), "{to}");
    assert!(to.contains("&availability=1%20available&fulfillment=Ships%20from%20Chicago%2C%20IL"), "{to}");
    // An attempt that is not one is refused, and nothing is started.
    let (status, _, _) = pilot.send(post("/listings/psa-8/buy", "buyer", "attempt=x", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.ends_with("/checkout-sessions")).count(), 1);
}

#[tokio::test]
async fn a_report_is_received_once_and_a_repeat_or_a_busy_reporter_is_told_so() {
    let pilot = Pilot::new().await;
    // A visitor's first report: a new reporter cookie, and the page says it was received.
    let (status, headers, _) =
        pilot.send(post("/listings/psa-8/report", "nobody", "reason=pricing-scam&details=Too+low", false)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/listings/psa-8?reported=1"));
    let cookie = headers["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("chase_sets_anonymous_reports=anon_cmd_"), "{cookie}");
    let call = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.ends_with("/report")).cloned().unwrap();
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(sent, json!({ "reason": "pricing-scam", "details": "Too low", "sourceRoutePath": "/listings/psa-8" }));
    let (_, _, html) = pilot.send(get("/listings/psa-8?reported=1", None)).await;
    assert!(html.contains(r#"role="status"><p>Thanks. We received your report"#) && !html.contains(r#"name="reason""#), "{html}");

    // The same visitor again, and one who sent too many: the page, saying so.
    let report = |visitor: &str| {
        let mut req = post("/listings/psa-8/report", "nobody", "reason=other&details=", false);
        req.headers_mut().insert(header::COOKIE, format!("chase_sets_anonymous_reports={visitor}").parse().unwrap());
        req
    };
    let (status, headers, html) = pilot.send(report("anon_repeat")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(!headers.contains_key("set-cookie"), "the reporter keeps their cookie");
    assert!(html.contains("You have already reported this listing."), "{html}");
    let (status, _, html) = pilot.send(report("anon_busy")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{html}");
    assert!(html.contains(r#"role="alert"><p>You have sent several reports"#) && html.contains(r#"name="reason""#), "{html}");

    // A reason that is not one is refused here, with the details kept.
    let (status, _, html) = pilot.send(post("/listings/psa-8/report", "nobody", "reason=spam&details=Keep+me", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Choose a reason for the report.") && html.contains(">Keep me</textarea>"), "{html}");
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.ends_with("/report")).count(), 3);
}

#[tokio::test]
async fn a_failed_search_says_so_with_a_502_and_keeps_the_filters() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/search?q=broken", None)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(html.contains("The platform API did not answer."), "{html}");
    assert!(html.contains(r#"<form id="search-form""#), "{html}");
    assert!(!html.contains("No items found"), "a failed read is not an empty one: {html}");
}

/// The account page's reads of the API (the chips left out).
fn account_reads(pilot: &Pilot) -> Vec<String> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls
        .iter()
        .filter(|c| c.path.starts_with("/api/marketplace/accounts/") && !c.path.contains("/behavioral"))
        .map(|c| c.path.clone())
        .collect()
}

#[tokio::test]
async fn an_accounts_page_shows_its_standing_chips_feedback_reviews_and_listings() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/accounts/chase-sets", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(account_reads(&pilot), ["/api/marketplace/accounts/chase-sets?limit=10&offset=0"]);
    assert!(html.contains("<title>Chase Sets | Marketplace</title>"), "{html}");
    assert!(html.contains(r#"<link rel="canonical" href="http://localhost:7753/accounts/chase-sets" "#), "{html}");
    assert!(!html.contains("noindex"), "{html}");
    let page = text(&html);
    for words in [
        "Chase Sets",
        "Trusted seller",
        "Founder #007",
        "Member since",
        "Ships on time",
        "Rarely disputed",
        "As seller",
        "As buyer",
        "18 ratings included \u{b7} 20 reviews",
        "Collector Zero | Oct 20, 2026",
        "Seller response: Thanks!",
        "Included in rating",
        "Shared for context \u{b7} rating not included",
        "$749.00",
        "Ships from Chicago, IL",
        "Ships from St. Louis, MO",
        "2 available | Limit 1 per order",
    ] {
        assert!(page.contains(words), "{words}: {page}");
    }
    assert!(!page.contains("Rarely cancels"), "a chip the API does not vouch for is left out: {page}");
    assert!(html.contains(r#"<li id="review-rev_1""#) && html.contains(r#"<dialog id="report-dialog-rev_1""#), "{html}");
    assert!(html.contains(r#"action="/accounts/chase-sets/reviews/rev_1/report""#), "{html}");
    // The roles and the pages are links to the feedback, the current one marked.
    for href in
        ["/accounts/chase-sets#feedback", "/accounts/chase-sets?role=seller#feedback", "/accounts/chase-sets?role=buyer#feedback"]
    {
        assert!(html.contains(&format!(r#"href="{href}""#)), "{href}: {html}");
    }
    assert!(html.contains(r#"href="/accounts/chase-sets?page=2#feedback">Next page</a>"#), "{html}");
    assert!(html.contains(r#"href="/accounts/chase-sets?page=3#feedback" aria-label="Page 3""#), "{html}");
    assert!(!html.contains(">Previous page</a>"), "{html}");
    assert!(
        html.contains(r#"href="/listings/psa-8">View listing</a>"#) && html.contains(r#"href="/items/charizard">Compare</a>"#),
        "{html}"
    );
}

#[tokio::test]
async fn the_reviews_role_and_page_are_read_from_the_api_and_written_back_into_the_links() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/accounts/chase-sets?role=seller&page=2", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(account_reads(&pilot), ["/api/marketplace/accounts/chase-sets?limit=10&offset=10&role=seller"]);
    assert!(html.contains(r#"href="/accounts/chase-sets?role=seller#feedback">Previous page</a>"#), "{html}");
    assert!(html.contains(r#"href="/accounts/chase-sets?role=seller&amp;page=3#feedback">Next page</a>"#), "{html}");
    assert!(html.contains(r#"href="/accounts/chase-sets?role=seller&amp;page=2#feedback" aria-current="page""#), "{html}");
    assert!(html.contains(r#"action="/accounts/chase-sets/reviews/rev_1/report?role=seller&amp;page=2""#), "{html}");
}

#[tokio::test]
async fn an_old_slug_or_id_moves_an_unknown_account_is_not_found_and_a_closed_one_is_not_indexed() {
    let pilot = Pilot::new().await;
    for old in ["/accounts/old-chase?role=buyer", "/accounts/acc_chase?role=buyer"] {
        let (status, headers, _) = pilot.send(get(old, None)).await;
        assert_eq!(
            (status, headers["location"].to_str().unwrap()),
            (StatusCode::MOVED_PERMANENTLY, "/accounts/chase-sets?role=buyer")
        );
    }
    let (status, headers, html) = pilot.send(get("/accounts/no-such-account", None)).await;
    assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::NOT_FOUND, &"noindex".parse().unwrap()), "{html}");
    assert_eq!(pilot.send(get("/accounts/down", None)).await.0, StatusCode::BAD_GATEWAY);
    let (status, _, html) = pilot.send(get("/accounts/closed", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"<meta name="robots" content="noindex" "#), "{html}");
    assert!(html.contains(">Chase Sets&#39;s marketplace profile isn&#39;t available right now.</p>"), "{html}");
    assert!(!html.contains("id=\"feedback\""), "a closed account shows no feedback: {html}");
}

#[tokio::test]
async fn an_account_with_nothing_yet_says_so_and_a_failed_chips_read_shows_none() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/accounts/quiet", None)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    for words in ["No feedback yet", "No written feedback yet.", "No active listings", "Browse marketplace"] {
        assert!(page.contains(words), "{words}: {page}");
    }
    assert!(!page.contains("Ships on time") && !html.contains(r#"data-tone="success"><"#), "{html}");
    assert!(!html.contains("Next page"), "{html}");
    assert!(
        pilot
            .stand
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.path == "/api/marketplace/accounts/acc_quiet/behavioral-metrics-chips")
    );
}

#[tokio::test]
async fn report_review_is_received_once_refused_in_its_open_dialog_and_a_visitor_signs_in() {
    let pilot = Pilot::new().await;
    let report = "/accounts/chase-sets/reviews/rev_1/report?page=2";
    let (status, headers, html) = pilot.send(post(report, "buyer", "reason=spam-or-manipulation&details=Paid+for", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(headers["location"].to_str().unwrap(), "/accounts/chase-sets?page=2&reported=rev_1#review-rev_1");
    let call = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.ends_with("/rev_1/report")).cloned().unwrap();
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(
        sent,
        json!({ "reason": "spam-or-manipulation", "details": "Paid for", "sourceRoutePath": "/accounts/chase-sets" })
    );
    let (_, _, html) = pilot.send(get("/accounts/chase-sets?page=2&reported=rev_1", Some("buyer"))).await;
    assert!(html.contains(r#"role="status"><p class="#) && text(&html).contains("Report submitted"), "{html}");
    assert!(
        !html.contains(r#"<dialog id="report-dialog-rev_1""#) && html.contains(r#"<dialog id="report-dialog-rev_refused""#),
        "{html}"
    );

    // Reported already: the page, saying so, with the button off.
    let (status, _, html) = pilot.send(post(report, "other", "reason=other&details=", false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(text(&html).contains("This account already reported this review."), "{html}");

    // A reason that is not one, too many reports, and one the API refuses: the dialog drawn open
    // with what was sent.
    let (status, _, html) = pilot.send(post(report, "buyer", "reason=nope&details=Keep+me", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Choose a reason for the report.") && html.contains(">Keep me</textarea>"), "{html}");
    let open = html.split(r#"<dialog id="report-dialog-rev_1""#).nth(1).unwrap().split('>').next().unwrap();
    assert!(open.contains(" open"), "{open}");
    let (status, _, html) = pilot.send(post(report, "stale", "reason=other&details=", false)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{html}");
    assert!(html.contains("You have sent several reports"), "{html}");
    let refused = "/accounts/chase-sets/reviews/rev_refused/report";
    let (status, _, html) = pilot.send(post(refused, "buyer", "reason=other&details=", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("This review cannot be reported."), "{html}");

    // A visitor signs in on marketplace, back to the page.
    let (status, headers, _) = pilot.send(post(report, "nobody", "reason=other&details=", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("http://localhost:7753/sign-in?") && to.contains("%2Faccounts%2Fchase-sets"), "{to}");
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.ends_with("/report")).count(), 5);
}

/// The notification center's calls to the API (the session lookups left out).
fn notice_calls(pilot: &Pilot) -> Vec<Call> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with("/api/notifications/") || c.path.starts_with(ACCOUNT_ALERTS)).cloned().collect()
}

#[tokio::test]
async fn the_feed_shows_each_notification_its_source_and_time_and_open_stays_here_or_goes_to_marketplace() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/notifications", Some("watcher"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(
        notice_calls(&pilot).iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        ["/api/notifications/center?limit=25&includeRead=true"]
    );
    assert!(html.contains("<title>Notifications | Marketplace</title>"), "{html}");
    assert!(html.contains(r#"href="/account/notifications" aria-current="page""#), "{html}");
    let page = text(&html);
    for words in
        ["Recent updates", "1 unread", "Order ORD-1 cancelled", "New", "Orders", "Product alerts", "Read", "Oct 25, 2026"]
    {
        assert!(page.contains(words), "{words}: {page}");
    }
    // Both pages are the pilot's (the orders since their port).
    assert!(html.contains(r#"href="/account/purchases/ord_1">Open</a>"#), "{html}");
    assert!(html.contains(r#"href="/items/charizard">Open</a>"#), "{html}");
    // Mark read only for the unread one, each a form naming its delivery.
    assert_eq!(html.matches(r#"name="delivery""#).count(), 1, "{html}");
    assert!(html.contains(r#"name="delivery" value="dlv_1""#), "{html}");
    assert!(html.contains(r#"action="/account/notifications/read-all" data-patch><button type="submit" class="#), "{html}");
    assert!(html.contains(">Mark all read</button>") && !html.contains(" disabled>Mark all read</button>"), "{html}");
}

#[tokio::test]
async fn mark_read_draws_the_feed_the_api_answered_with_and_without_a_script_redirects_to_it() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/account/notifications/read", "watcher", "delivery=dlv_1", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"<section id="feed""#) && text(&html).contains("0 unread"), "{html}");
    assert!(html.contains(" disabled>Mark all read</button>"), "{html}");
    // The API's answer is the feed after the write, so nothing is read again.
    assert_eq!(
        notice_calls(&pilot).iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        ["/api/notifications/center/dlv_1/read"]
    );
    let (status, headers, _) = pilot.send(post("/account/notifications/read-all", "watcher", "", false)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/account/notifications"));
    // A write the API did not answer: the feed as it is, saying so, 502.
    let (status, _, html) = pilot.send(post("/account/notifications/read", "watcher", "delivery=dlv_broken", false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains(r#"role="alert"><p>Try again in a moment.</p>"#) && text(&html).contains("1 unread"), "{html}");
}

#[tokio::test]
async fn the_settings_show_the_channels_the_page_has_words_for_and_the_accounts_alerts() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/notifications?view=settings", Some("watcher"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"href="/account/notifications?view=settings" aria-current="page""#), "{html}");
    for key in ["web", "email", "product-alerts"] {
        assert!(html.contains(&format!(r#"<form id="preference-{key}""#)), "{key}: {html}");
    }
    assert!(!html.contains(r#"id="preference-sms""#) && !html.contains(r#"id="preference-rcs""#), "{html}");
    assert_eq!(html.matches(r#"role="switch" aria-checked="true""#).count(), 3, "{html}");
    assert!(
        html.contains(
            r#"action="/account/notifications/preferences/email" data-patch><input type="hidden" name="enabled" value="false">"#
        ),
        "{html}"
    );
    let page = text(&html);
    for words in [
        "Delivery settings",
        "In-app notifications",
        "Email notifications",
        "Charizard, PSA 8",
        "Listings - at or below $25.00",
        "Offers - all new matches",
        "active",
        "paused",
    ] {
        assert!(page.contains(words), "{words}: {page}");
    }
    assert!(html.contains(r#"<section id="product-alerts""#), "{html}");
    assert!(
        html.contains(
            r#"action="/account/notifications/product-alerts/pal_1" data-patch><input type="hidden" name="action" value="pause">"#
        ),
        "{html}"
    );
    assert!(html.contains(r#"action="/account/notifications/product-alerts/pal_2" data-patch><input type="hidden" name="action" value="resume">"#), "{html}");
    assert!(html.contains(r#"href="/items/cat_charizard">View product</a>"#), "{html}");
    assert!(!html.contains("autofocus"), "only the alerts' section takes focus: {html}");
    let (_, _, html) = pilot.send(get("/account/notifications?view=settings&section=product-alerts", Some("watcher"))).await;
    assert!(html.contains(r#"tabindex="-1" autofocus>Product alerts</h2>"#), "{html}");
}

#[tokio::test]
async fn a_channels_switch_turns_it_the_other_way_and_draws_the_switch_the_api_answered_with() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/account/notifications/preferences/email", "watcher", "enabled=false", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"<form id="preference-email""#) && html.contains(r#"aria-checked="false""#), "{html}");
    assert!(html.contains(r#"name="enabled" value="true""#), "the switch now turns it back on: {html}");
    let call = notice_calls(&pilot).into_iter().find(|c| c.method == Method::POST).unwrap();
    assert_eq!((call.path.as_str(), call.body.as_str()), ("/api/notifications/preferences/email", r#"{"enabled":false}"#));
    let (status, headers, _) = pilot.send(post("/account/notifications/preferences/web", "watcher", "enabled=true", false)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/account/notifications?view=settings"));
    let (status, _, html) = pilot.send(post("/account/notifications/preferences/nope", "watcher", "enabled=true", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains(r#"role="alert"><p>Choose a notification channel.</p>"#), "{html}");
}

#[tokio::test]
async fn an_alerts_write_reads_the_alerts_after_its_receipt_and_says_when_the_read_is_catching_up() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/account/notifications/product-alerts/pal_1", "watcher", "action=pause", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"<section id="product-alerts""#), "{html}");
    assert!(
        html.contains(r#"/product-alerts/pal_1" data-patch><input type="hidden" name="action" value="resume">"#),
        "pal_1 is paused now: {html}"
    );
    let calls = notice_calls(&pilot);
    assert_eq!(calls[0].path, "/api/marketplace/account/product-alerts/pal_1/pause");
    assert_eq!(waits_for(&calls[1].headers).as_deref(), Some("22"), "the read waits for the write");
    // Without a script: the settings at the alerts, with the receipt, which the read waits for.
    let (status, headers, _) =
        pilot.send(post("/account/notifications/product-alerts/pal_1", "watcher", "action=pause", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap().to_owned();
    assert!(
        to.starts_with("/account/notifications?view=settings&section=product-alerts&afterWrite=")
            && to.ends_with("#product-alerts"),
        "{to}"
    );
    let (_, _, html) = pilot.send(get(to.split('#').next().unwrap(), Some("watcher"))).await;
    assert!(html.contains(r#"autofocus"#), "the alerts' heading takes focus: {html}");
    assert!(html.contains(r#"/product-alerts/pal_1" data-patch><input type="hidden" name="action" value="resume">"#), "{html}");
    // A read that has not caught up: saved, reading again.
    let (status, headers, _) =
        pilot.send(post("/account/notifications/product-alerts/pal_lag", "watcher", "action=delete", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap().split('#').next().unwrap().to_owned();
    let (status, _, html) = pilot.send(get(&to, Some("watcher"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"role="status"><p>Saved. Your Product alerts will show the change in a moment.</p>"#), "{html}");
    assert!(html.contains("<corten-read-again") || html.contains("read-again"), "the page reads again: {html}");
    // With a script the same write answers in place, and the section asks to be read again from
    // the settings' address with the write's receipt (todd-skelton/corten#104).
    let (status, headers, html) =
        pilot.send(post("/account/notifications/product-alerts/pal_lag", "watcher", "action=delete", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(headers.contains_key("corten-patch") && !headers.contains_key("corten-location"), "{headers:?}");
    assert!(html.contains(r#"<section id="product-alerts""#), "{html}");
    assert!(html.contains(r#"role="status"><p>Saved. Your Product alerts will show the change in a moment.</p>"#), "{html}");
    let from = html
        .split(r#"<template data-corten-read-again="2" data-from=""#)
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("a read-again template")
        .replace("&amp;", "&");
    assert!(from.starts_with("/account/notifications?view=settings&section=product-alerts&afterWrite="), "{from}");
    // That address answers the section again while the read is behind, as a patch to the runtime
    // and as the page without it.
    let mut again = get(&from, Some("watcher"));
    again.headers_mut().insert("corten", "action".parse().unwrap());
    let (status, headers, html) = pilot.send(again).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.starts_with(r#"<section id="product-alerts""#) && html.contains("data-corten-read-again"), "{html}");
    let (_, headers, html) = pilot.send(get(&from, Some("watcher"))).await;
    assert!(!headers.contains_key("corten-patch") && html.contains("<!DOCTYPE html>"), "{html}");
    // Once the read is in, the section stops asking.
    let mut settled = get("/account/notifications?view=settings&section=product-alerts", Some("watcher"));
    settled.headers_mut().insert("corten", "action".parse().unwrap());
    let (_, _, html) = pilot.send(settled).await;
    assert!(html.contains(r#"/product-alerts/pal_1" data-patch>"#) && !html.contains("data-corten-read-again"), "{html}");
    // A refusal and an action that is not one: the settings, saying so, 422.
    let (status, _, html) =
        pilot.send(post("/account/notifications/product-alerts/pal_gone", "watcher", "action=delete", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains(r#"role="alert"><p>Product alert not found.</p>"#), "{html}");
    let (status, _, _) =
        pilot.send(post("/account/notifications/product-alerts/pal_1", "watcher", "action=explode", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn an_alerts_write_whose_read_fails_says_in_place_it_was_saved() {
    let pilot = Pilot::new().await;
    let unconfirmed = r#"data-tone="warning" role="alert"><p>Saved, but your Product alerts could not be read. Reload the page to see the change.</p>"#;
    // With a script, the write's own read failing: the section says so, as a 502 patch the runtime
    // applies whatever its status (todd-skelton/corten#118), and asks to be read no more.
    let (status, headers, html) =
        pilot.send(post("/account/notifications/product-alerts/pal_down", "watcher", "action=pause", true)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(headers.contains_key("corten-patch") && !headers.contains_key("corten-location"), "{headers:?}");
    assert!(html.starts_with(r#"<section id="product-alerts""#) && html.contains(unconfirmed), "{html}");
    assert!(!html.contains("data-corten-read-again"), "{html}");
    // Without a script, the settings with the receipt, whose read fails as a page (502).
    let (status, headers, _) =
        pilot.send(post("/account/notifications/product-alerts/pal_down", "watcher", "action=pause", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap().split('#').next().unwrap().to_owned();
    assert!(to.contains("afterWrite="), "{to}");
    let (status, _, html) = pilot.send(get(&to, Some("watcher"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains("<!DOCTYPE html>") && !html.contains(unconfirmed), "the page's own error: {html}");
    // The same address read again by the runtime: the section, saying it was saved.
    let mut again = get(&to, Some("watcher"));
    again.headers_mut().insert("corten", "action".parse().unwrap());
    let (status, headers, html) = pilot.send(again).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(headers.contains_key("corten-patch") && html.contains(unconfirmed), "{html}");
}

#[tokio::test]
async fn a_failed_read_is_a_banner_answered_502_and_a_visitor_signs_in() {
    let pilot = Pilot::new().await;
    for uri in ["/account/notifications", "/account/notifications?view=settings"] {
        let (status, _, html) = pilot.send(get(uri, Some("notices_down"))).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{uri}: {html}");
        assert!(text(&html).contains("Notifications could not load") && html.contains(">Try again</a>"), "{html}");
        assert!(
            !text(&html).contains("No notifications") && !html.contains(r#"role="switch""#),
            "a failed read is not an empty one: {html}"
        );
    }
    let (status, headers, _) = pilot.send(get("/account/notifications", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"].to_str().unwrap(), "http://localhost:7753/sign-in?returnTo=%2Faccount%2Fnotifications");
    assert_eq!(pilot.send(get("/account/notifications", Some("other"))).await.0, StatusCode::FORBIDDEN);
}

const PURCHASES_API: &str = "/api/marketplace/account/purchases";
const SALES_API: &str = "/api/marketplace/account/sales";

/// An order as Ordering's projection has it: `status` and the reason it cannot be cancelled.
fn order(id: &str, status: &str, unavailable: Option<&str>) -> Value {
    json!({
        "order_id": id, "display_reference": format!("ORD-{}", id[4..].to_uppercase()), "source_type": "offer-acceptance",
        "source_reference_id": "off_1", "buyer_account_id": "acc_buyer", "buyer_display_name": "Collector Zero",
        "seller_account_id": "acc_seller", "seller_display_name": "Chase Sets", "shipping_option": "standard",
        "item_subtotal_amount": "44.50", "shipping_allowance_amount": "1.77", "protection_amount": "0.45",
        "shipping_charge_amount": "12.82", "sales_tax_amount": "0.00", "total_amount": "57.32",
        "marketplace_sales_fee_amount": "3.17", "seller_item_net_amount": "41.33", "seller_payout_amount": "53.70",
        "terms_schedule_id": "ots_1", "terms_resolved_at": "2026-10-24T03:55:44.970Z",
        "shipping_destination_snapshot": {
            "name": "Synthetic Buyer", "company": null, "line1": "100 Market Street", "line2": null, "city": "Chicago",
            "state": "IL", "postalCode": "60601", "country": "US",
        },
        "status": status, "payment_deadline_at": "2026-10-24T04:55:48.540Z", "ready_for_fulfillment_at": null,
        "self_service_cancellation_available": status == "ready-for-fulfillment" && unavailable.is_none(),
        "cancellation_unavailable_reason": unavailable, "created_at": "2026-10-25T14:10:03.103Z", "total_quantity": 2,
        "item_titles": ["Twilight Masquerade Elite Trainer Box", "Pikachu"],
        "lines": [{
            "line_id": "oli_1", "item_title": "Twilight Masquerade Elite Trainer Box", "item_subtitle": "Sealed Elite Trainer Box",
            "product_summary": "Form: Raw | Condition: Near Mint", "unit_price_amount": "44.50", "quantity": 1,
            "line_total_amount": "44.50", "listing_evidence_gallery": [],
        }],
        "inventory_holds": [{ "hold_id": "hld_1", "quantity": 1, "status": "active" }],
        "money_timeline": { "refunds": [], "support_cases": [], "refunded_amount": "0.00", "currency_code": "USD" },
    })
}

/// The account's orders, as the stand-in answers them. Purchases: `ord_open` is pending payment,
/// `ord_packed` is being packed (cancelling it is refused), `ord_lost`'s cancellation fails and
/// `ord_gone` is not found. A read after
/// a cancellation at 42 has caught up (the purchase is cancelled); one at 43 has not. The sale
/// `ord_sold` has a held case and a refund.
fn ordering(method: &Method, uri: &Uri, headers: &HeaderMap) -> Option<Response> {
    let path = uri.path();
    let (side, rest) = match (path.strip_prefix(PURCHASES_API), path.strip_prefix(SALES_API)) {
        (Some(rest), _) => ("buyer", rest),
        (_, Some(rest)) => ("seller", rest),
        _ => return None,
    };
    let query: HashMap<String, String> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    if rest.is_empty() {
        let limit: u64 = query.get("limit").and_then(|l| l.parse().ok()).unwrap_or(0);
        let offset: u64 = query.get("offset").and_then(|o| o.parse().ok()).unwrap_or(0);
        let items = match side {
            "buyer" => vec![
                order("ord_open", "pending-payment", Some("payment-pending")),
                order("ord_packed", "cancelled", Some("already-cancelled")),
            ],
            _ => vec![order("ord_sold", "ready-for-fulfillment", Some("fulfillment-started"))],
        };
        let total = if side == "buyer" { 205 } else { 1 };
        let summary = json!({ "total_quantity": 7, "pending_count": 1 });
        return Some(
            Json(json!({ "items": items, "total": total, "count": 2, "limit": limit, "offset": offset, "summary": summary }))
                .into_response(),
        );
    }
    let rest = rest.strip_prefix('/')?;
    if *method == Method::POST {
        let id = rest.strip_suffix("/cancel")?;
        return Some(match id {
            // The API's answer for an order being packed (`cancelPurchase`).
            "ord_packed" => refusal(
                StatusCode::BAD_REQUEST,
                "validation_failed",
                "Purchase cancellation is now handled through support because fulfillment has started.",
            ),
            "ord_lost" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => committed(StatusCode::OK, "ordering", "42", json!({ "order_id": id, "status": "cancelled" })),
        });
    }
    let waits = waits_for(headers);
    if waits.as_deref() == Some("43") {
        return Some(refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ));
    }
    let mut detail = match rest {
        "ord_open" if waits.as_deref() == Some("42") => order(rest, "cancelled", Some("already-cancelled")),
        "ord_open" => order(rest, "pending-payment", Some("payment-pending")),
        "ord_packed" => order(rest, "ready-for-fulfillment", Some("fulfillment-started")),
        "ord_sold" => {
            let mut sold = order(rest, "ready-for-fulfillment", Some("fulfillment-started"));
            sold["money_timeline"] = json!({
                "refunds": [{ "refund_id": "rfd_1", "amount": "5.00", "currency_code": "USD", "status": "issued",
                    "requested_at": "2026-10-25T10:00:00.000Z", "issued_at": "2026-10-25T11:00:00.000Z", "failed_at": null }],
                "support_cases": [{ "support_request_id": "sup_01M5SPB8DCX26R20QVHASPF77D", "status": "open", "active_hold": true }],
                "refunded_amount": "5.00", "currency_code": "USD",
            });
            sold
        }
        _ => return Some(refusal(StatusCode::NOT_FOUND, "order_not_found", "Order not found.")),
    };
    if side == "buyer" {
        detail["delivery_summary"] =
            json!({ "shipment_count": 2, "delivered_count": 1, "latest_delivered_at": "2026-03-22 12:00:00+00" });
        detail["reviewOutcome"] = json!({ "status": "ready", "opportunity": {
            "author_role": "buyer", "active_review_id": "rev_1", "active_review_revealed_at": "2026-03-23T10:05:00.000Z",
            "submission_state": "allowed", "window_expired": false, "revealed": true,
        } });
    } else {
        detail["reviewOutcome"] = json!({ "status": "ready", "opportunity": {
            "author_role": "seller", "active_review_id": null, "active_review_revealed_at": null,
            "submission_state": "expired", "window_expired": true, "revealed": false,
        } });
    }
    Some(Json(detail).into_response())
}

/// The calls the pilot made to Ordering.
fn order_calls(pilot: &Pilot) -> Vec<Call> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with(PURCHASES_API) || c.path.starts_with(SALES_API)).cloned().collect()
}

#[tokio::test]
async fn the_orders_sign_in_and_need_their_permissions() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/account/purchases/ord_open", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"].to_str().unwrap(), "http://localhost:7753/sign-in?returnTo=%2Faccount%2Fpurchases%2Ford_open");
    // Reading needs orders.view; a sale's pages need listings.view too; cancelling orders.manage.
    let (status, _, _) = pilot.send(get("/account/purchases", Some("looker"))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = pilot.send(get("/account/sales", Some("looker"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(post("/account/purchases/ord_open/cancel", "looker", "", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/account/purchases", Some("seller"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A purchase it may read but not cancel offers no Cancel (marketplace's does, and its action
    // then refuses).
    let (status, _, html) = pilot.send(get("/account/purchases/ord_open", Some("looker"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains("/cancel\"") && !text(&html).contains("Cancel purchase"), "{html}");
    assert!(order_calls(&pilot).iter().all(|c| c.method == Method::GET), "nothing was cancelled");
}

#[tokio::test]
async fn the_purchases_are_cards_with_their_counts_and_pages_as_links() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/purchases?limit=100&offset=100", Some("shopper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("BUYER") || shown.contains("Buyer"), "{shown}");
    assert!(shown.contains("205 Purchases 7 Items 1 Pending") || shown.contains("Purchases 205 Items 7 Pending 1"), "{shown}");
    assert!(
        shown.contains(
            "Twilight Masquerade Elite Trainer Box +1 more Purchase \u{b7} Oct 25, 2026 \u{b7} ORD-OPEN pending-payment"
        ),
        "{shown}"
    );
    assert!(shown.contains("Quantity 2 Total $57.32 Open order"), "{shown}");
    assert!(!shown.contains("Seller payout"), "a buyer sees no payout: {shown}");
    assert!(html.contains(r#"href="/account/purchases/ord_open">Open order</a>"#), "{html}");
    // Page 2 of 3, as links that work without a script.
    assert!(html.contains(r#"href="/account/purchases?limit=100&amp;offset=0">Previous page</a>"#), "{html}");
    assert!(html.contains(r#"href="/account/purchases?limit=100&amp;offset=100" aria-current="page""#), "{html}");
    assert!(html.contains(r#"href="/account/purchases?limit=100&amp;offset=200">Next page</a>"#), "{html}");
    // The API is asked for the page the address names; a limit that is not a number is 100.
    let (_, _, _) = pilot.send(get("/account/purchases?limit=abc&offset=-3", Some("shopper"))).await;
    let paths: Vec<_> = order_calls(&pilot).into_iter().map(|c| c.path).collect();
    assert_eq!(paths, [format!("{PURCHASES_API}?limit=100&offset=100"), format!("{PURCHASES_API}?limit=100&offset=0")]);
}

#[tokio::test]
async fn a_sale_card_shows_the_sellers_payout_and_a_data_client_gets_the_list() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/sales", Some("merchant"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Quantity 2 Total $57.32 Seller payout $53.70 Open order"), "{}", text(&html));
    assert!(!html.contains("Previous page") && !html.contains("Next page"), "one page has no pager: {html}");
    let mut req = get("/account/sales", Some("merchant"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    let data = &screen["data"];
    assert_eq!(
        (data["side"].as_str(), data["orders"]["items"][0]["order_id"].as_str()),
        (Some("seller"), Some("ord_sold")),
        "{body}"
    );
}

#[tokio::test]
async fn a_purchase_pending_payment_can_be_paid_or_cancelled() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/purchases/ord_open", Some("shopper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Purchase ORD-OPEN Counterparty: Chase Sets Back"), "{shown}");
    assert!(
        shown.contains(
            "Source Accepted offer Support reference off_1 Counterparty Chase Sets Terms resolved Oct 24, 2026, 3:55 AM UTC"
        ),
        "{shown}"
    );
    assert!(
        shown.contains("Complete payment by deadline Complete payment by Oct 24, 2026, 4:55 AM UTC to keep this order."),
        "{shown}"
    );
    assert!(html.contains(r#"href="http://localhost:7753/account/payments/new?orderIds=ord_open">Pay now</a>"#), "{html}");
    assert!(html.contains(r#"<form method="post" action="/account/purchases/ord_open/cancel"><button type="submit""#), "{html}");
    assert!(shown.contains("Cancel purchase"), "{shown}");
    // Nothing is fulfilled before it is paid.
    assert!(!shown.contains("View fulfillment"), "{shown}");
    // The buyer's money: what they paid, none of the seller's.
    assert!(shown.contains("Item subtotal $44.50 Shipping $12.82 Tax $0.00 Purchase Summary $57.32"), "{shown}");
    assert!(!shown.contains("Seller payout") && !shown.contains("Marketplace sales fee"), "{shown}");
    assert!(shown.contains("Raw Near Mint Quantity 1 Line total 1 x $44.50 = $44.50"), "{shown}");
    assert!(shown.contains("Your account review is already active. Published Open your review"), "{shown}");
    assert!(html.contains(r#"href="http://localhost:7753/account/reviews/rev_1""#), "{html}");
    assert!(!shown.contains("Inventory Holds"), "a buyer sees no holds: {shown}");
}

#[tokio::test]
async fn cancelling_redirects_to_the_order_read_after_it_and_a_late_read_reads_again() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post("/account/purchases/ord_open/cancel", "shopper", "", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/account/purchases/ord_open?after_write="), "{to}");
    assert!(query(&to)["after_write"].contains(r#""commitPosition":"42""#), "{to}");
    let (status, _, html) = pilot.send(get(&to, Some("shopper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Status cancelled"), "{}", text(&html));
    assert!(!html.contains("/cancel\""), "a cancelled purchase has no Cancel: {html}");
    let sent = order_calls(&pilot);
    assert_eq!(sent[0].path, format!("{PURCHASES_API}/ord_open/cancel"));
    assert_eq!(waits_for(&sent[1].headers).as_deref(), Some("42"));
    // Not caught up yet: marketplace's pending words, read again in a moment.
    let (status, _, html) =
        pilot.send(get(&format!("/account/purchases/ord_open?after_write={}", receipt_at("43")), Some("shopper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains(r#"role="status">We are preparing your purchase. Refresh in a moment and it should appear.</p>"#),
        "{html}"
    );
    assert!(html.contains("data-corten-read-again"), "{html}");
}

#[tokio::test]
async fn a_cancellation_the_api_refuses_is_the_order_with_what_it_said() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/account/purchases/ord_packed/cancel", "shopper", "", false)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{html}");
    assert!(html.contains(r#"role="alert"><p class="#), "{html}");
    assert!(
        text(&html)
            .contains("Purchase issue Purchase cancellation is now handled through support because fulfillment has started."),
        "{}",
        text(&html)
    );
    // Being packed: support instead of Cancel.
    assert!(text(&html).contains("The seller has started packing. Contact support for help with this purchase."), "{html}");
    assert!(
        html.contains(
            r#"href="http://localhost:7753/account/support?orderId=ord_packed&amp;flow=buyer-cancel-request">Ask to cancel</a>"#
        ),
        "{html}"
    );
    // An answer that is not a refusal is the error page; an unknown order is not found.
    let (status, _, _) = pilot.send(post("/account/purchases/ord_lost/cancel", "shopper", "", false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let (status, _, _) = pilot.send(get("/account/purchases/ord_gone", Some("shopper"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_sale_shows_the_sellers_money_holds_and_a_cancel_that_asks_first() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/sales/ord_sold", Some("merchant"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Sale ORD-SOLD Counterparty: Collector Zero"), "{shown}");
    assert!(
        shown.contains("Item subtotal $44.50 Shipping allowance $1.77 Order protection $0.45 Marketplace sales fee $3.17 Seller item net $41.33 Seller payout $53.70 Sale Summary $57.32"),
        "{shown}"
    );
    assert!(!shown.contains("Tax $"), "a seller sees no buyer tax line: {shown}");
    assert!(shown.contains("Inventory Holds Reserved item Inventory is reserved for this order while fulfillment is prepared. Quantity 1 Status active"), "{shown}");
    assert!(shown.contains("Review window closed The feedback window for this order has closed."), "{shown}");
    // The held case and the refund outcome.
    assert!(
        shown.contains("Sale proceeds under support review $53.70 is held for this sale and released when the case closes."),
        "{shown}"
    );
    assert!(
        html.contains(r#"href="http://localhost:7753/account/support?orderId=ord_sold&amp;flow=seller-cannot-fulfill&amp;requestId=sup_01M5SPB8DCX26R20QVHASPF77D">SUP-HASPF77D</a>"#),
        "{html}"
    );
    assert!(shown.contains("Refund outcome Refunded $5.00 Retained $52.32"), "{shown}");
    assert!(html.contains(r#"href="http://localhost:7753/account/sales/shipments">View fulfillment</a>"#), "{html}");
}

#[tokio::test]
async fn a_cancellable_sale_asks_in_a_dialog_before_it_posts() {
    let pilot = Pilot::new().await;
    // A sale the seller may still cancel: the stand-in's purchase, read as a sale.
    let (status, _, html) = pilot.send(get("/account/sales/ord_open", Some("merchant"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"command="show-modal" commandfor="cancel-dialog""#), "{html}");
    assert!(html.contains(r#"<dialog id="cancel-dialog""#), "{html}");
    assert!(text(&html).contains("Cancel this sale? The buyer will receive a full refund"), "{}", text(&html));
    assert!(html.contains(r#"action="/account/sales/ord_open/cancel""#), "{html}");
    let (status, headers, _) = pilot.send(post("/account/sales/ord_open/cancel", "merchant", "", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers["location"].to_str().unwrap().starts_with("/account/sales/ord_open?after_write="));
}

const BUYER_SHIPMENTS: &str = "/api/marketplace/account/shipments";
const SELLER_SHIPMENTS: &str = "/api/marketplace/account/sales/shipments";

/// A shipment as Fulfillment's reads send it: delivered with its tracking, or awaiting its package.
fn shipment(id: &str, status: &str, tracking: Option<&str>) -> Value {
    json!({
        "shipment_id": id, "order_id": "ord_01M5P0SQE5TQGRJCTMD116ACF7", "display_reference": id,
        "buyer_account_id": "acc_buyer", "buyer_display_name": "Collector Zero",
        "seller_account_id": "acc_seller", "seller_display_name": "Chase Sets",
        "status": status, "package_status": "packed", "package_count": 1,
        "tracking_identifier": tracking, "carrier_name": tracking.map(|_| "UPS"),
        "shipping_option": "standard", "shipping_method": "standard", "postage_service_level": null,
        "postage_provider_name": null, "postage_provider_mode": null,
        "postage_amount_cents": 599, "postage_currency": "USD",
        "label_status": "purchased", "label_reference": "lbl_1", "label_document_url": null,
        "label_error_code": null, "label_error_message": null, "label_refund_status": null, "label_refund_reference": null,
        "delivered_at": (status == "delivered").then_some("2026-03-22T12:00:00.000Z"),
        "shipping_plan_snapshot": {}, "line_count": 2, "total_quantity": 2, "conflicts": [],
        "lines": [
            { "line_id": "spl_1", "item_title": "Twilight Masquerade Elite Trainer Box", "item_subtitle": "Sealed Elite Trainer Box",
              "product_summary": null, "quantity": 1 },
            { "line_id": "spl_2", "item_title": "Charizard", "item_subtitle": null, "product_summary": "Raw / Near Mint", "quantity": 1 },
        ],
        "exceptions": [], "postage_label_operations": [], "postage_provider_events": [],
    })
}

/// The stand-in Fulfillment API: the buyer's and seller's shipments, `shp_gone` unknown and
/// `shp_down` failing.
fn fulfillment(method: &Method, uri: &Uri) -> Option<Response> {
    let path = uri.path();
    let (seller, rest) = match (path.strip_prefix(SELLER_SHIPMENTS), path.strip_prefix(BUYER_SHIPMENTS)) {
        (Some(rest), _) => (true, rest),
        (_, Some(rest)) => (false, rest),
        _ => return None,
    };
    if *method != Method::GET {
        return Some(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    if rest.is_empty() {
        let items = [shipment("shp_done", "delivered", Some("1ZDONE")), shipment("SHP-TEE49CFY", "awaiting-package", None)];
        return Some(Json(json!({ "items": items, "total": 2, "count": 2 })).into_response());
    }
    let mut detail = match rest.strip_prefix('/')? {
        "shp_gone" => return Some(refusal(StatusCode::NOT_FOUND, "shipment_not_found", "Shipment not found.")),
        "shp_down" => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        "shp_done" => shipment("shp_done", "delivered", Some("1ZDONE")),
        _ => return Some(refusal(StatusCode::NOT_FOUND, "shipment_not_found", "Shipment not found.")),
    };
    if seller {
        detail["label_status"] = json!("failed");
        detail["label_error_code"] = json!("rate_unavailable");
        detail["label_error_message"] = json!("No rate for this package.");
        detail["label_refund_status"] = json!("requested");
        detail["label_refund_reference"] = json!("rfd_9");
        detail["shipping_plan_snapshot"] = json!({ "postagePolicySnapshot": {
            "policyVersion": "default-postage-policy-v2", "parcelRequired": true,
            "parcelReasons": ["too-heavy-for-letter"], "signatureRequired": false, "signatureReasons": [],
            "insuranceRequired": false, "insuranceReasons": [], "insuredValueAmount": null, "shippingEvidenceTier": "tracked-parcel",
        } });
        detail["postage_label_operations"] = json!([{
            "operation_key": "op_1", "operation_kind": "purchase", "status": "failed",
            "requested_service_level": "USPS_GROUND_ADVANTAGE", "requested_delivery_confirmation": null,
            "requested_insurance_amount": null, "requested_mailpiece_class": "parcel", "policy_version": "default-postage-policy-v2",
            "parcel_required": "true", "signature_required": "false", "insurance_required": null, "insured_value_amount": null,
            "shipping_evidence_tier": "tracked-parcel", "address_override_changed_side": "recipient",
            "address_override_reason": "Buyer asked for suite", "error_message": "Rate unavailable.",
        }]);
        detail["postage_provider_events"] = json!([{
            "provider_event_id": "evt_1", "provider_name": "easypost", "provider_mode": "test", "event_kind": "tracker.updated",
            "status": "in_transit", "tracking_identifier": "1ZDONE", "processing_result": "applied", "status_detail": null,
        }]);
        detail["exceptions"] =
            json!([{ "raised_at": "2026-03-21T09:00:00.000Z", "exception_type": "carrier-delay", "notes": "Missed scan." }]);
    }
    Some(Json(detail).into_response())
}

/// The calls the pilot made to Fulfillment.
fn shipment_calls(pilot: &Pilot) -> Vec<Call> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with(BUYER_SHIPMENTS) || c.path.starts_with(SELLER_SHIPMENTS)).cloned().collect()
}

#[tokio::test]
async fn the_shipments_sign_in_and_need_fulfillment_view() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/account/shipments/shp_done", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"].to_str().unwrap(), "http://localhost:7753/sign-in?returnTo=%2Faccount%2Fshipments%2Fshp_done");
    for page in ["/account/shipments", "/account/sales/shipments/shp_done"] {
        let (status, _, _) = pilot.send(get(page, Some("seller"))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{page}: an account without fulfillment.view");
    }
    assert!(shipment_calls(&pilot).is_empty(), "nothing is read for who may not see it");
}

#[tokio::test]
async fn the_buyers_shipments_are_cards_with_tracking_or_their_reference() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/shipments", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Shipments Track the post-payment shipping workflow"), "{shown}");
    assert!(shown.contains("Tracking 1ZDONE delivered Quantity: 2 across 2 lines Open shipment"), "{shown}");
    assert!(
        shown.contains(
            "Shipment SHP-TEE49CFY awaiting-package Quantity: 2 across 2 lines Tracking: Not attached yet Open shipment"
        ),
        "{shown}"
    );
    assert!(html.contains(r#"href="/account/shipments/shp_done">Open shipment</a>"#), "{html}");
    let paths: Vec<_> = shipment_calls(&pilot).into_iter().map(|c| c.path).collect();
    assert_eq!(paths, [format!("{BUYER_SHIPMENTS}?limit=100&offset=0")], "the first 100, as marketplace reads them");
    // A data client gets the list.
    let mut req = get("/account/shipments", Some("shipper"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["shipments"]["items"][1]["status"], "awaiting-package", "{body}");
}

#[tokio::test]
async fn a_buyers_shipment_shows_its_progress_facts_cover_lines_and_exceptions() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/shipments/shp_done", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Buyer Shipment shp_done Order ORD-D116ACF7 with Chase Sets Back"), "{shown}");
    assert!(shown.contains("delivered Package state: packed Tracking: 1ZDONE Carrier: UPS"), "{shown}");
    assert!(shown.contains("Delivered at Mar 22, 2026, 12:00 PM UTC Shipping option: standard"), "{shown}");
    assert!(shown.contains("Label reference lbl_1 Postage provider: Not selected yet Package count: 1"), "{shown}");
    assert!(shown.contains("Tracking: 1ZDONE Label status: purchased Postage: $5.99"), "{shown}");
    assert!(shown.contains("Twilight Masquerade Elite Trainer Box Sealed Elite Trainer Box Standard Quantity: 1"), "{shown}");
    assert!(shown.contains("Charizard Raw Near Mint Quantity: 1"), "{shown}");
    assert!(shown.contains("Exceptions No shipment exceptions recorded."), "{shown}");
    assert!(html.contains(r#"href="/account/shipments">Back</a>"#), "{html}");
    for seller_only in ["Print packing slip", "Postage diagnostics", "Actions"] {
        assert!(!shown.contains(seller_only), "a buyer sees no {seller_only}: {shown}");
    }
    assert!(html.contains(r#"data-state="complete""#), "{html}");
}

#[tokio::test]
async fn a_sale_shipment_shows_the_postage_diagnostics_and_sends_its_actions_to_marketplace() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/sales/shipments/shp_done", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Seller Shipment shp_done Order ORD-D116ACF7 with Collector Zero Print packing slip Back"), "{shown}");
    assert!(
        html.contains(
            r#"href="http://localhost:7753/account/sales/shipments/packing-slips?shipmentIds=shp_done&amp;format=letter" target="_blank""#
        ),
        "{html}"
    );
    assert!(html.contains(r#"href="http://localhost:7753/account/sales/shipments">Back</a>"#), "{html}");
    assert!(!shown.contains("Delivered at"), "the seller's facts have no delivery time, as marketplace's: {shown}");
    // The order's postage policy, then the diagnostics.
    assert!(shown.contains("Postage policy Committed requirements from the order package plan snapshot. Policy version default-postage-policy-v2 Parcel required Required Parcel reasons too-heavy-for-letter"), "{shown}");
    assert!(shown.contains("Label status: No rate for this package."), "{shown}");
    assert!(shown.contains("Refund: requested (rfd_9)"), "{shown}");
    assert!(
        shown.contains(
            "Postage diagnostics Postage diagnostics Buyer shipping option standard Policy version default-postage-policy-v2"
        ),
        "{shown}"
    );
    assert!(shown.contains("Label status: failed (rate_unavailable) Provider outcome Not selected yet"), "{shown}");
    assert!(
        shown.contains("purchase / failed op_1 USPS service USPS_GROUND_ADVANTAGE Delivery confirmation Not recorded yet"),
        "{shown}"
    );
    assert!(
        shown.contains("Parcel required Required Signature required Not required Insurance required Not recorded yet"),
        "{shown}"
    );
    assert!(shown.contains("Address override: recipient: Buyer asked for suite Label status: Rate unavailable."), "{shown}");
    assert!(
        shown.contains("Provider events tracker.updated / in_transit Postage provider: easypost / test Tracking: 1ZDONE"),
        "{shown}"
    );
    assert!(shown.contains("carrier-delay Raised at 2026-03-21T09:00:00.000Z Missed scan."), "{shown}");
    assert!(html.contains(r#"href="http://localhost:7753/account/sales/shipments/shp_done">Open on marketplace</a>"#), "{html}");
}

#[tokio::test]
async fn an_unknown_shipment_is_not_found_a_failed_read_a_bad_gateway_and_the_command_center_is_marketplaces() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/account/shipments/shp_gone", Some("shipper"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = pilot.send(get("/account/sales/shipments/shp_down", Some("shipper"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    // The seller's list is marketplace's (chase-sets/chase-sets#10638), not a sale named "shipments".
    let (status, headers, _) = pilot.send(get("/account/sales/shipments", Some("shipper"))).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"], "http://localhost:7753/account/sales/shipments");
    assert!(
        order_calls(&pilot).iter().all(|c| c.path.starts_with(SELLER_SHIPMENTS)),
        "Ordering is not asked for a sale called shipments"
    );
}

#[tokio::test]
async fn an_orders_view_fulfillment_opens_the_buyers_shipments_here_and_the_sellers_on_marketplace() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/account/purchases/ord_packed", Some("shopper"))).await;
    assert!(html.contains(r#"href="/account/shipments">View fulfillment</a>"#), "{html}");
    let (_, _, html) = pilot.send(get("/account/sales/ord_sold", Some("merchant"))).await;
    assert!(html.contains(r#"href="http://localhost:7753/account/sales/shipments">View fulfillment</a>"#), "{html}");
}

/// Packing attempts the stand-in knows: one the API applied before (a repeat is refused, and
/// mutation-recovery says it succeeded), one it holds no record of, and one whose check fails.
const APPLIED_BEFORE: &str = "22222222-2222-4222-8222-222222222222";
const NO_RECORD: &str = "33333333-3333-4333-8333-333333333333";
const CHECK_DOWN: &str = "44444444-4444-4444-8444-444444444444";

/// A shipment the seller packs: `shp_wait` awaits its package, `shp_pack` is packing with 2 of 3
/// packed, `shp_full` is packing with all 3. Charizard's line holds 2.
fn packing_shipment(id: &str) -> Option<Value> {
    let (status, packed) = match id {
        "shp_wait" => ("awaiting-package", [None, None]),
        "shp_pack" => ("packing", [Some(1), Some(1)]),
        "shp_full" => ("packing", [Some(1), Some(2)]),
        _ => return None,
    };
    let mut detail = shipment(id, status, None);
    detail["package_status"] = json!("unpacked");
    detail["total_quantity"] = json!(3);
    detail["updated_at"] = json!("2026-10-24T15:00:00.000Z");
    detail["packing_started_at"] = if status == "packing" { json!("2026-10-24T15:00:00.000Z") } else { Value::Null };
    detail["shipping_destination_snapshot"] = json!({
        "name": "Collector Zero", "line1": "1 Test Way", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "US",
    });
    detail["lines"][0]["order_line_id"] = json!("orl_01ETB0000001");
    detail["lines"][0]["product_id"] = json!("cat_etb::sealed");
    detail["lines"][1]["order_line_id"] = json!("orl_01CHARIZARD2");
    detail["lines"][1]["product_id"] = json!("cat_charizard::raw-nm");
    detail["lines"][1]["quantity"] = json!(2);
    for (line, packed) in packed.into_iter().enumerate() {
        detail["lines"][line]["packing_confirmed_quantity"] = json!(packed);
    }
    Some(detail)
}

/// The stand-in Fulfillment packing API for those shipments: reads (one that waits for position 44
/// is still catching up), start, a line's count, pack and mutation-recovery. A rule the API keeps
/// is a 400 `validation_failed` with its words.
fn packing(method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    let rest = path.strip_prefix(SELLER_SHIPMENTS)?.strip_prefix('/')?;
    let (id, command) = rest.split_once('/').unwrap_or((rest, ""));
    let detail = packing_shipment(id)?;
    let attempt = headers.get("idempotency-key").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let rule = |message: &str| Some(refusal(StatusCode::BAD_REQUEST, "validation_failed", message));
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    match (method.as_str(), command) {
        ("GET", "") if waits_for(headers).as_deref() == Some("44") => Some(refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        )),
        ("GET", "") => Some(Json(detail).into_response()),
        ("GET", "mutation-recovery") => Some(match attempt {
            APPLIED_BEFORE => Json(json!({ "status": "succeeded", "commandKind": "start-packing" })).into_response(),
            NO_RECORD => Json(json!({ "status": "confirming" })).into_response(),
            CHECK_DOWN => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => Json(json!({ "status": "failed-safe" })).into_response(),
        }),
        ("POST", _) if attempt == APPLIED_BEFORE => rule("This request was already processed with a different body."),
        ("POST", "packing/start") if detail["status"] == "awaiting-package" => Some(written(StatusCode::OK, id)),
        ("POST", "packing/start") => rule("Packing can only start while the shipment is awaiting its package."),
        ("POST", line) if line.starts_with("packing/lines/") => {
            let line = line.trim_start_matches("packing/lines/");
            let found = detail["lines"].as_array()?.iter().find(|l| l["line_id"] == line)?.clone();
            match sent["confirmedQuantity"].as_u64() {
                _ if detail["status"] != "packing" => rule("Lines can only be confirmed while packing."),
                Some(n) if n <= found["quantity"].as_u64()? => Some(written(StatusCode::OK, id)),
                _ => rule("Confirmed quantity cannot exceed the line quantity."),
            }
        }
        ("POST", "pack") if id == "shp_full" => Some(written(StatusCode::OK, id)),
        ("POST", "pack") => rule("Every line must be confirmed before packing completes."),
        _ => Some(StatusCode::METHOD_NOT_ALLOWED.into_response()),
    }
}

/// The packing writes the pilot sent: their path, attempt and body.
fn packing_writes(pilot: &Pilot) -> Vec<(String, String, String)> {
    shipment_calls(pilot)
        .into_iter()
        .filter(|c| c.method == Method::POST)
        .map(|c| {
            let attempt = c.headers.get("idempotency-key").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
            (c.path.trim_start_matches(SELLER_SHIPMENTS).to_owned(), attempt, c.body)
        })
        .collect()
}

#[tokio::test]
async fn packing_needs_fulfillment_manage_to_write_and_view_to_see() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/account/sales/shipments/shp_pack/packing", Some("seller"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an account without fulfillment.view");
    let (status, _, html) = pilot.send(get("/account/sales/shipments/shp_pack/packing", Some("tracker"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (status, _, _) = pilot
        .send(post("/account/sales/shipments/shp_wait/packing/start", "tracker", &format!("attempt={ATTEMPT}"), false))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a write needs fulfillment.manage");
    assert!(packing_writes(&pilot).is_empty(), "nothing is sent for who may not pack");
}

#[tokio::test]
async fn an_awaiting_shipment_starts_packing_and_the_packing_page_reads_after_the_write() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/sales/shipments/shp_wait", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"action="/account/sales/shipments/shp_wait/packing/start""#), "{html}");
    assert!(html.contains(ATTEMPT_INPUT), "the form carries an attempt: {html}");
    assert!(text(&html).contains("Start packing"), "{}", text(&html));
    let (status, _, html) = pilot.send(get("/account/sales/shipments/shp_pack", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"href="/account/sales/shipments/shp_pack/packing">Resume packing</a>"#), "{html}");

    let (status, headers, _) = pilot
        .send(post("/account/sales/shipments/shp_wait/packing/start", "shipper", &format!("attempt={ATTEMPT}"), false))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("/account/sales/shipments/shp_wait/packing?"), "{to}");
    let place = query(to);
    assert_eq!(place["done"], ATTEMPT, "the page settles the attempt");
    assert!(place["after_write"].contains("\"commitPosition\":\"42\""), "read after the write: {to}");
    assert_eq!(packing_writes(&pilot), [("/shp_wait/packing/start".to_owned(), ATTEMPT.to_owned(), "{}".to_owned())]);
}

#[tokio::test]
async fn the_packing_page_shows_the_lock_progress_lines_and_finish_only_once_every_line_is_packed() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/sales/shipments/shp_pack/packing", Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Seller Pack shipment Order ORD-D116ACF7 for Collector Zero."), "{shown}");
    assert!(shown.contains("Order changes locked while packing Started 10/24/2026, 3:00 PM UTC."), "{shown}");
    assert!(shown.contains("2 of 3 items packed 67%"), "{shown}");
    assert!(shown.contains("Charizard Raw Near Mint ×2 1 of 2 packed"), "{shown}");
    assert!(shown.contains("Check every line before recording the package as packed."), "{shown}");
    assert!(html.contains(r#"<progress class="#) && html.contains(r#"value="67""#), "{html}");
    assert!(html.contains(r#"action="/account/sales/shipments/shp_pack/packing/lines/spl_2""#), "{html}");
    assert!(html.contains(r#"action="/account/sales/shipments/shp_pack/pack""#), "{html}");
    let finish = html.find("Finish packing").unwrap();
    assert!(html[..finish].rfind("<button").is_some_and(|at| html[at..finish].contains("disabled")), "Finish is off: {html}");
    assert!(shown.contains("Ship to Collector Zero 1 Test Way Austin, TX 78701 US"), "{shown}");
    // The pilot's own address, which redirects to marketplace's command center.
    assert!(html.contains(r#"href="/account/sales/shipments">Back to shipments</a>"#), "{html}");

    let (_, _, html) = pilot.send(get("/account/sales/shipments/shp_full/packing", Some("shipper"))).await;
    let shown = text(&html);
    assert!(shown.contains("3 of 3 items packed 100%"), "{shown}");
    assert!(shown.contains("All lines checked. Record the package when it is sealed."), "{shown}");
    let finish = html.find("Finish packing").unwrap();
    assert!(html[..finish].rfind("<button").is_some_and(|at| !html[at..finish].contains("disabled")), "Finish is on: {html}");

    let (_, _, html) = pilot.send(get("/account/sales/shipments/shp_wait/packing", Some("shipper"))).await;
    let shown = text(&html);
    assert!(shown.contains("Ready to start"), "{shown}");
    assert!(!html.contains(r#"action="/account/sales/shipments/shp_wait/pack""#), "no Finish before packing starts");
}

#[tokio::test]
async fn a_line_write_with_the_script_replaces_the_line_progress_and_finish_and_without_it_loads_the_page() {
    let pilot = Pilot::new().await;
    let line = "/account/sales/shipments/shp_pack/packing/lines/spl_2";
    let (status, _, patch) = pilot.send(post(line, "shipper", &format!("attempt={ATTEMPT}&quantity=2"), true)).await;
    assert_eq!(status, StatusCode::OK, "{patch}");
    assert!(!patch.contains("<html"), "a patch, not a page: {patch}");
    assert!(text(&patch).contains("Saved"), "{}", text(&patch));
    for part in ["packing-status", "packing-scan", "packing-progress", "packing-footer"] {
        assert!(patch.contains(&format!(r#"id="{part}""#)), "{part}: {patch}");
    }
    assert_eq!(packing_writes(&pilot)[0].2, r#"{"confirmedQuantity":2}"#);

    let (status, headers, _) = pilot.send(post(line, "shipper", &format!("attempt={ATTEMPT}&quantity=0"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("/account/sales/shipments/shp_pack/packing?"), "{to}");
    assert!(to.ends_with("#packing-line-spl_2"), "back to the line: {to}");
    assert_eq!(query(to.split('#').next().unwrap())["line"], "spl_2");
}

#[tokio::test]
async fn a_refused_line_says_why_in_place_and_a_count_that_is_not_a_number_is_not_sent() {
    let pilot = Pilot::new().await;
    let line = "/account/sales/shipments/shp_pack/packing/lines/spl_2";
    let (status, _, patch) = pilot.send(post(line, "shipper", &format!("attempt={ATTEMPT}&quantity=3"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{patch}");
    assert!(text(&patch).contains("Confirmed quantity cannot exceed the line quantity."), "{}", text(&patch));
    assert!(
        shipment_calls(&pilot).iter().any(|c| c.path.ends_with("/mutation-recovery")),
        "a refusal asks what came of the attempt"
    );
    let (status, _, html) = pilot.send(post(line, "shipper", &format!("attempt={ATTEMPT}&quantity=two"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Enter how many of this line are packed as a whole number."), "{}", text(&html));
    assert_eq!(packing_writes(&pilot).len(), 1, "only the first was sent");
}

#[tokio::test]
async fn a_start_the_api_applied_before_reads_as_applied_and_a_refused_one_says_so() {
    let pilot = Pilot::new().await;
    let start = "/account/sales/shipments/shp_pack/packing/start";
    let (status, headers, _) = pilot.send(post(start, "shipper", &format!("attempt={APPLIED_BEFORE}"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(query(headers["location"].to_str().unwrap())["done"], APPLIED_BEFORE);
    let (status, _, html) = pilot.send(post(start, "shipper", &format!("attempt={ATTEMPT}"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let shown = text(&html);
    assert!(
        shown.contains("Packing could not be updated Packing can only start while the shipment is awaiting its package."),
        "{shown}"
    );
    // Refused, and the API cannot say what came of the attempt: the page says so, with the writes off.
    // The page that asks about it (`a_write_the_page_cannot_confirm_turns_the_writes_off..`).
    let to = format!("/account/sales/shipments/shp_pack/packing?check={CHECK_DOWN}");
    let (status, headers, _) = pilot.send(post(start, "shipper", &format!("attempt={CHECK_DOWN}"), false)).await;
    assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, to.as_str()));
    let (status, headers, _) = pilot.send(post(start, "shipper", &format!("attempt={CHECK_DOWN}"), true)).await;
    assert_eq!((status, headers["corten-location"].to_str().unwrap()), (StatusCode::NO_CONTENT, to.as_str()));
}

#[tokio::test]
async fn a_scan_packs_one_more_of_the_line_it_names_or_says_what_it_found() {
    let pilot = Pilot::new().await;
    let scan = "/account/sales/shipments/shp_pack/packing/scan";
    let (status, _, patch) =
        pilot.send(post(scan, "shipper", &format!("attempt={ATTEMPT}&code=charizard&after_write="), true)).await;
    assert_eq!(status, StatusCode::OK, "{patch}");
    assert!(text(&patch).contains("Added one packed item for Charizard."), "{}", text(&patch));
    assert_eq!(
        packing_writes(&pilot),
        [("/shp_pack/packing/lines/spl_2".to_owned(), ATTEMPT.to_owned(), r#"{"confirmedQuantity":2}"#.to_owned())]
    );

    let (_, _, patch) = pilot.send(post(scan, "shipper", &format!("attempt={ATTEMPT}&code=arizard2&after_write="), true)).await;
    assert!(text(&patch).contains("Added one packed item"), "a reference's short form: {}", text(&patch));
    let (_, _, patch) = pilot.send(post(scan, "shipper", &format!("attempt={ATTEMPT}&code=pikachu&after_write="), true)).await;
    assert!(text(&patch).contains("No packing line matched that scan."), "{}", text(&patch));
    let (_, _, patch) = pilot.send(post(scan, "shipper", &format!("attempt={ATTEMPT}&code=cat_&after_write="), true)).await;
    assert!(text(&patch).contains("No packing line matched"), "a part of a reference is not a match: {}", text(&patch));
    let full = "/account/sales/shipments/shp_full/packing/scan";
    let (_, _, patch) = pilot.send(post(full, "shipper", &format!("attempt={ATTEMPT}&code=charizard&after_write="), true)).await;
    assert!(text(&patch).contains("Charizard is already fully packed."), "{}", text(&patch));
    let (status, headers, _) =
        pilot.send(post(full, "shipper", &format!("attempt={ATTEMPT}&code=pikachu&after_write="), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(query(headers["location"].to_str().unwrap())["scan"], "none", "the page says what the scan found");
    assert_eq!(packing_writes(&pilot).len(), 2, "a scan that matches nothing to pack sends nothing");
}

#[tokio::test]
async fn finish_records_the_package_then_the_shipment_page_reads_after_it() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post("/account/sales/shipments/shp_full/pack", "shipper", &format!("attempt={ATTEMPT}&package_count=2"), false))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("/account/sales/shipments/shp_full?after_write="), "{to}");
    assert_eq!(packing_writes(&pilot), [("/shp_full/pack".to_owned(), ATTEMPT.to_owned(), r#"{"packageCount":2}"#.to_owned())]);

    let (status, _, html) = pilot
        .send(post("/account/sales/shipments/shp_pack/pack", "shipper", &format!("attempt={ATTEMPT}&package_count=1"), false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Every line must be confirmed before packing completes."), "{}", text(&html));
    let (status, _, html) = pilot
        .send(post("/account/sales/shipments/shp_full/pack", "shipper", &format!("attempt={ATTEMPT}&package_count=0"), false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Enter a package count of 1 or more."), "{}", text(&html));
    assert_eq!(packing_writes(&pilot).len(), 2, "a package count under 1 is not sent");
}

#[tokio::test]
async fn a_write_the_page_cannot_confirm_turns_the_writes_off_until_the_api_can_say() {
    let pilot = Pilot::new().await;
    let page = "/account/sales/shipments/shp_pack/packing";
    for attempt in [NO_RECORD, CHECK_DOWN, "not-a-uuid"] {
        let (status, _, html) = pilot.send(get(&format!("{page}?check={attempt}"), Some("shipper"))).await;
        assert_eq!(status, StatusCode::OK, "{html}");
        assert!(text(&html).contains("We could not confirm your last packing change"), "{attempt}: {}", text(&html));
        let fieldsets: Vec<_> =
            html.match_indices("<fieldset").map(|(at, _)| &html[at..at + html[at..].find('>').unwrap()]).collect();
        assert!(fieldsets.len() >= 3, "{attempt}: {html}");
        assert!(fieldsets.iter().all(|f| f.contains("disabled")), "{attempt}: every write is off: {fieldsets:?}");
        assert!(html.contains(&format!(r#"href="{page}?check={attempt}">Check again</a>"#)), "{html}");
    }
    let (_, _, html) = pilot.send(get(&format!("{page}?check={APPLIED_BEFORE}"), Some("shipper"))).await;
    assert!(!text(&html).contains("We could not confirm"), "{}", text(&html));
    assert!(html.contains(APPLIED_BEFORE), "the page tells the browser it settles the attempt: {html}");
}

#[tokio::test]
async fn a_packing_page_not_caught_up_with_its_write_reads_itself_again() {
    let pilot = Pilot::new().await;
    let page = format!("/account/sales/shipments/shp_pack/packing?after_write={}", receipt_at("44"));
    let (status, _, html) = pilot.send(get(&page, Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Shipment update in progress"), "{}", text(&html));
    assert!(html.contains("data-corten-read-again=\"2\""), "{html}");
    let page = format!("/account/sales/shipments/shp_pack?after_write={}", receipt_at("44"));
    let (status, _, html) = pilot.send(get(&page, Some("shipper"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("data-corten-read-again=\"2\""), "the shipment's page too: {html}");
}

const BOOK: &str = "/api/identity/accounts/acc_seller/shipping-addresses";
const ADDRESSES: &str = "/account/shipping-addresses";

fn shipping_address(id: &str, label: &str, default: bool) -> Value {
    json!({
        "shipping_address_id": id, "account_id": "acc_seller", "label": label, "recipient_name": "Synthetic Collector",
        "company": null, "line1": "1 Test Way", "line2": null, "city": "Austin", "state": "TX", "postal_code": "78701",
        "country": "US", "phone": null, "email": null, "is_default": default, "is_archived": false,
    })
}

/// An Identity attempt's committed answer, with a receipt at 42.
fn address_committed(id: &str) -> Response {
    let body = json!({
        "outcome": "committed", "newlyCommitted": true, "current": { "id": id, "version": 2, "status": "active" },
        "destination": "/account/shipping-addresses",
    });
    committed(StatusCode::OK, "identity", "42", body)
}

/// The stand-in Identity address book of `acc_seller`: Home (the default) and Work. A read that
/// waits for 45 is still catching up. A write's attempt decides an answer it cannot get otherwise:
/// `NO_RECORD`, `APPLIED_BEFORE` and `CHECK_DOWN` are answered `indeterminate`, and the lookup
/// then says nothing was recorded, that it was (with the receipt in `destination`), or cannot say.
/// A create without a city is refused for it, `1 Suggest Way` is answered with a suggestion until a
/// choice is sent, `0 Nowhere` is undeliverable; making `adr_gone` the default is a conflict.
fn identity(method: &Method, uri: &Uri, headers: &HeaderMap, body: &str) -> Option<Response> {
    let path = uri.path();
    let attempt = headers.get("idempotency-key").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let indeterminate = || {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "outcome": "indeterminate", "code": "INDETERMINATE" }))).into_response()
    };
    if path == "/api/identity/account-management/attempts" {
        return Some(match attempt {
            APPLIED_BEFORE => {
                let receipt = receipt_at("42");
                Json(json!({ "outcome": "committed", "newlyCommitted": false, "destination": format!("/account/shipping-addresses?afterWrite={}", receipt.replace('%', "%25")) })).into_response()
            }
            CHECK_DOWN => Json(json!({ "outcome": "indeterminate", "code": "INDETERMINATE" })).into_response(),
            _ => Json(json!({ "outcome": "not-recorded", "code": "not-recorded" })).into_response(),
        });
    }
    let rest = path.strip_prefix(BOOK)?;
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    match (method.as_str(), rest) {
        ("GET", "") if waits_for(headers).as_deref() == Some("45") => Some(refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        )),
        ("GET", "") => {
            let items = [shipping_address("adr_home", "Home", true), shipping_address("adr_work", "Work", false)];
            Some(Json(json!({ "items": items, "total": 2, "count": 2 })).into_response())
        }
        _ if matches!(attempt, NO_RECORD | APPLIED_BEFORE | CHECK_DOWN) => Some(indeterminate()),
        ("POST", "") if sent["city"] == "" => {
            let message = "City is required.";
            Some((StatusCode::BAD_REQUEST, Json(json!({ "error": { "code": "validation_failed", "message": message, "details": [{ "field": "city", "code": "required", "message": message }] } }))).into_response())
        }
        ("POST", "") if sent["line1"] == "1 Suggest Way" && sent["addressVerificationDecision"].is_null() => Some(
            (StatusCode::BAD_REQUEST, Json(json!({ "outcome": "not-recorded", "code": "address-standardization-suggested", "suggestedAddress": {
                "name": "Synthetic Collector", "company": null, "line1": "1 SUGGEST WAY", "line2": null, "city": "AUSTIN", "state": "TX",
                "postalCode": "78701-0001", "country": "US", "phone": null, "email": null,
            } })))
                .into_response(),
        ),
        ("POST", "") if sent["line1"] == "0 Nowhere" => Some(
            (StatusCode::BAD_REQUEST, Json(json!({ "outcome": "not-recorded", "code": "shipping-address-undeliverable" }))).into_response(),
        ),
        ("POST", "") => Some(address_committed("adr_new")),
        ("POST", "/adr_gone/default") => Some(
            (StatusCode::CONFLICT, Json(json!({ "outcome": "conflict", "code": "owner-state-conflict", "current": { "id": "adr_gone", "version": 3, "status": "archived" } })))
                .into_response(),
        ),
        ("POST" | "PUT", id) => Some(address_committed(id.trim_start_matches('/').split('/').next().unwrap_or_default())),
        _ => Some(StatusCode::METHOD_NOT_ALLOWED.into_response()),
    }
}

/// The address writes the pilot sent: method, path under the book, attempt and body.
fn address_writes(pilot: &Pilot) -> Vec<(Method, String, String, Value)> {
    pilot
        .stand
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.path.starts_with(BOOK) && c.method != Method::GET)
        .map(|c| {
            let attempt = c.headers.get("idempotency-key").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
            (
                c.method.clone(),
                c.path.trim_start_matches(BOOK).to_owned(),
                attempt,
                serde_json::from_str(&c.body).unwrap_or_default(),
            )
        })
        .collect()
}

/// An add form's body with every field, at `line1` and `city`.
fn address_body(attempt: &str, line1: &str, city: &str) -> String {
    format!(
        "attempt={attempt}&label=Office&name=Synthetic+Collector&company=&country=US&line1={}&line2=&city={city}&state=TX\
         &postal_code=78701&phone=&email=&make_default=true",
        line1.replace(' ', "+")
    )
}

#[tokio::test]
async fn shipping_addresses_need_accounts_view_to_see_and_accounts_manage_to_change() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get(ADDRESSES, Some("buyer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an account without accounts.view");
    let (status, headers, _) = pilot.send(get(ADDRESSES, None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "a visitor signs in");
    assert!(headers["location"].to_str().unwrap().ends_with("/sign-in?returnTo=%2Faccount%2Fshipping-addresses"));
    let (status, _, html) = pilot.send(get(ADDRESSES, Some("watcher"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (status, _, _) = pilot.send(post(ADDRESSES, "watcher", &address_body(ATTEMPT, "1 Test Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a write needs accounts.manage");
    assert!(address_writes(&pilot).is_empty(), "nothing is sent for who may not write");
}

#[tokio::test]
async fn the_addresses_page_shows_each_address_with_its_actions() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(ADDRESSES, Some("addresser"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Account Shipping Addresses Manage reusable recipient destinations for faster checkout."), "{shown}");
    assert!(shown.contains("Home Default Synthetic Collector 1 Test Way Austin, TX 78701 US"), "{shown}");
    assert!(html.contains(r#"href="http://localhost:7753/account">Back to account</a>"#), "{html}");
    assert!(html.contains(r#"action="/account/shipping-addresses/adr_work/default""#), "Work may be made the default");
    assert!(!html.contains(r#"action="/account/shipping-addresses/adr_home/default""#), "Home is the default already");
    assert!(html.contains(r#"action="/account/shipping-addresses/adr_home/archive""#), "{html}");
    assert!(html.contains(r#"action="/account/shipping-addresses/adr_work""#), "Work's update form");
    assert!(html.contains(r#"command="show-modal""#) && html.contains("<dialog"), "{html}");
    assert!(html.contains(r#"autocomplete="postal-code""#), "{html}");
    assert_eq!(html.matches(ATTEMPT_INPUT).count(), 6, "every write form carries an attempt: {html}");
}

#[tokio::test]
async fn an_added_address_is_read_after_its_write_and_the_page_says_it_was_saved() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post(ADDRESSES, "addresser", &address_body(ATTEMPT, "1 Test Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap();
    assert!(to.starts_with("/account/shipping-addresses?"), "{to}");
    let place = query(to);
    assert_eq!(place["saved"], ATTEMPT);
    assert!(place["after_write"].contains("\"commitPosition\":\"42\""), "read after the write: {to}");
    let writes = address_writes(&pilot);
    assert_eq!((&writes[0].0, writes[0].1.as_str(), writes[0].2.as_str()), (&Method::POST, "", ATTEMPT));
    let sent = &writes[0].3;
    assert_eq!(sent["postalCode"], "78701", "{sent}");
    assert_eq!(sent["makeDefault"], true, "{sent}");
    assert_eq!(sent["company"], Value::Null, "{sent}");
    let (status, _, html) = pilot.send(get(to, Some("addresser"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Your change was saved"), "{}", text(&html));
    let read = pilot.stand.calls.lock().unwrap().iter().rev().find(|c| c.path == BOOK).cloned().unwrap();
    assert_eq!(waits_for(&read.headers).as_deref(), Some("42"), "the list waits for the write");
}

#[tokio::test]
async fn a_refused_address_says_why_in_its_form_with_a_new_attempt() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post(ADDRESSES, "addresser", &address_body(ATTEMPT, "1 Test Way", ""), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("City is required."), "{}", text(&html));
    assert!(html.contains(r#"name="city" value="" autocomplete="address-level2" required aria-invalid="true""#), "{html}");
    assert!(html.contains(r#"value="Office""#), "what was sent is kept: {html}");
    assert_ne!(drawn_attempt(&html), ATTEMPT, "drawn with a new attempt");

    let (status, _, html) = pilot.send(post(ADDRESSES, "addresser", &address_body(ATTEMPT, "0 Nowhere", "Austin"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("We could not verify this as a deliverable address."), "{}", text(&html));

    let (status, _, _) =
        pilot.send(post(ADDRESSES, "addresser", &address_body("not-an-attempt", "1 Test Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(address_writes(&pilot).len(), 2, "an address without the pilot's attempt is not sent");
}

#[tokio::test]
async fn an_address_the_api_would_change_offers_its_suggestion_and_sends_the_choice() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post(ADDRESSES, "addresser", &address_body(ATTEMPT, "1 Suggest Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let shown = text(&html);
    assert!(shown.contains("Choose which address to save in a new attempt."), "{shown}");
    assert!(shown.contains("Suggested address 1 SUGGEST WAY, AUSTIN, TX, 78701-0001, US"), "{shown}");
    assert!(html.contains(r#"name="decision" value="accept-suggested">Use suggested address</button>"#), "{html}");
    assert!(html.contains(r#"name="decision" value="keep-original">"#), "{html}");
    let again = drawn_attempt(&html);
    let body = format!("{}&decision=accept-suggested", address_body(&again, "1 Suggest Way", "Austin"));
    let (status, _, _) = pilot.send(post(ADDRESSES, "addresser", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let writes = address_writes(&pilot);
    assert_eq!(writes[1].3["addressVerificationDecision"], "accept-suggested");
    assert_eq!(writes[1].2, again, "in a new attempt");
}

#[tokio::test]
async fn an_address_write_without_an_answer_is_asked_about_and_one_that_cannot_be_confirmed_holds_its_form() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post(ADDRESSES, "addresser", &address_body(APPLIED_BEFORE, "1 Test Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "the lookup says it was saved");
    let place = query(headers["location"].to_str().unwrap());
    assert_eq!(place["saved"], APPLIED_BEFORE);
    assert!(place["after_write"].contains("\"commitPosition\":\"42\""), "the lookup's receipt: {place:?}");

    let (status, _, html) =
        pilot.send(post(ADDRESSES, "addresser", &address_body(NO_RECORD, "1 Test Way", "Austin"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("No change was recorded. Review and submit again."), "{}", text(&html));

    let archive = "/account/shipping-addresses/adr_work/archive";
    let (status, headers, _) = pilot.send(post(archive, "addresser", &format!("attempt={CHECK_DOWN}"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers["location"].to_str().unwrap().to_owned();
    assert_eq!(query(&to)["check"], CHECK_DOWN);
    assert_eq!((query(&to)["action"].as_str(), query(&to)["target"].as_str()), ("archive", "adr_work"));
    let (status, _, html) = pilot.send(get(&to, Some("addresser"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        text(&html).contains("We could not confirm the result. Do not repeat this action yet. Check again"),
        "{}",
        text(&html)
    );
    assert!(html.contains(&format!(r#"href="{}">Check again</a>"#, to.replace('&', "&amp;"))), "{html}");
    let work = html.find(r#"action="/account/shipping-addresses/adr_work/archive""#).unwrap();
    assert!(html[work..].split("</form>").next().unwrap().contains("disabled"), "Work's archive is held");
    let home = html.find(r#"action="/account/shipping-addresses/adr_home/archive""#).unwrap();
    assert!(!html[home..].split("</form>").next().unwrap().contains("disabled"), "Home's is not");
}

#[tokio::test]
async fn a_default_on_a_changed_address_says_the_account_changed_and_a_list_still_catching_up_says_so() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/account/shipping-addresses/adr_gone/default", "addresser", &format!("attempt={ATTEMPT}"), false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(text(&html).contains("The account changed. Review its current state before submitting again."), "{}", text(&html));
    let (status, headers, _) = pilot
        .send(post("/account/shipping-addresses/adr_work", "addresser", &address_body(ATTEMPT, "2 Test Way", "Austin"), false))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers["location"].to_str().unwrap().contains("saved="));
    assert_eq!(address_writes(&pilot)[1].0, Method::PUT);
    assert_eq!(address_writes(&pilot)[1].1, "/adr_work");

    let to = format!("{ADDRESSES}?after_write={}&saved={ATTEMPT}", receipt_at("45"));
    let (status, _, html) = pilot.send(get(&to, Some("addresser"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Shipping addresses are still updating. Reload this page in a moment."), "{}", text(&html));
    assert!(html.contains(r#"data-corten-read-again="2""#), "the page reads itself again: {html}");
}

// Create listing (marketplace's account-listings-new).

const LISTING_NEW: &str = "/account/listings/new";
const SUPPLY: &str = "/api/marketplace/account/listing-inventory";
const LOCATION_EXISTS: &str = "/api/marketplace/account/supply-locations/exists";
const TERMS_PREVIEW: &str = "/api/marketplace/account/listings/preview";
const READINESS_PREVIEW: &str = "/api/marketplace/account/listings/evidence-readiness/preview";
const CLAIMS: &str = "/api/marketplace/account/listing-draft-intents/";
/// A PNG's first bytes: what the pilot checks a photo's type against.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

/// A listing inventory item: `inv_etb` has a shipping measure, `inv_bare` none.
fn supply_item(id: &str, title: &str, measured: bool) -> Value {
    json!({
        "item_id": id, "catalog_catalog_item_id": "cat_etb", "product_id": "cat_etb", "item_title": title,
        "item_subtitle": "Sealed", "selected_options": [], "graded_card": null, "product_summary": title,
        "product_measure_snapshot": if measured { json!({ "weightOunces": 32 }) } else { Value::Null },
        "storage_location_id": "loc_main", "storage_location_name": "Main shelf", "ship_from_code": "MAIN",
        "ship_from_address": { "line1": "1 Test Way" }, "total_quantity": 4, "available_quantity": 3,
        "acquisition_cost_amount": "80.00",
    })
}

/// A multipart body's fields as (name, filename, value), parted at the boundary its type names.
fn multipart_fields(headers: &HeaderMap, body: &str) -> Option<Vec<(String, Option<String>, String)>> {
    let kind = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    let boundary = kind.strip_prefix("multipart/form-data; boundary=")?;
    let quoted =
        |head: &str, key: &str| head.split(&format!("{key}=\"")).nth(1).and_then(|r| r.split('"').next()).map(str::to_owned);
    Some(
        body.split(&format!("--{boundary}"))
            .filter_map(|part| {
                let (head, value) = part.split_once("\r\n\r\n")?;
                let name = quoted(head, " name")?;
                Some((name, quoted(head, "filename"), value.strip_suffix("\r\n").unwrap_or(value).to_owned()))
            })
            .collect(),
    )
}

/// Create listing's reads and its multipart create, as the stand-in answers them. The seller has
/// two inventory items in its first page and `inv_late` and `inv_missing` past it; `inv_missing`
/// is ahead in Marketplace's read, so Inventory does not know it. Only `lister` has its Listing
/// stock. A fee preview at 1.00 is refused. `inv_etb`'s evidence is complete, the others' is not.
/// The search finds `cat_etb` for "twilight", nothing for "zzz", and fails for "broken";
/// `cat_card` is a card with options (Inventory's read has no `valueKind`). A guest's draft
/// `ldi_1` is claimed with an `anon_` owner. The create refuses `purchaseLimits`
/// (chase-sets/chase-sets#10650), answers 500 for a photo named `broken.png`
/// (chase-sets/chase-sets#10649), and records the rest as the JSON create does.
fn listing_create(stand: &Stand, session: &str, method: &Method, uri: &Uri, headers: &HeaderMap, body: &str) -> Option<Response> {
    let path = uri.path();
    let query = uri.query().unwrap_or_default();
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    match (method.as_str(), path) {
        ("GET", SUPPLY) => {
            let items = match query.split('&').find_map(|p| p.strip_prefix("inventoryItemId=")) {
                Some(id @ ("inv_late" | "inv_missing")) => vec![supply_item(id, "Late box", true)],
                Some(_) => vec![],
                None => vec![supply_item("inv_etb", "Elite Trainer Box", true), supply_item("inv_bare", "Bare box", false)],
            };
            Some(Json(json!({ "items": items })).into_response())
        }
        ("GET", LOCATION_EXISTS) => Some(Json(json!({ "exists": session == "lister" })).into_response()),
        ("POST", TERMS_PREVIEW) if sent["priceAmount"] == "1.00" => {
            Some(refusal(StatusCode::BAD_REQUEST, "command-rejected", "Listing price is below the marketplace minimum."))
        }
        ("POST", TERMS_PREVIEW) => Some(
            Json(json!({
                "account_type": "individual", "basis_amount": sent["priceAmount"], "marketplace_sales_fee_unit_amount": "4.50",
                "seller_net_unit_amount": "40.50", "shipping_allowance_percentage_bps": 500, "schedule_id": "fs_1",
                "fee_quote_fingerprint": "fq_preview",
            }))
            .into_response(),
        ),
        ("POST", READINESS_PREVIEW) => {
            let complete = sent["inventoryItemId"] == "inv_etb";
            let slot = |id: &str, view: &str| json!({ "slotId": id, "viewKind": view, "satisfied": complete, "unmetCode": if complete { Value::Null } else { json!("slot-missing") } });
            Some(
                Json(json!({
                    "ready": complete,
                    "requirements": { "requiredSlots": [{ "slotId": "front", "minimumWidthPixels": 800, "minimumHeightPixels": 800 }] },
                    "coverage": { "complete": complete, "slots": [slot("front", "front")], "activePhotoCount": if complete { 1 } else { 0 }, "minimumPhotoCount": 1 },
                    "nextActions": if complete { json!([]) } else { json!([{ "code": "slot-missing" }]) },
                }))
                .into_response(),
            )
        }
        ("GET", "/api/marketplace/items/suggest") => Some(match query {
            q if q.contains("q=broken") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            q if q.contains("q=twilight") => Json(json!({ "items": [{ "catalogItemId": "cat_etb", "title": "Twilight Masquerade Elite Trainer Box", "subtitle": "Sealed", "category": "sealed" }] })).into_response(),
            _ => Json(json!({ "items": [] })).into_response(),
        }),
        ("GET", "/api/inventory/catalog-items/cat_etb") => Some(
            Json(json!({ "catalog_item_id": "cat_etb", "title": "Twilight Masquerade Elite Trainer Box", "subtitle": "Sealed", "status": "active", "product_schema": null }))
                .into_response(),
        ),
        ("GET", "/api/inventory/catalog-items/cat_card") => {
            let option = |id: &str, label: &str| json!({ "optionId": id, "code": id, "label": label, "displayOrder": 0 });
            Some(
                Json(json!({
                    "catalog_item_id": "cat_card", "title": "Charizard", "subtitle": "Base Set", "status": "active",
                    "product_schema": {
                        "dimensions": [
                            { "dimensionId": "dim_form", "dimensionName": "Form", "required": true, "appliesWhen": [],
                              "allowedOptions": [option("chc_raw", "Raw"), option("chc_graded", "Graded")] },
                            { "dimensionId": "dim_condition", "dimensionName": "Condition", "required": true,
                              "appliesWhen": [{ "dimensionId": "dim_form", "optionIds": ["chc_raw"] }],
                              "allowedOptions": [option("chc_nm", "Near Mint"), option("chc_lp", "Lightly Played")] },
                            { "dimensionId": "dim_grade", "dimensionName": "Grade", "required": true,
                              "appliesWhen": [{ "dimensionId": "dim_form", "optionIds": ["chc_graded"] }],
                              "allowedOptions": [option("chc_grade_10", "10")] },
                        ],
                        "canonicalDimensionOrder": [{ "dimensionId": "dim_form" }, { "dimensionId": "dim_condition" }, { "dimensionId": "dim_grade" }],
                    },
                }))
                .into_response(),
            )
        }
        ("GET", p) if p.starts_with("/api/inventory/catalog-items/") => {
            Some(refusal(StatusCode::NOT_FOUND, "catalog_item_not_found", "Catalog item was not found."))
        }
        ("POST", p) if p.strip_prefix(CLAIMS).is_some_and(|rest| rest.ends_with("/claim")) => {
            let owner = headers.get("x-marketplace-anonymous-listing-draft-id").and_then(|v| v.to_str().ok());
            if p != format!("{CLAIMS}ldi_1/claim") || !owner.is_some_and(|o| o.starts_with("anon_")) {
                return Some(refusal(StatusCode::NOT_FOUND, "listing_draft_intent_not_found", "That listing draft could not be found."));
            }
            Some(
                Json(json!({
                    "catalog_item_id": "cat_etb", "selected_options": [], "price_amount": "45.00", "price_currency_code": "USD",
                    "quantity_cap": 2, "max_units_per_order": 1, "max_units_per_day": null, "max_units_per_customer_account": null,
                }))
                .into_response(),
            )
        }
        ("POST", CREATE_LISTING) => {
            let parts = multipart_fields(headers, body)?;
            let mut fields = serde_json::Map::new();
            let mut photos = Vec::new();
            for (name, filename, value) in parts {
                match filename {
                    Some(filename) => photos.push(json!({ "field": name, "filename": filename })),
                    None => {
                        let value = match name.as_str() {
                            "inventorySnapshot" => serde_json::from_str(&value).unwrap_or(Value::Null),
                            _ => Value::String(value),
                        };
                        fields.insert(name, value);
                    }
                }
            }
            let sent = Value::Object(fields);
            if sent.get("purchaseLimits").is_some() {
                return Some(refusal(StatusCode::BAD_REQUEST, "listing_request_unknown_field", "Remove unrecognized fields and try again."));
            }
            if photos.iter().any(|p| p["filename"] == "broken.png") {
                return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
            if sent["inventoryItemId"] == "inv_missing" && sent["inventorySnapshot"].is_null() {
                return Some(refusal(StatusCode::NOT_FOUND, "inventory_item_not_found", "Inventory item was not found."));
            }
            if sent["priceAmount"] == "1.00" {
                return Some(refusal(StatusCode::BAD_REQUEST, "command-rejected", "Listing price is below the marketplace minimum."));
            }
            let id = sent["listingIdOverride"].as_str().unwrap_or("lst_new").to_owned();
            let mut record = sent;
            record["photos"] = json!(photos);
            stand.listings.lock().unwrap().entry(id.clone()).or_insert(record);
            let created = json!({ "id": id, "version": 1, "status": "draft", "feeQuoteFingerprint": "fq_1", "state": { "status": "draft" } });
            Some(committed(StatusCode::CREATED, "marketplace", "30", created))
        }
        _ => None,
    }
}

/// A multipart form post, as a browser sends Create listing: `fields`, then `files` as
/// (input name, filename, type, bytes).
fn post_multipart(uri: &str, session: &str, fields: &[(&str, &str)], files: &[(&str, &str, &str, &[u8])]) -> Request<Body> {
    const BOUNDARY: &str = "pilotTestBoundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    for (name, filename, kind, bytes) in files {
        body.extend_from_slice(
            format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {kind}\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    Request::post(uri)
        .header(header::HOST, "localhost:7791")
        .header(header::COOKIE, format!("chase_sets_session={session}"))
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(body))
        .unwrap()
}

/// The creates the stand-in kept, by listing id.
fn created(pilot: &Pilot, id: &str) -> Value {
    pilot.stand.listings.lock().unwrap().get(id).cloned().unwrap_or_default()
}

fn create_calls(pilot: &Pilot) -> usize {
    pilot.stand.calls.lock().unwrap().iter().filter(|c| c.method == Method::POST && c.path == CREATE_LISTING).count()
}

/// A create's fields from inventory: the attempt the form drew, the intent, the item and price.
fn inventory_create<'a>(attempt: &'a str, intent: &'a str, item: &'a str, price: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("attempt", attempt),
        ("intent", intent),
        ("inventoryItemId", item),
        ("priceAmount", price),
        ("priceCurrencyCode", "USD"),
        ("quantityCap", "2"),
        ("maxUnitsPerOrder", "1"),
        ("maxUnitsPerDay", ""),
        ("maxUnitsPerCustomerAccount", ""),
    ]
}

#[tokio::test]
async fn create_listing_reads_the_sellers_inventory_and_only_a_listing_manager_writes() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(LISTING_NEW, Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"enctype="multipart/form-data""#), "the form posts its photos: {html}");
    assert!(html.contains(r#"accept="image/jpeg,image/png,image/webp""#), "{html}");
    let page = text(&html);
    assert!(page.contains("Elite Trainer Box") && page.contains("Bare box"), "{page}");
    let reads: Vec<String> =
        pilot.stand.calls.lock().unwrap().iter().filter(|c| c.method == Method::GET).map(|c| c.path.clone()).collect();
    assert!(reads.contains(&format!("{SUPPLY}?limit=100&offset=0")), "{reads:?}");
    assert!(reads.contains(&format!("{LOCATION_EXISTS}?name=Listing%20stock")), "{reads:?}");
    // Nothing chosen: neither write is on.
    assert!(!html.contains(r#"value="create-listing" formmethod"#), "{html}");
    // Signed out: marketplace's sign-in, back to the page.
    let (status, headers, _) = pilot.send(get(LISTING_NEW, None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .starts_with("http://localhost:7753/sign-in?returnTo=%2Faccount%2Flistings%2Fnew")
    );
    // An account that may not list reads the access page and cannot post.
    let (status, _, html) = pilot.send(get(LISTING_NEW, Some("buyer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{html}");
    let (status, _, _) = pilot
        .send(post_multipart(LISTING_NEW, "trader", &inventory_create(ATTEMPT, "create-listing", "inv_etb", "45.00"), &[]))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(create_calls(&pilot), 0);
}

#[tokio::test]
async fn the_catalog_search_finds_chooses_and_asks_for_each_option_that_applies() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(&format!("{LISTING_NEW}?q=twilight"), Some("lister"))).await;
    assert!(text(&html).contains("Twilight Masquerade Elite Trainer Box"), "{html}");
    assert!(html.contains(r#"name="choose" value="cat_etb""#), "{html}");
    let (_, _, html) = pilot.send(get(&format!("{LISTING_NEW}?q=zzz"), Some("lister"))).await;
    assert!(text(&html).contains("No active catalog items matched that search."), "{html}");
    let (_, _, html) = pilot.send(get(&format!("{LISTING_NEW}?q=broken"), Some("lister"))).await;
    assert!(text(&html).contains("Catalog item lookup failed."), "{html}");
    // Chosen: a raw card asks for its condition, not a grade.
    let (_, _, html) = pilot.send(get(&format!("{LISTING_NEW}?choose=cat_card"), Some("lister"))).await;
    assert!(html.contains(r#"name="option.dim_form""#) && html.contains(r#"name="option.dim_condition""#), "{html}");
    assert!(!html.contains(r#"name="option.dim_grade""#), "{html}");
    // Graded: the grade, and no condition.
    let (_, _, html) = pilot
        .send(get(&format!("{LISTING_NEW}?catalogItemId=cat_card&option.dim_form=chc_graded&redraw=1"), Some("lister")))
        .await;
    assert!(html.contains(r#"name="option.dim_grade""#) && !html.contains(r#"name="option.dim_condition""#), "{html}");
    // With JavaScript a redraw is the parts, not the page.
    let mut req = get(&format!("{LISTING_NEW}?q=twilight&redraw=1"), Some("lister"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    let (status, _, patch) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!patch.contains("<html") && patch.contains("Twilight Masquerade Elite Trainer Box"), "{patch}");
}

#[tokio::test]
async fn a_draft_from_inventory_sends_its_photos_and_limits_and_goes_to_its_listing() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get(&format!("{LISTING_NEW}?inventoryItemId=inv_etb"), Some("lister"))).await;
    let attempt = drawn_attempt(&html);
    let fields = inventory_create(&attempt, "create-listing", "inv_etb", "45.00");
    let files: [(&str, &str, &str, &[u8]); 2] =
        [("evidence", "front.png", "image/png", PNG), ("other", "notes.png", "image/png", PNG)];
    let (status, headers, html) = pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &files)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let id = crate::listing::listing_id(&attempt).unwrap();
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with(&format!("/account/listings/{id}?evidenceEvent=upload_completed&afterWrite=")), "{to}");
    let sent = created(&pilot, &id);
    assert_eq!(
        (&sent["inventoryItemId"], &sent["priceAmount"], &sent["quantityCap"], &sent["maxUnitsPerOrder"]),
        (&json!("inv_etb"), &json!("45.00"), &json!("2"), &json!("1"))
    );
    assert!(sent.get("maxUnitsPerDay").is_none() && sent.get("purchaseLimits").is_none(), "only the limits given: {sent}");
    assert_eq!(sent["photos"], json!([{ "field": "evidence", "filename": "front.png" }]), "only the photo input's files");
    // The same form again is the same listing.
    let (status, _, _) = pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &files)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(pilot.stand.listings.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_photo_the_api_would_not_take_is_refused_with_the_form_and_nothing_is_created() {
    let pilot = Pilot::new().await;
    let fields = inventory_create(ATTEMPT, "create-listing", "inv_etb", "45.00");
    // Not a picture, whatever its type says.
    let (status, _, html) =
        pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &[("evidence", "notes.png", "image/png", b"hello")])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(page.contains("Each photo must be a JPEG, PNG or WebP image."), "{page}");
    assert!(page.contains("If you had chosen photos, choose them again."), "{page}");
    assert!(html.contains(r#"value="45.00""#), "the form keeps what was typed: {html}");
    // Too large.
    let big = [PNG, &vec![0u8; 10 * 1024 * 1024]].concat();
    let (status, _, html) =
        pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &[("evidence", "big.png", "image/png", &big)])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Each photo must be 10 MB or smaller."), "{html}");
    assert_eq!(create_calls(&pilot), 0);
    // The API's 500 for a photo it cannot decode (chase-sets/chase-sets#10649) is the form again.
    let (status, _, html) =
        pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &[("evidence", "broken.png", "image/png", PNG)])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("The photos could not be processed, so nothing was created."), "{html}");
    assert!(pilot.stand.listings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn publish_goes_to_the_listing_says_when_evidence_blocks_it_and_keeps_a_refused_draft() {
    let pilot = Pilot::new().await;
    let publish = |attempt: &'static str, item: &'static str, price: &'static str| {
        post_multipart(LISTING_NEW, "lister", &inventory_create(attempt, "create-and-publish-listing", item, price), &[])
    };
    let (status, headers, html) = pilot.send(publish(ATTEMPT, "inv_etb", "45.00")).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(headers[header::LOCATION].to_str().unwrap().contains("?evidenceEvent=publication_succeeded&afterWrite="));
    assert_eq!(created(&pilot, LISTED)["published"], true);
    let (status, headers, _) = pilot.send(publish("1b6f3c1e-4d2a-4b8e-9f00-1234567890ab", "inv_bare", "45.00")).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().contains("?evidenceEvent=publication_blocked&afterWrite="));
    // A publication refused for another reason: the draft is kept and linked.
    let (status, _, html) = pilot.send(publish("2b6f3c1e-4d2a-4b8e-9f00-1234567890ab", "inv_etb", "2.00")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(page.contains("Listings require a resolved shipping measure before publication."), "{page}");
    assert!(page.contains("The listing was saved as a draft and not published. Open the draft"), "{page}");
    assert!(html.contains(r#"href="/account/listings/lst_2b6f3c1e4d2a4b8e9f001234567890ab""#), "{html}");
}

#[tokio::test]
async fn a_catalog_product_ensures_its_listing_stock_and_creates_from_its_snapshot() {
    let pilot = Pilot::new().await;
    let fields = [
        ("attempt", ATTEMPT),
        ("intent", "create-listing"),
        ("catalogItemId", "cat_card"),
        ("option.dim_condition", "chc_lp"),
        ("option.dim_form", "chc_raw"),
        ("priceAmount", "30.00"),
        ("priceCurrencyCode", "USD"),
        ("quantityCap", "3"),
    ];
    let (status, _, html) = pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &[])).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let ensure = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path == ENSURE).cloned().expect("the stock is ensured");
    assert_eq!(ensure.headers["inventory-mutation-attempt"], ATTEMPT);
    let stock: Value = serde_json::from_str(&ensure.body).unwrap();
    assert_eq!(
        stock,
        json!({ "catalogItemId": "cat_card", "quantity": 3, "selectedOptions": [
            { "dimensionId": "dim_form", "optionId": "chc_raw" }, { "dimensionId": "dim_condition", "optionId": "chc_lp" },
        ] })
    );
    let sent = created(&pilot, LISTED);
    assert_eq!(sent["inventoryItemId"], "", "{sent}");
    assert_eq!(sent["inventorySnapshot"]["inventoryItemId"], "inv_stock", "{sent}");
    // A graded card without its grade writes nothing.
    let graded = [
        ("attempt", ATTEMPT),
        ("intent", "create-listing"),
        ("catalogItemId", "cat_card"),
        ("option.dim_form", "chc_graded"),
        ("priceAmount", "30.00"),
    ];
    let (status, _, html) = pilot.send(post_multipart(LISTING_NEW, "lister", &graded, &[])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Choose every product option to list this item."), "{html}");
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path == ENSURE).count(), 1);
}

#[tokio::test]
async fn an_item_marketplace_reads_before_inventory_does_is_created_from_marketplaces_snapshot() {
    let pilot = Pilot::new().await;
    let fields = inventory_create(ATTEMPT, "create-listing", "inv_missing", "45.00");
    let (status, _, html) = pilot.send(post_multipart(LISTING_NEW, "lister", &fields, &[])).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(create_calls(&pilot), 2);
    let sent = created(&pilot, LISTED);
    assert_eq!(
        (&sent["inventoryItemId"], &sent["inventorySnapshot"]["inventoryItemId"]),
        (&json!("inv_missing"), &json!("inv_missing"))
    );
    assert_eq!(sent["inventorySnapshot"]["shipFromCode"], "MAIN");
}

#[tokio::test]
async fn a_guests_draft_is_claimed_into_the_form_and_one_it_cannot_claim_says_so() {
    let pilot = Pilot::new().await;
    let claim = |cookie: &str| {
        let mut req = get(&format!("{LISTING_NEW}?claimListingIntent=ldi_1"), Some("lister"));
        req.headers_mut().insert(header::COOKIE, format!("chase_sets_session=lister; {cookie}").parse().unwrap());
        req
    };
    let (status, _, html) = pilot.send(claim("chase_sets_anonymous_listing_drafts=anon_cmd_1")).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent = pilot.stand.calls.lock().unwrap().iter().find(|c| c.path.starts_with(CLAIMS)).cloned().expect("the claim");
    assert_eq!(sent.headers["x-marketplace-anonymous-listing-draft-id"], "anon_cmd_1");
    assert!(html.contains(r#"value="45.00""#) && text(&html).contains("Twilight Masquerade Elite Trainer Box"), "{html}");
    // Without the guest's owner nothing is asked.
    let (status, _, html) = pilot.send(claim("other=1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(CLAIMS)).count(), 1);
    assert!(!html.contains(r#"value="45.00""#), "{html}");
}

#[tokio::test]
async fn the_fee_preview_draws_the_terms_or_the_apis_refusal() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot
        .send(get(
            &format!("{LISTING_NEW}?inventoryItemId=inv_etb&priceAmount=45.00&priceCurrencyCode=USD&preview=1"),
            Some("lister"),
        ))
        .await;
    let page = text(&html);
    assert!(page.contains("Basis amount: $45.00 Locked Fee $4.50") && page.contains("$40.50"), "{page}");
    let (_, _, html) =
        pilot.send(get(&format!("{LISTING_NEW}?inventoryItemId=inv_etb&priceAmount=1.00&preview=1"), Some("lister"))).await;
    assert!(text(&html).contains("Listing price is below the marketplace minimum."), "{html}");
}

const SELLER_LISTINGS: &str = "/api/marketplace/account/listings/";

/// A seller's listing as the API reads it: `lst_draft` is a draft with two photos and its front
/// view missing, `lst_active` is active and ready.
fn seller_listing(id: &str) -> Value {
    let draft = id == "lst_draft";
    let photo = |id: &str, order: i64, slot: Value| json!({ "photoId": id, "altText": null, "slotId": slot, "viewKind": slot, "status": "active", "sortOrder": order });
    let slot = json!({ "slotId": "front", "viewKind": "front", "satisfied": !draft, "unmetCode": if draft { json!("slot-missing") } else { Value::Null } });
    let mut gone = photo("ph_old", 2, Value::Null);
    gone["status"] = json!("removed");
    let evidence = json!([photo("ph_1", 0, json!("back")), photo("ph_2", 1, Value::Null), gone]);
    let mut listing = json!({
        "listing_id": id, "catalog_catalog_item_id": "cat_charizard", "item_language_code": "en",
        "item_title": "Charizard", "item_subtitle": "Base Set", "product_summary": "Form: raw | Condition: near-mint",
        "product_measure_snapshot": { "weightOunces": 1 }, "storage_location_name": "Main shelf", "ship_from_code": "MAIN",
        "price_amount": "399.99", "price_currency_code": "USD", "marketplace_sales_fee_unit_amount": "40.00",
        "seller_net_unit_amount": "359.99", "shipping_allowance_percentage_bps": 250, "terms_schedule_id": "fs_1",
        "terms_agreement_id": null, "terms_resolved_at": "2026-10-20T12:00:00.000Z", "fee_quote_fingerprint": "fq_listing",
        "quantity_cap": 2, "max_units_per_order": 1, "max_units_per_day": null, "max_units_per_customer_account": null,
        "status": if draft { "draft" } else { "active" },
        "evidence": evidence,
    });
    listing["evidence_readiness"] = json!({
        "ready": !draft,
        "requirements": { "requiredSlots": [{ "slotId": "front", "viewKind": "front", "minimumWidthPixels": 800, "minimumHeightPixels": 800 }] },
        "coverage": { "complete": !draft, "slots": [slot], "activePhotoCount": 2, "minimumPhotoCount": 1 },
        "nextActions": [],
        "publicGallery": [{ "photoId": "ph_1", "altText": null, "assets": [
            { "role": "catalog-detail", "publicUrl": "https://cdn.example/ph_1-480.webp", "width": 480, "height": 670, "density": 1 },
            { "role": "catalog-detail", "publicUrl": "https://cdn.example/ph_1-960.webp", "width": 960, "height": 1340, "density": 2 },
        ] }],
    });
    listing
}

/// The seller's list of listings' calls, as the stand-in answers them. The page holds `lst_active`
/// and `lst_draft` of 250 (two active, one draft, one paused); `lookout`'s metrics and open
/// order count fail; a read that waits for 43 is still catching up. Turning listings off with
/// the reason `bogus` is refused, as is an order capacity of 1000; pausing `lst_locked` is
/// refused and `lst_broken` fails. Every other write applies at 51.
fn listing_list(session: &str, method: &Method, uri: &Uri, headers: &HeaderMap, body: &str) -> Option<Response> {
    const ACCOUNT: &str = "/api/marketplace/account";
    let path = uri.path().strip_prefix(ACCOUNT)?;
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    let applied = || committed(StatusCode::OK, "marketplace", "51", json!({ "accountId": "acc_seller" }));
    let catching_up = || {
        refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        )
    };
    let waiting = waits_for(headers).as_deref() == Some("43");
    let row = |id: &str, status: &str, measured: bool| {
        json!({
            "listing_id": id, "catalog_catalog_item_id": "cat_charizard", "item_language_code": "en",
            "item_title": "Charizard", "item_subtitle": "Base Set", "product_summary": "Form: raw | Condition: near-mint",
            "product_measure_snapshot": if measured { json!({ "weightGrams": 5 }) } else { Value::Null },
            "storage_location_name": "Main shelf", "price_amount": "399.99", "price_currency_code": "USD",
            "marketplace_sales_fee_unit_amount": "40.00", "seller_net_unit_amount": "359.99",
            "shipping_allowance_percentage_bps": 250, "terms_resolved_at": "2026-10-20T12:00:00.000Z",
            "quantity_cap": 2, "status": status,
            "evidence": [{ "photoId": "ph_1", "status": "active", "sortOrder": 0 }, { "photoId": "ph_0", "status": "removed", "sortOrder": 1 }],
        })
    };
    Some(match (method.as_str(), path) {
        ("GET", "/listings") if waiting => catching_up(),
        ("GET", "/listings") => Json(json!({
            "items": [row("lst_active", "active", true), row("lst_draft", "draft", false)],
            "total": 250, "count": 2, "limit": 100, "offset": 0,
            "statusCounts": { "active": 2, "draft": 1, "paused": 1, "withdrawn": 0 },
        }))
        .into_response(),
        ("GET", "/listings/fee-lock-report") if waiting => catching_up(),
        ("GET", "/listings/fee-lock-report") => Json(json!({ "items": [{
            "listing_id": "lst_active", "inventory_item_id": "inv_1", "item_title": "Charizard", "item_language_code": "en",
            "product_summary": "Form: raw", "status": "active", "price_amount": "399.99", "price_currency_code": "USD",
            "quantity_cap": 2, "marketplace_sales_fee_unit_amount": "40.00", "seller_net_unit_amount": "359.99",
            "shipping_allowance_percentage_bps": 250, "terms_schedule_id": "fs_1", "terms_agreement_id": null,
            "terms_resolved_at": "2026-10-20T12:00:00.000Z", "fee_quote_fingerprint": "fq_1", "fee_locks": [],
            "created_at": "2026-10-20T12:00:00.000Z", "updated_at": "2026-10-21T12:00:00.000Z",
        }], "total": 1, "count": 1 }))
        .into_response(),
        ("GET", "/listing-availability") if waiting => catching_up(),
        ("GET", "/listing-availability") => Json(json!({
            "account_id": "acc_seller", "status": "available", "disabled_reason_category": null, "available_again_on": null,
            "available_again_at": null, "disabled_at": null, "enabled_at": null, "away_window_starts_at": null,
            "away_window_ends_at": null, "away_window_reason_category": null, "updated_at": "2026-10-20T12:00:00.000Z",
        }))
        .into_response(),
        ("GET", "/order-capacity") if waiting => catching_up(),
        ("GET", "/order-capacity") => {
            Json(json!({ "account_id": "acc_seller", "max_open_orders": 5, "updated_at": "2026-10-20T12:00:00.000Z" }))
                .into_response()
        }
        ("GET", "/seller-metrics") if session == "lookout" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        ("GET", "/seller-metrics") => Json(json!({
            "seller_account_id": "acc_seller", "window_days": 90, "orders_created_count": 40, "seller_cancelled_count": 1,
            "cancellation_rate": "0.025", "shipments_dispatched_count": 38, "shipments_on_time_count": 36,
            "on_time_shipment_rate": "0.9474", "disputes_resolved_count": 0, "disputes_against_seller_count": 0,
            "dispute_rate": null, "missing_responsibility_count": 0,
            "computed_at": "2026-10-27T00:00:00.000Z", "updated_at": "2026-10-27T00:00:00.000Z",
        }))
        .into_response(),
        ("GET", "/sales/order-capacity") if session == "lookout" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        ("GET", "/sales/order-capacity") => Json(json!({ "open_order_count": 3 })).into_response(),
        ("POST", "/listing-availability/disable") if sent["reasonCategory"] == "bogus" => refusal(
            StatusCode::BAD_REQUEST,
            "listing_availability_reason_invalid",
            "Seller listing availability reason is invalid.",
        ),
        ("POST", "/order-capacity") if sent["maxOpenOrders"] == 1000 => {
            refusal(StatusCode::BAD_REQUEST, "order_capacity_invalid", "Order capacity must be a whole number of at least 1.")
        }
        (
            "POST",
            "/listing-availability/disable"
            | "/listing-availability/enable"
            | "/listing-availability/away-window"
            | "/order-capacity",
        )
        | ("DELETE", "/listing-availability/away-window" | "/order-capacity") => applied(),
        ("POST", "/listings/lst_locked/pause") => {
            refusal(StatusCode::BAD_REQUEST, "listing_command_rejected", "Listing cannot be paused from its current status.")
        }
        ("POST", "/listings/lst_broken/pause") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => return None,
    })
}

/// The seller's listing page's calls, as the stand-in answers them. A read that waits for 43 is
/// still catching up; `lst_missing` is not found. A price of 1.00 is a stale quote (409 with the
/// current one) and 0.50 is refused; an image description with a text-direction override is
/// refused with its code; publishing the draft is refused for its evidence (409 with the
/// readiness now); photos named `broken.png` are a 500 (chase-sets/chase-sets#10649). Every
/// other write applies at 50.
fn seller_listings(method: &Method, path: &str, headers: &HeaderMap, body: &str) -> Option<Response> {
    let rest = path.strip_prefix(SELLER_LISTINGS)?;
    let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
    if !id.starts_with("lst_") {
        return None;
    }
    let sent: Value = serde_json::from_str(body).unwrap_or_default();
    let applied = || committed(StatusCode::OK, "marketplace", "50", json!({ "id": id, "version": 3 }));
    Some(match (method.as_str(), action) {
        ("GET", _) if id == "lst_missing" => refusal(StatusCode::NOT_FOUND, "listing-not-found", "Listing not found."),
        ("GET", _) if waits_for(headers).as_deref() == Some("43") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        ("GET", "") => Json(seller_listing(id)).into_response(),
        ("GET", "fee-history") => {
            let items = if id == "lst_active" {
                json!([{
                    "event_type": "marketplace.listing.published", "stream_version": 2, "recorded_at": "2026-10-20T12:00:00.000Z",
                    "price_amount": "399.99", "price_currency_code": "USD", "quantity_cap": 2,
                    "marketplace_sales_fee_unit_amount": "40.00", "seller_net_unit_amount": "359.99",
                    "terms_agreement_id": null, "terms_schedule_id": "fs_1", "terms_resolved_at": "2026-10-20T12:00:00.000Z",
                }])
            } else {
                json!([])
            };
            Json(json!({ "items": items })).into_response()
        }
        ("POST", "price") if sent["priceAmount"] == "1.00" => (
            StatusCode::CONFLICT,
            Json(json!({ "error": { "code": "fee-quote-stale", "message": "Fee quote is stale.", "currentQuote": {
                "account_type": "individual", "fee_quote_fingerprint": "fq_current", "basis_amount": "1.00",
                "marketplace_sales_fee_unit_amount": "0.10", "seller_net_unit_amount": "0.90",
                "shipping_allowance_percentage_bps": 250, "schedule_id": "fs_1",
            } } })),
        )
            .into_response(),
        ("POST", "price") if sent["priceAmount"] == "0.50" => {
            refusal(StatusCode::BAD_REQUEST, "command-rejected", "Listing price is below the marketplace minimum.")
        }
        ("POST", a) if a.ends_with("/classify") && sent["altText"].as_str().is_some_and(|t| t.contains('\u{202E}')) => {
            refusal(StatusCode::BAD_REQUEST, "text_direction_override", "Remove hidden text-direction characters.")
        }
        ("POST", "publish") if id == "lst_draft" => (
            StatusCode::CONFLICT,
            Json(json!({ "error": {
                "code": "listing_evidence_incomplete",
                "message": "Listing evidence is incomplete for the active policy.",
                "currentEvidenceReadiness": seller_listing(id)["evidence_readiness"],
            } })),
        )
            .into_response(),
        ("POST", _) if body.contains("filename=\"broken.png\"") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        ("POST", _) | ("DELETE", _) => applied(),
        _ => return None,
    })
}

/// The calls the seller's listing page made to the listing's API, but its reads.
fn listing_writes(pilot: &Pilot, id: &str) -> Vec<Call> {
    let prefix = format!("{SELLER_LISTINGS}{id}");
    pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(&prefix) && c.method != Method::GET).cloned().collect()
}

#[tokio::test]
async fn a_sellers_listing_shows_its_overview_fees_readiness_and_forms_and_only_a_draft_its_photos() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/listings/lst_active", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    for words in [
        "Charizard",
        "Base Set",
        "Active",
        "Verified account",
        "English",
        "near-mint",
        "$399.99",
        "Marketplace $40.00. Net $359.99. Buyer shipping credit 2.5%",
        "Main shelf MAIN",
        "Standard seller terms",
        "1 recorded fee events",
        "Published fee lock",
        "Evidence ready",
        "Active limits: order 1",
        "Seller-supplied evidence",
    ] {
        assert!(page.contains(words), "{words}: {page}");
    }
    // Its forms post to the page; the price form carries the listing's quote; Publish is off for
    // an active listing, Pause is on, and Withdraw asks first.
    assert!(html.contains(r#"action="/account/listings/lst_active""#), "{html}");
    assert!(html.contains(r#"name="feeQuoteFingerprint" value="fq_listing""#), "{html}");
    assert!(html.contains(r#"type="submit" disabled>Publish listing</button>"#), "{html}");
    assert!(html.contains(r#"type="submit">Pause listing</button>"#), "{html}");
    assert!(html.contains(r#"command="show-modal" commandfor="withdraw-dialog""#), "{html}");
    assert!(
        html.contains(r#"srcset="https://cdn.example/ph_1-480.webp 480w, https://cdn.example/ph_1-960.webp 960w""#),
        "{html}"
    );
    // An active listing has no photo forms.
    assert!(!html.contains("/account/listings/lst_active/photos"), "{html}");

    // A draft: what its evidence needs, and each active photo's forms in order.
    let (status, _, html) = pilot.send(get("/account/listings/lst_draft", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Evidence required") && page.contains("Add the required photo for this view."), "{page}");
    assert!(page.contains("No fee lock history is available."), "{page}");
    assert!(page.contains("Complete the required evidence actions above before publishing."), "{page}");
    assert_eq!(html.matches(r#"action="/account/listings/lst_draft/photos""#).count(), 3, "{html}");
    assert_eq!(html.matches(r#"value="classify-photo""#).count(), 2, "{html}");
    assert!(html.contains(r#"name="orderedPhotoIds" value="ph_2,ph_1""#), "{html}");
    assert!(html.contains(r#"disabled aria-label="Move photo 1 earlier""#), "{html}");
    assert!(html.contains(r#"type="submit" aria-label="Move photo 2 earlier""#), "{html}");
    assert!(html.contains(r#"<option value="front">front</option>"#), "{html}");
    assert!(!html.contains("ph_old"), "{html}");
}

#[tokio::test]
async fn a_sellers_listing_needs_listings_view_to_read_and_listings_manage_to_write() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/account/listings/lst_active", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().contains("/sign-in?returnTo=%2Faccount%2Flistings%2Flst_active"));
    let (status, _, _) = pilot.send(get("/account/listings/lst_active", Some("watcher"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/account/listings/lst_active", Some("lookout"))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = pilot.send(post("/account/listings/lst_active", "lookout", "intent=pause", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/account/listings/lst_missing", Some("lister"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(listing_writes(&pilot, "lst_active").is_empty());
}

#[tokio::test]
async fn a_listing_write_goes_back_to_the_page_after_its_receipt_and_sends_what_marketplace_does() {
    let pilot = Pilot::new().await;
    let at = |headers: &HeaderMap| headers[header::LOCATION].to_str().unwrap().to_owned();
    let cases: [(&str, &str, &str, Value, Option<&str>); 8] = [
        (
            "update-price",
            "priceAmount=12.00&priceCurrencyCode=usd&feeQuoteFingerprint=fq_preview",
            "price",
            json!({ "priceAmount": "12.00", "priceCurrencyCode": "USD", "feeQuoteFingerprint": "fq_preview" }),
            None,
        ),
        (
            "update-quantity-cap",
            "quantityCap=3&feeQuoteFingerprint=fq_listing",
            "quantity-cap",
            json!({ "quantityCap": 3, "feeQuoteFingerprint": "fq_listing" }),
            None,
        ),
        (
            "update-purchase-limits",
            "maxUnitsPerOrder=2&maxUnitsPerDay=&maxUnitsPerCustomerAccount=5",
            "purchase-limits",
            json!({ "purchaseLimits": { "maxUnitsPerOrder": 2, "maxUnitsPerDay": null, "maxUnitsPerCustomerAccount": 5 } }),
            None,
        ),
        (
            "classify-photo",
            "photoId=ph_2&slotId=front&altText=Front+of+the+card",
            "photos/ph_2/classify",
            json!({ "slotId": "front", "viewKind": "front", "altText": "Front of the card" }),
            Some("remediation_completed"),
        ),
        (
            "reorder-photos",
            "orderedPhotoIds=ph_2%2Cph_1",
            "photos/reorder",
            json!({ "orderedPhotoIds": ["ph_2", "ph_1"] }),
            Some("remediation_completed"),
        ),
        ("pause", "", "pause", json!({}), None),
        ("withdraw", "", "withdraw", json!({}), None),
        ("remove-photo", "photoId=ph_2", "photos/ph_2", Value::Null, Some("remediation_completed")),
    ];
    for (intent, fields, path, body, event) in cases {
        let id = "lst_draft";
        let (status, headers, html) =
            pilot.send(post(&format!("/account/listings/{id}"), "lister", &format!("intent={intent}&{fields}"), false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{intent}: {html}");
        let to = at(&headers);
        assert!(to.starts_with(&format!("/account/listings/{id}?")), "{to}");
        let q = query(&to);
        assert!(q.contains_key("afterWrite"), "{to}");
        assert_eq!(q.get("evidenceEvent").map(String::as_str), event, "{intent}: {to}");
        let call = listing_writes(&pilot, id).pop().unwrap();
        assert_eq!(call.path, format!("{SELLER_LISTINGS}{id}/{path}"), "{intent}");
        let sent: Value = serde_json::from_str(&call.body).unwrap_or_default();
        assert_eq!(sent, body, "{intent}");
        if intent == "remove-photo" {
            assert_eq!(call.method, Method::DELETE);
        }
    }
    // The page after a write reads after its receipt.
    let (status, _, html) =
        pilot.send(get(&format!("/account/listings/lst_draft?afterWrite={}", receipt_at("50")), Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
}

#[tokio::test]
async fn a_refused_listing_write_says_why_and_keeps_what_was_typed() {
    let pilot = Pilot::new().await;
    // Not a whole number: the field says so, and nothing is sent.
    let (status, _, html) =
        pilot.send(post("/account/listings/lst_active", "lister", "intent=update-quantity-cap&quantityCap=0", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("Enter a whole number of at least 1."), "{html}");
    assert!(html.contains(r#"name="quantityCap" value="0""#), "{html}");
    assert!(html.contains(r#"aria-invalid="true""#), "{html}");
    let (status, _, html) = pilot
        .send(post(
            "/account/listings/lst_active",
            "lister",
            "intent=update-purchase-limits&maxUnitsPerOrder=x&maxUnitsPerDay=&maxUnitsPerCustomerAccount=",
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains(r#"name="maxUnitsPerOrder" value="x""#), "{html}");
    assert!(listing_writes(&pilot, "lst_active").is_empty());

    // A stale quote: the current quote is shown, and the price form now carries it.
    let (status, _, html) = pilot
        .send(post(
            "/account/listings/lst_active",
            "lister",
            "intent=update-price&priceAmount=1.00&priceCurrencyCode=USD&feeQuoteFingerprint=fq_listing",
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    let page = text(&html);
    assert!(page.contains("Fee quote is stale. Refresh the fee preview before continuing."), "{page}");
    assert!(page.contains("Updated fee preview"), "{page}");
    assert!(html.contains(r#"name="feeQuoteFingerprint" value="fq_current""#), "{html}");
    assert!(html.contains(r#"name="priceAmount" value="1.00""#), "{html}");

    // Refused by the API: its words, and the price typed.
    let (status, _, html) = pilot
        .send(post("/account/listings/lst_active", "lister", "intent=update-price&priceAmount=0.50&priceCurrencyCode=USD", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("Update Listing Listing price is below the marketplace minimum."), "{html}");
    assert!(html.contains(r#"name="priceAmount" value="0.50""#), "{html}");

    // An image description refused with a closed code: its recovery, at the photo's field.
    let (status, _, html) = pilot
        .send(post(
            "/account/listings/lst_draft",
            "lister",
            "intent=classify-photo&photoId=ph_2&slotId=&altText=Front%E2%80%AE",
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(page.contains("Your text was not posted"), "{page}");
    assert!(page.contains("Remove hidden text-direction characters from your text, then try again."), "{page}");
    assert!(html.contains(r##"href="#alt-text-ph_2""##), "{html}");
    assert!(html.contains(r#"aria-invalid="true" aria-describedby="alt-text-error-ph_2""#), "{html}");

    // Publishing without the evidence: the API's words, and its readiness now.
    let (status, _, html) =
        pilot.send(post("/account/listings/lst_draft", "lister", "intent=publish&feeQuoteFingerprint=fq_listing", false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(text(&html).contains("Listing evidence is incomplete for the active policy."), "{html}");

    // An intent the page does not send.
    let (status, _, _) = pilot.send(post("/account/listings/lst_draft", "lister", "intent=delete-everything", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn preview_fees_is_a_get_of_the_page_and_the_price_form_sends_its_quote() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/account/listings/lst_active?preview=1&priceAmount=12.00&priceCurrencyCode=USD", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Updated fee preview") && page.contains("Basis amount: $12.00"), "{page}");
    assert!(html.contains(r#"name="priceAmount" value="12.00""#), "{html}");
    assert!(html.contains(r#"name="feeQuoteFingerprint" value="fq_preview""#), "{html}");
    let sent: Vec<Call> = pilot.stand.calls.lock().unwrap().iter().filter(|c| c.path == TERMS_PREVIEW).cloned().collect();
    assert_eq!(serde_json::from_str::<Value>(&sent[0].body).unwrap()["priceAmount"], "12.00");
    // A preview the API refuses says why.
    let (status, _, html) =
        pilot.send(get("/account/listings/lst_active?preview=1&priceAmount=1.00&priceCurrencyCode=USD", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text(&html).contains("Listing price is below the marketplace minimum."), "{html}");
}

#[tokio::test]
async fn a_listing_whose_read_is_catching_up_says_it_is_preparing_and_reads_again() {
    let pilot = Pilot::new().await;
    let receipt = receipt_at("43");
    let (status, _, html) = pilot
        .send(get(&format!("/account/listings/lst_draft?evidenceEvent=upload_completed&afterWrite={receipt}"), Some("lister")))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("Preparing listing") && page.contains("Refresh listing"), "{page}");
    assert!(html.contains(r#"data-corten-read-again="2""#), "{html}");
    let refresh = hrefs(&html, "Refresh listing");
    assert!(refresh[0].starts_with("/account/listings/lst_draft?evidenceEvent=upload_completed&amp;afterWrite="), "{refresh:?}");
}

#[tokio::test]
async fn a_drafts_photos_are_added_and_replaced_as_multipart_and_a_bad_file_is_refused() {
    let pilot = Pilot::new().await;
    let photos = "/account/listings/lst_draft/photos";
    let (status, headers, html) = pilot
        .send(post_multipart(photos, "lister", &[("intent", "add-photos")], &[("evidence", "front.png", "image/png", PNG)]))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(headers[header::LOCATION].to_str().unwrap().contains("evidenceEvent=upload_completed&afterWrite="));
    let call = listing_writes(&pilot, "lst_draft").pop().unwrap();
    assert_eq!(call.path, format!("{SELLER_LISTINGS}lst_draft/photos"));
    let parts = multipart_fields(&call.headers, &call.body).unwrap();
    assert_eq!(parts.iter().filter(|(name, file, _)| name == "evidence" && file.as_deref() == Some("front.png")).count(), 1);

    let fields = [("intent", "replace-photo"), ("photoId", "ph_1"), ("slotId", "back"), ("viewKind", "back"), ("altText", "")];
    let (status, _, html) =
        pilot.send(post_multipart(photos, "lister", &fields, &[("listingPhoto", "back.png", "image/png", PNG)])).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let call = listing_writes(&pilot, "lst_draft").pop().unwrap();
    assert_eq!(call.path, format!("{SELLER_LISTINGS}lst_draft/photos/ph_1/replace"));
    let parts = multipart_fields(&call.headers, &call.body).unwrap();
    let field = |n: &str| parts.iter().find(|(name, ..)| name == n).map(|(_, _, v)| v.clone());
    assert_eq!(field("slotId").as_deref(), Some("back"));
    assert_eq!(field("viewKind").as_deref(), Some("back"));
    assert!(field("listingPhotoAltText").is_none());
    assert!(parts.iter().any(|(name, file, _)| name == "listingPhoto" && file.as_deref() == Some("back.png")));

    let before = listing_writes(&pilot, "lst_draft").len();
    let (status, _, html) = pilot
        .send(post_multipart(photos, "lister", &[("intent", "add-photos")], &[("evidence", "notes.txt", "text/plain", b"hello")]))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    let page = text(&html);
    assert!(page.contains("Each photo must be a JPEG, PNG or WebP image."), "{page}");
    assert!(page.contains("If you had chosen photos, choose them again."), "{page}");
    let (status, _, html) = pilot.send(post_multipart(photos, "lister", &[("intent", "add-photos")], &[])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Choose a photo to upload."), "{html}");
    assert_eq!(listing_writes(&pilot, "lst_draft").len(), before);

    // A photo the API cannot process (a 500, chase-sets/chase-sets#10649) says so.
    let (status, _, html) = pilot
        .send(post_multipart(photos, "lister", &[("intent", "add-photos")], &[("evidence", "broken.png", "image/png", PNG)]))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(text(&html).contains("The photos could not be processed, so nothing was changed."), "{html}");
    // Someone who may only read cannot post photos.
    let (status, _, _) = pilot
        .send(post_multipart(photos, "lookout", &[("intent", "add-photos")], &[("evidence", "front.png", "image/png", PNG)]))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn back_to_listings_is_the_pilots_list() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/account/listings/lst_active", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hrefs(&html, "Back to listings"), ["/account/listings"]);
}

const LISTINGS: &str = "/account/listings";

/// The calls the list made to the API under \`path\`, as \`METHOD path body\`.
fn list_calls(pilot: &Pilot, path: &str) -> Vec<String> {
    let calls = pilot.stand.calls.lock().unwrap();
    calls.iter().filter(|c| c.path.starts_with(path)).map(|c| format!("{} {} {}", c.method, c.path, c.body)).collect()
}

#[tokio::test]
async fn the_sellers_listings_show_the_settings_counts_reliability_rows_and_fee_report() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(LISTINGS, Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    for words in [
        "Seller Listings Create, publish, and manage seller listings.",
        "Listings available Account-wide listing control",
        "Before you turn off listings 2 active listings will be hidden from buyers",
        "Schedule away window",
        "Current cap: 5 open orders Open orders right now: 3 of 5 Counted live from your orders.",
        "Active listings 2 Visible to buyers Draft listings 1 Not visible yet Paused listings 1 Withdrawn listings 0",
        "Seller reliability Objective, event-derived signals from the last 90 days",
        "On-time shipment rate 94.7% 38 shipments dispatched Cancellation rate 2.5% 40 orders, seller-caused only",
        "Dispute rate Not enough orders yet",
        "Charizard Active English",
        "Charizard Draft English Shipping measure missing",
        "near-mint",
        "1 photos",
        "$399.99 Marketplace $40.00. Net $359.99. Buyer shipping credit 2.5%",
        "Main shelf Terms resolved Oct 20, 2026, 12:00 PM UTC",
        "Page 1 of 3",
        "Fee Lock Report 1 fee lock records",
        "Locked Fee $40.00 Seller net $359.99 Terms Source Standard seller terms",
    ] {
        assert!(page.contains(words), "{words}: {page}");
    }
    // What marketplace reads, as it reads them.
    let reads = list_calls(&pilot, "/api/marketplace/account/");
    for read in [
        "GET /api/marketplace/account/listings?limit=100&offset=0 ",
        "GET /api/marketplace/account/listings/fee-lock-report?limit=100&offset=0 ",
        "GET /api/marketplace/account/listing-availability ",
        "GET /api/marketplace/account/order-capacity ",
        "GET /api/marketplace/account/seller-metrics ",
        "GET /api/marketplace/account/sales/order-capacity ",
    ] {
        assert!(reads.iter().any(|r| r == read), "{read}: {reads:?}");
    }
    // Each listing opens the pilot's page, and its box is in the bulk form.
    assert_eq!(hrefs(&html, "Open"), ["/account/listings/lst_active", "/account/listings/lst_draft"]);
    assert_eq!(hrefs(&html, "Create Listing"), ["/account/listings/new"]);
    assert!(html.contains(r#"<form id="bulk-form-id""#) || html.contains(r#"id="bulk-form""#), "{html}");
    assert!(
        html.contains(r#"<input type="checkbox" name="listingIds" value="lst_active" aria-label="Select Charizard">"#),
        "{html}"
    );
    assert_eq!(hrefs(&html, "Next page"), ["/account/listings?offset=100"]);
    assert!(html.contains(r#"<corten-live src="/account/listings/live"></corten-live>"#), "{html}");
    // Every setting posts to the page, and the date fields name the instant the script sends.
    assert!(
        html.contains(r#"data-instant="availableAgainAt""#) && html.contains(r#"data-instant="awayWindowStartsAt""#),
        "{html}"
    );
}

#[tokio::test]
async fn the_filters_and_pages_are_links_that_keep_each_other() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/account/listings?status=paused&search=Base%20Set&offset=100&limit=100", Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let reads = list_calls(&pilot, "/api/marketplace/account/listings?");
    assert_eq!(reads, ["GET /api/marketplace/account/listings?limit=100&offset=100&status=paused&search=Base%20Set "]);
    let page = text(&html);
    assert!(page.contains("Title: Base Set") && page.contains("Status: Paused") && page.contains("Page 2 of 3"), "{page}");
    assert_eq!(hrefs(&html, "Title: Base Set"), ["/account/listings?status=paused"]);
    assert_eq!(hrefs(&html, "Status: Paused"), ["/account/listings?search=Base%20Set"]);
    assert_eq!(hrefs(&html, "Previous page"), ["/account/listings?status=paused&amp;search=Base%20Set"]);
    assert_eq!(hrefs(&html, "Next page"), ["/account/listings?status=paused&amp;search=Base%20Set&amp;offset=200"]);
    // An unknown status is all of them, and too large a page the largest.
    let (_, _, _) = pilot.send(get("/account/listings?status=sold&limit=900", Some("lister"))).await;
    assert!(list_calls(&pilot, "/api/marketplace/account/listings?").iter().any(|r| r.contains("?limit=250&offset=0 ")));
}

#[tokio::test]
async fn a_setting_that_applies_goes_back_to_the_list_saying_what_it_set() {
    let pilot = Pilot::new().await;
    // Turn off listings: the script sent the date's instant where the seller is.
    let body = "intent=disable-listing-availability&reasonCategory=travel&availableAgainOn=2026-11-02&availableAgainAt=2026-11-02T06%3A00%3A00.000Z";
    let (status, headers, html) = pilot.send(post("/account/listings?status=active", "lister", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/account/listings?status=active&afterWrite="), "{to}");
    assert!(to.ends_with("&availabilityAction=disabled"), "{to}");
    let sent = list_calls(&pilot, "/api/marketplace/account/listing-availability/disable");
    assert_eq!(
        sent,
        [
            r#"POST /api/marketplace/account/listing-availability/disable {"availableAgainAt":"2026-11-02T06:00:00.000Z","availableAgainOn":"2026-11-02","reasonCategory":"travel"}"#
        ]
    );
    // Without the script there is no instant: the date is sent alone, only to be shown.
    let body = "intent=disable-listing-availability&reasonCategory=&availableAgainOn=2026-11-02";
    let (status, _, _) = pilot.send(post(LISTINGS, "lister", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    // The away window and the capacity, each saying what it set for the read that catches up.
    let body = "intent=schedule-away-window&awayWindowReasonCategory=audit&awayWindowStartsOn=2026-12-01&awayWindowEndsOn=\
                &awayWindowStartsAt=2026-12-01T06%3A00%3A00.000Z&awayWindowEndsAt=";
    let (status, headers, _) = pilot.send(post(LISTINGS, "lister", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(
        to.contains(
            "settingsAction=schedule-away-window&awayWindowReasonCategory=audit&awayWindowStartsAt=2026-12-01T06%3A00%3A00.000Z"
        ),
        "{to}"
    );
    assert!(!to.contains("awayWindowEndsAt"), "an indefinite window: {to}");
    for (body, action) in [
        ("intent=cancel-away-window", "settingsAction=cancel-away-window"),
        ("intent=set-order-capacity&maxOpenOrders=12", "settingsAction=set-order-capacity&maxOpenOrders=12"),
        ("intent=clear-order-capacity", "settingsAction=clear-order-capacity"),
        ("intent=enable-listing-availability", "availabilityAction=enabled"),
    ] {
        let (status, headers, _) = pilot.send(post(LISTINGS, "lister", body, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        assert!(headers[header::LOCATION].to_str().unwrap().contains(action), "{body}: {:?}", headers[header::LOCATION]);
    }
    let writes: Vec<String> =
        list_calls(&pilot, "/api/marketplace/account/").into_iter().filter(|c| !c.starts_with("GET")).collect();
    assert!(writes.iter().any(|w| w == "DELETE /api/marketplace/account/listing-availability/away-window "), "{writes:?}");
    assert!(writes.iter().any(|w| w == r#"POST /api/marketplace/account/order-capacity {"maxOpenOrders":12}"#), "{writes:?}");
    assert!(writes.iter().any(|w| w == "DELETE /api/marketplace/account/order-capacity "), "{writes:?}");
    assert!(writes.iter().any(|w| w == "POST /api/marketplace/account/listing-availability/enable {}"), "{writes:?}");
}

#[tokio::test]
async fn a_setting_refused_is_the_list_again_with_the_words_by_its_field() {
    let pilot = Pilot::new().await;
    // An away window with no reason, no start, or no instant (no script) is not sent.
    let (status, _, html) =
        pilot.send(post(LISTINGS, "lister", "intent=schedule-away-window&awayWindowStartsOn=2026-12-01", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let page = text(&html);
    assert!(page.contains("Choose a reason for the away window."), "{page}");
    assert!(page.contains("Your time zone could not be read, so nothing was scheduled."), "{page}");
    assert!(html.contains(r#"name="awayWindowStartsOn" value="2026-12-01""#), "the form as sent: {html}");
    assert!(
        html.contains(r#"aria-invalid="true" aria-describedby="away-form-id-awayWindowStartsOn-error""#)
            || html.contains("awayWindowStartsOn-error"),
        "{html}"
    );
    // An order capacity that is not a whole number of at least 1.
    let (status, _, html) = pilot.send(post(LISTINGS, "lister", "intent=set-order-capacity&maxOpenOrders=0", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Enter a whole-number order capacity of at least 1."), "{html}");
    assert!(html.contains(r#"name="maxOpenOrders" value="0""#), "{html}");
    assert!(list_calls(&pilot, "/api/marketplace/account/").iter().all(|c| c.starts_with("GET")), "nothing was written");
    // The API's refusals, in marketplace's words, by the field when they name one.
    let (status, _, html) = pilot.send(post(LISTINGS, "lister", "intent=set-order-capacity&maxOpenOrders=1000", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Enter a whole-number order capacity of at least 1."), "{html}");
    assert!(html.contains("maxOpenOrders-error"), "{html}");
    let (status, _, html) =
        pilot.send(post(LISTINGS, "lister", "intent=disable-listing-availability&reasonCategory=bogus", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Choose a valid availability reason."), "{html}");
    // Someone who may only read is refused, signed out signs in, and an account without listings
    // is marketplace's "Account access required" page, back to the list.
    let (status, _, html) = pilot.send(post(LISTINGS, "lookout", "intent=clear-order-capacity", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text(&html).contains("Use a selling account to manage listings"), "{html}");
    let (status, headers, _) = pilot.send(get(LISTINGS, None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("/sign-in?returnTo=%2Faccount%2Flistings"));
    let (status, _, html) = pilot.send(get(LISTINGS, Some("buyer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text(&html).contains("Use a selling account to manage listings"), "{html}");
    assert!(html.contains("/sign-in?returnTo=%2Faccount%2Flistings"), "{html}");
}

#[tokio::test]
async fn while_a_setting_catches_up_the_list_shows_what_was_set() {
    let pilot = Pilot::new().await;
    let to = format!("/account/listings?afterWrite={}&settingsAction=set-order-capacity&maxOpenOrders=9", receipt_at("43"));
    let (status, _, html) = pilot.send(get(&to, Some("lister"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(text(&html).contains("Current cap: 9 open orders"), "{html}");
    let to = format!("/account/listings?afterWrite={}&availabilityAction=disabled", receipt_at("43"));
    let (_, _, html) = pilot.send(get(&to, Some("lister"))).await;
    let page = text(&html);
    assert!(page.contains("Listings unavailable") && page.contains("Turn on listings"), "{page}");
    // The metrics and the open orders never wait for a write, and their failure shows them
    // unavailable, not the page's error.
    let (status, _, html) = pilot.send(get(LISTINGS, Some("lookout"))).await;
    assert_eq!(status, StatusCode::OK);
    let page = text(&html);
    assert!(page.contains("Seller reliability Some signals are temporarily unavailable"), "{page}");
    assert!(page.contains("Open order count is temporarily unavailable."), "{page}");
}

#[tokio::test]
async fn pause_selected_writes_each_listing_once_and_shows_each_outcome() {
    let pilot = Pilot::new().await;
    let body = "intent=bulk-pause-listings&listingIds=lst_active&listingIds=lst_locked&listingIds=lst_active";
    let (status, _, html) = pilot.send(post("/account/listings?status=active", "lister", body, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let page = text(&html);
    assert!(page.contains("1 succeeded, 1 failed"), "{page}");
    assert!(page.contains("Succeeded Listing lst_active"), "{page}");
    assert!(page.contains("Failed Listing lst_locked This listing change is not available."), "{page}");
    let writes = list_calls(&pilot, "/api/marketplace/account/listings/lst_");
    assert_eq!(
        writes,
        [
            "POST /api/marketplace/account/listings/lst_active/pause {}",
            "POST /api/marketplace/account/listings/lst_locked/pause {}"
        ]
    );
    // The page is read after the write that applied, with the filters it was posted with.
    let calls = pilot.stand.calls.lock().unwrap().clone();
    let read = calls.iter().rev().find(|c| c.path.starts_with("/api/marketplace/account/listings?")).unwrap();
    assert_eq!(read.path, "/api/marketplace/account/listings?limit=100&offset=0&status=active");
    assert_eq!(waits_for(&read.headers).as_deref(), Some("50"));
    // Nothing checked, and a listing whose write fails.
    let (status, _, html) = pilot.send(post(LISTINGS, "lister", "intent=bulk-withdraw-listings", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text(&html).contains("Check the listings to pause or withdraw first."), "{html}");
    let (status, _, _) = pilot.send(post(LISTINGS, "lister", "intent=bulk-pause-listings&listingIds=lst_broken", false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_change_to_the_accounts_listings_draws_the_counts_rows_and_report_again() {
    let pilot = Pilot::new().await;
    let events = pilot.events(get("/account/listings/live?status=active", Some("lister")), 1).await;
    let data = &events[0].2;
    assert!(data.contains(r#"id="listing-health-id""#) || data.contains("Listing health"), "{data}");
    assert!(data.contains(r#"value="lst_active""#) && data.contains("Fee Lock Report"), "{data}");
    let calls = pilot.stand.calls.lock().unwrap().clone();
    let realtime = calls.iter().find(|c| c.path.starts_with("/api/realtime/account/events")).unwrap();
    assert!(realtime.path.contains("topic=account%3Aacc_seller%3Alistings"), "{}", realtime.path);
    assert!(calls.iter().any(|c| c.path == "/api/marketplace/account/listings?limit=100&offset=0&status=active"));
}
