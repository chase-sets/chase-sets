//! The home page's views, after `public-pages.tsx`: the public-presence shell's parts (promo bar,
//! nav, footer; [`crate::views::HomeLayout`] puts them around `<main>`) and the page: the hero
//! with its form, the game roster, open offers, the fee comparison, the founders offer, the full
//! form and the FAQ, with the sticky calls to action.
//!
//! Everything reads and works without script: the hero's buy, sell or both is three radios, the
//! disclosures are `<details>`, the promo bar shows its first message, and both forms post. The
//! script (`home.js`) adds what public-web's React adds: the buyer's hero when the visitor picks
//! Buy, the two forms' choices kept in step, the promo bar's turns, the sticky bars, the referrer
//! in the forms, and the analytics events.
use corten::prelude::*;

use crate::{
    home::{Game, Interest, Panel, Role, Screen, Variant},
    presence::{Promo, Tone},
    text::{HomeMsg, Pilot},
};

corten::script::script!(pub mod handlers = "home.js");

/// The id of the hero's form, which the nav, the structured data and the roster link to.
const HERO_FORM: &str = "waitlist-form";
/// The id of the full form, which the sticky bars link to.
const FINAL_FORM: &str = "waitlist-form-final";

/// A number as public-web's translator writes one in a message (`String(value)`).
fn plain(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 { format!("{}", value as i64) } else { value.to_string() }
}

/// `heroTitleContent`: the title around its one foil word, when the word is in it once.
fn foil<'a>(title: &'a str, word: &str) -> Option<(&'a str, &'a str, &'a str)> {
    let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_');
    let found: Vec<usize> = title
        .match_indices(word)
        .map(|(at, _)| at)
        .filter(|&at| boundary(title[..at].chars().next_back()) && boundary(title[at + word.len()..].chars().next()))
        .collect();
    match found.as_slice() {
        [at] => Some((&title[..*at], &title[*at..*at + word.len()], &title[*at + word.len()..])),
        _ => None,
    }
}

/// The page, inside `<main>`.
#[component(css)]
pub fn HomePage<'a>(t: HomeMsg, p: Pilot, screen: &'a Screen) -> impl Render {
    let variant = screen.variant();
    let failed = screen.sent.is_some();
    html! {
        <div
            class={Home}
            data-variant={variant.as_str()}
            data-page-path={&screen.landing.source.page_path}
            data-failed={failed.then_some("")}
            on:connect={handlers::start(target)}
            on:change={handlers::change(event, target)}
            on:click={handlers::click(event, target)}
            on:focusin={handlers::focused(event, target)}
            on:submit={handlers::submitted(event, target)}
        >
            <Hero t={t} p={p} screen={screen} />
            <Roster t={t} screen={screen} />
            <OpenOffers t={t} />
            <Fees t={t} screen={screen} />
            <Founders t={t} screen={screen} />
            <FinalCta t={t} screen={screen} />
            <Faq t={t} screen={screen} />
            <Sticky t={t} />
        </div>
    }
}

/// `MarketingImageHero`: the picture under a scrim, the title (seller's or buyer's), the
/// highlights and the hero's form.
#[component(css = HomePage)]
fn Hero<'a>(t: HomeMsg, p: Pilot, screen: &'a Screen) -> impl Render {
    let [full, w800, w1200] = &screen.hero;
    let srcset = format!("{w800} 800w, {w1200} 1200w, {full} 1731w");
    let variant = screen.variant();
    html! {
        <section class={Hero} data-section="hero">
            <img
                class={HeroImage}
                src={full}
                srcset={&srcset}
                sizes="100vw"
                alt={t.home_hero_image_alt()}
                loading="eager"
                decoding="async"
                fetchpriority="high"
                width="1600"
                height="1000"
            >
            <div class={Scrim}></div>
            <div class={HeroGrid}>
                <div class={HeroCopies}>
                    <HeroCopy t={t} p={p} variant={Variant::SellerFirst} shown={variant == Variant::SellerFirst} />
                    <HeroCopy t={t} p={p} variant={Variant::BuyerFirst} shown={variant == Variant::BuyerFirst} />
                </div>
                <div class={HeroPanel}>
                    <SignupPanel t={t} screen={screen} panel={Panel::Hero} />
                </div>
            </div>
        </section>
    }
}

