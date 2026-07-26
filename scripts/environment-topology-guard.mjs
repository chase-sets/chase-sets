import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const registryPath = "scripts/environment-hosts.json";
const schemaPath = "scripts/environment-hosts.schema.json";
const documentationPath = "docs/architecture/environment-domain-names.md";
const documentationStart = "<!-- environment-hosts:start -->";
const documentationEnd = "<!-- environment-hosts:end -->";

function normalizeSource(source) {
  return source.replaceAll("\r\n", "\n");
}

const appServingRecordNamesPattern =
  /  app_serving_record_names = local\.is_staging \? toset\(\[\n(?<staging>(?:    "[a-z]+",\n)*)    \]\) : local\.is_production \? toset\(concat\(\n    \[(?<production>(?:"[a-z]+",? ?)*)\],\n    local\.marketplace_public_enabled \? \[(?<productionConditional>(?:"[a-z]+",? ?)*)\] : \[\],\n  \)\) : toset\(\[\]\)/;

const authorityAnchors = [
  {
    id: "A1",
    file: "infrastructure/digitalocean/platform/locals.tf",
    symbol: "environment_zone, live_dns_zone",
    fragments: [
      '  environment_zone    = "${var.environment}.${var.root_domain}"\n' +
        "  live_dns_zone       = local.is_production ? var.root_domain : local.environment_zone",
    ],
  },
  {
    id: "A2",
    file: "infrastructure/digitalocean/platform/locals.tf",
    symbol: "app_serving_record_names",
    pattern: appServingRecordNamesPattern,
    perturbationText: "app_serving_record_names = local.is_staging ?",
  },
  {
    id: "A3",
    file: "infrastructure/digitalocean/platform/main.tf",
    symbol: "digitalocean_record.app_serving",
    fragments: [
      'resource "digitalocean_record" "app_serving" {\n' +
        "  for_each = local.app_serving_record_names\n\n" +
        "  domain = local.live_dns_zone\n" +
        '  type   = "A"\n' +
        "  name   = each.value\n" +
        "  value  = var.doks_ingress_target\n" +
        "  ttl    = var.doks_ingress_ttl\n" +
        "}",
    ],
  },
  {
    id: "A4",
    file: "infrastructure/digitalocean/platform/main.tf",
    symbol: "digitalocean_record.doks_apex",
    fragments: [
      'resource "digitalocean_record" "doks_apex" {\n' +
        "  count = local.is_staging || local.is_production ? 1 : 0\n\n" +
        "  domain = local.live_dns_zone\n" +
        '  type   = "A"\n' +
        '  name   = "@"\n' +
        "  value  = var.doks_ingress_target\n" +
        "  ttl    = var.doks_ingress_ttl\n" +
        "}",
    ],
  },
  {
    id: "A5",
    file: "infrastructure/digitalocean/environment-dns/locals.tf",
    symbol: "environment_zone",
    fragments: ['  environment_zone = local.is_production ? var.root_domain : "${var.environment}.${var.root_domain}"'],
  },
  {
    id: "A6",
    file: "infrastructure/digitalocean/environment-dns/locals.tf",
    symbol: "doks_diagnostic_records",
    fragments: [
      "  doks_diagnostic_records = local.doks_ingress_target_configured ? merge(\n" +
        "    {\n" +
        '      apex  = { name = "doks", fqdn = "doks.${local.environment_zone}" }\n' +
        '      www   = { name = "www.doks", fqdn = "www.doks.${local.environment_zone}" }\n' +
        '      admin = { name = "admin.doks", fqdn = "admin.doks.${local.environment_zone}" }\n' +
        "    },\n" +
        "    local.is_staging || var.production_marketplace_public_enabled ? {\n" +
        '      marketplace = { name = "marketplace.doks", fqdn = "marketplace.doks.${local.environment_zone}" }\n' +
        "    } : {},\n" +
        "  ) : {}",
    ],
  },
  {
    id: "A7",
    file: "infrastructure/digitalocean/environment-dns/main.tf",
    symbol: "digitalocean_domain.environment",
    fragments: [
      'resource "digitalocean_domain" "environment" {\n' +
        "  count = local.is_staging ? 1 : 0\n\n" +
        "  name = local.environment_zone\n\n" +
        "  lifecycle {\n" +
        "    prevent_destroy = true\n" +
        "  }\n" +
        "}",
    ],
  },
  {
    id: "A8",
    file: "infrastructure/digitalocean/environment-dns/main.tf",
    symbol: "digitalocean_record.delegation",
    fragments: [
      'resource "digitalocean_record" "delegation" {\n' +
        "  for_each = local.is_staging ? toset(local.nameservers) : toset([])\n\n" +
        "  domain = var.root_domain\n" +
        '  type   = "NS"\n' +
        "  name   = var.environment\n" +
        "  value  = each.value\n" +
        "  ttl    = 1800\n" +
        "}",
    ],
  },
  {
    id: "A9",
    file: "infrastructure/digitalocean/environment-dns/main.tf",
    symbol: "digitalocean_record.catalog_assets",
    fragments: [
      'resource "digitalocean_record" "catalog_assets" {\n' +
        "  count = local.is_staging ? 1 : 0\n\n" +
        "  domain = digitalocean_domain.environment[0].name\n" +
        '  type   = "CNAME"\n' +
        '  name   = "assets"\n' +
        "  value  = local.catalog_asset_cdn_endpoint\n" +
        "  ttl    = 3600\n" +
        "}",
    ],
  },
  {
    id: "A10",
    file: "infrastructure/digitalocean/observability/locals.tf",
    symbol: "endpoint_names, environment_zones",
    fragments: [
      "  environment_zones = {\n" +
        "    for environment in var.observability_environments :\n" +
        '    environment => environment == "production" ? var.root_domain : "${environment}.${var.root_domain}"\n' +
        "  }",
      '  endpoint_names       = toset(["grafana", "otel", "prometheus"])',
    ],
  },
  {
    id: "A11",
    file: "scripts/digitalocean-preview-cleanup-sweep.mjs",
    symbol: "PREVIEW_DNS_BASE_DOMAIN, PREVIEW_DNS_ENVIRONMENT_LABEL, PREVIEW_SHARED_DNS_FQDN",
    fragments: [
      'export const PREVIEW_DNS_BASE_DOMAIN = "chasesets.com";',
      'export const PREVIEW_DNS_ENVIRONMENT_LABEL = "preview";',
      "export const PREVIEW_SHARED_DNS_FQDN = `*.${PREVIEW_DNS_ENVIRONMENT_LABEL}.${PREVIEW_DNS_BASE_DOMAIN}`;",
    ],
  },
  {
    id: "A12",
    file: "scripts/render-platform-helm-values.mjs",
    symbol: "previewEnvironmentZone, buildPreviewDoksIngressHosts",
    fragments: [
      'const previewEnvironmentZone = "preview.chasesets.com";',
      "function buildPreviewDoksIngressHosts(previewIdentifier) {\n" +
        "  return [\n" +
        "    {\n" +
        "      host: `${previewIdentifier}.${previewEnvironmentZone}`,\n" +
        '      paths: doksIngressPaths("public-web"),\n' +
        "    },\n" +
        "    {\n" +
        "      host: `${previewIdentifier}-marketplace.${previewEnvironmentZone}`,\n" +
        '      paths: doksIngressPaths("marketplace"),\n' +
        "    },\n" +
        "    {\n" +
        "      host: `${previewIdentifier}-admin.${previewEnvironmentZone}`,\n" +
        '      paths: doksIngressPaths("admin-web"),\n' +
        "    },\n" +
        "  ];\n" +
        "}",
    ],
    derivedPreviewPrefixes: ["pr-N", "pr-N-marketplace", "pr-N-admin"],
  },
];

