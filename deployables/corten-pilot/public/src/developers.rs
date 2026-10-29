//! The developer portal (Public Presence's `features/developer-portal`): the portal
//! (`/developers`), a guide (`/developers/{slug}`), the JSON manifest
//! (`/developers/manifest.json`) and `llms.txt`. Every address is gated as public-web's is: a 404
//! until `CHASE_SETS_M86_DEVELOPER_PORTAL_READY` is `true`, and then out of search
//! (`noindex,nofollow` in the page and `X-Robots-Tag` on every answer).
//!
//! The guides and the MCP tool catalog are compiled into the app (`developers.json`, which
//! scripts/export.mjs writes from the generated corpus and the MCP registry). A guide is drawn by
//! the help center's article view.
use std::{sync::LazyLock, time::Duration};

use corten::{
    answer::XRobotsTag,
    axum::http::{HeaderName, HeaderValue, StatusCode},
    prelude::*,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    app::{Shared, url},
    help::{Article, Values},
    text::{DevelopersMsg, HelpMsg, HomeMsg, Pilot},
    views::{self, HomeLayout},
};

const FRESH: Duration = Duration::from_secs(60);
const SHARED: Duration = Duration::from_secs(300);
const STALE: Duration = Duration::from_secs(60);
const ROBOTS: &str = "noindex, nofollow";

/// An MCP tool as the portal describes it, and as the manifest lists it.
#[derive(Debug, Deserialize)]
pub struct Tool {
    pub name: String,
    pub title: String,
    pub description: String,
    pub available: bool,
    pub service: String,
    pub risk: String,
    pub scope: String,
    pub permissions: Vec<String>,
    pub scopes: Vec<String>,
    pub usage: Vec<String>,
    pub confirmation: bool,
    pub idempotency: String,
    pub dry_run: bool,
    /// The schemas as public-web prints them (`JSON.stringify(schema, null, 2)`).
    pub input_schema: String,
    pub output_schema: Option<String>,
    /// The registry's entry, as the manifest lists it, in its own key order.
    pub manifest: Box<serde_json::value::RawValue>,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    articles: Vec<Article>,
    tools: Vec<Tool>,
    protocol_versions: Vec<String>,
    agent_terms: String,
}

static CORPUS: LazyLock<Corpus> =
    LazyLock::new(|| serde_json::from_str(include_str!("../developers.json")).expect("developers.json is the export's output"));

/// The guides, in the corpus's order.
pub fn articles() -> &'static [Article] {
    &CORPUS.articles
}

/// The tools the endpoint can invoke now, or the planned ones (`listDeveloperToolsByAvailability`).
pub fn tools(available: bool) -> Vec<&'static Tool> {
    CORPUS.tools.iter().filter(|t| t.available == available).collect()
}

/// The Agent Connector Terms' address.
pub fn agent_terms() -> &'static str {
    &CORPUS.agent_terms
}

/// Whether the portal is open (`isDeveloperPortalReady`).
pub fn ready(value: Option<&str>) -> bool {
    value.is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
}

fn robots() -> (HeaderName, HeaderValue) {
    (HeaderName::from_static("x-robots-tag"), HeaderValue::from_static(ROBOTS))
}

type Page = corten::Result<corten::HtmlResponse<corten::ForAll>>;

/// The answer's caching (`developerPortalResponseHeaders`), with `X-Robots-Tag`.
fn public(page: Page) -> Public<HtmlResult> {
    let page = page.map(|mut page| {
        let (name, value) = robots();
        page.headers_mut().insert(name, value);
        page
    });
    Public::new(FRESH, page).stale_while_revalidate(STALE).shared(SHARED)
}

/// A file the portal serves (the manifest, `llms.txt`), out of search (`X-Robots-Tag`, a header
/// of the app's on a `Public` answer since todd-skelton/corten#287).
fn file<A: corten::answer::Shareable>(answer: Public<A>) -> Public<A> {
    answer.stale_while_revalidate(STALE).shared(SHARED).header::<XRobotsTag>(HeaderValue::from_static(ROBOTS))
}

fn closed() -> Public<HtmlResult> {
    let page: Page = Err(corten::Error::status(StatusCode::NOT_FOUND));
    Public::new(FRESH, page)
}

fn head<'a>(description: &'a str, canonical: String) -> impl Render + 'a {
    html! {
        <meta name="description" content={description}>
        <meta name="robots" content="noindex,nofollow">
        <link rel="canonical" href={canonical}>
    }
}

