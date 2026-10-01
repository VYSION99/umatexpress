import { CampusEngineError } from '@/lib/campus-engine/errors';
import { platformSettingEnabled } from '@/lib/platform-settings';
import { rowsToObjects, turso, tursoTransaction } from '@/lib/turso';
import { getHostelBookingByReference, startHostelBooking } from './residency';
import { maintenanceHash, type MaintenanceActor } from './maintenance-files';
import { ensureStayRequestTables } from './stay-request-schema';
import { bedAvailableSql } from './inventory';
import { updateHostelStay } from './stays';
import type { StayRequest,StayRequestConfig,StayRequestDetail,StayOffer,StayRequestKind } from './stay-request-types';

type Row=Record<string,unknown>;
type Statement={sql:string;args:Array<string|number|null>};
const conflict=()=>new CampusEngineError('CONFLICT','This request, offer or bed changed. Refresh and review the latest details.',409);
const invalid=(message:string)=>new CampusEngineError('VALIDATION_ERROR',message,400);
const missing=()=>new CampusEngineError('NOT_FOUND','That stay request was not found.',404);
function text(value:unknown,max:number,min=0){if(value!==undefined&&typeof value!=='string')throw invalid('Enter valid text.');const s=String(value||'').trim();if(s.length<min||s.length>max)throw invalid(`Enter ${min||1}–${max} characters.`);return s;}
function key(value:unknown){const k=text(value,36,36);if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(k))throw invalid('Refresh the action before submitting.');return k.toLowerCase();}
const scope=(actor:MaintenanceActor)=>actor.kind==='STUDENT'?{sql:'q.student_email=?',value:actor.email.toLowerCase()}:{sql:'q.landlord_id=?',value:actor.landlordId};
const select=`SELECT q.*,p.name AS property_name,b.status AS booking_status,b.space_id AS current_space,b.period_id AS current_period,b.price AS current_price,b.utilities_fee AS current_utilities,
 COALESCE((SELECT r.label||' · '||s.label FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id WHERE l.id=q.requested_listing_id),'') AS requested_destination,st.assignment_id,st.status AS stay_status,st.version AS stay_version,st.key_reference,pe.starts_on,pe.ends_on
 FROM hostel_stay_requests q JOIN hostel_properties p ON p.id=q.property_id JOIN hostel_bookings b ON b.id=q.booking_id
 JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id`;
