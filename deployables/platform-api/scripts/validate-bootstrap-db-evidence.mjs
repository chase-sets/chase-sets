import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { bootstrapDbEnrollmentManifest } from "./check-bootstrap-db-enrollment.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const duration = (value) => Number.isFinite(value) && value >= 0;
const instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function validateBootstrapDbEvidence({ directory, manifest = bootstrapDbEnrollmentManifest, expectedHead }) {
  const violations = [];
  const units = [];
  const reject = (message) => violations.push(message);
  if (Object.keys(manifest).length === 0) reject("evidence manifest is empty");
  if (typeof expectedHead !== "string" || !/^[a-f0-9]{40}$/.test(expectedHead)) reject("expected head is invalid");
  const expectedUnits = [...new Set(Object.values(manifest).map((entry) => entry.executionUnit))];
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return { valid: false, violations: ["evidence directory is missing or unreadable"], units };
  }
  const expectedNames = expectedUnits.map((unit) => `${unit.replaceAll(":", "-")}.jsonl`);
  for (const name of names) if (!expectedNames.includes(name)) reject(`unknown unit file: ${name}`);
  for (const unit of expectedUnits) {
    const name = `${unit.replaceAll(":", "-")}.jsonl`;
    if (!names.includes(name)) {
      reject(`missing unit: ${unit}`);
      continue;
    }
    let rows;
    try {
      rows = readFileSync(resolve(directory, name), "utf8").trimEnd().split(/\r?\n/).map(JSON.parse);
      if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("invalid row");
    } catch {
      reject(`${unit}: malformed JSONL`);
      continue;
    }
    const start = rows[0];
    const end = rows.at(-1);
    const modules = rows.filter((row) => row.kind === "module");
    if (start?.kind !== "runStart" || rows.filter((row) => row.kind === "runStart").length !== 1) {
      reject(`${unit}: missing or duplicate runStart`);
    }
    if (start.unit !== unit) reject(`${unit}: missing or unknown unit identity`);
    const directHead = start.event === "push" && start.checkoutSha === expectedHead;
    const mergeHead =
      start.event === "pull_request" &&
      start.eventHeadSha === expectedHead &&
      Array.isArray(start.rawParents) &&
      start.rawParents.length === 2 &&
      start.rawParents[1] === expectedHead &&
      typeof start.checkoutSha === "string" &&
      /^[a-f0-9]{40}$/.test(start.checkoutSha) &&
      start.checkoutSha === start.githubSha;
    if (!directHead && !mergeHead) reject(`${unit}: head is not bound to expected head`);
    if (end?.kind !== "runEnd" || rows.filter((row) => row.kind === "runEnd").length !== 1) {
      reject(`${unit}: missing or duplicate runEnd`);
    }
    if (rows.some((row, index) => index > 0 && index < rows.length - 1 && row.kind !== "module")) {
      reject(`${unit}: unexpected row order or kind`);
    }
    if (
      !instant(start.startedAt) ||
      !instant(end.finishedAt) ||
      !duration(end.wallMs) ||
      end.wallMs !== Date.parse(end.finishedAt) - Date.parse(start.startedAt)
    )
      reject(`${unit}: invalid run wall`);
    if (end.reason !== "passed" || !Array.isArray(end.errors) || end.errors.length !== 0)
      reject(`${unit}: run did not pass`);
    if (end.moduleCount !== modules.length) reject(`${unit}: module count differs`);
    const files = Object.entries(manifest).filter(([, entry]) => entry.executionUnit === unit);
    for (const row of modules) {
      if (!files.some(([file]) => file === row.file)) reject(`${unit}: unknown module ${row.file}`);
    }
    for (const [file, entry] of files) {
      const matches = modules.filter((row) => row.file === file);
      if (matches.length !== 1) {
        reject(`${unit}: missing or duplicate module ${file}`);
        continue;
      }
      const row = matches[0];
      let sourceSha256 = entry.sourceSha256;
      if (!sourceSha256) {
        try {
          sourceSha256 = createHash("sha256")
            .update(readFileSync(resolve(workspace, "__tests__", file)))
            .digest("hex");
        } catch {
          reject(`${file}: source is unreadable`);
        }
      }
      if (!/^[a-f0-9]{64}$/.test(sourceSha256 ?? "") || row.sourceSha256 !== sourceSha256)
        reject(`${file}: sourceSha256 mismatch`);
      const identities = entry.cases.map(({ name, identity }) => ({ name, identity }));
      if (JSON.stringify(row.identities) !== JSON.stringify(identities)) reject(`${file}: case identities differ`);
      if (row.state !== "passed" || !Array.isArray(row.errors) || row.errors.length !== 0)
        reject(`${file}: module did not pass`);
      if (!duration(row.diagnostic?.duration)) reject(`${file}: module duration is missing`);
      if (!Array.isArray(row.cases) || row.cases.length !== entry.cases.length) {
        reject(`${file}: case count differs`);
        continue;
      }
      for (const [index, test] of row.cases.entries()) {
        if (
          !test ||
          test.name !== entry.cases[index].name ||
          typeof test.fullName !== "string" ||
          test.result?.state !== "passed" ||
          !duration(test.durationMs) ||
          test.durationMs !== test.diagnostic?.duration
        ) {
          reject(`${file}: case ${index} is missing, changed, skipped or failed`);
        }
      }
    }
    units.push({ unit, runStart: start, runEnd: end });
  }
  const owner = (start) =>
    JSON.stringify([
      start.checkoutSha,
      start.githubSha,
      start.eventHeadSha,
      start.event,
      start.runId,
      start.runAttempt,
      start.job,
    ]);
  if (units.some((unit) => owner(unit.runStart) !== owner(units[0].runStart)))
    reject("units have different owning runs");
  return { valid: violations.length === 0, violations, units };
}

