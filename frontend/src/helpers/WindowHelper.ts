/**
 * WebAuthn requires the document to have focus before prompting for passkeys.
 * This helper ensures focus or waits up to 3 seconds for the user to click back.
 */
export class WindowHelper {
  static ensureFocus(): Promise<void> {
    if (document.hasFocus()) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', settle);
        resolve();
      };

      window.addEventListener('focus', settle);
      window.focus();
      setTimeout(settle, 3000);
    });
  }
}