async function expireOffers(){const stamp=new Date().toISOString();await tursoTransaction([
 {sql:"UPDATE hostel_stay_requests SET status='EXPIRED',version=version+1,updated_at=? WHERE status='OFFERED' AND expires_at<=?",args:[stamp,stamp]},
 {sql:`INSERT INTO hostel_stay_request_events(id,request_id,mutation_id,payload_hash,version,action,actor_name,actor_email,note,created_at)
 SELECT lower(hex(randomblob(16))),id,'expired-'||version,'',version,'EXPIRED','System','system','The offer expired without acceptance.',? FROM hostel_stay_requests WHERE status='EXPIRED' AND updated_at=? ON CONFLICT(request_id,version) DO NOTHING`,args:[stamp,stamp]},
]);}
async function own(actor:MaintenanceActor,id:string){await ensureStayRequestTables();await expireOffers();const s=scope(actor);const row=rowsToObjects(await turso(`${select} WHERE q.id=? AND ${s.sql}`,[id,s.value]))[0];if(!row)throw missing();return row;}
function view(row:Row):StayRequest{const s=(k:string)=>String(row[k]||'');return {id:s('id'),reference:s('reference'),bookingReference:s('booking_reference'),propertyId:s('property_id'),propertyName:s('property_name'),studentName:s('student_name'),kind:s('kind') as StayRequestKind,status:s('status'),preference:s('preference'),requestedListingId:s('requested_listing_id'),requestedDestination:s('requested_destination'),offer:row.offer_json?JSON.parse(s('offer_json')):null,expiresAt:s('expires_at'),version:Number(row.version),createdAt:s('created_at'),updatedAt:s('updated_at'),checkoutReference:s('checkout_reference'),checkoutUrl:s('status')==='PAYMENT_PENDING'?s('checkout_url'):''};}
function eligible(row:Row){const today=new Date().toISOString().slice(0,10);return row.booking_status==='PAID'&&['EXPECTED','CHECKED_IN'].includes(String(row.stay_status))&&String(row.starts_on)<=today&&String(row.ends_on)>=today;}
function actions(row:Row,actor:MaintenanceActor){
 const open=['SUBMITTED','REVIEWING','OFFERED','ACCEPTED'].includes(String(row.status));if(!open)return [];
 const result=['CANCEL'];if(!eligible(row))return result;
 if(actor.kind==='STUDENT')return [...result,...(row.status==='OFFERED'?['ACCEPT']:[])];
 return [...result,...(row.status==='SUBMITTED'?['REVIEW']:[]),'OFFER','DECLINE',...(row.status==='ACCEPTED'&&row.kind==='MOVE'?['FULFILL']:[])];
}
export async function stayRequestConfig(actor:MaintenanceActor,options:{reference?:string;propertyId?:string}):Promise<StayRequestConfig>{
 await ensureStayRequestTables();let propertyId=options.propertyId||'',can=true,currentEnd='';
 if(options.reference){const b=await getHostelBookingByReference(options.reference);if(!b||(actor.kind==='STUDENT'?b.studentEmail.toLowerCase()!==actor.email.toLowerCase():b.landlordId!==actor.landlordId))throw missing();propertyId=b.propertyId;currentEnd=b.periodEndsOn;const today=new Date().toISOString().slice(0,10);can=b.status==='PAID'&&['EXPECTED','CHECKED_IN'].includes(b.stayStatus)&&b.periodStartsOn<=today&&b.periodEndsOn>=today;}
 else if(actor.kind==='STUDENT')throw missing();
 const row=rowsToObjects(await turso(`SELECT p.name,p.status,h.status AS host_status,s.* FROM hostel_properties p JOIN hostel_landlords h ON h.id=p.landlord_id LEFT JOIN hostel_stay_request_settings s ON s.property_id=p.id WHERE p.id=? ${actor.kind==='STAFF'?'AND p.landlord_id=?':''}`,actor.kind==='STAFF'?[propertyId,actor.landlordId]:[propertyId]))[0];if(!row)throw missing();
 const periods=rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE active=1 AND starts_on>? ORDER BY starts_on LIMIT 20",[currentEnd||new Date().toISOString().slice(0,10)])).map(p=>({id:String(p.id),name:String(p.name),startsOn:String(p.starts_on),endsOn:String(p.ends_on)}));
 const today=new Date().toISOString().slice(0,10),platformEnabled=await platformSettingEnabled('hostel_stay_requests_enabled');
 return {propertyId,propertyName:String(row.name),movesEnabled:Number(row.moves_enabled)===1,renewalsEnabled:Number(row.renewals_enabled)===1,platformEnabled,eligible:can&&row.status==='APPROVED'&&row.host_status==='ACTIVE',renewalOpen:Number(row.renewals_enabled)===1&&String(row.opens_on)<=today&&String(row.closes_on)>=today&&periods.some(p=>p.id===row.period_id),periodId:String(row.period_id||''),opensOn:String(row.opens_on||''),closesOn:String(row.closes_on||''),version:Number(row.version||0),isOwner:actor.kind==='STAFF'&&actor.isOwner,periods};
}
export async function saveStayRequestConfig(actor:MaintenanceActor,body:Record<string,unknown>){
 if(actor.kind!=='STAFF'||!actor.isOwner)throw new CampusEngineError('FORBIDDEN','Only the owner can set renewal windows and enable stay requests.',403);
 const propertyId=text(body.propertyId,100,1),config=await stayRequestConfig(actor,{propertyId});
 if(typeof body.movesEnabled!=='boolean'||typeof body.renewalsEnabled!=='boolean'||!Number.isInteger(body.version)||body.version!==config.version)throw conflict();
 const periodId=text(body.periodId,100),opens=text(body.opensOn,10),closes=text(body.closesOn,10);
 const validDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
 if(body.renewalsEnabled&&(!validDate(opens)||!validDate(closes)||opens>closes||!config.periods.some(p=>p.id===periodId&&p.startsOn>closes)))throw invalid('Choose a future academic year and a renewal window that closes before it starts.');
 const stamp=new Date().toISOString();const [changed]=await tursoTransaction([
 {sql:`INSERT INTO hostel_stay_request_settings(property_id,moves_enabled,renewals_enabled,period_id,opens_on,closes_on,version,updated_by,updated_at)
 SELECT ?,?,?,?,?,?,1,?,? WHERE EXISTS(SELECT 1 FROM hostel_landlords h JOIN hostel_properties p ON p.landlord_id=h.id WHERE p.id=? AND h.id=? AND lower(h.email)=? AND h.status='ACTIVE') AND (?=0 OR EXISTS(SELECT 1 FROM hostel_stay_request_settings WHERE property_id=?))
 ON CONFLICT(property_id) DO UPDATE SET moves_enabled=excluded.moves_enabled,renewals_enabled=excluded.renewals_enabled,period_id=excluded.period_id,opens_on=excluded.opens_on,closes_on=excluded.closes_on,version=hostel_stay_request_settings.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE hostel_stay_request_settings.version=?`,args:[propertyId,body.movesEnabled?1:0,body.renewalsEnabled?1:0,periodId,opens,closes,actor.email,stamp,propertyId,actor.landlordId,actor.email.toLowerCase(),config.version,propertyId,config.version]},
 {sql:"INSERT INTO admin_audit_logs(id,admin_email,action,target_type,target_reference,details,created_at) SELECT ?,?,'HOSTEL_STAY_REQUEST_SETTINGS','hostel_property',?,?,? WHERE changes()=1",args:[crypto.randomUUID(),actor.email,propertyId,JSON.stringify({movesEnabled:body.movesEnabled,renewalsEnabled:body.renewalsEnabled,periodId,opens,closes}),stamp]}
 ]);if(Number(changed.affected_row_count)!==1)throw conflict();return stayRequestConfig(actor,{propertyId});
}
function featureGuard(kind:string){return `EXISTS(SELECT 1 FROM hostel_stay_request_settings cfg JOIN hostel_properties prop ON prop.id=cfg.property_id JOIN hostel_landlords host ON host.id=prop.landlord_id WHERE cfg.property_id=b.property_id AND host.status='ACTIVE' AND prop.status='APPROVED' AND ${kind==='MOVE'?"cfg.moves_enabled=1":"cfg.renewals_enabled=1 AND cfg.opens_on<=date('now') AND cfg.closes_on>=date('now')"}) AND COALESCE((SELECT value FROM platform_settings WHERE key='hostel_stay_requests_enabled'),?)='1'`;}
const currentGuard=`b.status='PAID' AND st.status IN ('EXPECTED','CHECKED_IN') AND pe.starts_on<=date('now') AND pe.ends_on>=date('now') AND NOT EXISTS(SELECT 1 FROM hostel_refunds rf WHERE rf.booking_id=b.id AND rf.status IN ('REQUESTED','APPROVED'))`;
export async function stayRequestOptions(actor:MaintenanceActor,reference:string,kind:string,search=''){
 const config=await stayRequestConfig(actor,{reference}),booking=(await getHostelBookingByReference(reference))!;
 const periodId=kind==='RENEWAL'?config.periodId:booking.periodId;
 const destinations=rowsToObjects(await turso(`SELECT l.id AS listing_id,r.label AS room_label,s.label AS space_label,pe.name AS period_name,l.price,CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END AS utilities_fee
 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_properties p ON p.id=r.property_id JOIN hostel_periods pe ON pe.id=l.period_id
 WHERE p.id=? AND l.period_id=? AND l.status='APPROVED' AND p.status='APPROVED' AND r.status='ACTIVE' AND pe.active=1 AND ${bedAvailableSql()}
 ${kind==='RENEWAL'?'':'AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=?'}
 AND (?='' OR instr(lower(r.label||' '||s.label),lower(?))>0) ORDER BY r.label COLLATE NOCASE,s.label COLLATE NOCASE LIMIT 50`,[booking.propertyId,periodId,...(kind==='RENEWAL'?[]:[booking.price,booking.utilitiesFee]),search.slice(0,80),search.slice(0,80)])).map(r=>({listingId:String(r.listing_id),roomLabel:String(r.room_label),spaceLabel:String(r.space_label),periodName:String(r.period_name),price:Number(r.price),utilitiesFee:Number(r.utilities_fee),total:Number(r.price)+Number(r.utilities_fee)}));
 return {config,destinations};
}
function event(id:string,eventId:string,mutation:string,hash:string,version:number,action:string,actor:MaintenanceActor,note:string,details:string,stamp:string,guard='changes()=1',args:Array<string|number|null>=[]):Statement{
 return {sql:`INSERT INTO hostel_stay_request_events(id,request_id,mutation_id,payload_hash,version,action,actor_name,actor_email,note,details,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,args:[eventId,id,mutation,hash,version,action,actor.name,actor.email,note,details,stamp,...args]};
}
function notices(id:string,eventId:string,stamp:string):Statement[]{return [false,true].map(staff=>({sql:`INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at)
 SELECT ?,'email',${staff?'h.email':'q.student_email'},?,'Stay request · '||q.reference,'Your stay request has an update. Open Stay plans to review the details.',?,'PENDING',0,'',?,? FROM hostel_stay_requests q JOIN hostel_landlords h ON h.id=q.landlord_id WHERE q.id=? AND EXISTS(SELECT 1 FROM hostel_stay_request_events WHERE id=?) ON CONFLICT(reference,template) DO NOTHING`,args:[crypto.randomUUID(),staff?'hostel_stay_request_staff':'hostel_stay_request_student',`${id}:${eventId}`,stamp,stamp,id,eventId]}));}
export async function createStayRequest(actor:MaintenanceActor,body:Record<string,unknown>){
 if(actor.kind!=='STUDENT')throw new CampusEngineError('FORBIDDEN','Students submit their own stay requests.',403);
 await ensureStayRequestTables();await expireOffers();const id=key(body.mutationId),reference=text(body.reference,100,1),kind=text(body.kind,10),preference=text(body.preference,1000,5),target=text(body.listingId,100);
 if(!['MOVE','RENEWAL'].includes(kind))throw invalid('Choose a room change or next-year renewal.');
 const hash=await maintenanceHash(JSON.stringify([reference,kind,preference,target]));const existing=rowsToObjects(await turso('SELECT student_email,create_hash FROM hostel_stay_requests WHERE id=?',[id]))[0];if(existing){if(existing.student_email!==actor.email.toLowerCase()||existing.create_hash!==hash)throw conflict();return stayRequestDetail(actor,id);}
 const {config,destinations}=await stayRequestOptions(actor,reference,kind);if(!config.platformEnabled||!config.eligible||!(kind==='MOVE'?config.movesEnabled:config.renewalOpen))throw new CampusEngineError('INVALID_STATE','New requests are unavailable for this stay or outside the renewal window.',409);
 // The optional preference is not a reservation. Validate a chosen bed against the full query, including search.
 if(target&&!destinations.some(d=>d.listingId===target)){
  const chosen=rowsToObjects(await turso('SELECT r.label FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id WHERE l.id=?',[target]))[0];
  if(!chosen||!(await stayRequestOptions(actor,reference,kind,String(chosen.label))).destinations.some(d=>d.listingId===target))throw conflict();
 }
 const stamp=new Date().toISOString(),eventId=crypto.randomUUID();
 const [changed]=await tursoTransaction([
 {sql:`INSERT INTO hostel_stay_requests(id,reference,booking_id,booking_reference,property_id,landlord_id,student_email,student_name,kind,preference,requested_listing_id,create_hash,created_at,updated_at)
 SELECT ?,?,b.id,b.reference,b.property_id,b.landlord_id,lower(b.student_email),b.student_name,?,?,?,?,?,?
 FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id
 WHERE b.reference=? AND lower(b.student_email)=? AND ${currentGuard} AND ${featureGuard(kind)} AND NOT EXISTS(SELECT 1 FROM hostel_stay_requests previous WHERE previous.booking_id=b.id AND previous.kind=? AND previous.status='PAYMENT_REVIEW')`,args:[id,'HS-'+id.replaceAll('-','').slice(0,12).toUpperCase(),kind,preference,target,hash,stamp,stamp,reference,actor.email.toLowerCase(),config.platformEnabled?'1':'0',kind]},
 event(id,eventId,id,hash,0,'SUBMIT',actor,preference,'',stamp),...notices(id,eventId,stamp)
 ]).catch(error=>{if(error instanceof Error&&error.message.includes('UNIQUE'))throw new CampusEngineError('CONFLICT','An open request already exists. Review it before starting another.',409);throw error;});
 if(Number(changed.affected_row_count)!==1)throw conflict();return stayRequestDetail(actor,id);
}
export async function listStayRequests(actor:MaintenanceActor,options:{reference?:string;propertyId?:string;status?:string;page?:number}={}){
 await ensureStayRequestTables();await expireOffers();const s=scope(actor),filters=[s.sql],args:Array<string|number>=[s.value];
 if(options.reference){filters.push('q.booking_reference=?');args.push(options.reference);}if(options.propertyId){filters.push('q.property_id=?');args.push(options.propertyId);}if(options.status==='OPEN')filters.push("q.status IN ('SUBMITTED','REVIEWING','OFFERED','ACCEPTED','PAYMENT_PENDING','PAYMENT_REVIEW')");
 const where=filters.join(' AND '),count=rowsToObjects(await turso(`SELECT COUNT(*) n FROM hostel_stay_requests q WHERE ${where}`,args))[0],total=Number(count?.n||0),pages=Math.max(1,Math.ceil(total/20)),page=Math.max(1,Math.min(pages,Math.floor(Number(options.page)||1)));
 return {records:rowsToObjects(await turso(`${select} WHERE ${where} ORDER BY q.updated_at DESC,q.id DESC LIMIT 20 OFFSET ?`,[...args,(page-1)*20])).map(view),pagination:{page,pages,total},config:options.reference||options.propertyId?await stayRequestConfig(actor,options):undefined};
}
export async function stayRequestDetail(actor:MaintenanceActor,id:string):Promise<StayRequestDetail>{const row=await own(actor,id);return {record:view(row),actions:actions(row,actor),stayVersion:Number(row.stay_version),keyReference:actor.kind==='STAFF'?String(row.key_reference||''):'',events:rowsToObjects(await turso('SELECT id,action,actor_name,note,details,created_at FROM hostel_stay_request_events WHERE request_id=? ORDER BY version DESC LIMIT 100',[id])).map(e=>({id:String(e.id),action:String(e.action),actorName:String(e.actor_name),note:String(e.note),details:String(e.details||''),createdAt:String(e.created_at)}))};}
async function quote(row:Row,listingId:string,config:StayRequestConfig):Promise<StayOffer>{
 const target=rowsToObjects(await turso(`SELECT l.id,l.space_id,l.period_id,l.price,r.label AS room_label,s.label AS space_label,CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END AS utilities_fee,pe.name,pe.starts_on,pe.ends_on
 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_properties p ON p.id=r.property_id JOIN hostel_periods pe ON pe.id=l.period_id
 WHERE l.id=? AND p.id=? AND l.status='APPROVED' AND r.status='ACTIVE' AND p.status='APPROVED' AND pe.active=1 AND ${bedAvailableSql()}`,[listingId,String(row.property_id)]))[0];if(!target)throw conflict();
 if(row.kind==='MOVE'&&(target.period_id!==row.current_period||Number(target.price)!==Number(row.current_price)||Number(target.utilities_fee)!==Number(row.current_utilities)))throw invalid('Room changes must have the same rent and utilities. Different-price moves are not enabled.');
 if(row.kind==='RENEWAL'&&(target.period_id!==config.periodId||String(target.starts_on)<=String(row.ends_on)))throw invalid('Choose an approved listing for the configured next academic year.');
 return {listingId,spaceId:String(target.space_id),roomLabel:String(target.room_label),spaceLabel:String(target.space_label),periodId:String(target.period_id),periodName:String(target.name),startsOn:String(target.starts_on),endsOn:String(target.ends_on),price:Number(target.price),utilitiesFee:Number(target.utilities_fee),total:Number(target.price)+Number(target.utilities_fee),assignmentId:String(row.assignment_id),sourceSpaceId:String(row.current_space),configVersion:config.version};
}
export async function updateStayRequest(actor:MaintenanceActor,id:string,body:Record<string,unknown>,origin=''){
 const row=await own(actor,id),mutation=key(body.mutationId),action=text(body.action,20,1),note=text(body.note,1000),version=Number(body.version),listingId=text(body.listingId,100),expiresAt=text(body.expiresAt,30),keyReference=text(body.keyReference,80);
 const hash=await maintenanceHash(JSON.stringify([action,note,listingId,expiresAt,keyReference,body.keysReturned===true]));
 const previous=rowsToObjects(await turso('SELECT payload_hash FROM hostel_stay_request_events WHERE request_id=? AND mutation_id=?',[id,mutation]))[0];if(previous){if(previous.payload_hash!==hash)throw conflict();return stayRequestDetail(actor,id);}
 if(!Number.isInteger(version)||version!==Number(row.version))throw conflict();if(!actions(row,actor).includes(action))throw new CampusEngineError('INVALID_STATE','That action is not available for this request.',409);
 if(['OFFER','DECLINE','CANCEL','FULFILL'].includes(action)&&note.length<5)throw invalid('Add a brief explanation of at least five characters.');
 const stamp=new Date().toISOString(),eventId=crypto.randomUUID(),s=scope(actor);let offer=row.offer_json?JSON.parse(String(row.offer_json)) as StayOffer:null;
 let config:StayRequestConfig|undefined;
 if(['OFFER','ACCEPT'].includes(action)){
  config=await stayRequestConfig(actor,{reference:String(row.booking_reference)});
  if(!config.platformEnabled||!config.eligible||!(row.kind==='MOVE'?config.movesEnabled:config.renewalOpen))throw new CampusEngineError('INVALID_STATE','New offers and acceptance are paused or the renewal window has closed.',409);
 }
 if(action==='OFFER'){
  offer=await quote(row,listingId,config!);const end=Date.parse(expiresAt),limit=Math.min(Date.now()+14*86400000,Date.parse((row.kind==='RENEWAL'?config!.closesOn:String(row.ends_on))+'T23:59:59.999Z'));
  if(!Number.isFinite(end)||end<=Date.now()||end>limit||new Date(end).toISOString()!==expiresAt)throw invalid('Set an offer expiry within 14 days and before the renewal window or current year ends.');
 }
 if(['ACCEPT','FULFILL'].includes(action)){
  if(!offer||offer.assignmentId!==row.assignment_id||offer.sourceSpaceId!==row.current_space)throw conflict();
  if(action==='ACCEPT'){
   if(String(row.expires_at)<=stamp)throw conflict();const fresh=await quote(row,offer.listingId,config!);
   if(JSON.stringify(fresh)!==JSON.stringify(offer))throw new CampusEngineError('CONFLICT','The offer changed. Ask staff to issue a fresh offer before accepting.',409);
  }
 }
 const offerGuard=offer?`EXISTS(SELECT 1 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_properties p ON p.id=r.property_id JOIN hostel_periods target ON target.id=l.period_id
 WHERE l.id=? AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=? AND l.status='APPROVED' AND r.status='ACTIVE' AND p.status='APPROVED' AND target.active=1 AND ${bedAvailableSql()})
 AND EXISTS(SELECT 1 FROM hostel_stay_request_settings cfg WHERE cfg.property_id=? AND cfg.version=?)`:'';
 const offerArgs:Array<string|number>=offer?[offer.listingId,offer.price,offer.utilitiesFee,String(row.property_id),offer.configVersion]:[];
 const requestGuard=`EXISTS(SELECT 1 FROM hostel_stay_requests q JOIN hostel_bookings b ON b.id=q.booking_id JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id
 WHERE q.id=? AND q.version=? AND ${s.sql} AND q.status=? AND ${currentGuard} AND st.assignment_id=? AND b.space_id=? ${action==='ACCEPT'?"AND q.expires_at>? AND "+featureGuard(String(row.kind))+' AND '+offerGuard:''})`;
 const requestArgs:Array<string|number|null>=[id,version,s.value,String(row.status),String(row.assignment_id),String(row.current_space),...(action==='ACCEPT'?[stamp,config!.platformEnabled?'1':'0',...offerArgs]:[])];
 if(action==='FULFILL'&&actor.kind==='STAFF'){
  await updateHostelStay({landlordId:actor.landlordId,reference:String(row.booking_reference),actor:actor.email,action:'TRANSFER',version:Number(body.stayVersion),targetListingId:offer!.listingId,keyReference,keysReturned:body.keysReturned===true,note,
   transactionGuard:{sql:requestGuard,args:requestArgs,after:(stayEvent,at)=>[
    {sql:"UPDATE hostel_stay_requests SET status='FULFILLED',version=version+1,updated_at=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM hostel_stay_events WHERE id=?)",args:[at,id,version,stayEvent]},
    event(id,eventId,mutation,hash,version+1,action,actor,note,JSON.stringify(offer),at),...notices(id,eventId,at)
   ]}});return stayRequestDetail(actor,id);
 }
 if(action==='ACCEPT'&&row.kind==='RENEWAL'){
  if(!origin)throw invalid('Open renewal checkout from your residency page.');
  await startHostelBooking({listingId:offer!.listingId,student:{email:actor.email,name:actor.name,phone:''},origin,secure:origin.startsWith('https:'),note:'Renewal '+String(row.reference),offer:{id,version,price:offer!.price,utilitiesFee:offer!.utilitiesFee,guardSql:requestGuard,guardArgs:requestArgs as Array<string|number>,statements:(reference,at)=>[
   {sql:"UPDATE hostel_stay_requests SET status='PAYMENT_PENDING',checkout_reference=?,version=version+1,updated_at=? WHERE id=? AND version=? AND changes()=1",args:[reference,at,id,version]},
   event(id,eventId,mutation,hash,version+1,'ACCEPT',actor,'Accepted renewal quote; payment confirmation is required.',JSON.stringify(offer),at),...notices(id,eventId,at)
  ]}}).then(async result=>{await turso("UPDATE hostel_stay_requests SET checkout_url=? WHERE id=? AND checkout_reference=?",[result.authorizationUrl,id,result.booking!.reference]);});
  return stayRequestDetail(actor,id);
 }
 const status=action==='REVIEW'?'REVIEWING':action==='OFFER'?'OFFERED':action==='ACCEPT'?'ACCEPTED':action==='DECLINE'?'DECLINED':'CANCELLED';
 const [changed]=await tursoTransaction([
 {sql:`UPDATE hostel_stay_requests AS q SET status=?,offer_json=?,expires_at=?,version=version+1,updated_at=? WHERE q.id=? AND q.version=? AND ${s.sql} AND q.status=?
 ${action==='CANCEL'?'':`AND EXISTS(SELECT 1 FROM hostel_bookings b JOIN hostel_stays st ON st.booking_id=b.id JOIN hostel_periods pe ON pe.id=b.period_id WHERE b.id=q.booking_id AND ${currentGuard} AND st.assignment_id=? AND b.space_id=? ${['OFFER','ACCEPT'].includes(action)?'AND '+featureGuard(String(row.kind)):''})`}
 ${action==='ACCEPT'?'AND q.expires_at>?':''} ${['OFFER','ACCEPT'].includes(action)?'AND '+offerGuard:''}`,
 args:[status,offer?JSON.stringify(offer):'',action==='OFFER'?expiresAt:String(row.expires_at),stamp,id,version,s.value,String(row.status),...(action==='CANCEL'?[]:[String(row.assignment_id),String(row.current_space),...(['OFFER','ACCEPT'].includes(action)?[config!.platformEnabled?'1':'0']:[])]),...(action==='ACCEPT'?[stamp]:[]),...(['OFFER','ACCEPT'].includes(action)?offerArgs:[])]},
 event(id,eventId,mutation,hash,version+1,action,actor,note,offer?JSON.stringify({...offer,expiresAt:action==='OFFER'?expiresAt:String(row.expires_at)}):'',stamp),...notices(id,eventId,stamp)
 ]);if(Number(changed.affected_row_count)!==1)throw conflict();return stayRequestDetail(actor,id);
}
