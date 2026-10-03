import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

/**
 * Test doubles for Cloudflare Access: an RSA key pair generated per test run
 * (nothing committed), a JWKS document for it and a token signer. The team,
 * AUD and email are synthetic.
 */

export const TEAM = "synthetic-team.cloudflareaccess.com";
export const AUD = "synthetic-aud-0123456789abcdef";
export const OWNER = "owner@example.com";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function testKey(kid = "test-kid-1"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    alg: "RS256",
    use: "sig",
  };
  return { kid, privateKey, jwk };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signToken(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = encode({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = encode(claims);
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), key.privateKey).toString(
    "base64url",
  );
  return `${head}.${body}.${signature}`;
}

export function ownerClaims(
  nowMs: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: OWNER,
    iat: now,
    nbf: now,
    exp: now + 3600,
    sub: "synthetic-subject",
    ...overrides,
  };
}

/** A fetch double serving the JWKS for `keys()`, counting calls. */
export function jwksFetch(keys: () => Record<string, unknown>[]): typeof fetch & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return new Response(JSON.stringify({ keys: keys() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: number };
  fn.calls = 0;
  return fn;
}
