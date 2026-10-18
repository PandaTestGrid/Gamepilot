import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1'
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1'
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 2048
  }
});
