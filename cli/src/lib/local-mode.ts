/**
 * Why the hosted AI pass must not run for this invocation, or `null` when it may.
 *
 * `--local`, `--ollama`, and `--vllm` promise that no code leaves the machine (#892).
 * The CLI has no AI model of its own: its AI pass is `requestAiFileScan`, which uploads
 * staged file contents to the hosted SecureFlow API. Setting `LOCAL_AI_URL` in the CLI
 * process does not change where that upload goes, so under `--local`, `--ollama`, or `--vllm`
 * the only way to keep the promise is not to upload. The local pattern scan still runs.
 */
/**
 * The URL given to a local-provider flag, either inline (`--ollama=<url>`) or as
 * the next argument (`--ollama <url>`), or `undefined` when there is none.
 *
 * The inline form is split on the *first* `=` only: a URL can carry its own
 * (`http://gateway:8080/v1?tenant=a`), and splitting on every `=` cut it off
 * there.
 */
function flagUrl(argv: readonly string[], flag: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1) || undefined;

  const next = argv[argv.indexOf(flag) + 1];
  return next && (next.startsWith("http://") || next.startsWith("https://")) ? next : undefined;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * Environment for the `--local`, `--ollama` and `--vllm` flags, or an empty
 * object when none is given. `LOCAL_AI_URL` / `LOCAL_AI_MODEL` /
 * `LOCAL_AI_PROVIDER` are read by `resolveLocalModelConfig()` in any in-process
 * AI module. The model can be overridden with `--local-model <tag>`,
 * `--ollama-model <tag>` or `--vllm-model <tag>`.
 */
export function localModeEnv(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  let provider: "ollama" | "vllm" | undefined;
  let url: string | undefined;
  let model: string | undefined;

  if (hasFlag(argv, "--ollama")) {
    provider = "ollama";
    url = flagUrl(argv, "--ollama");
    model = flagValue(argv, "--ollama-model");
  } else if (hasFlag(argv, "--vllm")) {
    provider = "vllm";
    url = flagUrl(argv, "--vllm");
    model = flagValue(argv, "--vllm-model");
  } else if (argv.includes("--local")) {
    url = flagUrl(argv, "--local");
  } else {
    return {};
  }

  model = flagValue(argv, "--local-model") ?? model;

  const defaultUrl = provider === "vllm" ? "http://localhost:8000/v1" : "http://localhost:11434/v1";
  const result: Record<string, string> = {
    LOCAL_AI_URL: url || env.LOCAL_AI_URL || defaultUrl,
  };
  if (provider) result.LOCAL_AI_PROVIDER = provider;
  if (model) result.LOCAL_AI_MODEL = model;
  return result;
}

export function hostedAiScanSkipReason(argv: readonly string[]): "no-ai" | "local" | null {
  if (argv.includes("--no-ai")) return "no-ai";
  if (
    argv.includes("--local") ||
    argv.some((a) => a === "--ollama" || a.startsWith("--ollama=")) ||
    argv.some((a) => a === "--vllm" || a.startsWith("--vllm="))
  ) {
    return "local";
  }
  return null;
}
