// ============================================================
// lib/mcq-engine.js — Full AI Pipeline with 5-Layer Dedup
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
const MINHASH_COUNT = 8;             // ⭐ 8 signatures
const MINHASH_MATCH_THRESHOLD = 5;   // ⭐ 5/8 match = dup
const JACCARD_THRESHOLD = 0.72;      // ⭐ 72% token overlap = dup
const RECENT_CHECK_LIMIT = 500;      // ⭐ check vs last 500 in same chapter
const PROMPT_RECENT_LIMIT = 30;      // ⭐ inject last 30 in prompt

let cachedGeminiModels = { data: null, timestamp: 0 };
let cachedDeepSeekModel = { data: null, timestamp: 0 };
const disabledKeys = new Map();

// Stopwords (skip in fingerprint)
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'and','or','but','if','then','than','of','in','on','at','to',
  'for','from','with','without','by','as','into','about','over',
  'which','who','whom','whose','that','this','these','those',
  'what','when','where','why','how','all','any','both','each',
  'few','more','most','other','some','such','no','nor','not',
  'only','own','same','so','too','very','can','will','just',
  'है','हैं','का','की','के','को','से','में','पर','और','या',
  'यह','वह','ये','वे','कौन','क्या','कब','कहाँ','कैसे'
]);

// ==========================================
// ZOD SCHEMAS
// ==========================================
const RawMCQSchema = z.object({
  question_hi: z.string().min(10),
  question_en: z.string().min(10),
  option_a_hi: z.string().min(1), option_a_en: z.string().min(1),
  option_b_hi: z.string().min(1), option_b_en: z.string().min(1),
  option_c_hi: z.string().min(1), option_c_en: z.string().min(1),
  option_d_hi: z.string().min(1), option_d_en: z.string().min(1),
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

// ==========================================
// KEY ROTATION (unchanged)
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
  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) return jsonMatch[0];
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function safeJsonParseAndValidate(text, schema, contextName = 'API') {
  if (!text) throw new Error(`[${contextName}] Empty response`);
  const cleaned = cleanJSONString(text);
  if (!cleaned) throw new Error(`[${contextName}] No JSON found`);
  try {
    const rawParsed = JSON.parse(cleaned);
    if (!rawParsed || typeof rawParsed !== 'object') throw new Error('Parsed JSON is null or not object');
    const validated = schema.safeParse(rawParsed);
    if (!validated.success) {
      throw new Error(`Schema mismatch: ${validated.error.issues.map(i => i.message).join(', ')}`);
    }
    return validated.data;
  } catch (err) {
    throw new Error(`[${contextName}] ${err.message}`);
  }
}

function normalizeMCQText(text) {
  if (!text) return '';
  return text.toString().toLowerCase().trim().replace(/[^\w\s\u0900-\u097F]/gi, '');
}

// ⭐ NEW: tokenize into meaningful words
function tokenize(text) {
  return normalizeMCQText(text)
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !STOPWORDS.has(w));
}

// ⭐ Layer 2: Sorted keyword fingerprint
function makeFingerprint(questionEn, questionHi) {
  const combined = `${questionEn || ''} ${questionHi || ''}`;
  const words = tokenize(combined);
  const unique = [...new Set(words)].sort();
  return unique.slice(0, FINGERPRINT_WORDS).join('|');
}

// ⭐ Layer 3a: Order-preserved fingerprint (catches same words, different meaning)
function makeOrderedFingerprint(questionEn, questionHi) {
  const combined = `${questionEn || ''} ${questionHi || ''}`;
  const words = tokenize(combined);
  return words.slice(0, 12).join('|');
}

// ⭐ Layer 3b: Trigram MinHash — 8 signature numbers
function makeTrigramMinhash(questionEn, questionHi) {
  const combined = normalizeMCQText(`${questionEn} ${questionHi}`);
  const chars = combined.replace(/\s+/g, ' ');
  
  // Build 3-char shingles
  const shingles = [];
  for (let i = 0; i <= chars.length - 3; i++) {
    shingles.push(chars.slice(i, i + 3));
  }
  if (shingles.length === 0) return new Array(MINHASH_COUNT).fill(0);

  // Quick hash function
  const quickHash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) + s.charCodeAt(i);
      h = h & 0x7fffffff;
    }
    return h;
  };

  const sigs = [];
  for (let i = 0; i < MINHASH_COUNT; i++) {
    let min = Infinity;
    for (const sh of shingles) {
      const h = quickHash(`${i}:${sh}`);
      if (h < min) min = h;
    }
    sigs.push(min === Infinity ? 0 : min);
  }
  return sigs;
}

