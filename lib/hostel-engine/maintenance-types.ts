/** Shared display types; this module deliberately has no server dependencies. */
export const MAINTENANCE_CATEGORIES = ['WATER', 'ELECTRICITY', 'PLUMBING', 'FURNITURE', 'INTERNET', 'OTHER'] as const;
export const MAINTENANCE_STATUSES = ['SUBMITTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_STUDENT', 'RESOLVED', 'CLOSED', 'CANCELLED'] as const;
export const MAINTENANCE_ACTIONS = ['ACKNOWLEDGE', 'START', 'WAIT', 'RESOLVE', 'CLOSE', 'REOPEN', 'CANCEL', 'COMMENT', 'ASSIGN', 'ESCALATE'] as const;
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number];
export type MaintenanceAction = typeof MAINTENANCE_ACTIONS[number];
export const MAINTENANCE_LABELS: Record<string, string> = {
 WATER: 'Water', ELECTRICITY: 'Electricity', PLUMBING: 'Plumbing', FURNITURE: 'Furniture', INTERNET: 'Internet', OTHER: 'Other',
 ROUTINE: 'Routine', URGENT: 'Urgent', SUBMITTED: 'Submitted', ACKNOWLEDGED: 'Acknowledged', IN_PROGRESS: 'In progress', WAITING_FOR_STUDENT: 'Waiting for you',
 RESOLVED: 'Resolved', CLOSED: 'Closed', CANCELLED: 'Cancelled', ACKNOWLEDGE: 'Acknowledge', START: 'Start work', WAIT: 'Ask for details',
 RESOLVE: 'Mark resolved', CLOSE: 'Confirm resolved', REOPEN: 'Reopen', CANCEL: 'Cancel request', COMMENT: 'Add reply', ASSIGN: 'Assign staff', ESCALATE: 'Escalate to owner',
 SUBMIT: 'Report submitted', ROOM: 'My room / bed', SHARED: 'Shared area', PRESENT_ONLY: 'Only when I am present', ARRANGE_FIRST: 'Contact me to arrange access', PERMITTED: 'Staff may enter to attend this report',
};
export const MAX_MAINTENANCE_PHOTOS = 3;
export const MAX_MAINTENANCE_PHOTO_BYTES = 6 * 1024 * 1024;
export type MaintenanceConfig = {
 propertyId: string; propertyName: string; enabled: boolean; platformEnabled: boolean; canCreate: boolean;
 serviceHours: string; acknowledgementHours: number; urgentContact: string; contactReviewed: boolean; version: number;
};
export type MaintenanceRequest = {
 id: string; reference: string; bookingId: string; propertyId: string; propertyName: string; studentName: string; studentEmail: string;
 roomLabel: string; spaceLabel: string; category: string; urgency: string; locationType: string; locationDetail: string;
 title: string; description: string; entryPermission: string; preferredAccess: string; status: MaintenanceStatus;
 assigneeEmail: string; assigneeName: string; version: number; acknowledgementDueAt: string; acknowledgedAt: string;
 escalatedAt: string; resolvedAt: string; createdAt: string; updatedAt: string; overdue: boolean;
};
export type MaintenanceEvent = { id: string; action: string; actorType: string; actorName: string; status: string; previousStatus: string; note: string; createdAt: string; details: { assigneeName?: string } };
export type MaintenanceFile = { id: string; eventId: string; name: string; bytes: number; contentType: string; url: string };
export type MaintenanceDetail = { ticket: MaintenanceRequest; events: MaintenanceEvent[]; files: MaintenanceFile[]; actions: MaintenanceAction[] };
export type MaintenancePerson = { email: string; name: string };
export type MaintenanceList = {
 tickets: MaintenanceRequest[]; pagination: { page: number; pages: number; total: number; pageSize: number };
 summary: { open: number; overdue: number; escalated: number; resolved: number }; config?: MaintenanceConfig; isOwner?: boolean;
};
export type MaintenanceDraft = {
 reference: string; clientRequestId: string; category: string; urgency: string; locationType: string; locationDetail: string;
 title: string; description: string; entryPermission: string; preferredAccess: string;
};
export function maintenanceActions(status: MaintenanceStatus, staff: boolean, escalated = false): MaintenanceAction[] {
 if (status === 'CANCELLED') return [];
 if (status === 'CLOSED') return ['REOPEN'];
 const actions: MaintenanceAction[] = ['COMMENT'];
 if (status === 'RESOLVED') return staff ? [...actions, 'REOPEN'] : [...actions, 'CLOSE', 'REOPEN'];
 if (staff) {
  actions.push('ASSIGN');
  if (status === 'SUBMITTED') actions.push('ACKNOWLEDGE');
  if (['ACKNOWLEDGED', 'WAITING_FOR_STUDENT'].includes(status)) actions.push('START');
  if (['ACKNOWLEDGED', 'IN_PROGRESS'].includes(status)) actions.push('WAIT');
  if (['ACKNOWLEDGED', 'IN_PROGRESS', 'WAITING_FOR_STUDENT'].includes(status)) actions.push('RESOLVE');
 }
 actions.push('CANCEL');
 if (!escalated) actions.push('ESCALATE');
 return actions;
}
