//! The welcome page (`/welcome`, `WaitlistSuccessPage`), where Join lands: You are on the list,
//! for a seller the wave-placement questions, what happens next, the referral link with the
//! place in line and the progress to the goal, and the share links.
//!
//! public-web reads the referral summary from the browser after the page renders; here it is read
//! with the page (two seconds at most, then the page says the place is updating), so nothing
//! moves in. The page is about one signup, so it is private and kept out of search.
//!
//! The wave-placement questions save to Public Presence one field at a time, as public-web's do:
//! with a script, a changed field submits the form with the button that names it, and the answer
//! is the form's status in place (`data-patch`); without one, Save sends every field that has a
//! value and comes back here, so a field left empty is not cleared.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode},
    prelude::*,
};
use serde::Deserialize;

use crate::{
    app::{Shared, url},
    home::{Game, Role, Variant},
    presence::{Cohort, Presence, Referrals},
    text::{HomeMsg, Pilot},
    views::{self, HomeLayout},
};

/// How long the page waits for the referral summary.
const READ_WAIT: Duration = Duration::from_secs(2);

/// The address Join sends a signup to (public-web's `/welcome` query).
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Arrival {
    pub signup: Option<String>,
    pub fresh: Option<String>,
    pub role: Option<String>,
    pub variant: Option<String>,
    #[serde(default)]
    pub game: Vec<String>,
    pub attributed: Option<String>,
    /// After Save without a script: whether it saved.
    pub saved: Option<String>,
}

impl Arrival {
    /// The signup's id, as public-web accepts it: `wls_` and lowercase letters and digits.
    pub fn signup_id(&self) -> Option<String> {
        let id = self.signup.as_deref()?.trim().to_ascii_lowercase();
        let rest = id.strip_prefix("wls_")?;
        (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())).then_some(id)
    }

    /// Only a seller's signup is asked the wave-placement questions; a missing role (a bookmark)
    /// is not asked.
    pub fn role(&self) -> Option<Role> {
        self.role.as_deref().and_then(Role::read)
    }

    /// `normalizeLandingExperimentVariant`.
    pub fn variant(&self) -> Variant {
        if self.variant.as_deref() == Some(Variant::BuyerFirst.as_str()) { Variant::BuyerFirst } else { Variant::SellerFirst }
    }

    /// The games the signup recorded, the five in their order (the chips' start).
    pub fn games(&self) -> Vec<Game> {
        Game::ALL.into_iter().filter(|g| self.game.iter().any(|slug| slug == g.slug())).collect()
    }
}

/// The inventory sizes (`inventorySizeItems`).
pub const SIZES: [&str; 4] = ["under_100", "100_to_500", "500_to_2000", "2000_plus"];

/// How the last save went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Saved {
    Yes,
    Failed,
}

/// Everything the page draws.
pub struct Screen {
    pub arrival: Arrival,
    pub referrals: Referrals,
    pub link: String,
    pub share: String,
    pub discord: Option<String>,
}

impl Screen {
    pub fn asks_wave(&self) -> bool {
        matches!(self.arrival.role(), Some(Role::Sell | Role::Both))
    }

    pub fn goal_reached(&self) -> bool {
        self.referrals.count >= self.referrals.goal
    }
}

