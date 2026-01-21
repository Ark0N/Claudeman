# Claudeman TUI Implementation Plan

## Overview

Build a full terminal user interface (TUI) for Claudeman that mirrors the web interface functionality. The TUI will allow users to:
- See all running screen sessions as tabs
- Switch between sessions with keyboard shortcuts
- View real-time terminal output from each Claude session
- Create, manage, and kill sessions
- Control respawn and Ralph loop features

---

## Implementation Status

> Last updated: 2026-01-21

### Completed Files

| File | Status | Notes |
|------|--------|-------|
| `src/tui/index.tsx` | ✅ Done | Entry point with Ink render |
| `src/tui/App.tsx` | ✅ Done | Main app component with state management |
| `src/tui/components/StartScreen.tsx` | ✅ Done | Initial session discovery view |
| `src/tui/components/TabBar.tsx` | ✅ Done | Session tabs at top |
| `src/tui/components/TerminalView.tsx` | ✅ Done | PTY output display (renamed from Terminal.tsx) |
| `src/tui/components/StatusBar.tsx` | ✅ Done | Bottom status bar |
| `src/tui/components/HelpOverlay.tsx` | ✅ Done | Keyboard shortcuts help |
| `src/tui/components/index.ts` | ✅ Done | Component exports |
| `src/tui/hooks/useSessionManager.ts` | ✅ Done | Session management hook |
| `src/tui/hooks/index.ts` | ✅ Done | Hook exports |
| `src/cli.ts` | ✅ Done | `tui` command added |

### Remaining Work

| File | Status | Notes |
|------|--------|-------|
| `src/tui/components/RalphPanel.tsx` | ❌ Pending | Inner loop/todo tracking panel |
| `src/tui/hooks/useTerminal.ts` | ❌ Pending | Terminal output handling hook |
| `src/tui/hooks/useKeyboard.ts` | ❌ Pending | Global keyboard shortcuts hook |
| `src/tui/store/tui-state.ts` | ❌ Pending | TUI-specific state management |

### Phase Completion

- [x] **Phase 1**: Foundation (entry point, main app)
- [x] **Phase 2**: Start Screen & Session Discovery
- [x] **Phase 3**: Tab System
- [x] **Phase 4**: Terminal Display (basic)
- [x] **Phase 5**: Status Bar
- [ ] **Phase 6**: Session Management (partial - create/kill works)
- [ ] **Phase 7**: Advanced Features (Ralph panel, respawn banner)

### Usage

```bash
claudeman tui            # Start TUI
npx tsx src/index.ts tui # Dev mode
```

---

## Technology Choice: **Ink (React for CLI)**

**Why Ink over alternatives:**
1. **Component-based**: Familiar React patterns, composable UI
2. **Already in ecosystem**: Claude CLI uses Ink (explains the screen input workaround)
3. **TypeScript native**: First-class TS support
4. **Active maintenance**: Regular updates, good community
5. **Handles PTY well**: Built for terminal apps with real-time output

**Alternatives considered:**
- `blessed`/`blessed-contrib`: Legacy, unmaintained, complex API
- `terminal-kit`: Lower-level, more boilerplate
- Raw ANSI: Too low-level for complex UIs
- Existing bash script: Not extensible enough

## Architecture

```
src/
├── tui/
│   ├── index.ts              # Entry point, CLI command
│   ├── App.tsx               # Main TUI app component
│   ├── components/
│   │   ├── TabBar.tsx        # Session tabs at top
│   │   ├── Terminal.tsx      # PTY output display
│   │   ├── StatusBar.tsx     # Bottom status bar
│   │   ├── SessionInfo.tsx   # Session details panel
│   │   ├── HelpOverlay.tsx   # Keyboard shortcuts help
│   │   ├── RalphPanel.tsx    # Inner loop/todo tracking
│   │   └── StartScreen.tsx   # Initial session discovery
│   ├── hooks/
│   │   ├── useSession.ts     # Session management hook
│   │   ├── useTerminal.ts    # Terminal output handling
│   │   └── useKeyboard.ts    # Global keyboard shortcuts
│   └── store/
│       └── tui-state.ts      # TUI-specific state
```

