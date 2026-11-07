//! The seller's command center, after Fulfillment's `fulfillment-command-center-page.tsx`: the
//! heading, what the last action did, then each bucket with shipments in it, in the API's order,
//! or that nothing needs the seller. Each shipment is a card with its title, status, summary and
//! any exception, its one next action, the others under More actions, and Open shipment.
//!
//! Every action is a form, so the page works without a script; the script remembers each form's
//! attempt before it is sent, and asks the page about a record it does not settle (`restoreAny`).
//! The cards are a column on a phone and fill the width beside each other from 48rem; every
//! control is at least 2.75rem tall.
use corten::prelude::*;

use super::packing_page::{handlers, status_label};
use crate::{
    api::{CommandCenterBucket, CommandCenterItem, ShipmentAction},
    app::url,
    auth::Viewer,
    command_center::{ActionInput, CenterScreen, Place},
    packing::Outcome,
    text::{Pilot, ShipmentsMsg},
};

/// The word an action is posted as (`ShipmentActionName`).
pub(super) fn action_value(action: ShipmentAction) -> &'static str {
    match action {
        ShipmentAction::StartPacking => "start-packing",
        ShipmentAction::CompletePacking => "complete-packing",
        ShipmentAction::BuyLabel => "buy-label",
        ShipmentAction::VoidLabel => "void-label",
        ShipmentAction::CancelShipment => "cancel-shipment",
        ShipmentAction::Dispatch => "dispatch",
        ShipmentAction::RecordDelivery => "record-delivery",
        ShipmentAction::Return => "return",
        ShipmentAction::RaiseException => "raise-exception",
        ShipmentAction::Other => "",
    }
}

/// An action's words (`actionLabel`); one the pilot does not know has none and is not drawn.
fn action_label(t: ShipmentsMsg, action: ShipmentAction) -> Option<&'static str> {
    Some(match action {
        ShipmentAction::StartPacking => t.center_action_start_packing(),
        ShipmentAction::CompletePacking => t.center_action_complete_packing(),
        ShipmentAction::BuyLabel => t.center_action_buy_label(),
        ShipmentAction::VoidLabel => t.center_action_void_label(),
        ShipmentAction::CancelShipment => t.center_action_cancel_shipment(),
        ShipmentAction::Dispatch => t.center_action_dispatch(),
        ShipmentAction::RecordDelivery => t.center_action_record_delivery(),
        ShipmentAction::Return => t.center_action_return(),
        ShipmentAction::RaiseException => t.center_action_raise_exception(),
        ShipmentAction::Other => return None,
    })
}

/// A bucket's words (`bucketTitle`); one the pilot does not know is named as the API names it.
fn bucket_title(t: ShipmentsMsg, id: &str) -> &str {
    match id {
        "exceptions" => t.center_bucket_exceptions(),
        "ready-to-dispatch" => t.center_bucket_ready_to_dispatch(),
        "needs-label" => t.center_bucket_needs_label(),
        "needs-packing" => t.center_bucket_needs_packing(),
        other => other,
    }
}

/// A status's badge tone on the command center (`statusTone`).
fn status_tone(status: &str) -> &'static str {
    match status {
        "exception" => "warning",
        "label-attached" => "accent",
        "awaiting-label" => "info",
        _ => "neutral",
    }
}

/// The exception types a seller may raise, in the order the select offers them.
fn exception_types(t: ShipmentsMsg) -> [(&'static str, &'static str); 5] {
    [
        ("carrier-delay", t.center_exception_carrier_delay()),
        ("damaged-package", t.center_exception_damaged()),
        ("lost-in-transit", t.center_exception_lost()),
        ("return-to-sender", t.center_exception_return_to_sender()),
        ("other", t.center_exception_other()),
    ]
}

/// An exception type's words, or the type as the API names it.
fn exception_label(t: ShipmentsMsg, kind: &str) -> String {
    exception_types(t).iter().find(|(value, _)| *value == kind).map_or_else(|| kind.to_owned(), |(_, label)| (*label).to_owned())
}

/// The card's title (`itemTitle`): its tracking once it has one, else its reference.
fn item_title(t: ShipmentsMsg, item: &CommandCenterItem) -> String {
    match item.tracking_identifier.as_deref().filter(|id| !id.is_empty()) {
        Some(tracking) => t.center_tracking_title(tracking).to_string(),
        None => t.center_shipment(&item.display_reference).to_string(),
    }
}

