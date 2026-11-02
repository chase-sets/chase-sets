//! The seller's listing page (marketplace's `MarketplaceListingDetailPage` and
//! `ListingEvidenceReadiness`): the header with Back to listings, what the last write was refused
//! for, the listing's overview (its badges, price, fees, inventory, terms and status), its
//! readiness (the checklist, the photos buyers see, and on a draft its photos' forms: add,
//! classify, replace, move and remove), its fee lock history, and the forms that update it:
//! price (with Preview fees, a GET of the page), quantity cap, purchase limits, publish, pause
//! and withdraw (which asks first in a dialog its button opens, `command="show-modal"`).
//!
//! Every action is a form and works without JavaScript. One column, mobile first; the overview's
//! cards and the photos sit two abreast from 48rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{listing_page::options, on_marketplace};
use crate::{
    api::{EvidenceReadiness, FeeHistoryEntry, GalleryImage, ListingPhoto, SellerListing, TermsPreview},
    app::url,
    listing_new::PICTURES,
    seller_listing::{Edits, ListingForm, ListingScreen, Place},
    text::{Pilot, SellerListingMsg},
};

/// The forms' section, which the overview's Update Listing links to.
#[derive(Id)]
pub struct UpdateListingId;
/// The price form.
#[derive(Id, Clone, Copy)]
pub struct PriceFormId;
/// The quantity cap form.
#[derive(Id, Clone, Copy)]
pub struct QuantityFormId;
/// The purchase limits form.
#[derive(Id, Clone, Copy)]
pub struct LimitsFormId;
/// Withdraw's confirmation.
#[derive(Id)]
pub struct WithdrawDialogId;
/// A photo's image description (`listingEvidenceAltTextFieldId`).
#[derive(Id)]
pub struct AltTextId<'a>(pub &'a str);
/// Its refusal.
#[derive(Id)]
pub struct AltTextErrorId<'a>(pub &'a str);

/// The page's own address, where its forms post.
fn here(id: &str) -> url::SellerListing<'_> {
    url::SellerListing { id, place: Place::default() }
}

/// A label without the colon marketplace writes it with ("Price: "), for a list's term.
fn term(label: &str) -> &str {
    label.trim_end().trim_end_matches(':')
}

/// An amount in its currency (`formatOptionalMoney`), or "Incomplete price".
fn money(t: SellerListingMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    match (amount.and_then(platform::money::decimal), currency.and_then(|c| Currency::parse(c.trim()))) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => t.page_price_incomplete().to_owned(),
    }
}

/// `formatBreakdownMoney`: "Not set" without an amount.
fn breakdown(t: SellerListingMsg, amount: Option<&str>, currency: Option<&str>) -> String {
    match amount {
        None => t.page_not_set().to_owned(),
        Some(_) => money(t, amount, currency),
    }
}

/// A rate in basis points as a percentage (`formatBpsPercent`).
fn percent(t: SellerListingMsg, bps: Option<u32>) -> String {
    bps.map(|bps| t.percent(Decimal::new(i128::from(bps), 4), 2).to_string()).unwrap_or_else(|| t.page_not_set().to_owned())
}

/// A time the API sent (`formatDateTime`), or "Not set".
fn when(t: SellerListingMsg, at: Option<&str>) -> String {
    match at {
        Some(at) => parse_timestamp(at)
            .map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string()),
        None => t.page_not_set().to_owned(),
    }
}

/// The fee, net and credit in one line (`renderPreviewSummary`).
fn summary(t: SellerListingMsg, fee: Option<&str>, net: Option<&str>, bps: Option<u32>, currency: Option<&str>) -> String {
    [
        t.page_marketplace_fee_summary(&money(t, fee, currency)).to_string(),
        t.page_net_summary(&money(t, net, currency)).to_string(),
        t.page_buyer_shipping_credit_summary(&percent(t, bps)).to_string(),
    ]
    .join(". ")
}

/// Which terms priced the listing (`termsLabel`).
fn terms(t: SellerListingMsg, p: Pilot, agreement: Option<&str>, schedule: Option<&str>) -> String {
    match (agreement, schedule) {
        (Some(_), _) => p.seller_listing_terms_seller().to_owned(),
        (None, Some(_)) => p.seller_listing_terms_standard().to_owned(),
        (None, None) => t.page_default_fallback_unavailable().to_owned(),
    }
}

fn status(p: Pilot, status: &str) -> &str {
    match status {
        "draft" => p.seller_listing_status_draft(),
        "active" => p.seller_listing_status_active(),
        "paused" => p.seller_listing_status_paused(),
        "withdrawn" => p.seller_listing_status_withdrawn(),
        other => other,
    }
}

