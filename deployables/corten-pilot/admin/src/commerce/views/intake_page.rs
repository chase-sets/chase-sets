//! Return Intake's station (`FacilityIntakePage`). Top to bottom: the header with the connection
//! status, the banners, the facility form (before a facility is open), the scan, six figures (one
//! column on a phone, two from 40rem, three from 64rem), then the scanned package beside its form
//! (stacked on a phone) or the unidentified-package form, the queue and the unidentified packages,
//! each table scrolling on its own on a phone. Every form is a plain post or get; the script only
//! says when the station is offline (and disables its submits, as admin-web does) and prints.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    commerce::intake::{IntakeForm, Shipment, StationScreen, duration, url},
    text::{Com, Pilot},
};

/// A time as the queue shows it, else the API's text, else `missing`.
fn when(t: Com, at: Option<&str>, missing: &str) -> String {
    match at {
        Some(at) => parse_timestamp(at)
            .map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string()),
        None => missing.to_owned(),
    }
}

/// One choice of a select: its value and its words.
type Choice = (&'static str, &'static str);

fn discrepancies(t: Com) -> [Choice; 7] {
    [
        ("expected", t.ri_discrepancy_expected()),
        ("missing", t.ri_discrepancy_missing()),
        ("extra", t.ri_discrepancy_extra()),
        ("substituted", t.ri_discrepancy_substituted()),
        ("damaged", t.ri_discrepancy_damaged()),
        ("empty-package", t.ri_discrepancy_empty_package()),
        ("unreadable", t.ri_discrepancy_unreadable()),
    ]
}

fn package_conditions(t: Com) -> [Choice; 5] {
    [
        ("intact", t.ri_condition_intact()),
        ("damaged", t.ri_condition_damaged()),
        ("opened", t.ri_condition_opened()),
        ("empty", t.ri_condition_empty()),
        ("unreadable", t.ri_condition_unreadable()),
    ]
}

fn seal_conditions(t: Com) -> [Choice; 5] {
    [
        ("intact", t.ri_condition_intact()),
        ("broken", t.ri_condition_broken()),
        ("missing", t.ri_condition_missing()),
        ("not-applicable", t.ri_condition_not_applicable()),
        ("unreadable", t.ri_condition_unreadable()),
    ]
}

fn dispositions(t: Com) -> [Choice; 3] {
    [
        ("completed", t.ri_disposition_complete()),
        ("quarantine", t.ri_disposition_quarantine()),
        ("manual-review", t.ri_disposition_manual_review()),
    ]
}

#[component(css = IntakePage)]
fn Select<'a>(label: &'a str, name: corten::FieldName<String>, choices: &'a [Choice]) -> impl Render {
    html! {
        <label class={Field}>
            <span>{label}</span>
            <select name={name} required>
                for (value, words) in choices {
                    <option value={*value}>{*words}</option>
                }
            </select>
        </label>
    }
}

/// The receipt fields both custody forms share: station, time, conditions, weight, custody ID.
#[component(css = IntakePage)]
fn Receipt(t: Com) -> impl Render {
    let f = IntakeForm::FIELDS;
    html! {
        <label class={Field}>
            <span>{t.ri_facility_station()}</span>
            <input type="text" name={f.station_id} required autocomplete="off">
        </label>
        <label class={Field}>
            <span>{t.ri_receipt_timestamp()}</span>
            <input type="datetime-local" name={f.received_at} required>
        </label>
        <Select label={t.ri_package_condition()} name={f.package_condition} choices={&package_conditions(t)} />
        <Select label={t.ri_seal_condition()} name={f.seal_condition} choices={&seal_conditions(t)} />
        <label class={Field}>
            <span>{t.ri_measured_weight()}</span>
            <input type="number" name={f.measured_weight_ounces} min="0.1" step="0.1" inputmode="decimal">
        </label>
        <label class={Field}>
            <span>{t.ri_internal_custody_identifier()}</span>
            <input type="text" name={f.custody_identifier} required autocomplete="off">
        </label>
    }
}

