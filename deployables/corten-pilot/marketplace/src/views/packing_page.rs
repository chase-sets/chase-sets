//! Packing a shipment, after Fulfillment's `shipment-packing-page.tsx`: the heading, the three
//! steps, what the last write did, the stage's banner (start, the packing lock, packed), then the
//! item checklist (the scan, each line with its count and controls) beside the shipment's details
//! (its summary, where it goes, the packing slip), and while packing the footer that finishes it.
//!
//! Every control is a form, so the page works without a script; with one, a line's or the scan's
//! answer replaces only what it changed (`PackingParts`). Two columns from 64rem, one on a phone,
//! where the footer stays at the bottom of the screen; every control is at least 2.75rem tall.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
    view::{AttrValue, Id},
};
use corten_ui::CopyButton;

use super::{listing_page::options, order_page::display_reference};
use crate::{
    api::{AddressSnapshot, ShipmentDetail, ShipmentLine},
    app::url,
    auth::Viewer,
    packing::{AttemptInput, LineInput, LineState, Outcome, PackInput, PackingScreen, ScanInput, Scanned, short_reference},
    text::{Pilot, ShipmentsMsg},
};

corten::script::script!(pub mod handlers = "packing.js");

/// A line's item: a line write's answer replaces it, and Finish goes back to it.
#[derive(Id)]
pub struct PackingLineId<'a>(pub &'a str);

/// A line's references in full, which each Copy copies (the page shows their last eight).
#[derive(Id, Clone, Copy)]
pub struct LineReferenceId<'a>(pub &'a str);
#[derive(Id, Clone, Copy)]
pub struct OrderLineReferenceId<'a>(pub &'a str);
#[derive(Id, Clone, Copy)]
pub struct ProductReferenceId<'a>(pub &'a str);

/// Where the shipment goes, as Copy address copies it (a line each).
#[derive(Id, Clone, Copy)]
pub struct ShipToId;

/// The parts a line write replaces.
#[derive(Id)]
pub struct PackingStatusId;
#[derive(Id)]
pub struct PackingScanId;
#[derive(Id)]
pub struct PackingProgressId;
#[derive(Id)]
pub struct PackingFooterId;

/// A status's words (`statusLabel`).
fn status_label(t: ShipmentsMsg, status: &str) -> String {
    match status {
        "awaiting-package" => t.packing_status_awaiting_package(),
        "packing" => t.packing_status_packing(),
        "awaiting-label" => t.packing_status_awaiting_label(),
        "label-attached" => t.packing_status_label_attached(),
        "cancelled" => t.packing_status_cancelled(),
        "dispatched" => t.packing_status_dispatched(),
        "delivered" => t.packing_status_delivered(),
        "returned" => t.packing_status_returned(),
        "exception" => t.packing_status_exception(),
        other => other,
    }
    .to_owned()
}

/// A status's badge tone (`statusTone`).
fn status_tone(status: &str) -> &'static str {
    match status {
        "packing" | "awaiting-label" | "label-attached" | "dispatched" => "accent",
        "delivered" => "success",
        "cancelled" => "danger",
        "returned" | "exception" => "warning",
        _ => "neutral",
    }
}

/// "{quantity} items across {lines} lines" (`itemCountLabel`).
fn item_count(t: ShipmentsMsg, quantity: u64, lines: u64) -> String {
    let item = if quantity == 1 { t.packing_item() } else { t.packing_items_label() };
    let line = if lines == 1 { t.packing_line() } else { t.packing_lines() };
    t.packing_item_count(quantity, item, lines, line).to_string()
}

/// Where it goes, a line each (`addressLines`). The API's snapshot may be empty (`{}`), so each
/// part may be missing.
pub(super) fn address_lines(address: &AddressSnapshot) -> Vec<String> {
    let part = |value: &Option<String>| value.as_deref().map(str::trim).unwrap_or_default().to_owned();
    let place = format!("{}, {} {}", part(&address.city), part(&address.state), part(&address.postal_code));
    let place = place.trim_matches(|c: char| c == ',' || c.is_whitespace()).to_owned();
    [part(&address.name), part(&address.company), part(&address.line1), part(&address.line2), place, part(&address.country)]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect()
}

