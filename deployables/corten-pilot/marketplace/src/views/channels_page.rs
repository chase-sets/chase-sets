//! The channel screens (Channels' `ChannelConnectionListPage`, `ChannelConnectionDetailPage`,
//! `ChannelPublicationListPage` and `ChannelPublicationDetailPage`): the connections with the
//! status filter as links, the next page and Connect a channel; a connection's status with its
//! actions and the setup's storage locations; each connection's publication summary; and a
//! connection's publication settings, blocked listings and mappings to review; and a connection's
//! manual TCGplayer sync (`ManualSyncPanelView`). Every action is a form or a link. The cards are
//! one column on a phone and two from 48rem; a mapping's target and its decisions wrap under its
//! name on a phone, and the manual sync's facts wrap to as many columns as fit.
use corten::prelude::*;
use platform::api::segment;

use crate::{
    api::{
        ChannelConnection, ChannelPublication, ChannelPublicationSummary, IngestReceipt, ManualSyncPanel, MappingCandidate,
        SyncRun,
    },
    app::url,
    channels::{
        ChannelsScreen, ConnectForm, ConnectionForm, ConnectionScreen, IngestForm, ListPlace, ManualSaid, ManualSyncForm,
        PublicationForm, PublicationPlace, PublicationSaid, PublicationScreen, STATUSES, actions,
    },
    text::{ChannelsMsg, Pilot},
    views::on_marketplace,
};

/// A status's words (`statusLabelKeys`).
fn status_word(t: ChannelsMsg, status: &str) -> &str {
    match status {
        "pending-setup" => t.connections_status_pending_setup(),
        "active" => t.connections_status_active(),
        "paused" => t.connections_status_paused(),
        "disconnected" => t.connections_status_disconnected(),
        other => other,
    }
}

/// A status filter's words (`listFilters`); `None` is every connection not disconnected.
fn filter_word(t: ChannelsMsg, status: Option<&str>) -> &str {
    match status {
        None => t.connections_filter_default(),
        Some("pending-setup") => t.connections_filter_pending_setup(),
        Some("active") => t.connections_filter_active(),
        Some("paused") => t.connections_filter_paused(),
        Some("disconnected") => t.connections_filter_disconnected(),
        Some(other) => other,
    }
}

/// A status's badge tone (`statusTones`).
fn tone(status: &str) -> &'static str {
    match status {
        "active" => "success",
        "pending-setup" | "paused" => "warning",
        _ => "neutral",
    }
}

fn action_word(t: ChannelsMsg, action: &str) -> &str {
    match action {
        "pause" => t.connections_actions_pause(),
        "resume" => t.connections_actions_resume(),
        "disconnect" => t.connections_actions_disconnect(),
        other => other,
    }
}

/// A connection's publication page.
fn publication_href(id: &str) -> String {
    url::ChannelPublication { id, place: PublicationPlace::default() }.href()
}

/// The connections' page.
#[component(css)]
pub fn ChannelsPage<'a>(t: ChannelsMsg, p: Pilot, screen: &'a ChannelsScreen) -> impl Render {
    let current = screen.place.status();
    let statuses = std::iter::once(None).chain(STATUSES.into_iter().map(Some));
    let f = ConnectForm::FIELDS;
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.connections_eyebrow()}</p>
                <h1 class={Title}>{t.connections_title()}</h1>
                <p class={Muted}>{t.connections_description()}</p>
                <nav class={Row} aria-label={p.channels_pages()}>
                    <a class={(Button, Secondary)} href={url::ChannelPublications}>{t.publication_title()}</a>
                </nav>
            </header>
            if !screen.providers.is_empty() {
                <section class={Section} aria-labelledby="channels-connect">
                    <h2 id="channels-connect" class={PartTitle}>{t.connections_connect()}</h2>
                    <form class={Form} method="post" action={url::Channels::default()}>
                        <label class={Field}>
                            <span class={Strong}>{t.connections_provider()}</span>
                            <select class={Control} name={f.provider_key} required>
                                for provider in &screen.providers {
                                    <option value={*provider}>{*provider}</option>
                                }
                            </select>
                        </label>
                        if let Some(error) = &screen.connect_error {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.connections_error_title()}</p>
                                <p>{error}</p>
                            </div>
                        }
                        <p class={Row}><button type="submit" class={Button}>{t.connections_connect()}</button></p>
                    </form>
                </section>
            }
            <section class={Section} aria-labelledby="channels-connections">
                <h2 id="channels-connections" class={PartTitle}>{t.connections_section_title()}</h2>
                <nav class={Filter} aria-label={p.channels_filter()}>
                    for status in statuses {
                        <a
                            class={Choice}
                            href={url::Channels { place: ListPlace::of(status) }}
                            aria-current={if status == current { Some("page") } else { None }}
                        >
                            {filter_word(t, status)}
                        </a>
                    }
                </nav>
                match &screen.page {
                    None => {
                        <div class={Banner} data-tone="danger" role="alert">
                            <p class={Strong}>{t.connections_error_title()}</p>
                            <p>{t.connections_action_failed()}</p>
                        </div>
                    }
                    Some(page) if page.items.is_empty() => {
                        <div class={Banner} role="status">
                            <p class={Strong}>{t.connections_empty_title()}</p>
                            <p>{t.connections_empty_description()}</p>
                        </div>
                    }
                    Some(page) => {
                        <ul class={Cards} role="list">
                            for connection in &page.items {
                                <ConnectionCard t={t} connection={connection} />
                            }
                        </ul>
                        if let Some(cursor) = page.next_cursor.as_deref().filter(|c| !c.is_empty()) {
                            <p class={Row}>
                                <a class={(Button, Secondary)} href={url::Channels { place: screen.place.next(cursor) }}>
                                    {t.connections_next()}
                                </a>
                            </p>
                        }
                    }
                }
            </section>
        </div>
    }
}

