import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { emailWorkerConfigured, syncEmailNow, useEmailStatus } from "@/lib/email-connection";

/** A "Sync" button that kicks off an email sync — only renders once an email account is actually connected. */
export function SyncEmailButton() {
  const qc = useQueryClient();
  const { data: status } = useEmailStatus();
  const [syncing, setSyncing] = useState(false);

  if (!emailWorkerConfigured() || !status || status.status === "not_connected") return null;

  async function sync() {
    setSyncing(true);
    try {
      const summary = await syncEmailNow();
      toast.success(
        `Sync complete — ${summary.emailsScanned} emails scanned, ${summary.transactionsFound} transactions found, ${summary.imported} imported, ${summary.needsReview} need review.`,
      );
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
      qc.invalidateQueries({ queryKey: ["email-review-items"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "We couldn't finish syncing.");
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Button variant="outline" onClick={sync} disabled={syncing}>
      <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
      Sync
    </Button>
  );
}
