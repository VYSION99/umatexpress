/** Client-safe condition-record vocabulary and projections. */
export const CONDITION_VALUES = ['GOOD','WORN','DAMAGED','MISSING','NOT_CHECKED','NOT_APPLICABLE'] as const;
export const CONDITION_LABELS: Record<string,string> = {
 GOOD:'Good',WORN:'Worn',DAMAGED:'Damaged',MISSING:'Missing',NOT_CHECKED:'Not checked',NOT_APPLICABLE:'Not applicable',
 DRAFT:'Awaiting move-in record',SUBMITTED:'Awaiting staff review',CLARIFICATION_REQUESTED:'Clarification requested',ACKNOWLEDGED:'Receipt acknowledged',CLOSED:'Closed',
 SUBMIT:'Submit move-in record',AMEND:'Amend move-in record',ACKNOWLEDGE:'Acknowledge receipt',CLARIFY:'Request clarification',CHECKOUT:'Record checkout inspection',ACK_CHECKOUT:'Acknowledge checkout',
 COMMENT:'Add a note',DISPUTE:'Raise a disagreement',WITHDRAW:'Withdraw our disagreement',CLOSE:'Close condition record',TRANSFER:'New room handover',START:'Record opened',MOVE_IN:'Move-in',
};
export type ChecklistItem = { key:string; label:string };
export type ConditionItem = ChecklistItem & { condition:typeof CONDITION_VALUES[number]; note:string };
export const DEFAULT_CONDITION_CHECKLIST: ChecklistItem[] = [
 ['bed','Bed frame'],['mattress','Mattress'],['desk','Desk and chair'],['storage','Wardrobe / storage'],['locks','Door and locks'],['sockets','Sockets and lighting'],['walls','Walls and floor'],['bathroom','Bathroom and plumbing'],['shared','Shared facilities'],
].map(([key,label])=>({key,label}));
export type ConditionConfig = { propertyId:string; propertyName:string; enabled:boolean; platformEnabled:boolean; canCreate:boolean; version:number; checklist:ChecklistItem[] };
export type ConditionRecord = {
 id:string; reference:string; bookingId:string; bookingReference:string; assignmentId:string; propertyId:string; propertyName:string;
 studentName:string; roomLabel:string; spaceLabel:string; status:string; version:number; checklist:ChecklistItem[];
 moveInRevision:number; moveInAck:number; checkoutRevision:number; checkoutAck:number; disputeBy:string; disputeNote:string;
 archivedAt:string; closedAt:string; createdAt:string; updatedAt:string;
};
export type ConditionEvent = { id:string; version:number; action:string; actorType:string; actorName:string; note:string; createdAt:string };
export type ConditionRevision = { id:string; eventId:string; phase:string; revision:number; items:ConditionItem[]; authorType:string; authorName:string; createdAt:string };
export type ConditionPhoto = { id:string; eventId:string; itemKey:string; name:string; url:string };
export type ConditionDetail = { record:ConditionRecord; revisions:ConditionRevision[]; events:ConditionEvent[]; photos:ConditionPhoto[]; actions:string[] };
export type ConditionList = { records:ConditionRecord[]; pagination:{page:number;pages:number;total:number}; config?:ConditionConfig; isOwner:boolean };
