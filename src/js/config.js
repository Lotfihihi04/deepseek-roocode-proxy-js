'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const APP_DIR_NAME = '.deepseek-cursor-proxy';
const CONFIG_FILE_NAME = 'config.yaml';
const REASONING_CONTENT_FILE_NAME = 'reasoning_content.json';

const DEFAULT_CONFIG_TEXT = `# This file was created automatically at ~/.deepseek-cursor-proxy/config.yaml.
# API keys are read from the client's Authorization header and forwarded upstream.

# \`model\` is the fallback when a request has no model; the client's requested
# DeepSeek model name is otherwise respected.
base_url: https://api.deepseek.com
model: deepseek-v4-pro
thinking: enabled
reasoning_effort: high
display_reasoning: true

host: 127.0.0.1
port: 9000
ngrok: false
verbose: false
request_timeout: 300
max_request_body_bytes: 20971520
cors: false

reasoning_content_path: reasoning_content.json
missing_reasoning_strategy: reject
reasoning_cache_max_age_seconds: 604800
reasoning_cache_max_rows: 10000
`;

function defaultAppDir() {
  return path.join(os.homedir(), APP_DIR_NAME);
}

function defaultConfigPath() {
  return path.join(defaultAppDir(), CONFIG_FILE_NAME);
}

function defaultReasoningContentPath() {
  return path.join(defaultAppDir(), REASONING_CONTENT_FILE_NAME);
}

function populateDefaultConfigFile(configPath) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_e) {
    // may fail in containers; best effort
  }
  fs.writeFileSync(configPath, DEFAULT_CONFIG_TEXT, { encoding: 'utf-8', mode: 0o600 });
}

function loadConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  let loaded;
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    loaded = yaml.load(text);
  } catch (err) {
    throw new Error(`Invalid YAML config at ${configPath}: ${err.message}`);
  }
  if (loaded == null) {
    return {};
  }
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error(`Config file must contain a YAML mapping: ${configPath}`);
  }
  return loaded;
}

const MISSING = Symbol('MISSING');
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function settingValue(settings, env, key, envName) {
  if (Object.prototype.hasOwnProperty.call(env, envName)) {
    return env[envName];
  }
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : MISSING;
}

function asStr(value, defaultVal) {
  if (value === MISSING || value == null) return defaultVal;
  return String(value);
}

function asBool(value, defaultVal) {
  if (value === MISSING || value == null) return defaultVal;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const norm = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(norm)) return true;
  if (FALSE_VALUES.has(norm)) return false;
  return defaultVal;
}

function asInt(value, defaultVal) {
  if (value === MISSING || value == null) return defaultVal;
  const n = parseInt(value, 10);
  return isNaN(n) ? defaultVal : n;
}

function asFloat(value, defaultVal) {
  if (value === MISSING || value == null) return defaultVal;
  const n = parseFloat(value);
  return isNaN(n) ? defaultVal : n;
}

function asPath(value, defaultPath, relativeBase) {
  if (value === MISSING || value == null || value === '') return defaultPath;
  const candidate = value.startsWith('~')
    ? path.join(os.homedir(), value.slice(1))
    : value;
  if (path.isAbsolute(candidate)) return candidate;
  return path.join(relativeBase, candidate);
}

/**
 * Build a ProxyConfig object from a YAML config file and environment.
 *
 * @param {object} options
 * @param {string} [options.configPath] - Path to the YAML config file.
 * @param {object} [options.env] - Environment variables (defaults to process.env).
 * @param {object} [options.overrides] - Key/value overrides (from CLI args).
 * @returns {ProxyConfig}
 */
