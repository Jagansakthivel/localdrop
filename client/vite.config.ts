import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// The deployed staging Worker builds this entry explicitly. Vercel production
// must omit it even if a preview-only setting is inherited by the build.
const diagnostics = process.env.LOCALDROP_BUILD_DIAGNOSTICS === '1' &&
  process.env.VERCEL_ENV !== 'production';

export default defineConfig({
  define: diagnostics ? {} : { 'import.meta.env.VITE_ENABLE_TURN': JSON.stringify('false') },
  plugins: [
    react(),
    tailwindcss(),
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: false },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallbackDenylist: [/^\/ws/, /^\/api/, /^\/health/, /^\/stats/, /^\/diagnostics(?:\.html)?(?:[/?]|$)/],
      },
      manifest: {
        name: 'LocalDrop',
        short_name: 'LocalDrop',
        theme_color: '#000000',
        background_color: '#F2F2F7',
        display: 'standalone',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      input: diagnostics ? { app: 'index.html', diagnostics: 'diagnostics.html' } : { app: 'index.html' },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': {
        target: process.env.VITE_DEV_BACKEND_URL || 'http://localhost:8080',
        ws: true,
        rewriteWsOrigin: true,
      },
      '/health': {
        target: process.env.VITE_DEV_BACKEND_URL || 'http://localhost:8080',
      },
      '/api': {
        target: process.env.VITE_DEV_BACKEND_URL || 'http://localhost:8080',
      },
    },
  },
});
