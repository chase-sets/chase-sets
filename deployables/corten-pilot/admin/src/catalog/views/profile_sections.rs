//! Provider detail's profile section workspaces (admin-web's `ProfileSectionWorkspaces`): each
//! registered section of the selected version in its group, in the read model's order. A section is a
//! disclosure, so it opens without a script and reads on a phone (admin-web's section navigation is
//! the groups' headings here); inside are its status, diagnostics and blockers, then its form, drawn
//! from the section's fields as the API describes them: a text, a comma-separated list typed as text,
//! a textarea, a select or a checkbox, each disabled when the API says so. A form posts to the pilot
//! and lands back on the page; a refusal is the page's notice, patched in place with JavaScript.
use corten::prelude::*;
use platform::{
    theme::gap_4,
    ui::{
        accordion::Accordion,
        button::{Button, ButtonSize, ButtonVariant},
        checkbox::Checkbox,
        input::Input,
        select::Select,
        stack::{Gap, Stack as KitStack},
        textarea::Textarea,
    },
};

use super::integrations_page::{Blockers, Pairs, Pill, state_label};
use crate::{
    catalog::{
        daily::at,
        provider,
        sections::{Field, Group, PROFILE_VERSION, Workspace},
    },
    text::{Cat, Pilot},
};

/// admin-web's `sectionStatusTone`.
fn status_tone(status: &str) -> &'static str {
    match status {
        "valid" => "success",
        "warning" => "warning",
        _ => "danger",
    }
}

/// admin-web's `actionTone`.
fn action_tone(state: &str) -> &'static str {
    match state {
        "available" => "success",
        "denied" | "unsafe" | "blocked" => "danger",
        "degraded" => "warning",
        _ => "neutral",
    }
}

fn save_tone(outcome: &str) -> &'static str {
    match outcome {
        "saved" => "success",
        "not-submitted" => "neutral",
        _ => "warning",
    }
}

/// The section workspaces, by group. None of them draw without a selected version.
#[component(css)]
pub fn ProfileSections<'a>(
    t: Cat,
    p: Pilot,
    groups: &'a [Group],
    workspaces: &'a [Workspace],
    version: &'a str,
    key: &'a str,
    context: &'a str,
    manage: bool,
) -> impl Render {
    // A section the groups do not list is drawn after them, under no heading, so none goes missing.
    let grouped = |w: &&Workspace| groups.iter().any(|g| g.sections.contains(&w.section_key));
    let rest: Vec<&Workspace> = workspaces.iter().filter(|w| !grouped(w)).collect();
    html! {
        <div class={(KitStack { gap: Gap::App }, gap_4(), Stack)} data-catalog-profile-sections="true">
            for group in groups {
                let members: Vec<&Workspace> = workspaces.iter().filter(|w| group.sections.contains(&w.section_key)).collect();
                if !members.is_empty() {
                    <section class={GroupBox} aria-label={&group.label}>
                        <h3 class={Heading}>{&group.label}</h3>
                        for workspace in members {
                            <Section
                                t={t}
                                p={p}
                                workspace={workspace}
                                version={version}
                                key={key}
                                context={context}
                                manage={manage}
                            />
                        }
                    </section>
                }
            }
            for workspace in rest {
                <Section t={t} p={p} workspace={workspace} version={version} key={key} context={context} manage={manage} />
            }
        </div>
    }
}

