//! The storage-location and restock-decision calls, as the signed-in seller, and the cart read, as
//! the signed-in buyer (the shared caller is `platform::api`).
//! Types hold only the fields the screen reads; they are also the screen's JSON for data clients.
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

/// The cart page's call.
pub trait Checkout {
    async fn cart(&self) -> Result<Cart, ApiError>;
}

impl Checkout for Caller<'_> {
    async fn cart(&self) -> Result<Cart, ApiError> {
        self.read(CART, CHECKOUT).await
    }
}
