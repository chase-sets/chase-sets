//! The help center (Public Presence's `features/help`): the hub (`/help`), a category's articles
//! (`/help/{category}`), an article (`/help/{category}/{slug}`), and the two articles public-web
//! serves at their own addresses, `/sales-fees` and `/press`. The articles are compiled into the
//! app (`help.json`, which scripts/export.mjs writes from public-web's generated corpus), so only
//! the live policy values an article cites are read, from `GET /api/public-presence/policy-values`.
//!
//! A value is shown only when the answer is what the whitelist promises (its type, currency and
//! range, an effective date not in the future, and upcoming values in order), as
//! `resolvePublicPolicyArticle` checks it; any other is "Temporarily unavailable", marked for health
//! checks with `data-policy-value-state`, and the page says which values with
//! `data-policy-values-state="degraded"`. A value changing within the callout window gets a banner.
//!
//! Every page is the same for everyone (`Public`): a browser keeps it a minute, a cache in front
//! five, either a minute stale, as public-web's `headers()` say, which keeps a fee change within
//! the six minutes the API promises (`propagationSeconds`). The values are not kept in the process
//! for that reason. A page whose values or promo bar could not be read is kept by the browser only.
//! public-web waits for the values without a limit; the pilot gives up after two seconds and shows
//! the values as unavailable.
use std::{
    collections::{BTreeSet, HashMap},
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use corten::{axum::http::StatusCode, prelude::*};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{
    app::{Shared, url},
    presence::Presence,
    text::{HelpMsg, HomeMsg, Pilot},
    views::{self, HomeLayout},
};

const FRESH: Duration = Duration::from_secs(60);
const SHARED: Duration = Duration::from_secs(300);
const STALE: Duration = Duration::from_secs(60);
/// How long a page waits for the policy values.
const READ_WAIT: Duration = Duration::from_secs(2);

/// An article as public-web compiles it.
#[derive(Debug, Deserialize)]
pub struct Article {
    pub slug: String,
    pub locale: String,
    pub title: String,
    pub description: String,
    pub audience: Audience,
    pub category: Category,
    pub reviewed_at: String,
    pub href: String,
    pub headings: Vec<Heading>,
    pub blocks: Vec<Block>,
    pub policy_value_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Heading {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Block {
    Paragraph { content: Vec<Inline> },
    Heading { level: u8, id: String, content: Vec<Inline> },
    List { ordered: bool, items: Vec<Vec<Inline>> },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Inline {
    Text { value: String },
    Emphasis { value: String },
    Strong { value: String },
    Code { value: String },
    Link { label: String, href: String },
    PolicyValue { key: String },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Audience {
    Buyer,
    Seller,
    Developer,
}

impl Audience {
    pub const ALL: [Audience; 3] = [Audience::Buyer, Audience::Seller, Audience::Developer];

    pub fn title(self, t: HelpMsg) -> &'static str {
        match self {
            Audience::Buyer => t.audience_buyer_title(),
            Audience::Seller => t.audience_seller_title(),
            Audience::Developer => t.audience_developer_title(),
        }
    }

    pub fn description(self, t: HelpMsg) -> &'static str {
        match self {
            Audience::Buyer => t.audience_buyer_description(),
            Audience::Seller => t.audience_seller_description(),
            Audience::Developer => t.audience_developer_description(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    GettingStarted,
    Buying,
    Selling,
}

impl Category {
    pub const ALL: [Category; 3] = [Category::GettingStarted, Category::Buying, Category::Selling];

    pub fn slug(self) -> &'static str {
        match self {
            Category::GettingStarted => "getting-started",
            Category::Buying => "buying",
            Category::Selling => "selling",
        }
    }

    pub fn read(slug: &str) -> Option<Category> {
        Category::ALL.into_iter().find(|c| c.slug() == slug)
    }

    pub fn title(self, t: HelpMsg) -> &'static str {
        match self {
            Category::GettingStarted => t.category_getting_started_title(),
            Category::Buying => t.category_buying_title(),
            Category::Selling => t.category_selling_title(),
        }
    }

    pub fn description(self, t: HelpMsg) -> &'static str {
        match self {
            Category::GettingStarted => t.category_getting_started_description(),
            Category::Buying => t.category_buying_description(),
            Category::Selling => t.category_selling_description(),
        }
    }
}

/// What the whitelist promises about a value.
#[derive(Debug, Deserialize)]
struct Allowed {
    key: String,
    #[serde(rename = "type")]
    kind: String,
    currency: Option<String>,
    contract: Contract,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "primitive", rename_all = "kebab-case")]
enum Contract {
    Integer {
        minimum: i64,
        maximum: i64,
    },
    Money {
        #[serde(rename = "minimumCents")]
        minimum_cents: i64,
        #[serde(rename = "maximumCents")]
        maximum_cents: Option<i64>,
    },
}

#[derive(Deserialize)]
struct Corpus {
    articles: Vec<Article>,
    values: Vec<Allowed>,
}

static CORPUS: LazyLock<Corpus> =
    LazyLock::new(|| serde_json::from_str(include_str!("../help.json")).expect("help.json is the export's output"));

const LOCALE: &str = "en";

fn articles() -> impl Iterator<Item = &'static Article> {
    CORPUS.articles.iter().filter(|a| a.locale == LOCALE)
}

/// `listHelpArticlesByCategory`: every article in the category, the two at their own addresses too.
pub fn in_category(category: Category) -> Vec<&'static Article> {
    articles().filter(|a| a.category == category).collect()
}

