export const catalogSourceObservationsControlPlaneEnglishTranslations = {
  "catalog.features.sourceObservations.ui.lifecycleRecovery.audit.description":
    "Lifecycle changes stay traceable without preserving retired implementation paths.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyDescription":
    "Lifecycle recovery actions will appear here after rollback, deprecation, retirement, or activation.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.audit.emptyTitle": "No lifecycle audit events",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.audit.notRecorded": "not recorded",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.audit.title": "Recent lifecycle audit",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.badge.active": "Active",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.blockedDescription":
    "Resolve active jobs, profile lifecycle conflicts, or profile references before running lifecycle recovery.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.blockedTitle": "Lifecycle recovery has blockers",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.readyDescription":
    "Review impact evidence, confirm the lifecycle action, and verify audit evidence before returning to provider data import.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.readyTitle": "Lifecycle actions are ready",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.unavailableDescription":
    "Lifecycle recovery needs a provider profile version before rollback, deprecation, or retirement can be evaluated.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.banner.unavailableTitle": "Choose a profile version",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.blockers.none": "No lifecycle blockers",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.blockers.title": "Lifecycle blockers",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.confirmation.default":
    "I confirm {action} impact and audit evidence.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.confirmation.retire":
    "I confirm retirement removes this provider profile behavior entirely and all impact evidence is clear.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.description":
    "Rollback, deprecation, and retirement decisions for provider profile behavior that can affect import-to-promotion.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.metric.activeJobs": "Active jobs",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.metric.affectedReferences": "Affected references",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.metric.impactedCatalogItems": "Impacted Catalog Items",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.metric.lifecycleAudit": "Lifecycle audit",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.activation.open": "Open activation readiness",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.impactedCatalogItemIds":
    "Impacted Catalog Item IDs",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.noImpactedCatalogItems":
    "No impacted Catalog Items reported.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.evidence.replayRollback":
    "Replay and rollback evidence",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.activeJobs": "Active jobs",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.catalogItems": "Catalog Items",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.profileReferences": "Profile references",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.operation.metric.referencedObservations":
    "Referenced observations",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.description":
    "Choose the active profile for deprecation, a previous validated profile for rollback, or an inactive unreferenced profile for retirement.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyDescription":
    "Choose a provider before running profile lifecycle recovery.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.emptyTitle": "No provider profiles",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.profileCandidates.title": "Profile candidates",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.badge": "fully removed",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.description":
    "Retirement fully removes the profile behavior, not a soft deprecation or hidden compatibility support.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.ruleTitle":
    "Retirement removes the profile behavior",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.summary":
    "Retiring a provider profile removes its mapping and promotion behavior entirely. Lifecycle recovery cannot keep a compatibility route, alias, shim, fallback, hidden flag, or support-only path that preserves the retired behavior.",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.strictRetirement.title": "Strict retirement rule",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.action": "Action",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.event": "Event",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.inspect": "Inspect",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.lifecycle": "Lifecycle",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.occurred": "Occurred",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.profile": "Profile",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.table.references": "References",
  "catalog.features.sourceObservations.ui.lifecycleRecovery.title": "Lifecycle recovery",
  "catalog.features.sourceObservations.ui.conflictResolution.audit.description":
    "Recent provider, profile, and reapply events that explain how the conflict state was produced.",
  "catalog.features.sourceObservations.ui.conflictResolution.audit.emptyDescription":
    "Conflict audit evidence appears after provider imports, profile edits, activation, or reapply runs.",
  "catalog.features.sourceObservations.ui.conflictResolution.audit.emptyTitle": "No conflict audit events",
  "catalog.features.sourceObservations.ui.conflictResolution.audit.notRecorded": "not recorded",
  "catalog.features.sourceObservations.ui.conflictResolution.audit.title": "Conflict audit evidence",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.blockedDescription":
    "Promotion is blocked until the conflicting facts are reviewed with evidence and a ready command path.",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.blockedTitle": "Conflicts are blocking promotion",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.emptyDescription":
    "The selected Source Observations do not have duplicate, precedence, or promotion conflict evidence.",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.emptyTitle": "No conflicts in scope",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.readyDescription":
    "Review affected facts, precedence rules, candidate values, and audit evidence before returning to promotion.",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.readyTitle": "Conflict evidence is ready",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.unavailableDescription":
    "Source Observation review data is unavailable, so conflict resolution fails closed.",
  "catalog.features.sourceObservations.ui.conflictResolution.banner.unavailableTitle": "Conflict evidence unavailable",
  "catalog.features.sourceObservations.ui.conflictResolution.blockers.none": "No conflict blockers",
  "catalog.features.sourceObservations.ui.conflictResolution.blockers.title": "Conflict blockers",
  "catalog.features.sourceObservations.ui.conflictResolution.conflicts.description":
    "Affected facts, candidate values, precedence rules, and promotion impact for selected Source Observations.",
  "catalog.features.sourceObservations.ui.conflictResolution.conflicts.emptyDescription":
    "Return to Source Observation review or promotion preview to select observations with conflict evidence.",
  "catalog.features.sourceObservations.ui.conflictResolution.conflicts.emptyTitle": "No conflict rows",
  "catalog.features.sourceObservations.ui.conflictResolution.conflicts.title": "Fact conflicts",
  "catalog.features.sourceObservations.ui.conflictResolution.description":
    "Explain provider-to-provider and source-to-source fact conflicts that can block or shape Catalog promotion.",
  "catalog.features.sourceObservations.ui.conflictResolution.diagnostic.autoResolved":
    "Catalog precedence resolved this conflict without blocking promotion.",
  "catalog.features.sourceObservations.ui.conflictResolution.diagnostic.duplicateConflict":
    "Duplicate evidence requires review before promotion continues.",
  "catalog.features.sourceObservations.ui.conflictResolution.diagnostic.permissionDenied":
    "Override review requires Catalog management permission.",
  "catalog.features.sourceObservations.ui.conflictResolution.diagnostic.promotionConflict":
    "Promotion preview found a conflict that blocks execution.",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.audit": "Audit events",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.autoResolved": "auto-resolved",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.blocking": "Blocking",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.conflicts": "Conflicts",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.overrides": "Overrides",
  "catalog.features.sourceObservations.ui.conflictResolution.metric.reviewRequired": "need review",
  "catalog.features.sourceObservations.ui.conflictResolution.override.audit.required": "Audit required",
  "catalog.features.sourceObservations.ui.conflictResolution.override.banner.title": "Overrides fail closed",
  "catalog.features.sourceObservations.ui.conflictResolution.override.description":
    "Override affordances are permission-aware and auditable, but no compatibility override path exists.",
  "catalog.features.sourceObservations.ui.conflictResolution.override.key.audit": "Audit evidence",
  "catalog.features.sourceObservations.ui.conflictResolution.override.key.permission": "Required permission",
  "catalog.features.sourceObservations.ui.conflictResolution.override.policy.reason":
    "Conflict overrides run through an audited backend command with evidence capture; no compatibility override path is available.",
  "catalog.features.sourceObservations.ui.conflictResolution.override.title": "Override policy",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority": "Catalog promotion policy",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.description":
    "Potential duplicate identity evidence requires operator review before promotion.",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.label": "Duplicate prevention",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.description":
    "Catalog applies field precedence from Source Observation evidence when the result is not promotion-blocking.",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.label": "Field precedence",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.description":
    "Promotion command conflicts stop execution until the affected facts have reviewed evidence.",
  "catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.label": "Promotion blocking",
  "catalog.features.sourceObservations.ui.conflictResolution.rules.description":
    "The precedence rules used to decide whether a conflict blocks promotion, needs review, or auto-resolves.",
  "catalog.features.sourceObservations.ui.conflictResolution.rules.emptyDescription":
    "Precedence rules appear when the selected review scope contains conflict evidence.",
  "catalog.features.sourceObservations.ui.conflictResolution.rules.emptyTitle": "No precedence rules",
  "catalog.features.sourceObservations.ui.conflictResolution.rules.title": "Precedence rules",
  "catalog.features.sourceObservations.ui.conflictResolution.source.catalogCandidate": "Catalog candidate",
  "catalog.features.sourceObservations.ui.conflictResolution.source.duplicateEvidence": "Duplicate evidence",
  "catalog.features.sourceObservations.ui.conflictResolution.source.providerEvidence": "Provider evidence",
  "catalog.features.sourceObservations.ui.conflictResolution.table.action": "Action",
  "catalog.features.sourceObservations.ui.conflictResolution.table.authority": "Authority",
  "catalog.features.sourceObservations.ui.conflictResolution.table.behavior": "Behavior",
  "catalog.features.sourceObservations.ui.conflictResolution.table.event": "Event",
  "catalog.features.sourceObservations.ui.conflictResolution.table.fact": "Affected fact",
  "catalog.features.sourceObservations.ui.conflictResolution.table.occurred": "Occurred",
  "catalog.features.sourceObservations.ui.conflictResolution.table.openEvidence": "Open evidence",
  "catalog.features.sourceObservations.ui.conflictResolution.table.rule": "Rule",
  "catalog.features.sourceObservations.ui.conflictResolution.table.state": "State",
  "catalog.features.sourceObservations.ui.conflictResolution.table.values": "Candidate values",
  "catalog.features.sourceObservations.ui.conflictResolution.title": "Conflict resolution",
  "catalog.features.sourceObservations.ui.governanceControls.banner.blockedDescription":
    "At least one permission, rollout, kill-switch, worker, or observability control is blocking writes.",
  "catalog.features.sourceObservations.ui.governanceControls.banner.blockedTitle": "Governance controls are blocking",
  "catalog.features.sourceObservations.ui.governanceControls.banner.degradedDescription":
    "Controls remain inspectable, but one or more observability signals are stale or degraded.",
  "catalog.features.sourceObservations.ui.governanceControls.banner.degradedTitle":
    "Governance controls need attention",
  "catalog.features.sourceObservations.ui.governanceControls.banner.readyDescription":
    "Rollout, RBAC, worker, observability, and removal evidence are ready for the selected context.",
  "catalog.features.sourceObservations.ui.governanceControls.banner.readyTitle": "Governance controls are ready",
  "catalog.features.sourceObservations.ui.governanceControls.blockers.none": "No control blockers",
  "catalog.features.sourceObservations.ui.governanceControls.confirmationRequired": "confirmation required",
  "catalog.features.sourceObservations.ui.governanceControls.controls.description":
    "Rollout mode, emergency stops, kill switches, worker pause state, owners, metrics, and evidence stay together.",
  "catalog.features.sourceObservations.ui.governanceControls.controls.emptyDescription":
    "The workspace still exposes worker state and deletion evidence when no rollout stop is active.",
  "catalog.features.sourceObservations.ui.governanceControls.controls.emptyTitle": "No rollout controls",
  "catalog.features.sourceObservations.ui.governanceControls.controls.title": "Rollout and worker controls",
  "catalog.features.sourceObservations.ui.governanceControls.description":
    "Inspect rollout mode, kill switches, RBAC, worker state, observability, alert/runbook links, and removal evidence without leaving the primary import context.",
  "catalog.features.sourceObservations.ui.governanceControls.metric.blockedCommands": "Blocked commands",
  "catalog.features.sourceObservations.ui.governanceControls.metric.deletionEvidence": "Deletion evidence",
  "catalog.features.sourceObservations.ui.governanceControls.metric.deniedCommands": "Denied commands",
  "catalog.features.sourceObservations.ui.governanceControls.metric.observability": "Degraded signals",
  "catalog.features.sourceObservations.ui.governanceControls.metric.rolloutStops": "Rollout stops",
  "catalog.features.sourceObservations.ui.governanceControls.noConfirmation": "no confirmation",
  "catalog.features.sourceObservations.ui.governanceControls.observability.description":
    "Operational signals show option query latency, job failure rate, projection freshness, quarantine counts, conflict spikes, and alert/runbook links.",
  "catalog.features.sourceObservations.ui.governanceControls.observability.emptyDescription":
    "Missing observability data fails closed as unavailable evidence.",
  "catalog.features.sourceObservations.ui.governanceControls.observability.emptyTitle": "No observability signals",
  "catalog.features.sourceObservations.ui.governanceControls.observability.title": "Operational observability",
  "catalog.features.sourceObservations.ui.governanceControls.openEvidence": "Open evidence",
  "catalog.features.sourceObservations.ui.governanceControls.rbac.description":
    "Sensitive actions name view/manage permissions, destructive confirmations, current state, blockers, and denied-state copy.",
  "catalog.features.sourceObservations.ui.governanceControls.rbac.emptyDescription":
    "Sensitive actions are not available; their permission and confirmation rules are missing.",
  "catalog.features.sourceObservations.ui.governanceControls.rbac.emptyTitle": "No RBAC actions",
  "catalog.features.sourceObservations.ui.governanceControls.rbac.actionCount": "{count} actions",
  "catalog.features.sourceObservations.ui.governanceControls.rbac.title": "RBAC action matrix",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.alert": "Alert {value}",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.detail":
    "This compatibility behavior is fully removed; no broad patch route, client, or fallback branch preserves it.",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.label":
    "Broad patch compatibility",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.label": "Retired compatibility removal",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.message":
    "Retired payload escape hatches, broad patch behavior, and legacy selectors are deletion evidence only; they are not operator controls.",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.detail":
    "The payload escape hatch is fully removed across runtime, UI, and stored behavior.",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.label": "Payload escape hatch",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.detail":
    "The legacy selector pattern is fully removed, including its old UX, aliases, and redirects.",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.label":
    "Legacy selector pattern",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.runbook": "Runbook {value}",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.conflictSpike": "Conflict spike",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.dataQuarantine": "Data quarantine",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.jobFailureRate": "Job failure rate",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.optionLatency": "Option query latency",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.projectionFreshness":
    "Projection freshness",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.signal.sourceQuarantine":
    "Source Observation quarantine",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.worker.label": "Worker pause/resume state",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.worker.paused":
    "Worker claims are paused while rollout or emergency-stop controls are blocked.",
  "catalog.features.sourceObservations.ui.governanceControls.readModel.worker.running":
    "Workers are accepting import, reapply, and replay work; {count} active job(s) are in scope.",
  "catalog.features.sourceObservations.ui.governanceControls.removal.bannerDescription":
    "Retired behavior is deletion evidence only. No hidden flag, support route, or fallback branch preserves it.",
  "catalog.features.sourceObservations.ui.governanceControls.removal.bannerTitle": "Retired behavior is fully removed",
  "catalog.features.sourceObservations.ui.governanceControls.removal.description":
    "This workspace can show that compatibility behavior was removed, but cannot present it as an operator control.",
  "catalog.features.sourceObservations.ui.governanceControls.removal.title": "Retired compatibility removal",
  "catalog.features.sourceObservations.ui.governanceControls.staleEvidence": "stale evidence",
  "catalog.features.sourceObservations.ui.governanceControls.table.action": "Action",
  "catalog.features.sourceObservations.ui.governanceControls.table.alertRunbook": "Alert/runbook",
  "catalog.features.sourceObservations.ui.governanceControls.table.control": "Control",
  "catalog.features.sourceObservations.ui.governanceControls.table.evidence": "Evidence",
  "catalog.features.sourceObservations.ui.governanceControls.table.metric": "Metric",
  "catalog.features.sourceObservations.ui.governanceControls.table.permission": "Permission",
  "catalog.features.sourceObservations.ui.governanceControls.table.scope": "Scope",
  "catalog.features.sourceObservations.ui.governanceControls.table.signal": "Signal",
  "catalog.features.sourceObservations.ui.governanceControls.table.state": "State",
  "catalog.features.sourceObservations.ui.governanceControls.table.status": "Status",
  "catalog.features.sourceObservations.ui.governanceControls.table.surface": "Surface",
  "catalog.features.sourceObservations.ui.governanceControls.table.value": "Value",
  "catalog.features.sourceObservations.ui.governanceControls.title": "Governance controls",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.blocked.description":
    "The audit timeline cannot be assembled. Resolve the named projection issue before reviewing.",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.blocked.title": "Audit timeline is blocked",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.partial.description":
    "The audit timeline is reviewable, with {count} partial projection signal(s) called out.",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.partial.title": "Audit projection is partial",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.ready.title": "Audit timeline is ready",
  "catalog.features.sourceObservations.ui.auditEvidence.banner.unavailable.title": "Audit projection is unavailable",
  "catalog.features.sourceObservations.ui.auditEvidence.description":
    "Review who changed what, and which provider/unit/profile/job/Source Observation/Catalog item was touched.",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.active": "Active",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.available": "Available",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.description":
    "Provider, unit, profile version, job, observation, action category, actor, and time filters stay visible with the timeline.",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.emptyDescription":
    "Filter rows are required even when the audit projection is unavailable.",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.emptyTitle": "No filters",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.notApplied": "not applied",
  "catalog.features.sourceObservations.ui.auditEvidence.filters.title": "Timeline filters",
  "catalog.features.sourceObservations.ui.auditEvidence.key.forbiddenRequests": "Forbidden evidence requests",
  "catalog.features.sourceObservations.ui.auditEvidence.key.generatedAt": "Generated at",
  "catalog.features.sourceObservations.ui.auditEvidence.key.profileSnapshot": "Profile snapshot access",
  "catalog.features.sourceObservations.ui.auditEvidence.key.projection": "Projection state",
  "catalog.features.sourceObservations.ui.auditEvidence.key.sourcePayload": "Source payload access",
  "catalog.features.sourceObservations.ui.auditEvidence.links.description":
    "Every link opens a redacted summary, proof, or diagnostic for the selected timeline event.",
  "catalog.features.sourceObservations.ui.auditEvidence.links.emptyDescription":
    "Evidence links appear when timeline rows are available.",
  "catalog.features.sourceObservations.ui.auditEvidence.links.emptyTitle": "No evidence links",
  "catalog.features.sourceObservations.ui.auditEvidence.links.title": "Redacted evidence links",
  "catalog.features.sourceObservations.ui.auditEvidence.metric.links": "Evidence links",
  "catalog.features.sourceObservations.ui.auditEvidence.metric.linksTrend": "redacted summaries",
  "catalog.features.sourceObservations.ui.auditEvidence.metric.projection": "Partial signals",
  "catalog.features.sourceObservations.ui.auditEvidence.metric.timeline": "Timeline events",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.jobWorker": "job worker",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operator": "operator:{value}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operatorScope": "operator scope",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter": "provider adapter",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system": "system",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.dryRun.summary":
    "{externalKey}: {status}; {evidence}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.job.summary":
    "{status}: {completed}/{total} ({percent}%)",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.link.job": "Job {value}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.link.observation": "Observation {value}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.link.promotion": "Promotion command plan",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.projection.unavailable":
    "Audit evidence timeline projection is unavailable.",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.promotion.summary":
    "{eligible} eligible promotion target(s), {blocked} blocked target(s)",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.entry": "{label}: {value}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.summary":
    "Normal review uses redacted summaries and links; source payload bodies and profile snapshots are not required.",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.sourceObservation.summary": "{name}: {summary}",
  "catalog.features.sourceObservations.ui.auditEvidence.readModel.target.controlPlane": "control-plane",
  "catalog.features.sourceObservations.ui.auditEvidence.table.category": "Category",
  "catalog.features.sourceObservations.ui.auditEvidence.table.evidence": "Evidence",
  "catalog.features.sourceObservations.ui.auditEvidence.table.event": "Event",
  "catalog.features.sourceObservations.ui.auditEvidence.table.filter": "Filter",
  "catalog.features.sourceObservations.ui.auditEvidence.table.kind": "Kind",
  "catalog.features.sourceObservations.ui.auditEvidence.table.options": "Options",
  "catalog.features.sourceObservations.ui.auditEvidence.table.redaction": "Redaction",
  "catalog.features.sourceObservations.ui.auditEvidence.table.state": "State",
  "catalog.features.sourceObservations.ui.auditEvidence.table.summary": "Summary",
  "catalog.features.sourceObservations.ui.auditEvidence.table.target": "Target",
  "catalog.features.sourceObservations.ui.auditEvidence.table.value": "Value",
  "catalog.features.sourceObservations.ui.auditEvidence.timeline.description":
    "Timeline rows show event, actor, provider, unit, profile, job, observation, target, summary, diagnostics, and redacted evidence links.",
  "catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyDescription":
    "The projection is unavailable or the current filters have no matching events.",
  "catalog.features.sourceObservations.ui.auditEvidence.timeline.emptyTitle": "No timeline events",
  "catalog.features.sourceObservations.ui.auditEvidence.timeline.title": "Audit events",
  "catalog.features.sourceObservations.ui.auditEvidence.title": "Audit timeline",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.accept.label": "Accept alias",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.defer.label": "Defer alias",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.reject.label": "Reject alias",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.revoke.label": "Revoke alias",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.defer.label": "Defer candidate",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.edit.label": "Edit candidate",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.ignore.label": "Ignore candidate",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.promote.label": "Promote candidate",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.split.label": "Split candidate",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.cancel.label": "Cancel job",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.resume.label": "Resume job",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.retry.label": "Retry job",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.defer.label": "Defer observations",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.promote.label": "Promote observations",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.reapply.label": "Reapply observations",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.reject.label": "Reject observations",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.replay.label": "Replay observations",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.activate.label": "Activate profile",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.clone.label": "Clone profile draft",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.deprecate.label": "Deprecate profile",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.edit-section.label":
    "Edit profile section",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.retire.label": "Retire profile",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.rollback.label": "Roll back profile",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.scope.import.label": "Import provider data",
  "catalog.features.sourceObservations.ui.controlPlaneV2.actions.scope.sync.label": "Sync scope",
} as const;
