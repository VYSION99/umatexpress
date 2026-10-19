import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { assignFoodVendor, listFoodVendors } from "@/lib/food/vendors";

const headers={"Cache-Control":"no-store"};
export async function GET(request:Request){try{await requireConsoleRole(request,["ADMIN","MODERATOR"]);return Response.json({vendors:await listFoodVendors()},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
export async function PATCH(request:Request){try{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new CampusEngineError("FORBIDDEN","Cross-origin vendor action refused.",403);await requireConsoleRole(request,["ADMIN","MODERATOR"]);const body=await request.json() as {vendorId?:unknown;providerId?:unknown;status?:unknown;note?:unknown};return Response.json({ok:true,vendor:await assignFoodVendor({vendorId:body.vendorId,providerId:body.providerId,status:body.status,note:body.note})},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
