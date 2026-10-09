(() => {
  const FILES = ["capture.html", "helper.js", "manifest.json", "worker.js"];
  const LIMITS = { request: 8192, lookup: 65536, page: 1048576, session: 8388608 };
  const SIZE = 8;
  const LATCH = "detectionPaginationLatch";
  const encoder = new TextEncoder();
  const origin = `chrome-extension://${chrome.runtime.id}`;
  const codes = new Set([
    "package_mismatch",
    "repeat_invocation",
    "wrong_origin",
    "invalid_message",
    "canceled",
    "aborted",
    "expired",
    "custody_loss",
    "session_loss",
    "request_cap",
    "request_bytes",
    "response_bytes",
    "session_bytes",
    "timeout",
    "redirect",
    "http_status",
    "invalid_body",
    "transport",
    "size_mismatch",
    "discovery_unknown",
    "offset_unknown",
    "range_unknown",
    "frontier_unknown",
    "frontier_expired",
    "frontier_replaced",
    "total_missing",
    "count_mismatch",
    "duplicate",
    "tail_missing",
    "unsafe_next",
    "cap_hit",
    "qualified",
  ]);
  const fail = (code) => {
    throw new Error(code);
  };
  const closed = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join();
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const token = (value) => typeof value === "string" && value.length > 0 && encoder.encode(value).length <= 8192;
  let active;
  let busy = false;
  let terminal;
  const digest = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

  async function configuration() {
    const response = await fetch(chrome.runtime.getURL("capture-config.json"), {
      credentials: "omit",
      redirect: "error",
    });
    const config = await response.json();
    if (
      !response.ok ||
      !closed(config, ["format", "head", "extensionId", "evidence", "t0", "files"]) ||
      config.format !== "detection-pagination-package/v1" ||
      !/^[a-f0-9]{40}$/.test(config.head) ||
      config.extensionId !== chrome.runtime.id ||
      !["synthetic", "operator"].includes(config.evidence) ||
      !integer(config.t0) ||
      !closed(config.files, FILES)
    )
      fail("package_mismatch");
    for (const name of FILES) {
      const bytes = await fetch(chrome.runtime.getURL(name), { credentials: "omit", redirect: "error" });
      if (!bytes.ok || (await digest(await bytes.arrayBuffer())) !== config.files[name]) fail("package_mismatch");
    }
    return config;
  }

  function receipt(state, code) {
    const qualified = code === "qualified" && state.config.evidence === "synthetic";
    return {
      format: "detection-pagination-receipt/v1",
      evidence: state.config.evidence,
      head: state.config.head,
      extensionId: chrome.runtime.id,
      digests: state.config.files,
      t0: state.config.t0,
      deadline: state.config.t0 + 900000,
      finishedAt: Date.now(),
      state:
        code === "expired"
          ? "expired"
          : code === "canceled" || code === "aborted"
            ? "canceled"
            : qualified
              ? "qualified"
              : "unknown",
      reason: code,
      requestedSize: SIZE,
      counts: { ...state.latch.counts, detail: 0, write: 0 },
      totalBytes: state.bytes,
      requests: state.requests,
      pages: state.pages,
      facts: {
        detection: qualified && state.negative ? "qualified" : "unknown",
        range: qualified ? "qualified" : "unknown",
        pagination: qualified && state.pages.length > 1 && state.total > 8 ? "qualified" : "unknown",
        caps: qualified ? "qualified" : "unknown",
        envelope: qualified && state.requests.every((read) => read.withinFinalCall) ? "qualified" : "unknown",
      },
      distinctCount: state.seen.size,
      total: state.total,
      custody: "pending-removal",
    };
  }
  function stop(state, code) {
    state.stopped = true;
    state.controller?.abort();
    state.cancelWait?.();
    clearInterval(state.heartbeat);
    clearTimeout(state.expiry);
    terminal = receipt(state, code);
    state.seller = null;
    state.frontier = null;
    state.cursor = null;
    state.cursors.clear();
    state.seen.clear();
    active = undefined;
    return { ok: true, receipt: terminal };
  }
  async function wait(state) {
    const due = state.last === null ? Date.now() : state.last + 30000;
    if (due >= state.config.t0 + 900000) fail("expired");
    if (due > Date.now())
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, due - Date.now());
        state.cancelWait = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
      });
    state.cancelWait = undefined;
    if (state.stopped) fail("aborted");
    if (Date.now() >= state.config.t0 + 900000) fail("expired");
  }

  async function read(state, kind) {
    await wait(state);
    if (state.latch.counts[kind] >= (kind === "lookup" ? 1 : 8)) fail("request_cap");
    const url =
      kind === "lookup"
        ? "https://sp-api.tcgplayer.com/account/auth-detail?api-version=1.0"
        : "https://order-management-api.tcgplayer.com/orders/search?api-version=2.0";
    // Only the previously observed first-page wire shape is available live.
    // Synthetic cursors are a software control, never a discovered provider contract.
    const body =
      kind === "lookup"
        ? undefined
        : JSON.stringify({
            searchRange: "LastTwoYears",
            filters: { sellerKey: state.seller, orderStatuses: ["ReadyToShip"] },
            sortBy: [],
            from: 0,
            size: SIZE,
            ...(state.config.evidence === "synthetic" && state.cursor !== null ? { cursor: state.cursor } : {}),
          });
    const requestBytes = encoder.encode(body ?? url).length;
    if (requestBytes > LIMITS.request) fail("request_bytes");
    if (state.bytes + requestBytes > LIMITS.session) fail("session_bytes");
    state.latch.counts[kind] += 1;
    await chrome.storage.local.set({ [LATCH]: state.latch });
    state.last = Date.now();
    if (state.stopped || state.last >= state.config.t0 + 900000) fail("expired");
    state.bytes += requestBytes;
    const observation = {
      kind,
      ordinal: state.requests.length,
      startedAt: state.last,
      elapsedMs: 0,
      withinFinalCall: false,
      requestBytes,
      responseBytes: 0,
      responseComplete: false,
      status: null,
      failure: null,
    };
    state.requests.push(observation);
    const controller = new AbortController();
    state.controller = controller;
    let reader;
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              timedOut = true;
              controller.abort();
              void reader?.cancel().catch(() => {});
              reject(new Error("timeout"));
            },
            Math.min(30000, state.config.t0 + 900000 - Date.now()),
          );
        }),
        new Promise((_, reject) => {
          state.cancelRead = () => reject(new Error("aborted"));
        }),
        (async () => {
          const response = await fetch(url, {
            method: kind === "lookup" ? "GET" : "POST",
            credentials: "include",
            redirect: "manual",
            cache: "no-store",
            headers: body ? { "Content-Type": "application/json" } : {},
            body,
            signal: controller.signal,
          });
          if (state.stopped || timedOut) {
            void response.body?.cancel().catch(() => {});
            fail(timedOut ? "timeout" : "aborted");
          }
          observation.status = response.status;
          if (
            response.type === "opaqueredirect" ||
            response.redirected ||
            (response.status >= 300 && response.status < 400)
          )
            fail("redirect");
          if (
            [401, 403, 429].includes(response.status) ||
            response.headers.get("content-type")?.startsWith("text/html")
          )
            fail("session_loss");
          if (response.status !== 200) fail("http_status");
          if (!response.body || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
            fail("invalid_body");
          reader = response.body.getReader();
          const chunks = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (state.stopped || timedOut) fail(timedOut ? "timeout" : "aborted");
            if (done) break;
            observation.responseBytes += value.length;
            state.bytes += value.length;
            if (observation.responseBytes > LIMITS[kind]) fail("response_bytes");
            if (state.bytes > LIMITS.session) fail("session_bytes");
            chunks.push(value);
          }
          observation.responseComplete = true;
          const bytes = new Uint8Array(observation.responseBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            fail("invalid_body");
          }
        })(),
      ]);
    } catch (error) {
      observation.failure = codes.has(error?.message) ? error.message : "transport";
      throw new Error(observation.failure);
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
      state.controller = undefined;
      state.cancelRead = undefined;
      observation.elapsedMs = Date.now() - observation.startedAt;
      observation.withinFinalCall = observation.elapsedMs <= 10000;
    }
  }

  function collect(state, value) {
    if (!Array.isArray(value?.orders)) fail("invalid_body");
    const synthetic = state.config.evidence === "synthetic";
    const proof = synthetic ? value.syntheticAuthority : null;
    const page = {
      ordinal: state.pages.length,
      requestedSize: SIZE,
      effectiveSize: synthetic && integer(proof?.effectiveSize) ? proof.effectiveSize : null,
      rowCount: value.orders.length,
      distinctCount: 0,
      total: integer(value.totalOrders) ? value.totalOrders : null,
      snapshotCount: integer(proof?.snapshotCount) ? proof.snapshotCount : null,
      snapshotPresent: token(proof?.snapshot),
      snapshotEqual: false,
      cursorPresent: token(proof?.next),
      cursorAdvance: false,
      sameSession: synthetic && proof?.seller === state.seller,
      allEligible: synthetic && proof?.allEligible === true,
      hardResultCap: integer(proof?.resultCap) ? proof.resultCap : null,
      hardPageCap: integer(proof?.pageCap) ? proof.pageCap : null,
      stable:
        synthetic &&
        ["snapshot", "keyset"].includes(proof?.mechanism) &&
        proof?.immutableTie === true &&
        proof?.entryCoverage === true,
      negativeCovered: synthetic && proof?.negativeCovered === true && proof?.olderEntryCovered === true,
      terminal: synthetic && proof?.terminal === true,
    };
    state.pages.push(page);
    const identities = value.orders.map((row) => row?.orderNumber);
    if (identities.some((id) => !token(id)) || value.orders.some((row) => row.orderStatus !== "Ready to Ship"))
      fail("invalid_body");
    page.distinctCount = new Set(identities).size;
    if (identities.some((id) => state.seen.has(id)) || page.distinctCount !== identities.length) fail("duplicate");
    for (const id of identities) state.seen.add(id);
    if (!synthetic) return "discovery_unknown";
    if (page.effectiveSize !== SIZE || page.rowCount > SIZE) fail("size_mismatch");
    if (!page.sameSession) fail("session_loss");
    if (!page.allEligible) fail("range_unknown");
    if (!page.stable) fail(proof?.mechanism === "offset" ? "offset_unknown" : "frontier_unknown");
    if (!token(proof?.snapshot)) fail("frontier_unknown");
    if (!integer(proof?.expiresAt) || proof.expiresAt <= Date.now()) fail("frontier_expired");
    page.snapshotEqual = state.frontier === null || state.frontier === proof.snapshot;
    if (!page.snapshotEqual) fail("frontier_replaced");
    state.frontier = proof.snapshot;
    if (page.total === null || page.snapshotCount === null) fail("total_missing");
    if (page.total !== page.snapshotCount) fail("count_mismatch");
    if (state.total !== null && state.total !== page.total) fail("frontier_replaced");
    state.total = page.total;
    if (page.hardResultCap === null || page.hardPageCap === null) fail("discovery_unknown");
    if (state.total >= page.hardResultCap || state.pages.length >= page.hardPageCap) fail("cap_hit");
    if (state.pages.length === 1 && page.rowCount === 0 && !page.negativeCovered) fail("frontier_unknown");
    state.negative = page.rowCount === 0 && state.pages.length === 1 && page.negativeCovered;
    if (page.cursorPresent) {
      page.cursorAdvance = !state.cursors.has(proof.next) && proof.next !== state.cursor;
      if (proof.safeNext !== true || !page.cursorAdvance || page.terminal) fail("unsafe_next");
      state.cursors.add(proof.next);
      state.cursor = proof.next;
      return "next";
    }
    if (!page.terminal || page.rowCount === SIZE || state.seen.size !== state.total) fail("tail_missing");
    return "qualified";
  }

  async function handle(message) {
    if (message.kind === "begin") {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      if ((await chrome.storage.local.get(LATCH))[LATCH] !== undefined) fail("repeat_invocation");
      const latch = { used: true, counts: { lookup: 0, page: 0 } };
      await chrome.storage.local.set({ [LATCH]: latch });
      const config = await configuration();
      active = {
        config,
        latch,
        bytes: 0,
        requests: [],
        pages: [],
        seen: new Set(),
        cursors: new Set(),
        seller: null,
        frontier: null,
        cursor: null,
        total: null,
        last: null,
        negative: false,
        stopped: false,
      };
      const state = active;
      if (Date.now() >= config.t0 + 900000 || Date.now() < config.t0) return stop(state, "expired");
      state.heartbeat = setInterval(() => {
        void chrome.runtime.getPlatformInfo().catch(() => {
          state.cancelRead?.();
          stop(state, "custody_loss");
        });
      }, 20000);
      state.expiry = setTimeout(
        () => {
          state.cancelRead?.();
          stop(state, "expired");
        },
        config.t0 + 900000 - Date.now(),
      );
      return { ok: true };
    }
    if (!active) {
      if (message.kind === "finish" && terminal) {
        const output = terminal;
        terminal = undefined;
        return { ok: true, receipt: output };
      }
      fail("repeat_invocation");
    }
    const state = active;
    try {
      if (["cancel", "abort", "finish"].includes(message.kind))
        return stop(
          state,
          message.kind === "cancel"
            ? "canceled"
            : message.kind === "abort"
              ? "aborted"
              : state.latch.counts.page === 8
                ? "request_cap"
                : "discovery_unknown",
        );
      if (message.kind === "lookup" && state.latch.counts.lookup === 0) {
        const value = await read(state, "lookup");
        if (!token(value?.seller?.sellerKey)) fail("session_loss");
        state.seller = value.seller.sellerKey;
        return { ok: true };
      }
      if (message.kind === "page" && state.seller !== null) {
        const code = collect(state, await read(state, "page"));
        return code === "next" ? { ok: true, code: "next" } : stop(state, code);
      }
      fail("invalid_message");
    } catch (error) {
      if (state.stopped) return { ok: true, receipt: terminal };
      return stop(state, codes.has(error?.message) ? error.message : "custody_loss");
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
    if (
      !closed(message, ["kind"]) ||
      !["begin", "lookup", "page", "finish", "cancel", "abort"].includes(message.kind)
    ) {
      if (active) {
        active.cancelRead?.();
        stop(active, "invalid_message");
      }
      respond({ ok: false, code: "invalid_message" });
      return false;
    }
    if (busy) {
      if (message.kind === "abort" && active) {
        active.cancelRead?.();
        active.controller?.abort();
        active.cancelWait?.();
      }
      respond({ ok: false, code: "repeat_invocation" });
      return false;
    }
    busy = true;
    void handle(message)
      .then(respond, (error) =>
        respond({ ok: false, code: codes.has(error?.message) ? error.message : "package_mismatch" }),
      )
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