function finding(code, path, message, details = {}) {
  return { code, path, message: `${path} [${code}] ${message}`, ...details };
}

function readAnchor(root, anchor) {
  let source;
  try {
    source = normalizeSource(readFileSync(resolve(root, anchor.file), "utf8"));
  } catch (error) {
    return {
      error: finding(
        "topology-authority-unreadable",
        anchor.file,
        `${anchor.id} (${anchor.symbol}) is unreadable: ${error.message}`,
        { anchorId: anchor.id },
      ),
    };
  }
  const matchedSource = anchor.pattern?.exec(source)?.[0];
  const missing = anchor.fragments?.find((fragment) => !source.includes(fragment));
  if ((anchor.pattern && !matchedSource) || missing) {
    return {
      error: finding(
        "topology-authority-diverged",
        anchor.file,
        `${anchor.id} (${anchor.symbol}) no longer matches its pinned structural pattern.`,
        { anchorId: anchor.id },
      ),
    };
  }
  return { sourceText: matchedSource ?? anchor.fragments.join("\n---\n") };
}

function sourceCitation(anchorSources, ...anchorIds) {
  return anchorIds.map((anchorId) => ({ anchorId, sourceText: anchorSources.get(anchorId) }));
}

export function deriveEnvironmentHosts(root) {
  const violations = [];
  const anchorSources = new Map();
  for (const anchor of authorityAnchors) {
    const result = readAnchor(root, anchor);
    if (result.error) violations.push(result.error);
    else anchorSources.set(anchor.id, result.sourceText);
  }
  if (violations.length > 0) return { hosts: [], violations, artifact: null };

  const rootDomain = anchorSources.get("A11").match(/PREVIEW_DNS_BASE_DOMAIN = "([^"]+)"/)?.[1];
  const previewLabel = anchorSources.get("A11").match(/PREVIEW_DNS_ENVIRONMENT_LABEL = "([^"]+)"/)?.[1];
  const previewZone = anchorSources.get("A12").match(/previewEnvironmentZone = "([^"]+)"/)?.[1];
  const stagingZone = `staging.${rootDomain}`;
  const add = (hosts, host, environment, hostClass, templated, authorityAnchor, anchors) => {
    hosts.push({
      host,
      environment,
      class: hostClass,
      templated,
      authorityAnchor,
      sources: sourceCitation(anchorSources, ...anchors),
    });
  };
  const hosts = [];

  const servingMatch = appServingRecordNamesPattern.exec(anchorSources.get("A2"));
  const quotedNames = (text) => [...text.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  const servingNames = {
    staging: quotedNames(servingMatch.groups.staging),
    production: [
      ...quotedNames(servingMatch.groups.production),
      ...quotedNames(servingMatch.groups.productionConditional),
    ],
  };
  for (const environment of ["production", "staging"]) {
    const zone = environment === "production" ? rootDomain : stagingZone;
    for (const name of servingNames[environment]) {
      add(hosts, `${name}.${zone}`, environment, "application", false, "A3", ["A1", "A2", "A3"]);
    }
    add(hosts, zone, environment, "application", false, "A4", ["A1", "A4"]);
  }

  const assetRecordName = anchorSources.get("A9").match(/  name   = "([^"]+)"/)?.[1];
  add(hosts, `${assetRecordName}.${stagingZone}`, "staging", "service", false, "A9", ["A5", "A7", "A8", "A9"]);

  const diagnosticNames = [...anchorSources.get("A6").matchAll(/name = "([^"]+)"/g)].map((match) => match[1]);
  for (const environment of ["production", "staging"]) {
    const zone = environment === "production" ? rootDomain : stagingZone;
    for (const name of diagnosticNames) {
      add(hosts, `${name}.${zone}`, environment, "diagnostic", false, "A6", ["A5", "A6", "A7"]);
    }
  }

  const endpointNames = [
    ...anchorSources
      .get("A10")
      .match(/endpoint_names\s+= toset\(\[([^\]]+)\]\)/)?.[1]
      .matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  for (const environment of ["production", "staging"]) {
    const zone = environment === "production" ? rootDomain : stagingZone;
    for (const name of endpointNames) {
      add(hosts, `${name}.${zone}`, environment, "service", false, "A10", ["A10"]);
    }
  }

  add(hosts, `*.${previewLabel}.${rootDomain}`, "preview", "service", true, "A11", ["A11"]);
  const previewPrefixes = authorityAnchors.find((anchor) => anchor.id === "A12").derivedPreviewPrefixes;
  for (const prefix of previewPrefixes) {
    add(hosts, `${prefix}.${previewZone}`, "preview", "application", true, "A12", ["A11", "A12"]);
  }

  hosts.sort((left, right) => left.host.localeCompare(right.host));
  return {
    hosts,
    violations,
    artifact: {
      rootDomain,
      hosts,
      excludedAuthoritySources: [
        {
          file: "infrastructure/digitalocean/platform/locals.tf",
          lines: "public_domains, marketplace_domains, admin_domain preview branches",
          reason:
            "The branches express forbidden two-label preview hosts; A11 and A12 are the pinned preview authority.",
        },
      ],
    },
  };
}

