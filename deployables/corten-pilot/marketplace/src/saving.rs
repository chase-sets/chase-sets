//! The item page's Add to List (marketplace's `AddToSavedListControl`, its item action's
//! `prepare-saved-list` and `commit-saved-list` in
//! bounded-contexts/discovery/support/request-support/saved-list-addition.ts): the product chosen,
//! added to one of the account's recent Saved Lists or to a new one, with a tracked quantity.
//!
//! | Who | Add to List | Then |
//! |---|---|---|
//! | An account with `accounts.view` | opens the dialog the page drew with its recent lists | the addition, and the page again saying so |
//! | An account without it (a guest checkout's session) | opens the dialog, which says it cannot | |
//! | A guest | posts the product | an intent, its owner in marketplace's cookie, then marketplace's registration, which claims it |
//!
//! Marketplace's button posts `prepare-saved-list`, which reads the recent lists and draws the
//! ids the addition is made with, then opens its sheet. The pilot reads the recent lists with the
//! page (Discovery's own projection, beside the item read, so the page waits no longer) and draws
//! the ids with the form, so the dialog opens with no request and no script, and the same form
//! sent twice is one addition. The form posts the page's address and the product it showed; the
//! product's options are taken from the page the form was drawn as, not the form, and Collections
//! checks the product against the catalog.
use corten::{
    axum::{
        extract::State,
        http::{HeaderMap, StatusCode, Uri, header},
    },
    prelude::*,
    security::cookie,
};
use serde::Serialize;

use crate::chrome::Chrome;
use crate::{
    api::{ApiError, Caller, Discovery as _, Item, RecentSavedList, SavedLists as _, Selected, segment},
    app::{Shared, sign_in_at, url},
    auth::Session,
    buying::BuyNotice,
    items::{self, Address, ItemScreen, PageReads, Raw},
    text::{ItemMsg, Pilot},
    views,
};

/// Marketplace's anonymous saved-list cookie (`COLLECTIONS_ANONYMOUS_SAVED_LIST_COOKIE_NAME`).
pub const ANONYMOUS_SAVED_LIST_COOKIE: &str = "chase_sets_anonymous_saved_lists";
/// How long it lasts (`THIRTY_DAYS_SECONDS`).
const GUEST_SECONDS: i64 = 30 * 24 * 60 * 60;
/// The item page's parameters after Add Product: the write's receipt, the list, the quantity
/// added and whether the product was on the list already (`merged`).
pub const SAVED: &str = "saved";
pub const SAVED_LIST: &str = "saved_list";
pub const SAVED_QUANTITY: &str = "saved_quantity";
pub const SAVED_LINE: &str = "saved_line";
/// The permission Saved Lists need (Collections' `requireAccess`, `accounts.view`).
const ACCOUNTS_VIEW: &str = "accounts.view";
/// The destination that is a new list (marketplace's `NEW_LIST_VALUE`).
pub const NEW_LIST: &str = "new";
/// A new list's title, at most (`savedListLimits.maximumTitleLength`, in UTF-16 units as the
/// API counts).
const TITLE_MAX: usize = 120;
/// A tracked quantity, at most (`savedListLimits.maximumTrackedQuantity`).
const QUANTITY_MAX: u32 = 1_000_000;

/// The form's own fields, for their names (the form is read as `Raw`, since it also posts the
/// page's address).
#[derive(Fields)]
#[allow(dead_code)]
pub struct SaveFields {
    product: String,
    list: String,
    title: String,
    quantity: String,
    add_command: String,
    line: String,
    new_list: String,
    new_list_command: String,
}

/// The names as text.
pub mod field {
    use super::SaveFields;
    pub const PRODUCT: &str = SaveFields::FIELDS.product.as_str();
    pub const LIST: &str = SaveFields::FIELDS.list.as_str();
    pub const TITLE: &str = SaveFields::FIELDS.title.as_str();
    pub const QUANTITY: &str = SaveFields::FIELDS.quantity.as_str();
    pub const ADD_COMMAND: &str = SaveFields::FIELDS.add_command.as_str();
    pub const LINE: &str = SaveFields::FIELDS.line.as_str();
    pub const NEW_LIST: &str = SaveFields::FIELDS.new_list.as_str();
    pub const NEW_LIST_COMMAND: &str = SaveFields::FIELDS.new_list_command.as_str();
}

