//! Market following on the buyer's submitted offers (marketplace's `MarketFollowingOfferControls`
//! and `submittedOfferPolicyAction`), on the list and on an offer's page: a policy that reprices
//! the chosen open offers to the Market Price, with an adjustment, up to each offer's cap.
//!
//! The section lists the policies that name the page's offers, each a link that opens it
//! (`?policy={id}`, marketplace's `load-policy`), and the opened policy's status and authority.
//! Unless it is stopped, the steps follow: Preview the chosen offers with their caps and the
//! adjustment, Authorize the reviewed preview with consent, Pause an active policy, and Stop,
//! which asks for its own confirmation. Every step is a form that works without JavaScript. One
//! the API applies redirects to the page with the policy opened, as the command left it; a
//! refused step answers with the page again and keeps what was sent. A read that fails before a
//! command (the API failed, did not answer, or refused the caller) is the page's read failure, not
//! a refusal of what was sent, and every chosen offer's cap is checked before a new policy's draft
//! is made.
//!
//! A command with no definite answer is looked up once by its attempt
//! (`recoverMarketplaceCommand`): a committed attempt for this policy and request is the policy as
//! it now reads, at the version the attempt committed; anything else says the result could not be
//! confirmed, and the section offers no step until the page is opened again.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use corten::http::StatusCode;

use crate::{
    api::{ApiError, Caller, OfferPolicy, OfferPolicyCalls as _, PolicySelection, PolicyTerms, SubmittedOffer},
    cart_attempt::canonical,
    items::Raw,
};

/// The form's fields.
pub const STEP: &str = "step";
pub const POLICY: &str = "policyId";
pub const VERSION: &str = "expectedVersion";
pub const ATTEMPT: &str = "attemptId";
pub const OPERATION: &str = "operationId";
pub const OFFER: &str = "offerId";
pub const ADJUSTMENT: &str = "adjustment";
pub const PREVIEW: &str = "previewId";
pub const CONSENT: &str = "consent";
pub const CONFIRM_STOP: &str = "confirmStop";

/// An offer's cap's field.
pub fn cap_field(offer: &str) -> String {
    format!("cap.{offer}")
}

/// The mutation kind marketplace records a policy command's attempt under.
const KIND: &str = "offer-policy.command";

/// Why a step did not answer with a policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The input or the API refused it (`invalid_authority`).
    Invalid,
    /// The offers or the Market Price evidence changed under the preview (`stale_preview`).
    Stale,
    /// No definite answer, and the lookup could not confirm one (`ambiguous`).
    Ambiguous,
}

/// What a refused preview sent, to draw again.
#[derive(Clone, Debug, Default)]
pub struct Posted {
    pub offers: Vec<String>,
    pub caps: BTreeMap<String, String>,
    pub adjustment: String,
}

/// What a step came to.
#[derive(Debug, Default)]
pub struct Ran {
    /// The policy as the command left it.
    pub policy: Option<OfferPolicy>,
    pub problem: Option<Problem>,
    /// The policy the step was for, opened again when the step answered none.
    pub policy_id: Option<String>,
    pub posted: Option<Posted>,
    /// The API asked for a sign-in.
    pub unauthorized: bool,
    /// A read before any command failed (a 5xx, no answer, or a 403): the page's read failure,
    /// not a refusal of what was sent.
    pub read_error: Option<ApiError>,
}

impl Ran {
    fn refused(problem: Problem, policy_id: Option<String>, posted: Option<Posted>) -> Ran {
        Ran { problem: Some(problem), policy_id, posted, ..Ran::default() }
    }

    /// The policy a step's command answered with, when it did: the page opens it at its own address.
    pub fn answered(&self) -> Option<&str> {
        match (&self.policy, self.problem) {
            (Some(policy), None) => policy.policy_id.as_deref().or(self.policy_id.as_deref()),
            _ => None,
        }
    }
}

/// What the section shows.
#[derive(Debug, Default)]
pub struct Following {
    /// The policies naming the page's offers.
    pub policies: Vec<OfferPolicy>,
    /// The opened policy, as read or as the last step left it.
    pub policy: Option<OfferPolicy>,
    pub problem: Option<Problem>,
    pub posted: Option<Posted>,
    /// A new policy's id, for a first preview (`bop_{uuid}`).
    pub draft_id: String,
}

impl Following {
    /// The offers bound to some policy's authority: only that policy may choose them.
    pub fn bound(&self) -> Vec<&str> {
        self.policies.iter().flat_map(|p| p.authority.iter().flat_map(|a| a.offers.iter().map(|o| o.offer_id.as_str()))).collect()
    }