/// `listHelpCategoriesByAudience`: the categories with an article for the audience.
pub fn categories_for(audience: Audience) -> Vec<Category> {
    Category::ALL.into_iter().filter(|c| articles().any(|a| a.audience == audience && a.category == *c)).collect()
}

/// `findPublicHelpArticleByPath`.
fn at(path: &str) -> Option<&'static Article> {
    articles().find(|a| a.href == path)
}

/// `listRelatedHelpArticles`: the first three others in the same category or for the same audience.
pub fn related(article: &Article) -> Vec<&'static Article> {
    articles()
        .filter(|c| c.href != article.href && (c.category == article.category || c.audience == article.audience))
        .take(3)
        .collect()
}

/// The help center's addresses a sitemap lists (public-web's `publicHelpCategoryPaths` and
/// `publicHelpArticlePaths`): the hub, each category with an article, and each article under it.
pub fn indexed() -> Vec<String> {
    let categories = Category::ALL.into_iter().filter(|c| !in_category(*c).is_empty()).map(|c| format!("/help/{}", c.slug()));
    let under = articles().filter(|a| a.href.starts_with("/help/")).map(|a| a.href.clone());
    std::iter::once("/help".to_owned()).chain(categories).chain(under).collect()
}

/// Whether `path` is one of these pages or an address moved to one, for links between public pages.
pub fn serves(path: &str) -> bool {
    matches!(path, "/help" | "/faq" | "/order-protection" | "/refunds-and-returns")
        || articles().any(|a| a.href == path)
        || Category::ALL.iter().any(|c| format!("/help/{}", c.slug()) == path)
}

/// The cited values as the page shows them: each one's text, or none when it is unavailable, and
/// the dates a cited value changes within the callout window.
#[derive(Debug, Default)]
pub struct Values {
    pub shown: HashMap<String, String>,
    pub changes: Vec<String>,
}

impl Values {
    /// The keys the page could not show, sorted, once each.
    pub fn unavailable(&self, article: &Article) -> Vec<String> {
        let mut keys: BTreeSet<String> = BTreeSet::new();
        for block in &article.blocks {
            let lists: Vec<&Vec<Inline>> = match block {
                Block::List { items, .. } => items.iter().collect(),
                Block::Paragraph { content } | Block::Heading { content, .. } => vec![content],
            };
            for inline in lists.into_iter().flatten() {
                if let Inline::PolicyValue { key } = inline
                    && !self.shown.contains_key(key)
                {
                    keys.insert(key.clone());
                }
            }
        }
        keys.into_iter().collect()
    }
}

