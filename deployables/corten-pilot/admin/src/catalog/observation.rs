//! Catalog > a Source Observation (admin-web's `/catalog/source-observations/{id}`,
//! `SourceObservationDetailPage`): one provider record as the Catalog API observed it, with
//! Promote (an observed or changed one) and Reject (an observed one), through the Catalog API's
//! review routes (`/api/catalog/source-observations/{id}`, `.../promote`, `.../reject`).
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /catalog/source-observations/{id}?after_write&done` | the observation; `POST` promotes or rejects it |
//!
//! Reading needs `catalog.view` and a review `catalog.manage`, as the API asks. admin-web links to
//! this page from nowhere (its workbench opens an evidence sheet instead), so neither does the
//! pilot; its way back is admin-web's workbench. A review the API refuses (a rollout control, an
//! observation no longer reviewable) is the form's message here; admin-web shows nothing then
//! (chase-sets/chase-sets#10896).
//! Reject without a reason sends admin-web's default one, "Rejected during review.".
use corten::{axum::http::HeaderMap, prelude::*};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    Sent,
    api::{Catalog as _, Kind, under},
    command, manages, receipt, views,
};
use crate::{
    api::Method,
    app::{Shared, read_failed},
    auth::{CatalogAccess, Staff, Viewer},
    text::Cat,
};

#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogAccess>)]
pub mod url {
    /// An observation, after the review whose receipt the address carries.
    #[route("/catalog/source-observations/{id}", get = crate::catalog::observation::page, post = crate::catalog::observation::review)]
    pub struct Observation<'a> {
        pub id: &'a str,
        pub after_write: Option<String>,
        pub done: Option<super::Reviewed>,
    }
}

/// What a review did, for the page it redirects to (admin-web's toasts).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, corten::UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum Reviewed {
    Promoted,
    Rejected,
}

/// A provider product's SKU (`SourceObservationExternalProductReference`), by its key.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
#[serde(rename_all = "camelCase")]
pub struct Sku {
    pub external_key: String,
}

/// The normalized record (`SourceObservationNormalized`): the fields the page shows. A Pokemon
/// card's and a provider product's own fields are read only for those kinds.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct Normalized {
    pub kind: String,
    pub name: String,
    pub set_name: Option<String>,
    pub expansion_name: Option<String>,
    pub card_number: Option<String>,
    pub image_urls: Vec<String>,
    pub card_variant_label: Option<String>,
    pub rarity: Option<String>,
    pub image_disclaimer: Option<String>,
    pub illustrator: Option<String>,
    pub release_date: Option<String>,
    pub provider_product_id: Option<String>,
    pub product_line_name: Option<String>,
    pub product_category_name: Option<String>,
    pub sku_references: Vec<Sku>,
}

/// The observation (`SourceObservationDetail`), without its redacted source payload, which the
/// page does not show.
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Observation {
    pub observation_id: String,
    pub provider_key: String,
    pub external_key: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub language_code: String,
    #[serde(default)]
    pub source_record_hash: String,
    #[serde(default)]
    pub source_profile_key: String,
    #[serde(default)]
    pub source_profile_version: String,
    #[serde(default)]
    pub source_mapping_fingerprint: String,
    #[serde(default)]
    pub normalized: Normalized,
    pub status: String,
    #[serde(default)]
    pub promoted_catalog_item_id: Option<String>,
    #[serde(default)]
    pub promotion_profile_key: Option<String>,
    #[serde(default)]
    pub promotion_profile_version: Option<String>,
    #[serde(default)]
    pub promotion_plan_fingerprint: Option<String>,
}

/// Whether an observation of `status` may be promoted: observed or changed, as admin-web offers
/// Promote.
pub fn promotable(status: &str) -> bool {
    matches!(status, "observed" | "changed")
}

/// Whether an observation of `status` may be rejected: observed only, as admin-web offers Reject.
pub fn rejectable(status: &str) -> bool {
    status == "observed"
}

/// The review form: the button's action, the reason a reject sends, and the status the form was
/// drawn for (only to draw it again after a refusal; the API decides what the status allows).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ReviewInput {
    pub action: String,
    pub reason: String,
    pub status: String,
}

/// What the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ObservationScreen {
    pub observation: Observation,
    /// Whether the viewer may review it (`catalog.manage`).
    pub manage: bool,
}

pub(crate) async fn page(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Observation<'_>>,
) -> HtmlResult {
    let receipt = Receipt::from_param(route.after_write.as_deref());
    let notice = route.done.map(|done| notice(req.t(), done));
    render(&req, &staff.viewer, &config, &headers, &route.id, receipt, notice, None).await
}

fn notice(t: Cat, done: Reviewed) -> String {
    match done {
        Reviewed::Promoted => t.obs_promoted().into(),
        Reviewed::Rejected => t.obs_rejected().into(),
    }
}

/// The page; `refused` is a review the API refused, its form drawn with the message (422).
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    receipt: Option<Receipt>,
    notice: Option<String>,
    refused: Option<(&ReviewInput, &Errors)>,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let observation = match caller.read_at::<Observation>(Kind::SourceObservations, &under(id, &[])).await {
        Ok(observation) => observation,
        Err(error) => return read_failed(req, error, receipt.is_some()),
    };
    let screen = ObservationScreen { observation, manage: manages(viewer) };
    let t: Cat = req.t();
    let title = if screen.observation.normalized.name.is_empty() {
        t.route_obs().to_string()
    } else {
        t.route_obs_named(&screen.observation.normalized.name).to_string()
    };
    let view = views::observation_page(t, req.t(), &screen, notice.as_ref(), refused);
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={&title} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// The review's body for the API: Promote as a published item (`promoteAsDraft: false`, as
/// admin-web's detail page sends it), or Reject with its reason.
fn body(t: Cat, input: &ReviewInput) -> Option<(&'static str, serde_json::Value)> {
    match input.action.as_str() {
        "promote" => Some(("promote", json!({ "promoteAsDraft": false }))),
        "reject" => {
            let reason = input.reason.trim();
            let reason = if reason.is_empty() { t.obs_rejected_reason() } else { reason };
            Some(("reject", json!({ "reason": reason })))
        }
        _ => None,
    }
}

pub(crate) async fn review(
    req: Req,
    corten::Caller(staff): corten::Caller<Staff<CatalogAccess>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::Observation<'_>>,
    Form(input): Form<ReviewInput>,
) -> HtmlResult {
    let id = route.id.as_str();
    let t: Cat = req.t();
    let errors = match body(t, &input) {
        Some((action, body)) => {
            let caller = config.platform.caller(&headers, config.proto, None);
            match command(&caller, Method::POST, Kind::SourceObservations, &under(id, &[action]), Some(&body)).await {
                Sent::Written(written) => {
                    let done = if action == "promote" { Reviewed::Promoted } else { Reviewed::Rejected };
                    return req.redirect(&url::Observation { id, after_write: receipt(&written), done: Some(done) });
                }
                Sent::Refused(errors) => errors,
                Sent::Denied(denied) => return denied.answer(&req),
            }
        }
        None => super::not_offered(req.t()),
    };
    let action = url::Observation { id, after_write: None, done: None }.href();
    let form = views::ReviewForm { t, action: &action, input: &input, errors: &errors };
    req.invalid(&errors, form, || render(&req, &staff.viewer, &config, &headers, id, None, None, Some((&input, &errors)))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promote_and_reject_are_offered_as_admin_webs_page_offers_them() {
        let offered = |s: &str| (promotable(s), rejectable(s));
        assert_eq!(offered("observed"), (true, true));
        assert_eq!(offered("changed"), (true, false));
        assert_eq!(offered("promoted"), (false, false));
        assert_eq!(offered("rejected"), (false, false));
    }

    #[test]
    fn a_reject_without_a_reason_sends_admin_webs_default_and_promote_publishes() {
        let t = Cat::default();
        let input =
            |action: &str, reason: &str| ReviewInput { action: action.into(), reason: reason.into(), status: "observed".into() };
        assert_eq!(body(t, &input("reject", "  ")), Some(("reject", json!({ "reason": "Rejected during review." }))));
        assert_eq!(body(t, &input("reject", " duplicate ")), Some(("reject", json!({ "reason": "duplicate" }))));
        assert_eq!(body(t, &input("promote", "")), Some(("promote", json!({ "promoteAsDraft": false }))));
        assert_eq!(body(t, &input("archive", "")), None);
    }
}
