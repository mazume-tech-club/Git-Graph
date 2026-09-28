import type { RefLabel } from "../types";

const LABEL: Record<RefLabel["kind"], string> = {
  head: "HEAD",
  localBranch: "branch",
  remoteBranch: "remote",
  tag: "tag",
};

export function RefBadge({ refLabel }: { refLabel: RefLabel }) {
  return (
    <span className={`ref-badge ref-${refLabel.kind}`} title={LABEL[refLabel.kind]}>
      {refLabel.name}
    </span>
  );
}
