import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { cancelFoodPreorder, createFoodPreorder, listStudentFoodPreorders } from "@/lib/food/preorders";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const headers={"Cache-Control":"no-store"};
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new CampusEngineError("FORBIDDEN","Cross-origin preorder action refused.",403);}
export async function GET(request:Request){try{const student=await requireStudent(request);return Response.json({orders:await listStudentFoodPreorders(student.id)},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
export async function POST(request:Request){try{sameOrigin(request);const student=await requireStudent(request);const limited=await rateLimit(request,"food-preorder-create",{limit:10,windowMs:60*60_000});if(!limited.ok)return rateLimitResponse(limited.retryAfter);const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,order:await createFoodPreorder(body,student)},{status:201,headers});}catch(error){const failure=campusErrorPayload(error instanceof SyntaxError?new CampusEngineError("VALIDATION_ERROR","Enter the pickup request.",400):error);return Response.json(failure.body,{status:failure.status,headers});}}
export async function PATCH(request:Request){try{sameOrigin(request);const student=await requireStudent(request);const body=await request.json() as {id?:unknown};return Response.json({ok:true,order:await cancelFoodPreorder(body.id,student)},{headers});}catch(error){const failure=campusErrorPayload(error);return Response.json(failure.body,{status:failure.status,headers});}}
