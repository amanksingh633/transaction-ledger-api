import { readFileSync } from 'fs';
import path from 'path';
import { closePool, getPool } from './pool';

export async function migrate(): Promise<void> {
  // Same relative path from src/db (tsx) and dist/db (compiled).
  const sql = readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => console.log('Database schema is up to date.'))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
