'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
   * @param {string} reasoningContentPath - Path to the JSON cache file, or ':memory:'.
   * @param {object} [options]
   * @param {number|null} [options.maxAgeSeconds]
   * @param {number|null} [options.maxRows]
   */
  constructor(reasoningContentPath, { maxAgeSeconds = null, maxRows = null } = {}) {
    this.maxAgeSeconds = maxAgeSeconds;
    this.maxRows = maxRows;
    this.reasoningContentPath = reasoningContentPath;
    this._inMemory = reasoningContentPath === ':memory:';

    // In-memory store: Map<key, { reasoning, message_json, created_at }>
    this._data = new Map();

    if (!this._inMemory) {
      const dir = path.dirname(reasoningContentPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch (_e) {
        // ignore — may fail in containers
      }
      this._load();
    }

    this.prune();
  }

  /** Load the cache from disk, ignoring errors (treats as empty). */
  _load() {
    try {
      const text = fs.readFileSync(this.reasoningContentPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, entry] of Object.entries(parsed)) {
          if (
            entry &&
            typeof entry.reasoning === 'string' &&
            typeof entry.message_json === 'string' &&
            typeof entry.created_at === 'number'
          ) {
            this._data.set(key, entry);
          }
        }
      }
    } catch (_e) {
      // file doesn't exist or is corrupted; start fresh
    }
  }

  /** Persist the cache to disk atomically (write temp file then rename). */
  _save() {
    if (this._inMemory) return;
    const obj = Object.fromEntries(this._data);
    const json = JSON.stringify(obj);
    const tmpPath = this.reasoningContentPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (_e) {
        // best effort
      }
      fs.renameSync(tmpPath, this.reasoningContentPath);
    } catch (_e) {
      // best effort — clean up stray temp file
      try { fs.unlinkSync(tmpPath); } catch (_e2) { /* ignore */ }
    }
  }

  close() {
    // No resources to release for the JSON store.
  }

  put(key, reasoning, message) {
    if (typeof reasoning !== 'string') return;
    const messageJson = JSON.stringify(message);
    const now = Date.now() / 1000;
    this._data.set(key, { reasoning, message_json: messageJson, created_at: now });
    this._pruneLocked();
    this._save();
  }

  get(key) {
    const entry = this._data.get(key);
    return entry ? String(entry.reasoning) : null;
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
    const count = this._data.size;
    this._data.clear();
    this._save();
    return count;
  }

  prune() {
    this._pruneLocked();
    this._save();
  }

  _pruneLocked() {
    if (this.maxAgeSeconds != null && this.maxAgeSeconds > 0) {
      const cutoff = Date.now() / 1000 - this.maxAgeSeconds;
      for (const [key, entry] of this._data) {
        if (entry.created_at < cutoff) {
          this._data.delete(key);
        }
      }
    }
    if (this.maxRows != null && this.maxRows > 0 && this._data.size > this.maxRows) {
      const sorted = [...this._data.entries()]
        .sort((a, b) => b[1].created_at - a[1].created_at);
      this._data.clear();
      for (const [k, v] of sorted.slice(0, this.maxRows)) {
        this._data.set(k, v);
      }
    }
  }

  stats() {
    let oldest = null;
    let newest = null;
    let dataSize = 0;
    for (const [key, entry] of this._data) {
      if (oldest === null || entry.created_at < oldest) oldest = entry.created_at;
      if (newest === null || entry.created_at > newest) newest = entry.created_at;
      dataSize += key.length + entry.reasoning.length + entry.message_json.length + 8;
    }
    const count = this._data.size;
    const now = Date.now() / 1000;

    let dbFileSize = null;
    if (!this._inMemory) {
      try {
        dbFileSize = fs.statSync(this.reasoningContentPath).size;
      } catch (_e) {
        // ignore
      }
    }

    return {
      total_rows: count,
      oldest_age_seconds: oldest !== null ? Math.round((now - oldest) * 10) / 10 : null,
      newest_age_seconds: newest !== null ? Math.round((now - newest) * 10) / 10 : null,
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
      cache_location: this._inMemory ? ':memory:' : this.reasoningContentPath,
      rows: stats.total_rows,
      max_rows: maxRowsHuman,
      max_age: maxAgeHuman,
    };
  }
}

module.exports = { ReasoningStore, conversationScope };
