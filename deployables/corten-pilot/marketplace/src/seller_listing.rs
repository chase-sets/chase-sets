//! The seller's listing (marketplace's `account-listing` route, `/account/listings/{id}`): the
//! listing read after the write whose receipt its address carries, its fee lock history, and
//! every write marketplace's action takes: the price (with Preview fees, a GET of the page), the
//! quantity cap, the purchase limits, publish, pause and withdraw, and a draft's photos (add,
//! classify, replace, remove and reorder). A write that applied goes back to the page with its
//! receipt (`afterWrite`) and what came of the evidence (`evidenceEvent`), as marketplace's
//! does; one refused is the page again with the API's words. Each write but the photos' is a
//! Listing change Marketplace prepares from its form's `SubmitKey` (`listing_recovery`) and is
//! sent under the batch id it answers, so a form sent again applies once. The page after it names
//! the change (`listingRecovery`) and says what came of it; one whose answer was lost reads it
//! back. While the page names a change, every write, the photos' too, is prepared against it, and
//! one it does not offer to enter again is not sent. When the listing cannot be read, a page
//! naming a change says only that (marketplace's `recoveryOnly`). The two photo writes post
//! `multipart/form-data` to `/photos`, read with Corten's `Upload` (`uploads::read`).
use std::time::Duration;

use corten::{
    SubmitKey,
    extract::State,
    form::Errors,
    http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::{post_write::Surface, receipt::Receipt};

use crate::{
    api::{
        ApiError, Caller as Api, CommandError, EvidenceReadiness, FeeHistoryEntry, ListingCommand, ListingCreate as _,
        ListingRecovery, ListingReference, Photo, SellerListing, SellerListings as _, TermsPreview,
    },
    app::{Shared, read_failed, sign_in, url},
    auth::{ListingManager, Viewer},
    items::Raw,
    listing_new::LIMITS,
    listing_recovery::{self, Change, Next},
    text::{Pilot, SellerListingMsg},
    uploads::{self, Over},
    views::{self, Layout},
};

/// How long a write with photos may take, here and at the API.
pub const DEADLINE: Duration = Duration::from_secs(150);

/// What the page's address carries, in marketplace's names so its links and the pilot's agree:
/// the last write's receipt, what came of the evidence, a price to preview, and the change it
/// names.
#[derive(Clone, Debug, Default, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct Place {
    pub evidence_event: Option<String>,
    pub after_write: Option<String>,
    /// Preview fees: preview `price_amount`.
    pub preview: Option<String>,
    pub price_amount: Option<String>,
    pub price_currency_code: Option<String>,
    /// The Listing change the page names: its reference's JSON (`listing_recovery::param`).
    pub listing_recovery: Option<String>,
}

/// The forms' fields, for their names: marketplace's.
#[derive(Clone, Debug, Default, Fields)]
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
    /// The form's attempt, drawn with it: the same form sent again is the same Listing attempt
    /// (marketplace's `ListingCommandForm`). The photo forms send none.
    pub attempt: Option<SubmitKey>,
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
    /// What came of a change the page did not send, or of one refused; else what came of the
    /// change the address names is read.
    pub recovery: Option<ListingRecovery>,
}

/// The page.
pub struct ListingScreen {
    pub listing: SellerListing,
    pub fees: Vec<FeeHistoryEntry>,
    pub edits: Edits,
    /// What came of the change the page names or did not send.
    pub recovery: Option<ListingRecovery>,
    /// The change the address names, which the forms' address keeps.
    pub naming: Option<String>,
}

impl ListingScreen {
    /// Whether the page's writes are off: what it says came of a change is recorded, or nothing
    /// is confirmed (`ListingRecovery::blocks`).
    pub fn blocked(&self) -> bool {
        self.recovery.as_ref().is_some_and(ListingRecovery::blocks)
    }

