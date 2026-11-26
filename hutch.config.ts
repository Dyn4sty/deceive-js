// @hutch cli=0.30.0
export default {
  packageManager: 'bun',
  scripts: {
    install: ['bun', 'install', '--frozen-lockfile'],
    dev: ['hutch', 'electrobun', 'dev', '--watch'],
    start: ['hutch', 'electrobun', 'dev'],
    'build:canary': ['hutch', 'electrobun', 'build', '--env=canary'],
    build: ['hutch', 'electrobun', 'build', '--env=stable'],
  },
  electrobun: {
    version: '2.0.7',
  },
};
