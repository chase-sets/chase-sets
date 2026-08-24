import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanPlaywrightArtifactUploads } from "./playwright-artifact-upload-fence.mjs";

const executableProducerPattern = /(?:^|[\s;&|$(])(?:node|pnpm)\s/m;
const bestEffortProducerPattern = /\|\|\s*true\b/;
const uploadArtifactPattern = /uses:\s*actions\/upload-artifact@/;
const baselineVersion = 2;
const defaultBaselinePath = "scripts/workflow-canonical-artifacts-baseline.json";
const missingFileBehaviorSeverity = new Map([
  ["error", 0],
  ["warn", 1],
  ["ignore", 2],
]);

function workflowStepBlocks(source) {
  const lines = source.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)-\s+(?:name:|uses:|run:)/);
    if (match) starts.push({ index, indent: match[1].length });
  }

  return starts.map((start) => {
    let end = lines.length;
    for (const candidate of starts) {
      if (candidate.index > start.index && candidate.indent <= start.indent) {
        end = candidate.index;
        break;
      }
    }
    return {
      startLine: start.index + 1,
      endLine: end,
      source: lines.slice(start.index, end).join("\n"),
    };
  });
}

function runBlock(stepSource) {
  const lines = stepSource.split("\n");
  const index = lines.findIndex((line) => /^\s+(?:-\s+)?run:\s*/.test(line));
  if (index < 0) return null;
  const inline = lines[index].replace(/^\s+(?:-\s+)?run:\s*/, "");
  if (inline !== "|" && inline !== ">" && inline !== "") return inline;
  return lines.slice(index + 1).join("\n");
}

function normalizeLiteralPath(value) {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\.\//, "")
    .replaceAll("\\", "/");
}

export function literalOutPaths(run) {
  const pattern =
    /--out(?:(?:=)(?:"([^"$\r\n]+)"|'([^'$\r\n]+)'|([^\s\\'"$]+))|\s+(?:"([^"$\r\n]+)"|'([^'$\r\n]+)'|([^\s\\'"$]+)))/g;
  const paths = new Set();
  for (const match of run.matchAll(pattern)) {
    const value = match.slice(1).find(Boolean);
    if (value) paths.add(normalizeLiteralPath(value));
  }
  return [...paths].sort();
}