    /// Where the forms post: the page, naming the change it names.
    pub fn place(&self) -> Place {
        Place { listing_recovery: self.naming.clone(), ..Place::default() }
    }

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
/// preparing page, which reads itself again (`ListingDetailRecoveryPage`). `naming` is the change
/// the address names; what came of it is read beside the listing, without the receipt, unless the
/// write drew its own (`edits.recovery`). A page naming a change that cannot read the listing or
/// its fee history says only what came of the change (`recoveryOnly`).
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    (receipt, event): (Option<&Receipt>, Option<&str>),
    naming: Option<&str>,
    mut edits: Edits,
    readiness: Option<EvidenceReadiness>,
    status: StatusCode,
) -> HtmlResult {
    let t: SellerListingMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, receipt);
    // The fee history is read without the receipt, as marketplace's `nonFreshApi` reads it, and
    // beside the listing's read; so is what came of the change the address names.
    let history = config.platform.caller(headers, config.proto, None);
    let drawn = edits.recovery.take();
    let recovery = async {
        match drawn {
            Some(recovery) => Some(recovery),
            None => listing_recovery::read(&history, naming).await,
        }
    };
    let (listing, fees, recovery) = tokio::join!(caller.seller_listing(id), history.fee_history(id), recovery);
    LISTING.read(&listing, receipt.is_some());
    if let Some(recovery) = &recovery
        && (listing.is_err() || fees.is_err())
    {
        if let Err(error) = &listing {
            tracing::warn!("the listing could not be read after a change: {error}");
        } else if let Err(error) = &fees {
            tracing::warn!("the fee history could not be read after a change: {error}");
        }
        return recovery_only(req, viewer, id, naming, recovery);
    }
    let mut listing = match listing {
        Ok(listing) => listing,
        Err(error) if receipt.is_some() && error.catching_up() => {
            let mut again = at(id, receipt, event);
            again.place.listing_recovery = naming.map(str::to_owned);
            return preparing(req, viewer, &again);
        }
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
    let screen = ListingScreen { listing, fees, edits, recovery, naming: naming.map(str::to_owned) };
    let title = screen.listing.item_title.clone().unwrap_or_else(|| screen.listing.catalog_catalog_item_id.clone());
    let view = html! { <views::SellerListingPage t={t} p={req.t()} r={req.t()} id={id} screen={&screen} /> };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={&title} head={()}>{view}</Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// Only what came of the change the address names, for a listing that cannot be read.
fn recovery_only(req: &Req, viewer: &Viewer, id: &str, naming: Option<&str>, recovery: &ListingRecovery) -> HtmlResult {
    let t: SellerListingMsg = req.t();
    let here = url::SellerListing { id, place: Place { listing_recovery: naming.map(str::to_owned), ..Place::default() } };
    let (here, clear) = (here.href(), url::SellerListing { id, place: Place::default() }.href());
    let view = html! { <views::ListingRecoveryNotice t={req.t()} recovery={recovery} here={&here} clear={&clear} /> };
    req.page(html! {
        <Layout req={req} viewer={Some(viewer)} title={t.route_listing_marketplace()} head={()}>{view}</Layout>
    })
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
    render(&req, &viewer, &config, &headers, &id, read, place.listing_recovery.as_deref(), edits, None, StatusCode::OK).await
}

/// The page's post-write reports (marketplace's `ACCOUNT_LISTING_POST_WRITE_TELEMETRY`).
const LISTING: Surface = Surface {
    context: "marketplace",
    surface: "account-listing",
    route_id: "account-listing",
    route_template: "/account/listings/:listingId",
};

/// The listing's page read after the write `receipt` follows, saying what came of its evidence
/// (`evidenceEvent`): where a create or a photo write that applied goes.
pub fn at<'a>(id: &'a str, receipt: Option<&Receipt>, event: Option<&str>) -> url::SellerListing<'a> {
    let place = Place { after_write: receipt.map(Receipt::param), evidence_event: event.map(str::to_owned), ..Place::default() };
    url::SellerListing { id, place }
}

/// The listing's page naming the change `reference`, read after the write `receipt` follows:
/// where a prepared change that applied goes, and one whose answer was lost
/// (`listingRecoveryUrl`).
fn changed<'a>(
    id: &'a str,
    reference: &ListingReference,
    receipt: Option<&Receipt>,
    event: Option<&str>,
) -> url::SellerListing<'a> {
    let mut to = at(id, receipt, event);
    to.place.listing_recovery = Some(listing_recovery::param(reference));
    to
}

/// The page after a photo write that applied, read after its receipt.
fn applied(req: &Req, id: &str, receipt: Option<Receipt>, event: Option<&str>) -> HtmlResult {
    LISTING.navigated(receipt.as_ref(), None);
    req.redirect(&at(id, receipt.as_ref(), event))
}

/// What a write does before it is sent.
enum Gate {
    /// Send it, under this reference's batch id when it has one.
    Send(Option<ListingReference>),
    /// Send nothing: show this.
    Show(ListingRecovery),
}

/// Prepares a write from a page at `place` (marketplace's `prepareListingAction`): a
/// `recoverable` one always, under the form's attempt; another (a photo write) only from a page
/// naming a change, and sent without an attempt when its change allows it. An error only for a
/// session that ended.
async fn gate(caller: &Api<'_>, place: &Place, change: Change<'_>, recoverable: bool) -> Result<Gate, ApiError> {
    if !recoverable && place.listing_recovery.is_none() {
        return Ok(Gate::Send(None));
    }
    Ok(match listing_recovery::prepare(caller, place.listing_recovery.as_deref(), change).await? {
        Next::Send(reference) => Gate::Send(recoverable.then_some(reference)),
        Next::Show(recovery) => Gate::Show(recovery),
    })
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
    // Every command but the photo ones is an attempt, and a form drawn by the page has one.
    let photos =
        matches!(command, ListingCommand::Classify { .. } | ListingCommand::RemovePhoto { .. } | ListingCommand::Reorder { .. });
    if !photos && form.attempt.is_none() {
        errors.add_form(p.check_attempt());
        return Err(errors);
    }
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

/// A write's failure: sign in, the page again with what was refused, or the error page. A
/// prepared change refused is also said as a change (`reference`): in conflict for a 409, else
/// not applied, and the page's writes are off until another change is started.
#[allow(clippy::too_many_arguments)]
async fn refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &Place,
    form: &ListingForm,
    error: CommandError,
    reference: Option<&ListingReference>,
    photos: bool,
) -> HtmlResult {
    let t: SellerListingMsg = req.t();
    let mut edits = kept(form, Errors::new());
    edits.photos_lost = photos;
    let conflict = match &error {
        CommandError::StaleQuote(_) | CommandError::EvidenceIncomplete { .. } => true,
        CommandError::Api(error) => error.status() == Some(StatusCode::CONFLICT),
    };
    edits.recovery = reference.map(|reference| listing_recovery::refused(reference, id, conflict));
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
            // A prepared change refused without words: the notice says it was not applied.
            _ if edits.recovery.is_some() => StatusCode::UNPROCESSABLE_ENTITY,
            _ => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
        },
    };
    render(req, viewer, config, headers, id, (None, None), place.listing_recovery.as_deref(), edits, readiness, status).await
}

