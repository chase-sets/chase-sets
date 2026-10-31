//! The Policy Console (`PolicyConsolePage`). Top to bottom: the header, the link to Commercial
//! Terms, the Commercial Terms dates that need attention, the public articles waiting for a review
//! (each with Confirm current for an operator who may), and a section per owning context with its
//! policies. Each table scrolls on its own on a phone.
use corten::prelude::*;

use super::{status, when};
use crate::{
    policy_console::{ConfirmForm, ConsoleScreen, context_label, url},
    text::Ops,
    views::{Here, link_to},
};

#[component(css = PolicyConsolePage)]
fn Pill(words: &'static str, tone: &'static str) -> impl Render {
    html! { <span class={Tag} data-tone={tone}>{words}</span> }
}

#[component(css)]
pub fn PolicyConsolePage<'a>(o: Ops, req: &'a Req, here: &'a Here, screen: &'a ConsoleScreen) -> impl Render {
    let f = ConfirmForm::FIELDS;
    let terms = link_to(req, &screen.registry.commercial_terms_schedules_href).unwrap_or_default();
    let not_set = || o.policy_not_set().to_owned();
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{o.policy_eyebrow()}</p>
                <h1>{o.policy_title()}</h1>
                <p class={Muted}>{o.policy_description()}</p>
            </header>
            if let Some(refusal) = &screen.refusal {
                <p class={Alert} role="alert">{refusal}</p>
            }
            <section class={Card} aria-labelledby="policy-terms">
                <h2 class={Heading} id="policy-terms">{o.policy_commercial_terms_link_title()}</h2>
                <p class={Muted}>{o.policy_commercial_terms_link_description()}</p>
                <a class={(Button, Secondary)} href={&terms}>{o.policy_commercial_terms_link_action()}</a>
            </section>
            <section class={Card} aria-labelledby="policy-attention">
                <h2 class={Heading} id="policy-attention">{o.policy_commercial_terms_attention_title()}</h2>
                <p class={Muted}>{o.policy_commercial_terms_attention_description()}</p>
                if screen.attention.is_empty() {
                    <p class={Muted}>{o.policy_commercial_terms_attention_empty()}</p>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.policy_commercial_terms_attention_terms()}</th>
                                    <th scope="col">{o.policy_commercial_terms_attention_timing()}</th>
                                    <th scope="col">{o.policy_commercial_terms_attention_action()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for item in &screen.attention {
                                    <tr>
                                        <td class={Words}>{&item.label}</td>
                                        <td>{&item.detail}</td>
                                        <td>
                                            <a class={(Button, Secondary)} href={link_to(req, &item.href).unwrap_or_default()}>
                                                {o.policy_commercial_terms_attention_review()}
                                            </a>
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            <section class={Card} aria-labelledby="policy-reviews">
                <h2 class={Heading} id="policy-reviews">{o.policy_review_queue_title()}</h2>
                <p class={Muted}>{o.policy_review_queue_description()}</p>
                if screen.reviews.is_empty() {
                    <p class={Muted}>{o.policy_review_queue_empty()}</p>
                } else {
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.policy_review_queue_article()}</th>
                                    <th scope="col">{o.policy_review_queue_policy()}</th>
                                    <th scope="col">{o.policy_review_queue_age()}</th>
                                    if screen.can_manage {
                                        <th scope="col">{o.policy_review_queue_action()}</th>
                                    }
                                </tr>
                            </thead>
                            <tbody>
                                for review in &screen.reviews {
                                    <tr>
                                        <td class={Words}>
                                            <a href={link_to(req, &review.article_href).unwrap_or_default()}>
                                                {&review.article_title}
                                            </a>
                                        </td>
                                        <td class={Words}>{&review.policy_key}</td>
                                        <td>{o.policy_review_queue_age_days(&review.age_days.to_string()).to_string()}</td>
                                        if screen.can_manage {
                                            <td>
                                                <form method="post" action={url::Console::default()}>
                                                    <input type="hidden" name={f.locale} value={&review.locale}>
                                                    <input type="hidden" name={f.article_slug} value={&review.article_slug}>
                                                    <input type="hidden" name={f.policy_key} value={&review.policy_key}>
                                                    <button class={(Button, Secondary)} type="submit">
                                                        {o.policy_review_queue_confirm()}
                                                    </button>
                                                </form>
                                            </td>
                                        }
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                }
            </section>
            for (context, entries) in screen.groups() {
                let id = format!("policy-context-{context}");
                <section class={Card} aria-labelledby={&id}>
                    <h2 class={Heading} id={&id}>{context_label(context)}</h2>
                    <div class={Scroll}>
                        <table class={Table}>
                            <thead>
                                <tr>
                                    <th scope="col">{o.policy_policy_key()}</th>
                                    <th scope="col">{o.policy_schema()}</th>
                                    <th scope="col">{o.policy_status()}</th>
                                    <th scope="col">{o.policy_effective_from()}</th>
                                    <th scope="col">{o.policy_updated_at()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                for entry in entries {
                                    let (words, tone) = status(o, &entry.status);
                                    <tr>
                                        <td class={Key}>
                                            <a href={url::Policy { policy_key: &entry.policy_key, after_write: None }}>
                                                {&entry.policy_key}
                                            </a>
                                        </td>
                                        <td class={Schema}>{&entry.schema_summary}</td>
                                        <td><Pill words={words} tone={tone} /></td>
                                        <td class={When}>
                                            {if entry.effective_from.is_empty() { not_set() } else { when(o, here, &entry.effective_from) }}
                                        </td>
                                        <td class={When}>
                                            {if entry.updated_at.is_empty() { not_set() } else { when(o, here, &entry.updated_at) }}
                                        </td>
                                    </tr>
                                }
                            </tbody>
                        </table>
                    </div>
                </section>
            }
        </div>
    }
}