/// The welcome page: a 404 without a signup's id, as public-web's.
pub(crate) async fn page(
    req: Req,
    State(config): State<Shared>,
    client: Option<corten::ClientIp>,
    Params(route): Params<crate::app::url::files::Welcome>,
) -> HtmlResult {
    let arrival = route.arrival;
    let Some(signup) = arrival.signup_id() else {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    };
    let client = client.map(|corten::ClientIp(ip)| ip.to_string());
    let read = tokio::time::timeout(READ_WAIT, config.api().referrals(&signup, client.as_deref())).await;
    let referrals = match read {
        Ok(Ok(referrals)) => referrals,
        Ok(Err(error)) => {
            tracing::warn!("the referral summary's read failed: {error}");
            Referrals::default()
        }
        Err(_) => {
            tracing::warn!("the referral summary's read timed out");
            Referrals::default()
        }
    };
    let saved = match arrival.saved.as_deref() {
        Some("1") => Some(Saved::Yes),
        Some("0") => Some(Saved::Failed),
        _ => None,
    };
    let t: HomeMsg = req.t();
    // The share link carries its own channel (`utm_source=referral`) beside the `ref` code.
    let link =
        format!("{}/?ref={}&utm_source=referral&utm_medium=waitlist_share", config.origin, crate::home::form_encode(&signup));
    let share = t.welcome_referral_share_message(&link).to_string();
    let screen = Screen { arrival, referrals, link, share, discord: config.discord.clone() };
    render(&req, &config, &screen, saved).await
}

async fn render(req: &Req, config: &Shared, screen: &Screen, saved: Option<Saved>) -> HtmlResult {
    let t: HomeMsg = req.t();
    let p: Pilot = req.t();
    let promos = crate::home::promos(config).await.unwrap_or_default();
    let canonical = format!("{}{}", config.origin, url::files::Welcome::default().href());
    let head = html! {
        <meta name="robots" content="noindex, nofollow">
        <link rel="canonical" href={&canonical}>
    };
    let web = crate::app::public_web();
    req.page(html! {
        <HomeLayout req={req} t={t} p={p} promos={&promos} web={web} title={t.route_welcome_meta_title()} head={head}>
            <views::WelcomePage t={t} p={p} screen={screen} saved={saved} />
        </HomeLayout>
    })
}

/// The wave-placement form's fields. `field` is the button that sent it: the one field a script
/// saves, or `all` for Save.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Wave {
    pub field: String,
    pub games: Vec<String>,
    pub inventory_size: String,
    pub store_url: String,
}

impl Wave {
    /// What to send: the named field (a cleared one too), or for Save every field with a value.
    pub fn cohort(&self) -> Cohort<'_> {
        let size = Some(self.inventory_size.trim()).filter(|s| SIZES.contains(s));
        let store = Some(self.store_url.trim()).filter(|s| !s.is_empty());
        match self.field.as_str() {
            "games" => Cohort { games: Some(&self.games), ..Cohort::default() },
            "inventory_size" => Cohort { inventory_size: Some(size), ..Cohort::default() },
            "store_url" => Cohort { has_store_link: Some(store.is_some()), store_url: Some(store), ..Cohort::default() },
            _ => Cohort {
                games: (!self.games.is_empty()).then_some(&self.games[..]),
                inventory_size: size.map(Some),
                has_store_link: store.map(|_| true),
                store_url: store.map(Some),
            },
        }
    }
}

/// Save the wave-placement answers: with a script, the form's status in place; without one, the
/// page again with Saved or the failure.
pub(crate) async fn save(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    client: Option<corten::ClientIp>,
    Params(route): Params<crate::app::url::files::Welcome>,
    corten::Form(wave): corten::Form<Wave>,
) -> HtmlResult {
    let arrival = route.arrival;
    let Some(signup) = arrival.signup_id() else {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    };
    let client = client.map(|corten::ClientIp(ip)| ip.to_string());
    let caller = config.platform.caller(&headers, config.proto(), None);
    let saved = match caller.save_cohort(&signup, &wave.cohort(), client.as_deref()).await {
        Ok(()) => Saved::Yes,
        Err(error) => {
            tracing::warn!("a cohort-quality save failed: {error}");
            Saved::Failed
        }
    };
    let t: HomeMsg = req.t();
    req.patch_or(views::WaveStatus { t, saved: Some(saved) }, || async {
        let back = url::files::Welcome {
            arrival: Arrival { saved: Some(if saved == Saved::Yes { "1" } else { "0" }.into()), ..arrival.clone() },
        };
        req.redirect(&back)
    })
    .await
}