fn tone(status: &str) -> &'static str {
    match status {
        "active" => "accent",
        "paused" => "warning",
        "withdrawn" => "danger",
        _ => "neutral",
    }
}

fn language(t: SellerListingMsg, code: &str) -> &str {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en(),
        "ja" => t.language_ja(),
        _ => code.trim(),
    }
}

fn fee_event(t: SellerListingMsg, event: &str) -> &str {
    match event {
        "marketplace.listing.created" => t.page_fee_history_created(),
        "marketplace.listing.published" => t.page_fee_history_published(),
        "marketplace.listing.price-updated" => t.page_fee_history_price_updated(),
        "marketplace.listing.quantity-cap-updated" => t.page_fee_history_quantity_updated(),
        other => other,
    }
}

/// The limits set, or that there are none (`listingPurchaseLimitSummary`).
fn limits(t: SellerListingMsg, l: &SellerListing) -> String {
    let set: Vec<String> = [
        l.max_units_per_order.map(|n| t.page_purchase_limit_order_summary(n).to_string()),
        l.max_units_per_day.map(|n| t.page_purchase_limit_day_summary(n).to_string()),
        l.max_units_per_customer_account.map(|n| t.page_purchase_limit_customer_summary(n).to_string()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if set.is_empty() {
        t.page_no_seller_purchase_limits().to_owned()
    } else {
        t.page_active_purchase_limits(&set.join(", ")).to_string()
    }
}

/// Where the stock is: its location and ship-from code.
fn inventory(t: SellerListingMsg, l: &SellerListing) -> String {
    let at = l.storage_location_name.as_deref().unwrap_or(t.page_unknown_location());
    format!("{at} {}", l.ship_from_code.as_deref().unwrap_or_default()).trim().to_owned()
}

/// The page.
#[component(css)]
pub fn SellerListingPage<'a>(t: SellerListingMsg, p: Pilot, id: &'a str, screen: &'a ListingScreen) -> impl Render {
    let l = &screen.listing;
    let title = l.item_title.as_deref().unwrap_or(&l.catalog_catalog_item_id);
    let back = url::SellerListings::default().href();
    let update = UpdateListingId.fragment();
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_seller()}</p>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{t.page_manage_seller_listing_pricing_quantity_caps()}</p>
            </div>
            <a class={(Button, Secondary)} href={&back}>{t.page_back_to_listings()}</a>
        </header>
        <Notices t={t} p={p} screen={screen} />
        if l.price_currency_code.is_none() {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.page_price_incomplete()}</p>
                <p>{t.page_price_incomplete_description()}</p>
            </div>
        }
        <section class={Section} aria-labelledby="overview-title">
            <h2 id="overview-title" class={PartTitle}>{t.page_listing_overview()}</h2>
            <div class={Cards}>
                <div class={Card}>
                    <p class={Badges}>
                        <span class={Badge} data-tone={tone(&l.status)}>{status(p, &l.status)}</span>
                        if let Some(code) = &l.item_language_code {
                            <span class={Badge}>{language(t, code)}</span>
                        }
                        if l.status == "active" {
                            <span class={Badge} data-tone="success">{t.page_verified_seller()}</span>
                        }
                        if l.product_measure_snapshot.is_none() {
                            <span class={Badge} data-tone="warning">{t.page_shipping_measure_missing()}</span>
                        }
                    </p>
                    if l.product_measure_snapshot.is_none() {
                        <div class={Banner} data-tone="warning">
                            <p class={Strong}>{t.page_shipping_measure_missing()}</p>
                            <p>{t.page_shipping_measure_missing_description()}</p>
                        </div>
                    }
                    <p class={Big}>{title}</p>
                    if let Some(subtitle) = &l.item_subtitle {
                        <p class={Muted}>{subtitle}</p>
                    }
                    if l.product_summary.is_some() {
                        <p class={Tags}>
                            for option in options(l.product_summary.as_deref()) {
                                <span class={Tag}>{option}</span>
                            }
                        </p>
                    }
                    <p class={Big}>{money(t, Some(&l.price_amount), l.price_currency_code.as_deref())}</p>
                    <p class={Hint}>
                        if l.marketplace_sales_fee_unit_amount.is_none() || l.seller_net_unit_amount.is_none() {
                            {t.page_not_set()}
                        } else {
                            {summary(
                                t,
                                l.marketplace_sales_fee_unit_amount.as_deref(),
                                l.seller_net_unit_amount.as_deref(),
                                l.shipping_allowance_percentage_bps,
                                l.price_currency_code.as_deref(),
                            )}
                        }
                    </p>
                    <dl class={Lines}>
                        <div>
                            <dt>{term(t.page_inventory())}</dt>
                            <dd>{inventory(t, l)}</dd>
                        </div>
                        <div>
                            <dt>{term(t.page_quantity_cap())}</dt>
                            <dd>{l.quantity_cap}</dd>
                        </div>
                        <div>
                            <dt>{term(t.page_buyer_shipping_credit_rate())}</dt>
                            <dd>{percent(t, l.shipping_allowance_percentage_bps)}</dd>
                        </div>
                    </dl>
                    <a class={(Button, Secondary)} href={update}>{t.page_update_listing()}</a>
                </div>
                <div class={Card}>
                    <dl class={Lines}>
                        <div>
                            <dt>{term(t.page_price())}</dt>
                            <dd>{money(t, Some(&l.price_amount), l.price_currency_code.as_deref())}</dd>
                        </div>
                        <div>
                            <dt>{term(t.page_marketplace_fee())}</dt>
                            <dd>
                                {breakdown(t, l.marketplace_sales_fee_unit_amount.as_deref(), l.price_currency_code.as_deref())}
                            </dd>
                        </div>
                        <div>
                            <dt>{term(t.page_buyer_shipping_credit_rate())}</dt>
                            <dd>{percent(t, l.shipping_allowance_percentage_bps)}</dd>
                        </div>
                        <div>
                            <dt>{term(t.page_quantity_cap())}</dt>
                            <dd>{l.quantity_cap}</dd>
                        </div>
                        <div class={Total}>
                            <dt>{term(t.page_seller_net())}</dt>
                            <dd>{breakdown(t, l.seller_net_unit_amount.as_deref(), l.price_currency_code.as_deref())}</dd>
                        </div>
                    </dl>
                </div>
                <div class={Card}>
                    <h3 class={Strong}>{t.page_buyer_shipping_credit()}</h3>
                    <ul class={Facts}>
                        <li>
                            <p class={Strong}>{t.page_buyer_shipping_credit()}</p>
                            <p class={Muted}>
                                {t.page_buyers_earn_percentage_toward_shipping_when_grouping(&percent(t, l.shipping_allowance_percentage_bps))}
                            </p>
                        </li>
                        <li>
                            <p class={Strong}>{term(t.page_inventory())}</p>
                            <p class={Muted}>{l.storage_location_name.as_deref().unwrap_or(t.page_unknown_location())}</p>
                        </li>
                        <li>
                            <p class={Strong}>{term(t.page_terms_resolved_at())}</p>
                            <p class={Muted}>{when(t, l.terms_resolved_at.as_deref())}</p>
                        </li>
                    </ul>
                </div>
                <div class={Card}>
                    <dl class={Lines}>
                        <div>
                            <dt>{term(t.page_terms_schedule())}</dt>
                            <dd>{terms(t, p, l.terms_agreement_id.as_deref(), l.terms_schedule_id.as_deref())}</dd>
                        </div>
                        <div>
                            <dt>{term(t.page_agreement_override())}</dt>
                            <dd>
                                if l.terms_agreement_id.is_some() {
                                    {t.page_seller_terms_override()}
                                } else {
                                    {t.page_none()}
                                }
                            </dd>
                        </div>
                        <div>
                            <dt>{term(t.page_inventory())}</dt>
                            <dd>{inventory(t, l)}</dd>
                        </div>
                    </dl>
                    <ol class={Steps}>
                        <li data-state={if l.status == "active" { "complete" } else { "current" }}>
                            <p class={Strong}>{status(p, &l.status)}</p>
                            <p class={Muted}>{t.page_manage_seller_listing_pricing_quantity_caps()}</p>
                        </li>
                        <li data-state={if l.terms_resolved_at.is_some() { "complete" } else { "upcoming" }}>
                            <p class={Strong}>{t.page_fee_lock_history()}</p>
                            <p class={Muted}>{t.page_terms_resolved_at()} " " {when(t, l.terms_resolved_at.as_deref())}</p>
                        </li>
                    </ol>
                </div>
            </div>
        </section>
        <section class={Section} aria-labelledby="readiness-title">
            <h2 id="readiness-title" class={PartTitle}>{t.evidence_readiness_title()}</h2>
            <Readiness t={t} p={p} id={id} screen={screen} />
        </section>
        <section class={Section} aria-labelledby="fees-title">
            <h2 id="fees-title" class={PartTitle}>{t.page_fee_lock_history()}</h2>
            <FeeHistory t={t} p={p} listing={l} fees={&screen.fees} />
        </section>
        <section id={UpdateListingId} class={Section} aria-labelledby="update-title">
            <h2 id="update-title" class={PartTitle}>{t.page_update_listing()}</h2>
            <UpdateForms t={t} p={p} id={id} screen={screen} />
        </section>
    }
}

