//! Platform > Policy Console (admin-web's `/platform/policy-console`, Platform Operations'
//! `PolicyConsolePage` and `PolicyConsoleDetailPage`): every runtime-configurable policy grouped by
//! its owning context, the Commercial Terms dates that need attention, the public articles waiting
//! for a policy review, and a policy's page with what is in effect, what is scheduled, its revision
//! history and a revision form. Read from `/api/platform/policy-console`,
//! `/api/platform/public-doc-reviews` and `/api/platform/commercial-terms-attention`; reading needs
//! `platform-policy.view` and writing `platform-policy.manage`, as the API's routes do.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/policy-console` | the console |
//! | `POST /platform/policy-console` | a review's confirmation (`locale`, `articleSlug`, `policyKey`), then the console |
//! | `GET /platform/policy-console/{policy_key}` | a policy's page |
//! | `POST /platform/policy-console/{policy_key}` | a revision (`value`, `status`, `effectiveFrom`, `effectiveUntil`), then the page |
//!
//! The effective times are `datetime-local` fields, read in the operator's zone as admin-web reads
//! them. The pilot draws the form in that zone
//! (`DrawZone::from(req.zone())`, UTC until the browser has said, and named by each field), the
//! form sends that zone back (`FormZone`), and the post reads the times in it and sends the
//! instant. A blank effective-from is now, as in admin-web. Times sent without the form's zone (not
//! from this page) are refused.
use std::collections::BTreeMap;

use corten::{
    ClientZone,
    form::{DrawZone, FormZone},
    http::{HeaderMap, StatusCode},
    i18n::LocalDateTime,
    prelude::*,
};
use jiff::Timestamp;
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod views;

use crate::{
    api::{Method, segment},
    app::{Refusal, Shared, read_failed, refusal, refusal_answer as answer},
    auth::{PolicyAccess, Staff, Viewer},
    growth::promo::{sent, zone_of},
    text::{Ops, Pilot},
    views::Here,
};

const CONTEXT: &str = "platform-operations";
const CONSOLE: &str = "/api/platform/policy-console";
const REVIEWS: &str = "/api/platform/public-doc-reviews";
const ATTENTION: &str = "/api/platform/commercial-terms-attention";
/// Who may revise a policy or confirm a review.
pub const MANAGE: &str = "platform-policy.manage";

#[corten::routes(state = crate::app::Shared, area = crate::policy_console::url::Console, caller = crate::auth::Staff<crate::auth::PolicyAccess>)]
pub mod url {
    /// The console, after the confirmation whose receipt the address carries; a `POST` confirms
    /// a review.
    #[derive(Clone, Debug, Default)]
    #[route("/platform/policy-console", get = console, post = confirm)]
    pub struct Console {
        pub after_write: Option<String>,
    }

    /// A policy's page, after the revision whose receipt the address carries; a `POST` revises it.
    #[route("/platform/policy-console/{policy_key}", get = policy, post = revise)]
    pub struct Policy<'a> {
        pub policy_key: &'a str,
        pub after_write: Option<String>,
    }
}

/// The area: its routes and its stylesheets.
pub fn area(area: Area<url::Console>, shared: Shared) -> Area<url::Console> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// A policy in the registry (`PolicyConsoleRegistryItem`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub policy_key: String,
    pub context_name: String,
    pub schema_summary: String,
    pub status: String,
    #[serde(default)]
    pub effective_from: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub items: Vec<Entry>,
    pub commercial_terms_schedules_href: String,
}

/// A public article waiting for a policy review (`PublicDocReviewQueueItem`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub locale: String,
    pub article_slug: String,
    pub article_title: String,
    pub article_href: String,
    pub policy_key: String,
    pub age_days: u64,
}

/// A Commercial Terms date that needs attention (`CommercialTermsAttentionItem`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct TermsDate {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub href: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
pub struct Items<T> {
    #[serde(default = "Vec::new")]
    pub items: Vec<T>,
}

/// The console: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ConsoleScreen {
    pub registry: Registry,
    pub reviews: Vec<Review>,
    pub attention: Vec<TermsDate>,
    pub can_manage: bool,
    /// Why the last confirmation was refused.
    pub refusal: Option<String>,
}

impl ConsoleScreen {
    /// The policies by owning context, the contexts in name order and each context's in the API's.
    pub fn groups(&self) -> Vec<(&str, Vec<&Entry>)> {
        let mut groups: BTreeMap<&str, Vec<&Entry>> = BTreeMap::new();
        for entry in &self.registry.items {
            groups.entry(entry.context_name.as_str()).or_default().push(entry);
        }
        groups.into_iter().collect()
    }
}

