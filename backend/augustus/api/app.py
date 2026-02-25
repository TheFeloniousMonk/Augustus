"""FastAPI application setup."""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import anthropic
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from augustus.api.dependencies import init_services
from augustus.api.routes import (
    agents,
    sessions,
    trajectories,
    proposals,
    flags,
    search,
    usage,
    settings,
    evaluator_prompts,
    annotations,
    orchestrator,
    activity,
    events,
)

from augustus.models.dataclasses import EvaluatorPrompt
from augustus.services.evaluator import (
    DEFAULT_EVALUATOR_PROMPT,
    DEFAULT_EVALUATOR_PROMPT_RATIONALE,
    DEFAULT_EVALUATOR_PROMPT_VERSION,
)
from augustus.services.memory import MemoryService

logger = logging.getLogger(__name__)


def _arm_shutdown_watchdog(deadline: float = 6.0) -> None:
    """Force-exit if the process doesn't terminate within *deadline* seconds.

    On Windows, ``asyncio.run()`` blocks in ``shutdown_default_executor()``
    when ChromaDB / SQLite leave non-daemon threads alive.  This watchdog
    runs regardless of whether the app was launched via ``main.py`` or
    ``uvicorn --reload``.
    """
    def _watchdog():
        threading.Event().wait(deadline)
        logger.warning(
            "Shutdown watchdog: process still alive after %.0fs — forcing exit",
            deadline,
        )
        os._exit(0)

    t = threading.Thread(target=_watchdog, daemon=True, name="shutdown-watchdog")
    t.start()


async def _seed_default_evaluator_prompt(memory: MemoryService) -> None:
    """Insert the default v0.1 evaluator prompt if no prompts exist yet."""
    existing = await memory.list_evaluator_prompts()
    if existing:
        return

    prompt = EvaluatorPrompt(
        version_id=DEFAULT_EVALUATOR_PROMPT_VERSION,
        prompt_text=DEFAULT_EVALUATOR_PROMPT,
        change_rationale=DEFAULT_EVALUATOR_PROMPT_RATIONALE,
        is_active=True,
    )
    await memory.store_evaluator_prompt(prompt)
    logger.info("Seeded default evaluator prompt %s", DEFAULT_EVALUATOR_PROMPT_VERSION)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialize services on startup, orchestrator if needed."""
    import asyncio

    from augustus.api.dependencies import get_container

    container = get_container()
    # Only init if not already done (main.py pre-initializes when running via CLI)
    if container.memory is None:
        container = init_services()
    logger.info("Augustus API services initialized")

    # Seed the default evaluator prompt if none exists
    await _seed_default_evaluator_prompt(container.memory)

    # If no orchestrator exists yet (dev mode — running via uvicorn directly),
    # create and start one so the Resume button actually works.
    orch_task = None
    if container.orchestrator is None:
        from augustus.api.dependencies import create_orchestrator

        create_orchestrator()
        orch_task = asyncio.create_task(container.orchestrator.start())
        logger.info("Orchestrator created and started via lifespan")

    yield

    # Arm the watchdog FIRST — if anything below hangs, we still exit.
    _arm_shutdown_watchdog(deadline=6.0)

    # Shutdown: stop orchestrator if we started it
    if orch_task is not None and container.orchestrator is not None:
        try:
            await container.orchestrator.stop(timeout=3.0)
        except Exception:
            pass
        if not orch_task.done():
            orch_task.cancel()
            try:
                await asyncio.wait_for(orch_task, timeout=1.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

    logger.info("Augustus API shutting down")


app = FastAPI(title="Augustus API", version="0.9.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NoCacheAPIMiddleware:
    """ASGI middleware to prevent browser caching of API responses.

    Uses raw ASGI protocol instead of BaseHTTPMiddleware to avoid
    breaking StreamingResponse (SSE). BaseHTTPMiddleware consumes the
    entire response body before returning, which hangs on infinite
    SSE generators.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return

        async def send_with_no_cache(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_no_cache)


app.add_middleware(NoCacheAPIMiddleware)


from fastapi import Request
from fastapi.responses import JSONResponse


@app.exception_handler(sqlite3.OperationalError)
async def _sqlite_error_handler(request: Request, exc: sqlite3.OperationalError):
    logger.error("SQLite error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Database temporarily unavailable. Please try again."},
    )


@app.exception_handler(anthropic.APIConnectionError)
async def _anthropic_connection_handler(request: Request, exc: anthropic.APIConnectionError):
    logger.error("Claude API unreachable on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Claude API unreachable. Check network connectivity."},
    )


@app.exception_handler(anthropic.AuthenticationError)
async def _anthropic_auth_handler(request: Request, exc: anthropic.AuthenticationError):
    logger.error("Claude API auth error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Invalid API key configured. Update your API key in Settings."},
    )


@app.exception_handler(anthropic.RateLimitError)
async def _anthropic_rate_limit_handler(request: Request, exc: anthropic.RateLimitError):
    logger.warning("Claude API rate limit on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=429,
        content={"detail": "Claude API rate limit reached. Retry after a moment."},
    )


# Global fallback handler — logs full traceback server-side only; returns a
# generic message to the client to avoid leaking implementation details.
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal error occurred. Check server logs for details."},
    )


# Include routers
app.include_router(agents.router)
app.include_router(sessions.router)
app.include_router(trajectories.router)
app.include_router(proposals.router)
app.include_router(flags.router)
app.include_router(search.router)
app.include_router(usage.router)
app.include_router(settings.router)
app.include_router(evaluator_prompts.router)
app.include_router(annotations.router)
app.include_router(orchestrator.router)
app.include_router(activity.router)
app.include_router(events.router)


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.9.0"}


# SPA serving (production — frontend/dist served by FastAPI)
import sys
from fastapi.responses import FileResponse

if getattr(sys, "frozen", False):
    # PyInstaller frozen binary: exe lives at resources/backend/augustus.exe
    # frontend/dist is at resources/frontend/dist/
    frontend_dist = Path(sys.executable).parent.parent / "frontend" / "dist"
else:
    frontend_dist = Path(__file__).parent.parent.parent.parent / "frontend" / "dist"

if frontend_dist.exists():
    # Mount assets directory
    assets_dir = frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the SPA for all non-API routes."""
        # Don't intercept API routes
        if full_path.startswith("api/"):
            return {"error": "Not found"}

        index = frontend_dist / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return {"error": "Frontend not built"}
