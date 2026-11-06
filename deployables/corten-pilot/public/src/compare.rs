//! The compare pages (Public Presence's `compare-page.tsx`), `/compare/tcgplayer` and
//! `/compare/ebay`, with the fee calculator (`fee-comparison-calculator.tsx`), and Contact.
//!
//! The Chase Sets side is truth-gated as public-web's is: the seller-fee cell and the calculator
//! show numbers only from the live published schedule (`marketplace-sales-fee.standard.*` in
//! `GET /api/public-presence/policy-values`); without it the cell points to the fees page and the
//! calculator is not drawn. The schedule is kept in the process a minute (`SCHEDULE_LIFE`), so
//! calculations do not read the API. The competitors' fees are public-web's dated constants.
//!
//! The calculator is a GET form (`price`, `cards`), so it works without a script and a share
//! link (`?price=&cards=`) opens the same comparison. With a script the form is sent as the
//! visitor types and the section is redrawn in place (`data-patch`), which keeps the field being
//! typed into and its caret.
use std::time::Duration;

use corten::{
    axum::http::StatusCode,
    i18n::{Currency, Minor},
    prelude::*,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    app::{Shared, url},
    presence::{PolicyValues, Presence},
    text::{CompareMsg, HomeMsg, Pilot},
    views::{self, HomeLayout},
};

const FRESH: Duration = Duration::from_secs(60);
const SHARED: Duration = Duration::from_secs(240);
const STALE: Duration = Duration::from_secs(60);
const READ_WAIT: Duration = Duration::from_secs(2);
/// How long the schedule is kept in the process: with a shared cache's four minutes and one
/// stale, a schedule change shows within the six minutes the fees article promises
/// (`propagationSeconds`), and a seller's calculations within a minute read nothing.
pub const SCHEDULE_LIFE: Duration = crate::home::POLICY_LIFE;
const USD: Currency = Currency::new("USD");

/// When public-web's competitor fee constants were read from each marketplace's published schedule.
pub const AS_OF: &str = "July 12, 2026";

// TCGplayer: a 10.75% commission capped at $75 an item, and 2.5% + $0.30 processing an order.
const TCGPLAYER_COMMISSION_BPS: i64 = 1075;
const TCGPLAYER_COMMISSION_CAP: i64 = 7_500;
const TCGPLAYER_PROCESSING_BPS: i64 = 250;
const TCGPLAYER_ORDER_FEE: i64 = 30;
// eBay: 13.25% up to $7,500 and 2.35% above it, processing included, and $0.30 an order ($0.40
// over $10).
const EBAY_FVF_BPS: i64 = 1325;
const EBAY_TIER: i64 = 750_000;
const EBAY_ABOVE_TIER_BPS: i64 = 235;
const EBAY_SMALL_ORDER: i64 = 1_000;
const EBAY_SMALL_ORDER_FEE: i64 = 30;
const EBAY_ORDER_FEE: i64 = 40;

const MIN_PRICE: i64 = 1;
const MAX_PRICE: i64 = 999_999;
pub const MAX_CARDS: u32 = 100;

/// The competitor a compare page is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Competitor {
    Tcgplayer,
    Ebay,
}

impl Competitor {
    pub fn read(slug: &str) -> Option<Competitor> {
        match slug {
            "tcgplayer" => Some(Competitor::Tcgplayer),
            "ebay" => Some(Competitor::Ebay),
            _ => None,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Competitor::Tcgplayer => "tcgplayer",
            Competitor::Ebay => "ebay",
        }
    }

    pub fn other(self) -> Competitor {
        match self {
            Competitor::Tcgplayer => Competitor::Ebay,
            Competitor::Ebay => Competitor::Tcgplayer,
        }
    }

    pub fn name(self, t: HomeMsg) -> &'static str {
        match self {
            Competitor::Tcgplayer => t.home_fee_calculator_column_tcgplayer(),
            Competitor::Ebay => t.home_fee_calculator_column_ebay(),
        }
    }

    pub fn path(self) -> String {
        url::compare::Compare { competitor: self.slug(), ..Default::default() }.href()
    }

    /// The competitor's fee facts, by the names its messages use (`tcgplayerFeeFacts`,
    /// `ebayFeeFacts`), with its name as `competitor`.
    pub fn facts(self, t: HomeMsg) -> Vec<(&'static str, String)> {
        let money = |cents: i64| t.money(Minor(cents), USD).to_string();
        let mut facts = match self {
            Competitor::Tcgplayer => vec![
                ("commissionRate", percent(TCGPLAYER_COMMISSION_BPS)),
                ("commissionCap", money(TCGPLAYER_COMMISSION_CAP)),
                ("processingRate", percent(TCGPLAYER_PROCESSING_BPS)),
                ("processingFixed", money(TCGPLAYER_ORDER_FEE)),
            ],
            Competitor::Ebay => vec![
                ("finalValueFeeRate", percent(EBAY_FVF_BPS)),
                ("tierThreshold", money(EBAY_TIER)),
                ("aboveTierRate", percent(EBAY_ABOVE_TIER_BPS)),
                ("smallOrderThreshold", money(EBAY_SMALL_ORDER)),
                ("smallOrderFee", money(EBAY_SMALL_ORDER_FEE)),
                ("standardOrderFee", money(EBAY_ORDER_FEE)),
            ],
        };
        facts.push(("asOf", AS_OF.to_owned()));
        facts.push(("competitor", self.name(t).to_owned()));
        facts
    }
}

