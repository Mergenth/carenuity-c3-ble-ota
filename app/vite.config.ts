import { defineConfig } from 'vite';

// Relative paths so that the same build runs on GitHub Pages (sub-folder),
// inside the Capacitor apps and from any static host.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
});
