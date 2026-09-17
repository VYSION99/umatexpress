export const TRAVEL_DATE = "2026-09-05";

export const trips = [
  { id: 1, from: "UMaT Main Campus", to: "Accra", time: "6:30 AM", arrival: "11:30 AM", price: 180, tag: "Morning Express" },
  { id: 2, from: "UMaT Main Campus", to: "Accra", time: "1:00 PM", arrival: "6:00 PM", price: 180, tag: "Afternoon Express" },
] as const;

export function getTrip(id: number) {
  return trips.find((trip) => trip.id === id);
}

export function isValidTravelDate(value: unknown): value is string {
  return value === TRAVEL_DATE;
}

export function formatTime(value: string) {
  const [hourText, minute = "00"] = value.split(":");
  const hour = Number(hourText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}
