// Footer rendering, kept separate so the worker and any future preview
// surface share one implementation (and so it's unit-testable without
// spinning up the worker).
//
// Three configurations per scope (mirrored in pending_reviews):
//   - NULL      → DEFAULT_FOOTER_TEMPLATE
//   - ''        → no footer at all
//   - other     → that string, with substitutions applied

import type { Verdict } from './format.ts';
import type { PostedEvent } from '../db/reviews.ts';

export const DEFAULT_FOOTER_TEMPLATE =
  '_Reviewed by arbiter · scrutiny: `{{scrutiny}}` · mode: `{{mode}}` · verdict: `{{verdict}}` · posted as: `{{posted_as}}`_';

export type FooterContext = {
  scrutiny: string;
  mode: string;
  verdict: Verdict;
  postedEvent: PostedEvent;
};

/**
 * Resolve the footer template for a scope. Returns null if no footer
 * should be appended; otherwise returns the rendered string.
 */
export function renderFooter(
  template: string | null,
  ctx: FooterContext,
): string | null {
  if (template === '') return null;
  const tmpl = template ?? DEFAULT_FOOTER_TEMPLATE;
  return tmpl
    .replaceAll('{{scrutiny}}', ctx.scrutiny)
    .replaceAll('{{mode}}', ctx.mode)
    .replaceAll('{{verdict}}', ctx.verdict)
    .replaceAll('{{posted_as}}', ctx.postedEvent);
}

/**
 * Combine the review body with the rendered footer (separated by a horizontal
 * rule). If the footer is disabled, returns body unchanged.
 */
export function stampReviewBody(
  body: string,
  template: string | null,
  ctx: FooterContext,
): string {
  const footer = renderFooter(template, ctx);
  if (!footer) return body;
  return `${body}\n\n---\n${footer}`;
}