function typeMatches(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  if (schema.oneOf) {
    const alternatives = schema.oneOf.map((alternative) => validateAgainstSchema(value, alternative, path));
    const matches = alternatives.filter((alternativeErrors) => alternativeErrors.length === 0);
    if (matches.length !== 1) errors.push(`${path} must match exactly one schema alternative.`);
    return errors;
  }
  if (schema.type && !typeMatches(value, schema.type)) return [`${path} must be ${schema.type}.`];
  if (Object.hasOwn(schema, "const") && value !== schema.const) errors.push(`${path} must equal ${schema.const}.`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}.`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push(`${path} does not match ${schema.pattern}.`);
    if (
      schema.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        Number.isNaN(Date.parse(value)))
    ) {
      errors.push(`${path} must be a timezone-bearing RFC3339 instant.`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be at least ${schema.minimum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items.`);
    for (const [index, item] of value.entries()) {
      errors.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`));
    }
  } else if (value !== null && typeof value === "object") {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key])
        errors.push(...validateAgainstSchema(item, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed.`);
    }
  }
  return errors;
}

function loadRegistry(root) {
  let schema;
  let registry;
  try {
    schema = JSON.parse(readFileSync(resolve(root, schemaPath), "utf8"));
    registry = JSON.parse(readFileSync(resolve(root, registryPath), "utf8"));
  } catch (error) {
    return { error: finding("topology-registry-invalid", error.path ?? registryPath, error.message) };
  }
  const errors = validateAgainstSchema(registry, schema);
  if (errors.length > 0) {
    return {
      error: finding("topology-registry-invalid", registryPath, `Schema validation failed: ${errors.join(" ")}`),
    };
  }
  return { registry };
}

