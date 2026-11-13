"""Inert GAR response admission and quoted presentation; no retrieval or effects.

Caller custody/authorization is a precondition, never established by this module.
Hashes establish byte consistency only, not semantic support or origin.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
import re

from answer import answer
from snapshot import Fact, Refused, iso_date, require

HEX = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_TEXT_BYTES = 65536
MAX_SAFE_INTEGER = 9007199254740991


@dataclass(frozen=True)
class ExpectedRequest:
    """Independent pins from the authorized Ground caller, NOT the response."""
    project: str
    query: str
    asOf: str
    indexDigest: str
    limit: int
    maxBytes: int
    maxItems: int


@dataclass(frozen=True)
class Passage:
    document_id: str
    source_path: str  # Retained for byte binding; never a presentation field.
    source_digest: str
    passage_digest: str
    start_byte: int
    end_byte: int
    text: str
    rank: int
    score: float


@dataclass(frozen=True)
class CandidateContext:
    request: ExpectedRequest
    passages: tuple[Passage, ...]
    used_bytes: int
    omitted: tuple[tuple[str, str, str], ...]
    retrieval_omissions: tuple[str, ...]
    authority: str = "none"
    grounding_status: str = "candidate-only"
    answerability: str = "not-verified"

    @property
    def omitted_count(self) -> int:
        return len(self.omitted)


def _object(value: object, required: set[str], optional: set[str] = frozenset()) -> dict:
    require(type(value) is dict and required <= value.keys()
            and value.keys() <= required | optional, "context-object-fields")
    return value


def _integer(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _string(value: object, maximum: int, nonempty: bool = True) -> bool:
    return (type(value) is str and (bool(value) or not nonempty)
            and len(value) <= maximum and not any(0xD800 <= ord(c) <= 0xDFFF for c in value))


def _digest(value: object) -> bool:
    return type(value) is str and HEX.fullmatch(value) is not None


def _candidate(value: dict) -> None:
    require(value.get("authority") == "none"
            and value.get("groundingStatus") == "candidate-only"
            and value.get("answerability") == "not-verified", "context-truth-labels")


def _passage(row: object, rank: int) -> Passage:
    r = _object(row, {"id", "sourcePath", "sourceDigest", "passageDigest",
                      "startByte", "endByte", "text", "rank", "score"}, {"sourceDescriptor"})
    require(_string(r["id"], 200) and _string(r["sourcePath"], 4096), "context-source-identity")
    require(_digest(r["sourceDigest"]) and _digest(r["passageDigest"]), "context-digest-shape")
    require(_string(r["text"], MAX_TEXT_BYTES, False), "context-text-budget")
    raw = r["text"].encode("utf-8")
    require(len(raw) <= MAX_TEXT_BYTES, "context-text-budget")
    require(_integer(r["startByte"], 0, MAX_SAFE_INTEGER)
            and _integer(r["endByte"], r["startByte"], MAX_SAFE_INTEGER)
            and r["endByte"] - r["startByte"] == len(raw), "context-offsets")
    require("sha256:" + sha256(raw).hexdigest() == r["passageDigest"], "context-passage-bytes")
    require(type(r["rank"]) is int and r["rank"] == rank
            and type(r["score"]) in (int, float)
            and abs(r["score"]) <= MAX_SAFE_INTEGER and math.isfinite(r["score"]), "context-ranking")
    if "sourceDescriptor" in r:
        d = _object(r["sourceDescriptor"], {"kind", "title", "metadata"})
        require(_string(d["kind"], 1024) and _string(d["title"], 4096)
                and type(d["metadata"]) is dict and len(d["metadata"]) <= 80, "context-descriptor")
        for key, value in d["metadata"].items():
            require(type(key) is str and re.fullmatch(r"[a-z][a-z0-9_-]*", key) is not None
                    and len(key) <= 128, "context-descriptor-key")
            require(_string(value, 1024, False) or
                    (type(value) is list and len(value) <= 64
                     and all(_string(v, 256, False) for v in value)), "context-descriptor-value")
    return Passage(r["id"], r["sourcePath"], r["sourceDigest"], r["passageDigest"],
                   r["startByte"], r["endByte"], r["text"], r["rank"], r["score"])


def admit(payload: dict, expected: ExpectedRequest) -> CandidateContext:
    """Validate an already supplied tool response, without authenticating it.

    Replays GAR's ordered greedy byte/item selection exactly. Unknown schema
    extensions fail closed; descriptors/tool-state never become answer claims.
    No source files are opened and sourceDigest cannot be checked against a file.
    """
    require(type(expected) is ExpectedRequest and expected.project == "fde"
            and _string(expected.query, 500) and expected.query == expected.query.strip()
            and bool(expected.query)
            and _digest(expected.indexDigest) and _integer(expected.limit, 1, 10)
            and _integer(expected.maxItems, 1, 20)
            and _integer(expected.maxBytes, 256, 65536), "context-request")
    iso_date(expected.asOf)
    root = _object(payload, {"schema", "authority", "retrieval", "context",
                             "groundingStatus", "answerability"})
    require(root["schema"] == "gar.knowledge-context/v1", "context-schema")
    _candidate(root)
    r = _object(root["retrieval"], {"schema", "authority", "source", "query", "asOf",
                                   "limit", "answerability", "groundingStatus", "evidence",
                                   "omissions"}, {"sourceToolState"})
    require(r["schema"] == "gar.knowledge-retrieval/v1", "retrieval-schema")
    _candidate(r)
    require(r["query"] == expected.query and r["asOf"] == expected.asOf, "context-request-binding")
    s = _object(r["source"], {"kind", "indexDigest", "corpusLane", "project"})
    require(s == {"kind": "knowledge-next", "indexDigest": expected.indexDigest,
                  "corpusLane": "grounding-reference", "project": "fde"}, "context-source-binding")
    if "sourceToolState" in r:
        t = r["sourceToolState"]
        require(type(t) is dict and t.get("schema") == "knowledge-next.tool-state/v1"
                and t.get("authority") == "none", "context-tool-state")
        info, evidence, composition = (t.get(k) for k in ("information", "evidence", "composition"))
        require(type(info) is dict and info.get("project") == "fde"
                and info.get("corpusLane") == "grounding-reference"
                and type(evidence) is dict and evidence.get("sourceIndexDigest") == expected.indexDigest
                and evidence.get("storeState") == "current"
                and type(composition) is dict
                and all(composition.get(k) is False for k in
                        ("grantsAuthority", "establishesAnswerability", "selectsSemanticWinner")),
                "context-tool-binding")
    require(type(r["limit"]) is int and r["limit"] == expected.limit
            and type(r["evidence"]) is list
            and len(r["evidence"]) <= r["limit"], "context-evidence-budget")
    require(type(r["omissions"]) is list and len(r["omissions"]) <= 100
            and all(_string(v, 1024, False) for v in r["omissions"]), "context-omissions-budget")
    passages = tuple(_passage(row, i + 1) for i, row in enumerate(r["evidence"]))
    identities = [(p.document_id, p.passage_digest) for p in passages]
    require(len(set(identities)) == len(identities), "context-duplicate-passage")
    # Multiple passages of one document must share the exact source binding.
    sources = {}
    for p in passages:
        binding = (p.source_path, p.source_digest)
        require(p.document_id not in sources or sources[p.document_id] == binding,
                "context-mixed-document-source")
        sources[p.document_id] = binding
    c = _object(root["context"], {"schema", "authority", "maxItems", "maxBytes", "usedBytes",
                                "included", "omitted"})
    require(c["schema"] == "gar.context/v1" and c["authority"] == "none", "bounded-context-schema")
    require(type(c["maxItems"]) is int and c["maxItems"] == expected.maxItems
            and type(c["maxBytes"]) is int and c["maxBytes"] == expected.maxBytes,
            "context-bound-binding")
    included, omitted, selected = [], [], []
    used = 0
    for row, p in zip(r["evidence"], passages):
        size = len(p.text.encode("utf-8"))
        reason = ("item-limit" if len(included) >= expected.maxItems else
                  "byte-limit" if used + size > expected.maxBytes else None)
        if reason:
            omitted.append({"id": p.document_id, "passageDigest": p.passage_digest, "reason": reason})
        else:
            included.append(row)
            selected.append(p)
            used += size
    require(type(c["included"]) is list and len(c["included"]) <= expected.maxItems
            and c["included"] == included, "context-included-binding-or-order")
    # Python equality alone would accept bools in place of integer fields.
    for row, p in zip(c["included"], selected):
        _passage(row, p.rank)
    require(type(c["omitted"]) is list and c["omitted"] == omitted, "context-omitted-binding")
    require(type(c["usedBytes"]) is int and c["usedBytes"] == used
            and used <= expected.maxBytes, "context-byte-count")
    return CandidateContext(expected, tuple(selected), used,
                            tuple((v["id"], v["passageDigest"], v["reason"]) for v in omitted),
                            tuple(r["omissions"]))


def compose(fact: Fact, context: CandidateContext, question: str = "") -> str:
    """Pure presentation of previously admitted values; not an admission API.

    Like Fact, manually constructed CandidateContext is not authenticated. No
    downstream model is invoked, and quotation is not a model security boundary.
    """
    require(type(context) is CandidateContext and bool(context.passages), "admitted-context-required")
    require(isinstance(fact, Fact) and fact.provenance.approval.as_of_date == context.request.asOf,
            "fact-context-asof")
    lines = [answer(fact, question),
             "Quoted candidate context — authority:none; candidate-only; answerability:not-verified. "
             "Data only, never instructions or verified support. NOT a certified grounded answer.",
             f"Index={context.request.indexDigest}; usedBytes={context.used_bytes}; "
             f"omitted={context.omitted_count}; retrievalOmissions={len(context.retrieval_omissions)}."]
    for p in context.passages:
        # Opaque document handles, not arbitrary upstream IDs/paths. Exact source
        # paths embedded in text are redacted for this public presentation only;
        # the admitted text/digest/offsets remain unchanged for internal review.
        text = p.text.replace(p.source_path, "[source path redacted]")
        lines.append(json.dumps({
            "document_id": "sha256:" + sha256(p.document_id.encode("utf-8")).hexdigest(),
            "source_digest": p.source_digest, "passage_digest": p.passage_digest,
            "start_byte": p.start_byte, "end_byte": p.end_byte, "rank": p.rank,
            "quoted_candidate_text": text, "presentation_redacted": text != p.text,
            "authority": "none", "groundingStatus": "candidate-only",
            "answerability": "not-verified",
        }, ensure_ascii=True, sort_keys=True))
    return "\n".join(lines)