/// Whether `path` is Contact or a compare page, for links between public pages.
pub fn serves(path: &str) -> bool {
    path == "/contact" || path.strip_prefix("/compare/").and_then(Competitor::read).is_some()
}

/// `formatBpsPercent`: at most two decimals, no trailing zeros.
pub fn percent(bps: i64) -> String {
    let (whole, fraction) = (bps / 100, bps % 100);
    if fraction == 0 { format!("{whole}%") } else { format!("{whole}.{}%", format!("{fraction:02}").trim_end_matches('0')) }
}

/// The standard sales fee schedule (`toPublicMarketplaceFeeSchedule`): the rate, the fixed
/// amount and the cap an item, in cents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub bps: i64,
    pub fixed: i64,
    pub cap: i64,
}

impl Schedule {
    pub fn read(values: &PolicyValues) -> Result<Schedule, String> {
        let value = |key: &str| {
            values.values.get(key).map(|v| &v.value).ok_or_else(|| format!("public policy value '{key}' is unavailable"))
        };
        let bps = match value("marketplace-sales-fee.standard.bps")? {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        }
        .filter(|bps| (0..=10_000).contains(bps))
        .ok_or("the public marketplace sales fee percentage is not a valid basis-point value")?;
        let money = |key: &str| -> Result<i64, String> {
            let text = match value(key)? {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            cents(&text).ok_or_else(|| format!("public policy value '{key}' is not a money amount"))
        };
        Ok(Schedule {
            bps,
            fixed: money("marketplace-sales-fee.standard.fixed")?,
            cap: money("marketplace-sales-fee.standard.cap")?,
        })
    }

    /// The fee on one item before the cap: the rate rounded up, as Commercial Terms quotes it.
    pub fn uncapped(self, price: i64) -> i64 {
        (price * self.bps + 9_999) / 10_000 + self.fixed
    }
}

/// `parseMoneyCents`: digits with up to two decimals, at most the money maximum.
fn cents(text: &str) -> Option<i64> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || !digits(whole)
        || fraction.len() > 2
        || !digits(fraction)
        || (text.contains('.') && fraction.is_empty())
    {
        return None;
    }
    let whole: i64 = whole.parse().ok().filter(|w: &i64| *w <= 9_999_999_999)?;
    let fraction: i64 = format!("{fraction:0<2}").parse().ok()?;
    Some(whole * 100 + fraction).filter(|c| *c <= 999_999_999_999)
}

/// `parseCalculatorPrice`: a leading `$` and commas allowed, from $0.01 to $9,999.99.
pub fn parse_price(input: &str) -> Option<i64> {
    let text = input.trim();
    let text = text.strip_prefix('$').unwrap_or(text).replace(',', "");
    cents(&text).filter(|c| (MIN_PRICE..=MAX_PRICE).contains(c))
}

/// `parseCalculatorCardCount`: a whole number from 1 to 100.
pub fn parse_cards(input: &str) -> Option<u32> {
    let text = input.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|n| (1..=MAX_CARDS).contains(n))
}

/// What a seller pays and keeps on one marketplace, in cents (`MarketplaceFeeOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub fee: i64,
    pub processing: i64,
    pub kept: i64,
    pub capped: bool,
}

/// A competitor's fee rounds down, in its favor.
fn floor_bps(amount: i64, bps: i64) -> i64 {
    amount * bps / 10_000
}

/// `computeChaseSetsOutcome`: no seller processing; the fee rounds up and stops at the cap.
pub fn chase_sets(price: i64, cards: i64, schedule: Schedule) -> Outcome {
    let uncapped = schedule.uncapped(price);
    let fee = uncapped.min(schedule.cap) * cards;
    Outcome { fee, processing: 0, kept: price * cards - fee, capped: uncapped > schedule.cap }
}

