// ============================================================
// lib/mcq-engine.js — Fully Inlined (Local PDFs + Network Fallback)
// ============================================================

import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { getDb, safeDbError } from './db.js';
import fs from 'fs';
import path from 'path';

export function parseRobotsTxt(input, userAgent = 'MCQResearchBot') {
  const sourceText = String(input || '');
  const lines = sourceText.split(/\r?\n/);
  const groups = []; const sitemaps = []; let current = null; let directivesStarted = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase(); const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') { if (/^https:\/\//i.test(value)) sitemaps.push(value); continue; }
    if (key === 'user-agent') {
      if (!current || directivesStarted) { current = { agents: [], rules: [], crawlDelay: 0 }; groups.push(current); directivesStarted = false; }
      current.agents.push(value.toLowerCase()); continue;
    }
    if (!current) continue;
    directivesStarted = true;
    if (key === 'allow' || key === 'disallow') { if (value) current.rules.push({ type: key, path: value }); }
    else if (key === 'crawl-delay') { const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) current.crawlDelay = Math.max(current.crawlDelay, seconds); }
  }
  const meaningful = sourceText.split(/\r?\n/).map(x => x.replace(/#.*/, '').trim()).filter(Boolean);
  if (meaningful.length > 0 && !(groups.length > 0 || sitemaps.length > 0)) return { denyAll: true, invalid: true, rules: [], crawlDelaySeconds: 0, sitemaps: [] };
  const agent = String(userAgent || '').toLowerCase();
  const matching = groups.flatMap(g => g.agents.filter(a => a !== '*' && a && agent.includes(a)).map(a => ({ group: g, token: a })));
  const maxSpecificity = matching.reduce((max, item) => Math.max(max, item.token.length), 0);
  const exact = maxSpecificity ? matching.filter(item => item.token.length === maxSpecificity).map(item => item.group) : [];
  const wildcard = groups.filter(g => g.agents.includes('*'));
  const selected = exact.length ? [...new Set(exact)] : wildcard;
  return { denyAll: false, rules: selected.flatMap(g => g.rules), crawlDelaySeconds: selected.reduce((max, g) => Math.max(max, g.crawlDelay || 0), 0), sitemaps: [...new Set(sitemaps)].slice(0, 30) };
}
function ruleMatches(rulePath, requestPath) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$'); const raw = anchored ? rulePath.slice(0, -1) : rulePath;
  const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(requestPath); } catch { return requestPath.startsWith(rulePath.replace(/\*|\$/g, '')); }
}
export function isRobotsPathAllowed(policy, value) {
  if (!policy || policy.denyAll) return false;
  let url; try { url = new URL(value); } catch { return false; }
  const requestPath = `${url.pathname || '/'}${url.search || ''}`;
  const matches = (policy.rules || []).filter(rule => ruleMatches(rule.path, requestPath)).sort((a, b) => b.path.length - a.path.length || (a.type === 'allow' ? -1 : 1));
  return matches.length === 0 || matches[0].type === 'allow';
}
export function createHostPacer({ now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const queues = new Map(); const nextAt = new Map();
  return async function run(hostValue, delayMs, request, deadline = Infinity) {
    const host = String(hostValue || '').toLowerCase(); if (!host) throw new Error('HOST_REQUIRED');
    const previous = queues.get(host) || Promise.resolve(); let release; const gate = new Promise(resolve => { release = resolve; });
    queues.set(host, gate); await previous.catch(() => {});
    try {
      const wait = Math.max(0, (nextAt.get(host) || 0) - now());
      if (now() + wait > deadline) throw new Error('DEADLINE_EXCEEDED');
      if (wait > 0) await sleep(wait);
      if (now() > deadline) throw new Error('DEADLINE_EXCEEDED');
      nextAt.set(host, now() + Math.max(1000, Number(delayMs) || 1000));
      return await request();
    } finally { release(); if (queues.get(host) === gate) queues.delete(host); }
  };
}

export function isAutoApprovalEligible({ verificationTier, score, maxTier = 1, minScore = 93, sourceTrusted = false } = {}) {
  const tier = Number(verificationTier); const quality = Number(score); const allowedTier = Number(maxTier); const threshold = Number(minScore);
  if (sourceTrusted !== true) return false;
  if (![tier, quality, allowedTier, threshold].every(Number.isFinite)) return false;
  if (tier < 1 || tier > 3 || allowedTier < 1 || allowedTier > 3) return false;
  return tier <= allowedTier && quality >= threshold;
}

export const PYQ_REGISTRY = [];
function _pyqNormalize(text) { return String(text || '').toLowerCase().normalize('NFKC').replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '); }
function _pyqTrigrams(text) { const n = _pyqNormalize(text); if (!n) return []; const p = `  ${n}  `; const out = new Set(); for (let i = 0; i <= p.length - 3; i++) out.add(p.slice(i, i + 3)); return [...out]; }
function _pyqHash32(value) { let hash = 2166136261; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
export function makePYQSignature(text, numHashes = 64) {
  const grams = _pyqTrigrams(text); if (!grams.length) return '';
  const sig = new Array(numHashes).fill(0xffffffff);
  for (const g of grams) { for (let i = 0; i < numHashes; i++) { const h = _pyqHash32(`${i}:${g}`); if (h < sig[i]) sig[i] = h; } }
  return sig.join(',');
}
export function pyqSignatureSimilarity(sigA, sigB) {
  if (!sigA || !sigB) return 0; const a = sigA.split(',').map(Number); const b = sigB.split(',').map(Number);
  const len = Math.min(a.length, b.length); if (!len || a.some(Number.isNaN) || b.some(Number.isNaN)) return 0;
  let m = 0; for (let i = 0; i < len; i++) if (a[i] === b[i]) m++; return m / len;
}

const QUALITY_GATE = Math.max(70, Math.min(98, Number(process.env.MCQ_QUALITY_GATE || 90)));
const AUTO_APPROVE_TIER = Math.max(1, Math.min(3, Number(process.env.MCQ_AUTO_APPROVE_TIER || '1')));
const AUTO_APPROVE_MIN_SCORE = Math.max(0, Math.min(100, Number(process.env.MCQ_AUTO_APPROVE_MIN_SCORE || '93')));
const MAX_SAVE_RATE = Math.max(0.05, Math.min(0.50, Number(process.env.MCQ_MAX_SAVE_RATE || 0.15))); 
const GOLD_THRESHOLD = 95;
const BATCH_CONCURRENCY = 2;
const BATCH_DELAY_MS = 1500;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TRANSIENT_429_COOLDOWN = 60 * 1000;
const FORBIDDEN_KEY_COOLDOWN = 60 * 60 * 1000;
const MIN_EVIDENCE_LENGTH = 200;
const FINGERPRINT_WORDS = 15;

const TRUSTED_EVIDENCE_HOSTS = new Set([
  'ncert.nic.in', 'ncertbooks.ncert.gov.in', 'epathshala.nic.in', 'education.gov.in', 'upsc.gov.in', 'nios.ac.in', 'ignou.ac.in',
  'indiaculture.gov.in', 'knowindia.india.gov.in', 'india.gov.in', 'pib.gov.in', 'rbi.org.in', 'legislative.gov.in', 'indiacode.nic.in',
  'mha.gov.in', 'mof.gov.in', 'finmin.nic.in', 'mospi.gov.in', 'swayam.gov.in', 'diksha.gov.in'
]);

function isTrustedEvidenceUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    if (u.protocol === 'local:') return true;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'gov.in' || host === 'nic.in') return false;
    if (host.endsWith('.gov.in') || host.endsWith('.nic.in')) return true;
    return [...TRUSTED_EVIDENCE_HOSTS].some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function normalizeAnswerIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase(); const map = { a: 0, b: 1, c: 2, d: 3, '0': 0, '1': 1, '2': 2, '3': 3 };
  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : null;
}

const TRIGRAM_SIMILARITY_THRESHOLD = 0.75;
const WORDSET_SIMILARITY_THRESHOLD = 0.80;
const RECENT_QUESTIONS_FOR_PROMPT = 30;
const RECENT_QUESTIONS_TO_CHECK = 200;
const TRIGRAM_HASHES = 32;

let cachedGeminiModels = { data: null, timestamp: 0 };
let cachedDeepSeekModel = { data: null, timestamp: 0 };
const disabledKeys = new Map();
const sourceRobotsCache = new Map();
const sourceHostNextRequestAt = new Map();
const runPacedHostRequest = createHostPacer();
const sourceHostCooldownUntil = new Map();
const SOURCE_ROBOTS_TTL_MS = 12 * 60 * 60 * 1000;
const SOURCE_ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;
const configuredSourceDelay = Number(process.env.MCQ_SOURCE_MIN_HOST_DELAY_MS || 1200);
const SOURCE_MIN_HOST_DELAY_MS = Number.isFinite(configuredSourceDelay) ? Math.min(60000, Math.max(1000, configuredSourceDelay)) : 1200;
const SOURCE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sourceHostStateTableAvailable = null;

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being','and','or','but','if','then','than','of','in','on','at','to','for','from','with','without','by','as','into','about','over','which','who','whom','whose','that','this','these','those','what','when','where','why','how','all','any','both','each','few','more','most','other','some','such','no','nor','not','only','own','same','so','too','very','can','will','just','है','हैं','का','की','के','को','से','में','पर','और','या','यह','वह','ये','वे','कौन','क्या','कब','कहाँ','कैसे']);

const RawMCQSchema = z.object({ question_hi: z.string().min(10), question_en: z.string().min(10), option_a_hi: z.string().min(1), option_a_en: z.string().min(1), option_b_hi: z.string().min(1), option_b_en: z.string().min(1), option_c_hi: z.string().min(1), option_c_en: z.string().min(1), option_d_hi: z.string().min(1), option_d_en: z.string().min(1), answer: z.union([z.number().int().min(0).max(3), z.string().trim().min(1)]), difficulty: z.string().optional().default('medium'), explanation_hi: z.string().optional().default(''), explanation_en: z.string().optional().default('') });
const AIJudgeResultSchema = z.object({ passed: z.boolean(), confidence: z.number().min(0).max(100), options_quality: z.number().min(0).max(100), question_quality: z.number().min(0).max(100), explanation_valid: z.boolean(), contradiction: z.boolean(), evidence_sufficient: z.boolean(), unique_correct_option: z.boolean(), ambiguous: z.boolean(), reason: z.string().optional() });
const SolverResultSchema = z.object({ calculated_answer: z.number().int().min(0).max(3), confidence: z.number().min(0).max(100), reasoning_summary: z.string().min(3) });
const AdversarialReviewOnlySchema = z.object({ passed: z.boolean(), defects: z.array(z.string()).max(12), multiple_correct_options: z.boolean(), stem_mismatch: z.boolean(), ambiguity: z.boolean(), explanation_defect: z.boolean(), reason: z.string().optional().default('') });
const StructuralReviewOnlySchema = z.object({ passed: z.boolean(), stem_qualifier_match: z.boolean(), distractors_plausible_but_wrong: z.boolean(), distractor_justifications: z.array(z.string()).min(4).max(4), evidence_entails_explanation: z.boolean(), unsupported_claims: z.array(z.string()).max(12), defects: z.array(z.string()).max(12), confidence: z.number().min(0).max(100), reason: z.string().optional().default('') });
const CritiqueReviewOnlySchema = z.object({ has_defect: z.boolean(), defect_classes: z.array(z.string()).max(9), reason: z.string().optional().default('') });
const ChapterMatchSchema = z.object({ belongs: z.boolean(), actual_chapter: z.string().optional(), confidence: z.number().min(0).max(100).optional().default(50) });
const ChapterListSchema = z.object({ chapters: z.array(z.string().min(3)).min(3).max(50) });

function getRandomKey(envVarName) {
  const rawKeys = [...new Set((process.env[envVarName] ?? '').split(',').map(k => k.trim()).filter(Boolean))];
  if (rawKeys.length === 0) return null;
  const now = Date.now();
  const activeKeys = rawKeys.filter(key => {
    const until = disabledKeys.get(key);
    if (until === Infinity) return false;
    if (typeof until === 'number' && now < until) return false;
    if (until !== undefined) disabledKeys.delete(key);
    return true;
  });
  return activeKeys.length ? activeKeys[Math.floor(Math.random() * activeKeys.length)] : null;
}
function utcMidnightTimestamp() { const now = new Date(); return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); }
async function classifyKeyFailure(response, apiKeyUsed) {
  if (!apiKeyUsed) return { quotaExhausted: false };
  if (response.status === 401) { disabledKeys.set(apiKeyUsed, Infinity); return { quotaExhausted: false }; }
  if (response.status === 403) { disabledKeys.set(apiKeyUsed, Date.now() + FORBIDDEN_KEY_COOLDOWN); return { quotaExhausted: false }; }
  if (response.status === 429) {
    let detail = ''; try { detail = JSON.stringify(await response.clone().json()).toLowerCase(); } catch {}
    const isQuotaExhausted = /quota|daily.?limit|resource_exhausted|limit: 0/.test(detail);
    disabledKeys.set(apiKeyUsed, isQuotaExhausted ? utcMidnightTimestamp() : Date.now() + TRANSIENT_429_COOLDOWN);
    return { quotaExhausted: isQuotaExhausted };
  }
  return { quotaExhausted: false };
}
function scrubSecrets(value) {
  let text = String(value ?? '');
  const secrets = [...String(process.env.GEMINI_KEYS || '').split(/[\s,;]+/), ...String(process.env.DEEPSEEK_KEYS || '').split(/[\s,;]+/)].filter(v => v.length >= 8);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/([?&](?:key|api-key|api_key|access_token|token)=)[^&\s]+/gi, '$1[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]').slice(0, 500);
}

