# Kubernetes Observability Collector

This directory documents the DOKS-side collector contract for milestone #4051. The platform Helm release is the executable source of truth: `infrastructure/helm/platform/templates/observability-*.yaml`. It installs an OpenTelemetry DaemonSet for pod OTLP and kubelet usage plus one cluster collector with a kube-state-metrics sidecar. Both attach bounded Kubernetes metadata and forward signals to the single shared Chase Sets observability stack.

Required runtime environment:

- `CHASE_SETS_DEPLOYMENT_ENVIRONMENT`: `staging` or `production`.
- `CHASE_SETS_K8S_CLUSTER_NAME`: support-safe cluster name such as `chase-sets-staging-doks`.
- `CHASE_SETS_OTLP_ENDPOINT`: the secured shared stack OTLP endpoint, for example `https://otel.staging.chasesets.com`.
- `CHASE_SETS_OTLP_TOKEN`: the shared stack write token, sourced from Kubernetes Secret data.
- `K8S_NODE_NAME`: set from `spec.nodeName` on each DaemonSet pod.

Do not add account, user, order, payment, listing, shipment, session, raw URL, cookie, provider payload, or token values as labels or resource attributes. Environment, service, namespace, deployment, pod, and node names are the allowed Kubernetes separation labels for this collector.

The cluster collector filters kube-state-metrics to node readiness, namespace state, workload replica availability, pod phase/restarts, and failed jobs, and drops UID/container/image labels before export. The DaemonSet and cluster collector both upsert `deployment.environment`, `k8s.cluster.name`, and `chase_sets.observability_stack=single-shared-stack`; pod-supplied values cannot bypass environment separation.
