export function formatNumber(num) {
    return new Intl.NumberFormat('en-US').format(num);
}
export function formatCurrency(num) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 4,
    }).format(num);
}
export function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}
export function formatFullDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US');
}
export function timeAgo(dateStr) {
    if (!dateStr)
        return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime()))
        return '';
    const ms = Date.now() - date.getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
export function debounce(fn, delay = 300) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}
export function relativeTime(dateStr) {
    return timeAgo(dateStr);
}
export function truncate(str, maxLen = 25) {
    if (!str)
        return '';
    if (str.length <= maxLen)
        return str;
    return str.slice(0, maxLen) + '…';
}
