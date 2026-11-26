# Architecture

This document describes the high-level architecture of League Deceiver.

League Deceiver is an [Electrobun](https://electrobun.dev) desktop app. Its main process runs on Bun and
owns the proxies, the native tray and the dialogs. The only web content is the small game picker window.

## Module Structure

```
src/
├── bun/
│   └── index.ts              # Electrobun main process: tray, single-instance lock, session lifecycle
├── startup.ts                # Startup sequence (UI-agnostic, takes a StartupUI)
├── controller.ts             # Chat proxy listener, connections, status state
├── types.ts                  # Types and enums
│
├── proxy/
│   ├── config-proxy.ts       # HTTP proxy for the Riot client configuration
│   ├── proxied-connection.ts # Per-connection XMPP proxy, presence rewriting
│   └── certificate.ts        # Trusted localhost certificate (with self-signed fallback)
│
├── launcher/
│   ├── game-launcher.ts      # Launch the Riot Client through the config proxy
│   └── process-manager.ts    # Detect, watch and stop Riot processes
│
├── ui/
│   ├── tray.ts               # Native tray menu (Electrobun Tray)
│   ├── dialogs.ts            # Native message boxes and notifications
│   └── picker.ts             # Game picker window (main-process side)
│
├── views/picker/             # Game picker web view (HTML, CSS, TS)
├── shared/rpc.ts             # Typed RPC schema between main process and picker
│
├── config/
│   └── config.ts             # Persistent settings (conf)
│
└── utils/
    ├── logger.ts             # Console + deceive.log logging
    └── platform.ts           # Platform detection
```

Only `src/bun/` and `src/ui/` import Electrobun. Everything else runs under plain Bun, so `bun test`
covers the proxy, presence and certificate logic without the native runtime.

## Component Diagram

```mermaid
flowchart TB
    subgraph App [Electrobun main process]
        Main["bun/index.ts"]
        Tray["ui/tray.ts"]
        Dialogs["ui/dialogs.ts"]
        Picker["ui/picker.ts"]
    end

    subgraph View [Webview]
        PickerView["views/picker"]
    end

    subgraph Core [Core]
        Startup["startup.ts"]
        Controller["controller.ts"]
    end

    subgraph Proxy [Proxy layer]
        ConfigProxy["config-proxy.ts"]
        ProxiedConn["proxied-connection.ts"]
        Cert["certificate.ts"]
    end

    subgraph Launcher [Launcher]
        GameLauncher["game-launcher.ts"]
        ProcessMgr["process-manager.ts"]
    end

    Main --> Startup
    Main --> Tray
    Startup -->|StartupUI| Dialogs
    Dialogs --> Picker
    Picker <-->|"typed RPC"| PickerView
    Startup --> Controller
    Startup --> ConfigProxy
    Startup --> GameLauncher
    Startup --> ProcessMgr
    Controller --> ProxiedConn
    Controller -->|onStateChange| Tray
    Startup --> Cert
```

## Startup Sequence

```mermaid
sequenceDiagram
    participant User
    participant Main as bun/index.ts
    participant Startup
    participant UI as Dialogs and picker
    participant ProcessMgr as Process manager
    participant Controller
    participant ConfigProxy as Config proxy

    User->>Main: Open Deceive
    Main->>Main: Hide Dock icon, single-instance lock, create tray
    Main->>Startup: startDeceive(nativeUI)
    Startup->>ProcessMgr: isClientRunning()
    alt Riot Client running
        Startup->>UI: confirm("stop the Riot Client?")
        Startup->>ProcessMgr: killProcesses()
    end
    Startup->>UI: pickGame() unless a game is remembered
    Startup->>Startup: loadCertificate()
    Startup->>Controller: new MainController(status), startChatListener()
    Startup->>ConfigProxy: start()
    Startup->>ProcessMgr: launch Riot Client, watch for exit
    Startup->>UI: notify("Deceive is running")
    Startup-->>Main: DeceiveSession
    Main->>Controller: onStateChange(tray.update)
```

## Presence Modification Flow

```mermaid
sequenceDiagram
    participant RC as Riot Client
    participant ProxiedConn as Proxied connection
    participant Server as Riot chat server

    RC->>ProxiedConn: XMPP presence stanza
    alt Contains presence and Deceive is enabled
        ProxiedConn->>ProxiedConn: rewriteAndSendPresence()
        Note over ProxiedConn: Rewrite show/st, strip game presences
        ProxiedConn->>Server: Modified stanza
    else Message to the fake player
        ProxiedConn->>ProxiedConn: handleChatMessage()
    else Other data
        ProxiedConn->>Server: Forward unchanged
    end
```

## Session Lifecycle

`startDeceive` returns a `DeceiveSession` (`controller` and `stop()`). The main process keeps one session at
a time:

- **Restart and Launch a Different Game** stops the session and the Riot Client, clears the remembered game
  and runs `startDeceive` again. The tray stays in place.
- **Quit** asks for confirmation, stops the session and the Riot Client, then calls `Utils.quit()`.
- The session ends on its own when the Riot Client exits (with a 3 second relaunch grace period) or after
  60 seconds without chat connections; the app then quits.

## Configuration

Settings are stored with `conf`:

```typescript
interface AppConfig {
  defaultGame: LaunchGame; // Remembered game, or 'prompt'
  defaultStatus: PresenceStatus; // Status of the last session
  startupStatus: StartupStatus; // 'chat' | 'offline' | 'mobile' | 'last'
  lastPromptedVersion: string;
  connectToMuc: boolean; // Lobby chat
  introductionShown: boolean; // Welcome messages are sent once
}
```

## Building

`electrobun.config.ts` describes the app bundle (views, copied assets, icons) and `hutch.config.ts` the tasks.
Hutch builds for the host platform only, so releases are built on a native runner per platform
(`.github/workflows/release.yml`).
