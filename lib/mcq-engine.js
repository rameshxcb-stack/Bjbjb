// ============================================================
// lib/mcq-engine.js — Full AI Pipeline
// 4-Level Hierarchy + Learning Loop + Chapter Auto-Generation
// ============================================================

import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { getDb, safeDbError } from './db.js';

// ==========================================
// CONFIG
// ==========================================
const QUALITY_GATE = 75;
const GOLD_THRESHOLD = 95;
const BATCH_CONCURRENCY = 5;
const BATCH_DELAY_MS = 1500;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const DISABLED_KEY_COOLDOWN = 5 * 60 * 1000;
const MIN_EVIDENCE_LENGTH = 200;
const FINGERPRINT_WORDS = 15;

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
  answer: z.union([z.number().min(0).max(3), z.string()]),
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
      if (response.status === 429 || response.status === 403) {
        markKeyAsRateLimited(apiKeyUsed);
        if (attempt < retries) {
          await new Promise(res => setTimeout(res, backoffMs * Math.pow(2, attempt - 1)));
          continue;
        }
      }
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
  return text.toString().toLowerCase().trim().replace(/[^\w\s\u0900-\u097F]/gi, '');
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
          return cleaned.substring(0, 4000);
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
        return cleaned.substring(0, 3500);
      }
    }
  } catch (e) { /* silent */ }

  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(chapter)}`;
    const wikiRes = await fetchWithTimeout(wikiUrl, {}, 3000);
    if (wikiRes?.ok) {
      const data = await wikiRes.json();
      if (data?.extract && data.extract.length > MIN_EVIDENCE_LENGTH) return data.extract;
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
// ⭐ NEW: AI GENERATES CHAPTER LIST
// ==========================================
export async function generateChapterList({ category, section, subject, existingChapters = [], count = 20 }) {
  const existingBlock = existingChapters.length
    ? `\n\nAVOID these already-generated chapters (do NOT repeat):\n${existingChapters.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const prompt = `You are an expert curriculum designer for Indian competitive exams.

TASK: List ${count} distinct chapters or subtopics for the following:

- Category: ${category}
- Section: ${section}
- Subject: ${subject}

These chapters will be used to generate MCQs for exams like UPSC CSE, SSC CGL, JEE, NEET at hard level.

Requirements:
- Each chapter should be a specific, teachable topic (not too broad)
- Chapters must be strictly related to "${subject}"
- Chapters should be exam-relevant, not random trivia
- Return diverse topics covering the full subject
${existingBlock}

Return ONLY valid JSON:
{
  "chapters": [
    "Chapter name 1",
    "Chapter name 2"
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
  const goodExamples = await loadGoodExamples(5);
  const badExamples = await loadBadExamples(5);

  const goodBlock = goodExamples.length
    ? `\n\nPAST GOOD PATTERNS:\n${goodExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';
  const badBlock = badExamples.length
    ? `\n\nAVOID THESE MISTAKES:\n${badExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  const prompt = `You are an expert question setter for India's top competitive exams.

TASK: Generate exactly ${count} MCQs STRICTLY on the given chapter.

HIERARCHY (follow exactly):
- Category: ${category}
- Section: ${section}
- Subject: ${subject}
- Chapter: ${chapter}
- Exam Level: ${exam_type || 'UPSC CSE'}
- Difficulty: ${difficulty || 'hard'} (must be at exam level or HARDER)

⚠️ CRITICAL: Every MCQ MUST be from "${chapter}" chapter only.
- Do NOT add questions from other chapters
- Do NOT add general knowledge questions
- Stick strictly to "${chapter}"

REFERENCE EVIDENCE:
${evidence}
${goodBlock}${badBlock}

RULES:
1. Each MCQ has EXACTLY 4 options
2. Only ONE correct option
3. 100% factually accurate
4. BOTH Hindi and English versions
5. Detailed explanations

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
  const prompt = `Does this MCQ belong to the chapter "${chapter}" of subject "${subject}" (section: ${section}, category: ${category})?

QUESTION: ${mcq.question_en}
OPTIONS: A) ${mcq.option_a_en} B) ${mcq.option_b_en} C) ${mcq.option_c_en} D) ${mcq.option_d_en}

If the question is about a DIFFERENT chapter, return belongs: false.
If it belongs to "${chapter}" or closely related, return belongs: true.

Return JSON: {"belongs": boolean, "actual_chapter": "what chapter this really is about", "confidence": 0-100}`;

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
  if (typeof d.answer === 'number') answerIdx = d.answer;
  else if (typeof d.answer === 'string') {
    const norm = normalizeMCQText(d.answer);
    answerIdx = enOpts.findIndex(o => normalizeMCQText(o) === norm);
    if (answerIdx === -1) {
      const idx = ['a','b','c','d','0','1','2','3'].indexOf(d.answer.toLowerCase().trim());
      if (idx !== -1) answerIdx = idx % 4;
    }
  }
  if (answerIdx === -1) return { valid: false, reason: 'Answer not mapped', rawInput: mcq };

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
// FINGERPRINT DEDUP
// ==========================================
async function filterDuplicates(items) {
  if (items.length === 0) return { unique: [], duplicates: [] };

  const db = getDb();
  const fps = items.map(i => makeFingerprint(i.mcq.question_en, i.mcq.question_hi));
  const validFps = fps.filter(fp => fp.length > 0);
  if (validFps.length === 0) return { unique: items, duplicates: [] };

  let existing = new Set();
  try {
    const ph = validFps.map(() => '?').join(',');
    const res = await db.execute({ sql: `SELECT fingerprint FROM mcqs WHERE fingerprint IN (${ph})`, args: validFps });
    existing = new Set(res.rows.map(r => r.fingerprint));
  } catch (e) { /* silent */ }

  const unique = [], duplicates = [];
  const batchSeen = new Set();

  for (let i = 0; i < items.length; i++) {
    const fp = fps[i];
    if (!fp) { unique.push(items[i]); continue; }
    if (existing.has(fp) || batchSeen.has(fp)) {
      duplicates.push({ ...items[i], reason: 'Near-duplicate (fingerprint)' });
    } else {
      batchSeen.add(fp);
      unique.push(items[i]);
    }
  }
  return { unique, duplicates };
}

// ==========================================
// VALIDATE + JUDGE + SAVE
// ==========================================
async function validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput, evidenceText }) {
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

        // Step 1: Chapter match
        const chapterCheck = await verifyChapterMatch(mcq, category, section, subject, chapter);
        if (!chapterCheck.belongs || (chapterCheck.confidence || 0) < 60) {
          const reason = `Chapter mismatch (actual: ${chapterCheck.actual_chapter || 'unknown'})`;
          rejected.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, 0).catch(() => {});
          return null;
        }

        // Step 2: Gemini judge
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

  // Hash dedup
  const hashMap = new Map();
  for (const item of approved) {
    const h = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    if (!hashMap.has(h)) hashMap.set(h, item);
  }

  // Fingerprint dedup
  const { unique: uniqueItems, duplicates: fpDups } = await filterDuplicates([...hashMap.values()]);
  for (const d of fpDups) {
    rejected.push({ question: d.mcq.question_en, reason: d.reason });
    saveLearnBad(d.mcq.question_en, d.reason, 0).catch(() => {});
  }

  if (uniqueItems.length === 0) return { success: false, count: 0, rejectedTotal: rejected.length, rejectedDetails: rejected };

  // INSERT
  const placeholders = uniqueItems.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  const args = [];

  for (const item of uniqueItems) {
    const id = randomUUID();
    const hash = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    const fp = makeFingerprint(item.mcq.question_en, item.mcq.question_hi);
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
      item.score, isGold,
      null, null,
      Math.floor(Math.random() * 2147483647),
      1, null,
      Date.now()
    );
  }

  const sql = `
    INSERT INTO mcqs (
      id, category, section, subject, chapter, exam_type, difficulty,
      question_hi, question_en,
      option_a_hi, option_a_en,
      option_b_hi, option_b_en,
      option_c_hi, option_c_en,
      option_d_hi, option_d_en,
      answer, explanation_hi, explanation_en,
      hash, fingerprint, quality_score, is_gold,
      source_url, retrieval_score, random_key, version, parent_qid, created_at
    )
    VALUES ${placeholders}
    ON CONFLICT(hash) DO NOTHING;
  `;

  try {
    await db.execute({ sql, args });
  } catch (error) {
    throw new Error(`Insert failed: ${safeDbError(error).message}`);
  }

  for (const item of uniqueItems) {
    if (item.score >= 90 && item.judgeReason) {
      saveLearnGood(null, item.judgeReason, item.score).catch(() => {});
    }
  }

  return { success: true, count: uniqueItems.length, rejectedTotal: rejected.length, rejectedDetails: rejected };
}

