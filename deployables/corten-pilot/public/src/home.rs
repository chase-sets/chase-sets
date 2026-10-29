//! public-web's home page, the waitlist's landing (`/`, Public Presence's `routes/marketplace/home.tsx`
//! and `features/waitlist/ui/public-pages.tsx`): the hero with the early-access form, the five
//! games, open offers, the fee comparison, the founders offer, the full form and the FAQ, in the
//! public-presence shell (promo bar, nav, footer, sticky calls to action).
//!
//! The page is the same for everyone who asks with the same address, so it is `Public`: a browser
//! keeps it a minute and a cache in front four, and either may serve it a minute stale while it
//! reads it again, which stays inside the six minutes the /sales-fees article promises for a fee
//! change to reach every page (public-web sends no `Cache-Control` and reads the policy at most
//! every five minutes). What public-web reads per visitor, the page gets another way: the referrer
//! is the browser's (`document.referrer`, written into the forms by the page's script, so a visitor
//! without script sends none), and the promo bar and counter, which public-web's shell fetches from
//! the browser after it renders, are read here and drawn with the page, so nothing moves in.
//!
//! Join sends the form's fields to the API as public-web's action does, with the visitor's address
//! (see [`platform::client`]), and sends a signup to the welcome page; a refusal draws the
//! page again with the API's message over both forms.
use std::time::Duration;

use corten::{
    axum::http::{HeaderMap, StatusCode, Uri},
    i18n::{Currency, Decimal, Minor},
    prelude::*,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    app::{Shared, public_web},
    presence::{PolicyValues, Presence, Promo, Signup, SignupSource},
    text::{HomeMsg, Pilot},
    views::{self, HomeLayout},
};

/// How long the browser keeps the page.
const FRESH: Duration = Duration::from_secs(60);
/// How long a shared cache keeps it while the fee terms are live.
const SHARED: Duration = Duration::from_secs(240);
/// How long after that either may serve it while it reads it again.
const STALE: Duration = Duration::from_secs(60);
/// How long the page waits for a read before it draws without it (`LANDING_FEE_READ_TIMEOUT_MS`).
const READ_WAIT: Duration = Duration::from_secs(2);
/// How long a read is kept for the next visitor, each a minute. public-web keeps the policy values
/// five; the pilot keeps them one so that, with a shared cache's four minutes and one stale, a fee
/// change shows within the six minutes the fees article promises (`propagationSeconds`).
pub const POLICY_LIFE: Duration = Duration::from_secs(60);
pub const SHELL_LIFE: Duration = Duration::from_secs(60);

const USD: Currency = Currency::new("USD");

/// The reads the page keeps for the next visitor ([`crate::kept::Kept`]).
pub struct Kept {
    pub terms: crate::kept::Kept<Terms>,
    /// The compare pages' sales fee schedule.
    pub schedule: crate::kept::Kept<crate::compare::Schedule>,
    pub promos: crate::kept::Kept<Vec<Promo>>,
    pub count: crate::kept::Kept<Option<f64>>,
}

impl Default for Kept {
    fn default() -> Self {
        Kept {
            terms: crate::kept::Kept::new(POLICY_LIFE),
            schedule: crate::kept::Kept::new(crate::compare::SCHEDULE_LIFE),
            promos: crate::kept::Kept::new(SHELL_LIFE),
            count: crate::kept::Kept::new(SHELL_LIFE),
        }
    }
}

/// The five games (`gameItems`, the canonical `WAITLIST_GAMES` order), each with its social card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Game {
    Pokemon,
    Magic,
    YuGiOh,
    Lorcana,
    OnePiece,
}

impl Game {
    pub const ALL: [Game; 5] = [Game::Pokemon, Game::Magic, Game::YuGiOh, Game::Lorcana, Game::OnePiece];
    /// The roster's order (`gameRosterItems`): One Piece before Lorcana.
    pub const ROSTER: [Game; 5] = [Game::Pokemon, Game::Magic, Game::YuGiOh, Game::OnePiece, Game::Lorcana];