/// What the page knows of the shipment's stage.
struct Stage {
    awaiting: bool,
    packing: bool,
    packed: bool,
}

fn stage(s: &ShipmentDetail) -> Stage {
    Stage {
        awaiting: s.status == "awaiting-package",
        packing: s.status == "packing",
        packed: s.package_status == "packed" || s.status == "awaiting-label",
    }
}

/// How many are packed in all, and whether every line is.
fn counted(s: &ShipmentDetail) -> (u64, bool) {
    let packed = s.lines.iter().map(ShipmentLine::packed).sum();
    (packed, s.lines.iter().all(|line| line.packed() >= line.quantity))
}

/// The packing page (`FulfillmentShipmentPackingPage`), or while the shipment is catching up with
/// a write, the route's pending page.
#[component(css)]
pub fn PackingPage<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, id: &'a str, screen: &'a PackingScreen) -> impl Render {
    // The pilot's address, which redirects to marketplace's command center.
    let back = url::SaleShipments.href();
    html! {
        if let Some(s) = &screen.shipment {
            <PackingView t={t} p={p} viewer={viewer} id={id} screen={screen} s={s} back={&back} />
        } else {
            <div class={Page}>
                <platform::section::PageHeader
                    eyebrow={t.packing_seller()}
                    title={t.pack_route_update_pending_title()}
                    description={t.pack_route_update_pending_description()}
                />
                <p class={Actions}><a class={Secondary} href={&back}>{t.packing_back()}</a></p>
                <div class={(Banner, Info)} role="status">
                    <p class={Strong}>{t.pack_route_update_pending_title()}</p>
                    <p class={Muted}>{t.pack_route_update_pending_description()}</p>
                </div>
                <PackingStatus t={t} p={p} viewer={viewer} id={id} outcome={&screen.outcome} />
            </div>
        }
    }
}

