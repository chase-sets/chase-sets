//! Seller checkout (Checkout's `SignedInSellCheckoutPage` and `GuestSellCheckoutPage`) and its saved
//! confirmation (`SellCheckoutConfirmationPage`).
//!
//! One form, no script. An account's saved details (contact, ship-from, payout, label) each fold
//! under a `<details>` whose summary is the saved row and whose body is its fields, so the fields
//! are sent whether the seller opened them or not; a section that is not complete, or that was
//! refused, is open. Marketplace swaps a saved row for its fields with a script (Edit). A guest's
//! sections are all open. One column on a phone with the estimated payout and the call to action
//! in a bar at the bottom and the summary folded above the form; the summary beside the form from
//! 64rem, and the fields two across from 40rem.
use corten::{
    i18n::{Currency, DateStyle, Decimal, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    api::{SavedAddress, SellListConfirmation, SellListRow},
    app::url,
    sell_checkout::{Errors, MANUAL, Payout, Recovery, Screen, Values, line_value},
    sell_list::support_reference,
    text::{SellCheckoutMsg, SellListMsg},
    views::on_marketplace,
};

/// The page's one form.
#[derive(Id, Clone, Copy)]
pub struct SellCheckoutFormId;

fn usd() -> Currency {
    Currency::parse("USD").expect("USD")
}

fn dollars(t: SellCheckoutMsg, cents: i64) -> String {
    t.money(Decimal::new(i128::from(cents), 2), usd()).to_string()
}

/// The words that differ between an account's page and a guest's.
#[derive(Clone, Copy)]
struct Words {
    eyebrow: &'static str,
    title: &'static str,
    description: &'static str,
    back_to_sell_list: &'static str,
    back: &'static str,
    review_sell_list: &'static str,
    review_sale: &'static str,
    fix_details: &'static str,
    standard: &'static str,
    summary_title: &'static str,
    summary_status: &'static str,
    summary_selected_offer: &'static str,
    summary_product_line: &'static str,
    summary_items: &'static str,
    summary_lines: &'static str,
    summary_readiness: &'static str,
    summary_ready: &'static str,
    summary_needs_review: &'static str,
    estimated_payout: &'static str,
    mobile_summary: &'static str,
    sticky_context: &'static str,
    contact_title: &'static str,
    contact_description: &'static str,
    seller_name: &'static str,
    email: &'static str,
    phone: &'static str,
    ship_from_title: &'static str,
    ship_from_description: &'static str,
    ship_from_name: &'static str,
    company: &'static str,
    line1: &'static str,
    line2: &'static str,
    city: &'static str,
    state: &'static str,
    postal_code: &'static str,
    country: &'static str,
    payout_title: &'static str,
    payout_description: &'static str,
    payout_method: &'static str,
    label_title: &'static str,
    label_description: &'static str,
    label_preference: &'static str,
    label_prepaid: &'static str,
    label_later: &'static str,
    terms_title: &'static str,
    terms_description: &'static str,
    terms_accept: &'static str,
    terms_accept_description: &'static str,
    side_effect_boundary: &'static str,
}

impl Words {
    fn of(t: SellCheckoutMsg, account: bool) -> Self {
        if account {
            Words {
                eyebrow: t.signed_eyebrow(),
                title: t.signed_title(),
                description: t.signed_description(),
                back_to_sell_list: t.signed_back_to_sell_list(),
                back: t.signed_back(),
                review_sell_list: t.signed_review_sell_list(),
                review_sale: t.signed_review_sale(),
                fix_details: t.signed_fix_details(),
                standard: t.signed_standard(),
                summary_title: t.signed_summary_title(),
                summary_status: t.signed_summary_status(),
                summary_selected_offer: t.signed_summary_selected_offer(),
                summary_product_line: t.signed_summary_product_line(),
                summary_items: t.signed_summary_items(),
                summary_lines: t.signed_summary_lines(),
                summary_readiness: t.signed_summary_readiness(),
                summary_ready: t.signed_summary_ready(),
                summary_needs_review: t.signed_summary_needs_review(),
                estimated_payout: t.signed_summary_estimated_payout(),
                mobile_summary: t.signed_mobile_summary(),
                sticky_context: t.signed_sticky_context(),
                contact_title: t.signed_contact_title(),
                contact_description: t.signed_contact_description(),
                seller_name: t.signed_seller_name(),
                email: t.signed_email(),
                phone: t.signed_phone(),
                ship_from_title: t.signed_ship_from_title(),
                ship_from_description: t.signed_ship_from_description(),
                ship_from_name: t.signed_ship_from_name(),
                company: t.signed_company(),
                line1: t.signed_address_line1(),
                line2: t.signed_address_line2(),
                city: t.signed_city(),
                state: t.signed_state(),
                postal_code: t.signed_postal_code(),
                country: t.signed_country(),
                payout_title: t.signed_payout_title(),
                payout_description: t.signed_payout_description(),
                payout_method: t.signed_payout_method(),
                label_title: t.signed_label_title(),
                label_description: t.signed_label_description(),
                label_preference: t.signed_label_preference(),
                label_prepaid: t.signed_label_prepaid(),
                label_later: t.signed_label_later(),
                terms_title: t.signed_terms_title(),
                terms_description: t.signed_terms_description(),
                terms_accept: t.signed_terms_accept(),
                terms_accept_description: t.signed_terms_accept_description(),
                side_effect_boundary: t.signed_side_effect_boundary(),
            }
        } else {
            Words {
                eyebrow: t.guest_eyebrow(),
                title: t.guest_title(),
                description: t.guest_description(),
                back_to_sell_list: t.guest_back_to_sell_list(),
                back: t.guest_back(),
                review_sell_list: t.guest_review_sell_list(),
                review_sale: t.guest_review_sale(),
                fix_details: t.guest_fix_details(),
                standard: t.guest_standard(),
                summary_title: t.guest_summary_title(),
                summary_status: t.guest_summary_status(),
                summary_selected_offer: t.guest_summary_selected_offer(),
                summary_product_line: t.guest_summary_product_line(),
                summary_items: t.guest_summary_items(),
                summary_lines: t.guest_summary_lines(),
                summary_readiness: t.guest_summary_readiness(),
                summary_ready: t.guest_summary_ready(),
                summary_needs_review: t.guest_summary_needs_review(),
                estimated_payout: t.guest_summary_estimated_payout(),
                mobile_summary: t.guest_mobile_summary(),
                sticky_context: t.guest_sticky_context(),
                contact_title: t.guest_contact_title(),
                contact_description: t.guest_contact_description(),
                seller_name: t.guest_seller_name(),
                email: t.guest_email(),
                phone: t.guest_phone(),
                ship_from_title: t.guest_ship_from_title(),
                ship_from_description: t.guest_ship_from_description(),
                ship_from_name: t.guest_ship_from_name(),
                company: t.guest_company(),
                line1: t.guest_address_line1(),
                line2: t.guest_address_line2(),
                city: t.guest_city(),
                state: t.guest_state(),
                postal_code: t.guest_postal_code(),
                country: t.guest_country(),
                payout_title: t.guest_payout_title(),
                payout_description: t.guest_payout_description(),
                payout_method: t.guest_payout_method(),
                label_title: t.guest_label_title(),
                label_description: t.guest_label_description(),
                label_preference: t.guest_label_preference(),
                label_prepaid: t.guest_label_prepaid(),
                label_later: t.guest_label_later(),
                terms_title: t.guest_terms_title(),
                terms_description: t.guest_terms_description(),
                terms_accept: t.guest_terms_accept(),
                terms_accept_description: t.guest_terms_accept_description(),
                side_effect_boundary: t.guest_side_effect_boundary(),
            }
        }
    }
}

fn recovery_title(t: SellCheckoutMsg, account: bool, recovery: &Recovery) -> &'static str {
    match (recovery, account) {
        (Recovery::MissingSellList, true) => t.signed_recovery_missing_sell_list(),
        (Recovery::MissingSellList, false) => t.guest_recovery_missing_sell_list(),
        (Recovery::EmptySellList, true) => t.signed_recovery_empty_sell_list(),
        (Recovery::EmptySellList, false) => t.guest_recovery_empty_sell_list(),
        (Recovery::ReadinessRequired, true) => t.signed_recovery_readiness_required(),
        (Recovery::ReadinessRequired, false) => t.guest_recovery_readiness_required(),
        (Recovery::ReadinessStale(_), true) => t.signed_recovery_readiness_stale(),
        (Recovery::ReadinessStale(_), false) => t.guest_recovery_readiness_stale(),
        (Recovery::ReadinessBlocked, true) => t.signed_recovery_readiness_blocked(),
        (Recovery::ReadinessBlocked, false) => t.guest_recovery_readiness_blocked(),
    }
}