/// `resolvePublicPolicyArticle`: the article's values from the API's answer, each checked against
/// the whitelist. `None` is a failed read: every value is unavailable.
pub fn resolve(t: HomeMsg, article: &Article, answer: Option<&Value>) -> Values {
    let Some(answer) = answer.and_then(Value::as_object).filter(|a| envelope(a)) else {
        if !article.policy_value_keys.is_empty() {
            tracing::error!(route = %article.href, "public policy values are unavailable");
        }
        return Values::default();
    };
    let values = answer["values"].as_object().expect("the envelope is checked");
    let resolved_at = instant(answer["resolvedAt"].as_str().unwrap_or_default()).expect("the envelope is checked");
    let window = answer["changeCalloutDays"].as_i64().unwrap_or(0) * 86_400_000;
    let mut out = Values::default();
    let mut changes = BTreeSet::new();
    let mut unresolved = Vec::new();
    for key in article.policy_value_keys.iter().collect::<BTreeSet<_>>() {
        let checked = CORPUS.values.iter().find(|a| &a.key == key).and_then(|allowed| {
            let value = values.get(key.as_str())?.as_object()?;
            check(value, allowed, resolved_at).map(|upcoming| (allowed, value, upcoming))
        });
        let Some((allowed, value, upcoming)) = checked else {
            unresolved.push(key.as_str());
            continue;
        };
        out.shown.insert(key.clone(), format(t, allowed, &value["value"]));
        for (at, text) in upcoming {
            if at > resolved_at && at - resolved_at <= window {
                changes.insert(text.to_owned());
            }
        }
    }
    if !unresolved.is_empty() {
        tracing::error!(route = %article.href, keys = ?unresolved, "public policy values are unavailable");
    }
    out.changes = changes.into_iter().collect();
    out
}

fn envelope(answer: &Map<String, Value>) -> bool {
    only(answer, &["values", "resolvedAt", "propagationSeconds", "changeCalloutDays"])
        && answer["values"].is_object()
        && answer["resolvedAt"].as_str().and_then(instant).is_some()
        && answer["propagationSeconds"].as_u64().is_some()
        && answer["changeCalloutDays"].as_u64().is_some()
}

/// Exactly these keys.
fn only(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|k| object.contains_key(*k))
}

/// The value's upcoming changes (each one's instant and its text), when the value is what the
/// whitelist promises (`validatePublicPolicyValue`).
fn check<'v>(value: &'v Map<String, Value>, allowed: &Allowed, resolved_at: i64) -> Option<Vec<(i64, &'v str)>> {
    let money = allowed.kind == "money";
    let keys: &[&str] = if money {
        &["type", "value", "currency", "effectiveFrom", "upcoming"]
    } else {
        &["type", "value", "effectiveFrom", "upcoming"]
    };
    if !only(value, keys) || value["type"].as_str() != Some(allowed.kind.as_str()) || !payload(&value["value"], &allowed.contract)
    {
        return None;
    }
    match &value["effectiveFrom"] {
        Value::Null => {}
        Value::String(at) => {
            if instant(at)? > resolved_at {
                return None;
            }
        }
        _ => return None,
    }
    if money && (allowed.currency.is_none() || value["currency"].as_str() != allowed.currency.as_deref()) {
        return None;
    }
    let mut previous = resolved_at;
    let mut upcoming = Vec::new();
    for candidate in value["upcoming"].as_array()? {
        let candidate = candidate.as_object()?;
        if !only(candidate, &["value", "effectiveFrom"]) || !payload(&candidate["value"], &allowed.contract) {
            return None;
        }
        let text = candidate["effectiveFrom"].as_str()?;
        let at = instant(text)?;
        if at <= previous {
            return None;
        }
        previous = at;
        upcoming.push((at, text));
    }
    Some(upcoming)
}