/// What the last write was refused for: an image description's recovery
/// (`AuthoredTextRecoverySummary`), or the "Update Listing" banner with the API's words.
#[component(css = SellerListingPage)]
fn Notices<'a>(t: SellerListingMsg, p: Pilot, screen: &'a ListingScreen) -> impl Render {
    let e = &screen.edits;
    html! {
        <div class={Notes} role="status" aria-live="polite">
            if let Some(refused) = &e.alt_text {
                <div class={Banner} data-tone="danger" tabindex="-1">
                    <p class={Strong}>{t.recovery_title()}</p>
                    <p>{&refused.message}</p>
                    <p>{t.recovery_draft_kept()}</p>
                    <p><a href={AltTextId(&refused.photo).fragment()}>{t.evidence_alt_text()}</a></p>
                </div>
            } else if let Some(message) = e.errors.form() {
                <div class={Banner} data-tone="danger" tabindex="-1">
                    <p class={Strong}>{t.page_update_listing()}</p>
                    <p>{message}</p>
                    if e.photos_lost {
                        <p>{p.seller_listing_photos_again()}</p>
                    }
                </div>
            }
        </div>
    }
}

/// `ListingEvidenceReadiness`: the checklist, the photos buyers see, and a draft's photo forms.
#[component(css = SellerListingPage)]
fn Readiness<'a>(t: SellerListingMsg, p: Pilot, id: &'a str, screen: &'a ListingScreen) -> impl Render {
    let l = &screen.listing;
    let readiness = &l.evidence_readiness;
    let photos = l.active_photos();
    let ids: Vec<&str> = photos.iter().map(|p| p.photo_id.as_str()).collect();
    let gallery: Vec<(usize, &GalleryImage)> =
        readiness.public_gallery.iter().enumerate().filter(|(_, image)| !image.assets.is_empty()).collect();
    let f = ListingForm::FIELDS;
    html! {
        <div class={Stack}>
            <Checklist t={t} readiness={readiness} />
            if !gallery.is_empty() {
                <div class={Stack}>
                    <p class={Strong}>{t.evidence_seller_supplied()}</p>
                    <ul class={Gallery}>
                        for (index, image) in gallery {
                            <li><Picture t={t} image={image} index={index + 1} /></li>
                        }
                    </ul>
                </div>
            }
            if l.status == "draft" {
                <p class={Muted}>{t.guidance_description()}</p>
                <form class={(Form, Drop)} method="post" action={url::SellerListingPhotos { id }} enctype="multipart/form-data">
                    <input type="hidden" name={f.intent} value="add-photos">
                    <label class={Field}>
                        <span class={Label}>{t.evidence_add_photos()}</span>
                        <span class={Hint}>{t.evidence_add_photos_description()}</span>
                        <input type="file" name={f.evidence} accept={PICTURES} multiple capture="environment" required>
                    </label>
                    <p class={Hint}>{t.evidence_choose_photos()}</p>
                    <button class={Button} type="submit">{t.evidence_upload()}</button>
                </form>
                <ul class={Photos}>
                    for (index, photo) in photos.iter().enumerate() {
                        <li class={Card}>
                            <PhotoForms t={t} p={p} id={id} screen={screen} photo={photo} index={index} ids={&ids} />
                        </li>
                    }
                </ul>
            }
        </div>
    }
}

