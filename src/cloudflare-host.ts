// Everything that exists only on Cloudflare: the Durable Object that runs the
// parser container, the TCP sockets API, and the way a parser is shared between
// jobs. The rest of the app sees it through runtime.ts.

import { Container, getContainer } from "@cloudflare/containers";
import { connect } from "cloudflare:sockets";
import { acquireLock, loadMailbox, mailboxForStart, releaseLock } from "./mailbox-store";
import { containerEnv } from "./mailboxes";
import { getSyncMinutes } from "./sync-settings";
import { containerIntervalSeconds } from "./sync-schedule";
import { ensureSchema } from "./migrations";
import { constantTimeEqual } from "./security";
import { getAdminCreds, SETUP_HELP } from "./config";
import type { Env } from "./app";
import type { LeaseOptions, LeaseResult, Runtime } from "./runtime";
import type { Mailbox } from "./mailboxes";

export interface CloudflareEnv extends Env {
  DMARC_CONTAINER: DurableObjectNamespace<DmarcViewerContainer>;
}

const NOT_CONFIGURED_MAILBOX =
  "No mailbox is configured yet.\n\nOpen /admin, enter the IMAP details of the mailbox that receives your DMARC reports, and save.\n";

// A single long-lived instance of the dmarc-report-viewer container, which
// does the IMAP fetching and report parsing. It keeps everything in memory
// and re-fetches from IMAP on every start, so the durable copy of the data is
// the D1 database (see sync.ts), not the container.
export class DmarcViewerContainer extends Container<CloudflareEnv> {
  defaultPort = 8080;
  // Sleep after 30 minutes without requests. Syncs more often than that keep it
  // awake; with longer intervals it sleeps between syncs, and the sync waits for
  // it to finish reading when it wakes.
  sleepAfter = "30m";
  pingEndpoint = "localhost/health";

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const creds = getAdminCreds(this.env);
    if (!creds) return new Response(SETUP_HELP, { status: 503 });

    // Internal only: the Worker calls this after a settings save so the
    // container restarts with the new environment. It is never reachable
    // from outside; the Worker is the only caller of this class.
    if (url.pathname === "/admin/restart") {
      if (!constantTimeEqual(request.headers.get("x-admin-token") ?? "", creds.password)) {
        return new Response("Forbidden\n", { status: 403 });
      }
      await this.stop();
      return new Response("Stopping. The next request starts a fresh container.\n");
    }

    await ensureSchema(this.env.DB);
    // One container reads one mailbox at a time. Which one is decided by the
    // Worker (see loadMailbox in mailbox-store.ts) and read here when it starts.
    const mailbox = await mailboxForStart(this.env);
    if (!mailbox) return new Response(NOT_CONFIGURED_MAILBOX, { status: 503 });

    // Credentials are injected here at start time rather than baked into the image.
    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          ...containerEnv(mailbox),
          IMAP_CHECK_INTERVAL: String(containerIntervalSeconds(await getSyncMinutes(this.env.DB))),
          LOG_LEVEL: "debug",
          HTTP_SERVER_PORT: "8080",
          HTTP_SERVER_USER: creds.user,
          HTTP_SERVER_PASSWORD: creds.password,
        },
      },
    });
    return this.containerFetch(request);
  }

  override onStart() {
    console.log("dmarc-report-viewer container started");
  }

  override onError(error: unknown) {
    console.error("dmarc-report-viewer container error:", error);
    throw error;
  }
}

async function restartContainer(env: CloudflareEnv): Promise<void> {
  const creds = getAdminCreds(env);
  if (!creds) return;
  const container = getContainer(env.DMARC_CONTAINER, "dmarc-viewer");
  try {
    await container.fetch(
      new Request("https://internal/admin/restart", { method: "POST", headers: { "x-admin-token": creds.password } }),
    );
  } catch (err) {
    // The container may simply not be running yet; the next request starts it.
    console.warn("container restart skipped:", err);
  }
}

/** One parser container, shared. It reads one mailbox at a time, so jobs take turns:
 * the sync lock is held by the sync itself, and a person fetching an original file
 * takes the "raw" lock and is asked to retry if a sync has the reader. */
function cloudflareParsers(env: CloudflareEnv) {
  return {
    async lease(mailbox: Mailbox, opts: LeaseOptions): Promise<LeaseResult> {
      const raw = opts.purpose === "raw";
      if (raw && !(await acquireLock(env.DB, "raw", 5 * 60))) {
        return { ok: false, busy: true, error: "A sync is using the mailbox reader right now. Try again in a minute." };
      }
      const release = async () => {
        if (raw) await releaseLock(env.DB);
      };
      try {
        const container = getContainer(env.DMARC_CONTAINER, "dmarc-viewer");
        const loaded = await loadMailbox(env, container, mailbox, () => restartContainer(env), opts.timeoutMs, { onlyMailbox: opts.onlyMailbox });
        if (!loaded.ok) {
          await release();
          return { ok: false, error: loaded.error };
        }
        return { ok: true, client: container, release };
      } catch (err) {
        await release();
        throw err;
      }
    },
  };
}

export function createCloudflareRuntime(env: CloudflareEnv): Runtime {
  return {
    parsers: cloudflareParsers(env),
    connect: (host, port, tls) => connect({ hostname: host, port }, { secureTransport: tls ? "on" : "off", allowHalfOpen: false }),
  };
}