/// One variant's title, description and highlights; the other variant's is hidden until the
/// visitor picks its role.
#[component(css = HomePage)]
fn HeroCopy(t: HomeMsg, p: Pilot, variant: Variant, shown: bool) -> impl Render {
    let buyer = variant == Variant::BuyerFirst;
    let (title, word, description) = if buyer {
        (t.home_buyer_hero_title(), "cards", t.home_buyer_hero_description())
    } else {
        (t.home_title(), "marketplace", t.home_description())
    };
    let highlights = if buyer {
        [
            (t.home_buyer_hero_highlight_delivered_totals_label(), t.home_buyer_hero_highlight_delivered_totals_value()),
            (t.home_buyer_hero_highlight_shipping_credit_label(), t.home_buyer_hero_highlight_shipping_credit_value()),
            (t.home_buyer_hero_highlight_set_completion_label(), t.home_buyer_hero_highlight_set_completion_value()),
        ]
    } else {
        [
            (t.home_hero_highlight_offers_label(), t.home_hero_highlight_offers_value()),
            (t.home_hero_highlight_low_value_label(), t.home_hero_highlight_low_value_value()),
            (t.home_hero_highlight_launch_label(), t.home_hero_highlight_launch_value()),
        ]
    };
    let (first_label, first_value) = highlights[0];
    let parts = foil(title, word);
    html! {
        <div class={HeroCopy} data-variant-copy={variant.as_str()} hidden={!shown}>
            <div class={HeroText}>
                <h1 class={HeroTitle}>
                    match parts {
                        Some((before, word, after)) => { {before}<span class={Foil}>{word}</span>{after} }
                        None => { {title} }
                    }
                </h1>
                <p class={HeroDescription}>{description}</p>
            </div>
            <div class={HighlightOne} aria-label={p.home_highlight()}>
                <span class={HighlightLabel}>{first_label}</span>
                <span class={HighlightValue}>{first_value}</span>
            </div>
            <div class={Highlights} aria-label={p.home_highlights()}>
                for (label, value) in highlights {
                    <div class={Highlight}>
                        <div class={HighlightLabel}>{label}</div>
                        <div class={HighlightValue}>{value}</div>
                    </div>
                }
            </div>
        </div>
    }
}

