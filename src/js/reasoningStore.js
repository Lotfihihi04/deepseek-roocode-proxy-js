'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Normalize a tool call object for canonical comparison.
 */
function normalizeToolCall(toolCall) {
  const fn = (typeof toolCall.function === 'object' && toolCall.function) ? toolCall.function : {};
  let args = fn.arguments !== undefined ? fn.arguments : '';
  if (typeof args !== 'string') {
    args = JSON.stringify(args);
  }
  return {
    id: toolCall.id,
    type: toolCall.type || 'function',
    function: {
      name: fn.name || '',
      arguments: args,
    },
  };
}

function toolCallSignature(toolCall) {
  const normalized = normalizeToolCall(toolCall);
  delete normalized.id;
  const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toolCallIds(message) {
  const ids = [];
  for (const tc of (message.tool_calls || [])) {
    if (tc && tc.id) {
      ids.push(String(tc.id));
    }
  }
  return ids;
}

function messageSignature(message) {
  const toolCalls = (message.tool_calls || [])
    .filter(tc => tc && typeof tc === 'object')
    .map(normalizeToolCall);
  const payload = {
    content: message.content || '',
    tool_calls: toolCalls,
  };
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalScopeMessage(message) {
  const canonical = { role: message.role };
  for (const key of ['content', 'name', 'tool_call_id', 'prefix']) {
    if (Object.prototype.hasOwnProperty.call(message, key)) {
      canonical[key] = message[key];
    }
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    canonical.tool_calls = message.tool_calls
      .filter(tc => tc && typeof tc === 'object')
      .map(normalizeToolCall);
  }
  return canonical;
}

/**
 * Compute a conversation scope hash from the prior messages and a namespace string.
 * Excludes system messages so that changing the system prompt doesn't invalidate
 * cached reasoning for assistant messages with tool_calls.
 */
function conversationScope(messages, namespace) {
  const scopeMessages = messages
    .filter(m => m.role !== 'system')
    .map(canonicalScopeMessage);
  let payload;
  if (namespace) {
    payload = { namespace, messages: scopeMessages };
  } else {
    payload = scopeMessages;
  }
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

class ReasoningStore {
  /**
   * @param {string} reasoningContentPath - Path to the SQLite file, or ':memory:'.
   * @param {object} [options]
   * @param {number|null} [options.maxAgeSeconds]
   * @param {number|null} [options.maxRows]
   */
  constructor(reasoningContentPath, { maxAgeSeconds = null, maxRows = null } = {}) {
    this.maxAgeSeconds = maxAgeSeconds;
    this.maxRows = maxRows;
    this.reasoningContentPath = reasoningContentPath;

    if (reasoningContentPath !== ':memory:') {
      const dir = path.dirname(reasoningContentPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch (_e) {
        // ignore — may fail in containers
      }
    }

    this._db = new Database(reasoningContentPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');

    if (reasoningContentPath !== ':memory:') {
      try {
        fs.chmodSync(reasoningContentPath, 0o600);
      } catch (_e) {
        // best effort
      }
    }

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_cache (
        key TEXT PRIMARY KEY,
        reasoning TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at REAL NOT NULL
      )
    `);
    this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_cache_created_at
      ON reasoning_cache(created_at)
    `);

    this._stmtPut = this._db.prepare(`
      INSERT INTO reasoning_cache(key, reasoning, message_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        reasoning = excluded.reasoning,
        message_json = excluded.message_json,
        created_at = excluded.created_at
    `);
    this._stmtGet = this._db.prepare(
      'SELECT reasoning FROM reasoning_cache WHERE key = ?',
    );
    this._stmtCount = this._db.prepare('SELECT COUNT(*) as cnt FROM reasoning_cache');
    this._stmtDelete = this._db.prepare('DELETE FROM reasoning_cache');

    this.prune();
  }

  close() {
    this._db.close();
  }

  put(key, reasoning, message) {
    if (typeof reasoning !== 'string') return;
    const messageJson = JSON.stringify(message);
    const now = Date.now() / 1000;
    this._stmtPut.run(key, reasoning, messageJson, now);
    this._pruneLocked();
  }

  get(key) {
    const row = this._stmtGet.get(key);
    return row ? String(row.reasoning) : null;
  }

  storeAssistantMessage(message, scope) {
    if (message.role !== 'assistant') return 0;
    const reasoning = message.reasoning_content;
    if (typeof reasoning !== 'string') return 0;

    const keys = [`scope:${scope}:signature:${messageSignature(message)}`];
    for (const id of toolCallIds(message)) {
      keys.push(`scope:${scope}:tool_call:${id}`);
    }
    for (const tc of (message.tool_calls || [])) {
      if (tc && typeof tc === 'object') {
        keys.push(`scope:${scope}:tool_call_signature:${toolCallSignature(tc)}`);
      }
    }
    for (const key of keys) {
      this.put(key, reasoning, message);
    }
    return keys.length;
  }

  lookupForMessage(message, scope) {
    let reasoning = this.get(`scope:${scope}:signature:${messageSignature(message)}`);
    if (reasoning !== null) return reasoning;

    for (const id of toolCallIds(message)) {
      reasoning = this.get(`scope:${scope}:tool_call:${id}`);
      if (reasoning !== null) return reasoning;
    }
    for (const tc of (message.tool_calls || [])) {
      if (!tc || typeof tc !== 'object') continue;
      reasoning = this.get(`scope:${scope}:tool_call_signature:${toolCallSignature(tc)}`);
      if (reasoning !== null) return reasoning;
    }
    return null;
  }

  clear() {
    const count = this._stmtCount.get().cnt;
    this._stmtDelete.run();
    return count;
  }

  prune() {
    this._pruneLocked();
  }

  _pruneLocked() {
    if (this.maxAgeSeconds != null && this.maxAgeSeconds > 0) {
      const cutoff = Date.now() / 1000 - this.maxAgeSeconds;
      this._db.prepare('DELETE FROM reasoning_cache WHERE created_at < ?').run(cutoff);
    }
    if (this.maxRows != null && this.maxRows > 0) {
      this._db.prepare(`
        DELETE FROM reasoning_cache
        WHERE key NOT IN (
          SELECT key FROM reasoning_cache
          ORDER BY created_at DESC
          LIMIT ?
        )
      `).run(this.maxRows);
    }
  }

  stats() {
    const row = this._db.prepare(
      'SELECT COUNT(*) as cnt, COALESCE(MIN(created_at),0) as oldest, ' +
      'COALESCE(MAX(created_at),0) as newest, ' +
      'COALESCE(SUM(LENGTH(key) + LENGTH(reasoning) + LENGTH(message_json) + 8), 0) as data_size ' +
      'FROM reasoning_cache',
    ).get();

    const count = Number(row.cnt);
    const oldest = Number(row.oldest);
    const newest = Number(row.newest);
    const dataSize = Number(row.data_size);
    const now = Date.now() / 1000;

    let dbFileSize = null;
    if (this.reasoningContentPath !== ':memory:') {
      try {
        dbFileSize = fs.statSync(this.reasoningContentPath).size;
      } catch (_e) {
        // ignore
      }
    }

    return {
      total_rows: count,
      oldest_age_seconds: oldest > 0 ? Math.round((now - oldest) * 10) / 10 : null,
      newest_age_seconds: newest > 0 ? Math.round((now - newest) * 10) / 10 : null,
      total_keys_size_bytes: dataSize,
      db_file_size_bytes: dbFileSize,
      max_rows: this.maxRows,
      max_age_seconds: this.maxAgeSeconds,
    };
  }

  diagnosticInfo() {
    const maxRowsHuman = this.maxRows != null ? String(this.maxRows) : 'unlimited';
    const maxAgeHuman = this.maxAgeSeconds != null
      ? `${Math.floor(this.maxAgeSeconds / 3600)}h`
      : 'unlimited';
    const stats = this.stats();
    return {
      cache_location: this.reasoningContentPath === ':memory:'
        ? ':memory:'
        : this.reasoningContentPath,
      rows: stats.total_rows,
      max_rows: maxRowsHuman,
      max_age: maxAgeHuman,
    };
  }
}

module.exports = { ReasoningStore, conversationScope };