/// The ids an addition is made with (`createSavedListAdditionTokens`), drawn with the form: the
/// addition's command and line, and the new list and its create command if it makes one.
#[derive(Clone, Debug)]
pub struct Tokens {
    pub add_command: String,
    pub line: String,
    pub new_list: String,
    pub new_list_command: String,
}

impl Tokens {
    pub fn new() -> Self {
        let id = |prefix: &str| format!("{prefix}_{}", ulid::Ulid::new());
        Tokens { add_command: id("slc"), line: id("sll"), new_list: id("svl"), new_list_command: id("slc") }
    }

    /// The ids a form posted, each with its prefix; `None` when one is missing or is not one.
    fn read(first: impl Fn(&str) -> String) -> Option<Self> {
        let id = |name: &str, prefix: &str| {
            let value = first(name);
            let rest = value.strip_prefix(prefix)?;
            (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(value)
        };
        Some(Tokens {
            add_command: id(field::ADD_COMMAND, "slc_")?,
            line: id(field::LINE, "sll_")?,
            new_list: id(field::NEW_LIST, "svl_")?,
            new_list_command: id(field::NEW_LIST_COMMAND, "slc_")?,
        })
    }
}

/// What a refused form had chosen and typed, and its ids, so it is drawn again with them (and a
/// second try is the same addition).
#[derive(Clone, Debug)]
pub struct SaveInput {
    pub list: String,
    pub title: String,
    pub quantity: String,
    pub tokens: Tokens,
}

/// What the page's Add to List can do for the viewer.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum SaveState {
    /// Not read: a page that answers another form leaves Add to List out.
    #[default]
    Unread,
    /// No one signed in: the button saves an intent and goes to registration.
    Guest,
    /// An account that cannot manage Saved Lists (no `accounts.view`).
    Forbidden,
    /// The recent lists' read failed.
    Failed,
    /// The account's recent lists, newest change first.
    Ready { lists: Vec<RecentSavedList> },
}

/// What Add Product did, after the redirect: the list, its title when the read has it, the
/// quantity added, whether it was merged into a line already there, and the collection's link.
#[derive(Clone, Debug)]
pub struct Saved {
    pub title: Option<String>,
    pub quantity: String,
    pub merged: bool,
    pub collection: String,
}

/// After Add Product (`list` the list it added to, empty for none): the viewer's Add to List, read
/// without the write's receipt, and again with it (`waited`) only when the list is not there yet,
/// a list the addition made that Discovery's picker has not caught up with. Waiting is up to
/// 2.5 s (the picker's freshness SLO, p95), so an addition to a list the picker has, the usual
/// one, is not kept waiting for counts it does not show; a wait that times out keeps the read
/// without it.
pub async fn state_after(session: Option<&Session>, caller: &Caller<'_>, waited: &Caller<'_>, list: &str) -> SaveState {
    let state = state(session, caller).await;
    let SaveState::Ready { lists } = &state else { return state };
    if list.is_empty() || lists.iter().any(|l| l.list_id == list) {
        return state;
    }
    match waited.recent_saved_lists().await {
        Ok(lists) => SaveState::Ready { lists },
        Err(error) => {
            tracing::warn!("the recent saved lists' read after Add Product failed: {error}");
            state
        }
    }
}

/// The viewer's Add to List: for an account that may, its recent lists, read by `caller`.
pub async fn state(session: Option<&Session>, caller: &Caller<'_>) -> SaveState {
    match session {
        Some(Session::Account(viewer)) if viewer.actor.can(ACCOUNTS_VIEW) => match caller.recent_saved_lists().await {
            Ok(lists) => SaveState::Ready { lists },
            Err(error) => {
                tracing::warn!("the recent saved lists' read failed: {error}");
                SaveState::Failed
            }
        },
        Some(Session::Account(_)) => SaveState::Forbidden,
        Some(Session::Unavailable) => SaveState::Failed,
        None => SaveState::Guest,
    }
}

