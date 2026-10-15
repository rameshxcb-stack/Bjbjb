import 'dotenv/config';
// ============================================================
// scripts/generate.js — Auto-expanding MCQ generator
// ============================================================

import { getDb, diagnoseTurso, safeDbError } from '../lib/db.js';
import { generateFromScratch, generateChapterList } from '../lib/mcq-engine.js';
import { computeTaskOutcome } from '../lib/task-accounting.js';

const TASKS_PER_RUN = Math.max(1, parseInt(process.env.TASKS_PER_RUN || '3', 10) || 3);
const CHAPTERS_PER_SUBJECT = Math.max(3, parseInt(process.env.CHAPTERS_PER_SUBJECT || '20', 10) || 20);
const MCQS_PER_CHAPTER = Math.max(1, parseInt(process.env.MCQS_PER_CHAPTER || '10', 10) || 10);
const QUEUE_LOW_THRESHOLD = 5;
const CHAPTERS_TO_QUEUE = 10;
const SEED_LIMIT_PER_RUN = Math.max(1, parseInt(process.env.SEED_LIMIT_PER_RUN || '10', 10) || 10);
const MAX_TASK_ATTEMPTS = Math.max(1, parseInt(process.env.MAX_TASK_ATTEMPTS || '3', 10) || 3);
const STALE_PROCESSING_MS = Math.max(10 * 60 * 1000, parseInt(process.env.STALE_PROCESSING_MINUTES || '120', 10) * 60 * 1000 || 120 * 60 * 1000);