// ==========================================
// MAIN
// ==========================================
export async function generateFromScratch({ category, section, subject, chapter, exam_type, difficulty, count }) {
  console.log(`🚀 ${category} → ${section} → ${subject} → ${chapter} (${count} MCQs)`);

  let evidence = null;
  try {
    evidence = await retrieveEvidence(category, section, subject, chapter);
  } catch (e) { console.warn('Evidence error:', e.message); }

  if (!evidence || evidence.length < MIN_EVIDENCE_LENGTH) {
    return { success: false, error: 'EVIDENCE_FETCH_FAILED', message: `Evidence too short`, count: 0 };
  }

  console.log(`✅ Evidence: ${evidence.length} chars`);

  let rawMCQs;
  try {
    rawMCQs = await generateDraft({ category, section, subject, chapter, exam_type, difficulty, count, evidence });
    console.log(`✅ Generated ${rawMCQs.length} drafts`);
  } catch (e) {
    return { success: false, error: `generateDraft failed: ${e.message}`, count: 0 };
  }

  if (!rawMCQs || rawMCQs.length === 0) return { success: false, error: 'AI generated 0', count: 0 };

  const result = await validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput: rawMCQs, evidenceText: evidence });
  console.log(`✅ Saved ${result.count} | Rejected ${result.rejectedTotal}`);
  return result;
}

export { loadGoodExamples, loadBadExamples };
