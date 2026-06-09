import { Router } from 'express';
import healthRouter from './health';
import authRouter from './auth';
import roomsRouter from './rooms';
import devicesRouter from './devices';
import mediaRouter from './media';
import releasesRouter from './releases';

const router = Router();

router.use(healthRouter);
router.use('/api', authRouter);
router.use('/api', roomsRouter);
router.use('/api', devicesRouter);
router.use('/api', mediaRouter);
router.use('/api', releasesRouter);

export default router;
