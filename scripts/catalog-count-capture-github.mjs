// Bounded, read-only GitHub Actions transport for the count-lifecycle deployment
// collector. Every request is one exact allowlisted path, never retried or
// redirected (except GitHub's single signed log download, which never receives
// the token), and one deadline covers the headers and the complete body.
// Failures are value-free: callers learn only that the read was refused.

// Caps derive from the retained production-shaped evidence of Platform Deploy run
// 38349636491 (../.orchestrator/logs/9424-ac5-packet-r1): a run (or attempt) object is 13,235
// bytes and the largest job 12,866 bytes, so a 100-item page is about 1.3 MB; the
// executed Deploy Staging log is 728,996 bytes; the largest workflow definition,
// platform-production.yml, is 282,215 bytes. Each cap keeps at least 3x headroom.
export const countCaptureGitHubLimits = Object.freeze({
  jsonBytes: 4_000_000,
  logBytes: 8_388_608,
  workflowBytes: 1_048_576,
  deadlineMs: 30_000,
});

const refused = () => new Error("count-capture-deployment-unknown");
const instantSecond = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`;
const jsonPaths = [
  new RegExp(String.raw`^/actions/runs\?per_page=100&page=[1-9]\d{0,3}&created=${instantSecond}\.\.${instantSecond}$`),
  // The staging deploy generation's workflow-scoped listing (staging-deploy-generation.mjs).
  new RegExp(
    String.raw`^/actions/workflows/platform-production\.yml/runs\?per_page=100&page=[1-9]\d{0,3}&created=${instantSecond}\.\.${instantSecond}$`,
  ),
  /^\/actions\/runs\/[1-9]\d{0,19}\/attempts\/[1-9]\d{0,3}\/jobs\?per_page=100&page=[1-9]\d{0,3}$/,
  /^\/actions\/runs\/[1-9]\d{0,19}\/attempts\/[1-9]\d{0,3}$/,
];
const workflowPath = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/;
const signedLogHost = (hostname) =>
  hostname.endsWith(".blob.core.windows.net") || hostname.endsWith(".actions.githubusercontent.com");

async function readBounded(response, maximum, aborted) {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > maximum) throw refused();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw refused();
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function createCountCaptureGitHubReader({
  repository,
  token,
  transport = fetch,
  limits = countCaptureGitHubLimits,
}) {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository ?? "") || !token) throw refused();
  const base = `https://api.github.com/repos/${repository}`;

  // One deadline per logical read covers connection, headers, the optional signed
  // redirect and full body consumption, even if the transport ignores the signal.
  async function read(url, { accept, maximum, followSignedLog = false }) {
    const controller = new AbortController();
    let timer;
    const aborted = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(refused());
      }, limits.deadlineMs);
    });
    aborted.catch(() => {});
    const send = (target, authenticated) =>
      Promise.race([
        transport(target, {
          headers: authenticated
            ? { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" }
            : {},
          redirect: "manual",
          signal: controller.signal,
        }),
        aborted,
      ]);
    try {
      let response = await send(url, true);
      if (followSignedLog && response.status === 302) {
        const target = new URL(response.headers.get("location") ?? "");
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          target.port ||
          target.hash ||
          !signedLogHost(target.hostname)
        )
          throw refused();
        response = await send(target.href, false);
      }
      if (response.status !== 200) throw refused();
      return await readBounded(response, maximum, aborted);
    } catch {
      throw refused();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    async json(path) {
      if (!jsonPaths.some((pattern) => pattern.test(path))) throw refused();
      const text = await read(`${base}${path}`, { accept: "application/vnd.github+json", maximum: limits.jsonBytes });
      try {
        return JSON.parse(text);
      } catch {
        throw refused();
      }
    },
    async workflow(path, ref) {
      if (!workflowPath.test(path) || !/^[a-f0-9]{40}$/.test(ref ?? "")) throw refused();
      return read(`${base}/contents/${path}?ref=${ref}`, {
        accept: "application/vnd.github.raw+json",
        maximum: limits.workflowBytes,
      });
    },
    async jobLog(jobId) {
      if (!/^[1-9]\d{0,19}$/.test(jobId ?? "")) throw refused();
      return read(`${base}/actions/jobs/${jobId}/logs`, {
        accept: "application/vnd.github+json",
        maximum: limits.logBytes,
        followSignedLog: true,
      });
    },
  };
}
