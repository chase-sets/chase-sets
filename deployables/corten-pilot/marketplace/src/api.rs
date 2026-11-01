//! The storage-location and restock-decision calls, as the signed-in seller, the cart read, as
//! the signed-in buyer, and the item page's read, as anyone (the shared caller is `platform::api`).
//! Types hold only the fields the screen reads; they are also the screen's JSON for data clients.
use std::collections::BTreeMap;

use corten::axum::http::StatusCode;
use serde::{Deserialize, Serialize};

pub use platform::api::{ApiError, Caller, Identity, Method, Platform, segment};
use platform::receipt::Receipt;

const INVENTORY: &str = "inventory";
const CHECKOUT: &str = "checkout";
const CART: &str = "/api/marketplace/account/cart";
const LOCATIONS: &str = "/api/inventory/storage-locations";
const RESTOCK: &str = "/api/inventory/restock-decisions";
const ATTEMPTS: &str = "/api/inventory/mutation-attempts";
/// The header that names a write's attempt (`Inventory-Mutation-Attempt`): the API applies an
/// attempt once and answers a repeat with the first result.
const ATTEMPT_HEADER: &str = "inventory-mutation-attempt";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LocationList {
    pub items: Vec<Location>,
}

/// `InventoryStorageLocation` (features/storage-locations/ui/contracts.ts), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Location {
    pub storage_location_id: String,
    pub name: String,
    pub description: Option<String>,
    pub ship_from_code: String,
    pub ship_from_address: Address,
    pub is_archived: bool,
}

/// A ship-from address (`AddressSnapshot`), exactly the fields a write may send: the Inventory
/// API refuses any other key.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub name: String,
    pub company: Option<String>,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub phone: Option<String>,
    pub email: Option<String>,
}

/// A create, an update or an archive: what marketplace's route action sends.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationCommand {
    pub name: String,
    pub description: Option<String>,
    pub ship_from_code: String,
    pub ship_from_address: Address,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_archived: Option<bool>,
}

/// A page of pending restock decisions (`ListResponse`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DecisionList {
    pub items: Vec<Decision>,
    #[serde(default)]
    pub total: u64,
}

/// `InventoryRestockDecision` (features/restock-decisions/api/contracts.ts), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Decision {
    pub decision_id: String,
    pub version: u64,
    pub order_id: String,
    pub item_id: String,
    pub item_title: Option<String>,
    pub item_subtitle: Option<String>,
    pub quantity: u64,
    /// `order-cancelled-after-dispatch` or `shipment-returned` (another is shown as it is).
    pub source: String,
    pub return_reason: Option<String>,
    pub pending_at: String,
}

/// What a restock decision records (`RecordRestockDecisionInput`), as marketplace's action sends
/// it: a restock has no damage note; a write-off's is trimmed, or `null`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCommand {
    pub expected_version: u64,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage_note: Option<Option<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Restocked,
    WrittenOff,
}

/// What `GET /api/inventory/mutation-attempts/{id}` keeps of an applied attempt, the fields the
/// check compares.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptResult {
    pub version: u32,
    pub family: String,
    pub target_id: String,
}

/// A write the API accepted: the receipt the next read waits for.
pub struct Written {
    pub receipt: Option<Receipt>,
}

#[derive(Deserialize)]
struct Accepted {}

/// The screen's calls. A trait because the caller is the shared crate's.
pub trait Inventory {
    async fn locations(&self) -> Result<LocationList, ApiError>;
    async fn create_location(&self, attempt: &str, body: &LocationCommand) -> Result<Written, ApiError>;
    async fn update_location(&self, attempt: &str, id: &str, body: &LocationCommand) -> Result<Written, ApiError>;
    /// The first 100 pending decisions, as marketplace's loader reads them.
    async fn restock_decisions(&self) -> Result<DecisionList, ApiError>;
    async fn record_decision(&self, attempt: &str, id: &str, body: &DecisionCommand) -> Result<Written, ApiError>;
    /// The attempt's result, or `None` when the API holds none (it was never applied, or it is
    /// someone else's).
    async fn attempt(&self, id: &str) -> Result<Option<AttemptResult>, ApiError>;
}

async fn send(
    caller: &Caller<'_>,
    method: Method,
    path: &str,
    attempt: &str,
    body: &impl Serialize,
) -> Result<Written, ApiError> {
    let req = caller.request(method, path, INVENTORY).header(ATTEMPT_HEADER, attempt).json(body);
    let (_, receipt): (Accepted, _) = caller.write(req).await?;
    Ok(Written { receipt })
}

impl Inventory for Caller<'_> {
    async fn locations(&self) -> Result<LocationList, ApiError> {
        self.read(&format!("{LOCATIONS}?includeArchived=true"), INVENTORY).await
    }

    async fn create_location(&self, attempt: &str, body: &LocationCommand) -> Result<Written, ApiError> {
        send(self, Method::POST, LOCATIONS, attempt, body).await
    }

    async fn update_location(&self, attempt: &str, id: &str, body: &LocationCommand) -> Result<Written, ApiError> {
        send(self, Method::PATCH, &format!("{LOCATIONS}/{}", segment(id)), attempt, body).await
    }

    async fn restock_decisions(&self) -> Result<DecisionList, ApiError> {
        self.read(&format!("{RESTOCK}?limit=100&offset=0"), INVENTORY).await
    }

    async fn record_decision(&self, attempt: &str, id: &str, body: &DecisionCommand) -> Result<Written, ApiError> {
        send(self, Method::POST, &format!("{RESTOCK}/{}/decision", segment(id)), attempt, body).await
    }

    async fn attempt(&self, id: &str) -> Result<Option<AttemptResult>, ApiError> {
        match self.read(&format!("{ATTEMPTS}/{}", segment(id)), INVENTORY).await {
            Ok(result) => Ok(Some(result)),
            Err(error) if error.status().is_some_and(|s| s.as_u16() == 404) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// An inventory item as the list reads it (`InventoryItemListItem`), the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InventoryItem {
    pub item_id: String,
    pub catalog_catalog_item_id: String,
    #[serde(default)]
    pub item_title: Option<String>,
    #[serde(default)]
    pub item_subtitle: Option<String>,
    #[serde(default)]
    pub language_code: Option<String>,
    #[serde(default)]
    pub product_summary: Option<String>,
    pub storage_location_name: String,
    pub total_quantity: i64,
    pub held_quantity: i64,
    pub available_quantity: i64,
    #[serde(default)]
    pub acquisition_cost_amount: Option<String>,
    #[serde(default)]
    pub acquisition_cost_currency_code: Option<String>,
}

/// A page of the account's inventory items (`GET /api/inventory/items?limit=&offset=`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct InventoryItems {
    pub items: Vec<InventoryItem>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

/// What Create inventory item sends (`InventoryCreateItemRequest`), the fields its form has.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCommand {
    pub catalog_item_id: String,
    pub selected_options: Vec<Selected>,
    pub storage_location_id: String,
    pub total_quantity: u64,
    pub acquisition_cost_amount: Option<String>,
    pub acquisition_cost_currency_code: Option<String>,
    /// A graded card's details, only for a graded product (`InventoryGradedCardDetails`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graded_card: Option<GradedCard>,
}

/// `InventoryGradedCardDetails` as marketplace's Create inventory item sends it: no population
/// and no condition descriptors.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradedCard {
    pub grading_company: String,
    pub grade: String,
    pub certification_number: Option<String>,
    pub population: Option<()>,
    pub condition_descriptors: [(); 0],
}

#[derive(Deserialize)]
struct CreatedItem {
    id: String,
}

/// An offline sale (`InventoryOfflineSaleRequest`): the API refuses any other key.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleCommand {
    pub quantity: u64,
    pub sale_price_amount: Option<String>,
    pub channel: String,
    pub note: Option<String>,
    pub collision_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_seller_cannot_fulfill: Option<bool>,
    pub idempotency_key: String,
}

/// What an offline sale did (`InventoryOfflineSaleResult`), the fields the page says.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleResult {
    pub item_id: String,
    pub requested_quantity: u64,
    pub applied_quantity: u64,
    pub refused_quantity: u64,
    #[serde(default)]
    pub collision: Option<Collision>,
}

/// The orders an honored offline sale took stock from (`InventoryHoldCollisionPlan`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    #[serde(default)]
    pub affected_orders: Vec<AffectedOrder>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedOrder {
    pub order_id: String,
}

/// An inventory item as its page reads it (`InventoryItemDetail`): the list's fields, where it
/// ships from, its holds and its stock ledger, newest first.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InventoryItemDetail {
    #[serde(flatten)]
    pub item: InventoryItem,
    #[serde(default)]
    pub ship_from_code: String,
    #[serde(default)]
    pub holds: Vec<Hold>,
    #[serde(default)]
    pub ledger: Vec<LedgerEntry>,
}

/// A hold on an item's stock (`InventoryHold`), the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Hold {
    pub hold_id: String,
    pub quantity: i64,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub purpose: String,
    /// The order or checkout the hold is for (`InventoryHoldSourceRef`), when it is one.
    #[serde(default)]
    pub source_ref: Option<serde_json::Value>,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub status: String,
    pub created_at: String,
}

/// A movement of an item's stock (`InventoryItemLedgerEntry`), the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LedgerEntry {
    pub ledger_entry_id: String,
    pub occurred_at: String,
    pub kind: String,
    #[serde(default)]
    pub quantity_delta: Option<i64>,
    #[serde(default)]
    pub hold_quantity: Option<i64>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub source_ref: Option<serde_json::Value>,
    #[serde(default)]
    pub actor: String,
}

/// The order a hold or a movement is for (`orderSourceRef`).
pub fn source_order(source: Option<&serde_json::Value>) -> Option<&str> {
    source?.get("orderId")?.as_str()
}

/// What Adjust Quantity sends (`InventoryAdjustItemRequest`), the fields its form has.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustCommand {
    pub quantity_delta: i64,
    pub reason: String,
    pub reason_code: String,
    pub note: Option<String>,
}

/// What an adjustment did: `adjusted`, or `hold-collision-recorded` with the API's words for it.
#[derive(Clone, Debug, Deserialize)]
pub struct Adjusted {
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

/// What Create Hold sends: a manual hold.
#[derive(Clone, Debug, Serialize)]
pub struct HoldCommand {
    pub quantity: u64,
    pub reason: String,
    pub notes: Option<String>,
}

/// The inventory item page's calls.
pub trait InventoryItemCalls {
    async fn inventory_item_detail(&self, id: &str) -> Result<InventoryItemDetail, ApiError>;
    async fn adjust_item(&self, attempt: &str, id: &str, body: &AdjustCommand) -> Result<(Adjusted, Option<Receipt>), ApiError>;
    async fn create_hold(&self, attempt: &str, id: &str, body: &HoldCommand) -> Result<Written, ApiError>;
    async fn release_hold(&self, attempt: &str, hold: &str) -> Result<Written, ApiError>;
}

impl InventoryItemCalls for Caller<'_> {
    async fn inventory_item_detail(&self, id: &str) -> Result<InventoryItemDetail, ApiError> {
        self.read(&format!("/api/inventory/items/{}", segment(id)), INVENTORY).await
    }

    async fn adjust_item(&self, attempt: &str, id: &str, body: &AdjustCommand) -> Result<(Adjusted, Option<Receipt>), ApiError> {
        let path = format!("/api/inventory/items/{}/adjustments", segment(id));
        self.write(self.request(Method::POST, &path, INVENTORY).header(ATTEMPT_HEADER, attempt).json(body)).await
    }

    async fn create_hold(&self, attempt: &str, id: &str, body: &HoldCommand) -> Result<Written, ApiError> {
        send(self, Method::POST, &format!("/api/inventory/items/{}/holds", segment(id)), attempt, body).await
    }

    async fn release_hold(&self, attempt: &str, hold: &str) -> Result<Written, ApiError> {
        send(self, Method::POST, &format!("/api/inventory/holds/{}/release", segment(hold)), attempt, &serde_json::json!({}))
            .await
    }
}

/// The inventory list's calls.
pub trait InventoryList {
    async fn inventory_items(&self, limit: u64, offset: u64) -> Result<InventoryItems, ApiError>;
    async fn inventory_item(&self, id: &str) -> Result<InventoryItem, ApiError>;
    /// The new item's id and the write's receipt.
    async fn create_item(&self, attempt: &str, body: &ItemCommand) -> Result<(String, Option<Receipt>), ApiError>;
    async fn offline_sale(&self, id: &str, body: &SaleCommand) -> Result<(SaleResult, Option<Receipt>), ApiError>;
}

impl InventoryList for Caller<'_> {
    async fn inventory_items(&self, limit: u64, offset: u64) -> Result<InventoryItems, ApiError> {
        self.read(&format!("/api/inventory/items?limit={limit}&offset={offset}"), INVENTORY).await
    }

    async fn inventory_item(&self, id: &str) -> Result<InventoryItem, ApiError> {
        self.read(&format!("/api/inventory/items/{}", segment(id)), INVENTORY).await
    }

    async fn create_item(&self, attempt: &str, body: &ItemCommand) -> Result<(String, Option<Receipt>), ApiError> {
        let req = self.request(Method::POST, "/api/inventory/items", INVENTORY).header(ATTEMPT_HEADER, attempt).json(body);
        let (created, receipt): (CreatedItem, _) = self.write(req).await?;
        Ok((created.id, receipt))
    }

    async fn offline_sale(&self, id: &str, body: &SaleCommand) -> Result<(SaleResult, Option<Receipt>), ApiError> {
        let path = format!("/api/inventory/items/{}/offline-sales", segment(id));
        self.write(self.request(Method::POST, &path, INVENTORY).json(body)).await
    }
}

/// The account's cart (`GET /api/marketplace/account/cart`): its lines and the readiness the
/// Checkout API computed for them.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Cart {
    pub items: Vec<CartLine>,
    pub count: u64,
    pub readiness: Option<Readiness>,
}

/// `CheckoutCartLine` (features/cart/ui/contracts.ts), the fields the page reads.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CartLine {
    pub line_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    pub item_language_code: Option<String>,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub item_image_url: Option<String>,
    pub item_image_srcset: Option<String>,
    pub product_summary: Option<String>,
    pub quantity: u32,
    /// `optimize` or `locked-listing`.
    pub fulfillment_mode: String,
    pub locked_listing_id: Option<String>,
    pub selected_listing_id: Option<String>,
    pub selected_listing_seller_display_name: Option<String>,
    pub selected_listing_price_amount: Option<String>,
    #[serde(default)]
    pub selected_listing_price_currency_code: Option<String>,
    #[serde(default)]
    pub selected_listing_stream_version: Option<u64>,
    pub seller_preference_id: Option<String>,
    pub seller_options: Vec<SellerOption>,
    pub updated_at: String,
}

/// A listing that can fill a cart line.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SellerOption {
    pub listing_id: String,
    pub seller_display_name: Option<String>,
    #[serde(default)]
    pub seller_average_rating: Option<String>,
    #[serde(default)]
    pub seller_review_count: Option<u64>,
    pub price_amount: String,
    #[serde(default)]
    pub price_currency_code: Option<String>,
    #[serde(default)]
    pub listing_stream_version: Option<u64>,
    pub available_quantity: u64,
}

/// `CartReadinessRead` (features/cart/domain/readiness.ts): the cart as loaded, with the
/// optimization declined and accepted, and the totals the API computed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub loaded: Snapshot,
    pub declined: Snapshot,
    pub accepted: Option<Snapshot>,
    /// The listing chosen for each line, which prices it.
    #[serde(default)]
    pub line_listing_ids: std::collections::BTreeMap<String, Option<String>>,
    pub estimated_subtotal: Option<Money>,
    pub blocked_line_count: u64,
    pub savings: Option<Money>,
}

/// `CartReadinessSnapshot`, the fields the page reads or sends back to checkout.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub snapshot_id: String,
    pub source_revision: String,
    /// `ready` or not.
    pub status: String,
    pub line_outcomes: Vec<LineOutcome>,
    pub optimization: Optimization,
    #[serde(default)]
    pub line_count: u64,
    /// What the buyer may be told about a cart that is not ready.
    #[serde(default)]
    pub customer_safe_facts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOutcome {
    pub line_id: String,
    /// `ready`, `unassigned-fulfillment`, `unavailable`, `waiting-for-supply`, `changed`,
    /// `shipping-measure-missing` or `currency-mismatch`.
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Optimization {
    pub available: bool,
    /// `none`, `declined` or `accepted`.
    pub decision: String,
    pub proposed_line_id: Option<String>,
    pub proposed_listing_id: Option<String>,
}

/// A decimal amount and its currency, as the API sends money.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Money {
    pub amount: String,
    pub currency: String,
}

/// The decisions a readiness snapshot is computed with (`CartReadinessDecisionInput`): the
/// lower-price offer accepted or declined, for its line and listing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Decisions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimization: Option<OptimizationDecision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationDecision {
    /// `accepted` or `declined`.
    pub decision: &'static str,
    pub line_id: String,
    pub listing_id: String,
}

/// A checkout session the Checkout API started (`POST /account/checkout-sessions`).
#[derive(Clone, Debug, Deserialize)]
pub struct Started {
    pub session_id: String,
}

#[derive(Deserialize)]
struct ReadinessBody {
    readiness: Snapshot,
}

/// One of the cart page's commands (`CheckoutCartLineCommandInput`): a line's quantity, its
/// removal, or locking it to its preferred listing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum CartCommand {
    Quantity {
        line_id: String,
        quantity: u32,
    },
    Remove {
        line_id: String,
    },
    Fulfillment {
        line_id: String,
        /// `locked-listing`.
        fulfillment_mode: &'static str,
        locked_listing_id: String,
        seller_preference_id: String,
        /// `available`.
        availability_state: &'static str,
    },
}

/// What the Checkout API keeps of a cart attempt (`CheckoutCommandAttemptResult`), the fields
/// the page reads: whether it was committed, each command's outcome, and the commit.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartAttempt {
    /// `not-observed`, `committed`, `conflict`, `failed-safe` or `ambiguous`.
    pub owner_status: String,
    #[serde(default)]
    pub vector: Vec<CommandOutcome>,
    pub commit_receipt: Option<CommitReceipt>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    /// `succeeded`, `conflict` or `error`.
    pub outcome: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReceipt {
    pub event_id: String,
    pub global_position: String,
}

/// The API's answer to a cart attempt: its attempt (if it sent one), its message (a refusal's),
/// and the write's receipt; or none at all, when the answer may have been lost (no answer, 408,
/// or a 5xx: `isPossibleSendLoss`).
#[derive(Debug)]
pub enum CartAnswer {
    Answered { status: StatusCode, attempt: Option<CartAttempt>, message: Option<String>, receipt: Option<Receipt> },
    Lost,
}

#[derive(Deserialize)]
struct AttemptBody {
    attempt: Option<serde_json::Value>,
    error: Option<ErrorMessage>,
}

#[derive(Deserialize)]
struct ErrorMessage {
    message: Option<String>,
}

const CART_ATTEMPT_TARGET: &str = "cart";

/// One cart write the Checkout API keeps as a command attempt (`submitCheckoutCartAttempt`): the
/// cart's line commands, or an item page's new line, for the account's cart or a guest's. `body`
/// is what is sent less the attempt id, which the lookup names by its hash.
#[derive(Clone, Debug)]
pub struct CartWrite {
    /// After the cart's path: `/commands`, or nothing for a new line.
    path: &'static str,
    /// `CheckoutCommandAttemptKind`.
    kind: &'static str,
    pub body: serde_json::Value,
    /// A guest cart (`anon_...`), written through the guest routes.
    guest: Option<String>,
}

impl CartWrite {
    /// The cart page's commands, applied all or nothing per command (`POST /account/cart/commands`).
    pub fn commands(commands: &[CartCommand]) -> Self {
        CartWrite { path: "/commands", kind: "cart.commands", body: serde_json::json!({ "commands": commands }), guest: None }
    }

    /// A new line (`POST /account/cart`, or `/guest/cart` for a guest cart).
    pub fn add_line(line: &impl Serialize, guest: Option<String>) -> Self {
        let body = serde_json::to_value(line).unwrap_or_default();
        CartWrite { path: "", kind: "cart.add-line", body, guest }
    }

    /// The same write to the guest cart `guest` (`/guest/cart/commands`), or the account's.
    pub fn for_guest(self, guest: Option<String>) -> Self {
        CartWrite { guest, ..self }
    }

    fn owner(&self) -> &'static str {
        if self.guest.is_some() { "/api/marketplace/guest" } else { "/api/marketplace/account" }
    }
}

/// The guest cart a browser presents (`x-checkout-anonymous-cart-id`).
const ANONYMOUS_CART_HEADER: &str = "x-checkout-anonymous-cart-id";

/// The guest sell list a browser presents (`x-checkout-anonymous-sell-list-id`).
const ANONYMOUS_SELL_LIST_HEADER: &str = "x-checkout-anonymous-sell-list-id";

/// The sell list's calls (`/account/sell-list`, `/guest/sell-list` for a guest's). `guest` is
/// the guest sell list a browser presents; `None` is the account's.
pub trait SellList {
    /// Adds a line (`AddCheckoutSellListLineRequest`) to the account's sell list, or to the guest
    /// sell list `guest`. The API takes no attempt id: a product line sent again adds its
    /// quantity again (chase-sets/chase-sets#9995). The answer is the write's receipt.
    async fn add_sell_list_line(&self, line: &impl Serialize, guest: Option<&str>) -> Result<Option<Receipt>, ApiError>;
    /// The sell list's lines, their quantity and (the account's) latest seller confirmation.
    async fn sell_list(&self, guest: Option<&str>) -> Result<SellListRead, ApiError>;
    /// The account's offer and Smart Match reviews and the inventory a fallback listing ships
    /// from (`getSellListCompositeReview`), with the standard terms beside the final ones when
    /// `standard` (back from registration).
    async fn sell_list_review(&self, standard: bool) -> Result<CompositeReview, ApiError>;
    /// A guest sell list's offer reviews (the public standard terms).
    async fn guest_offer_reviews(&self, guest: &str) -> Result<Vec<OfferReview>, ApiError>;
    /// Whether the account's payouts are set up (`getSellListPayoutReadiness`).
    async fn sell_payout_readiness(&self) -> Result<SellPayoutReadiness, ApiError>;
    /// The sell list's readiness with the seller's `decisions`, as a snapshot seller checkout starts
    /// from, and the write's receipt.
    async fn sell_list_readiness(
        &self,
        decisions: &ReadinessDecisions,
        guest: Option<&str>,
    ) -> Result<(SellListSnapshot, Option<Receipt>), ApiError>;
    /// The account's readiness with the seller's `decisions` and the seller confirmation evidence
    /// seller checkout sends before its handoff.
    async fn seller_readiness(
        &self,
        decisions: &ReadinessDecisions,
        evidence: &SellerEvidence,
    ) -> Result<SellListSnapshot, ApiError>;
    /// A seller confirmation (`GET /sell-list/confirmations/{id}`); 404 while it is not saved.
    async fn sell_list_confirmation(&self, id: &str) -> Result<SellListConfirmation, ApiError>;
    /// Confirms seller checkout (`POST /sell-list/confirm`): the write's receipt.
    async fn confirm_sell_list(&self, body: &serde_json::Value) -> Result<Option<Receipt>, ApiError>;
    async fn remove_sell_list_line(&self, line: &str, guest: Option<&str>) -> Result<Option<Receipt>, ApiError>;
    /// Moves the guest sell list's lines into the account's: how many moved, and the receipt.
    async fn merge_guest_sell_list(&self, guest: &str) -> Result<(u64, Option<Receipt>), ApiError>;
}

fn sell_list_path(guest: Option<&str>, rest: &str) -> String {
    let owner = if guest.is_some() { "guest" } else { "account" };
    format!("/api/marketplace/{owner}/sell-list{rest}")
}

/// A request to the sell list `guest` (or the account's), naming the guest's in its header.
fn sell_list_request(caller: &Caller<'_>, method: Method, guest: Option<&str>, rest: &str) -> reqwest::RequestBuilder {
    let req = caller.request(method, &sell_list_path(guest, rest), CHECKOUT);
    match guest {
        Some(id) => req.header(ANONYMOUS_SELL_LIST_HEADER, id),
        None => req,
    }
}

impl SellList for Caller<'_> {
    async fn add_sell_list_line(&self, line: &impl Serialize, guest: Option<&str>) -> Result<Option<Receipt>, ApiError> {
        let req = sell_list_request(self, Method::POST, guest, "").json(line);
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn sell_list(&self, guest: Option<&str>) -> Result<SellListRead, ApiError> {
        // A read, sent as `write` sends a request (its answer checked, then its JSON).
        Ok(self.write(sell_list_request(self, Method::GET, guest, "")).await?.0)
    }

    async fn sell_list_review(&self, standard: bool) -> Result<CompositeReview, ApiError> {
        let rest = if standard { "/composite-review?includeStandardComparison=true" } else { "/composite-review" };
        self.read(&sell_list_path(None, rest), CHECKOUT).await
    }

    async fn guest_offer_reviews(&self, guest: &str) -> Result<Vec<OfferReview>, ApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Body {
            #[serde(default)]
            offer_reviews: Vec<OfferReview>,
        }
        let (body, _): (Body, _) = self.write(sell_list_request(self, Method::GET, Some(guest), "/offer-reviews")).await?;
        Ok(body.offer_reviews)
    }

    async fn sell_payout_readiness(&self) -> Result<SellPayoutReadiness, ApiError> {
        self.read(&sell_list_path(None, "/payout-readiness"), CHECKOUT).await
    }

    async fn sell_list_readiness(
        &self,
        decisions: &ReadinessDecisions,
        guest: Option<&str>,
    ) -> Result<(SellListSnapshot, Option<Receipt>), ApiError> {
        #[derive(Deserialize)]
        struct Body {
            readiness: SellListSnapshot,
        }
        let req = sell_list_request(self, Method::POST, guest, "/readiness").json(decisions);
        let (body, receipt): (Body, _) = self.write(req).await?;
        Ok((body.readiness, receipt))
    }

    async fn seller_readiness(
        &self,
        decisions: &ReadinessDecisions,
        evidence: &SellerEvidence,
    ) -> Result<SellListSnapshot, ApiError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Sent<'a> {
            #[serde(flatten)]
            decisions: &'a ReadinessDecisions,
            seller_evidence: &'a SellerEvidence,
        }
        #[derive(Deserialize)]
        struct Body {
            readiness: SellListSnapshot,
        }
        let req = sell_list_request(self, Method::POST, None, "/readiness").json(&Sent { decisions, seller_evidence: evidence });
        Ok(self.write::<Body>(req).await?.0.readiness)
    }

    async fn sell_list_confirmation(&self, id: &str) -> Result<SellListConfirmation, ApiError> {
        self.read(&sell_list_path(None, &format!("/confirmations/{}", segment(id))), CHECKOUT).await
    }

    async fn confirm_sell_list(&self, body: &serde_json::Value) -> Result<Option<Receipt>, ApiError> {
        let req = sell_list_request(self, Method::POST, None, "/confirm").json(body);
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn remove_sell_list_line(&self, line: &str, guest: Option<&str>) -> Result<Option<Receipt>, ApiError> {
        let req =
            sell_list_request(self, Method::POST, guest, &format!("/{}/remove", segment(line))).json(&serde_json::json!({}));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn merge_guest_sell_list(&self, guest: &str) -> Result<(u64, Option<Receipt>), ApiError> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Body {
            merged_line_count: u64,
        }
        let req = self
            .request(Method::POST, "/api/marketplace/guest/sell-list/merge-to-account", CHECKOUT)
            .header(ANONYMOUS_SELL_LIST_HEADER, guest)
            .json(&serde_json::json!({}));
        let (body, receipt): (Body, _) = self.write(req).await?;
        Ok((body.merged_line_count, receipt))
    }
}

/// A sell list as Checkout reads it (`GET /sell-list`): its lines, their quantity and the account's
/// latest seller confirmation.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SellListRead {
    pub items: Vec<SellListRow>,
    pub count: u64,
    pub latest_confirmation: Option<SellListConfirmation>,
}

/// A sell list line (`CheckoutSellListLineRow`): a selected offer, or a product the seller has.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SellListRow {
    pub line_id: String,
    /// `selected-offer` or `product`.
    pub line_type: String,
    pub offer_id: Option<String>,
    pub listing_id: Option<String>,
    pub buyer_account_id: Option<String>,
    pub buyer_display_name: Option<String>,
    pub offer_price_amount: Option<String>,
    pub offer_price_currency_code: Option<String>,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub quantity: u64,
    /// `none` or `create-listing`.
    pub fallback_mode: String,
    pub minimum_listing_price_amount: Option<String>,
    pub updated_at: String,
}

impl SellListRow {
    pub fn is_offer(&self) -> bool {
        self.line_type == "selected-offer"
    }
}

/// The account's latest seller confirmation (`CheckoutSellListConfirmationRow`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SellListConfirmation {
    pub confirmation_id: String,
    pub confirmed_at: String,
    pub handoff_summary: HandoffSummary,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HandoffSummary {
    pub accepted_offer_count: u64,
    pub published_listing_count: u64,
    pub skipped_line_count: u64,
    pub line_outcomes: Vec<ConfirmedLine>,
    /// `sale`, `accountHistory`, `label`, `payout`, `settlement`, `notification`: each one's status.
    pub side_effects: std::collections::HashMap<String, String>,
}

/// What seller checkout did with one line.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfirmedLine {
    pub line_id: String,
    pub item_title: String,
    /// `completed`, `partial` or `skipped`.
    pub status: String,
    pub action: String,
    pub quantity: u64,
    pub remaining_quantity: u64,
    pub detail: String,
    pub references: Option<serde_json::Value>,
}

/// The terms a sale at an offer would be priced with (`CheckoutSellListTermsPreview`, or the
/// public standard terms' `CheckoutSellListPublicStandardTermsPreview` for a guest).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SellTerms {
    pub basis_amount: String,
    pub marketplace_sales_fee_unit_amount: String,
    pub seller_net_unit_amount: String,
    pub shipping_allowance_percentage_bps: Option<i64>,
    pub fee_quote_fingerprint: Option<String>,
    pub resolved_at: Option<String>,
    /// `public-standard-seller-terms` for the standard terms.
    pub source_kind: Option<String>,
    pub source_label: Option<String>,
    pub agreement_id: Option<String>,
}

impl SellTerms {
    pub fn standard(&self) -> bool {
        self.source_kind.as_deref() == Some("public-standard-seller-terms")
    }
}

/// A selected offer's review (`CheckoutSellListOfferReview`). `evidence` is absent when the review
/// does not look at evidence, `Some(None)` when it could not be read.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OfferReview {
    pub line_id: String,
    /// `ready` or `unavailable`.
    pub status: String,
    pub terms: Option<SellTerms>,
    pub comparison: Option<TermsComparison>,
    pub message: Option<String>,
    #[serde(deserialize_with = "present")]
    pub evidence: Option<Option<ListingEvidence>>,
}

/// The standard terms beside the final ones, after registration.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TermsComparison {
    /// `same`, `changed`, `standard-preview-unavailable` or `final-unavailable`.
    pub status: String,
    pub standard_preview: Option<SellTerms>,
    pub changed_fields: Vec<String>,
}

/// A product line's Smart Match offers (`CheckoutSellListProductOfferReview`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProductOfferReview {
    pub line_id: String,
    pub status: String,
    pub offers: Vec<ProductOffer>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ProductOffer {
    pub offer: OfferMatch,
    pub terms: SellTerms,
    #[serde(deserialize_with = "present")]
    pub evidence: Option<Option<ListingEvidence>>,
}

/// Inventory a fallback listing can ship from (`CheckoutSellListInventoryItemOption`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct InventoryOption {
    pub item_id: String,
    pub product_id: String,
    pub storage_location_name: String,
    pub ship_from_code: String,
    pub available_quantity: u64,
}

/// `CheckoutSellListCompositeReview`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompositeReview {
    pub offer_reviews: Vec<OfferReview>,
    pub product_offer_reviews: Vec<ProductOfferReview>,
    pub inventory_items: Vec<InventoryOption>,
}

/// `CheckoutSellPayoutReadinessRow`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SellPayoutReadiness {
    /// `not-started`, `pending`, `ready` or `restricted`.
    pub status: String,
    pub missing_requirements: Vec<String>,
}

/// A listing's evidence as the sell list reviews it (`MarketplaceListingEvidenceCoverage`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingEvidence {
    pub listing_id: String,
    #[serde(default)]
    pub evidence: Vec<EvidencePhoto>,
    pub requirements: Requirements,
    pub coverage: Coverage,
}

/// A listing's photo with its renditions (`MarketplaceListingPhoto`), the fields the review shows.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EvidencePhoto {
    pub photo_id: String,
    pub status: String,
    pub view_kind: Option<String>,
    pub alt_text: Option<String>,
    pub asset_set: Option<PhotoAssets>,
}

