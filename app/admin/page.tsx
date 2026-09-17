import { AdminGate } from "@/components/admin/AdminGate";
import ConsoleLauncher from "@/components/admin/ConsoleLauncher";

export default function SuperAdminHome() {
  return <AdminGate label="super-admin"><ConsoleLauncher /></AdminGate>;
}
