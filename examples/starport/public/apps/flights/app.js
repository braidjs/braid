// Flights knows the ships. It knows nothing about the other apps: it broadcasts the ship the user
// picks, and raises intents for whoever can take them.
const SHIPS = [
  { name: 'Marigold', id: { registry: 'NX-204' }, from: 'Ceres', to: 'Europa', eta: '14:20', status: 'On time', bearing: 40, range: 0.55,
    cargo: [{ item: 'Seed vault crates', qty: 120, mass: '4.8 t', hazard: 'None' }, { item: 'Hydroponic gel', qty: 60, mass: '2.1 t', hazard: 'Low' }, { item: 'Honey (yes, honey)', qty: 12, mass: '0.3 t', hazard: 'Sticky' }] },
  { name: 'Slow Comet', id: { registry: 'KT-077' }, from: 'Titan', to: 'Mars', eta: '15:05', status: 'Delayed', bearing: 135, range: 0.8,
    cargo: [{ item: 'Methane ice', qty: 900, mass: '41 t', hazard: 'Flammable' }, { item: 'Tourist luggage', qty: 48, mass: '1.2 t', hazard: 'None' }] },
  { name: 'Paper Lantern', id: { registry: 'PL-311' }, from: 'Luna', to: 'Ceres', eta: '15:40', status: 'Boarding', bearing: 220, range: 0.35,
    cargo: [{ item: 'Printed books', qty: 2000, mass: '1.6 t', hazard: 'None' }, { item: 'Tea', qty: 300, mass: '0.9 t', hazard: 'None' }, { item: 'One piano', qty: 1, mass: '0.4 t', hazard: 'Fragile' }] },
  { name: 'Big Otter', id: { registry: 'BO-900' }, from: 'Mars', to: 'Titan', eta: '16:10', status: 'On time', bearing: 300, range: 0.68,
    cargo: [{ item: 'Reactor coolant', qty: 40, mass: '12 t', hazard: 'High' }, { item: 'Rubber ducks', qty: 5000, mass: '0.5 t', hazard: 'None' }] },
  { name: 'Quiet Tuesday', id: { registry: 'QT-002' }, from: 'Europa', to: 'Luna', eta: '17:30', status: 'On time', bearing: 85, range: 0.9,
    cargo: [{ item: 'Ice cores', qty: 75, mass: '9.3 t', hazard: 'Cold' }, { item: 'Lab samples', qty: 14, mass: '0.1 t', hazard: 'Bio' }] },
];
const context = (ship) => ({ type: 'starport.ship', ...ship });

const rows = document.getElementById('ships');
let selected;

for (const ship of SHIPS) {
  const row = rows.insertRow();
  row.dataset.ship = ship.id.registry;
  row.tabIndex = 0;
  row.innerHTML = `<td><span class="name"></span> <span class="mono" style="opacity:.55"></span></td><td></td><td class="mono"></td><td><span class="pill"></span></td>`;
  row.cells[0].children[0].textContent = ship.name;
  row.cells[0].children[1].textContent = ship.id.registry;
  row.cells[1].textContent = `${ship.from} → ${ship.to}`;
  row.cells[2].textContent = ship.eta;
  row.cells[3].firstChild.textContent = ship.status;
  row.cells[3].firstChild.classList.add(ship.status.toLowerCase().replace(' ', '-'));
  // its own broadcast does not come back to it, so a pick is shown here and then told to the desk
  const pick = () => {
    show(ship);
    fdc3.broadcast(context(ship));
  };
  row.addEventListener('click', pick);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    pick();
  });
}

function show(ship) {
  selected = ship;
  for (const row of rows.rows) row.toggleAttribute('aria-current', row.dataset.ship === ship?.id.registry);
  document.getElementById('picked').textContent = ship ? `${ship.name} selected` : 'No ship selected';
  document.getElementById('plot').disabled = document.getElementById('hail').disabled = !ship;
}

// another Flights' pick arrives here
fdc3.addContextListener('starport.ship', (ship) => show(SHIPS.find((known) => known.id.registry === ship.id?.registry)));

// "Plot route" does not say which app. Two can take it; the desk asks, or remembers.
const raise = (intent) => fdc3.raiseIntent(intent, context(selected)).catch((error) => console.info(`${intent}: ${error.message}`));
document.getElementById('plot').addEventListener('click', () => raise('PlotRoute'));
document.getElementById('hail').addEventListener('click', () => raise('HailShip'));