export function renderEnvironmentHosts(registry) {
  const rows = [...registry.hosts]
    .sort(
      (left, right) =>
        left.environment.localeCompare(right.environment) ||
        left.status.localeCompare(right.status) ||
        left.host.localeCompare(right.host),
    )
    .map((entry) => {
      const authority =
        entry.status === "current"
          ? entry.authorityAnchor
          : entry.status === "reserved"
            ? entry.reservedFor
            : `${entry.retiredIn} (${entry.retiredOn})`;
      return `| \`${entry.host}\` | ${entry.status} | ${entry.environment} | ${entry.class} | ${authority} |`;
    });
  return [
    documentationStart,
    "| Host | Status | Environment | Class | Authority / disposition |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    documentationEnd,
  ].join("\n");
}

function reconcileRegistry(root, registry, derivation) {
  const violations = [];
  if (registry.rootDomain !== derivation.rootDomain) {
    violations.push(
      finding(
        "topology-inventory-diverged",
        registryPath,
        `rootDomain '${registry.rootDomain}' does not equal derived '${derivation.rootDomain}'.`,
      ),
    );
  }
  const duplicateHosts = registry.hosts
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.host === entry.host) !== index)
    .map((entry) => entry.host);
  if (duplicateHosts.length > 0) {
    violations.push(
      finding(
        "topology-inventory-diverged",
        registryPath,
        `Host statuses are not disjoint; duplicate hosts: ${[...new Set(duplicateHosts)].join(", ")}.`,
      ),
    );
  }
  const derivedByHost = new Map(derivation.hosts.map((entry) => [entry.host, entry]));
  const currentByHost = new Map(
    registry.hosts.filter((entry) => entry.status === "current").map((entry) => [entry.host, entry]),
  );
  const missing = [...derivedByHost.keys()].filter((host) => !currentByHost.has(host));
  const extra = [...currentByHost.keys()].filter((host) => !derivedByHost.has(host));
  if (missing.length > 0 || extra.length > 0) {
    violations.push(
      finding(
        "topology-inventory-diverged",
        registryPath,
        `Current hosts must equal the derived inventory; missing: ${missing.join(", ") || "(none)"}; ` +
          `not derived: ${extra.join(", ") || "(none)"}.`,
      ),
    );
  }
  for (const [host, entry] of currentByHost) {
    const derived = derivedByHost.get(host);
    if (derived && !derived.sources.some((source) => source.anchorId === entry.authorityAnchor)) {
      violations.push(
        finding(
          "topology-inventory-diverged",
          registryPath,
          `${host} cites ${entry.authorityAnchor}, which is absent from its derivation artifact.`,
        ),
      );
    }
    if (
      derived &&
      (entry.environment !== derived.environment ||
        entry.class !== derived.class ||
        entry.templated !== derived.templated)
    ) {
      violations.push(
        finding(
          "topology-inventory-diverged",
          registryPath,
          `${host} metadata must equal its derivation: environment=${derived.environment}, ` +
            `class=${derived.class}, templated=${derived.templated}.`,
        ),
      );
    }
  }
  const duplicateSanctions = registry.sanctionedReferences
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.path === entry.path && candidate.token === entry.token) !== index,
    )
    .map((entry) => `${entry.path}:${entry.token}`);
  if (duplicateSanctions.length > 0) {
    violations.push(
      finding(
        "topology-sanction-stale",
        registryPath,
        `Sanction path/token pairs must be unique: ${[...new Set(duplicateSanctions)].join(", ")}.`,
      ),
    );
  }

  let documentation;
  try {
    documentation = normalizeSource(readFileSync(resolve(root, documentationPath), "utf8"));
  } catch (error) {
    violations.push(finding("topology-doc-diverged", documentationPath, error.message));
    return violations;
  }
  const startIndex = documentation.indexOf(documentationStart);
  const endIndex = documentation.indexOf(documentationEnd);
  const actual =
    startIndex >= 0 && endIndex >= startIndex
      ? documentation.slice(startIndex, endIndex + documentationEnd.length)
      : null;
  const expected = renderEnvironmentHosts(registry);
  if (actual !== expected) {
    violations.push(
      finding(
        "topology-doc-diverged",
        documentationPath,
        "The rendered environment-hosts block does not equal the registry rendering.",
      ),
    );
  }
  return violations;
}

