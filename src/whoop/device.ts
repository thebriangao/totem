// Device-identity headers that make our data requests indistinguishable from
// the WHOOP iOS app's own traffic.
//
// Why this exists: the data endpoints on api.prod.whoop.com authenticate on the
// bearer token alone, so a bare request *works* — but it doesn't look like the
// app. The real app stamps every data request with a fixed set of `x-whoop-*`
// identity headers plus `user-agent: iOS`. Sending the same set puts our
// requests inside the legitimate-app traffic distribution instead of leaving us
// as the one client that omits them (a missing header is itself a tell).
//
// Design rule — so a WHOOP engineer reading this open-source file CANNOT write a
// one-line rule that catches us specifically:
//   - The static values below are the app's OWN constants, shared by every real
//     install on this version. They're camouflage, not a signature.
//   - Per-install values (the installation identifier) are randomized per
//     install, exactly like the app, so there is no shared constant to grep.
//   - Environment values (time zone) are derived from the host, like a phone.
//   - We add NOTHING the app doesn't send: no fabricated Sentry baggage/trace,
//     no marketing cookies. A unique invented header would be the precise
//     fingerprint we are trying not to leave.
//
// Captured from WHOOP iOS 5.52.0 (build 595097). Bump these when the app ships a
// new version so we keep blending with the current install base.

import { randomUUID } from "node:crypto";

export const IOS_APP_VERSION = "5.52.0";
export const IOS_BUILD_NUMBER = "595097";
export const IOS_BUNDLE_NAME = "com.whoop.iphone";

// When the constants above were captured from a real device. If the bundled
// version drifts too far behind the live install base it stops being camouflage
// and becomes a "this one frozen old version" cohort — warn at boot so it gets
// refreshed. Bump alongside the version/build when you re-capture.
export const IOS_VERSION_CAPTURED_AT = "2026-05"; // YYYY-MM
export function versionStaleWarning(maxAgeMonths = 6): string | null {
  const [y, m] = IOS_VERSION_CAPTURED_AT.split("-").map(Number);
  if (!y || !m) return null;
  const ageMonths = (Date.now() - new Date(y, m - 1, 1).getTime()) / (30 * 86_400_000);
  if (ageMonths < maxAgeMonths) return null;
  return `[totem] bundled WHOOP iOS version (${IOS_APP_VERSION}, captured ${IOS_VERSION_CAPTURED_AT}) is ~${Math.round(ageMonths)} months old — update src/whoop/device.ts to keep blending with the current app install base.`;
}

// The app sends an uppercase UUID; randomUUID() is lowercase, so we upcase it.
function newInstallationId(): string {
  return randomUUID().toUpperCase();
}

let cachedInstallationId: string | null = null;

/**
 * The per-install identifier sent as `x-whoop-installation-identifier`.
 *
 * Resolution: `WHOOP_INSTALLATION_ID` env (persisted at boot by
 * resolveInstallationId) → a random per-process UUID fallback. A real install
 * keeps one stable ID for its lifetime; persisting the env value gives us the
 * same stability across restarts, while the per-process fallback keeps tests and
 * one-off scripts working with no setup. The value is randomized per install,
 * so no two totem users share one — there is no constant to fingerprint.
 */
export function getInstallationId(): string {
  if (cachedInstallationId) return cachedInstallationId;
  cachedInstallationId = process.env.WHOOP_INSTALLATION_ID ?? newInstallationId();
  return cachedInstallationId;
}

// IANA zone for the `x-whoop-time-zone` header. The app sends the phone's IANA
// name (e.g. "America/Los_Angeles"). We send the host's resolved zone. If
// WHOOP_TIMEZONE is set to an IANA name we honor it, but a fixed-offset value
// (which the Whoop-profile timezone tier can produce) is not a valid IANA name,
// so we fall back to the system zone in that case.
function deviceTimeZone(): string {
  const env = process.env.WHOOP_TIMEZONE;
  if (env && env.includes("/")) return env;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
}

/**
 * The identity header set the WHOOP iOS app stamps on every data request, minus
 * the per-request telemetry (Sentry baggage/trace) and marketing cookies that
 * carry no auth weight and would only add a fabricated, greppable signature.
 * Merged into every request by WhoopClient; `authorization` and (for bodies)
 * `content-type` are layered on top by the client itself.
 */
export function deviceHeaders(): Record<string, string> {
  return {
    "user-agent": "iOS",
    "x-whoop-device-platform": "iOS",
    "x-whoop-ios-version": IOS_APP_VERSION,
    "x-whoop-ios-build-number": IOS_BUILD_NUMBER,
    "x-whoop-bundle-name": IOS_BUNDLE_NAME,
    "x-whoop-installation-identifier": getInstallationId(),
    "x-whoop-time-zone": deviceTimeZone(),
    // The app's clock-format preference. Our own captures show the sleep
    // deep-dive already returns 12-hour clock labels by default; sending this
    // explicitly makes that deterministic — the sleep projection's
    // parseClockMinutes expects AM/PM — instead of leaning on an unstated
    // server default.
    "x-whoop-clock-format": "TWELVE_HOUR",
    currency: "USD",
    locale: "en_US",
    "accept-language": "en",
    accept: "*/*",
    priority: "u=3",
  };
}