#[component(css = ChannelsPage)]
fn ConnectionCard<'a>(t: ChannelsMsg, connection: &'a ChannelConnection) -> impl Render {
    html! {
        <li class={Card}>
            <p class={Strong}>{&connection.provider_key}</p>
            <Badges t={t} connection={connection} />
            <p class={Row}>
                <a
                    class={(Button, Secondary)}
                    href={url::ChannelConnection { id: &connection.connection_id, place: Default::default() }}
                >
                    {t.connections_open()}
                </a>
            </p>
        </li>
    }
}

#[component(css = ChannelsPage)]
fn Badges<'a>(t: ChannelsMsg, connection: &'a ChannelConnection) -> impl Render {
    html! {
        <p class={Badges}>
            <span class={Badge} data-tone={tone(&connection.status)}>{status_word(t, &connection.status)}</span>
            <span class={Badge}>{&connection.environment}</span>
        </p>
    }
}

/// A connection's page.
#[component(css = ChannelsPage)]
pub fn ChannelConnectionPage<'a>(t: ChannelsMsg, p: Pilot, screen: &'a ConnectionScreen) -> impl Render {
    let connection = &screen.connection;
    let here = url::ChannelConnection { id: &connection.connection_id, place: Default::default() }.href();
    let allowed = if screen.manage { actions(&connection.status) } else { &[] };
    let f = ConnectionForm::FIELDS;
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.connections_eyebrow()}</p>
                <h1 class={Title}>{&connection.provider_key}</h1>
                <p class={Muted}>{t.connections_connection_description()}</p>
                <nav class={Row} aria-label={p.channels_pages()}>
                    <a class={(Button, Ghost)} href={publication_href(&connection.connection_id)}>
                        {t.publication_manage()}
                    </a>
                    <a class={(Button, Secondary)} href={url::Channels::default()}>{t.connections_back()}</a>
                </nav>
            </header>
            if let Some(error) = &screen.error {
                <div class={Banner} data-tone="danger" role="alert">
                    <p class={Strong}>{t.connections_error_title()}</p>
                    <p>{error}</p>
                </div>
            }
            <section class={Section} aria-labelledby="channel-status">
                <h2 id="channel-status" class={PartTitle}>{t.connections_status_title()}</h2>
                <div class={Card}>
                    <Badges t={t} connection={connection} />
                    if allowed.is_empty() {
                        <p class={Muted}>{t.connections_actions_none()}</p>
                    } else {
                        <div class={Row}>
                            for action in allowed {
                                <form class={Inline} method="post" action={&here}>
                                    <button
                                        type="submit"
                                        class={if *action == "disconnect" { (Button, Danger) } else { (Button, Secondary) }}
                                        name={f.intent}
                                        value={*action}
                                    >
                                        {action_word(t, action)}
                                    </button>
                                </form>
                            }
                        </div>
                    }
                </div>
            </section>
            if screen.manage && connection.status == "pending-setup" {
                <section class={Section} aria-labelledby="channel-setup">
                    <h2 id="channel-setup" class={PartTitle}>{t.connections_setup()}</h2>
                    match &screen.locations {
                        None => {
                            <div class={Banner} data-tone="danger" role="alert">
                                <p class={Strong}>{t.connections_error_title()}</p>
                                <p>{t.connections_action_failed()}</p>
                            </div>
                        }
                        Some(locations) if locations.is_empty() => {
                            <p class={Row}><a class={Button} href={url::Locations::default()}>{t.connections_locations()}</a></p>
                        }
                        Some(locations) => {
                            <form class={Form} method="post" action={&here}>
                                <input type="hidden" name={f.intent} value="activate">
                                <fieldset class={Choices}>
                                    <legend class={Strong}>{t.connections_locations()}</legend>
                                    for location in locations {
                                        <label class={Check}>
                                            <input type="checkbox" name={f.storage_location_ids} value={&location.id}>
                                            <span>{&location.name}</span>
                                        </label>
                                    }
                                </fieldset>
                                <p class={Row}><button type="submit" class={Button}>{t.connections_activate()}</button></p>
                            </form>
                        }
                    }
                </section>
            }
            match &screen.manual {
                Some(panel) => {
                    <ManualSync t={t} id={&connection.connection_id} panel={panel} said={&screen.said} manage={screen.manage} />
                }
                None => {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.manual_sync_error_title()}</p>
                        <p>{t.manual_sync_error_description()}</p>
                    </div>
                }
            }
            <section class={Section}>
                <p class={Muted}>{p.channels_more_on_marketplace()}</p>
                <p class={Row}>
                    <a
                        class={(Button, Secondary)}
                        href={on_marketplace(&format!("/account/channels/{}", segment(&connection.connection_id)))}
                    >
                        {p.channels_open_on_marketplace()}
                    </a>
                </p>
            </section>
        </div>
    }
}

