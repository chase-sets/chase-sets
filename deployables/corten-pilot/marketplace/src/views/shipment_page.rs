//! The account's shipments, after Fulfillment's `shipment-list-page.tsx` and
//! `shipment-detail-page.tsx`.
//!
//! The list: the heading, then each shipment as a card (its tracking or reference, status,
//! quantity and lines, and Open shipment). One column, two from 80rem.
//!
//! A shipment: the heading (whose order with whom, Print packing slip for the seller, Back), its
//! progress (status, tracking, carrier), its facts, what it is covered by, the postage policy the
//! order committed to, the label's document, error and refund; for the seller the postage
//! diagnostics (each label operation and provider event); its lines and its exceptions. The
//! seller starts or resumes packing here (the pilot's packing page); its other actions are
//! marketplace's for now (a link there). The facts are two to a row from
//! 48rem, the cover three to a row from 48rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use super::{listing_page::options, on_marketplace, order_page::display_reference, packing_page::WriteForm};
use crate::{
    api::{PostageOperation, PostagePolicySnapshot, PostageProviderEvent, ShipmentCard, ShipmentDetail, Side},
    auth::Viewer,
    packing::AttemptInput,
    shipments::{ListScreen, ShipmentScreen},
    text::{Pilot, ShipmentsMsg},
};

/// A status's badge tone (`statusTone`). The badge shows the status's code, as marketplace's does.
fn tone(status: &str) -> &'static str {
    match status {
        "delivered" => "success",
        "returned" | "exception" => "warning",
        "dispatched" | "label-attached" => "accent",
        _ => "neutral",
    }
}

/// A label the catalog writes with its colon and a space ("Tracking: "), as the page shows it.
fn label(text: &str) -> &str {
    text.trim_end()
}

/// The buyer's list (`FulfillmentShipmentListPage`).
#[component(css = ShipmentPage)]
pub fn ShipmentList<'a>(t: ShipmentsMsg, p: Pilot, screen: &'a ListScreen) -> impl Render {
    let shipments = &screen.shipments.items;
    html! {
        <div class={Page}>
            <platform::section::PageHeader
                eyebrow={t.shipments_buyer()}
                title={t.shipments_shipments()}
                description={t.list_track_the_post_payment_shipping_workflow()}
            />
            <section class={Part} aria-labelledby="shipment-list">
                <h2 id="shipment-list" class={SectionTitle}>{t.list_shipments()}</h2>
                if shipments.is_empty() {
                    <div class={Empty}>
                        <h3 class={EmptyTitle}>{t.shipments_no_shipments_yet()}</h3>
                        <p class={Muted}>{t.shipments_shipments_appear_here_once_a_paid()}</p>
                    </div>
                } else {
                    <ul class={Cards}>
                        for shipment in shipments {
                            <li><ShipmentCardView t={t} p={p} shipment={shipment} /></li>
                        }
                    </ul>
                }
            </section>
        </div>
    }
}

/// A shipment in the list: its tracking (or its reference), status, quantity and Open shipment.
#[component(css = ShipmentPage)]
fn ShipmentCardView<'a>(t: ShipmentsMsg, p: Pilot, shipment: &'a ShipmentCard) -> impl Render {
    let title = match &shipment.tracking_identifier {
        Some(tracking) => t.list_tracking_title(tracking).to_string(),
        None => t.list_shipment(&shipment.display_reference).to_string(),
    };
    let lines = match shipment.line_count {
        1 => p.shipments_line(1).to_string(),
        n => p.shipments_lines(n).to_string(),
    };
    let quantity = format!("{}{} {}{lines}", t.list_quantity(), shipment.total_quantity, t.list_across());
    let tracking = format!("{}{}", t.list_tracking(), t.list_not_attached_yet());
    let open = crate::app::url::Shipment { id: &shipment.shipment_id }.href();
    let status = shipment.status.as_str();
    html! {
        <article class={(Card, Raised)}>
            <div class={Stack}>
                <h3 class={CardTitle}>{&title}</h3>
                <span class={Badge} data-tone={tone(status)}>{status}</span>
            </div>
            <p class={Muted}>{&quantity}</p>
            if shipment.tracking_identifier.is_none() {
                <p class={Muted}>{&tracking}</p>
            }
            <p class={Actions}><a class={Secondary} href={&open}>{t.list_open_shipment()}</a></p>
        </article>
    }
}

