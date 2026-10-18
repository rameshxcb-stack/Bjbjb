import 'dotenv/config';
import { getDb, diagnoseTurso, safeDbError } from '../lib/db.js';
import { generateFromScratch, generateChapterList, PYQ_REGISTRY, parseRobotsTxt, isRobotsPathAllowed } from '../lib/mcq-engine.js';
import { computeTaskOutcome } from '../lib/task-accounting.js';
import { createHash } from 'node:crypto';

const TASKS_PER_RUN = Math.max(1, parseInt(process.env.TASKS_PER_RUN || '3', 10) || 3);
const CHAPTERS_PER_SUBJECT = Math.max(3, parseInt(process.env.CHAPTERS_PER_SUBJECT || '20', 10) || 20);
const MCQS_PER_CHAPTER = Math.max(1, parseInt(process.env.MCQS_PER_CHAPTER || '10', 10) || 10);
const QUEUE_LOW_THRESHOLD = 5, CHAPTERS_TO_QUEUE = 10, SEED_LIMIT_PER_RUN = Math.max(1, parseInt(process.env.SEED_LIMIT_PER_RUN || '10', 10) || 10);
const MAX_TASK_ATTEMPTS = Math.max(1, parseInt(process.env.MAX_TASK_ATTEMPTS || '3', 10) || 3);
const STALE_PROCESSING_MS = Math.max(10 * 60 * 1000, parseInt(process.env.STALE_PROCESSING_MINUTES || '120', 10) * 60 * 1000 || 120 * 60 * 1000);

