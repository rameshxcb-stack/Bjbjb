// ============================================================
// lib/db.js — Turso HTTP Client
// ============================================================

function env(name) {
  return String(process.env[name] || '').trim();
}

function getConfig() {
  const rawUrl = env('TURSO_DATABASE_URL');
  const rawToken = env('TURSO_AUTH_TOKEN');
  return {
    url: rawUrl.replace(/\/+$/, ''),
    token: rawToken.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim()
  };
}

function getEndpoint(url) {
  if (!url) throw new Error('TURSO_DATABASE_URL is missing.');
  let endpoint = url;
  if (/^libsql:\/\//i.test(endpoint)) endpoint = endpoint.replace(/^libsql:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('Invalid TURSO_DATABASE_URL.');
  if (!endpoint.endsWith('/v2/pipeline')) endpoint += '/v2/pipeline';
  return endpoint;
}

function toHranaValue(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric argument.');
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }

  if (typeof value === 'string') return { type: 'text', value };
  if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  return { type: 'text', value: JSON.stringify(value) };
}

function fromHranaValue(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  switch (value.type) {
    case 'null': return null;
    case 'integer': {
      const n = Number(value.value);
      return Number.isSafeInteger(n) ? n : BigInt(value.value);
    }
    case 'float': return Number(value.value);
    case 'text': return value.value ?? '';
    case 'blob': return value.base64 ?? '';
    default: return value.value ?? null;
  }
}

function normalizeRows(result) {
  const columns = Array.isArray(result?.cols) ? result.cols : [];
  const rawRows = Array.isArray(result?.rows) ? result.rows : [];

  const rows = rawRows.map(row => {
    const values = Array.isArray(row) ? row : Array.isArray(row?.values) ? row.values : [];
    const output = {};
    columns.forEach((column, index) => {
      const name = typeof column === 'string' ? column : column?.name || `column_${index}`;
      output[name] = fromHranaValue(values[index]);
    });
    return output;
  });

  return {
    rows,
    columns,
    rowsAffected: Number(result?.affected_row_count || result?.rows_affected || 0),
    lastInsertRowid: result?.last_insert_rowid
  };
}

async function executeHttp(sql, args = []) {
  if (process.env.DEBUG_DB === '1') {
    console.log('[DB]', String(sql).slice(0, 100));
  }

  const { url, token } = getConfig();
  if (!url) throw new Error('TURSO_DATABASE_URL is missing.');
  if (!token) throw new Error('TURSO_AUTH_TOKEN is missing.');
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('SQL statement is empty.');

  const stmt = { sql };
  if (args.length > 0) stmt.args = args.map(toHranaValue);

  const response = await fetch(getEndpoint(url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      baton: null,
      requests: [
        { type: 'execute', stmt },
        { type: 'close' }
      ]
    })
  });

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }

  if (!response.ok) {
    const message = body?.error?.message || body?.error || body?.message || String(body || 'Request rejected.');
    const error = new Error(`Turso HTTP ${response.status}: ${message}`);
    error.code = `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }

  const first = body?.results?.[0];
  if (!first) throw new Error('Turso returned no pipeline result.');
  if (first.type === 'error' || first.error) {
    const message = first.error?.message || first.error || 'Pipeline failed.';
    const error = new Error(String(message));
    if (first.error?.code) error.code = first.error.code;
    throw error;
  }
  if (first.type !== 'ok' || first.response?.type !== 'execute') {
    throw new Error('Turso returned an unexpected execute response.');
  }

  const result = first.response.result;
  if (!result || typeof result !== 'object') throw new Error('Turso returned an empty execute result.');
  return normalizeRows(result);
}

function createHttpDb() {
  return {
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement?.sql;
      const args = typeof statement === 'string' ? [] : statement?.args || [];
      return executeHttp(sql, args);
    },
    async batch(statements = []) {
      const results = [];
      for (const statement of statements) results.push(await this.execute(statement));
      return results;
    },
    async close() {}
  };
}

let dbInstance = null;

export function getDb() {
  if (!dbInstance) dbInstance = createHttpDb();
  return dbInstance;
}

export function createDb() { return createHttpDb(); }

export async function dbQuery(sql, args = []) {
  const result = await getDb().execute({ sql, args });
  return result.rows || [];
}

export function safeDbError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 1000)
  };
}

export function getDbDiagnostics() {
  const { url, token } = getConfig();
  let host = null;
  try { host = new URL(url.replace(/^libsql:\/\//i, 'https://')).hostname; } catch {}
  return {
    clientImplementation: 'turso-http-v2',
    urlConfigured: Boolean(url),
    tokenConfigured: Boolean(token),
    urlHost: host,
    tokenLength: token.length
  };
}

export async function diagnoseTurso() {
  const diagnostics = getDbDiagnostics();
  if (!diagnostics.urlConfigured) return { success: false, error: 'TURSO_URL_MISSING', diagnostics };
  if (!diagnostics.tokenConfigured) return { success: false, error: 'TURSO_TOKEN_MISSING', diagnostics };

  try {
    const result = await getDb().execute({ sql: 'SELECT 1 AS is_active', args: [] });
    return {
      success: true,
      status: 'SUCCESS',
      message: 'Turso HTTP connection succeeded.',
      diagnostics,
      rows: result.rows
    };
  } catch (error) {
    const dbError = safeDbError(error);
    return {
      success: false,
      status: 'ERROR',
      error: dbError.code || 'TURSO_CONNECTION_FAILED',
      message: dbError.message,
      diagnostics
    };
  }
}

export async function testDbConnection() {
  const result = await getDb().execute({ sql: 'SELECT 1 AS is_active', args: [] });
  return { connected: true, rows: result.rows || [] };
}
