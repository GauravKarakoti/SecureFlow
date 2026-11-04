#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../helm/secureflow" && pwd)"
helm_bin="${HELM_BIN:-helm}"

for monitor in false true; do
  "$helm_bin" lint "$chart_dir" \
    --set secrets.authSecret=local-test-only \
    --set serviceMonitor.enabled="$monitor"
  "$helm_bin" template check "$chart_dir" \
    --set secrets.authSecret=local-test-only \
    --set serviceMonitor.enabled="$monitor" > /dev/null
done

# One Service for the app, which also carries the ServiceMonitor wiring (#1143, #1467).
app_service="$("$helm_bin" template check "$chart_dir" \
  --show-only templates/app-service.yaml \
  --set secrets.authSecret=local-test-only \
  --set app.service.port=9010 \
  --set service.portName=metrics)"
service_monitor="$("$helm_bin" template check "$chart_dir" \
  --show-only templates/servicemonitor.yaml \
  --set secrets.authSecret=local-test-only \
  --set serviceMonitor.enabled=true \
  --set service.portName=metrics)"

grep -Fq 'targetPort: http' <<< "$app_service"
grep -Fq 'port: 9010' <<< "$app_service"
grep -Fq 'name: metrics' <<< "$app_service"
grep -Fq 'port: metrics' <<< "$service_monitor"
grep -Fq 'secureflow-metrics: "true"' <<< "$app_service"
grep -Fq 'secureflow-metrics: "true"' <<< "$service_monitor"

# Regression (#1467): the redundant metrics Service template must stay removed,
# and exactly one rendered Service may carry the metrics label.
if [ -e "$chart_dir/templates/service.yaml" ]; then
  echo 'templates/service.yaml duplicates app-service.yaml and must not exist' >&2
  exit 1
fi
default_render="$("$helm_bin" template check "$chart_dir" \
  --set secrets.authSecret=local-test-only)"
if [ "$(grep -c 'secureflow-metrics: "true"' <<< "$default_render")" -ne 1 ]; then
  echo 'Exactly one Service must carry the secureflow-metrics label' >&2
  exit 1
fi

for np_enabled in false true; do
  "$helm_bin" lint "$chart_dir" \
    --set secrets.authSecret=local-test-only \
    --set networkPolicy.enabled="$np_enabled"
  "$helm_bin" template check "$chart_dir" \
    --set secrets.authSecret=local-test-only \
    --set networkPolicy.enabled="$np_enabled" > /dev/null
done

network_policies="$("$helm_bin" template check "$chart_dir" \
  --show-only templates/networkpolicy.yaml \
  --set secrets.authSecret=local-test-only \
  --set networkPolicy.enabled=true)"

grep -Fq 'name: check-secureflow-postgresql' <<< "$network_policies"
grep -Fq 'name: check-secureflow-redis' <<< "$network_policies"
grep -Fq 'port: 5432' <<< "$network_policies"
grep -Fq 'port: 6379' <<< "$network_policies"
grep -Fq 'app.kubernetes.io/component: postgresql' <<< "$network_policies"
grep -Fq 'app.kubernetes.io/component: redis' <<< "$network_policies"
grep -Fq 'values:' <<< "$network_policies"
grep -Fq -- '- app' <<< "$network_policies"
grep -Fq -- '- worker' <<< "$network_policies"
grep -Fq -- '- migration' <<< "$network_policies"
grep -Fq -- '- retention' <<< "$network_policies"

# ---------------------------------------------------------------------------
# Resource requests/limits (#1186)
#
# Every workload container must render non-empty cpu and memory requests AND
# limits, otherwise a large concurrent repository scan can exhaust the node.
# ---------------------------------------------------------------------------
rendered="$("$helm_bin" template check "$chart_dir" \
  --set secrets.authSecret=local-test-only)"

# Walk every container resources: block in the rendered manifests. PVC
# volumeClaimTemplates also have a resources: block (storage only); those are
# skipped. Prints one error per container block that is missing a field.
resource_errors="$(awk '
  function indent(s) { match(s, /[^ ]/); return RSTART - 1 }
  function finish(   ok) {
    if (!inblock) return
    inblock = 0
    if (storage) return
    checked++
    if (!(lim_cpu && lim_mem && req_cpu && req_mem)) {
      printf "container resources block at rendered line %d is missing cpu/memory requests or limits\n", start
    }
  }
  /^---/ { finish() }
  {
    if (inblock) {
      if ($0 ~ /^[[:space:]]*$/ || indent($0) > base) {
        if ($0 ~ /^[[:space:]]*limits:/)   section = "lim"
        if ($0 ~ /^[[:space:]]*requests:/) section = "req"
        if ($0 ~ /^[[:space:]]*storage:/)  storage = 1
        if (section == "lim" && $0 ~ /^[[:space:]]*cpu: *[^ ]/)    lim_cpu = 1
        if (section == "lim" && $0 ~ /^[[:space:]]*memory: *[^ ]/) lim_mem = 1
        if (section == "req" && $0 ~ /^[[:space:]]*cpu: *[^ ]/)    req_cpu = 1
        if (section == "req" && $0 ~ /^[[:space:]]*memory: *[^ ]/) req_mem = 1
        next
      }
      finish()
    }
    if ($0 ~ /^[[:space:]]*resources:[[:space:]]*$/) {
      inblock = 1; base = indent($0); start = NR; section = ""; storage = 0
      lim_cpu = lim_mem = req_cpu = req_mem = 0
    }
  }
  END { finish(); if (checked < 6) printf "expected at least 6 container resource blocks (app, worker, migration, retention, postgresql, redis), found %d\n", checked }