impl EvidencePhoto {
    /// Its thumbnail, else its source.
    pub fn thumbnail(&self) -> Option<&str> {
        let set = self.asset_set.as_ref()?;
        set.variants
            .iter()
            .find(|a| a.role.as_deref() == Some("thumbnail"))
            .or(set.source.as_ref())
            .map(|a| a.public_url.as_str())
            .filter(|url| !url.is_empty())
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PhotoAssets {
    pub source: Option<PhotoAsset>,
    pub variants: Vec<PhotoAsset>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhotoAsset {
    pub role: Option<String>,
    pub public_url: String,
}

/// A field that may be absent, `null` or a value: absent is `None`, `null` is `Some(None)`.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// What the seller decided for each line before seller checkout (`SellListReadinessDecisionInput`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessDecisions {
    pub line_actions: Vec<LineAction>,
    pub line_outcomes: Vec<LineKept>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineAction {
    pub line_id: String,
    /// `selected-offer`, `smart-match` or `fallback-listing`.
    pub action: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineKept {
    pub line_id: String,
    /// `keep-in-list`.
    pub outcome: &'static str,
}

/// The readiness snapshot seller checkout starts from (`SellListReadinessSnapshot`), the fields
/// the pages read.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SellListSnapshot {
    pub snapshot_id: String,
    pub source_revision: String,
    /// `ready`, `needs-resolution` or `blocked`.
    pub status: String,
    pub unresolved_line_ids: Vec<String>,
    /// The lines seller checkout takes.
    pub included_line_ids: Vec<String>,
    pub line_outcomes: Vec<SnapshotLine>,
    pub seller_readiness: SnapshotSeller,
}

impl SellListSnapshot {
    /// Ready, nothing unresolved, and at least one line to check out.
    pub fn ready(&self) -> bool {
        self.status == "ready" && self.unresolved_line_ids.is_empty() && !self.included_line_ids.is_empty()
    }

    /// The sale action readiness decided for an included line.
    pub fn action(&self, line: &str) -> Option<&str> {
        if !self.included_line_ids.iter().any(|id| id == line) {
            return None;
        }
        self.line_outcomes.iter().filter(|o| o.line_id == line).find_map(|o| o.action.as_deref())
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapshotLine {
    pub line_id: String,
    /// `checkout`, `keep-in-list` or `removed`.
    pub outcome: String,
    /// `selected-offer`, `smart-match` or `fallback-listing`.
    pub action: Option<String>,
}

/// The seller's readiness in a snapshot; the page reads only whether it is ready.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SnapshotSeller {
    pub status: String,
}

/// The seller confirmation evidence seller checkout sends (`SellListSellerConfirmationEvidence`), as
/// marketplace's route builds it (`buildSellerEvidence`): every dimension said to be ready, the
/// ship-from's place and the payout readiness read
/// ([chase-sets/chase-sets#10753](https://github.com/chase-sets/chase-sets/issues/10753)).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellerEvidence {
    pub ship_from: EvidenceShipFrom,
    pub payout: EvidencePayout,
    pub label: EvidenceLabel,
    pub risk: EvidenceStatus,
    pub provider: EvidenceStatus,
    pub freshness: EvidenceStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceShipFrom {
    pub status: &'static str,
    pub address_id: Option<String>,
    pub country: String,
    pub region: String,
    pub postal_code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePayout {
    pub status: &'static str,
    pub method: &'static str,
    pub readiness_status: String,
    pub last_checked_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EvidenceLabel {
    pub status: &'static str,
    pub preference: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EvidenceStatus {
    pub status: &'static str,
}

/// The header a guest's Product Alert intent names its owner in (the anonymous alert cookie's
/// value, `x-discovery-anonymous-product-alert-id`).
pub const ANONYMOUS_PRODUCT_ALERT_HEADER: &str = "x-discovery-anonymous-product-alert-id";

/// A guest's saved Watch alert (`AnonymousProductAlertIntent`), which an account claims after
/// registering; the pilot reads only its id.
#[derive(Clone, Debug, Deserialize)]
pub struct AlertIntent {
    pub intent_id: String,
}

/// The Discovery API's Product Alert calls (`/account/product-alerts`,
/// `/guest/product-alert-intents`).
pub trait ProductAlerts {
    /// Creates the account's alert (`CreateProductAlertRequest`). The API checks nothing against
    /// the catalog (chase-sets/chase-sets#10595) and creates a new alert for each call
    /// (chase-sets/chase-sets#10596). The answer is the write's receipt.
    async fn create_product_alert(&self, alert: &impl Serialize) -> Result<Option<Receipt>, ApiError>;
    /// Saves a guest's alert as an intent owned by `guest` (the same fields and `sourcePath`).
    async fn product_alert_intent(&self, guest: &str, alert: &impl Serialize) -> Result<AlertIntent, ApiError>;
}

impl ProductAlerts for Caller<'_> {
    async fn create_product_alert(&self, alert: &impl Serialize) -> Result<Option<Receipt>, ApiError> {
        let req = self.request(Method::POST, "/api/marketplace/account/product-alerts", DISCOVERY).json(alert);
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn product_alert_intent(&self, guest: &str, alert: &impl Serialize) -> Result<AlertIntent, ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/guest/product-alert-intents", DISCOVERY)
            .header(ANONYMOUS_PRODUCT_ALERT_HEADER, guest)
            .json(alert);
        Ok(self.write::<AlertIntent>(req).await?.0)
    }
}

/// The header a guest's Saved List intent names its owner in (the anonymous saved-list cookie's
/// value, `x-collections-anonymous-saved-list-id`).
pub const ANONYMOUS_SAVED_LIST_HEADER: &str = "x-collections-anonymous-saved-list-id";
const COLLECTIONS: &str = "collections";

/// One of the account's recent Saved Lists (`DiscoveryRecentSavedList`, Discovery's own picker
/// projection of Collections' lists), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSavedList {
    pub list_id: String,
    pub title: String,
    pub line_count: u64,
    pub tracked_unit_count: u64,
}

#[derive(Deserialize)]
struct RecentSavedLists {
    items: Vec<RecentSavedList>,
}

/// What adding a product to a Saved List did (`SavedListAdditionResponse`), the fields shown.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedListAddition {
    pub list_id: String,
    /// `added`, or `merged` when the product was on the list already.
    pub line_status: String,
}

/// A guest's saved addition (`AnonymousSavedListIntent`), which an account claims after
/// registering; the pilot reads only its id.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedListIntent {
    pub intent_id: String,
}

#[derive(Deserialize)]
struct SavedListIntentBody {
    intent: SavedListIntent,
}

/// The Saved List calls the item page's Add to List makes: Discovery's picker read, and
/// Collections' addition and guest intent.
pub trait SavedLists {
    /// The account's recent Saved Lists, newest change first (at most 8).
    async fn recent_saved_lists(&self) -> Result<Vec<RecentSavedList>, ApiError>;
    /// Adds a product to a list, or to a new list (`AddProductToSavedListRequest`). Its command
    /// and line ids make it one addition however often it is sent. The answer and its receipt.
    async fn add_to_saved_list(&self, addition: &impl Serialize) -> Result<(SavedListAddition, Option<Receipt>), ApiError>;
    /// Saves a guest's addition as an intent owned by `guest` (`CreateAnonymousSavedListIntentRequest`).
    async fn saved_list_intent(&self, guest: &str, intent: &impl Serialize) -> Result<SavedListIntent, ApiError>;
}

impl SavedLists for Caller<'_> {
    async fn recent_saved_lists(&self) -> Result<Vec<RecentSavedList>, ApiError> {
        Ok(self.read::<RecentSavedLists>("/api/marketplace/account/saved-lists/recent", DISCOVERY).await?.items)
    }

    async fn add_to_saved_list(&self, addition: &impl Serialize) -> Result<(SavedListAddition, Option<Receipt>), ApiError> {
        let req = self.request(Method::POST, "/api/collections/account/list-additions", COLLECTIONS).json(addition);
        self.write::<SavedListAddition>(req).await
    }

    async fn saved_list_intent(&self, guest: &str, intent: &impl Serialize) -> Result<SavedListIntent, ApiError> {
        let req = self
            .request(Method::POST, "/api/collections/guest/saved-list-intents", COLLECTIONS)
            .header(ANONYMOUS_SAVED_LIST_HEADER, guest)
            .json(intent);
        Ok(self.write::<SavedListIntentBody>(req).await?.0.intent)
    }
}

/// What a seller would be paid for a sale at a price under the public standard seller terms
/// (`MarketplacePublicStandardTermsPreview`): the fee and the net, each for one unit.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StandardTerms {
    pub marketplace_sales_fee_unit_amount: String,
    pub seller_net_unit_amount: String,
    pub shipping_allowance_percentage_bps: i64,
    pub source_label: Option<String>,
    pub resolved_at: Option<String>,
}

/// The Marketplace API's calls.
pub trait Marketplace {
    /// The public standard terms at `price` (`POST /terms/public-standard/listing-preview`),
    /// which anyone may read.
    async fn standard_terms(&self, price: &str) -> Result<StandardTerms, ApiError>;
    /// Report a listing (`POST /listings/{id}/report`): as the account signed in, else as the
    /// visitor `anonymous` (`anon_..`, marketplace's report cookie). A second report from the
    /// same reporter is a 409 `report_already_submitted`; too many in ten minutes a 429.
    async fn report_listing(&self, listing: &str, anonymous: &str, report: &ListingReport<'_>) -> Result<(), ApiError>;
    /// Report a review (`POST /reviews/{id}/report`), as the account signed in only: a visitor is
    /// a 401. A second report from the same account is a 409 `report_already_submitted`.
    async fn report_review(&self, review: &str, report: &ListingReport<'_>) -> Result<(), ApiError>;
    /// A seller's buyer-facing chips (`GET /accounts/{id}/behavioral-metrics-chips`).
    async fn metrics_chips(&self, account: &str) -> Result<MetricsChips, ApiError>;
}

/// A listing report's body (`ReportListingRequest`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingReport<'a> {
    pub reason: &'a str,
    pub details: Option<&'a str>,
    pub source_route_path: &'a str,
}

const ANONYMOUS_REPORT_HEADER: &str = "x-marketplace-anonymous-report-id";

impl Marketplace for Caller<'_> {
    async fn standard_terms(&self, price: &str) -> Result<StandardTerms, ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/terms/public-standard/listing-preview", MARKETPLACE)
            .json(&serde_json::json!({ "priceAmount": price }));
        Ok(self.write(req).await?.0)
    }

    async fn report_listing(&self, listing: &str, anonymous: &str, report: &ListingReport<'_>) -> Result<(), ApiError> {
        let req = self
            .request(Method::POST, &format!("/api/marketplace/listings/{}/report", segment(listing)), MARKETPLACE)
            .header(ANONYMOUS_REPORT_HEADER, anonymous)
            .json(report);
        self.write::<serde_json::Value>(req).await.map(|_| ())
    }

    async fn report_review(&self, review: &str, report: &ListingReport<'_>) -> Result<(), ApiError> {
        let req =
            self.request(Method::POST, &format!("/api/marketplace/reviews/{}/report", segment(review)), MARKETPLACE).json(report);
        self.write::<serde_json::Value>(req).await.map(|_| ())
    }

    async fn metrics_chips(&self, account: &str) -> Result<MetricsChips, ApiError> {
        self.read(&format!("/api/marketplace/accounts/{}/behavioral-metrics-chips", segment(account)), MARKETPLACE).await
    }
}

const MARKETPLACE: &str = "marketplace";

/// The cart page's calls.
pub trait Checkout {
    async fn cart(&self) -> Result<Cart, ApiError>;
    /// The guest cart `anonymous_cart` (`GET /guest/cart`), with the readiness the API computed
    /// for it. A browser without one has an empty cart, as the API answers then, so it is not asked.
    async fn guest_cart(&self, anonymous_cart: Option<&str>) -> Result<Cart, ApiError>;
    /// Moves a guest cart's lines into the account's cart.
    async fn merge_guest_cart(&self, anonymous_cart: &str) -> Result<(), ApiError>;
    /// The account's cart's readiness now, with `decisions` (and the guest cart's lines).
    async fn cart_readiness(&self, decisions: &Decisions, anonymous_cart: Option<&str>) -> Result<Snapshot, ApiError>;
    /// Sends `write` as one cart attempt, applied once however often `attempt` is sent.
    async fn cart_write(&self, attempt: &str, write: &CartWrite) -> CartAnswer;
    /// What the API kept of `attempt` sent as `write`; `None` when it cannot say.
    async fn cart_attempt(&self, attempt: &str, write: &CartWrite) -> Option<CartAttempt>;
    /// Starts a checkout session for one listing (Buy now), once per `entry` key: the same key
    /// with the same source is the same session, with another source a conflict.
    async fn buy_now(&self, entry: &str, source: &serde_json::Value) -> Result<(Started, Option<Receipt>), ApiError>;
    /// Starts a checkout session for the cart as `snapshot` saw it. A session started again from
    /// the same snapshot is the same session.
    async fn start_checkout(
        &self,
        snapshot: &Snapshot,
        decisions: &Decisions,
        anonymous_cart: Option<&str>,
    ) -> Result<(Started, Option<Receipt>), ApiError>;
}

impl Checkout for Caller<'_> {
    async fn cart(&self) -> Result<Cart, ApiError> {
        self.read(CART, CHECKOUT).await
    }

    async fn guest_cart(&self, anonymous_cart: Option<&str>) -> Result<Cart, ApiError> {
        let Some(id) = anonymous_cart else { return Ok(Cart { items: Vec::new(), count: 0, readiness: None }) };
        // A read, sent as `write` sends a request (its answer checked, then its JSON).
        let req = self.request(Method::GET, "/api/marketplace/guest/cart", CHECKOUT).header(ANONYMOUS_CART_HEADER, id);
        Ok(self.write(req).await?.0)
    }

    async fn merge_guest_cart(&self, anonymous_cart: &str) -> Result<(), ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/guest/cart/merge-to-account", CHECKOUT)
            .header(ANONYMOUS_CART_HEADER, anonymous_cart)
            .json(&serde_json::json!({}));
        self.write::<serde::de::IgnoredAny>(req).await?;
        Ok(())
    }

    async fn cart_readiness(&self, decisions: &Decisions, anonymous_cart: Option<&str>) -> Result<Snapshot, ApiError> {
        let mut req = self.request(Method::POST, &format!("{CART}/readiness"), CHECKOUT).json(decisions);
        if let Some(id) = anonymous_cart {
            req = req.header(ANONYMOUS_CART_HEADER, id);
        }
        let (body, _): (ReadinessBody, _) = self.write(req).await?;
        Ok(body.readiness)
    }

    async fn cart_write(&self, attempt: &str, write: &CartWrite) -> CartAnswer {
        let mut body = write.body.clone();
        if let Some(fields) = body.as_object_mut() {
            fields.insert("attemptId".to_owned(), attempt.into());
        }
        let mut req = self.request(Method::POST, &format!("{}/cart{}", write.owner(), write.path), CHECKOUT).json(&body);
        if let Some(id) = &write.guest {
            req = req.header(ANONYMOUS_CART_HEADER, id);
        }
        let sent = req.send().await;
        let Ok(res) = sent else { return CartAnswer::Lost };
        let status = res.status();
        if status.as_u16() == 408 || status.is_server_error() {
            return CartAnswer::Lost;
        }
        let receipt = Receipt::from_response(res.headers());
        let body: Option<AttemptBody> = res.json().await.ok();
        let (attempt, message) = match body {
            Some(AttemptBody { attempt, error }) => {
                (attempt.and_then(|a| serde_json::from_value(a).ok()), error.and_then(|e| e.message))
            }
            None => (None, None),
        };
        CartAnswer::Answered { status, attempt, message, receipt }
    }

    async fn cart_attempt(&self, attempt: &str, write: &CartWrite) -> Option<CartAttempt> {
        let hash = crate::cart_attempt::request_hash(&write.body);
        let path = format!(
            "{}/command-attempts/{}?kind={}&target={CART_ATTEMPT_TARGET}&requestHash={hash}",
            write.owner(),
            segment(attempt),
            write.kind,
        );
        #[derive(Deserialize)]
        struct Found {
            attempt: CartAttempt,
        }
        let mut req = self.request(Method::GET, &path, CHECKOUT);
        if let Some(id) = &write.guest {
            req = req.header(ANONYMOUS_CART_HEADER, id);
        }
        match self.write::<Found>(req).await {
            Ok((found, _)) => Some(found.attempt),
            Err(error) => {
                tracing::warn!("the cart attempt lookup failed: {error}");
                None
            }
        }
    }

    async fn start_checkout(
        &self,
        snapshot: &Snapshot,
        decisions: &Decisions,
        anonymous_cart: Option<&str>,
    ) -> Result<(Started, Option<Receipt>), ApiError> {
        let source = serde_json::json!({
            "type": "cart",
            "readinessSnapshotId": snapshot.snapshot_id,
            "readinessSourceRevision": snapshot.source_revision,
            "readinessDecisions": decisions,
        });
        let mut req = self
            .request(Method::POST, "/api/marketplace/account/checkout-sessions", CHECKOUT)
            .json(&serde_json::json!({ "source": source }));
        if let Some(id) = anonymous_cart {
            req = req.header(ANONYMOUS_CART_HEADER, id);
        }
        self.write(req).await
    }

    async fn buy_now(&self, entry: &str, source: &serde_json::Value) -> Result<(Started, Option<Receipt>), ApiError> {
        let body = serde_json::json!({ "entryAttemptKey": entry, "source": source });
        let req = self.request(Method::POST, "/api/marketplace/account/checkout-sessions", CHECKOUT).json(&body);
        self.write(req).await
    }
}

/// A guest checkout Auth started (`POST /api/auth/guest-checkout/start`): the guest identity's
/// token, which the browser keeps as `chase_sets_guest_checkout`, and when it ends.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuestCheckout {
    pub guest_token: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct GuestCartCount {
    #[serde(default)]
    count: u64,
}

/// Checkout start's calls beyond the cart's (marketplace's `/checkout/buy/readiness`).
pub trait CheckoutStart {
    /// How many lines a guest cart holds (`GET /api/marketplace/guest/cart`).
    async fn guest_cart_count(&self, anonymous_cart: Option<&str>) -> Result<u64, ApiError>;
    /// A new contact-less guest checkout identity.
    async fn start_guest_checkout(&self) -> Result<GuestCheckout, ApiError>;
}

impl CheckoutStart for Caller<'_> {
    async fn guest_cart_count(&self, anonymous_cart: Option<&str>) -> Result<u64, ApiError> {
        let mut req = self.request(Method::GET, "/api/marketplace/guest/cart", CHECKOUT);
        if let Some(id) = anonymous_cart {
            req = req.header(ANONYMOUS_CART_HEADER, id);
        }
        let res = req.send().await?;
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        if !status.is_success() {
            return Err(ApiError::Status { status, code: None, message: String::new() });
        }
        Ok(res.json::<GuestCartCount>().await?.count)
    }

    async fn start_guest_checkout(&self) -> Result<GuestCheckout, ApiError> {
        let req = self.request(Method::POST, "/api/auth/guest-checkout/start", "auth").json(&serde_json::json!({}));
        Ok(self.write(req).await?.0)
    }
}

/// A buy checkout session as the Checkout API reads it (`GET /account/checkout-sessions/{id}`,
/// `CheckoutSessionRow` in bounded-contexts/checkout/client.ts), the fields the checkout page reads.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CheckoutSession {
    pub session_id: String,
    pub source_type: String,
    #[serde(default)]
    pub shipping_option: Option<String>,
    #[serde(default)]
    pub shipping_address_id: Option<String>,
    #[serde(default)]
    pub shipping_address: Option<SessionAddress>,
    #[serde(default)]
    pub authenticity_check_opt_in: Option<OptIn>,
    #[serde(default)]
    pub fulfillment_preview_revision: Option<String>,
    #[serde(default)]
    pub fulfillment_preview_snapshot: Option<FulfillmentPreview>,
    #[serde(default)]
    pub lines: Vec<SessionLine>,
    #[serde(default)]
    pub order_ids: Vec<String>,
    #[serde(default)]
    pub payment_id: Option<String>,
    #[serde(default)]
    pub submitted_offer_id: Option<String>,
    #[serde(default)]
    pub handoff_expires_at: Option<String>,
    /// Where a support reference comes from (`buyCheckoutSupportReference`).
    #[serde(default)]
    pub split_group_handoff: Option<serde_json::Value>,
    #[serde(default)]
    pub cart_readiness_snapshot: Option<serde_json::Value>,
}

/// The address a session keeps (`CheckoutShippingAddressInput`), and the one a write sends.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAddress {
    #[serde(default)]
    pub shipping_address_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub line1: String,
    #[serde(default)]
    pub line2: Option<String>,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// The buyer's authenticity check choice, with the quote it was made against.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptIn {
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub quote_fingerprint: Option<String>,
}

/// A session line (`CheckoutSessionRow["lines"]`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLine {
    #[serde(default)]
    pub quantity: u64,
    #[serde(default)]
    pub item_title: String,
    #[serde(default)]
    pub item_subtitle: Option<String>,
    #[serde(default)]
    pub product_id: String,
    #[serde(default)]
    pub product_summary: Option<String>,
    #[serde(default)]
    pub cart_line_id: Option<String>,
    #[serde(default)]
    pub listing_id: Option<String>,
    /// A purchase intent's offer for the line (`offerPriceAmount`).
    #[serde(default)]
    pub offer_price_amount: Option<String>,
}

/// The fulfillment preview the session recorded (`CheckoutFulfillmentPreview`): what each seller
/// ships, the totals, and the authenticity check on offer.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FulfillmentPreview {
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub totals: PreviewTotals,
    #[serde(default)]
    pub seller_groups: Vec<SellerGroup>,
    #[serde(default)]
    pub ready_line_keys: Vec<String>,
    #[serde(default)]
    pub unavailable_line_keys: Vec<String>,
    #[serde(default)]
    pub unavailable_lines: Vec<PreviewLine>,
    #[serde(default)]
    pub material_change_reasons: Vec<String>,
    #[serde(default)]
    pub authenticity_check_offer: Option<AuthenticityOffer>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTotals {
    #[serde(default)]
    pub total_amount: Option<String>,
    #[serde(default)]
    pub item_subtotal_amount: Option<String>,
    #[serde(default)]
    pub shipping_amount: Option<String>,
    #[serde(default)]
    pub sales_tax_amount: Option<String>,
}

/// One seller's part of the preview: its lines and its delivery estimate.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SellerGroup {
    #[serde(default)]
    pub lines: Vec<PreviewLine>,
    #[serde(default)]
    pub delivery_estimate: DeliveryEstimate,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    #[serde(default)]
    pub line_key: String,
    #[serde(default)]
    pub listing_id: Option<String>,
    #[serde(default)]
    pub product_id: String,
    #[serde(default)]
    pub estimated_line_total_amount: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryEstimate {
    #[serde(default)]
    pub earliest_date: String,
    #[serde(default)]
    pub latest_date: String,
    #[serde(default)]
    pub package_count: u64,
    #[serde(default)]
    pub service_level: String,
}

/// The authenticity check the preview offers, at its quoted fee.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AuthenticityOffer {
    #[serde(default)]
    pub eligible: bool,
    #[serde(default)]
    pub fee_amount: String,
    #[serde(default)]
    pub quote_fingerprint: String,
}

/// What Payments quotes for paying `amount` (`GET /account/checkout/preview-status`,
/// `CheckoutPaymentPreviewStatus`): the fee for the chosen method, every method's quote, and the
/// wallet credit applied. Payments quotes it from the policy in effect; marketplace's loader
/// quotes the compiled default itself (chase-sets/chase-sets#10683).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PaymentPreview {
    pub marketplace_checkout_fee: FeeQuote,
    #[serde(default)]
    pub payment_method_quotes: Vec<FeeQuote>,
    #[serde(default)]
    pub wallet_credit: WalletCredit,
    /// Why Payments withholds part of the payment, in its words: the wallet's credit while the
    /// buyer has not accepted the current terms (`wallet-terms-not-accepted`), or nothing to pay.
    #[serde(default)]
    pub unavailable_reason_details: Vec<ReasonDetail>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct FeeQuote {
    pub payment_method_category: String,
    #[serde(default)]
    pub marketplace_checkout_fee_amount: String,
    /// How much less than the card's fee this method's is.
    #[serde(default)]
    pub marketplace_checkout_fee_reduction_amount: String,
    #[serde(default)]
    pub total_amount: String,
    /// What the provider charges: the total less the wallet's credit.
    #[serde(default)]
    pub processor_amount: String,
    #[serde(default)]
    pub quote_fingerprint: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct WalletCredit {
    #[serde(default)]
    pub requested_amount: String,
    #[serde(default)]
    pub applied_amount: String,
}

/// The account's wallet balance (`GET /api/settlement/wallet`): what checkout applies to the
/// payable total, and the money page's balances.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Wallet {
    pub available_balance_amount: String,
    pub currency_code: String,
    #[serde(default)]
    pub pending_balance_amount: String,
}

/// A saved shipping address (`GET /account/sell-list/ship-from-addresses`, the address book).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SavedAddress {
    pub shipping_address_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub recipient_name: String,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub line1: String,
    #[serde(default)]
    pub line2: Option<String>,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

/// A saved payment method checkout can use (`GET /account/checkout-payment-affordances`).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SavedInstrument {
    pub instrument_id: String,
    #[serde(default)]
    pub payment_method_category: String,
    #[serde(default)]
    pub display_label: String,
    #[serde(default)]
    pub confirmation_experience: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub readiness: String,
}

/// What Pay now sends (`confirmCheckoutSession`'s body).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmBody {
    pub requested_balance_credit_amount: Option<String>,
    pub payment_method_category: String,
    pub marketplace_checkout_fee_quote_fingerprint: Option<String>,
    pub saved_checkout_instrument_id: Option<String>,
    pub save_payment_method_for_future: bool,
    pub fulfillment_preview_revision: Option<String>,
    pub acknowledged_material_changes: bool,
    pub shipping_address: SessionAddress,
}

/// Pay now's answer: the payment started, or the offer a purchase intent became.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Confirmed {
    #[serde(default)]
    pub payment_id: Option<String>,
    #[serde(default)]
    pub offer_id: Option<String>,
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

const CHECKOUT_SESSIONS: &str = "/api/marketplace/account/checkout-sessions";

/// The buy checkout page's calls: the session and what the page reads with it, its review writes
/// (shipping option, address, authenticity check, the fulfillment preview) and Pay now.
pub trait CheckoutSessions {
    async fn checkout_session(&self, id: &str) -> Result<CheckoutSession, ApiError>;
    async fn wallet(&self) -> Result<Wallet, ApiError>;
    async fn checkout_addresses(&self) -> Result<Vec<SavedAddress>, ApiError>;
    async fn checkout_instruments(&self) -> Result<Vec<SavedInstrument>, ApiError>;
    /// Payments' quote for paying `amount`, `credit` of it from the wallet, by `method`.
    async fn payment_preview(&self, amount: &str, currency: &str, credit: &str, method: &str)
    -> Result<PaymentPreview, ApiError>;
    async fn select_shipping_option(&self, id: &str, option: &str) -> Result<Option<Receipt>, ApiError>;
    async fn select_shipping_address(&self, id: &str, address: &SessionAddress) -> Result<Option<Receipt>, ApiError>;
    async fn select_authenticity_check(&self, id: &str, selected: bool, quote: Option<&str>)
    -> Result<Option<Receipt>, ApiError>;
    async fn record_fulfillment_preview(
        &self,
        id: &str,
        option: &str,
        address: &SessionAddress,
    ) -> Result<Option<Receipt>, ApiError>;
    async fn confirm_checkout(&self, id: &str, body: &ConfirmBody) -> Result<(Confirmed, Option<Receipt>), ApiError>;
    /// A started payment's amount and status (`GET /account/checkout-payment-summaries/{id}`).
    async fn checkout_payment_summary(&self, payment: &str) -> Result<PaymentSummary, ApiError>;
}

/// A started payment as the checkout shows it (`CheckoutPaymentSummaryRow`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PaymentSummary {
    pub payment_id: String,
    pub amount: String,
    pub currency_code: String,
    /// `pending-confirmation`, `captured`, `failed`, `cancelled` or another (pending).
    pub status: String,
}

/// One of the session's review writes, and its receipt.
async fn session_write(caller: &Caller<'_>, id: &str, path: &str, body: serde_json::Value) -> Result<Option<Receipt>, ApiError> {
    let req = caller.request(Method::POST, &format!("{CHECKOUT_SESSIONS}/{}/{path}", segment(id)), CHECKOUT).json(&body);
    let (_, receipt): (serde_json::Value, _) = caller.write(req).await?;
    Ok(receipt)
}

impl CheckoutSessions for Caller<'_> {
    async fn checkout_session(&self, id: &str) -> Result<CheckoutSession, ApiError> {
        self.read(&format!("{CHECKOUT_SESSIONS}/{}", segment(id)), CHECKOUT).await
    }

    async fn checkout_payment_summary(&self, payment: &str) -> Result<PaymentSummary, ApiError> {
        self.read(&format!("/api/marketplace/account/checkout-payment-summaries/{}", segment(payment)), CHECKOUT).await
    }

    async fn wallet(&self) -> Result<Wallet, ApiError> {
        self.read("/api/settlement/wallet", "settlement").await
    }

    async fn checkout_addresses(&self) -> Result<Vec<SavedAddress>, ApiError> {
        let body: Items<SavedAddress> = self.read("/api/marketplace/account/sell-list/ship-from-addresses", CHECKOUT).await?;
        Ok(body.items)
    }

    async fn checkout_instruments(&self) -> Result<Vec<SavedInstrument>, ApiError> {
        let body: Items<SavedInstrument> = self.read("/api/marketplace/account/checkout-payment-affordances", CHECKOUT).await?;
        Ok(body.items)
    }

    async fn payment_preview(
        &self,
        amount: &str,
        currency: &str,
        credit: &str,
        method: &str,
    ) -> Result<PaymentPreview, ApiError> {
        let path = format!(
            "/api/marketplace/account/checkout/preview-status?amount={}&currencyCode={}&requestedBalanceCreditAmount={}&paymentMethodCategory={}",
            segment(amount),
            segment(currency),
            segment(credit),
            segment(method)
        );
        self.read(&path, "payments").await
    }

    async fn select_shipping_option(&self, id: &str, option: &str) -> Result<Option<Receipt>, ApiError> {
        session_write(self, id, "shipping-option", serde_json::json!({ "shippingOption": option })).await
    }

    async fn select_shipping_address(&self, id: &str, address: &SessionAddress) -> Result<Option<Receipt>, ApiError> {
        session_write(self, id, "shipping-address", serde_json::json!({ "shippingAddress": address })).await
    }

    async fn select_authenticity_check(
        &self,
        id: &str,
        selected: bool,
        quote: Option<&str>,
    ) -> Result<Option<Receipt>, ApiError> {
        let body = serde_json::json!({ "selected": selected, "quoteFingerprint": quote });
        session_write(self, id, "authenticity-check-opt-in", body).await
    }

    async fn record_fulfillment_preview(
        &self,
        id: &str,
        option: &str,
        address: &SessionAddress,
    ) -> Result<Option<Receipt>, ApiError> {
        let body = serde_json::json!({ "shippingOption": option, "shippingAddress": address });
        session_write(self, id, "fulfillment-preview", body).await
    }

    async fn confirm_checkout(&self, id: &str, body: &ConfirmBody) -> Result<(Confirmed, Option<Receipt>), ApiError> {
        // Confirm creates the orders and starts the payment with the provider, which can take longer
        // than the client's 10 s; cutting it off leaves orders without a payment. marketplace's
        // action sets no timeout on this write.
        let req = self
            .request(Method::POST, &format!("{CHECKOUT_SESSIONS}/{}/confirm", segment(id)), CHECKOUT)
            .timeout(CONFIRM_TIMEOUT)
            .json(body);
        self.write(req).await
    }
}

/// How long Pay now waits for Confirm (`confirm_checkout`).
const CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

const DISCOVERY: &str = "discovery";
const PRICING: &str = "pricing";
const ROLLUPS: &str = "/api/marketplace/market-rollups";
const ITEMS: &str = "/api/marketplace/items";

/// An item page's read (`GET /api/marketplace/items/{id}`, `DiscoveryItemDetail` in
/// bounded-contexts/discovery/support/client-support/contracts.ts), the fields the page reads. The
/// listings and offers come in the order the Discovery API ranks them (chase-sets/chase-sets#10559): the first
/// listing a buyer can buy is the best available one, the first offer the best.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Item {
    pub catalog_item_id: String,
    pub slug: Option<String>,
    pub language_code: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub blueprint: Option<Blueprint>,
    /// `active` or not.
    pub status: String,
    #[serde(default)]
    pub field_values: Vec<FieldValue>,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub product_asset_sets: Vec<AssetSet>,
    pub image_fallback: Option<ImageFallback>,
    pub product_schema: Option<Schema>,
    pub updated_at: String,
    pub market_summary: Option<MarketSummary>,
    #[serde(default)]
    pub market_listings: Vec<Listing>,
    #[serde(default)]
    pub offer_demand_matches: Vec<Offer>,
    #[serde(default)]
    pub market_products: Vec<MarketProduct>,
    /// Listings of the item's products that `market_listings` leaves out.
    #[serde(default)]
    pub market_product_listings: Vec<Listing>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Blueprint {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub category_id: String,
    pub slug: String,
    pub name: String,
}

/// A catalog field's value: text, a number, localized text (`{"values": {"en": ..}}`) or a
/// reference, which `reference` resolves.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub field_id: String,
    pub field_name: String,
    #[serde(default)]
    pub value: serde_json::Value,
    pub reference: Option<Reference>,
}

/// A reference record and the records it relates to (an expansion is part of a series).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub reference_id: String,
    pub name: String,
    pub type_key: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub status: String,
    /// Its attributes by name, each a value of any kind.
    #[serde(default)]
    pub attributes: Attributes,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
}

/// A record's attributes in the order the API sends them, as marketplace lists them
/// (`Object.entries`); serde_json's own map would sort them. Anything but an object is none.
#[derive(Clone, Debug, Default)]
pub struct Attributes(pub Vec<(String, serde_json::Value)>);

impl<'de> Deserialize<'de> for Attributes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Attributes;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object of attributes")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Attributes, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(Attributes(entries))
            }
            fn visit_unit<E>(self) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Attributes, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Attributes::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Attributes, E> {
                Ok(Attributes::default())
            }
        }
        deserializer.deserialize_any(Visit)
    }
}

impl Serialize for Attributes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub relationship_type: String,
    #[serde(default)]
    pub reference_id: String,
    pub reference: Option<Reference>,
}

/// A product picture's renditions (`DiscoveryProductAssetSet`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssetSet {
    #[serde(default)]
    pub variants: Vec<AssetVariant>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVariant {
    /// `thumbnail`, `catalog-detail` or `source`.
    pub role: String,
    pub density: u8,
    pub width: u32,
    pub height: u32,
    pub public_url: String,
}

/// The picture an item without one shows (a card back), and whether it stays (`permanent`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImageFallback {
    pub url: String,
    pub alt: String,
    pub usage: String,
    /// Its renditions by size (`thumbnail`, `card`, `detail`).
    #[serde(default)]
    pub variants: BTreeMap<String, FallbackVariant>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackVariant {
    pub one_x: Option<String>,
    pub two_x: Option<String>,
}

/// What makes a product of the item (`ProductSchema`): its dimensions, in the order a product
/// id names them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub dimensions: Vec<Dimension>,
    pub canonical_dimension_order: Vec<DimensionRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionRef {
    pub dimension_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimension {
    pub dimension_id: String,
    pub dimension_name: String,
    /// `ordered`, `numeric` or `unordered`; Inventory's catalog item read leaves it out.
    #[serde(default)]
    pub value_kind: String,
    #[serde(default)]
    pub required: bool,
    /// The selections under which the dimension applies (a grade only for a graded card).
    #[serde(default)]
    pub applies_when: Vec<Clause>,
    pub allowed_options: Vec<DimensionOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clause {
    pub dimension_id: String,
    pub option_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionOption {
    pub option_id: String,
    pub code: String,
    pub label: Option<String>,
    #[serde(default)]
    pub display_order: i64,
    pub numeric_value: Option<f64>,
}

/// One dimension's option, as a listing or an offer names its product.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selected {
    pub dimension_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarketSummary {
    pub lowest_price_amount: Option<String>,
    pub lowest_price_currency_code: Option<String>,
    pub active_listing_count: u64,
    pub total_visible_quantity: u64,
}

/// `DiscoveryMarketListing`, the fields the page reads.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Listing {
    pub listing_id: String,
    pub account_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    #[serde(default)]
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub quantity_cap: Option<u64>,
    pub visible_quantity: Option<u64>,
    pub max_units_per_order: Option<u64>,
    pub max_units_per_day: Option<u64>,
    pub max_units_per_customer_account: Option<u64>,
    pub seller_slug: Option<String>,
    pub seller_display_name: Option<String>,
    pub seller_average_rating: Option<String>,
    #[serde(default)]
    pub seller_review_count: u64,
    /// `active` or not; only an active listing is bought (`findSelectedListingForAction`).
    #[serde(default)]
    pub status: String,
    pub listing_stream_version: Option<u64>,
    /// The seller is temporarily at capacity: the listing shows, but cannot be bought now.
    #[serde(default)]
    pub seller_at_capacity: bool,
}

/// A product of the item and its lowest listing (`market_products`), which Buy best match buys.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarketProduct {
    pub product_id: String,
    pub lowest_listing_id: Option<String>,
}

/// `DiscoveryOffer`, the fields the page reads.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Offer {
    pub offer_id: String,
    pub buyer_account_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    #[serde(default)]
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub quantity_requested: u64,
    /// `submitted` while sellers may take it.
    #[serde(default)]
    pub status: Option<String>,
    pub buyer_slug: Option<String>,
    pub buyer_display_name: Option<String>,
    pub buyer_average_rating: Option<String>,
    #[serde(default)]
    pub buyer_review_count: u64,
}

/// The item page's calls.
pub trait Discovery {
    /// The item by its slug or its id; `None` when the API has no such item.
    async fn item(&self, id: &str) -> Result<Option<Item>, ApiError>;
    /// What the page shows a seller who may list (`SellerOverlay`).
    async fn seller_overlay(&self, id: &str) -> Result<SellerOverlay, ApiError>;
    /// Items like the item, by its slug or its id (`GET /api/marketplace/items/{id}/similar`).
    async fn similar(&self, id: &str) -> Result<Vec<SimilarItem>, ApiError>;
    /// A listing's public page by its slug (or an old one); `None` when there is none.
    async fn public_listing(&self, slug: &str) -> Result<Option<PublicListing>, ApiError>;
    /// An account's public page by its slug (or an old one, or its id), with the page of reviews
    /// `query` asks for (`limit`, `offset`, `role`); `None` when there is none.
    async fn public_account(&self, slug: &str, query: &str) -> Result<Option<PublicAccount>, ApiError>;
}

/// One public page a sitemap lists (`DiscoverySitemapUrl`): its path on marketplace and when it
/// last changed.
#[derive(Debug, Deserialize)]
pub struct SitemapEntry {
    pub path: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
struct SitemapEntries {
    #[serde(default)]
    items: Vec<SitemapEntry>,
}

/// Discovery's public pages for the sitemaps, read for no one in particular.
pub trait Sitemaps {
    /// How many public pages there are of each kind (`GET /api/marketplace/sitemap-entity-counts`):
    /// `items`, `categories`, `sellers`, `listings` and `sets`.
    async fn sitemap_counts(&self) -> Result<BTreeMap<String, u64>, ApiError>;
    /// The `page`th page of a kind's (`GET /api/marketplace/sitemap-entities/{kind}/{page}`).
    async fn sitemap_entries(&self, kind: &str, page: u64) -> Result<Vec<SitemapEntry>, ApiError>;
}

impl Sitemaps for Caller<'_> {
    async fn sitemap_counts(&self) -> Result<BTreeMap<String, u64>, ApiError> {
        self.read("/api/marketplace/sitemap-entity-counts", DISCOVERY).await
    }

    async fn sitemap_entries(&self, kind: &str, page: u64) -> Result<Vec<SitemapEntry>, ApiError> {
        let path = format!("/api/marketplace/sitemap-entities/{}/{page}", segment(kind));
        Ok(self.read::<SitemapEntries>(&path, DISCOVERY).await?.items)
    }
}

/// Pricing's market rollups for a product, which the Sales tab shows.
pub trait MarketHistory {
    /// The product's market stats (`ProductMarketStatsSnapshotResponse`).
    async fn market_stats(&self, item_id: &str, product_id: &str) -> Result<MarketStats, ApiError>;
    /// The product's sale prices in `currency` from `from` to `to` (`YYYY-MM-DD`), one point a
    /// `granularity` (`daily`, `weekly` or `monthly`).
    async fn rollup_series(
        &self,
        item_id: &str,
        product_id: &str,
        currency: &str,
        window: &SeriesWindow,
    ) -> Result<Vec<RollupPoint>, ApiError>;
}

/// The days a series covers and its granularity.
pub struct SeriesWindow {
    pub from: String,
    pub to: String,
    pub granularity: &'static str,
}

impl MarketHistory for Caller<'_> {
    async fn market_stats(&self, item_id: &str, product_id: &str) -> Result<MarketStats, ApiError> {
        self.read(&format!("{ROLLUPS}/{}/{}/stats", segment(item_id), segment(product_id)), PRICING).await
    }

    async fn rollup_series(
        &self,
        item_id: &str,
        product_id: &str,
        currency: &str,
        window: &SeriesWindow,
    ) -> Result<Vec<RollupPoint>, ApiError> {
        let path = format!(
            "{ROLLUPS}/{}/{}/series?from={}&to={}&currencyCode={}&granularity={}",
            segment(item_id),
            segment(product_id),
            segment(&window.from),
            segment(&window.to),
            segment(currency),
            window.granularity,
        );
        Ok(self.read::<RollupSeries>(&path, PRICING).await?.items)
    }
}

