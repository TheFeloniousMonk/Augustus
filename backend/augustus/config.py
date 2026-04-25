"""Application configuration and settings management."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)


@dataclass
class Settings:
    """Application settings."""
    api_key_encrypted: str = ""
    default_model: str = "claude-opus-4-6"
    default_temperature: float = 1.0
    default_max_tokens: int = 4096
    poll_interval: int = 60
    max_concurrent_agents: int = 3
    budget_warning: float = 50.0
    budget_hard_stop: float = 100.0
    budget_per_session: float = 5.0
    budget_per_day: float = 25.0
    evaluator_enabled: bool = True
    evaluator_model: str = "claude-sonnet-4-6"
    formula_in_identity_core: bool = False
    dashboard_port: int = 8080
    mcp_enabled: bool = True
    auto_update: bool = True
    data_directory: str = ""

    _fernet_key: str = field(default="", repr=False)

    def get_api_key(self) -> str:
        """Decrypt and return the stored API key."""
        if not self.api_key_encrypted or not self._fernet_key:
            return ""
        try:
            f = Fernet(self._fernet_key.encode())
            return f.decrypt(self.api_key_encrypted.encode()).decode()
        except Exception:
            return ""

    def set_api_key(self, key: str) -> None:
        """Encrypt and store an API key."""
        if not self._fernet_key:
            self._fernet_key = Fernet.generate_key().decode()
        f = Fernet(self._fernet_key.encode())
        self.api_key_encrypted = f.encrypt(key.encode()).decode()


class ConfigManager:
    """Manage persistent settings."""

    def __init__(self, config_dir: Path | None = None) -> None:
        """Initialize config manager with optional config directory override."""
        if config_dir is None:
            config_dir = self._default_config_dir()
        self.config_dir = Path(config_dir)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.config_dir / "settings.json"
        self.settings = self._load()

    def _default_config_dir(self) -> Path:
        """Return platform-appropriate config directory."""
        if os.name == "nt":
            return Path(os.environ.get("APPDATA", "~")) / "Augustus"
        return Path.home() / "Library" / "Application Support" / "Augustus"

    def _load(self) -> Settings:
        """Load settings from disk."""
        if self.config_file.exists():
            try:
                data = json.loads(self.config_file.read_text())
                settings = Settings()
                for k, v in data.items():
                    if hasattr(settings, k):
                        setattr(settings, k, v)
                return settings
            except Exception as e:
                logger.warning(f"Failed to load settings: {e}")
        return Settings()

    def save(self) -> None:
        """Save settings to disk."""
        data = {}
        for k, v in asdict(self.settings).items():
            data[k] = v
        self.config_file.write_text(json.dumps(data, indent=2))

    def update(self, updates: dict) -> None:
        """Update settings with a dictionary of changes and persist."""
        for k, v in updates.items():
            if hasattr(self.settings, k):
                setattr(self.settings, k, v)
        self.save()

    def get_data_dir(self) -> Path:
        """Return the data directory, creating it if needed."""
        if self.settings.data_directory:
            p = Path(self.settings.data_directory)
        else:
            p = self.config_dir / "data"
        p.mkdir(parents=True, exist_ok=True)
        return p
