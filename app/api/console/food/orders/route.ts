import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { decideVendorFoodPreorder, listVendorFoodPreorders } from "@/lib/food/preorders";

const headers={"Cache-Control":"no-store"};
export async function GET(request:Request){try{const account=await requireConsoleRole(request,["VENDOR"]);return Response.json(await listVendorFoodPreorders(account.profileId),{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
export async function PATCH(request:Request){try{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new CampusEngineError("FORBIDDEN","Cross-origin order action refused.",403);const account=await requireConsoleRole(request,["VENDOR"]);const body=await request.json() as {id?:unknown;action?:unknown;note?:unknown};return Response.json({ok:true,order:await decideVendorFoodPreorder(account.profileId,{id:body.id,action:body.action,note:body.note})},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