/// `computeTcgplayerOutcome`.
pub fn tcgplayer(price: i64, cards: i64) -> Outcome {
    let total = price * cards;
    let uncapped = floor_bps(price, TCGPLAYER_COMMISSION_BPS);
    let fee = uncapped.min(TCGPLAYER_COMMISSION_CAP) * cards;
    let processing = floor_bps(total, TCGPLAYER_PROCESSING_BPS) + TCGPLAYER_ORDER_FEE;
    Outcome { fee, processing, kept: total - fee - processing, capped: uncapped > TCGPLAYER_COMMISSION_CAP }
}

/// `computeEbayOutcome`.
pub fn ebay(price: i64, cards: i64) -> Outcome {
    let total = price * cards;
    let above = (total - EBAY_TIER).max(0);
    let fee = floor_bps(total - above, EBAY_FVF_BPS) + floor_bps(above, EBAY_ABOVE_TIER_BPS);
    let processing = if total > EBAY_SMALL_ORDER { EBAY_ORDER_FEE } else { EBAY_SMALL_ORDER_FEE };
    Outcome { fee, processing, kept: total - fee - processing, capped: false }
}

/// The calculator's two fields as the address has them (a share link's), each as typed, and a
/// share link's campaign tags, which the page's analytics read from the address.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route, PartialEq, Eq)]
#[route(query)]
pub struct Inputs {
    pub price: Option<String>,
    pub cards: Option<String>,
    pub utm_source: Option<String>,
    pub utm_medium: Option<String>,
    pub utm_campaign: Option<String>,
}

/// The calculator as drawn: the fields as typed, what they parse to, and the three outcomes.
pub struct Calculator {
    pub competitor: Competitor,
    pub schedule: Schedule,
    pub price_input: String,
    pub cards_input: String,
    pub price: Option<i64>,
    pub cards: Option<u32>,
    /// The page's own address with this comparison, to copy (`buildShareLink`).
    pub share: Option<String>,
}

impl Calculator {
    /// public-web prefills a share link's values only when they are valid, and starts at $50.00
    /// and one card. A form the visitor sent is drawn as they typed it, errors and all.
    pub fn new(competitor: Competitor, schedule: Schedule, inputs: &Inputs, sent: bool, origin: &str) -> Calculator {
        let price_input = match &inputs.price {
            Some(text) if sent || parse_price(text).is_some() => text.clone(),
            _ => "50.00".to_owned(),
        };
        let cards_input = match &inputs.cards {
            Some(text) if sent || parse_cards(text).is_some() => text.clone(),
            _ => "1".to_owned(),
        };
        let (price, cards) = (parse_price(&price_input), parse_cards(&cards_input));
        let share = price.zip(cards).map(|(price, cards)| {
            format!(
                "{origin}{}?price={}.{:02}&cards={cards}&utm_source=fee-calculator&utm_medium=share&utm_campaign=what-you-keep#{}",
                competitor.path(),
                price / 100,
                price % 100,
                <views::FeeCalculatorId as corten::view::Id>::NAME,
            )
        });
        Calculator { competitor, schedule, price_input, cards_input, price, cards, share }
    }

    /// The three outcomes, when both fields are valid.
    pub fn outcomes(&self) -> Option<(Outcome, Outcome, Outcome)> {
        let (price, cards) = (self.price?, i64::from(self.cards?));
        Some((chase_sets(price, cards, self.schedule), tcgplayer(price, cards), ebay(price, cards)))
    }
}

/// The schedule, kept for the next visitor and given up after two seconds; a failure is logged.
async fn schedule(config: &Shared) -> Option<Schedule> {
    let api = config.api();
    let read = config.home.schedule.or_read(async {
        let values = tokio::time::timeout(READ_WAIT, api.policy_values())
            .await
            .map_err(|_| "timed out".to_owned())?
            .map_err(|e| e.to_string())?;
        Schedule::read(&values)
    });
    match read.await {
        Ok(schedule) => Some(schedule),
        Err(error) => {
            tracing::error!("the fee calculator's policy read failed; the calculator is not drawn: {error}");
            None
        }
    }
}

type Page = corten::Result<corten::HtmlResponse<corten::ForAll>>;

fn public(page: Page, whole: bool) -> Public<HtmlResult> {
    let public = Public::new(FRESH, page).stale_while_revalidate(STALE);
    if whole { public.shared(SHARED) } else { public }
}

