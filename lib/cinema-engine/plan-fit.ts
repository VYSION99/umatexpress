export type CinemaPlaylistNeeds = { files: number; bytes: number; minutes: number };

type ComparablePlan = CinemaPlaylistNeeds & {
  code: string;
  checkoutPesewas: number;
  available: boolean;
  eligible: boolean;
};

export function findCinemaPlanFit<T extends ComparablePlan>(
  plans: readonly T[],
  currentCode: string,
  needs: CinemaPlaylistNeeds,
  perFile: Pick<CinemaPlaylistNeeds, "bytes" | "minutes">,
) {
  if (needs.bytes / needs.files > perFile.bytes || needs.minutes / needs.files > perFile.minutes) {
    return { kind: "file-limit" } as const;
  }
  const fits = plans.filter(plan => plan.files >= needs.files && plan.bytes >= needs.bytes && plan.minutes >= needs.minutes);
  const current = fits.find(plan => plan.code === currentCode);
  if (current) return { kind: "current", plan: current } as const;

  const cheapest = (items: T[]) => items.sort((left, right) => left.checkoutPesewas - right.checkoutPesewas)[0];
  const open = fits.filter(plan => plan.available);
  const eligible = cheapest(open.filter(plan => plan.eligible));
  if (eligible) return { kind: "recommended", plan: eligible } as const;
  const restricted = cheapest(open);
  if (restricted) return { kind: "approval", plan: restricted } as const;
  return { kind: fits.length ? "closed" : "no-fit" } as const;
}
