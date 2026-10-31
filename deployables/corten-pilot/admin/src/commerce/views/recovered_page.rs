//! Recovered Returns (`RecoveredItemsPage`). Top to bottom: the header, the recovery figures with
//! the recovered value, the custody and disposition queue (scrolling on its own on a phone), and the
//! action form, its fields in one column on a phone, two from 40rem and three from 64rem.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    commerce::{
        recovered::{ActionForm, RecoveredScreen},
        usd,
    },
    text::{Com, Pilot},
};

/// A status's pill, toned as admin-web's `statusTone` tones it.
#[component(css = RecoveredPage)]
fn Status<'a>(status: &'a str) -> impl Render {
    let tone = match status {
        "sellable" | "transferred" => Good,
        "disposed" | "merged" => Neutral,
        "authenticity-review" | "awaiting-identification" => Warning,
        _ => Accent,
    };
    html! { <span class={(Pill, tone)}>{status}</span> }
}

fn when(t: Com, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string())
}

#[component(css = RecoveredPage)]
fn Text<'a>(label: &'a str, name: corten::FieldName, value: &'a str) -> impl Render {
    html! {
        <label class={Field}>
            <span>{label}</span>
            <input type="text" name={name} value={value}>
        </label>
    }
}

#[component(css = RecoveredPage)]
fn Figure<'a>(label: &'a str, value: String, attention: bool) -> impl Render {
    html! {
        <tr>
            <th scope="row">{label}</th>
            <td><span class={(Pill, if attention { Warning } else { Good })}>{value}</span></td>
        </tr>
    }
}

