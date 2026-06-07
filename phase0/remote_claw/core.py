"""Relay state: sessions and the event bus between worker and clients.

One `Session` holds the authoritative event log for a Remote Control session:
  • downstream — events the relay pushes to the worker (SSE): user input from our
    clients, the `initialize` control_request, permission control_responses.
  • upstream — events the worker posts back (assistant/result/...), fanned out to
    every connected client.

Thread-safe; multiple worker SSE streams (reconnects) and multiple client streams
can wait on the same session concurrently.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_uuid() -> str:
    return str(uuid.uuid4())


@dataclass
class Event:
    event_id: str
    sequence_num: int
    event_type: str
    source: str  # "client" (downstream) | "worker" (upstream)
    payload: dict[str, Any]
    created_at: str = field(default_factory=now_iso)

    def wire(self) -> dict[str, Any]:
        """Shape sent to the worker over SSE (matches the real protocol)."""
        return {
            "event_id": self.event_id,
            "sequence_num": str(self.sequence_num),
            "event_type": self.event_type,
            "source": self.source,
            "payload": self.payload,
            "created_at": self.created_at,
        }


class Session:
    """Authoritative state + event bus for one Remote Control session."""

    def __init__(self, sid: str, title: str, config: dict[str, Any] | None):
        self.id = sid
        self.title = title
        self.config = config or {}
        self.created_at = now_iso()
        self.worker_epoch = 1
        self.worker_status = "WORKER_STATUS_UNSPECIFIED"
        self.closed = False

        self._cv = threading.Condition()
        self._downstream: list[Event] = []
        self._upstream: list[Event] = []
        self._ds_seq = 0
        self._us_seq = 0
        self.initialized = False
        #: event_ids the worker has acknowledged (so reconnects don't re-deliver).
        self.acked: set[str] = set()

    # ---- producers ----
    def push_downstream(self, event_type: str, payload: dict[str, Any]) -> Event:
        with self._cv:
            self._ds_seq += 1
            eid = new_uuid()
            payload.setdefault("uuid", eid)
            ev = Event(eid, self._ds_seq, event_type, "client", payload)
            self._downstream.append(ev)
            self._cv.notify_all()
            return ev

    def push_user_input(self, content: str) -> Event:
        return self.push_downstream(
            "user",
            {
                "type": "user",
                "message": {"role": "user", "content": content},
                "session_id": self.id,
                "timestamp": now_iso(),
                "parent_tool_use_id": None,
            },
        )

    def push_initialize(self) -> Event | None:
        with self._cv:
            if self.initialized:
                return None
            self.initialized = True
        return self.push_downstream(
            "control_request",
            {
                "type": "control_request",
                "request": {"subtype": "initialize"},
                "request_id": new_uuid(),
            },
        )

    def push_control_response(self, request_id: str, behavior: str = "allow") -> Event:
        return self.push_downstream(
            "control_response",
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": {"behavior": behavior},
                },
            },
        )

    def push_upstream(self, payload: dict[str, Any]) -> Event:
        with self._cv:
            self._us_seq += 1
            ev = Event(
                payload.get("uuid") or new_uuid(),
                self._us_seq,
                payload.get("type", "unknown"),
                "worker",
                payload,
            )
            self._upstream.append(ev)
            self._cv.notify_all()
            return ev

    def ack(self, event_id: str) -> None:
        with self._cv:
            self.acked.add(event_id)

    def close(self) -> None:
        with self._cv:
            self.closed = True
            self._cv.notify_all()

    # ---- consumers (generators that block until new events) ----
    def follow_downstream(self, stop: Callable[[], bool]):
        """Yield downstream events for the worker, skipping already-acked ones.

        Resumable across reconnects: a fresh follower replays only un-acked events.
        """
        sent: set[str] = set()
        while not stop() and not self.closed:
            with self._cv:
                pending = [
                    e for e in self._downstream if e.event_id not in sent and e.event_id not in self.acked
                ]
                if not pending:
                    self._cv.wait(timeout=10.0)
                    pending = [
                        e for e in self._downstream if e.event_id not in sent and e.event_id not in self.acked
                    ]
            for e in pending:
                sent.add(e.event_id)
                yield e
            if not pending:
                yield None  # heartbeat tick

    def follow_upstream(self, stop: Callable[[], bool]):
        """Yield upstream events for a client (live; multi-client safe)."""
        idx = 0
        while not stop() and not self.closed:
            with self._cv:
                if idx >= len(self._upstream):
                    self._cv.wait(timeout=10.0)
                pending = self._upstream[idx:]
                idx = len(self._upstream)
            if pending:
                yield from pending
            else:
                yield None

    def snapshot_upstream(self) -> list[Event]:
        with self._cv:
            return list(self._upstream)

    def session_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "status": "active",
            "environment_kind": "bridge",
            "environment_id": "",
            "worker_status": self.worker_status,
            "connection_status": "connected",
            "created_at": self.created_at,
            "updated_at": now_iso(),
            "last_event_at": now_iso(),
            "participants": [],
            "client_presence": [],
            "tags": ["remote-control-repl"],
            "security_tier": "standard",
            "unread": False,
            "config": self.config,
        }


class RelayCore:
    """Registry of sessions."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, body: dict[str, Any]) -> Session:
        sid = "cse_" + uuid.uuid4().hex[:22]
        s = Session(sid, body.get("title", "remote-claw"), body.get("config"))
        with self._lock:
            self._sessions[sid] = s
        return s

    def get(self, sid: str) -> Session | None:
        with self._lock:
            return self._sessions.get(sid)

    def list(self) -> list[Session]:
        with self._lock:
            return list(self._sessions.values())

    def close_all(self) -> None:
        for s in self.list():
            s.close()