fn recovery_description(t: SellCheckoutMsg, account: bool, recovery: &Recovery) -> String {
    if let Recovery::ReadinessStale(Some(detail)) = recovery {
        return detail.clone();
    }
    match (recovery, account) {
        (Recovery::MissingSellList, true) => t.signed_recovery_missing_sell_list_description(),
        (Recovery::MissingSellList, false) => t.guest_recovery_missing_sell_list_description(),
        (Recovery::EmptySellList, true) => t.signed_recovery_empty_sell_list_description(),
        (Recovery::EmptySellList, false) => t.guest_recovery_empty_sell_list_description(),
        (Recovery::ReadinessRequired, true) => t.signed_recovery_readiness_required_description(),
        (Recovery::ReadinessRequired, false) => t.guest_recovery_readiness_required_description(),
        (Recovery::ReadinessStale(_), true) => t.signed_recovery_readiness_stale_description(),
        (Recovery::ReadinessStale(_), false) => t.guest_recovery_readiness_stale_description(),
        (Recovery::ReadinessBlocked, true) => t.signed_recovery_readiness_blocked_description(),
        (Recovery::ReadinessBlocked, false) => t.guest_recovery_readiness_blocked_description(),
    }
    .to_owned()
}

/// A line's options, else its summary, else Standard (`productOptionsSummary`).
fn options(w: Words, line: &SellListRow) -> String {
    let picked: Vec<String> = line.selected_options.iter().map(|s| format!("{}: {}", s.dimension_id, s.option_id)).collect();
    if !picked.is_empty() {
        return picked.join(", ");
    }
    line.product_summary.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| w.standard.to_owned())
}

