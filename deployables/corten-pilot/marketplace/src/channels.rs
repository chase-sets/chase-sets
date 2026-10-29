//! The channel screens (Channels' marketplace routes): the account's connections
//! (`account-channels`, `/account/channels`) with the status filter, the next page and
//! Connect a channel; a connection (`account-channels-connection`, `/account/channels/{id}`) with its
//! status, Pause, Resume and Disconnect, and Activate on storage locations while it is pending
//! setup; and the publication list (`account-channels-publication`, `/account/channels/publication`).
//!
//! Reading needs `channels.view` and writing `channels.manage` (`ChannelsMember`). Which providers a
//! seller may connect and which actions a connection allows are copied here from marketplace's
//! web layer until the Channels API returns them
//! ([chase-sets/chase-sets#10778](https://github.com/chase-sets/chase-sets/issues/10778)):
//! `PROVIDERS` and `actions`. A write goes to the connection with its receipt; a refusal is the page
//! with Channels' words for it (422), a failure the same with a 502. A connection's drift, health,
//! pairing, manual sync and operation log, and a connection's publication settings, are on
//! marketplace for now.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;

use crate::{
    api::{ApiError, ChannelCalls as _, ChannelConnection, ChannelConnectionPage, ChannelPublicationSummary, Inventory as _},
    app::{CHANNELS_MANAGE, Shared, read_failed, sign_in, url},
    auth::{ChannelsMember, Viewer},
    text::{ChannelsMsg, Pilot},
    views::{self, Layout},
};

/// The statuses a connection has, in the filter's order.
pub const STATUSES: [&str; 4] = ["pending-setup", "active", "paused", "disconnected"];

/// The providers a seller may connect, and the environment each is for: marketplace's registry,
/// whose setup is resolved on its server (#10778 asks the Channels API to answer this).
const PROVIDERS: [(&str, &str); 2] = [("tcgplayer", "sandbox"), ("tcgplayer", "production")];

/// The channel environment this deployment connects to (`mapDeploymentEnvironment`): production
/// for `DEPLOYMENT_ENVIRONMENT=production`, the sandbox for every other.
fn environment() -> &'static str {
    match std::env::var("DEPLOYMENT_ENVIRONMENT").as_deref().map(str::trim) {
        Ok("production") => "production",
        _ => "sandbox",
    }
}

/// The providers this seller may connect: none without `channels.manage`.
pub fn providers(viewer: &Viewer) -> Vec<&'static str> {
    if !viewer.actor.can(CHANNELS_MANAGE) {
        return Vec::new();
    }
    let environment = environment();
    PROVIDERS.iter().filter(|(_, e)| *e == environment).map(|(key, _)| *key).collect()
}

/// What a connection in `status` allows (`allowedChannelConnectionActions`; #10778).
pub fn actions(status: &str) -> &'static [&'static str] {
    match status {
        "pending-setup" => &["disconnect"],
        "active" => &["pause", "disconnect"],
        "paused" => &["resume", "disconnect"],
        _ => &[],
    }
}

/// The list's address: the status shown (none: every connection not disconnected) and the page.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct ListPlace {
    pub status: Option<String>,
    pub cursor: Option<String>,
}

impl ListPlace {
    /// The status asked for, when it is one a connection has.
    pub fn status(&self) -> Option<&str> {
        self.status.as_deref().filter(|status| STATUSES.contains(status))
    }

    fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref().map(str::trim).filter(|cursor| !cursor.is_empty())
    }

    /// The first page of `status`.
    pub fn of(status: Option<&str>) -> ListPlace {
        ListPlace { status: status.map(str::to_owned), cursor: None }
    }

    /// The page after this one.
    pub fn next(&self, cursor: &str) -> ListPlace {
        ListPlace { status: self.status().map(str::to_owned), cursor: Some(cursor.to_owned()) }
    }
}

/// A connection's address: the receipt of the write it follows.
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct ConnectionPlace {
    pub after_write: Option<String>,
}

