import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runWerVisibilityControl } from "./browser-e2e-wer-control.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("bounds a minimally inherited abort and records only a PID-matched event", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "chase-sets-wer-control-"));
  directories.push(outputDirectory);
  const child = new EventEmitter();
  child.pid = 6102;
  child.exitCode = null;
  child.signalCode = null;
  const spawn = vi.fn((command, args, options) => {
    expect(command).toBe("node");
    expect(args).toEqual(["-e", "process.abort()"]);
    expect(options).toMatchObject({ inheritEnv: false, stdio: ["ignore", "pipe", "pipe"] });
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    setImmediate(() => child.emit("close", 3221226505, null));
    return child;
  });
  const packet = await runWerVisibilityControl({
    outputDirectory,
    spawn,
    query: async () => [
      { pid: "0x9999", time: "2023-11-14T22:13:20.000Z" },
      { pid: "0x17d6", time: "2023-11-14T22:13:20.000Z" },
    ],
    now: () => 1_700_000_000_000,
  });
  expect(spawn).toHaveBeenCalledOnce();
  expect(packet).toMatchObject({ pid: 6102, exitCode: 3221226505, applicationError1000Seen: true });
  expect(JSON.parse(await readFile(path.join(outputDirectory, "wer-control.json"), "utf8"))).toEqual(packet);
});
