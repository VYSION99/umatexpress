import { CampusEngineError } from '@/lib/campus-engine/errors';
import { platformSettingEnabled } from '@/lib/platform-settings';
import { rowsToObjects, turso, tursoTransaction } from '@/lib/turso';
import { getHostelBookingByReference } from './residency';
import { ensureHostelMaintenanceTables } from './maintenance-schema';
import { MAINTENANCE_CATEGORIES, MAINTENANCE_STATUSES, maintenanceActions, type MaintenanceAction, type MaintenanceConfig, type MaintenanceDetail, type MaintenanceRequest, type MaintenanceStatus } from './maintenance-types';
import { discardMaintenancePhotos, maintenanceBucket, maintenanceHash, maintenancePhotoUrl, stageMaintenancePhotos, validateMaintenancePhotos, verifyMaintenancePhotoToken, type MaintenanceActor, type MaintenanceUpload, type StagedMaintenanceFile } from './maintenance-files';
import type { PhotoBucket } from './photos';

type Row = Record<string, unknown>;
type Statement = { sql: string; args: Array<string | number | null> };
const JOIN = 'FROM hostel_maintenance_requests t LEFT JOIN hostel_properties p ON p.id=t.property_id';
const select = 'SELECT t.*,COALESCE(p.name,\'\') AS property_name ' + JOIN;
const missing = () => new CampusEngineError('NOT_FOUND', 'That maintenance report was not found.', 404);
const conflict = () => new CampusEngineError('CONFLICT', 'This report changed elsewhere. Refresh its details before trying again.', 409);
function clean(value: unknown, max: number, label: string, min = 0) {
 if (value !== undefined && typeof value !== 'string') throw new CampusEngineError('VALIDATION_ERROR', `Check ${label.toLowerCase()}.`, 400);
 const text = String(value ?? '').trim();
 if (text.length < min || text.length > max) throw new CampusEngineError('VALIDATION_ERROR', `${label} must contain ${min || 1}–${max} characters.`, 400);
 return text;
}
function choice(value: unknown, allowed: readonly string[], label: string) {
 const result = String(value || '');
 if (!allowed.includes(result)) throw new CampusEngineError('VALIDATION_ERROR', `Choose ${label}.`, 400);
 return result;
}
function requestKey(value: unknown) {
 const key = String(value || '');
 if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key)) throw new CampusEngineError('VALIDATION_ERROR', 'Refresh this form before sending it.', 400);
 return key.toLowerCase();
}
function scope(actor: MaintenanceActor) {
 return actor.kind === 'STAFF' ? { sql: 't.landlord_id=?', value: actor.landlordId } : { sql: 't.student_email=?', value: actor.email.toLowerCase() };
}
async function ownedTicket(actor: MaintenanceActor, id: string) {
 await ensureHostelMaintenanceTables();
 const own = scope(actor);
 const row = rowsToObjects(await turso(`${select} WHERE t.id=? AND ${own.sql}`, [id, own.value]))[0];
 if (!row) throw missing();
 return row;
}
function requestView(row: Row, actor: MaintenanceActor): MaintenanceRequest {
 const value = (key: string) => String(row[key] || '');
 return {
  id: value('id'), reference: value('reference'), bookingId: value('booking_id'), propertyId: value('property_id'), propertyName: value('property_name'),
  studentName: value('student_name'), studentEmail: value('student_email'), roomLabel: value('room_label'), spaceLabel: value('space_label'),
  category: value('category'), urgency: value('urgency'), locationType: value('location_type'), locationDetail: value('location_detail'), title: value('title'), description: value('description'),
  entryPermission: value('entry_permission'), preferredAccess: value('preferred_access'), status: value('status') as MaintenanceStatus,
  assigneeEmail: actor.kind === 'STAFF' ? value('assignee_email') : '', assigneeName: value('assignee_name'), version: Number(row.version),
  acknowledgementDueAt: value('acknowledgement_due_at'), acknowledgedAt: value('acknowledged_at'), resolvedAt: value('resolved_at'), escalatedAt: value('escalated_at'),
  createdAt: value('created_at'), updatedAt: value('updated_at'), overdue: row.status === 'SUBMITTED' && value('acknowledgement_due_at') < new Date().toISOString(),
 };
}

