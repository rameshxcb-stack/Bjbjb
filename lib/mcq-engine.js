// ============================================================
// lib/mcq-engine.js — Full AI Pipeline with 4-Layer Uniqueness
// Quality Gate: 90+ | Golden: 99+ | Exam pattern fetch
// ============================================================

import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { getDb, safeDbError } from './db.js';

// ==========================================
// CONFIG
// ==========================================
const QUALITY_GATE = 90;
const GOLD_THRESHOLD = 99;
const LEARN_GOOD_THRESHOLD = 90;
const PATTERN_CACHE_TTL = 24 * 60 * 60 * 1000;
const GOLDEN_EXAMPLES_COUNT = 8;

const BATCH_CONCURRENCY = 5;
const BATCH_DELAY_MS = 1500;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const DISABLED_KEY_COOLDOWN = 5 * 60 * 1000;
const MIN_EVIDENCE_LENGTH = 200;
const FINGERPRINT_WORDS = 15;

const TRIGRAM_SIMILARITY_THRESHOLD = 0.75;
const WORDSET_SIMILARITY_THRESHOLD = 0.80;
const RECENT_QUESTIONS_FOR_PROMPT = 30;
const RECENT_QUESTIONS_TO_CHECK = 200;
const TRIGRAM_HASHES = 32;

let cachedGeminiModels = { data: null, timestamp: 0 };
let cachedDeepSeekModel = { data: null, timestamp: 0 };
const disabledKeys = new Map();

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','and','or','but',
  'if','then','than','of','in','on','at','to','for','from','with','without',
  'by','as','into','about','over','which','who','whom','whose','that','this',
  'these','those','what','when','where','why','how','all','any','both','each',
  'few','more','most','other','some','such','no','nor','not','only','own',
  'same','so','too','very','can','will','just',
  'है','हैं','का','की','के','को','से','में','पर','और','या','यह','वह','ये','वे',
  'कौन','क्या','कब','कहाँ','कैसे'
]);

// ==========================================
// ZOD SCHEMAS
// ==========================================
const RawMCQSchema = z.object({
  question_hi: z.string().min(10),
  question_en: z.string().min(10),
  option_a_hi: z.string().min(1),
  option_a_en: z.string().min(1),
  option_b_hi: z.string().min(1),
  option_b_en: z.string().min(1),
  option_c_hi: z.string().min(1),
  option_c_en: z.string().min(1),
  option_d_hi: z.string().min(1),
  option_d_en: z.string().min(1),
  answer: z.union([z.number().int().min(0).max(3), z.string().trim().min(1)]),
  difficulty: z.string().optional().default('medium'),
  explanation_hi: z.string().optional().default(''),
  explanation_en: z.string().optional().default('')
});

const AIJudgeResultSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(100),
  options_quality: z.number().min(0).max(100),
  question_quality: z.number().min(0).max(100),
  explanation_valid: z.boolean(),
  contradiction: z.boolean(),
  evidence_sufficient: z.boolean(),
  unique_correct_option: z.boolean(),
  ambiguous: z.boolean(),
  reason: z.string().optional()
});

const ChapterMatchSchema = z.object({
  belongs: z.boolean(),
  actual_chapter: z.string().optional(),
  confidence: z.number().min(0).max(100).optional().default(50)
});

const ChapterListSchema = z.object({
  chapters: z.array(z.string().min(3)).min(3).max(50)
});

// ==========================================
// KEY ROTATION
// ==========================================
function getRandomKey(envVarName) {
  const rawKeys = (process.env[envVarName] ?? '').split(',').map(k => k.trim()).filter(Boolean);
  if (rawKeys.length === 0) return null;
  const now = Date.now();
  const activeKeys = rawKeys.filter(key => {
    const disabledUntil = disabledKeys.get(key);
    if (disabledUntil && now < disabledUntil) return false;
    if (disabledUntil && now >= disabledUntil) disabledKeys.delete(key);
    return true;
  });
  return activeKeys.length > 0
    ? activeKeys[Math.floor(Math.random() * activeKeys.length)]
    : rawKeys[Math.floor(Math.random() * rawKeys.length)];
}

function markKeyAsRateLimited(key) {
  if (key) disabledKeys.set(key, Date.now() + DISABLED_KEY_COOLDOWN);
}

async function fetchWithRetry(resource, options = {}, retries = 3, backoffMs = 1000) {
  const { timeout = 20000, apiKeyUsed = null, ...fetchOptions } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(resource, { ...fetchOptions, signal: controller.signal });
      clearTimeout(id);
      if (response.status === 429) {
        markKeyAsRateLimited(apiKeyUsed);
        if (attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30000)
            : backoffMs * Math.pow(2, attempt - 1);
          await new Promise(res => setTimeout(res, delay));
          continue;
        }
      }
      if ([500, 502, 503, 504].includes(response.status) && attempt < retries) {
        await new Promise(res => setTimeout(res, backoffMs * Math.pow(2, attempt - 1)));
        continue;
      }
      if (response.status === 403) markKeyAsRateLimited(apiKeyUsed);
      return response;
    } catch (err) {
      clearTimeout(id);
      if (attempt === retries) throw err;
      await new Promise(res => setTimeout(res, backoffMs * Math.pow(2, attempt - 1)));
    }
  }
}

// ==========================================
// UTILITIES
// ==========================================
function cleanJSONString(text) {
  if (!text) return '';
  const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (m) return m[0];
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function safeJsonParseAndValidate(text, schema, ctx = 'API') {
  if (!text) throw new Error(`[${ctx}] Empty response`);
  const cleaned = cleanJSONString(text);
  if (!cleaned) throw new Error(`[${ctx}] No JSON found`);
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
    const v = schema.safeParse(parsed);
    if (!v.success) throw new Error(`Schema: ${v.error.issues.map(i => i.message).join(', ')}`);
    return v.data;
  } catch (err) {
    throw new Error(`[${ctx}] ${err.message}`);
  }
}