fn address_summary(v: &Values) -> String {
    let region =
        [v.state.as_str(), v.postal_code.as_str()].iter().filter(|s| !s.trim().is_empty()).copied().collect::<Vec<_>>().join(" ");
    let locality =
        [v.city.as_str(), region.as_str()].iter().filter(|s| !s.trim().is_empty()).copied().collect::<Vec<_>>().join(", ");
    [v.line1.as_str(), v.line2.as_str(), locality.as_str(), v.country.as_str()]
        .iter()
        .filter(|s| !s.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(", ")
}

/// Whether any of `fields` was refused.
fn refused(errors: &Errors, fields: &[&str]) -> bool {
    fields.iter().any(|f| errors.contains_key(f))
}

/// The page.
#[component(css)]
pub fn SellCheckoutPage<'a>(t: SellCheckoutMsg, screen: &'a Screen) -> impl Render {
    let w = Words::of(t, screen.account);
    let total = dollars(t, screen.total());
    let blocked = screen.recovery.is_some();
    let quantity: u64 = screen.lines.iter().map(|l| l.quantity).sum();
    let count = screen.lines.len() as u64;
    let collapsed = if screen.account {
        t.signed_mobile_summary_collapsed(count).to_string()
    } else {
        t.guest_mobile_summary_collapsed(count).to_string()
    };
    let back = url::SellList::PATH;
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{w.eyebrow}</p>
                <h1 class={Title}>{w.title}</h1>
                <p class={Muted}>{w.description}</p>
            </div>
            <a class={(Button, Secondary)} href={back}>{w.back_to_sell_list}</a>
        </header>
        if let Some(recovery) = &screen.recovery {
            <div class={Banner} data-tone="warning" role="status">
                <p class={Strong}>{recovery_title(t, screen.account, recovery)}</p>
                <p>{recovery_description(t, screen.account, recovery)}</p>
                <p><a class={Button} href={back}>{w.review_sell_list}</a></p>
            </div>
        }
        <div class={Layout}>
            <div class={Main}>
                <details class={(Card, Folded)}>
                    <summary class={Strong}>{w.mobile_summary} " · " {&collapsed} " · " {&total}</summary>
                    <Summary t={t} w={w} screen={screen} total={&total} quantity={quantity} />
                </details>
                <form id={SellCheckoutFormId} class={Form} method="post" novalidate={false}>
                    <input type="hidden" name="sessionId" value={&screen.session_id}>
                    <input
                        type="hidden"
                        name="readinessSnapshotId"
                        value={screen.readiness.as_ref().map_or("", |r| r.snapshot_id.as_str())}
                    >
                    <input
                        type="hidden"
                        name="readinessSourceRevision"
                        value={screen.readiness.as_ref().map_or("", |r| r.source_revision.as_str())}
                    >
                    if screen.account {
                        <input type="hidden" name="readinessDecisions" value={&screen.decisions}>
                        <input type="hidden" name="sellListReviewPlan" value={&screen.plan}>
                    }
                    if let Some(message) = screen.errors.get("form") {
                        <div class={Banner} data-tone="danger" role="alert">
                            <p class={Strong}>{w.fix_details}</p>
                            <p>{message}</p>
                        </div>
                    }
                    if screen.account {
                        <AccountSections t={t} w={w} screen={screen} />
                    } else {
                        <GuestSections t={t} w={w} screen={screen} />
                    }
                    <section class={(Card, Section)} aria-labelledby="sell-checkout-terms">
                        <h2 id="sell-checkout-terms" class={PartTitle}>{w.terms_title}</h2>
                        <p class={Hint}>{w.terms_description}</p>
                        <label class={Check}>
                            <input
                                type="checkbox"
                                name="termsAccepted"
                                value="accepted"
                                checked={screen.values.terms_accepted}
                                required
                                aria-invalid={screen.errors.contains_key("termsAccepted").then_some("true")}
                            >
                            <span class={Tight}>
                                <span class={Strong}>{w.terms_accept}</span>
                                <span class={Hint}>{w.terms_accept_description}</span>
                            </span>
                        </label>
                        <FieldError errors={&screen.errors} name="termsAccepted" />
                        <p class={Hint}>{w.side_effect_boundary}</p>
                    </section>
                    <section class={Policies} aria-label={t.policy_label()}>
                        <p class={Row}>
                            <a href={on_marketplace("/terms")}>{t.policy_terms()}</a>
                            <a href={on_marketplace("/privacy")}>{t.policy_privacy()}</a>
                            <a href={on_marketplace("/refunds-and-returns")}>{t.policy_refunds()}</a>
                        </p>
                        <p class={Hint}>{t.policy_description()}</p>
                        if !screen.account {
                            <p class={Hint}>{t.guest_guest_data_description()}</p>
                        }
                    </section>
                    <p class={(Row, Desktop)}>
                        <button class={Button} type="submit" disabled={blocked}>{w.review_sale}</button>
                        <a class={(Button, Secondary)} href={back}>{w.back_to_sell_list}</a>
                    </p>
                </form>
                <div class={Dock}>
                    <p class={Total}><span class={Big}>{&total}</span> <span class={Hint}>{w.estimated_payout}</span></p>
                    <p class={Hint}>{w.sticky_context}</p>
                    <p class={Row}>
                        <button class={Button} type="submit" form={SellCheckoutFormId} disabled={blocked}>{w.review_sale}</button>
                        <a class={(Button, Secondary)} href={back}>{w.back}</a>
                    </p>
                </div>
            </div>
            <aside class={Aside} aria-label={w.summary_title}>
                <div class={Card}>
                    <h2 class={PartTitle}>{w.summary_title}</h2>
                    <Summary t={t} w={w} screen={screen} total={&total} quantity={quantity} />
                </div>
            </aside>
        </div>
    }
}

