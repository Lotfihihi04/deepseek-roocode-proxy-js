'use strict';

const crypto = require('crypto');
const { conversationScope } = require('./reasoningStore');

const SUPPORTED_REQUEST_FIELDS = new Set([
  'model', 'messages', 'stream', 'stream_options', 'max_tokens',
  'response_format', 'stop', 'tools', 'tool_choice', 'thinking',
  'reasoning_effort', 'temperature', 'top_p', 'presence_penalty',
  'frequency_penalty', 'logprobs', 'top_logprobs',
]);

const MESSAGE_FIELDS = new Set([
  'role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content', 'prefix',
]);

const ROLE_MESSAGE_FIELDS = {
  system: new Set(['role', 'content', 'name']),
  user: new Set(['role', 'content', 'name']),
  assistant: new Set(['role', 'content', 'name', 'tool_calls', 'reasoning_content', 'prefix']),
  tool: new Set(['role', 'content', 'tool_call_id']),
};

const EFFORT_ALIASES = {
  low: 'high',
  medium: 'high',
  high: 'high',
  max: 'max',
  xhigh: 'max',
};

const CURSOR_THINKING_BLOCK_RE = /<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)\s*/gi;

const PLACEHOLDER_REASONING_CONTENT =
  '[deepseek-cursor-proxy placeholder reasoning_content: original DeepSeek ' +
  'reasoning_content was missing from client history and unavailable in the ' +
  'local cache. This is an opt-in compatibility fallback, not the original ' +
  'model reasoning.]';

function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return 'high';
  return EFFORT_ALIASES[value.trim().toLowerCase()] || 'high';
}

function extractTextContent(content) {
  if (content == null || typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') {
        parts.push(String(item));
        continue;
      }
      const itemType = item.type;
      const text = item.text || item.content;
      if ((itemType === 'text' || itemType === 'input_text') && typeof text === 'string') {
        parts.push(text);
      } else if (typeof text === 'string') {
        parts.push(text);
      } else if (itemType) {
        parts.push(`[${itemType} omitted by DeepSeek text proxy]`);
      }
    }
    return parts.filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    return JSON.stringify(content);
  }
  return String(content);
}

function stripCursorThinkingBlocks(content) {
  return content.replace(CURSOR_THINKING_BLOCK_RE, '').replace(/^[\r\n]+/, '');
}

function normalizeToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') toolCall = {};
  const fn = (toolCall.function && typeof toolCall.function === 'object') ? toolCall.function : {};
  let args = fn.arguments !== undefined ? fn.arguments : '';
  if (typeof args !== 'string') {
    args = JSON.stringify(args);
  }
  const normalized = {
    id: String(toolCall.id || ''),
    type: toolCall.type || 'function',
    function: {
      name: String(fn.name || ''),
      arguments: args,
    },
  };
  if (!normalized.id) delete normalized.id;
  return normalized;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return { type: 'function', function: { name: '', description: '', parameters: {} } };
  }
  const normalized = Object.assign({}, tool);
  normalized.type = normalized.type || 'function';
  return normalized;
}

function legacyFunctionToTool(fn) {
  if (!fn || typeof fn !== 'object') fn = {};
  return { type: 'function', function: fn };
}

function convertFunctionCall(functionCall) {
  if (typeof functionCall === 'string') {
    return ['auto', 'none', 'required'].includes(functionCall) ? functionCall : null;
  }
  if (functionCall && typeof functionCall === 'object' && functionCall.name) {
    return { type: 'function', function: { name: String(functionCall.name) } };
  }
  return null;
}

function normalizeToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') {
    return ['auto', 'none', 'required'].includes(toolChoice) ? toolChoice : null;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function') {
      const fn = toolChoice.function;
      if (fn && typeof fn === 'object' && fn.name) {
        return { type: 'function', function: { name: String(fn.name) } };
      }
    }
    return toolChoice;
  }
  return toolChoice;
}

