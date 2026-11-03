//! An inventory item's page (marketplace's `/account/inventory/items/{id}`): the item, Record
//! sale, Adjust Quantity, Create Hold, its holds (a manual one released from its card) and its
//! stock ledger, filtered by kind.
//!
//! Adjust Quantity, Create Hold and Release hold are Inventory writes confirmed as the list's are
//! (`item-adjust`, `hold-create` and `hold-release`, see `recovery`): each form carries its attempt,
//! the browser remembers it, and an applied write comes back to the page with its receipt and the
//! attempt to confirm. An adjustment the API recorded as a collision with orders' holds is not a
//! change: the page says the API's words for it, as marketplace does. Record sale is the list's form
//! (`inventory_list::SaleInput`), drawn on the page; a recorded sale comes back with what it did in
//! the address, read after its receipt.
use crate::recovery::attempt_text;
use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::{Deserialize, Serialize};

use crate::chrome::Chrome;
use crate::{
    api::{AdjustCommand, ApiError, HoldCommand, InventoryItemCalls as _, InventoryItemDetail, InventoryList as _, SaleResult},
    app::{Config, Shared, read_failed, sign_in, url},
    auth::{Seller, Viewer},
    inventory_list::{Outcome, SaleDraft, SaleInput, Verified, can_honor},
    recovery::{self, Check, Failed, Family, Status, failed, valid_attempt},
    text::{InventoryMsg, Pilot},
    views::{self, Layout},
};

/// The adjustment reasons a seller may give (marketplace's Adjust Quantity choices).
pub const REASONS: [&str; 4] = ["damaged", "lost", "found", "correction"];

/// What the item page's address carries besides a write to confirm: the ledger's filter and what
/// the last sale did (marketplace keeps that in the history's state; the pilot keeps it in the
/// address, as the list does).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[serde(rename_all = "camelCase")]
#[route(query)]
pub struct ItemPlace {
    pub ledger_kind: Option<String>,
    pub requested: Option<u64>,
    pub applied: Option<u64>,
    pub refused: Option<u64>,
    /// The orders an honored sale affected, comma separated.
    pub orders: Option<String>,
}

impl ItemPlace {
    /// The ledger's filter, when it names a kind.
    pub fn kind(&self) -> Option<&str> {
        self.ledger_kind.as_deref().map(str::trim).filter(|k| !k.is_empty())
    }

    /// The page filtered to `kind` (all movements for `None`), with nothing else.
    pub fn filtered(&self, kind: Option<&str>) -> ItemPlace {
        ItemPlace { ledger_kind: kind.map(str::to_owned), ..ItemPlace::default() }
    }

    /// What the last sale of `item` did, when the address says.
    fn outcome(&self, item: &str) -> Option<Outcome> {
        Some(Outcome {
            item_id: item.to_owned(),
            requested: self.requested?,
            applied: self.applied?,
            refused: self.refused?,
            orders: self.orders.as_deref().unwrap_or_default().split(',').filter(|o| !o.is_empty()).map(str::to_owned).collect(),
        })
    }
}

/// Adjust Quantity's fields, in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct AdjustInput {
    pub inventory_mutation_attempt_id: Option<SubmitKey>,
    pub quantity_delta: String,
    pub reason_code: String,
    pub reason: String,
    pub note: String,
}

impl AdjustInput {
    /// The request, or what is wrong with the form. The rules are Inventory's; the pilot checks
    /// what the inputs ask of the browser.
    pub fn command(&self, p: Pilot) -> Result<AdjustCommand, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        if !valid_attempt(attempt_text(&self.inventory_mutation_attempt_id)) {
            errors.add_form(p.check_attempt());
        }
        let delta = self.quantity_delta.trim().parse::<i64>().ok().filter(|d| *d != 0);
        if delta.is_none() {
            errors.add(f.quantity_delta, p.inventory_delta());
        }
        if !REASONS.contains(&self.reason_code.as_str()) {
            errors.add(f.reason_code, p.check_required());
        }
        if self.reason.trim().is_empty() {
            errors.add(f.reason, p.check_required());
        }
        let note = self.note.trim();
        errors.into_result(AdjustCommand {
            quantity_delta: delta.unwrap_or_default(),
            reason: self.reason.trim().to_owned(),
            reason_code: self.reason_code.clone(),
            note: (!note.is_empty()).then(|| note.to_owned()),
        })
    }
}

