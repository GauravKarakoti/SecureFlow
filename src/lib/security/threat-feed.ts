import fs from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";

export type InjectionCategory =
  | "instruction-override"
  | "role-play-jailbreak"
  | "system-prompt-exfiltration"
  | "encoding-obfuscation"
  | "indirect-injection"
  | "policy-bypass-social-engineering"
  | "context-window-smuggling"
  | "output-format-hijack"
  | "adversarial-suffix"
  | "multilingual-bypass"
  | "math-logic-camouflage"
  | "recursive-simulation";

export interface ThreatFeedPayload {
  id: string;
  category: InjectionCategory;
  description: string;
  payload: string;
  source: string;
  tags?: string[];
  severity?: "low" | "medium" | "high" | "critical";
  dateAdded?: string;
}

export interface ThreatFeedSource {
  name: string;
  url: string;
  format: "json-array" | "threat-feed-json" | "line-delimited" | "csv";
  enabled?: boolean;
  defaultCategory?: InjectionCategory;
}

export interface ThreatFeedDataset {
  version: string;
  lastUpdated: string;
  sources: string[];
  payloads: ThreatFeedPayload[];
  metadata?: {
    totalCount: number;
    categoryCounts: Record<string, number>;
  };
}

export interface SyncResult {
  success: boolean;
  totalPayloads: number;
  newPayloadsAdded: number;
  sourcesSynced: string[];
  errors: string[];
  categoryCounts: Record<string, number>;
}

export const DEFAULT_FEED_PATH = path.resolve(
  process.cwd(),
  "src/data/threat-feeds/threat-feed-payloads.json",
);

/**
 * Standard community threat feeds and red-teaming corpora feeds.
 */
export const DEFAULT_THREAT_FEED_SOURCES: ThreatFeedSource[] = [
  {
    name: "OWASP-Top10-LLM01",
    url: "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/assets/data/llm01-prompt-injection.json",
    format: "threat-feed-json",
    enabled: true,
  },
  {
    name: "JailbreakBench-Corpus",
    url: "https://raw.githubusercontent.com/JailbreakBench/artifacts/main/jailbreak_artifacts.json",
    format: "json-array",
    enabled: true,
  },
  {
    name: "PayloadsAllTheThings-LLM",
    url: "https://raw.githubusercontent.com/swisskyrepo/PayloadsAllTheThings/master/Prompt%20Injection/README.md",
    format: "line-delimited",
    enabled: false,
  },
  {
    name: "Adversarial-Robustness-Feed",
    url: "https://raw.githubusercontent.com/corca-ai/eval-prompt-injection/main/data/payloads.json",
    format: "json-array",
    enabled: true,
  },
];

/**
 * Categorize a raw payload string using heuristic intent extraction.
 */