/// `ProductMarketStatsSnapshotResponse`, the fields the Sales tab reads.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStats {
    /// One for each currency the product has sold in.
    #[serde(default)]
    pub aggregates: Vec<MarketAggregate>,
    pub market_state: Option<MarketState>,
    pub stat_hygiene: Option<StatHygiene>,
    pub display_policy: Option<DisplayPolicy>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketAggregate {
    pub currency_code: String,
    pub last_sold_at: Option<String>,
    pub last_sold_price_amount: Option<String>,
    pub median_price30d: Option<String>,
    #[serde(default)]
    pub volume30d: u64,
    #[serde(default)]
    pub trade_count30d: u64,
    pub median_price90d: Option<String>,
    #[serde(default)]
    pub volume90d: u64,
    #[serde(default)]
    pub trade_count90d: u64,
}

/// The product's market today: its lowest ask, highest bid and the spread between them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketState {
    pub min_ask_amount: Option<String>,
    pub max_bid_amount: Option<String>,
    pub spread_amount: Option<String>,
}

/// Fewer sales than this in a window and its median is not shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatHygiene {
    pub minimum_trade_sample: u64,
}

/// Pricing's display policy: whether verified sales are marked on the chart.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayPolicy {
    pub show_verified_markers: bool,
}

/// A day's (or a week's, or a month's) sales (`ProductRollupSeriesPoint`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollupPoint {
    /// The period's first day, `YYYY-MM-DD`.
    pub day: String,
    pub last_price_amount: Option<String>,
    pub min_price_amount: Option<String>,
    pub max_price_amount: Option<String>,
    #[serde(default)]
    pub verified_trade_count: u64,
}

#[derive(Deserialize)]
struct RollupSeries {
    #[serde(default)]
    items: Vec<RollupPoint>,
}

/// An item like the page's (`DiscoverySimilarItem`), the fields its card shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SimilarItem {
    pub catalog_item_id: String,
    #[serde(default)]
    pub slug: String,
    pub title: String,
    pub subtitle: Option<String>,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub product_asset_sets: Vec<AssetSet>,
    pub image_fallback: Option<ImageFallback>,
}

/// `DiscoverySimilarItemsResponse`, the part the page reads.
#[derive(Deserialize)]
struct SimilarItems {
    #[serde(default)]
    items: Vec<SimilarItem>,
}

impl Discovery for Caller<'_> {
    async fn item(&self, id: &str) -> Result<Option<Item>, ApiError> {
        match self.read(&format!("{ITEMS}/{}", segment(id)), DISCOVERY).await {
            Ok(item) => Ok(Some(item)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn seller_overlay(&self, id: &str) -> Result<SellerOverlay, ApiError> {
        self.read(&format!("{ITEMS}/{}/seller-overlay", segment(id)), DISCOVERY).await
    }

    async fn similar(&self, id: &str) -> Result<Vec<SimilarItem>, ApiError> {
        Ok(self.read::<SimilarItems>(&format!("{ITEMS}/{}/similar", segment(id)), DISCOVERY).await?.items)
    }

    async fn public_listing(&self, slug: &str) -> Result<Option<PublicListing>, ApiError> {
        match self.read(&format!("/api/marketplace/listings/{}", segment(slug)), DISCOVERY).await {
            Ok(listing) => Ok(Some(listing)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn public_account(&self, slug: &str, query: &str) -> Result<Option<PublicAccount>, ApiError> {
        match self.read(&format!("/api/marketplace/accounts/{}?{query}", segment(slug)), DISCOVERY).await {
            Ok(account) => Ok(Some(account)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// An account's public page (`GET /api/marketplace/accounts/{slug}`, `DiscoveryPublicAccount`), the
/// fields the page reads. A suspended or closed account (`status` other than `active`) comes
/// without its listings, reviews or reputation.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PublicAccount {
    pub account_id: String,
    pub account_slug: String,
    pub account_display_name: Option<String>,
    pub status: String,
    pub created_at: Option<String>,
    pub active_listing_count: u64,
    pub badges: Vec<String>,
    pub founder_number: Option<u32>,
    pub average_rating_as_seller: Option<String>,
    pub review_count_as_seller: u64,
    pub rating_count_as_seller: u64,
    pub rating_1_count_as_seller: u64,
    pub rating_2_count_as_seller: u64,
    pub rating_3_count_as_seller: u64,
    pub rating_4_count_as_seller: u64,
    pub rating_5_count_as_seller: u64,
    pub average_rating_as_buyer: Option<String>,
    pub review_count_as_buyer: u64,
    pub rating_count_as_buyer: u64,
    pub rating_1_count_as_buyer: u64,
    pub rating_2_count_as_buyer: u64,
    pub rating_3_count_as_buyer: u64,
    pub rating_4_count_as_buyer: u64,
    pub rating_5_count_as_buyer: u64,
    pub reviews: AccountReviews,
    pub listings: Vec<AccountListing>,
}

/// A page of an account's reviews, and how many there are in all.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AccountReviews {
    pub items: Vec<AccountReview>,
    pub total: u64,
}

/// A review of the account (`DiscoveryPublicAccountReview`), with how it counts toward the rating.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AccountReview {
    pub review_id: String,
    pub author_display_name: Option<String>,
    /// `buyer` (a review of the account as a seller) or `seller`.
    pub author_role: String,
    pub rating: u8,
    pub feedback: Option<String>,
    /// `included` or `context-only`; none for a review from before scoring.
    pub scoring_disposition: Option<String>,
    pub disposition_reason_code: Option<String>,
    pub resolution_context: Option<String>,
    pub remedy_kind: Option<String>,
    pub submitted_at: Option<String>,
    pub updated_at: Option<String>,
    pub reply_feedback: Option<String>,
    pub reply_status: Option<String>,
}

/// One of the account's active listings, the fields its card shows.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AccountListing {
    pub listing_id: String,
    pub listing_slug: String,
    pub catalog_catalog_item_id: String,
    pub catalog_item_slug: Option<String>,
    pub item_title: Option<String>,
    pub product_summary: Option<String>,
    pub ship_from_code: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub visible_quantity: u64,
    pub max_units_per_order: Option<u64>,
    pub max_units_per_day: Option<u64>,
    pub max_units_per_customer_account: Option<u64>,
}

/// A seller's buyer-facing chips (`SellerBehavioralMetricsChips`): each is `true` only when its
/// rate is confidently good and past the threshold, and `null` otherwise.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MetricsChips {
    pub ships_on_time: Option<bool>,
    pub low_cancellation_rate: Option<bool>,
    pub low_dispute_rate: Option<bool>,
}

/// A listing's public page (`GET /api/marketplace/listings/{slug}`, `DiscoveryPublicListing`):
/// the listing as the item page reads one, and what its own page adds.
#[derive(Clone, Debug, Deserialize)]
pub struct PublicListing {
    #[serde(flatten)]
    pub listing: Listing,
    pub listing_slug: String,
    pub catalog_item_slug: Option<String>,
    pub item_title: Option<String>,
    pub item_subtitle: Option<String>,
    pub ship_from_code: Option<String>,
    #[serde(default)]
    pub shipping_allowance_percentage_bps: u64,
    /// `available` or `unavailable` (the seller is away).
    pub seller_listing_availability_status: Option<String>,
    /// When an away seller's listings return; `None` for an indefinite away.
    pub seller_available_again_at: Option<String>,
}

/// A page of search results (`GET /api/marketplace/items?..`, `DiscoverySearchResponse`), the
/// fields the search page reads.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    #[serde(default)]
    pub items: Vec<SearchItem>,
    #[serde(default)]
    pub facets: Vec<Facet>,
    #[serde(default, rename = "category_counts")]
    pub category_counts: Vec<CategoryCount>,
    /// Asked for with `includeTotal` (a first page).
    pub total: Option<u64>,
    pub next_cursor: Option<String>,
    /// A page after a cursor the API no longer takes (the results changed): this is a first page.
    #[serde(default)]
    pub cursor_restarted: bool,
    /// `lexical`, `corrected` (close spellings) or `rescue` (closest matches).
    pub retrieval_mode: Option<String>,
    pub lexical_count: Option<u64>,
    /// Filters the API read from the words, which the page applies with a redirect.
    pub interpretation: Option<Interpretation>,
    /// The normalized words' SHA-256 and the result set's opaque key, which the analytics of a
    /// result's click carry (`search_result_selected`).
    pub query_hash: Option<String>,
    pub result_set_key: Option<String>,
}

impl SearchResults {
    /// The analytics keys, empty when the API sent none (a click then sends nothing).
    pub fn keys(&self) -> (&str, &str) {
        (self.query_hash.as_deref().unwrap_or_default(), self.result_set_key.as_deref().unwrap_or_default())
    }
}

/// A result (`DiscoverySearchItem`): its card's fields, its language, badges and market.
#[derive(Clone, Debug, Deserialize)]
pub struct SearchItem {
    #[serde(flatten)]
    pub card: SimilarItem,
    pub language_code: Option<String>,
    #[serde(default)]
    pub display_badges: Vec<DisplayBadge>,
    pub market_summary: Option<SearchMarket>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DisplayBadge {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
}

/// A result's market: its lowest listed price and how many listings are active.
#[derive(Clone, Debug, Deserialize)]
pub struct SearchMarket {
    pub lowest_price_amount: Option<String>,
    pub lowest_price_currency_code: Option<String>,
    #[serde(default)]
    pub active_listing_count: u64,
}

/// A filter the results can be narrowed by (`DiscoveryFacetGroup`): a field, a reference or a
/// product dimension, and its values with their counts.
#[derive(Clone, Debug, Deserialize)]
pub struct Facet {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub values: Vec<FacetValue>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FacetValue {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub count: u64,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CategoryCount {
    pub slug: String,
    #[serde(default)]
    pub count: u64,
}

/// What the API read from the search's words (`DiscoverySearchInterpretation`): the words left,
/// and each filter it applied.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interpretation {
    pub remaining_query: String,
    #[serde(default)]
    pub applied: Vec<Applied>,
}

/// One applied filter: `param` is `language` (with `language`) or a filter's key such as
/// `dimension.<id>` (with `optionId`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub param: String,
    pub option_id: Option<String>,
    pub language: Option<String>,
}

/// A category (`DiscoveryCategoryItem`), the fields search reads.
#[derive(Clone, Debug, Deserialize)]
pub struct SearchCategory {
    pub category_id: String,
    pub slug: String,
    pub name: String,
    pub key: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub item_count: u64,
    /// The home page features the first four by this order.
    #[serde(default)]
    pub display_order: i64,
}

#[derive(Deserialize)]
struct Categories {
    #[serde(default)]
    items: Vec<SearchCategory>,
}

/// Marketplace search's calls.
pub trait Search {
    /// A page of results; `query` is the API's query string, without the `?`.
    async fn search(&self, query: &str) -> Result<SearchResults, ApiError>;
    /// Every category.
    async fn categories(&self) -> Result<Vec<SearchCategory>, ApiError>;
    /// The category with the slug; `None` when there is none.
    async fn category(&self, slug: &str) -> Result<Option<SearchCategory>, ApiError>;
    /// The set with the slug (or an old one) and its first items; `None` when there is none.
    async fn set(&self, slug: &str) -> Result<Option<SetPage>, ApiError>;
}

impl Search for Caller<'_> {
    async fn search(&self, query: &str) -> Result<SearchResults, ApiError> {
        self.read(&format!("{ITEMS}?{query}"), DISCOVERY).await
    }

    async fn categories(&self) -> Result<Vec<SearchCategory>, ApiError> {
        Ok(self.read::<Categories>("/api/marketplace/categories", DISCOVERY).await?.items)
    }

    async fn category(&self, slug: &str) -> Result<Option<SearchCategory>, ApiError> {
        match self.read(&format!("/api/marketplace/categories/{}", segment(slug)), DISCOVERY).await {
            Ok(category) => Ok(Some(category)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn set(&self, slug: &str) -> Result<Option<SetPage>, ApiError> {
        match self.read(&format!("/api/marketplace/sets/{}", segment(slug)), DISCOVERY).await {
            Ok(set) => Ok(Some(set)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// A set's page (`DiscoveryBrowseSetPage`): the set, a reference record of its type, and the
/// first of its cataloged items, as search's cards.
#[derive(Clone, Debug, Deserialize)]
pub struct SetPage {
    pub reference_record_id: String,
    pub type_key: String,
    pub slug: String,
    pub name: String,
    pub code: Option<String>,
    pub game: Option<String>,
    pub release_date: Option<String>,
    #[serde(default)]
    pub reference_card_count: Option<u64>,
    pub item_count: u64,
    #[serde(default)]
    pub items: Vec<SearchItem>,
}

/// What the item page reads for a seller (`GET /api/marketplace/items/{id}/seller-overlay`,
/// `DiscoveryItemDetailSellerOverlay`), the field the pilot reads: whether the account has the
/// Listing stock location quick listings ship from. Its offer matches and inventory are not
/// ported.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellerOverlay {
    pub has_listing_stock_location: bool,
}

/// The stock an account's quick listing sells (`POST /api/inventory/items/listing-stock/ensure`,
/// `InventoryEnsuredListingStock`): its snapshot, which the listing is created from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingStock {
    pub snapshot: serde_json::Value,
}

/// A created listing (`POST /api/marketplace/account/listings`): its id, the fee quote it is
/// published with, and its state. The same `listingIdOverride` sent again answers the listing as it
/// now is, so a resent form finds it already published.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedListing {
    pub id: String,
    pub fee_quote_fingerprint: Option<String>,
    #[serde(default)]
    pub state: Option<CreatedListingState>,
}

/// A created listing's current state; the pilot reads only its status.
#[derive(Clone, Debug, Deserialize)]
pub struct CreatedListingState {
    pub status: String,
}

impl CreatedListing {
    /// Whether the listing is already published (a resent form): publishing it again is refused.
    pub fn is_active(&self) -> bool {
        self.state.as_ref().is_some_and(|s| s.status == "active")
    }
}

/// A guest's listing draft (`MarketplaceAnonymousListingDraftIntent`), which an account claims
/// after registering; the pilot reads only its id.
#[derive(Clone, Debug, Deserialize)]
pub struct DraftIntent {
    pub intent_id: String,
}

/// The header a guest's listing draft names its owner in (the anonymous draft cookie's value).
const ANONYMOUS_LISTING_DRAFT_HEADER: &str = "x-marketplace-anonymous-listing-draft-id";

/// A quick listing's calls: its stock, the listing, its publication, and a guest's draft.
pub trait Listings {
    /// Ensures the account's Listing stock holds `body`'s product and quantity, as one inventory
    /// attempt (applied once however often `attempt` is sent).
    async fn ensure_listing_stock(&self, attempt: &str, body: &serde_json::Value) -> Result<ListingStock, ApiError>;
    /// Creates the listing, a draft. With `listingIdOverride` in `body`, the same id sent again is
    /// the same listing.
    async fn create_listing(&self, body: &serde_json::Value) -> Result<(CreatedListing, Option<Receipt>), ApiError>;
    /// Publishes a draft with the fee quote it was created with.
    async fn publish_listing(&self, id: &str, fee_quote_fingerprint: Option<&str>) -> Result<Option<Receipt>, ApiError>;
    /// Saves a guest's listing as a draft intent owned by `guest`.
    async fn listing_draft_intent(&self, guest: &str, body: &serde_json::Value) -> Result<DraftIntent, ApiError>;
}

impl Listings for Caller<'_> {
    async fn ensure_listing_stock(&self, attempt: &str, body: &serde_json::Value) -> Result<ListingStock, ApiError> {
        let req = self
            .request(Method::POST, "/api/inventory/items/listing-stock/ensure", INVENTORY)
            .header(ATTEMPT_HEADER, attempt)
            .json(body);
        Ok(self.write(req).await?.0)
    }

    async fn create_listing(&self, body: &serde_json::Value) -> Result<(CreatedListing, Option<Receipt>), ApiError> {
        let req = self.request(Method::POST, "/api/marketplace/account/listings", MARKETPLACE).json(body);
        self.write(req).await
    }

    async fn publish_listing(&self, id: &str, fee_quote_fingerprint: Option<&str>) -> Result<Option<Receipt>, ApiError> {
        let body = serde_json::json!({ "feeQuoteFingerprint": fee_quote_fingerprint });
        let path = format!("/api/marketplace/account/listings/{}/publish", segment(id));
        let req = self.request(Method::POST, &path, MARKETPLACE).json(&body);
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn listing_draft_intent(&self, guest: &str, body: &serde_json::Value) -> Result<DraftIntent, ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/guest/listing-draft-intents", MARKETPLACE)
            .header(ANONYMOUS_LISTING_DRAFT_HEADER, guest)
            .json(body);
        Ok(self.write(req).await?.0)
    }
}

/// One of the seller's inventory items a listing can use (`MarketplaceListingInventoryItemOption`):
/// what the page shows of it, and the snapshot a create sends when Marketplace's supply read is
/// ahead of Inventory's (`inventorySnapshotFromMarketplaceSupplyItem`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SupplyItem {
    pub item_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: Option<String>,
    pub item_title: Option<String>,
    pub item_subtitle: Option<String>,
    #[serde(default)]
    pub selected_options: Vec<Selected>,
    pub graded_card: Option<serde_json::Value>,
    pub product_summary: Option<String>,
    /// `null` when the catalog has no shipping measure for the product: it cannot be published.
    pub product_measure_snapshot: Option<serde_json::Value>,
    pub storage_location_id: Option<String>,
    pub storage_location_name: Option<String>,
    pub ship_from_code: Option<String>,
    pub ship_from_address: Option<serde_json::Value>,
    #[serde(default)]
    pub total_quantity: u64,
    #[serde(default)]
    pub available_quantity: u64,
    pub acquisition_cost_amount: Option<String>,
}

impl SupplyItem {
    /// The inventory snapshot a create takes from this item.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "inventoryItemId": self.item_id,
            "catalogItemId": self.catalog_catalog_item_id,
            "productId": self.product_id,
            "selectedOptions": self.selected_options,
            "gradedCard": self.graded_card,
            "storageLocationId": self.storage_location_id,
            "storageLocationName": self.storage_location_name,
            "shipFromCode": self.ship_from_code,
            "shipFromAddress": self.ship_from_address,
            "totalQuantity": self.total_quantity,
            "availableQuantity": self.available_quantity,
            "acquisitionCostAmount": self.acquisition_cost_amount,
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SupplyItems {
    pub items: Vec<SupplyItem>,
}

/// What a listing at a price would cost the seller (`MarketplaceListingTermsPreview`), the fields
/// shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TermsPreview {
    pub account_type: String,
    /// The quote a price write sends back, so it is the one the seller saw.
    pub fee_quote_fingerprint: Option<String>,
    pub agreement_id: Option<String>,
    pub basis_amount: Option<String>,
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub shipping_allowance_percentage_bps: Option<u32>,
    pub schedule_id: Option<String>,
}

/// Whether an inventory item's listing has the evidence the active policy requires to publish
/// (`MarketplaceListingEvidenceReadiness`), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReadiness {
    pub ready: bool,
    pub requirements: Requirements,
    pub coverage: Coverage,
    #[serde(default)]
    pub next_actions: Vec<NextAction>,
    /// The photos buyers see, in order (a listing's read; a preview has none).
    #[serde(default)]
    pub public_gallery: Vec<GalleryImage>,
}

/// A photo buyers see (`MarketplaceListingPublicGalleryImage`): its sizes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryImage {
    pub photo_id: String,
    pub alt_text: Option<String>,
    #[serde(default)]
    pub assets: Vec<GalleryAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryAsset {
    /// `thumbnail`, `search-card` or `catalog-detail`.
    pub role: String,
    pub public_url: String,
    pub width: u32,
    pub height: u32,
    pub density: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirements {
    #[serde(default)]
    pub required_slots: Vec<RequiredSlot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredSlot {
    pub slot_id: String,
    pub minimum_width_pixels: Option<u32>,
    pub minimum_height_pixels: Option<u32>,
    /// The view a photo in the slot shows (`front`, `back`, `slab`).
    #[serde(default)]
    pub view_kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub complete: bool,
    /// Every unmet requirement's code, each once.
    #[serde(default)]
    pub unmet_codes: Vec<String>,
    #[serde(default)]
    pub slots: Vec<SlotCoverage>,
    pub active_photo_count: u32,
    pub minimum_photo_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotCoverage {
    pub slot_id: String,
    pub view_kind: String,
    pub satisfied: bool,
    pub unmet_code: Option<String>,
    /// The active photo that satisfies the slot.
    #[serde(default)]
    pub matched_photo_id: Option<String>,
}

/// What the seller does next for an unmet code; the page writes the code's words.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NextAction {
    pub code: String,
}

/// A catalog item the search suggests (`/api/marketplace/items/suggest`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub catalog_item_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub category: Option<String>,
}

#[derive(Deserialize)]
struct Suggestions {
    #[serde(default)]
    items: Vec<Suggestion>,
}

/// A catalog item as Inventory reads it (`/api/inventory/catalog-items/{id}`): its words, whether
/// it is active, and the product options a listing of it chooses.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogItem {
    pub catalog_item_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: String,
    pub product_schema: Option<Schema>,
}

/// A guest's listing draft an account claims (`MarketplaceAnonymousListingDraftIntent`): the form
/// it starts.
#[derive(Clone, Debug, Deserialize)]
pub struct ClaimedDraft {
    pub catalog_item_id: String,
    #[serde(default)]
    pub selected_options: Vec<Selected>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub quantity_cap: u64,
    pub max_units_per_order: Option<u64>,
    pub max_units_per_day: Option<u64>,
    pub max_units_per_customer_account: Option<u64>,
}

/// A photo a create sends.
pub struct Photo {
    pub filename: String,
    pub content_type: String,
    pub bytes: bytes::Bytes,
}

/// How long a create with photos may take: the API normalizes each one into six sizes.
const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Create listing's calls (marketplace's `account-listings-new` route): the seller's inventory
/// and Listing stock, a fee and evidence preview, the catalog search, a guest's draft, and the
/// create with its photos.
pub trait ListingCreate {
    /// The seller's inventory a listing can use, the first 100, or the one named.
    async fn supply_items(&self, item: Option<&str>) -> Result<Vec<SupplyItem>, ApiError>;
    /// Whether the seller has a supply location named `name` (the Listing stock).
    async fn has_location_named(&self, name: &str) -> Result<bool, ApiError>;
    async fn preview_terms(&self, price: &str) -> Result<TermsPreview, ApiError>;
    async fn evidence_readiness(&self, item: &str, price: &str) -> Result<EvidenceReadiness, ApiError>;
    async fn suggest(&self, words: &str) -> Result<Vec<Suggestion>, ApiError>;
    /// An active catalog item, or `None` (none by that id, or not active).
    async fn catalog_item(&self, id: &str) -> Result<Option<CatalogItem>, ApiError>;
    /// Claims a guest's draft for the signed-in account.
    async fn claim_draft(&self, guest: &str, intent: &str) -> Result<ClaimedDraft, ApiError>;
    /// Creates a listing, a draft, from `fields` (the API's multipart fields) and `photos`.
    async fn create_listing_with(
        &self,
        fields: &[(&str, String)],
        photos: &[Photo],
    ) -> Result<(CreatedListing, Option<Receipt>), ApiError>;
}

impl ListingCreate for Caller<'_> {
    async fn supply_items(&self, item: Option<&str>) -> Result<Vec<SupplyItem>, ApiError> {
        let query = match item {
            Some(id) => format!("inventoryItemId={}&limit=1&offset=0", segment(id)),
            None => "limit=100&offset=0".to_owned(),
        };
        let path = format!("/api/marketplace/account/listing-inventory?{query}");
        Ok(self.read::<SupplyItems>(&path, MARKETPLACE).await?.items)
    }

    async fn has_location_named(&self, name: &str) -> Result<bool, ApiError> {
        #[derive(Deserialize)]
        struct Exists {
            exists: bool,
        }
        let path = format!("/api/marketplace/account/supply-locations/exists?name={}", segment(name));
        Ok(self.read::<Exists>(&path, MARKETPLACE).await?.exists)
    }

    async fn preview_terms(&self, price: &str) -> Result<TermsPreview, ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/account/listings/preview", MARKETPLACE)
            .json(&serde_json::json!({ "priceAmount": price }));
        Ok(self.write(req).await?.0)
    }

    async fn evidence_readiness(&self, item: &str, price: &str) -> Result<EvidenceReadiness, ApiError> {
        let body = serde_json::json!({ "inventoryItemId": item, "priceAmount": if price.is_empty() { "0" } else { price } });
        let req =
            self.request(Method::POST, "/api/marketplace/account/listings/evidence-readiness/preview", MARKETPLACE).json(&body);
        Ok(self.write(req).await?.0)
    }

    async fn suggest(&self, words: &str) -> Result<Vec<Suggestion>, ApiError> {
        let path = format!("{ITEMS}/suggest?q={}", segment(words));
        Ok(self.read::<Suggestions>(&path, DISCOVERY).await?.items)
    }

    async fn catalog_item(&self, id: &str) -> Result<Option<CatalogItem>, ApiError> {
        let path = format!("/api/inventory/catalog-items/{}", segment(id));
        match self.read::<CatalogItem>(&path, INVENTORY).await {
            Ok(item) if item.catalog_item_id == id && item.status == "active" => Ok(Some(item)),
            Ok(_) => Ok(None),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn claim_draft(&self, guest: &str, intent: &str) -> Result<ClaimedDraft, ApiError> {
        let path = format!("/api/marketplace/account/listing-draft-intents/{}/claim", segment(intent));
        let req = self
            .request(Method::POST, &path, MARKETPLACE)
            .header(ANONYMOUS_LISTING_DRAFT_HEADER, guest)
            .json(&serde_json::json!({}));
        Ok(self.write(req).await?.0)
    }

    async fn create_listing_with(
        &self,
        fields: &[(&str, String)],
        photos: &[Photo],
    ) -> Result<(CreatedListing, Option<Receipt>), ApiError> {
        let mut form = reqwest::multipart::Form::new();
        for (name, value) in fields {
            form = form.text(name.to_string(), value.clone());
        }
        for photo in photos {
            let part = reqwest::multipart::Part::stream(photo.bytes.clone())
                .file_name(photo.filename.clone())
                .mime_str(&photo.content_type)?;
            form = form.part("evidence", part);
        }
        let req =
            self.request(Method::POST, "/api/marketplace/account/listings", MARKETPLACE).timeout(UPLOAD_TIMEOUT).multipart(form);
        self.write(req).await
    }
}

const NOTIFICATIONS: &str = "notifications";
const CENTER: &str = "/api/notifications/center";
const PREFERENCES: &str = "/api/notifications/preferences";
const PRODUCT_ALERTS: &str = "/api/marketplace/account/product-alerts";

/// The notification center's calls (`notifications/client.ts`), and the account's Product alerts,
/// which Discovery owns (its `/account/product-alerts` routes).
pub trait Notifications {
    /// The newest 25 web notifications, read ones too, as marketplace's loader reads them.
    async fn feed(&self) -> Result<Feed, ApiError>;
    /// Mark one read; the API answers with the feed after it.
    async fn mark_read(&self, delivery: &str) -> Result<Feed, ApiError>;
    /// Mark every one read; the API answers with the feed after it.
    async fn mark_all_read(&self) -> Result<Feed, ApiError>;
    async fn preferences(&self) -> Result<Vec<Preference>, ApiError>;
    /// Turn a delivery channel on or off; the API answers with it.
    async fn set_preference(&self, key: &str, enabled: bool) -> Result<Preference, ApiError>;
    async fn product_alerts(&self) -> Result<Vec<ProductAlert>, ApiError>;
    /// Pause, resume or delete an alert, with the write's receipt.
    async fn change_alert(&self, alert: &str, change: AlertChange) -> Result<Option<Receipt>, ApiError>;
}

/// The feed (`NotificationCenterFeedResponse`): its items and how many are unread in all.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Feed {
    pub items: Vec<FeedItem>,
    pub unread: u64,
}

/// A notification (`NotificationCenterFeedItem`), the fields shown.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedItem {
    pub delivery_id: String,
    pub message_type: String,
    pub title: String,
    pub body: String,
    pub action_href: Option<String>,
    pub read_at: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
struct FeedAfter {
    feed: Feed,
}

/// A delivery channel and whether it is on (`NotificationPreference`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Preference {
    pub key: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
struct Preferences {
    items: Vec<Preference>,
}

#[derive(Deserialize)]
struct PreferenceAfter {
    item: Preference,
}

/// A Product alert as the settings list it (`NotificationCenterProductAlert`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ProductAlert {
    pub alert_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    pub product_summary: Option<String>,
    /// `listing` or `offer`.
    pub market_side: String,
    pub threshold_amount: Option<String>,
    /// `active` or `paused`.
    pub status: String,
}

#[derive(Deserialize)]
struct AlertList {
    items: Vec<ProductAlert>,
}

/// What a Product alert's form asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertChange {
    Pause,
    Resume,
    Delete,
}

impl AlertChange {
    pub fn read(text: &str) -> Option<Self> {
        match text {
            "pause" => Some(AlertChange::Pause),
            "resume" => Some(AlertChange::Resume),
            "delete" => Some(AlertChange::Delete),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AlertChange::Pause => "pause",
            AlertChange::Resume => "resume",
            AlertChange::Delete => "delete",
        }
    }
}

impl Notifications for Caller<'_> {
    async fn feed(&self) -> Result<Feed, ApiError> {
        self.read(&format!("{CENTER}?limit=25&includeRead=true"), NOTIFICATIONS).await
    }

    async fn mark_read(&self, delivery: &str) -> Result<Feed, ApiError> {
        let req = self
            .request(Method::POST, &format!("{CENTER}/{}/read", segment(delivery)), NOTIFICATIONS)
            .json(&serde_json::json!({}));
        Ok(self.write::<FeedAfter>(req).await?.0.feed)
    }

    async fn mark_all_read(&self) -> Result<Feed, ApiError> {
        let req = self.request(Method::POST, &format!("{CENTER}/read-all"), NOTIFICATIONS).json(&serde_json::json!({}));
        Ok(self.write::<FeedAfter>(req).await?.0.feed)
    }

    async fn preferences(&self) -> Result<Vec<Preference>, ApiError> {
        Ok(self.read::<Preferences>(PREFERENCES, NOTIFICATIONS).await?.items)
    }

    async fn set_preference(&self, key: &str, enabled: bool) -> Result<Preference, ApiError> {
        let req = self
            .request(Method::POST, &format!("{PREFERENCES}/{}", segment(key)), NOTIFICATIONS)
            .json(&serde_json::json!({ "enabled": enabled }));
        Ok(self.write::<PreferenceAfter>(req).await?.0.item)
    }

    async fn product_alerts(&self) -> Result<Vec<ProductAlert>, ApiError> {
        Ok(self.read::<AlertList>(PRODUCT_ALERTS, DISCOVERY).await?.items)
    }

    async fn change_alert(&self, alert: &str, change: AlertChange) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{PRODUCT_ALERTS}/{}/{}", segment(alert), change.as_str());
        let req = self.request(Method::POST, &path, DISCOVERY).json(&serde_json::json!({}));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }
}

const ORDERING: &str = "ordering";
const PURCHASES: &str = "/api/marketplace/account/purchases";
const SALES: &str = "/api/marketplace/account/sales";

/// Which side of an order the account is on: its purchases, or its sales.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buyer,
    Seller,
}

impl Side {
    fn path(self) -> &'static str {
        match self {
            Side::Buyer => PURCHASES,
            Side::Seller => SALES,
        }
    }
}

/// The account's orders (Ordering's `account/purchases` and `account/sales`): a page of them.
pub trait Orders {
    /// The page `limit` long from `offset`, with how many there are and the summary of all.
    async fn orders(&self, side: Side, limit: u32, offset: u32) -> Result<OrderList, ApiError>;
    /// One order, as `side` sees it.
    async fn order(&self, side: Side, id: &str) -> Result<OrderDetail, ApiError>;
    /// Cancels the order; the answer's receipt is the cancellation's.
    async fn cancel_order(&self, side: Side, id: &str) -> Result<Option<Receipt>, ApiError>;
}

/// A page of orders (`ListResponse<PurchaseListItem>` with its `limit`, `offset` and `summary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderList {
    pub items: Vec<OrderCard>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
    pub summary: OrderSummary,
}

/// Every order's quantity and how many are pending (`OrderListSummary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderSummary {
    pub total_quantity: u64,
    pub pending_count: u64,
}

/// An order as the list shows it (`OrderingOrderProjection`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderCard {
    pub order_id: String,
    pub display_reference: String,
    pub status: String,
    pub created_at: String,
    pub total_quantity: u64,
    pub total_amount: String,
    pub seller_payout_amount: String,
    pub item_titles: Vec<String>,
}

/// An order as its page shows it (`PurchaseDetail` or `SaleDetail`, the fields shown). Each
/// side's API answers only that side's money; the page shows only the side's lines of it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderDetail {
    pub order_id: String,
    pub display_reference: String,
    pub source_type: String,
    pub source_reference_id: Option<String>,
    pub buyer_account_id: String,
    pub buyer_display_name: Option<String>,
    pub seller_account_id: String,
    pub seller_display_name: Option<String>,
    pub shipping_option: String,
    pub item_subtotal_amount: String,
    pub shipping_allowance_amount: String,
    pub protection_amount: Option<String>,
    pub shipping_charge_amount: String,
    pub sales_tax_amount: String,
    pub total_amount: String,
    pub marketplace_sales_fee_amount: String,
    pub seller_item_net_amount: String,
    pub seller_payout_amount: String,
    pub terms_schedule_id: Option<String>,
    pub terms_resolved_at: String,
    pub shipping_destination_snapshot: AddressSnapshot,
    pub status: String,
    pub payment_deadline_at: Option<String>,
    pub ready_for_fulfillment_at: Option<String>,
    pub self_service_cancellation_available: bool,
    /// `payment-pending`, `fulfillment-started` or `already-cancelled`.
    pub cancellation_unavailable_reason: Option<String>,
    pub lines: Vec<OrderLine>,
    pub inventory_holds: Vec<OrderHold>,
    pub money_timeline: Option<MoneyTimeline>,
    /// The buyer's: how many shipments there are and how many arrived.
    pub delivery_summary: Option<DeliverySummary>,
    #[serde(rename = "reviewOutcome")]
    pub review_outcome: Option<ReviewOutcome>,
}

/// Where an order ships (`AddressSnapshot`, the lines `AddressBlock` shows).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AddressSnapshot {
    pub name: Option<String>,
    pub company: Option<String>,
    pub line1: Option<String>,
    pub line2: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
}

/// An order's line (`OrderingOrderProjectionLine`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderLine {
    pub line_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub product_summary: Option<String>,
    pub unit_price_amount: String,
    pub quantity: u64,
    pub line_total_amount: String,
    /// The pictures the seller showed when the offer was accepted, the buyer's.
    pub listing_evidence_gallery: Vec<EvidenceImage>,
}

/// One of a line's evidence pictures (`MarketplaceListingPublicGalleryImage`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceImage {
    pub alt_text: Option<String>,
    pub assets: Vec<EvidenceAsset>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceAsset {
    pub role: String,
    pub public_url: String,
}

/// Stock held for the order (`OrderingOrderProjectionHold`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OrderHold {
    pub hold_id: String,
    pub quantity: u64,
    pub status: String,
}

/// What happened to the order's money after it was paid (`OrderingOrderMoneyTimeline`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct MoneyTimeline {
    pub refunds: Vec<Refund>,
    pub support_cases: Vec<SupportCase>,
    pub refunded_amount: String,
    pub currency_code: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Refund {
    pub refund_id: String,
    pub amount: Option<String>,
    pub currency_code: String,
    /// `requested`, `issued` or `failed`.
    pub status: String,
    pub requested_at: String,
    pub issued_at: Option<String>,
    pub failed_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SupportCase {
    pub support_request_id: String,
    pub status: String,
    pub active_hold: bool,
}

/// The buyer's shipments and how many arrived (`OrderingOrderDeliverySummary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct DeliverySummary {
    pub shipment_count: u64,
    pub delivered_count: u64,
    pub latest_delivered_at: Option<String>,
}

/// Whether the account may review the other side of the order (`OrderingOrderReviewOutcome`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReviewOutcome {
    /// `ready` or `unavailable`.
    pub status: String,
    pub opportunity: Option<ReviewOpportunity>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReviewOpportunity {
    pub order_id: String,
    /// The account the review is about, and its name when it has one.
    pub subject_account_id: String,
    pub subject_display_name: Option<String>,
    /// `buyer` or `seller`: who writes the review.
    pub author_role: String,
    pub active_review_id: Option<String>,
    pub active_review_revealed_at: Option<String>,
    /// `allowed`, `held` or `expired`.
    pub submission_state: String,
    pub window_expired: bool,
    pub revealed: bool,
}

