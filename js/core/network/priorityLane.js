// Shared admission control for addon requests that all target the same host.
//
// The browser only opens ~6 sockets per host, and boot fans out ~100 meta
// lookups (continue-watching enrichment, library/watchlist hydration, next-up
// candidates). A user-initiated request issued during that window — opening a
// detail screen — is just request #100 in the browser's queue and can wait
// several seconds behind work nobody is looking at.
//
// This lane keeps background work to a fixed share of the socket budget and
// lets foreground work through immediately, so a d-pad press never queues
// behind speculative enrichment.
//
// Usage:
//   const ticket = lane.ticket("foreground");
//   const release = await lane.acquire(ticket);
//   try { ... } finally { release(); }
// A caller that joins an in-flight background request can call
// `lane.promote(ticket)` to pull it out of the queue — the request being
// deduped is now blocking a screen.
const DEFAULT_BACKGROUND_CONCURRENCY = 3;
// Background dispatch stays parked for this long after the last foreground
// request settles, so a burst of foreground calls (a detail mount issues meta
// plus its follow-ups) is not interleaved with re-admitted background work.
const FOREGROUND_COOLDOWN_MS = 150;

export function createPriorityLane({
  backgroundConcurrency = DEFAULT_BACKGROUND_CONCURRENCY
} = {}) {
  const waiters = [];
  let backgroundActive = 0;
  let foregroundActive = 0;
  let parkedUntil = 0;
  let drainTimer = null;

  const canAdmit = () =>
    backgroundActive < backgroundConcurrency
    && foregroundActive === 0
    && Date.now() >= parkedUntil;

  const drain = () => {
    while (waiters.length && canAdmit()) {
      backgroundActive += 1;
      waiters.shift().resolve();
    }
    if (waiters.length && !drainTimer) {
      // Foreground completion re-arms the drain directly; this timer only
      // covers the cooldown window, where nothing else will fire.
      drainTimer = setTimeout(() => {
        drainTimer = null;
        drain();
      }, Math.max(25, parkedUntil - Date.now()));
    }
  };

  const releaseForeground = () => {
    foregroundActive -= 1;
    if (foregroundActive === 0) {
      parkedUntil = Date.now() + FOREGROUND_COOLDOWN_MS;
    }
    drain();
  };

  return {
    ticket(priority = "background") {
      return { priority };
    },

    // Resolves with a release function. Always call it in a finally block.
    async acquire(ticketOrPriority = "background") {
      const ticket = typeof ticketOrPriority === "string"
        ? { priority: ticketOrPriority }
        : (ticketOrPriority || { priority: "background" });

      if (ticket.priority === "foreground") {
        foregroundActive += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseForeground();
        };
      }

      if (canAdmit()) {
        backgroundActive += 1;
      } else {
        await new Promise((resolve) => {
          waiters.push({ ticket, resolve });
          drain();
        });
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        backgroundActive -= 1;
        drain();
      };
    },

    // Escalate a ticket that is already queued (or not yet acquired). A queued
    // waiter is admitted immediately, above the background cap: it is now a
    // user-visible request that happens to be shared with background work.
    promote(ticket) {
      if (!ticket || ticket.priority === "foreground") {
        return;
      }
      ticket.priority = "foreground";
      const index = waiters.findIndex((waiter) => waiter.ticket === ticket);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        backgroundActive += 1;
        waiter.resolve();
      }
    },

    stats() {
      return { backgroundActive, foregroundActive, queued: waiters.length };
    }
  };
}