/// Connect a channel.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ConnectForm {
    #[serde(rename = "providerKey")]
    pub provider_key: String,
}

/// A connection's write: `pause`, `resume`, `disconnect`, or `activate` on the locations checked.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ConnectionForm {
    pub intent: String,
    #[serde(rename = "storageLocationIds")]
    pub storage_location_ids: Vec<String>,
}

/// What the list shows.
pub struct ChannelsScreen {
    /// Channels' page; `None` when the read failed.
    pub page: Option<ChannelConnectionPage>,
    pub place: ListPlace,
    pub providers: Vec<&'static str>,
    /// What Connect was refused for.
    pub connect_error: Option<String>,
}

/// A storage location setup may activate on.
pub struct SetupLocation {
    pub id: String,
    pub name: String,
}

/// What a connection's page shows.
pub struct ConnectionScreen {
    pub connection: ChannelConnection,
    /// The seller may write (`channels.manage`).
    pub manage: bool,
    /// While it is pending setup, the storage locations to activate on (`None`: their read failed).
    pub locations: Option<Vec<SetupLocation>>,
    /// What a write was refused for.
    pub error: Option<String>,
}

fn noindex() -> impl Render {
    html! { <meta name="robots" content="noindex"> }
}

async fn render_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: ListPlace,
    connect_error: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let (page, status) = match caller.channel_connections(place.status(), place.cursor()).await {
        Ok(page) => (Some(page), status),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => return read_failed(req, Some(viewer), error, None),
        Err(error) => {
            tracing::warn!("the channel connections' read failed: {error}");
            (None, StatusCode::BAD_GATEWAY)
        }
    };
    let screen = ChannelsScreen { page, place, providers: providers(viewer), connect_error };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.connections_meta_title()} head={noindex()}>
            <views::ChannelsPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The connections, of the status and page the address names.
pub(crate) async fn list(
    req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::Channels>,
) -> HtmlResult {
    render_list(&req, &viewer, &config, &headers, route.place, None, StatusCode::OK).await
}

/// Connect a channel: the new connection's page with the write's receipt, or the list with what
/// was refused.
pub(crate) async fn connect(
    req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Form(form): Form<ConnectForm>,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let provider = form.provider_key.trim();
    let refused = |status| {
        render_list(
            &req,
            &viewer,
            &config,
            &headers,
            ListPlace::default(),
            Some(t.connections_action_failed().to_owned()),
            status,
        )
    };
    if !providers(&viewer).contains(&provider) {
        return refused(StatusCode::UNPROCESSABLE_ENTITY).await;
    }
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.connect_channel(provider).await {
        Ok((connection, receipt)) => req.redirect(&connection_url(&connection.connection_id, receipt.as_ref())),
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            status => {
                tracing::warn!("connecting a channel was refused: {error}");
                refused(refusal_status(status)).await
            }
        },
    }
}

fn refusal_status(status: Option<StatusCode>) -> StatusCode {
    if status.is_some_and(|s| s.is_client_error()) { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::BAD_GATEWAY }
}

fn connection_url<'a>(id: &'a str, receipt: Option<&Receipt>) -> url::ChannelConnection<'a> {
    url::ChannelConnection { id, place: ConnectionPlace { after_write: receipt.map(Receipt::param) } }
}