/// A photo buyers see (`galleryImage`): the catalog-detail size at density 1, the others of its
/// role as its `srcset`.
#[component(css = SellerListingPage)]
fn Picture<'a>(t: SellerListingMsg, image: &'a GalleryImage, index: usize) -> impl Render {
    let primary =
        image.assets.iter().find(|a| a.role == "catalog-detail" && a.density == Some(1)).or_else(|| image.assets.first());
    let srcset = primary.map(|primary| {
        image
            .assets
            .iter()
            .filter(|a| a.role == primary.role)
            .map(|a| format!("{} {}w", a.public_url, a.width))
            .collect::<Vec<_>>()
            .join(", ")
    });
    let alt = image.alt_text.clone().unwrap_or_else(|| t.evidence_photo_fallback_alt(index).to_string());
    html! {
        if let Some(primary) = primary {
            <img
                class={Shot}
                src={&primary.public_url}
                srcset={srcset.as_deref().filter(|s| !s.is_empty())}
                sizes="(min-width: 768px) 480px, min(100vw, 276px)"
                width={primary.width}
                height={primary.height}
                alt={&alt}
                loading="lazy"
                decoding="async"
            >
        }
    }
}

/// A draft photo's forms: its view and description, a replacement, and Move earlier, Move later
/// and Remove.
#[component(css = SellerListingPage)]
fn PhotoForms<'a>(
    t: SellerListingMsg,
    p: Pilot,
    id: &'a str,
    screen: &'a ListingScreen,
    photo: &'a ListingPhoto,
    index: usize,
    ids: &'a [&'a str],
) -> impl Render {
    let f = ListingForm::FIELDS;
    let slots = &screen.listing.evidence_readiness.requirements.required_slots;
    let refused = screen.edits.alt_text.as_ref().filter(|r| r.photo == photo.photo_id);
    let alt = refused.map_or(photo.alt_text.as_deref().unwrap_or_default(), |r| r.text.as_str());
    let invalid = refused.is_some_and(|r| r.field_level);
    let chosen = photo.slot_id.as_deref().unwrap_or_default();
    let label = photo.alt_text.clone().unwrap_or_else(|| t.evidence_photo_label(index + 1).to_string());
    let moved = |to: usize| -> String {
        let mut order = ids.to_vec();
        order.swap(index, to);
        order.join(",")
    };
    let first = index == 0;
    let last = index + 1 == ids.len();
    html! {
        <p class={Strong}>{&label}</p>
        <form class={Stack} method="post" action={here(id)}>
            <input type="hidden" name={f.intent} value="classify-photo">
            <input type="hidden" name={f.photo_id} value={&photo.photo_id}>
            <label class={Field}>
                <span class={Label}>{t.evidence_assign_view()}</span>
                <select name={f.slot_id}>
                    <option value="" selected={chosen.is_empty()}>{t.evidence_unclassified()}</option>
                    for slot in slots {
                        <option value={&slot.slot_id} selected={slot.slot_id == chosen}>{&slot.view_kind}</option>
                    }
                </select>
            </label>
            <div class={Field}>
                <label class={Label} for={AltTextId(&photo.photo_id)}>{t.evidence_alt_text()}</label>
                <input
                    id={AltTextId(&photo.photo_id)}
                    type="text"
                    name={f.alt_text}
                    value={alt}
                    aria-invalid={invalid.then_some("true")}
                    aria-describedby={invalid.then_some(AltTextErrorId(&photo.photo_id))}
                >
                if let Some(refused) = refused.filter(|r| r.field_level) {
                    <p id={AltTextErrorId(&photo.photo_id)} class={Error}>{&refused.message}</p>
                }
            </div>
            <button class={(Button, Secondary)} type="submit">{t.evidence_save_classification()}</button>
        </form>
        <form class={(Stack, Drop)} method="post" action={url::SellerListingPhotos { id }} enctype="multipart/form-data">
            <input type="hidden" name={f.intent} value="replace-photo">
            <input type="hidden" name={f.photo_id} value={&photo.photo_id}>
            <input type="hidden" name={f.slot_id} value={photo.slot_id.as_deref().unwrap_or_default()}>
            <input type="hidden" name="viewKind" value={photo.view_kind.as_deref().unwrap_or_default()}>
            <label class={Field}>
                <span class={Label}>{t.evidence_replace_photo()}</span>
                <input type="file" name={f.listing_photo} accept={PICTURES} capture="environment" required>
            </label>
            <p class={Hint}>{t.evidence_choose_replacement()}</p>
            <button class={(Button, Secondary)} type="submit">{t.evidence_replace()}</button>
        </form>
        <div class={Row}>
            <form method="post" action={here(id)}>
                <input type="hidden" name={f.intent} value="reorder-photos">
                <input type="hidden" name={f.ordered_photo_ids} value={if first { String::new() } else { moved(index - 1) }}>
                <button
                    class={(Button, Secondary)}
                    type="submit"
                    disabled={first}
                    aria-label={p.seller_listing_move_earlier_label(index + 1).to_string()}
                >
                    {t.evidence_move_earlier()}
                </button>
            </form>
            <form method="post" action={here(id)}>
                <input type="hidden" name={f.intent} value="reorder-photos">
                <input type="hidden" name={f.ordered_photo_ids} value={if last { String::new() } else { moved(index + 1) }}>
                <button
                    class={(Button, Secondary)}
                    type="submit"
                    disabled={last}
                    aria-label={p.seller_listing_move_later_label(index + 1).to_string()}
                >
                    {t.evidence_move_later()}
                </button>
            </form>
            <form method="post" action={here(id)}>
                <input type="hidden" name={f.intent} value="remove-photo">
                <input type="hidden" name={f.photo_id} value={&photo.photo_id}>
                <button class={(Button, Danger)} type="submit" aria-label={p.seller_listing_remove_label(index + 1).to_string()}>
                    {t.evidence_remove()}
                </button>
            </form>
        </div>
    }
}