async function fetchWithRetry(resource, options = {}, retries = 3, backoffMs = 1000) {
  const { timeout = 20000, apiKeyUsed = null, ...fetchOptions } = options; let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController(); const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(resource, { ...fetchOptions, signal: controller.signal });
      const keyFailure = await classifyKeyFailure(response, apiKeyUsed);
      if (response.status === 429 && attempt < retries && !keyFailure?.quotaExhausted) {
        clearTimeout(id); const ra = Number(response.headers.get('retry-after')); const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : backoffMs * Math.pow(2, attempt - 1);
        try { await response.body?.cancel(); } catch {} await new Promise(r => setTimeout(r, delay)); continue;
      }
      if ([500, 502, 503, 504].includes(response.status) && attempt < retries) {
        clearTimeout(id); try { await response.body?.cancel(); } catch {} await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt - 1))); continue;
      }
      let timerReleased = false; const releaseTimer = () => { if (!timerReleased) { timerReleased = true; clearTimeout(id); } };
      for (const m of ['json', 'text', 'arrayBuffer']) { const orig = response[m]?.bind(response); if (orig) response[m] = async (...args) => { try { return await orig(...args); } finally { releaseTimer(); } }; }
      return response;
    } catch (err) { clearTimeout(id); lastError = new Error(scrubSecrets(err?.message || err)); if (attempt === retries) throw lastError; await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt - 1))); }
  }
  throw lastError || new Error('Request failed');
}

