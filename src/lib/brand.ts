// totem's brand: the logo (assets/brand/totem.svg) and its colours, used by the
// pages a server shows (Connect, consent), the MCP server's icon and the CLI.
//
// The logo is an isometric S in a hexagon: ice, with a darker fold face, and no
// background anywhere it is used, so it sits on whatever is behind it. Ice and
// ink are the brand colours (ink is the dark page and the buttons, never a
// square behind the logo); fold is the mark's own shade, used where ice would
// be too faint (a light page or terminal).

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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 800 800"><polygon fill="#B7D3F2" points="125.00,393.35 500.00,176.84 684.73,283.49 376.23,461.60 509.24,538.40 258.00,683.44 125.00,606.65"/><polygon fill="#7A9CC6" points="125.00,606.65 376.23,461.60 509.24,538.40 258.00,683.44"/><polygon fill="#B7D3F2" points="875.00,606.65 500.00,823.16 315.27,716.51 623.77,538.40 490.76,461.60 742.00,316.56 875.00,393.35"/><polygon fill="#7A9CC6" points="875.00,393.35 623.77,538.40 490.76,461.60 742.00,316.56"/></svg>';

/** Where a server serves the logo as its favicon, and the tag that points there. */
export const FAVICON_PATH = "/favicon.svg";
export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">`;

/**
 * The logo for a page header that names totem in text beside it: the same
 * shapes in a viewBox cut to the mark (x 125–875, y 176.84–823.16), so it
 * fills its box and lines up with the text.
 */
export const TOTEM_MARK = TOTEM_LOGO_SVG
  .replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 800 800">', '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="125 176 750 648">');

/**
 * 128 px PNG of the logo on a transparent background, for MCP clients that
 * don't draw SVG icons. Regenerate after a logo change:
 *   magick -background none -density 192 assets/brand/totem.svg -resize 128x128 -depth 8 +dither -colors 64 -strip -define png:compression-level=9 icon.png
 */
const ICON_PNG_128 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAbFBMVEWlw+WiweO30/KYt9u30/K10fG30/K30/KQsNa30/Kuy+uK" +
  "qtK30/K30/J7ncePr9W30/J8nse30/J7nce30/J6nMZ7ncd6nMZ7ncd7ncZ7ncd8nceOrtS30/J6nMaDpM2Wtdq41POeveF/oco3" +
  "j25FAAAAHXRSTlMAC1xQuPrFUxad+iPg6LEU1UAqkBnscdn7x4Jk/KAY6UUAAAPKSURBVHja7VttYqowEBQRQUQwRYraAmLvf8fy" +
  "1PqAbMgm2YQ/zAHMmNnvLKvVggULFixYYARvvfbmPN/fBNU2nO34aBdXHeLdfqbbT6oXDmnm/vz1serh6NoUWCf+AMHGd3j8R3qo" +
  "OMS7yJn42wpEkjvRIRQc/zAFZv34/dP1RLBtChkk/sgU0g+L4h8rBLa2XHJK/BGF0L34Y5ekjs6nPKmUQBudkeKPXJLOFPxx3HVr" +
  "CpGK+KNL2FPcfqJ7PEly0BGfMCayjf7try0lXRyS/DSP6wnD0N6zF3cR3hflRcrsxV1Z/PE+y7quzwoUMn3xgQjsX+onijybQ/z0" +
  "XL9RfiJMIdwQip/lRT3AxbcYdwXiD3FO95RJty8+V4n5aQ2hFJsCM4i7jBe/qAUQmIJu0gXjrpeXtRiQS0aptvgJL344dfzDJdPI" +
  "YtJlfdcT6tBvo0LKpBtdixqF8q2DdyR0va+yRqJp/hznlJDFXZaij78FBzMCQNxFif/ErbN5MwKIuCvGd1y1ZgRwcVd0+/d/x5sQ" +
  "mEq6GPHb189oEpAlXentv/+HHgE+7mZ5qSa+CYHETPyg7SupTgAYf+Bd7+c2OF6dQFttuSTmaYmvSSD+LkPtyDsQX4dAG9x+wEQe" +
  "YcJPM759VQJtcG/gRI6xgk58OJxgCbTd7QsS+YtCqXr7agT6xz8TuYevwP7irjaBTvwGUdNFcA0Ki69AoK3uDVjT5ShTuE0WmnIC" +
  "LXf7PR2+pKWoUHw0gfg2ZVx8mzVIChPi4whA4ktN4Z0WJ8XHEOhuv5EHGKDjfhYG35guY4LAlPiyNqvLjjLx5QQecRcHvjiKdkGL" +
  "K6wEBOTi9y6AT0/4JgsmgL99sNNWGa/ABPDHF/ysgSl12ACBVkV833SyyREQxV2k9SsPt0YEVMQH/F9jsjkiMB13JYMmrclmn4CK" +
  "6wE5QG+y2SfgVnyOQKMgfkQ31n4TWIUlVnxGOtZW7e5KZnGyKe9v+RLI4EUp5iebkg6/uEZWJ5uSNhcqg3eEk03ZlMco6ao9J0K1" +
  "tWHSVX1OHA/Zz1DSJXxUAExh0HFfjJNuX/wr7jnxf8dNGHfVthqepkCTdPUe8z1WUiVd3XWGjNl9Tpz5LVljh2fjSHzy50SKtSba" +
  "50SNv7/Vj7s023VrTQZ0y31aHpCQ7rQpJwD6BU+lvtPOXiNeB1tLvsgyyOaaMyIg2V70lpXC9lfdJ13SzYa3MC2723EHCxO3W/58" +
  "aUaxPmdgCskMX3r0TMHmNjXCFNx+WsBHZwcb9ZOmsD6tFixYsGDBAiP8Avw8HRY2BcgBAAAAAElFTkSuQmCC";

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
