//! The channel screens (Channels' marketplace routes): the account's connections
//! (`account-channels`, `/account/channels`) with the status filter, the next page and
//! Connect a channel; a connection (`account-channels-connection`, `/account/channels/{id}`) with its
//! status, Pause, Resume and Disconnect, Activate on storage locations while it is pending
//! setup, and its manual TCGplayer sync; the publication list (`account-channels-publication`, `/account/channels/publication`);
//! and a connection's publication (`channels-publication-connection`,
//! `/account/channels/publication/{id}`): its settings, the listings recorded as blocked, and the
//! mappings to review with Accept, Reject and Revoke.
//!
//! Reading needs `channels.view` and writing `channels.manage` (`ChannelsMember`). Which providers a
//! seller may connect and which actions a connection allows are copied here from marketplace's
//! web layer until the Channels API returns them
//! ([chase-sets/chase-sets#10778](https://github.com/chase-sets/chase-sets/issues/10778)):
//! `PROVIDERS` and `actions`. A write goes to the connection with its receipt; a refusal is the page
//! with Channels' words for it (422), a failure the same with a 502. A connection's drift, health,
//! pairing and operation log are on marketplace for now.
//!
//! The manual sync panel is Channels' (`ManualSyncPanel`): which actions the run allows is its
//! answer. Its writes post to `{id}/manual-sync` (an export's ingest, a file, to
//! `{id}/manual-sync/ingest`) and go back to the connection, or draw it with what was refused; an
//! ingest draws it with Channels' receipt. Clamp and download posts to `{id}/manual-sync/download`
//! and answers Channels' CSV. A handler that answers a file cannot answer a page
//! ([todd-skelton/corten#415](https://github.com/todd-skelton/corten/issues/415)), so a refused
//! download is relayed as a redirect to the connection with `?manual=failed` (marketplace shows
//! Channels' JSON instead, [chase-sets/chase-sets#10812](https://github.com/chase-sets/chase-sets/issues/10812)).
//!
//! A publication write is made at the configuration version the page was drawn with and answers
//! the version it made, not a receipt: the page goes to its address with that version and reads
//! itself again every two seconds (`ReadAgain`) while Channels' read is behind it, its forms
//! waiting, for at most 30 seconds, then says it is still catching up with Refresh. A write made at
//! a version that is no longer current is Channels' 409, which the page answers with "Settings
//! changed" (marketplace's page means to, but shows the 409's status instead).
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use corten::{
    Relay,
    axum::{
        body::Body,
        http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    },
    prelude::*,
};
use platform::receipt::Receipt;
use serde::Deserialize;

use crate::chrome::Chrome;
use crate::{
    api::{
        ApiError, ChannelCalls as _, ChannelConnection, ChannelConnectionPage, ChannelPublication, ChannelPublicationSummary,
        ImportSummary, IngestReceipt, Inventory as _, ManualSyncCalls as _, ManualSyncPanel, MappingDecision,
        PublicationSettings, RunAt,
    },
    app::{CHANNELS_MANAGE, Shared, read_failed, sign_in, url},
    auth::{ChannelsMember, Viewer},
    items::Raw,
    listing_new::first,
    text::{ChannelsMsg, Pilot},
    uploads::{self, Limits},
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
    /// `failed`: a manual sync download Channels refused.
    pub manual: Option<String>,
}

/// A manual sync write: its intent, the run and revision it was made at, and Upload attempt's
/// and Verify's fields, in marketplace's names.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ManualSyncForm {
    pub intent: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "verificationSnapshotId")]
    pub verification_snapshot_id: String,
    #[serde(rename = "dateImportedText")]
    pub date_imported_text: String,
    #[serde(rename = "numberOfProducts")]
    pub number_of_products: String,
}

impl ManualSyncForm {
    /// The run the write was made at, when the form names one.
    fn run(&self) -> Option<RunAt<'_>> {
        let run_id = self.run_id.trim();
        let revision = self.expected_revision.trim().parse().ok()?;
        (!run_id.is_empty()).then_some(RunAt { run_id, revision })
    }
}

/// An export's ingest form: its surface (`live` or `staged`) and the file (`export`).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct IngestForm {
    pub surface: String,
    pub export: String,
}

/// An export's bytes: Channels' ceiling for one (`manualSyncIngestContract.maxBytes`, 32 MiB) and
/// its multipart body (`multipartMaxBytes`, 34 MiB). Channels refuses a Live export over 16 MiB
/// itself.
const INGEST_LIMITS: Limits = Limits { file: 32 << 20, files: 1, whole: 34 << 20 };

