import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "./middleware";
import { corsOrigin, requireAuth } from "./middleware";
import type { Env } from "./types";
import { connectHandler } from "./routes/connect";
import { statusHandler } from "./routes/status";
import { disconnectHandler } from "./routes/disconnect";
import { syncHandler } from "./routes/sync";
import { scheduleHandler } from "./routes/schedule";
import { listScannedHandler } from "./routes/scanned";
import { reprocessHandler } from "./routes/reprocess";
import { searchSettingsHandler } from "./routes/search-settings";
import { approveReviewHandler, listReviewHandler, rejectReviewHandler } from "./routes/review";
import { handleScheduled } from "./scheduled";

const app = new Hono<AppContext>();

app.use(
  "*",
  cors({
    origin: (origin, c) => corsOrigin(c.env, origin) ?? "",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/", (c) => c.json({ ok: true, service: "moneta-email-worker" }));

app.use("/email/*", requireAuth);
app.post("/email/connect", connectHandler);
app.post("/email/disconnect", disconnectHandler);
app.get("/email/status", statusHandler);
app.post("/email/sync", syncHandler);
app.post("/email/schedule", scheduleHandler);
app.get("/email/scanned", listScannedHandler);
app.post("/email/reprocess", reprocessHandler);
app.post("/email/search-settings", searchSettingsHandler);
app.get("/email/review", listReviewHandler);
app.post("/email/review/:id/approve", approveReviewHandler);
app.post("/email/review/:id/reject", rejectReviewHandler);

app.onError((err, c) => {
  console.error("[worker] unhandled error", err instanceof Error ? err.message : err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;
