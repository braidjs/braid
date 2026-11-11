// Star Map follows the desk's selected ship, and takes PlotRoute. Its zoom and the plotted course
// are its own state: it hands them over when a layout is saved, and gets them back on restore.
const PORTS = { Luna: [70, 60], Mars: [150, 190], Ceres: [215, 95], Europa: [300, 45], Titan: [340, 180] };
const NS = 'http://www.w3.org/2000/svg';
const ports = document.getElementById('ports');
for (const [name, [x, y]] of Object.entries(PORTS)) {
  const dot = ports.appendChild(document.createElementNS(NS, 'circle'));
  dot.setAttribute('class', 'port');
  dot.dataset.port = name;
  dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 6);
  const label = ports.appendChild(document.createElementNS(NS, 'text'));
  label.setAttribute('x', x + 10); label.setAttribute('y', y + 4);
  label.textContent = name;
}

let zoom = 1;
let plotted;
function setZoom(next) {
  zoom = Math.min(3, Math.max(1, next));
  document.getElementById('sky').style.transform = `scale(${zoom})`;
  document.getElementById('zoom-label').textContent = `Zoom ${zoom}×`;
}
document.getElementById('in').addEventListener('click', () => setZoom(zoom + 1));
document.getElementById('out').addEventListener('click', () => setZoom(zoom - 1));

function highlight(ship) {
  for (const dot of ports.querySelectorAll('.port')) dot.classList.toggle('on', dot.dataset.port === ship.from || dot.dataset.port === ship.to);
}
function plot(ship) {
  const [from, to] = [PORTS[ship.from], PORTS[ship.to]];
  if (!from || !to) return;
  plotted = { name: ship.name, from: ship.from, to: ship.to };
  highlight(ship);
  const bend = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - 50];
  document.getElementById('route').setAttribute('d', `M${from} Q${bend} ${to}`);
  const dot = document.getElementById('ship');
  dot.setAttribute('cx', (from[0] + 2 * bend[0] + to[0]) / 4); dot.setAttribute('cy', (from[1] + 2 * bend[1] + to[1]) / 4); dot.setAttribute('r', 5);
  document.getElementById('status').textContent = `Course plotted for ${ship.name}: ${ship.from} → ${ship.to}`;
}

// A plotted course stays until another is plotted: a restored layout keeps its course whichever
// ship the desk has selected now.
fdc3.addContextListener('starport.ship', (ship) => {
  if (plotted?.name === ship.name) return;
  if (!plotted) highlight(ship);
  const where = `${ship.name} is between ${ship.from} and ${ship.to}.`;
  document.getElementById('status').textContent = plotted ? `${where} Course shown: ${plotted.name}.` : where;
});
fdc3.addIntentListener('PlotRoute', (ship) => plot(ship));

braidDesktop.onSaveLayout(() => ({ zoom, plotted }));
const restored = braidDesktop.restoredState;
if (restored) {
  setZoom(restored.zoom ?? 1);
  if (restored.plotted) plot(restored.plotted);
}
