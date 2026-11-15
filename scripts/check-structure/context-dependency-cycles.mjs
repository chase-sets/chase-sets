export function findContextDependencyCycleViolations(manifests) {
  if (!Array.isArray(manifests)) return ["context-dependency-graph: manifests must be an array"];
  const graph = new Map();
  const errors = [];
  for (const manifest of manifests) {
    if (
      !manifest ||
      typeof manifest.packageName !== "string" ||
      !manifest.packageName.trim() ||
      !Array.isArray(manifest.allowedContextDependencies) ||
      manifest.allowedContextDependencies.some((dependency) => typeof dependency !== "string" || !dependency.trim())
    ) {
      errors.push("context-dependency-graph: malformed packageName or allowedContextDependencies");
      continue;
    }
    if (graph.has(manifest.packageName))
      errors.push(`context-dependency-graph: duplicate package ${manifest.packageName}`);
    graph.set(manifest.packageName, [...new Set(manifest.allowedContextDependencies)].sort());
  }
  if (errors.length) return errors.sort();
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(vertex) {
    if (active.has(vertex)) {
      errors.push(`context-dependency-cycle: ${[...stack.slice(stack.indexOf(vertex)), vertex].join(" -> ")}`);
      return;
    }
    if (visited.has(vertex) || !graph.has(vertex)) return;
    active.add(vertex);
    stack.push(vertex);
    for (const dependency of graph.get(vertex)) visit(dependency);
    stack.pop();
    active.delete(vertex);
    visited.add(vertex);
  }
  for (const vertex of [...graph.keys()].sort()) visit(vertex);
  return errors;
}