/// A write the connection's read has not reached yet: it reads itself again.
#[component(css = ChannelsPage)]
pub fn ChannelsPending<'a>(t: ChannelsMsg, p: Pilot, words: &'a str, refresh: &'a str) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.connections_eyebrow()}</p>
                <h1 class={Title}>{t.connections_connection_title()}</h1>
            </header>
            <div class={Banner} role="status">
                <p>{words}</p>
            </div>
            <p class={Row}><a class={(Button, Secondary)} href={refresh}>{p.channels_refresh()}</a></p>
        </div>
    }
}

/// The publication list.
#[component(css = ChannelsPage)]
pub fn ChannelPublicationsPage<'a>(t: ChannelsMsg, p: Pilot, connections: &'a [ChannelPublicationSummary]) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.publication_eyebrow()}</p>
                <h1 class={Title}>{t.publication_title()}</h1>
                <p class={Muted}>{t.publication_description()}</p>
                <nav class={Row} aria-label={p.channels_pages()}>
                    <a class={(Button, Secondary)} href={url::Channels::default()}>{p.channels_connections()}</a>
                </nav>
            </header>
            <section class={Section} aria-labelledby="publication-connections">
                <h2 id="publication-connections" class={PartTitle}>{t.publication_connections()}</h2>
                if connections.is_empty() {
                    <div class={Banner} role="status">
                        <p class={Strong}>{t.publication_empty_title()}</p>
                        <p>{t.publication_empty_description()}</p>
                    </div>
                } else {
                    <ul class={Cards} role="list">
                        for connection in connections {
                            <li class={Card}>
                                <p class={Strong}>{&connection.provider_key}</p>
                                <p class={Badges}>
                                    <span
                                        class={Badge}
                                        data-tone={if connection.connection_status == "active" { "success" } else { "warning" }}
                                    >
                                        {status_word(t, &connection.connection_status)}
                                    </span>
                                    <span
                                        class={Badge}
                                        data-tone={if connection.settings_state == "configured" { "success" } else { "warning" }}
                                    >
                                        {&connection.settings_state}
                                    </span>
                                    <span class={Badge} data-tone={if connection.review_count == 0 { "neutral" } else { "info" }}>
                                        {t.publication_review_count(connection.review_count)}
                                    </span>
                                </p>
                                <p class={Row}>
                                    <a class={(Button, Secondary)} href={publication_href(&connection.connection_id)}>
                                        {t.publication_manage()}
                                    </a>
                                </p>
                            </li>
                        }
                    </ul>
                }
            </section>
        </div>
    }
}

