import { EventEmitter } from 'node:events';
import { Session } from './session.js';
import { getStore } from './state-store.js';
import { SessionState } from './types.js';

export interface SessionManagerEvents {
  sessionStarted: (session: Session) => void;
  sessionStopped: (sessionId: string) => void;
  sessionError: (sessionId: string, error: string) => void;
  sessionOutput: (sessionId: string, output: string) => void;
  sessionCompletion: (sessionId: string, phrase: string) => void;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private store = getStore();

  constructor() {
    super();
    this.loadFromStore();
  }

  private loadFromStore(): void {
    const storedSessions = this.store.getSessions();
    // Note: We don't restore actual processes, just the state
    // Dead sessions are marked as stopped
    for (const [id, state] of Object.entries(storedSessions)) {
      if (state.status !== 'stopped') {
        state.status = 'stopped';
        state.pid = null;
        this.store.setSession(id, state);
      }
    }
  }

  async createSession(workingDir: string): Promise<Session> {
    const config = this.store.getConfig();

    if (this.sessions.size >= config.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent sessions (${config.maxConcurrentSessions}) reached`);
    }

    const session = new Session({ workingDir });

    // Set up event forwarding
    session.on('output', (data) => {
      this.emit('sessionOutput', session.id, data);
      this.updateSessionState(session);
    });

    session.on('error', (data) => {
      this.emit('sessionError', session.id, data);
      this.updateSessionState(session);
    });

    session.on('completion', (phrase) => {
      this.emit('sessionCompletion', session.id, phrase);
    });

    session.on('exit', () => {
      this.emit('sessionStopped', session.id);
      this.updateSessionState(session);
    });

    await session.start();

    this.sessions.set(session.id, session);
    this.store.setSession(session.id, session.toState());

    this.emit('sessionStarted', session);
    return session;
  }

  async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      // Update store to mark as stopped if it exists there
      const storedSession = this.store.getSession(id);
      if (storedSession) {
        storedSession.status = 'stopped';
        storedSession.pid = null;
        this.store.setSession(id, storedSession);
      }
      return;
    }

    await session.stop();
    this.sessions.delete(id);
    this.updateSessionState(session);
  }

  async stopAllSessions(): Promise<void> {
    const stopPromises = Array.from(this.sessions.keys()).map((id) =>
      this.stopSession(id)
    );
    await Promise.all(stopPromises);
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getIdleSessions(): Session[] {
    return this.getAllSessions().filter((s) => s.isIdle());
  }

  getBusySessions(): Session[] {
    return this.getAllSessions().filter((s) => s.isBusy());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  private updateSessionState(session: Session): void {
    this.store.setSession(session.id, session.toState());
  }

  getStoredSessions(): Record<string, SessionState> {
    return this.store.getSessions();
  }

  async sendToSession(sessionId: string, input: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await session.sendInput(input);
  }

  getSessionOutput(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.getOutput() ?? null;
  }

  getSessionError(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.getError() ?? null;
  }
}

// Singleton instance
let managerInstance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!managerInstance) {
    managerInstance = new SessionManager();
  }
  return managerInstance;
}
