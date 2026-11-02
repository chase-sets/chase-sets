//! A Checkout Session entry, sent once (marketplace's `checkout-start-entry.ts` and the entry
//! attempt contract, `entry-attempt-contracts.ts`): one caller-created key per deliberate
//! submission, and after an answer that may have been lost, one lookup of that attempt instead of
//! sending it again. The owner and the caller hash the same canonical payload from the same body,
//! so the lookup names exactly what was sent.
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::api::{ApiError, Checkout, Entry, Started};
use platform::receipt::Receipt;

/// The kind and target every entry attempt names (`CHECKOUT_ENTRY_ATTEMPT_KIND`, `_TARGET`).
pub const KIND: &str = "checkout-entry";
pub const TARGET: &str = "session";

/// A key the API takes (`checkoutEntryAttemptKey`: `CHECKOUT_COMMAND_ATTEMPT_ID_PATTERN`), trimmed.
pub fn key(presented: &str) -> Option<&str> {
    let key = presented.trim();
    let valid = (22..=128).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(key)
}

/// Whether a submission is refused before anything is sent (`checkoutStartEntryRefusedBeforeSend`):
/// a malformed key never is sent, and only a cart's entry may go without one.
pub fn refused_before_send(presented: &str, cart: bool) -> bool {
    let presented = presented.trim();
    match key(presented) {
        Some(_) => false,
        None => !presented.is_empty() || !cart,
    }
}

/// An answer that cannot show the entry never reached Checkout (`isPossibleSendLoss`): none at all,
/// a timeout, or a server or gateway failure that is not a decided refusal (a closed checkout).
pub fn possible_send_loss(error: &ApiError) -> bool {
    match error.status() {
        None => true,
        Some(status) => status.as_u16() == 408 || (status.is_server_error() && error.code() != Some("checkout_closed")),
    }
}

/// What came of sending an entry once.
pub enum Opened {
    Started(Started, Option<Receipt>),
    /// It may have opened a Session, but neither its answer nor one lookup showed it.
    Ambiguous,
}

/// Sends `entry` once and never again (`openCheckoutSessionOnce`): its answer opens the Session; a
/// possible loss of a keyed entry looks the attempt up once, and only a committed attempt naming
/// its Session opens it. Anything else is ambiguous. A decided refusal is the error.
pub async fn open_once(caller: &impl Checkout, entry: &Entry) -> Result<Opened, ApiError> {
    match caller.open_session(entry).await {
        Ok((started, receipt)) => Ok(Opened::Started(started, receipt)),
        Err(error) if entry.key().and_then(key).is_some() && possible_send_loss(&error) => {
            tracing::warn!("a checkout entry may not have arrived, so it is looked up: {error}");
            Ok(match caller.entry_attempt(entry).await {
                Some((started, receipt)) => Opened::Started(started, receipt),
                None => Opened::Ambiguous,
            })
        }
        Err(error) => Err(error),
    }
}

