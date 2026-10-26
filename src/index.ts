// Cloudflare entry point: the Worker and the Durable Object class that wrangler
// binds. All behaviour is in app.ts; everything Cloudflare-specific is in
// cloudflare-host.ts.

import { handle, runScheduled } from "./app";
import { createCloudflareRuntime, DmarcViewerContainer, type CloudflareEnv } from "./cloudflare-host";

export { DmarcViewerContainer };

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    return handle(request, env, createCloudflareRuntime(env));
  },

  async scheduled(_event: ScheduledController, env: CloudflareEnv): Promise<void> {
    await runScheduled(env, createCloudflareRuntime(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
