use corten::prelude::*;

use super::{Draft, Lifecycle, ReviseForm, StatusBadge};
use crate::{
    api::{PackagePlan, Policy},
    app::url,
    form::{ActivateInput, CloneInput, PolicyInput, RetireInput},
    text::Msg,
};

/// The preview result's id: a preview patches it.
#[derive(Id)]
pub struct PreviewResultId;

/// The sheet's title, which names the dialog.
#[derive(Id)]
pub struct SheetTitleId;

/// A policy's details, its lifecycle, its revision and preview, and its history.
///
/// Without JavaScript it is an open, non-modal `<dialog>` beside the list, closed by a link back
/// to the list. corten-ui's `dialog::modalClosedBy` makes it modal (focus stays inside, the page
/// behind is inert) and sends Escape to the same link's address.
#[component(css)]
pub fn PolicySheet<'a>(
    t: Msg,
    policy: &'a Policy,
    close: &'a url::Policies,
    revise: &'a Draft<PolicyInput>,
    activate: &'a Draft<ActivateInput>,
    retire: &'a Draft<RetireInput>,
    clone: &'a Draft<CloneInput>,
    preview: Option<&'a PackagePlan>,
) -> impl Render {
    let back = refs();
    let none = t.common_none();
    let comparison = if !policy.active_comparison.is_empty() {
        t.detail_material_differences_only()
    } else if policy.status == "active" {
        t.detail_this_is_active_policy()
    } else {
        t.detail_no_active_differences()
    };
    html! {
        <dialog
            class={Sheet}
            open
            aria-labelledby={SheetTitleId}
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <header class={Head}>
                <div>
                    <h2 id={SheetTitleId}>{&policy.label}</h2>
                    <p>{t.detail_description()}</p>
                </div>
                <a ref={back} class={Close} href={close} aria-label={t.detail_close()}>"×"</a>
            </header>
            <section class={Part}>
                <h3>{t.detail_state()}</h3>
                <div class={Card}>
                    <StatusBadge status={&policy.status} />
                    <p>{t.detail_policy_id(&policy.policy_id)}</p>
                    <p>{t.detail_activated(policy.activated_at.as_deref().unwrap_or(t.detail_not_activated()))}</p>
                    <p>{t.detail_activation_reason(policy.activation_reason.as_deref().unwrap_or(none))}</p>
                </div>
            </section>
            <section class={Part}>
                <h3>{t.detail_active_comparison()}</h3>
                <div class={Card}>
                    <p>{comparison}</p>
                    if !policy.active_comparison.is_empty() {
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.detail_field()}</th>
                                    <th scope="col">{t.detail_active()}</th>
                                    <th scope="col">{t.detail_this_policy()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &policy.active_comparison {
                                    <tr>
                                        <th scope="row">{&row.field}</th>
                                        <td>{&row.active_value}</td>
                                        <td>{&row.candidate_value}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    }
                </div>
            </section>
            <section class={Part}>
                <h3>{t.detail_lifecycle()}</h3>
                <Lifecycle t={t} policy={policy} activate={activate} retire={retire} clone={clone} />
            </section>
            <section class={Part}>
                <h3>{t.detail_revise_policy()}</h3>
                <div class={Card}><ReviseForm t={t} id={&policy.policy_id} form={revise} /></div>
                <PreviewResult t={t} plan={preview} />
            </section>
            <section class={Part}>
                <h3>{t.detail_history()}</h3>
                if policy.history.is_empty() {
                    <div class={Card}>
                        <p><strong>{t.detail_no_history()}</strong></p>
                        <p>{t.detail_history_description()}</p>
                    </div>
                } else {
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{t.detail_event()}</th>
                                <th scope="col">{t.common_status()}</th>
                                <th scope="col">{t.detail_actor()}</th>
                                <th scope="col">{t.detail_reason()}</th>
                                <th scope="col">{t.detail_recorded()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &policy.history {
                                <tr>
                                    <td>{&row.event_type}</td>
                                    <td><StatusBadge status={&row.status} /></td>
                                    <td>{&row.actor_user_id}</td>
                                    <td>{row.reason.as_deref().unwrap_or(none)}</td>
                                    <td>{&row.recorded_at}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                }
            </section>
        </dialog>
    }
}

/// What a preview answered: inside the sheet, and on its own as the preview's patch.
#[component(css = PolicySheet)]
pub fn PreviewResult<'a>(t: Msg, plan: Option<&'a PackagePlan>) -> impl Patch {
    let none = t.common_none();
    let yes_no = |b: bool| if b { t.common_yes() } else { t.common_no() };
    let list = |items: &[String]| if items.is_empty() { none.to_owned() } else { items.join(", ") };
    html! {
        <div id={PreviewResultId} aria-live="polite">
            if let Some(plan) = plan {
                let first = plan.packages.first();
                let snap = plan.postage_policy_snapshot.as_ref();
                <div class={Card}>
                    <p><strong>{t.detail_preview_result()}</strong></p>
                    <p>{t.detail_packages(plan.package_count)}</p>
                    <p>{t.detail_mailpiece(first.map_or(none, |p| p.mailpiece_class.as_str()))}</p>
                    <p>{t.detail_service(first.map_or(none, |p| p.service_level.as_str()))}</p>
                    <p>{t.detail_parcel_required(yes_no(snap.is_some_and(|s| s.parcel_required)))}</p>
                    <p>{t.detail_parcel_reasons(snap.map_or(none.to_owned(), |s| list(&s.parcel_reasons)))}</p>
                    <p>{t.detail_signature_required(yes_no(snap.is_some_and(|s| s.signature_required)))}</p>
                    <p>{t.detail_signature_reasons(snap.map_or(none.to_owned(), |s| list(&s.signature_reasons)))}</p>
                    <p>{t.detail_insurance_required(yes_no(snap.is_some_and(|s| s.insurance_required)))}</p>
                    <p>{t.detail_insurance_reasons(snap.map_or(none.to_owned(), |s| list(&s.insurance_reasons)))}</p>
                    <p>{t.detail_insured_value(snap.and_then(|s| s.insured_value_amount.as_deref()).unwrap_or(none))}</p>
                    <p>{t.detail_shipping_evidence_tier(snap.map_or(none, |s| s.shipping_evidence_tier.as_str()))}</p>
                </div>
            }
        </div>
    }
}
