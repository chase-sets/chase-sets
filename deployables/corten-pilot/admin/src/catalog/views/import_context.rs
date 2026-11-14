//! The daily workbench's import context bar (admin-web's `CatalogImportContextBar`), above the
//! steps: a disclosure, open until a scope is chosen and then one summary line, holding the context
//! form and the source options panel.
//!
//! The form is a `GET` of the workbench: Select source scope sends the provider, the unit, the
//! scope selects and the profile version, so it works without JavaScript. With it, changing a
//! select clears what depends on it and sends the form at once, as admin-web's selects do: a new
//! provider clears the unit, the profile version and the scope; a scope level fills in the parents
//! its option names and clears the levels below. A level's name rides in a hidden field the script
//! fills from its select as the form is sent; without the script that field is not sent, so a
//! changed level never goes with the old level's name.
//!
//! The source options' Reload, Force refresh and Refresh all are forms that post to the pilot,
//! which reads the options with that intent and lands back on the working set without it.
use corten::prelude::*;
use platform::ui::{
    accordion::Accordion,
    button::{Button, ButtonSize, ButtonVariant},
    input::Input,
    select::Select,
};

use super::integrations_page::Pill;
use crate::{
    catalog::{
        daily::{self, OptionsInput, RouteContext, at},
        import_context::{self, GuidedField, ProviderScope, SourceOptions},
    },
    text::Cat,
};

fn options_status_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "degraded" => "warning",
        "blocked" => "danger",
        _ => "neutral",
    }
}

fn page_state_tone(state: &str) -> &'static str {
    match state {
        "live" => "success",
        "cached" => "info",
        "stale" => "warning",
        "unavailable" | "rollout-blocked" => "danger",
        _ => "neutral",
    }
}

fn options_status_label(t: Cat, status: &str) -> &'static str {
    match status {
        "ready" => t.wb_options_status_ready(),
        "degraded" => t.wb_options_status_degraded(),
        "blocked" => t.wb_options_status_blocked(),
        _ => t.wb_options_status_unavailable(),
    }
}

fn page_state_label(t: Cat, state: &str) -> &'static str {
    match state {
        "live" => t.wb_options_state_live(),
        "cached" => t.wb_options_state_cached(),
        "stale" => t.wb_options_state_stale(),
        "rollout-blocked" => t.wb_options_state_rollout_blocked(),
        "not-requested" => t.wb_options_state_not_requested(),
        _ => t.wb_options_state_unavailable(),
    }
}