/// A context's name as a title (admin-web's `contextLabel`: each hyphenated word capitalized).
pub fn context_label(name: &str) -> String {
    name.split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn console(
    req: Req,
    Caller(staff): Caller<Staff<PolicyAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Console>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let here = Here(zone_of(zone));
    draw_console(&req, &staff.viewer, &config, &headers, &here, receipt.as_ref(), None, StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw_console(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    here: &Here,
    receipt: Option<&Receipt>,
    refusal: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let read = tokio::try_join!(
        caller.read::<Registry>(CONSOLE, CONTEXT),
        caller.read::<Items<Review>>(REVIEWS, CONTEXT),
        caller.read::<Items<TermsDate>>(ATTENTION, CONTEXT),
    );
    let (registry, reviews, attention) = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen =
        ConsoleScreen { registry, reviews: reviews.items, attention: attention.items, can_manage: viewer.can(MANAGE), refusal };
    let o: Ops = req.t();
    let view = html! { <views::PolicyConsolePage o={o} req={req} here={here} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={o.policy_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// A review's confirmation, as admin-web's form names it.
#[derive(Clone, Debug, Default, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct ConfirmForm {
    pub locale: String,
    pub article_slug: String,
    pub policy_key: String,
}

async fn confirm(
    req: Req,
    Caller(staff): Caller<Staff<PolicyAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Form(form): Form<ConfirmForm>,
) -> HtmlResult {
    let path = format!(
        "{REVIEWS}/{}/{}/{}/confirm",
        segment(form.locale.trim()),
        segment(form.article_slug.trim()),
        segment(form.policy_key.trim())
    );
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.write::<Value>(caller.request(Method::POST, &path, CONTEXT).json(&json!({}))).await {
        Ok((_, receipt)) => req.redirect(&url::Console { after_write: receipt.map(|r| r.param()) }),
        Err(error) => match refusal(&req, error) {
            Refusal::Again(status, message) => {
                let here = Here(zone_of(zone));
                draw_console(&req, &staff.viewer, &config, &headers, &here, None, Some(message), status).await
            }
            other => answer(&req, other),
        },
    }
}

/// What is in effect now, or the compiled default (`PolicyConsoleOverview.current`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub source: String,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub effective_from: Option<String>,
    #[serde(default)]
    pub effective_until: Option<String>,
}

/// A revision scheduled for later.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Upcoming {
    pub document_id: String,
    #[serde(default)]
    pub value: Value,
    pub effective_from: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub policy_key: String,
    pub context_name: String,
    pub schema_summary: String,
    pub current: Current,
    #[serde(default)]
    pub upcoming: Vec<Upcoming>,
}

/// A revision history row (the API's snake case).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct HistoryRow {
    pub history_id: String,
    pub event_type: String,
    pub actor_user_id: String,
    pub status: String,
    pub effective_from: String,
    #[serde(default)]
    pub effective_until: Option<String>,
    pub recorded_at: String,
}

#[derive(Deserialize)]
struct Document {
    #[serde(default)]
    history: Vec<HistoryRow>,
}

/// A revision as the form sends it (admin-web's names).
#[derive(Clone, Debug, Default, Serialize, Fields, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct RevisionForm {
    pub value: String,
    pub status: String,
    /// Not in the screen's data: the times in effect are the overview's.
    #[serde(skip_serializing)]
    pub effective_from: corten::Entry<LocalDateTime>,
    #[serde(skip_serializing)]
    pub effective_until: corten::Entry<LocalDateTime>,
    /// The zone the form was drawn in, which its times are read in.
    #[serde(skip_serializing)]
    pub zone: Option<FormZone>,
}

/// Why a revision was not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Unsent {
    /// The value does not read as JSON.
    Value,
    /// It has a time but not the zone the form was drawn in.
    Zone,
}

impl RevisionForm {
    /// The form for a policy: its value as indented JSON and its status; the times blank.
    pub fn of(current: &Current) -> Self {
        RevisionForm {
            value: serde_json::to_string_pretty(&current.value).unwrap_or_default(),
            status: current.status.clone().unwrap_or_else(|| "active".into()),
            ..RevisionForm::default()
        }
    }

    /// The API's body: the value read as JSON, active unless inactive, and the times as instants in
    /// the form's zone (effective-from now when blank, as admin-web does).
    pub fn body(&self, now: Timestamp) -> Result<Value, Unsent> {
        let value: Value = serde_json::from_str(&self.value).map_err(|_| Unsent::Value)?;
        let zone = self.zone.as_ref();
        let from = match sent(&self.effective_from, zone).ok_or(Unsent::Zone)? {
            Value::Null => json!(now.to_string()),
            from => from,
        };
        let until = sent(&self.effective_until, zone).ok_or(Unsent::Zone)?;
        Ok(json!({
            "value": value,
            "status": if self.status == "inactive" { "inactive" } else { "active" },
            "effectiveFrom": from,
            "effectiveUntil": until,
        }))
    }
}

