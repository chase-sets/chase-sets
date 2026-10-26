//! The Catalog attention queue (admin-web's `CatalogAttentionQueuePanel`): the count, the four
//! metrics, and a row per item with its one-click commands and its Review, which opens the item's
//! sheet (drawn by the server: `AttentionSheet`). A row's Review is a submit button of one shared
//! form, so each row carries only its item's key. On a phone the rows stack, each cell under its
//! heading.
use corten::{
    prelude::*,
    view::{AttrValue, Id},
};

use super::{Dialog, Empty, KeyValues, Tone, TonePill, ids};
use crate::{
    catalog::{
        api::{AttentionItem, AttentionKind, AttentionQueue, Resolution, ResolutionMode, Severity},
        attention::{Params, ParkInput, Parked, RestoreInput, shown, url as at},
        scopes::url::{AttentionDone, ScopeQuery},
    },
    text::Cat,
    views::{Draft, admin_web},
};

fn severity(t: Cat, severity: Severity) -> (&'static str, Tone) {
    match severity {
        Severity::Critical => (t.attention_severity_critical(), Tone::Danger),
        Severity::Warning => (t.attention_severity_warning(), Tone::Warning),
        Severity::Info => (t.attention_severity_info(), Tone::Info),
    }
}

fn kind(t: Cat, kind: AttentionKind) -> &'static str {
    match kind {
        AttentionKind::UnmappedScope => t.attention_kind_unmapped_scope(),
        AttentionKind::MergeConflict => t.attention_kind_merge_conflict(),
        AttentionKind::ProviderHealth => t.attention_kind_provider_health(),
        AttentionKind::ImportJob => t.attention_kind_import_job(),
        AttentionKind::AliasCandidate => t.attention_kind_alias_candidate(),
        AttentionKind::StaleScopeSync => t.attention_kind_stale_scope_sync(),
    }
}

/// The hidden fields that keep the list's filters on a form the panel posts or opens.
#[component(css = AttentionPanel)]
fn Kept<'a>(query: &'a ScopeQuery) -> impl Render {
    let kept = query.kept();
    html! {
        for (name, value) in &kept {
            <input type="hidden" name={*name} value={value.as_str()}>
        }
    }
}

/// The queue, or the banner that says it could not be read.
#[component(css)]
pub fn AttentionPanel<'a>(t: Cat, query: &'a ScopeQuery, queue: Option<&'a AttentionQueue>, manage: bool) -> impl Render {
    html! {
        match queue {
            None => {
                <div class={Unavailable} role="status">
                    <p class={BannerTitle}>{t.attention_unavailable_title()}</p>
                    <p>{t.attention_unavailable_description()}</p>
                </div>
            }
            Some(queue) => {
                let c = &queue.counts;
                let tone = if c.total == 0 {
                    Tone::Success
                } else if c.by_severity.critical > 0 {
                    Tone::Danger
                } else if c.by_severity.warning > 0 {
                    Tone::Warning
                } else {
                    Tone::Info
                };
                let count = t.attention_status_count(c.total).to_string();
                let critical = c.by_severity.critical.to_string();
                let warning = c.by_severity.warning.to_string();
                let info = c.by_severity.info.to_string();
                let as_of = t.attention_metric_freshness_value(&queue.generated_at).to_string();
                let review = at::AttentionReview::default().href();
                let head = [t.attention_table_item(), t.attention_table_scope(), t.attention_table_actions()];
                <section class={Panel} aria-labelledby="attention-title" data-attention-queue>
                    <header class={Head}>
                        <div>
                            <h2 class={Title} id="attention-title">{t.attention_title()}</h2>
                            <p class={Description}>{t.attention_description()}</p>
                        </div>
                        <TonePill text={&count} tone={tone} />
                    </header>
                    <dl class={Metrics}>
                        <Metric
                            label={t.attention_metric_critical()}
                            value={&critical}
                            trend={t.attention_metric_critical_trend()}
                        />
                        <Metric
                            label={t.attention_metric_warning()}
                            value={&warning}
                            trend={t.attention_metric_warning_trend()}
                        />
                        <Metric label={t.attention_metric_info()} value={&info} trend={t.attention_metric_info_trend()} />
                        <Metric
                            label={t.attention_metric_freshness()}
                            value={&as_of}
                            trend={t.attention_metric_freshness_trend()}
                        />
                    </dl>
                    if queue.items.is_empty() {
                        <Empty title={t.attention_empty_title()} description={t.attention_empty_description()} />
                    } else {
                        <form id={ids::ATTENTION_OPEN} method="get" action={&review} data-patch>
                            <Kept query={query} />
                        </form>
                        <div class={Scroll}>
                            <table class={Table}>
                                <caption class={Caption}>{t.attention_title()}</caption>
                                <thead>
                                    <tr>
                                        for heading in &head {
                                            <th scope="col">{*heading}</th>
                                        }
                                    </tr>
                                </thead>
                                <tbody>
                                    for item in &queue.items {
                                        <AttentionRow t={t} query={query} item={item} manage={manage} />
                                    }
                                </tbody>
                            </table>
                        </div>
                    }
                </section>
            }
        }
    }
}

