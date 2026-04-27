<h1><img src="assets/logo.png" width="90" alt="deepseek-cursor-proxy logo" style="vertical-align: middle;"> deepseek-roocode-proxy</h1>

Compatibility proxy connecting RooCode and compatible editors to DeepSeek thinking models (`deepseek-v4-pro` and `deepseek-v4-flash`).

## What It Does

- ✅ Caches DeepSeek `reasoning_content` from regular and streamed responses, then restores it on later tool-call turns when the client omits it. If the exact original reasoning is unavailable, the proxy fails closed instead of sending a fake placeholder. See [DeepSeek docs](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls) for more details.
- ✅ Mirrors streamed `reasoning_content` into client-visible `<think>...</think>` text so that thinking tokens are shown in the editor's UI.
- ✅ Starts an ngrok tunnel for editors that require a public HTTPS URL (optional — RooCode works with localhost).
- ✅ Provides other compatibility fixes to make DeepSeek models run well in OpenAI-compatible editors like RooCode.

## Why This Exists

This repository fixes the following tool-call error when using DeepSeek with thinking mode enabled:

![Error 400 - reasoning_content must be passed back](assets/error_400.png)

```txt
⚠️ Connection Error
Provider returned error:
{
  "error": {
    "message": "The reasoning_content in the thinking mode must be passed back to the API.",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_request_error"
  }
}
```

## Usage

### Step 1: Install and Start the Proxy Server

**TL;DR Version**

```bash
# Install (activate your Python environment first)
git clone https://github.com/SpeedyGX/deepseek-roocode-proxy.git
cd deepseek-cursor-proxy
pip install -e .

# Start
deepseek-cursor-proxy
```

**Full Instructions with UV**

```bash
# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install
git clone https://github.com/SpeedyGX/deepseek-roocode-proxy.git
cd deepseek-cursor-proxy
uv sync
source .venv/bin/activate

# Start
deepseek-cursor-proxy
```

**Full Instructions with Conda**

```bash
# Install
conda create -n dcp python=3.10 -y
conda activate dcp
git clone https://github.com/SpeedyGX/deepseek-roocode-proxy.git
cd deepseek-cursor-proxy
pip install -e .

# Start
deepseek-cursor-proxy
```

On start, the proxy prints the local URL (`http://localhost:9000`) and, if ngrok is enabled, the ngrok public URL.

On the first run, `deepseek-cursor-proxy` will create:

- `~/.deepseek-cursor-proxy/config.yaml`: the configuration file
- `~/.deepseek-cursor-proxy/reasoning_content.sqlite3`: the reasoning content cache

### Step 2: Configure RooCode

In RooCode, set up a new API provider as follows:

| Setting           | Value                        |
|-------------------|------------------------------|
| API Provider      | OpenAI Compatible            |
| API URL           | `http://localhost:9000/v1`   |
| API Key           | Your DeepSeek API key        |
| Model             | `deepseek-v4-pro`            |

You can also use `deepseek-v4-flash` as the model name. The proxy respects the model name sent by the client; the `model` field in `config.yaml` is used as a fallback only when a request does not include a model.

### Step 3: (Optional) Set Up ngrok for Remote Editors

