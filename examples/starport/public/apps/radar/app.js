// Radar is the other app that can take PlotRoute: same intent, a different answer.
const blip = document.getElementById('blip');
const status = document.getElementById('status');

function place(ship) {
  const angle = (ship.bearing - 90) * (Math.PI / 180);
  blip.style.display = 'block';
  blip.style.left = `${50 + Math.cos(angle) * ship.range * 46}%`;
  blip.style.top = `${50 + Math.sin(angle) * ship.range * 46}%`;
}

let locked;

// A launched Radar hears the channel's current ship as well as the raise that launched it, in
// either order: the same ship again does not break the lock.
fdc3.addContextListener('starport.ship', (ship) => {
  if (locked === ship.id.registry) return;
  locked = undefined;
  place(ship);
  blip.classList.remove('locked');
  status.textContent = `${ship.name} at bearing ${ship.bearing}°.`;
});
fdc3.addIntentListener('PlotRoute', (ship) => {
  locked = ship.id.registry;
  place(ship);
  blip.classList.add('locked');
  status.textContent = `Locked on ${ship.name}: bearing ${ship.bearing}°, tracking to ${ship.to}.`;
});
