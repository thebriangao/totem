// totem's brand: the logo (assets/brand/totem.svg) and its colours, used by the
// pages a server shows (Connect, consent), the MCP server's icon and the CLI.
//
// The logo is an isometric S in a hexagon: ice on ink, with a darker fold face.
// Ice and ink are the brand colours; fold is the mark's own shade, used where
// ice would be too faint (a light page or terminal).

export const BRAND = {
  ice: "#B7D3F2",
  ink: "#141414",
  fold: "#7A9CC6",
} as const;

/**
 * The logo as one inline SVG string: assets/brand/totem.svg without its title,
 * comments and ids, so it can sit in a page more than once.
 * tests/lib/brand.test.ts keeps the two in step.
 */
export const TOTEM_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="#141414"/><polygon fill="#B7D3F2" points="125.00,393.35 500.00,176.84 684.73,283.49 376.23,461.60 509.24,538.40 258.00,683.44 125.00,606.65"/><polygon fill="#7A9CC6" points="125.00,606.65 376.23,461.60 509.24,538.40 258.00,683.44"/><polygon fill="#B7D3F2" points="875.00,606.65 500.00,823.16 315.27,716.51 623.77,538.40 490.76,461.60 742.00,316.56 875.00,393.35"/><polygon fill="#7A9CC6" points="875.00,393.35 623.77,538.40 490.76,461.60 742.00,316.56"/></svg>';

/** Where a server serves the logo as its favicon, and the tag that points there. */
export const FAVICON_PATH = "/favicon.svg";
export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">`;

/**
 * The mark alone, for a page header that names totem in text beside it: no ink
 * square, so it sits on whatever colour the page is, and a viewBox cut to the
 * mark (x 125–875, y 176.84–823.16) so it fills its box.
 */
export const TOTEM_MARK = TOTEM_LOGO_SVG
  .replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">', '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="125 176 750 648">')
  .replace('<rect width="1000" height="1000" fill="#141414"/>', "");

/**
 * 128 px PNG of the logo, for MCP clients that don't draw SVG icons.
 * Regenerate after a logo change:
 *   magick -background none -density 96 assets/brand/totem.svg -resize 128x128 -depth 8 -colors 32 PNG8:icon.png
 */
const ICON_PNG_128 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6" +
  "UTwAAABIUExURRQUFCgsMR4hJGJvfqO816jB3Wh5jh0eIUZOWJKuz7fT8kpZajQ7QoWZr46ju3WGmVdmdjtFUXKOsFlvi3qcxmR/" +
  "oKC+4X+gyuX/H1MAAAAJcEhZcwAAAGAAAABgAPBrQs8AAAAHdElNRQfqCxYTFBxdZj0lAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2" +
  "LTExLTIyVDE5OjIwOjI4KzAwOjAwrEgpjQAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMS0yMlQxOToyMDoyOCswMDowMN0VkTEA" +
  "AAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTEtMjJUMTk6MjA6MjgrMDA6MDCKALDuAAAASHRFWHRzdmc6Y29tbWVudAAgZWFj" +
  "aCBoYWxmOiBmdWxsIHNoYXBlIGluIHRoZSBtYWluIGNvbG91ciwgZm9sZCBmYWNlIG9uIHRvcCCGGd8vAAAAEnRFWHRzdmc6dGl0" +
  "bGUAICAgdG90ZW0mudvFAAADOklEQVR42u1a0bKqMAw8cEQoolAE/P8/vagcJSmQpC1l5k73XbN0003S9ucnIiIiIiIiIiIiIsIN" +
  "SXJo+PT3lJ2Po5AXqhyhLvkx8atrOeFWHBA+OWflB1kdWoe0OZUAp980YPi8uJUGAqZCVZeLuOog4YH4ECFSIb+ocgO7p8KS+CgV" +
  "ih1TIakzKv4zFaqdwo++ywj/TIVd3JkQH+nQeE8FfeWHfyajZ3Pmif9F7TcNDN8lcPO7EXJ668HV96x/JRMf7YDKVYsN310E9ICk" +
  "adu7y5ZMG8HWK7ELppe2G9FebCURiw/qQK77bkKtrZIyqUXhUSVM7t0Md3kqJGfZ1oO9wLT6X7SNLBVEvlvibigvUHhxKmih+Gjr" +
  "9d0iem4qCH3XEL/t1sDakuyiOwHOBIb4Yh1S2eqrBoivN8O/KFCLkEi+H/vunQqvhozakBICsOhuif8XfuTsj8BtyXc3478WzRcB" +
  "VHR1TYZ/by1PBCzE//ulFwLQd8eiS4R/fH3VBwHkuwzx54O8MwE0fOleEn4k4OoDQws+gfz+j/h+CAzKqKzJVgI+jKLqJEGm3n8L" +
  "HT1f34LKrGouBNTj88+wsq6YEF59RwKDAv8OK+vCTlwMb08gUzhAC60Qe9FaR2VHwAz/olCslmK1fopjQ2AmPkQP/u2TCiurb0tg" +
  "UN067mY7pjb7WTGBbCv8a0uCTrNqiXZaSoAIjwlMx9feCAxUfDR6VvQwJSFAhkcTF2uS5hOgxB8/H9ohb5JmE2CID4yIO0kzCUjF" +
  "5w9TrHJMi48cSDBJMwgwxIceLJqkSQJpS64+asiFJ5jkfEr1uLbiv8G6UNjq8lEnIp6keScEq0Mu6sVI34WQnGAvNlmoG3U7wSRh" +
  "zroWvjuDxS0GPOqpbXz3u/pWx9ezVMDiu5xgSvB32CouukB8p7u859zTu4nvepuptb3v+r/PlYp/9nt34XaC6Qy3E0x3VMeKL1yA" +
  "fe5O+Sng+drwC17z4fnaEIBhA76vDTGIq5wQz5q2UiHQK5I1P9z18QRAvtQOhH1JZNTE8G+pYFcQSHyAWV901Hu66WHD6cAXhWMq" +
  "hBcfQh8gfkRERERERERERMR/hn9K0ekNLhIt8gAAAABJRU5ErkJggg==";

/** The MCP server's icons (serverInfo.icons): the SVG, and the PNG for clients that don't draw SVG. */
export const SERVER_ICONS = [
  { src: `data:image/svg+xml;base64,${Buffer.from(TOTEM_LOGO_SVG).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] },
  { src: `data:image/png;base64,${ICON_PNG_128}`, mimeType: "image/png", sizes: ["128x128"] },
];

/** What the MCP server says it is (initialize's serverInfo), on stdio and HTTP alike. */
export const serverIdentity = (version: string) => ({
  name: "totem",
  version,
  websiteUrl: "https://github.com/thebriangao/totem",
  icons: SERVER_ICONS,
});
