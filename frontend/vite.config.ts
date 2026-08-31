import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` startet Vite auf :5173 und proxied /api an den Node-Server (:3000).
// Prod: `npm run build` schreibt nach dist/, das Express ausliefert.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
