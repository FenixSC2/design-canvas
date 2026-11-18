---
name: design-canvas
description: >-
  Design every screen of a website or app as a real, editable mock before building it: HTML and
  CSS on one shared token set, rendered in device frames (desktop browser, iPhone, Android) on a
  local canvas. The user selects any element, edits text, swaps tokens, drags to reorder,
  resizes, sketches placeholders and pins comments, then presses Send; the agent gets exact ops
  against stable element ids, applies them in the source, and the canvas reloads. A live audit
  flags off-scale type, color and spacing, low contrast and small tap targets. Use it whenever
  the user wants to design, mock up, lay out or iterate on the UI of a site, landing page, web
  app, dashboard or mobile app before (or instead of) building it; wants to see screens rather
  than read about them; wants to point at an element and say "change this"; or mentions the
  design canvas, mocks, artboards, the Audit tab or hitting Send on a design.
---

# Design Canvas

Users judge software by what they see. Agents tend to build the UI last and fastest, so it
ends up generic, inconsistent from screen to screen, and only reviewable after the code is
written. This skill puts the UI first. Every screen is mocked in real HTML and CSS on a local
canvas, the user changes it directly, and the result becomes the spec the build has to match.

- **Mocks are real HTML and CSS, not pictures.** You write them with the same craft you would
  use for production UI, so what the user approves is what can be built.
- **Tokens are the only place raw values live.** Colors, type sizes, spacing and radii come
  from `tokens.css`, and screens and components use `var(--…)`. The inspector offers only
  tokens as choices, and the Audit tab flags anything on screen that isn't one. Consistency
  comes from this, not from good intentions.
- **One definition per component.** If two screens show a button, both use `.btn` from
  `components.css`. When the user changes one instance, you decide whether the component
  changes everywhere, and you say which you chose.
- **Every element the user can point at has a `data-id`.** IDs are stable: renaming changes
  text, never the id. The user's edits arrive as ops against these ids, so there is nothing to
  misinterpret.
- **The user edits, you craft.** Text, deletes, reorders and duplicates are applied to the
  source mechanically. Style, resize and sketch ops are the user's intent, and you express
  them properly in the design system.
- **Questions go on the canvas.** When you need the user to decide something about a
  specific element, pin it there with `ask` instead of ending a chat reply with a question.

## What's in this skill

Paths are relative to this skill's directory, written `<skill>`.

| Path | Read it when |
|---|---|
| `references/format.md` | Before writing your first design: design.json, screen fragments, ids, comments, changeset ops. |
| `references/craft.md` | Before drafting tokens or screens: the quality bar and the mistakes to avoid. |
| `examples/tidewater/design/` | Before drafting: a complete project (web landing page plus four iOS screens). Match its structure. |
| `kit/ios.css`, `kit/android.css` | When mocking a native app: the kit classes and the SwiftUI / Compose names they map to. |
| `scripts/canvas.mjs` | The CLI you run (below). |
| `gui/` | The canvas. You start it with the CLI; you don't need to read its code. |

### The CLI

Run it as `node <skill>/scripts/canvas.mjs <command> <design-dir>` (Node 20+, no install
step). Below, `dc` stands for that whole prefix; write it out each time.

| Command | Does |
|---|---|
| `dc init <dir> [--name N] [--device D]` | Scaffolds `design.json`, `tokens.css`, `components.css` and one screen. |
| `dc serve <dir> [--port N]` | Starts the canvas (foreground: run it in the background) and prints its URL. Reuses a canvas already serving this dir. |
| `dc wait <dir> [--timeout S]` | Blocks until the user presses Send, then prints the changeset. Exit 2 on timeout. |
| `dc show <dir>` | Prints the pending changeset with file lines and a to-do list. |
| `dc apply <dir>` | Applies text, remove, move and duplicate ops to the screen files and prints what's left for you. The canvas shows "agent working". |
| `dc done <dir> --summary "…"` | Lints, then releases the design. The canvas reloads and shows your summary. Refuses on lint errors. |
| `dc lint <dir>` | Static checks: tokens, ids, banned patterns, raw values, sketches, copy. |
| `dc reply <dir> <thread> "…" [--resolve]` | Answers a comment thread; the user sees it on the pin. |
| `dc ask <dir> <screen> <data-id\|-> "…"` | Pins your question on an element for the user. |
| `dc comments <dir> [--all]` | Lists threads and whose turn each is. |
| `dc spec <dir> [screen]` | The component tree per screen: ids, tags, classes, native component names, copy, links. |
| `dc status <dir>` | Canvas URL, pending changeset, open comments. |

