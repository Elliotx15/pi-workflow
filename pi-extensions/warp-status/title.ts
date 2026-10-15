import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const FRAME_MS = 160;
const FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const;

export function plainText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}

export function piTitle(name: string | undefined, cwd: string): string {
  return [name && plainText(name), plainText(basename(cwd))].filter(Boolean).join(" - ");
}

export class TitleAnimation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private disposed = false;
  private getTitle: () => string;
  private setTitle: (title: string) => void;

  constructor(getTitle: () => string, setTitle: (title: string) => void) {
    this.getTitle = getTitle;
    this.setTitle = setTitle;
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.frame = 0;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.refresh();
    }, FRAME_MS);
    this.timer.unref();
    this.refresh();
  }

  pause(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    try {
      // Read the current session name on every write, including the final restore.
      const base = this.getTitle();
      this.setTitle(this.timer === undefined ? base : `${FRAMES[this.frame]} ${base}`);
    } catch {
      // Terminal rendering must never interrupt the agent.
    }
  }

  dispose(restore = true): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (restore) this.refresh();
    this.disposed = true;
  }
}
