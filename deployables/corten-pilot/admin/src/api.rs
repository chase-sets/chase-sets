//! The postage-policy calls, as the signed-in staff member (the shared caller is
//! `platform::api`). Types hold only the fields the screen reads; they are also the screen's JSON
//! for data clients.
use serde::{Deserialize, Serialize};

pub use platform::api::{ApiError, Caller, Identity, Method, Platform, segment};
use platform::receipt::Receipt;

const ORDERING: &str = "ordering";
const POLICIES: &str = "/api/marketplace/admin/postage-policies";

/// The screen's calls. A trait because the caller is the shared crate's.
pub trait Policies {
    async fn list(&self, limit: u32, offset: u32) -> Result<PolicyList, ApiError>;
    async fn get(&self, id: &str) -> Result<Policy, ApiError>;
    async fn create(&self, body: &PolicyCommand) -> Result<Written, ApiError>;
    async fn revise(&self, id: &str, body: &PolicyCommand) -> Result<Written, ApiError>;
    async fn activate(&self, id: &str, reason: &str) -> Result<Written, ApiError>;
    async fn retire(&self, id: &str, reason: &str) -> Result<Written, ApiError>;
    async fn clone_policy(&self, id: &str, body: &CloneCommand<'_>) -> Result<Written, ApiError>;
    async fn preview(&self, body: &PreviewCommand<'_>) -> Result<PackagePlan, ApiError>;
}

async fn command<B: Serialize>(caller: &Caller<'_>, method: Method, path: &str, body: &B) -> Result<Written, ApiError> {
    let (id, receipt): (Id, _) = caller.write(caller.request(method, path, ORDERING).json(body)).await?;
    Ok(Written { id: id.id, receipt })
}

impl Policies for Caller<'_> {
    async fn list(&self, limit: u32, offset: u32) -> Result<PolicyList, ApiError> {
        self.read(&format!("{POLICIES}?limit={limit}&offset={offset}"), ORDERING).await
    }

    async fn get(&self, id: &str) -> Result<Policy, ApiError> {
        self.read(&format!("{POLICIES}/{}", segment(id)), ORDERING).await
    }

    async fn create(&self, body: &PolicyCommand) -> Result<Written, ApiError> {
        command(self, Method::POST, POLICIES, body).await
    }

    async fn revise(&self, id: &str, body: &PolicyCommand) -> Result<Written, ApiError> {
        command(self, Method::PUT, &format!("{POLICIES}/{}", segment(id)), body).await
    }

    async fn activate(&self, id: &str, reason: &str) -> Result<Written, ApiError> {
        let body = serde_json::json!({ "activationReason": reason });
        command(self, Method::POST, &format!("{POLICIES}/{}/activate", segment(id)), &body).await
    }

    async fn retire(&self, id: &str, reason: &str) -> Result<Written, ApiError> {
        let body = serde_json::json!({ "retirementReason": reason });
        command(self, Method::POST, &format!("{POLICIES}/{}/retire", segment(id)), &body).await
    }

    async fn clone_policy(&self, id: &str, body: &CloneCommand<'_>) -> Result<Written, ApiError> {
        command(self, Method::POST, &format!("{POLICIES}/{}/clone", segment(id)), body).await
    }

    async fn preview(&self, body: &PreviewCommand<'_>) -> Result<PackagePlan, ApiError> {
        let req = self.request(Method::POST, &format!("{POLICIES}/preview"), ORDERING).json(body);
        let (plan, _): (PreviewBody, _) = self.write(req).await?;
        Ok(plan.package_plan)
    }
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

/// A write the API accepted: the policy's id and the receipt the next read waits for.
pub struct Written {
    pub id: String,
    pub receipt: Option<Receipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PolicyList {
    pub items: Vec<Policy>,
    pub total: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Policy {
    pub policy_id: String,
    pub label: String,
    pub status: String,
    pub policy_version: String,
    pub payload: Payload,
    pub effective_from: String,
    pub effective_until: Option<String>,
    pub activation_reason: Option<String>,
    pub updated_at: String,
    pub activated_at: Option<String>,
    #[serde(default)]
    pub history: Vec<History>,
    #[serde(default, rename = "activeComparison")]
    pub active_comparison: Vec<Difference>,
}

/// A policy's rules (`PostagePolicy` in contracts/product-measures).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub policy_version: String,
    pub max_letter_units: f64,
    pub max_letter_weight_ounces: f64,
    pub max_letter_thickness_inches: f64,
    pub max_letter_declared_value_amount: f64,
    pub letter_envelope_weight_ounces: f64,
    pub parcel_packaging_weight_ounces: f64,
    pub parcel_required_shipping_options: Vec<String>,
    pub letter_required_physical_flags: Vec<String>,
    pub parcel_required_physical_flags: Vec<String>,
    pub signature_required_shipping_options: Vec<String>,
    pub signature_required_declared_value_amount: Option<f64>,
    pub signature_required_physical_flags: Vec<String>,
    pub insurance_required_declared_value_amount: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct History {
    pub history_id: String,
    pub event_type: String,
    pub actor_user_id: String,
    pub reason: Option<String>,
    pub status: String,
    pub recorded_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub field: String,
    pub active_value: String,
    pub candidate_value: String,
}

/// The body of a create or a revision: the label, the dates and the rules, side by side.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCommand {
    pub label: String,
    pub effective_from: String,
    pub effective_until: String,
    #[serde(flatten)]
    pub payload: Payload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneCommand<'a> {
    pub label: &'a str,
    pub effective_from: &'a str,
    pub effective_until: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCommand<'a> {
    pub policy: &'a Payload,
    pub shipping_option: &'a str,
    pub item_subtotal_amount: &'a str,
    pub quantity: f64,
    pub unit_length_inches: f64,
    pub unit_width_inches: f64,
    pub unit_height_inches: f64,
    pub unit_weight_ounces: f64,
    pub physical_flags: &'a [String],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBody {
    package_plan: PackagePlan,
}

/// What a preview answers (`PackagePlan` in contracts/product-measures), the fields shown.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub package_count: u32,
    pub packages: Vec<Package>,
    pub postage_policy_snapshot: Option<Snapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub mailpiece_class: String,
    pub service_level: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub parcel_required: bool,
    pub parcel_reasons: Vec<String>,
    pub signature_required: bool,
    pub signature_reasons: Vec<String>,
    pub insurance_required: bool,
    pub insurance_reasons: Vec<String>,
    pub insured_value_amount: Option<String>,
    pub shipping_evidence_tier: String,
}
