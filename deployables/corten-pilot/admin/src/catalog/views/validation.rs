//! Provider detail's validation readiness (admin-web's `ProviderReadinessSection`, `FixtureSection`,
//! `DryRunSection`, `SemanticCompareSection`, `ActivationReadinessSection` and
//! `ActivationDecisionModule`), in admin-web's order. A row's side sheet is a disclosure in its first
//! cell, so it opens without a script and reads on a phone; each table stacks there, a row a block of
//! labelled lines. The evidence and activate forms post to the pilot and land back on the page; a
//! refusal is the page's notice, patched in place with JavaScript.
use corten::prelude::*;
use platform::ui::{
    accordion::Accordion,
    button::{Button, ButtonSize, ButtonVariant},
    input::Input,
    table::{CellLabel, Table, TableLayout},
    textarea::Textarea,
};

use super::integrations_page::{Banner, Blockers, Cell, Empty, Evidence, Metric, Module, Pairs, Pill, blocker, transport};
use crate::{
    catalog::{
        daily::at,
        provider::{self, Model},
        validation::{
            ActivateInput, Check, Decision, Diagnostic, DryRun, EvidenceInput, EvidenceRow, FixtureFlow, Section, open,
        },
    },
    text::{Cat, Pilot},
};

/// admin-web's `statusLabel`: each word capitalized.
fn status_label(value: &str) -> String {
    value
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn or(value: Option<&String>, fallback: &str) -> String {
    value.filter(|v| !v.is_empty()).map_or_else(|| fallback.to_owned(), Clone::clone)
}

const CREDENTIAL_BLOCKERS: [&str; 3] =
    ["provider-credential-missing", "provider-credential-invalid", "provider-credential-expired"];

/// The sections, between the profile's draft and its version history.
#[component(css)]
pub fn Validation<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    model: &'a Model,
    key: &'a str,
    context: &'a str,
    manage: bool,
) -> impl Render {
    html! {
        <div class={Stack} data-catalog-validation-readiness="true">
            <ProviderReadiness t={t} p={p} model={model} />
            <Fixtures t={t} p={p} model={model} />
            <DryRuns t={t} p={p} model={model} />
            <Compare t={t} p={p} model={model} />
            <Checks t={t} p={p} model={model} />
            <DecisionModule t={t} p={p} req={req} model={model} key={key} context={context} manage={manage} />
        </div>
    }
}

/// Provider readiness: the selected scope's adapter and credential, the provider's transport, and
/// what to fix. A credential blocker blocks; a transport problem degrades.
#[component(css = Validation)]
fn ProviderReadiness<'a>(t: Cat, p: Pilot, model: &'a Model) -> impl Render {
    let readiness = &model.readiness;
    let scope = model.import_jobs.selected_scope.as_ref().map(|s| &s.readiness);
    let mut categories: Vec<&str> = Vec::new();
    for category in &readiness.provider_transport {
        if !categories.contains(&category.as_str()) {
            categories.push(category);
        }
    }
    let credentials: Vec<String> =
        readiness.blockers.iter().filter(|b| CREDENTIAL_BLOCKERS.contains(&b.as_str())).cloned().collect();
    let (state, title, description) = if !credentials.is_empty() {
        ("blocked", t.wb_validation_provider_banner_blocked_title(), t.wb_validation_provider_banner_blocked_description())
    } else if !categories.is_empty() {
        ("degraded", t.wb_validation_provider_banner_degraded_title(), t.wb_validation_provider_banner_degraded_description())
    } else {
        ("ready", t.wb_validation_provider_banner_ready_title(), t.wb_validation_provider_banner_ready_description())
    };
    let tone = match state {
        "blocked" => "danger",
        "degraded" => "warning",
        _ => "success",
    };
    let labels: Vec<&str> = categories.iter().map(|c| transport(t, c).unwrap_or(c)).collect();
    let no_scope = t.wb_validation_provider_no_scope();
    let items = [
        (t.wb_validation_provider_adapter(), scope.map_or_else(|| no_scope.to_owned(), |s| status_label(&s.adapter_readiness))),
        (
            t.wb_validation_provider_credential(),
            scope.map_or_else(|| no_scope.to_owned(), |s| status_label(&s.credential_readiness)),
        ),
        (
            t.wb_validation_provider_transport(),
            if labels.is_empty() { t.wb_validation_provider_transport_ready().to_owned() } else { labels.join(", ") },
        ),
    ];
    let _ = p;
    html! {
        <Module
            id="pd-provider-readiness"
            title={t.wb_validation_provider_title()}
            description={t.wb_validation_provider_description()}
            status={status_label(state)}
            tone={tone}
        >
            <Banner tone={tone} title={title} description={description} />
            <Pairs items={&items} />
            if credentials.is_empty() && labels.is_empty() {
                <p class={Muted}>{t.wb_validation_provider_no_remediation()}</p>
            } else {
                <div class={Group}>
                    <p class={Strong}>{t.wb_validation_provider_remediation()}</p>
                    <span class={Badges}>
                        for b in &credentials {
                            <Pill text={blocker(t, b).map_or(b.as_str(), |(label, _)| label)} tone="danger" />
                        }
                        for label in &labels {
                            <Pill text={label} tone="warning" />
                        }
                    </span>
                </div>
            }
        </Module>
    }
}

