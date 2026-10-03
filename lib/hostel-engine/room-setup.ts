import { CampusEngineError } from "@/lib/campus-engine/errors";
import { ownerReadiness } from "@/lib/hostel-engine/onboarding";

/** Rooms and bed spaces belong to the workspace after every setup review passes. */
export async function requireApprovedRoomSetup(landlordId: string, propertyStatus: string) {
  const owner = await ownerReadiness(landlordId);
  if (owner.profileStatus !== "APPROVED" || owner.identityStatus !== "VERIFIED" || owner.payoutStatus !== "APPROVED" || propertyStatus !== "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "Account details, identity, payout destination, and property must all be approved before adding rooms or beds.", 409);
  }
}
