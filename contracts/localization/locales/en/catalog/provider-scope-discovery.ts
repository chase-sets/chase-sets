export const catalogProviderScopeDiscoveryEnglishTranslations = {
  "catalog.features.providerScopeDiscovery.api.route.schedule.not.found":
    "No refresh schedule exists for that provider.",
  "catalog.features.providerScopeDiscovery.api.route.accept.invalid.request":
    'Send exactly one mode: "bind" with a scopeRecordId, or "create" with optional parentScopeRecordId, releaseDate (YYYY-MM-DD) and officialSetCode.',
  "catalog.features.providerScopeDiscovery.api.route.accept.proposal.not.found":
    "No canonical Scope Record proposal has that id.",
  "catalog.features.providerScopeDiscovery.api.route.accept.proposal.rejected":
    "This canonical Scope Record proposal was rejected and cannot be accepted.",
  "catalog.features.providerScopeDiscovery.api.route.accept.proposal.accepted.elsewhere":
    "This canonical Scope Record proposal was already accepted onto a different Scope Record.",
  "catalog.features.providerScopeDiscovery.api.route.accept.candidates.exist":
    "Existing Scope Records may already be this proposal. Bind the proposal to one of them instead of creating another.",
  "catalog.features.providerScopeDiscovery.api.route.accept.product.line.missing":
    "The product domain's contract product line is not an active Scope Record, so it cannot be the default parent.",
  "catalog.features.providerScopeDiscovery.api.route.accept.key.unavailable":
    "The Reference Record key for this proposal is empty or already used by another record of that type.",
  "catalog.features.providerScopeDiscovery.api.route.accept.reference.history.conflict":
    "The Reference Record history for this proposal does not match the record this acceptance would author.",
  "catalog.features.providerScopeDiscovery.api.route.accept.bind.target.ineligible":
    "The bind target must be an active or draft Scope Record with the proposal's product domain, scope kind and language edition.",
  "catalog.features.providerScopeDiscovery.api.route.accept.kind.not.creatable":
    "Only series and the product domain's leaf scope kind can be created from a proposal.",
  "catalog.features.providerScopeDiscovery.api.route.accept.field.not.fillable":
    "A request value can only fill a field the proposal lacks.",
  "catalog.features.providerScopeDiscovery.api.route.accept.parent.ineligible":
    "The parent must be an active product line or series Scope Record of the proposal's product domain.",
  "catalog.features.providerScopeDiscovery.api.route.accept.attribute.missing":
    "A required Scope Record attribute is missing after the request values are applied.",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.title": "Scheduled source-option refresh",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.description":
    "Free providers refresh their scope options on a schedule so new sets reach the scope registry without a manual pull. Credit-metered providers stay manual-only by config.",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.provider": "Provider",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.cadence": "Cadence",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.cadence.hours": "Every {hours}h",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule": "Schedule",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.scheduled": "Scheduled",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.paused": "Paused",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.manual.only": "Manual only",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.schedule.disabled": "Disabled",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run": "Last run",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.summary": "Last run: {value}",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.never": "Never",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.succeeded": "Succeeded",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.failed": "Failed",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.last.run.skipped.no.targets": "Skipped (no targets)",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.next.run": "Next run",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.next.run.summary": "Next run: {value}",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.pause": "Pause",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.resume": "Resume",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.run.now": "Run now",
  "catalog.features.providerScopeDiscovery.ui.schedulePanel.empty": "No provider refresh schedules are configured yet.",
} as const;
