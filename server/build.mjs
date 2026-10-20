import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// @app/shared 以外の依存は外部化（本番イメージで npm ci --omit=dev する）
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: Object.keys({ ...pkg.dependencies }).filter((n) => n !== '@app/shared'),
  banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
});
