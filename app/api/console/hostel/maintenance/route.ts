import { maintenanceRoute } from '@/lib/hostel-engine/maintenance-http';
export const GET = (request: Request) => maintenanceRoute(request, 'STAFF');
export const PATCH = (request: Request) => maintenanceRoute(request, 'STAFF');
