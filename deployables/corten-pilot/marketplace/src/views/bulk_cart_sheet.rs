//! Add matching products to Buy Cart's sheet (marketplace's `CommerceSheet` on the search page):
//! what the add would put in the cart, or what it came to, and Add eligible products. The search
//! page draws it empty, and the preview's answer replaces it (`bulk_cart`); without JavaScript the
//! search page is drawn with it open.
use corten::prelude::*;

use crate::{
    app::url,
    bulk_cart::{BulkFields, NotAdded, Sheet},
    buying::cart_href,
    text::{
        SearchMsg,
        search_msg::{PageBulkAddedSummary, PageBulkFailedLine, PageBulkPreviewDescription},
    },
};

/// The sheet, which the preview's answer replaces.
#[derive(Id)]
pub struct BulkCartId;

/// The sheet's heading, and the heading of an add that did not settle.
const TITLE: &str = "bulk-cart-title";
const RESULT: &str = "search-bulk-add-result";
/// The skipped results the sheet names (marketplace's `skippedItems.slice(0, 3)`).
const SKIPPED_NAMED: usize = 3;

/// The sheet, or with no `sheet` the empty one the preview fills. `pairs` are the search's
/// parameters its forms send again. Drawn `open`, so it is in
/// front of the buyer without JavaScript, and `corten_ui::dialog::modal` makes it modal when it
/// joins the page.
#[component(css)]
pub fn BulkCartSheet<'a>(t: SearchMsg, sheet: Option<&'a Sheet>, pairs: &'a [(String, String)]) -> impl Patch {
    let action = url::SearchCart.href();
    let preview = sheet.and_then(Sheet::preview);
    let partial = match sheet {
        Some(Sheet::Partial { added, merged, not_added, .. }) => Some((*added, *merged, not_added.as_slice())),
        _ => None,
    };
    let unsettled = match sheet {
        Some(Sheet::Ambiguous { attempt, .. }) => {
            Some((t.page_bulk_ambiguous_title(), t.page_bulk_ambiguous_description().to_owned(), Some(attempt.as_str())))
        }
        Some(Sheet::NotApplied { message, .. }) => Some((
            t.page_bulk_not_applied_title(),
            message.clone().unwrap_or_else(|| t.page_bulk_not_applied_description().to_owned()),
            None,
        )),
        _ => None,
    };
    let can_add = sheet.is_some_and(Sheet::can_add);
    let cart = cart_href("");
    let skipped =
        preview.map(|p| p.skipped_items.iter().take(SKIPPED_NAMED).map(|s| s.message.as_str()).collect::<Vec<_>>().join(" "));
    html! {
        match sheet {
            None => <dialog id={BulkCartId} class={Dialog}></dialog>,
            Some(sheet) => {
                <dialog class={Dialog} id={BulkCartId} aria-labelledby={TITLE} open on:connect={corten_ui::dialog::modal(target)}>
                    <div class={Head}>
                        <h2 class={Title} id={TITLE}>
                            if partial.is_some() { {t.page_bulk_added_title()} } else { {t.page_bulk_preview_title()} }
                        </h2>
                        if let Some(p) = preview {
                            <p class={Muted}>
                                {t.page_bulk_preview_description(PageBulkPreviewDescription { eligible: p.eligible_count, skipped: p.skipped_count })}
                            </p>
                        }
                    </div>
                    if matches!(sheet, Sheet::Failed) {
                        <div class={Banner} data-tone="danger" role="alert">
                            <p class={Strong}>{t.page_bulk_error_title()}</p>
                            <p>{t.page_bulk_error_description()}</p>
                        </div>
                    }
                    if let Some(p) = preview.filter(|p| p.over_limit) {
                        <div class={Banner} data-tone="warning" role="status">
                            <p class={Strong}>{t.page_bulk_over_limit_title()}</p>
                            <p>{t.page_bulk_over_limit_description(p.limit)}</p>
                        </div>
                    }
                    if let Some((title, text, resend)) = &unsettled {
                        <div class={Result}>
                            <h3 class={Subtitle} id={RESULT}>{*title}</h3>
                            <p class={Muted} role="alert">{text}</p>
                            if let Some(attempt) = resend {
                                <form class={Actions} method="post" action={&action} data-patch>
                                    for (name, value) in pairs {
                                        <input type="hidden" name={name} value={value}>
                                    }
                                    <input type="hidden" name={BulkFields::FIELDS.attempt} value={*attempt}>
                                    <button type="submit" class={Button}>{t.page_bulk_resend()}</button>
                                    <a class={Button} href={&cart}>{t.page_review_cart()}</a>
                                </form>
                            }
                        </div>
                    }
                    if let Some((added, merged, not_added)) = partial {
                        <NotAddedLines t={t} lines={not_added} />
                        <div class={Banner} data-tone={if not_added.is_empty() { "success" } else { "warning" }} role="status">
                            <p class={Strong}>{t.page_bulk_added_summary(PageBulkAddedSummary { added, merged })}</p>
                            <p>{t.page_bulk_added_description(not_added.len())}</p>
                        </div>
                    }
                    if let Some(p) = preview {
                        <dl class={Stats}>
                            <div>
                                <dt>{t.page_bulk_matches()}</dt>
                                <dd>{p.total_matches.unwrap_or(p.eligible_count + p.skipped_count)}</dd>
                            </div>
                            <div>
                                <dt>{t.page_bulk_ready()}</dt>
                                <dd>{p.eligible_count}</dd>
                            </div>
                            <div>
                                <dt>{t.page_bulk_need_options()}</dt>
                                <dd>{p.skipped_count}</dd>
                            </div>
                        </dl>
                    }
                    if let Some(skipped) = skipped.as_deref().filter(|s| !s.is_empty()) {
                        <div class={Banner} data-tone="info">
                            <p class={Strong}>{t.page_bulk_skipped_title()}</p>
                            <p>{skipped}</p>
                        </div>
                    }
                    <div class={Actions}>
                        <button type="button" class={Button} command="close" commandfor={BulkCartId}>{t.page_close()}</button>
                        if partial.is_some() {
                            <a class={(Button, Primary)} href={&cart}>{t.page_review_cart()}</a>
                        } else if preview.is_some() && unsettled.as_ref().is_none_or(|(_, _, resend)| resend.is_none()) {
                            <form class={Add} method="post" action={&action} data-patch>
                                {SubmitKey::field(BulkFields::FIELDS.attempt)}
                                for (name, value) in pairs {
                                    <input type="hidden" name={name} value={value}>
                                }
                                <button type="submit" class={(Button, Primary)} disabled={!can_add}>
                                    {t.page_add_eligible_products()}
                                </button>
                            </form>
                        }
                    </div>
                </dialog>
            }
        }
    }
}

/// Each line the add did not put in the cart, with the API's reason.
#[component(css = BulkCartSheet)]
fn NotAddedLines<'a>(t: SearchMsg, lines: &'a [NotAdded]) -> impl Render {
    html! {
        if !lines.is_empty() {
            <ul class={Lines}>
                for line in lines {
                    <li>
                        if let Some(message) = &line.message {
                            {t.page_bulk_failed_line(PageBulkFailedLine { title: &line.title, message })}
                        } else {
                            {&line.title}
                        }
                    </li>
                }
            </ul>
        }
    }
}
