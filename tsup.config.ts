import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/controls/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^three/], // three 及其 examples/jsm 子路径都不打包（含 TransformControls）
});
