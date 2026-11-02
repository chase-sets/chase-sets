//! Platform > Listing Evidence Policy (admin-web's `/platform/listing-evidence-policy`,
//! Marketplace's `ListingEvidencePolicyPage`): the policy in effect, its versions with Validate,
//! Reject and Create rollback draft, a validated draft's semantic diff and Policy Impact Preview
//! with Activate, and the guided draft form. Read from and written to
//! `/api/marketplace/listing-evidence-policy`; reading needs `listing-evidence-policy.view`, and
//! each write the permission the API asks for it (`.draft`, `.validate` or `.activate`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/listing-evidence-policy` | the page |
//! | `POST /platform/listing-evidence-policy` | a write (`intent`: create-draft, validate, reject, rollback, activate), or the draft form with a rule more or less (`rerow`) |
//!
//! The guided form is drawn by the server: Add rule, Remove rule and Show values (the values of
//! the selector chosen) post the form and draw it again, writing nothing, so it works without
//! JavaScript. A rule's fields are parallel lists, one entry per rule; Require buyer acknowledgment
//! sends its rule's index.
//!
//! Where admin-web falls short the pilot does not: an invalid draft's diagnostics are shown
//! (chase-sets/chase-sets#10878), Validate is offered for a validated draft as well as a draft so
//! a validated one can still be activated (chase-sets/chase-sets#10879), the effective times are read
//! and written in the operator's zone (chase-sets/chase-sets#10880), and a write comes back here,
//! under `/platform` (chase-sets/chase-sets#10877).
//!
//! Two of the API's own faults show through: the read after a write may not show it yet
//! (chase-sets/chase-sets#10881), and Validate fails for every draft (chase-sets/chase-sets#10882).
use corten::{
    ClientZone,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use jiff::tz::TimeZone;
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod views;

use crate::{
    api::{ApiError, Method, segment},
    app::{Refusal, Shared, read_failed, refusal, refusal_answer},
    auth::{EvidenceView, Staff, Viewer},
    growth::promo::{sent_time, zone_of},
    text::Ops,
    views::Here,
};

const CONTEXT: &str = "marketplace";
const BASE: &str = "/api/marketplace/listing-evidence-policy";
pub const DRAFT: &str = "listing-evidence-policy.draft";
pub const VALIDATE: &str = "listing-evidence-policy.validate";
pub const ACTIVATE: &str = "listing-evidence-policy.activate";

#[corten::routes(state = crate::app::Shared, area = crate::evidence::url::Evidence, caller = crate::auth::Staff<crate::auth::EvidenceView>)]
pub mod url {
    /// The page, after the write whose receipt the address carries; a `POST` is a write.
    #[derive(Clone, Debug, Default)]
    #[route("/platform/listing-evidence-policy", get = page, post = act)]
    pub struct Evidence {
        pub after_write: Option<String>,
    }
}

/// The area: its route and its stylesheet.
pub fn area(area: Area<url::Evidence>, shared: Shared) -> Area<url::Evidence> {
    url::area(area, shared).components(views::COMPONENTS)
}

/// A policy value's rules (the page counts them).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct PolicyValue {
    pub rules: Vec<Value>,
}

/// The policy in effect, or the compiled fallback.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    #[serde(default)]
    pub policy_id: Option<String>,
    #[serde(default)]
    pub version: Option<u64>,
    pub hash: String,
    #[serde(default)]
    pub effective_from: Option<String>,
    #[serde(default)]
    pub effective_until: Option<String>,
    #[serde(default)]
    pub value: PolicyValue,
}

/// A policy version.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub policy_id: String,
    pub version: u64,
    pub lifecycle: String,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Overview {
    pub current: Current,
    #[serde(default)]
    pub documents: Vec<Version>,
}

/// A value a selector can name.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// The values each selector can name (`ListingEvidencePolicySelectorCatalog`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Selectors {
    pub catalog_items: Vec<Choice>,
    pub products: Vec<Choice>,
    pub blueprints: Vec<Choice>,
    pub categories: Vec<Choice>,
    pub options: Vec<Choice>,
    pub seller_risk_levels: Vec<Choice>,
}