/// Create Hold's fields, in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct HoldInput {
    pub inventory_mutation_attempt_id: Option<SubmitKey>,
    pub quantity: String,
    pub reason: String,
    pub notes: String,
}

impl HoldInput {
    pub fn command(&self, p: Pilot) -> Result<HoldCommand, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        if !valid_attempt(attempt_text(&self.inventory_mutation_attempt_id)) {
            errors.add_form(p.check_attempt());
        }
        let quantity = self.quantity.trim().parse::<u64>().ok().filter(|q| *q >= 1);
        if quantity.is_none() {
            errors.add(f.quantity, p.inventory_quantity());
        }
        if self.reason.trim().is_empty() {
            errors.add(f.reason, p.check_required());
        }
        let notes = self.notes.trim();
        errors.into_result(HoldCommand {
            quantity: quantity.unwrap_or_default(),
            reason: self.reason.trim().to_owned(),
            notes: (!notes.is_empty()).then(|| notes.to_owned()),
        })
    }
}

/// Release hold's one field.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleaseInput {
    pub inventory_mutation_attempt_id: Option<SubmitKey>,
}

/// A form the page draws again as it was sent, with what is wrong.
#[derive(Clone, Debug, Default)]
pub struct Drafts {
    pub adjust: Option<(AdjustInput, Errors)>,
    pub hold: Option<(HoldInput, Errors)>,
    /// A refused release: the hold and why.
    pub release: Option<(String, Errors)>,
    pub sale: Option<SaleDraft>,
    /// What a form without a draft shows: nothing typed and nothing wrong.
    blank: Blank,
}

#[derive(Clone, Debug, Default)]
struct Blank {
    adjust: (AdjustInput, Errors),
    hold: (HoldInput, Errors),
    sale: SaleDraft,
}

impl Drafts {
    pub fn adjust(&self) -> &(AdjustInput, Errors) {
        self.adjust.as_ref().unwrap_or(&self.blank.adjust)
    }

    pub fn hold(&self) -> &(HoldInput, Errors) {
        self.hold.as_ref().unwrap_or(&self.blank.hold)
    }

    /// Why `hold`'s release was refused, when it was.
    pub fn release(&self, hold: &str) -> &Errors {
        self.release.as_ref().filter(|(h, _)| h == hold).map_or(&self.blank.adjust.1, |(_, e)| e)
    }

    pub fn sale(&self) -> &SaleDraft {
        self.sale.as_ref().unwrap_or(&self.blank.sale)
    }
}

/// The screen's view model: what the page shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct ItemScreen {
    pub item: InventoryItemDetail,
    pub status: Status,
    pub outcome: Option<Outcome>,
    pub verified: Option<Verified>,
    /// The API's words for an adjustment it recorded as a collision with orders' holds.
    pub notice: Option<String>,
    /// `inventory.manage`: the page's writes are drawn.
    pub can_manage: bool,
    pub can_honor: bool,
    #[serde(skip)]
    pub place: ItemPlace,
}

impl ItemScreen {
    /// The ledger's kinds, in the order they first appear.
    pub fn kinds(&self) -> Vec<&str> {
        let mut kinds: Vec<&str> = Vec::new();
        for entry in &self.item.ledger {
            if !kinds.contains(&entry.kind.as_str()) {
                kinds.push(&entry.kind);
            }
        }
        kinds
    }

    /// The ledger, filtered to the address's kind.
    pub fn ledger(&self) -> impl Iterator<Item = &crate::api::LedgerEntry> {
        let kind = self.place.kind();
        self.item.ledger.iter().filter(move |e| kind.is_none_or(|k| e.kind == k))
    }
}

