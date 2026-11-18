---
name: design-canvas
description: >-
  Design every screen of a website or app as a real, editable mock before building it: HTML and
  CSS on one shared token set, rendered in device frames (desktop browser, iPhone, Android) on a
  local canvas, with responsive widths, hover/focus/pressed states, a component catalog, motion
  and a click-through prototype. The user selects any element, edits text, swaps tokens, drags
  to reorder, resizes, sketches placeholders, pins comments, asks for variants and presses Send;
  the agent gets exact ops against stable element ids, applies them in the source, and the canvas
  reloads. A live audit flags off-scale values, low contrast, small tap targets and bad motion;
  after the build, a Test button runs the real app and diffs it against the mocks. Use it
  whenever the user wants to design, mock up, lay out, animate or iterate on the UI of a site,
  landing page, web app, dashboard or mobile app before (or instead of) building it; wants to see
  screens rather than read about them; wants to point at an element and say "change this";
  wants to check that what was built matches the design; or mentions the design canvas, mocks,
  artboards, variants, the Audit or Build tab, or hitting Send on a design.
---

# Design Canvas

Users judge software by what they see. Agents tend to build the UI last and fastest, so it
ends up generic, inconsistent from screen to screen, and only reviewable after the code is
written. This skill puts the UI first. Every screen is mocked in real HTML and CSS on a local
canvas, the user changes it directly, the result becomes the spec the build has to match, and
the build is checked against it.

- **Mocks are real HTML and CSS, not pictures.** You write them with the same craft you would
  use for production UI, so what the user approves is what can be built.
- **Tokens are the only place raw values live.** Colors, type sizes, spacing, radii and motion
  timing come from `tokens.css`; screens and components use `var(--…)`. The inspector offers
  only tokens as choices, and the Audit tab flags anything on screen that isn't one.
- **One definition per component.** If two screens show a button, both use `.btn` from
  `components.css`. The user can edit a component once in the catalog; when they change one
  instance on a screen, you decide whether the component changes everywhere and say which.
- **Every element the user can point at has a `data-id`.** IDs are stable: renaming changes
  text, never the id. The user's edits arrive as ops against these ids, and the build carries
  them as test ids so it can be compared with the mock element by element.
- **States, widths and motion are designed, not left to the build.** Hover, focus, pressed and
  disabled are real rules the user can see and edit. Web screens show their narrower widths.
  Entrance motion and screen transitions are attributes with token timing, playable in the
  prototype player.
- **The user edits, you craft.** Text, deletes, reorders, duplicates, motion attributes and
  picked variants are applied to the source mechanically. Style, resize and sketch ops are
  intent: you express them properly in the design system.
- **Questions go on the canvas.** Pin them on the element with `ask`. Changes the user asks
  for in chat go on the canvas as a proposal they accept or reject.

## What's in this skill

Paths are relative to this skill's directory, written `<skill>`.

| Path | Read it when |
|---|---|
| `references/format.md` | Before writing your first design: design.json, screen attributes, variants, proposals, build config, changeset ops. |
| `references/craft.md` | Before drafting tokens or screens: the quality bar, states, motion, responsive. |
| `examples/tidewater/design/` | Before drafting: a complete project (web landing page at three widths, five iOS screens, motion, states). Match its structure. |
| `kit/ios.css`, `kit/android.css` | When mocking a native app: the kit classes and the SwiftUI / Compose names they map to. |
| `kit/motion.css` | When designing motion: the attribute vocabulary and how it maps to SwiftUI, Compose and the web. |
| `scripts/canvas.mjs` | The CLI you run (below). |
| `gui/` | The canvas. You start it with the CLI; you don't need to read its code. |

### The CLI

Run it as `node <skill>/scripts/canvas.mjs <command> <design-dir>` (Node 22+, no install
step; `compare` also needs Chrome, Chromium, Edge or Brave). Below, `dc` stands for that whole
prefix; write it out each time.

