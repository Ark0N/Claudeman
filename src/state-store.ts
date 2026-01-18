import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppState, createInitialState } from './types.js';

export class StateStore {
  private state: AppState;
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), '.claudeman', 'state.json');
    this.state = this.load();
    this.state.config.stateFilePath = this.filePath;
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): AppState {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data) as Partial<AppState>;
        // Merge with initial state to ensure all fields exist
        const initial = createInitialState();
        return {
          ...initial,
          ...parsed,
          sessions: { ...parsed.sessions },
          tasks: { ...parsed.tasks },
          ralphLoop: { ...initial.ralphLoop, ...parsed.ralphLoop },
          config: { ...initial.config, ...parsed.config },
        };
      }
    } catch (err) {
      console.error('Failed to load state, using initial state:', err);
    }
    return createInitialState();
  }

  save(): void {
    this.ensureDir();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getState(): AppState {
    return this.state;
  }

  getSessions() {
    return this.state.sessions;
  }

  getSession(id: string) {
    return this.state.sessions[id] || null;
  }

  setSession(id: string, session: AppState['sessions'][string]) {
    this.state.sessions[id] = session;
    this.save();
  }

  removeSession(id: string) {
    delete this.state.sessions[id];
    this.save();
  }

  getTasks() {
    return this.state.tasks;
  }

  getTask(id: string) {
    return this.state.tasks[id] || null;
  }

  setTask(id: string, task: AppState['tasks'][string]) {
    this.state.tasks[id] = task;
    this.save();
  }

  removeTask(id: string) {
    delete this.state.tasks[id];
    this.save();
  }

  getRalphLoopState() {
    return this.state.ralphLoop;
  }

  setRalphLoopState(ralphLoop: Partial<AppState['ralphLoop']>) {
    this.state.ralphLoop = { ...this.state.ralphLoop, ...ralphLoop };
    this.save();
  }

  getConfig() {
    return this.state.config;
  }

  setConfig(config: Partial<AppState['config']>) {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  reset(): void {
    this.state = createInitialState();
    this.state.config.stateFilePath = this.filePath;
    this.save();
  }
}

// Singleton instance
let storeInstance: StateStore | null = null;

export function getStore(filePath?: string): StateStore {
  if (!storeInstance) {
    storeInstance = new StateStore(filePath);
  }
  return storeInstance;
}
