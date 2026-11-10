// Comms takes HailShip. It need not be open: the desk launches it for the raise.
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
