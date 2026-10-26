import cors from 'cors';
import express from 'express';
import path from 'path';
import { config } from './config';
import { getPool } from './db/pool';
import { errorHandler, notFoundHandler } from './lib/errors';
import { accountsRouter } from './routes/accounts';
import { transfersRouter } from './routes/transfers';

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', async (_req, res) => {
    await getPool().query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/accounts', accountsRouter);
  app.use('/transfers', transfersRouter);

  // Paisa Wallet frontend at /, API docs (Swagger UI) at /docs, spec at /openapi.yaml.
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
