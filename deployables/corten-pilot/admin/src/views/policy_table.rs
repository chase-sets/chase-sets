use corten::prelude::*;

use super::{Badge, keep};
use crate::{
    api::{Payload, Policy},
    app::{Screen, url},
    text::{Msg, Pilot},
};

/// `Parcel: ..; Signature: ..; Insurance: ..`, as admin-web's list writes it: a value threshold is
/// the amount as JavaScript writes the number (`500`, `1000.5`), with no grouping.
fn summary(t: Msg, policy: &Payload) -> String {
    let none = t.common_none();
    let join = |items: Vec<String>| if items.is_empty() { none.to_owned() } else { items.join(", ") };
    let parcel = join(policy.parcel_required_shipping_options.clone());
    let mut signature = policy.signature_required_shipping_options.clone();
    if let Some(value) = policy.signature_required_declared_value_amount {
        signature.push(t.list_signature_value_threshold(value.to_string()).to_string());
    }
    signature.extend(policy.signature_required_physical_flags.iter().cloned());
    let insurance = match policy.insurance_required_declared_value_amount {
        Some(value) => t.list_insurance_value_threshold(value.to_string()).to_string(),
        None => none.to_owned(),
    };
    t.list_requirement_summary(parcel, join(signature), insurance).to_string()
}

/// One of the list's groups (active, drafts, retired), or its empty state.
#[component(css)]
pub fn PolicyTable<'a>(
    t: Msg,
    title: &'a str,
    policies: &'a [&'a Policy],
    empty_title: &'a str,
    empty_description: &'a str,
    screen: &'a Screen,
) -> impl Render {
    html! {
        <section class={Group}>
            <h2 class={Title}>{title}</h2>
            if policies.is_empty() {
                <div class={Empty}>
                    <p class={EmptyTitle}>{empty_title}</p>
                    <p>{empty_description}</p>
                </div>
            } else {
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th scope="col">{t.list_policy()}</th>
                                <th scope="col">{t.list_requirements()}</th>
                                <th scope="col">{t.common_status()}</th>
                                <th scope="col">{t.list_updated()}</th>
                                <th scope="col">{t.list_actions()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for policy in policies {
                                <tr>
                                    <td>
                                        <span class={Name}>{&policy.label}</span>
                                        <span class={Version}>{&policy.policy_version}</span>
                                    </td>
                                    <td>{summary(t, &policy.payload)}</td>
                                    <td><Badge status={&policy.status} /></td>
                                    <td>{&policy.updated_at}</td>
                                    <td>
                                        <a
                                            class={Open}
                                            href={url::Policies {
                                                limit: keep(screen.limit, 50),
                                                offset: keep(screen.offset, 0),
                                                policy: Some(policy.policy_id.clone()),
                                                after_write: None,
                                            }}
                                        >
                                            {t.list_open()}
                                        </a>
                                    </td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
            }
        </section>
    }
}

/// Previous and next pages, when the list has more than one.
#[component(css = PolicyTable)]
pub fn Pagination<'a>(p: Pilot, screen: &'a Screen) -> impl Render {
    let limit = screen.limit.max(1);
    let page = screen.offset / limit + 1;
    let pages = screen.policies.total.div_ceil(limit).max(1);
    let show = screen.policies.total > limit || screen.offset > 0;
    let at = move |page: u32| url::Policies {
        limit: keep(limit, 50),
        offset: keep((page - 1) * limit, 0),
        policy: None,
        after_write: None,
    };
    html! {
        if show {
            <nav class={Pages} aria-label={p.pages_label()}>
                if page > 1 { <a class={Open} href={at(page - 1)} rel="prev">{p.pages_previous()}</a> }
                <span>{p.pages_current(page, pages)}</span>
                if page < pages { <a class={Open} href={at(page + 1)} rel="next">{p.pages_next()}</a> }
            </nav>
        }
    }
}
