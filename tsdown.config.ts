/**
 * Two faces from one package, mirroring DSH's client tsdown preset
 * (packages/client/tsdown.client.ts in deepseek-harness 0.1.7-alpha.2):
 *
 * - lib/index.js  — Host ESM for the Cordis Loader; every bare import stays
 *   external so DSH packages resolve to the running installation (peers).
 * - lib/client.js — browser closure factory registered through
 *   `window.__ModuleLoader__.load({ id, factory })`; React, Cordis and the
 *   static UI libraries are requested from the shell module table, everything
 *   else is inlined.
 */
import { defineConfig, type UserConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

/** Mirrors PLATFORM_MODULES in packages/client/web/src/platform.ts. */
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const host: UserConfig = {
  name: 'host',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: (id: string) => !id.startsWith('.') && !id.startsWith('/') },
  // PH prompt templates (src/host/prompts/ph/templates/*.md) are inlined as strings.
  loader: { '.md': 'text' },
  outputOptions: { entryFileNames: 'index.js' },
}

const client: UserConfig = {
  name: 'client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (id: string) => PLATFORM_MODULES.has(id),
    alwaysBundle: (id: string) => !PLATFORM_MODULES.has(id),
  },
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