/// An unmet code's words.
fn coverage(t: SellerListingMsg, code: &str) -> &'static str {
    match code {
        "min-photo-count-unmet" => t.coverage_min_photo_count_unmet(),
        "slot-view-mismatch" => t.coverage_slot_view_mismatch(),
        "slot-dimensions-too-small" => t.coverage_slot_dimensions_too_small(),
        "slot-expired" => t.coverage_slot_expired(),
        "duplicate-source" => t.coverage_duplicate_source(),
        _ => t.coverage_slot_missing(),
    }
}

/// `EvidenceReadinessChecklist`.
#[component(css = SellerListingPage)]
fn Checklist<'a>(t: SellerListingMsg, readiness: &'a EvidenceReadiness) -> impl Render {
    let c = &readiness.coverage;
    let enough = c.active_photo_count >= c.minimum_photo_count;
    let state = |done: bool| if done { t.evidence_complete() } else { t.evidence_action_required() };
    let slot = |id: &str| readiness.requirements.required_slots.iter().find(|s| s.slot_id == id);
    html! {
        <div class={Banner} data-tone={if readiness.ready { "success" } else { "warning" }}>
            if readiness.ready {
                <p class={Strong}>{t.evidence_ready_title()}</p>
                <p>{t.evidence_ready_description()}</p>
            } else {
                <p class={Strong}>{t.evidence_required_title()}</p>
                <p>{t.evidence_required_description()}</p>
            }
        </div>
        <ul class={Checks}>
            <li class={Check}>
                <p class={Strong}>{t.evidence_minimum_photo_count(c.minimum_photo_count)}</p>
                <span class={State} data-done={enough}>{state(enough)}</span>
                <p class={Muted}>{t.evidence_photo_count_progress(c.active_photo_count, c.minimum_photo_count)}</p>
                if !enough {
                    <p>{t.coverage_min_photo_count_unmet()}</p>
                }
            </li>
            for s in &c.slots {
                <li class={Check}>
                    <p class={Strong}>{t.evidence_required_view(&s.view_kind)}</p>
                    <span class={State} data-done={s.satisfied}>{state(s.satisfied)}</span>
                    <p class={Muted}>
                        {match &s.unmet_code { Some(code) => coverage(t, code), None => t.evidence_view_ready() }}
                    </p>
                    if let Some(required) = slot(&s.slot_id) {
                        <p class={Tags}>
                            <span class={Tag}>{&required.slot_id}</span>
                            if let (Some(w), Some(h)) = (required.minimum_width_pixels, required.minimum_height_pixels) {
                                <span class={Tag}>{t.evidence_minimum_dimensions(w, h)}</span>
                            }
                        </p>
                    }
                </li>
            }
        </ul>
    }
}