| Command | Does |
|---|---|
| `dc init <dir> [--name N] [--device D]` | Scaffolds `design.json`, `tokens.css`, `components.css` and one screen. |
| `dc serve <dir> [--port N]` | Starts the canvas (foreground: run it in the background) and prints its URL. Reuses a canvas already serving this dir. |
| `dc wait <dir> [--timeout S]` | Blocks until the user sends (edits, a variants request, a test request, a proposal answer), then prints it. Exit 2 on timeout. |
| `dc show <dir>` | Prints the pending changeset with file lines and a to-do list. |
| `dc apply <dir>` | Applies text, remove, move, duplicate and attribute ops, picked variants and the accepted part of a proposal. Prints what's left for you. |
| `dc done <dir> --summary "…"` | Lints, then releases the design. The canvas reloads and shows your summary. Refuses on lint errors. |
| `dc lint <dir>` | Static checks: tokens, ids, banned patterns, missing states, motion, raw values, sketches, copy. |
| `dc reply <dir> <thread> "…" [--resolve]` | Answers a comment thread; the user sees it on the pin. |
| `dc ask <dir> <screen> <data-id\|-> "…"` | Pins your question on an element for the user. |
| `dc comments <dir> [--all]` | Lists threads and whose turn each is. |
| `dc variants <dir>` | Validates `variants.json` and lists the open sets. |
| `dc propose <dir> start` / `--title … --summary … [--question "Q\|a\|b"]` / `--withdraw` | Copies the design into `proposal/` for you to edit, then publishes it as an accept/reject diff on the canvas. |
| `dc compare <dir> [screen…] [--image screen=shot.png] [--simulator] [--url U]` | Screenshots the build and the mocks and diffs them; the result shows on the canvas and in the Build tab. |
| `dc components <dir>` | The component catalog: classes, instances, screens. |
| `dc spec <dir> [screen]` | Component tree per screen: ids, tags, classes, native component names, motion, links, copy. |
| `dc status <dir>` | Canvas URL, pending changeset, proposal, variants, comparisons, open comments. |

## Where the design lives

In the user's project, at `design/` (or the folder they name). It is a project artifact:
commit it. `init` writes a `.gitignore` for `design/.canvas/` and `design/changeset*.json`.

## Workflow

```
request → ground (impeccable) → tokens → components → screens, states, widths, motion → self-audit ─┐
                                                                                                   ▼
          serve → user edits, comments, variants, Send → apply → craft → done ─┐
            ▲   ▲                                                             │
            │   └── chat request → propose ──────────────────────────────────┤
            └──────────────────────────────────── until the user is happy ───┘
                                                                                                   ▼
                        spec → build from the mocks → Test build → compare → fix what differs
```

### 1. Ground the design before drawing anything

Quality is decided before the first screen. If the `impeccable` skill is available, run its
setup now (load PRODUCT.md / DESIGN.md, pick the register, read `brand.md` or `product.md`)
and follow its shared design laws throughout; for motion, also read its `animate` reference
and, if installed, the `emil-design-eng` skill. Either way:

1. Write the **scene sentence**: who uses this, where, in what light, in what mood. Put it in
   `design.json` as `scene` and at the top of `tokens.css`. It decides light vs dark, density,
   contrast, and how fast things should move.
2. Pick a **color strategy** (restrained, committed, full palette, drenched) and a type pairing
   that isn't the category reflex. If someone could guess your palette from the product
   category alone, choose again.
3. Write `tokens.css`: tinted neutrals (no `#000`/`#fff`), color roles including hover and
   focus colors, one type scale with steps at least 1.2× apart, a 4px spacing scale, a few
   radii, and motion: `--duration-fast/base/slow`, `--ease-out`, `--ease-in-out`,
   `--ease-emphasized`, `--stagger`. Use OKLCH. See `references/craft.md`.
4. Write `components.css`: every repeated pattern once, using tokens only, **with its
   states**: `:hover`, `:focus-visible` (or one global focus ring), `:active`, and
   `:disabled` where it applies. Lint warns when a pressable component has no focus style.

If the user already has a design system (a DESIGN.md, a Tailwind config, a theme file, an
existing site), extract its values into `tokens.css` instead of inventing new ones.

### 2. Draft the screens

1. **List every screen and state**, including the unglamorous ones: empty, loading, error,
   signed-out, the confirmation, the 404. A state of another screen gets `"state"` and `"of"`
   in `design.json` and draws underneath it. Pick the device per screen.
