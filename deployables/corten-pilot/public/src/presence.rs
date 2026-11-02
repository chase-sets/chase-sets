//! The Public Presence API's calls the home page makes, with no session: the public policy values
//! (`features/help/integrations/public-policy-values-client.ts`), the promo bar's messages and the
//! waitlist counter (which public-web's shell reads from the browser), and a waitlist signup
//! (`submitWaitlistSignup`); and the welcome page's: a signup's referral summary and its
//! cohort-quality saves, which public-web's page makes from the browser.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use platform::api::{ApiError, Caller, Method};

/// `GET /api/public-presence/policy-values`: each value by its key.
#[derive(Clone, Debug, Deserialize)]
pub struct PolicyValues {
    #[serde(default)]
    pub values: HashMap<String, PolicyValue>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PolicyValue {
    #[serde(default)]
    pub value: Value,
}

/// A promo bar message as the shell reads it (`usePromoBarMessages`): any field of the wrong
/// type is none, and a tone other than success, warning or info is info.
#[derive(Clone, Debug, PartialEq)]
pub struct Promo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub href: Option<String>,
    pub link_label: Option<String>,
    pub tone: Tone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Info,
    Success,
    Warning,
}

impl Promo {
    fn read(item: &Value) -> Promo {
        let text = |name: &str| item.get(name).and_then(Value::as_str).map(str::to_owned);
        let id = match item.get("id") {
            Some(Value::String(id)) => id.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        let title = match item.get("title") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(title)) => title.clone(),
            Some(other) => other.to_string(),
        };
        let tone = match item.get("tone").and_then(Value::as_str) {
            Some("success") => Tone::Success,
            Some("warning") => Tone::Warning,
            _ => Tone::Info,
        };
        Promo { id, title, description: text("description"), href: text("href"), link_label: text("link_label"), tone }
    }
}

#[derive(Deserialize)]
struct Promos {
    #[serde(default)]
    items: Value,
}

#[derive(Deserialize)]
struct Count {
    #[serde(rename = "displayCount")]
    display_count: Option<Value>,
}

/// `POST /api/public-presence/waitlist`'s body (`SubmitWaitlistSignupRequest`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signup<'a> {
    pub email: &'a str,
    pub role: &'a str,
    pub interests: &'a [String],
    pub marketing_consent: bool,
    pub referred_by_signup_id: Option<&'a str>,
    pub games: &'a [String],
    pub has_store_link: bool,
    pub store_url: Option<&'a str>,
    pub inventory_size: Option<&'a str>,
    pub website: Option<&'a str>,
    pub source: SignupSource<'a>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupSource<'a> {
    pub page_path: &'a str,
    pub referrer: Option<&'a str>,
    pub utm_source: Option<&'a str>,
    pub utm_medium: Option<&'a str>,
    pub utm_campaign: Option<&'a str>,
    pub utm_content: Option<&'a str>,
    pub utm_term: Option<&'a str>,
}

#[derive(Deserialize)]
struct Joined {
    id: String,
}

/// `GET /api/public-presence/waitlist/{id}/referral-summary` as the welcome page reads it
/// (`useWaitlistReferralSummary`): a missing number is its default, and a place in line that is
/// not a positive number is none (the read model has not caught up).
#[derive(Clone, Debug, PartialEq)]
pub struct Referrals {
    pub count: u64,
    pub goal: u64,
    pub position: Option<u64>,
    pub total: u64,
    pub advanced: u64,
}

impl Default for Referrals {
    fn default() -> Self {
        Referrals { count: 0, goal: 3, position: None, total: 0, advanced: 0 }
    }
}

impl Referrals {
    fn read(body: &Value) -> Referrals {
        let number = |name: &str| body.get(name).and_then(Value::as_f64).filter(|n| n.is_finite());
        let whole = |n: f64| n.max(0.0) as u64;
        Referrals {
            count: number("referralCount").map_or(0, whole),
            goal: number("referralGoal").map_or(3, whole),
            position: number("queuePosition").filter(|n| *n > 0.0).map(whole),
            total: number("totalSignups").map_or(0, whole),
            advanced: number("positionsAdvanced").map_or(0, whole),
        }
    }
}

/// `POST /api/public-presence/waitlist/{id}/cohort-quality`'s body: only the fields present are
/// saved, so each is left out unless it is sent.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cohort<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub games: Option<&'a [String]>,
    /// `Some(None)` clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_size: Option<Option<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_store_link: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_url: Option<Option<&'a str>>,
}

const CONTEXT: &str = "public-presence";

