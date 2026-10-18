import 'dotenv/config';
import { getDb, diagnoseTurso } from '../lib/db.js';
import { makeTrigramSignature, makeWordSetFp } from '../lib/mcq-engine.js';

// Keep total CASE-update bind variables below SQLite's conservative 999-variable limit.
const BATCH_SIZE = Math.max(1, Math.min(150, Number.parseInt(process.env.BACKFILL_BATCH_SIZE || '100', 10) || 100));
const EXPECTED_HASHES = 32;
const MAX_ROWS_PER_RUN = Math.max(BATCH_SIZE, Number.parseInt(process.env.BACKFILL_MAX_ROWS_PER_RUN || '1000', 10) || 1000);

async function ensureColumns(db) {
  const table = await db.execute({ sql: 'PRAGMA table_info(mcqs)', args: [] });
  if (!table.rows?.length) throw new Error('Table mcqs not found! Please apply db/schema.sql first.');
  const columns = new Set(table.rows.map(row => row.name));
  
  const addColumn = async (col, type) => {
    if (!columns.has(col)) {
      await db.execute({ sql: `ALTER TABLE mcqs ADD COLUMN ${col} ${type}`, args: [] });
    }
  };

  await addColumn('trigram_sig', 'TEXT');
  await addColumn('word_set_fp', 'TEXT');
  await addColumn('trigram_version', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn('generation_task_id', 'INTEGER');
  await addColumn('audit_status', "TEXT NOT NULL DEFAULT 'pending'");
  await addColumn('audit_notes', 'TEXT');
  await addColumn('audit_checked_at', 'INTEGER');
  await addColumn('is_disabled', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn('structural_checked_at', 'INTEGER');

  // Indexes
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_gold ON mcqs(is_gold, quality_score DESC)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_generation_task ON mcqs(generation_task_id)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_trigram ON mcqs(trigram_sig)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_wordset ON mcqs(word_set_fp)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_created_at ON mcqs(created_at DESC)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_chapter_created ON mcqs(category, section, subject, chapter, created_at DESC)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_mcqs_audit_status ON mcqs(audit_status, created_at DESC)', args: [] });

  // exam_pattern_cache table (Optional, safe to keep)
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS exam_pattern_cache (
      cache_key TEXT PRIMARY KEY,
      exam_type TEXT NOT NULL,
      subject TEXT,
      pattern_text TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`,
    args: []
  });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_pattern_exam ON exam_pattern_cache(exam_type, subject)', args: [] });
}

async function main() {
  const health = await diagnoseTurso();
  if (!health.success) throw new Error(`Turso connection failed: ${health.message || health.error}`);
  
  const db = getDb();
  await ensureColumns(db);

  let updated = 0;
  while (updated < MAX_ROWS_PER_RUN) {
    const currentBatchSize = Math.min(BATCH_SIZE, MAX_ROWS_PER_RUN - updated);
    
    // Fetch rows that are missing signatures or have old 8-hash versions
    const result = await db.execute({
      sql: `SELECT id, question_en FROM mcqs
            WHERE trigram_sig IS NULL
               OR trigram_version != 2
               OR (length(trigram_sig) - length(replace(trigram_sig, ',', '')) + 1) != ?
               OR word_set_fp IS NULL
            ORDER BY id ASC LIMIT ?`,
      args: [EXPECTED_HASHES, currentBatchSize]
    });
    
    const rows = result.rows || [];
    if (rows.length === 0) break;

    const cases = [];
    const args = [];
    const ids = [];
    
    for (const row of rows) {
      const id = String(row.id);
      const question = String(row.question_en || '');
      let signature = makeTrigramSignature(question, EXPECTED_HASHES);
      if (!signature) signature = new Array(EXPECTED_HASHES).fill(0).join(',');
      
      cases.push('WHEN ? THEN ?');
      args.push(id, signature);
      ids.push(id);
    }
    
    const signatureCase = `CASE id ${cases.join(' ')} ELSE trigram_sig END`;
    const wordCases = [];
    const wordArgs = [];
    
    for (const row of rows) {
      wordCases.push('WHEN ? THEN ?');
      wordArgs.push(String(row.id), makeWordSetFp(String(row.question_en || '')));
    }
    
    const wordCase = `CASE id ${wordCases.join(' ')} ELSE word_set_fp END`;
    const inPlaceholders = ids.map(() => '?').join(',');
    
    await db.execute({
      sql: `UPDATE mcqs SET trigram_sig = ${signatureCase}, trigram_version = 2, word_set_fp = ${wordCase} WHERE id IN (${inPlaceholders})`,
      args: [...args, ...wordArgs, ...ids]
    });
    
    updated += rows.length;
    console.log(`Backfilled ${updated} MCQs...`);
  }
  
  console.log(`✅ Signature backfill complete. Updated ${updated} rows.`);
}

main().catch(error => {
  console.error('❌ Backfill failed:', error?.message || error);
  process.exitCode = 1;
});
