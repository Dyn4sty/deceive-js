/**
 * RPC schema shared by the main process and the game picker view
 */

import type { RPCSchema } from 'electrobun/view';
import type { LaunchGame } from '../types.js';

export type PickerRPC = {
  bun: RPCSchema<{
    requests: {
      chooseGame: {
        params: { game: LaunchGame; remember: boolean };
        response: void;
      };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
};
