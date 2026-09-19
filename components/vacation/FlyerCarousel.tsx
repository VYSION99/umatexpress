"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Megaphone, Phone } from "lucide-react";
import { composeRouteLine, noticeDestinations, type PublicNotice } from "@/lib/trip-notice";

/**
 * The official trip notices, one flyer per organisation, looping on the
 * vacationRide page. A single notice renders as the plain card it always was;
 * several notices get arrows, dots and a slow automatic rotation that stops for
 * hover, focus, a hidden tab and `prefers-reduced-motion`.
 */

const ROTATE_MS = 7000;

function FlyerNotice({ notice }: { notice: PublicNotice }) {
  const { promo } = notice;
  // Live coaches win over the saved text, so a fare card never advertises a
  // route the organiser retired.
  const routeLine = composeRouteLine(notice.routes) || promo.route;
  const destinations = promo.dropOffPoints.length ? promo.dropOffPoints : noticeDestinations(notice.routes);
  const showTimes = Boolean(promo.nightBus || promo.dayBuses.length);
  const showDetails = Boolean(destinations.length || promo.amenities.length);
  return (
    <article className="flyer-promo">
      <div className="flyer-main">
        <div className="flyer-head">
          <span><Megaphone size={15} /> Official trip notice</span>
          {!notice.platform && <em>{notice.organizerName}</em>}
        </div>
        {promo.title && <h2>{promo.title}</h2>}
        {routeLine && <p>{routeLine}</p>}
        {promo.fare && <strong>{promo.fare}</strong>}
      </div>
      {showTimes && <div className="flyer-times">
        {promo.nightBus && <article><span>Night bus</span><strong>{promo.nightBus}</strong></article>}
        {promo.dayBuses.length > 0 && <article><span>Day bus</span>{promo.dayBuses.map((line) => <strong key={line}>{line}</strong>)}</article>}
      </div>}
      {showDetails && <div className="flyer-details">
        {destinations.length > 0 && <div><span>Drop-off points</span><p>{destinations.join(" · ")}</p></div>}
        {promo.amenities.length > 0 && <div><span>Features and amenities</span><p>{promo.amenities.join(" · ")}</p></div>}
      </div>}
      {promo.contacts.length > 0 && <div className="flyer-contacts">
        {promo.contacts.map((contact) => {
          const phone = contact.match(/[+\d][\d\s-]{7,}/)?.[0]?.replace(/\s|-/g, "");
          return phone ? <a key={contact} href={`tel:${phone}`}><Phone size={14} /> {contact}</a> : <span key={contact}>{contact}</span>;
        })}
      </div>}
    </article>
  );
}

export default function FlyerCarousel({ notices }: { notices: PublicNotice[] }) {
  const count = notices.length;
  const [index, setIndex] = useState(0);
  const [onHold, setOnHold] = useState(false);
  const [hidden, setHidden] = useState(false);
  const touchStart = useRef<number | null>(null);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (count < 2 || onHold || hidden) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % count), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [count, onHold, hidden]);

  const go = useCallback((next: number) => setIndex(count ? (next + count) % count : 0), [count]);
  const safeIndex = count ? index % count : 0;

  if (!count) return null;
  if (count === 1) return <div className="flyer-carousel single"><FlyerNotice notice={notices[0]} /></div>;

  return (
    <section
      className="flyer-carousel"
      aria-roledescription="carousel"
      aria-label="Official trip notices"
      onPointerEnter={() => setOnHold(true)}
      onPointerLeave={() => setOnHold(false)}
      onFocusCapture={() => setOnHold(true)}
      onBlurCapture={() => setOnHold(false)}
      onTouchStart={(event) => { touchStart.current = event.touches[0].clientX; }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (start === null) return;
        const delta = event.changedTouches[0].clientX - start;
        if (Math.abs(delta) >= 40) go(safeIndex + (delta < 0 ? 1 : -1));
      }}
    >
      <div className="flyer-carousel-viewport">
        <div className="flyer-carousel-track" style={{ transform: `translateX(-${safeIndex * 100}%)` }}>
          {notices.map((notice, slide) => (
            <div
              className="flyer-carousel-slide"
              key={notice.id}
              aria-hidden={slide !== safeIndex}
              inert={slide === safeIndex ? undefined : true}
            >
              <FlyerNotice notice={notice} />
            </div>
          ))}
        </div>
      </div>
      <div className="flyer-carousel-controls">
        <button type="button" className="flyer-carousel-arrow" onClick={() => go(safeIndex - 1)} aria-label="Previous trip notice"><ChevronLeft size={17} /></button>
        <div className="flyer-carousel-dots">
          {notices.map((notice, dot) => (
            <button
              key={notice.id}
              type="button"
              className={dot === safeIndex ? "active" : ""}
              aria-label={`Show the trip notice from ${notice.organizerName}`}
              aria-current={dot === safeIndex ? "true" : undefined}
              onClick={() => go(dot)}
            />
          ))}
        </div>
        <button type="button" className="flyer-carousel-arrow" onClick={() => go(safeIndex + 1)} aria-label="Next trip notice"><ChevronRight size={17} /></button>
      </div>
      <span className="flyer-carousel-status" role="status">{safeIndex + 1} of {count} notices</span>
    </section>
  );
}