#[component(css = PackingPage)]
fn PackingView<'a>(
    t: ShipmentsMsg,
    p: Pilot,
    viewer: &'a Viewer,
    id: &'a str,
    screen: &'a PackingScreen,
    s: &'a ShipmentDetail,
    back: &'a str,
) -> impl Render {
    let at = stage(s);
    let buyer = s.buyer_display_name.as_deref().unwrap_or(&s.buyer_account_id);
    let description = t.packing_description(&display_reference(&s.order_id), buyer).to_string();
    let step = |current: bool, done: bool| {
        if done {
            "complete"
        } else if current {
            "current"
        } else {
            "upcoming"
        }
    };
    let steps = [
        (t.packing_step_review(), t.packing_step_review_description(), step(at.awaiting, !at.awaiting)),
        (t.packing_step_pack(), t.packing_step_pack_description(), step(at.packing, at.packed)),
        (t.packing_step_finish(), t.packing_step_finish_description(), step(false, at.packed)),
    ];
    let started = s.packing_started_at.as_deref().unwrap_or(&s.updated_at);
    let started = parse_timestamp(started).map_or_else(
        || t.packing_not_recorded().to_owned(),
        |at| t.date_time(at, DateStyle::Short, TimeStyle::Short).to_string(),
    );
    let writes = screen.outcome.writes();
    let start = url::PackingStart { id }.href();
    let shipment = url::SaleShipment { id, after: Default::default() }.href();
    html! {
        <div class={Page}>
            <header class={Heading}>
                <div class={Stack}>
                    <p class={Eyebrow}>{t.packing_seller()}</p>
                    <h1 class={Title}>{t.packing_title()}</h1>
                    <p class={Muted}>{&description}</p>
                </div>
                <p class={Actions}><a class={Secondary} href={back}>{t.packing_back()}</a></p>
            </header>
            <ol class={Steps} aria-label={t.packing_title()}>
                for (name, detail, state) in steps {
                    <li class={StepItem} data-state={state} aria-current={(state == "current").then_some("step")}>
                        <p class={Strong}>{name}</p>
                        <p class={Muted}>{detail}</p>
                    </li>
                }
            </ol>
            <PackingStatus t={t} p={p} viewer={viewer} id={id} outcome={&screen.outcome} />
            if at.awaiting {
                <div class={(Banner, Info)}>
                    <div class={Stack}>
                        <p class={Strong}>{t.packing_ready_title()}</p>
                        <p class={Muted}>{t.packing_ready_description()}</p>
                    </div>
                    <WriteForm
                        p={p}
                        viewer={viewer}
                        id={id}
                        action={&start}
                        attempt={AttemptInput::FIELDS.attempt}
                        enabled={writes}
                    >
                        <button type="submit" class={Primary}>{t.packing_start_packing()}</button>
                    </WriteForm>
                </div>
            }
            if at.packing {
                <div class={(Banner, Lock)} role="note">
                    <p class={Strong}>{t.packing_locked_title()}</p>
                    <p class={Muted}>{t.packing_locked_description(&started)}</p>
                </div>
            }
            if at.packed {
                <div class={(Banner, Done)}>
                    <div class={Stack}>
                        <p class={Strong}>{t.packing_packed_title()}</p>
                        <p class={Muted}>{t.packing_packed_description()}</p>
                    </div>
                    <a class={Primary} href={&shipment}>{t.packing_continue_to_label()}</a>
                </div>
            }
            <div class={Workstation}>
                <section class={Checklist} aria-labelledby="packing-checklist">
                    <div class={Stack}>
                        <h2 id="packing-checklist" class={SectionTitle}>{t.packing_item_checklist()}</h2>
                        <p class={Muted}>{t.packing_item_checklist_description()}</p>
                    </div>
                    <Progress t={t} s={s} />
                    if at.packing {
                        <Scan t={t} p={p} viewer={viewer} id={id} screen={screen} enabled={writes} />
                    }
                    <ul class={Lines}>
                        for line in &s.lines {
                            <LineItem t={t} p={p} viewer={viewer} id={id} s={s} line={line} screen={screen} />
                        }
                    </ul>
                    if at.packing {
                        <Footer t={t} p={p} viewer={viewer} id={id} s={s} enabled={writes} />
                    }
                </section>
                <aside class={Rail} aria-labelledby="packing-details">
                    <div class={Stack}>
                        <h2 id="packing-details" class={SectionTitle}>{t.packing_shipment_details()}</h2>
                        <p class={Muted}>{item_count(t, s.total_quantity, s.line_count)}</p>
                    </div>
                    <Details t={t} p={p} s={s} />
                </aside>
            </div>
        </div>
    }
}

/// What a line write changes, as a patch: the status, the scan, the line, the progress and the
/// footer.
#[component(css = PackingPage)]
pub fn PackingParts<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, id: &'a str, screen: &'a PackingScreen) -> impl Patch {
    let s = screen.shipment.as_ref().expect("a patch is drawn from a shipment read");
    let line = screen.line.as_ref().and_then(|(line, _)| s.lines.iter().find(|l| &l.line_id == line));
    let writes = screen.outcome.writes();
    let packing = stage(s).packing;
    html! {
        <PackingStatus t={t} p={p} viewer={viewer} id={id} outcome={&screen.outcome} />
        if packing {
            <Scan t={t} p={p} viewer={viewer} id={id} screen={screen} enabled={writes} />
        }
        if let Some(line) = line {
            <LineItem t={t} p={p} viewer={viewer} id={id} s={s} line={line} screen={screen} />
        }
        <Progress t={t} s={s} />
        if packing {
            <Footer t={t} p={p} viewer={viewer} id={id} s={s} enabled={writes} />
        }
    }
}