function scalarStepField(stepSource, name) {
  const match = stepSource.match(new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`, "m"));
  if (!match || ["|", ">"].includes(match[1])) return null;
  return normalizeLiteralPath(match[1]);
}

function globPattern(value) {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function uploadIncludesPath(uploadPath, outPath) {
  if (uploadPath === outPath) return true;
  if (uploadPath.includes("*")) return globPattern(uploadPath).test(outPath);
  return outPath.startsWith(`${uploadPath.replace(/\/$/, "")}/`);
}

function uploadRequiresExactPayloadCheck(uploadPath, outPath) {
  return uploadPath !== outPath;
}

function hasExplicitPayloadValidation(source, outPath) {
  const escapedPath = outPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const validator = "(?:validate\\b|test\\s+-s\\b|\\[\\s+-s\\b|jq\\s+-e\\b|--(?:record|input|file)(?:=|\\s+))";
  return source
    .split(/\r?\n/)
    .some((line) => new RegExp(`(?:${validator}.*${escapedPath}|${escapedPath}.*${validator})`, "i").test(line));
}

function surfaceIdentity(surface) {
  return [surface.workflowFile, surface.outPath, surface.uploadPath].join("\u0000");
}

function findingIdentity(finding) {
  return `${surfaceIdentity(finding)}\u0000${finding.kind}`;
}

function findingMessage(finding, line) {
  if (finding.kind === "missing-file-behavior") {
    return `${finding.workflowFile}:${line} canonical payload '${finding.outPath}' is uploaded with if-no-files-found=${finding.observed}; required evidence must fail closed.`;
  }
  return `${finding.workflowFile}:${line} upload path '${finding.uploadPath}' can be nonempty while canonical payload '${finding.outPath}' is missing; validate the exact payload before upload.`;
}

export function checkWorkflowCanonicalArtifacts(source, { workflowFile = "workflow" } = {}) {
  const steps = workflowStepBlocks(source);
  const producers = [];
  const uploads = [];

  for (const step of steps) {
    const run = runBlock(step.source);
    if (run && executableProducerPattern.test(run) && !bestEffortProducerPattern.test(run)) {
      for (const outPath of literalOutPaths(run)) {
        if (extname(outPath) === ".json") producers.push({ ...step, outPath });
      }
    }
    if (uploadArtifactPattern.test(step.source)) {
      const uploadPath = scalarStepField(step.source, "path");
      if (uploadPath) {
        uploads.push({
          ...step,
          uploadPath,
          missingFileBehavior: scalarStepField(step.source, "if-no-files-found") ?? "warn",
        });
      }
    }
  }

  const surfaces = [];
  const findings = [];
  const lines = source.split(/\r?\n/);
  for (const producer of producers) {
    const upload = uploads.find(
      (candidate) =>
        candidate.startLine > producer.startLine && uploadIncludesPath(candidate.uploadPath, producer.outPath),
    );
    if (!upload) continue;

    const between = lines.slice(producer.startLine - 1, upload.startLine - 1).join("\n");
    const explicitlyValidated = hasExplicitPayloadValidation(between, producer.outPath);
    const surface = {
      workflowFile,
      producerLine: producer.startLine,
      uploadLine: upload.startLine,
      outPath: producer.outPath,
      uploadPath: upload.uploadPath,
      missingFileBehavior: upload.missingFileBehavior,
      explicitlyValidated,
    };
    surfaces.push(surface);

    if (upload.missingFileBehavior !== "error") {
      findings.push({
        workflowFile,
        outPath: producer.outPath,
        uploadPath: upload.uploadPath,
        kind: "missing-file-behavior",
        observed: upload.missingFileBehavior,
        message: findingMessage(
          {
            workflowFile,
            outPath: producer.outPath,
            uploadPath: upload.uploadPath,
            kind: "missing-file-behavior",
            observed: upload.missingFileBehavior,
          },
          upload.startLine,
        ),
      });
    }
    if (uploadRequiresExactPayloadCheck(upload.uploadPath, producer.outPath) && !explicitlyValidated) {
      const finding = {
        workflowFile,
        outPath: producer.outPath,
        uploadPath: upload.uploadPath,
        kind: "directory-masks-missing-payload",
        observed: true,
      };
      findings.push({ ...finding, message: findingMessage(finding, upload.startLine) });
    }
  }

  const violations = findings.map((finding) => finding.message);
  return { passed: violations.length === 0, surfaces, findings, violations };
}

function workflowFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.ya?ml$/i.test(entry)) files.push(path);
    }
  };
  visit(resolve(root, ".github/workflows"));
  visit(resolve(root, ".github/actions"));
  return files.sort();
}

export function scanWorkflowCanonicalArtifacts({ root = process.cwd() } = {}) {
  const files = workflowFiles(root);
  const findings = [];
  const surfaces = [];
  let scannedFiles = 0;
  for (const file of files) {
    const workflowFile = relative(root, file).replaceAll("\\", "/");
    const result = checkWorkflowCanonicalArtifacts(readFileSync(file, "utf8"), { workflowFile });
    findings.push(...result.findings);
    surfaces.push(...result.surfaces);
    scannedFiles += 1;
  }
  const playwrightUploadFence = scanPlaywrightArtifactUploads({ root });
  return {
    passed: findings.length === 0 && playwrightUploadFence.passed,
    findings,
    violations: findings.map((finding) => finding.message),
    surfaces,
    discovery: {
      scannedFiles,
      totalFiles: files.length,
      scannedSurfaces: surfaces.length,
      totalSurfaces: surfaces.length,
    },
    playwrightUploadFence,
  };
}

export function createWorkflowCanonicalArtifactBaseline(result) {
  return {
    version: baselineVersion,
    discovery: {
      scannedFiles: result.discovery.scannedFiles,
      scannedSurfaces: result.discovery.scannedSurfaces,
    },
    playwrightUploadFence: {
      trackedFiles: result.playwrightUploadFence.discovery.trackedFiles,
      workflowFiles: result.playwrightUploadFence.discovery.workflowFiles,
      compositeActionFiles: result.playwrightUploadFence.discovery.compositeActionFiles,
    },
    surfaces: result.surfaces
      .map(({ workflowFile, outPath, uploadPath }) => ({ workflowFile, outPath, uploadPath }))
      .sort((left, right) => surfaceIdentity(left).localeCompare(surfaceIdentity(right))),
    findings: result.findings
      .map(({ workflowFile, outPath, uploadPath, kind, observed }) => ({
        workflowFile,
        outPath,
        uploadPath,
        kind,
        observed,
      }))
      .sort((left, right) => findingIdentity(left).localeCompare(findingIdentity(right))),
  };
}

export function evaluateWorkflowCanonicalArtifactRatchet(result, baseline) {
  const currentSurfaces = new Map(result.surfaces.map((surface) => [surfaceIdentity(surface), surface]));
  const baselineFindings = new Map(baseline.findings.map((finding) => [findingIdentity(finding), finding]));
  const existingDebt = [];
  const newOrRegressed = [];

  for (const finding of result.findings) {
    const previous = baselineFindings.get(findingIdentity(finding));
    const isExisting =
      previous !== undefined &&
      (finding.kind !== "missing-file-behavior" ||
        (missingFileBehaviorSeverity.get(finding.observed) ?? Number.POSITIVE_INFINITY) <=
          (missingFileBehaviorSeverity.get(previous.observed) ?? Number.NEGATIVE_INFINITY));
    (isExisting ? existingDebt : newOrRegressed).push(finding);
  }

  const missingExpectedSurfaces = baseline.surfaces.filter((surface) => !currentSurfaces.has(surfaceIdentity(surface)));
  const coverageRegressions = [];
  if (result.discovery.scannedFiles < baseline.discovery.scannedFiles) {
    coverageRegressions.push(
      `scanned workflow/action files fell from ${baseline.discovery.scannedFiles} to ${result.discovery.scannedFiles}`,
    );
  }
  if (result.discovery.scannedSurfaces < baseline.discovery.scannedSurfaces) {
    coverageRegressions.push(
      `discovered producer/upload surfaces fell from ${baseline.discovery.scannedSurfaces} to ${result.discovery.scannedSurfaces}`,
    );
  }

  const playwrightUploadFenceRegressions = [];
  for (const finding of result.playwrightUploadFence.findings) {
    playwrightUploadFenceRegressions.push(
      `${finding.file}:${finding.owner}:${finding.step} upload '${finding.uploadPath}' ${finding.analysis}`,
    );
  }
  for (const field of ["trackedFiles", "workflowFiles", "compositeActionFiles"]) {
    if (result.playwrightUploadFence.discovery[field] < baseline.playwrightUploadFence[field]) {
      playwrightUploadFenceRegressions.push(
        `Playwright upload fence ${field} fell from ${baseline.playwrightUploadFence[field]} to ${result.playwrightUploadFence.discovery[field]}`,
      );
    }
  }

  return {
    passed:
      newOrRegressed.length === 0 &&
      missingExpectedSurfaces.length === 0 &&
      coverageRegressions.length === 0 &&
      playwrightUploadFenceRegressions.length === 0,
    existingDebt,
    newOrRegressed,
    missingExpectedSurfaces,
    coverageRegressions,
    playwrightUploadFenceRegressions,
  };
}

function readBaseline(root, baselinePath) {
  const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), "utf8"));
  if (
    baseline?.version !== baselineVersion ||
    !Array.isArray(baseline.surfaces) ||
    !Array.isArray(baseline.findings) ||
    !Number.isInteger(baseline.discovery?.scannedFiles) ||
    !Number.isInteger(baseline.discovery?.scannedSurfaces) ||
    !Number.isInteger(baseline.playwrightUploadFence?.trackedFiles) ||
    !Number.isInteger(baseline.playwrightUploadFence?.workflowFiles) ||
    !Number.isInteger(baseline.playwrightUploadFence?.compositeActionFiles)
  ) {
    throw new Error(`${baselinePath} is not a workflow canonical artifact baseline v${baselineVersion}.`);
  }
  return baseline;
}

function cliOption(argv, name, fallback) {
  const prefix = `${name}=`;
  const equalsValue = argv.find((value) => value.startsWith(prefix));
  if (equalsValue) return equalsValue.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

export function reportWorkflowCanonicalArtifactGuard(result, ratchet = null) {
  const { scannedFiles, totalFiles, scannedSurfaces, totalSurfaces } = result.discovery;
  console.log(
    `workflow canonical artifact guard: scanned ${scannedFiles}/${totalFiles} workflow/action files; checked ${scannedSurfaces}/${totalSurfaces} discovered producer/upload surfaces.`,
  );
  console.log(
    `Playwright upload fence: parsed ${result.playwrightUploadFence.discovery.parsedFiles}/${result.playwrightUploadFence.discovery.trackedFiles} tracked workflow/action files; checked ${result.playwrightUploadFence.discovery.evaluatedUploadPaths} upload paths and ${result.playwrightUploadFence.discovery.localCompositeCalls} local composite calls.`,
  );
  if (ratchet === null) {
    if (result.violations.length > 0) {
      for (const violation of result.violations) console.error(`- ${violation}`);
    }
    for (const finding of result.playwrightUploadFence.findings) {
      console.error(
        `- Playwright upload fence: ${finding.file}:${finding.owner}:${finding.step} upload '${finding.uploadPath}' ${finding.analysis}`,
      );
    }
    return result.passed;
  }

  console.log(`existing baseline debt: ${ratchet.existingDebt.length}`);
  for (const finding of ratchet.existingDebt) console.log(`- existing debt: ${finding.message}`);
  console.log(`new/regressed violations: ${ratchet.newOrRegressed.length}`);
  for (const finding of ratchet.newOrRegressed) console.error(`- new/regressed: ${finding.message}`);
  for (const surface of ratchet.missingExpectedSurfaces) {
    console.error(
      `- missing expected surface: ${surface.workflowFile} '${surface.outPath}' -> '${surface.uploadPath}'`,
    );
  }
  for (const regression of ratchet.coverageRegressions) {
    console.error(`- reduced scan coverage: ${regression}`);
  }
  for (const regression of ratchet.playwrightUploadFenceRegressions) {
    console.error(`- Playwright upload fence: ${regression}`);
  }
  return ratchet.passed;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = resolve(cliOption(argv, "--root", process.cwd()));
  const baselinePath = cliOption(argv, "--baseline", defaultBaselinePath);
  const result = scanWorkflowCanonicalArtifacts({ root });
  if (argv.includes("--write-baseline")) {
    if (!result.playwrightUploadFence.passed) {
      reportWorkflowCanonicalArtifactGuard(result);
      console.error("refusing to baseline a raw Playwright upload path");
      process.exitCode = 1;
    } else {
      writeFileSync(
        resolve(root, baselinePath),
        `${JSON.stringify(createWorkflowCanonicalArtifactBaseline(result), null, 2)}\n`,
      );
      reportWorkflowCanonicalArtifactGuard(result, {
        passed: true,
        existingDebt: result.findings,
        newOrRegressed: [],
        missingExpectedSurfaces: [],
        coverageRegressions: [],
        playwrightUploadFenceRegressions: [],
      });
      console.log(`wrote ${baselinePath}`);
    }
  } else {
    const ratchet = evaluateWorkflowCanonicalArtifactRatchet(result, readBaseline(root, baselinePath));
    if (!reportWorkflowCanonicalArtifactGuard(result, ratchet)) process.exitCode = 1;
  }
}