fn fixture_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "warning" => "warning",
        _ => "danger",
    }
}

/// Fixture flow proof: each flow, what its fixture is expected to prove, and its diagnostics.
#[component(css = Validation)]
fn Fixtures<'a>(t: Cat, p: Pilot, model: &'a Model) -> impl Render {
    let v = &model.validation_readiness;
    let tone = if v.summary.blocked_fixture_flows > 0 { "danger" } else { "success" };
    html! {
        <Module
            id="pd-fixtures"
            title={t.wb_validation_fixture_title()}
            description={t.wb_validation_fixture_description()}
            status={t.wb_validation_fixture_covered_flows().to_owned()}
            tone={tone}
        >
            if v.fixture_flows.is_empty() {
                <Empty title={t.wb_validation_fixture_empty_title()} description={t.wb_validation_fixture_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table data-catalog-validation-fixtures="true">
                        <caption class={Hidden}>{t.wb_validation_fixture_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_validation_fixture_table_flow()}</th>
                                <th scope="col">{t.wb_validation_table_status()}</th>
                                <th scope="col">{t.wb_validation_fixture_table_expected_evidence()}</th>
                                <th scope="col">{t.wb_validation_table_diagnostics()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for flow in &v.fixture_flows {
                                <FixtureRow t={t} p={p} flow={flow} />
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
    }
}

#[component(css = Validation)]
fn FixtureRow<'a>(t: Cat, p: Pilot, flow: &'a FixtureFlow) -> impl Render {
    let payload =
        flow.payload_path.clone().or_else(|| flow.payload_file.clone()).unwrap_or_else(|| p.validation_no_payload().to_owned());
    let not_declared = p.validation_not_declared();
    let expected = [
        or(flow.expected_status.as_ref(), not_declared),
        format!("{} {}", flow.expected_promotion_commands.len(), t.wb_validation_fixture_table_promotion_commands()),
        format!("{} {}", flow.expected_hash_evidence_paths.len(), t.wb_validation_fixture_table_hash_paths()),
        format!("{} {}", flow.expected_merge_evidence_paths.len(), t.wb_validation_fixture_table_merge_paths()),
    ];
    let first = flow.diagnostics.first().map_or(t.wb_validation_diagnostics_empty(), |d| d.diagnostic_text.as_str());
    let count = flow.diagnostics.len().to_string();
    let sample = if flow.sample_payload_available { p.validation_available() } else { p.validation_not_available() };
    let pairs = [
        (p.validation_flow(), flow.flow.clone()),
        (t.wb_validation_table_status(), status_label(&flow.status)),
        (p.validation_payload_file(), or(flow.payload_file.as_ref(), not_declared)),
        (p.validation_payload_path(), or(flow.payload_path.as_ref(), not_declared)),
        (p.validation_sample_payload(), sample.to_owned()),
    ];
    let title = t.wb_validation_fixture_sheet_title(&flow.label).to_string();
    html! {
        <tr>
            <td>
                <CellLabel>{t.wb_validation_fixture_table_flow()}</CellLabel>
                <details class={(Accordion {}, Sheet)} data-catalog-validation-fixture={&flow.flow}>
                    <summary><Cell title={&flow.label} description={Some(payload.as_str())} detail={None} /></summary>
                    <div class={Body}>
                        <p class={Strong}>{title}</p>
                        <p class={Muted}>{t.wb_validation_fixture_sheet_description()}</p>
                        <Pairs items={&pairs} />
                        <Listed
                            t={t}
                            title={t.wb_validation_fixture_expected_diagnostics()}
                            items={&flow.expected_diagnostic_paths}
                        />
                        <Listed
                            t={t}
                            title={t.wb_validation_fixture_expected_hash_evidence()}
                            items={&flow.expected_hash_evidence_paths}
                        />
                        <Listed
                            t={t}
                            title={t.wb_validation_fixture_expected_merge_evidence()}
                            items={&flow.expected_merge_evidence_paths}
                        />
                        <Listed
                            t={t}
                            title={t.wb_validation_fixture_expected_promotion_commands()}
                            items={&flow.expected_promotion_commands}
                        />
                        <Diagnostics
                            t={t}
                            p={p}
                            empty={t.wb_validation_fixture_empty_diagnostics()}
                            diagnostics={&flow.diagnostics}
                        />
                        <Blockers t={t} blockers={&flow.blockers} />
                    </div>
                </details>
            </td>
            <td>
                <CellLabel>{t.wb_validation_table_status()}</CellLabel>
                <Pill text={&status_label(&flow.status)} tone={fixture_tone(&flow.status)} />
            </td>
            <td>
                <CellLabel>{t.wb_validation_fixture_table_expected_evidence()}</CellLabel>
                <span class={Lines}>
                    for line in &expected {
                        <small>{line}</small>
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_validation_table_diagnostics()}</CellLabel>
                <Cell title={&count} description={None} detail={Some(first)} />
            </td>
        </tr>
    }
}

/// A titled list of values (`EvidenceStringList`), or "None declared".
#[component(css = Validation)]
fn Listed<'a>(t: Cat, title: &'a str, items: &'a [String]) -> impl Render {
    html! {
        <div class={Group}>
            <p class={Strong}>{title}</p>
            if items.is_empty() {
                <p class={Muted}>{t.wb_validation_evidence_none_declared()}</p>
            } else {
                <ul class={List}>
                    for item in items {
                        <li>{item}</li>
                    }
                </ul>
            }
        </div>
    }
}

/// A diagnostic's labelled values: a fixture flow's are its severity, path and words; a dry run's
/// add its code, section and flow.
fn diagnostic(p: Pilot, d: &Diagnostic) -> Vec<(&'static str, String)> {
    let mut items = Vec::new();
    if !d.code.is_empty() {
        items.push((p.validation_code(), d.code.clone()));
    }
    if !d.severity.is_empty() {
        items.push((p.validation_severity(), d.severity.clone()));
    }
    items.push((p.validation_path(), d.path.clone()));
    if !d.domain_concept.is_empty() {
        items.push((p.validation_section(), d.domain_concept.clone()));
        items.push((p.validation_flow(), or(d.fixture_flow.as_ref(), p.validation_not_flow_specific())));
    }
    items.push((p.validation_diagnostic(), d.diagnostic_text.clone()));
    items
}

/// Diagnostics, each its code, path, section, flow and words as the API reports them.
#[component(css = Validation)]
fn Diagnostics<'a>(t: Cat, p: Pilot, empty: &'a str, diagnostics: &'a [Diagnostic]) -> impl Render {
    html! {
        <div class={Group}>
            <p class={Strong}>{t.wb_validation_table_diagnostics()}</p>
            if diagnostics.is_empty() {
                <p class={Muted}>{empty}</p>
            } else {
                for d in diagnostics {
                    let items = diagnostic(p, d);
                    <div class={Panel}><Pairs items={&items} /></div>
                }
            }
        </div>
    }
}

/// Dry-run evidence: each fixture-backed proof, its redacted facts and diagnostics.
#[component(css = Validation)]
fn DryRuns<'a>(t: Cat, p: Pilot, model: &'a Model) -> impl Render {
    let v = &model.validation_readiness;
    let tone = if v.dry_run_evidence.iter().any(|e| e.status == "blocked") { "danger" } else { "success" };
    html! {
        <Module
            id="pd-dry-runs"
            title={t.wb_validation_dry_run_title()}
            description={t.wb_validation_dry_run_description()}
            status={p.validation_proofs().to_owned()}
            tone={tone}
        >
            if v.dry_run_evidence.is_empty() {
                <Empty title={t.wb_validation_dry_run_empty_title()} description={t.wb_validation_dry_run_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table data-catalog-validation-dry-runs="true">
                        <caption class={Hidden}>{t.wb_validation_dry_run_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_validation_dry_run_table_source()}</th>
                                <th scope="col">{t.wb_validation_table_status()}</th>
                                <th scope="col">{t.wb_validation_dry_run_table_redacted_facts()}</th>
                                <th scope="col">{t.wb_validation_table_diagnostics()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for evidence in &v.dry_run_evidence {
                                <DryRunRow t={t} p={p} evidence={evidence} />
                            }
                        </tbody>
                    </table>
                </Table>
            }
        </Module>
    }
}

#[component(css = Validation)]
fn DryRunRow<'a>(t: Cat, p: Pilot, evidence: &'a DryRun) -> impl Render {
    let url = or(evidence.source_url.as_ref(), p.validation_no_source_url());
    let hash = or(evidence.source_hash.as_ref(), p.validation_no_source_hash());
    let shown: Vec<String> = evidence.normalized_facts.iter().take(4).map(|f| format!("{}: {}", f.key, f.value)).collect();
    let more = evidence.normalized_facts.len().saturating_sub(shown.len());
    let first = evidence.diagnostics.first().map_or(t.wb_validation_diagnostics_empty(), |d| d.diagnostic_text.as_str());
    let count = evidence.diagnostics.len().to_string();
    let tone = if evidence.status == "completed" { "success" } else { "danger" };
    let not_captured = p.validation_not_captured();
    let head = [
        (p.validation_external_key(), evidence.external_key.clone()),
        (t.wb_validation_table_status(), status_label(&evidence.status)),
        (p.validation_source_url(), or(evidence.source_url.as_ref(), not_captured)),
        (t.wb_validation_redaction_source_hash(), or(evidence.source_hash.as_ref(), not_captured)),
    ];
    let redaction: Vec<(&str, String)> = evidence.redaction_summary.iter().map(|r| (r.label.as_str(), r.value.clone())).collect();
    let facts: Vec<(&str, String)> = evidence.normalized_facts.iter().map(|f| (f.key.as_str(), f.value.clone())).collect();
    let title = t.wb_validation_dry_run_sheet_title(&evidence.external_key).to_string();
    html! {
        <tr>
            <td>
                <CellLabel>{t.wb_validation_dry_run_table_source()}</CellLabel>
                <details class={(Accordion {}, Sheet)} data-catalog-validation-dry-run={&evidence.external_key}>
                    <summary>
                        <Cell title={&evidence.external_key} description={Some(url.as_str())} detail={Some(hash.as_str())} />
                    </summary>
                    <div class={Body}>
                        <p class={Strong}>{title}</p>
                        <p class={Muted}>{t.wb_validation_dry_run_sheet_description()}</p>
                        <Pairs items={&head} />
                        if !redaction.is_empty() {
                            <div class={Panel}><Pairs items={&redaction} /></div>
                        }
                        if facts.is_empty() {
                            <p class={Muted}>{t.wb_validation_dry_run_no_facts()}</p>
                        } else {
                            <Pairs items={&facts} />
                        }
                        <Rows
                            t={t}
                            p={p}
                            title={t.wb_validation_dry_run_duplicate_candidates()}
                            rows={&evidence.duplicate_candidates}
                        />
                        <Rows t={t} p={p} title={t.wb_validation_dry_run_selected_options()} rows={&evidence.selected_options} />
                        <div class={Group}>
                            <p class={Strong}>{t.wb_validation_dry_run_promotion_command_preview()}</p>
                            if evidence.promotion_command_preview.is_empty() {
                                <p class={Muted}>{t.wb_validation_dry_run_no_promotion_commands()}</p>
                            } else {
                                for command in &evidence.promotion_command_preview {
                                    <div class={Panel}>
                                        <p class={(Strong, Words)}>{&command.command_name}</p>
                                        <Rows t={t} p={p} title={t.wb_validation_dry_run_inputs()} rows={&command.inputs} />
                                    </div>
                                }
                            }
                        </div>
                        <Diagnostics
                            t={t}
                            p={p}
                            empty={t.wb_validation_diagnostics_empty()}
                            diagnostics={&evidence.diagnostics}
                        />
                        <Listed t={t} title={t.wb_validation_metric_audit_evidence()} items={&evidence.audit_evidence} />
                    </div>
                </details>
            </td>
            <td>
                <CellLabel>{t.wb_validation_table_status()}</CellLabel>
                <Pill text={&status_label(&evidence.status)} tone={tone} />
            </td>
            <td>
                <CellLabel>{t.wb_validation_dry_run_table_redacted_facts()}</CellLabel>
                <span class={Lines}>
                    if shown.is_empty() {
                        <small>{t.wb_validation_dry_run_no_facts()}</small>
                    }
                    for line in &shown {
                        <small class={Words}>{line}</small>
                    }
                    if more > 0 {
                        <small class={Muted}>{p.validation_more(more)}</small>
                    }
                </span>
            </td>
            <td>
                <CellLabel>{t.wb_validation_table_diagnostics()}</CellLabel>
                <Cell title={&count} description={None} detail={Some(first)} />
            </td>
        </tr>
    }
}

/// Evidence rows (`EvidenceRows`): each its label, path, summary, owner and uses.
#[component(css = Validation)]
fn Rows<'a>(t: Cat, p: Pilot, title: &'a str, rows: &'a [EvidenceRow]) -> impl Render {
    let not_declared = p.validation_not_declared();
    html! {
        <div class={Group}>
            <p class={Strong}>{title}</p>
            if rows.is_empty() {
                <p class={Muted}>{t.wb_validation_evidence_empty_rows()}</p>
            } else {
                for row in rows {
                    let uses = if row.uses.is_empty() { not_declared.to_owned() } else { row.uses.join(", ") };
                    let items = [
                        (p.validation_label(), row.label.clone()),
                        (p.validation_path(), row.path.clone()),
                        (p.validation_summary(), row.summary.clone()),
                        (p.validation_owner(), or(row.owner.as_ref(), not_declared)),
                        (p.validation_uses(), uses),
                    ];
                    <div class={Panel}><Pairs items={&items} /></div>
                }
            }
        </div>
    }
}