/// A fact: its label, its value and how it reads (`DetailConfidenceModule`'s item tone).
struct Fact {
    label: String,
    value: String,
    tone: &'static str,
}

fn fact(label: &str, value: impl Into<String>) -> Fact {
    Fact { label: label.trim_end().to_owned(), value: value.into(), tone: "success" }
}

fn toned(label: &str, value: impl Into<String>, tone: &'static str) -> Fact {
    Fact { tone, ..fact(label, value) }
}

/// "Required" or "Not required" (`formatPostagePolicyRequirement`).
fn required(t: ShipmentsMsg, required: bool) -> &'static str {
    if required { t.detail_policy_required() } else { t.detail_policy_not_required() }
}

/// A policy's reasons, or that it recorded none (`formatPostagePolicyReasons`).
fn reasons(t: ShipmentsMsg, reasons: &[String]) -> String {
    if reasons.is_empty() { t.detail_policy_no_reasons().to_owned() } else { reasons.join(", ") }
}

fn or_not_recorded(t: ShipmentsMsg, value: Option<&str>) -> String {
    value.unwrap_or(t.detail_not_recorded_yet()).to_owned()
}

/// A diagnostic's "true" or "false" as Required or Not required (`formatDiagnosticBoolean`).
fn diagnostic_boolean(t: ShipmentsMsg, value: Option<&str>) -> &'static str {
    match value {
        Some("true") => t.detail_policy_required(),
        Some("false") => t.detail_policy_not_required(),
        _ => t.detail_not_recorded_yet(),
    }
}

/// The postage, in the request's locale (`formatMoney(centsToMoneyAmount(..))`).
fn postage(t: ShipmentsMsg, shipment: &ShipmentDetail) -> String {
    let currency = shipment.postage_currency.as_deref().unwrap_or("USD");
    match (shipment.postage_amount_cents, Currency::parse(currency)) {
        (Some(cents), Some(currency)) => t.money(Decimal::new(i128::from(cents), 2), currency).to_string(),
        (Some(cents), None) => format!("{} {currency}", Decimal::new(i128::from(cents), 2)),
        (None, _) => t.detail_not_selected_yet_4().to_owned(),
    }
}

