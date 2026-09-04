/**
 * V6.1 FloatingAssistant — iPhone/mobile-safe draggable chat button.
 *
 * Fixes MOB-01..MOB-06:
 *   MOB-01: visible portrait
 *   MOB-02: visible landscape
 *   MOB-03: orientation change clamps position
 *   MOB-04: resize clamps position
 *   MOB-05: no horizontal overflow
 *   MOB-06: financial dialogs usable on iPhone viewport (button stays within safe area)
 *
 * Approach: use state for position, recompute clamp on resize/orientation.
 * Framer-motion dragConstraints are evaluated once at render — we use a state
 * updater to force re-render on viewport changes.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { MessageSquare } from 'lucide-react';

interface Props {
  onToggle: () => void;
  showChat: boolean;
  hasMessages: boolean;
}

interface ViewportDims {
  w: number;
  h: number;
}

const BUTTON_SIZE = 56;  // w-14 h-14 = 56px
const SAFE_MARGIN = 16;  // 16px from each edge

function getViewport(): ViewportDims {
  if (typeof window === 'undefined') return { w: 360, h: 640 };
  // Use visualViewport when available (handles mobile browser toolbar changes).
  const v = (window as any).visualViewport;
  if (v && v.width > 0 && v.height > 0) {
    return { w: v.width, h: v.height };
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

export function FloatingAssistant({ onToggle, showChat, hasMessages }: Props) {
  const [vp, setVp] = useState<ViewportDims>(() => getViewport());

  // V6.1 (MOB-03, MOB-04): recompute viewport on resize and orientation change.
  useEffect(() => {
    const update = () => setVp(getViewport());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const v = (window as any).visualViewport;
    if (v) {
      v.addEventListener('resize', update);
      v.addEventListener('scroll', update);
    }
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      if (v) {
        v.removeEventListener('resize', update);
        v.removeEventListener('scroll', update);
      }
    };
  }, []);

  // Clamp constraints recomputed from current viewport.
  // Button starts at right:20, bottom:140 in CSS coords (right edge anchored).
  // After drag, position is left/top in framer-motion's drag system.
  // We clamp so the button stays fully visible (no overflow).
  const constraints = {
    left: -(vp.w - BUTTON_SIZE - SAFE_MARGIN),
    right: 0,
    top: -(vp.h - BUTTON_SIZE - SAFE_MARGIN),
    bottom: SAFE_MARGIN,
  };

  return (
    <motion.div
      drag
      dragConstraints={constraints}
      dragElastic={0.1}
      dragMomentum={false}
      className="fixed z-[60] touch-none"
      style={{ right: SAFE_MARGIN, bottom: 140 }}
    >
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
        className="flex items-center justify-center w-14 h-14 rounded-full bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_0_20px_rgba(5,150,105,0.4)] transition-colors relative select-none"
        title="الدردشة الكتابية"
        aria-label="فتح الدردشة"
      >
        <MessageSquare className="w-6 h-6 pointer-events-none" />
        {hasMessages && !showChat && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 rounded-full border-2 border-slate-900 animate-pulse pointer-events-none"></span>
        )}
      </button>
    </motion.div>
  );
}