' <<< "$rendered")"

if [ -n "$resource_errors" ]; then
  echo "$resource_errors" >&2
  exit 1
fi

# app and worker also bound ephemeral-storage (requests and limits).
for tpl in app-deployment worker-deployment; do
  manifest="$("$helm_bin" template check "$chart_dir" \
    --show-only "templates/$tpl.yaml" \
    --set secrets.authSecret=local-test-only)"
  if [ "$(grep -c 'ephemeral-storage:' <<< "$manifest")" -ne 2 ]; then
    echo "$tpl must set ephemeral-storage in both requests and limits" >&2
    exit 1
  fi
done

# The ephemeral-storage defaults must survive a partial resources override.
partial="$("$helm_bin" template check "$chart_dir" \
  --show-only templates/worker-deployment.yaml \
  --set secrets.authSecret=local-test-only \
  --set worker.resources.limits.cpu=3)"
grep -Fq 'ephemeral-storage:' <<< "$partial"

# values.schema.json must reject missing or malformed resource blocks.
expect_schema_rejection() {
  if "$helm_bin" template check "$chart_dir" \
      --set secrets.authSecret=local-test-only "$@" > /dev/null 2>&1; then
    echo "values.schema.json accepted invalid resources: $*" >&2
    exit 1
  fi
}
for workload in app worker migration retention postgresql redis; do
  expect_schema_rejection --set "$workload.resources.limits.memory=null"
  expect_schema_rejection --set "$workload.resources.requests.cpu=null"
  expect_schema_rejection --set "$workload.resources.limits=null"
  expect_schema_rejection --set "$workload.resources.requests=null"
  expect_schema_rejection --set "$workload.resources.limits.cpu=lots"
done

# Secret provider modes (#1552). Use complete controller fixtures so failures
# cannot be mistaken for their missing-payload validation.
external_args=(--set externalSecrets.enabled=true
  --set externalSecrets.secretStoreRef.name=local-test-store
  --set 'externalSecrets.data[0].secretKey=AUTH_SECRET'
  --set 'externalSecrets.data[0].remoteRef.key=local-test-key')
sealed_args=(--set sealedSecrets.enabled=true
  --set-string sealedSecrets.encryptedData.AUTH_SECRET=synthetic-encrypted-fixture)

grep -Fq '# Source: secureflow/templates/secret.yaml' <<< "$rendered"
for provider in existing external sealed; do
  case "$provider" in
    existing) args=(--set secrets.existingSecret=precreated-secret) ;;
    external) args=("${external_args[@]}") ;;
    sealed) args=("${sealed_args[@]}") ;;
  esac
  # No authSecret: controller/existing modes must not need plaintext values.
  manifest="$("$helm_bin" template check "$chart_dir" "${args[@]}")"
  if grep -Fq '# Source: secureflow/templates/secret.yaml' <<< "$manifest"; then
    echo "$provider mode rendered a raw Secret" >&2
    exit 1
  fi
  case "$provider" in
    external) grep -Fxq 'kind: ExternalSecret' <<< "$manifest" ;;
    sealed) grep -Fxq 'kind: SealedSecret' <<< "$manifest" ;;
    existing) grep -Fq 'name: precreated-secret' <<< "$manifest" ;;
  esac
done

expect_provider_rejection() {
  local output
  if output="$("$helm_bin" template check "$chart_dir" "$@" 2>&1)"; then
    echo "accepted conflicting secret providers: $*" >&2
    exit 1
  fi
  # Distinguish the schema guard and template guard from unrelated failures.
  if [[ " $* " == *' --skip-schema-validation '* ]]; then
    grep -Fq 'Secret providers are mutually exclusive' <<< "$output"
  else
    grep -Eq "Must not validate the schema \(not\)|'not' failed" <<< "$output"
  fi
}
for validation in schema template; do
  skip=()
  if [ "$validation" = template ]; then skip=(--skip-schema-validation); fi
  expect_provider_rejection "${skip[@]}" "${external_args[@]}" "${sealed_args[@]}"
  expect_provider_rejection "${skip[@]}" --set secrets.existingSecret=precreated-secret "${external_args[@]}"
  expect_provider_rejection "${skip[@]}" --set secrets.existingSecret=precreated-secret "${sealed_args[@]}"
  expect_provider_rejection "${skip[@]}" --set secrets.existingSecret=precreated-secret "${external_args[@]}" "${sealed_args[@]}"
done