function tokenInventory(registry) {
  const tokens = [];
  for (const entry of registry.hosts) {
    if (
      entry.templated ||
      (entry.status !== "retired" && !(entry.status === "current" && entry.class === "diagnostic"))
    ) {
      continue;
    }
    const candidates = [entry.host];
    const suffix = `.${registry.rootDomain}`;
    if (entry.host.endsWith(suffix)) {
      const subName = entry.host.slice(0, -suffix.length);
      if (subName.includes(".")) candidates.push(subName);
    }
    for (const token of candidates) tokens.push({ token: token.toLowerCase(), entry });
  }
  tokens.sort((left, right) => left.token.localeCompare(right.token));
  return tokens;
}

function asciiLower(buffer) {
  const lowered = Buffer.from(buffer);
  for (let index = 0; index < lowered.length; index += 1) {
    if (lowered[index] >= 65 && lowered[index] <= 90) lowered[index] += 32;
  }
  return lowered;
}

function countBytes(buffer, token) {
  const needle = Buffer.from(token, "ascii");
  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - needle.length) {
    const index = buffer.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function discoverTrackedFiles(root) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      error: finding(
        "topology-corpus-discovery-failed",
        ".",
        `git ls-files failed: ${error.stderr?.toString().trim() || error.message}`,
      ),
    };
  }
  const files = output
    .subarray(0, output.length > 0 && output.at(-1) === 0 ? -1 : undefined)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (files.length === 0) {
    return { error: finding("topology-corpus-empty", ".", "git ls-files returned zero tracked files.") };
  }
  return { files };
}

