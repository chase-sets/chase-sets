//! The policy pages (Public Presence's `features/policies`): the terms, the privacy notice, the
//! founders offer's terms, the seller agreement, the payments, agent connector and authenticity
//! service terms. Each is a versioned document compiled into the app (`policies.json`, which
//! scripts/export.mjs writes from the policy registry), drawn as `PolicyArtifactPage` draws it:
//! the header with Print, the counsel-review banner while the document is not yet published, the
//! version, the contents and the sections.
//!
//! Each page is the same for everyone (`Public`). Only the promo bar in the shell is read, so a
//! cache in front keeps a page as long as the home page's (four minutes, a minute stale) while
//! that read succeeds, and the browser only otherwise.
use std::{sync::LazyLock, time::Duration};

use corten::prelude::*;
use serde::Deserialize;

use crate::{
    app::{Shared, url},
    text::{HomeMsg, Pilot, PolicyMsg},
    views::{self, HomeLayout},
};

const FRESH: Duration = Duration::from_secs(60);
const SHARED: Duration = Duration::from_secs(240);
const STALE: Duration = Duration::from_secs(60);

/// A document as its page draws it.
#[derive(Debug, Deserialize)]
pub struct Policy {
    pub key: String,
    pub href: String,
    pub version: String,
    pub locale: String,
    pub title: String,
    pub description: String,
    /// When it takes effect, only once it is published: ready for publication and dated
    /// (`resolvePolicyArtifactPublicationPosture`). Otherwise the page says counsel review is
    /// pending.
    pub effective_at: Option<String>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Deserialize)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub counsel_required: bool,
    /// The operative text, split where it names a sibling document's page.
    pub text: Vec<Part>,
    /// What the canonical claims registry says about an unresolved claim the section touches.
    pub disclosures: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Part {
    pub text: String,
    pub href: Option<String>,
}

static CORPUS: LazyLock<Vec<Policy>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../policies.json")).expect("policies.json is the export's output"));

/// The pages, each with what its route says besides the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Doc {
    Terms,
    Privacy,
    Founders,
    SellerAgreement,
    PaymentsTerms,
    AgentTerms,
    AuthenticityTerms,
}

impl Doc {
    pub const ALL: [Doc; 7] = [
        Doc::Terms,
        Doc::Privacy,
        Doc::Founders,
        Doc::SellerAgreement,
        Doc::PaymentsTerms,
        Doc::AgentTerms,
        Doc::AuthenticityTerms,
    ];

    fn key(self) -> &'static str {
        match self {
            Doc::Terms => "terms-of-service",
            Doc::Privacy => "privacy-policy",
            Doc::Founders => "founders-offer-terms",
            Doc::SellerAgreement => "seller-agreement",
            Doc::PaymentsTerms => "payments-terms",
            Doc::AgentTerms => "agent-connector-terms",
            Doc::AuthenticityTerms => "authenticity-service-terms",
        }
    }

    pub fn policy(self) -> &'static Policy {
        CORPUS.iter().find(|p| p.key == self.key()).expect("the export writes every registered document")
    }

    pub fn eyebrow(self, t: PolicyMsg) -> &'static str {
        match self {
            Doc::Terms => t.terms_eyebrow(),
            Doc::Privacy => t.eyebrow_privacy(),
            Doc::Founders => t.eyebrow_founders(),
            Doc::SellerAgreement => t.eyebrow_seller_agreement(),
            Doc::PaymentsTerms => t.eyebrow_payments_terms(),
            Doc::AgentTerms => t.eyebrow_agent_terms(),
            Doc::AuthenticityTerms => t.eyebrow_authenticity_terms(),
        }
    }

    fn meta(self, t: PolicyMsg) -> (&'static str, &'static str) {
        match self {
            Doc::Terms => (t.meta_terms_title(), t.meta_terms_description()),
            Doc::Privacy => (t.meta_privacy_title(), t.meta_privacy_description()),
            Doc::Founders => (t.meta_founders_title(), t.meta_founders_description()),
            Doc::SellerAgreement => (t.meta_seller_agreement_title(), t.meta_seller_agreement_description()),
            Doc::PaymentsTerms => (t.meta_payments_terms_title(), t.meta_payments_terms_description()),
            Doc::AgentTerms => (t.meta_agent_terms_title(), t.meta_agent_terms_description()),
            Doc::AuthenticityTerms => (t.meta_authenticity_terms_title(), t.meta_authenticity_terms_description()),
        }
    }

    /// Whether a document still in counsel review stays out of search (`noindexWhilePending`):
    /// all but the terms, the privacy notice and the founders' terms, which a visitor must be able
    /// to find while their page says they are not yet effective.
    fn hidden_while_pending(self) -> bool {
        !matches!(self, Doc::Terms | Doc::Privacy | Doc::Founders)
    }

    /// The terms have their own words (`copyProfile="terms-of-service"`).
    pub fn is_terms(self) -> bool {
        self == Doc::Terms
    }
}