    /// The terms the form starts from: the opened policy's preview, else its authority.
    pub fn terms(&self) -> Option<&PolicyTerms> {
        let policy = self.policy.as_ref()?;
        policy.preview.as_ref().map(|p| &p.terms).or(policy.authority.as_ref())
    }

    /// A step's buttons are off while a result could not be confirmed.
    pub fn blocked(&self) -> bool {
        self.problem == Some(Problem::Ambiguous)
    }
}

/// The section for `offers`: the policies naming them, and the opened one (`opened`, or the one
/// a step was for), with what the step came to. `Err` when the policies cannot be read, which the
/// page answers as its own read failure, as marketplace's loaders do.
pub async fn following(
    caller: &Caller<'_>,
    offers: &[SubmittedOffer],
    opened: Option<&str>,
    ran: Option<Ran>,
) -> Result<Following, ApiError> {
    let ids: Vec<&str> = offers.iter().map(|o| o.offer_id.as_str()).collect();
    let policies = if ids.is_empty() { Vec::new() } else { caller.offer_policies(&ids).await?.items };
    let stepped = ran.is_some();
    let ran = ran.unwrap_or_default();
    let mut problem = ran.problem;
    let policy = match ran.policy {
        Some(policy) => Some(policy),
        None => match ran.policy_id.as_deref().or(opened).filter(|id| identity(id)) {
            Some(id) => match caller.offer_policy(id).await {
                Ok(policy) => Some(policy),
                // A first preview refused before its draft was made has no policy to open.
                Err(error) if problem.is_some() && error.status() == Some(StatusCode::NOT_FOUND) => None,
                Err(error) => {
                    tracing::warn!("the policy {id} could not be read: {error}");
                    // After a step, a policy that cannot be read again is not drawn as a new
                    // draft (its steps would start another policy): the steps wait for a reload.
                    problem = Some(if stepped { Problem::Ambiguous } else { Problem::Invalid });
                    None
                }
            },
            None => None,
        },
    };
    Ok(Following { policies, policy, problem, posted: ran.posted, draft_id: format!("bop_{}", uuid::Uuid::new_v4()) })
}

/// A step the form sent, for the page's `offers`.
pub async fn run(caller: &Caller<'_>, offers: &[SubmittedOffer], raw: &Raw) -> Ran {
    let policy_id = field(raw, POLICY).to_owned();
    if !identity(&policy_id) {
        return Ran::refused(Problem::Invalid, None, None);
    }
    let Ok(expected) = field(raw, VERSION).parse::<u64>() else {
        return Ran::refused(Problem::Invalid, Some(policy_id), None);
    };
    let attempt = attempt_id(field(raw, ATTEMPT));
    let operation =
        Some(field(raw, OPERATION)).filter(|o| identity(o)).map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
    let operation = json!({ "operationId": operation, "attemptId": attempt, "expectedVersion": expected });
    let command = match field(raw, STEP) {
        "preview" => return preview(caller, offers, raw, policy_id, expected, operation).await,
        "authorize" => {
            let preview = field(raw, PREVIEW);
            let hex = preview.len() == 64 && preview.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            if field(raw, CONSENT) != "true" || !hex {
                return Ran::refused(Problem::Invalid, Some(policy_id), None);
            }
            with(operation, json!({ "type": "AuthorizeBuyerOfferPolicy", "previewId": preview, "consent": true }))
        }
        "pause" => with(operation, json!({ "type": "PauseBuyerOfferPolicy" })),
        "stop" if field(raw, CONFIRM_STOP) == "true" => with(operation, json!({ "type": "StopBuyerOfferPolicy" })),
        _ => return Ran::refused(Problem::Invalid, Some(policy_id), None),
    };
    answered(send(caller, &policy_id, &command).await, policy_id, None)
}