/// The page's notice after Add Product, from its address: the list's title from `save`'s lists.
pub fn saved(first: impl Fn(&str) -> Option<String>, save: &SaveState) -> Option<Saved> {
    let receipt = first(SAVED)?;
    let list = first(SAVED_LIST).unwrap_or_default();
    let title = match save {
        SaveState::Ready { lists } => lists.iter().find(|l| l.list_id == list).map(|l| l.title.clone()),
        _ => None,
    };
    Some(Saved {
        title,
        quantity: first(SAVED_QUANTITY).filter(|q| quantity(q).is_some()).unwrap_or_else(|| "1".into()),
        merged: first(SAVED_LINE).as_deref() == Some("merged"),
        collection: collection_href(&list, &receipt),
    })
}

/// The list in the account's collection on marketplace, after the write whose receipt is
/// `receipt` (empty for none).
fn collection_href(list: &str, receipt: &str) -> String {
    let mut path = format!("/account/collection?section=lists&list={}", segment(list));
    if !receipt.is_empty() {
        path.push_str(&format!("&afterWrite={}", segment(receipt)));
    }
    views::marketplace(&path).map(|u| u.to_string()).unwrap_or(path)
}

/// A tracked quantity as the API takes one: a whole number from 1 to a million.
pub fn quantity(text: &str) -> Option<u32> {
    let text = text.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok().filter(|q| (1..=QUANTITY_MAX).contains(q))
}

/// A new list's title as the API takes one: trimmed, 1 to 120 UTF-16 units.
fn title(text: &str) -> Option<&str> {
    let title = text.trim();
    let units = title.encode_utf16().count();
    (1..=TITLE_MAX).contains(&units).then_some(title)
}

/// The product as Collections names it (`SavedListProductSelection`): exactly these keys.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Product<'a> {
    catalog_item_id: &'a str,
    product_id: &'a str,
    selected_options: &'a [Selected],
}

/// Where the product goes (`SavedListDestination`).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Destination<'a> {
    Existing {
        #[serde(rename = "listId")]
        list_id: &'a str,
    },
    New {
        #[serde(rename = "listId")]
        list_id: &'a str,
        #[serde(rename = "createCommandId")]
        create_command_id: &'a str,
        title: &'a str,
    },
}

/// `AddProductToSavedListRequest`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Addition<'a> {
    destination: Destination<'a>,
    add_command_id: &'a str,
    line_id: &'a str,
    product: Product<'a>,
    tracked_quantity: u32,
    source_surface: &'static str,
}

/// `CreateAnonymousSavedListIntentRequest`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IntentRequest<'a> {
    source_path: &'a str,
    source_surface: &'static str,
    product: Product<'a>,
    product_summary: &'a str,
}

/// The product's label in the dialog and the intent (`productLabel`): the item's title and the
/// product's summary.
pub fn product_label(screen: &ItemScreen) -> String {
    let mut label = screen.item.title.clone();
    if let Some(summary) = screen.product_summary.as_deref().filter(|s| !s.is_empty()) {
        label.push_str(" · ");
        label.push_str(summary);
    }
    label
}

/// Marketplace's registration, back to the item page as the guest saw it with the intent to
/// claim (`prepareSavedListAddition`'s `returnUrl`).
fn register_href(source: &str, intent: &str) -> String {
    let join = if source.contains('?') { '&' } else { '?' };
    let back = format!("{source}{join}claimSavedListIntent={}", segment(intent));
    let path = format!("/register?returnTo={}", segment(&back));
    views::marketplace(&path).map(|u| u.to_string()).unwrap_or(path)
}

/// The guest saved-list owner a request writes as, by the id the browser keeps or a new one
/// (`ensureAnonymousSavedListOwnerId`: `anon_` and a `cmd_` id).
fn guest_owner(headers: &HeaderMap) -> String {
    cookie::get(headers, ANONYMOUS_SAVED_LIST_COOKIE)
        .filter(|id| id.starts_with("anon_"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("anon_cmd_{}", ulid::Ulid::new()))
}

/// The page again, its Add to List dialog drawn open with why nothing was saved.
#[expect(
    clippy::too_many_arguments,
    reason = "a page's inputs and who is asking (the handler's `Caller`), which its layout shows"
)]
async fn refused(
    req: &Req,
    session: Option<&Session>,
    caller: &Caller<'_>,
    item: Item,
    address: &Address,
    input: SaveInput,
    message: String,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let notice = BuyNotice::SaveRefused { message, input };
    let reads = PageReads { save: state(session, caller).await, ..Default::default() };
    items::render(req, session, item, address, Some(&notice), status, reads, chrome.cart().await)
}

