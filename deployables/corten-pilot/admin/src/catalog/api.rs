//! The catalog authoring API (`/api/catalog`), as the signed-in staff member. Types hold only the
//! fields the screens read; they are also the screens' JSON for data clients.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::api::{ApiError, Caller, Method, segment};
use platform::receipt::Receipt;

const CATALOG: &str = "catalog";
const API: &str = "/api/catalog";

/// A page of a list (`ListResponse`).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct List<T> {
    pub items: Vec<T>,
    #[serde(default)]
    pub total: u32,
}

/// `Dimension` (features/dimensions/ui/contracts.ts), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Dimension {
    pub dimension_id: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub value_kind: String,
    pub status: String,
    pub updated_at: String,
}

/// `DimensionDetail`: the dimension and its options.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DimensionDetail {
    #[serde(flatten)]
    pub dimension: Dimension,
    #[serde(default)]
    pub options: Vec<DimensionOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DimensionOption {
    pub option_id: String,
    pub code: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub label_i18n: Option<LocalizedText>,
    pub display_order: i64,
    pub numeric_value: Option<f64>,
    pub status: String,
}

/// A `LocalizedTextMap`: the default locale and a text per locale.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    pub default_locale: String,
    pub values: BTreeMap<String, String>,
}

/// `Field` (features/fields/ui/contracts.ts).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Field {
    pub field_id: String,
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: String,
    pub value_type: String,
    pub filterable: bool,
    pub searchable: bool,
    pub sortable: bool,
    pub updated_at: String,
}

/// A write the API accepted: the receipt the next read waits for.
pub struct Written {
    pub receipt: Option<Receipt>,
}

/// The kinds the catalog area edits, by their API path.
#[derive(Clone, Copy)]
pub enum Kind {
    Dimensions,
    Fields,
}

impl Kind {
    fn path(self) -> &'static str {
        match self {
            Kind::Dimensions => "dimensions",
            Kind::Fields => "fields",
        }
    }
}

/// The catalog calls. A trait because the caller is the shared crate's.
pub trait Catalog {
    /// A page of `kind`, with the list's query (`search=..&status=..&limit=50&offset=0`).
    async fn list<T: DeserializeOwned>(&self, kind: Kind, query: &str) -> Result<List<T>, ApiError>;
    async fn get<T: DeserializeOwned>(&self, kind: Kind, id: &str) -> Result<T, ApiError>;
    /// A command: `POST` or `PUT` to `/api/catalog/{kind}{rest}` with `body` (`rest` starts with
    /// `/`, or is empty for a create).
    async fn command(&self, method: Method, kind: Kind, rest: &str, body: Option<&Value>) -> Result<Written, ApiError>;
}

impl Catalog for Caller<'_> {
    async fn list<T: DeserializeOwned>(&self, kind: Kind, query: &str) -> Result<List<T>, ApiError> {
        self.read(&format!("{API}/{}?{query}", kind.path()), CATALOG).await
    }

    async fn get<T: DeserializeOwned>(&self, kind: Kind, id: &str) -> Result<T, ApiError> {
        self.read(&format!("{API}/{}/{}", kind.path(), segment(id)), CATALOG).await
    }

    async fn command(&self, method: Method, kind: Kind, rest: &str, body: Option<&Value>) -> Result<Written, ApiError> {
        let mut req = self.request(method, &format!("{API}/{}{rest}", kind.path()), CATALOG);
        if let Some(body) = body {
            req = req.json(body);
        }
        let (_, receipt): (Value, _) = self.write(req).await?;
        Ok(Written { receipt })
    }
}

/// `/{id}` and more segments, each encoded.
pub fn under(id: &str, rest: &[&str]) -> String {
    std::iter::once(id).chain(rest.iter().copied()).map(|s| format!("/{}", segment(s))).collect()
}
