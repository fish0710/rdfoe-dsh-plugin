/**
 * rdfoe-workflow Host entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Config } from './config.ts'
import { InboxBroker } from './inbox/broker.ts'
import { registerRoutes } from './routes/routes.ts'
import { Hub } from './runner/hub.ts'
import { NodeRunner } from './runner/node-runner.ts'
import { Store } from './store/store.ts'
import { registerWorkflowCommand } from './tools/session-command.ts'
import { engageSession } from './tools/session-engage.ts'
import { wfStartTool, wfStatusTool } from './tools/session-tools.ts'
import { WorkflowService } from './workflow/service.ts'

export const name = 'rdfoe-workflow'
export const inject = ['tools', 'agents', 'connection']
export { Config }

export function apply(ctx: Context, config: Config) {
  const dbPath = config.dbPath ?? dshHomePath('rdfoe-workflow', 'state.db')
  const worktreeRoot = config.worktreeRoot ?? dshHomePath('rdfoe-workflow', 'worktrees')
  const store = new Store(dbPath)
  const hub = new Hub()
  const inbox = new InboxBroker(store, hub)
  const runner = new NodeRunner(ctx, config.maxConcurrentAgents)
  const service = new WorkflowService(ctx, config, store, hub, inbox, runner, worktreeRoot)
  const recovered = service.recoverOnStartup()

  ctx.effect(() => async () => {
    service.dispose()
    // Release parked tool calls first so their items stay OPEN for recovery.
    inbox.detachAll('rdfoe-workflow unloading')
    await runner.disposeAll()
    store.close()
  })

  ctx.tools.register(wfStartTool(store, service))
  ctx.tools.register(wfStatusTool(store, service))
  /** Title a run's session and give it a first turn when it has none (session-engage.ts). */
  const engage = async (sessionId: string) => {
    const run = store.runBySession(sessionId)
    const agent = run ? await service.mainAgent(sessionId) : undefined
    return run && agent ? engageSession(ctx, agent, run.title) : { titled: false, engaged: false }
  }
  // Optional: `/rdfoe-workflow` appears wherever DSH composes its command registry.
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.effect(() => registerWorkflowCommand((commandsCtx as any).commands, store, service), 'rdfoe-workflow command')
  })
  registerRoutes(ctx, { store, hub, service, engage, devRoutes: config.devRoutes })
  console.info(`[rdfoe-workflow] loaded; db=${dbPath} interrupted runs=${recovered.runs} nodes=${recovered.nodes} legacy read-only=${recovered.orphaned}`)
}
