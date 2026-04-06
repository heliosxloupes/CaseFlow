/**
 * CaseFlow iOS Bridge
 * Injected before app code. Patches web APIs with native Capacitor equivalents.
 * Only active when running inside a Capacitor native shell.
 */

(function () {
  if (!window.Capacitor?.isNativePlatform()) return;

  // ── Safe area CSS variables ────────────────────────────────────────────────
  // Capacitor injects these; make sure they're available as fallbacks too
  const root = document.documentElement;
  function applySafeArea() {
    const top    = parseInt(getComputedStyle(root).getPropertyValue('--sat') || '0', 10);
    const bottom = parseInt(getComputedStyle(root).getPropertyValue('--sab') || '0', 10);
    if (!top && !bottom) {
      // Fallback for older Capacitor — read from env()
      root.style.setProperty('--safe-top',    'env(safe-area-inset-top, 0px)');
      root.style.setProperty('--safe-bottom', 'env(safe-area-inset-bottom, 0px)');
    }
  }
  applySafeArea();

  // ── Disable PWA install banner ─────────────────────────────────────────────
  window.addEventListener('beforeinstallprompt', e => e.preventDefault());

  // ── Disable service worker (not needed in native shell) ────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    });
  }

  // ── Microphone: use native Web API directly ───────────────────────────────
  // WKWebView handles the iOS mic permission prompt automatically when
  // getUserMedia is called. NSMicrophoneUsageDescription is in Info.plist.
  // No Capacitor plugin needed.

  // ── Haptic feedback on orb tap ─────────────────────────────────────────────
  const { Haptics } = window.Capacitor.Plugins;
  if (Haptics) {
    window.__nativeHaptic = function (style) {
      // style: 'light' | 'medium' | 'heavy'
      Haptics.impact({ style: style || 'medium' }).catch(() => {});
    };
  }

  // ── Status bar ─────────────────────────────────────────────────────────────
  const { StatusBar } = window.Capacitor.Plugins;
  if (StatusBar) {
    StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
    StatusBar.setBackgroundColor({ color: '#07090f' }).catch(() => {});
  }

  // ── Keyboard safe area ─────────────────────────────────────────────────────
  window.addEventListener('keyboardWillShow', (e) => {
    document.body.style.setProperty('--keyboard-height', `${e.keyboardHeight || 0}px`);
  });
  window.addEventListener('keyboardWillHide', () => {
    document.body.style.setProperty('--keyboard-height', '0px');
  });

  // ── Native speech recognition via WKScriptMessageHandler ─────────────────────
  // SpeechBridge in ViewController.swift registers "nativeSR" handler.
  // JS → Native: postMessage({action:'start'|'stop'})
  // Native → JS: evaluateJavaScript calls window.__srResult(text)
  if (window.webkit?.messageHandlers?.nativeSR) {
    window.__nativeSpeechRec = {
      _active: false,
      start: function (onPartial) {
        window.__nativeSpeechRec._active = true;
        window.__srResult = function (text) {
          if (window.__nativeSpeechRec._active) onPartial(text);
        };
        window.webkit.messageHandlers.nativeSR.postMessage({ action: 'start' });
      },
      stop: function () {
        window.__nativeSpeechRec._active = false;
        window.__srResult = null;
        window.webkit.messageHandlers.nativeSR.postMessage({ action: 'stop' });
      },
    };
    console.log('[CaseFlow] Native speech bridge ready (WKScriptMessageHandler)');
  }

  console.log('[CaseFlow] iOS bridge initialized');
})();
