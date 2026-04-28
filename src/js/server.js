#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const { loadConfig, defaultConfigPath, defaultReasoningContentPath } = require('./config');
const { ReasoningStore, conversationScope } = require('./reasoningStore');
const { StreamAccumulator, CursorReasoningDisplayAdapter } = require('./streaming');
const { NgrokTunnel, localTunnelTarget } = require('./tunnel');
const { PLACEHOLDER_REASONING_CONTENT, prepareUpstreamRequest, rewriteResponseBody } = require('./transform');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(level, ...args) {
  const msg = args.join(' ');
  process.stderr.write(`${timestamp()} ${level.toUpperCase()} ${msg}\n`);
}

const LOG = {
  info: (...a) => log('INFO', ...a),
  warn: (...a) => log('WARN', ...a),
  error: (...a) => log('ERROR', ...a),
  debug: (...a) => log('DEBUG', ...a),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsedMs(startedAt) {
  return Math.round(Date.now() - startedAt);
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function compactRequestStats(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = payload.tools;
  let reasoningCount = 0;
  let reasoningChars = 0;
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    if (typeof msg.reasoning_content === 'string') {
      reasoningCount++;
      reasoningChars += msg.reasoning_content.length;
    }
  }
  const rounds = messages.filter(m => m && m.role === 'user').length;
  return (
    `model=${payload.model} stream=${payload.stream ? 1 : 0} ` +
    `rounds=${rounds} msgs=${messages.length} ` +
    `tools=${Array.isArray(tools) ? tools.length : 0} ` +
    `reasoning=${reasoningCount}/${reasoningChars}ch`
  );
}

function compactUsageStats(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens, completion_tokens, total_tokens,
    prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss } = usage;
  const details = usage.completion_tokens_details;
  const reasoningTokens = (details && typeof details === 'object')
    ? details.reasoning_tokens
    : undefined;

  if ([prompt_tokens, completion_tokens, total_tokens, hit, miss, reasoningTokens]
    .every(v => v == null)) return null;

  let cacheSummary = 'cache=?';
  if (hit != null || miss != null) {
    const h = parseInt(hit || 0, 10) || 0;
    const m = parseInt(miss || 0, 10) || 0;
    const total = h + m;
    if (total) {
      cacheSummary = `cache=${h}/${m} hit=${(h / total * 100).toFixed(1)}%`;
    } else {
      cacheSummary = `cache=${h}/${m}`;
    }
  }
  return (
    `prompt=${prompt_tokens ?? '?'} completion=${completion_tokens ?? '?'} ` +
    `total=${total_tokens ?? '?'} ${cacheSummary} reasoning=${reasoningTokens ?? '?'}`
  );
}

function logUsage(usage) {
  const summary = compactUsageStats(usage);
  if (summary) LOG.info(`deepseek usage: ${summary}`);
}

function logReasoningCacheStats(store) {
  try {
    const stats = store.stats();
    const { total_rows: rows, oldest_age_seconds: oldest, newest_age_seconds: newest,
      db_file_size_bytes: dbSize, max_rows: maxRows, max_age_seconds: maxAge } = stats;

    let ageInfo = '';
    if (rows > 0 && oldest != null && newest != null) {
      ageInfo = ` oldest=${Math.round(oldest)}s newest=${Math.round(newest)}s`;
    }
    let sizeInfo = '';
    if (dbSize != null) {
      if (dbSize > 1024 * 1024) sizeInfo = ` dbfile=${(dbSize / 1024 / 1024).toFixed(1)}MB`;
      else if (dbSize > 1024) sizeInfo = ` dbfile=${(dbSize / 1024).toFixed(1)}KB`;
      else sizeInfo = ` dbfile=${dbSize}B`;
    }
    let ttlInfo = '';
    if (maxRows) {
      const pct = rows > 0 ? Math.round(rows / maxRows * 100) : 0;
      ttlInfo = ` util=${pct}%/${maxRows}`;
    }
    const maxAgeH = maxAge ? `${Math.floor(maxAge / 3600)}h` : 'unlimited';
    LOG.info(`reasoning cache: ${rows} rows${ageInfo}${sizeInfo}${ttlInfo} max_age=${maxAgeH}`);
  } catch (_e) {
    LOG.debug('failed to collect reasoning cache stats');
  }
}

