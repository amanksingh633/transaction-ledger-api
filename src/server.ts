import { config } from './config';
import { createApp } from './app';
import { closePool } from './db/pool';
import { migrate } from './db/migrate';

async function main() {
  await migrate(); // idempotent: creates tables/constraints if missing
  const server = createApp().listen(config.port, () => {
    console.log(`Ledger API listening on http://localhost:${config.port}`);
  });

  const shutdown = () => server.close(() => void closePool());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
