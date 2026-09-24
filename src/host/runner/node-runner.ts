/**
 * NodeRunner: node subagents through `ctx.agents.create` / `ctx.agents.resume`
 * (§6.1, decision 1).
 *
 * Attachment: a node agent is created as a child of the main session's agent
 * (parentAgent + meta.parentSession + subagent/descriptor), which keeps it out
 * of the sidebar session list and lets the right sidebar open it as a
 * subagent chat. When the main agent is not live, it is resolved through
 * `sessionController.resolveAgent` (DSH's own resume path); if that fails the
 * node becomes a root agent that still carries meta.parentSession and the
 * subagent origin.
 *
 * Tool isolation: the agent joins no agent preset, so its registry holds only
 * the tools registered in setup; process-global tools are denied.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput, parentAgentOptionsForDelegation, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { toolsFor, type ToolEnv } from '../tools/node-tools.ts'

export interface ModelRoute { provider: string, model: string }

export interface LaunchInput {
  env: ToolEnv
  mainSessionId: string
  persona: string
  prompt: string
  label: string
  route: AgentOptions
  /** Called with the agent session id before the agent can run any tool. */
  onSession?: (agentSessionId: string) => void
}

export interface ResumeInput extends LaunchInput {
  agentSessionId: string
}

export interface AgentRunResult {
  agentSessionId: string
  /** 'completed' | 'aborted' | 'error' | … from the last turn/end. */
  endKind: string
  error?: string
  finalText: string
}

export interface LiveAgent {
  agentSessionId: string
  attach: 'child' | 'root'
  done: Promise<AgentRunResult>
}

type SessionControllerLike = { resolveAgent(id: SessionId): Promise<{ agent: Agent } | { error: unknown }> }
type DefaultModelLike = { currentSelection(): { provider: string, model: string, reasoningEffort?: string } }

/** A small FIFO semaphore for the global concurrent-agent cap (◇ 4). */
class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve))
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.queue.shift()?.()
    }
  }
}

export class NodeRunner {
  private readonly live = new Map<string, AgentHandle>()
  private readonly semaphore: Semaphore

  constructor(private readonly ctx: Context, maxConcurrent: number) {
    this.semaphore = new Semaphore(maxConcurrent)
  }

  /** The main session's agent, resuming it through the session controller when needed. */
  async mainAgent(sessionId: string): Promise<Agent | undefined> {
    const live = this.ctx.agents.get(sessionId as SessionId)
    if (live) return live
    const controller = this.ctx.get('sessionController' as never) as SessionControllerLike | undefined
    if (!controller) return undefined
    try {
      const result = await controller.resolveAgent(sessionId as SessionId)
      return 'agent' in result ? result.agent : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Model route: per-node Config override, else the main session's current
   * route, else DSH's default-model setting, else the plugin default.
   */
  route(main: Agent | undefined, override: Partial<ModelRoute> | undefined, fallback: Partial<ModelRoute> | undefined): AgentOptions {
    if (override?.provider && override.model) return { provider: override.provider, model: override.model }
    if (main) {
      const inherited = parentAgentOptionsForDelegation(main)
      if (inherited.provider && inherited.model) return { provider: inherited.provider, model: inherited.model, ...(inherited.reasoningEffort ? { reasoningEffort: inherited.reasoningEffort } : {}) }
    }
    const selection = (this.ctx.get('agentDefaultModel' as never) as DefaultModelLike | undefined)?.currentSelection()
    if (selection?.provider && selection.model) return { provider: selection.provider, model: selection.model }
    if (fallback?.provider && fallback.model) return { provider: fallback.provider, model: fallback.model }
    throw new Error('no model route: configure rdfoe-workflow defaultModel or nodes.<key>.model')
  }

  private setup(input: LaunchInput) {
    return (agentCtx: Context) => {
      agentCtx.systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: input.persona,
      })
      const tools = toolsFor(input.env)
      for (const tool of tools) agentCtx.tools.register(tool)
      const own = new Set(tools.map(t => t.name))
      const globals = this.ctx.tools.schemas().map(s => s.name).filter(n => !own.has(n))
      if (globals.length > 0) agentCtx.tools.restrict({ deny: globals })
    }
  }

