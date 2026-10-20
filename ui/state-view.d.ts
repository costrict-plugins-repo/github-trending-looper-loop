export function toneFor(status: string | undefined): string;
export function prettyStatus(status: string | undefined): string;
export function isTerminal(status: string | undefined): boolean;
export function progressPercent(state: { status?: string; iter?: number; maxIter?: number }): number;
