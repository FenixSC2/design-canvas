# Design Canvas

**Design every screen before you build it, on a canvas you can edit directly.**

Agents are good at code structure and weak at the part users actually see. The UI comes
last, gets built fast, looks generic, drifts from screen to screen, and can only be reviewed
once it's already code. Design Canvas moves the frontend to the front: the agent mocks every
screen as real HTML and CSS on one shared design system, the user changes those mocks
directly in a local canvas, and the approved mocks become the spec the build has to match.

![The canvas: a web landing page and four iOS screens, one element selected](docs/canvas.jpg)

It's the frontend counterpart of plan-graph: plan-graph shows what every
screen *does*; this shows what every screen *looks like*. The two will connect through the
screen ids later. This prototype is the design half on its own.

## How it works

```
agent drafts tokens → components → screens        user edits on the canvas, presses Send
                ▲                                               │
                └── canvas reloads ◄── agent applies & crafts ◄─┘   changeset: exact ops on data-ids
```

1. **The agent grounds the design first**: a scene sentence (who, where, in what light),
   a color strategy, a type scale. It all goes in `tokens.css`, the only file with raw values.
   Shared components go in `components.css`. It uses the impeccable skill's laws if
   installed.
2. **Screens are HTML fragments**, one per screen or state, in device frames: desktop
   browser, iPhone, Android, mobile web. Every element the user might point at has a stable
   `data-id`.
3. **The user edits directly.** Click to select (Esc walks up, Enter walks down, Tab
   steps through siblings). Double-click to edit text. Swap type size, weight, color, fill,
   padding, gap or radius from the token scale. Drag the grip to reorder or move into
   another container. Resize with handles. Duplicate, delete, or sketch a placeholder
   ("a quiet link to past swims") for the agent to build. Press C to pin a comment on any
   element. Press P to click through the flow. Unsent work survives reloads.
4. **Send.** The agent receives ops, not prose: `text today.title "This morning" → "Before you
   go in"`, `move today.others.seaford into today.others at position 1`, `style
   today.primary.name font-size: --text-xl`. The CLI applies the mechanical ones (text,
   delete, move, duplicate) to the source, keeping its formatting. The agent handles the
   ones that need judgment: it turns a resize into a layout decision rather than a fixed
   pixel height, builds sketches, applies the note ("calmer overall") across screens,
   carries a component change to its other instances, and answers every comment.
5. **The canvas reloads** with the agent's summary, and the loop repeats.

## What keeps the quality up

The goal is that the default output is good, not that the user has to catch problems.

- **Tokens are the only choices.** The inspector offers the scale, not a free-form px field
  (raw values are possible, and flagged to the agent). Picking from the scale is easier than
  going off it.
- **A live audit on the rendered page.** For every element on every screen: font sizes,
  colors, spacing and radii checked against the tokens; WCAG AA contrast against the actual
  background behind the text; 44pt tap targets on phones; duplicate ids. It also shows the
  scale *in use* across all screens, so drift is visible at a glance (five near-identical
  grays, a stray 18px).
- **A static lint before the user sees anything**: missing tokens, raw colors and font sizes
  outside `tokens.css`, the banned patterns (side-stripe borders, gradient text, decorative
  glass, pure black and white), em dashes and lorem ipsum in copy, images without alt,
  interactive elements without ids, sketches nobody built.
- **A craft reference** the agent reads before drafting, which defers to impeccable when
  present: scene sentence first, avoid the category reflex, cards only when earned, states
  are screens.

## Apps, not just websites

Native screens are mocked in HTML that is structured like the native UI, so the agent can
rebuild it the same way every time:

- **Device frames** draw the status bar, Dynamic Island and home indicator. Screens pad with
  `var(--safe-top)` / `var(--safe-bottom)` and never fake system chrome.
- **Platform kits** (`kit/ios.css`, `kit/android.css`) provide HIG and Material metrics
  (44pt rows, 49pt tab bar, inset grouped lists, sheets, segmented controls, switches) and
  take every color from the project's tokens. Class names map 1:1 to SwiftUI / Compose.
- **`data-component`** on each element names the native component it becomes
  (`NavigationStack`, `List`, `Picker(.segmented)`, `Sheet`). `canvas.mjs spec` prints the
  tree per screen: ids, tags, classes, components, copy and links. That is the handoff.
- **Tokens carry over**: `tokens.css` becomes SwiftUI `Color`/`Font` extensions or a Compose
  theme, and each `data-id` becomes an `accessibilityIdentifier` / `testTag`, so the built
  screen stays traceable to the mock.

