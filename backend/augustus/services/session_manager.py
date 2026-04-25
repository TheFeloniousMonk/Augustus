"""Session Manager -- multi-turn Claude session orchestration.

Manages the complete lifecycle of a multi-turn session with the Anthropic API:
Phase 1 (INIT): Construct prompts and tool schedule from ParsedInstruction.
Phase 2 (TURN LOOP): Execute turns with capability gating and tool processing.
Phase 3 (CLOSE): Store data, run evaluator, trigger handoff protocol.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import anthropic

from augustus.config import Settings
from augustus.exceptions import BudgetExceededError
from augustus.models.dataclasses import (
    ActivityEvent,
    BasinConfig,
    BasinSnapshot,
    CapabilityConfig,
    CoActivationEntry,
    EvaluatorOutput,
    FlagRecord,
    ParsedInstruction,
    SessionRecord,
    TierProposal,
    UsageRecord,
)
from augustus.models.enums import CoActivationCharacter, FlagType, ProposalStatus, ProposalType
from augustus.services.evaluator import EvaluatorService
from augustus.services.handoff_engine import HandoffEngine, HandoffResult
from augustus.services.schema_parser import SchemaParser
from augustus.utils import DEFAULT_CONTINUATION_TASK, enum_val, flatten_transcript, normalize_model, utcnow_iso

logger = logging.getLogger(__name__)

# ── Transmission hygiene ─────────────────────────────────────────────────
# Instruction YAML sections (identity_core, session_task, close_protocol)
# are operational text, not creative artifacts.  Unicode typography serves
# no purpose in them and actively causes problems: Claude models sometimes
# produce mojibake when echoing Unicode punctuation through tool_use JSON.
# These helpers normalise at the capture boundary so corruption never enters
# the session lineage.

# Map of Unicode typography → ASCII equivalents for instruction sections.
_TYPOGRAPHY_MAP: dict[str, str] = {
    "\u2014": "--",   # em-dash  —
    "\u2013": "-",    # en-dash  –
    "\u2018": "'",    # left single curly quote  '
    "\u2019": "'",    # right single curly quote '
    "\u201c": '"',    # left double curly quote  "
    "\u201d": '"',    # right double curly quote "
    "\u2026": "...",  # horizontal ellipsis …
    "\u00a0": " ",    # non-breaking space
}


def _normalize_to_ascii(text: str) -> str:
    """Normalize Unicode typography to ASCII equivalents.

    Applied to instruction YAML sections (identity_core, session_task,
    close_protocol) at the capture boundary — before the body's output is
    stored in the session lineage.  This is transmission hygiene, not
    semantic modification: a double-hyphen serves the same intent as an
    em-dash in operational text.
    """
    for unicode_char, ascii_equiv in _TYPOGRAPHY_MAP.items():
        text = text.replace(unicode_char, ascii_equiv)
    return text


def _repair_mojibake(text: str) -> str:
    """Repair UTF-8 → Latin-1 double-encoding artifacts.

    When Claude generates mojibake (e.g. ``â€"`` instead of ``—``), the
    text contains Latin-1 codepoints that are actually UTF-8 byte values.
    Re-encoding as Latin-1 and decoding as UTF-8 recovers the original
    characters, which are then ASCII-normalised.

    Falls through silently if the text is not mojibake.
    """
    try:
        repaired = text.encode("latin-1").decode("utf-8")
        # If decode succeeded, the text was mojibake — normalise the
        # recovered Unicode characters to ASCII as well.
        return _normalize_to_ascii(repaired)
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


class SessionManager:
    """Execute multi-turn Claude sessions via the Anthropic API.

    Each session follows the three-phase lifecycle defined in the architecture:
    INIT -> TURN LOOP -> CLOSE. Tools are gated by turn number per the
    capability schedule in the YAML framework section.
    """

    def __init__(
        self,
        api_key: str,
        memory: Any,  # MemoryService -- typed as Any to avoid circular import
        evaluator: EvaluatorService | None,
        handoff: HandoffEngine,
        tier_enforcer: Any,  # TierEnforcer -- typed as Any to avoid circular import
        schema_parser: SchemaParser,
        settings: Settings | None = None,
    ) -> None:
        """Initialize SessionManager with injected dependencies.

        Args:
            api_key: Anthropic API key for creating the async client.
            memory: MemoryService instance for all data persistence.
            evaluator: EvaluatorService instance (may be None if disabled).
            handoff: HandoffEngine instance for between-session calculations.
            tier_enforcer: TierEnforcer instance for permission checks.
            schema_parser: SchemaParser instance for YAML validation.
            settings: Application settings for model defaults and budget limits.
        """
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self.memory = memory
        self.evaluator = evaluator
        self.handoff = handoff
        self.tier_enforcer = tier_enforcer
        self.schema_parser = schema_parser
        self.settings = settings

    # ------------------------------------------------------------------
    # Turn directive parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_turn_directives(
        session_task: str, max_turns: int
    ) -> dict[int, str]:
        """Parse session_task text into per-turn directives.

        Looks for patterns like "Turn 1:", "Turn 2:", etc. in the session
        task text and splits content so each turn receives only its own
        directive instead of the entire block.

        If no turn markers are found, returns an empty dict (meaning the
        entire session_task should be delivered on turn 0 as before).

        Returns:
            Mapping from 0-based turn index to that turn's directive text.
            May also include a key -1 for preamble text before the first
            turn marker.
        """
        # Match "Turn N:" at the start of a line (with optional leading whitespace)
        # Supports "Turn 1:", "Turn 1 -", "Turn 1 —", etc.
        pattern = re.compile(
            r"^[ \t]*Turn\s+(\d+)\s*[:—\-]",
            re.MULTILINE | re.IGNORECASE,
        )

        matches = list(pattern.finditer(session_task))
        if not matches:
            return {}

        directives: dict[int, str] = {}

        # Capture preamble (text before first turn marker)
        preamble = session_task[: matches[0].start()].strip()
        if preamble:
            directives[-1] = preamble

        # Split at each turn marker
        for i, match in enumerate(matches):
            turn_num = int(match.group(1))
            # 0-based index (Turn 1 -> index 0, Turn 2 -> index 1, etc.)
            turn_idx = turn_num - 1

            # Content runs from this match start to next match start (or end)
            start = match.start()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(session_task)
            content = session_task[start:end].strip()

            if 0 <= turn_idx < max_turns:
                directives[turn_idx] = content

        return directives

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute_session(
        self,
        instruction: ParsedInstruction,
        agent_config: Any | None = None,
    ) -> SessionRecord:
        """Execute a complete multi-turn session.

        Phases:
            1. INIT -- build prompts, tools, and metadata from the instruction.
            2. TURN LOOP -- iterate through max_turns API calls.
            3. CLOSE -- persist data, evaluate, run handoff.

        Args:
            instruction: Parsed YAML instruction containing framework,
                identity_core, session_task, and close_protocol.
            agent_config: Optional AgentConfig with model/temperature/token
                overrides. When provided, agent-level overrides take
                precedence over application-wide defaults.

        Returns:
            Completed SessionRecord with transcript and metadata.

        Raises:
            BudgetExceededError: If the daily budget is exhausted.
        """
        fw = instruction.framework
        session_id = fw.session_id
        agent_id = fw.agent_id
        max_turns = fw.max_turns

        model = self._resolve_model(agent_config)
        temperature = self._resolve_temperature(agent_config)
        max_tokens = self._resolve_max_tokens(agent_config)

        # Load identity_core from the agent DB — it is no longer stored in the YAML.
        # Also read any emphasis_directive computed by the previous handoff and apply it.
        if not agent_config:
            agent_config = await self.memory.get_agent(agent_id)
        if agent_config and agent_config.identity_core:
            effective_identity_core = agent_config.identity_core.rstrip()
            if agent_config.emphasis_directive:
                effective_identity_core += "\n\n" + agent_config.emphasis_directive
            instruction.identity_core = effective_identity_core
        elif not instruction.identity_core:
            logger.warning(
                "Session %s: no identity_core in agent DB or YAML — using empty system prompt",
                session_id,
            )

        logger.info(
            "Starting session %s for agent %s (%d turns, model=%s)",
            session_id,
            agent_id,
            max_turns,
            model,
        )

        # --- Phase 1: INIT ---
        record = SessionRecord(
            session_id=session_id,
            agent_id=agent_id,
            start_time=utcnow_iso(),
            model=model,
            temperature=temperature,
            status="running",
            yaml_raw=instruction.raw_yaml,
        )

        await self._log_activity(
            event_type="session_start",
            agent_id=agent_id,
            session_id=session_id,
            detail=f"Session started ({max_turns} turns, {model})",
        )
        await self.memory.emit_event(
            "session_start", agent_id,
            {"session_id": session_id, "model": model, "max_turns": max_turns},
        )

        # Snapshot the initial basin state before any handoff mutations.
        # Prefer alpha from basin_definitions (authoritative, brain-modifiable)
        # over the YAML value so that brain overrides are not silently lost.
        initial_basins = [
            BasinConfig(
                name=b.name,
                basin_class=b.basin_class,
                alpha=b.alpha,
                lambda_=b.lambda_,
                eta=b.eta,
                tier=b.tier,
            )
            for b in fw.basin_params
        ]
        try:
            _basin_source = await self.memory.get_agent_basin_source(agent_id)
            if _basin_source == "database":
                _defs = await self.memory.get_basin_definitions(agent_id)
                if _defs:
                    _def_alpha = {bd.name: bd.alpha for bd in _defs}
                    for _b in initial_basins:
                        if _b.name in _def_alpha:
                            _b.alpha = _def_alpha[_b.name]
        except Exception as _e:
            logger.warning(
                "Session %s: could not sync initial_basins from basin_definitions: %s",
                session_id, _e,
            )

        conversation: list[dict] = []
        total_tokens_in = 0
        total_tokens_out = 0
        total_web_searches = 0
        capabilities_used: list[str] = []
        pending_confirmations: list[str] = []
        turns_completed = 0
        agent_written_yaml: dict | None = None  # Captured from write_yaml tool calls

        # Parse turn-specific directives from session_task
        turn_directives = self._parse_turn_directives(
            instruction.session_task, max_turns
        )
        if turn_directives:
            logger.info(
                "Session %s: parsed %d turn directives from session_task",
                session_id,
                len([k for k in turn_directives if k >= 0]),
            )

        # --- Pre-session: fetch most recent brain annotation for session context ---
        # The annotation block is held in a local variable and passed to
        # _format_structural_preamble at render time.  It is NEVER written into
        # instruction.structural_sections — that dict round-trips to disk and must
        # remain clean of ephemeral content.
        annotation_block: str = ""
        try:
            recent_annotations = await self.memory.get_annotations(
                agent_id, limit=1, sort_order="desc"
            )
            if recent_annotations:
                ann = recent_annotations[0]
                date_str = ann.created_at[:10] if ann.created_at else ""
                annotation_block = f"[Brain note — {date_str}]\n{ann.content.strip()}"
        except Exception:
            logger.exception(
                "Failed to fetch recent annotation for session context "
                "(agent %s) — continuing without annotation prepend",
                agent_id,
            )

        try:
            # --- Phase 2: TURN LOOP ---
            for turn in range(max_turns):
                # Budget gate -- check before every API call
                await self._check_budget(agent_id)

                # Build user message for this turn
                user_content = self._build_user_message(
                    turn=turn,
                    max_turns=max_turns,
                    instruction=instruction,
                    pending_confirmations=pending_confirmations,
                    turn_directives=turn_directives,
                    annotation_block=annotation_block if turn == 0 else "",
                )
                pending_confirmations = []

                conversation.append({"role": "user", "content": user_content})

                # Determine which tools are active on this turn
                tools = self._build_tool_definitions(fw.capabilities, turn)

                # Call the Anthropic API with retry/backoff
                response = await self._api_call_with_retry(
                    system=instruction.identity_core,
                    messages=conversation,
                    tools=tools if tools else None,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )

                # Accumulate token usage
                if hasattr(response, "usage") and response.usage is not None:
                    total_tokens_in += response.usage.input_tokens
                    total_tokens_out += response.usage.output_tokens

                    # Track server-side tool usage (web search)
                    server_tool_use = getattr(
                        response.usage, "server_tool_use", None
                    )
                    if server_tool_use is not None:
                        ws_count = getattr(
                            server_tool_use, "web_search_requests", 0
                        )
                        if ws_count:
                            total_web_searches += ws_count

                # Serialize assistant response into conversation format
                assistant_content = self._serialize_response_content(response)
                conversation.append(
                    {"role": "assistant", "content": assistant_content}
                )

                # Process any tool_use blocks in the response
                tool_results, turn_yaml = await self._process_tool_calls(
                    response=response,
                    agent_id=agent_id,
                    session_id=session_id,
                    framework=fw,
                )
                if turn_yaml is not None:
                    agent_written_yaml = turn_yaml  # Last write wins

                # Track server-side tool use (e.g. web_search) in capabilities
                for block in response.content:
                    if getattr(block, "type", None) == "server_tool_use":
                        capabilities_used.append(
                            getattr(block, "name", "server_tool")
                        )

                if tool_results:
                    for result in tool_results:
                        tool_name = result.get("tool_name", "")
                        if tool_name:
                            capabilities_used.append(tool_name)
                        pending_confirmations.append(
                            f"[{tool_name}]: {result.get('summary', 'completed')}"
                        )

                    # Append tool results as a user message so the model
                    # can see the outcomes on the next turn
                    tool_result_content = [
                        {
                            "type": "tool_result",
                            "tool_use_id": r["tool_use_id"],
                            "content": r.get("output", ""),
                        }
                        for r in tool_results
                    ]
                    conversation.append(
                        {"role": "user", "content": tool_result_content}
                    )

                turns_completed = turn + 1
                logger.info(
                    "Turn %d/%d complete for session %s",
                    turns_completed,
                    max_turns,
                    session_id,
                )

            # --- Phase 3: CLOSE ---
            record.end_time = utcnow_iso()
            record.turn_count = max_turns
            record.transcript = conversation
            record.capabilities_used = list(set(capabilities_used))
            record.status = "complete"

            # Extract close report from the final assistant message
            record.close_report = self._extract_close_report(conversation)

            # Persist the session record FIRST — downstream tables
            # (usage, basin_snapshots, evaluator_outputs) have FK refs to it.
            await self.memory.store_session_record(record)

            # Log token usage (FK: usage.session_id → sessions.session_id)
            estimated_cost = self._estimate_cost(
                total_tokens_in, total_tokens_out, model,
                web_search_requests=total_web_searches,
            )
            await self.memory.log_usage(
                UsageRecord(
                    session_id=session_id,
                    agent_id=agent_id,
                    tokens_in=total_tokens_in,
                    tokens_out=total_tokens_out,
                    estimated_cost=estimated_cost,
                    model=model,
                    timestamp=utcnow_iso(),
                )
            )

            # Run close protocol (evaluator + handoff + persistence)
            # (FK: basin_snapshots/evaluator_outputs.session_id → sessions)
            await self._execute_close(
                instruction, record, initial_basins,
                agent_written_yaml=agent_written_yaml,
            )

            await self._log_activity(
                event_type="session_complete",
                agent_id=agent_id,
                session_id=session_id,
                detail=(
                    f"Session completed ({record.turn_count} turns, "
                    f"${estimated_cost:.4f})"
                ),
            )
            await self.memory.emit_event(
                "session_complete", agent_id,
                {"session_id": session_id, "turn_count": record.turn_count},
            )

            logger.info(
                "Session %s completed successfully (%d turns, $%.4f)",
                session_id,
                record.turn_count,
                estimated_cost,
            )
            return record

        except BudgetExceededError:
            logger.warning(
                "Budget exceeded for agent %s during session %s",
                agent_id,
                session_id,
            )
            record.status = "error"
            record.end_time = utcnow_iso()
            record.turn_count = turns_completed
            record.transcript = conversation
            record.error_message = "Session halted: budget exceeded"
            await self.memory.store_session_record(record)

            # Still log partial usage so costs are tracked
            if total_tokens_in > 0 or total_tokens_out > 0:
                estimated_cost = self._estimate_cost(
                    total_tokens_in, total_tokens_out, model,
                    web_search_requests=total_web_searches,
                )
                await self.memory.log_usage(
                    UsageRecord(
                        session_id=session_id,
                        agent_id=agent_id,
                        tokens_in=total_tokens_in,
                        tokens_out=total_tokens_out,
                        estimated_cost=estimated_cost,
                        model=model,
                        timestamp=utcnow_iso(),
                    )
                )

            await self._log_activity(
                event_type="session_error",
                agent_id=agent_id,
                session_id=session_id,
                detail="Session halted: budget exceeded",
            )
            raise

        except Exception as e:
            logger.error(
                "Session error for %s: %s", session_id, e, exc_info=True
            )
            record.status = "error"
            record.end_time = utcnow_iso()
            record.turn_count = turns_completed
            record.transcript = conversation
            record.error_message = str(e)
            await self.memory.store_session_record(record)

            # Still log partial usage so costs are tracked
            if total_tokens_in > 0 or total_tokens_out > 0:
                estimated_cost = self._estimate_cost(
                    total_tokens_in, total_tokens_out, model,
                    web_search_requests=total_web_searches,
                )
                await self.memory.log_usage(
                    UsageRecord(
                        session_id=session_id,
                        agent_id=agent_id,
                        tokens_in=total_tokens_in,
                        tokens_out=total_tokens_out,
                        estimated_cost=estimated_cost,
                        model=model,
                        timestamp=utcnow_iso(),
                    )
                )

            await self._log_activity(
                event_type="session_error",
                agent_id=agent_id,
                session_id=session_id,
                detail=f"Session error: {e}",
            )
            raise

    # ------------------------------------------------------------------
    # User message construction
    # ------------------------------------------------------------------

    def _build_user_message(
        self,
        turn: int,
        max_turns: int,
        instruction: ParsedInstruction,
        pending_confirmations: list[str],
        turn_directives: dict[int, str] | None = None,
        annotation_block: str = "",
    ) -> str:
        """Build the user message for a given turn.

        When turn_directives are present (parsed from session_task), each
        turn receives only its own directive. When absent, turn 0 gets the
        full session_task (legacy behavior).

        Final turn: close protocol probes (if present).

        Prepends tool confirmations and capability availability notices
        when applicable.

        Args:
            annotation_block: Pre-fetched brain annotation text to inject on turn 0.
                Rendered as session context without being persisted to structural_sections.
        """
        parts: list[str] = []

        # Prepend confirmations from previous tool calls
        if pending_confirmations:
            parts.append("Tool results from previous turn:")
            parts.extend(pending_confirmations)
            parts.append("")

        # Notify about newly available capabilities this turn
        newly_available = self._get_newly_available_capabilities(
            instruction.framework.capabilities, turn
        )
        if newly_available:
            parts.append(f"[Now available: {', '.join(newly_available)}]")

        # Inject structural sections as session context on turn 0
        if turn == 0 and (instruction.structural_sections or annotation_block):
            preamble_text = self._format_structural_preamble(
                instruction.structural_sections or {}, annotation_block=annotation_block
            )
            if preamble_text:
                parts.append(preamble_text)
                parts.append("")

        has_directives = turn_directives and any(k >= 0 for k in turn_directives)

        if (
            turn == max_turns - 1
            and instruction.close_protocol is not None
        ):
            # Final turn: close protocol (with turn directive if available)
            if has_directives and turn in turn_directives:
                parts.append(turn_directives[turn])
            else:
                parts.append(
                    f"Turn {turn + 1} of {max_turns}. This is your final turn."
                )
            parts.append("")
            parts.append("Please complete the close protocol:")

            for probe in instruction.close_protocol.behavioral_probes:
                parts.append(f"- {probe}")

            parts.append("")
            parts.append("Structural assessment:")
            for item in instruction.close_protocol.structural_assessment:
                parts.append(f"- {item}")

            if instruction.close_protocol.output_format:
                parts.append("")
                parts.append(instruction.close_protocol.output_format)

        elif has_directives:
            # Turn-directive mode: deliver only this turn's content
            if turn == 0:
                # Include preamble on first turn
                preamble = turn_directives.get(-1, "")
                if preamble:
                    parts.append(preamble)
                    parts.append("")

            if turn in turn_directives:
                parts.append(turn_directives[turn])
            else:
                # No specific directive for this turn — generic continuation
                parts.append(f"Turn {turn + 1} of {max_turns}. Continue.")

        elif turn == 0:
            # Legacy mode: deliver full session_task on turn 0
            parts.append(instruction.session_task)

        else:
            # Legacy mode: generic continuation
            parts.append(f"Turn {turn + 1} of {max_turns}. Continue.")

        return "\n".join(parts)

    @staticmethod
    def _get_newly_available_capabilities(
        capabilities: dict[str, CapabilityConfig],
        turn: int,
    ) -> list[str]:
        """Return capability names that become available on this exact turn.

        Only reports capabilities that gate on turn > 0 (turn-0 capabilities
        are always available from the start and need no announcement).
        """
        newly = []
        for name, cap in capabilities.items():
            if cap.enabled and cap.available_from_turn == turn and turn > 0:
                newly.append(name)
        return newly

    @staticmethod
    def _format_structural_preamble(
        sections: dict[str, Any],
        annotation_block: str = "",
    ) -> str:
        """Format structural sections as readable context for the turn 0 message.

        Converts ``relational_grounding`` and ``session_protocol`` dicts
        (preserved by the schema parser) into human-readable text blocks
        that Claude can consume as session context.

        Args:
            sections: Orchestrator-owned structural sections from the YAML.
            annotation_block: Most recent brain annotation, fetched at session
                start and rendered at the top of the session protocol block.
                This is ephemeral — it is never stored in ``sections``.

        Returns empty string if no content to inject.
        """
        blocks: list[str] = []

        # Relational grounding — brain-to-body message
        rg = sections.get("relational_grounding")
        if rg:
            lines: list[str] = ["[Relational grounding]"]
            if isinstance(rg, dict):
                if "content" in rg:
                    # Direct content field — use as-is
                    lines.append(str(rg["content"]).strip())
                else:
                    # Key-value pairs with human-readable labels
                    for key, value in rg.items():
                        label = key.replace("_", " ").capitalize()
                        lines.append(f"{label}: {value}")
            elif isinstance(rg, str):
                lines.append(rg.strip())
            if len(lines) > 1:
                blocks.append("\n".join(lines))

        # Session protocol — structural directives with optional brain annotation prepended
        sp = sections.get("session_protocol")
        sp_lines: list[str] = ["[Session protocol]"]

        # Brain annotation — rendered first, verbatim, never persisted
        if annotation_block:
            sp_lines.append(annotation_block.strip())

        if sp:
            if isinstance(sp, dict):
                for key, value in sp.items():
                    if key == "_brain_notes":
                        # Legacy: strip any stale _brain_notes that survived from old YAML
                        continue
                    elif isinstance(value, dict):
                        label = key.replace("_", " ").capitalize()
                        sp_lines.append(f"{label}:")
                        for sub_key, sub_val in value.items():
                            sub_label = sub_key.replace("_", " ").capitalize()
                            sp_lines.append(f"  {sub_label}: {sub_val}")
                    elif isinstance(value, list):
                        label = key.replace("_", " ").capitalize()
                        sp_lines.append(f"{label}:")
                        for item in value:
                            sp_lines.append(f"  - {item}")
                    else:
                        label = key.replace("_", " ").capitalize()
                        sp_lines.append(f"{label}: {value}")
            elif isinstance(sp, str):
                sp_lines.append(sp.strip())

        if len(sp_lines) > 1:
            blocks.append("\n".join(sp_lines))

        return "\n\n".join(blocks)

    # ------------------------------------------------------------------
    # Tool definitions
    # ------------------------------------------------------------------

    def _build_tool_definitions(
        self,
        capabilities: dict[str, CapabilityConfig],
        turn: int,
    ) -> list[dict]:
        """Build Anthropic tool schemas for capabilities active on this turn.

        Tool definitions are keyed by capability name in the YAML.
        A tool is included only when its capability is enabled and the
        current turn >= available_from_turn.
        """
        tools: list[dict] = []

        # Static tool definition registry
        tool_defs: dict[str, list[dict]] = {
            "file_write": [
                {
                    "name": "write_yaml",
                    "description": (
                        "Write a YAML instruction file to the agent's queue "
                        "for future sessions. You can provide the sections "
                        "as structured fields (RECOMMENDED) or as a raw YAML "
                        "string in 'content'. When using structured fields, "
                        "pass each section as a plain text string — the tool "
                        "handles YAML serialization and escaping for you. "
                        "The framework section is added by the orchestrator "
                        "and should NOT be included."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "filename": {
                                "type": "string",
                                "description": "Name for the YAML file",
                            },
                            "content": {
                                "type": "string",
                                "description": (
                                    "Raw YAML string (legacy). If provided "
                                    "alongside structured fields, the "
                                    "structured fields take precedence."
                                ),
                            },
                            "identity_core": {
                                "type": "string",
                                "description": (
                                    "Identity core text (plain text, no YAML "
                                    "escaping needed). Can contain any "
                                    "characters including quotes, colons, "
                                    "dashes, etc."
                                ),
                            },
                            "session_task": {
                                "type": "string",
                                "description": (
                                    "Session task text (plain text, no YAML "
                                    "escaping needed)."
                                ),
                            },
                            "close_protocol": {
                                "type": "string",
                                "description": (
                                    "Close protocol text (plain text, no "
                                    "YAML escaping needed)."
                                ),
                            },
                            "basin_proposals": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {
                                            "type": "string",
                                            "description": "Basin name",
                                        },
                                        "action": {
                                            "type": "string",
                                            "enum": ["create", "modify", "merge", "prune"],
                                            "description": "Proposed action",
                                        },
                                        "rationale": {
                                            "type": "string",
                                            "description": "Why this change is proposed",
                                        },
                                        "basin_class": {
                                            "type": "string",
                                            "enum": ["core", "peripheral"],
                                            "description": "Basin class (for create/modify)",
                                        },
                                        "suggested_alpha": {
                                            "type": "number",
                                            "description": "Suggested initial alpha value",
                                        },
                                        "eta": {
                                            "type": "number",
                                            "description": "Learning rate (for modify)",
                                        },
                                    },
                                    "required": ["name", "action", "rationale"],
                                },
                                "description": (
                                    "Basin modification proposals (subject "
                                    "to tier enforcement). Use this to "
                                    "propose new basins, modifications, "
                                    "merges, or pruning."
                                ),
                            },
                        },
                        "required": ["filename"],
                    },
                },
            ],
            "memory_query": [
                {
                    "name": "query_memory",
                    "description": (
                        "Search your own session history and trajectory data."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query",
                            },
                            "n_results": {
                                "type": "integer",
                                "description": "Maximum number of results",
                                "default": 5,
                            },
                        },
                        "required": ["query"],
                    },
                },
                {
                    "name": "get_own_trajectory",
                    "description": (
                        "View your own basin alpha trajectory over recent sessions."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "basin_name": {
                                "type": "string",
                                "description": (
                                    "Basin name (optional; omit for all basins)"
                                ),
                            },
                            "n_sessions": {
                                "type": "integer",
                                "description": "Number of recent sessions",
                                "default": 10,
                            },
                        },
                    },
                },
                {
                    "name": "get_observations",
                    "description": (
                        "Retrieve observations and annotations left by the "
                        "observer or by your own previous sessions. Returns "
                        "the most recent entries, optionally filtered by a "
                        "search query. Includes both your stored emergence "
                        "observations and external annotations."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": (
                                    "Optional search query to filter observations"
                                ),
                            },
                            "n_results": {
                                "type": "integer",
                                "description": "Maximum results to return (max 2)",
                                "default": 2,
                                "maximum": 2,
                            },
                        },
                    },
                },
            ],
            "memory_write": [
                {
                    "name": "store_emergence",
                    "description": (
                        "Store an emergent observation for future reference."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Observation text",
                            },
                            "related_basins": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Related basin names",
                            },
                        },
                        "required": ["content"],
                    },
                },
            ],
        }

        for cap_key, cap_tools in tool_defs.items():
            if cap_key in capabilities:
                cap = capabilities[cap_key]
                if cap.enabled and turn >= cap.available_from_turn:
                    tools.extend(cap_tools)

        # Server-side tools (handled by Anthropic API, not dispatched locally)
        if "web_search" in capabilities:
            cap = capabilities["web_search"]
            if cap.enabled and turn >= cap.available_from_turn:
                tools.append({
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": 5,
                })

        return tools

    # ------------------------------------------------------------------
    # Tool call processing
    # ------------------------------------------------------------------

    async def _process_tool_calls(
        self,
        response: Any,
        agent_id: str,
        session_id: str,
        framework: Any,
    ) -> tuple[list[dict], dict | None]:
        """Handle tool_use blocks in an API response.

        Each tool call is dispatched to a handler method. Results are
        returned in a list matching the order of tool_use blocks.

        Returns:
            (results_list, agent_yaml_sections_or_None). The second element
            is non-None when the agent successfully called ``write_yaml``
            during this turn. If multiple calls succeed, the last one wins.
        """
        results: list[dict] = []
        agent_yaml_sections: dict | None = None

        for block in response.content:
            if block.type != "tool_use":
                continue

            tool_name = block.name
            tool_input = block.input
            tool_id = block.id

            try:
                output, summary, yaml_sections = await self._dispatch_tool(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    agent_id=agent_id,
                    session_id=session_id,
                )
                if yaml_sections is not None:
                    agent_yaml_sections = yaml_sections
            except Exception as e:
                logger.error("Tool call error (%s): %s", tool_name, e)
                output = f"Error: {e}"
                summary = f"Error in {tool_name}"

            results.append(
                {
                    "tool_use_id": tool_id,
                    "tool_name": tool_name,
                    "output": output,
                    "summary": summary,
                }
            )

        return results, agent_yaml_sections

    async def _dispatch_tool(
        self,
        tool_name: str,
        tool_input: dict,
        agent_id: str,
        session_id: str,
    ) -> tuple[str, str, dict | None]:
        """Dispatch a single tool call and return (output, summary, agent_yaml).

        The third element is non-None only for ``write_yaml`` calls that
        succeed validation — it contains the parsed agent sections dict.
        All memory tools inject agent_id to enforce namespace isolation.
        """
        if tool_name == "write_yaml":
            return await self._tool_write_yaml(tool_input, session_id)

        if tool_name == "query_memory":
            out, summary = await self._tool_query_memory(tool_input, agent_id)
            return out, summary, None

        if tool_name == "get_own_trajectory":
            out, summary = await self._tool_get_trajectory(tool_input, agent_id)
            return out, summary, None

        if tool_name == "get_observations":
            out, summary = await self._tool_get_observations(tool_input, agent_id)
            return out, summary, None

        if tool_name == "store_emergence":
            out, summary = await self._tool_store_emergence(
                tool_input, agent_id, session_id
            )
            return out, summary, None

        return f"Unknown tool: {tool_name}", f"Unknown tool: {tool_name}", None

    async def _tool_write_yaml(
        self, tool_input: dict, session_id: str
    ) -> tuple[str, str, dict | None]:
        """Handle write_yaml tool call -- validate YAML and capture agent sections.

        The agent's YAML is NOT written directly to the queue here because it
        lacks a framework section (basins, co-activation, etc.) which must be
        injected by the handoff engine after session close.  Instead, the
        validated agent sections are returned as the third tuple element so
        ``execute_session`` can thread them through to ``_write_next_session_yaml``.

        Supports two input modes:

        1. **Structured (recommended):** The agent passes ``identity_core``,
           ``session_task``, and/or ``close_protocol`` as plain-text fields.
           The tool serialises them into valid YAML automatically, avoiding
           any escaping issues.

        2. **Raw (legacy):** The agent passes a single ``content`` string
           that is already formatted as YAML. Validated with ``yaml.safe_load``.

        If structured fields are present, they take precedence over ``content``.

        Returns:
            (output_text, summary, parsed_agent_sections_or_None)
        """
        import yaml as _yaml

        filename = tool_input.get("filename", f"session-{session_id}")

        # Check for structured input (preferred path)
        # Normalise at the capture boundary: repair any mojibake first,
        # then flatten Unicode typography to ASCII so the corruption
        # never enters the session lineage.
        structured_sections: dict[str, str] = {}
        for key in ("identity_core", "session_task", "close_protocol"):
            val = tool_input.get(key)
            if val is not None and str(val).strip():
                clean = _repair_mojibake(str(val))
                structured_sections[key] = _normalize_to_ascii(clean)

        try:
            if structured_sections:
                # Structured mode — build YAML safely via yaml.dump
                content = _yaml.dump(
                    structured_sections,
                    default_flow_style=False,
                    allow_unicode=True,
                    width=120,
                    sort_keys=False,
                )
            else:
                # Legacy raw-content mode
                content = tool_input.get("content", "")

            # Validate the result
            data = _yaml.safe_load(content)
            if not isinstance(data, dict):
                raise ValueError("Content must be a YAML mapping")

            allowed_keys = {"identity_core", "session_task", "close_protocol"}
            if not allowed_keys & set(data.keys()):
                raise ValueError(
                    f"YAML must contain at least one of: {', '.join(sorted(allowed_keys))}"
                )

            # Extract only agent-writable sections (ignore any framework etc.)
            # Apply mojibake repair + ASCII normalisation to catch the legacy
            # raw-content path (structured path was already cleaned above).
            parsed_sections = {
                k: _normalize_to_ascii(_repair_mojibake(str(v)))
                for k, v in data.items()
                if k in allowed_keys and v is not None
            }

            # Capture basin proposals from tool_input (not from YAML content)
            basin_proposals = tool_input.get("basin_proposals")
            if basin_proposals and isinstance(basin_proposals, list):
                parsed_sections["basin_proposals"] = basin_proposals

            output = f"YAML validated and queued as {filename}"
            if basin_proposals:
                output += f" ({len(basin_proposals)} basin proposal(s) recorded)"
            summary = f"Queued YAML: {filename}"
            return output, summary, parsed_sections

        except Exception as e:
            output = f"YAML validation failed: {e}"
            summary = f"YAML rejected: {e}"
            return output, summary, None

    async def _tool_query_memory(
        self, tool_input: dict, agent_id: str
    ) -> tuple[str, str]:
        """Handle query_memory tool call -- semantic search over sessions."""
        query = tool_input.get("query", "")
        n = tool_input.get("n_results", 5)

        search_results = await self.memory.search_sessions(
            agent_id, query, n
        )

        if search_results:
            output = json.dumps(
                [
                    {
                        "session_id": r.session_id,
                        "snippet": r.snippet,
                        "score": r.relevance_score,
                    }
                    for r in search_results
                ],
                indent=2,
            )
        else:
            output = "No results found."

        summary = f"Searched: '{query}' ({len(search_results)} results)"
        return output, summary

    async def _tool_get_trajectory(
        self, tool_input: dict, agent_id: str
    ) -> tuple[str, str]:
        """Handle get_own_trajectory tool call -- basin alpha history."""
        basin_name = tool_input.get("basin_name")
        n = tool_input.get("n_sessions", 10)

        if basin_name:
            trajectory = await self.memory.get_basin_trajectory(
                agent_id, basin_name, n
            )
            output = json.dumps(
                [
                    {
                        "session": s.session_id,
                        "alpha_start": s.alpha_start,
                        "alpha_end": s.alpha_end,
                        "delta": s.delta,
                    }
                    for s in trajectory
                ],
                indent=2,
            )
        else:
            trajectories = await self.memory.get_all_trajectories(agent_id, n)
            output = json.dumps(
                {
                    name: [
                        {"alpha_end": s.alpha_end, "delta": s.delta}
                        for s in snaps
                    ]
                    for name, snaps in trajectories.items()
                },
                indent=2,
            )

        summary = f"Trajectory for {basin_name or 'all basins'}"
        return output, summary

    async def _tool_get_observations(
        self, tool_input: dict, agent_id: str
    ) -> tuple[str, str]:
        """Handle get_observations tool call -- retrieve observer annotations and emergence data."""
        query = tool_input.get("query") or None
        n = min(tool_input.get("n_results", 2), 2)

        results = await self.memory.search_observations(agent_id, query, n)

        if results:
            items = []
            for r in results:
                item: dict[str, Any] = {
                    "content_type": r.content_type,
                    "session_id": r.session_id,
                    "score": r.relevance_score,
                    "timestamp": r.timestamp,
                }
                # Annotations include full_content so the body can read
                # the complete observer note without a separate tool call.
                if r.full_content is not None:
                    item["content"] = r.full_content
                else:
                    item["snippet"] = r.snippet
                items.append(item)
            output = json.dumps(items, indent=2)
        else:
            output = "No observations found."

        summary = f"Observations: {len(results)} results"
        if query:
            summary = f"Observations for '{query}': {len(results)} results"
        return output, summary

    async def _tool_store_emergence(
        self, tool_input: dict, agent_id: str, session_id: str
    ) -> tuple[str, str]:
        """Handle store_emergence tool call -- persist an emergent observation."""
        content = tool_input.get("content", "")
        basins = tool_input.get("related_basins", [])

        await self.memory.store_emergence(
            agent_id, content, basins, session_id
        )

        summary_text = content[:50] + "..." if len(content) > 50 else content
        return "Observation stored.", f"Stored emergence: {summary_text}"

    # ------------------------------------------------------------------
    # API call with retry
    # ------------------------------------------------------------------

    async def _api_call_with_retry(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None,
        model: str,
        temperature: float,
        max_tokens: int,
        max_retries: int = 3,
    ) -> Any:
        """Call the Anthropic messages API with exponential backoff on retries.

        Retries on rate-limit (429) and server errors (5xx).
        """
        for attempt in range(max_retries):
            try:
                kwargs: dict[str, Any] = {
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": system,
                    "messages": messages,
                    "temperature": temperature,
                }
                if tools:
                    kwargs["tools"] = tools
                    # Enable the server-side web search beta when the web_search
                    # tool is active. Without this header the API returns only
                    # the server_tool_use block (the search request) with no
                    # web_search_tool_result, and the next turn's API call fails
                    # with a 400 because the assistant message has an unmatched
                    # server_tool_use.
                    if any(
                        t.get("type") == "web_search_20250305" for t in tools
                    ):
                        kwargs.setdefault("extra_headers", {})["anthropic-beta"] = "web-search-2025-03-05"

                return await self.client.messages.create(**kwargs)

            except anthropic.RateLimitError:
                if attempt < max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "Rate limited (attempt %d/%d), waiting %ds...",
                        attempt + 1,
                        max_retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                else:
                    raise

            except anthropic.APIStatusError as e:
                if e.status_code >= 500 and attempt < max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    logger.warning(
                        "API error %d (attempt %d/%d), retrying in %ds...",
                        e.status_code,
                        attempt + 1,
                        max_retries,
                        wait,
                    )
                    await asyncio.sleep(wait)
                else:
                    raise

    # ------------------------------------------------------------------
    # Response serialization
    # ------------------------------------------------------------------

    @staticmethod
    def _serialize_response_content(response: Any) -> list[dict]:
        """Convert API response content blocks into serializable dicts.

        Handles standard blocks (text, tool_use) and server-side tool
        blocks (server_tool_use, web_search_tool_result) produced by
        Anthropic's native web search capability.
        """
        assistant_content: list[dict] = []
        for block in response.content:
            if block.type == "text":
                assistant_content.append(
                    {"type": "text", "text": block.text}
                )
            elif block.type == "tool_use":
                assistant_content.append(
                    {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                )
            elif block.type == "server_tool_use":
                assistant_content.append(
                    {
                        "type": "server_tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": getattr(block, "input", {}),
                    }
                )
            elif block.type == "web_search_tool_result":
                # block.content contains Anthropic SDK Pydantic objects
                # (WebSearchResultBlock) that are not JSON-serializable.
                # Convert them to plain dicts for transcript storage.
                raw_content = getattr(block, "content", [])
                if isinstance(raw_content, list):
                    serialized = []
                    for item in raw_content:
                        if hasattr(item, "model_dump"):
                            serialized.append(item.model_dump())
                        elif hasattr(item, "dict"):
                            serialized.append(item.dict())
                        elif isinstance(item, dict):
                            serialized.append(item)
                        else:
                            serialized.append({"type": "unknown", "text": str(item)})
                    content = serialized
                elif isinstance(raw_content, dict):
                    content = raw_content
                else:
                    content = str(raw_content)
                assistant_content.append(
                    {
                        "type": "web_search_tool_result",
                        "tool_use_id": getattr(block, "tool_use_id", ""),
                        "content": content,
                    }
                )
            else:
                # Forward-compat: capture unknown block types so transcripts
                # are never silently truncated
                logger.debug(
                    "Unknown response content block type: %s", block.type
                )
                assistant_content.append({"type": block.type})
        return assistant_content

    # ------------------------------------------------------------------
    # Close protocol
    # ------------------------------------------------------------------

    async def _execute_close(
        self,
        instruction: ParsedInstruction,
        record: SessionRecord,
        initial_basins: list[BasinConfig],
        agent_written_yaml: dict | None = None,
    ) -> None:
        """Post-session close protocol.

        1. Store transcript in vector DB for semantic search.
        2. Store close report in vector DB.
        3. Run the evaluator service (if enabled).
        4. Create flags from evaluator output.
        5. Process basin proposals (so approved basins enter handoff).
        6. Run the handoff engine to compute new basin alphas.
        7. Persist basin snapshots and updated basins.
        8. Generate next-session YAML (uses agent-written YAML if available).
        """
        agent_id = record.agent_id
        session_id = record.session_id

        # ChromaDB indexing of transcript + close report is already handled
        # by MemoryService.store_session_record() — no need to repeat here.

        # 3. Run evaluator
        evaluator_output: EvaluatorOutput | None = None
        if self.evaluator is not None:
            try:
                # Load active evaluator prompt (if configured)
                active_prompt = await self.memory.get_active_evaluator_prompt()
                prompt_text = active_prompt.prompt_text if active_prompt else None
                prompt_version = active_prompt.version_id if active_prompt else None

                evaluator_output = await self.evaluator.evaluate_session(
                    identity_core=instruction.identity_core,
                    transcript=record.transcript,
                    close_report=(
                        json.dumps(record.close_report)
                        if record.close_report
                        else ""
                    ),
                    basin_params=instruction.framework.basin_params,
                    prompt_text=prompt_text,
                    prompt_version=prompt_version,
                )
                await self.memory.store_evaluator_output(
                    session_id, evaluator_output
                )

                # 4. Create flags from evaluator findings
                await self._create_evaluator_flags(
                    evaluator_output, agent_id, session_id
                )

            except Exception as e:
                logger.error(
                    "Evaluator failed for session %s: %s",
                    session_id,
                    e,
                    exc_info=True,
                )

        # 5. Merge evaluator co-activation data with YAML co-activation log
        co_activation_entries: list[CoActivationEntry] = list(
            instruction.framework.co_activation_log
        ) if instruction.framework.co_activation_log else []

        if evaluator_output and evaluator_output.co_activation_characters:
            co_activation_entries = self._merge_evaluator_co_activation(
                co_activation_entries, evaluator_output.co_activation_characters
            )

        # 5b. Process basin proposals BEFORE handoff so approved basins
        #     get snapshots and participate in emphasis generation.
        if (
            agent_written_yaml
            and "basin_proposals" in agent_written_yaml
            and self.tier_enforcer is not None
        ):
            approved_basins = await self._process_basin_proposals(
                agent_id=agent_id,
                session_id=session_id,
                proposals=agent_written_yaml["basin_proposals"],
                current_basins=initial_basins,
            )
            # Merge approved new basins into initial_basins so the handoff
            # engine creates snapshots and emphasis directives for them.
            if approved_basins:
                existing_names = {b.name for b in initial_basins}
                for basin in approved_basins:
                    if basin.name not in existing_names:
                        initial_basins.append(basin)

        # 6. Run handoff engine
        handoff_result: HandoffResult = self.handoff.execute_handoff(
            basins=initial_basins,
            evaluator_output=evaluator_output,
            self_assessment=record.close_report,
            co_activation_entries=co_activation_entries or None,
        )

        # 6b. Apply per-basin alpha bounds (floor/ceiling from basin_definitions)
        # to the handoff output BEFORE writing snapshots or the next YAML.
        # This ensures the trajectory table and handoff file both respect
        # brain-set bounds, not just basin_current.
        try:
            _bounds_defs = await self.memory.get_basin_definitions(agent_id)
            if _bounds_defs:
                _bounds_map: dict[str, tuple] = {
                    bd.name: (bd.alpha_floor, bd.alpha_ceiling)
                    for bd in _bounds_defs
                }
                _clamped_alpha: dict[str, float] = {}
                for _basin in handoff_result.updated_basins:
                    _floor, _ceil = _bounds_map.get(_basin.name, (None, None))
                    _a = _basin.alpha
                    if _floor is not None and _a < _floor:
                        logger.info(
                            "Basin %s alpha %.4f clamped to floor %.4f (agent %s)",
                            _basin.name, _a, _floor, agent_id,
                        )
                        _a = _floor
                    if _ceil is not None and _a > _ceil:
                        _a = _ceil
                    _basin.alpha = round(_a, 6)
                    _clamped_alpha[_basin.name] = _basin.alpha
                # Sync snapshot alpha_end and delta to match clamped values
                for _snap in handoff_result.basin_snapshots:
                    if _snap.basin_name in _clamped_alpha:
                        _new_end = _clamped_alpha[_snap.basin_name]
                        _snap.delta = round(_new_end - _snap.alpha_start, 6)
                        _snap.alpha_end = _new_end
        except Exception as _e:
            logger.warning(
                "Could not apply per-basin bounds to handoff result for agent %s: %s",
                agent_id, _e,
            )

        # 7. Persist basin snapshots
        for snap in handoff_result.basin_snapshots:
            snap.session_id = session_id

        await self.memory.store_basin_snapshots(
            agent_id, session_id, handoff_result.basin_snapshots
        )

        # Update current basins to reflect post-handoff values
        await self.memory.update_current_basins(
            agent_id, handoff_result.updated_basins
        )

        # Sync updated basins to basin_definitions (v0.9.5)
        try:
            source = await self.memory.get_agent_basin_source(agent_id)
            if source == "database":
                for basin in handoff_result.updated_basins:
                    params = {
                        "alpha": basin.alpha,
                        "lambda": basin.lambda_,
                        "eta": basin.eta,
                        "basin_class": enum_val(basin.basin_class),
                        "tier": basin.tier.value if hasattr(basin.tier, "value") else int(basin.tier),
                    }
                    # Use upsert so basins added post-creation are created if missing
                    await self.memory.upsert_basin_definition(
                        agent_id=agent_id,
                        name=basin.name,
                        params=params,
                        modified_by="body",
                        rationale="Post-handoff update",
                    )
        except Exception as e:
            logger.error(
                "Failed to sync basin_definitions after handoff for "
                "session %s: %s",
                session_id, e, exc_info=True,
            )

        # Update co-activation data if available
        if handoff_result.co_activation_updates:
            await self.memory.update_co_activation(
                agent_id, handoff_result.co_activation_updates
            )

        # 8. Generate and queue next-session YAML (handoff Step 8)
        await self._write_next_session_yaml(
            instruction=instruction,
            agent_id=agent_id,
            updated_basins=handoff_result.updated_basins,
            co_activation_updates=handoff_result.co_activation_updates,
            emphasis_directive=handoff_result.emphasis_directive,
            agent_written_yaml=agent_written_yaml,
        )

        logger.info(
            "Close protocol complete for session %s: %s",
            session_id,
            handoff_result.change_rationale,
        )

    @staticmethod
    def _merge_evaluator_co_activation(
        existing: list[CoActivationEntry],
        evaluator_chars: dict[str, str],
    ) -> list[CoActivationEntry]:
        """Merge evaluator co_activation_characters into the co-activation entry list.

        The evaluator returns characters as {"basin_a|basin_b": "reinforcing", ...}.
        Each observed pair gets count incremented by 1 and character updated.
        """
        # Index existing entries by sorted pair for efficient lookup
        entry_map: dict[tuple[str, str], CoActivationEntry] = {}
        for e in existing:
            key = tuple(sorted(e.pair))
            entry_map[key] = e

        for pair_key, char_str in evaluator_chars.items():
            parts = pair_key.split("|")
            if len(parts) != 2:
                continue
            sorted_pair = tuple(sorted(parts))

            try:
                character = CoActivationCharacter(char_str)
            except ValueError:
                character = CoActivationCharacter.UNCHARACTERIZED

            if sorted_pair in entry_map:
                entry_map[sorted_pair].count += 1
                entry_map[sorted_pair].character = character
            else:
                entry = CoActivationEntry(
                    pair=sorted_pair,
                    count=1,
                    character=character,
                )
                entry_map[sorted_pair] = entry

        return list(entry_map.values())

    async def _create_evaluator_flags(
        self,
        evaluator_output: EvaluatorOutput,
        agent_id: str,
        session_id: str,
    ) -> None:
        """Create FlagRecords from evaluator findings and store them."""
        now = utcnow_iso()

        if evaluator_output.constraint_erosion_flag:
            await self.memory.store_flag(
                FlagRecord(
                    flag_id=str(uuid.uuid4()),
                    agent_id=agent_id,
                    session_id=session_id,
                    flag_type=FlagType.CONSTRAINT_EROSION,
                    severity="warning",
                    detail=(
                        evaluator_output.constraint_erosion_detail
                        or "Constraint erosion detected"
                    ),
                    created_at=now,
                )
            )

        if evaluator_output.assessment_divergence_flag:
            await self.memory.store_flag(
                FlagRecord(
                    flag_id=str(uuid.uuid4()),
                    agent_id=agent_id,
                    session_id=session_id,
                    flag_type=FlagType.ASSESSMENT_DIVERGENCE,
                    severity="info",
                    detail=(
                        evaluator_output.assessment_divergence_detail
                        or "Assessment divergence detected"
                    ),
                    created_at=now,
                )
            )

        # Store emergent observations as flags for visibility
        for observation in evaluator_output.emergent_observations:
            await self.memory.store_flag(
                FlagRecord(
                    flag_id=str(uuid.uuid4()),
                    agent_id=agent_id,
                    session_id=session_id,
                    flag_type=FlagType.EMERGENT_OBSERVATION,
                    severity="info",
                    detail=observation,
                    created_at=now,
                )
            )

    # ------------------------------------------------------------------
    # Basin proposal processing
    # ------------------------------------------------------------------

    async def _process_basin_proposals(
        self,
        agent_id: str,
        session_id: str,
        proposals: list[dict],
        current_basins: list[BasinConfig],
    ) -> list[BasinConfig]:
        """Process agent basin proposals through the tier enforcer.

        Converts raw proposal dicts from the write_yaml tool into
        BasinConfig objects where applicable, then runs them through
        check_yaml_modifications to create TierProposal records.

        Returns a list of BasinConfig objects for proposals that were
        auto-approved or approved, so they can be included in the
        handoff engine's basin list.
        """
        from augustus.models.enums import BasinClass, TierLevel

        proposed_basins = list(current_basins)  # Start with current state
        current_map = {b.name: b for b in current_basins}

        for prop in proposals:
            name = prop.get("name", "")
            action = prop.get("action", "")
            if not name or not action:
                continue

            if action == "create" and name not in current_map:
                basin_class_str = prop.get("basin_class", "peripheral")
                try:
                    basin_class = BasinClass(basin_class_str)
                except ValueError:
                    basin_class = BasinClass.PERIPHERAL

                alpha = prop.get("suggested_alpha", 0.3)
                alpha = max(0.05, min(1.0, alpha))

                proposed_basins.append(
                    BasinConfig(
                        name=name,
                        basin_class=basin_class,
                        alpha=alpha,
                        lambda_=0.95,
                        eta=0.1,
                        tier=TierLevel.TIER_3,
                    )
                )

            elif action == "prune" and name in current_map:
                proposed_basins = [b for b in proposed_basins if b.name != name]

            elif action == "modify" and name in current_map:
                # Structural modifications (class, eta) and/or
                # rationale-only conceptual reinterpretations.
                # Lambda is intentionally excluded — it cannot be modified
                # through the body's write_yaml tool. Use the MCP brain
                # interface to adjust lambda directly.
                for i, b in enumerate(proposed_basins):
                    if b.name == name:
                        new_class = b.basin_class
                        new_lambda = b.lambda_
                        new_eta = b.eta
                        new_tier = b.tier

                        basin_class_str = prop.get("basin_class")
                        if basin_class_str:
                            try:
                                new_class = BasinClass(basin_class_str)
                            except ValueError:
                                pass

                        if "eta" in prop:
                            new_eta = float(prop["eta"])

                        has_structural_change = (
                            new_class != b.basin_class
                            or abs(new_lambda - b.lambda_) > 0.001
                            or abs(new_eta - b.eta) > 0.001
                            or new_tier != b.tier
                        )

                        if has_structural_change:
                            proposed_basins[i] = BasinConfig(
                                name=b.name,
                                basin_class=new_class,
                                alpha=b.alpha,
                                lambda_=new_lambda,
                                eta=new_eta,
                                tier=new_tier,
                            )
                        break

        # Build a map of agent-provided rationales keyed by basin name
        rationale_map = {
            p.get("name", ""): p.get("rationale", "")
            for p in proposals
            if p.get("rationale")
        }

        # Track rationale-only modify proposals that won't produce
        # structural diffs (detect_basin_changes won't see them).
        rationale_only_modifies: list[dict] = []
        for prop in proposals:
            if prop.get("action") == "modify" and prop.get("name") in current_map:
                name = prop["name"]
                curr = current_map[name]
                # Check whether _any_ structural field was actually changed
                proposed_match = next(
                    (b for b in proposed_basins if b.name == name), None
                )
                if proposed_match and (
                    proposed_match.basin_class == curr.basin_class
                    and abs(proposed_match.lambda_ - curr.lambda_) <= 0.001
                    and abs(proposed_match.eta - curr.eta) <= 0.001
                    and proposed_match.tier == curr.tier
                ):
                    rationale_only_modifies.append(prop)

        # Get agent tier settings
        agent = await self.memory.get_agent(agent_id)
        if not agent or not agent.tier_settings:
            logger.warning(
                "Cannot process basin proposals: agent %s not found or no tier settings",
                agent_id,
            )
            return []

        approved_basins: list[BasinConfig] = []

        try:
            result = await self.tier_enforcer.check_yaml_modifications(
                agent_id, proposed_basins, current_basins, agent.tier_settings
            )

            # Store all proposals created by the tier enforcer,
            # enriching with the agent's own rationale when available
            for proposal in result.proposals_created:
                proposal.session_id = session_id
                agent_rationale = rationale_map.get(proposal.basin_name)
                if agent_rationale:
                    proposal.rationale = agent_rationale
                await self.memory.store_tier_proposal(proposal)

                # Auto-approved proposals: apply structural change to agent config
                if proposal.status in (
                    ProposalStatus.AUTO_APPROVED,
                    ProposalStatus.APPROVED,
                ) and proposal.proposed_config:
                    await self.memory.apply_approved_proposal(proposal)
                    approved_basins.append(proposal.proposed_config)

                    # Sync to basin_definitions (v0.9.5)
                    try:
                        source = await self.memory.get_agent_basin_source(agent_id)
                        if source == "database":
                            if proposal.proposal_type == ProposalType.CREATE:
                                await self.memory.insert_basin_definition(
                                    agent_id=agent_id,
                                    name=proposal.proposed_config.name,
                                    basin_class=enum_val(proposal.proposed_config.basin_class),
                                    alpha=proposal.proposed_config.alpha,
                                    lambda_decay=proposal.proposed_config.lambda_,
                                    eta=proposal.proposed_config.eta,
                                    tier=proposal.proposed_config.tier.value if hasattr(proposal.proposed_config.tier, "value") else int(proposal.proposed_config.tier),
                                    created_by="body",
                                    rationale=proposal.rationale,
                                )
                            elif proposal.proposal_type == ProposalType.MODIFY:
                                await self.memory.update_basin_definition(
                                    agent_id=agent_id,
                                    basin_name=proposal.basin_name,
                                    modifications={
                                        "basin_class": enum_val(proposal.proposed_config.basin_class),
                                        "alpha": proposal.proposed_config.alpha,
                                        "lambda": proposal.proposed_config.lambda_,
                                        "eta": proposal.proposed_config.eta,
                                        "tier": proposal.proposed_config.tier.value if hasattr(proposal.proposed_config.tier, "value") else int(proposal.proposed_config.tier),
                                    },
                                    modified_by="body",
                                    rationale=proposal.rationale,
                                    session_id=session_id,
                                )
                            elif proposal.proposal_type == ProposalType.PRUNE:
                                await self.memory.update_basin_definition(
                                    agent_id=agent_id,
                                    basin_name=proposal.basin_name,
                                    modifications={"deprecated": 1, "deprecated_at": utcnow_iso(), "deprecation_rationale": proposal.rationale},
                                    modified_by="body",
                                    rationale=proposal.rationale,
                                    session_id=session_id,
                                )
                    except Exception as e:
                        logger.error(
                            "Failed to sync approved proposal to basin_definitions "
                            "for basin '%s' (agent %s): %s",
                            proposal.basin_name, agent_id, e, exc_info=True,
                        )

            if result.proposals_created:
                logger.info(
                    "Created %d tier proposal(s) for agent %s from session %s",
                    len(result.proposals_created),
                    agent_id,
                    session_id,
                )

            for warning in result.warnings:
                logger.warning("Tier enforcer: %s", warning)

            # Create pending proposals for rationale-only modify requests
            # that didn't produce structural diffs.  These are conceptual
            # reinterpretations the agent wants reviewed.
            for prop in rationale_only_modifies:
                name = prop["name"]
                # Skip if the tier enforcer already created a proposal for
                # this basin (shouldn't happen, but guard against it)
                already_handled = any(
                    p.basin_name == name for p in result.proposals_created
                )
                if already_handled:
                    continue

                curr = current_map[name]
                rationale = prop.get("rationale", f"Modify proposal for '{name}'")
                proposal = TierProposal(
                    proposal_id=f"prop-{agent_id}-{name}-{utcnow_iso()}",
                    agent_id=agent_id,
                    basin_name=name,
                    tier=curr.tier,
                    proposal_type=ProposalType.MODIFY,
                    status=ProposalStatus.PENDING,
                    rationale=rationale,
                    session_id=session_id,
                    created_at=utcnow_iso(),
                    proposed_config=curr,  # No structural change — config is same
                )
                await self.memory.store_tier_proposal(proposal)
                logger.info(
                    "Created rationale-only modify proposal for basin '%s' "
                    "(agent %s, session %s): %s",
                    name, agent_id, session_id, rationale[:80],
                )

        except Exception as e:
            logger.error(
                "Tier enforcer failed for agent %s: %s",
                agent_id,
                e,
                exc_info=True,
            )

        return approved_basins

    # ------------------------------------------------------------------
    # Next-session YAML generation (handoff Step 8)
    # ------------------------------------------------------------------

    async def _write_next_session_yaml(
        self,
        instruction: ParsedInstruction,
        agent_id: str,
        updated_basins: list[BasinConfig],
        co_activation_updates: list | None,
        emphasis_directive: str,
        agent_written_yaml: dict | None = None,
    ) -> None:
        """Generate next-session YAML and write to agent's pending queue.

        If the agent wrote a YAML during the session (via the ``write_yaml``
        tool), its ``session_task`` and ``close_protocol`` take precedence
        over defaults.  ``identity_core`` in any agent-written YAML is
        silently ignored — identity_core is DB-owned and immutable from the
        agent's perspective.

        The handoff engine's ``emphasis_directive`` is persisted to the agent
        DB so the next session can read it from AgentConfig at start time.

        Structural sections (session_protocol, relational_grounding) are
        carried forward from the input instruction — they are orchestrator-
        owned and round-trip without modification.

        The close_protocol is merged with the agent config's base template
        so that behavioral probes and structural assessments survive even
        when the agent writes an incomplete close_protocol.

        When the agent did NOT write a YAML, falls back to
        ``DEFAULT_CONTINUATION_TASK``.
        """
        from augustus.services.yaml_generator import generate_next_session_yaml
        from augustus.services.queue_manager import QueueManager

        try:
            # Get current agent config for close_protocol and capabilities
            agent = await self.memory.get_agent(agent_id)
            if not agent:
                logger.warning(
                    "Cannot generate next YAML: agent %s not found", agent_id
                )
                return

            # Determine session number from completed session count
            session_number = await self.memory.count_sessions(agent_id) + 1

            # Persist the handoff engine's emphasis_directive to the agent DB.
            # The next session will read it from AgentConfig and prepend it to
            # identity_core at session start — it never touches the YAML.
            if emphasis_directive:
                await self.memory.update_agent(
                    agent_id, {"emphasis_directive": emphasis_directive}
                )
                logger.info(
                    "Stored emphasis_directive for agent %s (%d chars)",
                    agent_id,
                    len(emphasis_directive),
                )
            else:
                # Clear any stale emphasis from the previous session
                await self.memory.update_agent(
                    agent_id, {"emphasis_directive": ""}
                )

            # Resolve next-session task and close protocol.
            # identity_core from agent-written YAML is intentionally ignored —
            # it is a DB-owned field. Apply mojibake repair to task text.
            if agent_written_yaml:
                next_task = _normalize_to_ascii(_repair_mojibake(
                    agent_written_yaml.get(
                        "session_task", DEFAULT_CONTINUATION_TASK
                    )
                ))
                next_close_protocol = agent_written_yaml.get(
                    "close_protocol", None
                )
                if isinstance(next_close_protocol, str):
                    next_close_protocol = _normalize_to_ascii(
                        _repair_mojibake(next_close_protocol)
                    )
                written_keys = list(agent_written_yaml.keys())
                if "identity_core" in written_keys:
                    logger.info(
                        "Agent %s wrote identity_core in YAML — ignored (DB-owned field)",
                        agent_id,
                    )
                logger.info(
                    "Using agent-written YAML for next session of %s (sections: %s)",
                    agent_id,
                    written_keys,
                )
            else:
                next_task = DEFAULT_CONTINUATION_TASK
                next_close_protocol = None
                logger.info(
                    "Using default continuation task for next session of %s",
                    agent_id,
                )

            # Carry structural sections forward from the input YAML.
            # These are orchestrator-owned — they round-trip automatically.
            # Strip any stale _brain_notes before round-tripping.
            structural_sections = dict(instruction.structural_sections or {})
            sp = structural_sections.get("session_protocol")
            if isinstance(sp, dict) and "_brain_notes" in sp:
                structural_sections["session_protocol"] = {
                    k: v for k, v in sp.items() if k != "_brain_notes"
                }

            # Also merge in agent-level structural sections as fallback
            if not structural_sections.get("session_protocol") and agent.session_protocol:
                structural_sections["session_protocol"] = agent.session_protocol
            if not structural_sections.get("relational_grounding") and agent.relational_grounding:
                structural_sections["relational_grounding"] = agent.relational_grounding

            # Belt-and-suspenders: re-read basin_current from the DB so
            # that any basins approved during this close protocol (or via
            # other paths) are never silently dropped from the next YAML.
            canonical_basins = await self.memory.get_current_basins(agent_id)
            if canonical_basins:
                handoff_names = {b.name for b in updated_basins}
                for cb in canonical_basins:
                    if cb.name not in handoff_names:
                        updated_basins.append(cb)
                        logger.info(
                            "Recovered basin '%s' from basin_current into "
                            "next-session YAML for agent %s",
                            cb.name,
                            agent_id,
                        )

            yaml_content = generate_next_session_yaml(
                agent_id=agent_id,
                session_number=session_number,
                max_turns=agent.max_turns or instruction.framework.max_turns,
                basins=updated_basins,
                session_task=next_task,
                close_protocol=next_close_protocol,
                base_close_protocol=agent.close_protocol or None,
                capabilities=agent.capabilities,
                co_activation_log=co_activation_updates,
                structural_sections=structural_sections or None,
            )

            # Write to queue via QueueManager
            agent_dir = self._get_agent_dir(agent_id)
            queue = QueueManager(agent_dir, self.schema_parser)
            await queue.write_yaml(yaml_content, f"handoff-s{session_number:03d}.yaml")

            logger.info(
                "Generated next-session YAML for agent %s (session %d)",
                agent_id,
                session_number,
            )

        except Exception as e:
            logger.error(
                "Failed to generate next-session YAML for agent %s: %s",
                agent_id,
                e,
                exc_info=True,
            )

    def _get_agent_dir(self, agent_id: str) -> "Path":
        """Resolve agent directory path."""
        from pathlib import Path

        # Memory service should expose the data directory
        if hasattr(self.memory, 'sqlite') and hasattr(self.memory.sqlite, 'db_path'):
            data_dir = self.memory.sqlite.db_path.parent
            return data_dir / "agents" / agent_id

        # Fallback: use config
        if self.settings and hasattr(self.settings, 'data_directory') and self.settings.data_directory:
            return Path(self.settings.data_directory) / "agents" / agent_id

        # Last resort: default location
        import os
        if os.name == "nt":
            base = Path(os.environ.get("APPDATA", "~")) / "Augustus" / "data"
        else:
            base = Path.home() / "Library" / "Application Support" / "Augustus" / "data"
        return base / "agents" / agent_id

    # ------------------------------------------------------------------
    # Close report extraction
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_close_report(conversation: list[dict]) -> dict | None:
        """Extract close report from the final assistant message.

        Walks the conversation in reverse to find the last assistant turn.
        Returns a dict with 'raw_text' containing the full text content.
        """
        for msg in reversed(conversation):
            if msg.get("role") != "assistant":
                continue

            content = msg.get("content", "")
            if isinstance(content, list):
                text_parts = [
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                content = "\n".join(text_parts)

            if content:
                return {"raw_text": content}

        return None

    # ------------------------------------------------------------------
    # Budget check
    # ------------------------------------------------------------------

    async def _check_budget(self, agent_id: str) -> None:
        """Check daily credit budget before making an API call.

        Raises:
            BudgetExceededError: If spending has hit the hard stop.
        """
        if self.settings is None:
            return

        budget_limit = getattr(self.settings, "budget_hard_stop", 100.0)
        summary = await self.memory.get_usage_summary("day")
        daily_total = summary.get("total_cost", 0.0)

        if daily_total >= budget_limit:
            raise BudgetExceededError(
                f"Daily budget exceeded: ${daily_total:.2f} >= "
                f"${budget_limit:.2f}"
            )

    # ------------------------------------------------------------------
    # Configuration resolution (settings -> agent override -> YAML)
    # ------------------------------------------------------------------

    def _resolve_model(self, agent_config: Any | None = None) -> str:
        """Resolve model: agent override → app settings → hardcoded default.

        Priority chain:
            1. agent_config.model_override (if set and non-empty)
            2. self.settings.default_model (application-wide default)
            3. Hardcoded fallback

        All values are normalized through ``normalize_model`` to resolve
        short names (e.g. 'claude-sonnet-4') to full API model IDs.
        """
        if agent_config and getattr(agent_config, "model_override", None):
            return normalize_model(agent_config.model_override)
        if self.settings and hasattr(self.settings, "default_model"):
            return normalize_model(self.settings.default_model)
        return "claude-opus-4-6"

    def _resolve_temperature(self, agent_config: Any | None = None) -> float:
        """Resolve temperature: agent override → app settings → hardcoded default."""
        if agent_config and getattr(agent_config, "temperature_override", None) is not None:
            return agent_config.temperature_override
        if self.settings and hasattr(self.settings, "default_temperature"):
            return self.settings.default_temperature
        return 1.0

    def _resolve_max_tokens(self, agent_config: Any | None = None) -> int:
        """Resolve max_tokens: agent override → app settings → hardcoded default."""
        if agent_config and getattr(agent_config, "max_tokens_override", None) is not None:
            return agent_config.max_tokens_override
        if self.settings and hasattr(self.settings, "default_max_tokens"):
            return self.settings.default_max_tokens
        return 4096

    # ------------------------------------------------------------------
    # Cost estimation
    # ------------------------------------------------------------------

    @staticmethod
    def _estimate_cost(
        tokens_in: int,
        tokens_out: int,
        model: str,
        web_search_requests: int = 0,
    ) -> float:
        """Estimate API cost based on token counts and model pricing.

        Pricing is approximate and based on published Anthropic rates
        (per 1M tokens: input, output). Web search is $10 per 1000
        requests ($0.01 per request).
        """
        pricing: dict[str, tuple[float, float]] = {
            "claude-sonnet-4-6": (3.0, 15.0),
            "claude-sonnet-4-5-20250929": (3.0, 15.0),
            "claude-opus-4-1-20250805": (15.0, 75.0),
            "claude-opus-4-5-20251101": (5.0, 25.0),
            "claude-opus-4-6": (5.0, 25.0),
            "claude-opus-4-7": (5.0, 25.0),
            "claude-haiku-4-5-20251001": (1.0, 5.0),
        }
        rates = pricing.get(model, (3.0, 15.0))
        cost = (tokens_in * rates[0] / 1_000_000) + (
            tokens_out * rates[1] / 1_000_000
        )
        # Web search: $0.01 per request
        if web_search_requests > 0:
            cost += web_search_requests * 0.01
        return round(cost, 6)

    # ------------------------------------------------------------------
    # Activity logging helper
    # ------------------------------------------------------------------

    async def _log_activity(
        self,
        event_type: str,
        agent_id: str,
        session_id: str,
        detail: str,
    ) -> None:
        """Log an activity event through the memory service."""
        await self.memory.log_activity(
            ActivityEvent(
                event_id=str(uuid.uuid4()),
                event_type=event_type,
                agent_id=agent_id,
                session_id=session_id,
                detail=detail,
                timestamp=utcnow_iso(),
            )
        )
