/**
 * Provider-neutral contracts for Cinema broadcasts.
 *
 * The event catalogue, RSVP system, Durable Object and audience tools remain
 * provider-independent. Adapters translate these small commands into YouTube
 * or Cloudflare Stream API calls; provider credentials never cross this layer
 * into a browser component.
 */

export const STREAMING_PROVIDER_IDS = ["YOUTUBE", "CLOUDFLARE_STREAM"] as const;
export type StreamingProviderId = (typeof STREAMING_PROVIDER_IDS)[number];

export const BROADCAST_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;
export type BroadcastVisibility = (typeof BROADCAST_VISIBILITIES)[number];

export const BROADCAST_STATUSES = ["DRAFT", "READY", "LIVE", "ENDED", "FAILED"] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export type StreamingProviderCapabilities = {
  publicPlayback: boolean;
  privatePlayback: boolean;
  signedPlayback: boolean;
  managedLiveInputs: boolean;
  recording: boolean;
  providerUsage: boolean;
};

export type BroadcastCreateInput = {
  eventId: string;
  title: string;
  visibility: BroadcastVisibility;
  startsAt: string;
  expectedDurationMinutes: number;
  recordingEnabled: boolean;
};

export type BroadcastRecord = {
  provider: StreamingProviderId;
  providerBroadcastId: string;
  status: BroadcastStatus;
  playbackId: string;
  playbackUrl: string;
  /** Server-only ingest details. Never serialize this field to an audience response. */
  ingest?: { protocol: "RTMPS" | "SRT" | "WHIP"; url: string; key?: string };
};

export type PlaybackAccess = {
  provider: StreamingProviderId;
  playbackUrl: string;
  expiresAt: string | null;
  headers?: Record<string, string>;
};

export type ProviderUsageWindow = {
  from: string;
  to: string;
  deliveredMinutes: number;
  storedMinutes: number;
  /** The provider's immutable usage or invoice reference, when supplied. */
  providerReference: string;
};

export interface StreamingProvider {
  readonly id: StreamingProviderId;
  readonly capabilities: StreamingProviderCapabilities;
  createBroadcast(input: BroadcastCreateInput): Promise<BroadcastRecord>;
  readBroadcast(providerBroadcastId: string): Promise<BroadcastRecord>;
  endBroadcast(providerBroadcastId: string): Promise<BroadcastRecord>;
  deleteBroadcast(providerBroadcastId: string): Promise<void>;
  readUsage(providerBroadcastId: string, window: { from: string; to: string }): Promise<ProviderUsageWindow | null>;
}

export interface BroadcastController {
  create(input: BroadcastCreateInput & { provider: StreamingProviderId }): Promise<BroadcastRecord>;
  end(eventId: string, actorId: string): Promise<BroadcastRecord>;
}

export interface StreamAccessManager {
  issue(eventId: string, viewerId: string): Promise<PlaybackAccess>;
  revoke(eventId: string, viewerId: string): Promise<void>;
}

export interface StreamUsageTracker {
  reconcile(eventId: string, window: { from: string; to: string }): Promise<ProviderUsageWindow>;
}

export interface StreamingCostCalculator<TInput, TEstimate> {
  estimate(input: TInput): TEstimate;
}

