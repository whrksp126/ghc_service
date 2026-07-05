import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes';
import { errorHandler } from './middleware/errorHandler';

const app = express();

// 보안 헤더. 프론트가 별도 도메인이므로 crossOriginResourcePolicy는 완화.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const allowedOrigins = [
  'http://localhost:3200',
  'http://localhost:3100',
  'http://localhost:5173',
  'http://192.168.0.16:3100',
  'http://192.168.0.16:3101',
  'https://ghc.ghmate.com',
];

const isProd = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || !isProd || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(routes);
app.use(errorHandler);

export default app;