// ---------------------------------------------------------------------------
// Upstream HTTP request
// ---------------------------------------------------------------------------

/**
 * Make a proxied HTTPS/HTTP request to the upstream DeepSeek API.
 * Returns a promise that resolves to the IncomingMessage response object.
 */
function makeUpstreamRequest(upstreamUrl, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(upstreamUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

    const options = {
      hostname: parsed.hostname,
      port,
      path: parsed.path,
      method,
      headers,
      timeout: timeoutMs,
    };

    const req = transport.request(options, resolve);
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('upstream request timeout'));
    });
    req.write(body);
    req.end();
  });
}

function decompressBody(buffer, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'gzip') return zlib.gunzipSync(buffer);
  if (enc === 'deflate') {
    try {
      return zlib.inflateSync(buffer);
    } catch (_e) {
      return zlib.inflateRawSync(buffer);
    }
  }
  return buffer;
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(decompressBody(buf, res.headers['content-encoding']));
    });
    res.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function warnIfInsecureUpstream(baseUrl) {
  try {
    const parsed = url.parse(baseUrl);
    if (parsed.protocol !== 'http:') return;
    const host = parsed.hostname || '';
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) return;
    LOG.warn('upstream base_url uses plain HTTP; bearer tokens may be exposed');
  } catch (_e) {
    // ignore
  }
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Origin, Content-Type, Accept, Authorization',
    'Access-Control-Expose-Headers': 'Content-Length',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function sendJson(res, status, payload, cors) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (cors) Object.assign(headers, getCorsHeaders());
  res.writeHead(status, headers);
  res.end(body);
}

function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const match = /^bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token ? `Bearer ${token}` : null;
}

/**
 * Handle a single HTTP request.
 */