/// Whether `path` is one of these pages: the shell's footer links them here.
pub fn serves(path: &str) -> bool {
    Doc::ALL.iter().any(|doc| doc.policy().href == path)
}

pub(crate) async fn terms(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::Terms).await
}

pub(crate) async fn privacy(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::Privacy).await
}

pub(crate) async fn founders(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::Founders).await
}

pub(crate) async fn seller_agreement(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::SellerAgreement).await
}

pub(crate) async fn payments_terms(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::PaymentsTerms).await
}

pub(crate) async fn agent_terms(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::AgentTerms).await
}

pub(crate) async fn authenticity_terms(req: Req, State(config): State<Shared>) -> Public<HtmlResult> {
    page(req, config, Doc::AuthenticityTerms).await
}

async fn page(req: Req, config: Shared, doc: Doc) -> Public<HtmlResult> {
    let promos = crate::home::promos(&config).await;
    let read = promos.is_ok();
    let page = render(&req, &config, doc, &promos.unwrap_or_default());
    let public = Public::new(FRESH, page).stale_while_revalidate(STALE);
    if read { public.shared(SHARED) } else { public }
}

fn render(
    req: &Req,
    config: &Shared,
    doc: Doc,
    promos: &[crate::presence::Promo],
) -> corten::Result<corten::HtmlResponse<corten::ForAll>> {
    let t: PolicyMsg = req.t();
    let home: HomeMsg = req.t();
    let p: Pilot = req.t();
    let policy = doc.policy();
    let (title, description) = doc.meta(t);
    let published = policy.effective_at.as_deref();
    let status = if published.is_some() { "published" } else { "counsel-review-required" };
    let canonical = format!("{}{}", config.origin, policy.href);
    // The founders' terms are shared, so they carry the founders' social card
    // (`buildPublicSocialMeta`).
    let social = (doc == Doc::Founders).then(|| {
        (
            format!("{}{}", config.origin, url::Founders.href()),
            format!("{}{}", config.origin, req.asset(crate::app::Static::HOME_CHASE_SETS_OG_FOUNDERS_PNG)),
        )
    });
    let head = html! {
        <meta name="description" content={description}>
        if published.is_none() && doc.hidden_while_pending() {
            <meta name="robots" content="noindex, nofollow">
        }
        <meta name="chase-sets:policy-key" content={&policy.key}>
        <meta name="chase-sets:policy-version" content={&policy.version}>
        <meta name="chase-sets:policy-publication-status" content={status}>
        if let Some(at) = published {
            <meta name="chase-sets:policy-effective-at" content={at}>
        }
        if let Some((page_url, image)) = &social {
            <meta property="og:site_name" content={home.brand()}>
            <meta property="og:title" content={title}>
            <meta property="og:description" content={description}>
            <meta property="og:type" content="website">
            <meta property="og:url" content={page_url}>
            <meta property="og:image" content={image}>
            <meta name="twitter:card" content="summary_large_image">
            <meta name="twitter:title" content={title}>
            <meta name="twitter:description" content={description}>
            <meta name="twitter:image" content={image}>
        }
        if !config.indexing {
            <meta name="robots" content="noindex,nofollow">
        }
        <link rel="canonical" href={&canonical}>
    };
    let web = crate::app::public_web();
    req.page(html! {
        <HomeLayout req={req} t={home} p={p} promos={promos} web={web} title={title} head={head}>
            <views::PolicyPage t={t} doc={doc} policy={policy} />
        </HomeLayout>
    })
}