/// The sale summary (`SummaryPanel`): each line, the counts, readiness and the estimated payout.
#[component(css = SellCheckoutPage)]
fn Summary<'a>(t: SellCheckoutMsg, w: Words, screen: &'a Screen, total: &'a str, quantity: u64) -> impl Render {
    let count = screen.lines.len() as u64;
    let subtitle =
        if screen.account { t.signed_summary_subtitle(count).to_string() } else { t.guest_summary_subtitle(count).to_string() };
    let reassurance = if screen.account {
        t.signed_summary_reassurance(quantity).to_string()
    } else {
        t.guest_summary_reassurance().to_owned()
    };
    let ready = screen.readiness.as_ref().is_some_and(|r| r.status == "ready");
    html! {
        <div class={Stack}>
            <p class={Row}>
                <span class={Hint}>{&subtitle}</span>
                <span class={Badge} data-tone="success">{w.summary_status}</span>
            </p>
            <ul class={Lines}>
                for line in &screen.lines {
                    <li class={Line}>
                        <p class={Spread}>
                            <span class={Strong}>{&line.item_title}</span>
                            <span class={Strong}>{dollars(t, line_value(line))}</span>
                        </p>
                        if let Some(sub) = line.item_subtitle.as_deref().or(line.product_summary.as_deref()) {
                            <p class={Hint}>{sub}</p>
                        }
                        <p class={Hint}>
                            {if line.is_offer() { w.summary_selected_offer } else { w.summary_product_line }}
                            " · " {options(w, line)} " · ×" {line.quantity.to_string()}
                        </p>
                    </li>
                }
            </ul>
            <dl class={Facts}>
                <div>
                    <dt>{w.summary_items}</dt>
                    <dd>{quantity.to_string()}</dd>
                </div>
                <div>
                    <dt>{w.summary_lines}</dt>
                    <dd>{count.to_string()}</dd>
                </div>
                <div>
                    <dt>{w.summary_readiness}</dt>
                    <dd>{if ready { w.summary_ready } else { w.summary_needs_review }}</dd>
                </div>
                <div class={Sum}>
                    <dt>{w.estimated_payout}</dt>
                    <dd>{total}</dd>
                </div>
            </dl>
            <p class={Hint}>{&reassurance}</p>
        </div>
    }
}