/// The fee lock history, folded (`ProgressiveDisclosure`).
#[component(css = SellerListingPage)]
fn FeeHistory<'a>(t: SellerListingMsg, p: Pilot, listing: &'a SellerListing, fees: &'a [FeeHistoryEntry]) -> impl Render {
    // An entry without a price is in the listing's currency.
    let currency = |e: &'a FeeHistoryEntry| {
        if e.price_amount.is_none() { listing.price_currency_code.as_deref() } else { e.price_currency_code.as_deref() }
    };
    html! {
        <details class={Disclosure} data-tone={if fees.is_empty() { "neutral" } else { "info" }}>
            <summary>
                <span class={Strong}>{t.page_fee_lock_history()}</span>
                <span class={Hint}>{t.page_fee_history_summary(fees.len())}</span>
            </summary>
            if fees.is_empty() {
                <p class={Muted}>{t.page_no_fee_history()}</p>
            } else {
                <ol class={History}>
                    for e in fees {
                        <li>
                            <p class={Strong}>{fee_event(t, &e.event_type)}</p>
                            <p class={Hint}>
                                {t.page_fee_history_recorded(e.stream_version, &when(t, e.recorded_at.as_deref()))}
                            </p>
                            <dl class={Lines}>
                                <div>
                                    <dt>{term(t.page_price())}</dt>
                                    <dd>{money(t, e.price_amount.as_deref().or(Some(&listing.price_amount)), currency(e))}</dd>
                                </div>
                                if let Some(cap) = e.quantity_cap {
                                    <div>
                                        <dt>{term(t.page_quantity_cap())}</dt>
                                        <dd>{cap}</dd>
                                    </div>
                                }
                                <div>
                                    <dt>{term(t.page_marketplace_fee())}</dt>
                                    <dd>{money(t, e.marketplace_sales_fee_unit_amount.as_deref(), currency(e))}</dd>
                                </div>
                                <div>
                                    <dt>{term(t.page_seller_net())}</dt>
                                    <dd>{money(t, e.seller_net_unit_amount.as_deref(), currency(e))}</dd>
                                </div>
                                <div>
                                    <dt>{term(t.page_terms_schedule())}</dt>
                                    <dd>{terms(t, p, e.terms_agreement_id.as_deref(), e.terms_schedule_id.as_deref())}</dd>
                                </div>
                                <div>
                                    <dt>{term(t.page_terms_resolved_at())}</dt>
                                    <dd>{when(t, e.terms_resolved_at.as_deref())}</dd>
                                </div>
                            </dl>
                        </li>
                    }
                </ol>
            }
        </details>
    }
}