/// The shipment's page (`FulfillmentShipmentDetailPage`).
#[component(css)]
pub fn ShipmentPage<'a>(t: ShipmentsMsg, p: Pilot, viewer: &'a Viewer, screen: &'a ShipmentScreen) -> impl Render {
    let s = &screen.shipment;
    let side = screen.side;
    let seller = matches!(side, Side::Seller);
    let counterpart = match side {
        Side::Buyer => s.seller_display_name.as_deref().unwrap_or(&s.seller_account_id),
        Side::Seller => s.buyer_display_name.as_deref().unwrap_or(&s.buyer_account_id),
    };
    let eyebrow = if seller { t.detail_seller() } else { t.detail_buyer() };
    let title = t.detail_shipment(&s.display_reference).to_string();
    let description = t.detail_order_with_counterpart(&display_reference(&s.order_id), counterpart).to_string();
    let back = match side {
        Side::Buyer => crate::app::url::Shipments.href(),
        Side::Seller => on_marketplace("/account/sales/shipments"),
    };
    let slip = crate::packing_slips::href(&s.shipment_id);
    let on_market = on_marketplace(&format!("/account/sales/shipments/{}", crate::api::segment(&s.shipment_id)));
    let start = crate::app::url::PackingStart { id: &s.shipment_id }.href();
    let packing = crate::app::url::Packing { id: &s.shipment_id, place: Default::default() }.href();
    let policy = s.shipping_plan_snapshot.as_ref().and_then(|plan| plan.postage_policy_snapshot.as_ref());
    let step = |done: bool| if done { "complete" } else { "upcoming" };
    let progress = match s.status.as_str() {
        "delivered" => "complete",
        "exception" => "issue",
        _ => "current",
    };
    let steps = [
        (s.status.clone(), format!("{}{}", t.detail_package_state(), s.package_status), progress),
        (
            label(t.detail_tracking()).to_owned(),
            s.tracking_identifier.clone().unwrap_or_else(|| t.detail_not_attached_yet().to_owned()),
            step(s.tracking_identifier.is_some()),
        ),
        (
            label(t.detail_carrier()).to_owned(),
            s.carrier_name.clone().unwrap_or_else(|| t.detail_not_selected_yet_3().to_owned()),
            step(s.carrier_name.is_some()),
        ),
    ];
    let mut facts = Vec::new();
    if let (Side::Buyer, Some(at)) = (side, s.delivered_at.as_deref()) {
        let at = parse_timestamp(at)
            .map_or_else(|| at.to_owned(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
        facts.push(fact(t.detail_delivered_at(), at));
    }
    facts.extend([
        fact(t.detail_shipping_option(), s.shipping_option.clone()),
        fact(t.detail_shipping_method(), s.shipping_method.as_deref().unwrap_or(t.detail_not_selected_yet())),
        fact(t.detail_service_level(), s.postage_service_level.as_deref().unwrap_or(t.detail_not_selected_yet_2())),
        fact(t.detail_label_status(), s.label_status.clone()),
        fact(t.detail_label_reference(), or_not_recorded(t, s.label_reference.as_deref())),
        fact(t.detail_postage_provider(), s.postage_provider_name.as_deref().unwrap_or(t.detail_not_selected_yet_4())),
        fact(t.detail_package_count(), s.package_count.map_or_else(|| t.detail_not_recorded_yet().to_owned(), |n| n.to_string())),
    ]);
    let cover = [
        (label(t.detail_tracking()), s.tracking_identifier.clone().unwrap_or_else(|| t.detail_not_attached_yet().to_owned())),
        (label(t.detail_label_status()), s.label_status.clone()),
        (label(t.detail_postage()), postage(t, s)),
    ];
    let refund = s.label_refund_status.as_ref().map(|status| match &s.label_refund_reference {
        Some(reference) => format!("{status}{}", t.detail_refund_reference(reference)),
        None => status.clone(),
    });
    html! {
        <div class={Page}>
            <header class={Heading}>
                <div class={Stack}>
                    <p class={Eyebrow}>{eyebrow}</p>
                    <h1 class={Title}>{&title}</h1>
                    <p class={Muted}>{&description}</p>
                </div>
                <div class={Actions}>
                    if seller {
                        <a
                            class={Primary}
                            href={&slip}
                            target="_blank"
                            rel="noopener"
                            aria-label={t.detail_print_packing_slip_new_tab()}
                        >
                            {t.detail_print_packing_slip()}
                        </a>
                    }
                    if seller && s.status == "awaiting-package" {
                        <WriteForm
                            p={p}
                            viewer={viewer}
                            id={&s.shipment_id}
                            action={&start}
                            attempt={AttemptInput::FIELDS.attempt}
                            enabled={true}
                        >
                            <button type="submit" class={Primary}>{t.detail_start_packing()}</button>
                        </WriteForm>
                    }
                    if seller && s.status == "packing" {
                        <a class={Primary} href={&packing}>{t.detail_resume_packing()}</a>
                    }
                    <a class={Secondary} href={&back}>{t.detail_back()}</a>
                </div>
            </header>
            <section class={Part} aria-labelledby="shipment-summary">
                <h2 id="shipment-summary" class={SectionTitle}>{t.detail_summary()}</h2>
                <ol class={Steps}>
                    for (name, detail, state) in &steps {
                        <li class={StepItem} data-state={*state}>
                            <span class={Marker} aria-hidden="true"></span>
                            <span class={Stack}>
                                <span class={Strong}>{name}</span>
                                <span class={Muted}>{detail}</span>
                            </span>
                        </li>
                    }
                </ol>
                <Facts title={t.detail_summary()} description={None} facts={&facts} />
                <section class={Cover} aria-label={t.detail_summary()}>
                    <h3 class={CoverTitle}>{t.detail_summary()}</h3>
                    <ul class={CoverList}>
                        for (name, value) in &cover {
                            <li>
                                <span class={Strong}>{*name}</span>
                                <span class={Muted}>{value}</span>
                            </li>
                        }
                    </ul>
                </section>
                if let Some(policy) = policy {
                    <Policy t={t} policy={policy} />
                }
                if let Some(url) = &s.label_document_url {
                    <p><a class={Secondary} href={url}>{t.detail_open_label_pdf()}</a></p>
                }
                if let Some(error) = &s.label_error_message {
                    <div class={(Banner, Warning)} role="status">
                        <p class={Strong}>{label(t.detail_label_status())}</p>
                        <p>{error}</p>
                    </div>
                }
                if let Some(refund) = &refund {
                    <div class={(Banner, Info)} role="status">
                        <p class={Strong}>{label(t.detail_refund())}</p>
                        <p>{refund}</p>
                    </div>
                }
            </section>
            if seller {
                <Diagnostics t={t} shipment={s} policy={policy} />
            }
            <section class={Part} aria-labelledby="shipment-lines">
                <h2 id="shipment-lines" class={SectionTitle}>{t.detail_lines()}</h2>
                <ul class={List}>
                    for line in &s.lines {
                        <li class={(Card, Tinted)}>
                            <p class={Strong}>{&line.item_title}</p>
                            if let Some(subtitle) = &line.item_subtitle {
                                <p class={Muted}>{subtitle}</p>
                            }
                            <ul class={Chips}>
                                for option in &options(Some(line.product_summary.as_deref().unwrap_or(t.detail_standard()))) {
                                    <li class={Chip}>{option}</li>
                                }
                            </ul>
                            <p>{t.detail_quantity()}{line.quantity}</p>
                        </li>
                    }
                </ul>
            </section>
            <section class={Part} aria-labelledby="shipment-exceptions">
                <h2 id="shipment-exceptions" class={SectionTitle}>{t.detail_exceptions()}</h2>
                if s.exceptions.is_empty() {
                    <div class={Empty}>
                        <h3 class={EmptyTitle}>{t.detail_no_shipment_exceptions_recorded()}</h3>
                    </div>
                } else {
                    <ul class={List}>
                        for exception in &s.exceptions {
                            <li class={(Card, Tinted)}>
                                <p class={Strong}>{&exception.exception_type}</p>
                                <p class={Muted}>{t.detail_raised_at()}{&exception.raised_at}</p>
                                if let Some(notes) = &exception.notes {
                                    <p>{notes}</p>
                                }
                            </li>
                        }
                    </ul>
                }
            </section>
            if seller {
                <section class={Part} aria-labelledby="shipment-actions">
                    <h2 id="shipment-actions" class={SectionTitle}>{t.detail_actions()}</h2>
                    <div class={(Card, Tinted)}>
                        <p class={Muted}>{p.shipments_actions_on_marketplace()}</p>
                        <p class={Actions}><a class={Secondary} href={&on_market}>{p.shipments_open_on_marketplace()}</a></p>
                    </div>
                </section>
            }
        </div>
    }
}

/// A list of facts under a title (`DetailConfidenceModule`): two to a row from 48rem.
#[component(css = ShipmentPage)]
fn Facts<'a>(title: &'a str, description: Option<&'a str>, facts: &'a [Fact]) -> impl Render {
    html! {
        <section class={Module}>
            <h3 class={CardTitle}>{title}</h3>
            if let Some(description) = description {
                <p class={Muted}>{description}</p>
            }
            <dl class={FactList}>
                for f in facts {
                    <div class={FactItem} data-tone={f.tone}>
                        <dt class={FactLabel}>{&f.label}</dt>
                        <dd class={FactValue}>{&f.value}</dd>
                    </div>
                }
            </dl>
        </section>
    }
}