/// `WaitlistSignupPanel`: the hero's compact form (role as three segments, email) or the full one
/// (role, first priority and consent), with the hidden source fields both send.
#[component(css = HomePage)]
fn SignupPanel<'a>(t: HomeMsg, screen: &'a Screen, panel: Panel) -> impl Render {
    let hero = panel == Panel::Hero;
    let id = if hero { HERO_FORM } else { FINAL_FORM };
    let source = &screen.landing.source;
    let sent = screen.sent.as_ref();
    let mine = sent.filter(|s| s.panel == panel);
    let email = mine.map_or("", |s| s.email.as_str());
    let consent = mine.is_some_and(|s| s.consent);
    let game = screen.landing.game.map(Game::slug);
    let prefill = screen.landing.game.map(|g| g.label(t));
    let count = screen.count.map(plain);
    let email_id = format!("{id}-email");
    let role_id = format!("{id}-role");
    let interest_id = format!("{id}-interest");
    let interest_note_id = format!("{id}-interest-note");
    let consent_id = format!("{id}-consent");
    let consent_note_id = format!("{id}-consent-note");
    let text = |v: &Option<String>| v.clone().unwrap_or_default();
    html! {
        <div class={(Panel, hero.then_some(PanelHero))} id={id} data-panel={panel.as_str()}>
            if hero {
                if let Some(game) = prefill {
                    <p class={Prefill}>
                        <span class={Badge} data-tone="info">{game}</span>
                        <span class={Note}>{t.waitlist_game_prefill()}</span>
                    </p>
                }
            } else {
                <div class={PanelHead}>
                    <span class={Badge} data-tone="success">{t.waitlist_badge()}</span>
                    <h2 class={PanelTitle}>{t.waitlist_form_title()}</h2>
                    <p class={Muted}>{t.waitlist_form_description()}</p>
                    <p class={Note}>{t.waitlist_promise()}</p>
                </div>
            }
            if let Some(sent) = sent {
                <div class={Banner} role="alert">
                    <p class={BannerTitle}>{t.waitlist_error_title()}</p>
                    <p class={BannerText}>{&sent.message}</p>
                </div>
            }
            <form
                class={Form}
                method="post"
                action={&source.page_path}
                data-section={panel.section()}
                on:formdata={handlers::fill(event, target)}
            >
                <input type="hidden" name="panel" value={panel.as_str()}>
                if hero {
                    <fieldset class={Segments}>
                        <legend class={VisuallyHidden}>{t.waitlist_hero_intent_label()}</legend>
                        for role in Role::HERO {
                            <label class={Segment}>
                                <input type="radio" name="role" value={role.as_str()} checked={screen.role == role}>
                                <SegmentIcon role={role} />
                                <span>
                                    match role {
                                        Role::Sell => { {t.waitlist_hero_intent_sell()} }
                                        Role::Buy => { {t.waitlist_hero_intent_buy()} }
                                        Role::Both => { {t.waitlist_hero_intent_both()} }
                                    }
                                </span>
                            </label>
                        }
                    </fieldset>
                }
                <div class={Field}>
                    <label class={Label} for={&email_id}>
                        {t.waitlist_email()}<span class={Required} aria-hidden="true">" *"</span>
                    </label>
                    <input
                        class={Input}
                        id={&email_id}
                        type="email"
                        name="email"
                        required
                        autocomplete="email"
                        placeholder={t.waitlist_email_placeholder()}
                        value={email}
                    >
                </div>
                if let Some(game) = game {
                    <input type="hidden" name="games" value={game}>
                }
                if !hero {
                    <div class={Pair}>
                        <div class={Field}>
                            <label class={Label} for={&role_id}>
                                {t.waitlist_role()}<span class={Required} aria-hidden="true">" *"</span>
                            </label>
                            <select class={Input} id={&role_id} name="role" required>
                                for role in Role::ALL {
                                    <option value={role.as_str()} selected={screen.role == role}>
                                        match role {
                                            Role::Both => { {t.waitlist_role_both()} }
                                            Role::Buy => { {t.waitlist_role_buy()} }
                                            Role::Sell => { {t.waitlist_role_sell()} }
                                        }
                                    </option>
                                }
                            </select>
                        </div>
                        <div class={Field}>
                            <label class={Label} for={&interest_id}>
                                {t.waitlist_interests()}<span class={Required} aria-hidden="true">" *"</span>
                            </label>
                            <select
                                class={Input}
                                id={&interest_id}
                                name="interests"
                                required
                                aria-describedby={&interest_note_id}
                            >
                                for interest in Interest::ALL {
                                    <option value={interest.as_str()} selected={screen.interest == interest}>
                                        match interest {
                                            Interest::LowFees => { {t.waitlist_interest_low_seller_fees()} }
                                            Interest::BulkListing => { {t.waitlist_interest_bulk_listing()} }
                                            Interest::SetCompletion => { {t.waitlist_interest_set_completion()} }
                                            Interest::PricingTools => { {t.waitlist_interest_pricing_tools()} }
                                            Interest::Shipping => { {t.waitlist_interest_efficient_shipping()} }
                                        }
                                    </option>
                                }
                            </select>
                            <p class={Hint} id={&interest_note_id}>{t.waitlist_interests_description()}</p>
                        </div>
                    </div>
                    <div class={Check}>
                        <input
                            id={&consent_id}
                            type="checkbox"
                            name="marketing_consent"
                            value="yes"
                            checked={consent}
                            aria-describedby={&consent_note_id}
                        >
                        <label class={Label} for={&consent_id}>{t.waitlist_marketing_consent()}</label>
                    </div>
                    <p class={Hint} id={&consent_note_id}>{t.waitlist_marketing_consent_description()}</p>
                }
                <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" hidden>
                <input type="hidden" name="page_path" value={&source.page_path}>
                <input type="hidden" name="referrer" value="">
                <input type="hidden" name="utm_source" value={text(&source.utm_source)}>
                <input type="hidden" name="utm_medium" value={text(&source.utm_medium)}>
                <input type="hidden" name="utm_campaign" value={text(&source.utm_campaign)}>
                <input type="hidden" name="utm_content" value={text(&source.utm_content)}>
                <input type="hidden" name="utm_term" value={text(&source.utm_term)}>
                <input type="hidden" name="referred_by_signup_id" value={text(&source.referred_by)}>
                <button class={(Button, Primary, Block, (!hero).then_some(ButtonLarge))} type="submit">
                    <Icon name={IconName::Rocket} />
                    {t.waitlist_submit()}
                </button>
                if hero {
                    <p class={Note}>{t.waitlist_compact_description()}</p>
                    <p class={Note}>{t.waitlist_implied_consent()}</p>
                    if let Some(count) = &count {
                        <p class={Counter}>
                            <Icon name={IconName::Users} />
                            {t.waitlist_counter_label(count)}
                        </p>
                    }
                } else {
                    <p class={Note}>{t.waitlist_no_commitment()}</p>
                }
            </form>
        </div>
    }
}

