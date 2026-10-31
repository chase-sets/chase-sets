//! admin-web's `ScopeSyncBatchPage`: the held-set export, the New batch form, a preview with
//! Confirm and enqueue, a Scrydex count quote with Approve count acquisition, and a batch's
//! progress with its commands. Every command is a plain form, so the page works without
//! JavaScript; on a phone the form's fields stack and each table row is a card.
use corten::prelude::*;

use super::{Tone, TonePill};
use crate::{
    catalog::{
        coverage, scopes,
        sync_batches::{Batch, BatchInput, Preview, Quote, Resolution, Screen, url},
    },
    text::{Cat, Pilot},
};

/// The page. `manage`: the viewer may write (`catalog.manage`), so the forms are offered.
pub fn sync_batch_page<'a>(t: Cat, p: Pilot, screen: &'a Screen, manage: bool) -> impl Render + 'a {
    let back = crate::catalog::url::Scopes::default().href();
    html! {
        <SyncBatchPage>
            <Heading t={t} back={&back} />
            if let Some(error) = &screen.error {
                <Notice tone={Tone::Danger} title={t.ssb_ui_page_batch_command_blocked()} text={error} />
            }
            if manage {
                <HeldSets t={t} resolution={screen.resolution.as_ref()} />
                <NewBatch t={t} form={&screen.form} />
            } else if let Some(resolution) = &screen.resolution {
                <HeldSets t={t} resolution={Some(resolution)} />
            }
            if let Some(preview) = &screen.preview {
                <PreviewPart t={t} p={p} preview={preview} manage={manage} />
            }
            if let Some(quote) = &screen.quote {
                <QuotePart t={t} quote={quote} manage={manage} />
            }
            if let Some(batch) = &screen.batch {
                <BatchPart t={t} batch={batch} manage={manage} />
            }
        </SyncBatchPage>
    }
}

/// The page's frame, with its stylesheet.
#[component(css)]
pub fn SyncBatchPage<C: Render>(children: C) -> impl Render {
    html! { <div class={Page}>{children}</div> }
}

/// The page's title, what it is for, and Back to scopes.
#[component(css = SyncBatchPage)]
fn Heading<'a>(t: Cat, back: &'a str) -> impl Render {
    html! {
        <div class={Header}>
            <div>
                <p class={Eyebrow}>{t.ssb_ui_page_catalog_operations()}</p>
                <h1 class={Title}>{t.ssb_ui_page_title()}</h1>
                <p class={Lead}>{t.ssb_ui_page_description()}</p>
            </div>
            <a class={Link} href={back}>{t.ssb_ui_page_back_to_scopes()}</a>
        </div>
    }
}

/// A banner: its tone, title and text.
#[component(css = SyncBatchPage)]
fn Notice<'a>(tone: Tone, title: &'a str, text: &'a str) -> impl Render {
    let (hue, role) = match tone {
        Tone::Danger => (Danger, "alert"),
        Tone::Warning => (Warning, "status"),
        Tone::Success => (Success, "status"),
        Tone::Info | Tone::Neutral => (Info, "status"),
    };
    html! {
        <div class={(Banner, hue)} role={role}>
            <p class={Strong}>{title}</p>
            <p>{text}</p>
        </div>
    }
}

/// A part of the page with its heading.
#[component(css = SyncBatchPage)]
fn Part<'a, C: Render>(id: &'a str, title: &'a str, children: C) -> impl Render {
    html! {
        <section class={Part} aria-labelledby={id}>
            <h2 class={PartTitle} id={id}>{title}</h2>
            {children}
        </section>
    }
}

/// Named values, a term over its value on a phone and beside it on a wide screen.
#[component(css = SyncBatchPage)]
fn Values<'a>(items: &'a [(String, String)]) -> impl Render {
    html! {
        <dl class={Values}>
            for (key, value) in items {
                <div>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </div>
            }
        </dl>
    }
}

/// A table whose rows are cards on a phone, each cell under its heading (`data-label`).
#[component(css = SyncBatchPage)]
fn Rows<'a, C: Render>(caption: &'a str, head: &'a [&'a str], children: C) -> impl Render {
    html! {
        <div class={Scroll}>
            <table class={Table}>
                <caption class={Caption}>{caption}</caption>
                <thead>
                    <tr>
                        for heading in head {
                            <th scope="col">{*heading}</th>
                        }
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    }
}

