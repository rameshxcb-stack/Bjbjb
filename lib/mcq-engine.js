// ============================================================
// lib/mcq-engine.js — Fully Inlined (Direct URLs Prioritized)
// ============================================================

import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { getDb, safeDbError } from './db.js';

// ==========================================
// 1. INLINED: SOURCE POLICY (Robots & Pacing)
// ==========================================
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

// ==========================================
// 2. INLINED: APPROVAL POLICY
// ==========================================
export function isAutoApprovalEligible({ verificationTier, score, maxTier = 1, minScore = 93, sourceTrusted = false } = {}) {
  const tier = Number(verificationTier); const quality = Number(score); const allowedTier = Number(maxTier); const threshold = Number(minScore);
  if (sourceTrusted !== true) return false;
  if (![tier, quality, allowedTier, threshold].every(Number.isFinite)) return false;
  if (tier < 1 || tier > 3 || allowedTier < 1 || allowedTier > 3) return false;
  return tier <= allowedTier && quality >= threshold;
}

// ==========================================
// 3. INLINED: PYQ SIMILARITY & REGISTRY
// ==========================================
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

// ==========================================
// 4. MAIN ENGINE CONFIG
// ==========================================
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
const SOURCE_USER_AGENT = String(process.env.MCQ_SOURCE_USER_AGENT || 'MCQResearchBot/1.0 (educational)').slice(0, 180);
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
// EVIDENCE RETRIEVER (UPDATED)
// ==========================================
export async function retrieveEvidence(category, section, subject, chapter) {
  const diagnostics = [], MIN_TEXT = MIN_EVIDENCE_LENGTH, MAX_TOTAL_MS = Math.max(65000, Math.min(240000, Number(process.env.MCQ_EVIDENCE_TIME_BUDGET_MS || 150000))), startedAt = Date.now();
  let evidenceDb = null; const getEvidenceDb = () => evidenceDb || (evidenceDb = getDb());
  const MAX_URLS = 60, MAX_CANDIDATES_TO_CHECK = 12, MAX_PDF_BYTES = 12 * 1024 * 1024, MAX_HTML_BYTES = 2 * 1024 * 1024;
  const safe = v => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const persistHostCooldown = async (host, cd, st) => { if (sourceHostStateTableAvailable === false) return; try { await getEvidenceDb().execute({ sql: `INSERT INTO source_host_state (host, cooldown_until, last_status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET cooldown_until = MAX(COALESCE(source_host_state.cooldown_until, 0), excluded.cooldown_unt
