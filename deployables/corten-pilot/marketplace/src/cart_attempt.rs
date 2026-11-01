//! A cart write as the Checkout API's command attempt (features/command-attempts/api in Chase
//! Sets), as marketplace's `submitCheckoutCartAttempt` sends and resolves it.
//!
//! Every submission is one attempt with its own id: the form's `SubmitKey` (a UUID, which the
//! API's `^[A-Za-z0-9_-]{22,128}$` takes), or one drawn here for a post without it. The API
//! applies an attempt once, so a form sent twice (a double click, a resend after a lost answer)
//! cannot apply twice. An answer that may have been lost (no answer, 408 or 5xx) is looked up
//! exactly once, by the attempt id and the request's hash; nothing is ever resent on its own.
//! What the attempt then is decides the page: succeeded redirects to the cart with the write's
//! receipt; partial and failed-safe draw the cart with what was not applied; ambiguous draws it
//! with the cart's writes paused until the buyer sends the same change again or refreshes.
use corten::axum::http::StatusCode;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::api::{Caller, CartAnswer, CartAttempt, CartWrite, Checkout as _};
use platform::receipt::Receipt;

/// What one submission came to (`CheckoutCommandAttemptResolvedState`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Succeeded,
    /// Some commands applied, others not.
    Partial,
    /// Nothing applied.
    FailedSafe,
    /// Whether it applied is not known.
    Ambiguous,
}

impl State {
    pub fn as_str(&self) -> &'static str {
        match self {
            State::Succeeded => "succeeded",
            State::Partial => "partial",
            State::FailedSafe => "failed-safe",
            State::Ambiguous => "ambiguous",
        }
    }
}

/// A submission's outcome: its state, the API's message for a refusal, the messages of the
/// commands that did not apply, and the receipt the next read waits for.
#[derive(Debug)]
pub struct Outcome {
    pub state: State,
    pub message: Option<String>,
    pub not_applied: Vec<Option<String>>,
    pub receipt: Option<Receipt>,
}

/// The state an attempt the API kept resolves to (`checkoutCommandAttemptStateForResult`).
pub fn state_of(attempt: &CartAttempt) -> State {
    match attempt.owner_status.as_str() {
        "committed" => {
            let succeeded = attempt.vector.iter().filter(|c| c.outcome == "succeeded").count();
            if succeeded == attempt.vector.len() {
                State::Succeeded
            } else if succeeded == 0 {
                State::FailedSafe
            } else {
                State::Partial
            }
        }
        "failed-safe" | "conflict" => State::FailedSafe,
        _ => State::Ambiguous,
    }
}

/// Sends `write` as attempt `attempt` and resolves the answer, looking it up once if it may have
/// been lost. A 401 or 403 is the caller's, not the attempt's, and is returned as it is.
pub async fn submit(caller: &Caller<'_>, attempt: &str, write: &CartWrite) -> Result<Outcome, StatusCode> {
    let (attempt_kept, message, receipt, refused) = match caller.cart_write(attempt, write).await {
        CartAnswer::Answered { status, .. } if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
            return Err(status);
        }
        CartAnswer::Answered { status, attempt, message, receipt } => (attempt, message, receipt, !status.is_success()),
        CartAnswer::Lost => {
            let kept = caller.cart_attempt(attempt, write).await;
            let receipt = kept.as_ref().and_then(lookup_receipt);
            (kept, None, receipt, false)
        }
    };
    let state = match &attempt_kept {
        Some(kept) => state_of(kept),
        // A refusal without an attempt applied nothing; an answer without one is not known.
        None if refused => State::FailedSafe,
        None => State::Ambiguous,
    };
    let not_applied = attempt_kept
        .iter()
        .flat_map(|a| a.vector.iter().filter(|c| c.outcome != "succeeded").map(|c| c.message.clone()))
        .collect();
    let receipt = receipt.or_else(|| attempt_kept.as_ref().and_then(lookup_receipt));
    Ok(Outcome { state, message, not_applied, receipt })
}