/// What a write's answer adds to the page.
enum Posted {
    /// Nothing: the page as its address asks.
    Nothing,
    /// The write was refused (422): its form again, and the status that settles its attempt.
    Refused(Status),
    /// An adjustment the API recorded as a collision with orders' holds, and its words for it.
    Collided(Status, Option<String>),
}

/// The page for its address, with a refused write's form in place of its default.
#[allow(clippy::too_many_arguments)]
async fn render(
    req: &Req,
    viewer: &Viewer,
    config: &Config,
    headers: &HeaderMap,
    id: &str,
    place: &ItemPlace,
    check: &Check,
    drafts: Drafts,
    posted: Posted,
    chrome: &Chrome,
) -> HtmlResult {
    let (posted, refused, notice) = match posted {
        Posted::Nothing => (None, false, None),
        Posted::Refused(status) => (Some(status), true, None),
        Posted::Collided(status, notice) => (Some(status), false, notice),
    };
    let receipt = Receipt::from_param(check.after_write.as_deref());
    let caller = config.platform.caller(headers, config.proto, receipt.as_ref());
    let status = async {
        if let Some(status) = &posted {
            return status.clone();
        }
        match &check.attempt {
            // The attempt's result is read as it is now, without waiting for a projection.
            Some(attempt) => {
                let plain = config.platform.caller(headers, config.proto, None);
                let (family, target, user) = (check.family, check.target.as_deref(), check.user.as_deref());
                recovery::check(&plain, &viewer.actor, attempt, family, target, user).await
            }
            None => Status::Ready,
        }
    };
    let (item, status) = tokio::join!(caller.inventory_item_detail(id), status);
    let (t, p): (InventoryMsg, Pilot) = (req.t(), req.t());
    let item = match item {
        Ok(item) => item,
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) && receipt.is_none() => {
            return Err(corten::Error::new(error).with_status(StatusCode::NOT_FOUND));
        }
        // marketplace's `unverified`: the read after a write did not catch up.
        Err(error) => {
            return read_failed(
                req,
                Some(viewer),
                error,
                receipt.is_some().then(|| p.inventory_item_unverified()),
                chrome.cart().await,
            );
        }
    };
    let outcome = place.outcome(id);
    let verified = outcome.as_ref().map(|_| match &receipt {
        Some(_) => Verified::Fresh(item.item.available_quantity),
        None => Verified::Unverified,
    });
    let screen = ItemScreen {
        item,
        status,
        outcome,
        verified,
        notice,
        can_manage: viewer.actor.can("inventory.manage"),
        can_honor: can_honor(viewer),
        place: place.clone(),
    };
    let m: crate::text::Msg = req.t();
    // A refused form with a script: only that form is drawn again, in place.
    if req.mode == corten::Mode::Action && refused {
        return req.patch_with_status(StatusCode::UNPROCESSABLE_ENTITY, views::refused_stock(t, p, m, viewer, &screen, &drafts));
    }
    let code = if refused { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::OK };
    let title = t.item_route_inventory_item_marketplace();
    let head = html! { <meta name="description" content={t.item_route_inspect_a_specific_inventory_item_its()}> };
    let again = url::StockItem { id, place: place.clone(), check: check.again() };
    let view =
        html! { <views::InventoryItemPage t={t} p={p} m={m} viewer={viewer} screen={&screen} drafts={&drafts} again={&again} /> };
    let cart = chrome.cart().await;
    req.screen_with_status(
        code,
        &screen,
        html! { <Layout req={req} viewer={Some(viewer)} cart={cart} title={title} head={head}>{view}</Layout> },
    )
}

pub(crate) async fn open(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::StockItem<'_>>,
) -> HtmlResult {
    let (id, place, check) = (route.id, route.place, route.check);
    render(&req, &viewer, &config, &headers, &id, &place, &check, Drafts::default(), Posted::Nothing, &chrome).await
}

/// The page after an applied write: its receipt, and the attempt to confirm.
fn applied(req: &Req, id: &str, family: Family, target: &str, attempt: &str, receipt: Option<Receipt>) -> HtmlResult {
    let check = Check::applied(family, target, attempt, receipt.map(|r| r.param()));
    req.redirect(&url::StockItem { id, place: ItemPlace::default(), check })
}