#[component(css)]
pub fn RecoveredPage<'a>(t: Com, p: Pilot, screen: &'a RecoveredScreen) -> impl Render {
    let f = ActionForm::FIELDS;
    let form = &screen.form;
    let m = &screen.metrics;
    let count = |n: u64| (n.to_string(), n > 0);
    let actions = [
        ("identify", t.rr_action_identify()),
        ("inspect", t.rr_action_inspect()),
        ("require-authenticity-review", t.rr_action_require_authenticity()),
        ("complete-authenticity-review", t.rr_action_complete_authenticity()),
        ("record-authority", t.rr_action_authority()),
        ("decide-disposition", t.rr_action_disposition()),
        ("record-value", t.rr_action_value()),
        ("correct-source", t.rr_action_correct()),
        ("merge", t.rr_action_merge()),
    ];
    let figures = [
        (t.rr_unidentified(), count(m.unidentified_count)),
        (t.rr_quarantined(), count(m.quarantined_count)),
        (t.rr_sellable(), count(m.sellable_count)),
        (t.rr_terminal(), count(m.terminal_count)),
        (t.rr_recovery_rate(), (format!("{}%", (m.recovery_rate * 100.0).round()), false)),
        (t.rr_average_age(), (format!("{}", m.average_age_hours.round()), m.average_age_hours.round() > 0.0)),
    ];
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.rr_inventory()}</p>
                <h1>{t.rr_title()}</h1>
                <p class={Muted}>{t.rr_description()}</p>
            </header>
            if screen.catching_up {
                <p class={Note} role="status">{p.error_pending()}</p>
            }
            <section class={Card} aria-labelledby="rr-metrics">
                <h2 class={Heading} id="rr-metrics">{t.rr_metrics()}</h2>
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{t.rr_signal()}</th>
                                <th scope="col">{t.rr_value()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (label, (value, attention)) in figures {
                                <Figure label={label} value={value} attention={attention} />
                            }
                        </tbody>
                    </table>
                </div>
                <p class={Muted}>
                    {t.rr_recovery_summary(&usd(t, &m.gross_value), &usd(t, &m.disposition_cost), &usd(t, &m.net_recovered_value))}
                </p>
            </section>
            <section class={Card} aria-labelledby="rr-queue">
                <h2 class={Heading} id="rr-queue">{t.rr_queue()}</h2>
                if screen.items.is_empty() {
                    <div class={Empty}>
                        <p class={Strong}>{t.rr_empty_title()}</p>
                        <p class={Muted}>{t.rr_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.rr_status()}</th>
                                    <th scope="col">{t.rr_custody()}</th>
                                    <th scope="col">{t.rr_identity()}</th>
                                    <th scope="col">{t.rr_condition()}</th>
                                    <th scope="col">{t.rr_disposition()}</th>
                                    <th scope="col">{t.rr_received()}</th>
                                    <th scope="col">{t.rr_evidence()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &screen.items {
                                    <tr>
                                        <td><Status status={&item.status} /></td>
                                        <td class={Words}>{&item.custody_identifier}</td>
                                        <td class={Words}>{item.catalog_item_id.as_deref().unwrap_or(t.rr_unidentified())}</td>
                                        <td>{item.condition_grade.as_deref().unwrap_or(t.rr_pending())}</td>
                                        <td>{item.disposition.as_deref().unwrap_or(t.rr_pending())}</td>
                                        <td>{when(t, &item.received_at)}</td>
                                        <td>{t.rr_evidence_count(item.evidence_references.len())}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="rr-action">
                <h2 class={Heading} id="rr-action">{t.rr_action_title()}</h2>
                <p class={Muted}>{t.rr_action_description()}</p>
                if let Some(error) = &screen.error {
                    <p class={Alert} role="alert">{error}</p>
                }
                if let Some((item, status)) = &screen.done {
                    <p class={Success} role="status">
                        {t.rr_action_completed(item, status.as_deref().unwrap_or(t.rr_action_updated()))}
                    </p>
                }
                <form class={Form} method="post">
                    <div class={Grid}>
                        <label class={Field}>
                            <span>{t.rr_item_id()}</span>
                            <input
                                type="text"
                                name={f.recovered_item_id}
                                value={&form.recovered_item_id}
                                required
                                autocomplete="off"
                            >
                        </label>
                        <label class={Field}>
                            <span>{t.rr_action()}</span>
                            <select name={f.intent} required>
                                for (value, words) in actions {
                                    <option value={value} selected={form.intent == value}>{words}</option>
                                }
                            </select>
                        </label>
                        <Text label={t.rr_policy_version()} name={f.policy_version} value={&form.policy_version} />
                        <label class={Field}>
                            <span>{t.rr_evidence_references()}</span>
                            <input type="text" name={f.evidence_references} value={&form.evidence_references} required>
                        </label>
                        <Text label={t.rr_catalog_item()} name={f.catalog_item_id} value={&form.catalog_item_id} />
                        <Text label={t.rr_product()} name={f.product_id} value={&form.product_id} />
                        <Text label={t.rr_condition()} name={f.condition_grade} value={&form.condition_grade} />
                        <Text label={t.rr_authenticity_outcome()} name={f.outcome} value={&form.outcome} />
                        <Text label={t.rr_authenticity_reference()} name={f.review_reference} value={&form.review_reference} />
                        <Text label={t.rr_owner()} name={f.legal_owner} value={&form.legal_owner} />
                        <Text label={t.rr_authority_kind()} name={f.authority_kind} value={&form.authority_kind} />
                        <Text
                            label={t.rr_allowed_dispositions()}
                            name={f.allowed_dispositions}
                            value={&form.allowed_dispositions}
                        />
                        <Text label={t.rr_disposition()} name={f.disposition} value={&form.disposition} />
                        <Text label={t.rr_target_account()} name={f.target_account_id} value={&form.target_account_id} />
                        <Text label={t.rr_storage_location()} name={f.storage_location_id} value={&form.storage_location_id} />
                        <Text label={t.rr_reason()} name={f.reason_code} value={&form.reason_code} />
                        <Text label={t.rr_recovery_type()} name={f.recovery_type} value={&form.recovery_type} />
                        <Text label={t.rr_recovery_id()} name={f.recovery_id} value={&form.recovery_id} />
                        <Text label={t.rr_gross_amount()} name={f.gross_amount} value={&form.gross_amount} />
                        <Text label={t.rr_cost_amount()} name={f.cost_amount} value={&form.cost_amount} />
                        <Text label={t.rr_currency()} name={f.currency_code} value={&form.currency_code} />
                        <Text
                            label={t.rr_corrected_return_shipment()}
                            name={f.corrected_return_shipment_id}
                            value={&form.corrected_return_shipment_id}
                        />
                        <Text
                            label={t.rr_canonical_item()}
                            name={f.canonical_recovered_item_id}
                            value={&form.canonical_recovered_item_id}
                        />
                    </div>
                    <button type="submit" class={Button}>{t.rr_submit()}</button>
                </form>
            </section>
        </div>
    }
}
