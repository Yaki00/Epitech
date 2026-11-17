import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Front sur :3000 (comme la v1), API Express sur :3001 via le proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: { '/api': { target: process.env.LYRA_API || 'http://localhost:3001', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