/// `isValidPolicyPayload`: an integer in range, or an amount with exactly two decimals in range.
fn payload(value: &Value, contract: &Contract) -> bool {
    match contract {
        Contract::Integer { minimum, maximum } => {
            value.as_i64().is_some_and(|n| n >= *minimum && n <= *maximum) && !value.is_f64()
        }
        Contract::Money { minimum_cents, maximum_cents } => value
            .as_str()
            .and_then(two_decimals)
            .is_some_and(|cents| cents >= *minimum_cents && maximum_cents.is_none_or(|max| cents <= max)),
    }
}

/// `^(?:0|[1-9]\d*)\.\d{2}$` in cents.
fn two_decimals(text: &str) -> Option<i64> {
    let (whole, fraction) = text.split_once('.')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (whole.len() > 1 && whole.starts_with('0')) || fraction.len() != 2 || !digits(fraction) {
        return None;
    }
    whole.parse::<i64>().ok()?.checked_mul(100)?.checked_add(fraction.parse().ok()?)
}

/// `parseRfc3339Timestamp`: milliseconds since the epoch, for a timestamp with a real date and
/// time and a `Z` or `+hh:mm` offset.
pub fn instant(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let d = b.get(from..from + len)?;
        d.iter().all(u8::is_ascii_digit).then(|| d.iter().fold(0i64, |n, x| n * 10 + i64::from(x - b'0')))
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day, hour, minute, second) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &text[19..];
    let mut millis = 0i64;
    if let Some(fraction) = rest.strip_prefix('.') {
        let len = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if len == 0 {
            return None;
        }
        millis = format!("{:0<3}", &fraction[..len.min(3)]).parse().ok()?;
        rest = &fraction[len..];
    }
    let offset = match rest {
        "Z" => 0,
        _ => {
            let r = rest.as_bytes();
            if r.len() != 6 || !matches!(r[0], b'+' | b'-') || r[3] != b':' {
                return None;
            }
            let (h, m): (i64, i64) = (rest[1..3].parse().ok()?, rest[4..6].parse().ok()?);
            if h > 23 || m > 59 {
                return None;
            }
            (h * 60 + m) * if r[0] == b'+' { 1 } else { -1 }
        }
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if year < 1 || !(1..=12).contains(&month) || day < 1 || day > days_in || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60) * 1000) + millis)
}

/// `formatPublicPolicyValue`.
fn format(t: HomeMsg, allowed: &Allowed, value: &Value) -> String {
    let number = || value.as_i64().unwrap_or_default();
    let plural = |n: i64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    match allowed.kind.as_str() {
        "bps" => {
            let bps = number();
            let (whole, fraction) = (bps / 100, bps % 100);
            if fraction == 0 {
                format!("{whole}%")
            } else {
                format!("{whole}.{}%", format!("{fraction:02}").trim_end_matches('0'))
            }
        }
        "money" => {
            let cents = value.as_str().and_then(two_decimals).unwrap_or_default();
            let currency = corten::i18n::Currency::new(allowed.currency.as_deref().unwrap_or("USD"));
            t.money(corten::i18n::Minor(cents), currency).to_string()
        }
        "days" => plural(number(), "day", "days"),
        "hours" => plural(number(), "hour", "hours"),
        "minutes" => {
            let minutes = number() as f64 / 60_000.0;
            let text = if minutes.fract() == 0.0 { format!("{}", minutes as i64) } else { minutes.to_string() };
            format!("{text} {}", if minutes == 1.0 { "minute" } else { "minutes" })
        }
        _ => value.as_i64().map_or_else(|| value.to_string(), |n| n.to_string()),
    }
}

/// A date the page shows (`formatArticleReviewedAt`): `YYYY-MM-DD` as a long date in UTC.
pub fn long_date(t: HelpMsg, day: &str) -> String {
    let at = instant(&format!("{}T00:00:00Z", day.get(..10).unwrap_or(day)))
        .map(|ms| UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap_or_default()));
    at.map_or_else(|| day.to_owned(), |at: SystemTime| t.date(at, corten::i18n::DateStyle::Long).to_string())
}

