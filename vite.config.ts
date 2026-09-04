import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Keep only the largest independent vendor families separate. Splitting
          // React/UI from the generic vendor chunk created Rollup circular-chunk
          // warnings because shared UI dependencies imported across both groups.
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'vendor-firebase';
          if (id.includes('/recharts/') || id.includes('/d3')) return 'vendor-charts';
          return 'vendor';
        },
      },
    },
  },
});
