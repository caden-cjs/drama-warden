import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const frontendRoot = fileURLToPath(new URL('./frontend', import.meta.url));

export default defineConfig({
  root: frontendRoot,
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./frontend/dist', import.meta.url)),
    emptyOutDir: true,
  },
});
