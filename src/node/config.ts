// Settings for the self-hosted server, read from environment variables. Pure, so
// the rules (what is required, what is refused) are unit-tested.

export interface NodeConfig {
  port: number;
  host: string;
  dataDir: string;
  publicDir: string;
  parserCommand: string;
  trustProxy: boolean;
  publicUrl?: string;
  /** Passed to the app as its environment. */
  app: {
    ADMIN_USER: string;
    ADMIN_PASSWORD: string;
    CONFIG_ENCRYPTION_KEY: string;
    SLACK_WEBHOOK_URL?: string;
    READ_TIMEOUT_SECONDS?: string;
    IMAP_TEST_PORT?: string;
    ALLOW_INSECURE_HTTP?: string;
  };
}

export type ConfigResult = { ok: true; config: NodeConfig } | { ok: false; problems: string[] };

const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

function isAes256Key(base64: string): boolean {
  try {
    return Buffer.from(base64, "base64").length === 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD = 10;

export function readConfig(env: Record<string, string | undefined>, defaults: { publicDir: string }): ConfigResult {
  const problems: string[] = [];
  const user = (env.ADMIN_USER ?? "").trim();
  const password = env.ADMIN_PASSWORD ?? "";
  const key = (env.CONFIG_ENCRYPTION_KEY ?? "").trim();

  if (!user) problems.push("ADMIN_USER is not set. This is the user name for signing in.");
  if (!password) problems.push("ADMIN_PASSWORD is not set. This is the password for signing in.");
  else if (password.length < MIN_PASSWORD) problems.push(`ADMIN_PASSWORD is too short. Use at least ${MIN_PASSWORD} characters.`);
  if (!key) problems.push("CONFIG_ENCRYPTION_KEY is not set. It encrypts the mailbox passwords saved in the database. Create one with: openssl rand -base64 32");
  else if (!isAes256Key(key)) problems.push("CONFIG_ENCRYPTION_KEY is not valid. It must be 32 random bytes, base64 encoded. Create one with: openssl rand -base64 32");

  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT must be a number between 1 and 65535 (got "${env.PORT}").`);

  const publicUrl = (env.PUBLIC_URL ?? "").trim();
  if (publicUrl && !/^https?:\/\/[^/\s]+\/?$/.test(publicUrl)) problems.push(`PUBLIC_URL must look like https://dmarc.example.com (got "${publicUrl}").`);

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      port,
      host: env.HOST?.trim() || "0.0.0.0",
      dataDir: env.DATA_DIR?.trim() || "./data",
      publicDir: env.PUBLIC_DIR?.trim() || defaults.publicDir,
      parserCommand: env.PARSER_BIN?.trim() || "dmarc-report-viewer",
      trustProxy: truthy(env.TRUST_PROXY),
      publicUrl: publicUrl || undefined,
      app: {
        ADMIN_USER: user,
        ADMIN_PASSWORD: password,
        CONFIG_ENCRYPTION_KEY: key,
        SLACK_WEBHOOK_URL: env.SLACK_WEBHOOK_URL || undefined,
        READ_TIMEOUT_SECONDS: env.READ_TIMEOUT_SECONDS || undefined,
        IMAP_TEST_PORT: env.IMAP_TEST_PORT || undefined,
        ALLOW_INSECURE_HTTP: truthy(env.ALLOW_INSECURE_HTTP) ? "true" : undefined,
      },
    },
  };
}

export function startupHelp(problems: string[]): string {
  return (
    "dmarc-compass cannot start yet:\n\n" +
    problems.map((p) => `  - ${p}`).join("\n") +
    "\n\nSet these as environment variables (docker run -e ..., a Compose .env file, or a Kubernetes Secret), then start again.\n" +
    "There is deliberately no default password.\n"
  );
}