/// What the last write did, and the browser's record of a write it could not confirm: the page
/// asks the API about one it does not settle, and while the API cannot say, the seller may check
/// again or forget it (with the script).
#[component(css = PackingPage)]
fn PackingStatus<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, id: &'a str, outcome: &'a Outcome) -> impl Patch {
    let (check_form, check_attempt) = refs();
    let account = viewer.actor.account_id.as_str();
    let page = url::Packing { id, place: Default::default() }.href();
    let again = match outcome {
        Outcome::Uncertain(attempt) => {
            url::Packing { id, place: crate::packing::Place { check: Some(attempt.clone()), ..Default::default() } }.href()
        }
        _ => String::new(),
    };
    let check = handlers::Check { form: check_form, attempt: check_attempt };
    html! {
        <div
            id={PackingStatusId}
            class={Status}
            on:connect={handlers::restore(check, account, id, outcome.settles(), outcome.unsettled())}
        >
            match outcome {
                Outcome::Refused { message, .. } => {
                    <div class={(Banner, Danger)} role="alert" tabindex="-1" autofocus>
                        <p class={Strong}>{t.packing_error()}</p>
                        <p class={Muted}>{if message.is_empty() { p.packing_not_applied() } else { message.as_str() }}</p>
                    </div>
                }
                Outcome::Uncertain(attempt) => {
                    <div class={(Banner, Warning)} role="alert" tabindex="-1" autofocus>
                        <p class={Strong}>{p.packing_unconfirmed_title()}</p>
                        <p class={Muted}>{p.packing_unconfirmed()}</p>
                        <p class={Actions}>
                            <a class={Secondary} href={&again}>{p.packing_check()}</a>
                            <button
                                type="button"
                                class={Secondary}
                                hidden
                                on:connect={handlers::reveal(target)}
                                on:click={handlers::discard(account, id, attempt.as_str(), p.packing_discard_confirmation(), &page)}
                            >
                                {p.packing_discard()}
                            </button>
                        </p>
                    </div>
                }
                _ => {}
            }
            <form ref={check_form} method="get" action={&page} hidden>
                <input type="hidden" ref={check_attempt} name="check" value="">
            </form>
        </div>
    }
}

/// A write's form: the attempt (`SubmitKey`) the script remembers before it is sent, off while a
/// write is uncertain. A `data-patch` form: with the script the answer replaces what it changed.
#[component(css = PackingPage)]
pub(super) fn WriteForm<'a, A: AttrValue, C: Render>(
    p: Pilot,
    viewer: &'a Viewer,
    id: &'a str,
    action: A,
    attempt: FieldName,
    enabled: bool,
    children: C,
) -> impl Render {
    let unavailable = refs();
    let account = viewer.actor.account_id.as_str();
    html! {
        <form
            class={Write}
            method="post"
            action={action}
            data-patch
            on:submit={handlers::remember(event, account, id, unavailable)}
        >
            {SubmitKey::field(attempt)}
            <p ref={unavailable} class={Unavailable} role="alert" tabindex="-1" hidden>{p.packing_storage_unavailable()}</p>
            <fieldset class={Controls} disabled={!enabled}>{children}</fieldset>
        </form>
    }
}

/// "{checked} of {total} items packed", as a bar (`TaskProgress`); once packed, all of them.
#[component(css = PackingPage)]
fn Progress<'a>(t: ShipmentsMsg, s: &'a ShipmentDetail) -> impl Patch {
    let at = stage(s);
    let (packed, all) = counted(s);
    let total = s.total_quantity;
    let checked = if at.packed { total } else { packed };
    let percent = if at.packed { 100 } else { (checked * 100 + total / 2).checked_div(total).unwrap_or(0) };
    let label = t.packing_progress(checked, total).to_string();
    html! {
        <div id={PackingProgressId} class={Progress} data-tone={if all || at.packed { "success" } else { "accent" }}>
            if at.packing || at.packed {
                <div class={ProgressHead}>
                    <span id="packing-progress-label">{&label}</span>
                    <span class={Strong}>{t.packing_progress_percent(percent)}</span>
                </div>
                <progress class={Bar} max="100" value={percent} aria-labelledby="packing-progress-label"></progress>
            }
        </div>
    }
}

