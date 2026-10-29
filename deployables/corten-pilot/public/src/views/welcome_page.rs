//! The welcome page's views, after `success-page.tsx`: the header, the wave-placement form for a
//! seller, what happens next, and Move up the list (the place in line, the referral link with
//! Copy, the progress to the goal, and the share links).
//!
//! Everything reads and works without a script: the games are checkboxes, the form has Save, the
//! progress is a `<progress>`, and the share links are links. Copy is corten-ui's `CopyButton`,
//! counted when it reports a copy; the shell's script (`home.js`) adds the field-by-field saves,
//! the Discord share's copied message and the analytics events.
use corten::prelude::*;
use corten_ui::{Copied, CopyButton};

use super::home_page::handlers;
use crate::{
    app::url,
    home::Game,
    text::{HomeMsg, Pilot},
    welcome::{SIZES, Saved, Screen},
};

/// The wave-placement form's status line, which a save draws again in place.
#[derive(Id)]
pub struct WaveStatusId;

/// The referral link's field, which Copy copies.
#[derive(Id)]
pub struct WelcomeReferralLinkId;

fn size_label(t: HomeMsg, size: &str) -> &'static str {
    match size {
        "under_100" => t.waitlist_inventory_size_under100(),
        "100_to_500" => t.waitlist_inventory_size_100to500(),
        "500_to_2000" => t.waitlist_inventory_size_500to2000(),
        _ => t.waitlist_inventory_size_2000plus(),
    }
}

#[component(css)]
pub fn WelcomePage<'a>(t: HomeMsg, p: Pilot, screen: &'a Screen, saved: Option<Saved>) -> impl Render + 'a {
    let referrals = &screen.referrals;
    let goal = referrals.goal.to_string();
    let x = format!("https://twitter.com/intent/tweet?text={}", crate::home::form_encode(&screen.share).replace('+', "%20"));
    let variant = screen.arrival.variant().as_str();
    let attributed = screen.arrival.attributed.as_deref() == Some("1");
    html! {
        <div
            class={Page}
            data-variant={variant}
            data-attributed={attributed.then_some("1")}
            on:connect={handlers::welcome(target)}
        >
            <header class={Header}>
                <p class={Eyebrow}>{t.welcome_eyebrow()}</p>
                <h1 class={Title}>{t.waitlist_success_title()}</h1>
                <p class={Muted}>{t.waitlist_success_description()}</p>
            </header>
            if screen.asks_wave() {
                <WaveForm t={t} p={p} screen={screen} saved={saved} />
            }
            <section class={Section} aria-labelledby="welcome-next">
                <h2 class={SectionTitle} id="welcome-next">{t.welcome_what_next_title()}</h2>
                <ul class={Points}>
                    <li>{t.welcome_what_next_point_review()}</li>
                    <li>{t.welcome_what_next_point_founders()}</li>
                    <li>{t.welcome_what_next_point_email()}</li>
                    <li>{t.welcome_what_next_point_discord()}</li>
                </ul>
                <p><a class={(Button, Secondary, Small)} href={url::Founders}>{t.nav_founders_terms()}</a></p>
            </section>
            <section class={Section} aria-labelledby="welcome-referral">
                <div class={SectionHead}>
                    <h2 class={SectionTitle} id="welcome-referral">{t.welcome_referral_title()}</h2>
                    <p class={Muted}>{t.welcome_referral_description(&goal)}</p>
                </div>
                <div class={Columns}>
                    <div class={Card}>
                        match referrals.position {
                            Some(position) => {
                                <div class={Place}>
                                    <p class={Position}>
                                        {t.welcome_referral_position_value(&position.to_string(), &referrals.total.to_string())}
                                    </p>
                                    if referrals.advanced > 0 {
                                        <p class={Note}>
                                            {t.welcome_referral_position_advanced(&referrals.advanced.to_string())}
                                        </p>
                                    }
                                </div>
                            }
                            None => { <p class={Note}>{t.welcome_referral_position_pending()}</p> }
                        }
                        <label class={Label} for={WelcomeReferralLinkId}>{t.welcome_referral_link_label()}</label>
                        <div class={LinkRow} on:Copied={handlers::counted(event)}>
                            <input
                                class={Input}
                                id={WelcomeReferralLinkId}
                                type="url"
                                readonly
                                value={&screen.link}
                                on:focus={handlers::selected(target)}
                            >
                            <span class={CopyLink}>
                                <CopyButton
                                    text={WelcomeReferralLinkId}
                                    label={t.welcome_referral_copy_action()}
                                    copied={t.welcome_referral_copied_action()}
                                />
                            </span>
                        </div>
                        <div class={Progress}>
                            <div class={ProgressHead}>
                                <span id="welcome-progress-label">{t.welcome_referral_progress_label()}</span>
                                <span>{t.welcome_referral_progress_value(&referrals.count.to_string(), &goal)}</span>
                            </div>
                            <progress
                                class={(Bar, screen.goal_reached().then_some(Done))}
                                aria-labelledby="welcome-progress-label"
                                max={&goal}
                                value={referrals.count.min(referrals.goal).to_string()}
                            ></progress>
                            <p class={Note}>
                                if screen.goal_reached() {
                                    {t.welcome_referral_progress_complete()}
                                } else {
                                    {t.welcome_referral_progress_description()}
                                }
                            </p>
                        </div>
                        if screen.goal_reached() {
                            <span class={Badge}>{t.welcome_referral_progress_complete()}</span>
                        }
                    </div>
                    <div class={Card}>
                        <h3 class={CardTitle}>{t.welcome_referral_share_title()}</h3>
                        <div class={Actions}>
                            <a
                                class={(Button, Secondary)}
                                href={&x}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-share="x"
                                on:click={handlers::shared(target)}
                            >
                                {t.welcome_referral_share_x()}
                            </a>
                            if let Some(discord) = &screen.discord {
                                <a
                                    class={(Button, Secondary)}
                                    href={discord}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-share="discord"
                                    data-value={&screen.share}
                                    on:click={handlers::shared(target)}
                                >
                                    {t.welcome_referral_share_discord()}
                                </a>
                            }
                        </div>
                    </div>
                </div>
            </section>
            <p><a class={(Button, Secondary)} href={url::files::Home}>{t.welcome_back_home()}</a></p>
        </div>
    }
}