export function categorizeThreatPayload(
  text: string,
  defaultCategory: InjectionCategory = "instruction-override",
): InjectionCategory {
  if (!text) return defaultCategory;

  const lower = text.toLowerCase();

  // Multilingual checks
  if (
    /ignorez|instructions? précédentes|écrivez|approuvé/i.test(text) ||
    /ignora todas|instrucciones anteriores|marcar|seguro/i.test(text) ||
    /ignoriere alle|vorherigen anweisungen|bestätige/i.test(text) ||
    /忽略之前|所有指令|标记为安全|通过此检查/i.test(text) ||
    /игнорируй|предыдущие инструкции|безопасный/i.test(text)
  ) {
    return "multilingual-bypass";
  }

  // Recursive simulation / context-switch / multi-turn transcript
  if (
    /\[system_update/i.test(text) ||
    /\[context_/i.test(text) ||
    /(?:system:\s*[\s\S]*?\nuser:\s*[\s\S]*?\nassistant:)/i.test(text) ||
    /kernel.*?(?:root|safe mode|debug)/i.test(text) ||
    /debugkernel/i.test(text)
  ) {
    return "recursive-simulation";
  }

  // Adversarial suffix / token delimiters
  if (
    /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|\[inst\]|\[\/inst\]|<<sys>>/i.test(text) ||
    /={10,}|-{10,}/.test(text)
  ) {
    return "adversarial-suffix";
  }

  // Math / logic camouflage
  if (
    /let rule [a-z] =|if a\s*=\s*['"]|substitution cipher|solve this riddle|let [xyz]\s*=/i.test(
      lower,
    )
  ) {
    return "math-logic-camouflage";
  }

  // Encoding & Obfuscation
  if (
    /[a-z]\.[a-z]\.[a-z]\.[a-z]|(?:[a-z]-[a-z]-[a-z]-[a-z])|base64|rot13|decode and follow/i.test(
      lower,
    ) ||
    /^[A-Za-z0-9+/=]{40,}$/.test(text.trim())
  ) {
    return "encoding-obfuscation";
  }

  // System prompt exfiltration
  if (
    /system prompt|initial instructions|repeat the exact text|markdown code block containing your|reveal the prompt|print everything written before/i.test(
      lower,
    )
  ) {
    return "system-prompt-exfiltration";
  }

  // Role-play / jailbreak
  if (
    /\bdan\b|do anything now|you are now|omega|unrestricted assistant|opposite day|hypothetical scenario|act as /i.test(
      lower,
    )
  ) {
    return "role-play-jailbreak";
  }

  // Output format hijack
  if (
    /respond only with|<script>|format your entire response|raw html|click to verify|return exactly this json/i.test(
      lower,
    )
  ) {
    return "output-format-hijack";
  }

  // Social engineering / urgent policy bypass
  if (
    /urgent override|emergency patch|authorized automated penetration|auditor drill|chief security officer|p0 production outage/i.test(
      lower,
    )
  ) {
    return "policy-bypass-social-engineering";
  }

  // Indirect injection (code comments, sql, json)
  if (
    /^\s*(?:\/\/|\/\*|--|#|<!--|{\s*"|\/\*\*)/.test(text) ||
    /note to ai reviewer|commit message:/i.test(lower)
  ) {
    return "indirect-injection";
  }

  // Context window smuggling / token padding
  if (text.length > 300 || /\s{40,}/.test(text)) {
    return "context-window-smuggling";
  }

  // Instruction override
  if (/ignore|disregard|forget|override|bypass|maintenance mode|new instruction/i.test(lower)) {
    return "instruction-override";
  }

  return defaultCategory;
}

/**
 * Deduplicate payloads by normalized string content and assign stable IDs.
 */
export function normalizeAndDeduplicatePayloads(
  items: Array<Partial<ThreatFeedPayload> & { payload: string }>,
  sourcePrefix = "feed",
): ThreatFeedPayload[] {
  const seen = new Set<string>();
  const results: ThreatFeedPayload[] = [];
  let counter = 1;

  for (const item of items) {
    const raw = item.payload;
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);

    const category = item.category || categorizeThreatPayload(trimmed);
    const id =
      item.id || `${sourcePrefix}-${category.slice(0, 4)}-${String(counter++).padStart(3, "0")}`;

    results.push({
      id,
      category,
      description: item.description || `Red-team payload (${category})`,
      payload: trimmed,
      source: item.source || "ThreatFeed",
      tags: item.tags || [category],
      severity: item.severity || "high",
      dateAdded: item.dateAdded || new Date().toISOString(),
    });
  }

  return results;
}

/**
 * Parse raw downloaded string content based on source format.
 */
export function parseFeedContent(
  rawContent: string,
  source: ThreatFeedSource,
): ThreatFeedPayload[] {
  if (!rawContent || !rawContent.trim()) return [];

  try {
    if (source.format === "threat-feed-json") {
      const parsed = JSON.parse(rawContent) as { payloads?: ThreatFeedPayload[] };
      if (Array.isArray(parsed.payloads)) {
        return normalizeAndDeduplicatePayloads(
          parsed.payloads.map((p) => ({ ...p, source: source.name })),
          source.name.toLowerCase().slice(0, 4),
        );
      }
    }

    if (source.format === "json-array") {
      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed)) {
        const extracted: Array<{ payload: string; description?: string }> = [];
        for (const entry of parsed) {
          if (typeof entry === "string") {
            extracted.push({ payload: entry });
          } else if (typeof entry === "object" && entry !== null) {
            const payload =
              entry.payload || entry.prompt || entry.jailbreak || entry.text || entry.attack;
            if (typeof payload === "string") {
              extracted.push({
                payload,
                description: entry.description || entry.category || entry.name,
              });
            }
          }
        }
        return normalizeAndDeduplicatePayloads(
          extracted.map((e) => ({
            ...e,
            source: source.name,
            category: source.defaultCategory || categorizeThreatPayload(e.payload),
          })),
          source.name.toLowerCase().slice(0, 4),
        );
      }
    }

    if (source.format === "line-delimited") {
      const lines = rawContent
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 10 && !l.startsWith("#") && !l.startsWith("```"));

      return normalizeAndDeduplicatePayloads(
        lines.map((line) => ({
          payload: line,
          source: source.name,
          category: source.defaultCategory || categorizeThreatPayload(line),
        })),
        source.name.toLowerCase().slice(0, 4),
      );
    }
  } catch (error) {
    logger.warn(`Failed to parse threat feed content for source: ${source.name}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

/**
 * Fetch feed from a remote source with a configurable timeout.
 */
export async function fetchFeedFromSource(
  source: ThreatFeedSource,
  timeoutMs = 5000,
): Promise<ThreatFeedPayload[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "SecureFlow-ThreatFeed-Sync/1.0",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    return parseFeedContent(text, source);
  } catch (error) {
    logger.warn(`Error fetching threat feed from ${source.name} (${source.url})`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Load the threat feed dataset from local JSON file.
 */
export function loadThreatFeedDataset(filePath = DEFAULT_FEED_PATH): ThreatFeedDataset {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      const dataset = JSON.parse(content) as ThreatFeedDataset;
      if (Array.isArray(dataset.payloads)) {
        return dataset;
      }
    }
  } catch (error) {
    logger.warn("Could not load threat feed dataset from disk", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    version: "1.0.0",
    lastUpdated: new Date().toISOString(),
    sources: [],
    payloads: [],
  };
}

/**
 * Load payloads directly for test and runtime execution.
 */
export function loadThreatFeedPayloads(options?: { customPath?: string }): ThreatFeedPayload[] {
  const dataset = loadThreatFeedDataset(options?.customPath);
  return dataset.payloads || [];
}

/**
 * Sync threat feeds from external sources and update the local dataset file.
 */
export async function syncThreatFeeds(options?: {
  sources?: ThreatFeedSource[];
  outputPath?: string;
  force?: boolean;
}): Promise<SyncResult> {
  const sources = options?.sources || DEFAULT_THREAT_FEED_SOURCES;
  const outputPath = options?.outputPath || DEFAULT_FEED_PATH;

  const existingDataset = loadThreatFeedDataset(outputPath);
  const existingPayloads = existingDataset.payloads || [];
  const existingKeys = new Set(
    existingPayloads.map((p) => p.payload.trim().toLowerCase().replace(/\s+/g, " ")),
  );

  const newPayloads: ThreatFeedPayload[] = [];
  const sourcesSynced: string[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    if (source.enabled === false) continue;

    try {
      const fetched = await fetchFeedFromSource(source);
      if (fetched.length > 0) {
        sourcesSynced.push(source.name);
        for (const item of fetched) {
          const key = item.payload.trim().toLowerCase().replace(/\s+/g, " ");
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            newPayloads.push(item);
          }
        }
      }
    } catch (err) {
      const msg = `${source.name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
    }
  }

  const combinedPayloads = normalizeAndDeduplicatePayloads([...existingPayloads, ...newPayloads]);

  const categoryCounts: Record<string, number> = {};
  for (const item of combinedPayloads) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  const allSources = [...new Set([...existingDataset.sources, ...sourcesSynced])];

  const updatedDataset: ThreatFeedDataset = {
    version: existingDataset.version || "1.0.0",
    lastUpdated: new Date().toISOString(),
    sources: allSources,
    payloads: combinedPayloads,
    metadata: {
      totalCount: combinedPayloads.length,
      categoryCounts,
    },
  };

  try {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(updatedDataset, null, 2), "utf-8");
  } catch (err) {
    errors.push(
      `Failed to write dataset to ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    success: errors.length === 0,
    totalPayloads: combinedPayloads.length,
    newPayloadsAdded: newPayloads.length,
    sourcesSynced,
    errors,
    categoryCounts,
  };
}