    pub fn slug(self) -> &'static str {
        match self {
            Game::Pokemon => "pokemon",
            Game::Magic => "magic-the-gathering",
            Game::YuGiOh => "yu-gi-oh",
            Game::Lorcana => "disney-lorcana",
            Game::OnePiece => "one-piece-card-game",
        }
    }

    /// `normalizeSelectedGame`: one of the five, or none.
    pub fn read(slug: &str) -> Option<Game> {
        Game::ALL.into_iter().find(|g| g.slug() == slug)
    }

    /// The form's label (`gameItems`).
    pub fn label(self, t: HomeMsg) -> &'static str {
        match self {
            Game::Pokemon => t.waitlist_game_pokemon(),
            Game::Magic => t.waitlist_game_magic_the_gathering(),
            Game::YuGiOh => t.waitlist_game_yu_gi_oh(),
            Game::Lorcana => t.waitlist_game_disney_lorcana(),
            Game::OnePiece => t.waitlist_game_one_piece_card_game(),
        }
    }

    /// The roster's campaign label (`gameRosterItems`).
    pub fn roster_label(self, t: HomeMsg) -> &'static str {
        match self {
            Game::Pokemon => t.home_game_roster_game_pokemon(),
            Game::Magic => t.home_game_roster_game_magic_the_gathering(),
            Game::YuGiOh => t.home_game_roster_game_yu_gi_oh(),
            Game::Lorcana => t.home_game_roster_game_disney_lorcana(),
            Game::OnePiece => t.home_game_roster_game_one_piece_card_game(),
        }
    }

    /// The social card (`resolveGameOpenGraphImage`), in `static/home/`.
    pub fn card(self) -> corten::assets::Asset {
        use crate::app::Static;
        match self {
            Game::Pokemon => Static::HOME_CHASE_SETS_OG_POKEMON_PNG,
            Game::Magic => Static::HOME_CHASE_SETS_OG_MAGIC_THE_GATHERING_PNG,
            Game::YuGiOh => Static::HOME_CHASE_SETS_OG_YU_GI_OH_PNG,
            Game::Lorcana => Static::HOME_CHASE_SETS_OG_DISNEY_LORCANA_PNG,
            Game::OnePiece => Static::HOME_CHASE_SETS_OG_ONE_PIECE_CARD_GAME_PNG,
        }
    }
}

/// What the visitor wants to do (`WaitlistIntent`'s role).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    Both,
    Buy,
    Sell,
}

impl Role {
    pub const ALL: [Role; 3] = [Role::Both, Role::Buy, Role::Sell];
    /// The hero's segments' order (`heroIntentItems`).
    pub const HERO: [Role; 3] = [Role::Sell, Role::Buy, Role::Both];

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Both => "both",
            Role::Buy => "buy",
            Role::Sell => "sell",
        }
    }

    pub fn read(text: &str) -> Option<Role> {
        Role::ALL.into_iter().find(|r| r.as_str() == text)
    }

    /// The first priority the hero sends for it (`resolveHeroIntent`).
    pub fn interest(self) -> Interest {
        match self {
            Role::Buy => Interest::SetCompletion,
            Role::Both | Role::Sell => Interest::LowFees,
        }
    }

    /// The landing experiment's variant for it (`landingExperimentVariantForIntent`).
    pub fn variant(self) -> Variant {
        if self == Role::Buy { Variant::BuyerFirst } else { Variant::SellerFirst }
    }
}

/// The first priority (`WaitlistInterest`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interest {
    LowFees,
    BulkListing,
    SetCompletion,
    PricingTools,
    Shipping,
}

impl Interest {
    pub const ALL: [Interest; 5] =
        [Interest::LowFees, Interest::BulkListing, Interest::SetCompletion, Interest::PricingTools, Interest::Shipping];

    pub fn as_str(self) -> &'static str {
        match self {
            Interest::LowFees => "low-sales-fees",
            Interest::BulkListing => "bulk-listing",
            Interest::SetCompletion => "set-completion",
            Interest::PricingTools => "pricing-tools",
            Interest::Shipping => "efficient-shipping",
        }
    }

    pub fn read(text: &str) -> Option<Interest> {
        Interest::ALL.into_iter().find(|i| i.as_str() == text)
    }
}

/// The landing experiment's variant (`landingExperimentVariants`): the buyer-first hero for a
/// visitor who came to buy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    SellerFirst,
    BuyerFirst,
}

impl Variant {
    pub fn as_str(self) -> &'static str {
        match self {
            Variant::SellerFirst => "seller_first_v1",
            Variant::BuyerFirst => "seller_first_v2",
        }
    }
}

/// The address's query, in order, as `URLSearchParams` reads it.
#[derive(Clone, Debug, Default)]
pub struct Params(Vec<(String, String)>);

