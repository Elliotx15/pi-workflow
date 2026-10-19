export type Phase = "idle" | "working" | "blocked";
export type Outcome = "completed" | "failed" | "cancelled";

/** An activity covers the parent run, compaction, and optional background work. */
export class ActivityState {
  private running = false;
  private compacting = false;
  private background = false;
  private prompts = 0;
  private outcome: Outcome = "completed";

  get foregroundActive(): boolean {
    return this.running || this.compacting;
  }

  get active(): boolean {
    return this.foregroundActive || this.background;
  }

  setBackground(active: boolean | undefined): Outcome | undefined {
    if (active && !this.active) this.outcome = "completed";
    const wasBackground = this.background;
    this.background = active === true;
    if (!wasBackground || this.active) return undefined;
    this.prompts = 0;
    // Losing the observer must not turn unknown child state into a success.
    return active === false ? this.outcome : undefined;
  }

  get phase(): Phase {
    return this.active ? (this.prompts > 0 ? "blocked" : "working") : "idle";
  }

  startRun(): void {
    if (!this.running) this.outcome = "completed";
    this.running = true;
  }

  recordResponse(outcome: Outcome): void {
    if (this.running) this.outcome = outcome;
  }

  settle(aborted: boolean): Outcome | undefined {
    if (!this.running) return undefined;
    this.running = false;
    if (aborted) this.outcome = "cancelled";
    if (this.compacting) return undefined;
    this.prompts = 0;
    return this.background ? undefined : this.outcome;
  }

  startCompaction(manual: boolean): void {
    // Automatic preflight compaction belongs to the upcoming agent run.
    if (!manual) this.startRun();
    this.compacting = true;
  }

  finishCompaction(manual: boolean, outcome: Outcome): Outcome | undefined {
    this.compacting = false;
    if (this.running) {
      if (outcome !== "completed") this.outcome = outcome;
      return undefined;
    }
    if (!manual) return undefined;
    this.outcome = outcome;
    this.prompts = 0;
    return this.background ? undefined : outcome;
  }

  openPrompt(): void {
    this.prompts++;
  }

  closePrompt(): void {
    this.prompts = Math.max(0, this.prompts - 1);
  }
}