fn section_tone(status: &str) -> &'static str {
    match status {
        "valid" => "success",
        "warning" => "warning",
        _ => "danger",
    }
}

/// Semantic compare: the selected version's mapping beside the active one, section by section.
#[component(css = Validation)]
fn Compare<'a>(t: Cat, p: Pilot, model: &'a Model) -> impl Render {
    let c = &model.validation_readiness.semantic_compare;
    let (status, tone) =
        if c.mapping_fingerprint.changed { (p.validation_changed(), "warning") } else { (p.validation_unchanged(), "success") };
    let coverage = c.fixture_coverage.iter().map(|f| format!("{}:{}", f.flow, f.status)).collect::<Vec<_>>().join(", ");
    let impact =
        if c.activation_impact.is_empty() { p.validation_no_impact().to_owned() } else { c.activation_impact.join("; ") };
    let items = [
        (p.validation_candidate_fingerprint(), or(c.mapping_fingerprint.candidate.as_ref(), p.validation_not_set())),
        (p.validation_active_fingerprint(), or(c.mapping_fingerprint.active.as_ref(), p.validation_not_set())),
        (p.validation_fixture_coverage(), coverage),
        (p.validation_activation_impact(), impact),
    ];
    html! {
        <Module
            id="pd-compare"
            title={t.wb_validation_compare_title()}
            description={t.wb_validation_compare_description()}
            status={status.to_owned()}
            tone={tone}
        >
            <div class={Panel}><Pairs items={&items} /></div>
            if c.sections.is_empty() {
                <Empty title={t.wb_validation_compare_empty_title()} description={t.wb_validation_compare_empty_description()} />
            } else {
                <Table layout={TableLayout::Stack}>
                    <table data-catalog-validation-compare="true">
                        <caption class={Hidden}>{t.wb_validation_compare_title()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{t.wb_validation_compare_table_section()}</th>
                                <th scope="col">{t.wb_validation_table_status()}</th>
                                <th scope="col">{t.wb_validation_compare_table_changes()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            for section in &c.sections {
                                <SectionRow t={t} p={p} section={section} />
                            }
                        </tbody>
                    </table>
                </Table>
            }
            if !c.unchanged_sections.is_empty() {
                <span class={Badges}>
                    for s in &c.unchanged_sections {
                        <Pill text={&s.domain_concept} tone="neutral" />
                    }
                </span>
            }
        </Module>
    }
}

#[component(css = Validation)]
fn SectionRow<'a>(t: Cat, p: Pilot, section: &'a Section) -> impl Render {
    let first = section.changes.first().map_or(p.validation_no_impact_short(), |c| c.activation_impact.as_str());
    let count = section.change_count.to_string();
    let title = t.wb_validation_compare_sheet_title(&section.domain_concept).to_string();
    html! {
        <tr>
            <td>
                <CellLabel>{t.wb_validation_compare_table_section()}</CellLabel>
                <details class={(Accordion {}, Sheet)} data-catalog-validation-section={&section.section_key}>
                    <summary>
                        <Cell title={&section.domain_concept} description={Some(section.section_key.as_str())} detail={None} />
                    </summary>
                    <div class={Body}>
                        <p class={Strong}>{title}</p>
                        <p class={Muted}>{t.wb_validation_compare_sheet_description()}</p>
                        if section.changes.is_empty() {
                            <Empty
                                title={t.wb_validation_compare_no_changes_title()}
                                description={t.wb_validation_compare_no_changes_description()}
                            />
                        } else {
                            for change in &section.changes {
                                let items = [
                                    (p.validation_path(), change.path.clone()),
                                    (p.validation_label(), change.label.clone()),
                                    (p.validation_candidate(), change.candidate_summary.clone()),
                                    (p.validation_active(), change.active_summary.clone()),
                                    (p.validation_impact(), change.activation_impact.clone()),
                                ];
                                <div class={Panel}><Pairs items={&items} /></div>
                            }
                        }
                    </div>
                </details>
            </td>
            <td>
                <CellLabel>{t.wb_validation_table_status()}</CellLabel>
                <Pill text={&section.status} tone={section_tone(&section.status)} />
            </td>
            <td>
                <CellLabel>{t.wb_validation_compare_table_changes()}</CellLabel>
                <Cell title={&count} description={None} detail={Some(first)} />
            </td>
        </tr>
    }
}

fn check_tone(check: &Check) -> &'static str {
    match check.state() {
        "blocked" => "danger",
        "warning" => "warning",
        _ => "success",
    }
}

