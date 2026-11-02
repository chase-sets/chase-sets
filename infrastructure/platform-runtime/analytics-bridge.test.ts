import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildAnalyticsBridgeScript } from "./analytics-bridge";

class FixtureEvent {
  constructor(readonly detail: unknown) {}
}

function install(sendBeacon?: ReturnType<typeof vi.fn>) {
  let listener = (_event: FixtureEvent) => {};
  const fetch = vi.fn().mockResolvedValue(undefined);
  const addEventListener = vi.fn((_name: string, handler: (event: FixtureEvent) => void) => {
    listener = handler;
  });
  const script = buildAnalyticsBridgeScript({
    endpoint: "/analytics/fixture",
    eventName: "fixture-analytics",
    allowedEvents: ["accepted"],
    fields: {
      label: "bounded",
      hash: "sha256",
      attribution: "attribution",
      path: "path",
      position: "positive-integer",
      checked: "boolean",
    },
  });
  runInNewContext(script, {
    window: { addEventListener },
    navigator: { sendBeacon },
    fetch,
    Blob,
    CustomEvent: FixtureEvent,
  });
  return {
    fetch,
    addEventListener,
    emit: (detail: unknown) => listener(new FixtureEvent(detail)),
    plainEvent: () => listener({ detail: { event: "accepted" } }),
  };
}

describe("analytics bridge", () => {
  it("analytics bridge builder filters events, picks bounded fields, prefers sendBeacon and falls back to keepalive fetch", async () => {
    const beacon = vi.fn().mockReturnValue(false);
    const browser = install(beacon);
    expect(browser.addEventListener.mock.calls[0][0]).toBe("fixture-analytics");
    browser.emit({ event: "rejected" });
    browser.emit(null);
    browser.emit({});
    browser.plainEvent();
    expect(beacon).not.toHaveBeenCalled();
    const detail = {
      event: "accepted",
      label: " label.value ",
      hash: "a".repeat(64),
      attribution: " Campaign +1% ",
      path: " /search?q=a&sort=b ",
      position: 10001,
      checked: false,
      private: "omitted",
    };
    browser.emit(detail);
    expect(beacon).toHaveBeenCalledTimes(1);
    const [endpoint, blob] = beacon.mock.calls[0];
    expect(endpoint).toBe("/analytics/fixture");
    expect(blob.type).toBe("application/json");
    const expected = {
      event: "accepted",
      label: "label.value",
      hash: "a".repeat(64),
      attribution: "Campaign +1%",
      path: "/search?q=a&sort=b",
      position: 10001,
      checked: false,
    };
    expect(JSON.parse(await blob.text())).toEqual(expected);
    expect(browser.fetch).not.toHaveBeenCalled();
    const fallback = install();
    fallback.emit(detail);
    expect(fallback.fetch).toHaveBeenCalledWith("/analytics/fixture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(expected),
      credentials: "same-origin",
      keepalive: true,
    });
    fallback.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(() => fallback.emit(detail)).not.toThrow();
    await Promise.resolve();
  });

  it.each([
    ["label", "a".repeat(80), "a".repeat(80)],
    ["label", "a".repeat(81), null],
    ["label", "", null],
    ["label", "private text", null],
    ["label", 2, null],
    ["hash", " a" + "a".repeat(63) + " ", "a".repeat(64)],
    ["hash", "A".repeat(64), null],
    ["hash", "a".repeat(63), null],
    ["hash", "a".repeat(65), null],
    ["attribution", "a".repeat(120), "a".repeat(120)],
    ["attribution", "a".repeat(121), null],
    ["attribution", "_campaign", null],
    ["attribution", "private@text", null],
    ["path", "/" + "a".repeat(159), "/" + "a".repeat(159)],
    ["path", "/" + "a".repeat(160), null],
    ["path", "relative", null],
    ["path", "/private#text", null],
    ["position", 1, 1],
    ["position", 0, null],
    ["position", -1, null],
    ["position", 1.5, null],
    ["position", "1", null],
    ["checked", true, true],
    ["checked", false, false],
    ["checked", "true", null],
  ])("preserves the %s reader boundary for %j", (field, value, expected) => {
    const browser = install();
    browser.emit({ event: "accepted", [field]: value });
    expect(JSON.parse(browser.fetch.mock.calls[0][1].body)[field]).toEqual(expected);
  });

  it("encodes script configuration without an HTML script terminator", () => {
    expect(
      buildAnalyticsBridgeScript({ endpoint: "</script>", eventName: "fixture", allowedEvents: [], fields: {} }),
    ).not.toContain("</script>");
  });
});
