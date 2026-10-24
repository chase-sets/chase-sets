import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { browserPipe, partitionOwnedSnapshot, nativeCrashObserved } from "./browser-lifecycle-controls.mjs";

it("native crash proof requires an actual CoreDumping transition on the same owned browser identity", () => {
  const prior = { pid: 42, start: 100, observation: "present", coreDumping: 0 };
  const owner = { pid: 42, start: 100, image: "chrome" };
  const after = { ...prior, coreDumping: 1 };
  expect(nativeCrashObserved([prior], [after], [owner])).toBe(true);
  for (const patch of [{ coreDumping: 0 }, { coreDumping: null }, { observation: "gone" }, { start: 101 }, { pid: 43 }])
    expect(nativeCrashObserved([prior], [{ ...after, ...patch }], [owner])).toBe(false);
  expect(nativeCrashObserved([after], [after], [owner])).toBe(false);
  expect(nativeCrashObserved([prior], [after], [{ ...owner, image: "launcher" }])).toBe(false);
});

it("partitions one fresh snapshot by ancestry, never mistaking late A children for B survivors", () => {
  const root = { pid: 10, parent: 1, start: 100, image: "launcher" };
  const records = [
    { pid: 1, parent: 0, start: 1, image: "caller" },
    root,
    { pid: 11, parent: 10, start: 101, image: "launcher" },
    { pid: 12, parent: 11, start: 102, image: "chrome" },
    { pid: 13, parent: 12, start: 103, image: "chrome" },
    { pid: 20, parent: 1, start: 90, image: "launcher" },
    { pid: 21, parent: 20, start: 91, image: "chrome" },
  ];
  const before = records.filter((record) => [10, 11, 12].includes(record.pid));
  expect(
    records.filter((record) => !before.some((owned) => owned.pid === record.pid)).map((record) => record.pid),
  ).toContain(13);
  const partition = partitionOwnedSnapshot([...records].reverse(), root);
  expect(partition.owned.map((record) => record.pid).sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  expect(partition.survivors.map((record) => record.pid).sort((a, b) => a - b)).toEqual([1, 20, 21]);
  expect(() => partitionOwnedSnapshot(records, { ...root, start: 99 })).toThrow();
});

function fixture() {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  return { child, pipe: browserPipe(child) };
}

it("handles split NUL frames without publishing browser output", async () => {
  const { child, pipe } = fixture();
  const pending = pipe.request("Browser.getVersion");
  expect(JSON.parse(child.stdio[3].read().toString().slice(0, -1))).toEqual({
    id: 1,
    method: "Browser.getVersion",
    params: {},
  });
  child.stdio[4].write('{"id":1,"result":');
  child.stdio[4].write('{"synthetic":true}}\0');
  await expect(pending).resolves.toEqual({ synthetic: true });
});

it("waits for an actual crash event and distinguishes command errors", async () => {
  const { child, pipe } = fixture();
  const event = pipe.event("Inspector.targetCrashed");
  const command = pipe.request("Page.crash", {}, "SYNTHETIC_SESSION");
  const rejected = expect(command).rejects.toThrow("synthetic-browser-command-refused");
  child.stdio[4].write(
    '{"method":"Inspector.targetCrashed","params":{}}\0{"id":1,"error":{"message":"SYNTHETIC_PRIVATE"}}\0',
  );
  await expect(event).resolves.toEqual({});
  await rejected;
});

it.each(["malformed", "overflow", "closed"])("%s rejects pending work with no raw diagnostic", async (mode) => {
  const { child, pipe } = fixture();
  const pending = expect(pipe.request("Browser.getVersion")).rejects.toThrow("synthetic-browser-pipe-refused");
  if (mode === "closed") child.emit("close", 143, null);
  else child.stdio[4].write(mode === "overflow" ? Buffer.alloc(65537) : "SYNTHETIC_PRIVATE\0");
  await pending;
});
