import CampusLauncher from "@/components/launcher/CampusLauncher";
import { BrandSplash } from "@/components/launcher/BrandSplash";
import { ReloadSkeleton } from "@/components/launcher/ReloadSkeleton";

export default function ClientHomePage() {
  return <>
    <ReloadSkeleton />
    <BrandSplash />
    <CampusLauncher />
  </>;
}
