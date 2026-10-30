//! A Support Request's participant page (Platform Operations' marketplace `account-support-detail` route and
//! its `SupportRequestDetailPage`): who acts next and by when, the case's overview, what the
//! viewer is asked for (evidence prompts, an offer to accept or decline, the seller's response,
//! Request support review, Cancel case), the resolution, and the case's timeline. The buyer and
//! the seller of the order see it; anyone else gets Not found, as marketplace's loader answers.
//!
//! Which party acts next, the deadline in effect, and which of the viewer's actions the page offers
//! come from the detail read's `participantPolicy` (chase-sets/chase-sets#10715), and the API
//! derives the offer a seller's response makes from its type.
//!
//! Every write posts to the page and is a participant attempt (`participant-attempt.ts`): the form's
//! `SubmitKey` is its `Idempotency-Key`, and the request's canonical form is hashed into
//! `X-Support-Request-Hash`, which the API recomputes. A 400 or 403 applied nothing, so the page
//! says why and keeps what was typed. Any other failure is looked up once by the attempt and its
//! hash; a committed attempt goes on to the page with its receipt, and anything else is ambiguous:
//! the page says so, turns its writes off and offers Check status, which looks the attempt up again
//! and never resends it. A lookup that finds nothing keeps the page ambiguous, as marketplace's does
//! (absence is never permission for a second write); a reload starts clean.
//!
//! Unlike marketplace's forms, the role each write is submitted as is the viewer's, read here, not a
//! hidden field; a response's offer outcome is derived here from its type; and Request support
//! review's reason and a declined offer's summary are the catalog's words, not hidden fields.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /account/support/{id}?<place>` | the page, with what the last write did |
//! | `POST /account/support/{id}` | `evidence`, `response`, `accept-offer`, `decline-offer`, `escalate`, `cancel`, `check-status` |
use std::time::SystemTime;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    i18n::{Currency, parse_timestamp},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    api::{ParticipantWrite, SupportCalls as _, SupportChecklistItem, SupportRequest, segment},
    app::{Shared, read_failed, sign_in, url},
    auth::{SupportMember, Viewer},
    cart_attempt::attempt_id,
    text::{Pilot, SupportMsg},
    views::{self, Layout},
};

/// What the page's address carries: what the last write did (marketplace's `?action=`:
/// `evidence`, `response`, `offerAccepted`, `offerDeclined`, `escalated`, `cancelled`) and its receipt.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Place {
    pub action: Option<String>,
    pub after_write: Option<String>,
}

/// The page's forms: the write (`intent`), its attempt and the account it was drawn for, what
/// each write takes, and Check status's attempt.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct SupportInput {
    pub intent: String,
    pub attempt: String,
    pub account: String,
    /// The evidence prompt's checklist item, so a refusal fills the right form again.
    pub item: String,
    pub evidence_type: String,
    pub response_type: String,
    pub refund_amount: String,
    pub summary: String,
    pub offer_id: String,
    pub reason: String,
    pub check_kind: String,
    pub check_attempt: String,
    pub check_hash: String,
}

/// A party to a case (`SupportRequesterRole`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Buyer,
    Seller,
    Support,
}

impl Role {
    /// A role the API names; anything but the buyer or the seller is support's.
    fn of(role: &str) -> Role {
        match role {
            "buyer" => Role::Buyer,
            "seller" => Role::Seller,
            _ => Role::Support,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Buyer => "buyer",
            Role::Seller => "seller",
            Role::Support => "support",
        }
    }
}

/// Whether the case is over (`isTerminalStatus`).
pub fn terminal(status: &str) -> bool {
    matches!(status, "resolved" | "closed" | "cancelled")
}

const REVIEW: &str = "request-support-review";
const SUPPORT_NOTE: &str = "support-note";

/// The evidence types a participant may submit (`normalizeEvidenceType`).
const EVIDENCE_TYPES: [&str; 18] = [
    "buyer-attestation",
    "seller-attestation",
    "seller-condition-attestation",
    "tracking-status",
    "tracking-number",
    "delivery-confirmation",
    "return-delivery-confirmation",
    "photo",
    "unboxing-photo",
    "return-discrepancy-photo",
    "condition-notes",
    "missing-quantity",
    "authenticity-notes",
    "return-reason",
    "carrier-claim",
    "refund-reference",
    "payment-error",
    SUPPORT_NOTE,
];

