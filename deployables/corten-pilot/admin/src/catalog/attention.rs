//! The Catalog attention queue on the scopes list (admin-web's `CatalogAttentionQueuePanel` in
//! the scope landing's supplementary slot): what needs an operator, most important first, read
//! from `GET /api/catalog/attention-queue` with the page. An item's Review opens its sheet, drawn
//! by the server when opened (a patch with the script, the page without), with its evidence and
//! the two park forms. Parking posts `/api/catalog/attention-queue/commands` and returns to the
//! list, which reads after the write and offers Restore. An alias candidate's Accept and Reject
//! post the alias review's command, as admin-web's one-click buttons do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/scopes/attention/review?<filters>&item` | an item's sheet: a patch, or the list with it open |
//! | `POST /catalog/scopes/attention/dismiss?<filters>`, `.../defer` | parks the item (a reason; defer for 24 h) |
//! | `POST /catalog/scopes/attention/restore?<filters>` | brings a parked item back |
//! | `POST /catalog/scopes/attention/alias/accept?<filters>`, `.../reject` | an alias candidate's one-click command |
//!
//! The panel trusts the API's counts. admin-web recomputes them from the items and rejects a
//! queue whose counts differ, which chase-sets/chase-sets#10507 removes.
use std::collections::BTreeMap;

use corten::{axum::http::HeaderMap, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Sent,
    api::{AttentionItem, AttentionKind, Kind},
    command, receipt,
    scopes::{self, ScopeBack, url::ScopeQuery},
    views::{self, Draft},
};
use crate::{
    api::Method,
    app::Shared,
    text::{Cat, Pilot},
};

pub mod url {
    use corten::Route;
    use serde::Deserialize;

    use crate::catalog::scopes::url::ScopeQuery;

    /// An item's sheet, opened from the list with its filters.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route("/catalog/scopes/attention/review")]
    pub struct AttentionReview {
        #[route(query)]
        pub query: ScopeQuery,
        #[route(query)]
        pub item: ReviewItem,
    }

    /// The item whose sheet is open.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct ReviewItem {
        pub item: Option<String>,
    }

    #[derive(Route)]
    #[route("/catalog/scopes/attention/dismiss")]
    pub struct AttentionDismiss {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[derive(Route)]
    #[route("/catalog/scopes/attention/defer")]
    pub struct AttentionDefer {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[derive(Route)]
    #[route("/catalog/scopes/attention/restore")]
    pub struct AttentionRestore {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[derive(Route)]
    #[route("/catalog/scopes/attention/alias/accept")]
    pub struct AliasAccept {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[derive(Route)]
    #[route("/catalog/scopes/attention/alias/reject")]
    pub struct AliasReject {
        #[route(query)]
        pub query: ScopeQuery,
    }
}

/// Dismiss or defer: the item, its kind (the API keys the parking by both) and why.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ParkInput {
    pub item_key: String,
    pub kind: String,
    pub reason: String,
}

impl ParkInput {
    pub fn of(item: &AttentionItem) -> Self {
        ParkInput { item_key: item.item_key.clone(), kind: item.kind.as_str().to_owned(), reason: String::new() }
    }
}

/// Restore: the item a park took out of the queue.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct RestoreInput {
    pub item_key: String,
}

/// An alias candidate's command: its hashes (comma separated, as the API takes them) and, for a
/// reject, the reason admin-web sends (the button's label).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct AliasInput {
    pub alias_hashes: String,
    pub reason: String,
}

/// Which park form came back, refused, in place of a blank one.
#[derive(Clone, Debug)]
pub enum Parked {
    Dismiss(Draft<ParkInput>),
    Defer(Draft<ParkInput>),
}

pub fn routes(
    area: Area<crate::auth::Session, super::url::Catalog>,
    shared: Shared,
) -> Area<crate::auth::Session, super::url::Catalog> {
    area.route::<url::AttentionReview>(get(review).with_state(shared.clone()))
        .route::<url::AttentionDismiss>(post(dismiss).with_state(shared.clone()))
        .route::<url::AttentionDefer>(post(defer).with_state(shared.clone()))
        .route::<url::AttentionRestore>(post(restore).with_state(shared.clone()))
        .route::<url::AliasAccept>(post(alias_accept).with_state(shared.clone()))
        .route::<url::AliasReject>(post(alias_reject).with_state(shared))
}

/// An item's sheet: with the script, the sheet alone (the queue read again for the item); without,
/// the list with it open.
async fn review(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Query(item): Query<url::ReviewItem>,
) -> corten::Result {
    let key = item.item.unwrap_or_default();
    if req.mode == Mode::Action {
        let caller = config.platform.caller(&headers, config.proto, None);
        let queue = scopes::read_queue(&caller).await;
        let found = queue.as_ref().ok().and_then(|q| q.items.iter().find(|i| i.item_key == key));
        let t: Cat = req.t();
        return req.patch(views::AttentionSheet { t, query: &query, item: found, parked: None, manage: super::manages(&req) });
    }
    scopes::render(&req, &config, &headers, &query, &scopes::url::ScopeNotice::default(), ScopeBack::Review(key, None)).await
}

