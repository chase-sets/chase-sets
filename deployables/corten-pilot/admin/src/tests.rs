//! Router tests against a stand-in platform API: who may see the screen, what the pilot forwards
//! to the API, and how each answer of the API becomes a page, a patch or a redirect.
use std::sync::{Arc, Mutex};

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
    form::default_payload,
};

const POLICIES: &str = "/api/marketplace/admin/postage-policies";
const RECEIPT: &str = r#"[{"sourceContextName":"ordering","maxGlobalPosition":"42","eventIds":["e1"]}]"#;

/// A call the stand-in received.
#[derive(Clone, Debug)]
struct Call {
    method: Method,
    path: String,
    headers: HeaderMap,
    body: String,
}

type Calls = Arc<Mutex<Vec<Call>>>;

fn policy(id: &str, label: &str, status: &str) -> Value {
    json!({
        "policy_id": id,
        "label": label,
        "status": status,
        "policy_version": "default-postage-policy-v2",
        "payload": default_payload(),
        "effective_from": "2026-01-01T00:00:00.000Z",
        "effective_until": null,
        "activation_reason": null,
        "updated_at": "2026-01-01T00:00:00.000Z",
        "activated_at": null,
        "history": [],
        "activeComparison": [],
    })
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

fn written(status: StatusCode, id: &str) -> Response {
    let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
    let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
    (status, headers, Json(json!({ "id": id, "version": 2 }))).into_response()
}

/// The platform API, as far as the screen uses it. The session cookie's value says who is
/// asking: `staff` may see the screen, `reader` may not, `down` makes the lookup fail.
async fn platform(State(calls): State<Calls>, method: Method, uri: Uri, headers: HeaderMap, body: String) -> Response {
    calls.lock().unwrap().push(Call {
        method: method.clone(),
        path: uri.to_string(),
        headers: headers.clone(),
        body: body.clone(),
    });
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if uri.path() == "/api/auth/session" {
        let actor = |permissions: &[&str]| {
            Json(json!({ "actor": { "userId": "usr_1", "accountId": "acc_platform", "roleKey": "platform_admin", "permissions": permissions } }))
                .into_response()
        };
        if cookie.contains("chase_sets_session=access-admin") || cookie.contains("chase_sets_session=lagging-admin") {
            let permissions = ["accounts.view", "accounts.manage", "security.manage", "memberships.view", "memberships.manage"];
            return Json(json!({ "actor": { "userId": "usr_1", "accountId": "acc_platform", "roleKey": "platform-admin", "permissions": permissions } }))
                .into_response();
        }
        return if cookie.contains("chase_sets_session=access-staff") {
            actor(&["accounts.view", "security.manage", "memberships.view"])
        } else if cookie.contains("chase_sets_session=accounts-only") {
            actor(&["accounts.view"])
        } else if cookie.contains("chase_sets_session=staff") {
            actor(&["postage-policies.view", "catalog.view", "catalog.manage"])
        } else if cookie.contains("chase_sets_session=catalog-reader")
            || cookie.contains("chase_sets_session=catalog-viewer")
            || cookie.contains("chase_sets_session=queue-down")
        {
            actor(&["catalog.view"])
        } else if cookie.contains("chase_sets_session=projections-operator") {
            actor(&[
                "projection-operations.view",
                "projection-operations.operate",
                "projection-operations.rebuild",
                "catalog.view",
                "accounts.view",
            ])
        } else if cookie.contains("chase_sets_session=ops") || cookie.contains("chase_sets_session=projections-") {
            actor(&["projection-operations.view"])
        } else if cookie.contains("chase_sets_session=feedback-manager") || cookie.contains("chase_sets_session=feedback-lag") {
            actor(&["platform-feedback.view", "platform-feedback.manage", "platform-feedback.export"])
        } else if cookie.contains("chase_sets_session=feedback-viewer") {
            actor(&["platform-feedback.view"])
        } else if cookie.contains("chase_sets_session=support-viewer") || cookie.contains("chase_sets_session=attention-down") {
            actor(&["support.view"])
        } else if cookie.contains("chase_sets_session=support-agent") || cookie.contains("chase_sets_session=support-lag") {
            actor(&["support.manage"])
        } else if cookie.contains("chase_sets_session=intake-manager") {
            actor(&["return-intake.view", "return-intake.manage"])
        } else if cookie.contains("chase_sets_session=intake-viewer") {
            actor(&["return-intake.view"])
        } else if cookie.contains("chase_sets_session=recovery-manager") || cookie.contains("chase_sets_session=recovery-lag") {
            actor(&["recovered-inventory.view", "recovered-inventory.manage"])
        } else if cookie.contains("chase_sets_session=recovery-viewer") {
            actor(&["recovered-inventory.view"])
        } else if cookie.contains("chase_sets_session=terms-viewer") || cookie.contains("chase_sets_session=terms-lag") {
            actor(&["commercial-terms.view"])
        } else if cookie.contains("chase_sets_session=growth-viewer") {
            actor(&["public-presence.view"])
        } else if cookie.contains("chase_sets_session=providers-admin") {
            Json(json!({ "actor": { "userId": "usr_1", "accountId": "acc_platform", "roleKey": "platform-admin", "permissions": ["provider-connections.view"] } }))
                .into_response()
        } else if cookie.contains("chase_sets_session=providers-owner") {
            actor(&["provider-connections.view"])
        } else if cookie.contains("chase_sets_session=insights-viewer") {
            actor(&["insights-dashboards.view"])
        } else if cookie.contains("chase_sets_session=policy-viewer") {
            actor(&["platform-policy.view"])
        } else if cookie.contains("chase_sets_session=policy-manager") {
            actor(&["platform-policy.view", "platform-policy.manage"])
        } else if cookie.contains("chase_sets_session=evidence-viewer") {
            actor(&["listing-evidence-policy.view"])
        } else if cookie.contains("chase_sets_session=evidence-drafter") {
            actor(&["listing-evidence-policy.view", "listing-evidence-policy.draft"])
        } else if cookie.contains("chase_sets_session=evidence-manager") {
            actor(&[
                "listing-evidence-policy.view",
                "listing-evidence-policy.draft",
                "listing-evidence-policy.validate",
                "listing-evidence-policy.activate",
            ])
        } else if cookie.contains("chase_sets_session=shopping-viewer") {
            actor(&["google-shopping.view", "google-shopping.manage", "catalog.view"])
        } else if cookie.contains("chase_sets_session=payouts-viewer") {
            actor(&["payouts.platform.view"])
        } else if cookie.contains("chase_sets_session=payouts-operator") || cookie.contains("chase_sets_session=payouts-blocked")
        {
            actor(&["payouts.reconcile"])
        } else if cookie.contains("chase_sets_session=wallet-admin") || cookie.contains("chase_sets_session=wallet-stepup") {
            actor(&[
                "wallet-adjustments.view",
                "wallet-adjustments.create",
                "wallet-adjustments.approve",
                "wallet-adjustments.reverse",
            ])
        } else if cookie.contains("chase_sets_session=wallet-viewer") {
            actor(&["wallet-adjustments.view"])
        } else if cookie.contains("chase_sets_session=moderator") {
            actor(&["reported-content.view"])
        } else if cookie.contains("chase_sets_session=reader") {
            actor(&[])
        } else if cookie.contains("chase_sets_session=down") {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        } else {
            refusal(StatusCode::UNAUTHORIZED, "unauthenticated", "Sign in.")
        };
    }
    if uri.path() == "/api/realtime/public/events" {
        return realtime(cookie);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/platform/projections") {
        return projections_api(&method, rest, cookie, &body);
    }
    if uri.path() == "/api/platform/operations-attention" {
        return operations_attention(cookie);
    }
    if uri.path() == "/api/catalog/scope-records" {
        return scope_records(uri.query().unwrap_or_default());
    }
    if let Some(rest) = uri.path().strip_prefix("/api/catalog/scope-sync-batches") {
        return sync_batches_api(&method, rest, &headers, &body);
    }
    if let Some(answer) = scope_api(&method, uri.path(), uri.query().unwrap_or_default(), &body) {
        return answer;
    }
    if let Some(rest) = uri.path().strip_prefix("/api/catalog/attention-queue") {
        return attention_queue(method, rest, cookie, &headers, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/auth/sessions") {
        return auth_sessions(&method, rest, &body);
    }
    if uri.path() == "/api/customer-feedback" {
        return csat_dashboard(uri.query().unwrap_or_default());
    }
    if uri.path() == "/api/customer-feedback/attention" {
        return feedback_attention(cookie);
    }
    if let Some(reference) = uri.path().strip_prefix("/api/platform/support-reference-lookup/") {
        return support_lookup(reference);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/experience/platform-feedback") {
        if cookie.contains("feedback-lag") && headers.contains_key("chase-sets-read-after-write") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return platform_feedback(&method, rest, &body);
    }
    if let Some(rest) = uri.path().strip_prefix(EBAY_DELETION) {
        return ebay_deletion(&method, rest, &body);
    }
    if uri.path() == "/api/public/commercial-terms/marketplace-sales-fee-schedule" {
        return published_fee_schedule();
    }
    if let Some(rest) = uri.path().strip_prefix(TERMS_API) {
        if cookie.contains("terms-lag") && headers.contains_key("chase-sets-read-after-write") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return commercial_terms(&method, rest, uri.query().unwrap_or_default(), &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/platform/policy-console") {
        return policy_console(&method, rest, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/marketplace/listing-evidence-policy") {
        return listing_evidence_policy(&method, rest, &body);
    }
    if uri.path() == "/api/platform/public-doc-reviews" {
        return Json(json!({ "items": [{ "locale": "en", "articleSlug": "fees", "articleTitle": "Seller fees",
            "articleHref": "/help/selling/fees", "policyKey": "settlement.payout-fee", "policyDocumentId": "pol_2",
            "policyRevisionEventId": "evt_1", "flaggedAt": "2026-10-20T00:00:00.000Z", "ageDays": 11 }] }))
        .into_response();
    }
    if let Some(rest) = uri.path().strip_prefix("/api/platform/public-doc-reviews/") {
        return if method == Method::POST && rest == "en/fees/settlement.payout-fee/confirm" {
            Json(json!({ "confirmed": true })).into_response()
        } else {
            refusal(StatusCode::NOT_FOUND, "not_found", "No review is waiting for that article.")
        };
    }
    if uri.path() == "/api/platform/commercial-terms-attention" {
        return Json(json!({ "items": [{ "id": "schedule:cts_1:upcoming", "kind": "upcoming-schedule", "label": "Standard seller terms",
            "detail": "Effective 2026-11-15", "attentionAt": "2026-11-15T00:00:00.000Z", "href": "/commerce/terms?schedule=cts_1" }] }))
        .into_response();
    }
    if let Some(rest) = uri.path().strip_prefix("/api/platform/insights/ops/") {
        return ops_dashboard(rest, uri.query().unwrap_or_default());
    }
    if uri.path() == "/api/platform/insights/offer-economics/summary" {
        return offer_economics(uri.query().unwrap_or_default());
    }
    if uri.path() == "/api/platform/provider-connections" {
        return provider_connections();
    }
    if let Some(rest) = uri.path().strip_prefix(SHOPPING_API) {
        return shopping_api(&method, rest, uri.query().unwrap_or_default(), &body);
    }
    if let Some(rest) = uri.path().strip_prefix(PROMO_API) {
        return promo_api(&method, rest, &body);
    }
    if uri.path() == "/api/public-presence/admin/waitlist/campaign-analytics" {
        return campaign_analytics();
    }
    if let Some(rest) = uri.path().strip_prefix(WAITLIST_API) {
        return waitlist_api(rest, uri.query().unwrap_or_default());
    }
    if let Some(rest) = uri.path().strip_prefix(WALLET_API) {
        return wallet_api(&method, rest, cookie, &body);
    }
    if let Some(rest) = uri.path().strip_prefix(SETTLEMENT) {
        return settlement(&method, rest, uri.query().unwrap_or_default(), cookie);
    }
    if let Some(rest) = uri.path().strip_prefix(RECOVERED) {
        if cookie.contains("recovery-lag") && headers.contains_key("chase-sets-read-after-write") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return recovered_items(&method, rest, &body);
    }
    if let Some(rest) = uri.path().strip_prefix(RETURN_INTAKE) {
        return return_intake(&method, rest, uri.query().unwrap_or_default(), &body);
    }
    if let Some(rest) = uri.path().strip_prefix(SUPPORT_REQUESTS) {
        if cookie.contains("support-lag") && headers.contains_key("chase-sets-read-after-write") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return support_requests(&method, rest, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/experience/risk-alerts") {
        return risk_alerts(&method, rest);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/experience/reported-content") {
        if cookie.contains("moderator-lag") && headers.contains_key("chase-sets-read-after-write") {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return reported_content(&method, rest, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/api/identity/") {
        if rest == "access-hub/accounts/acc_1"
            && cookie.contains("lagging")
            && headers.contains_key("chase-sets-read-after-write")
        {
            return refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_freshness_timeout",
                "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
            );
        }
        return identity_api(&method, rest, &body);
    }
    if uri.path() == "/api/catalog/alias-review/commands" {
        return written(StatusCode::OK, "alias");
    }
    // What a reference record's form picks from (every record, as admin-web reads them).
    if method == Method::GET && uri.path() == "/api/catalog/reference-records" && uri.query() == Some("limit=500") {
        return Json(json!({
            "items": [
                { "reference_record_id": "ref_tpci", "type_key": "publisher", "key": "tpci", "name": "TPCi" },
                { "reference_record_id": "ref_seed", "type_key": "product-line", "key": "pokemon", "name": "Pokemon TCG" },
            ],
            "total": 2,
        }))
        .into_response();
    }
    if let Some(rest) = uri.path().strip_prefix(CATALOG) {
        return catalog_api(method, rest, &headers, &body);
    }
    let Some(rest) = uri.path().strip_prefix(POLICIES) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match (method, rest) {
        (Method::GET, "") => {
            Json(json!({ "items": [policy("opp_seed", "Default postage policy", "active")], "total": 1 })).into_response()
        }
        (Method::GET, "/opp_pending") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, id) => Json(policy(&id[1..], "Smoke draft", "draft")).into_response(),
        (Method::POST, "") if body.contains(r#""label":"Refused""#) => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "Effective until must be after effective from.")
        }
        (Method::POST, "") => written(StatusCode::CREATED, "opp_new"),
        (Method::POST, "/opp_seed/activate") => written(StatusCode::OK, "opp_seed"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The Identity API: Access's home with one of each attention kind, each list as one row of 120
/// (so its pages show), `acc_1`'s workspace, and its writes (an invitation to `taken@` is refused).
fn identity_api(method: &Method, rest: &str, body: &str) -> Response {
    let account = |id: &str, status: &str| {
        json!({
            "account_id": id, "name": "Acme Cards LLC", "display_name": "Acme Cards", "account_type": "business",
            "status": status, "badges": ["founding-account", "unknown-badge"], "founder_number": 7,
            "updated_at": "2026-10-01T12:00:00.000Z",
        })
    };
    let invitation = json!({
        "invitation_id": "inv_1", "account_id": "acc_1", "account_display_name": "Acme Cards",
        "email": "new@example.test", "role_key": "manager", "status": "pending", "expires_at": "2026-11-05T12:00:00.000Z",
    });
    let key = json!({
        "api_key_id": "key_1", "user_id": "usr_2", "user_display_name": "Dana", "name": "Inventory sync",
        "key_prefix": "csk_abc", "status": "active",
    });
    let membership = json!({
        "membership_id": "mem_1", "user_id": "usr_2", "user_primary_email": "dana@example.test", "account_id": "acc_1",
        "account_name": "Acme Cards LLC", "role_key": "custom-auditor", "status": "active",
    });
    let user = json!({
        "user_id": "usr_2", "display_name": "Dana", "primary_email": "dana@example.test", "status": "active",
        "auth_methods": ["password", "passkey"],
    });
    let page = |item: Value| Json(json!({ "items": [item], "total": 120 })).into_response();
    if *method != Method::GET {
        return match rest {
            "invitations" if body.contains("taken@example.test") => {
                refusal(StatusCode::CONFLICT, "invitation_exists", "That email already has a pending invitation.")
            }
            "api-keys/key_1/rotate" => {
                let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
                let answer = json!({ "id": "key_1", "keyPrefix": "csk_new", "secret": "csk_new_full_secret" });
                (StatusCode::OK, [("chase-sets-commit-receipt", receipt)], Json(answer)).into_response()
            }
            _ => written(StatusCode::OK, "identity"),
        };
    }
    match rest {
        "access-hub/accounts/acc_1" => {
            let mut user = user.clone();
            user["contact_methods"] =
                json!([{ "contactMethodId": "ctm_1", "type": "email", "value": "dana@example.test", "verifiedAt": null }]);
            let mut key = key.clone();
            key["account_id"] = json!("acc_1");
            Json(json!({
                "account": account("acc_1", "active"),
                "users": [user],
                "memberships": [membership],
                "invitations": [invitation],
                "api_keys": [key],
                "audit_events": [{
                    "event_id": "evt_1", "stream_id": "acc_1", "event_type": "identity.account.suspended",
                    "performed_by_user_id": "usr_1", "recorded_at": "2026-10-02T12:00:00.000Z",
                }],
            }))
            .into_response()
        }
        "access-hub/users/usr_2/account" => Json(json!({ "account_id": "acc_1" })).into_response(),
        "access-hub/users/usr_9/account" => Json(json!({ "account_id": null })).into_response(),
        "api-keys/key_1" => Json(key).into_response(),
        "memberships/mem_1" => Json(membership.clone()).into_response(),
        "invitations/inv_1" => Json(invitation.clone()).into_response(),
        "memberships/mem_gone" => refusal(StatusCode::NOT_FOUND, "not_found", "Membership not found."),
        "access-hub" => {
            let mut rotation = key.clone();
            rotation["account_id"] = json!("acc_1");
            rotation["account_display_name"] = json!("Acme Cards");
            rotation["rotation_due_at"] = json!("2026-11-01T12:00:00.000Z");
            Json(json!({
                "accounts": [account("acc_1", "active")],
                "account_total": 39,
                "attention": {
                    "pending_invitations": [invitation],
                    "api_keys_needing_rotation": [rotation],
                    "suspended_accounts": [account("acc_2", "suspended")],
                    "memberships_awaiting_review": [membership],
                },
            }))
            .into_response()
        }
        "accounts" => page(account("acc_1", "active")),
        "users" => page(user),
        "memberships" => page(membership),
        "invitations" => page(invitation),
        "api-keys" => page(key),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Auth's sessions: one of 120 in the list; `ses_1` active with two accounts, `ses_old` revoked,
/// and a switch to `acc_gone` refused.
fn auth_sessions(method: &Method, rest: &str, body: &str) -> Response {
    let session = |id: &str, status: &str| {
        json!({
            "session_id": id, "user_id": "usr_2", "user_display_name": null, "user_primary_email": "dana@example.test",
            "account_id": "acc_1", "account_display_name": "Acme Cards", "account_name": "Acme Cards LLC",
            "available_account_ids": ["acc_1", "acc_2"], "authentication_method": "magic-link", "status": status,
            "expires_at": "2026-11-05T12:00:00.000Z", "updated_at": "2026-10-30T12:00:00.000Z",
        })
    };
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({ "items": [session("ses_1", "active")], "total": 120, "count": 1 })).into_response(),
        (Method::GET, "/ses_1") => Json(session("ses_1", "active")).into_response(),
        (Method::GET, "/ses_old") => Json(session("ses_old", "revoked")).into_response(),
        (Method::POST, "/ses_1/switch-account") if body.contains("acc_gone") => {
            refusal(StatusCode::CONFLICT, "account_unavailable", "That account is not available to this session.")
        }
        (Method::POST, "/ses_1/switch-account" | "/ses_1/revoke") => written(StatusCode::OK, "ses_1"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Platform Operations' reported content: a listing with two reports and a review in the queue
/// (one page of 12), and a withdrawal without its note refused as the API refuses it.
fn reported_content(method: &Method, rest: &str, body: &str) -> Response {
    let item = |kind: &str, id: &str, status: &str| {
        json!({
            "target_type": kind, "target_id": id, "target_owner_account_id": "acc_seller", "status": status,
            "report_count": 2, "reasons": [{ "reason": "counterfeit", "count": 2 }],
            "first_reported_at": "2026-10-28T12:00:00.000Z", "last_reported_at": "2026-10-29T12:00:00.000Z",
            "auto_unlisted_at": null, "last_action": "contact-seller", "last_action_at": "2026-10-29T13:00:00.000Z",
        })
    };
    let detail = |kind: &str, id: &str| {
        let mut detail = item(kind, id, "needs-review");
        detail["distinct_reporter_count"] = json!(2);
        detail["reports"] = json!([
            { "reportId": "rep_1", "reporterKind": "visitor", "reason": "counterfeit", "details": "Fake holo.", "submittedAt": "2026-10-28T12:00:00.000Z" },
            { "reportId": "rep_2", "reporterKind": "account", "reason": "counterfeit", "submittedAt": "2026-10-29T12:00:00.000Z" },
        ]);
        Json(detail).into_response()
    };
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({
            "items": [item("listing", "lst_1", "needs-review"), item("review", "rev_1", "auto-unlisted")],
            "total": 12, "count": 2,
        }))
        .into_response(),
        (Method::GET, "/metrics") => {
            Json(json!({ "total_count": 12, "needs_review_count": 7, "auto_unlisted_count": 3 })).into_response()
        }
        (Method::GET, "/listing/lst_1") => detail("listing", "lst_1"),
        (Method::GET, "/review/rev_1") => detail("review", "rev_1"),
        (Method::POST, "/review/rev_1/actions") if body.contains(r#""note":null"#) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "validation_failed", "reason": "note_required", "message": "The moderation action was rejected." } })),
        )
            .into_response(),
        // As the API answers today (chase-sets/chase-sets#10833): no receipt.
        (Method::POST, "/review/rev_1/actions") if body.contains("dismiss") => {
            Json(json!({ "id": "rca_1", "recordedAt": "2026-10-30T12:00:00.000Z" })).into_response()
        }
        (Method::POST, "/listing/lst_1/actions" | "/review/rev_1/actions") => written(StatusCode::OK, "act_1"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Platform Operations' platform feedback: two of five in the queue, one with a note and two
/// related records, its CSV, and a blank note refused as the API refuses it.
fn platform_feedback(method: &Method, rest: &str, body: &str) -> Response {
    let entry = |id: &str, status: &str, rating: u8, topic: &str, workflow: &str| {
        json!({
            "feedback_id": id, "user_id": "usr_buyer", "account_id": "acc_buyer", "rating": rating, "topic": topic,
            "comment": "Offer tracking is useful.", "follow_up_consent": true, "workflow": workflow,
            "source_route_path": "/account/offers/submitted/off_1",
            "related_entities": [{ "id": "off_1", "type": "offer" }, { "id": "x_1", "type": "mystery" }],
            "related_entity_key": "offer:off_1", "status": status,
            "submitted_at": "2026-05-07 18:00:00+00", "updated_at": "2026-05-08T09:30:00.000Z",
            "reviewed_by_user_id": null, "reviewed_at": null, "archived_by_user_id": null, "archived_at": null,
            "operator_notes": [],
        })
    };
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({
            "items": [entry("pfb_1", "new", 4, "ease-of-use", "offer-submit"), entry("pfb_2", "reviewed", 2, "other", "listing-publish")],
            "total": 5, "count": 2,
        }))
        .into_response(),
        (Method::GET, "/metrics") => Json(json!({
            "total_count": 5, "new_count": 3, "reviewed_count": 1, "archived_count": 1, "average_rating": "3.80",
            "by_topic": [], "by_workflow": [],
        }))
        .into_response(),
        (Method::GET, "/export") => (
            [
                ("content-type", "text/csv; charset=utf-8"),
                ("content-disposition", r#"attachment; filename="chase-sets-platform-feedback.csv""#),
            ],
            r#""feedback_id","rating"
"pfb_1","4""#,
        )
            .into_response(),
        (Method::GET, "/pfb_1") => {
            let mut detail = entry("pfb_1", "new", 4, "ease-of-use", "offer-submit");
            detail["operator_notes"] = json!([
                { "noteId": "pfn_1", "body": "Asked the seller.", "recordedByUserId": "usr_ops", "recordedAt": "2026-05-08T09:30:00.000Z" },
            ]);
            Json(detail).into_response()
        }
        (Method::GET, "/pfb_2") => Json(entry("pfb_2", "archived", 2, "other", "listing-publish")).into_response(),
        (Method::POST, "/pfb_1/notes") if !body.contains(r#""body":"Called"#) => {
            refusal(StatusCode::BAD_REQUEST, "validation_failed", "Operator note is required.")
        }
        (Method::POST, "/bulk/review" | "/bulk/archive" | "/pfb_1/notes" | "/pfb_1/review" | "/pfb_1/archive") => {
            written(StatusCode::OK, "pfb_1")
        }
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Platform feedback not found."),
    }
}

/// Customer Feedback's attention queue: an urgent case past its triage deadline, a triaged one
/// due in 2099 with an owner, and the metrics; `attention-down` fails.
fn feedback_attention(cookie: &str) -> Response {
    if cookie.contains("attention-down") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "Internal server error.");
    }
    let item = |id: &str, priority: &str, rating: u8, owner: Option<&str>, triaged: Option<&str>, due: Option<&str>| {
        json!({
            "attentionId": format!("att_{id}"), "caseId": id, "state": "active", "reason": "low-score", "ruleVersion": "low-score-v1",
            "rating": rating, "priority": priority, "ownerId": owner, "openedAt": "2026-05-07T10:00:00.000Z", "triagedAt": triaged,
            "dueAt": due, "triageDueAt": "2026-05-07T11:00:00.000Z", "closedAt": null, "deliveryStatus": "sent",
            "deliveryReference": null, "deliveryReportedAt": null, "followUpDeliveryStatus": "not-requested", "followUpChannel": null,
        })
    };
    Json(json!({
        "items": [
            item("fbcase_1", "urgent", 1, None, None, None),
            item("fbcase_2", "high", 2, Some("usr_ops"), Some("2026-05-07T10:30:00.000Z"), Some("2099-01-01T12:00:00.000Z")),
        ],
        "metrics": {
            "activeCount": 2, "overdueCount": 1, "medianTimeToTriageMs": 5_400_000.0, "medianTimeToCloseMs": null, "oldestOverdueMs": 1,
            "deliverySuccesses": 2, "deliveryFailures": 3, "digestPending": 0, "digestFailures": 0, "latestDigestAt": null,
        },
    }))
    .into_response()
}

const EBAY_DELETION: &str = "/api/channels/staff/ebay-account-deletion";

/// Channels' staff eBay account-deletion lookup: the counts; `ebay-user-1` matches one receipt,
/// `nobody` none, `slow` misses the API's deadline and `down` fails (the counts too).
fn ebay_deletion(method: &Method, rest: &str, body: &str) -> Response {
    match (method.clone(), rest) {
        (Method::GET, "/subject-data-count") => Json(json!({ "connections": 2, "credentialEnvelopes": 0 })).into_response(),
        (Method::POST, "/lookup") if body == r#"{"userId":"ebay-user-1"}"# => Json(json!({
            "matches": [{ "notificationId": "ntf_1", "eventDate": "2026-05-07T18:00:00.000Z", "expiresAt": "2027-05-07T18:00:00.000Z" }],
        }))
        .into_response(),
        (Method::POST, "/lookup") if body == r#"{"userId":"slow"}"# => {
            (StatusCode::REQUEST_TIMEOUT, Json(json!({ "error": "receipt_lookup_deadline_exceeded" }))).into_response()
        }
        (Method::POST, "/lookup") if body == r#"{"userId":""}"# => (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_lookup" }))).into_response(),
        (Method::POST, "/lookup") => Json(json!({ "matches": [] })).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

const SUPPORT_REQUESTS: &str = "/api/marketplace/support-requests";

/// Support requests' ops API: `req_1`, urgent, contested and ready for support with a photo, a
/// note, a seller's challenge and a declined offer; `req_done`, resolved with a refund and not yet
/// closable; the flows' titles; Escalate overdue's counts; a resolve without its summary refused;
/// and `req_1`'s one photo.
fn support_requests(method: &Method, rest: &str, body: &str) -> Response {
    let row = |id: &str, reference: &str, status: &str, priority: &str, due: Option<&str>| {
        json!({
            "support_request_id": id, "display_reference": reference, "order_id": "ord_1", "flow_type": "product-damaged",
            "status": status, "priority": priority, "seller_response_due_at": due, "support_review_due_at": null,
            "checklist": [
                { "key": "photos", "label": "Damage photos", "required": true, "satisfiedAt": "2026-05-06T10:00:00.000Z" },
                { "key": "tracking", "label": "Carrier tracking", "required": true },
            ],
            "contested": status == "ready-for-support",
        })
    };
    let photo = format!("support-attachment:v1:sea_abc123:{}:jpg", "b".repeat(64));
    match (method.clone(), rest) {
        (Method::GET, "/ops") => Json(json!({
            "items": [
                row("req_1", "SUP-1042", "ready-for-support", "urgent", Some("2026-05-07T18:00:00.000Z")),
                row("req_2", "", "open", "normal", None),
            ],
            "total": 3, "count": 2,
        }))
        .into_response(),
        (Method::GET, "/flows") => {
            Json(json!({ "items": [{ "flowType": "product-damaged", "title": "Damaged product" }] })).into_response()
        }
        (Method::GET, "/ops/req_1") => {
            let mut detail = row("req_1", "SUP-1042", "ready-for-support", "urgent", Some("2026-05-07T18:00:00.000Z"));
            let more = json!({
                "buyer_account_id": "acc_buyer", "seller_account_id": "acc_seller",
                "evidence": [
                    { "evidenceId": "ev_1", "submittedByRole": "buyer", "evidenceType": "photo", "summary": "Crushed corner.",
                      "submittedAt": "2026-05-06T10:00:00.000Z", "attachments": [photo, "not-a-reference"] },
                    { "evidenceId": "ev_2", "submittedByRole": "support", "evidenceType": "support-note", "summary": "Called the carrier.",
                      "submittedAt": "2026-05-07T09:00:00.000Z" },
                ],
                "responses": [
                    { "responseId": "rsp_1", "responseType": "challenge-with-evidence", "submittedByRole": "seller",
                      "summary": "Packed in a toploader.", "submittedAt": "2026-05-06T12:00:00.000Z" },
                ],
                "offers": [
                    { "offerId": "off_1", "offeredByRole": "seller", "resolutionType": "partial-refund", "refundAmount": "10.00",
                      "summary": "Ten back.", "offeredAt": "2026-05-06T13:00:00.000Z", "status": "declined", "decidedByRole": "buyer" },
                ],
                "affected_line_items": [{ "amount": "56.83", "currencyCode": "USD" }],
                "flow": { "allowedResolutions": ["full-refund", "partial-refund", "support-reviewed"] },
            });
            detail.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
            Json(detail).into_response()
        }
        (Method::GET, "/ops/req_done") => {
            let mut detail = row("req_done", "SUP-1001", "resolved", "normal", None);
            let more = json!({
                "buyer_account_id": "acc_buyer", "seller_account_id": "acc_seller",
                "resolution": { "summary": "Refunded five.", "refundAmount": "5.00", "resolvedAt": "2026-05-08T09:00:00.000Z" },
                "closure_eligible": false, "closure_blocking_reasons": ["Refund still settling"],
                "flow": { "allowedResolutions": ["full-refund"] },
            });
            detail.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
            Json(detail).into_response()
        }
        (Method::POST, "/ops/escalate-overdue") => {
            let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
            let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
            (headers, Json(json!({ "escalated": 2, "skipped": 1, "capped": true, "total": 120 }))).into_response()
        }
        (Method::POST, "/ops/req_1/resolve") if !body.contains(r#""summary":"Refund"#) => {
            refusal(StatusCode::BAD_REQUEST, "validation_failed", "A resolution summary is required.")
        }
        (
            Method::POST,
            "/ops/req_1/evidence" | "/ops/req_1/responses" | "/ops/req_1/escalate" | "/ops/req_1/resolve" | "/ops/req_1/cancel",
        ) => written(StatusCode::OK, "req_1"),
        (Method::GET, "/req_1/attachments/sea_abc123") => {
            ([("content-type", "image/jpeg"), ("cache-control", "private, max-age=300")], "jpeg").into_response()
        }
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Support request not found."),
    }
}

/// Customer Feedback's CSAT dashboard: a 7-day window with too few answers, a 30-day one with
/// figures, one trend bucket, one invitation and both pages; a `to` in the future is answered 500,
/// as the API does (chase-sets/chase-sets#10844).
fn csat_dashboard(query: &str) -> Response {
    if query.contains("to=2099") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "Internal server error.");
    }
    let slice = |csat: Value, availability: &str| {
        json!({
            "csat": csat, "csatAvailability": availability, "responseRate": 0.25, "responseRateAvailability": "available",
            "ratingDistribution": { "1": 0, "2": 1, "3": 0, "4": 2, "5": 4 }, "volume": { "submitted": 7, "presented": 28 },
        })
    };
    let mut bucket = slice(json!(0.5), "available");
    bucket["bucketStart"] = json!("2026-10-29T00:00:00.000Z");
    Json(json!({
        "analytics": {
            "asOf": "2026-10-30T12:00:00.000Z",
            "windows": { "trailing-7d": slice(Value::Null, "insufficient-sample"), "trailing-30d": slice(json!(0.857), "available") },
            "trend": { "items": [bucket] },
            "health": { "lastProjectedAt": "2026-10-30T11:59:00.000Z" },
        },
        "queue": {
            "items": [{
                "invitationId": "csi_1", "state": "submitted",
                "surveyVersion": { "surveyKind": "transactional-csat", "surveyVersion": "csat.v1", "questionVersion": "csat.q.v1" },
                "outcomeCode": "order.delivered", "rating": 4, "submittedAt": "2026-10-29T10:00:00.000Z",
            }],
            "nextCursor": "c2", "previousCursor": "c0", "limit": 50,
        },
        "filters": {},
    }))
    .into_response()
}

/// Support's reference lookup: an order, a record whose link is not a path here, a failure, and
/// nothing else.
fn support_lookup(reference: &str) -> Response {
    let found = |href: &str| {
        Json(json!({ "result": {
            "contextName": "ordering", "entityType": "order", "displayReference": "ORD-A1B2C3D4",
            "status": "paid", "summary": "Order for 2 items, $41.50", "adminHref": href,
        } }))
        .into_response()
    };
    match reference {
        "ORD-A1B2C3D4" => found("/commerce/orders/ord_1"),
        "ORD-OFFSITE" => found("//elsewhere.example/orders"),
        "ORD-DOWN" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "support_reference_not_found", "No record was found for that reference."),
    }
}

/// Platform Operations' risk alerts: a candidate with evidence and a threshold, and an
/// acknowledged one that is not a candidate. Actions answer no receipt, as the API does
/// (chase-sets/chase-sets#10835).
fn risk_alerts(method: &Method, rest: &str) -> Response {
    let alert = |id: &str, status: &str, candidate: bool| {
        json!({
            "alert_id": id, "account_id": "acc_seller", "alert_kind": "chargeback-velocity", "status": status,
            "severity": "high", "manual_payout_review_candidate": candidate,
            "evidence": { "chargebackCount": 3, "windowDays": "30" }, "threshold": { "minChargebacks": 3 },
            "first_triggered_at": "2026-10-28T12:00:00.000Z", "last_triggered_at": "2026-10-29T12:00:00.000Z",
            "last_action": null, "last_action_at": null, "last_action_note": null, "last_action_by_user_id": null,
            "updated_at": "2026-10-29T12:00:00.000Z",
        })
    };
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({
            "items": [alert("ral_1", "needs-review", true), alert("ral_2", "acknowledged", false)],
            "total": 2, "count": 2,
        }))
        .into_response(),
        (Method::GET, "/metrics") => Json(json!({
            "total_count": 2, "needs_review_count": 1, "manual_payout_review_candidate_count": 1,
        }))
        .into_response(),
        (Method::GET, "/ral_1") => Json(alert("ral_1", "needs-review", true)).into_response(),
        (Method::GET, "/ral_2") => Json(alert("ral_2", "acknowledged", false)).into_response(),
        (Method::POST, "/ral_1/actions" | "/ral_2/actions") => {
            Json(json!({ "id": "raa_1", "recordedAt": "2026-10-30T12:00:00.000Z" })).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The pilot, in front of a stand-in API on a loopback port.
struct Pilot {
    router: Router,
    calls: Calls,
}

impl Pilot {
    async fn new() -> Self {
        let calls = Calls::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stand_in = Router::new().fallback(platform).with_state(calls.clone());
        tokio::spawn(async move { corten::axum::serve(listener, stand_in).await.unwrap() });
        let router = app(Config { platform: Platform::new(&origin), proto: "http" }).router();
        Pilot { router, calls }
    }

    async fn send(&self, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8(body.to_vec()).unwrap())
    }

    /// The calls to the policies API (the session lookups left out).
    fn policy_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(POLICIES)).cloned().collect()
    }
}

fn get(uri: &str, session: Option<&str>) -> Request<Body> {
    let mut req = Request::get(uri).header(header::HOST, "localhost:7790");
    if let Some(session) = session {
        req = req.header(header::COOKIE, format!("chase_sets_session={session}"));
    }
    req.body(Body::empty()).unwrap()
}

/// A form post as the runtime sends it (`corten: action`), or as a browser without JavaScript.
fn post(uri: &str, body: &str, script: bool) -> Request<Body> {
    post_as("staff", uri, body, script)
}

fn post_as(session: &str, uri: &str, body: &str, script: bool) -> Request<Body> {
    let mut req = Request::post(uri)
        .header(header::HOST, "localhost:7790")
        .header(header::COOKIE, format!("chase_sets_session={session}"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if script {
        req = req.header("corten", "action");
    }
    req.body(Body::from(body.to_owned())).unwrap()
}

/// A create form's body with `label` and every rule filled in.
fn create_body(label: &str, max_letter_units: &str) -> String {
    format!(
        "label={label}&effective_from=2026-01-01T00%3A00%3A00.000Z&effective_until=&policy_version=default-postage-policy-v2\
         &max_letter_units={max_letter_units}&max_letter_weight_ounces=3.5&max_letter_thickness_inches=0.25\
         &max_letter_declared_value_amount=50&letter_envelope_weight_ounces=0.4&parcel_packaging_weight_ounces=2\
         &parcel_required_shipping_options=priority"
    )
}

fn fresh_receipt() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let receipt = format!(r#"{{"observedAtMs":{now},"commitPosition":"42","sources":{RECEIPT}}}"#);
    percent_encoding::utf8_percent_encode(&receipt, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[tokio::test]
async fn a_signed_out_visitor_signs_in_through_admin_web() {
    let pilot = Pilot::new().await;
    for session in [None, Some("expired")] {
        let (status, headers, _) = pilot.send(get("/commerce/postage-policies", session)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{session:?}");
        assert_eq!(
            headers[header::LOCATION],
            "http://localhost:7752/access/sign-in?returnTo=%2Fcommerce%2Fpostage-policies",
            "{session:?}"
        );
    }
    assert!(pilot.policy_calls().is_empty(), "nothing is read for a visitor who is not signed in");
}

#[tokio::test]
async fn staff_without_the_permission_are_refused_and_an_unreachable_session_is_not_signed_out() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(html.contains("Your role cannot open this page.") && html.contains("<header"), "drawn with the reader's nav: {html}");
    // Corten's `Refused::unavailable`: a 503, not a sign-in, in its own words (not a screen's
    // "preparing your change") and with no nav, since no one could be read.
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("down"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a failed lookup must not send the user to sign in again");
    assert!(html.contains("We could not check who you are.") && !html.contains("<header"), "{html}");
    assert!(pilot.policy_calls().is_empty());
}

#[tokio::test]
async fn an_unknown_address_is_drawn_for_who_is_asking() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/nowhere", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("There is nothing at this address.") && html.contains("<header"), "with the staff nav: {html}");
    let (status, _, html) = pilot.send(get("/commerce/nowhere", None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an unknown address is not a sign-in");
    assert!(!html.contains("<header"), "no one, no nav: {html}");
}

#[tokio::test]
async fn the_list_renders_for_staff_and_data_clients_get_the_screen() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/postage-policies", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("<h1>Postage Policies</h1>"), "{html}");
    assert!(html.contains("Default postage policy"), "{html}");
    assert!(html.contains(r#"href="/commerce/postage-policies" aria-current="page""#), "{html}");

    let mut req = get("/commerce/postage-policies?policy=opp_seed", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (status, _, body) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["policies"]["items"][0]["policy_id"], "opp_seed", "{body}");
    assert_eq!(screen["data"]["selected"]["policy_id"], "opp_seed", "{body}");

    let calls = pilot.policy_calls();
    assert!(calls.iter().all(|c| c.headers["chase-sets-read-target-context"] == "ordering"), "{calls:?}");
    assert!(calls.iter().all(|c| c.headers["x-forwarded-host"] == "localhost:7790"), "{calls:?}");
    assert!(calls.iter().all(|c| c.headers[header::COOKIE] == "chase_sets_session=staff"), "{calls:?}");
    assert!(calls.iter().all(|c| !c.headers.contains_key("chase-sets-read-after-write")), "no write, no receipt: {calls:?}");
}

#[tokio::test]
async fn the_apis_refusal_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post("/commerce/postage-policies", &create_body("Refused", "8"), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"), "a patch of the form: {headers:?}");
    assert!(html.starts_with(r#"<form class="policy-fields__form" id="create-form""#), "{html}");
    assert!(html.contains(r#"<p class="form-error" role="alert">Effective until must be after effective from.</p>"#), "{html}");
    assert!(html.contains(r#"value="Refused""#), "what was typed stays: {html}");

    // Without JavaScript the same refusal is the whole page, with the form in it.
    let (status, _, html) = pilot.send(post("/commerce/postage-policies", &create_body("Refused", "8"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("Effective until must be after effective from."), "{html}");
}

#[tokio::test]
async fn the_pilots_own_check_names_the_field_and_calls_nothing() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", ""), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="create-form-max_letter_units-error""#) && html.contains(r#"aria-invalid="true""#), "{html}");
    assert!(
        html.contains(r#"</label><p class="field-error" id="create-form-max_letter_units-error">"#),
        "the error is not in the label: {html}"
    );
    assert!(!pilot.policy_calls().iter().any(|c| c.method == Method::POST), "nothing is sent to the API");
}

#[tokio::test]
async fn an_accepted_write_redirects_to_the_policy_with_its_receipt() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", "8"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/commerce/postage-policies?policy=opp_new&after_write="), "{to}");
    let sent = pilot.policy_calls().into_iter().find(|c| c.method == Method::POST).unwrap();
    let body: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!((body["label"].as_str(), body["maxLetterUnits"].as_f64()), (Some("Draft"), Some(8.0)), "{body}");

    let (status, headers, _) = pilot.send(post("/commerce/postage-policies", &create_body("Draft", "8"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION].to_str().unwrap().split("&after_write=").next(), to.split("&after_write=").next());
}

#[tokio::test]
async fn the_read_after_a_write_sends_the_receipt_and_waits_for_it() {
    let pilot = Pilot::new().await;
    let receipt = fresh_receipt();
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_new&after_write={receipt}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    let reads = pilot.policy_calls();
    assert_eq!(reads.len(), 2, "the list and the sheet: {reads:?}");
    for read in &reads {
        let sent = read.headers["chase-sets-read-after-write"].to_str().unwrap();
        let sent: Value = serde_json::from_str(&percent_encoding::percent_decode_str(sent).decode_utf8().unwrap()).unwrap();
        assert_eq!(sent["commitPosition"], "42", "{sent}");
        assert_eq!(sent["sources"], serde_json::from_str::<Value>(RECEIPT).unwrap(), "{sent}");
    }

    // The write's projection is not readable yet: "preparing", as admin-web answers.
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_pending&after_write={receipt}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    // Without a write before it, the same answer is the API failing.
    let (status, _, _) = pilot.send(get("/commerce/postage-policies?policy=opp_pending", Some("staff"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_stale_receipt_is_not_sent() {
    let pilot = Pilot::new().await;
    let old = format!(r#"{{"observedAtMs":1000,"commitPosition":"42","sources":{RECEIPT}}}"#);
    let old = percent_encoding::utf8_percent_encode(&old, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, _) =
        pilot.send(get(&format!("/commerce/postage-policies?policy=opp_new&after_write={old}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(pilot.policy_calls().iter().all(|c| !c.headers.contains_key("chase-sets-read-after-write")));
}

#[tokio::test]
async fn activation_sends_the_reason_or_asks_for_one() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/commerce/postage-policies/opp_seed/activate", "label=Default&activation_reason=Reviewed", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().starts_with("/commerce/postage-policies?policy=opp_seed&after_write="));
    let sent = pilot.policy_calls().into_iter().find(|c| c.method == Method::POST).unwrap();
    assert_eq!(sent.path, format!("{POLICIES}/opp_seed/activate"));
    assert_eq!(serde_json::from_str::<Value>(&sent.body).unwrap(), json!({ "activationReason": "Reviewed" }));

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/commerce/postage-policies/opp_seed/activate", "label=Default&activation_reason=+", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="lifecycle__card" id="activate-form""#), "{html}");
    assert!(html.contains(r#"id="activate-form-activation_reason-error""#), "{html}");
    assert!(!pilot.policy_calls().iter().any(|c| c.method == Method::POST));
}

// The catalog area.

const CATALOG: &str = "/api/catalog";

fn dimension(id: &str, status: &str) -> Value {
    json!({
        "dimension_id": id, "key": "condition", "name": "Condition", "description": null,
        "value_kind": "ordered", "status": status, "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

fn option(id: &str, code: &str, status: &str, order: i64) -> Value {
    json!({
        "option_id": id, "code": code, "label": code.to_uppercase(),
        "label_i18n": { "defaultLocale": "en", "values": { "en": code.to_uppercase(), "fr": "fr" } },
        "display_order": order, "numeric_value": if order == 1 { json!(2.5) } else { Value::Null }, "status": status,
    })
}

fn catalog_field(id: &str) -> Value {
    json!({
        "field_id": id, "key": "language", "name": "Language", "description": "Printed language", "status": "draft",
        "value_type": "string", "filterable": true, "searchable": false, "sortable": true,
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft child category under `ctg_root` (the API's `CategoryListItem`: snake_case, its parent
/// a camelCase `CategoryRef`).
fn catalog_category(id: &str) -> Value {
    json!({
        "category_id": id, "key": "fire", "name": "Fire", "description": "", "status": "draft",
        "parent_category": { "categoryId": "ctg_root", "name": "Energy types" }, "display_order": 3,
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft component with a required field rule and a dimension rule that allows one option and
/// applies when another dimension is `holo` (the API's `ComponentDetail`).
fn catalog_component(id: &str) -> Value {
    json!({
        "component_id": id, "key": "card-face", "name": "Card face", "description": "", "status": "draft",
        "field_rules": [{ "fieldId": "fld_seed", "fieldName": "Language", "required": true }],
        "dimension_rules": [{
            "dimensionId": "dim_seed", "dimensionName": "Condition", "required": false,
            "allowedOptions": [{ "optionId": "chc_a", "code": "nm" }],
            "appliesWhen": [{ "dimensionId": "dim_b", "dimensionName": "Finish", "optionIds": ["chc_x"], "options": [{ "optionId": "chc_x", "code": "holo" }] }],
        }],
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// A draft blueprint as its page reads it (`BlueprintDetail`): one component, a required field
/// rule, a dimension rule, and a canonical order. The admin page's read misses the field rule
/// the list has (`fld_more`), as chase-sets/chase-sets#10823 can.
fn catalog_blueprint(id: &str) -> Value {
    json!({
        "blueprint_id": id, "key": "single", "name": "Card single", "description": "", "status": "draft",
        "components": [{ "componentId": "cmp_seed", "name": "Card face" }],
        "field_rules": [{ "fieldId": "fld_seed", "fieldName": "Language", "required": true }],
        "dimension_rules": [{
            "dimensionId": "dim_seed", "dimensionName": "Condition", "required": true,
            "allowedOptions": [{ "optionId": "chc_a", "code": "nm" }],
            "appliesWhen": [{ "dimensionId": "dim_b", "dimensionName": "Finish", "optionIds": ["chc_x"], "options": [{ "optionId": "chc_x", "code": "holo" }] }],
        }],
        "canonical_dimension_order": [{ "dimensionId": "dim_seed", "dimensionName": "Condition" }],
        "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

/// The blueprints list (`Blueprint`): the blueprint's own table, with every rule.
fn catalog_blueprints() -> Value {
    json!({
        "items": [{
            "blueprint_id": "bpr_seed", "key": "single", "name": "Card single", "status": "draft",
            "component_ids": ["cmp_seed"],
            "field_rules": [{ "fieldId": "fld_seed", "required": true }, { "fieldId": "fld_more", "required": false }],
            "dimension_rules": [{ "dimensionId": "dim_seed", "required": true, "allowedOptionIds": ["chc_a"],
                                  "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] }],
            "canonical_dimension_order": ["dim_seed", "dim_b"],
        }],
        "total": 1,
    })
}

/// A draft display template for a blueprint (`DisplayTemplate`).
fn display_template(id: &str) -> Value {
    json!({
        "display_template_id": id, "key": "card-title", "name": "Card title", "description": "",
        "target_kind": "blueprint", "target_id": "bpr_seed", "priority": 10,
        "title_template": "{field.card-name}", "subtitle_template": null,
        "required_field_keys": ["card-name"], "status": "draft", "updated_at": "2026-01-01T00:00:00.000Z",
    })
}
/// A draft reference type with two attribute keys (`ReferenceType`).
fn reference_type(id: &str) -> Value {
    json!({
        "reference_type_id": id, "key": "set", "name": "Set", "description": null,
        "attribute_keys": ["release-date", "series"], "status": "draft", "updated_at": "2026-01-01T00:00:00.000Z",
    })
}
/// A draft reference record with one attribute and one relationship (`ReferenceRecord`).
fn reference_record(id: &str) -> Value {
    json!({
        "reference_record_id": id, "type_key": "product-line", "key": "pokemon", "name": "Pokemon TCG",
        "description": null, "attributes": { "short-name": "PTCG", "sets": 12 },
        "relationships": [{ "relationshipType": "published-by", "referenceId": "ref_tpci" }],
        "status": "draft", "updated_at": "2026-01-01T00:00:00.000Z",
    })
}
fn candidate(id: &str, status: &str, outcome: &str, reason: Option<&str>) -> Value {
    json!({ "id": id, "label": format!("Label {id}"), "status": status, "outcome": outcome, "reason": reason })
}

/// A bulk job (`CatalogAuthoringBulkJob`): running (1 of 2), or completed with its outcome.
fn job(id: &str, done: bool) -> Value {
    let (status, completed, result) = if done {
        let candidates = [
            candidate("dim_seed", "deprecated", "succeeded", None),
            candidate("dim_b", "draft", "skipped", Some("Only an active dimension can be deprecated.")),
        ];
        let result = json!({ "action": "deprecate", "ids": ["dim_seed", "dim_b"], "total": 2, "succeeded_count": 1,
                             "skipped_count": 1, "failed_count": 0, "candidates": candidates });
        ("completed", 2, result)
    } else {
        ("running", 1, Value::Null)
    };
    json!({
        "jobId": id, "kind": "catalog.authoring.dimensions.lifecycle", "action": "deprecate", "status": status,
        "progress": { "phase": status, "completed": completed, "total": 2, "currentName": "Label dim_seed", "status": "succeeded" },
        "result": result, "errorMessage": null, "createdAt": "2026-01-01T00:00:00.000Z", "startedAt": null,
        "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

/// The job's status stream: the running record, then the stream ends (the pilot connects again
/// from the last id), then the completed one.
fn job_events(headers: &HeaderMap) -> Response {
    let body = if headers.get("last-event-id").is_some_and(|id| id == "1") {
        format!("id: 2\nevent: job.completed\ndata: {}\n\n", job("job_1", true))
    } else {
        format!(": keepalive\n\nid: 1\nevent: job.progress\ndata: {}\n\n", job("job_1", false))
    };
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

fn item(id: &str, status: &str) -> Value {
    json!({
        "catalog_item_id": id, "language_code": "ja", "title_i18n": {}, "title": format!("Title {id}"), "subtitle_i18n": null,
        "subtitle": null, "display_template_key": null, "display_identity_hash": null, "display_identity_resolved_at": null,
        "blueprint": { "blueprintId": "bpr_card", "name": "Card" }, "status": status, "source_providers": ["tcgplayer", "pokemon"],
        "tags": ["foil"], "updated_at": "2026-01-01T00:00:00.000Z",
    })
}

fn publish_candidate(id: &str, outcome: &str, retryable: bool) -> Value {
    json!({
        "catalog_item_id": id, "title": format!("Title {id}"), "subtitle": null, "status": "draft", "blueprint_id": "bpr_card",
        "blueprint_name": "Card", "source_providers": [], "outcome": outcome,
        "reason": if outcome == "published" { Value::Null } else { json!("Display identity is not resolved yet.") },
        "reason_code": null, "retryable": retryable, "display_identity_readiness": "degraded", "missing_tokens": [],
        "required_field_ids": [],
    })
}

/// A catalog item bulk job, done: a publish (one published, one to retry) or an edit.
fn item_job(id: &str, kind: &str, action: &str) -> Value {
    let result = if kind.ends_with(".publish") {
        json!({ "item_ids": ["cat_a", "cat_b"], "total": 2, "published_count": 1, "failed_count": 1, "skipped_count": 0,
                "candidates": [publish_candidate("cat_a", "published", false), publish_candidate("cat_b", "failed", true)] })
    } else {
        json!({ "action": action, "item_ids": ["cat_a"], "total": 1, "succeeded_count": 1, "skipped_count": 0, "failed_count": 0,
                "candidates": [{ "catalog_item_id": "cat_a", "title": "Title cat_a", "status": "draft", "blueprint_id": null,
                                 "category_ids": [], "tags": ["featured", "foil"], "outcome": "succeeded", "reason": null }] })
    };
    json!({
        "jobId": id, "kind": kind, "action": action, "status": "completed",
        "progress": { "phase": "completed", "completed": 2, "total": 2, "currentName": null, "status": null },
        "result": result, "errorMessage": null, "createdAt": "2026-01-01T00:00:00.000Z", "startedAt": null,
        "completedAt": null, "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

/// The Catalog API's items routes: a page of a draft and an active item (75 in all); `cat_used`
/// cannot be removed.
fn items_api(method: Method, rest: &str, body: &str) -> Response {
    match (method, rest) {
        (Method::GET, "") => {
            Json(json!({ "items": [item("cat_a", "draft"), item("cat_b", "active")], "total": 75, "count": 2 })).into_response()
        }
        (Method::POST, "/bulk-publish/preview") => {
            let candidates = [publish_candidate("cat_a", "ready", false), publish_candidate("cat_b", "blocked", true)];
            Json(json!({ "mode": "ids", "item_ids": ["cat_a", "cat_b"], "total": 2, "ready_count": 1, "blocked_count": 1, "candidates": candidates }))
                .into_response()
        }
        (Method::POST, "/bulk-edit/preview") => {
            let sent: Value = serde_json::from_str(body).unwrap();
            let candidates =
                [json!({ "catalog_item_id": "cat_a", "title": "Title cat_a", "status": "draft", "blueprint_id": null,
                                      "category_ids": ["ctg_1"], "tags": ["foil"], "outcome": "ready", "reason": null })];
            Json(
                json!({ "mode": "ids", "action": sent["operation"]["action"], "item_ids": ["cat_a"], "total": 1, "ready_count": 1,
                         "blocked_count": 0, "candidates": candidates }),
            )
            .into_response()
        }
        (Method::POST, "/bulk-publish/confirm") => {
            (StatusCode::ACCEPTED, Json(item_job("job_publish", "catalog.authoring.items.publish", "publish"))).into_response()
        }
        (Method::POST, "/bulk-edit/confirm") => {
            (StatusCode::ACCEPTED, Json(item_job("job_edit", "catalog.authoring.items.edit", "mergeTags"))).into_response()
        }
        (Method::DELETE, "/cat_used") => refusal(StatusCode::CONFLICT, "invalid_transition", "Only draft items can be removed."),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The Catalog's Scope Records: two on the page of 51, one live and changed lately (a time to
/// come, so it stays fresh), one a draft untouched since 2020. A search for `broken` fails.
fn scope_records(query: &str) -> Response {
    if query.contains("search=broken") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "The scope list is unavailable.");
    }
    let scope = |id: &str, name: &str, code: Option<&str>, editions: &[&str], status: &str, updated: &str| {
        json!({ "scopeRecordId": id, "productDomain": "pokemon", "scopeKind": "expansion", "referenceTypeKey": "expansion",
                "referenceRecordId": format!("ref_{id}"), "referenceRecordKey": id, "name": name, "parentScopeRecordId": null,
                "productLineScopeRecordId": null, "seriesScopeRecordId": null, "releaseDate": null, "officialSetCode": code,
                "languageEditions": editions, "lifecycleStatus": status, "updatedAt": updated })
    };
    let items = [
        scope("scp_paf", "Paldean Fates", Some("PAF"), &["en", "ja"], "active", "2999-01-01T00:00:00.000Z"),
        scope("scp_base", "Base Set", None, &[], "draft", "2020-01-01T00:00:00.000Z"),
    ];
    Json(json!({ "items": items, "total": 51, "count": 2 })).into_response()
}

/// A scope's page's reads and writes. `scp_paf` has two editions (its Japanese alias pending), a
/// draft coverage with a provider available and one mapped, and a job of each kind; `scp_one` has
/// one edition and nothing to review; `scp_down`'s coverage and jobs cannot be read; `scp_gone`
/// is not there. A write whose reason (or provider) is `refuse` is refused.
fn scope_api(method: &Method, path: &str, query: &str, body: &str) -> Option<Response> {
    let scope = |id: &str, editions: &[&str], status: &str| {
        json!({ "scopeRecordId": id, "productDomain": "pokemon", "scopeKind": "expansion", "referenceTypeKey": "expansion",
                "referenceRecordId": format!("ref_{id}"), "referenceRecordKey": id, "name": "Paldean Fates",
                "officialSetCode": "PAF", "languageEditions": editions, "lifecycleStatus": status,
                "updatedAt": "2999-01-01T00:00:00.000Z" })
    };
    let job = |id: &str, kind: &str, status: &str, result: Value, error: Value| {
        json!({ "jobId": id, "kind": kind, "status": status, "progress": { "completed": 1, "total": 2 },
                "result": result, "errorMessage": error })
    };
    let rest = path.strip_prefix(CATALOG)?;
    let answer = match (method.clone(), rest) {
        (Method::GET, "/scope-records/scp_paf") => Json(scope("scp_paf", &["en", "ja"], "draft")).into_response(),
        (Method::GET, "/scope-records/scp_one") => Json(scope("scp_one", &["en"], "active")).into_response(),
        (Method::GET, "/scope-records/scp_down") => Json(scope("scp_down", &["en"], "active")).into_response(),
        (Method::GET, "/scope-records/scp_gone") => refusal(StatusCode::NOT_FOUND, "not_found", "Scope record not found."),
        (Method::GET, "/provider-scope-mappings/coverage/scp_down") | (Method::GET, "/source-observations/bulk-jobs/active")
            if query.contains("scp_down") || rest.ends_with("scp_down") =>
        {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "Unavailable.")
        }
        (Method::GET, "/provider-scope-mappings/inbox") => {
            let paf = json!({ "scopeRecordId": "scp_paf", "scopeName": "Paldean Fates", "productDomain": "pokemon",
                "scopeKind": "set", "officialSetCode": "PAF", "isDraftCanonicalRecord": true,
                "counts": { "total": 2, "highConfidence": 1 }, "candidates": [] });
            let groups = if query.contains("productDomain=magic") { vec![] } else { vec![paf] };
            let n = groups.len();
            Json(json!({ "groups": groups, "counts": { "totalGroups": n, "totalCandidates": 2 * n, "highConfidenceCandidates": n } }))
                .into_response()
        }
        (Method::GET, "/provider-scope-mappings/coverage/scp_paf") => Json(json!({
            "scopeRecordId": "scp_paf",
            "scopeName": "Paldean Fates",
            "lifecycleStatus": "draft",
            "providers": [
                { "providerKey": "tcgplayer", "state": "available", "mapping": { "mappingId": "map_1", "confidence": "high" } },
                { "providerKey": "pokemontcgio", "state": "mapped", "mapping": { "mappingId": "map_2", "confidence": "exact" },
                  "syncedObservations": 12, "promotedObservations": 3 },
                { "providerKey": "cardmarket", "state": "not-offered" },
            ],
        }))
        .into_response(),
        (Method::GET, "/provider-scope-mappings/coverage/scp_gone") => {
            refusal(StatusCode::NOT_FOUND, "not_found", "Scope record not found.")
        }
        (Method::GET, path) if path.starts_with("/provider-scope-mappings/coverage/") => {
            let id = path.trim_start_matches("/provider-scope-mappings/coverage/");
            Json(json!({ "scopeRecordId": id, "scopeName": id, "lifecycleStatus": "active", "providers": [] })).into_response()
        }
        (Method::GET, "/source-observations/bulk-jobs/active")
            if query.contains("scp_paf") && query.contains("status=completed") =>
        {
            let done = json!({ "promoted": 2, "deferred": 0, "skippedNotEligible": 1, "failed": 0,
                               "outcomes": [{ "status": "promoted", "catalogItemId": "itm_1" }, { "status": "promoted", "catalogItemId": "itm_1" }] });
            let cursor = if query.contains("cursor=c2") { Value::Null } else { json!("c2") };
            Json(json!({ "items": [job("job_done", "merge-candidate-promote", "completed", done, Value::Null)], "cursor": cursor }))
                .into_response()
        }
        (Method::GET, "/source-observations/bulk-jobs/active") if query.contains("scp_paf") => Json(json!({
            "items": [job("job_run", "merge-candidate-defer", "running", Value::Null, Value::Null)]
        }))
        .into_response(),
        (Method::GET, "/source-observations/merge-candidate-bulk-jobs/failed") if query.contains("scp_paf") => Json(json!({
            "items": [job("job_fail", "merge-candidate-promote", "failed", Value::Null, json!("The candidate moved."))]
        }))
        .into_response(),
        (Method::GET, "/source-observations/bulk-jobs/active" | "/source-observations/merge-candidate-bulk-jobs/failed") => {
            Json(json!({ "items": [] })).into_response()
        }
        (Method::GET, "/alias-review") => Json(json!({ "candidates": [{
            "aliasHash": "ah_ja", "targetKind": "reference-record", "targetId": "ref_scp_paf",
            "nativePrintedName": "Shiny Treasure ex", "proposedAlias": "Paldean Fates", "aliasLanguageCode": "ja",
            "confidence": "medium", "reviewStatus": "pending", "autoAccept": { "reasons": ["Confidence is below high."] },
            "availableActions": ["alias.accept", "alias.reject", "alias.defer"],
        }] }))
        .into_response(),
        (Method::POST, "/provider-scope-mappings/commands" | "/provider-scope-mappings/propose") if body.contains("refuse") => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "The mapping moved meanwhile.")
        }
        (Method::POST, "/provider-scope-mappings/commands" | "/provider-scope-mappings/propose") => {
            written(StatusCode::OK, "map_1")
        }
        (Method::POST, "/reference-records/scp_paf/publish") => written(StatusCode::OK, "scp_paf"),
        _ => return None,
    };
    Some(answer)
}

const HEALTH: &str = "provider-health:tcgplayer:tcgplayer:mtg:single-card:source-observation-import";

/// The Catalog attention queue: a provider unit's health (critical, its sheet links to the
/// provider's page) and an alias candidate (accept and reject in one click). It cannot be read
/// for `queue-down`; a park whose reason is `refuse` is refused.
fn attention_queue(method: Method, rest: &str, cookie: &str, headers: &HeaderMap, body: &str) -> Response {
    match (method, rest) {
        (Method::GET, _) if cookie.contains("queue-down") && headers.contains_key("chase-sets-read-after-write") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, _) if cookie.contains("queue-down") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "The queue is unavailable.")
        }
        (Method::GET, "") => {
            let q = "catalog.features.attentionQueue";
            let health = json!({
                "itemKey": HEALTH, "kind": "provider-health", "severity": "critical",
                "titleKey": format!("{q}.item.providerHealth.title"),
                "titleParams": { "unit": "TCGplayer Magic Single Cards", "provider": "tcgplayer" },
                "detailKey": format!("{q}.item.providerHealth.detail"),
                "detailParams": { "blocker": "credential", "code": "provider-retired" },
                "providerKey": "tcgplayer", "unitKey": "tcgplayer:mtg:single-card:source-observation-import",
                "observedAt": "2026-10-25T09:20:07.661Z",
                "resolution": { "intent": "review-provider-health", "mode": "drawer", "labelKey": format!("{q}.action.reviewHealth"),
                    "fields": { "providerKey": "tcgplayer", "unitKey": "tcgplayer:mtg:single-card:source-observation-import" },
                    "href": "/catalog/providers/tcgplayer?unitKey=tcgplayer%3Amtg%3Asingle-card%3Asource-observation-import" },
                "secondaryResolutions": [],
            });
            let alias = json!({
                "itemKey": "alias-candidate:h1", "kind": "alias-candidate", "severity": "info",
                "titleKey": format!("{q}.item.aliasCandidate.title"), "titleParams": { "alias": "Charizard ex", "type": "name" },
                "detailKey": format!("{q}.item.aliasCandidate.detail"),
                "detailParams": { "provider": "tcgdex", "type": "name", "confidence": 0.92 },
                "providerKey": "tcgdex", "unitKey": null, "observedAt": "2026-10-24T04:09:09.701000Z",
                "resolution": { "intent": "alias.accept", "mode": "command", "labelKey": format!("{q}.action.acceptAlias"),
                    "fields": { "aliasHashes": "h1" }, "requiresReason": false },
                "secondaryResolutions": [{ "intent": "alias.reject", "mode": "command", "labelKey": format!("{q}.action.rejectAlias"),
                    "fields": { "aliasHashes": "h1" }, "requiresReason": true }],
            });
            Json(json!({
                "generatedAt": "2026-10-25T09:20:07.661Z", "empty": false, "items": [health, alias],
                "counts": { "total": 2, "bySeverity": { "critical": 1, "warning": 0, "info": 1 },
                    "byKind": { "unmapped-scope": 0, "merge-conflict": 0, "provider-health": 1, "import-job": 0,
                        "alias-candidate": 1, "stale-scope-sync": 0 } },
                "freshness": { "generatedAt": "2026-10-25T09:20:07.661Z", "oldestObservedAt": null, "newestObservedAt": null },
            }))
            .into_response()
        }
        (Method::POST, "/commands") if body.contains(r#""reason":"refuse""#) => {
            refusal(StatusCode::BAD_REQUEST, "attention_queue_invalid_kind", "Parking an attention item requires its kind.")
        }
        (Method::POST, "/commands") => written(StatusCode::OK, "attention"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The Catalog API, as far as the area uses it. A dimension list has 120 rows (three pages). A
/// bulk archive cannot start (another change is running).
/// A Source Observation the stand-in knows: `obs_card`, an observed Pokemon card; `obs_product`,
/// a changed provider product; `obs_done`, a promoted one. Promoting `obs_held` is refused by a
/// rollout control (403), as the API answers it.
fn observation(id: &str, status: &str) -> Value {
    let normalized = if id == "obs_product" {
        json!({ "kind": "provider-product", "name": "Booster Box", "imageUrls": [], "providerProductId": "pp_9",
                "productLineName": "Lorcana", "productCategoryName": null,
                "skuReferences": [{ "externalKey": "sku-1" }, { "externalKey": "sku-2" }] })
    } else {
        json!({ "kind": "pokemon-card", "name": "Pikachu", "setName": "Base", "expansionName": null, "cardNumber": "58",
                "imageUrls": ["https://images.example/pikachu.png"], "cardVariantLabel": "Holo", "rarity": "Common",
                "imageDisclaimer": null, "illustrator": "Atsuko Nishida", "releaseDate": "1999-01-09" })
    };
    json!({ "observation_id": id, "provider_key": "tcgdex", "external_key": "base1-58", "source_url": "https://api.example/base1-58",
            "language_code": "en", "source_record_hash": "h_1", "source_updated_at": null, "observed_at": "2026-10-30T10:00:00Z",
            "source_profile_key": "tcgdex-cards", "source_profile_version": "3", "source_mapping_fingerprint": "fp_map",
            "normalized": normalized, "status": status, "status_reason": null,
            "promoted_catalog_item_id": if status == "promoted" { json!("cat_pika") } else { Value::Null },
            "promoted_reference_record_id": null, "promoted_at": null,
            "promotion_profile_key": if status == "promoted" { json!("pokemon-cards") } else { Value::Null },
            "promotion_profile_version": if status == "promoted" { json!("2") } else { Value::Null },
            "promotion_plan_fingerprint": null, "updated_at": "2026-10-30T10:00:00Z", "source_payload": {} })
}

fn observation_api(method: &Method, rest: &str, _body: &str) -> Option<Response> {
    let rest = rest.strip_prefix("/source-observations/")?;
    let (id, action) = rest.split_once('/').map_or((rest, None), |(id, action)| (id, Some(action)));
    let status = match id {
        "obs_card" | "obs_held" => "observed",
        "obs_product" => "changed",
        "obs_done" => "promoted",
        "obs_down" if *method == Method::GET => return Some(StatusCode::SERVICE_UNAVAILABLE.into_response()),
        _ if !id.starts_with("obs_") => return None,
        _ => return Some(refusal(StatusCode::NOT_FOUND, "not_found", "Source observation not found.")),
    };
    Some(match (method, action) {
        (&Method::GET, None) => Json(observation(id, status)).into_response(),
        (&Method::POST, Some("promote")) if id == "obs_held" => {
            refusal(StatusCode::FORBIDDEN, "catalog_integration_rollout_denied", "Promotion is paused for this provider.")
        }
        (&Method::POST, Some("promote" | "reject")) => Json(json!({ "observation_id": id })).into_response(),
        _ => return None,
    })
}

fn catalog_api(method: Method, rest: &str, headers: &HeaderMap, body: &str) -> Response {
    if let Some(rest) = rest.strip_prefix("/items")
        && !rest.starts_with("/bulk-lifecycle")
    {
        let answer = items_api(method.clone(), rest, body);
        if answer.status() != StatusCode::NOT_FOUND {
            return answer;
        }
    }
    if let Some(answer) = observation_api(&method, rest, body) {
        return answer;
    }
    match (method, rest) {
        (Method::GET, "/bulk-authoring-jobs/job_publish") => {
            Json(item_job("job_publish", "catalog.authoring.items.publish", "publish")).into_response()
        }
        (Method::GET, "/bulk-authoring-jobs/job_edit") => {
            Json(item_job("job_edit", "catalog.authoring.items.edit", "mergeTags")).into_response()
        }
        (
            Method::POST,
            "/dimensions/bulk-lifecycle/preview"
            | "/fields/bulk-lifecycle/preview"
            | "/categories/bulk-lifecycle/preview"
            | "/components/bulk-lifecycle/preview"
            | "/blueprints/bulk-lifecycle/preview"
            | "/reference-types/bulk-lifecycle/preview"
            | "/reference-records/bulk-lifecycle/preview"
            | "/items/bulk-lifecycle/preview",
        ) => {
            let sent: Value = serde_json::from_str(body).unwrap();
            let candidates = [
                candidate("dim_seed", "active", "ready", None),
                candidate("dim_b", "draft", "blocked", Some("Only an active dimension can be deprecated.")),
            ];
            Json(json!({ "mode": sent["selection"]["mode"], "action": sent["action"], "ids": ["dim_seed", "dim_b"], "total": 2,
                         "ready_count": 1, "blocked_count": 1, "candidates": candidates }))
            .into_response()
        }
        (Method::POST, "/dimensions/bulk-lifecycle/confirm") if body.contains(r#""action":"archive""#) => {
            refusal(StatusCode::CONFLICT, "conflict", "Another bulk change is running.")
        }
        (
            Method::POST,
            "/dimensions/bulk-lifecycle/confirm"
            | "/fields/bulk-lifecycle/confirm"
            | "/categories/bulk-lifecycle/confirm"
            | "/components/bulk-lifecycle/confirm"
            | "/blueprints/bulk-lifecycle/confirm"
            | "/reference-types/bulk-lifecycle/confirm"
            | "/reference-records/bulk-lifecycle/confirm"
            | "/items/bulk-lifecycle/confirm",
        ) => (StatusCode::ACCEPTED, Json(job("job_1", false))).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_1") => Json(job("job_1", false)).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_done") => Json(job("job_done", true)).into_response(),
        (Method::GET, "/bulk-authoring-jobs/job_1/events") => job_events(headers),
        (Method::GET, "/bulk-authoring-jobs/job_missing" | "/bulk-authoring-jobs/job_missing/events") => {
            refusal(StatusCode::NOT_FOUND, "not_found", "Bulk authoring job not found.")
        }
        (Method::GET, "/dimensions") => Json(json!({ "items": [dimension("dim_seed", "active")], "total": 120 })).into_response(),
        (Method::GET, "/dimensions/dim_pending") => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "projection_freshness_timeout",
            "Projection read model did not catch up to the requested write receipt before the freshness timeout.",
        ),
        (Method::GET, "/dimensions/dim_seed") => {
            let mut detail = dimension("dim_seed", "active");
            detail["options"] = json!([option("chc_a", "nm", "active", 1), option("chc_b", "lp", "deprecated", 2)]);
            Json(detail).into_response()
        }
        (Method::GET, "/dimensions/dim_missing") => refusal(StatusCode::NOT_FOUND, "not_found", "Dimension not found."),
        (Method::POST, "/dimensions") if body.contains(r#""key":"taken""#) => {
            refusal(StatusCode::CONFLICT, "conflict", "A dimension with this key already exists.")
        }
        (Method::POST, "/dimensions/dim_seed/archive") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "Only a deprecated dimension can be archived.")
        }
        (Method::GET, "/fields") => Json(json!({ "items": [catalog_field("fld_seed")], "total": 1 })).into_response(),
        (Method::GET, "/fields/fld_seed") => Json(catalog_field("fld_seed")).into_response(),
        (Method::GET, "/categories") => Json(json!({ "items": [catalog_category("ctg_seed")], "total": 1 })).into_response(),
        (Method::GET, "/categories/ctg_seed") => Json(catalog_category("ctg_seed")).into_response(),
        (Method::GET, "/components") => Json(json!({
            "items": [{
                "component_id": "cmp_seed", "key": "card-face", "name": "Card face", "status": "draft",
                "field_rules": [{ "fieldId": "fld_seed", "required": true }],
                "dimension_rules": [{ "dimensionId": "dim_seed", "required": false, "allowedOptionIds": ["chc_a"],
                                      "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x"] }] }],
            }],
            "total": 1,
        }))
        .into_response(),
        (Method::GET, "/components/cmp_seed") => Json(catalog_component("cmp_seed")).into_response(),
        (Method::DELETE, "/components/cmp_seed/field-rules/fld_gone") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "The component has no rule for this field.")
        }
        (Method::GET, "/display-templates") => {
            Json(json!({ "items": [display_template("dtp_seed")], "total": 1 })).into_response()
        }
        (Method::GET, "/display-templates/dtp_seed") => Json(display_template("dtp_seed")).into_response(),
        (Method::POST, "/display-templates/dtp_seed/publish") => refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "Display Template token {field.card-name} references an unknown or inactive field.",
        ),
        (Method::GET, "/reference-types") => Json(json!({ "items": [reference_type("rft_seed")], "total": 1 })).into_response(),
        (Method::GET, "/reference-types/rft_seed") => Json(reference_type("rft_seed")).into_response(),
        (Method::GET, "/reference-records") => {
            Json(json!({ "items": [reference_record("ref_seed")], "total": 1 })).into_response()
        }
        (Method::GET, "/reference-records/ref_seed") => Json(reference_record("ref_seed")).into_response(),
        (Method::POST, "/reference-types/rft_seed/archive") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "Only a deprecated reference type can be archived.")
        }
        (Method::GET, "/blueprints") => Json(catalog_blueprints()).into_response(),
        (Method::GET, "/blueprints/bpr_seed" | "/blueprints/bpr_other") => {
            Json(catalog_blueprint(rest.trim_start_matches("/blueprints/"))).into_response()
        }
        (Method::DELETE, "/blueprints/bpr_seed/components/cmp_gone") => {
            refusal(StatusCode::CONFLICT, "invalid_transition", "The component is not attached to this blueprint.")
        }
        (Method::POST | Method::PUT | Method::DELETE, _) => written(StatusCode::OK, "cmd"),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The platform's realtime stream: a heartbeat and one change, then the stream ends (the client
/// connects again). It refuses `catalog-reader`, standing in for a session the API will not stream
/// (`catalog-viewer` has the same permissions and is streamed).
fn realtime(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=catalog-reader") || cookie.contains("chase_sets_session=ops-refused") {
        return refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "Forbidden.");
    }
    let patch = r#"{"kind":"projection.patch","context":"catalog","projection":"catalog-dimensions","topics":["catalog:admin:dimensions"],"changes":[{"op":"summary","entity":"catalog.adminProjection","id":"dimensions:x","value":{}},{"op":"summary","entity":"catalog.adminProjection","id":"dimensions:y","value":{}}]}"#;
    let body = format!("id: c1\nevent: heartbeat\ndata: {{}}\nretry: 1000\n\nid: c2\nevent: projection.patch\ndata: {patch}\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

impl Pilot {
    /// The first `count` server-sent events of a stream at `uri` (their `event:` and `data:`), or
    /// what came before it ended.
    async fn events(&self, uri: &str, session: &str, count: usize) -> Vec<(String, String)> {
        let events = self.events_with_ids(get(uri, Some(session)), count).await;
        events.into_iter().map(|(event, _, data)| (event, data)).collect()
    }

    /// The same for `req` (a reconnect sends `Last-Event-ID`), with each event's `id:`.
    async fn events_with_ids(&self, req: Request<Body>, count: usize) -> Vec<(String, String, String)> {
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

    fn calls_to(&self, prefix: &str) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(prefix)).cloned().collect()
    }

    /// The calls to the Catalog API.
    fn catalog_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(CATALOG)).cloned().collect()
    }

    fn catalog_writes(&self) -> Vec<Call> {
        self.catalog_calls().into_iter().filter(|c| c.method != Method::GET).collect()
    }

    /// The stylesheet a page links whose URL contains `part`, and its text.
    async fn stylesheet(&self, html: &str, part: &str) -> Option<String> {
        let start = html.find(part)?;
        let href_start = html[..start].rfind("href=\"")? + 6;
        let href_end = href_start + html[href_start..].find('"')?;
        let (status, _, css) = self.send(get(&html[href_start..href_end], None)).await;
        assert_eq!(status, StatusCode::OK, "{}", &html[href_start..href_end]);
        Some(css)
    }
}

#[tokio::test]
async fn the_catalog_is_an_area_with_its_own_guard_and_stylesheet() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/catalog/dimensions/dim_seed", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "http://localhost:7752/access/sign-in?returnTo=%2Fcatalog%2Fdimensions");
    let (status, _, _) = pilot.send(get("/catalog/dimensions", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed to read");
    let (status, _, _) = pilot.send(get("/catalog/dimensions", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = pilot.send(post_as("catalog-reader", "/catalog/dimensions", "key=size", true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.manage is needed to write");
    let (status, _, _) = pilot.send(get("/commerce/postage-policies", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the postage area keeps its own permission");
    assert!(pilot.catalog_writes().is_empty(), "a refused write reaches no handler");
    let (status, headers, _) = pilot.send(get("/catalog", Some("staff"))).await;
    assert_eq!(
        (status, &headers[header::LOCATION]),
        (StatusCode::SEE_OTHER, &"/catalog/dimensions".parse::<header::HeaderValue>().unwrap())
    );

    // Each area's pages link its stylesheet, and only theirs; the shared one has neither's rules.
    let (_, _, catalog) = pilot.send(get("/catalog/dimensions", Some("staff"))).await;
    let (_, _, postage) = pilot.send(get("/commerce/postage-policies", Some("staff"))).await;
    assert!(catalog.contains("sections/catalog") && !catalog.contains("sections/commerce"), "{catalog}");
    assert!(postage.contains("sections/commerce/postage-policies") && !postage.contains("sections/catalog"), "{postage}");
    let section = pilot.stylesheet(&catalog, "sections/catalog").await.unwrap();
    let shared = pilot.stylesheet(&catalog, "components").await.unwrap();
    assert!(section.contains(".list-page__table") && section.contains(".dialog__form"), "{section}");
    assert!(!section.contains(".policy-table__"), "{section}");
    assert!(!shared.contains(".list-page__") && !shared.contains(".policy-table__"), "{shared}");
    assert!(shared.contains(".admin-nav__bar"), "{shared}");
}

#[tokio::test]
async fn the_list_asks_the_api_as_admin_web_does_and_pages() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/dimensions?search=cond&status=active&value_kind=&page=2", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    let calls = pilot.catalog_calls();
    assert_eq!(calls[0].path, "/api/catalog/dimensions?search=cond&status=active&limit=50&offset=50", "{calls:?}");
    assert_eq!(calls[0].headers["chase-sets-read-target-context"], "catalog");
    assert!(html.contains(r#"<a class="list-page__view" href="/catalog/dimensions/dim_seed">View</a>"#), "{html}");
    assert!(html.contains(r#"href="/catalog/dimensions?search=cond&amp;status=active" rel="prev""#), "{html}");
    assert!(html.contains(r#"href="/catalog/dimensions?search=cond&amp;status=active&amp;page=3" rel="next""#), "{html}");
    assert!(html.contains("Page 2 of 3"), "{html}");
    assert!(html.contains(r#"<option value="active" selected>Active</option>"#), "the filter shows its value: {html}");
    assert!(html.contains(r#"href="/catalog/dimensions" aria-current="page""#), "the catalog's own nav: {html}");
    assert!(html.contains(r#"href="/catalog/fields""#), "{html}");
}

#[tokio::test]
async fn a_create_sends_its_drawn_id_and_comes_back_with_the_receipt_and_the_toast() {
    let pilot = Pilot::new().await;
    let body = "dimension_id=dim_01JZ&key=size&name=+Size+&description=&value_kind=ordered";
    let (status, headers, _) = pilot.send(post("/catalog/dimensions?status=active", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/dimensions?status=active&after_write=") && to.ends_with("&done=created"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!((sent.method, sent.path.as_str()), (Method::POST, "/api/catalog/dimensions"));
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "dimensionId": "dim_01JZ", "key": "size", "valueKind": "ordered",
                "name": { "defaultLocale": "en", "values": { "en": "Size" } },
                "description": { "defaultLocale": "en", "values": {} } })
    );
    let (status, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<div id="ui-toast">Dimension created</div>"#), "{html}");
    assert!(pilot.catalog_calls().last().unwrap().headers.contains_key("chase-sets-read-after-write"));
}

#[tokio::test]
async fn a_refused_create_comes_back_in_its_dialog() {
    let pilot = Pilot::new().await;
    let body = "dimension_id=dim_01JZ&key=taken&name=Size&description=&value_kind=ordered";
    let (status, headers, html) = pilot.send(post("/catalog/dimensions", body, true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"));
    assert!(html.starts_with(r#"<form class="dialog__form" id="catalog-create""#), "{html}");
    assert!(html.contains("A dimension with this key already exists.") && html.contains(r#"value="dim_01JZ""#), "{html}");
    // Without JavaScript: the page, with the dialog open on the same form.
    let (status, _, html) = pilot.send(post("/catalog/dimensions", body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="catalog-create-dialog" aria-labelledby="catalog-create-dialog-title" open"#), "{html}");
    assert!(html.contains("A dimension with this key already exists."), "{html}");
}

#[tokio::test]
async fn a_dimension_shows_its_options_and_the_changes_its_status_allows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/dimensions/dim_seed", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<h1 class="detail-page__title">Condition</h1>"#), "{html}");
    assert!(html.contains(r#"command="show-modal" commandfor="catalog-lifecycle-deprecate">Deprecate</button>"#), "{html}");
    assert!(!html.contains(r#"value="activate""#), "an active dimension is not activated: {html}");
    assert!(html.contains("2 option(s)") && html.contains(">NM<") && html.contains(">2.5<"), "{html}");
    assert!(html.contains(r#"name="action" value="deprecate">Deprecate</button>"#), "the active option: {html}");
    assert!(html.contains(r#"name="action" value="reactivate">Reactivate</button>"#), "the deprecated one: {html}");
    assert!(html.contains(r#"value="chc_a, chc_b""#), "the reorder form starts from the order: {html}");
    assert!(html.contains(r#"name="label_locale" value="fr""#), "an option's edit form has its labels: {html}");

    let (status, _, _) = pilot.send(get("/catalog/dimensions/dim_missing", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) =
        pilot.send(get(&format!("/catalog/dimensions/dim_pending?after_write={}", fresh_receipt()), Some("staff"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "the write is not readable yet");
}

#[tokio::test]
async fn lifecycle_changes_go_to_their_api_routes_and_a_refusal_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=deprecate&status=active", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with("/catalog/dimensions/dim_seed?after_write=") && to.ends_with("&done=deprecated"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!((sent.path.as_str(), sent.body.as_str()), ("/api/catalog/dimensions/dim_seed/deprecate", ""));
    let (_, _, html) = pilot.send(get(to, Some("staff"))).await;
    assert!(html.contains(r#"<div id="ui-toast">Dimension deprecated.</div>"#), "{html}");

    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=archive&status=deprecated", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="detail-page__lifecycle" id="catalog-lifecycle""#), "{html}");
    assert!(html.contains("Only a deprecated dimension can be archived."), "{html}");

    let writes = pilot.catalog_writes().len();
    let (status, _, html) = pilot.send(post("/catalog/dimensions/dim_seed/lifecycle", "action=delete&status=active", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), writes, "an action the form does not offer is not sent");
}

#[tokio::test]
async fn options_are_added_revised_retired_and_reordered() {
    let pilot = Pilot::new().await;
    // Add Label draws the form again with a row more, and writes nothing.
    let rows = "code=nm&numeric_value=&label_locale=en&label_value=Near+mint";
    let (status, headers, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", &format!("option_id=chc_x&{rows}&relabel=add"), true)).await;
    assert_eq!((status, headers.contains_key("corten-patch")), (StatusCode::OK, true));
    assert_eq!(html.matches(r#"name="label_locale""#).count(), 2, "{html}");
    assert!(html.contains(r#"value="Near mint""#), "{html}");
    assert!(pilot.catalog_writes().is_empty());
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", &format!("option_id=chc_x&{rows}&relabel=add"), false)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"id="catalog-add-option-dialog" aria-labelledby="catalog-add-option-dialog-title" open"#), "{html}");

    // A number that does not parse is the pilot's own check.
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/dim_seed/options", "option_id=chc_x&code=nm&numeric_value=two", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"id="catalog-add-option-numeric_value-error""#), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let posts = [
        (
            "/catalog/dimensions/dim_seed/options",
            format!("option_id=chc_x&{}", rows.replace("numeric_value=", "numeric_value=3")),
            "option_added",
        ),
        ("/catalog/dimensions/dim_seed/options/chc_a", rows.to_owned(), "option_revised"),
        ("/catalog/dimensions/dim_seed/options/chc_a/lifecycle", "action=deprecate&status=active".into(), "option_deprecated"),
        (
            "/catalog/dimensions/dim_seed/options/chc_b/lifecycle",
            "action=reactivate&status=deprecated".into(),
            "option_reactivated",
        ),
        ("/catalog/dimensions/dim_seed/options/order", "option_ids=chc_b%2C+chc_a%2C".into(), "reordered"),
    ];
    for (uri, body, done) in &posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().ends_with(&format!("&done={done}")), "{uri}: {headers:?}");
    }
    let sent: Vec<(Method, String, String)> = pilot.catalog_writes().into_iter().map(|c| (c.method, c.path, c.body)).collect();
    let label = json!({ "defaultLocale": "en", "values": { "en": "Near mint" } });
    assert_eq!((&sent[0].0, sent[0].1.as_str()), (&Method::POST, "/api/catalog/dimensions/dim_seed/options"));
    assert_eq!(
        serde_json::from_str::<Value>(&sent[0].2).unwrap(),
        json!({ "optionId": "chc_x", "code": "nm", "label": label, "numericValue": 3.0 })
    );
    assert_eq!((&sent[1].0, sent[1].1.as_str()), (&Method::PUT, "/api/catalog/dimensions/dim_seed/options/chc_a"));
    assert_eq!(serde_json::from_str::<Value>(&sent[1].2).unwrap(), json!({ "code": "nm", "label": label }));
    assert_eq!(sent[2].1, "/api/catalog/dimensions/dim_seed/options/chc_a/deprecate");
    assert_eq!(sent[3].1, "/api/catalog/dimensions/dim_seed/options/chc_b/reactivate");
    assert_eq!((&sent[4].0, sent[4].1.as_str()), (&Method::PUT, "/api/catalog/dimensions/dim_seed/options/order"));
    assert_eq!(serde_json::from_str::<Value>(&sent[4].2).unwrap(), json!({ "optionIds": ["chc_b", "chc_a"] }));
}

#[tokio::test]
async fn fields_are_created_configured_and_activated() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/fields?filterable=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/fields?filterable=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/fields/fld_seed">View</a>"#), "{html}");

    let body = "field_id=fld_01JZ&key=language&name=Language&description=&value_type=string&filterable=on&sortable=on";
    let (status, headers, _) = pilot.send(post("/catalog/fields", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));
    let (status, _, _) =
        pilot.send(post("/catalog/fields/fld_seed/edit", "key=language&name=Language&value_type=number", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "without JavaScript a write is a redirect");
    let (status, _, _) = pilot.send(post("/catalog/fields/fld_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let sent = pilot.catalog_writes();
    let behavior = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap()["behavior"].clone();
    assert_eq!(behavior(0), json!({ "filterable": true, "searchable": false, "sortable": true }));
    assert_eq!(serde_json::from_str::<Value>(&sent[0].body).unwrap()["fieldId"], "fld_01JZ");
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/fields/fld_seed"));
    assert_eq!(behavior(1), json!({ "filterable": false, "searchable": false, "sortable": false }));
    assert_eq!(sent[2].path, "/api/catalog/fields/fld_seed/activate");

    let (_, _, html) = pilot.send(get("/catalog/fields/fld_seed", Some("staff"))).await;
    assert!(html.contains("<dt>Filterable</dt>") && html.contains("<dd>Yes</dd>") && html.contains("<dd>No</dd>"), "{html}");
    assert!(html.contains(r#"name="action" value="activate">Activate</button>"#), "a draft is activated: {html}");
    assert!(html.contains(r#"name="filterable" checked"#), "the configure form starts from the field: {html}");
}

#[tokio::test]
async fn categories_are_created_revised_and_published_not_activated() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/categories?hierarchy=child&parent_category_id=ctg_root", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        pilot.catalog_calls()[0].path,
        "/api/catalog/categories?parentCategoryId=ctg_root&hierarchy=child&limit=50&offset=0"
    );
    assert!(html.contains(r#"href="/catalog/categories/ctg_seed">View</a>"#), "{html}");
    assert!(html.contains("<td>Energy types</td>"), "a child shows its parent's name: {html}");
    assert!(html.contains(r#"<option value="child" selected>Child Categories</option>"#), "{html}");

    // A create leaves an empty parent out; an edit sends it as null (a root category).
    let body = "category_id=ctg_01JZ&key=fire&name=Fire&description=&parent_category_id=&display_order=2";
    let (status, headers, _) = pilot.send(post("/catalog/categories", body, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));
    let body = "key=fire&name=Fire&description=&parent_category_id=&display_order=next";
    let (status, _, _) = pilot.send(post("/catalog/categories/ctg_seed/edit", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "without JavaScript a write is a redirect");
    let (status, _, _) = pilot.send(post("/catalog/categories/ctg_seed/lifecycle", "action=publish&status=draft", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/categories"));
    assert_eq!((body(0)["categoryId"].clone(), body(0)["displayOrder"].clone()), (json!("ctg_01JZ"), json!(2)));
    assert!(body(0).get("parentCategoryId").is_none(), "{:?}", body(0));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/categories/ctg_seed"));
    assert_eq!((body(1)["parentCategoryId"].clone(), body(1)["displayOrder"].clone()), (Value::Null, json!(0)));
    assert!(body(1).get("categoryId").is_none(), "{:?}", body(1));
    assert_eq!(sent[2].path, "/api/catalog/categories/ctg_seed/publish");
    assert_eq!(sent.len(), 3);

    // A category is published, never activated: the page offers Publish, and Activate is refused.
    let (_, _, html) = pilot.send(get("/catalog/categories/ctg_seed", Some("staff"))).await;
    assert!(html.contains("<dt>Parent Category</dt>") && html.contains("<dd>Energy types</dd>"), "{html}");
    assert!(html.contains(r#"name="action" value="publish">Publish</button>"#), "a draft is published: {html}");
    assert!(html.contains(r#"value="ctg_root""#), "the edit form starts from the category: {html}");
    let (status, _, html) =
        pilot.send(post("/catalog/categories/ctg_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 3, "nothing more sent");
}

#[tokio::test]
async fn components_are_created_and_their_rules_added_and_removed() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/components?has_field_rules=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/components?hasFieldRules=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/components/cmp_seed">View</a>"#), "{html}");

    let (status, headers, _) =
        pilot.send(post("/catalog/components", "component_id=cmp_01JZ&key=back&name=Back&description=", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));

    // The page: each rule, with what it names, its options and when it applies.
    let (_, _, html) = pilot.send(get("/catalog/components/cmp_seed", Some("staff"))).await;
    assert!(html.contains("<td>Language</td>") && html.contains("<td>Condition</td>"), "{html}");
    assert!(html.contains("<td>nm</td>") && html.contains("<td>Finish = holo</td>"), "{html}");
    assert!(html.contains(r#"action="/catalog/components/cmp_seed/field-rules/fld_seed/remove""#), "{html}");
    assert!(html.contains(r#"name="action" value="activate">Activate</button>"#), "{html}");

    let posts = [
        ("/catalog/components/cmp_seed/edit", "key=card-face&name=Card+front&description="),
        ("/catalog/components/cmp_seed/field-rules", "field_id=+fld_x+&required=on"),
        (
            "/catalog/components/cmp_seed/dimension-rules",
            "dimension_id=dim_x&allowed_option_ids=chc_1%2C+chc_2&applies_when=dim_b%3Dchc_x%7Cchc_y%2C+bad%2C+dim_c%3D",
        ),
        ("/catalog/components/cmp_seed/field-rules/fld_seed/remove", ""),
        ("/catalog/components/cmp_seed/dimension-rules/dim_seed/remove", ""),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().starts_with("/catalog/components/cmp_seed?"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/components"));
    assert_eq!(body(0)["componentId"], "cmp_01JZ");
    // The edit restates the rules the API has, read from the list (the component's own table)
    // just before the write, not from the page's read.
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/components/cmp_seed"));
    assert_eq!(body(1)["fieldRules"], json!([{ "fieldId": "fld_seed", "required": true }]));
    assert_eq!(
        body(1)["dimensionRules"],
        json!([{ "dimensionId": "dim_seed", "required": false, "allowedOptionIds": ["chc_a"],
                 "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x"] }] }])
    );
    assert_eq!(sent[2].path, "/api/catalog/components/cmp_seed/field-rules");
    assert_eq!(body(2), json!({ "fieldId": "fld_x", "required": true }));
    assert_eq!(sent[3].path, "/api/catalog/components/cmp_seed/dimension-rules");
    assert_eq!(
        body(3),
        json!({ "dimensionId": "dim_x", "required": false, "allowedOptionIds": ["chc_1", "chc_2"],
                "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] })
    );
    assert_eq!(
        (&sent[4].method, sent[4].path.as_str()),
        (&Method::DELETE, "/api/catalog/components/cmp_seed/field-rules/fld_seed")
    );
    assert_eq!(sent[5].path, "/api/catalog/components/cmp_seed/dimension-rules/dim_seed");
    assert_eq!(sent.len(), 6);
    let reads: Vec<String> = pilot
        .catalog_calls()
        .into_iter()
        .filter(|c| c.method == Method::GET && c.path.starts_with("/api/catalog/components"))
        .map(|c| c.path)
        .collect();
    assert_eq!(
        reads,
        [
            "/api/catalog/components?hasFieldRules=true&limit=50&offset=0",
            "/api/catalog/components/cmp_seed",
            "/api/catalog/components?limit=50&offset=0",
        ],
        "the list, the page, and the edit's read of the rules"
    );
}

#[tokio::test]
async fn a_refused_rule_removal_is_its_rows_message_and_a_component_bulk_change_previews() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(post("/catalog/components/cmp_seed/field-rules/fld_gone/remove", "", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.contains("The component has no rule for this field."), "{html}");
    let (status, _, html) = pilot.send(post("/catalog/components/cmp_seed/field-rules/fld_gone/remove", "", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("The component has no rule for this field."), "{html}");

    // An edit of a component the list does not have writes nothing: its rules would be lost.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/components/cmp_other/edit", "key=x&name=X&description=", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("rules could not be read, so it was not saved"), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/components/bulk?has_dimension_rules=false", "action=activate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Activate Preview"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/components/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "activate", "selection": { "mode": "filter", "query": { "hasDimensionRules": "false" } } })
    );
}

/// A `GET` as the runtime sends it from a `data-patch` form (`corten: action`): a dialog opened.
fn opened(uri: &str) -> Request<Body> {
    let mut req = get(uri, Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    req
}

#[tokio::test]
async fn blueprints_are_created_and_their_components_attached_and_rules_set() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/blueprints?has_components=true", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/blueprints?hasComponents=true&limit=50&offset=0");
    assert!(html.contains(r#"href="/catalog/blueprints/bpr_seed">View</a>"#), "{html}");

    let (status, headers, _) =
        pilot.send(post("/catalog/blueprints", "blueprint_id=bpr_01JZ&key=lot&name=Lot&description=", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().ends_with("&done=created"));

    // The page: its components, its rules folded with what they name, and a draft's openers,
    // which carry the page's receipt.
    let receipt = fresh_receipt();
    let (_, _, html) = pilot.send(get(&format!("/catalog/blueprints/bpr_seed?after_write={receipt}"), Some("staff"))).await;
    assert!(html.contains("<td>Card face</td>") && html.contains("<td>Language</td>"), "{html}");
    assert!(html.contains("<td>nm</td>") && html.contains("<td>Finish = holo</td>"), "{html}");
    assert!(html.contains("1 field rules") && html.contains("<dd>Condition</dd>"), "{html}");
    assert!(html.contains(r#"action="/catalog/blueprints/bpr_seed/components/cmp_seed/detach""#), "{html}");
    assert!(html.contains(r#"action="/catalog/blueprints/bpr_seed/field-rules" data-patch"#), "{html}");
    assert!(html.contains(r#"name="after_write" value=""#), "{html}");
    assert!(html.contains(r#"name="action" value="publish">Publish</button>"#), "{html}");

    // A Set dialog starts from the list's rules (two field rules), not the page's (one).
    let (status, headers, html) =
        pilot.send(opened(&format!("/catalog/blueprints/bpr_seed/field-rules?after_write={receipt}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.contains(r#"value="fld_seed""#) && html.contains(r#"value="fld_more""#), "{html}");
    assert!(html.contains(r#"name="required" value="0" checked"#) && !html.contains(r#"value="1" checked"#), "{html}");
    let list_read = pilot.catalog_calls().into_iter().last().unwrap();
    assert_eq!(list_read.path, "/api/catalog/blueprints?limit=50&offset=0");
    assert!(list_read.headers.contains_key("chase-sets-read-after-write"), "the list read waits for the page's write");
    let (_, _, html) = pilot.send(opened("/catalog/blueprints/bpr_seed/dimension-rules")).await;
    assert!(html.contains(r#"value="dim_seed""#) && html.contains(r#"value="chc_a""#), "{html}");
    assert!(html.contains(r#"value="dim_b=chc_x|chc_y""#), "{html}");
    let (_, _, html) = pilot.send(opened("/catalog/blueprints/bpr_seed/product-resolution-rules")).await;
    assert!(html.contains(r#"value="dim_seed, dim_b""#), "{html}");

    // Add Rule draws the form again with a row more, and writes nothing.
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bpr_seed/field-rules", "field_id=fld_seed&required=0&rerow=add", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(html.matches(r#"name="field_id""#).count(), 2, "{html}");
    assert!(pilot.catalog_writes().iter().all(|w| !w.path.ends_with("/fields")));

    let posts = [
        ("/catalog/blueprints/bpr_seed/edit", "key=single&name=Card+single+v2&description="),
        ("/catalog/blueprints/bpr_seed/field-rules", "field_id=fld_seed&required=0&field_id=+fld_x+&field_id="),
        (
            "/catalog/blueprints/bpr_seed/dimension-rules",
            "dimension_id=dim_x&required=0&allowed_option_ids=chc_1%2C+chc_2&applies_when=dim_b%3Dchc_x%7Cchc_y%2C+bad",
        ),
        ("/catalog/blueprints/bpr_seed/product-resolution-rules", "canonical_dimension_order=dim_b%2C+dim_seed%2C"),
        ("/catalog/blueprints/bpr_seed/components", "component_id=+cmp_x+"),
        ("/catalog/blueprints/bpr_seed/components/cmp_seed/detach", ""),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers["corten-location"].to_str().unwrap().starts_with("/catalog/blueprints/bpr_seed?"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/blueprints"));
    assert_eq!(body(0)["blueprintId"], "bpr_01JZ");
    // The revise sends the key, name and description only.
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/blueprints/bpr_seed"));
    assert_eq!(body(1)["key"], "single");
    assert!(body(1).get("fieldRules").is_none(), "{}", body(1));
    assert_eq!((&sent[2].method, sent[2].path.as_str()), (&Method::PUT, "/api/catalog/blueprints/bpr_seed/fields"));
    assert_eq!(
        body(2),
        json!({ "fieldRules": [{ "fieldId": "fld_seed", "required": true }, { "fieldId": "fld_x", "required": false }] })
    );
    assert_eq!(sent[3].path, "/api/catalog/blueprints/bpr_seed/dimensions");
    assert_eq!(
        body(3),
        json!({ "dimensionRules": [{ "dimensionId": "dim_x", "required": true, "allowedOptionIds": ["chc_1", "chc_2"],
                                     "appliesWhen": [{ "dimensionId": "dim_b", "optionIds": ["chc_x", "chc_y"] }] }] })
    );
    assert_eq!(sent[4].path, "/api/catalog/blueprints/bpr_seed/product-resolution-rules");
    assert_eq!(body(4), json!({ "canonicalDimensionOrder": ["dim_b", "dim_seed"] }));
    assert_eq!((&sent[5].method, sent[5].path.as_str()), (&Method::POST, "/api/catalog/blueprints/bpr_seed/components/cmp_x"));
    assert_eq!(
        (&sent[6].method, sent[6].path.as_str()),
        (&Method::DELETE, "/api/catalog/blueprints/bpr_seed/components/cmp_seed")
    );
    assert_eq!(sent.len(), 7);
}

#[tokio::test]
async fn a_set_dialog_the_list_cannot_fill_has_no_form_and_blueprint_refusals_stay_on_the_page() {
    let pilot = Pilot::new().await;
    // The list does not have bpr_other: its rules are not known, so there is nothing to save.
    let (status, _, html) = pilot.send(opened("/catalog/blueprints/bpr_other/field-rules")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("rules could not be read") && !html.contains(r#"name="field_id""#), "{html}");
    let (status, _, html) = pilot.send(get("/catalog/blueprints/bpr_other/dimension-rules", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.starts_with("<!DOCTYPE html>") && html.contains("rules could not be read"), "{html}");

    // Without a component id there is no command to send.
    let (status, _, html) = pilot.send(post("/catalog/blueprints/bpr_seed/components", "component_id=+", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a value."), "{html}");
    // A refused Detach is its row's message; activate is not a blueprint's.
    let (status, _, html) = pilot.send(post("/catalog/blueprints/bpr_seed/components/cmp_gone/detach", "", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The component is not attached to this blueprint."), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bpr_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 1, "only the Detach was sent");

    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/blueprints/bulk?has_components=false", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Publish Preview"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/blueprints/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "hasComponents": "false" } } })
    );
}
#[tokio::test]
async fn display_templates_are_listed_created_and_revised_and_a_refused_publish_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/display-templates?target_kind=blueprint", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/display-templates?targetKind=blueprint&limit=50&offset=0");
    assert!(html.contains("<td>Blueprint: bpr_seed</td>") && html.contains("<td>{field.card-name}</td>"), "{html}");
    assert!(html.contains(r#"href="/catalog/display-templates/dtp_seed">View</a>"#), "{html}");
    // The create dialog opens on a blueprint target at priority 10, as admin-web's does.
    assert!(html.contains(r#"<option value="blueprint" selected>Blueprint</option>"#), "{html}");
    assert!(html.contains(r#"name="priority" value="10""#), "{html}");

    // A priority that is not a whole number is the pilot's own check: nothing is sent.
    let (status, _, html) = pilot
        .send(post(
            "/catalog/display-templates",
            "display_template_id=dtp_01JZ&key=k&name=N&target_kind=global&priority=ten",
            true,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a number."), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let posts = [
        (
            "/catalog/display-templates",
            "display_template_id=dtp_01JZ&key=k&name=N&description=&target_kind=global&target_id=ignored&priority=5&title_template=%7Bitem.title%7D&subtitle_template=+",
        ),
        (
            "/catalog/display-templates/dtp_seed/edit",
            "key=card-title&name=Card+title&description=&target_kind=category&target_id=+ctg_seed+&priority=&title_template=%7Bfield.card-name%7D&subtitle_template=%7Bfield.card-number%7D",
        ),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers.contains_key("corten-location"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/display-templates"));
    assert_eq!(body(0)["displayTemplateId"], "dtp_01JZ");
    assert_eq!(body(0)["target"], json!({ "kind": "global" }), "a global target sends no id");
    assert_eq!((body(0)["priority"].clone(), body(0)["subtitleTemplate"].clone()), (json!(5), Value::Null));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/display-templates/dtp_seed"));
    assert_eq!(body(1)["target"], json!({ "kind": "category", "id": "ctg_seed" }));
    assert_eq!((body(1)["priority"].clone(), body(1)["subtitleTemplate"].clone()), (json!(0), json!("{field.card-number}")));
    assert!(body(1).get("displayTemplateId").is_none());

    let (_, _, html) = pilot.send(get("/catalog/display-templates/dtp_seed", Some("staff"))).await;
    assert!(html.contains("<dd>card-name</dd>") && html.contains("<dd>Blueprint: bpr_seed</dd>"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/display-templates/dtp_seed/lifecycle", "action=publish&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("references an unknown or inactive field"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/display-templates/dtp_seed/lifecycle", "action=activate&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert_eq!(pilot.catalog_writes().len(), 3, "the create, the edit and the refused publish");
}
#[tokio::test]
async fn reference_types_are_listed_created_revised_and_bulk_published_and_a_refused_archive_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/reference-types?attribute_key=series", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pilot.catalog_calls()[0].path, "/api/catalog/reference-types?attributeKey=series&limit=50&offset=0");
    assert!(html.contains("<td>set</td>") && html.contains("<td>2</td>"), "{html}");
    assert!(html.contains(r#"href="/catalog/reference-types/rft_seed">View</a>"#), "{html}");

    let posts = [
        (
            "/catalog/reference-types",
            "reference_type_id=rft_01JZ&key=set&name=Set&description=&attribute_keys=release-date%2C+series%0D%0A%0D%0Aprinted",
        ),
        ("/catalog/reference-types/rft_seed/edit", "key=set&name=Card+set&description=Printed+sets&attribute_keys="),
    ];
    for (uri, body) in posts {
        let (status, headers, _) = pilot.send(post(uri, body, true)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        assert!(headers.contains_key("corten-location"), "{uri}");
    }
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/reference-types"));
    assert_eq!(body(0)["referenceTypeId"], "rft_01JZ");
    assert_eq!(body(0)["attributeKeys"], json!(["release-date", "series", "printed"]), "split on commas and lines");
    assert_eq!(body(0)["name"], json!({ "defaultLocale": "en", "values": { "en": "Set" } }));
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/reference-types/rft_seed"));
    assert_eq!(body(1)["attributeKeys"], json!([]));
    assert!(body(1).get("referenceTypeId").is_none());

    let (_, _, html) = pilot.send(get("/catalog/reference-types/rft_seed", Some("staff"))).await;
    assert!(html.contains("<dd>release-date, series</dd>"), "{html}");
    let (status, _, html) =
        pilot.send(post("/catalog/reference-types/rft_seed/lifecycle", "action=archive&status=draft", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Only a deprecated reference type can be archived."), "{html}");

    let (status, _, _) = pilot.send(post("/catalog/reference-types/bulk?status=draft", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    let sent = pilot.catalog_writes().remove(3);
    assert_eq!(sent.path, "/api/catalog/reference-types/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "status": "draft" } } })
    );
}
#[tokio::test]
async fn reference_records_are_created_and_revised_with_attributes_and_relationship_rows() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/reference-records?type_key=product-line&relationship_type=published-by", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    let calls = pilot.catalog_calls();
    assert!(
        calls
            .iter()
            .any(|c| c.path
                == "/api/catalog/reference-records?typeKey=product-line&relationshipType=published-by&limit=50&offset=0"),
        "{:?}",
        calls.iter().map(|c| &c.path).collect::<Vec<_>>()
    );
    assert!(html.contains("<td>product-line</td>") && html.contains("<td>Pokemon TCG</td>"), "{html}");
    assert!(html.contains(r#"href="/catalog/reference-records/ref_seed">View</a>"#), "{html}");
    // The list does not read the records a form picks from; opening the create dialog does,
    // and it keeps the list's filters.
    assert!(!calls.iter().any(|c| c.path == "/api/catalog/reference-records?limit=500"));
    assert!(html.contains(r#"<input type="hidden" name="type_key" value="product-line">"#), "{html}");
    let (status, _, html) = pilot.send(get("/catalog/reference-records/new?type_key=product-line", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<option value="ref_tpci">TPCi (publisher: tpci)</option>"#), "{html}");
    assert!(html.contains(r#"action="/catalog/reference-records?type_key=product-line""#), "{html}");

    // Add Relationship draws a row more and writes nothing.
    let create = "/catalog/reference-records";
    let base = "reference_record_id=ref_01JZ&type_key=publisher&key=wotc&name=WotC&description=";
    let (status, _, html) =
        pilot.send(post(create, &format!("{base}&attributes=&relationship_type=&reference_id=&rerow=add"), true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(html.matches(r#"name="relationship_type""#).count(), 2, "{html}");
    // A row with only one of its values is refused here; nothing is sent.
    let (status, _, html) =
        pilot.send(post(create, &format!("{base}&attributes=&relationship_type=publishes&reference_id="), true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter both the relationship and the reference record, or neither."), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let attributes = "short-name%3A+MTG%0D%0Asets%3A+12%0D%0Aratio%3A+1.5%0D%0Aprinted%3A+true%0D%0Aurl%3A+https%3A%2F%2Fx";
    let rows = "relationship_type=publishes&reference_id=ref_tpci&relationship_type=&reference_id=&relationship_type=publishes&reference_id=ref_tpci";
    let (status, headers, _) = pilot.send(post(create, &format!("{base}&attributes={attributes}&{rows}"), true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers.contains_key("corten-location"));
    let edit = "type_key=product-line&key=pokemon&name=Pokemon+TCG&description=&attributes=%7B%22sets%22%3A+13%7D&relationship_type=published-by&reference_id=ref_tpci";
    let (status, _, _) = pilot.send(post("/catalog/reference-records/ref_seed/edit", edit, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let sent = pilot.catalog_writes();
    let body = |i: usize| serde_json::from_str::<Value>(&sent[i].body).unwrap();
    assert_eq!((&sent[0].method, sent[0].path.as_str()), (&Method::POST, "/api/catalog/reference-records"));
    assert_eq!(body(0)["referenceRecordId"], "ref_01JZ");
    assert_eq!(
        body(0)["attributes"],
        json!({ "short-name": "MTG", "sets": 12, "ratio": 1.5, "printed": true, "url": "https://x" }),
        "key: value lines, each a scalar"
    );
    assert_eq!(
        body(0)["relationships"],
        json!([{ "relationshipType": "publishes", "referenceId": "ref_tpci" }]),
        "the empty row left out, the repeat sent once"
    );
    assert_eq!((&sent[1].method, sent[1].path.as_str()), (&Method::PUT, "/api/catalog/reference-records/ref_seed"));
    assert_eq!(body(1)["attributes"], json!({ "sets": 13 }), "a JSON object is taken as it is");
    assert!(body(1).get("referenceRecordId").is_none());

    // The page shows the attributes and relationships; Edit is drawn on a GET, filled from the
    // record, its relationship picked and the record itself not offered.
    let (_, _, html) = pilot.send(get("/catalog/reference-records/ref_seed", Some("staff"))).await;
    // By key name: the pilot's JSON objects keep no order (admin-web lists the API's).
    assert!(html.contains("<dd>sets: 12, short-name: PTCG</dd>"), "{html}");
    assert!(html.contains(r#"<a href="/catalog/reference-records/ref_tpci">ref_tpci</a>"#), "{html}");
    let (status, _, html) = pilot.send(get("/catalog/reference-records/ref_seed/edit", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<option value="ref_tpci" selected>TPCi (publisher: tpci)</option>"#), "{html}");
    assert!(!html.contains(r#"<option value="ref_seed""#), "{html}");
    assert!(html.contains("&quot;sets&quot;: 12"), "{html}");

    let (status, _, _) =
        pilot.send(post("/catalog/reference-records/bulk?status=draft", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    let sent = pilot.catalog_writes().remove(2);
    assert_eq!(sent.path, "/api/catalog/reference-records/bulk-lifecycle/preview");
}
#[tokio::test]
async fn a_category_bulk_change_publishes_by_the_lists_filters_and_refuses_activate() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/categories/bulk?hierarchy=root&search=gen", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Bulk Publish Preview"), "{html}");
    assert!(html.contains(r#"action="/catalog/categories/bulk/confirm?search=gen&amp;hierarchy=root""#), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/categories/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "search": "gen", "hierarchy": "root" } } })
    );

    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/categories/bulk", "action=activate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let (status, headers, _) =
        pilot.send(post("/catalog/categories/bulk/confirm?hierarchy=root", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().contains("job=job_1"), "{headers:?}");
}

#[tokio::test]
async fn a_list_draws_its_rows_on_open_and_again_on_each_change_resuming_after_a_drop() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/dimensions?status=active&page=2", Some("staff"))).await;
    assert!(
        html.contains(r#"<corten-live src="/catalog/dimensions/live?status=active&amp;page=2"><div data-scope="bulk-rows" id="catalog-rows""#),
        "the rows are live, with the list's filters and page: {html}"
    );
    let before = pilot.catalog_calls().len();

    // On open, on the change, and on the change the stream sends again after it reconnects.
    let events = pilot.events("/catalog/dimensions/live?status=active&page=2", "staff", 3).await;
    assert_eq!(events.len(), 3, "{events:?}");
    for (event, data) in &events {
        assert_eq!(event, "patch");
        assert!(
            data.starts_with(r#"<div data-scope="bulk-rows" id="catalog-rows""#) && data.contains("/catalog/dimensions/dim_seed"),
            "{data}"
        );
        assert!(
            data.contains("Page 2 of 3") && !data.contains(r#"role="search""#),
            "the rows, pager and bulk bar, not the filters: {data}"
        );
        assert!(data.contains("120 matching Dimensions"), "the bar's count is drawn with the rows: {data}");
    }
    let reads: Vec<_> = pilot.catalog_calls()[before..].iter().map(|c| c.path.clone()).collect();
    assert_eq!(reads, vec!["/api/catalog/dimensions?status=active&limit=50&offset=50"; 3], "the same list each time");

    let streams = pilot.calls_to("/api/realtime/");
    assert_eq!(streams[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions");
    assert_eq!(streams[0].headers[header::COOKIE], "chase_sets_session=staff", "as the signed-in user");
    assert_eq!(streams[1].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions&cursor=c2", "it resumes");
}

#[tokio::test]
async fn each_drawing_of_a_live_list_carries_the_streams_cursor_and_a_reconnect_resumes_from_it() {
    let pilot = Pilot::new().await;
    // A first connection: drawn once the stream is open (at its heartbeat, c1), then on the change.
    let first = pilot.events_with_ids(get("/catalog/dimensions/live", Some("staff")), 2).await;
    let ids: Vec<_> = first.iter().map(|(_, id, _)| id.as_str()).collect();
    assert_eq!(ids, ["c1", "c2"], "{first:?}");

    // The browser reconnects with the last cursor it got: nothing is drawn until a change.
    let before = (pilot.catalog_calls().len(), pilot.calls_to("/api/realtime/").len());
    let mut req = get("/catalog/dimensions/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "c2".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 1).await;
    assert_eq!(resumed.len(), 1);
    assert_eq!((resumed[0].0.as_str(), resumed[0].1.as_str()), ("patch", "c2"), "the change, not the open: {resumed:?}");
    assert_eq!(pilot.catalog_calls().len() - before.0, 1, "one read, for the change");
    let streams = &pilot.calls_to("/api/realtime/")[before.1..];
    assert_eq!(
        streams[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Adimensions&cursor=c2",
        "from the browser's cursor"
    );
}

#[tokio::test]
async fn a_live_list_ends_when_the_api_refuses_its_stream() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/catalog/fields/live", "catalog-reader", 3).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["end"], "the page's rows stay, and the element stops: {events:?}");
}

// Bulk changes.

#[tokio::test]
async fn staff_who_may_change_the_records_get_the_bulk_bar_and_a_box_on_each_row() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/dimensions?status=active", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<form data-ref="form" id="catalog-bulk" class="bulk-rows__bar" method="post" action="/catalog/dimensions/bulk?status=active" data-patch"#), "{html}");
    assert!(html.contains(r#"name="ids" value="dim_seed" form="catalog-bulk" aria-label="Select row dim_seed""#), "{html}");
    assert!(
        html.contains(r#"name="all" form="catalog-bulk" aria-label="Select all rows" hidden"#),
        "select-all needs the script: {html}"
    );
    assert!(
        html.contains(
            r#"connect:bulk_rows.drawn({form:@form,count:@count,preview:@preview,clear:@clear},{matching:&quot;120 matching Dimensions&quot;,entity:&quot;Dimensions&quot;,selected:%[&quot;&quot;,&quot;count&quot;,&quot; &quot;,&quot;entityName&quot;,&quot; selected&quot;]})"#
        ),
        "the count's text is the catalog's message, sent unfilled: {html}"
    );
    assert!(html.contains(r#"name="mode" value="ids">Preview</button>"#) && html.contains(r#"type="reset""#), "{html}");
    assert!(html.contains(r#"<dialog id="catalog-bulk-preview"></dialog>"#), "the preview's place: {html}");

    // catalog.view only: the rows, without the bar or the boxes (its posts need catalog.manage).
    let (status, _, html) = pilot.send(get("/catalog/dimensions", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<div id="catalog-rows">"#) && !html.contains("catalog-bulk\""), "{html}");
    assert!(!html.contains(r#"name="ids""#), "{html}");
    let (status, _, _) =
        pilot.send(post_as("catalog-reader", "/catalog/dimensions/bulk", "action=deprecate&mode=filter", true)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, rows) = pilot.events("/catalog/fields/live", "catalog-viewer", 1).await.remove(0);
    assert!(rows.starts_with(r#"<div id="catalog-rows">"#) && !rows.contains("catalog-bulk"), "{rows}");
}

#[tokio::test]
async fn a_preview_asks_the_api_for_the_checked_rows_or_the_filter_and_answers_with_its_dialog() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot
        .send(post("/catalog/dimensions/bulk?status=active", "action=deprecate&mode=ids&ids=dim_seed&ids=dim_b", true))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.starts_with(r#"<dialog class="dialog__dialog" id="catalog-bulk-preview""#) && html.contains(" open "), "{html}");
    assert!(html.contains("Bulk Deprecate Preview") && html.contains("1 ready, 1 blocked."), "{html}");
    assert!(html.contains("Label dim_b") && html.contains("Only an active dimension can be deprecated."), "{html}");
    assert!(html.contains(r#"action="/catalog/dimensions/bulk/confirm?status=active""#), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="ids" value="dim_b">"#), "the confirm takes the preview's ids: {html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/dimensions/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "deprecate", "selection": { "mode": "ids", "ids": ["dim_seed", "dim_b"] } })
    );

    // Every field the filters match: the list's filters are the selection's query.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(post("/catalog/fields/bulk?search=lang&value_type=string&sortable=true", "action=archive&mode=filter", true))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains(r#"name="ids""#), "a filter is confirmed as a filter: {html}");
    assert!(html.contains(r#"<input type="hidden" name="mode" value="filter">"#), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/fields/bulk-lifecycle/preview");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "archive", "selection": { "mode": "filter", "query": { "search": "lang", "valueType": "string", "sortable": "true" } } })
    );

    // Without JavaScript: the list, with the preview open.
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=deprecate&mode=ids&ids=dim_seed", false)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.starts_with("<!DOCTYPE html>")
            && html.contains(r#"id="catalog-bulk-preview" aria-labelledby="catalog-bulk-preview-title" open"#),
        "{html}"
    );
    assert!(html.contains("/catalog/dimensions/dim_seed"), "the list behind it: {html}");
}

#[tokio::test]
async fn a_preview_of_nothing_or_of_an_action_not_offered_is_refused_without_asking_the_api() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=deprecate&mode=ids", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"<p class="form-error" role="alert">Select at least one row to preview.</p>"#), "{html}");
    assert!(html.contains("disabled") && !html.contains("ready,"), "nothing to confirm: {html}");
    let (status, _, html) = pilot.send(post("/catalog/dimensions/bulk", "action=delete&mode=filter", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("This action is not available here."), "{html}");
    assert!(pilot.catalog_writes().is_empty());
}

#[tokio::test]
async fn a_confirm_starts_the_job_and_the_list_follows_it() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post("/catalog/dimensions/bulk/confirm?status=active", "action=deprecate&mode=ids&ids=dim_seed&ids=dim_b", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["corten-location"], "/catalog/dimensions?status=active&job=job_1");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/dimensions/bulk-lifecycle/confirm");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "action": "deprecate", "selection": { "mode": "ids", "ids": ["dim_seed", "dim_b"] } })
    );

    let (status, _, html) = pilot.send(get("/catalog/dimensions?status=active&job=job_1", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"id="catalog-bulk-job" aria-labelledby="catalog-bulk-job-title" open"#), "{html}");
    assert!(html.contains("Bulk Deprecate Result"), "{html}");
    assert!(html.contains(r#"<corten-live src="/catalog/jobs/job_1/live"><div id="catalog-bulk-status">"#), "{html}");
    assert!(html.contains("1 of 2 processed.") && html.contains("Current: Label dim_seed"), "{html}");
    assert!(
        html.contains(r#"href="/catalog/dimensions?status=active&amp;page=2" rel="next""#),
        "the pages leave the job: {html}"
    );

    let mut req = get("/catalog/dimensions?job=job_1", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["job"]["jobId"], "job_1", "data clients get the job: {body}");

    // Without JavaScript the same confirm is a redirect.
    let (status, headers, _) = pilot.send(post("/catalog/dimensions/bulk/confirm", "action=deprecate&mode=filter", false)).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, "/catalog/dimensions?job=job_1"));
}

#[tokio::test]
async fn a_refused_confirm_is_the_preview_again_with_the_apis_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/dimensions/bulk/confirm", "action=archive&mode=ids&ids=dim_seed", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<dialog class="dialog__dialog" id="catalog-bulk-preview""#), "{html}");
    assert!(html.contains(r#"<p class="form-error" role="alert">Another bulk change is running.</p>"#), "{html}");
    assert!(html.contains("1 ready, 1 blocked."), "the preview is drawn again: {html}");
    let paths: Vec<_> = pilot.catalog_writes().iter().map(|c| c.path.clone()).collect();
    assert_eq!(paths, ["/api/catalog/dimensions/bulk-lifecycle/confirm", "/api/catalog/dimensions/bulk-lifecycle/preview"]);
}

#[tokio::test]
async fn a_jobs_status_is_streamed_until_it_is_done_resuming_after_a_drop() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/catalog/jobs/job_1/live", "staff", 3).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["patch", "patch", "end"], "{events:?}");
    assert!(
        events[0].1.starts_with(r#"<div id="catalog-bulk-status">"#) && events[0].1.contains("1 of 2 processed."),
        "{events:?}"
    );
    assert!(events[1].1.contains("1 succeeded, 1 skipped, 0 failed.") && events[1].1.contains("Label dim_b"), "{events:?}");
    let streams = pilot.calls_to("/api/catalog/bulk-authoring-jobs/job_1/events");
    assert_eq!(streams.len(), 2, "{streams:?}");
    assert!(!streams[0].headers.contains_key("last-event-id"));
    assert_eq!(streams[1].headers["last-event-id"], "1", "it resumes from the last event");
    assert_eq!(streams[1].headers[header::COOKIE], "chase_sets_session=staff", "as the signed-in user");
}

#[tokio::test]
async fn a_job_dialog_that_reconnects_gets_only_the_changes_after_the_status_it_shows() {
    let pilot = Pilot::new().await;
    let first = pilot.events_with_ids(get("/catalog/jobs/job_1/live", Some("staff")), 1).await;
    assert_eq!(first[0].1, "1", "each status carries its event's id: {first:?}");

    let mut req = get("/catalog/jobs/job_1/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "1".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 2).await;
    let kinds: Vec<_> = resumed.iter().map(|(event, id, _)| (event.as_str(), id.as_str())).collect();
    assert_eq!(kinds, [("patch", "2"), ("end", "")], "{resumed:?}");
    assert!(resumed[0].2.contains("1 succeeded, 1 skipped, 0 failed."), "{resumed:?}");
    let streams = pilot.calls_to("/api/catalog/bulk-authoring-jobs/job_1/events");
    assert_eq!(streams.last().unwrap().headers["last-event-id"], "1", "the job's stream, from there");
}

#[tokio::test]
async fn a_done_job_shows_what_it_did_and_an_unknown_one_says_so() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/dimensions?job=job_done", Some("staff"))).await;
    assert!(
        html.contains("1 succeeded, 1 skipped, 0 failed.") && !html.contains("/catalog/jobs/"),
        "no stream once done: {html}"
    );
    let (_, _, html) = pilot.send(get("/catalog/dimensions?job=job_missing", Some("staff"))).await;
    assert!(html.contains("This bulk change is not known."), "{html}");
    let events = pilot.events("/catalog/jobs/job_missing/live", "staff", 2).await;
    assert!(events[0].1.contains("This bulk change is not known.") && events[1].0 == "end", "{events:?}");
}

// The catalog items list.

fn sent_json(call: &Call) -> Value {
    serde_json::from_str(&call.body).unwrap()
}

#[tokio::test]
async fn the_items_list_asks_the_api_with_admin_webs_filters_and_draws_its_columns() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(get(
            "/catalog/catalog-items?status=draft&language=ja&blueprint_state=missing&has_images=false&page=2",
            Some("staff"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let read = pilot.catalog_calls().remove(0);
    assert_eq!(
        read.path, "/api/catalog/items?status=draft&language=ja&blueprintState=missing&hasImages=false&limit=50&offset=50",
        "the API's query names"
    );
    assert!(html.contains("<title>Catalog Items | Catalog Admin</title>"), "{html}");
    assert!(html.contains("75 matching Catalog Items") && html.contains("Page 2 of 2"), "{html}");
    assert!(
        html.contains("<td>Title cat_a</td>") && html.contains("<td>Japanese</td>") && html.contains("<td>Card</td>"),
        "{html}"
    );
    assert!(html.contains("<td>tcgplayer, pokemon</td>"), "the sources: {html}");
    assert!(html.contains(r#"href="/catalog/catalog-items/cat_a""#), "the item's page is the pilot's: {html}");
    assert!(html.contains(r#"<details class="list-page__more" open>"#), "a folded filter that is set opens them: {html}");
    assert!(html.contains(r#"value="missing" selected"#), "{html}");
    assert!(html.contains(r#"data-status="draft""#), "a draft's box says so: {html}");
    assert!(html.contains(r#"formaction="/catalog/catalog-items/drafts?status=draft&amp;language=ja&amp;blueprint_state=missing&amp;has_images=false&amp;page=2" data-requires="draft""#), "{html}");
    assert!(html.contains(r#"<option value="mergeTags">Merge Tags</option>"#) && html.contains(r#"name="tags""#), "{html}");
    assert!(
        html.contains(r#"<corten-live data-scope="live-status" id="catalog-live" src="/catalog/catalog-items/live?status=draft&amp;language=ja&amp;blueprint_state=missing&amp;has_images=false&amp;page=2" data-on="#),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/catalog-items""#), "the nav serves the list: {html}");

    let (status, _, html) = pilot.send(get("/catalog/catalog-items", Some("catalog-reader"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("catalog-bulk\"") && !html.contains("New Catalog Item"), "no writes for catalog.view: {html}");
    assert!(!html.contains("<details class=\"list-page__more\" open>"), "{html}");
}

#[tokio::test]
async fn an_item_is_created_with_its_drawn_id_as_its_english_title() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/catalog-items", Some("staff"))).await;
    assert!(html.contains(r#"name="item_id" value="cat_"#) && html.contains(r#"name="language_code" value="en""#), "{html}");
    let (status, headers, _) = pilot
        .send(post("/catalog/catalog-items?status=draft", "item_id=cat_new&language_code=ja&description=Booster%20box", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(to.starts_with("/catalog/catalog-items?status=draft&after_write=") && to.ends_with("&done=created"), "{to}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items");
    assert_eq!(
        sent_json(&sent),
        json!({ "itemId": "cat_new", "languageCode": "ja", "title": { "defaultLocale": "en", "values": { "en": "cat_new" } },
                "subtitle": null, "description": { "defaultLocale": "en", "values": { "en": "Booster box" } } })
    );
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?done=created", Some("staff"))).await;
    assert!(html.contains("Catalog item created"), "{html}");
}

#[tokio::test]
async fn each_bulk_operation_previews_through_its_own_api_route() {
    let pilot = Pilot::new().await;
    // A publish of the matching items: the filters are the selection.
    let (status, _, html) =
        pilot.send(post("/catalog/catalog-items/bulk?status=draft&tag=foil", "action=publish&mode=filter", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Bulk Publish Preview") && html.contains("Matching drafts: 1 ready, 1 need attention."), "{html}");
    assert!(html.contains("Display identity is not resolved yet."), "{html}");
    assert!(html.contains(r#"action="/catalog/catalog-items/bulk/confirm?status=draft&amp;tag=foil""#), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="mode" value="ids"><input type="hidden" name="ids" value="cat_a"><input type="hidden" name="ids" value="cat_b">"#),
        "the confirm takes the preview's items: {html}"
    );
    assert!(html.contains(">Publish or recheck items</button>") && !html.contains("disabled"), "{html}");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-publish/preview");
    assert_eq!(
        sent_json(&sent),
        json!({ "action": "publish", "selection": { "mode": "filter", "query": { "status": "draft", "tag": "foil" } } })
    );

    // An edit of the checked rows, its tags as admin-web reads them.
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot
        .send(post("/catalog/catalog-items/bulk", "action=mergeTags&mode=ids&ids=cat_a&tags=foil%2C%20featured%2C%20foil", true))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Bulk Merge Tags Preview") && html.contains("1 ready, 0 need attention."), "{html}");
    assert!(html.contains("<td>ctg_1</td>") && html.contains(">Apply Edit</button>"), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="tags" value="foil, featured, foil">"#),
        "the confirm carries the operation: {html}"
    );
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-edit/preview");
    assert_eq!(
        sent_json(&sent),
        json!({ "operation": { "action": "mergeTags", "tags": ["featured", "foil"] }, "selection": { "mode": "ids", "ids": ["cat_a"] } })
    );

    // An archive: the lifecycle change, labelled as the item page labels it.
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(post("/catalog/catalog-items/bulk", "action=archive&mode=ids&ids=cat_a", true)).await;
    assert!(html.contains("Bulk Archive Preview") && html.contains("1 ready, 1 blocked."), "{html}");
    assert_eq!(pilot.catalog_writes().remove(0).path, "/api/catalog/items/bulk-lifecycle/preview");

    // An edit without the value it takes is the field's message, and the API is not asked.
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/catalog-items/bulk", "action=assignBlueprint&mode=filter&blueprint_id=%20", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Enter a value.") && html.contains("disabled"), "{html}");
    assert!(pilot.catalog_writes().is_empty());
}

#[tokio::test]
async fn a_confirm_starts_the_operations_job_and_the_dialog_shows_its_outcome() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post("/catalog/catalog-items/bulk/confirm?status=draft", "action=publish&mode=ids&ids=cat_a&ids=cat_b", true))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?status=draft&job=job_publish");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(
        (sent.path.as_str(), sent_json(&sent)),
        ("/api/catalog/items/bulk-publish/confirm", json!({ "itemIds": ["cat_a", "cat_b"] }))
    );

    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_publish", Some("staff"))).await;
    assert!(html.contains("Bulk Publish Result") && html.contains("1 published, 1 failed, 0 skipped."), "{html}");
    assert!(!html.contains("/catalog/jobs/job_publish/live"), "done: no stream: {html}");
    assert!(
        html.contains(r#"<input type="hidden" name="action" value="publish"><input type="hidden" name="mode" value="ids"><input type="hidden" name="ids" value="cat_b">"#)
            && html.contains("Retry items needing attention"),
        "the items to retry are previewed again: {html}"
    );

    let pilot = Pilot::new().await;
    let (_, headers, _) =
        pilot.send(post("/catalog/catalog-items/bulk/confirm", "action=mergeTags&mode=filter&tags=foil", true)).await;
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?job=job_edit");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent.path, "/api/catalog/items/bulk-edit/confirm");
    assert_eq!(
        sent_json(&sent),
        json!({ "operation": { "action": "mergeTags", "tags": ["foil"] }, "selection": { "mode": "filter", "query": {} } })
    );
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_edit", Some("staff"))).await;
    assert!(
        html.contains("Bulk Merge Tags Result")
            && html.contains("1 updated, 0 skipped, 0 failed.")
            && html.contains("<td>featured, foil</td>"),
        "{html}"
    );

    let pilot = Pilot::new().await;
    let (_, headers, _) =
        pilot.send(post("/catalog/catalog-items/bulk/confirm", "action=archive&mode=ids&ids=cat_b", true)).await;
    assert_eq!(headers["corten-location"], "/catalog/catalog-items?job=job_1");
    let sent = pilot.catalog_writes().remove(0);
    assert_eq!(sent_json(&sent), json!({ "action": "archive", "selection": { "mode": "ids", "ids": ["cat_b"] } }));
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?job=job_1", Some("staff"))).await;
    // The stand-in's running job is a dimensions' deprecate: labelled by its own kind.
    assert!(html.contains("Bulk Deprecate Result") && html.contains(r#"<corten-live src="/catalog/jobs/job_1/live">"#), "{html}");
}

#[tokio::test]
async fn checked_drafts_are_removed_one_by_one_and_only_drafts() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(post("/catalog/catalog-items/drafts?status=draft", "mode=ids&ids=cat_a", true)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("Remove Draft Catalog Items") && html.contains("Remove 1 draft Catalog Items from the grid."),
        "{html}"
    );
    assert!(html.contains(r#"action="/catalog/catalog-items/drafts/confirm?status=draft""#), "{html}");

    let (status, _, html) = pilot.send(post("/catalog/catalog-items/drafts", "mode=ids&ids=cat_a&ids=cat_b", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Check only draft Catalog Items to remove them.") && html.contains("disabled"), "{html}");
    assert!(pilot.catalog_writes().is_empty());

    let (status, headers, _) = pilot.send(post("/catalog/catalog-items/drafts/confirm?status=draft", "ids=cat_a", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap();
    assert!(
        to.starts_with("/catalog/catalog-items?status=draft&after_write=") && to.ends_with("&done=drafts_removed&removed=1"),
        "{to}"
    );
    let removed: Vec<_> = pilot.catalog_writes().iter().map(|c| (c.method.clone(), c.path.clone())).collect();
    assert_eq!(removed, [(Method::DELETE, "/api/catalog/items/cat_a".to_owned())]);
    let (_, _, html) = pilot.send(get("/catalog/catalog-items?done=drafts_removed&removed=1", Some("staff"))).await;
    assert!(html.contains("1 draft Catalog Items removed"), "{html}");
}

#[tokio::test]
async fn the_items_page_counts_changes_and_a_reload_draws_the_rows_and_a_new_stream() {
    let pilot = Pilot::new().await;
    let events = pilot.events_with_ids(get("/catalog/catalog-items/live?status=draft", Some("staff")), 2).await;
    assert_eq!(events.len(), 2, "{events:?}");
    let (event, id, data) = &events[0];
    assert_eq!((event.as_str(), id.as_str()), ("patch", "2.0.c2"), "the count rides on the cursor: {events:?}");
    assert!(data.starts_with(r#"<div id="catalog-changes""#) && data.contains("2 Catalog Items changed"), "{data}");
    assert!(data.contains(r#"<input type="hidden" name="status" value="draft">"#) && data.contains(">Reload</button>"), "{data}");
    assert_eq!(events[1].1, "2.0.c2", "the same records again after a reconnect: still two");
    assert_eq!(pilot.calls_to("/api/realtime/")[0].path, "/api/realtime/public/events?topic=catalog%3Aadmin%3Acatalog-items");
    assert!(pilot.catalog_calls().is_empty(), "a change is counted, not read");

    // The browser reconnects with the count it shows: it goes on from there.
    let mut req = get("/catalog/catalog-items/live", Some("staff"));
    req.headers_mut().insert("last-event-id", "5.0.c2".parse().unwrap());
    let resumed = pilot.events_with_ids(req, 1).await;
    assert!(resumed[0].2.contains("7 Catalog Items changed") && resumed[0].1 == "7.0.c2", "{resumed:?}");
    assert!(pilot.calls_to("/api/realtime/").iter().any(|c| c.path.ends_with("&cursor=c2")), "from its cursor");

    // Reload, with the script: the rows, and a new element to stream from, counting from none.
    let mut req = get("/catalog/catalog-items?status=draft", Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    let (status, headers, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains_key("corten-patch"), "{headers:?}");
    assert!(html.starts_with(r#"<div data-scope="bulk-rows" id="catalog-rows""#), "{html}");
    assert!(
        html.contains(
            r#"<corten-live data-scope="live-status" id="catalog-live" src="/catalog/catalog-items/live?status=draft" data-on="connect:live_status.stale($c,@since,%[&quot;Stale since &quot;,&quot;value&quot;,&quot;&quot;],%{"#
        ),
        "the stream's connection status, in the element that streams: {html}"
    );
    // The stale time is written by the server's date format (`t.js().date_time`), in UTC.
    let live = &html[html.find("<corten-live").unwrap()..];
    let live = &live[..live.find('>').unwrap()];
    assert_eq!(live.matches(r#"&quot;u&quot;:&quot;UTC&quot;"#).count(), 2, "on connect and on each status: {live}");
    assert!(
        html.contains(r#"<input type="hidden" name="status" value="draft"><button type="submit" class="live-status__reload">Reload</button>"#),
        "a stale stream's Reload keeps the filters: {html}"
    );
    assert!(
        html.contains(r#"<div id="catalog-changes" class="item-form__changes" role="status"></div></corten-live>"#),
        "{html}"
    );
    assert!(!html.contains(r#"role="search""#), "not the filters: {html}");
}

#[tokio::test]
async fn the_scopes_list_asks_the_api_and_shows_each_scopes_promotion_and_sync() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/catalog/scopes?search=pal&status=active&product_domain=pokemon&page=2", Some("catalog-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "catalog.view is enough: {html}");
    let calls = pilot.catalog_calls();
    assert!(
        calls
            .iter()
            .any(|c| c.path == "/api/catalog/scope-records?search=pal&status=active&productDomain=pokemon&limit=50&offset=50"),
        "{calls:?}"
    );
    assert!(html.contains("<strong>Paldean Fates</strong>") && html.contains(">PAF</span>"), "{html}");
    assert!(html.contains("<td>pokemon · expansion</td>") && html.contains("2 edition(s): en, ja"), "{html}");
    assert!(html.contains(">Live</span>") && html.contains(">Fresh</span>"), "an active scope, changed lately: {html}");
    assert!(
        html.contains("No editions yet") && html.contains(">Unpublished</span>") && html.contains(">Stale sync</span>"),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/scopes/scp_paf">View</a>"#), "the scope's page is the pilot's: {html}");
    assert!(
        html.contains(r#"href="/catalog/scopes?search=pal&amp;status=active&amp;product_domain=pokemon" rel="prev""#),
        "the pager keeps the filters: {html}"
    );
    assert!(
        html.contains(r#"<option value="pokemon" selected>pokemon</option>"#) && html.contains(r#"<option value="lorcana">"#),
        "{html}"
    );
    assert!(html.contains(r#"href="/catalog/scopes" aria-current="page""#), "the nav's Scopes is the pilot's: {html}");
}

#[tokio::test]
async fn the_scopes_language_filters_the_page_the_api_returned() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/catalog/scopes?language=ja", Some("staff"))).await;
    assert!(
        pilot.catalog_calls().iter().any(|c| c.path == "/api/catalog/scope-records?limit=50&offset=0"),
        "not sent to the API"
    );
    assert!(html.contains("Paldean Fates") && !html.contains("Base Set"), "{html}");
    assert!(
        html.contains(r#"<option value="ja" selected>ja</option>"#) && html.contains(r#"<option value="en">en</option>"#),
        "{html}"
    );
}

#[tokio::test]
async fn a_scopes_list_the_api_cannot_read_is_its_banner_over_no_rows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes?search=broken", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "as admin-web's loader: {html}");
    assert!(html.contains(r#"role="alert""#) && html.contains("The scope list is unavailable."), "{html}");
    assert!(html.contains("No scopes found"), "{html}");
    let mut req = get("/catalog/scopes?search=broken", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["error"], "The scope list is unavailable.", "{body}");
    assert_eq!(body["data"]["items"], json!([]), "{body}");

    let (status, _, _) = pilot.send(get("/catalog/scopes", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed");
}

fn action_get(uri: &str) -> Request<Body> {
    let mut req = get(uri, Some("staff"));
    req.headers_mut().insert("corten", "action".parse().unwrap());
    req
}

#[tokio::test]
async fn the_attention_queue_sits_above_the_scopes_with_its_counts_and_items() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes?status=active", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (queue, list) = (html.find("data-attention-queue").unwrap(), html.find("Paldean Fates").unwrap());
    assert!(queue < list, "the queue is above the list");
    assert!(html.contains(">2 need you</span>") && html.contains("As of 2026-10-25T09:20:07.661Z"), "{html}");
    assert!(
        html.contains("Unblock TCGplayer Magic Single Cards on tcgplayer")
            && html.contains("Blocked by credential · provider-retired"),
        "{html}"
    );
    assert!(html.contains("tcgdex · name · confidence 0.92"), "a keyword argument and a number: {html}");
    assert!(
        html.contains(r#"<form id="attention-open" method="get" action="/catalog/scopes/attention/review" data-patch><input type="hidden" name="status" value="active"></form>"#),
        "one Review form, keeping the filters: {html}"
    );
    assert!(html.contains(&format!(r#"form="attention-open" name="item" value="{HEALTH}">Review health</button>"#)), "{html}");
    assert!(
        html.contains(r#"action="/catalog/scopes/attention/alias/reject?status=active" data-patch><input type="hidden" name="alias_hashes" value="h1"><input type="hidden" name="reason" value="Reject">"#),
        "a reject sends its label as the reason: {html}"
    );
    assert!(html.contains(r#"<dialog id="attention-sheet"></dialog>"#), "the sheet is drawn when opened: {html}");

    let mut req = get("/catalog/scopes", Some("staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["attention"]["items"][0]["kind"], "provider-health", "{body}");
    assert_eq!(body["data"]["attention"]["items"][1]["resolution"]["mode"], "command", "{body}");

    let (_, _, html) = pilot.send(get("/catalog/scopes", Some("catalog-viewer"))).await;
    assert!(
        html.contains(r#"<button type="submit" class="attention-panel__small" disabled>Accept</button>"#),
        "a viewer may not act: {html}"
    );
}

#[tokio::test]
async fn an_items_review_draws_its_sheet_with_its_evidence_and_park_forms() {
    let pilot = Pilot::new().await;
    let key = percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, html) = pilot.send(action_get(&format!("/catalog/scopes/attention/review?status=active&item={key}"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.starts_with(r#"<dialog class="dialog__dialog" id="attention-sheet" aria-labelledby="attention-sheet-title" open"#),
        "{html}"
    );
    assert!(html.contains("<dt>Unit</dt><dd>tcgplayer:mtg:single-card:source-observation-import</dd>"), "{html}");
    assert!(
        html.contains(r#"href="http://localhost:7752/catalog/providers/tcgplayer?unitKey=tcgplayer%3Amtg%3Asingle-card%3Asource-observation-import""#),
        "the destination is admin-web's: {html}"
    );
    assert!(
        html.contains(r#"id="attention-dismiss" method="post" action="/catalog/scopes/attention/dismiss?status=active""#),
        "{html}"
    );
    assert!(html.contains(r#"<input type="hidden" name="kind" value="provider-health">"#), "{html}");
    assert!(!html.contains("Paldean Fates"), "only the sheet: {html}");

    let (_, _, html) = pilot.send(action_get("/catalog/scopes/attention/review?item=gone")).await;
    assert_eq!(html, r#"<dialog id="attention-sheet"></dialog>"#, "an item no longer in the queue");

    let (status, _, html) = pilot.send(get(&format!("/catalog/scopes/attention/review?item={key}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html.contains("Paldean Fates") && html.contains(r#"id="attention-sheet" aria-labelledby="attention-sheet-title" open"#),
        "{html}"
    );
}

#[tokio::test]
async fn parking_an_item_sends_its_reason_and_the_list_offers_restore() {
    let pilot = Pilot::new().await;
    let form = format!(
        "item_key={}&kind=provider-health&reason=Retired+provider",
        percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)
    );
    let (status, headers, _) = pilot.send(post("/catalog/scopes/attention/dismiss?status=active", &form, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/scopes?status=active&after_write="), "{to}");
    assert!(
        to.ends_with(&format!(
            "&done=queued&parked={}",
            percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)
        )) || to.contains("&done=queued&parked=provider-health"),
        "{to}"
    );
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[0].body).unwrap();
    assert_eq!(sent, json!({ "intent": "dismiss", "itemKey": HEALTH, "kind": "provider-health", "reason": "Retired provider" }));

    pilot.send(post("/catalog/scopes/attention/defer", &form, true)).await;
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[1].body).unwrap();
    assert_eq!((sent["intent"].as_str(), sent["deferHours"].as_u64()), (Some("defer"), Some(24)), "{sent}");

    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("Command queued"), "{html}");
    assert!(
        html.contains(&format!(r#"action="/catalog/scopes/attention/restore?status=active" data-patch><input type="hidden" name="item_key" value="{HEALTH}">"#)),
        "{html}"
    );
    pilot
        .send(post(
            "/catalog/scopes/attention/restore",
            &format!("item_key={}", percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC)),
            true,
        ))
        .await;
    let sent: Value = serde_json::from_str(&pilot.catalog_writes()[2].body).unwrap();
    assert_eq!(sent, json!({ "intent": "restore", "itemKey": HEALTH }));
}

#[tokio::test]
async fn a_park_without_a_reason_or_refused_comes_back_in_its_sheet() {
    let pilot = Pilot::new().await;
    let key = percent_encoding::utf8_percent_encode(HEALTH, percent_encoding::NON_ALPHANUMERIC).to_string();
    let (status, _, html) = pilot
        .send(post("/catalog/scopes/attention/dismiss", &format!("item_key={key}&kind=provider-health&reason=+"), true))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.starts_with(r#"<form class="attention-panel__park" id="attention-dismiss""#), "the form alone: {html}");
    assert!(html.contains(r#"id="attention-dismiss-reason-error""#) && html.contains("requires an operator reason"), "{html}");
    assert!(pilot.catalog_writes().is_empty(), "nothing sent");

    let (status, _, html) = pilot
        .send(post("/catalog/scopes/attention/defer", &format!("item_key={key}&kind=provider-health&reason=refuse"), false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        html.contains("Parking an attention item requires its kind.") && html.contains("Paldean Fates"),
        "the page, the sheet open: {html}"
    );
    assert!(html.contains(r#"id="attention-sheet" aria-labelledby="attention-sheet-title" open"#), "{html}");

    let (_, _, html) = pilot.send(post("/catalog/scopes/attention/dismiss", "item_key=x&kind=elsewhere&reason=r", true)).await;
    assert!(html.contains("role=\"alert\""), "a kind the queue does not have: {html}");
}

#[tokio::test]
async fn an_alias_candidates_accept_and_reject_post_the_alias_review() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post("/catalog/scopes/attention/alias/accept", "alias_hashes=h1", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers["corten-location"].to_str().unwrap().contains("done=queued"));
    pilot.send(post("/catalog/scopes/attention/alias/reject", "alias_hashes=h1&reason=Reject", true)).await;
    let writes = pilot.catalog_writes();
    assert_eq!(writes[0].path, "/api/catalog/alias-review/commands");
    let bodies: Vec<Value> = writes.iter().map(|w| serde_json::from_str(&w.body).unwrap()).collect();
    assert_eq!(
        bodies,
        [
            json!({ "intent": "accept", "aliasHashes": "h1" }),
            json!({ "intent": "reject", "aliasHashes": "h1", "reason": "Reject" })
        ]
    );

    let (_, headers, _) = pilot.send(post("/catalog/scopes/attention/alias/reject", "alias_hashes=h1", true)).await;
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert!(to.ends_with("done=failed"), "a reject needs its reason: {to}");
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("Command needs attention"), "{html}");
}

#[tokio::test]
async fn a_queue_the_api_cannot_read_is_its_banner_and_the_list_still_shows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes", Some("queue-down"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Attention queue unavailable") && html.contains("Paldean Fates"), "{html}");
    assert!(!html.contains("data-attention-queue"), "{html}");

    let (status, _, _) =
        pilot.send(get(&format!("/catalog/scopes?after_write={}&done=queued", fresh_receipt()), Some("queue-down"))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "after a park, a queue still catching up is the page's preparing answer");
}

// The Operations Attention queue.

/// The queue as the API answers it: `ops-empty` has nothing, `ops-down` fails, any other a
/// critical, a warning and an info item, with one source unavailable.
fn operations_attention(cookie: &str) -> Response {
    if cookie.contains("chase_sets_session=ops-down") {
        return refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.");
    }
    let sources = |wake: Value| {
        json!([
            { "id": "projection-poison-event", "status": "available", "itemCount": 1, "total": "unknown" },
            wake,
            { "id": "support-request-deadline", "status": "available", "itemCount": 1, "total": 1 },
            { "id": "platform-feedback-unreviewed", "status": "available", "itemCount": 1, "total": 1 },
        ])
    };
    if cookie.contains("chase_sets_session=ops-empty") {
        return Json(json!({
            "items": [],
            "rollup": { "total": 0, "bySeverity": { "critical": 0, "warning": 0, "info": 0 }, "bySource": {} },
            "sources": sources(json!({ "id": "wake-stalled-job", "status": "available", "itemCount": 0, "total": "unknown" })),
            "degraded": false,
        }))
        .into_response();
    }
    Json(json!({
        "items": [
            {
                "id": "projection-poison-event:ordering-orders:evt_1",
                "source": "projection-poison-event",
                "entity": "poison-event",
                "severity": "critical",
                "summary": { "code": "poisonEvent", "params": { "eventType": "OrderPlaced", "projectionKey": "ordering-orders", "retryCount": 3 } },
                "deepLink": { "surface": "projection-operations", "href": "/projections?tab=blocked" },
                "dueAt": null,
                "observedAt": "2026-10-25T09:20:00.000Z",
            },
            {
                "id": "support-request-deadline:req_1",
                "source": "support-request-deadline",
                "entity": "support-request",
                "severity": "warning",
                "summary": { "code": "supportRequest", "params": { "reference": "SR-1042" } },
                "deepLink": { "surface": "support-operations", "href": "/requests?requestId=req_1" },
                "dueAt": "2026-10-26T12:00:00.000Z",
                "observedAt": "2026-10-24 08:00:00+00",
            },
            {
                "id": "platform-feedback-unreviewed:pfb_1",
                "source": "platform-feedback-unreviewed",
                "entity": "platform-feedback",
                "severity": "info",
                "summary": { "code": "somethingNew", "params": {} },
                "deepLink": { "surface": "platform-feedback", "href": "/platform-feedback/pfb_1" },
                "observedAt": "2026-10-23T10:00:00.000Z",
            },
        ],
        "rollup": {
            "total": 3,
            "bySeverity": { "critical": 1, "warning": 1, "info": 1 },
            "bySource": { "projection-poison-event": 1, "support-request-deadline": 1, "platform-feedback-unreviewed": 1 },
        },
        "sources": sources(json!({ "id": "wake-stalled-job", "status": "unavailable", "itemCount": 0, "total": "unknown", "reason": "wake status unavailable" })),
        "degraded": true,
    }))
    .into_response()
}

#[tokio::test]
async fn the_attention_queue_draws_its_counts_its_missing_sources_and_its_items_in_the_apis_order() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/operations-attention", Some("ops"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<title>Attention Queue | Chase Sets Admin</title>") && html.contains("<h1>What needs you</h1>"),
        "{html}"
    );
    for (label, count) in [("Total", 3), ("Critical", 1), ("Warning", 1), ("Info", 1)] {
        assert!(html.contains(&format!("<dt>{label}</dt><dd>{count}</dd>")), "{label}: {html}");
    }
    assert!(
        html.contains("Some sources are unavailable") && html.contains("Wake work unavailable: wake status unavailable"),
        "{html}"
    );
    let rows = [
        "Poison event OrderPlaced on ordering-orders (retried 3)",
        "Support case SR-1042 needs review",
        "platformOperations.operationsAttention.summary.somethingNew",
    ];
    let at: Vec<usize> = rows.iter().map(|row| html.find(row).unwrap_or_else(|| panic!("{row}: {html}"))).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "in the API's order: {at:?}");
    assert!(
        html.contains("Oct 25, 2026, 9:20 AM UTC") && html.contains("Oct 24, 2026, 8:00 AM UTC"),
        "an ISO and a Postgres time: {html}"
    );
    assert!(html.contains("Oct 26, 2026, 12:00 PM UTC") && html.contains("No deadline"), "{html}");
    let origin = crate::app::admin_web_origin();
    assert!(html.contains(&format!(r#"href="{origin}/platform/projections?tab=blocked">Open</a>"#)), "{html}");
    assert!(html.contains(r#"href="/support/requests?requestId=req_1">Open</a>"#), "the pilot serves a request's sheet: {html}");
    assert!(html.contains(r#"href="/support/platform-feedback/pfb_1">Open</a>"#), "the pilot serves a feedback's page: {html}");
    assert!(html.contains(r#"id="attention-live" src="/platform/operations-attention/live""#), "{html}");
    assert!(html.contains(r#"<div id="attention-queue">"#), "{html}");
    assert!(
        html.contains(r#"href="/assets/"#) && html.contains("/sections/platform/operations-attention.css"),
        "the area's own stylesheet: {html}"
    );
    assert!(pilot.calls.lock().unwrap().iter().any(|c| c.path == "/api/platform/operations-attention"
        && c.headers.get(header::COOKIE).is_some_and(|v| v.to_str().unwrap().contains("chase_sets_session=ops"))));

    let mut req = get("/platform/operations-attention", Some("ops"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["queue"]["items"][0]["severity"], "critical", "{body}");
    assert_eq!(body["data"]["queue"]["sources"][1]["reason"], "wake status unavailable", "{body}");
}

#[tokio::test]
async fn the_attention_queue_is_for_staff_who_may_see_projection_operations() {
    let pilot = Pilot::new().await;
    for session in ["catalog-reader", "reader"] {
        let (status, _, _) = pilot.send(get("/platform/operations-attention", Some(session))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{session}");
    }
    let (status, headers, _) = pilot.send(get("/platform/operations-attention", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("/access/sign-in?returnTo=%2Fplatform%2Foperations-attention"));
    assert!(
        !pilot.calls.lock().unwrap().iter().any(|c| c.path == "/api/platform/operations-attention"),
        "refused before the read"
    );
}

#[tokio::test]
async fn an_empty_queue_says_so_and_a_queue_the_api_cannot_read_is_an_error() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/operations-attention", Some("ops-empty"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Nothing needs you") && html.contains("<dt>Total</dt><dd>0</dd>"), "{html}");
    assert!(!html.contains("Some sources are unavailable") && !html.contains("<table"), "{html}");
    let (status, _, _) = pilot.send(get("/platform/operations-attention", Some("ops-down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn the_queue_is_drawn_again_on_a_change_and_stays_when_the_api_refuses_the_topic() {
    let pilot = Pilot::new().await;
    let events = pilot.events("/platform/operations-attention/live", "ops", 2).await;
    assert_eq!(events.len(), 2, "on the stream's opening and its change: {events:?}");
    for (event, data) in &events {
        assert_eq!(event, "patch");
        assert!(
            data.starts_with(r#"<div id="attention-queue">"#) && data.contains("Support case SR-1042 needs review"),
            "{data}"
        );
    }
    let topics: Vec<String> =
        pilot.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/realtime")).map(|c| c.path.clone()).collect();
    assert!(topics.iter().all(|p| p.contains("topic=platform-operations%3Aadmin%3Aoperations-attention")), "{topics:?}");

    let events = pilot.events("/platform/operations-attention/live", "ops-refused", 2).await;
    let kinds: Vec<_> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(kinds, ["end"], "the page's queue stays, and the element stops: {events:?}");
}

#[tokio::test]
async fn a_scopes_page_draws_its_journey_coverage_jobs_and_editions_from_the_catalog_api() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_paf", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let calls: Vec<String> = pilot.catalog_calls().into_iter().map(|c| c.path).collect();
    for path in [
        "/api/catalog/scope-records/scp_paf",
        "/api/catalog/provider-scope-mappings/coverage/scp_paf",
        "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scp_paf",
        "/api/catalog/source-observations/bulk-jobs/active?scopeRecordId=scp_paf&status=completed",
        "/api/catalog/source-observations/merge-candidate-bulk-jobs/failed?scopeRecordId=scp_paf",
        "/api/catalog/alias-review?targetKind=reference-record&targetId=ref_scp_paf",
    ] {
        assert!(calls.iter().any(|c| c == path), "{path} in {calls:?}");
    }
    assert!(html.contains("Paldean Fates") && html.contains(r#"href="/catalog/scopes""#), "{html}");
    // The journey: a pending Japanese alias is a conflict.
    assert!(html.contains(r#"data-status="current""#), "{html}");
    // The coverage: Confirm canonical record (a draft), Accept all available (map_1 only), each row.
    assert!(html.contains(r#"action="/catalog/scopes/scp_paf/publish""#), "{html}");
    assert!(
        html.contains(r#"<input type="hidden" name="mapping_ids" value="map_1"><input type="hidden" name="all" value="1">"#),
        "{html}"
    );
    assert!(html.contains("tcgplayer") && html.contains("pokemontcgio") && html.contains("cardmarket"), "{html}");
    assert!(html.contains(r#"<input type="hidden" name="intent" value="revoke">"#), "the mapped row can be revoked: {html}");
    // The jobs: running, failed with its reason, completed with its Catalog Item once, and the next page.
    assert!(html.contains(r#"data-candidate-review-job-id="job_run""#) && html.contains("The candidate moved."), "{html}");
    assert_eq!(html.matches(r#"data-promoted-catalog-item-id="itm_1""#).count(), 1, "{html}");
    assert!(html.contains(r#"href="/catalog/scopes/scp_paf?jobs=c2" rel="next""#), "{html}");
    // The editions: English canonical, Japanese open with its candidate and its commands.
    assert!(html.contains(r#"data-link="pending-review""#) && html.contains("Confidence is below high."), "{html}");
    assert!(html.contains(r#"data-language-edition-command="alias.defer""#), "{html}");
    assert!(html.contains(r#"href="http://localhost:7752/catalog/scopes/scp_paf""#), "the workspace is admin-web's: {html}");
    assert!(
        pilot.stylesheet(&html, "sections/catalog").await.is_some_and(|css| css.contains(".scope-page__stages")),
        "the page's stylesheet is the area's"
    );

    let (_, _, html) = pilot.send(get("/catalog/scopes/scp_paf?jobs=c2", Some("staff"))).await;
    assert!(pilot.catalog_calls().iter().any(|c| c.path.ends_with("&status=completed&cursor=c2")));
    assert!(
        html.contains(r#"href="/catalog/scopes/scp_paf">"#) && !html.contains(r#"rel="next""#),
        "first page, no next: {html}"
    );
}

#[tokio::test]
async fn a_scope_with_one_edition_reads_no_alias_review_and_a_failed_read_is_its_sections_banner() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_one", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!pilot.catalog_calls().iter().any(|c| c.path.contains("alias-review")), "one edition has nothing to review");
    assert!(!html.contains("scope-editions"), "{html}");

    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_down", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "as admin-web's loader degrades them: {html}");
    assert!(html.matches(r#"role="status""#).count() >= 3, "the journey's and both banners: {html}");
    assert!(!html.contains("Accept all"), "no commands over a coverage that could not be read: {html}");

    let (status, _, _) = pilot.send(get("/catalog/scopes/scp_gone", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = pilot.send(get("/catalog/scopes/scp_paf", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed");
}

#[tokio::test]
async fn a_scopes_coverage_writes_send_the_commands_and_redirect_with_the_toast() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=accept&mapping_ids=map_1&all=1", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/scopes/scp_paf?after_write=") && to.ends_with("&done=available_accepted&count=1"), "{to}");
    pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=revoke&mapping_ids=map_2&reason=Wrong+set", true)).await;
    pilot
        .send(post(
            "/catalog/scopes/scp_paf/coverage/propose",
            "provider_key=tcgplayer&unit_key=sv&set_id=sv4pt5&set_name=&confidence=high&accept=1",
            true,
        ))
        .await;
    pilot.send(post("/catalog/scopes/scp_paf/publish", "", true)).await;
    let writes = pilot.catalog_writes();
    let sent: Vec<(String, Value)> =
        writes.iter().map(|w| (w.path.clone(), serde_json::from_str(&w.body).unwrap_or(Value::Null))).collect();
    assert_eq!(
        sent,
        [
            ("/api/catalog/provider-scope-mappings/commands".to_owned(), json!({ "intent": "accept", "mappingIds": ["map_1"] })),
            (
                "/api/catalog/provider-scope-mappings/commands".to_owned(),
                json!({ "intent": "revoke", "mappingIds": ["map_2"], "reason": "Wrong set" })
            ),
            (
                "/api/catalog/provider-scope-mappings/propose".to_owned(),
                json!({ "scopeRecordId": "scp_paf", "providerKey": "tcgplayer", "unitKey": "sv",
                        "coordinates": { "setId": "sv4pt5", "setName": null }, "confidence": "high", "autoAccept": true })
            ),
            ("/api/catalog/reference-records/scp_paf/publish".to_owned(), Value::Null),
        ]
    );
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("1 mappings accepted."), "the toast says how many: {html}");
}

#[tokio::test]
async fn the_unmapped_scope_inbox_lists_what_waits_and_filters_by_domain() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scope-coverage", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Unmapped Scope Inbox | Catalog Admin"), "{html}");
    assert!(html.contains("1 scope records with 2 pending proposals (1 high-confidence)."), "{html}");
    assert!(
        html.contains("Paldean Fates") && html.contains("New canonical record") && html.contains("2 pending (1 high-confidence)")
    );
    assert!(html.contains(r#"href="/catalog/scope-coverage/scp_paf""#), "Review opens its coverage: {html}");
    assert!(html.contains(r#"data-label="Pending proposals""#), "a row is a card on a phone: {html}");

    let (status, _, html) = pilot.send(get("/catalog/scope-coverage?product_domain=magic", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Nothing pending review") && html.contains(r#"<option value="magic" selected>"#), "{html}");
    let (status, _, _) = pilot.send(get("/catalog/scope-coverage", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.view is needed");
}

#[tokio::test]
async fn a_scopes_coverage_page_writes_through_the_scope_routes_and_comes_back() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scope-coverage/scp_paf", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"href="/catalog/scope-coverage">Unmapped Scope Inbox</a>"#), "the way back: {html}");
    assert!(html.contains(r#"action="/catalog/scopes/scp_paf/coverage?via=coverage""#), "{html}");
    assert!(
        html.contains(r#"action="/catalog/scopes/scp_paf/publish?via=coverage""#),
        "a draft's Confirm canonical record: {html}"
    );

    let (status, headers, _) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage?via=coverage", "intent=accept&mapping_ids=map_1", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/catalog/scope-coverage/scp_paf?after_write=") && to.ends_with("&done=mapping_accepted"), "{to}");
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("Mapping accepted."), "the toast: {html}");

    let (status, _, html) = pilot
        .send(post("/catalog/scopes/scp_paf/coverage?via=coverage", "intent=reject&mapping_ids=map_1&reason=refuse", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The mapping moved meanwhile.") && html.contains("Unmapped Scope Inbox</a>"), "refused, here: {html}");

    let (status, _, html) = pilot.send(get("/catalog/scope-coverage/scp_down", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "a coverage that cannot be read is a banner: {html}");
    assert!(html.contains(r#"role="status""#) && !html.contains("Accept all"), "{html}");
    let (status, _, _) = pilot.send(get("/catalog/scope-coverage/scp_gone", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an unknown scope");
}

#[tokio::test]
async fn a_scope_write_without_its_reason_or_refused_is_the_page_again_with_the_message() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=reject&mapping_ids=map_1&reason=+", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"role="alert""#) && html.contains("Paldean Fates"), "{html}");
    assert!(pilot.catalog_writes().is_empty(), "nothing sent");

    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=reject&mapping_ids=map_1&reason=refuse", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The mapping moved meanwhile."), "the API's refusal: {html}");

    let (status, _, html) =
        pilot.send(post("/catalog/scopes/scp_paf/coverage/propose", "provider_key=tcgplayer&unit_key=", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(r#"value="tcgplayer""#) && html.contains("Enter the provider, the unit"), "the dialog, open: {html}");
    let (status, _, html) = pilot
        .send(post("/catalog/scopes/scp_paf/coverage/propose", "provider_key=refuse&unit_key=u&set_name=Paldean", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("The mapping moved meanwhile.") && html.contains(r#"value="refuse""#), "{html}");

    let (status, _, _) = pilot.send(post("/catalog/scopes/scp_paf/coverage", "intent=forget&mapping_ids=map_1", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "an intent the form does not offer");
}

#[tokio::test]
async fn an_editions_alias_commands_post_the_alias_review_and_defer_writes_nothing() {
    let pilot = Pilot::new().await;
    let (status, headers, _) =
        pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.defer&alias_hashes=ah_ja", true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let to = headers["corten-location"].to_str().unwrap().to_owned();
    assert_eq!(to, "/catalog/scopes/scp_paf?done=alias_deferred");
    assert!(pilot.catalog_writes().is_empty(), "chase-sets/chase-sets#10702: defer has no command");
    let (_, _, html) = pilot.send(get(&to, Some("staff"))).await;
    assert!(html.contains("stays pending"), "{html}");

    pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.accept&alias_hashes=ah_ja", true)).await;
    pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.reject&alias_hashes=ah_ja&reason=Not+this+set", true)).await;
    let (status, _, _) =
        pilot.send(post("/catalog/scopes/scp_paf/aliases", "intent=alias.revoke&alias_hashes=ah_ja", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "a revoke needs its reason");
    let bodies: Vec<Value> = pilot.catalog_writes().iter().map(|w| serde_json::from_str(&w.body).unwrap()).collect();
    assert_eq!(
        bodies,
        [
            json!({ "intent": "accept", "aliasHashes": "ah_ja" }),
            json!({ "intent": "reject", "aliasHashes": "ah_ja", "reason": "Not this set" }),
        ]
    );
}

#[tokio::test]
async fn a_catalog_viewer_sees_a_scope_without_its_commands_and_cannot_write() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/scp_paf", Some("catalog-viewer"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("/catalog/scopes/scp_paf/coverage") && !html.contains("/publish"), "{html}");
    assert!(html.contains(r#"data-language-edition-command="alias.accept""#), "{html}");
    assert!(html.contains(r#"<button type="submit" class="#) && html.contains(" disabled>"), "off, as admin-web's: {html}");
    let (status, _, _) = pilot.send(post_as("catalog-viewer", "/catalog/scopes/scp_paf/publish", "", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.manage is needed");
    assert!(pilot.catalog_writes().is_empty());
}

// Catalog > a Source Observation (/catalog/source-observations/{id}).

#[tokio::test]
async fn a_source_observation_shows_its_values_and_offers_what_its_status_allows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/source-observations/obs_card", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Pikachu | Catalog Admin</title>"), "{html}");
    assert!(
        html.contains("tcgdex-cards@3") && html.contains("Atsuko Nishida") && html.contains("<dd>Base</dd>"),
        "the expansion falls back to the set: {html}"
    );
    assert!(html.contains(r#"src="https://images.example/pikachu.png""#), "{html}");
    assert!(
        html.contains(r#"value="promote""#) && html.contains(r#"value="reject""#) && html.contains(r#"name="reason""#),
        "{html}"
    );
    assert!(html.contains("/catalog/integrations?section=workbench"), "the way back is admin-web's workbench: {html}");

    let (_, _, html) = pilot.send(get("/catalog/source-observations/obs_product", Some("staff"))).await;
    assert!(html.contains(r#"value="promote""#) && !html.contains(r#"value="reject""#), "a changed one is promoted only: {html}");
    assert!(html.contains("sku-1, sku-2") && html.contains("<dd>2</dd>") && !html.contains("Card Number"), "{html}");

    let (_, _, html) = pilot.send(get("/catalog/source-observations/obs_done", Some("staff"))).await;
    assert!(!html.contains(r#"value="promote""#) && html.contains("cat_pika") && html.contains("pokemon-cards@2"), "{html}");

    let (_, _, html) = pilot.send(get("/catalog/source-observations/obs_card", Some("catalog-viewer"))).await;
    assert!(!html.contains(r#"value="promote""#), "a viewer reviews nothing: {html}");
    let (status, _, _) = pilot.send(get("/catalog/source-observations/obs_missing", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = pilot.send(get("/catalog/source-observations/obs_down", Some("staff"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_review_posts_the_api_its_body_and_a_refusal_is_the_forms_message() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post_as("staff", "/catalog/source-observations/obs_card", "action=reject&reason=&status=observed", false))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/catalog/source-observations/obs_card?") && to.contains("done=rejected"), "{to}");
    let (status, _, _) =
        pilot.send(post_as("staff", "/catalog/source-observations/obs_product", "action=promote&status=changed", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let writes = pilot.catalog_writes();
    assert_eq!(writes.len(), 2, "{writes:?}");
    assert_eq!(writes[0].path, "/api/catalog/source-observations/obs_card/reject");
    assert_eq!(serde_json::from_str::<Value>(&writes[0].body).unwrap(), json!({ "reason": "Rejected during review." }));
    assert_eq!(writes[1].path, "/api/catalog/source-observations/obs_product/promote");
    assert_eq!(serde_json::from_str::<Value>(&writes[1].body).unwrap(), json!({ "promoteAsDraft": false }));

    let (_, _, html) = pilot.send(get("/catalog/source-observations/obs_card?done=rejected", Some("staff"))).await;
    assert!(html.contains("Source observation rejected"), "the toast: {html}");

    let (status, _, html) =
        pilot.send(post_as("staff", "/catalog/source-observations/obs_held", "action=promote&status=observed", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        html.contains("Promotion is paused for this provider.") && html.contains("<title>"),
        "the whole page without JavaScript: {html}"
    );
    let (status, _, html) =
        pilot.send(post_as("staff", "/catalog/source-observations/obs_held", "action=promote&status=observed", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        html.contains("Promotion is paused for this provider.")
            && !html.contains("<title>")
            && html.contains(r#"value="reject""#),
        "the form as a patch: {html}"
    );

    let before = pilot.catalog_writes().len();
    let (status, _, _) =
        pilot.send(post_as("catalog-viewer", "/catalog/source-observations/obs_card", "action=promote", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "catalog.manage is needed");
    let (status, _, _) = pilot.send(post_as("staff", "/catalog/source-observations/obs_card", "action=archive", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "an action the form does not offer");
    assert_eq!(pilot.catalog_writes().len(), before);
}

// Projection Operations (/platform/projections).

const GROUP_KEY: &str = "settlement-fulfillment-source-projection:fulfillment:v2";

fn projection_operation(id: &str, kind: &str, state: &str, updated_at: &str) -> Value {
    json!({
        "operationId": id,
        "operationKind": kind,
        "state": state,
        "contextName": "settlement",
        "projectionName": "settlement-fulfillment-source-projection",
        "projectionKey": null,
        "streamId": null,
        "requestedByUserId": "usr_1",
        "claimOwnerId": null,
        "requestedAt": "2026-10-28T10:00:00.000Z",
        "startedAt": null,
        "updatedAt": updated_at,
        "completedAt": null,
        "error": if state == "failed" { json!({ "message": "Rebuild failed." }) } else { Value::Null },
    })
}

/// The console as the API answers it: a degraded group with blocked streams and poison events
/// (sent as counts only, as the API does: chase-sets/chase-sets#10710), a running operation and a
/// failed one, and the API's triage of them.
fn projections_console() -> Value {
    json!({
        "summary": { "status": "degraded", "totalGroups": 2, "caughtUpGroups": 1, "behindGroups": 0, "errorGroups": 0, "runningGroups": 0, "outstandingEventCount": "12345" },
        "projectionGroups": [
            {
                "projectionName": "settlement-fulfillment-source-projection",
                "projectionRevision": 2,
                "storedProjectionRevision": 1,
                "revisionStale": false,
                "targetContextName": "settlement",
                "sourceContextNames": ["fulfillment"],
                "ownedTables": ["settlement_order_fulfillment_sources"],
                "requiredDuringBootstrap": false,
                "initialized": true,
                "caughtUp": false,
                "state": "degraded",
                "lastError": null,
                "outstandingEventCount": "0",
                "sourceLagEventCount": "0",
                "applicableLagEstimate": "0",
                "blockedStreamCount": 1,
                "poisonEventCount": 1,
                "updatedAt": "2026-10-28T10:00:00.000Z",
                "subscriptions": [{
                    "checkpointKey": GROUP_KEY,
                    "sourceContextName": "fulfillment",
                    "targetContextName": "settlement",
                    "subscriptionVersion": 2,
                    "lastGlobalPosition": "47",
                    "sourceHeadGlobalPosition": "47",
                    "outstandingEventCount": "0",
                    "state": "degraded",
                    "lastError": null,
                    "blockedStreamCount": 1,
                    "poisonEventCount": 1
                }]
            },
            {
                "projectionName": "auth-session-projection",
                "projectionRevision": 1,
                "storedProjectionRevision": 1,
                "targetContextName": "auth",
                "state": "caught-up",
                "caughtUp": true,
                "initialized": true,
                "outstandingEventCount": "0",
                "blockedStreamCount": 0,
                "poisonEventCount": 0,
                "updatedAt": "2026-10-28T10:00:00.000Z",
                "subscriptions": []
            }
        ],
        "blockedProjections": [{ "projectionKey": GROUP_KEY, "blockedStreamCount": 1, "poisonEventCount": 1 }],
        "projectionStatusSource": "worker-snapshot",
        "workers": [{ "worker_id": "platform-worker-1", "worker_kind": "platform-worker", "worker_state": "active" }],
        "workerHeartbeatHistory": { "expiredWithinDiagnosticWindowCount": 16 },
        "runners": [],
        "operations": [
            projection_operation("op_run", "rebuild-projection-group", "running", "2026-10-28T10:01:00.000Z"),
            projection_operation("op_fail", "rebuild-context", "failed", "2026-10-28T09:00:00.000Z"),
        ],
        "operationSummary": { "queuedCount": "0", "runningCount": "1", "failedCount": "1", "cancelRequestedCount": "0", "oldestRunningAt": "2026-10-28T10:00:00.000Z" },
        "attentionItems": [
            { "id": "degraded-groups", "label": "Degraded projection groups", "detail": "One or more projection groups report degraded or error state.", "tone": "danger", "count": 1, "targetTab": "groups" },
            { "id": "failed-operations", "label": "Failed operations", "detail": "Projection work reached a terminal failure.", "tone": "danger", "count": 1, "targetTab": "operations" }
        ],
        "repairQueue": [
            { "kind": "operation", "targetId": "op_fail", "label": "rebuild-context", "detail": "settlement", "state": "failed", "tone": "danger", "contextName": "settlement" },
            { "kind": "projection-group", "targetId": "settlement:settlement-fulfillment-source-projection", "label": "settlement-fulfillment-source-projection", "detail": "settlement projection group; poison events: 1; blocked streams: 1", "state": "degraded", "tone": "warning", "contextName": "settlement", "projectionName": "settlement-fulfillment-source-projection" }
        ],
        "activeWorkerCount": 1,
        "staleWorkerCount": 0
    })
}

/// The projections API. `projections-down` fails the console's read, `projections-nowake` the wake
/// read; staff who may only look are refused every write, as the API refuses them. A rebuild
/// without its confirm word is refused, as the API refuses it.
fn projections_api(method: &Method, rest: &str, cookie: &str, body: &str) -> Response {
    let view_only = !cookie.contains("chase_sets_session=projections-operator");
    let queued = |id: &str, kind: &str| {
        let operation = projection_operation(id, kind, "queued", "2026-10-28T10:10:00.000Z");
        (StatusCode::ACCEPTED, Json(json!({ "operation": operation }))).into_response()
    };
    match (method.clone(), rest) {
        (Method::GET, "") if cookie.contains("chase_sets_session=projections-down") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.")
        }
        (Method::GET, "") => Json(projections_console()).into_response(),
        (Method::GET, "/wake-status") if cookie.contains("chase_sets_session=projections-nowake") => {
            refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed.")
        }
        (Method::GET, "/wake-status") => Json(json!({
            "generatedAt": "2026-10-28T10:00:00.000Z",
            "attentionItems": [{ "id": "wake-failed", "label": "Failed wake intents", "detail": "Wake intents failed.", "tone": "warning", "targetTab": "wake" }]
        }))
        .into_response(),
        (Method::GET, "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams") => Json(json!({
            "projectionKey": GROUP_KEY,
            "blockedStreams": [{
                "projectionKey": GROUP_KEY,
                "streamId": "fulfillment.shipment-shp_1",
                "firstBlockedGlobalPosition": "11",
                "firstBlockedStreamVersion": 5,
                "lastSeenGlobalPosition": "12",
                "deferredEventCount": 1,
                "state": "blocked"
            }],
            "poisonEvents": [{
                "projectionKey": GROUP_KEY,
                "eventId": "evt_1",
                "eventType": "fulfillment.shipment.label-attached",
                "streamId": "fulfillment.shipment-shp_1",
                "streamVersion": 5,
                "globalPosition": "11",
                "errorMessage": "Label postage activation was not read.",
                "retryCount": 0,
                "firstSeenAt": "2026-10-24T03:56:21.724Z",
                "lastSeenAt": "2026-10-24T03:56:21.724Z",
                "state": "blocked"
            }]
        }))
        .into_response(),
        (Method::GET, "/operations/op_run/events") => {
            let event = |id: u32, operation: Value| format!("id: {id}\nevent: job.progress\ndata: {operation}\n\n");
            let body = [
                event(1, projection_operation("op_run", "rebuild-projection-group", "running", "2026-10-28T10:01:00.000Z")),
                event(2, projection_operation("op_run", "rebuild-projection-group", "succeeded", "2026-10-28T10:05:00.000Z")),
            ]
            .concat();
            ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
        }
        (Method::POST, _) if view_only => refusal(StatusCode::FORBIDDEN, "authorization_forbidden", "Forbidden."),
        (Method::POST, "/refresh") => Json(json!({ "summary": {}, "projectionGroups": [] })).into_response(),
        (Method::POST, "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams/fulfillment.shipment-shp_1/retry") => {
            queued("op_retry", "retry-blocked-stream")
        }
        (Method::POST, "/groups/settlement/settlement-fulfillment-source-projection/rebuild") if body.contains(r#""confirm":"rebuild""#) => {
            queued("op_rebuild", "rebuild-projection-group")
        }
        (Method::POST, "/groups/settlement/rebuild") if body.contains(r#""confirm":"rebuild-all""#) => queued("op_context", "rebuild-context"),
        (Method::POST, "/operations/op_run/cancel") => Json(json!({ "result": { "cancelled": true } })).into_response(),
        (Method::POST, _) => refusal(StatusCode::BAD_REQUEST, "confirmation_required", "Confirm."),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

impl Pilot {
    fn projection_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/platform/projections")).cloned().collect()
    }
}

#[tokio::test]
async fn projection_operations_draws_the_apis_console_and_triage() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/projections", Some("projections-operator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<h1>Projection Operations</h1>")
            && html.contains("<title>Projection Operations | Chase Sets Admin</title>"),
        "{html}"
    );
    assert!(html.contains(r#"href="/platform/projections" aria-current="page""#), "the nav entry is the pilot's: {html}");
    assert!(html.contains("/sections/platform/projections.css"), "the area's own stylesheet: {html}");
    // The API's and the wake read's attention: a danger item makes the console Needs attention.
    for text in
        ["Needs attention", "Source: worker-snapshot", "Degraded projection groups", "Failed operations", "Failed wake intents"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    // The counts: three attention items, the source lag grouped, the API's worker counts.
    assert!(html.contains("<dt>Attention</dt><dd>3</dd>"), "{html}");
    assert!(html.contains("12,345"), "grouped as admin-web's formatDecimalCount: {html}");
    assert!(html.contains("1 active · 0 stale"), "{html}");
    assert!(html.contains("16 expired heartbeats in the last 7 days"), "{html}");
    // The API's repair queue in its order, and the operations most urgent first.
    let failed = html.find("rebuild-context").unwrap();
    let group = html.find("settlement projection group; poison events: 1; blocked streams: 1").unwrap();
    assert!(failed < group, "the API's order");
    assert!(html.contains(r#"href="/platform/projections?selected=op_fail""#), "{html}");
    assert!(
        html.contains(
            r#"href="/platform/projections/reference?context_name=settlement&amp;projection_name=settlement-fulfillment-source-projection""#
        ),
        "the group's place on the pilot's reference page: {html}"
    );
    assert!(html.contains(r#"href="/platform/projections/reference""#), "Settings and reference is the pilot's: {html}");
    let ops = &html[html.find("projections-operations-title").unwrap()..];
    assert!(ops.find("op_fail").unwrap() < ops.find("op_run").unwrap(), "failed before running");
    // Staff who may operate get Refresh status, and the console follows the running operation.
    assert!(html.contains(r#"action="/platform/projections/refresh""#) && html.contains("Refresh status"), "{html}");
    assert!(html.contains(r#"src="/platform/projections/live""#), "{html}");
    assert!(
        html.contains(r#"href="/catalog/dimensions""#) && html.contains("/access/accounts"),
        "Catalog and Identity for who may see them"
    );
    assert!(!html.contains("<dialog"), "nothing selected, no sheet");
    assert!(!pilot.projection_calls().iter().any(|c| c.path.contains("/blocked-streams")), "no detail read without a selection");

    // Staff who may only look: no Refresh, no Catalog.
    let (status, _, html) = pilot.send(get("/platform/projections", Some("ops"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("/platform/projections/refresh") && !html.contains(r#"href="/catalog/dimensions""#), "{html}");
}

#[tokio::test]
async fn projection_operations_is_for_staff_who_may_see_it_and_survives_a_failed_wake_read() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/projections", Some("staff"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "postage and catalog staff do not see projections");
    let (status, headers, _) = pilot.send(get("/platform/projections", None)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().ends_with("/access/sign-in?returnTo=%2Fplatform%2Fprojections"));
    let (status, _, html) = pilot.send(get("/platform/projections", Some("projections-nowake"))).await;
    assert_eq!(status, StatusCode::OK, "the console without the wake read's items, as admin-web: {html}");
    assert!(!html.contains("Failed wake intents") && html.contains("Degraded projection groups"), "{html}");
    let (status, _, _) = pilot.send(get("/platform/projections", Some("projections-down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn projection_operations_filters_the_queue_and_the_operations() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/platform/projections?state=failed", Some("ops"))).await;
    assert!(html.contains("State: failed"), "the applied filter as a chip: {html}");
    assert!(html.contains(r#"<option value="failed" selected>failed</option>"#), "{html}");
    assert!(!html.contains("settlement projection group;"), "the degraded group is filtered out: {html}");
    let ops = &html[html.find("projections-operations-title").unwrap()..];
    assert!(ops.contains("op_fail") && !ops.contains("op_run"), "{ops}");
    // The details link keeps the filters.
    assert!(html.contains(r#"href="/platform/projections?state=failed&amp;selected=op_fail""#), "{html}");
    let (_, _, html) = pilot.send(get("/platform/projections?search=AUTH&context_name=auth", Some("ops"))).await;
    assert!(html.contains("No attention signals") && html.contains("Search: AUTH") && html.contains("Context: auth"), "{html}");
    assert!(html.contains(r#"<option value="auth" selected>auth</option>"#), "the contexts are the groups': {html}");
}

#[tokio::test]
async fn a_selected_record_opens_its_sheet_with_the_repairs_the_viewer_may_make() {
    let pilot = Pilot::new().await;
    // A running operation: Cancel for staff who may operate.
    let (_, _, html) = pilot.send(get("/platform/projections?selected=op_run", Some("projections-operator"))).await;
    assert!(html.contains("<dialog") && html.contains("rebuild-projection-group / running"), "{html}");
    assert!(html.contains("connect:ui.dialog.modalClosedBy($t,@back,$s)"), "Escape goes to the close link's address: {html}");
    assert!(
        html.contains(r#"action="/platform/projections/cancel?selected=op_run""#)
            && html.contains(r#"name="operation_id" value="op_run""#),
        "{html}"
    );
    assert!(html.contains(r#"href="/platform/projections" aria-label="Close projection detail""#), "closed by a link: {html}");
    let (_, _, html) = pilot.send(get("/platform/projections?selected=op_run", Some("ops"))).await;
    assert!(
        html.contains("<dialog") && !html.contains("/platform/projections/cancel"),
        "no Cancel for who may only look: {html}"
    );
    assert!(!pilot.projection_calls().iter().any(|c| c.path.contains("/blocked-streams")), "an operation needs no detail read");

    // A group: Rebuild and Rebuild context, each confirmed in its dialog, and its blocked streams
    // and poison events, read from the projection's own read (chase-sets/chase-sets#10710).
    let group = "/platform/projections?selected=settlement%3Asettlement-fulfillment-source-projection";
    let (_, _, html) = pilot.send(get(group, Some("projections-operator"))).await;
    assert!(html.contains("settlement.settlement-fulfillment-source-projection"), "{html}");
    assert!(
        html.contains(r#"command="show-modal""#)
            && html.contains("Queue rebuild")
            && html.contains(r#"action="/platform/projections/rebuild-context"#),
        "{html}"
    );
    assert!(html.contains("1 -&gt; 2") || html.contains("1 -> 2"), "the revision range: {html}");
    assert!(html.contains("selected=poison-event%3Aevt_1") && html.contains("fulfillment.shipment-shp_1"), "{html}");
    assert!(pilot.projection_calls().iter().any(|c| c.path.ends_with("%3Afulfillment%3Av2/blocked-streams")));

    // A poison event: Retry its stream.
    let (_, _, html) = pilot.send(get("/platform/projections?selected=poison-event%3Aevt_1", Some("projections-operator"))).await;
    assert!(
        html.contains("Label postage activation was not read.") && html.contains(r#"action="/platform/projections/retry"#),
        "{html}"
    );
    assert!(html.contains(r#"name="stream_id" value="fulfillment.shipment-shp_1""#), "{html}");
    // A blocked stream, and a record that is gone.
    let blocked =
        "/platform/projections?selected=settlement-fulfillment-source-projection%3Afulfillment%3Av2%3Afulfillment.shipment-shp_1";
    let (_, _, html) = pilot.send(get(blocked, Some("projections-operator"))).await;
    assert!(
        html.contains("<dialog")
            && html.contains(r#"name="projection_key" value="settlement-fulfillment-source-projection:fulfillment:v2""#),
        "{html}"
    );
    let (status, _, html) = pilot.send(get("/platform/projections?selected=gone", Some("projections-operator"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("<dialog"), "{html}");
}

#[tokio::test]
async fn each_projection_repair_goes_to_the_api_and_back_to_the_console_as_it_was() {
    let pilot = Pilot::new().await;
    let cases = [
        ("/platform/projections/refresh?state=failed", "", "/refresh", "{}"),
        (
            "/platform/projections/retry?selected=poison-event%3Aevt_1",
            "projection_key=settlement-fulfillment-source-projection%3Afulfillment%3Av2&stream_id=fulfillment.shipment-shp_1",
            "/settlement-fulfillment-source-projection%3Afulfillment%3Av2/blocked-streams/fulfillment.shipment-shp_1/retry",
            "{}",
        ),
        (
            "/platform/projections/rebuild?selected=settlement%3Asettlement-fulfillment-source-projection",
            "context_name=settlement&projection_name=settlement-fulfillment-source-projection",
            "/groups/settlement/settlement-fulfillment-source-projection/rebuild",
            r#"{"confirm":"rebuild"}"#,
        ),
        (
            "/platform/projections/rebuild-context",
            "context_name=settlement",
            "/groups/settlement/rebuild",
            r#"{"confirm":"rebuild-all"}"#,
        ),
        ("/platform/projections/cancel?selected=op_run", "operation_id=op_run", "/operations/op_run/cancel", "{}"),
    ];
    for (uri, body, api, sent) in cases {
        let (status, headers, html) = pilot.send(post_as("projections-operator", uri, body, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{uri}: {html}");
        let back = uri.replacen(uri.split('?').next().unwrap(), "/platform/projections", 1);
        assert_eq!(headers[header::LOCATION], back.as_str(), "{uri}: back to the console as it was");
        let call = pilot.projection_calls().into_iter().rev().find(|c| c.method == Method::POST).unwrap();
        assert_eq!(call.path, format!("/api/platform/projections{api}"), "{uri}");
        assert_eq!(call.body, sent, "{uri}");
    }
    // The API refuses who may only look: the page says so.
    let (status, _, html) =
        pilot.send(post_as("ops", "/platform/projections/rebuild-context", "context_name=settlement", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{html}");
}

#[tokio::test]
async fn the_reference_page_lists_groups_subscriptions_workers_wake_signals_and_diagnostics() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/platform/projections/reference", Some("ops"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<h1>Projection settings and reference</h1>")
            && html.contains("<title>Projection Settings and Reference | Chase Sets Admin</title>"),
        "{html}"
    );
    assert!(html.contains("/sections/platform/projections.css"), "the area's stylesheet: {html}");
    assert!(html.contains(r#"href="/platform/projections""#) && html.contains("Back to projection operations"), "{html}");
    // The groups, the degraded one first, each with its issues and a Details link that stays here.
    let groups = &html[html.find("projections-groups-title").unwrap()..html.find("projections-subscriptions-title").unwrap()];
    assert!(groups.find("settlement-fulfillment-source-projection").unwrap() < groups.find("auth-session-projection").unwrap());
    assert!(groups.contains("1 blocked / 1 poison"), "{groups}");
    assert!(
        groups
            .contains(r#"href="/platform/projections/reference?selected=settlement%3Asettlement-fulfillment-source-projection""#),
        "{groups}"
    );
    // The subscription matrix: the checkpoint, its source and its positions.
    let matrix = &html[html.find("projections-subscriptions-title").unwrap()..html.find("projections-workers-title").unwrap()];
    assert!(
        matrix.contains("settlement-fulfillment-source-projection:fulfillment:v2") && matrix.contains("47 -&gt; 47"),
        "{matrix}"
    );
    // The workers, the wake pipeline's signals and the diagnostics.
    assert!(html.contains("platform-worker-1") && html.contains("platform-worker"), "{html}");
    assert!(html.contains("Failed wake intents") && html.contains("Wake intents failed."), "{html}");
    assert!(
        html.contains("<dt>Status source</dt><dd>worker-snapshot</dd>") && html.contains("<dt>Caught up</dt><dd>1</dd>"),
        "{html}"
    );
    assert!(html.contains("<dt>Oldest queued at</dt><dd>Not recorded</dd>"), "{html}");
    assert!(!html.contains("<dialog"), "nothing selected, no sheet");

    // The filters keep only what they choose, and their form and Clear stay on this page.
    let (_, _, html) = pilot.send(get("/platform/projections/reference?context_name=auth", Some("ops"))).await;
    assert!(html.contains(r#"action="/platform/projections/reference""#) && html.contains("Context: auth"), "{html}");
    let groups = &html[html.find("projections-groups-title").unwrap()..html.find("projections-subscriptions-title").unwrap()];
    assert!(groups.contains("auth-session-projection") && !groups.contains("settlement-fulfillment"), "{groups}");
    assert!(
        html.contains("No subscriptions") && html.contains("No workers"),
        "a context hides the workers, as admin-web's: {html}"
    );

    // Without the wake read, the page says so.
    let (status, _, html) = pilot.send(get("/platform/projections/reference", Some("projections-nowake"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Push-wake status unavailable") && !html.contains("Failed wake intents"), "{html}");
    let (status, _, _) = pilot.send(get("/platform/projections/reference", Some("staff"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/platform/projections/reference", Some("projections-down"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_repair_from_the_reference_page_comes_back_to_it() {
    let pilot = Pilot::new().await;
    let group = "/platform/projections/reference?selected=settlement%3Asettlement-fulfillment-source-projection";
    let (_, _, html) = pilot.send(get(group, Some("projections-operator"))).await;
    assert!(html.contains("<dialog") && html.contains("settlement.settlement-fulfillment-source-projection"), "{html}");
    assert!(
        html.contains(
            r#"action="/platform/projections/rebuild?selected=settlement%3Asettlement-fulfillment-source-projection&amp;via=reference""#
        ),
        "{html}"
    );
    assert!(
        html.contains(r#"href="/platform/projections/reference" aria-label="Close projection detail""#),
        "closed back to this page: {html}"
    );
    assert!(html.contains(r#"href="/platform/projections/reference?selected=poison-event%3Aevt_1""#), "{html}");
    let (status, headers, html) = pilot
        .send(post_as(
            "projections-operator",
            "/platform/projections/rebuild?selected=settlement%3Asettlement-fulfillment-source-projection&via=reference",
            "context_name=settlement&projection_name=settlement-fulfillment-source-projection",
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(
        headers[header::LOCATION],
        "/platform/projections/reference?selected=settlement%3Asettlement-fulfillment-source-projection"
    );
}

#[tokio::test]
async fn the_console_is_drawn_again_when_a_running_operation_changes_state() {
    let pilot = Pilot::new().await;
    // The stream's first record is the state the page has (running): nothing. The second
    // (succeeded) draws the health, the repair queue and the operations again from a new read.
    let events = pilot.events("/platform/projections/live", "projections-operator", 3).await;
    let patches: Vec<&(String, String)> = events.iter().filter(|(event, _)| event == "patch").collect();
    assert_eq!(patches.len(), 1, "{events:?}");
    let html = &patches[0].1;
    for id in [r#"id="projections-health""#, r#"id="projections-repair""#, r#"id="projections-operations""#] {
        assert!(html.contains(id), "{id}: {html}");
    }
    assert!(!html.contains(r#"method="get""#), "the filters are not drawn again: {html}");
    assert_eq!(events.last().unwrap().0, "end", "the stream ends once the operation is done: {events:?}");
}

#[tokio::test]
async fn access_is_an_area_each_list_needs_its_nav_entrys_permission() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(get("/access/users", None)).await;
    assert_eq!(
        (status, &headers[header::LOCATION]),
        (
            StatusCode::SEE_OTHER,
            &"http://localhost:7752/access/sign-in?returnTo=%2Faccess%2Fusers".parse::<header::HeaderValue>().unwrap()
        )
    );
    for (path, status) in [
        ("/access", StatusCode::OK),
        ("/access/accounts", StatusCode::OK),
        ("/access/users", StatusCode::FORBIDDEN),
        ("/access/api-keys", StatusCode::FORBIDDEN),
        ("/access/memberships", StatusCode::FORBIDDEN),
        ("/access/invitations", StatusCode::FORBIDDEN),
    ] {
        assert_eq!(pilot.send(get(path, Some("accounts-only"))).await.0, status, "{path}");
    }
    let (status, _, _) = pilot.send(get("/access", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "accounts.view is the section's fallback");
    for path in ["/access/users", "/access/api-keys", "/access/memberships", "/access/invitations"] {
        let (status, _, html) = pilot.send(get(path, Some("access-staff"))).await;
        assert_eq!(status, StatusCode::OK, "{path}: {html}");
        assert!(html.contains(&format!(r#"href="{path}" aria-current="page""#)), "the nav serves it: {html}");
    }
}

#[tokio::test]
async fn accesss_home_shows_each_attention_kind_and_searches_accounts() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/access?search=+acme+", Some("access-staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let calls = pilot.calls_to("/api/identity/");
    assert_eq!(calls.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["/api/identity/access-hub?search=acme"]);
    assert!(calls[0].headers[header::COOKIE] == "chase_sets_session=access-staff");
    for kind in ["Pending invitation", "API key rotation due", "Suspended account", "Membership awaiting review"] {
        assert!(html.contains(kind), "{kind}: {html}");
    }
    assert!(html.contains("new@example.test · Manager · "), "{html}");
    assert!(html.contains("Inventory sync · Dana · "), "{html}");
    assert!(html.contains("dana@example.test · Unrecognized"), "an unknown role is named as one: {html}");
    assert!(html.contains(r#"href="/access/accounts/acc_1?tab=team""#), "{html}");
    assert!(html.contains(r#"href="/access/accounts/acc_1?tab=api-access""#), "{html}");
    assert!(html.contains(r#"href="/access/accounts/acc_2""#), "the overview is the plain address: {html}");
    assert!(!html.contains("localhost:7752/access/accounts"), "nothing opens admin-web's workspace: {html}");
    assert!(html.contains("39 accounts found") && html.contains(r#"value="acme""#), "{html}");
    let section = pilot.stylesheet(&html, "sections/access").await.unwrap();
    assert!(section.contains(".access-page__table") && !section.contains(".list-page__"), "{section}");

    let mut req = get("/access", Some("access-staff"));
    req.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    let (_, _, body) = pilot.send(req).await;
    let screen: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(screen["data"]["home"]["account_total"], 39, "{body}");
}

#[tokio::test]
async fn an_access_list_asks_identity_as_admin_web_does_and_pages() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/access/accounts?search=acme&status=suspended&offset=50", Some("access-staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let (_, _, _) = pilot.send(get("/access/users?status=bogus&limit=900", Some("access-staff"))).await;
    let paths: Vec<String> = pilot.calls_to("/api/identity/").into_iter().map(|c| c.path).collect();
    assert_eq!(
        paths,
        ["/api/identity/accounts?limit=50&offset=50&status=suspended&search=acme", "/api/identity/users?limit=500&offset=0",]
    );
    assert!(html.contains("Founding Account #007") && !html.contains("unknown-badge"), "{html}");
    assert!(html.contains(r#"href="/access/accounts?search=acme&amp;status=suspended" rel="prev""#), "{html}");
    assert!(html.contains(r#"href="/access/accounts?search=acme&amp;status=suspended&amp;offset=100" rel="next""#), "{html}");
    assert!(html.contains(r#"<option value="suspended" selected>"#), "{html}");

    let (_, _, html) = pilot.send(get("/access/users", Some("access-staff"))).await;
    assert!(html.contains("Password, Passkey"), "{html}");
    let (_, _, html) = pilot.send(get("/access/memberships", Some("access-staff"))).await;
    assert!(html.contains("dana@example.test") && html.contains("Acme Cards LLC"), "{html}");
    assert!(html.contains(r#"href="/access/accounts/acc_1?tab=team""#), "{html}");
    let (_, _, html) = pilot.send(get("/access/api-keys", Some("access-staff"))).await;
    assert!(html.contains("<code>csk_abc</code>") && html.contains(r#"href="/access/api-keys/key_1""#), "{html}");
}

#[tokio::test]
async fn an_accounts_workspace_draws_each_tab_from_one_read() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/access/accounts/acc_1", Some("access-admin"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let paths: Vec<String> = pilot.calls_to("/api/identity/").into_iter().map(|c| c.path).collect();
    assert_eq!(paths, ["/api/identity/access-hub/accounts/acc_1"]);
    for words in ["Acme Cards", "Overview", "Team", "API Access", "Audit", "Suspend"] {
        assert!(html.contains(words), "{words}: {html}");
    }
    let (_, _, html) = pilot.send(get("/access/accounts/acc_1?tab=team", Some("access-admin"))).await;
    assert!(html.contains("dana@example.test") && html.contains("new@example.test"), "{html}");
    assert!(html.contains(r#"value="resend-invitation""#), "a manager may resend: {html}");
    let (_, _, html) = pilot.send(get("/access/accounts/acc_1?tab=api-access", Some("access-admin"))).await;
    assert!(html.contains("Inventory sync") && html.contains(r#"value="rotate-api-key""#), "{html}");
    let (_, _, html) = pilot.send(get("/access/accounts/acc_1?tab=audit", Some("access-admin"))).await;
    assert!(html.contains("acc_1 · usr_1"), "{html}");

    let (status, _, html) = pilot.send(get("/access/accounts/acc_1?tab=team", Some("accounts-only"))).await;
    assert_eq!(status, StatusCode::OK, "accounts.view reads the workspace: {html}");
    for intent in ["suspend", "resend-invitation", "create-invitation"] {
        assert!(!html.contains(&format!(r#"value="{intent}""#)), "{intent} is not offered: {html}");
    }
    let (status, _, _) = pilot.send(post_as("accounts-only", "/access/accounts/acc_1", "intent=suspend", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(post_as("access-admin", "/access/accounts/acc_1", "intent=bogus", false)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let writes = pilot.calls_to("/api/identity/").into_iter().filter(|c| c.method != Method::GET).count();
    assert_eq!(writes, 0, "a refused or unknown form writes nothing");
}

#[tokio::test]
async fn a_workspace_form_writes_to_identity_and_reads_the_page_after_it() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post_as("access-admin", "/access/accounts/acc_1", "intent=suspend", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/access/accounts/acc_1?tab=overview&after_write="), "{to}");

    let body = "intent=create-invitation&email=new2%40example.test&roleKey=manager";
    let (status, headers, _) = pilot.send(post_as("access-admin", "/access/accounts/acc_1", body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/access/accounts/acc_1?tab=team&after_write="));
    let writes: Vec<Call> = pilot.calls_to("/api/identity/").into_iter().filter(|c| c.method == Method::POST).collect();
    assert_eq!(
        writes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        ["/api/identity/accounts/acc_1/suspend", "/api/identity/invitations"]
    );
    let sent: Value = serde_json::from_str(&writes[1].body).unwrap();
    assert_eq!((sent["accountId"].as_str(), sent["roleKey"].as_str()), (Some("acc_1"), Some("manager")), "{sent}");
    let expires =
        time::OffsetDateTime::parse(sent["expiresAt"].as_str().unwrap(), &time::format_description::well_known::Rfc3339).unwrap();
    let hours = (expires - time::OffsetDateTime::now_utc()).whole_hours();
    assert!(
        (167..=168).contains(&hours) && expires.nanosecond().is_multiple_of(1_000_000),
        "seven days, to the millisecond: {sent}"
    );

    let body = "intent=create-invitation&email=taken%40example.test&roleKey=viewer";
    let (status, headers, html) = pilot.send(post_as("access-admin", "/access/accounts/acc_1", body, false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(headers.get(header::LOCATION).is_none());
    assert!(html.contains("That email already has a pending invitation.") && html.contains(r#"role="alert""#), "{html}");

    let (status, headers, html) =
        pilot.send(post_as("access-admin", "/access/accounts/acc_1", "intent=rotate-api-key&apiKeyId=key_1", false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(headers.get(header::LOCATION).is_none(), "the secret is never put in an address");
    assert!(html.contains("API key secret rotated") && html.contains("csk_new_full_secret"), "{html}");
}

#[tokio::test]
async fn a_workspace_whose_write_is_not_readable_yet_is_read_without_it() {
    let pilot = Pilot::new().await;
    let uri = format!("/access/accounts/acc_1?tab=team&after_write={}", fresh_receipt());
    let (status, _, html) = pilot.send(get(&uri, Some("lagging-admin"))).await;
    assert_eq!(status, StatusCode::OK, "admin-web's onPending: {html}");
    assert!(
        html.contains("new@example.test") && html.contains("Refresh in a moment"),
        "it says the change is on its way: {html}"
    );
    let reads: Vec<bool> =
        pilot.calls_to("/api/identity/").iter().map(|c| c.headers.contains_key("chase-sets-read-after-write")).collect();
    assert_eq!(reads, [true, false], "the write's read, then the read without it");
}

#[tokio::test]
async fn sessions_list_and_page_read_auth_as_admin_web_does() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/access/sessions?search=+dana+&status=revoked&offset=50", Some("access-staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let paths: Vec<String> = pilot.calls_to("/api/auth/sessions").into_iter().map(|c| c.path).collect();
    assert_eq!(paths, ["/api/auth/sessions?limit=50&offset=50&status=revoked&search=dana"]);
    assert!(html.contains("dana@example.test") && html.contains("Acme Cards") && html.contains("Magic link"), "{html}");
    assert!(html.contains(r#"href="/access/sessions/ses_1""#) && html.contains("Status: Revoked"), "{html}");
    assert!(html.contains(r#"href="/access/sessions" aria-current="page""#), "the nav serves it: {html}");
    assert_eq!(pilot.send(get("/access/sessions", Some("accounts-only"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(pilot.send(get("/access/sessions/ses_1", Some("accounts-only"))).await.0, StatusCode::FORBIDDEN);

    let (status, _, html) = pilot.send(get("/access/sessions/ses_1", Some("access-staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("dana@example.test session") && html.contains("acc_1, acc_2"), "{html}");
    assert!(html.contains(r#"value="switch-account""#) && html.contains(r#"value="revoke""#), "{html}");
    assert!(html.contains(r#"<option value="acc_1" selected>Acme Cards</option>"#), "{html}");
    let (_, _, html) = pilot.send(get("/access/sessions/ses_old", Some("access-staff"))).await;
    assert!(!html.contains(r#"value="revoke""#), "a revoked session has no forms: {html}");
    assert_eq!(pilot.send(get("/access/sessions/ses_none", Some("access-staff"))).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_sessions_switch_or_revoke_writes_to_auth_and_reads_the_page_after_it() {
    let pilot = Pilot::new().await;
    for (body, rest, sent) in [
        ("intent=switch-account&accountId=acc_2", "switch-account", r#"{"accountId":"acc_2"}"#),
        ("intent=revoke", "revoke", "{}"),
    ] {
        let (status, headers, _) = pilot.send(post_as("access-staff", "/access/sessions/ses_1", body, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{body}");
        let to = headers[header::LOCATION].to_str().unwrap();
        assert!(to.starts_with("/access/sessions/ses_1?after_write="), "{to}");
        let write = pilot.calls_to("/api/auth/sessions").into_iter().last().unwrap();
        assert_eq!(
            (write.method, write.path.as_str(), write.body.as_str()),
            (Method::POST, &*format!("/api/auth/sessions/ses_1/{rest}"), sent)
        );
    }
    let (status, headers, _) = pilot.send(post_as("access-staff", "/access/sessions/ses_1", "intent=bogus", false)).await;
    assert_eq!(
        (status, &headers[header::LOCATION]),
        (StatusCode::SEE_OTHER, &"/access/sessions/ses_1".parse::<header::HeaderValue>().unwrap())
    );
    let body = "intent=switch-account&accountId=acc_gone";
    let (status, headers, html) = pilot.send(post_as("access-staff", "/access/sessions/ses_1", body, false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(headers.get(header::LOCATION).is_none());
    assert!(html.contains("That account is not available to this session.") && html.contains(r#"role="alert""#), "{html}");
    let (status, _, _) = pilot.send(post_as("accounts-only", "/access/sessions/ses_1", "intent=revoke", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let writes = pilot.calls_to("/api/auth/sessions").into_iter().filter(|c| c.method == Method::POST).count();
    assert_eq!(writes, 3, "the unknown intent and the forbidden one write nothing");
}

#[tokio::test]
async fn a_users_or_keys_page_opens_its_accounts_workspace() {
    let pilot = Pilot::new().await;
    for (path, to) in [
        ("/access/users/usr_2", "/access/accounts/acc_1?tab=team"),
        ("/access/users/usr_9", "/access/users?search=usr_9"),
        ("/access/api-keys/key_1", "/access/accounts/acc_1?tab=api-access"),
        ("/access/memberships/mem_1", "/access/accounts/acc_1?tab=team"),
        ("/access/invitations/inv_1", "/access/accounts/acc_1?tab=team"),
    ] {
        let (status, headers, html) = pilot.send(get(path, Some("access-staff"))).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{path}: {html}");
        assert_eq!(headers[header::LOCATION], to, "{path}");
    }
    assert_eq!(pilot.send(get("/access/users/usr_2", Some("accounts-only"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(pilot.send(get("/access/memberships/mem_1", Some("accounts-only"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(pilot.send(get("/access/memberships/mem_gone", Some("access-staff"))).await.0, StatusCode::NOT_FOUND);
}

const REPORTED: &str = "/api/experience/reported-content";

#[tokio::test]
async fn reported_content_reads_the_queue_and_its_counts_as_admin_web_does() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(get("/support/reported-content?status=needs-review&targetType=bogus", Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let mut paths: Vec<String> = pilot.calls_to(REPORTED).into_iter().map(|c| c.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        [format!("{REPORTED}/metrics"), format!("{REPORTED}?limit=100&offset=0&status=needs-review")],
        "an unknown target type is all of them"
    );
    for text in ["<dd>12</dd>", "<dd>7</dd>", "<dd>3</dd>", "Listing lst_1", "counterfeit (2)", "Showing 2 of 12"] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"<option value="needs-review" selected>Needs review</option>"#), "{html}");
    assert!(html.contains(r#"<option value="all" selected>All targets</option>"#), "{html}");
    assert!(html.contains(r#"href="/support/reported-content/listing/lst_1""#), "{html}");
    assert!(html.contains(r#"href="/support/reported-content" aria-current="page""#), "the nav serves it: {html}");
    assert_eq!(pilot.send(get("/support/reported-content", Some("staff"))).await.0, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(get("/support/reported-content/listing/lst_1", Some("staff"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_reported_targets_page_offers_its_target_types_actions_and_its_reports() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/reported-content/listing/lst_1", Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for action in ["dismiss", "contact-seller", "unlist", "escalate-account-suspension"] {
        assert!(html.contains(&format!(r#"value="{action}""#)), "{action}: {html}");
    }
    assert!(!html.contains(r#"value="withdraw-review""#), "{html}");
    for text in
        ["Fake holo.", "No details provided.", "Visitor at", "Signed-in account at", "Latest moderation action: contact seller"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    let (_, _, html) = pilot.send(get("/support/reported-content/review/rev_1", Some("moderator"))).await;
    assert!(html.contains(r#"value="withdraw-review""#) && html.contains(r#"value="withdraw-review-reply""#), "{html}");
    let (status, _, _) = pilot.send(get("/support/reported-content/listing/lst_none", Some("moderator"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_moderation_action_is_sent_and_the_page_is_read_after_it() {
    let pilot = Pilot::new().await;
    let at = "/support/reported-content/listing/lst_1";
    let (status, headers, _) = pilot.send(post_as("moderator", at, "action=unlist&note=+Counterfeit+", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap();
    assert!(to.starts_with("/support/reported-content/listing/lst_1?after_write="), "{to}");
    let write = pilot.calls_to(REPORTED).into_iter().last().unwrap();
    assert_eq!(
        (write.method, write.path.as_str(), write.body.as_str()),
        (Method::POST, &*format!("{REPORTED}/listing/lst_1/actions"), r#"{"action":"unlist","note":"Counterfeit"}"#)
    );
    let (status, _, html) = pilot.send(get(to, Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let read = pilot.calls_to(REPORTED).into_iter().last().unwrap();
    assert!(read.headers.contains_key("chase-sets-read-after-write"), "the read waits for the action");

    let (status, _, _) = pilot.send(post_as("moderator", at, "action=bogus", false)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = pilot.send(post_as("staff", at, "action=dismiss", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let review = "/support/reported-content/review/rev_1";
    let (status, headers, html) = pilot.send(post_as("moderator", review, "action=withdraw-review&note=+", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(headers.get(header::LOCATION).is_none());
    assert!(html.contains("The moderation action was rejected.") && html.contains(r#"role="alert""#), "{html}");
    let writes: Vec<String> = pilot.calls_to(REPORTED).into_iter().filter(|c| c.method == Method::POST).map(|c| c.body).collect();
    assert_eq!(writes.len(), 2, "the unknown action and the forbidden one write nothing: {writes:?}");
    assert_eq!(writes[1], r#"{"action":"withdraw-review","note":null}"#);
}

#[tokio::test]
async fn a_target_read_after_an_action_that_is_not_readable_yet_is_read_without_it_and_says_so() {
    let pilot = Pilot::new().await;
    let at = format!("/support/reported-content/listing/lst_1?after_write={}", fresh_receipt());
    let (status, _, html) = pilot.send(get(&at, Some("moderator-lag"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"role="status""#) && html.contains("Refresh in a moment"), "{html}");
    let reads = pilot.calls_to(REPORTED);
    assert_eq!(reads.len(), 2, "with the receipt, then without it");
    assert!(!reads[1].headers.contains_key("chase-sets-read-after-write"));
}

#[tokio::test]
async fn an_action_answered_without_a_receipt_carries_its_time_and_the_page_says_it_is_being_applied() {
    let pilot = Pilot::new().await;
    let at = "/support/reported-content/review/rev_1";
    let (status, headers, _) = pilot.send(post_as("moderator", at, "action=dismiss&note=Not+abusive", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert_eq!(to, "/support/reported-content/review/rev_1?recorded=2026-10-30T12%3A00%3A00.000Z");
    let (status, _, html) = pilot.send(get(&to, Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"role="status""#) && html.contains("Refresh in a moment"), "older than the action: {html}");
    let caught_up = "/support/reported-content/review/rev_1?recorded=2026-10-29T13%3A00%3A00.000Z";
    let (_, _, html) = pilot.send(get(caught_up, Some("moderator"))).await;
    assert!(!html.contains("Refresh in a moment"), "the target shows the action: {html}");
}

const RISK: &str = "/api/experience/risk-alerts";

#[tokio::test]
async fn risk_alerts_read_the_queue_and_an_alerts_page_as_admin_web_does() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/risk-alerts?status=all&alertKind=review-velocity", Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let mut paths: Vec<String> = pilot.calls_to(RISK).into_iter().map(|c| c.path).collect();
    paths.sort();
    assert_eq!(paths, [format!("{RISK}/metrics"), format!("{RISK}?limit=100&offset=0&alertKind=review-velocity")]);
    for text in
        ["Chargeback velocity", "chargebackCount: 3, windowDays: 30", "Showing 2 of 2", r#"href="/support/risk-alerts/ral_1""#]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"<option value="review-velocity" selected>Review velocity</option>"#), "{html}");
    assert!(html.contains(r#"href="/support/risk-alerts" aria-current="page""#), "the nav serves it: {html}");
    assert_eq!(pilot.send(get("/support/risk-alerts", Some("staff"))).await.0, StatusCode::FORBIDDEN);

    let (status, _, html) = pilot.send(get("/support/risk-alerts/ral_1", Some("moderator"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"value="request-manual-payout-review""#) && html.contains(r#"value="acknowledge""#), "{html}");
    assert!(html.contains("<dt>minChargebacks</dt>") && html.contains("<dt>windowDays</dt>"), "{html}");
    let (_, _, html) = pilot.send(get("/support/risk-alerts/ral_2", Some("moderator"))).await;
    assert!(!html.contains(r#"value="request-manual-payout-review""#), "only a candidate is offered it: {html}");
    assert_eq!(pilot.send(get("/support/risk-alerts/ral_none", Some("moderator"))).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_risk_alert_response_is_sent_and_the_page_says_it_is_being_applied_until_it_shows() {
    let pilot = Pilot::new().await;
    let at = "/support/risk-alerts/ral_1";
    let (status, headers, _) = pilot.send(post_as("moderator", at, "action=acknowledge&note=+Known+seller+", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert_eq!(to, "/support/risk-alerts/ral_1?recorded=2026-10-30T12%3A00%3A00.000Z");
    let write = pilot.calls_to(RISK).into_iter().last().unwrap();
    assert_eq!(
        (write.method, write.path.as_str(), write.body.as_str()),
        (Method::POST, &*format!("{RISK}/ral_1/actions"), r#"{"action":"acknowledge","note":"Known seller"}"#)
    );
    let (_, _, html) = pilot.send(get(&to, Some("moderator"))).await;
    assert!(html.contains(r#"role="status""#) && html.contains("Refresh in a moment"), "{html}");
    assert_eq!(pilot.send(post_as("moderator", at, "action=unlist", false)).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(pilot.send(post_as("staff", at, "action=acknowledge", false)).await.0, StatusCode::FORBIDDEN);
    let writes = pilot.calls_to(RISK).into_iter().filter(|c| c.method == Method::POST).count();
    assert_eq!(writes, 1, "the unknown response and the forbidden one write nothing");
}

const LOOKUP: &str = "/api/platform/support-reference-lookup";

#[tokio::test]
async fn reference_lookup_finds_the_record_a_reference_names_and_links_its_admin_page() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/reference-lookup", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(pilot.calls_to(LOOKUP).is_empty(), "nothing is looked up before a search");
    assert!(!html.contains("No record found") && !html.contains("Result"), "{html}");
    assert!(html.contains(r#"href="/support/reference-lookup" aria-current="page""#), "the nav serves it: {html}");

    let (status, _, html) = pilot.send(get("/support/reference-lookup?reference=+ORD-A1B2C3D4+", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(pilot.calls_to(LOOKUP).last().unwrap().path, format!("{LOOKUP}/ORD-A1B2C3D4"));
    for text in
        ["Order for 2 items, $41.50", "ordering", "paid", r#"value="ORD-A1B2C3D4""#, "/commerce/orders/ord_1\">Open record"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    let (_, _, html) = pilot.send(get("/support/reference-lookup?reference=ORD-OFFSITE", Some("support-agent"))).await;
    assert!(html.contains("Order for 2 items") && !html.contains("Open record"), "a link off this site is not drawn: {html}");

    let (status, _, html) = pilot.send(get("/support/reference-lookup?reference=ORD-NONE", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("No record found") && html.contains("ORD-NONE"), "{html}");
    let (status, _, html) = pilot.send(get("/support/reference-lookup?reference=ORD-DOWN", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains(r#"role="alert""#) && html.contains("Reference lookup request failed."), "{html}");
    assert_eq!(pilot.send(get("/support/reference-lookup", Some("moderator"))).await.0, StatusCode::FORBIDDEN);
}

const CSAT: &str = "/api/customer-feedback";

#[tokio::test]
async fn the_csat_dashboard_reads_customer_feedback_with_the_filters_admin_web_offers() {
    let pilot = Pilot::new().await;
    let at = "/support/csat?from=2026-10-01&to=oops&surveyVersion=v1&outcomeCodes=order.delivered&customerRoles=pirate&ratings=4";
    let (status, _, html) = pilot.send(get(at, Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(
        pilot.calls_to(CSAT).last().unwrap().path,
        format!("{CSAT}?from=2026-10-01&surveyVersion=csat.v1&outcomeCodes=order.delivered&ratings=4"),
        "admin-web's v1 is the registered version; what admin-web does not offer is left out"
    );
    for text in [
        "<dd>Insufficient sample</dd>",
        "<dd>86%</dd>",
        "<dd>25%</dd>",
        "<dd>7</dd>",
        "<dd>28</dd>",
        "csi_1",
        "Order delivered",
        "Transactional CSAT v1",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"<option value="csat.v1" selected>Transactional CSAT v1</option>"#), "{html}");
    assert!(html.contains(r#"<option value="order.delivered" selected>Order delivered</option>"#), "{html}");
    assert!(html.contains(r#"value="2026-10-01""#), "{html}");
    assert!(html.contains("cursor=c2&amp;direction=next") && html.contains("cursor=c0&amp;direction=previous"), "{html}");
    assert!(!html.contains("Export safe CSV"), "Export is left out until it works: {html}");
    assert!(html.contains(r#"href="/support/csat" aria-current="page""#), "the nav serves it: {html}");

    pilot.send(get("/support/csat?cursor=c2&direction=next&ratings=4", Some("feedback-viewer"))).await;
    assert_eq!(pilot.calls_to(CSAT).last().unwrap().path, format!("{CSAT}?ratings=4&cursor=c2&direction=next"));
    assert_eq!(pilot.send(get("/support/csat", Some("support-agent"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_csat_read_that_fails_keeps_the_filters_on_the_page_with_a_banner() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/csat?to=2099-01-01&states=issued", Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains(r#"role="alert""#) && html.contains(r#"value="2099-01-01""#), "{html}");
    assert!(html.contains(r#"<option value="issued" selected>Issued</option>"#), "{html}");
}

const FEEDBACK: &str = "/api/experience/platform-feedback";

#[tokio::test]
async fn platform_feedback_reads_the_queue_and_its_counts_with_the_filters_admin_web_offers() {
    let pilot = Pilot::new().await;
    let at = "/support/platform-feedback?status=new&topic=bogus&workflow=offer-submit";
    let (status, _, html) = pilot.send(get(at, Some("feedback-manager"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let mut paths: Vec<String> = pilot.calls_to(FEEDBACK).into_iter().map(|c| c.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        [format!("{FEEDBACK}/metrics"), format!("{FEEDBACK}?limit=100&offset=0&status=new&workflow=offer-submit")],
        "an unknown topic is all of them"
    );
    for text in [
        "<dd>5</dd>",
        "<dd>3</dd>",
        "<dd>3.80</dd>",
        "\u{2605}\u{2605}\u{2605}\u{2605}\u{2606}",
        "4/5",
        "Ease of use",
        "Offer submission",
        "May 7, 2026, 6:00 PM UTC",
        "Showing 2 of 5",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"<option value="new" selected>New</option>"#), "{html}");
    assert!(html.contains(r#"<option value="all" selected>All topics</option>"#), "{html}");
    assert!(html.contains(r#"href="/support/platform-feedback/pfb_1""#), "{html}");
    assert!(html.contains(r#"name="feedbackIds" value="pfb_1""#), "a box on each row: {html}");
    assert!(html.contains(r#"value="bulk-review""#) && html.contains(r#"value="bulk-archive""#), "{html}");
    assert!(html.contains(r#"action="/support/platform-feedback?status=new&amp;workflow=offer-submit""#), "{html}");
    assert!(html.contains(r#"href="/support/platform-feedback/export?status=new&amp;workflow=offer-submit""#), "{html}");
    assert!(html.contains(r#"href="/support/platform-feedback" aria-current="page""#), "the nav serves it: {html}");

    let (status, _, html) = pilot.send(get("/support/platform-feedback", Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains("feedbackIds") && !html.contains("bulk-review"), "a viewer changes nothing: {html}");
    assert!(!html.contains("Export CSV"), "nor exports: {html}");
    assert_eq!(pilot.send(get("/support/platform-feedback", Some("support-agent"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_bulk_change_sends_the_ticked_rows_and_the_list_is_read_after_it() {
    let pilot = Pilot::new().await;
    let at = "/support/platform-feedback?status=new";
    let form = "intent=bulk-archive&feedbackIds=pfb_1&feedbackIds=pfb_2";
    let (status, headers, _) = pilot.send(post_as("feedback-manager", at, form, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/support/platform-feedback?status=new&after_write="), "{to}");
    let write = pilot.calls_to(FEEDBACK).into_iter().last().unwrap();
    assert_eq!(
        (write.method, write.path.as_str(), write.body.as_str()),
        (Method::POST, &*format!("{FEEDBACK}/bulk/archive"), r#"{"feedbackIds":["pfb_1","pfb_2"]}"#)
    );
    let (status, _, html) = pilot.send(get(&to, Some("feedback-manager"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(pilot.calls_to(FEEDBACK).into_iter().last().unwrap().headers.contains_key("chase-sets-read-after-write"));

    for form in ["intent=bulk-review", "intent=bogus&feedbackIds=pfb_1"] {
        let (status, headers, _) = pilot.send(post_as("feedback-manager", at, form, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{form}");
        assert_eq!(headers[header::LOCATION], "/support/platform-feedback?status=new", "{form}");
    }
    let (status, _, _) = pilot.send(post_as("feedback-viewer", at, "intent=bulk-review&feedbackIds=pfb_1", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let writes = pilot.calls_to(FEEDBACK).into_iter().filter(|c| c.method == Method::POST).count();
    assert_eq!(writes, 1, "no selection, an unknown intent and a viewer write nothing");
}

#[tokio::test]
async fn the_export_relays_the_apis_csv_to_staff_who_may_export() {
    let pilot = Pilot::new().await;
    let (status, headers, body) =
        pilot.send(get("/support/platform-feedback/export?status=new&topic=bogus", Some("feedback-manager"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert_eq!(headers[header::CONTENT_DISPOSITION], r#"attachment; filename="chase-sets-platform-feedback.csv""#);
    assert!(body.starts_with("\"feedback_id\""), "{body}");
    assert_eq!(pilot.calls_to(FEEDBACK).last().unwrap().path, format!("{FEEDBACK}/export?status=new"));
    let (status, _, _) = pilot.send(get("/support/platform-feedback/export", Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_feedbacks_page_shows_it_and_offers_what_its_status_allows() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/platform-feedback/pfb_1", Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "Feedback pfb_1",
        "Offer tracking is useful.",
        "/account/offers/submitted/off_1",
        "Asked the seller.",
        "usr_ops at May 8, 2026, 9:30 AM UTC",
        "offer: off_1",
        "mystery: x_1",
        "<dd>Yes</dd>",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(!html.contains(r#"value="review""#) && !html.contains("record-note"), "a viewer changes nothing: {html}");
    let (_, _, html) = pilot.send(get("/support/platform-feedback/pfb_1", Some("feedback-manager"))).await;
    assert!(html.contains(r#"value="review""#) && html.contains(r#"value="archive""#), "a new one: {html}");
    assert!(html.contains(r#"value="record-note""#), "{html}");
    let (_, _, html) = pilot.send(get("/support/platform-feedback/pfb_2", Some("feedback-manager"))).await;
    assert!(!html.contains(r#"value="review""#) && !html.contains(r#"value="archive""#), "an archived one: {html}");
    let (status, _, _) = pilot.send(get("/support/platform-feedback/pfb_none", Some("feedback-viewer"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_feedbacks_writes_are_sent_and_its_page_is_read_after_them() {
    let pilot = Pilot::new().await;
    let at = "/support/platform-feedback/pfb_1";
    let (status, headers, _) = pilot.send(post_as("feedback-manager", at, "intent=record-note&body=Called+back", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/support/platform-feedback/pfb_1?after_write="), "{to}");
    let write = pilot.calls_to(FEEDBACK).into_iter().last().unwrap();
    assert_eq!((write.path.as_str(), write.body.as_str()), (&*format!("{FEEDBACK}/pfb_1/notes"), r#"{"body":"Called back"}"#));
    let (_, headers, _) = pilot.send(post_as("feedback-manager", at, "intent=review", false)).await;
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/support/platform-feedback/pfb_1?after_write="));
    let write = pilot.calls_to(FEEDBACK).into_iter().last().unwrap();
    assert_eq!((write.path.as_str(), write.body.as_str()), (&*format!("{FEEDBACK}/pfb_1/review"), "{}"));

    let (status, headers, html) = pilot.send(post_as("feedback-manager", at, "intent=record-note&body=+", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(headers.get(header::LOCATION).is_none());
    assert!(html.contains("Operator note is required.") && html.contains(r#"role="alert""#), "{html}");
    let (status, headers, _) = pilot.send(post_as("feedback-manager", at, "intent=bogus", false)).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, at));
    assert_eq!(pilot.send(post_as("feedback-viewer", at, "intent=review", false)).await.0, StatusCode::FORBIDDEN);

    let lagging = format!("{at}?after_write={}", fresh_receipt());
    let (status, _, html) = pilot.send(get(&lagging, Some("feedback-lag"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"role="status""#) && html.contains("Refresh in a moment"), "{html}");
}

#[tokio::test]
async fn support_requests_reads_the_queue_with_the_filters_admin_web_offers() {
    let pilot = Pilot::new().await;
    let at = "/support/requests?status=ready-for-support&priority=bogus&flowType=product-damaged";
    let (status, _, html) = pilot.send(get(at, Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let mut paths: Vec<String> = pilot.calls_to(SUPPORT_REQUESTS).into_iter().map(|c| c.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            format!("{SUPPORT_REQUESTS}/flows"),
            format!("{SUPPORT_REQUESTS}/ops?limit=50&offset=0&status=ready-for-support&flowType=product-damaged"),
        ],
        "an unknown priority is all of them"
    );
    for text in ["SUP-1042", "req_2", "Damaged product", "Status: Ready for support", "1/2", "Showing 2 of 3"] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"<option value="product-damaged" selected>Damaged product</option>"#), "{html}");
    assert!(
        html.contains(r#"href="/support/requests?status=ready-for-support&amp;flowType=product-damaged&amp;requestId=req_1""#),
        "{html}"
    );
    assert!(html.contains(r#"aria-current="page">Ready for support</a>"#), "the status tab: {html}");
    assert!(html.contains(r#"href="/support/requests" aria-current="page""#), "the nav serves it: {html}");
    assert!(!html.contains("<dialog"), "no sheet without a request: {html}");
    assert_eq!(pilot.send(get("/support/requests", Some("feedback-viewer"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_requests_sheet_shows_the_case_and_recommends_what_admin_web_would() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/support/requests?requestId=req_1", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in
        ["<dialog", "Crushed corner.", "Called the carrier.", "Packed in a toploader.", "Ten back.", "acc_buyer / acc_seller"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"name="intent" value="resolve""#), "ready for support recommends Resolve: {html}");
    assert!(html.contains(r#"value="10.00""#), "the latest offer within the ceiling: {html}");
    assert!(html.contains("56.83"), "the ceiling: {html}");
    assert!(html.contains(r#"value="seller|product-damaged.seller-inadequate-packaging""#), "{html}");
    assert!(html.contains(r#"<option value="partial-refund">"#) && !html.contains(r#"<option value="replacement">"#), "{html}");
    assert!(html.contains(r#"src="/support/requests/req_1/attachments/sea_abc123""#), "{html}");
    assert_eq!(
        html.matches("/attachments/").count(),
        4,
        "one photo, twice (trail and position), each an image and a link: {html}"
    );
    assert!(html.contains(r#"value="cancel""#) && !html.contains(r#"value="close""#), "an open request: {html}");

    let (status, headers, _) = pilot.send(get("/support/requests/req_1?status=open", Some("support-agent"))).await;
    assert_eq!(
        (status, headers[header::LOCATION].to_str().unwrap()),
        (StatusCode::SEE_OTHER, "/support/requests?status=open&requestId=req_1")
    );

    let (status, _, html) = pilot.send(get("/support/requests?requestId=req_done", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Refunded five.") && html.contains("Refund still settling"), "{html}");
    assert!(html.contains(r#"value="close""#) && !html.contains(r#"value="cancel""#), "a resolved request: {html}");
    let origin = crate::app::admin_web_origin();
    assert!(html.contains(&format!(r#"href="{origin}/support/requests?requestId=req_done""#)), "the remedy on admin-web: {html}");

    let (status, _, html) = pilot.send(get("/support/requests?requestId=req_none", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(!html.contains("<dialog") && html.contains(r#"role="alert""#), "{html}");
}

#[tokio::test]
async fn a_case_action_is_sent_and_the_sheet_is_read_after_it() {
    let pilot = Pilot::new().await;
    let at = "/support/requests/req_1?status=ready-for-support";
    let form = "intent=resolve&summary=Refund+the+damage&resolutionType=partial-refund&refundAmount=10.00&responsibilityFinding=seller%7Cproduct-damaged.seller-inadequate-packaging&evidenceBasisType=operator-finding";
    let (status, headers, _) = pilot.send(post_as("support-agent", at, form, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/support/requests?status=ready-for-support&requestId=req_1&action=resolve&after_write="), "{to}");
    let write = pilot.calls_to(SUPPORT_REQUESTS).into_iter().last().unwrap();
    assert_eq!(write.path, format!("{SUPPORT_REQUESTS}/ops/req_1/resolve"));
    assert_eq!(
        serde_json::from_str::<Value>(&write.body).unwrap(),
        json!({
            "resolutionType": "partial-refund", "summary": "Refund the damage", "refundAmount": "10.00",
            "responsibility": "seller", "responsibilityReasonCode": "product-damaged.seller-inadequate-packaging",
            "evidenceBasis": { "type": "operator-finding", "reference": "support-workbench.operator-adjudication.v1" },
        })
    );
    let (status, _, html) = pilot.send(get(&to, Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(pilot.calls_to(SUPPORT_REQUESTS).iter().any(|c| c.headers.contains_key("chase-sets-read-after-write")));

    let (_, _, _) = pilot.send(post_as("support-agent", at, "intent=note&summary=Called", false)).await;
    let write = pilot.calls_to(SUPPORT_REQUESTS).into_iter().last().unwrap();
    assert_eq!(write.path, format!("{SUPPORT_REQUESTS}/ops/req_1/evidence"));
    assert_eq!(
        serde_json::from_str::<Value>(&write.body).unwrap(),
        json!({ "evidenceType": "support-note", "summary": "Called" })
    );

    let (status, headers, html) =
        pilot.send(post_as("support-agent", at, "intent=resolve&summary=+&resolutionType=full-refund", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(headers.get(header::LOCATION).is_none());
    assert!(html.contains("A resolution summary is required.") && html.contains("<dialog"), "the sheet says why: {html}");
    let writes = pilot.calls_to(SUPPORT_REQUESTS).into_iter().filter(|c| c.method == Method::POST).count();
    let (status, headers, _) = pilot.send(post_as("support-agent", at, "intent=remedy-approve", false)).await;
    assert_eq!(
        (status, headers[header::LOCATION].to_str().unwrap()),
        (StatusCode::SEE_OTHER, "/support/requests?status=ready-for-support&requestId=req_1")
    );
    assert_eq!(pilot.send(post_as("feedback-viewer", at, "intent=note&summary=x", false)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        pilot.calls_to(SUPPORT_REQUESTS).into_iter().filter(|c| c.method == Method::POST).count(),
        writes,
        "nothing more written"
    );

    let lagging = format!("/support/requests?requestId=req_1&action=note&after_write={}", fresh_receipt());
    let (status, _, html) = pilot.send(get(&lagging, Some("support-lag"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Called the carrier.") && html.contains("Refresh in a moment"), "read without the receipt: {html}");
}

#[tokio::test]
async fn escalate_overdue_reports_its_counts_on_the_queue() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot.send(post_as("support-agent", "/support/requests?status=open", "", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let to = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(to.starts_with("/support/requests?status=open&after_write="), "{to}");
    assert!(to.ends_with("&escalated=2&skipped=1&capped=true&escalationTotal=120"), "{to}");
    let write = pilot.calls_to(SUPPORT_REQUESTS).into_iter().last().unwrap();
    assert_eq!(
        (write.path.as_str(), write.body.as_str()),
        (&*format!("{SUPPORT_REQUESTS}/ops/escalate-overdue"), r#"{"limit":100}"#)
    );
    let (status, _, html) = pilot.send(get(&to, Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"role="status""#) && html.contains("120"), "{html}");
}

#[tokio::test]
async fn an_evidence_photo_is_relayed_to_staff() {
    let pilot = Pilot::new().await;
    let (status, headers, body) = pilot.send(get("/support/requests/req_1/attachments/sea_abc123", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(headers[header::CACHE_CONTROL], "private, max-age=300");
    assert_eq!(body, "jpeg");
    assert_eq!(
        pilot.send(get("/support/requests/req_1/attachments/sea_none", Some("support-agent"))).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        pilot.send(get("/support/requests/req_1/attachments/sea_abc123", Some("feedback-viewer"))).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_ebay_lookup_shows_the_counts_and_a_user_ids_unexpired_receipts() {
    let pilot = Pilot::new().await;
    let (status, headers, html) = pilot.send(get("/support/ebay-account-deletion", Some("support-agent"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(html.contains("Non-disconnected connections: 2. Credential envelopes: 0."), "{html}");
    assert!(
        html.contains(r#"<form class="#) && html.contains(r#"method="post" action="/support/ebay-account-deletion""#),
        "{html}"
    );
    assert!(html.contains(r#"name="userId""#) && html.contains(r#"maxlength="1024""#), "{html}");
    assert!(!html.contains("Unexpired receipts") && !html.contains(r#"role="alert""#), "{html}");
    assert!(html.contains(r#"href="/support/ebay-account-deletion" aria-current="page""#), "the nav serves it: {html}");

    let at = "/support/ebay-account-deletion";
    let (status, headers, html) = pilot.send(post_as("support-agent", at, "userId=ebay-user-1", false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(html.contains("ntf_1") && html.contains("Unexpired receipts") && html.contains("Credential envelopes: 0."), "{html}");
    assert!(!html.contains("ebay-user-1"), "the user ID is not echoed back: {html}");
    let lookup = pilot.calls_to(EBAY_DELETION).into_iter().find(|c| c.method == Method::POST).unwrap();
    assert_eq!(
        (lookup.path.as_str(), lookup.body.as_str()),
        (&*format!("{EBAY_DELETION}/lookup"), r#"{"userId":"ebay-user-1"}"#)
    );

    let (status, _, html) = pilot.send(post_as("support-agent", at, "userId=nobody", false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("No unexpired receipt matches"), "{html}");
    let (status, _, html) = pilot.send(post_as("support-agent", at, "userId=slow", false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(
        html.contains(r#"role="alert""#) && html.contains("Lookup unavailable") && html.contains("Credential envelopes"),
        "{html}"
    );
    let (status, _, html) = pilot.send(post_as("support-agent", at, "userId=", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");

    assert_eq!(pilot.send(get(at, Some("feedback-viewer"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(pilot.send(post_as("feedback-viewer", at, "userId=ebay-user-1", false)).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_feedback_attention_queue_shows_its_figures_and_each_cases_sla() {
    let pilot = Pilot::new().await;
    let at = "/support/customer-feedback/attention";
    let (status, _, html) = pilot.send(get(at, Some("support-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "<dd>2</dd>",
        "<dd>1</dd>",
        "<dd>2 hours</dd>",
        "<dd>3</dd>",
        "fbcase_1",
        "1/5",
        "SLA breached",
        "Jan 1, 2099, 12:00 PM UTC",
        "usr_ops",
        "Unassigned",
        "sent / not-requested",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert_eq!(html.matches("SLA breached").count(), 1, "the triaged case is within its due date: {html}");
    assert!(!html.contains("caseId="), "no link to the same queue (chase-sets/chase-sets#10854): {html}");
    assert!(html.contains(r#"href="/support/customer-feedback/attention" aria-current="page""#), "the nav serves it: {html}");
    assert_eq!(pilot.calls_to("/api/customer-feedback/attention").len(), 1);

    assert_eq!(pilot.send(get(at, Some("attention-down"))).await.0, StatusCode::BAD_GATEWAY);
    assert_eq!(pilot.send(get(at, Some("support-agent"))).await.0, StatusCode::FORBIDDEN, "admin-web's route needs support.view");
}

const RETURN_INTAKE: &str = "/api/marketplace/operations/return-intake";

/// Fulfillment's return intake for facility `fac_1`: a delivered package waiting, an unidentified
/// package awaiting reconciliation and one reconciled, and the figures. `RS-1` resolves to
/// `rsh_1` (version 3, not received), `RS-DONE` to `rsh_done` (quarantined), anything else to
/// nothing. A completion citing version 2 is stale; each photo answers an attachment named after
/// its file.
fn return_intake(method: &Method, rest: &str, query: &str, body: &str) -> Response {
    let shipment = |id: &str, intake: Value| {
        json!({
            "return_shipment_id": id, "order_id": "ord_1", "status": "delivered", "tracking_identifier": "9400TRACK1",
            "delivered_at": "2026-10-29T15:00:00.000Z", "received_at": null,
            "expected_items": [{ "item_title": "Sleeved Booster", "quantity": 2 }],
            "package_requirements": { "weightOunces": 6, "lengthInches": 9, "widthInches": 6, "heightInches": 2 },
            "destination_snapshot": { "displayInstructions": "Hold sealed product at the cage." },
            "facility_intake": intake,
        })
    };
    match (method.clone(), rest) {
        (Method::GET, "") if query == "facilityId=fac_1" => Json(json!({
            "items": [shipment("rsh_1", Value::Null)],
            "unidentified": [
                { "unidentified_package_id": "uip_1", "custody_identifier": "CUST-UNK-1", "received_at": "2026-10-29T16:00:00.000Z",
                  "package_condition": "damaged", "return_shipment_id": null },
                { "unidentified_package_id": "uip_2", "custody_identifier": "CUST-UNK-2", "received_at": "2026-10-28T16:00:00.000Z",
                  "package_condition": "intact", "return_shipment_id": "rsh_old" },
            ],
            "metrics": {
                "delivered_not_intaken_count": 4, "oldest_delivered_not_intaken_age_seconds": 7200.0, "discrepancy_rate": 0.25,
                "unidentified_package_count": 1, "duplicate_scan_count": 3, "average_intake_latency_seconds": 150.0,
            },
        }))
        .into_response(),
        (Method::GET, "/resolve") if query == "identifier=RS-1&facilityId=fac_1" => {
            Json(json!({ "shipment": shipment("rsh_1", Value::Null), "version": 3 })).into_response()
        }
        (Method::GET, "/resolve") if query == "identifier=RS-DONE&facilityId=fac_1" => Json(json!({
            "shipment": shipment("rsh_done", json!({ "custodyIdentifier": "CUST-77", "disposition": "quarantine" })),
            "version": 5,
        }))
        .into_response(),
        (Method::GET, "/resolve") => refusal(StatusCode::NOT_FOUND, "return_shipment_not_found", "No return shipment matched."),
        (Method::POST, "/evidence") => {
            let file = body.split("filename=\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("none");
            Json(json!({ "attachment": { "attachmentId": format!("att_{file}"), "fileName": file } })).into_response()
        }
        (Method::POST, "/rsh_1/complete") if body.contains(r#""expectedVersion":2"#) => {
            refusal(StatusCode::CONFLICT, "version_conflict", "The return shipment changed.")
        }
        (Method::POST, "/rsh_1/complete") if body.contains(r#""custodyIdentifier":"CUST-REFUSED""#) => {
            refusal(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "Custody identifier is already in use.")
        }
        (Method::POST, "/rsh_1/complete" | "/rsh_done/corrections" | "/unidentified" | "/unidentified/uip_1/reconcile") => {
            written(StatusCode::OK, "rsh_1")
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// Catalog > Scope Sync Batches.

const QUOTE_ID: &str = "8d0f6a4e-4f1e-4c1f-9a51-3c2b9f0a7e11";

fn sync_preview(ready: bool) -> Value {
    json!({
        "previewVersion": "scope-sync-batch-preview-v1",
        "selection": { "mode": "matching-scope", "query": { "productDomain": "pokemon", "scopeKind": "set", "languageCode": "en" } },
        "budget": {
            "maxScopesPerTurn": 1, "defaultProviderConcurrency": 1, "providerConcurrency": { "scrydex": 1 },
            "providerRequestLimits": { "tcgdex": 1000, "scrydex": 1000 }, "creditedProviderRequestLimits": { "scrydex": 0 },
            "providerFailureThreshold": 3
        },
        "planFingerprint": "plan_abc",
        "status": if ready { "ready" } else { "blocked" },
        "confirmAllowed": ready,
        "counts": { "scopes": 2, "readyScopes": if ready { 2 } else { 1 }, "blockedScopes": if ready { 0 } else { 1 }, "providerUnits": 3 },
        "providerUnitTotals": { "tcgdex": 2, "scrydex": 1 },
        "providerRequestEstimates": { "tcgdex": 40, "scrydex": null },
        "samples": [{
            "scopeRecordId": "scp_paf", "providerUnitCount": 2, "blockerCount": 0, "estimatedRequestCount": 40,
            "providerKeys": ["tcgdex", "scrydex"],
            "mappingVersions": [{ "mappingId": "map_1", "version": "3", "reviewStatus": "accepted" }],
            "profileVersions": [{ "providerKey": "tcgdex", "unitKey": "cards", "profileKey": "default", "profileVersion": "2" }]
        }],
        "blockers": if ready { json!([]) } else { json!([{ "code": "mapping-missing", "scopeRecordId": "scp_x", "providerKey": null, "message": "No accepted mapping." }]) },
        "resolvedAt": "2026-10-31T12:00:00.000Z"
    })
}

fn sync_batch(status: &str) -> Value {
    json!({
        "batchId": "ssb_1", "status": status, "fastNoOp": false, "circuitOpenProviders": if status == "running" { json!(["scrydex"]) } else { json!([]) },
        "counts": { "queued": 0, "running": 1, "completed": 1, "failed": 1, "cancelled": 0 },
        "units": [
            { "scopeRecordId": "scp_paf", "state": "completed", "syncRunId": "run_1", "providerKeys": ["tcgdex"], "attemptCount": 1, "errorMessage": null, "updatedAt": "2026-10-31T12:00:00.000Z" },
            { "scopeRecordId": "scp_sv1", "state": "failed", "syncRunId": null, "providerKeys": ["scrydex"], "attemptCount": 2, "errorMessage": "x", "updatedAt": "2026-10-31T12:00:00.000Z" }
        ],
    })
}

fn sync_quote(state: &str) -> Value {
    json!({
        "quoteId": QUOTE_ID, "fingerprint": "f".repeat(64), "membershipFingerprint": "m",
        "selection": { "mode": "ids", "scopeRecordIds": ["scp_paf"] },
        "authority": { "fingerprint": "a", "headroom": 100, "allowed": true },
        "targets": [
            { "scopeRecordId": "scp_paf", "query": { "kind": "cards" }, "source": null, "blocked": false },
            { "scopeRecordId": "scp_paf", "query": { "kind": "sealed" }, "source": { "observedAt": "2026-10-30T00:00:00.000Z" }, "blocked": false }
        ],
        "plannedCredits": 1, "cap": 5, "expiresAt": "2026-10-31T13:00:00.000Z", "state": state
    })
}

/// The scope sync batch API. A count command without the browser's origin is refused, as the
/// API refuses one from another origin.
fn sync_batches_api(method: &Method, rest: &str, headers: &HeaderMap, body: &str) -> Response {
    let same_origin = headers.get(header::ORIGIN).is_some_and(|o| o == "http://localhost:7790");
    match (method.clone(), rest) {
        (Method::POST, "/preview") if body.contains("scp_down") => refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Failed."),
        (Method::POST, "/preview") if body.contains(r#""mode":"ids","scopeRecordIds":[]"#) => {
            refusal(StatusCode::BAD_REQUEST, "invalid_request", "Selection is empty.")
        }
        (Method::POST, "/preview") => Json(sync_preview(!body.contains("scp_x"))).into_response(),
        (Method::POST, "/confirm") if body.contains(r#""planFingerprint":"stale""#) => {
            refusal(StatusCode::CONFLICT, "scope_sync_batch_stale_preview", "The preview is stale.")
        }
        (Method::POST, "/confirm") => (StatusCode::ACCEPTED, Json(sync_batch("queued"))).into_response(),
        (Method::POST, "/counts/quote" | "/counts/acquire") if !same_origin => refusal(StatusCode::FORBIDDEN, "forbidden", ""),
        (Method::POST, "/counts/quote") => Json(sync_quote("quoted")).into_response(),
        (Method::POST, "/counts/acquire") => Json(sync_quote("complete")).into_response(),
        (Method::GET, path) if path == format!("/counts/quote/{QUOTE_ID}") => Json(sync_quote("quoted")).into_response(),
        (Method::POST, "/resolve-held-sets") => Json(json!({
            "resolved": [{ "scopeRecordId": "scp_paf", "productDomain": "pokemon", "scopeKind": "set", "productLine": "Pokemon", "setName": "Paldean Fates", "rowCount": 12 }],
            "unresolved": [{ "productLine": "Pokemon", "setName": "Mystery", "rowCount": 2, "reason": "set-unresolved", "productDomain": "pokemon" }],
            "totals": { "rows": 14, "distinctPairs": 2, "resolvedPairs": 1, "unresolvedPairs": 1, "resolvedRows": 12, "unresolvedRows": 2 }
        }))
        .into_response(),
        (Method::GET, "/ssb_1") => Json(sync_batch("running")).into_response(),
        (Method::GET, "/ssb_done") => Json(json!({ "batchId": "ssb_done", "status": "completed", "fastNoOp": true, "circuitOpenProviders": [], "counts": {}, "units": [] })).into_response(),
        (Method::POST, "/ssb_1/cancel" | "/ssb_1/resume" | "/ssb_1/units/scp_sv1/retry") => Json(sync_batch("cancelled")).into_response(),
        (_, _) => refusal(StatusCode::NOT_FOUND, "not_found", "Scope Sync Batch not found."),
    }
}

impl Pilot {
    fn sync_calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with("/api/catalog/scope-sync-batches")).cloned().collect()
    }
}

#[tokio::test]
async fn the_sync_batch_page_offers_its_forms_to_who_may_write_and_follows_a_running_batch() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/catalog/scopes/sync-batches", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        html.contains("<h1")
            && html.contains("Scope Sync Batches")
            && html.contains("<title>Scope Sync Batches | Catalog admin</title>"),
        "{html}"
    );
    assert!(html.contains("/sections/catalog.css"), "the catalog area's stylesheet: {html}");
    assert!(
        html.contains(r#"action="/catalog/scopes/sync-batches/held-sets""#) && html.contains(r#"enctype="multipart/form-data""#),
        "{html}"
    );
    assert!(html.contains(r#"name="selection_mode""#) && html.contains(r#"<option value="matching-scope" selected>"#), "{html}");
    assert!(html.contains(r#"name="tcgdex_request_limit" value="1000""#), "admin-web's defaults: {html}");
    assert!(pilot.sync_calls().is_empty(), "nothing is read without a batch or quote");

    // A running batch: its progress, Cancel, the circuit notice, Retry on the failed unit, and
    // the page read again in two seconds.
    let (status, _, html) = pilot.send(get("/catalog/scopes/sync-batches?batch_id=ssb_1", Some("staff"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("1 completed · 1 failed · 1 running · 0 queued"), "{html}");
    assert!(html.contains(r#"name="intent" value="cancel""#) && html.contains("Cancel batch"), "{html}");
    assert!(html.contains("New work is paused for: scrydex."), "{html}");
    assert!(
        html.contains(r#"name="scope_record_id" value="scp_sv1""#) && !html.contains(r#"name="scope_record_id" value="scp_paf""#),
        "{html}"
    );
    assert!(html.contains(r#"http-equiv="refresh""#) || html.contains("corten-read-again"), "read again while it runs: {html}");

    // A settled batch: Already settled, nothing to cancel, not read again.
    let (_, _, html) = pilot.send(get("/catalog/scopes/sync-batches?batch_id=ssb_done", Some("staff"))).await;
    assert!(html.contains("Already settled") && !html.contains("Cancel batch"), "{html}");
    assert!(!html.contains(r#"http-equiv="refresh""#) && !html.contains("corten-read-again"), "{html}");

    // A viewer sees the batch without the forms or its commands.
    let (status, _, html) = pilot.send(get("/catalog/scopes/sync-batches?batch_id=ssb_1", Some("catalog-viewer"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!html.contains("held-sets") && !html.contains("Cancel batch") && !html.contains("Retry unit"), "{html}");
    let (status, _, _) = pilot.send(get("/catalog/scopes/sync-batches?batch_id=gone", Some("staff"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = pilot.send(get("/catalog/scopes/sync-batches", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn preview_shows_the_plan_and_confirm_sends_it_back_and_follows_the_batch() {
    let pilot = Pilot::new().await;
    let form = "intent=preview&selection_mode=matching-scope&product_domain=pokemon&scope_kind=set&language_code=en&scope_record_ids=                &max_scopes_per_turn=1&default_provider_concurrency=1&scrydex_concurrency=1&tcgdex_request_limit=1000                &scrydex_rate_request_limit=1000&scrydex_request_limit=0&provider_failure_threshold=3&count_cap=0";
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", form, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent = pilot.sync_calls().pop().unwrap();
    assert_eq!(sent.path, "/api/catalog/scope-sync-batches/preview");
    let body: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!(
        body["selection"],
        json!({ "mode": "matching-scope", "query": { "productDomain": "pokemon", "scopeKind": "set", "languageCode": "en" } })
    );
    assert_eq!(body["budget"]["providerRequestLimits"], json!({ "tcgdex": 1000, "scrydex": 1000 }));
    assert!(html.contains("Batch is ready") && html.contains("2 ready scopes, 0 blocked scopes, 3 provider units."), "{html}");
    assert!(
        html.contains("plan_abc")
            && html.contains("tcgdex units / requests")
            && html.contains("2 / 40")
            && html.contains("1 / Unavailable"),
        "{html}"
    );
    assert!(html.contains("map_1@3") && html.contains("tcgdex/default@2"), "{html}");
    assert!(
        html.contains(r#"name="intent" value="confirm""#) && html.contains(r#"name="plan_fingerprint" value="plan_abc""#),
        "{html}"
    );

    // Confirm sends the preview's selection, budget and plan, and goes to the batch.
    let confirm = "intent=confirm&plan_fingerprint=plan_abc&selection_mode=matching-scope&product_domain=pokemon&scope_kind=set                   &language_code=en&max_scopes_per_turn=1&default_provider_concurrency=1&scrydex_concurrency=1                   &tcgdex_request_limit=1000&scrydex_rate_request_limit=1000&scrydex_request_limit=0&provider_failure_threshold=3";
    let (status, headers, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", confirm, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert_eq!(headers[header::LOCATION], "/catalog/scopes/sync-batches?batch_id=ssb_1");
    let sent = pilot.sync_calls().pop().unwrap();
    let body: Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!(
        (sent.path.as_str(), body["planFingerprint"].as_str()),
        ("/api/catalog/scope-sync-batches/confirm", Some("plan_abc"))
    );

    // A blocked preview: its blockers, no Confirm. A stale confirm is the banner, the form kept.
    let blocked = form
        .replace("selection_mode=matching-scope", "selection_mode=ids")
        .replace("scope_record_ids=", "scope_record_ids=scp_paf,scp_x");
    let (_, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", &blocked, false)).await;
    assert!(
        html.contains("Batch needs attention") && html.contains("mapping-missing") && !html.contains(r#"value="confirm""#),
        "{html}"
    );
    let stale = confirm.replace("plan_abc", "stale");
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", &stale, false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(html.contains("Batch command blocked") && html.contains("The preview is stale."), "{html}");
    // An empty selection is the API's message; a failed preview is a 502 with the pilot's words.
    let empty = form.replace("selection_mode=matching-scope", "selection_mode=ids");
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", &empty, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(
        html.contains("Selection is empty.") && html.contains(r#"<option value="ids" selected>"#),
        "the form as it was sent: {html}"
    );
    let down = form
        .replace("selection_mode=matching-scope", "selection_mode=ids")
        .replace("scope_record_ids=", "scope_record_ids=scp_down");
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", &down, false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains("could not run the scope sync batch command"), "{html}");
}

#[tokio::test]
async fn batch_commands_go_to_the_batch_and_count_commands_carry_the_browsers_origin() {
    let pilot = Pilot::new().await;
    for (fields, api) in [
        ("intent=cancel&batch_id=ssb_1", "/ssb_1/cancel"),
        ("intent=resume&batch_id=ssb_1", "/ssb_1/resume"),
        ("intent=retry-unit&batch_id=ssb_1&scope_record_id=scp_sv1", "/ssb_1/units/scp_sv1/retry"),
    ] {
        let (status, headers, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", fields, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{fields}: {html}");
        assert_eq!(headers[header::LOCATION], "/catalog/scopes/sync-batches?batch_id=ssb_1");
        assert_eq!(pilot.sync_calls().pop().unwrap().path, format!("/api/catalog/scope-sync-batches{api}"));
    }
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", "intent=cancel", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Batch id is required."), "{html}");

    // Quote: the browser's origin goes along, and the quote is drawn with Approve.
    let quote = "intent=count-quote&selection_mode=ids&scope_record_ids=scp_paf&count_cap=5";
    let mut req = post_as("staff", "/catalog/scopes/sync-batches", quote, false);
    req.headers_mut().insert(header::ORIGIN, "http://localhost:7790".parse().unwrap());
    let (status, _, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent = pilot.sync_calls().pop().unwrap();
    assert_eq!(sent.headers[header::ORIGIN], "http://localhost:7790");
    assert_eq!(
        serde_json::from_str::<Value>(&sent.body).unwrap(),
        json!({ "selection": { "mode": "ids", "scopeRecordIds": ["scp_paf"] }, "cap": 5 })
    );
    assert!(html.contains("Scrydex count quote") && html.contains("Approve count acquisition"), "{html}");
    assert!(html.contains(&format!(r#"href="/catalog/scopes/sync-batches?quote_id={QUOTE_ID}""#)), "the retained quote: {html}");
    // Without the origin the API refuses it, and the page says so.
    let (status, _, html) = pilot.send(post_as("staff", "/catalog/scopes/sync-batches", quote, false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{html}");
    assert!(html.contains("Batch command blocked"), "{html}");
    // The retained quote's address reads it.
    let (status, _, html) = pilot.send(get(&format!("/catalog/scopes/sync-batches?quote_id={QUOTE_ID}"), Some("staff"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Planned credits") && html.contains(r#"name="count_fingerprint""#), "{html}");
}

#[tokio::test]
async fn a_held_set_export_is_sent_on_and_its_scopes_can_be_previewed() {
    let pilot = Pilot::new().await;
    let csv = b"Product Line,Set Name
Pokemon,Paldean Fates
";
    let req =
        post_multipart("/catalog/scopes/sync-batches/held-sets", "staff", None, &[], &[("file", "live.csv", "text/csv", csv)]);
    let (status, _, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent = pilot.sync_calls().pop().unwrap();
    assert_eq!(sent.path, "/api/catalog/scope-sync-batches/resolve-held-sets");
    assert!(sent.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("multipart/form-data"), "{:?}", sent.headers);
    assert!(
        sent.body.contains(r#"name="file"; filename="live.csv""#) && sent.body.contains("Pokemon,Paldean Fates"),
        "{}",
        sent.body
    );
    assert!(html.contains("1 resolved pairs and 1 unresolved pairs across 14 rows."), "{html}");
    assert!(html.contains("Pokemon / Paldean Fates") && html.contains("set-unresolved"), "{html}");
    assert!(html.contains(r#"href="/catalog/scope-coverage?product_domain=pokemon""#), "the inbox for its domain: {html}");
    assert!(html.contains(r#"name="scope_record_ids" value="scp_paf""#) && html.contains("Preview resolved sets"), "{html}");
    // No file: the page says to choose one.
    let req = post_multipart("/catalog/scopes/sync-batches/held-sets", "staff", None, &[], &[]);
    let (status, _, html) = pilot.send(req).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Choose a held-set export CSV."), "{html}");
}

/// A multipart form post, as a browser sends the station's forms: `fields`, then `files` as
/// (input name, filename, type, bytes), from a browser in `zone` when one is given.
fn post_multipart(
    uri: &str,
    session: &str,
    zone: Option<&str>,
    fields: &[(&str, &str)],
    files: &[(&str, &str, &str, &[u8])],
) -> Request<Body> {
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
    let cookie = match zone {
        Some(zone) => format!("chase_sets_session={session}; corten-zone={zone}"),
        None => format!("chase_sets_session={session}"),
    };
    Request::post(uri)
        .header(header::HOST, "localhost:7790")
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(body))
        .unwrap()
}

/// A complete intake's fields for `rsh_1` at `version`, received at `received_at`.
fn intake_fields<'a>(version: &'a str, received_at: &'a str, custody: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("intent", "complete"),
        ("returnShipmentId", "rsh_1"),
        ("facilityId", "fac_1"),
        ("expectedVersion", version),
        ("idempotencyKey", "rii_1"),
        ("stationId", "dock-2"),
        ("receivedAt", received_at),
        ("packageCondition", "intact"),
        ("sealCondition", "intact"),
        ("measuredWeightOunces", "6.5"),
        ("custodyIdentifier", custody),
        ("discrepancyType", "expected"),
        ("disposition", "completed"),
        ("expectedItemReference", ""),
        ("observedItemReference", ""),
        ("quantity", "2"),
        ("owner", "Facility operations"),
        ("nextAction", "Complete custody handoff"),
        ("notes", ""),
    ]
}

const STATION: &str = "/commerce/return-intake";

#[tokio::test]
async fn the_return_intake_station_opens_a_facility_and_resolves_a_scan() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(STATION, Some("intake-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Choose the assigned facility") && html.contains(r#"name="facilityId""#), "{html}");
    assert!(!html.contains("Record unidentified package"), "no unidentified form before a facility: {html}");
    assert!(pilot.calls_to(RETURN_INTAKE).is_empty(), "nothing is read before a facility is open");
    assert!(html.contains(r#"href="/commerce/return-intake" aria-current="page""#), "the nav serves it: {html}");

    let (status, _, html) = pilot.send(get("/commerce/return-intake?facilityId=fac_1", Some("intake-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in
        ["<dd>4</dd>", "<dd>2h</dd>", "<dd>25%</dd>", "<dd>3</dd>", "<dd>3m</dd>", "rsh_1", "9400TRACK1", "CUST-UNK-1", "rsh_old"]
    {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains("Record unidentified package"), "an open facility offers the unidentified form: {html}");
    assert_eq!(html.matches(r#"value="reconcile""#).count(), 1, "only the unreconciled package takes Reconcile: {html}");
    assert!(html.contains(r#"enctype="multipart/form-data""#), "{html}");

    let (status, _, html) =
        pilot.send(get("/commerce/return-intake?facilityId=fac_1&identifier=RS-1", Some("intake-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "Sleeved Booster \u{d7} 2",
        "6 oz \u{b7} 9 \u{d7} 6 \u{d7} 2 in",
        "Hold sealed product at the cage.",
        "Complete facility intake",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"name="expectedVersion" value="3""#), "{html}");
    assert!(!html.contains("Record unidentified package"), "{html}");

    let (_, _, html) =
        pilot.send(get("/commerce/return-intake?facilityId=fac_1&identifier=RS-DONE", Some("intake-viewer"))).await;
    assert!(html.contains("Existing intake result") && html.contains("Record correction") && html.contains("CUST-77"), "{html}");
    assert!(html.contains("Intake routed to quarantine"), "{html}");
    assert!(!html.contains("Complete facility intake"), "a received package takes a correction, not a second intake: {html}");

    let (status, _, html) =
        pilot.send(get("/commerce/return-intake?facilityId=fac_1&identifier=NOPE", Some("intake-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Record unidentified package"), "a scan that resolves nothing offers the unidentified form: {html}");

    assert_eq!(pilot.send(get(STATION, Some("reader"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(pilot.send(get(STATION, Some("support-viewer"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn completing_an_intake_sends_each_photo_then_cites_it_at_the_operators_time() {
    let pilot = Pilot::new().await;
    let at = "/commerce/return-intake?facilityId=fac_1&identifier=RS-1";
    let photos: [(&str, &str, &str, &[u8]); 2] =
        [("evidence", "front.jpg", "image/jpeg", b"front"), ("evidence", "label.png", "image/png", b"label")];
    let fields = intake_fields("3", "2026-10-30T14:05", "CUST-1");
    let (status, headers, html) =
        pilot.send(post_multipart(at, "intake-manager", Some("America/Chicago"), &fields, &photos)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let location = headers[header::LOCATION].to_str().unwrap();
    assert!(location.starts_with("/commerce/return-intake?facilityId=fac_1&result=completed&after_write="), "{location}");
    assert!(!location.contains("identifier="), "the station again, without the scan: {location}");

    let calls = pilot.calls_to(RETURN_INTAKE);
    let evidence: Vec<_> = calls.iter().filter(|c| c.path.ends_with("/evidence")).collect();
    assert_eq!(evidence.len(), 2, "{calls:?}");
    assert!(evidence.iter().all(|c| c.body.contains("name=\"facilityId\"\r\n\r\nfac_1")), "{evidence:?}");
    assert!(evidence[0].body.contains("front.jpg") && evidence[1].body.contains("label.png"), "in order: {evidence:?}");
    let complete = calls.iter().find(|c| c.path.ends_with("/rsh_1/complete")).expect("the intake");
    let sent: Value = serde_json::from_str(&complete.body).unwrap();
    assert_eq!(sent["receivedAt"], "2026-10-30T19:05:00Z", "read in the operator's zone (chase-sets/chase-sets#10857)");
    assert_eq!(sent["evidence"][1]["attachmentId"], "att_label.png");
    assert_eq!(sent["discrepancies"][0]["evidenceAttachmentIds"], json!(["att_front.jpg", "att_label.png"]));
    assert_eq!(sent["discrepancies"][0]["quantity"], 2);
    assert_eq!(sent["measuredWeightOunces"], 6.5);
    assert_eq!(sent["expectedVersion"], 3);
    assert_eq!(sent["idempotencyKey"], "rii_1");

    let (status, _, html) = pilot.send(get(location, Some("intake-manager"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Intake completed and platform custody is recorded."), "{html}");
}

#[tokio::test]
async fn a_refused_intake_redraws_the_station_and_sends_nothing_it_should_not() {
    let pilot = Pilot::new().await;
    let at = "/commerce/return-intake?facilityId=fac_1&identifier=RS-1";
    let photo: [(&str, &str, &str, &[u8]); 1] = [("evidence", "front.jpg", "image/jpeg", b"front")];

    let (status, _, html) =
        pilot.send(post_multipart(at, "intake-manager", None, &intake_fields("2", "2026-10-30T14:05", "CUST-1"), &photo)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(html.contains("This intake form is stale") && html.contains(r#"role="alert""#), "{html}");
    assert!(html.contains("Complete facility intake"), "the scanned package is drawn again: {html}");

    let (status, _, html) = pilot
        .send(post_multipart(at, "intake-manager", None, &intake_fields("3", "2026-10-30T14:05", "CUST-REFUSED"), &photo))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Custody identifier is already in use."), "the API's words: {html}");

    let before = pilot.calls_to(RETURN_INTAKE).iter().filter(|c| c.path.ends_with("/evidence")).count();
    let (status, _, html) =
        pilot.send(post_multipart(at, "intake-manager", None, &intake_fields("3", "yesterday", "CUST-1"), &photo)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Enter the date and time the package was received."), "{html}");
    let after = pilot.calls_to(RETURN_INTAKE).iter().filter(|c| c.path.ends_with("/evidence")).count();
    assert_eq!(before, after, "no photo is sent for a time that cannot be read");

    let many: Vec<(&str, &str, &str, &[u8])> = (0..11).map(|_| ("evidence", "p.jpg", "image/jpeg", b"p" as &[u8])).collect();
    let (status, _, html) =
        pilot.send(post_multipart(at, "intake-manager", None, &intake_fields("3", "2026-10-30T14:05", "CUST-1"), &many)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{html}");
    assert!(html.contains("Send up to 10 photos of 10 MB each."), "{html}");

    let (status, _, _) =
        pilot.send(post_multipart(at, "intake-viewer", None, &intake_fields("3", "2026-10-30T14:05", "CUST-1"), &photo)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "writing needs return-intake.manage");
    assert!(
        pilot
            .calls_to(RETURN_INTAKE)
            .iter()
            .all(|c| !c.path.ends_with("/complete") || !c.body.contains("dock-2") || c.body.contains("CUST-"))
    );
}

#[tokio::test]
async fn the_station_records_unidentified_packages_reconciles_them_and_corrects_an_intake() {
    let pilot = Pilot::new().await;
    let at = "/commerce/return-intake?facilityId=fac_1";
    let photo: [(&str, &str, &str, &[u8]); 1] = [("evidence", "box.jpg", "image/jpeg", b"box")];
    let unidentified = [
        ("intent", "unidentified"),
        ("facilityId", "fac_1"),
        ("idempotencyKey", "rii_2"),
        ("stationId", "dock-2"),
        ("receivedAt", "2026-10-30T14:05"),
        ("packageCondition", "damaged"),
        ("sealCondition", "broken"),
        ("measuredWeightOunces", ""),
        ("custodyIdentifier", "CUST-UNK-3"),
        ("owner", "Facility operations"),
        ("nextAction", "Hold for review"),
        ("notes", "No label"),
    ];
    let (status, headers, html) = pilot.send(post_multipart(at, "intake-manager", None, &unidentified, &photo)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(headers[header::LOCATION].to_str().unwrap().contains("result=unidentified"));
    let calls = pilot.calls_to(RETURN_INTAKE);
    let sent: Value = serde_json::from_str(&calls.iter().find(|c| c.path.ends_with("/unidentified")).unwrap().body).unwrap();
    assert_eq!(sent["receivedAt"], "2026-10-30T14:05:00Z", "UTC when the browser has not said its zone");
    assert_eq!(sent["measuredWeightOunces"], Value::Null);
    assert_eq!(sent["evidence"][0]["attachmentId"], "att_box.jpg");

    let reconcile = [
        ("intent", "reconcile"),
        ("facilityId", "fac_1"),
        ("unidentifiedPackageId", "uip_1"),
        ("returnShipmentId", "rsh_1"),
        ("reason", "Label found"),
    ];
    let (status, headers, html) = pilot.send(post_multipart(at, "intake-manager", None, &reconcile, &[])).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(headers[header::LOCATION].to_str().unwrap().contains("result=reconciled"));
    let calls = pilot.calls_to(RETURN_INTAKE);
    let sent: Value = serde_json::from_str(&calls.iter().find(|c| c.path.ends_with("/uip_1/reconcile")).unwrap().body).unwrap();
    assert_eq!(sent, json!({ "returnShipmentId": "rsh_1", "reason": "Label found" }));

    let correct = [
        ("intent", "correct"),
        ("facilityId", "fac_1"),
        ("returnShipmentId", "rsh_done"),
        ("expectedVersion", "5"),
        ("reason", "Wrong custody label"),
        ("owner", ""),
        ("nextAction", ""),
        ("custodyIdentifier", "CUST-78"),
    ];
    let (status, headers, html) = pilot.send(post_multipart(at, "intake-manager", None, &correct, &[])).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    assert!(headers[header::LOCATION].to_str().unwrap().contains("result=corrected"));
    let calls = pilot.calls_to(RETURN_INTAKE);
    let sent: Value =
        serde_json::from_str(&calls.iter().find(|c| c.path.ends_with("/rsh_done/corrections")).unwrap().body).unwrap();
    assert_eq!(sent["expectedVersion"], 5);
    assert_eq!(sent["owner"], Value::Null);
    assert_eq!(sent["custodyIdentifier"], "CUST-78");

    let (status, _, html) =
        pilot.send(post_multipart(at, "intake-manager", None, &[("intent", "other"), ("facilityId", "fac_1")], &[])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Choose an intake action and try again."), "{html}");
}

const RECOVERED: &str = "/api/inventory/recovered-items";

/// Inventory's recovered items: one quarantined item with two evidence references and one sellable,
/// and the figures. An action on `rci_1` records it sellable; `rci_bad` is refused with the API's
/// words, `rci_down` fails, and any other item is not found.
fn recovered_items(method: &Method, rest: &str, body: &str) -> Response {
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({
            "items": [
                { "recovered_item_id": "rci_1", "status": "quarantined", "custody_identifier": "CUST-1", "catalog_item_id": null,
                  "condition_grade": null, "disposition": null, "received_at": "2026-10-29T15:00:00.000Z",
                  "evidence_references": ["ev_1", "ev_2"], "return_shipment_id": "rsh_1" },
                { "recovered_item_id": "rci_2", "status": "sellable", "custody_identifier": "CUST-2", "catalog_item_id": "cat_9",
                  "condition_grade": "near-mint", "disposition": "resell", "received_at": "2026-10-28T15:00:00.000Z",
                  "evidence_references": [] },
            ],
            "total": 2, "count": 2,
        }))
        .into_response(),
        (Method::GET, "/metrics") => Json(json!({
            "total_count": 2, "unidentified_count": 1, "quarantined_count": 1, "sellable_count": 1, "terminal_count": 0,
            "recovered_count": 1, "recovery_rate": 0.5, "average_age_hours": 30.4,
            "gross_value": "125.5", "disposition_cost": "4.25", "net_recovered_value": "121.25",
        }))
        .into_response(),
        (Method::POST, "/rci_1/actions") => {
            let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
            let status = if body.contains(r#""intent":"decide-disposition""#) { "sellable" } else { "quarantined" };
            let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
            (headers, Json(json!({ "recoveredItemId": "rci_1", "version": 4, "status": status }))).into_response()
        }
        (Method::POST, "/rci_bad/actions") => {
            refusal(StatusCode::BAD_REQUEST, "validation_failed", "Unsupported recovered value type.")
        }
        (Method::POST, "/rci_down/actions") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Recovered item not found."),
    }
}

/// An action's form body: `fields` over admin-web's empty fields.
fn recovered_body(fields: &[(&str, &str)]) -> String {
    let names = [
        "recoveredItemId",
        "intent",
        "policyVersion",
        "evidenceReferences",
        "catalogItemId",
        "productId",
        "conditionGrade",
        "outcome",
        "reviewReference",
        "legalOwner",
        "authorityKind",
        "allowedDispositions",
        "disposition",
        "targetAccountId",
        "storageLocationId",
        "reasonCode",
        "recoveryType",
        "recoveryId",
        "grossAmount",
        "costAmount",
        "currencyCode",
        "correctedReturnShipmentId",
        "canonicalRecoveredItemId",
    ];
    names
        .iter()
        .map(|name| {
            let value = fields.iter().find(|(n, _)| n == name).map_or("", |(_, v)| v);
            format!("{name}={}", percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC))
        })
        .collect::<Vec<_>>()
        .join("&")
}

const RECOVERED_PAGE: &str = "/commerce/recovered-items";

#[tokio::test]
async fn recovered_returns_shows_the_figures_the_queue_and_the_action_form() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(RECOVERED_PAGE, Some("recovery-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "Recovered returns",
        "Recovery health",
        "50%",
        ">30<",
        "Gross recovery $125.50; disposition cost $4.25; net recovery $121.25.",
        "CUST-1",
        "cat_9",
        "near-mint",
        "2 references",
        "0 references",
        "Oct 29, 2026, 3:00 PM UTC",
        "Record a custody or disposition action",
        r#"value="USD""#,
        r#"<option value="merge""#,
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    assert!(html.contains(r#"href="/commerce/recovered-items" aria-current="page""#), "the nav serves it: {html}");
    assert_eq!(pilot.calls_to(RECOVERED).len(), 2, "the list and the figures");
    assert_eq!(pilot.send(get(RECOVERED_PAGE, Some("intake-viewer"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_recovered_item_action_posts_admin_webs_body_and_reports_the_new_status() {
    let pilot = Pilot::new().await;
    let fields = [
        ("recoveredItemId", "rci_1"),
        ("intent", "decide-disposition"),
        ("policyVersion", "recovery-v1"),
        ("evidenceReferences", "ev_1, ev_2"),
        ("disposition", "resell"),
        ("reasonCode", "inspected"),
        ("currencyCode", "USD"),
    ];
    let (status, headers, html) = pilot.send(post_as("recovery-manager", RECOVERED_PAGE, &recovered_body(&fields), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let location = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(location.starts_with("/commerce/recovered-items?item=rci_1&status=sellable&after_write="), "{location}");
    let call = pilot.calls_to(RECOVERED).into_iter().find(|c| c.method == Method::POST).expect("the action");
    assert_eq!(call.path, "/api/inventory/recovered-items/rci_1/actions");
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(sent["intent"], "decide-disposition");
    assert_eq!(sent["evidenceReferences"], json!(["ev_1", "ev_2"]));
    assert_eq!(sent["reason"], "inspected");
    assert_eq!(sent["targetAccountId"], "");

    let (status, _, html) = pilot.send(get(&location, Some("recovery-manager"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Recovered item rci_1 is now sellable."), "{html}");
    let (status, _, html) = pilot.send(get(&location, Some("recovery-lag"))).await;
    assert_eq!(status, StatusCode::OK, "the page is read again without the receipt: {html}");
    assert!(html.contains("Recovered item rci_1 is now sellable."), "{html}");
}

#[tokio::test]
async fn a_refused_recovered_item_action_keeps_the_form_and_says_why() {
    let pilot = Pilot::new().await;
    let refused = |id: &'static str| {
        recovered_body(&[("recoveredItemId", id), ("intent", "record-value"), ("recoveryType", "odd"), ("grossAmount", "9.99")])
    };
    let (status, _, html) = pilot.send(post_as("recovery-manager", RECOVERED_PAGE, &refused("rci_bad"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Unsupported recovered value type.") && html.contains(r#"role="alert""#), "{html}");
    assert!(html.contains(r#"value="rci_bad""#) && html.contains(r#"value="9.99""#), "the form keeps what was sent: {html}");
    assert!(html.contains(r#"<option value="record-value" selected"#), "{html}");

    let (status, _, html) = pilot.send(post_as("recovery-manager", RECOVERED_PAGE, &refused("rci_none"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Recovered item not found."), "{html}");

    let (status, _, html) = pilot.send(post_as("recovery-manager", RECOVERED_PAGE, &refused("rci_down"), false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains("The recovered item action could not be recorded."), "{html}");

    let before = pilot.calls_to(RECOVERED).iter().filter(|c| c.method == Method::POST).count();
    let (status, _, html) = pilot
        .send(post_as(
            "recovery-manager",
            RECOVERED_PAGE,
            &recovered_body(&[("recoveredItemId", "rci_1"), ("intent", "teleport")]),
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Choose a recovered item action."), "{html}");
    let (status, _, _) = pilot
        .send(post_as(
            "recovery-manager",
            RECOVERED_PAGE,
            &recovered_body(&[("recoveredItemId", " "), ("intent", "inspect")]),
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _, _) = pilot
        .send(post_as(
            "recovery-viewer",
            RECOVERED_PAGE,
            &recovered_body(&[("recoveredItemId", "rci_1"), ("intent", "inspect")]),
            false,
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "writing needs recovered-inventory.manage");
    let after = pilot.calls_to(RECOVERED).iter().filter(|c| c.method == Method::POST).count();
    assert_eq!(before, after, "an unknown action, a missing item and a viewer reach no API");
}

const TERMS_API: &str = "/api/commercial-terms";

fn published_fee_schedule() -> Response {
    Json(json!({
        "value": {
            "label": "Standard seller terms", "marketplaceSalesFeePercentageBps": 500, "marketplaceSalesFeeFixedAmount": "0.00",
            "marketplaceSalesFeeCapAmount": "25.00", "shippingAllowancePercentageBps": 500,
        },
        "source": "policy", "documentId": "pol_1", "effectiveFrom": "2026-07-03T00:00:00.000Z", "resolvedAt": "2026-10-30T12:00:00.000Z",
    }))
    .into_response()
}

fn terms_schedule(id: &str, kind: &str, label: &str, bps: i64, from: &str, until: Option<&str>, status: &str) -> Value {
    json!({
        "schedule_id": id, "label": label, "account_type": kind, "marketplace_sales_fee_percentage_bps": bps,
        "marketplace_sales_fee_fixed_amount": "0.30", "shipping_allowance_percentage_bps": 400, "status": status,
        "effective_from": from, "effective_until": until, "created_at": from, "updated_at": from,
    })
}

/// Commercial Terms: a business schedule in effect, one scheduled for 2099, an ended personal one and
/// an inactive one; an override for `acc_1` that expires in 2099. Writes answer the new ID; a label
/// of "Refused" is refused, "Down" fails, and the viewer's writes are forbidden (by cookie, upstream).
fn commercial_terms(method: &Method, rest: &str, query: &str, body: &str) -> Response {
    let in_effect = terms_schedule("cts_now", "business", "Business 2026", 650, "2026-01-01T00:00:00.000Z", None, "active");
    let scheduled = terms_schedule("cts_next", "business", "Business 2099", 600, "2099-01-01T00:00:00.000Z", None, "active");
    let ended = terms_schedule(
        "cts_old",
        "personal",
        "Personal 2025",
        900,
        "2025-01-01T00:00:00.000Z",
        Some("2025-12-31T00:00:00.000Z"),
        "active",
    );
    let inactive = terms_schedule("cts_off", "business", "Business draft", 700, "2026-02-01T00:00:00.000Z", None, "inactive");
    let agreement = json!({
        "agreement_id": "cag_1", "account_id": "acc_1", "account_name": "Card Vault", "account_display_name": "Vault",
        "account_type": "business", "label": "Vault override", "marketplace_sales_fee_percentage_bps": 425,
        "marketplace_sales_fee_fixed_amount": "0.05", "shipping_allowance_percentage_bps": 500, "status": "active",
        "effective_from": "2026-03-01T00:00:00.000Z", "effective_until": "2099-06-01T00:00:00.000Z",
        "created_at": "2026-03-01T00:00:00.000Z", "updated_at": "2026-03-01T00:00:00.000Z",
        "history": [{ "history_id": "h1", "event_id": "e1", "event_type": "agreement.created", "actor_user_id": "usr_ops",
            "status": "active", "payload": {}, "effective_from": "2026-03-01T00:00:00.000Z", "effective_until": null,
            "recorded_at": "2026-03-01T09:00:00.000Z" }],
    });
    let written = |status: StatusCode, id: &str| {
        let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
        let headers = [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)];
        (status, headers, Json(json!({ "id": id, "version": 1 }))).into_response()
    };
    let refused_or = |ok: Response| {
        if body.contains(r#""label":"Refused""#) {
            refusal(StatusCode::BAD_REQUEST, "validation_failed", "Effective until must be after effective from.")
        } else if body.contains(r#""label":"Down""#) {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        } else {
            ok
        }
    };
    match (method.clone(), rest) {
        (Method::GET, "/schedules") if query == "limit=250&offset=0" => {
            Json(json!({ "items": [in_effect, scheduled, ended, inactive], "total": 4, "count": 4 })).into_response()
        }
        (Method::GET, "/agreements") if query == "limit=250&offset=0" => Json(json!({ "items": [agreement], "total": 1, "count": 1 })).into_response(),
        (Method::GET, "/agreements/account-options") => Json(json!({ "items": [
            { "account_id": "acc_personal", "account_name": "Binder", "display_name": "Binder Builder", "account_type": "personal" },
            { "account_id": "acc_1", "account_name": "Card Vault", "display_name": "Vault", "account_type": "business" },
        ] }))
        .into_response(),
        (Method::GET, "/schedules/cts_next") => {
            let mut s = scheduled;
            s["history"] = json!([]);
            Json(s).into_response()
        }
        (Method::GET, "/agreements/cag_1") => Json(agreement).into_response(),
        (Method::GET, "/agreements/cag_new" | "/schedules/cts_new") => {
            refusal(StatusCode::NOT_FOUND, "not_found", "Not found.")
        }
        (Method::GET, _) => refusal(StatusCode::NOT_FOUND, "not_found", "Commercial terms schedule not found."),
        (Method::POST, "/schedules") => refused_or(written(StatusCode::CREATED, "cts_new")),
        (Method::PUT, "/schedules/cts_next") => refused_or(written(StatusCode::OK, "cts_next")),
        (Method::POST, "/agreements") => refused_or(written(StatusCode::CREATED, "cag_new")),
        (Method::PUT, "/agreements/cag_1") => refused_or(written(StatusCode::OK, "cag_1")),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

const TERMS: &str = "/commerce/terms";

fn terms_body(intent: &str, extra: &[(&str, &str)], label: &str) -> String {
    let mut fields = vec![
        ("intent", intent),
        ("label", label),
        ("marketplaceSalesFeePercentageBps", "725"),
        ("marketplaceSalesFeeFixedAmount", "0.25"),
        ("shippingAllowancePercentageBps", ""),
        ("status", "active"),
        ("effectiveFrom", "2026-11-01T00:00:00.000Z"),
        ("effectiveUntil", ""),
    ];
    fields.extend_from_slice(extra);
    fields
        .iter()
        .map(|(k, v)| format!("{k}={}", percent_encoding::utf8_percent_encode(v, percent_encoding::NON_ALPHANUMERIC)))
        .collect::<Vec<_>>()
        .join("&")
}

#[tokio::test]
async fn commercial_terms_lists_the_published_schedule_and_the_active_and_scheduled_terms_in_order() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(TERMS, Some("terms-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "Existing fee locks stay fixed",
        "Published policy",
        "Standard seller terms",
        "5% + $0.00",
        "$25.00",
        "2026-07-03",
        "Effective 2099-01-01",
        "Override expires 2099-06-01",
        "Effective since 2026-01-01",
        "Schedule for business accounts",
        "Card Vault (Vault)",
        "4.25% + $0.05",
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    let order: Vec<usize> = ["Business 2099", "Vault override", "Business 2026"].iter().map(|l| html.find(l).unwrap()).collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "latest to start first: {order:?}");
    assert!(!html.contains("Personal 2025") && !html.contains("Business draft"), "ended and inactive terms are left out: {html}");
    assert!(html.contains(r#"href="/commerce/terms" aria-current="page""#), "the nav serves it: {html}");
    assert!(!html.contains("<dialog"), "no sheet: {html}");
    assert_eq!(pilot.send(get(TERMS, Some("recovery-viewer"))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_terms_sheet_compares_and_revises_and_the_old_addresses_open_it() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/commerce/terms?schedule=cts_next", Some("terms-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<dialog") && html.contains("Compare with active schedule"), "{html}");
    assert!(html.contains("Business 2026") && html.contains("6.5% + $0.30"), "compared with the schedule in effect: {html}");
    assert!(html.contains(r#"value="revise-schedule""#) && html.contains(r#"value="cts_next""#), "{html}");
    assert!(html.contains("No revisions recorded yet."), "{html}");

    let (status, _, html) = pilot.send(get("/commerce/terms?agreement=cag_1", Some("terms-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "Compare with published seller terms",
        "Account override",
        "agreement.created \u{b7} active",
        "Changed by usr_ops",
        r#"value="425""#,
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }

    let (status, _, html) = pilot.send(get("/commerce/terms?schedule=cts_missing", Some("terms-viewer"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{html}");
    assert!(html.contains("Commercial Terms unavailable") && html.contains("Commercial terms schedule not found."), "{html}");

    for (old, new) in [
        ("/commerce/terms/schedules?create=schedule", "/commerce/terms?create=schedule"),
        ("/commerce/terms/agreements", "/commerce/terms"),
        ("/commerce/terms/schedules/cts_next", "/commerce/terms?schedule=cts_next"),
        ("/commerce/terms/agreements/cag_1", "/commerce/terms?agreement=cag_1"),
        ("/commerce/terms/accounts/acc_1/agreements/new", "/commerce/terms?create=agreement&account=acc_1"),
    ] {
        let (status, headers, _) = pilot.send(get(old, Some("terms-viewer"))).await;
        assert!(status.is_redirection(), "{old}: {status}");
        assert_eq!(headers[header::LOCATION], new, "{old}");
    }
}

#[tokio::test]
async fn the_create_sheets_start_from_the_schedule_in_effect_and_write_what_admin_web_writes() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/commerce/terms?create=schedule", Some("terms-viewer"))).await;
    assert!(
        html.contains(r#"value="Business 2026""#) && html.contains(r#"value="650""#),
        "the business schedule in effect: {html}"
    );
    let (_, _, html) = pilot.send(get("/commerce/terms?create=agreement", Some("terms-viewer"))).await;
    assert!(html.contains(r#"<option value="acc_personal" selected"#), "the first account: {html}");
    assert!(
        html.contains(r#"value="Account override""#) && html.contains(r#"value="850""#),
        "no personal schedule in effect: the defaults: {html}"
    );
    assert!(!html.contains(r#"type="hidden" name="accountId""#), "the account is the save form's select: {html}");
    let (_, _, html) = pilot.send(get("/commerce/terms?create=agreement&account=acc_1", Some("terms-viewer"))).await;
    assert!(html.contains(r#"<option value="acc_1" selected"#) && html.contains(r#"value="Business 2026""#), "{html}");

    let body = terms_body("create-agreement", &[("accountId", " acc_1 ")], "New override");
    let (status, headers, html) =
        pilot.send(post_as("terms-viewer", "/commerce/terms?create=agreement&account=acc_1", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER, "{html}");
    let location = headers[header::LOCATION].to_str().unwrap().to_owned();
    assert!(location.starts_with("/commerce/terms?agreement=cag_new&after_write="), "{location}");
    let call = pilot.calls_to(TERMS_API).into_iter().find(|c| c.method == Method::POST).expect("the create");
    let sent: Value = serde_json::from_str(&call.body).unwrap();
    assert_eq!(sent["accountId"], "acc_1");
    assert_eq!(sent["marketplaceSalesFeePercentageBps"], 725.0);
    assert_eq!(sent["shippingAllowancePercentageBps"], 0, "an empty number is 0, as admin-web's Number('')");
    assert_eq!(sent["effectiveUntil"], "");

    // The new override is not readable yet: the page says so and leaves its sheet closed.
    let (status, _, html) = pilot.send(get(&location, Some("terms-lag"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("We are preparing your change.") && !html.contains("<dialog"), "{html}");

    // Review on the save form re-opens the sheet on the account chosen, writing nothing.
    let posts = pilot.calls_to(TERMS_API).into_iter().filter(|c| c.method == Method::POST).count();
    let body = terms_body("create-agreement", &[("accountId", "acc_personal"), ("review", "account")], "");
    let (status, headers, _) =
        pilot.send(post_as("terms-viewer", "/commerce/terms?create=agreement&account=acc_1", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/commerce/terms?create=agreement&account=acc_personal");
    assert_eq!(pilot.calls_to(TERMS_API).into_iter().filter(|c| c.method == Method::POST).count(), posts, "no write");

    let body = terms_body("create-schedule", &[("accountType", "enterprise")], "Enterprise");
    let (status, headers, _) = pilot.send(post_as("terms-viewer", "/commerce/terms?create=schedule", &body, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/commerce/terms?schedule=cts_new&after_write="));
    let call = pilot.calls_to(TERMS_API).into_iter().filter(|c| c.method == Method::POST).nth(1).expect("the schedule");
    assert_eq!(serde_json::from_str::<Value>(&call.body).unwrap()["accountType"], "enterprise");
}

#[tokio::test]
async fn a_refused_terms_write_keeps_its_sheet_and_what_was_sent() {
    let pilot = Pilot::new().await;
    let at = "/commerce/terms?schedule=cts_next";
    let body = terms_body("revise-schedule", &[("id", "cts_next")], "Refused");
    let (status, _, html) = pilot.send(post_as("terms-viewer", at, &body, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Change not saved") && html.contains("Effective until must be after effective from."), "{html}");
    assert!(
        html.contains("<dialog") && html.contains(r#"value="Refused""#) && html.contains(r#"value="725""#),
        "the sheet keeps what was sent: {html}"
    );
    let call = pilot.calls_to(TERMS_API).into_iter().find(|c| c.method == Method::PUT).expect("the revision");
    assert_eq!(call.path, "/api/commercial-terms/schedules/cts_next");

    let body = terms_body("revise-agreement", &[("id", "cag_1")], "Down");
    let (status, _, html) = pilot.send(post_as("terms-viewer", "/commerce/terms?agreement=cag_1", &body, false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains("Commercial Terms unavailable"), "{html}");

    let (status, _, html) = pilot.send(post_as("terms-viewer", TERMS, &terms_body("delete-everything", &[], "X"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Unknown Commercial Terms action."), "{html}");
}

const SETTLEMENT: &str = "/api/settlement";

fn payout_row(id: &str, status: &str, reference: Option<&str>, retry: Option<&str>, retries: u32) -> Value {
    json!({
        "payout_id": id, "account_id": "acc_1", "amount": "20.00", "requested_amount": "20.00", "fee_amount": "0.25",
        "net_amount": "19.75", "currency_code": "usd", "status": status, "provider_payout_reference": reference,
        "provider_status": null, "last_reconciled_at": "2026-03-24T11:10:00.000Z", "retry_count": retries,
        "next_retry_at": retry, "updated_at": "2026-03-24T11:10:00.000Z",
    })
}

fn reconciliation_job(status: &str, done: u64, result: Option<Value>) -> Value {
    json!({
        "jobId": "job_1", "jobKind": "payout-reconciliation", "status": status,
        "progress": { "phase": status, "completed": done, "total": 2, "message": null }, "result": result,
        "errorMessage": null, "createdAt": "2026-10-30T12:00:00.000Z", "updatedAt": "2026-10-30T12:00:01.000Z",
    })
}

/// Settlement: two payouts needing attention (one failed with a retry queued, one in transit),
/// one finished run, a run `job_1` still running whose stream finishes it, and a blocked
/// operator's run refused.
fn settlement(method: &Method, rest: &str, query: &str, cookie: &str) -> Response {
    let payouts = json!([
        payout_row("pyo_failed", "failed", None, Some("2026-03-24T11:25:00.000Z"), 1),
        payout_row("pyo_transit", "in-transit", Some("po_1"), None, 0),
    ]);
    match (method.clone(), rest) {
        (Method::GET, "/money-health") => Json(json!({
            "payouts_needing_attention": payouts,
            "negative_balance_accounts": [{ "account_id": "acc_neg", "negative_balance_status": "collections",
                "available_balance_amount": "-12.50", "currency_code": "usd", "negative_balance_started_at": "2026-10-01T00:00:00.000Z",
                "collections_escalated_at": null }],
            "negative_balance_total": 1,
            "reconciliation_runs": [{ "reconciliation_run_id": "rec_1", "kind": "payouts", "checked_count": 2, "reconciled_count": 0,
                "ignored_count": 0, "skipped_count": 0, "error_count": 2, "status": "completed-with-errors",
                "started_at": "2026-10-30T11:00:00.000Z", "completed_at": "2026-10-30T11:00:01.000Z" }],
            "platform_balance_forecast": { "currency_code": "usd", "available_amount": "107.91",
                "pending_payout_demand_amount": "0.00", "forecast_after_pending_demand_amount": "107.91" },
            "provider_health": { "provider_name": "stripe", "adapter_mode": "provider", "webhook_signature_required": true,
                "webhook_failure_classes": ["signature-invalid", "unknown-event"], "platform_balance_supported": true,
                "connected_account_payouts_supported": false },
        }))
        .into_response(),
        (Method::GET, "/payouts/reconciliation") => {
            let items = if query == "filter=failed" { json!([payouts[0]]) } else { payouts };
            Json(json!({ "items": items, "total": 2, "count": 2 })).into_response()
        }
        (Method::GET, "/payout-readiness") => Json(json!({
            "account_id": "acc_platform", "status": "restricted", "missing_requirements": ["external_account"],
            "provider_reference": "acct_1", "payout_destination_status": "missing", "updated_at": "2026-01-01T00:00:00.000Z",
        }))
        .into_response(),
        (Method::GET, "/payouts/provider-idempotency") if query == "limit=10" => Json(json!({ "items": [{
            "operation_key": "op_1", "provider_name": "stripe", "operation_kind": "transfer", "account_id": "acc_1",
            "payout_id": "pyo_failed", "provider_object_reference": null, "idempotency_key": "secret-key", "created_at": "2026-03-24T11:00:00.000Z",
        }], "total": 1, "count": 1 }))
        .into_response(),
        (Method::GET, "/payouts/reconciliation/jobs/job_1") => Json(reconciliation_job("running", 1, None)).into_response(),
        (Method::GET, "/payouts/reconciliation/jobs/job_1/events") => {
            let done = json!({ "checked": 2, "reconciled": 1, "ignored": 0, "skipped": 0,
                "errors": [{ "payoutId": "pyo_failed", "message": "Payout setup must include a provider account." }] });
            let event = |id: u32, job: Value| format!("id: {id}\nevent: job.progress\ndata: {job}\n\n");
            let body = [
                event(1, reconciliation_job("running", 1, None)),
                event(2, reconciliation_job("running", 1, None)),
                event(3, reconciliation_job("completed", 2, Some(done))),
            ]
            .concat();
            ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
        }
        (Method::GET, path) if path.starts_with("/payouts/reconciliation/jobs/") => {
            refusal(StatusCode::NOT_FOUND, "not_found", "Job not found.")
        }
        (Method::POST, "/payouts/reconciliation/run") if cookie.contains("payouts-blocked") => {
            refusal(StatusCode::CONFLICT, "reconciliation_running", "A reconciliation run is already in progress.")
        }
        (Method::POST, "/payouts/reconciliation/run") => (StatusCode::ACCEPTED, Json(reconciliation_job("queued", 0, None))).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

impl Pilot {
    fn calls_to_path(&self, prefix: &str) -> Vec<Call> {
        self.calls.lock().unwrap().iter().filter(|c| c.path.starts_with(prefix)).cloned().collect()
    }
}

#[tokio::test]
async fn the_payout_pages_take_either_permission_and_a_run_takes_reconcile() {
    let pilot = Pilot::new().await;
    for path in ["/commerce/money-health", "/commerce/payout-operations"] {
        let (status, _, _) = pilot.send(get(path, Some("reader"))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
        for session in ["payouts-viewer", "payouts-operator"] {
            let (status, _, html) = pilot.send(get(path, Some(session))).await;
            assert_eq!(status, StatusCode::OK, "{path} {session}: {html}");
        }
    }
    let (status, _, _) =
        pilot.send(post_as("payouts-viewer", "/commerce/payout-operations", "intent=run-reconciliation", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(pilot.calls_to_path("/api/settlement/payouts/reconciliation/run").is_empty(), "a viewer's run reaches no API");
    // The nav shows both pages to a viewer with either permission.
    let (_, _, html) = pilot.send(get("/commerce/money-health", Some("payouts-viewer"))).await;
    assert!(html.contains(r#"href="/commerce/payout-operations""#), "{html}");
}

#[tokio::test]
async fn money_health_shows_its_one_read() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/commerce/money-health", Some("payouts-viewer"))).await;
    assert!(html.contains("<title>Money Health | Settlement Admin"), "{html}");
    assert!(html.contains("$107.91 available") && html.contains("Pending payout demand: "), "{html}");
    assert!(html.contains("signature-invalid, unknown-event") && html.contains(">Required<"), "{html}");
    assert!(html.contains(">Unavailable<"), "connected payouts unsupported: {html}");
    assert!(html.contains("acc_neg") && html.contains("-$12.50") && html.contains(">collections<"), "{html}");
    assert!(html.contains("pyo_failed") && html.contains("$19.75"), "{html}");
    assert!(html.contains("Checked 2; reconciled 0; errors 2"), "{html}");
    assert!(!html.contains("/account/desk/payouts/"), "no Marketplace origin, no links: {html}");
}

#[tokio::test]
async fn payout_operations_forwards_the_filter_and_reads_the_rest_only_to_reconcile() {
    let pilot = Pilot::new().await;
    let (_, _, html) = pilot.send(get("/commerce/payout-operations?filter=failed", Some("payouts-viewer"))).await;
    let reads: Vec<String> = pilot.calls_to_path(SETTLEMENT).into_iter().map(|c| c.path).collect();
    assert_eq!(reads, ["/api/settlement/payouts/reconciliation?filter=failed"], "a viewer reads only the payouts");
    assert!(!html.contains("run-reconciliation") && !html.contains("Recent Provider Attempts"), "{html}");
    assert!(html.contains(r#"aria-current="page""#) && html.contains("Retry queued"), "{html}");
    assert!(html.contains("1 attempt; next "), "{html}");
    assert!(!html.contains("Payout setup blocked"), "the setup rows need payouts.reconcile: {html}");

    let (_, _, html) = pilot.send(get("/commerce/payout-operations?filter=nonsense", Some("payouts-operator"))).await;
    let reads: Vec<String> = pilot.calls_to_path(SETTLEMENT).into_iter().skip(1).map(|c| c.path).collect();
    assert!(reads.contains(&"/api/settlement/payouts/reconciliation".to_owned()), "an unknown filter is All: {reads:?}");
    assert!(reads.contains(&"/api/settlement/payout-readiness".to_owned()));
    assert!(reads.contains(&"/api/settlement/payouts/provider-idempotency?limit=10".to_owned()));
    assert!(html.contains("Ready to reconcile") && !html.contains("Needs provider reference"), "{html}");
    assert!(html.contains("Protected retry key") && !html.contains("secret-key"), "the key itself is not shown: {html}");
    assert!(html.contains("Not checked in this session"), "{html}");
    // Restricted setup is blocked; updated in January is stale.
    let blocked = html.find("Payout setup blocked").unwrap();
    assert!(html[blocked..].contains(r#">1</span>"#), "{html}");
}

#[tokio::test]
async fn a_run_is_sent_shown_by_its_id_and_followed_until_it_is_done() {
    let pilot = Pilot::new().await;
    let (status, headers, _) = pilot
        .send(post_as("payouts-operator", "/commerce/payout-operations?filter=failed", "intent=run-reconciliation", false))
        .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/commerce/payout-operations?filter=failed&job=job_1");
    let run = pilot.calls_to_path("/api/settlement/payouts/reconciliation/run").remove(0);
    assert_eq!(serde_json::from_str::<Value>(&run.body).unwrap(), json!({ "limit": 100 }));

    let (_, _, html) = pilot.send(get("/commerce/payout-operations?filter=failed&job=job_1", Some("payouts-operator"))).await;
    assert!(html.contains(">running<") && html.contains("Checked 1; reconciled 0; ignored 0; skipped 0."), "{html}");
    assert!(html.contains(r#"src="/commerce/payout-operations/live?filter=failed&amp;job=job_1""#), "{html}");
    assert!(html.contains("Check again"), "{html}");

    // The stream draws the run when it moves: the repeated record draws nothing.
    let events = pilot.events("/commerce/payout-operations/live?filter=failed&job=job_1", "payouts-operator", 3).await;
    let events: Vec<_> = events.into_iter().filter(|(event, _)| event == "patch").collect();
    assert_eq!(events.len(), 2, "two patches, then the stream ends: {events:?}");
    let (_, done) = &events[1];
    assert!(done.contains(">completed<") && done.contains("Checked 2; reconciled 1"), "{done}");
    assert!(done.contains("Errors: Payout setup must include a provider account.") && !done.contains("Check again"), "{done}");

    // An unknown run: an old address shows none.
    let (status, _, html) = pilot.send(get("/commerce/payout-operations?job=job_gone", Some("payouts-operator"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Not checked in this session"), "{html}");
}

#[tokio::test]
async fn a_refused_run_says_why_and_an_unknown_intent_does_nothing() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post_as("payouts-blocked", "/commerce/payout-operations", "intent=run-reconciliation", true)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains(r#"role="alert">A reconciliation run is already in progress."#), "{html}");
    let (status, headers, _) =
        pilot.send(post_as("payouts-operator", "/commerce/payout-operations", "intent=other", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/commerce/payout-operations");
    assert_eq!(pilot.calls_to_path("/api/settlement/payouts/reconciliation/run").len(), 1, "only the blocked one");
}

const WAITLIST_API: &str = "/api/public-presence/admin/waitlist";

/// Public Presence's waitlist: one referred seller who came through a UTM campaign, the figures,
/// and the export as CSV; `search=down` fails.
fn waitlist_api(rest: &str, query: &str) -> Response {
    if query.contains("search=down") {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match rest {
        "" => Json(json!({ "items": [{
            "signup_id": "wls_1", "email": "seller@example.test", "role": "sell", "interests": ["bulk-listing", "pricing-tools"],
            "page_path": "/", "referrer": "https://ref.example", "utm_source": "discord", "referred_by_signup_id": "wls_0",
            "referral_count": 3, "updated_at": "2026-10-30T12:00:00.000Z",
        }], "total": 7, "count": 1 }))
        .into_response(),
        "/metrics" => Json(json!({ "total_count": 7, "buy_count": 2, "sell_count": 4, "both_count": 1, "wave_fill": [
            { "waveNumber": 1, "admittedCount": 3, "capacity": 100 }, { "waveNumber": 2, "admittedCount": 0, "capacity": 250 },
        ] }))
        .into_response(),
        "/export" => (
            [
                (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                (header::CONTENT_DISPOSITION, r#"attachment; filename="chase-sets-waitlist.csv""#),
            ],
            "\"email\",\"role\"\n\"seller@example.test\",\"sell\"",
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn the_waitlist_forwards_admin_webs_filters_and_shows_the_figures_and_signups() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/growth/waitlist", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) =
        pilot.send(get("/growth/waitlist?role=sell&interest=nonsense&sort=referrals&search=seller", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let reads: Vec<String> = pilot.calls_to_path(WAITLIST_API).into_iter().map(|c| c.path).collect();
    assert!(
        reads.contains(&format!("{WAITLIST_API}?limit=100&offset=0&role=sell&search=seller&sort=referrals")),
        "an interest admin-web does not offer is All: {reads:?}"
    );
    assert!(html.contains("<title>Waitlist | Experience Admin"), "{html}");
    assert!(html.contains(r#"<option value="sell" selected>List cards</option>"#), "{html}");
    assert!(html.contains("Wave 1") && html.contains("3 of 100 admitted"), "{html}");
    assert!(html.contains("seller@example.test") && html.contains("Bulk listing") && html.contains(">discord<"), "{html}");
    assert!(html.contains(">Yes<") && html.contains("Showing 1 of 7"), "{html}");
    assert!(html.contains(r#"href="/growth/waitlist/export?search=seller&amp;role=sell&amp;sort=referrals""#), "{html}");

    let (status, _, _) = pilot.send(get("/growth/waitlist?search=down", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn the_waitlist_export_relays_the_apis_file_and_no_cache_keeps_it() {
    let pilot = Pilot::new().await;
    let (status, headers, body) = pilot.send(get("/growth/waitlist/export?role=buy", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert_eq!(headers[header::CONTENT_DISPOSITION], r#"attachment; filename="chase-sets-waitlist.csv""#);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(body.starts_with("\"email\""), "{body}");
    assert!(
        pilot.calls_to_path(WAITLIST_API).iter().any(|c| c.path == format!("{WAITLIST_API}/export?limit=100&offset=0&role=buy"))
    );
    let (status, _, _) = pilot.send(get("/growth/waitlist/export", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

fn campaign_analytics() -> Response {
    Json(json!({
        "quality": { "totalSignups": 250, "sellerSignupCount": 80, "qualifiedSellerCount": 60, "storeLinkCount": 20, "storeLinkPercent": 25,
            "inventorySizeDistribution": { "under_100": 10, "100_to_500": 30, "500_to_2000": 15, "2000_plus": 5 },
            "qualifiedSellersByGame": { "pokemon": 40 } },
        "channelAttribution": [
            { "utm_source": "discord", "utm_medium": "social", "utm_campaign": null, "signup_count": 200, "seller_signup_count": 70, "qualified_seller_count": 55 },
            { "utm_source": null, "utm_medium": null, "utm_campaign": null, "signup_count": 50, "seller_signup_count": 10, "qualified_seller_count": 5 },
        ],
        "admissionBar": { "goals": { "minTotalSignups": 400, "minQualifiedSellers": 48, "minQualifiedSellersPerGame": 5 }, "totalSignups": 250, "qualifiedSellerCount": 60, "totalSignupsMet": false, "qualifiedSellersMet": true,
            "gameCoverage": [{ "game": "pokemon", "qualifiedSellerCount": 40, "covered": true }, { "game": "yu-gi-oh", "qualifiedSellerCount": 0, "covered": false }],
            "allGamesCovered": false, "admitted": false },
    }))
    .into_response()
}

#[tokio::test]
async fn campaign_analytics_shows_progress_toward_the_policys_goals() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/growth/campaign-analytics", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) = pilot.send(get("/growth/campaign-analytics", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>") && html.contains("Wave 1 bar not yet met"), "{html}");
    assert!(
        html.contains("250 of 400") && html.contains(r#"max="100" value="62""#),
        "the read's signup goal, not the policy's 500: {html}"
    );
    assert!(html.contains("60 of 48") && html.contains(r#"value="100""#), "past the read's seller goal: {html}");
    assert!(html.contains("25%") && html.contains("Pok"), "{html}");
    assert!(html.contains("discord / social") && html.contains("Direct / no UTM"), "{html}");
    assert!(html.contains("/grafana/d/chase-sets-public-presence-waitlist/public-presence-waitlist-funnel"), "{html}");
}

const PROMO_API: &str = "/api/public-presence/admin/promo-bar-messages";

/// Public Presence's promo bar messages: one live with a marketplace link, one scheduled and one
/// inactive. A message titled `refuse` is refused as admin-web's API refuses a bad write.
fn promo_api(method: &Method, rest: &str, body: &str) -> Response {
    if method == Method::GET && rest.is_empty() {
        return Json(json!({ "items": [
            { "id": "pbm_live", "title": "Lower fees", "description": "Sell for less.", "href": "/sales-fees", "link_label": "See fees",
              "tone": "success", "is_active": true, "display_order": 10, "starts_at": null, "ends_at": null },
            { "id": "pbm_later", "title": "Holiday hours", "description": null, "href": null, "link_label": null,
              "tone": "warning", "is_active": true, "display_order": 20, "starts_at": "2099-01-01 00:00:00+00", "ends_at": null },
            { "id": "pbm_off", "title": "Old news", "description": null, "href": null, "link_label": null,
              "tone": "info", "is_active": false, "display_order": 30, "starts_at": "2026-11-10 15:00:00+00", "ends_at": null },
        ] }))
        .into_response();
    }
    if body.contains(r#""title":"refuse""#) {
        return refusal(StatusCode::UNPROCESSABLE_ENTITY, "invalid_promo_bar_message", "Title must be shorter.");
    }
    Json(json!({})).into_response()
}

#[tokio::test]
async fn the_promo_bar_previews_live_messages_and_shows_each_messages_status() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/growth/promo-bar", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) = pilot.send(get("/growth/promo-bar", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Promo Bar | Experience Admin"), "{html}");
    assert_eq!(html.matches(r#"data-tone="success""#).count(), 1, "only the live message is previewed: {html}");
    assert!(html.contains("Sell for less.") && !html.contains("See fees"), "no marketplace origin, so no preview link: {html}");
    assert!(html.contains(r#"data-status="active""#) && html.contains(r#"data-status="scheduled""#), "{html}");
    assert!(html.contains(r#"data-status="inactive""#) && html.contains(">Deactivate<") && html.contains(">Activate<"), "{html}");
    assert!(
        html.contains(r#"href="/growth/promo-bar?edit=pbm_live""#) && html.contains(r#"href="/growth/promo-bar?delete=pbm_off""#),
        "{html}"
    );
    assert!(!html.contains("<dialog"), "{html}");

    let (_, _, html) =
        pilot.send(get("/growth/promo-bar?edit=pbm_off", Some("growth-viewer; corten-zone=America/Chicago"))).await;
    assert!(html.contains("<dialog") && html.contains(r#"value="2026-11-10T09:00""#), "the time in the operator's zone: {html}");
    let (_, _, html) = pilot.send(get("/growth/promo-bar?delete=pbm_off", Some("growth-viewer"))).await;
    assert!(html.contains(r#"role="alertdialog""#) && html.contains("Old news"), "{html}");
}

#[tokio::test]
async fn promo_bar_writes_send_admin_webs_bodies_and_a_refusal_keeps_what_was_typed() {
    let pilot = Pilot::new().await;
    let session = "growth-viewer; corten-zone=America/Chicago";
    let create = "intent=create&title=New&description=&href=%2Fx&linkLabel=Go&tone=warning&isActive=true&displayOrder=5\
                  &startsAt=2026-11-10T09%3A00&endsAt=";
    for script in [false, true] {
        let (status, _, body) = pilot.send(post_as(session, "/growth/promo-bar", create, script)).await;
        let expected = if script { StatusCode::NO_CONTENT } else { StatusCode::SEE_OTHER };
        assert_eq!(status, expected, "{body}");
    }
    let sent: Vec<Call> = pilot.calls_to_path(PROMO_API).into_iter().filter(|c| c.method == Method::POST).collect();
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body["startsAt"], json!("2026-11-10T15:00:00Z"), "Chicago's 9:00 as its instant");
    assert_eq!((body["endsAt"].clone(), body["description"].clone()), (Value::Null, Value::Null));
    assert_eq!((body["displayOrder"].clone(), body["tone"].clone()), (json!(5.0), json!("warning")));

    for (form, method, path) in [
        ("intent=activate&id=pbm_off", Method::POST, format!("{PROMO_API}/pbm_off/activate")),
        ("intent=deactivate&id=pbm_live", Method::POST, format!("{PROMO_API}/pbm_live/deactivate")),
        ("intent=delete&id=pbm_off", Method::DELETE, format!("{PROMO_API}/pbm_off")),
        ("intent=update&id=pbm_live&title=Lower&tone=info&displayOrder=10", Method::PUT, format!("{PROMO_API}/pbm_live")),
    ] {
        let (status, headers, _) = pilot.send(post_as("growth-viewer", "/growth/promo-bar", form, false)).await;
        assert_eq!(status, StatusCode::SEE_OTHER, "{form}");
        assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/growth/promo-bar?done="), "{form}");
        assert!(pilot.calls_to_path(&path).iter().any(|c| c.method == method), "{form}");
    }
    let (_, _, html) = pilot.send(get("/growth/promo-bar?done=deleted", Some("growth-viewer"))).await;
    assert!(html.contains("Promo bar message deleted."), "{html}");

    let (status, _, html) = pilot
        .send(post_as("growth-viewer", "/growth/promo-bar", "intent=create&title=refuse&tone=info&displayOrder=1", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Title must be shorter.") && html.contains(r#"value="refuse""#), "{html}");
    let (status, _, html) = pilot.send(post_as("growth-viewer", "/growth/promo-bar", "intent=update", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("No promo bar change was applied."), "{html}");
}

const SHOPPING_API: &str = "/api/marketplace/google-shopping";

fn shopping_row(id: &str, blocking: u64, reasons: &[&str]) -> Value {
    json!({
        "rowId": format!("google-shopping:listing:{id}"), "listingId": id, "title": format!("Box {id}"), "accountId": "acc_1",
        "catalogItemId": "cat_1", "productId": "cat_1::", "merchantOfferId": format!("cs-listing-{id}"), "externalSellerId": "cs-account-acc_1",
        "canonicalUrl": format!("https://marketplace.example/listings/{id}"), "targetCountry": "US", "contentLanguage": "en", "feedLabel": "US",
        "eligibilityStatus": if blocking > 0 { "excluded" } else { "eligible" }, "exclusionReasons": reasons,
        "imageEligibilityStatus": "excluded", "imageExclusionReasons": ["invalid-image-url"], "syncStatus": "never-submitted",
        "diagnosticStatus": null, "activeIssueCount": 0, "unknownIssueCodeCount": 0, "blockingIssueCount": blocking,
        "remediationOwners": ["Catalog"], "pendingDelete": false, "stale": false, "nearingRefresh": false, "payloadHash": null,
        "lastSubmittedPayloadHash": null, "lastSubmittedAt": null, "lastAcceptedAt": null, "lastSyncAttemptedAt": null,
        "lastSyncErrorCode": null, "lastSyncErrorMessage": null, "lastProviderOperation": null, "deleteSubmittedAt": null,
        "lastDiagnosticAt": null, "shippingPolicyUrl": null, "returnPolicyUrl": null, "returnPolicyLabel": null,
        "updatedAt": "2026-10-30T12:48:49.526Z",
    })
}

fn shopping_job(id: &str, status: &str) -> Value {
    json!({ "jobId": id, "jobKind": "google-shopping.full-sync", "status": status, "result": null, "errorMessage": null,
        "createdAt": "2026-10-31T06:00:00Z", "startedAt": null, "completedAt": null, "updatedAt": "2026-10-31T06:00:01Z",
        "progress": { "phase": "processing", "completed": 3, "total": 23, "currentRowId": "google-shopping:listing:lst_a",
            "submitted": 1, "skipped": 2, "deleted": 0, "failed": 0, "excluded": 20, "message": "Dry run in progress." } })
}

/// Discovery's Google Shopping operations: two rows (the second blocked, with a reason the page
/// has no words for), a running job `gsj_1`, and dry runs; a batch of 7 is refused.
fn shopping_api(method: &Method, rest: &str, query: &str, body: &str) -> Response {
    match (method.as_str(), rest) {
        ("GET", "/feed-rows") => Json(json!({
            "generatedAt": "2026-10-31T06:00:00Z", "filter": "all", "search": "", "limit": 100, "refreshWindowDays": 25,
            "refreshCutoff": "2026-10-06T06:00:00Z",
            "summary": { "totalRows": 2, "attentionRows": 1, "eligibleRows": 1, "excludedRows": 1, "failedRows": 0,
                "disapprovedRows": 0, "pendingDeleteRows": 0, "staleRows": 0, "nearingRefreshRows": 0, "pendingDiagnosticsRows": 0 },
            "rows": [shopping_row("lst_a", 0, &[]), shopping_row("lst_b", 2, &["missing-condition", "brand-new-reason"])],
            "echo": query,
        }))
        .into_response(),
        ("GET", "/sync-jobs/gsj_1") => Json(shopping_job("gsj_1", "running")).into_response(),
        ("GET", _) => StatusCode::NOT_FOUND.into_response(),
        (_, _) if body.contains(r#""batchSize":7"#) || body.contains(r#""limit":7"#) => {
            refusal(StatusCode::BAD_REQUEST, "validation_failed", "Batch size is too small.")
        }
        ("POST", "/sync-jobs") | ("POST", "/diagnostics/refresh-jobs") => (StatusCode::ACCEPTED, Json(shopping_job("gsj_2", "queued"))).into_response(),
        ("POST", "/maintenance/sync-jobs") => Json(json!({ "summary": { "total": 0 }, "job": null })).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn google_shopping_shows_the_feed_and_inspect_and_close_keep_the_filters() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/growth/google-shopping", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) =
        pilot.send(get("/growth/google-shopping?search=box&filter=nonsense&limit=50", Some("shopping-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let reads: Vec<String> = pilot.calls_to_path(SHOPPING_API).into_iter().map(|c| c.path).collect();
    assert!(
        reads.contains(&format!("{SHOPPING_API}/feed-rows?filter=all&limit=50&refreshWindowDays=25&search=box")),
        "{reads:?}"
    );
    assert!(html.contains("<title>Google Shopping | Operations"), "{html}");
    assert!(html.contains("1 of 2 rows eligible; 1 excluded"), "{html}");
    assert!(html.contains("Missing condition") && html.contains("Unrecognized exclusion reason (brand-new-reason)"), "{html}");
    assert!(html.contains("Box lst_b"), "the first blocked row's detail opens: {html}");
    assert!(
        html.contains(r#"href="/growth/google-shopping?search=box&amp;filter=nonsense&amp;limit=50&amp;selected=none""#),
        "Close: {html}"
    );
    assert!(
        html.contains(r#"href="/growth/google-shopping?search=box&amp;filter=nonsense&amp;limit=50&amp;selected=google-shopping%3Alisting%3Alst_a""#),
        "Inspect keeps the filters: {html}"
    );
    assert!(html.contains(r#"href="/catalog/catalog-items/cat_1""#) && !html.contains("/access/accounts/acc_1"), "{html}");
    assert!(html.contains("Live full sync gated") && html.contains(" disabled"), "{html}");

    let (_, _, html) = pilot.send(get("/growth/google-shopping?search=box&selected=none", Some("shopping-viewer"))).await;
    assert!(!html.contains("gs-detail"), "closed: {html}");
    let (_, _, html) =
        pilot.send(get("/growth/google-shopping?selected=google-shopping%3Alisting%3Alst_a", Some("shopping-viewer"))).await;
    assert!(html.contains(r#"id="gs-detail">Box lst_a<"#), "{html}");
}

#[tokio::test]
async fn a_google_shopping_dry_run_is_queued_with_the_pages_limit_and_followed() {
    let pilot = Pilot::new().await;
    for script in [false, true] {
        let (status, headers, _) =
            pilot.send(post_as("shopping-viewer", "/growth/google-shopping?limit=50", "intent=dry-run-full-sync", script)).await;
        let expected = if script { StatusCode::NO_CONTENT } else { StatusCode::SEE_OTHER };
        assert_eq!(status, expected);
        if !script {
            assert_eq!(headers[header::LOCATION], "/growth/google-shopping?limit=50&job=gsj_2&queued=full-sync");
        }
    }
    let sent: Vec<Call> = pilot.calls_to_path(SHOPPING_API).into_iter().filter(|c| c.method == Method::POST).collect();
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body, json!({ "mode": "dry-run", "batchSize": 50 }));

    let (status, headers, _) =
        pilot.send(post_as("shopping-viewer", "/growth/google-shopping", "intent=dry-run-maintenance-sync", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/growth/google-shopping?queued=maintenance&total=0");
    let (_, _, html) = pilot.send(get("/growth/google-shopping?queued=maintenance&total=0", Some("shopping-viewer"))).await;
    assert!(html.contains("Maintenance dry-run found 0 candidate rows."), "{html}");

    let (status, headers, _) =
        pilot.send(post_as("shopping-viewer", "/growth/google-shopping", "intent=live-full-sync", false)).await;
    assert_eq!((status, headers[header::LOCATION].to_str().unwrap()), (StatusCode::SEE_OTHER, "/growth/google-shopping"));
    assert_eq!(
        pilot.calls_to_path(SHOPPING_API).iter().filter(|c| c.method == Method::POST).count(),
        3,
        "a live run queues nothing"
    );

    let (_, _, html) = pilot.send(get("/growth/google-shopping?job=gsj_1&queued=full-sync", Some("shopping-viewer"))).await;
    assert!(html.contains("Full sync dry-run queued as gsj_1.") && html.contains("3 of 23"), "{html}");
    assert!(html.contains("/growth/google-shopping/live?job=gsj_1"), "a running job is followed: {html}");

    let (status, _, html) = pilot
        .send(post_as("shopping-viewer", "/growth/google-shopping?limit=7", "intent=dry-run-diagnostics-refresh", false))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains("Batch size is too small."), "{html}");
}

/// Platform Operations' provider connections: a fresh Catalog provider with its page, a stale
/// seller channel, and a section the API could only partly read.
fn provider_connections() -> Response {
    Json(json!({
        "evaluatedAt": "2026-10-31T07:05:00.000Z",
        "catalog": { "state": "available", "rows": [{
            "id": "lorcast", "provider": "lorcast", "capability": "catalog-integration", "owner": "catalog", "accountId": null,
            "credentialReadiness": "not-required", "health": "ready", "observedAt": "2026-10-31T07:04:55.000Z",
            "freshness": { "freshWithinSeconds": 15, "staleAfterSeconds": 60, "unavailableAfterSeconds": 300 },
            "destination": { "routeId": "provider-detail", "href": "/catalog/providers/lorcast" } }] },
        "channels": { "state": "partial", "rows": [{
            "id": "chc_1", "provider": "tcgplayer", "capability": "channel-connection", "owner": "channels", "accountId": "acc_9",
            "status": "paused", "credentialReadiness": "expired", "health": "failing", "observedAt": "2026-10-31T07:02:00.000Z",
            "freshness": { "freshWithinSeconds": 15, "staleAfterSeconds": 60, "unavailableAfterSeconds": 300 },
            "destination": { "routeId": "x", "href": "/account/channels/chc_1" } }] },
    }))
    .into_response()
}

#[tokio::test]
async fn provider_connections_need_a_platform_admin_and_show_each_connections_freshness() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/provider-connections", Some("providers-owner"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the permission without the platform-admin role");
    let (status, _, html) = pilot.send(get("/platform/provider-connections", Some("providers-admin"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Provider Connections | Chase Sets Admin"), "{html}");
    assert!(html.contains(">Fresh<") && html.contains("(0 min ago)"), "{html}");
    assert!(html.contains(">Stale<") && html.contains("(3 min ago)"), "{html}");
    assert!(html.contains("Seller account acc_9") && html.contains(">Expired<") && html.contains(">Paused<"), "{html}");
    assert!(
        html.contains(r#"href="http://localhost:7752/catalog/providers/lorcast""#) && !html.contains("/account/channels/chc_1"),
        "{html}"
    );
    assert!(html.contains("Read-only; no operator action"), "{html}");
}

/// Every page the pilot serves is the nav's own, found from the routes rather than a list kept by
/// hand; a page it does not serve opens on admin-web.
#[tokio::test]
async fn the_nav_links_every_page_the_pilot_serves_to_the_pilot() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get("/growth/campaign-analytics", Some("growth-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for path in ["/growth/waitlist", "/growth/promo-bar"] {
        assert!(html.contains(&format!(r#"href="{path}""#)), "{path}: {html}");
    }
    assert!(html.contains(r#"href="/growth/campaign-analytics" aria-current="page""#), "{html}");
    let (status, _, html) = pilot.send(get("/platform/insights/offer-economics", Some("insights-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"href="/platform/insights/offer-economics" aria-current="page""#), "{html}");
    assert!(!html.contains("localhost:7752/platform/insights/offer-economics"), "{html}");
}

/// Platform Operations' policy console: two contexts' policies (one on its compiled default), a
/// policy with a scheduled revision and its history, and revisions that the API refuses when the
/// value is negative.
fn policy_console(method: &Method, rest: &str, body: &str) -> Response {
    let current = json!({ "source": "policy", "documentId": "pol_1", "status": "active", "value": { "maximumDays": 14 },
        "effectiveFrom": "2026-07-14T00:00:00.000Z", "effectiveUntil": null });
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({ "commercialTermsSchedulesHref": "/commerce/terms", "items": [
            { "policyKey": "settlement.clearance-window", "contextName": "settlement", "schemaSummary": "{ maximumDays }",
              "status": "active", "value": { "maximumDays": 14 }, "effectiveFrom": "2026-07-14T00:00:00.000Z", "effectiveUntil": null,
              "updatedAt": "2026-10-29T21:55:36.532Z" },
            { "policyKey": "platform-operations.rate-limits", "contextName": "platform-operations", "schemaSummary": "{ perMinute }",
              "status": "fallback", "value": { "perMinute": 60 }, "effectiveFrom": "", "effectiveUntil": null, "updatedAt": "" },
        ] }))
        .into_response(),
        (Method::GET, "/settlement.clearance-window") => Json(json!({
            "policyKey": "settlement.clearance-window", "contextName": "settlement", "schemaSummary": "{ maximumDays }",
            "current": current,
            "upcoming": [{ "documentId": "pol_9", "status": "active", "value": { "maximumDays": 10 },
                "effectiveFrom": "2026-12-01T06:00:00.000Z", "effectiveUntil": null }],
        }))
        .into_response(),
        (Method::GET, "/settlement.clearance-window/documents/pol_1") => Json(json!({ "document_id": "pol_1", "history": [
            { "history_id": "h_1", "event_type": "platform-policy.document.created", "actor_user_id": "usr_admin", "status": "active",
              "effective_from": "2026-07-14T00:00:00.000Z", "effective_until": null, "recorded_at": "2026-07-13T18:30:00.000Z" },
        ] }))
        .into_response(),
        (Method::POST, "/settlement.clearance-window/revisions") => {
            let sent: Value = serde_json::from_str(body).unwrap_or_default();
            if sent["value"]["maximumDays"].as_i64().is_some_and(|d| d < 0) {
                refusal(StatusCode::BAD_REQUEST, "validation_failed", "maximumDays must be at least 0.")
            } else {
                (StatusCode::CREATED, Json(json!({ "id": "pol_10", "version": 2, "scheduled": true }))).into_response()
            }
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn the_policy_console_lists_by_context_and_a_reader_cannot_write() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/policy-console", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) = pilot.send(get("/platform/policy-console", Some("policy-viewer; corten-zone=America/Chicago"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Policy Console | Chase Sets Admin"), "{html}");
    let (operations, settlement) = (html.find(">Platform Operations<").unwrap(), html.find(">Settlement<").unwrap());
    assert!(operations < settlement, "the contexts in name order: {html}");
    assert!(html.contains(r#"href="/platform/policy-console/settlement.clearance-window""#), "{html}");
    assert!(html.contains("Fallback (compiled default)") && html.contains(">Not set<"), "{html}");
    assert!(html.contains("Oct 29, 2026, 4:55 PM"), "a time in the operator's zone: {html}");
    assert!(html.contains(r#"href="/commerce/terms?schedule=cts_1""#), "the attention link is the pilot's terms page: {html}");
    assert!(html.contains("Seller fees") && html.contains("11 days"), "{html}");
    assert!(!html.contains("Confirm current"), "a viewer cannot confirm: {html}");
    let (status, _, _) = pilot.send(post_as("policy-viewer", "/platform/policy-console", "locale=en", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nor post");

    let (_, _, html) = pilot.send(get("/platform/policy-console", Some("policy-manager"))).await;
    assert!(html.contains("Confirm current"), "{html}");
    let confirm = "locale=en&articleSlug=fees&policyKey=settlement.payout-fee";
    let (status, headers, _) = pilot.send(post_as("policy-manager", "/platform/policy-console", confirm, false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/platform/policy-console"));
    assert!(
        pilot
            .calls_to_path("/api/platform/public-doc-reviews/en/fees/settlement.payout-fee/confirm")
            .iter()
            .any(|c| c.method == Method::POST),
        "the confirmation was sent"
    );
    let (status, _, html) =
        pilot.send(post_as("policy-manager", "/platform/policy-console", "locale=en&articleSlug=gone&policyKey=x", false)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{html}");
    assert!(html.contains("No review is waiting for that article."), "the refusal on the console: {html}");
}

#[tokio::test]
async fn a_policy_revision_is_sent_in_the_operators_zone_and_a_refusal_keeps_what_was_typed() {
    let pilot = Pilot::new().await;
    let page = "/platform/policy-console/settlement.clearance-window";
    let (status, _, html) = pilot.send(get(page, Some("policy-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>settlement.clearance-window</title>"), "{html}");
    assert!(html.contains("Scheduled for Dec 1, 2026, 6:00 AM") && html.contains("platform-policy.document.created"), "{html}");
    assert!(!html.contains("<textarea"), "a viewer has no form: {html}");

    let session = "policy-manager; corten-zone=America/Chicago";
    let (_, _, html) = pilot.send(get(page, Some(session))).await;
    assert!(html.contains("Scheduled for Dec 1, 2026, 12:00 AM"), "in Chicago: {html}");
    assert!(html.contains("&quot;maximumDays&quot;: 14"), "the value, indented, to edit: {html}");
    let revise = "value=%7B%22maximumDays%22%3A10%7D&status=active&effectiveFrom=2026-12-01T00%3A00&effectiveUntil=";
    for script in [false, true] {
        let (status, _, body) = pilot.send(post_as(session, page, revise, script)).await;
        let expected = if script { StatusCode::NO_CONTENT } else { StatusCode::SEE_OTHER };
        assert_eq!(status, expected, "{body}");
    }
    let sent = pilot.calls_to_path("/api/platform/policy-console/settlement.clearance-window/revisions");
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        body,
        json!({ "value": { "maximumDays": 10 }, "status": "active", "effectiveFrom": "2026-12-01T06:00:00Z", "effectiveUntil": null }),
        "midnight in Chicago as its instant"
    );

    let (status, _, html) = pilot.send(post_as(session, page, "value=%7Bnope&status=inactive", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("The value must be valid JSON.") && html.contains(">{nope</textarea>"), "{html}");
    assert!(html.contains(r#"<option value="inactive" selected>"#), "the status as chosen: {html}");
    let calls = pilot.calls_to_path("/api/platform/policy-console/settlement.clearance-window/revisions").len();
    assert_eq!(calls, 2, "nothing sent for JSON that does not read");

    let negative = "value=%7B%22maximumDays%22%3A-1%7D&status=active&effectiveFrom=2026-12-01T00%3A00";
    let (status, _, html) = pilot.send(post_as(session, page, negative, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("maximumDays must be at least 0.") && html.contains(r#"value="2026-12-01T00:00""#), "{html}");
}

/// Marketplace's Listing Evidence Policy: the compiled fallback in effect, an active, a draft and a
/// validated version, a category and an option to select, a draft that does not validate, and a
/// draft name the API refuses.
fn listing_evidence_policy(method: &Method, rest: &str, body: &str) -> Response {
    let version = |id: &str, version: u64, lifecycle: &str| json!({ "policyId": id, "version": version, "lifecycle": lifecycle, "hash": format!("sha256:{id}") });
    match (method.clone(), rest) {
        (Method::GET, "") => Json(json!({
            "current": { "policyId": null, "version": null, "hash": "sha256:fallback", "effectiveFrom": null, "effectiveUntil": null,
                "value": { "rules": [{ "ruleId": "a" }, { "ruleId": "b" }] } },
            "documents": [version("lep_1", 1, "active"), version("lep_2", 2, "draft"), version("lep_3", 3, "validated"),
                version("lep_bad", 4, "draft")],
        }))
        .into_response(),
        (Method::GET, "/selectors") => Json(json!({
            "categories": [{ "id": "cat_1", "label": "Trading cards" }],
            "options": [{ "id": "opt_mint", "label": "Mint", "parentId": "dim_condition" }],
        }))
        .into_response(),
        (Method::POST, "/drafts") => {
            let sent: Value = serde_json::from_str(body).unwrap_or_default();
            if sent["policyName"] == "refuse" {
                refusal(StatusCode::BAD_REQUEST, "validation_failed", "The policy name is taken.")
            } else {
                (StatusCode::CREATED, Json(version("lep_5", 5, "draft"))).into_response()
            }
        }
        (Method::POST, "/drafts/lep_bad/validate") => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "valid": false, "documentId": "lep_bad",
                "diagnostics": [{ "path": "rules[0].priority", "code": "duplicate", "message": "Priority 100 is used twice." }],
                "semanticDiff": { "addedRuleIds": [], "changedRuleIds": [], "removedRuleIds": [] },
                "impactPreview": { "impactedListingCount": 0, "previewHash": "" } })),
        )
            .into_response(),
        (Method::POST, "/drafts/lep_2/validate" | "/drafts/lep_3/validate") => Json(json!({
            "valid": true, "documentId": rest.trim_start_matches("/drafts/").trim_end_matches("/validate"), "diagnostics": [],
            "semanticDiff": { "addedRuleIds": ["rule-2"], "changedRuleIds": [], "removedRuleIds": ["a"] },
            "impactPreview": { "impactedListingCount": 4, "previewHash": "impact_1" },
        }))
        .into_response(),
        (Method::POST, "/drafts/lep_2/reject" | "/drafts/lep_3/activate" | "/documents/lep_1/rollback-draft") => {
            Json(version("lep_3", 3, "scheduled")).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// One rule as the guided form posts it.
const EVIDENCE_RULE: &str = "ruleId=rule-1&explanationCode=listing-evidence.configured-rule&priority=100&selectorKind=category\
    &selectorValue=cat_1&minimumPrice=&maximumPrice=&minimumPhotoCount=2&viewSet=condition&minimumWidthPixels=800\
    &minimumHeightPixels=&maximumAgeHours=&minimumTrustReviews=0&acceptedBadgeKey=";

#[tokio::test]
async fn the_listing_evidence_policy_shows_what_is_in_effect_and_a_viewer_cannot_write() {
    let pilot = Pilot::new().await;
    let page = "/platform/listing-evidence-policy";
    let (status, _, _) = pilot.send(get(page, Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) = pilot.send(get(page, Some("evidence-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("<title>Listing Evidence Policy | Platform"), "{html}");
    assert!(
        html.contains(">Compiled fallback<") && html.contains("2 configured rules") && html.contains(">Open ended<"),
        "{html}"
    );
    assert!(html.contains("lep_2 v2") && html.contains(r#"data-tone="good">Active<"#), "{html}");
    assert!(!html.contains(">Validate<") && !html.contains(">Reject<") && !html.contains("Guided policy draft"), "{html}");
    let (status, _, _) = pilot.send(post_as("evidence-viewer", page, "intent=reject&policyId=lep_2", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nor post");
    assert!(pilot.calls_to_path("/api/marketplace/listing-evidence-policy/drafts").is_empty());

    let (_, _, html) = pilot.send(get(page, Some("evidence-drafter"))).await;
    assert!(
        html.contains(">Reject<") && html.contains(">Create rollback draft<") && html.contains("Guided policy draft"),
        "{html}"
    );
    assert!(!html.contains(">Validate<"), "a drafter cannot validate: {html}");
    let (status, _, _) = pilot.send(post_as("evidence-drafter", page, "intent=validate&policyId=lep_2", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nor post to");
    let (status, headers, _) = pilot.send(post_as("evidence-drafter", page, "intent=reject&policyId=lep_2", false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with(page), "back under /platform");
}

#[tokio::test]
async fn a_guided_draft_is_drawn_again_without_writing_and_sent_as_admin_web_writes_it() {
    let pilot = Pilot::new().await;
    let page = "/platform/listing-evidence-policy";
    let (_, _, html) = pilot.send(get(page, Some("evidence-manager"))).await;
    assert!(html.contains(r#"value="Marketplace Listing Evidence Policy revision""#), "{html}");
    assert!(
        html.contains(r#"name="ruleId" value="rule-1""#) && !html.contains(">Remove rule<"),
        "one rule, not removable: {html}"
    );

    let one = format!("policyName=Slabs&{EVIDENCE_RULE}&buyerAcknowledgment=0");
    let (status, _, html) = pilot.send(post_as("evidence-manager", page, &format!("{one}&rerow=add"), false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"name="ruleId" value="rule-2""#) && html.contains(">Remove rule<"), "{html}");
    assert!(html.contains(r#"<option value="cat_1" selected>Trading cards</option>"#), "the category kept: {html}");
    assert!(html.contains(r#"name="buyerAcknowledgment" value="0" checked"#), "the box kept: {html}");
    assert!(pilot.calls_to_path("/api/marketplace/listing-evidence-policy/drafts").is_empty(), "nothing written");

    let option = one.replace("selectorKind=category", "selectorKind=option");
    let (_, _, html) = pilot.send(post_as("evidence-manager", page, &format!("{option}&rerow=refresh"), false)).await;
    assert!(html.contains(r#"<option value="opt_mint">Mint (opt_mint)</option>"#), "the option's values: {html}");

    let (status, headers, _) = pilot.send(post_as("evidence-manager", page, &format!("intent=create-draft&{one}"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with(page));
    let sent = pilot.calls_to_path("/api/marketplace/listing-evidence-policy/drafts");
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(body["policyName"], json!("Slabs"));
    let rule = &body["rules"][0];
    assert_eq!(rule["selector"]["categoryIds"], json!(["cat_1"]));
    assert_eq!(rule["outcome"]["minimumPhotoCount"], json!(2.0));
    assert_eq!(rule["outcome"]["requiredSlots"][0]["minimumWidthPixels"], json!(800.0));
    assert_eq!(rule["outcome"]["buyerAcknowledgment"], json!("required"));

    let refused = one.replace("policyName=Slabs", "policyName=refuse");
    let (status, _, html) = pilot.send(post_as("evidence-manager", page, &format!("intent=create-draft&{refused}"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "the API's 400 is the form again: {html}");
    assert!(html.contains("The policy name is taken.") && html.contains(r#"value="refuse""#), "the draft as typed: {html}");
}

#[tokio::test]
async fn a_draft_that_does_not_validate_shows_why_and_activation_is_sent_in_the_operators_zone() {
    let pilot = Pilot::new().await;
    let page = "/platform/listing-evidence-policy";
    let session = "evidence-manager; corten-zone=America/Chicago";
    let (_, _, html) = pilot.send(get(page, Some(session))).await;
    assert_eq!(html.matches(">Validate<").count(), 3, "a draft or a validated version can be validated: {html}");

    let (status, _, html) = pilot.send(post_as(session, page, "intent=validate&policyId=lep_bad", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("rules[0].priority: Priority 100 is used twice."), "the diagnostics: {html}");
    assert!(!html.contains("Activate policy version"), "{html}");

    let (status, _, html) = pilot.send(post_as(session, page, "intent=validate&policyId=lep_3", false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("4 listings would receive changed requirements."), "{html}");
    assert!(html.contains("Added: rule-2") && html.contains("Removed: a"), "{html}");
    assert!(html.contains(r#"name="policyId" value="lep_3""#) && html.contains(r#"value="impact_1""#), "{html}");

    let activate =
        "intent=activate&policyId=lep_3&impactAcknowledgmentHash=impact_1&effectiveFrom=2026-12-01T00%3A00&effectiveUntil=";
    let (status, _, html) = pilot.send(post_as(session, page, activate, false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Review and acknowledge the current Policy Impact Preview."), "{html}");
    let (status, _, html) =
        pilot.send(post_as(session, page, "intent=activate&policyId=lep_3&impactAcknowledged=yes&effectiveFrom=", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(html.contains("Choose a valid effective time before activation."), "{html}");
    assert!(pilot.calls_to_path("/api/marketplace/listing-evidence-policy/drafts/lep_3/activate").is_empty());

    let (status, headers, _) = pilot.send(post_as(session, page, &format!("{activate}&impactAcknowledged=yes"), false)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers[header::LOCATION].to_str().unwrap().starts_with(page));
    let sent = pilot.calls_to_path("/api/marketplace/listing-evidence-policy/drafts/lep_3/activate");
    let body: Value = serde_json::from_str(&sent[0].body).unwrap();
    assert_eq!(
        body,
        json!({ "effectiveFrom": "2026-12-01T06:00:00Z", "effectiveUntil": null, "impactAcknowledgmentHash": "impact_1" }),
        "midnight in Chicago as its instant"
    );
}

/// Platform Operations' ops dashboard: two days of GMV, one top item without a title, and a
/// drift alarm with a ratio and an OK run without one. The summary echoes the window it was asked.
fn ops_dashboard(rest: &str, query: &str) -> Response {
    let param = |name: &str| query.split('&').find_map(|p| p.strip_prefix(&format!("{name}="))).unwrap_or("").to_owned();
    match rest {
        "summary" => Json(json!({
            "from": param("from"), "to": param("to"),
            "summary": { "gmvAmount": "1406.95", "tradeCount": 12, "orderCount": 11, "unitVolume": 14, "verifiedTradeCount": 3,
                "activeBuyerCount": 9, "activeSellerCount": 4 },
            "liquidity": { "asOfDay": param("to"), "sellThroughRate": "0.0444", "medianSpreadAmount": null, "spreadSampleCount": 5 },
            "topCatalogItems": [{ "catalogItemId": "cat_untitled", "title": null, "gmvAmount": "389.00", "tradeCount": 1, "unitVolume": 1 }],
        }))
        .into_response(),
        "series" => Json(json!({
            "from": param("from"), "to": param("to"), "granularity": param("granularity"),
            "series": [
                { "day": "2026-10-29", "gmvAmount": "1000.00", "tradeCount": 10, "unitVolume": 12, "orderCount": 9, "verifiedTradeCount": 3 },
                { "day": "2026-10-30", "gmvAmount": "406.95", "tradeCount": 2, "unitVolume": 2, "orderCount": 2, "verifiedTradeCount": 0 },
            ],
        }))
        .into_response(),
        "reconciliation-runs" => Json(json!({ "items": [
            { "reconciliationRunId": "gmvrec_1", "yearMonth": "2026-09", "tapeGmvAmount": "100.00", "ledgerSaleAmount": "80.00",
              "deltaAmount": "20.00", "deltaRatio": "0.2", "status": "drift-alarm",
              "startedAt": "2026-10-30T22:01:42.751Z", "completedAt": "2026-10-30T22:01:42.751Z" },
            { "reconciliationRunId": "gmvrec_2", "yearMonth": "2026-08", "tapeGmvAmount": "0.00", "ledgerSaleAmount": "0.00",
              "deltaAmount": "0.00", "deltaRatio": null, "status": "ok",
              "startedAt": "2026-09-30T22:01:42.751Z", "completedAt": "2026-09-30T22:01:42.751Z" },
        ], "count": 2 }))
        .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[tokio::test]
async fn the_ops_dashboard_reads_the_range_asked_and_draws_the_trend() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/insights/ops-dashboard", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) =
        pilot.send(get("/platform/insights/ops-dashboard?rangeDays=7&granularity=weekly", Some("insights-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let calls = pilot.calls_to_path("/api/platform/insights/ops/");
    let today = jiff::Timestamp::now().to_zoned(jiff::tz::TimeZone::UTC).date();
    let from = today.checked_sub(jiff::ToSpan::days(6)).unwrap();
    assert!(calls.iter().any(|c| c.path == format!("/api/platform/insights/ops/summary?from={from}&to={today}")), "{calls:?}");
    assert!(
        calls.iter().any(|c| c.path == format!("/api/platform/insights/ops/series?from={from}&to={today}&granularity=weekly")),
        "{calls:?}"
    );
    assert!(calls.iter().any(|c| c.path == "/api/platform/insights/ops/reconciliation-runs?limit=12"), "{calls:?}");
    assert!(html.contains("<title>Ops Dashboard | Chase Sets Admin"), "{html}");
    assert!(
        html.contains(r#"<option value="7" selected>Last 7 days"#) && html.contains(r#"<option value="weekly" selected>Weekly"#),
        "{html}"
    );
    assert!(html.contains(r#"name="rangeDays""#) && html.contains(r#"type="submit""#), "the range can be applied: {html}");
    assert!(html.contains("$1,406.95") && html.contains("4.4%") && html.contains(">Not available<"), "{html}");
    assert!(html.contains(r#"<path d="M12.0,"#) && html.contains("Oct 29, 2026: $1,000.00"), "the line and its points: {html}");
    assert!(html.contains(">cat_untitled<") && html.contains("$389.00"), "an item without a title is its id: {html}");
    assert!(html.contains(">Drift alarm<") && html.contains("$20.00 (20.0%)") && html.contains(">OK<"), "{html}");
    // Anything else is admin-web's default: the last 30 days, by day.
    let (status, _, html) =
        pilot.send(get("/platform/insights/ops-dashboard?rangeDays=14&granularity=hourly", Some("insights-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains(r#"<option value="30" selected>"#) && html.contains(r#"<option value="daily" selected>"#), "{html}");
}

/// Platform Operations' offer economics: one week of sell-through, a share of the platform's GMV,
/// and the reserve not available in this profile; the window echoes what was asked.
fn offer_economics(query: &str) -> Response {
    let from = query.split('&').find_map(|p| p.strip_prefix("from=")).unwrap_or("2026-09-02");
    Json(json!({ "snapshot": {
        "from": from, "to": "2026-10-31", "listingsCreatedCount": 12, "lockedSellerAccountCount": 3, "lockedGmvAmount": "1234.50",
        "lockedTradeCount": 9, "platformGmvAmount": "4000.00", "lockedGmvShareRatio": "0.3086", "standardFeePercentageBps": 650,
        "standardFeeFixedAmount": "0.30", "standardScheduleSource": { "scheduleId": "pol_1", "scheduleLabel": "Standard seller terms" },
        "foregoneFeeEstimateAmount": "82.94",
        "weeklySellThrough": [{ "weekStart": "2026-10-26", "listingsCreatedCount": 4, "cumulativeListingsCreatedCount": 12,
            "tradeCount": 2, "cumulativeTradeCount": 9, "sellThroughRate": "0.75" }],
        "protectionReserve": { "available": false, "reason": "Settlement protection-reserve contribution data is unavailable in this runtime profile." },
    } }))
    .into_response()
}

#[tokio::test]
async fn offer_economics_writes_the_apis_figures_for_the_window_asked() {
    let pilot = Pilot::new().await;
    let (status, _, _) = pilot.send(get("/platform/insights/offer-economics", Some("reader"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, html) =
        pilot.send(get("/platform/insights/offer-economics?from=2026-10-01&to=nonsense", Some("insights-viewer"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(
        pilot
            .calls_to_path("/api/platform/insights/offer-economics")
            .iter()
            .any(|c| c.path.ends_with("/summary?from=2026-10-01")),
        "a date the API cannot read is not sent"
    );
    assert!(html.contains("<title>Offer Economics | Chase Sets Admin") && html.contains("Oct 1, 2026 to Oct 31, 2026"), "{html}");
    assert!(html.contains("$1,234.50") && html.contains("30.9%") && html.contains("$82.94"), "{html}");
    assert!(html.contains("Standard seller terms published schedule: 6.50% + $0.30 per sale."), "{html}");
    assert!(html.contains("Oct 26, 2026") && html.contains("75.0%"), "{html}");
    assert!(html.contains("Pending #4098") && html.contains("unavailable in this runtime profile"), "{html}");
}

const WALLET_API: &str = "/api/settlement/wallet-adjustments";

fn wallet_adjustment(id: &str, status: &str, requested_by: &str, elevation_required: bool) -> Value {
    json!({
        "adjustment_id": id, "status": status, "target_account_id": "acc_1", "display_reference": "WAD-1",
        "direction": "credit", "amount": "25.00", "currency_code": "USD", "reason_code": "fee-correction",
        "explanation": "Refund of a double fee", "evidence_references": ["ord_1"], "reversal_of_adjustment_id": null,
        "reversed_by_adjustment_id": null, "requested_by": requested_by, "requested_at": "2026-10-30T15:00:00.000Z",
        "self_benefiting": false, "approved_by": null, "approved_at": null, "elevation_required": elevation_required,
        "elevation_reasons": [], "elevation_approved_by": null, "rejected_by": null, "rejected_at": null,
        "rejection_reason": null, "posted_at": if status == "posted" { json!("2026-10-30T16:00:00.000Z") } else { Value::Null },
        "available_balance_before": null, "available_balance_after": if status == "posted" { json!("125.00") } else { Value::Null },
        "updated_at": "2026-10-30T16:00:00.000Z"
    })
}

/// Settlement's wallet adjustment API, as far as the workbench uses it.
fn wallet_api(method: &Method, rest: &str, cookie: &str, body: &str) -> Response {
    let sent: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let path = rest.split('?').next().unwrap_or_default();
    let receipt = || {
        let receipt = percent_encoding::utf8_percent_encode(RECEIPT, percent_encoding::NON_ALPHANUMERIC).to_string();
        [("chase-sets-commit-position", "42".to_owned()), ("chase-sets-commit-receipt", receipt)]
    };
    match (method.clone(), path) {
        (Method::GET, "/accounts/acc_1/summary") => Json(json!({
            "account_id": "acc_1", "currency_code": "USD", "pending_balance_amount": "10.00",
            "available_balance_amount": "-4.50", "total_credited_amount": "300.00", "total_debited_amount": "304.50",
            "negative_balance_status": "negative", "negative_balance_started_at": null, "collections_escalated_at": null,
            "opened_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-10-30T16:00:00.000Z"
        }))
        .into_response(),
        (Method::GET, "/accounts/acc_down/summary") => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        (Method::GET, p) if p.ends_with("/summary") => refusal(StatusCode::NOT_FOUND, "not_found", "Account wallet not found."),
        (Method::GET, "/accounts/acc_1/adjustments") => Json(json!({
            "items": [wallet_adjustment("wad_req", "requested", "usr_2", true), wallet_adjustment("wad_post", "posted", "usr_2", false),
                wallet_adjustment("wad_mine", "requested", "usr_1", false)],
            "total": 45, "count": 3
        }))
        .into_response(),
        (Method::GET, "/accounts/acc_1/ledger") => Json(json!({
            "items": [{ "ledger_entry_id": "led_1", "account_id": "acc_1", "kind": "payout", "direction": "debit", "amount": "50.00",
                "currency_code": "USD", "funds_status": "available", "order_id": null, "payment_id": null, "payout_id": "pay_1",
                "description": "Weekly payout", "posted_at": "2026-10-29T12:00:00.000Z", "available_at": null,
                "updated_at": "2026-10-29T12:00:00.000Z" }],
            "total": 1, "count": 1
        }))
        .into_response(),
        (Method::POST, "/preview") if sent["amount"] == "0" => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "validation_failed", "message": "Amount must be a positive money value.",
                "details": [{ "field": "amount", "code": "invalid_amount", "message": "Amount must be a positive money value." }] } })),
        )
            .into_response(),
        (Method::POST, "/preview") => Json(json!({
            "target_account_id": "acc_1", "direction": sent["direction"], "amount": sent["amount"], "currency_code": "USD",
            "reason_code": sent["reasonCode"], "balance_revision": "rev_7", "available_balance_before": "-4.50",
            "available_balance_after": "-1004.50", "pending_balance_amount": "10.00", "cash_equivalent": true, "spendable": false,
            "payoutable": false, "negative_balance_status": "negative", "creates_or_increases_negative_balance": true,
            "high_value": true, "self_benefiting": sent["amount"] == "666",
            "blocked_reason": if sent["amount"] == "666" { json!("self-benefiting") } else { Value::Null },
            "requires_second_approval": true, "elevation_reasons": ["high-value", "negative-balance"],
            "controls": { "high_value_credit_threshold_amount": "500.00", "high_value_debit_threshold_amount": "500.00",
                "recent_auth_max_age_minutes": 15 }
        }))
        .into_response(),
        (Method::POST, "") if cookie.contains("wallet-stepup") => {
            refusal(StatusCode::UNAUTHORIZED, "step_up_required", "Sign in again to make this change.")
        }
        (Method::POST, "") if sent["expectedBalanceRevision"] == "stale" => (
            StatusCode::CONFLICT,
            Json(json!({ "error": { "code": "conflict", "message": "The wallet balance changed since the preview.",
                "details": [{ "code": "stale_balance_revision", "message": "The wallet balance changed since the preview." }] } })),
        )
            .into_response(),
        (Method::POST, "") => (StatusCode::CREATED, receipt(), Json(wallet_adjustment("wad_new", "requested", "usr_1", true))).into_response(),
        (Method::POST, "/wad_req/approve") if sent.get("elevationApprovedByUserId").is_none() => {
            refusal(StatusCode::CONFLICT, "conflict", "This Wallet Adjustment requires a second, elevated approval.")
        }
        (Method::POST, "/wad_req/approve") => (receipt(), Json(wallet_adjustment("wad_req", "posted", "usr_2", true))).into_response(),
        (Method::POST, "/wad_req/reject") => (receipt(), Json(wallet_adjustment("wad_req", "rejected", "usr_2", true))).into_response(),
        (Method::POST, "/wad_post/reverse") => {
            let mut reversal = wallet_adjustment("wad_rev", "posted", "usr_1", true);
            reversal["reversal_of_adjustment_id"] = json!("wad_post");
            let mut original = wallet_adjustment("wad_post", "reversed", "usr_2", false);
            original["reversed_by_adjustment_id"] = json!("wad_rev");
            (StatusCode::CREATED, receipt(), Json(json!({ "original": original, "reversal": reversal }))).into_response()
        }
        (Method::POST, "/wad_down/approve") => StatusCode::BAD_GATEWAY.into_response(),
        _ => refusal(StatusCode::NOT_FOUND, "not_found", "Wallet Adjustment not found."),
    }
}

const WALLET_PAGE: &str = "/commerce/wallet-workbench/acc_1";

#[tokio::test]
async fn the_wallet_workbench_shows_the_balance_the_history_with_its_commands_and_the_ledger() {
    let pilot = Pilot::new().await;
    let (status, _, html) = pilot.send(get(&format!("{WALLET_PAGE}?accountName=Card%20Vault"), Some("wallet-admin"))).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    for text in [
        "<title>Wallet Workbench | Settlement Admin</title>",
        "Wallet for Card Vault",
        "Account: acc_1",
        "-$4.50",
        "$300.00",
        "Negative balance",
        "Payouts restricted",
        "Request adjustment",
        "Request preview",
        "Fee correction",
        "Refund of a double fee",
        "Requested by usr_2",
        "$125.00",
        "Weekly payout",
        r#"name="direction" value="credit" checked"#,
        r#"<option value="transaction-correction" selected"#,
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    // A requested adjustment that needs an elevated approver asks for one in its Approve dialog;
    // the operator's own request cannot be approved by them.
    assert!(
        html.contains(r#"commandfor="wallet-approve-wad_req""#) && html.contains(r#"name="elevationApprovedByUserId""#),
        "{html}"
    );
    assert!(html.contains("You requested this adjustment"), "{html}");
    assert!(html.contains(r#"command="show-modal" commandfor="wallet-approve-wad_mine" disabled"#), "{html}");
    assert!(html.contains(r#"commandfor="wallet-reverse-wad_post""#) && html.contains(r#"name="approvedByUserId""#), "{html}");
    // The filters and the pager keep the account's name.
    assert!(html.contains(r#"href="/commerce/wallet-workbench/acc_1?accountName=Card%20Vault&amp;status=posted""#), "{html}");
    assert!(
        html.contains(r#"href="/commerce/wallet-workbench/acc_1?accountName=Card%20Vault&amp;adjustmentsOffset=20""#),
        "{html}"
    );
    assert!(!html.contains("View payout"), "no payout link without marketplace's origin, as on admin-web: {html}");
    assert!(html.contains(r#"<nav class="wallet-page__buttons" aria-label="Adjustment history">"#), "{html}");
    let reads: Vec<String> = pilot.calls_to(WALLET_API).into_iter().map(|c| c.path).collect();
    assert!(reads.contains(&format!("{WALLET_API}/accounts/acc_1/adjustments?limit=20&offset=0")), "{reads:?}");
    assert!(reads.contains(&format!("{WALLET_API}/accounts/acc_1/ledger?limit=20&offset=0")), "{reads:?}");

    // A viewer sees the wallet without the form or the commands.
    let (status, _, html) = pilot.send(get(WALLET_PAGE, Some("wallet-viewer"))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("Wallet Workbench") && !html.contains("Request preview") && !html.contains("show-modal"), "{html}");
    let (status, _, html) = pilot.send(get("/commerce/wallet-workbench/acc_none", Some("wallet-viewer"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(html.contains("Account wallet not found") && html.contains("acc_none"), "{html}");
    let (status, _, html) = pilot.send(get("/commerce/wallet-workbench/acc_down", Some("wallet-viewer"))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(html.contains("Wallet workbench unavailable"), "{html}");
    assert_eq!(pilot.send(get(WALLET_PAGE, Some("reader"))).await.0, StatusCode::FORBIDDEN);
    let (status, _, _) = pilot.send(post_as("wallet-viewer", WALLET_PAGE, "intent=preview-adjustment&amount=5", false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a command needs its own permission");
    let (status, _, _) = pilot.send(post_as("wallet-admin", WALLET_PAGE, "intent=teleport", false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn a_preview_offers_confirm_and_submit_with_its_balance_revision_and_a_request_shows_its_snapshot() {
    let pilot = Pilot::new().await;
    let form = "intent=preview-adjustment&direction=debit&amount=1000.00&reasonCode=fraud-recovery&explanation=&evidenceReferences=ord_9";
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, form, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent: Value =
        serde_json::from_str(&pilot.calls_to(WALLET_API).into_iter().find(|c| c.method == Method::POST).unwrap().body).unwrap();
    assert_eq!(
        sent,
        json!({ "targetAccountId": "acc_1", "direction": "debit", "amount": "1000.00", "reasonCode": "fraud-recovery" })
    );
    for text in [
        "Available balance after",
        "-$1,004.50",
        "High-value amount; Creates or deepens a negative balance",
        r#"commandfor="wallet-confirm""#,
        r#"name="expectedBalanceRevision" value="rev_7""#,
        r#"name="evidenceReferences" value="ord_9""#,
        r#"name="direction" value="debit" checked"#,
        r#"aria-current="step""#,
    ] {
        assert!(html.contains(text), "{text}: {html}");
    }
    let (_, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, &form.replace("1000.00", "666"), false)).await;
    assert!(
        html.contains("role=\"alert\"") && !html.contains(r#"commandfor="wallet-confirm""#),
        "a self-benefiting preview is blocked: {html}"
    );

    // A field the API refuses keeps the form and names the field.
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, &form.replace("1000.00", "0"), false)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{html}");
    assert!(
        html.contains("Check the adjustment details") && html.contains("<li>Amount must be a positive money value.</li>"),
        "{html}"
    );
    assert!(html.contains(r#"<option value="fraud-recovery" selected"#), "{html}");

    // Confirm & submit: the snapshot is drawn first, read with the write's receipt.
    let request = "intent=request-adjustment&direction=credit&amount=25.00&reasonCode=fee-correction&explanation=Refund&evidenceReferences=ord_1,%20ord_2&expectedBalanceRevision=rev_7";
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, request, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let calls = pilot.calls_to(WALLET_API);
    let sent: Value = serde_json::from_str(&calls.iter().rev().find(|c| c.method == Method::POST).unwrap().body).unwrap();
    assert_eq!(sent["evidenceReferences"], json!(["ord_1", "ord_2"]));
    assert_eq!((sent["explanation"].as_str(), sent["expectedBalanceRevision"].as_str()), (Some("Refund"), Some("rev_7")));
    assert!(calls.last().unwrap().headers.contains_key("chase-sets-read-after-write"), "read after the write");
    assert!(html.contains("Projection catching up") && html.contains("wad_new"), "{html}");
    assert!(html.contains(r#"<option value="transaction-correction" selected"#), "the form starts again: {html}");

    // A stale preview and a session too old for the command are said where they were made.
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, &request.replace("rev_7", "stale"), false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(html.contains("Balance changed since preview") && html.contains(">Refund</textarea>"), "{html}");
    let (status, _, html) = pilot.send(post_as("wallet-stepup", WALLET_PAGE, request, false)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{html}");
    assert!(html.contains("Reauthentication required") && html.contains("Sign in again in a new tab"), "{html}");
    assert!(html.contains(r#"target="_blank""#) && html.contains("returnTo=%2Fcommerce%2Fwallet-workbench%2Facc_1"), "{html}");
}

#[tokio::test]
async fn approve_reject_and_reverse_answer_with_their_snapshots_and_refusals_stay_on_their_row() {
    let pilot = Pilot::new().await;
    let (status, _, html) =
        pilot.send(post_as("wallet-admin", WALLET_PAGE, "intent=approve-adjustment&adjustmentId=wad_req", false)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{html}");
    assert!(html.contains("Second approval required") && html.contains("requires a second, elevated approval"), "{html}");

    let approve = "intent=approve-adjustment&adjustmentId=wad_req&elevationApprovedByUserId=usr_9";
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, approve, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent = pilot.calls_to(WALLET_API).into_iter().rev().find(|c| c.method == Method::POST).unwrap();
    assert_eq!(
        (sent.path.as_str(), sent.body.as_str()),
        ("/api/settlement/wallet-adjustments/wad_req/approve", r#"{"elevationApprovedByUserId":"usr_9"}"#)
    );
    assert!(
        html.contains("Projection catching up") && !html.contains(r#"commandfor="wallet-approve-wad_req""#),
        "posted now: {html}"
    );

    let (status, _, html) = pilot
        .send(post_as("wallet-admin", WALLET_PAGE, "intent=reject-adjustment&adjustmentId=wad_req&rejectionReason=", false))
        .await;
    assert_eq!(status, StatusCode::OK, "{html}");
    assert!(html.contains("Rejected"), "{html}");

    let reverse = "intent=reverse-adjustment&adjustmentId=wad_post&approvedByUserId=usr_8&elevationApprovedByUserId=usr_9&explanation=Wrong%20account";
    let (status, _, html) = pilot.send(post_as("wallet-admin", WALLET_PAGE, reverse, false)).await;
    assert_eq!(status, StatusCode::OK, "{html}");
    let sent: Value =
        serde_json::from_str(&pilot.calls_to(WALLET_API).into_iter().rev().find(|c| c.method == Method::POST).unwrap().body)
            .unwrap();
    assert_eq!(
        sent,
        json!({ "approvedByUserId": "usr_8", "elevationApprovedByUserId": "usr_9", "explanation": "Wrong account" })
    );
    assert!(html.contains("Reversed by wad_rev") && html.contains("Reverses wad_post"), "{html}");

    let (status, _, html) =
        pilot.send(post_as("wallet-admin", WALLET_PAGE, "intent=approve-adjustment&adjustmentId=wad_down", false)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{html}");
    assert!(html.contains("Something went wrong") && html.contains("Approval could not be completed."), "{html}");
}

#[tokio::test]
async fn the_site_files_are_admin_webs() {
    let pilot = Pilot::new().await;
    for path in ["/favicon.svg", "/favicon.ico"] {
        let (status, headers, body) = pilot.send(get(path, None)).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers[header::CONTENT_TYPE], "image/svg+xml; charset=utf-8");
        assert!(body.contains("<svg xmlns=\"http://www.w3.org/2000/svg\""), "{body}");
    }

    // The manifest: admin-web's names, description, colors and four icons, at their versioned URLs.
    let (status, headers, manifest) = pilot.send(get("/manifest.webmanifest", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=3600");
    let manifest: Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["name"], "Chase Sets Admin");
    assert_eq!(manifest["short_name"], "CS Admin");
    assert_eq!(manifest["theme_color"], "#0f766e");
    assert!(manifest["description"].as_str().unwrap().starts_with("Manage Chase Sets catalog"));
    let icons = manifest["icons"].as_array().unwrap();
    assert_eq!(icons.len(), 4);
    for icon in icons {
        let src = icon["src"].as_str().unwrap();
        assert!(src.contains("/icons/chase-sets-admin-"), "{src}");
        let res = pilot.router.clone().oneshot(get(src, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{src}");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png", "{src}");
    }

    // The worker leaves admin-web's sign-in and the API to the network.
    let (status, _, worker) = pilot.send(get("/service-worker.js", None)).await;
    assert_eq!(status, StatusCode::OK);
    for prefix in ["/access/sign-in", "/sign-in", "/api/", "/health/"] {
        assert!(worker.contains(&format!("\"{prefix}\"")), "{prefix}: {worker}");
    }
}

#[tokio::test]
async fn the_offline_page_is_the_same_for_everyone() {
    let pilot = Pilot::new().await;
    for session in [None, Some("staff")] {
        let before = pilot.calls.lock().unwrap().len();
        let (status, headers, page) = pilot.send(get("/offline", session)).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        // A request with a cookie is answered privately (Corten's rule for every `Public` answer).
        let cache = headers[header::CACHE_CONTROL].to_str().unwrap();
        assert!(if session.is_none() { cache.starts_with("public, max-age=0") } else { cache.starts_with("private") }, "{cache}");
        assert!(page.contains("<title>Offline | Chase Sets Admin</title>"), "{page}");
        assert!(page.contains("Admin is offline"), "{page}");
        assert!(page.contains(r#"href="">Try again</a>"#), "{page}");
        assert!(page.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#), "{page}");
        // No staff member's nav, and nothing asked of the API.
        assert!(!page.contains("<nav"), "{page}");
        assert_eq!(pilot.calls.lock().unwrap().len(), before);
    }
}
