export async function deliverQuotaNotice(read: () => Promise<string | null>, show: (message: string) => void) {
  const message = await read();
  if (message) show(message);
}

// One outstanding read per surface. An already claimed message can finish
// displaying through the host toast service while navigation swaps surfaces.
export function pollQuotaNotices(read: () => Promise<string | null>, show: (message: string) => void) {
  let pending = false;
  async function poll() {
    if (pending) return;
    pending = true;
    try {
      await deliverQuotaNotice(read, show);
    } catch {
      // A disconnected or older host can be checked on the next tick.
    } finally {
      pending = false;
    }
  }
  void poll();
  const timer = setInterval(() => void poll(), 30_000);
  return () => clearInterval(timer);
}