/// A connection's publication: the header with Back to publication, what the last write did, and
/// its settings, blocked listings and mappings to review; or that there is no such connection.
#[component(css = ChannelsPage)]
pub fn ChannelPublicationPage<'a>(t: ChannelsMsg, p: Pilot, screen: &'a PublicationScreen) -> impl Render {
    let title = screen.detail.as_ref().map_or(t.publication_connection_title(), |d| d.connection.provider_key.as_str());
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.publication_eyebrow()}</p>
                <h1 class={Title}>{title}</h1>
                <p class={Muted}>{t.publication_connection_description()}</p>
                <p class={Row}>
                    <a class={(Button, Secondary)} href={url::ChannelPublications}>{t.publication_back()}</a>
                </p>
            </header>
            <div role="status" aria-live="polite">
                match &screen.said {
                    PublicationSaid::Nothing => {}
                    PublicationSaid::Pending => {
                        <div class={Banner}><p>{t.publication_loading()}</p></div>
                    }
                    PublicationSaid::Exhausted => {
                        <div class={Banner} data-tone="warning">
                            <p class={Strong}>{t.publication_freshness_exhausted_title()}</p>
                            <p>{t.publication_freshness_exhausted_description()}</p>
                            <p class={Row}>
                                <a
                                    class={(Button, Secondary)}
                                    href={url::ChannelPublication { id: &screen.id, place: screen.place.here() }}
                                >
                                    {t.publication_freshness_exhausted_refresh()}
                                </a>
                            </p>
                        </div>
                    }
                    PublicationSaid::Conflict => {
                        <div class={Banner} data-tone="warning" tabindex="-1" autofocus>
                            <p class={Strong}>{t.publication_conflict_title()}</p>
                            <p>{t.publication_conflict_description()}</p>
                        </div>
                    }
                    PublicationSaid::Refused(words) => {
                        <div class={Banner} data-tone="danger" tabindex="-1" autofocus>
                            <p class={Strong}>{t.publication_error_title()}</p>
                            <p>{words}</p>
                        </div>
                    }
                }
            </div>
            match &screen.detail {
                None => {
                    <div class={Banner} role="status">
                        <p class={Strong}>{t.publication_missing_title()}</p>
                        <p>{t.publication_missing_description()}</p>
                    </div>
                }
                Some(detail) => {
                    <PublicationSettingsForm t={t} screen={screen} detail={detail} />
                    <BlockedListings t={t} detail={detail} />
                    <MappingReview t={t} p={p} screen={screen} detail={detail} />
                }
            }
        </div>
    }
}

/// The settings form, with the settings as read, or as sent after a refusal.
#[component(css = ChannelsPage)]
fn PublicationSettingsForm<'a>(t: ChannelsMsg, screen: &'a PublicationScreen, detail: &'a ChannelPublication) -> impl Render {
    let f = PublicationForm::FIELDS;
    let read = detail.settings.clone().unwrap_or_default();
    let number = |n: Option<i64>| n.map(|n| n.to_string()).unwrap_or_default();
    let shown = screen.sent.clone().unwrap_or_else(|| PublicationForm {
        title_prefix: read.title_prefix.clone(),
        title_suffix: read.title_suffix.clone(),
        description_footer: read.description_footer.clone(),
        publish_quantity_cap: number(read.publish_quantity_cap),
        low_stock_withhold_units: number(read.low_stock_withhold_units),
        category_allowlist: read.category_allowlist.join("\n"),
        excluded_listing_ids: read.excluded_listing_ids.join("\n"),
        ..PublicationForm::default()
    });
    let here = url::ChannelPublication { id: &screen.id, place: screen.place.here() };
    html! {
        <section class={Section} aria-labelledby="publication-settings">
            <h2 id="publication-settings" class={PartTitle}>{t.publication_settings_title()}</h2>
            if detail.settings.is_none() {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.publication_settings_missing_title()}</p>
                    <p>{t.publication_settings_missing_description()}</p>
                </div>
            }
            <form class={(Card, Form)} method="post" action={&here}>
                <fieldset class={Choices} disabled={screen.disabled()}>
                    <input type="hidden" name={f.intent} value="replace-settings">
                    <input type="hidden" name={f.expected_stream_version} value={detail.configuration_stream_version.to_string()}>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_title_prefix()}</span>
                        <input class={Control} type="text" name={f.title_prefix} value={&shown.title_prefix} maxlength="1000">
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_title_suffix()}</span>
                        <input class={Control} type="text" name={f.title_suffix} value={&shown.title_suffix} maxlength="1000">
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_description_footer()}</span>
                        <textarea class={(Control, Area)} name={f.description_footer} rows="3" maxlength="5000">
                            {&shown.description_footer}
                        </textarea>
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_publish_quantity_cap()}</span>
                        <input
                            class={Control}
                            type="number"
                            name={f.publish_quantity_cap}
                            value={&shown.publish_quantity_cap}
                            min="1"
                            max="1000"
                            step="1"
                            inputmode="numeric"
                            placeholder={t.publication_settings_publish_quantity_cap_placeholder()}
                        >
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_low_stock_withhold()}</span>
                        <input
                            class={Control}
                            type="number"
                            name={f.low_stock_withhold_units}
                            value={&shown.low_stock_withhold_units}
                            min="1"
                            max="1000"
                            step="1"
                            inputmode="numeric"
                            placeholder={t.publication_settings_low_stock_withhold_placeholder()}
                        >
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_category_allowlist()}</span>
                        <textarea class={(Control, Area)} name={f.category_allowlist} rows="4">
                            {&shown.category_allowlist}
                        </textarea>
                    </label>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_settings_excluded_listings()}</span>
                        <textarea class={(Control, Area)} name={f.excluded_listing_ids} rows="4">
                            {&shown.excluded_listing_ids}
                        </textarea>
                    </label>
                    <p class={Row}><button type="submit" class={Button}>{t.publication_settings_save()}</button></p>
                </fieldset>
            </form>
        </section>
    }
}

