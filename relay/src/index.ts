/**
 * cameld email-code relay. Strava login-code mail reaches this Worker via a
 * Gmail filter ("Forward it to" 2fa@<relay mail subdomain>) and Cloudflare
 * Email Routing; the cameld server on the NAS claims codes over HTTP.
 */
import { importDataKey } from "./crypto.ts";
import { consoleLog, handleEmail, handleHttp } from "./handlers.ts";
import { CodeStore } from "./store.ts";

export interface Env {
  DB: D1Database;
  /** base64 of 32 random bytes. */
  DATA_KEY: string;
  /** Bearer token the NAS presents. */
  RELAY_TOKEN: string;
}

async function storeFor(env: Env): Promise<CodeStore> {
  return new CodeStore(env.DB, await importDataKey(env.DATA_KEY));
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const store = await storeFor(env);
    const now = Date.now();
    await handleEmail(message, store, now, consoleLog);
    ctx.waitUntil(store.purge(now));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return handleHttp(request, await storeFor(env), env.RELAY_TOKEN, Date.now());
  },
} satisfies ExportedHandler<Env>;
