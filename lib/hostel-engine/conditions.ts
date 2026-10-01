import { CampusEngineError } from '@/lib/campus-engine/errors';
import { platformSettingEnabled } from '@/lib/platform-settings';
import { rowsToObjects, turso, tursoTransaction } from '@/lib/turso';
import { getHostelBookingByReference } from './residency';
import { ensureHostelConditionTables } from './condition-schema';
import { CONDITION_LABELS, CONDITION_VALUES, DEFAULT_CONDITION_CHECKLIST, type ChecklistItem, type ConditionConfig, type ConditionDetail, type ConditionItem, type ConditionRecord } from './condition-types';
import { discardMaintenancePhotos, maintenanceBucket, maintenanceHash, maintenancePhotoUrl, stageMaintenancePhotos, validateMaintenancePhotos, verifyMaintenancePhotoToken, type MaintenanceActor, type MaintenanceUpload } from './maintenance-files';
import type { PhotoBucket } from './photos';

type Row = Record<string,unknown>;
export type ConditionStatement = { sql:string; args:Array<string|number|null> };
const notFound = () => new CampusEngineError('NOT_FOUND','That condition record was not found.',404);
const conflict = () => new CampusEngineError('CONFLICT','The record or room assignment changed. Refresh and review the latest details before retrying.',409);
function text(value:unknown,max:number,min=0) { if(typeof value!=='string'&&value!==undefined)throw new CampusEngineError('VALIDATION_ERROR','Enter valid text.',400);const result=String(value||'').trim();if(result.length>max||result.length<min)throw new CampusEngineError('VALIDATION_ERROR',`Enter ${min||1}–${max} characters.`,400);return result; }
function key(value:unknown){const result=String(value||'');if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result))throw new CampusEngineError('VALIDATION_ERROR','Refresh this action before submitting.',400);return result.toLowerCase();}
const scope=(actor:MaintenanceActor)=>actor.kind==='STUDENT'?{sql:'c.student_email=?',value:actor.email.toLowerCase()}:{sql:'c.landlord_id=?',value:actor.landlordId};
const select=`SELECT c.*,p.name AS property_name,b.status AS booking_status,b.space_id AS current_space,st.assignment_id AS current_assignment,st.status AS stay_status,pe.starts_on,pe.ends_on
 FROM hostel_condition_records c JOIN hostel_properties p ON p.id=c.property_id JOIN hostel_bookings b ON b.id=c.booking_id
 JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id`;
