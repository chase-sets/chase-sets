//! Offer Economics (`OfferEconomicsAdminPage`). Top to bottom: the header, the reporting window,
//! the figures (one column on a phone, two from 40rem, three from 64rem), the standard schedule the
//! foregone fee is measured against, the weekly sell-through (a table that scrolls on its own on a
//! phone) and the order protection reserve.
use corten::prelude::*;

use super::{date, usd};
use crate::{
    insights::{Snapshot, ratio_percent},
    text::Ops,
};

#[component(css = OfferEconomicsPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Stat}>
            <p class={Muted}>{label}</p>
            <p class={Value}>{value}</p>
        </div>
    }
}

#[component(css)]
pub fn OfferEconomicsPage<'a>(o: Ops, snapshot: &'a Snapshot) -> impl Render {
    let s = snapshot;
    let n = |v: u64| o.number(v).to_string();
    let share = ratio_percent(s.locked_gmv_share_ratio.as_deref()).unwrap_or_else(|| o.oe_not_available().to_owned());
    let schedule = match &s.standard_schedule_source.schedule_label {
        Some(label) => o
            .oe_standard_schedule_description(
                label,
                &format!("{:.2}", s.standard_fee_percentage_bps as f64 / 100.0),
                &usd(o, &s.standard_fee_fixed_amount),
            )
            .to_string(),
        None => o.oe_standard_schedule_unavailable().to_owned(),
    };
    let reserve = &s.protection_reserve;
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{o.oe_eyebrow()}</p>
                <h1>{o.oe_title()}</h1>
                <p class={Muted}>{o.oe_description()}</p>
            </header>
            <section class={Card} aria-labelledby="oe-window">
                <h2 class={Heading} id="oe-window">{o.oe_window()}</h2>
                <p class={Muted}>{o.oe_window_range(&date(o, &s.from), &date(o, &s.to)).to_string()}</p>
            </section>
            <div class={Stats}>
                <Figure label={o.oe_listings_created()} value={n(s.listings_created_count)} />
                <Figure label={o.oe_locked_seller_account_count()} value={n(s.locked_seller_account_count)} />
                <Figure label={o.oe_locked_gmv()} value={usd(o, &s.locked_gmv_amount)} />
                <Figure label={o.oe_locked_gmv_share()} value={share} />
                <Figure label={o.oe_foregone_fee_estimate()} value={usd(o, &s.foregone_fee_estimate_amount)} />
                <Figure label={o.oe_platform_gmv()} value={usd(o, &s.platform_gmv_amount)} />
            </div>
            <section class={Card} aria-labelledby="oe-schedule">
                <h2 class={Heading} id="oe-schedule">{o.oe_standard_schedule()}</h2>
                <p class={Muted}>{schedule}</p>
            </section>
            <section class={Card} aria-labelledby="oe-trend">
                <h2 class={Heading} id="oe-trend">{o.oe_sell_through_trend()}</h2>
                if s.weekly_sell_through.is_empty() {
                    <div class={Nothing}>
                        <p class={Strong}>{o.oe_sell_through_empty_title()}</p>
                        <p class={Muted}>{o.oe_sell_through_empty_description()}</p>
                    </div>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.oe_week()}</th>
                                    <th scope="col">{o.oe_listings_created()}</th>
                                    <th scope="col">{o.oe_cumulative_listings_created()}</th>
                                    <th scope="col">{o.oe_cumulative_trade_count()}</th>
                                    <th scope="col">{o.oe_sell_through_rate()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for week in &s.weekly_sell_through {
                                    <tr>
                                        <td>{date(o, &week.week_start)}</td>
                                        <td>{n(week.listings_created_count)}</td>
                                        <td>{n(week.cumulative_listings_created_count)}</td>
                                        <td>{n(week.cumulative_trade_count)}</td>
                                        <td>
                                            {ratio_percent(week.sell_through_rate.as_deref()).unwrap_or_else(|| o.oe_not_available().to_owned())}
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="oe-reserve">
                <h2 class={Heading} id="oe-reserve">{o.oe_protection_reserve()}</h2>
                if reserve.available {
                    <p><span class={(Pill, Good)}>{o.oe_protection_reserve_available()}</span></p>
                    <div class={Stats}>
                        <Figure label={o.oe_protection_reserve_contribution()} value={usd(o, &reserve.contribution_amount)} />
                        <Figure label={o.oe_protection_reserve_allowance()} value={usd(o, &reserve.allowance_amount)} />
                        <Figure label={o.oe_protection_reserve_overage()} value={usd(o, &reserve.overage_amount)} />
                        <Figure label={o.oe_protection_reserve_reversals()} value={usd(o, &reserve.reversal_amount)} />
                        <Figure label={o.oe_protection_reserve_covered_orders()} value={n(reserve.covered_order_count)} />
                    </div>
                } else {
                    <p><span class={(Pill, Neutral)}>{o.oe_protection_reserve_pending()}</span></p>
                    <p class={Muted}>{reserve.reason.as_deref().unwrap_or("")}</p>
                }
            </section>
        </div>
    }
}