/// The entry attempt's request hash (`computeCheckoutEntryRequestHash`): SHA-256, in hex, of
/// `checkout-entry-attempt-request/v1\n` and the canonical payload as JSON with sorted keys.
pub fn request_hash(body: &Value, anonymous_cart: Option<&str>) -> String {
    let mut text = String::from("checkout-entry-attempt-request/v1\n");
    crate::cart_attempt::canonical(&payload(body, anonymous_cart), &mut text);
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical payload of one entry body and the guest cart it presented (`checkoutEntryPayload`):
/// what the owner opens its Session from, without the page's display-only fields.
pub fn payload(body: &Value, anonymous_cart: Option<&str>) -> Value {
    let empty = Map::new();
    let request = body.as_object().unwrap_or(&empty);
    let goal = if request.get("optimizationGoal").and_then(Value::as_str) == Some("fewest-shipments") {
        "fewest-shipments"
    } else {
        "lowest-total"
    };
    let shipping = or(request, &["shippingOption"]).map_or_else(|| "standard".to_owned(), js_string);
    let given = request.get("source").and_then(Value::as_object);
    let source = given.unwrap_or(request);
    if given.and_then(|s| s.get("type")).and_then(Value::as_str) == Some("cart") {
        let mut cart = json!({
            "type": "cart",
            "readinessSnapshotId": text(source, &["readinessSnapshotId"]),
            "readinessSourceRevision": text(source, &["readinessSourceRevision"]),
            "readinessDecisions": decisions(source.get("readinessDecisions")),
        });
        if let Some(id) = anonymous_cart.map(str::trim).filter(|id| id.starts_with("anon_")) {
            cart["presentedAnonymousCartId"] = id.into();
        }
        return json!({ "source": cart, "shippingOption": shipping, "optimizationGoal": goal });
    }
    let options = options(source.get("selectedOptions"));
    if source.get("type").and_then(Value::as_str) == Some("offer-intent") {
        let offer = json!({
            "type": "offer-intent",
            "catalogItemId": text(source, &["catalogItemId"]),
            "productId": text(source, &["productId"]),
            "selectedOptions": options,
            "offerPriceAmount": text(source, &["offerPriceAmount", "priceAmount"]),
            "offerPriceCurrencyCode": text(source, &["offerPriceCurrencyCode", "priceCurrencyCode"]),
            "quantity": number(or(source, &["quantity", "quantityRequested"])),
        });
        return json!({ "source": offer, "shippingOption": shipping, "optimizationGoal": goal });
    }
    let seller = match source.get("sellerPreferenceId") {
        None | Some(Value::Null) => Value::Null,
        Some(value) if truthy(value) => js_string(value).into(),
        Some(_) => Value::Null,
    };
    let buy = json!({
        "type": "buy-now",
        "listingId": text(source, &["listingId"]),
        "catalogItemId": text(source, &["catalogItemId"]),
        "productId": text(source, &["productId"]),
        "selectedOptions": options,
        "quantity": number(or(source, &["quantity"])),
        "fulfillmentMode": "locked-listing",
        "lockedListingId": text(source, &["lockedListingId", "listingId"]).trim(),
        "sellerPreferenceId": seller,
    });
    let shipping = if matches!(shipping.as_str(), "expedited" | "priority") { shipping } else { "standard".to_owned() };
    json!({ "source": buy, "shippingOption": shipping, "optimizationGoal": goal })
}

/// The first of `keys` that is neither missing nor null (JavaScript's `a ?? b`).
fn or<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| map.get(*k).filter(|v| !v.is_null()))
}

/// `String(a ?? b ?? "")`.
fn text(map: &Map<String, Value>, keys: &[&str]) -> String {
    or(map, keys).map(js_string).unwrap_or_default()
}

