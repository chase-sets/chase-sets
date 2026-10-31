//! Promo Bar (`PromoBarAdminPage`). Top to bottom: the header, what the last write did, the public
//! preview of the messages live now, Create message, and the messages with their status and
//! actions, which scroll on their own on a phone. Edit opens a sheet and Delete a confirmation, each
//! an open `<dialog>` closed by a link back to the page; corten-ui's dialog makes it modal with
//! JavaScript. Every write is a plain post.
use corten::prelude::*;
use jiff::Timestamp;

use crate::{
    growth::promo::{Message, MessageForm, PromoScreen, Status, TONES, url},
    text::Gro,
};

/// The open sheet's title, which names it.
#[derive(Id)]
pub struct PromoSheetTitleId;

/// A preview link as admin-web resolves it (`resolveAdminPreviewHref`): a marketplace path on the
/// marketplace's origin, and no link when that origin is unknown.
pub fn preview_href(href: Option<&str>, marketplace: Option<&str>) -> Option<String> {
    let href = href?;
    if !href.starts_with('/') {
        return Some(href.to_owned());
    }
    marketplace.map(|origin| format!("{}{href}", origin.trim_end_matches('/')))
}

fn status_words(t: Gro, status: Status) -> &'static str {
    match status {
        Status::Active => t.promo_status_active(),
        Status::Scheduled => t.promo_status_scheduled(),
        Status::Expired => t.promo_status_expired(),
        Status::Inactive => t.promo_status_inactive(),
    }
}

fn tone_words(t: Gro, tone: &str) -> &'static str {
    match tone {
        "success" => t.promo_tone_success(),
        "warning" => t.promo_tone_warning(),
        _ => t.promo_tone_info(),
    }
}

fn done_words(t: Gro, done: &str) -> &'static str {
    match done {
        "created" => t.promo_action_created(),
        "updated" => t.promo_action_updated(),
        "activated" => t.promo_action_activated(),
        "deactivated" => t.promo_action_deactivated(),
        _ => t.promo_action_deleted(),
    }
}

/// A message's fields (`PromoBarMessageFields`): one column on a phone, two from 40rem, four from 80rem.
#[component(css = PromoPage)]
fn PromoFields<'a>(t: Gro, form: &'a MessageForm) -> impl Render {
    let f = MessageForm::FIELDS;
    html! {
        <div class={Fields}>
            <label class={Field}>
                <span>{t.promo_field_title()}</span>
                <input type="text" name={f.title} value={&form.title} required>
            </label>
            <label class={Field}>
                <span>{t.promo_field_href()}</span>
                <input type="text" name={f.href} value={&form.href} placeholder="/sales-fees">
            </label>
            <label class={Field}>
                <span>{t.promo_field_link_label()}</span>
                <input type="text" name={f.link_label} value={&form.link_label}>
            </label>
            <label class={Field}>
                <span>{t.promo_field_tone()}</span>
                <select name={f.tone}>
                    for tone in TONES {
                        <option value={tone} selected={form.tone == tone}>{tone_words(t, tone)}</option>
                    }
                </select>
            </label>
            <label class={Field}>
                <span>{t.promo_field_description()}</span>
                <textarea name={f.description} rows="3">{&form.description}</textarea>
            </label>
            <label class={Field}>
                <span>{t.promo_field_display_order()}</span>
                <input type="number" name={f.display_order} value={&form.display_order}>
            </label>
            <label class={Field}>
                <span>{t.promo_field_starts_at()}</span>
                <input type="datetime-local" name={f.starts_at} value={&form.starts_at}>
            </label>
            <label class={Field}>
                <span>{t.promo_field_ends_at()}</span>
                <input type="datetime-local" name={f.ends_at} value={&form.ends_at}>
            </label>
            <label class={Check}>
                <input type="checkbox" name={f.is_active} value="true" checked={form.is_active == "true"}>
                <span>{t.promo_field_active()}</span>
            </label>
        </div>
    }
}

/// A sheet or confirmation over the page, closed by a link back to it.
#[component(css = PromoPage)]
fn PromoSheet<'a, C: Render>(
    title: &'a str,
    description: Option<&'a str>,
    close: &'a str,
    confirm: bool,
    children: C,
) -> impl Render {
    let back = refs();
    let page = url::Promo::default().href();
    html! {
        <dialog
            class={if confirm { Confirm } else { Drawer }}
            open
            role={if confirm { "alertdialog" } else { "dialog" }}
            aria-labelledby={PromoSheetTitleId}
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <header class={Head}>
                <div>
                    <h2 id={PromoSheetTitleId} class={Words}>{title}</h2>
                    if let Some(description) = description {
                        <p class={Words}>{description}</p>
                    }
                </div>
                <a ref={back} class={Close} href={&page} aria-label={close}>"\u{d7}"</a>
            </header>
            {children}
        </dialog>
    }
}

