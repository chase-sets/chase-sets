//! admin-web's `CatalogRealtimeConnectionStatus`: whether the list's stream of changes is live.
//! It sits in the list's `<corten-live>` and follows the element's `status`: Live while the stream
//! is open, Connecting before it, and a warning with Reload once it dropped. The states are CSS on
//! the element's attribute, so they need no script; the script only writes when it went stale
//! (`stale-since`), in the page's locale. Without JavaScript nothing streams, and nothing shows.
use corten::{FieldName, prelude::*};

use crate::text::Cat;

#[component(css, js)]
pub fn LiveStatus<'a>(t: Cat, reload: &'a str, kept: &'a [(FieldName, String)]) -> impl Render {
    let (since,) = refs();
    html! {
        <div
            class={Status}
            role="status"
            aria-live="polite"
            on:connect={js::watch(scope, since, signal, t.js().live_status_stale_since())}
        >
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
    }
}
