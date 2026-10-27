//! The Public Presence API's calls the home page makes, with no session: the public policy values
//! (`features/help/integrations/public-policy-values-client.ts`), the promo bar's messages and the
//! waitlist counter (which public-web's shell reads from the browser), and a waitlist signup
//! (`submitWaitlistSignup`).
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

const CONTEXT: &str = "public-presence";

/// The calls the home page makes.
pub trait Presence {
    async fn policy_values(&self) -> Result<PolicyValues, ApiError>;
    /// The messages, with a title or not (the page shows only titled ones).
    async fn promos(&self) -> Result<Vec<Promo>, ApiError>;
    /// The rounded, threshold-gated headcount, or none while it is hidden.
    async fn waitlist_count(&self) -> Result<Option<f64>, ApiError>;
    /// The signup's id. `client` is the visitor's address, which the API's signup limiter keys on.
    async fn join(&self, signup: &Signup<'_>, client: Option<&str>) -> Result<String, ApiError>;
}

impl Presence for Caller<'_> {
    async fn policy_values(&self) -> Result<PolicyValues, ApiError> {
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
        let mut req = self.request(Method::POST, "/api/public-presence/waitlist", CONTEXT).json(signup);
        if let Some(client) = client {
            req = req.header("x-forwarded-for", client);
        }
        let (joined, _): (Joined, _) = self.write(req).await?;
        Ok(joined.id)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Promo, Tone};

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
}
