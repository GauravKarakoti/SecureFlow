/**
 * SVG status badge generator.
 *
 * Produces shields.io-style flat badges entirely server-side — no external
 * service dependency. The label is always "SecureFlow" and the message
 * reflects the latest scan policy decision.
 */

export type BadgeState = "passing" | "review required" | "blocked" | "unknown";

const STATE_COLOURS: Record<BadgeState, string> = {
  passing: "#4c1",
  "review required": "#dfb317",
  blocked: "#e05d44",
  unknown: "#9f9f9f",
};

/** Approximate the rendered width of a string in the Verdana 11px font used by shields.io. */
function textWidth(text: string): number {
  // Average character width for Verdana 11px is ~6.8px; add padding.
  return Math.round(text.length * 6.8 + 10);
}

/**
 * Generate an SVG badge for a given scan state.
 *
 * The returned string is a self-contained SVG document ready to serve with
 * `Content-Type: image/svg+xml`.
 */
export function generateBadgeSvg(state: BadgeState): string {
  const label = "SecureFlow";
  const message = state;
  const colour = STATE_COLOURS[state];

  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const totalWidth = labelWidth + messageWidth;

  // prettier-ignore
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${message}">`,
    `  <title>${label}: ${message}</title>`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`,
    `    <stop offset="1" stop-opacity=".1"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${labelWidth}" height="20" fill="#555"/>`,
    `    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${colour}"/>`,
    `    <rect width="${totalWidth}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">`,
    `    <text aria-hidden="true" x="${labelWidth * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${label}</text>`,
    `    <text x="${labelWidth * 5}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelWidth - 10) * 10}">${label}</text>`,
    `    <text aria-hidden="true" x="${(labelWidth + messageWidth / 2 + labelWidth / 2) * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(messageWidth - 10) * 10}">${message}</text>`,
    `    <text x="${(labelWidth + messageWidth / 2 + labelWidth / 2) * 5}" y="140" transform="scale(.1)" fill="#fff" textLength="${(messageWidth - 10) * 10}">${message}</text>`,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}