/// A labelled input of the batch form.
#[component(css = SyncBatchPage)]
fn Labeled<'a>(label: &'a str, name: FieldName, value: &'a str, kind: &'a str, hint: Option<&'a str>) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <input type={kind} name={name} value={value}>
            if let Some(hint) = hint {
                <span class={Hint}>{hint}</span>
            }
        </label>
    }
}

/// A choice of the batch form.
#[component(css = SyncBatchPage)]
fn Choice<'a>(label: &'a str, name: FieldName, value: &'a str, options: &'a [(&'a str, &'a str)]) -> impl Render {
    html! {
        <label class={Field}>
            <span class={Label}>{label}</span>
            <select name={name}>
                for (option, text) in options {
                    <option value={*option} selected={*option == value}>{*text}</option>
                }
            </select>
        </label>
    }
}

/// Hidden inputs carrying `input`'s selection and budget (and its `intent` and plan, when set).
#[component(css = SyncBatchPage)]
fn Carried<'a>(input: &'a BatchInput) -> impl Render {
    let f = BatchInput::FIELDS;
    let ids = input.selection_mode == "ids";
    let fields = [
        (f.selection_mode, &input.selection_mode),
        (f.max_scopes_per_turn, &input.max_scopes_per_turn),
        (f.default_provider_concurrency, &input.default_provider_concurrency),
        (f.scrydex_concurrency, &input.scrydex_concurrency),
        (f.tcgdex_request_limit, &input.tcgdex_request_limit),
        (f.scrydex_rate_request_limit, &input.scrydex_rate_request_limit),
        (f.scrydex_request_limit, &input.scrydex_request_limit),
        (f.provider_failure_threshold, &input.provider_failure_threshold),
    ];
    html! {
        if !input.intent.is_empty() {
            <input type="hidden" name={f.intent} value={&input.intent}>
        }
        if !input.plan_fingerprint.is_empty() {
            <input type="hidden" name={f.plan_fingerprint} value={&input.plan_fingerprint}>
        }
        if ids {
            <input type="hidden" name={f.scope_record_ids} value={&input.scope_record_ids}>
        } else {
            <input type="hidden" name={f.product_domain} value={&input.product_domain}>
            <input type="hidden" name={f.scope_kind} value={&input.scope_kind}>
            <input type="hidden" name={f.language_code} value={&input.language_code}>
        }
        for (name, value) in &fields {
            <input type="hidden" name={*name} value={*value}>
        }
    }
}

/// From held-set export: the CSV upload, and what it resolved to with Preview resolved sets.
#[component(css = SyncBatchPage)]
fn HeldSets<'a>(t: Cat, resolution: Option<&'a Resolution>) -> impl Render {
    let action = url::HeldSets.href();
    let main = url::SyncBatches::default().href();
    let f = crate::catalog::sync_batches::HeldSetForm::FIELDS;
    html! {
        <Part id="ssb-held-sets" title={t.ssb_ui_held_set_title()}>
            <p class={Muted}>{t.ssb_ui_held_set_description()}</p>
            <form class={Form} method="post" action={&action} enctype="multipart/form-data">
                <label class={Field}>
                    <span class={Label}>{t.ssb_ui_held_set_file()}</span>
                    <input type="file" name={f.file} accept=".csv,text/csv" required>
                    <span class={Hint}>{t.ssb_ui_held_set_file_description()}</span>
                </label>
                <div class={Buttons}>
                    <button type="submit">{t.ssb_ui_held_set_resolve()}</button>
                </div>
            </form>
            if let Some(resolution) = resolution {
                <Resolved t={t} resolution={resolution} action={&main} />
            }
        </Part>
    }
}