/// The calls the home page makes.
pub trait Presence {
    async fn policy_values(&self) -> Result<PolicyValues, ApiError>;
    /// The same answer as it is, for a page that checks every field (the help center's).
    async fn policy_document(&self) -> Result<Value, ApiError>;
    /// The messages, with a title or not (the page shows only titled ones).
    async fn promos(&self) -> Result<Vec<Promo>, ApiError>;
    /// The rounded, threshold-gated headcount, or none while it is hidden.
    async fn waitlist_count(&self) -> Result<Option<f64>, ApiError>;
    /// The signup's id. `client` is the visitor's address, which the API's signup limiter keys on.
    async fn join(&self, signup: &Signup<'_>, client: Option<&str>) -> Result<String, ApiError>;
    /// A signup's referrals and place in line. Its limiter keys on the visitor's address too.
    async fn referrals(&self, signup: &str, client: Option<&str>) -> Result<Referrals, ApiError>;
    async fn save_cohort(&self, signup: &str, cohort: &Cohort<'_>, client: Option<&str>) -> Result<(), ApiError>;
}

/// The visitor's address, which the API's limiters key on, on a request the app sends for them.
fn for_client(req: platform::api::RequestBuilder, client: Option<&str>) -> platform::api::RequestBuilder {
    match client {
        Some(client) => req.header("x-forwarded-for", client),
        None => req,
    }
}

impl Presence for Caller<'_> {
    async fn policy_values(&self) -> Result<PolicyValues, ApiError> {
        self.read("/api/public-presence/policy-values", CONTEXT).await
    }

    async fn policy_document(&self) -> Result<Value, ApiError> {
        self.read("/api/public-presence/policy-values", CONTEXT).await
    }

    async fn promos(&self) -> Result<Vec<Promo>, ApiError> {
        let body: Promos = self.read("/api/public-presence/promo-bar-messages", CONTEXT).await?;
        Ok(body.items.as_array().map(|items| items.iter().map(Promo::read).collect()).unwrap_or_default())
    }

    async fn waitlist_count(&self) -> Result<Option<f64>, ApiError> {
        let body: Count = self.read("/api/public-presence/waitlist/count", CONTEXT).await?;
        Ok(body.display_count.as_ref().and_then(Value::as_f64))
    }

    async fn join(&self, signup: &Signup<'_>, client: Option<&str>) -> Result<String, ApiError> {
        let req = for_client(self.request(Method::POST, "/api/public-presence/waitlist", CONTEXT).json(signup), client);
        let (joined, _): (Joined, _) = self.write(req).await?;
        Ok(joined.id)
    }

    async fn referrals(&self, signup: &str, client: Option<&str>) -> Result<Referrals, ApiError> {
        let path = format!("/api/public-presence/waitlist/{}/referral-summary", platform::api::segment(signup));
        // A GET built with the visitor's address; `write` sends a built request and reads its JSON.
        let (body, _): (Value, _) = self.write(for_client(self.request(Method::GET, &path, CONTEXT), client)).await?;
        Ok(Referrals::read(&body))
    }

    async fn save_cohort(&self, signup: &str, cohort: &Cohort<'_>, client: Option<&str>) -> Result<(), ApiError> {
        let path = format!("/api/public-presence/waitlist/{}/cohort-quality", platform::api::segment(signup));
        let (_, _): (Value, _) = self.write(for_client(self.request(Method::POST, &path, CONTEXT).json(cohort), client)).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Cohort, Promo, Referrals, Tone};

    #[test]
    fn a_promo_reads_as_the_shell_reads_it() {
        let promo =
            Promo::read(&json!({ "id": 7, "title": null, "description": 3, "href": "/x", "link_label": "Go", "tone": "danger" }));
        assert_eq!(promo.id, "7");
        assert_eq!(promo.title, "");
        assert_eq!(promo.description, None);
        assert_eq!(promo.href.as_deref(), Some("/x"));
        assert_eq!(promo.tone, Tone::Info, "a tone the bar has no style for is info");
    }

    #[test]
    fn referrals_read_as_the_welcome_page_reads_them() {
        assert_eq!(Referrals::read(&json!({})), Referrals::default());
        let read = Referrals::read(
            &json!({ "referralCount": 2, "referralGoal": 3, "queuePosition": 0, "totalSignups": 40, "positionsAdvanced": -1 }),
        );
        assert_eq!(read.position, None, "not caught up");
        assert_eq!(read.advanced, 0);
        let read = Referrals::read(&json!({ "queuePosition": 12, "positionsAdvanced": 4 }));
        assert_eq!((read.position, read.advanced, read.goal), (Some(12), 4, 3));
    }

    #[test]
    fn a_cohort_save_sends_only_its_fields() {
        let games = vec!["pokemon".to_owned()];
        let body = serde_json::to_value(Cohort { games: Some(&games), ..Cohort::default() }).unwrap();
        assert_eq!(body, json!({ "games": ["pokemon"] }));
        let body = serde_json::to_value(Cohort { inventory_size: Some(None), ..Cohort::default() }).unwrap();
        assert_eq!(body, json!({ "inventorySize": null }), "a cleared size is sent as null");
    }
}
