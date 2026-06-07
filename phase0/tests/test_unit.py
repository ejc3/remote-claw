"""Fast unit tests (stdlib unittest; no network / no claude)."""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from remote_claw import http_util, log  # noqa: E402
from remote_claw.client_api import _client_event  # noqa: E402
from remote_claw.core import RelayCore, Session  # noqa: E402


class TestDechunk(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(http_util.dechunk(b"5\r\nhello\r\n0\r\n\r\n"), b"hello")

    def test_multi(self):
        self.assertEqual(http_util.dechunk(b"3\r\nfoo\r\n3\r\nbar\r\n0\r\n\r\n"), b"foobar")

    def test_hex_size(self):
        body = b"a" * 26
        self.assertEqual(http_util.dechunk(b"1a\r\n" + body + b"\r\n0\r\n\r\n"), body)


class TestParse(unittest.TestCase):
    def test_request(self):
        head = b"POST /v1/code/sessions HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n"
        m, p, h = http_util.parse_request(head)
        self.assertEqual((m, p), ("POST", "/v1/code/sessions"))
        self.assertEqual(h["content-length"], "2")

    def test_headers_without(self):
        out = http_util.headers_without("Host: x\r\nAccept-Encoding: gzip\r\nA: b", ("accept-encoding",))
        self.assertNotIn("Accept-Encoding: gzip", out)
        self.assertIn("Host: x", out)


class TestRedaction(unittest.TestCase):
    def test_jwt_and_token(self):
        s = log.redact('worker_jwt":"sk-ant-si-deadbeef" Authorization: Bearer abc123')
        self.assertNotIn("deadbeef", s)
        self.assertNotIn("abc123", s)

    def test_access_token(self):
        self.assertNotIn("SECRETVAL", log.redact('"access_token":"SECRETVAL"'))

    def test_client_token_in_url_and_cookie(self):
        self.assertNotIn("deadbeef", log.redact("client UI: http://h:9100/?token=deadbeef"))
        self.assertNotIn("c0ffee", log.redact("Cookie: rc_token=c0ffee; Path=/"))


class TestMitmHelpers(unittest.TestCase):
    def test_split_authority_ipv4(self):
        from remote_claw.mitm import _split_authority

        self.assertEqual(_split_authority("api.anthropic.com:443"), ("api.anthropic.com", 443))
        self.assertEqual(_split_authority("example.com"), ("example.com", 443))

    def test_split_authority_ipv6(self):
        from remote_claw.mitm import _split_authority

        self.assertEqual(_split_authority("[::1]:8443"), ("::1", 8443))

    def test_connection_tokens(self):
        from remote_claw.mitm import _connection_tokens

        toks = _connection_tokens("Host: x\r\nConnection: keep-alive, X-Foo\r\nX-Foo: 1")
        self.assertIn("x-foo", toks)
        self.assertIn("keep-alive", toks)


class TestCore(unittest.TestCase):
    def test_create_and_get(self):
        c = RelayCore()
        s = c.create({"title": "t"})
        self.assertTrue(s.id.startswith("cse_"))
        self.assertIs(c.get(s.id), s)
        self.assertIsNone(c.get("nope"))

    def test_user_input_event(self):
        s = Session("cse_x", "t", {})
        ev = s.push_user_input("hello")
        self.assertEqual(ev.event_type, "user")
        self.assertEqual(ev.payload["message"]["content"], "hello")
        self.assertEqual(ev.source, "client")

    def test_initialize_once(self):
        s = Session("cse_x", "t", {})
        self.assertIsNotNone(s.push_initialize())
        self.assertIsNone(s.push_initialize())

    def test_upstream_and_snapshot(self):
        s = Session("cse_x", "t", {})
        s.push_upstream({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}})
        snap = s.snapshot_upstream()
        self.assertEqual(len(snap), 1)
        self.assertEqual(_client_event(snap[0])["text"], "hi")

    def test_ack_skips_downstream(self):
        s = Session("cse_x", "t", {})
        e1 = s.push_user_input("a")
        s.ack(e1.event_id)  # already delivered
        s.push_user_input("b")
        gen = s.claim_worker_stream()
        out = []
        for ev in s.follow_downstream(gen, lambda: len(out) >= 1):
            if ev is not None:
                out.append(ev)
                break
        self.assertEqual([e.payload["message"]["content"] for e in out], ["b"])

    def test_supersede_stops_old_follower(self):
        s = Session("cse_x", "t", {})
        g1 = s.claim_worker_stream()
        s.claim_worker_stream()  # supersedes g1
        # old follower must exit immediately (no duplicate delivery)
        self.assertEqual(list(s.follow_downstream(g1, lambda: False)), [])

    def test_close_stops_followers(self):
        s = Session("cse_x", "t", {})
        g = s.claim_worker_stream()
        s.close()
        self.assertEqual(list(s.follow_downstream(g, lambda: False)), [])
        self.assertEqual(list(s.follow_upstream(lambda: False)), [])

    def test_initialize_is_first(self):
        s = Session("cse_x", "t", {})
        s.push_initialize()
        s.push_user_input("hi")
        # initialize must occupy sequence 1 (atomic enqueue under lock)
        first = s._downstream[0]
        self.assertEqual(first.payload["request"]["subtype"], "initialize")
        self.assertEqual(first.sequence_num, 1)


class TestClientEvent(unittest.TestCase):
    def test_control_request_shape(self):
        s = Session("cse_x", "t", {})
        s.push_upstream(
            {
                "type": "control_request",
                "request_id": "r1",
                "request": {"subtype": "can_use_tool", "tool_name": "Bash"},
            }
        )
        ev = _client_event(s.snapshot_upstream()[0])
        self.assertEqual(ev["tool_name"], "Bash")
        self.assertEqual(ev["request_id"], "r1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
