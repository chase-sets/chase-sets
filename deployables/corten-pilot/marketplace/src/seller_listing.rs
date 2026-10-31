//! The seller's listing (marketplace's `account-listing` route, `/account/listings/{id}`): the
//! listing read after the write whose receipt its address carries, its fee lock history, and
//! every write marketplace's action takes: the price (with Preview fees, a GET of the page), the
//! quantity cap, the purchase limits, publish, pause and withdraw, and a draft's photos (add,
//! classify, replace, remove and reorder). A write that applied goes back to the page with its
//! receipt (`afterWrite`) and what came of the evidence (`evidenceEvent`), as marketplace's
//! does; one refused is the page again with the API's words. The two photo writes post
//! `multipart/form-data` to `/photos`, read with Corten's `Upload` (`uploads::read`).
use std::time::Duration;

use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
    },
    form::Errors,
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;

use crate::{
    api::{
        ApiError, CommandError, EvidenceReadiness, FeeHistoryEntry, ListingCommand, ListingCreate as _, Photo, SellerListing,
        SellerListings as _, TermsPreview,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{ListingManager, Viewer},
    items::Raw,
    listing_new::LIMITS,
    text::{Pilot, SellerListingMsg},
    uploads::{self, Over},
    views::{self, Layout},
};

/// How long a write with photos may take, here and at the API.
pub const DEADLINE: Duration = Duration::from_secs(150);

/// What the page's address carries, in marketplace's names so its links and the pilot's agree:
/// the last write's receipt, what came of the evidence, and a price to preview.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub evidence_event: Option<String>,
    pub after_write: Option<String>,
    /// Preview fees: preview `price_amount`.
    pub preview: Option<String>,
    pub price_amount: Option<String>,
    pub price_currency_code: Option<String>,
}

/// The forms' fields, for their names: marketplace's.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ListingForm {
    pub intent: String,
    pub price_amount: String,
    pub price_currency_code: String,
    pub fee_quote_fingerprint: String,
    pub quantity_cap: String,
    pub max_units_per_order: String,
    pub max_units_per_day: String,
    pub max_units_per_customer_account: String,
    pub photo_id: String,
    pub slot_id: String,
    pub alt_text: String,
    /// The photos in their new order, comma separated.
    pub ordered_photo_ids: String,
    /// Add photos' file input.
    pub evidence: String,
    /// Replace photo's file input.
    pub listing_photo: String,
    pub preview: String,
}

/// A refused image description (`ListingEvidenceAltTextRecovery`): the photo, what was sent,
/// and the corrective words.
#[derive(Clone, Debug)]
pub struct AltTextRefused {
    pub photo: String,
    pub text: String,
    pub message: String,
    /// False for a rate limit: the text is fine, so the field is not marked invalid.
    pub field_level: bool,
}

/// What the forms show besides the listing: what was typed, a preview, and what was refused.
#[derive(Debug, Default)]
pub struct Edits {
    pub price_amount: Option<String>,
    pub price_currency_code: Option<String>,
    pub preview: Option<TermsPreview>,
    pub quantity_cap: Option<String>,
    pub limits: Option<[String; 3]>,
    /// The form's message (the "Update Listing" banner) and the fields' own.
    pub errors: Errors,
    pub alt_text: Option<AltTextRefused>,
    /// A refused photo write drawn as a page: its files are not kept.
    pub photos_lost: bool,
}

/// The page.
pub struct ListingScreen {
    pub listing: SellerListing,
    pub fees: Vec<FeeHistoryEntry>,
    pub edits: Edits,
}

impl ListingScreen {
    /// Publish is off for a listing active or withdrawn, without a currency or a shipping
    /// measure, or without the evidence its policy requires (`publishDisabled`).
    pub fn publish_disabled(&self) -> bool {
        let l = &self.listing;
        matches!(l.status.as_str(), "active" | "withdrawn")
            || l.price_currency_code.is_none()
            || l.product_measure_snapshot.is_none()
            || !l.evidence_readiness.ready
    }

    /// The fee quote a price write sends: the preview's, else the listing's.
    pub fn fingerprint(&self) -> Option<&str> {
        self.edits
            .preview
            .as_ref()
            .and_then(|p| p.fee_quote_fingerprint.as_deref())
            .or(self.listing.fee_quote_fingerprint.as_deref())
    }

    /// The currency the price form and its preview are in.
    pub fn currency(&self) -> &str {
        self.edits.price_currency_code.as_deref().or(self.listing.price_currency_code.as_deref()).unwrap_or_default()
    }
}

