//! Add to List's dialog (marketplace's `AddToSavedListControl` sheet), shared by the item page and
//! search's results: the product, a recent Saved List or a new one, and the tracked quantity, with
//! the ids the addition is made with. Its own stylesheet, so a page that patches it in from another
//! area's handler (search, from `/items/{slug}/save`) has its rules.
use corten::prelude::*;

use crate::{
    saving::{self, SaveInput, SaveState},
    text::{ItemMsg, item_msg::SavedListSummary},
};

/// The dialog, which a search result's Add to List replaces with its answer.
#[derive(Id)]
pub struct SaveToListId;

/// The dialog's heading, the new list's title field and the tracked quantity's, and its help.
const TITLE: &str = "save-to-list-title";
const NEW_TITLE: &str = "save-title";
const QUANTITY: &str = "save-quantity";
const QUANTITY_HELP: &str = "save-quantity-help";

/// The dialog, or with no `save` the empty one a search result's Add to List fills. `input` is a
/// form drawn again (its choices, its ids, the page it came from); with it the dialog is drawn
/// `open`, so it is in front of the buyer without JavaScript, and `corten_ui::dialog::modal` makes
/// it modal when it joins the page. `message` is why the last Add Product saved nothing.
#[component(css)]
pub fn SaveDialog<'a>(
    t: ItemMsg,
    save: Option<&'a SaveState>,
    label: &'a str,
    product: &'a str,
    page: &'a [(String, String)],
    action: &'a str,
    input: Option<&'a SaveInput>,
    message: Option<&'a str>,
) -> impl Patch {
    let lists = match save {
        Some(SaveState::Ready { lists }) => Some(lists.as_slice()),
        _ => None,
    };
    let tokens = input.map_or_else(saving::Tokens::new, |i| i.tokens.clone());
    let chosen = input
        .map(|i| i.list.clone())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| lists.and_then(|l| l.first()).map_or_else(|| saving::NEW_LIST.to_owned(), |l| l.list_id.clone()));
    let typed_title = input.map_or("", |i| i.title.as_str());
    let typed_quantity = input.map(|i| i.quantity.as_str()).filter(|q| !q.is_empty()).unwrap_or("1");
    let from = input.map_or("", |i| i.from.as_str());
    html! {
        match save {
            None => <dialog id={SaveToListId} class={Dialog}></dialog>,
            Some(save) => {
                <dialog
                    class={Dialog}
                    id={SaveToListId}
                    aria-labelledby={TITLE}
                    open={input.is_some()}
                    on:connect={corten_ui::dialog::modal(target)}
                >
                    <div class={Head}>
                        <h2 class={Title} id={TITLE}>{t.saved_sheet_title()}</h2>
                        <p class={Muted}>{t.saved_sheet_description()}</p>
                    </div>
                    match save {
                        SaveState::Forbidden => {
                            <p class={Error} role="alert">{t.saved_api_account_forbidden()}</p>
                        }
                        SaveState::Ready { .. } => {
                            <form class={Form} method="post" action={action}>
                                for (name, value) in page {
                                    <input type="hidden" name={name} value={value}>
                                }
                                <input type="hidden" name={saving::field::PRODUCT} value={product}>
                                <input type="hidden" name={saving::field::ADD_COMMAND} value={&tokens.add_command}>
                                <input type="hidden" name={saving::field::LINE} value={&tokens.line}>
                                <input type="hidden" name={saving::field::NEW_LIST} value={&tokens.new_list}>
                                <input type="hidden" name={saving::field::NEW_LIST_COMMAND} value={&tokens.new_list_command}>
                                if !from.is_empty() {
                                    <input type="hidden" name={saving::field::FROM} value={from}>
                                }
                                if let Some(message) = message {
                                    <div class={Banner} role="alert">
                                        <p class={(Strong, Error)}>{t.saved_error_title()}</p>
                                        <p>{message}</p>
                                    </div>
                                }
                                <p class={Strong}>{label}</p>
                                if lists.is_some_and(<[_]>::is_empty) {
                                    <p class={Muted}>{t.saved_no_lists()}</p>
                                }
                                <fieldset class={Lists}>
                                    <legend class={Label}>{t.saved_destination_label()}</legend>
                                    for list in lists.unwrap_or_default() {
                                        <label class={Choice}>
                                            <input
                                                type="radio"
                                                name={saving::field::LIST}
                                                value={&list.list_id}
                                                checked={chosen == list.list_id}
                                            >
                                            <span>
                                                <span class={Strong}>{&list.title}</span>
                                                <span class={Muted}>
                                                    {t.saved_list_summary(SavedListSummary { lines: list.line_count, quantity: list.tracked_unit_count })}
                                                </span>
                                            </span>
                                        </label>
                                    }
                                    <label class={Choice}>
                                        <input
                                            type="radio"
                                            name={saving::field::LIST}
                                            value={saving::NEW_LIST}
                                            checked={chosen == saving::NEW_LIST}
                                        >
                                        <span>
                                            <span class={Strong}>{t.saved_create_new()}</span>
                                            <span class={Muted}>{t.saved_create_new_description()}</span>
                                        </span>
                                    </label>
                                </fieldset>
                                <div class={(Field, NewTitle)}>
                                    <label class={Label} for={NEW_TITLE}>{t.saved_title_label()}</label>
                                    <input
                                        id={NEW_TITLE}
                                        type="text"
                                        name={saving::field::TITLE}
                                        maxlength="120"
                                        placeholder={t.saved_title_placeholder()}
                                        value={typed_title}
                                    >
                                </div>
                                <div class={Field}>
                                    <label class={Label} for={QUANTITY}>{t.saved_quantity_label()}</label>
                                    <input
                                        id={QUANTITY}
                                        class={Quantity}
                                        type="number"
                                        name={saving::field::QUANTITY}
                                        min="1"
                                        max="1000000"
                                        step="1"
                                        inputmode="numeric"
                                        required
                                        aria-describedby={QUANTITY_HELP}
                                        value={typed_quantity}
                                    >
                                    <p class={Muted} id={QUANTITY_HELP}>{t.saved_quantity_description()}</p>
                                </div>
                                <div class={Actions}>
                                    <button type="button" class={Button} command="close" commandfor={SaveToListId}>
                                        {t.saved_cancel()}
                                    </button>
                                    <button type="submit" class={(Button, Primary)}>{t.saved_submit()}</button>
                                </div>
                            </form>
                        }
                        _ => {
                            <div class={Banner} role="alert">
                                <p class={(Strong, Error)}>{t.saved_error_title()}</p>
                                <p>{t.saved_error_description()}</p>
                            </div>
                        }
                    }
                    if !matches!(save, SaveState::Ready { .. }) {
                        <div class={Actions}>
                            <button type="button" class={Button} command="close" commandfor={SaveToListId}>
                                {t.saved_cancel()}
                            </button>
                        </div>
                    }
                </dialog>
            }
        }
    }
}
