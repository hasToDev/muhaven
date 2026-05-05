import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    broker: 'src/broker/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
  shims: true,
});