/// The page after the write `receipt` follows. A listing not readable yet after a write is the
/// preparing page, which reads itself again (`ListingDetailRecoveryPage`).
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    (receipt, event): (Option<&Receipt>, Option<&str>),
    edits: Edits,
    readiness: Option<EvidenceReadiness>,
    status: StatusCode,
) -> HtmlResult {
    let t: SellerListingMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, receipt);
    // The fee history is read without the receipt, as marketplace's `nonFreshApi` reads it, and
    // beside the listing's read.
    let history = config.platform.caller(headers, config.proto, None);
    let (listing, fees) = tokio::join!(caller.seller_listing(id), history.fee_history(id));
    let mut listing = match listing {
        Ok(listing) => listing,
        Err(error) if receipt.is_some() && error.catching_up() => return preparing(req, viewer, &at(id, receipt, event)),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    let fees = match fees {
        Ok(fees) => fees,
        Err(error) => return read_failed(req, Some(viewer), error, None),
    };
    if let Some(readiness) = readiness {
        listing.evidence_readiness = readiness;
    }
    let screen = ListingScreen { listing, fees, edits };
    let title = screen.listing.item_title.clone().unwrap_or_else(|| screen.listing.catalog_catalog_item_id.clone());
    let view = html! { <views::SellerListingPage t={t} p={req.t()} id={id} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={&title} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The listing is not readable yet after its write: say so and read again.
fn preparing(req: &Req, viewer: &Viewer, again: &url::SellerListing<'_>) -> HtmlResult {
    let t: SellerListingMsg = req.t();
    let head = html! { <ReadAgain after={Duration::from_secs(2)} /> };
    let again = again.href();
    let view = html! { <views::ListingPreparing t={t} again={&again} /> };
    req.page(html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_listing_preparing()} head={head}>{view}</Layout>
    })
}

pub(crate) async fn page(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListing<'_>>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let mut edits = Edits::default();
    if place.preview.is_some() {
        let price = place.price_amount.clone().unwrap_or_default();
        let caller = config.platform.caller(&headers, config.proto, None);
        match caller.preview_terms(&price).await {
            Ok(preview) => edits.preview = Some(preview),
            Err(error) => match error.refusal() {
                Some(message) => edits.errors.add_form(message),
                None => tracing::warn!("the fee preview failed: {error}"),
            },
        }
        edits.price_amount = Some(price);
        edits.price_currency_code = place.price_currency_code.clone();
    }
    let read = (receipt.as_ref(), place.evidence_event.as_deref());
    render(&req, &viewer, &config, &headers, &id, read, edits, None, StatusCode::OK).await
}

/// The listing's page read after the write `receipt` follows, saying what came of its evidence
/// (`evidenceEvent`): where a create or a write that applied goes.
pub fn at<'a>(id: &'a str, receipt: Option<&Receipt>, event: Option<&str>) -> url::SellerListing<'a> {
    let place = Place { after_write: receipt.map(Receipt::param), evidence_event: event.map(str::to_owned), ..Place::default() };
    url::SellerListing { id, place }
}

/// The page after a write that applied, read after its receipt.
fn applied(req: &Req, id: &str, receipt: Option<Receipt>, event: Option<&str>) -> HtmlResult {
    req.redirect(&at(id, receipt.as_ref(), event))
}

/// A whole number of at least 1, or (`optional`) nothing.
fn count(text: &str, optional: bool) -> Result<Option<u64>, ()> {
    match text.trim() {
        "" if optional => Ok(None),
        text => text.parse::<u64>().ok().filter(|n| *n >= 1).map(Some).ok_or(()),
    }
}

fn some(text: &str) -> Option<String> {
    Some(text.trim().to_owned()).filter(|t| !t.is_empty())
}

/// The command a form sends, or the fields it got wrong.
fn command(form: &ListingForm, listing: Option<&SellerListing>, p: Pilot) -> Result<ListingCommand, Errors> {
    let f = ListingForm::FIELDS;
    let mut errors = Errors::new();
    let fingerprint = some(&form.fee_quote_fingerprint);
    let command = match form.intent.as_str() {
        "update-price" => ListingCommand::Price {
            amount: form.price_amount.trim().to_owned(),
            currency: form.price_currency_code.trim().to_uppercase(),
            fee_quote_fingerprint: fingerprint,
        },
        "update-quantity-cap" => match count(&form.quantity_cap, false) {
            Ok(Some(cap)) => ListingCommand::QuantityCap { cap, fee_quote_fingerprint: fingerprint },
            _ => {
                errors.add(f.quantity_cap, p.seller_listing_whole_number());
                return Err(errors);
            }
        },
        "update-purchase-limits" => {
            let read = |name, text: &str, errors: &mut Errors| {
                count(text, true).unwrap_or_else(|()| {
                    errors.add(name, p.seller_listing_whole_number());
                    None
                })
            };
            let per_order = read(f.max_units_per_order, &form.max_units_per_order, &mut errors);
            let per_day = read(f.max_units_per_day, &form.max_units_per_day, &mut errors);
            let per_customer = read(f.max_units_per_customer_account, &form.max_units_per_customer_account, &mut errors);
            if !errors.is_empty() {
                return Err(errors);
            }
            ListingCommand::PurchaseLimits { per_order, per_day, per_customer }
        }
        "classify-photo" => {
            // The view is the slot's, as the listing's policy names it (marketplace reads it again).
            let slot = listing
                .and_then(|l| l.evidence_readiness.requirements.required_slots.iter().find(|s| s.slot_id == form.slot_id.trim()));
            ListingCommand::Classify {
                photo: form.photo_id.clone(),
                slot_id: slot.map(|s| s.slot_id.clone()),
                view_kind: slot.map(|s| s.view_kind.clone()).filter(|v| !v.is_empty()),
                alt_text: some(&form.alt_text),
            }
        }
        "remove-photo" => ListingCommand::RemovePhoto { photo: form.photo_id.clone() },
        "reorder-photos" => ListingCommand::Reorder {
            photos: form.ordered_photo_ids.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect(),
        },
        "publish" => ListingCommand::Publish { fee_quote_fingerprint: fingerprint },
        "pause" => ListingCommand::Pause,
        "withdraw" => ListingCommand::Withdraw,
        _ => {
            errors.add_form(p.check_attempt());
            return Err(errors);
        }
    };
    Ok(command)
}

