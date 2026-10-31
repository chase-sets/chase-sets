//! Waitlist (`WaitlistAdminPage`). Top to bottom: the header with Export CSV, the signups by role,
//! the invite waves' fill, the filters (one column on a phone, then two, then all in a row) and the
//! signups, which scroll on their own on a phone.
use corten::{
    i18n::{DateStyle, TimeStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    growth::waitlist::{INTERESTS, ROLES, WaitlistScreen, url},
    text::Gro,
};

fn when(t: Gro, at: &str) -> String {
    parse_timestamp(at).map_or_else(|| at.to_owned(), |when| t.date_time(when, DateStyle::Medium, TimeStyle::Short).to_string())
}

/// A role's words (admin-web's `roleLabel`), or the API's value.
pub fn role(t: Gro, value: &str) -> String {
    match value {
        "buy" => t.role_buy().to_owned(),
        "sell" => t.role_sell().to_owned(),
        "both" => t.role_both().to_owned(),
        other => other.to_owned(),
    }
}

/// An interest's words (admin-web's `interestLabel`), or the API's value.
pub fn interest(t: Gro, value: &str) -> String {
    match value {
        "low-sales-fees" => t.interest_low_seller_fees().to_owned(),
        "bulk-listing" => t.interest_bulk_listing().to_owned(),
        "set-completion" => t.interest_set_completion().to_owned(),
        "pricing-tools" => t.interest_pricing_tools().to_owned(),
        "efficient-shipping" => t.interest_efficient_shipping().to_owned(),
        other => other.to_owned(),
    }
}

#[component(css = WaitlistPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Stat}>
            <p class={Muted}>{label}</p>
            <p class={Value}>{value}</p>
        </div>
    }
}

#[component(css)]
pub fn WaitlistPage<'a>(t: Gro, screen: &'a WaitlistScreen) -> impl Render {
    let m = &screen.metrics;
    let chosen = &screen.chosen;
    let f = url::Filters::FIELDS;
    let export = url::Export { filters: chosen.filters() };
    let roles = [("all", t.admin_all_roles().to_owned())].into_iter().chain(ROLES.map(|r| (r, role(t, r))));
    let interests = [("all", t.admin_all_interests().to_owned())].into_iter().chain(INTERESTS.map(|i| (i, interest(t, i))));
    let sorts = [("updated", t.admin_sort_updated()), ("referrals", t.admin_sort_referrals())];
    html! {
        <div class={Page}>
            <header class={Header}>
                <div>
                    <p class={Eyebrow}>{t.admin_eyebrow()}</p>
                    <h1>{t.admin_title()}</h1>
                    <p class={Muted}>{t.admin_description()}</p>
                </div>
                <div class={Actions}>
                    <a class={(Button, Secondary)} href={export}>{t.admin_export()}</a>
                </div>
            </header>
            <div class={(Stats, Four)}>
                <Figure label={t.admin_total()} value={t.number(m.total_count).to_string()} />
                <Figure label={t.role_buy()} value={t.number(m.buy_count).to_string()} />
                <Figure label={t.role_sell()} value={t.number(m.sell_count).to_string()} />
                <Figure label={t.role_both()} value={t.number(m.both_count).to_string()} />
            </div>
            <section class={Card} aria-labelledby="wl-waves">
                <div>
                    <h2 class={Heading} id="wl-waves">{t.admin_wave_fill_title()}</h2>
                    <p class={Muted}>{t.admin_wave_fill_description()}</p>
                </div>
                <div class={(Stats, Three)}>
                    for wave in &m.wave_fill {
                        <Figure
                            label={&t.admin_wave_fill_wave(wave.wave_number).to_string()}
                            value={t.admin_wave_fill_value(wave.admitted_count, wave.capacity).to_string()}
                        />
                    }
                </div>
            </section>
            <section class={Card} aria-labelledby="wl-filters">
                <h2 class={Heading} id="wl-filters">{t.admin_filters()}</h2>
                <form class={Filters} method="get" action={url::Waitlist::default()}>
                    <label class={Field}>
                        <span>{t.admin_search()}</span>
                        <input type="search" name={f.search} value={&chosen.search}>
                    </label>
                    <label class={Field}>
                        <span>{t.admin_role()}</span>
                        <select name={f.role}>
                            for (value, words) in roles {
                                <option value={value} selected={chosen.role == value}>{words}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.admin_interest()}</span>
                        <select name={f.interest}>
                            for (value, words) in interests {
                                <option value={value} selected={chosen.interest == value}>{words}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span>{t.admin_sort()}</span>
                        <select name={f.sort}>
                            for (value, words) in sorts {
                                <option value={value} selected={chosen.sort == value}>{words}</option>
                            }
                        </select>
                    </label>
                    <button type="submit" class={Button}>{t.admin_apply_filters()}</button>
                </form>
            </section>
            <section class={Card} aria-labelledby="wl-signups">
                <h2 class={Heading} id="wl-signups">{t.admin_signups()}</h2>
                if screen.signups.items.is_empty() {
                    <div class={Nothing}>
                        <p class={Strong}>{t.admin_empty_title()}</p>
                        <p class={Muted}>{t.admin_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.admin_updated()}</th>
                                    <th scope="col">{t.admin_email()}</th>
                                    <th scope="col">{t.admin_role()}</th>
                                    <th scope="col">{t.admin_interests()}</th>
                                    <th scope="col">{t.admin_referrals()}</th>
                                    <th scope="col">{t.admin_referred()}</th>
                                    <th scope="col">{t.admin_source()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &screen.signups.items {
                                    <tr>
                                        <td>{when(t, &item.updated_at)}</td>
                                        <td class={Words}>{&item.email}</td>
                                        <td><span class={(Pill, Accent)}>{role(t, &item.role)}</span></td>
                                        <td>
                                            <span class={Pills}>
                                                for value in &item.interests {
                                                    <span class={(Pill, Neutral)}>{interest(t, value)}</span>
                                                }
                                            </span>
                                        </td>
                                        <td>
                                            if item.referral_count > 0 {
                                                <span class={(Pill, Good)}>{t.number(item.referral_count).to_string()}</span>
                                            } else {
                                                "0"
                                            }
                                        </td>
                                        <td>{if item.referred_by_signup_id.is_some() { t.admin_referred_yes() } else { "" }}</td>
                                        <td class={Words}>{item.source()}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
                <p class={Muted}>{t.admin_count_summary(screen.signups.count, screen.signups.total)}</p>
            </section>
        </div>
    }
}
