// Authored side-profile vehicle icons, all facing right on a shared 64x32 grid so they line up
// in chips, roster rows and map markers. Geometry only: no external assets.

const WHEEL = (cx, cy = 25) =>
  `<circle cx="${cx}" cy="${cy}" r="5" fill="#111827"/><circle cx="${cx}" cy="${cy}" r="2.4" fill="#cbd5e1"/><circle cx="${cx}" cy="${cy}" r="0.9" fill="#475569"/>`;

const LIGHTBAR = (x, y, w = 10) =>
  `<rect x="${x}" y="${y}" width="${w}" height="2.6" rx="1.2" fill="#ef4444"/><rect x="${x + w / 2 - 0.5}" y="${y}" width="1" height="2.6" fill="#fff" opacity=".7"/>`;

export const VEHICLES = {
  engine: `
    <rect x="3" y="8" width="38" height="16" rx="1.8" fill="#bf2726"/>
    <rect x="3" y="8" width="38" height="2.2" fill="#8f1d1c"/>
    <path d="M41 6.5h9.5c1.2 0 2.2.6 2.8 1.6l4.4 7.4c.5.8.8 1.8.8 2.8V24H41z" fill="#bf2726"/>
    <path d="M44 9h6.2c.6 0 1.1.3 1.4.8l3.3 5.7H44z" fill="#dbeafe"/>
    <rect x="3" y="16.6" width="55.5" height="1.4" fill="#f8fafc"/>
    <path d="M10 10.5v13M17.5 10.5v13M25 10.5v13M32.5 10.5v13" stroke="#8f1d1c" stroke-width=".8"/>
    <rect x="57.2" y="19.5" width="3.8" height="4.5" rx="1" fill="#cbd5e1"/>
    ${LIGHTBAR(43.5, 3.9, 9)}
    ${WHEEL(13)}${WHEEL(49)}`,

  aerial: `
    <rect x="2" y="9" width="40" height="15" rx="1.8" fill="#bf2726"/>
    <path d="M42 8h9.5c1.2 0 2.2.6 2.8 1.6l4.4 7.4c.5.8.8 1.8.8 2.8V24H42z" fill="#bf2726"/>
    <path d="M45 10.5h6.2c.6 0 1.1.3 1.4.8l3 5.2H45z" fill="#dbeafe"/>
    <rect x="2" y="17.4" width="57.5" height="1.3" fill="#f8fafc"/>
    <g fill="none" stroke="#e2e8f0" stroke-width="1.1" stroke-linecap="round">
      <path d="M4 3.2h58M4 6.6h58"/>
      <path d="M8 3.2v3.4M13 3.2v3.4M18 3.2v3.4M23 3.2v3.4M28 3.2v3.4M33 3.2v3.4M38 3.2v3.4M43 3.2v3.4M48 3.2v3.4M53 3.2v3.4M58 3.2v3.4"/>
    </g>
    <path d="M6 6.8 9 9M30 6.8l-3 2.2" stroke="#94a3b8" stroke-width="1.4"/>
    <rect x="58.2" y="19.5" width="3.6" height="4.5" rx="1" fill="#cbd5e1"/>
    ${WHEEL(9)}${WHEEL(20)}${WHEEL(50)}`,

  medic: `
    <rect x="3" y="4.5" width="36" height="19.5" rx="2" fill="#f8fafc" stroke="#cbd5e1" stroke-width=".8"/>
    <rect x="3" y="15" width="55.6" height="3" fill="#bf2726"/>
    <path d="M39 10h8.6c1 0 1.9.5 2.5 1.3l3.8 4.9h3c1 0 1.8.8 1.8 1.8V24H39z" fill="#f8fafc" stroke="#cbd5e1" stroke-width=".8"/>
    <path d="M41.5 11.8h5.6c.5 0 .9.2 1.2.6l2.6 3.4h-9.4z" fill="#dbeafe"/>
    <g transform="translate(21 9.8)" fill="#2563eb">
      <rect x="-1.1" y="-4" width="2.2" height="8" rx=".4"/>
      <rect x="-1.1" y="-4" width="2.2" height="8" rx=".4" transform="rotate(60)"/>
      <rect x="-1.1" y="-4" width="2.2" height="8" rx=".4" transform="rotate(-60)"/>
    </g>
    ${LIGHTBAR(5, 2, 8)}${LIGHTBAR(29, 2, 8)}
    ${WHEEL(13)}${WHEEL(48)}`,

  police: `
    <path d="M4.5 9.2c0-1.4 1.1-2.5 2.5-2.5h31.6c1 0 1.9.4 2.5 1.2l4.6 5.4 9.6 1.6c1.9.3 3.3 2 3.3 3.9V22c0 1.1-.9 2-2 2H6.5c-1.1 0-2-.9-2-2z" fill="#1e3a8a"/>
    <path d="M7.6 8.8h10.6v4.8H7.6zM19.8 8.8h9.4v4.8h-9.4zM30.8 8.8h7.3c.5 0 1 .2 1.3.6l3.6 4.2H30.8z" fill="#dbeafe"/>
    <path d="M4.5 16.4h54.1v3.4H4.5z" fill="#f8fafc"/>
    <path d="M19 8.8V24M30 8.8V24" stroke="#172554" stroke-width=".7"/>
    <rect x="14" y="3.4" width="15" height="2.8" rx="1.3" fill="#ef4444"/><rect x="21.5" y="3.4" width="7.5" height="2.8" rx="1.3" fill="#2563eb"/>
    <rect x="57" y="15.3" width="3.2" height="1.8" rx=".8" fill="#fde68a"/>
    <rect x="58.2" y="20.5" width="2.6" height="3.5" rx=".8" fill="#334155"/>
    ${WHEEL(15)}${WHEEL(49)}`,
};

export function vehicleSVG(type, cls = "") {
  return `<svg class="${cls}" viewBox="0 0 64 32" aria-hidden="true" focusable="false">${VEHICLES[type] || ""}</svg>`;
}

// The Mayor: a gold five-point star on a navy seal. Not a vehicle, so it is square.
export function mayorSVG(cls = "") {
  return `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="16" cy="16" r="14.5" fill="#152a40"/>
    <circle cx="16" cy="16" r="12.2" fill="none" stroke="#f9c031" stroke-width="1.2"/>
    <path d="M16 6.8l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z" fill="#f9c031"/>
  </svg>`;
}