function normalizeMCQText(text) {
  if (!text) return '';
  return text.toString().toLowerCase().trim().replace(/[^\w\s\u0900-\u097F]/gi, '').replace(/\s+/g, ' ');
}

function makeFingerprint(en, hi) {
  const combined = `${en || ''} ${hi || ''}`;
  const words = normalizeMCQText(combined).split(/\s+/).filter(w => w.length > 3).filter(w => !STOPWORDS.has(w));
  const unique = [...new Set(words)].sort();
  return unique.slice(0, FINGERPRINT_WORDS).join('|');
}

function chunkArray(arr, size) {
  if (!Array.isArray(arr)) return [];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ==========================================
// UNIQUENESS — Trigram MinHash
// ==========================================
function hashString(str) {
  return createHash('sha256').update(String(str)).digest().readUInt32BE(0);
}

function makeTrigrams(text) {
  const norm = normalizeMCQText(text).replace(/\s+/g, ' ');
  const grams = new Set();
  for (let i = 0; i < norm.length - 2; i++) {
    grams.add(norm.substring(i, i + 3));
  }
  return [...grams];
}

export function makeTrigramSignature(text, numHashes = TRIGRAM_HASHES) {
  const grams = makeTrigrams(text);
  if (grams.length === 0) return '';

  const sigs = new Array(numHashes).fill(Infinity);

  for (const gram of grams) {
    for (let i = 0; i < numHashes; i++) {
      const h = hashString(`${i}:${gram}`);
      if (h < sigs[i]) sigs[i] = h;
    }
  }

  return sigs.join(',');
}

function signatureSimilarity(sigA, sigB) {
  if (!sigA || !sigB) return 0;
  const a = sigA.split(',').map(Number);
  const b = sigB.split(',').map(Number);
  const length = Math.min(a.length, b.length);
  if (length === 0 || a.some(Number.isNaN) || b.some(Number.isNaN)) return 0;
  let matches = 0;
  for (let i = 0; i < length; i++) if (a[i] === b[i]) matches++;
  return matches / length;
}

// ==========================================
// UNIQUENESS — Word-set fingerprint
// ==========================================
export function makeWordSetFp(text) {
  const norm = normalizeMCQText(text).replace(/\s+/g, ' ');
  const words = norm.split(' ').filter(w => w.length > 3).filter(w => !STOPWORDS.has(w));
  const unique = [...new Set(words)].sort();
  return unique.slice(0, 30).join('|');
}

function wordSetSimilarity(fpA, fpB) {
  if (!fpA || !fpB) return 0;
  const a = new Set(fpA.split('|'));
  const b = new Set(fpB.split('|'));
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;

  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// ==========================================
// Get recent questions from chapter
// ==========================================
async function getRecentQuestionsFromChapter(category, section, subject, chapter, limit = RECENT_QUESTIONS_FOR_PROMPT) {
  try {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT question_en FROM mcqs 
            WHERE category = ? AND section = ? AND subject = ? AND chapter = ?
            ORDER BY created_at DESC LIMIT ?`,
      args: [category, section, subject, chapter, limit]
    });
    return res.rows.map(r => r.question_en).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ==========================================
// ⭐ Golden MCQs (99+) for prompt reference
// ==========================================
async function loadGoldenMCQs(category, section, subject, chapter, limit = GOLDEN_EXAMPLES_COUNT) {
  try {
    const db = getDb();

    let res = await db.execute({
      sql: `SELECT question_en, question_hi,
                   option_a_en, option_b_en, option_c_en, option_d_en,
                   answer, explanation_en, quality_score
            FROM mcqs
            WHERE category = ? AND section = ? AND subject = ? AND chapter = ?
              AND is_gold = 1
            ORDER BY quality_score DESC
            LIMIT ?`,
      args: [category, section, subject, chapter, limit]
    });

    if (res.rows.length < limit) {
      const broader = await db.execute({
        sql: `SELECT question_en, question_hi,
                     option_a_en, option_b_en, option_c_en, option_d_en,
                     answer, explanation_en, quality_score
              FROM mcqs
              WHERE category = ? AND section = ? AND subject = ?
                AND is_gold = 1
                AND chapter != ?
              ORDER BY quality_score DESC
              LIMIT ?`,
        args: [category, section, subject, chapter, limit - res.rows.length]
      });
      res.rows.push(...broader.rows);
    }

    return res.rows.map(r => ({
      question_en: r.question_en,
      question_hi: r.question_hi,
      options: [r.option_a_en, r.option_b_en, r.option_c_en, r.option_d_en],
      answer: r.answer,
      explanation_en: r.explanation_en,
      score: r.quality_score
    }));
  } catch (e) {
    console.warn('[GOLDEN] Failed to load:', e.message);
    return [];
  }
}

// ==========================================
// ⭐ Fetch latest exam pattern from internet
// ==========================================
async function fetchExamPattern(exam_type, subject) {
  const cacheKey = `${exam_type}_${subject || 'general'}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const db = getDb();

  try {
    const cached = await db.execute({
      sql: 'SELECT pattern_text, fetched_at FROM exam_pattern_cache WHERE cache_key = ?',
      args: [cacheKey]
    });
    if (cached.rows.length > 0 && (Date.now() - cached.rows[0].fetched_at) < PATTERN_CACHE_TTL) {
      console.log(`[PATTERN] Cache hit: ${cacheKey}`);
      return cached.rows[0].pattern_text;
    }
  } catch (e) { /* silent */ }

  const year = new Date().getFullYear();
  const prevYear = year - 1;
  const searchQuery = `${exam_type} ${prevYear} question paper pattern difficulty analysis`;

  console.log(`[PATTERN] Fetching: ${searchQuery}`);

  let patternText = null;

  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const ddgRes = await fetch(ddgUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    clearTimeout(timeout);

    if (ddgRes?.ok) {
      const html = await ddgRes.text();
      if (!html.toLowerCase().includes('captcha')) {
        const matches = html.match(/uddg=([^&"']+)/g);
        if (matches && matches.length > 0) {
          const targetUrl = decodeURIComponent(matches[0].replace('uddg=', ''));

          const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: { 'X-No-Cache': 'true' }
          });

          if (jinaRes?.ok) {
            const text = await jinaRes.text();
            if (text && text.length > 300) {
              const cleaned = text
                .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
                .replace(/https?:\/\/\S+/g, '')
                .replace(/[#*`_~]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              patternText = cleaned.substring(0, 2500);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[PATTERN] DDG failed:', e.message);
  }

  if (!patternText) {
    try {
      const aiPattern = await callGeminiForJudge(
        `You are an exam expert. Describe the question paper pattern, style, and difficulty for ${exam_type} ${subject ? `(${subject})` : ''} based on recent years (${prevYear}-${year}).

Include:
1. Question format (single statement, multi-statement, match the following)
2. Difficulty level
3. Typical option patterns
4. Trap patterns used by exam setters
5. Topic distribution

Return a brief 200-word summary only.`
      );
      patternText = typeof aiPattern === 'string' ? aiPattern : JSON.stringify(aiPattern).slice(0, 2000);
    } catch (e) {
      console.warn('[PATTERN] AI fallback failed:', e.message);
    }
  }

  if (patternText) {
    try {
      await db.execute({
        sql: `INSERT INTO exam_pattern_cache (cache_key, exam_type, subject, pattern_text, fetched_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(cache_key) DO UPDATE SET
              pattern_text = excluded.pattern_text,
              fetched_at = excluded.fetched_at`,
        args: [cacheKey, exam_type, subject || null, patternText, Date.now()]
      });
    } catch (e) { /* silent */ }
  }

  return patternText || `${exam_type}: MCQ pattern with 4 options, mix of factual and analytical questions at moderate-hard difficulty.`;
}

// ==========================================
// Multi-layer duplicate filter
// ==========================================
async function filterDuplicatesMultiLayer(items, contextInfo) {
  if (items.length === 0) return { unique: [], duplicates: [] };

  const db = getDb();
  const duplicates = [];
  const survivors = [];

  const { category, section, subject, chapter } = contextInfo;
  let globalRecentRows = [];
  try {
    const globalRecent = await db.execute({
      sql: `SELECT id, trigram_sig, word_set_fp, question_en
            FROM mcqs
            ORDER BY created_at DESC LIMIT 500`,
      args: []
    });
    globalRecentRows = globalRecent.rows || [];
  } catch (e) {
    console.warn('[DEDUP] Global recent scan unavailable:', e.message);
  }

  for (const item of items) {
    const q = item.mcq.question_en;
    const trigramSig = makeTrigramSignature(q);
    const wordFp = makeWordSetFp(q);

    let isDup = false;
    let dupReason = '';

    try {
      const recent = await db.execute({
        sql: `SELECT id, trigram_sig, word_set_fp, question_en
              FROM mcqs
              WHERE category = ? AND section = ? AND subject = ? AND chapter = ?
              ORDER BY created_at DESC LIMIT ?`,
        args: [category, section, subject, chapter, RECENT_QUESTIONS_TO_CHECK]
      });
      const merged = new Map();
      for (const row of globalRecentRows) merged.set(row.id, row);
      for (const row of (recent.rows || [])) merged.set(row.id, row);

      for (const existing of merged.values()) {
        const existingTriSig = existing.trigram_sig || makeTrigramSignature(existing.question_en);
        const existingWordFp = existing.word_set_fp || makeWordSetFp(existing.question_en);
        const triSim = signatureSimilarity(trigramSig, existingTriSig);
        if (triSim >= TRIGRAM_SIMILARITY_THRESHOLD) {
          isDup = true;
          dupReason = `Trigram similarity ${(triSim * 100).toFixed(0)}%`;
          break;
        }
        const wsSim = wordSetSimilarity(wordFp, existingWordFp);
        if (wsSim >= WORDSET_SIMILARITY_THRESHOLD) {
          isDup = true;
          dupReason = `Word overlap ${(wsSim * 100).toFixed(0)}%`;
          break;
        }
      }
    } catch (e) { /* fail-open */ }

    if (isDup) {
      duplicates.push({ ...item, reason: dupReason });
    } else {
      let batchDup = false;
      for (const s of survivors) {
        const triSim = signatureSimilarity(trigramSig, s._trigramSig);
        if (triSim >= TRIGRAM_SIMILARITY_THRESHOLD) {
          batchDup = true;
          dupReason = 'Batch trigram duplicate';
          break;
        }
        const wsSim = wordSetSimilarity(wordFp, s._wordFp);
        if (wsSim >= WORDSET_SIMILARITY_THRESHOLD) {
          batchDup = true;
          dupReason = 'Batch word-set duplicate';
          break;
        }
      }

      if (batchDup) {
        duplicates.push({ ...item, reason: dupReason });
      } else {
        item._trigramSig = trigramSig;
        item._wordFp = wordFp;
        survivors.push(item);
      }
    }
  }

  return { unique: survivors, duplicates };
}

// ==========================================
// EVIDENCE RETRIEVER
// ==========================================
export async function retrieveEvidence(category, section, subject, chapter) {
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (err) { clearTimeout(id); throw err; }
  };

  const searchQuery = `${subject} ${chapter} NCERT UPSC notes`;
  let targetUrl = null;

  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const ddgRes = await fetchWithTimeout(ddgUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    }, 4000);

    if (ddgRes?.ok) {
      const html = await ddgRes.text();
      if (!html.toLowerCase().includes('captcha') && !html.includes('403')) {
        const matches = html.match(/uddg=([^&"']+)/g);
        if (matches && matches.length > 0) {
          for (const m of matches) {
            const url = decodeURIComponent(m.replace('uddg=', ''));
            if (url.includes('ncert.nic.in') || url.includes('wikipedia.org')) {
              targetUrl = url;
              break;
            }
          }
          if (!targetUrl) targetUrl = decodeURIComponent(matches[0].replace('uddg=', ''));
        }
      }
    }
  } catch (e) { /* silent */ }

  if (targetUrl) {
    try {
      const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${targetUrl}`, { headers: { 'X-No-Cache': 'true' } }, 7000);
      if (jinaRes?.ok) {
        const txt = await jinaRes.text();
        if (txt && txt.length > MIN_EVIDENCE_LENGTH && !txt.toLowerCase().includes('not found')) {
          const cleaned = txt
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/[#*`_~]/g, '')
            .replace(/\s+/g, ' ').trim();
          return { text: cleaned.substring(0, 4000), sourceUrl: targetUrl };
        }
      }
    } catch (e) { /* silent */ }
  }

  try {
    const backupUrl = `https://s.jina.ai/${encodeURIComponent(`NCERT ${subject} ${chapter} notes`)}`;
    const backupRes = await fetchWithTimeout(backupUrl, { headers: { 'X-No-Cache': 'true' } }, 5000);
    if (backupRes?.ok) {
      const txt = await backupRes.text();
      if (txt && txt.length > MIN_EVIDENCE_LENGTH) {
        const cleaned = txt
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[#*`_~]/g, '')
          .replace(/\s+/g, ' ').trim();
        return { text: cleaned.substring(0, 3500), sourceUrl: null };
      }
    }
  } catch (e) { /* silent */ }

  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(chapter)}`;
    const wikiRes = await fetchWithTimeout(wikiUrl, {}, 3000);
    if (wikiRes?.ok) {
      const data = await wikiRes.json();
      if (data?.extract && data.extract.length > MIN_EVIDENCE_LENGTH) return { text: data.extract, sourceUrl: wikiUrl };
    }
  } catch (e) { /* silent */ }

  return null;
}

// ==========================================
// MODEL DISCOVERY
// ==========================================
async function getAvailableGeminiModels(apiKey) {
  if (process.env.GEMINI_MODELS) return process.env.GEMINI_MODELS.split(',').map(m => m.trim()).filter(Boolean);
  if (cachedGeminiModels.data && (Date.now() - cachedGeminiModels.timestamp < CACHE_TTL)) return cachedGeminiModels.data;

  try {
    const res = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`, { method: 'GET', apiKeyUsed: apiKey }, 2);
    if (res?.ok) {
      const data = await res.json();
      const models = (data?.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
      if (models.length > 0) { cachedGeminiModels = { data: models, timestamp: Date.now() }; return models; }
    }
  } catch (e) { /* silent */ }
  return ['gemini-2.0-flash', 'gemini-1.5-flash'];
}

async function getAvailableDeepSeekModel(apiKey) {
  if (process.env.DEEPSEEK_MODEL) return process.env.DEEPSEEK_MODEL.trim();
  if (cachedDeepSeekModel.data && (Date.now() - cachedDeepSeekModel.timestamp < CACHE_TTL)) return cachedDeepSeekModel.data;
  try {
    const res = await fetchWithRetry('https://api.deepseek.com/models', { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, apiKeyUsed: apiKey }, 2);
    if (res?.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data) && data.data.length > 0) {
        cachedDeepSeekModel = { data: data.data[0].id, timestamp: Date.now() };
        return cachedDeepSeekModel.data;
      }
    }
  } catch (e) { /* silent */ }
  return 'deepseek-chat';
}

// ==========================================
// LEARNING LOOP
// ==========================================
async function loadGoodExamples(limit = 5) {
  try {
    const db = getDb();
    const res = await db.execute({ sql: 'SELECT pattern FROM learn_good ORDER BY score DESC LIMIT ?', args: [limit] });
    return res.rows.map(r => r.pattern).filter(Boolean);
  } catch (e) { return []; }
}

async function loadBadExamples(limit = 5) {
  try {
    const db = getDb();
    const res = await db.execute({ sql: 'SELECT reason FROM learn_bad ORDER BY id DESC LIMIT ?', args: [limit] });
    return res.rows.map(r => r.reason).filter(Boolean);
  } catch (e) { return []; }
}

async function saveLearnGood(mcqId, pattern, score) {
  try {
    const db = getDb();
    await db.execute({ sql: 'INSERT INTO learn_good (mcq_id, pattern, score, created_at) VALUES (?, ?, ?, ?)', args: [mcqId, pattern, score, Date.now()] });
  } catch (e) { /* silent */ }
}

async function saveLearnBad(question, reason, score) {
  try {
    const db = getDb();
    await db.execute({ sql: 'INSERT INTO learn_bad (rejected_question, reason, score, created_at) VALUES (?, ?, ?, ?)', args: [question, reason, score || 0, Date.now()] });
  } catch (e) { /* silent */ }
}

// ==========================================
// AI GENERATES CHAPTER LIST
// ==========================================
export async function generateChapterList({ category, section, subject, existingChapters = [], count = 20 }) {
  const existingBlock = existingChapters.length
    ? `\n\nAVOID these already-generated chapters (do NOT repeat):\n${existingChapters.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const prompt = `You are an expert curriculum designer for Indian competitive exams.

TASK: List ${count} distinct chapters or subtopics for:

- Category: ${category}
- Section: ${section}
- Subject: ${subject}

Requirements:
- Each chapter should be a specific, teachable topic
- Chapters must be strictly related to "${subject}"
- Chapters should be exam-relevant
- Return diverse topics
${existingBlock}

Return ONLY valid JSON:
{"chapters": ["Chapter 1", "Chapter 2"]}`;

  const initialKey = getRandomKey('GEMINI_KEYS');
  if (!initialKey) throw new Error('GEMINI_KEYS missing');

  const models = await getAvailableGeminiModels(initialKey);
  let lastError = null;

  for (const model of models) {
    const currentKey = getRandomKey('GEMINI_KEYS') || initialKey;
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      };
      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(currentKey)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), apiKeyUsed: currentKey }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = JSON.parse(cleanJSONString(text));
      const v = ChapterListSchema.safeParse(parsed);
      if (!v.success) throw new Error('Invalid chapters JSON');
      return v.data.chapters;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Chapter list failed: ${lastError?.message}`);
}

// ==========================================
// GENERATE DRAFT
// ==========================================
async function generateDraft({ category, section, subject, chapter, exam_type, difficulty, count, evidence }) {
  const goldenExamples = await loadGoldenMCQs(category, section, subject, chapter, GOLDEN_EXAMPLES_COUNT);
  const examPattern = await fetchExamPattern(exam_type, subject);
  const goodExamples = await loadGoodExamples(5);
  const badExamples = await loadBadExamples(5);
  const recentQuestions = await getRecentQuestionsFromChapter(category, section, subject, chapter, RECENT_QUESTIONS_FOR_PROMPT);

  const goodBlock = goodExamples.length
    ? `\n\n✅ PAST GOOD PATTERNS (90+, follow these):\n${goodExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  const badBlock = badExamples.length
    ? `\n\n❌ AVOID THESE MISTAKES (rejected):\n${badExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  const recentBlock = recentQuestions.length
    ? `\n\n⚠️ ALREADY EXISTS (DO NOT recreate):\n${recentQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  const goldenBlock = goldenExamples.length
    ? `\n\n🏆 GOLDEN EXAMPLES (99+, MATCH THIS STYLE):\n${
        goldenExamples.map((g, i) => {
          return `\n--- Golden ${i + 1} (score ${g.score}) ---
Q: ${g.question_en}
A) ${g.options[0]}
B) ${g.options[1]}
C) ${g.options[2]}
D) ${g.options[3]}
Answer: ${['A','B','C','D'][g.answer]}
Explanation: ${g.explanation_en}`;
        }).join('\n')
      }\n\nMatch this style, depth, and rigor.`
    : '';

  const patternBlock = `\n\n📋 LATEST EXAM PATTERN (${exam_type} — match this):\n${examPattern}`;

  const prompt = `You are an expert question setter for India's top competitive exams.

TASK: Generate exactly ${count} MCQs STRICTLY on the given chapter.

HIERARCHY:
- Category: ${category}
- Section: ${section}
- Subject: ${subject}
- Chapter: ${chapter}
- Exam Level: ${exam_type || 'UPSC CSE'}
- Difficulty: ${difficulty || 'hard'}
${patternBlock}

⚠️ CRITICAL: Every MCQ MUST be from "${chapter}" chapter only.
⚠️ QUALITY STANDARD: MCQs scoring below 90 will be REJECTED. Only 90+ saved.
⚠️ 99+ score MCQs become GOLDEN and are used as reference for future MCQs.
${goldenBlock}
${recentBlock}

REFERENCE EVIDENCE:
${evidence}
${goodBlock}${badBlock}

RULES:
1. Each MCQ has EXACTLY 4 options
2. Only ONE correct option
3. 100% factually accurate
4. BOTH Hindi and English versions
5. Explanation 3-4 lines: why correct, why others wrong, example
6. NO duplicates from ALREADY EXISTS list
7. Match STYLE and RIGOR of golden examples
8. Follow the latest exam pattern

Return ONLY valid JSON:
{
  "mcqs": [
    {
      "question_hi": "...", "question_en": "...",
      "option_a_hi": "...", "option_a_en": "...",
      "option_b_hi": "...", "option_b_en": "...",
      "option_c_hi": "...", "option_c_en": "...",
      "option_d_hi": "...", "option_d_en": "...",
      "answer": 0,
      "difficulty": "${difficulty || 'hard'}",
      "explanation_hi": "...", "explanation_en": "..."
    }
  ]
}`;

  const initialKey = getRandomKey('GEMINI_KEYS');
  if (!initialKey) throw new Error('GEMINI_KEYS missing');

  const models = await getAvailableGeminiModels(initialKey);
  let lastError = null;

  for (const model of models) {
    const currentKey = getRandomKey('GEMINI_KEYS') || initialKey;
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      };
      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(currentKey)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), apiKeyUsed: currentKey }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = JSON.parse(cleanJSONString(text));
      const mcqs = Array.isArray(parsed?.mcqs) ? parsed.mcqs : (Array.isArray(parsed) ? parsed : []);
      if (mcqs.length === 0) throw new Error('No MCQs');
      return mcqs;
    } catch (err) { lastError = err; }
  }
  throw new Error(`All Gemini models failed: ${lastError?.message}`);
}

// ==========================================
// AI JUDGES
// ==========================================
async function callGeminiForJudge(prompt) {
  const initialKey = getRandomKey('GEMINI_KEYS');
  if (!initialKey) throw new Error('GEMINI_KEYS missing');

  const models = await getAvailableGeminiModels(initialKey);
  let lastError = null;

  for (const model of models) {
    const currentKey = getRandomKey('GEMINI_KEYS') || initialKey;
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      };
      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(currentKey)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), apiKeyUsed: currentKey }
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return JSON.parse(cleanJSONString(text));
    } catch (err) { lastError = err; }
  }
  throw new Error(`Gemini judge failed: ${lastError?.message}`);
}

async function judgeWithGemini(question, options, answerText, explanation, evidence) {
  const prompt = `Analyze this MCQ for factual accuracy based strictly on evidence. EVIDENCE: ${evidence} QUESTION: ${question} OPTIONS: ${JSON.stringify(options)} ANSWER: ${answerText} EXPLANATION: ${explanation} Return JSON strictly: {"passed": boolean, "confidence": number (0-100), "options_quality": number (0-100), "question_quality": number (0-100), "explanation_valid": boolean, "contradiction": boolean, "evidence_sufficient": boolean, "unique_correct_option": boolean, "ambiguous": boolean, "reason": "short explanation"}`;
  const raw = await callGeminiForJudge(prompt);
  return safeJsonParseAndValidate(JSON.stringify(raw), AIJudgeResultSchema, 'Gemini-judge');
}

async function judgeWithDeepSeek(question, options, answerText, explanation, evidence) {
  const apiKey = getRandomKey('DEEPSEEK_KEYS');
  if (!apiKey) throw new Error('DEEPSEEK_KEYS missing');

  const model = await getAvailableDeepSeekModel(apiKey);
  const prompt = `Analyze this MCQ for factual accuracy based ONLY on evidence. EVIDENCE: ${evidence} QUESTION: ${question} OPTIONS: A) ${options[0]} B) ${options[1]} C) ${options[2]} D) ${options[3]} ANSWER: ${answerText} EXPLANATION: ${explanation} Return JSON strictly: {"passed": boolean, "confidence": number (0-100), "options_quality": number (0-100), "question_quality": number (0-100), "explanation_valid": boolean, "contradiction": boolean, "evidence_sufficient": boolean, "unique_correct_option": boolean, "ambiguous": boolean, "reason": "short explanation"}`;

  const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    apiKeyUsed: apiKey
  });

  const resJson = await res.json();
  const content = resJson?.choices?.[0]?.message?.content;
  return safeJsonParseAndValidate(content, AIJudgeResultSchema, 'DeepSeek');
}

async function verifyChapterMatch(mcq, category, section, subject, chapter) {
  const prompt = `Does this MCQ belong to chapter "${chapter}" of subject "${subject}" (section: ${section}, category: ${category})?

QUESTION: ${mcq.question_en}
OPTIONS: A) ${mcq.option_a_en} B) ${mcq.option_b_en} C) ${mcq.option_c_en} D) ${mcq.option_d_en}

