require('dotenv').config();
const crypto = require('crypto');
const db = require('../db');

function makeKey() {
  return `CASEFLOW-BETA-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function main() {
  const count = Math.max(1, Number(process.argv[2] || 10));
  const rows = [];

  for (let i = 0; i < count; i++) {
    const key = makeKey();
    const label = `Tester ${i + 1}`;
    const { rows: inserted } = await db.query(
      `INSERT INTO beta_invites (invite_key, label, is_active, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       ON CONFLICT (invite_key) DO NOTHING
       RETURNING invite_key, label`,
      [key, label]
    );
    if (inserted[0]) rows.push(inserted[0]);
  }

  console.log('Created beta invites:');
  rows.forEach(r => console.log(`${r.label}: ${r.invite_key}`));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