## Where the design lives

In the user's project, at `design/` (or the folder they name). It is a project artifact:
commit it. Add `design/.canvas/` and `design/changeset*.json` to `.gitignore`.

## Workflow

```
request → ground (impeccable) → tokens → components → screens → self-audit ─┐
                                                                            ▼
                     serve → user edits, comments, Send → apply → craft → done ─┐
                                  ▲                                             │
                                  └────────────── until the user is happy ─────┘
                                                                            ▼
                                    spec → build from the mocks → compare to the mocks
```

### 1. Ground the design before drawing anything

Quality is decided before the first screen. If the `impeccable` skill is available, run its
setup now (load PRODUCT.md / DESIGN.md, pick the register, read `brand.md` or `product.md`)
and follow its shared design laws throughout. Either way:

1. Write the **scene sentence**: who uses this, where, in what light, in what mood. Put it in
   `design.json` as `scene` and at the top of `tokens.css`. It decides light vs dark, density
   and contrast. "Dashboard for SREs" decides nothing; "SRE checking an incident at 2am on a
   27-inch monitor in a dark room" does.
2. Pick a **color strategy** (restrained, committed, full palette, drenched) and a type pairing
   that isn't the category reflex. If someone could guess your palette from the product
   category alone, choose again.
3. Write `tokens.css`: tinted neutrals (no `#000`/`#fff`), roles (`--color-ink`,
   `--color-surface`, `--color-accent`…), one type scale with steps at least 1.2× apart, a 4px
   spacing scale, a few radii. Use OKLCH. Platform overrides go in selectors like
   `html[data-platform="ios"] { … }`. See `references/craft.md`.
4. Write `components.css`: every repeated pattern once (buttons, fields, badges, rows,
   cards if you truly need them), using tokens only.

If the user already has a design system (a DESIGN.md, a Tailwind config, a theme file, an
existing site), extract its values into `tokens.css` instead of inventing new ones.

### 2. Draft the screens

1. **List every screen and state**, including the unglamorous ones: empty, loading, error,
   signed-out, the confirmation, the 404. A state of another screen gets `"state"` and
   `"of"` in `design.json` and draws underneath it. Pick the device per screen: `desktop`,
   `laptop`, `tablet`, `mobile-web`, `iphone`, `android`.
2. **Write each screen as an HTML fragment** in `screens/<id>.html`: no `<html>`/`<head>`;
   the canvas wraps it with the kit, tokens, components and fonts.
   - A `data-id` on the screen root and on every element the user might select: sections,
     cards, rows, headings, text, buttons, inputs, images. Dotted ids by area
     (`today.primary.temp`). Put text that should be editable in its own element with an id.
   - `data-component` on anything that maps to a named component in the real codebase
     (`NavigationStack`, `List`, `Sheet`, `PricingTable`). It's the bridge to the build.
   - `data-goto="<screen id>"` on anything that navigates, so Preview mode clicks through.
   - Real copy, written for this product. No lorem ipsum, no em dashes.
   - Inline SVG for icons and charts; no external images unless the project has them.
3. **For native apps**, use the kit classes (`ios-screen`, `ios-scroll`, `ios-nav`,
   `ios-list`, `ios-row`, `ios-tabbar`, `ios-sheet`, `ios-segmented`, `ios-switch`; `md-*`
   on Android). They carry the platform's metrics (44pt rows, 49pt tab bar) and take colors
   from your tokens. Don't draw the status bar, notch or home indicator: the device frame
   does. Pad with `var(--safe-top)` / `var(--safe-bottom)`.
4. Write files directly; there is no builder script. Keep markup tidy and indented: the
   CLI splices edits into it.

