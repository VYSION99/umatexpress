"use client";

import { useRef, type ChangeEvent } from "react";
import { SlidersHorizontal } from "lucide-react";

export type HostelFilterValues = {
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
 * still submits to `/hostel` — and a change on any dropdown applies immediately
 * when the browser can run one line of script.
 */
export function HostelFilters({ periods, value, matchCount }: { periods: PeriodOption[]; value: HostelFilterValues; matchCount: number }) {
  const formRef = useRef<HTMLFormElement>(null);
  const applyOnChange = (event: ChangeEvent<HTMLFormElement>) => {
    if (event.target instanceof HTMLSelectElement) formRef.current?.requestSubmit();
  };
  return <form ref={formRef} className="hostel-filters" action="/hostel" method="get" onChange={applyOnChange}>
    <div className="hostel-filters-head">
      <SlidersHorizontal size={16} aria-hidden />
      <strong>Filter the map</strong>
      <span>{matchCount} {matchCount === 1 ? "home" : "homes"} match</span>
    </div>
    <div className="hostel-filter-grid">
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
        <span>Utilities included</span>
      </label>
    </div>
    <button type="submit" className="hostel-filter-apply">Show homes</button>
  </form>;
}