function assistantNeedsReasoningForToolContext(message, priorMessages) {
  if (message.tool_calls && message.tool_calls.length > 0) return true;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const prior = priorMessages[i];
    if (prior.role === 'tool') return true;
    if (prior.role === 'user' || prior.role === 'system') return false;
  }
  return false;
}

/**
 * Normalize a single message.
 * Returns { normalized, patched, placeholder, missing }.
 */
function normalizeMessage(
  message,
  store,
  priorMessages,
  cacheNamespace,
  repairReasoning,
  keepReasoning,
  missingReasoningStrategy,
) {
  if (!message || typeof message !== 'object') {
    message = { role: 'user', content: String(message) };
  }
  const normalized = {};
  for (const key of MESSAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(message, key)) {
      normalized[key] = message[key];
    }
  }
  let role = normalized.role || 'user';
  if (role === 'function') role = 'tool';
  normalized.role = role;

  if (Object.prototype.hasOwnProperty.call(normalized, 'content')) {
    normalized.content = extractTextContent(normalized.content) || '';
  } else if (['assistant', 'tool', 'system', 'user'].includes(role)) {
    normalized.content = '';
  }

  if (role === 'assistant' && typeof normalized.content === 'string') {
    normalized.content = stripCursorThinkingBlocks(normalized.content);
    if (!normalized.content.trim()) normalized.content = '';
  }

  if (normalized.tool_calls) {
    normalized.tool_calls = (normalized.tool_calls || []).map(normalizeToolCall);
  }

  let patched = false;
  let placeholder = false;
  let missing = false;

  if (role === 'assistant') {
    if (!keepReasoning) {
      delete normalized.reasoning_content;
    } else if (repairReasoning) {
      const reasoning = normalized.reasoning_content;
      if (typeof reasoning !== 'string') {
        delete normalized.reasoning_content;
        const needsReasoning = assistantNeedsReasoningForToolContext(normalized, priorMessages);
        if (needsReasoning && store != null) {
          const scope = conversationScope(priorMessages, cacheNamespace);
          const restored = store.lookupForMessage(normalized, scope);
          if (restored !== null) {
            normalized.reasoning_content = restored;
            patched = true;
          }
        }
        if (needsReasoning && !patched) {
          if (missingReasoningStrategy === 'placeholder') {
            normalized.reasoning_content = PLACEHOLDER_REASONING_CONTENT;
            placeholder = true;
          } else {
            missing = true;
          }
        }
      }
    }
  }

  const allowedFields = ROLE_MESSAGE_FIELDS[normalized.role] || MESSAGE_FIELDS;
  const filtered = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      filtered[key] = normalized[key];
    }
  }
  return { normalized: filtered, patched, placeholder, missing };
}

function normalizeMessages(
  messages,
  store,
  cacheNamespace,
  repairReasoning,
  keepReasoning,
  missingReasoningStrategy,
) {
  if (!Array.isArray(messages)) return { messages: [], patched: 0, placeholder: 0, missing: 0 };
  const normalizedMessages = [];
  let patchedCount = 0;
  let placeholderCount = 0;
  let missingCount = 0;

  for (const message of messages) {
    const { normalized, patched, placeholder, missing } = normalizeMessage(
      message,
      store,
      normalizedMessages,
      cacheNamespace,
      repairReasoning,
      keepReasoning,
      missingReasoningStrategy,
    );
    normalizedMessages.push(normalized);
    if (patched) patchedCount++;
    if (placeholder) placeholderCount++;
    if (missing) missingCount++;
  }

  return { messages: normalizedMessages, patched: patchedCount, placeholder: placeholderCount, missing: missingCount };
}

function upstreamModelFor(originalModel, config) {
  if (originalModel.startsWith('deepseek-')) return originalModel;
  return config.upstreamModel;
}

