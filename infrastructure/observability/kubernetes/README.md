# Kubernetes Observability Collector

This directory holds the DOKS-side collector contract for milestone #4051. The collector runs inside Kubernetes, accepts OTLP from pods, collects Kubernetes node/pod/container and cluster metrics through service-account auth, attaches bounded Kubernetes metadata, and forwards all signals to the single shared Chase Sets observability stack.

Required runtime environment:

- `CHASE_SETS_DEPLOYMENT_ENVIRONMENT`: `staging` or `production`.
- `CHASE_SETS_K8S_CLUSTER_NAME`: support-safe cluster name such as `chase-sets-staging-doks`.
- `CHASE_SETS_OTLP_ENDPOINT`: the secured shared stack OTLP endpoint, for example `https://otel.staging.chasesets.com`.
- `CHASE_SETS_OTLP_TOKEN`: the shared stack write token, sourced from Kubernetes Secret data.
- `K8S_NODE_NAME`: set from `spec.nodeName` when deployed as a DaemonSet or node-aware collector.

Do not add account, user, order, payment, listing, shipment, session, raw URL, cookie, provider payload, or token values as labels or resource attributes. Environment, service, namespace, deployment, pod, and node names are the allowed Kubernetes separation labels for this collector.

Live acceptance for #4051 still requires staging and production evidence that both environments are visible in one Grafana/Prometheus/Loki/Tempo stack, alert notifications fire through the replacement path, and the old duplicate observability stack has been decommissioned.
