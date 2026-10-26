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
async fn platform(State(stand): State<Stand>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
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
            "watcher" => actor(&["accounts.view"]),
            // Sellers who may list at a price: `lister` has a Listing stock location, `starter` has
            // none until its ship-from setup is saved.
            "lister" | "starter" => actor(&["listings.view", "listings.manage", "offers.view"]),
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
    if let Some(answer) = listings(&stand, session, &method, uri.path(), &headers, &body) {
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
                "referenceId": "ref_base", "name": "Base Set", "typeKey": "expansion",
                "relationships": [{ "relationshipType": "part-of", "reference": { "referenceId": "ref_series", "name": "Base", "typeKey": "series", "relationships": [] } }],
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
/// else is unknown.
fn discovery_item(stand: &Stand, id: &str) -> Response {
    match id {
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
        html.contains(
            r#"href="http://localhost:7753/account/notifications?view=settings&amp;section=product-alerts&amp;afterWrite=%7B"#
        ),
        "{html}"
    );
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
        .find(|c| c.path.starts_with("/api/marketplace/items/charizard") && c.path != OVERLAY)
        .cloned()
        .unwrap();
    assert_eq!(waits_for(&item_read.headers).as_deref(), Some("31"), "the item waits for the publication");
    assert!(text(&html).contains("Your active listing is $400.00. Manage listing"), "{html}");
    assert_eq!(hrefs(&html, "Manage listing"), [format!("http://localhost:7753/account/listings/{LISTED}")]);
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
async fn the_mobile_dock_links_to_the_rail_on_each_side_or_to_the_options() {
    let pilot = Pilot::new().await;
    let dock = |html: &str| {
        let at = html.find(r#"<div class="item-detail__dock">"#).expect("the dock");
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
    assert_eq!(hrefs(&html, "Manage listing"), [format!("http://localhost:7753/account/listings/{LISTED}")]);
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
    assert_eq!(hrefs(&html, "Manage listing"), ["http://localhost:7753/account/listings/lst_1b6f3c1e4d2a4b8e9f001234567890ab"]);
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
