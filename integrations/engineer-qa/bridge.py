"""Read-only pairing of an exported fact and caller-supplied inert GAR bytes.

No retrieval, identity attestation, semantic support assessment or public export.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import answer
import context
import snapshot


@dataclass(frozen=True)
class ReviewResult:
    """Private review material, not a release projection or an admission API.

    Direct construction does not authenticate inputs. Use pair_review. Raw fact
    and context fields remain private-custody data; repr deliberately omits them.
    """
    fact: snapshot.Fact = field(repr=False)
    context: context.CandidateContext = field(repr=False)
    _question: str = field(default="", repr=False)
    boundary: str = field(default="candidate-only", init=False)
    status: str = field(default="unverified", init=False)
    authority: str = field(default="none", init=False)

    def render_review(self) -> str:
        """PRIVATE ONLY: may contain sensitive quoted text; never public-safe.

        This deterministic formatter invokes no model. Quotation is not a
        security boundary for later model use or a sensitive-data scrubber.
        """
        # A retrieved identity with zero/whitespace text is not usable evidence.
        # Preserve admitted bytes in the private context, but abstain instead
        # of presenting an empty passage as meaningful source support.
        if any(p.text.strip() for p in self.context.passages):
            text = context.compose(self.fact, self.context, self._question)
        else:
            text = answer.answer(self.fact, self._question)
            reason = ("no retrieved context" if not self.context.passages
                      else "no usable retrieved context (empty or whitespace only)")
            text += ("\n" + reason + "; not verified; do not claim source support. "
                     "Abstain from answering from retrieved evidence.")
        return ("PRIVATE REVIEW ONLY — candidate-only; unverified; authority: none.\n"
                + text + "\nCausal inference refused: neither this KPI nor quoted candidate "
                "context establishes why or a root cause.")


def pair_review(export_directory: Path, metric_id: str, approval: snapshot.Approval,
                ground_payload: dict, expected: context.ExpectedRequest,
                question: str = "") -> ReviewResult:
    """Fail closed as one pair; pins must come independently from the caller.

    Reads only via snapshot.select; context.admit inspects supplied data only.
    No partial result is returned on either refusal. No question is echoed.
    """
    snapshot.require(type(approval) is snapshot.Approval
                     and type(expected) is context.ExpectedRequest, "review-pin-types")
    # Before filesystem access or passage inspection; never learn pins from data.
    snapshot.require(approval.as_of_date == expected.asOf, "review-asof-mismatch")
    snapshot.iso_date(approval.as_of_date)
    snapshot.require(type(question) is str and len(question) <= 4000
                     and not any(0xD800 <= ord(c) <= 0xDFFF for c in question),
                     "question-budget")
    snapshot.require(isinstance(export_directory, Path)
                     and export_directory.is_absolute()
                     and ".." not in export_directory.parts, "absolute-explicit-path-required")
    snapshot.require(type(metric_id) is str and metric_id in snapshot.METRICS, "unknown-metric")
    snapshot.require(type(ground_payload) is dict, "context-object-fields")
    fact = snapshot.select(export_directory, metric_id, approval)
    admitted = context.admit(ground_payload, expected)
    return ReviewResult(fact, admitted, question)