/// The hero segments' icons (`heroIntentItems`).
#[component(css = HomePage)]
fn SegmentIcon(role: Role) -> impl Render {
    let name = match role {
        Role::Sell => IconName::Store,
        Role::Buy => IconName::Cart,
        Role::Both => IconName::Users,
    };
    html! { <Icon name={name} /> }
}

/// `GameRosterSection`: each game links to the hero's form with the game chosen.
#[component(css = HomePage)]
fn Roster<'a>(t: HomeMsg, screen: &'a Screen) -> impl Render {
    html! {
        <section class={Section} data-section="game_roster" aria-labelledby="game-roster">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="game-roster">{t.home_game_roster_title()}</h2>
                <p class={Muted}>{t.home_game_roster_description()}</p>
            </div>
            <div class={RosterGrid}>
                for game in Game::ROSTER {
                    <a
                        class={(Button, ButtonLarge, if screen.landing.game == Some(game) { Primary } else { Secondary })}
                        href={screen.landing.roster_href(game)}
                        data-cta="game_roster"
                        data-target={game.slug()}
                    >
                        {game.roster_label(t)}
                    </a>
                }
            </div>
        </section>
    }
}

/// `OpenOffersSection`: the sample offer and the three steps.
#[component(css = HomePage)]
fn OpenOffers(t: HomeMsg) -> impl Render {
    let steps = [t.home_open_offers_step_post(), t.home_open_offers_step_accept(), t.home_open_offers_step_checkout()];
    html! {
        <section class={Section} id="open-offers" data-section="open_offers" aria-labelledby="open-offers-title">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="open-offers-title">{t.home_open_offers_title()}</h2>
            </div>
            <div class={TwoColumns}>
                <div class={Card}>
                    <div class={OfferHead}>
                        <div>
                            <h3 class={CardTitle}>{t.home_open_offers_after_offer_card_title()}</h3>
                            <p class={Note}>{t.home_open_offers_after_offer_card_status()}</p>
                        </div>
                        <p class={Amount}>{t.home_open_offers_after_offer_card_amount()}</p>
                    </div>
                    <p class={Note}>{t.home_open_offers_after_offer_card_details()}</p>
                </div>
                <ol class={Steps}>
                    for (index, step) in steps.iter().enumerate() {
                        <li class={Step}>
                            <span class={StepNumber} aria-hidden="true">{index + 1}</span>
                            <span class={Muted}>{*step}</span>
                        </li>
                    }
                </ol>
            </div>
        </section>
    }
}

/// `FeeComparisonSection`: what a seller keeps on a $10 card here, on TCGplayer and on eBay, how
/// it was worked out, and the full comparison.
#[component(css = HomePage)]
fn Fees<'a>(t: HomeMsg, screen: &'a Screen) -> impl Render {
    html! {
        <section class={Section} data-section="fee_comparison" aria-labelledby="fee-comparison">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="fee-comparison">{t.home_seller_economics_comparison_title()}</h2>
            </div>
            <div class={TableBox}>
                <table class={Table}>
                    <thead>
                        <tr>
                            <th scope="col">{t.home_seller_economics_comparison_column_metric()}</th>
                            <th scope="col">{t.home_seller_economics_comparison_column_chase_sets()}</th>
                            <th scope="col">{t.home_seller_economics_comparison_column_tcgplayer()}</th>
                            <th scope="col">{t.home_seller_economics_comparison_column_ebay()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <th scope="row">{t.home_seller_economics_comparison_row_you_keep_label()}</th>
                            <td>
                                <span class={(Badge, Solid)} data-tone="success">
                                    {t.home_seller_economics_comparison_row_you_keep_chase_sets()}
                                </span>
                            </td>
                            <td>{t.home_seller_economics_comparison_row_you_keep_tcgplayer()}</td>
                            <td>{t.home_seller_economics_comparison_row_you_keep_ebay()}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <details
                class={Disclosure}
                data-section="fee_comparison"
                data-target="fee_comparison_source_note"
                on:toggle={handlers::disclosed(target)}
            >
                <summary class={Summary}>
                    {t.home_disclosure_how_calculated()}
                    <Icon name={IconName::ChevronDown} />
                </summary>
                <p class={DisclosureBody}>{t.home_seller_economics_comparison_source_note()}</p>
            </details>
            <div>
                <a
                    class={(Button, Secondary)}
                    href={crate::compare::Competitor::Tcgplayer.path()}
                    data-cta="fee_comparison"
                    data-target="compare_tcgplayer"
                >
                    {t.home_seller_economics_comparison_compare_link()}
                </a>
            </div>
        </section>
    }
}

/// `FoundersOfferSection`.
#[component(css = HomePage)]
fn Founders<'a>(t: HomeMsg, screen: &'a Screen) -> impl Render {
    html! {
        <section class={Section} data-section="founders_offer" aria-labelledby="founders-offer">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="founders-offer">{t.home_founders_offer_title()}</h2>
                <p class={Muted}>{t.home_founders_offer_description()}</p>
            </div>
            <div>
                <a
                    class={(Button, Secondary)}
                    href={crate::app::url::Founders.href()}
                    data-cta="founders_offer"
                    data-target="founders_terms"
                >
                    {t.home_founders_offer_action()}
                </a>
            </div>
        </section>
    }
}

