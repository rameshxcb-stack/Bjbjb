// ============================================================
// scripts/generate.js
// Auto-expanding MCQ generator
// Ek chapter khatam → next chapter → next subject → AI generates more
// ============================================================

import { getDb, diagnoseTurso, safeDbError } from '../lib/db.js';
import { generateFromScratch, generateChapterList } from '../lib/mcq-engine.js';

// ============================================================
// CONFIG
// ============================================================
const TASKS_PER_RUN = parseInt(process.env.TASKS_PER_RUN || '3');
const CHAPTERS_PER_SUBJECT = parseInt(process.env.CHAPTERS_PER_SUBJECT || '20');
const MCQS_PER_CHAPTER = parseInt(process.env.MCQS_PER_CHAPTER || '10');
const QUEUE_LOW_THRESHOLD = 5;
const CHAPTERS_TO_QUEUE = 10;

// ============================================================
// SEED SUBJECTS
// ============================================================
const SUBJECT_SEEDS = [
  // UPSC / State PCS
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

  // JEE
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

  // NEET
  { category: 'NEET Biology', section: 'Human Physiology', subject: 'Digestive System' },
  { category: 'NEET Biology', section: 'Human Physiology', subject: 'Circulatory System' },
  { category: 'NEET Biology', section: 'Genetics', subject: 'Mendelian Genetics' },
  { category: 'NEET Biology', section: 'Cell Biology', subject: 'Cell Structure' },
  { category: 'NEET Biology', section: 'Plant Physiology', subject: 'Photosynthesis' },

  // SSC
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

  // Banking
  { category: 'Banking Reasoning', section: 'Logical', subject: 'Puzzles' },
  { category: 'Banking Reasoning', section: 'Logical', subject: 'Seating Arrangement' },
  { category: 'Banking Quantitative Aptitude', section: 'Arithmetic', subject: 'Profit & Loss' },
  { category: 'Banking Quantitative Aptitude', section: 'Arithmetic', subject: 'Time & Work' },
  { category: 'Banking English', section: 'Comprehension', subject: 'Reading Comprehension' },
  { category: 'Banking Awareness', section: 'Banking', subject: 'RBI Functions' },
  { category: 'Banking Awareness', section: 'Banking', subject: 'Banking Terminology' },

  // Railway
  { category: 'Railway Exams', section: 'Technical', subject: 'Basic Electricity' },
  { category: 'Railway Exams', section: 'Technical', subject: 'Basic Mechanics' },
  { category: 'Railway Exams', section: 'General', subject: 'General Science' },

  // Defense
  { category: 'Defense Exams', section: 'NDA', subject: 'Mathematics' },
  { category: 'Defense Exams', section: 'NDA', subject: 'General Ability' },

  // Teaching
  { category: 'Teaching & Eligibility Exams', section: 'CTET', subject: 'Child Development' },
  { category: 'Teaching & Eligibility Exams', section: 'CTET', subject: 'Pedagogy' },

  // Law
  { category: 'Law & Judicial Exams', section: 'CLAT', subject: 'Legal Reasoning' },
  { category: 'Law & Judicial Exams', section: 'CLAT', subject: 'Logical Reasoning' },

  // Jharkhand
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand History' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand Geography' },
  { category: 'Jharkhand State Exams', section: 'JPSC', subject: 'Jharkhand Polity' },
  { category: 'Jharkhand State Exams', section: 'JSSC', subject: 'General Studies' },
];

// ============================================================
// LOGGER
// ============================================================
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

// ============================================================
// STEP 1: Check Turso
// ============================================================
async function checkConnection() {
  logSection('STEP 1: Turso connection');
  const r = await diagnoseTurso();
  if (!r.success) {
    console.error('❌ DB failed:', r.error, r.message);
    process.exit(1);
  }
  log(`✅ Connected to ${r.diagnostics.urlHost}`);
}