/// The page again, not having sent `form`'s write, saying `recovery`.
#[allow(clippy::too_many_arguments)]
async fn shown(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &Place,
    form: &ListingForm,
    recovery: ListingRecovery,
    photos: bool,
) -> HtmlResult {
    let edits = Edits { recovery: Some(recovery), photos_lost: photos, ..kept(form, Errors::new()) };
    render(req, viewer, config, headers, id, (None, None), place.listing_recovery.as_deref(), edits, None, StatusCode::CONFLICT)
        .await
}

pub(crate) async fn write(
    req: Req,
    Caller(ListingManager(viewer)): Caller<ListingManager>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::seller_listings::SellerListing<'_>>,
    Form(form): Form<ListingForm>,
) -> HtmlResult {
    let (id, place) = (route.id, route.place);
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
                place.listing_recovery.as_deref(),
                kept(&form, errors),
                None,
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        }
    };
    let photos =
        matches!(command, ListingCommand::Classify { .. } | ListingCommand::RemovePhoto { .. } | ListingCommand::Reorder { .. });
    let change = Change {
        intent: &form.intent,
        attempt: form.attempt.as_ref().map(SubmitKey::as_str),
        listing_id: Some(&id),
        listing_ids: &[],
        fields: listing_recovery::command_fields(&command),
    };
    let reference = match gate(&caller, &place, change, !photos).await {
        Ok(Gate::Send(reference)) => reference,
        Ok(Gate::Show(recovery)) => return shown(&req, &viewer, &config, &headers, &id, &place, &form, recovery, false).await,
        Err(_) => return sign_in(&req),
    };
    let attempt = reference.as_ref().map(|reference| reference.batch_id.as_str());
    match (caller.listing_command(&id, &command, attempt).await, &reference) {
        (Ok(receipt), Some(reference)) => {
            LISTING.navigated(receipt.as_ref(), None);
            req.redirect(&changed(&id, reference, receipt.as_ref(), event(&command)))
        }
        (Ok(receipt), None) => applied(&req, &id, receipt, event(&command)),
        (Err(CommandError::Api(error)), Some(reference)) if listing_recovery::interrupted(&error) => {
            tracing::warn!("a listing write's answer was lost: {error}");
            req.redirect(&changed(&id, reference, None, None))
        }
        (Err(error), reference) => {
            refused(&req, &viewer, &config, &headers, &id, &place, &form, error, reference.as_ref(), false).await
        }
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
    let (id, place) = (route.id, route.place);
    let p: Pilot = req.t();
    let f = ListingForm::FIELDS;
    let naming = place.listing_recovery.as_deref();
    let posted = match uploads::read(upload, LIMITS).await {
        Ok(posted) => posted,
        Err(UploadError::TooLarge { .. }) => {
            let mut edits = Edits { photos_lost: true, ..Edits::default() };
            edits.errors.add_form(p.seller_listing_photos_too_large());
            let status = StatusCode::PAYLOAD_TOO_LARGE;
            return render(&req, &viewer, &config, &headers, &id, (None, None), naming, edits, None, status).await;
        }
        Err(other) => return Err(other.into()),
    };
    let first = |name: FieldName<String>| crate::listing_new::first(&posted.fields, name.as_str());
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
        let status = StatusCode::UNPROCESSABLE_ENTITY;
        return render(&req, &viewer, &config, &headers, &id, (None, None), naming, edits, None, status).await;
    }
    let photos: Vec<Photo> =
        files.into_iter().map(|u| Photo { filename: u.filename, content_type: u.content_type, bytes: u.bytes }).collect();
    let caller = config.platform.caller(&headers, config.proto, None);
    let change =
        Change { intent: &form.intent, attempt: None, listing_id: Some(&id), listing_ids: &[], fields: Default::default() };
    match gate(&caller, &place, change, false).await {
        Ok(Gate::Send(_)) => {}
        Ok(Gate::Show(recovery)) => return shown(&req, &viewer, &config, &headers, &id, &place, &form, recovery, true).await,
        Err(_) => return sign_in(&req),
    }
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
        Err(error) => refused(&req, &viewer, &config, &headers, &id, &place, &form, error, None, true).await,
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
