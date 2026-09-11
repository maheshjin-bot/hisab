import { ImageResponse } from "next/og";
import { renderAppIcon } from "@/lib/pwa/app-icon";

// Apple's own convention: a 180×180 PNG, auto-linked as apple-touch-icon.
// iOS applies its own rounding/shine, so this is left square (no radius
// tweak needed beyond what renderAppIcon already does for Android).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(renderAppIcon(180), size);
}
