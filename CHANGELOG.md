# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0](https://github.com/Dyn4sty/deceive-node/compare/v1.1.0...v1.2.0) (2026-11-13)

### Added

- Native Apple Silicon (universal) tray helper for macOS, embedded in the compiled executable
- Tray menu: Enabled toggle, Default Status on Startup, Enable Lobby Chat
- Teamfight Tactics support (`launch tft`), direct game launch with `--allow-direct-launch`
- Terminal commands while running: offline, online, mobile, enable, disable, status, help, quit
- `--no-tray` and `--status prompt` options
- Deceive exits when the Riot Client exits

### Changed

- Chat proxy uses the valid `deceive-localhost.molenzwiebel.xyz` certificate (upstream Deceive), with a self-signed fallback
- Updated VALORANT fake player presence, strips standalone TFT presence, keeps in-game state when appearing online (upstream Deceive)
- Startup status remembers the last session by default; introduction messages are shown only on the first run
- Outgoing chat server TLS certificate is now validated
- Stops a running Riot Client only after confirmation

### Bug Fixes

- System tray failing to start in compiled executables ("Object is not a constructor")
- Crash on Ctrl+C ("Connection closed" unhandled error)
- Launching without arguments started with an Online status

## [1.0.1](https://github.com/Dyn4sty/deceive-node/compare/v1.0.0...v1.0.1) (2025-12-12)


### Bug Fixes

* disable ESLint rule for unsafe assignment in tray.ts ([ebc4bfb](https://github.com/Dyn4sty/deceive-node/commit/ebc4bfbfa0ff039edbd8365d54182709b41ba49e))

## [1.1.0](https://github.com/Dyn4sty/deceive-node/compare/v1.0.1...v1.1.0) (2025-12-12)

### Changed

- Migrated from Jest to Bun's native test runner for better performance
- Refactored code to use Bun's native TLS socket APIs
- Improved connection handling with data buffering to prevent race conditions
- Removed manual setup command - certificates now auto-generate on first use
- Fixed systray2 import to use default export correctly

### Removed

- Removed unused dependencies: ora, tsx, tree-kill, xml2js, jest, ts-jest
- Removed manual certificate setup command

### Fixed

- Fixed system tray initialization error with systray2 default export
- Fixed race condition where incoming data was lost before proxy connection was established

## [Unreleased]

### Added

- Initial TypeScript/Node.js port of Deceive
- Support for League of Legends, VALORANT, and Legends of Runeterra
- CLI interface with commander
- Cross-platform system tray interface
- Certificate generation and installation
- HTTPS proxy server with request interception
- Presence handler for modifying XMPP presence stanzas
- Game launcher with automatic detection
- Configuration management
- Comprehensive documentation (README, TECHNICAL_OVERVIEW, ARCHITECTURE)
- GitHub Actions workflows for CI/CD
- Issue templates and contribution guidelines
- Code of Conduct

## [1.0.0] - TBD

### Added

- Initial release
- Support for League of Legends, VALORANT, and Legends of Runeterra
- CLI and system tray interfaces
- Cross-platform support (Windows, macOS, Linux)