/// What a held-set export resolved to.
#[component(css = SyncBatchPage)]
fn Resolved<'a>(t: Cat, resolution: &'a Resolution, action: &'a str) -> impl Render {
    let totals = &resolution.totals;
    let summary = t.ssb_ui_held_set_summary(totals.resolved_pairs, totals.unresolved_pairs, totals.rows).to_string();
    let tone = if resolution.unresolved.is_empty() { Tone::Success } else { Tone::Warning };
    let inbox = coverage::url::Inbox { query: Default::default() }.href();
    let resolved_head =
        [t.ssb_ui_held_set_pair(), t.ssb_ui_page_scope_record(), t.ssb_ui_page_product_domain(), t.ssb_ui_held_set_rows()];
    let unresolved_head = [t.ssb_ui_held_set_pair(), t.ssb_ui_held_set_reason(), t.ssb_ui_held_set_rows(), ""];
    let preview = resolution.preview_input();
    let f = BatchInput::FIELDS;
    html! {
        <Notice tone={tone} title={t.ssb_ui_held_set_summary_title()} text={&summary} />
        if resolution.resolved.is_empty() {
            <p class={Muted}>{t.ssb_ui_held_set_none_resolved()}</p>
            <a class={Link} href={&inbox}>{t.ssb_ui_held_set_open_inbox()}</a>
        } else {
            <Rows caption={t.ssb_ui_held_set_resolved_caption()} head={&resolved_head}>
                for row in &resolution.resolved {
                    <tr>
                        <td data-label={resolved_head[0]}>
                            {t.ssb_ui_held_set_pair_value(&row.product_line, &row.set_name).to_string()}
                        </td>
                        <td data-label={resolved_head[1]} class={Code}>{&row.scope_record_id}</td>
                        <td data-label={resolved_head[2]}>
                            {t.ssb_ui_held_set_domain_value(&row.product_domain, &row.scope_kind).to_string()}
                        </td>
                        <td data-label={resolved_head[3]}>{row.row_count}</td>
                    </tr>
                }
            </Rows>
        }
        if !resolution.unresolved.is_empty() {
            <Rows caption={t.ssb_ui_held_set_unresolved_caption()} head={&unresolved_head}>
                for row in &resolution.unresolved {
                    let query = coverage::url::InboxQuery { product_domain: row.product_domain.clone() };
                    let href = coverage::url::Inbox { query }.href();
                    <tr>
                        <td data-label={unresolved_head[0]}>
                            {t.ssb_ui_held_set_pair_value(&row.product_line, &row.set_name).to_string()}
                        </td>
                        <td data-label={unresolved_head[1]}><TonePill text={&row.reason} tone={Tone::Warning} /></td>
                        <td data-label={unresolved_head[2]}>{row.row_count}</td>
                        <td><a class={Link} href={&href}>{t.ssb_ui_held_set_open_inbox()}</a></td>
                    </tr>
                }
            </Rows>
        }
        if !resolution.resolved.is_empty() {
            <form class={Inline} method="post" action={action}>
                <Carried input={&preview} />
                <button type="submit" name={f.intent} value="preview">{t.ssb_ui_held_set_preview()}</button>
                <Labeled label={t.ssb_count_cap()} name={f.count_cap} value="0" kind="number" hint={None} />
                <button type="submit" class={Secondary} name={f.intent} value="count-quote">{t.ssb_count_quote()}</button>
            </form>
        }
    }
}