/// What a refused write's API answer means: its form again with the API's words, the page that
/// confirms an attempt applied before, sign-in, or the error page.
enum Answer {
    Refused(Errors),
    Done(HtmlResult),
}

async fn refused(
    req: &Req,
    caller: &crate::api::Caller<'_>,
    id: &str,
    family: Family,
    target: &str,
    attempt: &str,
    error: ApiError,
) -> Answer {
    match failed(caller, family, target, attempt, error).await {
        Failed::Refused(errors) => Answer::Refused(errors),
        Failed::AppliedBefore => Answer::Done(applied(req, id, family, target, attempt, None)),
        Failed::SignIn => Answer::Done(sign_in(req)),
        Failed::Unknown(error) => Answer::Done(Err(error)),
    }
}

/// Adjust Quantity: the page again after an applied adjustment, or with the API's words for one it
/// recorded as a collision; a refused one is its form again.
pub(crate) async fn adjust(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::StockAdjust<'_>>,
    Form(input): Form<AdjustInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let attempt = attempt_text(&input.inventory_mutation_attempt_id).to_owned();
    let errors = match input.command(req.t()) {
        Ok(command) => match caller.adjust_item(&attempt, &id, &command).await {
            Ok((adjusted, receipt)) if adjusted.status == "hold-collision-recorded" => {
                // Nothing changed on hand: the page says what the API recorded, and settles the attempt.
                let notice = adjusted.message.filter(|m| !m.trim().is_empty());
                let check = Check { after_write: receipt.map(|r| r.param()), ..Check::default() };
                let posted = Posted::Collided(Status::Confirmed(attempt), notice);
                return render(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    &id,
                    &ItemPlace::default(),
                    &check,
                    Drafts::default(),
                    posted,
                    &chrome,
                )
                .await;
            }
            Ok((_, receipt)) => return applied(&req, &id, Family::ItemAdjust, &id, &attempt, receipt),
            Err(error) => match refused(&req, &caller, &id, Family::ItemAdjust, &id, &attempt, error).await {
                Answer::Refused(errors) => errors,
                Answer::Done(answer) => return answer,
            },
        },
        Err(errors) => errors,
    };
    let drafts = Drafts { adjust: Some((input, errors)), ..Drafts::default() };
    let posted = Posted::Refused(Status::Refused(attempt));
    render(&req, &viewer, &config, &headers, &id, &ItemPlace::default(), &Check::default(), drafts, posted, &chrome).await
}

/// Create Hold: the page again after an applied hold; a refused one is its form again.
pub(crate) async fn hold(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::StockHold<'_>>,
    Form(input): Form<HoldInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let attempt = attempt_text(&input.inventory_mutation_attempt_id).to_owned();
    let errors = match input.command(req.t()) {
        Ok(command) => match caller.create_hold(&attempt, &id, &command).await {
            Ok(written) => return applied(&req, &id, Family::HoldCreate, &id, &attempt, written.receipt),
            Err(error) => match refused(&req, &caller, &id, Family::HoldCreate, &id, &attempt, error).await {
                Answer::Refused(errors) => errors,
                Answer::Done(answer) => return answer,
            },
        },
        Err(errors) => errors,
    };
    let drafts = Drafts { hold: Some((input, errors)), ..Drafts::default() };
    let posted = Posted::Refused(Status::Refused(attempt));
    render(&req, &viewer, &config, &headers, &id, &ItemPlace::default(), &Check::default(), drafts, posted, &chrome).await
}

