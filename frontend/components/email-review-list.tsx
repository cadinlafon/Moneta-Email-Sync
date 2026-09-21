import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  approveReviewItem,
  rejectReviewItem,
  useReviewItems,
  type ReviewItem,
} from "@/lib/email-connection";

/**
 * Minimal review queue: medium-confidence emails the worker wasn't sure
 * about. Approving creates the real transaction (server-side); rejecting
 * discards it. Restyle freely — the data layer is in lib/email-connection.ts.
 */
export function EmailReviewList() {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useReviewItems();

  async function act(item: ReviewItem, action: "approve" | "reject") {
    try {
      if (action === "approve") await approveReviewItem(item.id);
      else await rejectReviewItem(item.id);
      qc.invalidateQueries({ queryKey: ["email-review-items"] });
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
      // Also invalidate whatever query key your app uses for transactions/accounts here.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing to review.</p>;

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border border-border p-4">
          <p className="font-medium">
            {item.merchant ?? item.description ?? "Transaction"} — {item.type}{" "}
            {item.amount.toFixed(2)} {item.currency}
          </p>
          <p className="text-xs text-muted-foreground">
            {item.email_subject} · {item.email_from} · {Math.round(item.confidence * 100)}% sure
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => act(item, "approve")}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(item, "reject")}>
              Reject
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
