CREATE TABLE IF NOT EXISTS mcqs (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, section TEXT NOT NULL, subject TEXT NOT NULL, chapter TEXT NOT NULL,
  exam_type TEXT, difficulty TEXT DEFAULT 'medium', question_hi TEXT NOT NULL, question_en TEXT NOT NULL,
  option_a_hi TEXT NOT NULL, option_a_en TEXT NOT NULL, option_b_hi TEXT NOT NULL, option_b_en TEXT NOT NULL,
  option_c_hi TEXT NOT NULL, option_c_en TEXT NOT NULL, option_d_hi TEXT NOT NULL, option_d_en TEXT NOT NULL,
  answer INTEGER NOT NULL CHECK (answer BETWEEN 0 AND 3), explanation_hi TEXT, explanation_en TEXT,
  hash TEXT UNIQUE NOT NULL, fingerprint TEXT, trigram_sig TEXT, word_set_fp TEXT,
  quality_score REAL DEFAULT 0, is_gold INTEGER DEFAULT 0, source_url TEXT,
  audit_status TEXT NOT NULL DEFAULT 'pending', audit_notes TEXT, audit_checked_at INTEGER,
  retrieval_score REAL, random_key INTEGER DEFAULT 0, version INTEGER DEFAULT 1, parent_qid TEXT,
  generation_task_id INTEGER, is_disabled INTEGER NOT NULL DEFAULT 0, trigram_version INTEGER,
  structural_checked_at INTEGER, attempt_count INTEGER DEFAULT 0, correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcqs_chapter ON mcqs(category, section, subject, chapter);
CREATE INDEX IF NOT EXISTS idx_mcqs_hash ON mcqs(hash);
CREATE INDEX IF NOT EXISTS idx_mcqs_audit ON mcqs(audit_status, created_at DESC);

CREATE TABLE IF NOT EXISTS chapter_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, section TEXT NOT NULL, subject TEXT NOT NULL, chapter TEXT NOT NULL,
  status TEXT DEFAULT 'pending', mcq_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(category, section, subject, chapter)
);

CREATE TABLE IF NOT EXISTS generation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, section TEXT NOT NULL, subject TEXT NOT NULL, chapter TEXT NOT NULL,
  exam_type TEXT, difficulty TEXT DEFAULT 'hard', target_count INTEGER NOT NULL, generated_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_tasks_status ON generation_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS learn_good (id INTEGER PRIMARY KEY AUTOINCREMENT, mcq_id TEXT, pattern TEXT, score REAL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learn_bad (id INTEGER PRIMARY KEY AUTOINCREMENT, rejected_question TEXT, reason TEXT, score REAL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS knowledge_base (
  chapter_key TEXT PRIMARY KEY, subject TEXT NOT NULL, chapter TEXT NOT NULL, source_url TEXT NOT NULL,
  extracted_text TEXT NOT NULL, extraction_method TEXT NOT NULL DEFAULT 'unknown', downloaded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_host_state (
  host TEXT PRIMARY KEY, robots_policy_json TEXT, robots_fetched_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcq_answer_stats (qid TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0, is_disabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS mcq_quality_flags (
  qid TEXT PRIMARY KEY, quality_status TEXT NOT NULL DEFAULT 'active', flag_reason TEXT, flagged_at INTEGER,
  ai_recheck_status TEXT NOT NULL DEFAULT 'not_run', ai_recheck_at INTEGER, details_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pyq_bank (
  id TEXT PRIMARY KEY, category TEXT, section TEXT, subject TEXT, chapter TEXT, exam_name TEXT, exam_year INTEGER,
  question_en TEXT, question_number TEXT, question_hi TEXT, option_a_en TEXT, option_b_en TEXT, option_c_en TEXT, option_d_en TEXT,
  option_a_hi TEXT, option_b_hi TEXT, option_c_hi TEXT, option_d_hi TEXT, correct_answer INTEGER, difficulty TEXT, topics TEXT,
  source_url TEXT, source_page INTEGER, extraction_method TEXT, verified_at INTEGER, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pyq_usage (pyq_id TEXT, mcq_id TEXT, generated_at INTEGER, PRIMARY KEY(pyq_id, mcq_id));
CREATE TABLE IF NOT EXISTS pyq_ingest_state (state_key TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
