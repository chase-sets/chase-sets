(() => {
  const AUTHORITY = "https://github.com/chase-sets/chase-sets/issues/8607#issuecomment-5983720229";
  const PROBE = "https://github.com/chase-sets/chase-sets/issues/9115";
  const FILES = ["capture.html", "helper.js", "manifest.json", "worker.js"];
  const LIMITS = { lookup: 65536, list: 1048576, request: 8192, session: 8388608 };
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
  function utc(value) {
    return (
      typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
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
    "date_filter_mismatch",
    "count_surface_mismatch",
    "display_unsettled",
    "bracket_changed",
    "count_input_invalid",
    "bracket_timing",
    "aborted",
    "completeness_unproven",
    "page_ceiling_exceeded",
  ]);
  const REFUSALS = new Set([
    "aborted",
    "date_filter_mismatch",
    "count_surface_mismatch",
    "display_unsettled",
    "bracket_changed",
    "count_input_invalid",
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
        !closed(config, [
          "format",
          "head",
          "probe",
          "t0",
          "cadenceMs",
          "cadenceSource",
          "extensionId",
          "files",
          "evidence",
        ]) ||
        config.format !== "order-authority-package/v4" ||
        config.probe !== PROBE ||
        !utc(config.t0) ||
        !/^[a-f0-9]{40}$/.test(config.head) ||
        config.extensionId !== chrome.runtime.id ||
        !["synthetic", "operator"].includes(config.evidence) ||
        !closed(config.files, FILES)
      )
        fail("package_mismatch");
      if (
        !Number.isSafeInteger(config.cadenceMs) ||
        config.cadenceMs <= 0 ||
        config.cadenceMs > 30000 ||
        (config.evidence === "operator" && config.cadenceMs !== 30000) ||
        config.cadenceSource !== AUTHORITY
      )
        fail("authority_missing");
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
  const shapes = {
    lookup: { seller: { sellerKey: null } },
    list: {
      totalOrders: null,
      orders: [
        {
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
        },
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
      format: "order-authority-receipt/v4",
      evidence: state.config.evidence,
      probe: PROBE,
      origin: "extension-service-worker",
      extensionId: chrome.runtime.id,
      head: state.config.head,
      digests: state.config.files,
      cadenceMs: state.config.cadenceMs,
      cadenceSource: AUTHORITY,
      t0: state.config.t0,
      startedAt: new Date(state.started).toISOString(),
      finishedAt: new Date(Date.now()).toISOString(),
      deadlineAt: new Date(state.latch.deadline).toISOString(),
      counts: { lookup: state.latch.lookup, list: state.latch.list, detail: 0 },
      totalBytes: state.bytes,
      requests: state.requests,
      failures: state.failures,
      selector: {
        identity: "tcgplayer-ready-to-ship-selector/v1",
        searches: state.searches.map((search) =>
          search.after
            ? search.qualification === "qualified" && state.failures.length
              ? { ...search, qualification: "unknown", reason: state.failures.at(-1) }
              : search
            : {
                ...search,
                totalOrders: null,
                rowCount: null,
                distinctCount: null,
                listStatuses: [],
                topLevelKeys: [],
                oldestRowAgeBucket: "unknown",
                qualification: "unknown",
                reason: state.failures.at(-1) ?? search.reason,
              },
        ),
      },
      completeness: "unknown",
    };
  }
  async function waitForCadence(state) {
    const due = state.lastDispatch === null ? Date.now() : state.lastDispatch + state.config.cadenceMs;
    if (due >= state.latch.deadline || Date.now() >= state.latch.deadline) fail("deadline");
    if (due > Date.now())
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
    if (state.aborted) fail("aborted");
    if (Date.now() >= state.latch.deadline) fail("deadline");
  }
  async function dispatch(state, kind, searchRange = "LastTwoYears", before) {
    const controller = new AbortController();
    await waitForCadence(state);
    if (state.latch[kind] >= ({ lookup: 1, list: 2 }[kind] ?? 0)) fail("request_budget");
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
    if (!url) fail("request_budget");
    const requestBytes = body ? encoder.encode(body).byteLength : encoder.encode(url).byteLength;
    if (requestBytes > LIMITS.request || state.bytes + requestBytes > LIMITS.session) fail("request_ceiling_exceeded");
    state.latch[kind] += 1;
    await chrome.storage.local.set({ [LATCH]: state.latch });
    state.lastDispatch = Date.now();
    if (state.lastDispatch >= state.latch.deadline) fail("deadline");
    if (
      before &&
      (Date.parse(before.observedAt) > state.lastDispatch || state.lastDispatch - Date.parse(before.observedAt) > 30000)
    )
      fail("bracket_timing");
    state.bytes += requestBytes;
    const observation = {
      kind,
      method: kind === "list" ? "POST" : "GET",
      host: kind === "lookup" ? "sp-api.tcgplayer.com" : "order-management-api.tcgplayer.com",
      version: kind === "lookup" ? "1.0" : "2.0",
      pathTemplate: kind === "lookup" ? "/account/auth-detail" : "/orders/search",
      startedAt: new Date(state.lastDispatch).toISOString(),
      endedAt: null,
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
      const ended = Date.now();
      observation.endedAt = new Date(ended).toISOString();
      observation.elapsedMs = ended - state.lastDispatch;
      clearTimeout(timer);
      controller.abort();
      state.controller = undefined;
      url = undefined;
      body = undefined;
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  function clear(state) {
    clearInterval(state.heartbeat);
    clearTimeout(state.residencyDeadline);
    state.cancelWait?.();
    state.controller?.abort();
    state.sellerKey = null;
    active = undefined;
  }
  function keepResident(state) {
    const expire = () => {
      state.expired = true;
      clear(state);
    };
    state.heartbeat = setInterval(() => {
      if (Date.now() >= state.latch.deadline) {
        expire();
        return;
      }
      void chrome.runtime.getPlatformInfo().catch(() => {
        state.aborted = true;
        clear(state);
      });
    }, 20000);
    state.residencyDeadline = setTimeout(expire, state.latch.deadline - Date.now());
  }
  function bracket(message, range) {
    if (message.countSurface !== "ready-to-ship-quick-filter") fail("count_surface_mismatch");
    if (message.dateFilter !== range) fail("date_filter_mismatch");
    if (!message.settled) fail("display_unsettled");
    if (!message.unchanged) fail("bracket_changed");
    return Object.fromEntries(
      ["count", "dateFilter", "reprompted", "countSurface", "observedAt", "settled", "unchanged"].map((key) => [
        key,
        message[key],
      ]),
    );
  }
  function searchSummary(range, before) {
    return {
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
  }
  function observeList(state, search, list) {
    if (list && Array.isArray(list.orders) && (!Number.isSafeInteger(list.totalOrders) || list.totalOrders < 0))
      fail("completeness_unproven");
    if (list && Array.isArray(list.orders) && list.orders.length > 500) fail("page_ceiling_exceeded");
    if (
      !closed(list, ["totalOrders", "orders"]) ||
      !Array.isArray(list.orders) ||
      list.orders.some((row) => !row || typeof row.orderNumber !== "string" || !row.orderNumber.trim())
    )
      fail("invalid_shape");
    state.requests.at(-1).shape = project(list, shapes.list);
    search.topLevelKeys = ["totalOrders", "orders"];
    search.totalOrders = list.totalOrders;
    search.rowCount = list.orders.length;
    search.distinctCount = new Set(list.orders.map((row) => row.orderNumber)).size;
    // Unknown status strings are private; never copy them into a vocabulary.
    const ready = list.orders.filter((row) => row.orderStatus === "Ready to Ship").length;
    search.listStatuses = ready ? [{ surface: "list-display", key: "Ready to Ship", count: ready }] : [];
    const ages = list.orders.map((row) =>
      typeof row.orderDate === "string" && /^\d{4}-\d\d-\d\d(?:T.*)?$/.test(row.orderDate)
        ? Date.now() - Date.parse(row.orderDate)
        : NaN,
    );
    if (!list.orders.length) search.oldestRowAgeBucket = "empty";
    else if (ages.every((age) => Number.isFinite(age) && age >= 0)) {
      const days = Math.max(...ages) / 86400000;
      search.oldestRowAgeBucket = days <= 90 ? "0-90-days" : days <= 730 ? "91-730-days" : "over-730-days";
    }
    search.reason =
      list.orders.length !== list.totalOrders
        ? "length_mismatch"
        : list.totalOrders >= 500
          ? "page_not_closed"
          : search.distinctCount !== list.orders.length
            ? "duplicate_order"
            : ready !== list.orders.length
              ? "filter_not_honored"
              : "counts_pending";
  }
  async function search(state, message) {
    if (state.phase !== "search") fail("invalid_message");
    const range = state.latch.list === 0 ? "LastTwoYears" : "LastThreeMonths";
    const before = bracket(message, range);
    if (
      Date.parse(before.observedAt) < state.started ||
      Date.parse(before.observedAt) > Date.now() ||
      Date.now() - Date.parse(before.observedAt) > 30000
    )
      fail("bracket_timing");
    const current = searchSummary(range, before);
    const requestCount = state.requests.length;
    state.fallback = false;
    try {
      const list = await dispatch(state, "list", range, before);
      state.searches.push(current);
      observeList(state, current, list);
    } catch (error) {
      const code = failureCode(error);
      const request = state.requests.at(-1);
      if (state.requests.length === requestCount || request?.kind !== "list") throw error;
      if (!state.searches.includes(current)) state.searches.push(current);
      if (request.failure === null) request.failure = code;
      current.reason = code;
      state.fallback = range === "LastTwoYears" && ["http_status", "invalid_json", "invalid_shape"].includes(code);
      if (!state.fallback) throw error;
    }
    state.phase = "counts";
    return { ok: true, code: "search_observed" };
  }
  function end(state) {
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
      latch.deadline = Math.min(latch.deadline, Date.parse(config.t0) + 900000);
      await chrome.storage.local.set({ [LATCH]: latch });
      active = {
        config,
        started,
        latch,
        lastDispatch: null,
        bytes: 0,
        requests: [],
        failures: [],
        sellerKey: null,
        searches: [],
        phase: "lookup",
        fallback: false,
        aborted: false,
      };
      if (started < Date.parse(config.t0) || Date.now() >= latch.deadline) {
        active.failures.push("deadline");
        return end(active);
      }
      keepResident(active);
      return { ok: true };
    }
    if (!active) fail("repeat_invocation");
    const state = active;
    try {
      if (message.kind === "cancel" || message.kind === "abort") {
        state.failures.push(message.kind === "cancel" ? "canceled" : (message.reason ?? "aborted"));
        return end(state);
      }
      if (Date.now() >= state.latch.deadline) fail("deadline");
      if (message.kind === "finish" && state.phase === "finish") return end(state);
      if (message.kind === "lookup" && state.phase === "lookup") {
        let session = await dispatch(state, "lookup");
        state.sellerKey = session?.seller?.sellerKey;
        if (typeof state.sellerKey !== "string" || !state.sellerKey.trim()) fail("session_missing");
        state.requests.at(-1).shape = project(session, shapes.lookup);
        session = null;
        state.phase = "search";
        await waitForCadence(state);
        return { ok: true };
      }
      if (message.kind === "search") return await search(state, message);
      if (message.kind === "counts" && state.phase === "counts") {
        const current = state.searches.at(-1);
        const after = bracket(message, current.searchRange);
        const ended = Date.parse(state.requests.at(-1).endedAt);
        if (
          Date.parse(after.observedAt) < ended ||
          Date.parse(after.observedAt) > Date.now() ||
          Date.parse(after.observedAt) - ended > 120000 ||
          Date.now() - ended > 120000
        )
          fail("bracket_timing");
        if (!message.sameSession) fail("session_missing");
        current.after = after;
        current.sameSession = true;
        if (current.before.count !== after.count) {
          current.reason = "count_mismatch";
          state.fallback = false;
        }
        if (state.fallback) {
          state.phase = "search";
          await waitForCadence(state);
          return { ok: true, code: "fallback_available" };
        }
        if (current.reason === "counts_pending") {
          current.reason =
            current.before.count === current.totalOrders && after.count === current.totalOrders
              ? "qualified"
              : "count_mismatch";
          current.qualification = current.reason === "qualified" ? "qualified" : "unknown";
        }
        if (current.qualification !== "qualified") return end(state);
        state.phase = "finish";
        return { ok: true, code: "selector_qualified" };
      }
      fail("invalid_message");
    } catch (error) {
      state.failures.push(state.expired ? "deadline" : failureCode(error));
      return end(state);
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
    const refusal = closed(message, ["kind", "reason"]) && message.kind === "abort" && REFUSALS.has(message.reason);
    const count =
      closed(
        message,
        message?.kind === "counts"
          ? [
              "kind",
              "count",
              "dateFilter",
              "reprompted",
              "countSurface",
              "observedAt",
              "settled",
              "unchanged",
              "sameSession",
            ]
          : ["kind", "count", "dateFilter", "reprompted", "countSurface", "observedAt", "settled", "unchanged"],
      ) &&
      ["search", "counts"].includes(message.kind) &&
      Number.isSafeInteger(message.count) &&
      message.count >= 0 &&
      message.count <= 999999999 &&
      ["LastTwoYears", "LastThreeMonths"].includes(message.dateFilter) &&
      typeof message.reprompted === "boolean" &&
      message.countSurface === "ready-to-ship-quick-filter" &&
      utc(message.observedAt) &&
      typeof message.settled === "boolean" &&
      typeof message.unchanged === "boolean" &&
      (message.kind !== "counts" || typeof message.sameSession === "boolean");
    if (!simple && !refusal && !count) {
      if (active && !busy) clear(active);
      respond({ ok: false, code: "invalid_message" });
      return false;
    }
    if (busy) {
      if ((simple || refusal) && message.kind === "abort" && active) {
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
    void handle(message)
      .then(respond, (error) => respond({ ok: false, code: failureCode(error) }))
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