/// The policy values, given up after two seconds.
async fn read_values(config: &Shared) -> Option<Value> {
    match tokio::time::timeout(READ_WAIT, config.api().policy_document()).await {
        Ok(Ok(answer)) => Some(answer),
        Ok(Err(error)) => {
            tracing::warn!("the public policy values' read failed: {error}");
            None
        }
        Err(_) => {
            tracing::warn!("the public policy values' read timed out");
            None
        }
    }
}

/// The shell's promo bar and whether it was read.
async fn shell(config: &Shared) -> (Vec<crate::presence::Promo>, bool) {
    match crate::home::promos(config).await {
        Ok(promos) => (promos, true),
        Err(()) => (Vec::new(), false),
    }
}

type Page = corten::Result<corten::HtmlResponse<corten::ForAll>>;

fn public(page: Page, whole: bool) -> Public<HtmlResult> {
    let public = Public::new(FRESH, page).stale_while_revalidate(STALE);
    if whole { public.shared(SHARED) } else { public }
}

/// Where a page is, for its canonical and social tags.
fn absolute(config: &Shared, path: &str) -> String {
    format!("{}{path}", config.origin)
}

/// The hub: each audience's categories.
pub(crate) async fn hub(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    let (promos, read) = shell(&config).await;
    let t: HelpMsg = req.t();
    let path = url::help::Help.href();
    let head = head(&req, &config, t.meta_title(), t.meta_description(), &path, true);
    let page = layout(&req, &promos, t.meta_title(), head, html! { <views::HelpHub t={t} /> });
    public(page, read)
}

/// A category's articles; a category that is not one, or has none, is not found.
pub(crate) async fn category(
    req: Req,
    State(config): State<Shared>,
    Params(route): Params<crate::app::url::help::HelpCategory<'_>>,
) -> Public<HtmlResult> {
    let slug = route.category;
    let Some(category) = Category::read(&slug).filter(|c| !in_category(*c).is_empty()) else {
        return public(Err(corten::Error::status(StatusCode::NOT_FOUND)), false);
    };
    let (promos, read) = shell(&config).await;
    let t: HelpMsg = req.t();
    let title = t.category_meta_title(category.title(t)).to_string();
    let description = t.category_meta_description(category.title(t)).to_string();
    let path = url::help::HelpCategory { category: category.slug() }.href();
    let head = head(&req, &config, &title, &description, &path, false);
    let page = layout(&req, &promos, &title, head, html! { <views::HelpCategoryPage t={t} category={category} /> });
    public(page, read)
}

/// An article under `/help`, with its related articles and marketplace's account links.
pub(crate) async fn article(
    req: Req,
    State(config): State<Shared>,
    Params(route): Params<crate::app::url::help::HelpArticle<'_>>,
) -> Public<HtmlResult> {
    let (category, slug) = (route.category, route.slug);
    let found =
        articles().find(|a| a.category.slug() == category && a.slug == slug && a.href == format!("/help/{category}/{slug}"));
    let Some(article) = found else {
        return public(Err(corten::Error::status(StatusCode::NOT_FOUND)), false);
    };
    let t: HelpMsg = req.t();
    let title = t.article_meta_title(&article.title).to_string();
    let marketplace = config.marketplace.clone();
    show(req, config, article, title, Some(marketplace), true, false).await
}

/// `/sales-fees`: the fees article, with no related articles, as public-web composes it.
pub(crate) async fn sales_fees(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    let article = at("/sales-fees").expect("the export writes the sales-fees article");
    let p: Pilot = req.t();
    let title = format!("{} | {}", article.title, p.shell_site());
    show(req, config, article, title, None, false, false).await
}

/// `/press`: the creator and press fact sheet, with the default social card.
pub(crate) async fn press(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    let article = at("/press").expect("the export writes the press article");
    let p: Pilot = req.t();
    let title = format!("{} | {}", article.title, p.shell_site());
    show(req, config, article, title, None, false, true).await
}

