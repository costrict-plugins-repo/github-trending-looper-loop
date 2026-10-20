const MAX_SUMMARY_CHARS = 360;

function normalizeSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd()}...`;
}

export function extractLooperloopSummary(markdown: string): string | undefined {
  const block = markdown.match(/```[ \t]*looperloop-summary[^\r\n]*\r?\n([\s\S]*?)\r?\n```/i);
  if (!block?.[1]) {
    return undefined;
  }
  const summary = normalizeSummary(block[1]);
  return summary || undefined;
}
