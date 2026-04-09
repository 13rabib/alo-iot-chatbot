import { createClient } from '@libsql/client';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
  const db = createClient({ 
    url: process.env.TURSO_DATABASE_URL as string, 
    authToken: process.env.TURSO_AUTH_TOKEN as string
  });
  await db.execute({ sql: "DELETE FROM scrape_hashes WHERE source_id = 'obd-supported-vehicles'", args: [] });
  console.log('PDF hash cleared');
})();