async fn show(
    req: Req,
    config: Shared,
    article: &'static Article,
    title: String,
    marketplace: Option<String>,
    with_related: bool,
    social: bool,
) -> Public<HtmlResult> {
    let answer = if article.policy_value_keys.is_empty() { None } else { read_values(&config).await };
    let (promos, read) = shell(&config).await;
    let home: HomeMsg = req.t();
    let values = resolve(home, article, answer.as_ref());
    let whole = read && values.unavailable(article).is_empty();
    let t: HelpMsg = req.t();
    let related = if with_related { related(article) } else { Vec::new() };
    let head = head(&req, &config, &title, &article.description, &article.href, social);
    let page = layout(
        &req,
        &promos,
        &title,
        head,
        html! {
            <views::HelpArticlePage
                t={t}
                p={req.t()}
                req={&req}
                article={article}
                values={&values}
                related={&related}
                marketplace={marketplace.as_deref()}
            />
        },
    );
    public(page, whole)
}

/// The head tags: the description, the canonical, `noindex` off the indexed site, and for a page
/// public-web shares (the hub, the press sheet) the default social card.
fn head<'a>(
    req: &'a Req,
    config: &'a Shared,
    title: &'a str,
    description: &'a str,
    path: &'a str,
    social: bool,
) -> impl Render + 'a {
    let home: HomeMsg = req.t();
    let page_url = absolute(config, path);
    let image = absolute(config, &req.asset(crate::app::Static::HOME_CHASE_SETS_OG_DEFAULT_PNG).to_string());
    html! {
        <meta name="description" content={description}>
        if social {
            <meta property="og:site_name" content={home.brand()}>
            <meta property="og:title" content={title}>
            <meta property="og:description" content={description}>
            <meta property="og:type" content="website">
            <meta property="og:url" content={&page_url}>
            <meta property="og:image" content={&image}>
            <meta name="twitter:card" content="summary_large_image">
            <meta name="twitter:title" content={title}>
            <meta name="twitter:description" content={description}>
            <meta name="twitter:image" content={&image}>
        }
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        <link rel="canonical" href={&page_url}>
    }
}

fn layout<H: Render, C: Render>(req: &Req, promos: &[crate::presence::Promo], title: &str, head: H, children: C) -> Page {
    let home: HomeMsg = req.t();
    let p: Pilot = req.t();
    req.page(html! {
        <HomeLayout req={req} t={home} p={p} promos={promos} web={crate::app::public_web()} title={title} head={head}>
            {children}
        </HomeLayout>
    })
}

/// The old addresses public-web moves to the help center, and its two older ones before them.
pub(crate) async fn faq(req: Req) -> HtmlResult {
    req.moved(&url::help::HelpArticle { category: "getting-started", slug: "frequently-asked-questions" })
}

pub(crate) async fn order_protection(req: Req) -> HtmlResult {
    req.moved(&url::help::HelpArticle { category: "buying", slug: "order-protection" })
}

pub(crate) async fn refunds(req: Req) -> HtmlResult {
    req.moved(&url::help::HelpArticle { category: "buying", slug: "refunds-and-returns" })
}

pub(crate) async fn older_protection(req: Req) -> HtmlResult {
    req.moved(&url::files::OrderProtection)
}

pub(crate) async fn older_fees(req: Req) -> HtmlResult {
    req.moved(&url::sales_fees::SalesFees)
}

/// Where an article's link goes: marketplace's account pages on its origin (or no link, where
/// public-web has none), a public page this app does not serve on public-web, anything else as it is.
pub fn link_href(req: &Req, href: &str, marketplace: Option<&str>) -> Option<String> {
    if !href.starts_with('/') || href.starts_with("//") {
        return Some(href.to_owned());
    }
    let path = href.split(['?', '#']).next().unwrap_or(href);
    if path == "/account" || path.starts_with("/account/") {
        return marketplace.map(|origin| format!("{}{href}", origin.trim_end_matches('/')));
    }
    let ours = corten::Local::parse(path).is_some_and(|local| req.serves(&local));
    Some(if ours { href.to_owned() } else { format!("{}{href}", crate::app::public_web()) })
}