Return JSON: {"belongs": boolean, "actual_chapter": "what it's really about", "confidence": 0-100}`;

  try {
    const raw = await callGeminiForJudge(prompt);
    return safeJsonParseAndValidate(JSON.stringify(raw), ChapterMatchSchema, 'ChapterMatch');
  } catch (e) {
    return { belongs: true, actual_chapter: chapter, confidence: 50 };
  }
}

// ==========================================
// QUALITY SCORE
// ==========================================
function calculateQualityScore(judgeResult, agreement) {
  const q = (Number(judgeResult?.question_quality) || 0) * 0.35;
  const o = (Number(judgeResult?.options_quality) || 0) * 0.35;
  const c = (Number(judgeResult?.confidence) || 0) * 0.20;
  const a = (Number(agreement) || 0) * 0.10;
  return Math.round(Math.min(100, Math.max(0, q + o + c + a)));
}

// ==========================================
// VALIDATE
// ==========================================
function validateRawMCQ(mcq) {
  if (!mcq || typeof mcq !== 'object' || Array.isArray(mcq)) return { valid: false, reason: 'Invalid', rawInput: mcq };

  const result = RawMCQSchema.safeParse(mcq);
  if (!result.success) return { valid: false, reason: result.error.issues.map(i => i.message).join('; '), rawInput: mcq };

  const d = result.data;
  const hiOpts = [d.option_a_hi, d.option_b_hi, d.option_c_hi, d.option_d_hi];
  const enOpts = [d.option_a_en, d.option_b_en, d.option_c_en, d.option_d_en];

  if (new Set(hiOpts.map(normalizeMCQText)).size !== 4) return { valid: false, reason: 'Duplicate Hindi options', rawInput: mcq };
  if (new Set(enOpts.map(normalizeMCQText)).size !== 4) return { valid: false, reason: 'Duplicate English options', rawInput: mcq };

  let answerIdx = -1;
  if (typeof d.answer === 'number') {
    answerIdx = Number.isInteger(d.answer) && d.answer >= 0 && d.answer <= 3 ? d.answer : -1;
  } else if (typeof d.answer === 'string') {
    const rawAnswer = d.answer.trim().toLowerCase();
    const letterMap = { a: 0, b: 1, c: 2, d: 3, '0': 0, '1': 1, '2': 2, '3': 3 };
    if (Object.prototype.hasOwnProperty.call(letterMap, rawAnswer)) {
      answerIdx = letterMap[rawAnswer];
    } else {
      const norm = normalizeMCQText(d.answer);
      answerIdx = enOpts.findIndex(o => normalizeMCQText(o) === norm);
      if (answerIdx === -1) answerIdx = hiOpts.findIndex(o => normalizeMCQText(o) === norm);
    }
  }
  if (!Number.isInteger(answerIdx) || answerIdx < 0 || answerIdx > 3) {
    return { valid: false, reason: 'Answer not mapped', rawInput: mcq };
  }

  return {
    valid: true,
    mcq: {
      question_hi: d.question_hi.trim(),
      question_en: d.question_en.trim(),
      option_a_hi: d.option_a_hi.trim(), option_a_en: d.option_a_en.trim(),
      option_b_hi: d.option_b_hi.trim(), option_b_en: d.option_b_en.trim(),
      option_c_hi: d.option_c_hi.trim(), option_c_en: d.option_c_en.trim(),
      option_d_hi: d.option_d_hi.trim(), option_d_en: d.option_d_en.trim(),
      answer: answerIdx,
      difficulty: (d.difficulty || 'medium').trim(),
      explanation_hi: (d.explanation_hi || '').trim(),
      explanation_en: (d.explanation_en || '').trim()
    }
  };
}

// ==========================================
// Fingerprint bulk dedup (exact batch dedup only)
// ==========================================
async function filterDuplicatesByFingerprint(items) {
  const unique = [];
  const duplicates = [];
  const seen = new Set();
  for (const item of items) {
    const normalized = normalizeMCQText(item?.mcq?.question_en || '');
    const hash = createHash('sha256').update(normalized).digest('hex');
    if (seen.has(hash)) duplicates.push({ ...item, reason: 'Exact duplicate in batch' });
    else { seen.add(hash); unique.push(item); }
  }
  return { unique, duplicates };
}

// ==========================================
// VALIDATE + JUDGE + SAVE
// ==========================================
async function validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput, evidenceText, sourceUrl = null, taskId = null }) {
  const db = getDb();
  const safeEvidence = typeof evidenceText === 'string' ? evidenceText.slice(0, 10000) : '';
  const rejected = [];

  const inputArr = Array.isArray(rawMCQsInput) ? rawMCQsInput : [];

  const initialValidated = inputArr.map(validateRawMCQ).filter(r => {
    if (!r || !r.valid) {
      const q = r?.rawInput?.question_en || r?.rawInput?.question_hi || 'Unknown';
      const reason = `Structural: ${r?.reason || 'Invalid'}`;
      rejected.push({ question: q, reason });
      saveLearnBad(q, reason, 0).catch(() => {});
      return false;
    }
    return true;
  }).map(r => r.mcq);

  if (initialValidated.length === 0) return { success: false, count: 0, rejectedTotal: rejected.length, rejectedDetails: rejected };

  const approved = [];
  const chunks = chunkArray(initialValidated, BATCH_CONCURRENCY);

  for (let i = 0; i < chunks.length; i++) {
    const promises = chunks[i].map(async mcq => {
      try {
        const enOpts = [mcq.option_a_en, mcq.option_b_en, mcq.option_c_en, mcq.option_d_en];
        const answerText = enOpts[mcq.answer];

        const chapterCheck = await verifyChapterMatch(mcq, category, section, subject, chapter);
        if (!chapterCheck.belongs || (chapterCheck.confidence || 0) < 60) {
          const reason = `Chapter mismatch (actual: ${chapterCheck.actual_chapter || 'unknown'})`;
          rejected.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, 0).catch(() => {});
          return null;
        }

        const gResult = await judgeWithGemini(mcq.question_en, enOpts, answerText, mcq.explanation_en, safeEvidence);
        let final = gResult;
        let agreement = 50;

        if (!gResult.passed || gResult.confidence < 90 || gResult.ambiguous || !gResult.evidence_sufficient) {
          try {
            const dResult = await judgeWithDeepSeek(mcq.question_en, enOpts, answerText, mcq.explanation_en, safeEvidence);
            if (gResult.passed !== dResult.passed) {
              rejected.push({ question: mcq.question_en, reason: 'Model disagreement' });
              saveLearnBad(mcq.question_en, 'Model disagreement', 0).catch(() => {});
              return null;
            }
            agreement = 100;
            if (gResult.passed && dResult.passed) {
              final = { ...gResult, confidence: Math.min(gResult.confidence, dResult.confidence) };
            }
          } catch (e) {
            rejected.push({ question: mcq.question_en, reason: 'DeepSeek failed: ' + e.message });
            saveLearnBad(mcq.question_en, 'DeepSeek failed', 0).catch(() => {});
            return null;
          }
        }

        if (!final || !final.passed || final.contradiction || !final.explanation_valid ||
            !final.evidence_sufficient || !final.unique_correct_option || final.ambiguous) {
          const reason = final?.reason || 'Quality gate failed';
          rejected.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, 0).catch(() => {});
          return null;
        }

        const score = calculateQualityScore(final, agreement);
        if (score < QUALITY_GATE) {
          const reason = `Score ${score} < ${QUALITY_GATE}`;
          rejected.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, score).catch(() => {});
          return null;
        }

        return { mcq, score, judgeReason: final.reason || '' };
      } catch (e) {
        rejected.push({ question: mcq.question_en, reason: `Error: ${e.message}` });
        return null;
      }
    });

    approved.push(...(await Promise.all(promises)).filter(Boolean));
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  if (approved.length === 0) return { success: false, count: 0, rejectedTotal: rejected.length, rejectedDetails: rejected };

  // Layer 1+2: Exact hash
  const hashMap = new Map();
  for (const item of approved) {
    const h = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    if (!hashMap.has(h)) hashMap.set(h, item);
  }

  // Layer 2: Batch dedup
  const { unique: afterFp, duplicates: fpDups } = await filterDuplicatesByFingerprint([...hashMap.values()]);
  for (const d of fpDups) {
    rejected.push({ question: d.mcq.question_en, reason: d.reason });
    saveLearnBad(d.mcq.question_en, d.reason, 0).catch(() => {});
  }

  // Layer 3: Trigram + Word-set
  const { unique: uniqueItems, duplicates: triDups } = await filterDuplicatesMultiLayer(afterFp, {
    category, section, subject, chapter
  });
  for (const d of triDups) {
    rejected.push({ question: d.mcq.question_en, reason: d.reason });
    saveLearnBad(d.mcq.question_en, d.reason, 0).catch(() => {});
  }

  if (uniqueItems.length === 0) return { success: false, count: 0, rejectedTotal: rejected.length, rejectedDetails: rejected };

  // INSERT
  const INSERT_COLUMNS = [
    'id', 'category', 'section', 'subject', 'chapter', 'exam_type', 'difficulty',
    'question_hi', 'question_en',
    'option_a_hi', 'option_a_en',
    'option_b_hi', 'option_b_en',
    'option_c_hi', 'option_c_en',
    'option_d_hi', 'option_d_en',
    'answer', 'explanation_hi', 'explanation_en',
    'hash', 'fingerprint', 'trigram_sig', 'word_set_fp',
    'quality_score', 'is_gold',
    'source_url', 'retrieval_score', 'random_key', 'version', 'parent_qid', 'generation_task_id', 'created_at'
  ];

  const COL_COUNT = INSERT_COLUMNS.length;
  const args = [];

  for (const item of uniqueItems) {
    const id = randomUUID();
    const hash = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    const fp = makeFingerprint(item.mcq.question_en, item.mcq.question_hi);
    const trigramSig = item._trigramSig || makeTrigramSignature(item.mcq.question_en);
    const wordFp = item._wordFp || makeWordSetFp(item.mcq.question_en);
    const isGold = item.score >= GOLD_THRESHOLD ? 1 : 0;

    args.push(
      id,
      category || '',
      section || '',
      subject || '',
      chapter || '',
      exam_type || '',
      item.mcq.difficulty,
      item.mcq.question_hi, item.mcq.question_en,
      item.mcq.option_a_hi, item.mcq.option_a_en,
      item.mcq.option_b_hi, item.mcq.option_b_en,
      item.mcq.option_c_hi, item.mcq.option_c_en,
      item.mcq.option_d_hi, item.mcq.option_d_en,
      item.mcq.answer,
      item.mcq.explanation_hi, item.mcq.explanation_en,
      hash, fp,
      trigramSig, wordFp,
      item.score, isGold,
      sourceUrl || null, null,
      Math.floor(Math.random() * 2147483647),
      1, null,
      taskId == null ? null : Number(taskId),
      Date.now()
    );
  }

  if (args.length !== uniqueItems.length * COL_COUNT) {
    throw new Error(`Arg count mismatch: ${args.length} vs ${uniqueItems.length * COL_COUNT}`);
  }

  const INSERT_BATCH_SIZE = 25;
  let actualInserted = 0;
  let taskRowsBefore = 0;
  if (taskId != null) {
    const before = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM mcqs WHERE generation_task_id = ?',
      args: [Number(taskId)]
    });
    taskRowsBefore = Number(before.rows?.[0]?.c || 0);
  }
  try {
    for (let start = 0; start < uniqueItems.length; start += INSERT_BATCH_SIZE) {
      const batchItems = uniqueItems.slice(start, start + INSERT_BATCH_SIZE);
      const batchArgs = args.slice(start * COL_COUNT, (start + batchItems.length) * COL_COUNT);
      const batchPlaceholders = batchItems
        .map(() => `(${Array(COL_COUNT).fill('?').join(',')})`)
        .join(',');
      const sql = `
        INSERT INTO mcqs (${INSERT_COLUMNS.join(', ')})
        VALUES ${batchPlaceholders}
        ON CONFLICT(hash) DO NOTHING;
      `;
      const insertResult = await db.execute({ sql, args: batchArgs });
      const inserted = Number(insertResult?.rowsAffected ?? 0);
      if (!Number.isFinite(inserted) || inserted < 0) throw new Error('Invalid rowsAffected');
      actualInserted += inserted;
    }
  } catch (error) {
    let insertedThisAttempt = actualInserted;
    if (taskId != null) {
      try {
        const after = await db.execute({
          sql: 'SELECT COUNT(*) AS c FROM mcqs WHERE generation_task_id = ?',
          args: [Number(taskId)]
        });
        const totalForTask = Number(after.rows?.[0]?.c || 0);
        if (Number.isFinite(totalForTask)) insertedThisAttempt = Math.max(insertedThisAttempt, totalForTask - taskRowsBefore);
      } catch (countError) {
        console.warn('[INSERT] Count reconciliation failed:', safeDbError(countError).message);
      }
    }
    const message = `Insert failed: ${safeDbError(error).message}`;
    console.error(`⚠️ ${message}; inserted this attempt: ${insertedThisAttempt}`);
    return {
      success: false,
      isPartial: insertedThisAttempt > 0,
      count: insertedThisAttempt,
      rejectedTotal: rejected.length,
      rejectedDetails: rejected,
      error: message
    };
  }

  for (const item of uniqueItems) {
    if (item.score >= LEARN_GOOD_THRESHOLD && item.judgeReason) {
      saveLearnGood(null, item.judgeReason, item.score).catch(() => {});
    }
  }

  return { success: actualInserted > 0, count: actualInserted, rejectedTotal: rejected.length, rejectedDetails: rejected, error: actualInserted === 0 ? 'NO_NEW_ROWS_INSERTED' : undefined };
}

// ==========================================
// MAIN
// ==========================================
export async function generateFromScratch({ category, section, subject, chapter, exam_type, difficulty, count, taskId = null }) {
  console.log(`🚀 ${category} → ${section} → ${subject} → ${chapter} (${count} MCQs)`);

  let evidence = null;
  let sourceUrl = null;
  try {
    const retrieved = await retrieveEvidence(category, section, subject, chapter);
    if (typeof retrieved === 'string') evidence = retrieved;
    else if (retrieved && typeof retrieved === 'object') {
      evidence = typeof retrieved.text === 'string' ? retrieved.text : null;
      sourceUrl = typeof retrieved.sourceUrl === 'string' ? retrieved.sourceUrl : null;
    }
  } catch (e) { console.warn('Evidence error:', e.message); }

  if (!evidence || evidence.length < MIN_EVIDENCE_LENGTH) {
    return { success: false, error: 'EVIDENCE_FETCH_FAILED', message: 'Evidence too short', count: 0 };
  }

  console.log(`✅ Evidence: ${evidence.length} chars${sourceUrl ? ` | Source: ${sourceUrl}` : ''}`);

  let rawMCQs;
  try {
    rawMCQs = await generateDraft({ category, section, subject, chapter, exam_type, difficulty, count, evidence });
    console.log(`✅ Generated ${rawMCQs.length} drafts`);
  } catch (e) {
    return { success: false, error: `generateDraft failed: ${e.message}`, count: 0 };
  }

  if (!rawMCQs || rawMCQs.length === 0) return { success: false, error: 'AI generated 0', count: 0 };

  const result = await validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput: rawMCQs, evidenceText: evidence, sourceUrl, taskId });
  console.log(`✅ Saved ${result.count} | Rejected ${result.rejectedTotal}`);
  return result;
}

export { loadGoodExamples, loadBadExamples };
