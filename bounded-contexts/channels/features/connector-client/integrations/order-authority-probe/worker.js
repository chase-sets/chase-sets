(() => {
  const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/7791#issuecomment-5621442291";
  const FILES = ["capture.html", "helper.js", "manifest.json", "worker.js"];
  const LIMITS = { lookup: 65536, list: 1048576, detail: 524288, request: 8192, session: 8388608 };
  const LATCH = "orderAuthorityLatch";
  const encoder = new TextEncoder();
  const origin = `chrome-extension://${chrome.runtime.id}`;
  let busy = false;
  let active;

  function closed(value, keys) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",")
    );
  }

  function fail(code) {
    throw new Error(code);
  }
  const FAILURE_CODES = new Set([
    "package_mismatch",
    "authority_missing",
    "repeat_invocation",
    "invalid_message",
    "wrong_origin",
    "canceled",
    "deadline",
    "request_budget",
    "request_ceiling_exceeded",
    "response_ceiling_exceeded",
    "response_timeout",
    "redirect",
    "session_missing",
    "http_status",
    "invalid_json",
    "invalid_shape",
    "transport_failure",
    "custody_failure",
  ]);
  function failureCode(error) {
    return FAILURE_CODES.has(error?.message) ? error.message : "custody_failure";
  }

  async function digest(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function configuration() {
    try {
      const response = await fetch(chrome.runtime.getURL("capture-config.json"), {
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) fail("package_mismatch");
      const config = await response.json();
      if (
        !closed(config, ["format", "head", "cadenceMs", "cadenceSource", "extensionId", "files", "evidence"]) ||
        config.format !== "order-authority-package/v1" ||
        !/^[a-f0-9]{40}$/.test(config.head) ||
        config.extensionId !== chrome.runtime.id ||
        !["synthetic", "operator"].includes(config.evidence) ||
        !closed(config.files, FILES)
      )
        fail("package_mismatch");
      if (!Number.isSafeInteger(config.cadenceMs) || config.cadenceMs <= 0 || config.cadenceSource !== AUTHORITY) {
        fail("authority_missing");
      }
      for (const file of FILES) {
        if (!/^[a-f0-9]{64}$/.test(config.files[file])) fail("package_mismatch");
        const bytes = await fetch(chrome.runtime.getURL(file), { credentials: "omit", redirect: "error" });
        if (!bytes.ok || (await digest(await bytes.arrayBuffer())) !== config.files[file]) fail("package_mismatch");
      }
      return config;
    } catch (error) {
      fail(error?.message === "authority_missing" ? "authority_missing" : "package_mismatch");
    }
  }

  // Only fixed schema names leave memory. Unknown names, including nested names,
  // are counted at the omitted boundary rather than traversed or copied.
  const summary = {
    orderNumber: null,
    orderDate: null,
    orderChannel: null,
    orderStatus: null,
    buyerName: null,
    shippingType: null,
    productAmount: null,
    shippingAmount: null,
    totalAmount: null,
    buyerPaid: null,
    orderFulfillment: null,
  };
  const shapes = {
    lookup: { seller: { sellerKey: null } },
    list: { totalOrders: null, orders: [summary] },
    detail: {
      createdAt: null,
      status: null,
      orderChannel: null,
      orderFulfillment: null,
      orderNumber: null,
      sellerName: null,
      buyerName: null,
      paymentType: null,
      pickupStatus: null,
      shippingType: null,
      estimatedDeliveryDate: null,
      refundStatus: null,
      refunds: null,
      trackingNumbers: null,
      allowedActions: null,
      transaction: {
        productAmount: null,
        shippingAmount: null,
        grossAmount: null,
        feeAmount: null,
        netAmount: null,
        directFeeAmount: null,
        taxes: [{ code: null, amount: null }],
      },
      shippingAddress: {
        recipientName: null,
        addressOne: null,
        addressTwo: null,
        city: null,
        territory: null,
        country: null,
        postalCode: null,
      },
      products: [
        { name: null, unitPrice: null, extendedPrice: null, quantity: null, url: null, productId: null, skuId: null },
      ],
    },
  };
  function project(value, schema) {
    const fields = new Map();
    let omittedFields = 0;
    function visit(item, allowed, prefix) {
      if (item === null || typeof item !== "object") return;
      if (allowed === null) {
        omittedFields += Object.keys(item).length;
        return;
      }
      if (Array.isArray(allowed)) {
        if (Array.isArray(item)) for (const member of item) visit(member, allowed[0], `${prefix}[]`);
        return;
      }
      if (Array.isArray(item)) return;
      for (const key of Object.keys(item)) {
        if (!Object.hasOwn(allowed, key)) {
          omittedFields += 1;
          continue;
        }
        const path = prefix ? `${prefix}.${key}` : key;
        const type = item[key] === null ? "null" : Array.isArray(item[key]) ? "array" : typeof item[key];
        if (!fields.has(path)) fields.set(path, new Set());
        fields.get(path).add(type);
        visit(item[key], allowed[key], path);
      }
    }
    visit(value, schema, "");
    return { fields: [...fields].map(([field, types]) => ({ field, types: [...types].sort() })), omittedFields };
  }

  function receipt(state) {
    return {
      format: "order-authority-receipt/v1",
      evidence: state.config.evidence,
      origin: "extension-service-worker",
      extensionId: chrome.runtime.id,
      head: state.config.head,
      digests: state.config.files,
      cadenceMs: state.config.cadenceMs,
      cadenceSource: AUTHORITY,
      startedAt: new Date(state.started).toISOString(),
      finishedAt: new Date(Date.now()).toISOString(),
      deadlineAt: new Date(state.latch.deadline).toISOString(),
      counts: { lookup: state.latch.lookup, list: state.latch.list, detail: state.latch.detail },
      totalBytes: state.bytes,
      requests: state.requests,
      failures: state.failures,
      listDetailEquality: state.equality,
      completeness: "unknown",
      consistency: {
        snapshot: "not-observed-on-captured-surface",
        closedDateRange: "not-observed-on-captured-surface",
        immutableTieBreaker: "not-observed-on-captured-surface",
        terminalProof: "unknown",
      },
      syntheticEncodingExample: { input: "SYNTHETIC/order ?#", encoded: "SYNTHETIC%2Forder%20%3F%23" },
    };
  }

  async function dispatch(state, kind, order, sellerKey) {
    const controller = new AbortController();
    const due = state.lastDispatch === null ? Date.now() : state.lastDispatch + state.config.cadenceMs;
    if (due >= state.latch.deadline || Date.now() >= state.latch.deadline) fail("deadline");
    if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
    if (Date.now() >= state.latch.deadline) fail("deadline");
    if (state.latch[kind] >= (kind === "lookup" ? 1 : 3)) fail("request_budget");
    let url;
    let body;
    if (kind === "lookup") url = "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0";
    if (kind === "list") {
      url = "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0";
      body = JSON.stringify({
        searchRange: "LastThreeMonths",
        filters: { sellerKey },
        sortBy: [
          { sortingType: "orderStatus", direction: "ascending" },
          { sortingType: "orderDate", direction: "ascending" },
        ],
        from: 0,
        size: 25,
      });
    }
    if (kind === "detail")
      url = `https://order-management-api.tcgplayer.com/orders/${encodeURIComponent(order)}?api-version=2.0`;
    if (!url) fail("request_budget");
    const requestBytes = body ? encoder.encode(body).byteLength : encoder.encode(url).byteLength;
    if (requestBytes > LIMITS.request || state.bytes + requestBytes > LIMITS.session) fail("request_ceiling_exceeded");
    state.latch[kind] += 1;
    await chrome.storage.local.set({ [LATCH]: state.latch });
    state.lastDispatch = Date.now();
    if (state.lastDispatch >= state.latch.deadline) fail("deadline");
    state.bytes += requestBytes;
    const observation = {
      kind,
      method: kind === "list" ? "POST" : "GET",
      host: kind === "lookup" ? "sp-api.tcgplayer.com" : "order-management-api.tcgplayer.com",
      version: kind === "lookup" ? "1.0" : "2.0",
      pathTemplate:
        kind === "lookup"
          ? "/account/auth-detail"
          : kind === "list"
            ? "/orders/search"
            : "/orders/{encodedOrderNumber}",
      startedAt: new Date(state.lastDispatch).toISOString(),
      elapsedMs: 0,
      status: null,
      redirect: "unknown",
      contentType: "unknown",
      credentials: "include",
      authorizationPresent: false,
      requestBytes,
      responseBytes: 0,
      responseComplete: false,
      ceilingBytes: LIMITS[kind],
      nearCeiling: false,
      shape: null,
      failure: null,
    };
    state.requests.push(observation);
    let reader;
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
          if (reader) void reader.cancel().catch(() => {});
          reject(new Error("response_timeout"));
        },
        Math.min(30000, state.latch.deadline - Date.now()),
      );
    });
    try {
      return await Promise.race([
        timeout,
        (async () => {
          const response = await fetch(url, {
            method: observation.method,
            credentials: "include",
            redirect: "manual",
            cache: "no-store",
            headers: body ? { "Content-Type": "application/json" } : {},
            body,
            signal: controller.signal,
          });
          if (timedOut) {
            if (response.body) void response.body.cancel().catch(() => {});
            fail("response_timeout");
          }
          if (response.body) reader = response.body.getReader();
          observation.status = response.status;
          if (
            response.type === "opaqueredirect" ||
            response.redirected ||
            (response.status >= 300 && response.status < 400)
          ) {
            observation.redirect = response.type === "opaqueredirect" ? "opaque-destination-unknown" : "blocked";
            fail("redirect");
          }
          observation.redirect = "none";
          const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
          observation.contentType =
            contentType === "application/json"
              ? "application/json"
              : contentType === "text/html"
                ? "text/html"
                : "other";
          if ([401, 403, 429].includes(response.status)) fail("session_missing");
          if (!response.ok) fail("http_status");
          if (observation.contentType !== "application/json") fail("invalid_json");
          if (!response.body) fail("invalid_json");
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (timedOut) fail("response_timeout");
            if (done) break;
            observation.responseBytes += value.byteLength;
            observation.nearCeiling = observation.responseBytes >= LIMITS[kind] / 2;
            state.bytes += value.byteLength;
            if (observation.responseBytes > LIMITS[kind] || state.bytes > LIMITS.session)
              fail("response_ceiling_exceeded");
            chunks.push(value);
          }
          observation.responseComplete = true;
          const bytes = new Uint8Array(observation.responseBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            fail("invalid_json");
          }
        })(),
      ]);
    } catch (error) {
      const code = timedOut
        ? "response_timeout"
        : FAILURE_CODES.has(error?.message)
          ? error.message
          : "transport_failure";
      observation.failure = code;
      fail(code);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      observation.elapsedMs = Date.now() - state.lastDispatch;
    }
  }

  async function capture(state, order) {
    try {
      const session = await dispatch(state, "lookup");
      const sellerKey = session?.seller?.sellerKey;
      if (typeof sellerKey !== "string" || !sellerKey.trim()) fail("session_missing");
      state.requests.at(-1).shape = project(session, shapes.lookup);
      const list = await dispatch(state, "list", undefined, sellerKey);
      if (
        !list ||
        !Array.isArray(list.orders) ||
        list.orders.length > 25 ||
        !Number.isSafeInteger(list.totalOrders) ||
        list.totalOrders < list.orders.length ||
        list.orders.some((row) => !row || typeof row.orderNumber !== "string")
      )
        fail("invalid_shape");
      state.requests.at(-1).shape = project(list, shapes.list);
      const matching = list.orders.filter((row) => row.orderNumber === order).length;
      const detail = await dispatch(state, "detail", order);
      if (!detail || typeof detail.orderNumber !== "string") fail("invalid_shape");
      state.requests.at(-1).shape = project(detail, shapes.detail);
      state.equality = matching === 1 ? detail.orderNumber === order : null;
    } catch (error) {
      state.failures.push(failureCode(error));
    }
    return { ok: true, receipt: receipt(state) };
  }

  async function handle(message) {
    if (message.kind === "begin") {
      const started = Date.now();
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      if ((await chrome.storage.local.get(LATCH))[LATCH] !== undefined) fail("repeat_invocation");
      const latch = { used: true, lookup: 0, list: 0, detail: 0, deadline: started + 900000 };
      await chrome.storage.local.set({ [LATCH]: latch });
      const config = await configuration();
      active = { config, started, latch, lastDispatch: null, bytes: 0, requests: [], failures: [], equality: null };
      return { ok: true };
    }
    if (!active) fail("repeat_invocation");
    const state = active;
    active = undefined;
    if (message.kind === "cancel") {
      state.failures.push("canceled");
      return { ok: true, receipt: receipt(state) };
    }
    return capture(state, message.orderNumber);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== `${origin}/capture.html` ||
      sender.origin !== origin ||
      sender.frameId !== 0
    ) {
      respond({ ok: false, code: "wrong_origin" });
      return false;
    }
    const simple = closed(message, ["kind"]) && ["begin", "cancel"].includes(message.kind);
    const selected =
      closed(message, ["kind", "orderNumber"]) &&
      message.kind === "capture" &&
      typeof message.orderNumber === "string" &&
      message.orderNumber.trim().length > 0 &&
      ![".", ".."].includes(message.orderNumber) &&
      encoder.encode(message.orderNumber).byteLength <= LIMITS.request &&
      !/[\u0000-\u001f\u007f]/.test(message.orderNumber);
    if (!simple && !selected) {
      respond({ ok: false, code: "invalid_message" });
      return false;
    }
    if (busy) {
      respond({ ok: false, code: "repeat_invocation" });
      return false;
    }
    busy = true;
    void handle(message)
      .then(respond, (error) => respond({ ok: false, code: failureCode(error) }))
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