/// When a deadline falls, from now (`countdownParts`): minutes under an hour, hours under two
/// days, else days, each rounded up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Countdown {
    pub overdue: bool,
    pub value: u64,
    /// The catalog's English unit (`minute`, `hours`, ...), as marketplace passes it.
    pub unit: &'static str,
}

pub fn countdown(due: SystemTime, now: SystemTime) -> Countdown {
    let (overdue, ms) = match due.duration_since(now) {
        Ok(left) => (false, left.as_millis()),
        Err(past) => (past.duration().as_millis() > 0, past.duration().as_millis()),
    };
    let minutes = u64::try_from(ms.div_ceil(60_000)).unwrap_or(u64::MAX).max(1);
    let (value, one, many) = if minutes < 60 {
        (minutes, "minute", "minutes")
    } else if minutes.div_ceil(60) < 48 {
        (minutes.div_ceil(60), "hour", "hours")
    } else {
        (minutes.div_ceil(60).div_ceil(24), "day", "days")
    };
    Countdown { overdue, value, unit: if value == 1 { one } else { many } }
}

/// One entry of the case's timeline (`timelineItems`).
#[derive(Clone, Debug, Serialize)]
pub struct Moment {
    pub id: String,
    /// `opened`, `evidence`, `response`, `offer`, `offer-accepted`, `offer-declined`, `escalated`, `resolved`, `closed`.
    pub kind: &'static str,
    pub at: String,
    pub description: Option<String>,
}

/// The case's timeline, oldest first. Marketplace sorts the moments as text, which puts the read
/// model's `2026-10-28 13:05` before an event's `2026-10-28T09:00`; the pilot sorts by the moment.
pub fn timeline(request: &SupportRequest) -> Vec<Moment> {
    let moment = |id: String, kind, at: &str, description: Option<&str>| Moment {
        id,
        kind,
        at: at.to_owned(),
        description: description.map(str::to_owned),
    };
    let mut items = vec![moment("opened".into(), "opened", &request.opened_at, None)];
    for e in &request.evidence {
        items.push(moment(format!("evidence:{}", e.evidence_id), "evidence", &e.submitted_at, Some(&e.summary)));
    }
    for r in request.responses.iter().filter(|r| r.offer_id.is_none()) {
        items.push(moment(format!("response:{}", r.response_id), "response", &r.submitted_at, Some(&r.summary)));
    }
    for o in &request.offers {
        items.push(moment(format!("offer:{}", o.offer_id), "offer", &o.offered_at, Some(&o.summary)));
        if let Some(at) = &o.decided_at {
            let kind = if o.status == "accepted" { "offer-accepted" } else { "offer-declined" };
            let said = o.decision_summary.as_deref().unwrap_or(&o.summary);
            items.push(moment(format!("offer-decision:{}", o.offer_id), kind, at, Some(said)));
        }
    }
    if let Some(at) = &request.escalated_at {
        items.push(moment("escalated".into(), "escalated", at, request.escalation_reason.as_deref()));
    }
    if let Some(resolution) = &request.resolution {
        items.push(moment("resolved".into(), "resolved", &resolution.resolved_at, Some(&resolution.summary)));
    }
    if let Some(at) = &request.closed_at {
        items.push(moment("closed".into(), "closed", at, None));
    }
    items.sort_by(|a, b| match (parse_timestamp(&a.at), parse_timestamp(&b.at)) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => a.at.cmp(&b.at),
    });
    items
}

/// A form filled again after a refusal: which form, and what was typed.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Draft {
    /// `evidence:<item>`, `response` or `cancel`.
    pub form: String,
    pub evidence_type: String,
    pub response_type: String,
    pub refund_amount: String,
    pub summary: String,
    pub reason: String,
}

/// An attempt whose outcome is not known (marketplace's `SupportParticipantDescriptor`): what Check
/// status looks up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Recovery {
    pub action_kind: String,
    pub attempt: String,
    pub hash: String,
}

