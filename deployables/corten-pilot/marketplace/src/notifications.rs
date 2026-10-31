//! The account's notification center (Notifications' `routes/account-notifications.tsx`), at
//! `/account/notifications`: the feed of web notifications, and the settings (`view=settings`):
//! the delivery channels and the account's Product alerts, which Discovery owns.
//!
//! | Form | Posts to | Then |
//! |---|---|---|
//! | Mark read | `/account/notifications/read` | the feed; with a script, the feed the API answered with, drawn in place |
//! | Mark all read | `/account/notifications/read-all` | the same |
//! | A channel's switch | `/account/notifications/preferences/{key}` | the settings; with a script, the switch the API answered with |
//! | Pause, Resume, Delete | `/account/notifications/product-alerts/{id}` | the settings at the alerts, read after the write (`afterWrite`); with a script, the alerts read after it, drawn in place |
//!
//! `/account/product-alerts` (Discovery's `account-product-alerts`) sends a `GET` to the settings at
//! the alerts. Its form action is not ported: only marketplace's notification center posts to it.
//!
//! Each form works without JavaScript (post, then redirect). With it, each is a `data-patch`
//! form: the answer is only the part that changed. The API's answer to a feed or channel write
//! already holds what changed, so nothing is read again.
//!
//! A failed read is its own state (a banner and Try again, answered 502), never an empty feed or
//! empty settings: the settings need both of their reads, as marketplace's loader does. The
//! channels are the ones the page has words for (web, email and Product alerts); the API also
//! lists `sms` and `rcs`, which marketplace shows as bare keys and nothing delivers
//! (chase-sets/chase-sets#10625). The Product alerts list is Discovery's read model, so the read
//! after an alert's write waits for its receipt and, while it catches up, says the change is saved
//! and reads again.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;

use crate::{
    api::{AlertChange, ApiError, Caller as Api, Feed, Notifications as _, Preference, ProductAlert},
    app::{Shared, read_failed, sign_in_at, url},
    auth::{Member, Viewer},
    text::{NotificationsMsg, Pilot},
    views::{self, Layout},
};

/// `/account/product-alerts`: the settings at the Product alerts, which ask who they are for.
pub(crate) async fn product_alerts(req: Req) -> HtmlResult {
    req.redirect(&url::Notifications { place: Place::settings(Section::ProductAlerts, None) })
}

/// The address's parameters: the view, the settings' section, and the receipt of the write the
/// read waits for.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub view: Option<String>,
    pub section: Option<String>,
    pub after_write: Option<String>,
}

/// The feed, or the settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Feed,
    Settings,
}

/// The settings' section the address names (`readNotificationCenterLocation`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Preferences,
    ProductAlerts,
}

impl Place {
    /// The settings at `section`, read after `receipt`'s write.
    pub fn settings(section: Section, receipt: Option<&Receipt>) -> Self {
        Place {
            view: Some("settings".into()),
            section: (section == Section::ProductAlerts).then(|| "product-alerts".into()),
            after_write: receipt.map(Receipt::param),
        }
    }

    pub fn view(&self) -> View {
        if self.view.as_deref() == Some("settings") { View::Settings } else { View::Feed }
    }

    pub fn section(&self) -> Section {
        if self.section.as_deref() == Some("product-alerts") { Section::ProductAlerts } else { Section::Preferences }
    }
}

/// The channels the page has words for, in the order it shows them.
pub const CHANNELS: [&str; 3] = ["web", "email", "product-alerts"];

/// The Product alerts' section, as the address names it (`section=product-alerts`); links to it
/// are also at it (`#product-alerts`), and its heading takes focus.
pub const ALERTS: &str = "product-alerts";

/// The Product alerts, as the settings show them.
#[derive(Clone, Debug)]
pub enum Alerts {
    Listed(Vec<ProductAlert>),
    /// The read has not caught up with a write yet: saved, read again.
    CatchingUp,
    /// The read after a write failed: saved, but what it changed cannot be shown (a patch only).
    Unconfirmed,
}

/// What the settings show.
#[derive(Clone, Debug)]
pub struct Settings {
    pub preferences: Vec<Preference>,
    pub alerts: Alerts,
}

/// What a write that failed says, in the section its form is in.
#[derive(Clone, Debug)]
pub enum Notice {
    Feed(String),
    Preferences(String),
    Alerts(String),
}

/// What the page shows: each view's read, `None` when it failed.
pub enum Screen {
    Feed(Option<Feed>),
    Settings(Option<Settings>, Section),
}

