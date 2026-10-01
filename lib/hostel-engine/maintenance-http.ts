import { CampusEngineError, campusErrorPayload } from '@/lib/campus-engine/errors';
import { requireConsoleRole } from '@/lib/console-auth';
import { requireStudent } from '@/lib/student-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { resolveHostelHost } from './managers';
import { createMaintenanceRequest, listMaintenanceRequests, maintenanceAssignees, maintenanceConfig, maintenanceDetail, readMaintenancePhoto, saveMaintenanceConfig, updateMaintenanceRequest } from './maintenance';
import { readMaintenanceBody, type MaintenanceActor } from './maintenance-files';
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
type Audience = 'STUDENT' | 'STAFF';
export async function residentCareActor(request: Request, audience: Audience): Promise<MaintenanceActor> {
 if (!['GET','HEAD'].includes(request.method)) {
  const origin=request.headers.get('origin');
  if(origin && origin!==new URL(request.url).origin)throw new CampusEngineError('FORBIDDEN','Open this action from your signed-in workspace.',403);
 }
 if(audience==='STUDENT') {const student=await requireStudent(request);return {kind:'STUDENT',email:student.email,name:student.name};}
 const account=await requireConsoleRole(request,['LANDLORD']);
 const host=await resolveHostelHost(account);
 return {kind:'STAFF',email:host.email,name:account.name,landlordId:host.landlordId,isOwner:host.isOwner};
}
function failure(error: unknown) {
 if(!(error instanceof CampusEngineError)) return Response.json({ok:false,code:'ENGINE_ERROR',error:'The maintenance service could not complete this request. Your saved reports are safe; please try again.'},{status:500,headers});
 const {status,body}=campusErrorPayload(error);return Response.json(body,{status,headers});
}
export async function maintenanceRoute(request:Request,audience:Audience) {
 try {
  const actor=await residentCareActor(request,audience), write=request.method!=='GET';
  const limited=await rateLimit(request,`maintenance-${write?'write':'read'}-${actor.email}`,{limit:write?45:150,windowMs:write?3600000:60000});
  if(!limited.ok)return rateLimitResponse(limited.retryAfter);
  const url=new URL(request.url);
  if(request.method==='GET') {
   const id=url.searchParams.get('id');
   if(id)return Response.json({ok:true,...await maintenanceDetail(actor,id),...(audience==='STAFF'?{assignees:await maintenanceAssignees(actor)}:{})},{headers});
   const data=await listMaintenanceRequests(actor,{reference:url.searchParams.get('reference')||'',propertyId:url.searchParams.get('propertyId')||'',
    status:url.searchParams.get('status')||'',category:url.searchParams.get('category')||'',urgency:url.searchParams.get('urgency')||'',assignee:url.searchParams.get('assignee')||'',
    search:url.searchParams.get('q')||'',page:Number(url.searchParams.get('page')||1),overdue:url.searchParams.get('overdue')==='1',escalated:url.searchParams.get('escalated')==='1'});
   return Response.json({ok:true,...data,...(audience==='STAFF'?{assignees:await maintenanceAssignees(actor)}:{})},{headers});
  }
  const {data,files}=await readMaintenanceBody(request);
  if(request.method==='POST'&&audience==='STUDENT')return Response.json({ok:true,...await createMaintenanceRequest(actor,data,files)},{status:201,headers});
  if(request.method==='PATCH')return Response.json({ok:true,...await updateMaintenanceRequest(actor,String(data.id||''),data,files)},{headers});
  return Response.json({ok:false,error:'That method is not supported.'},{status:405,headers});
 }catch(error){return failure(error);}
}
export async function maintenanceSettingsRoute(request:Request) {
 try{
  const actor=await residentCareActor(request,'STAFF');
  const limited=await rateLimit(request,`maintenance-settings-${actor.email}`,{limit:60,windowMs:60000});
  if(!limited.ok)return rateLimitResponse(limited.retryAfter);
  if(request.method==='GET')return Response.json({ok:true,config:await maintenanceConfig(actor,{propertyId:new URL(request.url).searchParams.get('propertyId')||''}),isOwner:actor.kind==='STAFF'&&actor.isOwner},{headers});
  const {data}=await readMaintenanceBody(request);
  return Response.json({ok:true,config:await saveMaintenanceConfig(actor,data)},{headers});
 }catch(error){return failure(error);}
}
export async function maintenanceFileRoute(request:Request,audience:Audience,id:string) {
 try{
  const actor=await residentCareActor(request,audience);
  const limited=await rateLimit(request,`maintenance-photo-${actor.email}`,{limit:180,windowMs:60000});
  if(!limited.ok)return rateLimitResponse(limited.retryAfter);
  return await readMaintenancePhoto(actor,id,new URL(request.url).searchParams.get('token')||'');
 }catch(error){return failure(error);}
}
