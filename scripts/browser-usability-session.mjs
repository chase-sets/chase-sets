import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

// Called inside the browser tool's Node session. The timer is code-owned, not
// a deadline that the participant must remember to check between model turns.
export function createBrowserUsabilitySession({ directory, tab, now = () => performance.now() }) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== "browser-usability/v1") throw new Error("Unsupported probe manifest.");
  if (!Number.isSafeInteger(manifest.budgetMs) || manifest.budgetMs < 1 || manifest.budgetMs > 600_000)
    throw new Error("Invalid time budget.");
  if (!Number.isSafeInteger(manifest.maxActions) || manifest.maxActions < 1 || manifest.maxActions > 50)
    throw new Error("Invalid action budget.");
  const began = now();
  const resultPath = path.join(directory, "run.json");
  const receipt = {
    schema: manifest.schema,
    runId: manifest.runId,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    startedAt: new Date().toISOString(),
    pageReadyMs: null,
    elapsedMs: null,
    status: "running",
    actions: 0,
    calls: [],
    screenshots: [],
    participant: null,
  };
  // Refuse to silently replace an earlier attempt, including a crashed one.
  writeFileSync(resultPath, JSON.stringify(receipt, null, 2), { flag: "wx" });
  let observed = false;
  let started = false;
  let busy = false;
  let rejectDeadline;
  let timer;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  // The timer also runs while the model is thinking, when nobody awaits it.
  deadline.catch(() => {});
  const flush = () => writeFileSync(resultPath, JSON.stringify(receipt, null, 2) + "\n");
  const close = () =>
    Promise.resolve()
      .then(() => tab.close())
      .catch(() => {});
  function end(status, reason = null) {
    if (receipt.status !== "running") return;
    receipt.status = status;
    receipt.reason = reason;
    receipt.elapsedMs = Math.max(0, now() - began);
    receipt.endedAt = new Date().toISOString();
    clearTimeout(timer);
    for (const call of receipt.calls) {
      if (call.status === "running") {
        call.status = "interrupted";
        call.durationMs = Math.max(0, now() - began - call.startedMs);
      }
    }
    flush();
  }
  function expire(reason) {
    end("timed-out", reason);
    rejectDeadline(new Error(`Browser probe stopped: ${reason}`));
    void close();
  }
  timer = setTimeout(() => expire("wall-clock-budget"), manifest.budgetMs);
  timer.unref?.();

  async function call(method, execute) {
    if (receipt.status !== "running") throw new Error(`Probe is ${receipt.status}.`);
    if (busy) throw new Error("Probe browser calls must be sequential.");
    if (now() - began >= manifest.budgetMs) {
      expire("wall-clock-budget");
      throw new Error("Probe deadline exceeded.");
    }
    busy = true;
    const entry = { method, startedMs: now() - began, durationMs: null, status: "running" };
    receipt.calls.push(entry);
    flush();
    try {
      const value = await Promise.race([Promise.resolve().then(execute), deadline]);
      if (receipt.status !== "running") throw new Error(`Probe is ${receipt.status}.`);
      entry.status = "ok";
      return value;
    } catch (error) {
      if (receipt.status === "running") entry.status = "error";
      // Do not persist entered values, raw DOM, URLs with tokens, or exception text.
      throw error;
    } finally {
      if (receipt.status === "running") {
        entry.durationMs = Math.max(0, now() - began - entry.startedMs);
        flush();
      }
      busy = false;
    }
  }

  return {
    async start() {
      if (started) throw new Error("The attempt has already started.");
      started = true;
      await call("initial-navigation", () => tab.goto(manifest.startUrl));
      return this.observe();
    },
    async observe() {
      const screenshot = await call("screenshot", () => tab.getScreenshot({ emit: false }));
      const name = `screen-${String(receipt.screenshots.length + 1).padStart(3, "0")}.png`;
      mkdirSync(path.join(directory, "screenshots"), { recursive: true });
      writeFileSync(path.join(directory, "screenshots", name), screenshot);
      receipt.screenshots.push(`screenshots/${name}`);
      const state = await call("accessibility", () => tab.getAXState({ emit: false, disableDiffing: true }));
      if (receipt.pageReadyMs === null) receipt.pageReadyMs = now() - began;
      observed = true;
      flush();
      return { screenshot, state };
    },
    async act(method, args, visibleTarget) {
      if (!observed) throw new Error("Observe a screenshot and fresh accessibility state before each action.");
      if (typeof visibleTarget !== "string" || !visibleTarget.trim()) throw new Error("Name the visible target.");
      if (!["click", "typeText", "pressKey", "scroll", "back", "reload", "performSecondaryAction"].includes(method))
        throw new Error("Unsupported participant browser action.");
      if (receipt.actions >= manifest.maxActions) {
        expire("action-budget");
        throw new Error("Probe action budget exceeded.");
      }
      observed = false;
      receipt.actions += 1;
      await call(method, () => tab[method](...args));
      return this.observe();
    },
    async finish({ status, answer, obstacles = [] }) {
      if (!["complete", "partial", "blocked"].includes(status)) throw new Error("Invalid participant status.");
      if (receipt.status !== "running") throw new Error(`Probe is ${receipt.status}.`);
      if (busy || !observed) throw new Error("Observe the final state before finishing.");
      if (typeof answer !== "string" || !answer.trim() || answer.length > 8000)
        throw new Error("Provide a bounded answer.");
      if (!Array.isArray(obstacles) || obstacles.some((entry) => typeof entry !== "string" || entry.length > 1000))
        throw new Error("Invalid obstacles.");
      receipt.participant = { status, answer, obstacles };
      end("finished");
      await close();
      return { runId: receipt.runId, status: "unadjudicated", elapsedMs: receipt.elapsedMs };
    },
  };
}
