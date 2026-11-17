import type { Metadata } from "next";
import Link from "next/link";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { Copy, MapPinLine, ShieldCheck } from "@/components/ui/MaterialIcon";
import { PrintCopyMyQuotes, PrintCopyQuoteButton, PrintCopyReportButton } from "@/components/printCopy/PrintCopyActions";
import { getPrintCopyQuoteSettings, listPublicPrintCopyProviders } from "@/lib/print-copy/directory";
import "./print-copy.css";

export const metadata: Metadata = {
  title: "Print & Copy | UMaTeXPRESS",
  description: "Find provider-verified printing and photocopy services around UMaT.",
};
export const dynamic = "force-dynamic";

function checkedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-GH", { dateStyle: "medium" }).format(date);
}

export default async function PrintCopyPage() {
  const [providers, quoteSettings] = await Promise.all([listPublicPrintCopyProviders().catch(() => null), getPrintCopyQuoteSettings().catch(() => ({ enabled: false }))]);
  return <CampusShell area="PRINT & COPY" title="Print & Copy around campus" subtitle="Compare provider-confirmed services, indicative prices, and typical turnaround before you contact a shop.">
    <div className="print-copy-page">
      <section className="print-copy-trust"><ShieldCheck size={21} aria-hidden /><div><strong>Verified shop details</strong><p>Details are checked at least every 30 days. Prices and turnaround are indicative; confirm the final quote directly with the shop.</p></div></section>
      {providers === null ? <section className="print-copy-empty"><span><Copy size={25} aria-hidden /></span><h2>Listings are temporarily unavailable</h2><p>We couldn’t check the shop directory right now. Please try again shortly.</p><Link href="/print-copy" className="print-copy-home">Try again</Link></section> : providers.length ? <section className="print-copy-list" aria-label="Verified print shops">{providers.map((provider) => <article className="print-copy-card" key={provider.id}>
        <header><div><span className="print-copy-verified"><ShieldCheck size={14} aria-hidden /> Verified</span><h2>{provider.name}</h2><p>{provider.description}</p></div></header>
        <p className="print-copy-location"><MapPinLine size={17} aria-hidden />{provider.location}</p>
        <dl><div><dt>Services</dt><dd>{provider.services.join(" · ") || "Ask the shop"}</dd></div><div><dt>Opening hours</dt><dd>{provider.hours}</dd></div><div><dt>Indicative pricing</dt><dd>{provider.indicativePricing || "Ask the shop for a quote"}</dd></div><div><dt>Typical turnaround</dt><dd>{provider.turnaround || "Confirm when requesting a quote"}</dd></div><div><dt>Details checked</dt><dd>{checkedDate(provider.verifiedAt)}</dd></div></dl>
        <div className="print-copy-actions"><a className="print-copy-action" href={provider.contactHref}>{provider.contactLabel}</a>{quoteSettings.enabled && <PrintCopyQuoteButton providerId={provider.id} providerName={provider.name} />}</div>
        {!quoteSettings.enabled && <p className="print-copy-quote-paused">Online quote requests are not open yet. Contact the shop directly for a quote.</p>}
        <PrintCopyReportButton providerId={provider.id} providerName={provider.name} />
      </article>)}</section> : <section className="print-copy-empty"><span><Copy size={25} aria-hidden /></span><h2>Verified print shops are not listed yet</h2><p>We’re confirming shop services, location, hours, and prices before publishing listings. Check back when provider details have been reviewed.</p><Link href="/" className="print-copy-home">Back to services</Link></section>}
      <PrintCopyMyQuotes />
      <p className="print-copy-privacy">Quote requests use your signed-in student name and email so staff can follow up. The request only contains the job description you enter. Do not submit documents or sensitive personal information.</p>
    </div>
  </CampusShell>;
}
