#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const DURABLE_DATABASE_DESTRUCTIVE_RESOURCE_NAMES = new Map([
  ["digitalocean_database_cluster", new Set(["postgres"])],
  ["digitalocean_database_db", new Set(["contexts"])],
  ["digitalocean_database_user", new Set(["contexts", "wake_listeners"])],
  ["digitalocean_database_connection_pool", new Set(["contexts"])],
]);

const DESTRUCTIVE_APPROVAL_STATE_ACTIVE = "active";
const DESTRUCTIVE_APPROVAL_STATE_NONE = "no-active-approval";
const PRODUCTION_SERVING_RECORD_ADDRESSES = [
  'digitalocean_record.app_serving["admin"]',
  'digitalocean_record.app_serving["www"]',
];
const PRODUCTION_ROOT_DOMAIN = "chasesets.com";
const PRODUCTION_APP_PLATFORM_PARKING_DOMAIN = `app-platform.${PRODUCTION_ROOT_DOMAIN}`;

function productionAppDomainAttachmentAddress(name) {
  return `digitalocean_app.platform.domain["${name}"]`;
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        const commandError = new Error(`${command} ${args.join(" ")} failed: ${message}`);
        Object.assign(commandError, { exitCode: error.code, signal: error.signal, stdout, stderr });
        reject(commandError);
        return;
      }

      resolve(stdout);
    });
  });
}

function readStringOption(argv, name, defaultValue = undefined) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? defaultValue;
}

export function appPlatformChanges(plan) {
  return Boolean(
    plan.resource_changes?.some((resourceChange) => {
      if (resourceChange.type !== "digitalocean_app" || resourceChange.name !== "platform") {
        return false;
      }

      const actions = resourceChange.change?.actions ?? [];
      return actions.length > 0 && actions.some((action) => action !== "no-op");
    }),
  );
}

export function terraformPlanSummary(plan, options = {}) {
  const maxResources = options.maxResources ?? 50;
  const changes = (plan.resource_changes ?? [])
    .map((resourceChange) => {
      const actions = resourceChange.change?.actions ?? [];
      return {
        address: resourceChange.address ?? `${resourceChange.type}.${resourceChange.name}`,
        actions,
      };
    })
    .filter(
      (change) => change.actions.length > 0 && change.actions.some((action) => !["no-op", "read"].includes(action)),
    );

  return {
    add: changes.filter((change) => change.actions.includes("create")).length,
    change: changes.filter((change) => change.actions.includes("update")).length,
    destroy: changes.filter((change) => change.actions.includes("delete")).length,
    resources: changes
      .sort((left, right) => left.address.localeCompare(right.address))
      .slice(0, maxResources)
      .map((change) => ({ ...change, actions: [...change.actions] })),
    omittedResources: Math.max(0, changes.length - maxResources),
  };
}

