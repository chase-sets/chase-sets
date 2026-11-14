export type AnalyticsBridgeFieldReader = "bounded" | "sha256" | "attribution" | "path" | "positive-integer" | "boolean";

export type AnalyticsBridgeOptions = Readonly<{
  endpoint: string;
  eventName: string;
  allowedEvents: readonly string[];
  fields: Readonly<Record<string, AnalyticsBridgeFieldReader>>;
}>;

function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildAnalyticsBridgeScript({ endpoint, eventName, allowedEvents, fields }: AnalyticsBridgeOptions) {
  return `
(() => {
  const endpoint = ${scriptJson(endpoint)};
  const allowedEvents = new Set(${scriptJson(allowedEvents)});
  const fields = ${scriptJson(fields)};

  function readBounded(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : null;
  }

  function readSha256(value) {
    const text = readBounded(value);
    return text && /^[a-f0-9]{64}$/.test(text) ? text : null;
  }

  function readAttribution(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length > 0 && text.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/.test(text) ? text : null;
  }

  function readPath(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length > 0 && text.length <= 160 && text.startsWith("/") && /^[/a-zA-Z0-9_.~%=&?-]+$/.test(text)
      ? text : null;
  }

  const readers = {
    bounded: readBounded,
    sha256: readSha256,
    attribution: readAttribution,
    path: readPath,
    "positive-integer": (value) => Number.isInteger(value) && value > 0 ? value : null,
    boolean: (value) => typeof value === "boolean" ? value : null,
  };

  window.addEventListener(${scriptJson(eventName)}, (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.event !== "string" || !allowedEvents.has(detail.event)) return;

    const payload = { event: detail.event };
    for (const [field, reader] of Object.entries(fields)) {
      payload[field] = readers[reader](detail[field]);
    }
    const body = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      return;
    }

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  });
})();
`.trim();
}
