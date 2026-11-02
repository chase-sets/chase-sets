//! The notification center, after Notifications' `notification-center-page.tsx`: the heading,
//! Feed and Settings as links, then the feed (each notification's title, words, source and time,
//! Open and Mark read; Mark all read) or the settings (each delivery channel's switch, then the
//! account's Product alerts with Pause or Resume, Delete and View product). Every action is a
//! form; a channel's switch is its form's button (`role="switch"`), so it works without a script.
//! One column at every width, as marketplace's narrow page is.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::{Feed, FeedItem, Preference, ProductAlert},
    app::url,
    items::Address,
    notifications::{AlertInput, Alerts, CHANNELS, Notice, PreferenceInput, ReadInput, Screen, Section, open_href},
    text::{NotificationsMsg, Pilot},
};

/// The feed, which a feed write draws again.
#[derive(Id)]
pub struct FeedId;

/// A channel's switch, which its write draws again.
#[derive(Id)]
pub struct PreferenceId<'a>(pub &'a str);

/// The Product alerts (`product-alerts`), which an alert's write draws again and links go to.
#[derive(Id)]
pub struct ProductAlertsId;

/// The page.
#[component(css)]
pub fn NotificationPage<'a>(t: NotificationsMsg, p: Pilot, screen: &'a Screen, notice: Option<&'a Notice>) -> impl Render {
    let feed = matches!(screen, Screen::Feed(_));
    let feed_href = url::Notifications::default().href();
    let settings_href = url::Notifications { place: crate::notifications::Place::settings(Section::Preferences, None) }.href();
    let message = |which: fn(&Notice) -> Option<&String>| notice.and_then(which).map(String::as_str);
    let feed_notice = message(|n| if let Notice::Feed(m) = n { Some(m) } else { None });
    let preference_notice = message(|n| if let Notice::Preferences(m) = n { Some(m) } else { None });
    let alert_notice = message(|n| if let Notice::Alerts(m) = n { Some(m) } else { None });
    html! {
        <div class={Page}>
            <header class={Head}>
                <h1 class={Title}>{t.page_heading()}</h1>
                <p class={Muted}>{t.route_description()}</p>
            </header>
            <nav class={Tabs} aria-label={t.page_heading()}>
                <a class={if feed { Primary } else { Secondary }} href={&feed_href} aria-current={feed.then_some("page")}>
                    {t.page_feed_label()}
                </a>
                <a class={if feed { Secondary } else { Primary }} href={&settings_href} aria-current={(!feed).then_some("page")}>
                    <span aria-hidden="true">"\u{2699}"</span>" "{t.page_settings_label()}
                </a>
            </nav>
            match screen {
                Screen::Feed(Some(feed)) => { <FeedSection t={t} feed={feed} notice={feed_notice} /> }
                Screen::Settings(Some(settings), section) => {
                    <section class={Section} aria-labelledby="preferences-heading">
                        <h2 id="preferences-heading" class={SectionTitle}>{t.page_settings_preferences_heading()}</h2>
                        <p class={Muted}>{t.page_settings_preferences_description()}</p>
                        if let Some(message) = preference_notice {
                            <div class={Banner} data-tone="danger" role="alert"><p>{message}</p></div>
                        }
                        <ul class={List}>
                            for key in CHANNELS {
                                if let Some(preference) = settings.preferences.iter().find(|p| p.key == key) {
                                    <li><PreferenceSwitch t={t} preference={preference} /></li>
                                }
                            }
                        </ul>
                    </section>
                    <AlertsSection
                        t={t}
                        p={p}
                        alerts={&settings.alerts}
                        notice={alert_notice}
                        focus={*section == Section::ProductAlerts}
                    />
                }
                _ => {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.page_read_failure_title()}</p>
                        <p>{t.page_read_failure_description()}</p>
                        <p>
                            <a class={Secondary} href={if feed { &feed_href } else { &settings_href }}>
                                {t.page_read_failure_retry()}
                            </a>
                        </p>
                    </div>
                }
            }
        </div>
    }
}

