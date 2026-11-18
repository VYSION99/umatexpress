/** Keep post-auth navigation on this site, including a selected ride's query and hash. */
export function safeAuthReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://umatexpress.local");
    return url.origin === "https://umatexpress.local" ? value : "/";
  } catch {
    return "/";
  }
}

/** Account entry points that lead to actions reserved for UMaT students. */
export function requiresStudentAccess(path: string): boolean {
  return /^\/(campus|vacation|hostel|print-copy)(?:[/?#]|$)/.test(path);
}