async function handleRequest(req, res, config, store) {
  const parsedUrl = url.parse(req.url || '/');
  const reqPath = parsedUrl.pathname || '/';
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    if (config.verbose) {
      LOG.info(`incoming OPTIONS ${reqPath} from ${req.socket.remoteAddress}`);
    }
    const headers = { 'Content-Length': '0' };
    if (config.cors) Object.assign(headers, getCorsHeaders());
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (method === 'GET') {
    if (config.verbose) {
      LOG.info(`incoming GET ${reqPath} from ${req.socket.remoteAddress}`);
    }
    if (reqPath === '/healthz' || reqPath === '/v1/healthz') {
      return sendJson(res, 200, { ok: true }, config.cors);
    }
    if (reqPath === '/models' || reqPath === '/v1/models') {
      const created = Math.floor(Date.now() / 1000);
      const modelIds = [...new Set([config.upstreamModel, 'deepseek-v4-pro', 'deepseek-v4-flash'])];
      const models = modelIds.map(id => ({ id, object: 'model', created, owned_by: 'deepseek' }));
      return sendJson(res, 200, { object: 'list', data: models }, config.cors);
    }
    if (reqPath === '/reasoning-cache' || reqPath === '/v1/reasoning-cache') {
      return sendJson(res, 200, {
        ok: true,
        cache: store.stats(),
        diagnostic: store.diagnosticInfo(),
      }, config.cors);
    }
    return sendJson(res, 404, { error: { message: 'Not found' } }, config.cors);
  }

  if (method === 'POST') {
    const startedAt = Date.now();
    if (config.verbose) {
      LOG.info(
        `incoming POST ${reqPath} from ${req.socket.remoteAddress} ` +
        `content_length=${req.headers['content-length'] || '0'} ` +
        `user_agent=${req.headers['user-agent'] || ''}`,
      );
    }

    if (reqPath !== '/chat/completions' && reqPath !== '/v1/chat/completions') {
      LOG.warn(`rejected unsupported POST path=${reqPath} status=404`);
      return sendJson(res, 404, { error: { message: 'Only /v1/chat/completions is supported' } }, config.cors);
    }

    const authorization = extractBearerToken(req.headers['authorization']);
    if (!authorization) {
      LOG.warn(`rejected request path=${reqPath} status=401 reason=missing_bearer_token`);
      return sendJson(res, 401, { error: { message: 'Missing Authorization bearer token' } }, config.cors);
    }

    // Read and parse request body
    let payload;
    try {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (isNaN(contentLength) || contentLength < 0) {
        return sendJson(res, 400, { error: { message: 'Invalid Content-Length' } }, config.cors);
      }
      if (contentLength > config.maxRequestBodyBytes) {
        LOG.warn(`rejected request path=${reqPath} status=413 reason=body_too_large`);
        return sendJson(res, 413, {
          error: { message: `Request body is too large; limit is ${config.maxRequestBodyBytes} bytes` },
        }, config.cors);
      }
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > config.maxRequestBodyBytes) {
          LOG.warn(`rejected request path=${reqPath} status=413 reason=body_too_large`);
          return sendJson(res, 413, {
            error: { message: `Request body is too large; limit is ${config.maxRequestBodyBytes} bytes` },
          }, config.cors);
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks);
      if (!rawBody.length) {
        return sendJson(res, 400, { error: { message: 'Request body is empty' } }, config.cors);
      }
      payload = JSON.parse(rawBody.toString('utf-8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { error: { message: 'Request body must be a JSON object' } }, config.cors);
      }
    } catch (err) {
      LOG.warn(`rejected request path=${reqPath} status=400 reason=${err.message}`);
      return sendJson(res, 400, { error: { message: `Invalid JSON: ${err.message}` } }, config.cors);
    }

    if (config.verbose) {
      LOG.info(`cursor request body:\n${JSON.stringify(payload, null, 2)}`);
    }
    LOG.info(`cursor request: ${compactRequestStats(payload)}`);

    const prepared = prepareUpstreamRequest(payload, config, store, authorization);

    if (prepared.patchedReasoningMessages) {
      LOG.info(`restored reasoning_content on ${prepared.patchedReasoningMessages} assistant message(s)`);
    }
    if (prepared.placeholderReasoningMessages) {
      LOG.warn(
        `inserted placeholder reasoning_content on ${prepared.placeholderReasoningMessages} assistant ` +
        'message(s); this is compatibility mode and may still be rejected by DeepSeek',
      );
    }
    if (prepared.missingReasoningMessages) {
      const diagPlaceholder =
        `${PLACEHOLDER_REASONING_CONTENT} [not sent upstream because missing_reasoning_strategy=reject]`;
      const cacheDiag = store.diagnosticInfo();
      LOG.warn(
        `rejected request path=${reqPath} status=409 reason=missing_reasoning_content ` +
        `count=${prepared.missingReasoningMessages} cache_rows=${cacheDiag.rows} ` +
        `cache_location=${cacheDiag.cache_location}`,
      );
      return sendJson(res, 409, {
        error: {
          message:
            `Missing cached DeepSeek reasoning_content for a thinking-mode tool-call history on ` +
            `${prepared.missingReasoningMessages} assistant message(s). This usually means the chat ` +
            `has tool-call turns that were not captured by this proxy/cache. ` +
            `Cache has ${cacheDiag.rows} row(s) at ${cacheDiag.cache_location}. ` +
            `Start a new chat or retry from the original tool-call turn. ` +
            `Use \`deepseek-roocode-proxy --reasoning-cache-stats\` for details.`,
          type: 'missing_reasoning_content',
          code: 'missing_reasoning_content',
          missing_reasoning_messages: prepared.missingReasoningMessages,
          diagnostic_placeholder: diagPlaceholder,
          cache_diagnostic: cacheDiag,
        },
      }, config.cors);
    }

    LOG.info(
      `deepseek send: ${compactRequestStats(prepared.payload)} ` +
      `patched=${prepared.patchedReasoningMessages} placeholder=${prepared.placeholderReasoningMessages}`,
    );

    if (config.verbose) {
      LOG.info(`upstream request body:\n${JSON.stringify(prepared.payload, null, 2)}`);
    }

    const upstreamBody = JSON.stringify(prepared.payload);
    const upstreamUrl = `${config.upstreamBaseUrl}/chat/completions`;
    const isStream = !!prepared.payload.stream;
    const upstreamHeaders = {
      'Authorization': authorization,
      'Content-Type': 'application/json',
      'Accept': isStream ? 'text/event-stream' : 'application/json',
      'Accept-Encoding': 'identity',
      'Content-Length': Buffer.byteLength(upstreamBody),
      'User-Agent': 'DeepSeekNodeProxy/1.0',
    };
    const acceptLanguage = req.headers['accept-language'];
    if (acceptLanguage) upstreamHeaders['Accept-Language'] = acceptLanguage;

    let upstreamRes;
    try {
      if (config.verbose) LOG.info(`forwarding to ${upstreamUrl}`);
      upstreamRes = await makeUpstreamRequest(
        upstreamUrl,
        'POST',
        upstreamHeaders,
        upstreamBody,
        config.requestTimeout * 1000,
      );
    } catch (err) {
      LOG.warn(`upstream request failed elapsed_ms=${elapsedMs(startedAt)} reason=${err.message}`);
      return sendJson(res, 502, { error: { message: `Upstream request failed: ${err.message}` } }, config.cors);
    }

    const upstreamStatus = upstreamRes.statusCode || 200;
    if (config.verbose) {
      LOG.info(
        `upstream response status=${upstreamStatus} stream=${isStream} elapsed_ms=${elapsedMs(startedAt)}`,
      );
    }

    if (upstreamStatus >= 400) {
      LOG.warn(
        `request failed upstream_status=${upstreamStatus} stream=${isStream} elapsed_ms=${elapsedMs(startedAt)}`,
      );
      const errBody = await readBody(upstreamRes);
      const respHeaders = { 'Content-Type': upstreamRes.headers['content-type'] || 'application/json' };
      if (config.cors) Object.assign(respHeaders, getCorsHeaders());
      res.writeHead(upstreamStatus, respHeaders);
      res.end(errBody);
      return;
    }

    if (isStream) {
      await proxyStreamingResponse(res, upstreamRes, config, store, prepared, startedAt);
    } else {
      await proxyRegularResponse(res, upstreamRes, config, store, prepared, startedAt);
    }

    LOG.info(
      `request complete status=${upstreamStatus} stream=${isStream} elapsed_ms=${elapsedMs(startedAt)} ` +
      `patched_reasoning=${prepared.patchedReasoningMessages} missing_reasoning=${prepared.missingReasoningMessages}`,
    );
    return;
  }

  return sendJson(res, 405, { error: { message: 'Method not allowed' } }, config.cors);
}

