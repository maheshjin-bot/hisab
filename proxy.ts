import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Refreshes the Supabase session on every request so Server Components
 * always see a valid (non-expired) session. This does not itself enforce
 * auth on any route — route-level access control happens per-page by
 * checking the session and per-row via Postgres RLS.
 */
/**
 * Server Components can't read the current pathname, so the auth guard in
 * app/(app)/layout.tsx has no way to know where a signed-out visitor was
 * headed. Stamping it on the request here gives it one — which is what lets
 * an invite link survive a trip through /login. Always `set`, never `append`:
 * a client-supplied x-pathname must not be trusted.
 */
function nextWithPathname(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = nextWithPathname(request);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Re-derived after the cookie writes above so the refreshed session
          // cookies are carried on the outgoing request headers.
          supabaseResponse = nextWithPathname(request);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Touching auth here is what actually performs the refresh + cookie
  // rewrite above — do not remove even though the claims aren't used
  // directly in this function.
  await supabase.auth.getClaims();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