/// What the order's postage policy committed the shipment to.
#[component(css = ShipmentPage)]
fn Policy<'a>(t: ShipmentsMsg, policy: &'a PostagePolicySnapshot) -> impl Render {
    let tone = |warn: bool| if warn { "warning" } else { "success" };
    html! {
        let facts = vec![
        fact(t.detail_postage_policy_version(), policy.policy_version.clone()),
        toned(t.detail_parcel_required(), required(t, policy.parcel_required), tone(policy.parcel_required)),
        toned(t.detail_parcel_reasons(), reasons(t, &policy.parcel_reasons), tone(!policy.parcel_reasons.is_empty())),
        toned(t.detail_signature_required(), required(t, policy.signature_required), tone(policy.signature_required)),
        toned(t.detail_signature_reasons(), reasons(t, &policy.signature_reasons), tone(!policy.signature_reasons.is_empty())),
        toned(t.detail_insurance_required(), required(t, policy.insurance_required), tone(policy.insurance_required)),
        toned(t.detail_insurance_reasons(), reasons(t, &policy.insurance_reasons), tone(!policy.insurance_reasons.is_empty())),
        fact(t.detail_insured_value(), or_not_recorded(t, policy.insured_value_amount.as_deref())),
        fact(t.detail_shipping_evidence_tier(), policy.shipping_evidence_tier.clone()),
    ];
        <Facts title={t.detail_postage_policy()} description={Some(t.detail_postage_policy_description())} facts={&facts} />
    }
}