function loadConfig({ configPath, env, overrides = {} } = {}) {
  const liveEnv = env || process.env;
  const resolvedConfigPath = configPath
    || liveEnv.DEEPSEEK_CURSOR_PROXY_CONFIG_PATH
    || defaultConfigPath();

  const resolvedConfigPathExpanded = resolvedConfigPath.startsWith('~')
    ? path.join(os.homedir(), resolvedConfigPath.slice(1))
    : resolvedConfigPath;

  const isDefault = resolvedConfigPathExpanded === defaultConfigPath()
    && !liveEnv.DEEPSEEK_CURSOR_PROXY_CONFIG_PATH;

  if (isDefault && !fs.existsSync(resolvedConfigPathExpanded)) {
    populateDefaultConfigFile(resolvedConfigPathExpanded);
  }

  const settings = loadConfigFile(resolvedConfigPathExpanded);
  const configDir = path.dirname(resolvedConfigPathExpanded);

  let thinking = asStr(
    settingValue(settings, liveEnv, 'thinking', 'DEEPSEEK_THINKING'),
    'enabled',
  ).trim().toLowerCase();
  if (['passthrough', 'pass-through', 'pass_through'].includes(thinking)) {
    thinking = 'pass-through';
  }
  if (!['enabled', 'disabled', 'pass-through'].includes(thinking)) {
    thinking = 'enabled';
  }

  let missingReasoningStrategy = asStr(
    settingValue(settings, liveEnv, 'missing_reasoning_strategy', 'MISSING_REASONING_STRATEGY'),
    'reject',
  ).trim().toLowerCase();
  if (!['reject', 'placeholder'].includes(missingReasoningStrategy)) {
    missingReasoningStrategy = 'reject';
  }

  const config = {
    host: asStr(settingValue(settings, liveEnv, 'host', 'PROXY_HOST'), '127.0.0.1'),
    port: asInt(settingValue(settings, liveEnv, 'port', 'PROXY_PORT'), 9000),
    upstreamBaseUrl: asStr(
      settingValue(settings, liveEnv, 'base_url', 'DEEPSEEK_BASE_URL'),
      'https://api.deepseek.com',
    ).replace(/\/$/, ''),
    upstreamModel: asStr(
      settingValue(settings, liveEnv, 'model', 'DEEPSEEK_MODEL'),
      'deepseek-v4-pro',
    ),
    allowModelPassthrough: asBool(
      settingValue(settings, liveEnv, 'allow_model_passthrough', 'DEEPSEEK_ALLOW_MODEL_PASSTHROUGH'),
      false,
    ),
    thinking,
    reasoningEffort: asStr(
      settingValue(settings, liveEnv, 'reasoning_effort', 'DEEPSEEK_REASONING_EFFORT'),
      'high',
    ),
    requestTimeout: asFloat(
      settingValue(settings, liveEnv, 'request_timeout', 'PROXY_REQUEST_TIMEOUT'),
      300.0,
    ),
    maxRequestBodyBytes: asInt(
      settingValue(settings, liveEnv, 'max_request_body_bytes', 'PROXY_MAX_REQUEST_BODY_BYTES'),
      20 * 1024 * 1024,
    ),
    reasoningContentPath: asPath(
      settingValue(settings, liveEnv, 'reasoning_content_path', 'REASONING_CONTENT_PATH'),
      defaultReasoningContentPath(),
      configDir,
    ),
    missingReasoningStrategy,
    reasoningCacheMaxAgeSeconds: asInt(
      settingValue(settings, liveEnv, 'reasoning_cache_max_age_seconds', 'REASONING_CACHE_MAX_AGE_SECONDS'),
      7 * 24 * 60 * 60,
    ),
    reasoningCacheMaxRows: asInt(
      settingValue(settings, liveEnv, 'reasoning_cache_max_rows', 'REASONING_CACHE_MAX_ROWS'),
      10000,
    ),
    cursorDisplayReasoning: asBool(
      settingValue(settings, liveEnv, 'display_reasoning', 'CURSOR_DISPLAY_REASONING'),
      true,
    ),
    cors: asBool(settingValue(settings, liveEnv, 'cors', 'PROXY_CORS'), false),
    verbose: asBool(settingValue(settings, liveEnv, 'verbose', 'PROXY_VERBOSE'), false),
    ngrok: asBool(settingValue(settings, liveEnv, 'ngrok', 'PROXY_NGROK'), false),
  };

  // Apply CLI overrides
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) {
      config[key] = value;
    }
  }

  return config;
}

module.exports = {
  loadConfig,
  defaultConfigPath,
  defaultReasoningContentPath,
};