/// An account's sections: the saved rows, each folding its fields, and the seller readiness row.
#[component(css = SellCheckoutPage)]
fn AccountSections<'a>(t: SellCheckoutMsg, w: Words, screen: &'a Screen) -> impl Render {
    let v = &screen.values;
    let e = &screen.errors;
    let payout = screen.payout.clone().unwrap_or(Payout::Unavailable);
    let contact_open = !v.contact_ready() || refused(e, &["sellerName", "email", "phone"]);
    let ship_open = !v.ship_from_ready()
        || refused(
            e,
            &["shipFromName", "shipFromLine1", "shipFromCity", "shipFromState", "shipFromPostalCode", "shipFromCountry"],
        );
    let payout_open = !payout.ready() || refused(e, &["payoutMethod"]);
    let label_open = refused(e, &["labelPreference"]);
    let supporting = if v.phone.trim().is_empty() {
        t.signed_contact_supporting().to_owned()
    } else {
        t.signed_contact_supporting_phone(&v.phone).to_string()
    };
    let (payout_label, payout_text) = match &payout {
        Payout::Ready => (t.signed_payout_ready(), t.signed_payout_ready_description().to_owned()),
        Payout::NeedsSetup { status, missing } => {
            let requirements = if missing.is_empty() { status.clone() } else { missing.join(", ") };
            (t.signed_payout_needs_setup(), t.signed_payout_needs_setup_description(&requirements).to_string())
        }
        Payout::Unavailable => (t.signed_payout_unavailable(), t.signed_payout_unavailable_description().to_owned()),
    };
    let label_value = if v.label_preference == "seller-label-later" { w.label_later } else { w.label_prepaid };
    html! {
        <section class={(Card, Section)} aria-labelledby="sell-checkout-saved">
            <h2 id="sell-checkout-saved" class={PartTitle}>{t.signed_saved_title()}</h2>
            <details class={Saved} open={contact_open}>
                <summary class={SavedRow}>
                    <span class={Tight}>
                        <span class={Hint}>{w.contact_title}</span>
                        <span class={Strong}>{if v.email.is_empty() { "-" } else { v.email.as_str() }}</span>
                        <span class={Hint}>{&supporting}</span>
                    </span>
                    <SavedStatus t={t} ready={v.contact_ready()} edit={t.signed_edit_contact()} />
                </summary>
                <div class={Fields}>
                    <p class={Hint}>{w.contact_description}</p>
                    <ContactFields w={w} v={v} e={e} />
                </div>
            </details>
            <details class={Saved} open={ship_open}>
                <summary class={SavedRow}>
                    <span class={Tight}>
                        <span class={Hint}>{w.ship_from_title}</span>
                        <span class={Strong}>{if v.ship_from_name.is_empty() { "-" } else { v.ship_from_name.as_str() }}</span>
                        <span class={Hint}>{address_summary(v)}</span>
                    </span>
                    <SavedStatus t={t} ready={v.ship_from_ready()} edit={t.signed_edit_ship_from()} />
                </summary>
                <div class={Fields}>
                    <p class={Hint}>{w.ship_from_description}</p>
                    if !screen.addresses.is_empty() {
                        <SavedAddresses t={t} addresses={&screen.addresses} chosen={&v.ship_from_address_id} />
                    }
                    <ShipFromFields w={w} v={v} e={e} />
                </div>
            </details>
            <details class={Saved} open={payout_open}>
                <summary class={SavedRow}>
                    <span class={Tight}>
                        <span class={Hint}>{w.payout_title}</span>
                        <span class={Strong}>{payout_label}</span>
                        <span class={Hint}>{&payout_text}</span>
                    </span>
                    <SavedStatus t={t} ready={payout.ready()} edit={t.signed_edit_payout()} />
                </summary>
                <div class={Fields}>
                    <p class={Hint}>{w.payout_description}</p>
                    <label class={Field}>
                        <span class={Label}>{w.payout_method}</span>
                        <select name="payoutMethod" required aria-invalid={e.contains_key("payoutMethod").then_some("true")}>
                            <option value="saved-payout" selected={v.payout_method == "saved-payout"}>{payout_label}</option>
                            <option value="setup-payout" selected={v.payout_method == "setup-payout"}>
                                {t.signed_payout_setup()}
                            </option>
                        </select>
                    </label>
                    <FieldError errors={e} name="payoutMethod" />
                </div>
            </details>
            <div class={SavedRow}>
                <span class={Tight}>
                    <span class={Hint}>{t.signed_seller_readiness_title()}</span>
                    <span class={Strong}>{t.signed_seller_readiness_ready()}</span>
                    <span class={Hint}>{t.signed_seller_readiness_detail()}</span>
                </span>
                <span class={Badge} data-tone="success">{t.signed_ready()}</span>
            </div>
            <details class={Saved} open={label_open}>
                <summary class={SavedRow}>
                    <span class={Tight}>
                        <span class={Hint}>{w.label_title}</span>
                        <span class={Strong}>{label_value}</span>
                        <span class={Hint}>{t.signed_label_row_supporting()}</span>
                    </span>
                    <SavedStatus t={t} ready={true} edit={t.signed_edit_label()} />
                </summary>
                <div class={Fields}>
                    <p class={Hint}>{w.label_description}</p>
                    <LabelField w={w} v={v} e={e} />
                </div>
            </details>
        </section>
    }
}

