"""Deterministic review-only presentation. No model, retrieval, or causal inference."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Mapping

from snapshot import Fact

BOUNDARIES = {
    "SCENARIO_ATTAINMENT": "SCENARIO_ATTAINMENT is synthetic scenario-good attainment, not native MES-produced output.",
    "NATIVE_MES_OUTPUT_UNITS": "Native MES-reported output is distinct from synthetic scenario-good quantities; it does not certify physical production.",
    "QC_SAMPLE_PASS": "QC_SAMPLE_PASS is sample pass rate, not production first-pass yield (FPY).",
    "QC_CHECK_COUNT": "QC checks are not finished-product unit acceptance or FPY.",
    "SYNTHETIC_EVENT_RATE": "Synthetic event rates per 100k worker-hours are not OSHA TRIR or regulatory reportability.",
    "SYNTHETIC_EVENT_COUNT": "Synthetic event counts do not establish physical incidents or OSHA reportability.",
    "PM_ON_TIME": "PM not-due means no obligations due through the cutoff, not achieved compliance; future obligations are excluded.",
    "PM_DUE_COUNT": "PM due counts cover obligations through the cutoff, not certified compliance or physical equipment service.",
    "DOWNTIME_MINUTES": "Modelled synthetic downtime is not machine telemetry.",
}


@dataclass(frozen=True)
class KnowledgePassage:
    text: str
    passage_id: str = "unspecified"
    authority: str = "none"
    verification: str = "unverified"

    def __post_init__(self) -> None:
        # Ignore external authority claims rather than propagating them.
        object.__setattr__(self, "authority", "none")
        object.__setattr__(self, "verification", "unverified")
        if (not isinstance(self.text, str) or len(self.text) > 4000
                or not isinstance(self.passage_id, str) or len(self.passage_id) > 200):
            raise ValueError("knowledge-passage-budget")

    @classmethod
    def from_envelope(cls, envelope: Mapping[str, object]) -> KnowledgePassage:
        # No external labels, citations, instructions, or source authority inherited.
        return cls(text=envelope["text"], passage_id=envelope.get("passage_id", "unspecified"))


def answer(fact: Fact, question: str = "", knowledge: KnowledgePassage | None = None) -> str:
    """Format a fact returned by snapshot.select/validate; not an admission API.

    Question is used only to select abstention; never echoed or executed.
    All untrusted passage text is JSON-quoted as candidate context.
    """
    if not isinstance(fact, Fact) or fact.metric_id not in BOUNDARIES:
        raise ValueError("admitted-fact-required")
    if not isinstance(question, str) or len(question) > 4000:
        raise ValueError("question-budget")
    p = fact.provenance
    lines = [
        "REVIEW ONLY — offline synthetic job-demo candidate; authority: none.",
        f"CURRENT MONTH {fact.period}: {fact.metric_id} = "
        f"{fact.value if fact.value is not None else 'null (unavailable)'} {fact.unit}; status={fact.status}.",
        f"Exported numerator={fact.numerator}; denominator={fact.denominator}. No values recomputed.",
        BOUNDARIES[fact.metric_id],
        f"As of {p.approval.as_of_date}; run={p.approval.source_run_id}; source kind={p.source_kind}.",
        f"Source SHA-256={p.approval.source_sha256}; kernel SHA-256={p.approval.kernel_sha256}.",
        f"Manifest SHA-256={p.manifest_sha256}; {p.filename} SHA-256={p.csv_sha256}.",
        "Hashes check local byte integrity, not source authorization, semantic admission, or live plant truth.",
    ]
    if re.search(r"\b(why|root[\s_-]*cause|caus(?:e|es|ed|al|ation)|reason|explain)\b",
                 question, flags=re.IGNORECASE):
        lines.extend([
            "Insufficient evidence for a root cause. No causal claim is supported by this snapshot.",
            "Investigation questions: Which exact source-bound ERP and MES witnesses cover the period? "
            "What independent observations and timing corroborate the discrepancy? "
            "Which alternative explanations and missing records need owner review?",
        ])
    if knowledge is not None:
        if not isinstance(knowledge, KnowledgePassage):
            raise ValueError("knowledge-envelope-required")
        lines.extend([
            "Candidate Knowledge context only — authority:none; unverified; not verified support. "
            "Cannot upgrade source facts or supply a missing ERP/MES witness.",
            json.dumps({"passage_id": knowledge.passage_id, "text": knowledge.text,
                        "authority": "none", "verification": "unverified"},
                       ensure_ascii=True, sort_keys=True),
        ])
    return "\n".join(lines)