/// One section (`ProfileSectionWorkspaceCard`).
#[component(css = ProfileSections)]
fn Section<'a>(
    t: Cat,
    p: Pilot,
    workspace: &'a Workspace,
    version: &'a str,
    key: &'a str,
    context: &'a str,
    manage: bool,
) -> impl Render {
    let w = workspace;
    let can_save = manage && w.editable && !version.is_empty();
    let action = at(&provider::url::Section { key, section: &w.section_key }.href().to_string(), context);
    let left = [
        (p.sections_domain(), w.domain_concept.clone()),
        (p.sections_dirty(), state_label(&w.dirty_state)),
        (p.sections_stale(), state_label(&w.stale_state)),
    ];
    let right = [
        (p.sections_diagnostics(), w.diagnostics.len().to_string()),
        (p.sections_semantic(), w.semantic_change_count.to_string()),
        (p.sections_readiness(), w.readiness_check_count.to_string()),
    ];
    let (status, act, saved) = (state_label(&w.status), state_label(&w.action_state), state_label(&w.save_outcome));
    html! {
        <details class={(Accordion {}, Sheet)} id={&w.anchor_id} data-catalog-profile-section-workspace={&w.section_key}>
            <summary>
                <span class={Title}>
                    <span class={(Strong, Words)}>{&w.display_name}</span>
                    <span class={Badges}>
                        <Pill text={&status} tone={status_tone(&w.status)} />
                        <Pill text={&act} tone={action_tone(&w.action_state)} />
                        <Pill text={&saved} tone={save_tone(&w.save_outcome)} />
                    </span>
                </span>
            </summary>
            <div class={Body}>
                if !w.description.is_empty() {
                    <p class={(Muted, Words)}>{&w.description}</p>
                }
                <div class={Columns}>
                    <Pairs items={&left} />
                    <Pairs items={&right} />
                </div>
                <Blockers t={t} blockers={&w.blockers} />
                if !w.diagnostics.is_empty() {
                    <div class={Panel}>
                        <p class={Strong}>{t.wb_profile_sections_diagnostics()}</p>
                        <ul class={List}>
                            for d in &w.diagnostics {
                                <li data-severity={&d.severity}>
                                    <span class={Strong}>{&d.path}</span>
                                    " "
                                    <span class={Words}>{&d.diagnostic_text}</span>
                                </li>
                            }
                        </ul>
                    </div>
                }
                <form
                    method="post"
                    action={&action}
                    class={Form}
                    data-patch
                    data-catalog-primary-workbench-command="provider-profile.edit-section"
                >
                    <input type="hidden" name={PROFILE_VERSION} value={version}>
                    <div class={Fields}>
                        for field in &w.fields {
                            <Control p={p} field={field} locked={!can_save} />
                        }
                    </div>
                    <div>
                        <button
                            type="submit"
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            disabled={!can_save}
                        >
                            {t.wb_profile_sections_save()}
                        </button>
                    </div>
                </form>
            </div>
        </details>
    }
}

/// A field's control (`ProfileSectionFieldControl`). One the API disables, or every field when the
/// section cannot be saved, is disabled, so the browser does not send it and the stored value stays.
#[component(css = ProfileSections)]
fn Control<'a>(p: Pilot, field: &'a Field, locked: bool) -> impl Render {
    let disabled = locked || field.disabled;
    let help = field.help_text.as_deref().filter(|h| !h.is_empty());
    let help_id = format!("{}-help", field.key);
    let described = help.is_some().then(|| help_id.clone());
    html! {
        match field.control.as_str() {
            "checkbox" => {
                <div class={FieldBox}>
                    <Checkbox label={&field.label}>
                        <input
                            type="checkbox"
                            name={&field.key}
                            value="true"
                            checked={field.value == "true"}
                            disabled={disabled}
                            aria-describedby={described.as_deref()}
                        >
                    </Checkbox>
                    if let Some(help) = help {
                        <small id={&help_id} class={Muted}>{help}</small>
                    }
                </div>
            }
            _ => {
                <label class={FieldBox}>
                    <span>{&field.label}</span>
                    match field.control.as_str() {
                        "textarea" => {
                            <textarea
                                class={Textarea {}}
                                name={&field.key}
                                rows="3"
                                required={field.required}
                                disabled={disabled}
                                aria-describedby={described.as_deref()}
                            >
                                {&field.value}
                            </textarea>
                        }
                        "select" => {
                            <select
                                class={Select {}}
                                name={&field.key}
                                required={field.required}
                                disabled={disabled}
                                aria-describedby={described.as_deref()}
                            >
                                if field.options.is_empty() {
                                    let label = if field.value.is_empty() { p.sections_not_selected() } else { field.value.as_str() };
                                    <option value={&field.value} selected>{label}</option>
                                } else {
                                    // A stored value the options leave out (an active version's lifecycle) is
                                    // shown as it is, not as the first option.
                                    if !field.value.is_empty() && !field.options.iter().any(|o| o.value == field.value) {
                                        <option value={&field.value} selected>{state_label(&field.value)}</option>
                                    }
                                    for option in &field.options {
                                        <option value={&option.value} selected={option.value == field.value}>
                                            {&option.label}
                                        </option>
                                    }
                                }
                            </select>
                        }
                        _ => {
                            <input
                                type="text"
                                class={Input {}}
                                name={&field.key}
                                value={&field.value}
                                required={field.required}
                                disabled={disabled}
                                aria-describedby={described.as_deref()}
                            >
                        }
                    }
                    if let Some(help) = help {
                        <small id={&help_id} class={Muted}>{help}</small>
                    }
                </label>
            }
        }
    }
}
