import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  classifyAttachment,
  isRepoLocation,
  journeyPackageRecordSchemaVersion,
  journeyPackageTarget,
  knownLocatorFor,
  rawRoot,
  recordDirectory,
} from "./journey-package-contract.mjs";

const toPosix = (value) => value.split(path.sep).join("/");

function fileSuiteOf(test) {
  let suite = test.parent;
  while (suite && suite.type !== "file") suite = suite.parent;
  return suite ?? null;
}

function stepsWithErrors(steps, found = []) {
  for (const step of steps) {
    if (step.error) found.push(step);
    stepsWithErrors(step.steps ?? [], found);
  }
  return found;
}

function attachTimes(steps, times = new Map()) {
  for (const step of steps) {
    for (const attachment of step.attachments ?? []) times.set(attachment, step.startTime.toISOString());
    attachTimes(step.steps ?? [], times);
  }
  return times;
}

// Reads Playwright's in-memory error and step objects and keeps only the closed
// classification, known-locator enum and repository location. No error text is
// retained or written.
function failureOf(rootDir, test, result) {
  if (result.status === "skipped") return null;
  if (result.status === "passed" && test.expectedStatus === "passed") return null;
  const errors = result.errors ?? [];
  let classification = "unknown";
  if (result.status === "timedOut") classification = "timeout";
  else {
    const topLevel = (result.steps ?? []).find((step) => step.error || stepsWithErrors(step.steps ?? []).length);
    const failing = stepsWithErrors(result.steps ?? []).at(-1);
    if (topLevel?.category === "hook" && topLevel.title === "Before Hooks") classification = "setup";
    else if (topLevel?.category === "hook" && topLevel.title === "After Hooks") classification = "teardown";
    else if (failing?.category === "expect") classification = "assertion";
  }
  const located = errors.find((error) => error.location);
  const relative = located ? toPosix(path.relative(rootDir, located.location.file)) : null;
  const location = located ? `${relative}:${located.location.line}:${located.location.column}` : null;
  const message = errors.find((error) => typeof error.message === "string")?.message;
  return {
    classification,
    knownLocator: knownLocatorFor(message),
    location: isRepoLocation(location) ? location : null,
  };
}

// Records the enrolled target's attempts for the packager. It is inert in list
// mode, for every other test, and when no target is selected.
export default class JourneyPackageReporter {
  #inert;
  #rootDir = null;
  #targets = new Map();

  constructor(options = {}) {
    this.#inert = options._mode === "list" || process.argv.includes("--list");
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    if (this.#inert) return;
    this.#rootDir = config.rootDir;
    for (const test of suite.allTests()) {
      const fileSuite = fileSuiteOf(test);
      if (!fileSuite?.location?.file) continue;
      const file = toPosix(path.relative(this.#rootDir, fileSuite.location.file));
      const project = test.parent.project()?.name ?? null;
      if (file !== journeyPackageTarget.file || project !== journeyPackageTarget.project) continue;
      this.#targets.set(test, { file, title: test.title, project, attempts: [] });
    }
  }

  onTestEnd(test, result) {
    const target = this.#targets.get(test);
    if (!target) return;
    const attempt = {
      retry: result.retry,
      status: result.status,
      durationMs: Math.max(0, Math.round(result.duration)),
      failure: failureOf(this.#rootDir, test, result),
      candidates: null,
      excluded: null,
    };
    if (result.retry === 0) Object.assign(attempt, this.#retainFirstAttempt(result));
    target.attempts.push(attempt);
  }

  // Only the authoritative first attempt keeps candidate bytes: the timeline
  // and listed captures, written inside the raw Playwright root. Everything
  // else is counted, never read or copied.
  #retainFirstAttempt(result) {
    const rawRootPath = path.join(this.#rootDir, rawRoot);
    const directory = path.join(rawRootPath, recordDirectory, "attempt-0");
    const times = attachTimes(result.steps ?? []);
    const candidates = [];
    const excluded = { automatic: 0, unlisted: 0, png: 0 };
    result.attachments.forEach((attachment, index) => {
      const kind = classifyAttachment(attachment.name);
      if (kind === "automatic" || kind === "unlisted") {
        excluded[kind] += 1;
        if (attachment.contentType === "image/png") excluded.png += 1;
        return;
      }
      let file = null;
      if (attachment.body) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, `${index}.bin`), attachment.body);
        file = `${recordDirectory}/attempt-0/${index}.bin`;
      } else if (attachment.path) {
        file = toPosix(path.relative(rawRootPath, attachment.path));
      }
      candidates.push({
        name: attachment.name,
        contentType: attachment.contentType,
        file,
        attachedAt: times.get(attachment) ?? null,
      });
    });
    return { candidates, excluded };
  }

  onEnd() {
    if (this.#inert || this.#targets.size === 0) return;
    const record = {
      schemaVersion: journeyPackageRecordSchemaVersion,
      run: { id: process.env.GITHUB_RUN_ID ?? "local", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "local" },
      targets: [...this.#targets].map(([test, target]) => ({
        file: target.file,
        title: target.title,
        project: target.project,
        expectedStatus: test.expectedStatus,
        outcome: test.outcome(),
        attempts: target.attempts.sort((left, right) => left.retry - right.retry),
      })),
    };
    const directory = path.join(this.#rootDir, rawRoot, recordDirectory);
    mkdirSync(directory, { recursive: true });
    const staged = path.join(directory, "record.json.partial");
    writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(staged, path.join(directory, "record.json"));
  }
}
