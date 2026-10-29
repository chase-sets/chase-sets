//! The channel screens (Channels' `ChannelConnectionListPage`, `ChannelConnectionDetailPage` and
//! `ChannelPublicationListPage`): the connections with the status filter as links, the next page
//! and Connect a channel; a connection's status with its actions and the setup's storage
//! locations; and each connection's publication summary. Every action is a form or a link. The
//! cards are one column on a phone and two from 48rem.
use corten::prelude::*;
use platform::api::segment;

use crate::{
    api::{ChannelConnection, ChannelPublicationSummary},
    app::url,
    channels::{ChannelsScreen, ConnectForm, ConnectionForm, ConnectionScreen, ListPlace, STATUSES, actions},
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

/// A connection's publication page, on marketplace for now.
fn publication_on_marketplace(id: &str) -> String {
    on_marketplace(&format!("/account/channels/publication/{}", segment(id)))
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
                    <a class={(Button, Ghost)} href={publication_on_marketplace(&connection.connection_id)}>
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
                                    <a class={(Button, Secondary)} href={publication_on_marketplace(&connection.connection_id)}>
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
