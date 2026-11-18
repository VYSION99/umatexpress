# UMaTeXPRESS account access

One account and sign-in session is shared across public services and student services. A valid email address can create an account. New accounts must verify their sign-in email before joining Cinema activities or using student-only actions.

| Action | Requirement |
| --- | --- |
| Browse public service pages | No account |
| Join public Cinema activities and manage a profile | Verified account email |
| Book student rides, request Print & Copy quotes, use student hostel actions, host Cinema events or subscribe to student room plans | Verified UMaT student email |

A verified `@st.umat.edu.gh` sign-in email grants student access. Someone who registered with another email can link and verify a UMaT student address on `/account` without changing their sign-in email or creating another account. The code is sent only to the UMaT address, expires after ten minutes, and stops working after five wrong attempts. A student address can belong to one account. The account API checks student eligibility at each restricted action; hiding a button in the UI is never the access check.

Existing student accounts created before email verification became mandatory retain their previous access. A separate migration and notification campaign is needed before requiring those accounts to verify. New accounts and new linked student addresses have no such exception.

The legacy `/api/auth/cinema-audience` registration endpoint remains available for older clients; the main account form uses `/api/auth/student` for every email. `/api/auth/student/eligibility` reports student access and handles linked-address verification. These route names are historical; they do not create separate account types.
