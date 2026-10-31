//! The Operations Attention queue (`/platform/operations-attention`, admin-web's
//! `OperationsAttentionQueuePage` in the platform section): everything that needs an operator,
//! most important first, read from `GET /api/platform/operations-attention` as the signed-in staff
//! member. The area has its own stylesheet and caller: admin-web challenges the page for
//! `projection-operations.view` (its nav entry's permission), and the API drops each source the
//! caller may not see.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/operations-attention` | the queue: its counts, the sources it could not read, its items |
//! | `GET /platform/operations-attention/live` | the queue again on each change (`<corten-live>`) |
//!
//! The page follows the realtime topic admin-web follows,
//! `platform-operations:admin:operations-attention`, and draws the queue again on each change, as
//! admin-web revalidates its route. The platform does not register that topic yet, so the API
//! refuses the stream and the page stays as it was drawn (admin-web's says Connecting);
//! chase-sets/chase-sets#10607.
use corten::{LiveResponse, LiveSince, axum::http::HeaderMap, prelude::*};
use serde::Serialize;

pub mod api;
pub mod views;

use crate::{
    app::{Shared, live_rows, read_failed},
    auth::{self, OperationsView, Staff},
    text::Ops,
};
use api::{DeepLink, Queue};

/// The topic admin-web's page follows (`OPERATIONS_ATTENTION_REALTIME_TOPICS`).
pub const TOPIC: &str = "platform-operations:admin:operations-attention";

/// The queue's routes: the queue is the area's route. admin-web challenges the page for
/// `projection-operations.view` (its nav entry's permission), so every handler takes staff with it.
#[corten::routes(state = Shared, area = Attention, caller = Staff<OperationsView>)]
pub mod url {
    #[route("/platform/operations-attention", get = queue)]
    pub struct Attention;

    /// The queue, streamed again on each change.
    #[route("/platform/operations-attention/live", get = live)]
    pub struct AttentionLive;
}

/// The area: its routes and its stylesheet.
pub fn area(area: Area<url::Attention>, shared: Shared) -> Area<url::Attention> {
    url::area(area, shared).components(views::COMPONENTS).components(crate::views::LIVE)
}

/// The page's view model: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub queue: Queue,
}

async fn queue(
    req: Req,
    Caller(staff): Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let caller = config.platform.caller(&headers, config.proto, None);
    let queue = match api::read(&caller).await {
        Ok(queue) => queue,
        Err(error) => return read_failed(&req, error, false),
    };
    let screen = Screen { queue };
    let t: Ops = req.t();
    let view = html! { <views::AttentionPage t={t} queue={&screen.queue} /> };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.attention_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// The queue's counts, sources and items, drawn again on each change to the topic.
async fn live(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    since: LiveSince,
) -> LiveResponse {
    let t: Ops = req.t();
    live_rows(config, headers, since, TOPIC, move |config, headers| async move {
        let caller = config.platform.caller(&headers, config.proto, None);
        let queue = api::read(&caller).await.ok()?;
        Some(views::queue_body(t, &queue).to_html())
    })
}

/// admin-web's section for an item's surface (`OPERATIONS_ATTENTION_SOURCES`'s targets).
fn section(surface: &str) -> Option<&'static str> {
    match surface {
        "projection-operations" => Some("platform"),
        "support-operations" | "platform-feedback" => Some("support"),
        _ => None,
    }
}

/// Where an item's Open goes: its admin-web page. The API sends the path without its section
/// (`/projections?tab=blocked`, `/platform-feedback/{id}`), which admin-web does not serve, so the
/// pilot puts the surface's section in front of a path that has none. Remove that when
/// chase-sets/chase-sets#10606 lands; a path with its section is taken as it is.
pub fn open_href(link: &DeepLink) -> Option<String> {
    if !link.href.starts_with('/') || link.href.starts_with("//") {
        return None;
    }
    let first = link.href[1..].split(['/', '?', '#']).next().unwrap_or("");
    let path =
        if auth::SECTIONS.contains(&first) { link.href.clone() } else { format!("/{}{}", section(&link.surface)?, link.href) };
    // A page the pilot serves opens here.
    if let Some(own) = crate::support::feedback::serves(&path).or_else(|| crate::support::requests::serves(&path)) {
        return Some(own);
    }
    crate::views::admin_web(&path).map(|uri| uri.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(surface: &str, href: &str) -> DeepLink {
        DeepLink { surface: surface.into(), href: href.into() }
    }

    #[test]
    fn an_items_open_is_its_admin_web_page_in_its_section() {
        let origin = crate::app::admin_web_origin();
        let open = |surface: &str, href: &str| open_href(&link(surface, href)).map(|h| h.trim_start_matches(origin).to_owned());
        assert_eq!(
            open("projection-operations", "/projections?tab=blocked").as_deref(),
            Some("/platform/projections?tab=blocked")
        );
        assert_eq!(open("support-operations", "/requests?requestId=req_1").as_deref(), Some("/support/requests?requestId=req_1"));
        assert_eq!(open("platform-feedback", "/platform-feedback/pfb_1").as_deref(), Some("/support/platform-feedback/pfb_1"));
        assert_eq!(
            open("platform-feedback", "/support/platform-feedback/pfb_1").as_deref(),
            Some("/support/platform-feedback/pfb_1"),
            "a sectioned path as it is"
        );
        assert_eq!(open("other", "/elsewhere"), None, "an unknown surface has no page");
        assert_eq!(open("platform-feedback", "https://example.test/x"), None, "only admin-web paths");
        assert_eq!(open("platform-feedback", "//example.test/x"), None);
    }
}