const SUBJECT_SEEDS = [
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Indian Constitution' },
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Union Government' },
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'State Government' },
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Judiciary' },
  { category: 'General Studies & Civil Services', section: 'Polity', subject: 'Local Governance' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Ancient India' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Medieval India' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Modern India' },
  { category: 'General Studies & Civil Services', section: 'History', subject: 'Art & Culture' },
  { category: 'General Studies & Civil Services', section: 'Geography', subject: 'Physical Geography' },
  { category: 'General Studies & Civil Services', section: 'Geography', subject: 'Indian Geography' },
  { category: 'General Studies & Civil Services', section: 'Geography', subject: 'World Geography' },
  { category: 'General Studies & Civil Services', section: 'Economy', subject: 'Macroeconomics' },
  { category: 'General Studies & Civil Services', section: 'Economy', subject: 'Indian Economy' },
  { category: 'General Studies & Civil Services', section: 'Economy', subject: 'Banking & Finance' },
  { category: 'General Studies & Civil Services', section: 'Environment', subject: 'Ecology' },
  { category: 'General Studies & Civil Services', section: 'Environment', subject: 'Climate Change' },
  { category: 'General Studies & Civil Services', section: 'Science & Tech', subject: 'Space Technology' },
  { category: 'General Studies & Civil Services', section: 'Science & Tech', subject: 'Biotechnology' },
  { category: 'General Studies & Civil Services', section: 'International Relations', subject: 'India & Neighbours' },
  { category: 'JEE Physics', section: 'Mechanics', subject: 'Kinematics' },
  { category: 'JEE Physics', section: 'Mechanics', subject: 'Laws of Motion' },
  { category: 'JEE Physics', section: 'Mechanics', subject: 'Work Energy Power' },
  { category: 'JEE Physics', section: 'Electromagnetism', subject: 'Electrostatics' },
  { category: 'JEE Physics', section: 'Electromagnetism', subject: 'Current Electricity' },
  { category: 'JEE Physics', section: 'Modern Physics', subject: 'Quantum Mechanics' },
  { category: 'JEE Chemistry', section: 'Organic', subject: 'Hydrocarbons' },
  { category: 'JEE Chemistry', section: 'Organic', subject: 'Alcohols Phenols Ethers' },
  { category: 'JEE Chemistry', section: 'Physical', subject: 'Thermodynamics' },
  { category: 'JEE Chemistry', section: 'Physical', subject: 'Chemical Kinetics' },
  { category: 'JEE Chemistry', section: 'Inorganic', subject: 'Periodic Table' },
  { category: 'JEE Mathematics', section: 'Calculus', subject: 'Differentiation' },
  { category: 'JEE Mathematics', section: 'Calculus', subject: 'Integration' },
  { category: 'JEE Mathematics', section: 'Algebra', subject: 'Quadratic Equations' },
  { category: 'JEE Mathematics', section: 'Coordinate Geometry', subject: 'Straight Lines' },
  { category: 'NEET Biology', section: 'Human Physiology', subject: 'Digestive System' },
  { category: 'NEET Biology', section: 'Human Physiology', subject: 'Circulatory System' },
  { category: 'NEET Biology', section: 'Genetics', subject: 'Mendelian Genetics' },
  { category: 'NEET Biology', section: 'Cell Biology', subject: 'Cell Structure' },
  { category: 'NEET Biology', section: 'Plant Physiology', subject: 'Photosynthesis' },
  { category: 'SSC Reasoning', section: 'Verbal', subject: 'Analogy' },
  { category: 'SSC Reasoning', section: 'Verbal', subject: 'Series' },
  { category: 'SSC Reasoning', section: 'Non-Verbal', subject: 'Figure Matrix' },
  { category: 'SSC Quantitative Aptitude', section: 'Arithmetic', subject: 'Number System' },
  { category: 'SSC Quantitative Aptitude', section: 'Arithmetic', subject: 'Percentages' },
  { category: 'SSC Quantitative Aptitude', section: 'Algebra', subject: 'Linear Equations' },
  { category: 'SSC English', section: 'Grammar', subject: 'Tenses' },
  { category: 'SSC English', section: 'Vocabulary', subject: 'Synonyms Antonyms' },
  { category: 'SSC General Awareness', section: 'Static GK', subject: 'Indian Geography' },
  { category: 'SSC General Awareness', section: 'Static GK', subject: 'Indian History' },
  { category: 'SSC General Awareness', section: 'Current Affairs', subject: 'Recent Events' },
  { category: 'Banking Reasoning', section: 'Logical', subject: 'Puzzles' },
  { category: 'Banking Reasoning', section: 'Logical', subject: 'Seating Arrangement' },
  { category: 'Banking Quantitative Aptitude', section: 'Arithmetic', subject: 'Profit & Loss' },
  { category: 'Banking Quantitative Aptitude', section: 'Arithmetic', subject: 'Time & Work' },
  { category: 'Banking English', section: 'Comprehension', subject: 'Reading Comprehension' },
  { category: 'Banking Awareness', section: 'Banking', subject: 'RBI Functions' },
  { category: 'Banking Awareness', section: 'Banking', subject: 'Banking Terminology' },
  { category: 'Railway Exams', section: 'Technical', subject: 'Basic Electricity' },
  { category: 'Railway Exams', section: 'Technical', subject: 'Basic Mechanics' },
  { category: 'Railway Exams', section: 'General', subject: 'General Science' },
  { category: 'Defense Exams', section: 'NDA', subject: 'Mathematics' },
  { category: 'Defense Exams', section: 'NDA', subject: 'General Ability' },
  { category: 'Teaching & Eligibility Exams', section: 'CTET', subject: 'Child Development' },
  { category: 'Teaching & Eligibility Exams', section: 'CTET', subject: 'Pedagogy' },
  { category: 'Law & Judicial Exams', section: 'CLAT', subject: 'Legal Reasoning' },
  { category: 'Law & Judicial Exams', section: 'CLAT', subject: 'Logical Reasoning' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand History' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand Geography' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand Polity' },
  { category: 'Jharkhand State Exams', section: 'JSSC', subject: 'General Studies' },
];

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function logSection(title) { console.log('\n' + '='.repeat(60)); console.log(title); console.log('='.repeat(60)); }

async function checkConnection() {
  logSection('STEP 1: Turso connection');
  const r = await diagnoseTurso();
  if (!r.success) { console.error('❌ DB failed:', r.error, r.message); process.exit(1); }
  log(`✅ Connected to ${r.diagnostics.urlHost}`);
}

async function seedSubjectsIfNeeded() {
  logSection('STEP 2: Seed check');
  const db = getDb();

  const subjectCount = await db.execute({
    sql: `SELECT COUNT(DISTINCT category || '|' || section || '|' || subject) AS c FROM chapter_pool`,
    args: []
  });
  const existing = subjectCount.rows[0]?.c || 0;
  log(`Subjects in pool: ${existing} / ${SUBJECT_SEEDS.length}`);

  if (existing >= SUBJECT_SEEDS.length) { log('All seed subjects already in pool'); return; }

  let expanded = 0;
  for (const seed of SUBJECT_SEEDS) {
    if (expanded >= SEED_LIMIT_PER_RUN) {
      log(`Reached seed limit (${SEED_LIMIT_PER_RUN}) — remaining next run`);
      break;
    }

    const hasChapters = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM chapter_pool WHERE category = ? AND section = ? AND subject = ?`,
      args: [seed.category, seed.section, seed.subject]
    });
    if ((hasChapters.rows[0]?.c || 0) > 0) continue;

    log(`🌱 Seeding: ${seed.category} → ${seed.section} → ${seed.subject}`);

    try {
      const chapters = await generateChapterList({
        category: seed.category, section: seed.section, subject: seed.subject,
        existingChapters: [], count: CHAPTERS_PER_SUBJECT
      });

      const now = Date.now();
      let inserted = 0;
      for (const ch of chapters) {
        try {
          const insertResult = await db.execute({
            sql: `INSERT OR IGNORE INTO chapter_pool (category, section, subject, chapter, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            args: [seed.category, seed.section, seed.subject, ch, now, now]
          });
          inserted += Number(insertResult?.rowsAffected || 0);
        } catch (e) { /* silent */ }
      }
      log(`   ✅ Added ${inserted} chapters`);
      expanded++;
    } catch (e) {
      log(`   ❌ Failed: ${e.message}`);
    }
  }

  log(`Seeding done. Expanded ${expanded} subjects this run.`);
}