export async function maintenanceConfig(actor: MaintenanceActor, options: { reference?: string; propertyId?: string }): Promise<MaintenanceConfig> {
 await ensureHostelMaintenanceTables();
 let propertyId = options.propertyId || '', eligible = actor.kind === 'STAFF';
 if (actor.kind === 'STUDENT') {
  const booking = await getHostelBookingByReference(options.reference || '');
  if (!booking || booking.studentEmail.toLowerCase() !== actor.email.toLowerCase()) throw missing();
  propertyId = booking.propertyId;
  const today = new Date().toISOString().slice(0,10);
  eligible = booking.status === 'PAID' && ['EXPECTED','CHECKED_IN'].includes(booking.stayStatus) && booking.periodStartsOn <= today && booking.periodEndsOn >= today;
 }
 const row = rowsToObjects(await turso(`SELECT p.id,p.name,p.status AS property_status,h.status AS host_status,h.phone,h.kyc_status,o.profile_status,
   COALESCE(s.enabled,0) AS enabled,COALESCE(s.service_hours,'') AS service_hours,COALESCE(s.acknowledgement_hours,24) AS acknowledgement_hours,COALESCE(s.version,0) AS version
   FROM hostel_properties p JOIN hostel_landlords h ON h.id=p.landlord_id LEFT JOIN hostel_owner_onboarding o ON o.landlord_id=h.id
   LEFT JOIN hostel_maintenance_settings s ON s.property_id=p.id WHERE p.id=? ${actor.kind === 'STAFF' ? 'AND p.landlord_id=?' : ''}`,
   actor.kind === 'STAFF' ? [propertyId, actor.landlordId] : [propertyId]))[0];
 if (!row) throw missing();
 const platformEnabled = await platformSettingEnabled('hostel_maintenance_enabled');
 const reviewed = row.kyc_status === 'VERIFIED' && row.profile_status === 'APPROVED';
 return {
  propertyId, propertyName: String(row.name), enabled: Number(row.enabled) === 1, platformEnabled,
  canCreate: eligible && platformEnabled && Number(row.enabled) === 1 && row.host_status === 'ACTIVE' && row.property_status !== 'SUSPENDED',
  serviceHours: String(row.service_hours), acknowledgementHours: Number(row.acknowledgement_hours), urgentContact: reviewed ? String(row.phone || '') : '', contactReviewed: reviewed,
  version: Number(row.version),
 };
}
export async function saveMaintenanceConfig(actor: MaintenanceActor, body: Record<string, unknown>) {
 if (actor.kind !== 'STAFF' || !actor.isOwner) throw new CampusEngineError('FORBIDDEN', 'Only the property owner can change maintenance settings.', 403);
 const propertyId = clean(body.propertyId,100,'Property',1);
 await maintenanceConfig(actor,{propertyId});
 const hours = clean(body.serviceHours,240,'Service hours');
 const acknowledgement = Number(body.acknowledgementHours), version = Number(body.version);
 if (!Number.isInteger(version) || version < 0 || !Number.isInteger(acknowledgement) || acknowledgement < 1 || acknowledgement > 168 || typeof body.enabled !== 'boolean') throw new CampusEngineError('VALIDATION_ERROR','Choose a response target from 1 to 168 hours and valid settings.',400);
 if (body.enabled && !hours) throw new CampusEngineError('VALIDATION_ERROR','Add service hours before enabling reports for this property.',400);
 const stamp = new Date().toISOString();
 const [changed] = await tursoTransaction([
  {sql:`INSERT INTO hostel_maintenance_settings (property_id,enabled,service_hours,acknowledgement_hours,version,updated_by,updated_at)
   SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM hostel_properties p JOIN hostel_landlords h ON h.id=p.landlord_id WHERE p.id=? AND h.id=? AND lower(h.email)=? AND h.status='ACTIVE')
   AND (EXISTS (SELECT 1 FROM hostel_maintenance_settings WHERE property_id=?) OR ?=0)
   ON CONFLICT(property_id) DO UPDATE SET enabled=excluded.enabled,service_hours=excluded.service_hours,acknowledgement_hours=excluded.acknowledgement_hours,
   version=hostel_maintenance_settings.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE hostel_maintenance_settings.version=?`,
   args:[propertyId,body.enabled?1:0,hours,acknowledgement,1,actor.email,stamp,propertyId,actor.landlordId,actor.email.toLowerCase(),propertyId,version,version]},
  {sql:`INSERT INTO admin_audit_logs (id,admin_email,action,target_type,target_reference,details,created_at) SELECT ?,?,'HOSTEL_MAINTENANCE_SETTINGS','hostel_property',?,?,? WHERE changes()=1`,
   args:[crypto.randomUUID(),actor.email,propertyId,JSON.stringify({enabled:body.enabled,serviceHours:hours,acknowledgementHours:acknowledgement}),stamp]},
 ]);
 if (Number(changed.affected_row_count)!==1) throw conflict();
 return maintenanceConfig(actor,{propertyId});
}
export async function maintenanceAssignees(actor: MaintenanceActor) {
 if (actor.kind !== 'STAFF') throw new CampusEngineError('FORBIDDEN','Staff access is required.',403);
 await ensureHostelMaintenanceTables();
 return rowsToObjects(await turso(`SELECT lower(a.email) AS email,a.name FROM console_accounts a JOIN hostel_landlords h ON h.id=a.profile_id
  WHERE a.role='LANDLORD' AND a.status='ACTIVE' AND h.status='ACTIVE' AND h.id=?
  AND (lower(a.email)=lower(h.email) OR EXISTS (SELECT 1 FROM hostel_managers m WHERE m.landlord_id=h.id AND lower(m.email)=lower(a.email) AND m.status='ACTIVE'))
  ORDER BY a.name COLLATE NOCASE`,[actor.landlordId])).map(row=>({email:String(row.email),name:String(row.name)}));
}
function attachmentStatements(files: StagedMaintenanceFile[], id: string, eventId: string, mutation: string, stamp: string): Statement[] {
 return files.map(file=>({sql:`INSERT INTO hostel_maintenance_attachments (id,request_id,event_id,object_key,content_type,bytes,file_name,created_at)
  SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM hostel_maintenance_events WHERE request_id=? AND mutation_id=? AND id=?)`,
  args:[file.id,id,eventId,file.objectKey,file.type,file.bytes,file.name,stamp,id,mutation,eventId]}));
}
function eventStatement(input: {id: string; eventId: string; mutation: string; actor: MaintenanceActor; action: string; previous: string; status: string; note: string; details: Record<string, unknown>; stamp: string}): Statement {
 return {sql:`INSERT INTO hostel_maintenance_events (id,request_id,mutation_id,actor_type,actor_email,actor_name,action,previous_status,status,note,details,created_at)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1 ON CONFLICT(request_id,mutation_id) DO NOTHING`,
 args:[input.eventId,input.id,input.mutation,input.actor.kind,input.actor.email,input.actor.name,input.action,input.previous,input.status,input.note,JSON.stringify(input.details),input.stamp]};
}
function notificationStatements(id: string, mutation: string, stamp: string, action: string): Statement[] {
 // Queue in the same transaction as the report. The existing outbox cron retries delivery.
 const text = action === 'SUBMIT' ? 'A maintenance report has been submitted.' : 'There is an update to a maintenance report.';
 return [false,true].map(staff=>({sql:`INSERT INTO notification_outbox (id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at)
  SELECT ?,'email',${staff ? `CASE WHEN ?='ESCALATE' OR t.assignee_email='' OR NOT EXISTS (
    SELECT 1 FROM console_accounts a WHERE lower(a.email)=t.assignee_email AND a.profile_id=t.landlord_id AND a.role='LANDLORD' AND a.status='ACTIVE'
    AND (lower(a.email)=lower(h.email) OR EXISTS (SELECT 1 FROM hostel_managers m WHERE m.landlord_id=t.landlord_id AND lower(m.email)=lower(a.email) AND m.status='ACTIVE'))
   ) THEN h.email ELSE t.assignee_email END` : 't.student_email'},?,
  'Maintenance · ' || t.reference,? || ' ' || t.reference || ': ' || t.status || '. Open ' || ? || ' to view the report.',?,'PENDING',0,'',?,?
  FROM hostel_maintenance_requests t JOIN hostel_landlords h ON h.id=t.landlord_id
  WHERE t.id=? AND EXISTS (SELECT 1 FROM hostel_maintenance_events WHERE request_id=t.id AND mutation_id=?)
  ON CONFLICT(reference,template) DO NOTHING`,
 args:[crypto.randomUUID(),...(staff?[action]:[]),staff?'hostel_maintenance_staff':'hostel_maintenance_student',text,staff?'Residents & services → Maintenance':'your residency → Requests',`${id}:${mutation}`,stamp,stamp,id,mutation]}));
}
async function preserveCommittedPhotosOrDiscard(id: string, mutation: string, files: StagedMaintenanceFile[], bucket?: PhotoBucket) {
 try {
  const committed=rowsToObjects(await turso('SELECT id FROM hostel_maintenance_events WHERE request_id=? AND mutation_id=?',[id,mutation])).length;
  if (!committed) await discardMaintenancePhotos(files,bucket);
 } catch { /* Uncertain commit: preserve blobs rather than deleting evidence referenced by a committed report. */ }
}
export async function createMaintenanceRequest(actor: MaintenanceActor, body: Record<string, unknown>, files: MaintenanceUpload[] = [], bucket?: PhotoBucket) {
 if (actor.kind !== 'STUDENT') throw new CampusEngineError('FORBIDDEN','A student account is required to report a problem.',403);
 await ensureHostelMaintenanceTables();
 validateMaintenancePhotos(files);
 const key=requestKey(body.clientRequestId), email=actor.email.toLowerCase();
 const data={reference:clean(body.reference,100,'Booking reference',1),category:choice(body.category,MAINTENANCE_CATEGORIES,'a problem category'),
  urgency:choice(body.urgency,['ROUTINE','URGENT'],'an urgency'),locationType:choice(body.locationType,['ROOM','SHARED'],'a location'),locationDetail:clean(body.locationDetail,160,'Location details',2),
  title:clean(body.title,120,'Short description',5),description:clean(body.description,2000,'Problem details',10),
  entryPermission:choice(body.entryPermission,['PRESENT_ONLY','ARRANGE_FIRST','PERMITTED'],'an access preference'),preferredAccess:clean(body.preferredAccess,160,'Preferred access times')};
 const hash=await maintenanceHash(JSON.stringify([data,await Promise.all(files.map(async file=>({type:file.type,name:file.name,hash:await maintenanceHash(file.body)})))]));
 const existing=rowsToObjects(await turso('SELECT id,payload_hash FROM hostel_maintenance_requests WHERE student_email=? AND client_request_id=?',[email,key]))[0];
 if (existing) {
  if (existing.payload_hash!==hash) throw new CampusEngineError('CONFLICT','This draft was already submitted with different details. Open the existing report before making changes.',409);
  return maintenanceDetail(actor,String(existing.id));
 }
 const config=await maintenanceConfig(actor,{reference:data.reference});
 if (!config.canCreate) throw new CampusEngineError('INVALID_STATE','New maintenance reports require a current paid stay and maintenance enabled by the platform and property owner.',409);
 const booking=await getHostelBookingByReference(data.reference);
 if (!booking) throw missing();
 const id=crypto.randomUUID(), mutation=crypto.randomUUID(), eventId=crypto.randomUUID(), stamp=new Date().toISOString();
 const due=new Date(Date.now()+config.acknowledgementHours*3600000).toISOString();
 const row: Record<string,string|number>={id,reference:'MT-'+id.replaceAll('-','').slice(0,12).toUpperCase(),booking_id:booking.id,property_id:booking.propertyId,landlord_id:booking.landlordId,
  student_email:email,student_name:actor.name,room_label:booking.roomLabel,space_label:booking.spaceLabel,category:data.category,urgency:data.urgency,location_type:data.locationType,location_detail:data.locationDetail,
  title:data.title,description:data.description,entry_permission:data.entryPermission,preferred_access:data.preferredAccess,client_request_id:key,payload_hash:hash,mutation_id:mutation,acknowledgement_due_at:due,created_at:stamp,updated_at:stamp};
 const staged=await stageMaintenancePhotos(id,files,bucket);
 try {
  const [inserted]=await tursoTransaction([
   {sql:`INSERT INTO hostel_maintenance_requests (${Object.keys(row).join(',')}) SELECT ${Object.keys(row).map(()=>'?').join(',')}
    WHERE EXISTS (SELECT 1 FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id
      JOIN hostel_properties p ON p.id=b.property_id JOIN hostel_landlords h ON h.id=b.landlord_id JOIN hostel_maintenance_settings s ON s.property_id=p.id
      WHERE b.id=? AND b.student_email=? AND b.status='PAID' AND st.status IN ('EXPECTED','CHECKED_IN') AND pe.starts_on<=? AND pe.ends_on>=?
      AND b.space_id=? AND b.property_id=? AND h.status='ACTIVE' AND p.status<>'SUSPENDED' AND s.enabled=1)
    AND COALESCE((SELECT value FROM platform_settings WHERE key='hostel_maintenance_enabled'),?)='1'
    ON CONFLICT(student_email,client_request_id) DO NOTHING`,
    args:[...Object.values(row),booking.id,email,stamp.slice(0,10),stamp.slice(0,10),booking.spaceId,booking.propertyId,config.platformEnabled?'1':'0']},
   eventStatement({id,eventId,mutation,actor,action:'SUBMIT',previous:'',status:'SUBMITTED',note:data.description,details:{photos:staged.map(file=>file.id)},stamp}),
   ...attachmentStatements(staged,id,eventId,mutation,stamp),...notificationStatements(id,mutation,stamp,'SUBMIT'),
  ]);
  if (Number(inserted.affected_row_count)!==1) {
   await discardMaintenancePhotos(staged,bucket);
   const raced=rowsToObjects(await turso('SELECT id,payload_hash FROM hostel_maintenance_requests WHERE student_email=? AND client_request_id=?',[email,key]))[0];
   if (raced?.payload_hash===hash) return maintenanceDetail(actor,String(raced.id));
   throw new CampusEngineError('CONFLICT','The stay, property settings, or submitted draft changed. Refresh and review before trying again.',409);
  }
 } catch(error) {await preserveCommittedPhotosOrDiscard(id,mutation,staged,bucket);throw error;}
 return maintenanceDetail(actor,id);
}

