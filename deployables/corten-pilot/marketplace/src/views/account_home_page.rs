//! The account's own page (Identity's `AccountProfilePage`): the header (the eyebrow, the account's
//! marketplace name with its badges, the description) with Update Profile and the links to the
//! shipping addresses, ship-from locations and listings; what the last write did; who is signed in
//! (`ActorIdentityCue`'s panel); Marketplace Readiness's three signals; and Trust Details with the
//! platform-protection cue. One column on a phone; the form's fields side by side and the signals
//! three across from 48rem.
use corten::{
    i18n::{DateStyle, parse_timestamp},
    prelude::*,
};

use crate::{
    account_home::{AccountScreen, Draft, Place, ProfileInput},
    addresses::Said,
    api::ActorDisplay,
    app::url,
    text::{AccountHomeMsg, Pilot},
};

/// The profile form: a refused update draws it again.
#[derive(Id, Clone, Copy)]
pub struct ProfileFormId;

/// Identity's `formatMachineValue`: the word for a known value, else "Unrecognized {family}"
/// with the value humanized when it is a plain token.
fn machine(known: Option<&'static str>, t: AccountHomeMsg, family: &str, value: &str) -> String {
    match (known, humanized(value)) {
        (Some(word), _) => word.to_owned(),
        (None, Some(human)) => t.value_unrecognized_with_value(family, &human).to_string(),
        (None, None) => t.value_unrecognized(family).to_string(),
    }
}

/// An unknown machine value as Identity shows it (`humanizeMachineToken`), when it is a plain
/// token (`safeMachineToken`): `new-thing` is "New Thing".
pub(super) fn humanized(value: &str) -> Option<String> {
    let token = !value.is_empty()
        && value.len() <= 40
        && value.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    token.then(|| {
        value
            .split('-')
            .map(|part| {
                let mut chars = part.chars();
                chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    })
}

pub fn account_type(t: AccountHomeMsg, value: &str) -> String {
    let known = match value {
        "personal" => Some(t.account_type_personal()),
        "business" => Some(t.account_type_business()),
        "enterprise" => Some(t.account_type_enterprise()),
        _ => None,
    };
    machine(known, t, t.family_account_type(), value)
}

pub fn account_status(t: AccountHomeMsg, value: &str) -> String {
    let known = match value {
        "active" => Some(t.status_active()),
        "suspended" => Some(t.status_suspended()),
        "closed" => Some(t.status_closed()),
        _ => None,
    };
    machine(known, t, t.family_account_status(), value)
}

pub fn membership_role(t: AccountHomeMsg, value: &str) -> String {
    let known = match value {
        "platform-admin" => Some(t.role_platform_admin()),
        "owner" => Some(t.role_owner()),
        "manager" => Some(t.role_manager()),
        "fulfillment" => Some(t.role_fulfillment()),
        "viewer" => Some(t.role_viewer()),
        _ => None,
    };
    machine(known, t, t.family_membership_role(), value)
}

/// The account badges marketplace shows (`AccountBadgeList`): the known ones, in the order the
/// account has them, a founding account's with its number.
fn badges(t: AccountHomeMsg, badges: &[String], founder: Option<u32>) -> Vec<String> {
    badges
        .iter()
        .filter_map(|badge| match badge.as_str() {
            "founding-account" => Some(match founder {
                Some(n) if n > 0 => format!("{} #{n:03}", t.badges_founding_account()),
                _ => t.badges_founding_account().to_owned(),
            }),
            "manual-payout-review" => Some(t.badges_manual_payout_review().to_owned()),
            "trusted-seller" => Some(t.badges_trusted_seller().to_owned()),
            _ => None,
        })
        .collect()
}

/// A name and its badges.
#[component(css = AccountHomePage)]
fn Named<'a>(name: &'a str, badges: &'a [String]) -> impl Render {
    html! {
        <span class={Named}>
            <span>{name}</span>
            for badge in badges {
                <span class={Badge} title={badge}>{badge}</span>
            }
        </span>
    }
}

/// The page.
#[component(css)]
pub fn AccountHomePage<'a>(t: AccountHomeMsg, p: Pilot, screen: &'a AccountScreen) -> impl Render {
    let account = &screen.account;
    let draft = screen.draft();
    let held = screen.held();
    let shown = badges(t, &account.badges, account.founder_number);
    let updated = if account.updated_at.is_empty() {
        t.page_not_available().to_owned()
    } else {
        parse_timestamp(&account.updated_at)
            .map_or_else(|| t.value_date_unavailable().to_owned(), |at| t.date(at, DateStyle::Medium).to_string())
    };
    let banner = match &screen.said {
        Said::Editing => None,
        Said::Saved => Some(("info", t.manage_state_succeeded())),
        Said::NotSaved => Some(("danger", t.manage_state_failed_safe())),
        Said::Conflict => Some(("warning", t.manage_state_conflict())),
        Said::Unconfirmed { .. } => Some(("warning", t.manage_state_ambiguous())),
        Said::Denied => Some(("danger", t.manage_state_route_denied())),
    };
    let again = match &screen.said {
        Said::Unconfirmed { attempt, .. } => {
            Some(url::AccountHome { place: Place { check: Some(attempt.clone()), ..Place::default() } }.href())
        }
        _ => None,
    };
    let status = account_status(t, &account.status);
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_account()}</p>
                <h1 class={Title}>
                    <Named name={&account.display_name} badges={&shown} />
                </h1>
                <p class={Muted}>{t.page_profile_and_commercial_ownership_details_for()}</p>
            </div>
            <div class={Actions}>
                <ProfileForm t={t} draft={&draft} held={held} />
                <nav class={Links}>
                    <a class={(Button, Secondary)} href={url::ShippingAddresses::default()}>
                        {t.page_manage_shipping_addresses()}
                    </a>
                    <a class={(Button, Secondary)} href={url::Locations::default()}>{t.page_manage_ship_from_locations()}</a>
                    <a class={(Button, Secondary)} href={url::SellerListings::default()}>
                        {t.page_manage_time_away_and_order_capacity()}
                    </a>
                </nav>
            </div>
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p class={Strong}>{text}</p>
                    if let Some(again) = &again {
                        <p><a href={again}>{p.addresses_check()}</a></p>
                    }
                </div>
            }
            if screen.pending {
                <div class={Banner} data-tone="warning">
                    <p>{p.account_home_pending()}</p>
                </div>
            }
        </div>
        if let Some(actor) = &screen.actor {
            <ActorPanel t={t} actor={actor} />
        }
        <section class={Part} aria-labelledby="readiness-title">
            <h2 id="readiness-title" class={PartTitle}>{t.page_marketplace_readiness()}</h2>
            <p class={Muted}>{t.page_marketplace_readiness_description()}</p>
            <dl class={Metrics}>
                <div class={Metric}>
                    <dt>{t.page_account_type()}</dt>
                    <dd class={Value}>{account_type(t, &account.account_type)}</dd>
                    <dd class={Muted}>{t.page_commercial_identity()}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.page_status()}</dt>
                    <dd class={Value}>{&status}</dd>
                    <dd class={Muted}>{t.page_active_accounts_can_buy_sell_and_receive()}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.page_updated()}</dt>
                    <dd class={Value}>{&updated}</dd>
                    <dd class={Muted}>{t.page_profile_changes_are_visible()}</dd>
                </div>
            </dl>
        </section>
        <section class={Part} aria-labelledby="trust-title">
            <h2 id="trust-title" class={PartTitle}>{t.page_trust_details()}</h2>
            <p class={Muted}>{t.page_trust_details_description()}</p>
            <div class={Tinted}>
                <dl class={Specs}>
                    <div>
                        <dt>{t.page_legal_name()}</dt>
                        <dd>{&account.name}</dd>
                    </div>
                    <div>
                        <dt>{t.page_marketplace_name()}</dt>
                        <dd>{&account.display_name}</dd>
                    </div>
                    <div>
                        <dt>{t.page_status()}</dt>
                        <dd>{&status}</dd>
                    </div>
                </dl>
                <div class={Cue}>
                    <p class={Strong}>{t.page_platform_protection_active()}</p>
                    <p class={Muted}>{t.page_platform_protection_active_description()}</p>
                </div>
            </div>
        </section>
    }
}