## Implementation Steps

### Phase 1: Foundation (Core Infrastructure)

#### Step 1.1: Add Dependencies
```bash
npm install ink ink-text-input ink-spinner ink-box react
npm install -D @types/react
```

#### Step 1.2: Create Entry Point (`src/tui/index.ts`)
- Add `tui` command to CLI in `src/cli.ts`
- Create Ink render entry point
- Handle graceful shutdown (restore terminal)

#### Step 1.3: Create Main App Component (`src/tui/App.tsx`)
- Full-screen layout with Ink's `Box` components
- Three regions: TabBar (top), Terminal (center), StatusBar (bottom)
- Global keyboard event handling

### Phase 2: Start Screen & Session Discovery

#### Step 2.1: Create StartScreen Component
On launch, the TUI should:
1. Read `~/.claudeman/screens.json` for existing sessions
2. Check which screens are alive (`screen -ls`)
3. Display list of sessions with status
4. Allow user to:
   - Select and attach to existing session
   - Create new session
   - Kill dead sessions

#### Step 2.2: Session List Display
```
╔═══════════════════════════════════════════════════════════╗
║                    Claudeman TUI                          ║
╠═══════════════════════════════════════════════════════════╣
║  Existing Sessions:                                       ║
║                                                           ║
║  [1] ● testcase          2h 15m    idle     claude       ║
║  [2] ● another-case      45m       working  claude       ║
║  [3] ○ old-session       3d        dead     claude       ║
║                                                           ║
║  ─────────────────────────────────────────────────────────║
║  [n] New session   [1-9] Select   [d] Delete   [q] Quit  ║
╚═══════════════════════════════════════════════════════════╝
```

### Phase 3: Tab System

#### Step 3.1: TabBar Component
- Horizontal tab bar at top of screen
- Shows session name + status indicator (● idle, ◐ working)
- Keyboard navigation: Ctrl+Tab (next), Ctrl+Shift+Tab (prev), Ctrl+1-9 (direct)
- Visual indication of active tab

#### Step 3.2: Tab State Management
- Track active session ID
- Track tab order (array of session IDs)
- Handle session creation/deletion (add/remove tabs)
- Persist tab order to state

### Phase 4: Terminal Display

#### Step 4.1: Terminal Component
- Display PTY output for active session
- Scrollable viewport (show last N lines that fit)
- ANSI color support (Ink handles this)
- Handle terminal resize

#### Step 4.2: Output Integration
Connect to existing Session class:
```typescript
// Subscribe to session events
session.on('terminal', (data) => {
  // Append to display buffer
});

session.on('clearTerminal', () => {
  // Clear display buffer
});
```

#### Step 4.3: Input Handling
- Capture keyboard input when terminal focused
- Send to session via `session.write()` or `session.writeViaScreen()`
- Handle special keys (Ctrl+C, Ctrl+D, etc.)
- Distinguish between TUI commands and session input

### Phase 5: Status Bar

#### Step 5.1: StatusBar Component
Display at bottom:
- Session status (idle/working)
- Token count
- Cost
- Respawn status (if enabled)
- Ralph loop status (if active)

#### Step 5.2: System Stats (Optional)
- CPU/Memory usage (like web UI)
- Poll periodically from `/proc`

### Phase 6: Session Management

#### Step 6.1: New Session Creation
- Prompt for case name (or use default)
- Create case folder if needed
- Start interactive Claude session
- Add to tab bar

#### Step 6.2: Session Operations
- Close session (Ctrl+W): Kill screen, remove tab
- Kill all (Ctrl+Shift+K): Confirm dialog, kill all screens

### Phase 7: Advanced Features