impl Orders for Caller<'_> {
    async fn orders(&self, side: Side, limit: u32, offset: u32) -> Result<OrderList, ApiError> {
        self.read(&format!("{}?limit={limit}&offset={offset}", side.path()), ORDERING).await
    }

    async fn order(&self, side: Side, id: &str) -> Result<OrderDetail, ApiError> {
        self.read(&format!("{}/{}", side.path(), segment(id)), ORDERING).await
    }

    async fn cancel_order(&self, side: Side, id: &str) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{}/{}/cancel", side.path(), segment(id));
        let req = self.request(Method::POST, &path, ORDERING).json(&serde_json::json!({}));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }
}

const FULFILLMENT: &str = "fulfillment";

impl Side {
    /// The side's shipments (Fulfillment's `account/shipments` and `account/sales/shipments`).
    fn shipments(self) -> &'static str {
        match self {
            Side::Buyer => "/api/marketplace/account/shipments",
            Side::Seller => "/api/marketplace/account/sales/shipments",
        }
    }
}

/// The account's shipments (Fulfillment's `account/shipments` and `account/sales/shipments`).
pub trait Shipments {
    /// The first 100, as marketplace reads them (`limit=100&offset=0`).
    async fn shipments(&self, side: Side) -> Result<ShipmentList, ApiError>;
    /// One shipment, as `side` sees it.
    async fn shipment(&self, side: Side, id: &str) -> Result<ShipmentDetail, ApiError>;
    /// The seller's shipments `ids` as packing slips (`listSellerPackingSlips`); the API takes
    /// 1 to 100.
    async fn packing_slips(&self, ids: &[String]) -> Result<PackingSlipBatch, ApiError>;
}

impl Shipments for Caller<'_> {
    async fn shipments(&self, side: Side) -> Result<ShipmentList, ApiError> {
        self.read(&format!("{}?limit=100&offset=0", side.shipments()), FULFILLMENT).await
    }

    async fn shipment(&self, side: Side, id: &str) -> Result<ShipmentDetail, ApiError> {
        self.read(&format!("{}/{}", side.shipments(), segment(id)), FULFILLMENT).await
    }

    async fn packing_slips(&self, ids: &[String]) -> Result<PackingSlipBatch, ApiError> {
        let ids = segment(&ids.join(","));
        self.read(&format!("{}/packing-slips?shipmentIds={ids}", Side::Seller.shipments()), FULFILLMENT).await
    }
}

/// Packing slips (`FulfillmentPackingSlipBatch`): each a shipment's detail.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PackingSlipBatch {
    pub items: Vec<ShipmentDetail>,
}

/// The header that names a Fulfillment write's attempt (`Idempotency-Key`, a UUID v4): the API
/// applies an attempt once, answers a repeat with its first result, and says later what came of it.
const IDEMPOTENCY_KEY: &str = "idempotency-key";

/// The seller's packing commands on a shipment (Fulfillment's `account/sales/shipments/{id}/..`),
/// each sent as `attempt`.
pub trait Packing {
    /// Start packing: the shipment is locked from the buyer's changes.
    async fn start_packing(&self, id: &str, attempt: &str) -> Result<Option<Receipt>, ApiError>;
    /// How many of `line` are packed.
    async fn set_packed(&self, id: &str, line: &str, quantity: u64, attempt: &str) -> Result<Option<Receipt>, ApiError>;
    /// Record the package as packed, in `packages` packages.
    async fn pack(&self, id: &str, packages: u64, attempt: &str) -> Result<Option<Receipt>, ApiError>;
    /// What came of `attempt` on the shipment (`mutation-recovery`).
    async fn packing_attempt(&self, id: &str, attempt: &str) -> Result<PackingAttempt, ApiError>;
}

/// What the API knows of an attempt (`recoverShipmentMutation`): `succeeded`, `unchanged`,
/// `failed-safe` or `conflict` once it is settled, `confirming` when the API holds no record of it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PackingAttempt {
    pub status: String,
    pub command_kind: Option<String>,
}

impl PackingAttempt {
    /// Applied, or found already so (`succeeded`, `unchanged`).
    pub fn applied(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "unchanged")
    }

    /// Settled without applying anything (`failed-safe`, `conflict`).
    pub fn refused(&self) -> bool {
        matches!(self.status.as_str(), "failed-safe" | "conflict")
    }
}

impl Packing for Caller<'_> {
    async fn start_packing(&self, id: &str, attempt: &str) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{}/{}/packing/start", Side::Seller.shipments(), segment(id));
        let req = self.request(Method::POST, &path, FULFILLMENT).header(IDEMPOTENCY_KEY, attempt).json(&serde_json::json!({}));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn set_packed(&self, id: &str, line: &str, quantity: u64, attempt: &str) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{}/{}/packing/lines/{}", Side::Seller.shipments(), segment(id), segment(line));
        let req = self
            .request(Method::POST, &path, FULFILLMENT)
            .header(IDEMPOTENCY_KEY, attempt)
            .json(&serde_json::json!({ "confirmedQuantity": quantity }));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn pack(&self, id: &str, packages: u64, attempt: &str) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{}/{}/pack", Side::Seller.shipments(), segment(id));
        let req = self
            .request(Method::POST, &path, FULFILLMENT)
            .header(IDEMPOTENCY_KEY, attempt)
            .json(&serde_json::json!({ "packageCount": packages }));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn packing_attempt(&self, id: &str, attempt: &str) -> Result<PackingAttempt, ApiError> {
        let path = format!("{}/{}/mutation-recovery", Side::Seller.shipments(), segment(id));
        let req = self.request(Method::GET, &path, FULFILLMENT).header(IDEMPOTENCY_KEY, attempt);
        Ok(self.write(req).await?.0)
    }
}

/// A page of shipments (`ListResponse<FulfillmentShipmentListItem>`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShipmentList {
    pub items: Vec<ShipmentCard>,
}

/// A shipment as the list shows it (`FulfillmentShipmentListItem`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShipmentCard {
    pub shipment_id: String,
    pub display_reference: String,
    pub tracking_identifier: Option<String>,
    pub status: String,
    pub total_quantity: u64,
    pub line_count: u64,
}

/// A shipment (`FulfillmentShipmentDetail`, the fields the page shows).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShipmentDetail {
    pub shipment_id: String,
    pub order_id: String,
    pub buyer_account_id: String,
    pub buyer_display_name: Option<String>,
    pub seller_account_id: String,
    pub seller_display_name: Option<String>,
    pub display_reference: String,
    pub status: String,
    pub package_status: String,
    pub package_count: Option<u64>,
    pub tracking_identifier: Option<String>,
    pub carrier_name: Option<String>,
    pub shipping_option: String,
    pub shipping_method: Option<String>,
    pub postage_service_level: Option<String>,
    pub postage_provider_name: Option<String>,
    pub postage_provider_mode: Option<String>,
    pub postage_amount_cents: Option<i64>,
    pub postage_currency: Option<String>,
    pub label_status: String,
    pub label_reference: Option<String>,
    pub label_document_url: Option<String>,
    pub label_error_code: Option<String>,
    pub label_error_message: Option<String>,
    pub label_refund_status: Option<String>,
    pub label_refund_reference: Option<String>,
    pub delivered_at: Option<String>,
    /// When packing started (the packing page's lock), and when the shipment last changed.
    pub packing_started_at: Option<String>,
    pub updated_at: String,
    pub total_quantity: u64,
    pub line_count: u64,
    /// Where it goes (the packing page's Ship to), and where from (the packing slip's Ship from).
    pub shipping_destination_snapshot: Option<AddressSnapshot>,
    pub shipping_origin_snapshot: Option<AddressSnapshot>,
    pub shipping_plan_snapshot: Option<PackagePlanSnapshot>,
    pub lines: Vec<ShipmentLine>,
    pub exceptions: Vec<ShipmentException>,
    pub postage_label_operations: Vec<PostageOperation>,
    pub postage_provider_events: Vec<PostageProviderEvent>,
}

/// The order's package plan, the part the page shows (`PackagePlan`): its postage policy.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PackagePlanSnapshot {
    pub postage_policy_snapshot: Option<PostagePolicySnapshot>,
}

/// What the postage policy required when the order was placed.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PostagePolicySnapshot {
    pub policy_version: String,
    pub parcel_required: bool,
    pub parcel_reasons: Vec<String>,
    pub signature_required: bool,
    pub signature_reasons: Vec<String>,
    pub insurance_required: bool,
    pub insurance_reasons: Vec<String>,
    pub insured_value_amount: Option<String>,
    pub shipping_evidence_tier: String,
}

/// A line of the shipment (`FulfillmentShipmentLine`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShipmentLine {
    pub line_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub product_summary: Option<String>,
    pub quantity: u64,
    /// The references a packer scans (the packing page).
    pub order_line_id: String,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    /// How many are packed: the count when there is one, else all once the line was confirmed.
    pub packing_confirmed_quantity: Option<u64>,
    pub packing_confirmed_at: Option<String>,
}

impl ShipmentLine {
    /// How many are packed (`packedQuantity`).
    pub fn packed(&self) -> u64 {
        self.packing_confirmed_quantity.unwrap_or(if self.packing_confirmed_at.is_some() { self.quantity } else { 0 })
    }
}

/// An exception raised on the shipment.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShipmentException {
    pub raised_at: String,
    pub exception_type: String,
    pub notes: Option<String>,
}

/// A postage label operation, for the seller's diagnostics
/// (`FulfillmentPostageLabelOperationDiagnostic`, the fields shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PostageOperation {
    pub operation_key: String,
    pub operation_kind: String,
    pub status: String,
    pub requested_service_level: Option<String>,
    pub requested_delivery_confirmation: Option<String>,
    pub requested_insurance_amount: Option<String>,
    pub requested_mailpiece_class: Option<String>,
    pub policy_version: Option<String>,
    pub parcel_required: Option<String>,
    pub signature_required: Option<String>,
    pub insurance_required: Option<String>,
    pub insured_value_amount: Option<String>,
    pub shipping_evidence_tier: Option<String>,
    pub address_override_changed_side: Option<String>,
    pub address_override_reason: Option<String>,
    pub error_message: Option<String>,
}

/// An event the postage provider sent (`FulfillmentPostageProviderEventDiagnostic`, the fields
/// shown).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PostageProviderEvent {
    pub provider_event_id: String,
    pub provider_name: String,
    pub provider_mode: String,
    pub event_kind: String,
    pub status: String,
    pub tracking_identifier: Option<String>,
    pub processing_result: Option<String>,
    pub status_detail: Option<String>,
}

const IDENTITY: &str = "identity";
/// Identity's lookup of an account-management attempt (`GET ..?action=&target=`, the attempt as
/// `Idempotency-Key`), which always answers 200 with an `outcome`.
const ACCOUNT_ATTEMPTS: &str = "/api/identity/account-management/attempts";

/// A saved shipping address (Identity's `ShippingAddress`, the fields the page shows and edits).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ShippingAddress {
    pub shipping_address_id: String,
    pub label: Option<String>,
    pub recipient_name: String,
    pub company: Option<String>,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub is_default: bool,
}

#[derive(Deserialize)]
struct ShippingAddressList {
    #[serde(default)]
    items: Vec<ShippingAddress>,
}

/// What a create or an update sends (marketplace's `addressBody`): optional text trimmed or
/// `null`, required text trimmed, an empty country `US`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressCommand {
    pub label: Option<String>,
    pub name: String,
    pub company: Option<String>,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub make_default: bool,
    /// The choice the seller made between the address and the one the API suggested
    /// (`accept-suggested`, `keep-original`).
    pub address_verification_decision: Option<String>,
}

/// An address the API suggests instead of the one sent (`ShippingAddressSnapshot`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SuggestedAddress {
    pub name: String,
    pub company: Option<String>,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

/// An Identity account-management write the pilot sends (`MutationAction`): the address book's
/// four, the account's profile, the security page's user profile and API key writes, the team
/// page's invitation and membership writes, and a consent's withdrawal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, corten::UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum AccountAction {
    Create,
    Update,
    Default,
    Archive,
    UpdateProfile,
    UpdateUser,
    CreateApiKey,
    RotateApiKey,
    RevokeApiKey,
    CreateInvitation,
    CancelInvitation,
    ChangeRole,
    /// A membership's revoke.
    Revoke,
    Reinstate,
    /// A consent's withdrawal.
    Withdraw,
}

impl AccountAction {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountAction::Create => "create",
            AccountAction::Update => "update",
            AccountAction::Default => "default",
            AccountAction::Archive => "archive",
            AccountAction::UpdateProfile => "update-profile",
            AccountAction::UpdateUser => "update-user",
            AccountAction::CreateApiKey => "create-api-key",
            AccountAction::RotateApiKey => "rotate-api-key",
            AccountAction::RevokeApiKey => "revoke-api-key",
            AccountAction::CreateInvitation => "create-invitation",
            AccountAction::CancelInvitation => "cancel-invitation",
            AccountAction::ChangeRole => "change-role",
            AccountAction::Revoke => "revoke",
            AccountAction::Reinstate => "reinstate",
            AccountAction::Withdraw => "withdraw",
        }
    }
}

/// What Identity answered about an account-management attempt (`MutationResult`).
#[derive(Clone, Debug, PartialEq)]
pub enum AccountAnswer {
    /// Recorded, now or before: the receipt the page waits for (from the headers, or the lookup's
    /// `destination`).
    Committed(Option<String>),
    /// Nothing was recorded, for `code`: `validation-failed` (with the field a required-field
    /// refusal names), `address-standardization-suggested` (with the address), and the rest.
    NotRecorded { code: String, field: Option<String>, suggested: Option<Box<SuggestedAddress>> },
    /// The address book changed under the write (`owner-state-conflict`, `attempt-hash-conflict`, ..).
    Conflict,
    /// The API cannot say what came of it.
    Indeterminate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerBody {
    outcome: Option<String>,
    code: Option<String>,
    destination: Option<String>,
    suggested_address: Option<SuggestedAddress>,
    error: Option<AnswerError>,
}

#[derive(Deserialize)]
struct AnswerError {
    code: Option<String>,
    #[serde(default)]
    details: Vec<AnswerDetail>,
}

#[derive(Deserialize)]
struct AnswerDetail {
    field: Option<String>,
}

/// The `afterWrite` a lookup's `destination` carries (`/account/shipping-addresses?afterWrite=..`,
/// the receipt's JSON encoded twice), as the page's `after_write`.
fn after_write_of(destination: &str) -> Option<String> {
    let (_, query) = destination.split_once('?')?;
    let value = query.split('&').find_map(|pair| pair.strip_prefix("afterWrite="))?;
    let once = percent_encoding::percent_decode_str(value).decode_utf8().ok()?;
    let twice = percent_encoding::percent_decode_str(&once).decode_utf8().ok()?;
    Receipt::from_param(Some(&twice)).map(|r| r.param())
}

impl AccountAnswer {
    /// The answer `status` and `body` say; an error the page handles itself (sign in, forbidden,
    /// anything else) is `Err`.
    fn read(status: u16, body: &str, receipt: Option<Receipt>) -> Result<Self, ApiError> {
        let parsed: Option<AnswerBody> = serde_json::from_str(body).ok();
        let outcome = parsed.as_ref().and_then(|b| b.outcome.as_deref());
        let code = parsed.as_ref().and_then(|b| b.code.clone()).unwrap_or_default();
        match (status, outcome) {
            (200, Some("committed")) => {
                let from_destination = parsed.as_ref().and_then(|b| b.destination.as_deref()).and_then(after_write_of);
                Ok(AccountAnswer::Committed(receipt.map(|r| r.param()).or(from_destination)))
            }
            (200 | 400, Some("not-recorded")) => Ok(AccountAnswer::NotRecorded {
                code,
                field: None,
                suggested: parsed.and_then(|b| b.suggested_address).map(Box::new),
            }),
            (200 | 409, Some("conflict")) => Ok(AccountAnswer::Conflict),
            (_, Some("indeterminate")) | (500..=599, _) => Ok(AccountAnswer::Indeterminate),
            (400, None) => {
                let error = parsed.and_then(|b| b.error);
                match error {
                    Some(AnswerError { code: Some(c), details }) if c == "validation_failed" => Ok(AccountAnswer::NotRecorded {
                        code: "validation-failed".into(),
                        field: details.into_iter().find_map(|d| d.field),
                        suggested: None,
                    }),
                    error => Err(ApiError::Status {
                        status: StatusCode::BAD_REQUEST,
                        code: error.and_then(|e| e.code),
                        message: String::new(),
                    }),
                }
            }
            (200, _) => Ok(AccountAnswer::Indeterminate),
            _ => {
                let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
                Err(ApiError::Status { status, code: Some(code).filter(|c| !c.is_empty()), message: String::new() })
            }
        }
    }
}

/// The account's shipping addresses (Identity's `accounts/{account}/shipping-addresses`), as the
/// signed-in member. Each write is an account-management attempt: the form's `SubmitKey` as
/// `Idempotency-Key`, applied once and answered again with its first result.
pub trait Addresses {
    /// The account's active addresses.
    async fn shipping_addresses(&self, account: &str) -> Result<Vec<ShippingAddress>, ApiError>;
    /// Send `action` on `target` (`None` for a create) as `attempt`, with the address for a
    /// create or an update. A call with no answer is `Err(ApiError::Transport)`.
    async fn write_address(
        &self,
        account: &str,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        command: Option<&AddressCommand>,
    ) -> Result<AccountAnswer, ApiError>;
    /// What came of `attempt` (Identity's attempt lookup), for any account-management action.
    async fn account_attempt(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
    ) -> Result<AccountAnswer, ApiError>;
}

impl Addresses for Caller<'_> {
    async fn shipping_addresses(&self, account: &str) -> Result<Vec<ShippingAddress>, ApiError> {
        let list: ShippingAddressList =
            self.read(&format!("/api/identity/accounts/{}/shipping-addresses", segment(account)), IDENTITY).await?;
        Ok(list.items)
    }

    async fn write_address(
        &self,
        account: &str,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        command: Option<&AddressCommand>,
    ) -> Result<AccountAnswer, ApiError> {
        let book = format!("/api/identity/accounts/{}/shipping-addresses", segment(account));
        let target = target.map(segment).unwrap_or_default();
        let (method, path) = match action {
            AccountAction::Create => (Method::POST, book),
            AccountAction::Update => (Method::PUT, format!("{book}/{target}")),
            AccountAction::Default => (Method::POST, format!("{book}/{target}/default")),
            AccountAction::Archive => (Method::POST, format!("{book}/{target}/archive")),
            AccountAction::UpdateProfile
            | AccountAction::UpdateUser
            | AccountAction::CreateApiKey
            | AccountAction::RotateApiKey
            | AccountAction::RevokeApiKey
            | AccountAction::CreateInvitation
            | AccountAction::CancelInvitation
            | AccountAction::ChangeRole
            | AccountAction::Revoke
            | AccountAction::Reinstate
            | AccountAction::Withdraw => {
                unreachable!("not in the address book: AccountCalls::update_profile, SecurityCalls, TeamCalls, ConsentCalls")
            }
        };
        let req = self.request(method, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt);
        let req = match command {
            Some(command) => req.json(command),
            None => req.json(&serde_json::json!({})),
        };
        let res = req.send().await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let body = res.text().await?;
        AccountAnswer::read(status, &body, receipt)
    }

    async fn account_attempt(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
    ) -> Result<AccountAnswer, ApiError> {
        let mut path = format!("{ACCOUNT_ATTEMPTS}?action={}", action.as_str());
        if let Some(target) = target {
            path.push_str(&format!("&target={}", segment(target)));
        }
        let res = self.request(Method::GET, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).send().await?;
        let status = res.status().as_u16();
        let body = res.text().await?;
        AccountAnswer::read(status, &body, None)
    }
}

/// An account (Identity's `Account`), the fields the account page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AccountProfile {
    pub account_id: String,
    pub name: String,
    pub display_name: String,
    pub account_type: String,
    pub status: String,
    pub badges: Vec<String>,
    pub founder_number: Option<u32>,
    /// Empty for the fallback the page builds from the actor (`buildActorAccountFallback`).
    pub updated_at: String,
}

/// Who is signed in, as Identity shows them (`CurrentActorDisplay`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ActorDisplay {
    pub account: ActorAccount,
    pub membership: ActorMembership,
    pub user: ActorUser,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ActorAccount {
    pub account_id: String,
    pub display_name: Option<String>,
    pub name: Option<String>,
    pub badges: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ActorMembership {
    pub membership_id: String,
    pub role_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ActorUser {
    pub user_id: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
}

/// What a profile update sends (the `update-profile` action's two fields, as marketplace sends
/// them: the form's text as it is; Identity trims it).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCommand {
    pub name: String,
    pub display_name: String,
}

/// The signed-in account's own page (Identity's `accounts/{account}` and
/// `current-actor-display`), and its profile write, an account-management attempt like the
/// address book's.
pub trait AccountCalls {
    async fn account(&self, account: &str) -> Result<AccountProfile, ApiError>;
    async fn actor_display(&self) -> Result<ActorDisplay, ApiError>;
    /// Send the profile as `attempt`. A call with no answer is `Err(ApiError::Transport)`.
    async fn update_profile(&self, account: &str, attempt: &str, command: &ProfileCommand) -> Result<AccountAnswer, ApiError>;
}

impl AccountCalls for Caller<'_> {
    async fn account(&self, account: &str) -> Result<AccountProfile, ApiError> {
        self.read(&format!("/api/identity/accounts/{}", segment(account)), IDENTITY).await
    }

    async fn actor_display(&self) -> Result<ActorDisplay, ApiError> {
        self.read("/api/identity/current-actor-display", IDENTITY).await
    }

    async fn update_profile(&self, account: &str, attempt: &str, command: &ProfileCommand) -> Result<AccountAnswer, ApiError> {
        let path = format!("/api/identity/accounts/{}", segment(account));
        let res = self.request(Method::PUT, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).json(command).send().await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let body = res.text().await?;
        AccountAnswer::read(status, &body, receipt)
    }
}

/// The signed-in user (Identity's `User`), the fields the security page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SecurityUser {
    pub user_id: String,
    pub display_name: String,
    pub given_name: String,
    pub family_name: String,
    pub auth_methods: Vec<String>,
    pub updated_at: String,
}

/// A member of an account (Identity's `Membership`), the fields the team page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Membership {
    pub membership_id: String,
    pub user_id: String,
    pub user_display_name: Option<String>,
    pub user_primary_email: Option<String>,
    pub account_id: String,
    pub account_display_name: Option<String>,
    pub account_name: Option<String>,
    pub role_key: String,
    pub status: String,
}

/// An invitation to an account (Identity's `Invitation`), the fields the team page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Invitation {
    pub invitation_id: String,
    pub email: String,
    pub account_id: String,
    pub account_display_name: Option<String>,
    pub account_name: Option<String>,
    pub role_key: String,
    pub status: String,
}

#[derive(Deserialize)]
struct TeamList<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
}

/// A committed create-invitation's answer: the invitation it recorded, and whether this call
/// recorded it (`false` for an attempt the API had already recorded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invited {
    pub invitation_id: String,
    pub newly: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommittedBody {
    #[serde(default)]
    newly_committed: bool,
    receipt: Option<CommittedReceipt>,
    current: Option<CommittedOwner>,
}

#[derive(Deserialize)]
struct CommittedReceipt {
    result: Option<CommittedOwner>,
}

#[derive(Deserialize)]
struct CommittedOwner {
    id: Option<String>,
}

/// The account's team (Identity's `memberships` and `invitations`), as the signed-in member. Each
/// write is an account-management attempt, as the address book's are.
pub trait TeamCalls {
    /// The account's members and invitations. Workaround for chase-sets/chase-sets#10704: Identity
    /// scopes these lists by a substring match on the account's id, so only the rows whose
    /// `account_id` is `account` are kept.
    async fn team(&self, account: &str) -> Result<(Vec<Membership>, Vec<Invitation>), ApiError>;
    /// Send `action` on `target` as `attempt` with `body` (a create's fields, or a role); with
    /// the invitation a committed create recorded.
    async fn write_team(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        body: &serde_json::Value,
    ) -> Result<(AccountAnswer, Option<Invited>), ApiError>;
    /// Ask Auth to email a new invitation's acceptance link, after the receipt the caller carries,
    /// from the browser's address (Auth limits these by address, as it does sign-ins).
    async fn invitation_link(&self, invitation: &str, client: Option<corten::ClientIp>) -> Result<(), ApiError>;
}

impl TeamCalls for Caller<'_> {
    async fn team(&self, account: &str) -> Result<(Vec<Membership>, Vec<Invitation>), ApiError> {
        let scope = segment(account);
        let (members_at, invitations_at) =
            (format!("/api/identity/memberships?search={scope}"), format!("/api/identity/invitations?search={scope}"));
        let (members, invitations) = tokio::join!(
            self.read::<TeamList<Membership>>(&members_at, IDENTITY),
            self.read::<TeamList<Invitation>>(&invitations_at, IDENTITY),
        );
        let members = members?.items.into_iter().filter(|m| m.account_id == account).collect();
        let invitations = invitations?.items.into_iter().filter(|i| i.account_id == account).collect();
        Ok((members, invitations))
    }

    async fn write_team(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        body: &serde_json::Value,
    ) -> Result<(AccountAnswer, Option<Invited>), ApiError> {
        let id = target.map(segment).unwrap_or_default();
        let (method, path) = match action {
            AccountAction::CreateInvitation => (Method::POST, "/api/identity/invitations".to_owned()),
            AccountAction::CancelInvitation => (Method::POST, format!("/api/identity/invitations/{id}/cancel")),
            AccountAction::ChangeRole => (Method::PUT, format!("/api/identity/memberships/{id}/role")),
            AccountAction::Revoke => (Method::POST, format!("/api/identity/memberships/{id}/revoke")),
            AccountAction::Reinstate => (Method::POST, format!("/api/identity/memberships/{id}/reinstate")),
            _ => unreachable!("not a team write: {}", action.as_str()),
        };
        let res = self.request(method, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).json(body).send().await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let text = res.text().await?;
        let answer = AccountAnswer::read(status, &text, receipt)?;
        let invited = match (&answer, action) {
            (AccountAnswer::Committed(_), AccountAction::CreateInvitation) => invited(&text),
            _ => None,
        };
        Ok((answer, invited))
    }

    async fn invitation_link(&self, invitation: &str, client: Option<corten::ClientIp>) -> Result<(), ApiError> {
        let landing = format!("/invite/{}", segment(invitation));
        let body = serde_json::json!({ "invitationId": invitation, "landingPath": landing });
        let mut req = self.request(Method::POST, "/api/auth/invitations/acceptance-link/request", AUTH).json(&body);
        if let Some(corten::ClientIp(ip)) = client {
            req = req.header("x-forwarded-for", ip.to_string());
        }
        self.write::<serde_json::Value>(req).await.map(|_| ())
    }
}

/// An account's ratings as a seller and as a buyer (Reputation's `ReviewSummary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReviewSummary {
    pub account_id: String,
    pub account_display_name: Option<String>,
    pub average_rating_as_seller: Option<String>,
    pub review_count_as_seller: u64,
    pub rating_count_as_seller: u64,
    pub rating_1_count_as_seller: u64,
    pub rating_2_count_as_seller: u64,
    pub rating_3_count_as_seller: u64,
    pub rating_4_count_as_seller: u64,
    pub rating_5_count_as_seller: u64,
    pub average_rating_as_buyer: Option<String>,
    pub review_count_as_buyer: u64,
    pub rating_count_as_buyer: u64,
    pub rating_1_count_as_buyer: u64,
    pub rating_2_count_as_buyer: u64,
    pub rating_3_count_as_buyer: u64,
    pub rating_4_count_as_buyer: u64,
    pub rating_5_count_as_buyer: u64,
}

/// A review on the account's review pages (Reputation's `ReviewListItem`), the fields they show.
/// `rating` and `feedback` are none while a received review is not revealed yet (double blind).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReviewItem {
    pub review_id: String,
    pub order_id: String,
    pub author_account_id: String,
    pub author_display_name: Option<String>,
    pub subject_account_id: String,
    pub subject_display_name: Option<String>,
    pub author_role: String,
    pub rating: Option<u8>,
    pub feedback: Option<String>,
    pub status: String,
    pub revealed_at: Option<String>,
    pub held: bool,
    pub withdrawn_by_actor_type: Option<String>,
    pub feedback_redacted_at: Option<String>,
    pub reply_id: Option<String>,
    pub reply_feedback: Option<String>,
    pub reply_status: Option<String>,
    pub scoring_disposition: Option<String>,
    pub disposition_reason_code: Option<String>,
    pub resolution_context: Option<String>,
    pub remedy_kind: Option<String>,
}

impl ReviewItem {
    /// Whether it may be reported: active, revealed and not held.
    pub fn reportable(&self) -> bool {
        self.status == "active" && self.revealed_at.is_some() && !self.held
    }

    /// The account's reply, while the review and the reply are both shown.
    pub fn reply(&self) -> Option<&str> {
        self.reply_feedback.as_deref().filter(|_| self.reportable() && self.reply_status.as_deref() == Some("active"))
    }
}

/// The account's reviews (Reputation's `/api/marketplace/reviews` reads), as the account signed in.
pub trait ReviewCalls {
    /// The account's ratings (`GET /accounts/{id}/review-summary`).
    async fn review_summary(&self, account: &str) -> Result<ReviewSummary, ApiError>;
    /// Its ten newest revealed reviews (`GET /accounts/{id}/reviews`), as the summary shows them.
    async fn account_reviews(&self, account: &str) -> Result<Vec<ReviewItem>, ApiError>;
    /// The reviews others left the account (`received`) or it left (`written`), the first 100, in
    /// one role or both.
    async fn review_list(&self, which: &str, role: Option<&str>) -> Result<Vec<ReviewItem>, ApiError>;
    /// A review the account wrote or received (`GET /reviews/{id}`).
    async fn review(&self, review: &str) -> Result<ReviewItem, ApiError>;
    /// The account's one public response to a review it received (`POST /reviews/{id}/reply`). The
    /// answer is the write's receipt.
    async fn reply_to_review(&self, review: &str, feedback: &str) -> Result<Option<Receipt>, ApiError>;
    /// Whether the account may review the other side of `order`
    /// (`GET /reviews/opportunities/orders/{id}`); `None` when it has no such order.
    async fn review_opportunity(&self, order: &str) -> Result<Option<ReviewOpportunity>, ApiError>;
    /// Submit a review of the order's other side (`POST /reviews`): the review's id and the
    /// write's receipt.
    async fn submit_review(
        &self,
        order: &str,
        subject: &str,
        rating: i64,
        feedback: &str,
    ) -> Result<(String, Option<Receipt>), ApiError>;
}

impl ReviewCalls for Caller<'_> {
    async fn review_summary(&self, account: &str) -> Result<ReviewSummary, ApiError> {
        self.read(&format!("/api/marketplace/accounts/{}/review-summary", segment(account)), MARKETPLACE).await
    }

    async fn account_reviews(&self, account: &str) -> Result<Vec<ReviewItem>, ApiError> {
        let path = format!("/api/marketplace/accounts/{}/reviews?limit=10&offset=0", segment(account));
        Ok(self.read::<TeamList<ReviewItem>>(&path, MARKETPLACE).await?.items)
    }

    async fn review_list(&self, which: &str, role: Option<&str>) -> Result<Vec<ReviewItem>, ApiError> {
        let mut path = format!("/api/marketplace/reviews/{which}?limit=100&offset=0");
        if let Some(role) = role {
            path.push_str(&format!("&role={}", segment(role)));
        }
        Ok(self.read::<TeamList<ReviewItem>>(&path, MARKETPLACE).await?.items)
    }

    async fn review(&self, review: &str) -> Result<ReviewItem, ApiError> {
        self.read(&format!("/api/marketplace/reviews/{}", segment(review)), MARKETPLACE).await
    }

    async fn reply_to_review(&self, review: &str, feedback: &str) -> Result<Option<Receipt>, ApiError> {
        let path = format!("/api/marketplace/reviews/{}/reply", segment(review));
        let req = self.request(Method::POST, &path, MARKETPLACE).json(&serde_json::json!({ "feedback": feedback }));
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }

    async fn review_opportunity(&self, order: &str) -> Result<Option<ReviewOpportunity>, ApiError> {
        let path = format!("/api/marketplace/reviews/opportunities/orders/{}", segment(order));
        match self.read(&path, MARKETPLACE).await {
            Ok(opportunity) => Ok(Some(opportunity)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn submit_review(
        &self,
        order: &str,
        subject: &str,
        rating: i64,
        feedback: &str,
    ) -> Result<(String, Option<Receipt>), ApiError> {
        #[derive(Deserialize)]
        struct Submitted {
            id: String,
        }
        let body = serde_json::json!({ "orderId": order, "subjectAccountId": subject, "rating": rating, "feedback": feedback });
        let req = self.request(Method::POST, "/api/marketplace/reviews", MARKETPLACE).json(&body);
        let (submitted, receipt) = self.write::<Submitted>(req).await?;
        Ok((submitted.id, receipt))
    }
}

/// A consent the user or its account gave (Identity's `Consent`), the fields the history shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Consent {
    pub consent_id: String,
    pub subject_type: String,
    pub user_id: Option<String>,
    pub account_id: Option<String>,
    pub policy_key: String,
    pub policy_version: String,
    pub status: String,
    pub recorded_at: String,
    pub withdrawn_at: Option<String>,
    pub updated_at: String,
    pub is_current: bool,
}

impl Consent {
    /// Whether the consent is the user's own: a user consent of `user`, or an account consent
    /// `user` gave for `account` (Identity's withdraw rule, `subjectMatchesActor`).
    pub fn is_of(&self, user: &str, account: &str) -> bool {
        let by_user = self.user_id.as_deref() == Some(user);
        match self.subject_type.as_str() {
            "user" => by_user,
            "account" => by_user && self.account_id.as_deref() == Some(account),
            _ => false,
        }
    }
}

/// The user's consent history (Identity's `consents`), as the signed-in user. A withdrawal is an
/// account-management attempt, as the address book's writes are.
pub trait ConsentCalls {
    /// The user's consents for the account, newest first, as marketplace's loader asks (the first
    /// 50). Workaround for chase-sets/chase-sets#10707: Identity takes the user and account from the
    /// query for an actor with `security.manage`, so only the user's own consents are kept.
    async fn consents(&self, user: &str, account: &str) -> Result<Vec<Consent>, ApiError>;
    /// Withdraw `consent` as `attempt`.
    async fn withdraw_consent(&self, consent: &str, attempt: &str) -> Result<AccountAnswer, ApiError>;
}

impl ConsentCalls for Caller<'_> {
    async fn consents(&self, user: &str, account: &str) -> Result<Vec<Consent>, ApiError> {
        let path = format!("/api/identity/consents?limit=50&offset=0&userId={}&accountId={}", segment(user), segment(account));
        let list: TeamList<Consent> = self.read(&path, IDENTITY).await?;
        Ok(list.items.into_iter().filter(|c| c.is_of(user, account)).collect())
    }

    async fn withdraw_consent(&self, consent: &str, attempt: &str) -> Result<AccountAnswer, ApiError> {
        let path = format!("/api/identity/consents/{}/withdraw", segment(consent));
        let res = self
            .request(Method::POST, &path, IDENTITY)
            .header(IDEMPOTENCY_KEY, attempt)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let text = res.text().await?;
        AccountAnswer::read(status, &text, receipt)
    }
}

/// The invitation a committed create's body names (`receipt.result.id`, else `current.id`).
fn invited(body: &str) -> Option<Invited> {
    let parsed: CommittedBody = serde_json::from_str(body).ok()?;
    let id = parsed.receipt.and_then(|r| r.result).and_then(|o| o.id).or_else(|| parsed.current.and_then(|o| o.id))?;
    Some(Invited { invitation_id: id, newly: parsed.newly_committed })
}

/// An API key (Identity's `ApiKey`), never its secret.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ApiKey {
    pub api_key_id: String,
    pub user_id: String,
    pub name: String,
    pub key_prefix: String,
    pub status: String,
    pub last_used_at: Option<String>,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct ApiKeyList {
    #[serde(default)]
    items: Vec<ApiKey>,
}

/// What a user profile update sends (the `update-user` action's three fields, as typed).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCommand {
    pub display_name: String,
    pub given_name: String,
    pub family_name: String,
}

/// What a key's create or rotate said about its secret. The secret is in this answer only: the
/// API keeps its hash, and its attempt lookup never returns it.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum KeySecret {
    /// Nothing to show (any other write, or no secret in the answer).
    #[default]
    None,
    /// The new secret of `key`, this once.
    Issued { key: String, secret: String },
    /// The write was recorded before (a repeated attempt): its secret cannot be shown again.
    Unrecoverable,
}

