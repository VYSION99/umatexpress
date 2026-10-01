import { CampusEngineError,campusErrorPayload } from '@/lib/campus-engine/errors';
import { rateLimit,rateLimitResponse } from '@/lib/rate-limit';
import { residentCareActor } from './maintenance-http';
import { readMaintenanceBody } from './maintenance-files';
import { createStayRequest,listStayRequests,saveStayRequestConfig,stayRequestConfig,stayRequestDetail,stayRequestOptions,updateStayRequest } from './stay-requests';
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
export async function stayRequestRoute(request:Request,audience:'STUDENT'|'STAFF',settings=false){
 try{
  const actor=await residentCareActor(request,audience),write=request.method!=='GET';
  const limited=await rateLimit(request,`stay-request-${write?'write':'read'}-${actor.email}`,{limit:write?45:150,windowMs:write?3600000:60000});if(!limited.ok)return rateLimitResponse(limited.retryAfter);
  const url=new URL(request.url),q=url.searchParams;
  if(request.method==='GET'){
   if(settings)return Response.json({ok:true,config:await stayRequestConfig(actor,{propertyId:q.get('propertyId')||''})},{headers});
   if(q.get('mode')==='options')return Response.json({ok:true,...await stayRequestOptions(actor,q.get('reference')||'',q.get('kind')||'MOVE',q.get('q')||'')},{headers});
   if(q.get('id'))return Response.json({ok:true,...await stayRequestDetail(actor,q.get('id')!)},{headers});
   return Response.json({ok:true,...await listStayRequests(actor,{reference:q.get('reference')||'',propertyId:q.get('propertyId')||'',status:q.get('status')||'',page:Number(q.get('page')||1)})},{headers});
  }
  const {data,files}=await readMaintenanceBody(request);if(files.length)throw new CampusEngineError('VALIDATION_ERROR','Stay requests accept text only. Room evidence belongs in your condition record.',400);
  if(settings&&request.method==='PATCH')return Response.json({ok:true,config:await saveStayRequestConfig(actor,data)},{headers});
  if(request.method==='POST')return Response.json({ok:true,...await createStayRequest(actor,data)},{status:201,headers});
  if(request.method==='PATCH')return Response.json({ok:true,...await updateStayRequest(actor,String(data.id||''),data,url.origin)},{headers});
  return Response.json({ok:false,error:'Method not supported.'},{status:405,headers});
 }catch(error){if(error instanceof CampusEngineError){const r=campusErrorPayload(error);return Response.json(r.body,{status:r.status,headers});}return Response.json({ok:false,error:'The stay request could not be completed. Refresh its status before retrying; your current stay remains protected.'},{status:500,headers});}
}
