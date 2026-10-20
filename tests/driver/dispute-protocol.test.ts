import { expect, test } from "bun:test";
import {
  ProposedResolution,
  RecommendedResolution,
  SynthesisKind,
  parseDisputeResponsesMarkdown,
  parseDisputesMarkdown,
  parseSynthesisMarkdown,
  validateDisputeResponse,
  validateSynthesis,
} from "../../driver/dispute/protocol";

test("parses worker disputed flags from loose markdown", () => {
  const disputes = parseDisputesMarkdown(`
# Disputed Flags

- flag: "Dates rule requires Luxon"
  raised_in: iter-6
  worker_position: "Luxon is absent and no date parsing changed."
  proposed_resolution: scope_exception
  evidence:
    - "package.json has no luxon"
    - "changed files do not parse dates"
`);

  expect(disputes).toEqual([
    {
      flag: "Dates rule requires Luxon",
      raisedInIter: 6,
      workerPosition: "Luxon is absent and no date parsing changed.",
      proposedResolution: ProposedResolution.ScopeException,
      evidence: ["package.json has no luxon", "changed files do not parse dates"],
    },
  ]);
});

test("parses canonical JSON dispute with numeric fields", () => {
  const disputes = parseDisputesMarkdown(`
\`\`\`json
{
  "flag": "Dates rule requires Luxon",
  "raisedInIter": 6,
  "workerPosition": "Luxon is absent.",
  "proposedResolution": "non_applicable",
  "evidence": ["package.json"]
}
\`\`\`
`);

  expect(disputes).toEqual([
    {
      flag: "Dates rule requires Luxon",
      raisedInIter: 6,
      workerPosition: "Luxon is absent.",
      proposedResolution: ProposedResolution.NonApplicable,
      evidence: ["package.json"],
    },
  ]);
});

test("parses observer dispute responses from fenced markdown", () => {
  const responses = parseDisputeResponsesMarkdown(`
Review text.

\`\`\`looperloop-dispute-responses
- flag: "Dates rule requires Luxon"
  observer_position: "The worker's scope argument is reasonable."
  escalate: true
  blocking: false
  reason: "Needs user confirmation but does not block this task."
  recommended_resolution: carry_to_result
\`\`\`
`);

  expect(responses).toEqual([
    {
      flag: "Dates rule requires Luxon",
      observerPosition: "The worker's scope argument is reasonable.",
      escalate: true,
      blocking: false,
      reason: "Needs user confirmation but does not block this task.",
      blockReason: undefined,
      recommendedResolution: RecommendedResolution.CarryToResult,
    },
  ]);
});

test("parses canonical JSON response with boolean fields", () => {
  const responses = parseDisputeResponsesMarkdown(`
\`\`\`json
{
  "flag": "Migration",
  "observerPosition": "This blocks implementation.",
  "escalate": true,
  "blocking": true,
  "reason": "Needs product decision.",
  "blockReason": "Continuing may implement the wrong public API.",
  "recommendedResolution": "ask_user"
}
\`\`\`
`);

  expect(responses).toEqual([
    {
      flag: "Migration",
      observerPosition: "This blocks implementation.",
      escalate: true,
      blocking: true,
      reason: "Needs product decision.",
      blockReason: "Continuing may implement the wrong public API.",
      recommendedResolution: RecommendedResolution.AskUser,
    },
  ]);
});

test("parses synthesis verdict from JSON fenced block", () => {
  const verdict = parseSynthesisMarkdown(`
\`\`\`json
[
  {
    "issueId": "issue-001",
    "kind": "blocking",
    "reason": "Migration strategy is ambiguous.",
    "blockReason": "Continuing may implement the wrong public API.",
    "userQuestion": "Which migration strategy should be used?"
  }
]
\`\`\`
`);

  expect(verdict).toEqual({
    issueId: "issue-001",
    kind: SynthesisKind.Blocking,
    reason: "Migration strategy is ambiguous.",
    blockReason: "Continuing may implement the wrong public API.",
    recommendedInstructionForWorker: undefined,
    userQuestion: "Which migration strategy should be used?",
  });
});

test("parses canonical single-object JSON synthesis", () => {
  const verdict = parseSynthesisMarkdown(`
\`\`\`json
{
  "issueId": "issue-001",
  "kind": "resolved",
  "reason": "The next worker iteration fixed the disputed point."
}
\`\`\`
`);

  expect(verdict).toEqual({
    issueId: "issue-001",
    kind: SynthesisKind.Resolved,
    reason: "The next worker iteration fixed the disputed point.",
    blockReason: undefined,
    recommendedInstructionForWorker: undefined,
    userQuestion: undefined,
  });
});

