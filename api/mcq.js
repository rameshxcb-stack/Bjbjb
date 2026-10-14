async function handleCleanup() {
  const db = getDb();
  const cutoff90d = Date.now() - (90 * 24 * 60 * 60 * 1000);

  const r1 = await db.execute({ sql: 'DELETE FROM user_seen WHERE seen_at < ?', args: [cutoff90d] });

  const r2 = await db.execute({
    sql: `DELETE FROM learn_bad WHERE id NOT IN (SELECT id FROM learn_bad ORDER BY id DESC LIMIT 10000)`,
    args: []
  });

  const r3 = await db.execute({
    sql: `DELETE FROM learn_good WHERE id NOT IN (SELECT id FROM learn_good ORDER BY id DESC LIMIT 10000)`,
    args: []
  });

  // ⭐ NEW: orphan signatures cleanup
  const r4 = await db.execute({
    sql: `DELETE FROM mcq_signatures 
          WHERE mcq_id NOT IN (SELECT id FROM mcqs)`,
    args: []
  });

  return {
    status: 200,
    body: {
      status: 'SUCCESS',
      cleaned: {
        user_seen: r1.rowsAffected || 0,
        learn_bad: r2.rowsAffected || 0,
        learn_good: r3.rowsAffected || 0,
        orphan_sigs: r4.rowsAffected || 0
      }
    }
  };
}
