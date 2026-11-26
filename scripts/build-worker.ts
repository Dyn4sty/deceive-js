/**
 * Electrobun preBuild hook: bundle the proxy worker into build-generated/proxy-worker.js,
 * which electrobun.config.ts copies into the app as app/worker/proxy-worker.js.
 */

import { join } from 'path';

const root = join(import.meta.dir, '..');
const env = process.env.ELECTROBUN_BUILD_ENV ?? 'dev';

const result = await Bun.build({
  entrypoints: [join(root, 'src/proxy/worker.ts')],
  outdir: join(root, 'build-generated'),
  naming: 'proxy-worker.js',
  target: 'bun',
  format: 'esm',
  minify: env !== 'dev',
  sourcemap: env === 'dev' ? 'inline' : 'none',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Bundled proxy worker (${env})`);
