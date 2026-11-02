//! Campaign Analytics (`CampaignAnalyticsPage`). Top to bottom: the header, the admission bar with
//! its progress, the cohort's figures, game coverage, inventory sizes, channel attribution and the
//! funnel dashboard's link. The tables scroll on their own on a phone.
use corten::prelude::*;

use crate::{
    growth::campaign::{Analytics, FUNNEL_DASHBOARD, INVENTORY_SIZES, progress},
    text::Gro,
};

/// A game's words, or the API's value.
fn game(t: Gro, value: &str) -> String {
    match value {
        "pokemon" => t.game_pokemon().to_owned(),
        "magic-the-gathering" => t.game_magic_the_gathering().to_owned(),
        "yu-gi-oh" => t.game_yu_gi_oh().to_owned(),
        "disney-lorcana" => t.game_disney_lorcana().to_owned(),
        "one-piece-card-game" => t.game_one_piece_card_game().to_owned(),
        other => other.to_owned(),
    }
}

fn size(t: Gro, value: &str) -> String {
    match value {
        "under_100" => t.inventory_size_under100().to_owned(),
        "100_to_500" => t.inventory_size_100to500().to_owned(),
        "500_to_2000" => t.inventory_size_500to2000().to_owned(),
        "2000_plus" => t.inventory_size_2000plus().to_owned(),
        other => other.to_owned(),
    }
}

/// Progress toward a goal (`TaskProgress`): its label, a native progress bar and "{count} of {goal}".
#[component(css = CampaignPage)]
fn Progress<'a>(t: Gro, label: &'a str, count: u64, goal: u64, met: bool) -> impl Render {
    html! {
        <div class={Goal}>
            <div class={Line}>
                <span class={Strong}>{label}</span>
                <span class={Muted}>{t.admin_campaign_analytics_admission_bar_progress_value(count, goal)}</span>
            </div>
            <progress
                class={(Bar, if met { Met } else { Open })}
                max="100"
                value={progress(count, goal).to_string()}
                aria-label={label}
            >
                {format!("{}%", progress(count, goal))}
            </progress>
        </div>
    }
}

#[component(css = CampaignPage)]
fn Figure<'a>(label: &'a str, value: String) -> impl Render {
    html! {
        <div class={Stat}>
            <p class={Muted}>{label}</p>
            <p class={Value}>{value}</p>
        </div>
    }
}

#[component(css = CampaignPage)]
fn Empty<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Nothing}>
            <p class={Strong}>{title}</p>
            <p class={Muted}>{description}</p>
        </div>
    }
}