/// Scan or search (`TaskScanInput`): one more packed of the line it names.
#[component(css = PackingPage)]
fn Scan<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, id: &'a str, screen: &'a PackingScreen, enabled: bool) -> impl Patch {
    let f = ScanInput::FIELDS;
    let action = url::PackingScan { id }.href();
    let title = |line: &str| {
        screen.shipment.as_ref().and_then(|s| s.lines.iter().find(|l| l.line_id == line)).map_or("", |l| l.item_title.as_str())
    };
    let feedback = screen.scan.as_ref().map(|(scanned, line)| match scanned {
        Scanned::Matched => ("success", t.packing_scan_matched(title(line)).to_string()),
        Scanned::Complete => ("warning", t.packing_scan_already_complete(title(line)).to_string()),
        Scanned::Ambiguous => ("warning", t.packing_scan_ambiguous().to_owned()),
        Scanned::None => ("danger", t.packing_scan_no_match().to_owned()),
    });
    let receipt = screen.after_write.as_deref().unwrap_or("");
    html! {
        <div id={PackingScanId} class={Scan}>
            <WriteForm p={p} viewer={viewer} id={id} action={&action} attempt={f.attempt} enabled={enabled}>
                <input type="hidden" name={f.after_write} value={receipt}>
                <label class={Label} for="packing-scan-code">{t.packing_scan_label()}</label>
                <p class={Muted} id="packing-scan-note">{t.packing_scan_description()}</p>
                <div class={ScanRow}>
                    <input
                        class={Input}
                        id="packing-scan-code"
                        name={f.code}
                        type="search"
                        autocomplete="off"
                        placeholder={t.packing_scan_placeholder()}
                        aria-describedby="packing-scan-note packing-scan-feedback"
                    >
                    <button type="submit" class={Primary}>{t.packing_scan_confirm()}</button>
                </div>
            </WriteForm>
            <p
                id="packing-scan-feedback"
                class={Feedback}
                data-tone={feedback.as_ref().map_or("", |(tone, _)| *tone)}
                role="status"
            >
                {feedback.as_ref().map_or("", |(_, text)| text.as_str())}
            </p>
        </div>
    }
}

/// A line (`PackingLine`): its title, options and count; while packing, a box that packs all of it
/// or none, and for more than one, a step down and up; its references.
#[component(css = PackingPage)]
fn LineItem<'a>(
    t: ShipmentsMsg,
    p: Pilot,
    viewer: &'a Viewer,
    id: &'a str,
    s: &'a ShipmentDetail,
    line: &'a ShipmentLine,
    screen: &'a PackingScreen,
) -> impl Patch {
    let at = stage(s);
    let packed = if at.packed { line.quantity } else { line.packed() };
    let checked = packed >= line.quantity;
    let state = screen.line.as_ref().filter(|(l, _)| *l == line.line_id).map(|(_, state)| state);
    let (state_name, state_text) = match state {
        Some(LineState::Failed(message)) => {
            ("error", if message.is_empty() { t.packing_line_save_failed().to_owned() } else { message.clone() })
        }
        Some(LineState::Matched) => ("matched", t.packing_line_matched().to_owned()),
        Some(LineState::Saved) => ("saved", t.packing_line_saved().to_owned()),
        None => ("idle", String::new()),
    };
    let summary = line.product_summary.as_deref().or(Some(t.packing_standard()));
    let action = url::PackingLine { id, line: &line.line_id }.href();
    let f = LineInput::FIELDS;
    let enabled = at.packing && screen.outcome.writes();
    html! {
        <li id={PackingLineId(&line.line_id)} class={LineItem} data-state={state_name} data-checked={checked}>
            <WriteForm p={p} viewer={viewer} id={id} action={&action} attempt={f.attempt} enabled={enabled}>
                <button
                    type="submit"
                    class={Check}
                    name={f.quantity}
                    value={if checked { 0 } else { line.quantity }}
                    role="checkbox"
                    aria-checked={if checked { "true" } else { "false" }}
                    aria-label={t.packing_line_checked(line.quantity, &line.item_title)}
                ></button>
                <div class={LineText}>
                    <p class={Strong}>{&line.item_title}</p>
                    if let Some(subtitle) = &line.item_subtitle {
                        <p class={Muted}>{subtitle}</p>
                    }
                    <ul class={Chips}>
                        for option in options(summary) {
                            <li class={Chip}>{option}</li>
                        }
                    </ul>
                </div>
                <div class={Count}>
                    <p class={Strong}>{format!("\u{d7}{}", line.quantity)}</p>
                    <p class={Muted}>{t.packing_line_quantity_detail(packed, line.quantity)}</p>
                    if line.quantity > 1 {
                        <div class={Stepper}>
                            <button
                                type="submit"
                                class={Step}
                                name={f.quantity}
                                value={packed.saturating_sub(1)}
                                disabled={packed == 0}
                                aria-label={t.packing_line_quantity_decrease(&line.item_title)}
                            >
                                "\u{2212}"
                            </button>
                            <span class={StepValue} aria-hidden="true">{packed}</span>
                            <button
                                type="submit"
                                class={Step}
                                name={f.quantity}
                                value={packed + 1}
                                disabled={packed >= line.quantity}
                                aria-label={t.packing_line_quantity_increase(&line.item_title)}
                            >
                                "+"
                            </button>
                        </div>
                    }
                </div>
            </WriteForm>
            if !state_text.is_empty() {
                <p class={LineState} data-state={state_name} role={if state_name == "error" { "alert" } else { "status" }}>
                    {&state_text}
                </p>
            }
            <dl class={References}>
                <ReferenceRow
                    t={t}
                    p={p}
                    label={t.packing_line_reference_label()}
                    value={&line.line_id}
                    id={LineReferenceId(&line.line_id)}
                />
                <ReferenceRow
                    t={t}
                    p={p}
                    label={t.packing_order_line_reference_label()}
                    value={&line.order_line_id}
                    id={OrderLineReferenceId(&line.line_id)}
                />
                <ReferenceRow
                    t={t}
                    p={p}
                    label={t.packing_product_reference_label()}
                    value={&line.product_id}
                    id={ProductReferenceId(&line.line_id)}
                />
            </dl>
        </li>
    }
}