impl Params {
    pub fn read(query: Option<&str>) -> Params {
        let decode = |text: &str| percent_encoding::percent_decode_str(&text.replace('+', " ")).decode_utf8_lossy().into_owned();
        Params(
            query
                .unwrap_or("")
                .split('&')
                .filter(|pair| !pair.is_empty())
                .map(|pair| {
                    let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
                    (decode(name), decode(value))
                })
                .collect(),
        )
    }

    /// The first value of `name` (`searchParams.get`).
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn has(&self, name: &str) -> bool {
        self.0.iter().any(|(n, _)| n == name)
    }

    /// `set(name, value)` then `toString()`: the first `name` takes the value in its place, the
    /// rest go, and one is added at the end when there was none.
    pub fn with(&self, name: &str, value: &str) -> String {
        let mut set = false;
        let mut out = Vec::with_capacity(self.0.len() + 1);
        for (n, v) in &self.0 {
            if n != name {
                out.push((n.as_str(), v.as_str()));
            } else if !set {
                out.push((n.as_str(), value));
                set = true;
            }
        }
        if !set {
            out.push((name, value));
        }
        out.iter().map(|(n, v)| format!("{}={}", form_encode(n), form_encode(v))).collect::<Vec<_>>().join("&")
    }
}

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
pub fn form_encode(text: &str) -> String {
    const SET: &percent_encoding::AsciiSet =
        &percent_encoding::NON_ALPHANUMERIC.remove(b'*').remove(b'-').remove(b'.').remove(b'_').remove(b' ');
    percent_encoding::utf8_percent_encode(text, SET).to_string().replace(' ', "+")
}

/// Where the visitor came from (`WaitlistPageSource`), sent with a signup.
#[derive(Clone, Debug, Default)]
pub struct Source {
    pub page_path: String,
    pub utm_source: Option<String>,
    pub utm_medium: Option<String>,
    pub utm_campaign: Option<String>,
    pub utm_content: Option<String>,
    pub utm_term: Option<String>,
    /// The referral code from an inbound `?ref=`: the API is its only validator.
    pub referred_by: Option<String>,
}

/// What the address asks for: the source, the game a roster tile or campaign link chose, and
/// what the visitor came to do.
#[derive(Clone, Debug, Default)]
pub struct Landing {
    pub params: Params,
    pub source: Source,
    pub game: Option<Game>,
    pub role: Role,
}

impl Landing {
    pub fn read(uri: &Uri) -> Landing {
        let params = Params::read(uri.query());
        let text = |name: &str| params.get(name).map(str::to_owned);
        let page_path = uri.path_and_query().map_or_else(|| "/".to_owned(), |p| p.as_str().to_owned());
        let source = Source {
            page_path,
            utm_source: text("utm_source"),
            utm_medium: text("utm_medium"),
            utm_campaign: text("utm_campaign"),
            utm_content: text("utm_content"),
            utm_term: text("utm_term"),
            referred_by: text("ref"),
        };
        let game = params.get("game").and_then(Game::read);
        let role = landing_role(params.get("intent"), &source);
        Landing { params, source, game, role }
    }

    /// A roster tile's link: this address with `?game=` set, at the hero's form
    /// (`gameRosterHref`), so attribution and the referral code stay.
    pub fn roster_href(&self, game: Game) -> String {
        format!("/?{}#waitlist-form", self.params.with("game", game.slug()))
    }
}

/// `resolveLandingIntent`: `?intent=` when it is one of the three, else buy when an utm value
/// names buyers, else both.
fn landing_role(intent: Option<&str>, source: &Source) -> Role {
    if let Some(role) = intent.and_then(Role::read) {
        return role;
    }
    const BUYERS: [&str; 6] = ["buy", "buyer", "buyers", "buying", "collector", "collectors"];
    let buyer = |value: &Option<String>| {
        value.as_deref().is_some_and(|v| {
            v.to_lowercase().split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()).any(|t| BUYERS.contains(&t))
        })
    };
    let utm = [&source.utm_source, &source.utm_medium, &source.utm_campaign, &source.utm_content, &source.utm_term];
    if utm.into_iter().any(buyer) { Role::Buy } else { Role::Both }
}

/// A checkout processing term: a rate in basis points and a fixed amount in cents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Term {
    pub bps: u32,
    pub fixed: i64,
}

