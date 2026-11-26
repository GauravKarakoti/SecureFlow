/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY.
 * Generated from openapi.yaml via scripts/generate-api-client.ts.
 * Run `npm run client:generate` to regenerate.
 */
export interface paths {
    "/api/sbom/scan": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        fileName: string;
                        content: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success: true;
                            result: components["schemas"]["SbomScanResult"];
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/{id}": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id?: string;
                            type?: string;
                            severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
                            fileLocation?: string;
                            lineStart?: number;
                            lineEnd?: number;
                            codeSnippet?: string;
                            explanation?: string;
                            remediation?: string;
                            promptInjectionSuspected?: boolean;
                            fingerprint?: string;
                            complianceTags?: Array<string>;
                            createdAt?: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        "patch": {
            requestBody?: {
                content: {
                    "application/json": {
                        triageStatus?: "OPEN" | "RESOLVED" | "FALSE_POSITIVE" | "IGNORED";
                        severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
                        note?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        "delete": {
            responses: {
                "204": {};
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/{id}/remediate": {
        "post": {
            parameters: {
                path: {
                    "id": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success: true;
                            patch: components["schemas"]["RemediationPatch"];
                            explanation: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/{id}/issue": {
        "get": {
            parameters: {
                path: {
                    "id": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id?: string;
                            type?: string;
                            severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
                            fileLocation?: string;
                            lineStart?: number;
                            lineEnd?: number;
                            codeSnippet?: string;
                            explanation?: string;
                            remediation?: string;
                            promptInjectionSuspected?: boolean;
                            fingerprint?: string;
                            complianceTags?: Array<string>;
                            createdAt?: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        "post": {
            parameters: {
                path: {
                    "id": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success: true;
                            explanation: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/bulk-remediate": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        findingIds: Array<string>;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success: true;
                            patch: {
                                patchDiff?: string;
                                status?: "GENERATED";
                            };
                            explanation: string;
                            count: number;
                            type: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": {
                            error?: string;
                            details?: {
                                types?: Array<string>;
                            };
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "403": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/bulk-remediate/progress": {
        "get": {
            parameters: {
                query?: {
                    "total"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings": {
        "get": {
            parameters: {
                query?: {
                    "limit"?: number;
                    "cursor"?: string;
                    "severity"?: string;
                    "type"?: string;
                    "repositoryId"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            findings?: Array<Record<string, unknown>>;
                            total?: number;
                            nextCursor?: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        "post": {
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ScanJobRequest"];
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": {
                            status?: "queued";
                            jobId?: string;
                            scanJobId?: string;
                            message?: string;
                            pollingUrl?: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/{id}/explain-stream": {
        "get": {
            parameters: {
                path: {
                    "id": string;
                };
                header?: {
                    "Accept"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/repositories/sync": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        repositoryId?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            synced?: number;
                            skipped?: number;
                            failed?: number;
                            hasInstallation?: boolean;
                            error?: string;
                            repository?: components["schemas"]["Repository"];
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "408": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/leaderboard": {
        "get": {
            parameters: {
                query?: {
                    "stream"?: boolean;
                };
                header?: {
                    "Accept"?: "text/event-stream" | "application/json";
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            contributors?: Array<components["schemas"]["LeaderboardContributor"]>;
                            timestamp?: number;
                        };
                        "text/event-stream": string;
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/admin/export": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "text/csv": string;
                    };
                };
                "401": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
                "403": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
                "404": {
                    content: {
                        "text/plain": string;
                    };
                };
                "500": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
            };
        };
    };
    "/api/admin/webhooks": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "text": string;
                    };
                };
                "401": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
                "403": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
                "404": {
                    content: {
                        "text/plain": string;
                    };
                };
                "500": {
                    content: {
                        "application/json": {
                            error?: string;
                        };
                    };
                };
            };
        };
    };
    "/api/admin/webhooks/{id}/redeliver": {
        "post": {
            parameters: {
                path: {
                    "id": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success?: boolean;
                            deliveryId?: string;
                            message?: string;
                            statusCode?: number;
                        };
                    };
                };
                "400": {};
                "403": {};
                "500": {};
            };
        };
    };
    "/api/webhooks/gitlab": {
        "post": {
            parameters: {
                header?: {
                    "X-Gitlab-Token": string;
                    "X-Gitlab-Event": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            status?: "queued" | "received" | "ignored";
                            message?: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "413": {};
                "500": {};
            };
        };
    };
    "/api/webhooks/bitbucket": {
        "post": {
            parameters: {
                header?: {
                    "X-Hub-Signature": string;
                    "X-Event-Key": string;
                    "X-Request-UUID"?: string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            status?: "queued" | "received" | "ignored";
                            message?: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "413": {};
                "500": {};
            };
        };
    };
    "/api/webhooks/github": {
        "post": {
            parameters: {
                header?: {
                    "X-GitHub-Event": "pull_request" | "installation" | "installation_repositories";
                    "X-GitHub-Delivery": string;
                    "X-Hub-Signature-256": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success?: boolean;
                            message?: string;
                            decision?: "PASS" | "REVIEW REQUIRED" | "BLOCKED";
                            findingCount?: number;
                            error?: string;
                            fallback?: boolean;
                        };
                    };
                };
                "202": {
                    content: {
                        "application/json": {
                            message?: string;
                            success?: boolean;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/findings/{id}/audio-debrief": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "audio/mpeg": string;
                    };
                };
                "401": {};
                "404": {};
                "429": {};
                "502": {};
                "503": {};
            };
        };
        "post": {
            responses: {
                "200": {
                    content: {
                        "audio/mpeg": string;
                    };
                };
            };
        };
    };
    "/api/findings/{id}/remediate/apply": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        approved: boolean;
                    };
                };
            };
            responses: {
                "200": {};
                "400": {};
                "401": {};
                "403": {};
                "404": {};
                "409": {};
                "502": {};
                "503": {};
            };
        };
    };
    "/api/findings/export": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "text/csv": string;
                    };
                };
                "401": {};
            };
        };
    };
    "/api/findings/status/{jobId}": {
        "get": {
            responses: {
                "200": {};
                "401": {};
                "404": {};
            };
        };
    };
    "/api/sbom/scan/status/{jobId}": {
        "get": {
            parameters: {
                query?: {
                    "page"?: number;
                    "pageSize"?: number;
                };
            };
            responses: {
                "200": {};
                "401": {};
                "404": {};
            };
        };
    };
    "/api/scans/compare": {
        "get": {
            responses: {
                "200": {};
                "401": {};
                "404": {};
            };
        };
    };
    "/api/cli/scan": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {};
                "400": {};
                "429": {};
            };
        };
    };
    "/api/audit": {
        "get": {
            parameters: {
                query?: {
                    "limit"?: number;
                    "cursor"?: string;
                    "action"?: string;
                    "decision"?: string;
                    "search"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            logs?: Array<Record<string, unknown>>;
                            total?: number;
                            nextCursor?: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
    };
    "/api/audit/armoriq": {
        "get": {
            parameters: {
                query?: {
                    "cursor"?: string;
                    "scanJobId"?: string;
                    "findingId"?: string;
                    "decision"?: string;
                    "framework"?: string;
                    "format"?: string;
                    "limit"?: number;
                    "offset"?: number;
                };
            };
            responses: {
                "200": {};
                "400": {};
                "401": {};
                "403": {};
                "500": {
                    content: {
                        "application/json": components["schemas"]["Error"];
                    };
                };
            };
        };
        "post": {
            responses: {
                "200": {};
                "401": {};
                "403": {};
                "404": {};
                "502": {};
                "503": {};
            };
        };
    };
    "/api/compliance/export": {
        "get": {
            parameters: {
                query?: {
                    "format"?: string;
                    "framework"?: string;
                    "repositoryId"?: string;
                    "from"?: string;
                    "to"?: string;
                    "limit"?: number;
                };
            };
            responses: {
                "200": {};
                "401": {};
            };
        };
    };
    "/api/admin/audit/verify": {
        "get": {
            parameters: {
                query?: {
                    "cursor"?: string;
                    "limit"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            status?: string;
                            valid?: boolean;
                            totalVerified?: number;
                            nextCursor?: string;
                            hasMore?: boolean;
                        };
                    };
                };
                "401": {};
                "409": {
                    content: {
                        "application/json": {
                            status?: string;
                            valid?: boolean;
                            totalVerified?: number;
                            brokenEntryId?: string;
                            firstInvalidEntryId?: string;
                            expectedHash?: string;
                            actualHash?: string;
                            reason?: string;
                        };
                    };
                };
            };
        };
    };
    "/api/admin/ai-health": {
        "get": {
            responses: {
                "200": {};
                "401": {};
                "403": {};
            };
        };
        "post": {
            responses: {
                "200": {};
                "403": {};
            };
        };
        "patch": {
            responses: {
                "200": {};
                "403": {};
            };
        };
    };
    "/api/health": {
        "get": {
            parameters: {
                query?: {
                    "stream"?: boolean;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                        "text/event-stream": string;
                    };
                };
                "503": {};
            };
        };
    };
    "/api/version": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            version: string;
                            commit: string;
                            buildDate: string;
                        };
                    };
                };
            };
        };
    };
    "/api/openapi": {
        "get": {
            responses: {
                "200": {};
                "500": {};
            };
        };
    };
    "/api/metrics/landing": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "500": {};
            };
        };
    };
    "/api/emergency-intake": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": unknown;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            success: boolean;
                            action: {
                                action: "LOCKDOWN" | "EVACUATE" | "ISOLATE" | "CREDENTIAL_REVOCATION" | "NETWORK_ISOLATION" | "POLICY_ENFORCEMENT" | "MONITOR" | "ALERT";
                                target: string;
                                confidence: number;
                                rationale?: string;
                                sourceInputs?: Array<"text" | "audio" | "image">;
                                metadata?: Record<string, unknown>;
                            };
                        };
                    };
                };
                "400": {};
                "401": {};
                "413": {};
                "415": {};
                "429": {};
                "502": {};
            };
        };
    };
    "/api/heist-transmission": {
        "get": {
            parameters: {
                query?: {
                    "project"?: string;
                    "rank"?: number;
                    "score"?: number;
                    "findingsCount"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
                "400": {};
            };
        };
    };
    "/api/og/heist": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "image/png": string;
                    };
                };
                "500": {};
            };
        };
    };
    "/api/voice-alerts/audio": {
        "get": {
            parameters: {
                query?: {
                    "repo": string;
                    "decision": string;
                    "severity": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "audio/mpeg": string;
                    };
                };
                "400": {};
                "401": {};
            };
        };
    };
    "/api/voice-alerts/stream": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
                "401": {};
                "429": {};
            };
        };
    };
    "/api/webhooks": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {};
                "401": {};
                "429": {};
            };
        };
    };
    "/api/webhooks/generic": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {};
                "401": {};
                "429": {};
            };
        };
    };
    "/api/webhooks/dlq": {
        "get": {
            parameters: {
                query?: {
                    "webhookId"?: string;
                    "status"?: "quarantined" | "replaying" | "replayed" | "purged";
                    "circuitBroken"?: boolean;
                    "limit"?: number;
                    "offset"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            total?: number;
                            entries?: Array<Record<string, unknown>>;
                        };
                    };
                };
                "403": {};
            };
        };
        "delete": {
            parameters: {
                query?: {
                    "id"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "403": {};
                "404": {};
            };
        };
    };
    "/api/webhooks/dlq/replay": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        ids?: Array<string>;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            total?: number;
                            replayed?: number;
                            succeeded?: number;
                            failed?: number;
                            circuitBroken?: number;
                        };
                    };
                };
                "403": {};
            };
        };
    };
    "/api/webhooks/dlq/{id}/replay": {
        "post": {
            parameters: {
                path: {
                    "id": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "400": {};
                "403": {};
                "404": {};
                "502": {};
            };
        };
    };
    "/api/policies/export": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "401": {};
            };
        };
    };
    "/api/policies/import/preview": {
        "post": {
            responses: {
                "200": {};
                "400": {};
                "401": {};
                "413": {};
            };
        };
    };
    "/api/policies/import": {
        "post": {
            responses: {
                "200": {};
                "400": {};
                "401": {};
                "413": {};
            };
        };
    };
    "/api/policies/test": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {};
                "401": {};
                "429": {};
            };
        };
    };
    "/api/policies/preview-impact": {
        "post": {
            requestBody?: {
                content: {
                    "application/json": {
                        templateId: string;
                        draftDescription: string;
                        draftSeverity?: string;
                        maxScans?: number;
                        maxTokens?: number;
                    };
                };
            };
            responses: {
                "200": {};
                "400": {};
                "401": {};
                "429": {};
            };
        };
    };
    "/api/policies/effectiveness": {
        "get": {
            parameters: {
                query?: {
                    "days"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "401": {};
            };
        };
    };
    "/api/policies/effectiveness/export": {
        "get": {
            parameters: {
                query?: {
                    "days"?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/csv": string;
                    };
                };
                "401": {};
            };
        };
    };
    "/api/badge/{owner}/{repo}": {
        "get": {
            responses: {
                "200": {
                    content: {
                        "image/svg+xml": string;
                    };
                };
                "429": {};
            };
        };
    };
}
export interface components {
    schemas: {
        "Error": {
            error: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "DATABASE_ERROR";
            message?: string;
            success?: false;
        };
        "SbomDependency": {
            name: string;
            version: string;
            manifestFile: string;
            ecosystem: "npm" | "pypi" | "maven" | "gem";
        };
        "VulnerabilityMatch": {
            dependency: components["schemas"]["SbomDependency"];
            cveId: string;
            severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
            description: string;
            patchedVersion?: string;
        };
        "SbomScanResult": {
            scanId: string;
            timestamp: string;
            totalDependencies: number;
            vulnerabilities: Array<components["schemas"]["VulnerabilityMatch"]>;
            status: "CLEAN" | "WARNING" | "VULNERABLE" | "ERROR";
        };
        "RemediationPatch": {
            id?: string;
            findingId: string;
            patchDiff: string;
            status: "GENERATED" | "APPLIED" | "REJECTED";
            createdAt?: string;
        };
        "Finding": {
            id?: string;
            scanResultId?: string;
            type?: "Secret" | "Vulnerability" | "Misconfig" | "CodeQuality" | "Security";
            severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
            filePath?: string;
            fileLocation?: string;
            codeSnippet?: string;
            description?: string;
            explanation?: string;
            remediation?: string;
            promptInjectionSuspected?: boolean;
            createdAt?: string;
        };
        "ScanJobRequest": {
            repositoryId: string;
            prNumber?: number;
        };
        "LeaderboardContributor": {
            id?: string;
            codename?: string;
            totalPRs?: number;
            securityScore?: number;
            rank?: number;
            tier?: "S" | "A" | "B" | "C" | "D";
        };
        "Repository": {
            id?: string;
            githubId?: string;
            fullName?: string;
            owner?: string;
            name?: string;
            isActive?: boolean;
            userId?: string;
        };
    };
}
export interface operations {
    "scanSbom": paths["/api/sbom/scan"]["post"];
    "getFinding": paths["/api/findings/{id}"]["get"];
    "patchFinding": paths["/api/findings/{id}"]["patch"];
    "deleteFinding": paths["/api/findings/{id}"]["delete"];
    "remediateFinding": paths["/api/findings/{id}/remediate"]["post"];
    "getFindingIssue": paths["/api/findings/{id}/issue"]["get"];
    "createIssueForFinding": paths["/api/findings/{id}/issue"]["post"];
    "bulkRemediateFindings": paths["/api/findings/bulk-remediate"]["post"];
    "streamBulkRemediationProgress": paths["/api/findings/bulk-remediate/progress"]["get"];
    "listFindings": paths["/api/findings"]["get"];
    "enqueueScan": paths["/api/findings"]["post"];
    "explainFindingStream": paths["/api/findings/{id}/explain-stream"]["get"];
    "syncRepositories": paths["/api/repositories/sync"]["post"];
    "getLeaderboard": paths["/api/leaderboard"]["get"];
    "exportAuditLogs": paths["/api/admin/export"]["get"];
    "getWebhookDelivery": paths["/api/admin/webhooks"]["get"];
    "redeliverWebhookDelivery": paths["/api/admin/webhooks/{id}/redeliver"]["post"];
    "ingestGitLabWebhook": paths["/api/webhooks/gitlab"]["post"];
    "ingestBitbucketWebhook": paths["/api/webhooks/bitbucket"]["post"];
    "handleGitHubWebhook": paths["/api/webhooks/github"]["post"];
    "getFindingAudioDebrief": paths["/api/findings/{id}/audio-debrief"]["get"];
    "postFindingAudioDebrief": paths["/api/findings/{id}/audio-debrief"]["post"];
    "applyFindingRemediation": paths["/api/findings/{id}/remediate/apply"]["post"];
    "exportFindingsCsv": paths["/api/findings/export"]["get"];
    "getScanJobStatus": paths["/api/findings/status/{jobId}"]["get"];
    "getSbomScanStatus": paths["/api/sbom/scan/status/{jobId}"]["get"];
    "compareScans": paths["/api/scans/compare"]["get"];
    "cliScan": paths["/api/cli/scan"]["post"];
    "listAuditLogs": paths["/api/audit"]["get"];
    "getArmorIqAudit": paths["/api/audit/armoriq"]["get"];
    "postArmorIqAudit": paths["/api/audit/armoriq"]["post"];
    "exportCompliance": paths["/api/compliance/export"]["get"];
    "verifyAuditChain": paths["/api/admin/audit/verify"]["get"];
    "getAiHealth": paths["/api/admin/ai-health"]["get"];
    "postAiHealth": paths["/api/admin/ai-health"]["post"];
    "patchAiHealth": paths["/api/admin/ai-health"]["patch"];
    "getHealth": paths["/api/health"]["get"];
    "getVersion": paths["/api/version"]["get"];
    "getOpenApiSpec": paths["/api/openapi"]["get"];
    "getLandingMetrics": paths["/api/metrics/landing"]["get"];
    "postEmergencyIntake": paths["/api/emergency-intake"]["post"];
    "streamHeistTransmission": paths["/api/heist-transmission"]["get"];
    "getHeistOgImage": paths["/api/og/heist"]["get"];
    "getVoiceAlertAudio": paths["/api/voice-alerts/audio"]["get"];
    "streamVoiceAlerts": paths["/api/voice-alerts/stream"]["get"];
    "receiveGenericWebhook": paths["/api/webhooks"]["post"];
    "receiveGenericWebhookAlt": paths["/api/webhooks/generic"]["post"];
    "listWebhookDlqEntries": paths["/api/webhooks/dlq"]["get"];
    "purgeWebhookDlqEntries": paths["/api/webhooks/dlq"]["delete"];
    "batchReplayWebhookDlq": paths["/api/webhooks/dlq/replay"]["post"];
    "replayWebhookDlqEntry": paths["/api/webhooks/dlq/{id}/replay"]["post"];
    "exportPolicies": paths["/api/policies/export"]["get"];
    "previewPolicyImport": paths["/api/policies/import/preview"]["post"];
    "importPolicies": paths["/api/policies/import"]["post"];
    "testPolicy": paths["/api/policies/test"]["post"];
    "previewPolicyImpact": paths["/api/policies/preview-impact"]["post"];
    "getPolicyEffectiveness": paths["/api/policies/effectiveness"]["get"];
    "exportPolicyEffectivenessCSV": paths["/api/policies/effectiveness/export"]["get"];
    "getStatusBadge": paths["/api/badge/{owner}/{repo}"]["get"];
}
//# sourceMappingURL=schema.d.ts.map