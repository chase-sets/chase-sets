//! Commercial Terms (`CommercialTermsHomePage`). Top to bottom: the header with its two create links,
//! the fee lock banner, the load and write banners, the published seller fee schedule, and the
//! active and scheduled terms as cards (one column on a phone, more as the width allows). A sheet
//! opens over the page as an open `<dialog>` closed by a link back to the page; corten-ui's dialog
//! makes it modal with JavaScript. Every form is a plain post or get; the script only re-reads Create
//! account override when its account changes, which Review does without it.
use corten::prelude::*;

use crate::{
    commerce::{
        percent,
        terms::{
            AccountOption, Agreement, Fees, HistoryItem, Phase, Published, Schedule, Sheet, Term, TermsForm, TermsScreen, url,
        },
        usd,
    },
    text::{Com, Pilot},
};

/// The open sheet's title, which names it.
#[derive(Id)]
pub struct TermsSheetTitleId;

/// A date as admin-web's `dateOnly` writes it: the first ten characters.
fn date(at: &str) -> &str {
    at.get(..10).unwrap_or(at)
}

/// The fee as "rate + fixed".
fn fee(t: Com, bps: i64, fixed: &str) -> String {
    format!("{} + {}", percent(bps), usd(t, fixed))
}

/// An effective window, "from \u{2013} until" (or None for an open end).
fn window(t: Com, fees: &Fees) -> String {
    format!("{} \u{2013} {}", date(&fees.effective_from), fees.effective_until.as_deref().map_or(t.ct_none(), date))
}

fn source(t: Com, published: &Published) -> &'static str {
    if published.source == "policy" { t.ct_published_policy() } else { t.ct_fallback_policy() }
}

fn href(open: url::Open) -> String {
    url::Terms { open }.href()
}

#[component(css = TermsPage)]
fn TermsBadge<'a>(words: &'a str, tone: &'static str) -> impl Render {
    let tone = match tone {
        "success" => Good,
        "warning" => Warning,
        _ => Neutral,
    };
    html! { <span class={(Pill, tone)}>{words}</span> }
}

/// Two sets of terms side by side (`ComparisonModule`).
#[component(css = TermsPage)]
fn TermsCompare<'a>(t: Com, title: &'a str, left: &'a str, right: &'a str, rows: Vec<(&'a str, String, String)>) -> impl Render {
    html! {
        <section class={Part}>
            <h3 class={Minor}>{title}</h3>
            <div class={Scroll}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th scope="col">{t.ct_term()}</th>
                            <th scope="col">{left}</th>
                            <th scope="col">{right}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for (label, a, b) in rows {
                            <tr>
                                <th scope="row">{label}</th>
                                <td class={Words}>{a}</td>
                                <td class={Words}>{b}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        </section>
    }
}

/// A schedule's or override's revisions (`RevisionHistory`).
#[component(css = TermsPage)]
fn TermsHistory<'a>(t: Com, history: &'a [HistoryItem]) -> impl Render {
    html! {
        <section class={Part}>
            <h3 class={Minor}>{t.ct_revision_history()}</h3>
            if history.is_empty() {
                <p class={Muted}>{t.ct_no_revision_history()}</p>
            } else {
                <ol class={Timeline}>
                    for item in history {
                        <li>
                            <p class={Strong}>{t.ct_history_event_status(&item.event_type, &item.status)}</p>
                            <p class={Muted}>{t.ct_history_actor(&item.actor_user_id)}</p>
                            <p class={Small}>{&item.recorded_at}</p>
                        </li>
                    }
                </ol>
            }
        </section>
    }
}

