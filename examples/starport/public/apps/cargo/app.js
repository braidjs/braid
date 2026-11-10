// Cargo shows the selected ship's manifest. Which columns it shows is a setting: kept for this
// user and this app by the desk, so it is the same in every Cargo, and after a reload.
const table = document.getElementById('manifest');
const boxes = { mass: document.getElementById('col-mass'), hazard: document.getElementById('col-hazard') };

function applyColumns(columns) {
  for (const [name, box] of Object.entries(boxes)) {
    box.checked = columns.includes(name);
    table.classList.toggle(`hide-${name}`, !box.checked);
  }
}
for (const box of Object.values(boxes)) {
  box.addEventListener('change', async () => {
    const columns = Object.keys(boxes).filter((name) => boxes[name].checked);
    applyColumns(columns);
    await braidDesktop.settings.set('columns', columns);
    table.dataset.saved = columns.join(',');
  });
}
braidDesktop.settings.get('columns').then((columns) => {
  if (Array.isArray(columns)) applyColumns(columns);
  table.dataset.loaded = '';
});

fdc3.addContextListener('starport.ship', (ship) => {
  document.getElementById('title').textContent = `Manifest · ${ship.name} (${ship.id.registry})`;
  const items = document.getElementById('items');
  items.replaceChildren();
  for (const entry of ship.cargo ?? []) {
    const row = items.insertRow();
    for (const [key, cls] of [['item'], ['qty'], ['mass', 'mass'], ['hazard', 'hazard']]) {
      const cell = row.insertCell();
      cell.textContent = entry[key];
      if (cls) cell.className = cls;
    }
  }
});