export function renderTerraformPlanSummaryMarkdown(plan, options = {}) {
  const title = options.title ?? "Terraform plan";
  const summary = terraformPlanSummary(plan, { maxResources: options.maxResources });
  const lines = [
    `### ${title}`,
    "",
    `- Add: ${summary.add}`,
    `- Change: ${summary.change}`,
    `- Destroy: ${summary.destroy}`,
    "",
  ];

  if (summary.resources.length === 0) {
    lines.push("No resource changes in this plan.");
  } else {
    lines.push("Changed resources:");
    for (const resource of summary.resources) {
      lines.push(`- \`${resource.address}\` (${resource.actions.join(", ")})`);
    }
    if (summary.omittedResources > 0) {
      lines.push(`- ... ${summary.omittedResources} additional resource change(s) omitted from the summary.`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function knownTerraformId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function postgresClusterResourceId(resource) {
  if (resource?.type !== "digitalocean_database_cluster" || resource?.name !== "postgres") {
    return "";
  }

  return knownTerraformId(resource.values?.id);
}

function modulePostgresClusterId(module) {
  for (const resource of module?.resources ?? []) {
    const id = postgresClusterResourceId(resource);
    if (id) {
      return id;
    }
  }

  for (const childModule of module?.child_modules ?? []) {
    const id = modulePostgresClusterId(childModule);
    if (id) {
      return id;
    }
  }

  return "";
}

export function postgresClusterIdFromPlan(plan) {
  for (const resourceChange of plan.resource_changes ?? []) {
    if (resourceChange.type !== "digitalocean_database_cluster" || resourceChange.name !== "postgres") {
      continue;
    }

    const id =
      knownTerraformId(resourceChange.change?.after?.id) || knownTerraformId(resourceChange.change?.before?.id);
    if (id) {
      return id;
    }
  }

  return (
    modulePostgresClusterId(plan.planned_values?.root_module) ||
    modulePostgresClusterId(plan.prior_state?.values?.root_module)
  );
}

export function destructiveResourceChanges(plan) {
  const resourceDeletes = (plan.resource_changes ?? [])
    .filter((resourceChange) => {
      if (resourceChange.type === "terraform_data") {
        return false;
      }

      const actions = resourceChange.change?.actions ?? [];
      return actions.includes("delete");
    })
    .map((resourceChange) => ({
      address: resourceChange.address ?? `${resourceChange.type}.${resourceChange.name}`,
      type: resourceChange.type ?? "",
      name: resourceChange.name ?? "",
      actions: resourceChange.change?.actions ?? [],
    }));

  const platformChange = (plan.resource_changes ?? []).find(
    (resourceChange) =>
      resourceChange.type === "digitalocean_app" &&
      resourceChange.name === "platform" &&
      JSON.stringify(resourceChange.change?.actions) === JSON.stringify(["update"]),
  );
  const beforeDomains = appDomainsFromState(platformChange?.change?.before);
  const afterDomainNames = new Set(appDomainsFromState(platformChange?.change?.after).map((domain) => domain.name));
  const domainDetaches = beforeDomains
    .filter((domain) => !afterDomainNames.has(domain.name))
    .map((domain) => ({
      address: productionAppDomainAttachmentAddress(domain.name),
      type: "digitalocean_app_domain_attachment",
      name: domain.name,
      actions: ["delete"],
    }));

  return [...resourceDeletes, ...domainDetaches];
}

function appDomainsFromState(state) {
  const domains = state?.spec?.[0]?.domain;
  if (!Array.isArray(domains)) {
    return [];
  }

  return domains
    .filter((domain) => typeof domain?.name === "string" && domain.name.length > 0)
    .map((domain) => ({
      name: domain.name,
      type: domain.type ?? "",
      zone: domain.zone ?? "",
    }));
}

function appDomainSignature(domains) {
  return domains.map((domain) => `${domain.name}|${domain.type}|${domain.zone}`).sort();
}

function productionLiveAppDomains(includeMarketplace) {
  return [
    { name: PRODUCTION_ROOT_DOMAIN, type: "PRIMARY", zone: PRODUCTION_ROOT_DOMAIN },
    { name: `admin.${PRODUCTION_ROOT_DOMAIN}`, type: "ALIAS", zone: PRODUCTION_ROOT_DOMAIN },
    { name: `www.${PRODUCTION_ROOT_DOMAIN}`, type: "ALIAS", zone: PRODUCTION_ROOT_DOMAIN },
    ...(includeMarketplace
      ? [{ name: `marketplace.${PRODUCTION_ROOT_DOMAIN}`, type: "ALIAS", zone: PRODUCTION_ROOT_DOMAIN }]
      : []),
  ];
}

function productionParkingAppDomains(type = "PRIMARY") {
  return [
    {
      name: PRODUCTION_APP_PLATFORM_PARKING_DOMAIN,
      type,
      zone: PRODUCTION_ROOT_DOMAIN,
    },
  ];
}

function productionPreparedAppPlatformDomains(includeMarketplace) {
  return [...productionLiveAppDomains(includeMarketplace), ...productionParkingAppDomains("ALIAS")];
}

export function assertProductionServingModeReplacement(plan, options) {
  const from = options?.from;
  const to = options?.to;
  if (!new Set(["app-platform", "doks"]).has(from) || !new Set(["app-platform", "doks"]).has(to) || from === to) {
    throw new Error("Production serving-mode replacement requires different app-platform/doks from and to modes.");
  }

  const servingRecordAddresses = [...PRODUCTION_SERVING_RECORD_ADDRESSES];
  if (options?.includeMarketplace) {
    servingRecordAddresses.push('digitalocean_record.app_serving["marketplace"]');
  }
  const expectedDestroyedAddresses = [];
  if (from === "doks") {
    expectedDestroyedAddresses.push(...servingRecordAddresses);
    expectedDestroyedAddresses.push("digitalocean_record.doks_apex[0]");
  } else {
    expectedDestroyedAddresses.push(
      ...productionLiveAppDomains(Boolean(options?.includeMarketplace)).map((domain) =>
        productionAppDomainAttachmentAddress(domain.name),
      ),
    );
  }
  expectedDestroyedAddresses.sort();

  const destroyedAddresses = destructiveResourceChanges(plan)
    .map((change) => change.address)
    .sort();
  if (JSON.stringify(destroyedAddresses) !== JSON.stringify(expectedDestroyedAddresses)) {
    throw new Error(
      `Production ${from}-to-${to} plan deletes must be limited to ${expectedDestroyedAddresses.join(", ")}; observed ${destroyedAddresses.join(", ") || "none"}.`,
    );
  }

  const platformChange = (plan.resource_changes ?? []).find(
    (candidate) => candidate.type === "digitalocean_app" && candidate.name === "platform",
  );
  const expectedBeforeDomains =
    from === "app-platform"
      ? productionPreparedAppPlatformDomains(Boolean(options?.includeMarketplace))
      : productionParkingAppDomains();
  const expectedAfterDomains =
    to === "app-platform"
      ? productionPreparedAppPlatformDomains(Boolean(options?.includeMarketplace))
      : productionParkingAppDomains();
  if (
    JSON.stringify(platformChange?.change?.actions) !== JSON.stringify(["update"]) ||
    JSON.stringify(appDomainSignature(appDomainsFromState(platformChange?.change?.before))) !==
      JSON.stringify(appDomainSignature(expectedBeforeDomains)) ||
    JSON.stringify(appDomainSignature(appDomainsFromState(platformChange?.change?.after))) !==
      JSON.stringify(appDomainSignature(expectedAfterDomains))
  ) {
    throw new Error(
      `Production ${from}-to-${to} must update digitalocean_app.platform from exactly the expected source attachments to exactly the expected destination attachments.`,
    );
  }

  for (const address of servingRecordAddresses) {
    const change = (plan.resource_changes ?? []).find((candidate) => candidate.address === address);
    const before = change?.change?.before;
    const after = change?.change?.after;
    const validForwardCreate =
      from === "app-platform" &&
      JSON.stringify(change?.change?.actions) === JSON.stringify(["create"]) &&
      before === null &&
      after?.type === "A" &&
      Number.isFinite(after?.ttl) &&
      after.ttl <= 300;
    const validRollbackDelete =
      from === "doks" &&
      JSON.stringify(change?.change?.actions) === JSON.stringify(["delete"]) &&
      before?.type === "A" &&
      Number.isFinite(before?.ttl) &&
      before.ttl <= 300 &&
      after === null;
    if (!validForwardCreate && !validRollbackDelete) {
      throw new Error(
        `${address} must be a low-TTL A create after App Platform releases its CNAME (${from === "app-platform" ? "forward" : "not applicable"}) or a low-TTL A delete before App Platform reattaches its CNAME (${from === "doks" ? "rollback" : "not applicable"}).`,
      );
    }
  }

  if (from === "doks") {
    const apex = (plan.resource_changes ?? []).find(
      (candidate) => candidate.address === "digitalocean_record.doks_apex[0]",
    );
    if (
      JSON.stringify(apex?.change?.actions) !== JSON.stringify(["delete"]) ||
      apex?.change?.before?.type !== "A" ||
      !Number.isFinite(apex?.change?.before?.ttl) ||
      apex.change.before.ttl > 300
    ) {
      throw new Error(
        "DOKS rollback must delete only the low-TTL DOKS apex A record in addition to the leaf replacements.",
      );
    }
  }

  if (from === "app-platform") {
    const apex = (plan.resource_changes ?? []).find(
      (candidate) => candidate.address === "digitalocean_record.doks_apex[0]",
    );
    if (
      JSON.stringify(apex?.change?.actions) !== JSON.stringify(["create"]) ||
      apex?.change?.before !== null ||
      apex?.change?.after?.type !== "A" ||
      !Number.isFinite(apex?.change?.after?.ttl) ||
      apex.change.after.ttl > 300
    ) {
      throw new Error("DOKS cutover must create the low-TTL DOKS apex A record after the leaf A records.");
    }
  }

  return destroyedAddresses;
}

function durableDatabaseDestructiveResource(change) {
  const names = DURABLE_DATABASE_DESTRUCTIVE_RESOURCE_NAMES.get(change.type);
  const baseName = change.name.split("[")[0];
  return names?.has(baseName) ?? false;
}

export function durableDatabaseDestructiveResourceChanges(plan) {
  return destructiveResourceChanges(plan).filter(durableDatabaseDestructiveResource);
}

function destructiveApprovalField(text, label) {
  return new RegExp(`^${label}:\\s*(.+?)\\s*$`, "m").exec(text)?.[1]?.trim() ?? "";
}

export function destructiveChangesApprovalFingerprint(changes) {
  const fingerprintInput = changes
    .map((change) => ({
      address: change.address,
      actions: [...change.actions].sort(),
    }))
    .sort((left, right) => left.address.localeCompare(right.address));

  return `sha256:${createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex")}`;
}

export function destructiveChangeApprovalFromText(text) {
  const state = destructiveApprovalField(text, "Approval state");
  if (state === DESTRUCTIVE_APPROVAL_STATE_NONE) {
    return { state, planFingerprint: "", addresses: [] };
  }
  if (state !== DESTRUCTIVE_APPROVAL_STATE_ACTIVE) {
    throw new Error(
      "Production destructive-change approval must declare 'Approval state: active' or 'Approval state: no-active-approval'.",
    );
  }

  const planFingerprint = destructiveApprovalField(text, "Plan fingerprint");
  if (!/^sha256:[a-f0-9]{64}$/.test(planFingerprint)) {
    throw new Error("Active production destructive-change approval must include a current Plan fingerprint.");
  }

  const headingMatch = /^## Approved Destructive Changes\s*$/m.exec(text);
  if (!headingMatch) {
    throw new Error("Production destructive-change approval must include an 'Approved Destructive Changes' section.");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const sectionTail = text.slice(sectionStart);
  const nextHeadingIndex = sectionTail.search(/\n##\s+/);
  const section = nextHeadingIndex >= 0 ? sectionTail.slice(0, nextHeadingIndex) : sectionTail;
  const addresses = section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+`([^`]+)`\s*$/)?.[1])
    .filter((address) => typeof address === "string" && address.length > 0);

  if (addresses.length === 0) {
    throw new Error("Production destructive-change approval must list at least one exact Terraform resource address.");
  }

  return { state, planFingerprint, addresses: [...new Set(addresses)] };
}

export function approvedDestructiveChangeAddressesFromText(text) {
  return destructiveChangeApprovalFromText(text).addresses;
}

export function readDestructiveChangeAllowFile(filePath) {
  return destructiveChangeApprovalFromText(readFileSync(filePath, "utf8"));
}

export function assertNoDestructiveChanges(plan, options = {}) {
  const destructiveChanges = destructiveResourceChanges(plan);
  if (destructiveChanges.length === 0) {
    return destructiveChanges;
  }

  const durableDatabaseChanges = destructiveChanges.filter(durableDatabaseDestructiveResource);
  const approval = options.destructiveChangeApproval;
  const allowedDestructiveAddresses = approval?.addresses ?? options.allowedDestructiveAddresses ?? [];

  if (allowedDestructiveAddresses.length > 0) {
    if (approval) {
      const expectedFingerprint = destructiveChangesApprovalFingerprint(destructiveChanges);
      if (approval.planFingerprint !== expectedFingerprint) {
        throw new Error(
          `Production destructive-change approval plan fingerprint does not match the current Terraform plan. Expected ${expectedFingerprint}.`,
        );
      }
    }

    const allowed = new Set(allowedDestructiveAddresses);
    const unapprovedChanges = destructiveChanges.filter((change) => !allowed.has(change.address));

    if (unapprovedChanges.length > 0) {
      const summary = unapprovedChanges.map((change) => `- ${change.address}: ${change.actions.join(",")}`).join("\n");
      throw new Error(
        `Production Terraform plan contains destructive changes not covered by the reviewed override marker:\n${summary}`,
      );
    }

    console.warn("Production destructive-change override marker is present for these resources:");
    for (const change of destructiveChanges) {
      console.warn(`- ${change.address}: ${change.actions.join(",")}`);
    }
    return destructiveChanges;
  }

  if (durableDatabaseChanges.length > 0) {
    const summary = durableDatabaseChanges
      .map((change) => `- ${change.address}: ${change.actions.join(",")}`)
      .join("\n");
    throw new Error(
      `Production Terraform plan would delete durable database resources without an audited resource-scoped emergency override:\n${summary}\nExpected paths: use profile gating or retained context provisioning for runtime posture changes, PITR/restore procedures for recovery, or a reviewed production destructive-change approval marker that names each exact resource address.`,
    );
  }

  if (options.allowDestructiveChanges) {
    console.warn("Production destructive-change override marker is present.");
    for (const change of destructiveChanges) {
      console.warn(`- ${change.address}: ${change.actions.join(",")}`);
    }
    return destructiveChanges;
  }

  const summary = destructiveChanges.map((change) => `- ${change.address}: ${change.actions.join(",")}`).join("\n");
  throw new Error(
    `Production Terraform plan contains destructive changes and no reviewed override marker was found:\n${summary}`,
  );
}

export async function planAppChanged(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return appPlatformChanges(JSON.parse(output));
}

export async function readPostgresClusterIdFromPlan(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return postgresClusterIdFromPlan(JSON.parse(output));
}

export async function assertTerraformPlanSafe(tfplanPath, options = {}) {
  const output = await (options.commandOutput ?? commandOutput)("terraform", ["show", "-json", tfplanPath]);
  return assertNoDestructiveChanges(JSON.parse(output), options);
}

export function readTerraformPlanSummaryMarkdown(tfplanJsonPath, options = {}) {
  return renderTerraformPlanSummaryMarkdown(JSON.parse(readFileSync(tfplanJsonPath, "utf8")), options);
}

async function main(argv) {
  const [command, ...args] = argv;

  if (command === "plan-app-changed") {
    const [tfplanPath] = args;
    if (!tfplanPath) {
      throw new Error("Usage: node ./scripts/terraform-plan-inspection.mjs plan-app-changed <tfplan>");
    }

    console.log(String(await planAppChanged(tfplanPath)));
    return;
  }

  if (command === "assert-no-destructive-changes") {
    const [tfplanPath, ...options] = args;
    if (!tfplanPath) {
      throw new Error(
        "Usage: node ./scripts/terraform-plan-inspection.mjs assert-no-destructive-changes <tfplan> [--allow-file=<path>]",
      );
    }

    const allowFilePath = options.find((option) => option.startsWith("--allow-file="))?.slice("--allow-file=".length);
    const destructiveChangeApproval =
      allowFilePath && existsSync(allowFilePath) ? readDestructiveChangeAllowFile(allowFilePath) : undefined;

    await assertTerraformPlanSafe(tfplanPath, { destructiveChangeApproval });
    return;
  }

  if (command === "summarize-plan") {
    const [tfplanJsonPath, ...options] = args;
    if (!tfplanJsonPath) {
      throw new Error(
        "Usage: node ./scripts/terraform-plan-inspection.mjs summarize-plan <tfplan-json> [--title=<title>]",
      );
    }

    process.stdout.write(
      readTerraformPlanSummaryMarkdown(tfplanJsonPath, {
        title: readStringOption(options, "--title") ?? "Terraform plan",
      }),
    );
    return;
  }

  if (command === "list-destructive-changes") {
    const [tfplanJsonPath] = args;
    if (!tfplanJsonPath) {
      throw new Error("Usage: node ./scripts/terraform-plan-inspection.mjs list-destructive-changes <tfplan-json>");
    }

    for (const change of destructiveResourceChanges(JSON.parse(readFileSync(tfplanJsonPath, "utf8")))) {
      console.log(change.address);
    }
    return;
  }

  if (command === "assert-serving-mode-replacement") {
    const [tfplanJsonPath, ...options] = args;
    const from = readStringOption(options, "--from");
    const to = readStringOption(options, "--to");
    if (!tfplanJsonPath || !from || !to) {
      throw new Error(
        "Usage: node ./scripts/terraform-plan-inspection.mjs assert-serving-mode-replacement <tfplan-json> --from=<app-platform|doks> --to=<app-platform|doks>",
      );
    }

    assertProductionServingModeReplacement(JSON.parse(readFileSync(tfplanJsonPath, "utf8")), {
      from,
      to,
      includeMarketplace: readStringOption(options, "--include-marketplace", "false") === "true",
    });
    return;
  }

  if (command === "postgres-cluster-id") {
    const [tfplanPath] = args;
    if (!tfplanPath) {
      throw new Error("Usage: node ./scripts/terraform-plan-inspection.mjs postgres-cluster-id <tfplan>");
    }

    const clusterId = await readPostgresClusterIdFromPlan(tfplanPath);
    if (!clusterId) {
      throw new Error("Terraform plan did not expose digitalocean_database_cluster.postgres id.");
    }

    console.log(clusterId);
    return;
  }

  throw new Error(
    "Usage: node ./scripts/terraform-plan-inspection.mjs <plan-app-changed|assert-no-destructive-changes|assert-serving-mode-replacement|list-destructive-changes|postgres-cluster-id|summarize-plan>",
  );
}

if (process.argv[1]?.endsWith("terraform-plan-inspection.mjs")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
