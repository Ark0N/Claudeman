/**
 * @fileoverview Minimal Telegram Bot API client (long polling, no webhook: the box sits
 * behind Tailscale) plus the pure command / callback parsers.
 *
 * Only updates from the configured chat are ever acted on; everything else is dropped
 * without an answer, so a stranger who finds the bot gets silence, not a menu.
 */

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  from?: { id: number; username?: string };
  text?: string;
  reply_to_message?: { message_id: number; text?: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendOptions {
  replyMarkup?: unknown;
  replyToMessageId?: number;
  disablePreview?: boolean;
}

export class TelegramClient {
  private readonly base: string;

  constructor(
    token: string,
    private readonly chatId: string
  ) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  isOurChat(chatId: number | string | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.chatId;
  }

  async getMe(): Promise<{ username?: string }> {
    return this.call<{ username?: string }>('getMe');
  }

  async sendMessage(text: string, opts: SendOptions = {}): Promise<number> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_markup: opts.replyMarkup,
      reply_to_message_id: opts.replyToMessageId,
    });
    return result.message_id;
  }

  /** Plain text, no parse mode: for content the bot did not write (reviewer answers, drafts). */
  async sendPlain(text: string, opts: SendOptions = {}): Promise<number> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_markup: opts.replyMarkup,
      reply_to_message_id: opts.replyToMessageId,
    });
    return result.message_id;
  }

  async editReplyMarkup(messageId: number, replyMarkup: unknown): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: this.chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      });
    } catch (err) {
      // "message is not modified" is Telegram's way of saying the keyboard already looks like that.
      if (!String(err).includes('not modified')) throw err;
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.call('deleteMessage', { chat_id: this.chatId, message_id: messageId });
    } catch {
      // Already gone, or older than Telegram allows a bot to delete; the message was informational.
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text });
  }

  async sendDocument(filename: string, content: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', this.chatId);
    if (caption) form.set('caption', caption);
    form.set('document', new Blob([content], { type: 'text/markdown' }), filename);
    const res = await fetch(`${this.base}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`telegram sendDocument: ${json.description ?? res.status}`);
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      (timeoutSec + 15) * 1000
    );
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }
}

export interface ParsedCommand {
  command: string;
  prNumber?: number;
  rest: string;
}

/** `/merge 381 force` -> {command:'merge', prNumber:381, rest:'force'}; `/help@botname` is handled. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null;
  const m = text.trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = m[1].toLowerCase();
  const argText = (m[2] ?? '').trim();
  const numMatch = argText.match(/^#?(\d+)\b\s*([\s\S]*)$/);
  if (numMatch) return { command, prNumber: parseInt(numMatch[1], 10), rest: numMatch[2].trim() };
  return { command, rest: argText };
}

export interface ParsedCallback {
  action: string;
  prNumber: number;
  nonce?: string;
  /** For confirm/cancel: the action being confirmed. */
  target?: string;
}

export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts[0] === 'confirm' || parts[0] === 'cancel') {
    if (parts.length !== 4) return null;
    const prNumber = parseInt(parts[2], 10);
    if (!Number.isFinite(prNumber)) return null;
    return { action: parts[0], target: parts[1], prNumber, nonce: parts[3] };
  }
  if (parts.length !== 2) return null;
  const prNumber = parseInt(parts[1], 10);
  if (!Number.isFinite(prNumber)) return null;
  return { action: parts[0], prNumber };
}

/** Find the PR number a report message is about, from its first line (`🔍 PR #381 · ...`). */
export function prNumberFromMessageText(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.match(/PR #(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
