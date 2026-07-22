# Signal Desk — repo-level agent rules

Any Claude session working in this repo must follow these:

## 1. Handbook is the source of truth for users

`handbook.html` is a beginner-facing reference. Whenever you ship a feature that
changes any of the following, you MUST update `handbook.html` in the same commit:

- The composite score (weights, components, min/max ranges) → update Chapter 03
- Setup states, entry/exit rules, or the classifier logic → Chapter 04 / 05
- The regime filter thresholds or effects → Chapter 06
- The political overlay: sector lexicons, trigger words, or scoring → Chapter 07
- Screener columns or filter behavior → Chapter 08
- Political calendar structure → Chapter 09
- Any new data source coming online or going away → Chapter 10
- Any new indicator or trader term used in the UI → add to glossary (Chapter 11)

## 2. Always append a changelog entry

Every shipped feature adds a `.log-entry` block at the top of Chapter 12
(newest first). Format:

```html
<div class="log-entry">
  <div class="when">Round N<br/>YYYY-MM-DD</div>
  <div class="what">
    <h4>Short feature title</h4>
    <ul>
      <li>Bullet describing what shipped and why the user cares.</li>
    </ul>
  </div>
</div>
```

Also bump the version badge in the masthead kicker (`v1.X`) and update
`LAST UPDATED` in the meta block.

## 3. Never let handbook and code diverge

If you find yourself editing `analyze.js`, `api/*.js`, `index.html`, or scoring
logic and you have NOT updated `handbook.html`, you are not done. The user has
explicitly asked for the handbook to stay current — treat it as production code,
not documentation.

## 4. Data honesty

Never claim data is "live" in the handbook when it's mock. If you're wiring a
new feed, update Chapter 10 to move it from the "mock" list to the "live" list
in the same commit that brings it online.
