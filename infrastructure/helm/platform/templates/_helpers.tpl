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

{{- define "chase-sets-platform.canaryServiceName" -}}
{{- $component := index .root.Values.components .name -}}
{{- $suffix := default "canary" $component.rollout.canary.canaryServiceSuffix -}}
{{- printf "%s-%s" (include "chase-sets-platform.componentName" .) $suffix | trunc 63 | trimSuffix "-" -}}
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
    {{- if and $component.port $component.healthPath }}
    readinessProbe:
      httpGet:
        path: {{ $component.healthPath | quote }}
        port: http
    {{- if $component.startupPath }}
    startupProbe:
      httpGet:
        path: {{ $component.startupPath | quote }}
        port: http
      periodSeconds: 10
      failureThreshold: 30
    livenessProbe:
      httpGet:
        path: {{ $component.startupPath | quote }}
        port: http
    {{- else }}
    livenessProbe:
      httpGet:
        path: {{ $component.healthPath | quote }}
        port: http
    {{- end }}
    {{- end }}
    {{- with $component.resources }}
    resources:
{{ toYaml . | nindent 6 }}
    {{- end }}
{{- end -}}
