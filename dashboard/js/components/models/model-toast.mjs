import { escapeHtml } from '../../utils/sanitize.mjs';

export class ModelToast {
  static show(msg, type = 'info', duration = 3000) {
    let t = document.getElementById('mm-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mm-toast';
      t.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; padding: 12px 24px;
        border-radius: 8px; font-weight: 500; font-size: 14px;
        z-index: 10000; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        transform: translateY(100px); opacity: 0; transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      `;
      document.body.appendChild(t);
    }

    if (t._timeout) clearTimeout(t._timeout);

    let bg = 'rgba(59, 130, 246, 0.9)';
    let border = '1px solid rgba(59, 130, 246, 0.3)';

    if (type === 'success') {
      bg = 'rgba(16, 185, 129, 0.9)';
      border = '1px solid rgba(16, 185, 129, 0.3)';
    } else if (type === 'error') {
      bg = 'rgba(239, 68, 68, 0.9)';
      border = '1px solid rgba(239, 68, 68, 0.3)';
    } else if (type === 'warning') {
      bg = 'rgba(245, 158, 11, 0.9)';
      border = '1px solid rgba(245, 158, 11, 0.3)';
    }

    t.style.background = bg;
    t.style.border = border;
    t.style.backdropFilter = 'blur(8px)';

    t.innerHTML = escapeHtml(msg);

    requestAnimationFrame(() => {
      t.style.transform = 'translateY(0)';
      t.style.opacity = '1';
    });

    t._timeout = setTimeout(() => {
      t.style.transform = 'translateY(100px)';
      t.style.opacity = '0';
    }, duration);
  }
}
