import type { TourDefinition } from "./types";

export const LAUNCHER_TOUR: TourDefinition = {
  id: "launcher",
  title: "Welcome to UMaTeXPRESS",
  autoStartOnFirstVisit: true,
  steps: [
    {
      id: "curiosity",
      targetSelector: '[data-tour="curiosity-pilot"]',
      title: "Campus Curiosity AI",
      content: "Your campus co-pilot. Get smart recommendations for meals, ride schedules, study spots, and campus weather.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "bell",
      targetSelector: '[data-tour="launcher-bell"]',
      title: "Updates & Live Feed",
      content: "Check ride arrival alerts, quote confirmations, and hostel messages. Reading notifications here saves SMS credits automatically.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "campusride",
      targetSelector: '[data-tour="service-campus"]',
      title: "CampusRide Shuttle",
      content: "Hop on verified campus shuttles. Track drivers arriving in real-time and coordinate pickup with 1-tap curbside chat.",
      placement: "top",
      mobilePlacement: "bottom",
    },
    {
      id: "hostels",
      targetSelector: '[data-tour="service-hostel"]',
      title: "Verified Hostel Finder",
      content: "Browse student-approved hostels near UMaT. Check live bed vacancies, room amenities, and send direct viewing requests.",
      placement: "top",
      mobilePlacement: "bottom",
    },
    {
      id: "account",
      targetSelector: '[data-tour="launcher-profile"]',
      title: "Student Account & Claims",
      content: "Link your @st.umat.edu.gh student email to unlock student discounts, ticket recovery on any device, and passkey login.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
  ],
};

export const CAMPUS_TICKET_TOUR: TourDefinition = {
  id: "campus-ticket",
  title: "Your Ride & Curbside Coordination",
  autoStartOnFirstVisit: true,
  steps: [
    {
      id: "live-progress",
      targetSelector: '[data-tour="ticket-progress"]',
      title: "Live Ride Milestones",
      content: "Follow your driver's status in real-time from Accepted to Arrived and Boarded.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "boarding-pin",
      targetSelector: '[data-tour="ticket-pin"]',
      title: "Boarding Security PIN",
      content: "Show this 4-digit PIN to your driver when getting in to verify your seat.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "curbside-chat",
      targetSelector: '[data-tour="ticket-chat"]',
      title: "Curbside Driver Chat",
      content: "Coordinate pickup with your driver using 1-tap quick chips ('Waiting by the signpost', 'On my way') with zero spam.",
      placement: "top",
      mobilePlacement: "top",
    },
  ],
};

export const HOSTEL_TOUR: TourDefinition = {
  id: "hostel",
  title: "Hostel Discovery Guide",
  autoStartOnFirstVisit: false,
  steps: [
    {
      id: "period-select",
      targetSelector: '[data-tour="hostel-periods"]',
      title: "Academic Period",
      content: "Choose your target academic year to see available beds for that term.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "filters",
      targetSelector: '[data-tour="hostel-filters"]',
      title: "Search & Distance",
      content: "Filter by walking distance to UMaT, price range, and utility inclusions.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
  ],
};

export const PRINT_COPY_TOUR: TourDefinition = {
  id: "print-copy",
  title: "Print & Copy Quotes",
  autoStartOnFirstVisit: false,
  steps: [
    {
      id: "quote-btn",
      targetSelector: '[data-tour="print-quote-trigger"]',
      title: "Request a Custom Quote",
      content: "Tell campus print shops your document size, color, and spiral binding needs for an upfront price estimate.",
      placement: "bottom",
      mobilePlacement: "bottom",
    },
    {
      id: "my-quotes",
      targetSelector: '[data-tour="print-my-quotes"]',
      title: "In-App Staff Discussion",
      content: "Track status updates and chat directly with print shop operators inside your quote cards.",
      placement: "top",
      mobilePlacement: "top",
    },
  ],
};

export const TOURS: Record<string, TourDefinition> = {
  launcher: LAUNCHER_TOUR,
  "campus-ticket": CAMPUS_TICKET_TOUR,
  hostel: HOSTEL_TOUR,
  "print-copy": PRINT_COPY_TOUR,
};
