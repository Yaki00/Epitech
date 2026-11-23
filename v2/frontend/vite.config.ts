/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Développement : http://localhost:5173, l'API est relayée vers le backend v2 (port 3002).
// Production : `npm run build` écrit dist/, servi tel quel par le backend (FRONTEND_DIST).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Edge / Chrome récents du poste de travail
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