/// A reference: its label, its last eight characters (the whole in its title), and Copy
/// (corten-ui's, shown with the script), which copies the whole from a hidden element.
#[component(css = PackingPage)]
fn ReferenceRow<'a, I: Id + Copy>(t: ShipmentsMsg, p: Pilot, label: &'a str, value: &'a str, id: I) -> impl Render {
    html! {
        <div class={Reference}>
            <dt>{label}</dt>
            <dd>
                <span title={value}>{short_reference(value)}</span>
                <span id={id} hidden>{value}</span>
                <span class={Copy}>
                    <CopyButton text={id} label={t.packing_copy_reference()} copied={p.packing_copied()} />
                </span>
            </dd>
        </div>
    }
}

/// The footer while packing (`StickyTaskFooter`): how many are packed, what Finish waits for, the
/// packing slip, the package count and Finish packing, off until every line is packed.
#[component(css = PackingPage)]
fn Footer<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, id: &'a str, s: &'a ShipmentDetail, enabled: bool) -> impl Patch {
    let (packed, all) = counted(s);
    let f = PackInput::FIELDS;
    let action = url::Pack { id }.href();
    let slip = crate::packing_slips::href(&s.shipment_id);
    html! {
        <div id={PackingFooterId} class={Footer}>
            <div class={Stack}>
                <p class={Strong}>{t.packing_progress(packed, s.total_quantity)}</p>
                <p class={Muted} id="packing-finish-note">
                    {if all { t.packing_complete_ready() } else { t.packing_complete_disabled() }}
                </p>
            </div>
            <WriteForm p={p} viewer={viewer} id={id} action={&action} attempt={f.attempt} enabled={enabled}>
                <div class={FooterRow}>
                    <a
                        class={Secondary}
                        href={&slip}
                        target="_blank"
                        rel="noopener"
                        aria-label={t.packing_print_packing_slip_new_tab()}
                    >
                        {t.packing_print_packing_slip()}
                    </a>
                    <label class={Field}>
                        <span class={Label}>{t.packing_package_count()}</span>
                        <input
                            class={(Input, Number)}
                            type="number"
                            name={f.package_count}
                            required
                            min="1"
                            step="1"
                            inputmode="numeric"
                            value={s.package_count.unwrap_or(1)}
                        >
                    </label>
                    <button type="submit" class={Primary} disabled={!all} aria-describedby="packing-finish-note">
                        {t.packing_complete_packing()}
                    </button>
                </div>
            </WriteForm>
        </div>
    }
}

