import { maintenanceFileRoute } from '@/lib/hostel-engine/maintenance-http';
export async function GET(request: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
 return maintenanceFileRoute(request, "STUDENT", (await params).attachmentId);
}
