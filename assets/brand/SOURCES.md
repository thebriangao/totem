# Client logo sources

The consent page shows the logo of the AI client that is asking for access. The logos live in `src/whoop/consent_logos.ts` as inline SVG. They are trademarks of their owners, used only to identify the client, and nothing here implies that the owners endorse totem. They are not covered by totem's licence.

Every file came from the owner's own site or from a download that site links to. All were fetched on 2026-11-21.

| Logo | Source | What changed | Trademark |
| --- | --- | --- | --- |
| `claude` | `Claude Spark - Clay.svg` in the press kit at https://www.anthropic.com/press-kit (which redirects to https://assets.claude.com/ae59ca4ca194dac9c9dc3bc78c5829468cb0e8af.zip) | Size attributes removed, coordinates rounded to two decimals. Shape, viewBox and colour (#D97757) as published. | Claude and the Claude spark are trademarks of Anthropic, PBC. |
| `openai` | `OAI_OpenAI-Blossom_Black.svg` in https://cdn.openai.com/brand/openai-logos.zip, linked from https://openai.com/brand/ | Black fill replaced with `currentColor`, viewBox tightened from the 716 unit artboard to the mark, coordinates rounded to two decimals. | OpenAI, ChatGPT and the OpenAI blossom are trademarks of OpenAI. |
| `opencode` | https://opencode.ai/brand/files/opencode-logo-transparent-light.svg, from https://opencode.ai/brand | Ink colour (#1F1F1F) replaced with `currentColor`. Paths and the 20% inner shade as published. | OpenCode and the OpenCode logo are trademarks of Anomaly. |
| `cursor` | `CUBE_2D_LIGHT.svg` in https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip, the download on https://cursor.com/brand | CSS class fill (#26251E) replaced with `fill="currentColor"`, editor metadata removed. Path data untouched. | Cursor and the Cursor logo are trademarks of Anysphere, Inc. |
| `vscode` | `vscode.svg` in https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip, from https://code.visualstudio.com/brand | Inline blend style converted (see below), the two identical shadow filters merged into one, coordinates rounded to two decimals. | Visual Studio Code, VS Code and the Visual Studio Code icon are trademarks of Microsoft Corporation. |
| `antigravity` | https://antigravity.google/favicon.svg | Favicon background disc and its `<style>` block removed, viewBox tightened to the mark, inline mask style converted, filter bookkeeping shortened (see below). | Google Antigravity is a trademark of Google LLC. |

## Notes on the conversions

The page's Content-Security-Policy blocks inline styles, so anything a source expressed with `style="..."` or a `<style>` block had to become plain attributes.

**Marks in `currentColor`.** OpenAI publishes the blossom in black and in white. Cursor publishes the 2D cube in #26251E for light backgrounds and #EDECEC for dark ones. OpenCode publishes its logo in #1F1F1F for light backgrounds and #EEEEEE for dark ones. These three take the page's text colour instead, which gives the light and the dark tile the right variant from one string. One difference remains: OpenCode's dark file draws the inner shade at 28% opacity, and the string here keeps the light file's 20% on both tiles.

**VS Code.** The source lays a white gradient over the whole icon with `mix-blend-mode: overlay` at 25% opacity, which has no attribute form. Its effect on a flat colour is an exact vertical gradient, so each of the three ribbon pieces carries that gradient instead: the published blues (#0065A9, #007ACC, #1F9CF0) at the bottom, and the colour the overlay produces at the top (#007EBE, #0098D9, #27B5F4). Rendered next to the source file the two match to within anti-aliasing. Dropping the overlay would keep only the published hex values but makes the icon visibly flatter.

**Antigravity.** The colours come from ten blurred shapes clipped to the arch. All ten are kept with their published colours, positions and blur radii. To fit in 3 KB the string states each filter region relative to its layer, shares one filter between the two layers with the same blur, draws the solid blue base as a rectangle inside the mask, writes each ellipse centre into its transform, and rounds the blurred layers to one decimal. The mask's `mask-type: alpha` style became a white mask fill, which is the same mask. The header logo on antigravity.google embeds a PNG for the gradient, so it could not be used.

## Updating a logo

Fetch the new file from the owner's site, apply the same rules (one `<svg>` with a `viewBox`, no `width` or `height`, no inline styles, ids prefixed `tl-<logo>-`), and update the row above. `tests/whoop/consent_page.test.ts` checks the rules.
