import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const manifestRelativePath = "scripts/environment-topology-manifest.json";
const schemaRelativePath = "scripts/environment-topology-manifest.schema.json";
const previewDnsSourceRelativePath = "scripts/digitalocean-preview-cleanup-sweep.mjs";
const topologyViolationCode = "topology-assertion-undeclared";
const zoneViolationCode = "topology-zone-shape-contradiction";
const unresolvableViolationCode = "topology-assertion-unresolvable";
const ignoredDirectoryReasons = {
  ".git": "Git object and worktree metadata is not executable repository source.",
  node_modules: "Installed third-party dependencies are outside repository-owned topology assertions.",
  ".pnpm-store": "The package-manager content-addressed cache is outside repository-owned source.",
  coverage: "Generated coverage output is derived from scanned source.",
  artifacts: "Generated verification evidence is output, not an executable topology gate.",
};
const ignoredDirectoryNames = new Set(Object.keys(ignoredDirectoryReasons));
const scriptExtensions = new Set([".js", ".cjs", ".mjs", ".ts", ".sh", ".ps1"]);
const vitestImportPattern = /(?:from\s+["']vitest["']|require\(["']vitest["']\))/;
const vitestExclusionReason =
  "Vitest-importing scripts are test modules containing intentional negative-control fixtures; " +
  "the script test battery executes them, while the topology guard scans executable non-test scripts.";

function violation(code, file, message, line = null) {
  return { code, file, line, message: `${file}${line === null ? "" : `:${line}`} [${code}] ${message}` };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) errors.push(`${path}[${index}] must be a non-empty string.`);
    if (seen.has(item)) errors.push(`${path} contains duplicate '${item}'.`);
    seen.add(item);
  }
}

export function validateEnvironmentTopologyManifest(manifest) {
  const errors = [];
  const exactKeys = (value, expected, path) => {
    if (!isPlainObject(value)) {
      errors.push(`${path} must be an object.`);
      return false;
    }
    const extras = Object.keys(value).filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !(key in value));
    for (const key of extras) errors.push(`${path} has unknown property '${key}'.`);
    for (const key of missing) errors.push(`${path} is missing '${key}'.`);
    return extras.length === 0 && missing.length === 0;
  };

  if (!exactKeys(manifest, ["schemaVersion", "rootDomain", "terraformSource", "environments"], "manifest")) {
    return errors;
  }
  if (manifest.schemaVersion !== 1) errors.push("manifest.schemaVersion must equal 1.");
  if (manifest.rootDomain !== "chasesets.com") errors.push("manifest.rootDomain must equal 'chasesets.com'.");
  if (
    exactKeys(manifest.terraformSource, ["locals", "records"], "manifest.terraformSource") &&
    (manifest.terraformSource.locals !== "infrastructure/digitalocean/environment-dns/locals.tf" ||
      manifest.terraformSource.records !== "infrastructure/digitalocean/environment-dns/main.tf")
  ) {
    errors.push("manifest.terraformSource must name the canonical environment-dns locals and records files.");
  }
  if (!isPlainObject(manifest.environments)) {
    errors.push("manifest.environments must be an object.");
    return errors;
  }
  const environmentNames = ["production", "staging", "dev", "preview"];
  exactKeys(manifest.environments, environmentNames, "manifest.environments");
  const managers = new Set(["digitalocean-platform-root", "digitalocean-environment-dns", "dynamic-platform"]);
  for (const environmentName of environmentNames) {
    const environment = manifest.environments[environmentName];
    if (
      !exactKeys(
        environment,
        ["dnsZones", "applicationHosts", "serviceHosts", "diagnosticHosts"],
        `manifest.environments.${environmentName}`,
      )
    ) {
      continue;
    }
    if (!Array.isArray(environment.dnsZones) || environment.dnsZones.length === 0) {
      errors.push(`manifest.environments.${environmentName}.dnsZones must be a non-empty array.`);
    } else {
      for (const [index, zone] of environment.dnsZones.entries()) {
        const path = `manifest.environments.${environmentName}.dnsZones[${index}]`;
        if (!exactKeys(zone, ["name", "managedBy", "delegatedFrom"], path)) continue;
        if (typeof zone.name !== "string" || zone.name.length === 0) errors.push(`${path}.name must be non-empty.`);
        if (!managers.has(zone.managedBy)) errors.push(`${path}.managedBy is not recognized.`);
        if (zone.delegatedFrom !== null && typeof zone.delegatedFrom !== "string") {
          errors.push(`${path}.delegatedFrom must be a string or null.`);
        }
      }
    }
    validateStringArray(environment.applicationHosts, `${environmentName}.applicationHosts`, errors);
    validateStringArray(environment.serviceHosts, `${environmentName}.serviceHosts`, errors);
    validateStringArray(environment.diagnosticHosts, `${environmentName}.diagnosticHosts`, errors);
  }
  return errors;
}

