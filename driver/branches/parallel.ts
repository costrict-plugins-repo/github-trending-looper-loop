export enum BranchNodeStatus {
  Completed = "completed",
  Failed = "failed",
}

export type BranchParallelNodeSpec = {
  id: string;
};

export type BranchParallelNodeResult<TSpec extends BranchParallelNodeSpec> = {
  node: TSpec;
  status: BranchNodeStatus;
  text: string;
};

export type RunParallelBranchInput<TSpec extends BranchParallelNodeSpec> = {
  nodes: TSpec[];
  runNode: (node: TSpec) => Promise<{ ok: boolean; text: string }>;
  onNodeCompleted?: (node: TSpec, text: string) => Promise<void>;
  onNodeFailed?: (node: TSpec, text: string) => Promise<void>;
};

export type ParallelBranchResult<TSpec extends BranchParallelNodeSpec> = {
  results: Array<BranchParallelNodeResult<TSpec>>;
  successful: Array<BranchParallelNodeResult<TSpec>>;
  failed: Array<BranchParallelNodeResult<TSpec>>;
  allFailed: boolean;
};

async function runOneNode<TSpec extends BranchParallelNodeSpec>(
  input: RunParallelBranchInput<TSpec>,
  node: TSpec,
): Promise<BranchParallelNodeResult<TSpec>> {
  const result = await input.runNode(node);
  if (result.ok) {
    await input.onNodeCompleted?.(node, result.text);
    return { node, status: BranchNodeStatus.Completed, text: result.text };
  }
  await input.onNodeFailed?.(node, result.text);
  return { node, status: BranchNodeStatus.Failed, text: result.text };
}

export async function runParallelBranch<TSpec extends BranchParallelNodeSpec>(
  input: RunParallelBranchInput<TSpec>,
): Promise<ParallelBranchResult<TSpec>> {
  const results = await Promise.all(input.nodes.map((node) => runOneNode(input, node)));
  const successful = results.filter((result) => result.status === BranchNodeStatus.Completed);
  const failed = results.filter((result) => result.status === BranchNodeStatus.Failed);
  return {
    results,
    successful,
    failed,
    allFailed: successful.length === 0,
  };
}