/// The price form and its preview, the quantity cap, the purchase limits, and Publish, Pause and
/// Withdraw.
#[component(css = SellerListingPage)]
fn UpdateForms<'a>(t: SellerListingMsg, p: Pilot, id: &'a str, screen: &'a ListingScreen) -> impl Render {
    let f = ListingForm::FIELDS;
    let l = &screen.listing;
    let e = &screen.edits;
    let price = e.price_amount.as_deref().unwrap_or(&l.price_amount);
    let cap = e.quantity_cap.clone().unwrap_or_else(|| l.quantity_cap.to_string());
    let limit = |n: Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
    let [per_order, per_day, per_customer] = e
        .limits
        .clone()
        .unwrap_or_else(|| [limit(l.max_units_per_order), limit(l.max_units_per_day), limit(l.max_units_per_customer_account)]);
    let (qe, le) = (e.errors.within(QuantityFormId), e.errors.within(LimitsFormId));
    let blocked = !matches!(l.status.as_str(), "active" | "withdrawn");
    html! {
        <div class={Stack}>
            <div class={Card}>
                <form id={PriceFormId} class={Stack} method="post" action={here(id)}>
                    <div class={Grid}>
                        <label class={Field}>
                            <span class={Label}>{t.page_price_2()}</span>
                            <input type="text" name={f.price_amount} value={price} inputmode="decimal" required>
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_price_currency_code()}</span>
                            <input
                                type="text"
                                name={f.price_currency_code}
                                value={screen.currency()}
                                placeholder={t.page_price_currency_code_placeholder()}
                                minlength="3"
                                maxlength="3"
                                autocapitalize="characters"
                                required
                            >
                        </label>
                    </div>
                    if let Some(fingerprint) = screen.fingerprint() {
                        <input type="hidden" name={f.fee_quote_fingerprint} value={fingerprint}>
                    }
                    <div class={Row}>
                        <button class={(Button, Secondary)} type="submit" name={f.intent} value="update-price">
                            {t.page_save_price()}
                        </button>
                        <button class={(Button, Secondary)} type="submit" name={f.preview} value="1" formmethod="get">
                            {t.page_preview_fees()}
                        </button>
                    </div>
                </form>
                if let Some(preview) = &e.preview {
                    <Preview t={t} p={p} preview={preview} currency={screen.currency()} />
                }
            </div>
            <div class={Card}>
                <form id={QuantityFormId} class={Stack} method="post" action={here(id)}>
                    <input type="hidden" name={f.intent} value="update-quantity-cap">
                    if let Some(fingerprint) = &l.fee_quote_fingerprint {
                        <input type="hidden" name={f.fee_quote_fingerprint} value={fingerprint}>
                    }
                    <label class={Field}>
                        <span class={Label}>{t.page_quantity_cap_2()}</span>
                        <input
                            type="number"
                            name={f.quantity_cap}
                            value={&cap}
                            min="1"
                            step="1"
                            inputmode="numeric"
                            required
                            {..qe.aria(f.quantity_cap)}
                        >
                    </label>
                    {qe.message(f.quantity_cap)}
                    <p class={Hint}>{t.page_quantity_cap_exposure_copy()}</p>
                    <button class={(Button, Secondary)} type="submit">{t.page_save_quantity_cap()}</button>
                </form>
            </div>
            <details class={Disclosure} data-tone="info" open={le_open(e)}>
                <summary>
                    <span class={Strong}>{t.page_purchase_limits_copy()}</span>
                    <span class={Hint}>{limits(t, l)}</span>
                </summary>
                <form id={LimitsFormId} class={Stack} method="post" action={here(id)}>
                    <input type="hidden" name={f.intent} value="update-purchase-limits">
                    <div class={Grid3}>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_order()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_order}
                                value={&per_order}
                                min="1"
                                step="1"
                                inputmode="numeric"
                                {..le.aria(f.max_units_per_order)}
                            >
                            {le.message(f.max_units_per_order)}
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_day()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_day}
                                value={&per_day}
                                min="1"
                                step="1"
                                inputmode="numeric"
                                {..le.aria(f.max_units_per_day)}
                            >
                            {le.message(f.max_units_per_day)}
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.page_limit_per_customer()}</span>
                            <input
                                type="number"
                                name={f.max_units_per_customer_account}
                                value={&per_customer}
                                min="1"
                                step="1"
                                inputmode="numeric"
                                {..le.aria(f.max_units_per_customer_account)}
                            >
                            {le.message(f.max_units_per_customer_account)}
                        </label>
                    </div>
                    <p class={Hint}>{t.page_purchase_limits_copy()}</p>
                    <button class={(Button, Secondary)} type="submit">{t.page_save_purchase_limits()}</button>
                </form>
            </details>
            <div class={Card}>
                <form class={Stack} method="post" action={here(id)}>
                    <input type="hidden" name={f.intent} value="publish">
                    if let Some(fingerprint) = &l.fee_quote_fingerprint {
                        <input type="hidden" name={f.fee_quote_fingerprint} value={fingerprint}>
                    }
                    <p class={Muted}>{t.guidance_description()}</p>
                    <p class={Links}>
                        <a href={&on_marketplace("/help/buying/community-guidelines-and-enforcement")}>
                            {t.guidance_community_guidelines()}
                        </a>
                        <a href={&on_marketplace("/contact")}>{t.guidance_contact_support()}</a>
                    </p>
                    <button class={Button} type="submit" disabled={screen.publish_disabled()}>{t.page_publish_listing()}</button>
                    if blocked && l.product_measure_snapshot.is_none() {
                        <p class={Hint}>{t.page_publish_requires_shipping_measure()}</p>
                    }
                    if blocked && l.product_measure_snapshot.is_some() && !l.evidence_readiness.ready {
                        <p class={Hint}>{t.evidence_publish_blocked()}</p>
                    }
                </form>
                <form method="post" action={here(id)}>
                    <input type="hidden" name={f.intent} value="pause">
                    <button class={(Button, Secondary)} type="submit" disabled={l.status != "active"}>
                        {t.page_pause_listing()}
                    </button>
                </form>
                <button
                    class={(Button, Danger)}
                    type="button"
                    command="show-modal"
                    commandfor={WithdrawDialogId}
                    disabled={l.status == "withdrawn"}
                >
                    {t.page_withdraw_listing()}
                </button>
                <dialog id={WithdrawDialogId} class={Dialog} aria-labelledby="withdraw-title" aria-describedby="withdraw-text">
                    <h3 id="withdraw-title" class={PartTitle}>{t.page_withdraw_listing()}</h3>
                    <p id="withdraw-text" class={Muted}>{t.page_withdraw_confirm_description()}</p>
                    <form class={Row} method="post" action={here(id)}>
                        <input type="hidden" name={f.intent} value="withdraw">
                        <button class={(Button, Secondary)} type="button" command="close" commandfor={WithdrawDialogId}>
                            {p.seller_listing_cancel()}
                        </button>
                        <button class={(Button, Danger)} type="submit">{t.page_withdraw_listing()}</button>
                    </form>
                </dialog>
            </div>
        </div>
    }
}