/// New batch: the selection, the budget, Preview batch, and the count quote's cap.
#[component(css = SyncBatchPage)]
fn NewBatch<'a>(t: Cat, form: &'a BatchInput) -> impl Render {
    let f = BatchInput::FIELDS;
    let action = url::SyncBatches::default().href();
    let modes = [("matching-scope", t.ssb_ui_page_matching_scope()), ("ids", t.ssb_ui_page_explicit_scope_record_ids())];
    let domains: Vec<(&str, &str)> = scopes::product_domains().iter().map(|d| (d.as_str(), d.as_str())).collect();
    let kinds = [("product-line", "product-line"), ("series", "series"), ("expansion", "expansion"), ("set", "set")];
    html! {
        <Part id="ssb-new-batch" title={t.ssb_ui_page_new_batch()}>
            <form class={Form} method="post" action={&action}>
                <div class={Grid}>
                    <Choice
                        label={t.ssb_ui_page_selection()}
                        name={f.selection_mode}
                        value={&form.selection_mode}
                        options={&modes}
                    />
                    <Choice
                        label={t.ssb_ui_page_product_domain()}
                        name={f.product_domain}
                        value={&form.product_domain}
                        options={&domains}
                    />
                    <Choice label={t.ssb_ui_page_scope_kind()} name={f.scope_kind} value={&form.scope_kind} options={&kinds} />
                    <Labeled
                        label={t.ssb_ui_page_language()}
                        name={f.language_code}
                        value={&form.language_code}
                        kind="text"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_scope_record_ids()}
                        name={f.scope_record_ids}
                        value={&form.scope_record_ids}
                        kind="text"
                        hint={Some(t.ssb_ui_page_scope_record_ids_description())}
                    />
                </div>
                <div class={Grid}>
                    <Labeled
                        label={t.ssb_ui_page_scopes_per_worker_turn()}
                        name={f.max_scopes_per_turn}
                        value={&form.max_scopes_per_turn}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_default_provider_concurrency()}
                        name={f.default_provider_concurrency}
                        value={&form.default_provider_concurrency}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_scrydex_concurrency()}
                        name={f.scrydex_concurrency}
                        value={&form.scrydex_concurrency}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_tcgdex_request_limit()}
                        name={f.tcgdex_request_limit}
                        value={&form.tcgdex_request_limit}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_scrydex_rate_request_limit()}
                        name={f.scrydex_rate_request_limit}
                        value={&form.scrydex_rate_request_limit}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_scrydex_credit_limit()}
                        name={f.scrydex_request_limit}
                        value={&form.scrydex_request_limit}
                        kind="number"
                        hint={None}
                    />
                    <Labeled
                        label={t.ssb_ui_page_circuit_breaker_failures()}
                        name={f.provider_failure_threshold}
                        value={&form.provider_failure_threshold}
                        kind="number"
                        hint={None}
                    />
                </div>
                <div class={Inline}>
                    <button type="submit" name={f.intent} value="preview">{t.ssb_ui_page_preview_batch()}</button>
                    <Labeled label={t.ssb_count_cap()} name={f.count_cap} value={&form.count_cap} kind="number" hint={None} />
                    <button type="submit" class={Secondary} name={f.intent} value="count-quote">{t.ssb_count_quote()}</button>
                </div>
            </form>
        </Part>
    }
}