/// Never the secret, so a log line cannot carry it.
impl std::fmt::Debug for KeySecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeySecret::None => f.write_str("None"),
            KeySecret::Issued { key, .. } => f.debug_struct("Issued").field("key", key).finish_non_exhaustive(),
            KeySecret::Unrecoverable => f.write_str("Unrecoverable"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretBody {
    newly_committed: Option<bool>,
    secret: Option<String>,
    secret_state: Option<String>,
    current: Option<SecretOwner>,
}

#[derive(Deserialize)]
struct SecretOwner {
    id: Option<String>,
}

/// The longest secret marketplace takes (`validateCommittedResult`).
const SECRET_MAX: usize = 200;

/// `answer` and the secret its `body` carries, as marketplace's `clientResult` reads them: a
/// secret only on a newly committed create or rotate, at most 200 characters, with the key's id;
/// anything else carrying one cannot be trusted, and is `Indeterminate`. A lookup (`lookup`)
/// never carries the secret, so one that does is `Indeterminate` too.
fn key_secret(action: AccountAction, answer: AccountAnswer, body: &str, lookup: bool) -> (AccountAnswer, KeySecret) {
    if !matches!(answer, AccountAnswer::Committed(_)) {
        return (answer, KeySecret::None);
    }
    let Ok(body) = serde_json::from_str::<SecretBody>(body) else { return (answer, KeySecret::None) };
    let issues = matches!(action, AccountAction::CreateApiKey | AccountAction::RotateApiKey);
    match (body.secret, body.secret_state.as_deref()) {
        (Some(secret), None)
            if !lookup && issues && body.newly_committed == Some(true) && !secret.is_empty() && secret.len() <= SECRET_MAX =>
        {
            match body.current.and_then(|c| c.id).filter(|id| !id.is_empty()) {
                Some(key) => (answer, KeySecret::Issued { key, secret }),
                None => (AccountAnswer::Indeterminate, KeySecret::None),
            }
        }
        (Some(_), _) => (AccountAnswer::Indeterminate, KeySecret::None),
        (None, Some("committed-secret-unrecoverable")) if issues && body.newly_committed != Some(true) => {
            (answer, KeySecret::Unrecoverable)
        }
        (None, Some(_)) => (AccountAnswer::Indeterminate, KeySecret::None),
        (None, None) => (answer, KeySecret::None),
    }
}

/// The security page (Identity's `users/{user}` and `api-keys`), as the signed-in user, and its
/// writes, account-management attempts like the address book's.
pub trait SecurityCalls {
    async fn user(&self, user: &str) -> Result<SecurityUser, ApiError>;
    /// The user's keys. Identity filters the list by `search`, which it matches against the key's
    /// name too, so only the keys whose `user_id` is `user` are kept (chase-sets/chase-sets#10695).
    async fn api_keys(&self, user: &str) -> Result<Vec<ApiKey>, ApiError>;
    /// Send the user's profile as `attempt`. A call with no answer is `Err(ApiError::Transport)`.
    async fn update_user(&self, user: &str, attempt: &str, command: &UserCommand) -> Result<AccountAnswer, ApiError>;
    /// Create a key named `name` for `user` (`target` none), or rotate or revoke `target`, as
    /// `attempt`; with the secret a create or rotate issued.
    async fn write_key(
        &self,
        user: &str,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        name: Option<&str>,
    ) -> Result<(AccountAnswer, KeySecret), ApiError>;
    /// What came of a security write's `attempt`: never its secret, but whether it is lost.
    async fn security_attempt(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
    ) -> Result<(AccountAnswer, KeySecret), ApiError>;
}

impl SecurityCalls for Caller<'_> {
    async fn user(&self, user: &str) -> Result<SecurityUser, ApiError> {
        self.read(&format!("/api/identity/users/{}", segment(user)), IDENTITY).await
    }

    async fn api_keys(&self, user: &str) -> Result<Vec<ApiKey>, ApiError> {
        let list: ApiKeyList = self.read(&format!("/api/identity/api-keys?search={}", segment(user)), IDENTITY).await?;
        Ok(list.items.into_iter().filter(|key| key.user_id == user).collect())
    }

    async fn update_user(&self, user: &str, attempt: &str, command: &UserCommand) -> Result<AccountAnswer, ApiError> {
        let path = format!("/api/identity/users/{}", segment(user));
        let res = self.request(Method::PUT, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).json(command).send().await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let body = res.text().await?;
        AccountAnswer::read(status, &body, receipt)
    }

    async fn write_key(
        &self,
        user: &str,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
        name: Option<&str>,
    ) -> Result<(AccountAnswer, KeySecret), ApiError> {
        let key = target.map(segment).unwrap_or_default();
        let (path, body) = match action {
            AccountAction::CreateApiKey => {
                ("/api/identity/api-keys".to_owned(), serde_json::json!({ "userId": user, "name": name.unwrap_or_default() }))
            }
            AccountAction::RotateApiKey => (format!("/api/identity/api-keys/{key}/rotate"), serde_json::json!({})),
            AccountAction::RevokeApiKey => (format!("/api/identity/api-keys/{key}/revoke"), serde_json::json!({})),
            _ => unreachable!("not a key write: {}", action.as_str()),
        };
        let res = self.request(Method::POST, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).json(&body).send().await?;
        let (status, receipt) = (res.status().as_u16(), Receipt::from_response(res.headers()));
        let text = res.text().await?;
        let answer = AccountAnswer::read(status, &text, receipt)?;
        Ok(key_secret(action, answer, &text, false))
    }

    async fn security_attempt(
        &self,
        action: AccountAction,
        target: Option<&str>,
        attempt: &str,
    ) -> Result<(AccountAnswer, KeySecret), ApiError> {
        let mut path = format!("{ACCOUNT_ATTEMPTS}?action={}", action.as_str());
        if let Some(target) = target {
            path.push_str(&format!("&target={}", segment(target)));
        }
        let res = self.request(Method::GET, &path, IDENTITY).header(IDEMPOTENCY_KEY, attempt).send().await?;
        let status = res.status().as_u16();
        let text = res.text().await?;
        let answer = AccountAnswer::read(status, &text, None)?;
        Ok(key_secret(action, answer, &text, true))
    }
}

const AUTH: &str = "auth";

/// A sign-in session (Auth's `SessionRow`), the fields the session pages show.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SessionRecord {
    pub session_id: String,
    pub user_id: String,
    pub user_display_name: Option<String>,
    pub user_primary_email: Option<String>,
    pub account_id: String,
    pub account_display_name: Option<String>,
    pub account_name: Option<String>,
    pub available_account_ids: Vec<String>,
    pub authentication_method: String,
    pub status: String,
    pub expires_at: String,
    pub updated_at: String,
}

impl SessionRecord {
    /// Who it is for, as marketplace names them: the display name, else the email, else the id.
    pub fn user(&self) -> &str {
        self.user_display_name.as_deref().or(self.user_primary_email.as_deref()).unwrap_or(&self.user_id)
    }

    /// The account it acts for: the display name, else the name, else the id.
    pub fn account(&self) -> &str {
        self.account_display_name.as_deref().or(self.account_name.as_deref()).unwrap_or(&self.account_id)
    }

    /// The accounts it could switch to: the available ones but the one it acts for.
    pub fn others(&self) -> impl Iterator<Item = &str> {
        self.available_account_ids.iter().map(String::as_str).filter(|id| *id != self.account_id)
    }
}

#[derive(Deserialize)]
struct SessionList {
    #[serde(default)]
    items: Vec<SessionRecord>,
    #[serde(default)]
    total: u64,
}

/// A write to a session: sign it out, or make it act for another of its accounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionWrite<'a> {
    Revoke,
    Switch(&'a str),
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorCode>,
}

#[derive(Deserialize)]
struct ErrorCode {
    code: Option<String>,
}

/// The signed-in user's sessions (Auth's `sessions`) and their two writes. Neither write is an
/// attempt: Auth takes no `Idempotency-Key` for them, and answers every refusal (already revoked,
/// already that account) with a 500 (chase-sets/chase-sets#10698).
pub trait SessionCalls {
    /// A page of `user`'s sessions, newest first, and how many there are. Auth filters the list
    /// by `search`, which it matches against names and emails too, so only the sessions whose
    /// `user_id` is `user` are kept (chase-sets/chase-sets#10697), and the total counts them out.
    async fn sessions(
        &self,
        user: &str,
        status: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<SessionRecord>, u64), ApiError>;
    async fn session(&self, id: &str) -> Result<SessionRecord, ApiError>;
    /// Send `write`; the write's receipt when it is done. A call with no answer is
    /// `Err(ApiError::Transport)`.
    async fn session_write(&self, id: &str, write: SessionWrite<'_>) -> Result<Option<String>, ApiError>;
}

impl SessionCalls for Caller<'_> {
    async fn sessions(
        &self,
        user: &str,
        status: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<SessionRecord>, u64), ApiError> {
        let mut path = format!("/api/auth/sessions?limit={limit}&offset={offset}");
        if let Some(status) = status {
            path.push_str(&format!("&status={}", segment(status)));
        }
        let list: SessionList = self.read(&path, AUTH).await?;
        let found = list.items.len();
        let items: Vec<SessionRecord> = list.items.into_iter().filter(|s| s.user_id == user).collect();
        let total = list.total.saturating_sub((found - items.len()) as u64);
        Ok((items, total))
    }

    async fn session(&self, id: &str) -> Result<SessionRecord, ApiError> {
        self.read(&format!("/api/auth/sessions/{}", segment(id)), AUTH).await
    }

    async fn session_write(&self, id: &str, write: SessionWrite<'_>) -> Result<Option<String>, ApiError> {
        let (path, body) = match write {
            SessionWrite::Revoke => (format!("/api/auth/sessions/{}/revoke", segment(id)), serde_json::json!({})),
            SessionWrite::Switch(account) => {
                (format!("/api/auth/sessions/{}/switch-account", segment(id)), serde_json::json!({ "accountId": account }))
            }
        };
        let res = self.request(Method::POST, &path, AUTH).json(&body).send().await?;
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let receipt = Receipt::from_response(res.headers());
        if status.is_success() {
            return Ok(receipt.map(|r| r.param()));
        }
        let code = serde_json::from_str::<ErrorBody>(&res.text().await?).ok().and_then(|b| b.error).and_then(|e| e.code);
        Err(ApiError::Status { status, code, message: String::new() })
    }
}

/// Auth's UCP OAuth routes, which the connected agents pages call (marketplace's
/// `createUcpOAuthRequestApiClient`). Each needs an interactive session and answers a refusal
/// with `{ "error": .. }` or `{ "state": .. }`, so a refusal is read by its status.
const UCP_OAUTH: &str = "/ucp/oauth";

/// What a grant may spend (`AgentGrantSpendingMandate`): each cap in cents, none for no cap.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct SpendingMandate {
    pub max_per_order_cents: Option<i64>,
    pub daily_cap_cents: Option<i64>,
    pub monthly_cap_cents: Option<i64>,
    pub human_present_required: bool,
    pub allowed_rails: Vec<String>,
}

/// What a grant spent today and this month, in cents (`AgentGrantSpend`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct GrantSpend {
    pub daily_cents: i64,
    pub monthly_cents: i64,
}

/// A connected agent (`AgentGrant`), the fields the pages show.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AgentGrant {
    pub id: String,
    pub account_id: Option<String>,
    pub platform_profile_url: String,
    pub client_id: String,
    pub client_name: Option<String>,
    pub client_uri: Option<String>,
    pub scopes: Vec<String>,
    pub status: String,
    pub granted_at: String,
    pub revoked_at: Option<String>,
    pub spending_mandate: Option<SpendingMandate>,
    pub spend: Option<GrantSpend>,
}

impl AgentGrant {
    /// Its name, as marketplace's `clientLabel`: the client's name, else its address, else the
    /// platform's profile.
    pub fn name(&self) -> &str {
        self.client_name.as_deref().or(self.client_uri.as_deref()).unwrap_or(&self.platform_profile_url)
    }
}

#[derive(Deserialize)]
struct GrantList {
    #[serde(default)]
    authorizations: Vec<AgentGrant>,
}

/// A grant's page read (`GET /authorizations/{id}`): the grant, whether it can be revoked now,
/// and whether revocation runs as an attempt that is confirmed (`revocation_active`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct GrantDetail {
    pub authorization: AgentGrant,
    pub revocation_available: bool,
    pub revocation_active: bool,
}

/// One call an agent made with its grant (`AgentGrantActivityRecord`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct GrantActivity {
    pub id: String,
    pub occurred_at: String,
    pub outcome: String,
    pub method: String,
    pub tool_name: Option<String>,
    pub resource_uri: Option<String>,
    pub reason: Option<String>,
}

impl GrantActivity {
    /// What was called: the tool, else the resource, else the method.
    pub fn called(&self) -> &str {
        self.tool_name.as_deref().or(self.resource_uri.as_deref()).unwrap_or(&self.method)
    }
}

#[derive(Deserialize)]
struct ActivityPage {
    #[serde(default)]
    activity: Vec<GrantActivity>,
}

/// A grant's order-update webhook (`AgentGrantWebhook`). `signing_secret` is only in the answer
/// to the save that made it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct GrantWebhook {
    pub callback_url: String,
    pub signing_secret_preview: Option<String>,
    pub signing_secret: Option<String>,
}

#[derive(Deserialize)]
struct WebhookBody {
    webhook: Option<GrantWebhook>,
}

/// What a revoke answered: `{ "revoked": .. }` alone, while revocation is not an attempt, or the
/// attempt's receipt as sent, which the page checks before believing it.
#[derive(Clone, Debug, PartialEq)]
pub enum RevokeAnswer {
    Plain,
    Receipt(serde_json::Value),
}

/// An OAuth consent request (`GET /consent`, `AgentOAuthConsent`): who asks, where the answer goes,
/// the account it would act for and the user's other accounts, and the authorize address that
/// asks again (after Use another account).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentConsent {
    pub client_name: String,
    pub redirect_origin: String,
    #[serde(skip_serializing)]
    pub session_id: String,
    pub account_id: String,
    pub account_name: String,
    pub scopes: Vec<String>,
    pub operator_grant_expires_at: Option<String>,
    pub memberships: Vec<ConsentMembership>,
    pub authorize_path: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConsentMembership {
    pub account_id: String,
    pub account_name: String,
}

#[derive(Deserialize)]
struct ConsentBody {
    consent: AgentConsent,
}

/// The connected agents pages' calls (`/ucp/oauth`), as the signed-in user.
pub trait AgentCalls {
    async fn agent_grants(&self) -> Result<Vec<AgentGrant>, ApiError>;
    async fn agent_grant(&self, id: &str) -> Result<GrantDetail, ApiError>;
    /// The grant's newest 50 calls, as marketplace's loader reads them.
    async fn agent_activity(&self, id: &str) -> Result<Vec<GrantActivity>, ApiError>;
    async fn agent_webhook(&self, id: &str) -> Result<Option<GrantWebhook>, ApiError>;
    /// Save the webhook's address, or disable it (`None`); the webhook as it now is.
    async fn save_agent_webhook(&self, id: &str, callback_url: Option<&str>) -> Result<Option<GrantWebhook>, ApiError>;
    async fn save_agent_mandate(&self, id: &str, mandate: &SpendingMandate) -> Result<(), ApiError>;
    /// Revoke the grant as `attempt` (`Idempotency-Key` and `attempt_id`). A call with no answer
    /// is `Err(ApiError::Transport)`.
    async fn revoke_agent_grant(&self, id: &str, attempt: &str) -> Result<RevokeAnswer, ApiError>;
    /// What came of the revoke `attempt`, as sent.
    async fn agent_revocation(&self, id: &str, attempt: &str) -> Result<serde_json::Value, ApiError>;
    async fn agent_consent(&self, token: &str) -> Result<AgentConsent, ApiError>;
}

impl AgentCalls for Caller<'_> {
    async fn agent_grants(&self) -> Result<Vec<AgentGrant>, ApiError> {
        let list: GrantList = self.read(&format!("{UCP_OAUTH}/authorizations"), AUTH).await?;
        Ok(list.authorizations)
    }

    async fn agent_grant(&self, id: &str) -> Result<GrantDetail, ApiError> {
        self.read(&format!("{UCP_OAUTH}/authorizations/{}", segment(id)), AUTH).await
    }

    async fn agent_activity(&self, id: &str) -> Result<Vec<GrantActivity>, ApiError> {
        let path = format!("{UCP_OAUTH}/authorizations/{}/activity?limit=50&offset=0", segment(id));
        let page: ActivityPage = self.read(&path, AUTH).await?;
        Ok(page.activity)
    }

    async fn agent_webhook(&self, id: &str) -> Result<Option<GrantWebhook>, ApiError> {
        let body: WebhookBody = self.read(&format!("{UCP_OAUTH}/authorizations/{}/webhook", segment(id)), AUTH).await?;
        Ok(body.webhook)
    }

    async fn save_agent_webhook(&self, id: &str, callback_url: Option<&str>) -> Result<Option<GrantWebhook>, ApiError> {
        let path = format!("{UCP_OAUTH}/authorizations/{}/webhook", segment(id));
        let req = self.request(Method::PUT, &path, AUTH).json(&serde_json::json!({ "callback_url": callback_url }));
        let (body, _): (WebhookBody, _) = self.write(req).await?;
        Ok(body.webhook)
    }

    async fn save_agent_mandate(&self, id: &str, mandate: &SpendingMandate) -> Result<(), ApiError> {
        let path = format!("{UCP_OAUTH}/authorizations/{}/mandate", segment(id));
        let (_, _): (serde_json::Value, _) = self.write(self.request(Method::PUT, &path, AUTH).json(mandate)).await?;
        Ok(())
    }

    async fn revoke_agent_grant(&self, id: &str, attempt: &str) -> Result<RevokeAnswer, ApiError> {
        let path = format!("{UCP_OAUTH}/authorizations/{}/revoke", segment(id));
        let req = self.request(Method::POST, &path, AUTH).header(IDEMPOTENCY_KEY, attempt);
        let (body, _): (serde_json::Value, _) = self.write(req.json(&serde_json::json!({ "attempt_id": attempt }))).await?;
        let plain = body.as_object().is_some_and(|o| o.len() == 1 && o.get("revoked").is_some_and(serde_json::Value::is_boolean));
        Ok(if plain { RevokeAnswer::Plain } else { RevokeAnswer::Receipt(body) })
    }

    async fn agent_revocation(&self, id: &str, attempt: &str) -> Result<serde_json::Value, ApiError> {
        self.read(&format!("{UCP_OAUTH}/authorizations/{}/revocation/{}", segment(id), segment(attempt)), AUTH).await
    }

    async fn agent_consent(&self, token: &str) -> Result<AgentConsent, ApiError> {
        let body: ConsentBody = self.read(&format!("{UCP_OAUTH}/consent?consent_token={}", segment(token)), AUTH).await?;
        Ok(body.consent)
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    const ISSUED: &str = r#"{"outcome":"committed","newlyCommitted":true,"current":{"id":"key_1","version":1,"status":"active"},"secret":"key_live_abcdefghijklmnop"}"#;

    #[test]
    fn a_new_secret_is_read_once_and_never_from_a_lookup() {
        let committed = AccountAnswer::Committed(None);
        let (answer, secret) = key_secret(AccountAction::CreateApiKey, committed.clone(), ISSUED, false);
        assert_eq!(answer, committed);
        assert_eq!(secret, KeySecret::Issued { key: "key_1".into(), secret: "key_live_abcdefghijklmnop".into() });
        assert!(!format!("{secret:?}").contains("abcdef"), "Debug never prints the secret");
        let (answer, secret) = key_secret(AccountAction::CreateApiKey, committed.clone(), ISSUED, true);
        assert_eq!((answer, secret), (AccountAnswer::Indeterminate, KeySecret::None), "a lookup with a secret is ambiguous");
        let (answer, _) = key_secret(AccountAction::RevokeApiKey, committed.clone(), ISSUED, false);
        assert_eq!(answer, AccountAnswer::Indeterminate, "a revoke never issues one");
        let replayed = ISSUED.replace(r#""newlyCommitted":true"#, r#""newlyCommitted":false"#);
        let (answer, _) = key_secret(AccountAction::RotateApiKey, committed.clone(), &replayed, false);
        assert_eq!(answer, AccountAnswer::Indeterminate, "only a new commit carries one");
        let long = ISSUED.replace("key_live_abcdefghijklmnop", &"k".repeat(201));
        assert_eq!(key_secret(AccountAction::CreateApiKey, committed.clone(), &long, false).0, AccountAnswer::Indeterminate);
        let lost = r#"{"outcome":"committed","newlyCommitted":false,"secretState":"committed-secret-unrecoverable"}"#;
        assert_eq!(
            key_secret(AccountAction::CreateApiKey, committed.clone(), lost, true),
            (committed.clone(), KeySecret::Unrecoverable)
        );
        let plain = r#"{"outcome":"committed","newlyCommitted":true}"#;
        assert_eq!(key_secret(AccountAction::RevokeApiKey, committed.clone(), plain, false), (committed, KeySecret::None));
        let refused = AccountAnswer::Conflict;
        assert_eq!(key_secret(AccountAction::CreateApiKey, refused.clone(), ISSUED, false), (refused, KeySecret::None));
    }

    #[test]
    fn a_user_profile_is_sent_as_typed() {
        let command = UserCommand { display_name: " Ada ".into(), given_name: "Ada".into(), family_name: String::new() };
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            serde_json::json!({ "displayName": " Ada ", "givenName": "Ada", "familyName": "" })
        );
    }
}

#[cfg(test)]
mod address_tests {
    use super::*;

    #[test]
    fn identity_answers_read_as_the_page_needs_them() {
        let committed = r#"{"outcome":"committed","newlyCommitted":true,"current":{"id":"adr_1","version":2,"status":"active"}}"#;
        assert_eq!(AccountAnswer::read(200, committed, None).unwrap(), AccountAnswer::Committed(None));
        let required = r#"{"error":{"code":"validation_failed","message":"City is required.","details":[{"field":"city","code":"required","message":"City is required."}]}}"#;
        assert_eq!(
            AccountAnswer::read(400, required, None).unwrap(),
            AccountAnswer::NotRecorded { code: "validation-failed".into(), field: Some("city".into()), suggested: None }
        );
        let suggested = r#"{"outcome":"not-recorded","code":"address-standardization-suggested","suggestedAddress":{"name":"A","company":null,"line1":"1 TEST WAY","line2":null,"city":"AUSTIN","state":"TX","postalCode":"78701-0001","country":"US","phone":null,"email":null}}"#;
        let AccountAnswer::NotRecorded { suggested: Some(address), .. } = AccountAnswer::read(400, suggested, None).unwrap()
        else {
            panic!("a suggestion")
        };
        assert_eq!(address.postal_code, "78701-0001");
        let conflict =
            r#"{"outcome":"conflict","code":"owner-state-conflict","current":{"id":"adr_1","version":3,"status":"archived"}}"#;
        assert_eq!(AccountAnswer::read(409, conflict, None).unwrap(), AccountAnswer::Conflict);
        assert_eq!(
            AccountAnswer::read(503, r#"{"outcome":"indeterminate","code":"INDETERMINATE"}"#, None).unwrap(),
            AccountAnswer::Indeterminate
        );
        assert_eq!(AccountAnswer::read(502, "", None).unwrap(), AccountAnswer::Indeterminate);
        assert_eq!(
            AccountAnswer::read(401, r#"{"error":{"code":"authentication_required"}}"#, None).unwrap_err().status(),
            Some(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            AccountAnswer::read(403, r#"{"outcome":"not-recorded","code":"authorization_forbidden"}"#, None)
                .unwrap_err()
                .status(),
            Some(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn a_lookup_reads_its_receipt_from_the_destination() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let receipt = format!(
            r#"{{"observedAtMs":{now},"sources":[{{"sourceContextName":"identity","maxGlobalPosition":"83","eventIds":["evt_1"]}}]}}"#
        );
        let once = percent_encoding::utf8_percent_encode(&receipt, percent_encoding::NON_ALPHANUMERIC).to_string();
        let twice = percent_encoding::utf8_percent_encode(&once, percent_encoding::NON_ALPHANUMERIC).to_string();
        let body = format!(
            r#"{{"outcome":"committed","newlyCommitted":false,"destination":"/account/shipping-addresses?afterWrite={twice}"}}"#
        );
        let AccountAnswer::Committed(Some(after)) = AccountAnswer::read(200, &body, None).unwrap() else { panic!("a receipt") };
        assert!(after.contains(r#""maxGlobalPosition":"83""#), "{after}");
        assert_eq!(after_write_of("/account/shipping-addresses"), None);
    }
}

/// A seller's listing (`MarketplaceListingDetail`), the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SellerListing {
    pub listing_id: String,
    pub catalog_catalog_item_id: String,
    pub item_language_code: Option<String>,
    pub item_title: Option<String>,
    pub item_subtitle: Option<String>,
    /// "Form: raw | Condition: near-mint".
    pub product_summary: Option<String>,
    /// `null` when the catalog has no shipping measure for the product: it cannot be published.
    pub product_measure_snapshot: Option<serde_json::Value>,
    pub storage_location_name: Option<String>,
    pub ship_from_code: Option<String>,
    #[serde(default)]
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub shipping_allowance_percentage_bps: Option<u32>,
    pub terms_schedule_id: Option<String>,
    pub terms_agreement_id: Option<String>,
    pub terms_resolved_at: Option<String>,
    pub fee_quote_fingerprint: Option<String>,
    pub quantity_cap: u64,
    pub max_units_per_order: Option<u64>,
    pub max_units_per_day: Option<u64>,
    pub max_units_per_customer_account: Option<u64>,
    /// `draft`, `active`, `paused` or `withdrawn`.
    pub status: String,
    #[serde(default)]
    pub evidence: Vec<ListingPhoto>,
    pub evidence_readiness: EvidenceReadiness,
}

impl SellerListing {
    /// The active photos in their order (`ListingEvidenceReadiness`'s `activePhotos`).
    pub fn active_photos(&self) -> Vec<&ListingPhoto> {
        let mut photos: Vec<_> = self.evidence.iter().filter(|p| p.status == "active").collect();
        photos.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.photo_id.cmp(&b.photo_id)));
        photos
    }
}

/// A listing's photo (`MarketplaceListingPhoto`), the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingPhoto {
    pub photo_id: String,
    pub alt_text: Option<String>,
    pub slot_id: Option<String>,
    pub view_kind: Option<String>,
    /// `active`, `replaced` or `removed`.
    pub status: String,
    #[serde(default)]
    pub sort_order: i64,
}

/// One change of a listing's fee lock (`MarketplaceListingFeeHistoryEntry`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FeeHistoryEntry {
    pub event_type: String,
    pub stream_version: u64,
    pub recorded_at: Option<String>,
    pub price_amount: Option<String>,
    pub price_currency_code: Option<String>,
    pub quantity_cap: Option<u64>,
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub terms_agreement_id: Option<String>,
    pub terms_schedule_id: Option<String>,
    pub terms_resolved_at: Option<String>,
}

#[derive(Deserialize)]
struct FeeHistory {
    #[serde(default)]
    items: Vec<FeeHistoryEntry>,
}

/// A change to a listing, as its page sends it (marketplace's `account-listing` intents).
#[derive(Clone, Debug, PartialEq)]
pub enum ListingCommand {
    Price { amount: String, currency: String, fee_quote_fingerprint: Option<String> },
    QuantityCap { cap: u64, fee_quote_fingerprint: Option<String> },
    PurchaseLimits { per_order: Option<u64>, per_day: Option<u64>, per_customer: Option<u64> },
    Classify { photo: String, slot_id: Option<String>, view_kind: Option<String>, alt_text: Option<String> },
    RemovePhoto { photo: String },
    Reorder { photos: Vec<String> },
    Publish { fee_quote_fingerprint: Option<String> },
    Pause,
    Withdraw,
}

/// Why a listing command was not applied.
#[derive(Debug)]
pub enum CommandError {
    /// The fee quote the form carried is stale (409): the API's current one.
    StaleQuote(Box<TermsPreview>),
    /// Publication needs evidence the listing does not have (409): what it needs now.
    EvidenceIncomplete {
        message: String,
        readiness: Box<EvidenceReadiness>,
    },
    Api(ApiError),
}

impl From<ApiError> for CommandError {
    fn from(error: ApiError) -> Self {
        CommandError::Api(error)
    }
}

/// The seller's listing page's calls (marketplace's `account-listing` route).
pub trait SellerListings {
    async fn seller_listing(&self, id: &str) -> Result<SellerListing, ApiError>;
    async fn fee_history(&self, id: &str) -> Result<Vec<FeeHistoryEntry>, ApiError>;
    async fn listing_command(&self, id: &str, command: &ListingCommand) -> Result<Option<Receipt>, CommandError>;
    /// Adds photos to a draft, each with `alt_text` when there is one.
    async fn add_listing_photos(
        &self,
        id: &str,
        photos: &[Photo],
        alt_text: Option<&str>,
    ) -> Result<Option<Receipt>, CommandError>;
    /// Replaces a photo, keeping its slot and view.
    async fn replace_listing_photo(
        &self,
        id: &str,
        photo: &str,
        with: &Photo,
        fields: &[(&str, String)],
    ) -> Result<Option<Receipt>, CommandError>;
}

fn photo_part(photo: &Photo) -> Result<reqwest::multipart::Part, ApiError> {
    Ok(reqwest::multipart::Part::stream(photo.bytes.clone()).file_name(photo.filename.clone()).mime_str(&photo.content_type)?)
}

/// A listing command's answer: its receipt, or why it was not applied, with the 409s that carry
/// the current fee quote or evidence (`staleQuoteFromError`, `evidenceReadinessFromError`).
async fn answer(req: reqwest::RequestBuilder) -> Result<Option<Receipt>, CommandError> {
    let res = req.send().await.map_err(ApiError::from)?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_success() {
        return Ok(Receipt::from_response(res.headers()));
    }
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    let error = &body["error"];
    let message = error["message"].as_str().unwrap_or_default().to_owned();
    if status == StatusCode::CONFLICT {
        if let Ok(quote) = serde_json::from_value::<TermsPreview>(error["currentQuote"].clone()) {
            return Err(CommandError::StaleQuote(Box::new(quote)));
        }
        if let Ok(readiness) = serde_json::from_value::<EvidenceReadiness>(error["currentEvidenceReadiness"].clone()) {
            return Err(CommandError::EvidenceIncomplete { message, readiness: Box::new(readiness) });
        }
    }
    let code = error["code"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
    Err(CommandError::Api(ApiError::Status { status, code, message }))
}

impl SellerListings for Caller<'_> {
    async fn seller_listing(&self, id: &str) -> Result<SellerListing, ApiError> {
        self.read(&format!("/api/marketplace/account/listings/{}", segment(id)), MARKETPLACE).await
    }

    async fn fee_history(&self, id: &str) -> Result<Vec<FeeHistoryEntry>, ApiError> {
        let path = format!("/api/marketplace/account/listings/{}/fee-history", segment(id));
        Ok(self.read::<FeeHistory>(&path, MARKETPLACE).await?.items)
    }

    async fn listing_command(&self, id: &str, command: &ListingCommand) -> Result<Option<Receipt>, CommandError> {
        use serde_json::json;
        let base = format!("/api/marketplace/account/listings/{}", segment(id));
        let (method, path, body) = match command {
            ListingCommand::Price { amount, currency, fee_quote_fingerprint } => (
                Method::POST,
                format!("{base}/price"),
                json!({ "priceAmount": amount, "priceCurrencyCode": currency, "feeQuoteFingerprint": fee_quote_fingerprint }),
            ),
            ListingCommand::QuantityCap { cap, fee_quote_fingerprint } => (
                Method::POST,
                format!("{base}/quantity-cap"),
                json!({ "quantityCap": cap, "feeQuoteFingerprint": fee_quote_fingerprint }),
            ),
            ListingCommand::PurchaseLimits { per_order, per_day, per_customer } => (
                Method::POST,
                format!("{base}/purchase-limits"),
                json!({ "purchaseLimits": {
                    "maxUnitsPerOrder": per_order, "maxUnitsPerDay": per_day, "maxUnitsPerCustomerAccount": per_customer,
                } }),
            ),
            ListingCommand::Classify { photo, slot_id, view_kind, alt_text } => (
                Method::POST,
                format!("{base}/photos/{}/classify", segment(photo)),
                json!({ "slotId": slot_id, "viewKind": view_kind, "altText": alt_text }),
            ),
            ListingCommand::RemovePhoto { photo } => {
                (Method::DELETE, format!("{base}/photos/{}", segment(photo)), serde_json::Value::Null)
            }
            ListingCommand::Reorder { photos } => {
                (Method::POST, format!("{base}/photos/reorder"), json!({ "orderedPhotoIds": photos }))
            }
            ListingCommand::Publish { fee_quote_fingerprint } => {
                (Method::POST, format!("{base}/publish"), json!({ "feeQuoteFingerprint": fee_quote_fingerprint }))
            }
            ListingCommand::Pause => (Method::POST, format!("{base}/pause"), json!({})),
            ListingCommand::Withdraw => (Method::POST, format!("{base}/withdraw"), json!({})),
        };
        let mut req = self.request(method, &path, MARKETPLACE);
        if !body.is_null() {
            req = req.json(&body);
        }
        answer(req).await
    }

    async fn add_listing_photos(
        &self,
        id: &str,
        photos: &[Photo],
        alt_text: Option<&str>,
    ) -> Result<Option<Receipt>, CommandError> {
        let mut form = reqwest::multipart::Form::new();
        for photo in photos {
            form = form.part("evidence", photo_part(photo)?);
        }
        if let Some(text) = alt_text.map(str::trim).filter(|t| !t.is_empty()) {
            form = form.text("listingPhotoAltText", text.to_owned());
        }
        let path = format!("/api/marketplace/account/listings/{}/photos", segment(id));
        answer(self.request(Method::POST, &path, MARKETPLACE).timeout(UPLOAD_TIMEOUT).multipart(form)).await
    }

    async fn replace_listing_photo(
        &self,
        id: &str,
        photo: &str,
        with: &Photo,
        fields: &[(&str, String)],
    ) -> Result<Option<Receipt>, CommandError> {
        let mut form = reqwest::multipart::Form::new().part("listingPhoto", photo_part(with)?);
        for (name, value) in fields.iter().filter(|(_, v)| !v.is_empty()) {
            form = form.text(name.to_string(), value.clone());
        }
        let path = format!("/api/marketplace/account/listings/{}/photos/{}/replace", segment(id), segment(photo));
        answer(self.request(Method::POST, &path, MARKETPLACE).timeout(UPLOAD_TIMEOUT).multipart(form)).await
    }
}

/// A page of the seller's listings (`listSellerListings`): the rows, the total the filters match,
/// the page asked for and the account's counts by status.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ListingPage {
    pub items: Vec<ListingRow>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
    #[serde(rename = "statusCounts")]
    pub status_counts: StatusCounts,
}

/// How many of the account's listings are in each status (`MarketplaceSellerListingStatusCounts`).
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct StatusCounts {
    pub active: u64,
    pub draft: u64,
    pub paused: u64,
    pub withdrawn: u64,
}

/// A row of the list (`MarketplaceListingListItem`), the fields it shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ListingRow {
    pub listing_id: String,
    pub catalog_catalog_item_id: String,
    pub item_language_code: Option<String>,
    pub item_title: Option<String>,
    pub item_subtitle: Option<String>,
    pub product_summary: Option<String>,
    pub product_measure_snapshot: Option<serde_json::Value>,
    pub storage_location_name: Option<String>,
    #[serde(default)]
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub shipping_allowance_percentage_bps: Option<u32>,
    pub terms_resolved_at: Option<String>,
    pub quantity_cap: u64,
    pub status: String,
    #[serde(default)]
    pub evidence: Vec<ListingPhoto>,
}

/// A row of the fee lock report (`MarketplaceListingFeeLockReportEntry`), the fields it shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FeeLockRow {
    pub listing_id: String,
    pub inventory_item_id: String,
    pub item_title: Option<String>,
    pub product_summary: Option<String>,
    pub status: String,
    pub price_currency_code: Option<String>,
    pub quantity_cap: u64,
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub terms_schedule_id: Option<String>,
    pub terms_agreement_id: Option<String>,
    pub terms_resolved_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
struct FeeLockReport {
    #[serde(default)]
    items: Vec<FeeLockRow>,
}

/// Whether the account's listings are on, and its away window (`MarketplaceSellerListingAvailability`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Availability {
    /// `available` or `unavailable`.
    pub status: String,
    pub disabled_reason_category: Option<String>,
    pub available_again_on: Option<String>,
    pub available_again_at: Option<String>,
    /// The pending away window's start; none when no window is scheduled.
    pub away_window_starts_at: Option<String>,
    pub away_window_ends_at: Option<String>,
    pub away_window_reason_category: Option<String>,
}

impl Availability {
    pub fn available(&self) -> bool {
        self.status != "unavailable"
    }
}

/// The account's order capacity (`MarketplaceSellerOrderCapacity`): none is unlimited.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct OrderCapacity {
    pub max_open_orders: Option<u64>,
}

/// The seller's own behavioral metrics (`SellerBehavioralMetricsSummary`), the fields shown. A rate
/// is a fraction from 0 to 1, none while there is nothing to divide by.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SellerMetrics {
    pub window_days: u32,
    pub orders_created_count: u64,
    pub shipments_dispatched_count: u64,
    pub cancellation_rate: Option<String>,
    pub on_time_shipment_rate: Option<String>,
    pub dispute_rate: Option<String>,
}

impl SellerMetrics {
    /// Whether every rate is a decimal from 0 to 1 (`parseSellerBehavioralMetricsSummary`): one that
    /// is not makes the whole summary unavailable, never partly shown.
    pub fn valid(&self) -> bool {
        [&self.cancellation_rate, &self.on_time_shipment_rate, &self.dispute_rate].into_iter().flatten().all(|rate| {
            let digits = rate.split_once('.').map_or((rate.as_str(), "0"), |(whole, fraction)| (whole, fraction));
            let decimal = !digits.0.is_empty()
                && !digits.1.is_empty()
                && digits.0.bytes().all(|b| b.is_ascii_digit())
                && digits.1.bytes().all(|b| b.is_ascii_digit());
            decimal && rate.parse::<f64>().is_ok_and(|r| r <= 1.0)
        })
    }
}