## Design decisions

| Decision | Chosen | Instead of | Why |
|---|---|---|---|
| What a mock is | Real HTML/CSS fragments | A JSON scene graph, or generated images | The agent writes HTML at full craft; nothing is lost in translation; the mock is close to buildable. Images can't be edited or audited. |
| Where consistency comes from | One token file, checked at runtime | Style guidelines in the prompt | Rules in a prompt drift; a scale enforced by the inspector and the audit doesn't. |
| What the user's edits mean | Intent (ops), applied by the agent | The GUI rewriting source | A resize handle produces "436px"; good code needs "a taller card" expressed as layout. The agent does that translation. |
| Mechanical vs. crafted ops | Text, delete, move, duplicate applied by the CLI; style, resize, sketch by the agent | Everything by the agent | Saves tokens and round-trips on the edits that need no judgment, and keeps the user's exact words. |
| Moving things | Reorder within, or move into, flow containers | Free x/y positioning | Real layouts are flow, flex and grid. Absolute nudges would produce mocks that can't be built. |
| Questions | Pinned on the element (`ask`) | At the end of a chat reply | The question sits next to the thing it's about, and the answer comes back with the next Send. |
| Dependencies | None: Node's http server, vanilla JS GUI | React/Vite like plan-graph | Starts instantly with no install; a prototype should be easy to try. Worth revisiting if the GUI grows. |

## Try it

```bash
node scripts/canvas.mjs serve examples/tidewater/design
```

Open the URL it prints. The example is a sea-swim conditions product: a desktop landing page
and four iOS screens (Today, its empty state, a spot, and a log-a-swim sheet), with one
open question from the agent pinned on the landing page headline.

Make some edits, press Send, then play the agent:

```bash
node scripts/canvas.mjs show examples/tidewater/design
```

```bash
node scripts/canvas.mjs apply examples/tidewater/design
```

```bash
node scripts/canvas.mjs done examples/tidewater/design --summary "What I did beyond your edits"
```

Start a new design with `node scripts/canvas.mjs init design --device iphone`. As a skill,
install this folder as `~/.claude/skills/design-canvas` and ask Claude to design your app's
screens; `SKILL.md` drives the whole loop.

## What's in the prototype

| Path | What |
|---|---|
| `SKILL.md` | The agent's workflow: ground, draft, self-audit, review, apply, build from mocks. |
| `references/format.md` | design.json, screen fragments, attributes, comments, changeset ops. |
| `references/craft.md` | The quality bar for mocks. |
| `scripts/canvas.mjs` | CLI and local server: init, serve, wait, show, apply, done, lint, reply, ask, comments, spec, status. |
| `scripts/lib.mjs` | Offset-preserving HTML parser, lint, changeset formatting, mechanical apply, spec. |
| `gui/` | The canvas: artboards in device frames, pan/zoom, selection, inline edit, drag, resize, inspector, audit, comments, send. |
| `kit/` | Base reset and safe areas, iOS and Android kits, canvas-only runtime styles. |
| `templates/` | What `init` scaffolds. |
| `examples/tidewater/` | A complete example design. |

## Not built yet

- **Variants.** Select an element and get three alternatives side by side to pick from
  (impeccable's `live` mode does this for running apps; it would fit naturally here).
- **Responsive views.** Show a web screen at desktop, tablet and phone widths at once and
  let edits target one breakpoint.
- **Interaction states.** Hover, focus, pressed, disabled per component, previewed on the
  canvas.
- **Proposals.** When the user asks for a change in chat, load it as a diff on the canvas
  to accept or reject, as plan-graph does.
- **Mock-vs-build diff.** Screenshot the built screen next to its mock and highlight what
  differs.
- **Component view.** A page listing every component in `components.css` with all its
  variants, editable once for every screen.
- **plan-graph link.** Screen ids match plan-graph surface ids, so each surface opens its
  mock and each mock shows the actions and outcomes plan-graph defined for it.

## Known limits

- Selection is by `data-id`. Elements without one can't be selected; the lint warns about
  interactive ones.
- Inline text editing flattens inline formatting inside the edited element.
- Moving across screens isn't supported (it's a different screen; the agent handles that
  from a comment).
- The audit checks computed styles, so a value produced by `calc()` that happens to equal
  a token passes, and a sum of a safe-area inset and a token is treated as on-scale.
