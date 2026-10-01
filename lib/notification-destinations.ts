import { residentCareWorkspaceLink } from "./campus-engine/notify-templates";

export type NotificationAction = { href: string; label: string };

/** A message may offer only a page that understands its product and reference. */
export function notificationAction(template: string, reference: string, message = ""): NotificationAction | null {
  if (template.startsWith("auth_")) return null;
  const care = residentCareWorkspaceLink(template);
  if (care) return { href: care.path, label: care.cta };
  if (template === "cinema_invite" && /^[A-Za-z0-9_-]+$/.test(reference)) {
    return { href: "/cinema/" + encodeURIComponent(reference), label: "Open cinema room" };
  }
  if (template.startsWith("vacation_")) {
    return reference ? { href: "/payment/callback?reference=" + encodeURIComponent(reference), label: "View ticket" } : null;
  }
  if (template.startsWith("campus_") || ["driver_accepted", "driver_arrived", "driver_cancelled", "trip_completed"].includes(template)) {
    return reference ? { href: "/campus/ticket?reference=" + encodeURIComponent(reference), label: "Track ride" } : { href: "/campus", label: "Open campusRide" };
  }
  if (template.startsWith("hostel_viewing_") || template === "hostel_bed_available" || template === "hostel_year_open") {
    const property = message.match(/\/hostel\/[A-Za-z0-9_-]+(?:\?periodId=[A-Za-z0-9_-]+)?/)?.[0];
    return { href: property || "/hostel", label: "View hostel" };
  }
  if (template === "hostel_message_staff") return { href: "/console/hostels", label: "Open hostel messages" };
  if (template === "hostel_message_received" || template === "hostel_message_student") return { href: "/hostel/resident?section=messages", label: "Open messages" };
  if (template === "hostel_ai_inquiry_reply") return null;
  if (template === "hostel_refund_requested") return { href: "/console/hostels", label: "Review refund request" };
  if (template.startsWith("hostel_refund_")) return { href: "/hostel/resident?section=payments", label: "View payments" };
  if (template.startsWith("hostel_")) {
    if (template.endsWith("_staff") || template.endsWith("_landlord") || template === "hostel_review_received" || template === "hostel_payout_recorded") {
      return { href: "/console/hostels", label: "Open Hostel Finder console" };
    }
    return { href: "/hostel/resident", label: "Open residency" };
  }
  if (template.startsWith("organizer_")) return { href: "/console/vacation", label: "Open vacationRide console" };
  if (template.startsWith("landlord_")) return { href: "/console/hostels", label: "Open Hostel Finder console" };
  if (template.startsWith("driver_")) return { href: "/console/driver", label: "Open driver console" };
  return null;
}
