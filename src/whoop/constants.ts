export const BASE_URL = "https://api.prod.whoop.com";
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * WHOOP's web client. Browser-login tokens are issued to it, and Cognito refreshes
 * need the issuing client's id (verified live 2026-11-21; see SPEC.md §4.0).
 */
export const WEB_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";