/// A message's row actions (`PromoBarRowActions`).
#[component(css = PromoPage)]
fn RowActions<'a>(t: Gro, message: &'a Message) -> impl Render {
    let f = MessageForm::FIELDS;
    let open = |edit: bool| url::Promo {
        open: url::Open {
            edit: edit.then(|| message.id.clone()),
            delete: (!edit).then(|| message.id.clone()),
            ..url::Open::default()
        },
    };
    html! {
        <div class={Actions}>
            <form method="post">
                <input type="hidden" name={f.id} value={&message.id}>
                <button
                    type="submit"
                    class={(Button, Secondary, Small)}
                    name={f.intent}
                    value={if message.is_active { "deactivate" } else { "activate" }}
                >
                    {if message.is_active { t.promo_deactivate_action() } else { t.promo_activate_action() }}
                </button>
            </form>
            <a class={(Button, Secondary, Small)} href={open(true)}>{t.promo_edit_action()}</a>
            <a class={(Button, Danger, Small)} href={open(false)}>{t.promo_delete_action()}</a>
        </div>
    }
}

/// The public preview (`PromoBar`): the messages live now, each in its tone.
#[component(css = PromoPage)]
fn Preview<'a>(messages: Vec<&'a Message>, marketplace: Option<&'a str>) -> impl Render {
    html! {
        if !messages.is_empty() {
            <ul class={Bars}>
                for message in messages {
                    <li class={Bar} data-tone={TONES.iter().find(|t| **t == message.tone).copied().unwrap_or("info")}>
                        <div class={Words}>
                            <p class={Strong}>{&message.title}</p>
                            if let Some(description) = &message.description {
                                <p class={Muted}>{description}</p>
                            }
                        </div>
                        if let (Some(href), Some(label)) = (preview_href(message.href.as_deref(), marketplace), &message.link_label) {
                            <a class={(Button, Secondary, Small)} href={href}>{label}</a>
                        }
                    </li>
                }
            </ul>
        }
    }
}

#[component(css)]
pub fn PromoPage<'a>(t: Gro, screen: &'a PromoScreen, marketplace: Option<&'a str>) -> impl Render {
    let f = MessageForm::FIELDS;
    let now: Timestamp = screen.now;
    let live: Vec<&Message> = screen.messages.iter().filter(|m| m.status(now) == Status::Active).collect();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.promo_admin_eyebrow()}</p>
                <h1>{t.promo_admin_title()}</h1>
                <p class={Muted}>{t.promo_admin_description()}</p>
            </header>
            if let Some(error) = &screen.error {
                <div class={Alert} role="alert">
                    <p class={Strong}>{t.promo_action_failed()}</p>
                    <p>{error}</p>
                </div>
            } else if let Some(done) = &screen.done {
                <p class={Done} role="status">{done_words(t, done)}</p>
            }
            <section class={Card} aria-labelledby="pb-preview">
                <div>
                    <h2 class={Heading} id="pb-preview">{t.promo_preview_title()}</h2>
                    <p class={Muted}>{t.promo_preview_description()}</p>
                </div>
                <Preview messages={live} marketplace={marketplace} />
            </section>
            <section class={Card} aria-labelledby="pb-create">
                <h2 class={Heading} id="pb-create">{t.promo_create_title()}</h2>
                <form class={Form} method="post">
                    <input type="hidden" name={f.intent} value="create">
                    <PromoFields t={t} form={&screen.create} />
                    <button type="submit" class={Button}>{t.promo_create_action()}</button>
                </form>
            </section>
            <section class={Card} aria-labelledby="pb-messages">
                <h2 class={Heading} id="pb-messages">{t.promo_messages_title()}</h2>
                if screen.messages.is_empty() {
                    <div class={Nothing}>
                        <p class={Strong}>{t.promo_empty_title()}</p>
                        <p class={Muted}>{t.promo_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.promo_column_status()}</th>
                                    <th scope="col">{t.promo_column_message()}</th>
                                    <th scope="col">{t.promo_column_order()}</th>
                                    <th scope="col">{t.promo_column_actions()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for message in &screen.messages {
                                    <tr>
                                        <td>
                                            <span class={Pill} data-status={format!("{:?}", message.status(now)).to_lowercase()}>
                                                {status_words(t, message.status(now))}
                                            </span>
                                        </td>
                                        <td class={Words}>
                                            <p class={Strong}>{&message.title}</p>
                                            if let Some(description) = &message.description {
                                                <p class={Muted}>{description}</p>
                                            }
                                        </td>
                                        <td>{t.number(message.display_order).to_string()}</td>
                                        <td><RowActions t={t} message={message} /></td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            if let Some(form) = &screen.edit {
                <PromoSheet
                    title={t.promo_edit_title()}
                    description={Some(form.title.as_str())}
                    close={t.promo_cancel_action()}
                    confirm={false}
                >
                    <form class={Form} method="post">
                        <input type="hidden" name={f.intent} value="update">
                        <input type="hidden" name={f.id} value={&form.id}>
                        <PromoFields t={t} form={form} />
                        <button type="submit" class={Button}>{t.promo_update_action()}</button>
                    </form>
                </PromoSheet>
            } else if let Some(message) = &screen.delete {
                <PromoSheet
                    title={t.promo_delete_confirm_title()}
                    description={Some(t.promo_delete_confirm_description(&message.title).to_string().as_str())}
                    close={t.promo_cancel_action()}
                    confirm={true}
                >
                    <form class={Actions} method="post">
                        <input type="hidden" name={f.intent} value="delete">
                        <input type="hidden" name={f.id} value={&message.id}>
                        <button type="submit" class={(Button, Danger)}>{t.promo_delete_action()}</button>
                        <a class={(Button, Secondary)} href={url::Promo::default()}>{t.promo_cancel_action()}</a>
                    </form>
                </PromoSheet>
            }
        </div>
    }
}