/// The fee fields every form shares (`TermsFields`).
#[component(css = TermsPage)]
fn TermsFields<'a>(t: Com, form: &'a TermsForm, submit: &'a str) -> impl Render {
    let f = TermsForm::FIELDS;
    html! {
        <label class={Field}><span>{t.ct_label()}</span><input type="text" name={f.label} value={&form.label} required></label>
        <label class={Field}>
            <span>{t.ct_marketplace_fee_bps()}</span>
            <input
                type="number"
                name={f.marketplace_sales_fee_percentage_bps}
                value={&form.marketplace_sales_fee_percentage_bps}
                min="0"
                max="10000"
                required
            >
        </label>
        <label class={Field}>
            <span>{t.ct_marketplace_fixed_amount()}</span>
            <input
                type="text"
                name={f.marketplace_sales_fee_fixed_amount}
                value={&form.marketplace_sales_fee_fixed_amount}
                inputmode="decimal"
                required
            >
        </label>
        <label class={Field}>
            <span>{t.ct_shipping_allowance_bps()}</span>
            <input
                type="number"
                name={f.shipping_allowance_percentage_bps}
                value={&form.shipping_allowance_percentage_bps}
                min="0"
                max="10000"
                required
            >
        </label>
        <label class={Field}>
            <span>{t.ct_status()}</span>
            <select name={f.status} required>
                <option value="active" selected={form.status == "active"}>{t.ct_active()}</option>
                <option value="inactive" selected={form.status == "inactive"}>{t.ct_inactive()}</option>
            </select>
        </label>
        <label class={Field}>
            <span>{t.ct_effective_from()}</span>
            <input type="text" name={f.effective_from} value={&form.effective_from} required>
        </label>
        <label class={Field}>
            <span>{t.ct_effective_until()}</span>
            <input type="text" name={f.effective_until} value={&form.effective_until}>
        </label>
        <button type="submit" class={Button}>{submit}</button>
    }
}

/// A sheet over the page (`ResponsiveEditSheet`), closed by a link back to it.
#[component(css = TermsPage)]
fn TermsSheet<'a, C: Render>(t: Com, title: &'a str, description: Option<&'a str>, close: &'a str, children: C) -> impl Render {
    let back = refs();
    let page = url::Terms::default().href();
    let _ = t;
    html! {
        <dialog
            class={Drawer}
            open
            aria-labelledby={TermsSheetTitleId}
            on:connect={corten_ui::dialog::modalClosedBy(target, back, signal)}
        >
            <header class={Head}>
                <div>
                    <h2 id={TermsSheetTitleId} class={Words}>{title}</h2>
                    if let Some(description) = description {
                        <p>{description}</p>
                    }
                </div>
                <a ref={back} class={Close} href={&page} aria-label={close}>"\u{d7}"</a>
            </header>
            {children}
        </dialog>
    }
}

/// The facts a sheet starts with (`KeyValueList`).
#[component(css = TermsPage)]
fn TermsFacts(rows: Vec<(&'static str, String)>) -> impl Render {
    html! {
        <dl class={FactList}>
            for (key, value) in rows {
                <div>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </div>
            }
        </dl>
    }
}

#[component(css = TermsPage)]
fn ScheduleSheet<'a>(t: Com, schedule: &'a Schedule, active: Option<&'a Schedule>, sent: Option<&'a TermsForm>) -> impl Render {
    let f = TermsForm::FIELDS;
    let fees = &schedule.fees;
    let form = sent.cloned().unwrap_or_else(|| TermsForm::from_fees(fees));
    let none = t.ct_none().to_owned();
    let rows = vec![
        (t.ct_label(), active.map_or(none.clone(), |a| a.fees.label.clone()), fees.label.clone()),
        (
            t.ct_marketplace_fee(),
            active.map_or(none.clone(), |a| {
                fee(t, a.fees.marketplace_sales_fee_percentage_bps, &a.fees.marketplace_sales_fee_fixed_amount)
            }),
            fee(t, fees.marketplace_sales_fee_percentage_bps, &fees.marketplace_sales_fee_fixed_amount),
        ),
        (
            t.ct_shipping_allowance(),
            active.map_or(none.clone(), |a| percent(a.fees.shipping_allowance_percentage_bps)),
            percent(fees.shipping_allowance_percentage_bps),
        ),
        (t.ct_effective_window(), active.map_or(none, |a| window(t, &a.fees)), window(t, fees)),
    ];
    let facts = vec![
        (t.ct_status(), fees.status.clone()),
        (t.ct_account_type(), schedule.account_type.clone()),
        (t.ct_effective_from(), fees.effective_from.clone()),
        (t.ct_effective_until(), fees.effective_until.clone().unwrap_or_else(|| t.ct_open_ended().to_owned())),
    ];
    html! {
        <TermsSheet t={t} title={&fees.label} description={Some(t.ct_schedule_sheet_description())} close={t.ct_close_schedule()}>
            <TermsFacts rows={facts} />
            <TermsCompare
                t={t}
                title={t.ct_compare_active_schedule()}
                left={t.ct_active_schedule()}
                right={t.ct_selected_revision()}
                rows={rows}
            />
            <TermsHistory t={t} history={&schedule.history} />
            <section class={Part}>
                <h3 class={Minor}>{t.ct_revise_schedule()}</h3>
                <form class={Form} method="post">
                    <input type="hidden" name={f.intent} value="revise-schedule">
                    <input type="hidden" name={f.id} value={&schedule.schedule_id}>
                    <TermsFields t={t} form={&form} submit={t.ct_save_schedule_revision()} />
                </form>
            </section>
        </TermsSheet>
    }
}