function readJson(root, path, code) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) {
    throw new Error(`[${code}] required file is absent: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`[${code}] ${path} is not valid JSON: ${error.message}`);
  }
}

export function loadEnvironmentTopology(root = process.cwd()) {
  const schema = readJson(root, schemaRelativePath, "topology-schema-absent");
  if (
    schema?.additionalProperties !== false ||
    schema?.$defs?.environment?.additionalProperties !== false ||
    schema?.$defs?.environment?.properties?.dnsZones?.items?.additionalProperties !== false
  ) {
    throw new Error("[topology-schema-open] environment topology schema must reject unknown properties.");
  }
  const manifest = readJson(root, manifestRelativePath, "topology-manifest-absent");
  const errors = validateEnvironmentTopologyManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`[topology-manifest-schema-invalid] ${errors.join(" ")}`);
  }
  return manifest;
}

function walkFiles(directory, predicate, files = []) {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

function primaryCandidateFiles(root) {
  const files = new Set();
  for (const directory of [".github/workflows", ".github/actions"]) {
    for (const file of walkFiles(resolve(root, directory), (path) => /\.ya?ml$/i.test(path))) files.add(file);
  }
  for (const file of walkFiles(resolve(root, "scripts"), (path) => scriptExtensions.has(extname(path).toLowerCase()))) {
    files.add(file);
  }
  return [...files].sort();
}

function semanticWorkflowFiles(root, primaryFiles) {
  const primary = new Set(primaryFiles);
  return walkFiles(
    root,
    (path) => {
      if (primary.has(path) || !/\.ya?ml$/i.test(path)) return false;
      let source;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        return false;
      }
      try {
        const parsed = parseWorkflow(source, relative(root, path).replaceAll("\\", "/"));
        const jobs = isPlainObject(parsed?.jobs) ? Object.values(parsed.jobs) : [];
        const triggers = parsed?.on;
        const reusable =
          triggers === "workflow_call" ||
          (Array.isArray(triggers) && triggers.includes("workflow_call")) ||
          (isPlainObject(triggers) && Object.hasOwn(triggers, "workflow_call"));
        const workflowJobs = jobs.some(
          (job) => isPlainObject(job) && (Array.isArray(job.steps) || typeof job.uses === "string"),
        );
        const compositeAction = isPlainObject(parsed?.runs) && parsed.runs.using === "composite";
        return reusable || workflowJobs || compositeAction;
      } catch {
        return (
          (/^\s*jobs:\s*$/m.test(source) && (/^\s+steps:\s*$/m.test(source) || /^\s+uses:\s*\S+/m.test(source))) ||
          (/^\s*(?:on:\s*)?workflow_call:\s*$/m.test(source) && /^\s*jobs:\s*$/m.test(source)) ||
          (/^\s*runs:\s*$/m.test(source) && /^\s+using:\s*composite\s*$/m.test(source))
        );
      }
    },
    [],
  ).sort();
}

function lineNumber(source, needle) {
  const index = source.indexOf(needle);
  return index < 0 ? null : source.slice(0, index).split(/\r?\n/).length;
}

function normalizeDynamicHostText(value) {
  return value
    .replace(/\$\{\{([\s\S]*?)\}\}/g, (_expression, contents) =>
      contents.includes("chasesets.com") ? contents : "{slug}",
    )
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "{slug}")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "{slug}")
    .replace(/\\\r?\n/g, "")
    .replace(/["'`]\s*\+\s*["'`]/g, "")
    .replace(/["'`]\s*["'`]/g, "");
}

function expandStaticReferences(value, assignments) {
  let expanded = value;
  for (let pass = 0; pass <= assignments.size; pass += 1) {
    const next = expanded.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)\b/g,
      (reference, braced, unbraced) => assignments.get(braced ?? unbraced) ?? reference,
    );
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

function expandStaticScalarValues(value) {
  const assignments = shellAssignments(value);
  let variants = [value];
  for (const match of value.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z0-9_. -]+);\s*do/g)) {
    const [, name, tokenSource] = match;
    const tokens = tokenSource.trim().split(/\s+/).filter(Boolean);
    const reference = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, "g");
    variants = variants.flatMap((variant) => tokens.map((token) => variant.replace(reference, token)));
  }
  return variants.map((variant) => expandStaticReferences(variant, assignments));
}