/// Activation readiness: the reference count, whether migration evidence is required, and each
/// domain concept's checks with their remediation.
#[component(css = Validation)]
fn Checks<'a>(t: Cat, p: Pilot, model: &'a Model) -> impl Render {
    let a = &model.validation_readiness.activation_readiness;
    let tone = if a.status == "ready" { "success" } else { "danger" };
    let required = if a.requires_migration_evidence { p.validation_required() } else { p.validation_not_required() };
    let items = [
        (p.validation_reference_count(), a.reference_count.to_string()),
        (t.wb_validation_activation_decision_key_migration(), required.to_owned()),
        (t.wb_validation_table_status(), a.status.clone()),
    ];
    html! {
        <Module
            id="pd-activation-readiness"
            title={t.wb_validation_activation_title()}
            description={t.wb_validation_activation_description()}
            status={a.status.clone()}
            tone={tone}
        >
            <Pairs items={&items} />
            <div class={Grid}>
                for group in &a.groups {
                    <div class={Panel} data-catalog-activation-group={&group.domain_concept}>
                        <span class={Badges}>
                            <Pill text={&group.domain_concept} tone="neutral" />
                            <Pill text={&group.status} tone={if group.status == "ready" { "success" } else { "danger" }} />
                        </span>
                        if group.checks.is_empty() {
                            <p class={Muted}>{p.validation_no_checks()}</p>
                        } else {
                            <ul class={Checklist}>
                                for check in &group.checks {
                                    <li data-check-state={check.state()}>
                                        <span class={Row}>
                                            <span class={(Strong, Words)}>{&check.diagnostic_text}</span>
                                            <Pill text={&check.status} tone={check_tone(check)} />
                                        </span>
                                        <span class={(Muted, Words)}>{&check.remediation}</span>
                                        <span class={Badges}>
                                            <Pill text={&check.code} tone="neutral" />
                                            <Pill text={&check.path} tone="neutral" />
                                        </span>
                                    </li>
                                }
                            </ul>
                        }
                    </div>
                }
            </div>
        </Module>
    }
}