#[component(css = IntakePage)]
fn Photos<'a>(label: &'a str, description: &'a str) -> impl Render {
    let f = IntakeForm::FIELDS;
    html! {
        <label class={Field}>
            <span>{label}</span>
            <small class={Muted}>{description}</small>
            <input type="file" name={f.evidence} accept="image/jpeg,image/png,image/webp" capture="environment" multiple required>
        </label>
    }
}

/// The scanned package's facts (`TaskSummary`).
#[component(css = IntakePage)]
fn Summary<'a>(t: Com, shipment: &'a Shipment) -> impl Render {
    let intake = shipment.intake();
    let items = shipment.items();
    let package = shipment.package();
    html! {
        <dl class={Facts}>
            <div>
                <dt>{t.ri_return_shipment()}</dt>
                <dd>{&shipment.return_shipment_id}</dd>
            </div>
            <div>
                <dt>{t.ri_tracking()}</dt>
                <dd>{shipment.tracking_identifier.as_deref().unwrap_or(t.ri_not_available())}</dd>
            </div>
            <div>
                <dt>{t.ri_order()}</dt>
                <dd>{&shipment.order_id}</dd>
            </div>
            <div>
                <dt>{t.ri_expected_items()}</dt>
                <dd>{items.as_deref().unwrap_or(t.ri_no_item_summary())}</dd>
            </div>
            <div>
                <dt>{t.ri_package()}</dt>
                <dd>{package.as_deref().unwrap_or(t.ri_no_package_measurements())}</dd>
            </div>
            <div>
                <dt>{t.ri_safe_handling()}</dt>
                <dd>{shipment.handling().unwrap_or(t.ri_safe_handling_fallback())}</dd>
            </div>
            <div>
                <dt>{t.ri_carrier_delivered()}</dt>
                <dd>{when(t, shipment.delivered_at.as_deref(), t.ri_not_recorded())}</dd>
            </div>
            <div>
                <dt>{t.ri_facility_intake()}</dt>
                <dd>{when(t, shipment.received_at.as_deref(), t.ri_not_completed())}</dd>
            </div>
            if let Some(intake) = &intake {
                <div>
                    <dt>{t.ri_disposition()}</dt>
                    <dd>{&intake.disposition}</dd>
                </div>
                <div>
                    <dt>{t.ri_custody_identifier()}</dt>
                    <dd>{intake.custody_identifier.as_deref().unwrap_or(t.ri_not_assigned())}</dd>
                </div>
            }
        </dl>
    }
}

