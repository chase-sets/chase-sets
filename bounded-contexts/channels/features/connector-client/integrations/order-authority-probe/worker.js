(() => {
  const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/8607#issuecomment-5983720229";
  const BUCKETS = ["Shipped - In Transit", "Shipped - Delivered", "Completed - Paid", "Canceled"];
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
    "identity_mismatch",
    "selector_unknown",
    "aborted",
    "completeness_unproven",
    "page_ceiling_exceeded",
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
        config.format !== "order-authority-package/v2" ||
        !/^[a-f0-9]{40}$/.test(config.head) ||
        config.extensionId !== chrome.runtime.id ||
        !["synthetic", "operator"].includes(config.evidence) ||
        !closed(config.files, FILES)
      )
        fail("package_mismatch");
      if (
        !Number.isSafeInteger(config.cadenceMs) ||
        config.cadenceMs <= 0 ||
        (config.evidence === "operator" && config.cadenceMs !== 30000) ||
        config.cadenceSource !== AUTHORITY
      ) {
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
      format: "order-authority-receipt/v2",
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
      selector: { identity: "tcgplayer-ready-to-ship-selector/v1", searches: state.searches },
      vocabulary: state.vocabulary,
      completeness: "unknown",
      consistency: {
        snapshot: "not-observed-on-captured-surface",
        closedDateRange: "not-observed-on-captured-surface",
        immutableTieBreaker: "not-observed-on-captured-surface",
        terminalProof: "unknown",
      },
    };
  }

  async function waitForCadence(state) {
    const due = state.lastDispatch === null ? Date.now() : state.lastDispatch + state.config.cadenceMs;
    if (due >= state.latch.deadline || Date.now() >= state.latch.deadline) fail("deadline");
    if (due > Date.now()) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.cancelWait = undefined;
          resolve();
        }, due - Date.now());
        state.cancelWait = () => {
          clearTimeout(timer);
          state.cancelWait = undefined;
          reject(new Error("aborted"));
        };
      });
    }
    if (state.aborted) fail("aborted");
    if (Date.now() >= state.latch.deadline) fail("deadline");
  }

  async function dispatch(state, kind, order, searchRange = "LastTwoYears") {
    const controller = new AbortController();
    await waitForCadence(state);
    if (state.latch[kind] >= ({ lookup: 1, list: 2, detail: 4 }[kind] ?? 0)) fail("request_budget");
    let url;
    let body;
    if (kind === "lookup") url = "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0";
    if (kind === "list") {
      url = "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0";
      body = JSON.stringify({
        searchRange,
        filters: { sellerKey: state.sellerKey, orderStatuses: ["ReadyToShip"] },
        sortBy: [],
        from: 0,
        size: 500,
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
    state.controller = controller;
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
          if (observation.contentType === "text/html") fail("session_missing");
          if (response.status !== 200) fail("http_status");
          if (observation.contentType !== "application/json") fail("invalid_json");
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
      const code = state.aborted
        ? "aborted"
        : timedOut
          ? "response_timeout"
          : FAILURE_CODES.has(error?.message)
            ? error.message
            : "transport_failure";
      observation.failure = code;
      fail(code);
    } finally {
      clearTimeout(timer);
      controller.abort();
      state.controller = undefined;
      order = null;
      url = undefined;
      body = undefined;
      if (reader) void reader.cancel().catch(() => {});
      observation.elapsedMs = Date.now() - state.lastDispatch;
    }
  }

  function clear(state) {
    state.sellerKey = null;
    state.privateValues.length = 0;
    active = undefined;
  }

  // Status values are captured, not translated. Other strings are private and
  // may never masquerade as a status key, even on an otherwise valid response.
  function collectPrivate(state, value, key = "") {
    if (typeof value === "string" && !["status", "orderStatus", "orderDate"].includes(key))
      state.privateValues.push(value);
    else if (Array.isArray(value)) value.forEach((item) => collectPrivate(state, item));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([name, item]) => collectPrivate(state, item, name));
  }
  function statusKey(state, value) {
    if (
      typeof value !== "string" ||
      value.length > 64 ||
      !/^[A-Za-z]+(?:[ -]+[A-Za-z]+)*$/.test(value) ||
      state.privateValues.some((privateValue) => privateValue && value.includes(privateValue))
    )
      fail("custody_failure");
    return value;
  }
  function searchSummary(state, list, range, before) {
    const result = {
      searchRange: range,
      filter: { surface: "search-filter", key: "ReadyToShip" },
      sortBy: [],
      from: 0,
      pageSize: 500,
      before,
      after: null,
      sameSession: false,
      topLevelKeys: [],
      totalOrders: null,
      rowCount: null,
      distinctCount: null,
      listStatuses: [],
      oldestRowAgeBucket: "unknown",
      qualification: "unknown",
      reason: "invalid_shape",
    };
    if (list && Array.isArray(list.orders) && (!Number.isSafeInteger(list.totalOrders) || list.totalOrders < 0))
      fail("completeness_unproven");
    if (list && Array.isArray(list.orders) && list.orders.length > 500) fail("page_ceiling_exceeded");
    if (
      !closed(list, ["totalOrders", "orders"]) ||
      !Array.isArray(list.orders) ||
      list.orders.some((row) => !row || typeof row.orderNumber !== "string" || !row.orderNumber.trim())
    )
      fail("invalid_shape");
    collectPrivate(state, list);
    state.requests.at(-1).shape = project(list, shapes.list);
    result.topLevelKeys = Object.keys(shapes.list).filter((key) => Object.hasOwn(list, key));
    result.totalOrders = list.totalOrders;
    result.rowCount = list.orders.length;
    result.distinctCount = new Set(list.orders.map((row) => row.orderNumber)).size;
    const counts = new Map();
    for (const row of list.orders) {
      const key = statusKey(state, row.orderStatus);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > 128) fail("custody_failure");
    }
    result.listStatuses = [...counts].map(([key, count]) => ({ surface: "list-display", key, count }));
    const ages = list.orders.map((row) => {
      if (typeof row.orderDate !== "string" || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(row.orderDate)) return NaN;
      return Date.now() - Date.parse(row.orderDate);
    });
    if (!list.orders.length) result.oldestRowAgeBucket = "empty";
    else if (ages.every((age) => Number.isFinite(age) && age >= 0)) {
      const days = Math.max(...ages) / 86400000;
      result.oldestRowAgeBucket = days <= 90 ? "0-90-days" : days <= 730 ? "91-730-days" : "over-730-days";
    }
    result.reason =
      list.orders.length !== list.totalOrders
        ? "length_mismatch"
        : list.totalOrders >= 500
          ? "page_not_closed"
          : result.distinctCount !== list.orders.length
            ? "duplicate_order"
            : list.orders.some((row) => row.orderStatus !== "Ready to Ship")
              ? "filter_not_honored"
              : "counts_pending";
    return result;
  }

  async function search(state, message) {
    if (state.phase !== "search") fail("invalid_message");
    const range = state.latch.list === 0 ? "LastTwoYears" : "LastThreeMonths";
    state.fallback = false;
    try {
      const list = await dispatch(state, "list", undefined, range);
      state.searches.push(searchSummary(state, list, range, { count: message.count, dateFilter: message.dateFilter }));
    } catch (error) {
      const code = failureCode(error);
      const request = state.requests.at(-1);
      if (request?.kind === "list" && request.failure === null) request.failure = code;
      state.searches.push({
        searchRange: range,
        filter: { surface: "search-filter", key: "ReadyToShip" },
        sortBy: [],
        from: 0,
        pageSize: 500,
        before: { count: message.count, dateFilter: message.dateFilter },
        after: null,
        sameSession: false,
        topLevelKeys: [],
        totalOrders: null,
        rowCount: null,
        distinctCount: null,
        listStatuses: [],
        oldestRowAgeBucket: "unknown",
        qualification: "unknown",
        reason: code,
      });
      // Semantic closure/count/filter mismatches are not validation fallback.
      state.fallback = range === "LastTwoYears" && ["http_status", "invalid_json", "invalid_shape"].includes(code);
      if (!state.fallback) throw error;
    }
    state.phase = "counts";
    return { ok: true, code: "search_observed" };
  }

  async function capture(state, selections) {
    if (state.phase !== "details") fail("invalid_message");
    selections.forEach((selection) => {
      if (selection.orderNumber !== null) state.privateValues.push(selection.orderNumber);
    });
    try {
      for (const selection of selections) {
        const bucket = state.vocabulary.find((item) => item.listStatus.key === selection.listStatus);
        if (selection.orderNumber === null) continue;
        let order = selection.orderNumber;
        state.privateValues.push(order);
        try {
          const detail = await dispatch(state, "detail", order);
          if (!detail || typeof detail.orderNumber !== "string") fail("invalid_shape");
          collectPrivate(state, detail);
          state.requests.at(-1).shape = project(detail, shapes.detail);
          bucket.identityEquality = detail.orderNumber === order;
          if (!bucket.identityEquality) fail("identity_mismatch");
          bucket.detailStatus = { surface: "order-detail", key: statusKey(state, detail.status) };
          bucket.refundStatus = {
            present: Object.hasOwn(detail, "refundStatus"),
            type: !Object.hasOwn(detail, "refundStatus")
              ? "absent"
              : detail.refundStatus === null
                ? "null"
                : Array.isArray(detail.refundStatus)
                  ? "array"
                  : typeof detail.refundStatus,
          };
          bucket.requestIndex = state.requests.length - 1;
          bucket.qualification = "captured";
        } finally {
          order = null;
          selection.orderNumber = null;
        }
      }
    } finally {
      selections.forEach((selection) => {
        selection.orderNumber = null;
      });
    }
    const output = { ok: true, receipt: receipt(state) };
    clear(state);
    return output;
  }

  async function handle(message) {
    if (message.kind === "begin") {
      const started = Date.now();
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      if ((await chrome.storage.local.get(LATCH))[LATCH] !== undefined) fail("repeat_invocation");
      const latch = { used: true, lookup: 0, list: 0, detail: 0, deadline: started + 900000 };
      await chrome.storage.local.set({ [LATCH]: latch });
      const config = await configuration();
      active = {
        config,
        started,
        latch,
        lastDispatch: null,
        bytes: 0,
        requests: [],
        failures: [],
        sellerKey: null,
        privateValues: [],
        searches: [],
        phase: "lookup",
        fallback: false,
        aborted: false,
        vocabulary: BUCKETS.map((key) => ({
          listStatus: { surface: "list-display", key },
          detailStatus: null,
          refundStatus: null,
          identityEquality: null,
          requestIndex: null,
          qualification: "unqualified",
        })),
      };
      return { ok: true };
    }
    if (!active) fail("repeat_invocation");
    const state = active;
    try {
      if (message.kind === "cancel" || message.kind === "abort" || message.kind === "finish") {
        if (message.kind !== "finish") state.failures.push(message.kind === "abort" ? "aborted" : "canceled");
        const output = { ok: true, receipt: receipt(state) };
        clear(state);
        return output;
      }
      if (Date.now() >= state.latch.deadline) fail("deadline");
      if (message.kind === "lookup" && state.phase === "lookup") {
        let session = await dispatch(state, "lookup");
        state.sellerKey = session?.seller?.sellerKey;
        if (typeof state.sellerKey !== "string" || !state.sellerKey.trim()) fail("session_missing");
        collectPrivate(state, session);
        state.requests.at(-1).shape = project(session, shapes.lookup);
        session = null;
        state.phase = "search";
        await waitForCadence(state);
        return { ok: true };
      }
      if (message.kind === "search") return await search(state, message);
      if (message.kind === "counts" && state.phase === "counts") {
        const current = state.searches.at(-1);
        current.after = { count: message.count, dateFilter: message.dateFilter };
        current.sameSession = message.sameSession;
        if (!message.sameSession) fail("session_missing");
        if (state.fallback) {
          state.phase = "search";
          await waitForCadence(state);
          return { ok: true, code: "fallback_available" };
        }
        if (current.reason === "counts_pending") {
          current.reason =
            current.before.count === current.totalOrders &&
            message.count === current.totalOrders &&
            current.before.dateFilter === message.dateFilter
              ? "qualified"
              : "count_mismatch";
          current.qualification = current.reason === "qualified" ? "qualified" : "unknown";
        }
        state.phase = current.qualification === "qualified" ? "details" : "unknown";
        return { ok: true, code: state.phase === "details" ? "selector_qualified" : "selector_unknown" };
      }
      if (message.kind === "capture") return await capture(state, message.selections);
      fail("invalid_message");
    } catch (error) {
      state.failures.push(failureCode(error));
      const output = { ok: true, receipt: receipt(state) };
      clear(state);
      return output;
    }
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
    const simple = closed(message, ["kind"]) && ["begin", "lookup", "finish", "cancel", "abort"].includes(message.kind);
    const count =
      closed(
        message,
        message?.kind === "counts" ? ["kind", "count", "dateFilter", "sameSession"] : ["kind", "count", "dateFilter"],
      ) &&
      ["search", "counts"].includes(message.kind) &&
      Number.isSafeInteger(message.count) &&
      message.count >= 0 &&
      ["LastTwoYears", "LastThreeMonths"].includes(message.dateFilter) &&
      (message.kind !== "counts" || typeof message.sameSession === "boolean");
    const selected =
      closed(message, ["kind", "selections"]) &&
      message.kind === "capture" &&
      Array.isArray(message.selections) &&
      message.selections.length === 4 &&
      message.selections.every(
        (item, index) =>
          closed(item, ["listStatus", "orderNumber"]) &&
          item.listStatus === BUCKETS[index] &&
          (item.orderNumber === null ||
            (typeof item.orderNumber === "string" &&
              item.orderNumber.trim().length > 0 &&
              ![".", ".."].includes(item.orderNumber) &&
              encoder.encode(item.orderNumber).byteLength <= LIMITS.request &&
              !/[\u0000-\u001f\u007f]/.test(item.orderNumber))),
      ) &&
      encoder.encode(JSON.stringify(message)).byteLength <= LIMITS.request;
    if (!simple && !selected && !count) {
      if (active && !busy) clear(active);
      respond({ ok: false, code: "invalid_message" });
      return false;
    }
    if (busy) {
      if (simple && message.kind === "abort" && active) {
        active.aborted = true;
        active.cancelWait?.();
        active.controller?.abort();
        respond({ ok: true, code: "abort_requested" });
        return false;
      }
      respond({ ok: false, code: "repeat_invocation" });
      return false;
    }
    busy = true;
    const input = selected ? { kind: "capture", selections: message.selections.map((item) => ({ ...item })) } : message;
    const cleanup = () => {
      if (selected) {
        input.selections.forEach((item) => {
          item.orderNumber = null;
        });
        message.selections.forEach((item) => {
          item.orderNumber = null;
        });
      }
    };
    void handle(input)
      .then(
        (output) => {
          cleanup();
          respond(output);
        },
        (error) => {
          cleanup();
          respond({ ok: false, code: failureCode(error) });
        },
      )
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
