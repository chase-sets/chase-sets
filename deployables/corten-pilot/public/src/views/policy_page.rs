//! A policy document's page (`PolicyArtifactPage`): the eyebrow, title and description with Print,
//! the counsel-review banner while it is not published, its version, the contents and the
//! sections, each with its counsel badge, its text (a mention of a sibling document links to its
//! page) and the canonical claims' disclosures. Only that renders; the review manifest is for
//! counsel's packet.
//!
//! Print is the one thing that needs a script: the button is hidden until the shell's script
//! (`home.js`, which every page in this layout loads) shows it, so a visitor without one sees no
//! button that does nothing (the browser's own print works). Its two handlers are in that file
//! because every policy page loads it for the shell anyway: a module of their own would be one
//! more request for a page that is otherwise only text.
use corten::prelude::*;

use crate::{
    policy::{Doc, Policy},
    text::PolicyMsg,
};

use super::home_page::handlers;

/// The words that differ between the terms and the other documents.
struct Words {
    print: &'static str,
    pending_title: &'static str,
    pending_description: &'static str,
    metadata_label: &'static str,
    metadata_title: &'static str,
    version: String,
    effective_pending: &'static str,
    locale: String,
    toc_label: &'static str,
    toc_title: &'static str,
    counsel_required: &'static str,
}

impl Words {
    fn of(t: PolicyMsg, doc: Doc, policy: &Policy) -> Words {
        if doc.is_terms() {
            Words {
                print: t.terms_print(),
                pending_title: t.terms_counsel_pending_title(),
                pending_description: t.terms_counsel_pending_description(),
                metadata_label: t.terms_metadata_label(),
                metadata_title: t.terms_metadata_title(),
                version: t.terms_metadata_version(&policy.version).to_string(),
                effective_pending: t.terms_metadata_effective_pending(),
                locale: t.terms_metadata_locale(&policy.locale).to_string(),
                toc_label: t.terms_toc_label(),
                toc_title: t.terms_toc_title(),
                counsel_required: t.terms_section_counsel_required(),
            }
        } else {
            Words {
                print: t.policies_print(),
                pending_title: t.policies_counsel_pending_title(),
                pending_description: t.policies_counsel_pending_description(),
                metadata_label: t.policies_metadata_label(),
                metadata_title: t.policies_metadata_title(),
                version: t.policies_metadata_version(&policy.version).to_string(),
                effective_pending: t.policies_metadata_effective_pending(),
                locale: t.policies_metadata_locale(&policy.locale).to_string(),
                toc_label: t.policies_toc_label(),
                toc_title: t.policies_toc_title(),
                counsel_required: t.policies_section_counsel_required(),
            }
        }
    }
}

#[component(css)]
pub fn PolicyPage<'a>(t: PolicyMsg, doc: Doc, policy: &'a Policy) -> impl Render + 'a {
    let words = Words::of(t, doc, policy);
    let effective = match &policy.effective_at {
        Some(at) => t.policies_metadata_effective(at).to_string(),
        None => words.effective_pending.to_owned(),
    };
    let status = if policy.effective_at.is_some() { "published" } else { "counsel-review-required" };
    html! {
        <div
            class={Page}
            data-policy-key={&policy.key}
            data-policy-version={&policy.version}
            data-policy-publication-status={status}
            data-policy-effective-at={policy.effective_at.as_deref().unwrap_or("")}
        >
            <header class={Header}>
                <div class={Heading}>
                    <p class={Eyebrow}>{doc.eyebrow(t)}</p>
                    <h1 class={Title}>{&policy.title}</h1>
                    <p class={Description}>{&policy.description}</p>
                </div>
                <button
                    class={Print}
                    type="button"
                    hidden
                    on:connect={handlers::reveal(target)}
                    on:click={handlers::print(event)}
                >
                    {words.print}
                </button>
            </header>
            if policy.effective_at.is_none() {
                <div class={Pending} role="alert">
                    <p class={PendingTitle}>{words.pending_title}</p>
                    <p>{words.pending_description}</p>
                </div>
            }
            <section class={Card} aria-label={words.metadata_label}>
                <h2 class={CardTitle}>{words.metadata_title}</h2>
                <p>{&words.version}</p>
                <p>{&effective}</p>
                <p>{&words.locale}</p>
            </section>
            <nav class={Card} aria-label={words.toc_label}>
                <h2 class={CardTitle}>{words.toc_title}</h2>
                <ul class={Contents}>
                    for section in &policy.sections {
                        <li><a href={format!("#{}", section.id)}>{&section.title}</a></li>
                    }
                </ul>
            </nav>
            <article class={Sections}>
                for section in &policy.sections {
                    <section class={Part} aria-labelledby={&section.id}>
                        <h2 class={PartTitle} id={&section.id}>{&section.title}</h2>
                        if section.counsel_required {
                            <span class={Badge}>{words.counsel_required}</span>
                        }
                        if !section.text.is_empty() {
                            <p class={Text}>
                                for part in &section.text {
                                    match &part.href {
                                        Some(href) => { <a href={href}>{&part.text}</a> }
                                        None => { {&part.text} }
                                    }
                                }
                            </p>
                        }
                        for disclosure in &section.disclosures {
                            <p class={Text}>{disclosure}</p>
                        }
                    </section>
                }
            </article>
        </div>
    }
}
