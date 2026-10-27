const MARKETPLACE_NAMESPACE = "chase-sets-platform";
const MARKETPLACE_SELECTOR = "app.kubernetes.io/name=chase-sets-platform,app.kubernetes.io/component=marketplace";

export const marketplaceCleanupScope = Object.freeze({
  namespace: MARKETPLACE_NAMESPACE,
  selector: MARKETPLACE_SELECTOR,
  phase: "Failed",
  reason: "Evicted",
});

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function parseMemoryQuantity(value) {
  if (typeof value !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/.exec(value.trim());
  if (!match) return null;
  const multipliers = { Ki: 1, Mi: 1024, Gi: 1024 * 1024, Ti: 1024 * 1024 * 1024 };
  return Number(match[1]) * (multipliers[match[2] ?? "Ki"] ?? 1);
}

function incomplete(reason) {
  return { verdict: "INCONCLUSIVE", recurrence: "unknown", metrics: "unknown", reasons: [reason] };
}

function podEvidenceIssues(pod) {
  const metadata = object(pod?.metadata);
  const spec = object(pod?.spec);
  const status = object(pod?.status);
  const container = Array.isArray(spec?.containers)
    ? (spec.containers.find((entry) => entry?.name === "marketplace") ?? spec.containers[0])
    : null;
  const digest = typeof container?.image === "string" && container.image.includes("@sha256:") ? container.image : null;
  const issues = [];
  for (const [label, value] of [
    ["namespace", metadata?.namespace],
    ["ownerReferences", metadata?.ownerReferences],
    ["startTime", status?.startTime ?? metadata?.creationTimestamp],
    ["phase", status?.phase],
    ["imageDigest", digest],
    ["resources", container?.resources],
  ]) {
    if (!hasValue(value) || (label === "ownerReferences" && !Array.isArray(value))) issues.push(`missing ${label}`);
  }
  if (metadata?.namespace !== MARKETPLACE_NAMESPACE) issues.push("namespace mismatch");
  return issues;
}

/** Classifies a retained recurrence package without treating absent metrics as healthy. */
export function classifyMarketplaceMemoryEvidence(packageInput) {
  const pkg = object(packageInput);
  if (!pkg) return incomplete("package is not an object");
  if (pkg.complete === false || pkg.truncated === true || pkg.metadata?.continue)
    return incomplete("capture is truncated");
  const deployment = object(pkg.marketplaceDeployment ?? pkg.deployment);
  const pods = Array.isArray(pkg.marketplacePods?.items)
    ? pkg.marketplacePods.items
    : Array.isArray(pkg.pods)
      ? pkg.pods
      : null;
  const nodes = object(pkg.nodeMetrics ?? pkg.nodes?.metrics);
  const events = Array.isArray(pkg.nodeEvents ?? pkg.events) ? (pkg.nodeEvents ?? pkg.events) : null;
  if (!deployment || !pods || pods.length === 0 || !events)
    return incomplete("required workload or event evidence is missing");
  const podIssues = pods.flatMap((pod) => podEvidenceIssues(pod));
  if (podIssues.length > 0) return incomplete(podIssues[0]);
  const contradictory = pods.some((pod) => pod.status?.phase === "Running" && pod.status?.reason === "Evicted");
  const readyRunningPods = pods.filter(
    (pod) =>
      pod.status?.phase === "Running" &&
      pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"),
  );
  if (
    contradictory ||
    deployment.spec?.replicas !== 1 ||
    deployment.status?.readyReplicas !== 1 ||
    readyRunningPods.length !== deployment.status.readyReplicas
  ) {
    return incomplete("deployment or pod evidence is contradictory");
  }
  const metricsAvailable = Array.isArray(nodes?.items) && nodes.items.length > 0;
  const rolloutAt = Date.parse(
    deployment.status?.conditions?.find((condition) => condition.type === "Progressing")?.lastUpdateTime ?? "",
  );
  const starts = pods
    .map((pod) => Date.parse(pod.status.startTime ?? pod.metadata.creationTimestamp ?? ""))
    .filter(Number.isFinite);
  const overlap = Number.isFinite(rolloutAt) && starts.some((start) => Math.abs(start - rolloutAt) <= 15 * 60 * 1000);
  return {
    verdict: metricsAvailable ? "PASS" : "UNKNOWN",
    recurrence: overlap ? "deploy-time-overlap" : "steady-state",
    metrics: metricsAvailable ? "available" : "unknown",
    reasons: metricsAvailable ? [] : ["node metrics unavailable"],
    affectedPodCount: pods.length,
  };
}

/** Selects only the bounded terminal marketplace cleanup set. */
export function selectEvictedMarketplacePods(inventory) {
  const input = object(inventory);
  const items = Array.isArray(input?.items) ? input.items : [];
  return items
    .filter(
      (pod) =>
        pod?.metadata?.namespace === MARKETPLACE_NAMESPACE &&
        pod?.metadata?.labels?.["app.kubernetes.io/name"] === "chase-sets-platform" &&
        pod?.metadata?.labels?.["app.kubernetes.io/component"] === "marketplace" &&
        pod?.status?.phase === "Failed" &&
        pod?.status?.reason === "Evicted",
    )
    .map((pod) => pod.metadata.name)
    .filter(Boolean);
}

export function buildMarketplaceEvictionCleanupCommand({ context = "$KUBE_CONTEXT", expectedCount } = {}) {
  const countGuard = Number.isInteger(expectedCount)
    ? `if($names.Count -ne ${expectedCount}){ throw \"refusing unexpected Evicted marketplace count: $($names.Count)\" }; `
    : "";
  return `$ctx='${context}'; $ns='${MARKETPLACE_NAMESPACE}'; $label='${MARKETPLACE_SELECTOR}'; $p=kubectl --context $ctx --request-timeout=30s -n $ns get pods -l $label --field-selector=status.phase=Failed -o json | ConvertFrom-Json; $names=@($p.items | Where-Object { $_.status.reason -eq 'Evicted' } | ForEach-Object { $_.metadata.name }); ${countGuard}\"selected=$($names.Count)\"; $names | ForEach-Object { kubectl --context $ctx --request-timeout=30s -n $ns delete pod $_ --wait=false }`;
}

export { MARKETPLACE_NAMESPACE, MARKETPLACE_SELECTOR };
