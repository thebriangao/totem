// Unsigned test JWTs: the token code only decodes claims, never verifies them.
const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");

export function jwt(claims: Record<string, unknown> = {}): string {
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86_400, ...claims })}.sig`;
}

/** A JWT expiring `ms` from `now` (epoch ms). */
export function jwtExpiring(now: number, ms: number, claims: Record<string, unknown> = {}): string {
  return jwt({ ...claims, exp: Math.floor((now + ms) / 1000) });
}