/// The listings recorded as blocked, each with its reasons.
#[component(css = ChannelsPage)]
fn BlockedListings<'a>(t: ChannelsMsg, detail: &'a ChannelPublication) -> impl Render {
    let blocked = &detail.blocked_listings;
    let shown = blocked.items.len() as u64;
    html! {
        <section class={Section} aria-labelledby="publication-blocked">
            <h2 id="publication-blocked" class={PartTitle}>{t.publication_blocked_title()}</h2>
            if blocked.items.is_empty() {
                <div class={Banner} role="status">
                    <p class={Strong}>{t.publication_blocked_empty_title()}</p>
                    <p>{t.publication_blocked_empty_description()}</p>
                </div>
            } else {
                if blocked.total > shown {
                    <div class={Banner} data-tone="warning">
                        <p class={Strong}>{t.publication_blocked_truncated_title()}</p>
                        <p>{t.publication_blocked_truncated_description(shown, blocked.total)}</p>
                    </div>
                }
                <ul class={Cards} role="list">
                    for item in &blocked.items {
                        <li class={Card}>
                            <p class={Strong}>{&item.listing_id}</p>
                            <p class={Muted}>{&item.channel_listing_id}</p>
                            <p class={Badges}>
                                if item.blocking_reason_codes.is_empty() {
                                    <span class={Badge} data-tone="warning">{t.publication_blocked_reason_unknown()}</span>
                                }
                                for code in &item.blocking_reason_codes {
                                    <span class={Badge} data-tone="warning">{code}</span>
                                }
                            </p>
                        </li>
                    }
                </ul>
            }
        </section>
    }
}

/// The mappings to review, each with its target and Accept, Reject and Revoke, and the next page.
#[component(css = ChannelsPage)]
fn MappingReview<'a>(t: ChannelsMsg, p: Pilot, screen: &'a PublicationScreen, detail: &'a ChannelPublication) -> impl Render {
    let review = &detail.mapping_review;
    let next = review
        .next_cursor
        .as_deref()
        .map(|cursor| url::ChannelPublication { id: &screen.id, place: PublicationPlace::next(cursor) });
    html! {
        <section class={Section} aria-labelledby="publication-mapping">
            <h2 id="publication-mapping" class={PartTitle}>{t.publication_mapping_title()}</h2>
            if review.completeness.kind == "incomplete" {
                <div class={Banner} data-tone="warning">
                    <p class={Strong}>{t.publication_mapping_incomplete_title()}</p>
                    if let Some(reason) = &review.completeness.reason {
                        <p>{reason}</p>
                    }
                </div>
            }
            if review.items.is_empty() {
                <div class={Banner} role="status">
                    <p class={Strong}>{t.publication_mapping_empty_title()}</p>
                    <p>{t.publication_mapping_empty_description()}</p>
                </div>
            } else {
                <ul class={Cards} role="list">
                    for item in &review.items {
                        <Mapping t={t} p={p} screen={screen} detail={detail} item={item} />
                    }
                </ul>
            }
            if let Some(next) = &next {
                <p class={Row}><a class={(Button, Secondary)} href={next}>{t.publication_mapping_next()}</a></p>
            }
        </section>
    }
}

#[component(css = ChannelsPage)]
fn Mapping<'a>(
    t: ChannelsMsg,
    p: Pilot,
    screen: &'a PublicationScreen,
    detail: &'a ChannelPublication,
    item: &'a MappingCandidate,
) -> impl Render {
    let f = PublicationForm::FIELDS;
    let here = url::ChannelPublication { id: &screen.id, place: screen.place.here() };
    let facts = format!("{} · {} · {}", item.dimension, item.review_status, item.confidence_tier);
    html! {
        <li class={Card}>
            <p class={Strong}>{&item.source_key}</p>
            <p class={Muted}>{&facts}</p>
            <form class={Form} method="post" action={&here}>
                <fieldset class={Choices} disabled={screen.disabled()}>
                    <input type="hidden" name={f.intent} value="decide-mapping">
                    <input type="hidden" name={f.dimension} value={&item.dimension}>
                    <input type="hidden" name={f.source_key} value={&item.source_key}>
                    <input type="hidden" name={f.expected_stream_version} value={detail.configuration_stream_version.to_string()}>
                    <label class={Field}>
                        <span class={Strong}>{t.publication_mapping_target()}</span>
                        <input
                            class={Control}
                            type="text"
                            name={f.target_key}
                            value={item.target_key.as_deref().unwrap_or_default()}
                        >
                    </label>
                    <div class={Row} role="group" aria-label={p.channels_mapping_options(&item.source_key)}>
                        <button type="submit" class={Button} name={f.decision} value="accept">
                            {t.publication_mapping_accept()}
                        </button>
                        <button type="submit" class={(Button, Danger)} name={f.decision} value="reject">
                            {t.publication_mapping_reject()}
                        </button>
                        if item.review_status != "revoked" {
                            <button type="submit" class={(Button, Secondary)} name={f.decision} value="revoke">
                                {t.publication_mapping_revoke()}
                            </button>
                        }
                    </div>
                </fieldset>
            </form>
        </li>
    }
}

