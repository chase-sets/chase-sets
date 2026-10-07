import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { browserPipe } from "./browser-lifecycle-controls.mjs";

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
