import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Loader2,
  Mail,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  connectEmailWithAppPassword,
  disconnectEmail,
  emailWorkerConfigured,
  reprocessScannedEmail,
  setEmailSearchSettings,
  setEmailSyncFrequency,
  syncEmailNow,
  useEmailStatus,
  useScannedEmails,
  type ScannedEmail,
  type SyncFrequency,
} from "@/lib/email-connection";
import { StringListEditor } from "@/components/string-list-editor";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const SYNC_STEPS = [
  "Connecting to Gmail…",
  "Searching for financial emails…",
  "Analyzing transactions…",
  "Checking for duplicates…",
  "Importing transactions…",
];

const FREQUENCY_OPTIONS: { value: SyncFrequency; label: string }[] = [
  { value: "manual", label: "Manual only" },
  { value: "5min", label: "Every 5 minutes" },
  { value: "10min", label: "Every 10 minutes" },
  { value: "15min", label: "Every 15 minutes" },
  { value: "30min", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "2h", label: "Every 2 hours" },
  { value: "daily", label: "Daily" },
  { value: "custom", label: "Custom…" },
];

const MIN_CUSTOM_MINUTES = 5;
const MAX_CUSTOM_MINUTES = 10080;

const OUTCOME_META: Record<ScannedEmail["outcome"], { label: string; className: string }> = {
  imported: { label: "Imported", className: "border-transparent bg-[#4F8A5B]/15 text-[#4F8A5B]" },
  review: { label: "Needs review", className: "border-transparent bg-primary/15 text-primary" },
  ignored: { label: "Not a transaction", className: "border-border text-muted-foreground" },
};

