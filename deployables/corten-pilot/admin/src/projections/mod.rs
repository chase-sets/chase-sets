//! Projection Operations (`/platform/projections`, admin-web's `ProjectionOperationsPage` in the platform
//! section): the console's health, its filters, the repair queue and the recent operations, read
//! from `GET /api/platform/projections` and its wake status as the signed-in staff member, and a
//! record's details (`selected`) in a sheet with its repairs; and its settings and reference page
//! (admin-web's `ProjectionOperationsReferencePage`): the groups, the subscription matrix, the
//! workers, the wake pipeline's signals and the read's diagnostics, from the same reads, with the
//! same filters and sheet. The area has its own stylesheet and caller: admin-web challenges both
//! pages for `projection-operations.view` (its nav entry's permission). The page offers each write only to staff the API lets make it (`.operate`,
//! `.rebuild`), and the API checks again.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /platform/projections?search&state&context_name&projection_name&selected` | the console |
//! | `GET /platform/projections/live?..` | its health, repair queue and operations again each time a running operation changes state (`<corten-live>`) |
//! | `GET /platform/projections/reference?search&state&context_name&projection_name&selected` | settings and reference |
//! | `POST /platform/projections/refresh?..` | Refresh status |
//! | `POST /platform/projections/retry?..` | Retry a blocked stream |
//! | `POST /platform/projections/rebuild?..` | Rebuild a projection group |
//! | `POST /platform/projections/rebuild-context?..` | Rebuild every group of a context |
//! | `POST /platform/projections/cancel?..` | Cancel an operation |
//!
//! Each write goes back to the page it came from as it was (its filters and selection; `via=reference`
//! for the reference page), as admin-web's do; an operation it queued is in the console's Recent
//! operations, followed live.
use std::collections::HashMap;

use corten::{Fragment, LiveResponse, axum::http::HeaderMap, prelude::*};
use futures_util::{StreamExt, stream};
use platform::jobs::Update;
use serde::{Deserialize, Serialize};

pub mod api;
pub mod views;

use crate::{
    app::{Shared, read_failed},
    auth::{OperationsView, Staff},
    text::Ops,
};
use api::{AttentionItem, Operation, Snapshot};

/// Who may queue a retry, a cancel or a status refresh.
pub const OPERATE: &str = "projection-operations.operate";
/// Who may rebuild a group or a context.
pub const REBUILD: &str = "projection-operations.rebuild";

/// The console's routes: the console is the area's route. Every handler takes staff with
/// `projection-operations.view`, as admin-web's page does.
#[corten::routes(state = Shared, area = Projections, caller = Staff<OperationsView>)]
pub mod url {
    use corten::prelude::*;
    use serde::Deserialize;

    /// The console's filters and the record whose details are open: what the console, its live
    /// part and each write carry, so a write comes back to the console as it was.
    #[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
    #[route(query)]
    pub struct Filters {
        pub search: Option<String>,
        pub state: Option<String>,
        pub context_name: Option<String>,
        pub projection_name: Option<String>,
        pub selected: Option<String>,
        /// The page a write answers with; none is the console.
        pub via: Option<Via>,
    }

    /// The page a link or a write leads to: the console, or settings and reference.
    #[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, corten::UrlValue)]
    #[serde(rename_all = "snake_case")]
    pub enum Via {
        #[default]
        Console,
        Reference,
    }

    #[derive(Clone, Debug, Default)]
    #[route("/platform/projections", get = console)]
    pub struct Projections {
        #[route(query)]
        pub filters: Filters,
    }

    /// Settings and reference: the groups, the subscriptions, the workers, the wake pipeline's
    /// signals and the read's diagnostics.
    #[derive(Clone, Debug, Default)]
    #[route("/platform/projections/reference", get = reference)]
    pub struct Reference {
        #[route(query)]
        pub filters: Filters,
    }

    /// The console's health, repair queue and operations, again as running operations change.
    #[route("/platform/projections/live", get = live)]
    pub struct ProjectionsLive {
        #[route(query)]
        pub filters: Filters,
    }

    #[route("/platform/projections/refresh", post = refresh)]
    pub struct Refresh {
        #[route(query)]
        pub filters: Filters,
    }

    #[route("/platform/projections/retry", post = retry)]
    pub struct Retry {
        #[route(query)]
        pub filters: Filters,
    }

    #[route("/platform/projections/rebuild", post = rebuild)]
    pub struct Rebuild {
        #[route(query)]
        pub filters: Filters,
    }

    #[route("/platform/projections/rebuild-context", post = rebuild_context)]
    pub struct RebuildContext {
        #[route(query)]
        pub filters: Filters,
    }

    #[route("/platform/projections/cancel", post = cancel)]
    pub struct Cancel {
        #[route(query)]
        pub filters: Filters,
    }
}

impl url::Filters {
    fn get(value: &Option<String>) -> &str {
        value.as_deref().map(str::trim).unwrap_or("")
    }