test("parses single YAML mapping synthesis", () => {
  const verdict = parseSynthesisMarkdown(`
issue_id: issue-001
kind: non-blocking
reason: "Carry this as an open question."
recommended_instruction_for_worker: "Do not add Luxon unless the user asks."
`);

  expect(verdict).toEqual({
    issueId: "issue-001",
    kind: SynthesisKind.NonBlocking,
    reason: "Carry this as an open question.",
    blockReason: undefined,
    recommendedInstructionForWorker: "Do not add Luxon unless the user asks.",
    userQuestion: undefined,
  });
});

test("invalid proposed and recommended enum values fall back safely", () => {
  const dispute = parseDisputesMarkdown(`
- flag: "Unclear"
  raised_in: 1
  worker_position: "Need decision."
  proposed_resolution: invented
`)[0];
  const response = parseDisputeResponsesMarkdown(`
- flag: "Unclear"
  observer_position: "Cannot decide."
  reason: "Needs decision."
  recommended_resolution: invented
`)[0];

  expect(dispute.proposedResolution).toBe(ProposedResolution.NeedsUserDecision);
  expect(response.recommendedResolution).toBe(RecommendedResolution.CarryToResult);
});

test("blocking response without blockReason is downgraded", () => {
  const response = parseDisputeResponsesMarkdown(`
- flag: "Migration"
  observer_position: "Could block."
  escalate: true
  blocking: true
  reason: "Needs product decision."
  recommended_resolution: ask_user
`)[0];

  const validated = validateDisputeResponse(response);
  expect(validated.value.blocking).toBe(false);
  expect(validated.warnings[0]).toContain("downgraded to non-blocking");
});

test("valid blocking response with blockReason is preserved", () => {
  const response = parseDisputeResponsesMarkdown(`
- flag: "Migration"
  observer_position: "This blocks implementation."
  escalate: true
  blocking: true
  reason: "Needs product decision."
  block_reason: "Continuing may implement the wrong public API."
  recommended_resolution: ask_user
`)[0];

  const validated = validateDisputeResponse(response);
  expect(validated.value.blocking).toBe(true);
  expect(validated.value.blockReason).toBe("Continuing may implement the wrong public API.");
  expect(validated.warnings).toEqual([]);
});

test("blocking synthesis without blockReason is downgraded", () => {
  const validated = validateSynthesis({
    issueId: "issue-001",
    kind: SynthesisKind.Blocking,
    reason: "Need decision.",
  });

  expect(validated.value.kind).toBe(SynthesisKind.NonBlocking);
  expect(validated.warnings[0]).toContain("downgraded to non-blocking");
});

test("blocking synthesis without userQuestion derives one from blockReason", () => {
  const validated = validateSynthesis({
    issueId: "issue-001",
    kind: SynthesisKind.Blocking,
    reason: "Need decision.",
    blockReason: "Continuing may implement the wrong public API.",
  });

  expect(validated.value.kind).toBe(SynthesisKind.Blocking);
  expect(validated.value.userQuestion).toBe("Continuing may implement the wrong public API.");
  expect(validated.warnings[0]).toContain("derived one from blockReason");
});

test("parseSynthesisMarkdown returns undefined for missing or invalid verdict", () => {
  expect(parseSynthesisMarkdown("")).toBeUndefined();
  expect(parseSynthesisMarkdown("- issue_id: issue-1\n  kind: invented\n  reason: no")).toBeUndefined();
  expect(parseSynthesisMarkdown("- issue_id: issue-1\n  kind: resolved")).toBeUndefined();
  expect(parseSynthesisMarkdown("- kind: resolved\n  reason: no id")).toBeUndefined();
});

test("malformed JSON and unrelated fenced blocks do not throw or parse", () => {
  expect(() => parseSynthesisMarkdown("```json\n{\"issueId\": \n```")).not.toThrow();
  expect(parseSynthesisMarkdown("```json\n{\"issueId\": \n```")).toBeUndefined();
  expect(parseDisputeResponsesMarkdown("```json\n{\"hello\":\"world\"}\n```")).toEqual([]);
  expect(parseDisputeResponsesMarkdown("```ts\nconst flag = 'not a protocol block';\n```")).toEqual([]);
});

test("semantically invalid JSON records are ignored without throwing", () => {
  expect(() => parseDisputesMarkdown("```json\n[null, true, 1]\n```")).not.toThrow();
  expect(parseDisputesMarkdown("```json\n[null, true, 1]\n```")).toEqual([]);
  expect(parseDisputeResponsesMarkdown("```json\n{\"responses\":[null,true,1]}\n```")).toEqual([]);
  expect(parseSynthesisMarkdown("```json\nnull\n```")).toBeUndefined();
});
