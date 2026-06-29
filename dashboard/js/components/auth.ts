export function mountAuthOverlay(container, onTokenSubmit) {
  const overlayHtml = `
    <div id="auth-backdrop" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div class="glass-panel p-8 max-w-md w-full space-y-6 transform transition-all">
        <div class="text-center space-y-2">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/20 text-primary mb-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
          </div>
          <h2 class="text-2xl font-bold text-white tracking-tight">Access Required</h2>
          <p class="text-zinc-400 text-sm">Please enter your dashboard token to proceed.</p>
        </div>
        
        <form id="auth-form" class="space-y-4">
          <div>
            <input 
              type="password" 
              id="auth-token-input"
              class="w-full bg-surface/50 border border-white/10 rounded-lg px-4 py-3 text-white               placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
              placeholder="Dashboard Token"
              required
              autocomplete="current-password"
            >
          </div>
          <button 
            type="submit"
            class="w-full bg-primary hover:bg-primary/90 text-white font-medium rounded-lg px-4 py-3 transition-colors duration-200"
          >
            Authenticate
          </button>
        </form>
      </div>
    </div>
  `;

  container.innerHTML = overlayHtml;

  const form = document.getElementById('auth-form');
  const input = document.getElementById('auth-token-input') as HTMLInputElement;

  // Focus the input when mounted
  setTimeout(() => input.focus(), 50);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (token) {
      onTokenSubmit(token);
    }
  });

  return {
    hide: () => {
      container.innerHTML = '';
    },
  };
}