impl Selectors {
    /// The values a selector kind chooses among (admin-web's `optionsForSelector`); none for a
    /// kind that is typed or has no value.
    pub fn of(&self, kind: &str) -> &[Choice] {
        match kind {
            "catalog-item" => &self.catalog_items,
            "product" => &self.products,
            "blueprint" => &self.blueprints,
            "category" => &self.categories,
            "option" => &self.options,
            "seller-risk" => &self.seller_risk_levels,
            _ => &[],
        }
    }
}

/// The selector kinds, in admin-web's order.
pub const KINDS: [&str; 11] = [
    "all",
    "catalog-item",
    "product",
    "blueprint",
    "category",
    "option",
    "graded-item",
    "price",
    "seller-reviews",
    "seller-badge",
    "seller-risk",
];

/// The named evidence slot sets, in admin-web's order.
pub const VIEW_SETS: [&str; 3] = ["none", "condition", "slab-front-back"];

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default)]
pub struct Diagnostic {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Diff {
    pub added_rule_ids: Vec<String>,
    pub changed_rule_ids: Vec<String>,
    pub removed_rule_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Impact {
    pub impacted_listing_count: u64,
    pub preview_hash: String,
}

/// A draft's validation: what the API answers Validate with, valid or not.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub valid: bool,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
    #[serde(default)]
    pub semantic_diff: Diff,
    #[serde(default)]
    pub impact_preview: Impact,
    pub document_id: String,
}

/// A rule in the guided form (admin-web's `GuidedRule`), as typed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, ToJson)]
pub struct Row {
    pub rule_id: String,
    pub explanation_code: String,
    pub priority: String,
    pub selector_kind: String,
    pub selector_value: String,
    pub minimum_price: String,
    pub maximum_price: String,
    pub minimum_photo_count: String,
    pub view_set: String,
    pub minimum_width_pixels: String,
    pub minimum_height_pixels: String,
    pub maximum_age_hours: String,
    pub minimum_trust_reviews: String,
    pub accepted_badge_key: String,
    pub buyer_acknowledgment: bool,
}

impl Row {
    /// Rule `n` as admin-web starts it (`emptyRule`).
    pub fn new(n: usize) -> Self {
        Row {
            rule_id: format!("rule-{n}"),
            explanation_code: "listing-evidence.configured-rule".into(),
            priority: (n * 100).to_string(),
            selector_kind: "all".into(),
            minimum_photo_count: "0".into(),
            view_set: "none".into(),
            minimum_trust_reviews: "0".into(),
            ..Row::default()
        }
    }
}

/// Every write's and every redraw's fields, as admin-web's forms name them; a rule's are lists.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default, rename_all = "camelCase")]
pub struct Posted {
    pub intent: String,
    pub policy_id: String,
    pub policy_name: String,
    pub rule_id: Vec<String>,
    pub explanation_code: Vec<String>,
    pub priority: Vec<String>,
    pub selector_kind: Vec<String>,
    pub selector_value: Vec<String>,
    pub minimum_price: Vec<String>,
    pub maximum_price: Vec<String>,
    pub minimum_photo_count: Vec<String>,
    pub view_set: Vec<String>,
    pub minimum_width_pixels: Vec<String>,
    pub minimum_height_pixels: Vec<String>,
    pub maximum_age_hours: Vec<String>,
    pub minimum_trust_reviews: Vec<String>,
    pub accepted_badge_key: Vec<String>,
    /// The indices of the rules whose box is checked.
    pub buyer_acknowledgment: Vec<String>,
    /// `add`, `refresh` or a rule's index to remove: draw the form again and write nothing.
    pub rerow: Option<String>,
    pub effective_from: String,
    pub effective_until: String,
    pub impact_acknowledged: String,
    pub impact_acknowledgment_hash: String,
}

/// The guided draft as typed.
#[derive(Clone, Debug, Serialize, ToJson)]
pub struct Draft {
    pub policy_name: String,
    pub rows: Vec<Row>,
}

impl Draft {
    /// A new draft: admin-web's default name and one rule.
    pub fn fresh(o: Ops) -> Self {
        Draft { policy_name: o.lep_default_policy_name().to_owned(), rows: vec![Row::new(1)] }
    }