/// What the last write did, drawn with the page.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Said {
    pub error: Option<String>,
    pub draft: Option<Draft>,
    pub recovery: Option<Recovery>,
}

/// The page: the case, the viewer's part in it, what the page works out from it, and what the last
/// write did.
#[derive(Serialize, ToJson)]
pub struct SupportScreen {
    pub request: SupportRequest,
    pub viewer_role: Role,
    /// The account the forms are drawn for (`participantAccountId`).
    pub account: String,
    pub next_actor: Option<Role>,
    pub deadline: Option<String>,
    pub countdown: Option<Countdown>,
    /// The checklist items the viewer is asked to answer.
    pub prompts: Vec<SupportChecklistItem>,
    pub offer_decision: bool,
    /// The responses the seller's form offers; empty when it is not shown.
    pub responses: Vec<String>,
    /// Whether Request support review is offered.
    pub review: bool,
    pub cancel: bool,
    pub timeline: Vec<Moment>,
    /// What the last write did, from the address (`evidence`, ...).
    pub action: Option<String>,
    pub said: Said,
}

impl SupportScreen {
    /// Whether the page's writes are on: off while an attempt's outcome is not known.
    pub fn writes(&self) -> bool {
        self.said.recovery.is_none()
    }
}

/// The viewer's part in the case (`supportRequestParticipantDetail`): the buyer or the seller, or
/// none.
fn viewer_role(request: &SupportRequest, account: &str) -> Option<Role> {
    if request.buyer_account_id == account {
        Some(Role::Buyer)
    } else if request.seller_account_id == account {
        Some(Role::Seller)
    } else {
        None
    }
}

/// The page's screen: the API's participant policy (who acts next, the deadline, the viewer's
/// actions) drawn as `SupportRequestDetailPage` draws it.
pub fn screen(
    request: SupportRequest,
    role: Role,
    account: &str,
    now: SystemTime,
    action: Option<String>,
    said: Said,
) -> SupportScreen {
    let policy = &request.participant_policy;
    let allows = |kind: &str| policy.actions.iter().any(|a| a.kind == kind);
    let prompts: Vec<SupportChecklistItem> = request
        .checklist
        .iter()
        .filter(|item| {
            policy
                .actions
                .iter()
                .any(|a| a.kind == "submit-evidence" && a.checklist_item_key.as_deref() == Some(item.key.as_str()))
        })
        .cloned()
        .collect();
    let responses = if allows("record-response") {
        request.flow.allowed_responses.iter().filter(|r| *r != REVIEW).cloned().collect()
    } else {
        Vec::new()
    };
    let due = policy.deadline_at.clone();
    SupportScreen {
        viewer_role: role,
        account: account.to_owned(),
        next_actor: policy.next_actor.as_deref().map(Role::of),
        countdown: due.as_deref().and_then(parse_timestamp).map(|at| countdown(at, now)),
        deadline: due,
        offer_decision: request.pending_offer.is_some() && (allows("accept-offer") || allows("decline-offer")),
        responses,
        review: allows("escalate"),
        cancel: allows("cancel"),
        prompts,
        timeline: timeline(&request),
        action,
        said,
        request,
    }
}

/// The checklist item's evidence types a participant may submit (`EvidencePrompt`): all but support's
/// note.
pub fn prompt_types(item: &SupportChecklistItem) -> impl Iterator<Item = &str> {
    item.evidence_types.iter().map(String::as_str).filter(|t| *t != SUPPORT_NOTE)
}

/// What a participant action's lookup result is called on the page (the action's `?action=`).
fn result_of(action_kind: &str) -> Option<&'static str> {
    Some(match action_kind {
        "submit-evidence" => "evidence",
        "record-response" => "response",
        "accept-offer" => "offerAccepted",
        "decline-offer" => "offerDeclined",
        "escalate" => "escalated",
        "cancel" => "cancelled",
        "close" => "closed",
        "return-condition-dispute" => "return-condition-disputed",
        "open-support-request" => "opened",
        _ => return None,
    })
}

/// `text`'s checks: trimmed, not empty, and at most `limit` UTF-16 units, as the API counts.
fn text(value: &str, limit: usize) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty() && value.encode_utf16().count() <= limit).then_some(value)
}