/// What a manual sync write said, on the connection's page.
#[derive(Default)]
pub enum ManualSaid {
    #[default]
    Nothing,
    /// Channels refused or failed it.
    Failed,
    /// Not an action the panel offers.
    Invalid,
    /// Compose needs a Staged export newer than the last verified run.
    StagedBasis,
    /// An export's ingest, with Channels' receipt.
    Ingested(Box<IngestReceipt>),
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
    /// The manual sync panel; `None` when its read failed.
    pub manual: Option<ManualSyncPanel>,
    pub said: ManualSaid,
}

fn noindex() -> impl Render {
    html! { <meta name="robots" content="noindex"> }
}

#[allow(clippy::too_many_arguments)]
async fn render_list(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    place: ListPlace,
    connect_error: Option<String>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let (page, status) = match caller.channel_connections(place.status(), place.cursor()).await {
        Ok(page) => (Some(page), status),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) if error.status() == Some(StatusCode::FORBIDDEN) => {
            return read_failed(req, Some(viewer), error, None, chrome.cart().await);
        }
        Err(error) => {
            tracing::warn!("the channel connections' read failed: {error}");
            (None, StatusCode::BAD_GATEWAY)
        }
    };
    let screen = ChannelsScreen { page, place, providers: providers(viewer), connect_error };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.connections_meta_title()} head={noindex()}>
            <views::ChannelsPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// The connections, of the status and page the address names.
pub(crate) async fn list(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::Channels>,
) -> HtmlResult {
    render_list(&req, &viewer, &config, &headers, route.place, None, StatusCode::OK, &chrome).await
}

/// Connect a channel: the new connection's page with the write's receipt, or the list with what
/// was refused.
pub(crate) async fn connect(
    req: Req,
    chrome: Chrome,
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
            &chrome,
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
    url::ChannelConnection { id, place: ConnectionPlace { after_write: receipt.map(Receipt::param), manual: None } }
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
    chrome: &Chrome,
) -> HtmlResult {
    let said = if place.manual.as_deref() == Some("failed") { ManualSaid::Failed } else { ManualSaid::Nothing };
    render_connection_with(req, viewer, config, headers, id, place, written, error, said, status, chrome).await
}

#[allow(clippy::too_many_arguments)]
async fn render_connection_with(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: &ConnectionPlace,
    written: Option<ChannelConnection>,
    error: Option<String>,
    said: ManualSaid,
    status: StatusCode,
    chrome: &Chrome,
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
            let cart = chrome.cart().await;
            return req.page(html! {
                <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.connections_connection_meta_title()} head={head}>
                    <views::ChannelsPending t={t} p={p} words={p.channels_pending()} refresh={&here} />
                </Layout>
            });
        }
        Err(read) if read.status() == Some(StatusCode::NOT_FOUND) => return Err(corten::Error::status(StatusCode::NOT_FOUND)),
        Err(read) => return read_failed(req, Some(viewer), read, None, chrome.cart().await),
    };
    let manage = viewer.actor.can(CHANNELS_MANAGE);
    let caller = config.platform.caller(headers, config.proto, None);
    let (manual, locations) = tokio::join!(caller.manual_sync(id), async {
        if !(manage && connection.status == "pending-setup") {
            return Some(Vec::new());
        }
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
    });
    let manual = manual.map_err(|read| tracing::warn!("a connection's manual sync read failed: {read}")).ok();
    let screen = ConnectionScreen { connection, manage, locations, error, manual, said };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.connections_connection_meta_title()} head={noindex()}>
            <views::ChannelConnectionPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// A connection, read after the write whose receipt the address carries.
pub(crate) async fn connection(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelConnection<'_>>,
) -> HtmlResult {
    render_connection(&req, &viewer, &config, &headers, &route.id, &route.place, None, None, StatusCode::OK, &chrome).await
}

/// Pause, Resume, Disconnect and Activate: the connection with the write's receipt, or the page
/// with what was refused.
pub(crate) async fn command(
    req: Req,
    chrome: Chrome,
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
                    &chrome,
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
                &chrome,
            )
            .await;
        }
    };
    match outcome {
        Ok((connection, Some(receipt))) => req.redirect(&connection_url(&connection.connection_id, Some(&receipt))),
        // Disconnect sends no receipt to read after (chase-sets/chase-sets#10779): the page is the
        // connection the write returned, as marketplace's action draws it.
        Ok((connection, None)) => {
            render_connection(&req, &viewer, &config, &headers, id, &here, Some(connection), None, StatusCode::OK, &chrome).await
        }
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(status @ (StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) => Err(corten::Error::new(error).with_status(status)),
            status => {
                tracing::warn!("a channel connection's write was refused: {error}");
                let words = t.connections_action_failed().to_owned();
                render_connection(&req, &viewer, &config, &headers, id, &here, None, Some(words), refusal_status(status), &chrome)
                    .await
            }
        },
    }
}

