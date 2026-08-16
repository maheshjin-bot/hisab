import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/currency";

export function SummaryTile({
  label,
  value,
  tone = "default",
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "destructive";
  icon: React.ComponentType<{ className?: string }>;
  /** A real period-over-period delta (e.g. vs. start of month) — never a fabricated figure. Omit when there's no honest baseline to compare against. */
  trend?: { amount: number; caption: string };
}) {
  return (
    <div className="rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-lg",
            tone === "success" && "bg-success/10 text-success",
            tone === "destructive" && "bg-destructive/10 text-destructive",
            tone === "default" && "bg-accent text-accent-foreground"
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      <p
        className={cn(
          "mt-2.5 text-2xl font-semibold tabular-nums tracking-tight",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive"
        )}
      >
        {value}
      </p>
      {trend && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
          {trend.amount > 0 ? (
            <ArrowUpRight className="size-3 shrink-0 text-success" />
          ) : trend.amount < 0 ? (
            <ArrowDownRight className="size-3 shrink-0 text-destructive" />
          ) : (
            <Minus className="size-3 shrink-0" />
          )}
          <span className={cn("font-medium", trend.amount > 0 && "text-success", trend.amount < 0 && "text-destructive")}>
            {formatCurrency(Math.abs(trend.amount), { decimals: false })}
          </span>
          <span className="truncate">{trend.caption}</span>
        </p>
      )}
    </div>
  );
}
