/** Browser-side client for `/api/rdfoe-wf/*`. Relative URLs ride the page's Connection authentication. */

export const API = '/api/rdfoe-wf'

export interface RunRow { id: string, session_id: string, project_path: string, title: string, status: string, current_node: string | null, created_at: string }
export interface NodeRow { id: string, node_key: string, status: string, agent_session_id: string | null, cwd: string, output: string | null, error: string | null }
export interface AskRow { id: string, nodeId: string, question: string }
export interface Snapshot { run: RunRow | null, nodes: NodeRow[], asks: AskRow[], at?: string }

export async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

/**
 * Follow the NDJSON event stream for one session, reconnecting after drops.
 * @returns a disposer that aborts the stream.
 */
export function followSession(sessionId: string, onSnapshot: (s: Snapshot) => void, onStatus: (s: string) => void): () => void {
  const controller = new AbortController()
  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        onStatus('connecting')
        const response = await fetch(`${API}/events?${new URLSearchParams({ sessionId })}`, { signal: controller.signal })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        onStatus('live')
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.trim() === '') continue
            const message = JSON.parse(line) as { type: string } & Snapshot
            if (message.type === 'snapshot') onSnapshot(message)
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        onStatus(`retrying: ${String(error)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  void loop()
  return () => controller.abort()
}