fn decision_tone(status: &str) -> &'static str {
    match status {
        "ready" => "success",
        "blocked" => "danger",
        _ => "warning",
    }
}

/// The activation decision: its banner and metrics, the profile and its evidence, then the
/// evidence and activate forms, each open when the API offers it to a manager.
#[component(css = Validation)]
fn DecisionModule<'a>(
    t: Cat,
    p: Pilot,
    req: &'a Req,
    model: &'a Model,
    key: &'a str,
    context: &'a str,
    manage: bool,
) -> impl Render {
    let v = &model.validation_readiness;
    let d = &v.activation_decision;
    let (title, description) = match d.status.as_str() {
        "ready" => (
            t.wb_validation_activation_decision_banner_ready_title(),
            t.wb_validation_activation_decision_banner_ready_description(),
        ),
        "blocked" => (
            t.wb_validation_activation_decision_banner_blocked_title(),
            t.wb_validation_activation_decision_banner_blocked_description(),
        ),
        _ => (
            t.wb_validation_activation_decision_banner_unavailable_title(),
            t.wb_validation_activation_decision_banner_unavailable_description(),
        ),
    };
    let not_selected = t.wb_not_selected();
    let e = &d.migration_evidence;
    let migration = if d.affected_references.requires_migration_evidence {
        t.wb_validation_activation_decision_metric_migration_required()
    } else {
        t.wb_validation_activation_decision_metric_migration_not_required()
    };
    let evidence_when = e.recorded_at.clone().or_else(|| model.generated_at.clone()).unwrap_or_default();
    let items = [
        (t.wb_validation_activation_decision_key_provider(), or(d.provider_key.as_ref(), not_selected)),
        (t.wb_validation_activation_decision_key_profile(), or(d.profile_version.as_ref(), not_selected)),
        (t.wb_validation_activation_decision_key_before(), or(e.mapping_fingerprint_before.as_ref(), not_selected)),
        (t.wb_validation_activation_decision_key_after(), or(e.mapping_fingerprint_after.as_ref(), not_selected)),
        (t.wb_validation_activation_decision_key_events(), d.audit_consequences.event_names.join(", ")),
        (t.wb_validation_activation_decision_key_audit(), d.audit_consequences.summary.clone()),
    ];
    let mut all: Vec<String> = d.blockers.clone();
    all.extend(d.save_evidence_blockers.iter().cloned());
    html! {
        <Module
            id="pd-activation-decision"
            title={t.wb_validation_activation_decision_title()}
            description={t.wb_validation_activation_decision_description()}
            status={status_label(&d.status)}
            tone={decision_tone(&d.status)}
        >
            if !d.audit_consequences.audit_evidence_url.is_empty() {
                <p>
                    <Evidence
                        req={req}
                        href={&d.audit_consequences.audit_evidence_url}
                        label={t.wb_validation_activation_decision_audit_link()}
                    />
                </p>
            }
            <Banner tone={decision_tone(&d.status)} title={title} description={description} />
            <dl class={Metrics}>
                <Metric
                    label={t.wb_validation_activation_decision_metric_references()}
                    value={d.affected_references.reference_count.to_string()}
                    trend={migration.to_owned()}
                />
                <Metric
                    label={t.wb_validation_activation_decision_metric_import_eligibility()}
                    value={status_label(&d.import_eligibility)}
                    trend={status_label(&v.activation_readiness.status)}
                />
                <Metric
                    label={t.wb_validation_activation_decision_metric_evidence()}
                    value={status_label(&e.state)}
                    trend={evidence_when.clone()}
                />
                <Metric
                    label={t.wb_validation_activation_decision_metric_action()}
                    value={status_label(&d.action_state)}
                    trend={or(d.lifecycle.as_ref(), not_selected)}
                />
            </dl>
            <div class={Columns}>
                <div class={Stack}>
                    <Pairs items={&items} />
                    <Listed
                        t={t}
                        title={t.wb_validation_activation_decision_replay_title()}
                        items={&d.affected_references.replay_implications}
                    />
                    if all.is_empty() {
                        <span class={Badges}>
                            <Pill text={t.wb_validation_activation_decision_no_blockers()} tone="success" />
                        </span>
                    } else {
                        <div class={Group}>
                            <p class={Strong}>{t.wb_validation_activation_decision_blockers()}</p>
                            <Blockers t={t} blockers={&all} />
                        </div>
                    }
                </div>
                <div class={Stack}>
                    <EvidenceForm t={t} decision={d} recorded_at={&evidence_when} key={key} context={context} manage={manage} />
                    <ActivateForm t={t} decision={d} key={key} context={context} manage={manage} />
                </div>
            </div>
        </Module>
    }
}

