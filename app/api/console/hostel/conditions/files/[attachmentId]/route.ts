import { conditionRoute } from '@/lib/hostel-engine/condition-http';
export async function GET(request: Request, context: { params: Promise<{attachmentId: string}> }) { return conditionRoute(request, 'STAFF', 'photo', (await context.params).attachmentId); }
