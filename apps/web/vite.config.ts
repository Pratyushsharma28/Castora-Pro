import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const webRoot = import.meta.dirname;

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@web': path.resolve(webRoot, 'src'),
    },
  },
  build: {
    outDir: path.resolve(webRoot, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
