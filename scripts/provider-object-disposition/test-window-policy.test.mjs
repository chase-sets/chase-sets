import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  BROWSER_BOOTSTRAP,
  browserRequestAllowed,
  createAttemptBudget,
  createBrowserBootstrapTransport,
} from "./test-window-policy.mjs";

const request = (patch = {}) => ({ url: BROWSER_BOOTSTRAP, method: "GET", headers: {}, body: null, ...patch });
const budget = (patch = {}) =>
  createAttemptBudget({ expiresAt: new Date(Date.now() + 60000).toISOString(), cleanupSeconds: 1, ...patch });
const marker = "SYNTHETIC_FORBIDDEN_RAW_MARKER";

describe("AC-03 browser fence", () => {
  it("exact bootstrap: exact GET send1; forbidden serialized forms send0", async () => {
    let sends = 0;
    const attempts = budget();
    const transport = createBrowserBootstrapTransport({
      budget: attempts,
      send: async (_url, options) => {
        expect(options.redirect).toBe("manual");
        expect(options.credentials).toBe("omit");
        expect(Object.keys(options.headers)).toEqual(["Accept"]);
        sends++;
        return new Response("/* SYNTHETIC SDK */", { headers: { "content-type": "application/javascript" } });
      },
    });
    expect((await transport(request())).outcome).toBe("loaded");
    for (const url of [
      `${BROWSER_BOOTSTRAP}?`,
      `${BROWSER_BOOTSTRAP}#`,
      `${BROWSER_BOOTSTRAP}?${marker}=${marker}`,
      `${BROWSER_BOOTSTRAP}#${marker}`,
      "https://connect-js.stripe.com:443/v1.0/connect.js",
      "https://connect-js.stripe.com:444/v1.0/connect.js",
      "https://user@connect-js.stripe.com/v1.0/connect.js",
      "https://connect-js.stripe.com/v1.0/%63onnect.js",
      "https://connect-js.stripe.com/alias/../v1.0/connect.js",
      "http://connect-js.stripe.com/v1.0/connect.js",
      "https://connect-js.stripe.com.evil.invalid/v1.0/connect.js",
      "https://sub.connect-js.stripe.com/v1.0/connect.js",
      "https://js.stripe.com/v1.0/connect.js",
      "https://api.stripe.com/v1/customers",
      "https://api.stripe.com/v1/payment_intents/search",
      "https://merchant-ui-api.stripe.com/v1/accounts/acct_SYNTHETIC_6733",
      "https://arbitrary.stripe.com/v1.0/connect.js",
      "file:///SYNTHETIC",
      "ws://SYNTHETIC.invalid",
      "data:text/plain,SYNTHETIC",
      "not a URL",
    ])
      expect((await transport(request({ url }))).outcome).toBe("policy-blocked");
    for (const method of ["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "get", marker])
      expect((await transport(request({ method }))).outcome).toBe("policy-blocked");
    for (const name of ["Authorization", "Cookie", "Referrer", "Referer", marker])
      expect((await transport(request({ headers: { [name]: marker } }))).outcome).toBe("policy-blocked");
    for (const body of ["", marker, new Uint8Array()])
      expect((await transport(request({ body }))).outcome).toBe("policy-blocked");
    expect(sends).toBe(1);
    expect(JSON.stringify(attempts.snapshot()).includes(marker)).toBe(false);
    expect(attempts.snapshot().denials.length).toBeLessThanOrEqual(80);
  });

  it("redirects: same/cross-origin 3xx never performs a second send; response cookies refuse", async () => {
    for (const headers of [
      { location: BROWSER_BOOTSTRAP },
      { location: "https://SYNTHETIC.invalid" },
      { "set-cookie": marker },
    ]) {
      let sends = 0;
      const transport = createBrowserBootstrapTransport({
        budget: budget(),
        send: async () => {
          sends++;
          return new Response("", { status: headers.location ? 302 : 200, headers });
        },
      });
      expect((await transport(request())).outcome).toBe("error");
      expect(sends).toBe(1);
    }
  });

  it("governing fence-removed mutant reaches the forbidden-send sentinel", async () => {
    const source = await readFile(new URL("./test-window-policy.mjs", import.meta.url), "utf8");
    const mutant = source
      .replace("if (!browserRequestAllowed(request))", "if (false)")
      .replaceAll("import.meta.url", JSON.stringify(new URL("./test-window-policy.mjs", import.meta.url).href));
    expect(mutant === source).toBe(false);
    const { createBrowserBootstrapTransport: unfenced } = await import(
      `data:text/javascript,${encodeURIComponent(mutant)}`
    );
    let sends = 0;
    const send = async () => {
      sends++;
      return new Response("SYNTHETIC");
    };
    const forbidden = request({ method: "POST", url: "https://api.stripe.com/v1/accounts" });
    await createBrowserBootstrapTransport({ budget: budget(), send })(forbidden);
    expect(sends).toBe(0);
    await unfenced({ budget: budget(), send })(forbidden);
    expect(sends).toBe(1);
  });
});

describe("AC-05 budgets / browser", () => {
  it("concurrent permit/deny cap+1 and expiry preserve disposition reserve", async () => {
    let now = 0;
    let stopped = 0;
    let sends = 0;
    const attempts = budget({ now: () => now, expiresAt: new Date(60000).toISOString(), abort: () => stopped++ });
    const transport = createBrowserBootstrapTransport({
      budget: attempts,
      send: async () => {
        sends++;
        return new Response("SYNTHETIC");
      },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 129 }, (_, index) => transport(request(index % 2 ? { method: "POST" } : {}))),
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(attempts.snapshot().browser).toBe(128);
    expect(sends).toBe(64);
    expect(stopped).toBeGreaterThan(0);
    attempts.take("disposition");
    expect(attempts.snapshot().disposition).toBe(1);
    now = 60000;
    expect(() => attempts.take("disposition")).toThrow("capture-bound");
    expect(attempts.snapshot().disposition).toBe(1);
  });
});

it("AC-06 markers / browser: all raw fields collapse into closed aggregates", async () => {
  const attempts = budget();
  const transport = createBrowserBootstrapTransport({
    budget: attempts,
    send: async () => {
      throw new Error(marker);
    },
  });
  for (const input of [
    request({ method: marker }),
    request({ url: `https://${marker}.invalid/${marker}?${marker}=${marker}` }),
    request({ headers: { Cookie: marker }, body: marker }),
  ])
    expect(JSON.stringify(await transport(input)).includes(marker)).toBe(false);
  expect(JSON.stringify(await transport(request())).includes(marker)).toBe(false);
  expect(JSON.stringify(attempts.snapshot()).includes(marker)).toBe(false);
  expect(browserRequestAllowed(request({ unknown: marker }))).toBe(false);
});