/// The bar: the summary line (or the step's title), then the form and the options panel. The line
/// and whether the scope is free text are the surface's (`skeleton`), as admin-web's bar takes
/// them; the selects and the panel are the populated options when they read (`options`).
#[component(css, js)]
pub fn ImportContext<'a>(
    t: Cat,
    route: &'a RouteContext,
    providers: &'a ProviderScope,
    skeleton: &'a SourceOptions,
    options: &'a SourceOptions,
    context: &'a str,
) -> impl Render {
    let import_scope = route.import_scope.as_deref().unwrap_or("");
    let selected_provider = route
        .provider_key
        .as_deref()
        .and_then(|key| providers.providers.iter().find(|p| p.provider_key == key))
        .or(providers.providers.first());
    let provider_key = route.provider_key.as_deref().or(selected_provider.map(|p| p.provider_key.as_str())).unwrap_or("");
    let units = selected_provider.map(|p| p.units.as_slice()).unwrap_or_default();
    let unit_key = route.unit_key.as_deref().or(units.first().map(|u| u.unit_key.as_str())).unwrap_or("");
    let selected_unit = units.iter().find(|u| Some(u.unit_key.as_str()) == route.unit_key.as_deref());
    let profile = route
        .profile_version
        .clone()
        .or_else(|| selected_unit.and_then(|u| u.active_profile.as_ref()).map(|p| p.profile_version.clone()))
        .unwrap_or_default();
    let summary = skeleton.context_summary.as_deref().filter(|line| !line.is_empty());
    let fields = if options.guided_fields.is_empty() { &skeleton.guided_fields } else { &options.guided_fields };
    let clears_provider = ["unitKey", "profileVersion", "importScope"]
        .into_iter()
        .chain(import_context::SCOPE_FIELDS)
        .collect::<Vec<_>>()
        .join(" ");
    let clears_unit =
        ["profileVersion", "importScope"].into_iter().chain(import_context::SCOPE_FIELDS).collect::<Vec<_>>().join(" ");
    let action = daily::url::Daily.href().to_string();
    let refresh = at(daily::url::SourceOptions.href().as_str(), context);
    html! {
        <details class={(Accordion {}, Bar)} open={summary.is_none()} data-catalog-import-context-bar="true">
            <summary>
                <span class={Head}>
                    <span class={Title}>{t.wb_ctx_step_title()}</span>
                    match summary {
                        Some(line) => { <span class={Line}>{t.wb_ctx_step_summary(line).to_string()}</span> }
                        None => { <span class={Line}>{t.wb_ctx_step_description()}</span> }
                    }
                </span>
            </summary>
            <div class={Body}>
                <form method="get" action={&action} class={Form} on:change={js::changed(event)} on:submit={js::submitted(event)}>
                    <div class={Grid}>
                        <label class={Field}>
                            <span class={Label}>{t.wb_ctx_provider()}</span>
                            <select name="providerKey" class={Select {}} required data-clears={&clears_provider}>
                                for provider in &providers.providers {
                                    <option value={&provider.provider_key} selected={provider.provider_key == provider_key}>
                                        {&provider.display_name}
                                    </option>
                                }
                            </select>
                        </label>
                        <label class={Field}>
                            <span class={Label}>{t.wb_ctx_unit()}</span>
                            <select name="unitKey" class={Select {}} required data-clears={&clears_unit}>
                                for unit in units {
                                    <option value={&unit.unit_key} selected={unit.unit_key == unit_key}>{&unit.unit_key}</option>
                                }
                            </select>
                        </label>
                        if skeleton.free_text_applicable {
                            <label class={Field}>
                                <span class={Label}>{t.wb_ctx_scope()}</span>
                                <input class={Input {}} name="importScope" value={import_scope}>
                            </label>
                        }
                    </div>
                    if !fields.is_empty() {
                        <fieldset class={Scope}>
                            <legend>{t.wb_options_scope_legend()}</legend>
                            <p class={Muted}>{t.wb_options_scope_description()}</p>
                            <div class={Grid}>
                                for (index, field) in fields.iter().enumerate() {
                                    <ScopeSelect t={t} field={field} index={index} />
                                }
                            </div>
                        </fieldset>
                    }
                    <div class={Apply}>
                        <label class={Field}>
                            <span class={Label}>{t.wb_ctx_profile_version()}</span>
                            <input class={Input {}} name="profileVersion" value={&profile}>
                        </label>
                        <button type="submit" class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                            {t.wb_ctx_apply()}
                        </button>
                    </div>
                </form>
                if !options.option_kinds.is_empty() {
                    <OptionsPanel t={t} options={options} refresh={&refresh} />
                }
            </div>
        </details>
    }
}