/// Record migration evidence (`MigrationEvidenceForm`).
#[component(css = Validation)]
fn EvidenceForm<'a>(
    t: Cat,
    decision: &'a Decision,
    recorded_at: &'a str,
    key: &'a str,
    context: &'a str,
    manage: bool,
) -> impl Render {
    let e = &decision.migration_evidence;
    let version = decision.profile_version.clone().unwrap_or_default();
    let disabled = !(manage && open(&decision.save_evidence_state) && !version.is_empty());
    let action = at(&provider::url::Evidence { key }.href().to_string(), context);
    let f = EvidenceInput::FIELDS;
    let before = e.mapping_fingerprint_before.clone().unwrap_or_default();
    let after = e.mapping_fingerprint_after.clone().unwrap_or_default();
    let run = e.fixture_run_id.clone().unwrap_or_default();
    html! {
        <form
            method="post"
            action={&action}
            class={Form}
            data-patch
            data-catalog-validation-evidence-form="true"
        >
            <input type="hidden" name={f.profile_version} value={&version}>
            <input type="hidden" name={f.migration_fingerprint_before} value={&before}>
            <input type="hidden" name={f.migration_fingerprint_after} value={&after}>
            <input type="hidden" name={f.migration_recorded_at} value={recorded_at}>
            <label class={Field}>
                <span>{t.wb_validation_activation_decision_evidence_label()}</span>
                <textarea
                    class={Textarea {}}
                    name={f.migration_evidence_text}
                    rows="4"
                    required={decision.affected_references.requires_migration_evidence}
                    disabled={disabled}
                    aria-describedby="pd-evidence-help"
                >
                    {&e.evidence_text}
                </textarea>
            </label>
            <small id="pd-evidence-help" class={Muted}>{t.wb_validation_activation_decision_evidence_help()}</small>
            <label class={Field}>
                <span>{t.wb_validation_activation_decision_fixture_run_label()}</span>
                <input type="text" class={Input {}} name={f.migration_fixture_run_id} value={&run} disabled={disabled}>
            </label>
            <div>
                <button
                    type="submit"
                    class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Md }}
                    disabled={disabled}
                >
                    {t.wb_validation_activation_decision_evidence_save()}
                </button>
            </div>
            if !decision.save_evidence_blockers.is_empty() {
                <Blockers t={t} blockers={&decision.save_evidence_blockers} />
            }
        </form>
    }
}

