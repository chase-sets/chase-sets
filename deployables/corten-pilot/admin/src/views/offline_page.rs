//! admin-web's offline page (`routes/offline.tsx`, a narrow `Page` with an `EmptyState`): that
//! admin is offline, why, and Try again. The service worker answers a navigation it cannot make
//! with this page under the address asked for, so Try again is a link to that address (`href=""`):
//! it loads it again with or without a script, where admin-web's button calls `location.reload()`.
use corten::prelude::*;

use crate::text::SiteMsg;

#[component(css)]
pub fn OfflinePage(t: SiteMsg) -> impl Render {
    html! {
        <div class={Empty}>
            <h1 class={Title}>{t.offline_heading()}</h1>
            <p class={Muted}>{t.offline_description()}</p>
            <a class={Retry} href="">{t.offline_retry()}</a>
        </div>
    }
}