  async launch(input: LaunchInput, main: Agent | undefined): Promise<LiveAgent> {
    const release = await this.semaphore.acquire()
    try {
      const childId = randomUUID() as SessionId
      const setup = this.setup(input)
      const handle = await this.ctx.agents.create({
        sessionId: childId,
        ...(main ? { parentAgent: main } : {}),
        meta: {
          // Required: the deployment persona suffix interpolates {{cwd}}.
          cwd: input.env.root,
          parentSession: (main?.id ?? input.mainSessionId) as SessionId,
          origin: 'subagent',
          delegationDepth: 1,
        } as never,
        agentOptions: input.route,
        setup: (agentCtx, agent) => {
          input.onSession?.(agent.id)
          // The Web subagent catalog / sidebar classify a child by this event.
          agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'rdfoe-workflow', label: input.label }))
          // A delegated node never prompts for approval; its tools enforce their own scope.
          agent.session.append('approval/policy', { policy: 'never', source: 'delegation' } as never)
          setup(agentCtx)
        },
      }).catch((error: unknown) => { release(); throw error })
      return this.drive(handle, input.prompt, main ? 'child' : 'root', release)
    } catch (error) {
      release()
      throw error
    }
  }

  /** Cold-resume a node agent session (§8.3) and continue it with `prompt`. */
  async resume(input: ResumeInput, main: Agent | undefined): Promise<LiveAgent> {
    const release = await this.semaphore.acquire()
    try {
      const existing = this.ctx.agents.get(input.agentSessionId as SessionId)
      if (existing) {
        const handle = this.live.get(input.agentSessionId)
        if (handle) return this.drive(handle, input.prompt, main ? 'child' : 'root', release)
      }
      const setup = this.setup(input)
      input.onSession?.(input.agentSessionId)
      const handle = await this.ctx.agents.resume({
        resumeSessionId: input.agentSessionId as SessionId,
        ...(main ? { parentAgent: main } : {}),
        agentOptions: input.route,
        setup: (agentCtx: Context) => setup(agentCtx),
      } as never)
      return this.drive(handle, input.prompt, main ? 'child' : 'root', release)
    } catch (error) {
      release()
      throw error
    }
  }

  private drive(handle: AgentHandle, prompt: string, attach: 'child' | 'root', release: () => void): LiveAgent {
    const agent = handle.agent
    this.live.set(agent.id, handle)
    const done = (async (): Promise<AgentRunResult> => {
      try {
        const before = agent.session.snapshotEvents().length
        agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
        await agent.whenIdle()
        // oxlint-disable-next-line typescript/no-deprecated -- same history read the in-process subagent driver uses
        const events = agent.session.snapshotEvents().slice(before)
        const output = finalAssistantOutput(events) ?? []
        const finalText = output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
        const lastEnd = [...events].reverse().find(e => e.type === 'turn/end') as { data?: { reason?: { kind?: string, error?: { message?: string } } } } | undefined
        const reason = lastEnd?.data?.reason
        return { agentSessionId: agent.id, endKind: reason?.kind ?? 'unknown', ...(reason?.error?.message ? { error: reason.error.message } : {}), finalText }
      } catch (error) {
        return { agentSessionId: agent.id, endKind: 'error', error: String(error), finalText: '' }
      } finally {
        release()
      }
    })()
    return { agentSessionId: agent.id, attach, done }
  }

  /** Send a follow-up to a live agent (e.g. "call wf_report") and wait for it. */
  async nudge(agentSessionId: string, text: string): Promise<AgentRunResult | undefined> {
    const handle = this.live.get(agentSessionId)
    if (!handle) return undefined
    const release = await this.semaphore.acquire()
    return this.drive(handle, text, 'child', release).done
  }

  cancel(agentSessionId: string): void {
    this.live.get(agentSessionId)?.agent.cancel({ kind: 'user' })
  }

  async dispose(agentSessionId: string): Promise<void> {
    const handle = this.live.get(agentSessionId)
    this.live.delete(agentSessionId)
    await handle?.dispose().catch(() => {})
  }

  isLive(agentSessionId: string): boolean {
    return this.live.has(agentSessionId)
  }

  async disposeAll(): Promise<void> {
    const handles = [...this.live.values()]
    this.live.clear()
    await Promise.allSettled(handles.map(h => h.dispose()))
  }
}
