/** Small dependency-free PDF writer for text-only study exports. */
export function downloadTextPdf(filename: string, title: string, lines: string[]) {
  const ascii = (value: string) => value
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, "-")
    .replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/≠/g, "!=").replace(/→/g, "->").replace(/×/g, "x").replace(/÷/g, "/")
    .replace(/₵/g, "GHS ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
  const escape = (value: string) => ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const pages: string[][] = [];
  const wrapped: string[] = [];
  for (const raw of [title, "", ...lines]) {
    const words = raw.split(/\s+/); let line = "";
    for (const word of words) { if (`${line} ${word}`.trim().length > 88) { wrapped.push(line); line = word; } else line = `${line} ${word}`.trim(); }
    wrapped.push(line);
  }
  while (wrapped.length) pages.push(wrapped.splice(0, 48));
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>", "");
  const fontId = 3;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const page of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1; pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const commands = page.map((line, index) => `${index ? "T* " : ""}(${escape(line)}) Tj`).join("\n");
    const stream = `BT /F1 11 Tf 14 TL 54 738 Td\n${commands}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
