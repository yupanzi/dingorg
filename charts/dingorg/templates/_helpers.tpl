{{- define "dingorg.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dingorg.labels" -}}
app.kubernetes.io/name: {{ include "dingorg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* 常驻进程的非敏感 env。空值不渲染，由进程侧默认值或下面的派生值接管 */}}
{{- define "dingorg.env" -}}
{{- range $k, $v := .Values.env }}
{{- if $v }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end }}
{{/* 从 ingress.host 派生：再填一遍只会制造配错机会 */}}
{{- if and .Values.ingress.host (not .Values.env.PUBLIC_ORIGIN) }}
- name: PUBLIC_ORIGIN
  value: {{ printf "%s://%s" (ternary "https" "http" .Values.ingress.tls) .Values.ingress.host | quote }}
{{- end }}
{{- end -}}

{{/*
一次性任务只注入点名的 Secret 键。入参：dict "root" <根上下文> "keys" <键名列表>。
别换回 envFrom：会把钉钉 AppSecret 与 AUTH_JSON（全部 client secret 与 API key）注入用不到它们的 Pod。
*/}}
{{- define "dingorg.secretEnv" -}}
{{- range .keys }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $.root.Values.secretName }}
      key: {{ . }}
{{- end }}
{{- end -}}

{{/*
CronJob 与部署 hook 共用的 Job spec。入参：dict "root" "name"（dist/bin/cron 下的入口）
"cfg"（backoffLimit、secretKeys）"component"。
podFailurePolicy：节点驱逐、抢占等中断不计入 backoffLimit，照样起新 Pod（k8s ≥ 1.26）。
*/}}
{{- define "dingorg.taskJobSpec" -}}
backoffLimit: {{ required (printf "cronjobs.%s.backoffLimit 必须显式给" .name) .cfg.backoffLimit }}
podFailurePolicy:
  rules:
    - action: Ignore
      onPodConditions:
        - type: DisruptionTarget
ttlSecondsAfterFinished: 86400
template:
  metadata:
    labels:
      app.kubernetes.io/name: {{ include "dingorg.name" .root }}
      app.kubernetes.io/component: {{ .component }}
  spec:
    restartPolicy: Never
    containers:
      - name: {{ .name }}
        image: "{{ .root.Values.image.repository }}:{{ .root.Values.image.tag }}"
        imagePullPolicy: {{ .root.Values.image.pullPolicy }}
        command: ['node', 'dist/bin/cron/{{ .name }}.js']
        env:
          {{- include "dingorg.secretEnv" (dict "root" .root "keys" .cfg.secretKeys) | nindent 10 }}
          {{- include "dingorg.logLevelEnv" .root | nindent 10 }}
        resources:
          requests: { cpu: 50m, memory: 128Mi }
          limits: { memory: 512Mi }
{{- end -}}

{{/* 一次性任务不渲染 dingorg.env，LOG_LEVEL 单独补上 */}}
{{- define "dingorg.logLevelEnv" -}}
{{- with .Values.env.LOG_LEVEL }}
- name: LOG_LEVEL
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "dingorg.envFrom" -}}
- secretRef:
    name: {{ .Values.secretName }}
{{- end -}}

{{/*
⚠️ envFrom 在容器启动时注入，Secret 变了 pod template 不变就不 rollout：migrate 用上了
新值，常驻进程还是旧的。bump secretVersion 改变 template 触发滚动。用不了 checksum/secret
（chart 不自建 Secret），lookup 在 helm template 时拿不到值。
*/}}
{{- define "dingorg.podAnnotations" -}}
{{- if .Values.secretVersion }}
dingorg.io/secret-version: {{ .Values.secretVersion | quote }}
{{- end }}
{{- end -}}
