import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  base: './', // 相対パスを使用
  server: {
    host: true,
    port: 3000,
    hmr: true,
    watch: {
      usePolling: true,
    }
  },
  preview: {
    host: true,
    port: 4173,
  },
});