async fn dismiss(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Form(input): Form<ParkInput>,
) -> corten::Result {
    park(req, config, headers, query, input, false).await
}

async fn defer(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Form(input): Form<ParkInput>,
) -> corten::Result {
    park(req, config, headers, query, input, true).await
}

/// `handleAttentionQueueCommand`'s dismiss and defer: the pilot checks only that the reason is
/// there and the kind is one the queue has; the API checks the rest.
async fn park(req: Req, config: Shared, headers: HeaderMap, query: ScopeQuery, input: ParkInput, defer: bool) -> corten::Result {
    let (t, p): (Cat, Pilot) = (req.t(), req.t());
    let f = ParkInput::FIELDS;
    let mut errors = Errors::new();
    let kind = serde_json::from_value::<AttentionKind>(Value::String(input.kind.clone()));
    if input.item_key.trim().is_empty() || kind.is_err() {
        errors.add_form(p.catalog_action());
    }
    if input.reason.trim().is_empty() {
        errors.add(f.reason, t.feedback_reason_required());
    }
    if errors.is_empty() {
        let mut body = json!({
            "intent": if defer { "defer" } else { "dismiss" },
            "itemKey": input.item_key.trim(),
            "kind": input.kind,
            "reason": input.reason.trim(),
        });
        if defer {
            // admin-web's form: re-surface in 24 hours.
            body["deferHours"] = json!(24);
        }
        let caller = config.platform.caller(&headers, config.proto, None);
        match command(&caller, Method::POST, Kind::AttentionQueue, "/commands", Some(&body)).await {
            Sent::Written(written) => {
                let notice = scopes::url::ScopeNotice {
                    after_write: receipt(&written),
                    done: Some(scopes::url::AttentionDone::Queued),
                    parked: Some(input.item_key.trim().to_owned()),
                };
                return req.redirect(&scopes::url::Scopes { query, notice });
            }
            Sent::Refused(refusal) => errors = refusal,
            Sent::Denied(denied) => return denied.answer(&req),
        }
    }
    let draft = Draft { input, errors: errors.clone() };
    let key = draft.input.item_key.clone();
    let parked = if defer { Parked::Defer(draft) } else { Parked::Dismiss(draft) };
    let form = views::park_form(t, &query, &parked, super::manages(&req));
    let notice = scopes::url::ScopeNotice::default();
    req.invalid(&errors, form, || {
        scopes::render(&req, &config, &headers, &query, &notice, ScopeBack::Review(key.clone(), Some(parked.clone())))
    })
    .await
}

/// Restore after a park: the list again, without the Restore it offered.
async fn restore(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Form(input): Form<RestoreInput>,
) -> corten::Result {
    let body = json!({ "intent": "restore", "itemKey": input.item_key.trim() });
    queued(&req, &config, &headers, query, Kind::AttentionQueue, &body).await
}

async fn alias_accept(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Form(input): Form<AliasInput>,
) -> corten::Result {
    alias(req, config, headers, query, input, "accept").await
}

async fn alias_reject(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<ScopeQuery>,
    Form(input): Form<AliasInput>,
) -> corten::Result {
    alias(req, config, headers, query, input, "reject").await
}

/// `handleAliasReviewCommand`: accept or reject the candidates (a reject needs its reason).
async fn alias(
    req: Req,
    config: Shared,
    headers: HeaderMap,
    query: ScopeQuery,
    input: AliasInput,
    intent: &str,
) -> corten::Result {
    let hashes: Vec<&str> = input.alias_hashes.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
    let reason = input.reason.trim();
    if hashes.is_empty() || (intent == "reject" && reason.is_empty()) {
        return failed(&req, query);
    }
    let mut body = json!({ "intent": intent, "aliasHashes": hashes.join(",") });
    if !reason.is_empty() {
        body["reason"] = json!(reason);
    }
    queued(&req, &config, &headers, query, Kind::AliasReview, &body).await
}

/// A one-click command: the list after it, with admin-web's banner (queued, or the command failed).
async fn queued(req: &Req, config: &Shared, headers: &HeaderMap, query: ScopeQuery, kind: Kind, body: &Value) -> corten::Result {
    let caller = config.platform.caller(headers, config.proto, None);
    match command(&caller, Method::POST, kind, "/commands", Some(body)).await {
        Sent::Written(written) => {
            let notice = scopes::url::ScopeNotice {
                after_write: receipt(&written),
                done: Some(scopes::url::AttentionDone::Queued),
                parked: None,
            };
            req.redirect(&scopes::url::Scopes { query, notice })
        }
        // As admin-web's dispatcher: the banner says the command failed, without the API's words.
        Sent::Refused(_) => failed(req, query),
        Sent::Denied(denied) => denied.answer(req),
    }
}

