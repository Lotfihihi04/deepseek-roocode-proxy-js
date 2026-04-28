<h1><img src="assets/logo.png" width="90" alt="deepseek-roocode-proxy logo" style="vertical-align: middle;"> deepseek-roocode-proxy</h1>

Compatibility proxy connecting RooCode and compatible editors to DeepSeek thinking models (`deepseek-v4-pro` and `deepseek-v4-flash`). Built with **Node.js**.

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

## Requirements

- **Node.js >= 18**
- npm (comes with Node.js)

## Usage

### Step 1: Install and Start the Proxy Server

```bash
# Clone the repo
git clone https://github.com/Lotfihihi04/deepseek-roocode-proxy-js.git
cd deepseek-roocode-proxy-js

# Install dependencies
npm install

# Start the proxy
npm start
```

Or run directly:

```bash
node src/js/server.js
```

On start, the proxy prints the local URL (`http://localhost:9000`) and, if ngrok is enabled, the ngrok public URL.

On the first run, the proxy will create:

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
docker compose exec deepseek-cursor-proxy node src/js/server.js --reasoning-cache-stats

# Stop the proxy
docker compose down
```

The Docker setup uses persistent volumes for the configuration and reasoning cache,
so your cached reasoning survives container restarts.

Customize with a `.env` file:

```bash
cat > .env << EOF
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
PROXY_VERBOSE=true
MISSING_REASONING_STRATEGY=reject
EOF

docker compose up -d
```

The container runs as a non-root user (`appuser`) on port 9000 and includes a
healthcheck on `/v1/healthz`. ngrok is disabled by default since the container
mode targets local-API scenarios (e.g., RooCode).

## How It Works

DeepSeek's [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls) requires `reasoning_content` from assistant messages in tool-call sequences to be passed back in later requests. Some AI editors may omit this field, causing DeepSeek to return a 400 error. This proxy sits between the editor and DeepSeek and repairs requests when it has the exact original reasoning cached.

- **Core fix**: every DeepSeek response, streaming or non-streaming, has its `reasoning_content` stored in a local SQLite cache keyed by message signature, tool-call ID, and tool-call function signature. On outgoing thinking-mode requests, the proxy restores missing `reasoning_content` for tool-call-related assistant messages. If the cache is cold (e.g. after a proxy restart), it returns a local 409 error instead of fabricating reasoning.
- **Multi-conversation isolation**: cache keys are scoped by a SHA-256 hash of the canonical conversation prefix plus the upstream model/configuration and an API-key hash. Concurrent threads with different histories get different scopes.
- **DeepSeek prefix caching** compatibility: the proxy restores the exact original reasoning string, preserving repeated prefixes for DeepSeek's automatic context cache.
- **Additional fixes**: legacy `functions`/`function_call` → `tools`/`tool_choice` conversion, `reasoning_effort` alias normalization, `<think>` block stripping from assistant content, multi-part content array flattening, and `reasoning_content` mirroring into `<think>...</think>` blocks.

## Debugging

Run with verbose output:

```bash
node src/js/server.js --verbose
```

Run without ngrok for local curl testing:

```bash
PROXY_NGROK=false node src/js/server.js --port 9000 --verbose
```

If the editor shows `missing_reasoning_content` (409), the current chat has tool-call turns whose `reasoning_content` is not in the local cache. Start a new chat, or retry from the original tool-call turn while the proxy is running.

For debugging an old history, opt into a non-compliant compatibility fallback:

```bash
node src/js/server.js --verbose --missing-reasoning-strategy placeholder
```

Use another config file:

```bash
node src/js/server.js --config ./dev.config.yaml
```

Clear the local reasoning cache:

```bash
node src/js/server.js --clear-reasoning-cache
```

### Reasoning Cache Diagnostics

**CLI — Print cache statistics and exit:**

```bash
node src/js/server.js --reasoning-cache-stats
```

Example output:
```
Reasoning cache location: /home/user/.deepseek-cursor-proxy/reasoning_content.sqlite3
  Total rows: 42
  Oldest entry: 3600s ago
  Newest entry: 10s ago
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
    "max_age": "168h"
  }
}
```

## Configuration

The proxy reads settings from (in order of precedence):

1. CLI flags (highest priority)
2. Environment variables
3. YAML config file (`~/.deepseek-cursor-proxy/config.yaml` by default)
4. Built-in defaults

Key environment variables:

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Upstream DeepSeek API URL |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Fallback model |
| `PROXY_HOST` | `127.0.0.1` | Bind host |
| `PROXY_PORT` | `9000` | Bind port |
| `PROXY_VERBOSE` | `false` | Enable verbose logging |
| `PROXY_CORS` | `false` | Enable CORS headers |
| `PROXY_NGROK` | `false` | Start ngrok tunnel |
| `PROXY_REQUEST_TIMEOUT` | `300` | Upstream request timeout (seconds) |
| `DEEPSEEK_THINKING` | `enabled` | Thinking mode (`enabled`/`disabled`/`pass-through`) |
| `DEEPSEEK_REASONING_EFFORT` | `high` | Reasoning effort (`high`/`max`) |
| `CURSOR_DISPLAY_REASONING` | `true` | Mirror reasoning into `<think>` content |
| `MISSING_REASONING_STRATEGY` | `reject` | What to do on cache miss (`reject`/`placeholder`) |
| `REASONING_CACHE_MAX_AGE_SECONDS` | `604800` | Cache TTL in seconds (7 days) |
| `REASONING_CACHE_MAX_ROWS` | `10000` | Max rows in the reasoning cache |
| `REASONING_CONTENT_PATH` | `~/.deepseek-cursor-proxy/reasoning_content.sqlite3` | SQLite cache path |
