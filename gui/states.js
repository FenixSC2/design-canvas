// Forced interaction states. CSS can't fake :hover from script, so every rule that uses a state
// pseudo-class gets a twin keyed on an attribute: `.btn:hover` also matches
// `.btn[data-dc-state~="hover"]`. Setting the attribute on an element shows that state.

export const STATES = ["hover", "focus", "pressed", "disabled"];

const MAP = [
  [/:hover\b/g, '[data-dc-state~="hover"]'],
  [/:focus-visible\b/g, '[data-dc-state~="focus"]'],
  [/:focus-within\b/g, '[data-dc-state~="focus"]'],
  [/:focus\b/g, '[data-dc-state~="focus"]'],
  [/:active\b/g, '[data-dc-state~="pressed"]'],
  [/:disabled\b/g, '[data-dc-state~="disabled"]'],
];
const HAS = /:(hover|focus-visible|focus-within|focus|active|disabled)\b/;

function twin(selectorText) {
  const parts = selectorText.split(",").map((s) => s.trim()).filter((s) => HAS.test(s));
  if (!parts.length) return null;
  return parts.map((s) => MAP.reduce((acc, [re, rep]) => acc.replace(re, rep), s)).join(", ");
}

function collect(rules, out) {
  for (const r of rules) {
    if (r.selectorText !== undefined) {
      const sel = twin(r.selectorText);
      if (sel) out.push(`${sel} { ${r.style.cssText} }`);
    } else if (r.cssRules && (r.conditionText !== undefined || r.media)) {
      const inner = [];
      collect(r.cssRules, inner);
      if (inner.length) out.push(`@${r.constructor.name === "CSSSupportsRule" ? "supports" : "media"} ${r.conditionText ?? r.media.mediaText} { ${inner.join("\n")} }`);
    }
  }
}

/** Install the twins into a frame's document. Safe to call again after stylesheets change. */
export function installForcedStates(doc) {
  const out = [];
  for (const sheet of doc.styleSheets) {
    if (sheet.ownerNode?.id === "dc-forced" || sheet.ownerNode?.id === "dc-ops") continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin (web fonts)
    collect(rules, out);
  }
  let el = doc.getElementById("dc-forced");
  if (!el) { el = doc.createElement("style"); el.id = "dc-forced"; doc.head.appendChild(el); }
  el.textContent = out.join("\n");
  return out.length;
}

/** Selector for a state, matching both the real pseudo-class and the forced attribute. */
export function stateSelector(sel, state) {
  if (!state) return sel;
  const pseudo = { hover: ":hover", focus: ":focus-visible", pressed: ":active", disabled: ":disabled" }[state];
  const extra = state === "disabled" ? `, ${sel}[aria-disabled="true"]` : "";
  return `${sel}${pseudo}, ${sel}[data-dc-state~="${state}"]${extra}`;
}

/** Does any rule in this document style the element in that state? (So the inspector only offers real ones.) */
export function statesFor(el) {
  const doc = el.ownerDocument;
  const forced = doc.getElementById("dc-forced")?.sheet;
  const found = new Set();
  if (!forced) return found;
  const check = (rules) => {
    for (const r of rules) {
      // Style rules have cssRules too (CSS nesting), so tell them apart by selectorText.
      if (r.selectorText === undefined) { if (r.cssRules) check(r.cssRules); continue; }
      for (const st of STATES) {
        if (found.has(st) || !r.selectorText.includes(`~="${st}"`)) continue;
        const probe = r.selectorText.split(",").map((s) => s.trim()).filter((s) => s.includes(`~="${st}"`)).map((s) => s.replaceAll(`[data-dc-state~="${st}"]`, ""));
        // An empty remainder is a global rule (`:focus-visible { … }`): it styles every element.
        try { if (probe.some((p) => !p.trim() || p.trim() === "*" || el.matches(p))) found.add(st); } catch { /* odd selector */ }
      }
    }
  };
  check(forced.cssRules);
  return found;
}
