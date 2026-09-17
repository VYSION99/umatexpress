import { getCampusData } from "@/lib/campus-ride";

export async function GET() {
  const data = await getCampusData();
  return Response.json({ zones: data.zones, corridors: data.corridors });
}