/// The command center (`FulfillmentCommandCenterPage`), or while it is catching up with an
/// action, the page that says so.
#[component(css)]
pub fn CommandCenterPage<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, screen: &'a CenterScreen) -> impl Render {
    let writes = screen.outcome.writes();
    html! {
        <div class={Page}>
            <platform::section::PageHeader
                eyebrow={t.center_eyebrow()}
                title={t.center_title()}
                description={t.center_description()}
            />
            <CenterStatus t={t} p={p} viewer={viewer} screen={screen} />
            match &screen.center {
                None => {
                    <div class={(Banner, Info)} role="status">
                        <p class={Strong}>{t.sale_shipment_update_pending_title()}</p>
                        <p class={Muted}>{t.sale_shipment_update_pending_description()}</p>
                    </div>
                }
                Some(center) if center.total_needing_attention == 0 => {
                    <div class={Empty}>
                        <p class={Strong}>{t.center_empty_title()}</p>
                        <p class={Muted}>{t.center_empty_description()}</p>
                    </div>
                }
                Some(center) => {
                    for bucket in center.buckets.iter().filter(|b| b.count > 0) {
                        <Bucket t={t} p={p} viewer={viewer} bucket={bucket} writes={writes} />
                    }
                }
            }
        </div>
    }
}

#[component(css = CommandCenterPage)]
fn Bucket<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, bucket: &'a CommandCenterBucket, writes: bool) -> impl Render {
    let heading = format!("bucket-{}", bucket.id);
    let title = t
        .center_bucket_with_count(crate::text::shipments_msg::CenterBucketWithCount {
            bucket: bucket_title(t, &bucket.id),
            count: bucket.count,
        })
        .to_string();
    html! {
        <section class={Bucket} aria-labelledby={&heading}>
            <h2 id={&heading} class={SectionTitle}>{&title}</h2>
            <ul class={Cards}>
                for item in &bucket.items {
                    <ItemCard t={t} p={p} viewer={viewer} item={item} writes={writes} />
                }
            </ul>
        </section>
    }
}

/// A shipment's card (`CommandCenterItemCard`).
#[component(css = CommandCenterPage)]
fn ItemCard<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, item: &'a CommandCenterItem, writes: bool) -> impl Render {
    let id = item.shipment_id.as_str();
    let buyer = item.buyer_display_name.as_deref().filter(|b| !b.is_empty()).unwrap_or(t.center_buyer_unknown());
    let summary = t
        .center_summary(crate::text::shipments_msg::CenterSummary {
            buyer,
            quantity: item.total_quantity,
            lines: item.line_count,
        })
        .to_string();
    let open = url::SaleShipment { id, place: Default::default() }.href();
    let disclosed: Vec<(ShipmentAction, &str)> =
        item.plan.disclosed.iter().filter_map(|a| action_label(t, *a).map(|label| (*a, label))).collect();
    html! {
        <li class={Card}>
            <div class={Stack}>
                <p class={CardTitle}>{item_title(t, item)}</p>
                <span class={Badge} data-tone={status_tone(&item.status)}>{status_label(t, &item.status)}</span>
            </div>
            <p class={Muted}>{&summary}</p>
            if let Some(kind) = item.current_exception_type.as_deref() {
                <div class={(Banner, Warning)} role="note">
                    <p class={Strong}>{exception_label(t, kind)}</p>
                    <p class={Muted}>{item.current_exception_notes.as_deref().unwrap_or(t.center_exception_no_notes())}</p>
                </div>
            }
            <Primary t={t} p={p} viewer={viewer} item={item} writes={writes} />
            if !disclosed.is_empty() {
                <details class={More}>
                    <summary class={Secondary}>{t.center_more_actions()}</summary>
                    <div class={MoreActions}>
                        for (action, label) in disclosed {
                            <Disclosed t={t} p={p} viewer={viewer} id={id} action={action} label={label} writes={writes} />
                        }
                    </div>
                </details>
            }
            <a class={Secondary} href={&open}>{t.center_open_shipment()}</a>
        </li>
    }
}

/// The one next action (`PrimaryAction`): packing's open the packing page, which keeps its
/// checklist; any other is a form.
#[component(css = CommandCenterPage)]
fn Primary<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, item: &'a CommandCenterItem, writes: bool) -> impl Render {
    let id = item.shipment_id.as_str();
    let primary = item.plan.primary.and_then(|a| action_label(t, a).map(|label| (a, label)));
    let packing = url::Packing { id, place: Default::default() }.href();
    let f = ActionInput::FIELDS;
    html! {
        match primary {
            Some((ShipmentAction::StartPacking | ShipmentAction::CompletePacking, label)) => {
                <a class={Primary} href={&packing}>{label}</a>
            }
            Some((action, label)) => {
                <ActionForm p={p} viewer={viewer} id={id} writes={writes}>
                    <button type="submit" class={Primary} name={f.intent} value={action_value(action)}>{label}</button>
                </ActionForm>
            }
            None => {}
        }
    }
}