/// The card and bank account terms (`CheckoutProcessingTermsByMethod`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub card: Term,
    pub bank: Term,
}

/// The compiled launch terms (`compiledCheckoutProcessingTerms`), when the live read fails.
pub const COMPILED: Terms = Terms { card: Term { bps: 290, fixed: 30 }, bank: Term { bps: 50, fixed: 0 } };

/// The sample order the preview prices, in cents (`checkoutFeePreviewSampleOrderCents`): an $83.40
/// item and $0.48 shipping after the credit, no tax.
const SAMPLE_CENTS: i64 = 8340 + 48;

impl Terms {
    /// `selectCheckoutProcessingTerms`: the four whitelisted values, or why one is unusable.
    pub fn read(values: &PolicyValues) -> Result<Terms, String> {
        let bps = |key: &str| {
            let value = values.values.get(key).map(|v| &v.value);
            let number = match value {
                Some(Value::Number(n)) => n.as_f64(),
                Some(Value::String(s)) => s.trim().parse::<f64>().ok().or((s.trim().is_empty()).then_some(0.0)),
                _ => None,
            };
            number
                .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < 10_000.0)
                .map(|n| n as u32)
                .ok_or_else(|| format!("public policy value '{key}' is not a valid basis-points amount"))
        };
        let money = |key: &str| match values.values.get(key).map(|v| &v.value) {
            Some(Value::String(amount)) => {
                cents(amount).ok_or_else(|| format!("public policy value '{key}' is not a money amount"))
            }
            _ => Err(format!("public policy value '{key}' is not a valid money amount")),
        };
        Ok(Terms {
            card: Term { bps: bps("checkout-processing-fee.card.bps")?, fixed: money("checkout-processing-fee.card.fixed")? },
            bank: Term {
                bps: bps("checkout-processing-fee.bank-account.bps")?,
                fixed: money("checkout-processing-fee.bank-account.fixed")?,
            },
        })
    }
}

/// An amount the API writes as text (`"0.30"`) in cents (`moneyToCents`): at most two decimals.
fn cents(amount: &str) -> Option<i64> {
    let (whole, fraction) = amount.trim().split_once('.').unwrap_or((amount.trim(), ""));
    let negative = whole.starts_with('-');
    let digits = whole.trim_start_matches('-');
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let value = digits.parse::<i64>().ok()? * 100 + format!("{fraction:0<2}").parse::<i64>().ok()?;
    Some(if negative { -value } else { value })
}

/// The buyer-side checkout fee the page shows (`CheckoutFeePreview`), in the reader's locale.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeePreview {
    pub card_rate: String,
    pub card_fixed: String,
    pub bank_rate: String,
    pub bank_fixed: String,
    pub card_fee: String,
    pub card_total: String,
    pub balance_total: String,
}

impl FeePreview {
    /// `buildCheckoutFeePreview`: the card fee grossed up so it covers its own processing,
    /// rounded up, over integer cents.
    pub fn of(t: HomeMsg, terms: Terms) -> FeePreview {
        let card = terms.card;
        let numerator = SAMPLE_CENTS * i64::from(card.bps) + card.fixed * 10_000;
        let denominator = 10_000 - i64::from(card.bps);
        let fee = (numerator + denominator - 1).div_euclid(denominator);
        let money = |cents: i64| t.money(Minor(cents), USD).to_string();
        FeePreview {
            card_rate: rate(t, card.bps),
            card_fixed: money(card.fixed),
            bank_rate: rate(t, terms.bank.bps),
            bank_fixed: money(terms.bank.fixed),
            card_fee: money(fee),
            card_total: money(SAMPLE_CENTS + fee),
            balance_total: money(SAMPLE_CENTS),
        }
    }
}

/// Basis points as a percentage with at most two decimals (`formatBpsPercent`): 290 is 2.9%, in
/// the locale's way (`2,9 %` in French).
fn rate(t: HomeMsg, bps: u32) -> String {
    t.percent(Decimal::new(i128::from(bps), 4), 2).to_string()
}

/// What the page reads besides the address: the fee terms (live, or the compiled ones), the
/// promo bar's titled messages and the counter.
pub struct Reads {
    pub terms: Terms,
    pub live: bool,
    pub promos: Vec<Promo>,
    pub count: Option<f64>,
}

