# README media

The pictures the README and its translations use, and how each was made.

## What's here

| File | Where it's used | How it's made |
|---|---|---|
| `totem-local-light.svg`, `totem-local-dark.svg` | The hero at the top | An animated terminal with a 24-row window, generated from the CLI's real output (the light one in the colours the CLI uses on a light terminal): `npx tsx scripts/readme-media.ts` writes both. A test fails when either is stale. |
| `how-it-works-light.svg`, `how-it-works-dark.svg` | "How it works" | Hand-drawn SVG. The two files differ only in colour. |
| `connect-page-light.png`, `connect-page-dark.png` | "Connect your apps" | A screenshot of the real Connect page (`renderConnectPage`), 1040 px wide. |
| `consent-page-light.png`, `consent-page-dark.png` | "Connect your apps" | A screenshot of the real sign-in page (`renderConsentForm`) as claude.ai sees it, 1040 px wide. |

Every picture comes as a light and a dark pair, switched with `<picture>` and `prefers-color-scheme`, so a dark picture never sits on a light page or the other way round. Viewers decide that differently: github.com seems to follow the theme picked in GitHub's settings, while npm's package page and many editors' previews follow the operating system's setting even when the page itself is light. When adding a picture, make both versions.

Retake the page screenshots when either page changes: render the page to an HTML file, open it in a 1040 × 690 window at 2× scale, and resize the capture to 1040 px wide. Use an example address (`https://totem.you.workers.dev/mcp`), never a real server.

## Social preview

The card GitHub shows when the repo is shared (Settings → Social preview) is uploaded there, not kept in the repo. Update it if the tagline changes.