async function proxyRegularResponse(res, upstreamRes, config, store, prepared, startedAt) {
  const upstreamStatus = upstreamRes.statusCode || 200;
  const buf = await readBody(upstreamRes);

  let bodyStr = buf.toString('utf-8');
  try {
    bodyStr = rewriteResponseBody(
      bodyStr,
      prepared.originalModel,
      store,
      prepared.payload.messages,
      prepared.cacheNamespace,
    );
  } catch (err) {
    LOG.warn(`failed to rewrite upstream JSON response: ${err.message}`);
  }

  // Log usage from response
  try {
    const respPayload = JSON.parse(bodyStr);
    if (respPayload && respPayload.usage) logUsage(respPayload.usage);
  } catch (_e) {
    // ignore
  }

  if (config.verbose) {
    LOG.info(`cursor response body:\n${bodyStr}`);
  }

  const bodyBuf = Buffer.from(bodyStr, 'utf-8');
  const headers = {
    'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
    'Content-Length': bodyBuf.length,
  };
  if (config.cors) Object.assign(headers, getCorsHeaders());
  res.writeHead(upstreamStatus, headers);
  res.end(bodyBuf);
}

async function proxyStreamingResponse(res, upstreamRes, config, store, prepared, _startedAt) {
  const upstreamStatus = upstreamRes.statusCode || 200;
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
  };
  if (config.cors) Object.assign(headers, getCorsHeaders());
  res.writeHead(upstreamStatus, headers);

  const accumulator = new StreamAccumulator();
  const displayAdapter = config.cursorDisplayReasoning ? new CursorReasoningDisplayAdapter() : null;
  const scope = conversationScope(prepared.payload.messages, prepared.cacheNamespace);

  let lineBuffer = '';
  let finalized = false;

  await new Promise((resolve, reject) => {
    upstreamRes.setEncoding('utf-8');
    upstreamRes.on('data', (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep partial last line

      for (const rawLine of lines) {
        const line = rawLine + '\n';
        if (finalized) continue;
        const result = rewriteSseLine(
          line,
          prepared.originalModel,
          accumulator,
          scope,
          displayAdapter,
          config,
          store,
        );
        if (result.output) {
          res.write(result.output);
        }
        if (result.finalized) {
          finalized = true;
        }
      }
    });

    upstreamRes.on('end', () => {
      // Handle any remaining buffer
      if (lineBuffer.trim()) {
        const result = rewriteSseLine(
          lineBuffer,
          prepared.originalModel,
          accumulator,
          scope,
          displayAdapter,
          config,
          store,
        );
        if (result.output) res.write(result.output);
        if (result.finalized) finalized = true;
      }

      if (!finalized) {
        if (displayAdapter) {
          const closingChunk = displayAdapter.flushChunk(prepared.originalModel);
          if (closingChunk) res.write(sseData(closingChunk));
        }
        if (config.verbose) {
          LOG.info(`model streaming assistant messages:\n${JSON.stringify(accumulator.messages(), null, 2)}`);
        }
        const stored = accumulator.storeReasoning(store, scope);
        if (stored) LOG.info(`stored ${stored} streaming reasoning cache key(s)`);
      }

      res.end();
      resolve();
    });

    upstreamRes.on('error', (err) => {
      LOG.warn(`upstream stream error: ${err.message}`);
      res.end();
      resolve();
    });
  });
}