    pub fn search(&self) -> &str {
        Self::get(&self.search)
    }

    pub fn state(&self) -> &str {
        Self::get(&self.state)
    }

    pub fn context(&self) -> &str {
        Self::get(&self.context_name)
    }

    pub fn projection(&self) -> &str {
        Self::get(&self.projection_name)
    }

    pub fn selected(&self) -> &str {
        Self::get(&self.selected)
    }

    /// The same filters with `selected` open (admin-web's `projectionSelectionHref`).
    pub fn select(&self, selected: Option<&str>) -> url::Filters {
        url::Filters { selected: selected.map(str::to_owned), ..self.clone() }
    }

    /// The page `via` names with these filters (admin-web's `projectionSelectionHref` on its base).
    pub fn on(&self, via: url::Via) -> String {
        let filters = url::Filters { via: None, ..self.clone() };
        match via {
            url::Via::Console => url::Projections { filters }.href(),
            url::Via::Reference => url::Reference { filters }.href(),
        }
    }

    /// The same filters for a write from `via`'s page, so it answers with that page.
    pub fn writing_from(&self, via: url::Via) -> url::Filters {
        url::Filters { via: (via == url::Via::Reference).then_some(via), ..self.clone() }
    }

    /// Whether a record with these values is shown (admin-web's `matchesProjectionFilters`):
    /// its text holds the search (any case), and its state, context and projection are the ones chosen.
    pub fn matches(&self, text: &str, state: &str, context: Option<&str>, projection: Option<&str>) -> bool {
        let search = self.search().to_lowercase();
        (search.is_empty() || text.to_lowercase().contains(&search))
            && (self.state().is_empty() || state == self.state())
            && (self.context().is_empty() || context == Some(self.context()))
            && (self.projection().is_empty() || projection == Some(self.projection()))
    }
}

/// The area: its routes, its stylesheet and the live status it shares with the other areas.
pub fn area(area: Area<url::Projections>, shared: Shared) -> Area<url::Projections> {
    url::area(area, shared).components(views::COMPONENTS).components(crate::views::LIVE)
}

/// The page's view model: what it shows and what a data client gets.
#[derive(Serialize, ToJson)]
pub struct Screen {
    pub console: Snapshot,
    /// The wake pipeline's attention items; none when its read failed.
    pub wake: Option<Vec<AttentionItem>>,
}

/// The console and the wake pipeline's attention, read together. The wake read is optional:
/// the console is drawn without it when it fails.
async fn read(config: &Shared, headers: &HeaderMap) -> Result<Screen, api::ApiError> {
    let caller = config.platform.caller(headers, config.proto, None);
    let (console, wake) = tokio::join!(api::read(&caller), api::wake(&caller));
    Ok(Screen { console: console?, wake: wake.map(|w| w.attention_items) })
}

/// What a selection needs that the console's read does not carry: the details of each blocked
/// projection, which it sends as counts only (chase-sets/chase-sets#10710). Read only for a
/// selected record that is not an operation, each projection's in parallel; one that fails stays
/// without details. Remove when the read carries them.
async fn blocked_details(config: &Shared, headers: &HeaderMap, console: &mut Snapshot, selected: &str) {
    if selected.is_empty() || console.operations.iter().any(|o| o.operation_id == selected) {
        return;
    }
    let caller = config.platform.caller(headers, config.proto, None);
    let reads = console.blocked_projections.iter().map(|b| api::blocked(&caller, &b.projection_key));
    let details = futures_util::future::join_all(reads).await;
    for (projection, detail) in console.blocked_projections.iter_mut().zip(details) {
        match detail {
            Ok(detail) => {
                projection.blocked_streams = detail.blocked_streams;
                projection.poison_events = detail.poison_events;
            }
            Err(error) => tracing::warn!("blocked streams of {} unreadable: {error}", projection.projection_key),
        }
    }
}

async fn console(
    req: Req,
    Caller(staff): Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Projections>,
) -> HtmlResult {
    let filters = route.filters;
    let mut screen = match read(&config, &headers).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, error, false),
    };
    blocked_details(&config, &headers, &mut screen.console, filters.selected()).await;
    let t: Ops = req.t();
    let view = html! {
        <views::ConsolePage t={t} screen={&screen} filters={&filters} viewer={&staff.viewer} />
    };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.projections_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// Settings and reference: the console's reads drawn as its groups, subscriptions, workers, wake
/// signals and diagnostics, with the same filters and selection sheet. Not followed live, as
/// admin-web's page is not.
async fn reference(
    req: Req,
    Caller(staff): Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Reference>,
) -> HtmlResult {
    let filters = route.filters;
    let mut screen = match read(&config, &headers).await {
        Ok(screen) => screen,
        Err(error) => return read_failed(&req, error, false),
    };
    blocked_details(&config, &headers, &mut screen.console, filters.selected()).await;
    let t: Ops = req.t();
    let view = html! {
        <views::ReferencePage t={t} screen={&screen} filters={&filters} viewer={&staff.viewer} />
    };
    req.screen(
        &screen,
        html! {
            <crate::views::Layout req={&req} viewer={Some(&staff.viewer)} title={t.projections_reference_meta_title()} head="">
                {view}
            </crate::views::Layout>
        },
    )
}