/// The three reads, at once, each kept for the next visitor and each given up after two seconds:
/// the page draws without the promo bar or counter, and with the compiled terms, rather than wait.
async fn read(config: &Shared) -> Reads {
    let api = config.api();
    let kept = &config.home;
    let terms = async {
        let read = async {
            let values = tokio::time::timeout(READ_WAIT, api.policy_values())
                .await
                .map_err(|_| "timed out".to_owned())?
                .map_err(|e| e.to_string())?;
            Terms::read(&values)
        };
        kept.terms.or_read(read).await
    };
    let promos = promos(config);
    let count = kept.count.or_read(async {
        tokio::time::timeout(READ_WAIT, api.waitlist_count())
            .await
            .map_err(|_| "timed out".to_owned())?
            .map_err(|e| e.to_string())
    });
    let (terms, promos, count) = tokio::join!(terms, promos, count);
    let live = terms.is_ok();
    let terms = terms.unwrap_or_else(|error| {
        tracing::warn!("live checkout processing terms are unavailable; the home page uses the compiled launch terms: {error}");
        COMPILED
    });
    let promos = promos.unwrap_or_default();
    let count = count.unwrap_or_else(|error| {
        tracing::warn!("the waitlist counter's read failed: {error}");
        None
    });
    Reads { terms, live, promos, count }
}

/// The promo bar's titled messages, kept for the next visitor and given up after two seconds: the
/// shell around the home page and the policy pages. A failure is logged and is none.
pub async fn promos(config: &Shared) -> Result<Vec<Promo>, ()> {
    let api = config.api();
    let read = config.home.promos.or_read(async {
        tokio::time::timeout(READ_WAIT, api.promos()).await.map_err(|_| "timed out".to_owned())?.map_err(|e| e.to_string())
    });
    match read.await {
        Ok(promos) => Ok(promos.into_iter().filter(|p| !p.title.is_empty()).collect()),
        Err(error) => {
            tracing::warn!("the promo bar's read failed: {error}");
            Err(())
        }
    }
}

/// A fee-calculator share link made while the calculator was on `/`: `price` and exactly this
/// utm triple. The calculator is on the compare pages now (public-web's), so it goes to TCGplayer's
/// with the query as it is.
fn legacy_share(params: &Params) -> bool {
    params.has("price")
        && params.get("utm_source") == Some("fee-calculator")
        && params.get("utm_medium") == Some("share")
        && params.get("utm_campaign") == Some("what-you-keep")
}

/// What the visitor sent the last time, drawn into the form they sent it from, with the API's
/// refusal.
#[derive(Clone, Debug, Default)]
pub struct Sent {
    pub panel: Panel,
    pub email: String,
    pub role: Role,
    pub interest: Option<Interest>,
    pub consent: bool,
    pub message: String,
}

/// Which of the two forms.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Panel {
    #[default]
    Hero,
    Final,
}

impl Panel {
    pub fn as_str(self) -> &'static str {
        match self {
            Panel::Hero => "hero",
            Panel::Final => "final",
        }
    }

    /// Its analytics section.
    pub fn section(self) -> &'static str {
        match self {
            Panel::Hero => "hero",
            Panel::Final => "final_cta",
        }
    }
}

/// Everything the page draws.
pub struct Screen {
    pub landing: Landing,
    /// What the forms start with: the address's, or what the visitor sent.
    pub role: Role,
    pub interest: Interest,
    pub preview: FeePreview,
    pub promos: Vec<Promo>,
    pub count: Option<f64>,
    pub discord: Option<String>,
    pub sent: Option<Sent>,
    /// public-web's origin, for its pages this app does not serve.
    pub web: String,
    /// The hero picture: the full size, then 800 and 1200 pixels wide.
    pub hero: [String; 3],
}

impl Screen {
    pub fn variant(&self) -> Variant {
        self.role.variant()
    }
}

/// The home page, or a fee-calculator share link's move to the compare page.
pub(crate) async fn page(req: Req, State(config): State<Shared>, uri: Uri) -> Public<HtmlResult> {
    let landing = Landing::read(&uri);
    if legacy_share(&landing.params) {
        // The compare page's calculator, which owns the anchor, with the link's price and tags.
        let param = |name: &str| landing.params.get(name).map(str::to_owned);
        let inputs = crate::compare::Inputs {
            price: param("price"),
            cards: None,
            utm_source: param("utm_source"),
            utm_medium: param("utm_medium"),
            utm_campaign: param("utm_campaign"),
        };
        let to = crate::app::url::compare::Compare { competitor: "tcgplayer", inputs };
        return Public::new(FRESH, req.moved(&to.at(views::FeeCalculatorId)));
    }
    let reads = read(&config).await;
    let live = reads.live;
    let page = render(&req, &config, landing, reads, None, StatusCode::OK);
    let public = Public::new(FRESH, page).stale_while_revalidate(STALE);
    if live { public.shared(SHARED) } else { public }
}

