"use client"

import { useState } from "react"
import { ThemeProvider } from "next-themes"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Vouchers/ledgers can change from other tabs/users; keep data reasonably
            // fresh without refetching on every focus for dense, read-heavy screens.
            staleTime: 30 * 1000,
            retry: 1,
          },
        },
      })
  )

  return (
    // attribute="class" to match the `dark` custom variant in globals.css,
    // which is what the whole dark token set hangs off. next-themes was
    // already a dependency but only imported inside the toast component, so
    // nothing ever set the class and the dark palette was unreachable.
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={300}>
          {children}
          <Toaster richColors position="top-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
