import { describe, expect, it } from "vitest";
import { unwrapRouteEntry } from "./capture.mts";

const handler = () => {};
const router = () => ({ routes: [{ basePath: "/", path: "/x", method: "GET", handler }] });

describe("closed route-entry unwrapper", () => {
  it("accepts current positional and exact keyed successor shapes", () => {
    expect(unwrapRouteEntry(router()).entryShape).toBe("positional");
    expect(unwrapRouteEntry({ mountPath: "/api", contextMountOrdinal: 1, router: router() })).toMatchObject({
      entryShape: "keyed",
      declaredMountPath: "/api",
      declaredContextMountOrdinal: 1,
    });
  });

  it.each([
    ["neither", {}],
    ["extra", { mountPath: "/api", contextMountOrdinal: 1, router: router(), extra: true }],
    ["thenable", { then() {}, routes: [] }],
    ["wrong type", 7],
    ["wrong router", { mountPath: "/api", contextMountOrdinal: 1, router: {} }],
    ["both", { mountPath: "/api", contextMountOrdinal: 1, router: router(), routes: [] }],
  ])("rejects %s", (_name, value) => {
    expect(() => unwrapRouteEntry(value)).toThrowError(expect.objectContaining({ code: "E_ENTRY_SHAPE" }));
  });

  it("rejects accessor, proxy, and unreadable route tables", () => {
    const accessor = {
      mountPath: "/api",
      contextMountOrdinal: 1,
      get router() {
        return router();
      },
    };
    expect(() => unwrapRouteEntry(accessor)).toThrowError(expect.objectContaining({ code: "E_ENTRY_SHAPE" }));
    expect(() => unwrapRouteEntry(new Proxy(router(), {}))).toThrowError(
      expect.objectContaining({ code: "E_ENTRY_SHAPE" }),
    );
    const unreadable = {};
    Object.defineProperty(unreadable, "routes", {
      get() {
        throw new Error("no");
      },
    });
    expect(() => unwrapRouteEntry(unreadable)).toThrowError(expect.objectContaining({ code: "E_ENTRY_SHAPE" }));
  });
});
