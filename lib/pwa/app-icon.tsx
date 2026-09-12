/**
 * Shared mark for every generated app icon (manifest icons, apple-touch-icon).
 * One indigo rounded square with a white ₹ — the same "first letter on a
 * tinted chip" language CompanySwitcher already uses, just rendered to a PNG
 * via next/og's ImageResponse instead of CSS.
 *
 * Kept inside an ~80% safe zone so Android's maskable-icon crop (a circle cut
 * from the square) never clips the glyph.
 */
export function renderAppIcon(size: number) {
  const glyphSize = Math.round(size * 0.52);
  const radius = Math.round(size * 0.22);

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#4338ca",
        borderRadius: radius,
      }}
    >
      <span
        style={{
          fontSize: glyphSize,
          fontWeight: 700,
          color: "#fafafa",
          lineHeight: 1,
        }}
      >
        ₹
      </span>
    </div>
  );
}