/// Preview the chosen offers (`preview()`, then the action's draft for a new policy).
async fn preview(
    caller: &Caller<'_>,
    offers: &[SubmittedOffer],
    raw: &Raw,
    policy_id: String,
    expected: u64,
    operation: Value,
) -> Ran {
    let chosen: Vec<String> = raw.get(OFFER).map(|v| v.all().to_vec()).unwrap_or_default();
    let posted = Posted {
        caps: offers
            .iter()
            .filter_map(|o| {
                raw.get(&cap_field(&o.offer_id)).map(|_| (o.offer_id.clone(), field(raw, &cap_field(&o.offer_id)).to_owned()))
            })
            .collect(),
        adjustment: field(raw, ADJUSTMENT).to_owned(),
        offers: chosen.clone(),
    };
    let refuse = |problem| Ran::refused(problem, Some(policy_id.clone()), Some(posted.clone()));
    let selected: Vec<&SubmittedOffer> =
        offers.iter().filter(|o| o.status == "submitted" && chosen.contains(&o.offer_id)).collect();
    let current = if expected > 0 {
        match caller.offer_policy(&policy_id).await {
            Ok(policy) => Some(policy),
            Err(error) => return read_failed(error, policy_id, Some(posted)),
        }
    } else {
        None
    };
    if selected.is_empty() || current.as_ref().is_some_and(|p| p.status() == "stopped") {
        return refuse(Problem::Invalid);
    }
    let ids: Vec<&str> = selected.iter().map(|o| o.offer_id.as_str()).collect();
    let versions = match caller.offer_policies(&ids).await {
        Ok(list) => list.offer_versions,
        Err(error) => return read_failed(error, policy_id, Some(posted)),
    };
    let Some(currency) = selected[0].price_currency_code.clone().or_else(|| current.as_ref().and_then(|p| p.currency.clone()))
    else {
        return refuse(Problem::Invalid);
    };
    let version = |id: &str| {
        let known = current.as_ref().and_then(|p| p.offer_versions.get(id)).copied().unwrap_or(0);
        known.max(versions.get(id).copied().unwrap_or(0))
    };
    if selected.iter().any(|o| version(&o.offer_id) == 0) {
        return refuse(Problem::Stale);
    }
    let Some(bps) = adjustment_bps(&posted.adjustment) else { return refuse(Problem::Invalid) };
    // Each chosen offer's cap is checked before anything is sent, as marketplace parses the whole
    // command first, so a refused cap makes no draft.
    let cap = |o: &SubmittedOffer| posted.caps.get(&o.offer_id).cloned().unwrap_or_else(|| o.price_amount.clone());
    if selected.iter().any(|o| !cap_ok(&cap(o))) {
        return refuse(Problem::Invalid);
    }
    if selected.iter().any(|o| o.price_currency_code.as_deref() != Some(currency.as_str())) {
        return refuse(Problem::Invalid);
    }
    let terms = PolicyTerms {
        currency,
        adjustment_bps: bps,
        offers: selected
            .iter()
            .map(|o| PolicySelection {
                offer_id: o.offer_id.clone(),
                offer_version: version(&o.offer_id),
                catalog_item_id: o.catalog_catalog_item_id.clone(),
                product_id: o.product_id.clone(),
                selected_options: o.selected_options.clone(),
                quantity: o.quantity_requested,
                maximum_unit_item_amount: canonical_amount(&cap(o)),
            })
            .collect(),
    };
    let mut command = with(operation, json!({ "type": "PreviewBuyerOfferPolicy", "terms": terms }));
    if expected == 0 {
        // A new policy is made first, its draft's attempt the policy's own (the action's create).
        let create = json!({
            "type": "CreateBuyerOfferPolicy",
            "expectedVersion": 0,
            "operationId": format!("create_{policy_id}"),
            "attemptId": format!("{policy_id:_<22}"),
        });
        match send(caller, &policy_id, &create).await {
            Ok(draft) => command["expectedVersion"] = json!(draft.version),
            Err(sent) => return answered(Err(sent), policy_id, Some(posted)),
        }
    }
    answered(send(caller, &policy_id, &command).await, policy_id, Some(posted))
}

/// A command's answer as the step's: the policy, or why not (a stale preview opens the policy again).
fn answered(answer: Result<OfferPolicy, Sent>, policy_id: String, posted: Option<Posted>) -> Ran {
    match answer {
        Ok(policy) => Ran { policy: Some(policy), policy_id: Some(policy_id), ..Ran::default() },
        Err(Sent::Refused(error)) => failed(error, policy_id, posted),
        Err(Sent::Ambiguous) => Ran::refused(Problem::Ambiguous, Some(policy_id), posted),
    }
}

/// A read before the step's commands that failed: the page's read failure when the API did not
/// answer, failed or refused the caller, else as a command's answer.
fn read_failed(error: ApiError, policy_id: String, posted: Option<Posted>) -> Ran {
    match error.status() {
        Some(status) if status.is_client_error() && status != StatusCode::FORBIDDEN => failed(error, policy_id, posted),
        _ => Ran { read_error: Some(error), ..Ran::default() },
    }
}

/// A call's error as the action reads it: a sign-in, a stale preview, or a refusal.
fn failed(error: ApiError, policy_id: String, posted: Option<Posted>) -> Ran {
    match (error.status(), error.code()) {
        (Some(StatusCode::UNAUTHORIZED), _) => Ran { unauthorized: true, ..Ran::default() },
        (_, Some("stale_preview")) => Ran::refused(Problem::Stale, Some(policy_id), posted),
        _ => Ran::refused(Problem::Invalid, Some(policy_id), posted),
    }
}

