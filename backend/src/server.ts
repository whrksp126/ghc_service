import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { sequelize } from './models';
import { setupSocketHandlers } from './signaling/socketHandler';

const PORT = parseInt(process.env.API_PORT || '3000');

async function main() {
  // DB sync
  await sequelize.sync({ alter: process.env.NODE_ENV !== 'production' });
  console.log('Database synced');

  // HTTP server
  const httpServer = http.createServer(app);

  // Socket.IO
  const isProd = process.env.NODE_ENV === 'production';

  const io = new Server(httpServer, {
    cors: {
      origin: isProd
        ? ['https://ghc.ghmate.com']
        : true,
      credentials: true,
    },
    // Socket.IO defaults. The previous 10s/5s pair was aggressive enough that ordinary jitter
    // (a Cloudflare-proxied desktop, a briefly busy renderer) read as death: prod logs showed
    // clients being dropped with "ping timeout" mid-call and immediately reconnecting, each churn
    // re-running room:join. Slower liveness detection (~45s worst case, then GRACE_MS) is the
    // right trade against dropping healthy calls.
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // Socket handlers (media is handled by the external LiveKit SFU)
  setupSocketHandlers(io);

  httpServer.listen(PORT, () => {
    console.log(`GHC API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
