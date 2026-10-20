{{- define "dingorg.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dingorg.labels" -}}
app.kubernetes.io/name: {{ include "dingorg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Deployment 与 Service 的 selector 靠它们，所以 Pod 上不让 podLabels 覆盖。入参：dict "root" "component" */}}
{{- define "dingorg.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dingorg.name" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* image.tag 留空即 appVersion：release 时它与镜像 tag 是同一个版本号 */}}
{{- define "dingorg.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/*
容器的 env。入参：dict "root" "cfg"（组件的 values）。凭证键只注入 cfg.secretKeys 里列的：
别换回 envFrom，会把钉钉 AppSecret 与 AUTH_JSON（全部 client secret 与 API key）注入用不到它们的 Pod。
*/}}
{{- define "dingorg.env" -}}
{{- $root := .root -}}
{{- $credentials := list "DATABASE_URL" "DINGTALK_APP_KEY" "DINGTALK_APP_SECRET" "AUTH_JSON" -}}
{{- $keys := .cfg.secretKeys | default (list) -}}
{{- $env := mergeOverwrite (deepCopy ($root.Values.env | default dict)) (.cfg.env | default dict) -}}
{{- range $keys }}
{{- $v := get $env . }}
{{- if not $v }}
{{- $v = dict "valueFrom" (dict "secretKeyRef" (dict "name" (required (printf "%s：env 里没给就要设 secretName" .) $root.Values.secretName) "key" .)) }}
{{- end }}
{{- include "dingorg.envVar" (list . $v) }}
{{- end }}
{{- range $k, $v := $env }}
{{- if and $v (not (has $k $credentials)) (not (has $k $keys)) }}
{{- include "dingorg.envVar" (list $k $v) }}
{{- end }}
{{- end }}
{{- end -}}

{{/* 入参：list <名字> <值>。值是对象就原样透传（valueFrom 等），否则当 value */}}
{{- define "dingorg.envVar" -}}
{{- $v := index . 1 }}
- name: {{ index . 0 }}
{{- if kindIs "map" $v }}
  {{- toYaml $v | nindent 2 }}
{{- else }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/*
Pod 的 metadata。入参：dict "root" "cfg" "component"。
⚠️ env 在容器启动时注入，Secret 变了 pod template 不变就不 rollout：migrate 用上了新值，常驻进程
还是旧的。bump secretVersion 改变 template 触发滚动。用不了 checksum/secret（chart 不自建
Secret），lookup 在 helm template 时拿不到值。
*/}}
{{- define "dingorg.podMetadata" -}}
{{- $labels := merge (include "dingorg.selectorLabels" . | fromYaml) (.cfg.podLabels | default .root.Values.podLabels | default dict) }}
{{- $annotations := .cfg.podAnnotations | default .root.Values.podAnnotations | default dict }}
{{- with .root.Values.secretVersion }}
{{- $annotations = merge (dict "dingorg.io/secret-version" (toString .)) $annotations }}
{{- end -}}
labels:
  {{- toYaml $labels | nindent 2 }}
{{- with $annotations }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Pod spec 的调度与安全项。入参：dict "root" "cfg" */}}
{{- define "dingorg.podSpec" -}}
{{- $v := .root.Values -}}
{{- with $v.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .cfg.podSecurityContext | default $v.podSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .cfg.nodeSelector | default $v.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .cfg.tolerations | default $v.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .cfg.affinity | default $v.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* 容器的镜像、安全上下文与资源。入参：dict "root" "cfg" */}}
{{- define "dingorg.containerBase" -}}
image: {{ include "dingorg.image" .root | quote }}
imagePullPolicy: {{ .root.Values.image.pullPolicy }}
{{- with .cfg.securityContext | default .root.Values.securityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .cfg.resources | default .root.Values.resources }}
resources:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
一次性任务（migrate、cron、部署 hook）的 Pod template。入参：dict "root" "cfg" "component"
"name"（容器名）"entry"（dist 下的入口文件）。
*/}}
{{- define "dingorg.taskPodTemplate" -}}
metadata:
  {{- include "dingorg.podMetadata" . | nindent 2 }}
spec:
  restartPolicy: Never
  {{- with include "dingorg.podSpec" . }}
  {{- . | nindent 2 }}
  {{- end }}
  containers:
    - name: {{ .name }}
      {{- include "dingorg.containerBase" . | nindent 6 }}
      command: ['node', '{{ .entry }}']
      env:
        {{- include "dingorg.env" . | nindent 8 }}
{{- end -}}

{{/*
CronJob 与部署 hook 共用的 Job spec。入参：dict "root" "name"（dist/bin/cron 下的入口）
"cfg"（cronjobs.<name>）"component"。
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
  {{- include "dingorg.taskPodTemplate" (merge (dict "entry" (printf "dist/bin/cron/%s.js" .name)) .) | nindent 2 }}
{{- end -}}
