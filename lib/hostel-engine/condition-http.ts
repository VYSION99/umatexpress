import { CampusEngineError, campusErrorPayload } from '@/lib/campus-engine/errors';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { residentCareActor } from './maintenance-http';
import { readMaintenanceBody } from './maintenance-files';
import { conditionConfig, conditionDetail, exportConditionRecord, listConditionRecords, readConditionPhoto, saveConditionConfig, startConditionRecord, updateConditionRecord } from './conditions';
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
export async function conditionRoute(request:Request,audience:'STUDENT'|'STAFF',mode:'records'|'settings'|'photo'|'export'='records',id='') {
 try {
  const actor=await residentCareActor(request,audience),write=request.method!=='GET';
  const limited=await rateLimit(request,`condition-${write?'write':'read'}-${actor.email}`,{limit:write?45:150,windowMs:write?3600000:60000});if(!limited.ok)return rateLimitResponse(limited.retryAfter);
  const url=new URL(request.url);
  if(mode==='photo')return await readConditionPhoto(actor,id,url.searchParams.get('token')||'');
  if(mode==='export')return await exportConditionRecord(actor,url.searchParams.get('id')||'',url.searchParams.get('format')==='json'?'json':'text');
  if(mode==='settings') {
   if(request.method==='GET')return Response.json({ok:true,config:await conditionConfig(actor,{propertyId:url.searchParams.get('propertyId')||''}),isOwner:actor.kind==='STAFF'&&actor.isOwner},{headers});
   const {data}=await readMaintenanceBody(request);return Response.json({ok:true,config:await saveConditionConfig(actor,data)},{headers});
  }
  if(request.method==='GET') {
   const id=url.searchParams.get('id');if(id)return Response.json({ok:true,...await conditionDetail(actor,id)},{headers});
   return Response.json({ok:true,...await listConditionRecords(actor,{reference:url.searchParams.get('reference')||'',propertyId:url.searchParams.get('propertyId')||'',status:url.searchParams.get('status')||'',q:url.searchParams.get('q')||'',page:Number(url.searchParams.get('page')||1),disputed:url.searchParams.get('disputed')==='1'})},{headers});
  }
  const {data,files}=await readMaintenanceBody(request);
  if(request.method==='POST'){if(files.length)throw new CampusEngineError('VALIDATION_ERROR','Open the checklist before adding evidence.',400);return Response.json({ok:true,...await startConditionRecord(actor,data)},{status:201,headers});}
  if(request.method==='PATCH')return Response.json({ok:true,...await updateConditionRecord(actor,String(data.id||''),data,files)},{headers});
  return Response.json({ok:false,error:'Method not supported.'},{status:405,headers});
 }catch(error){if(error instanceof CampusEngineError){const result=campusErrorPayload(error);return Response.json(result.body,{status:result.status,headers});}return Response.json({ok:false,error:'The condition record could not be updated. Your saved evidence is safe; please retry.'},{status:500,headers});}
}
