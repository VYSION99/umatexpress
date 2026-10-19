import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { saveFoodPreorderSettings } from "@/lib/food/preorders";

const headers={"Cache-Control":"no-store"};
export async function PUT(request:Request){try{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new CampusEngineError("FORBIDDEN","Cross-origin preorder setting refused.",403);const account=await requireConsoleRole(request,["ADMIN","MODERATOR"]);const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,settings:await saveFoodPreorderSettings(body.providerId,body,account.email)},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
