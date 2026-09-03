import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/controls/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['three'],
});