/// `buildCompareFaqEntries`: the questions the page shows and its structured data answers.
pub fn faq(c: CompareMsg, t: HomeMsg, competitor: Competitor) -> Vec<(&'static str, String, String)> {
    let facts = competitor.facts(t);
    let key = |suffix: &str| format!("{}.{suffix}", competitor.slug());
    let by_key = |key: &str| c.by_key(key, &facts).map(|m| m.to_string()).unwrap_or_default();
    vec![
        ("competitor-fees", by_key(&key("faq.competitor_fees.question")), by_key(&key("faq.competitor_fees.answer"))),
        ("chase-sets-fees", c.faq_chase_sets_fees_question().to_owned(), c.faq_chase_sets_fees_answer().to_owned()),
        ("keep-more", c.faq_keep_more_question(competitor.name(t)).to_string(), c.faq_keep_more_answer().to_owned()),
        ("launch", t.faq_launch_question().to_owned(), t.faq_launch_answer().to_owned()),
    ]
}

/// `buildCompareStructuredData`: the page, its trail and the FAQ.
fn structured_data(c: CompareMsg, t: HomeMsg, competitor: Competitor, origin: &str) -> Value {
    let home = format!("{origin}/");
    let page = format!("{origin}{}", competitor.path());
    let (title, description) = meta(c, competitor);
    let questions: Vec<Value> = faq(c, t, competitor)
        .into_iter()
        .map(|(_, question, answer)| json!({ "@type": "Question", "name": question, "acceptedAnswer": { "@type": "Answer", "text": answer } }))
        .collect();
    json!({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage", "@id": format!("{page}#webpage"), "name": title, "description": description, "url": page,
                "isPartOf": { "@type": "WebSite", "@id": format!("{home}#website"), "name": t.brand(), "url": home },
            },
            {
                "@type": "BreadcrumbList", "@id": format!("{page}#breadcrumbs"),
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": t.brand(), "item": home },
                    { "@type": "ListItem", "position": 2, "name": title_of(c, competitor), "item": page },
                ],
            },
            { "@type": "FAQPage", "@id": format!("{page}#faq"), "mainEntity": questions },
        ],
    })
}

fn meta(c: CompareMsg, competitor: Competitor) -> (&'static str, &'static str) {
    match competitor {
        Competitor::Tcgplayer => (c.meta_tcgplayer_title(), c.meta_tcgplayer_description()),
        Competitor::Ebay => (c.meta_ebay_title(), c.meta_ebay_description()),
    }
}

pub fn title_of(c: CompareMsg, competitor: Competitor) -> &'static str {
    match competitor {
        Competitor::Tcgplayer => c.tcgplayer_title(),
        Competitor::Ebay => c.ebay_title(),
    }
}

/// A compare page; with a script, the calculator's form answers with its section alone.
pub(crate) async fn page(
    req: Req,
    State(config): State<Shared>,
    Params(route): Params<crate::app::url::compare::Compare<'_>>,
) -> Public<HtmlResult> {
    let (slug, inputs) = (route.competitor, route.inputs);
    let Some(competitor) = Competitor::read(&slug) else {
        return public(Err(corten::Error::status(StatusCode::NOT_FOUND)), false);
    };
    let sent = inputs.price.is_some() || inputs.cards.is_some();
    let (schedule, (promos, read)) = tokio::join!(schedule(&config), shell(&config));
    let t: HomeMsg = req.t();
    let c: CompareMsg = req.t();
    let calculator = schedule.map(|s| Calculator::new(competitor, s, &inputs, sent, &config.origin));
    let path = competitor.path();
    let page_url = format!("{}{path}", config.origin);
    let (title, description) = meta(c, competitor);
    let ld = structured_data(c, t, competitor, &config.origin);
    let head = html! {
        <meta name="description" content={description}>
        <meta property="og:site_name" content={t.brand()}>
        <meta property="og:title" content={title}>
        <meta property="og:description" content={description}>
        <meta property="og:type" content="website">
        <meta property="og:url" content={&page_url}>
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        <link rel="canonical" href={&page_url}>
        <JsonLd value={&ld} />
    };
    let p: Pilot = req.t();
    let live = calculator.is_some();
    let calculator = calculator.as_ref();
    let draw = || async {
        req.page(html! {
            <HomeLayout req={&req} t={t} p={p} promos={&promos} web={crate::app::public_web()} title={title} head={head}>
                <views::ComparePage c={c} t={t} p={p} competitor={competitor} schedule={schedule} calculator={calculator} />
            </HomeLayout>
        })
    };
    // With a script, the calculator's form answers with its section alone.
    let page = match calculator {
        Some(calculator) => {
            req.patch_or(html! { <views::FeeCalculator t={t} c={c} p={p} calculator={calculator} /> }, draw).await
        }
        None => draw().await,
    };
    // A share link's page is about one comparison; only the plain page is worth a shared cache.
    public(page, read && live && !sent)
}