function cleanJSONString(text) { if (!text) return ''; const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/); return m ? m[0] : text.replace(/```json/gi, '').replace(/```/g, '').trim(); }
function safeJsonParseAndValidate(text, schema, ctx = 'API') {
  if (!text) throw new Error(`[${ctx}] Empty response`); const cleaned = cleanJSONString(text);
  try { const parsed = JSON.parse(cleaned); const v = schema.safeParse(parsed); if (!v.success) throw new Error(`Schema error`); return v.data; } catch (err) { throw new Error(`[${ctx}] ${err.message}`); }
}
function normalizeMCQText(text) { return text ? text.toString().toLowerCase().trim().replace(/[^\w\s\u0900-\u097F]/gi, '').replace(/\s+/g, ' ') : ''; }
function makeFingerprint(en, hi) { const words = normalizeMCQText(`${en || ''} ${hi || ''}`).split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w)); return [...new Set(words)].sort().slice(0, FINGERPRINT_WORDS).join('|'); }
function chunkArray(arr, size) { const c = []; for (let i = 0; i < arr.length; i += size) c.push(arr.slice(i, i + size)); return c; }
function hashString(str) { let h = 0; for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0; return Math.abs(h); }
function makeTrigrams(text) { const n = normalizeMCQText(text); const g = new Set(); for (let i = 0; i < n.length - 2; i++) g.add(n.substring(i, i + 3)); return [...g]; }
export function makeTrigramSignature(text, numHashes = TRIGRAM_HASHES) { const g = makeTrigrams(text); if (!g.length) return ''; const s = new Array(numHashes).fill(Infinity); for (const x of g) for (let i = 0; i < numHashes; i++) { const h = hashString(`${i}:${x}`); if (h < s[i]) s[i] = h; } return s.join(','); }
function signatureSimilarity(a, b) { if (!a || !b) return 0; const x = a.split(',').map(Number), y = b.split(',').map(Number); const len = Math.min(x.length, y.length); if (!len) return 0; let m = 0; for (let i = 0; i < len; i++) if (x[i] === y[i]) m++; return m / len; }
export function makeWordSetFp(text) { const w = normalizeMCQText(text).split(' ').filter(x => x.length > 3 && !STOPWORDS.has(x)); return [...new Set(w)].sort().slice(0, 30).join('|'); }
function wordSetSimilarity(a, b) { if (!a || !b) return 0; const x = new Set(a.split('|')), y = new Set(b.split('|')); let inter = 0; for (const w of x) if (y.has(w)) inter++; const union = new Set([...x, ...y]).size; return union ? inter / union : 0; }