#[derive(Deserialize)]
struct OpenOrders {
    #[serde(default)]
    open_order_count: u64,
}

/// The account-wide listing settings marketplace's list of listings changes (its intents).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SellerSetting {
    /// Turn listings off: the reason, the date they come back and that date's start in the
    /// seller's time zone (empty when the page's script did not run: the date is then only shown).
    Disable {
        reason: String,
        on: String,
        at: String,
    },
    Enable,
    /// An away window from `starts_at` to `ends_at` (none: until turned back on).
    Schedule {
        reason: String,
        starts_at: String,
        ends_at: String,
    },
    CancelWindow,
    Capacity(u64),
    ClearCapacity,
}

/// The seller's list of listings' calls (marketplace's `account-listings` route).
pub trait SellerListingList {
    /// A page of the listings: `query` is `limit`, `offset` and the filters.
    async fn seller_listing_page(&self, query: &str) -> Result<ListingPage, ApiError>;
    /// The first 100 rows of the fee lock report, as marketplace reads them.
    async fn fee_lock_report(&self) -> Result<Vec<FeeLockRow>, ApiError>;
    async fn listing_availability(&self) -> Result<Availability, ApiError>;
    async fn order_capacity(&self) -> Result<OrderCapacity, ApiError>;
    async fn seller_metrics(&self) -> Result<SellerMetrics, ApiError>;
    /// Ordering's count of the account's open orders (the "N" of "N of M").
    async fn open_order_count(&self) -> Result<u64, ApiError>;
    async fn seller_setting(&self, setting: &SellerSetting) -> Result<Option<Receipt>, CommandError>;
}

const ACCOUNT: &str = "/api/marketplace/account";

impl SellerListingList for Caller<'_> {
    async fn seller_listing_page(&self, query: &str) -> Result<ListingPage, ApiError> {
        self.read(&format!("{ACCOUNT}/listings?{query}"), MARKETPLACE).await
    }

    async fn fee_lock_report(&self) -> Result<Vec<FeeLockRow>, ApiError> {
        Ok(self
            .read::<FeeLockReport>(&format!("{ACCOUNT}/listings/fee-lock-report?limit=100&offset=0"), MARKETPLACE)
            .await?
            .items)
    }

    async fn listing_availability(&self) -> Result<Availability, ApiError> {
        self.read(&format!("{ACCOUNT}/listing-availability"), MARKETPLACE).await
    }

    async fn order_capacity(&self) -> Result<OrderCapacity, ApiError> {
        self.read(&format!("{ACCOUNT}/order-capacity"), MARKETPLACE).await
    }

    async fn seller_metrics(&self) -> Result<SellerMetrics, ApiError> {
        self.read(&format!("{ACCOUNT}/seller-metrics"), MARKETPLACE).await
    }

    async fn open_order_count(&self) -> Result<u64, ApiError> {
        Ok(self.read::<OpenOrders>(&format!("{ACCOUNT}/sales/order-capacity"), ORDERING).await?.open_order_count)
    }

    async fn seller_setting(&self, setting: &SellerSetting) -> Result<Option<Receipt>, CommandError> {
        use serde_json::json;
        let availability = format!("{ACCOUNT}/listing-availability");
        let capacity = format!("{ACCOUNT}/order-capacity");
        let (method, path, body) = match setting {
            SellerSetting::Disable { reason, on, at } => (
                Method::POST,
                format!("{availability}/disable"),
                json!({ "reasonCategory": reason, "availableAgainOn": on, "availableAgainAt": at }),
            ),
            SellerSetting::Enable => (Method::POST, format!("{availability}/enable"), json!({})),
            SellerSetting::Schedule { reason, starts_at, ends_at } => (
                Method::POST,
                format!("{availability}/away-window"),
                json!({ "reasonCategory": reason, "startsAt": starts_at, "endsAt": ends_at }),
            ),
            SellerSetting::CancelWindow => (Method::DELETE, format!("{availability}/away-window"), serde_json::Value::Null),
            SellerSetting::Capacity(max) => (Method::POST, capacity, json!({ "maxOpenOrders": max })),
            SellerSetting::ClearCapacity => (Method::DELETE, capacity, serde_json::Value::Null),
        };
        let mut req = self.request(method, &path, MARKETPLACE);
        if !body.is_null() {
            req = req.json(&body);
        }
        answer(req).await
    }
}

/// A submitted offer that matches a listing of the seller's (`OfferMatchListItem`, the same row
/// for the list and an offer match's page; Checkout's sell-list read adds `offer_stream_version`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct OfferMatch {
    pub offer_id: String,
    pub buyer_account_id: String,
    pub buyer_display_name: Option<String>,
    pub buyer_average_rating: Option<String>,
    pub buyer_review_count: u64,
    pub catalog_catalog_item_id: String,
    pub product_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub selected_options: Vec<Selected>,
    pub product_summary: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub last_stream_version: u64,
    pub offer_stream_version: Option<u64>,
    pub quantity_requested: u64,
    /// `submitted`, or what it became.
    pub status: String,
    pub listing_id: String,
    pub listing_price_amount: String,
    pub listing_price_currency_code: String,
    pub listing_stream_version: u64,
    pub listing_quantity_cap: u64,
    pub listing_visible_quantity: u64,
    /// The offer's price below the listing's (negative over it), as a decimal.
    pub offer_price_gap_amount: String,
    /// The offer as basis points of the listing's price.
    pub offer_to_listing_price_bps: u32,
    pub seller_available_quantity: u64,
    /// `available` or `unavailable` (listings turned off).
    pub seller_listing_availability_status: String,
    pub can_fulfill: bool,
    /// `unavailable`, `held` or `refresh_required` for a managed offer.
    pub managed_status: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct OfferMatches {
    pub items: Vec<OfferMatch>,
    pub total: u64,
}

/// The fee terms accepting an offer would be priced with (`MarketplaceListingTermsPreview`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AcceptanceTerms {
    pub marketplace_sales_fee_unit_amount: Option<String>,
    pub seller_net_unit_amount: Option<String>,
    pub shipping_allowance_percentage_bps: Option<u32>,
    pub agreement_id: Option<String>,
    pub resolved_at: Option<String>,
}

/// The seller's offer matches' calls (marketplace's `account-offer-matches` and
/// `account-offer-match`, and the sell list's `add-selected-offer`).
pub trait OfferMatchCalls {
    /// The first 100 offer matches, as marketplace reads them.
    async fn offer_matches(&self) -> Result<OfferMatches, ApiError>;
    /// An offer match, or none when the seller has no such match (404).
    async fn offer_match(&self, id: &str) -> Result<Option<OfferMatch>, ApiError>;
    /// What accepting it at `listing` would be priced with.
    async fn acceptance_terms(&self, id: &str, listing: &str) -> Result<AcceptanceTerms, ApiError>;
    /// The offer as Checkout's sell list reads it (`getSellListOfferMatch`), for its line.
    async fn sell_list_offer(&self, id: &str) -> Result<Option<OfferMatch>, ApiError>;
    /// Declines the offer as `attempt` (`attemptId`): Marketplace applies an attempt once.
    async fn decline_offer_match(&self, id: &str, attempt: &str) -> Result<Option<Receipt>, CommandError>;
    /// Accepts the offer at its exact listing (`listingId`, `feeQuoteFingerprint`,
    /// `sourceActionKey` and a Smart Match's batch): the write's receipt.
    async fn accept_offer_match(&self, id: &str, body: &serde_json::Value) -> Result<Option<Receipt>, ApiError>;
}

impl OfferMatchCalls for Caller<'_> {
    async fn offer_matches(&self) -> Result<OfferMatches, ApiError> {
        self.read(&format!("{ACCOUNT}/offers/matches?limit=100&offset=0"), MARKETPLACE).await
    }

    async fn offer_match(&self, id: &str) -> Result<Option<OfferMatch>, ApiError> {
        match self.read(&format!("{ACCOUNT}/offers/matches/{}", segment(id)), MARKETPLACE).await {
            Ok(offer) => Ok(Some(offer)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn acceptance_terms(&self, id: &str, listing: &str) -> Result<AcceptanceTerms, ApiError> {
        let path = format!("{ACCOUNT}/offers/matches/{}/terms-preview?listingId={}", segment(id), segment(listing));
        self.read(&path, MARKETPLACE).await
    }

    async fn sell_list_offer(&self, id: &str) -> Result<Option<OfferMatch>, ApiError> {
        match self.read(&format!("{ACCOUNT}/sell-list/offer-matches/{}", segment(id)), CHECKOUT).await {
            Ok(offer) => Ok(Some(offer)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn decline_offer_match(&self, id: &str, attempt: &str) -> Result<Option<Receipt>, CommandError> {
        let path = format!("{ACCOUNT}/offers/matches/{}/decline", segment(id));
        answer(self.request(Method::POST, &path, MARKETPLACE).json(&serde_json::json!({ "attemptId": attempt }))).await
    }

    async fn accept_offer_match(&self, id: &str, body: &serde_json::Value) -> Result<Option<Receipt>, ApiError> {
        let path = format!("{ACCOUNT}/offers/matches/{}/accept", segment(id));
        Ok(self.write::<serde::de::IgnoredAny>(self.request(Method::POST, &path, MARKETPLACE).json(body)).await?.1)
    }
}

/// An offer the account submitted (`SubmittedOfferListItem`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SubmittedOffer {
    pub offer_id: String,
    pub catalog_catalog_item_id: String,
    pub item_title: String,
    pub item_subtitle: Option<String>,
    pub product_summary: Option<String>,
    pub price_amount: String,
    pub price_currency_code: Option<String>,
    pub quantity_requested: u64,
    /// `submitted` (open), `paused`, `withdrawn` or `accepted`.
    pub status: String,
    pub last_stream_version: u64,
    pub accepted_seller_account_id: Option<String>,
    pub accepted_seller_average_rating: Option<String>,
    pub accepted_seller_review_count: Option<u64>,
    pub updated_at: String,
}

/// How many of the account's offers are in each status (`SubmittedOfferStatusCounts`).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct OfferStatusCounts {
    pub submitted: u64,
    pub paused: u64,
    pub withdrawn: u64,
    pub accepted: u64,
}

/// The account's submitted offers, the first 100 in the status asked for, with every status's count.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubmittedOffers {
    pub items: Vec<SubmittedOffer>,
    pub total: u64,
    pub status_counts: Option<OfferStatusCounts>,
}

/// What a Pause, Resume or Withdraw did to one offer (`SubmittedOfferLifecycleOutcome`): `changed`
/// or `unchanged` with the status and stream version it left, or `rejected` with the API's code.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct LifecycleOutcome {
    pub offer_id: String,
    pub outcome: String,
    pub status: Option<String>,
    pub version: Option<u64>,
    pub code: Option<String>,
}

/// One offer's lifecycle answer (`{ id, version, status, outcome }`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct LifecycleAnswer {
    id: String,
    version: u64,
    status: String,
    outcome: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct BulkLifecycleAnswer {
    items: Vec<LifecycleOutcome>,
}

/// The buyer's submitted offers' calls (marketplace's `account-offers-submitted` route).
pub trait SubmittedOfferCalls {
    /// The first 100 of the account's offers, in `status` (all for none), as marketplace reads them.
    async fn submitted_offers(&self, status: Option<&str>) -> Result<SubmittedOffers, ApiError>;
    /// One of the account's offers (`SubmittedOfferDetail`), or `None` when it is not the
    /// account's (the API's 404).
    async fn submitted_offer(&self, id: &str) -> Result<Option<SubmittedOffer>, ApiError>;
    /// Pause, Resume or Withdraw (`action`) one offer: its outcome, and the write's receipt.
    async fn change_offer(&self, id: &str, action: &str) -> Result<(LifecycleOutcome, Option<Receipt>), ApiError>;
    /// The same for several offers at once (up to 250), each with its outcome.
    async fn change_offers(&self, ids: &[String], action: &str) -> Result<(Vec<LifecycleOutcome>, Option<Receipt>), ApiError>;
}

impl SubmittedOfferCalls for Caller<'_> {
    async fn submitted_offers(&self, status: Option<&str>) -> Result<SubmittedOffers, ApiError> {
        let mut path = format!("{ACCOUNT}/offers/submitted?limit=100&offset=0");
        if let Some(status) = status {
            path.push_str(&format!("&status={}", segment(status)));
        }
        self.read(&path, MARKETPLACE).await
    }

    async fn submitted_offer(&self, id: &str) -> Result<Option<SubmittedOffer>, ApiError> {
        match self.read(&format!("{ACCOUNT}/offers/submitted/{}", segment(id)), MARKETPLACE).await {
            Ok(offer) => Ok(Some(offer)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn change_offer(&self, id: &str, action: &str) -> Result<(LifecycleOutcome, Option<Receipt>), ApiError> {
        let path = format!("{ACCOUNT}/offers/submitted/{}/{}", segment(id), segment(action));
        let (answer, receipt) =
            self.write::<LifecycleAnswer>(self.request(Method::POST, &path, MARKETPLACE).json(&serde_json::json!({}))).await?;
        let outcome = LifecycleOutcome {
            offer_id: if answer.id.is_empty() { id.to_owned() } else { answer.id },
            outcome: answer.outcome,
            status: Some(answer.status),
            version: Some(answer.version),
            code: None,
        };
        Ok((outcome, receipt))
    }

    async fn change_offers(&self, ids: &[String], action: &str) -> Result<(Vec<LifecycleOutcome>, Option<Receipt>), ApiError> {
        let path = format!("{ACCOUNT}/offers/submitted/bulk");
        let body = serde_json::json!({ "action": action, "offerIds": ids });
        let (answer, receipt) =
            self.write::<BulkLifecycleAnswer>(self.request(Method::POST, &path, MARKETPLACE).json(&body)).await?;
        Ok((answer.items, receipt))
    }
}

/// The Seller Desk's attention queue (`SellerAttentionQueue`): the items in the order the API
/// sorts them, the counts by severity, and each source's health.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AttentionQueue {
    pub items: Vec<AttentionItem>,
    pub rollup: AttentionRollup,
    pub sources: Vec<AttentionSource>,
    pub degraded: bool,
}

/// An item of the queue (`SellerAttentionItem`): a semantic `code` and its `params`, which the
/// page puts in its own words, and where to fix it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    pub source: String,
    pub severity: String,
    pub summary: AttentionSummary,
    pub deep_link: AttentionLink,
    #[serde(default)]
    pub due_at: Option<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AttentionSummary {
    pub code: String,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AttentionLink {
    pub surface: String,
    pub href: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AttentionRollup {
    pub total: u64,
    pub by_severity: Severities,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Severities {
    pub critical: u64,
    pub warning: u64,
    pub info: u64,
}

/// A source's health: `available`, or `unavailable` with the API's internal reason.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSource {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub item_count: u64,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The account holder's preferences in Identity (`GET /api/identity/preferences`): the time zone
/// they chose (`UTC` until they choose one).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    #[serde(default)]
    pub time_zone: Option<String>,
}

pub trait PreferenceCalls {
    async fn user_preferences(&self) -> Result<UserPreferences, ApiError>;
}

impl PreferenceCalls for Caller<'_> {
    async fn user_preferences(&self) -> Result<UserPreferences, ApiError> {
        self.read("/api/identity/preferences", IDENTITY).await
    }
}

/// The Seller Desk home's own read.
pub trait DeskCalls {
    async fn seller_attention_queue(&self) -> Result<AttentionQueue, ApiError>;
}

impl DeskCalls for Caller<'_> {
    async fn seller_attention_queue(&self) -> Result<AttentionQueue, ApiError> {
        self.read(&format!("{ACCOUNT}/seller-attention-queue"), MARKETPLACE).await
    }
}

const REPRICING: &str = "/api/marketplace/account/repricing-policies";

/// A policy's scope (`RepricingPolicyScope`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RepricingScope {
    AllListings,
    #[serde(rename_all = "camelCase")]
    CatalogFilter {
        category_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    ListingSet {
        listing_ids: Vec<String>,
    },
}

/// A row of the policy list (`RepricingPolicyListRow`): the fields the list shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingPolicyRow {
    pub policy_id: Option<String>,
    pub name: Option<String>,
    pub scope: Option<RepricingScope>,
    /// `active`, `paused` or `deleted`.
    pub status: String,
    pub max_changes_per_day: Option<u64>,
    #[serde(default)]
    pub changes_used_today: u64,
}

/// The account-wide halt (`RepricingHaltState`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingHalt {
    pub engaged: bool,
    pub engaged_at: Option<String>,
    pub released_at: Option<String>,
}

/// A dry run's counts (`RepricingDryRunSummary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingDryRunSummary {
    pub flags: BTreeMap<String, u64>,
    pub outcomes: BTreeMap<String, u64>,
    pub skip_reasons: BTreeMap<String, u64>,
    pub delta_buckets: BTreeMap<String, u64>,
    pub within_tolerance: u64,
    pub listings_evaluated: u64,
}

/// A dry run (`RepricingDryRun`): the body it evaluated, as the API keeps it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingDryRun {
    pub dry_run_id: String,
    #[serde(default)]
    pub body: serde_json::Value,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    pub requested_at: String,
    pub completed_at: Option<String>,
    pub consumed_at: Option<String>,
    pub summary: Option<RepricingDryRunSummary>,
    pub updated_at: String,
}

impl RepricingDryRun {
    pub fn finished(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

/// The anchor a listing's evaluation used (`RepricingPolicyListingTrace.anchor`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingTraceAnchor {
    pub source: String,
    /// `hard-ask`, `any-ask`, `market-estimate`, `last-sold` or `curve-objective`.
    pub stratum: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RepricingExhaustedAnchor {
    pub source: String,
}

/// Which price limits a listing's evaluation met (`RepricingClampTrace`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingClamps {
    pub floor: bool,
    pub ceiling: bool,
    pub max_move: bool,
    pub evidence_floor: bool,
}

/// One listing's result in a dry run (`RepricingPolicyListingTrace`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingTrace {
    pub listing_id: String,
    #[serde(default)]
    pub rule_index: usize,
    /// `changed`, `skipped`, `pause-requested` or `notify-only`.
    pub outcome: String,
    pub skip_reason: Option<String>,
    pub anchor: Option<RepricingTraceAnchor>,
    #[serde(default)]
    pub exhausted_anchors: Vec<RepricingExhaustedAnchor>,
    #[serde(default)]
    pub flags: Vec<String>,
    #[serde(default)]
    pub clamps: RepricingClamps,
    pub target_price_amount: Option<String>,
    pub current_price_amount: String,
}

/// A policy a scope would overlap, and how many listings (`RepricingScopePreview`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RepricingOverlap {
    pub name: String,
    pub count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingScopePreview {
    pub matching: u64,
    pub governed: u64,
    pub shadowed_by: Vec<RepricingOverlap>,
    pub taken_from: Vec<RepricingOverlap>,
}

/// What the editor starts from (`RepricingAuthoringPrerequisites`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingPrerequisites {
    pub listing_currency_codes: Vec<String>,
    pub has_cost_basis: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingCategory {
    pub id: String,
    pub name: String,
}

/// A repricing policy as Pricing folds it (`RepricingPolicyState`): what its page shows.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingPolicy {
    pub name: Option<String>,
    pub scope: Option<RepricingScope>,
    #[serde(default)]
    pub excluded_listing_ids: Vec<String>,
    #[serde(default)]
    pub rules: Vec<RepricingRule>,
    pub max_changes_per_day: Option<u64>,
    /// `active`, `paused` or `deleted`.
    pub status: String,
    pub updated_at: Option<String>,
}

/// A rule: the conditions a listing must meet, and how it is priced (`RepricingRule`). The first
/// rule a listing meets prices it.
#[derive(Clone, Debug, Deserialize)]
pub struct RepricingRule {
    #[serde(default)]
    pub conditions: Vec<RepricingCondition>,
    pub directive: RepricingDirective,
}

/// A rule's condition (`RepricingRuleCondition`). One Pricing adds later reads as `Other` rather
/// than failing the page, and the page says it cannot show it.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RepricingCondition {
    #[serde(rename_all = "camelCase")]
    Category {
        category_id: String,
    },
    ItemGrading {
        grading: String,
    },
    QuantityAtLeast {
        quantity: f64,
    },
    ListingAgeAtLeast {
        days: f64,
    },
    CostBasisPresent,
    CostBasisAbsent,
    CompetingListingCountAtLeast {
        count: f64,
    },
    #[serde(rename_all = "camelCase")]
    ScheduleWindow {
        #[serde(default)]
        days_of_week: Vec<u8>,
        start_time: String,
        end_time: String,
    },
    #[serde(other)]
    Other,
}

/// How a rule prices a listing (`RepricingRuleDirective`). Its amounts are in `currency_code`; a
/// historical rule without one shows them bare.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingDirective {
    pub currency_code: Option<String>,
    #[serde(default)]
    pub anchor_chain: Vec<RepricingAnchor>,
    pub offset: RepricingOffset,
    pub floor: RepricingFloor,
    pub ceiling: Option<RepricingCeiling>,
    pub tolerance: RepricingTolerance,
    pub rounding: RepricingRounding,
    pub max_move_percent: Option<f64>,
    pub terminal: RepricingTerminal,
}

/// Where a rule's price starts (`RepricingAnchor`), tried in the chain's order.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case")]
pub enum RepricingAnchor {
    MarketEstimate,
    LowestCompetingAsk {
        /// `any` for a listing of any kind, else manual listings only.
        strata: Option<String>,
        band: Option<RepricingBand>,
    },
    CompPercentile {
        percentile: f64,
    },
    LastSold,
    #[serde(rename_all = "camelCase")]
    CurveObjective {
        goal_id: String,
        #[serde(default)]
        parameters: BTreeMap<String, f64>,
    },
    #[serde(other)]
    Other,
}

/// How far below the market estimate a listing of any kind may anchor.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingBand {
    pub min_percent_of_ground: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RepricingOffset {
    Percent {
        percent: f64,
    },
    Absolute {
        amount: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RepricingFloor {
    Absolute {
        amount: String,
    },
    #[serde(rename_all = "camelCase")]
    CostBasisPlusMargin {
        margin_percent: f64,
        absolute_fallback_amount: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RepricingCeiling {
    Absolute {
        amount: String,
    },
    Percent {
        percent: f64,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RepricingTolerance {
    Percent {
        percent: f64,
    },
    Absolute {
        amount: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RepricingRounding {
    None,
    Charm,
    #[serde(rename_all = "camelCase")]
    Increment {
        increment_amount: String,
    },
    #[serde(other)]
    Other,
}

/// What a rule does when no anchor in its chain has a price (`RepricingTerminalBehavior`). A
/// pause's reason is the seller's own text and is not shown.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RepricingTerminal {
    Hold,
    Pause,
    FallbackPrice {
        amount: String,
    },
    PriceAtFloor,
    NotifyOnly,
    #[serde(other)]
    Other,
}

/// The account's changes today (`RepricingBudget`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingBudget {
    pub changes_used: u64,
}

/// A listing's latest evaluation by a policy (`RepricingActivityRow`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepricingActivityRow {
    pub listing_id: String,
    pub evaluated_at: String,
    pub trace: RepricingTrace,
    pub frozen_until: Option<String>,
    /// How many of the product's listings the spiral breaker froze.
    #[serde(default)]
    pub affected_listing_count: u64,
}

/// A page of a policy's activity, the cursor of the next, and each filter's count.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepricingActivityPage {
    pub rows: Vec<RepricingActivityRow>,
    pub next: Option<String>,
    pub filter_counts: BTreeMap<String, u64>,
}

/// A refused dry run or write: the API's error and the messages its `details` carry
/// (`pricingValidationMessages`).
#[derive(Debug)]
pub struct PricingRefusal {
    pub error: ApiError,
    pub details: Vec<String>,
}

impl From<ApiError> for PricingRefusal {
    fn from(error: ApiError) -> Self {
        PricingRefusal { error, details: Vec::new() }
    }
}

/// A write's receipt, or what the API refused it for, with its details.
async fn pricing_answer(req: reqwest::RequestBuilder) -> Result<(serde_json::Value, Option<Receipt>), PricingRefusal> {
    let res = req.send().await.map_err(ApiError::from)?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let receipt = Receipt::from_response(res.headers());
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if status.is_success() {
        return Ok((body, receipt));
    }
    let error = &body["error"];
    let details = error["details"]
        .as_array()
        .map(|details| details.iter().filter_map(|d| d["message"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let error = ApiError::Status {
        status,
        code: error["code"].as_str().filter(|c| !c.is_empty()).map(str::to_owned),
        message: error["message"].as_str().unwrap_or_default().to_owned(),
    };
    Err(PricingRefusal { error, details })
}

/// The Seller Desk repricing page's calls (Pricing's `repricing-policies` routes).
pub trait RepricingCalls {
    async fn repricing_policies(&self) -> Result<Vec<RepricingPolicyRow>, ApiError>;
    async fn repricing_halt(&self) -> Result<RepricingHalt, ApiError>;
    async fn repricing_dry_runs(&self, limit: u32) -> Result<Vec<RepricingDryRun>, ApiError>;
    async fn repricing_prerequisites(&self) -> Result<RepricingPrerequisites, ApiError>;
    async fn repricing_categories(&self) -> Result<Vec<RepricingCategory>, ApiError>;
    /// How many listings a scope matches and whose they are now (a read, posted).
    async fn repricing_scope_preview(&self, input: &serde_json::Value) -> Result<RepricingScopePreview, ApiError>;
    async fn repricing_dry_run(&self, id: &str) -> Result<RepricingDryRun, ApiError>;
    async fn repricing_dry_run_traces(&self, id: &str, after: Option<&str>) -> Result<Vec<RepricingTrace>, ApiError>;
    async fn start_repricing_dry_run(&self, body: &serde_json::Value) -> Result<RepricingDryRun, PricingRefusal>;
    async fn create_repricing_policy(&self, dry_run_id: &str, name: &str) -> Result<Option<Receipt>, PricingRefusal>;
    /// `pause` or `resume` a policy.
    async fn repricing_lifecycle(&self, policy_id: &str, change: &str) -> Result<Option<Receipt>, PricingRefusal>;
    async fn set_repricing_halt(&self, engaged: bool) -> Result<Option<Receipt>, PricingRefusal>;
    async fn repricing_policy(&self, id: &str) -> Result<RepricingPolicy, ApiError>;
    async fn repricing_budget(&self) -> Result<RepricingBudget, ApiError>;
    /// A page of the policy's activity under `filter`, after the listing `after`.
    async fn repricing_activity(
        &self,
        id: &str,
        filter: Option<&str>,
        after: Option<&str>,
    ) -> Result<RepricingActivityPage, ApiError>;
}

impl RepricingCalls for Caller<'_> {
    async fn repricing_policies(&self) -> Result<Vec<RepricingPolicyRow>, ApiError> {
        self.read(REPRICING, PRICING).await
    }

    async fn repricing_halt(&self) -> Result<RepricingHalt, ApiError> {
        self.read(&format!("{REPRICING}/halt"), PRICING).await
    }

    async fn repricing_dry_runs(&self, limit: u32) -> Result<Vec<RepricingDryRun>, ApiError> {
        self.read(&format!("{REPRICING}/dry-runs?limit={limit}"), PRICING).await
    }

    async fn repricing_prerequisites(&self) -> Result<RepricingPrerequisites, ApiError> {
        self.read(&format!("{REPRICING}/authoring-prerequisites"), PRICING).await
    }

    async fn repricing_categories(&self) -> Result<Vec<RepricingCategory>, ApiError> {
        self.read(&format!("{REPRICING}/categories"), PRICING).await
    }

    async fn repricing_scope_preview(&self, input: &serde_json::Value) -> Result<RepricingScopePreview, ApiError> {
        let req = self.request(Method::POST, &format!("{REPRICING}/scope-preview"), PRICING).json(input);
        Ok(self.write(req).await?.0)
    }

    async fn repricing_dry_run(&self, id: &str) -> Result<RepricingDryRun, ApiError> {
        self.read(&format!("{REPRICING}/dry-runs/{}", segment(id)), PRICING).await
    }

    async fn repricing_dry_run_traces(&self, id: &str, after: Option<&str>) -> Result<Vec<RepricingTrace>, ApiError> {
        let after = after.map(|after| format!("&after={}", segment(after))).unwrap_or_default();
        self.read(&format!("{REPRICING}/dry-runs/{}/traces?limit=100{after}", segment(id)), PRICING).await
    }

    async fn start_repricing_dry_run(&self, body: &serde_json::Value) -> Result<RepricingDryRun, PricingRefusal> {
        let req = self.request(Method::POST, &format!("{REPRICING}/dry-runs"), PRICING).json(body);
        let (run, _) = pricing_answer(req).await?;
        serde_json::from_value(run).map_err(|error| {
            PricingRefusal::from(ApiError::Status {
                status: StatusCode::BAD_GATEWAY,
                code: None,
                message: format!("a dry run the page cannot read: {error}"),
            })
        })
    }

    async fn create_repricing_policy(&self, dry_run_id: &str, name: &str) -> Result<Option<Receipt>, PricingRefusal> {
        let body = serde_json::json!({ "dryRunId": dry_run_id, "name": name });
        let req = self.request(Method::POST, REPRICING, PRICING).json(&body);
        Ok(pricing_answer(req).await?.1)
    }

    async fn repricing_lifecycle(&self, policy_id: &str, change: &str) -> Result<Option<Receipt>, PricingRefusal> {
        let req = self.request(Method::POST, &format!("{REPRICING}/{}/{change}", segment(policy_id)), PRICING);
        Ok(pricing_answer(req).await?.1)
    }

    async fn set_repricing_halt(&self, engaged: bool) -> Result<Option<Receipt>, PricingRefusal> {
        let req =
            self.request(Method::POST, &format!("{REPRICING}/halt"), PRICING).json(&serde_json::json!({ "engaged": engaged }));
        Ok(pricing_answer(req).await?.1)
    }

    async fn repricing_policy(&self, id: &str) -> Result<RepricingPolicy, ApiError> {
        self.read(&format!("{REPRICING}/{}", segment(id)), PRICING).await
    }

    async fn repricing_budget(&self) -> Result<RepricingBudget, ApiError> {
        self.read(&format!("{REPRICING}/budget"), PRICING).await
    }

    async fn repricing_activity(
        &self,
        id: &str,
        filter: Option<&str>,
        after: Option<&str>,
    ) -> Result<RepricingActivityPage, ApiError> {
        let query: Vec<String> = [("filter", filter), ("after", after)]
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| format!("{key}={}", segment(value))))
            .collect();
        let query = if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) };
        self.read(&format!("{REPRICING}/{}/activity{query}", segment(id)), PRICING).await
    }
}

const BULK_REPRICE: &str = "/api/marketplace/account/bulk-reprice";

/// A bulk reprice job (`BulkRepriceJobStatus`, a durable job's public snapshot).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkRepriceJob {
    pub job_id: String,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    #[serde(default)]
    pub progress: BulkRepriceProgress,
    pub result: Option<BulkRepriceResult>,
    pub error_message: Option<String>,
}

impl BulkRepriceJob {
    pub fn finished(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BulkRepriceProgress {
    pub completed: u64,
    pub total: u64,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BulkRepriceResult {
    pub applied: u64,
    pub unchanged: u64,
    pub failed: u64,
}

/// Bulk reprice's calls (Pricing's `bulk-reprice` routes). While Pricing has bulk reprice switched
/// off, every one answers 404 (chase-sets/chase-sets#10772).
pub trait BulkRepriceCalls {
    async fn bulk_reprice_job(&self, id: &str) -> Result<BulkRepriceJob, ApiError>;
    /// Start a job for `csv_text` (a file's text and name, or pasted rows).
    async fn start_bulk_reprice(&self, csv_text: &str, filename: Option<&str>) -> Result<BulkRepriceJob, ApiError>;
    async fn cancel_bulk_reprice(&self, id: &str) -> Result<BulkRepriceJob, ApiError>;
    /// The template (`template.csv`) or a job's results (`jobs/{id}/results.csv`), as Pricing sends it.
    async fn bulk_reprice_csv(&self, path: &str) -> Result<reqwest::Response, ApiError>;
}

impl BulkRepriceCalls for Caller<'_> {
    async fn bulk_reprice_job(&self, id: &str) -> Result<BulkRepriceJob, ApiError> {
        self.read(&format!("{BULK_REPRICE}/jobs/{}", segment(id)), PRICING).await
    }

    async fn start_bulk_reprice(&self, csv_text: &str, filename: Option<&str>) -> Result<BulkRepriceJob, ApiError> {
        let body = serde_json::json!({ "csvText": csv_text, "sourceFilename": filename });
        let req = self.request(Method::POST, BULK_REPRICE, PRICING).json(&body);
        let (job, _) = pricing_answer(req).await.map_err(|refusal| refusal.error)?;
        serde_json::from_value(job).map_err(|error| ApiError::Status {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: format!("a bulk reprice job the page cannot read: {error}"),
        })
    }

    async fn cancel_bulk_reprice(&self, id: &str) -> Result<BulkRepriceJob, ApiError> {
        let req = self
            .request(Method::POST, &format!("{BULK_REPRICE}/jobs/{}/cancel", segment(id)), PRICING)
            .json(&serde_json::json!({}));
        let (job, _) = pricing_answer(req).await.map_err(|refusal| refusal.error)?;
        serde_json::from_value(job).map_err(|error| ApiError::Status {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: format!("a bulk reprice job the page cannot read: {error}"),
        })
    }

    async fn bulk_reprice_csv(&self, path: &str) -> Result<reqwest::Response, ApiError> {
        let res = self.request(Method::GET, &format!("{BULK_REPRICE}/{path}"), PRICING).send().await?;
        if res.status().is_success() {
            return Ok(res);
        }
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        Err(ApiError::Status { status, code: None, message: String::new() })
    }
}

const RECOMMENDATIONS: &str = "/api/marketplace/account/recommendations";
const RECOMMENDATION_JOBS: &str = "/api/marketplace/account/recommendation-jobs";

/// A pricing recommendation (`AccountRecommendationListItem`): the fields the page shows.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Recommendation {
    pub recommendation_id: String,
    pub catalog_catalog_item_id: String,
    /// `active-listing-price-update`, `draft-listing-price-update` or `draft-listing-create`.
    pub action_type: String,
    /// `proposed`, `applied`, `dismissed` or `failed`.
    pub status: String,
    pub catalog_item_title: Option<String>,
    pub catalog_item_language_code: Option<String>,
    pub catalog_item_subtitle: Option<String>,
    pub catalog_item_status: Option<String>,
    pub market_price_amount: Option<f64>,
    pub market_currency: String,
    /// `competition` or `offer`.
    pub market_signal_type: String,
    pub current_price_amount: Option<f64>,
    pub recommended_list_amount: Option<f64>,
    pub recommendation_reason: Option<String>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub stock_on_hand_quantity: u64,
    #[serde(default)]
    pub active_listing_count: u64,
    pub lowest_listing_price_amount: Option<f64>,
    #[serde(default)]
    pub active_offer_count: u64,
    pub highest_offer_price_amount: Option<f64>,
    #[serde(default)]
    pub delivered_quantity: u64,
    #[serde(default)]
    pub returned_quantity: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Recommendations {
    pub items: Vec<Recommendation>,
}

/// A recommendation job (`PricingRecommendationJobStatus`): Refresh, Apply or Dismiss.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationJob {
    pub job_id: String,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    #[serde(default)]
    pub progress: BulkRepriceProgress,
    pub error_message: Option<String>,
}

impl RecommendationJob {
    pub fn finished(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }
}

/// The recommendations' calls (Pricing's `recommendations` and `recommendation-jobs` routes).
pub trait RecommendationCalls {
    /// The first 100, as marketplace's loader reads them.
    async fn recommendations(&self) -> Result<Recommendations, ApiError>;
    async fn recommendation_job(&self, id: &str) -> Result<RecommendationJob, ApiError>;
    /// `refresh` (no ids), `apply` or `dismiss` the recommendations `ids`: the job that does it.
    async fn recommendation_command(&self, command: &str, ids: &[String]) -> Result<RecommendationJob, ApiError>;
}

impl RecommendationCalls for Caller<'_> {
    async fn recommendations(&self) -> Result<Recommendations, ApiError> {
        self.read(&format!("{RECOMMENDATIONS}?limit=100&offset=0"), PRICING).await
    }

    async fn recommendation_job(&self, id: &str) -> Result<RecommendationJob, ApiError> {
        self.read(&format!("{RECOMMENDATION_JOBS}/{}", segment(id)), PRICING).await
    }

    async fn recommendation_command(&self, command: &str, ids: &[String]) -> Result<RecommendationJob, ApiError> {
        let body = if command == "refresh" { serde_json::json!({}) } else { serde_json::json!({ "recommendationIds": ids }) };
        let req = self.request(Method::POST, &format!("{RECOMMENDATIONS}/{command}"), PRICING).json(&body);
        let (job, _) = pricing_answer(req).await.map_err(|refusal| refusal.error)?;
        serde_json::from_value(job).map_err(|error| ApiError::Status {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: format!("a recommendation job the page cannot read: {error}"),
        })
    }
}

/// The path of a recommendation job's status stream (server-sent events, each the job).
pub fn recommendation_job_events(id: &str) -> String {
    format!("{RECOMMENDATION_JOBS}/{}/events", segment(id))
}

/// The path of a bulk reprice job's status stream (server-sent events, each the job).
pub fn bulk_reprice_job_events(id: &str) -> String {
    format!("{BULK_REPRICE}/jobs/{}/events", segment(id))
}

/// The path of a dry run's status stream (`/dry-runs/{id}/events`, server-sent `status` events).
pub fn repricing_dry_run_events(id: &str) -> String {
    format!("{REPRICING}/dry-runs/{}/events", segment(id))
}

/// The bounded context the repricing routes read and write, for a request built by hand.
pub const PRICING_CONTEXT: &str = PRICING;

const SETTLEMENT: &str = "settlement";
const PAYOUTS: &str = "/api/settlement/payouts";

/// A movement of the wallet (`SettlementLedgerEntryRow`), the fields the money page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct WalletEntry {
    pub ledger_entry_id: String,
    /// `sale`, `fee`, `payout`, `payout-reversal`, `rebate`, `adjustment`, ...
    pub kind: String,
    pub amount: String,
    pub currency_code: String,
    /// `available` or `pending`.
    pub funds_status: String,
    pub description: Option<String>,
    pub posted_at: String,
    pub adjustment_display_reference: Option<String>,
}