/// Update Profile: the legal and marketplace names, off while its last write is unconfirmed.
#[component(css = AccountHomePage)]
fn ProfileForm<'a>(t: AccountHomeMsg, draft: &'a Draft, held: bool) -> impl Render {
    let f = ProfileInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(ProfileFormId));
    // A name must have a letter in it: the API takes a blank one (chase-sets/chase-sets#10688).
    let named = ".*\\S.*";
    html! {
        <form id={ProfileFormId} class={Form} method="post" action={url::AccountHome::default()}>
            {SubmitKey::field(f.attempt)}
            {draft.errors.form_message()}
            <fieldset class={Row} disabled={held}>
                <label class={Field}>
                    <span class={Label}>{t.page_legal_name()}</span>
                    <input
                        type="text"
                        name={f.name}
                        value={&i.name}
                        required
                        pattern={named}
                        {..e.aria(f.name)}
                    >
                </label>
                <label class={Field}>
                    <span class={Label}>{t.page_marketplace_name()}</span>
                    <input
                        type="text"
                        name={f.display_name}
                        value={&i.display_name}
                        required
                        pattern={named}
                        {..e.aria(f.display_name)}
                    >
                </label>
                <button type="submit" class={Secondary}>{t.page_update_profile()}</button>
            </fieldset>
        </form>
    }
}

/// Who is signed in (`ActorIdentityCue` as a panel): the account with its badges, the user and
/// the membership's role.
#[component(css = AccountHomePage)]
fn ActorPanel<'a>(t: AccountHomeMsg, actor: &'a ActorDisplay) -> impl Render {
    let account = actor.account.display_name.as_deref().or(actor.account.name.as_deref()).unwrap_or(&actor.account.account_id);
    let user = actor.user.display_name.as_deref().or(actor.user.primary_email.as_deref()).unwrap_or(&actor.user.user_id);
    let detail = actor.user.primary_email.as_deref().unwrap_or(t.actor_current_user());
    let shown = badges(t, &actor.account.badges, None);
    html! {
        <section class={(Part, Tinted)} aria-labelledby="identity-title">
            <h2 id="identity-title" class={PartTitle}>{t.actor_signed_in_identity()}</h2>
            <p class={Muted}>{t.actor_signed_in_identity_description()}</p>
            <dl class={Metrics}>
                <div class={Metric}>
                    <dt>{t.actor_account()}</dt>
                    <dd class={Value}><Named name={account} badges={&shown} /></dd>
                    <dd class={Muted}>{t.actor_selected_account()}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.actor_user()}</dt>
                    <dd class={Value}>{user}</dd>
                    <dd class={Muted}>{detail}</dd>
                </div>
                <div class={Metric}>
                    <dt>{t.actor_membership()}</dt>
                    <dd class={Value}>{membership_role(t, &actor.membership.role_key)}</dd>
                    <dd class={Muted}>{t.actor_active_membership()}</dd>
                </div>
            </dl>
        </section>
    }
}
