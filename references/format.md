# Design Canvas file formats

A design is a folder (usually `design/` in the user's project):

```
design/
  design.json        project: name, scene, fonts, breakpoints, components, build, screens
  tokens.css         every raw value, as custom properties on :root
  components.css     shared components and their states, tokens only
  screens/*.html     one HTML fragment per screen or state
  comments.json      comment threads (user's and yours), persistent
  variants.json      variant sets you offered; resolved ones stay as a record
  proposal/          transient: your proposed copy of the design, until the user answers
  changeset.json     transient: what the user sent, until `apply`
  .canvas/           transient: server, state, history of sends, build comparisons (gitignore it)
```

## design.json

```jsonc
{
  "name": "Tidewater",
  "summary": "One line on what the product is.",
  "scene": "Who uses it, where, in what light, in what mood.",
  "defaultDevice": "iphone",                 // used when a screen has no device
  "fonts": ["https://fonts.googleapis.com/css2?family=…"],   // stylesheet URLs, loaded in every screen
  "breakpoints": [834, 390],                 // narrower widths shown for web screens; a screen can override
  "components": ["btn", "btn-quiet", "flag"],// classes the catalog shows; omit to let it guess
  "build": {                                 // how `compare` finds each screen in the real build
    "web": { "url": "http://localhost:3000/", "routes": { "web-home": "/" } },   // url may be a folder relative to design/
    "ios": { "scheme": "Tidewater", "bundleId": "app.tidewater.ios", "links": { "ios-today": "tidewater://today" } }
  },
  "screens": [
    { "id": "web-home", "name": "Landing", "file": "screens/web-home.html", "device": "desktop", "address": "tidewater.app" },
    { "id": "ios-today", "name": "Today", "device": "iphone" },              // file defaults to screens/<id>.html
    { "id": "ios-today-empty", "name": "Today", "state": "empty", "of": "ios-today", "device": "iphone" },
    { "id": "ios-log", "name": "Log swim", "device": "iphone", "statusBar": "light" },
    { "id": "web-pricing", "device": "desktop", "breakpoints": [] }          // no narrower widths for this one
  ]
}
```

Devices: `desktop` 1440, `laptop` 1280, `tablet` 834, `mobile-web` 390 (these grow to their
content's height), `iphone` 393×852 and `android` 412×915 (fixed; content scrolls inside).
Screen order is canvas order. States draw under their screen; breakpoints, variants, proposed
versions and build screenshots draw to its right.

## Screens

A screen file is a fragment: the body's content only. The canvas wraps it in:

```html
<html data-device="iphone" data-platform="ios" data-screen="ios-today">
  fonts → kit/base.css → kit/ios.css (native only) → kit/motion.css → tokens.css → components.css
  <body> your fragment </body>
```

Target platforms and devices in CSS with `html[data-platform="ios"]`, `html[data-device="desktop"]`;
`base.css` defines `--safe-top`, `--safe-bottom` per device. Breakpoint frames are the same
document in a narrower iframe, so ordinary `@media (max-width: …)` rules apply.

Attributes the canvas reads:

| Attribute | Meaning |
|---|---|
| `data-id="area.part.name"` | Selectable, editable, commentable. Unique per screen. Stable: never rename one. Required on the screen root. |
| `data-component="List"` | The component this maps to in the real codebase. Shown in the inspector and `spec`. |
| `data-goto="screen-id"` | Navigates there in Preview mode and the prototype player. |
| `data-transition="push\|sheet\|fade\|none"` | How the `data-goto` target arrives. Default: push on phones, fade on the web. |
| `data-motion="fade\|rise\|scale\|slide-left\|slide-right\|drop"` | Entrance motion when the screen appears. |
| `data-motion-speed="fast\|base\|slow"` | → `--duration-fast/base/slow`. Default base. |
| `data-motion-ease="out\|in-out\|emphasized"` | → `--ease-out/in-out/emphasized`. Default out. |
| `data-motion-order="0…12"` | Stagger slot, × `--stagger`. |
| `data-press="scale\|dim"` | Press feedback on something tappable. |
| `data-sketch` | A placeholder the user drew. Never write one yourself; replace each with real elements. |

Text is editable inline when the element contains only text (and inline `em`/`strong`/`span`
without ids). Give each piece of copy its own element with an id.

## comments.json

```jsonc
{ "threads": [ {
  "id": "c3", "screen": "ios-today", "target": "today.window",   // target null = the screen
  "x": 0.9, "y": 0.1,                    // pin position as a fraction of the target's box
  "status": "open",                      // or "resolved"
  "by": "agent",                         // who opened it
  "messages": [ { "by": "agent", "text": "…", "at": "ISO date" }, { "by": "user", "text": "…" } ]
} ] }
```

Use `ask`, `reply` and `comments` rather than editing it by hand. Comments made in a
breakpoint frame start with "(at 390px)".

## variants.json (you → canvas)

```jsonc
{ "sets": [ {
  "id": "v1", "screen": "ios-today", "target": "today.primary",
  "prompt": "calmer",                    // the user's direction, copied from the request
  "status": "open",                      // apply sets "resolved" and "picked"
  "options": [ {
    "id": "a", "label": "Quieter number",
    "rationale": "One sentence on what this option changes and why.",
    "html": "<section class=\"spot-hero v-quiet\" data-id=\"today.primary\" …>…</section>",   // root keeps the target's data-id and attributes
    "css": ".v-quiet-top { … }"          // extra rules it needs, tokens only; scope class names to the option
  } ]
} ] }
```

The canvas renders each option as the whole screen with the element replaced. `dc variants`
checks that every option's root keeps the target id.

## proposal/ (you → canvas)

`propose start` copies `design.json`, `tokens.css`, `components.css` and the screens into
`proposal/`. Edit them like the real design. `propose --title …` writes `proposal/proposal.json`:

```jsonc
{ "title": "…", "summary": "…", "request": "the user's words", "createdAt": "…",
  "questions": [ { "id": "q1", "question": "…", "options": ["…", "…"] } ],
  "changed": { "screens": ["ios-spot"], "added": ["ios-spots"], "removed": [], "system": true } }
```

`system` is true when tokens or components differ. Only one proposal at a time.

## changeset.json (canvas → you)

```jsonc
{
  "sentAt": "ISO date", "base": "<version the user was editing>",
  "note": "Calmer overall.",             // optional, applies to the whole send
  "ops": [ /* in the order the user made them; each has "screen" */ ],
  "comments": [ { "thread": "c4", "screen": "…", "target": "…", "text": "…", "reply": false, "resolve": false } ],
  "requests": [ { "type": "variants", "screen": "ios-today", "id": "today.primary", "prompt": "calmer", "count": 3, "rid": "r1" },
                { "type": "test", "target": "simulator" | "device" | "web" }, { "type": "compare" } ],
  "variants": [ { "set": "v1", "note": "none of these: all too busy" } ],     // sets the user turned down
  "proposal": { "decision": "accepted" | "partial" | "rejected", "accepted": ["ios-spot"], "rejected": [],
                "system": false, "answers": [ { "id": "q1", "question": "…", "answer": "…" } ], "reply": "…" }
}
```

| op | Fields | Applied by |
|---|---|---|
| `text` | `id`, `value`, `before` | `apply` |
| `remove` | `id`, `label` (its text, for context) | `apply` |
| `move` | `id`, `parent` (data-id), `index` (among the parent's data-id children, after removal), `before: {parent, index}` | `apply` |
| `duplicate` | `id`, `suffix` (appended to every data-id in the copy) | `apply` |
| `attr` | `id`, `attrs: { "data-motion": "rise", "data-goto": null, … }` (null removes), `before` | `apply` |
| `pick-variant` | `id`, `set`, `option`, `html`, `css` | `apply` (CSS appended to components.css under a marker) |
| `style` | `id`, `prop`, `value` (`var(--token)` or raw), `token`, `before`, and scope: `component`, `state`, `viewport` | you |
| `resize` | `id`, `width` / `height` (px, or `null` for auto), `before`, same scope fields | you |
| `sketch` | `newId`, `parent`, `index`, `note` | you |

Scope on style and resize ops: `component: "btn"` (edited in the catalog: change the `.btn`
rule), `state: "hover" | "focus" | "pressed" | "disabled"` (that state's rule:
`:hover`, `:focus-visible`, `:active`, `:disabled`), `viewport: 390` (inside
`@media (max-width: 390px)`). They combine.

`apply` renames `changeset.json` to `changeset.applying.json` and records what it applied, so
running it twice is safe. `done` archives the changeset to `.canvas/history/`.

## .canvas/compare/<screen>/ (compare → canvas)

`mock.png`, `build.png`, `diff.png` and `report.json`:

```jsonc
{ "screen": "web-home", "at": "…", "source": "http://localhost:3000/", "mode": "elements",
  "mismatch": 0.24,                      // share of mock elements with a finding (pixels share in "pixels" mode)
  "matched": 64, "total": 65, "extra": ["…ids only in the build"], "heightDelta": -30,
  "elements": [ { "id": "web.hero.cta", "kind": "style", "detail": "border-radius 14px → 8px",
                  "x": 120, "y": 610, "w": 240, "h": 50, "bx": 120, "by": 580, "bw": 240, "bh": 50 } ],
  "regions": [] }                        // pixel mode: [{ x, y, w, h, ids }]
```

Element kinds: `missing` (in the mock, not the build), `size` (width, or height for leaves,
off by more than 4px), `style` (computed font size, weight, color, fill, radius, padding, gap),
`look` (more than 8% of the element's own pixels differ).
