import { createClient } from '@libsql/client';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
  const db = createClient({ 
    url: process.env.TURSO_DATABASE_URL as string, 
    authToken: process.env.TURSO_AUTH_TOKEN as string
  });
  await db.execute({ sql: "DELETE FROM scrape_hashes", args: [] });
  const result = await db.execute({ sql: "SELECT COUNT(*) as count FROM scrape_hashes", args: [] });
  console.log('Hashes remaining:', result.rows[0].count);
  console.log('All hashes cleared — next scrape will re-embed everything');
})();