/// `FinalCtaSection`: the pitch, the founder's byline, Discord and the founders' terms, beside the
/// full form.
#[component(css = HomePage)]
fn FinalCta<'a>(t: HomeMsg, screen: &'a Screen) -> impl Render {
    let byline = t.home_final_cta_byline(t.home_founder_story_name(), t.home_founder_story_role()).to_string();
    html! {
        <section class={Section} data-section="final_cta">
            <div class={TwoColumns}>
                <div class={Pitch}>
                    <h2 class={SectionTitle}>{t.home_final_cta_title()}</h2>
                    <p class={Muted}>{t.home_final_cta_description()}</p>
                    <p class={Note}>{&byline}</p>
                    <div class={Actions}>
                        if let Some(discord) = &screen.discord {
                            <a
                                class={(Button, ButtonLarge, Secondary)}
                                href={discord}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-cta="final_cta"
                                data-target="discord"
                            >
                                <Icon name={IconName::Message} />
                                {t.home_discord_cta()}
                            </a>
                        }
                        <a
                            class={(Button, ButtonLarge, Secondary)}
                            href={crate::app::url::Founders.href()}
                            data-cta="final_cta"
                            data-target="founders_terms"
                        >
                            {t.home_founders_offer_action()}
                        </a>
                    </div>
                </div>
                <SignupPanel t={t} screen={screen} panel={Panel::Final} />
            </div>
        </section>
    }
}

/// `FaqPreview`: the four questions the structured data answers, folded, and every FAQ.
#[component(css = HomePage)]
fn Faq<'a>(t: HomeMsg, screen: &'a Screen) -> impl Render {
    let entries = crate::home::faq(t, &screen.preview);
    html! {
        <section class={Section} data-section="faq" aria-labelledby="landing-faq">
            <div class={SectionHead}>
                <h2 class={SectionTitle} id="landing-faq">{t.faq_title()}</h2>
                <p class={Muted}>{t.faq_description()}</p>
            </div>
            <div class={Group}>
                for (value, question, answer) in entries.iter() {
                    <details class={GroupItem} data-faq={*value}>
                        <summary class={Summary}>
                            {*question}
                            <Icon name={IconName::ChevronDown} />
                        </summary>
                        <p class={DisclosureBody}>{answer}</p>
                    </details>
                }
            </div>
            <div>
                <a
                    class={(Button, Secondary)}
                    href={crate::app::url::help::HelpArticle { category: "getting-started", slug: "frequently-asked-questions" }}
                    data-cta="faq"
                    data-target="faq"
                >
                    {t.faq_all()}
                </a>
            </div>
        </section>
    }
}