/// The feed (`NotificationFeed`): the heading and how many are unread, each notification, and
/// Mark all read, off when none is unread. A failed write says so above it and leaves it as it was.
#[component(css = NotificationPage)]
pub fn FeedSection<'a>(t: NotificationsMsg, feed: &'a Feed, notice: Option<&'a str>) -> impl Patch {
    html! {
        <section id={FeedId} class={Section} aria-labelledby="feed-heading">
            if let Some(message) = notice {
                <div class={Banner} data-tone="danger" role="alert"><p>{message}</p></div>
            }
            <div class={Inline}>
                <h2 id="feed-heading" class={SectionTitle}>{t.page_feed_heading()}</h2>
                <span class={Badge} data-tone={if feed.unread > 0 { "accent" } else { "neutral" }}>
                    {&t.page_feed_unread(feed.unread).to_string()}
                </span>
            </div>
            if feed.items.is_empty() {
                <div class={Empty}>
                    <p class={Strong}>{t.page_feed_empty_title()}</p>
                    <p class={Muted}>{t.page_feed_empty_description()}</p>
                </div>
            } else {
                <ul class={List}>
                    for item in &feed.items {
                        <li><FeedCard t={t} item={item} /></li>
                    }
                </ul>
            }
            <form method="post" action={&url::NotificationReadAll.href()} data-patch>
                <button type="submit" class={Secondary} disabled={feed.unread == 0}>{t.page_feed_mark_all_read()}</button>
            </form>
        </section>
    }
}

/// Where a notification came from (`sourceLabel`), by its message type.
fn source(t: NotificationsMsg, message_type: &str) -> &'static str {
    if message_type.starts_with("ordering.") {
        t.shell_source_orders()
    } else if message_type.starts_with("fulfillment.") {
        t.shell_source_shipments()
    } else if message_type.starts_with("inventory.") {
        t.shell_source_inventory()
    } else if message_type.starts_with("discovery.product-alert") {
        t.shell_source_product_alerts()
    } else {
        t.shell_source_marketplace()
    }
}

/// A notification: its title and words, New or Read, its source and time, Open and Mark read.
#[component(css = NotificationPage)]
fn FeedCard<'a>(t: NotificationsMsg, item: &'a FeedItem) -> impl Render {
    let read = item.read_at.is_some();
    let when = parse_timestamp(&item.created_at).map(|at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
    let open = item.action_href.as_deref().and_then(open_href);
    let f = ReadInput::FIELDS;
    html! {
        <article class={Card}>
            <div class={CardHead}>
                <div class={Stack}>
                    <p class={Strong}>{&item.title}</p>
                    <p class={Muted}>{&item.body}</p>
                </div>
                <span class={Badge} data-tone={if read { "neutral" } else { "accent" }}>
                    {if read { t.page_feed_read() } else { t.page_feed_new() }}
                </span>
            </div>
            <p class={Faint}>
                <span>{source(t, &item.message_type)}</span>
                if let Some(when) = &when {
                    " \u{b7} " <time datetime={&item.created_at}>{when}</time>
                }
            </p>
            if open.is_some() || !read {
                <div class={Inline}>
                    if let Some(open) = &open {
                        <a class={Secondary} href={open}>{t.shell_open()}</a>
                    }
                    if !read {
                        <form method="post" action={&url::NotificationRead.href()} data-patch>
                            <input type="hidden" name={f.delivery} value={&item.delivery_id}>
                            <button type="submit" class={Ghost}>{t.page_feed_mark_read()}</button>
                        </form>
                    }
                </div>
            }
        </article>
    }
}

/// A channel's words, by its key.
fn channel(t: NotificationsMsg, key: &str) -> (&'static str, &'static str) {
    match key {
        "web" => (t.shell_preference_web_label(), t.shell_preference_web_description()),
        "email" => (t.shell_preference_email_label(), t.shell_preference_email_description()),
        _ => (t.shell_preference_product_alerts_label(), t.shell_preference_product_alerts_description()),
    }
}

/// A delivery channel's switch (`Switch`): its name and words, and a button that turns it the
/// other way, `role="switch"` with `aria-checked` saying how it is.
#[component(css = NotificationPage)]
pub fn PreferenceSwitch<'a>(t: NotificationsMsg, preference: &'a Preference) -> impl Patch {
    let (label, description) = channel(t, &preference.key);
    let label_id = format!("preference-{}-label", preference.key);
    let description_id = format!("preference-{}-description", preference.key);
    let f = PreferenceInput::FIELDS;
    html! {
        <form
            id={PreferenceId(&preference.key)}
            class={Preference}
            method="post"
            action={&url::NotificationPreference { key: &preference.key }.href()}
            data-patch
        >
            <input type="hidden" name={f.enabled} value={if preference.enabled { "false" } else { "true" }}>
            <div class={Stack}>
                <span id={&label_id} class={Strong}>{label}</span>
                <span id={&description_id} class={Muted}>{description}</span>
            </div>
            <button
                type="submit"
                class={Switch}
                role="switch"
                aria-checked={if preference.enabled { "true" } else { "false" }}
                aria-labelledby={&label_id}
                aria-describedby={&description_id}
            ></button>
        </form>
    }
}

