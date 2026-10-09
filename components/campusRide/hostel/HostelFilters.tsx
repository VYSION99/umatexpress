"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal } from "@/components/ui/MaterialIcon";

export type HostelFilterValues = {
  q?: string;
  periodId: string;
  maxDistance: string;
  maxPrice: string;
  minSpaces: string;
  utilities: boolean;
  sort: string;
};

type PeriodOption = { id: string; name: string };

/**
 * The browse filters. This is a real GET form first — without JavaScript it
 * still submits to `/hostel` — and the enhanced form applies all filters together through client navigation.
 */
export function HostelFilters({ periods, value, matchCount }: { periods: PeriodOption[]; value: HostelFilterValues; matchCount: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    new FormData(event.currentTarget).forEach((entry, key) => {
      if (String(entry).trim()) params.set(key, String(entry).trim());
    });
    startTransition(() => router.push(`/hostel?${params}`, { scroll: false }));
  }
  return <form key={JSON.stringify(value)} className="hostel-filters" action="/hostel" method="get" onSubmit={submit} aria-busy={pending}>
    <div className="hostel-filters-head">
      <SlidersHorizontal size={16} aria-hidden />
      <strong>Find your next home</strong>
      <span>{matchCount} {matchCount === 1 ? "home" : "homes"} match</span>
    </div>
    <label className="hostel-search"><span>Hostel name or area</span><input type="search" name="q" maxLength={100} defaultValue={value.q || ""} placeholder="Search by name or neighbourhood" /></label>
    <button type="button" className="hostel-filter-toggle" aria-expanded={expanded} aria-controls="hostel-filter-options" onClick={() => setExpanded(!expanded)}>Filters & academic year</button>
    <div id="hostel-filter-options" className={`hostel-filter-grid${expanded ? " is-expanded" : ""}`}>
      <noscript><style>{`.hostel-filter-grid{display:grid!important}`}</style></noscript>
      <label>
        <span>Academic year</span>
        <select name="periodId" defaultValue={value.periodId}>
          {periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}
        </select>
      </label>
      <label>
        <span>Distance</span>
        <select name="maxDistance" defaultValue={value.maxDistance}>
          <option value="">Any distance</option>
          <option value="500">Under 500 m</option>
          <option value="1000">Under 1 km</option>
          <option value="2000">Under 2 km</option>
          <option value="5000">Under 5 km</option>
        </select>
      </label>
      <label>
        <span>Yearly budget</span>
        <select name="maxPrice" defaultValue={value.maxPrice}>
          <option value="">Any budget</option>
          <option value="100000">Under GH₵ 1,000</option>
          <option value="200000">Under GH₵ 2,000</option>
          <option value="300000">Under GH₵ 3,000</option>
          <option value="500000">Under GH₵ 5,000</option>
        </select>
      </label>
      <label>
        <span>Beds free</span>
        <select name="minSpaces" defaultValue={value.minSpaces}>
          <option value="">Any number</option>
          <option value="2">Two or more</option>
          <option value="5">Five or more</option>
        </select>
      </label>
      <label>
        <span>Order by</span>
        <select name="sort" defaultValue={value.sort}>
          <option value="name">Name</option>
          <option value="distance">Closest to campus</option>
          <option value="price">Cheapest first</option>
        </select>
      </label>
      <label className="hostel-filter-check">
        <input type="checkbox" name="utilities" value="1" defaultChecked={value.utilities} />
        <span>Utilities in total</span>
      </label>
    </div>
    <div className="hostel-filter-actions"><button type="submit" className="hostel-filter-apply" disabled={pending}>{pending ? "Finding homes…" : "Show homes"}</button><Link href={`/hostel?periodId=${encodeURIComponent(value.periodId)}`} scroll={false}>Reset filters</Link><span role="status">{pending ? "Updating results…" : ""}</span></div>
  </form>;
}
