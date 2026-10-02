import { ReactNode, useEffect } from 'react';

export function Modal({ title, children, footer, onClose, size, z }: {
  title: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void; size?: 'sm' | 'mid' | 'wide'; z?: number;
}) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
  return (
    <div className="overlay no-print-bg" style={z ? { zIndex: z } : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${size === 'wide' ? 'wide' : size === 'mid' ? 'mid' : ''}`} style={size === 'sm' ? { width: 'min(400px,100%)' } : undefined} role="dialog" aria-modal>
        <div className="modal-h"><h2>{title}</h2>{onClose && <button className="x" onClick={onClose} aria-label="Fechar">×</button>}</div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}