/// `StickyWaitlistCtas`: a bar at the bottom of a phone, and one at the top of a wider screen,
/// while the hero's form is out of view (the top one hides over the full form). Hidden until the
/// script shows them.
#[component(css = HomePage)]
fn Sticky(t: HomeMsg) -> impl Render {
    let to = format!("#{FINAL_FORM}");
    html! {
        <div class={StickyBottom} data-sticky="mobile" hidden>
            <span class={StickyLabel}>{t.home_sticky_cta_label()}</span>
            <a class={(Button, Primary, Block)} href={&to} data-cta="mobile_sticky" data-target="waitlist_form_final">
                <Icon name={IconName::Rocket} />
                {t.home_sticky_cta_action()}
            </a>
        </div>
        <div class={StickyTop} data-sticky="desktop" hidden>
            <div class={StickyInner}>
                <Brand t={t} id="chase-logo-sticky" />
                <a class={(Button, Primary)} href={&to} data-cta="desktop_sticky" data-target="waitlist_form_final">
                    <Icon name={IconName::Rocket} />
                    {t.home_sticky_cta_action()}
                </a>
            </div>
        </div>
    }
}

/// `BrandLink`: the logo and the name, home.
#[component(css = HomePage)]
pub fn Brand<'a>(t: HomeMsg, id: &'a str) -> impl Render {
    let fill = format!("url(#{id})");
    html! {
        <a class={Brand} href="/" aria-label={t.brand()}>
            <svg width="20" height="20" viewBox="0 0 1254 1254" aria-hidden="true" focusable="false">
                <defs>
                    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
                        <stop offset="0" class={StopStart}></stop>
                        <stop offset="0.52" class={StopMid}></stop>
                        <stop offset="1" class={StopEnd}></stop>
                    </linearGradient>
                </defs>
                <g fill={&fill}>
                    <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z"></path>
                    <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z"></path>
                </g>
            </svg>
            <span>{t.brand()}</span>
        </a>
    }
}

/// The shell's nav: the brand and Request early access.
#[component(css = HomePage)]
pub fn HomeNav(t: HomeMsg) -> impl Render {
    let to = format!("/#{HERO_FORM}");
    html! {
        <nav class={Nav}>
            <Brand t={t} id="chase-logo-nav" />
            <a
                class={(Button, Primary, Small)}
                href={&to}
                data-cta="nav"
                data-target="waitlist_form"
                on:click={handlers::cta(target)}
            >
                <Icon name={IconName::Rocket} />
                {t.nav_waitlist()}
            </a>
        </nav>
    }
}

/// A public page's link: here when this app serves the page, else on public-web; a link
/// elsewhere as it is.
pub fn public_href(web: &str, href: &str) -> String {
    if !href.starts_with('/') || href.starts_with("//") {
        return href.to_owned();
    }
    let path = href.split(['?', '#']).next().unwrap_or(href);
    let ours = path == "/" || crate::policy::serves(path) || crate::help::serves(path) || crate::compare::serves(path);
    if ours { href.to_owned() } else { format!("{web}{href}") }
}

/// The shell's footer: the policies, the help center and Contact. The policy documents, the help
/// center, the fees, the press sheet, Contact and the compare pages are this app's pages.
#[component(css = HomePage)]
pub fn HomeFooter<'a>(t: HomeMsg, web: &'a str) -> impl Render {
    let href = |path: &str| public_href(web, path);
    let links = [
        ("/help", t.nav_help()),
        ("/terms", t.nav_terms()),
        ("/privacy", t.nav_privacy()),
        ("/refunds-and-returns", t.nav_refunds()),
        ("/order-protection", t.nav_buyer_protection()),
        ("/sales-fees", t.nav_seller_fees()),
        ("/founders", t.nav_founders_terms()),
        ("/seller-agreement", t.info_seller_agreement()),
        ("/payments-terms", t.info_payments_terms()),
        ("/authenticity-terms", t.info_authenticity_terms()),
        ("/agent-terms", t.info_agent_terms()),
        ("/press", t.nav_press()),
        ("/contact", t.nav_contact()),
    ];
    html! {
        <footer class={Footer}>
            <p class={FooterTitle}>{t.footer_title()}</p>
            <ul class={FooterLinks}>
                for (path, label) in links {
                    <li><a href={href(path)}>{label}</a></li>
                }
            </ul>
            <p class={Note}>{t.footer_description()}</p>
        </footer>
    }
}

