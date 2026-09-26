import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveBootstrapDbCaseIdentities } from "./check-bootstrap-db-enrollment.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default class BootstrapDbEvidenceReporter {
  constructor() {
    this.unit = process.env.BOOTSTRAP_DB_EVIDENCE_UNIT ?? process.env.npm_lifecycle_event;
    if (!/^test:db:\d+$/.test(this.unit ?? "")) {
      throw new Error("Bootstrap DB evidence requires a numbered test:db unit");
    }
    this.output = resolve(workspace, "artifacts/bootstrap-db-evidence", `${this.unit.replaceAll(":", "-")}.jsonl`);
  }

  append(row) {
    appendFileSync(this.output, `${JSON.stringify(row)}\n`);
  }

  onTestRunStart() {
    const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    this.startedAt = new Date().toISOString();
    const event = process.env.GITHUB_EVENT_NAME ?? null;
    const payload = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
      : null;
    const eventHeadSha =
      event === "pull_request"
        ? (payload?.pull_request?.head?.sha ?? null)
        : event === "merge_group"
          ? (payload?.merge_group?.head_sha ?? null)
          : null;
    mkdirSync(dirname(this.output), { recursive: true });
    writeFileSync(this.output, "");
    this.append({
      kind: "runStart",
      unit: this.unit,
      startedAt: this.startedAt,
      pid: process.pid,
      node: process.version,
      checkoutSha: git("rev-parse", "HEAD"),
      headParents: git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/),
      rawParents: git("cat-file", "-p", "HEAD")
        .split("\n\n", 1)[0]
        .split("\n")
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7)),
      eventHeadSha,
      githubSha: process.env.GITHUB_SHA ?? null,
      githubRef: process.env.GITHUB_REF ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      job: process.env.GITHUB_JOB ?? null,
      event,
    });
  }

  onTestModuleEnd(module) {
    const source = readFileSync(module.moduleId, "utf8");
    const file = basename(module.moduleId);
    this.append({
      kind: "module",
      file,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      identities: deriveBootstrapDbCaseIdentities(file, source),
      state: module.state(),
      diagnostic: module.diagnostic(),
      errors: module.errors(),
      cases: [...module.children.allTests()].map((test) => {
        const diagnostic = test.diagnostic();
        return {
          name: test.name,
          fullName: test.fullName,
          result: test.result(),
          diagnostic,
          durationMs: diagnostic.duration,
        };
      }),
    });
  }

  onTestRunEnd(modules, errors, reason) {
    const finishedAt = new Date().toISOString();
    this.append({
      kind: "runEnd",
      finishedAt,
      wallMs: Date.parse(finishedAt) - Date.parse(this.startedAt),
      moduleCount: modules.length,
      errors,
      reason,
    });
  }
}
