//! Read-after-write: a write's commit receipt rides the redirect to the next page, which sends it
//! to the API so the read waits for the write's projection. The same protocol as admin-web's
//! `navigateAfterWrite` and `createForwardedAuthHeaders` (contracts/http/responses.ts): a
//! receipt is `{observedAtMs, commitPosition?, sources}`, good for 30 seconds with 5 seconds of
//! clock skew, sent as `Chase-Sets-Read-After-Write: encodeURIComponent(JSON)`.
use std::time::{SystemTime, UNIX_EPOCH};

use corten::axum::http::HeaderMap;
use percent_encoding::{percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::api::URI_COMPONENT as COMPONENT;

const MAX_AGE_MS: u64 = 30_000;
const CLOCK_SKEW_MS: u64 = 5_000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    observed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    commit_position: Option<String>,
    /// `[{sourceContextName, maxGlobalPosition, eventIds}]`, passed on as the API wrote it.
    sources: Box<RawValue>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Receipt {
    /// The receipt of a write, from its response headers; `None` when the API sent none.
    pub fn from_response(headers: &HeaderMap) -> Option<Self> {
        let text = |name| headers.get(name).and_then(|v| v.to_str().ok());
        let commit_position = text("chase-sets-commit-position").filter(|p| !p.is_empty()).map(str::to_owned);
        let sources = text("chase-sets-commit-receipt")
            .and_then(|v| percent_decode_str(v).decode_utf8().ok())
            .and_then(|json| RawValue::from_string(json.into_owned()).ok())
            .filter(|raw| raw.get().starts_with('['))
            .unwrap_or_else(|| RawValue::from_string("[]".into()).expect("JSON"));
        if commit_position.is_none() && sources.get() == "[]" {
            return None;
        }
        Some(Receipt { observed_at_ms: now_ms(), commit_position, sources })
    }

    /// The receipt of a write known by its event alone (an attempt found by lookup, whose
    /// response was lost): `context`'s event `event_id` at `position`.
    pub fn of_event(context: &str, position: &str, event_id: &str) -> Option<Self> {
        let digits = !position.is_empty() && position.bytes().all(|b| b.is_ascii_digit());
        if !digits || event_id.is_empty() {
            return None;
        }
        let sources =
            serde_json::json!([{ "sourceContextName": context, "maxGlobalPosition": position, "eventIds": [event_id] }]);
        let sources = RawValue::from_string(sources.to_string()).ok()?;
        Some(Receipt { observed_at_ms: now_ms(), commit_position: Some(position.to_owned()), sources })
    }

    /// The receipt a write's result carries in its body (`CommandReceiptMetadata`: a durable job's
    /// `commandReceipt`), as `navigateAfterWrite` reads it: its `commitPosition` and its
    /// `commitPositions`, the sources. `None` when it points at nothing.
    pub fn of_metadata(commit_position: Option<&str>, sources: &RawValue) -> Option<Self> {
        let commit_position = commit_position.filter(|p| !p.is_empty()).map(str::to_owned);
        let sources = RawValue::from_string(sources.get().to_owned()).ok().filter(|raw| raw.get().starts_with('['))?;
        if commit_position.is_none() && sources.get().trim() == "[]" {
            return None;
        }
        Some(Receipt { observed_at_ms: now_ms(), commit_position, sources })
    }

    /// The `afterWrite` value a redirect carries: the JSON (the typed route encodes it).
    pub fn param(&self) -> String {
        serde_json::to_string(self).expect("a receipt serializes")
    }

    /// The receipt a page's `after_write` parameter carries, while it is fresh.
    pub fn from_param(param: Option<&str>) -> Option<Self> {
        Self::fresh(serde_json::from_str(param?).ok()?, now_ms())
    }

    fn fresh(self, now: u64) -> Option<Self> {
        let valid = self.observed_at_ms <= now + CLOCK_SKEW_MS && now.saturating_sub(self.observed_at_ms) <= MAX_AGE_MS;
        let points = self.commit_position.is_some() || self.sources.get().trim() != "[]";
        (valid && points).then_some(self)
    }

    /// The later of two receipts, by commit position: the one a read must wait for so both writes
    /// are in it. One without a position counts as the earlier.
    pub fn later(self, other: Receipt) -> Receipt {
        let position = |r: &Receipt| r.commit_position.as_deref().and_then(|p| p.parse::<u128>().ok());
        if position(&other) > position(&self) { other } else { self }
    }

    /// `Chase-Sets-Read-After-Write`.
    pub fn header(&self) -> String {
        utf8_percent_encode(&self.param(), COMPONENT).to_string()
    }
}

#[cfg(test)]
mod tests {
    use corten::axum::http::HeaderValue;

    use super::*;

    fn written() -> HeaderMap {
        let mut headers = HeaderMap::new();
        let sources = r#"[{"sourceContextName":"ordering","maxGlobalPosition":"42","eventIds":["e1"]}]"#;
        let encoded = utf8_percent_encode(sources, COMPONENT).to_string();
        headers.insert("chase-sets-commit-receipt", HeaderValue::from_str(&encoded).unwrap());
        headers.insert("chase-sets-commit-position", HeaderValue::from_static("42"));
        headers
    }

    #[test]
    fn a_receipt_rides_the_redirect_and_becomes_the_read_header() {
        let receipt = Receipt::from_response(&written()).unwrap();
        let param = receipt.param();
        assert!(param.contains(r#""commitPosition":"42","sources":[{"sourceContextName":"ordering""#), "{param}");
        let back = Receipt::from_param(Some(&param)).expect("fresh");
        let header = back.header();
        assert!(header.starts_with("%7B%22observedAtMs%22%3A"), "{header}");
        let decoded = percent_decode_str(&header).decode_utf8().unwrap();
        assert_eq!(decoded, param, "what decodeURIComponent reads back");
    }

    #[test]
    fn the_later_receipt_is_the_higher_commit_position() {
        let at =
            |position: &str| Receipt { commit_position: Some(position.into()), ..Receipt::from_response(&written()).unwrap() };
        assert_eq!(at("42").later(at("100")).commit_position.as_deref(), Some("100"), "compared as numbers");
        assert_eq!(at("100").later(at("42")).commit_position.as_deref(), Some("100"));
        let none = Receipt { commit_position: None, ..Receipt::from_response(&written()).unwrap() };
        assert_eq!(none.later(at("7")).commit_position.as_deref(), Some("7"));
    }

    #[test]
    fn stale_future_and_empty_receipts_are_dropped() {
        let receipt = |at: u64| Receipt { observed_at_ms: at, ..Receipt::from_response(&written()).unwrap() };
        assert!(receipt(1_000_000).fresh(1_030_000).is_some());
        assert!(receipt(1_000_000).fresh(1_030_001).is_none(), "older than 30 s");
        assert!(receipt(1_005_000).fresh(1_000_000).is_some(), "within the clock skew");
        assert!(receipt(1_005_001).fresh(1_000_000).is_none(), "from the future");
        assert!(Receipt::from_response(&HeaderMap::new()).is_none());
        assert!(Receipt::from_param(Some("{not json")).is_none());
        assert!(Receipt::from_param(None).is_none());
    }
}
