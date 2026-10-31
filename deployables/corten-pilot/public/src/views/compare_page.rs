//! The compare pages' views, after `compare-page.tsx` and `fee-comparison-calculator.tsx`, and
//! Contact's (`PublicInfoPage`).
//!
//! Everything reads and works without a script: the table is a table, the FAQ is `<details>`, and
//! the calculator is a GET form with Calculate. The shell's script (`home.js`) sends the form as
//! the visitor types (the section is redrawn in place), shows Copy share link, and sends the
//! analytics events public-web sends.
use corten::{
    i18n::{Currency, Minor},
    prelude::*,
};

use super::home_page::{Icon, IconName, handlers};
use crate::{
    compare::{self, Calculator, Competitor, MAX_CARDS, Schedule},
    text::{CompareMsg, HomeMsg, Pilot},
};

const USD: Currency = Currency::new("USD");

/// The calculator's section, which a calculation draws again; public-web's `#fee-calculator`.
#[derive(Id)]
pub struct FeeCalculatorId;

fn money(t: HomeMsg, cents: i64) -> String {
    t.money(Minor(cents), USD).to_string()
}

/// A compare page (`ComparePage`): the header, the table, why and where the competitor is ahead,
/// the calculator, the questions, the call to action and the sources.
#[component(css)]
pub fn ComparePage<'a>(
    c: CompareMsg,
    t: HomeMsg,
    p: Pilot,
    competitor: Competitor,
    schedule: Option<Schedule>,
    calculator: Option<&'a Calculator>,
) -> impl Render + 'a {
    let facts = competitor.facts(t);
    let by_key =
        |suffix: &str| c.by_key(&format!("{}.{suffix}", competitor.slug()), &facts).map(|m| m.to_string()).unwrap_or_default();
    let name = competitor.name(t);
    let seller_fees = match schedule {
        Some(s) => c.chase_sets_seller_fees_live(compare::percent(s.bps), money(t, s.fixed), money(t, s.cap)).to_string(),
        None => c.chase_sets_seller_fees_fallback().to_owned(),
    };
    let rows = [
        (c.row_seller_fees(), seller_fees, by_key("seller_fees")),
        (c.row_processing(), c.chase_sets_processing().to_owned(), by_key("processing")),
        (c.row_fee_lock(), c.chase_sets_fee_lock().to_owned(), by_key("fee_lock")),
        (c.row_protection(), c.chase_sets_protection().to_owned(), by_key("protection")),
        (c.row_payouts(), c.chase_sets_payouts().to_owned(), by_key("payouts")),
        (c.row_coverage(), c.chase_sets_coverage().to_owned(), by_key("coverage")),
        (c.row_availability(), c.chase_sets_availability().to_owned(), by_key("availability")),
    ];
    let questions = compare::faq(c, t, competitor);
    let (description, honesty) = (by_key("description"), by_key("honesty.body"));
    let section = format!("compare_{}", competitor.slug());
    html! {
        <div class={Page} on:connect={handlers::compare(target)} on:click={handlers::compared(event, target)}>
            <header class={Header}>
                <p class={Eyebrow}>{c.eyebrow()}</p>
                <h1 class={Title}>{compare::title_of(c, competitor)}</h1>
                <p class={Muted}>{&description}</p>
            </header>
            <section class={Section} data-public-presence-section="compare_table" aria-labelledby="compare-table">
                <div class={SectionHead}>
                    <h2 class={SectionTitle} id="compare-table">{c.table_title()}</h2>
                    <p class={Muted}>{c.table_description(name, compare::AS_OF)}</p>
                </div>
                <div class={TableBox}>
                    <table class={(Table, Wordy)}>
                        <caption class={Caption}>{c.table_caption(name)}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{c.table_column_dimension()}</th>
                                <th scope="col">{t.home_fee_calculator_column_chase_sets()}</th>
                                <th scope="col">{name}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (row, ours, theirs) in &rows {
                                <tr>
                                    <th scope="row">{*row}</th>
                                    <td>{ours}</td>
                                    <td>{theirs}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
            <div class={Pair}>
                <div class={Card}>
                    <h2 class={CardTitle}>{c.why_title()}</h2>
                    <p class={Muted}>{c.why_body()}</p>
                </div>
                <div class={Card}>
                    <h2 class={CardTitle}>{c.honesty_title(name)}</h2>
                    <p class={Muted}>{&honesty}</p>
                </div>
            </div>
            if let Some(calculator) = calculator {
                <FeeCalculator t={t} c={c} p={p} calculator={calculator} />
            }
            <section class={Section} data-public-presence-section="compare_faq" aria-labelledby="compare-faq">
                <h2 class={SectionTitle} id="compare-faq">{c.faq_title()}</h2>
                <div class={Group}>
                    for (value, question, answer) in &questions {
                        <details class={GroupItem} data-faq={*value}>
                            <summary class={Summary}>
                                {question}
                                <Icon name={IconName::ChevronDown} />
                            </summary>
                            <p class={DisclosureBody}>{answer}</p>
                        </details>
                    }
                </div>
            </section>
            <div class={(Card, Subtle)}>
                <p class={Muted}>{c.cta_text()}</p>
                <div class={Actions}>
                    <a class={(Button, Primary)} href="/#waitlist-form" data-cta={&section} data-target="waitlist_form">
                        {t.nav_waitlist()}
                    </a>
                    <a class={(Button, Secondary)} href={crate::app::url::sales_fees::SalesFees.href()}>{t.nav_seller_fees()}</a>
                </div>
            </div>
            <p class={Note}>{c.sources_note(name, compare::AS_OF)}</p>
        </div>
    }
}

