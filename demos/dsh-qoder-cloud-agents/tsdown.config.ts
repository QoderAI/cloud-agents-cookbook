import { defineConfig } from 'tsdown'

/** Self-contained Loader entries: dsh packages stay external (peers). */
const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

export default defineConfig([
  entry('lib/types/index.js'),
  // The 「云端模式」 preset's child plugin, loaded as `dsh-qoder-cloud-agents/cloud-route`.
  entry('lib/types/cloud-route.js'),
])
