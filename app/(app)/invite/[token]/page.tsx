"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { useAcceptInviteMutation } from "@/hooks/useCompaniesQuery";
import { errorMessage } from "@/lib/utils/error-message";

/**
 * Redeems an invite token. The (app) layout above has already guaranteed a
 * signed-in user and, for a signed-out visitor, sent them through /login with
 * a ?next= back to this exact URL — so by the time this renders we can simply
 * call the RPC.
 *
 * accept_company_invite() raises in plain English for every failure it knows
 * about; those messages are shown as-is rather than re-worded, because the
 * database is the only thing that knows which of them applies.
 */
export default function AcceptInvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = use(params);
  const router = useRouter();
  // Destructured because the object useMutation returns is new on every
  // render, while mutateAsync itself is a stable reference — so this can go in
  // the dependency array without re-running the effect each render.
  const { mutateAsync } = useAcceptInviteMutation();
  const [error, setError] = useState<string | null>(null);

  // Redeeming is not idempotent from the user's point of view — a second call
  // fails with "no longer pending" — and React runs effects twice in
  // development, so this fires exactly once.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    // mutateAsync rather than mutate(token, { onError }): the per-call
    // callbacks are dropped if the observer unmounts before the request
    // settles, which is exactly what StrictMode's remount does. The promise
    // returned here settles either way.
    mutateAsync(token)
      .then((companyId) => router.replace(`/${companyId}/dashboard`))
      .catch((err: unknown) => setError(errorMessage(err, "This invite could not be accepted.")));
  }, [mutateAsync, router, token]);

  if (error) {
    return (
      <Centered>
        <h1 className="font-heading text-base font-medium">This invite didn&apos;t work</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          Ask whoever invited you to send a fresh link, or check that you&apos;re signed in with the
          address the invite was sent to.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/companies" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Your companies
          </Link>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="font-heading text-base font-medium">Joining the company…</h1>
      <p className="mt-2 text-sm text-muted-foreground">One moment while we accept your invite.</p>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-6 text-center shadow-sm ring-1 ring-foreground/10">
        {children}
      </div>
    </div>
  );
}