/// What came of the evidence after a write (`evidenceEvent`).
fn event(command: &ListingCommand) -> Option<&'static str> {
    match command {
        ListingCommand::Publish { .. } => Some("publication_succeeded"),
        ListingCommand::Classify { .. } | ListingCommand::RemovePhoto { .. } | ListingCommand::Reorder { .. } => {
            Some("remediation_completed")
        }
        _ => None,
    }
}

/// The closed authoring codes an image description is refused with, and their words
/// (`authoredTextRecoveryCopy`).
fn alt_text_recovery(t: SellerListingMsg, code: &str) -> Option<(String, bool)> {
    let message = match code {
        "text_control_character" => t.recovery_control_character(),
        "text_direction_override" => t.recovery_direction_override(),
        "text_unsafe_link" => t.recovery_unsafe_link(),
        "text_duplicate_link" => t.recovery_duplicate_link(),
        "rate_limited" => t.recovery_rate_limited(),
        _ => return None,
    };
    Some((message.to_owned(), code != "rate_limited"))
}

/// The form `form` sent, kept in the page drawn again.
fn kept(form: &ListingForm, errors: Errors) -> Edits {
    let typed = |text: &str| Some(text.to_owned());
    let mut edits = Edits { errors, ..Edits::default() };
    match form.intent.as_str() {
        "update-price" => {
            edits.price_amount = typed(&form.price_amount);
            edits.price_currency_code = typed(&form.price_currency_code);
        }
        "update-quantity-cap" => edits.quantity_cap = typed(&form.quantity_cap),
        "update-purchase-limits" => {
            edits.limits = Some([
                form.max_units_per_order.clone(),
                form.max_units_per_day.clone(),
                form.max_units_per_customer_account.clone(),
            ]);
        }
        _ => {}
    }
    edits
}

/// A write's failure: sign in, the page again with what was refused, or the error page.
#[allow(clippy::too_many_arguments)]
async fn refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    form: &ListingForm,
    error: CommandError,
    photos: bool,
) -> HtmlResult {
    let (t, p): (SellerListingMsg, Pilot) = (req.t(), req.t());
    let mut edits = kept(form, Errors::new());
    edits.photos_lost = photos;
    let mut readiness = None;
    let status = match error {
        CommandError::StaleQuote(quote) => {
            edits.errors.add_form(t.route_fee_quote_stale());
            edits.preview = Some(*quote);
            StatusCode::CONFLICT
        }
        CommandError::EvidenceIncomplete { message, readiness: now } => {
            edits.errors.add_form(message);
            readiness = Some(*now);
            StatusCode::CONFLICT
        }
        CommandError::Api(error) => match (error.status(), error.code(), error.refusal()) {
            (Some(StatusCode::UNAUTHORIZED), ..) => return sign_in(req),
            (_, Some(code), _) if form.intent == "classify-photo" && alt_text_recovery(t, code).is_some() => {
                let (message, field_level) = alt_text_recovery(t, code).expect("checked");
                edits.alt_text =
                    Some(AltTextRefused { photo: form.photo_id.clone(), text: form.alt_text.clone(), message, field_level });
                StatusCode::UNPROCESSABLE_ENTITY
            }
            (_, _, Some(message)) => {
                edits.errors.add_form(message);
                error.status().filter(|s| *s == StatusCode::CONFLICT).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY)
            }
            // A photo the API cannot decode is a 500 (chase-sets/chase-sets#10649).
            (Some(status), ..) if photos && status.is_server_error() => {
                tracing::warn!("a listing photo write failed: {error}");
                edits.errors.add_form(p.seller_listing_photos_unprocessed());
                StatusCode::UNPROCESSABLE_ENTITY
            }
            _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    render(req, viewer, config, headers, id, (None, None), edits, readiness, status).await
}

pub(crate) async fn write(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListing<'_>>,
    Form(form): Form<ListingForm>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    // Classify names the slot; its view is read from the listing, as marketplace does.
    let listing = match form.intent.as_str() {
        "classify-photo" => match caller.seller_listing(&id).await {
            Ok(listing) => Some(listing),
            Err(error) => return failed_read(&req, &viewer, error),
        },
        _ => None,
    };
    let command = match command(&form, listing.as_ref(), req.t()) {
        Ok(command) => command,
        Err(errors) => {
            return render(
                &req,
                &viewer,
                &config,
                &headers,
                &id,
                (None, None),
                kept(&form, errors),
                None,
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        }
    };
    match caller.listing_command(&id, &command).await {
        Ok(receipt) => applied(&req, &id, receipt, event(&command)),
        Err(error) => refused(&req, &viewer, &config, &headers, &id, &form, error, false).await,
    }
}

fn failed_read(req: &Req, viewer: &Viewer, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::NOT_FOUND) => Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND)),
        _ => read_failed(req, Some(viewer), error, None),
    }
}