/// The form's fields (`WaitlistSignupPanel`), named as the pilot names them.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Form {
    pub panel: String,
    pub email: String,
    pub role: String,
    pub interests: Vec<String>,
    pub marketing_consent: String,
    pub games: Vec<String>,
    /// The honeypot: the API refuses a signup that fills it.
    pub website: String,
    pub page_path: String,
    pub referrer: String,
    pub utm_source: String,
    pub utm_medium: String,
    pub utm_campaign: String,
    pub utm_content: String,
    pub utm_term: String,
    pub referred_by_signup_id: String,
}

/// `optional`: the trimmed value, or none when it is empty.
fn optional(text: &str) -> Option<&str> {
    Some(text.trim()).filter(|t| !t.is_empty())
}

/// Join the waitlist: the signup goes to the welcome page (`/welcome`
/// reads the role, the variant and the games from the address, not the API); a refusal or a
/// failed call draws the page again with what was sent and the API's message.
pub(crate) async fn join(
    req: Req,
    State(config): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    client: Option<corten::ClientIp>,
    corten::Form(form): corten::Form<Form>,
) -> HtmlResult {
    let t: HomeMsg = req.t();
    let role_text = if form.role.is_empty() { "both" } else { form.role.as_str() };
    let role = Role::read(role_text);
    // The hero sends no first priority: it is the one its segment stands for (`resolveHeroIntent`).
    let derived;
    let interests: &[String] = if form.interests.is_empty() {
        derived = [role.unwrap_or_default().interest().as_str().to_owned()];
        &derived
    } else {
        &form.interests
    };
    let consent = matches!(form.marketing_consent.as_str(), "yes" | "on");
    let signup = Signup {
        email: &form.email,
        role: role_text,
        interests,
        marketing_consent: consent,
        referred_by_signup_id: optional(&form.referred_by_signup_id),
        games: &form.games,
        has_store_link: false,
        store_url: None,
        inventory_size: None,
        website: optional(&form.website),
        source: SignupSource {
            page_path: if form.page_path.is_empty() { "/" } else { &form.page_path },
            referrer: optional(&form.referrer),
            utm_source: optional(&form.utm_source),
            utm_medium: optional(&form.utm_medium),
            utm_campaign: optional(&form.utm_campaign),
            utm_content: optional(&form.utm_content),
            utm_term: optional(&form.utm_term),
        },
    };
    // The visitor's address, which the API's signup limiter keys on: the connection's, or behind
    // the proxies the deploy lists (`PROXIES`) the nearest one they forwarded.
    let client = client.map(|corten::ClientIp(ip)| ip.to_string());
    let caller = config.platform.caller(&headers, config.proto(), None);
    match caller.join(&signup, client.as_deref()).await {
        Ok(id) => {
            let mut games: Vec<String> = Vec::new();
            for game in &form.games {
                if !games.contains(game) {
                    games.push(game.clone());
                }
            }
            let arrival = crate::welcome::Arrival {
                signup: Some(id),
                fresh: Some("1".into()),
                role: Some(role_text.to_owned()),
                variant: Some(role.unwrap_or_default().variant().as_str().into()),
                game: games,
                attributed: optional(&form.referred_by_signup_id).map(|_| "1".into()),
                saved: None,
            };
            req.redirect(&crate::app::url::files::Welcome { arrival })
        }
        Err(error) => {
            let status = match error.status() {
                Some(StatusCode::TOO_MANY_REQUESTS) => StatusCode::TOO_MANY_REQUESTS,
                Some(status) if status.is_client_error() => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::BAD_GATEWAY,
            };
            if status == StatusCode::BAD_GATEWAY {
                tracing::warn!("the waitlist signup failed: {error}");
            }
            let message = match &error {
                crate::presence::ApiError::Status { message, .. } if !message.is_empty() => message.clone(),
                _ => t.route_waitlist_failed().to_owned(),
            };
            let sent = Sent {
                panel: if form.panel == "final" { Panel::Final } else { Panel::Hero },
                email: form.email.clone(),
                role: role.unwrap_or_default(),
                interest: form.interests.first().and_then(|i| Interest::read(i)),
                consent,
                message,
            };
            let landing = Landing::read(&uri);
            let reads = read(&config).await;
            render(&req, &config, landing, reads, Some(sent), status)
        }
    }
}

