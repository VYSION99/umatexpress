"use client";

import { MapPin } from "@phosphor-icons/react";

export function MapStatus({ loading, error, disabled, onRetry }: { loading: boolean; error: string; disabled: boolean; onRetry: () => void }) {
  if (disabled) return <div className="real-map-disabled" role="status"><MapPin size={20} aria-hidden /><span>Map view is currently turned off.</span></div>;
  if (error) return <div className="real-map-error" role="alert"><MapPin size={22} aria-hidden /><span>{error}</span><button type="button" className="map-retry" onClick={onRetry}>Retry map</button></div>;
  return loading ? <div className="real-map-loading" role="status"><MapPin size={22} aria-hidden /><span>Loading map…</span></div> : null;
}
