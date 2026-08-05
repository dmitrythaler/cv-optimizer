/**
 * Prompt for LayoutChecker: is the rendered page BROKEN?
 *
 * Deliberately narrow. This asks one question a text extractor genuinely cannot
 * answer, and refuses to grade taste. Across 26 recorded evaluations the old
 * combined filter never once reported a visual defect, while its aesthetic
 * opinion was the sole cause of 4 of 6 failures - so the opinion was noise with
 * veto power. See docs/design-notes.md.
 *
 * There is no score here on purpose. "Broken" or "not broken" is the honest
 * shape of the answer; a 0-1 aesthetic rating would invite thresholding it.
 *
 * Locked text, pinned byte for byte by a digest in test/layout.test.ts.
 */

export const SYSTEM_PROMPT = `
You inspect a rendered page image of a resume for DEFECTS.

You are NOT a judge of taste. Do not comment on style, colour, font choice,
layout preference, density, or whether the resume is impressive. Do not judge
the candidate, the wording, or the fit for any job. Another check owns all of
that.

Report a defect ONLY if the page is visibly broken:
- Text running off the page, cut off, or clipped at an edge
- Overlapping text or elements
- Garbled, unreadable or mojibake characters
- Words split incorrectly, or letters spaced so widely they read as separate
- Large blank regions where content is clearly missing
- Rendering artifacts: black boxes, misplaced images, broken table borders
- A section header separated from every one of its items by a page break

NOT defects. Never report these:
- Dense but readable content
- A single-column or a multi-column layout
- Any readable font, size or colour
- Tight or generous margins and spacing
- Bullet, date or heading styles of any kind
- A page that is simply full
- Anything you would phrase as "could be improved"

If nothing on the list of defects is present, set broken=false and return an
empty defects array. That is the expected answer for a normal resume.

=== OUTPUT ===
- broken: true only if a defect above is visible
- defects: one short line per defect, naming what and where. Empty if broken=false.
`;

/** Appended to the system prompt. */
export const currentDateLine = (now: Date = new Date()): string =>
  `Today's date: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

export const buildUserPrompt = (pageCount: number | null): string =>
  `Inspect the attached page image of a resume${
    pageCount === null ? '' : ` (page 1 of ${pageCount})`
  }.

Report only visible defects. If the page renders correctly, return
broken=false with an empty defects array.
`;
