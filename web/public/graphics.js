// Original Star Gazer artwork, reused by the shared-service interface.
// Illustrations are decorative; the outing report supplies calculated sky data.
export const constellation = `<svg class="constellation" viewBox="0 0 180 120" fill="none" aria-hidden="true"><path class="c-line" d="m22 89 41-55 44 22 41-37-9 78-32-41-44-22" stroke="currentColor" pathLength="1"/><path d="m22 89 117 8" stroke="currentColor" opacity=".1" stroke-dasharray="3 5"/>${[
  [22, 89],
  [63, 34],
  [107, 56],
  [148, 19],
  [139, 97],
]
  .map(
    ([x, y], i) =>
      `<g class="c-node" style="--i:${i};transform-origin:${x}px ${y}px"><circle cx="${x}" cy="${y}" r="14" fill="transparent"/><circle class="c-halo" cx="${x}" cy="${y}" r="${i === 2 ? 11 : 7}" stroke="currentColor"/><circle class="c-core" cx="${x}" cy="${y}" r="${i === 2 ? 4 : 2.5}" fill="currentColor"/></g>`,
  )
  .join("")}</svg>`;
const passportNodes = [
  [30, 150],
  [62, 92],
  [112, 118],
  [150, 58],
  [196, 96],
  [214, 30],
];
export const passport = (step) =>
  `<svg class="passport-sky" viewBox="0 0 240 180" fill="none" aria-hidden="true">${passportNodes
    .slice(1)
    .map(([x, y], i) => {
      const [px, py] = passportNodes[i];
      return `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}" class="${i < step ? "lit" : ""}"/>`;
    })
    .join(
      "",
    )}${passportNodes.map(([x, y], i) => `<g class="p-node ${i < step ? "lit" : i === step ? "current" : ""}"><circle cx="${x}" cy="${y}" r="${i === step ? 13 : 9}" class="p-halo"/><circle cx="${x}" cy="${y}" r="${i === step ? 4.5 : 3}" class="p-core"/></g>`).join("")}</svg>`;

function orbitPath(cx, cy, rx, ry, deg) {
  const t = (deg * Math.PI) / 180,
    dx = rx * Math.cos(t),
    dy = rx * Math.sin(t),
    a = `${(cx - dx).toFixed(1)} ${(cy - dy).toFixed(1)}`,
    b = `${(cx + dx).toFixed(1)} ${(cy + dy).toFixed(1)}`;
  return `M${a}A${rx} ${ry} ${deg} 1 1 ${b}A${rx} ${ry} ${deg} 1 1 ${a}`;
}

export function skyIllustration(t = "Saturn", interactive = false) {
  const labels = {
    Saturn: "Saturn",
    Moon: "the Moon",
    stargazing: "a constellation",
    Jupiter: "Jupiter",
    Mars: "Mars",
  };
  const label = labels[t] || "Saturn";
  const sparkles = [
    [8, 22],
    [22, 78],
    [78, 10],
    [92, 70],
    [44, 6],
    [4, 52],
    [64, 88],
    [96, 30],
    [34, 40],
  ]
    .map(
      ([x, y], i) =>
        `<span class="sky-star" aria-hidden="true" style="left:${x}%;top:${y}%;--i:${i}">${i % 3 === 0 ? "✦" : "•"}</span>`,
    )
    .join("");
  let art;
  if (t === "Moon")
    art = `<span class="moon-art"><span class="moon-halo"></span><span class="moon-disc">${[
      [28, 30, 18],
      [60, 22, 10],
      [48, 58, 22],
      [72, 62, 9],
      [30, 72, 8],
      [80, 40, 6],
    ]
      .map(
        ([x, y, s]) =>
          `<i class="crater" style="left:${x}%;top:${y}%;width:${s}%;height:${s}%"></i>`,
      )
      .join(
        "",
      )}<i class="moon-shade"></i></span><span class="satellite" style="offset-path:path('${orbitPath(220, 160, 190, 70, -12)}')">✦</span></span>`;
  else if (t === "stargazing")
    art = `<svg class="hero-constellation" viewBox="0 0 440 320" fill="none"><path class="hc-line" pathLength="1" d="M60 230 128 150 206 182 268 96 352 120 380 50"/><path class="hc-line faint" pathLength="1" d="M206 182 236 262 330 248 352 120"/>${[
      [60, 230, 3],
      [128, 150, 4],
      [206, 182, 6],
      [268, 96, 4],
      [352, 120, 5],
      [380, 50, 3],
      [236, 262, 3],
      [330, 248, 4],
    ]
      .map(
        ([x, y, r], i) =>
          `<g class="hc-node" style="--i:${i}"><circle cx="${x}" cy="${y}" r="${r * 3.2}" class="hc-halo"/><circle cx="${x}" cy="${y}" r="${r}" class="hc-core"/></g>`,
      )
      .join("")}</svg>`;
  else
    art = `<svg class="orbits" viewBox="0 0 440 320" fill="none"><g transform="rotate(-30 220 160)"><ellipse cx="220" cy="160" rx="200" ry="135" class="dashed"/><ellipse cx="220" cy="160" rx="155" ry="105"/><ellipse cx="220" cy="160" rx="105" ry="71"/></g></svg><span class="moonlet m1" style="offset-path:path('${orbitPath(220, 160, 155, 105, -30)}')"></span><span class="moonlet m2" style="offset-path:path('${orbitPath(220, 160, 105, 71, -30)}')"></span><span class="moonlet m3" style="offset-path:path('${orbitPath(220, 160, 200, 135, -30)}')">✦</span><span class="planet ${t === "Jupiter" ? "planet-jupiter" : t === "Mars" ? "planet-mars" : ""}"></span>`;
  return `<div class="sky-illustration ${interactive ? "interactive-sky" : "decorative-sky"}">${interactive ? `<button type="button" class="hero-stage" data-action="cycle-sky" aria-label="Explore the sky illustration. Showing ${label}." title="Tap to explore the sky">` : '<div class="sky-scene" aria-hidden="true">'}<span aria-hidden="true" class="art art-${t === "stargazing" ? "stars" : t.toLowerCase()}">${art}</span>${sparkles}${interactive ? '</button><span class="art-label">A little perspective · tap to explore</span>' : "</div>"}</div>`;
}