/// Add to List's Add Product, and a guest's Add to List.
pub(crate) async fn save(
    req: Req,
    chrome: Chrome,
    session: Option<corten::Caller<Session>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::items::ItemSave<'_>>,
    Form(raw): Form<Raw>,
) -> HtmlResult {
    let slug = route.slug;
    let session = session.as_deref();
    let t: ItemMsg = req.t();
    let p = Pilot::default();
    let first = |key: &str| raw.get(key).and_then(|v| v.all().first()).map(|v| v.trim().to_owned()).unwrap_or_default();
    let address = Address::read(&raw);
    let caller = config.platform.caller(&headers, config.proto, None);
    let item = match caller.item(&slug).await {
        Ok(Some(item)) => item,
        Ok(None) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(error) => return Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    };
    if matches!(session, Some(Session::Unavailable)) {
        return Err(corten::Error::status(StatusCode::BAD_GATEWAY));
    }
    let viewer = match session {
        Some(Session::Account(viewer)) => Some(viewer),
        _ => None,
    };
    let screen = ItemScreen::of(item.clone(), &address, viewer.map(|v| v.actor.account_id.clone()));
    let product_id = first(field::PRODUCT);
    let tokens = Tokens::read(first);
    let mut input = SaveInput {
        list: first(field::LIST),
        title: first(field::TITLE),
        quantity: first(field::QUANTITY),
        tokens: tokens.clone().unwrap_or_else(Tokens::new),
    };
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    if product_id.is_empty() || screen.product_id.as_deref() != Some(product_id.as_str()) {
        let message = t.saved_api_product_invalid().to_owned();
        return refused(&req, session, &caller, item, &address, input, message, unprocessable, &chrome).await;
    }
    let product =
        Product { catalog_item_id: &item.catalog_item_id, product_id: &product_id, selected_options: &screen.product_options };
    let Some(viewer) = viewer else {
        // No one signed in: the intent, then marketplace's registration, which claims it on the
        // way back to marketplace's item page.
        let source =
            url::Item { slug: item.slug.as_deref().unwrap_or(&slug), state: address.clone(), after: Default::default() }.href();
        let label = product_label(&screen);
        let intent = IntentRequest { source_path: &source, source_surface: "item-detail", product, product_summary: &label };
        let owner = guest_owner(&headers);
        let intent = match caller.saved_list_intent(&owner, &intent).await {
            Ok(intent) => intent,
            Err(error) => return refusal(&req, session, &caller, item, &address, input, error, &chrome).await,
        };
        let to: Uri = register_href(&source, &intent.intent_id).parse().map_err(corten::Error::new)?;
        let mut res = req.redirect(&to)?;
        let keep = cookie::SetCookie::new(ANONYMOUS_SAVED_LIST_COOKIE, &owner).max_age(GUEST_SECONDS);
        let keep = if config.proto == "https" { keep } else { keep.insecure() };
        res.headers_mut().append(header::SET_COOKIE, keep.header());
        return Ok(res);
    };
    if !viewer.actor.can(ACCOUNTS_VIEW) {
        let message = t.saved_api_account_forbidden().to_owned();
        return refused(&req, session, &caller, item, &address, input, message, StatusCode::FORBIDDEN, &chrome).await;
    }
    // A form without its ids is not one the page drew (or one from before the ids): drawn again
    // with new ones, nothing sent.
    if tokens.is_none() {
        return refused(&req, session, &caller, item, &address, input, p.check_attempt().to_owned(), unprocessable, &chrome)
            .await;
    }
    let Some(tracked) = quantity(&input.quantity) else {
        let message = p.item_saved_quantity_invalid().to_owned();
        return refused(&req, session, &caller, item, &address, input, message, unprocessable, &chrome).await;
    };
    let destination = if input.list == NEW_LIST {
        match title(&input.title) {
            Some(title) => {
                Destination::New { list_id: &input.tokens.new_list, create_command_id: &input.tokens.new_list_command, title }
            }
            None => {
                let message = p.item_saved_title_required().to_owned();
                return refused(&req, session, &caller, item, &address, input, message, unprocessable, &chrome).await;
            }
        }
    } else if input.list.is_empty() {
        let message = p.item_saved_choose_list().to_owned();
        return refused(&req, session, &caller, item, &address, input, message, unprocessable, &chrome).await;
    } else {
        Destination::Existing { list_id: &input.list }
    };
    let addition = Addition {
        destination,
        add_command_id: &input.tokens.add_command,
        line_id: &input.tokens.line,
        product,
        tracked_quantity: tracked,
        source_surface: "item-detail",
    };
    match caller.add_to_saved_list(&addition).await {
        Ok((added, receipt)) => {
            let receipt = receipt.map(|r| r.param()).unwrap_or_default();
            let slug = item.slug.as_deref().unwrap_or(&slug);
            req.redirect(&url::Item {
                slug,
                state: address,
                after: crate::items::After {
                    saved: Some(receipt),
                    saved_list: Some(added.list_id),
                    saved_quantity: Some(tracked.to_string()),
                    saved_line: Some(added.line_status),
                    ..Default::default()
                },
            })
        }
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => {
            match sign_in_at(&url::Item { slug: &slug, state: address, after: Default::default() }.href()) {
                Some(to) => req.redirect(&to),
                None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }
        Err(error) => {
            // A new list's title stays as typed; the ids stay, so trying again is the same addition.
            input.title = input.title.trim().to_owned();
            refusal(&req, session, &caller, item, &address, input, error, &chrome).await
        }
    }
}

/// A write the API refused shows its reason in the dialog; anything else is the API failing.
#[allow(clippy::too_many_arguments)]
async fn refusal(
    req: &Req,
    session: Option<&Session>,
    caller: &Caller<'_>,
    item: Item,
    address: &Address,
    input: SaveInput,
    error: ApiError,
    chrome: &Chrome,
) -> HtmlResult {
    match error.refusal() {
        Some(message) => {
            let message = message.to_owned();
            refused(req, session, caller, item, address, input, message, StatusCode::UNPROCESSABLE_ENTITY, chrome).await
        }
        None => Err(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quantity_is_a_whole_number_from_one_to_a_million_and_a_title_is_one_to_120_units() {
        assert_eq!(quantity("1"), Some(1));
        assert_eq!(quantity(" 25 "), Some(25));
        assert_eq!(quantity("1000000"), Some(1_000_000));
        assert_eq!(quantity("1000001"), None);
        assert_eq!(quantity("0"), None);
        assert_eq!(quantity("1.5"), None);
        assert_eq!(quantity("-1"), None);
        assert_eq!(quantity(""), None);
        assert_eq!(title("  Favorites "), Some("Favorites"));
        assert_eq!(title("   "), None);
        assert_eq!(title(&"a".repeat(120)).map(str::len), Some(120));
        assert_eq!(title(&"a".repeat(121)), None);
        // An emoji is two UTF-16 units, as the API counts a title.
        assert_eq!(title(&"\u{1F0CF}".repeat(61)), None);
    }

    #[test]
    fn a_form_s_ids_each_need_their_prefix() {
        let ids = Tokens::new();
        let posted = |name: &str| match name {
            field::ADD_COMMAND => ids.add_command.clone(),
            field::LINE => ids.line.clone(),
            field::NEW_LIST => ids.new_list.clone(),
            field::NEW_LIST_COMMAND => ids.new_list_command.clone(),
            _ => String::new(),
        };
        assert!(Tokens::read(posted).is_some());
        assert!(Tokens::read(|name: &str| if name == field::LINE { "slc_1".into() } else { posted(name) }).is_none());
        assert!(Tokens::read(|name: &str| if name == field::NEW_LIST { "svl_".into() } else { posted(name) }).is_none());
    }
}
