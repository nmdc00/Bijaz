import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  build: {
    outDir: '../src/gateway/dashboard-dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:18789',
    },
  },
});
