# The quality bar for mocks

A mock is judged the way the shipped product will be: by how it looks. Hold it to
production standards. If the `impeccable` skill is installed, its shared design laws and
register references (`brand.md` for marketing pages, `product.md` for app UI) apply in
full and win over anything here. This file is the short version plus what is specific to
mocking.

## Before the first screen

- **Scene sentence first.** Theme, density and contrast follow from it. Write it down.
- **Color strategy, then colors.** Restrained (tinted neutrals plus one accent at 10% or
  less), committed (one color carries 30–60% of the surface), full palette, or drenched.
  Product UI is usually restrained; a brand page often isn't.
- **Avoid the category reflex.** Observability is not automatically dark blue, healthcare is
  not white and teal, finance is not navy and gold. If the palette is guessable from the
  category, rework the scene sentence.
- **Borrow from the real world.** The best systems have a referent: Tidewater's only signal
  color is the red-over-yellow of a lifeguard flag, so status reads the way the beach does.

## Tokens

- OKLCH. Tint every neutral toward the brand hue (chroma 0.005–0.02). Never `#000`/`#fff`.
- Lower chroma as lightness nears 0 or 100.
- Check text contrast while choosing: 4.5:1 for body text, 3:1 for large text. A mid-light
  gray "secondary text" color is the most common failure; test it on every surface it sits on.
- One type scale, steps at least 1.2× apart, named by size (`--text-sm` … `--text-5xl`).
  Hierarchy comes from scale and weight contrast together.
- A 4px spacing scale with enough large steps (64, 96, 128) for page-level rhythm.
- Platform type: on iOS, SF for text (`-apple-system`); a brand face for display only, if at all.

## Layout

- Vary spacing for rhythm; identical padding everywhere reads as a template.
- Cards only when they're the best affordance. Never nest cards. Most things need no container.
- Left-aligned, asymmetric compositions usually beat a centered hero stack.
- Cap line length around 65–75ch for body copy.
- Phones: 44pt minimum tap targets, content padded by the safe areas, one primary action
  per screen within thumb reach.

## Never

- Side-stripe borders (a thick colored `border-left` on a card or alert).
- Gradient text.
- Glass blur as decoration.
- The hero-metric template: a giant number, a small label, three supporting stats, a gradient.
- Rows of identical icon-heading-text cards.
- A modal where inline or progressive disclosure would do.
- Em dashes or `--` in copy. Lorem ipsum. Copy that restates the heading.
- Inline styles in screens. Raw values outside `tokens.css`.

`dc lint` catches the mechanical ones; the Audit tab catches off-scale values, contrast and
tap targets; the rest is your eye. Look at every screen at 100% before showing it.

## Interaction states

Every pressable component has four, designed as carefully as its rest state:

- **Hover**: a small, certain change (a shade darker fill, an underline, a color shift).
  Not a lift-and-shadow on everything.
- **Focus**: a visible ring, 2px, offset, in a color that contrasts with every surface it sits
  on. One global `:focus-visible` rule is fine; never `outline: none` without a replacement.
- **Pressed**: immediate. Darker, or a 0.97–0.98 scale on touch targets.
- **Disabled**: clearly unavailable without disappearing: a fill and ink step toward the
  background, `cursor: not-allowed`, and still readable (it's still text).

Switch an element to each state on the canvas and look at it, the way the user will.

## Motion

Motion is part of the design system, not decoration added at the end.

- **It explains something.** Where a screen came from (push, sheet), what is new (an entrance),
  what responded to a touch (press). If it explains nothing, remove it.
- **Timing comes from the scene.** A swimmer with cold hands needs things fast and settled;
  a meditation app can breathe. Set `--duration-fast` (~120–160ms, feedback),
  `--duration-base` (~220–300ms, entrances), `--duration-slow` (~360–450ms, screen
  transitions) from that, and use nothing else.
- **Ease out, exponentially.** `cubic-bezier(0.22, 1, 0.36, 1)` or similar for arrivals;
  `in-out` for things that move across the screen. No bounce, no elastic, no overshoot.
- **Transform and opacity only.** Never animate width, height, top, left, margin or padding.
- **Stagger in reading order, briefly.** 30–60ms between blocks, a screen's whole entrance
  done within ~500ms. Three or four slots, not one per row.
- **Small distances.** Entrances move 8–16px, not across the screen.
- **Respect reduced motion.** The kit swaps every entrance for a short fade; check it with the
  player's Reduce motion switch.
- Play it with the prototype player at ×4 slow motion to see the curve, not just the result.

## Responsive

- Design the narrow widths, don't just let them happen. Each web screen shows at its
  breakpoints next to the desktop frame; look at each.
- Reflow, don't shrink: grids become single columns, side-by-side becomes stacked, secondary
  navigation folds away. Type steps down the scale at the breakpoint (a 96px headline becomes
  64, then 46), it doesn't scale linearly.
- Nothing scrolls sideways (the audit errors on it), and tap targets stay 44pt on phone widths.

## States are screens

A screen with data has at least: loading, empty, error, and the normal state. Forms have
idle, submitting, invalid and failed. Mock the ones the user would notice as separate
screens with `"state"` and `"of"`. The empty state is often the first thing a new user sees;
give it real copy and a clear next step.