async function own(actor:MaintenanceActor,id:string){await ensureHostelConditionTables();const s=scope(actor);const row=rowsToObjects(await turso(`${select} WHERE c.id=? AND ${s.sql}`,[id,s.value]))[0];if(!row)throw notFound();return row;}
function view(row:Row):ConditionRecord {
 const v=(k:string)=>String(row[k]||'');return {id:v('id'),reference:v('reference'),bookingId:v('booking_id'),bookingReference:v('booking_reference'),assignmentId:v('assignment_id'),propertyId:v('property_id'),propertyName:v('property_name'),studentName:v('student_name'),roomLabel:v('room_label'),spaceLabel:v('space_label'),status:v('status'),version:Number(row.version),checklist:JSON.parse(v('checklist_json')),moveInRevision:Number(row.move_in_revision),moveInAck:Number(row.move_in_ack),checkoutRevision:Number(row.checkout_revision),checkoutAck:Number(row.checkout_ack),disputeBy:v('dispute_by'),disputeNote:v('dispute_note'),archivedAt:v('archived_at'),closedAt:v('closed_at'),createdAt:v('created_at'),updatedAt:v('updated_at')};
}
function current(row:Row) {const today=new Date().toISOString().slice(0,10);return !row.archived_at && row.assignment_id===row.current_assignment && row.space_id===row.current_space && row.booking_status==='PAID' && ['EXPECTED','CHECKED_IN'].includes(String(row.stay_status)) && String(row.starts_on)<=today && String(row.ends_on)>=today;}
function actions(row:Row,actor:MaintenanceActor) {
 if(row.status==='CLOSED')return ['COMMENT',...(!row.dispute_by?['DISPUTE']:row.dispute_by===actor.kind?['WITHDRAW']:[])];
 const result:string[]=['COMMENT'];
 if(actor.kind==='STUDENT'&&current(row))result.push(Number(row.move_in_revision)?'AMEND':'SUBMIT');
 if(Number(row.move_in_revision)>0) {
  if(actor.kind==='STAFF') {if(Number(row.move_in_ack)!==Number(row.move_in_revision)||row.status==='CLARIFICATION_REQUESTED')result.push('ACKNOWLEDGE');result.push('CLARIFY');if(row.archived_at||['CHECKED_IN','CHECKED_OUT'].includes(String(row.stay_status)))result.push('CHECKOUT');}
  if(actor.kind==='STUDENT'&&Number(row.checkout_revision)>Number(row.checkout_ack))result.push('ACK_CHECKOUT');
  if(!row.dispute_by)result.push('DISPUTE');else if(row.dispute_by===actor.kind)result.push('WITHDRAW');
  if(actor.kind==='STAFF'&&row.status==='ACKNOWLEDGED'&&!row.dispute_by&&Number(row.move_in_ack)===Number(row.move_in_revision)&&Number(row.checkout_revision)>0&&Number(row.checkout_ack)===Number(row.checkout_revision)&&(row.archived_at||row.stay_status==='CHECKED_OUT'))result.push('CLOSE');
 }
 return result;
}
export async function conditionConfig(actor:MaintenanceActor,options:{reference?:string;propertyId?:string}):Promise<ConditionConfig> {
 await ensureHostelConditionTables();let propertyId=options.propertyId||'',eligible=actor.kind==='STAFF';
 if(actor.kind==='STUDENT'){const b=await getHostelBookingByReference(options.reference||'');if(!b||b.studentEmail.toLowerCase()!==actor.email.toLowerCase())throw notFound();propertyId=b.propertyId;const today=new Date().toISOString().slice(0,10);eligible=b.status==='PAID'&&['EXPECTED','CHECKED_IN'].includes(b.stayStatus)&&b.periodStartsOn<=today&&b.periodEndsOn>=today;}
 const row=rowsToObjects(await turso(`SELECT p.name,p.status,h.status AS host_status,s.enabled,s.checklist_json,s.version FROM hostel_properties p JOIN hostel_landlords h ON h.id=p.landlord_id LEFT JOIN hostel_condition_settings s ON s.property_id=p.id WHERE p.id=? ${actor.kind==='STAFF'?'AND p.landlord_id=?':''}`,actor.kind==='STAFF'?[propertyId,actor.landlordId]:[propertyId]))[0];if(!row)throw notFound();
 const platformEnabled=await platformSettingEnabled('hostel_conditions_enabled');return {propertyId,propertyName:String(row.name),enabled:Number(row.enabled)===1,platformEnabled,canCreate:eligible&&platformEnabled&&Number(row.enabled)===1&&row.host_status==='ACTIVE'&&row.status!=='SUSPENDED',version:Number(row.version||0),checklist:row.checklist_json?JSON.parse(String(row.checklist_json)):DEFAULT_CONDITION_CHECKLIST};
}
export async function saveConditionConfig(actor:MaintenanceActor,body:Record<string,unknown>) {
 if(actor.kind!=='STAFF'||!actor.isOwner)throw new CampusEngineError('FORBIDDEN','Only the property owner can configure condition checklists.',403);
 const propertyId=text(body.propertyId,100,1);await conditionConfig(actor,{propertyId});
 const checklist=body.checklist;if(!Array.isArray(checklist)||checklist.length<1||checklist.length>20||typeof body.enabled!=='boolean'||!Number.isInteger(body.version)||Number(body.version)<0)throw new CampusEngineError('VALIDATION_ERROR','Use 1–20 checklist items and valid settings.',400);
 const items:ChecklistItem[]=checklist.map((item,index)=>({key:`item-${index+1}`,label:text(typeof item==='string'?item:item?.label,60,2)}));
 if(new Set(items.map(item=>item.label.toLowerCase())).size!==items.length)throw new CampusEngineError('VALIDATION_ERROR','Checklist labels must be unique.',400);
 const stamp=new Date().toISOString();const [changed]=await tursoTransaction([
  {sql:`INSERT INTO hostel_condition_settings (property_id,enabled,checklist_json,version,updated_by,updated_at) SELECT ?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM hostel_properties p JOIN hostel_landlords h ON h.id=p.landlord_id WHERE p.id=? AND h.id=? AND lower(h.email)=? AND h.status='ACTIVE') AND (EXISTS(SELECT 1 FROM hostel_condition_settings WHERE property_id=?) OR ?=0)
   ON CONFLICT(property_id) DO UPDATE SET enabled=excluded.enabled,checklist_json=excluded.checklist_json,version=hostel_condition_settings.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE hostel_condition_settings.version=?`,args:[propertyId,body.enabled?1:0,JSON.stringify(items),actor.email,stamp,propertyId,actor.landlordId,actor.email.toLowerCase(),propertyId,Number(body.version),Number(body.version)]},
  {sql:`INSERT INTO admin_audit_logs (id,admin_email,action,target_type,target_reference,details,created_at) SELECT ?,?,'HOSTEL_CONDITION_SETTINGS','hostel_property',?,?,? WHERE changes()=1`,args:[crypto.randomUUID(),actor.email,propertyId,JSON.stringify({enabled:body.enabled,checklist:items}),stamp]},
 ]);if(Number(changed.affected_row_count)!==1)throw conflict();return conditionConfig(actor,{propertyId});
}
export async function startConditionRecord(actor:MaintenanceActor,body:Record<string,unknown>) {
 if(actor.kind!=='STUDENT')throw new CampusEngineError('FORBIDDEN','A student opens their own move-in record.',403);
 await ensureHostelConditionTables();const reference=text(body.reference,100,1),booking=await getHostelBookingByReference(reference);if(!booking||booking.studentEmail.toLowerCase()!==actor.email.toLowerCase())throw notFound();
 const stay=rowsToObjects(await turso('SELECT assignment_id FROM hostel_stays WHERE booking_id=?',[booking.id]))[0];const assignment=String(stay?.assignment_id||'initial');
 const existing=rowsToObjects(await turso('SELECT id FROM hostel_condition_records WHERE booking_id=? AND assignment_id=?',[booking.id,assignment]))[0];if(existing)return conditionDetail(actor,String(existing.id));
 const config=await conditionConfig(actor,{reference});if(!config.canCreate)throw new CampusEngineError('INVALID_STATE','New condition records require a current paid stay and both platform and property enablement.',409);
 const id=crypto.randomUUID(),stamp=new Date().toISOString();const [changed]=await tursoTransaction([
  {sql:`INSERT INTO hostel_condition_records (id,reference,booking_id,booking_reference,assignment_id,property_id,landlord_id,student_email,student_name,room_id,space_id,room_label,space_label,checklist_json,created_at,updated_at)
   SELECT ?,?,b.id,b.reference,st.assignment_id,b.property_id,b.landlord_id,lower(b.student_email),b.student_name,b.room_id,b.space_id,r.label,s.label,cs.checklist_json,?,?
   FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_spaces s ON s.id=b.space_id JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_properties p ON p.id=b.property_id JOIN hostel_landlords h ON h.id=b.landlord_id JOIN hostel_periods pe ON pe.id=b.period_id JOIN hostel_condition_settings cs ON cs.property_id=p.id
   WHERE b.id=? AND lower(b.student_email)=? AND st.assignment_id=? AND b.status='PAID' AND st.status IN ('EXPECTED','CHECKED_IN') AND pe.starts_on<=? AND pe.ends_on>=? AND h.status='ACTIVE' AND p.status<>'SUSPENDED' AND cs.enabled=1
   AND COALESCE((SELECT value FROM platform_settings WHERE key='hostel_conditions_enabled'),?)='1' ON CONFLICT(booking_id,assignment_id) DO NOTHING`,args:[id,'HC-'+id.replaceAll('-','').slice(0,12).toUpperCase(),stamp,stamp,booking.id,actor.email.toLowerCase(),assignment,stamp.slice(0,10),stamp.slice(0,10),config.platformEnabled?'1':'0']},
  {sql:`INSERT INTO hostel_condition_events (id,record_id,mutation_id,payload_hash,version,action,actor_type,actor_email,actor_name,note,created_at) SELECT ?,?,?,'',0,'START','STUDENT',?,?,'Move-in checklist opened.',? WHERE changes()=1`,args:[crypto.randomUUID(),id,crypto.randomUUID(),actor.email,actor.name,stamp]},
 ]);
 if(Number(changed.affected_row_count)!==1){const raced=rowsToObjects(await turso('SELECT id FROM hostel_condition_records WHERE booking_id=? AND assignment_id=?',[booking.id,assignment]))[0];if(!raced)throw conflict();return conditionDetail(actor,String(raced.id));}
 return conditionDetail(actor,id);
}
export async function listConditionRecords(actor:MaintenanceActor,options:{reference?:string;propertyId?:string;status?:string;q?:string;page?:number;disputed?:boolean}={}) {
 await ensureHostelConditionTables();const s=scope(actor),conditions=[s.sql],args:Array<string|number>=[s.value];let config:ConditionConfig|undefined;
 if(actor.kind==='STUDENT'&&options.reference){config=await conditionConfig(actor,{reference:options.reference});conditions.push('c.booking_reference=?');args.push(options.reference);}
 if(actor.kind==='STAFF'&&options.propertyId){conditions.push('c.property_id=?');args.push(options.propertyId);}
 if(options.status==='OPEN')conditions.push("c.status<>'CLOSED'");else if(['DRAFT','SUBMITTED','CLARIFICATION_REQUESTED','ACKNOWLEDGED','CLOSED'].includes(options.status||'')){conditions.push('c.status=?');args.push(options.status!);}
 if(options.disputed)conditions.push("c.dispute_by<>''");if(options.q){conditions.push("instr(lower(c.reference||' '||c.student_name||' '||c.room_label),lower(?))>0");args.push(options.q.slice(0,100));}
 const where=conditions.join(' AND '),count=rowsToObjects(await turso(`SELECT COUNT(*) n FROM hostel_condition_records c WHERE ${where}`,args));const total=Number(count[0]?.n||0),pages=Math.max(1,Math.ceil(total/20)),page=Math.max(1,Math.min(pages,Math.floor(Number(options.page)||1)));
 return {records:rowsToObjects(await turso(`${select} WHERE ${where} ORDER BY c.updated_at DESC,c.id DESC LIMIT 20 OFFSET ?`,[...args,(page-1)*20])).map(view),pagination:{page,pages,total},config,isOwner:actor.kind==='STAFF'&&actor.isOwner};
}
export async function conditionDetail(actor:MaintenanceActor,id:string):Promise<ConditionDetail> {
 const row=await own(actor,id);const [events,revisions,photos]=await Promise.all([
  turso('SELECT * FROM hostel_condition_events WHERE record_id=? ORDER BY version DESC',[id]),
  turso('SELECT * FROM hostel_condition_revisions WHERE record_id=? ORDER BY revision DESC',[id]),
  turso('SELECT * FROM hostel_condition_photos WHERE record_id=? ORDER BY created_at,id',[id]),
 ]);
 return {record:view(row),actions:actions(row,actor),events:rowsToObjects(events).map(e=>({id:String(e.id),version:Number(e.version),action:String(e.action),actorType:String(e.actor_type),actorName:String(e.actor_name),note:String(e.note),createdAt:String(e.created_at)})),revisions:rowsToObjects(revisions).map(r=>({id:String(r.id),eventId:String(r.event_id),phase:String(r.phase),revision:Number(r.revision),items:JSON.parse(String(r.items_json)),authorType:String(r.author_type),authorName:String(r.author_name),createdAt:String(r.created_at)})),photos:await Promise.all(rowsToObjects(photos).map(async p=>({id:String(p.id),eventId:String(p.event_id),itemKey:String(p.item_key),name:String(p.file_name),url:await maintenancePhotoUrl(actor,String(p.id),'conditions')})))};
}
function validatedItems(input:unknown,checklist:ChecklistItem[]):ConditionItem[] {
 if(!Array.isArray(input)||input.length!==checklist.length)throw new CampusEngineError('VALIDATION_ERROR','Complete every checklist item, including anything not checked.',400);
 return checklist.map(item=>{const matches=input.filter(i=>i?.key===item.key);if(matches.length!==1||!(CONDITION_VALUES as readonly string[]).includes(matches[0].condition))throw new CampusEngineError('VALIDATION_ERROR',`Choose a condition for ${item.label}.`,400);const condition=matches[0].condition,note=text(matches[0].note,300,['WORN','DAMAGED','MISSING','NOT_CHECKED'].includes(condition)?5:0);return {...item,condition,note};});
}
function notices(id:string,eventId:string,stamp:string):ConditionStatement[] {
 return [false,true].map(staff=>({sql:`INSERT INTO notification_outbox (id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at)
 SELECT ?,'email',${staff?'h.email':'c.student_email'},?,'Condition record · '||c.reference,'A condition record was updated. Open your hostel condition records to review it.',?,'PENDING',0,'',?,?
 FROM hostel_condition_records c JOIN hostel_landlords h ON h.id=c.landlord_id WHERE c.id=? AND EXISTS(SELECT 1 FROM hostel_condition_events WHERE id=? AND record_id=c.id) ON CONFLICT(reference,template) DO NOTHING`,args:[crypto.randomUUID(),staff?'hostel_condition_staff':'hostel_condition_student',`${id}:${eventId}`,stamp,stamp,id,eventId]}));
}
export async function updateConditionRecord(actor:MaintenanceActor,id:string,body:Record<string,unknown>,files:MaintenanceUpload[]=[],bucket?:PhotoBucket) {
 const row=await own(actor,id),mutation=key(body.mutationId),action=text(body.action,30,1),note=text(body.note,1500),version=Number(body.version);validateMaintenancePhotos(files);
 const checklist:ChecklistItem[]=JSON.parse(String(row.checklist_json));const revisionAction=['SUBMIT','AMEND','CHECKOUT'].includes(action);
 const items=revisionAction?validatedItems(body.items,checklist):[];
 const photoItems=Array.isArray(body.photoItems)?body.photoItems:[];
 if(files.length&&(photoItems.length!==files.length||photoItems.some(value=>typeof value!=='string'||value!==''&&!checklist.some(item=>item.key===value))))throw new CampusEngineError('VALIDATION_ERROR','Choose the checklist item or whole room for each photo.',400);
 if(files.length&&!['SUBMIT','AMEND','CHECKOUT','COMMENT','DISPUTE'].includes(action))throw new CampusEngineError('VALIDATION_ERROR','Attach evidence with an inspection, note or disagreement.',400);
 const hash=await maintenanceHash(JSON.stringify([action,note,items,photoItems,await Promise.all(files.map(async f=>({name:f.name,type:f.type,hash:await maintenanceHash(f.body)})))]));
 const previous=rowsToObjects(await turso('SELECT payload_hash FROM hostel_condition_events WHERE record_id=? AND mutation_id=?',[id,mutation]))[0];if(previous){if(previous.payload_hash!==hash)throw conflict();return conditionDetail(actor,id);}
 if(!Number.isInteger(version)||version!==Number(row.version))throw conflict();if(!actions(row,actor).includes(action))throw new CampusEngineError('INVALID_STATE','That action is not available for this record.',409);
 if(['AMEND','CLARIFY','CHECKOUT','COMMENT','DISPUTE','WITHDRAW','CLOSE'].includes(action)&&note.length<5)throw new CampusEngineError('VALIDATION_ERROR','Add an explanation of at least five characters.',400);
 const stamp=new Date().toISOString(),eventId=crypto.randomUUID(),next=version+1,phase=action==='CHECKOUT'?'CHECKOUT':'MOVE_IN';
 const number=revisionAction?Number(row[action==='CHECKOUT'?'checkout_revision':'move_in_revision'])+1:0;
 const staged=await stageMaintenancePhotos(id,files,bucket,'conditions'),s=scope(actor);
 let status=String(row.status);if(['SUBMIT','AMEND'].includes(action))status='SUBMITTED';if(action==='ACKNOWLEDGE')status='ACKNOWLEDGED';if(action==='CLARIFY')status='CLARIFICATION_REQUESTED';if(action==='CLOSE')status='CLOSED';if(action==='DISPUTE'&&row.status==='CLOSED')status='ACKNOWLEDGED';
 try {
  const [changed]=await tursoTransaction([
   {sql:`UPDATE hostel_condition_records AS c SET status=?,version=version+1,updated_at=?,
    move_in_revision=CASE WHEN ? IN ('SUBMIT','AMEND') THEN ? ELSE move_in_revision END,
    checkout_revision=CASE WHEN ?='CHECKOUT' THEN ? ELSE checkout_revision END,
    move_in_ack=CASE WHEN ?='ACKNOWLEDGE' THEN move_in_revision ELSE move_in_ack END,
    checkout_ack=CASE WHEN ?='ACK_CHECKOUT' THEN checkout_revision ELSE checkout_ack END,
    dispute_by=CASE WHEN ?='DISPUTE' THEN ? WHEN ?='WITHDRAW' THEN '' ELSE dispute_by END,
    dispute_note=CASE WHEN ?='DISPUTE' THEN ? WHEN ?='WITHDRAW' THEN '' ELSE dispute_note END,
    closed_at=CASE WHEN ?='CLOSE' THEN ? WHEN ?='DISPUTE' THEN '' ELSE closed_at END
    WHERE c.id=? AND c.version=? AND ${s.sql}
    AND (SELECT COUNT(*) FROM hostel_condition_photos WHERE record_id=c.id)+?<=30
    ${['SUBMIT','AMEND'].includes(action)?`AND c.archived_at='' AND EXISTS(SELECT 1 FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id WHERE b.id=c.booking_id AND b.space_id=c.space_id AND st.assignment_id=c.assignment_id AND b.status='PAID' AND st.status IN ('EXPECTED','CHECKED_IN') AND pe.starts_on<=? AND pe.ends_on>=?)`:''}`,
    args:[status,stamp,action,number,action,number,action,action,action,actor.kind,action,action,note,action,action,stamp,action,id,version,s.value,staged.length,...(['SUBMIT','AMEND'].includes(action)?[stamp.slice(0,10),stamp.slice(0,10)]:[])]},
   {sql:`INSERT INTO hostel_condition_events (id,record_id,mutation_id,payload_hash,version,action,actor_type,actor_email,actor_name,note,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`,args:[eventId,id,mutation,hash,next,action,actor.kind,actor.email,actor.name,note,stamp]},
   ...(revisionAction?[{sql:`INSERT INTO hostel_condition_revisions (id,record_id,event_id,phase,revision,items_json,author_type,author_name,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hostel_condition_events WHERE id=?)`,args:[crypto.randomUUID(),id,eventId,phase,number,JSON.stringify(items),actor.kind,actor.name,stamp,eventId]}]:[]),
   ...staged.map((file,index)=>({sql:`INSERT INTO hostel_condition_photos (id,record_id,event_id,item_key,object_key,content_type,bytes,file_name,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hostel_condition_events WHERE id=?)`,args:[file.id,id,eventId,String(photoItems[index]||''),file.objectKey,file.type,file.bytes,file.name,stamp,eventId]})),
   ...notices(id,eventId,stamp),
  ]);
  if(Number(changed.affected_row_count)!==1){await discardMaintenancePhotos(staged,bucket);const retry=rowsToObjects(await turso('SELECT payload_hash FROM hostel_condition_events WHERE record_id=? AND mutation_id=?',[id,mutation]))[0];if(retry?.payload_hash===hash)return conditionDetail(actor,id);throw new CampusEngineError('CONFLICT','The record changed or reached its 30-photo limit. Refresh before retrying.',409);}
 }catch(error){try{const committed=rowsToObjects(await turso('SELECT id FROM hostel_condition_events WHERE id=?',[eventId]));if(!committed.length)await discardMaintenancePhotos(staged,bucket);}catch{/* Preserve possible committed evidence if commit status is unknown. */}throw error;}
 return conditionDetail(actor,id);
}
export async function readConditionPhoto(actor:MaintenanceActor,id:string,token:string,bucket?:PhotoBucket) {
 await ensureHostelConditionTables();if(!await verifyMaintenancePhotoToken(actor,id,token,'conditions'))throw new CampusEngineError('FORBIDDEN','Refresh the record to renew this private photo link.',403);
 const s=scope(actor),row=rowsToObjects(await turso(`SELECT f.object_key,f.content_type FROM hostel_condition_photos f JOIN hostel_condition_records c ON c.id=f.record_id WHERE f.id=? AND ${s.sql}`,[id,s.value]))[0];if(!row)throw notFound();const object=await(await maintenanceBucket(bucket)).get(String(row.object_key));if(!object?.body)throw notFound();return new Response(object.body,{headers:{'Content-Type':String(row.content_type),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
}
export async function exportConditionRecord(actor:MaintenanceActor,id:string,format:'text'|'json'='text') {
 const detail=await conditionDetail(actor,id),record=detail.record;
 const notice='Acknowledgment records receipt, not agreement. This record does not create charges or refunds.';
 const report={exportedAt:new Date().toISOString(),notice,...detail,actions:undefined,photos:detail.photos.map(({id,eventId,itemKey,name})=>({id,eventId,itemKey,name}))};
 const lines=['HOSTEL ROOM CONDITION RECORD',record.reference,`${record.propertyName} · ${record.roomLabel} · ${record.spaceLabel}`,`Resident: ${record.studentName}`,`Booking: ${record.bookingReference}`,`Exported: ${report.exportedAt}`,`Status: ${CONDITION_LABELS[record.status]} · record version ${record.version}`,notice,
  `Open disagreement: ${record.disputeBy ? record.disputeBy+' — '+record.disputeNote : 'None recorded'}`,
  `Move-in receipt: revision ${record.moveInAck} of ${record.moveInRevision}. Checkout receipt: revision ${record.checkoutAck} of ${record.checkoutRevision}.`,
  record.archivedAt?'Previous room; transferred at '+record.archivedAt:'',
  '', 'INSPECTION VERSIONS (original evidence retained)',
  ...detail.revisions.flatMap(revision=>['',`${revision.phase==='MOVE_IN'?'MOVE-IN':'CHECKOUT'} · revision ${revision.revision} · ${revision.createdAt}`,`Recorded by: ${revision.authorName} (${revision.authorType})`,...revision.items.map(item=>`${item.label}: ${CONDITION_LABELS[item.condition]}${item.note?' — '+item.note:''}`)]),
  '', 'ACTIVITY (most recent first)',...detail.events.flatMap(event=>[`v${event.version} · ${event.createdAt} · ${CONDITION_LABELS[event.action]||event.action} · ${event.actorName} (${event.actorType})`,event.note]),
  '', 'PRIVATE PHOTO REFERENCES',...detail.photos.map(photo=>`${photo.name} · ${record.checklist.find(item=>item.key===photo.itemKey)?.label||'Whole room'} · event ${photo.eventId}`),
  'Open the authenticated condition record to view photos. Downloaded summaries are private; store and share them carefully.'];
 return new Response(format==='json'?JSON.stringify(report,null,2):lines.join('\n'),{headers:{'Content-Type':format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${record.reference}.${format==='json'?'json':'txt'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}

/** Called after the stay audit insert, inside the SAME occupancy transaction. */
export function conditionTransferStatements(input:{bookingId:string;previousAssignment:string;eventId:string;actor:string;stamp:string}):ConditionStatement[] {
 const {bookingId,previousAssignment,eventId,actor,stamp}=input,id='hc-'+eventId;
 return [
  {sql:`UPDATE hostel_condition_records SET archived_at=?,updated_at=?,version=version+1 WHERE booking_id=? AND assignment_id=? AND EXISTS(SELECT 1 FROM hostel_stay_events WHERE id=? AND action='TRANSFER')`,args:[stamp,stamp,bookingId,previousAssignment,eventId]},
  {sql:`INSERT INTO hostel_condition_events (id,record_id,mutation_id,payload_hash,version,action,actor_type,actor_email,actor_name,note,created_at)
   SELECT ?,id,?,'',version,'TRANSFER','STAFF',?,?,'Resident transferred. Original room evidence retained.',? FROM hostel_condition_records WHERE booking_id=? AND assignment_id=? AND EXISTS(SELECT 1 FROM hostel_stay_events WHERE id=?)`,args:[crypto.randomUUID(),eventId,actor,actor,stamp,bookingId,previousAssignment,eventId]},
  {sql:`INSERT INTO hostel_condition_records (id,reference,booking_id,booking_reference,assignment_id,property_id,landlord_id,student_email,student_name,room_id,space_id,room_label,space_label,checklist_json,created_at,updated_at)
   SELECT ?,?,b.id,b.reference,st.assignment_id,b.property_id,b.landlord_id,lower(b.student_email),b.student_name,r.id,s.id,r.label,s.label,COALESCE(cs.checklist_json,old.checklist_json),?,?
   FROM hostel_condition_records old JOIN hostel_bookings b ON b.id=old.booking_id JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_spaces s ON s.id=b.space_id JOIN hostel_rooms r ON r.id=s.room_id LEFT JOIN hostel_condition_settings cs ON cs.property_id=b.property_id
   WHERE old.booking_id=? AND old.assignment_id=? AND EXISTS(SELECT 1 FROM hostel_stay_events WHERE id=?) ON CONFLICT(booking_id,assignment_id) DO NOTHING`,args:[id,'HC-'+eventId.replaceAll('-','').slice(0,12).toUpperCase(),stamp,stamp,bookingId,previousAssignment,eventId]},
  {sql:`INSERT INTO hostel_condition_events (id,record_id,mutation_id,payload_hash,version,action,actor_type,actor_email,actor_name,note,created_at) SELECT ?,?,?, '',0,'TRANSFER','STAFF',?,?,'New room checklist opened after transfer.',? WHERE EXISTS(SELECT 1 FROM hostel_condition_records WHERE id=?)`,args:[crypto.randomUUID(),id,eventId,actor,actor,stamp,id]},
 ];
}
