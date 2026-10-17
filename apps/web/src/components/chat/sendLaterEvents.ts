const SEND_LATER_EVENT = "t2:send-later";

export function subscribeToSendLater(listener: () => void): () => void {
  window.addEventListener(SEND_LATER_EVENT, listener);
  return () => window.removeEventListener(SEND_LATER_EVENT, listener);
}

/**
 * Lets entry points outside the composer (the command palette) ask it to start
 * "Send later" with its current draft. Deferred a frame so a closing palette
 * has released focus before the dialog opens.
 */
export function requestSendLaterFromComposer(): void {
  window.requestAnimationFrame(() => window.dispatchEvent(new Event(SEND_LATER_EVENT)));
}