/// An action under More actions (`DisclosedAction`): Raise exception with its type and notes,
/// any other a button.
#[component(css = CommandCenterPage)]
fn Disclosed<'a>(
    t: ShipmentsMsg,
    p: Pilot,
    viewer: &'a Viewer,
    id: &'a str,
    action: ShipmentAction,
    label: &'a str,
    writes: bool,
) -> impl Render {
    let f = ActionInput::FIELDS;
    let kind = format!("exception-type-{id}");
    let notes = format!("exception-notes-{id}");
    html! {
        <ActionForm p={p} viewer={viewer} id={id} writes={writes}>
            if action == ShipmentAction::RaiseException {
                <label class={Label} for={&kind}>{t.center_exception_type()}</label>
                <select class={Input} id={&kind} name={f.exception_type}>
                    for (value, words) in exception_types(t) {
                        <option value={value} selected={value == "carrier-delay"}>{words}</option>
                    }
                </select>
                <label class={Label} for={&notes}>{t.center_exception_notes()}</label>
                <textarea class={Input} id={&notes} name={f.notes} rows="2"></textarea>
            }
            <button type="submit" class={Secondary} name={f.intent} value={action_value(action)}>{label}</button>
        </ActionForm>
    }
}

/// An action's form: the attempt (`SubmitKey`) the script remembers before it is sent, and the
/// shipment; off while an action is uncertain.
#[component(css = CommandCenterPage)]
fn ActionForm<'a, C: Render>(p: Pilot, viewer: &'a Viewer, id: &'a str, writes: bool, children: C) -> impl Render {
    let unavailable = refs();
    let account = viewer.actor.account_id.as_str();
    let f = ActionInput::FIELDS;
    let action = url::SaleShipments::default().href();
    html! {
        <form class={Write} method="post" action={&action} on:submit={handlers::remember(event, account, id, unavailable)}>
            {SubmitKey::field(f.attempt)}
            <input type="hidden" name={f.shipment} value={id}>
            <p ref={unavailable} class={Unavailable} role="alert" tabindex="-1" hidden>{p.packing_storage_unavailable()}</p>
            <fieldset class={Controls} disabled={!writes}>{children}</fieldset>
        </form>
    }
}

/// What the last action did, and the browser's records of actions it could not confirm: the page
/// asks the API about one it does not settle, and while the API cannot say, the seller may check
/// again or forget it (with the script).
#[component(css = CommandCenterPage)]
fn CenterStatus<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, screen: &'a CenterScreen) -> impl Render {
    let (check_form, check_attempt, check_shipment) = refs();
    let account = viewer.actor.account_id.as_str();
    let shipment = screen.shipment.as_str();
    let page = url::SaleShipments::default().href();
    let again = match &screen.outcome {
        Outcome::Uncertain(attempt) => url::SaleShipments {
            place: Place { check: Some(attempt.clone()), shipment: Some(shipment.to_owned()), ..Place::default() },
        }
        .href(),
        _ => String::new(),
    };
    let f = Place::FIELDS;
    let check = handlers::CheckAny { form: check_form, attempt: check_attempt, shipment: check_shipment };
    html! {
        <div
            class={Status}
            on:connect={handlers::restoreAny(check, account, shipment, screen.outcome.settles(), screen.outcome.unsettled())}
        >
            match &screen.outcome {
                Outcome::Refused { message, .. } => {
                    <div class={(Banner, Danger)} role="alert" tabindex="-1" autofocus>
                        <p class={Strong}>{t.center_action_failed()}</p>
                        <p class={Muted}>{if message.is_empty() { p.packing_not_applied() } else { message.as_str() }}</p>
                    </div>
                }
                Outcome::Uncertain(attempt) => {
                    <div class={(Banner, Warning)} role="alert" tabindex="-1" autofocus>
                        <p class={Strong}>{p.packing_center_unconfirmed_title()}</p>
                        <p class={Muted}>{p.packing_center_unconfirmed()}</p>
                        <p class={Actions}>
                            <a class={Secondary} href={&again}>{p.packing_check()}</a>
                            <button
                                type="button"
                                class={Secondary}
                                hidden
                                on:connect={handlers::reveal(target)}
                                on:click={handlers::discard(account, shipment, attempt.as_str(), p.packing_discard_confirmation(), &page)}
                            >
                                {p.packing_discard()}
                            </button>
                        </p>
                    </div>
                }
                _ => {}
            }
            <form ref={check_form} method="get" action={&page} hidden>
                <input type="hidden" ref={check_attempt} name={f.check} value="">
                <input type="hidden" ref={check_shipment} name={f.shipment} value="">
            </form>
        </div>
    }
}