/// `PromoBar`: the titled messages, one at a time. Without script the first shows; with it they
/// turn every seven seconds (not when the visitor prefers less motion) and the controls work.
#[component(css = HomePage)]
pub fn PromoBar<'a>(p: Pilot, promos: &'a [Promo], web: &'a str) -> impl Render {
    let several = promos.len() > 1;
    let count = format!("1/{}", promos.len());
    html! {
        <section
            class={Promo}
            aria-label={p.promo_label()}
            data-tone={promos.first().map_or("info", |m| tone(m.tone))}
            on:connect={handlers::promos(target, signal)}
            on:click={handlers::promo(event, target)}
        >
            <div class={PromoMessages}>
                for (index, message) in promos.iter().enumerate() {
                    <div class={PromoMessage} data-promo={index} data-tone={tone(message.tone)} hidden={index > 0}>
                        <span class={PromoIcon}>
                            match message.tone {
                                Tone::Success => { <Icon name={IconName::Check} /> }
                                Tone::Warning => { <Icon name={IconName::Warning} /> }
                                Tone::Info => { <Icon name={IconName::Info} /> }
                            }
                        </span>
                        <div class={PromoText}>
                            <p class={PromoTitle}>{&message.title}</p>
                            if let Some(description) = &message.description {
                                <p class={PromoDescription}>{description}</p>
                            }
                        </div>
                        if let (Some(href), Some(label)) = (&message.href, &message.link_label) {
                            <a
                                class={(Button, Secondary, Small)}
                                href={public_href(web, href)}
                            >
                                {label}
                                <Icon name={IconName::ChevronRight} />
                            </a>
                        }
                    </div>
                }
            </div>
            if several {
                <div class={PromoControls} hidden>
                    <button class={IconButton} type="button" data-promo-step="-1" aria-label={p.promo_previous()}>
                        <Icon name={IconName::ChevronLeft} />
                    </button>
                    <span class={PromoCount} aria-live="polite">{&count}</span>
                    <button class={IconButton} type="button" data-promo-step="1" aria-label={p.promo_next()}>
                        <Icon name={IconName::ChevronRight} />
                    </button>
                    <button
                        class={IconButton}
                        type="button"
                        data-promo-pause=""
                        aria-label={p.promo_pause()}
                        data-pause={p.promo_pause()}
                        data-resume={p.promo_resume()}
                    >
                        <Icon name={IconName::Pause} />
                    </button>
                </div>
            }
        </section>
    }
}

fn tone(tone: Tone) -> &'static str {
    match tone {
        Tone::Info => "info",
        Tone::Success => "success",
        Tone::Warning => "warning",
    }
}

/// The design system's icons the page draws (lucide's, as `Icon` draws them).
#[derive(Clone, Copy)]
pub enum IconName {
    Rocket,
    Store,
    Cart,
    Users,
    Message,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Pause,
    Check,
    Info,
    Warning,
}

#[component(css = HomePage)]
pub(crate) fn Icon(name: IconName) -> impl Render {
    html! {
        <svg
            class={Icon}
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            match name {
                IconName::Rocket => {
                    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path>
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"></path>
                    <path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"></path>
                    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"></path>
                }
                IconName::Store => {
                    <path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"></path>
                    <path
                        d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"
                    ></path>
                    <path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"></path>
                }
                IconName::Cart => {
                    <circle cx="8" cy="21" r="1"></circle>
                    <circle cx="19" cy="21" r="1"></circle>
                    <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"></path>
                }
                IconName::Users => {
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                    <path d="M16 3.128a4 4 0 0 1 0 7.744"></path>
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                }
                IconName::Message => {
                    <path
                        d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
                    ></path>
                }
                IconName::ChevronDown => { <path d="m6 9 6 6 6-6"></path> }
                IconName::ChevronLeft => { <path d="m15 18-6-6 6-6"></path> }
                IconName::ChevronRight => { <path d="m9 18 6-6-6-6"></path> }
                IconName::Pause => {
                    <rect x="14" y="3" width="5" height="18" rx="1"></rect>
                    <rect x="5" y="3" width="5" height="18" rx="1"></rect>
                }
                IconName::Check => {
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="m9 12 2 2 4-4"></path>
                }
                IconName::Info => {
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 16v-4"></path>
                    <path d="M12 8h.01"></path>
                }
                IconName::Warning => {
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path>
                    <path d="M12 9v4"></path>
                    <path d="M12 17h.01"></path>
                }
            }
        </svg>
    }
}

#[cfg(test)]
mod tests {
    use super::{foil, plain};

    #[test]
    fn the_foil_word_is_one_whole_word() {
        assert_eq!(foil("The marketplace that works", "marketplace"), Some(("The ", "marketplace", " that works")));
        assert_eq!(foil("marketplaces", "marketplace"), None);
        assert_eq!(foil("cards and cards", "cards"), None, "twice is no foil");
        assert_eq!(plain(1200.0), "1200");
    }
}