/// A notification's Open: a path the pilot serves stays here, any other site path goes to
/// marketplace, and anything else (another site, a scheme) is no link.
pub fn open_href(href: &str) -> Option<String> {
    if !href.starts_with('/') || href.starts_with("//") {
        return None;
    }
    if served_here(href) { Some(href.to_owned()) } else { Some(views::on_marketplace(href)) }
}

/// Whether the pilot serves the page at `href`. Of the seller's shipments only a shipment's own
/// page is the pilot's: the list, the packing slips and the packing flow are marketplace's. Not
/// `Req::serves`, which would keep the list here only for the pilot to send it to marketplace.
fn served_here(href: &str) -> bool {
    const HERE: [&str; 16] = [
        "/items/",
        "/listings/",
        "/accounts/",
        "/sets/",
        "/search",
        "/categories/",
        "/account/cart",
        // The money page and a payout's page.
        "/account/desk/money",
        "/account/desk/payouts/",
        "/account/inventory/",
        "/account/notifications",
        "/account/purchases",
        "/account/sales",
        "/account/shipments",
        // The cases and a case's page.
        "/account/support",
        "/account/team",
    ];
    let path = href.split(['?', '#']).next().unwrap_or_default();
    if let Some(rest) = path.strip_prefix("/account/sales/shipments") {
        return rest.strip_prefix('/').is_some_and(|id| !id.is_empty() && !id.contains('/'));
    }
    HERE.iter().any(|p| path.starts_with(p))
}

/// The feed's form: the notification's delivery.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ReadInput {
    pub delivery: String,
}

/// A channel's form: what to turn it to.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct PreferenceInput {
    pub enabled: String,
}

/// An alert's form: what to do with it.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct AlertInput {
    pub action: String,
}

pub(crate) async fn page(
    req: Req,
    Caller(Member(viewer)): Caller<Member>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::notifications::Notifications>,
) -> HtmlResult {
    let place = route.place;
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let caller = config.platform.caller(&headers, config.proto, None);
    match place.view() {
        View::Feed => match caller.feed().await {
            Ok(feed) => render(&req, &viewer, &Screen::Feed(Some(feed)), None, StatusCode::OK),
            Err(error) => failed(&req, &viewer, Screen::Feed(None), error),
        },
        // An alert write's read again (`ReadAgain::from` in its patch): the section alone. A read
        // that fails says so in place, as a patch the runtime applies whatever its status; signed
        // out or refused answers the page's, which stops the reads.
        View::Settings if req.mode == corten::Mode::Action && place.section() == Section::ProductAlerts => {
            let waiting = config.platform.caller(&headers, config.proto, receipt.as_ref());
            match alerts(&waiting, receipt.is_some()).await {
                Ok(alerts) => alerts_patch(&req, &alerts, &url::Notifications { place: place.clone() }),
                Err(error) if matches!(error.status(), Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)) => {
                    failed(&req, &viewer, Screen::Settings(None, Section::ProductAlerts), error)
                }
                Err(error) => unconfirmed(&req, error),
            }
        }
        View::Settings => {
            let waiting = config.platform.caller(&headers, config.proto, receipt.as_ref());
            match settings(&caller, &waiting, receipt.is_some()).await {
                Ok(settings) => render(&req, &viewer, &Screen::Settings(Some(settings), place.section()), None, StatusCode::OK),
                Err(error) => failed(&req, &viewer, Screen::Settings(None, place.section()), error),
            }
        }
    }
}

/// The settings' two reads, together (either failing fails both, as marketplace's loader does);
/// the alerts through `waiting`, which waits for a write's receipt when there is one.
async fn settings(caller: &Api<'_>, waiting: &Api<'_>, after_write: bool) -> Result<Settings, ApiError> {
    let (preferences, alerts) = tokio::join!(caller.preferences(), alerts(waiting, after_write));
    Ok(Settings { preferences: preferences?, alerts: alerts? })
}

/// The account's alerts; after a write, a read that has not caught up yet is `CatchingUp`.
async fn alerts(caller: &Api<'_>, after_write: bool) -> Result<Alerts, ApiError> {
    match caller.product_alerts().await {
        Ok(alerts) => Ok(Alerts::Listed(alerts)),
        Err(error) if after_write && error.catching_up() => Ok(Alerts::CatchingUp),
        Err(error) => Err(error),
    }
}

/// A failed read: sign in again when the session ended, else the page's banner, 502.
fn failed(req: &Req, viewer: &Viewer, screen: Screen, error: ApiError) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(StatusCode::FORBIDDEN) => read_failed(req, Some(viewer), error, None),
        _ => {
            tracing::warn!("the notification center's read failed: {error}");
            render(req, viewer, &screen, None, StatusCode::BAD_GATEWAY)
        }
    }
}

