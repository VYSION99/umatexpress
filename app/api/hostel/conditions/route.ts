import { conditionRoute } from '@/lib/hostel-engine/condition-http';
export const GET = (request: Request) => conditionRoute(request, 'STUDENT');
export const POST = (request: Request) => conditionRoute(request, 'STUDENT');
export const PATCH = (request: Request) => conditionRoute(request, 'STUDENT');