/// `operation`'s fields and `command`'s, as one command.
fn with(operation: Value, mut command: Value) -> Value {
    if let (Value::Object(fields), Some(into)) = (operation, command.as_object_mut()) {
        into.extend(fields);
    }
    command
}

/// Why a command did not answer with a policy.
#[derive(Debug)]
pub enum Sent {
    /// The API's definite refusal.
    Refused(ApiError),
    /// No definite answer, and the lookup did not confirm one.
    Ambiguous,
}

/// A command to the policy, looked up once when its answer is not definite
/// (`commandBuyerOfferPolicy` through `recoverMarketplaceCommand`).
pub async fn send(caller: &Caller<'_>, policy_id: &str, command: &Value) -> Result<OfferPolicy, Sent> {
    let attempt = command["attemptId"].as_str().unwrap_or_default().to_owned();
    let mut request = command.clone();
    if let Some(fields) = request.as_object_mut() {
        fields.remove("attemptId");
    }
    let hash = request_hash(&request);
    let error = match caller.command_offer_policy(policy_id, command).await {
        Ok(policy) => return Ok(policy),
        Err(error) if definite(&error) => return Err(Sent::Refused(error)),
        Err(error) => error,
    };
    tracing::warn!("a policy command had no definite answer, looking up its attempt: {error}");
    let observed = match caller.marketplace_attempt(&attempt, KIND, policy_id, &hash).await {
        Ok(observed) => observed,
        Err(error) => {
            tracing::warn!("the policy command's attempt {attempt} could not be looked up: {error}");
            return Err(Sent::Ambiguous);
        }
    };
    let Some(version) = committed(observed, &attempt, policy_id, &hash) else {
        tracing::warn!("the policy command's attempt {attempt} is not a committed attempt for this request");
        return Err(Sent::Ambiguous);
    };
    match caller.offer_policy(policy_id).await {
        Ok(policy) if policy.version == version && policy.policy_id.is_some() => Ok(policy),
        Ok(policy) => {
            tracing::warn!("the policy {policy_id} reads at {}, not the committed {version}", policy.version);
            Err(Sent::Ambiguous)
        }
        Err(error) => {
            tracing::warn!("the policy {policy_id} could not be read after its attempt committed: {error}");
            Err(Sent::Ambiguous)
        }
    }
}

