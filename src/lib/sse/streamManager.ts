export class StreamManager {
  private activeStreams: Map<string, AbortController> = new Map();

  registerStream(streamId: string, controller: AbortController) {
    this.activeStreams.set(streamId, controller);
  }

  abortStream(streamId: string) {
    const controller = this.activeStreams.get(streamId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(streamId);
      console.log(`[StreamManager] Aborted stream ${streamId} due to client disconnect.`);
    }
  }

  deregisterStream(streamId: string) {
    this.activeStreams.delete(streamId);
  }
}

export const globalStreamManager = new StreamManager();
