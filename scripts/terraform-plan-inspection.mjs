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
  return (plan.resource_changes ?? [])
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
    "Usage: node ./scripts/terraform-plan-inspection.mjs <assert-no-destructive-changes|postgres-cluster-id|summarize-plan>",
  );
}

if (process.argv[1]?.endsWith("terraform-plan-inspection.mjs")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
