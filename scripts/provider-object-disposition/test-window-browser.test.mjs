import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openConfinedBrowser, observeConnectComponent } from "./test-window-browser.mjs";
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
