const refused = () => new Error("count-capture-deployment-unknown");

async function boundedText(response, maximum) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maximum) throw refused();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw refused();
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function createCountCaptureGitHubReader({ repository, token, transport = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) throw refused();
  const base = `https://api.github.com/repos/${repository}`;
  const request = (url, authenticated) =>
    transport(url, {
      headers: authenticated
        ? {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          }
        : {},
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  return {
    async json(path) {
      if (
        !/^\/actions\/(?:workflows|runs(?:\/\d{1,20}\/attempts\/\d{1,4}\/jobs)?)\?per_page=100&page=[1-9]\d{0,3}$/.test(
          path,
        )
      )
        throw refused();
      return JSON.parse(await boundedText(await request(`${base}${path}`, true), 4_000_000));
    },
    async jobLog(jobId) {
      if (!/^\d{1,20}$/.test(jobId)) throw refused();
      let response = await request(`${base}/actions/jobs/${jobId}/logs`, true);
      if (response.status === 302) {
        const target = new URL(response.headers.get("location") ?? "");
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          target.port ||
          target.hash ||
          !(
            target.hostname.endsWith(".blob.core.windows.net") ||
            target.hostname.endsWith(".actions.githubusercontent.com")
          )
        )
          throw refused();
        // GitHub's signed download URL is never logged; the GitHub token is not forwarded.
        response = await request(target.href, false);
      }
      return boundedText(response, 16_000_000);
    },
  };
}
