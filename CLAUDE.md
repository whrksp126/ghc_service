# GHC Service

## Project Overview
Self-hosted multi-camera video conferencing PWA. Users register devices (phones, tablets, desktops) as "cameras", then create or join rooms where multiple device cameras stream simultaneously via WebRTC SFU (mediasoup). A single user can have multiple devices, each acting as an independent camera that can be remotely started/stopped and previewed via P2P WebRTC.

## Architecture

### Backend (`backend/src/`)
- **Runtime**: Node.js 20, TypeScript (ES2022, CommonJS), Express.js 4.21
- **Realtime**: Socket.IO 4.8 for signaling + device control
- **Media**: mediasoup 3.14 SFU (VP8/VP9/Opus, simulcast 3-layer)
- **Database**: MySQL 8.0 via Sequelize 6 ORM (snake_case columns, CHAR(36) UUID PKs)
- **Auth**: JWT (30-day expiry) + Google OAuth, bcryptjs passwords
- **Validation**: Zod schemas inline in route handlers
- **Storage**: AWS SDK v3 → self-hosted MinIO (objectstore.ghmate.com), path-style
- **TURN**: coturn with HMAC-SHA1 ephemeral credentials (24h TTL)

### Frontend (`frontend/src/`)
- **Framework**: React 18.3, TypeScript (ES2020, ESNext modules)
- **Build**: Vite 5.4 + PWA plugin (standalone display, auto-updating service worker)
- **Styling**: Tailwind CSS 3.4 with custom dark theme (dark-900 base, primary #FE2C55, secondary #25F4EE)
- **State**: Zustand 5 stores (auth with persist, room, device, camera, ui)
- **Routing**: React Router 6 (BrowserRouter, ProtectedRoute/GuestRoute wrappers)
- **Media**: mediasoup-client 3.7 + native RTCPeerConnection for P2P preview
- **Icons**: lucide-react, **Animations**: Framer Motion 11

### Infrastructure
- **Production**: Docker Compose — front (nginx SPA), api (host network), mysql, coturn
- **Proxy**: External nginx_proxy container handles TLS + routing
- **Domains**: ghc.ghmate.com (front), ghc-api.ghmate.com (API), ghc-turn.ghmate.com (TURN)

## Directory Structure
```
backend/src/
├── config/       # database.ts, mediasoup.ts, objectstore.ts, turn.ts
├── media/        # MediasoupManager.ts (singleton, worker pool)
├── middleware/    # auth.ts (JWT + authMiddleware), errorHandler.ts
├── models/       # User, Device, Room, RoomMember, RoomSession, MediaFile
├── routes/       # auth, rooms, devices, health (under /api prefix)
├── signaling/    # socketHandler.ts (Socket.IO events)
├── migrations/   # Sequelize CLI migrations (currently empty, uses sync({alter}))
├── services/     # (currently empty)
└── lib/          # (currently empty)

frontend/src/
├── components/   # common/ (Button, Modal, Toast), room/, layout/, connection/, devices/, gallery/
├── config/       # constants.ts (API_URL, SOCKET_URL)
├── hooks/        # useMediasoup.ts, useSocket.ts, useGlobalSocket.ts
├── lib/          # api.ts (typed REST client), socket.ts (singleton), fingerprint.ts, sounds.ts
├── pages/        # HomePage, LoginPage, RegisterPage, RoomPage, CamerasPage, AuthCallbackPage
├── services/     # alwaysOnCamera.ts (Zustand store), backgroundCamera.ts (hook), previewStream.ts (P2P)
├── stores/       # authStore, roomStore, deviceStore, cameraStore, uiStore (all Zustand)
├── styles/       # Tailwind entry
└── types/        # room.ts (Participant, ConsumerInfo, LayoutMode, etc.)
```

## Key Conventions

### Backend
- Routes grouped under `/api` prefix (except `/health`)
- Zod validation inline in route handlers
- Error messages in Korean for user-facing, English for logs
- Auth: `Bearer` token, JWT payload `{ userId, nickname }`
- Socket events: `namespace:action` format (room:join, media:produce, camera:requestStart, preview:offer)
- Participant key: `${userId}:${deviceId}` (multi-device per user)
- mediasoupManager singleton from `media/MediasoupManager.ts`
- Consumer starts paused → client calls `media:resumeConsumer`

### Frontend
- Named exports for components
- Zustand `create` pattern, hooks named `use[Name]Store`
- Auth store uses `persist` middleware with `'ghc-auth'` localStorage key
- API calls through `lib/api.ts`, Socket.IO lazy singleton via `lib/socket.ts`
- `emitWithAck<T>(event, data)` for request-response socket calls
- User-facing text in Korean
- Tailwind only (no inline styles), dark theme: `bg-dark-900`, `text-white/60`
- Button wraps `motion.button` (Framer Motion)
- No prop drilling — components read from Zustand stores directly

### Naming
- Backend DB columns: snake_case, files: snake_case (except classes)
- Frontend: camelCase vars/functions, PascalCase components/types
- Socket events: `namespace:action`
- Store hooks: `use[Name]Store`

## Development Workflow

### Local Setup
```bash
# From project root (longdcam/)
bash local-setup.sh

# Manual (from ghc_service/)
docker compose -f docker-compose.local.yml up -d   # MySQL on port 3360
cd backend && set -a && source .env.local && set +a && npm run dev
cd frontend && npm run dev
```

Log surfaces (cmux): `front-log`, `api-log`, `db-log` — read with `cmux capture-pane`.

### Important Ports
- Frontend: https://localhost:3100 (Vite HTTPS)
- Backend: http://localhost:3001 (API_PORT)
- MySQL: localhost:3360
- RTC: 40000-40100 (mediasoup)

### Production Deployment
```bash
bash deploy.sh prod   # SSH to server, git pull, docker compose up --build
```

## Critical Constraints

### mediasoup
- Requires Node.js 20 with native C++ addons (python3, make, g++ at build time)
- Dockerfile: `node:20-bullseye-slim` (not alpine)
- `network_mode: host` required in production for RTC port access
- `MEDIASOUP_ANNOUNCED_IP` must match host's public/LAN IP
- Simulcast: 3 layers (r0: 100kbps/4x, r1: 300kbps/2x, r2: 1Mbps/1x)

### WebRTC / TURN
- coturn: `use-auth-secret` with HMAC-SHA1 ephemeral credentials
- `TURN_SECRET` must match between backend config and turnserver.conf
- TURN ports: 3478 (UDP/TCP), 5349 (TLS)

### Database
- `sequelize.sync({ alter: true })` in dev (no migration files yet)
- utf8mb4 charset for Korean text
- Never use `sync({ force: true })` — drops tables