// ==========================================
// EVIDENCE RETRIEVER (LOCAL PDF + NETWORK FALLBACK)
// ==========================================
export async function retrieveEvidence(category, section, subject, chapter) {
  const diagnostics = [], MIN_TEXT = MIN_EVIDENCE_LENGTH, MAX_TOTAL_MS = 45000, startedAt = Date.now();
  let evidenceDb = null; const getEvidenceDb = () => evidenceDb || (evidenceDb = getDb());
  const MAX_PDF_BYTES = 12 * 1024 * 1024;
  const safe = v => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const clean = v => safe(String(v || '').replace(/https?:\/\/\S+/g, ' '));
  const validText = t => typeof t === 'string' && t.length >= MIN_TEXT && !/(page not found|404 not found|access denied|captcha required|enable javascript to continue|temporarily unavailable|checking your browser|robot check)/i.test(t);
  const TOPIC_ALIASES = { 'इतिहास': ['history'], 'भूगोल': ['geography'], 'राजव्यवस्था': ['polity'], 'राजनीति': ['polity'], 'संविधान': ['constitution'], 'अर्थव्यवस्था': ['economy'], 'अर्थशास्त्र': ['economics'], 'विज्ञान': ['science'], 'जीवविज्ञान': ['biology'], 'भौतिकी': ['physics'], 'रसायन': ['chemistry'], 'भारत': ['india'] };
  const tokensFor = v => { const raw = String(v || '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).map(x => x.trim()).filter(x => x.length >= 3 && !new Set(['chapter','subject','general','studies','विषय','lesson']).has(x)); const exp = [...raw]; for (const t of raw) exp.push(...(TOPIC_ALIASES[t] || [])); return [...new Set(exp.filter(x => x.length >= 3))]; };
  const subjectTokens = tokensFor(subject), chapterTokens = tokensFor(chapter), queryTokens = [...new Set([...subjectTokens, ...chapterTokens])];
  
  const relevantEnough = (text, url = '') => { 
    const corpus = `${String(text || '').slice(0, 18000)} ${String(url || '').replace(/[-_/.?=&]/g, ' ')}`.toLocaleLowerCase(); 
    const hC = chapterTokens.length === 0 || chapterTokens.some(t => corpus.includes(t)); 
    const hS = subjectTokens.length === 0 || subjectTokens.some(t => corpus.includes(t)); 
    return queryTokens.length === 0 ? true : (hC || hS); 
  };
  
  const chapterKey = createHash('sha256').update([category, section, subject, chapter].map(v => safe(v).toLocaleLowerCase()).join('\u0000')).digest('hex');
  const db = getEvidenceDb();
  const safeSubject = safe(subject), safeChapter = safe(chapter);
  
  // 1. Cache check
  try {
    const cached = await db.execute({ sql: 'SELECT extracted_text, source_url, extraction_method, downloaded_at FROM knowledge_base WHERE chapter_key = ? LIMIT 1', args: [chapterKey] });
    const row = cached.rows?.[0]; const age = row ? Date.now() - Number(row.downloaded_at || 0) : Infinity;
    if (row && validText(String(row.extracted_text || '')) && age >= 0 && age <= CACHE_TTL) {
      return { text: String(row.extracted_text).slice(0, 18000), sourceUrl: String(row.source_url), retryable: false, extractionMethod: row.extraction_method || 'cached', diagnostics: ['Loaded from cache'] };
    }
  } catch (e) {}

  // 2. LOCAL PDFs CHECK
  const localPdfDir = path.join(process.cwd(), 'pdfs');
  if (fs.existsSync(localPdfDir)) {
    const files = fs.readdirSync(localPdfDir);
    for (const file of files) {
      if (!file.endsWith('.pdf')) continue;
      try {
        const buffer = fs.readFileSync(path.join(localPdfDir, file));
        let pageText = '';
        const mod = await import('pdf-parse');
        const parse = mod.default || mod.pdf || mod;
        if (typeof parse === 'function') {
          const p = await parse(buffer);
          pageText = clean(p?.text || '');
        }

        if (validText(pageText) && relevantEnough(pageText, file)) {
          const citationUrl = `local://${file}`;
          try { 
            await db.execute({ 
              sql: `INSERT INTO knowledge_base (chapter_key, subject, chapter, source_url, extracted_text, extraction_method, downloaded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chapter_key) DO UPDATE SET extracted_text=excluded.extracted_text, downloaded_at=excluded.downloaded_at`, 
              args: [chapterKey, safeSubject, safeChapter, citationUrl, pageText.slice(0, 18000), 'local-pdf-parse', Date.now()] 
            }); 
          } catch (e) {}
          return { text: pageText.slice(0, 18000), sourceUrl: citationUrl, retryable: false, evidenceType: 'local-pdf', extractionMethod: 'pdf-parse', diagnostics: [`Success from local: ${file}`] };
        }
      } catch (e) { diagnostics.push(`Local err: ${file}`); }
    }
  }

  // 3. NETWORK FALLBACK (Hardcoded URLs)
  const HARDCODED_URLS = `
  polity::https://ncert.nic.in/textbook/pdf/jess301.pdf
  polity::https://ncert.nic.in/textbook/pdf/jess302.pdf
  polity::https://ncert.nic.in/textbook/pdf/keps101.pdf
  history::https://ncert.nic.in/textbook/pdf/jess201.pdf
  history::https://ncert.nic.in/textbook/pdf/jess202.pdf
  history::https://ncert.nic.in/textbook/pdf/lehs101.pdf
  geography::https://ncert.nic.in/textbook/pdf/jess401.pdf
  geography::https://ncert.nic.in/textbook/pdf/kegy201.pdf
  economy::https://ncert.nic.in/textbook/pdf/keec101.pdf
  economy::https://ncert.nic.in/textbook/pdf/keec102.pdf
  science::https://ncert.nic.in/textbook/pdf/jesc101.pdf
  science::https://ncert.nic.in/textbook/pdf/jesc102.pdf
  biology::https://ncert.nic.in/textbook/pdf/kebo101.pdf
  physics::https://ncert.nic.in/textbook/pdf/keph101.pdf
  chemistry::https://ncert.nic.in/textbook/pdf/kech101.pdf
  `;

  const candidates = [];
  for (const rawEntry of String(HARDCODED_URLS).split(/[\n,;]/)) {
    const entry = rawEntry.trim(); if (!entry) continue; 
    const splitAt = entry.indexOf('::'); 
    const rawUrl = splitAt >= 0 ? entry.slice(splitAt + 2).trim() : entry; 
    try { const u = new URL(rawUrl); if (u.protocol === 'https:') candidates.push(rawUrl); } catch(e) {}
  }

  let checked = 0;
  for (const url of candidates) {
    if (checked >= 5 || Date.now() - startedAt > MAX_TOTAL_MS) break; checked++;
    try {
      const proxyUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(proxyUrl, { headers: { 'Accept': 'text/plain', 'User-Agent': SOURCE_USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { diagnostics.push(`Proxy HTTP ${response.status}`); continue; }
      
      const pageText = clean(await response.text());
      if (!validText(pageText)) { diagnostics.push(`Extract fail (${pageText.length} chars)`); continue; }
      if (!relevantEnough(pageText, url)) { diagnostics.push(`Topic mismatch`); continue; }
      
      try { 
        await db.execute({ 
          sql: `INSERT INTO knowledge_base (chapter_key, subject, chapter, source_url, extracted_text, extraction_method, downloaded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chapter_key) DO UPDATE SET extracted_text=excluded.extracted_text, downloaded_at=excluded.downloaded_at`, 
          args: [chapterKey, safeSubject, safeChapter, url, pageText.slice(0, 18000), 'jina-proxy', Date.now()] 
        }); 
      } catch (e) {}
      return { text: pageText.slice(0, 18000), sourceUrl: url, retryable: false, evidenceType: 'pdf', extractionMethod: 'jina-proxy', diagnostics: ['Fetched via Proxy'] };
    } catch (e) { diagnostics.push(`Proxy fail: ${scrubSecrets(e.message).slice(0, 50)}`); }
  }
  
  return { text: null, sourceUrl: null, retryable: true, retryAfterSeconds: 900, error: 'EVIDENCE_UNAVAILABLE', diagnostics: diagnostics.slice(-5) };
}

async function getAvailableGeminiModels(apiKey) {
  const rank = m => [...new Set(m)].filter(n => typeof n === 'string' && n.trim()).sort((a, b) => { const r = n => n.includes('flash-lite') ? 0 : n.includes('flash') ? 1 : n.includes('pro') ? 3 : 2; return r(a) - r(b) || a.localeCompare(b); });
  if (process.env.GEMINI_MODELS) return rank(process.env.GEMINI_MODELS.split(',').map(m => m.trim()));
  if (cachedGeminiModels.data && (Date.now() - cachedGeminiModels.timestamp < CACHE_TTL)) return cachedGeminiModels.data;
  try { const res = await fetchWithRetry(`${GEMINI_BASE}/models`, { method: 'GET', headers: { 'x-goog-api-key': apiKey }, apiKeyUsed: apiKey }, 2); if (res?.ok) { const data = await res.json(); const models = rank((data?.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name.replace(/^models\//, ''))); if (models.length) { cachedGeminiModels = { data: models, timestamp: Date.now() }; return models; } } } catch (e) {}
  return rank(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
}
async function getAvailableDeepSeekModel(apiKey) {
  if (process.env.DEEPSEEK_MODEL) return process.env.DEEPSEEK_MODEL.trim();
  if (cachedDeepSeekModel.data && (Date.now() - cachedDeepSeekModel.timestamp < CACHE_TTL)) return cachedDeepSeekModel.data;
  try { const res = await fetchWithRetry('https://api.deepseek.com/models', { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, apiKeyUsed: apiKey }, 2); if (res?.ok) { const data = await res.json(); if (Array.isArray(data?.data) && data.data.length > 0) { const chosen = data.data.find(id => id.id === 'deepseek-chat') || data.data.find(id => /chat/i.test(id.id)); if (chosen) { cachedDeepSeekModel = { data: chosen.id, timestamp: Date.now() }; return chosen.id; } } } } catch (e) {}
  return 'deepseek-chat';
}
async function callGeminiForJudge(prompt, temperature = 0.1) {
  const k = getRandomKey('GEMINI_KEYS'); if (!k) throw new Error('NO_KEYS');
  const models = await getAvailableGeminiModels(k); let lastErr;
  for (const m of models) {
    const ck = getRandomKey('GEMINI_KEYS'); if (!ck) break;
    try {
      const res = await fetchWithRetry(`${GEMINI_BASE}/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ck }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature } }), apiKeyUsed: ck });
      const d = await res.json(); if (!res.ok) throw new Error(`HTTP ${res.status}`); return JSON.parse(cleanJSONString(d?.candidates?.[0]?.content?.parts?.[0]?.text));
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Gemini failed: ${lastErr?.message}`);
}
async function callDeepSeekJSON(prompt, schema, context = 'DS') {
  const k = getRandomKey('DEEPSEEK_KEYS'); if (!k) throw new Error('NO_KEYS');
  const m = await getAvailableDeepSeekModel(k);
  const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` }, body: JSON.stringify({ model: m, messages: [{ role: 'system', content: 'Strict auditor. Return JSON only.' }, { role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.1 }), apiKeyUsed: k });
  const b = await res.json(); if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return safeJsonParseAndValidate(b?.choices?.[0]?.message?.content, schema, context);
}

function buildPayload(q, opts, exp, ev) { return `EVIDENCE:\n${ev}\n\nQ: ${q}\nA) ${opts[0]}\nB) ${opts[1]}\nC) ${opts[2]}\nD) ${opts[3]}\nEXP: ${exp || ''}`; }
function buildSolverPayload(q, opts, ev) { return `EVIDENCE:\n${ev}\n\nQ: ${q}\nA) ${opts[0]}\nB) ${opts[1]}\nC) ${opts[2]}\nD) ${opts[3]}`; }

async function solveWithGemini(q, opts, exp, ev, temp) {
  const p = `Solve independently. Return JSON: {"calculated_answer":0,"confidence":0,"reasoning_summary":"..."}\n${buildSolverPayload(q, opts, ev)}`;
  return safeJsonParseAndValidate(JSON.stringify(await callGeminiForJudge(p, temp)), SolverResultSchema, `GS-${temp}`);
}
async function solveWithDeepSeek(q, opts, exp, ev) {
  const p = `Solve independently. Return JSON: {"calculated_answer":0,"confidence":0,"reasoning_summary":"..."}\n${buildSolverPayload(q, opts, ev)}`;
  return callDeepSeekJSON(p, SolverResultSchema, 'DS-Solve');
}
async function judgeWithGemini(q, opts, ans, exp, ev) {
  const p = `Audit. Return JSON: {"passed":bool,"confidence":0,"options_quality":0,"question_quality":0,"explanation_valid":bool,"contradiction":bool,"evidence_sufficient":bool,"unique_correct_option":bool,"ambiguous":bool,"reason":""}\n${buildPayload(q, opts, exp, ev)}\nANS: ${ans}`;
  return safeJsonParseAndValidate(JSON.stringify(await callGeminiForJudge(p, 0.1)), AIJudgeResultSchema, 'GJ');
}
async function adversarialReview(q, opts, exp, ev) {
  const sp = `Solve blindly. Return JSON: {"calculated_answer":0,"confidence":0,"reasoning_summary":"..."}\n${buildSolverPayload(q, opts, ev)}`;
  const rp = `Hostile reviewer. Return JSON: {"passed":bool,"defects":[],"multiple_correct_options":bool,"stem_mismatch":bool,"ambiguity":bool,"explanation_defect":bool,"reason":""}\n${buildPayload(q, opts, exp, ev)}`;
  const [s, r] = await Promise.all([callGeminiForJudge(sp, 0.1).then(x => safeJsonParseAndValidate(JSON.stringify(x), SolverResultSchema, 'AdvS')), callGeminiForJudge(rp, 0.2).then(x => safeJsonParseAndValidate(JSON.stringify(x), AdversarialReviewOnlySchema, 'AdvR'))]);
  return { ...r, calculated_answer: s.calculated_answer, solver_confidence: s.confidence };
}
async function structuralEvidenceReview(q, opts, exp, ev) {
  const sp = `Solve blindly. Return JSON: {"calculated_answer":0,"confidence":0,"reasoning_summary":"..."}\n${buildSolverPayload(q, opts, ev)}`;
  const rp = `Strict structural audit. Return JSON: {"passed":bool,"stem_qualifier_match":bool,"distractors_plausible_but_wrong":bool,"distractor_justifications":["A:","B:","C:","D:"],"evidence_entails_explanation":bool,"unsupported_claims":[],"defects":[],"confidence":0,"reason":""}\n${buildPayload(q, opts, exp, ev)}`;
  const [s, r] = await Promise.all([callDeepSeekJSON(sp, SolverResultSchema, 'StrS'), callDeepSeekJSON(rp, StructuralReviewOnlySchema, 'StrR')]);
  return { ...r, calculated_answer: s.calculated_answer, solver_confidence: s.confidence };
}
async function finalCritique(q, opts, exp, ev, prior) {
  const sp = `Solve blindly. Return JSON: {"calculated_answer":0,"confidence":0,"reasoning_summary":"..."}\n${buildSolverPayload(q, opts, ev)}`;
  const rp = `Final critique. Return JSON: {"has_defect":bool,"defect_classes":[],"reason":""}\n${buildPayload(q, opts, exp, ev)}\nPrior: ${JSON.stringify(prior)}`;
  const [s, r] = await Promise.all([callGeminiForJudge(sp, 0.1).then(x => safeJsonParseAndValidate(JSON.stringify(x), SolverResultSchema, 'CritS')), callGeminiForJudge(rp, 0.1).then(x => safeJsonParseAndValidate(JSON.stringify(x), CritiqueReviewOnlySchema, 'CritR'))]);
  return { ...r, calculated_answer: s.calculated_answer, solver_confidence: s.confidence };
}
async function verifyChapterMatch(mcq, cat, sec, sub, ch) {
  const p = `Does this MCQ belong to "${ch}" of "${sub}"? Return JSON: {"belongs":bool,"actual_chapter":"","confidence":0}\nQ: ${mcq.question_en}`;
  try { return safeJsonParseAndValidate(JSON.stringify(await callGeminiForJudge(p)), ChapterMatchSchema, 'Chap'); } catch { return { belongs: false, actual_chapter: 'api_error', confidence: 0 }; }
}
function calculateQualityScore(j, agreement) { return Math.round(Math.min(100, Math.max(0, (Number(j?.question_quality) || 0) * 0.35 + (Number(j?.options_quality) || 0) * 0.35 + (Number(j?.confidence) || 0) * 0.20 + (Number(agreement) || 0) * 0.10))); }

export async function generateChapterList({ category, section, subject, existingChapters = [], count = 20 }) {
  const c = Math.max(3, Math.min(50, Math.floor(Number(count) || 20)));
  const ex = new Set(existingChapters.map(x => x.trim().toLowerCase()));
  const prompt = `List ${c} NEW chapters for ${subject} (${section}, ${category}). Return JSON: {"chapters":[]}\nAVOID: ${existingChapters.join(', ')}`;
  const k = getRandomKey('GEMINI_KEYS'); if (!k) throw new Error('NO_KEYS');
  const models = await getAvailableGeminiModels(k);
  for (const m of models) {
    const ck = getRandomKey('GEMINI_KEYS'); if (!ck) break;
    try {
      const res = await fetchWithRetry(`${GEMINI_BASE}/models/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ck }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }), apiKeyUsed: ck });
      const v = ChapterListSchema.safeParse(JSON.parse(cleanJSONString((await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text))); if (!v.success) throw new Error('Schema');
      const chaps = []; for (const rc of v.data.chapters) { const n = rc.trim(); if (n.length >= 3 && !ex.has(n.toLowerCase())) { chaps.push(n); ex.add(n.toLowerCase()); if (chaps.length === c) break; } }
      if (chaps.length === c) return chaps;
    } catch (e) {}
  }
  throw new Error('Chapter gen failed');
}
async function generateDraft({ category, section, subject, chapter, exam_type, difficulty, count, evidence }) {
  const rq = await getRecentQuestionsFromChapter(category, section, subject, chapter, RECENT_QUESTIONS_FOR_PROMPT);
  const pyq = await loadPYQExamples(subject, chapter, 5);
  const pyqB = pyq.length ? `\nPYQ STYLE:\n${pyq.map(q => q.question_en).join('\n')}` : '';
  const rqB = rq.length ? `\nAVOID:\n${rq.join('\n')}` : '';
  const prompt = `Generate exactly ${count} hard MCQs for ${subject} - ${chapter}. Return JSON: {"mcqs":[{...}]}\n${rqB}${pyqB}\nEVIDENCE: ${evidence}`;
  const k = getRandomKey('GEMINI_KEYS'); if (!k) throw new Error('NO_KEYS');
  const models = await getAvailableGeminiModels(k);
  for (const m of models) {
    const ck = getRandomKey('GEMINI_KEYS'); if (!ck) break;
    try {
      const res = await fetchWithRetry(`${GEMINI_BASE}/models/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ck }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }), apiKeyUsed: ck });
      const parsed = JSON.parse(cleanJSONString((await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text));
      const mcqs = Array.isArray(parsed?.mcqs) ? parsed.mcqs : (Array.isArray(parsed) ? parsed : []);
      if (mcqs.length > 0) { Object.defineProperty(mcqs, '_pyqIds', { value: pyq.map(q => q.id), enumerable: false }); return mcqs; }
    } catch (e) {}
  }
  throw new Error('Gen failed');
}
async function getRecentQuestionsFromChapter(cat, sec, sub, ch, limit) {
  try { return (await getDb().execute({ sql: 'SELECT question_en FROM mcqs WHERE category=? AND section=? AND subject=? AND chapter=? ORDER BY created_at DESC LIMIT ?', args: [cat, sec, sub, ch, limit] })).rows.map(r => r.question_en); } catch { return []; }
}
async function loadPYQExamples(sub, ch, limit) {
  try { return (await getDb().execute({ sql: 'SELECT id, question_en, option_a_en, option_b_en, option_c_en, option_d_en FROM pyq_bank WHERE exam_year>=? AND (LOWER(COALESCE(chapter, \'\')) LIKE ? OR LOWER(COALESCE(topics, \'\')) LIKE ?) LIMIT ?', args: [new Date().getFullYear() - 5, `%${ch.toLowerCase()}%`, `%${ch.toLowerCase()}%`, limit] })).rows; } catch { return []; }
}

function validateRawMCQ(m) {
  if (!m || typeof m !== 'object') return { valid: false, reason: 'Not object' };
  const r = RawMCQSchema.safeParse(m); if (!r.success) return { valid: false, reason: 'Zod fail' };
  const d = r.data; const hiO = [d.option_a_hi, d.option_b_hi, d.option_c_hi, d.option_d_hi]; const enO = [d.option_a_en, d.option_b_en, d.option_c_en, d.option_d_en];
  if (new Set(hiO.map(normalizeMCQText)).size !== 4 || new Set(enO.map(normalizeMCQText)).size !== 4) return { valid: false, reason: 'Dup options' };
  let aIdx = -1; if (typeof d.answer === 'number') aIdx = d.answer; else if (typeof d.answer === 'string') { const n = normalizeMCQText(d.answer); aIdx = enO.findIndex(o => normalizeMCQText(o) === n); if (aIdx === -1) aIdx = hiO.findIndex(o => normalizeMCQText(o) === n); }
  if (aIdx < 0 || aIdx > 3) return { valid: false, reason: 'Bad answer' };
  return { valid: true, mcq: { ...d, answer: aIdx } };
}
async function filterDuplicatesByFingerprint(items) {
  const db = getDb(); const fps = items.map(i => makeFingerprint(i.mcq.question_en, i.mcq.question_hi)); const valid = fps.filter(f => f);
  let ex = new Set(); if (valid.length) { try { ex = new Set((await db.execute({ sql: `SELECT fingerprint FROM mcqs WHERE fingerprint IN (${valid.map(() => '?').join(',')})`, args: valid })).rows.map(r => r.fingerprint)); } catch (e) { throw new Error('FP fail'); } }
  const u = [], d = [], seen = new Set();
  for (let i = 0; i < items.length; i++) { const fp = fps[i]; if (!fp) { u.push(items[i]); continue; } if (ex.has(fp) || seen.has(fp)) d.push({ ...items[i], reason: 'FP Dup' }); else { seen.add(fp); u.push(items[i]); } }
  return { unique: u, duplicates: d };
}
async function filterDuplicatesMultiLayer(items, context) {
  const db = getDb(); const d = [], s = [];
  let gl = []; try { gl = (await db.execute({ sql: 'SELECT id, trigram_sig, word_set_fp, fingerprint, question_en FROM mcqs ORDER BY created_at DESC LIMIT 500', args: [] })).rows; } catch { throw new Error('Dedup fail'); }
  for (const item of items) {
    const q = item.mcq.question_en; const tri = makeTrigramSignature(q); const ws = makeWordSetFp(q); const fp = makeFingerprint(q, item.mcq.question_hi); let dup = false;
    try {
      const rec = (await db.execute({ sql: 'SELECT id, trigram_sig, word_set_fp, fingerprint, question_en FROM mcqs WHERE category=? AND section=? AND subject=? AND chapter=? ORDER BY created_at DESC LIMIT ?', args: [context.category, context.section, context.subject, context.chapter, RECENT_QUESTIONS_TO_CHECK] })).rows;
      const mg = new Map(); gl.forEach(r => mg.set(r.id, r)); rec.forEach(r => mg.set(r.id, r));
      for (const ex of mg.values()) {
        if (signatureSimilarity(tri, ex.trigram_sig || makeTrigramSignature(ex.question_en)) >= TRIGRAM_SIMILARITY_THRESHOLD) { dup = true; break; }
        if (wordSetSimilarity(ws, ex.word_set_fp || makeWordSetFp(ex.question_en)) >= WORDSET_SIMILARITY_THRESHOLD) { dup = true; break; }
        if (fp && (ex.fingerprint || makeFingerprint(ex.question_en, '')) === fp) { dup = true; break; }
      }
    } catch { throw new Error('Dedup fail'); }
    if (dup) d.push({ ...item, reason: 'Dup' }); else {
      let bDup = false; for (const sv of s) if (signatureSimilarity(tri, sv._tri) >= TRIGRAM_SIMILARITY_THRESHOLD || wordSetSimilarity(ws, sv._ws) >= WORDSET_SIMILARITY_THRESHOLD) { bDup = true; break; }
      if (bDup) d.push({ ...item, reason: 'Batch dup' }); else { item._tri = tri; item._ws = ws; s.push(item); }
    }
  }
  return { unique: s, duplicates: d };
}
async function filterPYQDuplicates(items) {
  const db = getDb(); let rows = [];
  try { rows = (await db.execute({ sql: 'SELECT id, question_en FROM pyq_bank WHERE exam_year >= ? AND question_en IS NOT NULL ORDER BY exam_year DESC LIMIT 1000', args: [new Date().getFullYear() - 5] })).rows; } catch { throw new Error('PYQ scan fail'); }
  const pSigs = rows.map(r => ({ id: r.id, sig: makePYQSignature(r.question_en) })).filter(x => x.sig);
  const u = [], d = [];
  for (const item of items) {
    const sig = makePYQSignature(item.mcq.question_en); let match = null;
    for (const p of pSigs) if (pyqSignatureSimilarity(sig, p.sig) >= 0.70) { match = p; break; }
    if (match) d.push({ ...item, reason: 'Too similar to PYQ' }); else u.push(item);
  }
  return { unique: u, duplicates: d };
}

async function validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput, evidenceText, sourceUrl = null, taskId = null, pyqExampleIds = [] }) {
  const db = getDb(); const safeEv = typeof evidenceText === 'string' ? evidenceText.slice(0, 10000) : ''; const rej = [];
  const valid = rawMCQsInput.map(validateRawMCQ).filter(r => r.valid).map(r => r.mcq);
  if (!valid.length) return { success: false, count: 0, rejectedTotal: rawMCQsInput.length };
  const appr = []; const chunks = chunkArray(valid, BATCH_CONCURRENCY);
  for (let i = 0; i < chunks.length; i++) {
    const p = chunks[i].map(async m => {
      const rj = (r, s = 0) => { rej.push({ question: m.question_en, reason: r }); return null; };
      try {
        const enO = [m.option_a_en, m.option_b_en, m.option_c_en, m.option_d_en]; const hiO = [m.option_a_hi, m.option_b_hi, m.option_c_hi, m.option_d_hi];
        const opts = enO.map((o, id) => `${o} [H: ${hiO[id]}]`); const qA = `${m.question_en} [H: ${m.question_hi}]`; const exp = `${m.explanation_en || ''} [H: ${m.explanation_hi || ''}]`;
        let chk; try { chk = await verifyChapterMatch(m, category, section, subject, chapter); } catch { return rj('Chap fail'); }
        if (!chk.belongs || chk.confidence < 60) return rj('Chap mismatch');
        
        let judge, ds, gm1;
        try { [judge, ds, gm1] = await Promise.all([judgeWithGemini(qA, opts, enO[m.answer], exp, safeEv), solveWithDeepSeek(qA, opts, '', safeEv), solveWithGemini(qA, opts, '', safeEv, 0.1)]); } catch { return rj('T1 API fail'); }
        if (!judge.passed || judge.contradiction || !judge.explanation_valid || !judge.evidence_sufficient || !judge.unique_correct_option || judge.ambiguous) return rj('T1 Judge fail');
        
        const t1C = Math.min(judge.confidence, ds.confidence, gm1.confidence); const t1S = calculateQualityScore({ ...judge, confidence: t1C }, 100); const chkStr = chk.confidence >= 75;
        const t1Consensus = [ds.calculated_answer, gm1.calculated_answer].every(a => a === m.answer);
        if (t1Consensus && chkStr && t1C >= 92 && t1S >= QUALITY_GATE) return { mcq: m, score: t1S, verificationTier: 1 };

        let gm2, adv, str;
        try { [gm2, adv, str] = await Promise.all([solveWithGemini(qA, opts, exp, safeEv, 0.5), adversarialReview(qA, opts, exp, safeEv), structuralEvidenceReview(qA, opts, exp, safeEv)]); } catch { return rj('T2 API fail'); }
        const solv = [ds.calculated_answer, gm1.calculated_answer, gm2.calculated_answer, adv.calculated_answer, str.calculated_answer];
        if (solv.some(a => a !== m.answer)) return rj('T2 Solver mismatch');
        if (!adv.passed || adv.multiple_correct_options || adv.stem_mismatch || adv.ambiguity || adv.explanation_defect || adv.defects.length) return rj('T2 Adv fail');
        if (!str.passed || !str.stem_qualifier_match || !str.distractors_plausible_but_wrong || !str.evidence_entails_explanation || str.unsupported_claims.length || str.defects.length) return rj('T2 Str fail');
        
        const t2C = Math.min(judge.confidence, ds.confidence, gm1.confidence, gm2.confidence, adv.solver_confidence, str.solver_confidence, str.confidence); const t2S = calculateQualityScore({ ...judge, confidence: t2C }, 100);
        if (chkStr && str.confidence >= 90 && t2C >= 85 && t2S >= QUALITY_GATE) return { mcq: m, score: t2S, verificationTier: 2 };
        
        if (str.confidence < 85 || t2S < QUALITY_GATE || t2C < 80) return rj(`T3 ineligible`);
        let crit; try { crit = await finalCritique(qA, opts, exp, safeEv, { tier: 2 }); } catch { return rj('T3 fail'); }
        if (crit.calculated_answer !== m.answer || crit.solver_confidence < 85) return rj('T3 mismatch');
        if (crit.has_defect || crit.defect_classes.length) return rj('T3 defect');
        return { mcq: m, score: t2S, verificationTier: 3 };
      } catch { return rj('Crash'); }
    });
    appr.push(...(await Promise.all(p)).filter(Boolean));
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  if (!appr.length) return { success: false, count: 0, rejectedTotal: rej.length, rejectedDetails: rej };
  
  const hMap = new Map(); appr.forEach(i => { const h = createHash('sha256').update(normalizeMCQText(i.mcq.question_en)).digest('hex'); if (!hMap.has(h)) hMap.set(h, i); });
  let u1, u2, u3; try { u1 = (await filterDuplicatesByFingerprint([...hMap.values()])).unique; } catch { return { success: false, count: 0, error: 'Dedup fail' }; }
  try { u2 = (await filterDuplicatesMultiLayer(u1, { category, section, subject, chapter })).unique; } catch { return { success: false, count: 0, error: 'Dedup fail' }; }
  try { u3 = (await filterPYQDuplicates(u2)).unique; } catch { return { success: false, count: 0, error: 'PYQ dedup fail' }; }

  const maxSave = Math.max(1, Math.floor(rawMCQsInput.length * MAX_SAVE_RATE));
  if (u3.length > maxSave) { u3.sort((a, b) => b.score - a.score); u3 = u3.slice(0, maxSave); }

  if (!u3.length) return { success: false, count: 0, error: 'All filtered' };

  const bCols = ['id', 'category', 'section', 'subject', 'chapter', 'exam_type', 'difficulty', 'question_hi', 'question_en', 'option_a_hi', 'option_a_en', 'option_b_hi', 'option_b_en', 'option_c_hi', 'option_c_en', 'option_d_hi', 'option_d_en', 'answer', 'explanation_hi', 'explanation_en', 'hash', 'fingerprint', 'trigram_sig', 'word_set_fp', 'quality_score', 'is_gold', 'source_url', 'retrieval_score', 'random_key', 'version', 'parent_qid', 'generation_task_id', 'created_at'];
  const optDef = { trigram_version: 32, audit_status: 'pending', audit_notes: '', audit_checked_at: null, structural_checked_at: Date.now(), attempt_count: 0, correct_count: 0, wrong_count: 0, is_disabled: 0 };
  let sCols; try { sCols = new Set((await db.execute({ sql: 'PRAGMA table_info(mcqs)' })).rows.map(r => r.name)); } catch { return { success: false, count: 0, error: 'Schema fail' }; }
  const insCols = [...bCols, ...Object.keys(optDef).filter(c => sCols.has(c))]; const cCount = insCols.length;
  const rows = u3.map(i => {
    const id = randomUUID(); const hash = createHash('sha256').update(normalizeMCQText(i.mcq.question_en)).digest('hex');
    const auto = isAutoApprovalEligible({ verificationTier: i.verificationTier, score: i.score, maxTier: AUTO_APPROVE_TIER, minScore: AUTO_APPROVE_MIN_SCORE, sourceTrusted: isTrustedEvidenceUrl(sourceUrl) });
    return { i, v: { id, category: category || '', section: section || '', subject: subject || '', chapter: chapter || '', exam_type: exam_type || null, difficulty: i.mcq.difficulty || 'medium', question_hi: i.mcq.question_hi, question_en: i.mcq.question_en, option_a_hi: i.mcq.option_a_hi, option_a_en: i.mcq.option_a_en, option_b_hi: i.mcq.option_b_hi, option_b_en: i.mcq.option_b_en, option_c_hi: i.mcq.option_c_hi, option_c_en: i.mcq.option_c_en, option_d_hi: i.mcq.option_d_hi, option_d_en: i.mcq.option_d_en, answer: i.mcq.answer, explanation_hi: i.mcq.explanation_hi || '', explanation_en: i.mcq.explanation_en || '', hash, fingerprint: makeFingerprint(i.mcq.question_en, i.mcq.question_hi), trigram_sig: i._tri || makeTrigramSignature(i.mcq.question_en), word_set_fp: i._ws || makeWordSetFp(i.mcq.question_en), quality_score: i.score, is_gold: i.score >= 95 ? 1 : 0, source_url: sourceUrl, retrieval_score: null, random_key: Math.floor(Math.random() * 2147483647), version: 1, parent_qid: null, generation_task_id: taskId, created_at: Date.now(), ...optDef, audit_status: auto ? 'approved' : 'pending', audit_checked_at: auto ? Date.now() : null } };
  });

  let ins = 0;
  try {
    for (let s = 0; s < rows.length; s += 20) {
      const b = rows.slice(s, s + 20); const a = b.flatMap(r => insCols.map(c => r.v[c] ?? null)); const ph = b.map(() => `(${Array(cCount).fill('?').join(',')})`).join(',');
      const res = await db.execute({ sql: `INSERT INTO mcqs (${insCols.join(',')}) VALUES ${ph}`, args: a }); ins += Number(res.rowsAffected || 0);
    }
  } catch (e) { return { success: false, count: ins, error: 'Insert fail' }; }

  return { success: true, count: ins, rejectedTotal: rej.length };
}

export async function generateFromScratch({ category, section, subject, chapter, exam_type, difficulty, count, taskId = null }) {
  let ev = null, sUrl = null, retryable = false, lastError = null, lastDiagnostics = [];
  for (let i = 0; i < 2; i++) {
    try { 
      const r = await retrieveEvidence(category, section, subject, chapter); 
      if (r && typeof r === 'object') { 
        ev = r.text; sUrl = r.sourceUrl; retryable = r.retryable; lastError = r.error; lastDiagnostics = r.diagnostics || [];
      } 
      if (ev && sUrl) break; 
      if (!retryable) break; 
      await new Promise(res => setTimeout(res, 2000)); 
    } catch (e) { 
      retryable = true; lastError = e.message; 
    }
  }
  
  if (!ev || ev.length < MIN_EVIDENCE_LENGTH || !sUrl) {
    return { success: false, error: lastError || 'NO_EVIDENCE_FOUND', diagnostics: lastDiagnostics, retryable, count: 0, rejectedTotal: 0, roundsUsed: 0 };
  }

  let total = 0, totalRejected = 0, rounds = 0;
  for (let round = 1; round <= 3 && total < count; round++) {
    rounds = round;
    const req = Math.ceil((count - total) * 1.35);
    let raw; 
    try { raw = await generateDraft({ category, section, subject, chapter, exam_type, difficulty, count: req, evidence: ev }); } catch (e) { lastError = e.message; continue; }
    if (!raw || !raw.length) continue;
    
    try { 
      const res = await validateJudgeAndSave({ category, section, subject, chapter, exam_type, rawMCQsInput: raw, evidenceText: ev, sourceUrl: sUrl, taskId, pyqExampleIds: raw._pyqIds || [] }); 
      total += res.count || 0; 
      totalRejected += res.rejectedTotal || 0;
    } catch (e) {
      lastError = e.message;
    }
  }
  
  return { success: total > 0, count: total, rejectedTotal: totalRejected, roundsUsed: rounds, error: total > 0 ? null : (lastError || 'ALL_MCQS_REJECTED') };
}

export { loadGoodExamples, loadBadExamples };
async function loadGoodExamples(l) { try { return (await getDb().execute({ sql: 'SELECT pattern FROM learn_good ORDER BY score DESC LIMIT ?', args: [l] })).rows.map(r => r.pattern); } catch { return []; } }
async function loadBadExamples(l) { try { return (await getDb().execute({ sql: 'SELECT reason FROM learn_bad ORDER BY id DESC LIMIT ?', args: [l] })).rows.map(r => r.reason); } catch { return []; } }