2. **Write each screen as an HTML fragment** in `screens/<id>.html` (no `<html>`/`<head>`):
   - A `data-id` on the screen root and on every element the user might select. Dotted ids by
     area (`today.primary.temp`). Put editable copy in its own element with an id.
   - `data-component` on anything that maps to a named component in the real codebase.
   - `data-goto="<screen>"` on anything that navigates, with `data-transition` (`push`,
     `sheet`, `fade`, `none`) for how the next screen arrives.
   - Real copy, written for this product. No lorem ipsum, no em dashes.
3. **Web screens are responsive.** Set `"breakpoints": [834, 390]` in `design.json` (or per
   screen) and write the media queries in `components.css`. The canvas shows each width next
   to the desktop frame, and the audit errors on sideways scroll.
4. **Native apps** use the kit classes (`ios-screen`, `ios-scroll`, `ios-nav`, `ios-list`,
   `ios-row`, `ios-tabbar`, `ios-sheet`, `ios-segmented`, `ios-switch`; `md-*` on Android).
   Don't draw the status bar, notch or home indicator: the device frame does. Pad with
   `var(--safe-top)` / `var(--safe-bottom)`.
5. **Design the motion** with `kit/motion.css` attributes: `data-motion` (entrance:
   `fade`, `rise`, `scale`, `slide-left`, `slide-right`, `drop`), `data-motion-speed`,
   `data-motion-ease`, `data-motion-order` (stagger slot) and `data-press` (`scale`, `dim`).
   Motion explains hierarchy and causality: stagger a screen's main blocks in reading order,
   keep it under ~500ms total, never bounce, animate transform and opacity only.
6. Curate `"components"` in `design.json`: the classes the catalog shows (buttons, badges,
   rows, fields), not page sections.

### 3. Check your own work before the user sees it

1. `dc lint <dir>` until there are no errors. Fix warnings, or accept one deliberately and say why.
2. `dc serve <dir>` in the background, open the URL, and read the **Audit** tab across every
   screen and width: off-scale type, colors, spacing and radii; contrast below WCAG AA; tap
   targets under 44pt on phones; transitions on layout properties or longer than 600ms;
   sideways scroll at breakpoints. Fix the source, not the audit.