/// The limits fold open when a limit was refused, so its message shows.
fn le_open(e: &Edits) -> bool {
    e.limits.is_some() && !e.errors.is_empty()
}

/// The fee preview a Preview fees asked for.
#[component(css = SellerListingPage)]
fn Preview<'a>(t: SellerListingMsg, p: Pilot, preview: &'a TermsPreview, currency: &'a str) -> impl Render {
    let currency = Some(currency).filter(|c| !c.trim().is_empty());
    html! {
        <div class={(Stack, Quote)} role="status">
            <p class={Strong}>{t.page_updated_fee_preview()}</p>
            <p class={Hint}>{t.page_account_type()} {&preview.account_type}</p>
            <p class={Hint}>
                {summary(
                    t,
                    preview.marketplace_sales_fee_unit_amount.as_deref(),
                    preview.seller_net_unit_amount.as_deref(),
                    preview.shipping_allowance_percentage_bps,
                    currency,
                )}
            </p>
            <p class={Hint}>{t.page_basis_amount()} {money(t, preview.basis_amount.as_deref(), currency)}</p>
            <p class={Hint}>
                {t.page_terms_schedule_2()} {terms(t, p, preview.agreement_id.as_deref(), preview.schedule_id.as_deref())}
            </p>
        </div>
    }
}

/// The listing is not readable yet after its write (`ListingDetailRecoveryPage`): the page reads
/// itself again, and Refresh listing does the same.
#[component(css = SellerListingPage)]
pub fn ListingPreparing<'a>(t: SellerListingMsg, again: &'a str) -> impl Render {
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_seller()}</p>
                <h1 class={Title}>{t.route_listing_preparing()}</h1>
                <p class={Muted}>{t.route_listing_preparing_description()}</p>
            </div>
        </header>
        <div class={Banner} data-tone="info" role="status">
            <p class={Strong}>{t.recover_recover_listing()}</p>
            <p>{t.recover_listing_action_saved()}</p>
        </div>
        <p class={Row}><a class={Button} href={again}>{t.recover_refresh_listing()}</a></p>
    }
}
