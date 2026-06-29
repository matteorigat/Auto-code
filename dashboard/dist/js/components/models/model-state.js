export class ModelState {
    constructor() {
        this.state = {
            healthList: [],
            activeView: 'overview',
            filterText: '',
            statusFilter: 'all',
            checkingModels: new Set(),
            checkingAll: false,
            autoChecksEnabled: false,
            discoveryFreeOnly: true,
            discoverySortBy: 'default',
            discoveryViewMode: 'grid',
            discoveryCompare: new Set(),
            sortCol: 'actual_model',
            sortDesc: false,
            healthViewMode: 'table',
            selectedModels: new Set(),
            cmdPaletteOpen: false,
            sidebarCollapsed: false,
        };
        this.listeners = new Set();
        this.restore();
    }
    get() {
        return this.state;
    }
    update(newState) {
        let changed = false;
        for (const [key, value] of Object.entries(newState)) {
            if (this.state[key] !== value) {
                this.state[key] = value;
                changed = true;
            }
        }
        if (changed) {
            this.persist();
            this.notify();
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notify() {
        if (this._updateScheduled)
            return;
        this._updateScheduled = true;
        queueMicrotask(() => {
            this._updateScheduled = false;
            for (const listener of this.listeners) {
                try {
                    listener(this.state);
                }
                catch (e) {
                    console.error('[ModelState] Listener error:', e);
                }
            }
        });
    }
    getStats() {
        const list = this.state.healthList || [];
        let healthy = 0, unhealthy = 0, unchecked = 0;
        const providers = {};
        for (const m of list) {
            if (m.health_status === 'healthy')
                healthy++;
            else if (m.health_status === 'unhealthy')
                unhealthy++;
            else
                unchecked++;
            const p = m.provider || 'unknown';
            providers[p] = (providers[p] || 0) + 1;
        }
        return { total: list.length, healthy, unhealthy, unchecked, providers };
    }
    persist() {
        try {
            const persistState = {
                activeView: this.state.activeView,
                filterText: this.state.filterText,
                discoveryFreeOnly: this.state.discoveryFreeOnly,
                discoverySortBy: this.state.discoverySortBy,
                discoveryViewMode: this.state.discoveryViewMode,
                sortCol: this.state.sortCol,
                sortDesc: this.state.sortDesc,
                healthViewMode: this.state.healthViewMode,
                sidebarCollapsed: this.state.sidebarCollapsed,
            };
            sessionStorage.setItem('model_mgt_state', JSON.stringify(persistState));
        }
        catch (e) {
            console.warn('Failed to persist state:', e);
        }
    }
    restore() {
        try {
            const saved = sessionStorage.getItem('model_mgt_state');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.state = { ...this.state, ...parsed };
            }
        }
        catch (e) {
            console.warn('Failed to restore state:', e);
        }
    }
}
