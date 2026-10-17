import pg from 'pg';
pg.types.setTypeParser(20, Number); // bigint -> number (safe up to 9 PB)
export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
