import { build } from 'esbuild';

// Bundle first-party CLI code while leaving declared npm dependencies external.
// Consumers install those dependencies normally, avoiding duplicate bundled and
// installed copies and preserving their package metadata/licenses.
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/cli.mjs',
});