const SUBJECT_SEEDS = [
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Indian Constitution' },
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Union Government' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Ancient India' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Modern India' },
  { category: 'General Studies & Civil Services', section: 'Geography', subject: 'Physical Geography' },
  { category: 'General Studies & Civil Services', section: 'Economy', subject: 'Indian Economy' },
  { category: 'JEE Physics', section: 'Mechanics', subject: 'Kinematics' },
  { category: 'JEE Chemistry', section: 'Organic', subject: 'Hydrocarbons' },
  { category: 'JEE Mathematics', section: 'Calculus', subject: 'Differentiation' },
  { category: 'NEET Biology', section: 'Human Physiology', subject: 'Digestive System' },
  { category: 'SSC Reasoning', section: 'Verbal', subject: 'Analogy' },
  { category: 'Banking Awareness', section: 'Banking', subject: 'RBI Functions' },
  { category: 'Railway Exams', section: 'General', subject: 'General Science' },
  { category: 'Defense Exams', section: 'NDA', subject: 'Mathematics' },
  { category: 'Teaching & Eligibility Exams', section: 'CTET', subject: 'Child Development' },
  { category: 'Law & Judicial Exams', section: 'CLAT', subject: 'Legal Reasoning' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand History' },
];

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function logSection(t) { console.log('\n' + '='.repeat(60)); console.log(t); console.log('='.repeat(60)); }

// ═══════════════════════════════════════════
// 1. SCHEMA MIGRATION (ensure-knowledge-base)
// ═══════════════════════════════════════════
async function runMigrations() {
  logSection('STEP 1: Migrations');
  const db = getDb();
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS knowledge_base (chapter_key TEXT PRIMARY KEY, subject TEXT NOT NULL, chapter TEXT NOT NULL, source_url TEXT NOT NULL, extracted_text TEXT NOT NULL, extraction_method TEXT NOT NULL DEFAULT 'unknown', downloaded_at INTEGER NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS source_host_state (host TEXT PRIMARY KEY, robots_policy_json TEXT, robots_fetched_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0, last_status INTEGER, updated_at INTEGER NOT NULL)`);
    
    async function addCol(t, c, d) { const info = await db.execute(`PRAGMA table_info(${t})`); if (!info.rows.some(r => r.name === c)) await db.execute(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); }
    await addCol('mcqs', 'generation_task_id', 'INTEGER'); await addCol('mcqs', 'is_disabled', 'INTEGER NOT NULL DEFAULT 0');
    await addCol('mcqs', 'trigram_version', 'INTEGER'); await addCol('mcqs', 'structural_checked_at', 'INTEGER');
    
    await db.execute(`CREATE TABLE IF NOT EXISTS mcq_answer_stats (qid TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0, is_disabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS mcq_quality_flags (qid TEXT PRIMARY KEY, quality_status TEXT NOT NULL DEFAULT 'active', flag_reason TEXT, flagged_at INTEGER, ai_recheck_status TEXT NOT NULL DEFAULT 'not_run', ai_recheck_at INTEGER, details_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pyq_bank (id TEXT PRIMARY KEY, category TEXT, section TEXT, subject TEXT, chapter TEXT, exam_name TEXT, exam_year INTEGER, question_en TEXT, question_number TEXT, question_hi TEXT, option_a_en TEXT, option_b_en TEXT, option_c_en TEXT, option_d_en TEXT, option_a_hi TEXT, option_b_hi TEXT, option_c_hi TEXT, option_d_hi TEXT, correct_answer INTEGER, difficulty TEXT, topics TEXT, source_url TEXT, source_page INTEGER, extraction_method TEXT, verified_at INTEGER, created_at INTEGER)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pyq_usage (pyq_id TEXT, mcq_id TEXT, generated_at INTEGER, PRIMARY KEY(pyq_id, mcq_id))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pyq_ingest_state (state_key TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
    log('Migrations OK');
  } catch (e) { log(`Migration error: ${safeDbError(e).message}`); }
}

// ═══════════════════════════════════════════
// 2. STRUCTURAL AUDIT (audit-mcqs)
// ═══════════════════════════════════════════
async function runAudit() {
  logSection('STEP 2: Structural Audit');
  const db = getDb();
  try {
    const rows = (await db.execute({ sql: "SELECT id, question_en, option_a_en, option_b_en, option_c_en, option_d_en FROM mcqs WHERE audit_status = 'pending' AND audit_checked_at IS NULL LIMIT 500" })).rows;
    if (!rows.length) { log('No pending rows'); return; }
    let q = 0;
    for (const r of rows) {
      const opts = [r.option_a_en, r.option_b_en, r.option_c_en, r.option_d_en].map(x => String(x || '').toLowerCase().trim());
      if (new Set(opts).size !== 4) { await db.execute({ sql: "UPDATE mcqs SET audit_status = 'quarantine', audit_checked_at = ? WHERE id = ?", args: [Date.now(), r.id] }); q++; }
      else { await db.execute({ sql: "UPDATE mcqs SET audit_checked_at = ? WHERE id = ?", args: [Date.now(), r.id] }); }
    }
    log(`Audited ${rows.length}, quarantined ${q}`);
  } catch (e) { log(`Audit error: ${safeDbError(e).message}`); }
}

// ═══════════════════════════════════════════
// 3. PYQ INGESTION (ingest-pyq)
// ═══════════════════════════════════════════
async function runPyqIngest() {
  if (!PYQ_REGISTRY || !PYQ_REGISTRY.length) { log('PYQ Registry empty'); return; }
  logSection('STEP 3: PYQ Ingestion');
  const db = getDb();
  const curRes = await db.execute({ sql: "SELECT cursor FROM pyq_ingest_state WHERE state_key = 'cursor' LIMIT 1" });
  let cur = Number(curRes.rows[0]?.cursor || 0) % PYQ_REGISTRY.length;
  
  for (let i = 0; i < Math.min(5, PYQ_REGISTRY.length); i++) {
    const paper = PYQ_REGISTRY[(cur + i) % PYQ_REGISTRY.length];
    if (!paper || !paper.paper_url) continue;
    log(`Ingesting ${paper.exam_name}...`);
    try {
      const res = await fetch(paper.paper_url, { headers: { 'User-Agent': 'MCQResearchBot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const gKey = String(process.env.GEMINI_KEYS).split(',')[0].trim();
      const gRes = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Extract MCQs to JSON: {\"questions\":[{\"question_en\":\"\",\"option_a_en\":\"\",\"option_b_en\":\"\",\"option_c_en\":\"\",\"option_d_en\":\"\",\"correct_answer\":0,\"subject\":\"\",\"chapter\":\"\"}]}" }, { inline_data: { mime_type: 'application/pdf', data: buf.toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json' } })
      });
      const gData = await gRes.json();
      const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
        let ins = 0;
        for (const q of (parsed.questions || [])) {
           if (!q.question_en) continue;
           const id = createHash('sha256').update(q.question_en).digest('hex').slice(0, 32);
           await db.execute({ sql: "INSERT OR IGNORE INTO pyq_bank (id, exam_name, exam_year, subject, chapter, question_en, option_a_en, option_b_en, option_c_en, option_d_en, correct_answer, source_url, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, paper.exam_name, paper.exam_year, q.subject||paper.subject, q.chapter||paper.chapter, q.question_en, q.option_a_en, q.option_b_en, q.option_c_en, q.option_d_en, q.correct_answer, paper.paper_url, Date.now(), Date.now()] });
           ins++;
        }
        log(`Inserted ${ins} questions`);
      }
    } catch (e) { log(`Fail ${paper.id}: ${e.message}`); }
  }
  cur = (cur + 5) % PYQ_REGISTRY.length;
  await db.execute({ sql: "INSERT INTO pyq_ingest_state (state_key, cursor, updated_at) VALUES ('cursor', ?, ?) ON CONFLICT(state_key) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at", args: [cur, Date.now()] });
}

// ═══════════════════════════════════════════
// 4. QUEUE & GENERATION
// ═══════════════════════════════════════════
async function checkConnection() {
  const r = await diagnoseTurso();
  if (!r.success) { log(`DB failed: ${r.error}`); process.exit(1); }
}

async function seedSubjectsIfNeeded() {
  logSection('STEP 4: Seed Subjects');
  const db = getDb();
  let expanded = 0;
  for (const seed of SUBJECT_SEEDS) {
    if (expanded >= SEED_LIMIT_PER_RUN) break;
    const cnt = (await db.execute({ sql: 'SELECT COUNT(*) AS c FROM chapter_pool WHERE category=? AND section=? AND subject=?', args: [seed.category, seed.section, seed.subject] })).rows[0]?.c || 0;
    if (cnt > 0) continue;
    try {
      const chaps = await generateChapterList({ category: seed.category, section: seed.section, subject: seed.subject, existingChapters: [], count: CHAPTERS_PER_SUBJECT });
      const now = Date.now();
      for (const ch of chaps) await db.execute({ sql: "INSERT OR IGNORE INTO chapter_pool (category, section, subject, chapter, status, created_at, updated_at) VALUES (?,?,?,?,'pending',?,?)", args: [seed.category, seed.section, seed.subject, ch, now, now] });
      expanded++;
    } catch (e) { log(`Seed fail ${seed.subject}: ${e.message}`); }
  }
}

async function ensureQueueHasTasks() {
  logSection('STEP 5: Queue Check');
  const db = getDb();
  const pending = (await db.execute({ sql: "SELECT COUNT(*) AS c FROM generation_tasks WHERE status = 'pending'" })).rows[0]?.c || 0;
  if (pending >= QUEUE_LOW_THRESHOLD) { log('Queue full'); return; }
  
  const chaps = (await db.execute({ sql: "SELECT * FROM chapter_pool WHERE status = 'pending' LIMIT ?", args: [CHAPTERS_TO_QUEUE] })).rows;
  if (chaps.length) {
    const now = Date.now(); let q = 0;
    for (const c of chaps) {
      const res = await db.execute({ sql: "INSERT INTO generation_tasks (category, section, subject, chapter, target_count, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)", args: [c.category, c.section, c.subject, c.chapter, MCQS_PER_CHAPTER, now, now] });
      if (res.rowsAffected > 0) { await db.execute({ sql: "UPDATE chapter_pool SET status='in_progress' WHERE id=?", args: [c.id] }); q++; }
    }
    log(`Queued ${q} tasks`); return;
  }

  // Expand pool
  let best = SUBJECT_SEEDS[0], min = Infinity;
  for (const s of SUBJECT_SEEDS) { const cnt = (await db.execute({ sql: 'SELECT COUNT(*) AS c FROM chapter_pool WHERE category=? AND section=? AND subject=?', args: [s.category, s.section, s.subject] })).rows[0]?.c || 0; if (cnt < min) { min = cnt; best = s; } }
  const ex = (await db.execute({ sql: 'SELECT chapter FROM chapter_pool WHERE category=? AND section=? AND subject=?', args: [best.category, best.section, best.subject] })).rows.map(r => r.chapter);
  try {
    const chaps = await generateChapterList({ category: best.category, section: best.section, subject: best.subject, existingChapters: ex, count: CHAPTERS_PER_SUBJECT });
    const now = Date.now();
    for (const ch of chaps) await db.execute({ sql: "INSERT OR IGNORE INTO chapter_pool (category, section, subject, chapter, status, created_at, updated_at) VALUES (?,?,?,?,'pending',?,?)", args: [best.category, best.section, best.subject, ch, now, now] });
  } catch (e) { log(`Pool expand fail: ${e.message}`); }
}

async function processTasks() {
  logSection('STEP 6: Generate MCQs');
  const db = getDb();
  for (let i = 0; i < TASKS_PER_RUN; i++) {
    const claim = await db.execute({ sql: "UPDATE generation_tasks SET status = 'processing', retry_count = retry_count + 1, updated_at = ? WHERE id = (SELECT id FROM generation_tasks WHERE status = 'pending' ORDER BY updated_at ASC LIMIT 1) RETURNING *", args: [Date.now()] });
    const task = claim.rows?.[0];
    if (!task) { log('No pending tasks'); break; }
    
    log(`Processing [${task.category} | ${task.subject} | ${task.chapter}]`);
    try {
      const res = await generateFromScratch({ category: task.category, section: task.section, subject: task.subject, chapter: task.chapter, exam_type: 'mixed', difficulty: 'hard', count: task.target_count || MCQS_PER_CHAPTER, taskId: task.id });
      const outcome = computeTaskOutcome(task, res, MAX_TASK_ATTEMPTS);
      
      await db.execute({ sql: `UPDATE generation_tasks SET status=?, generated_count=?, last_error=?, updated_at=? WHERE id=?`, args: [outcome.taskStatus, outcome.cumulativeGenerated, outcome.errorText, Date.now(), task.id] });
      await db.execute({ sql: `UPDATE chapter_pool SET status=?, mcq_count=mcq_count+?, updated_at=? WHERE category=? AND section=? AND subject=? AND chapter=?`, args: [outcome.chapterStatus, outcome.insertedThisAttempt, Date.now(), task.category, task.section, task.subject, task.chapter] });
      
      log(`Saved: ${res.count}, Rejected: ${res.rejectedTotal}, Time: ${res.roundsUsed} rounds`);
    } catch (e) {
      log(`Task crash: ${e.message}`);
      await db.execute({ sql: "UPDATE generation_tasks SET status='pending', last_error=? WHERE id=?", args: [e.message, task.id] });
    }
  }
}

async function main() {
  logSection('STARTING WORKFLOW');
  try {
    await checkConnection();
    await runMigrations();
    await runAudit();
    
    if (process.env.RUN_PYQ_INGEST === '1') {
      await runPyqIngest();
    }

    await seedSubjectsIfNeeded();
    await ensureQueueHasTasks();
    await processTasks();
    log('WORKFLOW COMPLETE');
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
  }
}

main();
