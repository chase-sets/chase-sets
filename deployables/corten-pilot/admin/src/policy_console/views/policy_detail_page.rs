//! A policy's page (`PolicyConsoleDetailPage`). Top to bottom: the header (its context, key and
//! schema), the publication runbook, what is in effect and what is scheduled (side by side from
//! 48rem), the revision form for an operator who may revise, and the revision history (a table that
//! scrolls on its own on a phone).
use corten::prelude::*;

use super::{status, when};
use crate::{
    policy_console::{PolicyScreen, RevisionForm, url},
    text::Ops,
    views::Here,
};

/// The runbook admin-web links every policy's page to.
const RUNBOOK: &str = "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/legal-corpus-publication.md";

/// A JSON value as indented text.
fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

#[component(css = PolicyDetailPage)]
fn Pair<'a>(term: &'a str, value: String) -> impl Render {
    html! {
        <div class={Row}>
            <dt>{term}</dt>
            <dd>{value}</dd>
        </div>
    }
}

#[component(css)]
pub fn PolicyDetailPage<'a>(o: Ops, here: &'a Here, screen: &'a PolicyScreen) -> impl Render {
    let f = RevisionForm::FIELDS;
    let overview = &screen.overview;
    let current = &overview.current;
    let form = &screen.form;
    let at = |value: Option<&str>, otherwise: &str| value.map_or_else(|| otherwise.to_owned(), |v| when(o, here, v));
    let (status_words, _) = status(o, current.status.as_deref().unwrap_or("fallback"));
    let action = url::Policy { policy_key: &overview.policy_key, after_write: None };
    html! {
        <div class={Page}>
            <header class={Header}>
                <p class={Eyebrow}>{o.policy_detail_eyebrow(&overview.context_name).to_string()}</p>
                <h1 class={Words}>{&overview.policy_key}</h1>
                <p class={(Muted, Words)}>{&overview.schema_summary}</p>
            </header>
            <a class={(Button, Secondary)} href={RUNBOOK}>{o.policy_detail_publication_runbook()}</a>
            <div class={Panels}>
                <section class={Card} aria-labelledby="policy-current">
                    <h2 class={Heading} id="policy-current">{o.policy_detail_current_title()}</h2>
                    <dl class={Pairs}>
                        <Pair term={o.policy_detail_source()} value={current.source.clone()} />
                        <Pair
                            term={o.policy_detail_status()}
                            value={if current.status.is_some() { status_words.to_owned() } else { o.policy_detail_not_set().to_owned() }}
                        />
                        <Pair
                            term={o.policy_detail_effective_from()}
                            value={at(current.effective_from.as_deref(), o.policy_detail_not_set())}
                        />
                        <Pair
                            term={o.policy_detail_effective_until()}
                            value={at(current.effective_until.as_deref(), o.policy_detail_open_ended())}
                        />
                    </dl>
                    <pre class={Json}>{pretty(&current.value)}</pre>
                </section>
                <section class={Card} aria-labelledby="policy-upcoming">
                    <h2 class={Heading} id="policy-upcoming">{o.policy_detail_upcoming_title()}</h2>
                    if overview.upcoming.is_empty() {
                        <p class={Muted}>{o.policy_detail_no_upcoming()}</p>
                    } else {
                        for revision in &overview.upcoming {
                            <div class={Upcoming}>
                                <span class={Tag}>
                                    {o.policy_detail_scheduled_for(&when(o, here, &revision.effective_from)).to_string()}
                                </span>
                                <pre class={Json}>{pretty(&revision.value)}</pre>
                            </div>
                        }
                    }
                </section>
            </div>
            if screen.can_manage {
                <section class={Card} aria-labelledby="policy-revise">
                    <h2 class={Heading} id="policy-revise">{o.policy_detail_revise_title()}</h2>
                    <form class={Form} method="post" action={action}>
                        if let Some(refusal) = &screen.refusal {
                            <p class={Alert} role="alert">{refusal}</p>
                        }
                        <label class={Field}>
                            <span>{o.policy_detail_value_label()}</span>
                            <small>{o.policy_detail_value_description()}</small>
                            <textarea name={f.value} rows="10" required spellcheck="false">{&form.value}</textarea>
                        </label>
                        <div class={Fields}>
                            <label class={Field}>
                                <span>{o.policy_detail_status_label()}</span>
                                <select name={f.status}>
                                    <option value="active" selected={form.status != "inactive"}>
                                        {o.policy_detail_status_active()}
                                    </option>
                                    <option value="inactive" selected={form.status == "inactive"}>
                                        {o.policy_detail_status_inactive()}
                                    </option>
                                </select>
                            </label>
                            <label class={Field}>
                                <span>{o.policy_detail_effective_from_label()}</span>
                                <small>{o.policy_detail_effective_from_description()}</small>
                                <input type="datetime-local" name={f.effective_from} value={&form.effective_from}>
                            </label>
                            <label class={Field}>
                                <span>{o.policy_detail_effective_until_label()}</span>
                                <small>{o.policy_detail_effective_until_description()}</small>
                                <input type="datetime-local" name={f.effective_until} value={&form.effective_until}>
                            </label>
                        </div>
                        <button class={Button} type="submit">{o.policy_detail_revise_submit()}</button>
                    </form>
                </section>
            }
            <section class={Card} aria-labelledby="policy-history">
                <h2 class={Heading} id="policy-history">{o.policy_detail_history_title()}</h2>
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{o.policy_detail_history_event()}</th>
                                <th scope="col">{o.policy_detail_status()}</th>
                                <th scope="col">{o.policy_detail_effective_from()}</th>
                                <th scope="col">{o.policy_detail_effective_until()}</th>
                                <th scope="col">{o.policy_detail_history_actor()}</th>
                                <th scope="col">{o.policy_detail_history_recorded_at()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for row in &screen.history {
                                <tr>
                                    <td>{&row.event_type}</td>
                                    <td>{status(o, &row.status).0}</td>
                                    <td>{when(o, here, &row.effective_from)}</td>
                                    <td>{at(row.effective_until.as_deref(), o.policy_detail_open_ended())}</td>
                                    <td>{&row.actor_user_id}</td>
                                    <td>{when(o, here, &row.recorded_at)}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    }
}