/// A saved row's status and its Edit cue (the summary itself opens the fields).
#[component(css = SellCheckoutPage)]
fn SavedStatus(t: SellCheckoutMsg, ready: bool, edit: &'static str) -> impl Render {
    html! {
        <span class={Status}>
            <span class={Badge} data-tone={if ready { "success" } else { "warning" }}>
                {if ready { t.signed_ready() } else { t.signed_review_required() }}
            </span>
            <span class={Edit} aria-hidden="true">{edit}</span>
        </span>
    }
}

/// A guest's sections, all open.
#[component(css = SellCheckoutPage)]
fn GuestSections<'a>(t: SellCheckoutMsg, w: Words, screen: &'a Screen) -> impl Render {
    let v = &screen.values;
    let e = &screen.errors;
    html! {
        <section class={(Card, Section)} aria-labelledby="sell-checkout-contact">
            <h2 id="sell-checkout-contact" class={PartTitle}>{w.contact_title}</h2>
            <p class={Hint}>{w.contact_description}</p>
            <ContactFields w={w} v={v} e={e} />
        </section>
        <section class={(Card, Section)} aria-labelledby="sell-checkout-ship-from">
            <h2 id="sell-checkout-ship-from" class={PartTitle}>{w.ship_from_title}</h2>
            <p class={Hint}>{w.ship_from_description}</p>
            <ShipFromFields w={w} v={v} e={e} />
        </section>
        <section class={(Card, Section)} aria-labelledby="sell-checkout-payout">
            <h2 id="sell-checkout-payout" class={PartTitle}>{w.payout_title}</h2>
            <p class={Hint}>{w.payout_description}</p>
            <label class={Field}>
                <span class={Label}>{w.payout_method}</span>
                <select name="payoutHandoff" required aria-invalid={e.contains_key("payoutHandoff").then_some("true")}>
                    <option value="create-account" selected>{t.guest_payout_create_account()}</option>
                </select>
            </label>
            <FieldError errors={e} name="payoutHandoff" />
        </section>
        <section class={(Card, Section)} aria-labelledby="sell-checkout-label">
            <h2 id="sell-checkout-label" class={PartTitle}>{w.label_title}</h2>
            <p class={Hint}>{w.label_description}</p>
            <LabelField w={w} v={v} e={e} />
        </section>
    }
}

#[component(css = SellCheckoutPage)]
fn ContactFields<'a>(w: Words, v: &'a Values, e: &'a Errors) -> impl Render {
    html! {
        <div class={Grid}>
            <TextField
                label={w.seller_name}
                name="sellerName"
                value={&v.seller_name}
                auto="name"
                kind="text"
                required={true}
                e={e}
            />
            <TextField label={w.email} name="email" value={&v.email} auto="email" kind="email" required={true} e={e} />
            <TextField label={w.phone} name="phone" value={&v.phone} auto="tel" kind="tel" required={false} e={e} />
        </div>
    }
}