export function deriveUnitWallsFromStepLog({ lines, workspace, units, runEnds }) {
  const parsed = lines.map((line) => {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    return { at: match ? Date.parse(match[1]) : NaN, text: match?.[2] ?? "" };
  });
  const running = units
    .map((unit) => {
      const matches = parsed.flatMap((line, index) =>
        line.text === `Running ${unit} in ${workspace}...` ? [index] : [],
      );
      if (matches.length !== 1 || !Number.isFinite(parsed[matches[0]].at))
        throw new Error(`${unit}: missing or duplicate Running line`);
      return { unit, index: matches[0] };
    })
    .sort((left, right) => left.index - right.index);
  return running.map(({ unit, index }, position) => {
    const next = running[position + 1]?.index ?? parsed.length;
    const prefixed = parsed.slice(index + 1, next).filter((line) => line.text.startsWith(`[${workspace}] `));
    const last = prefixed.at(-1);
    if (!last || !Number.isFinite(last.at)) throw new Error(`${unit}: missing timestamped workspace output`);
    const runningAt = parsed[index].at;
    const finishedAt = Date.parse(runEnds[unit]);
    if (!Number.isFinite(finishedAt)) throw new Error(`${unit}: missing runEnd wall`);
    const endAt = position === running.length - 1 ? Math.max(last.at, finishedAt) : last.at;
    if (endAt < runningAt || finishedAt < runningAt || finishedAt > endAt)
      throw new Error(`${unit}: runEnd outside unit wall`);
    return { unit, runningAt, lastPrefixedAt: last.at, endAt, wallMs: endAt - runningAt };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        directory: { type: "string" },
        "expect-head": { type: "string" },
        manifest: { type: "string" },
        "step-log": { type: "string" },
      },
    });
    const result = validateBootstrapDbEvidence({
      directory: values.directory,
      expectedHead: values["expect-head"],
      manifest: values.manifest ? JSON.parse(readFileSync(values.manifest, "utf8")) : bootstrapDbEnrollmentManifest,
    });
    if (values["step-log"] && result.valid) {
      result.walls = deriveUnitWallsFromStepLog({
        lines: readFileSync(values["step-log"], "utf8").split(/\r?\n/),
        workspace: "@chase-sets/app-platform-api",
        units: result.units.map(({ unit }) => unit),
        runEnds: Object.fromEntries(result.units.map(({ unit, runEnd }) => [unit, runEnd.finishedAt])),
      });
      for (const wall of result.walls) {
        const start = result.units.find(({ unit }) => unit === wall.unit).runStart;
        wall.guardMs = Date.parse(start.startedAt) - wall.runningAt;
        if (wall.guardMs < 0) throw new Error(`${wall.unit}: runStart before Running line`);
      }
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.error(`Bootstrap DB evidence refused: ${error.message}`);
    process.exitCode = 1;
  }
}
