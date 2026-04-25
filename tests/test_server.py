from __future__ import annotations

from io import BytesIO
import gzip
import json
import unittest
import zlib

from deepseek_cursor_proxy.server import (
    build_arg_parser,
    main,
    read_response_body,
    summarize_chat_payload,
)


class FakeResponse:
    def __init__(self, body: bytes, encoding: str = "") -> None:
        self._body = BytesIO(body)
        self.headers = {"Content-Encoding": encoding} if encoding else {}

    def read(self) -> bytes:
        return self._body.read()


class ServerTests(unittest.TestCase):
    def test_read_response_body_handles_gzip(self) -> None:
        body = gzip.compress(b'{"ok":true}')

        self.assertEqual(read_response_body(FakeResponse(body, "gzip")), b'{"ok":true}')

    def test_read_response_body_handles_deflate(self) -> None:
        body = zlib.compress(b'{"ok":true}')

        self.assertEqual(
            read_response_body(FakeResponse(body, "deflate")), b'{"ok":true}'
        )

    def test_summarize_chat_payload_does_not_include_message_content(self) -> None:
        summary = summarize_chat_payload(
            {
                "model": "deepseek-v4-pro",
                "stream": True,
                "messages": [{"role": "user", "content": "secret prompt"}],
                "tools": [{"type": "function"}],
                "tool_choice": "auto",
            }
        )

        self.assertIn("model='deepseek-v4-pro'", summary)
        self.assertIn("stream=True", summary)
        self.assertIn("messages=1", summary)
        self.assertIn("tools=1", summary)
        self.assertNotIn("secret prompt", summary)

    def test_build_arg_parser_accepts_reasoning_cache_stats(self) -> None:
        parser = build_arg_parser()
        args = parser.parse_args(["--reasoning-cache-stats"])
        self.assertTrue(args.reasoning_cache_stats)
        self.assertFalse(args.clear_reasoning_cache)

    def test_build_arg_parser_accepts_config_path_and_cache_stats(self) -> None:
        parser = build_arg_parser()
        args = parser.parse_args(
            ["--config", "/tmp/test.yaml", "--reasoning-cache-stats"]
        )
        self.assertTrue(args.reasoning_cache_stats)
        self.assertEqual(str(args.config_path), "/tmp/test.yaml")


if __name__ == "__main__":
    unittest.main()