/// The connection's page with what a manual sync write said, at `status`.
#[allow(clippy::too_many_arguments)]
async fn manual_page(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    said: ManualSaid,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    render_connection_with(req, viewer, config, headers, id, &ConnectionPlace::default(), None, None, said, status, chrome).await
}

/// A manual sync write Channels refused: signed out goes to sign in, a forbidden or missing
/// connection is its status, Compose without a newer Staged export says to ingest one, and the
/// rest is the page saying the action failed (422, or 502 when Channels failed).
async fn manual_refused(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    error: ApiError,
    chrome: &Chrome,
) -> HtmlResult {
    match error.status() {
        Some(StatusCode::UNAUTHORIZED) => sign_in(req),
        Some(status @ (StatusCode::FORBIDDEN | StatusCode::NOT_FOUND)) => Err(corten::Error::new(error).with_status(status)),
        status => {
            tracing::warn!("a manual sync write was refused: {error}");
            let said = match error.code() {
                Some("staged-basis-stale" | "staged-basis-unavailable") => ManualSaid::StagedBasis,
                _ => ManualSaid::Failed,
            };
            manual_page(req, viewer, config, headers, id, said, refusal_status(status), chrome).await
        }
    }
}

/// Compose, Retry inbound clamp, Release, Record validation cancellation, Record upload attempt
/// and Verify: the connection again, or the page with what was refused.
pub(crate) async fn manual_sync(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelManualSync<'_>>,
    Form(form): Form<ManualSyncForm>,
) -> HtmlResult {
    if !viewer.actor.can(CHANNELS_MANAGE) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let id: &str = &route.id;
    let caller = config.platform.caller(&headers, config.proto, None);
    let outcome = match (form.intent.as_str(), form.run()) {
        ("compose", _) => caller.compose_manual_sync(id).await,
        (step @ ("retry-clamp" | "release" | "validation-cancelled"), Some(run)) => caller.manual_sync_step(id, run, step).await,
        ("upload-attempt", Some(run)) => caller.record_upload_attempt(id, run, form.file_name.trim()).await,
        ("verify", Some(run)) => {
            let Ok(number_of_products) = form.number_of_products.trim().parse() else {
                return manual_page(
                    &req,
                    &viewer,
                    &config,
                    &headers,
                    id,
                    ManualSaid::Failed,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    &chrome,
                )
                .await;
            };
            let summary = ImportSummary {
                file_name: form.file_name.trim(),
                date_imported_text: form.date_imported_text.trim(),
                number_of_products,
            };
            caller.verify_manual_sync(id, run, form.verification_snapshot_id.trim(), &summary).await
        }
        _ => {
            return manual_page(
                &req,
                &viewer,
                &config,
                &headers,
                id,
                ManualSaid::Invalid,
                StatusCode::UNPROCESSABLE_ENTITY,
                &chrome,
            )
            .await;
        }
    };
    match outcome {
        Ok(()) => req.redirect(&connection_url(id, None)),
        Err(error) => manual_refused(&req, &viewer, &config, &headers, id, error, &chrome).await,
    }
}