/// `String(value)` for what a JSON body holds.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript's truthiness, for `String(value || "") || null`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `Number(value ?? 0)`, as `JSON.stringify` writes it: a whole number without a fraction, and
/// `null` for one that is not a number.
fn number(value: Option<&Value>) -> Value {
    let n = match value {
        None => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(_) => f64::NAN,
    };
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `parseSelectedOptions`: each entry that names both a dimension and an option.
fn options(value: Option<&Value>) -> Value {
    let Some(Value::Array(items)) = value else { return json!([]) };
    let picked = items
        .iter()
        .filter_map(Value::as_object)
        .filter(|o| o.contains_key("dimensionId") && o.contains_key("optionId"))
        .map(|o| json!({ "dimensionId": text(o, &["dimensionId"]), "optionId": text(o, &["optionId"]) }))
        .collect();
    Value::Array(picked)
}

/// `parseCartReadinessDecisionInput`: the line outcomes a cart may decide (removed, saved for
/// later) and the lower-price offer, accepted or declined, for its line and listing.
fn decisions(value: Option<&Value>) -> Value {
    let empty = Map::new();
    let source = value.and_then(Value::as_object).unwrap_or(&empty);
    let trimmed = |v: Option<&Value>| v.and_then(Value::as_str).map(str::trim).unwrap_or("").to_owned();
    let outcomes: Vec<Value> = match or(source, &["lineOutcomes", "line_outcomes"]) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|o| {
                let outcome = trimmed(o.get("outcome"));
                let line = trimmed(or(o, &["lineId", "line_id"]));
                (matches!(outcome.as_str(), "removed" | "save-for-later") && !line.is_empty())
                    .then(|| json!({ "lineId": line, "outcome": outcome }))
            })
            .collect(),
        _ => Vec::new(),
    };
    let optimization = source.get("optimization").and_then(Value::as_object).and_then(|o| {
        let decision = trimmed(o.get("decision"));
        let line = trimmed(or(o, &["lineId", "line_id"]));
        let listing = trimmed(or(o, &["listingId", "listing_id"]));
        (matches!(decision.as_str(), "accepted" | "declined") && !line.is_empty() && !listing.is_empty())
            .then(|| json!({ "decision": decision, "lineId": line, "listingId": listing }))
    });
    json!({ "lineOutcomes": outcomes, "optimization": optimization })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hashes from marketplace's own `checkoutEntryAttemptQuery` for the same bodies (run with
    /// tsx against `entry-attempt-contracts.ts`), so the lookup names what the owner kept.
    #[test]
    fn the_request_hash_is_the_owners() {
        let key = "chkentry_01JBXQ5V7Z3N4M8K2R6T9W1Y0A";
        let cart = json!({ "entryAttemptKey": key, "source": { "type": "cart", "readinessSnapshotId": "rs_1",
            "readinessSourceRevision": "7",
            "readinessDecisions": { "optimization": { "decision": "accepted", "lineId": "ln_1", "listingId": "lst_2" } } } });
        assert_eq!(request_hash(&cart, Some("anon_abc")), "06a4020523ee8e1255f8abe662773e4d0e9520fb3994548bfa75ce74aac348b7");
        let plain = json!({ "entryAttemptKey": key, "source": { "type": "cart", "readinessSnapshotId": "rs_1",
            "readinessSourceRevision": "7", "readinessDecisions": {} } });
        assert_eq!(request_hash(&plain, None), "80677d974b83b0a94c9cde1b934047aab5391417a970b149156834ae79a25793");
        let buy = json!({ "entryAttemptKey": key, "source": { "type": "buy-now", "listingId": "lst_chase",
            "fulfillmentMode": "locked-listing", "lockedListingId": null, "catalogItemId": "cat_charizard",
            "productId": "cat_charizard::dim_form:chc_raw", "itemTitle": "Charizard", "itemSubtitle": null,
            "selectedOptions": [{ "dimensionId": "dim_form", "optionId": "chc_raw", "label": "Raw" }],
            "productSummary": "Raw", "quantity": 2, "priceAmount": "412.50", "priceCurrencyCode": "USD",
            "sellerName": null, "availability": null, "fulfillment": null } });
        assert_eq!(request_hash(&buy, Some("anon_x")), "a5c55c24426c72ef2c6067b9e2303d11822ae45cbdd420501943ed0aaefa86fd");
        let offer = json!({ "entryAttemptKey": key, "source": { "type": "offer-intent", "catalogItemId": "cat_charizard",
            "productId": "p1", "itemTitle": "Charizard", "itemSubtitle": null, "selectedOptions": [], "productSummary": null,
            "offerPriceAmount": "300.00", "offerPriceCurrencyCode": "USD", "quantity": 1 } });
        assert_eq!(request_hash(&offer, None), "d2c417a84a1d09660a3810e43cbc11a3353181fbb405099626857110e708f7ee");
    }

    #[test]
    fn only_a_carts_entry_goes_without_a_key_and_a_malformed_one_is_never_sent() {
        let good = "chkentry_01JBXQ5V7Z3N4M8K2R6T9W1Y0A";
        assert!(!refused_before_send(good, false));
        assert!(!refused_before_send("", true));
        assert!(refused_before_send("", false));
        assert!(refused_before_send("short", true));
        assert!(refused_before_send("has a space but is long enough", false));
    }
}
