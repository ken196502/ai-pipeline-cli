# Fix: VL Evaluation Hallucinated Winner Mapping (False Positive)

## Symptom
```
❌ Xhot pipeline failed [new model]
Error: VL evaluation inconsistent: winner "Anthropic New Model (Claude/Fable)" (#12)
not found in that candidate's text (@theinformation: "Anthropic is preparing a new AI
model that can better infer what users are trying to accomplish...").
Refusing to proceed on a hallucinated mapping.
```

## Investigation

### Artifact evidence
`artifacts/xhot-1792664374221-tgtahx/eval-result.json`:
- `winner.index = 12`, `winner.id = "@theinformation"`
- `winner.name = "Anthropic New Model (Claude/Fable)"`
- `winnerNameMatches = false`
- `winnerCandidateText` = "Anthropic is preparing a new AI model that can better infer
  what users are trying to accomplish, even when their instructions are vague..."
- Raw response is *internally consistent*: reasoning cites tweets #5/#6/#7/#9/#11/#12 and
  names Claude Duet / Fable 5.1 / Fable 5.5 as the cluster. Not a hallucinated mapping.

### Candidate #12 screenshot (candidate-12.png)
Card shows: **"Anthropic is preparing a new AI model that can better infer what users are
trying to accomplish..."** — an unnamed, unreleased Anthropic model. The card contains
**no** string "Claude", no "Fable", and no concrete model name at all.

### Root cause (two compounding defects)

**Defect 1 — validation compares a *cluster/topic label* against a *single tweet text*.**
The prompt (eval.ts step 2) asks the model to identify "核心模型/技术/项目名称" and pick a
**cluster** spanning many tweets. The model legitimately returned a *synthetic aggregate
name* ("Anthropic New Model (Claude/Fable)") synthesized from the cluster's 6 tweets, then
anchored it to the single representative tweet #12. The name is valid cluster-level
semantics but unverifiable in any one tweet. The validator assumes
`winner.name ⊆ winner.tweet.text`, which is only true when the winner is a concrete named
entity present in one tweet.

**Defect 2 — `strippedNameNorm` fallback defeats the segment check for parenthesized names.**
`winner.name = "Anthropic New Model (Claude/Fable)"`.
- `nameSegments` splits on `/|、,，&+` → `["Anthropic New Model (Claude", "Fable)"]` →
  normalized `["anthropicnewmodelclaude", "fable"]`.
- `strippedNameNorm` strips `(...)` → `"anthropicnewmodel"` → not in haystack.
- Neither `anthropicnewmodelclaude` nor `fable` is in tweet #12's text.
- **But** `"anthropic new model"` *is* in the tweet. The bracket-stripping is applied only
  to the whole name and never re-split, so the valid core token is lost.

Net effect: a semantically correct answer is rejected and the whole pipeline aborts.

## Fix design

Make the name check **token-based and tolerant**, rather than requiring one contiguous
normalized substring:

1. Extract candidate name tokens: split on `/|、,，&+`, parentheses/brackets, parentheses
   content, and whitespace; drop stop-words/connectives (`new`, `model`, `ai`, `the`,
   `rumor`, `project`, `update`, `unreleased`).
2. Match if **all** content tokens appear in the haystack (order-independent, allows
   interleaved words) — e.g. `anthropic` + `fable` both present.
3. Match if **any** single content token of length ≥ 3 is present (strong signal; handles
   "Fable" alone).
4. When the name has **no** content tokens after filtering (fully generic label), treat the
   check as **not applicable** rather than failing.
5. Keep strictness where it matters: `winner.index` must still map to a real candidate, and
   the concrete-entity case (e.g. `DeepSeek-V3`) still fails loudly if absent.

Additionally:
- Cross-check the winner name against the **whole cluster**, not just one tweet, by also
  accepting a match in the candidate's `authorName`/`authorHandle` and in any
  `topCandidates[].reasoning` token that references the winner index.
- Log a structured warning (not fatal) when the name matches only at cluster level.

## Steps
1. Implement token-tolerant matching in `src/modules/evaluation/eval.ts`.
2. Add unit tests covering: parenthesized cluster name, bracket name, segmented name,
   genuinely hallucinated name (must still fail), generic-label name (not applicable),
   out-of-range index (must still fail).
3. Run `npm test` and typecheck.
4. Re-run pipeline for `new model`.

## Non-goals
- Do not weaken the anti-hallucination guarantee for concrete named entities.
- Do not silently accept an unmappable `winner.index`.