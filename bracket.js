'use strict';

/**
 * bracket.js
 *
 * Generates a self-contained, dependency-free HTML/SVG visualization of the 2026
 * World Cup knockout bracket. The bracket is seeded from the official FIFA
 * R32_TEMPLATE / LATER_ROUNDS used in simulation.js, and each slot is filled
 * with the most likely team from the Monte Carlo bracket occupancies.
 *
 * Zero third-party dependencies.
 */

const { R32_TEMPLATE, LATER_ROUNDS, HOSTS } = require('./simulation');
const { GROUP_OF, TEAMS } = require('./worldcup2026');

const MATCH_HEIGHT = 40;
const SLOT_HEIGHT = 52;
const ROUND_WIDTH = 170;
const LEFT_PAD = 20;
const TOP_PAD = 20;

const ROUND_LABEL = {
  R32: 'Round of 32',
  R16: 'Round of 16',
  QF: 'Quarterfinal',
  SF: 'Semifinal',
  FINAL: 'Final',
};

function roundIndex(stage) {
  return { R32: 0, R16: 1, QF: 2, SF: 3, FINAL: 4 }[stage];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(p) {
  return (p * 100).toFixed(1) + '%';
}

function isHost(team) {
  return HOSTS.has(team);
}

function mostLikely(bracketSlot) {
  function top(map) {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return entries[0] || [null, 0];
  }
  return {
    a: top(bracketSlot.a),
    b: top(bracketSlot.b),
    winner: top(bracketSlot.winner),
  };
}

function buildPositions() {
  const pos = {};
  const r32 = R32_TEMPLATE.map((m) => m.n);
  const r16 = LATER_ROUNDS.filter((m) => m.n <= 96).map((m) => m.n);
  const qf = LATER_ROUNDS.filter((m) => m.n > 96 && m.n <= 100).map((m) => m.n);
  const sf = LATER_ROUNDS.filter((m) => m.n > 100 && m.n <= 102).map((m) => m.n);
  const final = LATER_ROUNDS.filter((m) => m.n > 102).map((m) => m.n);

  for (let i = 0; i < r32.length; i++) pos[r32[i]] = { stage: 'R32', idx: i };
  for (let i = 0; i < r16.length; i++) pos[r16[i]] = { stage: 'R16', idx: i };
  for (let i = 0; i < qf.length; i++) pos[qf[i]] = { stage: 'QF', idx: i };
  for (let i = 0; i < sf.length; i++) pos[sf[i]] = { stage: 'SF', idx: i };
  for (let i = 0; i < final.length; i++) pos[final[i]] = { stage: 'FINAL', idx: i };
  return pos;
}

function yFor(stage, idx) {
  const r = roundIndex(stage);
  const y = idx * SLOT_HEIGHT * Math.pow(2, r) + SLOT_HEIGHT * (Math.pow(2, r - 1) - 0.5);
  return TOP_PAD + y;
}

function xFor(stage) {
  return LEFT_PAD + roundIndex(stage) * ROUND_WIDTH;
}

function boxWidth() {
  return ROUND_WIDTH - 30;
}

function formatTeam(team, p) {
  if (!team) return '—';
  let label = team;
  if (label.length > 18) label = label.slice(0, 16) + '…';
  const flag = isHost(team) ? ' 🏠' : '';
  return `${label}${flag} ${pct(p)}`;
}

function generateBracketHTML({ odds, bracket, modelText = '' } = {}) {
  const positions = buildPositions();

  const width = LEFT_PAD + 5 * ROUND_WIDTH + ROUND_WIDTH + 40;
  const height = yFor('R32', 15) + TOP_PAD + 40;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" class="bracket-svg">\n`;
  svg += `  <defs>\n`;
  svg += `    <style>\n`;
  svg += `      .bracket-svg { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }\n`;
  svg += `      .match-box { fill: #f8f9fa; stroke: #dee2e6; stroke-width: 1; }\n`;
  svg += `      .match-box.host { fill: #fff8e1; }\n`;
  svg += `      .team-text { font-size: 11px; fill: #212529; font-weight: 500; }\n`;
  svg += `      .connector { stroke: #adb5bd; stroke-width: 1.5; fill: none; }\n`;
  svg += `      .match-no { font-size: 9px; fill: #adb5bd; }\n`;
  svg += `      .round-title { font-size: 14px; font-weight: 700; fill: #495057; }\n`;
  svg += `      .highlight path, .highlight rect { stroke: #0d6efd !important; stroke-width: 2 !important; }\n`;
  svg += `      .highlight text { fill: #0d6efd !important; font-weight: 700; }\n`;
  svg += `    </style>\n`;
  svg += `  </defs>\n`;

  for (const stage of ['R32', 'R16', 'QF', 'SF', 'FINAL']) {
    const x = xFor(stage) - 5;
    const y = TOP_PAD - 8;
    svg += `  <text x="${x}" y="${y}" class="round-title">${ROUND_LABEL[stage]}</text>\n`;
  }

  const matchIndex = {};
  for (const n of Object.keys(positions)) {
    const { stage, idx } = positions[n];
    matchIndex[n] = { x: xFor(stage) + boxWidth(), y: yFor(stage, idx) };
  }

  for (const m of LATER_ROUNDS) {
    const a = matchIndex[m.a];
    const b = matchIndex[m.b];
    const target = matchIndex[m.n];
    if (!a || !b || !target) continue;
    const midX = a.x + (target.x - a.x) / 2;
    svg += `  <path d="M ${a.x} ${a.y} H ${midX} V ${target.y} H ${target.x}" class="connector" />\n`;
    svg += `  <path d="M ${b.x} ${b.y} H ${midX} V ${target.y} H ${target.x}" class="connector" />\n`;
  }

  for (const n of Object.keys(positions)) {
    const { stage, idx } = positions[n];
    const x = xFor(stage);
    const y = yFor(stage, idx) - MATCH_HEIGHT / 2;
    const bw = boxWidth();
    const slot = bracket[n] || { a: {}, b: {}, winner: {} };
    const pick = mostLikely(slot);
    const teamA = pick.a[0];
    const teamB = pick.b[0];
    const clsA = isHost(teamA) ? 'match-box host' : 'match-box';
    const clsB = isHost(teamB) ? 'match-box host' : 'match-box';

    svg += `  <g id="match-${n}" class="match-group" data-team-a="${escapeHtml(teamA || '')}" data-team-b="${escapeHtml(teamB || '')}">\n`;
    svg += `    <rect x="${x}" y="${y}" width="${bw}" height="${MATCH_HEIGHT / 2}" class="${clsA}" />\n`;
    svg += `    <rect x="${x}" y="${y + MATCH_HEIGHT / 2}" width="${bw}" height="${MATCH_HEIGHT / 2}" class="${clsB}" />\n`;
    svg += `    <text x="${x + 4}" y="${y + 14}" class="team-text">${escapeHtml(formatTeam(teamA, pick.a[1]))}</text>\n`;
    svg += `    <text x="${x + 4}" y="${y + MATCH_HEIGHT / 2 + 14}" class="team-text">${escapeHtml(formatTeam(teamB, pick.b[1]))}</text>\n`;
    svg += `    <text x="${x + bw - 4}" y="${y - 4}" text-anchor="end" class="match-no">M${n}</text>\n`;
    svg += `  </g>\n`;
  }

  const finalY = yFor('FINAL', 0);
  const champX = xFor('FINAL') + boxWidth() + 30;
  const bw = boxWidth();
  const championTeam = mostLikely(bracket[103] || { winner: {} }).winner[0];
  const championProb = odds[championTeam]?.champion || 0;
  svg += `  <g id="match-champion" class="match-group">\n`;
  svg += `    <rect x="${champX}" y="${finalY - 18}" width="${bw}" height="36" class="match-box" style="fill:#e7f3ff;stroke:#0d6efd;" />\n`;
  svg += `    <text x="${champX + 4}" y="${finalY - 4}" class="round-title" style="font-size:11px;">Champion</text>\n`;
  svg += `    <text x="${champX + 4}" y="${finalY + 12}" class="team-text" style="font-weight:700;">${escapeHtml(formatTeam(championTeam, championProb))}</text>\n`;
  svg += `  </g>\n`;

  svg += `</svg>\n`;

  const teamOptions = TEAMS.map((t) => `    <option value="${escapeHtml(t)}">${escapeHtml(t)} (${GROUP_OF[t]})</option>`).join('\n');

  const topOdds = Object.entries(odds)
    .sort((a, b) => b[1].champion - a[1].champion)
    .slice(0, 10);
  const oddsRows = topOdds
    .map(([team, p], i) => {
      return `      <tr><td>${i + 1}</td><td>${escapeHtml(team)}</td><td>${GROUP_OF[team]}</td><td>${pct(p.champion)}</td><td>${pct(p.final)}</td><td>${pct(p.sf)}</td></tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polycup — 2026 World Cup Predicted Bracket</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background: #f4f6f8; color: #212529; }
  .container { max-width: 1200px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  .subtitle { color: #6c757d; margin-bottom: 18px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
  label { font-weight: 600; }
  select { padding: 6px 10px; border-radius: 4px; border: 1px solid #ced4da; font-size: 14px; }
  .svg-wrap { overflow-x: auto; border: 1px solid #dee2e6; border-radius: 6px; background: #fff; }
  .odds { margin-top: 24px; }
  .odds h2 { font-size: 18px; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; max-width: 600px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #dee2e6; }
  th { background: #f8f9fa; font-size: 12px; text-transform: uppercase; }
  .note { margin-top: 24px; font-size: 13px; color: #6c757d; border-top: 1px solid #dee2e6; padding-top: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>2026 FIFA World Cup — Predicted Bracket</h1>
  <div class="subtitle">Most likely occupant for each bracket slot from ${modelText}</div>
  <div class="controls">
    <label for="team-select">Highlight a team's path:</label>
    <select id="team-select">
      <option value="">— none —</option>
${teamOptions}
    </select>
  </div>
  <div class="svg-wrap">
${svg}
  </div>
  <div class="odds">
    <h2>Top 10 title odds</h2>
    <table>
      <thead><tr><th>Rank</th><th>Team</th><th>Group</th><th>Champion</th><th>Final</th><th>Semis</th></tr></thead>
      <tbody>
${oddsRows}
      </tbody>
    </table>
  </div>
  <div class="note">
    <strong>Model note:</strong> Probabilities are Monte Carlo estimates from the Polycup Elo + Dixon-Coles model. The bracket is the official FIFA 2026 fixed-seeding knockout bracket. Selecting a team highlights its predicted path; this is a probabilistic model for entertainment only, not betting advice.
  </div>
</div>
<script>
  const select = document.getElementById('team-select');
  const groups = document.querySelectorAll('.match-group');
  select.addEventListener('change', () => {
    const team = select.value;
    groups.forEach((g) => {
      const a = g.getAttribute('data-team-a');
      const b = g.getAttribute('data-team-b');
      if (team && (a === team || b === team)) {
        g.classList.add('highlight');
      } else {
        g.classList.remove('highlight');
      }
    });
  });
</script>
</body>
</html>
`;

  return html;
}

module.exports = { generateBracketHTML };