/// A payout (`SettlementPayoutRow`), the fields the money page shows and its rules read.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Payout {
    pub payout_id: String,
    pub display_reference: String,
    /// `requested`, `in-transit`, `completed` or `failed`.
    pub status: String,
    pub requested_amount: String,
    pub fee_amount: String,
    pub net_amount: String,
    pub currency_code: String,
    pub requested_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
    pub completed_at: Option<String>,
    pub failed_at: Option<String>,
    pub failure_reason: Option<String>,
    pub provider_failure_code: Option<String>,
    pub provider_payout_reference: Option<String>,
    /// What the seller wrote with the request.
    pub note: Option<String>,
    pub provider_transfer_reference: Option<String>,
    pub last_provider_event_at: Option<String>,
    pub last_reconciled_at: Option<String>,
}

/// The account's payouts and what Settlement makes of them (`GET /api/settlement/payouts`,
/// `SettlementPayoutSummary`): a page of payouts, whether the summary saw every one, the payout
/// that arrives first, the payouts held from settling, and whether a payout can be requested.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutSummary {
    pub items: Vec<Payout>,
    pub completeness: PayoutCompleteness,
    pub next_payout: Option<NextPayout>,
    pub blocked_payouts: Vec<BlockedPayout>,
    pub availability: PayoutAvailability,
}

impl PayoutSummary {
    /// Whether the summary covers every payout; when it does not, Settlement leaves the next payout
    /// and the blocked ones out.
    pub fn complete(&self) -> bool {
        self.completeness.kind == "complete"
    }
}

/// Whether the summary saw every payout (`PayoutSummaryCompleteness`): `complete`, or
/// `bounded-incomplete` past Settlement's cap.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutCompleteness {
    pub kind: String,
    pub total: u64,
}

impl Default for PayoutCompleteness {
    fn default() -> Self {
        PayoutCompleteness { kind: "complete".into(), total: 0 }
    }
}

/// The payout that arrives first, and when (`PayoutSummaryNextPayout`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct NextPayout {
    pub payout_id: String,
    /// What reaches the seller.
    pub amount: String,
    pub currency_code: String,
    /// ISO 8601, UTC.
    pub estimated_arrival_at: String,
}

/// A payout held from settling (`PayoutSummaryBlockedPayout`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct BlockedPayout {
    pub payout_id: String,
    pub reference: String,
    /// A money status code, or the provider's words for a failure.
    pub block_reason: String,
    /// `failed`, `missing-provider-reference` or `stale-requested`.
    pub kind: String,
    /// The write that is its next step: `retry` or `run-reconciliation`.
    pub next_action: String,
}

/// Whether a payout can be requested, and if not the money status codes that say why
/// (`PayoutAvailability`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutAvailability {
    pub can_request: bool,
    pub unavailable_reasons: Vec<String>,
}

/// Whether the account can be paid out (`SettlementPayoutReadinessRow`), the fields the money and
/// payout setup pages read.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutReadiness {
    /// `ready` once payout setup is complete; `not-started`, `restricted` or another (in progress).
    pub status: String,
    pub missing_requirements: Vec<String>,
    pub advisory_requirements: Vec<String>,
    /// The provider's reason the account is disabled (Stripe's `requirements.disabled_reason`).
    pub disabled_reason: Option<String>,
    pub requirements_deadline: Option<String>,
    pub provider_reference: Option<String>,
    /// `not-started`, `pending` or `complete`.
    pub onboarding_status: String,
    /// `inactive`, `pending` or `active`.
    pub transfer_capability_status: String,
    pub payout_capability_status: String,
    /// `missing`, `pending` or `ready`.
    pub payout_destination_status: String,
    pub updated_at: Option<String>,
    /// Settlement's payout setup decision (`PayoutSetupDecision`): what the seller does next
    /// (`restricted_past_due`, `restricted_review`, `restricted_rejected`, `restricted_paused`,
    /// `restricted`, `platform_review`, `complete_requirements`, `add_destination`,
    /// `provider_review` or `none`), whether to recommend support, and which of Stripe's forms
    /// the seller may open.
    pub next_step: String,
    pub support_recommended: bool,
    pub provider_setup_available: bool,
    pub provider_management_available: bool,
}

/// Payout setup's progress as Settlement works it out (`GET /payout-setup/progress`,
/// `PayoutSetupProgress`): the missing and upcoming requirements by group, and the steps.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutSetupProgress {
    pub missing_requirement_groups: Vec<RequirementGroup>,
    pub advisory_requirement_groups: Vec<RequirementGroup>,
    pub steps: Vec<SetupStep>,
}

/// A group of requirements (`MissingRequirementGroup`): `payout-account`,
/// `identity-and-business`, `account-agreement`, `platform-review` or `verification-review`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RequirementGroup {
    pub id: String,
    pub count: u64,
}

/// A step of payout setup (`PayoutSetupProgressStep`): its words are Settlement's English, as
/// marketplace shows them; `status` is `not-started`, `needs-attention`, `pending` or `ready`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SetupStep {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

/// Which of Stripe's Connect components a session is for, and its Settlement endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectSession {
    /// Account onboarding (`/payout-setup/embedded-session`), with the account's email.
    Onboarding,
    /// Account management (`/payout-setup/account-management-embedded-session`).
    Management,
    /// The notification banner (`/payout-setup/notification-banner-session`).
    Notifications,
}

impl ConnectSession {
    fn path(self) -> &'static str {
        match self {
            ConnectSession::Onboarding => "/api/settlement/payout-setup/embedded-session",
            ConnectSession::Management => "/api/settlement/payout-setup/account-management-embedded-session",
            ConnectSession::Notifications => "/api/settlement/payout-setup/notification-banner-session",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientSecret {
    #[serde(default)]
    client_secret: String,
}

/// The payout amounts the policy in effect offers (`GET /payouts/quick-amounts`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct QuickAmounts {
    pub minimum_amount: String,
    pub maximum_amount: String,
    pub full_available_amount: String,
}

/// What a payout of an amount would be (`SettlementPayoutPreview`): its fees, what reaches the
/// seller, the balance after it, and whether it can be requested and why not.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PayoutPreview {
    pub requested_amount: String,
    pub net_amount: String,
    pub estimated_wallet_balance_after: String,
    pub fee_lines: Vec<FeeLine>,
    pub can_request: bool,
    pub unavailable_reason_details: Vec<ReasonDetail>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct FeeLine {
    pub label: String,
    pub amount: String,
}

/// A reason a payout cannot be requested, in Settlement's words (`MoneyStatusDetail`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReasonDetail {
    pub code: String,
    pub message: String,
}

/// A wallet adjustment as the account sees it (`SettlementWalletAdjustmentAccountDetailRow`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct WalletAdjustment {
    /// `requested`, `approved`, `rejected`, `posted` or `reversed`.
    pub status: String,
    pub display_reference: String,
    /// `credit` or `debit`.
    pub direction: String,
    pub amount: String,
    pub currency_code: String,
    pub reason_code: String,
    pub requested_at: String,
    pub available_balance_after: Option<String>,
}

/// The amount a payout preview is for: one of the policy's quick amounts, which Settlement
/// resolves (`amountSelection`), or one the seller typed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutAmount {
    Selection(&'static str),
    Typed(String),
}

#[derive(Deserialize)]
struct RequestedPayout {
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ReconciliationRun {
    progress: ReconciliationProgress,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ReconciliationProgress {
    message: Option<String>,
}

/// The money page's calls (Settlement's, as marketplace's `account-desk-money` route makes them).
pub trait MoneyCalls {
    async fn balances(&self) -> Result<Wallet, ApiError>;
    /// The wallet's movements, the API's first page, as marketplace's loader reads them.
    async fn wallet_entries(&self) -> Result<Vec<WalletEntry>, ApiError>;
    /// The account's payouts, the API's first page, with Settlement's summary of them.
    async fn payouts(&self) -> Result<PayoutSummary, ApiError>;
    /// One of the account's payouts; `None` when it has none by `id`.
    async fn payout(&self, id: &str) -> Result<Option<Payout>, ApiError>;
    async fn payout_readiness(&self) -> Result<PayoutReadiness, ApiError>;
    async fn payout_setup_progress(&self) -> Result<PayoutSetupProgress, ApiError>;
    /// Ask Settlement to read the account's payout setup from the provider again: the readiness it
    /// now has and the receipt the next read waits for.
    async fn refresh_payout_setup(&self) -> Result<(PayoutReadiness, Option<Receipt>), ApiError>;
    /// A Stripe Connect session's client secret for one of its components. `contact_email` goes
    /// with onboarding only, as marketplace sends it.
    async fn connect_session(&self, session: ConnectSession, contact_email: Option<&str>) -> Result<String, ApiError>;
    async fn payout_quick_amounts(&self) -> Result<QuickAmounts, ApiError>;
    /// The adjustment by its display reference; `None` when the account has none by it.
    async fn wallet_adjustment(&self, reference: &str) -> Result<Option<WalletAdjustment>, ApiError>;
    /// A payout's preview. It writes nothing.
    async fn preview_payout(&self, amount: &PayoutAmount) -> Result<PayoutPreview, ApiError>;
    /// Request a payout: its id and the receipt the next read waits for. `attempt` is the
    /// `Idempotency-Key`, so a request sent again after a lost answer is the same payout.
    async fn request_payout(
        &self,
        attempt: &str,
        amount: &str,
        note: Option<&str>,
    ) -> Result<(String, Option<Receipt>), ApiError>;
    /// Ask Settlement to check the account's payouts with the provider: what it says it did.
    async fn run_payout_reconciliation(&self) -> Result<Option<String>, ApiError>;
}

impl MoneyCalls for Caller<'_> {
    async fn balances(&self) -> Result<Wallet, ApiError> {
        self.read("/api/settlement/wallet", SETTLEMENT).await
    }

    async fn wallet_entries(&self) -> Result<Vec<WalletEntry>, ApiError> {
        let body: Items<WalletEntry> = self.read("/api/settlement/wallet/entries", SETTLEMENT).await?;
        Ok(body.items)
    }

    async fn payouts(&self) -> Result<PayoutSummary, ApiError> {
        self.read(PAYOUTS, SETTLEMENT).await
    }

    async fn payout(&self, id: &str) -> Result<Option<Payout>, ApiError> {
        match self.read(&format!("{PAYOUTS}/{}", segment(id)), SETTLEMENT).await {
            Ok(payout) => Ok(Some(payout)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn payout_readiness(&self) -> Result<PayoutReadiness, ApiError> {
        self.read("/api/settlement/payout-readiness", SETTLEMENT).await
    }

    async fn payout_setup_progress(&self) -> Result<PayoutSetupProgress, ApiError> {
        self.read("/api/settlement/payout-setup/progress", SETTLEMENT).await
    }

    async fn refresh_payout_setup(&self) -> Result<(PayoutReadiness, Option<Receipt>), ApiError> {
        let req = self.request(Method::POST, "/api/settlement/payout-setup/refresh", SETTLEMENT).json(&serde_json::json!({}));
        self.write(req).await
    }

    async fn connect_session(&self, session: ConnectSession, contact_email: Option<&str>) -> Result<String, ApiError> {
        let email = contact_email.map(str::trim).filter(|e| !e.is_empty()).filter(|_| session == ConnectSession::Onboarding);
        let body = match email {
            Some(email) => serde_json::json!({ "contactEmail": email }),
            None => serde_json::json!({}),
        };
        let req = self.request(Method::POST, session.path(), SETTLEMENT).json(&body);
        let (secret, _): (ClientSecret, _) = self.write(req).await?;
        Ok(secret.client_secret)
    }

    async fn payout_quick_amounts(&self) -> Result<QuickAmounts, ApiError> {
        self.read(&format!("{PAYOUTS}/quick-amounts"), SETTLEMENT).await
    }

    async fn wallet_adjustment(&self, reference: &str) -> Result<Option<WalletAdjustment>, ApiError> {
        match self.read(&format!("/api/settlement/wallet/adjustments/{}", segment(reference)), SETTLEMENT).await {
            Ok(adjustment) => Ok(Some(adjustment)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn preview_payout(&self, amount: &PayoutAmount) -> Result<PayoutPreview, ApiError> {
        let body = match amount {
            PayoutAmount::Selection(selection) => serde_json::json!({ "amountSelection": selection }),
            PayoutAmount::Typed(amount) => serde_json::json!({ "amount": amount }),
        };
        let req = self.request(Method::POST, &format!("{PAYOUTS}/preview"), SETTLEMENT).json(&body);
        let (preview, _) = self.write(req).await?;
        Ok(preview)
    }

    async fn request_payout(
        &self,
        attempt: &str,
        amount: &str,
        note: Option<&str>,
    ) -> Result<(String, Option<Receipt>), ApiError> {
        let body = serde_json::json!({ "amount": amount, "destinationReference": null, "note": note });
        let req = self.request(Method::POST, PAYOUTS, SETTLEMENT).header("idempotency-key", attempt).json(&body);
        let (requested, receipt): (RequestedPayout, _) = self.write(req).await?;
        Ok((requested.id, receipt))
    }

    async fn run_payout_reconciliation(&self) -> Result<Option<String>, ApiError> {
        let req = self
            .request(Method::POST, &format!("{PAYOUTS}/reconciliation/run"), SETTLEMENT)
            .json(&serde_json::json!({ "limit": 100 }));
        let (run, _): (ReconciliationRun, _) = self.write(req).await?;
        Ok(run.progress.message.filter(|m| !m.trim().is_empty()))
    }
}

const PAYMENTS: &str = "payments";
const ACCOUNT_PAYMENTS: &str = "/api/marketplace/account/payments";

/// A payment as its buyer reads it (`PaymentsPaymentDetail`, `GET /account/payments/{id}`), the
/// fields the payment page reads. Moments are ISO 8601 (`2026-10-28T13:05:00.123Z`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AccountPayment {
    pub payment_id: String,
    pub buyer_account_id: String,
    pub order_ids: Vec<String>,
    pub amount: String,
    pub balance_credit_amount: String,
    pub processor_amount: String,
    pub marketplace_checkout_fee_amount: String,
    pub payment_method_category: Option<String>,
    pub currency_code: String,
    pub processor_name: String,
    pub processor_payment_reference: String,
    /// The provider's client secret: `cs_..` for a Checkout Session (Stripe's Checkout Elements),
    /// `pi_.._secret_..` for a Payment Intent (the Payment Element).
    pub processor_client_secret: Option<String>,
    pub processor_redirect_url: Option<String>,
    pub processor_status: String,
    pub processor_publishable_key: Option<String>,
    pub source_context: Option<String>,
    pub source_reference_id: Option<String>,
    /// `pending-confirmation`, `captured`, `failed`, `cancelled` or another (in progress).
    pub status: String,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub captured_at: Option<String>,
    pub failed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub provider_events: Vec<ProviderEvent>,
}

/// What the provider told Payments about a payment (`paymentsProviderEventSchema`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ProviderEvent {
    pub provider_event_id: String,
    pub event_kind: String,
    pub received_at: String,
}

/// A payment's order as Payments reads it for its buyer (`PaymentsAccountOrderInput`), the fields
/// the payment page reads.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PaymentOrder {
    pub order_id: String,
    pub buyer_email: Option<String>,
    pub shipping_destination_snapshot: Option<PaymentDestination>,
    pub total_amount: String,
    pub marketplace_sales_fee_amount: String,
    pub seller_payout_amount: String,
    pub sales_tax_amount: Option<String>,
    pub status: String,
    pub payment_deadline_at: Option<String>,
    /// The seller's condition photos committed when an offer was accepted, a set per line.
    pub listing_evidence: Vec<PaymentEvidence>,
}

/// A line's condition photos as the seller committed them when the offer was accepted.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PaymentEvidence {
    pub line_id: String,
    pub item_title: String,
    pub gallery: Vec<GalleryImage>,
}

/// Where an order ships, as the order recorded it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PaymentDestination {
    pub name: String,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct PaymentOrders {
    #[serde(default)]
    orders: Vec<PaymentOrder>,
}

/// The payment page's reads.
pub trait PaymentCalls {
    /// The buyer's payment; `None` when the account has none by `id`.
    async fn account_payment(&self, id: &str) -> Result<Option<AccountPayment>, ApiError>;
    /// The payment's orders (`GET /account/order-inputs?orderIds=..`).
    async fn payment_orders(&self, ids: &[String]) -> Result<Vec<PaymentOrder>, ApiError>;
    /// What Payments quotes for paying a payment's orders again (`GET /account/checkout/status`),
    /// with its wallet credit and method.
    async fn checkout_status(&self, payment: &AccountPayment) -> Result<PaymentPreview, ApiError>;
    /// What Payments quotes for paying `order_ids` (`GET /account/checkout/status`), `credit` of it
    /// from the wallet (none when `None`), by `method`.
    async fn quote(
        &self,
        order_ids: &[String],
        currency: &str,
        credit: Option<&str>,
        method: &str,
    ) -> Result<PaymentPreview, ApiError>;
    /// A payment for `order_ids` at the quote `fingerprint` (`POST /account/payments`, marketplace's
    /// Start payment), `credit` of it from the wallet.
    async fn start_payment(
        &self,
        order_ids: &[String],
        credit: Option<&str>,
        method: &str,
        fingerprint: &str,
    ) -> Result<(AccountPayment, Option<Receipt>), ApiError>;
    /// A new payment for a failed or closed one's orders at the quote `fingerprint`
    /// (`POST /account/checkout/recover`), the provider sent back to `return_path`.
    async fn recover_payment(
        &self,
        payment: &AccountPayment,
        fingerprint: &str,
        return_path: &str,
    ) -> Result<(AccountPayment, Option<Receipt>), ApiError>;
}

impl PaymentCalls for Caller<'_> {
    async fn account_payment(&self, id: &str) -> Result<Option<AccountPayment>, ApiError> {
        match self.read(&format!("{ACCOUNT_PAYMENTS}/{}", segment(id)), PAYMENTS).await {
            Ok(payment) => Ok(Some(payment)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn payment_orders(&self, ids: &[String]) -> Result<Vec<PaymentOrder>, ApiError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = ids.iter().map(|id| segment(id)).collect::<Vec<_>>().join(",");
        let orders: PaymentOrders = self.read(&format!("/api/marketplace/account/order-inputs?orderIds={ids}"), PAYMENTS).await?;
        Ok(orders.orders)
    }

    async fn checkout_status(&self, payment: &AccountPayment) -> Result<PaymentPreview, ApiError> {
        let method = payment.payment_method_category.as_deref().unwrap_or("card");
        self.quote(&payment.order_ids, &payment.currency_code, Some(&payment.balance_credit_amount), method).await
    }

    async fn quote(
        &self,
        order_ids: &[String],
        currency: &str,
        credit: Option<&str>,
        method: &str,
    ) -> Result<PaymentPreview, ApiError> {
        let ids = order_ids.iter().map(|id| segment(id)).collect::<Vec<_>>().join(",");
        let credit = credit.map(|c| format!("&requestedBalanceCreditAmount={}", segment(c))).unwrap_or_default();
        let path = format!(
            "/api/marketplace/account/checkout/status?orderIds={ids}&currencyCode={}{credit}&paymentMethodCategory={}",
            segment(currency),
            segment(method)
        );
        self.read(&path, PAYMENTS).await
    }

    async fn start_payment(
        &self,
        order_ids: &[String],
        credit: Option<&str>,
        method: &str,
        fingerprint: &str,
    ) -> Result<(AccountPayment, Option<Receipt>), ApiError> {
        let body = serde_json::json!({
            "orderIds": order_ids,
            "requestedBalanceCreditAmount": credit,
            "paymentMethodCategory": method,
            "marketplaceCheckoutFeeQuoteFingerprint": fingerprint,
        });
        self.write(self.request(Method::POST, ACCOUNT_PAYMENTS, PAYMENTS).json(&body)).await
    }

    async fn recover_payment(
        &self,
        payment: &AccountPayment,
        fingerprint: &str,
        return_path: &str,
    ) -> Result<(AccountPayment, Option<Receipt>), ApiError> {
        let body = serde_json::json!({
            "orderIds": payment.order_ids,
            "currencyCode": payment.currency_code,
            "requestedBalanceCreditAmount": payment.balance_credit_amount,
            "paymentMethodCategory": payment.payment_method_category.as_deref().unwrap_or("card"),
            "marketplaceCheckoutFeeQuoteFingerprint": fingerprint,
            "returnUrlPath": return_path,
        });
        self.write(self.request(Method::POST, "/api/marketplace/account/checkout/recover", PAYMENTS).json(&body)).await
    }
}

const PAYMENT_METHODS: &str = "/api/marketplace/account/payment-methods";

/// A saved payment method as its account manages it (`savedCheckoutInstrumentSnapshot` with the
/// management fields, `GET /account/payment-methods`), the fields the page reads.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct PaymentMethod {
    pub instrument_id: String,
    pub account_id: String,
    /// `card`, `bank-account` or `platform-credit`.
    pub payment_method_category: String,
    pub display_label: String,
    /// `ready`, `setup-required` or `removed`.
    pub readiness: String,
    pub is_default: bool,
    pub updated_at: String,
}

/// A setup session for a new payment method (`savedCheckoutSetupSessionSnapshot`): Stripe's
/// SetupIntent secret and the publishable key its fields mount with, or a page of the provider's.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SetupSession {
    pub setup_reference_id: String,
    pub processor_client_secret: Option<String>,
    pub processor_redirect_url: Option<String>,
    pub processor_publishable_key: Option<String>,
}

#[derive(Deserialize)]
struct SetupReconciled {
    #[serde(default)]
    instrument: Option<PaymentMethod>,
}

/// A change to a saved payment method (`POST /account/payment-methods/{id}/default` or `/remove`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MethodChange {
    Default,
    Remove,
}

/// The payment methods page's calls. Each write is a Saved Checkout Instrument Attempt: the body
/// names the account the page was drawn for (`account_changed` when it is not the caller's) and
/// the attempt, which Payments applies once.
pub trait PaymentMethodCalls {
    /// The account's payment methods, removed ones too.
    async fn payment_methods(&self) -> Result<Vec<PaymentMethod>, ApiError>;
    /// What came of a setup: the payment method it saved, or `None` while the provider has not said.
    async fn reconcile_setup(&self, setup: &str) -> Result<Option<PaymentMethod>, ApiError>;
    /// Ask the provider again about every payment method (Refresh).
    async fn reconcile_payment_methods(&self) -> Result<(), ApiError>;
    /// Start adding a payment method, coming back to `return_path`.
    async fn start_setup(&self, account: &str, attempt: &str, return_path: &str) -> Result<SetupSession, ApiError>;
    /// Make a payment method the default, or remove it; the receipt the next read waits for.
    async fn change_payment_method(
        &self,
        change: MethodChange,
        instrument: &str,
        account: &str,
        attempt: &str,
    ) -> Result<Option<Receipt>, ApiError>;
}

impl PaymentMethodCalls for Caller<'_> {
    async fn payment_methods(&self) -> Result<Vec<PaymentMethod>, ApiError> {
        let body: Items<PaymentMethod> = self.read(PAYMENT_METHODS, PAYMENTS).await?;
        Ok(body.items)
    }

    async fn reconcile_setup(&self, setup: &str) -> Result<Option<PaymentMethod>, ApiError> {
        let path = format!("{PAYMENT_METHODS}/setup-sessions/{}/reconcile", segment(setup));
        let req = self.request(Method::POST, &path, PAYMENTS).json(&serde_json::json!({}));
        let (body, _): (SetupReconciled, _) = self.write(req).await?;
        Ok(body.instrument)
    }

    async fn reconcile_payment_methods(&self) -> Result<(), ApiError> {
        let req = self.request(Method::POST, &format!("{PAYMENT_METHODS}/reconcile"), PAYMENTS).json(&serde_json::json!({}));
        let _: (serde_json::Value, _) = self.write(req).await?;
        Ok(())
    }

    async fn start_setup(&self, account: &str, attempt: &str, return_path: &str) -> Result<SetupSession, ApiError> {
        let body = serde_json::json!({ "accountId": account, "attemptId": attempt, "returnUrlPath": return_path });
        let req = self.request(Method::POST, &format!("{PAYMENT_METHODS}/setup-sessions"), PAYMENTS).json(&body);
        let (setup, _) = self.write(req).await?;
        Ok(setup)
    }

    async fn change_payment_method(
        &self,
        change: MethodChange,
        instrument: &str,
        account: &str,
        attempt: &str,
    ) -> Result<Option<Receipt>, ApiError> {
        let verb = match change {
            MethodChange::Default => "default",
            MethodChange::Remove => "remove",
        };
        let path = format!("{PAYMENT_METHODS}/{}/{verb}", segment(instrument));
        let body = serde_json::json!({ "accountId": account, "attemptId": attempt });
        let (_, receipt): (serde_json::Value, _) = self.write(self.request(Method::POST, &path, PAYMENTS).json(&body)).await?;
        Ok(receipt)
    }
}

const SUPPORT: &str = "platform-operations";
const SUPPORT_REQUESTS: &str = "/api/marketplace/support-requests";

/// A Support Request as its participant reads it (`SupportRequestDetailResponse`: Platform
/// Operations' detail row and its flow, already scoped to the viewer's role), the fields the page
/// reads. Moments are as the read model writes them (`2026-10-28 13:05:00.123+00`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SupportRequest {
    pub support_request_id: String,
    pub display_reference: String,
    pub order_id: String,
    pub buyer_account_id: String,
    pub seller_account_id: String,
    pub status: String,
    pub opened_by_account_id: String,
    pub opened_by_role: String,
    pub opened_at: String,
    pub seller_response_due_at: Option<String>,
    pub support_review_due_at: Option<String>,
    pub seller_condition_attestation_due_at: Option<String>,
    pub checklist: Vec<SupportChecklistItem>,
    pub pending_offer: Option<SupportOffer>,
    pub resolution: Option<SupportResolution>,
    pub closed_at: Option<String>,
    pub escalated_at: Option<String>,
    pub escalation_reason: Option<String>,
    /// Whether a remedy runs: the page reads only that there is one.
    pub remedy: Option<serde_json::Value>,
    /// `RemedyCasePresentation`: `decision-pending`, `remedy-in-progress`, ...
    pub case_presentation: String,
    pub evidence: Vec<SupportEvidence>,
    pub responses: Vec<SupportResponse>,
    pub offers: Vec<SupportOffer>,
    pub flow: SupportFlow,
    /// Who acts next, the deadline in effect and what the viewer may do, as the API decides them.
    #[serde(rename = "participantPolicy")]
    pub participant_policy: SupportParticipantPolicy,
}

/// `SupportParticipantPolicy`: who acts next (`buyer`, `seller`, `support`, or nobody once the
/// case is over), the deadline that party works against, and the viewer's actions, empty unless
/// the viewer acts next.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportParticipantPolicy {
    pub next_actor: Option<String>,
    pub deadline_at: Option<String>,
    pub actions: Vec<SupportParticipantAction>,
}

/// One action the policy allows: `submit-evidence` (with its checklist item), `accept-offer`,
/// `decline-offer`, `record-response`, `escalate` or `cancel`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportParticipantAction {
    pub kind: String,
    pub checklist_item_key: Option<String>,
}

/// The request's flow, as the API projects it for the viewer (`SupportFlowDetail`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportFlow {
    pub flow_type: String,
    pub title: String,
    pub automation_summary: String,
    /// The responses the viewer may record: none for a buyer, nor for a seller once escalated.
    pub allowed_responses: Vec<String>,
}

/// A checklist item (`SupportChecklistItem`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportChecklistItem {
    pub key: String,
    pub label: String,
    /// `buyer`, `seller` or `support`.
    pub owner_role: String,
    pub evidence_types: Vec<String>,
    pub required: bool,
    pub satisfied_at: Option<String>,
}

/// A piece of evidence (`SupportEvidence`), the fields the timeline shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportEvidence {
    pub evidence_id: String,
    pub summary: String,
    pub submitted_at: String,
}

/// A response (`SupportResponse`); one that made an offer is shown as its offer.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportResponse {
    pub response_id: String,
    pub summary: String,
    pub submitted_at: String,
    pub offer_id: Option<String>,
}

/// An offer (`SupportOffer`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportOffer {
    pub offer_id: String,
    pub pending_with_role: String,
    pub resolution_type: String,
    pub refund_amount: Option<String>,
    pub summary: String,
    pub offered_at: String,
    /// `pending`, `accepted` or `declined`.
    pub status: String,
    pub decided_at: Option<String>,
    pub decision_summary: Option<String>,
}

/// How the request was resolved (`SupportResolution`), the fields shown.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportResolution {
    pub resolution_type: String,
    pub summary: String,
    pub refund_amount: Option<String>,
    pub resolved_at: String,
}

/// A participant write as Platform Operations takes it (`participantActions`): what it is, the
/// request it is on, its body as sent and its canonical request, whose hash the API checks.
#[derive(Clone, Debug)]
pub struct ParticipantWrite {
    /// `submit-evidence`, `record-response`, `accept-offer`, `decline-offer`, `escalate`, `cancel`.
    pub action_kind: &'static str,
    pub path: String,
    pub body: serde_json::Value,
    /// `canonicalParticipantRequest`'s text.
    pub canonical: String,
}

/// What `GET .../participant-attempts/{attempt}` says of an attempt (`ParticipantLookup`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantLookup {
    /// `committed`, `confirming`, `not-recorded` or `unknown`.
    pub outcome: String,
    #[serde(default)]
    pub action_kind: Option<String>,
    #[serde(default)]
    pub result: Option<ParticipantResult>,
}

/// The applied attempt's result (`ParticipantResult`), the field the page compares.
#[derive(Clone, Debug, Deserialize)]
pub struct ParticipantResult {
    pub id: String,
}

/// A Support Request participant page's calls (Platform Operations', as marketplace's
/// `account-support-detail` route makes them).
pub trait SupportCalls {
    async fn support_request(&self, id: &str) -> Result<SupportRequest, ApiError>;
    /// Sends `write` as `attempt` (`Idempotency-Key`) with its request hash
    /// (`X-Support-Request-Hash`): the receipt the next read waits for.
    async fn participant_write(&self, write: &ParticipantWrite, attempt: &str, hash: &str) -> Result<Option<Receipt>, ApiError>;
    /// What the API recorded for `attempt` on request `id`, and the receipt of its write.
    async fn participant_attempt(
        &self,
        id: &str,
        action_kind: &str,
        attempt: &str,
        hash: &str,
    ) -> Result<(ParticipantLookup, Option<Receipt>), ApiError>;
}

impl SupportCalls for Caller<'_> {
    async fn support_request(&self, id: &str) -> Result<SupportRequest, ApiError> {
        self.read(&format!("{SUPPORT_REQUESTS}/{}", segment(id)), SUPPORT).await
    }

    async fn participant_write(&self, write: &ParticipantWrite, attempt: &str, hash: &str) -> Result<Option<Receipt>, ApiError> {
        let req = self
            .request(Method::POST, &format!("{SUPPORT_REQUESTS}{}", write.path), SUPPORT)
            .header("idempotency-key", attempt)
            .header("x-support-request-hash", hash)
            .json(&write.body);
        let (_, receipt): (serde_json::Value, _) = self.write(req).await?;
        Ok(receipt)
    }

    async fn participant_attempt(
        &self,
        id: &str,
        action_kind: &str,
        attempt: &str,
        hash: &str,
    ) -> Result<(ParticipantLookup, Option<Receipt>), ApiError> {
        let path = format!(
            "{SUPPORT_REQUESTS}/{}/participant-attempts/{}?requestHash={hash}&actionKind={}",
            segment(id),
            segment(attempt),
            segment(action_kind),
        );
        let (lookup, headers) = self.read_with_headers(&path, SUPPORT).await?;
        Ok((lookup, Receipt::from_response(&headers)))
    }
}

/// A flow a case can be opened in (`SupportFlowSummary`, Platform Operations' flow catalog), the
/// fields the list page reads.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportFlowSummary {
    pub flow_type: String,
    pub title: String,
    /// Who may open it: `buyer`, `seller`.
    pub opened_by: Vec<String>,
    pub post_delivery_open_window_days: Option<u32>,
    /// `None` when support owns the response.
    pub seller_response_hours: Option<u32>,
    pub checklist: Vec<SupportChecklistItem>,
    pub default_resolution: String,
    pub automation_summary: String,
}

/// An order a case can be opened for (`SupportOrderLookup`): the viewer's part in it, its lines,
/// and the case already open for it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportOrderLookup {
    pub order_id: String,
    /// `buyer` or `seller`.
    pub opened_by_role: String,
    pub status: String,
    pub total_amount: String,
    pub lines: Vec<SupportOrderLine>,
    pub existing_open_request: Option<ExistingCase>,
}

/// An order's line, as the intake lists it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupportOrderLine {
    pub line_id: String,
    pub item_title: String,
    pub product_summary: Option<String>,
    pub quantity: u32,
    pub amount: String,
    pub currency_code: String,
}

/// The case already open for an order.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExistingCase {
    pub support_request_id: String,
    pub display_reference: String,
    pub flow_type: String,
    pub status: String,
}

/// A case in the buyer's or the seller's list (`CustomerSupportRequestListRow`), the fields the list
/// draws: its next deadline and its remedy's status for the list's side are the API's.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SupportCaseRow {
    #[serde(rename = "nextDeadline")]
    pub next_deadline: Option<String>,
    #[serde(rename = "customerRemedyStatus")]
    pub customer_remedy_status: Option<CustomerRemedyStatus>,
    pub support_request_id: String,
    pub display_reference: String,
    pub order_id: String,
    pub flow_type: String,
    pub status: String,
    pub priority: String,
    pub seller_response_due_at: Option<String>,
    pub support_review_due_at: Option<String>,
    pub seller_condition_attestation_due_at: Option<String>,
    pub checklist: Vec<SupportChecklistItem>,
    pub return_shipping: Option<ReturnShipping>,
}

/// Where a case's remedy stands for the list's side (`CustomerRemedyState`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum RemedyState {
    #[serde(rename = "proposed-under-review")]
    Proposed,
    #[serde(rename = "awaiting-coverage-approval")]
    AwaitingCoverage,
    #[serde(rename = "return-label-ready")]
    LabelReady,
    #[serde(rename = "in-transit")]
    InTransit,
    #[serde(rename = "awaiting-intake")]
    AwaitingIntake,
    #[serde(rename = "refund-submitted")]
    RefundSubmitted,
    #[serde(rename = "refund-confirmed")]
    RefundConfirmed,
    #[serde(rename = "settlement-reconciliation-pending")]
    ReconciliationPending,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "expired-deadline")]
    Expired,
    #[serde(rename = "carrier-exception")]
    CarrierException,
    #[serde(rename = "refund-failure")]
    RefundFailure,
    #[serde(rename = "manual-review")]
    ManualReview,
    #[default]
    #[serde(rename = "resolution-in-progress", other)]
    InProgress,
}

/// A case's remedy as its buyer or seller sees it (`CustomerRemedyStatusProjection`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomerRemedyStatus {
    pub state: RemedyState,
    pub terminal: bool,
    /// `underReview`, `fullRefund`, `partialRefund`, `sellerFunded`, `completedCovered` or `covered`.
    pub outcome: String,
    /// `full`, `partial` or none.
    pub coverage: Option<String>,
    pub no_fault_finding: bool,
    /// `return-to-platform`, `return-to-seller` or none.
    pub return_directive: Option<String>,
    /// `carrier-accepted`, `delivered`, `facility-intake`, `operator-release` or immediate.
    pub refund_trigger: Option<String>,
    /// `ship`, `waitForLabel`, `followSupport`, `refundFailure`, `none` or none.
    pub next_action: Option<String>,
    pub amount: String,
    pub currency_code: String,
    pub seller_amount: String,
    pub platform_amount: String,
    pub allocation_currency_code: String,
}

/// A case's return shipment (`return_shipping`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ReturnShipping {
    pub status: String,
    /// `pending`, `ready`, `failed` or `voided`.
    pub label_status: String,
    /// `buyer` or `seller`.
    pub cost_payer: String,
    pub tracking_identifier: Option<String>,
    pub label_document_url: Option<String>,
    pub postage_amount_cents: Option<i64>,
    pub postage_currency: Option<String>,
}

