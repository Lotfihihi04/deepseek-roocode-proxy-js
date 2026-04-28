'use strict';

const { conversationScope } = require('./reasoningStore');

const THINKING_BLOCK_START = '<think>\n';
const THINKING_BLOCK_END = '\n</think>\n\n';

class StreamingChoice {
  constructor() {
    this.role = 'assistant';
    this.content = '';
    this.reasoningContent = '';
    this.hasReasoningContent = false;
    this.toolCalls = [];
    this.finishReason = null;
  }

  toMessage() {
    const message = { role: this.role, content: this.content };
    if (this.hasReasoningContent) {
      message.reasoning_content = this.reasoningContent;
    }
    if (this.toolCalls.length > 0) {
      message.tool_calls = this.toolCalls;
    }
    return message;
  }
}

class StreamAccumulator {
  constructor() {
    this.choices = new Map(); // index -> StreamingChoice
    this._storedChoices = new Set();
  }

  ingestChunk(chunk) {
    const choices = chunk.choices;
    if (!Array.isArray(choices)) return;

    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== 'object') continue;
      const index = Number(rawChoice.index || 0);
      if (!this.choices.has(index)) {
        this.choices.set(index, new StreamingChoice());
      }
      const choice = this.choices.get(index);

      const finishReason = rawChoice.finish_reason;
      if (typeof finishReason === 'string') {
        choice.finishReason = finishReason;
      }

      const delta = rawChoice.delta;
      if (!delta || typeof delta !== 'object') continue;

      const role = delta.role;
      if (typeof role === 'string' && role) {
        choice.role = role;
      }

      const content = delta.content;
      if (typeof content === 'string') {
        choice.content += content;
      }

      const reasoningContent = delta.reasoning_content;
      if (typeof reasoningContent === 'string') {
        choice.hasReasoningContent = true;
        choice.reasoningContent += reasoningContent;
      }

      this._mergeToolCallDeltas(choice, delta.tool_calls);
    }
  }

  storeReasoning(store, scope) {
    let stored = 0;
    for (const [index, choice] of this.choices) {
      stored += this._storeChoice(index, choice, store, scope);
    }
    return stored;
  }

  storeFinishedReasoning(store, scope) {
    let stored = 0;
    for (const [index, choice] of this.choices) {
      if (choice.finishReason !== null) {
        stored += this._storeChoice(index, choice, store, scope);
      }
    }
    return stored;
  }

  messages() {
    const sorted = Array.from(this.choices.entries()).sort(([a], [b]) => a - b);
    return sorted.map(([, choice]) => choice.toMessage());
  }

  _mergeToolCallDeltas(choice, deltas) {
    if (!Array.isArray(deltas)) return;
    for (const rawDelta of deltas) {
      if (!rawDelta || typeof rawDelta !== 'object') continue;
      let index = rawDelta.index;
      if (typeof index !== 'number') index = choice.toolCalls.length;
      while (choice.toolCalls.length <= index) {
        choice.toolCalls.push({ type: 'function', function: { name: '', arguments: '' } });
      }
      const toolCall = choice.toolCalls[index];
      if (rawDelta.id) toolCall.id = rawDelta.id;
      if (rawDelta.type) toolCall.type = rawDelta.type;
      const fnDelta = rawDelta.function;
      if (!fnDelta || typeof fnDelta !== 'object') continue;
      if (!toolCall.function) toolCall.function = { name: '', arguments: '' };
      if (fnDelta.name) {
        const existing = toolCall.function.name || '';
        const newName = String(fnDelta.name);
        toolCall.function.name = existing ? existing + newName : newName;
      }
      if ('arguments' in fnDelta && fnDelta.arguments != null) {
        toolCall.function.arguments = (toolCall.function.arguments || '') + String(fnDelta.arguments);
      }
    }
  }

  _storeChoice(index, choice, store, scope) {
    if (this._storedChoices.has(index)) return 0;
    const stored = store.storeAssistantMessage(choice.toMessage(), scope);
    if (stored) this._storedChoices.add(index);
    return stored;
  }
}

/**
 * Mirrors reasoning_content into content for visible thinking display.
 */
class CursorReasoningDisplayAdapter {
  constructor() {
    this._openChoices = new Set();
    this._lastChunkMetadata = {};
  }

  rewriteChunk(chunk) {
    this._rememberChunkMetadata(chunk);
    const choices = chunk.choices;
    if (!Array.isArray(choices)) return;

    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== 'object') continue;
      const index = Number(rawChoice.index || 0);
      let delta = rawChoice.delta;
      if (!delta || typeof delta !== 'object') {
        delta = {};
        rawChoice.delta = delta;
      }

      const mirroredParts = [];
      const reasoningContent = delta.reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent) {
        if (!this._openChoices.has(index)) {
          mirroredParts.push(THINKING_BLOCK_START);
          this._openChoices.add(index);
        }
        mirroredParts.push(reasoningContent);
      }

      const existingContent = delta.content;
      const shouldClose = this._openChoices.has(index) && (
        !!existingContent ||
        !!(delta.tool_calls && delta.tool_calls.length > 0) ||
        rawChoice.finish_reason != null
      );
      if (shouldClose) {
        mirroredParts.push(THINKING_BLOCK_END);
        this._openChoices.delete(index);
      }

      if (mirroredParts.length === 0) continue;
      if (typeof existingContent === 'string') {
        mirroredParts.push(existingContent);
      }
      delta.content = mirroredParts.join('');
    }
  }

  flushChunk(model) {
    if (this._openChoices.size === 0) return null;
    const indices = Array.from(this._openChoices).sort((a, b) => a - b);
    const choices = indices.map(index => ({
      index,
      delta: { content: THINKING_BLOCK_END },
      finish_reason: null,
    }));
    this._openChoices.clear();
    return {
      id: this._lastChunkMetadata.id || 'chatcmpl-reasoning-close',
      object: this._lastChunkMetadata.object || 'chat.completion.chunk',
      created: this._lastChunkMetadata.created || Math.floor(Date.now() / 1000),
      model,
      choices,
    };
  }

  _rememberChunkMetadata(chunk) {
    for (const key of ['id', 'object', 'created']) {
      if (Object.prototype.hasOwnProperty.call(chunk, key)) {
        this._lastChunkMetadata[key] = chunk[key];
      }
    }
  }
}

module.exports = { StreamAccumulator, CursorReasoningDisplayAdapter, conversationScope };
