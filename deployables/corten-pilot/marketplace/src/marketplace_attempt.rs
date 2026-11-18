//! Marketplace's command attempts (`mutation-recovery`): a review, its reply, a review's report
//! and a listing's are each sent with the form's attempt (`attemptId`, the form's `SubmitKey`),
//! which Marketplace applies once and keeps with the request it was for.
//!
//! An answer that says nothing of what happened (none, or a 5xx) is settled as marketplace's
//! `runReviewMutation` settles it. A report is sent once more as the same attempt, which answers
//! what the first did. A review or a reply is looked up by its attempt
//! (`GET /mutation-attempts/{id}`): committed for this request is done, a conflict is another
//! request's attempt, not observed is nothing applied, and anything else cannot be confirmed. A
//! page that cannot confirm one, or that the attempt was another request's, offers no send until it
//! is opened again, as marketplace's form locks.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    api::{ApiError, Caller, OfferPolicyCalls as _},
    market_following::request_hash,
    recovery::valid_attempt,
};

/// What Marketplace kept of an attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum Observed {
    /// Applied, for this request: the owner's id and the version it committed.
    Committed { id: String, version: u64 },
    /// The attempt was another request's (`attempt_conflict`).
    Conflict,
    /// Marketplace holds nothing for it (`not-observed`): nothing was applied.
    Absent,
    /// The lookup failed, or answered something that is not this attempt's.
    Unsettled,
}

/// Why a page offers no send: the result could not be confirmed, or the attempt was another
/// request's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Locked {
    Unconfirmed,
    Conflict,
}