/// A preview: whether the batch is ready, its plan, its providers, a sample of its scopes, its
/// blockers, and Confirm and enqueue when it may be.
#[component(css = SyncBatchPage)]
fn PreviewPart<'a>(t: Cat, p: Pilot, preview: &'a Preview, manage: bool) -> impl Render {
    let c = &preview.counts;
    let summary = t.ssb_ui_page_preview_summary(c.ready_scopes, c.blocked_scopes, c.provider_units).to_string();
    let (tone, title) = if preview.confirm_allowed {
        (Tone::Success, t.ssb_ui_page_batch_ready())
    } else {
        (Tone::Warning, t.ssb_ui_page_batch_needs_attention())
    };
    let plan = [
        (t.ssb_ui_page_plan_fingerprint().to_owned(), preview.plan_fingerprint.clone()),
        (t.ssb_ui_page_resolved_at().to_owned(), preview.resolved_at.clone()),
        (t.ssb_ui_page_scope_count().to_owned(), c.scopes.to_string()),
    ];
    let shown = |value: Option<&serde_json::Value>| match value {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => t.ssb_ui_page_unavailable().to_owned(),
    };
    let providers: Vec<(String, String)> = preview
        .provider_unit_totals
        .iter()
        .map(|(key, units)| {
            let units = units.as_i64().unwrap_or(0);
            let requests = shown(preview.provider_request_estimates.get(key));
            (t.ssb_ui_page_provider_units_and_requests(key).to_string(), format!("{units} / {requests}"))
        })
        .collect();
    let head = [
        t.ssb_ui_page_scope_record(),
        t.ssb_ui_page_providers(),
        t.ssb_ui_page_estimated_requests(),
        t.ssb_ui_page_evidence_versions(),
        t.ssb_ui_page_blockers(),
    ];
    let confirm = preview.confirm_input();
    let action = url::SyncBatches::default().href();
    let _ = p;
    html! {
        <Part id="ssb-preview" title={t.ssb_ui_page_preview()}>
            <Notice tone={tone} title={title} text={&summary} />
            <Values items={&plan} />
            if !providers.is_empty() {
                <Values items={&providers} />
            }
            <Rows caption={t.ssb_ui_page_preview_sample_caption()} head={&head}>
                for sample in &preview.samples {
                    let mappings = sample.mapping_versions.iter().map(|m| format!("{}@{}", m.mapping_id, m.version)).collect::<Vec<_>>().join(", ");
                    let profiles = sample
                        .profile_versions
                        .iter()
                        .map(|v| format!("{}/{}@{}", v.provider_key, v.profile_key, v.profile_version))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let mappings = if mappings.is_empty() { t.ssb_ui_page_no_mapping().to_owned() } else { mappings };
                    let profiles = if profiles.is_empty() { t.ssb_ui_page_no_profile().to_owned() } else { profiles };
                    let requests = sample.estimated_request_count.map_or_else(|| t.ssb_ui_page_unavailable().to_owned(), |n| n.to_string());
                    <tr>
                        <td data-label={head[0]} class={Code}>{&sample.scope_record_id}</td>
                        <td data-label={head[1]}>{sample.provider_keys.join(", ")}</td>
                        <td data-label={head[2]}>{&requests}</td>
                        <td data-label={head[3]} class={Code}>{&mappings}" \u{b7} "{&profiles}</td>
                        <td data-label={head[4]}>{sample.blocker_count}</td>
                    </tr>
                }
            </Rows>
            for blocker in &preview.blockers {
                <Notice tone={Tone::Warning} title={&blocker.code} text={&blocker.message} />
            }
            if preview.confirm_allowed && manage {
                <form class={Inline} method="post" action={&action}>
                    <Carried input={&confirm} />
                    <button type="submit">{t.ssb_ui_page_confirm_and_enqueue()}</button>
                </form>
            }
        </Part>
    }
}

/// A count quote: what it would buy, its retained address, and Approve count acquisition.
#[component(css = SyncBatchPage)]
fn QuotePart<'a>(t: Cat, quote: &'a Quote, manage: bool) -> impl Render {
    let tone = match quote.state.as_str() {
        "complete" => Tone::Success,
        "uncertain" | "failed" => Tone::Danger,
        _ => Tone::Info,
    };
    let retained = url::SyncBatches::quote(&quote.quote_id).href();
    let items = [
        (t.ssb_count_planned().to_owned(), quote.planned_credits.to_string()),
        (t.ssb_count_cap().to_owned(), quote.cap.to_string()),
        (t.ssb_count_cards().to_owned(), quote.missing("cards").to_string()),
        (t.ssb_count_sealed().to_owned(), quote.missing("sealed").to_string()),
        (t.ssb_count_reused().to_owned(), quote.reused().to_string()),
        (t.ssb_count_expires().to_owned(), quote.expires_at.clone()),
    ];
    let state_tone = if quote.state == "complete" { Tone::Success } else { Tone::Neutral };
    let head = [t.ssb_count_kind(), t.ssb_count_cost(), t.ssb_count_observed()];
    let f = BatchInput::FIELDS;
    let action = url::SyncBatches::default().href();
    let pressable = quote.approvable();
    html! {
        <Part id="ssb-count" title={t.ssb_count_title()}>
            <Notice tone={tone} title={t.ssb_count_separate()} text={t.ssb_count_no_batch()} />
            <a class={Link} href={&retained}>{t.ssb_count_retained()}</a>
            <Values items={&items} />
            <p class={Muted}>
                {t.ssb_count_state()}": "
                <TonePill text={&quote.state} tone={state_tone} />
            </p>
            if !quote.targets.is_empty() {
                <Rows caption={t.ssb_count_title()} head={&head}>
                    for target in &quote.targets {
                        let kind = format!("{} / {}", target.scope_record_id, target.query.kind);
                        let cost = if target.source.is_some() { "0" } else { "1" };
                        let observed = target.source.as_ref().map_or(t.ssb_count_unobserved(), |s| s.observed_at.as_str());
                        <tr>
                            <td data-label={head[0]} class={Code}>{&kind}</td>
                            <td data-label={head[1]}>{cost}</td>
                            <td data-label={head[2]}>{observed}</td>
                        </tr>
                    }
                </Rows>
            }
            if quote.offered() && manage {
                <form class={Inline} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value="count-acquire">
                    <input type="hidden" name={f.quote_id} value={&quote.quote_id}>
                    <input type="hidden" name={f.count_fingerprint} value={&quote.fingerprint}>
                    <button type="submit" disabled={!pressable}>{t.ssb_count_approve()}</button>
                </form>
            }
        </Part>
    }
}