/// The page, for whoever the caller says it is for: everyone (the home page, `Public`) or the
/// visitor who joined (`join`'s answer).
fn render<For>(
    req: &Req,
    config: &Shared,
    landing: Landing,
    reads: Reads,
    sent: Option<Sent>,
    status: StatusCode,
) -> corten::Result<corten::HtmlResponse<For>> {
    let t: HomeMsg = req.t();
    let p: Pilot = req.t();
    let role = sent.as_ref().map_or(landing.role, |s| s.role);
    let interest = sent.as_ref().and_then(|s| s.interest).unwrap_or(role.interest());
    let preview = FeePreview::of(t, reads.terms);
    let game_label = landing.game.map(|g| g.label(t));
    let title = match game_label {
        Some(game) => t.route_meta_game_title(game).to_string(),
        None => t.route_meta_title().to_owned(),
    };
    let description = match game_label {
        Some(game) => t.route_meta_game_description(game).to_string(),
        None => t.route_meta_description().to_owned(),
    };
    let home = format!("{}/", config.origin);
    let page_url = match landing.game {
        Some(game) => format!("{}/?game={}", config.origin, game.slug()),
        None => home.clone(),
    };
    let image = format!(
        "{}{}",
        config.origin,
        req.asset(landing.game.map_or(crate::app::Static::HOME_CHASE_SETS_OG_DEFAULT_PNG, Game::card))
    );
    let ld = structured_data(t, &home, &preview);
    let screen = Screen {
        landing,
        role,
        interest,
        preview,
        promos: reads.promos,
        count: reads.count,
        discord: config.discord.clone(),
        sent,
        web: public_web().to_owned(),
        hero: [
            req.asset(crate::app::Static::HOME_CHASE_SETS_PRELAUNCH_HERO_WEBP).to_string(),
            req.asset(crate::app::Static::HOME_CHASE_SETS_PRELAUNCH_HERO_800W_WEBP).to_string(),
            req.asset(crate::app::Static::HOME_CHASE_SETS_PRELAUNCH_HERO_1200W_WEBP).to_string(),
        ],
    };
    let (og_title, description, page_url, image, brand) =
        (title.as_str(), description.as_str(), page_url.as_str(), image.as_str(), t.brand());
    let head = html! {
        <meta name="description" content={description}>
        <meta property="og:site_name" content={brand}>
        <meta property="og:title" content={og_title}>
        <meta property="og:description" content={description}>
        <meta property="og:type" content="website">
        <meta property="og:url" content={page_url}>
        <meta property="og:image" content={image}>
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content={og_title}>
        <meta name="twitter:description" content={description}>
        <meta name="twitter:image" content={image}>
        <link rel="canonical" href={&home}>
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        <JsonLd value={&ld} />
    };
    let screen = &screen;
    req.page_with_status(
        status,
        html! {
            <HomeLayout req={req} t={t} p={p} promos={&screen.promos} web={&screen.web} title={&title} head={head}>
                <views::HomePage t={t} p={p} screen={screen} />
            </HomeLayout>
        },
    )
}

/// The page's structured data (`buildHomeStructuredData`): the organization, the site and its
/// signup, and the four questions the FAQ answers, with the fee answer's live terms.
fn structured_data(t: HomeMsg, home: &str, preview: &FeePreview) -> Value {
    let faq: Vec<Value> = faq(t, preview)
        .into_iter()
        .map(|(_, question, answer)| {
            json!({ "@type": "Question", "name": question, "acceptedAnswer": { "@type": "Answer", "text": answer } })
        })
        .collect();
    json!({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Organization",
                "@id": format!("{home}#organization"),
                "name": t.brand(),
                "url": home,
                "contactPoint": { "@type": "ContactPoint", "email": "support@chasesets.com", "contactType": "customer support" },
            },
            {
                "@type": "WebSite",
                "@id": format!("{home}#website"),
                "name": t.brand(),
                "url": home,
                "publisher": { "@id": format!("{home}#organization") },
                "potentialAction": { "@type": "RegisterAction", "name": t.waitlist_submit(), "target": format!("{home}#waitlist-form") },
            },
            { "@type": "FAQPage", "@id": format!("{home}#landing-faq"), "mainEntity": faq },
        ],
    })
}

