/** Monotonic authority for async UI work where only the newest request may commit state. */
export class LatestRequestAuthority {
  private generation = 0;

  begin(): number { return ++this.generation; }
  invalidate(): void { this.generation += 1; }
  isCurrent(token: number): boolean { return token === this.generation; }
}
