import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { SessionState, SessionStatus, SessionConfig } from './types.js';

export interface SessionEvents {
  output: (data: string) => void;
  error: (data: string) => void;
  exit: (code: number | null) => void;
  completion: (phrase: string) => void;
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly workingDir: string;
  readonly createdAt: number;

  private process: ChildProcess | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;
  private _outputBuffer: string = '';
  private _errorBuffer: string = '';
  private _lastActivityAt: number;

  constructor(config: Partial<SessionConfig> & { workingDir: string }) {
    super();
    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.createdAt = config.createdAt || Date.now();
    this._lastActivityAt = this.createdAt;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get outputBuffer(): string {
    return this._outputBuffer;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.process) {
        reject(new Error('Session already started'));
        return;
      }

      try {
        // Spawn claude CLI with --print flag for non-interactive mode
        this.process = spawn('claude', ['--print'], {
          cwd: this.workingDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        this._status = 'idle';
        this._lastActivityAt = Date.now();

        this.process.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          this._outputBuffer += text;
          this._lastActivityAt = Date.now();
          this.emit('output', text);
          this.checkForCompletion(text);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          this._errorBuffer += text;
          this._lastActivityAt = Date.now();
          this.emit('error', text);
        });

        this.process.on('error', (err) => {
          this._status = 'error';
          this.emit('error', err.message);
          reject(err);
        });

        this.process.on('exit', (code) => {
          this._status = 'stopped';
          this.process = null;
          this.emit('exit', code);
        });

        // Give process time to start
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            resolve();
          }
        }, 100);
      } catch (err) {
        this._status = 'error';
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        this._status = 'stopped';
        resolve();
        return;
      }

      const cleanup = () => {
        this.process = null;
        this._status = 'stopped';
        this._currentTaskId = null;
        resolve();
      };

      this.process.once('exit', cleanup);

      // Try graceful shutdown first
      this.process.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  async sendInput(input: string): Promise<void> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Session not started or stdin not available');
    }

    this._status = 'busy';
    this._lastActivityAt = Date.now();

    return new Promise((resolve, reject) => {
      this.process!.stdin!.write(input + '\n', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._outputBuffer = '';
    this._errorBuffer = '';
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._outputBuffer;
  }

  getError(): string {
    return this._errorBuffer;
  }

  clearBuffers(): void {
    this._outputBuffer = '';
    this._errorBuffer = '';
  }

  private checkForCompletion(text: string): void {
    // Check for completion phrase pattern: <promise>...</promise>
    const promiseMatch = text.match(/<promise>([^<]+)<\/promise>/);
    if (promiseMatch) {
      this.emit('completion', promiseMatch[1]);
    }

    // Also check for common completion indicators
    const completionIndicators = [
      /Task completed successfully/i,
      /All tasks done/i,
      /✓ Complete/i,
    ];

    for (const pattern of completionIndicators) {
      if (pattern.test(text)) {
        this.emit('completion', 'auto-detected');
        break;
      }
    }
  }
}