/// The receipt an attempt found by lookup proves: its event, appended with the cart's events
/// (`checkoutCartAttemptCommitSource`).
fn lookup_receipt(attempt: &CartAttempt) -> Option<Receipt> {
    let commit = attempt.commit_receipt.as_ref()?;
    Receipt::of_event("checkout", &commit.global_position, &commit.event_id)
}

/// An attempt id the API takes (`CHECKOUT_COMMAND_ATTEMPT_ID_PATTERN`), or a new one: a post
/// without a valid id (no script ran, or the field was lost) is still one attempt.
pub fn attempt_id(presented: &str) -> String {
    let valid =
        (22..=128).contains(&presented.len()) && presented.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid { presented.to_owned() } else { uuid::Uuid::new_v4().to_string() }
}

/// The attempt's request hash (`computeCheckoutCommandAttemptRequestHash`): SHA-256, in hex, of
/// `checkout-command-attempt-request/v1\n` and the body as sent without its attempt id, as JSON
/// with every object's keys sorted.
pub fn request_hash(body: &Value) -> String {
    let mut text = String::from("checkout-command-attempt-request/v1\n");
    canonical(body, &mut text);
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// `canonicalJson`: arrays in order, object keys sorted by code unit, values as `JSON.stringify`
/// writes them.
pub(crate) fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{CartCommand, CommandOutcome};

    #[test]
    fn the_request_hash_is_the_web_hosts() {
        // computeCheckoutCommandAttemptRequestHash({ attemptId: "..", commands: [
        //   { type: "quantity", lineId: "cli_1", quantity: 2 }, { type: "remove", lineId: "cli_2" } ] })
        let commands =
            [CartCommand::Quantity { line_id: "cli_1".into(), quantity: 2 }, CartCommand::Remove { line_id: "cli_2".into() }];
        let mut text = String::new();
        canonical(&serde_json::json!({ "commands": commands }), &mut text);
        assert_eq!(
            text,
            r#"{"commands":[{"lineId":"cli_1","quantity":2,"type":"quantity"},{"lineId":"cli_2","type":"remove"}]}"#
        );
        // The web hosts' function, run with tsx on the same body.
        assert_eq!(
            request_hash(&CartWrite::commands(&commands).body),
            "173a4d1a79c13b46ffbe7659d1ab2d908e1258c7d2e2fc75936af85f476a4bc5"
        );
    }

    #[test]
    fn an_attempt_resolves_as_the_web_hosts_do() {
        let attempt = |status: &str, outcomes: &[&str]| CartAttempt {
            owner_status: status.into(),
            vector: outcomes.iter().map(|o| CommandOutcome { outcome: (*o).into(), message: None }).collect(),
            commit_receipt: None,
        };
        assert_eq!(state_of(&attempt("committed", &["succeeded", "succeeded"])), State::Succeeded);
        assert_eq!(state_of(&attempt("committed", &["succeeded", "conflict"])), State::Partial);
        assert_eq!(state_of(&attempt("committed", &["error"])), State::FailedSafe);
        assert_eq!(state_of(&attempt("conflict", &[])), State::FailedSafe);
        assert_eq!(state_of(&attempt("failed-safe", &[])), State::FailedSafe);
        assert_eq!(state_of(&attempt("not-observed", &[])), State::Ambiguous);
        assert_eq!(state_of(&attempt("ambiguous", &[])), State::Ambiguous);
    }

    #[test]
    fn a_post_without_a_valid_attempt_id_gets_one() {
        let key = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        assert_eq!(attempt_id(key), key);
        assert_ne!(attempt_id("short"), "short");
        assert_ne!(attempt_id("has spaces in it, which no attempt id may"), "has spaces in it, which no attempt id may");
        assert_eq!(attempt_id("").len(), 36);
    }
}
