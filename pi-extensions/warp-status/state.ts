export type Phase = "idle" | "working" | "blocked";
export type Outcome = "completed" | "failed" | "cancelled";

/** An agent run stays open across low-level agent_end and retry boundaries. */
export class ActivityState {
  private running = false;
  private compacting = false;
  private prompts = 0;
  private outcome: Outcome = "completed";

  get active(): boolean {
    return this.running || this.compacting;
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
    return this.outcome;
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
    this.prompts = 0;
    return outcome;
  }

  openPrompt(): void {
    this.prompts++;
  }

  closePrompt(): void {
    this.prompts = Math.max(0, this.prompts - 1);
  }
}
