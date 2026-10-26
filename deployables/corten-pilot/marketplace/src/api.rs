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

    fn owner(&self) -> &'static str {
        if self.guest.is_some() { "/api/marketplace/guest" } else { "/api/marketplace/account" }
    }
}

/// The guest cart a browser presents (`x-checkout-anonymous-cart-id`).
const ANONYMOUS_CART_HEADER: &str = "x-checkout-anonymous-cart-id";

/// The guest sell list a browser presents (`x-checkout-anonymous-sell-list-id`).
const ANONYMOUS_SELL_LIST_HEADER: &str = "x-checkout-anonymous-sell-list-id";

/// The sell list's calls (`/account/sell-list`, `/guest/sell-list` for a guest's).
pub trait SellList {
    /// Adds a line (`AddCheckoutSellListLineRequest`) to the account's sell list, or to the guest
    /// sell list `guest`. The API takes no attempt id: a product line sent again adds its
    /// quantity again (chase-sets/chase-sets#9995). The answer is the write's receipt.
    async fn add_sell_list_line(&self, line: &impl Serialize, guest: Option<&str>) -> Result<Option<Receipt>, ApiError>;
}

impl SellList for Caller<'_> {
    async fn add_sell_list_line(&self, line: &impl Serialize, guest: Option<&str>) -> Result<Option<Receipt>, ApiError> {
        let owner = if guest.is_some() { "guest" } else { "account" };
        let mut req = self.request(Method::POST, &format!("/api/marketplace/{owner}/sell-list"), CHECKOUT).json(line);
        if let Some(id) = guest {
            req = req.header(ANONYMOUS_SELL_LIST_HEADER, id);
        }
        Ok(self.write::<serde::de::IgnoredAny>(req).await?.1)
    }
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
}

impl Marketplace for Caller<'_> {
    async fn standard_terms(&self, price: &str) -> Result<StandardTerms, ApiError> {
        let req = self
            .request(Method::POST, "/api/marketplace/terms/public-standard/listing-preview", MARKETPLACE)
            .json(&serde_json::json!({ "priceAmount": price }));
        Ok(self.write(req).await?.0)
    }
}

const MARKETPLACE: &str = "marketplace";

/// The cart page's calls.
pub trait Checkout {
    async fn cart(&self) -> Result<Cart, ApiError>;
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
