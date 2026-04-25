# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec file for Augustus backend.

Builds the FastAPI + uvicorn + ChromaDB backend into a single-folder distribution.
Run with: python -m PyInstaller augustus.spec --clean --noconfirm
"""

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

block_cipher = None

# ---------------------------------------------------------------------------
# Data files & submodule collection
# ---------------------------------------------------------------------------
chromadb_datas = collect_data_files("chromadb")
chromadb_submodules = collect_submodules("chromadb")

# ChromaDB's default embedding function lazy-imports onnxruntime + tokenizers
# at first upsert.  PyInstaller's static analysis can't see those imports, so
# we collect them explicitly here.  Without this, packaged builds raise:
#   "The onnxruntime python package is not installed.  Please install it with
#    `pip install onnxruntime`" — see issue #5.
onnx_datas = collect_data_files("onnxruntime")
onnx_binaries = collect_dynamic_libs("onnxruntime")
onnx_submodules = collect_submodules("onnxruntime")
tokenizers_datas = collect_data_files("tokenizers")
tokenizers_binaries = collect_dynamic_libs("tokenizers")

# Augustus own data files (schema.sql, etc.)
augustus_datas = [
    ("augustus/db/schema.sql", "augustus/db"),
]
anthropic_submodules = collect_submodules("anthropic")
mcp_submodules = collect_submodules("mcp")

# ---------------------------------------------------------------------------
# Hidden imports
# ---------------------------------------------------------------------------
chromadb_hidden = [
    "chromadb.telemetry.product.posthog",
    "chromadb.api.segment",
    "chromadb.db.impl",
    "chromadb.db.impl.sqlite",
    "chromadb.migrations",
    "chromadb.migrations.embeddings_queue",
    "chromadb.segment.impl.manager",
    "chromadb.segment.impl.manager.local",
    "chromadb.segment.impl.metadata",
    "chromadb.segment.impl.metadata.sqlite",
    "chromadb.segment.impl.vector",
    "chromadb.execution.executor.local",
    "chromadb.quota.simple_quota_enforcer",
    "chromadb.rate_limit.simple_rate_limit",
    "chromadb.utils.embedding_functions",
    "chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2",
    "onnxruntime",
    "onnxruntime.capi._pybind_state",
    "tokenizers",
]

uvicorn_hidden = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

fastapi_hidden = [
    "multipart",
    "email.mime.multipart",
    "email.mime.text",
    "pydantic",
    "pydantic.deprecated.decorator",
    "mcp",
]

hidden_imports = (
    chromadb_hidden
    + uvicorn_hidden
    + fastapi_hidden
    + chromadb_submodules
    + anthropic_submodules
    + mcp_submodules
    + onnx_submodules
)

# ---------------------------------------------------------------------------
# Excludes — trim modules we don't need
# ---------------------------------------------------------------------------
excludes = [
    "matplotlib",
    "scipy",
    "numpy.testing",
    "tkinter",
    "test",
    "unittest",
]

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
a = Analysis(
    ["augustus/main.py"],
    pathex=[],
    binaries=onnx_binaries + tokenizers_binaries,
    datas=chromadb_datas + onnx_datas + tokenizers_datas + augustus_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
    module_collection_mode={"chromadb": "py"},
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="augustus",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="augustus",
)