### 3. Check your own work before the user sees it

1. `dc lint <dir>` until there are no errors. Fix warnings, or accept one deliberately and
   say why.
2. `dc serve <dir>` in the background, open the URL in a browser, and read the **Audit**
   tab: off-scale type, colors, spacing and radii; contrast below WCAG AA; tap targets under
   44pt on phones. Fix the source, not the audit. A finding inside a kit component is
   exempt; one in your components is yours.
3. Look at every screen at 100% zoom and critique it as a designer would (impeccable's
   `critique` if available). Squint test: is the hierarchy obvious? Is anything generic?
   Fix before showing.

### 4. Review on the canvas

1. Tell the user the URL and where to start. Name the screens in a line, and say they can
   click anything to edit it, double-click text, drag the round grip to reorder, use the
   square handles to resize, press C to pin a comment, P to click through, and Send when
   done.
2. Pin the two to five decisions that matter most with `dc ask` on the element they concern,
   each with the options and your pick in one or two sentences. Mention them in chat.
3. Run `dc wait <dir>` in the background so you're notified on Send, and end your turn. If
   you can't run background commands, ask the user to tell you when they've sent, then
   run `dc show`.

If the user asks for changes in chat instead, make them in the source and run `dc done`
with a summary; the canvas reloads with their unsent edits replayed on top.

### 5. Apply what the user sent

1. `dc apply <dir>`. It applies text, remove, move and duplicate ops to the source and
   prints everything with file lines, the user's note, and a to-do list.
2. Then do the part that needs judgment:
   - **style ops** arrive as a property and a token (`font-size: --text-xl`). Make the
     change in the design system: switch a class, or change the component rule if every
     instance should follow. Never leave an inline style in a screen. An op flagged
     "off-scale raw value" came from the Custom CSS field: find the nearest token, or add a
     token if the scale genuinely lacks a step, and say which.
   - **resize ops** mean "wider" or "taller", not "exactly 436px". Decide what that is in
     layout terms (a max-width, a grid track, flex-basis, padding, an aspect ratio) and say
     what you chose. A fixed pixel size is right only for things that are fixed (an avatar,
     an icon, a thumbnail).
   - **sketches** are dashed placeholders the user drew with a note ("a quiet link to past
     swims"). Build each into real elements with ids, in the design system, where it was
     placed. `dc lint` errors until no sketch is left.
   - **comments**: tell a question from a request. A question ("should this be a pill?")
     gets an answer with your pick via `dc reply`, not a redesign; offer the change. A
     request ("make this a pill") is an edit: make it, then reply saying what you did and
     `--resolve`. Answer every thread the user wrote in, including replies to your `ask`s.
   - **The note** applies to the whole send. Act on its intent across every screen it
     touches.
   - **Consistency fallout**: when the user changes one instance of a component, check the
     same component on other screens. Change them too if that's clearly the intent, and
     list them in your summary; ask with a pin if it isn't clear.
3. The user's edits are decisions. Don't silently undo or "improve" one. If something they
   asked for forces a change elsewhere, make it, and say so in the summary.
4. `dc done <dir> --summary "…"`: one or two sentences on what you did beyond the literal
   edits. The canvas reloads and shows it. Then wait again (step 4.3).

### 6. Know when the design is done

The design is ready when lint is clean, the Audit tab is clean or every remaining finding is
deliberate, no sketches or open threads remain, and the user says so. Ask before moving on;
don't decide on your own that design is over.

### 7. Build from the mocks

1. Map the design system first: `tokens.css` becomes the project's theme (CSS variables,
   a Tailwind theme, SwiftUI `Color`/`Font` extensions, a Compose `MaterialTheme`), and each
   rule in `components.css` becomes one component. Do this before any screen.
2. Build screen by screen from `dc spec <dir> <screen>`: the tree, classes, native
   component names and copy. Carry each `data-id` into the build as a test id
   (`data-testid`, `accessibilityIdentifier`, `testTag`) so mock and code stay traceable.
3. Compare the build to the mock: screenshot both at the same size and fix what differs.
   If implementation forces a visual change, change the mock too and tell the user.