fn failed(req: &Req, query: ScopeQuery) -> corten::Result {
    let notice = scopes::url::ScopeNotice { done: Some(scopes::url::AttentionDone::Failed), ..Default::default() };
    req.redirect(&scopes::url::Scopes { query, notice })
}

/// A parameter of an item's message, as text (the API sends strings and numbers).
fn param(params: &BTreeMap<String, Value>, name: &str) -> String {
    match params.get(name) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// An item's title or detail, or a resolution's label, from the API's message key and arguments.
///
/// Workaround for todd-skelton/corten#54: `messages!` has no lookup by key, so this matches the
/// keys the queue's collectors use (features/attention-queue/read-model/collectors.ts) to their
/// methods. A key it does not know is shown as the key; admin-web shows `[missing:en:<key>]`.
pub fn item_text(t: Cat, key: &str, params: &BTreeMap<String, Value>) -> String {
    let a = |name: &str| param(params, name);
    let Some(name) = key.strip_prefix("catalog.features.attentionQueue.") else {
        return key.to_owned();
    };
    match name {
        "item.unmappedScope.title" => t.attention_item_unmapped_scope_title(a("label"), a("provider")).to_string(),
        "item.unmappedScope.detail" => t.attention_item_unmapped_scope_detail(a("unit"), a("confidence")).to_string(),
        "item.mergeConflict.title" => t.attention_item_merge_conflict_title(a("conflicts"), a("candidate")).to_string(),
        "item.mergeConflict.detail" => t.attention_item_merge_conflict_detail(a("observations"), a("reason")).to_string(),
        "item.mergeStale.title" => t.attention_item_merge_stale_title(a("candidate")).to_string(),
        "item.mergeStale.detail" => t.attention_item_merge_stale_detail(a("observations"), a("reason")).to_string(),
        "item.providerHealth.title" => t.attention_item_provider_health_title(a("unit"), a("provider")).to_string(),
        "item.providerHealth.detail" => t.attention_item_provider_health_detail(a("blocker"), a("code")).to_string(),
        "item.importJob.title" => t.attention_item_import_job_title(a("job"), a("status")).to_string(),
        "item.importJob.detail" => t.attention_item_import_job_detail(a("provider"), a("action"), a("scope")).to_string(),
        "item.aliasCandidate.title" => t.attention_item_alias_candidate_title(a("alias")).to_string(),
        "item.aliasCandidate.detail" => {
            t.attention_item_alias_candidate_detail(a("provider"), a("type"), a("confidence")).to_string()
        }
        "item.staleScopeSync.title" => t.attention_item_stale_scope_sync_title(a("scope"), a("domain")).to_string(),
        "item.staleScopeSync.detail" => t.attention_item_stale_scope_sync_detail(a("kind"), a("updatedAt")).to_string(),
        "action.reviewMapping" => t.attention_action_review_mapping().to_owned(),
        "action.resolveConflict" => t.attention_action_resolve_conflict().to_owned(),
        "action.reviewHealth" => t.attention_action_review_health().to_owned(),
        "action.reviewJob" => t.attention_action_review_job().to_owned(),
        "action.acceptAlias" => t.attention_action_accept_alias().to_owned(),
        "action.rejectAlias" => t.attention_action_reject_alias().to_owned(),
        "action.reviewScopeSync" => t.attention_action_review_scope_sync().to_owned(),
        _ => key.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_items_text_is_its_message_with_the_apis_arguments() {
        let t = Cat::default();
        let params: BTreeMap<String, Value> =
            serde_json::from_value(json!({ "unit": "TCGplayer Magic Single Cards", "provider": "tcgplayer" })).unwrap();
        assert_eq!(
            item_text(t, "catalog.features.attentionQueue.item.providerHealth.title", &params),
            "Unblock TCGplayer Magic Single Cards on tcgplayer"
        );
        let numbers: BTreeMap<String, Value> = serde_json::from_value(json!({ "candidate": "mc_1", "conflicts": 2 })).unwrap();
        assert_eq!(
            item_text(t, "catalog.features.attentionQueue.item.mergeConflict.title", &numbers),
            "Resolve 2 blocking conflicts on mc_1"
        );
        let stale: BTreeMap<String, Value> =
            serde_json::from_value(json!({ "kind": "expansion", "updatedAt": "2026-10-01T00:00:00Z" })).unwrap();
        assert_eq!(
            item_text(t, "catalog.features.attentionQueue.item.staleScopeSync.detail", &stale),
            "expansion · last refreshed 2026-10-01T00:00:00Z"
        );
        assert_eq!(item_text(t, "catalog.features.attentionQueue.action.reviewHealth", &BTreeMap::new()), "Review health");
        assert_eq!(item_text(t, "catalog.other.key", &BTreeMap::new()), "catalog.other.key", "an unknown key is itself");
    }
}
