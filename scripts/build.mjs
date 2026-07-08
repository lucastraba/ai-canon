import { build } from 'esbuild';

// Bundle the CLI and its dependencies into a single zero-dependency ESM file.
// The banner shims `require` because some bundled deps use CommonJS interop,
// which esbuild's ESM output otherwise cannot satisfy.
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cli.mjs',
  banner: {
    js: "import { createRequire as __aiCanonCreateRequire } from 'node:module';\nconst require = __aiCanonCreateRequire(import.meta.url);",
  },
});