#[allow(clippy::too_many_arguments)]
async fn render_connection(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &ConnectionPlace,
    written: Option<ChannelConnection>,
    error: Option<String>,
    status: StatusCode,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let receipt = Receipt::from_param(place.after_write.as_deref());
    let read = match written {
        Some(connection) => Ok(connection),
        None => config.platform.caller(headers, config.proto, receipt.as_ref()).channel_connection(id).await,
    };
    let connection = match read {
        Ok(connection) => connection,
        // A write the read has not reached yet.
        Err(read) if receipt.is_some() && read.catching_up() => {
            let p: Pilot = req.t();
            let head = html! {
                <meta name="robots" content="noindex">
                <ReadAgain after={Duration::from_secs(2)} />
            };
            let here = connection_url(id, receipt.as_ref()).href();
            return req.page(html! {
                <Layout req={req} viewer={Some(viewer)} title={t.connections_connection_meta_title()} head={head}>
                    <views::ChannelsPending t={t} p={p} words={p.channels_pending()} refresh={&here} />
                </Layout>
            });
        }
        Err(read) if read.status() == Some(StatusCode::NOT_FOUND) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(read) => return read_failed(req, Some(viewer), read, None),
    };
    let manage = viewer.actor.can(CHANNELS_MANAGE);
    let locations = if manage && connection.status == "pending-setup" {
        let caller = config.platform.caller(headers, config.proto, None);
        match caller.locations().await {
            Ok(list) => Some(
                list.items
                    .into_iter()
                    .filter(|location| !location.is_archived)
                    .map(|location| SetupLocation { id: location.storage_location_id, name: location.name })
                    .collect(),
            ),
            Err(read) => {
                tracing::warn!("the storage locations' read for channel setup failed: {read}");
                None
            }
        }
    } else {
        Some(Vec::new())
    };
    let screen = ConnectionScreen { connection, manage, locations, error };
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} title={t.connections_connection_meta_title()} head={noindex()}>
            <views::ChannelConnectionPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// A connection, read after the write whose receipt the address carries.
pub(crate) async fn connection(
    req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelConnection<'_>>,
) -> HtmlResult {
    render_connection(&req, &viewer, &config, &headers, &route.id, &route.place, None, None, StatusCode::OK).await
}

/// Pause, Resume, Disconnect and Activate: the connection with the write's receipt, or the page
/// with what was refused.
pub(crate) async fn command(
    req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelConnection<'_>>,
    Form(form): Form<ConnectionForm>,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let id: &str = &route.id;
    let here = ConnectionPlace::default();
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome: Result<(ChannelConnection, Option<Receipt>), ApiError> = match form.intent.as_str() {
        command @ ("pause" | "resume" | "disconnect") => caller.channel_command(id, command).await,
        "activate" => {
            let locations: Vec<String> =
                form.storage_location_ids.iter().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).collect();
            if locations.is_empty() {
                let p: Pilot = req.t();
                let words = p.channels_choose_location().to_owned();
                return render_connection(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    id,
                    &here,
                    None,
                    Some(words),
                    StatusCode::UNPROCESSABLE_ENTITY,
                )
                .await;
            }
            caller.activate_channel(id, &locations).await
        }
        _ => {
            let words = t.connections_action_unknown().to_owned();
            return render_connection(
                &req,
                &viewer,
                &config,
                &headers,
                id,
                &here,
                None,
                Some(words),
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        }
    };
    match outcome {
        Ok((connection, Some(receipt))) => req.redirect(&connection_url(&connection.connection_id, Some(&receipt))),
        // Disconnect sends no receipt to read after (chase-sets/chase-sets#10779): the page is the
        // connection the write returned, as marketplace's action draws it.
        Ok((connection, None)) => {
            render_connection(&req, &viewer, &config, &headers, id, &here, Some(connection), None, StatusCode::OK).await
        }
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(status @ (StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) => Err(corten::Error::new(error).with_status(status)),
            status => {
                tracing::warn!("a channel connection's write was refused: {error}");
                let words = t.connections_action_failed().to_owned();
                render_connection(&req, &viewer, &config, &headers, id, &here, None, Some(words), refusal_status(status)).await
            }
        },
    }
}

/// The publication list: each connection's settings and mappings to review.
pub(crate) async fn publications(
    req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let connections: Vec<ChannelPublicationSummary> = match caller.channel_publications().await {
        Ok(connections) => connections,
        Err(error) => return read_failed(&req, Some(&viewer), error, None),
    };
    let p: Pilot = req.t();
    let (r, viewer, connections) = (&req, &viewer, &connections);
    let page = html! {
        <Layout req={r} viewer={Some(viewer)} title={t.publication_meta_title()} head={noindex()}>
            <views::ChannelPublicationsPage t={t} p={p} connections={connections} />
        </Layout>
    };
    req.page(page)
}
