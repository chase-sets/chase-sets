type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type SyntheticContext = { id: number; sessionId?: string };

export async function syntheticTarget(port: string, url: string) {
  const targets: unknown = await (
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  ).json();
  if (!Array.isArray(targets)) throw new Error("Synthetic target discovery refused");
  const target: unknown = targets.find(
    (value: unknown) => typeof value === "object" && value !== null && "url" in value && value.url === url,
  );
  if (
    typeof target !== "object" ||
    target === null ||
    !("webSocketDebuggerUrl" in target) ||
    typeof target.webSocketDebuggerUrl !== "string"
  )
    throw new Error("Synthetic target missing");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map<number, Pending>();
  const contexts = new Map<string, SyntheticContext>();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const reply: unknown = JSON.parse(String(event.data));
    if (typeof reply !== "object" || reply === null) return;
    if ("method" in reply && reply.method === "Target.attachedToTarget" && "params" in reply) {
      const params = reply.params;
      if (
        typeof params === "object" &&
        params !== null &&
        "sessionId" in params &&
        typeof params.sessionId === "string"
      )
        void send("Runtime.enable", {}, params.sessionId).catch(() => undefined);
    }
    if ("method" in reply && reply.method === "Runtime.executionContextCreated" && "params" in reply) {
      const params = reply.params;
      if (typeof params === "object" && params !== null && "context" in params) {
        const context = params.context;
        if (
          typeof context === "object" &&
          context !== null &&
          "id" in context &&
          typeof context.id === "number" &&
          "auxData" in context
        ) {
          const aux = context.auxData;
          if (
            typeof aux === "object" &&
            aux !== null &&
            "isDefault" in aux &&
            aux.isDefault === true &&
            "frameId" in aux &&
            typeof aux.frameId === "string"
          )
            contexts.set(aux.frameId, {
              id: context.id,
              ...("sessionId" in reply && typeof reply.sessionId === "string" ? { sessionId: reply.sessionId } : {}),
            });
        }
      }
    }
    if (!("id" in reply) || typeof reply.id !== "number") return;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    clearTimeout(call.timer);
    if ("error" in reply || !("result" in reply)) call.reject(new Error("Synthetic CDP command refused"));
    else call.resolve(reply.result);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Synthetic connection deadline"));
    }, 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Synthetic connection refused"));
    };
  });
  async function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Synthetic command deadline"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return {
    async frameDiagnostics() {
      return { frameTree: await send("Page.getFrameTree"), contexts: [...contexts] };
    },
    async evaluate(expression: string, context?: SyntheticContext): Promise<unknown> {
      const response = await send(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          ...(context === undefined ? {} : { contextId: context.id }),
        },
        context?.sessionId,
      );
      if (
        typeof response !== "object" ||
        response === null ||
        "exceptionDetails" in response ||
        !("result" in response)
      )
        throw new Error("Synthetic evaluation refused");
      const result = response.result;
      return typeof result === "object" && result !== null && "value" in result ? result.value : undefined;
    },
    async sandboxContext(): Promise<SyntheticContext | undefined> {
      const result = await send("Page.getFrameTree");
      if (typeof result !== "object" || result === null || !("frameTree" in result)) return undefined;
      function find(value: unknown): SyntheticContext | undefined {
        if (typeof value !== "object" || value === null || !("frame" in value)) return undefined;
        const frame = value.frame;
        if (
          typeof frame === "object" &&
          frame !== null &&
          "url" in frame &&
          typeof frame.url === "string" &&
          frame.url.endsWith("/sandbox.html") &&
          "id" in frame &&
          typeof frame.id === "string"
        )
          return contexts.get(frame.id);
        if ("childFrames" in value && Array.isArray(value.childFrames)) {
          for (const child of value.childFrames) {
            const id = find(child);
            if (id !== undefined) return id;
          }
        }
        return undefined;
      }
      return find(result.frameTree);
    },
    close() {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Synthetic connection closed"));
      }
      pending.clear();
      socket.close();
    },
  };
}
