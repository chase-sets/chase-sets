//! Growth > Promo Bar (admin-web's `/growth/promo-bar`, Public Presence's `PromoBarAdminPage`): a
//! preview of the messages live now, Create message, and the messages with Activate or Deactivate,
//! Edit (a sheet) and Delete (a confirmation). Read from and written to
//! `/api/public-presence/admin/promo-bar-messages` with `public-presence.view`, as the API asks.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /growth/promo-bar?edit&delete&done` | the page, with a message's edit sheet or delete confirmation open, and what the last write did |
//! | `POST /growth/promo-bar` | a write (`intent`: create, update, activate, deactivate, delete), then the page |
//!
//! The start and end times are `datetime-local` fields: a wall-clock time without a zone. admin-web
//! sends that text and the API reads it in its server's time zone, and admin-web fills the fields
//! with the UTC time. The pilot reads and fills them in the operator's time zone (`ClientZone`, UTC
//! when unknown) and sends the instant (chase-sets/chase-sets#10871). A time it cannot read is sent
//! as typed, so the API refuses it in its own words.
use corten::{
    ClientZone,
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use jiff::{Timestamp, tz::TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::views;
use crate::{
    api::{ApiError, Method, segment},
    app::{Shared, read_failed, sign_in},
    auth::{GrowthView, Staff, Viewer},
    text::Gro,
};

const CONTEXT: &str = "public-presence";
const BASE: &str = "/api/public-presence/admin/promo-bar-messages";
/// The tones a message may have, in admin-web's order.
pub const TONES: [&str; 3] = ["info", "success", "warning"];
/// What a write may have done, by its intent.
pub const DONE: [&str; 5] = ["created", "updated", "activated", "deactivated", "deleted"];

#[corten::routes(state = crate::app::Shared, area = crate::growth::promo::url::Promo, caller = crate::auth::Staff<crate::auth::GrowthView>)]
pub mod url {
    use corten::Route;
    use serde::Deserialize;

    /// What the page has open, and what the last write did.
    #[derive(Clone, Debug, Default, Deserialize, Route)]
    #[route(query)]
    pub struct Open {
        pub edit: Option<String>,
        pub delete: Option<String>,
        pub done: Option<String>,
    }

    /// The page; a `POST` is a write.
    #[derive(Clone, Debug, Default)]
    #[route("/growth/promo-bar", get = page, post = act)]
    pub struct Promo {
        #[route(query)]
        pub open: Open,
    }
}

/// The area: its route, its stylesheet and the sheets' dialog.
pub fn area(area: Area<url::Promo>, shared: Shared) -> Area<url::Promo> {
    url::area(area, shared).components(views::PROMO)
}

/// A promo bar message (`PromoBarMessage`).
#[derive(Clone, Debug, Deserialize, Serialize, ToJson)]
pub struct Message {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub href: Option<String>,
    #[serde(default)]
    pub link_label: Option<String>,
    pub tone: String,
    pub is_active: bool,
    pub display_order: i64,
    #[serde(default)]
    pub starts_at: Option<String>,
    #[serde(default)]
    pub ends_at: Option<String>,
}

/// Where a message is at `now` (Public Presence's `promoBarMessageStatusAt`, copied: the API does
/// not return it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    Scheduled,
    Expired,
    Inactive,
}

fn instant(text: Option<&str>) -> Option<Timestamp> {
    text.and_then(corten::i18n::parse_timestamp).and_then(|t| Timestamp::try_from(t).ok())
}

impl Message {
    pub fn status(&self, now: Timestamp) -> Status {
        if !self.is_active {
            return Status::Inactive;
        }
        if instant(self.starts_at.as_deref()).is_some_and(|at| at > now) {
            return Status::Scheduled;
        }
        if instant(self.ends_at.as_deref()).is_some_and(|at| at <= now) {
            return Status::Expired;
        }
        Status::Active
    }
}

/// A message's fields as the forms send them (admin-web's names).
#[derive(Clone, Debug, Default, Deserialize, Serialize, Fields, ToJson)]
#[serde(default, rename_all = "camelCase")]
pub struct MessageForm {
    pub intent: String,
    pub id: String,
    pub title: String,
    pub description: String,
    pub href: String,
    pub link_label: String,
    pub tone: String,
    pub is_active: String,
    pub display_order: String,
    pub starts_at: String,
    pub ends_at: String,
}

/// A wall-clock time as it reads in `zone` (`datetime-local`'s value), or empty.
pub fn local(at: Option<&str>, zone: &TimeZone) -> String {
    instant(at).map_or_else(String::new, |at| at.to_zoned(zone.clone()).strftime("%Y-%m-%dT%H:%M").to_string())
}

/// A `datetime-local` value as the instant it is in `zone`, or the text as typed when it cannot be read.
pub fn sent_time(text: &str, zone: &TimeZone) -> Value {
    let text = text.trim();
    if text.is_empty() {
        return Value::Null;
    }
    let read = text.parse::<jiff::civil::DateTime>().ok().and_then(|civil| civil.to_zoned(zone.clone()).ok());
    match read {
        Some(zoned) => json!(zoned.timestamp().to_string()),
        None => json!(text),
    }
}

impl MessageForm {
    /// A new message: admin-web's defaults.
    pub fn new() -> Self {
        MessageForm { tone: "info".into(), is_active: "true".into(), display_order: "100".into(), ..MessageForm::default() }
    }

    /// The form for `message`, its times in `zone`.
    pub fn of(message: &Message, zone: &TimeZone) -> Self {
        MessageForm {
            intent: "update".into(),
            id: message.id.clone(),
            title: message.title.clone(),
            description: message.description.clone().unwrap_or_default(),
            href: message.href.clone().unwrap_or_default(),
            link_label: message.link_label.clone().unwrap_or_default(),
            tone: message.tone.clone(),
            is_active: if message.is_active { "true".into() } else { String::new() },
            display_order: message.display_order.to_string(),
            starts_at: local(message.starts_at.as_deref(), zone),
            ends_at: local(message.ends_at.as_deref(), zone),
        }
    }

    /// The body admin-web's `messageBody` sends: blank text is null; an empty order is 0 and one that
    /// is not a number is null (`Number(..)`, then JSON), which the API reads as 100.
    pub fn body(&self, zone: &TimeZone) -> Value {
        fn optional(v: &str) -> Option<&str> {
            Some(v.trim()).filter(|v| !v.is_empty())
        }
        let order = self.display_order.trim();
        let order = if order.is_empty() { json!(0) } else { order.parse::<f64>().map_or(Value::Null, |n| json!(n)) };
        json!({
            "title": self.title,
            "description": optional(&self.description),
            "href": optional(&self.href),
            "linkLabel": optional(&self.link_label),
            "tone": if self.tone.is_empty() { "info" } else { self.tone.as_str() },
            "isActive": self.is_active == "true",
            "displayOrder": order,
            "startsAt": sent_time(&self.starts_at, zone),
            "endsAt": sent_time(&self.ends_at, zone),
        })
    }
}

#[derive(Deserialize)]
struct List {
    items: Vec<Message>,
}

/// The page as drawn.
#[derive(Serialize, ToJson)]
pub struct PromoScreen {
    pub messages: Vec<Message>,
    /// The create form: as sent when a create was refused, else new.
    pub create: MessageForm,
    /// The edit sheet's form, when one is open.
    pub edit: Option<MessageForm>,
    /// The message whose delete confirmation is open.
    pub delete: Option<Message>,
    /// What the last write did (`DONE`).
    pub done: Option<String>,
    /// Why the last write was refused.
    pub error: Option<String>,
    #[serde(skip)]
    pub now: Timestamp,
}

/// The operator's zone, or UTC when the browser has not said.
pub fn zone_of(zone: Option<ClientZone>) -> TimeZone {
    zone.and_then(|ClientZone(name)| TimeZone::get(&name).ok()).unwrap_or(TimeZone::UTC)
}

async fn page(
    req: Req,
    Caller(staff): Caller<Staff<GrowthView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Params(route): Params<url::Promo>,
) -> HtmlResult {
    draw(&req, &staff.viewer, &config, &headers, &zone_of(zone), &route.open, None, StatusCode::OK).await
}

/// A write that was refused: what it sent, and why.
struct Refused {
    form: MessageForm,
    message: String,
}

#[allow(clippy::too_many_arguments)]
async fn draw(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    zone: &TimeZone,
    open: &url::Open,
    refused: Option<Refused>,
    status: StatusCode,
) -> HtmlResult {
    let caller = config.platform.caller(headers, config.proto, None);
    let messages = match caller.read::<List>(BASE, CONTEXT).await {
        Ok(list) => list.items,
        Err(error) => return read_failed(req, error, false),
    };
    let find = |id: Option<&str>| id.and_then(|id| messages.iter().find(|m| m.id == id)).cloned();
    let (create, edit, error) = match refused {
        Some(Refused { form, message }) if form.intent == "create" => (form, None, Some(message)),
        Some(Refused { form, message }) if form.intent == "update" => (MessageForm::new(), Some(form), Some(message)),
        Some(Refused { message, .. }) => (MessageForm::new(), None, Some(message)),
        None => (MessageForm::new(), find(open.edit.as_deref()).map(|m| MessageForm::of(&m, zone)), None),
    };
    let screen = PromoScreen {
        delete: if edit.is_none() { find(open.delete.as_deref()) } else { None },
        messages,
        create,
        edit,
        done: open.done.clone().filter(|d| DONE.contains(&d.as_str()) && error.is_none()),
        error,
        now: Timestamp::now(),
    };
    let t: Gro = req.t();
    let view = html! { <views::PromoPage t={t} screen={&screen} marketplace={crate::app::marketplace_origin()} /> };
    req.screen_with_status(
        status,
        &screen,
        html! {
            <crate::views::Layout req={req} viewer={Some(viewer)} title={t.route_promo_bar()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// What the page says when the API refuses a write, and its status.
fn refusal(t: Gro, error: &ApiError) -> (String, StatusCode) {
    match error.status() {
        Some(StatusCode::FORBIDDEN) => (error.refusal().unwrap_or(t.promo_action_failed()).to_owned(), StatusCode::FORBIDDEN),
        Some(status) if status.is_client_error() => {
            (error.refusal().unwrap_or(t.promo_action_failed()).to_owned(), StatusCode::UNPROCESSABLE_ENTITY)
        }
        _ => {
            tracing::warn!("a promo bar write failed: {error}");
            (t.promo_action_failed().to_owned(), StatusCode::BAD_GATEWAY)
        }
    }
}

async fn act(
    req: Req,
    Caller(staff): Caller<Staff<GrowthView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    zone: Option<ClientZone>,
    Form(form): Form<MessageForm>,
) -> HtmlResult {
    let t: Gro = req.t();
    let zone = zone_of(zone);
    let id = form.id.trim().to_owned();
    let caller = config.platform.caller(&headers, config.proto, None);
    let one = |suffix: &str| format!("{BASE}/{}{suffix}", segment(&id));
    let (request, done) = match form.intent.as_str() {
        "create" => (caller.request(Method::POST, BASE, CONTEXT).json(&form.body(&zone)), "created"),
        "update" if !id.is_empty() => (caller.request(Method::PUT, &one(""), CONTEXT).json(&form.body(&zone)), "updated"),
        "activate" if !id.is_empty() => (caller.request(Method::POST, &one("/activate"), CONTEXT).json(&json!({})), "activated"),
        "deactivate" if !id.is_empty() => {
            (caller.request(Method::POST, &one("/deactivate"), CONTEXT).json(&json!({})), "deactivated")
        }
        "delete" if !id.is_empty() => (caller.request(Method::DELETE, &one(""), CONTEXT), "deleted"),
        // No message or an unknown intent: admin-web answers "No promo bar change was applied".
        _ => {
            let refused = Refused { form: MessageForm::default(), message: t.promo_action_noop().to_owned() };
            return draw(
                &req,
                &staff.viewer,
                &config,
                &headers,
                &zone,
                &url::Open::default(),
                Some(refused),
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        }
    };
    match caller.write::<Value>(request).await {
        Ok(_) => req.redirect(&url::Promo { open: url::Open { done: Some(done.to_owned()), ..url::Open::default() } }),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
        Err(error) => {
            let (message, status) = refusal(t, &error);
            draw(&req, &staff.viewer, &config, &headers, &zone, &url::Open::default(), Some(Refused { form, message }), status)
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(active: bool, starts: Option<&str>, ends: Option<&str>) -> Message {
        Message {
            id: "pbm_1".into(),
            title: "Hi".into(),
            description: None,
            href: None,
            link_label: None,
            tone: "info".into(),
            is_active: active,
            display_order: 10,
            starts_at: starts.map(Into::into),
            ends_at: ends.map(Into::into),
        }
    }

    #[test]
    fn a_messages_status_is_public_presences() {
        let now: Timestamp = "2026-10-31T12:00:00Z".parse().unwrap();
        assert_eq!(message(false, None, None).status(now), Status::Inactive);
        assert_eq!(message(true, Some("2026-11-01 00:00:00+00"), None).status(now), Status::Scheduled);
        assert_eq!(message(true, None, Some("2026-10-31 12:00:00+00")).status(now), Status::Expired);
        assert_eq!(message(true, Some("2026-10-01 00:00:00+00"), Some("2026-12-01 00:00:00+00")).status(now), Status::Active);
    }

    #[test]
    fn times_are_the_operators_and_the_body_is_admin_webs() {
        let chicago = TimeZone::get("America/Chicago").unwrap();
        assert_eq!(local(Some("2026-11-10 15:00:00+00"), &chicago), "2026-11-10T09:00");
        assert_eq!(sent_time("2026-11-10T09:00", &chicago), json!("2026-11-10T15:00:00Z"));
        assert_eq!(sent_time("2026-10-20T09:00", &chicago), json!("2026-10-20T14:00:00Z"), "daylight time");
        assert_eq!(sent_time("soon", &chicago), json!("soon"), "the API refuses it in its words");
        let form = MessageForm { title: "T".into(), description: "  ".into(), display_order: "".into(), ..MessageForm::new() };
        let body = form.body(&TimeZone::UTC);
        assert_eq!(body["description"], Value::Null);
        assert_eq!((body["displayOrder"].clone(), body["isActive"].clone()), (json!(0), json!(true)));
        let form = MessageForm { display_order: "x".into(), is_active: String::new(), ..MessageForm::new() };
        assert_eq!(
            (form.body(&TimeZone::UTC)["displayOrder"].clone(), form.body(&TimeZone::UTC)["isActive"].clone()),
            (Value::Null, json!(false))
        );
    }
}