/// The landing FAQ (`landingFaqEntries`): what the visible list and the structured data both draw,
/// so they cannot drift. Each is its value, question and answer.
pub fn faq(t: HomeMsg, preview: &FeePreview) -> [(&'static str, &'static str, String); 4] {
    [
        ("launch", t.faq_launch_question(), t.faq_launch_answer().to_owned()),
        (
            "fees",
            t.faq_fees_question(),
            t.faq_fees_answer(&preview.card_rate, &preview.card_fixed, &preview.bank_rate).to_string(),
        ),
        ("shipping", t.faq_shipping_question(), t.faq_shipping_answer().to_owned()),
        ("safety", t.faq_safety_question(), t.faq_safety_answer().to_owned()),
    ]
}

#[cfg(test)]
mod tests {
    use corten::{axum::http::Uri, i18n::Messages as _};

    use super::{COMPILED, FeePreview, Game, Landing, Params, Role, Term, Terms, cents, legacy_share};
    use crate::text::HomeMsg;

    #[test]
    fn the_preview_grosses_the_card_fee_up_and_rounds_it_up() {
        let t = HomeMsg::for_locale("en");
        let preview = FeePreview::of(t, COMPILED);
        assert_eq!(preview.card_rate, "2.9%");
        assert_eq!(preview.card_fixed, "$0.30");
        assert_eq!(preview.bank_rate, "0.5%");
        assert_eq!(preview.bank_fixed, "$0.00");
        assert_eq!(preview.card_fee, "$2.82");
        assert_eq!(preview.card_total, "$86.70");
        assert_eq!(preview.balance_total, "$83.88");
        let odd = FeePreview::of(t, Terms { card: Term { bps: 325, fixed: 0 }, bank: Term { bps: 0, fixed: 0 } });
        assert_eq!((odd.card_rate.as_str(), odd.bank_rate.as_str()), ("3.25%", "0%"));
    }

    #[test]
    fn an_amount_is_cents_with_at_most_two_decimals() {
        assert_eq!(cents("0.30"), Some(30));
        assert_eq!(cents("12"), Some(1200));
        assert_eq!(cents("1.5"), Some(150));
        assert_eq!(cents("1.555"), None);
        assert_eq!(cents("abc"), None);
    }

    #[test]
    fn the_address_says_the_game_and_what_the_visitor_came_to_do() {
        let landing = Landing::read(&"/?utm_campaign=Collectors-Fall&game=pokemon&ref=wls_1".parse::<Uri>().unwrap());
        assert_eq!(landing.game, Some(Game::Pokemon));
        assert_eq!(landing.role, Role::Buy, "an utm value that names collectors is a buyer");
        assert_eq!(landing.source.referred_by.as_deref(), Some("wls_1"));
        assert_eq!(landing.source.page_path, "/?utm_campaign=Collectors-Fall&game=pokemon&ref=wls_1");
        assert_eq!(
            landing.roster_href(Game::Magic),
            "/?utm_campaign=Collectors-Fall&game=magic-the-gathering&ref=wls_1#waitlist-form"
        );
        let explicit = Landing::read(&"/?intent=sell&utm_source=buyers&game=chess".parse::<Uri>().unwrap());
        assert_eq!((explicit.role, explicit.game), (Role::Sell, None), "?intent= wins; an unknown game is none");
        assert_eq!(Landing::read(&"/".parse::<Uri>().unwrap()).roster_href(Game::Lorcana), "/?game=disney-lorcana#waitlist-form");
        assert_eq!(Params::read(Some("a=1&b=x+y%21")).with("c", "d e"), "a=1&b=x+y%21&c=d+e");
    }

    #[test]
    fn only_the_old_calculators_share_link_moves() {
        let share = Params::read(Some("price=12&utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep"));
        assert!(legacy_share(&share));
        assert!(!legacy_share(&Params::read(Some("utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep"))));
        assert!(!legacy_share(&Params::read(Some(
            "price=12&utm_source=fee-calculator&utm_medium=email&utm_campaign=what-you-keep"
        ))));
    }
}
