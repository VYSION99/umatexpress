import { ConsoleSessionGate } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";
import { PrintCopyManager } from "@/components/console/printCopy/PrintCopyManager";

export default function PrintCopyConsolePage() {
  return <ConsoleSessionGate label="Print & Copy directory">
    {(session) => session.account.role === "ADMIN" && (session.account.delegateServices === undefined || session.account.delegateServices.includes("print-copy"))
      ? <ConsoleShell session={session} service="print-copy" label="CAMPUS SERVICES · PRINT & COPY" title="Print & Copy" blurb="Verify shop details, review student quote requests, and keep public listings accurate."><PrintCopyManager /></ConsoleShell>
      : <ConsoleUnavailable session={session} service="print-copy" label="PRINT & COPY" blurb="Print & Copy listings and quote requests are managed by authorized platform staff." />}
  </ConsoleSessionGate>;
}