#[component(css = TermsPage)]
fn AgreementSheet<'a>(
    t: Com,
    agreement: &'a Agreement,
    published: Option<&'a Published>,
    sent: Option<&'a TermsForm>,
) -> impl Render {
    let f = TermsForm::FIELDS;
    let fees = &agreement.fees;
    let form = sent.cloned().unwrap_or_else(|| TermsForm::from_fees(fees));
    let facts = vec![
        (t.ct_account(), format!("{} ({})", agreement.account(), agreement.account_id)),
        (t.ct_status(), fees.status.clone()),
        (t.ct_effective_from(), fees.effective_from.clone()),
        (t.ct_effective_until(), fees.effective_until.clone().unwrap_or_else(|| t.ct_open_ended().to_owned())),
    ];
    html! {
        <TermsSheet
            t={t}
            title={&fees.label}
            description={Some(t.ct_agreement_sheet_description())}
            close={t.ct_close_agreement()}
        >
            <TermsFacts rows={facts} />
            if let Some(published) = published {
                <TermsCompare
                    t={t}
                    title={t.ct_compare_published_schedule()}
                    left={source(t, published)}
                    right={t.ct_account_override()}
                    rows={vec![
                        (t.ct_label(), published.value.label.clone(), fees.label.clone()),
                        (
                            t.ct_marketplace_fee(),
                            fee(t, published.value.marketplace_sales_fee_percentage_bps, &published.value.marketplace_sales_fee_fixed_amount),
                            fee(t, fees.marketplace_sales_fee_percentage_bps, &fees.marketplace_sales_fee_fixed_amount),
                        ),
                        (
                            t.ct_shipping_allowance(),
                            percent(published.value.shipping_allowance_percentage_bps),
                            percent(fees.shipping_allowance_percentage_bps),
                        ),
                        (t.ct_marketplace_fee_cap(), usd(t, &published.value.marketplace_sales_fee_cap_amount), t.ct_none().to_owned()),
                        (
                            t.ct_effective_from(),
                            published.effective_from.as_deref().map_or(t.ct_none(), date).to_owned(),
                            date(&fees.effective_from).to_owned(),
                        ),
                    ]}
                />
            }
            <TermsHistory t={t} history={&agreement.history} />
            <section class={Part}>
                <h3 class={Minor}>{t.ct_revise_override()}</h3>
                <form class={Form} method="post">
                    <input type="hidden" name={f.intent} value="revise-agreement">
                    <input type="hidden" name={f.id} value={&agreement.agreement_id}>
                    <TermsFields t={t} form={&form} submit={t.ct_save_account_override()} />
                </form>
            </section>
        </TermsSheet>
    }
}

#[component(css = TermsPage)]
fn CreateScheduleSheet<'a>(t: Com, form: TermsForm, account_type: &'a str) -> impl Render {
    let f = TermsForm::FIELDS;
    let kinds = [("personal", t.ct_personal()), ("business", t.ct_business()), ("enterprise", t.ct_enterprise())];
    html! {
        <TermsSheet t={t} title={t.ct_create_schedule()} description={None} close={t.ct_close_create_schedule()}>
            <form class={Form} method="post">
                <input type="hidden" name={f.intent} value="create-schedule">
                <label class={Field}>
                    <span>{t.ct_account_type()}</span>
                    <select name={f.account_type} required>
                        for (value, words) in kinds {
                            <option value={value} selected={account_type == value}>{words}</option>
                        }
                    </select>
                </label>
                <TermsFields t={t} form={form} submit={t.ct_save_schedule()} />
            </form>
        </TermsSheet>
    }
}