/// The shipment's details (the page's rail): its summary, where it goes, and the packing slip.
#[component(css = PackingPage)]
fn Details<'a>(t: ShipmentsMsg, p: Pilot, s: &'a ShipmentDetail) -> impl Render {
    let buyer = s.buyer_display_name.as_deref().unwrap_or(&s.buyer_account_id);
    let address = s.shipping_destination_snapshot.as_ref().map(address_lines).unwrap_or_default();
    let copied = address.join("\n");
    let slip = crate::packing_slips::href(&s.shipment_id);
    let (note, label) = refs();
    html! {
        <div class={Cards}>
            <div class={Card}>
                <h3 class={CardTitle}>{t.packing_fulfillment_summary()}</h3>
                <dl class={Facts}>
                    <div>
                        <dt>{t.packing_shipment_reference_label()}</dt>
                        <dd>{&s.display_reference}</dd>
                    </div>
                    <div>
                        <dt>{t.packing_status()}</dt>
                        <dd><span class={Badge} data-tone={status_tone(&s.status)}>{status_label(t, &s.status)}</span></dd>
                    </div>
                    <div>
                        <dt>{t.packing_buyer()}</dt>
                        <dd>{buyer}</dd>
                    </div>
                    <div>
                        <dt>{t.packing_shipping_option()}</dt>
                        <dd>{&s.shipping_option}</dd>
                    </div>
                    <div>
                        <dt>{t.packing_items()}</dt>
                        <dd>{item_count(t, s.total_quantity, s.line_count)}</dd>
                    </div>
                </dl>
            </div>
            <div class={Card}>
                <h3 class={CardTitle}>{t.packing_ship_to()}</h3>
                <address class={Address}>
                    for line in &address {
                        <span>{line}</span>
                    }
                </address>
                <span id={ShipToId} hidden>{&copied}</span>
                <span class={Copy}>
                    <CopyButton text={ShipToId} label={t.packing_copy_address()} copied={p.packing_copied()} />
                </span>
            </div>
            <div class={Card}>
                <a
                    class={Secondary}
                    href={&slip}
                    target="_blank"
                    rel="noopener"
                    aria-label={t.packing_print_packing_slip_new_tab()}
                    on:click={handlers::slip(target, label, note, t.packing_print_packing_slip_again(), t.packing_print_packing_slip_again_new_tab(), t.packing_packing_slip_opened())}
                >
                    <span ref={label}>{t.packing_print_packing_slip()}</span>
                </a>
                <p ref={note} class={Muted}>{t.packing_packing_slip_ready()}</p>
            </div>
        </div>
    }
}

/// A shipment's page while it is catching up with a write (the packing route's pending words).
#[component(css = PackingPage)]
pub fn ShipmentPending(t: ShipmentsMsg) -> impl Render {
    // The pilot's address, which redirects to marketplace's command center.
    let back = url::SaleShipments.href();
    html! {
        <div class={Page}>
            <platform::section::PageHeader
                eyebrow={t.packing_seller()}
                title={t.pack_route_update_pending_title()}
                description={t.pack_route_update_pending_description()}
            />
            <p class={Actions}><a class={Secondary} href={&back}>{t.packing_back()}</a></p>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::{address_lines, status_tone};
    use crate::api::AddressSnapshot;

    #[test]
    fn an_address_reads_a_line_each_without_empty_ones() {
        let address = AddressSnapshot {
            name: Some("Ash Ketchum".into()),
            company: Some(" ".into()),
            line1: Some("1 Route Rd".into()),
            city: Some("Pallet".into()),
            state: Some("KS".into()),
            postal_code: Some("66002".into()),
            country: Some("US".into()),
            ..AddressSnapshot::default()
        };
        assert_eq!(address_lines(&address), ["Ash Ketchum", "1 Route Rd", "Pallet, KS 66002", "US"]);
        assert!(address_lines(&AddressSnapshot::default()).is_empty(), "the API's empty snapshot");
    }

    #[test]
    fn a_status_reads_as_marketplace_tones_it() {
        assert_eq!(status_tone("packing"), "accent");
        assert_eq!(status_tone("cancelled"), "danger");
        assert_eq!(status_tone("awaiting-package"), "neutral");
    }
}