#[component(css, js)]
pub fn IntakePage<'a>(t: Com, p: Pilot, screen: &'a StationScreen) -> impl Render {
    let f = IntakeForm::FIELDS;
    let open = !screen.facility_id.is_empty();
    let here = url::Intake {
        station: url::Station {
            facility_id: open.then(|| screen.facility_id.clone()),
            identifier: (!screen.identifier.is_empty()).then(|| screen.identifier.clone()),
            ..url::Station::default()
        },
    };
    let station = url::Intake {
        station: url::Station { facility_id: open.then(|| screen.facility_id.clone()), ..url::Station::default() },
    };
    let status = match screen.result.as_deref() {
        Some("duplicate") => Some(t.ri_status_duplicate()),
        Some("completed") => Some(t.ri_status_completed()),
        Some("unidentified") => Some(t.ri_status_unidentified()),
        Some("reconciled") => Some(t.ri_status_reconciled()),
        Some("corrected") => Some(t.ri_status_corrected()),
        _ => None,
    };
    let intake = screen.resolved.as_ref().and_then(Shipment::intake);
    let review = intake.as_ref().is_some_and(|i| i.disposition == "quarantine" || i.disposition == "manual-review");
    let version = screen.expected_version.map(|v| v.to_string()).unwrap_or_default();
    html! {
        <div class={Station} on:connect={js::watch(target, signal)}>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.ri_eyebrow()}</p>
                    <h1>{t.ri_title()}</h1>
                    <p class={Muted}>{t.ri_description()}</p>
                </div>
                <div class={Connection} role="status" aria-live="polite">
                    <span class={(Pill, Online)}>{t.ri_online()}</span>
                    <span class={(Pill, Offline)}>{t.ri_offline()}</span>
                    <p class={(Muted, OfflineNote)}>{t.ri_offline_description()}</p>
                </div>
            </header>
            if let Some(error) = &screen.error {
                <div class={Alert} role="alert">
                    <p class={Strong}>{t.ri_not_saved()}</p>
                    <p>{error}</p>
                    <a class={(Button, Secondary)} href={&here}>{t.ri_reload_current_state()}</a>
                </div>
            }
            if let Some(status) = status {
                <p class={Success} role="status">{status}</p>
            }
            if screen.catching_up {
                <p class={Note} role="status">{p.error_pending()}</p>
            }
            if !open {
                <section class={Card}>
                    <h2 class={Heading}>{t.ri_choose_facility()}</h2>
                    <p class={Muted}>{t.ri_choose_facility_description()}</p>
                    <form class={Inline} method="get" action={url::Intake::default()}>
                        <label class={Field}>
                            <span>{t.ri_facility_identifier()}</span>
                            <input type="text" name="facilityId" required autofocus autocomplete="off">
                        </label>
                        <button type="submit" class={Button}>{t.ri_open_facility_station()}</button>
                    </form>
                </section>
            }
            <form class={(Card, Inline)} method="get" action={url::Intake::default()}>
                <input type="hidden" name="facilityId" value={&screen.facility_id}>
                <label class={Field}>
                    <span>{t.ri_scan_label()}</span>
                    <small class={Muted}>{t.ri_scan_description()}</small>
                    <input
                        type="search"
                        name="identifier"
                        value={&screen.identifier}
                        placeholder={t.ri_scan_placeholder()}
                        autocomplete="off"
                        spellcheck="false"
                        required
                        autofocus={open}
                        disabled={!open}
                    >
                </label>
                <button type="submit" class={Button} disabled={!open}>{t.ri_resolve_package()}</button>
            </form>
            <dl class={Stats}>
                <div class={Stat}>
                    <dt>{t.ri_metric_delivered_not_intaken()}</dt>
                    <dd>{screen.metrics.delivered_not_intaken_count}</dd>
                </div>
                <div class={Stat}>
                    <dt>{t.ri_metric_oldest_waiting()}</dt>
                    <dd>{duration(screen.metrics.oldest_delivered_not_intaken_age_seconds)}</dd>
                </div>
                <div class={Stat}>
                    <dt>{t.ri_metric_discrepancy_rate()}</dt>
                    <dd>{format!("{}%", (screen.metrics.discrepancy_rate * 100.0).round())}</dd>
                </div>
                <div class={Stat}>
                    <dt>{t.ri_metric_unidentified()}</dt>
                    <dd>{screen.metrics.unidentified_package_count}</dd>
                </div>
                <div class={Stat}>
                    <dt>{t.ri_metric_duplicate_scans()}</dt>
                    <dd>{screen.metrics.duplicate_scan_count}</dd>
                </div>
                <div class={Stat}>
                    <dt>{t.ri_metric_average_latency()}</dt>
                    <dd>{duration(screen.metrics.average_intake_latency_seconds)}</dd>
                </div>
            </dl>
            if let Some(shipment) = &screen.resolved {
                <div class={Workstation}>
                    <section class={Card}>
                        <h2 class={Heading}>{t.ri_expected_package()}</h2>
                        <p class={Muted}>{t.ri_expected_package_description()}</p>
                        <Summary t={t} shipment={shipment} />
                        if intake.is_some() {
                            <button
                                type="button"
                                class={(Button, Secondary)}
                                hidden
                                on:connect={js::reveal(target)}
                                on:click={js::print()}
                            >
                                {t.ri_print_custody_identifier()}
                            </button>
                        }
                    </section>
                    if let Some(intake) = &intake {
                        <section class={Card}>
                            <h2 class={Heading}>{t.ri_existing_result()}</h2>
                            <p class={Muted}>{t.ri_existing_result_description()}</p>
                            if review {
                                <span class={(Pill, Warning)}>{t.ri_exception_routed()}</span>
                                <div class={Warn} role="status">
                                    <p class={Strong}>{t.ri_routed_to(&intake.disposition)}</p>
                                    <p>{t.ri_duplicate_description()}</p>
                                </div>
                            } else {
                                <span class={(Pill, Done)}>{t.ri_complete()}</span>
                                <div class={Note} role="status">
                                    <p class={Strong}>{t.ri_double_scan_prevention()}</p>
                                    <p>{t.ri_duplicate_description()}</p>
                                </div>
                            }
                            <form class={Form} method="post" action={&here} enctype="multipart/form-data">
                                <input type="hidden" name={f.intent} value="correct">
                                <input type="hidden" name={f.facility_id} value={&screen.facility_id}>
                                <input type="hidden" name={f.return_shipment_id} value={&shipment.return_shipment_id}>
                                <input type="hidden" name={f.expected_version} value={&version}>
                                <label class={Field}>
                                    <span>{t.ri_correction_reason()}</span>
                                    <textarea name={f.reason} rows="3" required></textarea>
                                </label>
                                <label class={Field}>
                                    <span>{t.ri_corrected_owner()}</span>
                                    <input type="text" name={f.owner}>
                                </label>
                                <label class={Field}>
                                    <span>{t.ri_corrected_next_action()}</span>
                                    <input type="text" name={f.next_action}>
                                </label>
                                <label class={Field}>
                                    <span>{t.ri_corrected_custody_identifier()}</span>
                                    <input type="text" name={f.custody_identifier} autocomplete="off">
                                </label>
                                <button type="submit" class={Button}>{t.ri_record_correction()}</button>
                            </form>
                        </section>
                    } else {
                        <section class={Card}>
                            <h2 class={Heading}>{t.ri_record_custody()}</h2>
                            <p class={Muted}>{t.ri_record_custody_description()}</p>
                            <form
                                class={Form}
                                method="post"
                                action={&here}
                                enctype="multipart/form-data"
                                aria-describedby="intake-help"
                            >
                                <input type="hidden" name={f.intent} value="complete">
                                <input type="hidden" name={f.return_shipment_id} value={&shipment.return_shipment_id}>
                                <input type="hidden" name={f.facility_id} value={&screen.facility_id}>
                                <input type="hidden" name={f.expected_version} value={&version}>
                                <input type="hidden" name={f.idempotency_key} value={&screen.form_token}>
                                <div class={Grid}>
                                    <Receipt t={t} />
                                </div>
                                <Photos label={t.ri_custody_evidence()} description={t.ri_evidence_description()} />
                                <div class={Grid}>
                                    <Select label={t.ri_observed_state()} name={f.discrepancy_type} choices={&discrepancies(t)} />
                                    <Select label={t.ri_disposition()} name={f.disposition} choices={&dispositions(t)} />
                                    <label class={Field}>
                                        <span>{t.ri_expected_item_reference()}</span>
                                        <input type="text" name={f.expected_item_reference}>
                                    </label>
                                    <label class={Field}>
                                        <span>{t.ri_observed_item_reference()}</span>
                                        <input type="text" name={f.observed_item_reference}>
                                    </label>
                                    <label class={Field}>
                                        <span>{t.ri_quantity()}</span>
                                        <input
                                            type="number"
                                            name={f.quantity}
                                            min="1"
                                            step="1"
                                            value="1"
                                            inputmode="numeric"
                                            required
                                        >
                                    </label>
                                    <label class={Field}>
                                        <span>{t.ri_owner()}</span>
                                        <input type="text" name={f.owner} value={t.ri_eyebrow()} required>
                                    </label>
                                </div>
                                <label class={Field}>
                                    <span>{t.ri_next_action()}</span>
                                    <input type="text" name={f.next_action} value={t.ri_complete_custody_handoff()} required>
                                </label>
                                <label class={Field}>
                                    <span>{t.ri_condition_notes()}</span>
                                    <textarea name={f.notes} rows="3"></textarea>
                                </label>
                                <p id="intake-help" role="note" class={Muted}>{t.ri_physical_truth_reminder()}</p>
                                <button type="submit" class={Button}>{t.ri_complete_facility_intake()}</button>
                            </form>
                        </section>
                    }
                </div>
            } else if open {
                <section class={Card}>
                    <h2 class={Heading}>{t.ri_unidentified_exception()}</h2>
                    <p class={Muted}>{t.ri_unidentified_exception_description()}</p>
                    <form class={Form} method="post" action={&here} enctype="multipart/form-data">
                        <input type="hidden" name={f.intent} value="unidentified">
                        <input type="hidden" name={f.facility_id} value={&screen.facility_id}>
                        <input type="hidden" name={f.idempotency_key} value={&screen.form_token}>
                        <div class={Grid}>
                            <Receipt t={t} />
                            <label class={Field}>
                                <span>{t.ri_exception_owner()}</span>
                                <input type="text" name={f.owner} value={t.ri_eyebrow()} required>
                            </label>
                        </div>
                        <Photos label={t.ri_package_evidence()} description={t.ri_package_evidence_description()} />
                        <label class={Field}>
                            <span>{t.ri_identification_notes()}</span>
                            <textarea name={f.notes} rows="3"></textarea>
                        </label>
                        <label class={Field}>
                            <span>{t.ri_next_action()}</span>
                            <input type="text" name={f.next_action} value={t.ri_hold_for_review()} required>
                        </label>
                        <button type="submit" class={Button}>{t.ri_record_unidentified()}</button>
                    </form>
                </section>
            }
            <section class={Card}>
                <h2 class={Heading}>{t.ri_queue()}</h2>
                <p class={Muted}>{t.ri_queue_description()}</p>
                <div class={Scroll}>
                    <table class={Table}>
                        <caption>{t.ri_queue_caption()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.ri_return_shipment()}</th>
                                <th scope="col">{t.ri_tracking()}</th>
                                <th scope="col">{t.ri_status()}</th>
                                <th scope="col">{t.ri_delivered()}</th>
                                <th scope="col">{t.ri_received()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for item in &screen.queue {
                                <tr>
                                    <td class={Words}>{&item.return_shipment_id}</td>
                                    <td class={Words}>{item.tracking_identifier.as_deref().unwrap_or("\u{2014}")}</td>
                                    <td>{&item.status}</td>
                                    <td>{when(t, item.delivered_at.as_deref(), "\u{2014}")}</td>
                                    <td>{when(t, item.received_at.as_deref(), "\u{2014}")}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
            <section class={Card}>
                <h2 class={Heading}>{t.ri_unidentified_packages()}</h2>
                <p class={Muted}>{t.ri_unidentified_description()}</p>
                <div class={Scroll}>
                    <table class={Table}>
                        <caption>{t.ri_unidentified_caption()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.ri_custody_identifier()}</th>
                                <th scope="col">{t.ri_received()}</th>
                                <th scope="col">{t.ri_condition()}</th>
                                <th scope="col">{t.ri_reconciled_return_shipment()}</th>
                                <th scope="col">{t.ri_reconcile()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for item in &screen.unidentified {
                                <tr>
                                    <td class={Words}>{&item.custody_identifier}</td>
                                    <td>{when(t, Some(&item.received_at), "\u{2014}")}</td>
                                    <td>{&item.package_condition}</td>
                                    <td class={Words}>
                                        {item.return_shipment_id.as_deref().unwrap_or(t.ri_awaiting_reconciliation())}
                                    </td>
                                    <td>
                                        if item.return_shipment_id.is_some() {
                                            {t.ri_complete()}
                                        } else {
                                            <form class={Form} method="post" action={&station} enctype="multipart/form-data">
                                                <input type="hidden" name={f.intent} value="reconcile">
                                                <input type="hidden" name={f.facility_id} value={&screen.facility_id}>
                                                <input
                                                    type="hidden"
                                                    name={f.unidentified_package_id}
                                                    value={&item.unidentified_package_id}
                                                >
                                                <label class={Field}>
                                                    <span>{t.ri_return_shipment()}</span>
                                                    <input type="text" name={f.return_shipment_id} required autocomplete="off">
                                                </label>
                                                <label class={Field}>
                                                    <span>{t.ri_reason()}</span>
                                                    <input type="text" name={f.reason} required>
                                                </label>
                                                <button type="submit" class={(Button, Secondary)}>{t.ri_reconcile()}</button>
                                            </form>
                                        }
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    }
}
