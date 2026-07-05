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
      includeAssets: ['icons/*.png', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'GHC',
        short_name: 'GHC',
        description: 'Multi-camera video calling',
        theme_color: '#121212',
        background_color: '#121212',
        // 'browser'는 설치 가능 조건(standalone/minimal-ui/fullscreen)에서 제외되므로
        // 크롬의 PWA "앱 설치" 프롬프트/주소창 아이콘이 뜨지 않는다. 웹은 브라우저로,
        // 데스크탑은 네이티브 앱(.dmg)으로 쓰는 방향이라 PWA 설치를 의도적으로 끈다.
        // (서비스워커/오프라인 캐싱은 그대로 유지)
        display: 'browser',
        orientation: 'any',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