/// The account's Product alerts (Discovery's): each alert, or that there are none yet; after a
/// write whose read has not caught up, that the change is saved. When the address names this
/// section (`focus`), its heading takes focus as the page loads, which scrolls to it with no
/// script (marketplace scrolls it into view).
#[component(css = NotificationPage)]
pub fn AlertsSection<'a>(t: NotificationsMsg, p: Pilot, alerts: &'a Alerts, notice: Option<&'a str>, focus: bool) -> impl Patch {
    html! {
        <section id={ProductAlertsId} class={Section} aria-labelledby="product-alerts-heading">
            <h2 id="product-alerts-heading" class={SectionTitle} tabindex="-1" autofocus={focus}>
                {t.page_settings_product_alerts_heading()}
            </h2>
            <p class={Muted}>{t.page_settings_product_alerts_description()}</p>
            if let Some(message) = notice {
                <div class={Banner} data-tone="danger" role="alert"><p>{message}</p></div>
            }
            match alerts {
                Alerts::CatchingUp => {
                    <div class={Banner} role="status"><p>{p.notifications_pending()}</p></div>
                }
                Alerts::Unconfirmed => {
                    <div class={Banner} data-tone="warning" role="alert"><p>{p.notifications_unconfirmed()}</p></div>
                }
                Alerts::Listed(alerts) if alerts.is_empty() => {
                    <div class={Empty}>
                        <p class={Strong}>{t.page_settings_product_alerts_empty_title()}</p>
                        <p class={Muted}>{t.page_settings_product_alerts_empty_description()}</p>
                    </div>
                }
                Alerts::Listed(alerts) => {
                    <ul class={List}>
                        for alert in alerts {
                            <li><AlertCard t={t} alert={alert} /></li>
                        }
                    </ul>
                }
            }
        </section>
    }
}

/// What an alert watches (`productAlertDetail`): its side, and its price when it has one.
fn detail(t: NotificationsMsg, alert: &ProductAlert) -> String {
    let listing = alert.market_side == "listing";
    match alert.threshold_amount.as_deref().filter(|a| !a.is_empty()) {
        None if listing => t.shell_product_alerts_listings_all_new_matches().to_owned(),
        None => t.shell_product_alerts_offers_all_new_matches().to_owned(),
        Some(amount) if listing => t.shell_product_alerts_listings_at_or_below(amount).to_string(),
        Some(amount) => t.shell_product_alerts_offers_at_or_above(amount).to_string(),
    }
}

/// An alert: its product, what it watches, active or paused, Pause or Resume, Delete and View
/// product.
#[component(css = NotificationPage)]
fn AlertCard<'a>(t: NotificationsMsg, alert: &'a ProductAlert) -> impl Render {
    let active = alert.status == "active";
    let action = url::ProductAlertChange { id: &alert.alert_id }.href();
    let product = url::Item { slug: &alert.catalog_catalog_item_id, state: Address::default(), after: Default::default() }.href();
    let f = AlertInput::FIELDS;
    html! {
        <article class={Card}>
            <div class={CardHead}>
                <div class={Stack}>
                    <p class={Strong}>{alert.product_summary.as_deref().unwrap_or(&alert.product_id)}</p>
                    <p class={Muted}>{&detail(t, alert)}</p>
                </div>
                <span class={Badge} data-tone={if active { "success" } else { "neutral" }}>
                    {if active { t.page_settings_product_alerts_status_active() } else { t.page_settings_product_alerts_status_paused() }}
                </span>
            </div>
            <div class={Inline}>
                <form method="post" action={&action} data-patch>
                    <input type="hidden" name={f.action} value={if active { "pause" } else { "resume" }}>
                    <button type="submit" class={Secondary}>
                        {if active { t.page_settings_product_alerts_pause() } else { t.page_settings_product_alerts_resume() }}
                    </button>
                </form>
                <form method="post" action={&action} data-patch>
                    <input type="hidden" name={f.action} value="delete">
                    <button type="submit" class={Ghost}>{t.page_settings_product_alerts_delete()}</button>
                </form>
                <a class={Ghost} href={&product}>{t.page_settings_product_alerts_view_product()}</a>
            </div>
        </article>
    }
}
