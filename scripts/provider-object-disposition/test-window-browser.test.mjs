import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { BROWSER_LAUNCHER, openConfinedBrowser, observeConnectComponent } from "./test-window-browser.mjs";
import { createAttemptBudget, BROWSER_BOOTSTRAP } from "./test-window-policy.mjs";

// These controls deliberately require the production confinement adapter, rather
// than making a Windows-only policy simulation stand in for actual child proof.
// Hosted Static Checks provisions Chromium and runs this zero-network suite.
const marker = "SYNTHETIC_BROWSER_PRIVATE_MARKER";
let browser;
beforeAll(async () => {
  browser = await openConfinedBrowser();
});
afterAll(async () => {
  await browser?.close();
});

async function processRecord(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

async function ownedTree() {
  const ids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  expect(ids.length).toBeLessThan(4096);
  const processes = (await Promise.all(ids.map((id) => processRecord(Number(id))))).filter(Boolean);
  const roots = [];
  for (const record of processes.filter((record) => record.parent === process.pid)) {
    const command = await readFile(`/proc/${record.pid}/cmdline`, "utf8").catch(() => "");
    if (command.startsWith(`${BROWSER_LAUNCHER}\0browser\0`)) roots.push(record);
  }
  const selected = new Map(roots.map((record) => [record.pid, record]));
  for (let size = -1; size !== selected.size; ) {
    size = selected.size;
    for (const record of processes) if (selected.has(record.parent)) selected.set(record.pid, record);
  }
  return { roots, processes: [...selected.values()] };
}

async function expectDrained(records) {
  let remaining = records;
  const deadline = Date.now() + 2000;
  do {
    remaining = (
      await Promise.all(
        remaining.map(async (record) => ((await processRecord(record.pid))?.start === record.start ? record : null)),
      )
    ).filter(Boolean);
    if (!remaining.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  expect(remaining.map(({ pid }) => pid)).toEqual([]);
}

it("AC-02 installed boundary: effective labels, nonroot descendants, dropped capabilities and nested Chromium sandbox", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("chrome://sandbox");
    // Only closed booleans leave this local diagnostics page, never page text.
    const sandbox = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()),
      );
      const enabled = (name) => rows.some(([label, value]) => label === name && value === "Yes");
      return {
        namespace: enabled("Namespace sandbox"),
        pid: enabled("PID namespaces"),
        network: enabled("Network namespaces"),
        seccomp: enabled("Seccomp-BPF sandbox"),
      };
    });
    expect(sandbox).toEqual({ namespace: true, pid: true, network: true, seccomp: true });
    const tree = await ownedTree();
    expect(tree.roots).toHaveLength(1);
    expect(tree.processes.length).toBeGreaterThan(3);
    for (const record of tree.processes) {
      const status = await readFile(`/proc/${record.pid}/status`, "utf8");
      const label = (await readFile(`/proc/${record.pid}/attr/current`, "utf8")).trim();
      expect(label).toBe("chase-sets-provider-window (unconfined)");
      expect(status.match(/^Uid:\s+(\d+)\s+(\d+)/m)?.slice(1)).toEqual([
        String(process.getuid()),
        String(process.getuid()),
      ]);
      expect(status.match(/^CapEff:\s+(\w+)/m)?.[1]).toMatch(/^0+$/);
      expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
      if (!tree.roots.some(({ pid }) => pid === record.pid))
        expect(
          status
            .match(/^NSpid:\s+(.+)$/m)?.[1]
            .trim()
            .split(/\s+/).length,
        ).toBeGreaterThanOrEqual(2);
    }
  } finally {
    await context.close();
  }
});

it.each(["close", "force-termination"])(
  "AC-02 cleanup: %s drains only this launch and leaves no persistent profile",
  async (mode) => {
    const previous = await ownedTree();
    const extra = await openConfinedBrowser();
    let owned = [];
    try {
      const context = await extra.newContext();
      await context.newPage();
      const current = await ownedTree();
      owned = current.processes.filter((record) => !previous.processes.some(({ pid }) => pid === record.pid));
      const root = current.roots.filter((record) => !previous.roots.some(({ pid }) => pid === record.pid));
      expect(root).toHaveLength(1);
      expect(owned.length).toBeGreaterThan(3);
      if (mode === "force-termination") process.kill(root[0].pid, "SIGKILL");
    } finally {
      await extra.close();
    }
    await expectDrained(owned);
    expect((await ownedTree()).roots).toEqual(previous.roots);
    expect(await readdir("/opt/chase-sets-provider-window/root/tmp")).toEqual([]);
  },
);

function syntheticSdk(stimulus = "") {
  return `/* LABELED SYNTHETIC SDK STIMULUS; NOT PROVIDER USABILITY */
    for (const component of ['account-onboarding','account-management','notification-banner']) {
      customElements.define('stripe-connect-'+component, class extends HTMLElement {
        setConnector() { this.textContent=${JSON.stringify(marker)}; }
        setOnLoaderStartInternalOnly(callback) { callback(); }
        setOnLoadErrorInternalOnly(callback) { this.syntheticError = callback; }
      });
    }
    window.StripeConnect = {init(options) { ${stimulus}; return {connect:{},update(){},logout(){}}; }};
  `;
}

async function observe(mapper, source, patch = {}) {
  let sends = 0;
  let forbidden = 0;
  const budget =
    patch.budget ?? createAttemptBudget({ expiresAt: new Date(Date.now() + 60000).toISOString(), cleanupSeconds: 1 });
  const result = await observeConnectComponent({
    browser,
    mapper,
    publishableKey: "pk_test_SYNTHETIC_6733",
    clientSecret: `SYNTHETIC_SESSION_${marker}`,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    deadlineAt: new Date(Date.now() + 500).toISOString(),
    budget,
    send: async (url, options) => {
      if (url !== BROWSER_BOOTSTRAP || options.method !== "GET") forbidden++;
      sends++;
      return new Response(source, { headers: { "content-type": "application/javascript" } });
    },
    ...patch,
  });
  return { result, counts: budget.snapshot(), sends, forbidden };
}