/// One guided scope select: its options, the parent each names (so the script can fill the parents
/// in), and the hidden field its name rides in.
#[component(css = ImportContext)]
fn ScopeSelect<'a>(t: Cat, field: &'a GuidedField, index: usize) -> impl Render {
    let placeholder = t.wb_options_scope_select(&field.label).to_string();
    let index = index.to_string();
    let id = format!("ctx-{}", field.field_name);
    html! {
        <div class={Field}>
            <label class={Label} for={&id}>{&field.label}</label>
            <select
                id={&id}
                name={&field.field_name}
                class={Select {}}
                disabled={field.parent_missing}
                data-guided={&index}
                data-query-kind={&field.query_kind}
                data-label-field={field.label_field_name.as_deref().unwrap_or("")}
            >
                <option value="" selected={field.selected_value.is_empty()}>{&placeholder}</option>
                for option in &field.options {
                    <option
                        value={&option.value}
                        selected={option.value == field.selected_value}
                        data-parent={option.parent_value.as_deref()}
                    >
                        {&option.label}
                    </option>
                }
            </select>
            if let Some(text) = &field.parent_diagnostic {
                <p class={Muted}>{text}</p>
            }
            if let Some(name) = &field.label_field_name {
                <input type="hidden" name={name} value={&field.selected_label} disabled data-label-for={&field.field_name}>
            }
        </div>
    }
}

/// The synced source options (admin-web's `SourceOptionsStatusPanel`): how many are loaded, each
/// kind's state, and its Reload and Force refresh.
#[component(css = ImportContext)]
fn OptionsPanel<'a>(t: Cat, options: &'a SourceOptions, refresh: &'a str) -> impl Render {
    let summary = &options.summary;
    let line = t
        .wb_options_summary(crate::text::cat::WbOptionsSummary {
            available: summary.available_options,
            loaded: summary.loaded_pages,
            declared: summary.declared_kinds,
        })
        .to_string();
    let f = OptionsInput::FIELDS;
    html! {
        <section class={Options} aria-labelledby="ctx-options" data-catalog-source-options-status={&options.status}>
            <div class={OptionsHead}>
                <div>
                    <h3 id="ctx-options">{t.wb_options_title()}</h3>
                    <p class={Muted}>{&line}</p>
                </div>
                <div class={Controls}>
                    <Pill text={options_status_label(t, &options.status)} tone={options_status_tone(&options.status)} />
                    if options.refresh.all() {
                        <form method="post" action={refresh}>
                            <input type="hidden" name={f.action} value="force-refresh-all">
                            <button type="submit" class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}>
                                {t.wb_options_refresh_all()}
                            </button>
                        </form>
                    }
                </div>
            </div>
            <ul class={Kinds}>
                for page in &options.pages {
                    let disabled = page.action_state == "disabled";
                    let detail = if page.state == "not-requested" {
                        page.cache.diagnostics.first().map_or_else(
                            || t.wb_options_parent_required(page.scope.as_str()).to_string(),
                            |d| d.message.clone(),
                        )
                    } else {
                        t.wb_options_option_count(page.page.count).to_string()
                    };
                    <li class={Kind} data-source-option-page={&page.query_kind} data-source-option-state={&page.state}>
                        <div class={KindHead}>
                            <div>
                                <p class={Strong}>{&page.display_name}</p>
                                <p class={Muted}>{&detail}</p>
                            </div>
                            <div class={Controls}>
                                <Pill text={page_state_label(t, &page.state)} tone={page_state_tone(&page.state)} />
                                if page.degraded {
                                    <Pill text={t.wb_options_degraded_note()} tone="warning" />
                                }
                            </div>
                        </div>
                        <div class={Controls}>
                            <form method="post" action={refresh}>
                                <input type="hidden" name={f.action} value="reload">
                                <input type="hidden" name={f.query_kind} value={&page.query_kind}>
                                <button
                                    type="submit"
                                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                                    disabled={disabled}
                                >
                                    {t.wb_options_reload()}
                                </button>
                            </form>
                            if page.refresh_href.is_some() {
                                <form method="post" action={refresh}>
                                    <input type="hidden" name={f.action} value="force-refresh">
                                    <input type="hidden" name={f.query_kind} value={&page.query_kind}>
                                    <button
                                        type="submit"
                                        class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                                        disabled={disabled}
                                    >
                                        {t.wb_options_force_refresh()}
                                    </button>
                                </form>
                            }
                        </div>
                    </li>
                }
            </ul>
        </section>
    }
}