#[component(css = AttentionPanel)]
fn Metric<'a>(label: &'a str, value: &'a str, trend: &'a str) -> impl Render {
    html! {
        <div class={Metric}>
            <dt>{label}</dt>
            <dd class={Value}>{value}</dd>
            <dd class={Trend}>{trend}</dd>
        </div>
    }
}

/// An item: its title, detail and badges; its provider and unit; its commands and Review.
#[component(css = AttentionPanel)]
fn AttentionRow<'a>(t: Cat, query: &'a ScopeQuery, item: &'a AttentionItem, manage: bool) -> impl Render {
    let (title, detail, none) = (Params::title(item), Params::detail(item), Params::none());
    let (severity, tone) = severity(t, item.severity);
    let commands: Vec<&Resolution> = std::iter::once(&item.resolution)
        .filter(|r| r.mode == ResolutionMode::Command)
        .chain(&item.secondary_resolutions)
        .collect();
    html! {
        <tr>
            <td>
                <div class={Item}>
                    <strong class={ItemTitle}>{shown(t, &item.title_key, &title)}</strong>
                    <span class={Muted}>{shown(t, &item.detail_key, &detail)}</span>
                    <span class={Badges}>
                        <TonePill text={severity} tone={tone} />
                        <TonePill text={kind(t, item.kind)} tone={Tone::Neutral} />
                    </span>
                </div>
            </td>
            <td data-label={t.attention_table_scope()}>
                <span class={Scope}>
                    <span>{item.provider_key.as_deref().unwrap_or(t.attention_scope_platform())}</span>
                    if let Some(unit) = &item.unit_key {
                        <span class={Muted}>{unit}</span>
                    }
                </span>
            </td>
            <td data-label={t.attention_table_actions()}>
                <div class={Actions}>
                    for resolution in commands {
                        <CommandButton t={t} query={query} resolution={resolution} manage={manage} />
                    }
                    <button
                        type="submit"
                        class={(Small, Secondary)}
                        form={ids::ATTENTION_OPEN}
                        name="item"
                        value={&item.item_key}
                    >
                        {shown(t, &item.resolution.label_key, &none)}
                    </button>
                </div>
            </td>
        </tr>
    }
}

/// A one-click resolution (an alias candidate's Accept or Reject): its fields, and the reason a
/// reject needs (the button's label, as admin-web sends it). Any other intent is not offered.
#[component(css = AttentionPanel)]
fn CommandButton<'a>(t: Cat, query: &'a ScopeQuery, resolution: &'a Resolution, manage: bool) -> impl Render {
    let action = match resolution.intent.as_str() {
        "alias.accept" => Some(at::AliasAccept { query: query.clone() }.href()),
        "alias.reject" => Some(at::AliasReject { query: query.clone() }.href()),
        _ => None,
    };
    let none = Params::none();
    let label = shown(t, &resolution.label_key, &none).to_string();
    let hashes = resolution.fields.get("aliasHashes").map(String::as_str).unwrap_or("");
    html! {
        if let Some(action) = &action {
            <form method="post" action={action} data-patch>
                <input type="hidden" name="alias_hashes" value={hashes}>
                if resolution.requires_reason {
                    <input type="hidden" name="reason" value={&label}>
                }
                <button type="submit" class={Small} disabled={!manage}>{&label}</button>
            </form>
        }
    }
}

/// An item's sheet (admin-web's `AttentionItemDrawer`): its evidence, the page that resolves it
/// (admin-web's), and the two park forms. Drawn open when the server is asked for it; the empty
/// dialog when the item is not in the queue (any more).
#[component(css = AttentionPanel)]
pub fn AttentionSheet<'a>(
    t: Cat,
    query: &'a ScopeQuery,
    item: Option<&'a AttentionItem>,
    parked: Option<&'a Parked>,
    manage: bool,
) -> impl Patch {
    html! {
        match item {
            None => <dialog id={ids::ATTENTION_DIALOG}></dialog>,
            Some(item) => {
                let params = Params::title(item);
                let title = shown(t, &item.title_key, &params).to_string();
                let evidence = evidence(t, item);
                let destination = item.resolution.href.as_deref().and_then(admin_web).map(|u| u.to_string());
                let blank = || Draft::new(ParkInput::of(item));
                let dismiss = match parked {
                    Some(Parked::Dismiss(draft)) => draft.clone(),
                    _ => blank(),
                };
                let defer = match parked {
                    Some(Parked::Defer(draft)) => draft.clone(),
                    _ => blank(),
                };
                <Dialog
                    id={ids::ATTENTION_DIALOG}
                    title={&title}
                    description={Some(t.attention_drawer_description())}
                    open
                    close={t.attention_drawer_close()}
                >
                    <div class={Sheet}>
                        <KeyValues items={&evidence} />
                        match &destination {
                            Some(href) => <a class={Link} href={href} data-attention-destination>{t.attention_action_open_destination()}</a>,
                            None => <p class={Muted}>{t.attention_resolution_unavailable()}</p>,
                        }
                        <ParkForm
                            t={t}
                            id={ids::ATTENTION_DISMISS}
                            action={&at::AttentionDismiss { query: query.clone() }.href()}
                            submit={t.attention_action_dismiss()}
                            form={&dismiss}
                            manage={manage}
                        />
                        <ParkForm
                            t={t}
                            id={ids::ATTENTION_DEFER}
                            action={&at::AttentionDefer { query: query.clone() }.href()}
                            submit={t.attention_action_defer()}
                            form={&defer}
                            manage={manage}
                        />
                    </div>
                </Dialog>
            }
        }
    }
}

