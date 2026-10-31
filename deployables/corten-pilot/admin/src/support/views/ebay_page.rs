//! eBay Deletion Lookup (`EbayAccountDeletionLookupPage`): the user ID form, the banner when the
//! lookup or the counts failed, the unexpired receipts (a table that scrolls on its own on a phone),
//! and Production's subject data counts with the save warning.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    support::ebay::{EbayScreen, MAX_USER_ID, url},
    text::Sup,
};

/// A receipt's time, as admin-web shows it (the API's instant) when it cannot be read.
fn when(t: Sup, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string())
}

#[component(css)]
pub fn EbayPage<'a>(t: Sup, screen: &'a EbayScreen) -> impl Render {
    let f = crate::support::ebay::LookupForm::FIELDS;
    html! {
        <header class={Header}>
            <h1>{t.ebay_title()}</h1>
            <p class={Muted}>{t.ebay_description()}</p>
        </header>
        <section class={Part}>
            <h2 class={Heading}>{t.ebay_lookup()}</h2>
            <form class={Search} method="post" action={url::Lookup}>
                <label class={Field}>
                    <span>{t.ebay_user_id()}</span>
                    <input type="text" name={f.user_id} required autocomplete="off" spellcheck="false" maxlength={MAX_USER_ID}>
                </label>
                <button type="submit" class={Button}>{t.ebay_lookup()}</button>
            </form>
        </section>
        if screen.failed {
            <p class={Alert} role="alert">{t.ebay_error()}</p>
        }
        if let Some(matches) = &screen.matches {
            <section class={Part}>
                <h2 class={Heading}>{t.ebay_receipts()}</h2>
                if matches.is_empty() {
                    <div class={Empty}>
                        <p class={EmptyTitle}>{t.ebay_empty()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table} aria-label={t.ebay_receipts()}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.ebay_notification()}</th>
                                    <th scope="col">{t.ebay_event_date()}</th>
                                    <th scope="col">{t.ebay_expires_at()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for receipt in matches {
                                    <tr>
                                        <td class={Words}>{&receipt.notification_id}</td>
                                        <td>{when(t, &receipt.event_date)}</td>
                                        <td>{when(t, &receipt.expires_at)}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
        }
        if let Some(counts) = &screen.counts {
            <section class={Part}>
                <h2 class={Heading}>{t.ebay_count_title()}</h2>
                <p>{t.ebay_counts(counts.connections, counts.credential_envelopes)}</p>
                <p class={Muted}>{t.ebay_save_warning()}</p>
            </section>
        }
    }
}
