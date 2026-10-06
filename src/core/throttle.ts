/**
 * Edits one status message at most once per interval, always ending on the latest text.
 *
 * Telegram allows roughly one message per second per chat and 20 per minute in a group; Discord
 * rate-limits edits per channel. A progress line that changes every poll would trip both, so
 * updates are coalesced: only the newest text is sent, unchanged text is never re-sent, and
 * `flush` pushes the final text right away.
 */
export class ThrottledEditor {
  private latest: string | undefined;
  private shown: string | undefined;
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly edit: (text: string) => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    initialText?: string,
  ) {
    this.shown = initialText;
  }

  /** Queues text; it is sent now if the interval has passed, otherwise when it does. */
  update(text: string): void {
    if (this.closed) return;
    this.latest = text;
    if (this.timer) return;
    const wait = this.lastEditAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.send();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.send();
    }, wait);
  }

  /** Sends the given (or latest) text immediately and stops further updates. */
  async flush(text?: string): Promise<void> {
    if (text !== undefined) this.latest = text;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.closed = true;
    this.send();
    await this.chain;
  }

  /** Stops without sending anything else, for when the message is replaced by something new. */
  cancel(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private send(): void {
    const text = this.latest;
    if (text === undefined || text === this.shown) return;
    this.shown = text;
    this.lastEditAt = this.now();
    this.chain = this.chain.then(() => this.edit(text)).then(
      () => undefined,
      () => undefined,
    );
  }
}
