import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  // Tauri 的约定：固定端口，且不要把 Rust 源码纳入前端热更新
  clearScreen: false,
  server: {
    port: 30110,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'safari15',
    sourcemap: true,
    // React Flow 让主 chunk 超过默认 500KB 阈值；M3 接入代码分割后再收紧
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: { reporter: ['text', 'html'], include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/*.test.*'] },
  },
});