/// Contact (`PublicInfoPage`): the support address and the current status.
pub(crate) async fn contact(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    let (promos, read) = shell(&config).await;
    let t: HomeMsg = req.t();
    let c: CompareMsg = req.t();
    let p: Pilot = req.t();
    let page_url = format!("{}{}", config.origin, url::contact::Contact.href());
    let head = html! {
        <meta name="description" content={c.meta_contact_description()}>
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        <link rel="canonical" href={&page_url}>
    };
    let page = req.page(html! {
        <HomeLayout
            req={&req}
            t={t}
            p={p}
            promos={&promos}
            web={crate::app::public_web()}
            title={c.meta_contact_title()}
            head={head}
        >
            <views::ContactPage c={c} />
        </HomeLayout>
    });
    public(page, read)
}

async fn shell(config: &Shared) -> (Vec<crate::presence::Promo>, bool) {
    match crate::home::promos(config).await {
        Ok(promos) => (promos, true),
        Err(()) => (Vec::new(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEDULE: Schedule = Schedule { bps: 800, fixed: 30, cap: 5_000 };

    #[test]
    fn prices_and_counts_parse_as_public_web_parses_them() {
        assert_eq!(parse_price("50.00"), Some(5_000));
        assert_eq!(parse_price(" $1,234.5 "), Some(123_450));
        assert_eq!(parse_price("0.01"), Some(1));
        for bad in ["0", "0.00", "10000", "1.234", "abc", "", "-1", "1.", ".5"] {
            assert_eq!(parse_price(bad), None, "{bad}");
        }
        assert_eq!(parse_price("9999.99"), Some(999_999));
        assert_eq!(parse_cards("100"), Some(100));
        for bad in ["0", "101", "1.5", "", "-2", "x"] {
            assert_eq!(parse_cards(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_outcomes_round_as_public_webs_do() {
        // Chase Sets rounds up: 8% of $10.01 is 80.08 cents, so 81 + 30.
        assert_eq!(chase_sets(1_001, 1, SCHEDULE), Outcome { fee: 111, processing: 0, kept: 890, capped: false });
        // The cap: 8% of $1,000 + $0.30 is $80.30, capped at $50 an item.
        let capped = chase_sets(100_000, 2, SCHEDULE);
        assert_eq!((capped.fee, capped.capped), (10_000, true));
        // TCGplayer rounds down: 10.75% of $10.01 is 107.6 cents, so 107; processing 2.5% of
        // $10.01 is 25.025 cents, so 25 + 30.
        assert_eq!(tcgplayer(1_001, 1), Outcome { fee: 107, processing: 55, kept: 839, capped: false });
        assert!(tcgplayer(800_000, 1).capped);
        // eBay: $10 is a small order; above $7,500 the rest is 2.35%.
        assert_eq!(ebay(1_000, 1).processing, 30);
        assert_eq!(ebay(1_001, 1).processing, 40);
        assert_eq!(ebay(400_000, 2).fee, 750_000 * 1325 / 10_000 + 50_000 * 235 / 10_000);
        // A cent's sale keeps less than nothing on TCGplayer.
        assert!(tcgplayer(1, 1).kept < 0);
    }

    #[test]
    fn a_schedule_missing_a_value_or_out_of_range_is_none() {
        use crate::presence::PolicyValue;
        let values = |pairs: &[(&str, Value)]| PolicyValues {
            values: pairs.iter().map(|(k, v)| ((*k).to_owned(), PolicyValue { value: v.clone() })).collect(),
        };
        let full = [
            ("marketplace-sales-fee.standard.bps", json!(800)),
            ("marketplace-sales-fee.standard.fixed", json!("0.30")),
            ("marketplace-sales-fee.standard.cap", json!("50.00")),
        ];
        assert_eq!(Schedule::read(&values(&full)), Ok(SCHEDULE));
        assert!(Schedule::read(&values(&full[..2])).is_err());
        let mut over = full.clone();
        over[0].1 = json!(10_001);
        assert!(Schedule::read(&values(&over)).is_err());
        let mut text = full.clone();
        text[2].1 = json!("fifty");
        assert!(Schedule::read(&values(&text)).is_err());
    }

    #[test]
    fn rates_read_as_format_bps_percent_writes_them() {
        assert_eq!(percent(1075), "10.75%");
        assert_eq!(percent(250), "2.5%");
        assert_eq!(percent(800), "8%");
        assert_eq!(percent(5), "0.05%");
    }
}
