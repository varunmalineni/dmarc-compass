// Resolution of the deployment's own credentials from Worker secrets.

export interface AdminEnv {
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  /** Legacy names, still honoured so existing deployments keep working. */
  HTTP_SERVER_USER?: string;
  HTTP_SERVER_PASSWORD?: string;
}

export interface AdminCreds {
  user: string;
  password: string;
}

/** The admin login. It also protects the internal container's own UI
 * (/classic), so the same pair is handed to the container at start. */
export function getAdminCreds(env: AdminEnv): AdminCreds | null {
  const user = env.ADMIN_USER || env.HTTP_SERVER_USER;
  const password = env.ADMIN_PASSWORD || env.HTTP_SERVER_PASSWORD;
  return user && password ? { user, password } : null;
}

export const SETUP_HELP =
  "dmarc-compass is not configured yet.\n\n" +
  "Set the admin login (and the config encryption key) as Worker secrets, then reload:\n\n" +
  "  npm run setup\n\n" +
  "or manually:\n\n" +
  "  npx wrangler secret put ADMIN_USER\n" +
  "  npx wrangler secret put ADMIN_PASSWORD\n" +
  "  openssl rand -base64 32 | npx wrangler secret put CONFIG_ENCRYPTION_KEY\n";