/// A run's state's words (`stateLabel`).
fn run_state_word(t: ChannelsMsg, state: &str) -> &str {
    match state {
        "composed" => t.manual_sync_state_composed(),
        "claimed" => t.manual_sync_state_claimed(),
        "awaiting-verification" => t.manual_sync_state_awaiting_verification(),
        "applied" => t.manual_sync_state_applied(),
        "validation-rejected" => t.manual_sync_state_validation_rejected(),
        "application-unknown" => t.manual_sync_state_application_unknown(),
        "superseded" => t.manual_sync_state_superseded(),
        "stale-basis" => t.manual_sync_state_stale_basis(),
        "abandoned" => t.manual_sync_state_abandoned(),
        _ => t.manual_sync_state_none(),
    }
}

/// A run's state's badge tone (`stateTone`).
fn run_tone(state: &str) -> &'static str {
    match state {
        "applied" => "success",
        "application-unknown" | "stale-basis" => "danger",
        "validation-rejected" | "abandoned" => "warning",
        _ => "info",
    }
}

/// Why inbound coverage is dark (`coverageReasonKeys`).
fn dark_words(t: ChannelsMsg, reason: Option<&str>) -> &'static str {
    match reason {
        Some("inbound-authority-revoked") => t.manual_sync_coverage_revoked_description(),
        Some("provider-has-no-inbound") => t.manual_sync_coverage_unsupported_description(),
        Some("inbound-authority-failing") => t.manual_sync_coverage_failing_description(),
        _ => t.manual_sync_coverage_dark_description(),
    }
}

/// The states a run is still in progress in, whose lease the panel counts down
/// (`channelSyncRunStates` before the terminal ones).
const OPEN_RUN_STATES: [&str; 3] = ["composed", "claimed", "awaiting-verification"];

