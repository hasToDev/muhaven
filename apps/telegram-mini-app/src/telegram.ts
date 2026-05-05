/**
 * Minimal types for the Telegram WebApp host. We only consume a tiny
 * subset of the API; the full surface is documented at
 * https://core.telegram.org/bots/webapps#initializing-mini-apps.
 *
 * The host injects `window.Telegram.WebApp` when the page is opened
 * inside Telegram. When opened in a regular browser (no Telegram), we
 * fall back to a stub that surfaces an "open in Telegram" message.
 */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: { id: number; username?: string };
    start_param?: string;
  };
  ready(): void;
  expand(): void;
  close(): void;
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  themeParams: Record<string, string>;
  colorScheme: 'light' | 'dark';
  showAlert(message: string): void;
  MainButton: {
    setText(text: string): void;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    enable(): void;
    disable(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}