/// Create account override. The account's select belongs to the save form, so a save always sends
/// the account on screen; Review re-reads the starting terms for it (with JavaScript, choosing an
/// account does, through the page's script).
#[component(css = TermsPage, js = TermsPage)]
fn CreateAgreementSheet<'a>(t: Com, form: TermsForm, accounts: &'a [AccountOption], chosen_account: &'a str) -> impl Render {
    let f = TermsForm::FIELDS;
    html! {
        <TermsSheet
            t={t}
            title={t.ct_create_account_override()}
            description={Some(t.ct_create_account_override_description())}
            close={t.ct_close_create_override()}
        >
            <form class={Form} method="post">
                <input type="hidden" name={f.intent} value="create-agreement">
                <label class={Field}>
                    <span>{t.ct_account()}</span>
                    <select name={f.account_id} required on:change={js::prefill(target)}>
                        for option in accounts {
                            <option value={&option.account_id} selected={option.account_id == chosen_account}>
                                {t.ct_account_option(&option.display_name, &option.account_type)}
                            </option>
                        }
                    </select>
                </label>
                <TermsFields t={t} form={form} submit={t.ct_save_account_override()} />
                <button type="submit" class={(Button, Secondary)} name={f.review} value="account" formnovalidate>
                    {t.ct_review()}
                </button>
            </form>
        </TermsSheet>
    }
}

/// An active or scheduled term (`CommercialTermCardView`).
#[component(css = TermsPage)]
fn TermCard<'a>(t: Com, term: &'a Term) -> impl Render {
    let fees = term.fees();
    let (phase, at) = term.phase();
    let when = match phase {
        Phase::Scheduled => t.ct_effective(date(at)).to_string(),
        Phase::Expiring => t.ct_override_expires(date(at)).to_string(),
        Phase::InEffect => t.ct_effective_since(date(at)).to_string(),
    };
    // admin-web's `term.phase === "scheduled" ? "warning" : "success"`: every active term is active.
    let tone = if phase == Phase::Scheduled { "warning" } else { "success" };
    let (open, subtitle, account) = match term {
        Term::Schedule { id, item, .. } => (
            url::Open { schedule: Some(id.clone()), ..url::Open::default() },
            t.ct_schedule_for(&item.account_type).to_string(),
            None,
        ),
        Term::Agreement { id, item, .. } => {
            (url::Open { agreement: Some(id.clone()), ..url::Open::default() }, item.account(), Some(item.account_id.clone()))
        }
    };
    html! {
        <li class={Term}>
            <TermsBadge words={&fees.status} tone={tone} />
            <h3 class={Minor}>{&fees.label}</h3>
            <p class={Muted}>{subtitle}</p>
            if let Some(account) = account {
                <p class={(Small, Words)}>{account}</p>
            }
            <p class={Strong}>{when}</p>
            <p class={Small}>{fee(t, fees.marketplace_sales_fee_percentage_bps, &fees.marketplace_sales_fee_fixed_amount)}</p>
            <a class={(Button, Secondary)} href={href(open)}>{t.ct_review()}</a>
        </li>
    }
}