export function EmailConnectionCard() {
  const qc = useQueryClient();
  const { data: status, isLoading } = useEmailStatus();
  const [connectOpen, setConnectOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStep, setSyncStep] = useState(0);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingFrequency, setSavingFrequency] = useState(false);
  const [pendingFrequency, setPendingFrequency] = useState<SyncFrequency | null>(null);
  const [customMinutesInput, setCustomMinutesInput] = useState("");
  const persistedCustomMinutes =
    status && status.status !== "not_connected" ? status.customIntervalMinutes : null;
  useEffect(() => {
    if (persistedCustomMinutes != null) setCustomMinutesInput(String(persistedCustomMinutes));
  }, [persistedCustomMinutes]);
  const [scannedOpen, setScannedOpen] = useState(false);
  const { data: scannedEmails = [], isLoading: scannedLoading } = useScannedEmails(scannedOpen);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);
  const [searchSettingsOpen, setSearchSettingsOpen] = useState(false);
  const [folder, setFolder] = useState("INBOX");
  const [senders, setSenders] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [savingSearchSettings, setSavingSearchSettings] = useState(false);

  if (!emailWorkerConfigured()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Email Connection</CardTitle>
          <CardDescription>Not set up for this deployment yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This deployment doesn't have the email-import Worker configured (
            <code className="text-xs">VITE_EMAIL_WORKER_URL</code> is unset). See{" "}
            <code className="text-xs">worker/README.md</code> to deploy it.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    setConnecting(true);
    try {
      await connectEmailWithAppPassword(email.trim(), appPassword.trim());
      setConnectOpen(false);
      setEmail("");
      setAppPassword("");
      toast.success("Email connected");
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not connect your email.");
    } finally {
      setConnecting(false);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncStep(0);
    const interval = setInterval(() => {
      setSyncStep((s) => Math.min(s + 1, SYNC_STEPS.length - 1));
    }, 1400);
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
      clearInterval(interval);
      setSyncing(false);
    }
  }

  async function reprocess(messageId: string) {
    setReprocessingId(messageId);
    try {
      const result = await reprocessScannedEmail(messageId);
      const OUTCOME_TOAST: Record<typeof result.outcome, string> = {
        imported: "Re-imported as a transaction (any earlier one from this email was replaced).",
        review: "Now waiting in Needs Review (any earlier verdict was replaced).",
        ignored: "Still not a transaction — same verdict as before.",
      };
      toast.success(OUTCOME_TOAST[result.outcome]);
      qc.invalidateQueries({ queryKey: ["email-scanned"] });
      qc.invalidateQueries({ queryKey: ["email-review-items"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reprocess this email.");
    } finally {
      setReprocessingId(null);
    }
  }

  async function changeFrequency(frequency: SyncFrequency, customMinutes?: number) {
    setSavingFrequency(true);
    try {
      await setEmailSyncFrequency(frequency, customMinutes);
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
      toast.success(frequency === "manual" ? "Auto-sync turned off" : "Sync schedule updated");
      setPendingFrequency(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the sync schedule.");
    } finally {
      setSavingFrequency(false);
    }
  }

  function selectFrequency(frequency: SyncFrequency) {
    if (frequency === "custom") {
      setPendingFrequency("custom");
      return;
    }
    changeFrequency(frequency);
  }

  function saveCustomFrequency() {
    const minutes = Number(customMinutesInput);
    if (!Number.isFinite(minutes) || minutes < MIN_CUSTOM_MINUTES || minutes > MAX_CUSTOM_MINUTES) {
      toast.error(
        `Enter a number of minutes between ${MIN_CUSTOM_MINUTES} and ${MAX_CUSTOM_MINUTES}.`,
      );
      return;
    }
    changeFrequency("custom", Math.round(minutes));
  }

  function openSearchSettings() {
    if (status && status.status !== "not_connected") {
      setFolder(status.searchFolder);
      setSenders(status.searchSenders);
      setKeywords(status.searchKeywords);
    }
    setSearchSettingsOpen(true);
  }

  async function saveSearchSettings(e: FormEvent) {
    e.preventDefault();
    if (!folder.trim() || (senders.length === 0 && keywords.length === 0)) return;
    setSavingSearchSettings(true);
    try {
      await setEmailSearchSettings({ folder: folder.trim(), senders, keywords });
      setSearchSettingsOpen(false);
      toast.success("Search settings saved — next sync will use them.");
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save those search settings.");
    } finally {
      setSavingSearchSettings(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      await disconnectEmail();
      qc.invalidateQueries({ queryKey: ["email-connection-status"] });
      toast.success("Email disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect your email.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Connection</CardTitle>
        <CardDescription>
          Connect your email to automatically find transactions from receipts, payment
          notifications, bank alerts, deposits and withdrawals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full rounded-lg" />
            <div className="grid grid-cols-3 gap-3">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
          </div>
        )}

        {!isLoading && (!status || status.status === "not_connected") && (
          <div className="animate-in fade-in space-y-4 duration-300">
            <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              <p className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5" /> How this works right now
              </p>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Temporary setup: uses a Google <strong>App Password</strong>, never your real
                  Gmail password.
                </li>
                <li>
                  Requires 2-Step Verification to already be turned on for your Google account.
                </li>
                <li>
                  Only emails matching financial senders or keywords (payment, receipt, deposit,
                  refund, and similar) are ever looked at.
                </li>
              </ul>
            </div>
            <Button onClick={() => setConnectOpen(true)}>
              <Mail className="mr-2 h-4 w-4" />
              Connect Email
            </Button>
          </div>
        )}

        {!isLoading && status && status.status !== "not_connected" && (
          <div className="animate-in fade-in space-y-4 duration-300">
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div className="flex items-start gap-2">
                {status.status === "error" ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#4F8A5B]" />
                )}
                <div>
                  <p className="text-sm font-medium">{status.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {status.status === "error"
                      ? (status.lastSyncError ?? "The last sync ran into a problem.")
                      : status.lastSyncedAt
                        ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}`
                        : "Not synced yet"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              <div className="rounded-lg border border-border p-3">
                <p className="font-display text-lg font-semibold tabular-nums">
                  {status.emailsScannedTotal}
                </p>
                <p className="text-xs text-muted-foreground">Emails scanned</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="font-display text-lg font-semibold tabular-nums">
                  {status.transactionsFoundTotal}
                </p>
                <p className="text-xs text-muted-foreground">Found</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="font-display text-lg font-semibold tabular-nums">
                  {status.transactionsImportedTotal}
                </p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="sync-frequency" className="text-sm font-medium">
                    Sync automatically
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Checks in every 5 minutes and syncs when your schedule is due.
                  </p>
                </div>
                <Select
                  value={pendingFrequency ?? status.syncFrequency}
                  onValueChange={(v) => selectFrequency(v as SyncFrequency)}
                  disabled={savingFrequency}
                >
                  <SelectTrigger id="sync-frequency" className="w-40 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREQUENCY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(pendingFrequency ?? status.syncFrequency) === "custom" && (
                <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                  <Label
                    htmlFor="custom-minutes"
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    Every
                  </Label>
                  <Input
                    id="custom-minutes"
                    type="number"
                    min={MIN_CUSTOM_MINUTES}
                    max={MAX_CUSTOM_MINUTES}
                    value={customMinutesInput}
                    onChange={(e) => setCustomMinutesInput(e.target.value)}
                    placeholder="e.g. 45"
                    className="h-8 w-24"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">minutes</span>
                  <Button
                    size="sm"
                    className="ml-auto h-8"
                    onClick={saveCustomFrequency}
                    disabled={savingFrequency || !customMinutesInput.trim()}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>

            {syncing && (
              <p className="text-xs text-muted-foreground">
                <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
                {SYNC_STEPS[syncStep]}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={sync} disabled={syncing}>
                <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                Sync Now
              </Button>
              <Button variant="outline" asChild>
                <a href="/needs-review">Review transactions</a>
              </Button>
              <Button variant="outline" onClick={() => setScannedOpen(true)}>
                <Inbox className="mr-2 h-4 w-4" />
                Scanned emails
              </Button>
              <Button variant="outline" onClick={openSearchSettings}>
                <Settings2 className="mr-2 h-4 w-4" />
                Search settings
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-destructive" disabled={disconnecting}>
                    <Unplug className="mr-2 h-4 w-4" /> Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {status.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Moneta stops reading this inbox immediately. Transactions already imported
                      stay in your account.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Moneta only looks at emails likely to be financial, never stores full email contents —
          just the sender and subject line of each one scanned, plus transaction details when found
          — and you can disconnect at any time. AI is used to read and classify each matched email.
        </p>
      </CardContent>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Gmail</DialogTitle>
            <DialogDescription>
              Uses a Google App Password — a 16-character code, separate from your real password,
              generated at{" "}
              <span className="font-medium text-foreground">myaccount.google.com/apppasswords</span>
              . Requires 2-Step Verification to already be turned on for your Google account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={connect} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="gmail-address">Gmail address</Label>
              <Input
                id="gmail-address"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gmail-app-password">App password</Label>
              <Input
                id="gmail-app-password"
                type="password"
                autoComplete="off"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                required
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={connecting}>
                {connecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Connect
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={scannedOpen} onOpenChange={setScannedOpen}>
        <DialogContent className="max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Scanned emails</DialogTitle>
            <DialogDescription>
              The most recent emails a sync has looked at, and what happened to each one.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-6 max-h-[60vh] overflow-y-auto border-t border-border">
            {scannedLoading && (
              <div className="space-y-3 px-6 py-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}
            {!scannedLoading && scannedEmails.length === 0 && (
              <EmptyState
                icon={Inbox}
                title="No emails scanned yet"
                description="Run a sync to see them here."
              />
            )}
            <div className="divide-y divide-border">
              {scannedEmails.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 px-6 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.subject}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.from}</p>
                    {item.processedAt && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {new Date(item.processedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant="outline" className={OUTCOME_META[item.outcome].className}>
                      {OUTCOME_META[item.outcome].label}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => reprocess(item.id)}
                      disabled={reprocessingId === item.id}
                      className="text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {reprocessingId === item.id ? "Rechecking…" : "Recheck"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={searchSettingsOpen} onOpenChange={setSearchSettingsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Search settings</DialogTitle>
            <DialogDescription>
              Control exactly what a sync looks for. Saving resets the "last synced" point, so the
              next sync re-checks the folder from the start under these settings — emails already
              scanned before are still skipped automatically.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveSearchSettings} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="search-folder">Folder / label</Label>
              <Input
                id="search-folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="INBOX"
                required
              />
              <p className="text-xs text-muted-foreground">
                Usually <code className="text-xs">INBOX</code>. Use{" "}
                <code className="text-xs">[Gmail]/All Mail</code> to search everything, or type any
                Gmail label you use (e.g. a "Receipts" label you already filter into).
              </p>
            </div>
            <div className="space-y-2">
              <Label>Senders</Label>
              <StringListEditor
                value={senders}
                onChange={setSenders}
                placeholder="e.g. chase, paypal, venmo…"
              />
              <p className="text-xs text-muted-foreground">
                Matches the sender's address or name. Unrecognized senders can still match on
                keywords below.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Subject keywords</Label>
              <StringListEditor
                value={keywords}
                onChange={setKeywords}
                placeholder="e.g. receipt, invoice, deposit…"
              />
              <p className="text-xs text-muted-foreground">
                Matches words anywhere in the subject line.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={savingSearchSettings || (senders.length === 0 && keywords.length === 0)}
              >
                {savingSearchSettings && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
