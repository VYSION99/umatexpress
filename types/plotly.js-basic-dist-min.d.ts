/**
 * The Plotly basic bundle ships JavaScript without types. The whiteboard uses
 * four verbs from it and owns every trace it builds, so the declaration below
 * names exactly those rather than pulling the full Plotly type package in for a
 * library that is loaded as a separate chunk on demand.
 */
declare module "plotly.js-basic-dist-min" {
  export type PlotlyTrace = Record<string, unknown>;
  export type PlotlyLayout = Record<string, unknown>;
  export type PlotlyConfig = Record<string, unknown>;
  export function newPlot(element: HTMLElement, data: PlotlyTrace[], layout?: PlotlyLayout, config?: PlotlyConfig): Promise<unknown>;
  export function react(element: HTMLElement, data: PlotlyTrace[], layout?: PlotlyLayout, config?: PlotlyConfig): Promise<unknown>;
  export function resize(element: HTMLElement): Promise<unknown>;
  export function purge(element: HTMLElement): void;
}
