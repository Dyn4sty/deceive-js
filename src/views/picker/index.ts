import { Electroview } from 'electrobun/view';
import type { PickerRPC } from '../../shared/rpc.js';
import type { LaunchGame } from '../../types.js';

const rpc = Electroview.defineRPC<PickerRPC>({
  maxRequestTime: Infinity,
  handlers: { requests: {}, messages: {} },
});
new Electroview({ rpc });

const remember = document.getElementById('remember') as HTMLInputElement;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.games button'));

for (const button of buttons) {
  button.addEventListener('click', () => {
    for (const b of buttons) b.disabled = true;
    const game = button.dataset['game'] as LaunchGame;
    void rpc.request.chooseGame({ game, remember: remember.checked });
  });
}
