import { ImageResponse } from "next/og";
import { renderAppIcon } from "@/lib/pwa/app-icon";

// Nothing here depends on the request, so render it once at build time.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(renderAppIcon(192), { width: 192, height: 192 });
}