/// A connection's manual TCGplayer sync (`ManualSyncPanelView`): the run's state, inbound
/// coverage, the counts and the lease, and the actions Channels allows, each a form; an export's
/// ingest posts the file. A reader sees the panel without its forms.
#[component(css = ChannelsPage)]
fn ManualSync<'a>(t: ChannelsMsg, id: &'a str, panel: &'a ManualSyncPanel, said: &'a ManualSaid, manage: bool) -> impl Render {
    let run = panel.run.as_ref();
    let state = run.map_or("none", |run| run.state.as_str());
    let recovery = panel.attention_reason.as_deref() == Some("recovery");
    let open = run.is_some_and(|run| OPEN_RUN_STATES.contains(&run.state.as_str()));
    let live = panel.inbound_coverage.state == "live";
    let write = url::ChannelManualSync { id }.href();
    let ingest = url::ChannelManualSyncIngest { id }.href();
    let download = url::ChannelManualSyncDownload { id }.href();
    let f = ManualSyncForm::FIELDS;
    let g = IngestForm::FIELDS;
    let can = |action: &str| manage && panel.allows(action);
    html! {
        <section class={(Section, Card)} aria-labelledby="manual-sync">
            <div class={Row}>
                <h2 id="manual-sync" class={PartTitle}>{t.manual_sync_title()}</h2>
                if recovery {
                    <span class={Badge} data-tone="warning">{t.manual_sync_recovery_badge()}</span>
                } else {
                    <span class={Badge} data-tone={run_tone(state)}>{run_state_word(t, state)}</span>
                }
            </div>
            <p class={Muted}>{t.manual_sync_description()}</p>
            if recovery {
                <div class={Banner} data-tone="warning" role="status">
                    <p class={Strong}>{t.manual_sync_recovery_title()}</p>
                    <p>{t.manual_sync_recovery_description()}</p>
                </div>
            }
            <div class={Banner} data-tone={if live { "success" } else { "warning" }}>
                if live {
                    <p class={Strong}>{t.manual_sync_coverage_live()}</p>
                    <p>{t.manual_sync_coverage_live_description()}</p>
                } else {
                    <p class={Strong}>{t.manual_sync_coverage_dark()}</p>
                    <p>{dark_words(t, panel.inbound_coverage.reason.as_deref())}</p>
                }
            </div>
            <dl class={Facts}>
                <div>
                    <dt>{t.manual_sync_metric_requested()}</dt>
                    <dd>{panel.requested_listing_count}</dd>
                </div>
                <div>
                    <dt>{t.manual_sync_metric_composed()}</dt>
                    <dd>{panel.composed_listing_count}</dd>
                </div>
                if open {
                    <div>
                        <dt>{t.manual_sync_metric_lease()}</dt>
                        match panel.lease_countdown_ms {
                            Some(ms) => { <dd>{t.manual_sync_lease_value(ms / 60_000, ms % 60_000 / 1_000)}</dd> }
                            None => { <dd>{t.manual_sync_lease_none()}</dd> }
                        }
                    </div>
                }
                if let Some(run) = run {
                    <div>
                        <dt>{t.manual_sync_lease_expires_at()}</dt>
                        <dd>{&run.lease_expires_at}</dd>
                    </div>
                    if let Some(at) = &run.upload_attempted_at {
                        <div>
                            <dt>{t.manual_sync_lease_upload_attempted_at()}</dt>
                            <dd>{at}</dd>
                        </div>
                    }
                }
            </dl>
            match said {
                ManualSaid::StagedBasis => {
                    <div class={Banner} data-tone="warning" role="alert">
                        <p class={Strong}>{t.manual_sync_compose_staged_basis_title()}</p>
                        <p>{t.manual_sync_compose_staged_basis_description()}</p>
                    </div>
                }
                ManualSaid::Failed => {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.manual_sync_action_failed()}</p>
                        <p>{t.manual_sync_action_failed_description()}</p>
                    </div>
                }
                ManualSaid::Invalid => {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.manual_sync_action_failed()}</p>
                        <p>{t.manual_sync_action_invalid()}</p>
                    </div>
                }
                ManualSaid::Ingested(receipt) => { <Receipt t={t} receipt={receipt} /> }
                ManualSaid::Nothing => {}
            }
            if manage {
                <div class={Row}>
                    if can("compose") {
                        <form class={Inline} method="post" action={&write}>
                            <input type="hidden" name={f.intent} value="compose">
                            <button type="submit" class={Button}>{t.manual_sync_action_compose()}</button>
                        </form>
                    }
                    if let Some(run) = run {
                        if can("retry-clamp") {
                            <RunForm to={&write} intent="retry-clamp" label={t.manual_sync_action_retry_clamp()} run={run} />
                        }
                        if can("download") {
                            <RunForm to={&download} intent="download" label={t.manual_sync_action_download()} run={run} />
                        }
                        if can("record-validation-cancellation") {
                            <RunForm to={&write} intent="validation-cancelled" label={t.manual_sync_action_cancel()} run={run} />
                        }
                        if can("release") {
                            <RunForm to={&write} intent="release" label={t.manual_sync_action_release()} run={run} />
                        }
                    }
                </div>
                if let Some(run) = run.filter(|_| can("record-upload-attempt")) {
                    <form class={Form} method="post" action={&write}>
                        <input type="hidden" name={f.intent} value="upload-attempt">
                        <input type="hidden" name={f.run_id} value={&run.run_id}>
                        <input type="hidden" name={f.expected_revision} value={run.revision}>
                        <label class={Field}>
                            <span class={Strong}>{t.manual_sync_file_staged_label()}</span>
                            <input class={Control} name={f.file_name} required>
                        </label>
                        <p class={Row}><button type="submit" class={Button}>{t.manual_sync_action_upload_attempt()}</button></p>
                    </form>
                }
                for (surface, allowed, label, action) in [
                    ("live", can("ingest-live"), t.manual_sync_file_live_label(), t.manual_sync_action_ingest_live()),
                    ("staged", can("ingest-staged"), t.manual_sync_file_staged_label(), t.manual_sync_action_ingest_staged()),
                ] {
                    if allowed {
                        <form class={Form} method="post" action={&ingest} enctype="multipart/form-data">
                            <input type="hidden" name={g.surface} value={surface}>
                            <label class={Field}>
                                <span class={Strong}>{label}</span>
                                <span class={Muted}>{t.manual_sync_file_description()}</span>
                                <input class={Control} type="file" name={g.export} accept=".csv,text/csv" required>
                            </label>
                            <p class={Row}><button type="submit" class={(Button, Secondary)}>{action}</button></p>
                        </form>
                    }
                }
                if let Some(run) = run.filter(|_| can("verify")) {
                    match &panel.verification_candidate {
                        Some(candidate) => {
                            <form class={Form} method="post" action={&write}>
                                <input type="hidden" name={f.intent} value="verify">
                                <input type="hidden" name={f.run_id} value={&run.run_id}>
                                <input type="hidden" name={f.expected_revision} value={run.revision}>
                                <input type="hidden" name={f.verification_snapshot_id} value={&candidate.snapshot_id}>
                                <dl class={Facts}>
                                    <div>
                                        <dt>{t.manual_sync_verify_snapshot()}</dt>
                                        <dd>{&candidate.snapshot_id}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.manual_sync_verify_captured_at()}</dt>
                                        <dd>{&candidate.captured_at}</dd>
                                    </div>
                                    <div>
                                        <dt>{t.manual_sync_verify_parsed_row_count()}</dt>
                                        <dd>{candidate.parsed_row_count}</dd>
                                    </div>
                                </dl>
                                <label class={Field}>
                                    <span class={Strong}>{t.manual_sync_verify_file_name()}</span>
                                    <input class={Control} name={f.file_name} required>
                                </label>
                                <label class={Field}>
                                    <span class={Strong}>{t.manual_sync_verify_date_imported()}</span>
                                    <input class={Control} name={f.date_imported_text} required>
                                </label>
                                <label class={Field}>
                                    <span class={Strong}>{t.manual_sync_verify_number_of_products()}</span>
                                    <input class={Control} name={f.number_of_products} inputmode="numeric" required>
                                </label>
                                <p class={Row}><button type="submit" class={Button}>{t.manual_sync_action_verify()}</button></p>
                            </form>
                        }
                        None => {
                            <div class={Banner} data-tone="info" role="status">
                                <p class={Strong}>{t.manual_sync_verify_none_title()}</p>
                                <p>{t.manual_sync_verify_none_description()}</p>
                            </div>
                        }
                    }
                }
            }
        </section>
    }
}