3. Look at every screen at 100% zoom, at every width, and in each state of its components
   (the catalog shows them side by side). Play the prototype (`⇧P`) and watch the
   transitions. Critique as a designer would (impeccable's `critique` if available). Fix
   before showing.

### 4. Review on the canvas

1. Tell the user the URL and where to start, in a few lines. They can click anything to edit
   it, double-click text, drag the round grip to reorder, use the square handles to resize,
   switch an element to hover/focus/pressed/disabled to design that state, edit at a narrower
   width to change only that width, edit a component once in the catalog (K), set motion and
   links in the inspector, ask for variants of anything, press C to comment, ⇧P to play the
   prototype, and Send when done.
2. Pin the two to five decisions that matter most with `dc ask`, each with the options and your
   pick in one or two sentences. Mention them in chat.
3. Run `dc wait <dir>` in the background so you're notified on Send, and end your turn. If you
   can't run background commands, ask the user to tell you when they've sent, then `dc show`.

**When the user asks for a change in chat**, propose it instead of just making it, unless
it's a small unambiguous edit or they say to just do it:

1. `dc propose <dir> start` copies the design into `<dir>/proposal/`. Edit the files there
   (add new screens to its `design.json`; change tokens or components if the change needs it).
2. `dc propose <dir> --title "…" --summary "…" --request "<their words>"`, with
   `--question "Q|option|option"` for anything you can't settle without them.
3. Tell them the proposal is on the canvas: proposed screens sit next to the current ones,
   with what was added, changed or removed outlined, and they accept all, some screens, or
   none (tokens and components are a separate checkbox). Then wait.

### 5. Apply what the user sent

1. `dc apply <dir>`. It applies text, remove, move, duplicate and attribute (motion, link,
   transition) ops, swaps in picked variants, copies the accepted part of a proposal, and
   prints everything left with file lines, the user's note, and a to-do list.
2. Then do the part that needs judgment:
   - **style ops** arrive as a property and a token, with a scope. `[component .btn]` means
     the rule in `components.css` for every instance. `[:hover]` / `[:focus-visible]` /
     `[:active]` / `[:disabled]` means that state's rule. `[@media (max-width: 390px)]`
     means a media query at that breakpoint, not the base rule. Unscoped means this element:
     switch a class, or change the component rule if every instance should follow. Never
     leave an inline style. "Off-scale raw value" came from the Custom CSS field: use the
     nearest token, or add one if the scale truly lacks a step, and say which.
   - **resize ops** mean "wider" or "taller", not "exactly 436px". Decide what that is in
     layout terms (max-width, grid track, flex-basis, padding, aspect ratio) and say so.
   - **sketches** are placeholders with a note. Build each into real elements with ids, in the
     design system, where it was placed. Lint errors until none is left.
   - **picked variants** are already swapped in, with their CSS appended to `components.css`
     under a `/* variant … */` marker. Fold it into proper component rules and remove the marker.
   - **comments**: a question gets an answer with your pick via `dc reply`, not a redesign; a
     request is an edit: make it, reply with what you did, `--resolve`. Answer every thread.
   - **requests**: see Variants and Test below.
   - **a proposal answer**: act on the answers and reply. If they took screens but not the
     token/component changes, make those screens work with the current system.
   - **The note** applies to the whole send. **Consistency fallout**: when one instance of a
     component changes, check its other instances and list what you changed.
3. The user's edits are decisions. Don't silently undo or "improve" one.
4. `dc done <dir> --summary "…"`: one or two sentences on what you did beyond the literal
   edits. The canvas reloads and shows it. Then wait again.

### Variants

The user selects an element and asks for variants (optionally with a direction: "calmer",
"no card"). You get a `variants` request. Write `variants.json` (see `references/format.md`):
one set per request, each option a complete replacement of the element whose root keeps the
same `data-id` and attributes, plus the CSS it needs (tokens only), a short label and a
one-sentence rationale. Make the options genuinely different along different axes (hierarchy,
layout, density, structure, what leads) while staying inside the identity of the design: three
takes on this product, not three products. `dc variants <dir>` validates; `dc done` shows them
beside the screen, and the user picks one or turns them all down.

### Test the build

Once screens are built, the user can press **Test build** (simulator, device, browser, or
compare again). You get a `test` or `compare` request:

1. Build and run the app where they asked: the dev server for web, the iOS Simulator
   (`xcodebuild`, then install and launch; use the simulator tools if you have them), or a
   connected device. A device run is for the user to try in their hand; say how to open it.
2. Map screens to the build in `design.json` → `build` once: web routes per screen, iOS deep
   links per screen (see `references/format.md`).
3. `dc compare <dir>` captures each mapped screen at the mock's size and diffs it. When the
   build carries the mock's ids (`data-testid` / `data-id` on the web), the comparison is
   per element: missing elements, size changes, style drift (font size, weight, color, fill,
   radius, padding) and elements that look different. Otherwise it's per pixel region (iOS
   screenshots: `--simulator`, or `--image screen=shot.png` for any screenshot).
4. Fix what differs in the build (or, if the build is right and the mock is stale, the mock),
   compare again, and `done` with a summary of what matched and what you fixed.

### 6. Know when the design is done

Lint is clean, the Audit tab is clean or every remaining finding is deliberate, no sketches,
open variants, proposals or threads remain, and the user says so. Ask before moving on.

### 7. Build from the mocks

1. Map the design system first: `tokens.css` becomes the project's theme (CSS variables, a
   Tailwind theme, SwiftUI `Color`/`Font`/`Animation` extensions, a Compose `MaterialTheme`),
   and each rule in `components.css` becomes one component with all its states.
2. Build screen by screen from `dc spec <dir> <screen>`: the tree, classes, native component
   names, motion and links, copy. Carry each `data-id` into the build as a test id
   (`data-testid`, `accessibilityIdentifier`, `testTag`) so `compare` can match elements.
3. Map each motion attribute to the platform (the table in `kit/motion.css`), with the same
   durations and curves from the tokens.
4. Offer the user **Test build** when a screen is done, and run `compare` yourself before
   saying it matches. If implementation forces a visual change, change the mock too and say so.