it("AC-05 budgets / browser: real alternate requests cap+1 shut down without disposition reserve or journal writes", async () => {
  const budget = createAttemptBudget({ expiresAt: new Date(Date.now() + 60000).toISOString(), cleanupSeconds: 1 });
  const observation = await observe(
    "connect-manage",
    syntheticSdk("for(let i=0;i<150;i++)fetch('https://api.stripe.com/v1/customers?synthetic='+i).catch(()=>{});"),
    { budget },
  );
  expect(observation.counts.browser).toBe(128);
  expect(observation.counts.disposition).toBe(0);
  expect(observation.counts.scenario).toBe(0);
  expect(observation.forbidden).toBe(0);
  expect(observation.sends).toBe(1);
  expect(observation.result.usability).toBe("unknown");
});

it("AC-06 markers / browser: SDK errors and page text never reach output or renew", async () => {
  const observation = await observe(
    "connect-notification",
    syntheticSdk(`document.body.append('${marker}');console.error('${marker}');throw new Error('${marker}');`),
  );
  expect(JSON.stringify(observation).includes(marker)).toBe(false);
  expect(observation.result.usability).toBe("unknown");
  expect(observation.sends).toBe(1);
});

describe("AC-04 browser outcomes", () => {
  it.each(["connect-setup", "connect-manage", "connect-notification"])(
    "%s: actual SDK 3.4.5 entrypoint with synthetic loader/create/render never becomes usable",
    async (mapper) => {
      const observation = await observe(mapper, syntheticSdk());
      expect(observation.sends).toBe(1);
      expect(observation.forbidden).toBe(0);
      expect(observation.result.attempted).toBe(true);
      expect(observation.result.created).toBe(true);
      expect(observation.result.mounted).toBe(true);
      expect(observation.result.usability).toBe("unknown");
      expect(observation.result.callbackInvocations).toBe(1);
      expect(JSON.stringify(observation).includes(marker)).toBe(false);
    },
  );

  it("refresh: repeat callback refuses without create/refresh/unrelated material or suppressed initialization", async () => {
    const observation = await observe(
      "connect-manage",
      syntheticSdk(
        "options.fetchClientSecret().then(() => { throw Error('SYNTHETIC_UNEXPECTED_REFRESH'); }).catch(() => {});",
      ),
    );
    expect(observation.result.attempted).toBe(true);
    expect(observation.result.created).toBe(true);
    expect(observation.result.callbackInvocations).toBe(2);
    expect(observation.sends).toBe(1);
    expect(observation.forbidden).toBe(0);
  });

  it("error, absent render/callback, expired and uninvoked stages are unknown, never a positive", async () => {
    for (const source of ["/* SYNTHETIC absent SDK */", `throw new Error(${JSON.stringify(marker)})`]) {
      const observation = await observe("connect-notification", source);
      expect(observation.result.usability).toBe("unknown");
      expect(JSON.stringify(observation).includes(marker)).toBe(false);
    }
    const expired = await observe("connect-setup", syntheticSdk(), { expiresAt: "2000-01-01T00:00:00Z" });
    expect(expired.sends).toBe(0);
    expect(expired.result.attempted).toBe(false);
    expect(expired.result.usability).toBe("unknown");
  });
});

it("AC-03 browser fence / alternate egress: whole real child denies fetch/XHR/assets/frames/workers/popups/form/beacon/WebSocket and background paths", async () => {
  const observation = await observe(
    "connect-setup",
    syntheticSdk(`
    const forbidden = 'https://api.stripe.com/${marker}?${marker}=${marker}';
    fetch(forbidden, {method:'POST',body:'${marker}'}).catch(()=>{});
    const xhr=new XMLHttpRequest();xhr.open('GET',forbidden);xhr.send();
    for (const tag of ['script','img','iframe']) {const element=document.createElement(tag);element.src=forbidden;document.body.appendChild(element);}
    try {new Worker(forbidden)} catch {}
    try {new Worker(URL.createObjectURL(new Blob(["fetch('"+forbidden+"').catch(()=>{})"],{type:'application/javascript'})))} catch {}
    try {window.open(forbidden)} catch {}
    const form=document.createElement('form');form.action=forbidden;form.method='POST';form.target='_blank';document.body.appendChild(form);try{form.submit()}catch{}
    try {navigator.sendBeacon(forbidden,'${marker}')} catch {}
    try {new WebSocket('wss://api.stripe.com/${marker}')} catch {}
    try {navigator.serviceWorker.register(forbidden).catch(()=>{})} catch {}
    try {new WebTransport('https://api.stripe.com/${marker}').ready.catch(()=>{})} catch {}
    try {const rtc=new RTCPeerConnection({iceServers:[{urls:'stun:${marker}.invalid:3478'}]});rtc.createDataChannel('${marker}');rtc.createOffer().then(o=>rtc.setLocalDescription(o));} catch {}
    console.error('${marker}'); document.body.append('${marker}');
  `),
  );
  expect(observation.sends).toBe(1);
  expect(observation.forbidden).toBe(0);
  expect(observation.counts.browser).toBeGreaterThan(1);
  expect(observation.counts.denials.length).toBeGreaterThan(0);
  expect(observation.result.usability).toBe("unknown");
  expect(JSON.stringify(observation).includes(marker)).toBe(false);
});
