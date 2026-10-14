-- ═══════════════════════════════════════════
-- MCQs — 4-Level Hierarchy
-- Category → Section → Subject → Chapter
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mcqs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  section TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  exam_type TEXT,
  difficulty TEXT DEFAULT 'medium',
  question_hi TEXT NOT NULL,
  question_en TEXT NOT NULL,
  option_a_hi TEXT NOT NULL,
  option_a_en TEXT NOT NULL,
  option_b_hi TEXT NOT NULL,
  option_b_en TEXT NOT NULL,
  option_c_hi TEXT NOT NULL,
  option_c_en TEXT NOT NULL,
  option_d_hi TEXT NOT NULL,
  option_d_en TEXT NOT NULL,
  answer INTEGER NOT NULL,
  explanation_hi TEXT,
  explanation_en TEXT,
  hash TEXT UNIQUE NOT NULL,
  fingerprint TEXT,
  quality_score REAL DEFAULT 0,
  is_gold INTEGER DEFAULT 0,
  source_url TEXT,
  retrieval_score REAL,
  random_key INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,
  parent_qid TEXT,
  attempt_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcqs_category ON mcqs(category);
CREATE INDEX IF NOT EXISTS idx_mcqs_section ON mcqs(category, section);
CREATE INDEX IF NOT EXISTS idx_mcqs_subject ON mcqs(category, section, subject);
CREATE INDEX IF NOT EXISTS idx_mcqs_chapter ON mcqs(category, section, subject, chapter);
CREATE INDEX IF NOT EXISTS idx_mcqs_hash ON mcqs(hash);
CREATE INDEX IF NOT EXISTS idx_mcqs_fingerprint ON mcqs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_mcqs_random ON mcqs(category, section, subject, chapter, random_key);

-- ═══════════════════════════════════════════
-- ⭐ Chapter Pool (AI-generated chapters)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chapter_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  section TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  mcq_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(category, section, subject, chapter)
);
CREATE INDEX IF NOT EXISTS idx_chapter_pool_status ON chapter_pool(status);
CREATE INDEX IF NOT EXISTS idx_chapter_pool_subject ON chapter_pool(category, section, subject);

-- ═══════════════════════════════════════════
-- Generation tasks
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS generation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  section TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  exam_type TEXT,
  difficulty TEXT DEFAULT 'hard',
  target_count INTEGER NOT NULL,
  generated_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gen_tasks_status ON generation_tasks(status, created_at);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  details TEXT,
  timestamp INTEGER NOT NULL
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  nonce TEXT,
  submitted INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Rate limits
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Results
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  category TEXT,
  section TEXT,
  subject TEXT,
  chapter TEXT NOT NULL,
  qid TEXT NOT NULL,
  selected INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Source cache
CREATE TABLE IF NOT EXISTS source_cache (
  cache_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Admin nonces
CREATE TABLE IF NOT EXISTS admin_nonces (
  nonce TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- Bundles
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  section TEXT,
  subject TEXT,
  chapter TEXT NOT NULL,
  bundle_name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(chapter, bundle_name)
);

-- Telegram
CREATE TABLE IF NOT EXISTS telegram_log (
  id TEXT PRIMARY KEY,
  event TEXT,
  sent_at INTEGER NOT NULL
);

-- Schema migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  rollback_sql TEXT
);

-- AI Learning loop
CREATE TABLE IF NOT EXISTS learn_good (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mcq_id TEXT,
  pattern TEXT,
  score REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_good_score ON learn_good(score DESC);

CREATE TABLE IF NOT EXISTS learn_bad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rejected_question TEXT,
  reason TEXT,
  score REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_bad_id ON learn_bad(id DESC);

-- API keys (optional)
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE,
  provider TEXT,
  calls_today INTEGER DEFAULT 0,
  calls_total INTEGER DEFAULT 0,
  last_reset INTEGER,
  status TEXT DEFAULT 'active',
  last_used INTEGER
);

-- User interactions
CREATE TABLE IF NOT EXISTS user_saved (
  user_id TEXT NOT NULL,
  mcq_id TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mcq_id)
);
CREATE INDEX IF NOT EXISTS idx_user_saved_user ON user_saved(user_id);

CREATE TABLE IF NOT EXISTS user_seen (
  user_id TEXT NOT NULL,
  mcq_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mcq_id)
);
CREATE INDEX IF NOT EXISTS idx_user_seen_user ON user_seen(user_id);
CREATE INDEX IF NOT EXISTS idx_user_seen_time ON user_seen(seen_at);