function rewriteSseLine(line, originalModel, accumulator, scope, displayAdapter, config, store) {
  const stripped = line.trim();
  if (!stripped.startsWith('data:')) {
    return { output: line, finalized: false };
  }

  const data = stripped.slice('data:'.length).trim();
  if (data === '[DONE]') {
    if (config.verbose) {
      LOG.info(`model streaming assistant messages:\n${JSON.stringify(accumulator.messages(), null, 2)}`);
    }
    const stored = accumulator.storeReasoning(store, scope);
    if (stored) LOG.info(`stored ${stored} streaming reasoning cache key(s)`);

    if (!displayAdapter) {
      return { output: 'data: [DONE]\n\n', finalized: true };
    }
    const closingChunk = displayAdapter.flushChunk(originalModel);
    if (!closingChunk) {
      return { output: 'data: [DONE]\n\n', finalized: true };
    }
    return { output: sseData(closingChunk) + 'data: [DONE]\n\n', finalized: true };
  }

  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch (_e) {
    return { output: line, finalized: false };
  }

  if (chunk && typeof chunk === 'object') {
    accumulator.ingestChunk(chunk);
    const stored = accumulator.storeFinishedReasoning(store, scope);
    if (stored) LOG.info(`stored ${stored} streaming reasoning cache key(s)`);

    logUsage(chunk.usage);

    if (displayAdapter) displayAdapter.rewriteChunk(chunk);
    if ('model' in chunk) chunk.model = originalModel;

    const ending = line.endsWith('\r\n') ? '\r\n' : '\n';
    return { output: `data: ${JSON.stringify(chunk)}${ending}`, finalized: false };
  }

  return { output: line, finalized: false };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function buildArgParser(argv) {
  const minimist = require('minimist');
  const args = minimist(argv, {
    string: ['config', 'host', 'model', 'base-url', 'reasoning-content-path', 'missing-reasoning-strategy'],
    boolean: ['ngrok', 'verbose', 'no-cursor-display-reasoning', 'clear-reasoning-cache', 'reasoning-cache-stats', 'help'],
    number: ['port'],
    alias: {
      h: 'help',
      v: 'verbose',
    },
  });
  return args;
}

function printHelp() {
  process.stdout.write(`
Usage: deepseek-roocode-proxy [options]

Options:
  --config <path>                    YAML config file (default: ~/.deepseek-cursor-proxy/config.yaml)
  --host <host>                      Bind host (default from config, PROXY_HOST, or 127.0.0.1)
  --port <port>                      Bind port (default from config, PROXY_PORT, or 9000)
  --model <model>                    Fallback DeepSeek model (default: deepseek-v4-pro)
  --base-url <url>                   DeepSeek base URL (default: https://api.deepseek.com)
  --reasoning-content-path <path>    SQLite reasoning cache path
  --ngrok                            Start an ngrok tunnel and print the public base URL
  --verbose                          Log detailed request metadata and full payloads
  --no-cursor-display-reasoning      Do not mirror reasoning_content into <think> content
  --missing-reasoning-strategy       reject (default) or placeholder
  --clear-reasoning-cache            Clear the local SQLite reasoning cache and exit
  --reasoning-cache-stats            Print reasoning cache statistics and exit
  -h, --help                         Show this help

`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = buildArgParser(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const overrides = {};
  if (args.host) overrides.host = args.host;
  if (args.port) overrides.port = args.port;
  if (args.model) overrides.upstreamModel = args.model;
  if (args['base-url']) overrides.upstreamBaseUrl = args['base-url'].replace(/\/$/, '');
  if (args['reasoning-content-path']) overrides.reasoningContentPath = args['reasoning-content-path'];
  if (args.ngrok) overrides.ngrok = true;
  if (args.verbose) overrides.verbose = true;
  if (args['no-cursor-display-reasoning']) overrides.cursorDisplayReasoning = false;
  if (args['missing-reasoning-strategy']) overrides.missingReasoningStrategy = args['missing-reasoning-strategy'];

  let config;
  try {
    config = loadConfig({ configPath: args.config, overrides });
  } catch (err) {
    LOG.error(err.message);
    process.exit(2);
  }

  warnIfInsecureUpstream(config.upstreamBaseUrl);

  const store = new ReasoningStore(config.reasoningContentPath, {
    maxAgeSeconds: config.reasoningCacheMaxAgeSeconds,
    maxRows: config.reasoningCacheMaxRows,
  });

  if (args['reasoning-cache-stats']) {
    const stats = store.stats();
    console.log(`Reasoning cache location: ${store.reasoningContentPath}`);
    console.log(`  Total rows: ${stats.total_rows}`);
    console.log(stats.oldest_age_seconds != null
      ? `  Oldest entry: ${stats.oldest_age_seconds}s ago`
      : '  Oldest entry: N/A');
    console.log(stats.newest_age_seconds != null
      ? `  Newest entry: ${stats.newest_age_seconds}s ago`
      : '  Newest entry: N/A');
    console.log(`  Total keys data size: ${stats.total_keys_size_bytes} bytes`);
    if (stats.db_file_size_bytes != null) {
      console.log(`  Database file size: ${stats.db_file_size_bytes} bytes`);
    }
    console.log(`  Max rows: ${stats.max_rows}`);
    console.log(`  Max age: ${stats.max_age_seconds}s`);
    store.close();
    process.exit(0);
  }

  if (args['clear-reasoning-cache']) {
    const deleted = store.clear();
    LOG.info(`cleared ${deleted} reasoning cache row(s)`);
    store.close();
    process.exit(0);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config, store);
    } catch (err) {
      LOG.error(`unhandled error: ${err.message}\n${err.stack}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: 'Internal server error' } }, config.cors);
      }
    }
  });

  LOG.info(`listening on http://${config.host}:${config.port}/v1`);
  LOG.info(
    `forwarding to ${config.upstreamBaseUrl}/chat/completions default_model=${config.upstreamModel}`,
  );
  LOG.info(
    `thinking=${config.thinking} reasoning_effort=${config.reasoningEffort} ` +
    `cursor_display_reasoning=${config.cursorDisplayReasoning} ` +
    `missing_reasoning_strategy=${config.missingReasoningStrategy} ` +
    `reasoning_content_path=${config.reasoningContentPath}`,
  );
  logReasoningCacheStats(store);

  if (config.missingReasoningStrategy === 'placeholder') {
    LOG.warn(
      'missing_reasoning_strategy=placeholder is not DeepSeek-compliant; ' +
      'use only to test old histories whose original reasoning cannot be recovered',
    );
  }
  if (config.verbose) {
    LOG.info('logging mode=verbose metadata=detailed bodies=true');
    LOG.warn('verbose logging enabled; prompts and code may be written to stderr');
  } else {
    LOG.info('logging mode=normal metadata=safe_summaries bodies=false');
  }

  let tunnel = null;
  if (config.ngrok) {
    const targetUrl = localTunnelTarget(config.host, config.port);
    tunnel = new NgrokTunnel(targetUrl);
    try {
      const publicUrl = await tunnel.start();
      LOG.info(`ngrok tunnel forwarding ${publicUrl} -> ${targetUrl}`);
      LOG.info(`RooCode Base URL: ${publicUrl.replace(/\/$/, '')}/v1`);
    } catch (err) {
      LOG.error(err.message);
      server.close();
      store.close();
      process.exit(2);
    }
  }

  server.listen(config.port, config.host, () => {
    LOG.info(`proxy ready at http://${config.host}:${config.port}/v1`);
  });

  const shutdown = () => {
    LOG.info('shutting down');
    if (tunnel) tunnel.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
