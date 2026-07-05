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

{{- define "chase-sets-platform.image" -}}
{{- $image := .Values.global.image -}}
{{- $repository := printf "%s/%s/%s" $image.registry $image.registryName $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $image.tag -}}
{{- end -}}
{{- end -}}

{{- define "chase-sets-platform.componentName" -}}
{{- printf "%s-%s" (include "chase-sets-platform.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
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
{{- range .component.env }}
- name: {{ .name | quote }}
  {{- if .secret }}
  valueFrom:
    secretKeyRef:
      name: {{ default $root.Values.global.existingSecretName .secretName | quote }}
      key: {{ default .name .secretKey | quote }}
  {{- else }}
  value: {{ default "" .value | quote }}
  {{- end }}
{{- end }}
{{- end -}}

{{- define "chase-sets-platform.podSpec" -}}
{{- $root := .root -}}
{{- $component := .component -}}
serviceAccountName: {{ include "chase-sets-platform.serviceAccountName" $root }}
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
      - {{ $component.command | quote }}
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
    livenessProbe:
      httpGet:
        path: {{ $component.healthPath | quote }}
        port: http
    {{- end }}
    {{- with $component.resources }}
    resources:
{{ toYaml . | nindent 6 }}
    {{- end }}
{{- end -}}
