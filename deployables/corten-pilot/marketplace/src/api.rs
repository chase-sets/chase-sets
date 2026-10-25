//! The storage-location and restock-decision calls, as the signed-in seller, the cart read, as
//! the signed-in buyer, and the item page's read, as anyone (the shared caller is `platform::api`).
//! Types hold only the fields the screen reads; they are also the screen's JSON for data clients.
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

const CART_ATTEMPT_KIND: &str = "cart.commands";
const CART_ATTEMPT_TARGET: &str = "cart";

/// The guest cart a browser presents (`x-checkout-anonymous-cart-id`).
const ANONYMOUS_CART_HEADER: &str = "x-checkout-anonymous-cart-id";

/// The cart page's calls.
pub trait Checkout {
    async fn cart(&self) -> Result<Cart, ApiError>;
    /// Moves a guest cart's lines into the account's cart.
    async fn merge_guest_cart(&self, anonymous_cart: &str) -> Result<(), ApiError>;
    /// The account's cart's readiness now, with `decisions` (and the guest cart's lines).
    async fn cart_readiness(&self, decisions: &Decisions, anonymous_cart: Option<&str>) -> Result<Snapshot, ApiError>;
    /// Sends `commands` as one cart attempt (`POST /account/cart/commands`): all or nothing per
    /// command, applied once however often `attempt` is sent.
    async fn cart_commands(&self, attempt: &str, commands: &[CartCommand]) -> CartAnswer;
    /// What the API kept of `attempt` sent with `commands`; `None` when it cannot say.
    async fn cart_attempt(&self, attempt: &str, commands: &[CartCommand]) -> Option<CartAttempt>;
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

    async fn cart_commands(&self, attempt: &str, commands: &[CartCommand]) -> CartAnswer {
        let body = serde_json::json!({ "attemptId": attempt, "commands": commands });
        let sent = self.request(Method::POST, &format!("{CART}/commands"), CHECKOUT).json(&body).send().await;
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

    async fn cart_attempt(&self, attempt: &str, commands: &[CartCommand]) -> Option<CartAttempt> {
        let hash = crate::cart_attempt::request_hash(commands);
        let path = format!(
            "/api/marketplace/account/command-attempts/{}?kind={CART_ATTEMPT_KIND}&target={CART_ATTEMPT_TARGET}&requestHash={hash}",
            segment(attempt)
        );
        #[derive(Deserialize)]
        struct Found {
            attempt: CartAttempt,
        }
        match self.read::<Found>(&path, CHECKOUT).await {
            Ok(found) => Some(found.attempt),
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
}

const DISCOVERY: &str = "discovery";
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
    pub relationships: Vec<Relationship>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub relationship_type: String,
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
    /// `ordered`, `numeric` or `unordered`.
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
}

impl Discovery for Caller<'_> {
    async fn item(&self, id: &str) -> Result<Option<Item>, ApiError> {
        match self.read(&format!("{ITEMS}/{}", segment(id)), DISCOVERY).await {
            Ok(item) => Ok(Some(item)),
            Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