export async function maintenanceDetail(actor: MaintenanceActor, id: string): Promise<MaintenanceDetail> {
 const row=await ownedTicket(actor,id);
 const [events,files]=await Promise.all([
  turso('SELECT * FROM hostel_maintenance_events WHERE request_id=? ORDER BY created_at DESC,id DESC LIMIT 100',[id]),
  turso('SELECT id,event_id,file_name,bytes,content_type FROM hostel_maintenance_attachments WHERE request_id=? ORDER BY created_at,id',[id]),
 ]);
 return {ticket:requestView(row,actor),actions:maintenanceActions(row.status as MaintenanceStatus,actor.kind==='STAFF',Boolean(row.escalated_at)),
  events:rowsToObjects(events).map(event=>{let details:Record<string,unknown>={};try{details=JSON.parse(String(event.details));}catch{/* Tolerate older entries. */}
   return {id:String(event.id),action:String(event.action),actorType:String(event.actor_type),actorName:String(event.actor_name),status:String(event.status),previousStatus:String(event.previous_status),note:String(event.note),createdAt:String(event.created_at),details:{assigneeName:typeof details.assigneeName==='string'?details.assigneeName:undefined}};}),
  files:await Promise.all(rowsToObjects(files).map(async file=>({id:String(file.id),eventId:String(file.event_id),name:String(file.file_name),bytes:Number(file.bytes),contentType:String(file.content_type),url:await maintenancePhotoUrl(actor,String(file.id))}))),
 };
}
export async function listMaintenanceRequests(actor: MaintenanceActor, options: {reference?:string;propertyId?:string;status?:string;category?:string;urgency?:string;assignee?:string;search?:string;page?:number;overdue?:boolean;escalated?:boolean}={}) {
 await ensureHostelMaintenanceTables();
 const own=scope(actor), conditions=[own.sql], args:Array<string|number>=[own.value], stamp=new Date().toISOString();
 let config:MaintenanceConfig|undefined;
 if (actor.kind==='STUDENT' && options.reference) {
  config=await maintenanceConfig(actor,{reference:options.reference});
  const booking=await getHostelBookingByReference(options.reference);
  conditions.push('t.booking_id=?');args.push(booking!.id);
 }
 if (options.propertyId && actor.kind==='STAFF') {conditions.push('t.property_id=?');args.push(options.propertyId);}
 const base=conditions.join(' AND '),baseArgs=[...args];
 if (options.status==='OPEN') conditions.push("t.status NOT IN ('CLOSED','CANCELLED')");
 else if (MAINTENANCE_STATUSES.includes(options.status as MaintenanceStatus)) {conditions.push('t.status=?');args.push(options.status!);}
 if ((MAINTENANCE_CATEGORIES as readonly string[]).includes(options.category||'')) {conditions.push('t.category=?');args.push(options.category!);}
 if (['URGENT','ROUTINE'].includes(options.urgency||'')) {conditions.push('t.urgency=?');args.push(options.urgency!);}
 if (actor.kind==='STAFF' && options.assignee) {conditions.push('t.assignee_email=?');args.push(options.assignee==='UNASSIGNED'?'':options.assignee.toLowerCase());}
 if (options.overdue) {conditions.push("t.status='SUBMITTED' AND t.acknowledgement_due_at<?");args.push(stamp);}
 if (options.escalated) conditions.push("t.escalated_at<>'' AND t.status NOT IN ('CLOSED','CANCELLED')");
 if (options.search) {conditions.push("instr(lower(t.reference || ' ' || t.title || ' ' || t.room_label || ' ' || t.student_name),lower(?))>0");args.push(options.search.trim().slice(0,80));}
 const where=conditions.join(' AND ');
 const [count,totals]=await Promise.all([
  turso(`SELECT COUNT(*) n ${JOIN} WHERE ${where}`,args),
  turso(`SELECT SUM(CASE WHEN t.status NOT IN ('CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS open,
   SUM(CASE WHEN t.status='SUBMITTED' AND t.acknowledgement_due_at<? THEN 1 ELSE 0 END) AS overdue,
   SUM(CASE WHEN t.escalated_at<>'' AND t.status NOT IN ('CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS escalated,
   SUM(CASE WHEN t.status='RESOLVED' THEN 1 ELSE 0 END) AS resolved ${JOIN} WHERE ${base}`,[stamp,...baseArgs]),
 ]);
 const total=Number(rowsToObjects(count)[0]?.n||0),pages=Math.max(1,Math.ceil(total/20)),page=Math.max(1,Math.min(pages,Math.floor(Number(options.page)||1)));
 const rows=rowsToObjects(await turso(`${select} WHERE ${where} ORDER BY CASE WHEN t.status NOT IN ('CLOSED','CANCELLED','RESOLVED') THEN 0 ELSE 1 END,
   CASE t.urgency WHEN 'URGENT' THEN 0 ELSE 1 END,t.created_at DESC,t.id DESC LIMIT 20 OFFSET ?`,[...args,(page-1)*20]));
 const sum=rowsToObjects(totals)[0]||{};
 return {tickets:rows.map(row=>requestView(row,actor)),pagination:{page,pages,total,pageSize:20},summary:{open:Number(sum.open||0),overdue:Number(sum.overdue||0),escalated:Number(sum.escalated||0),resolved:Number(sum.resolved||0)},config,isOwner:actor.kind==='STAFF'&&actor.isOwner};
}