function reasoningCacheNamespace(config, upstreamModel, thinking, reasoningEffort, authorization) {
  let authHash = '';
  if (authorization) {
    authHash = crypto.createHash('sha256').update(authorization, 'utf8').digest('hex');
  }
  const payload = {
    base_url: config.upstreamBaseUrl,
    model: upstreamModel,
    thinking,
    reasoning_effort: reasoningEffort,
    authorization_hash: authHash,
  };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Prepare the upstream request payload.
 * Returns a PreparedRequest object.
 */
function prepareUpstreamRequest(payload, config, store, authorization) {
  const originalModel = String(payload.model || config.upstreamModel);
  const upstreamModel = upstreamModelFor(originalModel, config);

  const prepared = {};
  for (const key of SUPPORTED_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      prepared[key] = payload[key];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(prepared, 'max_tokens') &&
      Object.prototype.hasOwnProperty.call(payload, 'max_completion_tokens')) {
    prepared.max_tokens = payload.max_completion_tokens;
  }

  prepared.model = upstreamModel;

  if (prepared.stream) {
    const streamOptions = (prepared.stream_options && typeof prepared.stream_options === 'object')
      ? Object.assign({}, prepared.stream_options)
      : {};
    streamOptions.include_usage = true;
    prepared.stream_options = streamOptions;
  }

  if (Array.isArray(prepared.tools)) {
    prepared.tools = prepared.tools.map(normalizeTool);
  } else if (Array.isArray(payload.functions)) {
    prepared.tools = payload.functions.map(legacyFunctionToTool);
  }

  if (Object.prototype.hasOwnProperty.call(prepared, 'tool_choice')) {
    const tc = normalizeToolChoice(prepared.tool_choice);
    if (tc == null) {
      delete prepared.tool_choice;
    } else {
      prepared.tool_choice = tc;
    }
  } else if (Object.prototype.hasOwnProperty.call(payload, 'function_call')) {
    const tc = convertFunctionCall(payload.function_call);
    if (tc != null) prepared.tool_choice = tc;
  }

  if (config.thinking !== 'pass-through') {
    prepared.thinking = { type: config.thinking };
  }

  const thinking = prepared.thinking;
  const thinkingEnabled = thinking && typeof thinking === 'object' && thinking.type === 'enabled';
  const thinkingDisabled = thinking && typeof thinking === 'object' && thinking.type === 'disabled';

  if (thinkingEnabled) {
    prepared.reasoning_effort = normalizeReasoningEffort(
      prepared.reasoning_effort || config.reasoningEffort,
    );
  }

  const cacheNamespace = reasoningCacheNamespace(
    config,
    upstreamModel,
    prepared.thinking,
    prepared.reasoning_effort,
    authorization,
  );

  const { messages, patched, placeholder, missing } = normalizeMessages(
    payload.messages,
    store,
    cacheNamespace,
    thinkingEnabled,
    !thinkingDisabled,
    config.missingReasoningStrategy,
  );
  prepared.messages = messages;

  return {
    payload: prepared,
    originalModel,
    upstreamModel,
    cacheNamespace,
    patchedReasoningMessages: patched,
    placeholderReasoningMessages: placeholder,
    missingReasoningMessages: missing,
  };
}

function recordResponseReasoning(responsePayload, store, requestMessages, cacheNamespace) {
  if (!store) return 0;
  if (!Array.isArray(responsePayload.choices)) return 0;
  const scope = conversationScope(requestMessages, cacheNamespace);
  let stored = 0;
  for (const choice of responsePayload.choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = choice.message;
    if (message && typeof message === 'object') {
      stored += store.storeAssistantMessage(message, scope);
    }
  }
  return stored;
}

function rewriteResponseBody(body, originalModel, store, requestMessages, cacheNamespace) {
  const responsePayload = JSON.parse(body);
  if (responsePayload && typeof responsePayload === 'object') {
    recordResponseReasoning(responsePayload, store, requestMessages, cacheNamespace);
    if ('model' in responsePayload) {
      responsePayload.model = originalModel;
    }
  }
  return JSON.stringify(responsePayload);
}

module.exports = {
  PLACEHOLDER_REASONING_CONTENT,
  prepareUpstreamRequest,
  rewriteResponseBody,
};