/// A run's bodiless write, made at the revision the panel was drawn with.
#[component(css = ChannelsPage)]
fn RunForm<'a>(to: &'a str, intent: &'static str, label: &'a str, run: &'a SyncRun) -> impl Render {
    let f = ManualSyncForm::FIELDS;
    html! {
        <form class={Inline} method="post" action={to}>
            <input type="hidden" name={f.intent} value={intent}>
            <input type="hidden" name={f.run_id} value={&run.run_id}>
            <input type="hidden" name={f.expected_revision} value={run.revision}>
            <button type="submit" class={(Button, Secondary)}>{label}</button>
        </form>
    }
}

/// What an export's ingest found (`IngestReceipt`).
#[component(css = ChannelsPage)]
fn Receipt<'a>(t: ChannelsMsg, receipt: &'a IngestReceipt) -> impl Render {
    let outcome = &receipt.outcome;
    let probe = &receipt.probe;
    html! {
        if outcome.kind == "ingested" {
            <div class={Banner} data-tone="success" role="status">
                <p class={Strong}>
                    if receipt.surface == "live" {
                        {t.manual_sync_receipt_ingested_live()}
                    } else {
                        {t.manual_sync_receipt_ingested_staged()}
                    }
                </p>
                <p>
                    {t.manual_sync_receipt_ingested_description(
                        outcome.snapshot_id.as_deref().unwrap_or_default(),
                        outcome.snapshot_generation.unwrap_or_default(),
                        outcome.parsed_row_count.unwrap_or_default(),
                    )}
                </p>
            </div>
        } else {
            <div class={Banner} data-tone="danger" role="alert">
                <p class={Strong}>{t.manual_sync_receipt_refused_title()}</p>
                <p>{t.manual_sync_receipt_refused_description(outcome.reason.as_deref().unwrap_or_default())}</p>
            </div>
        }
        <dl class={Facts}>
            <div>
                <dt>{t.manual_sync_receipt_file_name()}</dt>
                <dd>{&probe.file_name}</dd>
            </div>
            <div>
                <dt>{t.manual_sync_receipt_byte_size()}</dt>
                <dd>{probe.byte_size}</dd>
            </div>
            <div>
                <dt>{t.manual_sync_receipt_logical_rows()}</dt>
                <dd>{probe.logical_rows}</dd>
            </div>
            <div>
                <dt>{t.manual_sync_receipt_header_sha256()}</dt>
                <dd>{&probe.header_sha256}</dd>
            </div>
            <div>
                <dt>{t.manual_sync_receipt_observed_at()}</dt>
                <dd>{&probe.observed_at}</dd>
            </div>
        </dl>
    }
}
