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
//! admin-web revalidates its route. Platform Operations publishes to it when a support request,
//! a reported-content response or platform feedback changes.
use corten::{LiveResponse, LiveSince, http::HeaderMap, prelude::*};
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

/// Where an item's Open goes: the admin path the API sends, with its section
/// (`/platform/projections?tab=blocked`, `/support/platform-feedback/{id}`), opened here when the
/// pilot serves that page and on admin-web otherwise. Anything else has no page.
pub fn open_href(link: &DeepLink) -> Option<String> {
    if !link.href.starts_with('/') || link.href.starts_with("//") {
        return None;
    }
    let first = link.href[1..].split(['/', '?', '#']).next().unwrap_or("");
    if !auth::SECTIONS.contains(&first) {
        return None;
    }
    let path = link.href.clone();
    // A page the pilot serves opens here.
    let own = crate::support::feedback::serves(&path)
        .or_else(|| crate::support::requests::serves(&path))
        .or_else(|| crate::reported::serves(&path))
        .or_else(|| crate::projections::serves(&path));
    if let Some(own) = own {
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
            open_href(&link("projection-operations", "/platform/projections?tab=blocked")).as_deref(),
            Some("/platform/projections?tab=blocked"),
            "the pilot serves the projections console"
        );
        assert_eq!(
            open("projection-operations", "/platform/projections/elsewhere").as_deref(),
            Some("/platform/projections/elsewhere")
        );
        assert_eq!(
            open("support-operations", "/support/requests?requestId=req_1").as_deref(),
            Some("/support/requests?requestId=req_1")
        );
        assert_eq!(
            open("platform-feedback", "/support/platform-feedback/pfb_1").as_deref(),
            Some("/support/platform-feedback/pfb_1")
        );
        assert_eq!(
            open_href(&link("reported-content", "/support/reported-content/listing/lst_1")).as_deref(),
            Some("/support/reported-content/listing/lst_1"),
            "the pilot serves a reported target's page"
        );
        assert_eq!(
            open_href(&link("reported-content", "/support/reported-content")).as_deref(),
            Some("/support/reported-content")
        );
        assert_eq!(open("platform-feedback", "/platform-feedback/pfb_1"), None, "a path without its section has no page");
        assert_eq!(open("platform-feedback", "https://example.test/x"), None, "only admin-web paths");
        assert_eq!(open("platform-feedback", "//example.test/x"), None);
    }
}
