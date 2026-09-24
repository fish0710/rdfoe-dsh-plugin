/** In-process change bus feeding the NDJSON event routes. */

export type HubEvent =
  | { type: 'run', runId: string, sessionId?: string }
  | { type: 'node', runId: string, nodeId: string, status: string }
  | { type: 'inbox', runId: string, id: string, status: string }
  | { type: 'tool', runId: string, nodeId: string, tool: string }

export class Hub {
  private readonly listeners = new Set<(event: HubEvent) => void>()

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(event: HubEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* a broken stream must not break publishers */ }
    }
  }
}
