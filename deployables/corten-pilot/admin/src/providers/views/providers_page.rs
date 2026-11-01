//! Provider Connections (`ProviderConnectionsPage`): the header, then Catalog's providers and
//! Channels' connections, each a section with its table, which scrolls on its own on a phone. A
//! section the API could not read says so instead of its table.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    providers::{Connection, Section, Snapshot},
    text::Ops,
};

fn capability(o: Ops, value: &str) -> String {
    match value {
        "catalog-integration" => o.pc_capability_catalog_integration().to_owned(),
        "channel-connection" => o.pc_capability_channel_connection().to_owned(),
        other => other.to_owned(),
    }
}

fn credential(o: Ops, value: &str) -> String {
    match value {
        "not-required" => o.pc_credential_not_required(),
        "configured" => o.pc_credential_configured(),
        "missing" => o.pc_credential_missing(),
        "invalid" => o.pc_credential_invalid(),
        "expired" => o.pc_credential_expired(),
        "revoked" => o.pc_credential_revoked(),
        "unknown" => o.pc_credential_unknown(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn health(o: Ops, value: &str) -> String {
    match value {
        "ready" => o.pc_health_ready(),
        "blocked" => o.pc_health_blocked(),
        "degraded" => o.pc_health_degraded(),
        "healthy" => o.pc_health_healthy(),
        "failing" => o.pc_health_failing(),
        "unknown" => o.pc_health_unknown(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn status(o: Ops, value: &str) -> String {
    match value {
        "pending-setup" => o.pc_status_pending_setup(),
        "active" => o.pc_status_active(),
        "paused" => o.pc_status_paused(),
        "disconnected" => o.pc_status_disconnected(),
        other => return other.to_owned(),
    }
    .to_owned()
}

fn owner(o: Ops, value: &str) -> String {
    match value {
        "catalog" => o.pc_owner_catalog().to_owned(),
        "channels" => o.pc_owner_channels().to_owned(),
        other => other.to_owned(),
    }
}

/// A credential or health in a tone: good, warning or bad.
fn tone(value: &str) -> &'static str {
    match value {
        "ready" | "healthy" | "configured" | "not-required" | "active" => "good",
        "missing" | "invalid" | "expired" | "revoked" | "blocked" | "failing" | "disconnected" => "bad",
        _ => "warn",
    }
}

/// The observation's age (`observation`): the API's freshness, then when and how many minutes ago.
fn observed(o: Ops, row: &Connection) -> (String, Option<String>, &'static str) {
    let (words, tone) = match row.freshness_state.as_deref() {
        Some("ageOnly") => (o.pc_freshness_age_only(), "neutral"),
        Some("fresh") => (o.pc_freshness_fresh(), "good"),
        Some("aging") => (o.pc_freshness_aging(), "neutral"),
        Some("stale") => (o.pc_freshness_stale(), "warn"),
        Some("unavailable") => (o.pc_freshness_unavailable(), "bad"),
        _ => (o.pc_freshness_unknown(), "warn"),
    };
    let seconds = row.age_seconds;
    let at = row.observed_at.as_deref().unwrap_or("");
    let at =
        parse_timestamp(at).map_or_else(|| at.to_owned(), |w| o.date_time(w, DateStyle::Medium, TimeStyle::Short).to_string());
    let when = seconds.map(|s| o.pc_observed(&at, (s / 60.0).floor() as i64).to_string());
    (words.to_owned(), when, tone)
}

#[component(css = ProvidersPage)]
fn Part<'a>(o: Ops, which: &'static str, section: &'a Section) -> impl Render {
    let (title, description, empty) = match which {
        "catalog" => (o.pc_home_catalog(), o.pc_description_catalog(), o.pc_empty_catalog()),
        _ => (o.pc_home_channels(), o.pc_description_channels(), o.pc_empty_channels()),
    };
    let id = format!("pc-{which}");
    html! {
        <section class={Card} aria-labelledby={&id}>
            <div>
                <h2 class={Heading} id={&id}>{title}</h2>
                <p class={Muted}>{description}</p>
            </div>
            if section.state == "unavailable" {
                <div class={Nothing} role="status">
                    <p class={Strong}>{o.pc_unavailable()}</p>
                    <p class={Muted}>{o.pc_unavailable_description()}</p>
                </div>
            } else {
                if section.state == "partial" {
                    <p class={Note} role="status">{o.pc_partial()}</p>
                }
                if section.rows.is_empty() {
                    <div class={Nothing}>
                        <p class={Strong}>{empty}</p>
                        <p class={Muted}>{o.pc_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.pc_provider()}</th>
                                    <th scope="col">{o.pc_capability()}</th>
                                    <th scope="col">{o.pc_scope()}</th>
                                    <th scope="col">{o.pc_credential()}</th>
                                    <th scope="col">{o.pc_health()}</th>
                                    <th scope="col">{o.pc_observation()}</th>
                                    <th scope="col">{o.pc_owner()}</th>
                                    <th scope="col">{o.pc_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &section.rows {
                                    <Line o={o} row={row} />
                                }
                            </tbody>
                        </table>
                    </div>
                }
            }
        </section>
    }
}

#[component(css = ProvidersPage)]
fn Line<'a>(o: Ops, row: &'a Connection) -> impl Render {
    let (fresh, when, fresh_tone) = observed(o, row);
    let scope = match &row.account_id {
        Some(account) => o.pc_seller_scope(account).to_string(),
        None => o.pc_platform_scope().to_owned(),
    };
    // A provider's page is admin-web's (the pilot does not serve Catalog's providers).
    let open = row.destination.as_ref().filter(|_| row.owner == "catalog").and_then(|d| crate::views::admin_web(&d.href));
    html! {
        <tr>
            <td class={Words}>
                <p class={Strong}>{&row.provider}</p>
                <p class={Muted}>{&row.id}</p>
            </td>
            <td>{capability(o, &row.capability)}</td>
            <td class={Words}>{scope}</td>
            <td>
                <span class={Pill} data-tone={tone(&row.credential_readiness)}>{credential(o, &row.credential_readiness)}</span>
            </td>
            <td>
                <span class={Pill} data-tone={tone(&row.health)}>{health(o, &row.health)}</span>
                if let Some(value) = &row.status {
                    <p class={Muted}>{status(o, value)}</p>
                }
            </td>
            <td>
                <span class={Pill} data-tone={fresh_tone}>{fresh}</span>
                if let Some(when) = when {
                    <p class={(Muted, Words)}>{when}</p>
                }
            </td>
            <td>{owner(o, &row.owner)}</td>
            <td>
                match open {
                    Some(href) => { <a class={Button} href={href}>{o.pc_open_provider()}</a> }
                    None => { <span class={Muted}>{o.pc_read_only()}</span> }
                }
            </td>
        </tr>
    }
}

#[component(css)]
pub fn ProvidersPage<'a>(o: Ops, snapshot: &'a Snapshot) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <h1>{o.pc_title()}</h1>
                <p class={Muted}>{o.pc_description()}</p>
            </header>
            <Part o={o} which="catalog" section={&snapshot.catalog} />
            <Part o={o} which="channels" section={&snapshot.channels} />
        </div>
    }
}