/// Release hold: the page again after an applied release; a refused one says why on the hold.
pub(crate) async fn release(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::StockRelease<'_>>,
    Form(input): Form<ReleaseInput>,
) -> HtmlResult {
    let (id, hold) = (route.id, route.hold);
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let attempt = attempt_text(&input.inventory_mutation_attempt_id).to_owned();
    let errors = if valid_attempt(&attempt) {
        match caller.release_hold(&attempt, &hold).await {
            Ok(written) => return applied(&req, &id, Family::HoldRelease, &hold, &attempt, written.receipt),
            Err(error) => match refused(&req, &caller, &id, Family::HoldRelease, &hold, &attempt, error).await {
                Answer::Refused(errors) => errors,
                Answer::Done(answer) => return answer,
            },
        }
    } else {
        let mut errors = Errors::new();
        errors.add_form(p.check_attempt());
        errors
    };
    let drafts = Drafts { release: Some((hold, errors)), ..Drafts::default() };
    let posted = Posted::Refused(Status::Refused(attempt));
    render(&req, &viewer, &config, &headers, &id, &ItemPlace::default(), &Check::default(), drafts, posted, &chrome).await
}

/// Record sale: the page with what the sale did, read after its receipt; a refused one is its
/// form again with what was typed.
pub(crate) async fn sale(
    req: Req,
    chrome: Chrome,
    Caller(Seller(viewer)): Caller<Seller>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::inventory::StockSale<'_>>,
    Form(input): Form<SaleInput>,
) -> HtmlResult {
    let id = route.id;
    let p: Pilot = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let errors = match input.command(p, can_honor(&viewer)) {
        Ok(command) => match caller.offline_sale(&id, &command).await {
            Ok((result, receipt)) => return sold(&req, &id, &result, receipt),
            Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(&req),
            Err(error) => match error.refusal() {
                Some(message) => {
                    let mut errors = Errors::new();
                    errors.add_form(message);
                    errors
                }
                None => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
            },
        },
        Err(errors) => errors,
    };
    let drafts = Drafts { sale: Some(SaleDraft { item_id: id.clone(), input, errors }), ..Drafts::default() };
    // A sale's key is its own (`SubmitKey`), not an Inventory attempt: nothing to settle.
    render(
        &req,
        &viewer,
        &config,
        &headers,
        &id,
        &ItemPlace::default(),
        &Check::default(),
        drafts,
        Posted::Refused(Status::Ready),
        &chrome,
    )
    .await
}

/// The page after a sale: what it did, and its receipt.
fn sold(req: &Req, id: &str, result: &SaleResult, receipt: Option<Receipt>) -> HtmlResult {
    let orders: Vec<&str> = result.collision.iter().flat_map(|c| c.affected_orders.iter()).map(|o| o.order_id.as_str()).collect();
    let place = ItemPlace {
        ledger_kind: None,
        requested: Some(result.requested_quantity),
        applied: Some(result.applied_quantity),
        refused: Some(result.refused_quantity),
        orders: (!orders.is_empty()).then(|| orders.join(",")),
    };
    let check = Check { after_write: receipt.map(|r| r.param()), ..Check::default() };
    req.redirect(&url::StockItem { id, place, check })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_adjustment_is_a_whole_number_other_than_zero_with_a_reason() {
        let p = Pilot::default();
        let input = |delta: &str, code: &str, reason: &str| AdjustInput {
            inventory_mutation_attempt_id: recovery::submit_key(&recovery::new_attempt()),
            quantity_delta: delta.into(),
            reason_code: code.into(),
            reason: reason.into(),
            note: " ".into(),
        };
        let sent = input("-2", "damaged", " Water ").command(p).unwrap();
        assert_eq!((sent.quantity_delta, sent.reason.as_str(), sent.note), (-2, "Water", None));
        for (delta, code, reason) in [("0", "lost", "x"), ("1.5", "lost", "x"), ("2", "sold-offline", "x"), ("2", "found", " ")] {
            assert!(input(delta, code, reason).command(p).is_err(), "{delta} {code} {reason:?}");
        }
    }

    #[test]
    fn the_ledger_filter_is_one_kind_or_every_movement() {
        let place = ItemPlace { ledger_kind: Some(" adjusted ".into()), applied: Some(1), ..ItemPlace::default() };
        assert_eq!(place.kind(), Some("adjusted"));
        let all = place.filtered(None);
        assert_eq!((all.kind(), all.applied), (None, None));
        assert!(ItemPlace { ledger_kind: Some(String::new()), ..ItemPlace::default() }.kind().is_none());
    }
}