#[component(css)]
pub fn CampaignPage<'a>(t: Gro, analytics: &'a Analytics) -> impl Render {
    let q = &analytics.quality;
    let bar = &analytics.admission_bar;
    let funnel = crate::views::admin_web(FUNNEL_DASHBOARD).map(|u| u.to_string()).unwrap_or_else(|| FUNNEL_DASHBOARD.to_owned());
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{t.admin_eyebrow()}</p>
                <h1>{t.admin_campaign_analytics_title()}</h1>
                <p class={Muted}>{t.admin_campaign_analytics_description()}</p>
            </header>
            <section class={Card} aria-labelledby="ca-bar">
                <div>
                    <h2 class={Heading} id="ca-bar">{t.admin_campaign_analytics_admission_bar_title()}</h2>
                    <p class={Muted}>{t.admin_campaign_analytics_admission_bar_description()}</p>
                </div>
                <span class={(Pill, if bar.admitted { Good } else { Neutral })}>
                    {if bar.admitted {
                        t.admin_campaign_analytics_admission_bar_status_admitted()
                    } else {
                        t.admin_campaign_analytics_admission_bar_status_not_admitted()
                    }}
                </span>
                <Progress
                    t={t}
                    label={t.admin_campaign_analytics_admission_bar_total_signups()}
                    count={bar.total_signups}
                    goal={bar.goals.min_total_signups}
                    met={bar.total_signups_met}
                />
                <Progress
                    t={t}
                    label={t.admin_campaign_analytics_admission_bar_qualified_sellers()}
                    count={bar.qualified_seller_count}
                    goal={bar.goals.min_qualified_sellers}
                    met={bar.qualified_sellers_met}
                />
            </section>
            <div class={(Stats, Four)}>
                <Figure label={t.admin_campaign_analytics_stat_total_signups()} value={t.number(q.total_signups).to_string()} />
                <Figure
                    label={t.admin_campaign_analytics_stat_seller_signups()}
                    value={t.number(q.seller_signup_count).to_string()}
                />
                <Figure
                    label={t.admin_campaign_analytics_stat_qualified_sellers()}
                    value={t.number(q.qualified_seller_count).to_string()}
                />
                <Figure
                    label={t.admin_campaign_analytics_stat_store_link_percent()}
                    value={format!("{}%", q.store_link_percent)}
                />
            </div>
            <section class={Card} aria-labelledby="ca-games">
                <div>
                    <h2 class={Heading} id="ca-games">{t.admin_campaign_analytics_game_coverage_title()}</h2>
                    <p class={Muted}>{t.admin_campaign_analytics_game_coverage_description()}</p>
                </div>
                if bar.game_coverage.is_empty() {
                    <Empty
                        title={t.admin_campaign_analytics_game_coverage_empty_title()}
                        description={t.admin_campaign_analytics_game_coverage_empty_description()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.admin_campaign_analytics_game_coverage_game()}</th>
                                    <th scope="col">{t.admin_campaign_analytics_game_coverage_qualified_sellers()}</th>
                                    <th scope="col">{t.admin_campaign_analytics_game_coverage_covered()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &bar.game_coverage {
                                    <tr>
                                        <th scope="row">{game(t, &row.game)}</th>
                                        <td>{t.number(row.qualified_seller_count).to_string()}</td>
                                        <td>
                                            <span class={(Pill, if row.covered { Good } else { Neutral })}>
                                                {if row.covered {
                                                    t.admin_campaign_analytics_game_coverage_covered_yes()
                                                } else {
                                                    t.admin_campaign_analytics_game_coverage_covered_no()
                                                }}
                                            </span>
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="ca-sizes">
                <h2 class={Heading} id="ca-sizes">{t.admin_campaign_analytics_inventory_size_title()}</h2>
                <div class={(Stats, Sizes)}>
                    for key in INVENTORY_SIZES {
                        <Figure
                            label={&size(t, key)}
                            value={t.number(q.inventory_size_distribution.get(key).copied().unwrap_or(0)).to_string()}
                        />
                    }
                </div>
            </section>
            <section class={Card} aria-labelledby="ca-channels">
                <div>
                    <h2 class={Heading} id="ca-channels">{t.admin_campaign_analytics_channel_attribution_title()}</h2>
                    <p class={Muted}>{t.admin_campaign_analytics_channel_attribution_description()}</p>
                </div>
                if analytics.channel_attribution.is_empty() {
                    <Empty
                        title={t.admin_campaign_analytics_channel_attribution_empty_title()}
                        description={t.admin_campaign_analytics_channel_attribution_empty_description()}
                    />
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{t.admin_campaign_analytics_channel_attribution_channel()}</th>
                                    <th scope="col">{t.admin_campaign_analytics_channel_attribution_signups()}</th>
                                    <th scope="col">{t.admin_campaign_analytics_channel_attribution_seller_signups()}</th>
                                    <th scope="col">{t.admin_campaign_analytics_channel_attribution_qualified_sellers()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for row in &analytics.channel_attribution {
                                    <tr>
                                        <th scope="row" class={Words}>
                                            {row.label().unwrap_or_else(|| t.admin_campaign_analytics_channel_direct().to_owned())}
                                        </th>
                                        <td>{t.number(row.signup_count).to_string()}</td>
                                        <td>{t.number(row.seller_signup_count).to_string()}</td>
                                        <td>{t.number(row.qualified_seller_count).to_string()}</td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="ca-funnel">
                <div>
                    <h2 class={Heading} id="ca-funnel">{t.admin_campaign_analytics_funnel_title()}</h2>
                    <p class={Muted}>{t.admin_campaign_analytics_funnel_description()}</p>
                </div>
                <p>
                    <a class={Link} href={&funnel} target="_blank" rel="noopener noreferrer">
                        {t.admin_campaign_analytics_funnel_link()}
                    </a>
                </p>
            </section>
        </div>
    }
}
