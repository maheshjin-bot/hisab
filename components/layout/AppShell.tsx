import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";

export function AppShell({
  companyId,
  userEmail,
  children,
}: {
  companyId: string;
  userEmail: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full">
      <Sidebar companyId={companyId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar companyId={companyId} userEmail={userEmail} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette companyId={companyId} />
    </div>
  );
}