/// An answer the action can act on: any status below 500 but a lookup that found the history
/// incomplete (`isDefiniteMarketplaceCommandResponse`).
fn definite(error: &ApiError) -> bool {
    error.status().is_some_and(|s| s.as_u16() < 500) && error.code() != Some("history_incomplete")
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

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerReceipt {
    #[allow(dead_code)]
    id: String,
    version: u64,
}

/// The version a looked-up attempt committed, when it is this attempt's, for this policy and this
/// request, and committed.
fn committed(observed: Value, attempt: &str, policy_id: &str, hash: &str) -> Option<u64> {
    let recovery: Recovery = serde_json::from_value(observed).ok()?;
    let target = serde_json::to_value(&recovery.target).ok()?;
    let fingerprint = request_hash(&json!([recovery.actor_binding.account_id, KIND, target, attempt]));
    let receipt = recovery.owner_receipt?;
    (recovery.schema_version == 1
        && recovery.owner_status == "committed"
        && recovery.mutation_kind == KIND
        && recovery.attempt_key_fingerprint == fingerprint
        && recovery.target.id == policy_id
        && recovery.target.kind == "offer-policy"
        && recovery.canonical_request_hash == hash)
        .then_some(receipt.version)
}

/// SHA-256, in hex, of the value as JSON with every object's keys sorted
/// (`marketplaceRequestHash`).
pub fn request_hash(value: &Value) -> String {
    let mut text = String::new();
    canonical(value, &mut text);
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A policy or operation id the API takes (`identity`).
pub fn identity(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// An attempt id the API takes (`marketplaceAttemptIdSchema`), or a new one.
fn attempt_id(presented: &str) -> String {
    if (22..=128).contains(&presented.len()) && identity(presented) {
        presented.to_owned()
    } else {
        uuid::Uuid::new_v4().to_string()
    }
}

/// The adjustment, as a percent from 0 to -25 with up to two decimals, in basis points.
pub fn adjustment_bps(text: &str) -> Option<i64> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let ok = |part: &str, most: usize| (1..=most).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    if !ok(whole, 2) || (digits.contains('.') && !ok(fraction, 2)) {
        return None;
    }
    let bps = whole.parse::<i64>().ok()? * 100 + format!("{fraction:0<2}").parse::<i64>().ok()?;
    let bps = if negative { -bps } else { bps };
    (-2500..=0).contains(&bps).then_some(bps)
}

/// Basis points as the percent the page writes (`String(bps / 100)`).
pub fn percent(bps: i64) -> String {
    let text = format!("{:.2}", bps as f64 / 100.0);
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" { "0".to_owned() } else { text.to_owned() }
}

/// A cap the policy contract takes (`amount`): a positive amount of at most two decimals, at most
/// 13 characters once written canonically.
pub fn cap_ok(text: &str) -> bool {
    let canonical = canonical_amount(text);
    let Some((whole, fraction)) = canonical.split_once('.') else { return false };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.len() == 2
        && fraction.bytes().all(|b| b.is_ascii_digit())
        && canonical.len() <= 13
        && canonical != "0.00"
}

/// A cap as the command sends it: a plain amount with two decimals, anything else as typed.
pub fn canonical_amount(text: &str) -> String {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || !digits(whole)
        || !digits(fraction)
        || fraction.len() > 2
        || (text.contains('.') && fraction.is_empty())
    {
        return text.to_owned();
    }
    let whole = whole.trim_start_matches('0');
    format!("{}.{fraction:0<2}", if whole.is_empty() { "0" } else { whole })
}

/// The value a form sent as `name`, trimmed.
fn field<'a>(raw: &'a Raw, name: &str) -> &'a str {
    raw.get(name).and_then(|v| v.all().first()).map_or("", |v| v.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_adjustment_is_zero_to_minus_twenty_five_percent_in_hundredths() {
        assert_eq!(adjustment_bps("0"), Some(0));
        assert_eq!(adjustment_bps("-1.5"), Some(-150));
        assert_eq!(adjustment_bps("-0.01"), Some(-1));
        assert_eq!(adjustment_bps("-25"), Some(-2500));
        for refused in ["1", "-25.01", "-26", "-1.234", "", "-", "1.", "-.5", "abc", "-100"] {
            assert_eq!(adjustment_bps(refused), None, "{refused}");
        }
        assert_eq!(
            (percent(-150), percent(0), percent(-5), percent(-2500)),
            ("-1.5".into(), "0".into(), "-0.05".into(), "-25".into())
        );
    }

    #[test]
    fn a_cap_is_sent_with_two_decimals_and_anything_else_as_typed() {
        assert_eq!(canonical_amount("5"), "5.00");
        assert_eq!(canonical_amount("012.5"), "12.50");
        assert_eq!(canonical_amount("00"), "0.00");
        assert_eq!(canonical_amount("12.34"), "12.34");
        for kept in ["12.345", "", "1,000", "12.", ".5", "-3"] {
            assert_eq!(canonical_amount(kept), kept);
        }
    }

    #[test]
    fn a_looked_up_attempt_counts_only_when_it_committed_this_request_for_this_policy() {
        let attempt = "attempt_0123456789abcdefghij";
        let hash = request_hash(&json!({ "type": "PauseBuyerOfferPolicy" }));
        let target = json!({ "kind": "offer-policy", "id": "bop_1" });
        let fingerprint = request_hash(&json!(["acc_buyer", KIND, target, attempt]));
        let observed = |change: fn(&mut Value)| {
            let mut v = json!({
                "schemaVersion": 1, "mutationKind": KIND, "attemptKeyFingerprint": fingerprint,
                "actorBinding": { "accountId": "acc_buyer" }, "target": target, "canonicalRequestHash": hash,
                "ownerStatus": "committed", "ownerReceipt": { "id": "bop_1", "version": 4 },
            });
            change(&mut v);
            committed(v, attempt, "bop_1", &hash)
        };
        assert_eq!(observed(|_| {}), Some(4));
        assert_eq!(observed(|v| v["ownerStatus"] = json!("prepared")), None);
        assert_eq!(observed(|v| v["canonicalRequestHash"] = json!("0".repeat(64))), None);
        assert_eq!(observed(|v| v["target"]["id"] = json!("bop_2")), None);
        assert_eq!(observed(|v| v["attemptKeyFingerprint"] = json!("0".repeat(64))), None);
        assert_eq!(observed(|v| v["extra"] = json!(1)), None, "an answer of another shape confirms nothing");
        assert_eq!(observed(|v| v.as_object_mut().unwrap().remove("ownerReceipt").map(|_| ()).unwrap()), None);
    }
}