    /// The draft a form posted.
    pub fn of(posted: &Posted) -> Self {
        let at = |list: &[String], i: usize| list.get(i).cloned().unwrap_or_default();
        let checked = |i: usize| posted.buyer_acknowledgment.iter().any(|v| v.parse::<usize>().ok() == Some(i));
        let rows = (0..posted.rule_id.len())
            .map(|i| Row {
                rule_id: at(&posted.rule_id, i),
                explanation_code: at(&posted.explanation_code, i),
                priority: at(&posted.priority, i),
                selector_kind: at(&posted.selector_kind, i),
                selector_value: at(&posted.selector_value, i),
                minimum_price: at(&posted.minimum_price, i),
                maximum_price: at(&posted.maximum_price, i),
                minimum_photo_count: at(&posted.minimum_photo_count, i),
                view_set: at(&posted.view_set, i),
                minimum_width_pixels: at(&posted.minimum_width_pixels, i),
                minimum_height_pixels: at(&posted.minimum_height_pixels, i),
                maximum_age_hours: at(&posted.maximum_age_hours, i),
                minimum_trust_reviews: at(&posted.minimum_trust_reviews, i),
                accepted_badge_key: at(&posted.accepted_badge_key, i),
                buyer_acknowledgment: checked(i),
            })
            .collect();
        Draft { policy_name: posted.policy_name.clone(), rows }
    }

    /// The draft after a `rerow` button: a rule more (numbered after the highest `rule-N`, so
    /// its id is new), a rule less (never the last), or as it was, to show the values of the
    /// selectors chosen. None for a write.
    pub fn rerowed(posted: &Posted) -> Option<Self> {
        let mut draft = Draft::of(posted);
        match posted.rerow.as_deref()? {
            "add" => {
                let highest = draft
                    .rows
                    .iter()
                    .filter_map(|r| r.rule_id.strip_prefix("rule-").and_then(|n| n.parse::<usize>().ok()))
                    .max()
                    .unwrap_or(0);
                draft.rows.push(Row::new(highest.max(draft.rows.len()) + 1));
            }
            "refresh" => {}
            index => {
                if let Some(i) = index.parse::<usize>().ok().filter(|i| *i < draft.rows.len() && draft.rows.len() > 1) {
                    draft.rows.remove(i);
                }
            }
        }
        if draft.rows.is_empty() {
            draft.rows.push(Row::new(1));
        }
        Some(draft)
    }