/// Add photos and Replace photo: `multipart/form-data`, read with Corten's `Upload` (`uploads::read`).
pub(crate) async fn photos(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListingPhotos<'_>>,
    upload: Upload<Raw>,
) -> HtmlResult {
    let id = route.id;
    let p: Pilot = req.t();
    let f = ListingForm::FIELDS;
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(UploadError::TooLarge { .. }) => {
            let mut edits = Edits { photos_lost: true, ..Edits::default() };
            edits.errors.add_form(p.seller_listing_photos_too_large());
            return render(&req, &viewer, &config, &headers, &id, (None, None), edits, None, StatusCode::PAYLOAD_TOO_LARGE).await;
        }
        Err(other) => return Err(other.into()),
    };
    let first = |name: FieldName| crate::listing_new::first(&posted.fields, name.as_str());
    let form = ListingForm {
        intent: first(f.intent),
        photo_id: first(f.photo_id),
        slot_id: first(f.slot_id),
        alt_text: first(f.alt_text),
        ..ListingForm::default()
    };
    let input = match form.intent.as_str() {
        "add-photos" => f.evidence,
        "replace-photo" => f.listing_photo,
        _ => return Err(corten::Error::status(StatusCode::BAD_REQUEST)),
    };
    let files: Vec<_> = posted.files.into_iter().filter(|u| u.field == input.as_str() && !u.bytes.is_empty()).collect();
    let refusal = match posted.over {
        Some(Over::FileTooLarge) => Some(p.seller_listing_photo_size()),
        Some(Over::TooManyFiles) => Some(p.seller_listing_photo_count()),
        None if files.is_empty() => Some(p.seller_listing_choose_photo()),
        None if files.iter().any(|u| !uploads::is_picture(&u.content_type, &u.bytes)) => Some(p.seller_listing_photo_type()),
        None => None,
    };
    if let Some(message) = refusal {
        let mut edits = Edits { photos_lost: true, ..Edits::default() };
        edits.errors.add_form(message);
        return render(&req, &viewer, &config, &headers, &id, (None, None), edits, None, StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let photos: Vec<Photo> =
        files.into_iter().map(|u| Photo { filename: u.filename, content_type: u.content_type, bytes: u.bytes }).collect();
    let caller = config.platform.caller(&headers, config.proto, None);
    let result = match form.intent.as_str() {
        "add-photos" => caller.add_listing_photos(&id, &photos, None).await,
        _ => {
            // The replacement keeps the photo's slot and view (`replacementPhotoFormData`).
            let fields = [
                ("slotId", first(f.slot_id)),
                ("viewKind", crate::listing_new::first(&posted.fields, "viewKind")),
                ("listingPhotoAltText", first(f.alt_text)),
            ];
            caller.replace_listing_photo(&id, &form.photo_id, &photos[0], &fields).await
        }
    };
    match result {
        Ok(receipt) => applied(&req, &id, receipt, Some("upload_completed")),
        Err(error) => refused(&req, &viewer, &config, &headers, &id, &form, error, true).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_count_is_a_whole_number_of_at_least_one_and_a_limit_may_be_blank() {
        assert_eq!(count("3", false), Ok(Some(3)));
        assert_eq!(count(" 12 ", true), Ok(Some(12)));
        assert_eq!(count("", true), Ok(None));
        assert_eq!(count("", false), Err(()));
        assert_eq!(count("0", true), Err(()));
        assert_eq!(count("1.5", false), Err(()));
    }
}
