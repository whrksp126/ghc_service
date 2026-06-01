import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    basicSsl(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Longdcam',
        short_name: 'Longdcam',
        description: 'Multi-camera video calling',
        theme_color: '#121212',
        background_color: '#121212',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: 'StaleWhileRevalidate',
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 3100,
    proxy: {
      '/socket.io': {
        target: `http://localhost:${process.env.API_PORT || 3001}`,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: true,
      },
      // LiveKit signaling over the dev server's TLS, so a phone on the LAN uses a single
      // wss origin (no second self-signed cert, no mixed-content block). Media (RTP) still
      // flows directly to the LiveKit UDP/TCP ports — see --node-ip in docker-compose.local.
      '/livekit': {
        target: `http://localhost:${process.env.LIVEKIT_PORT || 7880}`,
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/livekit/, ''),
      },
    },
  },
});
