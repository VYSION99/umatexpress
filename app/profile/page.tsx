import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { StudentProfileWorkspace } from "@/components/account/StudentProfileWorkspace";

export default function ProfilePage() {
  return <CampusShell area="UMATEXPRESS ACCOUNT" title="Your profile" subtitle="Your details, sign-in security and campus activity in one place.">
    <StudentProfileWorkspace />
  </CampusShell>;
}