fn unit_tone(state: &str) -> Tone {
    match state {
        "completed" => Tone::Success,
        "failed" => Tone::Danger,
        _ => Tone::Neutral,
    }
}

/// A batch's progress: its status and counts, Cancel or Resume, its notices, and its units with
/// Retry unit for a failed or cancelled one.
#[component(css = SyncBatchPage)]
fn BatchPart<'a>(t: Cat, batch: &'a Batch, manage: bool) -> impl Render {
    let c = &batch.counts;
    let summary = t.ssb_ui_page_batch_progress_summary(c.completed, c.failed, c.running, c.queued).to_string();
    let f = BatchInput::FIELDS;
    let action = url::SyncBatches::default().href();
    let command = match batch.status.as_str() {
        "queued" | "running" => Some(("cancel", t.ssb_ui_page_cancel_batch(), true)),
        "cancelled" => Some(("resume", t.ssb_ui_page_resume_batch(), false)),
        _ => None,
    };
    let circuit = t.ssb_ui_page_provider_circuit_open_description(batch.circuit_open_providers.join(", ")).to_string();
    let head = [
        t.ssb_ui_page_scope_record(),
        t.ssb_ui_page_providers(),
        t.ssb_ui_page_state(),
        t.ssb_ui_page_attempts(),
        t.ssb_ui_page_recovery(),
    ];
    html! {
        <Part id="ssb-batch" title={t.ssb_ui_page_batch_progress()}>
            <p class={Status}>
                <TonePill text={&batch.status} tone={unit_tone(&batch.status)} />
                <span>{&summary}</span>
            </p>
            if let Some((intent, label, danger)) = command.filter(|_| manage) {
                <form class={Inline} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value={intent}>
                    <input type="hidden" name={f.batch_id} value={&batch.batch_id}>
                    if danger {
                        <button type="submit" class={DangerButton}>{label}</button>
                    } else {
                        <button type="submit">{label}</button>
                    }
                </form>
            }
            if !batch.circuit_open_providers.is_empty() {
                <Notice tone={Tone::Warning} title={t.ssb_ui_page_provider_circuit_open()} text={&circuit} />
            }
            if batch.fast_no_op {
                <Notice
                    tone={Tone::Info}
                    title={t.ssb_ui_page_already_settled()}
                    text={t.ssb_ui_page_already_settled_description()}
                />
            }
            <Rows caption={t.ssb_ui_page_units_caption()} head={&head}>
                for unit in &batch.units {
                    let retry = manage && matches!(unit.state.as_str(), "failed" | "cancelled");
                    <tr>
                        <td data-label={head[0]} class={Code}>{&unit.scope_record_id}</td>
                        <td data-label={head[1]}>{unit.provider_keys.join(", ")}</td>
                        <td data-label={head[2]}><TonePill text={&unit.state} tone={unit_tone(&unit.state)} /></td>
                        <td data-label={head[3]}>{unit.attempt_count}</td>
                        <td data-label={head[4]}>
                            if retry {
                                <form method="post" action={&action}>
                                    <input type="hidden" name={f.intent} value="retry-unit">
                                    <input type="hidden" name={f.batch_id} value={&batch.batch_id}>
                                    <input type="hidden" name={f.scope_record_id} value={&unit.scope_record_id}>
                                    <button type="submit" class={(Small, Secondary)}>{t.ssb_ui_page_retry_unit()}</button>
                                </form>
                            } else {
                                <span class={Muted}>"\u{2014}"</span>
                            }
                        </td>
                    </tr>
                }
            </Rows>
        </Part>
    }
}
