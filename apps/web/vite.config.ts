import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const proxyTarget = process.env.XOFFLE_PROXY ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/favicon.svg'],
      manifest: {
        id: '/',
        name: 'X-Offline — zapisane posty bez internetu',
        short_name: 'X Offline',
        description:
          'Przeglądaj i zapisuj posty X (Twitter) do czytania offline — dziwnie szybki czytnik na słabe łącze.',
        lang: 'pl',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        start_url: '/?source=pwa',
        scope: '/',
        shortcuts: [
          { name: 'Zapisane offline', short_name: 'Offline', url: '/?tab=offline' },
          { name: 'Pobierz posty', short_name: 'Pobierz', url: '/?tab=live' },
        ],
        share_target: {
          action: '/?import=1',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,json,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Odpowiedzi proxy (listy postów) — sieciowo, ale zapisujemy kopię do IDB osobno.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'xoffline-api',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            // Media z publicznego CDN X — CacheFirst, żeby offline odtwarzały się natychmiast.
            urlPattern: ({ url }) => /twimg\.com$/.test(url.hostname) || url.hostname.endsWith('.pbs.twimg.com'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'xoffline-media',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: true, navigateFallback: 'index.html' },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true, selfHandleResponse: false },
      '/media': { target: proxyTarget, changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
});
