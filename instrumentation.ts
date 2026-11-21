export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./src/lib/env");
    const { validateAndLogAiConfigStartup } = await import("./src/ai/model-config");
    validateAndLogAiConfigStartup();

    const { initTracing } = await import("./src/lib/tracing");
    await initTracing();
  }
}
