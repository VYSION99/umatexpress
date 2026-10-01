import { stayRequestRoute } from "@/lib/hostel-engine/stay-request-http";
export function GET(request:Request){return stayRequestRoute(request,"STAFF",true);}
export function PATCH(request:Request){return stayRequestRoute(request,"STAFF",true);}