// ============================================================
// STEP 2: Seed subjects
// ============================================================
async function seedSubjectsIfNeeded() {
  logSection('STEP 2: Seed check');

  const db = getDb();

  const subjectCount = await db.execute({
    sql: `SELECT COUNT(DISTINCT category || '|' || section || '|' || subject) AS c FROM chapter_pool`,
    args: []
  });
  const existing = subjectCount.rows[0]?.c || 0;

  log(`Subjects in pool: ${existing} / ${SUBJECT_SEEDS.length}`);

  if (existing >= SUBJECT_SEEDS.length) {
    log('All seed subjects already in pool — skipping seed');
    return;
  }

  let expanded = 0;

  for (const seed of SUBJECT_SEEDS) {
    const hasChapters = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM chapter_pool 
            WHERE category = ? AND section = ? AND subject = ?`,
      args: [seed.category, seed.section, seed.subject]
    });

    if ((hasChapters.rows[0]?.c || 0) > 0) continue;

    log(`🌱 Seeding: ${seed.category} → ${seed.section} → ${seed.subject}`);

    try {
      const chapters = await generateChapterList({
        category: seed.category,
        section: seed.section,
        subject: seed.subject,
        existingChapters: [],
        count: CHAPTERS_PER_SUBJECT
      });

      const now = Date.now();
      let inserted = 0;

      for (const ch of chapters) {
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO chapter_pool 
                  (category, section, subject, chapter, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            args: [seed.category, seed.section, seed.subject, ch, now, now]
          });
          inserted++;
        } catch (e) { /* silent */ }
      }

      log(`   ✅ Added ${inserted} chapters`);
      expanded++;
    } catch (e) {
      log(`   ❌ Failed: ${e.message}`);
    }
  }

  log(`Seeding done. Expanded ${expanded} subjects.`);
}

// ============================================================
// STEP 3: Ensure queue has tasks
// ============================================================
async function ensureQueueHasTasks() {
  logSection('STEP 3: Queue check');

  const db = getDb();

  const pending = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM generation_tasks WHERE status = 'pending'",
    args: []
  });
  const pendingCount = pending.rows[0]?.c || 0;
  log(`Pending tasks: ${pendingCount}`);

  if (pendingCount >= QUEUE_LOW_THRESHOLD) {
    log(`Queue has enough tasks — no expansion needed`);
    return;
  }

  const pendingChapters = await db.execute({
    sql: `SELECT * FROM chapter_pool 
          WHERE status = 'pending' 
          ORDER BY created_at ASC 
          LIMIT ?`,
    args: [CHAPTERS_TO_QUEUE]
  });

  if (pendingChapters.rows.length > 0) {
    log(`Found ${pendingChapters.rows.length} pending chapters in pool — queuing as tasks`);

    const now = Date.now();
    let queued = 0;

    for (const ch of pendingChapters.rows) {
      try {
        await db.execute({
          sql: `INSERT INTO generation_tasks 
                (category, section, subject, chapter, exam_type, difficulty, target_count, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'hard', ?, 'pending', ?, ?)`,
          args: [ch.category, ch.section, ch.subject, ch.chapter, 'mixed', MCQS_PER_CHAPTER, now, now]
        });
        await db.execute({
          sql: `UPDATE chapter_pool SET status = 'in_progress', updated_at = ? WHERE id = ?`,
          args: [now, ch.id]
        });
        queued++;
      } catch (e) {
        log(`   ⚠️ Queue failed for ${ch.chapter}: ${e.message}`);
      }
    }

    log(`✅ Queued ${queued} tasks from pool`);
    return;
  }

  log(`Pool is empty of pending chapters — asking AI for more`);

  let chosenSeed = null;
  let minCount = Infinity;

  for (const seed of SUBJECT_SEEDS) {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM chapter_pool 
            WHERE category = ? AND section = ? AND subject = ?`,
      args: [seed.category, seed.section, seed.subject]
    });
    const count = res.rows[0]?.c || 0;
    if (count < minCount) {
      minCount = count;
      chosenSeed = seed;
    }
  }

  if (!chosenSeed) {
    log('No seed subjects found — cannot expand');
    return;
  }

  log(`Chosen to expand: ${chosenSeed.category} → ${chosenSeed.section} → ${chosenSeed.subject} (has ${minCount} chapters)`);

  const existingRes = await db.execute({
    sql: `SELECT chapter FROM chapter_pool 
          WHERE category = ? AND section = ? AND subject = ?`,
    args: [chosenSeed.category, chosenSeed.section, chosenSeed.subject]
  });
  const existingChapters = existingRes.rows.map(r => r.chapter);

  let newChapters;
  try {
    newChapters = await generateChapterList({
      category: chosenSeed.category,
      section: chosenSeed.section,
      subject: chosenSeed.subject,
      existingChapters,
      count: CHAPTERS_PER_SUBJECT
    });
  } catch (e) {
    log(`❌ AI expansion failed: ${e.message}`);
    return;
  }

  log(`AI generated ${newChapters.length} new chapters`);

  const now = Date.now();
  let inserted = 0;

  for (const ch of newChapters) {
    try {
      const res = await db.execute({
        sql: `INSERT OR IGNORE INTO chapter_pool 
              (category, section, subject, chapter, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        args: [chosenSeed.category, chosenSeed.section, chosenSeed.subject, ch, now, now]
      });
      if (res.rowsAffected > 0) inserted++;
    } catch (e) { /* silent */ }
  }

  log(`✅ Inserted ${inserted} new chapters`);

  if (inserted > 0) {
    await ensureQueueHasTasks();
  }
}

// ============================================================
// STEP 4: Process tasks
// ============================================================
async function processTasks() {
  logSection(`STEP 4: Process up to ${TASKS_PER_RUN} tasks`);

  const db = getDb();
  let processed = 0, totalGenerated = 0, totalRejected = 0;

  for (let i = 0; i < TASKS_PER_RUN; i++) {
    const claim = await db.execute({
      sql: `UPDATE generation_tasks
            SET status = 'processing', retry_count = retry_count + 1, updated_at = ?
            WHERE id = (
              SELECT id FROM generation_tasks 
              WHERE status = 'pending'
              ORDER BY created_at ASC 
              LIMIT 1
            )
            RETURNING *`,
      args: [Date.now()]
    });

    const task = claim.rows?.[0];
    if (!task) {
      log(`No more pending tasks. Stopping at ${i}`);
      break;
    }

    log(`\n[${i + 1}/${TASKS_PER_RUN}] ${task.category} → ${task.section} → ${task.subject} → ${task.chapter}`);
    const t0 = Date.now();

    try {
      const result = await generateFromScratch({
        category: task.category,
        section: task.section,
        subject: task.subject,
        chapter: task.chapter,
        exam_type: task.exam_type || 'mixed',
        difficulty: task.difficulty || 'hard',
        count: task.target_count || MCQS_PER_CHAPTER
      });

      const dur = ((Date.now() - t0) / 1000).toFixed(1);

      await db.execute({
        sql: `UPDATE generation_tasks 
              SET status = ?, generated_count = ?, last_error = ?, updated_at = ?
              WHERE id = ?`,
        args: [
          result.success ? 'done' : 'failed',
          result.count || 0,
          result.success ? null : (result.error || 'failed'),
          Date.now(),
          task.id
        ]
      });

      await db.execute({
        sql: `UPDATE chapter_pool 
              SET status = ?, mcq_count = mcq_count + ?, updated_at = ?
              WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
        args: [
          result.success ? 'done' : 'failed',
          result.count || 0,
          Date.now(),
          task.category, task.section, task.subject, task.chapter
        ]
      });

      if (result.success) {
        log(`  ✅ Saved: ${result.count} | Rejected: ${result.rejectedTotal} | ${dur}s`);
        totalGenerated += result.count || 0;
        totalRejected += result.rejectedTotal || 0;
      } else {
        log(`  ❌ Failed: ${result.error || result.message} | ${dur}s`);
      }

      processed++;
    } catch (err) {
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      log(`  ❌ Exception: ${err.message} | ${dur}s`);

      await db.execute({
        sql: `UPDATE generation_tasks 
              SET status = 'failed', last_error = ?, updated_at = ?
              WHERE id = ?`,
        args: [safeDbError(err).message, Date.now(), task.id]
      });

      await db.execute({
        sql: `UPDATE chapter_pool 
              SET status = 'failed', updated_at = ?
              WHERE category = ? AND section = ? AND subject = ? AND chapter = ?`,
        args: [Date.now(), task.category, task.section, task.subject, task.chapter]
      });
    }

    if (i < TASKS_PER_RUN - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logSection('SUMMARY');
  log(`Tasks processed: ${processed}`);
  log(`MCQs saved: ${totalGenerated}`);
  log(`MCQs rejected: ${totalRejected}`);

  return { processed, totalGenerated, totalRejected };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const start = Date.now();

  logSection('MCQ AUTO-EXPANDING RUN');
  log(`Started: ${new Date().toISOString()}`);
  log(`Config: ${TASKS_PER_RUN} tasks/run, ${CHAPTERS_PER_SUBJECT} chapters/subject, ${MCQS_PER_CHAPTER} MCQs/chapter`);

  try {
    await checkConnection();
    await seedSubjectsIfNeeded();
    await ensureQueueHasTasks();
    await processTasks();
  } catch (e) {
    console.error('\n❌ FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }

  log(`\n✅ Run complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error('Unhandled:', e);
  process.exit(1);
});