/// Ingest a Live or Staged export: the connection with Channels' receipt, or the page with what
/// was refused. A file over the ceiling is not sent (413).
pub(crate) async fn manual_sync_ingest(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelManualSyncIngest<'_>>,
    upload: corten::Upload<Raw>,
) -> HtmlResult {
    if !viewer.actor.can(CHANNELS_MANAGE) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let id: &str = &route.id;
    let f = IngestForm::FIELDS;
    let posted = match uploads::read(upload, INGEST_LIMITS).await {
        Ok(posted) => posted,
        Err(corten::UploadError::TooLarge { .. }) => {
            return manual_page(&req, &viewer, &config, &headers, id, ManualSaid::Failed, StatusCode::PAYLOAD_TOO_LARGE, &chrome)
                .await;
        }
        Err(other) => return Err(other.into()),
    };
    let surface = first(&posted.fields, f.surface.as_str());
    let file = posted.files.into_iter().find(|file| file.field == f.export.as_str() && !file.bytes.is_empty());
    let (Some(file), None) = (file, posted.over) else {
        return manual_page(&req, &viewer, &config, &headers, id, ManualSaid::Failed, StatusCode::UNPROCESSABLE_ENTITY, &chrome)
            .await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    match caller.ingest_export(id, &surface, &file.filename, file.bytes).await {
        Ok(receipt) => {
            manual_page(&req, &viewer, &config, &headers, id, ManualSaid::Ingested(Box::new(receipt)), StatusCode::OK, &chrome)
                .await
        }
        Err(error) => manual_refused(&req, &viewer, &config, &headers, id, error, &chrome).await,
    }
}

/// Clamp and download CSV: Channels claims the composed run and sends its Staged batch, passed on
/// with its type, file name and the run's new revision. A refused download goes back to the
/// connection with `?manual=failed`: a handler that answers a file cannot answer a page
/// (todd-skelton/corten#415).
pub(crate) async fn manual_sync_download(
    _req: Req,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelManualSyncDownload<'_>>,
    Form(form): Form<ManualSyncForm>,
) -> corten::Result<Relay> {
    if !viewer.actor.can(CHANNELS_MANAGE) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let id: &str = &route.id;
    let refused = || {
        let place = ConnectionPlace { after_write: None, manual: Some("failed".to_owned()) };
        let to = url::ChannelConnection { id, place }.href();
        let mut kept = HeaderMap::new();
        kept.insert(header::LOCATION, HeaderValue::from_str(&to).map_err(corten::Error::new)?);
        Ok(Relay::new(StatusCode::SEE_OTHER, kept, Body::empty()))
    };
    let Some(run) = form.run() else { return refused() };
    let caller = config.platform.caller(&headers, config.proto, None);
    let res = match caller.download_manual_sync(id, run).await {
        Ok(res) => res,
        Err(error) if matches!(error.status(), Some(StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED)) => {
            return Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN));
        }
        Err(error) => {
            tracing::warn!("a manual sync download was refused: {error}");
            return refused();
        }
    };
    let mut kept = HeaderMap::new();
    for name in ["content-type", "content-disposition", "x-channel-sync-run-revision"] {
        if let Some(value) = res.headers().get(name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
            kept.insert(HeaderName::from_static(name), value);
        }
    }
    let bytes = res.bytes().await.map_err(|error| corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))?;
    Ok(Relay::new(StatusCode::OK, kept, Body::from(bytes)))
}

/// The publication list: each connection's settings and mappings to review.
pub(crate) async fn publications(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(&headers, config.proto, None);
    let connections: Vec<ChannelPublicationSummary> = match caller.channel_publications().await {
        Ok(connections) => connections,
        Err(error) => return read_failed(&req, Some(&viewer), error, None, chrome.cart().await),
    };
    let p: Pilot = req.t();
    let (r, viewer, connections) = (&req, &viewer, &connections);
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={r} viewer={Some(viewer)} cart={cart} title={t.publication_meta_title()} head={noindex()}>
            <views::ChannelPublicationsPage t={t} p={p} connections={connections} />
        </Layout>
    };
    req.page(page)
}

/// How long a connection's publication waits for the configuration version a write was made at,
/// reading itself again every two seconds: marketplace's page reads fifteen times, two seconds apart.
const PUBLICATION_WAIT: Duration = Duration::from_secs(30);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A connection's publication address: the mappings' cursor and, after a write, the configuration
/// version it was made at and when the page stops waiting for it (Unix seconds).
#[derive(Clone, Debug, Default, Deserialize, Route)]
#[route(query)]
pub struct PublicationPlace {
    pub cursor: Option<String>,
    pub version: Option<u64>,
    pub until: Option<u64>,
}

impl PublicationPlace {
    fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref().map(str::trim).filter(|cursor| !cursor.is_empty())
    }

    /// The same mappings' page, without a version to wait for.
    pub fn here(&self) -> PublicationPlace {
        PublicationPlace { cursor: self.cursor().map(str::to_owned), version: None, until: None }
    }

    /// The mappings' page after `cursor`.
    pub fn next(cursor: &str) -> PublicationPlace {
        PublicationPlace { cursor: Some(cursor.to_owned()), version: None, until: None }
    }

    /// The same page, waiting for `version` from now.
    fn waiting(&self, version: u64) -> PublicationPlace {
        PublicationPlace {
            cursor: self.cursor().map(str::to_owned),
            version: Some(version),
            until: Some(now_secs() + PUBLICATION_WAIT.as_secs()),
        }
    }
}

