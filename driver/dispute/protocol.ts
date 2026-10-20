export enum ProposedResolution {
  ScopeException = "scope_exception",
  NonApplicable = "non_applicable",
  NeedsUserDecision = "needs_user_decision",
  FixInFollowup = "fix_in_followup",
}

export enum RecommendedResolution {
  Resolved = "resolved",
  ContinueWithInstruction = "continue_with_instruction",
  CarryToResult = "carry_to_result",
  AskUser = "ask_user",
}

export enum SynthesisKind {
  Resolved = "resolved",
  NonBlocking = "non-blocking",
  Blocking = "blocking",
}

export type Dispute = {
  flag: string;
  raisedInIter: number;
  workerPosition: string;
  proposedResolution: ProposedResolution;
  evidence: string[];
};

export type DisputeResponse = {
  flag: string;
  observerPosition: string;
  escalate: boolean;
  blocking: boolean;
  reason: string;
  blockReason?: string;
  recommendedResolution: RecommendedResolution;
};

export type SynthesisVerdict = {
  issueId: string;
  kind: SynthesisKind;
  reason: string;
  blockReason?: string;
  recommendedInstructionForWorker?: string;
  userQuestion?: string;
};

export type ValidationResult<T> = {
  value: T;
  warnings: string[];
};

type LooseValue = string | number | boolean | null | undefined | LooseValue[] | { [key: string]: LooseValue };
type LooseRecord = Record<string, LooseValue>;
type FencedBlock = { info: string; body: string };

function cleanScalar(value: LooseValue): string {
  if (Array.isArray(value) || value === undefined || value === null) {
    return "";
  }
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function booleanValue(value: LooseValue): boolean {
  if (Array.isArray(value) || value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return cleanScalar(value).toLowerCase() === "true";
}

function numberValue(value: LooseValue): number {
  if (Array.isArray(value) || value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const match = cleanScalar(value).match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function stringValue(value: LooseValue): string {
  if (Array.isArray(value) || value === undefined || value === null) {
    return "";
  }
  return cleanScalar(value);
}

function stringArrayValue(value: LooseValue): string[] {
  if (Array.isArray(value)) {
    return value.map(cleanScalar).filter(Boolean);
  }
  const scalar = stringValue(value);
  return scalar ? [scalar] : [];
}

function keyValue(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
  if (!match) {
    return undefined;
  }
  return { key: match[1], value: match[2] };
}

function normalizeKey(key: string): string {
  return key.replace(/[-_][a-z]/g, (part) => part[1].toUpperCase());
}

function recordsFromLooseYaml(text: string): LooseRecord[] {
  const records: LooseRecord[] = [];
  let current: LooseRecord | undefined;
  let currentArrayKey: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2);
      const pair = keyValue(rest);
      if (pair) {
        current = {};
        records.push(current);
        currentArrayKey = undefined;
        current[normalizeKey(pair.key)] = cleanScalar(pair.value);
      } else if (current && currentArrayKey) {
        const existing = current[currentArrayKey];
        const list = Array.isArray(existing) ? existing : [];
        list.push(cleanScalar(rest));
        current[currentArrayKey] = list;
      }
      continue;
    }

    const pair = keyValue(line);
    if (!pair) {
      continue;
    }

    if (!current) {
      current = {};
      records.push(current);
    }

    const key = normalizeKey(pair.key);
    if (!pair.value.trim()) {
      current[key] = [];
      currentArrayKey = key;
      continue;
    }

    current[key] = cleanScalar(pair.value);
    currentArrayKey = undefined;
  }

  return records;
}

function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const regex = /```([^\r\n`]*)\s*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(regex)) {
    blocks.push({ info: match[1].trim().toLowerCase(), body: match[2] });
  }
  return blocks;
}

function parseJsonRecords(source: string): LooseRecord[] {
  try {
    const parsed = JSON.parse(source) as
      | LooseRecord
      | LooseRecord[]
      | { disputes?: LooseRecord[]; responses?: LooseRecord[]; verdicts?: LooseRecord[] };
    if (Array.isArray(parsed)) {
      return parsed.filter(isLooseRecord);
    }
    if (!isLooseRecord(parsed)) {
      return [];
    }
    if (Array.isArray(parsed.disputes)) {
      return recordArray(parsed.disputes);
    }
    if (Array.isArray(parsed.responses)) {
      return recordArray(parsed.responses);
    }
    if (Array.isArray(parsed.verdicts)) {
      return recordArray(parsed.verdicts);
    }
    return [parsed];
  } catch {
    return [];
  }
}

function isLooseRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(values: LooseValue[]): LooseRecord[] {
  return values.filter((value): value is LooseRecord => isLooseRecord(value));
}

function parseRecordSource(source: string, jsonOnly = false): LooseRecord[] {
  const trimmed = source.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonRecords(trimmed);
  }
  if (jsonOnly) {
    return [];
  }
  return recordsFromLooseYaml(source);
}

function parseRecords(text: string): LooseRecord[] {
  const blocks = fencedBlocks(text);
  if (!blocks.length) {
    return parseRecordSource(text);
  }

  const protocolBlocks = blocks.filter((block) => block.info.startsWith("looperloop-"));
  const selected = protocolBlocks.length ? protocolBlocks : blocks;
  return selected.flatMap((block) => parseRecordSource(block.body, block.info === "json"));
}

function isProposedResolution(value: string): value is ProposedResolution {
  return Object.values(ProposedResolution).includes(value as ProposedResolution);
}

function isRecommendedResolution(value: string): value is RecommendedResolution {
  return Object.values(RecommendedResolution).includes(value as RecommendedResolution);
}

function isSynthesisKind(value: string): value is SynthesisKind {
  return Object.values(SynthesisKind).includes(value as SynthesisKind);
}

export function parseDisputesMarkdown(text: string): Dispute[] {
  return parseRecords(text)
    .map((record) => {
      const proposedResolution = stringValue(record.proposedResolution);
      const raisedInIter = numberValue(record.raisedInIter ?? record.raisedIn);
      return {
        flag: stringValue(record.flag),
        raisedInIter,
        workerPosition: stringValue(record.workerPosition),
        proposedResolution: isProposedResolution(proposedResolution)
          ? proposedResolution
          : ProposedResolution.NeedsUserDecision,
        evidence: stringArrayValue(record.evidence),
      };
    })
    .filter((dispute) => dispute.flag && dispute.raisedInIter > 0 && dispute.workerPosition);
}

export function parseDisputeResponsesMarkdown(text: string): DisputeResponse[] {
  return parseRecords(text)
    .map((record) => {
      const recommendedResolution = stringValue(record.recommendedResolution);
      return {
        flag: stringValue(record.flag),
        observerPosition: stringValue(record.observerPosition),
        escalate: booleanValue(record.escalate),
        blocking: booleanValue(record.blocking),
        reason: stringValue(record.reason),
        blockReason: stringValue(record.blockReason) || undefined,
        recommendedResolution: isRecommendedResolution(recommendedResolution)
          ? recommendedResolution
          : RecommendedResolution.CarryToResult,
      };
    })
    .filter((response) => response.flag && response.observerPosition && response.reason);
}

export function parseSynthesisMarkdown(text: string): SynthesisVerdict | undefined {
  const record = parseRecords(text)[0];
  if (!record) {
    return undefined;
  }
  const kind = stringValue(record.kind);
  if (!isSynthesisKind(kind)) {
    return undefined;
  }
  const issueId = stringValue(record.issueId);
  const reason = stringValue(record.reason);
  if (!issueId || !reason) {
    return undefined;
  }
  return {
    issueId,
    kind,
    reason,
    blockReason: stringValue(record.blockReason) || undefined,
    recommendedInstructionForWorker: stringValue(record.recommendedInstructionForWorker) || undefined,
    userQuestion: stringValue(record.userQuestion) || undefined,
  };
}

export function validateDisputeResponse(response: DisputeResponse): ValidationResult<DisputeResponse> {
  const warnings: string[] = [];
  if (response.blocking && !response.blockReason?.trim()) {
    warnings.push(`Dispute response for "${response.flag}" set blocking=true without blockReason; downgraded to non-blocking.`);
    return { value: { ...response, blocking: false }, warnings };
  }
  return { value: response, warnings };
}

export function validateSynthesis(verdict: SynthesisVerdict): ValidationResult<SynthesisVerdict> {
  const warnings: string[] = [];
  if (verdict.kind === SynthesisKind.Blocking && !verdict.blockReason?.trim()) {
    warnings.push(`Synthesis verdict for "${verdict.issueId}" was blocking without blockReason; downgraded to non-blocking.`);
    return { value: { ...verdict, kind: SynthesisKind.NonBlocking }, warnings };
  }
  if (verdict.kind === SynthesisKind.Blocking && !verdict.userQuestion?.trim()) {
    warnings.push(`Synthesis verdict for "${verdict.issueId}" was blocking without userQuestion; derived one from blockReason.`);
    return { value: { ...verdict, userQuestion: verdict.blockReason }, warnings };
  }
  return { value: verdict, warnings };
}
