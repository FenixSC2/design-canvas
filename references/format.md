# Design Canvas file formats

A design is a folder (usually `design/` in the user's project):

```
design/
  design.json        project: name, scene, fonts, screens
  tokens.css         every raw value, as custom properties on :root
  components.css     shared components, tokens only
  screens/*.html     one HTML fragment per screen or state
  comments.json      comment threads (user's and yours), persistent
  changeset.json     transient: what the user sent, until `apply`
  .canvas/           transient: server, state, history of sends (gitignore it)
```

## design.json

```jsonc
{
  "name": "Tidewater",
  "summary": "One line on what the product is.",
  "scene": "Who uses it, where, in what light, in what mood.",
  "defaultDevice": "iphone",                // used when a screen has no device
  "fonts": ["https://fonts.googleapis.com/css2?family=…"],   // stylesheet URLs, loaded in every screen
  "screens": [
    { "id": "web-home", "name": "Landing", "file": "screens/web-home.html", "device": "desktop", "address": "tidewater.app" },
    { "id": "ios-today", "name": "Today", "device": "iphone" },              // file defaults to screens/<id>.html
    { "id": "ios-today-empty", "name": "Today", "state": "empty", "of": "ios-today", "device": "iphone" },
    { "id": "ios-log", "name": "Log swim", "device": "iphone", "statusBar": "light" }  // light status bar text over dark content
  ]
}
```

Devices: `desktop` 1440, `laptop` 1280, `tablet` 834, `mobile-web` 390 (these grow to their
content's height), `iphone` 393×852 and `android` 412×915 (fixed; content scrolls inside).
Screen order is canvas order, left to right. States draw under the screen they belong to.

## Screens

A screen file is a fragment: the body's content only. The canvas wraps it in:

```html
<html data-device="iphone" data-platform="ios" data-screen="ios-today">
  fonts → kit/base.css → kit/ios.css (native only) → tokens.css → components.css
  <body> your fragment </body>
```

So you can target platforms and devices in CSS with `html[data-platform="ios"]`,
`html[data-device="desktop"]`. `base.css` defines `--safe-top`, `--safe-bottom` per device.

Attributes the canvas reads:

| Attribute | Meaning |
|---|---|
| `data-id="area.part.name"` | Selectable, editable, commentable. Unique per screen. Stable: never rename one; the user's ops point at it. Required on the screen root. |
| `data-component="List"` | The component this maps to in the real codebase (SwiftUI, Compose, React…). Shown in the inspector and `spec`. |
| `data-goto="screen-id"` | In Preview mode, clicking it flies to that screen. |
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

Use `ask`, `reply` and `comments` rather than editing it by hand. A thread is the user's turn
when the last message is yours, and yours when it's theirs.

## changeset.json (canvas → you)

```jsonc
{
  "sentAt": "ISO date", "base": "<version the user was editing>",
  "note": "Calmer overall.",             // optional, applies to the whole send
  "ops": [ /* in the order the user made them; each has "screen" */ ],
  "comments": [ { "thread": "c4", "screen": "…", "target": "…", "text": "…", "reply": false, "resolve": false } ]
}
```

| op | Fields | Applied by |
|---|---|---|
| `text` | `id`, `value`, `before` | `apply` |
| `remove` | `id`, `label` (its text, for context) | `apply` |
| `move` | `id`, `parent` (data-id), `index` (among the parent's data-id children, after removal), `before: {parent, index}` | `apply` |
| `duplicate` | `id`, `suffix` (appended to every data-id in the copy) | `apply` |
| `style` | `id`, `prop`, `value` (`var(--token)` or raw), `token` (name, or absent if raw), `before` | you |
| `resize` | `id`, `width` / `height` (px, or `null` for auto), `before: {width, height}` | you |
| `sketch` | `newId`, `parent`, `index`, `note` | you |

`apply` renames `changeset.json` to `changeset.applying.json` and records which ops it
applied, so running it twice is safe. `done` archives the changeset to `.canvas/history/`.