/// The calculator (`FeeCalculatorWorkbench`): the price and the card count, the three
/// marketplaces' fees and what the seller keeps, the cap's note, Copy share link, the founders'
/// window, the sources and the other compare page. Drawn again on each calculation.
#[component(css = ComparePage)]
pub fn FeeCalculator<'a>(t: HomeMsg, c: CompareMsg, p: Pilot, calculator: &'a Calculator) -> impl Patch + 'a {
    let schedule = calculator.schedule;
    let rate = compare::percent(schedule.bps);
    let cap = money(t, schedule.cap);
    let outcomes = calculator.outcomes();
    let total = calculator.price.zip(calculator.cards).map(|(p, n)| money(t, p * i64::from(n)));
    let other = calculator.competitor.other();
    let link = match other {
        Competitor::Tcgplayer => c.link_tcgplayer(),
        Competitor::Ebay => c.link_ebay(),
    };
    let action = format!("{}#{}", calculator.competitor.path(), <FeeCalculatorId as Id>::NAME);
    html! {
        <section
            class={Section}
            id={FeeCalculatorId}
            data-public-presence-section="fee_calculator"
            aria-labelledby="fee-calculator-title"
        >
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="fee-calculator-title">{t.home_fee_calculator_title()}</h2>
                <p class={Muted}>{t.home_fee_calculator_description(&rate, &cap)}</p>
            </div>
            <form class={Calculator} method="get" action={&action} data-patch on:input={handlers::calculate(event)}>
                <div class={Pair}>
                    <div class={Field}>
                        <label class={Label} for="fee-calculator-price">{t.home_fee_calculator_price_label()}</label>
                        <input
                            class={Input}
                            id="fee-calculator-price"
                            name="price"
                            inputmode="decimal"
                            autocomplete="off"
                            value={&calculator.price_input}
                            aria-invalid={calculator.price.is_none().then_some("true")}
                            aria-describedby={calculator.price.is_none().then_some("fee-calculator-price-error")}
                        >
                        if calculator.price.is_none() {
                            <p class={Error} id="fee-calculator-price-error">{t.home_fee_calculator_price_error()}</p>
                        }
                    </div>
                    <div class={Field}>
                        <label class={Label} for="fee-calculator-cards">{t.home_fee_calculator_cards_label()}</label>
                        <input
                            class={Input}
                            id="fee-calculator-cards"
                            name="cards"
                            type="number"
                            min="1"
                            max={MAX_CARDS.to_string()}
                            step="1"
                            inputmode="numeric"
                            autocomplete="off"
                            value={&calculator.cards_input}
                            aria-invalid={calculator.cards.is_none().then_some("true")}
                            aria-describedby={calculator.cards.is_none().then_some("fee-calculator-cards-error")}
                        >
                        if calculator.cards.is_none() {
                            <p class={Error} id="fee-calculator-cards-error">{t.home_fee_calculator_cards_error()}</p>
                        }
                    </div>
                </div>
                <div class={Actions} on:connect={handlers::conceal(target)}>
                    <button class={(Button, Secondary)} type="submit">{p.compare_calculate()}</button>
                </div>
            </form>
            if let (Some((ours, tcgplayer, ebay)), Some(total), Some(price), Some(cards)) =
                (outcomes, total.as_deref(), calculator.price, calculator.cards) {
                <div class={Results} role="status" aria-live="polite">
                    if cards > 1 {
                        <p class={Note}>{t.home_fee_calculator_per_card_note(cards, money(t, price), total)}</p>
                    }
                    <div class={TableBox}>
                        <table class={Table}>
                            <caption class={Caption}>{t.home_fee_calculator_caption(total)}</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{t.home_fee_calculator_column_metric(total)}</th>
                                    <th scope="col">{t.home_fee_calculator_column_chase_sets()}</th>
                                    <th scope="col">{t.home_fee_calculator_column_tcgplayer()}</th>
                                    <th scope="col">{t.home_fee_calculator_column_ebay()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <th scope="row">{t.home_fee_calculator_row_marketplace_fee()}</th>
                                    <td class={Amount}>{money(t, ours.fee)}</td>
                                    <td class={Amount}>{money(t, tcgplayer.fee)}</td>
                                    <td class={Amount}>{money(t, ebay.fee)}</td>
                                </tr>
                                <tr>
                                    <th scope="row">{t.home_fee_calculator_row_processing()}</th>
                                    <td>{t.home_fee_calculator_row_processing_chase_sets()}</td>
                                    <td class={Amount}>{money(t, tcgplayer.processing)}</td>
                                    <td class={Amount}>{money(t, ebay.processing)}</td>
                                </tr>
                                <tr>
                                    <th scope="row">{t.home_fee_calculator_row_you_keep()}</th>
                                    <td class={Amount}><span class={Kept}>{money(t, ours.kept)}</span></td>
                                    <td class={Amount}>{money(t, tcgplayer.kept)}</td>
                                    <td class={Amount}>{money(t, ebay.kept)}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    if ours.capped {
                        <p class={Note} data-testid="fee-calculator-cap-note">
                            {t.home_fee_calculator_cap_note(&rate, money(t, schedule.uncapped(price)), &cap)}
                        </p>
                    }
                    if let Some(share) = &calculator.share {
                        <div class={Actions}>
                            <button
                                class={(Button, Secondary, Small)}
                                type="button"
                                hidden
                                data-value={share}
                                on:connect={handlers::reveal(target)}
                                on:click={handlers::share(target)}
                            >
                                {t.home_fee_calculator_share_action()}
                            </button>
                            <p class={Note} role="status" data-copied={t.home_fee_calculator_share_copied()}></p>
                        </div>
                    }
                </div>
            }
            <div class={(Card, Subtle)}>
                <div class={Actions}>
                    <span class={Badge}>{t.home_fee_calculator_founders_badge()}</span>
                    <a class={(Button, Secondary, Small)} href={crate::app::url::Founders.href()}>
                        {t.home_fee_calculator_founders_action()}
                    </a>
                </div>
                <p class={Note}>{t.home_fee_calculator_founders_text()}</p>
            </div>
            <p class={Note}>{t.home_fee_calculator_source_note()}</p>
            <div>
                <a
                    class={(Button, Secondary, Small)}
                    href={other.path()}
                    data-cta="fee_calculator"
                    data-target={format!("compare_{}", other.slug())}
                >
                    {link}
                </a>
            </div>
        </section>
    }
}

/// Contact (`PublicInfoPage`): the header and the two cards.
#[component(css = ComparePage)]
pub fn ContactPage(c: CompareMsg) -> impl Render {
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{c.contact_eyebrow()}</p>
                <h1 class={Title}>{c.contact_title()}</h1>
                <p class={Muted}>{c.contact_description()}</p>
            </header>
            <div class={Pair}>
                <section class={Card} aria-labelledby="contact-support">
                    <h2 class={CardTitle} id="contact-support">{c.contact_support_title()}</h2>
                    <p class={Muted}>{c.contact_support_body()}</p>
                </section>
                <section class={Card} aria-labelledby="contact-status">
                    <h2 class={CardTitle} id="contact-status">{c.contact_status_title()}</h2>
                    <p class={Muted}>{c.contact_status_body()}</p>
                </section>
            </div>
        </div>
    }
}