export async function updateMaintenanceRequest(actor: MaintenanceActor, id: string, body: Record<string,unknown>, files:MaintenanceUpload[]=[],bucket?:PhotoBucket) {
 const row=await ownedTicket(actor,id), mutation=requestKey(body.mutationId);
 validateMaintenancePhotos(files);
 const action=String(body.action||'') as MaintenanceAction,version=Number(body.version),note=clean(body.note,2000,'Your note');
 const assignee=clean(body.assigneeEmail,150,'Staff member').toLowerCase();
 const hash=await maintenanceHash(JSON.stringify([action,note,assignee,await Promise.all(files.map(file=>maintenanceHash(file.body)))]));
 const previous=rowsToObjects(await turso('SELECT details FROM hostel_maintenance_events WHERE request_id=? AND mutation_id=?',[id,mutation]))[0];
 if(previous){if(JSON.parse(String(previous.details)).hash!==hash)throw conflict();return maintenanceDetail(actor,id);}
 if (!Number.isInteger(version)||version!==Number(row.version)) throw conflict();
 if (!maintenanceActions(row.status as MaintenanceStatus,actor.kind==='STAFF',Boolean(row.escalated_at)).includes(action)) throw new CampusEngineError('INVALID_STATE','That action is not available for this report.',409);
 if (['WAIT','RESOLVE','REOPEN','CANCEL','ESCALATE'].includes(action)&&note.length<5) throw new CampusEngineError('VALIDATION_ERROR','Add a note of at least five characters explaining this change.',400);
 if (action==='COMMENT'&&!note&&!files.length) throw new CampusEngineError('VALIDATION_ERROR','Write a reply or add a photo.',400);
 if (files.length && !['COMMENT','RESOLVE','REOPEN'].includes(action)) throw new CampusEngineError('VALIDATION_ERROR','Attach photos with a reply, resolution, or reopened report.',400);
 let staffName=String(row.assignee_name||'');
 if (action==='ASSIGN') {
  const member=(await maintenanceAssignees(actor)).find(person=>person.email===assignee);
  if (assignee&&!member) throw new CampusEngineError('VALIDATION_ERROR','Choose an active owner or manager of this hostel.',400);
  staffName=member?.name||'';
 }
 let status=String(row.status);
 const mapping:Partial<Record<MaintenanceAction,string>>={ACKNOWLEDGE:'ACKNOWLEDGED',START:'IN_PROGRESS',WAIT:'WAITING_FOR_STUDENT',RESOLVE:'RESOLVED',CLOSE:'CLOSED',REOPEN:'SUBMITTED',CANCEL:'CANCELLED'};
 status=mapping[action]||status;
 if(action==='COMMENT'&&actor.kind==='STUDENT'&&row.status==='WAITING_FOR_STUDENT')status='ACKNOWLEDGED';
 const stamp=new Date().toISOString(),eventId=crypto.randomUUID();
 const config=rowsToObjects(await turso('SELECT acknowledgement_hours FROM hostel_maintenance_settings WHERE property_id=?',[String(row.property_id)]))[0];
 const due=action==='REOPEN'?new Date(Date.now()+Number(config?.acknowledgement_hours||24)*3600000).toISOString():String(row.acknowledgement_due_at);
 const staged=await stageMaintenancePhotos(id,files,bucket);
 const own=scope(actor);
 try {
  const [changed]=await tursoTransaction([
   {sql:`UPDATE hostel_maintenance_requests AS t SET status=?,assignee_email=?,assignee_name=?,version=version+1,mutation_id=?,updated_at=?,acknowledgement_due_at=?,
    acknowledged_at=CASE WHEN ?='REOPEN' THEN '' WHEN ?='ACKNOWLEDGE' THEN ? ELSE acknowledged_at END,
    resolved_at=CASE WHEN ?='REOPEN' THEN '' WHEN ?='RESOLVE' THEN ? ELSE resolved_at END,
    escalated_at=CASE WHEN ?='REOPEN' THEN '' WHEN ?='ESCALATE' THEN ? ELSE escalated_at END
    WHERE t.id=? AND t.version=? AND ${own.sql} AND t.status=?
    AND (SELECT COUNT(*) FROM hostel_maintenance_attachments WHERE request_id=t.id)+?<=10
    ${action==='ASSIGN'&&assignee?`AND EXISTS (SELECT 1 FROM console_accounts a JOIN hostel_landlords h ON h.id=a.profile_id WHERE h.id=t.landlord_id AND lower(a.email)=? AND a.role='LANDLORD' AND a.status='ACTIVE'
      AND (lower(a.email)=lower(h.email) OR EXISTS (SELECT 1 FROM hostel_managers m WHERE m.landlord_id=h.id AND lower(m.email)=lower(a.email) AND m.status='ACTIVE')))` : ''}`,
    args:[status,action==='ASSIGN'?assignee:String(row.assignee_email||''),staffName,mutation,stamp,due,action,action,stamp,action,action,stamp,action,action,stamp,id,version,own.value,String(row.status),staged.length,...(action==='ASSIGN'&&assignee?[assignee]:[])]},
   eventStatement({id,eventId,mutation,actor,action,previous:String(row.status),status,note:note||(files.length?'Added photos.':''),details:{hash,...(action==='ASSIGN'?{assigneeName:staffName||'Unassigned'}:{}),photos:staged.map(file=>file.id)},stamp}),
   ...attachmentStatements(staged,id,eventId,mutation,stamp),...notificationStatements(id,mutation,stamp,action),
  ]);
  if(Number(changed.affected_row_count)!==1){await discardMaintenancePhotos(staged,bucket);throw new CampusEngineError('CONFLICT','The report or staff access changed, or this report has reached its ten-photo limit. Refresh before trying again.',409);}
 }catch(error){await preserveCommittedPhotosOrDiscard(id,mutation,staged,bucket);throw error;}
 return maintenanceDetail(actor,id);
}
export async function readMaintenancePhoto(actor:MaintenanceActor,id:string,token:string,bucket?:PhotoBucket) {
 await ensureHostelMaintenanceTables();
 if(!await verifyMaintenancePhotoToken(actor,id,token))throw new CampusEngineError('FORBIDDEN','This photo link expired. Refresh the report to open it again.',403);
 const own=scope(actor);
 const row=rowsToObjects(await turso(`SELECT f.object_key,f.content_type FROM hostel_maintenance_attachments f JOIN hostel_maintenance_requests t ON t.id=f.request_id WHERE f.id=? AND ${own.sql}`,[id,own.value]))[0];
 if(!row)throw missing();
 const object=await(await maintenanceBucket(bucket)).get(String(row.object_key));
 if(!object?.body)throw missing();
 return new Response(object.body,{headers:{'Content-Type':String(row.content_type),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
}
