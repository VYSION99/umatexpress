/**
 * The UMaT student email rule, kept free of server imports so both the sign-in
 * page (client) and the account service (server) enforce exactly the same
 * domain check.
 */

/** The only domain that may hold a student account. */
export const STUDENT_EMAIL_DOMAIN = "st.umat.edu.gh";

export function normalizeStudentEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : "";
}

/**
 * True only for an address on STUDENT_EMAIL_DOMAIN. The local part still has to
 * look like a mailbox, so "ama@st.umat.edu.gh" passes while
 * "ama@x.st.umat.edu.gh" and "st.umat.edu.gh@evil.test" do not.
 */
export function validStudentEmail(email: string) {
  const suffix = `@${STUDENT_EMAIL_DOMAIN}`;
  if (!email.endsWith(suffix)) return false;
  const local = email.slice(0, -suffix.length);
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(local) && !local.includes("..") && local.length <= 64;
}