export function extractTopologyHosts(value) {
  const normalized = normalizeDynamicHostText(value);
  const matches = [];
  const pattern = /(?:\{slug\}|[A-Za-z0-9_-]+)(?:\.(?:\{slug\}|[A-Za-z0-9_-]+))*\.chasesets\.com\b/g;
  for (const match of normalized.matchAll(pattern)) {
    if (match.index > 0 && normalized[match.index - 1] === "@") continue;
    matches.push(match[0].toLowerCase());
  }
  if (/(?:^|[^@A-Za-z0-9_.-])chasesets\.com\b/.test(normalized)) matches.push("chasesets.com");
  return [...new Set(matches)];
}

function hostPatternRegex(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{slug\\\}/g, "(?:[a-z0-9-]+|\\{slug\\})");
  return new RegExp(`^${escaped}$`);
}

export function topologyIndex(manifest) {
  const assertable = [];
  const diagnostics = [];
  const zones = [];
  for (const [environment, declaration] of Object.entries(manifest.environments)) {
    for (const host of [...declaration.applicationHosts, ...declaration.serviceHosts]) {
      assertable.push({ environment, host, regex: hostPatternRegex(host) });
    }
    for (const host of declaration.diagnosticHosts) {
      diagnostics.push({ environment, host, regex: hostPatternRegex(host) });
    }
    for (const zone of declaration.dnsZones) zones.push({ environment, ...zone });
  }
  return { assertable, diagnostics, zones: zones.sort((left, right) => right.name.length - left.name.length) };
}

function classifyHost(host, index) {
  const assertable = index.assertable.find((entry) => entry.regex.test(host));
  if (assertable) return { role: "assertable", ...assertable };
  const diagnostic = index.diagnostics.find((entry) => entry.regex.test(host));
  if (diagnostic) return { role: "diagnostic", ...diagnostic };
  const zone = index.zones.find((entry) => entry.name === host);
  if (zone) return { role: "zone", ...zone };
  return { role: "undeclared" };
}

function scalarEntries(value, path = [], entries = []) {
  if (typeof value === "string") entries.push({ path, key: path.at(-1) ?? "", value });
  else if (Array.isArray(value)) value.forEach((item, index) => scalarEntries(item, [...path, index], entries));
  else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) scalarEntries(item, [...path, key], entries);
  }
  return entries;
}

