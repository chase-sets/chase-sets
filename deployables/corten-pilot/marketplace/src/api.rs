//! The storage-location calls, as the signed-in seller (the shared caller is `platform::api`).
//! Types hold only the fields the screen reads; they are also the screen's JSON for data clients.
use serde::{Deserialize, Serialize};

pub use platform::api::{ApiError, Caller, Identity, Method, Platform, segment};
use platform::receipt::Receipt;

const INVENTORY: &str = "inventory";
const LOCATIONS: &str = "/api/inventory/storage-locations";
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
    /// The attempt's result, or `None` when the API holds none (it was never applied, or it is
    /// someone else's).
    async fn attempt(&self, id: &str) -> Result<Option<AttemptResult>, ApiError>;
}

async fn send(
    caller: &Caller<'_>,
    method: Method,
    path: &str,
    attempt: &str,
    body: &LocationCommand,
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

    async fn attempt(&self, id: &str) -> Result<Option<AttemptResult>, ApiError> {
        match self.read(&format!("{ATTEMPTS}/{}", segment(id)), INVENTORY).await {
            Ok(result) => Ok(Some(result)),
            Err(error) if error.status().is_some_and(|s| s.as_u16() == 404) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