/// Activate the profile version (`ActivateProfileForm`).
#[component(css = Validation)]
fn ActivateForm<'a>(t: Cat, decision: &'a Decision, key: &'a str, context: &'a str, manage: bool) -> impl Render {
    let version = decision.profile_version.clone().unwrap_or_default();
    let disabled = !(manage && open(&decision.action_state) && !version.is_empty());
    let action = at(&provider::url::Activate { key }.href().to_string(), context);
    let f = ActivateInput::FIELDS;
    let items = [
        (t.wb_validation_activation_decision_key_action(), status_label(&decision.action_state)),
        (t.wb_validation_activation_decision_key_migration(), status_label(&decision.migration_evidence.state)),
    ];
    html! {
        <form
            method="post"
            action={&action}
            class={Form}
            data-patch
            data-catalog-activate-profile-form="true"
        >
            <input type="hidden" name={f.profile_version} value={&version}>
            <Pairs items={&items} />
            <div>
                <button
                    type="submit"
                    class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                    disabled={disabled}
                >
                    {t.wb_validation_activation_decision_activate()}
                </button>
            </div>
            if !decision.blockers.is_empty() {
                <Blockers t={t} blockers={&decision.blockers} />
            }
        </form>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_reads_as_admin_webs_words() {
        assert_eq!(status_label("not-required"), "Not Required");
        assert_eq!(status_label("ready"), "Ready");
        assert_eq!(status_label(""), "");
    }
}