fn render(req: &Req, viewer: &Viewer, screen: &Screen, notice: Option<&Notice>, status: StatusCode) -> HtmlResult {
    let t: NotificationsMsg = req.t();
    let p: Pilot = req.t();
    let again = matches!(screen, Screen::Settings(Some(Settings { alerts: Alerts::CatchingUp, .. }), _));
    let head = html! {
        <meta name="description" content={t.route_description()}>
        if again {
            <ReadAgain after={Duration::from_secs(2)} />
        }
    };
    req.page_with_status(
        status,
        html! {
            <Layout req={req} viewer={Some(viewer)} title={t.route_title()} head={head}>
                <views::NotificationPage t={t} p={p} screen={screen} notice={notice} />
            </Layout>
        },
    )
}

/// Marketplace's sign-in, back to the notification center.
fn sign_in(req: &Req) -> HtmlResult {
    match sign_in_at("/account/notifications") {
        Some(to) => req.redirect(&to),
        None => Err(corten::Error::status(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// The form a write came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Feed,
    Preferences,
    Alerts,
}

/// A write the API did not take: sign in when the session ended, else the view again with what
/// went wrong in the form's section (422 for a refusal, 502 when the API did not answer).
async fn refused(req: &Req, viewer: &Viewer, caller: &Api<'_>, form: Which, error: ApiError) -> HtmlResult {
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        return sign_in(req);
    }
    tracing::warn!("a notification center write failed: {error}");
    let t: NotificationsMsg = req.t();
    let refusal = error.status().is_some_and(|s| s.is_client_error());
    let status = if refusal { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::BAD_GATEWAY };
    let message = error.refusal().filter(|_| refusal).unwrap_or(t.page_read_failure_description()).to_owned();
    match form {
        Which::Feed => {
            let feed = caller.feed().await.ok();
            render(req, viewer, &Screen::Feed(feed), Some(&Notice::Feed(message)), status)
        }
        Which::Preferences | Which::Alerts => {
            let (notice, section) = match form {
                Which::Preferences => (Notice::Preferences(message), Section::Preferences),
                _ => (Notice::Alerts(message), Section::ProductAlerts),
            };
            let settings = settings(caller, caller, false).await.ok();
            render(req, viewer, &Screen::Settings(settings, section), Some(&notice), status)
        }
    }
}

/// The feed after a write: with a script, the feed the API answered with, in place; without one,
/// the feed's address.
fn feed_after(req: &Req, feed: &Feed) -> HtmlResult {
    if req.mode == corten::Mode::Action {
        let t: NotificationsMsg = req.t();
        return req.patch(html! { <views::FeedSection t={t} feed={feed} notice={None} /> });
    }
    req.redirect(&url::Notifications::default())
}

/// Mark read: the delivery the form names.
pub(crate) async fn mark_read(
    req: Req,
    Caller(Member(viewer)): Caller<Member>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(input): Form<ReadInput>,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.mark_read(input.delivery.trim()).await {
        Ok(feed) => feed_after(&req, &feed),
        Err(error) => refused(&req, &viewer, &caller, Which::Feed, error).await,
    }
}

/// Mark all read.
pub(crate) async fn mark_all_read(
    req: Req,
    Caller(Member(viewer)): Caller<Member>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.mark_all_read().await {
        Ok(feed) => feed_after(&req, &feed),
        Err(error) => refused(&req, &viewer, &caller, Which::Feed, error).await,
    }
}

/// A channel's switch: on or off, as the form says. With a script, the switch the API answered
/// with, in place; without one, the settings.
pub(crate) async fn set_preference(
    req: Req,
    Caller(Member(viewer)): Caller<Member>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::notifications::NotificationPreference<'_>>,
    Form(input): Form<PreferenceInput>,
) -> HtmlResult {
    let key = route.key;
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.set_preference(&key, input.enabled == "true").await {
        Ok(preference) if req.mode == corten::Mode::Action => {
            let t: NotificationsMsg = req.t();
            req.patch(html! { <views::PreferenceSwitch t={t} preference={&preference} /> })
        }
        Ok(_) => req.redirect(&url::Notifications { place: Place::settings(Section::Preferences, None) }),
        Err(error) => refused(&req, &viewer, &caller, Which::Preferences, error).await,
    }
}

/// Pause, resume or delete an alert, then the alerts read after the write. With a script, in
/// place: while the read catches up the section says the change is saved and asks to be read again
/// from the settings' address with the write's receipt (`ReadAgain::from`), which answers the
/// section the same way until the read is in; a read after the write that fails says the change
/// was saved and cannot be shown yet (502, in place). Without a script, the settings at the alerts
/// with the receipt, which say the same and read themselves again. Carrying the receipt is what marketplace does not do (chase-sets/chase-sets#10627).
pub(crate) async fn change_alert(
    req: Req,
    Caller(Member(viewer)): Caller<Member>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::app::url::notifications::ProductAlertChange<'_>>,
    Form(input): Form<AlertInput>,
) -> HtmlResult {
    let id = route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let Some(change) = AlertChange::read(&input.action) else {
        let t: NotificationsMsg = req.t();
        let settings = settings(&caller, &caller, false).await.ok();
        let notice = Notice::Alerts(t.page_read_failure_description().to_owned());
        return render(
            &req,
            &viewer,
            &Screen::Settings(settings, Section::ProductAlerts),
            Some(&notice),
            StatusCode::UNPROCESSABLE_ENTITY,
        );
    };
    let receipt = match caller.change_alert(&id, change).await {
        Ok(receipt) => receipt,
        Err(error) => return refused(&req, &viewer, &caller, Which::Alerts, error).await,
    };
    let to = url::Notifications { place: Place::settings(Section::ProductAlerts, receipt.as_ref()) };
    if req.mode == corten::Mode::Action {
        let waiting = config.platform.caller(&headers, config.proto, receipt.as_ref());
        return match alerts(&waiting, receipt.is_some()).await {
            Ok(alerts) => alerts_patch(&req, &alerts, &to),
            Err(error) => unconfirmed(&req, error),
        };
    }
    req.redirect(&to.at(views::ProductAlertsId))
}

/// The alerts' section when the read after a write failed: the write was saved, the section says
/// so and that a reload shows it (502).
fn unconfirmed(req: &Req, error: ApiError) -> HtmlResult {
    tracing::warn!("the product alerts' read after a write failed: {error}");
    let (t, p): (NotificationsMsg, Pilot) = (req.t(), req.t());
    req.patch_with_status(
        StatusCode::BAD_GATEWAY,
        html! { <views::AlertsSection t={t} p={p} alerts={&Alerts::Unconfirmed} notice={None} focus={false} /> },
    )
}

/// The alerts' section as a patch; while the read is catching up with a write it asks to be read
/// again from `from`, the settings' address with the write's receipt, which answers this again.
fn alerts_patch(req: &Req, alerts: &Alerts, from: &url::Notifications) -> HtmlResult {
    let (t, p): (NotificationsMsg, Pilot) = (req.t(), req.t());
    let again = matches!(alerts, Alerts::CatchingUp).then(|| ReadAgain { after: Duration::from_secs(2) }.from(from));
    req.patch(html! {
        <views::AlertsSection t={t} p={p} alerts={alerts} notice={None} focus={false} />
        {again}
    })
}

#[cfg(test)]
mod tests {
    use super::{Place, Section, View, open_href};

    #[test]
    fn the_address_names_the_view_and_the_section_as_marketplace_reads_them() {
        let place = |view: Option<&str>, section: Option<&str>| Place {
            view: view.map(Into::into),
            section: section.map(Into::into),
            after_write: None,
        };
        assert_eq!(place(None, Some("product-alerts")).view(), View::Feed);
        assert_eq!(place(Some("settings"), None).section(), Section::Preferences);
        assert_eq!(place(Some("settings"), Some("nope")).section(), Section::Preferences);
        assert_eq!(place(Some("settings"), Some("product-alerts")).section(), Section::ProductAlerts);
    }

    #[test]
    fn open_stays_here_for_a_ported_page_goes_to_marketplace_for_another_and_is_no_link_off_site() {
        assert_eq!(open_href("/items/charizard").as_deref(), Some("/items/charizard"));
        assert_eq!(open_href("/account/purchases/ord_1").as_deref(), Some("/account/purchases/ord_1"));
        assert_eq!(open_href("/account/shipments/shp_1").as_deref(), Some("/account/shipments/shp_1"));
        assert_eq!(open_href("/account/sales/shipments/shp_1").as_deref(), Some("/account/sales/shipments/shp_1"));
        let slips = "/account/sales/shipments/packing-slips?shipmentIds=shp_1";
        assert_eq!(open_href(slips).as_deref(), Some(slips));
        for marketplaces in ["/account/sales/shipments", "/account/sales/shipments/shp_1/packing", "/account/offers"] {
            assert_eq!(open_href(marketplaces), Some(format!("http://localhost:7753{marketplaces}")), "{marketplaces}");
        }
        assert_eq!(open_href("https://example.com/x"), None);
        assert_eq!(open_href("//example.com/x"), None);
    }
}