#[component(css, js)]
pub fn TermsPage<'a>(t: Com, p: Pilot, screen: &'a TermsScreen) -> impl Render {
    let sent = |intent: &str| screen.sent.as_ref().filter(|s| s.intent == intent);
    let list = screen.home.as_ref().map_or(&[][..], |home| &home.active_terms);
    let asked = match &screen.sheet {
        Sheet::CreateAgreement { account } => account.as_deref(),
        _ => None,
    };
    let chosen_account = sent("create-agreement").map_or_else(|| chosen(&screen.accounts, asked), |s| s.account_id.as_str());
    html! {
        <div class={Page}>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.ct_eyebrow()}</p>
                    <h1>{t.ct_title()}</h1>
                    <p class={Muted}>{t.ct_description()}</p>
                </div>
                <div class={Actions}>
                    <a
                        class={(Button, Secondary)}
                        href={href(url::Open { create: Some("schedule".into()), ..url::Open::default() })}
                    >
                        {t.ct_create_schedule()}
                    </a>
                    <a class={Button} href={href(url::Open { create: Some("agreement".into()), ..url::Open::default() })}>
                        {t.ct_create_account_override()}
                    </a>
                </div>
            </header>
            <div class={Warn} role="note">
                <p class={Strong}>{t.ct_fee_lock_title()}</p>
                <p>{t.ct_fee_lock_description()}</p>
            </div>
            if let Some(error) = &screen.load_error {
                <div class={Alert} role="alert">
                    <p class={Strong}>{t.ct_unavailable()}</p>
                    <p>{error}</p>
                </div>
            }
            if let Some(error) = &screen.error {
                <div class={Alert} role="alert">
                    <p class={Strong}>{t.ct_change_rejected()}</p>
                    <p>{error}</p>
                </div>
            }
            if screen.catching_up {
                <p class={Note} role="status">{p.error_pending()}</p>
            }
            if let Some(published) = &screen.published {
                <section class={(Panel, Featured)} aria-labelledby="ct-published">
                    <TermsBadge
                        words={source(t, published)}
                        tone={if published.source == "policy" { "success" } else { "warning" }}
                    />
                    <h2 class={Heading} id="ct-published">{&published.value.label}</h2>
                    <TermsFacts
                        rows={vec![
                            (t.ct_marketplace_fee(), fee(t, published.value.marketplace_sales_fee_percentage_bps, &published.value.marketplace_sales_fee_fixed_amount)),
                            (t.ct_marketplace_fee_cap(), usd(t, &published.value.marketplace_sales_fee_cap_amount)),
                            (t.ct_shipping_allowance(), percent(published.value.shipping_allowance_percentage_bps)),
                            (t.ct_effective_from(), published.effective_from.as_deref().map_or(t.ct_none(), date).to_owned()),
                        ]}
                    />
                </section>
            }
            <section class={Part} aria-labelledby="ct-active">
                <h2 class={Heading} id="ct-active">{t.ct_active_and_scheduled()}</h2>
                <ul class={Cards}>
                    for term in list {
                        <TermCard t={t} term={term} />
                    }
                </ul>
            </section>
            match &screen.sheet {
                Sheet::Schedule(schedule) => {
                    <ScheduleSheet
                        t={t}
                        schedule={schedule}
                        active={screen.home.as_ref().and_then(|home| home.schedule_comparison.as_ref())}
                        sent={sent("revise-schedule")}
                    />
                }
                Sheet::Agreement(agreement) => {
                    <AgreementSheet
                        t={t}
                        agreement={agreement}
                        published={screen.published.as_ref()}
                        sent={sent("revise-agreement")}
                    />
                }
                Sheet::CreateSchedule => {
                    if let Some(home) = &screen.home {
                        <CreateScheduleSheet
                            t={t}
                            form={sent("create-schedule").cloned().unwrap_or_else(|| TermsForm::starting(&home.starting_terms.schedule, t.ct_new_schedule()))}
                            account_type={sent("create-schedule").map_or("business", |s| s.account_type.as_str())}
                        />
                    }
                }
                Sheet::CreateAgreement { .. } => {
                    <CreateAgreementSheet
                        t={t}
                        form={sent("create-agreement").cloned().unwrap_or_else(|| {
                            let kind = screen.accounts.iter().find(|a| a.account_id == chosen_account).map(|a| a.account_type.as_str());
                            match &screen.home {
                                Some(home) => TermsForm::starting(home.starting_terms.overrides.for_type(kind), t.ct_new_override()),
                                None => TermsForm::default(),
                            }
                        })}
                        accounts={&screen.accounts}
                        chosen_account={chosen_account}
                    />
                }
                Sheet::None => {}
            }
        </div>
    }
}

/// The account Create account override opens on: the one asked for when it can have an override,
/// else the first (admin-web's `firstAccountId`).
fn chosen<'a>(accounts: &'a [AccountOption], asked: Option<&str>) -> &'a str {
    accounts
        .iter()
        .find(|a| Some(a.account_id.as_str()) == asked)
        .or_else(|| accounts.first())
        .map_or("", |a| a.account_id.as_str())
}
