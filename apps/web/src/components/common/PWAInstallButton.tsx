import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return isOnline;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const install = async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export function PWAInstallButton({ compact = false }: { compact?: boolean }) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIosGuide, setShowIosGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => {
          void install();
        }}
        className={`inline-flex items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white font-medium text-[#172033] hover:bg-[#F8FAFC] transition-colors ${
          compact ? 'h-9 px-3 text-xs' : 'h-10 px-3.5 text-sm'
        }`}
      >
        <Download className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
        <span>Install Player App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIosGuide(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:bg-[#F8FAFC]"
        >
          <Download className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
          <span>Install App</span>
        </button>

        {showIosGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-sm rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-xl">
              <h3 className="font-display text-base font-semibold text-[#172033]">
                Install Castora Pro
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-[#64748B]">
                Tap the <strong className="text-[#172033]">Share</strong> button in Safari, then choose{' '}
                <strong className="text-[#172033]">Add to Home Screen</strong> for standalone offline playback.
              </p>
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="mt-4 h-10 w-full rounded-[10px] bg-[#2563EB] text-xs font-semibold text-white hover:bg-[#1D4ED8]"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
