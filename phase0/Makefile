# remote-claw (phase0) developer tasks
PY ?= python3

.PHONY: help lint fmt test test-integration test-all check clean

help:
	@echo "make lint              ruff (if installed) + byte-compile check"
	@echo "make fmt               ruff format (if installed)"
	@echo "make test              fast unit tests (no claude/network)"
	@echo "make test-integration  e2e + two-surface (needs claude + claude.ai auth)"
	@echo "make check             lint + unit tests"
	@echo "make clean             remove caches / runtime state"

lint:
	@if command -v ruff >/dev/null 2>&1; then ruff check .; \
	else echo "ruff not installed — byte-compile check only"; fi
	@$(PY) -m compileall -q remote_claw tests remote-claw

fmt:
	@if command -v ruff >/dev/null 2>&1; then ruff format .; ruff check --fix .; \
	else echo "ruff not installed; skipping"; fi

test:
	$(PY) -m unittest discover -s tests -p 'test_*.py' -v

test-integration:
	$(PY) tests/e2e.py
	$(PY) tests/two_surface.py

test-all: check test-integration

check: lint test

clean:
	rm -rf .state __pycache__ */__pycache__ tests/__pycache__ remote_claw/__pycache__
	rm -f /tmp/e2e-relay.log /tmp/two-surface-relay.log
