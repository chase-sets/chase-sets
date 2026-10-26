//! admin-web's realtime connection status (`CatalogRealtimeConnectionStatus`, the design system's
//! `ConnectionStatusIndicator`) around a `<corten-live>`: whether its stream of changes is live. It
//! draws the element, its status and then `children` (what the stream redraws). Live while the
//! stream is open, Connecting before it, and a warning with Reload once it dropped: the states are
//! CSS on the element's `status`, so they need no script. The script only writes when it went
//! stale (`stale-since`), in the page's locale, on connect and on each `corten-status` the element
//! dispatches. Without JavaScript nothing streams, and nothing shows. Each screen passes its own
//! words (`LiveWords`), from its own catalog.
use corten::{
    FieldName,
    i18n::{DateFormat, Template},
    prelude::*,
    view::AttrValue,
};

/// A message with one argument, `{value}`: what `t.js().key()` gives for one.
pub type WithValue = Template<{ corten::script::message_id(&["value"]) }>;

/// What a `LiveStatus` says, in the screen's catalog.
pub struct LiveWords {
    pub live: &'static str,
    pub connecting: &'static str,
    /// "Stale since {value}", for the script to fill in (`t.js()`).
    pub stale_since: WithValue,
    /// The same message without its time, until the script writes it.
    pub stale: String,
    pub stale_description: &'static str,
    /// The stale warning's Reload, which draws the page again; none for a screen whose warning has
    /// no button (it says to reload).
    pub reload: Option<&'static str>,
    /// How the script writes the time (`t.js().date_time(..)`).
    pub date: DateFormat,
}

#[component(css, js)]
pub fn LiveStatus<'a, I: Id + AttrValue + Copy, C: Render>(
    words: &'a LiveWords,
    id: I,
    src: &'a str,
    reload: &'a str,
    kept: &'a [(FieldName, String)],
    children: C,
) -> impl Patch {
    let (since,) = refs();
    html! {
        <corten-live
            id={id}
            src={src}
            on:connect={js::stale(scope, since, words.stale_since, words.date)}
            on:corten-status={js::stale(target, since, words.stale_since, words.date)}
        >
            <div class={Status} role="status" aria-live="polite">
                <span class={(Badge, Live)}><span class={Dot} aria-hidden="true"></span>{words.live}</span>
                <span class={(Badge, Connecting)}>{words.connecting}</span>
                <div class={Stale}>
                    <div>
                        <p ref={since} class={Title}>{&words.stale}</p>
                        <p class={Description}>{words.stale_description}</p>
                    </div>
                    if let Some(label) = words.reload {
                        <form method="get" action={reload} data-patch>
                            for (name, value) in kept {
                                <input type="hidden" name={*name} value={value.as_str()}>
                            }
                            <button type="submit" class={Reload}>{label}</button>
                        </form>
                    }
                </div>
            </div>
            {children}
        </corten-live>
    }
}
