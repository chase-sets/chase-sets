export const catalogSourceObservationsApiDetailMappingEnglishTranslations = {
  "catalog.features.sourceObservations.api.route.source.observation.not.found": "Source observation not found.",
  "catalog.features.sourceObservations.api.route.bulk.job.not.found": "Bulk job was not found.",
  "catalog.features.sourceObservations.api.route.catalog.sync.run.not.found": "Catalog sync run was not found.",
  "catalog.features.sourceObservations.api.route.integration.job.invalid.action": "Unknown integration job action.",
  "catalog.features.sourceObservations.api.route.integration.job.lifecycle.unsupported":
    "Integration job lifecycle command is not available for this job state.",
  "catalog.features.sourceObservations.api.route.integration.job.not.found": "Integration job was not found.",
  "catalog.features.sourceObservations.api.route.telemetry.invalid.event":
    "Unknown Catalog control plane telemetry event.",
  "catalog.features.sourceObservations.api.route.impact.profile.version.required":
    "Provider key and profile version are required for impact analysis.",
  "catalog.features.sourceObservations.api.route.impact.lifecycle.operation.invalid":
    "Lifecycle impact operation must be activation, rollback, deprecate, or retire.",
  "catalog.features.sourceObservations.api.adminControlPlaneOverview.job.summary":
    "{action} job {jobId} is {operatorStatus} ({completed}/{total}).",
  "catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.created":
    "{displayName} profile {profileVersion} was created.",
  "catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.lifecycle":
    "{displayName} profile {profileVersion} is {lifecycle}.",
  "catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.sections.edited":
    "{displayName} profile {profileVersion} sections were edited.",
  "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.reapply.ineligible":
    "{count} matched Source Observations are outside the promoted reapply set.",
  "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.reapply.jobs":
    "{count} active integration or review jobs may overlap this reapply preview.",
  "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.lifecycle.jobs":
    "{count} active integration or review jobs block this profile lifecycle action.",
  "catalog.features.sourceObservations.api.catalogIntegrationImpactAnalysis.lifecycle.retirement.references":
    "{count} Source Observations still reference this profile version.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.requiredUnitMissing":
    "{unitKey} was required for this Catalog scope but no provider profile unit is available.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.providerAdapterMissing":
    "No provider adapter is registered for {providerKey}.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.importPlanningUnavailable":
    "{providerKey} does not expose import planning for this unit.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.credentialReadinessUnavailable":
    "Provider credential readiness could not be verified.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.transportDiagnosticsUnavailable":
    "Provider transport diagnostics could not be verified.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.inactiveProfileUnit":
    "{unitKey} is not an active provider profile unit.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.productDomainMismatch":
    "{unitKey} does not match the {productDomain} Catalog product domain.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.productFormMismatch":
    "{unitKey} does not match the {productForm} Catalog product form.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.referenceUnsupported":
    "{unitKey} does not support {referenceKind} source-scope planning.",
  "catalog.features.sourceObservations.api.catalogSyncScopePlanner.providerScopeMappingMissing":
    "{unitKey} has no accepted provider scope mapping supplying its {coordinate} coordinate for this Catalog scope.",
  "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.multipleExistingCatalogItems":
    "Matched Source Observations point at more than one existing Catalog Item.",
  "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.fieldMismatch":
    "Provider observations disagree about {field}.",
  "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.warning.imageSourceDiffers":
    "Provider image URLs differ; keep image choice reviewable before promotion.",
  "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.mergeIdentityMismatch":
    "Exact external reference matched observations with different merge identities.",
  "catalog.features.sourceObservations.api.catalogMergeCandidateMatcher.conflict.repeatedExternalCatalogItemReference":
    "One provider identifier appears on materially different Source Observation identities.",
  "catalog.features.sourceObservations.ui.detail.card.illustrator": "Card Illustrator",
  "catalog.features.sourceObservations.ui.detail.card.image": "Card image",
  "catalog.features.sourceObservations.ui.detail.card.number": "Card Number",
  "catalog.features.sourceObservations.ui.detail.card.variant": "Card Variant",
  "catalog.features.sourceObservations.ui.detail.external.key": "External Key",
  "catalog.features.sourceObservations.ui.detail.hash": "Hash",
  "catalog.features.sourceObservations.ui.detail.image.note": "Image Note",
  "catalog.features.sourceObservations.ui.detail.language": "Language",
  "catalog.features.sourceObservations.ui.detail.promote": "Promote",
  "catalog.features.sourceObservations.ui.detail.promoted": "Source observation promoted",
  "catalog.features.sourceObservations.ui.detail.promoted.catalog.item": "Promoted Catalog Item",
  "catalog.features.sourceObservations.ui.detail.promotion.plan.fingerprint": "Promotion Plan Fingerprint",
  "catalog.features.sourceObservations.ui.detail.promotion.profile": "Promotion Profile",
  "catalog.features.sourceObservations.ui.detail.product.category": "Product Category",
  "catalog.features.sourceObservations.ui.detail.product.id": "Product ID",
  "catalog.features.sourceObservations.ui.detail.product.line": "Product Line",
  "catalog.features.sourceObservations.ui.detail.provider": "Provider",
  "catalog.features.sourceObservations.ui.detail.rarity": "Rarity",
  "catalog.features.sourceObservations.ui.detail.reject": "Reject",
  "catalog.features.sourceObservations.ui.detail.reject.reason": "Reject Reason",
  "catalog.features.sourceObservations.ui.detail.rejected": "Source observation rejected",
  "catalog.features.sourceObservations.ui.detail.rejected.reason": "Rejected during review.",
  "catalog.features.sourceObservations.ui.detail.release.date": "Release Date",
  "catalog.features.sourceObservations.ui.detail.expansion": "Expansion",
  "catalog.features.sourceObservations.ui.detail.source.observation": "Source Observation",
  "catalog.features.sourceObservations.ui.detail.source.observations": "Source Observations",
  "catalog.features.sourceObservations.ui.detail.source.mapping.fingerprint": "Source Mapping Fingerprint",
  "catalog.features.sourceObservations.ui.detail.source.profile": "Source Profile",
  "catalog.features.sourceObservations.ui.detail.source.url": "Source URL",
  "catalog.features.sourceObservations.ui.detail.status": "Status",
  "catalog.features.sourceObservations.ui.detail.sku.count": "SKU Count",
  "catalog.features.sourceObservations.ui.detail.sku.evidence": "SKU Evidence",
  "catalog.features.sourceObservations.api.providerAdapters.referenceCards.fixture.backed.provider":
    "Reference provider uses fixture-backed payloads and does not require live provider transport.",
  "catalog.features.sourceObservations.api.providerAdapters.referenceCards.credential.not.required":
    "Reference fixture payloads do not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.representativeCatalog.credential.not.required":
    "Accepted Observation Pack replay does not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgdex.json.transport.configured":
    "TCGdex JSON transport is configured for {connectorKind}.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgdex.credential.not.required":
    "TCGdex public JSON transport does not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.mtgjson.credential.not.required":
    "MTGJSON public JSON files do not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.mtgjson.public.json.transport.configured":
    "MTGJSON public v5 JSON transport is configured.",
  "catalog.features.sourceObservations.api.providerAdapters.lorcanajson.credential.not.required":
    "LorcanaJSON public JSON files do not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.lorcanajson.public.json.transport.configured":
    "LorcanaJSON public JSON transport is configured; prefer all-cards and set JSON documents before scoped card fetches.",
  "catalog.features.sourceObservations.api.providerAdapters.lorcast.credential.not.required":
    "Lorcast public API does not require credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.lorcast.public.api.transport.configured":
    "Lorcast public API transport is configured; cache downloaded data for at least 24 hours and pace cold calls around 10 requests per second.",
  "catalog.features.sourceObservations.api.providerAdapters.card.option.label": "{name} #{cardNumber}",
  "catalog.features.sourceObservations.api.providerAdapters.ygoprodeck.credential.not.required":
    "YGOPRODeck public API access does not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.ygoprodeck.public.api.transport.configured":
    "YGOPRODeck public API transport is configured; callers must honor provider rate limits and cache image assets locally.",
  "catalog.features.sourceObservations.api.providerAdapters.ygojson.credential.not.required":
    "YGOJSON public JSON files do not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.ygojson.public.json.transport.configured":
    "YGOJSON public JSON transport is configured.",
  "catalog.features.sourceObservations.api.providerAdapters.scryfall.credential.not.required":
    "Scryfall public API requests do not require provider credentials.",
  "catalog.features.sourceObservations.api.providerAdapters.scryfall.public.api.transport.configured":
    "Scryfall public API transport is configured with caller identification.",
  "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.credential.configured":
    "Shared Scrydex credential readiness is configured with redacted provider headers for One Piece transport.",
  "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.credential.missing":
    "Shared Scrydex credentials are missing for One Piece transport.",
  "catalog.features.sourceObservations.api.providerAdapters.scrydex.onePiece.bulk.first.transport.configured":
    "Scrydex One Piece transport uses paginated expansion, card, and sealed-product list endpoints before any single-item scope.",
  "catalog.features.sourceObservations.api.providerAdapters.scrydex.bulk.first.transport.configured":
    "Scrydex {productLine} bulk-first transport is configured with shared credentials and redacted usage diagnostics.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.automation.client.configured":
    "TCGplayer automation transport is configured for {connectorKind} with profile lifecycle {lifecycle}.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.automation.client.unconfigured":
    "TCGplayer automation transport is not configured in this runtime.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.credential.configured":
    "TCGplayer automation credential/session readiness is configured.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.credential.missing":
    "TCGplayer automation credential/session readiness is missing.",
  "catalog.features.sourceObservations.api.providerAdapters.tcgplayer.domain.rate.limit.policy.configured":
    "TCGplayer domain throttling covers {domains}; retryable statuses are {retryableCodes}.",
  "catalog.features.sourceObservations.api.route.profile.review.unavailable":
    "Provider profile review is not available.",
  "catalog.features.sourceObservations.api.route.profile.review.invalid.json.object":
    "Expected a JSON object request body.",
  "catalog.features.sourceObservations.api.route.profile.review.invalid.json.valid.object":
    "Expected a valid JSON object request body.",
  "catalog.features.sourceObservations.api.route.profile.review.raw.patch.quarantined":
    "Broad Provider Integration Profile patching is quarantined; use section-scoped typed commands for normal authoring.",
  "catalog.features.sourceObservations.api.route.bulk.deferral.requires.selection.or.scope":
    "Bulk deferral requires selected observations or an explicit review scope.",
  "catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason": "Bulk rejection requires a reason.",
  "catalog.features.sourceObservations.api.route.rejection.requires.reason": "Rejection requires a reason.",
  "catalog.features.sourceObservations.api.route.merge.candidate.promote.requires.reason":
    "Promotion requires a reason.",
  "catalog.features.sourceObservations.api.route.merge.candidate.split.requires.reason": "Split requires a reason.",
  "catalog.features.sourceObservations.api.route.merge.candidate.split.requires.snapshots":
    "Split requires remainingSnapshot, splitCandidateId, and splitSnapshot.",
  "catalog.features.sourceObservations.api.route.merge.candidate.update.requires.reason": "Update requires a reason.",
  "catalog.features.sourceObservations.api.route.merge.candidate.update.requires.snapshot":
    "Update requires a candidate snapshot.",
  "catalog.features.sourceObservations.api.route.merge.candidate.ignore.requires.reason": "Ignore requires a reason.",
  "catalog.features.sourceObservations.api.route.merge.candidate.defer.requires.reason": "Deferral requires a reason.",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.add.expression": "Add expression",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.add.field": "Add field",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.add.selector": "Add selector",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.add.transform": "Add transform",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.allow.empty": "Allow empty",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.allow.null": "Allow null",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.array": "Array",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.array.items": "Array items",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.array.map": "Array map",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.array.path": "Array path",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.boolean": "Boolean",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.catalog.merge.evidence": "Catalog merge evidence",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.catalog.truth": "Catalog truth",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.coalesce": "Coalesce",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.coerce": "Coerce",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.coerce.to": "Coerce to",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.constant": "Constant",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.constant.json": "Constant JSON",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.diagnostic": "Diagnostic",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.down": "Down",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.duplicate": "Duplicate",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.empty.policy": "Empty policy",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.evidence.owner": "Evidence owner",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.excluded": "Excluded",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.expression": "Expression",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.external.reference": "External reference",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.fallback.selectors": "Fallback selectors",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.field.key": "Field key",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.fixture.preview": "Fixture Preview",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.inventory.signal": "Inventory signal",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.json.array": "JSON array",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.json.object": "JSON object",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.lookup": "Lookup",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.lookup.table": "Lookup table",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.lowercase": "Lowercase",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.named.runtime.selector": "Named runtime selector",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.named.transform": "Named transform",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.none": "None",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.normalize.provider.option":
    "Normalize provider option",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.null.policy": "Null policy",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.number": "Number",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.object": "Object",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.object.fields": "Object fields",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.omit": "Omit",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.operations": "Operations",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.path": "Path",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.price": "Price",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.pricing.signal": "Pricing signal",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.redaction": "Redaction",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.remove": "Remove",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.required.coalesce.result": "Required coalesce result",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.required.path": "Required path",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.required.template.result": "Required template result",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.review.evidence": "Review evidence",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.runtime.selector": "Runtime selector",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.scrydex.tcgplayer.id.reference.extractor":
    "Scrydex TCGplayer ID reference extractor",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.secret": "Secret",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.selector": "Selector",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.selector.kind": "Selector kind",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.selector.reason": "Selector reason",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.seller": "Seller",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.slug": "Slug",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.string": "String",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.string.operation": "String operation",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.string.transform": "String transform",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.card.variant.expander":
    "TCGdex card variant expander",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.marketplace.reference.extractor":
    "TCGdex marketplace reference extractor",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.pokemon.promotion.command.plan":
    "TCGdex Pokemon promotion command plan",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.pokemon.reference.hierarchy":
    "TCGdex Pokemon reference hierarchy",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.product.barcode":
    "TCGplayer product barcode",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.product.form": "TCGplayer product form",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.sku.selected.option.resolver":
    "TCGplayer SKU selected option resolver",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.template": "Template",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.template.values": "Template values",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.transform": "Transform",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.function": "Transform function",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.kind": "Transform kind",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.reason": "Transform reason",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.transforms": "Transforms",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.trim": "Trim",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.unknown.policy": "Unknown policy",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.up": "Up",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.uppercase": "Uppercase",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.value.expression.value":
    "{value0} expression {value1}",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.value.item": "{value} item",
  "catalog.features.sourceObservations.ui.mappingExpressionEditor.value.value": "{value0}.{value1}",
} as const;
