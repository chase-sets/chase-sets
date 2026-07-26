#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { MANAGED_REGISTRY_AUTHORITY } from "./managed-registry-readiness.mjs";

const executableWorkflowDirectory = ".github/workflows";
const workflowExtensionPattern = /\.ya?ml$/i;
const platformCommandPattern =
  /\b(?:pnpm\s+run\s+platform:kubernetes-deployment\s+--|node\s+(?:\.\/)?scripts\/platform-kubernetes-deployment\.mjs)\s+(deploy|scenario-seed)\b/g;
const imagePullSelectorPattern = /--image-pull-secret(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/g;
const helmImagePullSelectorPattern =
  /global\.imagePullSecrets(?:\[[^\]]+\])?\.name(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/g;
const generatedRegistryCredentialPattern =
  /\bdoctl\s+registry\s+(?:docker-config|kubernetes-manifest)\b|\bkubectl\s+create\s+secret\s+docker-registry\b|\bkubectl\s+create\s+secret\s+generic\b[\s\S]*?(?:\.dockerconfigjson|kubernetes\.io\/dockerconfigjson)/;
const namespaceManifestCreatePattern = /\bnamespace-manifest\b[\s\S]*?\|\s*kubectl\s+create\s+-f\s+-/;
const readinessInvocationPattern = /\bnode\s+(?:\.\/)?scripts\/managed-registry-readiness\.mjs\b/;

export function discoverTrackedExecutableWorkflows(repositoryRoot) {
  const output = execFileSync("git", ["ls-files", "--", executableWorkflowDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  return output
    .split(/\r?\n/)
    .map((file) => file.trim().replaceAll("\\", "/"))
    .filter(
      (file) =>
        file !== "" && path.posix.dirname(file) === executableWorkflowDirectory && workflowExtensionPattern.test(file),
    )
    .sort();
}

export function auditManagedRegistryAuthority(repositoryRoot) {
  const files = discoverTrackedExecutableWorkflows(repositoryRoot);
  const violations = [];
  let scanned = 0;
  let platformPullCommands = 0;
  let managedSelectors = 0;
  let temporaryNamespaceReadinessPaths = 0;

  for (const file of files) {
    scanned += 1;
    const source = readFileSync(path.join(repositoryRoot, file), "utf8");
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      violations.push(
        finding(
          file,
          null,
          "workflow-yaml-invalid",
          "Workflow YAML could not be parsed; registry authority is unknown.",
        ),
      );
      continue;
    }

    const workflow = document.toJS();
    const jobs = workflow?.jobs;
    if (jobs == null || typeof jobs !== "object") continue;
    const workflowRuns = [];

    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const runs = steps.flatMap((step, stepIndex) =>
        typeof step?.run === "string" ? [{ jobId, stepIndex, run: step.run }] : [],
      );
      workflowRuns.push(...runs);

      for (const [runIndex, block] of runs.entries()) {
        const commands = [...block.run.matchAll(platformCommandPattern)];
        if (commands.length === 0) continue;
        platformPullCommands += commands.length;

        const selectors = [
          ...selectorValues(block.run, imagePullSelectorPattern),
          ...selectorValues(block.run, helmImagePullSelectorPattern),
        ];
        if (selectors.length === 0) {
          violations.push(
            finding(
              file,
              jobId,
              "managed-pull-selector-missing",
              `Private platform ${commands.map((match) => match[1]).join("/")} command must explicitly select '${MANAGED_REGISTRY_AUTHORITY}'.`,
            ),
          );
        }
        for (const selector of selectors) {
          if (selector !== MANAGED_REGISTRY_AUTHORITY) {
            violations.push(
              finding(
                file,
                jobId,
                "non-managed-pull-selector",
                `Private platform pulls must select '${MANAGED_REGISTRY_AUTHORITY}', not '${selector}'.`,
              ),
            );
          } else {
            managedSelectors += 1;
          }
        }

        const deploymentNamespace = optionValue(block.run, "--namespace");
        const priorNamespaceCreate = findLastIndex(runs.slice(0, runIndex), ({ run }) => {
          if (namespaceManifestCreatePattern.test(run)) return true;
          return namespaceCreateTargets(run).some((target) => target === deploymentNamespace);
        });
        if (priorNamespaceCreate >= 0) {
          const readinessBlocks = runs
            .slice(priorNamespaceCreate + 1, runIndex)
            .filter(({ run }) => readinessInvocationPattern.test(run));
          if (readinessBlocks.length !== 1) {
            violations.push(
              finding(
                file,
                jobId,
                "temporary-namespace-readiness-missing",
                "A temporary namespace must run exactly one managed-registry readiness check after creation and before private workload deployment.",
              ),
            );
          } else if (!hasBoundedReadinessTimeout(readinessBlocks[0].run)) {
            violations.push(
              finding(
                file,
                jobId,
                "temporary-namespace-readiness-unbounded",
                "Managed-registry readiness must declare --timeout-seconds from 1 through 300.",
              ),
            );
          } else {
            temporaryNamespaceReadinessPaths += 1;
          }
        }
      }
    }

    const hasPlatformPull = workflowRuns.some(({ run }) => new RegExp(platformCommandPattern).test(run));
    const generatedCredentialRuns = workflowRuns.filter(({ run }) => generatedRegistryCredentialPattern.test(run));
    if (hasPlatformPull && generatedCredentialRuns.length > 0) {
      for (const { jobId } of generatedCredentialRuns) {
        violations.push(
          finding(
            file,
            jobId,
            "generated-platform-pull-credential",
            "A workflow that deploys private platform workloads must not generate a parallel registry credential; the provider-managed authority is the single pull owner.",
          ),
        );
      }
    }
  }

  return {
    schemaVersion: "managed-registry-authority-guard/v1",
    authority: MANAGED_REGISTRY_AUTHORITY,
    scanned,
    total: files.length,
    platformPullCommands,
    managedSelectors,
    temporaryNamespaceReadinessPaths,
    violations,
  };
}

function selectorValues(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function optionValue(source, name) {
  const escapedName = name.replaceAll("-", "\\-");
  const match = source.match(new RegExp(`${escapedName}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s\\\\]+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function namespaceCreateTargets(source) {
  return [...source.matchAll(/\bkubectl\s+create\s+namespace(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function hasBoundedReadinessTimeout(run) {
  const match = run.match(/--timeout-seconds(?:=|\s+)(\d+)\b/);
  const seconds = Number(match?.[1]);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 300;
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function finding(file, jobId, code, message) {
  return { file, ...(jobId == null ? {} : { jobId }), code, message };
}

function main(args) {
  const repositoryRootIndex = args.indexOf("--repository-root");
  const repositoryRoot = repositoryRootIndex >= 0 ? path.resolve(args[repositoryRootIndex + 1]) : path.resolve(".");
  const report = auditManagedRegistryAuthority(repositoryRoot);
  console.log(
    `managed registry authority guard: scanned ${report.scanned}/${report.total} tracked executable workflows; checked ${report.platformPullCommands} private platform pull commands, ${report.managedSelectors} managed selectors, and ${report.temporaryNamespaceReadinessPaths} temporary-namespace readiness paths.`,
  );
  for (const violation of report.violations) {
    console.error(
      `${violation.file}${violation.jobId ? `:${violation.jobId}` : ""} [${violation.code}] ${violation.message}`,
    );
  }
  if (report.scanned !== report.total || report.total === 0 || report.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
