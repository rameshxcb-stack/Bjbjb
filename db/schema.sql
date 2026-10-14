-- ═══════════════════════════════════════════
-- MCQs
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mcqs (
  id TEXT PRIMARY KEY,
  exam_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  topic TEXT,
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
  fingerprint TEXT,               -- sorted keywords
  ordered_fp TEXT,                -- ⭐ NEW: order-preserved
  trigram_fp TEXT,                -- ⭐ NEW: 8 minhash sigs (comma-sep)
  option_fp TEXT,                 -- ⭐ NEW: options fingerprint
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

CREATE INDEX IF NOT EXISTS idx_mcqs_chapter ON mcqs(chapter);
CREATE INDEX IF NOT EXISTS idx_mcqs_exam ON mcqs(exam_type);
CREATE INDEX IF NOT EXISTS idx_mcqs_hash ON mcqs(hash);
CREATE INDEX IF NOT EXISTS idx_mcqs_fingerprint ON mcqs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_mcqs_ordered_fp ON mcqs(ordered_fp);
CREATE INDEX IF NOT EXISTS idx_mcqs_trigram_fp ON mcqs(trigram_fp);
CREATE INDEX IF NOT EXISTS idx_mcqs_option_fp ON mcqs(option_fp);
CREATE INDEX IF NOT EXISTS idx_mcqs_chapter_random ON mcqs(chapter, random_key);
CREATE INDEX IF NOT EXISTS idx_mcqs_subject_random ON mcqs(subject, random_key);
CREATE INDEX IF NOT EXISTS idx_mcqs_chapter_created ON mcqs(chapter, created_at DESC);

-- ═══════════════════════════════════════════
-- MinHash signatures (fast lookup table)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mcq_signatures (
  mcq_id TEXT NOT NULL,
  sig_index INTEGER NOT NULL,     -- 0..7
  sig_value INTEGER NOT NULL,
  PRIMARY KEY (mcq_id, sig_index)
);
CREATE INDEX IF NOT EXISTS idx_sig_lookup ON mcq_signatures(sig_index, sig_value);

-- ═══════════════════════════════════════════
-- Generation tasks
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS generation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  topic TEXT,
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

-- Bundle metadata
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter TEXT NOT NULL,
  bundle_name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(chapter, bundle_name)
);

-- Telegram alert dedup
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

-- ═══════════════════════════════════════════
-- AI Learning Loop
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS learn_good (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mcq_id TEXT,
  pattern TEXT,
  score REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_good_score ON learn_good(score DESC);
CREATE INDEX IF NOT EXISTS idx_learn_good_time ON learn_good(created_at DESC);

CREATE TABLE IF NOT EXISTS learn_bad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rejected_question TEXT,
  reason TEXT,
  score REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_bad_id ON learn_bad(id DESC);

-- ═══════════════════════════════════════════
-- API Keys
-- ═══════════════════════════════════════════
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

-- ═══════════════════════════════════════════
-- User interactions
-- ═══════════════════════════════════════════
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
