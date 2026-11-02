//! Catalog > a Source Observation (`SourceObservationDetailPage`): its image, its values as
//! admin-web lists them, and the review form, which posts Promote or Reject to the page.
use corten::prelude::*;

use super::{DetailPage, Input, KeyValues, Toasts, ids};
use crate::{
    catalog::observation::{ObservationScreen, ReviewInput, promotable, rejectable, url},
    text::{Cat, Pilot},
};

const DASH: &str = "\u{2014}";

fn or_dash(value: &Option<String>) -> String {
    value.as_deref().filter(|v| !v.is_empty()).unwrap_or(DASH).to_owned()
}

/// The values admin-web's `KeyValueList` shows, in its order: a Pokemon card's own after the
/// source mapping, a provider product's at the end.
pub fn observation_values(t: Cat, screen: &ObservationScreen) -> Vec<(&'static str, String)> {
    let o = &screen.observation;
    let n = &o.normalized;
    let mut items = vec![
        (t.obs_status(), o.status.clone()),
        (t.obs_provider(), o.provider_key.clone()),
        (t.obs_external_key(), o.external_key.clone()),
        (t.obs_language(), o.language_code.clone()),
        (t.obs_source_profile(), format!("{}@{}", o.source_profile_key, o.source_profile_version)),
        (t.obs_source_mapping_fingerprint(), o.source_mapping_fingerprint.clone()),
    ];
    if n.kind == "pokemon-card" {
        items.extend([
            (t.obs_expansion(), or_dash(&n.expansion_name.clone().or_else(|| n.set_name.clone()))),
            (t.obs_card_number(), or_dash(&n.card_number)),
            (t.obs_card_variant(), or_dash(&n.card_variant_label)),
            (t.obs_rarity(), or_dash(&n.rarity)),
            (t.obs_image_note(), or_dash(&n.image_disclaimer)),
            (t.obs_card_illustrator(), or_dash(&n.illustrator)),
            (t.obs_release_date(), or_dash(&n.release_date)),
        ]);
    }
    items.extend([
        (t.obs_hash(), o.source_record_hash.clone()),
        (t.obs_source_url(), o.source_url.clone()),
        (t.obs_promoted_catalog_item(), or_dash(&o.promoted_catalog_item_id)),
        (
            t.obs_promotion_profile(),
            match (&o.promotion_profile_key, &o.promotion_profile_version) {
                (Some(key), Some(version)) if !key.is_empty() && !version.is_empty() => format!("{key}@{version}"),
                _ => DASH.to_owned(),
            },
        ),
        (t.obs_promotion_plan_fingerprint(), or_dash(&o.promotion_plan_fingerprint)),
    ]);
    if n.kind == "provider-product" {
        let skus: Vec<&str> = n.sku_references.iter().map(|s| s.external_key.as_str()).collect();
        items.extend([
            (t.obs_product_id(), or_dash(&n.provider_product_id)),
            (t.obs_product_line(), or_dash(&n.product_line_name)),
            (t.obs_product_category(), or_dash(&n.product_category_name)),
            (t.obs_sku_count(), n.sku_references.len().to_string()),
            (t.obs_sku_evidence(), if skus.is_empty() { DASH.to_owned() } else { skus.join(", ") }),
        ]);
    }
    items
}

/// The page: breadcrumbs back to admin-web's workbench, the name, the review form (for staff who
/// may review it, when its status allows a review), the image and the values.
pub fn observation_page<'a>(
    t: Cat,
    p: Pilot,
    screen: &'a ObservationScreen,
    notice: Option<&'a String>,
    refused: Option<(&'a ReviewInput, &'a Errors)>,
) -> impl Render + 'a {
    let o = &screen.observation;
    let name = if o.normalized.name.is_empty() { o.observation_id.as_str() } else { o.normalized.name.as_str() };
    let workbench = crate::views::admin_web("/catalog/integrations?section=workbench").map(|u| u.to_string()).unwrap_or_default();
    let action = url::Observation { id: &o.observation_id, after_write: None, done: None }.href();
    let values = observation_values(t, screen);
    let reviewable = screen.manage && (promotable(&o.status) || rejectable(&o.status));
    html! {
        <DetailPage p={p} list={&workbench} list_label={t.obs_source_observations()} name={name}>
            <ObservationPage>
                if reviewable {
                    let fresh = ReviewInput { status: o.status.clone(), ..Default::default() };
                    let none = Errors::new();
                    let (input, errors) = refused.unwrap_or((&fresh, &none));
                    <ReviewForm t={t} action={&action} input={input} errors={errors} />
                }
                if let Some(image) = o.normalized.image_urls.first() {
                    <Picture src={image} alt={t.obs_card_image()} />
                }
                <KeyValues items={&values} />
            </ObservationPage>
        </DetailPage>
        <Toasts p={p} notice={notice} />
    }
}

/// The page's frame: the form, the image and the values, one under another.
#[component(css)]
pub fn ObservationPage<C: Render>(children: C) -> impl Render {
    html! { <div class={Observation}>{children}</div> }
}

/// The observation's first image, at most 180 pixels wide. It is at the top of the page, so it is
/// not lazy: the browser fetches it with the page (`Image width={180} fit="contain"`).
#[component(css = ObservationPage)]
pub fn Picture<'a>(src: &'a str, alt: &'a str) -> impl Render {
    html! { <img class={Image} src={src} alt={alt} width="180" decoding="async"> }
}

/// Promote and Reject, as the status allows them, with the reason Reject sends (an observed
/// observation's). A refusal is the form's message.
#[component(css = ObservationPage)]
pub fn ReviewForm<'a>(t: Cat, action: &'a str, input: &'a ReviewInput, errors: &'a Errors) -> impl Patch {
    let f = ReviewInput::FIELDS;
    let e = errors.within(ids::REVIEW);
    html! {
        <form class={Review} id={ids::REVIEW} method="post" action={action} data-patch>
            {errors.form_message()}
            <input type="hidden" name={f.status} value={&input.status}>
            if rejectable(&input.status) {
                <Input label={t.obs_reject_reason()} name={f.reason} value={&input.reason} errors={&e} />
            }
            <div class={Actions}>
                if promotable(&input.status) {
                    <button type="submit" name={f.action} value="promote">{t.obs_promote()}</button>
                }
                if rejectable(&input.status) {
                    <button type="submit" class={Reject} name={f.action} value="reject">{t.obs_reject()}</button>
                }
            </div>
        </form>
    }
}
