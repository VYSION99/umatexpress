import { AuthRecoveryCard } from "@/components/account/AuthRecoveryCard";

export const metadata = { title: "Reset your console password" };

/** The console reset page. The token in the link decides which account it is for. */
export default async function ConsoleResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  return <AuthRecoveryCard scope="CONSOLE" token={String(params.token || "")} variant="console" signInHref="/console/login" />;
}
