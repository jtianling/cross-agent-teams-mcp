import { execFileSync } from 'node:child_process'
import { defineConfig } from 'tsup'
export default defineConfig(options => ({
  entry: {
    cli: 'src/cli.ts',
    'channel-cli': 'plugins/cross-agent-teams-channel/src/cli.ts',
    'agy-mcp': 'plugins/antigravity/src/cli.ts'
  },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  dts: true,
  async onSuccess() {
    if (process.platform !== 'darwin') return
    execFileSync(process.execPath, [
      'scripts/build-darwin-carrier.mjs', options.outDir ?? 'dist',
    ], { stdio: 'inherit' })
  },
}))
