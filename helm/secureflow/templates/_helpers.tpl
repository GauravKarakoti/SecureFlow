{{/*
Expand the name of the chart.
*/}}
{{- define "secureflow.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "secureflow.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "secureflow.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "secureflow.labels" -}}
helm.sh/chart: {{ include "secureflow.chart" . }}
{{ include "secureflow.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for the main app
*/}}
{{- define "secureflow.selectorLabels" -}}
app.kubernetes.io/name: {{ include "secureflow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: app
{{- end }}

{{/*
Selector labels for worker
*/}}
{{- define "secureflow.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "secureflow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "secureflow.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "secureflow.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the secret name
*/}}
{{- define "secureflow.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "secureflow.fullname" . }}-secrets
{{- end }}
{{- end }}

{{/*
Return the config map name
*/}}
{{- define "secureflow.configMapName" -}}
{{- include "secureflow.fullname" . }}-config
{{- end }}

{{/*
Database hostname helper
*/}}
{{- define "secureflow.databaseHost" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "secureflow.fullname" .) }}
{{- else }}
{{- .Values.postgresql.external.host }}
{{- end }}
{{- end }}

{{/*
Database URL connection string helper
*/}}
{{- define "secureflow.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgresql://%s:%s@%s:5432/%s?sslmode=disable" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "secureflow.databaseHost" .) .Values.postgresql.auth.database }}
{{- else if .Values.postgresql.external.url }}
{{- .Values.postgresql.external.url }}
{{- else }}
{{- printf "postgresql://%s:%s@%s:%v/%s?sslmode=%s" .Values.postgresql.external.username .Values.postgresql.external.password .Values.postgresql.external.host (default 5432 .Values.postgresql.external.port) .Values.postgresql.external.database (default "prefer" .Values.postgresql.external.sslmode) }}
{{- end }}
{{- end }}

{{/*
Redis URL connection string helper
*/}}
{{- define "secureflow.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- if .Values.redis.auth.enabled }}
{{- printf "redis://:%s@%s-redis:6379/0" .Values.redis.auth.password (include "secureflow.fullname" .) }}
{{- else }}
{{- printf "redis://%s-redis:6379/0" (include "secureflow.fullname" .) }}
{{- end }}
{{- else }}
{{- .Values.redis.external.url }}
{{- end }}
{{- end }}

{{/*
Resolve Application Image
*/}}
{{- define "secureflow.appImage" -}}
{{- $registry := default .Values.global.imageRegistry "" -}}
{{- $repository := .Values.app.image.repository -}}
{{- $tag := default .Chart.AppVersion .Values.app.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end }}

{{/*
Resolve Worker Image
*/}}
{{- define "secureflow.workerImage" -}}
{{- $registry := default .Values.global.imageRegistry "" -}}
{{- $repository := default .Values.app.image.repository .Values.worker.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.app.image.tag) .Values.worker.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end }}