/// The canonical request (`canonicalParticipantRequest`): `{version, actionKind, payload}` as
/// `JSON.stringify` writes it, the payload's keys in the order the web host's code builds them.
/// `serde_json` escapes strings as `JSON.stringify` does.
pub(crate) fn canonical(action_kind: &str, payload: &[(&str, serde_json::Value)]) -> String {
    let mut text = format!(r#"{{"version":1,"actionKind":{},"payload":{{"#, json!(action_kind));
    for (i, (key, value)) in payload.iter().enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push_str(&format!("{}:{value}", json!(key)));
    }
    text.push_str("}}");
    text
}

/// The request hash (`hashParticipantRequest`): SHA-256 of the canonical request, in hex.
pub fn hash(canonical: &str) -> String {
    Sha256::digest(canonical.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Why a write was not sent: the message, and whether its form is filled again with what was typed.
struct NotSent(&'static str, bool);

/// The write `input` asks for on `request`, as the viewer, or why it cannot be sent.
fn participant_write(
    t: SupportMsg,
    p: Pilot,
    request: &SupportRequest,
    role: Role,
    input: &SupportInput,
) -> Result<ParticipantWrite, NotSent> {
    let id = segment(&request.support_request_id);
    let role = role.as_str();
    let write = |action_kind, path: String, body, payload: &[(&str, serde_json::Value)]| ParticipantWrite {
        action_kind,
        path,
        body,
        canonical: canonical(action_kind, payload),
    };
    match input.intent.as_str() {
        "evidence" => {
            let kind = input.evidence_type.trim();
            if !EVIDENCE_TYPES.contains(&kind) || kind == SUPPORT_NOTE {
                return Err(NotSent(p.support_choice_invalid(), true));
            }
            let Some(summary) = text(&input.summary, 4000) else {
                return Err(NotSent(p.support_summary_required(), true));
            };
            let body = json!({ "submittedByRole": role, "evidenceType": kind, "summary": summary });
            let payload = [
                ("submittedByRole", json!(role)),
                ("evidenceType", json!(kind)),
                ("summary", json!(summary)),
                ("occurredAt", json!(null)),
                ("attachments", json!([])),
            ];
            Ok(write("submit-evidence", format!("/{id}/evidence"), body, &payload))
        }
        "response" => {
            let kind = input.response_type.trim();
            if kind == REVIEW || !request.flow.allowed_responses.iter().any(|r| r == kind) {
                return Err(NotSent(p.support_choice_invalid(), true));
            }
            let Some(summary) = text(&input.summary, 4000) else {
                return Err(NotSent(p.support_summary_required(), true));
            };
            let refund = if kind == "offer-partial-refund" {
                let typed = input.refund_amount.trim();
                if typed.is_empty() {
                    return Err(NotSent(p.support_refund_required(), true));
                }
                match t.parse_money(typed, Currency::new("USD")) {
                    Some(cents) if cents.0 > 0 => Some(format!("{}.{:02}", cents.0 / 100, cents.0 % 100)),
                    _ => return Err(NotSent(p.support_refund_invalid(), true)),
                }
            } else {
                None
            };
            let mut body = json!({ "submittedByRole": role, "responseType": kind, "summary": summary });
            if let Some(refund) = &refund {
                body["refundAmount"] = json!(refund);
            }
            let payload = [
                ("submittedByRole", json!(role)),
                ("responseType", json!(kind)),
                ("summary", json!(summary)),
                ("offerResolutionType", json!(null)),
                ("refundAmount", json!(refund)),
                ("affectedLineIds", json!(null)),
                ("refundCurrencyCode", json!(null)),
            ];
            Ok(write("record-response", format!("/{id}/responses"), body, &payload))
        }
        intent @ ("accept-offer" | "decline-offer") => {
            let Some(offer) = text(&input.offer_id, 128) else {
                return Err(NotSent(p.support_choice_invalid(), false));
            };
            // The offer goes in the path, and only in the hash's payload.
            if intent == "accept-offer" {
                let path = format!("/{id}/offers/{}/accept", segment(offer));
                Ok(write("accept-offer", path, json!({}), &[("offerId", json!(offer))]))
            } else {
                let path = format!("/{id}/offers/{}/decline", segment(offer));
                let summary = t.page_offer_decline_summary();
                let payload = [("offerId", json!(offer)), ("summary", json!(summary))];
                Ok(write("decline-offer", path, json!({ "summary": summary }), &payload))
            }
        }
        "escalate" => {
            let reason = t.page_review_default_reason();
            Ok(write("escalate", format!("/{id}/escalate"), json!({ "reason": reason }), &[("reason", json!(reason))]))
        }
        "cancel" => {
            let Some(reason) = text(&input.reason, 4000) else {
                return Err(NotSent(p.support_reason_required(), true));
            };
            Ok(write("cancel", format!("/{id}/cancel"), json!({ "reason": reason }), &[("reason", json!(reason))]))
        }
        _ => Err(NotSent(t.route_action_unsupported(), false)),
    }
}

pub(crate) async fn page(
    req: Req,
    Caller(SupportMember(viewer)): Caller<SupportMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::support::SupportCase<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, receipt.as_ref());
    let request = match caller.support_request(&id).await {
        Ok(request) => request,
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        Err(error) => {
            let p: Pilot = req.t();
            return read_failed(&req, Some(&viewer), error, receipt.is_some().then_some(p.load_unverified()));
        }
    };
    draw(&req, &viewer, request, place.action, Said::default(), StatusCode::OK)
}

fn draw(
    req: &Req,
    viewer: &Viewer,
    request: SupportRequest,
    action: Option<String>,
    said: Said,
    status: StatusCode,
) -> HtmlResult {
    let account = viewer.actor.account_id.as_str();
    let Some(role) = viewer_role(&request, account) else {
        return Err(corten::Error::new("not a participant").with_status(StatusCode::NOT_FOUND));
    };
    let screen = screen(request, role, account, SystemTime::now(), action, said);
    let t: SupportMsg = req.t();
    let reference = &screen.request.display_reference;
    let title =
        if reference.is_empty() { t.route_meta_fallback_title().to_string() } else { t.route_meta_title(reference).to_string() };
    let view = html! { <views::SupportPage t={t} p={req.t()} screen={&screen} /> };
    let page = html! { <Layout req={req} viewer={Some(viewer)} title={title.as_str()} head={()}>{view}</Layout> };
    if status == StatusCode::OK { req.screen(&screen, page) } else { req.page_with_status(status, page) }
}

/// Every write (marketplace's action intents), and Check status.
pub(crate) async fn write(
    req: Req,
    Caller(SupportMember(viewer)): Caller<SupportMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::support::SupportCase<'_>>,
    Form(input): Form<SupportInput>,
) -> HtmlResult {
    let id = route.id;
    let (t, p): (SupportMsg, Pilot) = (req.t(), req.t());
    let caller = config.platform.caller(&headers, config.proto, None);
    // The page's case, read first: the write is submitted as the viewer's role in it.
    let request = match caller.support_request(&id).await {
        Ok(request) => request,
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let account = viewer.actor.account_id.as_str();
    let Some(role) = viewer_role(&request, account) else {
        return Err(corten::Error::new("not a participant").with_status(StatusCode::NOT_FOUND));
    };
    let said = |error: Option<&str>, draft: Option<Draft>, recovery: Option<Recovery>| Said {
        error: error.map(str::to_owned),
        draft,
        recovery,
    };
    // A form drawn for another account (`participantActorMatches`): nothing is sent.
    if !input.account.is_empty() && input.account != account {
        return draw(&req, &viewer, request, None, said(Some(t.attempt_account_changed()), None, None), StatusCode::CONFLICT);
    }
    let done = |result: &str, receipt: Option<Receipt>| {
        let place = Place { action: Some(result.to_owned()), after_write: receipt.as_ref().map(Receipt::param) };
        req.redirect(&url::SupportCase { id: &id, place })
    };
    if input.intent == "check-status" {
        let recovery = Recovery {
            action_kind: input.check_kind.trim().to_owned(),
            attempt: input.check_attempt.trim().to_owned(),
            hash: input.check_hash.trim().to_owned(),
        };
        let valid = result_of(&recovery.action_kind).is_some()
            && attempt_id(&recovery.attempt) == recovery.attempt
            && recovery.hash.len() == 64
            && recovery.hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !valid {
            return draw(
                &req,
                &viewer,
                request,
                None,
                said(Some(t.attempt_status_unavailable()), None, None),
                StatusCode::BAD_REQUEST,
            );
        }
        return match caller.participant_attempt(&id, &recovery.action_kind, &recovery.attempt, &recovery.hash).await {
            Ok((lookup, receipt)) if settled(&lookup, &recovery.action_kind, &id) => {
                done(result_of(&recovery.action_kind).unwrap_or_default(), receipt)
            }
            Ok(_) => draw(&req, &viewer, request, None, said(None, None, Some(recovery)), StatusCode::CONFLICT),
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Err(error) => {
                tracing::warn!("support attempt check failed: {error}");
                let said = said(Some(t.attempt_status_unavailable()), None, Some(recovery));
                draw(&req, &viewer, request, None, said, StatusCode::CONFLICT)
            }
        };
    }
    let write = match participant_write(t, p, &request, role, &input) {
        Ok(write) => write,
        Err(NotSent(message, keep)) => {
            let (draft, status) =
                if keep { (redraft(&input), StatusCode::UNPROCESSABLE_ENTITY) } else { (None, StatusCode::BAD_REQUEST) };
            return draw(&req, &viewer, request, None, said(Some(message), draft, None), status);
        }
    };
    // A post without a valid attempt (no script, a lost field) is still one attempt.
    let attempt = attempt_id(&input.attempt);
    let request_hash = hash(&write.canonical);
    let result = result_of(write.action_kind).unwrap_or_default();
    let error = match caller.participant_write(&write, &attempt, &request_hash).await {
        Ok(receipt) => return done(result, receipt),
        Err(error) => error,
    };
    match error.status().map(|s| s.as_u16()) {
        Some(401) => sign_in(&req),
        // Refused before anything was applied: say why and keep what was typed.
        Some(status @ (400 | 403)) => {
            let draft = redraft(&input);
            let message = error.refusal().unwrap_or(p.support_not_sent());
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            draw(&req, &viewer, request, None, said(Some(message), draft, None), status)
        }
        // No answer that says what happened: one lookup; a read can prove the commit, and absence
        // is never permission for a second write.
        _ => {
            tracing::warn!("support participant write failed: {error}");
            match caller.participant_attempt(&id, write.action_kind, &attempt, &request_hash).await {
                Ok((lookup, receipt)) if settled(&lookup, write.action_kind, &id) => done(result, receipt),
                _ => {
                    let recovery = Recovery { action_kind: write.action_kind.to_owned(), attempt, hash: request_hash };
                    draw(&req, &viewer, request, None, said(None, None, Some(recovery)), StatusCode::CONFLICT)
                }
            }
        }
    }
}

/// The form a refused write fills again, with what was typed.
fn redraft(input: &SupportInput) -> Option<Draft> {
    let form = match input.intent.as_str() {
        "evidence" => format!("evidence:{}", input.item),
        "response" | "cancel" => input.intent.clone(),
        _ => return None,
    };
    Some(Draft {
        form,
        evidence_type: input.evidence_type.trim().to_owned(),
        response_type: input.response_type.trim().to_owned(),
        refund_amount: input.refund_amount.trim().to_owned(),
        summary: input.summary.clone(),
        reason: input.reason.clone(),
    })
}

/// Whether a lookup proves the attempt committed on this case.
fn settled(lookup: &crate::api::ParticipantLookup, action_kind: &str, id: &str) -> bool {
    matches!(lookup.outcome.as_str(), "committed" | "confirming")
        && lookup.action_kind.as_deref() == Some(action_kind)
        && lookup.result.as_ref().is_some_and(|r| r.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{SupportOffer, SupportParticipantAction, SupportParticipantPolicy, SupportResolution};

    fn at(text: &str) -> SystemTime {
        parse_timestamp(text).unwrap()
    }

    fn item(owner: &str, satisfied: bool) -> SupportChecklistItem {
        SupportChecklistItem {
            key: format!("{owner}-proof"),
            label: "Proof".into(),
            owner_role: owner.into(),
            evidence_types: vec!["photo".into(), SUPPORT_NOTE.into()],
            required: true,
            satisfied_at: satisfied.then(|| "2026-10-27 10:00:00+00".into()),
        }
    }

    fn case(status: &str) -> SupportRequest {
        SupportRequest {
            support_request_id: "sup_1".into(),
            status: status.into(),
            buyer_account_id: "acc_buyer".into(),
            seller_account_id: "acc_seller".into(),
            opened_by_account_id: "acc_buyer".into(),
            opened_at: "2026-10-27 09:00:00.5+00".into(),
            seller_response_due_at: Some("2026-10-29 09:00:00+00".into()),
            support_review_due_at: Some("2026-10-30 09:00:00+00".into()),
            ..SupportRequest::default()
        }
    }

    #[test]
    fn the_canonical_request_and_its_hash_are_the_web_hosts() {
        // canonicalParticipantRequest and hashParticipantRequest, run with tsx on the same input.
        let evidence = canonical(
            "submit-evidence",
            &[
                ("submittedByRole", json!("buyer")),
                ("evidenceType", json!("photo")),
                ("summary", json!("Box arrived \"crushed\"\n/\u{fc}")),
                ("occurredAt", json!(null)),
                ("attachments", json!([])),
            ],
        );
        assert_eq!(
            evidence,
            r#"{"version":1,"actionKind":"submit-evidence","payload":{"submittedByRole":"buyer","evidenceType":"photo","summary":"Box arrived \"crushed\"\n/ü","occurredAt":null,"attachments":[]}}"#
        );
        assert_eq!(hash(&evidence), "0d2188d97d5486668f694337410f71c94512cdb9808c03e01980ad0c909fff96");
        let response = canonical(
            "record-response",
            &[
                ("submittedByRole", json!("seller")),
                ("responseType", json!("offer-partial-refund")),
                ("summary", json!("Half back")),
                ("offerResolutionType", json!("partial-refund")),
                ("refundAmount", json!("12.50")),
                ("affectedLineIds", json!(null)),
                ("refundCurrencyCode", json!(null)),
            ],
        );
        assert_eq!(hash(&response), "5585563375f01e17908007c0cb41827ecdee3c74ced13947edeb3d1d4497db18");
        let decline = canonical("decline-offer", &[("offerId", json!("sof_1")), ("summary", json!("No thanks"))]);
        assert_eq!(hash(&decline), "3d8c050947a12a83726c693b05a16f6f1dbff51fcc74e7eba065961fd2cb4654");
        assert_eq!(
            hash(&canonical("accept-offer", &[("offerId", json!("sof_1"))])),
            "41f46ac63d078a3c2322ca008adb7c7fa8ae840b56ddafd5a85be997b219f004"
        );
        assert_eq!(
            hash(&canonical("cancel", &[("reason", json!("Resolved with the seller"))])),
            "9c70ff38e64e4ee746d02a2f9bb42c31794a6d37a2414fd1ce9237f98ddcce95"
        );
    }

    fn policy(next: Option<&str>, deadline: Option<&str>, actions: &[(&str, Option<&str>)]) -> SupportParticipantPolicy {
        SupportParticipantPolicy {
            next_actor: next.map(str::to_owned),
            deadline_at: deadline.map(str::to_owned),
            actions: actions
                .iter()
                .map(|(kind, item)| SupportParticipantAction {
                    kind: (*kind).into(),
                    checklist_item_key: item.map(str::to_owned),
                })
                .collect(),
        }
    }

    #[test]
    fn the_page_draws_the_apis_policy_and_offers_only_its_actions() {
        let now = at("2026-10-28T09:00:00Z");
        let mut seller_turn = case("waiting-on-seller");
        seller_turn.flow.allowed_responses = vec!["provide-tracking".into(), "offer-partial-refund".into(), REVIEW.into()];
        seller_turn.participant_policy =
            policy(Some("seller"), Some("2026-10-29 09:00:00+00"), &[("record-response", None), ("escalate", None)]);
        let seller = screen(seller_turn.clone(), Role::Seller, "acc_seller", now, None, Said::default());
        assert_eq!(seller.next_actor, Some(Role::Seller));
        assert_eq!(seller.deadline.as_deref(), Some("2026-10-29 09:00:00+00"));
        assert_eq!(seller.responses, ["provide-tracking", "offer-partial-refund"], "never Request support review");
        assert!(seller.review && !seller.cancel && !seller.offer_decision && seller.prompts.is_empty());
        assert_eq!(seller.countdown, Some(Countdown { overdue: false, value: 24, unit: "hours" }));

        seller_turn.participant_policy.actions.clear();
        let buyer = screen(seller_turn, Role::Buyer, "acc_buyer", now, None, Said::default());
        assert!(buyer.responses.is_empty() && !buyer.review && !buyer.cancel, "not the buyer's turn");

        let mut prompted =
            SupportRequest { checklist: vec![item("buyer", false), item("seller", false)], ..case("waiting-on-buyer") };
        prompted.participant_policy = policy(Some("buyer"), None, &[("submit-evidence", Some("buyer-proof")), ("cancel", None)]);
        let buyer = screen(prompted, Role::Buyer, "acc_buyer", now, None, Said::default());
        assert_eq!(
            buyer.prompts.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
            ["buyer-proof"],
            "only the items the API names"
        );
        assert!(!buyer.review && buyer.cancel && buyer.countdown.is_none());
        assert_eq!(prompt_types(&buyer.prompts[0]).collect::<Vec<_>>(), ["photo"], "never support's note");

        let mut offered = case("waiting-on-buyer");
        offered.pending_offer =
            Some(SupportOffer { offer_id: "sof_1".into(), pending_with_role: "buyer".into(), ..SupportOffer::default() });
        offered.participant_policy = policy(Some("buyer"), None, &[("accept-offer", None), ("decline-offer", None)]);
        let buyer = screen(offered, Role::Buyer, "acc_buyer", now, None, Said::default());
        assert!(buyer.offer_decision && buyer.prompts.is_empty() && !buyer.review);

        let over = SupportRequest {
            resolution: Some(SupportResolution { resolved_at: "2026-10-27 12:00:00+00".into(), ..SupportResolution::default() }),
            ..case("resolved")
        };
        let buyer = screen(over, Role::Buyer, "acc_buyer", now, None, Said::default());
        assert!(buyer.next_actor.is_none() && !buyer.cancel && !buyer.review);
    }

    #[test]
    fn a_deadline_counts_down_in_minutes_hours_then_days() {
        let now = at("2026-10-28T09:00:00Z");
        let c = |due: &str| countdown(at(due), now);
        assert_eq!(c("2026-10-28T09:00:30Z"), Countdown { overdue: false, value: 1, unit: "minute" });
        assert_eq!(c("2026-10-28T09:59:00Z"), Countdown { overdue: false, value: 59, unit: "minutes" });
        assert_eq!(c("2026-10-28T10:00:00Z"), Countdown { overdue: false, value: 1, unit: "hour" });
        assert_eq!(c("2026-10-30T08:00:00Z"), Countdown { overdue: false, value: 47, unit: "hours" });
        assert_eq!(c("2026-10-30T09:00:00Z"), Countdown { overdue: false, value: 2, unit: "days" });
        assert_eq!(c("2026-10-28T07:30:00Z"), Countdown { overdue: true, value: 2, unit: "hours" });
    }

    #[test]
    fn the_timeline_is_in_the_order_things_happened() {
        let mut request = case("resolved");
        request.offers = vec![SupportOffer {
            offer_id: "sof_1".into(),
            summary: "Half back".into(),
            offered_at: "2026-10-27T10:00:00.000Z".into(),
            status: "declined".into(),
            decided_at: Some("2026-10-27T11:00:00.000Z".into()),
            ..SupportOffer::default()
        }];
        request.resolution = Some(SupportResolution {
            summary: "Refunded".into(),
            resolved_at: "2026-10-27 12:00:00+00".into(),
            ..SupportResolution::default()
        });
        request.escalated_at = Some("2026-10-27 11:30:00+00".into());
        let kinds: Vec<_> = timeline(&request).iter().map(|m| m.kind).collect();
        assert_eq!(kinds, ["opened", "offer", "offer-declined", "escalated", "resolved"]);
    }
}
