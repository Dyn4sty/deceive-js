/**
 * CLI Interface - Command-line prompts and interactions
 */

import { createInterface } from 'readline';
import chalk from 'chalk';
import { LaunchGame, PresenceStatus } from '../types.js';

function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt user to select a game
 */
export async function promptForGame(): Promise<LaunchGame> {
  console.log('');
  console.log(chalk.bold('Select a game to launch:'));
  console.log('');
  console.log('  1. League of Legends');
  console.log('  2. Teamfight Tactics');
  console.log('  3. VALORANT');
  console.log('  4. Legends of Runeterra');
  console.log('  5. 2XKO (Lion)');
  console.log('  6. Riot Client only');
  console.log('  0. Cancel');
  console.log('');

  const choices: Record<string, LaunchGame> = {
    '1': LaunchGame.LoL,
    '2': LaunchGame.TFT,
    '3': LaunchGame.VALORANT,
    '4': LaunchGame.LoR,
    '5': LaunchGame.Lion,
    '6': LaunchGame.RiotClient,
  };

  const answer = await ask(chalk.cyan('Enter your choice (0-6): '));
  return choices[answer] ?? LaunchGame.Prompt;
}

/**
 * Prompt user to select a status
 */
export async function promptForStatus(): Promise<PresenceStatus> {
  console.log('');
  console.log(chalk.bold('Select your status:'));
  console.log('');
  console.log('  1. Offline (appear offline to friends)');
  console.log('  2. Mobile (appear on mobile app)');
  console.log('  3. Online (normal status)');
  console.log('');

  const answer = await ask(chalk.cyan('Enter your choice (1-3) [1]: '));
  switch (answer) {
    case '2':
      return PresenceStatus.Mobile;
    case '3':
      return PresenceStatus.Online;
    default:
      return PresenceStatus.Offline;
  }
}

/**
 * Ask a yes/no question. Returns defaultYes when stdin is not interactive.
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const answer = (
    await ask(chalk.cyan(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `))
  ).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

export interface CommandHandlers {
  setStatus: (status: PresenceStatus) => void;
  setEnabled: (enabled: boolean) => void;
  describeStatus: () => string;
  quit: () => void;
}

const COMMANDS_HELP = 'Commands: offline, online, mobile, enable, disable, status, help, quit';

/**
 * Read status commands from stdin while Deceive is running
 */
export function startCommandLoop(handlers: CommandHandlers): () => void {
  if (!process.stdin.isTTY) return () => {};

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  console.log(chalk.gray(COMMANDS_HELP));

  rl.on('line', (line) => {
    switch (line.trim().toLowerCase()) {
      case '':
        break;
      case 'offline':
        handlers.setStatus(PresenceStatus.Offline);
        break;
      case 'online':
        handlers.setStatus(PresenceStatus.Online);
        break;
      case 'mobile':
        handlers.setStatus(PresenceStatus.Mobile);
        break;
      case 'enable':
        handlers.setEnabled(true);
        console.log(handlers.describeStatus());
        break;
      case 'disable':
        handlers.setEnabled(false);
        console.log(handlers.describeStatus());
        break;
      case 'status':
        console.log(handlers.describeStatus());
        break;
      case 'quit':
      case 'exit':
        handlers.quit();
        break;
      default:
        console.log(COMMANDS_HELP);
    }
  });

  return () => rl.close();
}

/**
 * Display status message
 */
export function displayStatus(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

/**
 * Display error message
 */
export function displayError(message: string): void {
  console.log(chalk.red(`✗ ${message}`));
}

/**
 * Display warning message
 */
export function displayWarning(message: string): void {
  console.log(chalk.yellow(`⚠ ${message}`));
}