/// The console's health, repair queue and operations, drawn again each time a running operation
/// changes state: admin-web follows each queued or running operation's status stream and reads the
/// console again when one moves (`onOperationTerminal`). Each operation's stream is the API's
/// (`/operations/{id}/events`); a record no newer than the one the page has, or in the same
/// state, draws nothing. The stream ends once every followed operation is done. There is no cursor:
/// several streams make one, so a browser that reconnects reads the console again.
async fn live(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::ProjectionsLive>,
) -> LiveResponse {
    let filters = route.filters;
    let t: Ops = req.t();
    let Ok(first) = read(&config, &headers).await else { return corten::live(stream::empty::<String>()) };
    let followed: Vec<&Operation> = first.console.operations.iter().filter(|o| o.live()).collect();
    let mut known: HashMap<String, (String, String)> =
        followed.iter().map(|o| (o.operation_id.clone(), (o.state.clone(), o.updated_at.clone()))).collect();
    let caller = config.platform.caller(&headers, config.proto, None);
    let streams: Vec<_> = followed
        .iter()
        .map(|o| {
            caller
                .watch_job::<Operation>(&api::operation_events(&o.operation_id), api::CONTEXT, None, Operation::terminal)
                .boxed()
        })
        .collect();
    drop(caller);
    let moved = stream::select_all(streams).filter_map(move |update| {
        std::future::ready(match update {
            Update::Job(operation, _) => {
                let seen = known.get(&operation.operation_id);
                let newer = seen.is_none_or(|(state, at)| *state != operation.state && operation.updated_at >= *at);
                if newer {
                    known.insert(operation.operation_id.clone(), (operation.state.clone(), operation.updated_at.clone()));
                }
                newer.then_some(())
            }
            Update::Refused(_) => None,
        })
    });
    let fragments = moved
        .then(move |()| {
            let (config, headers, filters) = (config.clone(), headers.clone(), filters.clone());
            async move {
                let screen = read(&config, &headers).await.ok()?;
                Some(Fragment::new(views::live_parts(t, &screen, &filters).to_html()))
            }
        })
        .filter_map(std::future::ready);
    corten::live(fragments)
}

/// Back to the page the write came from, as the write found it.
fn back(req: &Req, mut filters: url::Filters) -> HtmlResult {
    match filters.via.take() {
        Some(url::Via::Reference) => req.redirect(&url::Reference { filters }),
        _ => req.redirect(&url::Projections { filters }),
    }
}

/// A write the API refused or failed, as the page's answer: sign in again, 403, 404, or 502
/// (admin-web throws the API's answer to its error page).
fn write_failed(req: &Req, error: api::ApiError) -> HtmlResult {
    read_failed(req, error, false)
}

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct RetryInput {
    pub projection_key: String,
    pub stream_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct RebuildInput {
    pub context_name: String,
    pub projection_name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct ContextInput {
    pub context_name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct CancelInput {
    pub operation_id: String,
}

async fn refresh(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Refresh>,
) -> HtmlResult {
    let filters = route.filters;
    match api::refresh(&config.platform.caller(&headers, config.proto, None)).await {
        Ok(()) => back(&req, filters),
        Err(error) => write_failed(&req, error),
    }
}

async fn retry(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Retry>,
    Form(input): Form<RetryInput>,
) -> HtmlResult {
    let filters = route.filters;
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::retry_stream(&caller, &input.projection_key, &input.stream_id).await {
        Ok(_) => back(&req, filters),
        Err(error) => write_failed(&req, error),
    }
}

async fn rebuild(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Rebuild>,
    Form(input): Form<RebuildInput>,
) -> HtmlResult {
    let filters = route.filters;
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::rebuild_group(&caller, &input.context_name, &input.projection_name).await {
        Ok(_) => back(&req, filters),
        Err(error) => write_failed(&req, error),
    }
}

async fn rebuild_context(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::RebuildContext>,
    Form(input): Form<ContextInput>,
) -> HtmlResult {
    let filters = route.filters;
    let caller = config.platform.caller(&headers, config.proto, None);
    match api::rebuild_context(&caller, &input.context_name).await {
        Ok(_) => back(&req, filters),
        Err(error) => write_failed(&req, error),
    }
}

async fn cancel(
    req: Req,
    _: Caller<Staff<OperationsView>>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<crate::projections::url::Cancel>,
    Form(input): Form<CancelInput>,
) -> HtmlResult {
    let filters = route.filters;
    match api::cancel(&config.platform.caller(&headers, config.proto, None), &input.operation_id).await {
        Ok(()) => back(&req, filters),
        Err(error) => write_failed(&req, error),
    }
}