#[component(css = SellCheckoutPage)]
fn ShipFromFields<'a>(w: Words, v: &'a Values, e: &'a Errors) -> impl Render {
    html! {
        <div class={Grid}>
            <TextField
                label={w.ship_from_name}
                name="shipFromName"
                value={&v.ship_from_name}
                auto="name"
                kind="text"
                required={true}
                e={e}
            />
            <TextField
                label={w.company}
                name="company"
                value={&v.company}
                auto="organization"
                kind="text"
                required={false}
                e={e}
            />
            <TextField
                label={w.line1}
                name="shipFromLine1"
                value={&v.line1}
                auto="address-line1"
                kind="text"
                required={true}
                e={e}
            />
            <TextField
                label={w.line2}
                name="shipFromLine2"
                value={&v.line2}
                auto="address-line2"
                kind="text"
                required={false}
                e={e}
            />
            <TextField
                label={w.city}
                name="shipFromCity"
                value={&v.city}
                auto="address-level2"
                kind="text"
                required={true}
                e={e}
            />
            <TextField
                label={w.state}
                name="shipFromState"
                value={&v.state}
                auto="address-level1"
                kind="text"
                required={true}
                e={e}
            />
            <TextField
                label={w.postal_code}
                name="shipFromPostalCode"
                value={&v.postal_code}
                auto="postal-code"
                kind="text"
                required={true}
                e={e}
            />
            <TextField
                label={w.country}
                name="shipFromCountry"
                value={&v.country}
                auto="country"
                kind="text"
                required={true}
                e={e}
            />
        </div>
    }
}

/// The saved ship-from addresses to pick from; Enter a new one keeps the typed fields.
#[component(css = SellCheckoutPage)]
fn SavedAddresses<'a>(t: SellCheckoutMsg, addresses: &'a [SavedAddress], chosen: &'a str) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{t.signed_saved_ship_from()}</span>
            <select name="shipFromAddressId">
                <option value={MANUAL} selected={chosen == MANUAL}>{t.signed_enter_new_ship_from()}</option>
                for a in addresses {
                    <option value={&a.shipping_address_id} selected={chosen == a.shipping_address_id}>
                        if a.is_default { {t.signed_default_ship_from_option(&a.label).to_string()} } else { {&a.label} }
                    </option>
                }
            </select>
        </label>
    }
}

#[component(css = SellCheckoutPage)]
fn LabelField<'a>(w: Words, v: &'a Values, e: &'a Errors) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{w.label_preference}</span>
            <select name="labelPreference" required aria-invalid={e.contains_key("labelPreference").then_some("true")}>
                <option value="prepaid-label" selected={v.label_preference != "seller-label-later"}>{w.label_prepaid}</option>
                <option value="seller-label-later" selected={v.label_preference == "seller-label-later"}>{w.label_later}</option>
            </select>
        </label>
        <FieldError errors={e} name="labelPreference" />
    }
}

#[component(css = SellCheckoutPage)]
fn TextField<'a>(
    label: &'static str,
    name: &'static str,
    value: &'a str,
    auto: &'static str,
    kind: &'static str,
    required: bool,
    e: &'a Errors,
) -> impl Render {
    let refused = e.contains_key(name);
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <input
                type={kind}
                name={name}
                value={value}
                autocomplete={auto}
                required={required}
                aria-invalid={refused.then_some("true")}
            >
            if let Some(message) = e.get(name) {
                <span class={Error}>{message}</span>
            }
        </label>
    }
}

#[component(css = SellCheckoutPage)]
fn FieldError<'a>(errors: &'a Errors, name: &'static str) -> impl Render {
    html! {
        if let Some(message) = errors.get(name) {
            <p class={Error} role="alert">{message}</p>
        }
    }
}

