import { maintenanceRoute } from '@/lib/hostel-engine/maintenance-http';
export const GET = (request: Request) => maintenanceRoute(request, 'STUDENT');
export const POST = (request: Request) => maintenanceRoute(request, 'STUDENT');
export const PATCH = (request: Request) => maintenanceRoute(request, 'STUDENT');