function sweepCorpus(root, registry) {
  const violations = [];
  const tokenTable = tokenInventory(registry).map((descriptor) => ({
    ...descriptor,
    hits: [],
    hitCount: 0,
    sanctionedCount: 0,
    violationCount: 0,
  }));
  const discovery = discoverTrackedFiles(root);
  if (discovery.error) {
    return { violations: [discovery.error], trackedFiles: 0, sweptFiles: 0, tokenTable };
  }
  const sanctions = new Map(
    registry.sanctionedReferences.map((entry) => [`${entry.path}\0${entry.token.toLowerCase()}`, entry]),
  );
  const observed = new Map();
  let sweptFiles = 0;
  for (const path of discovery.files) {
    let bytes;
    try {
      bytes = readFileSync(resolve(root, path));
    } catch (error) {
      violations.push(finding("topology-corpus-unreadable", path, error.message));
      continue;
    }
    sweptFiles += 1;
    const lowered = asciiLower(bytes);
    for (const descriptor of tokenTable) {
      const occurrences = countBytes(lowered, descriptor.token);
      if (occurrences === 0) continue;
      const key = `${path}\0${descriptor.token}`;
      observed.set(key, occurrences);
      descriptor.hitCount += occurrences;
      const selfReference = path === registryPath;
      const sanction = sanctions.get(key);
      const sanctioned = selfReference || sanction?.occurrences === occurrences;
      descriptor.hits.push({
        path,
        occurrences,
        disposition: selfReference ? "registry-self-reference" : sanctioned ? "sanctioned" : "violation",
      });
      if (sanctioned) descriptor.sanctionedCount += occurrences;
      else {
        descriptor.violationCount += occurrences;
        const code = descriptor.entry.status === "retired" ? "retired-host-referenced" : "diagnostic-host-referenced";
        violations.push(
          finding(code, path, `'${descriptor.token}' occurs ${occurrences} time(s) without an exact sanction.`, {
            token: descriptor.token,
            occurrences,
          }),
        );
      }
    }
  }
  for (const sanction of registry.sanctionedReferences) {
    const actual = observed.get(`${sanction.path}\0${sanction.token.toLowerCase()}`) ?? 0;
    if (actual !== sanction.occurrences || !discovery.files.includes(sanction.path)) {
      violations.push(
        finding(
          "topology-sanction-stale",
          sanction.path,
          `Sanction for '${sanction.token}' requires exactly ${sanction.occurrences} occurrence(s); observed ${actual}.`,
          { token: sanction.token, expected: sanction.occurrences, actual },
        ),
      );
    }
  }
  return { violations, trackedFiles: discovery.files.length, sweptFiles, tokenTable };
}

function emptyReport(violations) {
  return {
    passed: false,
    violations,
    derivationArtifact: null,
    corpus: {
      sweptFiles: 0,
      trackedFiles: 0,
      tokenCount: 0,
      hitCount: 0,
      sanctionedCount: 0,
      violationCount: violations.length,
      tokens: [],
    },
  };
}

export function checkEnvironmentTopology({ root = process.cwd() } = {}) {
  const derivation = deriveEnvironmentHosts(root);
  if (derivation.violations.length > 0) return emptyReport(derivation.violations);
  const loaded = loadRegistry(root);
  if (loaded.error) return emptyReport([loaded.error]);
  const reconciliationViolations = reconcileRegistry(root, loaded.registry, derivation.artifact);
  const sweep = sweepCorpus(root, loaded.registry);
  const violations = [...reconciliationViolations, ...sweep.violations];
  const hitCount = sweep.tokenTable.reduce((total, token) => total + token.hitCount, 0);
  const sanctionedCount = sweep.tokenTable.reduce((total, token) => total + token.sanctionedCount, 0);
  return {
    passed: violations.length === 0,
    violations,
    derivationArtifact: derivation.artifact,
    corpus: {
      sweptFiles: sweep.sweptFiles,
      trackedFiles: sweep.trackedFiles,
      tokenCount: sweep.tokenTable.length,
      hitCount,
      sanctionedCount,
      violationCount: sweep.tokenTable.reduce((total, token) => total + token.violationCount, 0),
      tokens: sweep.tokenTable.map((descriptor) => ({
        token: descriptor.token,
        originatingHost: descriptor.entry.host,
        status: descriptor.entry.status,
        class: descriptor.entry.class,
        hitCount: descriptor.hitCount,
        sanctionedCount: descriptor.sanctionedCount,
        violationCount: descriptor.violationCount,
        hits: descriptor.hits,
      })),
    },
  };
}

function printHuman(report) {
  const { corpus } = report;
  console.log(
    `environment-topology: ${report.passed ? "PASS" : "FAIL"} ` +
      `sweptFiles=${corpus.sweptFiles} trackedFiles=${corpus.trackedFiles} tokens=${corpus.tokenCount} ` +
      `hits=${corpus.hitCount} sanctioned=${corpus.sanctionedCount} violations=${corpus.violationCount}`,
  );
  for (const violation of report.violations) console.error(violation.message);
  if (report.derivationArtifact) {
    console.log("derivationArtifact:");
    console.log(JSON.stringify(report.derivationArtifact, null, 2));
    console.log("tokenTable:");
    console.log(JSON.stringify(report.corpus.tokens, null, 2));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = checkEnvironmentTopology();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.passed) process.exitCode = 1;
}

export { authorityAnchors };