/// What `GET /mutation-attempts/{id}` answers (`marketplaceMutationRecoveryResultSchema`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Recovery {
    schema_version: u8,
    mutation_kind: String,
    attempt_key_fingerprint: String,
    actor_binding: ActorBinding,
    target: Target,
    canonical_request_hash: String,
    owner_status: String,
    #[serde(default)]
    #[allow(dead_code)]
    reason: Option<String>,
    owner_receipt: Option<OwnerReceipt>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActorBinding {
    account_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerReceipt {
    id: String,
    version: u64,
}

/// What `observed` says of `attempt`, a `kind` command on the `target_kind` `target` whose
/// canonical request hashes to `hash`: an answer for another attempt, target or request cannot
/// confirm it.
pub fn read(observed: Value, kind: &str, target_kind: &str, target: &str, attempt: &str, hash: &str) -> Observed {
    let Ok(recovery) = serde_json::from_value::<Recovery>(observed) else {
        return Observed::Unsettled;
    };
    let Ok(key) = serde_json::to_value(&recovery.target) else {
        return Observed::Unsettled;
    };
    let fingerprint = request_hash(&json!([recovery.actor_binding.account_id, kind, key, attempt]));
    let ours = recovery.schema_version == 1
        && recovery.mutation_kind == kind
        && recovery.attempt_key_fingerprint == fingerprint
        && recovery.target.kind == target_kind
        && recovery.target.id == target
        && recovery.canonical_request_hash == hash;
    if !ours {
        return Observed::Unsettled;
    }
    match (recovery.owner_status.as_str(), recovery.owner_receipt) {
        ("conflict", _) => Observed::Conflict,
        ("committed", Some(receipt)) => Observed::Committed { id: receipt.id, version: receipt.version },
        ("not-observed", _) => Observed::Absent,
        _ => Observed::Unsettled,
    }
}

/// Look up `attempt`, a `kind` command on the `target_kind` `target` sent as `request`
/// (`marketplaceCanonicalRequest`'s form of it).
pub async fn observe(
    caller: &Caller<'_>,
    kind: &str,
    target_kind: &str,
    target: &str,
    attempt: &str,
    request: &Value,
) -> Observed {
    let hash = request_hash(request);
    match caller.marketplace_attempt(attempt, kind, target, &hash).await {
        Ok(observed) => read(observed, kind, target_kind, target, attempt, &hash),
        Err(error) => {
            tracing::warn!("the {kind} attempt {attempt} could not be looked up: {error}");
            Observed::Unsettled
        }
    }
}

/// A review's or a reply's words as its canonical request holds them (`canonicalReviewText`):
/// trimmed, and none when that leaves nothing.
pub fn review_text(text: &str) -> Value {
    match text.trim() {
        "" => Value::Null,
        words => Value::from(words),
    }
}

/// An answer that says nothing of what happened: none, or the API failing.
pub fn lost(error: &ApiError) -> bool {
    error.status().is_none_or(|status| status.is_server_error())
}

/// What a write's refusal says of its attempt: another request's, or one Marketplace cannot
/// confirm (its history is incomplete).
pub fn locked_by(error: &ApiError) -> Option<Locked> {
    match error.code() {
        Some("attempt_conflict") => Some(Locked::Conflict),
        Some("history_incomplete") => Some(Locked::Unconfirmed),
        _ => None,
    }
}

/// The attempt a form posted, when it is one a form draws (a UUID v4, which Marketplace's
/// `marketplaceAttemptIdSchema` takes).
pub fn presented(attempt: &str) -> Option<&str> {
    valid_attempt(attempt).then_some(attempt)
}

/// What came of a report.
#[derive(Debug)]
pub enum Reported {
    Sent,
    /// The API's answer, which says what it did with the report.
    Refused(ApiError),
    Locked(Locked),
}

/// A report sent as its attempt by `send`, and sent once more when the answer was lost:
/// Marketplace answers the same attempt with what it did the first time. The second answer
/// settles it only when it is the report's (sent, or reported already); anything else cannot be
/// confirmed.
pub async fn report<F, Fut>(send: F) -> Reported
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<(), ApiError>>,
{
    let error = match send().await {
        Ok(()) => return Reported::Sent,
        Err(error) => error,
    };
    if let Some(locked) = locked_by(&error) {
        return Reported::Locked(locked);
    }
    if !lost(&error) {
        return Reported::Refused(error);
    }
    tracing::warn!("a report had no answer, sending its attempt again: {error}");
    match send().await {
        Ok(()) => Reported::Sent,
        Err(error) if error.code() == Some("report_already_submitted") => Reported::Refused(error),
        Err(error) if error.code() == Some("attempt_conflict") => Reported::Locked(Locked::Conflict),
        Err(error) => {
            tracing::warn!("a report's attempt sent again had no answer either: {error}");
            Reported::Locked(Locked::Unconfirmed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTEMPT: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    fn recovery(status: &str, hash: &str) -> Value {
        let key = json!({ "kind": "review", "id": "rev_1" });
        json!({
            "schemaVersion": 1, "mutationKind": "review.reply",
            "attemptKeyFingerprint": request_hash(&json!(["acc_1", "review.reply", key, ATTEMPT])),
            "actorBinding": { "accountId": "acc_1" }, "target": key, "canonicalRequestHash": hash,
            "ownerStatus": status, "ownerReceipt": { "id": "rev_1", "version": 2 },
        })
    }

    #[test]
    fn an_attempt_is_settled_only_by_its_own_answer() {
        let request = json!({ "reviewId": "rev_1", "feedback": review_text("  Thanks!  ") });
        let hash = request_hash(&request);
        let read = |v: Value| read(v, "review.reply", "review", "rev_1", ATTEMPT, &hash);
        assert_eq!(read(recovery("committed", &hash)), Observed::Committed { id: "rev_1".into(), version: 2 });
        assert_eq!(read(recovery("conflict", &hash)), Observed::Conflict);
        assert_eq!(read(recovery("not-observed", &hash)), Observed::Absent);
        assert_eq!(read(recovery("ambiguous", &hash)), Observed::Unsettled);
        assert_eq!(read(recovery("committed", "other")), Observed::Unsettled, "another request");
        let mut other = recovery("committed", &hash);
        other["actorBinding"]["accountId"] = json!("acc_2");
        assert_eq!(read(other), Observed::Unsettled, "another account's fingerprint");
        assert_eq!(read(json!({ "unexpected": true })), Observed::Unsettled);
    }

    #[test]
    fn review_words_are_trimmed_and_none_when_blank() {
        assert_eq!(review_text("  Thanks!\n"), json!("Thanks!"));
        assert_eq!(review_text(" \n "), Value::Null);
        assert!(presented(ATTEMPT).is_some() && presented("").is_none() && presented("not-a-key").is_none());
    }
}
