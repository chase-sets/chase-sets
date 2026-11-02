//! Platform Feedback's pages. The queue (`PlatformFeedbackAdminListPage`): its four counts, the
//! filters with Export CSV, and the review queue as one form, a box on each row and its two bulk
//! buttons above, in a table that scrolls on its own on a phone. A feedback's page
//! (`PlatformFeedbackAdminDetailPage`): Back, Mark reviewed and Archive, the feedback beside its
//! notes, attribution and related records from 64rem, stacked below that. No script.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    support::feedback::{BulkForm, Entry, ItemForm, ItemScreen, ListScreen, STATUSES, TOPICS, WORKFLOWS, url},
    text::{Pilot, Sup},
};

/// A topic's words, else the topic as it is (admin-web's `topicLabel`).
pub fn topic(t: Sup, value: &str) -> String {
    match value {
        "ease-of-use" => t.fb_topic_ease_of_use(),
        "pricing-fees" => t.fb_topic_pricing_fees(),
        "product-data-search" => t.fb_topic_product_data_search(),
        "checkout-payment" => t.fb_topic_checkout_payment(),
        "selling-inventory" => t.fb_topic_selling_inventory(),
        "performance-reliability" => t.fb_topic_performance_reliability(),
        "other" => t.fb_topic_other(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A workflow's words, else the workflow as it is.
pub fn workflow(t: Sup, value: &str) -> String {
    match value {
        "checkout-payment" => t.fb_workflow_checkout_payment(),
        "listing-publish" => t.fb_workflow_listing_publish(),
        "listing-update" => t.fb_workflow_listing_update(),
        "offer-submit" => t.fb_workflow_offer_submit(),
        "offer-accept" => t.fb_workflow_offer_accept(),
        "inventory-create" => t.fb_workflow_inventory_create(),
        "inventory-adjust" => t.fb_workflow_inventory_adjust(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A status's words, else the status as it is.
pub fn status(t: Sup, value: &str) -> String {
    match value {
        "new" => t.fb_status_new(),
        "reviewed" => t.fb_status_reviewed(),
        "archived" => t.fb_status_archived(),
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A time the API sent, as admin-web's `formatDateTime` writes it, else "Not set".
fn when(t: Sup, at: Option<&str>) -> String {
    at.and_then(parse_timestamp)
        .map_or_else(|| t.fb_not_set().to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A status's pill (`statusTone`).
#[component(css = FeedbackPage)]
fn StatusPill<'a>(t: Sup, value: &'a str) -> impl Render {
    let words = status(t, value);
    html! {
        match value {
            "new" => <span class={(Pill, Accent)}>{&words}</span>,
            "reviewed" => <span class={(Pill, Success)}>{&words}</span>,
            _ => <span class={(Pill, Neutral)}>{&words}</span>,
        }
    }
}

/// A rating as five stars (admin-web's `Rating`), and as a number, which admin-web's stars do not
/// say to a screen reader (chase-sets/chase-sets#10848).
#[component(css = FeedbackPage)]
fn Stars(value: u8) -> impl Render {
    let filled = usize::from(value.min(5));
    html! {
        <span class={Rating}>
            <span class={Star} aria-hidden="true">
                {format!("{}{}", "\u{2605}".repeat(filled), "\u{2606}".repeat(5 - filled))}
            </span>
            <span>{format!("{value}/5")}</span>
        </span>
    }
}

#[component(css)]
pub fn FeedbackPage<'a>(t: Sup, p: Pilot, screen: &'a ListScreen) -> impl Render {
    let f = url::Filters::FIELDS;
    let b = BulkForm::FIELDS;
    let chosen = &screen.filters;
    let status_now = chosen.status.as_deref().unwrap_or("all");
    let topic_now = chosen.topic.as_deref().unwrap_or("all");
    let workflow_now = chosen.workflow.as_deref().unwrap_or("all");
    let here = url::Feedback { filters: chosen.filters(), after_write: None };
    let export = url::Export { filters: chosen.filters() };
    let m = &screen.metrics;
    html! {
        <crate::views::PageHeader eyebrow={t.fb_eyebrow()} title={t.fb_title()} description={t.fb_description()} />
        if let Some(refusal) = &screen.refusal {
            <p class={Alert} role="alert">{refusal}</p>
        }
        if screen.catching_up {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        <dl class={Stats}>
            <div class={Stat}>
                <dt>{t.fb_total()}</dt>
                <dd>{m.total_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.fb_new()}</dt>
                <dd>{m.new_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.fb_reviewed()}</dt>
                <dd>{m.reviewed_count}</dd>
            </div>
            <div class={Stat}>
                <dt>{t.fb_average_rating()}</dt>
                <dd>{m.average_rating.as_deref().unwrap_or(t.fb_not_set())}</dd>
            </div>
        </dl>
        <section class={Part}>
            <h2 class={Heading}>{t.fb_filters()}</h2>
            <form class={Filters} method="get" action={url::Feedback::default()}>
                <label class={Field}>
                    <span>{t.fb_status()}</span>
                    <select name={f.status}>
                        <option value="all" selected={status_now == "all"}>{t.fb_all_statuses()}</option>
                        for value in STATUSES {
                            <option value={value} selected={value == status_now}>{status(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.fb_topic()}</span>
                    <select name={f.topic}>
                        <option value="all" selected={topic_now == "all"}>{t.fb_all_topics()}</option>
                        for value in TOPICS {
                            <option value={value} selected={value == topic_now}>{topic(t, value)}</option>
                        }
                    </select>
                </label>
                <label class={Field}>
                    <span>{t.fb_workflow()}</span>
                    <select name={f.workflow}>
                        <option value="all" selected={workflow_now == "all"}>{t.fb_all_workflows()}</option>
                        for value in WORKFLOWS {
                            <option value={value} selected={value == workflow_now}>{workflow(t, value)}</option>
                        }
                    </select>
                </label>
                <div class={Actions}>
                    <button type="submit" class={Button}>{t.fb_apply_filters()}</button>
                    if screen.can_export {
                        <a class={(Button, Secondary)} href={&export}>{t.fb_export()}</a>
                    }
                </div>
            </form>
        </section>
        <section class={Part}>
            <h2 class={Heading}>{t.fb_review_queue()}</h2>
            if screen.entries.items.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{t.fb_empty_title()}</p>
                    <p class={Muted}>{t.fb_empty_description()}</p>
                </div>
            } else {
                <form class={Queue} method="post" action={&here}>
                    if screen.can_manage {
                        <div class={Actions}>
                            <button type="submit" class={Button} name={b.intent} value="bulk-review">{t.fb_bulk_review()}</button>
                            <button type="submit" class={(Button, Secondary)} name={b.intent} value="bulk-archive">
                                {t.fb_bulk_archive()}
                            </button>
                        </div>
                    }
                    <div class={Scroll}>
                        <table class={Table} aria-label={t.fb_review_queue()}>
                            <thead>
                                <tr>
                                    if screen.can_manage {
                                        <th scope="col"><span class={Hidden}>{p.bulk_select_all()}</span></th>
                                    }
                                    <th scope="col">{t.fb_submitted()}</th>
                                    <th scope="col">{t.fb_rating()}</th>
                                    <th scope="col">{t.fb_topic()}</th>
                                    <th scope="col">{t.fb_workflow()}</th>
                                    <th scope="col">{t.fb_status()}</th>
                                    <th scope="col">{t.fb_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for entry in &screen.entries.items {
                                    <Row t={t} p={p} entry={entry} select={screen.can_manage} field={b.feedback_ids} />
                                }
                            </tbody>
                        </table>
                    </div>
                </form>
            }
            <p class={Muted}>{t.fb_count_summary(screen.entries.count, screen.entries.total)}</p>
        </section>
    }
}

/// A row of the queue, with its box when the viewer may change it.
#[component(css = FeedbackPage)]
fn Row<'a>(t: Sup, p: Pilot, entry: &'a Entry, select: bool, field: corten::FieldName<String>) -> impl Render {
    let label = p.bulk_select_row(&entry.feedback_id).to_string();
    html! {
        <tr>
            if select {
                <td class={Pick}>
                    <input type="checkbox" class={Box} name={field} value={&entry.feedback_id} aria-label={&label}>
                </td>
            }
            <td>{when(t, Some(&entry.submitted_at))}</td>
            <td><Stars value={entry.rating} /></td>
            <td>{topic(t, &entry.topic)}</td>
            <td>{workflow(t, &entry.workflow)}</td>
            <td><StatusPill t={t} value={&entry.status} /></td>
            <td>
                <a class={Open} href={url::Item { id: &entry.feedback_id, after_write: None }}>{t.fb_open()}</a>
            </td>
        </tr>
    }
}

/// A fact of the feedback.
#[component(css = FeedbackPage)]
fn Fact<'a>(label: &'a str, value: &'a str) -> impl Render {
    html! {
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    }
}

#[component(css = FeedbackPage)]
pub fn FeedbackItemPage<'a>(t: Sup, p: Pilot, screen: &'a ItemScreen) -> impl Render {
    let entry = &screen.entry;
    let f = ItemForm::FIELDS;
    let here = url::Item { id: &entry.feedback_id, after_write: None };
    let follow_up = if entry.follow_up_consent { t.fb_yes() } else { t.fb_no() };
    html! {
        let title = t.fb_detail_title(&entry.feedback_id).to_string();
        <crate::views::PageHeader eyebrow={t.fb_eyebrow()} title={&title} description={t.fb_detail_description()} />
        <div class={Links}>
            <a class={(Button, Secondary)} href={url::Feedback::default()}>{t.fb_back()}</a>
            if screen.can_manage && entry.status == "new" {
                <form method="post" action={&here}>
                    <button type="submit" class={Button} name={f.intent} value="review">{t.fb_mark_reviewed()}</button>
                </form>
            }
            if screen.can_manage && entry.status != "archived" {
                <form method="post" action={&here}>
                    <button type="submit" class={(Button, Secondary)} name={f.intent} value="archive">{t.fb_archive()}</button>
                </form>
            }
        </div>
        if let Some(refusal) = &screen.refusal {
            <p class={Alert} role="alert">{refusal}</p>
        }
        if screen.catching_up {
            <p class={Note} role="status">{p.error_pending()}</p>
        }
        <div class={Panels}>
            <section class={Panel}>
                <h2 class={Heading}>{t.fb_feedback()}</h2>
                <p class={Inline}>
                    <StatusPill t={t} value={&entry.status} />
                    <Stars value={entry.rating} />
                </p>
                <dl class={Facts}>
                    <Fact label={t.fb_topic()} value={&topic(t, &entry.topic)} />
                    <Fact label={t.fb_workflow()} value={&workflow(t, &entry.workflow)} />
                    <Fact label={t.fb_follow_up()} value={follow_up} />
                    <Fact label={t.fb_source_route()} value={&entry.source_route_path} />
                    <Fact label={t.fb_submitted()} value={&when(t, Some(&entry.submitted_at))} />
                </dl>
                <p class={(Comment, Words)}>{entry.comment.as_deref().unwrap_or(t.fb_no_comment())}</p>
            </section>
            <div class={Column}>
                <section class={Panel}>
                    <h2 class={Heading}>{t.fb_operator_notes()}</h2>
                    if screen.can_manage {
                        <form class={NoteForm} method="post" action={&here}>
                            <label class={Field}>
                                <span>{t.fb_operator_note()}</span>
                                <textarea name={f.body} rows="4" required>{&screen.note}</textarea>
                            </label>
                            <button type="submit" class={Button} name={f.intent} value="record-note">{t.fb_record_note()}</button>
                        </form>
                    }
                    if entry.operator_notes.is_empty() {
                        <p class={Muted}>{t.fb_no_operator_notes()}</p>
                    } else {
                        <ul class={Notes}>
                            for note in &entry.operator_notes {
                                <li class={NoteCard}>
                                    <p class={Words}>{&note.body}</p>
                                    <p class={Muted}>
                                        {t.fb_operator_note_attribution(&note.recorded_by_user_id, &when(t, Some(&note.recorded_at)))}
                                    </p>
                                </li>
                            }
                        </ul>
                    }
                </section>
                <section class={Panel}>
                    <h2 class={Heading}>{t.fb_attribution()}</h2>
                    <dl class={Facts}>
                        <Fact label={t.fb_user()} value={&entry.user_id} />
                        <Fact label={t.fb_account()} value={&entry.account_id} />
                        <Fact label={t.fb_updated()} value={&when(t, Some(&entry.updated_at))} />
                        <Fact label={t.fb_reviewed_by()} value={entry.reviewed_by_user_id.as_deref().unwrap_or(t.fb_not_set())} />
                        <Fact label={t.fb_archived_by()} value={entry.archived_by_user_id.as_deref().unwrap_or(t.fb_not_set())} />
                    </dl>
                </section>
                <section class={Panel}>
                    <h2 class={Heading}>{t.fb_related_entities()}</h2>
                    if screen.related.is_empty() {
                        <p class={Muted}>{t.fb_no_related_entities()}</p>
                    } else {
                        <ul class={Related}>
                            for (entity, href) in &screen.related {
                                let label = t.fb_related_entity_label(&entity.entity_type, &entity.id).to_string();
                                <li>
                                    if let Some(href) = href {
                                        <a class={(Button, Secondary, Words)} href={href} target="_blank" rel="noreferrer">
                                            {&label}
                                        </a>
                                    } else {
                                        <span class={Words}>{&label}</span>
                                    }
                                </li>
                            }
                        </ul>
                    }
                </section>
            </div>
        </div>
    }
}