#### Step 7.1: Ralph Panel
When Ralph loop active, show:
- Progress ring (iteration count)
- Todo list with status
- Completion phrase status

#### Step 7.2: Help Overlay
- Press `?` or `F1` to show
- List all keyboard shortcuts
- Dismiss with Escape

#### Step 7.3: Respawn Banner
When respawn enabled:
- Show current state
- Cycle count
- Controls (pause/resume)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+1-9` | Go to tab N |
| `Ctrl+N` | New session |
| `Ctrl+W` | Close current session |
| `Ctrl+Shift+K` | Kill all sessions |
| `Ctrl+L` | Clear terminal |
| `?` or `F1` | Show help |
| `Escape` | Close overlay/panel |
| `Ctrl+C` | Exit TUI (with confirm) |

## Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                        TUI App                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                      TabBar                              │ │
│  │  [testcase ●] [another ◐] [+]                           │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                                                         │ │
│  │                   Terminal Viewport                     │ │
│  │                                                         │ │
│  │   (PTY output from active session)                     │ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  StatusBar: idle | 45.2k tokens | $0.82 | respawn: off │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
         │                      │
         │ events               │ input
         ▼                      ▼
┌─────────────────┐    ┌─────────────────┐
│    Session      │◄───│  PTY (node-pty) │
│  (existing)     │    └─────────────────┘
└─────────────────┘
```

## Files to Create

| File | Purpose | LOC Est. |
|------|---------|----------|
| `src/tui/index.ts` | Entry point | 30 |
| `src/tui/App.tsx` | Main app | 150 |
| `src/tui/components/TabBar.tsx` | Tab navigation | 80 |
| `src/tui/components/Terminal.tsx` | Output display | 120 |
| `src/tui/components/StatusBar.tsx` | Status display | 60 |
| `src/tui/components/StartScreen.tsx` | Initial view | 100 |
| `src/tui/components/HelpOverlay.tsx` | Help modal | 50 |
| `src/tui/components/RalphPanel.tsx` | Loop tracking | 80 |
| `src/tui/hooks/useSession.ts` | Session management | 100 |
| `src/tui/hooks/useTerminal.ts` | Terminal handling | 80 |
| `src/tui/hooks/useKeyboard.ts` | Key shortcuts | 60 |
| `src/tui/store/tui-state.ts` | State management | 50 |

**Total: ~960 lines of new code**

## Files to Modify

| File | Change |
|------|--------|
| `src/cli.ts` | Add `tui` command |
| `src/index.ts` | Export TUI if needed |
| `package.json` | Add Ink dependencies |
| `tsconfig.json` | Add JSX support for TSX files |

## Testing Strategy

1. **Unit tests**: Component rendering with Ink's test utilities
2. **Integration tests**: Session creation, tab switching
3. **Manual testing**: Real Claude sessions, screen attach/detach

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Terminal resize handling | Use Ink's built-in resize detection |
| PTY output performance | Reuse existing batching from Session class |
| Input conflicts (TUI vs session) | Clear mode distinction, Escape to exit input mode |
| Screen attachment complexity | Reuse existing screen-manager.ts logic |

## Success Criteria

1. Launch TUI and see existing sessions from `screens.json`
2. Switch between sessions with tabs
3. See real-time Claude output in terminal
4. Send input to active session
5. Create new sessions
6. Kill sessions
7. Responsive keyboard navigation
8. Clean exit (restore terminal state)

## Implementation Order

1. **Week 1**: Phases 1-2 (Foundation + Start Screen)
2. **Week 2**: Phases 3-4 (Tabs + Terminal)
3. **Week 3**: Phases 5-6 (Status + Session Management)
4. **Week 4**: Phase 7 (Advanced Features)

## Commands

After implementation:
```bash
# Start TUI
claudeman tui

# Or via npm/tsx
npx tsx src/index.ts tui
npm run tui  # After adding script
```