/// Help us place you in the right wave: the games, the inventory size and the store link. Each
/// field's change saves it with a script; Save sends them all without one.
#[component(css = WelcomePage)]
fn WaveForm<'a>(t: HomeMsg, p: Pilot, screen: &'a Screen, saved: Option<Saved>) -> impl Render + 'a {
    let games = screen.arrival.games();
    let action = url::files::Welcome { arrival: crate::welcome::Arrival { saved: None, ..screen.arrival.clone() } };
    html! {
        <section class={Section} aria-labelledby="welcome-wave">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="welcome-wave">{t.welcome_wave_placement_title()}</h2>
                <p class={Muted}>{t.welcome_wave_placement_description()}</p>
            </div>
            <form class={(Card, Wave)} method="post" action={action} data-patch on:change={handlers::wave(event)}>
                <fieldset class={Games}>
                    <legend class={Label}>{t.waitlist_games_label()}</legend>
                    <p class={Note}>{t.waitlist_games_description()}</p>
                    <div class={Chips}>
                        for game in Game::ALL {
                            <label class={Chip}>
                                <input type="checkbox" name="games" value={game.slug()} checked={games.contains(&game)}>
                                <span>{game.label(t)}</span>
                            </label>
                        }
                    </div>
                </fieldset>
                <div class={Fields}>
                    <label class={Field}>
                        <span class={Label}>{t.waitlist_inventory_size_label()}</span>
                        <select class={Input} name="inventory_size">
                            <option value="">{t.waitlist_inventory_size_placeholder()}</option>
                            for size in SIZES {
                                <option value={size}>{size_label(t, size)}</option>
                            }
                        </select>
                    </label>
                    <label class={Field}>
                        <span class={Label}>{t.welcome_wave_placement_store_link_label()}</span>
                        <span class={Note}>{t.welcome_wave_placement_store_link_why()}</span>
                        <input class={Input} type="url" name="store_url" placeholder={t.waitlist_store_url_placeholder()}>
                    </label>
                </div>
                <div class={Actions}>
                    <button class={(Button, Primary)} type="submit" name="field" value="all" data-wave-save>
                        {p.welcome_save()}
                    </button>
                    <button type="submit" name="field" value="games" hidden data-wave-field="games"></button>
                    <button type="submit" name="field" value="inventory_size" hidden data-wave-field="inventory_size"></button>
                    <button type="submit" name="field" value="store_url" hidden data-wave-field="store_url"></button>
                    <WaveStatus t={t} saved={saved} />
                </div>
            </form>
        </section>
    }
}

/// Saved, or That didn't save, after the last save; a script says Saving... while one is sent.
#[component(css = WelcomePage)]
pub fn WaveStatus(t: HomeMsg, saved: Option<Saved>) -> impl Patch {
    html! {
        <p
            class={(Note, (saved == Some(Saved::Failed)).then_some(Failed))}
            id={WaveStatusId}
            role="status"
            data-saving={t.welcome_wave_placement_saving()}
        >
            match saved {
                Some(Saved::Yes) => { {t.welcome_wave_placement_saved()} }
                Some(Saved::Failed) => { {t.welcome_wave_placement_save_failed()} }
                None => {}
            }
        </p>
    }
}