/// An item's evidence in its sheet: its kind, severity and age, where it is, and its fields.
fn evidence(t: Cat, item: &AttentionItem) -> Vec<(&str, String)> {
    let (severity, _) = severity(t, item.severity);
    let mut evidence: Vec<(&str, String)> = vec![
        (t.attention_drawer_kind(), kind(t, item.kind).to_owned()),
        (t.attention_drawer_severity(), severity.to_owned()),
        (t.attention_drawer_observed_at(), item.observed_at.clone()),
    ];
    if let Some(provider) = &item.provider_key {
        evidence.push((t.attention_drawer_provider(), provider.clone()));
    }
    if let Some(unit) = &item.unit_key {
        evidence.push((t.attention_drawer_unit(), unit.clone()));
    }
    evidence.extend(item.resolution.fields.iter().map(|(k, v)| (k.as_str(), v.clone())));
    evidence
}

/// A park form: the item, its kind, and the reason the operator gives.
#[component(css = AttentionPanel)]
pub fn ParkForm<'a, I: Id + AttrValue + Copy>(
    t: Cat,
    id: I,
    action: &'a str,
    submit: &'a str,
    form: &'a Draft<ParkInput>,
    manage: bool,
) -> impl Patch {
    let f = ParkInput::FIELDS;
    let (i, e) = (&form.input, form.errors.within(id));
    html! {
        <form class={Park} id={id} method="post" action={action} data-patch>
            {form.errors.form_message()}
            <input type="hidden" name={f.item_key} value={&i.item_key}>
            <input type="hidden" name={f.kind} value={&i.kind}>
            <div class={Reason}>
                <label class={Reason}>
                    <span class={Label}>{t.attention_park_reason()}</span>
                    <input type="text" name={f.reason} value={&i.reason} required disabled={!manage} {..e.aria(f.reason)}>
                </label>
                {e.message(f.reason)}
            </div>
            <button type="submit" class={(Small, Secondary)} disabled={!manage}>{submit}</button>
        </form>
    }
}

/// The park form that came back, refused: drawn in place of the one posted.
pub fn park_form<'a>(t: Cat, query: &'a ScopeQuery, parked: &'a Parked, manage: bool) -> impl Patch + 'a {
    html! {
        match parked {
            Parked::Dismiss(draft) => {
                <ParkForm
                    t={t}
                    id={ids::ATTENTION_DISMISS}
                    action={&at::AttentionDismiss { query: query.clone() }.href()}
                    submit={t.attention_action_dismiss()}
                    form={draft}
                    manage={manage}
                />
            }
            Parked::Defer(draft) => {
                <ParkForm
                    t={t}
                    id={ids::ATTENTION_DEFER}
                    action={&at::AttentionDefer { query: query.clone() }.href()}
                    submit={t.attention_action_defer()}
                    form={draft}
                    manage={manage}
                />
            }
        }
    }
}

/// admin-web's command banner, after a queue command: queued (with Restore, after a park) or failed.
#[component(css = AttentionPanel)]
pub fn AttentionBanner<'a>(
    t: Cat,
    query: &'a ScopeQuery,
    done: AttentionDone,
    parked: Option<&'a str>,
    manage: bool,
) -> impl Render {
    let f = RestoreInput::FIELDS;
    let restore = at::AttentionRestore { query: query.clone() }.href();
    html! {
        match done {
            AttentionDone::Queued => {
                <div class={(Banner, Done)} role="status">
                    <div>
                        <p class={BannerTitle}>{t.feedback_queued_title()}</p>
                        <p>{t.feedback_queued_description()}</p>
                    </div>
                    if let Some(key) = parked {
                        <form method="post" action={&restore} data-patch>
                            <input type="hidden" name={f.item_key} value={key}>
                            <button type="submit" class={(Small, Secondary)} disabled={!manage}>
                                {t.attention_action_restore()}
                            </button>
                        </form>
                    }
                </div>
            }
            AttentionDone::Failed => {
                <div class={(Banner, Failed)} role="alert">
                    <div>
                        <p class={BannerTitle}>{t.feedback_error_title()}</p>
                        <p>{t.feedback_failed()}</p>
                    </div>
                </div>
            }
        }
    }
}
