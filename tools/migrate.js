'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('pg');

async function migrate(connectionString = process.env.SIGNLIST_DATABASE_URL) {
  if (!connectionString) throw new Error('SIGNLIST_DATABASE_URL is required');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('protocol-registration.migrations'))");
    await client.query('create table if not exists protocol_registration_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())');
    const directory = path.join(__dirname, '..', 'db', 'migrations');
    const names = fs.readdirSync(directory).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of names) {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      const hash = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const existing = await client.query('select sha256 from protocol_registration_migrations where name = $1', [name]);
      if (existing.rows.length) {
        if (existing.rows[0].sha256 !== hash) throw new Error('Migration checksum mismatch: ' + name);
        continue;
      }
      const body = sql.replace(/^begin;\s*$/im, '').replace(/^commit;\s*$/im, '');
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into protocol_registration_migrations (name, sha256) values ($1, $2)', [name, hash]);
        await client.query('commit');
        console.log('Applied ' + name);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    return names.length;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(count => console.log('Migrations ready: ' + count)).catch(error => {
    console.error('Database migration failed (' + (error.code || 'MIGRATION_ERROR') + ').');
    process.exitCode = 1;
  });
}
module.exports = { migrate };