async function ensureQueueHasTasks() {
  logSection('STEP 3: Queue check');
  const db = getDb();

  const pending = await db.execute({ sql: "SELECT COUNT(*) AS c FROM generation_tasks WHERE status = 'pending'", args: [] });
  const pendingCount = pending.rows[0]?.c || 0;
  log(`Pending tasks: ${pendingCount}`);

  if (pendingCount >= QUEUE_LOW_THRESHOLD) { log(`Queue has enough tasks`); return; }

  const pendingChapters = await db.execute({
    sql: `SELECT * FROM chapter_pool WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    args: [CHAPTERS_TO_QUEUE]
  });

  if (pendingChapters.rows.length > 0) {
    log(`Found ${pendingChapters.rows.length} pending chapters — queuing`);
    const now = Date.now();
    let queued = 0;
    for (const ch of pendingChapters.rows) {
      try {
        const taskInsert = await db.execute({
          sql: `INSERT INTO generation_tasks (category, section, subject, chapter, exam_type, difficulty, target_count, status, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, 'hard', ?, 'pending', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1 FROM generation_tasks
                  WHERE category = ? AND section = ? AND subject = ? AND chapter = ?
                    AND status IN ('pending', 'processing')
                )`,
          args: [ch.category, ch.section, ch.subject, ch.chapter, 'mixed', MCQS_PER_CHAPTER, now, now,
            ch.category, ch.section, ch.subject, ch.chapter]
        });
        if (Number(taskInsert?.rowsAffected || 0) > 0) {
          await db.execute({
            sql: `UPDATE chapter_pool SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'pending'`,
            args: [now, ch.id]
          });
          queued++;
        }
      } catch (e) { log(`   ⚠️ ${ch.chapter}: ${e.message}`); }
    }
    log(`✅ Queued ${queued} tasks`);
    return;
  }

  log(`Pool empty — asking AI for more chapters`);

  let chosenSeed = null;
  let minCount = Infinity;
  for (const seed of SUBJECT_SEEDS) {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM chapter_pool WHERE category = ? AND section = ? AND subject = ?`,
      args: [seed.category, seed.section, seed.subject]
    });
    const count = res.rows[0]?.c || 0;
    if (count < minCount) { minCount = count; chosenSeed = seed; }
  }

  if (!chosenSeed) { log('No seeds'); return; }
  log(`Expanding: ${chosenSeed.subject} (has ${minCount})`);

  const existingRes = await db.execute({
    sql: `SELECT chapter FROM chapter_pool WHERE category = ? AND section = ? AND subject = ?`,
    args: [chosenSeed.category, chosenSeed.section, chosenSeed.subject]
  });
  const existingChapters = existingRes.rows.map(r => r.chapter);

  let newChapters;
  try {
    newChapters = await generateChapterList({
      category: chosenSeed.category, section: chosenSeed.section, subject: chosenSeed.subject,
      existingChapters, count: CHAPTERS_PER_SUBJECT
    });
  } catch (e) { log(`❌ AI expansion failed: ${e.message}`); return; }

  log(`AI generated ${newChapters.length} new chapters`);
  const now = Date.now();
  let inserted = 0;
  for (const ch of newChapters) {
    try {
      const res = await db.execute({
        sql: `INSERT OR IGNORE INTO chapter_pool (category, section, subject, chapter, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        args: [chosenSeed.category, chosenSeed.section, chosenSeed.subject, ch, now, now]
      });
      if (res.rowsAffected > 0) inserted++;
    } catch (e) { /* silent */ }
  }
  log(`✅ Inserted ${inserted} new chapters`);

  if (inserted > 0) await ensureQueueHasTasks();
}

async function getTaskSavedCount(db, taskId) {
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS c FROM mcqs WHERE generation_task_id = ?',
    args: [Number(taskId)]
  });
  return Math.max(0, Number(result.rows?.[0]?.c || 0));
}

async function getChapterSavedCount(db, task) {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM mcqs
          WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
    args: [task.category, task.section, task.subject, task.chapter]
  });
  return Math.max(0, Number(result.rows?.[0]?.c || 0));
}

async function recoverStaleTasks() {
  const db = getDb();
  const cutoff = Date.now() - STALE_PROCESSING_MS;
  const stale = await db.execute({
    sql: `SELECT * FROM generation_tasks WHERE status = 'processing' AND updated_at < ? ORDER BY updated_at ASC LIMIT 100`,
    args: [cutoff]
  });
  for (const task of (stale.rows || [])) {
    const canRetry = Number(task.retry_count || 0) < MAX_TASK_ATTEMPTS;
    const now = Date.now();
    const savedForTask = await getTaskSavedCount(db, task.id);
    const chapterSaved = await getChapterSavedCount(db, task);
    await db.execute({
      sql: `UPDATE generation_tasks SET status = ?, generated_count = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
      args: [canRetry ? 'pending' : 'failed', savedForTask, 'Recovered stale task', now, task.id]
    });
    await db.execute({
      sql: `UPDATE chapter_pool SET status = ?, mcq_count = ?, updated_at = ? WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
      args: [canRetry ? 'in_progress' : 'failed', chapterSaved, now, task.category, task.section, task.subject, task.chapter]
    });
    log(`♻️ Recovered stale task #${task.id}: ${canRetry ? 'queued' : 'failed'}`);
  }
}

async function processTasks() {
  logSection(`STEP 4: Process up to ${TASKS_PER_RUN} tasks`);
  const db = getDb();
  let processed = 0, totalGenerated = 0, totalRejected = 0;

  for (let i = 0; i < TASKS_PER_RUN; i++) {
    const claim = await db.execute({
      sql: `UPDATE generation_tasks SET status = 'processing', retry_count = retry_count + 1, updated_at = ?
            WHERE id = (SELECT id FROM generation_tasks WHERE status = 'pending' ORDER BY updated_at ASC, created_at ASC LIMIT 1)
            RETURNING *`,
      args: [Date.now()]
    });

    const task = claim.rows?.[0];
    if (!task) { log(`No more tasks`); break; }

    log(`\n[${i + 1}/${TASKS_PER_RUN}] ${task.category} → ${task.section} → ${task.subject} → ${task.chapter}`);
    const t0 = Date.now();

    try {
      const taskSavedBefore = await getTaskSavedCount(db, task.id);
      const result = await generateFromScratch({
        category: task.category, section: task.section, subject: task.subject, chapter: task.chapter,
        exam_type: task.exam_type || 'mixed', difficulty: task.difficulty || 'hard',
        count: task.target_count || MCQS_PER_CHAPTER, taskId: task.id
      });

      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const taskSavedAfter = await getTaskSavedCount(db, task.id);
      const chapterSavedAfter = await getChapterSavedCount(db, task);
      const reconciledThisAttempt = Math.max(Number(result.count || 0), taskSavedAfter - taskSavedBefore);
      const reconciledResult = { ...result, count: reconciledThisAttempt };
      const outcome = computeTaskOutcome({ ...task, generated_count: taskSavedBefore }, reconciledResult, MAX_TASK_ATTEMPTS);
      const { insertedThisAttempt, retryable, taskStatus, chapterStatus, errorText, cumulativeGenerated } = outcome;

      await db.execute({
        sql: `UPDATE generation_tasks SET status = ?, generated_count = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        args: [taskStatus, cumulativeGenerated, errorText, Date.now(), task.id]
      });

      await db.execute({
        sql: `UPDATE chapter_pool SET status = ?, mcq_count = ?, updated_at = ?
              WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
        args: [chapterStatus, chapterSavedAfter, Date.now(), task.category, task.section, task.subject, task.chapter]
      });

      if (outcome.complete) {
        log(`  ✅ Saved: ${insertedThisAttempt} | Total: ${cumulativeGenerated} | Rejected: ${result.rejectedTotal} | ${dur}s`);
        totalGenerated += result.count || 0;
        totalRejected += result.rejectedTotal || 0;
      } else {
        if (insertedThisAttempt > 0) totalGenerated += insertedThisAttempt;
        totalRejected += result.rejectedTotal || 0;
        log(`  ⚠️ ${result.isPartial ? 'PARTIAL' : 'Failed'}: ${insertedThisAttempt} saved, cumulative ${cumulativeGenerated} | ${result.error || 'failed'} | ${dur}s`);
      }
      processed++;
    } catch (err) {
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  ❌ Exception: ${err.message} | ${dur}s`);

      const retryable = Number(task.retry_count || 0) < MAX_TASK_ATTEMPTS;
      const nextStatus = retryable ? 'pending' : 'failed';
      const nextChapterStatus = retryable ? 'in_progress' : 'failed';
      let taskSavedCount = Number(task.generated_count || 0);
      let chapterSavedCount = null;
      try { taskSavedCount = await getTaskSavedCount(db, task.id); } catch (e) { /* silent */ }
      try { chapterSavedCount = await getChapterSavedCount(db, task); } catch (e) { /* silent */ }
      await db.execute({
        sql: `UPDATE generation_tasks SET status = ?, generated_count = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        args: [nextStatus, taskSavedCount, safeDbError(err).message, Date.now(), task.id]
      });
      if (chapterSavedCount !== null) {
        await db.execute({
          sql: `UPDATE chapter_pool SET status = ?, mcq_count = ?, updated_at = ? WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
          args: [nextChapterStatus, chapterSavedCount, Date.now(), task.category, task.section, task.subject, task.chapter]
        });
      } else {
        await db.execute({
          sql: `UPDATE chapter_pool SET status = ?, updated_at = ? WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
          args: [nextChapterStatus, Date.now(), task.category, task.section, task.subject, task.chapter]
        });
      }
    }

    if (i < TASKS_PER_RUN - 1) await new Promise(r => setTimeout(r, 2000));
  }

  logSection('SUMMARY');
  log(`Processed: ${processed} | Saved: ${totalGenerated} | Rejected: ${totalRejected}`);
  return { processed, totalGenerated, totalRejected };
}

async function main() {
  const start = Date.now();
  logSection('MCQ AUTO-EXPANDING RUN');
  log(`Started: ${new Date().toISOString()}`);

  try {
    await checkConnection();
    await recoverStaleTasks();
    await seedSubjectsIfNeeded();
    await ensureQueueHasTasks();
    await processTasks();
  } catch (e) {
    console.error('\n❌ FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }

  log(`\n✅ Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('Unhandled:', e); process.exit(1); });
