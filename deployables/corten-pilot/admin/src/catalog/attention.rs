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
//! | `POST /catalog/scopes/aliases?<filters>` | a candidate's command in the all-scopes alias review |
//!
//! The panel trusts the API's counts and coverage. admin-web's loader checks them against each
//! other (counts against each kind's coverage, coverage against the window and the items) and
//! rejects a queue where they disagree; the pilot leaves that to the API that computed them.
use std::fmt::Display;

use corten::{
    http::HeaderMap,
    i18n::{Args, Found},
    prelude::*,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    Sent,
    api::{AliasReview, AttentionItem, AttentionKind, Catalog, Kind},
    command, receipt,
    scopes::{self, ScopeBack, url::ScopeQuery},
    views::{self, Draft},
};
use crate::{
    api::Method,
    app::Shared,
    auth::{CatalogAccess, Staff, Viewer},
    text::{Cat, Pilot},
};

/// The screen's routes in the catalog area, with their handlers (the area's caller: `CatalogAccess`).
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    use crate::catalog::scopes::url::ScopeQuery;

    /// An item's sheet, opened from the list with its filters.
    #[derive(Clone, Debug, Default, Deserialize)]
    #[route("/catalog/scopes/attention/review", get = review)]
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

    #[route("/catalog/scopes/attention/dismiss", post = dismiss)]
    pub struct AttentionDismiss {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[route("/catalog/scopes/attention/defer", post = defer)]
    pub struct AttentionDefer {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[route("/catalog/scopes/attention/restore", post = restore)]
    pub struct AttentionRestore {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[route("/catalog/scopes/attention/alias/accept", post = alias_accept)]
    pub struct AliasAccept {
        #[route(query)]
        pub query: ScopeQuery,
    }

    #[route("/catalog/scopes/attention/alias/reject", post = alias_reject)]
    pub struct AliasReject {
        #[route(query)]
        pub query: ScopeQuery,
    }

    /// A candidate's command in the all-scopes alias review.
    #[route("/catalog/scopes/aliases", post = alias_review)]
    pub struct AliasReviewCommand {
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

/// An item's sheet: with the script, the sheet alone (the queue read again for the item); without,
/// the list with it open.
async fn review(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AttentionReview>,
) -> HtmlResult {
    let (query, item) = (route.query, route.item);
    let key = item.item.unwrap_or_default();
    if req.mode == Mode::Action {
        let caller = config.platform.caller(&headers, config.proto, None);
        let queue = scopes::read_queue(&caller, &query).await;
        let found = queue.as_ref().ok().and_then(|q| q.items.iter().find(|i| i.item_key == key));
        let (t, p): (Cat, Pilot) = (req.t(), req.t());
        return req.patch(views::AttentionSheet {
            t,
            p,
            query: &query,
            item: found,
            parked: None,
            manage: super::manages(&staff.viewer),
        });
    }
    scopes::render(
        &req,
        &staff.viewer,
        &config,
        &headers,
        &query,
        &scopes::url::ScopeNotice::default(),
        ScopeBack::Review(key, None),
    )
    .await
}

async fn dismiss(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AttentionDismiss>,
    Form(input): Form<ParkInput>,
) -> HtmlResult {
    let query = route.query;
    park(req, &staff.viewer, config, headers, query, input, false).await
}

async fn defer(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AttentionDefer>,
    Form(input): Form<ParkInput>,
) -> HtmlResult {
    let query = route.query;
    park(req, &staff.viewer, config, headers, query, input, true).await
}

/// `handleAttentionQueueCommand`'s dismiss and defer: the pilot checks only that the reason is
/// there and the kind is one the queue has; the API checks the rest.
async fn park(
    req: Req,
    viewer: &Viewer,
    config: Shared,
    headers: HeaderMap,
    query: ScopeQuery,
    input: ParkInput,
    defer: bool,
) -> HtmlResult {
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
    let form = views::park_form(t, &query, &parked, super::manages(viewer));
    let notice = scopes::url::ScopeNotice::default();
    req.invalid(&errors, form, || {
        scopes::render(&req, viewer, &config, &headers, &query, &notice, ScopeBack::Review(key.clone(), Some(parked.clone())))
    })
    .await
}

/// Restore after a park: the list again, without the Restore it offered.
async fn restore(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AttentionRestore>,
    Form(input): Form<RestoreInput>,
) -> HtmlResult {
    let query = route.query;
    let body = json!({ "intent": "restore", "itemKey": input.item_key.trim() });
    queued(&req, &config, &headers, query, Kind::AttentionQueue, &body).await
}

async fn alias_accept(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AliasAccept>,
    Form(input): Form<AliasInput>,
) -> HtmlResult {
    let query = route.query;
    alias(req, config, headers, query, input, "accept").await
}

async fn alias_reject(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AliasReject>,
    Form(input): Form<AliasInput>,
) -> HtmlResult {
    let query = route.query;
    alias(req, config, headers, query, input, "reject").await
}

/// `handleAliasReviewCommand`: accept or reject the candidates (a reject needs its reason).
async fn alias(req: Req, config: Shared, headers: HeaderMap, query: ScopeQuery, input: AliasInput, intent: &str) -> HtmlResult {
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

/// A candidate's command in the all-scopes alias review (`handleAliasReviewCommand`): accept,
/// reject or revoke post the alias review's command; defer writes nothing (the candidate stays
/// pending) and says queued, as admin-web's does. A reject or revoke with no reason, or no
/// candidate, is the failed banner. The bulk bar posts its checked boxes as `picked`, and its
/// Auto-accept eligible (`alias.accept-eligible`) accepts only those the review marks eligible,
/// read again here: admin-web's sends every picked candidate (chase-sets/chase-sets#11024).
async fn alias_review(
    req: Req,
    _: corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    corten::Params(route): corten::Params<crate::catalog::attention::url::AliasReviewCommand>,
    Form(input): Form<crate::catalog::scope::url::AliasCommand>,
) -> HtmlResult {
    let query = route.query;
    let caller = config.platform.caller(&headers, config.proto, None);
    match alias_command_body(&caller, &input, "?limit=200").await {
        Ok(Some(body)) => queued(&req, &config, &headers, query, Kind::AliasReview, &body).await,
        Ok(None) => {
            let notice = scopes::url::ScopeNotice { done: Some(scopes::url::AttentionDone::Queued), ..Default::default() };
            req.redirect(&scopes::url::Scopes { query, notice })
        }
        Err(()) => failed(&req, query),
    }
}

/// What an alias review command sends (`handleAliasReviewCommand`): the alias review's command
/// body, `None` for a defer (it writes nothing), or `Err` for one it cannot send: no candidate, a
/// reject or revoke without its reason, an intent it does not offer, or an Auto-accept eligible
/// with none eligible. Auto-accept eligible keeps the picked candidates the review read with
/// `review_query` marks eligible: admin-web's sends every picked one (chase-sets/chase-sets#11024).
pub(crate) async fn alias_command_body(
    caller: &crate::api::Caller<'_>,
    input: &crate::catalog::scope::url::AliasCommand,
    review_query: &str,
) -> Result<Option<Value>, ()> {
    let mut hashes: Vec<&str> = Vec::new();
    let named = input.alias_hashes.split(',').chain(input.picked.iter().map(String::as_str));
    for hash in named.map(str::trim).filter(|h| !h.is_empty()) {
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    let reason = input.reason.trim();
    let eligible_only = input.intent == ACCEPT_ELIGIBLE;
    let intent = match input.intent.as_str() {
        "alias.accept" | ACCEPT_ELIGIBLE => "accept",
        "alias.reject" => "reject",
        "alias.revoke" => "revoke",
        "alias.defer" => "defer",
        _ => return Err(()),
    };
    if hashes.is_empty() || (matches!(intent, "reject" | "revoke") && reason.is_empty()) {
        return Err(());
    }
    if intent == "defer" {
        return Ok(None);
    }
    if eligible_only {
        // Workaround for chase-sets/chase-sets#11024: remove once the API's command takes the rule.
        match caller.read_at::<AliasReview>(Kind::AliasReview, review_query).await {
            Ok(review) => hashes.retain(|hash| review.candidates.iter().any(|c| c.alias_hash == *hash && c.auto_accept.eligible)),
            Err(error) => {
                tracing::warn!("the alias review could not be read for Auto-accept eligible: {error}");
                return Err(());
            }
        }
        if hashes.is_empty() {
            return Err(());
        }
    }
    let mut body = json!({ "intent": intent, "aliasHashes": hashes.join(",") });
    if !reason.is_empty() {
        body["reason"] = json!(reason);
    }
    Ok(Some(body))
}

/// A one-click command: the list after it, with admin-web's banner (queued, or the command failed).
async fn queued(req: &Req, config: &Shared, headers: &HeaderMap, query: ScopeQuery, kind: Kind, body: &Value) -> HtmlResult {
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

/// The bulk bar's Auto-accept eligible: an accept of the picked candidates the review marks eligible.
pub const ACCEPT_ELIGIBLE: &str = "alias.accept-eligible";

fn failed(req: &Req, query: ScopeQuery) -> HtmlResult {
    let notice = scopes::url::ScopeNotice { done: Some(scopes::url::AttentionDone::Failed), ..Default::default() };
    req.redirect(&scopes::url::Scopes { query, notice })
}

/// An API message key as the pilot's catalog files it: `export.mjs` writes
/// `catalog.features.attentionQueue.<rest>` as `attention.<rest>`, each segment in snake case.
fn catalog_key(key: &str) -> Option<String> {
    let rest = key.strip_prefix("catalog.features.attentionQueue.")?;
    let mut out = String::from("attention");
    for segment in rest.split('.') {
        out.push('.');
        out.push_str(&crate::text::snake_case(segment));
    }
    Some(out)
}

/// An item's message arguments as the API sends them, for `t.by_key`.
pub struct Params<'a> {
    own: &'a Map<String, Value>,
}

impl<'a> Params<'a> {
    /// A title's arguments.
    pub fn title(item: &'a AttentionItem) -> Self {
        Params { own: &item.title_params }
    }

    /// A detail's arguments.
    pub fn detail(item: &'a AttentionItem) -> Self {
        Params { own: &item.detail_params }
    }

    /// A resolution's label, which has none.
    pub fn none() -> Self {
        static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
        Params { own: &EMPTY }
    }
}

impl Args for Params<'_> {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.own.arg(name, write)
    }
}

/// An API message in the page: the catalog's message (`t.by_key`, escaped), or its key when the
/// catalog lacks it or an argument is missing (admin-web shows `[missing:en:<key>]`).
pub struct Shown<'a> {
    found: Option<Found<'a, Params<'a>>>,
    key: &'a str,
}

/// `key`'s message with `args`.
pub fn shown<'a>(t: Cat, key: &'a str, args: &'a Params<'a>) -> Shown<'a> {
    Shown { found: catalog_key(key).and_then(|k| t.by_key(&k, args)), key }
}

impl Render for Shown<'_> {
    fn render(&self, out: &mut String) {
        match &self.found {
            Some(message) => message.render(out),
            None => self.key.render(out),
        }
    }
}