/// The saved confirmation (`SellCheckoutConfirmationPage`): its reference, what happens next, and
/// each line's outcome.
#[component(css = SellCheckoutPage)]
pub fn SellConfirmationPage<'a>(t: SellCheckoutMsg, s: SellListMsg, confirmation: &'a SellListConfirmation) -> impl Render {
    let summary = &confirmation.handoff_summary;
    let reference = support_reference(&confirmation.confirmation_id);
    let recorded = summary.accepted_offer_count + summary.published_listing_count;
    let activity = url::SellList::PATH;
    let sales = <url::Sales as Route>::PATH;
    let recorded_at = parse_timestamp(&confirmation.confirmed_at)
        .map_or_else(|| confirmation.confirmed_at.clone(), |at| t.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string());
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.signed_eyebrow()}</p>
                <h1 class={Title}>{t.signed_confirmation_title()}</h1>
                <p class={Muted}>{t.signed_confirmation_description()}</p>
            </div>
            <a class={(Button, Secondary)} href={activity}>{t.signed_view_seller_activity()}</a>
        </header>
        <div class={Layout}>
            <div class={Main}>
                <section class={(Card, Section)} aria-labelledby="sell-confirmation-title">
                    <div class={Banner} data-tone="success" role="status">
                        <p id="sell-confirmation-title" class={Strong}>{t.signed_confirmation_title()}</p>
                        <p>{t.signed_confirmation_description()}</p>
                    </div>
                    <dl class={Facts}>
                        <div>
                            <dt>{t.signed_confirmation_reference()}</dt>
                            <dd class={Strong}>{&reference}</dd>
                        </div>
                        <div>
                            <dt>{t.signed_confirmation_support_reference()}</dt>
                            <dd>{&reference}</dd>
                        </div>
                        <div>
                            <dt>{s.page_latest_confirmation_recorded()}</dt>
                            <dd>{&recorded_at}</dd>
                        </div>
                        <div class={Sum}>
                            <dt>{s.page_latest_confirmation_action()}</dt>
                            <dd>{recorded.to_string()}</dd>
                        </div>
                    </dl>
                    <ol class={Steps}>
                        <li>
                            <p class={Strong}>{t.signed_confirmation_sale_title()}</p>
                            <p class={Hint}>{t.signed_confirmation_sale_description()}</p>
                        </li>
                        <li>
                            <p class={Strong}>{t.signed_confirmation_label_title()}</p>
                            <p class={Hint}>{t.signed_confirmation_label_description()}</p>
                        </li>
                        <li>
                            <p class={Strong}>{t.signed_confirmation_side_effects_title()}</p>
                            <p class={Hint}>{t.signed_confirmation_side_effects_description()}</p>
                        </li>
                    </ol>
                    <p class={Row}>
                        <a class={Button} href={activity}>{t.signed_view_seller_activity()}</a>
                        <a class={(Button, Secondary)} href={sales}>{t.signed_view_committed_sales()}</a>
                    </p>
                </section>
                <section class={(Card, Section)} aria-labelledby="sell-confirmation-lines">
                    <h2 id="sell-confirmation-lines" class={PartTitle}>{s.page_latest_confirmation_line_outcomes()}</h2>
                    <p class={Row}>
                        <span class={Hint}>{s.page_latest_confirmation_recorded()}</span>
                        <span class={Badge} data-tone="success">{s.page_latest_confirmation_status_handoff_recorded()}</span>
                    </p>
                    <ul class={Lines}>
                        for line in &summary.line_outcomes {
                            <li class={Line}>
                                <p class={Spread}>
                                    <span class={Strong}>{&line.item_title}</span>
                                    <span class={Hint}>"×" {line.quantity.to_string()}</span>
                                </p>
                                <p class={Hint}>{&line.detail}</p>
                                <p class={Row}>
                                    <span class={Badge}>{crate::views::sell_list_status(s, &line.action)}</span>
                                    <span class={Badge}>{crate::views::sell_list_status(s, &line.status)}</span>
                                    if line.remaining_quantity > 0 {
                                        <span class={Badge} data-tone="warning">{s.page_latest_confirmation_remaining()}</span>
                                    }
                                </p>
                            </li>
                        }
                    </ul>
                    <dl class={Facts}>
                        <div>
                            <dt>{s.page_latest_confirmation_accepted_offers()}</dt>
                            <dd>{summary.accepted_offer_count.to_string()}</dd>
                        </div>
                        <div>
                            <dt>{s.page_latest_confirmation_listings_published()}</dt>
                            <dd>{summary.published_listing_count.to_string()}</dd>
                        </div>
                        <div>
                            <dt>{s.page_latest_confirmation_status_skipped()}</dt>
                            <dd>{summary.skipped_line_count.to_string()}</dd>
                        </div>
                        <div class={Sum}>
                            <dt>{s.page_latest_confirmation_support_references()}</dt>
                            <dd>{&reference}</dd>
                        </div>
                    </dl>
                    <p class={Hint}>{t.signed_confirmation_side_effects_description()}</p>
                </section>
            </div>
        </div>
    }
}
