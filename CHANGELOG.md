# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **`--reasoning-cache-stats` CLI flag** — Prints detailed reasoning cache statistics
  (row count, oldest/newest entry age, database file size, utilization) and exits.
  Useful for diagnosing cache-related issues like the 409 `missing_reasoning_content` error.

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

- **`GET /v1/reasoning-cache` (and `/reasoning-cache`) HTTP endpoint** — Returns JSON
  with cache statistics and diagnostic information at runtime. Useful for monitoring
  and integration with external tools.

  ```bash
  curl http://127.0.0.1:9000/v1/reasoning-cache | jq
  ```

  Example response:
  ```json
  {
    "ok": true,
    "cache": {
      "total_rows": 42,
      "oldest_age_seconds": 3600.0,
      "newest_age_seconds": 10.0,
      "total_keys_size_bytes": 12345,
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

- **Improved 409 error response** — The `missing_reasoning_content` error now includes
  a `cache_diagnostic` field with cache location, row count, and limits. The error
  message also suggests using `--reasoning-cache-stats` for details.

- **Cache statistics logging on startup** — The proxy now logs reasoning cache
  utilization at startup (row count, age range, file size, capacity usage).

- **SQLite WAL mode** — Enabled `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000`
  for better concurrent read/write performance and fewer `SQLITE_BUSY` errors under load.

- **Created_at index** — Added database index on `created_at` column for more efficient
  cache pruning queries.

### Tests

- Added `test_stats_on_empty_store` — verifies `stats()` and `diagnostic_info()` on
  an empty store (returns zero rows, None ages, zero data size).
- Added `test_stats_on_populated_store` — verifies `stats()` and `diagnostic_info()`
  report correct row count, non-null ages, and respect `max_rows`/`max_age_seconds`.
- Added `test_stats_on_file_store_includes_file_size` — verifies that file-backed
  stores include `db_file_size_bytes` in stats.
- Added `test_build_arg_parser_accepts_reasoning_cache_stats` — verifies the
  `--reasoning-cache-stats` CLI argument is accepted.
- Added `test_build_arg_parser_accepts_config_path_and_cache_stats` — verifies
  `--config` and `--reasoning-cache-stats` work together.
- Added `test_reasoning_cache_endpoint_returns_stats` — verifies the
  `GET /v1/reasoning-cache` endpoint returns the expected JSON structure.
- Added `test_reasoning_cache_endpoint_on_root_path` — verifies the
  `GET /reasoning-cache` (without /v1 prefix) also works.
- Added `test_reasoning_cache_endpoint_includes_stored_data` — verifies the
  endpoint reflects data written to the store.
