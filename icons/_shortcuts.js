// SVGs de los 3 shortcuts del manifest. Glifo blanco sobre cuadrado redondeado
// con el degradado de marca. 96x96 final.
const base = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7cc4ec"/><stop offset="1" stop-color="#2f7fb0"/>
  </linearGradient></defs>
  <rect width="96" height="96" rx="22" fill="url(#g)"/>
  <g fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    ${inner}
  </g>
</svg>`;

module.exports = {
  'shortcut-agenda.svg': base(`
    <rect x="26" y="20" width="44" height="56" rx="6"/>
    <line x1="36" y1="36" x2="60" y2="36"/>
    <line x1="36" y1="48" x2="60" y2="48"/>
    <line x1="36" y1="60" x2="52" y2="60"/>`),
  'shortcut-hub.svg': base(`
    <circle cx="48" cy="48" r="24"/>
    <ellipse cx="48" cy="48" rx="10" ry="24"/>
    <line x1="24" y1="48" x2="72" y2="48"/>`),
  'shortcut-despacho.svg': base(`
    <path d="M22 58V34h30v24" />
    <path d="M52 42h14l8 10v6H52z" />
    <circle cx="34" cy="62" r="6"/>
    <circle cx="62" cy="62" r="6"/>`),
};
