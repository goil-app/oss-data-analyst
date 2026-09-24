/**
 * Accumulates progress lines and edits one status message with them, at most once per `intervalMs`
 * (parallel tool calls would otherwise hit Discord's edit rate limit). Each edit sends the latest text.
 */
export function liveProgress(edit: (text: string) => Promise<unknown>, intervalMs = 1000) {
  const steps: string[] = [];
  let running: Promise<void> | null = null;
  let dirty = false;

  const flush = () => {
    if (running) {
      dirty = true;
      return;
    }
    running = (async () => {
      do {
        dirty = false;
        await edit(steps.join("\n")).catch((err) => console.warn("[Progress] Edit failed:", err));
        await new Promise((r) => setTimeout(r, intervalMs));
      } while (dirty);
      running = null;
    })();
  };

  return {
    add: (step: string) => {
      if (steps.at(-1) === step) return;
      steps.push(step);
      flush();
    },
    /** Waits for pending edits so a late progress edit never overwrites the final answer. */
    done: async () => {
      await running;
    },
  };
}
