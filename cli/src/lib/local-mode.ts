/**
 * Why the hosted AI pass must not run for this invocation, or `null` when it may.
 *
 * `--local`, `--ollama`, and `--vllm` promise that no code leaves the machine (#892).
 * The CLI has no AI model of its own: its AI pass is `requestAiFileScan`, which uploads
 * staged file contents to the hosted SecureFlow API. Setting `LOCAL_AI_URL` in the CLI
 * process does not change where that upload goes, so under `--local`, `--ollama`, or `--vllm`
 * the only way to keep the promise is not to upload. The local pattern scan still runs.
 */
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