function isWorkflowAssertionScalar(entry) {
  const keys = entry.path.filter((part) => typeof part === "string");
  if (entry.key === "run" || entry.key === "default") return true;
  if (keys.includes("env") || keys.includes("with")) {
    return /https?:\/\/|chasesets\.com|(?:URL|HOST|DOMAIN|ZONE|ENDPOINT|ORIGIN)/i.test(`${entry.key} ${entry.value}`);
  }
  return /platform-ingress-wait|doctl\s+compute\s+domain\s+records\s+list|curl\s|fetch\s*\(/.test(entry.value);
}

function isScriptAssertionSource(source) {
  return /(?:fetch\s*\(|curl\s|platform-ingress-wait|smoke(?::|[-_])|\.hostname\s*[!=]=|new\s+Set\s*\(|\.includes\s*\(|doctl\s+compute\s+domain\s+records\s+list)/.test(
    source,
  );
}

function assertionHostViolations(source, scalars, file, index) {
  const violations = [];
  for (const scalar of scalars) {
    for (const resolvedValue of expandStaticScalarValues(scalar.value)) {
      for (const host of extractTopologyHosts(resolvedValue)) {
        const classification = classifyHost(host, index);
        if (classification.role === "assertable" || classification.role === "zone") continue;
        const reason =
          classification.role === "diagnostic"
            ? `'${host}' is diagnostic-only in ${classification.environment}, not an application or service host.`
            : `'${host}' is not declared as an application host, service host, or DNS zone.`;
        violations.push(
          violation(topologyViolationCode, file, reason, lineNumber(source, host.replaceAll("{slug}", ""))),
        );
      }
    }
  }
  return violations;
}

export function shellAssignments(source, contextSource = source) {
  const assignments = new Map();
  const direct = /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9._@-]+))/gm;
  for (const match of source.matchAll(direct)) assignments.set(match[1], match[2] ?? match[3] ?? match[4]);
  for (const match of contextSource.matchAll(direct)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (/^[A-Za-z0-9._@-]+$/.test(value) && !/^[A-Za-z0-9._@-]+$/.test(assignments.get(match[1]) ?? "")) {
      assignments.set(match[1], value);
    }
  }
  const multilineScriptConstant =
    /(?:^|[;\r\n]\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/gm;
  for (const match of contextSource.matchAll(multilineScriptConstant)) {
    assignments.set(match[1], match[2] ?? match[3] ?? match[4]);
  }
  for (const [name, value] of assignments) {
    assignments.set(name, expandStaticReferences(value, assignments));
  }
  const suffix = /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)="\$\{([A-Za-z_][A-Za-z0-9_]*)%\.([A-Za-z0-9.-]+)\}"/gm;
  for (const match of source.matchAll(suffix)) {
    const base = assignments.get(match[2]);
    if (base?.endsWith(`.${match[3]}`)) assignments.set(match[1], base.slice(0, -match[3].length - 1));
  }
  for (const [name, value] of assignments) {
    assignments.set(name, expandStaticReferences(value, assignments));
  }
  return assignments;
}

function resolveShellToken(token, assignments) {
  const normalized = token.trim().replace(/^['"]|['"]$/g, "");
  const variable = normalized.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (variable) return assignments.get(variable[1] ?? variable[2]) ?? null;
  return /^[A-Za-z0-9._@-]+$/.test(normalized) ? normalized : null;
}

function zoneForFqdn(fqdn, index) {
  return index.zones.find((zone) => fqdn === zone.name || fqdn.endsWith(`.${zone.name}`)) ?? null;
}

export function dnsAssertionViolations(source, file, index, contextSource = source) {
  const violations = [];
  const assignments = shellAssignments(source, contextSource);
  const queryPattern = /doctl\s+compute\s+domain\s+records\s+list\s+([^\s|\\]+)/g;
  for (const match of source.matchAll(queryPattern)) {
    const queriedZone = resolveShellToken(match[1], assignments);
    if (!queriedZone) {
      violations.push(
        violation(
          unresolvableViolationCode,
          file,
          `DNS assertion zone '${match[1]}' cannot be resolved to a declared zone.`,
          lineNumber(contextSource, match[0]),
        ),
      );
      continue;
    }
    const recordArgument = source.match(/--arg\s+record_name\s+["']?\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)/);
    const recordName = recordArgument ? assignments.get(recordArgument[1]) : null;
    if (recordArgument && !recordName) {
      violations.push(
        violation(
          unresolvableViolationCode,
          file,
          `DNS assertion record '${recordArgument[1]}' cannot be resolved.`,
          lineNumber(contextSource, match[0]),
        ),
      );
      continue;
    }
    if (recordName) {
      const fqdn = recordName === "@" ? queriedZone : `${recordName}.${queriedZone}`;
      const owner = zoneForFqdn(fqdn, index);
      if (owner && owner.name !== queriedZone) {
        violations.push(
          violation(
            zoneViolationCode,
            file,
            `DNS assertion queries parent zone '${queriedZone}' for '${fqdn}', which is owned by delegated child zone '${owner.name}'.`,
            lineNumber(contextSource, match[0]),
          ),
        );
      }
    }
  }

  const recordType = assignments.get("record_type") ?? assignments.get("type");
  const recordName = assignments.get("record_name") ?? assignments.get("name");
  const zone = assignments.get("zone") ?? assignments.get("domain");
  if (["CNAME", "ALIAS"].includes(recordType?.toUpperCase()) && ["@", zone].includes(recordName) && zone) {
    violations.push(
      violation(
        zoneViolationCode,
        file,
        `DNS assertion requires ${recordType.toUpperCase()} at real apex '${zone}'; declared environment apexes cannot be CNAME/ALIAS records.`,
        lineNumber(contextSource, recordType),
      ),
    );
  }
  return violations;
}

function parseWorkflow(source, file) {
  const document = parseDocument(source, { logLevel: "silent", prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${file}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document.toJS();
}

function scanYamlSource(source, file, index, shapes) {
  let parsed;
  try {
    parsed = parseWorkflow(source, file);
  } catch (error) {
    return [violation("topology-workflow-parse-failed", file, error.message)];
  }
  const entries = scalarEntries(parsed).filter(isWorkflowAssertionScalar);
  for (const entry of entries) {
    if (entry.key === "run") shapes.add("run-block");
    else if (entry.key === "default") shapes.add("input-default");
    else if (entry.path.includes("env")) shapes.add("environment-value");
    else if (entry.path.includes("with")) shapes.add("action-input");
  }
  const scalarViolations = assertionHostViolations(source, entries, file, index);
  const dnsViolations = [];
  for (const entry of entries.filter((candidate) => candidate.key === "run")) {
    if (/doctl\s+compute\s+domain\s+records\s+list/.test(entry.value)) shapes.add("dns-record-query");
    dnsViolations.push(...dnsAssertionViolations(entry.value, file, index, source));
  }
  return [...scalarViolations, ...dnsViolations];
}

function scanScriptSource(source, file, index, shapes) {
  const assignments = shellAssignments(source);
  const blocks = source
    .split(/\r?\n/)
    .filter((line) => isScriptAssertionSource(line))
    .map((line) => ({ value: expandStaticReferences(line, assignments) }));
  for (const match of source.matchAll(/\bfetch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const value = assignments.get(match[1]);
    if (value !== undefined) blocks.push({ value });
  }
  if (blocks.length > 0) shapes.add("script-assertion");
  return [...assertionHostViolations(source, blocks, file, index), ...dnsAssertionViolations(source, file, index)];
}

export function reconcileEnvironmentDnsTerraform(root, manifest) {
  const findings = [];
  const localsPath = manifest.terraformSource.locals;
  const recordsPath = manifest.terraformSource.records;
  let localsSource;
  let recordsSource;
  let previewDnsSource;
  try {
    localsSource = readFileSync(resolve(root, localsPath), "utf8");
    recordsSource = readFileSync(resolve(root, recordsPath), "utf8");
    previewDnsSource = readFileSync(resolve(root, previewDnsSourceRelativePath), "utf8");
  } catch (error) {
    return [violation("topology-terraform-source-unreadable", error.path ?? localsPath, error.message)];
  }
  if (
    !/environment_zone\s*=\s*local\.is_production\s*\?\s*var\.root_domain\s*:\s*"\$\{var\.environment\}\.\$\{var\.root_domain\}"/.test(
      localsSource,
    )
  ) {
    findings.push(
      violation(
        "topology-terraform-diverged",
        localsPath,
        "environment_zone no longer derives production from root_domain and non-production from <environment>.<root_domain>.",
      ),
    );
  }

  const previewParentZone = previewDnsSource.match(/PREVIEW_DNS_BASE_DOMAIN\s*=\s*["']([^"']+)["']/)?.[1];
  const previewZone = manifest.environments.preview.dnsZones[0];
  if (
    !previewParentZone ||
    !/record:\s*\{\s*role:\s*["']wildcard["'][\s\S]*?previewDnsRecordName\(fqdn,\s*zone\)/.test(previewDnsSource)
  ) {
    findings.push(
      violation(
        "topology-preview-dns-source-diverged",
        previewDnsSourceRelativePath,
        "shared preview DNS ownership is no longer statically derivable from the preview wildcard record plan.",
      ),
    );
  } else if (
    previewZone?.name !== previewParentZone ||
    previewZone.delegatedFrom !== null ||
    previewZone.managedBy !== "digitalocean-platform-root"
  ) {
    findings.push(
      violation(
        "topology-manifest-preview-dns-diverged",
        manifestRelativePath,
        `preview DNS must use parent zone '${previewParentZone}' from ${previewDnsSourceRelativePath}; ` +
          "preview.chasesets.com is a record namespace, not a delegated DNS zone.",
      ),
    );
  }

  const catalogResource = recordsSource.match(
    /resource\s+"digitalocean_record"\s+"catalog_assets"\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  const catalogRecordName = catalogResource?.match(/name\s*=\s*"([^"]+)"/)?.[1];
  if (
    !catalogResource ||
    !/domain\s*=\s*digitalocean_domain\.environment\[0\]\.name/.test(catalogResource) ||
    !catalogRecordName
  ) {
    findings.push(
      violation(
        "topology-terraform-diverged",
        recordsPath,
        "catalog_assets must remain an 'assets' record owned by the delegated environment zone.",
      ),
    );
  }

  const stagingZone = manifest.environments.staging.dnsZones.find(
    ({ managedBy }) => managedBy === "digitalocean-environment-dns",
  )?.name;
  if (
    catalogRecordName &&
    stagingZone &&
    !manifest.environments.staging.serviceHosts.includes(`${catalogRecordName}.${stagingZone}`)
  ) {
    findings.push(
      violation(
        "topology-manifest-terraform-diverged",
        manifestRelativePath,
        `Terraform-owned '${catalogRecordName}.${stagingZone}' must be a declared staging service host.`,
      ),
    );
  }

  const diagnosticRecordNames = [
    ...localsSource.matchAll(/\b\w+\s*=\s*\{\s*name\s*=\s*"([^"]+)"\s*,?\s*fqdn\s*=/g),
  ].map((match) => match[1]);
  if (diagnosticRecordNames.length === 0) {
    findings.push(
      violation(
        "topology-terraform-diverged",
        localsPath,
        "doks_diagnostic_records no longer exposes statically derivable record names.",
      ),
    );
  }
  for (const environmentName of ["production", "staging"]) {
    const environment = manifest.environments[environmentName];
    const zone = environment.dnsZones[0]?.name;
    const expected = diagnosticRecordNames.map((name) => `${name}.${zone}`).sort();
    if (JSON.stringify([...environment.diagnosticHosts].sort()) !== JSON.stringify(expected)) {
      findings.push(
        violation(
          "topology-manifest-terraform-diverged",
          manifestRelativePath,
          `${environmentName} diagnostic hosts must equal Terraform-derived records: ${expected.join(", ")}.`,
        ),
      );
    }
  }
  return findings;
}

export function scanEnvironmentTopology({ root = process.cwd() } = {}) {
  let manifest;
  try {
    manifest = loadEnvironmentTopology(root);
  } catch (error) {
    return {
      passed: false,
      violations: [violation("topology-source-invalid", manifestRelativePath, error.message)],
      discovery: {
        scannedFiles: 0,
        excludedFiles: 0,
        totalFiles: 0,
        semanticFiles: 0,
        recognizedShapes: [],
        exclusionReasons: [],
        ignoredDirectories: ignoredDirectoryReasons,
      },
    };
  }
  const index = topologyIndex(manifest);
  const primaryFiles = primaryCandidateFiles(root);
  const semanticFiles = semanticWorkflowFiles(root, primaryFiles);
  const files = [...primaryFiles, ...semanticFiles];
  const shapes = new Set();
  const violations = [...reconcileEnvironmentDnsTerraform(root, manifest)];
  let scannedFiles = 0;
  let excludedFiles = 0;
  for (const absolutePath of files) {
    const file = relative(root, absolutePath).replaceAll("\\", "/");
    let source;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch (error) {
      violations.push(violation("topology-candidate-unreadable", file, error.message));
      continue;
    }
    if (!/\.ya?ml$/i.test(file) && vitestImportPattern.test(source)) {
      excludedFiles += 1;
      shapes.add("vitest-test-module-excluded");
      continue;
    }
    scannedFiles += 1;
    if (/\.ya?ml$/i.test(file)) violations.push(...scanYamlSource(source, file, index, shapes));
    else violations.push(...scanScriptSource(source, file, index, shapes));
  }
  return {
    passed: violations.length === 0,
    violations,
    discovery: {
      scannedFiles,
      excludedFiles,
      totalFiles: files.length,
      primaryFiles: primaryFiles.length,
      semanticFiles: semanticFiles.length,
      recognizedShapes: [...shapes].sort(),
      exclusionReasons:
        excludedFiles === 0
          ? []
          : [{ category: "vitest-importing-script", count: excludedFiles, reason: vitestExclusionReason }],
      ignoredDirectories: ignoredDirectoryReasons,
    },
  };
}

export function reportEnvironmentTopology(result) {
  const discovery = result.discovery;
  console.log(
    `environment topology guard: scanned=${discovery.scannedFiles} excluded=${discovery.excludedFiles ?? 0} ` +
      `total=${discovery.totalFiles} candidate files ` +
      `(${discovery.primaryFiles ?? 0} workflow/action/script candidates; ${discovery.semanticFiles ?? 0} semantic arbitrary-path additions).`,
  );
  for (const exclusion of discovery.exclusionReasons ?? []) {
    console.log(`excluded ${exclusion.count} ${exclusion.category} files: ${exclusion.reason}`);
  }
  const ignored = Object.entries(discovery.ignoredDirectories ?? {});
  if (ignored.length > 0) {
    console.log(`traversal-excluded directories: ${ignored.map(([name, reason]) => `${name} (${reason})`).join("; ")}`);
  }
  console.log(`recognized assertion shapes: ${(discovery.recognizedShapes ?? []).join(", ") || "none"}.`);
  for (const finding of result.violations) console.error(`- ${finding.message}`);
  return result.passed;
}

function cliOption(argv, name, fallback) {
  const prefix = `${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(cliOption(process.argv.slice(2), "--repository-root", process.cwd()));
  if (!reportEnvironmentTopology(scanEnvironmentTopology({ root }))) process.exitCode = 1;
}