/// The seller's postage diagnostics: what the policy required, the label's outcome, each label
/// operation and each event the provider sent.
#[component(css = ShipmentPage)]
fn Diagnostics<'a>(t: ShipmentsMsg, shipment: &'a ShipmentDetail, policy: Option<&'a PostagePolicySnapshot>) -> impl Render {
    let s = shipment;
    let recorded = |value: Option<&'static str>| value.unwrap_or(t.detail_not_recorded_yet());
    let tone = |warn: bool| if warn { "warning" } else { "success" };
    let label_status = match &s.label_error_code {
        Some(code) => format!("{} ({code})", s.label_status),
        None => s.label_status.clone(),
    };
    let outcome = match &s.postage_provider_name {
        Some(name) => t.detail_provider_name_mode(name, s.postage_provider_mode.as_deref().unwrap_or("")).to_string(),
        None => t.detail_not_selected_yet_4().to_owned(),
    };
    let facts = vec![
        fact(t.detail_buyer_shipping_option(), s.shipping_option.clone()),
        fact(
            t.detail_postage_policy_version(),
            policy.map_or_else(|| t.detail_not_recorded_yet().to_owned(), |p| p.policy_version.clone()),
        ),
        toned(
            t.detail_parcel_required(),
            recorded(policy.map(|p| required(t, p.parcel_required))),
            tone(policy.is_some_and(|p| p.parcel_required)),
        ),
        toned(
            t.detail_signature_required(),
            recorded(policy.map(|p| required(t, p.signature_required))),
            tone(policy.is_some_and(|p| p.signature_required)),
        ),
        toned(
            t.detail_insurance_required(),
            recorded(policy.map(|p| required(t, p.insurance_required))),
            tone(policy.is_some_and(|p| p.insurance_required)),
        ),
        fact(
            t.detail_shipping_evidence_tier(),
            policy.map_or_else(|| t.detail_not_recorded_yet().to_owned(), |p| p.shipping_evidence_tier.clone()),
        ),
        toned(t.detail_label_status(), label_status, if s.label_error_code.is_some() { "warning" } else { "neutral" }),
        fact(t.detail_provider_outcome(), outcome),
    ];
    html! {
        <section class={Part} aria-labelledby="shipment-diagnostics">
            <h2 id="shipment-diagnostics" class={SectionTitle}>{t.detail_postage_diagnostics()}</h2>
            <Facts title={t.detail_postage_diagnostics()} description={None} facts={&facts} />
            if s.postage_label_operations.is_empty() {
                <div class={Empty}>
                    <h3 class={EmptyTitle}>{t.detail_no_postage_operations_recorded()}</h3>
                </div>
            } else {
                for operation in &s.postage_label_operations {
                    <Operation t={t} operation={operation} />
                }
            }
            if !s.postage_provider_events.is_empty() {
                <div class={Part}>
                    <h3 class={CardTitle}>{t.detail_provider_events()}</h3>
                    for event in &s.postage_provider_events {
                        <Event t={t} event={event} />
                    }
                </div>
            }
        </section>
    }
}

