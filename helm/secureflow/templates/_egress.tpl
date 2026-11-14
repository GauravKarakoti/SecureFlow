{{/* Parse a canonical IPv4 CIDR without network access. Helm schema also checks shape. */}}
{{- define "secureflow.ipv4Range" -}}
{{- $cidr := . -}}
{{- if not (regexMatch `^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$` $cidr) -}}
  {{- fail (printf "worker egress requires an IPv4 CIDR: %s" $cidr) -}}
{{- end -}}
{{- $parts := splitList "/" $cidr -}}
{{- $prefix := int (index $parts 1) -}}
{{- if or (lt $prefix 0) (gt $prefix 32) -}}{{- fail "worker egress CIDR prefix must be 0..32" -}}{{- end -}}
{{- $address := int64 0 -}}
{{- range splitList "." (index $parts 0) -}}
  {{- $octet := int . -}}
  {{- if or (gt $octet 255) (ne (toString $octet) .) -}}{{- fail "worker egress CIDR has an invalid IPv4 octet" -}}{{- end -}}
  {{- $address = add (mul $address 256) $octet -}}
{{- end -}}
{{- $size := int64 4294967296 -}}
{{- range until $prefix -}}{{- $size = div $size 2 -}}{{- end -}}
{{- if ne (mod $address $size) (int64 0) -}}{{- fail "worker egress CIDR must use its canonical network address" -}}{{- end -}}
{{- dict "start" $address "end" (sub (add $address $size) 1) | toJson -}}
{{- end -}}

{{/* Exclusions must be contained by ipBlock.cidr. Add only overlapping subnets;
     reject allowlist entries wholly inside reserved/private/metadata space. */}}
{{- define "secureflow.publicEgressBlock" -}}
{{- $cidr := . -}}
{{- $allowed := include "secureflow.ipv4Range" $cidr | fromJson -}}
{{- $excluded := list -}}
{{- range list "0.0.0.0/8" "10.0.0.0/8" "100.64.0.0/10" "127.0.0.0/8" "168.63.129.16/32" "169.254.0.0/16" "172.16.0.0/12" "192.0.0.0/24" "192.0.2.0/24" "192.168.0.0/16" "198.18.0.0/15" "198.51.100.0/24" "203.0.113.0/24" "224.0.0.0/4" "240.0.0.0/4" -}}
  {{- $blocked := include "secureflow.ipv4Range" . | fromJson -}}
  {{- if and (ge $allowed.start $blocked.start) (le $allowed.end $blocked.end) -}}
    {{- fail (printf "worker external egress CIDR %s is inside reserved/private range %s" $cidr .) -}}
  {{- end -}}
  {{- if and (le $allowed.start $blocked.start) (ge $allowed.end $blocked.end) -}}
    {{- $excluded = append $excluded . -}}
  {{- end -}}
{{- end -}}
cidr: {{ $cidr | quote }}
{{- with $excluded }}
except:
  {{- toYaml . | nindent 2 }}
{{- end -}}
{{- end -}}
