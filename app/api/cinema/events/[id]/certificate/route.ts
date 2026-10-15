import { fail } from "@/lib/campus-engine/responses";
import { attendanceForCinemaEvent } from "@/lib/cinema-engine/events";
import { requireCinemaAccount } from "@/lib/student-auth";

function pdfEscape(value: string) { return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, " "); }

function certificatePdf(input: { name: string; title: string; organizer: string; date: string }) {
  const content = [
    "0.10 0.27 0.20 rg 0 0 842 595 re f",
    "0.78 0.93 0.67 rg 22 22 798 551 re S",
    "1 1 1 rg BT /F1 18 Tf 72 492 Td (UMATeXPRESS CINEMA) Tj ET",
    "0.78 0.93 0.67 rg BT /F1 14 Tf 72 444 Td (CERTIFICATE OF ATTENDANCE) Tj ET",
    `1 1 1 rg BT /F1 34 Tf 72 350 Td (${pdfEscape(input.name)}) Tj ET`,
    "0.76 0.84 0.80 rg BT /F1 14 Tf 72 314 Td (attended the community event) Tj ET",
    `1 1 1 rg BT /F1 24 Tf 72 264 Td (${pdfEscape(input.title)}) Tj ET`,
    `0.76 0.84 0.80 rg BT /F1 12 Tf 72 222 Td (Presented by ${pdfEscape(input.organizer)}  |  ${pdfEscape(input.date)}) Tj ET`,
    "0.78 0.93 0.67 rg 72 155 240 2 re f",
    "0.76 0.84 0.80 rg BT /F1 10 Tf 72 132 Td (Verified from the Cinema attendance record.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request); const { id } = await context.params;
    const record = await attendanceForCinemaEvent(id, student.id);
    if (!record.event.certificatesEnabled) return Response.json({ error: "This event does not issue attendance certificates." }, { status: 409 });
    if (record.event.state !== "REPLAY" || !record.attended) return Response.json({ error: "A certificate is issued after the event to students who attended." }, { status: 403 });
    const bytes = certificatePdf({ name: student.name || record.displayName || "UMaT student", title: record.event.title, organizer: record.event.organizer.name, date: new Date(record.event.startsAt).toLocaleDateString("en-GH", { dateStyle: "long" }) });
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${record.event.slug}-certificate.pdf"`, "cache-control": "private, no-store" } });
  } catch (error) { return fail(error, request); }
}
