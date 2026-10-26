//! admin-web's `CatalogRealtimeConnectionStatus` around a list's `<corten-live>`: whether its stream
//! of changes is live. It draws the element, its status and then `children` (what the stream
//! redraws). Live while the stream is open, Connecting before it, and a warning with Reload once it
//! dropped: the states are CSS on the element's `status`, so they need no script. The script only
//! writes when it went stale (`stale-since`), in the page's locale, on connect and on each
//! `corten-status` the element dispatches. Without JavaScript nothing streams, and nothing shows.
use corten::{
    FieldName,
    i18n::{DateStyle, TimeStyle},
    prelude::*,
    view::AttrValue,
};

use crate::text::Cat;

#[component(css, js)]
pub fn LiveStatus<'a, I: Id + AttrValue + Copy, C: Render>(
    t: Cat,
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
            on:connect={js::stale(scope, since, t.js().live_status_stale_since(), t.js().date_time(DateStyle::Medium, TimeStyle::Short))}
            on:corten-status={js::stale(target, since, t.js().live_status_stale_since(), t.js().date_time(DateStyle::Medium, TimeStyle::Short))}
        >
            <div class={Status} role="status" aria-live="polite">
                <span class={(Badge, Live)}><span class={Dot} aria-hidden="true"></span>{t.live_status_live()}</span>
                <span class={(Badge, Connecting)}>{t.live_status_connecting()}</span>
                <div class={Stale}>
                    <div>
                        <p ref={since} class={Title}>{t.live_status_stale_since("")}</p>
                        <p class={Description}>{t.live_status_stale_description()}</p>
                    </div>
                    <form method="get" action={reload} data-patch>
                        for (name, value) in kept {
                            <input type="hidden" name={*name} value={value.as_str()}>
                        }
                        <button type="submit" class={Reload}>{t.realtime_reload()}</button>
                    </form>
                </div>
            </div>
            {children}
        </corten-live>
    }
}
