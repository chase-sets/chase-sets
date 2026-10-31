//! Reference Lookup (`SupportReferenceLookupPage`): the search box, then the record a reference
//! names (its summary, owning context, type, reference and status, each label above its value on
//! a phone and beside it from 40rem) with a link to its admin page, "no record" when there is
//! none, or the error banner when the lookup failed.
use corten::prelude::*;

use crate::{support::LookupScreen, text::Sup};

#[component(css)]
pub fn LookupPage<'a>(t: Sup, screen: &'a LookupScreen) -> impl Render {
    html! {
        <header class={Header}>
            <h1>{t.lookup_title()}</h1>
            <p class={Muted}>{t.lookup_description()}</p>
        </header>
        <section class={Part}>
            <h2 class={Heading}>{t.lookup_search_title()}</h2>
            <p class={Muted}>{t.lookup_search_description()}</p>
            <form class={Search} method="get" action={crate::support::url::Lookup::default()}>
                <label class={Field}>
                    <span>{t.lookup_search_label()}</span>
                    <input
                        type="search"
                        name="reference"
                        value={&screen.query}
                        placeholder={t.lookup_search_placeholder()}
                        autocomplete="off"
                        spellcheck="false"
                        required
                        autofocus
                    />
                </label>
                <button type="submit" class={Button}>{t.lookup_search_submit()}</button>
            </form>
        </section>
        if screen.failed {
            <p class={Alert} role="alert"><strong>{t.lookup_error()}</strong> {t.lookup_route_request_failed()}</p>
        } else if screen.searched {
            <section class={Part}>
                <h2 class={Heading}>{t.lookup_result_title()}</h2>
                if let Some(found) = &screen.found {
                    <div class={Card}>
                        <dl class={Rows}>
                            <div>
                                <dt>{t.lookup_result_summary()}</dt>
                                <dd>{&found.summary}</dd>
                            </div>
                            <div>
                                <dt>{t.lookup_result_context()}</dt>
                                <dd>{&found.context_name}</dd>
                            </div>
                            <div>
                                <dt>{t.lookup_result_entity_type()}</dt>
                                <dd>{&found.entity_type}</dd>
                            </div>
                            <div>
                                <dt>{t.lookup_result_display_reference()}</dt>
                                <dd>{found.display_reference.as_deref().unwrap_or(t.lookup_result_not_applicable())}</dd>
                            </div>
                            if let Some(status) = &found.status {
                                <div>
                                    <dt>{t.lookup_result_status()}</dt>
                                    <dd><span class={Pill}>{status}</span></dd>
                                </div>
                            }
                        </dl>
                        if let Some(href) = &screen.href {
                            <a class={Button} href={href}>{t.lookup_result_open()}</a>
                        }
                    </div>
                } else {
                    <div class={Empty}>
                        <p class={EmptyTitle}>{t.lookup_not_found_title()}</p>
                        <p class={Muted}>{t.lookup_not_found_description(&screen.query)}</p>
                    </div>
                }
            </section>
        }
    }
}
