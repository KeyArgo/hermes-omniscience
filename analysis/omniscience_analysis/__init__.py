"""Deterministic anomaly detection over omni.v1 events (ROADMAP phase 3)."""

from .rules import Config, Finding, detect

__all__ = ["Config", "Finding", "detect"]