Some editors (e.g. Cursor) block non-public API URLs such as `localhost`. If you need to use the proxy with such an editor, [ngrok](https://ngrok.com/) can expose the local proxy via a public HTTPS URL. Alternatively, you may use [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/).

Create an ngrok account, then visit ngrok's dashboard: https://dashboard.ngrok.com

![ngrok dashboard](assets/ngrok_dashboard.png)

Then, install and authenticate ngrok once:

```bash
brew install ngrok
ngrok config add-authtoken <your-ngrok-token>
```

For example, if ngrok dashboard shows `https://example.ngrok-free.app`, use:

```text
https://example.ngrok-free.app/v1
```

> **Note:** RooCode supports localhost natively, so ngrok is not required when using RooCode.

### Step 4: Chat with DeepSeek in RooCode

Select `deepseek-v4-pro` in RooCode and use chat or agent mode as usual.

![Chatting with DeepSeek in Cursor](assets/cursor_chat.png)

### Docker Deployment (Alternative)

For containerized deployment, use Docker Compose:

```bash
# Build and start the proxy
docker compose up -d

# View logs
docker compose logs -f

# Check cache statistics inside the container
docker compose exec deepseek-cursor-proxy deepseek-cursor-proxy --reasoning-cache-stats

# Stop the proxy
docker compose down
```

The Docker setup uses persistent volumes for the configuration and reasoning cache,
so your cached reasoning survives container restarts.

Customize with a `.env` file:

```bash
# Create .env file with your settings
cat > .env << EOF
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
PROXY_VERBOSE=true
MISSING_REASONING_STRATEGY=reject
EOF

# Start with custom .env
docker compose up -d
```

The container runs as a non-root user (`appuser`) on port 9000 and includes a
healthcheck on `/v1/healthz`. ngrok is disabled by default since the container
mode targets local-API scenarios (e.g., RooCode).

## How It Works

DeepSeek's [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls) requires `reasoning_content` from assistant messages in tool-call sequences to be passed back in later requests. Some AI editors may omit this field, causing DeepSeek to return a 400 error. This proxy sits between the editor and DeepSeek and repairs requests when it has the exact original reasoning cached.

- Core fix: every DeepSeek response, streaming or non-streaming, has its `reasoning_content` stored in a local SQLite cache keyed by message signature, tool-call ID, and tool-call function signature. On outgoing thinking-mode requests, the proxy restores missing `reasoning_content` for tool-call-related assistant messages and sends the complete history to DeepSeek. If the cache is cold, such as after a proxy restart, it returns a local error instead of fabricating reasoning.
- Multi-conversation isolation: cache keys are scoped by a SHA-256 hash of the canonical conversation prefix (roles, content, tool calls, excluding `reasoning_content`) plus the upstream model/configuration and an API-key hash. Concurrent or interleaved threads with different histories get different scopes, so reused tool-call IDs do not collide. Byte-identical cloned histories are indistinguishable unless the client sends a differentiating history.
- DeepSeek [prefix caching](https://api-docs.deepseek.com/guides/kv_cache) compatibility: the proxy does not inject synthetic thread IDs, timestamps, or cache-control messages into the prompt. When it restores cached reasoning, it restores the exact original string, preserving repeated prefixes for DeepSeek's automatic best-effort context cache.
- Additional compatibility fixes: the proxy converts legacy `functions`/`function_call` fields to `tools`/`tool_choice`, preserves required and named tool-choice semantics, normalizes `reasoning_effort` aliases per DeepSeek docs, strips mirrored `<think>` blocks from assistant content, converts multi-part content arrays to plain text, logs DeepSeek prompt-cache usage when available, and mirrors `reasoning_content` into client-visible `<think>...</think>` blocks for thinking display.

## Debugging

Normal logs avoid request/response bodies but still print compact request and usage statistics. `rounds` is the number of user turns in the forwarded history, `reasoning` is the number and character size of `reasoning_content` fields sent to DeepSeek, and `cache=hit/miss` comes from DeepSeek's `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.

Run with verbose output:

```bash
deepseek-cursor-proxy --verbose
```

Run without ngrok for local curl testing:

```bash
PROXY_NGROK=false deepseek-cursor-proxy --port 9000 --verbose
```

If the editor shows `missing_reasoning_content`, the current chat contains thinking-mode tool-call history whose original DeepSeek `reasoning_content` is not in the local cache. This commonly happens when continuing an older chat after a proxy restart, cache clear, or cache format/config change. The local 409 response includes a diagnostic placeholder so the cause is visible, but that placeholder is not forwarded to DeepSeek in the default safe mode. Start a new chat, or retry from the original tool-call turn while the proxy is running so it can capture the reasoning.

For debugging an old history, you can opt into a non-compliant compatibility fallback:

```bash
deepseek-cursor-proxy --verbose --missing-reasoning-strategy placeholder
```

This inserts a loud placeholder into missing `reasoning_content` fields and forwards the request. It may still be rejected by DeepSeek and should not be used for normal work.

Use another config file:

```bash
deepseek-cursor-proxy --config ./dev.config.yaml
```

Clear the local reasoning cache:

```bash
deepseek-cursor-proxy --clear-reasoning-cache
```

### Reasoning Cache Diagnostics

When troubleshooting the `missing_reasoning_content` (409) error, the proxy provides
several tools to inspect the reasoning cache:

**CLI — Print cache statistics and exit:**

```bash
deepseek-cursor-proxy --reasoning-cache-stats
```

Example output:
```
Reasoning cache location: /home/user/.deepseek-cursor-proxy/reasoning_content.sqlite3
  Total rows: 42
  Oldest entry: 3600.0s ago
  Newest entry: 10.0s ago
  Total keys data size: 12345 bytes
  Database file size: 81920 bytes
  Max rows: 10000
  Max age: 604800s
```

**HTTP — Query cache stats at runtime:**

```bash
curl http://127.0.0.1:9000/v1/reasoning-cache
```

Example response:
```json
{
  "ok": true,
  "cache": {
    "total_rows": 42,
    "oldest_age_seconds": 3600.0,
    "newest_age_seconds": 10.0,
    "db_file_size_bytes": 81920,
    "max_rows": 10000,
    "max_age_seconds": 604800
  },
  "diagnostic": {
    "cache_location": "/home/user/.deepseek-cursor-proxy/reasoning_content.sqlite3",
    "rows": 42,
    "max_rows": "10000",
    "max_age": "604800h"
  }
}
```

**Startup logging** — The proxy logs cache utilization on every start:
```
reasoning cache: 42 rows oldest=3600s newest=10s dbfile=80.0KB util=0%/10000 max_age=604800h
```

**Improved 409 error response** — The `missing_reasoning_content` error now includes
a `cache_diagnostic` field with location and row count:
```json
{
  "error": {
    "message": "... Cache has 0 row(s) at :memory:. Use `deepseek-cursor-proxy --reasoning-cache-stats` for details.",
    "cache_diagnostic": {
      "cache_location": ":memory:",
      "rows": 0,
      "max_rows": "10000",
      "max_age": "604800h"
    }
  }
}
```

Run tests:

```bash
PYTHONPATH=src python -m unittest discover -s tests
```
