import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    // Same as the tsdown `loader: { '.md': 'text' }` used for lib/.
    name: 'md-text',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(code)}`, map: null }
    },
  }],
  // Only the unit specs; isolated DSH homes (.dsh-dev*) hold workflow worktrees with their own tests.
  test: { include: ['test/**/*.spec.ts'] },
})