// ⭐ Layer 5: Option fingerprint
function makeOptionFingerprint(optionsEn) {
  const combined = optionsEn.join(' ');
  const words = tokenize(combined);
  const unique = [...new Set(words)].sort();
  return unique.slice(0, 10).join('|');
}

// ⭐ Layer 4: Jaccard similarity between two token sets
function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function chunkArray(array, size) {
  if (!Array.isArray(array)) return [];
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// ==========================================
// EVIDENCE RETRIEVER (unchanged)
// ==========================================
export async function retrieveEvidence(subject, chapter) {
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (err) { clearTimeout(id); throw err; }
  };

  let targetUrl = null;

  try {
    const searchQuery = `${subject} ${chapter} NCERT notes`;
    const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const ddgRes = await fetchWithTimeout(ddgHtmlUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    }, 4000);

    if (ddgRes?.ok) {
      const htmlText = await ddgRes.text();
      if (!htmlText.toLowerCase().includes('captcha') && !htmlText.includes('403')) {
        const uddgMatches = htmlText.match(/uddg=([^&"']+)/g);
        if (uddgMatches && uddgMatches.length > 0) {
          for (const match of uddgMatches) {
            const decodedUrl = decodeURIComponent(match.replace('uddg=', ''));
            if (decodedUrl.includes('ncert.nic.in') || decodedUrl.includes('wikipedia.org')) {
              targetUrl = decodedUrl;
              break;
            }
          }
          if (!targetUrl) targetUrl = decodeURIComponent(uddgMatches[0].replace('uddg=', ''));
        }
      }
    }
  } catch (e) { /* silent */ }

  if (targetUrl) {
    try {
      const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${targetUrl}`, { headers: { 'X-No-Cache': 'true' } }, 7000);
      if (jinaRes?.ok) {
        const fullText = await jinaRes.text();
        if (fullText && fullText.length > MIN_EVIDENCE_LENGTH && !fullText.toLowerCase().includes('not found')) {
          const cleanedText = fullText
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/[#*`_~]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          return cleanedText.substring(0, 4000);
        }
      }
    } catch (e) { /* silent */ }
  }

  try {
    const backupUrl = `https://s.jina.ai/${encodeURIComponent(`NCERT ${subject} ${chapter} notes`)}`;
    const backupRes = await fetchWithTimeout(backupUrl, { headers: { 'X-No-Cache': 'true' } }, 5000);
    if (backupRes?.ok) {
      const text = await backupRes.text();
      if (text && text.length > MIN_EVIDENCE_LENGTH) {
        const cleaned = text
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[#*`_~]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned.substring(0, 3500);
      }
    }
  } catch (e) { /* silent */ }

  try {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(chapter)}`;
    const wikiRes = await fetchWithTimeout(wikiUrl, {}, 3000);
    if (wikiRes?.ok) {
      const wikiData = await wikiRes.json();
      if (wikiData?.extract && wikiData.extract.length > MIN_EVIDENCE_LENGTH) {
        return wikiData.extract;
      }
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
      const models = (data?.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
      if (models.length > 0) {
        cachedGeminiModels = { data: models, timestamp: Date.now() };
        return models;
      }
    }
  } catch (e) { /* silent */ }

  return ['gemini-2.0-flash', 'gemini-1.5-flash'];
}

async function getAvailableDeepSeekModel(apiKey) {
  if (process.env.DEEPSEEK_MODEL) return process.env.DEEPSEEK_MODEL.trim();
  if (cachedDeepSeekModel.data && (Date.now() - cachedDeepSeekModel.timestamp < CACHE_TTL)) return cachedDeepSeekModel.data;

  try {
    const res = await fetchWithRetry('https://api.deepseek.com/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      apiKeyUsed: apiKey
    }, 2);
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
    const res = await db.execute({
      sql: 'SELECT pattern FROM learn_good ORDER BY score DESC LIMIT ?',
      args: [limit]
    });
    return res.rows.map(r => r.pattern).filter(Boolean);
  } catch (e) { return []; }
}

async function loadBadExamples(limit = 5) {
  try {
    const db = getDb();
    const res = await db.execute({
      sql: 'SELECT reason FROM learn_bad ORDER BY id DESC LIMIT ?',
      args: [limit]
    });
    return res.rows.map(r => r.reason).filter(Boolean);
  } catch (e) { return []; }
}

// ⭐ NEW: Load recent questions to prevent regenerating them
async function loadRecentQuestions(chapter, limit = PROMPT_RECENT_LIMIT) {
  try {
    const db = getDb();
    const res = await db.execute({
      sql: `SELECT question_en FROM mcqs 
            WHERE chapter = ? 
            ORDER BY created_at DESC 
            LIMIT ?`,
      args: [chapter, limit]
    });
    return res.rows.map(r => r.question_en).filter(Boolean);
  } catch (e) { return []; }
}

async function saveLearnGood(mcqId, pattern, score) {
  try {
    const db = getDb();
    await db.execute({
      sql: 'INSERT INTO learn_good (mcq_id, pattern, score, created_at) VALUES (?, ?, ?, ?)',
      args: [mcqId, pattern, score, Date.now()]
    });
  } catch (e) { /* silent */ }
}

async function saveLearnBad(question, reason, score) {
  try {
    const db = getDb();
    await db.execute({
      sql: 'INSERT INTO learn_bad (rejected_question, reason, score, created_at) VALUES (?, ?, ?, ?)',
      args: [question, reason, score || 0, Date.now()]
    });
  } catch (e) { /* silent */ }
}

// ⭐ NEW: Save minhash signatures for future dedup
async function saveSignatures(mcqId, sigs) {
  try {
    const db = getDb();
    const stmts = sigs.map((sigVal, idx) => ({
      sql: 'INSERT OR IGNORE INTO mcq_signatures (mcq_id, sig_index, sig_value) VALUES (?, ?, ?)',
      args: [mcqId, idx, sigVal]
    }));
    await db.batch(stmts);
  } catch (e) {
    console.warn('saveSignatures failed:', e.message);
  }
}

// ==========================================
// GENERATE DRAFT (with recent-question injection)
// ==========================================
async function generateDraft({ subject, chapter, topic, exam_type, difficulty, count, evidence }) {
  const [goodExamples, badExamples, recentQuestions] = await Promise.all([
    loadGoodExamples(5),
    loadBadExamples(5),
    loadRecentQuestions(chapter, PROMPT_RECENT_LIMIT)
  ]);

  const goodBlock = goodExamples.length
    ? `\n\nPAST GOOD PATTERNS (follow these):\n${goodExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  const badBlock = badExamples.length
    ? `\n\nAVOID THESE PAST MISTAKES:\n${badExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  // ⭐ KEY: prevent duplicates at generation time
  const existingBlock = recentQuestions.length
    ? `\n\n🚫 THESE QUESTIONS ALREADY EXIST — DO NOT generate anything similar:\n${recentQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nIMPORTANT: Your new questions must test COMPLETELY DIFFERENT facts/angles/concepts. Even if the topic is same, the specific fact being asked must be different.`
    : '';

  const prompt = `You are an expert question setter for India's top competitive exams (UPSC, JEE, NEET, SSC).

TASK: Generate exactly ${count} multiple-choice questions.

DETAILS:
- Exam Type: ${exam_type}
- Subject: ${subject}
- Chapter: ${chapter}
- Topic: ${topic || chapter}
- Difficulty: ${difficulty || 'hard'} (must be at ${exam_type} level or HARDER)
- Language: BOTH Hindi and English

REFERENCE EVIDENCE:
${evidence}
${goodBlock}${badBlock}${existingBlock}

CRITICAL RULES:
1. Each question must have EXACTLY 4 options
2. Only ONE option is correct
3. 100% factually accurate — no speculation
4. Hindi translation must be natural
5. Explanation must be detailed
6. Difficulty must match top exam level
7. ⭐ MAXIMUM DIVERSITY: Each question must test a DIFFERENT fact, angle, or concept. No two questions should test the same underlying fact.
8. ⭐ UNIQUE ANGLES: Prefer uncommon, specific, tricky facts over obvious ones. Avoid the most-asked standard questions.
9. ⭐ NO REPHRASING: Do not just reword an existing question — ask about a completely different detail.

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
  if (!initialKey) throw new Error('GEMINI_KEYS missing in environment.');

  const availableModels = await getAvailableGeminiModels(initialKey);
  let lastError = null;

  for (const model of availableModels) {
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
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${data?.error?.message || 'Unknown'}`);

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const cleaned = cleanJSONString(text);
      const parsed = JSON.parse(cleaned);
      const mcqs = Array.isArray(parsed?.mcqs) ? parsed.mcqs : (Array.isArray(parsed) ? parsed : []);

      if (mcqs.length === 0) throw new Error('No MCQs in response');
      return mcqs;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`All Gemini models failed: ${lastError?.message}`);
}

// ==========================================
// AI JUDGES (unchanged)
// ==========================================
async function callGeminiForJudge(prompt) {
  const initialKey = getRandomKey('GEMINI_KEYS');
  if (!initialKey) throw new Error('GEMINI_KEYS missing in environment.');
  const availableModels = await getAvailableGeminiModels(initialKey);
  let lastError = null;
  for (const model of availableModels) {
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
      return safeJsonParseAndValidate(text, AIJudgeResultSchema, `Gemini (${model})`);
    } catch (err) { lastError = err; }
  }
  throw new Error(`All Gemini models failed: ${lastError?.message}`);
}

async function judgeWithGemini(question, options, answerText, explanation, evidence) {
  const prompt = `Analyze this MCQ for factual accuracy based strictly on the provided evidence. EVIDENCE: ${evidence} QUESTION: ${question} OPTIONS: ${JSON.stringify(options)} ANSWER: ${answerText} EXPLANATION: ${explanation} Return JSON strictly: {"passed": boolean, "confidence": number (0-100), "options_quality": number (0-100), "question_quality": number (0-100), "explanation_valid": boolean, "contradiction": boolean, "evidence_sufficient": boolean, "unique_correct_option": boolean, "ambiguous": boolean, "reason": "short explanation"}`;
  return await callGeminiForJudge(prompt);
}

async function judgeWithDeepSeek(question, options, answerText, explanation, evidence) {
  const apiKey = getRandomKey('DEEPSEEK_KEYS');
  if (!apiKey) throw new Error('DEEPSEEK_KEYS missing in environment.');
  const activeModel = await getAvailableDeepSeekModel(apiKey);
  const prompt = `Analyze this MCQ for factual accuracy based ONLY on evidence provided. EVIDENCE: ${evidence} QUESTION: ${question} OPTIONS: A) ${options[0]} B) ${options[1]} C) ${options[2]} D) ${options[3]} SELECTED ANSWER: ${answerText} EXPLANATION: ${explanation} Return JSON strictly: {"passed": boolean, "confidence": number (0-100), "options_quality": number (0-100), "question_quality": number (0-100), "explanation_valid": boolean, "contradiction": boolean, "evidence_sufficient": boolean, "unique_correct_option": boolean, "ambiguous": boolean, "reason": "short explanation"}`;

  const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: activeModel, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    apiKeyUsed: apiKey
  });

  const resJson = await res.json();
  const content = resJson?.choices?.[0]?.message?.content;
  return safeJsonParseAndValidate(content, AIJudgeResultSchema, `DeepSeek (${activeModel})`);
}

function calculateQualityScore(judgeResult, modelAgreementScore) {
  const qQual = (Number(judgeResult?.question_quality) || 0) * 0.35;
  const oQual = (Number(judgeResult?.options_quality) || 0) * 0.35;
  const conf = (Number(judgeResult?.confidence) || 0) * 0.20;
  const agree = (Number(modelAgreementScore) || 0) * 0.10;
  return Math.round(Math.min(100, Math.max(0, qQual + oQual + conf + agree)));
}

// ==========================================
// VALIDATE RAW MCQ (unchanged)
// ==========================================
function validateRawMCQ(mcq) {
  if (!mcq || typeof mcq !== 'object' || Array.isArray(mcq)) {
    return { valid: false, reason: 'Invalid MCQ input', rawInput: mcq };
  }
  const result = RawMCQSchema.safeParse(mcq);
  if (!result.success) {
    return { valid: false, reason: result.error.issues.map(i => i.message).join('; '), rawInput: mcq };
  }
  const data = result.data;
  const hiOpts = [data.option_a_hi, data.option_b_hi, data.option_c_hi, data.option_d_hi];
  const enOpts = [data.option_a_en, data.option_b_en, data.option_c_en, data.option_d_en];

  if (new Set(hiOpts.map(normalizeMCQText)).size !== 4) return { valid: false, reason: 'Duplicate Hindi options', rawInput: mcq };
  if (new Set(enOpts.map(normalizeMCQText)).size !== 4) return { valid: false, reason: 'Duplicate English options', rawInput: mcq };

  let answerIdx = -1;
  if (typeof data.answer === 'number') answerIdx = data.answer;
  else if (typeof data.answer === 'string') {
    const normalizedAns = normalizeMCQText(data.answer);
    answerIdx = enOpts.findIndex(opt => normalizeMCQText(opt) === normalizedAns);
    if (answerIdx === -1) {
      const matchIdx = ['a', 'b', 'c', 'd', '0', '1', '2', '3'].indexOf(data.answer.toLowerCase().trim());
      if (matchIdx !== -1) answerIdx = matchIdx % 4;
    }
  }
  if (answerIdx === -1) return { valid: false, reason: 'Answer index not mapped', rawInput: mcq };

  return {
    valid: true,
    mcq: {
      question_hi: data.question_hi.trim(),
      question_en: data.question_en.trim(),
      option_a_hi: data.option_a_hi.trim(), option_a_en: data.option_a_en.trim(),
      option_b_hi: data.option_b_hi.trim(), option_b_en: data.option_b_en.trim(),
      option_c_hi: data.option_c_hi.trim(), option_c_en: data.option_c_en.trim(),
      option_d_hi: data.option_d_hi.trim(), option_d_en: data.option_d_en.trim(),
      answer: answerIdx,
      difficulty: (data.difficulty || 'medium').trim(),
      explanation_hi: (data.explanation_hi || '').trim(),
      explanation_en: (data.explanation_en || '').trim()
    }
  };
}

// ==========================================
// ⭐ ENHANCED: Multi-Layer Duplicate Filter
// ==========================================
async function filterDuplicates(items, chapter) {
  if (items.length === 0) return { unique: [], duplicates: [] };

  const db = getDb();

  // Compute all signals for each item
  const enriched = items.map(item => {
    const enOptions = [item.mcq.option_a_en, item.mcq.option_b_en, item.mcq.option_c_en, item.mcq.option_d_en];
    return {
      ...item,
      _fp: makeFingerprint(item.mcq.question_en, item.mcq.question_hi),
      _ofp: makeOrderedFingerprint(item.mcq.question_en, item.mcq.question_hi),
      _sigs: makeTrigramMinhash(item.mcq.question_en, item.mcq.question_hi),
      _optfp: makeOptionFingerprint(enOptions),
      _tokens: tokenize(`${item.mcq.question_en} ${item.mcq.question_hi}`)
    };
  });

  // ── Layer 1: Batch fingerprint exact match ──
  const fps = enriched.map(e => e._fp).filter(Boolean);
  const ofps = enriched.map(e => e._ofp).filter(Boolean);
  const optfps = enriched.map(e => e._optfp).filter(Boolean);

  const existingFps = new Set();
  const existingOfps = new Set();
  const existingOptFps = new Set();

  try {
    if (fps.length > 0) {
      const ph = fps.map(() => '?').join(',');
      const res = await db.execute({
        sql: `SELECT fingerprint FROM mcqs WHERE fingerprint IN (${ph})`,
        args: fps
      });
      res.rows.forEach(r => existingFps.add(r.fingerprint));
    }
  } catch (e) { console.warn('FP check failed:', e.message); }

  try {
    if (ofps.length > 0) {
      const ph = ofps.map(() => '?').join(',');
      const res = await db.execute({
        sql: `SELECT ordered_fp FROM mcqs WHERE ordered_fp IN (${ph})`,
        args: ofps
      });
      res.rows.forEach(r => existingOfps.add(r.ordered_fp));
    }
  } catch (e) { console.warn('OFP check failed:', e.message); }

  try {
    if (optfps.length > 0) {
      const ph = optfps.map(() => '?').join(',');
      const res = await db.execute({
        sql: `SELECT option_fp FROM mcqs WHERE option_fp IN (${ph})`,
        args: optfps
      });
      res.rows.forEach(r => existingOptFps.add(r.option_fp));
    }
  } catch (e) { console.warn('OPTFp check failed:', e.message); }

  // ── Layer 3: MinHash signature check ──
  // Get all (sig_index, sig_value) pairs and find matching mcq_ids
  const sigLookup = new Map(); // "idx:val" → Set<mcq_id>
  try {
    if (enriched.length > 0) {
      const pairs = [];
      for (let i = 0; i < enriched.length; i++) {
        for (let j = 0; j < MINHASH_COUNT; j++) {
          pairs.push({ idx: j, val: enriched[i]._sigs[j] });
        }
      }
      // Query in chunks to avoid huge IN clause
      const sigConditions = pairs.map(() => '(sig_index = ? AND sig_value = ?)').join(' OR ');
      const sigArgs = pairs.flatMap(p => [p.idx, p.val]);

      const res = await db.execute({
        sql: `SELECT mcq_id, sig_index, sig_value FROM mcq_signatures WHERE ${sigConditions}`,
        args: sigArgs
      });

      for (const r of res.rows) {
        const key = `${r.sig_index}:${r.sig_value}`;
        if (!sigLookup.has(key)) sigLookup.set(key, new Set());
        sigLookup.get(key).add(r.mcq_id);
      }
    }
  } catch (e) { console.warn('MinHash check failed:', e.message); }

  // Count matches per existing mcq_id
  const sigMatchCount = new Map(); // mcq_id → count
  for (let i = 0; i < enriched.length; i++) {
    const matchedIds = new Set();
    for (let j = 0; j < MINHASH_COUNT; j++) {
      const key = `${j}:${enriched[i]._sigs[j]}`;
      const ids = sigLookup.get(key);
      if (ids) ids.forEach(id => matchedIds.add(id));
    }
    for (const id of matchedIds) {
      sigMatchCount.set(id, (sigMatchCount.get(id) || 0) + 1);
    }
  }

  // Find any existing mcq with ≥ threshold matches
  const stronglySimilarIds = new Set();
  for (const [id, cnt] of sigMatchCount) {
    if (cnt >= MINHASH_MATCH_THRESHOLD) stronglySimilarIds.add(id);
  }

  // ── Layer 4: Jaccard against recent MCQs in same chapter ──
  let recentTokens = [];
  try {
    const res = await db.execute({
      sql: `SELECT question_en, question_hi FROM mcqs 
            WHERE chapter = ? 
            ORDER BY created_at DESC 
            LIMIT ?`,
      args: [chapter || '', RECENT_CHECK_LIMIT]
    });
    recentTokens = res.rows.map(r => tokenize(`${r.question_en} ${r.question_hi}`));
  } catch (e) { console.warn('Recent fetch failed:', e.message); }

  // ── Combine all layers ──
  const unique = [];
  const duplicates = [];
  const batchSeenFps = new Set();
  const batchSeenOfps = new Set();
  const batchSeenOptFps = new Set();
  const batchSeenTokens = [];

  for (const e of enriched) {
    // Layer 2: fingerprint exact
    if (e._fp && (existingFps.has(e._fp) || batchSeenFps.has(e._fp))) {
      duplicates.push({ ...e, reason: 'L2: fingerprint match' });
      continue;
    }

    // Layer 3a: ordered fingerprint
    if (e._ofp && (existingOfps.has(e._ofp) || batchSeenOfps.has(e._ofp))) {
      duplicates.push({ ...e, reason: 'L3a: ordered fingerprint match' });
      continue;
    }

    // Layer 3b: MinHash strong similarity
    if (stronglySimilarIds.size > 0) {
      // Check if THIS item matches any strong existing mcq
      const thisMatches = new Set();
      for (let j = 0; j < MINHASH_COUNT; j++) {
        const key = `${j}:${e._sigs[j]}`;
        const ids = sigLookup.get(key);
        if (ids) ids.forEach(id => thisMatches.add(id));
      }
      let maxMatch = 0;
      for (const id of thisMatches) {
        const cnt = sigMatchCount.get(id) || 0;
        if (cnt > maxMatch) maxMatch = cnt;
      }
      if (maxMatch >= MINHASH_MATCH_THRESHOLD) {
        duplicates.push({ ...e, reason: `L3b: minhash ${maxMatch}/${MINHASH_COUNT} match` });
        continue;
      }
    }

    // Layer 4: Jaccard vs recent
    let maxJaccard = 0;
    for (const recent of recentTokens) {
      const sim = jaccard(e._tokens, recent);
      if (sim > maxJaccard) maxJaccard = sim;
    }
    if (maxJaccard >= JACCARD_THRESHOLD) {
      duplicates.push({ ...e, reason: `L4: jaccard ${maxJaccard.toFixed(2)} vs recent` });
      continue;
    }

    // Layer 4b: Jaccard vs batch (within this generation)
    let maxBatchJaccard = 0;
    for (const existing of batchSeenTokens) {
      const sim = jaccard(e._tokens, existing);
      if (sim > maxBatchJaccard) maxBatchJaccard = sim;
    }
    if (maxBatchJaccard >= JACCARD_THRESHOLD) {
      duplicates.push({ ...e, reason: `L4b: jaccard ${maxBatchJaccard.toFixed(2)} within batch` });
      continue;
    }

    // Layer 5: Option fingerprint + answer match (weaker signal)
    if (e._optfp && (existingOptFps.has(e._optfp) || batchSeenOptFps.has(e._optfp))) {
      // Only reject if we already have multiple signals
      // Just option match alone isn't conclusive (some facts have same options)
      // Skip this for now to avoid false positives
    }

    // PASSED ALL LAYERS
    if (e._fp) batchSeenFps.add(e._fp);
    if (e._ofp) batchSeenOfps.add(e._ofp);
    if (e._optfp) batchSeenOptFps.add(e._optfp);
    batchSeenTokens.push(e._tokens);
    unique.push(e);
  }

  return { unique, duplicates };
}

// ==========================================
// VALIDATE + JUDGE + SAVE
// ==========================================
async function validateJudgeAndSave({ exam_type, subject, chapter, topic, rawMCQsInput, evidenceText }) {
  const db = getDb();
  const safeEvidence = typeof evidenceText === 'string' ? evidenceText.slice(0, 10000) : '';
  const rejectedMCQs = [];

  const safeInputArray = Array.isArray(rawMCQsInput) ? rawMCQsInput : [];

  const initialValidated = safeInputArray
    .map(validateRawMCQ)
    .filter(r => {
      if (!r || !r.valid) {
        const qTitle = r?.rawInput?.question_en || r?.rawInput?.question_hi || 'Unknown';
        const reason = `Structural: ${r?.reason || 'Invalid structure'}`;
        rejectedMCQs.push({ question: qTitle, reason });
        saveLearnBad(qTitle, reason, 0).catch(() => {});
        return false;
      }
      return true;
    })
    .map(r => r.mcq);

  if (initialValidated.length === 0) {
    return { success: false, count: 0, rejectedTotal: rejectedMCQs.length, rejectedDetails: rejectedMCQs };
  }

  const approvedMCQs = [];
  const chunks = chunkArray(initialValidated, BATCH_CONCURRENCY);

  for (let i = 0; i < chunks.length; i++) {
    const chunkPromises = chunks[i].map(async (mcq) => {
      try {
        const enOptions = [mcq.option_a_en, mcq.option_b_en, mcq.option_c_en, mcq.option_d_en];
        const answerText = enOptions[mcq.answer];

        const geminiResult = await judgeWithGemini(mcq.question_en, enOptions, answerText, mcq.explanation_en, safeEvidence);
        let final = geminiResult;
        let agreement = 50;

        if (!geminiResult.passed || geminiResult.confidence < 90 || geminiResult.ambiguous || !geminiResult.evidence_sufficient) {
          try {
            const deepResult = await judgeWithDeepSeek(mcq.question_en, enOptions, answerText, mcq.explanation_en, safeEvidence);
            if (geminiResult.passed !== deepResult.passed) {
              rejectedMCQs.push({ question: mcq.question_en, reason: 'Model disagreement' });
              saveLearnBad(mcq.question_en, 'Model disagreement', 0).catch(() => {});
              return null;
            }
            agreement = 100;
            if (geminiResult.passed && deepResult.passed) {
              final = { ...geminiResult, confidence: Math.min(geminiResult.confidence, deepResult.confidence) };
            }
          } catch (e) {
            rejectedMCQs.push({ question: mcq.question_en, reason: 'DeepSeek failed: ' + e.message });
            saveLearnBad(mcq.question_en, 'DeepSeek failed', 0).catch(() => {});
            return null;
          }
        }

        if (!final || !final.passed || final.contradiction || !final.explanation_valid ||
            !final.evidence_sufficient || !final.unique_correct_option || final.ambiguous) {
          const reason = final?.reason || 'Quality gate failed';
          rejectedMCQs.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, 0).catch(() => {});
          return null;
        }

        const score = calculateQualityScore(final, agreement);
        if (score < QUALITY_GATE) {
          const reason = `Score ${score} < ${QUALITY_GATE}`;
          rejectedMCQs.push({ question: mcq.question_en, reason });
          saveLearnBad(mcq.question_en, reason, score).catch(() => {});
          return null;
        }

        return { mcq, score, judgeReason: final.reason || '' };
      } catch (e) {
        rejectedMCQs.push({ question: mcq.question_en, reason: `Error: ${e.message}` });
        return null;
      }
    });

    approvedMCQs.push(...(await Promise.all(chunkPromises)).filter(Boolean));
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  if (approvedMCQs.length === 0) {
    return { success: false, count: 0, rejectedTotal: rejectedMCQs.length, rejectedDetails: rejectedMCQs };
  }

  // ⭐ Layer 1: hash dedup within batch
  const hashMap = new Map();
  for (const item of approvedMCQs) {
    const hash = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    if (!hashMap.has(hash)) hashMap.set(hash, item);
  }

  // ⭐ Layers 2-5: multi-signal dedup
  const hashUnique = [...hashMap.values()];
  const { unique: uniqueItems, duplicates: dupItems } = await filterDuplicates(hashUnique, chapter);

  for (const dup of dupItems) {
    rejectedMCQs.push({ question: dup.mcq.question_en, reason: dup.reason });
    saveLearnBad(dup.mcq.question_en, dup.reason, 0).catch(() => {});
  }

  if (uniqueItems.length === 0) {
    return { success: false, count: 0, rejectedTotal: rejectedMCQs.length, rejectedDetails: rejectedMCQs };
  }

  // ⭐ INSERT with all new signals
  const insertVals = uniqueItems.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  const args = [];
  const insertSignatures = [];

  for (const item of uniqueItems) {
    const id = randomUUID();
    const hash = createHash('sha256').update(normalizeMCQText(item.mcq.question_en)).digest('hex');
    const fingerprint = makeFingerprint(item.mcq.question_en, item.mcq.question_hi);
    const orderedFp = makeOrderedFingerprint(item.mcq.question_en, item.mcq.question_hi);
    const trigramSigs = makeTrigramMinhash(item.mcq.question_en, item.mcq.question_hi);
    const optionFp = makeOptionFingerprint([
      item.mcq.option_a_en, item.mcq.option_b_en, item.mcq.option_c_en, item.mcq.option_d_en
    ]);
    const isGold = item.score >= GOLD_THRESHOLD ? 1 : 0;

    args.push(
      id,
      exam_type || '',
      subject || '',
      chapter || '',
      topic || '',
      item.mcq.difficulty,
      item.mcq.question_hi, item.mcq.question_en,
      item.mcq.option_a_hi, item.mcq.option_a_en,
      item.mcq.option_b_hi, item.mcq.option_b_en,
      item.mcq.option_c_hi, item.mcq.option_c_en,
      item.mcq.option_d_hi, item.mcq.option_d_en,
      item.mcq.answer,
      item.mcq.explanation_hi, item.mcq.explanation_en,
      hash,
      fingerprint,
      orderedFp,
      trigramSigs.join(','),
      optionFp,
      item.score,
      isGold,
      null, null,
      Math.floor(Math.random() * 2147483647),
      1, null,
      Date.now()
    );

    // Queue signatures
    for (let j = 0; j < MINHASH_COUNT; j++) {
      insertSignatures.push({
        sql: 'INSERT OR IGNORE INTO mcq_signatures (mcq_id, sig_index, sig_value) VALUES (?, ?, ?)',
        args: [id, j, trigramSigs[j]]
      });
    }
  }

  const sql = `
    INSERT INTO mcqs (
      id, exam_type, subject, chapter, topic, difficulty,
      question_hi, question_en,
      option_a_hi, option_a_en,
      option_b_hi, option_b_en,
      option_c_hi, option_c_en,
      option_d_hi, option_d_en,
      answer, explanation_hi, explanation_en,
      hash, fingerprint, ordered_fp, trigram_fp, option_fp,
      quality_score, is_gold,
      source_url, retrieval_score, random_key, version, parent_qid, created_at
    )
    VALUES ${insertVals}
    ON CONFLICT(hash) DO NOTHING;
  `;

  try {
    await db.execute({ sql, args });
  } catch (error) {
    throw new Error(`MCQ insert failed: ${safeDbError(error).message}`);
  }

  // ⭐ Save signatures for future dedup
  try {
    if (insertSignatures.length > 0) {
      await db.batch(insertSignatures);
    }
  } catch (e) {
    console.warn('Signature save failed:', e.message);
  }

  for (const item of uniqueItems) {
    if (item.score >= 90 && item.judgeReason) {
      saveLearnGood(null, item.judgeReason, item.score).catch(() => {});
    }
  }

  return {
    success: true,
    count: uniqueItems.length,
    rejectedTotal: rejectedMCQs.length,
    rejectedDetails: rejectedMCQs
  };
}

// ==========================================
// MAIN: GENERATE FROM SCRATCH
// ==========================================
export async function generateFromScratch({ exam_type, subject, chapter, topic, difficulty, count }) {
  console.log(`🚀 [ENGINE] ${exam_type}/${subject}/${chapter} — ${count} MCQs`);

  let evidence = null;
  try {
    evidence = await retrieveEvidence(subject, chapter);
  } catch (e) {
    console.warn('⚠️ Evidence fetch failed:', e.message);
  }

  if (!evidence || evidence.length < MIN_EVIDENCE_LENGTH) {
    console.error(`❌ Evidence insufficient (${evidence?.length || 0})`);
    return {
      success: false,
      error: 'EVIDENCE_FETCH_FAILED',
      message: `Evidence too short (${evidence?.length || 0} chars)`,
      count: 0
    };
  }

  console.log(`✅ Evidence: ${evidence.length} chars`);

  let rawMCQs;
  try {
    rawMCQs = await generateDraft({ subject, chapter, topic, exam_type, difficulty, count, evidence });
    console.log(`✅ Generated ${rawMCQs.length} drafts`);
  } catch (e) {
    console.error('❌ generateDraft failed:', e.message);
    return { success: false, error: `generateDraft failed: ${e.message}`, count: 0 };
  }

  if (!rawMCQs || rawMCQs.length === 0) {
    return { success: false, error: 'AI generated 0 MCQs', count: 0 };
  }

  const result = await validateJudgeAndSave({
    exam_type, subject, chapter, topic,
    rawMCQsInput: rawMCQs,
    evidenceText: evidence
  });

  console.log(`✅ Done: saved ${result.count}, rejected ${result.rejectedTotal}`);
  return result;
}

export { loadGoodExamples, loadBadExamples };
