import { createEventBus } from '@braidlabs/data';

// Comms takes HailShip. It need not be open: the desk launches it for the raise. It also listens
// to the tower's bus, and logs departures as they happen.
const REPLIES = ['Copy that, Starport.', 'Holding at the outer marker.', 'Could you repeat? We were watching the rings.', 'Roger. Kettle is on.', 'Requesting a berth with a view.'];
const log = document.getElementById('log');
let hailed;
let replies = 0;

function say(text, who) {
  const line = log.appendChild(document.createElement('p'));
  line.className = who;
  line.textContent = text;
  log.scrollTop = log.scrollHeight;
}

fdc3.addIntentListener('HailShip', (ship) => {
  hailed = ship;
  document.getElementById('status').textContent = `Channel open with ${ship.name}.`;
  say(`Hailing ${ship.name} (${ship.id.registry})…`, 'sys');
  setTimeout(() => say(`${ship.name} here. Go ahead, Starport.`, 'them'), 500);
});

document.getElementById('send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('message');
  if (!input.value.trim()) return;
  say(input.value, 'me');
  input.value = '';
  if (hailed) setTimeout(() => say(REPLIES[replies++ % REPLIES.length], 'them'), 600);
});

// Events are not replayed: a Comms opened after a departure does not log it. The count is state,
// so it is right from the start.
const tower = createEventBus({ consumer: 'comms' }).channel('tower');
tower.addEventListener('ship.departed', ({ payload }) => say(`Tower: ${payload.name} departed for ${payload.to}.`, 'sys'));
tower.subscribe((state) => {
  const departures = state?.departed?.length ?? 0;
  document.getElementById('tower').textContent = `${departures} ${departures === 1 ? 'departure' : 'departures'} today`;
});