/// A publication write, in marketplace's names: `replace-settings` with the settings, or
/// `decide-mapping` with the mapping and its decision; each made at `expectedStreamVersion`.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct PublicationForm {
    pub intent: String,
    pub expected_stream_version: String,
    pub title_prefix: String,
    pub title_suffix: String,
    pub description_footer: String,
    pub publish_quantity_cap: String,
    pub low_stock_withhold_units: String,
    pub category_allowlist: String,
    pub excluded_listing_ids: String,
    pub dimension: String,
    pub source_key: String,
    pub target_key: String,
    pub decision: String,
}

/// A text area's lines, trimmed, without empty ones or repeats, in order
/// (`parseChannelPublicationSettingsForm`'s `lines`).
fn lines(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !out.iter().any(|seen| seen == line) {
            out.push(line.to_owned());
        }
    }
    out
}

/// An optional whole number: empty is none; anything else that is not one is `Err`. Channels
/// decides the range.
fn whole(text: &str) -> Result<Option<i64>, ()> {
    match text.trim() {
        "" => Ok(None),
        text => text.parse().map(Some).map_err(|_| ()),
    }
}

impl PublicationForm {
    /// The settings the form sends, or `Err` when a number is not a whole number.
    pub fn settings(&self) -> Result<PublicationSettings, ()> {
        Ok(PublicationSettings {
            title_prefix: self.title_prefix.clone(),
            title_suffix: self.title_suffix.clone(),
            description_footer: self.description_footer.clone(),
            category_allowlist: lines(&self.category_allowlist),
            excluded_listing_ids: lines(&self.excluded_listing_ids),
            publish_quantity_cap: whole(&self.publish_quantity_cap)?,
            low_stock_withhold_units: whole(&self.low_stock_withhold_units)?,
        })
    }
}

/// What the page says above the publication.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PublicationSaid {
    #[default]
    Nothing,
    /// The read is behind the write the address waits for: the forms wait too.
    Pending,
    /// It still is when the wait ended: Refresh.
    Exhausted,
    /// A write was made at a version that is no longer current.
    Conflict,
    /// A write was refused, in these words.
    Refused(String),
}

/// What a connection's publication page shows.
pub struct PublicationScreen {
    pub id: String,
    /// `None`: no connection by this id for the account.
    pub detail: Option<ChannelPublication>,
    pub place: PublicationPlace,
    /// The seller may write (`channels.manage`).
    pub manage: bool,
    pub said: PublicationSaid,
    /// The settings form as it was sent, drawn again after a refusal.
    pub sent: Option<PublicationForm>,
}

impl PublicationScreen {
    /// Whether the forms wait: a reader's, or while the read is behind the write.
    pub fn disabled(&self) -> bool {
        !self.manage || self.said == PublicationSaid::Pending
    }
}

fn publication_url<'a>(id: &'a str, place: PublicationPlace) -> url::ChannelPublication<'a> {
    url::ChannelPublication { id, place }
}

#[allow(clippy::too_many_arguments)]
async fn render_publication(
    req: &Req,
    viewer: &Viewer,
    config: &Shared,
    headers: &HeaderMap,
    id: &str,
    place: PublicationPlace,
    said: PublicationSaid,
    sent: Option<PublicationForm>,
    status: StatusCode,
    chrome: &Chrome,
) -> HtmlResult {
    let t: ChannelsMsg = req.t();
    let caller = config.platform.caller(headers, config.proto, None);
    let (detail, status) = match caller.channel_publication(id, place.cursor()).await {
        Ok(detail) => (Some(detail), status),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return sign_in(req),
        Err(error) if error.status() == Some(StatusCode::NOT_FOUND) => (None, StatusCode::NOT_FOUND),
        Err(error) => return read_failed(req, Some(viewer), error, None, chrome.cart().await),
    };
    let behind = matches!((&detail, place.version), (Some(d), Some(v)) if d.configuration_stream_version < v);
    let said = match said {
        PublicationSaid::Nothing if behind && place.until.is_some_and(|until| now_secs() < until) => PublicationSaid::Pending,
        PublicationSaid::Nothing if behind => PublicationSaid::Exhausted,
        said => said,
    };
    let pending = said == PublicationSaid::Pending;
    let screen = PublicationScreen { id: id.to_owned(), detail, place, manage: viewer.actor.can(CHANNELS_MANAGE), said, sent };
    let head = html! {
        <meta name="robots" content="noindex">
        {pending.then_some(ReadAgain { after: Duration::from_secs(2) })}
    };
    let cart = chrome.cart().await;
    let page = html! {
        <Layout req={req} viewer={Some(viewer)} cart={cart} title={t.publication_connection_meta_title()} head={head}>
            <views::ChannelPublicationPage t={t} p={req.t()} screen={&screen} />
        </Layout>
    };
    if status == StatusCode::OK { req.page(page) } else { req.page_with_status(status, page) }
}