/// Which of the account's cases a list reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseSide {
    /// The cases on its purchases (it is the buyer).
    Purchases,
    /// The cases on its sales.
    Sales,
}

#[derive(Deserialize)]
struct CaseItems<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Opened {
    id: String,
}

#[derive(Deserialize)]
struct UploadedPhotos {
    #[serde(default)]
    attachments: Vec<UploadedPhoto>,
}

#[derive(Deserialize)]
struct UploadedPhoto {
    reference: String,
}

/// The support list page's calls (Platform Operations', as marketplace's `account-support` route
/// makes them).
pub trait SupportListCalls {
    async fn support_flows(&self) -> Result<Vec<SupportFlowSummary>, ApiError>;
    async fn support_cases(&self, side: CaseSide) -> Result<Vec<SupportCaseRow>, ApiError>;
    async fn support_order(&self, order_id: &str) -> Result<SupportOrderLookup, ApiError>;
    /// Opens a case (`open-support-request`) as `attempt` with its request hash: the case's id
    /// and the receipt the next read waits for.
    async fn open_case(&self, body: &serde_json::Value, attempt: &str, hash: &str)
    -> Result<(String, Option<Receipt>), ApiError>;
    /// What the API recorded for an open's `attempt`, which names no case.
    async fn open_attempt(&self, attempt: &str, hash: &str) -> Result<(ParticipantLookup, Option<Receipt>), ApiError>;
    /// Stages an open's photos as one batch under its participant attempt, before the case exists
    /// (`stageParticipantIntakeAttachments`, `x-support-attachment-operation-id`): their references,
    /// which the open then names as `intakePhotoReferences`.
    async fn stage_intake_photos(
        &self,
        attempt: &str,
        operation: &str,
        order: &str,
        flow: &str,
        lines: &[String],
        photos: &[Photo],
    ) -> Result<Vec<String>, ApiError>;
}

impl SupportListCalls for Caller<'_> {
    async fn support_flows(&self) -> Result<Vec<SupportFlowSummary>, ApiError> {
        let body: CaseItems<SupportFlowSummary> = self.read(&format!("{SUPPORT_REQUESTS}/flows"), SUPPORT).await?;
        Ok(body.items)
    }

    async fn support_cases(&self, side: CaseSide) -> Result<Vec<SupportCaseRow>, ApiError> {
        let side = match side {
            CaseSide::Purchases => "purchases",
            CaseSide::Sales => "sales",
        };
        let body: CaseItems<SupportCaseRow> = self.read(&format!("{SUPPORT_REQUESTS}/{side}"), SUPPORT).await?;
        Ok(body.items)
    }

    async fn support_order(&self, order_id: &str) -> Result<SupportOrderLookup, ApiError> {
        self.read(&format!("{SUPPORT_REQUESTS}/orders/{}", segment(order_id)), SUPPORT).await
    }

    async fn open_case(
        &self,
        body: &serde_json::Value,
        attempt: &str,
        hash: &str,
    ) -> Result<(String, Option<Receipt>), ApiError> {
        let req = self
            .request(Method::POST, SUPPORT_REQUESTS, SUPPORT)
            .header("idempotency-key", attempt)
            .header("x-support-request-hash", hash)
            .json(body);
        let (opened, receipt): (Opened, _) = self.write(req).await?;
        Ok((opened.id, receipt))
    }

    async fn open_attempt(&self, attempt: &str, hash: &str) -> Result<(ParticipantLookup, Option<Receipt>), ApiError> {
        let path = format!("{SUPPORT_REQUESTS}/participant-attempts/{}?requestHash={hash}", segment(attempt));
        let (lookup, headers) = self.read_with_headers(&path, SUPPORT).await?;
        Ok((lookup, Receipt::from_response(&headers)))
    }

    async fn stage_intake_photos(
        &self,
        attempt: &str,
        operation: &str,
        order: &str,
        flow: &str,
        lines: &[String],
        photos: &[Photo],
    ) -> Result<Vec<String>, ApiError> {
        let mut form = reqwest::multipart::Form::new()
            .text("attemptId", attempt.to_owned())
            .text("orderId", order.to_owned())
            .text("flowType", flow.to_owned());
        for line in lines {
            form = form.text("affectedLineIds", line.clone());
        }
        for photo in photos {
            form = form.part("attachments", photo_part(photo)?);
        }
        let path = format!("{SUPPORT_REQUESTS}/participant-attempts/{}/attachments", segment(attempt));
        let req = self
            .request(Method::POST, &path, SUPPORT)
            .header("x-support-attachment-operation-id", operation)
            .timeout(UPLOAD_TIMEOUT)
            .multipart(form);
        let (uploaded, _): (UploadedPhotos, _) = self.write(req).await?;
        Ok(uploaded.attachments.into_iter().map(|a| a.reference).collect())
    }
}

/// The account's import batches (`/api/inventory/import-batches`, Inventory's import-batches API).
const IMPORTS: &str = "/api/inventory/import-batches";

/// A page of import batches (`ListResponse<InventoryImportBatch>`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportBatchList {
    pub items: Vec<ImportBatch>,
}

/// An import batch (`InventoryImportBatch`), the fields the page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportBatch {
    pub batch_id: String,
    /// `uploaded`, `validating`, `ready-to-commit`, `committing`, `partial`, `committed`,
    /// `failed-safe` or `expired`.
    pub status: String,
    pub source_key: String,
    pub adapter_version: u64,
    pub quantity_mode: String,
    pub default_storage_location_id: Option<String>,
    pub total_count: u64,
    pub accepted_count: u64,
    pub rejected_count: u64,
    pub committed_count: u64,
    pub updated_at: String,
}

/// A batch with a page of its rows (`InventoryImportBatchDetail`). Inventory says whether Commit
/// can run and how many rows it would commit.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ImportBatchDetail {
    #[serde(flatten)]
    pub batch: ImportBatch,
    #[serde(default)]
    pub can_commit: bool,
    #[serde(default)]
    pub commit_ready_count: u64,
    #[serde(default)]
    pub rows: Vec<ImportRow>,
}

/// What resolving a row answers (`InventoryImportBatchResolution`): the batch, of which the page
/// needs only the next row that still needs the seller.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportResolution {
    pub next_needs_seller_row_id: Option<String>,
}

/// A row of a batch (`InventoryImportBatchRow`), the fields the page shows.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportRow {
    pub row_id: String,
    pub row_number: u64,
    /// `accepted`, `rejected` or `committed`.
    pub status: String,
    pub external_reference: Option<ExternalReference>,
    pub row_fingerprint: String,
    pub quantity_mode: String,
    pub quantity_delta: Option<i64>,
    pub set_quantity: Option<i64>,
    pub total_quantity: Option<i64>,
    pub resolution_status: String,
    pub catalog_item_id: Option<String>,
    pub product_id: Option<String>,
    /// The options the row named, as the API takes them.
    pub selected_options: Vec<Selected>,
    pub storage_location_id: Option<String>,
    pub listing_price_amount: Option<String>,
    pub listing_price_currency_code: Option<String>,
    pub listing_quantity_cap: Option<i64>,
    pub row_note: Option<String>,
    pub validation_errors: Vec<String>,
    pub committed_inventory_item_id: Option<String>,
    pub committed_listing_id: Option<String>,
    pub committed_at: Option<String>,
    /// Inventory's answer to whether the row still needs the seller.
    pub needs_seller: bool,
}

/// Where a row came from in another system (`InventoryImportExternalReference`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalReference {
    pub provider_key: String,
    pub external_key: String,
    pub display_name: Option<String>,
}

/// An import job (`InventoryImportBatchJobStatus`, a durable job's public snapshot).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportJob {
    pub job_id: String,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    pub progress: ImportProgress,
    pub result: Option<ImportJobResult>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ImportProgress {
    pub message: Option<String>,
}

/// What a finished job made: its batch and the receipt of its write.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportJobResult {
    pub batch: Option<JobBatch>,
    #[serde(skip_serializing)]
    pub command_receipt: Option<CommandReceipt>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct JobBatch {
    pub batch_id: String,
}

/// A write's receipt in its body (`CommandReceiptMetadata`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub commit_position: Option<String>,
    pub commit_positions: Box<serde_json::value::RawValue>,
}

impl ImportJob {
    /// The receipt of the job's write, for the read after it.
    pub fn receipt(&self) -> Option<Receipt> {
        let receipt = self.result.as_ref()?.command_receipt.as_ref()?;
        Receipt::of_metadata(receipt.commit_position.as_deref(), &receipt.commit_positions)
    }
}

/// A new import, as marketplace's action sends it: the CSV's text (the file's, else the pasted
/// rows), its source, how quantities apply and the default storage location.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewImport {
    pub csv_text: String,
    pub source_key: String,
    pub quantity_mode: String,
    pub default_storage_location_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_filename: Option<String>,
}

/// A row's fix (`resolveRow`'s body): the catalog item, its options and where the stock is.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowFix {
    pub catalog_item_id: String,
    pub selected_options: Vec<Selected>,
    pub storage_location_id: String,
}

/// The import screen's calls.
pub trait Imports {
    /// The 25 latest batches (`limit=25&offset=0`, as marketplace's loader reads them).
    async fn import_batches(&self) -> Result<ImportBatchList, ApiError>;
    /// A batch with 100 of its rows from `offset`.
    async fn import_batch(&self, id: &str, offset: u64) -> Result<ImportBatchDetail, ApiError>;
    /// A job, or `None` when it is not the caller's to read (the API's 404).
    async fn import_job(&self, id: &str) -> Result<Option<ImportJob>, ApiError>;
    /// Start a batch's validation, as `attempt` (`Inventory-Mutation-Attempt`): a repeat is the same job.
    async fn create_import(&self, attempt: &str, body: &NewImport) -> Result<ImportJob, ApiError>;
    /// Start committing a batch's accepted rows, as `attempt` (`Inventory-Mutation-Attempt`, which
    /// the API requires).
    async fn commit_import(&self, id: &str, attempt: &str) -> Result<ImportJob, ApiError>;
    /// Resolve a rejected row to a catalog item, its options and a storage location: the batch
    /// as it now is, or the API's refusal (400).
    async fn resolve_import_row(&self, batch: &str, row: &str, body: &RowFix) -> Result<ImportResolution, ApiError>;
    /// The storage locations a row or a batch may name (`limit=100&offset=0`, not archived).
    async fn import_locations(&self) -> Result<LocationList, ApiError>;
    /// The native template or the account's inventory as CSV (`templates/native-csv`,
    /// `exports/native-csv`): the API's answer as it came, to pass on.
    async fn import_csv(&self, which: &str) -> Result<reqwest::Response, ApiError>;
}

impl Imports for Caller<'_> {
    async fn import_batches(&self) -> Result<ImportBatchList, ApiError> {
        self.read(&format!("{IMPORTS}?limit=25&offset=0"), INVENTORY).await
    }

    async fn import_batch(&self, id: &str, offset: u64) -> Result<ImportBatchDetail, ApiError> {
        self.read(&format!("{IMPORTS}/{}?limit=100&offset={offset}", segment(id)), INVENTORY).await
    }

    async fn import_job(&self, id: &str) -> Result<Option<ImportJob>, ApiError> {
        match self.read(&format!("{IMPORTS}/jobs/{}", segment(id)), INVENTORY).await {
            Ok(job) => Ok(Some(job)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn create_import(&self, attempt: &str, body: &NewImport) -> Result<ImportJob, ApiError> {
        let req = self.request(Method::POST, IMPORTS, INVENTORY).header(ATTEMPT_HEADER, attempt).json(body);
        Ok(self.write(req).await?.0)
    }

    async fn commit_import(&self, id: &str, attempt: &str) -> Result<ImportJob, ApiError> {
        let path = format!("{IMPORTS}/{}/commit", segment(id));
        let req = self.request(Method::POST, &path, INVENTORY).header(ATTEMPT_HEADER, attempt).json(&serde_json::json!({}));
        Ok(self.write(req).await?.0)
    }

    async fn resolve_import_row(&self, batch: &str, row: &str, body: &RowFix) -> Result<ImportResolution, ApiError> {
        let path = format!("{IMPORTS}/{}/rows/{}/resolve", segment(batch), segment(row));
        Ok(self.write(self.request(Method::POST, &path, INVENTORY).json(body)).await?.0)
    }

    async fn import_locations(&self) -> Result<LocationList, ApiError> {
        self.read(&format!("{LOCATIONS}?limit=100&offset=0"), INVENTORY).await
    }

    async fn import_csv(&self, which: &str) -> Result<reqwest::Response, ApiError> {
        let res = self.request(Method::GET, &format!("{IMPORTS}/{which}/native-csv"), INVENTORY).send().await?;
        if res.status().is_success() {
            return Ok(res);
        }
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        Err(ApiError::Status { status, code: None, message: String::new() })
    }
}

/// Pricing health (marketplace's `account-desk-pricing-health`, Pricing's `pricing-health` routes).
const PRICING_HEALTH: &str = "/api/marketplace/account/pricing-health";

/// A policy the page can show (`PricingHealthData.policies`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthPolicy {
    pub policy_id: String,
    pub name: String,
    pub version: u64,
    pub body_hash: Option<String>,
}

/// Listings and units (`population`, `uncategorized`, a risk bucket).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCount {
    pub listing_count: u64,
    pub unit_count: u64,
    /// The uncategorized listings' reasons, by reason.
    pub reasons: BTreeMap<String, u64>,
    /// A risk bucket's value, in the currency's units.
    pub value_amount: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCoverage {
    pub listing_count: u64,
    pub listing_total: u64,
    pub unit_count: u64,
    pub unit_total: u64,
    pub listing_ratio: Option<f64>,
    pub unit_ratio: Option<f64>,
    pub missing_reasons: BTreeMap<String, u64>,
    pub bound_status_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCurveAge {
    pub newest_age_days: Option<f64>,
    pub oldest_age_days: Option<f64>,
    pub stale_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthWait {
    pub median_days: Option<f64>,
    pub p90_days: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthRisk {
    pub hopeless: HealthCount,
    pub slow: HealthCount,
    pub unknown_policy_listing_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthProfit {
    pub value: Option<f64>,
    pub cycle_days: Option<f64>,
    pub economics_listing_count: u64,
    pub unavailable_reason: Option<String>,
    pub economics_unavailable_reasons: BTreeMap<String, u64>,
    pub cost_basis_source_kinds: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthTurn {
    /// A fractional daily return: shown as a percentage.
    pub value: Option<f64>,
    pub cycle_days: Option<f64>,
    pub daily_return_hurdle: Option<f64>,
    pub daily_return_hurdle_source_kinds: BTreeMap<String, u64>,
    pub unavailable_reason: Option<String>,
}

/// One currency's verdict (`RepricingHealthCurrencySummary`); currencies are never added together.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCurrency {
    pub listed_value_amount: String,
    pub modeled_value_amount: String,
    pub modeled_value_delta_amount: String,
    pub coverage: HealthCoverage,
    pub curve_age: HealthCurveAge,
    pub expected_wait: HealthWait,
    pub expected_sales: HealthCount,
    pub value_at_risk: HealthRisk,
    pub profit_per_day: HealthProfit,
    pub capital_turn: HealthTurn,
}

/// A stored verdict (`RepricingHealthSummary`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthSummary {
    pub captured_at: String,
    pub population: HealthCount,
    pub currencies: BTreeMap<String, HealthCurrency>,
    pub uncategorized: HealthCount,
}

/// The dry run a verdict came from (`PricingHealthRun`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthRun {
    pub dry_run_id: String,
    pub completed_at: String,
    pub body_hash: String,
}

/// A goal the Adoption Gate cleared (`GoalChoice`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthGoal {
    pub goal_id: String,
    pub goal_version: u64,
    pub parameters: BTreeMap<String, f64>,
    pub required_curve_features: Vec<String>,
}

/// A goal's candidate run (`CandidateMetrics`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthCandidate {
    pub goal_id: String,
    pub goal_version: u64,
    pub dry_run_id: String,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    pub requested_at: String,
    pub body_hash: String,
    pub target_policy_id: String,
    pub target_revision: u64,
    pub listing_count: Option<u64>,
    pub raised: Option<u64>,
    pub lowered: Option<u64>,
    pub held: Option<u64>,
    pub held_reasons: BTreeMap<String, u64>,
    pub value: Option<BTreeMap<String, String>>,
    pub median_wait_days: Option<BTreeMap<String, Option<f64>>>,
    pub p90_wait_days: Option<BTreeMap<String, Option<f64>>>,
    pub bound_status_count: Option<BTreeMap<String, f64>>,
    pub coverage: Option<BTreeMap<String, f64>>,
    pub profit_per_day: Option<BTreeMap<String, Option<f64>>>,
    /// What the apply confirmation shows and Apply goal sends back, as Pricing sent them.
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
    pub currency_code: Option<String>,
    pub floor: Option<serde_json::Value>,
    pub guardrails: Option<serde_json::Value>,
}

/// What the page recommends (`Recommendation`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthAdvice {
    pub kind: String,
    pub goal_id: Option<String>,
    pub goal_version: Option<u64>,
    pub currency: Option<String>,
    pub delta: Option<f64>,
    pub wait_delta: Option<f64>,
    pub raised: Option<u64>,
    pub lowered: Option<u64>,
    pub held: Option<u64>,
    pub reason: Option<String>,
    pub count: Option<u64>,
}

/// A platform forecast grade (`PricingHealthGrade`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthGrade {
    pub goal_id: String,
    pub goal_version: u64,
    pub closed_on: String,
    pub forecast_kind: String,
    pub model: String,
    pub horizon_days: f64,
    /// `disclosed` or `undisclosed`.
    pub status: String,
    pub values: Option<HealthGradeValues>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthGradeValues {
    pub sold_share: Option<f64>,
    pub expected_share: Option<f64>,
    pub brier: Option<f64>,
    pub base_rate_brier: Option<f64>,
}

/// The page's read (`PricingHealthData` with `canCompute`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PricingHealth {
    pub policies: Vec<HealthPolicy>,
    pub target: Option<HealthPolicy>,
    pub health: Option<HealthSummary>,
    pub run: Option<HealthRun>,
    pub grades: Vec<HealthGrade>,
    pub computing: bool,
    pub goals: Vec<HealthGoal>,
    pub comparison: Vec<HealthCandidate>,
    pub recommendation: Option<HealthAdvice>,
    /// `comparison`, `advanced-editor` or `create-editor`.
    pub branch: Option<String>,
    pub can_compute: bool,
}

/// Apply goal's request (`ApplyGoalRequest`): the candidate as the page showed it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyGoal {
    pub dry_run_id: String,
    pub target_revision: u64,
    pub target_body_hash: String,
    pub candidate_body_hash: String,
    pub goal_id: String,
    pub goal_version: u64,
    pub parameters: serde_json::Map<String, serde_json::Value>,
}

/// What applying a goal did (`ApplyGoalResult`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppliedGoal {
    pub revision: u64,
    pub movement: AppliedMovement,
    pub alerts: AppliedAlerts,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppliedMovement {
    pub raised: u64,
    pub lowered: u64,
    pub held: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppliedAlerts {
    pub floor_binding: u64,
}

/// Pricing health's calls.
pub trait PricingHealthCalls {
    /// The verdict for `policy`, or Pricing's choice of policy without one.
    async fn pricing_health(&self, policy: Option<&str>) -> Result<PricingHealth, ApiError>;
    /// Compute a verdict, or compare the goals, for `policy` (`compute` or `compare`).
    async fn pricing_health_command(&self, policy: &str, command: &str) -> Result<(), ApiError>;
    async fn apply_pricing_goal(&self, policy: &str, goal: &ApplyGoal) -> Result<AppliedGoal, ApiError>;
}

impl PricingHealthCalls for Caller<'_> {
    async fn pricing_health(&self, policy: Option<&str>) -> Result<PricingHealth, ApiError> {
        match policy {
            Some(policy) => self.read(&format!("{PRICING_HEALTH}?policyId={}", segment(policy)), PRICING).await,
            None => self.read(PRICING_HEALTH, PRICING).await,
        }
    }

    async fn pricing_health_command(&self, policy: &str, command: &str) -> Result<(), ApiError> {
        let req = self.request(Method::POST, &format!("{PRICING_HEALTH}/{}/{command}", segment(policy)), PRICING);
        pricing_answer(req).await.map(|_| ()).map_err(|refusal| refusal.error)
    }

    async fn apply_pricing_goal(&self, policy: &str, goal: &ApplyGoal) -> Result<AppliedGoal, ApiError> {
        let path = format!("{PRICING_HEALTH}/{}/apply-goal", segment(policy));
        let (body, _) =
            pricing_answer(self.request(Method::POST, &path, PRICING).json(goal)).await.map_err(|refusal| refusal.error)?;
        serde_json::from_value(body).map_err(|error| ApiError::Status {
            status: StatusCode::BAD_GATEWAY,
            code: None,
            message: format!("an applied goal the page cannot read: {error}"),
        })
    }
}

/// Channels' connection and publication reads and writes (marketplace's channel screens).
const CHANNEL_CONNECTIONS: &str = "/api/channels/connections";
const CHANNEL_PUBLICATION: &str = "/api/channels/publication";
const CHANNELS: &str = "channels";

/// A connection as Channels shows it (`PublicChannelConnection`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelConnection {
    pub connection_id: String,
    pub provider_key: String,
    /// `sandbox` or `production`.
    pub environment: String,
    /// `pending-setup`, `active`, `paused` or `disconnected`.
    pub status: String,
    pub created_at: String,
}

/// A page of connections (`ChannelConnectionPage`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelConnectionPage {
    pub items: Vec<ChannelConnection>,
    pub next_cursor: Option<String>,
}

/// A connection's publication summary (`ChannelPublicationConnectionSummary`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelPublicationSummary {
    pub connection_id: String,
    pub provider_key: String,
    pub environment: String,
    pub connection_status: String,
    /// `configured` or `missing`.
    pub settings_state: String,
    pub review_count: u64,
}

#[derive(Deserialize)]
struct ChannelPublicationList {
    items: Vec<ChannelPublicationSummary>,
}

/// A connection's publication (`ChannelPublicationConnectionDetail`): its summary, its settings
/// (`None` until the seller saves some), a page of mappings to review, the listings recorded as
/// blocked, and the configuration's stream version, which a write is made at and the page waits for.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelPublication {
    pub connection: ChannelPublicationSummary,
    pub settings: Option<PublicationSettings>,
    pub mapping_review: MappingReview,
    pub blocked_listings: BlockedListings,
    pub configuration_stream_version: u64,
}

/// A connection's publication settings (`ChannelPublicationSettings`), as Channels reads and
/// replaces them.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PublicationSettings {
    pub title_prefix: String,
    pub title_suffix: String,
    pub description_footer: String,
    pub category_allowlist: Vec<String>,
    pub excluded_listing_ids: Vec<String>,
    pub publish_quantity_cap: Option<i64>,
    pub low_stock_withhold_units: Option<i64>,
}

/// A page of mappings to review (`ChannelMappingReviewPage`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MappingReview {
    pub items: Vec<MappingCandidate>,
    pub next_cursor: Option<String>,
    pub completeness: MappingCompleteness,
}

/// Whether the review read every mapping: `complete`, or `incomplete` with Channels' reason.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct MappingCompleteness {
    pub kind: String,
    pub reason: Option<String>,
}

/// A mapping to review (`ChannelMappingReviewQueueItem`), the fields the page shows and decides.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MappingCandidate {
    /// `category`, `condition` or `attribute`.
    pub dimension: String,
    pub source_key: String,
    pub target_key: Option<String>,
    pub confidence_tier: String,
    /// `proposed`, `rejected` or `revoked`.
    pub review_status: String,
}

/// The listings recorded as blocked from publishing (`ChannelPublicationBlockedListingPage`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BlockedListings {
    pub items: Vec<BlockedChannelListing>,
    pub total: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BlockedChannelListing {
    pub listing_id: String,
    pub channel_listing_id: String,
    pub blocking_reason_codes: Vec<String>,
}

/// A mapping's decision: `accept`, `reject` or `revoke`, with the channel's key for it.
#[derive(Clone, Debug)]
pub struct MappingDecision<'a> {
    pub dimension: &'a str,
    pub source_key: &'a str,
    pub decision: &'a str,
    pub target_key: Option<&'a str>,
}

/// What a publication write answered (`ChannelCommandResult`): `applied` or `unchanged` at a
/// stream version, or `refused` with Channels' code. A write made at a version that is no longer
/// current is Channels' 409, not an answer.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelCommandAnswer {
    pub kind: String,
    pub stream_version: Option<u64>,
    pub code: Option<String>,
}

/// The channel screens' calls.
pub trait ChannelCalls {
    /// A page of connections, of one status (`None`: Channels' default, every one not
    /// disconnected), from `cursor`.
    async fn channel_connections(&self, status: Option<&str>, cursor: Option<&str>) -> Result<ChannelConnectionPage, ApiError>;
    async fn channel_connection(&self, id: &str) -> Result<ChannelConnection, ApiError>;
    /// Connect a provider: the new connection, pending setup.
    async fn connect_channel(&self, provider: &str) -> Result<(ChannelConnection, Option<Receipt>), ApiError>;
    /// `pause`, `resume` or `disconnect` a connection.
    async fn channel_command(&self, id: &str, command: &str) -> Result<(ChannelConnection, Option<Receipt>), ApiError>;
    /// Activate a connection pending setup on the storage locations `locations`.
    async fn activate_channel(&self, id: &str, locations: &[String]) -> Result<(ChannelConnection, Option<Receipt>), ApiError>;
    async fn channel_publications(&self) -> Result<Vec<ChannelPublicationSummary>, ApiError>;
    /// A connection's publication, its mappings to review from `cursor`.
    async fn channel_publication(&self, id: &str, cursor: Option<&str>) -> Result<ChannelPublication, ApiError>;
    /// Replace a connection's publication settings, made at the configuration version `expected`.
    async fn replace_publication_settings(
        &self,
        id: &str,
        settings: &PublicationSettings,
        expected: u64,
    ) -> Result<ChannelCommandAnswer, ApiError>;
    /// Decide a mapping, made at the configuration version `expected`.
    async fn decide_channel_mapping(
        &self,
        id: &str,
        decision: &MappingDecision<'_>,
        expected: u64,
    ) -> Result<ChannelCommandAnswer, ApiError>;
}

impl ChannelCalls for Caller<'_> {
    async fn channel_connections(&self, status: Option<&str>, cursor: Option<&str>) -> Result<ChannelConnectionPage, ApiError> {
        let mut query = Vec::new();
        if let Some(cursor) = cursor {
            query.push(format!("cursor={}", segment(cursor)));
        }
        if let Some(status) = status {
            query.push(format!("status={}", segment(status)));
        }
        let path =
            if query.is_empty() { CHANNEL_CONNECTIONS.to_owned() } else { format!("{CHANNEL_CONNECTIONS}?{}", query.join("&")) };
        self.read(&path, CHANNELS).await
    }

    async fn channel_connection(&self, id: &str) -> Result<ChannelConnection, ApiError> {
        self.read(&format!("{CHANNEL_CONNECTIONS}/{}", segment(id)), CHANNELS).await
    }

    async fn connect_channel(&self, provider: &str) -> Result<(ChannelConnection, Option<Receipt>), ApiError> {
        let body = serde_json::json!({ "providerKey": provider });
        self.write(self.request(Method::POST, CHANNEL_CONNECTIONS, CHANNELS).json(&body)).await
    }

    async fn channel_command(&self, id: &str, command: &str) -> Result<(ChannelConnection, Option<Receipt>), ApiError> {
        // Pause, Resume and Disconnect take no body (Channels refuses one).
        self.write(self.request(Method::POST, &format!("{CHANNEL_CONNECTIONS}/{}/{command}", segment(id)), CHANNELS)).await
    }

    async fn activate_channel(&self, id: &str, locations: &[String]) -> Result<(ChannelConnection, Option<Receipt>), ApiError> {
        let body = serde_json::json!({ "storageLocationIds": locations });
        self.write(self.request(Method::POST, &format!("{CHANNEL_CONNECTIONS}/{}/activate", segment(id)), CHANNELS).json(&body))
            .await
    }

    async fn channel_publications(&self) -> Result<Vec<ChannelPublicationSummary>, ApiError> {
        Ok(self.read::<ChannelPublicationList>(CHANNEL_PUBLICATION, CHANNELS).await?.items)
    }

    async fn channel_publication(&self, id: &str, cursor: Option<&str>) -> Result<ChannelPublication, ApiError> {
        let query = cursor.map(|c| format!("?cursor={}", segment(c))).unwrap_or_default();
        self.read(&format!("{CHANNEL_PUBLICATION}/{}{query}", segment(id)), CHANNELS).await
    }

    async fn replace_publication_settings(
        &self,
        id: &str,
        settings: &PublicationSettings,
        expected: u64,
    ) -> Result<ChannelCommandAnswer, ApiError> {
        let body = serde_json::json!({ "settings": settings, "expectedStreamVersion": expected });
        let path = format!("{CHANNEL_PUBLICATION}/{}/settings", segment(id));
        Ok(self.write(self.request(Method::PUT, &path, CHANNELS).json(&body)).await?.0)
    }

    async fn decide_channel_mapping(
        &self,
        id: &str,
        decision: &MappingDecision<'_>,
        expected: u64,
    ) -> Result<ChannelCommandAnswer, ApiError> {
        let body = serde_json::json!({
            "decision": decision.decision,
            "targetKey": decision.target_key,
            "expectedStreamVersion": expected,
        });
        let path = format!(
            "{CHANNEL_PUBLICATION}/{}/mappings/{}/{}/decision",
            segment(id),
            segment(decision.dimension),
            segment(decision.source_key)
        );
        Ok(self.write(self.request(Method::POST, &path, CHANNELS).json(&body)).await?.0)
    }
}
/// A connection's manual TCGplayer sync as Channels answers it (`ManualSyncPanel`): which actions
/// the run allows now is Channels' answer (`actions`), not the page's.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManualSyncPanel {
    pub inbound_coverage: InboundCoverage,
    pub run: Option<SyncRun>,
    /// `compose`, `download`, `retry-clamp`, `record-upload-attempt`,
    /// `record-validation-cancellation`, `release`, `ingest-live`, `ingest-staged`, `verify`.
    pub actions: Vec<String>,
    pub lease_countdown_ms: Option<u64>,
    pub requested_listing_count: u64,
    pub composed_listing_count: u64,
    /// `ready`, `unknown` or `recovery`.
    pub attention_reason: Option<String>,
    pub verification_candidate: Option<VerificationCandidate>,
}

impl ManualSyncPanel {
    pub fn allows(&self, action: &str) -> bool {
        self.actions.iter().any(|a| a == action)
    }
}

/// Whether a paired connector authorizes inbound data (`live`), and why not (`dark`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InboundCoverage {
    pub state: String,
    pub reason: Option<String>,
}

/// The connection's latest manual run (`ChannelSyncRun`), the fields the panel shows.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncRun {
    pub run_id: String,
    pub revision: u64,
    pub state: String,
    pub lease_expires_at: String,
    pub upload_attempted_at: Option<String>,
}

/// The Staged snapshot a run awaiting verification is checked against.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VerificationCandidate {
    pub snapshot_id: String,
    pub parsed_row_count: u64,
    pub captured_at: String,
}

/// What an export's ingest found (`ManualSyncIngestReceipt`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestReceipt {
    /// `live` or `staged`.
    pub surface: String,
    pub probe: IngestProbe,
    pub outcome: IngestOutcome,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestProbe {
    pub file_name: String,
    pub byte_size: u64,
    pub logical_rows: u64,
    pub header_sha256: String,
    pub observed_at: String,
}

/// `ingested` with its snapshot, or `refused` with Channels' reason.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IngestOutcome {
    pub kind: String,
    pub snapshot_id: Option<String>,
    pub snapshot_generation: Option<u64>,
    pub parsed_row_count: Option<u64>,
    pub reason: Option<String>,
}

/// What the seller read off TCGplayer's import, for Verify.
pub struct ImportSummary<'a> {
    pub file_name: &'a str,
    pub date_imported_text: &'a str,
    pub number_of_products: u64,
}

/// A run's write: which run, at which revision.
#[derive(Clone, Copy)]
pub struct RunAt<'a> {
    pub run_id: &'a str,
    pub revision: u64,
}

/// Now, as `new Date().toISOString()` writes it.
pub fn instant_now() -> String {
    use time::format_description::well_known::Rfc3339;
    let now = time::OffsetDateTime::now_utc();
    let now = now.replace_millisecond(now.millisecond()).unwrap_or(now);
    now.format(&Rfc3339).unwrap_or_default()
}

/// The manual sync panel's calls (Channels' `manual-sync` routes).
pub trait ManualSyncCalls {
    async fn manual_sync(&self, id: &str) -> Result<ManualSyncPanel, ApiError>;
    /// Compose a Staged batch from the claimed publication work.
    async fn compose_manual_sync(&self, id: &str) -> Result<(), ApiError>;
    /// A run's bodiless write: `retry-clamp`, `release` or `validation-cancelled`.
    async fn manual_sync_step(&self, id: &str, run: RunAt<'_>, step: &str) -> Result<(), ApiError>;
    async fn record_upload_attempt(&self, id: &str, run: RunAt<'_>, file_name: &str) -> Result<(), ApiError>;
    async fn verify_manual_sync(
        &self,
        id: &str,
        run: RunAt<'_>,
        snapshot: &str,
        summary: &ImportSummary<'_>,
    ) -> Result<(), ApiError>;
    /// Ingest a TCGplayer export of `surface` (`live` or `staged`).
    async fn ingest_export(
        &self,
        id: &str,
        surface: &str,
        file_name: &str,
        bytes: bytes::Bytes,
    ) -> Result<IngestReceipt, ApiError>;
    /// Claim the composed run and its Staged CSV, as Channels sends it.
    async fn download_manual_sync(&self, id: &str, run: RunAt<'_>) -> Result<reqwest::Response, ApiError>;
}

fn manual_sync_path(id: &str) -> String {
    format!("{CHANNEL_CONNECTIONS}/{}/manual-sync", segment(id))
}

fn run_path(id: &str, run: RunAt<'_>, step: &str) -> String {
    format!("{}/runs/{}/{step}", manual_sync_path(id), segment(run.run_id))
}

impl ManualSyncCalls for Caller<'_> {
    async fn manual_sync(&self, id: &str) -> Result<ManualSyncPanel, ApiError> {
        self.read(&manual_sync_path(id), CHANNELS).await
    }

    async fn compose_manual_sync(&self, id: &str) -> Result<(), ApiError> {
        let path = format!("{}/compose", manual_sync_path(id));
        self.write::<serde_json::Value>(self.request(Method::POST, &path, CHANNELS)).await.map(|_| ())
    }

    async fn manual_sync_step(&self, id: &str, run: RunAt<'_>, step: &str) -> Result<(), ApiError> {
        let path = format!("{}?expectedRevision={}", run_path(id, run, step), run.revision);
        self.write::<serde_json::Value>(self.request(Method::POST, &path, CHANNELS)).await.map(|_| ())
    }

    async fn record_upload_attempt(&self, id: &str, run: RunAt<'_>, file_name: &str) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "expectedRevision": run.revision,
            "uploadAttemptedAt": instant_now(),
            "fileName": file_name,
        });
        let req = self.request(Method::POST, &run_path(id, run, "upload-attempt"), CHANNELS).json(&body);
        self.write::<serde_json::Value>(req).await.map(|_| ())
    }

    async fn verify_manual_sync(
        &self,
        id: &str,
        run: RunAt<'_>,
        snapshot: &str,
        summary: &ImportSummary<'_>,
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "expectedRevision": run.revision,
            "verificationSnapshotId": snapshot,
            "importSummary": {
                "fileName": summary.file_name,
                "dateImportedText": summary.date_imported_text,
                "numberOfProducts": summary.number_of_products,
                "recordedAt": instant_now(),
            },
        });
        let req = self.request(Method::POST, &run_path(id, run, "verify"), CHANNELS).json(&body);
        self.write::<serde_json::Value>(req).await.map(|_| ())
    }

    async fn ingest_export(
        &self,
        id: &str,
        surface: &str,
        file_name: &str,
        bytes: bytes::Bytes,
    ) -> Result<IngestReceipt, ApiError> {
        let part = reqwest::multipart::Part::stream(bytes)
            .file_name(file_name.to_owned())
            .mime_str("text/csv")
            .map_err(ApiError::Transport)?;
        let form = reqwest::multipart::Form::new().part("export", part);
        let path = format!("{}/ingest?surface={}", manual_sync_path(id), segment(surface));
        let req = self
            .request(Method::POST, &path, CHANNELS)
            .header("x-channel-export-captured-at", instant_now())
            .timeout(UPLOAD_TIMEOUT)
            .multipart(form);
        Ok(self.write(req).await?.0)
    }

    async fn download_manual_sync(&self, id: &str, run: RunAt<'_>) -> Result<reqwest::Response, ApiError> {
        let path = format!("{}?expectedRevision={}", run_path(id, run, "download"), run.revision);
        let res = self.request(Method::POST, &path, CHANNELS).send().await?;
        if res.status().is_success() {
            return Ok(res);
        }
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        let code = body["error"]["code"].as_str().map(str::to_owned);
        Err(ApiError::Status { status, message: code.clone().unwrap_or_default(), code })
    }
}