/// A policy's page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct PolicyScreen {
    pub overview: Overview,
    pub history: Vec<HistoryRow>,
    pub can_manage: bool,
    pub form: RevisionForm,
    /// Why the last revision was refused.
    pub refusal: Option<String>,
}

async fn policy(
    req: Req,
    Caller(staff): Caller<Staff<PolicyAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Policy<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let here = Here(zone_of(zone));
    let drawn_in = DrawZone::from(req.zone());
    draw_policy(
        &req,
        &staff.viewer,
        &config,
        &headers,
        (&here, &drawn_in),
        &route.policy_key,
        receipt.as_ref(),
        None,
        StatusCode::OK,
    )
    .await
}

/// The page's dates are written in the operator's zone (`Here`); the revision form's times are
/// drawn in its `DrawZone`, the posted one when a revision is drawn again.
#[allow(clippy::too_many_arguments)]
async fn draw_policy(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    (here, drawn_in): (&Here, &DrawZone),
    policy_key: &str,
    receipt: Option<&Receipt>,
    refused: Option<(RevisionForm, String)>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let key = segment(policy_key);
    let overview = match caller.read::<Overview>(&format!("{CONSOLE}/{key}"), CONTEXT).await {
        Ok(overview) => overview,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let history = match &overview.current.document_id {
        Some(id) => match caller.read::<Document>(&format!("{CONSOLE}/{key}/documents/{}", segment(id)), CONTEXT).await {
            Ok(document) => document.history,
            Err(error) => return read_failed(req, error, receipt.is_some()),
        },
        None => Vec::new(),
    };
    let (form, refusal) = match refused {
        Some((form, message)) => (form, Some(message)),
        None => (RevisionForm::of(&overview.current), None),
    };
    let screen = PolicyScreen { overview, history, can_manage: viewer.can(MANAGE), form, refusal };
    let view = html! { <views::PolicyDetailPage o={req.t()} here={here} zone={drawn_in} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={&screen.overview.policy_key} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

async fn revise(
    req: Req,
    Caller(staff): Caller<Staff<PolicyAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Policy<'_>>,
    Form(form): Form<RevisionForm>,
) -> HtmlResult {
    let here = Here(zone_of(zone));
    let drawn_in = form.zone.as_ref().map_or_else(|| DrawZone::from(req.zone()), DrawZone::from);
    let key = route.policy_key.as_str();
    let again = |form: RevisionForm, message: String, status: StatusCode| {
        let (req, viewer, config, headers, here, drawn_in) = (&req, &staff.viewer, &config, &headers, &here, &drawn_in);
        async move { draw_policy(req, viewer, config, headers, (here, drawn_in), key, None, Some((form, message)), status).await }
    };
    let body = match form.body(Timestamp::now()) {
        Ok(body) => body,
        Err(unsent) => {
            let (o, p): (Ops, Pilot) = (req.t(), req.t());
            let message = match unsent {
                Unsent::Value => o.policy_detail_invalid_json(),
                Unsent::Zone => p.check_zone(),
            };
            return again(form, message.to_owned(), StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    let path = format!("{CONSOLE}/{}/revisions", segment(key));
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.write::<Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((_, receipt)) => req.redirect(&url::Policy { policy_key: key, after_write: receipt.map(|r| r.param()) }),
        Err(error) => match refusal(&req, error) {
            Refusal::Again(status, message) => again(form, message, status).await,
            other => answer(&req, other),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_context_reads_as_a_title_and_a_revision_as_the_apis_body() {
        assert_eq!(context_label("platform-operations"), "Platform Operations");
        assert_eq!(context_label("pricing"), "Pricing");
        let now: Timestamp = "2026-10-31T12:00:00Z".parse().unwrap();
        let posted = |form: &[u8]| corten::form::from_bytes::<RevisionForm>(form).unwrap();
        let form = posted(
            b"value=%7B%22a%22%3A1%7D&status=inactive&effectiveFrom=2026-11-02T09%3A00&effectiveUntil=&zone=America%2FChicago",
        );
        assert_eq!(
            form.body(now),
            Ok(json!({ "value": { "a": 1 }, "status": "inactive",
                "effectiveFrom": "2026-11-02T15:00:00Z", "effectiveUntil": null })),
            "9:00 in Chicago, after its clocks go back, is 15:00 UTC"
        );
        assert_eq!(
            posted(b"value=1&status=anything").body(now),
            Ok(json!({ "value": 1, "status": "active", "effectiveFrom": "2026-10-31T12:00:00Z", "effectiveUntil": null })),
            "a blank effective-from is now, and any status but inactive is active"
        );
        assert_eq!(posted(b"value=%7Bnope").body(now), Err(Unsent::Value));
        assert_eq!(posted(b"value=1&effectiveUntil=2026-11-02T09%3A00").body(now), Err(Unsent::Zone), "a time without the zone");
    }
}