/// A connection's publication, its mappings from the address's cursor; after a write, read again
/// until it shows the configuration version the write was made at.
pub(crate) async fn publication(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelPublication<'_>>,
) -> HtmlResult {
    render_publication(
        &req,
        &viewer,
        &config,
        &headers,
        &route.id,
        route.place,
        PublicationSaid::Nothing,
        None,
        StatusCode::OK,
        &chrome,
    )
    .await
}

/// Save publication settings or decide a mapping, at the version the page was drawn with: the page
/// waiting for the version the write made; or the page with what was refused (422), with the
/// settings as sent; a version that is no longer current is a 409 that says to reload.
pub(crate) async fn publication_write(
    req: Req,
    chrome: Chrome,
    Caller(ChannelsMember(viewer)): Caller<ChannelsMember>,
    State(config): State<Shared>,
    headers: HeaderMap,
    Params(route): Params<url::channels::ChannelPublication<'_>>,
    Form(form): Form<PublicationForm>,
) -> HtmlResult {
    if !viewer.actor.can(CHANNELS_MANAGE) {
        return Err(corten::Error::status(StatusCode::FORBIDDEN));
    }
    let t: ChannelsMsg = req.t();
    let id: &str = &route.id;
    let place = route.place.here();
    let sent = (form.intent == "replace-settings").then(|| form.clone());
    let refused = |said: PublicationSaid, status: StatusCode| {
        render_publication(&req, &viewer, &config, &headers, id, place.clone(), said, sent.clone(), status, &chrome)
    };
    let Ok(expected) = form.expected_stream_version.trim().parse::<u64>() else {
        return refused(PublicationSaid::Refused(t.publication_action_failed().to_owned()), StatusCode::UNPROCESSABLE_ENTITY)
            .await;
    };
    let caller = config.platform.caller(&headers, config.proto, None);
    let answer = match form.intent.as_str() {
        "replace-settings" => match form.settings() {
            Ok(settings) => caller.replace_publication_settings(id, &settings, expected).await,
            Err(()) => {
                let p: Pilot = req.t();
                let words = p.channels_whole_number().to_owned();
                return refused(PublicationSaid::Refused(words), StatusCode::UNPROCESSABLE_ENTITY).await;
            }
        },
        "decide-mapping" => {
            let target = form.target_key.trim();
            let decision = MappingDecision {
                dimension: form.dimension.trim(),
                source_key: &form.source_key,
                decision: form.decision.trim(),
                target_key: (!target.is_empty()).then_some(target),
            };
            caller.decide_channel_mapping(id, &decision, expected).await
        }
        _ => {
            let words = t.publication_action_unknown().to_owned();
            return refused(PublicationSaid::Refused(words), StatusCode::UNPROCESSABLE_ENTITY).await;
        }
    };
    match answer {
        Ok(answer) => match (answer.kind.as_str(), answer.stream_version) {
            ("applied" | "unchanged", Some(version)) => req.redirect(&publication_url(id, place.waiting(version))),
            ("applied" | "unchanged", None) => req.redirect(&publication_url(id, place)),
            // Channels' code is its words for a refusal, as marketplace's page shows it.
            _ => {
                let words = answer.code.unwrap_or_else(|| t.publication_action_failed().to_owned());
                refused(PublicationSaid::Refused(words), StatusCode::UNPROCESSABLE_ENTITY).await
            }
        },
        Err(error) => match error.status() {
            Some(StatusCode::UNAUTHORIZED) => sign_in(&req),
            Some(StatusCode::FORBIDDEN) => Err(corten::Error::new(error).with_status(StatusCode::FORBIDDEN)),
            Some(StatusCode::CONFLICT) => refused(PublicationSaid::Conflict, StatusCode::CONFLICT).await,
            status => {
                tracing::warn!("a channel publication write was refused: {error}");
                let words = error.refusal().unwrap_or(t.publication_action_failed()).to_owned();
                refused(PublicationSaid::Refused(words), refusal_status(status)).await
            }
        },
    }
}