    /// `POST /drafts`'s body: the name, and each rule as admin-web's `toPolicyRule` writes it.
    pub fn body(&self, selectors: &Selectors) -> Value {
        json!({
            "policyName": self.policy_name.trim(),
            "rules": self.rows.iter().map(|row| rule(row, selectors)).collect::<Vec<_>>(),
        })
    }
}

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A rule as admin-web's `toPolicyRule` writes it. A selector value that is not one of its kind's
/// values counts as none, as admin-web clears the value when the kind changes.
pub fn rule(row: &Row, selectors: &Selectors) -> Value {
    let kind = row.selector_kind.as_str();
    let value = row.selector_value.trim();
    let listed = selectors.of(kind);
    let chosen = if listed.is_empty() {
        Some(value).filter(|v| !v.is_empty())
    } else {
        listed.iter().find(|c| c.id == value).map(|c| c.id.as_str())
    };
    let one = |k: &str| match chosen {
        Some(v) if kind == k => vec![v],
        _ => vec![],
    };
    let option = (kind == "option")
        .then(|| listed.iter().find(|c| Some(c.id.as_str()) == chosen).and_then(|c| c.parent_id.clone()))
        .flatten();
    let options: Vec<Value> = match (option, chosen) {
        (Some(dimension), Some(choice)) => vec![json!({ "dimensionId": dimension, "optionId": choice })],
        _ => vec![],
    };
    let (low, high) = (row.minimum_price.trim(), row.maximum_price.trim());
    let price_band = (kind == "price" && (!low.is_empty() || !high.is_empty())).then(|| {
        json!({
            "minimumAmount": Some(low).filter(|v| !v.is_empty()),
            "maximumAmount": Some(high).filter(|v| !v.is_empty()),
        })
    });
    let constraint = |text: &str| number(text).map(|n| json!(n));
    let constraints = json!({
        "minimumWidthPixels": constraint(&row.minimum_width_pixels),
        "minimumHeightPixels": constraint(&row.minimum_height_pixels),
        "maximumAgeHours": constraint(&row.maximum_age_hours),
    });
    let slot = |view: &str| {
        let mut slot = constraints.clone();
        slot["slotId"] = json!(view);
        slot["viewKind"] = json!(view);
        slot
    };
    let slots: Vec<Value> = match row.view_set.as_str() {
        "slab-front-back" => ["slab", "front", "back"].into_iter().map(slot).collect(),
        "condition" => vec![slot("condition")],
        _ => vec![],
    };
    let trust_reviews = number(&row.minimum_trust_reviews).unwrap_or(0.0);
    let badge = row.accepted_badge_key.trim();
    let seller_trust = (trust_reviews > 0.0 || !badge.is_empty()).then(|| {
        json!({
            "satisfaction": "any",
            "minimumReviewCount": trust_reviews,
            "acceptedBadgeKeys": if badge.is_empty() { vec![] } else { vec![badge] },
        })
    });
    json!({
        "ruleId": row.rule_id,
        "explanationCode": row.explanation_code,
        "priority": number(&row.priority).unwrap_or(0.0),
        "selector": {
            "catalogItemIds": one("catalog-item"),
            "productIds": one("product"),
            "blueprintIds": one("blueprint"),
            "categoryIds": one("category"),
            "options": options,
            "gradedItem": if kind == "graded-item" { json!(true) } else { Value::Null },
            "priceBand": price_band,
            "seller": {
                "minimumReviewCount": if kind == "seller-reviews" { chosen.and_then(number) } else { None },
                "badgeKeys": one("seller-badge"),
                "riskLevels": one("seller-risk"),
            },
        },
        "outcome": {
            "minimumPhotoCount": number(&row.minimum_photo_count).unwrap_or(0.0),
            "requiredSlots": slots,
            "sellerTrust": seller_trust,
            "buyerAcknowledgment": if row.buyer_acknowledgment { "required" } else { "none" },
        },
    })
}

/// The page: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct EvidenceScreen {
    pub overview: Overview,
    pub selectors: Selectors,
    pub validation: Option<Validation>,
    pub refusal: Option<String>,
    pub draft: Draft,
    pub can_draft: bool,
    pub can_validate: bool,
    pub can_activate: bool,
}

