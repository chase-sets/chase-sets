{{- define "chase-sets-platform.name" -}}
{{- default .Chart.Name .Values.global.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.fullname" -}}
{{- if .Values.global.fullnameOverride -}}
{{- .Values.global.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "chase-sets-platform.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "chase-sets-platform.serviceAccountName" -}}
{{- if .Values.global.serviceAccount.create -}}
{{- default (include "chase-sets-platform.fullname" .) .Values.global.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.global.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "chase-sets-platform.bootstrapQuiesceServiceAccountName" -}}
{{- printf "%s-bootstrap-quiesce" (include "chase-sets-platform.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.image" -}}
{{- $image := .Values.global.image -}}
{{- $repository := printf "%s/%s/%s" $image.registry $image.registryName $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $image.tag -}}
{{- end -}}
{{- end -}}

{{- define "chase-sets-platform.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "chase-sets-platform.componentName" -}}
{{- printf "%s-%s" (include "chase-sets-platform.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.previewPostgresName" -}}
{{- printf "%s-preview-postgres" (include "chase-sets-platform.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.observabilityName" -}}
{{- printf "%s-observability" (include "chase-sets-platform.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.observabilityServiceName" -}}
{{- printf "%s-collector" (include "chase-sets-platform.observabilityName" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.canaryServiceName" -}}
{{- $component := index .root.Values.components .name -}}
{{- $suffix := default "canary" $component.rollout.canary.canaryServiceSuffix -}}
{{- printf "%s-%s" (include "chase-sets-platform.componentName" .) $suffix | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.rolloutIngressName" -}}
{{- printf "%s-%s-stable" (include "chase-sets-platform.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.analysisTemplateName" -}}
{{- printf "%s-%s-readiness" (include "chase-sets-platform.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chase-sets-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chase-sets-platform.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}

{{- define "chase-sets-platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{ include "chase-sets-platform.selectorLabels" . }}
{{- end -}}

{{- /*
  Env precedence: secret > component envOverrides > global envOverrides >
  CHASE_SETS_INTERNAL_API_ORIGIN (derived from the release fullname) > base value.

  The in-cluster platform-api Service name is derived from the release fullname
  (`<release>-<chart>-platform-api`), so an origin baked into values.yaml only
  resolves for the release it was rendered against (`chase-sets-platform`, i.e.
  staging/production). Previews deploy under release `chase-sets-pr-<n>`, whose
  API Service is `chase-sets-pr-<n>-chase-sets-platform-platform-api`; the baked
  origin then points at a non-existent host and the webs get ENOTFOUND / 503 on
  actor resolution. Compute CHASE_SETS_INTERNAL_API_ORIGIN from the chart
  fullname so it always matches the actual Service for the current release, in
  every environment. An explicit envOverride still wins.
*/ -}}
{{- define "chase-sets-platform.env" -}}
{{- $root := .root -}}
{{- $envOverrides := default dict $root.Values.global.envOverrides -}}
{{- $componentEnvOverrides := default dict .component.envOverrides -}}
{{- range .component.env }}
- name: {{ .name | quote }}
  {{- if .secret }}
  valueFrom:
    secretKeyRef:
      name: {{ default $root.Values.global.existingSecretName .secretName | quote }}
      key: {{ default .name .secretKey | quote }}
  {{- else if hasKey $componentEnvOverrides .name }}
  value: {{ index $componentEnvOverrides .name | quote }}
  {{- else if hasKey $envOverrides .name }}
  value: {{ index $envOverrides .name | quote }}
  {{- else if eq .name "CHASE_SETS_INTERNAL_API_ORIGIN" }}
  value: {{ printf "http://%s:8080" (include "chase-sets-platform.componentName" (dict "root" $root "name" "platform-api")) | quote }}
  {{- else }}
  value: {{ default "" .value | quote }}
  {{- end }}
{{- end }}
{{- if and (eq .component.kind "job") .component.job.quiesce.enabled }}
- name: "CHASE_SETS_QUIESCE_DEPLOYMENTS"
  value: {{ include "chase-sets-platform.quiesceDeployments" . | quote }}
- name: "CHASE_SETS_QUIESCE_TIMEOUT_SECONDS"
  value: {{ .component.job.quiesce.timeoutSeconds | quote }}
- name: "CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS"
  value: {{ .component.job.quiesce.commandTimeoutSeconds | quote }}
- name: "CHASE_SETS_QUIESCE_POLL_INTERVAL_MS"
  value: {{ .component.job.quiesce.pollIntervalMs | quote }}
- name: "CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE"
  value: {{ .component.job.quiesce.restoreOnFailure | quote }}
- name: "CHASE_SETS_QUIESCE_IGNORE_MISSING_DEPLOYMENTS"
  value: {{ .component.job.quiesce.ignoreMissingDeployments | quote }}
{{- end }}
{{- end -}}

{{- define "chase-sets-platform.quiesceDeployments" -}}
{{- $root := .root -}}
{{- $names := list -}}
{{- range .component.job.quiesce.targetComponents -}}
{{- $names = append $names (include "chase-sets-platform.componentName" (dict "root" $root "name" .)) -}}
{{- end -}}
{{- join "," $names -}}
{{- end -}}

{{- define "chase-sets-platform.podSpec" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $isQuiesceJob := and (eq $component.kind "job") $component.job.quiesce.enabled -}}
{{- if $isQuiesceJob }}
serviceAccountName: {{ include "chase-sets-platform.bootstrapQuiesceServiceAccountName" $root }}
{{- else }}
serviceAccountName: {{ include "chase-sets-platform.serviceAccountName" $root }}
{{- end }}
{{ include "chase-sets-platform.imagePullSecrets" $root }}
{{- with $root.Values.global.nodeSelector }}
nodeSelector:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.global.affinity }}
affinity:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.global.tolerations }}
tolerations:
{{ toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: {{ .name | quote }}
    image: {{ include "chase-sets-platform.image" $root | quote }}
    imagePullPolicy: {{ $root.Values.global.image.pullPolicy | quote }}
    command:
      - "sh"
      - "-lc"
    args:
      {{- if and (eq $component.kind "job") $component.job.quiesce.enabled }}
      - {{ printf "node ./infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs -- %s" $component.command | quote }}
      {{- else }}
      - {{ $component.command | quote }}
      {{- end }}
    {{- if $component.port }}
    ports:
      - name: http
        containerPort: {{ $component.port }}
        protocol: TCP
    {{- end }}
    env:
{{ include "chase-sets-platform.env" . | nindent 6 }}
    {{- /*
      Probe wiring is intentionally decoupled and each path has exactly one
      source of truth:
        - readinessProbe always uses healthPath (DB-aware; gates traffic/rollout).
        - startupProbe exists only if startupPath is set (boot-grace window;
          purely about *whether* a startup probe exists, not which path
          liveness uses).
        - livenessProbe uses livenessPath if the component sets one
          (process-life check, e.g. /health/live), else falls back to
          healthPath unchanged for every component that has not opted in.
      Before #4765 startupPath doubled as "the liveness path", which coupled
      an unrelated boot-grace concern to liveness and left platform-api's
      liveness on the DB-aware healthPath by default with tight Kubernetes
      defaults (timeout=1s period=10s failureThreshold=3) -- proven in a live
      preview namespace to kill healthy pods (Exit Code 137) under nothing
      worse than brief DB or event-loop pressure.
    */ -}}
    {{- if and $component.port $component.healthPath }}
    readinessProbe:
      httpGet:
        path: {{ $component.healthPath | quote }}
        port: http
      {{- with $component.readinessProbe }}
{{ toYaml . | nindent 6 }}
      {{- end }}
    {{- if $component.startupPath }}
    startupProbe:
      httpGet:
        path: {{ $component.startupPath | quote }}
        port: http
      periodSeconds: 10
      failureThreshold: 30
    {{- end }}
    livenessProbe:
      httpGet:
        path: {{ default $component.healthPath $component.livenessPath | quote }}
        port: http
      {{- with $component.livenessProbe }}
{{ toYaml . | nindent 6 }}
      {{- end }}
    {{- end }}
    {{- with $component.resources }}
    resources:
{{ toYaml . | nindent 6 }}
    {{- end }}
{{- end -}}
