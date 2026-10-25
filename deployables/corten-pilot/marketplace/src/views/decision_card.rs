use corten::{prelude::*, view::Id};

use super::{WriteForm, marketplace};
use crate::{
    api::{Decision, segment},
    app::url,
    auth::Viewer,
    form::DecisionInput,
    recovery::Family,
    text::{Msg, Restock},
};

/// A decision's Restock form: a refused restock's patch replaces it.
#[derive(Id, Clone, Copy)]
pub struct RestockFormId<'a>(pub &'a str);

/// A decision's Write off form.
#[derive(Id, Clone, Copy)]
pub struct WriteOffFormId<'a>(pub &'a str);

/// A decision form's values and what is wrong with them.
#[derive(Clone, Debug)]
pub struct DecisionDraft {
    pub input: DecisionInput,
    pub errors: Errors,
}

impl DecisionDraft {
    pub fn new(version: u64) -> Self {
        DecisionDraft { input: DecisionInput::of(version), errors: Errors::new() }
    }
}

/// Which of a decision's forms a refused write posted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decided {
    Restock(String),
    WriteOff(String),
}

impl Decided {
    /// The decision.
    pub fn id(&self) -> &str {
        match self {
            Decided::Restock(id) | Decided::WriteOff(id) => id,
        }
    }
}

/// How the decision came back (`sourceLabel`): another source is shown as the API names it.
fn source(t: Restock, decision: &Decision) -> &str {
    match decision.source.as_str() {
        "order-cancelled-after-dispatch" => t.queue_source_cancelled_after_dispatch(),
        "shipment-returned" => t.queue_source_shipment_returned(),
        other => other,
    }
}

/// A marketplace page's address, or none when the origin is not a URL.
fn link(path: &str) -> String {
    marketplace(path).map(|u| u.to_string()).unwrap_or_default()
}

/// The decisions, one card each.
#[component(css = DecisionCard)]
pub fn DecisionList<C: Render>(children: C) -> impl Render {
    html! { <ul class={List}>{children}</ul> }
}

/// No decision is pending (marketplace's tinted card).
#[component(css = DecisionCard)]
pub fn NoDecisions(t: Restock) -> impl Render {
    html! { <p class={Empty}>{t.queue_empty()}</p> }
}

/// One decision: how it came back and how many, the item, when, its order and ledger (marketplace's
/// pages), the return's reason, and the two forms.
#[component(css)]
pub fn DecisionCard<'a>(
    t: Restock,
    m: Msg,
    viewer: &'a Viewer,
    decision: &'a Decision,
    restock: &'a DecisionDraft,
    write_off: &'a DecisionDraft,
    enabled: bool,
) -> impl Render {
    let id = decision.decision_id.as_str();
    let title = decision.item_title.as_deref().unwrap_or(&decision.item_id);
    let order = link(&format!("/account/sales/{}", segment(&decision.order_id)));
    let ledger = link(&format!("/account/inventory/items/{}", segment(&decision.item_id)));
    html! {
        <li class={Card} data-decision={id}>
            <div class={Badges}>
                <span class={(Pill, Warning)}>{source(t, decision)}</span>
                <span class={(Pill, Neutral)}>{t.queue_quantity(decision.quantity)}</span>
            </div>
            <div class={Item}>
                <p class={Title}>{title}</p>
                if let Some(subtitle) = &decision.item_subtitle {
                    <p class={Muted}>{subtitle}</p>
                }
                <p class={(Muted, Small)}>{platform::when::date_time(&decision.pending_at)}</p>
            </div>
            <div class={Links}>
                <a class={Link} href={order}>{t.queue_view_order(&decision.order_id)}</a>
                <a class={Link} href={ledger}>{t.queue_view_ledger()}</a>
            </div>
            if let Some(reason) = &decision.return_reason {
                <p class={Reason}>{reason}</p>
            }
            <div class={Actions}>
                <RestockForm t={t} m={m} viewer={viewer} id={id} draft={restock} enabled={enabled} />
                <div class={WriteOff}>
                    <WriteOffForm t={t} m={m} viewer={viewer} id={id} draft={write_off} enabled={enabled} />
                </div>
            </div>
        </li>
    }
}

/// Restock: the decision's version as the page read it.
#[component(css = DecisionCard)]
pub fn RestockForm<'a>(
    t: Restock,
    m: Msg,
    viewer: &'a Viewer,
    id: &'a str,
    draft: &'a DecisionDraft,
    enabled: bool,
) -> impl Render {
    let f = DecisionInput::FIELDS;
    html! {
        <WriteForm
            t={m}
            id={RestockFormId(id)}
            action={url::Restocked { id }}
            viewer={viewer}
            family={Family::Restock}
            target={id}
            attempt={f.attempt}
            errors={&draft.errors}
            enabled={enabled}
        >
            <input type="hidden" name={f.expected_version} value={&draft.input.expected_version}>
            <div class={Buttons}><button type="submit">{t.queue_restock()}</button></div>
        </WriteForm>
    }
}

/// Write off: the version, and a damage note. The form is the patch's element (a refused write-off
/// replaces it by its id), so its wrapper is the card's.
#[component(css = DecisionCard)]
pub fn WriteOffForm<'a>(
    t: Restock,
    m: Msg,
    viewer: &'a Viewer,
    id: &'a str,
    draft: &'a DecisionDraft,
    enabled: bool,
) -> impl Render {
    let f = DecisionInput::FIELDS;
    html! {
        <WriteForm
            t={m}
            id={WriteOffFormId(id)}
            action={url::WrittenOff { id }}
            viewer={viewer}
            family={Family::Restock}
            target={id}
            attempt={f.attempt}
            errors={&draft.errors}
            enabled={enabled}
        >
            <input type="hidden" name={f.expected_version} value={&draft.input.expected_version}>
            <label class={Field}>
                <span class={Label}>{t.queue_damage_note()}</span>
                <textarea name={f.damage_note} rows="2">{&draft.input.damage_note}</textarea>
            </label>
            <div class={Buttons}><button type="submit" class={Secondary}>{t.queue_write_off()}</button></div>
        </WriteForm>
    }
}