/// What a page drawn after a post keeps: the validation it answered, why it was refused, and the
/// draft as typed.
#[derive(Default)]
struct Kept {
    validation: Option<Validation>,
    refusal: Option<String>,
    draft: Option<Draft>,
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<EvidenceView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Evidence>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let zone = zone_of(zone);
    draw(&req, &staff.viewer, &config, &headers, &zone, receipt.as_ref(), Kept::default(), StatusCode::OK).await
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    zone: &TimeZone,
    receipt: Option<&Receipt>,
    kept: Kept,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt);
    let selectors_path = format!("{BASE}/selectors");
    let read = tokio::try_join!(caller.read::<Overview>(BASE, CONTEXT), caller.read::<Selectors>(&selectors_path, CONTEXT));
    let (overview, selectors) = match read {
        Ok(read) => read,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let o: Ops = req.t();
    let screen = EvidenceScreen {
        overview,
        selectors,
        validation: kept.validation,
        refusal: kept.refusal,
        draft: kept.draft.unwrap_or_else(|| Draft::fresh(o)),
        can_draft: viewer.can(DRAFT),
        can_validate: viewer.can(VALIDATE),
        can_activate: viewer.can(ACTIVATE),
    };
    let here = Here(zone.clone());
    let view = html! { <views::ListingEvidencePage o={o} p={req.t()} here={&here} screen={&screen} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={o.lep_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// Validate's answer: the validation, valid (200) or not (422, which is not a refusal: its body is
/// the validation), and the receipt the next read waits for.
async fn validate(
    caller: &crate::api::Caller<'_>,
    policy_id: &str,
) -> Result<(Validation, Option<Receipt>, StatusCode), ApiError> {
    let path = format!("{BASE}/drafts/{}/validate", segment(policy_id));
    let res = caller.request(Method::POST, &path, CONTEXT).json(&json!({})).send().await?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let receipt = Receipt::from_response(res.headers());
    match status {
        StatusCode::OK | StatusCode::UNPROCESSABLE_ENTITY => Ok((res.json().await?, receipt, status)),
        _ => {
            #[derive(Deserialize, Default)]
            struct Refused {
                #[serde(default)]
                error: Reason,
            }
            #[derive(Deserialize, Default)]
            struct Reason {
                code: Option<String>,
                #[serde(default)]
                message: String,
            }
            let body: Refused = res.json().await.unwrap_or_default();
            Err(ApiError::Status { status, code: body.error.code, message: body.error.message })
        }
    }
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<EvidenceView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Form(posted): Form<Posted>,
) -> HtmlResult {
    let zone = zone_of(zone);
    let viewer = &staff.viewer;
    let again = |kept: Kept, status: StatusCode| {
        let (req, config, headers, zone) = (&req, &config, &headers, &zone);
        async move { draw(req, viewer, config, headers, zone, None, kept, status).await }
    };
    if let Some(draft) = Draft::rerowed(&posted) {
        return again(Kept { draft: Some(draft), ..Kept::default() }, StatusCode::OK).await;
    }
    let o: Ops = req.t();
    let needs = match posted.intent.as_str() {
        "create-draft" | "reject" | "rollback" => DRAFT,
        "validate" => VALIDATE,
        "activate" => ACTIVATE,
        _ => {
            let kept = Kept { refusal: Some(o.lep_intent_invalid().to_owned()), ..Kept::default() };
            return again(kept, StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    if !viewer.can(needs) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    let id = segment(posted.policy_id.trim());
    let draft = (posted.intent == "create-draft").then(|| Draft::of(&posted));
    let (path, body) = match posted.intent.as_str() {
        "validate" => {
            return match validate(&caller, posted.policy_id.trim()).await {
                Ok((validation, receipt, status)) => {
                    let kept = Kept { validation: Some(validation), ..Kept::default() };
                    draw(&req, viewer, &config, &headers, &zone, receipt.as_ref(), kept, status).await
                }
                Err(error) => match refusal(&req, error) {
                    Refusal::Again(status, message) => again(Kept { refusal: Some(message), ..Kept::default() }, status).await,
                    other => refusal_answer(&req, other),
                },
            };
        }
        "create-draft" => {
            let selectors = match caller.read::<Selectors>(&format!("{BASE}/selectors"), CONTEXT).await {
                Ok(selectors) => selectors,
                Err(error) => return read_failed(&req, error, false),
            };
            (format!("{BASE}/drafts"), draft.as_ref().map(|d| d.body(&selectors)).unwrap_or_default())
        }
        "reject" => (format!("{BASE}/drafts/{id}/reject"), json!({})),
        "rollback" => (format!("{BASE}/documents/{id}/rollback-draft"), json!({})),
        _ => {
            let refused = |message: &str| Kept { refusal: Some(message.to_owned()), ..Kept::default() };
            if posted.impact_acknowledged != "yes" {
                return again(refused(o.lep_impact_required()), StatusCode::UNPROCESSABLE_ENTITY).await;
            }
            let from = sent_time(&posted.effective_from, &zone);
            if !from.as_str().is_some_and(|f| f.parse::<jiff::Timestamp>().is_ok()) {
                return again(refused(o.lep_effective_required()), StatusCode::UNPROCESSABLE_ENTITY).await;
            }
            let body = json!({
                "effectiveFrom": from,
                "effectiveUntil": sent_time(&posted.effective_until, &zone),
                "impactAcknowledgmentHash": posted.impact_acknowledgment_hash,
            });
            (format!("{BASE}/drafts/{id}/activate"), body)
        }
    };
    match caller.write::<Value>(caller.request(Method::POST, &path, CONTEXT).json(&body)).await {
        Ok((_, receipt)) => req.redirect(&url::Evidence { after_write: receipt.map(|r| r.param()) }),
        Err(error) => match refusal(&req, error) {
            Refusal::Again(status, message) => again(Kept { refusal: Some(message), draft, ..Kept::default() }, status).await,
            other => refusal_answer(&req, other),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selectors() -> Selectors {
        let choice =
            |id: &str, parent: Option<&str>| Choice { id: id.into(), label: id.into(), parent_id: parent.map(Into::into) };
        Selectors {
            categories: vec![choice("cat_1", None)],
            options: vec![choice("opt_mint", Some("dim_condition"))],
            ..Selectors::default()
        }
    }

    #[test]
    fn a_guided_rule_is_written_as_admin_webs_to_policy_rule() {
        let row = Row {
            selector_kind: "option".into(),
            selector_value: "opt_mint".into(),
            view_set: "slab-front-back".into(),
            minimum_width_pixels: "800".into(),
            minimum_trust_reviews: "5".into(),
            buyer_acknowledgment: true,
            ..Row::new(2)
        };
        let rule = rule(&row, &selectors());
        assert_eq!(rule["ruleId"], json!("rule-2"));
        assert_eq!(rule["priority"], json!(200.0));
        assert_eq!(rule["selector"]["options"], json!([{ "dimensionId": "dim_condition", "optionId": "opt_mint" }]));
        assert_eq!(rule["selector"]["categoryIds"], json!([]));
        let slots = rule["outcome"]["requiredSlots"].as_array().unwrap();
        assert_eq!(slots.len(), 3);
        assert_eq!(
            slots[0],
            json!({ "slotId": "slab", "viewKind": "slab", "minimumWidthPixels": 800.0,
            "minimumHeightPixels": null, "maximumAgeHours": null })
        );
        assert_eq!(
            rule["outcome"]["sellerTrust"],
            json!({ "satisfaction": "any", "minimumReviewCount": 5.0, "acceptedBadgeKeys": [] })
        );
        assert_eq!(rule["outcome"]["buyerAcknowledgment"], json!("required"));

        let stale = Row { selector_kind: "category".into(), selector_value: "opt_mint".into(), ..Row::new(1) };
        assert_eq!(rule_of(&stale)["selector"]["categoryIds"], json!([]), "a value of another kind is none");
        let price = Row { selector_kind: "price".into(), minimum_price: "10.00".into(), ..Row::new(1) };
        assert_eq!(rule_of(&price)["selector"]["priceBand"], json!({ "minimumAmount": "10.00", "maximumAmount": null }));
        let reviews = Row { selector_kind: "seller-reviews".into(), selector_value: "x".into(), ..Row::new(1) };
        assert_eq!(rule_of(&reviews)["selector"]["seller"]["minimumReviewCount"], Value::Null);
    }

    fn rule_of(row: &Row) -> Value {
        rule(row, &selectors())
    }

    #[test]
    fn rules_are_added_and_removed_without_reusing_an_id() {
        let posted = |ids: &[&str], rerow: &str| Posted {
            rule_id: ids.iter().map(|s| s.to_string()).collect(),
            buyer_acknowledgment: vec!["1".into()],
            rerow: Some(rerow.into()),
            ..Posted::default()
        };
        let added = Draft::rerowed(&posted(&["rule-1", "rule-3"], "add")).unwrap();
        assert_eq!(added.rows.iter().map(|r| r.rule_id.as_str()).collect::<Vec<_>>(), ["rule-1", "rule-3", "rule-4"]);
        assert!(added.rows[1].buyer_acknowledgment && !added.rows[0].buyer_acknowledgment);
        let removed = Draft::rerowed(&posted(&["rule-1", "rule-3"], "0")).unwrap();
        assert_eq!(removed.rows.len(), 1);
        assert!(removed.rows[0].buyer_acknowledgment, "the checked rule kept its box");
        let last = Draft::rerowed(&posted(&["rule-1"], "0")).unwrap();
        assert_eq!(last.rows.len(), 1, "never the last rule");
        assert!(Draft::rerowed(&Posted::default()).is_none(), "a write");
    }
}