/// A label operation: what it asked the provider for, the address override and its error.
#[component(css = ShipmentPage)]
fn Operation<'a>(t: ShipmentsMsg, operation: &'a PostageOperation) -> impl Render {
    let o = operation;
    let value = |v: &Option<String>| or_not_recorded(t, v.as_deref());
    let heading = t.detail_operation_kind_status(&o.operation_kind, &o.status).to_string();
    let facts = vec![
        fact(t.detail_usps_service(), value(&o.requested_service_level)),
        fact(t.detail_delivery_confirmation(), value(&o.requested_delivery_confirmation)),
        fact(t.detail_insurance_amount(), value(&o.requested_insurance_amount)),
        fact(t.detail_mailpiece_class(), value(&o.requested_mailpiece_class)),
        fact(t.detail_postage_policy_version(), value(&o.policy_version)),
        fact(t.detail_parcel_required(), diagnostic_boolean(t, o.parcel_required.as_deref())),
        fact(t.detail_signature_required(), diagnostic_boolean(t, o.signature_required.as_deref())),
        fact(t.detail_insurance_required(), diagnostic_boolean(t, o.insurance_required.as_deref())),
        fact(t.detail_insured_value(), value(&o.insured_value_amount)),
        fact(t.detail_shipping_evidence_tier(), value(&o.shipping_evidence_tier)),
    ];
    let override_note = o.address_override_changed_side.as_ref().map(|side| match &o.address_override_reason {
        Some(reason) => t.detail_address_override_with_reason(side, reason).to_string(),
        None => t.detail_address_override_with_side(side).to_string(),
    });
    html! {
        <div class={Part}>
            <p class={Strong}>{&heading}</p>
            <Facts title={&o.operation_key} description={None} facts={&facts} />
            if let Some(note) = &override_note {
                <p class={Muted}>{note}</p>
            }
            if let Some(error) = &o.error_message {
                <div class={(Banner, Warning)} role="status">
                    <p class={Strong}>{label(t.detail_label_status())}</p>
                    <p>{error}</p>
                </div>
            }
        </div>
    }
}

/// An event the postage provider sent.
#[component(css = ShipmentPage)]
fn Event<'a>(t: ShipmentsMsg, event: &'a PostageProviderEvent) -> impl Render {
    let e = event;
    let value = |v: &Option<String>| or_not_recorded(t, v.as_deref());
    html! {
        let title = t.detail_provider_event_kind_status(&e.event_kind, &e.status).to_string();
        let facts = vec![
        fact(t.detail_postage_provider(), t.detail_provider_name_mode(&e.provider_name, &e.provider_mode).to_string()),
        fact(t.detail_tracking(), value(&e.tracking_identifier)),
        fact(t.detail_provider_processing_result(), value(&e.processing_result)),
        fact(t.detail_provider_status_detail(), value(&e.status_detail)),
    ];
        <Facts title={&title} description={None} facts={&facts} />
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_reads_as_marketplace_tones_it() {
        assert_eq!(tone("delivered"), "success");
        assert_eq!(tone("exception"), "warning");
        assert_eq!(tone("label-attached"), "accent");
        assert_eq!(tone("awaiting-package"), "neutral");
    }
}
