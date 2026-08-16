export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">
            H
          </span>
          <span className="text-lg font-semibold tracking-tight">HISAB</span>
          <p className="mt-1 text-sm text-muted-foreground">Double-entry books, built for speed.</p>
        </div>
        {children}
      </div>
    </div>
  );
}
