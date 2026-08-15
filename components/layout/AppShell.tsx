import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

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
        <TopBar userEmail={userEmail} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
