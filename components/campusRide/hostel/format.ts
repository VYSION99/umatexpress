/** Money and distance, said the same way on every hostel surface. */

const grouped = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Pesewas to a student's money: GH₵1,200 rather than GH₵1,200.00. */
export function cedis(pesewas: number) {
  const value = Number(pesewas || 0) / 100;
  return `GH₵ ${grouped(value.toFixed(2).replace(/\.00$/, ""))}`;
}

export function bedsLabel(count: number) {
  return `${count} bed${count === 1 ? "" : "s"} available`;
}

export function distanceLabel(distanceM: number | null) {
  if (distanceM === null || !Number.isFinite(distanceM)) return "Distance not set";
  if (distanceM < 1000) return `${Math.round(distanceM)} m from campus`;
  return `${(distanceM / 1000).toFixed(distanceM < 10_000 ? 1 : 0)} km from campus`;
}
