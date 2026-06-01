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
        ? ['https://longdcam-front.ghmate.com']
        : true,
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // Socket handlers (media is handled by the external LiveKit SFU)
  setupSocketHandlers(io);

  httpServer.listen(PORT, () => {
    console.log(`Longdcam API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
