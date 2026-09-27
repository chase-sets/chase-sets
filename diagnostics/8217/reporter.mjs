import { appendFileSync, statSync, writeFileSync } from "node:fs";

export default class CapacityReporter {
  constructor() {
    this.file = `${process.env.CAPTURE_DIR}/vitest-${process.env.npm_lifecycle_event?.replaceAll(":", "-") ?? process.env.CAPTURE_PHASE}.jsonl`;
    this.start = process.hrtime.bigint();
    this.truncated = false;
    writeFileSync(this.file, "");
  }

  record(kind, data = {}) {
    if (this.truncated) return;
    if (statSync(this.file).size >= 7 * 1024 * 1024) {
      appendFileSync(this.file, JSON.stringify({ kind: "truncated", capBytes: 7 * 1024 * 1024 }) + "\n");
      this.truncated = true;
      return;
    }
    appendFileSync(this.file, JSON.stringify({ kind, at: new Date().toISOString(), monotonicMs: Number(process.hrtime.bigint() - this.start) / 1e6, reporterPid: process.pid, ...data }) + "\n");
  }

  onTestRunStart(specifications) { this.record("runStart", { fileCount: specifications.length }); }
  onTestModuleQueued(m) { this.record("queued", { file: m.relativeModuleId }); }
  onTestModuleCollected(m) { this.record("collected", { file: m.relativeModuleId, diagnostic: m.diagnostic() }); }
  onTestModuleStart(m) { this.record("moduleStart", { file: m.relativeModuleId, diagnostic: m.diagnostic() }); }
  onTestModuleEnd(m) { this.record("moduleEnd", { file: m.relativeModuleId, state: m.state(), diagnostic: m.diagnostic(), testCount: [...m.children.allTests()].length }); }
  onTestCaseReady(t) { this.record("caseReady", { file: t.module.relativeModuleId, id: t.id, name: t.fullName }); }
  onTestCaseResult(t) { this.record("caseResult", { file: t.module.relativeModuleId, id: t.id, name: t.fullName, outcome: t.result().state, diagnostic: t.diagnostic() }); }
  onHookStart(h) { this.record("hookStart", { name: h.name, file: h.entity.module?.relativeModuleId ?? h.entity.relativeModuleId, id: h.entity.id }); }
  onHookEnd(h) { this.record("hookEnd", { name: h.name, file: h.entity.module?.relativeModuleId ?? h.entity.relativeModuleId, id: h.entity.id }); }
  onTestRunEnd(modules, errors, reason) { this.record("runEnd", { reason, moduleCount: modules.length, errorCount: errors.length }); }
}
