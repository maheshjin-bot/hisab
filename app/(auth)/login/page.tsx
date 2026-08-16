"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { safeReturnPath } from "@/lib/utils/return-path";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSupabase } from "@/hooks/useSupabase";

// useSearchParams below opts this subtree out of prerendering, so it needs a
// Suspense boundary of its own rather than blocking the whole route.
export default function LoginPage() {
  return (
    <Suspense
      fallback={<div className="h-96 rounded-2xl bg-card shadow-sm ring-1 ring-foreground/10" />}
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const supabase = useSupabase();
  const router = useRouter();
  // Set when the visitor was sent here from a deep link — an invite, usually.
  const destination = safeReturnPath(useSearchParams().get("next"));
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        router.push(destination);
        router.refresh();
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setCheckEmail(true);
        } else {
          router.push("/");
          router.refresh();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="rounded-2xl bg-card p-6 text-center text-sm shadow-sm ring-1 ring-foreground/10">
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1 text-muted-foreground">We sent a confirmation link to {email}.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-card p-6 shadow-sm ring-1 ring-foreground/10">
      <Tabs value={mode} onValueChange={(v) => setMode(v as "login" | "signup")}>
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="login" className="flex-1">Sign in</TabsTrigger>
          <TabsTrigger value="signup" className="flex-1">Create account</TabsTrigger>
        </TabsList>
      </Tabs>

      <form onSubmit={handleSubmit}>
        <FieldGroup>
          {mode === "signup" && (
            <Field>
              <FieldLabel htmlFor="fullName">Full name</FieldLabel>
              <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </FieldGroup>
      </form>
    </div>
  );
}