/// The portal: the guides as cards, and the agent-readable documents.
pub(crate) async fn portal(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    if !config.developers {
        return closed();
    }
    let d: DevelopersMsg = req.t();
    let (t, p): (HomeMsg, Pilot) = (req.t(), req.t());
    let promos = crate::home::promos(&config).await.unwrap_or_default();
    let canonical = format!("{}{}", config.origin, url::developers::Developers.href());
    let page = req.page(html! {
        <HomeLayout
            req={&req}
            t={t}
            p={p}
            promos={&promos}
            web={crate::app::public_web()}
            title={d.meta_title()}
            head={head(d.meta_description(), canonical)}
        >
            <views::DeveloperPortal d={d} />
        </HomeLayout>
    });
    public(page)
}

/// A guide; one that is not one is not found.
pub(crate) async fn article(
    req: Req,
    State(config): State<Shared>,
    Params(route): Params<crate::app::url::developers::Guide<'_>>,
) -> Public<HtmlResult> {
    let slug = route.slug;
    if !config.developers {
        return closed();
    }
    let found = CORPUS.articles.iter().find(|a| a.locale == "en" && a.slug == slug && a.href == format!("/developers/{slug}"));
    let Some(article) = found else {
        return public(Err(corten::Error::status(StatusCode::NOT_FOUND)));
    };
    let d: DevelopersMsg = req.t();
    let (t, p, h): (HomeMsg, Pilot, HelpMsg) = (req.t(), req.t(), req.t());
    let promos = crate::home::promos(&config).await.unwrap_or_default();
    let title = d.article_meta_title(&article.title).to_string();
    let canonical = format!("{}{}", config.origin, article.href);
    let values = Values::default();
    let r = &req;
    let page = req.page(html! {
        <HomeLayout
            req={r}
            t={t}
            p={p}
            promos={&promos}
            web={crate::app::public_web()}
            title={&title}
            head={head(&article.description, canonical)}
        >
            <views::DeveloperArticle d={d} h={h} req={r} article={article} values={&values} />
        </HomeLayout>
    });
    public(page)
}

/// `buildDeveloperManifest`.
pub fn manifest(origin: &str) -> Value {
    let tools: Vec<&serde_json::value::RawValue> = CORPUS.tools.iter().map(|t| t.manifest.as_ref()).collect();
    json!({
        "schemaVersion": 1,
        "name": "Chase Sets Developer Portal",
        "indexing": "disabled",
        "readinessGate": "m86-certification",
        "portalUrl": format!("{origin}/developers"),
        "llmsUrl": format!("{origin}/llms.txt"),
        "articles": CORPUS.articles.iter().map(|a| json!({
            "slug": a.slug, "locale": a.locale, "title": a.title, "description": a.description,
            "reviewedAt": a.reviewed_at, "url": format!("{origin}{}", a.href),
        })).collect::<Vec<_>>(),
        "policies": [{ "policyKey": "agent-connector-terms", "title": "Agent Connector Terms", "url": format!("{origin}{}", CORPUS.agent_terms) }],
        "mcp": { "endpoint": format!("{origin}/mcp"), "protocolVersions": CORPUS.protocol_versions, "tools": tools },
    })
}

/// `buildDeveloperLlmsTxt`.
pub fn llms(origin: &str) -> String {
    let mut lines = vec![
        "# Chase Sets Developer Portal".to_owned(),
        String::new(),
        "> Gated, non-indexed documentation for the Chase Sets MCP and agent-commerce surface.".to_owned(),
        String::new(),
        format!("- [Developer portal]({origin}/developers)"),
    ];
    lines.extend(CORPUS.articles.iter().map(|a| format!("- [{}]({origin}{}): {}", a.title, a.href, a.description)));
    lines.push(format!("- [Agent Connector Terms]({origin}{})", CORPUS.agent_terms));
    lines.push(format!("- [Machine-readable developer manifest]({origin}/developers/manifest.json)"));
    lines.push(String::new());
    lines.push(format!("MCP endpoint: {origin}/mcp"));
    lines.push(format!("Supported protocol versions: {}", CORPUS.protocol_versions.join(", ")));
    lines.push(String::new());
    lines.join("\n")
}

pub(crate) async fn manifest_file(State(config): State<Shared>) -> Result<Public<Json<Value>>, corten::Error> {
    if !config.developers {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    }
    Ok(file(Public::new(FRESH, Json(manifest(&config.origin)))))
}

pub(crate) async fn llms_file(State(config): State<Shared>) -> Result<Public<String>, corten::Error> {
    if !config.developers {
        return Err(corten::Error::status(StatusCode::NOT_FOUND));
    }
    Ok(file(Public::new(FRESH, llms(&config.origin))))
}
