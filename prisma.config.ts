import path from 'node:path';
import { defineConfig } from 'prisma/config';

// A prisma.config.ts turns OFF Prisma's automatic .env loading, so DATABASE_URL
// has to be loaded here explicitly or every migrate command fails.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env yet (fresh clone, or CI supplying real env vars) — fine either way.
}

export default defineConfig({
  schema: path.join('src', 'db', 'schema.prisma'),
  migrations: {
    // Kept beside the schema so the whole data layer lives under src/db.
    path: path.join('src', 'db', 'migrations'),
  },
});