impl Display for Shown<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.found {
            Some(message) => message.fmt(f),
            None => f.write_str(self.key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::api::{Resolution, ResolutionMode, Severity};

    fn item(title_key: &str, title: Value, detail_key: &str, detail: Value) -> AttentionItem {
        let map = |v: Value| v.as_object().cloned().unwrap_or_default();
        AttentionItem {
            item_key: "k".into(),
            kind: AttentionKind::AliasCandidate,
            severity: Severity::Info,
            title_key: title_key.into(),
            title_params: map(title),
            detail_key: detail_key.into(),
            detail_params: map(detail),
            provider_key: None,
            unit_key: None,
            observed_at: String::new(),
            resolution: Resolution {
                intent: "alias.accept".into(),
                mode: ResolutionMode::Command,
                label_key: "catalog.features.attentionQueue.action.acceptAlias".into(),
                fields: Default::default(),
                href: None,
                requires_reason: false,
                unavailable: false,
            },
            secondary_resolutions: vec![],
        }
    }

    #[test]
    fn an_items_text_is_its_message_with_the_apis_arguments() {
        let t = Cat::default();
        let alias = item(
            "catalog.features.attentionQueue.item.aliasCandidate.title",
            json!({ "alias": "Elsa & Anna", "type": "printed-name" }),
            "catalog.features.attentionQueue.item.aliasCandidate.detail",
            json!({ "provider": "tcgplayer", "type": "printed-name", "confidence": 0.92 }),
        );
        let title = Params::title(&alias);
        assert_eq!(shown(t, &alias.title_key, &title).to_string(), "Review alias Elsa & Anna", "a string without its quotes");
        let message = shown(t, &alias.title_key, &title);
        let html = html! { <p>{message}</p> }.to_html();
        assert_eq!(html, "<p>Review alias Elsa &amp; Anna</p>", "escaped in the page");
        let detail = Params::detail(&alias);
        assert_eq!(
            shown(t, &alias.detail_key, &detail).to_string(),
            "tcgplayer · printed-name · confidence 0.92",
            "the detail's own {{type}}"
        );
        let title_only = item(
            "catalog.features.attentionQueue.item.aliasCandidate.title",
            json!({ "alias": "Elsa & Anna", "type": "printed-name" }),
            "catalog.features.attentionQueue.item.aliasCandidate.detail",
            json!({ "provider": "tcgplayer", "confidence": 0.92 }),
        );
        let detail = Params::detail(&title_only);
        assert_eq!(
            shown(t, &title_only.detail_key, &detail).to_string(),
            title_only.detail_key,
            "a detail is drawn from its own arguments, not the title's"
        );

        let stale = item(
            "catalog.features.attentionQueue.item.staleScopeSync.title",
            json!({ "scope": "Base Set", "domain": "pokemon" }),
            "catalog.features.attentionQueue.item.staleScopeSync.detail",
            json!({ "kind": "expansion", "updatedAt": "2026-10-01T00:00:00Z" }),
        );
        let detail = Params::detail(&stale);
        assert_eq!(
            shown(t, &stale.detail_key, &detail).to_string(),
            "expansion · last refreshed 2026-10-01T00:00:00Z",
            "a camelCase argument"
        );

        let none = Params::none();
        assert_eq!(shown(t, "catalog.features.attentionQueue.action.reviewHealth", &none).to_string(), "Review health");
        assert_eq!(shown(t, "catalog.other.key", &none).to_string(), "catalog.other.key", "an unknown key is itself");
        let missing = Params::title(&stale);
        assert_eq!(shown(t, &stale.detail_key, &missing).to_string(), stale.detail_key, "a missing argument shows the key");
    }
}
